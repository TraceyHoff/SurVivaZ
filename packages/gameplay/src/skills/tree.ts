/**
 * ADR-113 skill tree data + pure reads (no gameplay imports besides components, so every system can hook it without
 * import cycles). Node index = bit in Progression.nodes (skills.json order is append-only).
 */
import { entityIndex, type Entity, type World } from "@engine/core";
import raw from "../../data/skills.json";
import { Progression } from "../components.js";

export type SkillMod = "gather" | "cropYield" | "carry" | "fuel" | "vfuel" | "repair" | "nutrition" | "heal" | "produce" | "tame" | "share" | "xp" | "noise" | `dmg_${string}`;
/** ADR-135: keys of data/xp.json sources (the single XP table). */
export type XpSource = keyof typeof import("../../data/xp.json")["sources"];
export interface SkillNodeDef {
  key: string; name: string; branch: string; tier: number; x: number; y: number; cost: number; requires: string[]; desc: string; icon: string; retired?: boolean;
  effects: { skill?: { key: string; level: number }; mods?: Partial<Record<string, number>>; perk?: string; /** ADR-221: "piece:<key>" / "tier:<key>" */ unlock?: string[] };
}
export interface SkillsData {
  levels: { base: number; growth: number; pointsPerLevel: number; maxLevel: number; bonusEvery: number; bonusPoints: number };
  /** ADR-209: per-tree curve (each category has its own XP / level / points). */
  treeLevels: { base: number; growth: number; early?: number[]; pointsPerLevel: number; maxLevel: number; bonusEvery: number; bonusPoints: number };
  respec: { item: string; base: number; perRespec: number; refundFraction: number };
  weaponClasses: Record<string, string[]>;
  husbandry: { feed: string; trough: string; reach: number; troughRange: number; penRadius: number; fedSeconds: number; tameBase: number; breedSeconds: number; maxPerTrough: number; animals: Record<string, { produce: string; seconds: number; diet?: string[] }> };
  branches: { key: string; name: string; icon: string }[];
  /** ADR-132: category trees (one UI tab each); every branch belongs to exactly one, prerequisites stay inside it. */
  categories: { key: string; name: string; icon: string; branches: string[] }[];
  nodes: SkillNodeDef[];
}
export const SKILLS: SkillsData = raw as unknown as SkillsData;
export const SKILL_NODE_WORDS = 8;
/** ADR-219: party / clan mates within this many tiles receive the "share" fraction of your XP. */
export const XP_SHARE_RADIUS = 20;
if (SKILLS.nodes.length > SKILL_NODE_WORDS * 32) throw new Error("skills.json: too many nodes for Progression.nodes");
const byKey = new Map(SKILLS.nodes.map((n, i) => [n.key, i]));
export const skillNodeIndex = (key: string): number => byKey.get(key) ?? -1;
export const skillNode = (i: number): SkillNodeDef | undefined => SKILLS.nodes[i];
/** Prerequisite indices per node. */
export const SKILL_REQS: readonly number[][] = SKILLS.nodes.map((n) => n.requires.map((r) => { const i = byKey.get(r); if (i === undefined) throw new Error(`skills.json: ${n.key} requires unknown ${r}`); return i; }));

/** ADR-132: category key per branch / node index. */
const catOfBranch = new Map<string, string>(); for (const c of SKILLS.categories) for (const b of c.branches) catOfBranch.set(b, c.key);
export const SKILL_NODE_CATEGORY: readonly string[] = SKILLS.nodes.map((n) => { const c = catOfBranch.get(n.branch); if (!c) throw new Error(`skills.json: branch ${n.branch} has no category`); return c; });
SKILLS.nodes.forEach((n, i) => { for (const r of SKILL_REQS[i]!) if (SKILL_NODE_CATEGORY[r] !== SKILL_NODE_CATEGORY[i]) throw new Error(`skills.json: ${n.key} requires ${SKILLS.nodes[r]!.key} from another category`); });
export const skillCategoryOf = (i: number): string | undefined => SKILL_NODE_CATEGORY[i];

/** Weapon class of an item key ("unarmed" for none). */
export function weaponClassOf(itemKey: string | undefined): string {
  if (!itemKey) return "unarmed";
  let best = "", bestLen = 0;
  for (const [c, pats] of Object.entries(SKILLS.weaponClasses)) for (const p of pats) if (itemKey.includes(p) && p.length > bestLen) { best = c; bestLen = p.length; }
  return best || "unarmed";
}

// ---- level curve -------------------------------------------------------------------------------------
export const xpToNext = (level: number): number => Math.round(SKILLS.levels.base * Math.pow(SKILLS.levels.growth, Math.max(0, level - 1)));
export const pointsForLevel = (level: number): number => SKILLS.levels.pointsPerLevel + (SKILLS.levels.bonusEvery > 0 && level % SKILLS.levels.bonusEvery === 0 ? SKILLS.levels.bonusPoints : 0);

// ---- per-entity reads --------------------------------------------------------------------------------
export function nodeWords(world: World, e: Entity): readonly number[] | undefined {
  if (!world.has(e, Progression)) return undefined; const a = world.getArray(e, Progression, "nodes"); return a ? Array.from(a) : undefined;
}
export const wordsHas = (w: readonly number[], i: number): boolean => ((w[i >>> 5] ?? 0) >>> (i & 31) & 1) === 1;
export function hasNode(world: World, e: Entity, i: number): boolean { const w = nodeWords(world, e); return !!w && wordsHas(w, i); }
export function ownedNodes(world: World, e: Entity): number[] { const w = nodeWords(world, e); if (!w) return []; const o: number[] = []; for (let i = 0; i < SKILLS.nodes.length; i++) if (wordsHas(w, i)) o.push(i); return o; }

interface Totals { mods: Map<string, number>; perks: Set<string>; skills: Map<string, number>; unlocks: Set<string> }
const cache = new Map<string, Totals>();
function totalsOf(w: readonly number[]): Totals {
  const k = w.join(","); let t = cache.get(k); if (t) return t;
  t = { mods: new Map(), perks: new Set(), skills: new Map(), unlocks: new Set() };
  for (let i = 0; i < SKILLS.nodes.length; i++) {
    if (!wordsHas(w, i)) continue; const n = SKILLS.nodes[i]!; if (n.retired) continue;
    for (const [m, v] of Object.entries(n.effects.mods ?? {})) t.mods.set(m, (t.mods.get(m) ?? 0) + (v ?? 0));
    if (n.effects.perk) t.perks.add(n.effects.perk);
    for (const u of n.effects.unlock ?? []) t.unlocks.add(u);
    if (n.effects.skill) t.skills.set(n.effects.skill.key, Math.max(t.skills.get(n.effects.skill.key) ?? 0, n.effects.skill.level));
  }
  if (cache.size > 512) cache.clear(); cache.set(k, t); return t;
}
/** Additive fraction for a mod (0 without Progression). Multiply by (1 + skillMod). */
/** ADR-212: totals of the live Progression words without copying / joining them (hot: movement speed, carry weight, every tick). */
const hashed = new Map<number, { w: number[]; t: Totals }>();
function liveTotals(world: World, e: Entity): Totals | undefined {
  if (!world.has(e, Progression)) return undefined; const st = world.store(Progression); const idx = entityIndex(e);
  let h = 0x811c9dc5, n = 0; for (let v = st.readElement(idx, "nodes", 0); v !== undefined; v = st.readElement(idx, "nodes", ++n)) h = Math.imul(h ^ (v >>> 0), 0x01000193);
  const hit = hashed.get(h);
  if (hit && hit.w.length === n) { let same = true; for (let i = 0; i < n; i++) if (hit.w[i] !== st.readElement(idx, "nodes", i)) { same = false; break; } if (same) return hit.t; }
  const w = nodeWords(world, e)!; const t = totalsOf(w); if (hashed.size > 512) hashed.clear(); hashed.set(h, { w: w.slice(), t }); return t;
}
export function skillMod(world: World, e: Entity, mod: SkillMod): number { return liveTotals(world, e)?.mods.get(mod) ?? 0; }
export const skillMul = (world: World, e: Entity, mod: SkillMod, min = 0.1): number => Math.max(min, 1 + skillMod(world, e, mod));
export function hasPerk(world: World, e: Entity, perk: string): boolean { return liveTotals(world, e)?.perks.has(perk) ?? false; }
/** Recipe skill level granted by nodes; undefined when the entity has no Progression (legacy / NPC crafters). */
export function skillLevelOf(world: World, e: Entity, key: string): number | undefined { const t = liveTotals(world, e); return t ? t.skills.get(key) ?? 0 : undefined; }
// ---- ADR-221 unlock gates (stations, building tiers) ----------------------------------------------------------
/** Gate token -> node index that grants it. Tokens no node grants (twig tier, non-station pieces) are never gated. */
export const UNLOCK_NODE: ReadonlyMap<string, number> = new Map(SKILLS.nodes.flatMap((n, i) => (n.retired ? [] : (n.effects.unlock ?? []).map((u) => [u, i] as [string, number]))));
/** True for unlock (knowledge) nodes: kept on respec, granted free to pre-ADR-221 characters. */
export const isUnlockNode = (i: number): boolean => !!SKILLS.nodes[i]?.effects.unlock?.length;
export const pieceToken = (key: string): string => `piece:${key}`;
export const tierToken = (key: string): string => `tier:${key}`;
/** Whether e may use gate `token`. Ungated tokens and entities without Progression (NPC crafters, legacy tests) pass. */
export function hasSkillUnlock(world: World, e: Entity, token: string): boolean {
  if (!UNLOCK_NODE.has(token)) return true; const t = liveTotals(world, e); return !t || t.unlocks.has(token);
}
/** Node granting `token` (undefined = not gated), for the "Requires <skill> (<tree>)" UI hint. */
export function unlockRequirement(token: string): { node: number; name: string; tree: string; cost: number } | undefined {
  const i = UNLOCK_NODE.get(token); if (i === undefined) return undefined; const n = SKILLS.nodes[i]!;
  return { node: i, name: n.name, tree: SKILLS.categories.find((c) => c.key === SKILL_NODE_CATEGORY[i])?.name ?? "", cost: n.cost };
}
/** Damage multiplier for the held weapon class. */
export const damageMulFor = (world: World, e: Entity, itemKey: string | undefined): number => skillMul(world, e, `dmg_${weaponClassOf(itemKey)}`);
/** Integer amount scaled by a multiplier with a deterministic fractional roll (r in [0,1)). */
export const scaleCount = (n: number, mul: number, r: number): number => { const v = n * mul; const f = Math.floor(v); return f + (r < v - f ? 1 : 0); };

// ---- ADR-209 per-tree progression ---------------------------------------------------------------------
/** Tree (category) keys; index = slot in Progression.txp / tlevel / tpoints. skills.json categories are append-only. */
export const TREE_KEYS: readonly string[] = SKILLS.categories.map((c) => c.key);
export const TREE_SLOTS = 8;
if (TREE_KEYS.length > TREE_SLOTS) throw new Error("skills.json: too many categories for Progression tree slots");
const treeIdx = new Map(TREE_KEYS.map((k, i) => [k, i]));
export const treeIndex = (key: string): number => treeIdx.get(key) ?? -1;
export const treeName = (i: number): string => SKILLS.categories[i]?.name ?? "";
/** Short tab label ("Survival & Gathering" -> "Survival"). */
export const treeShortName = (i: number): string => treeName(i).split(/[ ,&]/)[0] || treeName(i);
export const SKILL_NODE_TREE: readonly number[] = SKILL_NODE_CATEGORY.map((c) => treeIdx.get(c)!);
/** ADR-225: XP from `level` to `level+1`. `early[level-1]` (hand-tuned first levels) when present, then geometric from the last early step (or `base`). */
export const treeXpToNext = (level: number): number => treeXpCurve(level, SKILLS.treeLevels);
export function treeXpCurve(level: number, c: { base: number; growth: number; early?: readonly number[] }): number {
  const l = Math.max(1, level); const e = c.early ?? [];
  if (l <= e.length) return e[l - 1]!;
  return e.length ? Math.round(e[e.length - 1]! * Math.pow(c.growth, l - e.length)) : Math.round(c.base * Math.pow(c.growth, l - 1));
}
export const treePointsForLevel = (level: number): number => SKILLS.treeLevels.pointsPerLevel + (SKILLS.treeLevels.bonusEvery > 0 && level % SKILLS.treeLevels.bonusEvery === 0 ? SKILLS.treeLevels.bonusPoints : 0);
/** Points a tree has earned in total at `level` (level 1 = 0). */
export function treePointsAtLevel(level: number): number { let p = 0; for (let l = 2; l <= level; l++) p += treePointsForLevel(l); return p; }
export interface TreeProgress { xp: number; level: number; points: number }
/** Per-tree xp / level / unspent points (level 0 in an unmigrated row reads as 1). */
export function treeProgress(world: World, e: Entity): TreeProgress[] | undefined {
  if (!world.has(e, Progression)) return undefined;
  const x = world.getArray(e, Progression, "txp"), l = world.getArray(e, Progression, "tlevel"), p = world.getArray(e, Progression, "tpoints");
  return TREE_KEYS.map((_, i) => ({ xp: x?.[i] ?? 0, level: Math.max(1, l?.[i] ?? 1), points: p?.[i] ?? 0 }));
}
