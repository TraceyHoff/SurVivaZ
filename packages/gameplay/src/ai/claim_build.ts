/**
 * ADR-337: claim-and-build for unhired AI humans (Task 37, the user's question 3).
 *
 * An unhired bot with no home and met survival needs claims land instead of wandering:
 * it repairs / rebuilds the nearest mostly-intact abandoned ruin, or plants a Claim Flag
 * and builds an enclosed 2x2 hut of its own design. Hired workers keep following their
 * employer's jobs and never claim land of their own.
 *
 * The layer is a decision + plan layer only. It writes no world state except AiMemory
 * (the planner's own base anchor, on the new-home handoff) and the agent blackboard
 * (the active claim target + the next step's material priority). Everything it asks the
 * bot to do goes through the same commands a human sends (`build:` / `repair:` /
 * `reclaim:`), so reach, cost, skill gates and privilege stay server-validated.
 *
 * Stage machine (recomputed from world state every sense tick, so it is deterministic
 * given (bot, world state) and needs no persisted stage):
 *   ruin:  claim flag -> reclaim the site -> repair damaged pieces -> rebuild missing
 *          pieces from the site's planned layout (planAbandonedSite is a pure function
 *          of (seed, origin, kind, rot), so the layout is recoverable at runtime; the
 *          rotation is found by matching live pieces) -> done. When the layout cannot
 *          be matched at all (no live piece matches any rotation), the footprint is
 *          rebuilt as a 2x2 hut (BASE_SLOTS).
 *   new:   claim flag -> hand the site to the planner (mem.base = anchor; the planner's
 *          own ladder builds the hut, flag-first by its own rule) -> build the variant
 *          extras ("own design": a deterministic per-bot layout variant from
 *          ai_claim.json — same pieces, same costs, never a new piece type) -> done.
 * A ruin home never gets a planner base anchor (the planner would try to build
 * BASE_SLOTS over the ruin); the self-claimed ruin marker IS its home record, and the
 * sensor re-adopts it after a restart. Materials for the next step are returned as a
 * Plan-like leaves list AND as a `claimPriority` blackboard entry, so the planner's
 * normal item goals gather / craft them (makePlan `priority`, same as the saddle
 * chain) — the flag's 10 logs come through the ordinary wood goal, not a special case.
 *
 * Wiring (coordinator-owned, see /tmp/task37-337-integration.md): fillClaimSensors is
 * called in computeGoalSensors before the fillPlanSensors block; claimBuildBehaviors()
 * joins the survivor registry; AgentWorldView gains `claimTarget` / `claimPlan`.
 */
import { PlayerId, Transform, type Agent, type AgentContext, type Entity, type World } from "@engine/core";
import { AbandonedSite, BuildPiece, PieceSlot, Survival, Worker } from "../components.js";
import { GameplayConfig, gameplayDefs } from "../config.js";
import { countItem } from "../inventory.js";
import { maxHpOf } from "../building/integrity.js";
import { hasOwnClaim, pieceCost, pieceUnlocked, snapPlacement, validatePlacement } from "../building/place.js";
import { planAbandonedSite, siteUnclaimed, type AbandonedKindId, type PlannedPiece, type PlannedSite } from "../building/abandoned.js";
import { aiMemoryOf, BASE_SLOTS, BUILD_STAND, bumpStat, claimBaseSite, markAiDirty, pickBaseSite, plannerIndex, scanBase, siteClaimOk, STATION_SLOTS, type Step } from "./planner.js";
import { agentWorld, goTo } from "./base_behaviors.js";
import { pieceAt, stuckOn } from "./autonomy.js";
import type { AgentWorldView, GameBehavior } from "../agents.js";
import claimData from "../../data/ai_claim.json";

export interface ClaimVariantExtra { key: string; x: number; y: number; level?: number; rot?: number }
export interface ClaimVariant { key: string; extras: ClaimVariantExtra[] }
export interface ClaimData {
  scanRadius: number; ruinPreferDist: number; minIntact: number; maxDamagedFrac: number;
  repairHpFrac: number; needs: { minHunger: number; minThirst: number; minBodyTemp: number };
  claimAbandonDist: number; variants: ClaimVariant[];
}
export const CLAIM_DATA: ClaimData = claimData as unknown as ClaimData;

export type ClaimKind = "ruin" | "new";
export type ClaimStage = "gather" | "claim" | "reclaim" | "repair" | "rebuild" | "extras" | "done";
export interface ClaimTarget {
  kind: ClaimKind; stage: ClaimStage;
  /** site anchor: the ruin origin, or the new hut's north-west foundation corner. */
  x: number; y: number;
  /** where the bot walks to reclaim (ruin marker) / work the site (hut centre). */
  mx: number; my: number;
  marker?: Entity;
  /** new-home layout variant key (ai_claim.json). */
  variant?: string;
  /** ruin intact fraction (standing structural pieces / planned structural pieces). */
  intact?: number;
  /** ruin rebuild pieces / damaged pieces still outstanding. */
  missing?: number; damaged?: number;
}
export type ClaimStep = Step | { k: "reclaim"; marker: Entity } | { k: "repair"; piece: Entity };
export interface ClaimPlan {
  goal: string; target: ClaimTarget;
  step?: ClaimStep; leaves: number[]; hunt: number[]; keep: Set<number>; blocked: string[];
  /** materials the next step still lacks ({key, count} for the planner's priority chain). */
  priority?: { key: string; count: number }[];
  /** claim slot ids currently satisfied (the sensor clears these from AiMemory.fails). */
  doneSlots: string[];
}
/** What the sensor keeps on the agent blackboard between sense ticks. */
export interface ClaimTargetState { kind: ClaimKind; x: number; y: number; marker?: Entity; variant?: string }
/** The two view fields the coordinator adds to AgentWorldView (agents.ts). */
export interface ClaimView { claimTarget?: ClaimTarget; claimPlan?: ClaimPlan }

/** A build slot is abandoned after this many emitted-but-unfulfilled attempts (planner idiom: mem.fails). */
export const CLAIM_FAILS = 4;
/** Structural roles rebuilt at a ruin (furniture / loot / garden are reclaimed, not rebuilt). */
const STRUCTURAL: ReadonlySet<string> = new Set(["deck", "wall", "opening", "stair", "roof", "fence"]);
const PHASE: Record<string, number> = { deck: 0, wall: 1, opening: 2, stair: 3, fence: 4, roof: 5 };

const hash = (s: string): number => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0) / 4294967296; };
export const botPlayerId = (world: World, self: Entity): number => world.isRegistered(PlayerId) ? world.getField(self, PlayerId, "id") ?? 0 : 0;
/** Hired workers (Worker.owner != 0) follow their employer's jobs; they never claim land. */
export const isHiredBot = (world: World, self: Entity): boolean => (world.getField(self, Worker, "owner") ?? 0) !== 0;
/** Survival needs met (same cutoffs autonomy uses for hungry / thirsty / cold). */
export function needsMet(world: World, self: Entity): boolean {
  const d = CLAIM_DATA.needs;
  return (world.getField(self, Survival, "hunger") ?? 100) >= d.minHunger
    && (world.getField(self, Survival, "thirst") ?? 100) >= d.minThirst
    && (world.getField(self, Survival, "bodyTemp") ?? 37) >= d.minBodyTemp;
}
export function variantFor(world: World, self: Entity): ClaimVariant {
  const vs = CLAIM_DATA.variants.length ? CLAIM_DATA.variants : [{ key: "homestead", extras: [] }];
  return vs[Math.abs(botPlayerId(world, self)) % vs.length]!;
}
const variantByKey = (key?: string): ClaimVariant | undefined => CLAIM_DATA.variants.find((v) => v.key === key);

const defsOf = (world: World): ReturnType<typeof gameplayDefs> | undefined => world.getResource(GameplayConfig)?.defs;
const standNear = (b: { x: number; y: number }, x: number, y: number): { x: number; y: number } => {
  const tx = b.x + BUILD_STAND.x, ty = b.y + BUILD_STAND.y; const dx = tx - x, dy = ty - y, d = Math.hypot(dx, dy) || 1;
  return d < 1.6 ? { x: tx, y: ty } : { x: x + (dx / d) * 1.6, y: y + (dy / d) * 1.6 };
};
/** Materials of one build / repair the bot does not already carry (bag only — a claiming bot has no base storage yet). */
export function missingMaterials(world: World, self: Entity, def: { id: number; key: string }, tier: number, scale = 1): { item: number; key: string; count: number }[] {
  const defs = defsOf(world); if (!defs) return [];
  const out: { item: number; key: string; count: number }[] = [];
  for (const c of pieceCost(defs, def as Parameters<typeof pieceCost>[1], tier, scale)) {
    const have = countItem(world, self, c.item);
    if (have < c.count) out.push({ item: c.item, key: defs.items.get(c.item)?.key ?? `${c.item}`, count: c.count - have });
  }
  return out;
}
const ghostOk = (world: World, self: Entity, piece: number, x: number, y: number, level: number, rot: number, tier: number): boolean => {
  const sn = snapPlacement(world, { piece, x, y, level, rot, tier, variant: 0 });
  return typeof sn !== "number" && validatePlacement(world, self, sn, { ignoreCost: true, ignoreRange: true }) === 0;
};
/** First ghost-placeable Claim Flag slot beside `anchor` (STATION_SLOTS.claim_totem order). */
export function flagSlot(world: World, self: Entity, anchor: { x: number; y: number }): { x: number; y: number; i: number } | undefined {
  const defs = defsOf(world); if (!defs) return undefined;
  const flag = plannerIndex(defs).piece.get("claim_totem"); if (!flag) return undefined;
  for (let i = 0; i < STATION_SLOTS.claim_totem!.length; i++) {
    const s = STATION_SLOTS.claim_totem![i]!;
    if (ghostOk(world, self, flag.id, anchor.x + s.x, anchor.y + s.y, 0, 0, 0)) return { x: anchor.x + s.x, y: anchor.y + s.y, i };
  }
  return undefined;
}
const flagSlotId = (x: number, y: number): string => `claim:${x},${y}`;

/** One build attempt: slot-fail / skill / snap / placement gates, then the materials check. */
function nextBuild(world: World, self: Entity, def: { id: number; key: string; tiered?: boolean; fixedTier: number; minTier?: number }, x: number, y: number, level: number, rot: number, tier: number, slotId: string, anchor: { x: number; y: number }, fails: Record<string, number>): { step?: Step; missing?: { item: number; key: string; count: number }[]; blocked?: string } {
  if ((fails[slotId] ?? 0) >= CLAIM_FAILS) return { blocked: "slot-failed" };
  const effTier = def.tiered ? Math.max(def.minTier ?? 1, tier) : def.fixedTier;
  if (!pieceUnlocked(world, self, def as Parameters<typeof pieceUnlocked>[2], effTier)) return { blocked: `locked:${def.key}` };
  const sn = snapPlacement(world, { piece: def.id, x, y, level, rot, tier: effTier, variant: 0 });
  if (typeof sn === "number") return { blocked: "no-snap" };
  if (validatePlacement(world, self, sn, { ignoreCost: true, ignoreRange: true }) !== 0) return { blocked: "no-place" };
  const missing = missingMaterials(world, self, def, effTier);
  if (missing.length) return { missing };
  return { step: { k: "build", piece: def.id, x: sn.pos.x, y: sn.pos.y, level, ...(rot ? { rot } : {}), ...(effTier ? { tier: effTier } : {}), slot: slotId, stand: standNear(anchor, sn.pos.x, sn.pos.y) } };
}
const planOut = (goal: string, target: ClaimTarget, extra: Partial<ClaimPlan> = {}): ClaimPlan =>
  ({ goal, target, leaves: [], hunt: [], keep: new Set(), blocked: [], doneSlots: [], ...extra });

// ---------------- ruin layout (cached per marker, 20 ticks like scanBase) ----------------
export interface RuinLayout {
  rot: number; plan: PlannedSite; total: number; matched: number; intact: number; score: number;
  /** planned structural pieces with no live piece (each carries its stable slot id). */
  missing: (PlannedPiece & { slotId: string })[];
  /** live pieces in the footprint under the repair threshold. */
  damaged: Entity[];
  /** structural pieces damaged (for the too-ruined check). */
  damagedStructural: number;
  /** slot ids of the structural pieces still standing. */
  presentSlots: string[];
  /** true when no live piece matched any rotation — the planned layout is unrecoverable. */
  fallback: boolean;
}
interface LivePiece { e: Entity; key: string; x: number; y: number; level: number; hp: number; max: number }
const layoutCache = new WeakMap<World, Map<number, { tick: number; layout: RuinLayout | undefined }>>();
const LAYOUT_TTL = 20;
function livePieces(world: World, ox: number, oy: number, w: number, h: number): LivePiece[] {
  const defs = defsOf(world); const out: LivePiece[] = [];
  for (const e of world.query([BuildPiece, Transform])) {
    const t = world.get(e, Transform)!; if (t.x < ox - 0.6 || t.x > ox + w + 0.6 || t.y < oy - 0.6 || t.y > oy + h + 0.6) continue;
    const type = world.getField(e, BuildPiece, "type"); const def = type !== undefined ? defs?.pieces.get(type) : undefined; if (!def) continue;
    const lvl = world.getField(e, PieceSlot, "z") ?? Math.round((t.z ?? 0) / (defs?.building.levelHeight ?? 3));
    out.push({ e, key: def.key, x: t.x, y: t.y, level: lvl, hp: world.getField(e, BuildPiece, "hp") ?? 0, max: maxHpOf(world, e) });
  }
  return out;
}
/** The site's planned layout, recovered from (seed, origin, kind) by matching live pieces across rotations. */
export function ruinLayout(world: World, marker: Entity): RuinLayout | undefined {
  let m = layoutCache.get(world); if (!m) layoutCache.set(world, (m = new Map()));
  const c = m.get(marker);
  if (c && world.tick - c.tick < LAYOUT_TTL && world.tick >= c.tick) return c.layout;
  const layout = computeRuinLayout(world, marker);
  if (m.size > 256) m.clear(); m.set(marker, { tick: world.tick, layout }); return layout;
}
function computeRuinLayout(world: World, marker: Entity): RuinLayout | undefined {
  const ox = world.getField(marker, AbandonedSite, "originX"); const oy = world.getField(marker, AbandonedSite, "originY");
  const w = world.getField(marker, AbandonedSite, "width") ?? 8, h = world.getField(marker, AbandonedSite, "height") ?? 8;
  const kind = world.getField(marker, AbandonedSite, "kind");
  if (ox === undefined || oy === undefined || kind === undefined) return undefined;
  const live = livePieces(world, ox, oy, w, h);
  const match = (p: PlannedPiece): boolean => live.some((l) => l.key === p.key && Math.abs(l.x - p.x) < 0.6 && Math.abs(l.y - p.y) < 0.6 && l.level === p.level);
  let best: { rot: number; plan: PlannedSite; structural: PlannedPiece[]; score: number } | undefined;
  for (let rot = 0; rot < 4; rot++) {
    const plan = planAbandonedSite(world.seed, ox, oy, { kind: kind as AbandonedKindId, rot });
    const structural = plan.pieces.filter((p) => STRUCTURAL.has(p.role));
    const score = structural.filter(match).length;
    if (!best || score > best.score) best = { rot, plan, structural, score };
  }
  const { rot, plan, structural, score } = best!;
  const total = structural.length;
  const missingPlanned = structural.filter((p) => !match(p));
  const frac = CLAIM_DATA.repairHpFrac;
  const damaged = live.filter((l) => l.max > 0 && l.hp < l.max * frac).map((l) => l.e);
  const damagedStructural = live.filter((l) => STRUCTURAL.has(plan.pieces.find((p) => p.key === l.key)?.role ?? "") && l.max > 0 && l.hp < l.max * frac).length;
  const presentSlots = structural.filter(match).map((p) => `ruin:${p.key}:${p.x},${p.y}`);
  if (score === 0) {
    // ADR-337 fallback: nothing matches the plan, so the footprint is rebuilt as a 2x2 hut.
    const missing = BASE_SLOTS.filter((s) => !live.some((l) => l.key === s.key && Math.abs(l.x - (ox + s.x)) < 0.6 && Math.abs(l.y - (oy + s.y)) < 0.6 && l.level === s.level))
      .map((s) => ({ key: s.key, x: ox + s.x, y: oy + s.y, level: s.level, rot: s.rot ?? 0, role: s.key.startsWith("roof") ? "roof" : s.key.startsWith("wall") || s.key === "door_wood" ? "wall" : "deck", tier: s.tier ?? 0, omit: false, hpFrac: 1, slotId: `ruin:${s.id}` }) as PlannedPiece & { slotId: string });
    return { rot, plan, total, matched: 0, intact: 0, score, missing, damaged, damagedStructural, presentSlots, fallback: true };
  }
  return {
    rot, plan, total, matched: score, intact: total ? score / total : 1, score,
    missing: missingPlanned.map((p) => ({ ...p, slotId: `ruin:${p.key}:${p.x},${p.y}` })),
    damaged, damagedStructural, presentSlots, fallback: false,
  };
}

// ---------------- ruin census ----------------
export interface RuinInfo {
  marker: Entity; x: number; y: number; originX: number; originY: number; width: number; height: number;
  kind: number; claimed: number; claimedBy: number; dist: number; intact: number; damagedFrac: number;
}
export function scanClaimRuins(world: World, x: number, y: number, radius = CLAIM_DATA.scanRadius): RuinInfo[] {
  const out: RuinInfo[] = [];
  if (!world.isRegistered(AbandonedSite)) return out;
  const r2 = radius * radius;
  for (const m of world.query([AbandonedSite, Transform])) {
    const t = world.get(m, Transform)!; const d2 = (t.x - x) * (t.x - x) + (t.y - y) * (t.y - y); if (d2 > r2) continue;
    const layout = ruinLayout(world, m); if (!layout) continue;
    const ox = world.getField(m, AbandonedSite, "originX")!, oy = world.getField(m, AbandonedSite, "originY")!;
    out.push({
      marker: m, x: t.x, y: t.y, originX: ox, originY: oy,
      width: world.getField(m, AbandonedSite, "width") ?? 8, height: world.getField(m, AbandonedSite, "height") ?? 8,
      kind: world.getField(m, AbandonedSite, "kind") ?? 0, claimed: world.getField(m, AbandonedSite, "claimed") ?? 0,
      claimedBy: world.getField(m, AbandonedSite, "claimedBy") ?? 0, dist: Math.sqrt(d2),
      intact: layout.intact, damagedFrac: layout.damagedStructural / Math.max(1, layout.matched),
    });
  }
  return out;
}

// ---------------- home checks ----------------
/** The planner's base: an anchor with anything built, or a fresh site pick still in progress. False when a built base was destroyed (ruined home). */
export function hasPlannerHome(world: World, self: Entity, agent: Agent): boolean {
  const mem = aiMemoryOf(agent);
  if (!mem.base) return false;
  const defs = defsOf(world); if (!defs) return true;
  const bs = scanBase(world, defs, mem.base);
  const n = bs.pieces.size + bs.stations.size + (bs.storage ? 1 : 0);
  if (n > 0) return true;
  if (mem.stats.built > 0) return false;
  return true;
}
function ownedRuinNear(world: World, self: Entity): RuinInfo | undefined {
  const pid = botPlayerId(world, self); if (!pid) return undefined;
  const t = world.get(self, Transform); if (!t) return undefined;
  const owned = scanClaimRuins(world, t.x, t.y).filter((r) => r.claimedBy === pid);
  owned.sort((a, b) => a.dist - b.dist || a.originX - b.originX || a.originY - b.originY);
  return owned[0];
}
/**
 * ADR-340: the adopted ruin home of a bot that has claimed + reclaimed a ruin — the anchor the
 * planner's base ladder runs against for behaviour goals (furnish / hearth / bed / upgrade / piece /
 * storage), never `mem.base`, so the `base` goal that builds BASE_SLOTS can never fire over the
 * ruin. The anchor is the ruin centre minus 1, so anchor+1 is the ruin centre (the same convention
 * as a hut anchor+1 = hut centre): scanBase, the furnish / upgrade scans and the station slots all
 * read from it. Undefined until the bot owns the ruin and it is reclaimed — during flag / reclaim
 * the claim layer still owns the site, and a dropped target (or a hired bot, whose target the sensor
 * clears) adopts nothing.
 */
export interface RuinHome { x: number; y: number; ox: number; oy: number; marker: Entity }
export function ruinHomeAnchor(world: World, self: Entity, agent: Agent): RuinHome | undefined {
  const target = agent.bb.get<ClaimTargetState>("claimTarget");
  if (!target || target.kind !== "ruin" || target.marker === undefined) return undefined;
  const marker = target.marker;
  if (!world.isAlive(marker)) return undefined;
  const pid = botPlayerId(world, self);
  if (!pid) return undefined;
  if ((world.getField(marker, AbandonedSite, "claimed") ?? 0) !== 1) return undefined;
  if ((world.getField(marker, AbandonedSite, "claimedBy") ?? 0) !== pid) return undefined;
  if (siteUnclaimed(world, marker)) return undefined;
  const ox = world.getField(marker, AbandonedSite, "originX") ?? target.x;
  const oy = world.getField(marker, AbandonedSite, "originY") ?? target.y;
  const w = world.getField(marker, AbandonedSite, "width") ?? 8;
  const h = world.getField(marker, AbandonedSite, "height") ?? 8;
  return { x: ox + w / 2 - 1, y: oy + h / 2 - 1, ox, oy, marker };
}
/**
 * A claim the bot already started (restart-safe): an owned ruin, a ruin whose flag is
 * down but which is not reclaimed yet, or a new-home flag with no planner base yet.
 * The flag-derived anchor is approximate (the first flag slot's offset) — the hut lands
 * a few tiles off at worst, still inside the flag's 32-tile claim.
 */
function adoptExisting(world: World, self: Entity): { kind: ClaimKind; marker?: Entity; x: number; y: number; variant?: string } | undefined {
  const owned = ownedRuinNear(world, self);
  if (owned) return { kind: "ruin", marker: owned.marker, x: owned.originX, y: owned.originY };
  const defs = defsOf(world); if (!defs) return undefined;
  const flag = plannerIndex(defs).piece.get("claim_totem"); if (!flag) return undefined;
  const t = world.get(self, Transform); if (!t) return undefined;
  const r = CLAIM_DATA.scanRadius;
  let best: { x: number; y: number; d: number } | undefined;
  for (const e of world.query([BuildPiece, Transform])) {
    if (world.getField(e, BuildPiece, "type") !== flag.id) continue;
    const p = world.get(e, Transform)!; const d = Math.hypot(p.x - t.x, p.y - t.y); if (d > r || (best && d >= best.d)) continue;
    if (!hasOwnClaim(world, self, p.x, p.y)) continue;
    best = { x: p.x, y: p.y, d };
  }
  if (!best) return undefined;
  const pid = botPlayerId(world, self);
  for (const m of world.query([AbandonedSite])) {
    const ox = world.getField(m, AbandonedSite, "originX")!, oy = world.getField(m, AbandonedSite, "originY")!;
    const w = world.getField(m, AbandonedSite, "width") ?? 8, h = world.getField(m, AbandonedSite, "height") ?? 8;
    const by = world.getField(m, AbandonedSite, "claimedBy") ?? 0;
    if ((world.getField(m, AbandonedSite, "claimed") ?? 0) === 0 || by === pid) {
      if (best.x >= ox - 2 && best.x <= ox + w + 2 && best.y >= oy - 2 && best.y <= oy + h + 2) return { kind: "ruin", marker: m, x: ox, y: oy };
    }
  }
  const s0 = STATION_SLOTS.claim_totem![0]!;
  return { kind: "new", x: best.x - s0.x, y: best.y - s0.y, variant: variantFor(world, self).key };
}

// ---------------- the choice ----------------
export interface ClaimChoice { kind: ClaimKind; marker?: Entity; x: number; y: number; variant?: string }
/**
 * Deterministic given (bot, world state): nearest suitable ruin wins when it is near
 * and mostly intact; otherwise a new site; a far suitable ruin is the fallback when no
 * new site exists. Claimed ruins, ruins inside another claim, and ruins no flag fits
 * beside are skipped, as is any ruin another agent already reserved a site beside.
 */
export function chooseClaim(world: World, self: Entity, agent: Agent, home?: { x: number; y: number }): ClaimChoice | undefined {
  if (isHiredBot(world, self)) return undefined;
  if (hasPlannerHome(world, self, agent)) return undefined;
  const existing = adoptExisting(world, self);
  if (existing) return existing;
  if (!needsMet(world, self)) return undefined;
  const t = world.get(self, Transform); if (!t) return undefined;
  // Coordinator fix (ADR-321 regression): claim land near HOME, not under the bot's feet. The planner
  // anchors every site pick on view.home; a bot far from home (returning from a trip, fleeing) must
  // not claim where it happens to stand — that adopted a base beside it and made return_home walk
  // to the base's porch instead of riding home. Callers without a view pass nothing and the bot's
  // own position is the anchor, as before.
  const anchor = home ?? { x: t.x, y: t.y };
  const defs = defsOf(world); if (!defs) return undefined;
  const flagR = plannerIndex(defs).piece.get("claim_totem")?.privilegeRadius ?? 0;
  const ruins = scanClaimRuins(world, anchor.x, anchor.y).filter((r) =>
    r.claimed === 0 && r.intact >= CLAIM_DATA.minIntact && r.damagedFrac <= CLAIM_DATA.maxDamagedFrac
    && siteClaimOk(world, self, r.originX, r.originY, flagR) && flagSlot(world, self, { x: r.originX, y: r.originY }) !== undefined);
  ruins.sort((a, b) => a.dist - b.dist || b.intact - a.intact || a.originX - b.originX || a.originY - b.originY);
  const best = ruins[0];
  if (best && best.dist <= CLAIM_DATA.ruinPreferDist) return { kind: "ruin", marker: best.marker, x: best.originX, y: best.originY };
  const site = pickBaseSite(world, self, anchor, (botPlayerId(world, self) * 0.6180339887) % 1);
  if (site) return { kind: "new", x: site.x, y: site.y, variant: variantFor(world, self).key };
  if (best) return { kind: "ruin", marker: best.marker, x: best.originX, y: best.originY };
  return undefined;
}

// ---------------- the plans ----------------
function flagPlan(world: World, self: Entity, goal: string, target: ClaimTarget, anchor: { x: number; y: number }, fails: Record<string, number>): ClaimPlan {
  const defs = defsOf(world)!; const ix = plannerIndex(defs);
  const flag = ix.piece.get("claim_totem");
  if (!flag) return planOut(goal, target, { blocked: ["no-flag-def"] });
  let locked: string | undefined;
  for (let i = 0; i < STATION_SLOTS.claim_totem!.length; i++) {
    const s = STATION_SLOTS.claim_totem![i]!;
    if (!ghostOk(world, self, flag.id, anchor.x + s.x, anchor.y + s.y, 0, 0, 0)) continue;
    const slotId = flagSlotId(anchor.x + s.x, anchor.y + s.y);
    const nb = nextBuild(world, self, flag, anchor.x + s.x, anchor.y + s.y, 0, 0, 0, slotId, anchor, fails);
    if (nb.blocked === "slot-failed" || nb.blocked === "no-snap" || nb.blocked === "no-place") continue;
    if (nb.blocked) { locked ??= nb.blocked; continue; }
    if (nb.missing) {
      target.stage = "gather";
      return planOut(goal, target, { leaves: nb.missing.map((m) => m.item), keep: new Set(nb.missing.map((m) => m.item)), priority: nb.missing.map((m) => ({ key: m.key, count: m.count })) });
    }
    target.stage = "claim";
    return planOut(goal, target, { step: nb.step!, keep: new Set(pieceCost(defs, flag, 0).map((c) => c.item)) });
  }
  return planOut(goal, target, { blocked: [locked ?? "claim-blocked"] });
}

/** Claim a ruin: flag first, then reclaim, repair, rebuild. Never emits a build before the flag is down. */
export function planClaimRuin(world: World, self: Entity, marker: Entity, fails: Record<string, number> = {}): ClaimPlan {
  const defs = defsOf(world);
  const ox = world.getField(marker, AbandonedSite, "originX") ?? 0, oy = world.getField(marker, AbandonedSite, "originY") ?? 0;
  const w = world.getField(marker, AbandonedSite, "width") ?? 8, h = world.getField(marker, AbandonedSite, "height") ?? 8;
  const target: ClaimTarget = { kind: "ruin", stage: "claim", x: ox, y: oy, mx: ox + 0.5, my: oy + 0.5, marker };
  if (!defs) return planOut("claim_ruin", target, { blocked: ["no-defs"] });
  const pid = botPlayerId(world, self);
  const claimed = world.getField(marker, AbandonedSite, "claimed") ?? 0;
  const claimedBy = world.getField(marker, AbandonedSite, "claimedBy") ?? 0;
  if (claimed !== 0 && claimedBy !== pid) return planOut("claim_ruin", target, { blocked: ["claimed-by-other"] });
  const layout = ruinLayout(world, marker);
  if (!layout) return planOut("claim_ruin", target, { blocked: ["no-layout"] });
  target.intact = layout.intact; target.missing = layout.missing.length; target.damaged = layout.damaged.length;
  const doneSlots = [...layout.presentSlots];
  const centre = { x: ox + w / 2, y: oy + h / 2 };
  if (!hasOwnClaim(world, self, centre.x, centre.y)) {
    const fp = flagPlan(world, self, "claim_ruin", target, { x: ox, y: oy }, fails);
    fp.doneSlots = doneSlots; return fp;
  }
  // the flag is down: its slot is satisfied (find the flag piece for the exact slot id)
  const ix = plannerIndex(defs); const flag = ix.piece.get("claim_totem");
  if (flag) for (const e of world.query([BuildPiece, Transform])) {
    if (world.getField(e, BuildPiece, "type") !== flag.id) continue;
    const p = world.get(e, Transform)!;
    if (Math.abs(p.x - ox) < 6 && Math.abs(p.y - oy) < 6 && hasOwnClaim(world, self, p.x, p.y)) { doneSlots.push(flagSlotId(p.x, p.y)); break; }
  }
  if (siteUnclaimed(world, marker)) {
    target.stage = "reclaim";
    return planOut("claim_ruin", target, { step: { k: "reclaim", marker }, doneSlots });
  }
  // repair: nearest damaged piece the bot may fix (own claim + skill gate, the server's rule)
  const t = world.get(self, Transform);
  const damaged = layout.damaged.filter((e) => {
    const bp = world.get(e, BuildPiece); if (!bp) return false;
    const def = defs.pieces.get(bp.type); if (!def) return false;
    const p = world.get(e, Transform); if (!p) return false;
    return hasOwnClaim(world, self, p.x, p.y) && pieceUnlocked(world, self, def, bp.tier);
  });
  damaged.sort((a, b) => {
    const pa = world.get(a, Transform)!, pb = world.get(b, Transform)!;
    return (Math.hypot(pa.x - (t?.x ?? 0), pa.y - (t?.y ?? 0)) - Math.hypot(pb.x - (t?.x ?? 0), pb.y - (t?.y ?? 0))) || a - b;
  });
  if (damaged.length) {
    const piece = damaged[0]!; const bp = world.get(piece, BuildPiece)!; const def = defs.pieces.get(bp.type)!;
    const max = maxHpOf(world, piece); const hp = bp.hp ?? 0;
    const scale = (defs.tiers[bp.tier]?.repairMul ?? 0.3) * (1 - hp / Math.max(1, max));
    const missing = missingMaterials(world, self, def, bp.tier, scale);
    target.damaged = damaged.length;
    if (missing.length) {
      target.stage = "gather";
      return planOut("claim_ruin", target, { leaves: missing.map((m) => m.item), keep: new Set(missing.map((m) => m.item)), priority: missing.map((m) => ({ key: m.key, count: m.count })), doneSlots });
    }
    target.stage = "repair";
    return planOut("claim_ruin", target, { step: { k: "repair", piece }, keep: new Set(missingMaterials(world, self, def, bp.tier, scale).map((m) => m.item)), doneSlots });
  }
  // rebuild: first missing structural piece in phase order (deck -> wall -> opening -> stair -> fence -> roof)
  const missing = [...layout.missing].sort((a, b) => a.level - b.level || PHASE[a.role]! - PHASE[b.role]! || a.y - b.y || a.x - b.x);
  let locked: string | undefined;
  for (const p of missing) {
    const def = ix.piece.get(p.key); if (!def) continue;
    const nb = nextBuild(world, self, def, p.x, p.y, p.level, p.rot, p.tier, p.slotId, { x: ox, y: oy }, fails);
    if (nb.blocked === "slot-failed" || nb.blocked === "no-snap" || nb.blocked === "no-place") continue;
    if (nb.blocked) { locked ??= nb.blocked; continue; }
    if (nb.missing) {
      target.stage = "gather";
      return planOut("claim_ruin", target, { leaves: nb.missing.map((m) => m.item), keep: new Set(nb.missing.map((m) => m.item)), priority: nb.missing.map((m) => ({ key: m.key, count: m.count })), doneSlots });
    }
    target.stage = "rebuild";
    return planOut("claim_ruin", target, { step: nb.step!, doneSlots });
  }
  if (missing.length) return planOut("claim_ruin", target, { blocked: [locked ?? "rebuild-blocked"], doneSlots });
  target.stage = "done";
  return planOut("claim_ruin", target, { doneSlots });
}

/** Build new: flag first, then the variant extras (the planner's ladder builds the hut once mem.base is set — see fillClaimSensors). */
export function planOwnHome(world: World, self: Entity, site?: { x: number; y: number }, variantKey?: string, fails: Record<string, number> = {}): ClaimPlan {
  const defs = defsOf(world);
  const t = world.get(self, Transform);
  const target: ClaimTarget = { kind: "new", stage: "claim", x: site?.x ?? 0, y: site?.y ?? 0, mx: (site?.x ?? 0) + 1, my: (site?.y ?? 0) + 1, variant: variantKey ?? variantFor(world, self).key };
  if (!defs || !t) return planOut("claim_new", target, { blocked: ["no-defs"] });
  const anchor = site ?? pickBaseSite(world, self, { x: t.x, y: t.y }, (botPlayerId(world, self) * 0.6180339887) % 1);
  if (!anchor) return planOut("claim_new", target, { blocked: ["no-site"] });
  target.x = anchor.x; target.y = anchor.y; target.mx = anchor.x + 1; target.my = anchor.y + 1;
  const variant = variantByKey(target.variant) ?? variantFor(world, self);
  target.variant = variant.key;
  const doneSlots: string[] = [];
  if (!hasOwnClaim(world, self, anchor.x + 1, anchor.y + 1)) {
    const fp = flagPlan(world, self, "claim_new", target, anchor, fails);
    fp.doneSlots = doneSlots; return fp;
  }
  const ix = plannerIndex(defs);
  // ADR-337 coordinator fix: the variant extras are decoration, not shelter — they wait until the hut
  // (BASE_SLOTS) stands, so a bot never spends its homesteading ticks on fences / garden beds / a
  // flower bed (gathering clay for one) while its hut and bed are unbuilt. While waiting the plan
  // has no step and no leaves, so claim_build scores 0 and the planner's ladder runs undisturbed.
  const hut = scanBase(world, defs, anchor);
  if (!BASE_SLOTS.every((s) => hut.pieces.has(s.id))) { target.stage = "extras"; return planOut("claim_new", target, { doneSlots }); }
  let locked: string | undefined;
  for (let i = 0; i < variant.extras.length; i++) {
    const ex = variant.extras[i]!; const slotId = `extra:${variant.key}:${i}`;
    if ((fails[slotId] ?? 0) >= CLAIM_FAILS) continue;
    const def = ix.piece.get(ex.key); if (!def) continue;
    if (pieceAt(world, def.id, anchor.x + ex.x, anchor.y + ex.y, 0.6) !== undefined) { doneSlots.push(slotId); continue; }
    const nb = nextBuild(world, self, def, anchor.x + ex.x, anchor.y + ex.y, ex.level ?? 0, ex.rot ?? 0, 0, slotId, anchor, fails);
    if (nb.blocked === "slot-failed" || nb.blocked === "no-snap" || nb.blocked === "no-place") continue;
    if (nb.blocked) { locked ??= nb.blocked; continue; } // skill gate: holds the extra until skill_pick learns it
    if (nb.missing) {
      target.stage = "gather";
      return planOut("claim_new", target, { leaves: nb.missing.map((m) => m.item), keep: new Set(nb.missing.map((m) => m.item)), priority: nb.missing.map((m) => ({ key: m.key, count: m.count })), doneSlots });
    }
    target.stage = "extras";
    return planOut("claim_new", target, { step: nb.step!, doneSlots });
  }
  if (locked) { target.stage = "extras"; return planOut("claim_new", target, { blocked: [locked], doneSlots }); }
  target.stage = "done";
  return planOut("claim_new", target, { doneSlots });
}

// ---------------- sensors (unwired: the coordinator calls this from computeGoalSensors) ----------------
/**
 * Fill the claim sensors on the view. Returns the claim leaves (missing materials for
 * the next step) so the caller can merge them into the gather needs, like fillPlanSensors
 * returns the plan leaves. The same materials are also published as the `claimPriority`
 * blackboard entry (the sensor's record of what the claim needs; the planner does NOT
 * consume it as a goal override — coordinator fix: claim materials as makePlan priority
 * hijacked the plan goal to "dye"/"clay" and starved the homestead ladder).
 */
export function fillClaimSensors(world: World, self: Entity, view: AgentWorldView, agent: Agent): Set<number> | undefined {
  const v = view as AgentWorldView & ClaimView;
  const mem = aiMemoryOf(agent);
  const pid = botPlayerId(world, self);
  const clear = (): undefined => {
    delete v.claimTarget; delete v.claimPlan;
    agent.bb.set("claimTarget", undefined); agent.bb.set("claimPriority", undefined);
    claimBaseSite(world, self, undefined);
    return undefined;
  };
  if (isHiredBot(world, self)) return clear();
  const t = world.get(self, Transform); if (!t) return clear();
  let target = agent.bb.get<ClaimTargetState>("claimTarget");
  if (target) {
    let ok = Math.hypot(target.x - t.x, target.y - t.y) <= CLAIM_DATA.claimAbandonDist;
    if (ok && target.kind === "ruin" && target.marker === undefined) ok = false;
    const defs = defsOf(world); const flagR = defs ? plannerIndex(defs).piece.get("claim_totem")?.privilegeRadius ?? 0 : 0;
    if (ok && target.kind === "ruin" && target.marker !== undefined) {
      const alive = world.isAlive(target.marker);
      const claimed = alive ? world.getField(target.marker, AbandonedSite, "claimed") ?? 0 : 1;
      const by = alive ? world.getField(target.marker, AbandonedSite, "claimedBy") ?? 0 : -1;
      ok = alive && (claimed === 0 || by === pid);
      // not mine yet: the site must still be claimable (a foreign claim swallowing it drops the target)
      if (ok && !(claimed === 1 && by === pid)) ok = siteClaimOk(world, self, target.x, target.y, flagR);
    }
    if (ok && target.kind === "new") {
      if (mem.base && (mem.base.x !== target.x || mem.base.y !== target.y)) ok = false; // the planner owns a different home now
      else if (!hasOwnClaim(world, self, target.x + 1, target.y + 1)) ok = siteClaimOk(world, self, target.x, target.y, flagR);
    }
    if (!ok) { target = undefined; agent.bb.set("claimTarget", undefined); }
  }
  if (!target) {
    const choice = chooseClaim(world, self, agent, view.home); // ADR-337 coordinator fix: anchor on home, not the bot's feet
    if (!choice) return clear();
    target = { kind: choice.kind, x: choice.x, y: choice.y, ...(choice.marker !== undefined ? { marker: choice.marker } : {}), ...(choice.variant ? { variant: choice.variant } : {}) };
    agent.bb.set("claimTarget", target);
  }
  claimBaseSite(world, self, { x: target.x, y: target.y }); // reserve the site against other bots' picks
  const plan = target.kind === "ruin" && target.marker !== undefined
    ? planClaimRuin(world, self, target.marker, mem.fails)
    : planOwnHome(world, self, { x: target.x, y: target.y }, target.variant, mem.fails);
  for (const s of plan.doneSlots) delete mem.fails[s];
  // new-home handoff: the flag is down, so the planner owns the hut from here (its own
  // ladder builds BASE_SLOTS at mem.base, flag-first by its own rule).
  if (target.kind === "new" && !mem.base && hasOwnClaim(world, self, target.x + 1, target.y + 1)) {
    mem.base = { x: target.x, y: target.y }; markAiDirty(agent, world.tick);
  }
  if (plan.target.stage === "done" && target.kind === "new") {
    agent.bb.set("claimTarget", undefined); // mem.base is the home record now
    claimBaseSite(world, self, undefined);
  }
  v.claimTarget = plan.target;
  v.claimPlan = plan;
  agent.bb.set("claimPriority", plan.priority?.length ? plan.priority : undefined);
  return plan.leaves.length ? new Set(plan.leaves) : undefined;
}

// ---------------- behaviors (unwired: the coordinator adds these to the survivor registry) ----------------
const step01 = { type: "step" as const, at: 0.5 };
const cooled = (c: AgentContext<AgentWorldView>, k: string, n: number): boolean => c.self.tick - c.bb.num(k, -1e9) >= n;
const stop = (o: { moveX: number; moveY: number }): void => { o.moveX = 0; o.moveY = 0; };
const cv = (c: AgentContext<AgentWorldView>): ClaimView => c.world as unknown as ClaimView;
/** Drive the claim plan's step with the same action strings a human sends; gathering rides the planner's plan. */
export function claimBuildBehaviors(): GameBehavior[] {
  return [
    { name: "claim_build", scheduleBonus: 0.35, inertia: 0.35, traits: { industriousness: 0.6 }, considerations: [
        { name: "step", weight: 1.3, curve: step01, input: (c) => (cv(c).claimPlan?.step && cooled(c, "claimFail", 120) ? 1 : 0) },
        { name: "calm", curve: step01, input: (c) => (c.memory.nearest("zombie", c.self.x, c.self.y, 0.3) ? 0 : 1) }],
      run: (c, o) => {
        const plan = cv(c).claimPlan; const s = plan?.step; if (!s) return false;
        const w = agentWorld(c);
        const fail = (): false => { c.bb.set("claimFail", c.self.tick); return false; };
        if (s.k === "build") {
          const d = goTo(c, o, s.stand.x, s.stand.y, 0.8);
          if (d > 0.5 && !(d < 3 && stuckOn(c, s.stand.x, s.stand.y, 40))) { if (d >= 3 && stuckOn(c, s.stand.x, s.stand.y)) return fail(); return; }
          stop(o); o.aimX = s.x - c.self.x; o.aimY = s.y - c.self.y;
          if (!cooled(c, "claimBuildAt", 30)) return;
          o.actions.push(`build:${s.piece}:${s.x}:${s.y}:${s.level}:${s.rot ?? 0}:${s.tier ?? 0}`);
          c.bb.set("claimBuildAt", c.self.tick);
          const m = aiMemoryOf(c.agent); m.fails[s.slot] = (m.fails[s.slot] ?? 0) + 1; markAiDirty(c.agent, c.self.tick);
          return false;
        }
        if (s.k === "reclaim") {
          const tgt = cv(c).claimTarget; if (!tgt) return false;
          if (!w || !w.isAlive(s.marker)) return fail();
          if (goTo(c, o, tgt.mx, tgt.my, 0.8) > 2) { if (stuckOn(c, tgt.mx, tgt.my)) return fail(); return; }
          stop(o);
          if (!cooled(c, "claimAt", 30)) return;
          o.actions.push(`reclaim:${s.marker}`); c.bb.set("claimAt", c.self.tick); return false;
        }
        if (s.k === "repair") {
          if (!w || !w.isAlive(s.piece)) return fail();
          const p = w.get(s.piece, Transform); if (!p) return fail();
          if (goTo(c, o, p.x, p.y, 0.8) > 2) { if (stuckOn(c, p.x, p.y)) return fail(); return; }
          stop(o);
          if (!cooled(c, "claimAt", 30)) return;
          o.actions.push(`repair:${s.piece}`); c.bb.set("claimAt", c.self.tick);
          bumpStat(c.agent, "repairs", c.self.tick); return false;
        }
        return false; // other planner step kinds (withdraw / craft / ...) belong to base_work
      } },
  ];
}
