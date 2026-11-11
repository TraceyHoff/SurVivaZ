import { nextTerrainWork, type TerrainBasePlan } from "./terrain_base.js";
import { hasShovel } from "../terrain.js";
/**
 * ADR-252: goal-driven planner for AI humans. Each sense pass (autonomy.ts, every SENSE_EVERY ticks per bot) walks a fixed
 * goal ladder (tools -> campfire -> basic storage box (ADR-250) -> workbench -> 2x2 base -> hearth -> bed -> knife / weapon ->
 * clothes / armour -> furnace -> metal); pieces the bot has not learned (ADR-221 pieceUnlocked) hold the build order until
 * skill_pick learns them and backward-chains the first unmet goal through the same RecipeDef / ResourceDef / PieceDef data players read:
 * have it (bag or base storage -> withdraw), craft it (hand or at a base station), gather it (node with the right tool),
 * hunt it (animal loot) or build it (station / base piece at a fixed slot of the base layout). The result is one
 * concrete step + the leaf items to gather; behaviours (base_behaviors.ts) turn those into ordinary player commands.
 * Nothing here writes the world. Long-term memory (base anchor, stats) lives in AiMemory on the agent identity and is
 * persisted through game.agents like social memory (flushAiMemory).
 */
import { Transform, seasonAt, type Agent, type Entity, type World } from "@engine/core";
import { installSpatialIndex } from "@engine/world";
import { AttachKind, BuildPiece, Container, DoorState, Fuel, ResourceNode, Worker, Worn } from "../components.js";
import { planDefence, type DefenceMemory } from "./defence_plan.js"; // ADR-341: the defence goal reuses ADR-338's planDefence + surplus gating (leaf module: no input.ts cycle)
import { resolveAttachment } from "../building/links.js";
import { countItem, readSlots } from "../inventory.js";
import { maxHpOf } from "../building/integrity.js";
import { hasOwnClaim, pieceCost, pieceUnlocked, snapPlacement, tribeOf, validatePlacement, zoneOwnedBy, zonesAt } from "../building/place.js";
import { PrivilegeZone } from "../components.js";
import { isBaseStoragePiece, STARTER_STORAGE_PIECE } from "./storage_api.js";
import { bedSpots } from "../stance.js";
import { StationKind, ToolKind, type GameDefs, type ItemDef, type PieceDef, type RecipeDef, type ResourceDef } from "../defs.js";
import { bareHandsCan } from "../systems/gathering.js";
import { nearWater } from "../systems/vitals.js";
import { emitterSpecs, EmitterKind } from "../realism.js";
import { animalDefs } from "../population.js";
import ruinData from "../../data/ai_ruin.json";

/** ADR-340: tuning for ruin-home base behaviour (furnish / upgrade scan radii around the ruin centre). */
export interface RuinData { furnishRadius: number; upgradeRadius: number }
export const RUIN_DATA: RuinData = ruinData as unknown as RuinData;

/** Task 30: lit state + remaining burn (ticks) of a fired piece: the current burn plus every fuel item in its box. */
export function fireState(world: World, defs: GameDefs, e: Entity): { lit: boolean; fuelTicks: number } {
  const fa = resolveAttachment(world, e, AttachKind.Fire) ?? e;
  let fuelTicks = Math.max(0, (world.getField(fa, Fuel, "burnUntilTick") ?? 0) - world.tick);
  if (world.has(fa, Container)) {
    const sl = readSlots(world, fa);
    for (let i = 0; i < sl.items.length; i++) {
      if (!sl.items[i] || !sl.counts[i]) continue;
      const sec = defs.items.get(sl.items[i]!)?.fuelSeconds ?? 0;
      if (sec > 0) fuelTicks += sl.counts[i]! * sec * 20;
    }
  }
  return { lit: (world.getField(fa, Fuel, "lit") ?? 0) > 0, fuelTicks };
}

// ---------------- long-term memory ----------------
export interface AiStats { trips: number; tripMax: number; deposits: number; withdraws: number; repairs: number; refuels: number; crafts: number; stationCrafts: number; built: number; hunts: number; loots: number; wears: number; relocations: number; bestTier: number; snoozed: number }
export interface AiMemory { v: 1; base?: { x: number; y: number }; stats: AiStats; earth?: TerrainBasePlan; hireEarth?: TerrainBasePlan; fails: Record<string, number>; blocked: string[]; snooze?: Record<string, number>;
  /** ADR-343: the plan's unmet gather need (item ids + the tick it was last confirmed by a sensor pass) — the travel
   *  layer's fuel for a resource expedition, readable off-screen where there is no view / plan. Cleared when the plan
   *  no longer needs anything. */
  resourceNeed?: { items: number[]; at: number };
  /** ADR-343: resource-expedition destinations that failed (unreachable / timed out / gone on arrival) — prospecting
   *  skips nodes near these until they age past resourceNeedTtlTicks. */
  resourceBanned?: { x: number; y: number; at: number }[];
  /** ADR-343: a resource expedition arrived — the next travel goal is a return home (set on arrival, cleared when
   *  that return arrives). */
  resourceReturn?: boolean;
  /** ADR-344: a journey ended early (turned back for lack of provisions) — no new resource expedition
   *  launches until this ages past journeyRetryCooldownTicks, so the bot does not ping-pong out and
   *  back on an empty pantry. */
  journeyBlocked?: { at: number } }
const newStats = (): AiStats => ({ trips: 0, tripMax: 0, deposits: 0, withdraws: 0, repairs: 0, refuels: 0, crafts: 0, stationCrafts: 0, built: 0, hunts: 0, loots: 0, wears: 0, relocations: 0, bestTier: 0, snoozed: 0 });
const aiDirty = new WeakMap<Agent, number>();
/** The agent's AiMemory (identity.ai, validated / created on first use). */
export function aiMemoryOf(a: Agent): AiMemory {
  const id = a.identity as { ai?: Partial<AiMemory> }; const r = id.ai;
  if (r && r.v === 1 && r.stats) { if (!r.fails) r.fails = {}; if (!r.blocked) r.blocked = []; for (const [k, v] of Object.entries(newStats())) if (typeof (r.stats as unknown as Record<string, number>)[k] !== "number") (r.stats as unknown as Record<string, number>)[k] = v; return r as AiMemory; }
  const m: AiMemory = { v: 1, stats: newStats(), fails: {}, blocked: [] };
  if (r?.base && Number.isFinite(r.base.x) && Number.isFinite(r.base.y)) m.base = { x: r.base.x, y: r.base.y };
  id.ai = m; return m;
}
export function markAiDirty(a: Agent, tick: number): void { if (!aiDirty.has(a)) aiDirty.set(a, tick); }
export const AI_MEMORY_DEBOUNCE_TICKS = 200;
export type AiPut = (id: string, partial: { ai: AiMemory }) => unknown;
/** Debounced write-through of dirty AiMemory (base anchor + stats) via game.agents.put; force on shutdown / bot removal. */
export function flushAiMemory(agents: Iterable<Agent>, put: AiPut, tick: number, force = false): number {
  let n = 0;
  for (const a of agents) { const at = aiDirty.get(a); if (at === undefined || (!force && tick - at < AI_MEMORY_DEBOUNCE_TICKS)) continue; aiDirty.delete(a); put(a.identity.id, { ai: JSON.parse(JSON.stringify(aiMemoryOf(a))) as AiMemory }); n++; }
  return n;
}
export function bumpStat(a: Agent, k: keyof AiStats, tick: number, by = 1): void { aiMemoryOf(a).stats[k] += by; markAiDirty(a, tick); }

// ---------------- base layout (relative to the anchor = north-west corner of a 2x2 foundation) ----------------
export interface BaseSlot { id: string; key: string; x: number; y: number; level: number; rot?: number; /** material tier (0 twig); roofs are wood: a twig roof cantilevers only one tile off a wall (horizLoss 45) */ tier?: number; legacy?: readonly { key: string; x: number; y: number }[] }
/**
 * 2x2 hut, built with the same Place commands a player sends. ADR-211 corners: every perimeter edge of a 2x2 is an arm of an outer
 * corner, so three corners are L pieces (`wall_corner_outer`, rot = which tile the L wraps) and the south-west corner keeps a doorway
 * (south) + window frame (west), the two openings allowed in a corner slot. `legacy` = the pre-ADR-211 straight walls that still count.
 */
export const BASE_SLOTS: readonly BaseSlot[] = [
  ...[[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => ({ id: `f${x}${y}`, key: "foundation", x: x! + 0.5, y: y! + 0.5, level: 0 })),
  { id: "cnw", key: "wall_corner_outer", x: 0, y: 0, level: 0, rot: 0, legacy: [{ key: "wall", x: 0.5, y: 0 }, { key: "wall", x: 0, y: 0.5 }] },
  { id: "cne", key: "wall_corner_outer", x: 2, y: 0, level: 0, rot: 1, legacy: [{ key: "wall", x: 1.5, y: 0 }, { key: "wall", x: 2, y: 0.5 }] },
  { id: "cse", key: "wall_corner_outer", x: 2, y: 2, level: 0, rot: 2, legacy: [{ key: "wall", x: 2, y: 1.5 }, { key: "wall", x: 1.5, y: 2 }] },
  { id: "wwin", key: "wall_window", x: 0, y: 1.5, level: 0, legacy: [{ key: "wall", x: 0, y: 1.5 }] },
  { id: "wd", key: "wall_doorway", x: 0.5, y: 2, level: 0 }, { id: "door", key: "door_wood", x: 0.5, y: 2, level: 0 },
  ...[[0, 1], [0, 0], [1, 1], [1, 0]].map(([x, y]) => ({ id: `r${x}${y}`, key: "roof_flat", x: x! + 0.5, y: y! + 0.5, level: 1, tier: 1 })), // wall-backed tile first (L corners are vertex pieces: no roof support)
];
/** Station spots outside the walls (2 candidates each; a slot failing 4 times moves to the next). */
export const STATION_SLOTS: Readonly<Record<string, readonly { x: number; y: number }[]>> = {
  claim_totem: [{ x: -1.5, y: 0.5 }, { x: 2.5, y: 3.8 }, { x: 1, y: -1.7 }], // ADR-310: flag first, covering the hut (ADR-315: radius 32; the slot must also clear every other claim)
  campfire: [{ x: 2.6, y: 2.9 }, { x: 1.6, y: 3.4 }], workbench: [{ x: 3.5, y: 0.5 }, { x: 0.5, y: -1.5 }], storage_box: [{ x: 3.5, y: 1.6 }, { x: 1.5, y: -1.5 }], basic_storage_box: [{ x: 3.5, y: 1.6 }, { x: 1.5, y: -1.5 }], // ADR-250 starter box: same spots (one base box)
  furnace: [{ x: -1.5, y: 0.5 }, { x: 3.5, y: -1.2 }], anvil: [{ x: -1.5, y: 1.6 }, { x: -1.2, y: -1.2 }],
  // Task 28: furnishing — table inside the hut (SE tile), light by the door, shelf + trough + salt barrel in the yard
  table: [{ x: 1.5, y: 1.5 }], torch_stand: [{ x: 0.5, y: 2.9 }, { x: 2.6, y: 2.9 }],
  shelf_rustic: [{ x: 3.5, y: 0.5 }, { x: 0.5, y: -1.5 }], feeding_trough: [{ x: 3.5, y: 2.6 }, { x: -1.5, y: 2.6 }],
  salt_barrel: [{ x: 2.6, y: 3.4 }, { x: 4.5, y: 0.5 }],
};
/** Fallback station spots on a ring outside the walls (clear of the door path and BUILD_STAND). */
export const SPARE_SPOTS: readonly { x: number; y: number }[] = [{ x: 3.6, y: -0.7 }, { x: -1.6, y: -0.7 }, { x: 1, y: -1.7 }, { x: -1.6, y: 1 }, { x: 3.7, y: 2.7 }, { x: -1.6, y: 2.7 }, { x: 4.7, y: 0.5 }, { x: 4.7, y: 1.8 }, { x: -0.6, y: -1.8 }, { x: 2.6, y: -1.8 }];
const ghostOk = (world: World, self: Entity, piece: number, x: number, y: number): boolean => {
  const sn = snapPlacement(world, { piece, x, y, level: 0, rot: 0, tier: 0, variant: 0 }); return typeof sn !== "number" && validatePlacement(world, self, sn, { ignoreCost: true, ignoreRange: true }) === 0;
};
/** Where a builder stands for base pieces (outside the footprint, inside build reach of every slot). */
export const BUILD_STAND = { x: 1, y: 3.3 };
export const DOOR_OUT = { x: 0.5, y: 2.8 }, DOOR_IN = { x: 0.5, y: 1.25 };
/** ADR-252: indoor campfire (back corner, off the door path): the walls keep its heat in and the roof keeps rain off; sleep spot next to it. */
export const HEARTH: BaseSlot = { id: "hearth", key: "campfire", x: 1.5, y: 0.5, level: 0 }; export const HEARTH_SIT = { x: 0.9, y: 1.1 };
/** ADR-252: the bed (1x2, not solid) along the west wall, under the window, beside the hearth; the sleeper lies on it (ADR-244 Rest edge). */
export const BED_SLOT: BaseSlot = { id: "bed", key: "bed", x: 0.5, y: 1, level: 0 };
export const baseHome = (b: { x: number; y: number }): { x: number; y: number } => ({ x: b.x + 1, y: b.y + 1 });
export const insideBase = (b: { x: number; y: number }, x: number, y: number): boolean => x > b.x + 0.1 && x < b.x + 1.9 && y > b.y + 0.1 && y < b.y + 1.9;

// ---------------- static indexes ----------------
interface Ix {
  item: Map<string, ItemDef>; piece: Map<string, PieceDef>; recipes: Map<number, RecipeDef[]>; nodes: Map<number, ResourceDef[]>;
  animal: Map<number, number[]>; station: Map<StationKind, PieceDef>; reachable: Set<number>; tools: ItemDef[]; foods: number[]; useful: Set<number>;
}
const ixCache = new WeakMap<GameDefs, Ix>();
const STATION_KEYS: Record<string, StationKind> = { campfire: StationKind.Campfire, workbench: StationKind.Workbench, furnace: StationKind.Furnace, anvil: StationKind.Anvil };
export function plannerIndex(defs: GameDefs): Ix {
  let ix = ixCache.get(defs); if (ix) return ix;
  ix = { item: new Map(), piece: new Map(), recipes: new Map(), nodes: new Map(), animal: new Map(), station: new Map(), reachable: new Set(), tools: [], foods: [], useful: new Set() };
  for (const d of defs.items.values()) { ix.item.set(d.key, d); if (d.tool) ix.tools.push(d); if (d.food && d.food.hunger > 0 && d.food.health >= 0) ix.foods.push(d.id); }
  for (const p of defs.pieces.values()) { if (!ix.piece.has(p.key)) ix.piece.set(p.key, p); const k = STATION_KEYS[p.key]; if (k !== undefined) ix.station.set(k, p); }
  for (const r of defs.recipes.values()) { const l = ix.recipes.get(r.output.item) ?? []; l.push(r); ix.recipes.set(r.output.item, l); }
  for (const l of ix.recipes.values()) l.sort((a, b) => a.station - b.station || a.id - b.id);
  for (const n of defs.resources.values()) for (const y of n.yields) if (y.chance >= 0.15) { const l = ix.nodes.get(y.item) ?? []; l.push(n); ix.nodes.set(y.item, l); }
  for (const l of ix.nodes.values()) l.sort((a, b) => (b.yields[0]!.chance === 1 ? 1 : 0) - (a.yields[0]!.chance === 1 ? 1 : 0) || a.minTier - b.minTier);
  animalDefs().forEach((a, kind) => { if (a.attack || a.hp > 60) return; for (const l of a.loot) { if (l.chance < 0.3) continue; const id = defs.itemId(l.item); const k = ix!.animal.get(id) ?? []; k.push(kind); ix!.animal.set(id, k); } });
  ix.tools.sort((a, b) => a.tool!.tier - b.tool!.tier || a.id - b.id);
  // static reachability fixed point (what a fresh player can ever obtain from the world): detects cycles like hardwood -> t2 axe -> anvil -> hardwood
  const R = ix.reachable; const toolTier = (k: ToolKind): number => { let t = 0; for (const d of ix!.tools) if (d.tool!.kind === k && R.has(d.id)) t = Math.max(t, d.tool!.tier); return t; };
  for (let changed = true; changed;) {
    changed = false; const add = (id: number): void => { if (!R.has(id)) { R.add(id); changed = true; } };
    for (const n of defs.resources.values()) if (n.requiredTool === ToolKind.None || bareHandsCan(defs, n) || toolTier(n.requiredTool) >= n.minTier) for (const y of n.yields) if (y.chance >= 0.15) add(y.item);
    for (const id of ix.animal.keys()) add(id);
    for (const r of defs.recipes.values()) { if (R.has(r.output.item)) continue; const sp = r.station === StationKind.None ? undefined : ix.station.get(r.station);
      if (r.station !== StationKind.None && (!sp || !pieceCost(defs, sp, 0).every((c) => R.has(c.item)))) continue;
      if (r.ingredients.every((g) => R.has(g.item))) add(r.output.item); }
  }
  // useful: everything the ladder, the base pieces and food can consume (closure over recipes); the rest is clutter a full bag may drop
  const U = ix.useful; const addU = (id: number | undefined): void => { if (id !== undefined && R.has(id)) U.add(id); };
  for (const g of GOAL_LADDER) {
    if (g.k === "item") { addU(ix.item.get(g.key)?.id); if (g.alt) addU(ix.item.get(g.alt)?.id); }
    else if (g.k === "wear") addU(ix.item.get(g.key)?.id);
    else if (g.k === "tool") { for (const d of ix.tools) if (d.tool!.kind === g.kind && d.tool!.tier <= g.tier) addU(d.id); }
    else if (g.k === "piece" || g.k === "bed") { const p = ix.piece.get(g.k === "bed" ? BED_SLOT.key : g.key); if (p) for (const c of pieceCost(defs, p, 0)) addU(c.item); }
  }
  for (const sl of BASE_SLOTS) { const p = ix.piece.get(sl.key); if (p) for (const c of pieceCost(defs, p, 0)) addU(c.item); }
  for (const k of ["wood", "raw_meat", "cooked_meat", "water_flask", "leather"]) addU(ix.item.get(k)?.id);
  for (const id of ix.foods) U.add(id);
  for (let grew = true; grew;) { grew = false; for (const id of [...U]) for (const r of ix.recipes.get(id) ?? []) for (const g of r.ingredients) if (!U.has(g.item) && R.has(g.item)) { U.add(g.item); grew = true; } }
  ixCache.set(defs, ix); return ix;
}

// ---------------- base scan (pieces of one base, shared per anchor) ----------------
export interface BaseState {
  pieces: Map<string, Entity>; stations: Map<StationKind, { id: Entity; x: number; y: number; fired: boolean; lit: boolean; fuelTicks: number }>;
  storage?: { id: Entity; x: number; y: number; counts: Map<number, number>; free: number }; bed?: { id: Entity; x: number; y: number }; door?: { id: Entity; x: number; y: number; open: boolean }; repair?: Entity; complete: boolean; hearth?: Entity;
  /** Task 30: every fired piece with a heat emitter at the base (campfire, fireplace, stove, furnace, torch
   * stand) — the refuel behaviour tops up the lowest one. Lamps / candles are light-only and not fires. */
  fires?: { id: Entity; key: string; x: number; y: number; lit: boolean; fuelTicks: number }[];
}
const scans = new WeakMap<World, Map<string, { tick: number; s: BaseState }>>();
const BASE_SCAN_EVERY = 20;
export function scanBase(world: World, defs: GameDefs, b: { x: number; y: number }): BaseState {
  let m = scans.get(world); if (!m) scans.set(world, (m = new Map())); const key = `${b.x},${b.y}`; const c = m.get(key);
  if (c && world.tick - c.tick < BASE_SCAN_EVERY && world.tick >= c.tick) return c.s;
  const s: BaseState = { pieces: new Map(), stations: new Map(), complete: false };
  const legacy = new Map<string, Entity>(); const cx = b.x + 1, cy = b.y + 1;
  for (const e of installSpatialIndex(world).queryRadius(cx, cy, 6)) {
    if (!world.has(e, BuildPiece)) continue; const t = world.get(e, Transform); if (!t) continue;
    const def = defs.pieces.get(world.getField(e, BuildPiece, "type")!); if (!def) continue;
    const hp = world.getField(e, BuildPiece, "hp") ?? 0; if (def.hp && s.repair === undefined && hp < maxHpOf(world, e) * 0.6) s.repair = e;
    const hearth = def.key === HEARTH.key && Math.abs(t.x - (b.x + HEARTH.x)) < 0.4 && Math.abs(t.y - (b.y + HEARTH.y)) < 0.4; if (hearth) s.hearth = e;
    // Task 30: every heat fire at the base, for the refuel behaviour (stations and plain fired pieces alike).
    if (def.fired && emitterSpecs(def).some((s) => s.kind === EmitterKind.Heat)) { const fs = fireState(world, defs, e); (s.fires ??= []).push({ id: e, key: def.key, x: t.x, y: t.y, lit: fs.lit, fuelTicks: fs.fuelTicks }); }
    if (def.station !== StationKind.None) { if (!s.stations.has(def.station) || hearth) { // the hearth is THE campfire once built (warmth, cooking, refuel)
      const fs = fireState(world, defs, e); // Fuel / fuel slots live on the fire attachment
      s.stations.set(def.station, { id: e, x: t.x, y: t.y, fired: def.fired, lit: fs.lit, fuelTicks: fs.fuelTicks }); } continue; }
    if (!s.bed && bedSpots(def.key).length) { s.bed = { id: e, x: t.x, y: t.y }; continue; }
    const sa = isBaseStoragePiece(def) ? resolveAttachment(world, e, AttachKind.Storage) : undefined; // ADR-250: any base storage piece
    if (sa !== undefined && world.has(sa, Container) && (!s.storage || (s.storage.free === 0 && readSlots(world, sa).counts.some((n) => !n)))) { const sl = readSlots(world, sa); const counts = new Map<number, number>(); let free = 0;
      for (let i = 0; i < sl.items.length; i++) { const it = sl.items[i]!; if (!it || !sl.counts[i]) { free++; continue; } counts.set(it, (counts.get(it) ?? 0) + sl.counts[i]!); }
      s.storage = { id: e, x: t.x, y: t.y, counts, free }; continue; }
    if (def.key === "wall" && t.z < 1.5) legacy.set(`wall@${Math.round((t.x - b.x) * 2) / 2},${Math.round((t.y - b.y) * 2) / 2}`, e);
    for (const sl of BASE_SLOTS) if (sl.key === def.key && Math.abs(t.x - (b.x + sl.x)) < 0.3 && Math.abs(t.y - (b.y + sl.y)) < 0.3 && (sl.level === 0) === (t.z < 1.5)) { s.pieces.set(sl.id, e);
      if (def.door) s.door = { id: e, x: t.x, y: t.y, open: (world.getField(resolveAttachment(world, e, AttachKind.Door) ?? e, DoorState, "open") ?? 0) > 0 }; }
  }
  for (const sl of BASE_SLOTS) if (sl.legacy && !s.pieces.has(sl.id)) { const es = sl.legacy.map((q) => legacy.get(`${q.key}@${q.x},${q.y}`)); if (es.every((e) => e !== undefined)) s.pieces.set(sl.id, es[0]!); }
  s.complete = BASE_SLOTS.every((sl) => s.pieces.has(sl.id));
  if (m.size > 512) m.clear(); m.set(key, { tick: world.tick, s }); return s;
}

/** ADR-252: base sites claimed by living agents (per world). Two bots picking in the same window would otherwise both see an empty
 *  spot (no piece is down yet) and settle side by side, walling off each other's build stand. */
const siteClaims = new WeakMap<World, Map<Entity, { x: number; y: number }>>();
export const SITE_SPACING = 10;
export function claimBaseSite(world: World, self: Entity, b: { x: number; y: number } | undefined): void {
  let m = siteClaims.get(world); if (!m) siteClaims.set(world, (m = new Map()));
  if (b) m.set(self, { x: b.x, y: b.y }); else m.delete(self);
}
const claimedNear = (world: World, self: Entity, bx: number, by: number, spacing = SITE_SPACING): boolean => {
  const m = siteClaims.get(world); if (!m) return false;
  for (const [e, c] of m) {
    if (e === self) continue; if (!world.has(e, Transform)) { m.delete(e); continue; }
    const d = Math.hypot(c.x - bx, c.y - by); if (d < SITE_SPACING) return true;
    if (d < spacing) { const ta = tribeOf(world, self), tb = tribeOf(world, e); if (!(ta && ta === tb)) return true; } // ADR-315: a clanmate's site may sit closer
  }
  return false;
};
/** ADR-315: slack (tiles) between a site's centre and its flag slot (STATION_SLOTS.claim_totem sit within ~3 of the hut centre). */
export const SITE_FLAG_PAD = 4;
/** An own / clan claim covering the hut with room to spare: the base needs no new flag there. */
const OWN_CLAIM_MARGIN = 6;
/**
 * ADR-315 claim check for a base site (hut centre bx+1, by+1): either an own / clan claim already covers it, or a new
 * flag of `flagR` planted beside the hut overlaps no claim (any owner) and no other agent's planned site.
 */
export function siteClaimOk(world: World, self: Entity, bx: number, by: number, flagR: number): boolean {
  if (flagR <= 0) return !claimedNear(world, self, bx, by);
  const cx = bx + 1, cy = by + 1; let covered = false; let blocked = false;
  for (const z of zonesAt(world, cx, cy, flagR + SITE_FLAG_PAD)) {
    const t = world.get(z, Transform)!; const r = world.getField(z, PrivilegeZone, "radius") ?? 0; const d = Math.hypot(t.x - cx, t.y - cy);
    if (zoneOwnedBy(world, z, self)) { if (d <= r - OWN_CLAIM_MARGIN) covered = true; else blocked = true; }
    else if (d <= r + flagR + SITE_FLAG_PAD) blocked = true;
  }
  if (covered) return !claimedNear(world, self, bx, by);
  return !blocked && !claimedNear(world, self, bx, by, 2 * flagR + SITE_FLAG_PAD);
}
/** Pick a base anchor 5..9 tiles from `near`: all four foundations must preview as placeable (the green ghost a player sees), no water / nodes / pieces around, and no other agent's claimed site within SITE_SPACING.
 *  ADR-315: the site's Claim Flag must fit without overlapping any claim (siteClaimOk); when the ring around `near` is all
 *  claimed, candidates just outside the blocking claims' rims (tangent spots, nearest first) are tried next. */
export function pickBaseSite(world: World, self: Entity, near: { x: number; y: number }, salt: number): { x: number; y: number } | undefined {
  const defs = gameplayDefsOf(world); if (!defs) return undefined; const ix = plannerIndex(defs); const f = ix.piece.get("foundation"); if (!f) return undefined;
  const flagR = ix.piece.get("claim_totem")?.privilegeRadius ?? 0;
  const sp = installSpatialIndex(world);
  const ok = (bx: number, by: number): boolean => {
    if (!siteClaimOk(world, self, bx, by, flagR)) return false;
    for (let y = -1; y <= 4; y++) for (let x = -2; x <= 4; x++) if (nearWater(world, bx + x + 0.5, by + y + 0.5)) return false;
    for (const e of sp.queryRect(bx - 3, by - 2, bx + 5, by + 5)) if (world.has(e, ResourceNode) || world.has(e, BuildPiece)) return false;
    for (const e of sp.queryRadius(bx + 1, by + 1, 9)) if (world.has(e, BuildPiece)) return false;
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const sn = snapPlacement(world, { piece: f.id, x: bx + x! + 0.5, y: by + y! + 0.5, level: 0, rot: 0, tier: 0, variant: 0 });
      if (typeof sn === "number" || validatePlacement(world, self, sn, { ignoreCost: true, ignoreRange: true, ignoreClaim: true }) !== 0) return false; }
    return true;
  };
  for (let i = 0; i < 24; i++) {
    const a = ((salt * 0.6180339887 + i * 0.2618) % 1) * Math.PI * 2, r = 5 + (i % 3) * 2;
    const bx = Math.floor(near.x + Math.cos(a) * r), by = Math.floor(near.y + Math.sin(a) * r);
    if (ok(bx, by)) return { x: bx, y: by };
  }
  if (flagR <= 0) return undefined;
  // ADR-315: everything near is claimed — try the rims of the blocking claims / planned sites, nearest to `near` first
  const blockers: { x: number; y: number; r: number }[] = [];
  for (const z of zonesAt(world, near.x, near.y, flagR * 2)) { const t = world.get(z, Transform)!; blockers.push({ x: t.x, y: t.y, r: world.getField(z, PrivilegeZone, "radius") ?? 0 }); }
  for (const [e, c] of siteClaims.get(world) ?? []) if (e !== self && Math.hypot(c.x - near.x, c.y - near.y) < flagR * 3) blockers.push({ x: c.x + 1, y: c.y + 1, r: flagR });
  const cands: { x: number; y: number; d: number }[] = [];
  for (const b of blockers) for (let k = 0; k < 16; k++) {
    const a = (k / 16 + salt * 0.0625) * Math.PI * 2, rr = b.r + flagR + SITE_FLAG_PAD + 1;
    const bx = Math.floor(b.x + Math.cos(a) * rr) - 1, by = Math.floor(b.y + Math.sin(a) * rr) - 1;
    cands.push({ x: bx, y: by, d: Math.hypot(bx - near.x, by - near.y) });
  }
  cands.sort((p, q) => p.d - q.d || p.x - q.x || p.y - q.y);
  for (const c of cands.slice(0, 48)) if (ok(c.x, c.y)) return { x: c.x, y: c.y };
  return undefined;
}
import { GameplayConfig } from "../config.js";
const gameplayDefsOf = (world: World): GameDefs | undefined => world.getResource(GameplayConfig)?.defs;

// ---------------- the planner ----------------
export type Step =
  | { k: "terrain"; x: number; y: number; dir: number; stand: { x: number; y: number } }
  | { k: "light"; piece: Entity }
  | { k: "withdraw"; item: number; count: number }
  | { k: "craft"; recipe: number; count: number; station: StationKind; ticks: number }
  | { k: "build"; piece: number; x: number; y: number; level: number; rot?: number; tier?: number; slot: string; stand: { x: number; y: number } }
  | { k: "wear"; invSlot: number }
  /** Task 28: upgrade an existing tiered piece to `tier` (Upgrade intent, full tier cost — the game's rule). */
  | { k: "upgrade"; piece: number; tier: number };
export interface Plan { goal: string; step?: Step; leaves: number[]; hunt: number[]; keep: Set<number>; blocked: string[] }

type Goal = { k: "earthworks" } | { k: "tool"; kind: ToolKind; tier: number; name: string } | { k: "item"; key: string; count: number; alt?: string } | { k: "piece"; key: string } | { k: "base" } | { k: "wear"; key: string } | { k: "cook" } | { k: "hearth" } | { k: "bed" } | { k: "furnish"; key: string; slot?: BaseSlot } | { k: "upgrade" } | { k: "defence" };
export const GOAL_LADDER: readonly Goal[] = [
  { k: "tool", kind: ToolKind.Axe, tier: 1, name: "axe" }, { k: "tool", kind: ToolKind.Pickaxe, tier: 1, name: "pickaxe" },
  // ADR-252 / ADR-250: campfire -> starter storage box -> workbench (isBaseStoragePiece: any storage piece satisfies the box goal)
  { k: "piece", key: "campfire" }, { k: "piece", key: STARTER_STORAGE_PIECE }, { k: "item", key: "wood", count: 8 }, { k: "piece", key: "workbench" },
  { k: "wear", key: "torch" }, // ADR-252 / ADR-217: a held light in the off hand keeps zombies out of its 5.5-tile ring at dusk / night
  { k: "earthworks" }, // Yard stations stay outside the finite footprint/quarry.
  { k: "base" }, { k: "hearth" },
  { k: "bed" },
  // ADR-341: defence is a first-class plan goal once the bot has shelter (tools, fire, storage,
  // workbench, base, hearth, bed) — acute hunger / cold / fuel are pre-goals that jump the queue
  // anyway, so defence never starves a need; it competes with furnish / progression after that.
  { k: "defence" },
  // Task 28: furnish the home like a player would (table inside, light by the door, shelf + trough + salt barrel
  // in the yard), and stock animal feed so livestock can be tamed for food.
  { k: "furnish", key: "table", slot: { id: "table", key: "table", x: 1.5, y: 1.5, level: 0 } },
  { k: "furnish", key: "torch_stand" }, { k: "furnish", key: "shelf_rustic" }, { k: "furnish", key: "feeding_trough" },
  { k: "furnish", key: "salt_barrel" }, { k: "item", key: "animal_feed", count: 4 },
  { k: "tool", kind: ToolKind.Knife, tier: 1, name: "knife" }, { k: "item", key: "stone_spear", count: 1, alt: "wooden_club" },
  { k: "cook" }, { k: "wear", key: "straw_hat" }, { k: "wear", key: "reed_sandals" }, { k: "tool", kind: ToolKind.Shovel, tier: 1, name: "shovel" },
  { k: "item", key: "wood", count: 20 }, { k: "item", key: "cooked_meat", count: 2 }, { k: "wear", key: "leather_gloves" }, { k: "wear", key: "leather_boots" },
  { k: "wear", key: "leather_cap" }, { k: "item", key: "water_flask", count: 1 }, { k: "piece", key: "furnace" }, { k: "item", key: "charcoal", count: 4 },
  { k: "item", key: "bronze_ingot", count: 4 }, { k: "piece", key: "anvil" }, { k: "tool", kind: ToolKind.Axe, tier: 2, name: "axe2" },
  { k: "tool", kind: ToolKind.Pickaxe, tier: 2, name: "pickaxe2" }, { k: "item", key: "bronze_spear", count: 1 },
  // Task 28: last of all, upgrade the home to the max tier (reinforced) one piece at a time.
  { k: "upgrade" },
];
/** Fire wood a bot never spends on planks / sticks / pieces (a night's first fuel load). */
export const WOOD_RESERVE = 8;
/** Freezing with no fire and no wood: wood + stone for a campfire on the spot comes before anything else. */
const EMERGENCY: readonly Goal[] = [{ k: "item", key: "wood", count: 8 }, { k: "item", key: "stone", count: 4 }];
/** Late afternoon without a finished, heated base: stock a night of fuel first. */
export const NIGHT_WOOD = 130; // ADR-252: a campfire burns a wood per 20 s; ~16 cold hours (h16-h8) = ~120 wood
/** ADR-252 / ADR-239: winter days sit near -6 C (felt cold all day): keep ~2.5 game hours of fuel banked in the fire before other work. */
export const WINTER_WOOD = 20;
/** ADR-252: winter = the season blend is mostly winter (seasonAt weights[Winter] >= 0.5). */
export const isWinter = (world: World): boolean => seasonAt(world).weights[2] >= 0.5;
const EVENING = (have: number): Goal[] => [{ k: "item", key: "wood", count: Math.max(8, Math.min(150, NIGHT_WOOD - have)) }];
const spendsFuel = (g: Goal): boolean => (g.k === "item" && (g.key === "wood" || g.key === "stone")) || (g.k === "piece" && g.key === "campfire") || g.k === "hearth" || g.k === "cook";

export interface PlanInput {
  /** ADR-323: extra item goals planned right after the survival pre-goals (the AI's saddle chain); onlyPriority = plan just those. */
  priority?: readonly { key: string; count: number }[]; onlyPriority?: boolean;
  /** ADR-323: recursion cap of the backward chain (recipe depth); deeper = stuck. */
  maxDepth?: number;
  earth?: TerrainBasePlan; terrainOnly?: boolean; shelterOnly?: boolean; world: World; self: Entity; defs: GameDefs; base?: { x: number; y: number }; bs?: BaseState; fails: Record<string, number>; hungry?: boolean; snooze?: Record<string, number>; freezing?: boolean; evening?: boolean; /** ADR-252 / ADR-239: winter (cold all day): fire + a day's fuel come first */ winter?: boolean;
  /** ADR-340: adopted ruin home anchor (ruin centre minus 1, so anchor+1 is the centre — the hut
   *  anchor convention). Behaviour goals (piece / furnish / hearth / bed / upgrade / cook / storage)
   *  run against it via `bs` (scanned at the anchor); the `base` goal (BASE_SLOTS build) NEVER runs
   *  for a ruin home. Set by fillPlanSensors from ruinHomeAnchor, never from mem.base. */
  ruinBase?: { x: number; y: number };
  /** ADR-341: threat level (assessThreat over identity.defence events) + defence memory, for the
   *  defence goal. Set by fillPlanSensors; the goal is skipped when either is absent. */
  threat?: number; defenceMem?: DefenceMemory }
class Resolver {
  avail = new Map<number, number>(); inv = new Map<number, number>(); visiting = new Set<number>();
  step?: Step; leaves = new Set<number>(); hunt = new Set<number>(); keep = new Set<number>(); stuck = false; /** ADR-221: a piece / station not learned yet */ locked?: string;
  constructor(readonly p: PlanInput, readonly ix: Ix, inv: Map<number, number>, readonly tool: Map<ToolKind, number>) {
    this.inv = inv; for (const [k, v] of inv) this.avail.set(k, v); for (const [k, v] of p.bs?.storage?.counts ?? []) this.avail.set(k, (this.avail.get(k) ?? 0) + v);
  }
  private take(item: number, n: number): number { const h = this.avail.get(item) ?? 0; const t = Math.min(h, n); this.avail.set(item, h - t); return t; }
  /** true = n of item are in hand (bag) now; otherwise records the first actionable step / leaves. */
  obtain(item: number, n: number, inBag = true): boolean {
    this.keep.add(item); const had = this.avail.get(item) ?? 0; const got = this.take(item, n);
    if (got >= n) { const bag = this.inv.get(item) ?? 0; if (inBag && bag < n && !this.step) this.step = { k: "withdraw", item, count: Math.min(had, n) - bag + 0 }; return !inBag || bag >= n; }
    const missing = n - got;
    if (this.visiting.has(item) || !this.ix.reachable.has(item) || (this.p.maxDepth !== undefined && this.visiting.size >= this.p.maxDepth)) { this.stuck = true; return false; }
    this.visiting.add(item);
    try {
      const rs = this.ix.recipes.get(item) ?? []; const nodes = this.ix.nodes.get(item) ?? [];
      const r = rs.find((x) => x.ingredients.every((g) => this.ix.reachable.has(g.item)) && (x.station === StationKind.None || this.ix.reachable.has(-1) || this.stationReachable(x.station)));
      if (nodes.length && (!r || nodes.some((nd) => nd.requiredTool === ToolKind.None || (this.tool.get(nd.requiredTool) ?? 0) >= nd.minTier))) { this.gatherLeaf(item, nodes); return false; }
      if (r) {
        const crafts = Math.ceil(missing / r.output.count); let ok = true;
        for (const g of r.ingredients) ok = this.obtain(g.item, g.count * crafts) && ok;
        if (r.station !== StationKind.None) ok = this.ensureStation(r.station) && ok;
        if (ok && !this.step) this.step = { k: "craft", recipe: r.id, count: Math.min(crafts, 20), station: r.station, ticks: Math.ceil(r.seconds * 20 * Math.min(crafts, 20)) + 10 };
        return false;
      }
      if (nodes.length) { this.gatherLeaf(item, nodes); return false; }
      if (this.ix.animal.has(item)) { this.hunt.add(item); return false; }
      this.stuck = true; return false;
    } finally { this.visiting.delete(item); }
  }
  private stationReachable(k: StationKind): boolean { const sp = this.ix.station.get(k); return !!sp && pieceCost(this.p.defs, sp, 0).every((c) => this.ix.reachable.has(c.item)); }
  private gatherLeaf(item: number, nodes: ResourceDef[]): void {
    const usable = nodes.find((nd) => nd.requiredTool === ToolKind.None || (this.tool.get(nd.requiredTool) ?? 0) >= nd.minTier);
    if (usable) { this.leaves.add(item); return; }
    const nd = nodes[0]!; if (bareHandsCan(this.p.defs, nd)) this.leaves.add(item); // fists work (poorly) while the tool is made
    this.obtainTool(nd.requiredTool, nd.minTier);
  }
  obtainTool(kind: ToolKind, tier: number): boolean {
    for (const d of this.ix.tools) if (d.tool!.kind === kind && d.tool!.tier >= tier && (this.avail.get(d.id) ?? 0) > 0) return this.obtain(d.id, 1);
    const cand = this.ix.tools.find((d) => d.tool!.kind === kind && d.tool!.tier >= tier && this.ix.reachable.has(d.id));
    if (!cand) { this.stuck = true; return false; } return this.obtain(cand.id, 1);
  }
  ensureStation(k: StationKind): boolean { const sp = this.ix.station.get(k); // ADR-221: station recipes need the station's token too
    if (sp && !this.unlocked(sp, 0)) return false; if (this.p.bs?.stations.has(k)) return true; if (!sp) { this.stuck = true; return false; } this.obtainPiece(sp.key); return false; }
  /** ADR-221: the same gate the server's validatePlacement applies; a locked piece stops the chain (skill_pick learns it). */
  unlocked(def: PieceDef, tier: number): boolean { if (pieceUnlocked(this.p.world, this.p.self, def, def.tiered ? tier : def.fixedTier)) return true; this.locked ??= def.key; this.stuck = true; return false; }
  /** Task 28: upgrade an existing tiered piece straight to `tier` (the game's Upgrade charges the full tier
   * cost, not the delta). Materials are obtained first; the step is emitted only when all are in hand. */
  obtainUpgrade(piece: number, def: PieceDef, tier: number): boolean {
    if (!this.unlocked(def, tier)) return false;
    let ok = true; for (const c of pieceCost(this.p.defs, def, tier)) ok = this.obtain(c.item, c.count) && ok;
    if (!ok || this.step) return false;
    this.step = { k: "upgrade", piece, tier }; return false;
  }
  obtainPiece(key: string, slot?: BaseSlot): boolean {
    const def = this.ix.piece.get(key); const b = this.p.base ?? this.p.ruinBase; if (!def || !b) { this.stuck = true; return false; }
    if (key !== "claim_totem" && !hasOwnClaim(this.p.world, this.p.self, b.x + 1, b.y + 1)) return this.obtainPiece("claim_totem");
    if (!this.unlocked(def, slot?.tier ?? 0)) return false;
    let ok = true; for (const c of pieceCost(this.p.defs, def, slot?.tier ?? 0)) ok = this.obtain(c.item, c.count) && ok;
    if (def.station !== StationKind.None) for (const sk of [StationKind.None]) void sk;
    if (!ok || this.step) return false;
    let at = slot ? { x: slot.x, y: slot.y, level: slot.level, id: slot.id } : undefined;
    if (!at) { const c = [...(STATION_SLOTS[key] ?? []), ...SPARE_SPOTS]; // ghost-preview each spot (validatePlacement, cost/range ignored) like a player would
      const i = c.findIndex((q, j) => (this.p.fails[`${key}${j}`] ?? 0) < 4 && ghostOk(this.p.world, this.p.self, def.id, b.x + q.x, b.y + q.y)); if (i < 0) { this.stuck = true; return false; } at = { x: c[i]!.x, y: c[i]!.y, level: 0, id: `${key}${i}` }; }
    const x = b.x + at.x, y = b.y + at.y;
    const stand = slot === HEARTH || slot === BED_SLOT ? { x: b.x + DOOR_IN.x, y: b.y + DOOR_IN.y } : slot ? { x: b.x + BUILD_STAND.x, y: b.y + BUILD_STAND.y } : standNear(b, x, y);
    this.step = { k: "build", piece: def.id, x, y, level: at.level, ...(slot?.rot ? { rot: slot.rot } : {}), ...(slot?.tier ? { tier: slot.tier } : {}), slot: at.id, stand }; return false;
  }
}
const standNear = (b: { x: number; y: number }, x: number, y: number): { x: number; y: number } => {
  const tx = b.x + BUILD_STAND.x, ty = b.y + BUILD_STAND.y; const dx = tx - x, dy = ty - y, d = Math.hypot(dx, dy) || 1; return d < 1.6 ? { x: tx, y: ty } : { x: x + (dx / d) * 1.6, y: y + (dy / d) * 1.6 };
};

const goalName = (g: Goal): string => (g.k === "tool" ? g.name : g.k === "item" ? g.key : g.k === "piece" ? g.key : g.k === "wear" ? `wear:${g.key}` : g.k === "furnish" ? `furnish:${g.key}` : g.k);
const buildsPiece = (g: Goal): boolean => g.k === "piece" || g.k === "base" || g.k === "hearth" || g.k === "bed" || g.k === "furnish" || g.k === "upgrade" || g.k === "defence";
/** One planner pass: first unmet, reachable goal of the ladder -> step + leaves. */
export function makePlan(p: PlanInput): Plan {
  const ix = plannerIndex(p.defs); const { world, self, defs } = p; const sl = readSlots(world, self);
  /** ADR-340: the anchor every placement / scan in the ladder reads — the built base, else the adopted ruin home. */
  const home = p.base ?? p.ruinBase;
  const inv = new Map<number, number>(); for (let i = 0; i < sl.items.length; i++) if (sl.items[i] && sl.counts[i]) inv.set(sl.items[i]!, (inv.get(sl.items[i]!) ?? 0) + sl.counts[i]!);
  const tool = new Map<ToolKind, number>(); const allCount = (id: number): number => (inv.get(id) ?? 0) + (p.bs?.storage?.counts.get(id) ?? 0);
  for (const d of ix.tools) if (allCount(d.id) > 0) tool.set(d.tool!.kind, Math.max(tool.get(d.tool!.kind) ?? 0, d.tool!.tier));
  const worn = new Set<number>(); const wi = world.getArray(self, Worn, "item"); if (wi) for (const x of wi) if (x) worn.add(x);
  const blocked: string[] = []; const keepAll = new Set<number>();
  if (p.earth && !p.earth.done) { const soil = ix.item.get("soil"); if (soil) keepAll.add(soil.id); }
  const pre: Goal[] = []; if (p.freezing) pre.push(...EMERGENCY); if (p.hungry) pre.push({ k: "cook" });
  if (p.winter && !p.evening) { const fire = p.bs?.stations.get(StationKind.Campfire); const inFire = fire ? Math.floor(fire.fuelTicks / 400) : 0; if (inFire < WINTER_WOOD) { if (!fire) pre.push(GOAL_LADDER[0]!, { k: "piece", key: "campfire" }); pre.push({ k: "item", key: "wood", count: Math.max(8, WINTER_WOOD - inFire) }); } }
  if (p.evening) { const fire = p.bs?.stations.get(StationKind.Campfire); const inFire = fire ? Math.floor(fire.fuelTicks / 400) : 0; if (inFire < NIGHT_WOOD) { if (!fire) pre.push(GOAL_LADDER[0]!, { k: "piece", key: "campfire" }); pre.push(...EVENING(inFire)); } } // ADR-252: a stone axe and the fire first (5 wood + 4 stone), then its night of fuel
  const prio: Goal[] = (p.priority ?? []).map((g) => ({ k: "item", key: g.key, count: g.count }));
  const ladder: readonly Goal[] = p.onlyPriority ? prio : prio.length && !p.terrainOnly && !p.shelterOnly ? [...pre, ...prio, ...GOAL_LADDER] : p.terrainOnly ? [{ k: "earthworks" }] : p.shelterOnly ? [{ k: "earthworks" }, { k: "base" }, { k: "hearth" }, { k: "bed" }] : pre.length ? [...pre, ...GOAL_LADDER] : GOAL_LADDER; const woodId = ix.item.get("wood")?.id;
  let held = false; // ADR-252: a locked build goal holds the later ones (campfire -> box -> workbench order); item / tool goals go on
  for (const g of ladder) {
    if (p.snooze && (p.snooze[goalName(g)] ?? 0) > world.tick) continue; // gave up on it for now (no source found in time)
    if (held && buildsPiece(g)) continue;
    const r = new Resolver(p, ix, inv, tool); let name = "";
    if (woodId !== undefined && !spendsFuel(g)) r.avail.set(woodId, Math.max(0, (r.avail.get(woodId) ?? 0) - WOOD_RESERVE)); // keep a fire's worth
    if (g.k === "tool") { name = g.name; if ((tool.get(g.kind) ?? 0) >= g.tier) { const d = ix.tools.find((t) => t.tool!.kind === g.kind && t.tool!.tier >= g.tier && allCount(t.id) > 0); if (d) { r.obtain(d.id, 1); if (r.step) return out(g, r); keepAll.add(d.id); } continue; }
      if (!ix.tools.some((d) => d.tool!.kind === g.kind && d.tool!.tier >= g.tier && ix.reachable.has(d.id))) { blocked.push(name); continue; } r.obtainTool(g.kind, g.tier); }
    else if (g.k === "item") { let d = ix.item.get(g.key); name = g.key; if (!d) continue; if (!ix.reachable.has(d.id)) { const a = g.alt ? ix.item.get(g.alt) : undefined; if (!a || !ix.reachable.has(a.id)) { blocked.push(name); continue; } d = a; }
      if (allCount(d.id) >= g.count) { if (d.weapon || d.tool) { r.obtain(d.id, 1); if (r.step) return out(g, r); } keepAll.add(d.id); continue; } r.obtain(d.id, g.count, false); }
    else if (g.k === "piece") { name = g.key; const def = ix.piece.get(g.key); if (!def || !home) continue; if (def.station !== StationKind.None ? p.bs?.stations.has(def.station) : isBaseStoragePiece(def) ? !!p.bs?.storage : false) continue;
      if (!pieceCost(defs, def, 0).every((c) => ix.reachable.has(c.item))) { blocked.push(name); continue; } r.obtainPiece(g.key); }
    else if (g.k === "earthworks") {
      name = "earthworks"; if (!p.earth || p.earth.done || p.earth.abandoned) continue;
      if (!hasShovel(world, self)) { r.obtainTool(ToolKind.Shovel, 1); }
      else {
        const work = nextTerrainWork(world, self, p.earth);
        if (work?.k === "terrain") r.step = work;
        else if (work?.k === "ladder" || work?.k === "light") {
          const key = work.k === "ladder" ? "ladder" : "campfire";
          // ADR-340: earth slots are relative to the earth anchor (= the planner base anchor); a ruin
          // anchor must not reinterpret them, so this path needs a real base — without one the goal
          // stalls exactly as before (the earthworks plan with no step, below).
          if (p.base) r.obtainPiece(key, { id: `earth:${key}`, key, x: work.x - p.earth.x, y: work.y - p.earth.y, level: 0 });
        } else if (work?.k === "fuel") {
          if (woodId !== undefined && (countItem(world, work.piece, woodId) > 0 || (world.getField(work.piece, Fuel, "burnUntilTick") ?? 0) > world.tick || r.obtain(woodId, 4))) r.step = { k: "light", piece: work.piece };
        }
      }
      if (r.step || r.leaves.size || r.hunt.size) return out(g, r);
      if (!p.earth.done && !p.earth.abandoned) return out(g, r); // don't lay foundations before the planned earthworks
      continue;
    }
    else if (g.k === "base") { name = "base"; if (!p.base) continue; // ADR-340: ruinBase never builds BASE_SLOTS — a ruin home skips this goal entirely
      const missing = BASE_SLOTS.filter((s) => !p.bs?.pieces.has(s.id) && (p.fails[s.id] ?? 0) < 6 && (s.key !== "door_wood" || p.bs?.pieces.has("wd")) && (s.level === 0 || BASE_SLOTS.filter((f) => f.key === "foundation").every((f) => p.bs?.pieces.has(f.id))));
      if (!missing.length) continue; const pd = (sl: BaseSlot): PieceDef | undefined => ix.piece.get(sl.key);
      const next = missing.find((sl) => { const d = pd(sl); return !!d && pieceUnlocked(world, self, d, d.tiered ? sl.tier ?? 0 : d.fixedTier); }) ?? missing[0]!; // ADR-221: walls go on while the roof tier is learned
      r.obtainPiece(next.key, next); }
    else if (g.k === "bed") { name = "bed"; if (!home || p.bs?.bed || (p.fails.bed ?? 0) >= 6) continue; const def = ix.piece.get(BED_SLOT.key); if (!def) continue;
      if (!pieceCost(defs, def, 0).every((c) => ix.reachable.has(c.item))) { blocked.push(name); continue; }
      // ADR-340: a ruin has no BASE_SLOTS hut, so no `complete` gate — but the bed still goes on
      // BED_SLOT (the ruin floor: validatePlacement needs a deck under a bed, and the spare spots
      // around a ruin are bare ground, so they all fail the ghost check).
      if (!p.ruinBase && (!p.base || !p.bs?.complete)) continue;
      r.obtainPiece(BED_SLOT.key, BED_SLOT); }
    else if (g.k === "defence") {
      name = "defence";
      // ADR-341: the planner owns the defence target now (ADR-338's sensor only records threat
      // events and translates this step back into view.defenceTarget for build_defence).
      // planDefence enforces the ADR-338 gating (threat >= buildThreatLevel, own claim, surplus
      // after the data reserve, ghost preview). Hired bots defend nobody's land, and without a
      // home anchor (built base or adopted ruin) there is no territory. The leaves passed here
      // are the current pass's gather leaves: any unmet earlier goal returns first, so they are
      // empty by construction — later comfort goals do not reserve materials against defence.
      if (p.threat === undefined || !p.defenceMem || !home) continue;
      if (world.isRegistered(Worker) && (world.getField(self, Worker, "owner") ?? 0) > 0) continue;
      const t = planDefence({ world, self, defs, base: home, ...(p.bs ? { bs: p.bs } : {}), threat: p.threat, leaves: new Set<number>(), mem: p.defenceMem });
      if (!t) continue;
      const def = ix.piece.get(t.key);
      if (!def) { blocked.push(name); continue; }
      // the build step's materials are never junk-dropped / stashed while the goal is live
      for (const c of pieceCost(defs, def, t.tier)) r.keep.add(c.item);
      r.step = { k: "build", piece: t.piece, x: t.x, y: t.y, level: t.level, rot: t.rot, tier: t.tier, slot: t.slot, stand: t.stand };
    }
    else if (g.k === "furnish") { name = `furnish:${g.key}`; const def = ix.piece.get(g.key); if (!def || !home) continue;
      // Task 28: unlike stations / storage, furniture has no scanBase slot — the goal is met when a piece of
      // this key already stands within the furnish radius of the anchor+1 (the hut centre, or the ruin centre).
      const fr = p.ruinBase ? RUIN_DATA.furnishRadius : 6;
      let have = false;
      for (const e of installSpatialIndex(world).queryRadius(home.x + 1, home.y + 1, fr)) {
        if (!world.has(e, BuildPiece)) continue; const t = world.getField(e, BuildPiece, "type");
        if (t !== undefined && defs.pieces.get(t)?.key === g.key) { have = true; break; }
      }
      if (have) continue;
      if (!pieceCost(defs, def, 0).every((c) => ix.reachable.has(c.item))) { blocked.push(name); continue; } r.obtainPiece(g.key, g.slot); }
    else if (g.k === "upgrade") { name = "upgrade"; if (!home || !p.bs) continue;
      // Task 28: the lowest-tier tiered hut piece, straight to the max tier (reinforced). One piece per pass;
      // the skill gate (tier token) holds the goal via Resolver.unlocked, like any locked build goal.
      const maxTier = defs.tiers.length - 1; let target: { e: Entity; def: PieceDef; tier: number } | undefined;
      const consider = (e: Entity): void => {
        const t = world.getField(e, BuildPiece, "type"); const df = t !== undefined ? defs.pieces.get(t) : undefined;
        const tier = world.getField(e, BuildPiece, "tier") ?? 0;
        if (!df?.tiered || tier >= maxTier) return;
        if (!target || tier < target.tier || (tier === target.tier && e < target.e)) target = { e, def: df, tier };
      };
      // ADR-340: ruins have no BASE_SLOTS pieces in the scan — the lowest-tier tiered piece standing
      // within upgradeRadius of the ruin centre upgrades instead.
      if (p.ruinBase) for (const e of installSpatialIndex(world).queryRadius(home.x + 1, home.y + 1, RUIN_DATA.upgradeRadius)) {
        if (!world.has(e, BuildPiece)) continue; consider(e);
      } else for (const e of [...p.bs.pieces.values()]) consider(e);
      if (!target) continue;
      if (!pieceCost(defs, target.def, maxTier).every((c) => ix.reachable.has(c.item))) { blocked.push(name); continue; }
      r.obtainUpgrade(target.e, target.def, maxTier); }
    else if (g.k === "hearth") { name = "hearth"; if (!home || (p.fails.hearth ?? 0) >= 6) continue;
      // ADR-340: a ruin's hearth is any campfire station in the ruin scan — the ladder's campfire piece
      // goal (earlier) builds one, so a ruin with a fire never reaches this goal; without one the HEARTH
      // slot is the second chance after the campfire station spots.
      if (p.ruinBase) { if (p.bs?.stations.has(StationKind.Campfire)) continue; }
      else if (!p.base || !p.bs?.complete || p.bs.hearth !== undefined) continue;
      r.obtainPiece(HEARTH.key, HEARTH); }
    else if (g.k === "cook") { name = "cook"; const raw = ix.item.get("raw_meat"); const cooked = ix.item.get("cooked_meat"); if (!raw || !cooked || !p.bs?.stations.has(StationKind.Campfire) || allCount(raw.id) === 0) continue; r.obtain(cooked.id, allCount(cooked.id) + Math.min(5, allCount(raw.id)), false); }
    else if (g.k === "wear") { name = `wear:${g.key}`; const d = ix.item.get(g.key); if (!d?.wear) continue; if (worn.has(d.id)) { keepAll.add(d.id); continue; }
      if (!ix.reachable.has(d.id)) { blocked.push(name); continue; }
      if ((inv.get(d.id) ?? 0) > 0) { for (let i = 0; i < sl.items.length; i++) if (sl.items[i] === d.id && sl.counts[i]) { r.step = { k: "wear", invSlot: i }; break; } return out(g, r); }
      r.obtain(d.id, 1); }
    if (r.step || r.leaves.size || r.hunt.size) { const o = out(g, r); o.blocked = blocked; return o; }
    if (r.locked) { blocked.push(`locked:${r.locked}`); if (buildsPiece(g)) held = true; continue; }
    if (r.stuck) blocked.push(name);
  }
  return { goal: "idle", leaves: [], hunt: [], keep: keepAll, blocked };
  function out(g: Goal, r: Resolver): Plan { for (const k of keepAll) r.keep.add(k); return { goal: goalName(g), ...(r.step ? { step: r.step } : {}), leaves: [...r.leaves], hunt: [...r.hunt], keep: r.keep, blocked: [] }; }
}
export const itemKey = (defs: GameDefs, key: string): number | undefined => plannerIndex(defs).item.get(key)?.id;
export { countItem };
