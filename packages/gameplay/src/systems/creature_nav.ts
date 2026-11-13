import { TerrainRes } from "../world.js";
import { terrainMoveBlocked } from "../building/terrain-ladder.js";
/**
 * ADR-215 creature navigation: animals and pets collide with building pieces and path around them.
 *
 * Authority only (animal AI and pets never run in client prediction; their Transforms replicate). The body is the
 * walker body of ADR-212/215 (bodyAxisMove with bodyRadius: edge walls / closed doors, solid cell pieces such as
 * stations, vertex corner posts), so creatures obey exactly the rules players and zombies do. Open ground keeps the
 * legacy straight-line step bit for bit: creatureStep() returns undefined when no piece is anchored near the move
 * (StructureIndex.anyPieceNear, a coarse 8x8 block count) and the caller runs its old code.
 *
 * Near structures: a body-sized line check (centre + 4 body corners through the tile DDA, plus the exact corner post
 * boxes) decides whether the goal is in straight sight; if not, a bounded passable-only A* (4-neighbour, doorways
 * and open doors pass, closed doors / walls / solid cells / angled-corner tiles / unwalkable terrain do not) finds a
 * tile route, cached per entity and re-planned when the goal tile or StructureIndex.version changes or it expires
 * (a goal stepping one open tile on extends the route; a stall forces a re-plan and tile-lane-only steering).
 * The creature steers to the farthest of the next few route tiles in straight sight (string pulling). An unreachable
 * goal routes to the closest reachable tile; a step that makes no progress returns false (callers idle).
 */
import { defineResource, Transform, type Entity, type World } from "@engine/core";
import { EdgeSide } from "../components.js";
import { gameplayDefs } from "../config.js";
// ADR-372 gate fix: STAIRS_DATA comes from the leaf stairs_data.js, not stairs.ts —
// creature_nav reads STAIRS_DATA.maxPathLevel at module top level to size its A* scratch
// arrays, and stairs.ts's import graph reaches back here, so importing stairs.ts from
// stairs.js threw a TDZ "Cannot access 'STAIRS_DATA' before initialization".
import { STAIRS_DATA } from "../building/stairs_data.js";
import { stairLinkDown, stairLinkUp } from "../building/stairs.js";
import { isLCorner, structures, StructureIndexRes, type StructureIndex } from "../building/structure.js";
import { bodyAxisMove, cornerPostBoxes, settleStandZ, solidCell, terrainBlocksWalker } from "./movement.js";

/** Per-tile terrain veto of the caller (animals / pets: unwalkable population tiles). */
export type TileBlocked = (tx: number, ty: number) => boolean;
interface NavState { gtx: number; gty: number; ver: number; until: number; clear: boolean; path: number[]; i: number; reached: boolean; stall: number; strict: number; pj: number; pi: number; pexp: number; /** ADR-372: entity level + goal level the cached route was planned for (a climb re-plans). */ lvl: number; glvl: number }
const NavRes = defineResource<Map<Entity, NavState>>("gameplay.CreatureNav");
const nav = (w: World): Map<Entity, NavState> => { let m = w.getResource(NavRes); if (!m) w.setResource(NavRes, (m = new Map())); return m; };

/** Route search bounds: radius (tiles) around the start, node budget and detour allowance (tiles over 2x the straight
 *  distance); cache lifetimes (ticks): open sight, unreached route, found route, string-pull pick; strict lanes after a stall. */
export const NAV = { radius: 24, maxNodes: 1200, detour: 12, clearTicks: 60, repathTicks: 40, keepTicks: 120, pullTicks: 8, lookahead: 4, strictTicks: 40 } as const;

/** Structures OR a height-step across the segment require routing, even on an otherwise empty map. */
export function navNeeded(world: World, x0: number, y0: number, x1: number, y1: number): boolean {
  const idx = world.getResource(StructureIndexRes);
  if (idx && idx.count > 0 && idx.anyPieceNear(x0, y0, x1, y1)) return true;
  return !!world.getResource(TerrainRes) && !ray(idx ?? structures(world), x0, y0, x1, y1, 0, undefined);
}

/**
 * One movement step of creature e toward (gx, gy) by up to `sp` tiles, stopping `stopAt` short of the goal. Writes the
 * Transform (x, y, facing; z settles onto decks). Returns undefined when no structure is near (caller: legacy step),
 * else whether it moved.
 */
export function creatureStep(world: World, e: Entity, gx: number, gy: number, sp: number, stopAt: number, blocked: TileBlocked, dt: number): boolean | undefined {
  const t = world.get(e, Transform); if (!t) return false;
  if (!navNeeded(world, t.x, t.y, gx, gy)) { nav(world).delete(e); return undefined; }
  const idx = structures(world); const defs = gameplayDefs(world); const r = defs.movement.bodyRadius;
  const level = Math.max(0, Math.round((t.z ?? 0) / defs.building.levelHeight));
  const gd = Math.hypot(gx - t.x, gy - t.y); if (gd <= stopAt + 1e-6) return false;
  const tgt = waypoint(world, idx, e, t.x, t.y, gx, gy, level, r, blocked);
  if (!tgt) return false;
  let dx = tgt.x - t.x, dy = tgt.y - t.y; let d = Math.hypot(dx, dy);
  if (d < 1e-6) return false;
  const k = Math.min(sp, tgt.final ? gd - stopAt : d) / d; dx *= k; dy *= k;
  let x = bodyAxisMove(world, t.x, t.y, t.x + dx, 0, level, true, r); if (blocked(Math.floor(x), Math.floor(t.y))) x = t.x;
  let y = bodyAxisMove(world, x, t.y, t.y + dy, 1, level, true, r); if (blocked(Math.floor(x), Math.floor(y))) y = t.y;
  d = Math.hypot(x - t.x, y - t.y);
  const st = nav(world).get(e);
  if (d < Math.min(sp, 0.05) * 0.2) { if (st) { st.stall++; if (st.stall > 2) { st.clear = false; st.until = 0; st.strict = world.tick + NAV.strictTicks; } } return false; } // stalled: re-plan, tile lanes only for a while
  if (st) st.stall = 0;
  world.set(e, Transform, { x, y, facing: Math.atan2(y - t.y, x - t.x) }); settleStandZ(world, e, dt);
  return true;
}

/** True when structures stand between (x0, y0) and (x1, y1) on level z's deck: no body-sized straight sight (ADR-215;
 *  e.g. a pet "close" to its owner through a wall). False on open ground. */
export function walledOff(world: World, x0: number, y0: number, x1: number, y1: number, z: number, blocked: TileBlocked): boolean {
  if (!navNeeded(world, x0, y0, x1, y1)) return false;
  const defs = gameplayDefs(world); const level = Math.max(0, Math.round(z / defs.building.levelHeight));
  return !sight(structures(world), x0, y0, x1, y1, level, defs.movement.bodyRadius, blocked);
}

/** Spot near the owner (pet teleport) that is in body-sized straight sight of (ox, oy); legacy offset first, else (ox, oy). */
export function reachableSpotNear(world: World, ox: number, oy: number, z: number, blocked: TileBlocked, prefer: readonly [number, number][]): { x: number; y: number } {
  const idx = structures(world); const defs = gameplayDefs(world); const r = defs.movement.bodyRadius; const level = Math.max(0, Math.round(z / defs.building.levelHeight));
  for (const [ax, ay] of prefer) { const x = ox + ax, y = oy + ay; if (!blocked(Math.floor(x), Math.floor(y)) && !solidCell(idx, Math.floor(x), Math.floor(y), level) && sight(idx, ox, oy, x, y, level, r, blocked)) return { x, y }; }
  return { x: ox, y: oy };
}

/**
 * AI humans emit movement input rather than teleporting: use the same cached ladder-aware route.
 * ADR-372: the walker's level comes from its own Transform.z (it used to be hardcoded 0, so a bot that
 * had climbed could never route on its own floor), and `goalLevel` routes across floors via stairs when
 * given — the bot walks onto the stair tile and the movement ramp carries its z up / down. Callers that
 * pass no goal level keep the old same-floor behaviour.
 */
export function walkerWaypoint(world: World, e: Entity, x: number, y: number, gx: number, gy: number, goalLevel?: number): { x: number; y: number } | undefined {
  if (!navNeeded(world, x, y, gx, gy)) return { x: gx, y: gy };
  const r = gameplayDefs(world).movement.bodyRadius;
  const t = world.get(e, Transform);
  const level = Math.max(0, Math.round((t?.z ?? 0) / gameplayDefs(world).building.levelHeight));
  // Digital human input moves a full ~0.13 tiles per tick: a 0.04 creature lane
  // oscillates forever across the centre. Keep a body-clear lane with half-step tolerance.
  const lane = Math.max(LANE, Math.min(.15, .5 - r - .02));
  return waypoint(world, structures(world), e, x, y, gx, gy, level, r,
    (tx, ty) => terrainBlocksWalker(world, tx, ty), lane, goalLevel ?? level);
}
/**
 * ADR-385: true when the pathfinder can route the walker from (x, y) to (gx, gy) on its
 * current level — the cached route search reaches the goal tile, not just the closest
 * reachable tile. Straight sight counts as reachable. The check reuses the same cached
 * route goTo walks (a cold check runs one bounded A*; a warm one reads the cache), so a
 * sensor can ask it every sense cycle without a fresh search each time. A goal the
 * search cannot reach — a resource node on a ridge above the max climb, a sealed room —
 * returns false, so the picker can re-target instead of freezing against the obstacle.
 * Callers must pass the walker's own current position: reachability is positional (a
 * node unreachable from here may be reachable from the far side of the ridge).
 */
export function navReachable(world: World, e: Entity, x: number, y: number, gx: number, gy: number, goalLevel?: number): boolean {
  if (!navNeeded(world, x, y, gx, gy)) return true;
  const defs = gameplayDefs(world); const r = defs.movement.bodyRadius;
  const t = world.get(e, Transform);
  const level = Math.max(0, Math.round((t?.z ?? 0) / defs.building.levelHeight));
  const lane = Math.max(LANE, Math.min(.15, .5 - r - .02));
  const wp = waypoint(world, structures(world), e, x, y, gx, gy, level, r,
    (tx, ty) => terrainBlocksWalker(world, tx, ty), lane, goalLevel ?? level);
  if (wp?.final) return true; // straight sight, or standing on the route's last tile with the goal reached
  return nav(world).get(e)?.reached ?? false; // a partial route: reached says whether it gets to the goal
}

// ---- internals -------------------------------------------------------------------------------------------------
function waypoint(world: World, idx: StructureIndex, e: Entity, x: number, y: number, gx: number, gy: number, level: number, r: number, blocked: TileBlocked, lane = LANE, goalLevel = level): { x: number; y: number; final: boolean } | undefined {
  const m = nav(world); const gtx = Math.floor(gx), gty = Math.floor(gy); const now = world.tick;
  let st = m.get(e);
  if (st && !st.clear && st.reached && st.ver === idx.version && now < st.until && now >= st.strict && st.lvl === level && st.glvl === goalLevel && Math.abs(gtx - st.gtx) + Math.abs(gty - st.gty) === 1 && enterable(idx, gtx, gty, level, blocked)
    && (level !== 0 || !terrainMoveBlocked(world, st.gtx, st.gty, gtx, gty, true))
    && !(gtx !== st.gtx ? idx.edgeBlocker(Math.max(gtx, st.gtx), gty, level, EdgeSide.West) : idx.edgeBlocker(gtx, Math.max(gty, st.gty), level, EdgeSide.North))) {
    // goal stepped one open edge on (a pet's walking owner): extend the route instead of searching again
    const p = st.path; const k = p.length;
    if (k >= 4 && p[k - 4] === gtx && p[k - 3] === gty) p.length = k - 2; else p.push(gtx, gty);
    if (st.i > p.length >> 1) st.i = p.length >> 1;
    st.gtx = gtx; st.gty = gty; st.pexp = 0;
  }
  if (!st || st.gtx !== gtx || st.gty !== gty || st.ver !== idx.version || st.lvl !== level || st.glvl !== goalLevel || now >= st.until) {
    const strict = st && now < st.strict ? st.strict : 0;
    // ADR-372: straight sight is a same-floor shortcut only — an upstairs goal is never "in sight" from below.
    const clear = !strict && goalLevel === level && sight(idx, x, y, gx, gy, level, r, blocked);
    st = { gtx, gty, ver: idx.version, until: now + (clear ? NAV.clearTicks : NAV.repathTicks), clear, path: [], i: 0, reached: true, stall: st?.stall ?? 0, strict, pj: -2, pi: -1, pexp: 0, lvl: level, glvl: goalLevel };
    if (!clear) { const p = route(idx, Math.floor(x), Math.floor(y), gtx, gty, level, blocked, goalLevel); st.path = p.path; st.reached = p.reached; if (p.reached) st.until = now + NAV.keepTicks; } // a found route holds (a door shut on it shows up as a stall)
    m.set(e, st);
    if (m.size > 64 && (now & 63) === 0) for (const k of [...m.keys()]) if (!world.isAlive(k)) m.delete(k);
  }
  if (st.clear) return { x: gx, y: gy, final: true };
  const p = st.path; const n = p.length >> 1;
  // advance past route tiles the body centre has reached
  const ctx = Math.floor(x), cty = Math.floor(y);
  for (let j = Math.min(n - 1, st.i + NAV.lookahead); j >= st.i; j--) if (p[j * 2] === ctx && p[j * 2 + 1] === cty) { st.i = j + 1; break; }
  if (st.i >= n) return st.reached ? { x: gx, y: gy, final: true } : undefined; // at the closest reachable tile
  // string pulling: farthest of the next few route tiles in straight sight (the goal itself when it is)
  const pull = now >= st.strict; // after a stall: no string pulling (thin sight rays can miss a wall end the square body catches)
  // (the pick is cached while the route index holds: walking toward a point in straight sight keeps it in sight)
  if (pull) {
    if (st.pi !== st.i || now >= st.pexp) {
      st.pi = st.i; st.pexp = now + NAV.pullTicks; st.pj = -1;
      if (st.reached && n - st.i <= NAV.lookahead && sight(idx, x, y, gx, gy, level, r, blocked)) st.pj = n;
      else for (let j = Math.min(n - 1, st.i + NAV.lookahead - 1); j > st.i; j--) if (sight(idx, x, y, p[j * 2]! + 0.5, p[j * 2 + 1]! + 0.5, level, r, blocked)) { st.pj = j; break; }
    }
    if (st.pj === n) return { x: gx, y: gy, final: true };
    if (st.pj > st.i) return { x: p[st.pj * 2]! + 0.5, y: p[st.pj * 2 + 1]! + 0.5, final: false };
  }
  // next route tile only: cross into it along the current tile's centre line (clears corner posts and the ADR-212
  // lateral samples), so first slide back onto that lane when the body is off it
  const nx = p[st.i * 2]!, ny = p[st.i * 2 + 1]!;
  if (Math.abs(nx - ctx) + Math.abs(ny - cty) === 1) {
    if (nx !== ctx && Math.abs(y - (cty + 0.5)) > lane) return { x, y: cty + 0.5, final: false };
    if (ny !== cty && Math.abs(x - (ctx + 0.5)) > lane) return { x: ctx + 0.5, y, final: false };
  }
  return { x: nx + 0.5, y: ny + 0.5, final: false };
}
const LANE = 0.04;

/** Tile a body may stand in: walkable terrain, no solid station / furniture, not split by an angled corner run. */
function enterable(idx: StructureIndex, nx: number, ny: number, level: number, blocked: TileBlocked): boolean {
  return !blocked(nx, ny) && !solidCell(idx, nx, ny, level) && !(idx.vertexPosts > 0 && angledTile(idx, nx, ny, level));
}
const scratch: number[] = [];
/** Tile containing the 45 deg run of a wall_corner_angled at one of its four corners (the run splits it diagonally). */
function angledTile(idx: StructureIndex, tx: number, ty: number, level: number): boolean {
  for (let c = 0; c < 4; c++) {
    const vx = tx + (c & 1), vy = ty + (c >> 1); const e = idx.cell(vx, vy, level, 3); if (!e) continue; const d = idx.def(e);
    if (!d || d.snap !== "vertex" || !d.solid || isLCorner(d) || d.rotSteps !== 8) continue;
    const b = cornerPostBoxes(d, idx.info.get(e)?.slot.rot ?? 0, vx, vy, scratch); // last run box sits inside the split tile
    if (Math.floor(b[b.length - 4]!) === tx && Math.floor(b[b.length - 3]!) === ty) return true;
  }
  return false;
}

/** Body-sized straight sight from (x0, y0) to (x1, y1): centre ray (terrain + structures) and the 4 body-corner rays (structures), plus corner posts. */
function sight(idx: StructureIndex, x0: number, y0: number, x1: number, y1: number, level: number, r: number, blocked: TileBlocked): boolean {
  const k = r * 0.98;
  if (!ray(idx, x0, y0, x1, y1, level, blocked)) return false;
  for (let c = 0; c < 4; c++) { const ox = c & 1 ? k : -k, oy = c & 2 ? k : -k; if (!ray(idx, x0 + ox, y0 + oy, x1 + ox, y1 + oy, level, undefined)) return false; }
  return !(idx.vertexPosts > 0 && postsHit(idx, x0, y0, x1, y1, level, r));
}
/** Tile DDA: every tile boundary crossed must be a passable step (corner crossings must pass both ways round). */
function ray(idx: StructureIndex, x0: number, y0: number, x1: number, y1: number, level: number, blocked: TileBlocked | undefined): boolean {
  let tx = Math.floor(x0), ty = Math.floor(y0); const ex = Math.floor(x1), ey = Math.floor(y1);
  const dx = x1 - x0, dy = y1 - y0; const sx = Math.sign(dx), sy = Math.sign(dy);
  const tdx = sx ? Math.abs(1 / dx) : Infinity, tdy = sy ? Math.abs(1 / dy) : Infinity;
  let tmx = sx > 0 ? (tx + 1 - x0) * tdx : sx < 0 ? (x0 - tx) * tdx : Infinity;
  let tmy = sy > 0 ? (ty + 1 - y0) * tdy : sy < 0 ? (y0 - ty) * tdy : Infinity;
  for (let guard = 0; guard < 256 && (tx !== ex || ty !== ey); guard++) {
    if (Math.abs(tmx - tmy) < 1e-9) { // through a vertex: both orders
      if (tmx > 1) break;
      if (!(crossOk(idx, tx, ty, tx + sx, ty, level, blocked) && crossOk(idx, tx + sx, ty, tx + sx, ty + sy, level, blocked) && crossOk(idx, tx, ty, tx, ty + sy, level, blocked) && crossOk(idx, tx, ty + sy, tx + sx, ty + sy, level, blocked))) return false;
      tx += sx; ty += sy; tmx += tdx; tmy += tdy;
    } else if (tmx < tmy) { if (tmx > 1) break; if (!crossOk(idx, tx, ty, tx + sx, ty, level, blocked)) return false; tx += sx; tmx += tdx; }
    else { if (tmy > 1) break; if (!crossOk(idx, tx, ty, tx, ty + sy, level, blocked)) return false; ty += sy; tmy += tdy; }
  }
  return true;
}
/** One tile-boundary crossing of a sight ray (terrain veto optional). */
function crossOk(idx: StructureIndex, ax: number, ay: number, bx: number, by: number, level: number, blocked: TileBlocked | undefined): boolean {
  if (level === 0 && terrainMoveBlocked(idx.world, ax, ay, bx, by, true)) return false;
  if (blocked && blocked(bx, by)) return false;
  if (bx !== ax ? idx.edgeBlocker(Math.max(ax, bx), ay, level, EdgeSide.West) : idx.edgeBlocker(ax, Math.max(ay, by), level, EdgeSide.North)) return false;
  return !solidCell(idx, bx, by, level);
}
/** Segment vs vertex post boxes inflated by the body half-size (slab test). */
function postsHit(idx: StructureIndex, x0: number, y0: number, x1: number, y1: number, level: number, r: number): boolean {
  const pad = r + 0.6;
  for (let vy = Math.ceil(Math.min(y0, y1) - pad); vy <= Math.floor(Math.max(y0, y1) + pad); vy++) for (let vx = Math.ceil(Math.min(x0, x1) - pad); vx <= Math.floor(Math.max(x0, x1) + pad); vx++) {
    const e = idx.cell(vx, vy, level, 3); if (!e) continue; const d = idx.def(e);
    if (!d || d.snap !== "vertex" || !d.solid || isLCorner(d)) continue;
    const b = cornerPostBoxes(d, idx.info.get(e)?.slot.rot ?? 0, vx, vy, scratch);
    for (let i = 0; i < b.length; i += 4) if (segBox(x0, y0, x1, y1, b[i]!, b[i + 1]!, b[i + 2]! + r, b[i + 3]! + r)) return true;
  }
  return false;
}
function segBox(x0: number, y0: number, x1: number, y1: number, cx: number, cy: number, hx: number, hy: number): boolean {
  let t0 = 0, t1 = 1; const dx = x1 - x0, dy = y1 - y0;
  for (let ax = 0; ax < 2; ax++) {
    const p = ax ? y0 : x0, d = ax ? dy : dx, lo = ax ? cy - hy : cx - hx, hi = ax ? cy + hy : cx + hx;
    if (Math.abs(d) < 1e-12) { if (p <= lo || p >= hi) return false; continue; }
    let a = (lo - p) / d, b = (hi - p) / d; if (a > b) { const s = a; a = b; b = s; }
    t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 >= t1) return false;
  }
  return true;
}

// A* scratch (single-threaded sim): a (2R+1)^2 window around the start, x ADR-372 levels (townhouse = 0..2)
const W = NAV.radius * 2 + 1; const NL = STAIRS_DATA.maxPathLevel + 1; const NN = W * W * NL;
const G = new Float64Array(NN); const PARENT = new Int32Array(NN); const SEEN = new Uint32Array(NN); const CLOSED = new Uint32Array(NN); const ENTER = new Uint32Array(NN); const ENTER_OK = new Uint8Array(NN); let stamp = 0;
const HEAP: number[] = []; const HF: number[] = [];
/**
 * Bounded A* over passable steps; falls back to the closest reached tile (by heuristic) when the goal is not reachable.
 * ADR-372: state is (x, y, level) and a stair tile links its level to the one above / below at `pathStairCost`,
 * so a walker whose goal is on another floor routes through the stairs; the returned `path` stays (x, y) pairs
 * (the follower re-plans when its level flips) with `levels` alongside for callers that need them. With
 * goalLevel === level the search is the old single-level one.
 */
function route(idx: StructureIndex, sx: number, sy: number, gx: number, gy: number, level: number, blocked: TileBlocked, goalLevel: number = level): { path: number[]; levels: number[]; reached: boolean } {
  stamp = (stamp + 1) >>> 0; if (stamp === 0) { SEEN.fill(0); CLOSED.fill(0); ENTER.fill(0); stamp = 1; }
  const ox = sx - NAV.radius, oy = sy - NAV.radius;
  const inWin = (x: number, y: number): boolean => x >= ox && y >= oy && x < ox + W && y < oy + W;
  const stairCost = STAIRS_DATA.pathStairCost;
  const h = (x: number, y: number, l: number): number => Math.abs(x - gx) + Math.abs(y - gy) + Math.abs(l - goalLevel) * stairCost;
  const id = (x: number, y: number, l: number): number => (l * W + (y - oy)) * W + (x - ox);
  const id0 = id(sx, sy, level); SEEN[id0] = stamp; G[id0] = 0; PARENT[id0] = -1;
  HEAP.length = 0; HF.length = 0; push(id0, h(sx, sy, level));
  let best = id0, bestH = h(sx, sy, level), expanded = 0, goal = -1; const fMax = 2 * bestH + NAV.detour; // bounded detour: a sealed goal cannot flood the window
  while (HEAP.length && expanded < NAV.maxNodes) {
    const cur = pop(); if (CLOSED[cur] === stamp) continue; CLOSED[cur] = stamp; expanded++;
    const cl = Math.floor(cur / (W * W)); const rem = cur - cl * W * W;
    const cx = (rem % W) + ox, cy = Math.floor(rem / W) + oy;
    if (cx === gx && cy === gy && cl === goalLevel) { goal = cur; break; }
    const hc = h(cx, cy, cl); if (hc < bestH) { bestH = hc; best = cur; }
    const relax = (nx: number, ny: number, nl: number, g: number): void => {
      if (g + h(nx, ny, nl) > fMax) return;
      const nid = id(nx, ny, nl); if (CLOSED[nid] === stamp) return;
      if (ENTER[nid] !== stamp) { ENTER[nid] = stamp; ENTER_OK[nid] = enterable(idx, nx, ny, nl, blocked) ? 1 : 0; }
      if (!ENTER_OK[nid]) return;
      if (SEEN[nid] === stamp && G[nid]! <= g) return;
      SEEN[nid] = stamp; G[nid] = g; PARENT[nid] = cur; push(nid, g + h(nx, ny, nl) * 1.001);
    };
    for (let k = 0; k < 4; k++) {
      const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = cy + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (!inWin(nx, ny)) continue;
      if (cl === 0 && terrainMoveBlocked(idx.world, cx, cy, nx, ny, true)) continue;
      if (nx !== cx ? idx.edgeBlocker(Math.max(cx, nx), cy, cl, EdgeSide.West) : idx.edgeBlocker(cx, Math.max(cy, ny), cl, EdgeSide.North)) continue;
      relax(nx, ny, cl, G[cur]! + 1);
    }
    // ADR-372: vertical stair links on this tile (same tile, level +/- 1).
    if (cl < STAIRS_DATA.maxPathLevel && stairLinkUp(idx, cx, cy, cl)) relax(cx, cy, cl + 1, G[cur]! + stairCost);
    if (cl > 0 && stairLinkDown(idx, cx, cy, cl)) relax(cx, cy, cl - 1, G[cur]! + stairCost);
  }
  const end = goal >= 0 ? goal : best; const out: number[] = []; const outLv: number[] = [];
  for (let c = end; c !== -1 && c !== id0; c = PARENT[c]!) {
    const l = Math.floor(c / (W * W)); const r2 = c - l * W * W;
    out.push((r2 % W) + ox, Math.floor(r2 / W) + oy); outLv.push(l);
  }
  // reverse pairs (start side first)
  const path: number[] = []; const levels: number[] = [];
  for (let i = out.length - 2; i >= 0; i -= 2) { path.push(out[i]!, out[i + 1]!); levels.push(outLv[i / 2]!); }
  return { path, levels, reached: goal >= 0 };
}
function push(id: number, f: number): void {
  HEAP.push(id); HF.push(f); let i = HEAP.length - 1;
  while (i > 0) { const p = (i - 1) >> 1; if (HF[p]! < f || (HF[p] === f && HEAP[p]! <= id)) break; HEAP[i] = HEAP[p]!; HF[i] = HF[p]!; i = p; }
  HEAP[i] = id; HF[i] = f;
}
function pop(): number {
  const top = HEAP[0]!; const lid = HEAP.pop()!, lf = HF.pop()!; const n = HEAP.length;
  if (n) {
    let i = 0;
    for (;;) { const l = 2 * i + 1, r = l + 1; let m = i, mf = lf, mid = lid;
      if (l < n && (HF[l]! < mf || (HF[l] === mf && HEAP[l]! < mid))) { m = l; mf = HF[l]!; mid = HEAP[l]!; }
      if (r < n && (HF[r]! < mf || (HF[r] === mf && HEAP[r]! < mid))) { m = r; }
      if (m === i) break; HEAP[i] = HEAP[m]!; HF[i] = HF[m]!; i = m; }
    HEAP[i] = lid; HF[i] = lf;
  }
  return top;
}
