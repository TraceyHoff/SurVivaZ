/**
 * ADR-324: world-scale travel for AI humans. Replaces the hard range caps (home re-anchored after 48 tiles and the base
 * forgotten after 192, resource trips of 18-36 tiles for <= 3 min, creature_nav routes bounded to 24 tiles / 1200 nodes)
 * with long-range goals and hierarchical routes:
 *
 * - Goals (pickTravelGoal, on a cooldown): explore an unvisited region far away, visit a known point of interest
 *   (abandoned buildings) or a stall (trade / scavenge), relocate the homestead (every relocateEvery explorations of an
 *   unattached AI with a base), or return to the clan anchor.
 * - Attachment (travelMode): hired workers stay with the employer unless sent (orderTravel); clan members stay within
 *   clanStayRadius of the clan anchor when their roam preference (traits, roamWeights) is under roamTraitMin or a clan order
 *   (BuildBase / Defend) holds them, else roam and come back after roamReturnTicks; unattached AIs roam freely.
 * - Routes (requestRoute): A* over a coarse region grid (regionTiles; cost from sampled water tiles, cached) with a node
 *   budget, then ordinary local nav (goTo -> creature_nav) between region centres: no path length cap. Long legs ride the
 *   own mount (goTo records the goal, ADR-321 mountPolicy mounts for > longTripTiles). At most maxPlansPerTick routes are
 *   planned per world tick; the rest wait in a deterministic FIFO.
 * - Off-screen (offscreenStep): the host steps travelling bots that are far from every human coarsely along their route
 *   (no controller, no chunk streaming) and hands them back to full sim near a human or on arrival; the route and the leg
 *   index live in AiMemory (persisted), so position and progress survive a reload.
 *
 * ADR-345: water navigation. A leg's water is profiled by depth (regionSampleDepth: loaded terrain first, else the
 * seeded generator — the ADR-329 rule — so an unloaded lake is deep in the middle and shallow at its shore): shallow
 * water is a ford, deep water is a swim. At route assignment checkRouteWater re-plans around legs no crossing can
 * make (a deep run longer than swimMaxDeepTiles on foot / rideSwimMaxDeepTiles mounted; a mount that cannot swim
 * only forces a re-plan around lake-scale water — smaller water is left to the bank gate, where the local nav
 * decides whether it can be skirted). In full sim the bank gate in travelRun profiles the path the bot will
 * actually walk (the local-nav waypoint when the world has structures, else the straight segment) and holds a bot
 * in bad shape (cold, hurt, hungry / thirsty, or without the stamina the deep water costs) at the water's edge
 * instead of letting it in; a leg the local nav cannot skirt is re-planned around on the spot (its own regions
 * avoided), and swimming drains stamina; mid-crossing the bot presses on to the far shore. Off-screen, legs cross
 * water at the wade / swim speed multipliers with wetness and swim stamina costed in, and a leg no crossing can
 * make is re-planned around its own regions (off-screen nothing can recover, so "wait" counts as "around"). The
 * decisions live in the pure leaf ai/water_crossing.ts.
 *
 * Deterministic (FNV hashes of the agent id, no rng), server-authoritative (the host writes the authoritative world).
 */
import { Transform, type Agent, type AgentContext, type AgentOutput, type Entity, type Traits, type World } from "@engine/core";
import { CHUNK_SIZE, ProceduralGenerator, WaterDepth, waterDepthAt } from "@engine/world";
import raw from "../../data/travel.json";
import movementRaw from "../../data/movement.json";
import type { AgentWorldView, GameBehavior } from "../agents.js";
import { AbandonedSite, ClanStatus, Exposure, Health, ResourceNode, Riding, StallHeader, Survival, Wetness, Worker } from "../components.js";
import { GameplayConfig } from "../config.js";
import { inWater, waterDepth } from "../systems/movement.js";
import { walkerWaypoint } from "../systems/creature_nav.js";
import { editIndex } from "../terrain_depth.js";
import { WATER_WET_PER_SEC } from "../systems/environment.js";
import { spendStamina } from "../systems/vitals.js";
import { mountSpecies } from "../mount_defs.js";
import { TerrainRes } from "../world.js";
import { agentWorld, containerSeq, goTo } from "./base_behaviors.js";
import { COLD_BELOW } from "./autonomy.js";
import { aiMemoryOf, markAiDirty, plannerIndex } from "./planner.js";
import { mayTakeFromStorageAt, storageWithdrawActions } from "./storage_api.js";
import { WATER_DATA, decideCrossing, legUncrossableAtPlan, profileFromDepths, waterSeconds, type CrossingBot, type CrossingSpeeds, type WaterProfile } from "./water_crossing.js";
import { JOURNEY_DATA, bagCounts, bagPoints, canPrepareJourney, drainProvisions, estimateJourney, freeBagSlots, planJourneyPack, provisionsExhausted, requiredToolChain, routeTiles, shouldTurnBack, stepTargetsToolChain, willRide, type JourneyState, type PackItem } from "./journey.js";
import type { GameDefs } from "../defs.js";

export const TRAVEL: Readonly<typeof raw> = raw;
const T = raw;
export type TravelKind = "explore" | "poi" | "trade" | "relocate" | "return" | "sent" | "resource";
export interface TravelState { kind: TravelKind; x: number; y: number; since: number; route?: { x: number; y: number }[]; leg: number; origin: { x: number; y: number }; pending?: boolean; /** ADR-343: the wanted item ids a resource trip is for (the live need may change; fillTravelSensors ends the trip when none of these is still needed) */ items?: number[]; /** ADR-344: the resource-def id of the prospected destination node (gear is packed for this exact node) */ nodeKind?: number; /** ADR-344: provisions carried for a long trip (bag + packed at departure); unset = short trip, or preparation not yet resolved */ journey?: JourneyState; /** ADR-345: tick the bot started waiting at a bank for a dangerous crossing to become safe (cleared when it proceeds, re-plans, or the trip ends) */ waterWaitSince?: number }
export type TravelMode = "free" | "roam" | "stay" | "worker";
/** ADR-344: what a bot still has to pack before it leaves (recomputed every sensor pass from live bag + storage counts, so each landed withdraw shrinks it). */
export interface JourneyPrep { box: { id: Entity; x: number; y: number }; items: PackItem[]; estTicks: number; riding: boolean }
export interface TravelSensors { travel?: TravelState; travelMode?: TravelMode; journeyPrep?: JourneyPrep }
type Ctx = AgentContext<AgentWorldView>;
type Mem = ReturnType<typeof aiMemoryOf> & { travel?: TravelState; visited?: number[]; travelN?: number; roamSince?: number; travelAt?: number; sent?: { x: number; y: number }; spawnOff?: boolean };
const memOf = (a: Agent): Mem => aiMemoryOf(a) as Mem;
const fnv = (s: string): number => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const dist = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(bx - ax, by - ay);

// ---- attachment ------------------------------------------------------------------------------------------------
/** Roam preference 0..1 from the AI's traits (data roamWeights). */
export function roamPreference(t: Traits): number {
  const w = T.roamWeights; const v = w.bias + w.bravery * t.bravery + w.sociability * t.sociability + w.industriousness * t.industriousness + w.greed * t.greed;
  return Math.max(0, Math.min(1, v));
}
const STAY_ORDERS = new Set([1, 3]); // ClanGoal.BuildBase, ClanGoal.Defend: the clan wants everyone home
export function travelMode(world: World, self: Entity, a: Agent): TravelMode {
  if (world.isRegistered(Worker) && world.getField(self, Worker, "owner")) return "worker";
  const cs = world.isRegistered(ClanStatus) && world.has(self, ClanStatus) ? world.get(self, ClanStatus)! : undefined;
  if (!cs?.clan) return "free";
  return roamPreference(a.identity.traits) < T.roamTraitMin || STAY_ORDERS.has(cs.goal) ? "stay" : "roam";
}
/** Where a clan member stays / returns to: the clan order's point when one is set, else its home. */
export function clanAnchor(world: World, self: Entity, home: { x: number; y: number }): { x: number; y: number } {
  const cs = world.isRegistered(ClanStatus) && world.has(self, ClanStatus) ? world.get(self, ClanStatus)! : undefined;
  return cs && cs.goal && (cs.goalX || cs.goalY) ? { x: cs.goalX, y: cs.goalY } : home;
}
/** Employer order: send a hired worker (or any AI) to (x, y). */
export function orderTravel(a: Agent, x: number, y: number, tick: number): void { const m = memOf(a); m.sent = { x, y }; delete m.travel; markAiDirty(a, tick); }

// ---- region graph + budgeted planner ------------------------------------------------------------------------------
const R = (): number => T.regionTiles;
export const regionOf = (x: number, y: number): { rx: number; ry: number } => ({ rx: Math.floor(x / R()), ry: Math.floor(y / R()) });
const rkey = (rx: number, ry: number): number => ((rx + 32768) & 0xffff) * 65536 + ((ry + 32768) & 0xffff);
const centre = (rx: number, ry: number): { x: number; y: number } => ({ x: (rx + 0.5) * R(), y: (ry + 0.5) * R() });
const costCache = new WeakMap<World, Map<number, { c: number; at: number }>>();
/** Seeded generator for a world, cached per world: `new ProceduralGenerator({ seed })` with the default bands is the
 *  same generator the server builds its chunks from (apps/server/src/game.ts), so its tileAt is the generated tile
 *  at any (tx, ty) whether or not the chunk is loaded. Pure function of the world seed: no rng, same seed -> same tile. */
const seededGenCache = new WeakMap<World, ProceduralGenerator>();
const seededGenerator = (world: World): ProceduralGenerator => {
  let g = seededGenCache.get(world); if (!g) seededGenCache.set(world, (g = new ProceduralGenerator({ seed: world.seed })));
  return g;
};
/** Swim tiles when there is no GameplayConfig to read them from (bare worlds): data/movement.json swimTiles [1, 8]. */
const DEFAULT_SWIM_TILES: ReadonlySet<number> = new Set([1, 8]);
/** One region-cost sample: is (x, y) water? Loaded terrain wins (shovel edits and flowing water included: they only
 *  touch loaded ground, ADR-263); unloaded terrain is read from the seeded generator instead of assuming land, so an
 *  unloaded lake is wet and an unloaded shore is dry exactly as the chunk will generate. A TerrainRes without a
 *  loaded() hook (test stubs, replicas) is treated as loaded, as before. */
export function regionSampleWater(world: World, x: number, y: number): boolean {
  const tx = Math.floor(x), ty = Math.floor(y);
  const terrain = world.getResource(TerrainRes);
  if (terrain && (terrain.loaded?.(tx, ty) ?? true)) return inWater(world, x, y);
  const swim = world.getResource(GameplayConfig)?.defs.movement.swimTiles ?? DEFAULT_SWIM_TILES;
  return swim.has(seededGenerator(world).tileAt(tx, ty));
}
/** ADR-345: water depth at (x, y), by the ADR-329 rule — loaded terrain wins (shovel edits and flowing water
 *  included: they only touch loaded ground); unloaded terrain is read from the seeded generator, so an unloaded
 *  lake is deep in the middle and shallow at its shore exactly as the chunk will generate. A TerrainRes without
 *  a loaded() hook (test stubs, replicas) is treated as loaded, as before. */
export function regionSampleDepth(world: World, x: number, y: number): WaterDepth {
  const tx = Math.floor(x), ty = Math.floor(y);
  const terrain = world.getResource(TerrainRes);
  if (terrain && (terrain.loaded?.(tx, ty) ?? true)) return waterDepth(world, x, y);
  const gen = seededGenerator(world);
  const shallowR = world.getResource(GameplayConfig)?.defs.movement.shallowRadius ?? 2; // movement.json shallowRadius, like DEFAULT_SWIM_TILES above
  return waterDepthAt((ax, ay) => gen.tileAt(ax, ay), tx, ty, shallowR);
}
/** ADR-345: water profile of the straight segment (ax, ay) -> (bx, by): depths sampled every
 *  water.sampleStepTiles, so a ford (shallow only) reads differently from a swim (deep middle) and a long
 *  deep run reads differently from a short one. Works loaded and unloaded (regionSampleDepth). */
export function legWaterProfile(world: World, ax: number, ay: number, bx: number, by: number): WaterProfile {
  const d = Math.hypot(bx - ax, by - ay); const step = WATER_DATA.sampleStepTiles;
  const n = Math.max(1, Math.ceil(d / step)); const depths: WaterDepth[] = [];
  for (let i = 0; i <= n; i++) { const t = i / n; depths.push(regionSampleDepth(world, ax + (bx - ax) * t, ay + (by - ay) * t)); }
  return profileFromDepths(depths, d);
}
/** ADR-345: region keys the straight segment passes through (sampled every half region). */
export function regionsAlongLeg(ax: number, ay: number, bx: number, by: number): number[] {
  const d = Math.hypot(bx - ax, by - ay); const step = R() / 2; const n = Math.max(1, Math.ceil(d / step)); const out = new Set<number>();
  for (let i = 0; i <= n; i++) { const t = i / n; const { rx, ry } = regionOf(ax + (bx - ax) * t, ay + (by - ay) * t); out.add(rkey(rx, ry)); }
  return [...out];
}
/** ADR-345: the speeds a crossing is costed at — the off-screen speeds (the journey.ts convention) and the
 *  movement.json water multipliers (defs when present, data JSON otherwise). */
export function crossingSpeeds(world: World): CrossingSpeeds {
  const mv = world.getResource(GameplayConfig)?.defs.movement;
  return {
    foot: T.offscreen.speedTilesPerSec, ride: T.offscreen.mountSpeedTilesPerSec,
    wadeMul: mv?.wadeSpeedMul ?? (movementRaw as unknown as { wadeSpeedMul: number }).wadeSpeedMul,
    swimMul: mv?.swimSpeedMul ?? (movementRaw as unknown as { swimSpeedMul: number }).swimSpeedMul,
  };
}
/** ADR-345: the bot's live crossing state. `future` is the mount it will be riding for this trip (route
 *  assignment, before mountPolicy has mounted it); otherwise the Riding component decides. */
export function crossingBotOf(world: World, e: Entity, future?: { riding: boolean; species: number } | undefined): CrossingBot {
  const ridingNow = world.isRegistered(Riding) && world.has(e, Riding);
  const riding = ridingNow || future?.riding === true;
  const species = ridingNow ? world.getField(e, Riding, "species") ?? 0 : future?.species ?? 0;
  const sv = world.isRegistered(Survival) ? world.get(e, Survival) : undefined;
  const hp = world.get(e, Health);
  return {
    riding, mountSwims: riding ? (mountSpecies(species)?.swims ?? false) : false,
    hp: hp ? hp.hp / Math.max(1, hp.max) : 1,
    hunger: (sv?.hunger ?? 100) / 100, thirst: (sv?.thirst ?? 100) / 100,
    stamina: sv?.stamina ?? 100, staminaMax: sv?.maxStamina ?? 100,
    cold: (sv?.bodyTemp ?? 37) < COLD_BELOW,
  };
}
/** ADR-345: the mount the bot will be riding for this trip (own mount + skill + a long route — the ADR-321
 *  mountPolicy rule, via journey.ts willRide), for the structural check at route assignment. Undefined when
 *  the bot will walk the trip. */
function willRideHint(view: AgentWorldView | undefined, tr: TravelState): { riding: boolean; species: number } | undefined {
  if (!view?.mount || !tr.route) return undefined;
  const tiles = routeTiles(tr.route, tr.origin);
  return willRide(view.mount, view.mountSkill, tiles) ? { riding: true, species: view.mount.species ?? 0 } : undefined;
}
/** ADR-345: legs of this route no crossing can make at planning time (legUncrossableAtPlan — a deep run longer
 *  than the bot or its mount can swim, or lake-scale deep water under a mount that cannot swim; smaller water
 *  under a non-swimmer is left to the bank gate, where the local nav decides whether it can be skirted). */
function badWaterLegs(world: World, tr: TravelState, bot: CrossingBot): { from: { x: number; y: number }; to: { x: number; y: number } }[] {
  const out: { from: { x: number; y: number }; to: { x: number; y: number } }[] = [];
  let px = tr.origin.x, py = tr.origin.y;
  for (const wp of tr.route ?? []) {
    if (legUncrossableAtPlan(legWaterProfile(world, px, py, wp.x, wp.y), bot.riding, bot.mountSwims)) out.push({ from: { x: px, y: py }, to: { x: wp.x, y: wp.y } });
    px = wp.x; py = wp.y;
  }
  return out;
}
/** ADR-345: the current leg's endpoints — the previous waypoint (or the trip origin for leg 0) to the current
 *  waypoint. Callers have already resolved the current waypoint (currentWaypoint), so tr.leg is valid. */
function legEndpoints(tr: TravelState): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const to = tr.route![tr.leg]!;
  const from = tr.leg === 0 ? tr.origin : tr.route![tr.leg - 1]!;
  return { from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } };
}
/** ADR-345: re-plan around one leg's regions — the leg at hand (the bank gate's river, the off-screen
 *  leg-entry check's). Unlike checkRouteWater this does not re-check the whole route: the leg the bot is
 *  standing at is a real barrier (the local nav already failed, or there is no local nav off-screen), and
 *  later legs get their own gate when reached. Returns false when the trip was ended (no route around). A
 *  spent plan budget keeps the old route and returns true — the caller holds this step and retries next tick. */
function rerouteAroundLeg(world: World, e: Entity, a: Agent, tr: TravelState, from: { x: number; y: number }, to: { x: number; y: number }): boolean {
  const avoid = new Set(regionsAlongLeg(from.x, from.y, to.x, to.y));
  const cur = world.get(e, Transform); if (!cur) return true;
  const r = requestRoute(world, a.identity.id, cur.x, cur.y, tr.x, tr.y, avoid);
  if (r === undefined) return true; // budget spent: keep the old route
  if (r === null) { endTravel(a, world.tick, false); return false; }
  tr.route = r; tr.leg = 0; tr.origin = { x: cur.x, y: cur.y }; delete tr.waterWaitSince; markAiDirty(a, world.tick);
  return true;
}
/** ADR-345: structural water check of a route — every leg must be crossable on foot or by the bot's (eventual)
 *  mount. A leg that is not is re-planned around (its regions avoided); when no route around exists the trip
 *  ends like any unreachable goal. Returns false when the trip was ended. Two re-plans: a re-planned route may
 *  cross new bad water further along (a long route crosses many rivers), and ending the trip on the first bad
 *  re-plan stranded trips that could have detoured. The condition gate (cold / tired) is NOT checked here — a
 *  bot far from the water may recover before it arrives; the bank gate in travelRun and the leg-entry check in
 *  offscreenStep enforce it when the water is actually reached. */
export function checkRouteWater(world: World, e: Entity, a: Agent, tr: TravelState, view?: AgentWorldView): boolean {
  if (!tr.route) return true;
  for (let attempt = 0; attempt < 3; attempt++) {
    // the hint is recomputed per attempt: a re-planned route may be short enough to walk, and a bot on foot
    // swims a shorter deep run than a mounted one
    const bot = crossingBotOf(world, e, willRideHint(view, tr));
    const bad = badWaterLegs(world, tr, bot);
    if (!bad.length) return true;
    if (attempt === 2) break; // two re-plans only
    const avoid = new Set<number>();
    for (const l of bad) for (const k of regionsAlongLeg(l.from.x, l.from.y, l.to.x, l.to.y)) avoid.add(k);
    const cur = world.get(e, Transform); if (!cur) return true;
    const r = requestRoute(world, a.identity.id, cur.x, cur.y, tr.x, tr.y, avoid);
    if (r === undefined) return true; // budget spent: keep the old route; the bank / leg-entry gate is the backstop
    if (r === null) break;
    tr.route = r; tr.leg = 0; tr.origin = { x: cur.x, y: cur.y }; delete tr.waterWaitSince; markAiDirty(a, world.tick);
  }
  endTravel(a, world.tick, false); return false;
}
/** Region traversal cost: 1 + waterCostMul x the wet share of 5 samples; Infinity when every sample is water.
 *  Samples resolve through regionSampleWater, so unloaded regions are costed from the seeded terrain, never
 *  silently as cheap dry land. Cached with regionCostTtlTicks like before; a re-plan after the TTL picks up a
 *  chunk that has since loaded (and any edits in it). */
export function regionCost(world: World, rx: number, ry: number): number {
  let m = costCache.get(world); if (!m) costCache.set(world, (m = new Map())); const k = rkey(rx, ry); const c = m.get(k);
  if (c && world.tick - c.at < T.regionCostTtlTicks && world.tick >= c.at) return c.c;
  const s = R(); const x0 = rx * s, y0 = ry * s; let wet = 0;
  for (const [fx, fy] of [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]] as const) if (regionSampleWater(world, x0 + fx * s, y0 + fy * s)) wet++;
  const v = wet === 5 ? Infinity : 1 + T.waterCostMul * (wet / 5); if (m.size > 65536) m.clear(); m.set(k, { c: v, at: world.tick }); return v;
}
/** Seed a region's cost (scenario/test hook; it expires with regionCostTtlTicks like a sampled one). */
export function setRegionCost(world: World, rx: number, ry: number, c: number): void {
  let m = costCache.get(world); if (!m) costCache.set(world, (m = new Map())); m.set(rkey(rx, ry), { c, at: world.tick });
}
type HNode = { k: number; f: number; rx: number; ry: number };
const less = (a: HNode, b: HNode): boolean => a.f < b.f || (a.f === b.f && a.k < b.k); // total order: deterministic
function heapPush(h: HNode[], n: HNode): void { h.push(n); let i = h.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (!less(h[i]!, h[p]!)) break; [h[i], h[p]] = [h[p]!, h[i]!]; i = p; } }
function heapPop(h: HNode[]): HNode {
  const top = h[0]!, last = h.pop()!; if (h.length) { h[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < h.length && less(h[l]!, h[m]!)) m = l; if (r < h.length && less(h[r]!, h[m]!)) m = r; if (m === i) break; [h[i], h[m]] = [h[m]!, h[i]!]; i = m; } }
  return top;
}
/** A* over the region grid (8-neighbour), node budget maxRegionExpand. Waypoints = region centres + the exact goal.
 *  `avoid` (ADR-345) bans regions for this bot — a re-plan around water it cannot cross — except the goal region,
 *  which is always enterable (a goal inside an avoided region is still reachable). */
export function planRegionRoute(world: World, fx: number, fy: number, tx: number, ty: number, avoid?: ReadonlySet<number>): { x: number; y: number }[] | undefined {
  const a = regionOf(fx, fy), b = regionOf(tx, ty); if (a.rx === b.rx && a.ry === b.ry) return [{ x: tx, y: ty }];
  const h = (rx: number, ry: number): number => Math.hypot(rx - b.rx, ry - b.ry);
  const open: { k: number; rx: number; ry: number; f: number }[] = [{ k: rkey(a.rx, a.ry), rx: a.rx, ry: a.ry, f: h(a.rx, a.ry) }];
  const g = new Map<number, number>([[open[0]!.k, 0]]); const from = new Map<number, number>(); const pos = new Map<number, [number, number]>([[open[0]!.k, [a.rx, a.ry]]]);
  const closed = new Set<number>(); let n = 0; const goal = rkey(b.rx, b.ry);
  while (open.length && n++ < T.maxRegionExpand) {
    const cur = heapPop(open); if (closed.has(cur.k)) continue; closed.add(cur.k);
    if (cur.k === goal) {
      const path: { x: number; y: number }[] = []; let k: number | undefined = cur.k;
      while (k !== undefined && from.has(k)) { const [rx, ry] = pos.get(k)!; path.push(centre(rx, ry)); k = from.get(k); }
      path.reverse(); path[path.length - 1] = { x: tx, y: ty }; return path;
    }
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue; const rx = cur.rx + dx, ry = cur.ry + dy; const k = rkey(rx, ry); if (closed.has(k)) continue;
      const c = k === goal ? 1 : avoid?.has(k) ? Infinity : regionCost(world, rx, ry); if (!Number.isFinite(c)) continue;
      const ng = g.get(cur.k)! + c * (dx && dy ? Math.SQRT2 : 1); if (ng >= (g.get(k) ?? Infinity)) continue;
      g.set(k, ng); from.set(k, cur.k); pos.set(k, [rx, ry]); heapPush(open, { k, rx, ry, f: ng + h(rx, ry) });
    }
  }
  return undefined;
}
const budget = new WeakMap<World, { tick: number; used: number }>();
/** Budgeted route planning: at most maxPlansPerTick routes per world tick, served in request order (the controller's
 *  stable agent order, so deterministic); a caller over the budget gets undefined and asks again next tick. Returns the
 *  route, or `null` when unreachable within the node budget. `avoid` (ADR-345) bans regions for this bot only. */
export function requestRoute(world: World, _id: string, fx: number, fy: number, tx: number, ty: number, avoid?: ReadonlySet<number>): { x: number; y: number }[] | null | undefined {
  let b = budget.get(world); if (!b) budget.set(world, (b = { tick: world.tick, used: 0 }));
  if (b.tick !== world.tick) { b.tick = world.tick; b.used = 0; }
  if (b.used >= T.maxPlansPerTick) return undefined;
  b.used++; return planRegionRoute(world, fx, fy, tx, ty, avoid) ?? null;
}
/** Routes planned this tick (tests / debug). */
export const plansThisTick = (world: World): number => { const b = budget.get(world); return b && b.tick === world.tick ? b.used : 0; };

// ---- resource prospecting (ADR-343) --------------------------------------------------------------------------------
/** Resource kinds (resource-def ids) that yield any of `items` (plannerIndex's >= 0.15 chance rule, like the planner's own leaves). */
export function resourceKindsFor(defs: GameDefs, items: readonly number[]): Set<number> {
  const ix = plannerIndex(defs); const out = new Set<number>();
  for (const it of items) for (const nd of ix.nodes.get(it) ?? []) out.add(nd.id);
  return out;
}
const prospectCache = new WeakMap<World, Map<string, { at: number; hit: { x: number; y: number; kind: number } | undefined }>>();
const BAN_TILES = 8;
/** Nearest node of one of `kinds` to (x, y), or undefined. Placed nodes first (live: depletion is known — a placed node
 *  with amount 0 is skipped); otherwise the seeded generator, ring by ring out to prospectMaxTiles (nodesInChunk, so no
 *  chunk is ever built). The first ring with a hit wins: "nearest" within a chunk diagonal of the true nearest — exact
 *  nearest would need the whole radius scanned. Bounded by prospectMaxChunks chunk generations, so a kind the generator
 *  never places (copper / tin are not in its bands) costs a capped scan, not a world sweep; results are cached per
 *  (start chunk, kinds, excludes) for prospectCacheTtlTicks. Deterministic: fixed ring order, fixed in-chunk order, no rng. */
export function prospectResource(world: World, x: number, y: number, kinds: ReadonlySet<number>, exclude: readonly { x: number; y: number }[] = []): { x: number; y: number; kind: number } | undefined {
  const banned = (px: number, py: number): boolean => exclude.some((e) => (e.x - px) ** 2 + (e.y - py) ** 2 <= BAN_TILES * BAN_TILES);
  // live nodes in loaded chunks (a test world holds its placed nodes the same way)
  let placed: { x: number; y: number; kind: number } | undefined, pd = Infinity;
  for (const e of world.query([ResourceNode, Transform])) {
    if ((world.getField(e, ResourceNode, "amount") ?? 0) <= 0) continue;
    const kind = world.getField(e, ResourceNode, "kind")!; if (!kinds.has(kind)) continue;
    const p = world.get(e, Transform)!; const d = Math.hypot(p.x - x, p.y - y);
    if (d > T.prospectMaxTiles || d >= pd || banned(p.x, p.y)) continue; pd = d; placed = { x: p.x, y: p.y, kind };
  }
  if (placed) return placed;
  const ccx = Math.floor(x / CHUNK_SIZE), ccy = Math.floor(y / CHUNK_SIZE);
  const key = `${ccx},${ccy}:${[...kinds].sort((a, b) => a - b).join(",")}:${exclude.map((e) => `${Math.floor(e.x)},${Math.floor(e.y)}`).join(";")}`;
  let cache = prospectCache.get(world); if (!cache) prospectCache.set(world, (cache = new Map()));
  const hit0 = cache.get(key);
  if (hit0 && world.tick - hit0.at < T.prospectCacheTtlTicks && world.tick >= hit0.at) return hit0.hit;
  const gen = seededGenerator(world); const maxRing = Math.ceil(T.prospectMaxTiles / CHUNK_SIZE);
  let hit: { x: number; y: number; kind: number } | undefined; let used = 0;
  for (let r = 0; r <= maxRing && used < T.prospectMaxChunks && !hit; r++) {
    for (let cy = ccy - r; cy <= ccy + r && used < T.prospectMaxChunks && !hit; cy++) for (let cx = ccx - r; cx <= ccx + r && !hit; cx++) {
      if (Math.max(Math.abs(cx - ccx), Math.abs(cy - ccy)) !== r) continue;
      used++;
      for (const n of gen.nodesInChunk(cx, cy)) {
        if (!kinds.has(n.kind)) continue;
        const px = n.tx + 0.5, py = n.ty + 0.5;
        if (Math.hypot(px - x, py - y) > T.prospectMaxTiles || banned(px, py)) continue;
        hit = { x: px, y: py, kind: n.kind }; break;
      }
    }
  }
  if (cache.size > 256) cache.clear();
  cache.set(key, { at: world.tick, hit });
  return hit;
}

// ---- goals ---------------------------------------------------------------------------------------------------------
const visitedOf = (m: Mem): number[] => (m.visited ??= []);
export function noteVisited(a: Agent, x: number, y: number, tick: number): void {
  const m = memOf(a); const { rx, ry } = regionOf(x, y); const k = rkey(rx, ry); const v = visitedOf(m); if (v.includes(k)) return;
  v.push(k); if (v.length > T.visitedCap) v.splice(0, v.length - T.visitedCap); markAiDirty(a, tick);
}
/** Deterministic pick of the AI's next long-range goal, or undefined (stay put). */
export function pickTravelGoal(world: World, self: Entity, a: Agent, home: { x: number; y: number }, hasBase: boolean): TravelState | undefined {
  const t = world.get(self, Transform); if (!t) return undefined; const m = memOf(a); const tick = world.tick; const mode = travelMode(world, self, a);
  const mk = (kind: TravelKind, x: number, y: number): TravelState => ({ kind, x, y, since: tick, leg: 0, origin: { x: t.x, y: t.y } });
  if (m.sent) { const s = m.sent; delete m.sent; return mk("sent", s.x, s.y); }
  if (mode === "worker") return undefined;
  const anchor = mode === "free" ? home : clanAnchor(world, self, home);
  // ADR-343: a resource expedition that arrived comes home next (free bots too — the expedition is a round trip, not a relocation)
  if (m.resourceReturn) return mk("return", anchor.x, anchor.y);
  if (mode === "roam" && m.roamSince !== undefined && tick - m.roamSince > T.roamReturnTicks && dist(t.x, t.y, anchor.x, anchor.y) > T.clanStayRadius) return mk("return", anchor.x, anchor.y);
  const n = m.travelN ?? 0; const h = fnv(`${a.identity.id}:${n}`);
  if (mode === "stay") { // a short loop inside the clan's range
    const ang = (h / 4294967296) * Math.PI * 2, r = T.clanStayRadius * (0.4 + 0.5 * ((h >>> 8) % 1000) / 1000);
    return mk("explore", anchor.x + Math.cos(ang) * r, anchor.y + Math.sin(ang) * r);
  }
  // ADR-343: the plan needs something no known node near home yields (m.resourceNeed, recorded by noteTripWanted):
  // prospect the seeded world for the nearest node of that kind and travel to it, instead of wandering 18-36 tiles
  // on the local trip and snoozing the goal. Stay bots never get here (their short loop above); hired workers never
  // get here (worker return above). A node inside resourceMinTiles is the local trip / gather's job, not an
  // expedition's; no source at all (or no defs to map items to kinds) falls through to the old explore / POI goals.
  // ADR-344: no new expedition while a journey is cooling down (turned back for lack of provisions) —
  // the bot does not ping-pong out and back on an empty pantry.
  if (m.resourceNeed && tick - m.resourceNeed.at <= T.resourceNeedTtlTicks && !(m.journeyBlocked && tick - m.journeyBlocked.at <= JOURNEY_DATA.journeyRetryCooldownTicks)) {
    const defs = world.getResource(GameplayConfig)?.defs;
    if (defs) {
      const kinds = resourceKindsFor(defs, m.resourceNeed.items);
      if (kinds.size) {
        const banned = (m.resourceBanned ?? []).filter((b) => tick - b.at <= T.resourceNeedTtlTicks);
        const hit = prospectResource(world, t.x, t.y, kinds, banned);
        if (hit && dist(t.x, t.y, hit.x, hit.y) > T.resourceMinTiles) {
          const g = mk("resource", hit.x, hit.y); g.items = [...m.resourceNeed.items]; g.nodeKind = hit.kind; return g;
        }
      }
    }
  }
  // roamers + unattached: points of interest first (every 3rd goal), then unseen regions far away
  if (n % 3 === 1) {
    let best: { x: number; y: number; kind: TravelKind } | undefined, bd = T.poiSearchTiles;
    const v = new Set(visitedOf(m));
    const look = (q: Iterable<Entity>, kind: TravelKind): void => { for (const e of q) { const p = world.get(e, Transform); if (!p) continue; const d = dist(t.x, t.y, p.x, p.y); const { rx, ry } = regionOf(p.x, p.y); if (d > 2 * T.arriveTiles && d < bd && !v.has(rkey(rx, ry))) { bd = d; best = { x: p.x, y: p.y, kind }; } } };
    if (world.isRegistered(AbandonedSite)) look(world.query([AbandonedSite, Transform]), "poi");
    if (world.isRegistered(StallHeader)) look(world.query([StallHeader, Transform]), "trade");
    if (best) return mk(best.kind, best.x, best.y);
  }
  const v = new Set(visitedOf(m));
  for (let i = 0; i < 8; i++) {
    const hh = fnv(`${a.identity.id}:${n}:${i}`); const ang = (hh / 4294967296) * Math.PI * 2;
    const r = T.exploreMinTiles + ((hh >>> 7) % 1000) / 1000 * (T.exploreMaxTiles - T.exploreMinTiles);
    const x = t.x + Math.cos(ang) * r, y = t.y + Math.sin(ang) * r; const { rx, ry } = regionOf(x, y);
    if (v.has(rkey(rx, ry)) || !Number.isFinite(regionCost(world, rx, ry))) continue;
    const reloc = mode === "free" && hasBase && T.relocateEvery > 0 && n % T.relocateEvery === T.relocateEvery - 1;
    return mk(reloc ? "relocate" : "explore", x, y);
  }
  return undefined;
}

// ---- sensors + behaviour -------------------------------------------------------------------------------------------
/** Fill view.travel / travelMode (after the goal sensors: home and base are known). Goal picks are on a cooldown. */
export function fillTravelSensors(world: World, self: Entity, view: AgentWorldView, a: Agent): void {
  const t = world.get(self, Transform); if (!t) return; const m = memOf(a); const tick = world.tick;
  view.travelMode = travelMode(world, self, a);
  noteVisited(a, t.x, t.y, tick);
  if (m.travel && tick - m.travel.since > T.goalTimeoutTicks) endTravel(a, tick, false);
  // ADR-343: a resource trip whose items no longer intersect the live need is pointless — gathered en route, or the
  // plan moved on — so end it instead of walking to a node nobody needs. (A trip with no recorded items, e.g. an old
  // save, is never ended here.) The need is refreshed by noteTripWanted on every sensor pass while the plan still
  // lists the items, so this only fires when the need is genuinely gone — and never while a plan step is executing:
  // the planner reports the first unmet goal only, so leaves are transiently empty while a build / craft step runs
  // even though the next goal still needs the trip's items.
  if (m.travel?.kind === "resource" && m.travel.items !== undefined && !view.plan?.step) {
    const need = m.resourceNeed?.items;
    if (!need || !m.travel.items.some((it) => need.includes(it))) endTravel(a, tick, false);
  }
  if (m.travelAt === undefined) m.travelAt = tick; // first goal one cooldown after the bot appears (settle in first)
  if (!m.travel && (m.sent || tick - m.travelAt >= T.travelCooldownTicks)) {
    m.travelAt = tick; const g = pickTravelGoal(world, self, a, view.home, !!view.base);
    if (g) { m.travel = { ...g, pending: true }; if (view.travelMode === "roam" && m.roamSince === undefined && g.kind !== "return") m.roamSince = tick; markAiDirty(a, tick); }
  }
  const tr = m.travel; if (!tr) return;
  let justAssigned = false;
  if (tr.pending) { const r = requestRoute(world, a.identity.id, t.x, t.y, tr.x, tr.y); if (r === null) { endTravel(a, tick, false); return; } if (r) { tr.route = r; tr.leg = 0; delete tr.pending; justAssigned = true; if (!checkRouteWater(world, self, a, tr, view)) return; markAiDirty(a, tick); } }
  // ADR-344: a long trip prepares before it leaves (pack from the base storage, or depart bag-only);
  // a trip whose provisions ran out turns back instead of pressing on.
  if (tr.route && !tr.journey) prepareJourneySensors(world, self, a, view, tr, justAssigned);
  if (tr.route && tr.journey && turnBackNow(world, self, a, view.home)) return; // provisions gone: the return leg is set; this pass has no travel to show
  view.travel = tr;
}
/** ADR-344: abandon the current trip for a return leg home (no destination ban — the node is fine,
 *  the bot was just unprepared) and cool down re-launches so the bot does not ping-pong out and back
 *  on an empty pantry. The return leg carries no journey record: its provisions were sized into the
 *  round trip, and it never turns back again. */
export function turnBackToHome(a: Agent, at: { x: number; y: number }, home: { x: number; y: number }, tick: number): void {
  const m = memOf(a);
  m.travel = { kind: "return", x: home.x, y: home.y, since: tick, leg: 0, origin: { x: at.x, y: at.y }, pending: true };
  m.journeyBlocked = { at: tick };
  m.travelN = (m.travelN ?? 0) + 1;
  a.bb.set("journeyPacked", undefined);
  markAiDirty(a, tick);
}
/** ADR-344: full-sim turn-back check — the bag is empty of a kind and that need is low. Sets the
 *  return leg home; true when the trip was turned back. */
function turnBackNow(world: World, self: Entity, a: Agent, home: { x: number; y: number }): boolean {
  const m = memOf(a); const tr = m.travel; if (!tr?.journey) return false;
  const defs = world.getResource(GameplayConfig)?.defs; if (!defs) return false;
  const pts = bagPoints(world, self, defs);
  const sv = world.get(self, Survival);
  if (!shouldTurnBack(pts.foodUnits, pts.waterUnits, sv?.hunger ?? 100, sv?.thirst ?? 100)) return false;
  const t = world.get(self, Transform); if (!t) return false;
  turnBackToHome(a, { x: t.x, y: t.y }, home, world.tick);
  return true;
}
/** ADR-344: resolve a long trip's preparation on the sensor pass (the travel behaviour will not start
 *  a long trip until tr.journey is set — see journeyResolved). Runs every pass while the journey is
 *  unresolved: the pack list is recomputed from live bag + storage counts, so each landed withdraw
 *  shrinks it until it empties and the journey is recorded. */
function prepareJourneySensors(world: World, self: Entity, a: Agent, view: AgentWorldView, tr: TravelState, justAssigned: boolean): void {
  const tick = world.tick; const defs = world.getResource(GameplayConfig)?.defs;
  const tiles = routeTiles(tr.route!, tr.origin) * (tr.kind === "resource" ? 2 : 1);
  if (tiles < JOURNEY_DATA.minPrepTiles) return; // short trips need no preparation (and no turn-back rule)
  const est = estimateJourney(tiles, willRide(view.mount, view.mountSkill, tiles));
  const recordBagOnly = (prepared: boolean): void => {
    const pts = defs ? bagPoints(world, self, defs) : { hunger: 0, thirst: 0, foodUnits: 0, waterUnits: 0 };
    tr.journey = { food: pts.hunger, water: pts.thirst, estTicks: est.ticks, prepared };
    markAiDirty(a, tick);
  };
  if (justAssigned) a.bb.set("journeyPacked", undefined); // a new trip starts its packed tally fresh
  if (tick - tr.since > JOURNEY_DATA.prepDeadlineTicks) { recordBagOnly(false); return; } // waited long enough: leave with what the bag holds
  if (!defs) { recordBagOnly(false); return; }
  // ADR-344: never set out for a resource without the means to gather it. The planner backward-chains
  // through the tool chain first (ADR-343 note: iron needs a tier-2 pickaxe) — while the required tool
  // is not in the bag and the plan is still working that chain (a step targeting the tool, a part, or
  // its station, or a chain ingredient among the leaves), the trip waits here instead of departing.
  // The deadline above bounds the wait; the turn-back is the safety net if it departs short. A bot
  // with no tool and no chain work in its plan (stuck planner, stale trip) is not held: the trip is
  // the planner's to end, and the turn-back guards the walk.
  if (tr.kind === "resource" && tr.items?.length) {
    const chain = requiredToolChain(defs, tr.items, tr.nodeKind !== undefined ? [tr.nodeKind] : undefined);
    if (chain && (bagCounts(world, self).get(chain.tool) ?? 0) === 0) {
      if (stepTargetsToolChain(defs, view.plan?.step, chain) || (view.plan?.leaves ?? []).some((l) => chain.items.has(l))) return;
    }
  }
  const sb = view.bs?.storage;
  const t = world.get(self, Transform); if (!t) { recordBagOnly(false); return; }
  // the box is the bot's own base scan — for a hired worker fillHireSensors re-anchored it to the
  // employer's base — and mayTakeFromStorageAt enforces the ADR-323/327 rule (own / clan / employer
  // claim, else unclaimed near home): never another bot's or a stranger's storage.
  const boxOk = !!sb && Math.hypot(sb.x - t.x, sb.y - t.y) <= JOURNEY_DATA.packRadiusTiles && mayTakeFromStorageAt(world, self, { piece: sb.id, x: sb.x, y: sb.y }, view.home);
  if (!boxOk) { recordBagOnly(false); return; } // nowhere to pack from (far from home, or a stranger's box): leave with what the bag holds
  const sv = world.get(self, Survival);
  if (!canPrepareJourney(sv?.hunger ?? 100, sv?.thirst ?? 100, view.cold === true)) return; // hungry / thirsty / cold: eat, drink and warm up first — the trip waits (deadline bounds the wait)
  // storage counts minus what this trip already withdrew (the base scan caches 20 ticks, so a just-landed
  // withdraw would otherwise read as still on the shelf and be taken twice, eating the reserve)
  const packed = (a.bb.get("journeyPacked") ?? {}) as Record<number, number>;
  const storage = new Map<number, number>();
  for (const [k, v] of sb!.counts) storage.set(k, Math.max(0, v - (packed[k] ?? 0)));
  const pack = planJourneyPack(defs, est, bagCounts(world, self), storage, { targetItems: tr.items, nodeKinds: tr.nodeKind !== undefined ? [tr.nodeKind] : undefined, leaves: new Set(view.plan?.leaves ?? []), freeSlots: freeBagSlots(world, self) });
  const items = [...pack.gear, ...pack.water, ...pack.food];
  if (!items.length) { tr.journey = { food: pack.hunger, water: pack.thirst, estTicks: est.ticks, prepared: pack.prepared }; markAiDirty(a, tick); return; }
  view.journeyPrep = { box: { id: sb!.id, x: sb!.x, y: sb!.y }, items, estTicks: est.ticks, riding: est.riding };
}
/** Travel done (arrived = true) or dropped: relocations move the homestead, a clan roamer's return clears its roam clock. */
export function endTravel(a: Agent, tick: number, arrived: boolean): void {
  const m = memOf(a); const tr = m.travel; if (!tr) return;
  a.bb.set("journeyPacked", undefined); // ADR-344: a finished trip leaves no packed tally for the next one
  if (arrived && tr.kind === "relocate") { delete m.base; m.stats.relocations++; }
  if (tr.kind === "return" && arrived) { delete m.roamSince; delete m.resourceReturn; }
  // ADR-343: a resource expedition is a round trip — on arrival the next goal is the return home, and a far-spawned
  // bot must leave the coarse sim at the node (clear spawnOff) or it would re-depart without ever gathering. A failed
  // resource trip bans its destination so the next prospect goes to the next-nearest source instead of retrying the
  // same unreachable / depleted spot forever.
  if (arrived && tr.kind === "resource") { m.resourceReturn = true; markSpawnOffscreen(a, false); }
  if (!arrived && tr.kind === "resource") { const b = (m.resourceBanned ??= []); b.push({ x: tr.x, y: tr.y, at: tick }); if (b.length > 4) b.splice(0, b.length - 4); }
  m.travelN = (m.travelN ?? 0) + 1; delete m.travel; m.travelAt = tick; markAiDirty(a, tick);
}
const calmFor = (c: Ctx): boolean => c.self.hp >= T.minHp && c.self.hunger > T.minNeeds && c.self.thirst > T.minNeeds && !c.memory.nearest("zombie", c.self.x, c.self.y, 0.3);
/** Next waypoint of a route from the current leg (advances legs within waypointArriveTiles). */
export function currentWaypoint(tr: TravelState, x: number, y: number): { x: number; y: number } | undefined {
  const r = tr.route; if (!r) return undefined;
  while (tr.leg < r.length - 1 && dist(x, y, r[tr.leg]!.x, r[tr.leg]!.y) <= T.waypointArriveTiles) tr.leg++;
  return r[tr.leg];
}
/** ADR-344: a long trip does not start until its preparation resolved (journey recorded — packed, or
 *  explicitly bag-only): the bot eats and packs first instead of walking off hungry and unpacked.
 *  Short trips need no preparation. */
const journeyResolved = (c: Ctx): boolean => {
  const tr = c.world.travel; if (!tr?.route) return true;
  const tiles = routeTiles(tr.route, tr.origin) * (tr.kind === "resource" ? 2 : 1);
  return tiles < JOURNEY_DATA.minPrepTiles || tr.journey !== undefined;
};
export function travelBehaviors(): GameBehavior[] {
  return [{
    name: "travel", inertia: 0.5, traits: { bravery: 0.3 },
    considerations: [
      { name: "goal", weight: T.travelUtility, curve: { type: "step", at: 0.5 }, input: (c) => (c.world.travel?.route && calmFor(c) && journeyResolved(c) ? 1 : 0) },
    ],
    run: (c, o) => travelRun(c, o),
  }, {
    // ADR-344: pack for a long trip before leaving — walk to the base storage box and withdraw the
    // sensor's pack list, one container cycle per item (the ADR-250 sequences, like base_work's
    // withdraw). Outranks travel while a pack is pending; the travel behaviour is gated on the
    // journey record anyway, so the bot cannot walk off half-packed. A zombie nearby hands the
    // tick to flee instead (the calm consideration).
    name: "prepare_journey", inertia: 0.5, traits: { industriousness: 0.4 },
    considerations: [
      { name: "prep", weight: 1.0, curve: { type: "step", at: 0.5 }, input: (c) => (c.world.journeyPrep ? 1 : 0) },
      { name: "calm", curve: { type: "step", at: 0.5 }, input: (c) => (c.memory.nearest("zombie", c.self.x, c.self.y, 0.3) ? 0 : 1) },
    ],
    run: (c, o) => {
      const prep = c.world.journeyPrep; if (!prep) return false;
      const item = prep.items[0]; if (!item) return false;
      if (goTo(c, o as never, prep.box.x, prep.box.y, 0.85) > 2.2) return;
      o.moveX = 0; o.moveY = 0;
      if (containerSeq(c, o, prep.box.id, storageWithdrawActions(prep.box.id, item.item, item.count))) {
        const rec = { ...(c.bb.get<Record<number, number>>("journeyPacked") ?? {}) };
        rec[item.item] = (rec[item.item] ?? 0) + item.count;
        c.bb.set("journeyPacked", rec);
        return false;
      }
      return;
    },
  }];
}
/** ADR-345: the bank gate, run on every travel tick before goTo. True when the bot may walk this tick.
 *  The water profiled is the path the bot will actually walk: the local-nav waypoint (walkerWaypoint, the
 *  same call goTo makes) when the world has structures — a pond the local nav skirts is not a bank — else
 *  the straight segment to the route waypoint, which is the real path in a structure-less wilderness. When
 *  the local nav has no path (undefined) the straight waypoint is the fallback, and the profile crosses the
 *  water. (A failed local nav returns undefined only once the bot has walked the reachable path — until then
 *  it returns waypoints along it, so the bot walks to the bank before the gate fires.)
 *  - In deep water already: press on to the far shore — never wait in the water, never turn back mid-crossing.
 *  - No deep water on this leg (a ford, or dry land): go.
 *  - Water more than bankTiles ahead: go — the gate re-checks as the bot closes on it. The trigger reads the
 *    first WET sample (not the first deep one): a bot must decide before it wades in, because a mount that
 *    cannot swim beaches at the deep boundary — it can wade the shallows but cannot press on, so "press on"
 *    would strand it. firstWet is measured to a sample, which can sit up to one sample step past the first
 *    wet tile, so the trigger backs off by the step.
 *  - Water at hand and the crossing is structurally impossible (too long, or a non-swimming mount):
 *    re-plan around this leg now (rerouteAroundLeg — the leg's own regions avoided, not the whole route);
 *    the trip ends when no route around exists. The same applies when the bot is already wading in the
 *    shallows and the world has changed under it — the re-plan's new waypoint is on land, and the leg back
 *    out is shallow / dry, so the bot walks out.
 *  - Water at hand and the bot is in bad shape (cold, hurt, hungry / thirsty, low on stamina): hold at
 *    the bank — returning false hands the tick to the other behaviours (eat / drink / warm) — until the bot
 *    recovers or waterWaitTicks pass, when it re-plans around instead of waiting forever.
 *  A world the behaviour cannot reach (no agentWorld binding) fails open, as before. */
function waterGate(c: Ctx, tr: TravelState, wp: { x: number; y: number }): boolean {
  const w = agentWorld(c); if (!w) return true;
  const e = c.agent.bb.num("selfEntity") as Entity;
  const x = c.self.x, y = c.self.y;
  const clearWait = (): void => { if (tr.waterWaitSince !== undefined) { delete tr.waterWaitSince; markAiDirty(c.agent, c.self.tick); } };
  if (inWater(w, x, y) && waterDepth(w, x, y) === WaterDepth.Deep) { clearWait(); return true; } // mid-crossing: press on
  const navWp = editIndex(w).size ? walkerWaypoint(w, e, x, y, wp.x, wp.y) : undefined;
  const target = navWp ?? wp; // the path goTo will walk (the straight segment when there is no local nav)
  const prof = legWaterProfile(w, x, y, target.x, target.y);
  if (prof.deep <= 0) { clearWait(); return true; } // a ford, or dry land
  if (!inWater(w, x, y) && prof.firstWet - WATER_DATA.sampleStepTiles > WATER_DATA.bankTiles) { clearWait(); return true; } // water not at hand yet
  const bot = crossingBotOf(w, e, willRideHint(c.world, tr));
  const decision = decideCrossing(prof, bot, crossingSpeeds(w));
  if (decision === "swim" || decision === "ride") { clearWait(); return true; }
  // the water is here and the local nav cannot skirt it: re-plan around this leg only (its own regions
  // avoided) — the planning check already passed the later legs, and they get their own gate when reached.
  const rerouteLeg = (): void => { const { from, to } = legEndpoints(tr); rerouteAroundLeg(w, e, c.agent, tr, from, to); };
  if (decision === "around") { rerouteLeg(); return false; } // re-planned, or the trip ended: re-evaluate next tick
  if (tr.waterWaitSince === undefined) { tr.waterWaitSince = c.self.tick; markAiDirty(c.agent, c.self.tick); return false; }
  if (c.self.tick - tr.waterWaitSince <= WATER_DATA.waitTicks) return false; // still waiting for recovery
  rerouteLeg(); return false; // waited long enough: go around instead
}
export function travelRun(c: Ctx, o: AgentOutput): boolean | void {
  const tr = c.world.travel; if (!tr?.route) return false;
  if (dist(c.self.x, c.self.y, tr.x, tr.y) <= T.arriveTiles) { endTravel(c.agent, c.self.tick, true); o.moveX = 0; o.moveY = 0; return false; }
  const wp = currentWaypoint(tr, c.self.x, c.self.y); if (!wp) return false;
  if (!waterGate(c, tr, wp)) return false; // ADR-345: hold at the bank (or the trip was re-planned / ended)
  goTo(c, o as never, wp.x, wp.y, 0.9); // local nav per leg; the ADR-321 mount policy rides long legs
  // ADR-345: swimming costs stamina (deep water only — wading is walking). The pre-crossing stamina
  // estimate is the guarantee; this drain is the cost, so a bot at ~0 stamina keeps what little it has.
  const w = agentWorld(c);
  if (w && inWater(w, c.self.x, c.self.y) && waterDepth(w, c.self.x, c.self.y) === WaterDepth.Deep) {
    spendStamina(w, c.agent.bb.num("selfEntity") as Entity, WATER_DATA.swimStaminaPerSec / 20, 1 / 20);
  }
}

// ---- off-screen coarse simulation ----------------------------------------------------------------------------------
/** True when the host may step this bot coarsely: it is travelling on a route and no human is within fullSimTiles. */
export function wantsOffscreen(a: Agent, x: number, y: number, humans: readonly { x: number; y: number }[]): boolean {
  const m = memOf(a); if (!humans.length || (!m.travel?.route && !m.spawnOff)) return false; // ADR-325: far spawns start off-screen
  const r2 = T.offscreen.fullSimTiles ** 2; for (const h of humans) if ((h.x - x) ** 2 + (h.y - y) ** 2 <= r2) return false;
  return true;
}
/** Coarse travel for `ticks` ticks along the stored route (authoritative Transform write, vitals held at needsFloor).
 *  Returns "arrived" (hand back: full sim resumes at the goal), "moved", or "idle" (no route). */
export function offscreenStep(world: World, e: Entity, a: Agent, ticks: number, tickHz = 20): "arrived" | "moved" | "idle" {
  const m = memOf(a); const t = world.get(e, Transform); if (!t) return "idle";
  const tr = m.travel; if (!tr?.route) { offscreenPlan(world, e, a, { x: t.x, y: t.y }); return "idle"; }
  // ADR-344: a long trip that left without a journey record (it was still preparing when the bot went
  // off-screen, or a reload dropped the prep) still gets the turn-back rule, from what the bag holds now —
  // but only when the bag holds anything: an empty bag travels on ADR-343's abstract foraging (needsFloor),
  // it never had provisions to run out of, so a 0/0 record must not turn it straight back.
  if (!tr.journey) {
    const tiles = routeTiles(tr.route!, tr.origin) * (tr.kind === "resource" ? 2 : 1);
    if (tiles >= JOURNEY_DATA.minPrepTiles) {
      const defs = world.getResource(GameplayConfig)?.defs;
      const pts = defs ? bagPoints(world, e, defs) : { hunger: 0, thirst: 0, foodUnits: 0, waterUnits: 0 };
      if (pts.hunger > 0 || pts.thirst > 0) {
        tr.journey = { food: pts.hunger, water: pts.thirst, estTicks: estimateJourney(tiles, world.isRegistered(Riding) && world.has(e, Riding)).ticks, prepared: false };
        markAiDirty(a, world.tick);
      }
    }
  }
  const riding = world.isRegistered(Riding) && world.has(e, Riding);
  const speeds = crossingSpeeds(world);
  // ADR-345: the leg-entry check — a leg no crossing can make is re-planned around before the bot steps into
  // it. Off-screen nothing can recover, so a "wait" (cold / tired) counts as "around" here; the bank gate in
  // travelRun is the full-sim counterpart. The re-plan avoids this leg's own regions (rerouteAroundLeg):
  // off-screen there is no local nav to skirt small water, so the strict decision applies here even though
  // the planning check left small water to the bank gate. When the plan budget is spent the old route stays
  // and this step holds (it retries on the next step, when the budget has reset).
  {
    const wp = currentWaypoint(tr, t.x, t.y);
    if (wp) {
      const prof = legWaterProfile(world, t.x, t.y, wp.x, wp.y);
      if (prof.deep > 0) {
        const d = decideCrossing(prof, crossingBotOf(world, e), speeds);
        if (d === "around" || d === "wait") {
          const before = tr.route;
          const { from, to } = legEndpoints(tr);
          if (!rerouteAroundLeg(world, e, a, tr, from, to)) return "idle"; // no route around: the trip ends
          if (tr.route === before) return "moved"; // budget spent: hold this step, retry next
        }
      }
    }
  }
  if (!m.travel?.route) return "idle";
  const route = m.travel.route;
  // ADR-345: water on a leg slows the crossing, so a river costs its own time instead of being teleported
  // across. The budget is seconds now, spent at the water under the bot's feet — re-sampled every tile, so
  // deep water is crossed at swimSpeedMul and shallows at wadeSpeedMul, not at the leg's average speed
  // (a long dry tail after a river must not dilute the swim).
  const startX = t.x, startY = t.y;
  let budgetSecs = ticks / tickHz; let x = t.x, y = t.y;
  while (budgetSecs > 1e-6) {
    const wp = currentWaypoint(tr, x, y); if (!wp) break; const d = dist(x, y, wp.x, wp.y); if (d < 1e-6) break;
    const depth = regionSampleDepth(world, x, y);
    const mul = depth === WaterDepth.Deep ? speeds.swimMul : depth === WaterDepth.Shallow ? speeds.wadeMul : 1;
    const speed = (riding ? speeds.ride : speeds.foot) * mul;
    const s = Math.min(d, speed * budgetSecs, 1); // one tile per sub-step: the depth is re-read as the bot crosses
    x += ((wp.x - x) / d) * s; y += ((wp.y - y) / d) * s; budgetSecs -= s / Math.max(speed, 1e-6);
    if (tr.leg >= route.length - 1 && dist(x, y, tr.x, tr.y) <= T.arriveTiles) break;
  }
  world.set(e, Transform, { x, y }); noteVisited(a, x, y, world.tick);
  // ADR-345: the crossing just walked costs wetness (the exposure system's 0.15/s) and swim stamina, from the
  // water the traversed segment actually held — a river crossed mid-step still soaks the bot.
  {
    const { wet, deep } = waterSeconds(legWaterProfile(world, startX, startY, x, y), riding, speeds);
    if (wet > 0) {
      const cur = world.isRegistered(Exposure) && world.has(e, Exposure)
        ? world.getField(e, Exposure, "wetness") ?? 0
        : (world.getField(e, Wetness, "level") ?? 0) / 255;
      const next = Math.min(1, cur + WATER_WET_PER_SEC * wet);
      if (world.isRegistered(Exposure) && world.has(e, Exposure)) world.setField(e, Exposure, "wetness", next);
      if (world.isRegistered(Wetness)) {
        if (world.has(e, Wetness)) world.setField(e, Wetness, "level", Math.round(next * 255));
        else world.add(e, Wetness, { level: Math.round(next * 255) });
      }
    }
    if (deep > 0) spendStamina(world, e, WATER_DATA.swimStaminaPerSec * deep, ticks / tickHz);
  }
  if (world.isRegistered(Survival) && world.has(e, Survival)) { const sv = world.get(e, Survival)!; const f = T.offscreen.needsFloor; if (sv.hunger < f || sv.thirst < f) world.set(e, Survival, { hunger: Math.max(sv.hunger, f), thirst: Math.max(sv.thirst, f) }); } // abstract foraging on the road
  // ADR-344: provisions drain with the miles; when a provision the bot was carrying runs out the bot
  // turns back toward home instead of pressing on. The needsFloor above stays (abstract foraging keeps
  // the bot alive at 50), but it is a last resort, not the plan: it does not let the bot continue.
  if (tr.journey) {
    const before = tr.journey;
    const left = drainProvisions(before, ticks, tickHz);
    tr.journey = { ...before, ...left };
    if (provisionsExhausted(before, left)) {
      turnBackToHome(a, { x, y }, m.base ? { x: m.base.x + 1, y: m.base.y + 1 } : tr.origin, world.tick);
      return "moved";
    }
  }
  markAiDirty(a, world.tick);
  if (dist(x, y, tr.x, tr.y) <= T.arriveTiles) { endTravel(a, world.tick, true); return "arrived"; }
  return "moved";
}
/** ADR-325: an off-screen bot between trips still lives on: on the travel cooldown it picks its next goal and asks the
 *  budgeted planner for a route (no view needed; home = its remembered base, else where it stands). */
export function offscreenPlan(world: World, e: Entity, a: Agent, at: { x: number; y: number }): void {
  const m = memOf(a); const tick = world.tick;
  if (m.travelAt === undefined) m.travelAt = tick;
  if (!m.travel && (m.sent || tick - m.travelAt >= T.travelCooldownTicks)) { m.travelAt = tick; const g = pickTravelGoal(world, e, a, m.base ?? at, !!m.base); if (g) { m.travel = { ...g, pending: true }; markAiDirty(a, tick); } }
  const tr = m.travel; if (!tr?.pending) return;
  const r = requestRoute(world, a.identity.id, at.x, at.y, tr.x, tr.y); if (r === null) { endTravel(a, tick, false); return; }
  if (r) { tr.route = r; tr.leg = 0; delete tr.pending; checkRouteWater(world, e, a, tr); markAiDirty(a, tick); }
}
/** ADR-325: mark a freshly spawned bot as off-screen-eligible (it stays in the coarse sim until a human comes near). */
export function markSpawnOffscreen(a: Agent, on: boolean): void { const m = memOf(a); if (on) m.spawnOff = true; else delete m.spawnOff; }
export const spawnedOffscreen = (a: Agent): boolean => !!memOf(a).spawnOff;
/** Home anchoring without the old caps: the base is kept while travelling (only a relocation drops it) and the home only
 *  re-anchors to the bot's position past homeMaxDist when it is not on a trip that should bring it back. */
/** While on a trip's corridor (near its current leg — the segment from the previous waypoint, or the trip origin, to
 *  the current one) the bot keeps its base and home. Off the corridor (a teleport, a respawn) it re-anchors like
 *  before ADR-324. Relocation trips never keep the base. ADR-343: the corridor is measured to the leg segment, not
 *  to the waypoint points — a bot walking a 22-tile leg sits up to 11 tiles from either end, and a local-nav detour
 *  around a pond or pit pushes it sideways off the line; both are still on the trip, and on a 1200-tile expedition
 *  that distinction is what keeps the bot from losing its base mid-trip. The limit is unchanged (2 x regionTiles). */
const distToSegment = (x: number, y: number, ax: number, ay: number, bx: number, by: number): number => {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
};
export function travelKeepsHome(a: Agent, x: number, y: number): boolean {
  const tr = memOf(a).travel; if (!tr || tr.kind === "relocate") return false; if (!tr.route) return true;
  const lim = 2 * T.regionTiles; const cur = tr.route[tr.leg], prev = tr.leg > 0 ? tr.route[tr.leg - 1] : tr.origin;
  if (!cur || !prev) return true;
  return distToSegment(x, y, prev.x, prev.y, cur.x, cur.y) <= lim;
}
