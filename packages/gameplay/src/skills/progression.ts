/**
 * ADR-113 progression: XP from gathering/crafting/combat/farming/hunting/building/taming/cooking/healing/repair,
 * levels -> skill points, node unlocks (prereqs + cost), paid respec, AI picks by personality (same commands),
 * and the recipe skill provider (setSkillLevelProvider). Authority-only writes; Progression replicates + persists.
 */
import { DEFAULT_TICK_HZ, defineCommand, Membership, Transform, type CommandHandlers, type Entity, type Traits, type World } from "@engine/core";
import { Animal, BuildPiece, Dead, Health, Progression, ResourceNode, Zombie } from "../components.js";
import { gameplayDefs, isAuthority } from "../config.js";
import { CraftCompleted, Damaged, emit, ev, ItemConsumed, ItemGathered, PiecePlaced, WaterDrunk, XpActivity } from "../events.js";
import { skillDescription, type SkillDescription } from "./describe.js";
import { isAiHuman, killXpBase, pvpFactor, travelStep, victimType, XP } from "./xp.js";
import { isCreativePlayer } from "../creative.js";
import { worldRules } from "../hordes.js";
import { ToolKind } from "../defs.js";
import { countItem, removeItem } from "../inventory.js";
import { setSkillLevelProvider, setUnlockProvider } from "../systems/crafting.js";
import { VehicleRepaired } from "../vehicle_craft.js";
import { hasSkillUnlock, isUnlockNode, nodeWords, ownedNodes, SKILL_NODE_TREE, TREE_KEYS, TREE_SLOTS, treeIndex, treePointsAtLevel, treePointsForLevel, treeProgress, treeXpToNext, type TreeProgress, SKILL_NODE_CATEGORY, SKILL_NODE_WORDS, SKILL_REQS, SKILLS, skillLevelOf, skillMod, skillNode, wordsHas, xpToNext, XP_SHARE_RADIUS, type XpSource } from "./tree.js";

/** ADR-135: every award (after mods), for host-side popups/logs. The client derives its popup from Progression deltas. */
export const XpGained = ev<{ entity: Entity; source: string; amount: number; tree: string }>("gameplay.XpGained");
/** ADR-209: a skill tree levelled (points = that tree's unspent points after the level-up). */
export const TreeLevelUp = ev<{ entity: Entity; tree: string; level: number; points: number }>("gameplay.TreeLevelUp");
export const LevelUp = ev<{ entity: Entity; level: number; points: number }>("gameplay.LevelUp");
export const SkillUnlocked = ev<{ entity: Entity; node: number }>("gameplay.SkillUnlocked");
export const SkillsRespecced = ev<{ entity: Entity; refunded: number; cost: number }>("gameplay.SkillsRespecced");

export const UnlockSkillCmd = defineCommand("gameplay.unlockSkill", { node: "u16" });
export const RespecSkillsCmd = defineCommand("gameplay.respecSkills", {});
export const SKILL_COMMANDS = [UnlockSkillCmd, RespecSkillsCmd] as const;

const blank = { xp: 0, level: 1, points: 0, respecs: 0 };
export function ensureProgression(world: World, e: Entity): void { if (!world.has(e, Progression)) world.add(e, Progression, blank); migrateProgression(world, e); }

// ---- ADR-209 per-tree XP / level / points + legacy (global pool) conversion ---------------------------------
/** XP tree of a data/xp.json source (unknown sources -> survival). */
export const treeOfSource = (source: string): number => { const i = treeIndex((XP.trees as Record<string, string>)[source] ?? "survival"); return i < 0 ? 0 : i; };
/**
 * Pure conversion of a pre-ADR-209 row (one global level/points pool) into per-tree progress:
 *  1. every learned node stays learned and is charged to its own tree; that tree gets the lowest level whose earned
 *     points cover what was spent there (rounding surplus stays in the tree as unspent points; xp 0);
 *  2. leftover global unspent points are split evenly over all trees; the remainder goes one each to the trees with
 *     the least spent (ties -> lower tree index). The global xp/level stays as the character level (kill / PvP scaling).
 */
export function convertLegacyProgression(points: number, words: readonly number[]): TreeProgress[] {
  const spent = TREE_KEYS.map(() => 0);
  for (let i = 0; i < SKILLS.nodes.length; i++) if (wordsHas(words, i)) spent[SKILL_NODE_TREE[i]!]! += SKILLS.nodes[i]!.cost;
  const out = spent.map((s): TreeProgress => {
    let level = 1; while (level < SKILLS.treeLevels.maxLevel && treePointsAtLevel(level) < s) level++;
    return { xp: 0, level, points: Math.max(0, treePointsAtLevel(level) - s) };
  });
  const n = out.length; const each = Math.floor(points / n); let rem = points - each * n;
  for (const t of out) t.points += each;
  for (const i of out.map((_, i) => i).sort((a, b) => spent[a]! - spent[b]! || a - b)) { if (rem <= 0) break; out[i]!.points++; rem--; }
  for (const t of out) t.points = Math.min(0xffff, t.points);
  return out;
}
function writeTrees(world: World, e: Entity, t: readonly TreeProgress[]): void {
  for (let i = 0; i < TREE_SLOTS; i++) {
    world.setElement(e, Progression, "txp", i, t[i]?.xp ?? 0); world.setElement(e, Progression, "tlevel", i, t[i]?.level ?? 1); world.setElement(e, Progression, "tpoints", i, t[i]?.points ?? 0);
  }
}
/**
 * Authority: converts an unmigrated row in place. Idempotent.
 *  tver 0 -> per-tree progress (ADR-209); tver < 2 -> ADR-221 unlock grant: a pre-ADR-221 character (any tver-1 row, or a
 *  tver-0 row with xp / level / points / nodes) learns every unlock node free (no points charged) so the stations and
 *  tiers it already built or crafted at keep working. A fresh spawn (blank tver-0 row) gets nothing: twig tier only.
 */
export function migrateProgression(world: World, e: Entity): boolean {
  if (!isAuthority(world) || world.isReplaying || !world.has(e, Progression)) return false;
  const tv = world.getField(e, Progression, "tver") ?? 0; if (tv >= PROGRESSION_TVER) return false;
  const p = world.get(e, Progression)!; const words = nodeWords(world, e)!;
  const legacy = tv >= 1 || p.points > 0 || p.xp > 0 || p.level > 1 || words.some((x) => x !== 0);
  if (tv < 1) writeTrees(world, e, convertLegacyProgression(p.points, words));
  if (legacy) setUnlockBits(world, e);
  world.set(e, Progression, { points: 0, tver: PROGRESSION_TVER }); return true;
}
function setUnlockBits(world: World, e: Entity): void {
  for (const i of UNLOCK_NODES) { const a = world.getArray(e, Progression, "nodes")!; world.setElement(e, Progression, "nodes", i >>> 5, (a[i >>> 5]! | (1 << (i & 31))) >>> 0); }
}
/** Authority / QA / tests: learn every station and tier unlock free (ADR-221), without touching tree points. */
export function grantSkillUnlocks(world: World, e: Entity): void {
  if (!world.has(e, Progression)) return; migrateProgression(world, e); setUnlockBits(world, e);
}
/** ADR-209 tver 1 (per-tree pools); ADR-221 tver 2 (unlock nodes granted to legacy characters). */
export const PROGRESSION_TVER = 2;
const UNLOCK_NODES: readonly number[] = SKILLS.nodes.flatMap((n, i) => (isUnlockNode(i) && !n.retired ? [i] : []));
/** Per-tree progress as the authority will see it (unmigrated rows are converted on the fly, read-only). */
export function treesOf(world: World, e: Entity): TreeProgress[] | undefined {
  if (!world.has(e, Progression)) return undefined;
  if ((world.getField(e, Progression, "tver") ?? 0) < 1) return convertLegacyProgression(world.getField(e, Progression, "points") ?? 0, nodeWords(world, e)!);
  return treeProgress(world, e);
}
/** Unspent points of tree `tree` (index or key). */
export function treePoints(world: World, e: Entity, tree: number | string): number { const i = typeof tree === "string" ? treeIndex(tree) : tree; return treesOf(world, e)?.[i]?.points ?? 0; }
/** ADR-582: per-tree points that buy every learnable node in the tree, summed from skills.json costs. */
export const CREATIVE_TREE_POINTS: readonly number[] = (() => {
  const tot = TREE_KEYS.map(() => 0);
  for (let i = 0; i < SKILLS.nodes.length; i++) { const n = SKILLS.nodes[i]!; if (!n.retired) tot[SKILL_NODE_TREE[i]!]! += n.cost; }
  return tot;
})();
/** True when a Progression row is still the untouched start: no XP, no levels, no points, no nodes. */
export function isFreshProgression(world: World, e: Entity): boolean {
  const p = world.get(e, Progression); if (!p) return false;
  if (p.level > 1 || p.xp > 0 || p.points > 0) return false;
  const t = treesOf(world, e); if (!t) return false;
  return t.every((x) => x.level <= 1 && x.xp === 0 && x.points === 0) && ownedNodes(world, e).length === 0;
}
/**
 * ADR-582: the Creative start — max character level, every tree at max level, and enough points in
 * each tree to learn all of its skills (CREATIVE_TREE_POINTS; max level alone earns 71 per tree but
 * the crafting tree costs 77, so the points come from the node costs, not the level curve).
 */
export function applyCreativeStart(world: World, e: Entity): boolean {
  if (!world.has(e, Progression)) return false;
  migrateProgression(world, e);
  world.set(e, Progression, { xp: 0, level: SKILLS.levels.maxLevel, points: 0 });
  for (let i = 0; i < TREE_SLOTS; i++) {
    world.setElement(e, Progression, "txp", i, 0);
    world.setElement(e, Progression, "tlevel", i, i < TREE_KEYS.length ? SKILLS.treeLevels.maxLevel : 1);
    world.setElement(e, Progression, "tpoints", i, CREATIVE_TREE_POINTS[i] ?? 0);
  }
  return true;
}
/** ADR-582: grants the Creative start to fresh human players in a Creative world (AI humans are
 *  excluded by isCreativePlayer, as with every ADR-581 waiver). The fresh check makes it fire once:
 *  a restored character with any progress keeps it, and a granted character is no longer fresh. */
export function creativeStartSystem(world: World): void {
  if (!isAuthority(world) || world.isReplaying || !worldRules(world).creative) return;
  for (const e of world.query([Progression])) if (isCreativePlayer(world, e) && isFreshProgression(world, e)) applyCreativeStart(world, e);
}
/** Authority/test/QA: add unspent points to one tree. */
export function grantTreePoints(world: World, e: Entity, tree: number | string, n: number): void {
  const i = typeof tree === "string" ? treeIndex(tree) : tree; if (i < 0 || !world.has(e, Progression)) return; migrateProgression(world, e);
  world.setElement(e, Progression, "tpoints", i, Math.max(0, Math.min(0xffff, treePoints(world, e, i) + n)));
}
function addTreeXp(world: World, e: Entity, ti: number, amount: number): void {
  if (amount <= 0) return; migrateProgression(world, e); const t = treesOf(world, e)![ti]!; let { xp, level, points } = t; xp += amount; let up = false;
  const max = SKILLS.treeLevels.maxLevel;
  while (level < max && xp >= treeXpToNext(level)) { xp -= treeXpToNext(level); level++; points += treePointsForLevel(level); up = true; }
  if (level >= max) xp = Math.min(xp, treeXpToNext(level));
  world.setElement(e, Progression, "txp", ti, xp); world.setElement(e, Progression, "tlevel", ti, level); world.setElement(e, Progression, "tpoints", ti, Math.min(0xffff, points));
  if (up) emit(world, TreeLevelUp, { entity: e, tree: TREE_KEYS[ti]!, level, points });
}
/** One award into tree `ti` (ONLY that tree: no cross-tree share, ADR-209 amendment) and the character level. */
function credit(world: World, e: Entity, ti: number, amount: number): void {
  addXp(world, e, amount); addTreeXp(world, e, ti, amount);
}

/** ADR-234: sim-local fractional XP remainders (server only; under 1 XP per entity is lost on restart). */
const carries = new WeakMap<World, Map<string, number>>();
/** Whole XP to credit now for `v`; the fraction is kept for the next award of the same entity / kind. */
export function carryRound(world: World, kind: string, e: Entity, v: number): number {
  let m = carries.get(world); if (!m) carries.set(world, (m = new Map()));
  const k = `${kind}:${e}`; const acc = (m.get(k) ?? 0) + Math.max(0, v); const n = Math.floor(acc + 1e-9);
  if (m.size > 8192) m.clear(); m.set(k, acc - n); return n;
}
/** Award XP (scaled by the source table x skill "xp" mod); levels up and grants points. Shares to nearby party/clan. */
export function awardXp(world: World, e: Entity, source: XpSource, units = 1, share = true): number {
  if (!isAuthority(world) || world.isReplaying || !world.isAlive(e) || !world.has(e, Progression)) return 0;
  return awardXpRaw(world, e, source, (XP.sources[source] ?? 0) * units, share);
}
/** Award an already-computed base amount (kill XP); same mods / sharing as awardXp. */
export function awardXpRaw(world: World, e: Entity, source: string, base: number, share = true): number {
  if (!isAuthority(world) || world.isReplaying || !world.has(e, Progression)) return 0;
  // ADR-225: AI humans (virtual players) compress a player's hours into their short lives: x aiHumanMul
  // ADR-234: fractional XP carries over per entity (Math.round erased +5% / +10% XP on the 1-6 XP activity awards)
  const amount = carryRound(world, "xp", e, base * (1 + skillMod(world, e, "xp")) * (isAiHuman(world, e) ? XP.aiHumanMul ?? 1 : 1));
  if (amount <= 0) return 0;
  const ti = treeOfSource(source); credit(world, e, ti, amount); emit(world, XpGained, { entity: e, source, amount, tree: TREE_KEYS[ti]! });
  const sh = share ? skillMod(world, e, "share") : 0;
  if (sh > 0) for (const m of matesNear(world, e, XP_SHARE_RADIUS)) { const each = carryRound(world, "share", m, amount * sh); if (each > 0) credit(world, m, ti, each); } // ADR-234: carried, not rounded to 0
  return amount;
}
function addXp(world: World, e: Entity, amount: number): void {
  // ADR-209: the global row is now only the character level (kill / PvP / horde scaling); skill points are per tree
  const p = world.get(e, Progression)!; let { xp, level } = p; xp += amount; let up = false;
  while (level < SKILLS.levels.maxLevel && xp >= xpToNext(level)) { xp -= xpToNext(level); level++; up = true; }
  if (level >= SKILLS.levels.maxLevel) xp = Math.min(xp, xpToNext(level));
  world.set(e, Progression, { xp, level });
  if (up) emit(world, LevelUp, { entity: e, level, points: treesOf(world, e)!.reduce((s, t) => s + t.points, 0) });
}
function matesNear(world: World, e: Entity, r: number): Entity[] {
  const m = world.get(e, Membership); const t = world.get(e, Transform); if (!m || !t || (!m.partyId && !m.clanId)) return [];
  const out: Entity[] = [];
  for (const o of world.query([Progression, Membership, Transform], [Dead])) {
    if (o === e) continue; const om = world.get(o, Membership)!; if (!((m.partyId && om.partyId === m.partyId) || (m.clanId && om.clanId === m.clanId))) continue;
    const ot = world.get(o, Transform)!; if (Math.hypot(ot.x - t.x, ot.y - t.y) <= r) out.push(o);
  }
  return out.sort((a, b) => a - b);
}

// ---- unlock / respec ---------------------------------------------------------------------------------
export type SkillReject = "no_progression" | "bad_node" | "owned" | "requires" | "points" | "retired" | "cost" | "nothing";
export function canUnlock(world: World, e: Entity, node: number): SkillReject | undefined {
  const w = nodeWords(world, e); if (!w) return "no_progression";
  const n = skillNode(node); if (!n) return "bad_node"; if (n.retired) return "retired";
  if (wordsHas(w, node)) return "owned";
  if (!SKILL_REQS[node]!.every((r) => wordsHas(w, r))) return "requires";
  if (treePoints(world, e, SKILL_NODE_TREE[node]!) < n.cost) return "points"; // ADR-209: only this tree's points
  return undefined;
}
export function unlockSkill(world: World, e: Entity, node: number): SkillReject | undefined {
  const why = canUnlock(world, e, node); if (why) return why; migrateProgression(world, e);
  const ti = SKILL_NODE_TREE[node]!; world.setElement(e, Progression, "tpoints", ti, treePoints(world, e, ti) - skillNode(node)!.cost);
  const a = world.getArray(e, Progression, "nodes")!; world.setElement(e, Progression, "nodes", node >>> 5, (a[node >>> 5]! | (1 << (node & 31))) >>> 0);
  emit(world, SkillUnlocked, { entity: e, node }); return undefined;
}
export const respecCost = (world: World, e: Entity): number => SKILLS.respec.base + SKILLS.respec.perRespec * (world.getField(e, Progression, "respecs") ?? 0);
export function canRespec(world: World, e: Entity): SkillReject | undefined {
  if (!world.has(e, Progression)) return "no_progression"; if (!ownedNodes(world, e).some((i) => !isUnlockNode(i))) return "nothing";
  const item = safeItem(world, SKILLS.respec.item); if (item === undefined || countItem(world, e, item) < respecCost(world, e)) return "cost";
  return undefined;
}
export function respecSkills(world: World, e: Entity): SkillReject | undefined {
  const why = canRespec(world, e); if (why) return why;
  const cost = respecCost(world, e); removeItem(world, e, gameplayDefs(world).itemId(SKILLS.respec.item), cost);
  migrateProgression(world, e); // ADR-209: each tree's spent points go back to that tree
  // ADR-221: unlock nodes are permanent knowledge: kept, not refunded
  const owned = ownedNodes(world, e); const spent = TREE_KEYS.map(() => 0); for (const i of owned) if (!isUnlockNode(i)) spent[SKILL_NODE_TREE[i]!]! += skillNode(i)!.cost;
  let refunded = 0; spent.forEach((s, ti) => { const r = Math.floor(s * SKILLS.respec.refundFraction); refunded += r; if (r) world.setElement(e, Progression, "tpoints", ti, Math.min(0xffff, treePoints(world, e, ti) + r)); });
  const keep = new Array<number>(SKILL_NODE_WORDS).fill(0); for (const i of owned) if (isUnlockNode(i)) keep[i >>> 5] = (keep[i >>> 5]! | (1 << (i & 31))) >>> 0;
  for (let i = 0; i < SKILL_NODE_WORDS; i++) world.setElement(e, Progression, "nodes", i, keep[i]!);
  const p = world.get(e, Progression)!; world.set(e, Progression, { respecs: Math.min(255, p.respecs + 1) });
  emit(world, SkillsRespecced, { entity: e, refunded, cost }); return undefined;
}

function safeItem(world: World, key: string): number | undefined { try { return gameplayDefs(world).itemId(key); } catch { return undefined; } }

// ---- AI (personality) ---------------------------------------------------------------------------------
/** Branch weights per trait: brave -> combat, industrious -> crafting/building/farming, social -> leadership/cooking/medicine, greedy -> survival/vehicles/husbandry, chatty -> leadership; low bravery -> stealth. */
const BRANCH_TRAITS: Record<string, (t: Traits) => number> = {
  survival: (t) => 0.6 + 0.4 * t.greed, combat: (t) => 0.3 + 1.2 * t.bravery, crafting: (t) => 0.4 + t.industriousness, farming: (t) => 0.3 + 0.8 * t.industriousness,
  husbandry: (t) => 0.2 + 0.6 * t.industriousness + 0.3 * t.greed, cooking: (t) => 0.3 + 0.6 * t.sociability, medicine: (t) => 0.3 + 0.5 * t.sociability + 0.3 * (1 - t.bravery),
  building: (t) => 0.3 + 0.9 * t.industriousness, vehicles: (t) => 0.2 + 0.5 * t.greed + 0.3 * t.bravery, stealth: (t) => 0.2 + 0.9 * (1 - t.bravery),
  perks: (t) => 0.1 + 0.4 * t.greed, leadership: (t) => 0.1 + 0.7 * t.sociability + 0.4 * t.chattiness,
};
/** ADR-221: unlock tokens AI survivors need for their base plan (campfire, workbench, wood tier). */
export const AI_FIRST_UNLOCKS: ReadonlySet<string> = new Set(["piece:campfire", "piece:workbench", "tier:wood"]);
/** Best affordable node for a personality (deterministic: ties -> lower index). undefined when nothing is affordable. */
export function pickSkillNode(world: World, e: Entity, traits: Traits): number | undefined {
  let best: number | undefined, bestScore = -Infinity;
  for (let i = 0; i < SKILLS.nodes.length; i++) {
    if (canUnlock(world, e, i)) continue; const n = skillNode(i)!;
    let s = (BRANCH_TRAITS[n.branch]?.(traits) ?? 0.5) * (1 + 0.15 * n.tier) / n.cost;
    // ADR-221: stations / tiers gate progress, so AI learns them first (the ones its build plan needs first of all)
    if (isUnlockNode(i)) s *= n.effects.unlock!.some((u) => AI_FIRST_UNLOCKS.has(u)) ? 20 : 4;
    if (s > bestScore) { bestScore = s; best = i; }
  }
  return best;
}

// ---- install -----------------------------------------------------------------------------------------
function fnv(s: string): number { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h; }
export const SKILLS_HASH = fnv(JSON.stringify(SKILLS));
const isPlayer = (world: World, e: Entity): boolean => world.isAlive(e) && world.has(e, Progression);
/** Hooks XP sources + the recipe skill provider. Entities without Progression (NPC crafters, legacy tests) are not gated. */
export function installProgression(world: World): void {
  world.addSchemaSalt("gameplay.skills", SKILLS_HASH);
  setSkillLevelProvider(world, (e, key) => skillLevelOf(world, e, key) ?? Number.MAX_SAFE_INTEGER);
  setUnlockProvider(world, (e, token) => hasSkillUnlock(world, e, token)); // ADR-221
  const defs = gameplayDefs(world);
  // ADR-135: small XP for every activity (data/xp.json sources); kills scaled by victim type / kind / level
  const TOOL_SRC: Partial<Record<number, XpSource>> = { [ToolKind.Axe]: "chop", [ToolKind.Pickaxe]: "mine", [ToolKind.Shovel]: "dig" };
  // ADR-225: one award per successful swing (a swing emits one ItemGathered per yield line; it used to pay XP x item count)
  const swungAt = new Map<Entity, string>();
  world.events.on(ItemGathered, (p: { entity: Entity; node: Entity; count: number }) => {
    if (!isPlayer(world, p.entity)) return;
    const key = `${world.tick}:${p.node}`; if (swungAt.get(p.entity) === key) return; swungAt.set(p.entity, key);
    if (swungAt.size > 1024) swungAt.clear();
    const kind = world.getField(p.node, ResourceNode, "kind");
    const r = kind === undefined ? undefined : defs.resources.get(kind);
    awardXp(world, p.entity, r?.key.startsWith("crop_") ? "farm" : (r && TOOL_SRC[r.requiredTool]) || "gather");
  });
  world.events.on(CraftCompleted, (p: { entity: Entity; recipe: number; item: number }) => {
    if (!isPlayer(world, p.entity)) return; const it = defs.items.get(p.item);
    awardXp(world, p.entity, it?.food && it.food.hunger > 0 ? "cook" : "craft");
  });
  const killedAt = new Map<Entity, number>();
  world.events.on(Damaged, (p: { target: Entity; source: Entity; amount: number }) => {
    if (!isPlayer(world, p.source) || p.source === p.target || world.has(p.target, BuildPiece)) return;
    awardXp(world, p.source, "combat", p.amount);
    if ((world.getField(p.target, Health, "hp") ?? 1) > 0) return;
    const last = killedAt.get(p.target); if (last !== undefined && world.tick - last < 40) return; // one award per death
    killedAt.set(p.target, world.tick); if (killedAt.size > 512) for (const [k, t] of killedAt) if (world.tick - t >= 40) killedAt.delete(k);
    const vt = victimType(world, p.target); if (!vt) return;
    const f = vt === "player" ? pvpFactor(world, p.source, p.target, DEFAULT_TICK_HZ) : 1;
    awardXpRaw(world, p.source, vt === "animal" ? "hunt" : "kill", killXpBase(world, p.target) * f);
  });
  world.events.on(PiecePlaced, (p: { builder: Entity }) => { if (isPlayer(world, p.builder)) awardXp(world, p.builder, "build"); });
  world.events.on(ItemConsumed, (p: { entity: Entity; item: number }) => {
    const f = defs.items.get(p.item)?.food; if (!isPlayer(world, p.entity) || !f) return;
    if (f.health > 0 && f.hunger === 0) awardXp(world, p.entity, "heal");
    else awardXp(world, p.entity, f.hunger > 0 ? "eat" : "drink");
  });
  world.events.on(WaterDrunk, (p: { entity: Entity }) => { if (isPlayer(world, p.entity)) awardXp(world, p.entity, "drink"); });
  world.events.on(XpActivity, (p: { entity: Entity; source: string; units: number }) => { if (isPlayer(world, p.entity)) awardXp(world, p.entity, p.source as XpSource, p.units); });
  world.events.on(VehicleRepaired, (p: { entity: Entity }) => { if (isPlayer(world, p.entity)) awardXp(world, p.entity, "repair"); });
}
/** ADR-209: converts unmigrated Progression rows (legacy saves, fresh spawns) on the authority every tick. */
export function progressionMigrateSystem(world: World): void {
  if (!isAuthority(world) || world.isReplaying) return;
  for (const e of world.query([Progression])) if ((world.getField(e, Progression, "tver") ?? 0) < PROGRESSION_TVER) migrateProgression(world, e);
}
/** ADR-135 travel XP (every 20 ticks): tiles walked / driven, teleports ignored. */
export function xpTravelSystem(world: World): void {
  if (!isAuthority(world) || world.isReplaying) return;
  for (const a of travelStep(world, DEFAULT_TICK_HZ, world.query([Progression, Transform], [Dead]))) awardXp(world, a.e, a.source, a.units, false);
}
/** Server/host command handlers (players and AI humans use the same commands). */
export function installSkillHandlers(world: World, h: CommandHandlers): void {
  h.on(UnlockSkillCmd, { validate: (v, ctx) => canUnlock(world, ctx.actor, v.node), handle: (v, ctx) => { unlockSkill(world, ctx.actor, v.node); } });
  h.on(RespecSkillsCmd, { validate: (_v, ctx) => canRespec(world, ctx.actor), handle: (_v, ctx) => { respecSkills(world, ctx.actor); } });
}
/** Gives a player entity its Progression row (called on spawn). */
export const PROGRESSION_WORDS = SKILL_NODE_WORDS;

// ---- view model (client skill-tree panel) ---------------------------------------------------------------
export type SkillNodeState = "owned" | "available" | "locked";
export interface SkillNodeView { index: number; key: string; name: string; branch: string; category: string; cx: number; cy: number; tier: number; x: number; y: number; cost: number; desc: string; /** ADR-219 generated from the effect data */ info: SkillDescription; icon: string; state: SkillNodeState; why?: SkillReject | undefined; requires: number[] }
/** ADR-132: one tab per category; node coordinates (cx, cy) are laid out per category tree, branches side by side. */
/** Lanes are 80 apart in skills.json but nodes draw 150 wide: spread them so siblings never overlap. */
export const LANE_SPREAD = 2.1;
export interface SkillCategoryView { key: string; name: string; icon: string; branches: string[]; nodes: number[]; owned: number; available: number; width: number; height: number; /** ADR-209 */ level: number; xp: number; next: number; points: number; maxed: boolean }
export interface ProgressionView { categories: SkillCategoryView[]; level: number; xp: number; next: number; points: number; respecCost: number; canRespec: SkillReject | undefined; branches: { key: string; name: string; icon: string }[]; nodes: SkillNodeView[]; width: number; height: number }
export function progressionView(world: World, e: Entity): ProgressionView | undefined {
  const p = world.get(e, Progression); if (!p) return undefined; const w = nodeWords(world, e)!; const trees = treesOf(world, e)!;
  const nodes = SKILLS.nodes.map((n, i): SkillNodeView => {
    const why = wordsHas(w, i) ? undefined : canUnlock(world, e, i);
    return { index: i, key: n.key, name: n.name, branch: n.branch, category: SKILL_NODE_CATEGORY[i]!, cx: 0, cy: n.y, tier: n.tier, x: n.x, y: n.y, cost: n.cost, desc: n.desc, info: skillDescription(i), icon: n.icon,
      state: wordsHas(w, i) ? "owned" : why === undefined || why === "points" ? "available" : "locked", why, requires: SKILL_REQS[i]! as number[] };
  });
  const categories = SKILLS.categories.map((c, ci): SkillCategoryView => {
    const tp = trees[ci]!;
    let cursor = 0; const idx: number[] = [];
    for (const b of c.branches) {
      const bn = nodes.filter((n) => n.branch === b); if (!bn.length) continue; const minX = Math.min(...bn.map((n) => n.x));
      for (const n of bn) { n.cx = cursor + (n.x - minX) * LANE_SPREAD; idx.push(n.index); }
      cursor += (Math.max(...bn.map((n) => n.x)) - minX) * LANE_SPREAD + 200;
    }
    const cn = idx.map((i) => nodes[i]!);
    return { key: c.key, name: c.name, icon: c.icon, branches: [...c.branches], nodes: idx, owned: cn.filter((n) => n.state === "owned").length,
      available: cn.filter((n) => n.state === "available" && n.why === undefined).length, width: Math.max(0, cursor - 200) + 240, height: Math.max(0, ...cn.map((n) => n.cy)) + 120,
      level: tp.level, xp: tp.xp, next: treeXpToNext(tp.level), points: tp.points, maxed: tp.level >= SKILLS.treeLevels.maxLevel };
  });
  return { categories, level: p.level, xp: p.xp, next: xpToNext(p.level), points: trees.reduce((s, t) => s + t.points, 0), respecCost: respecCost(world, e), canRespec: canRespec(world, e),
    branches: SKILLS.branches.map((b) => ({ ...b })), nodes, width: Math.max(...nodes.map((n) => n.x)) + 240, height: Math.max(...nodes.map((n) => n.y)) + 120 };
}
export const SKILL_REJECT_TEXT: Readonly<Record<SkillReject, string>> = {
  no_progression: "No progression", bad_node: "Unknown skill", owned: "Already learned", requires: "Learn the connected skills first", points: "Not enough points in this tree",
  retired: "Retired skill", cost: "Not enough coin to respec", nothing: "No skills to reset",
};
export const unlockSkillIntent = (node: number): { cmd: typeof UnlockSkillCmd; args: { node: number } } => ({ cmd: UnlockSkillCmd, args: { node } });
export const respecSkillsIntent = (): { cmd: typeof RespecSkillsCmd; args: Record<string, never> } => ({ cmd: RespecSkillsCmd, args: {} });
