import { terrainStepBlocked } from "../building/terrain-ladder.js";
/**
 * Zombie pathing: deterministic A* on the tile grid at level 0, 4-neighbour moves. Crossing an edge with a blocking
 * wall or closed door (or entering a solid cell piece) is allowed at a break cost = ticks to destroy it
 * (hp / damage per hit x cooldown) x breakCostMul, so zombies route through doors/weak walls when that is cheaper
 * than walking around. Unwalkable terrain is impassable. Returns the tile path and the first blocking piece on it.
 * ADR-372: with `opts.allowStairs` the search state is (x, y, level) and a stair tile links its level to the one
 * above / below (stairLinkUp / stairLinkDown) at `pathStairCost`, so a caller that knows the goal's level can route
 * across floors; `levels` parallels `tiles`. Default (no opts) is bit-identical to the old level-0 search: zombies
 * keep their old behaviour and never route upstairs.
 */
import { WaterDepth, waterDepthAt } from "@engine/world";
import type { Entity, World } from "@engine/core";
import { BuildPiece, EdgeSide } from "../components.js";
import { gameplayDefs } from "../config.js";
import { STAIRS_DATA, stairLinkDown, stairLinkUp } from "../building/stairs.js";
import { StructureIndexRes, type StructureIndex } from "../building/structure.js";
import { TerrainRes } from "../world.js";

export interface PathResult { tiles: [number, number][]; blocker: Entity | 0; blockerIndex: number; cost: number; /** ADR-372: level of each tile in `tiles` (all 0 unless stair links were allowed). */ levels: number[] }
export interface FindPathOpts { startLevel?: number; goalLevel?: number; allowStairs?: boolean }

/** Blocker when stepping from (x,y) to (nx,ny) at `level`: edge wall/door between them, or a solid cell at the destination. */
const BLOCK_IDS: number[] = []; // Task 29: reused scratch (single-threaded sim; stepBlocker is a leaf)
export function stepBlocker(idx: StructureIndex | undefined, x: number, y: number, nx: number, ny: number, level = 0): Entity | 0 {
  if (!idx || idx.count === 0) return 0;
  let e: Entity | 0 = 0;
  if (nx !== x) e = idx.edgeBlocker(Math.max(x, nx), y, level, EdgeSide.West);
  else e = idx.edgeBlocker(x, Math.max(y, ny), level, EdgeSide.North);
  if (e) return e;
  // Task 29: one chunk-layer resolution for layers 1..3 (grid.cellsIn) instead of a full at() per
  // layer — same layer order, same solid check, first solid cell wins.
  BLOCK_IDS.length = 0; idx.grid.cellsIn(nx, ny, level, 1, 3, BLOCK_IDS);
  for (const id of BLOCK_IDS) { const c = idx.byGrid.get(id) ?? 0; if (c && idx.def(c)?.solid) return c; }
  return 0;
}

// ---- Task 29: allocation-free A* scratch -----------------------------------------------
// The old implementation kept g/from in Maps and the heap in a class holding a fresh 3-element
// array per push (plus a temp array per swap): a 20-tile chase through a village expanded up to
// 4000 nodes and cost ~15ms per call. Node state now lives in module-level typed arrays keyed by
// window index, stamped per search so no clearing is needed (same pattern as creature_nav route());
// the heap keeps (f, h, key) in three parallel number arrays. Ordering is exactly the old one:
// f ascending, then h ascending, then key ascending, with the same stale-pop epsilon check, so the
// returned path, blocker and cost are unchanged. Single-threaded and synchronous: no re-entrancy.
let P_SEEN = new Uint32Array(0);
let P_G = new Float64Array(0);
let P_FROM = new Int32Array(0);
let P_BLOCKER = new Int32Array(0);
let pStamp = 0;
const P_HF: number[] = []; const P_HH: number[] = []; const P_HK: number[] = [];
let pTopF = 0;
function pEnsure(n: number): void {
  if (P_G.length >= n) return;
  P_SEEN = new Uint32Array(n); P_G = new Float64Array(n); P_FROM = new Int32Array(n); P_BLOCKER = new Int32Array(n); pStamp = 0;
}
function pLess(f0: number, h0: number, k0: number, f1: number, h1: number, k1: number): boolean {
  return f0 < f1 || (f0 === f1 && (h0 < h1 || (h0 === h1 && k0 < k1)));
}
function pPush(f: number, h: number, k: number): void {
  P_HF.push(f); P_HH.push(h); P_HK.push(k);
  let i = P_HF.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (pLess(P_HF[p]!, P_HH[p]!, P_HK[p]!, f, h, k)) break;
    P_HF[i] = P_HF[p]!; P_HH[i] = P_HH[p]!; P_HK[i] = P_HK[p]!; i = p;
  }
  P_HF[i] = f; P_HH[i] = h; P_HK[i] = k;
}
/** Pops the minimum entry; returns its key and leaves its f in pTopF. */
function pPop(): number {
  const topK = P_HK[0]!; pTopF = P_HF[0]!;
  const lk = P_HK.pop()!, lf = P_HF.pop()!, lh = P_HH.pop()!;
  const n = P_HK.length;
  if (n) {
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1; let m = i, mf = lf, mh = lh, mk = lk;
      if (l < n && pLess(P_HF[l]!, P_HH[l]!, P_HK[l]!, mf, mh, mk)) { m = l; mf = P_HF[l]!; mh = P_HH[l]!; mk = P_HK[l]!; }
      if (r < n && pLess(P_HF[r]!, P_HH[r]!, P_HK[r]!, mf, mh, mk)) { m = r; mf = P_HF[r]!; mh = P_HH[r]!; mk = P_HK[r]!; }
      if (m === i) break;
      P_HF[i] = P_HF[m]!; P_HH[i] = P_HH[m]!; P_HK[i] = P_HK[m]!; i = m;
    }
    P_HF[i] = lf; P_HH[i] = lh; P_HK[i] = lk;
  }
  return topK;
}

export function findPath(world: World, sx: number, sy: number, gx: number, gy: number, breakTicks: (piece: Entity) => number, opts: FindPathOpts = {}): PathResult | undefined {
  const defs = gameplayDefs(world); const ai = defs.ai; const idx = world.getResource(StructureIndexRes); const terrain = world.getResource(TerrainRes);
  const unwalk = defs.worldgen.unwalkableTiles; const shallowR = defs.movement.shallowRadius; const R = ai.maxSearchRadius;
  const W = 2 * R + 1;
  // ADR-372: level-aware state (x, y, level); without stair links L = 1 and every key below is the old key.
  const allowStairs = opts.allowStairs === true; const maxLevel = allowStairs ? STAIRS_DATA.maxPathLevel : 0;
  const startLevel = Math.max(0, Math.min(maxLevel, opts.startLevel ?? 0)); const goalLevel = Math.max(0, Math.min(maxLevel, opts.goalLevel ?? 0));
  const stairCost = STAIRS_DATA.pathStairCost;
  const L = maxLevel + 1; const N = W * W * L;
  pEnsure(N);
  pStamp = (pStamp + 1) >>> 0; if (pStamp === 0) { P_SEEN.fill(0); pStamp = 1; }
  const key = (x: number, y: number, l: number): number => (l * W + (y - sy + R)) * W + (x - sx + R);
  const h = (x: number, y: number, l: number): number => Math.abs(x - gx) + Math.abs(y - gy) + Math.abs(l - goalLevel) * stairCost;
  P_HF.length = 0; P_HH.length = 0; P_HK.length = 0;
  const k0 = key(sx, sy, startLevel); P_SEEN[k0] = pStamp; P_G[k0] = 0; P_FROM[k0] = -1; P_BLOCKER[k0] = 0;
  pPush(h(sx, sy, startLevel), 0, k0);
  let expanded = 0; let best = k0, bestH = h(sx, sy, startLevel);
  while (expanded < ai.maxExpandedNodes) {
    if (!P_HK.length) break;
    const k = pPop();
    // ADR-372: decode the level from the key (level stride W * W).
    const lv = Math.floor(k / (W * W)); const rem = k - lv * W * W;
    const x = (rem % W) + sx - R, y = Math.floor(rem / W) + sy - R; const gc = P_G[k]!;
    if (pTopF > gc + h(x, y, lv) + 1e-9) continue;
    expanded++;
    const hh = h(x, y, lv); if (hh < bestH) { bestH = hh; best = k; }
    if (x === gx && y === gy && lv === goalLevel) { best = k; break; }
    const relax = (nx: number, ny: number, nl: number, step: number, b: Entity | 0): void => {
      const nk = key(nx, ny, nl); const ng = gc + step;
      if (P_SEEN[nk] !== pStamp || ng < P_G[nk]!) { P_SEEN[nk] = pStamp; P_G[nk] = ng; P_FROM[nk] = k; P_BLOCKER[nk] = b; const nh = h(nx, ny, nl); pPush(ng + nh, nh, nk); }
    };
    for (let d = 0; d < 4; d++) {
      const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0), ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
      if (Math.abs(nx - sx) > R || Math.abs(ny - sy) > R) continue;
      // Task 29: inlined terrainBlocksWalker — same predicate, but the tile is fetched once and
      // gameplayDefs/TerrainRes are not re-resolved per neighbour. Terrain only binds ground level.
      if (lv === 0 && terrain) { const tile = terrain.tileAt(nx, ny); if (unwalk.has(tile) && waterDepthAt(terrain.tileAt, nx, ny, shallowR) !== WaterDepth.Shallow) continue; }
      if (lv === 0 && terrainStepBlocked(terrain, idx, x, y, nx, ny, world)) continue;
      const b = stepBlocker(idx, x, y, nx, ny, lv);
      relax(nx, ny, lv, 1 + (b ? breakTicks(b) * ai.breakCostMul : 0), b);
    }
    // ADR-372: vertical stair links on this tile (same tile, level +/- 1, no break cost).
    if (allowStairs && idx) {
      if (lv < maxLevel && stairLinkUp(idx, x, y, lv)) relax(x, y, lv + 1, stairCost, 0);
      if (lv > 0 && stairLinkDown(idx, x, y, lv)) relax(x, y, lv - 1, stairCost, 0);
    }
  }
  const tiles: [number, number][] = []; const levels: number[] = [];
  for (let k = best; k !== -1; k = P_FROM[k]!) {
    const lv = Math.floor(k / (W * W)); const rem = k - lv * W * W;
    tiles.push([(rem % W) + sx - R, Math.floor(rem / W) + sy - R]); levels.push(lv);
  }
  tiles.reverse(); levels.reverse();
  // ADR-368: the blocker of the step into each tile was recorded during relaxation (P_BLOCKER is set
  // exactly when P_FROM is, so it always describes the chosen path's edge) — no second stepBlocker
  // scan over the path (each call did a chunk-layer cellsIn per tile). stepBlocker is deterministic
  // on the geometry, so the reported blocker and index are unchanged.
  let blocker: Entity | 0 = 0, blockerIndex = -1;
  for (let i = 1; i < tiles.length; i++) { const b = P_BLOCKER[key(tiles[i]![0], tiles[i]![1], levels[i]!)]!; if (b) { blocker = b; blockerIndex = i; break; } }
  return { tiles, blocker, blockerIndex, cost: P_SEEN[best] === pStamp ? P_G[best]! : 0, levels };
}
export const pieceHp = (world: World, e: Entity): number => world.getField(e, BuildPiece, "hp") ?? 0;
