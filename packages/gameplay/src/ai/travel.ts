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
 * Deterministic (FNV hashes of the agent id, no rng), server-authoritative (the host writes the authoritative world).
 */
import { Transform, type Agent, type AgentContext, type AgentOutput, type Entity, type Traits, type World } from "@engine/core";
import { ProceduralGenerator } from "@engine/world";
import raw from "../../data/travel.json";
import type { AgentWorldView, GameBehavior } from "../agents.js";
import { AbandonedSite, ClanStatus, Riding, StallHeader, Survival, Worker } from "../components.js";
import { GameplayConfig } from "../config.js";
import { inWater } from "../systems/movement.js";
import { TerrainRes } from "../world.js";
import { goTo } from "./base_behaviors.js";
import { aiMemoryOf, markAiDirty } from "./planner.js";

export const TRAVEL: Readonly<typeof raw> = raw;
const T = raw;
export type TravelKind = "explore" | "poi" | "trade" | "relocate" | "return" | "sent";
export interface TravelState { kind: TravelKind; x: number; y: number; since: number; route?: { x: number; y: number }[]; leg: number; origin: { x: number; y: number }; pending?: boolean }
export type TravelMode = "free" | "roam" | "stay" | "worker";
export interface TravelSensors { travel?: TravelState; travelMode?: TravelMode }
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
/** A* over the region grid (8-neighbour), node budget maxRegionExpand. Waypoints = region centres + the exact goal. */
export function planRegionRoute(world: World, fx: number, fy: number, tx: number, ty: number): { x: number; y: number }[] | undefined {
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
      const c = k === goal ? 1 : regionCost(world, rx, ry); if (!Number.isFinite(c)) continue;
      const ng = g.get(cur.k)! + c * (dx && dy ? Math.SQRT2 : 1); if (ng >= (g.get(k) ?? Infinity)) continue;
      g.set(k, ng); from.set(k, cur.k); pos.set(k, [rx, ry]); heapPush(open, { k, rx, ry, f: ng + h(rx, ry) });
    }
  }
  return undefined;
}
const budget = new WeakMap<World, { tick: number; used: number }>();
/** Budgeted route planning: at most maxPlansPerTick routes per world tick, served in request order (the controller's
 *  stable agent order, so deterministic); a caller over the budget gets undefined and asks again next tick. Returns the
 *  route, or `null` when unreachable within the node budget. */
export function requestRoute(world: World, _id: string, fx: number, fy: number, tx: number, ty: number): { x: number; y: number }[] | null | undefined {
  let b = budget.get(world); if (!b) budget.set(world, (b = { tick: world.tick, used: 0 }));
  if (b.tick !== world.tick) { b.tick = world.tick; b.used = 0; }
  if (b.used >= T.maxPlansPerTick) return undefined;
  b.used++; return planRegionRoute(world, fx, fy, tx, ty) ?? null;
}
/** Routes planned this tick (tests / debug). */
export const plansThisTick = (world: World): number => { const b = budget.get(world); return b && b.tick === world.tick ? b.used : 0; };

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
  if (mode === "roam" && m.roamSince !== undefined && tick - m.roamSince > T.roamReturnTicks && dist(t.x, t.y, anchor.x, anchor.y) > T.clanStayRadius) return mk("return", anchor.x, anchor.y);
  const n = m.travelN ?? 0; const h = fnv(`${a.identity.id}:${n}`);
  if (mode === "stay") { // a short loop inside the clan's range
    const ang = (h / 4294967296) * Math.PI * 2, r = T.clanStayRadius * (0.4 + 0.5 * ((h >>> 8) % 1000) / 1000);
    return mk("explore", anchor.x + Math.cos(ang) * r, anchor.y + Math.sin(ang) * r);
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
  if (m.travelAt === undefined) m.travelAt = tick; // first goal one cooldown after the bot appears (settle in first)
  if (!m.travel && (m.sent || tick - m.travelAt >= T.travelCooldownTicks)) {
    m.travelAt = tick; const g = pickTravelGoal(world, self, a, view.home, !!view.base);
    if (g) { m.travel = { ...g, pending: true }; if (view.travelMode === "roam" && m.roamSince === undefined && g.kind !== "return") m.roamSince = tick; markAiDirty(a, tick); }
  }
  const tr = m.travel; if (!tr) return;
  if (tr.pending) { const r = requestRoute(world, a.identity.id, t.x, t.y, tr.x, tr.y); if (r === null) { endTravel(a, tick, false); return; } if (r) { tr.route = r; tr.leg = 0; delete tr.pending; markAiDirty(a, tick); } }
  view.travel = tr;
}
/** Travel done (arrived = true) or dropped: relocations move the homestead, a clan roamer's return clears its roam clock. */
export function endTravel(a: Agent, tick: number, arrived: boolean): void {
  const m = memOf(a); const tr = m.travel; if (!tr) return;
  if (arrived && tr.kind === "relocate") { delete m.base; m.stats.relocations++; }
  if (tr.kind === "return" && arrived) delete m.roamSince;
  m.travelN = (m.travelN ?? 0) + 1; delete m.travel; m.travelAt = tick; markAiDirty(a, tick);
}
const calmFor = (c: Ctx): boolean => c.self.hp >= T.minHp && c.self.hunger > T.minNeeds && c.self.thirst > T.minNeeds && !c.memory.nearest("zombie", c.self.x, c.self.y, 0.3);
/** Next waypoint of a route from the current leg (advances legs within waypointArriveTiles). */
export function currentWaypoint(tr: TravelState, x: number, y: number): { x: number; y: number } | undefined {
  const r = tr.route; if (!r) return undefined;
  while (tr.leg < r.length - 1 && dist(x, y, r[tr.leg]!.x, r[tr.leg]!.y) <= T.waypointArriveTiles) tr.leg++;
  return r[tr.leg];
}
export function travelBehaviors(): GameBehavior[] {
  return [{
    name: "travel", inertia: 0.5, traits: { bravery: 0.3 },
    considerations: [
      { name: "goal", weight: T.travelUtility, curve: { type: "step", at: 0.5 }, input: (c) => (c.world.travel?.route && calmFor(c) ? 1 : 0) },
    ],
    run: (c, o) => travelRun(c, o),
  }];
}
export function travelRun(c: Ctx, o: AgentOutput): boolean | void {
  const tr = c.world.travel; if (!tr?.route) return false;
  if (dist(c.self.x, c.self.y, tr.x, tr.y) <= T.arriveTiles) { endTravel(c.agent, c.self.tick, true); o.moveX = 0; o.moveY = 0; return false; }
  const wp = currentWaypoint(tr, c.self.x, c.self.y); if (!wp) return false;
  goTo(c, o as never, wp.x, wp.y, 0.9); // local nav per leg; the ADR-321 mount policy rides long legs
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
  const route = tr.route;
  const riding = world.isRegistered(Riding) && world.has(e, Riding);
  let budgetTiles = (riding ? T.offscreen.mountSpeedTilesPerSec : T.offscreen.speedTilesPerSec) * ticks / tickHz; let x = t.x, y = t.y;
  while (budgetTiles > 1e-6) {
    const wp = currentWaypoint(tr, x, y); if (!wp) break; const d = dist(x, y, wp.x, wp.y); if (d < 1e-6) break;
    const s = Math.min(d, budgetTiles); x += ((wp.x - x) / d) * s; y += ((wp.y - y) / d) * s; budgetTiles -= s;
    if (tr.leg >= route.length - 1 && dist(x, y, tr.x, tr.y) <= T.arriveTiles) break;
  }
  world.set(e, Transform, { x, y }); noteVisited(a, x, y, world.tick);
  if (world.isRegistered(Survival) && world.has(e, Survival)) { const sv = world.get(e, Survival)!; const f = T.offscreen.needsFloor; if (sv.hunger < f || sv.thirst < f) world.set(e, Survival, { hunger: Math.max(sv.hunger, f), thirst: Math.max(sv.thirst, f) }); } // abstract foraging on the road
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
  if (r) { tr.route = r; tr.leg = 0; delete tr.pending; markAiDirty(a, tick); }
}
/** ADR-325: mark a freshly spawned bot as off-screen-eligible (it stays in the coarse sim until a human comes near). */
export function markSpawnOffscreen(a: Agent, on: boolean): void { const m = memOf(a); if (on) m.spawnOff = true; else delete m.spawnOff; }
export const spawnedOffscreen = (a: Agent): boolean => !!memOf(a).spawnOff;
/** Home anchoring without the old caps: the base is kept while travelling (only a relocation drops it) and the home only
 *  re-anchors to the bot's position past homeMaxDist when it is not on a trip that should bring it back. */
/** While on a trip's corridor (near its current or previous waypoint) the bot keeps its base and home. Off the corridor
 *  (a teleport, a respawn) it re-anchors like before ADR-324. Relocation trips never keep the base. */
export function travelKeepsHome(a: Agent, x: number, y: number): boolean {
  const tr = memOf(a).travel; if (!tr || tr.kind === "relocate") return false; if (!tr.route) return true;
  const lim = 2 * T.regionTiles; const cur = tr.route[tr.leg], prev = tr.leg > 0 ? tr.route[tr.leg - 1] : tr.origin;
  return (!!cur && dist(x, y, cur.x, cur.y) <= lim) || (!!prev && dist(x, y, prev.x, prev.y) <= lim);
}
