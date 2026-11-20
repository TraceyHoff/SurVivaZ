/**
 * ADR-413: AI humans wear paths into roads on routes they travel often.
 *
 * A route is an unordered pair of tile endpoints (home <-> destination, home <-> favourite spot, home <->
 * resource node — whatever the travel layer's trip origin and goal are). Every completed trip (arrived) on a
 * route counts once toward it, in the bot's AiMemory (`wornRoutes`, persisted through game.agents like the
 * rest of AiMemory — see planner.ts flushAiMemory). Once a route has been travelled WORN_PATH_TRIPS times, the
 * next trip that starts on it lays a worn path: Dirt Path road tiles (RoadSurface.Path, owner 0 = worn, not
 * player-built) along the Bresenham line between the endpoints, via roads.ts spawnRoad — so the path is a
 * first-class road: it renders through the existing road autotile art (`road_path_m<mask>`, canvas2d flat
 * decals, seasonal dusting), it gives the ADR-119 movement bonus (roadSpeedMul, 1.1x on dirt path), and it
 * persists / replicates through the core chunk codec (Road is networked + persistent, ADR-119) with no new
 * schema and no persist migration. No new art: a worn path is a dirt path, which the game already draws.
 *
 * The bot then prefers the road: at route assignment (fillTravelSensors / offscreenPlan) the straight line is
 * checked, and when >= WORN_PATH_COVERAGE of its tiles are road the route waypoints are replaced by the road
 * tiles (compressed to direction changes), so the bot walks the path instead of the region-centre route. The
 * water check (checkRouteWater) still runs afterwards on the new route, so a worn path never strands a bot at
 * a river it cannot cross.
 *
 * Bounds (no per-tick work, no unbounded growth): counting happens only on trip completion; forming and the
 * preference check happen only at route assignment (a <= WORN_PATH_MAX_TILES Bresenham scan). At most
 * WORN_PATH_MAX_ROUTES_PER_AI routes per bot (least-travelled evicted first); at most WORN_PATH_MAX_TILES
 * tiles laid per formation; at most WORN_PATH_MAX_WORLD_TILES worn tiles per world (a formation that would
 * exceed it lays nothing). Tiles are skipped when already road, in water, or inside someone else's privilege
 * zone (hasPrivilege) — a worn path never paves a lake or a stranger's claim.
 */
import { Transform, type Agent, type Entity, type World } from "@engine/core";
import { isWaterId } from "@engine/world";
import { Road, RoadSurface } from "../components.js";
import { hasPrivilege } from "../building/place.js";
import { roadAt, roadLine, spawnRoad } from "../roads.js";
import { TerrainRes } from "../world.js";
import { aiMemoryOf, markAiDirty } from "./planner.js";

/** Completed trips on one route before a worn path forms. */
export const WORN_PATH_TRIPS = 3;
/** Routes shorter than this never form a path (a path across the dooryard is clutter, not a road). */
export const WORN_PATH_MIN_TILES = 6;
/** Most tiles laid when one path forms. */
export const WORN_PATH_MAX_TILES = 128;
/** Most routes remembered per bot (least-travelled evicted first). */
export const WORN_PATH_MAX_ROUTES_PER_AI = 8;
/** Most worn-path tiles in one world (owner-0 Path roads); a formation past this lays nothing. */
export const WORN_PATH_MAX_WORLD_TILES = 4096;
/** Share of the straight line that must already be road before a bot follows it instead of its region route. */
export const WORN_PATH_COVERAGE = 0.6;
/** Endpoints within this many tiles of a remembered route's endpoints count as the same route (a bot rarely
 *  departs from the exact tile it departed from last time). */
export const WORN_PATH_ENDPOINT_TOL = 4;

export interface WornRoute { ax: number; ay: number; bx: number; by: number; trips: number }

const tile = (v: number): number => Math.floor(v);
const dist = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(bx - ax, by - ay);
/** Endpoints, tile-quantised and ordered so home->dest and dest->home are the same route. */
const norm = (from: { x: number; y: number }, to: { x: number; y: number }): WornRoute => {
  const ax = tile(from.x), ay = tile(from.y), bx = tile(to.x), by = tile(to.y);
  return ax < bx || (ax === bx && ay <= by) ? { ax, ay, bx, by, trips: 0 } : { ax: bx, ay: by, bx: ax, by: ay, trips: 0 };
};
const routesOf = (a: Agent): WornRoute[] => (aiMemoryOf(a).wornRoutes ??= []);
const sameRoute = (r: WornRoute, n: WornRoute): boolean =>
  (dist(r.ax, r.ay, n.ax, n.ay) <= WORN_PATH_ENDPOINT_TOL && dist(r.bx, r.by, n.bx, n.by) <= WORN_PATH_ENDPOINT_TOL)
  || (dist(r.ax, r.ay, n.bx, n.by) <= WORN_PATH_ENDPOINT_TOL && dist(r.bx, r.by, n.ax, n.ay) <= WORN_PATH_ENDPOINT_TOL);

/** Completed trips this bot has made on the route from -> to (either direction). */
export function wornTrips(a: Agent, from: { x: number; y: number }, to: { x: number; y: number }): number {
  const n = norm(from, to); return routesOf(a).find((r) => sameRoute(r, n))?.trips ?? 0;
}

/** Record one completed trip on from -> to. Short hops do not count; the least-travelled route is evicted
 *  past the per-bot cap. Pure memory work — no world writes, so endTravel can call it. */
export function recordWornTrip(a: Agent, from: { x: number; y: number }, to: { x: number; y: number }, tick: number): void {
  if (dist(from.x, from.y, to.x, to.y) < WORN_PATH_MIN_TILES) return;
  const routes = routesOf(a); const n = norm(from, to);
  let r = routes.find((c) => sameRoute(c, n));
  if (!r) {
    if (routes.length >= WORN_PATH_MAX_ROUTES_PER_AI) {
      let worst = 0; for (let i = 1; i < routes.length; i++) if (routes[i]!.trips <= routes[worst]!.trips) worst = i;
      routes.splice(worst, 1);
    }
    r = n; routes.push(r);
  }
  r.trips++; markAiDirty(a, tick);
}

/** Lay the worn path for from -> to when this bot has travelled it often enough and no path is there yet.
 *  Returns tiles laid (0 when the route is not worn enough, a path already exists, or the world cap is hit).
 *  Skips tiles already road, in water, or inside someone else's privilege zone. */
export function maybeFormWornPath(world: World, self: Entity, a: Agent, from: { x: number; y: number }, to: { x: number; y: number }): number {
  if (wornTrips(a, from, to) < WORN_PATH_TRIPS) return 0;
  if (wornPathWaypoints(world, from, to)) return 0; // a path already connects them
  if (!world.isRegistered(Road)) return 0;
  let worn = 0;
  for (const e of world.query([Road, Transform])) {
    if ((world.getField(e, Road, "surface") ?? 0) === RoadSurface.Path && (world.getField(e, Road, "owner") ?? 0) === 0) worn++;
  }
  if (worn >= WORN_PATH_MAX_WORLD_TILES) return 0;
  const line = roadLine(from.x, from.y, to.x, to.y, WORN_PATH_MAX_TILES);
  let laid = 0;
  const terrain = world.getResource(TerrainRes);
  for (const [x, y] of line) {
    if (worn + laid >= WORN_PATH_MAX_WORLD_TILES) break;
    if (roadAt(world, x, y) !== undefined) continue;
    // ADR-450: the raw water-tile check, not inWater — inWater reads frozen lakes as land, and a worn
    // path must never pave a lake (frozen or not); the ice thaws and the path would sit on water.
    if (terrain && isWaterId(terrain.tileAt(Math.floor(x + 0.5), Math.floor(y + 0.5)))) continue;
    if (!hasPrivilege(world, self, x + 0.5, y + 0.5)) continue;
    spawnRoad(world, x, y, RoadSurface.Path, 0);
    laid++;
  }
  return laid;
}

/** Waypoints along the road tiles of the straight line from -> to, when enough of that line is already road
 *  (and road reaches both ends): the route a bot should walk instead of its region-centre route. Compressed to
 *  direction changes so a straight 100-tile path is 2 waypoints, not 100. Undefined when there is no usable
 *  path yet — the caller keeps its planned route. */
export function wornPathWaypoints(world: World, from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number }[] | undefined {
  if (!world.isRegistered(Road)) return undefined;
  const line = roadLine(from.x, from.y, to.x, to.y, WORN_PATH_MAX_TILES);
  if (line.length < WORN_PATH_MIN_TILES) return undefined;
  let road = 0; const onRoad: boolean[] = [];
  for (const [x, y] of line) { const r = roadAt(world, x, y) !== undefined; onRoad.push(r); if (r) road++; }
  if (road / line.length < WORN_PATH_COVERAGE) return undefined;
  // road must reach both ends (a cluster of road in the middle is not a path home)
  if (!onRoad.slice(0, 3).some(Boolean) || !onRoad.slice(-3).some(Boolean)) return undefined;
  const pts: { x: number; y: number }[] = [];
  let prevDx = 0, prevDy = 0;
  for (let i = 0; i < line.length; i++) {
    if (!onRoad[i]) continue;
    const [x, y] = line[i]!;
    if (!pts.length) { pts.push({ x: x + 0.5, y: y + 0.5 }); continue; }
    const last = pts[pts.length - 1]!; const dx = Math.sign(x + 0.5 - last.x), dy = Math.sign(y + 0.5 - last.y);
    if (pts.length > 1 && dx === prevDx && dy === prevDy) { pts[pts.length - 1] = { x: x + 0.5, y: y + 0.5 }; continue; } // extend the straight run
    pts.push({ x: x + 0.5, y: y + 0.5 }); prevDx = dx; prevDy = dy;
  }
  // the last road tile is the path's end, not the goal itself — the caller keeps its own arrival check
  return pts.length >= 2 ? pts : undefined;
}
