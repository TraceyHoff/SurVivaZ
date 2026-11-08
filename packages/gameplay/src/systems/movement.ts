import { autoSprintReady } from "./auto-sprint.js";
import { applyDamage } from "../combat/combat.js";
import { ladderBetween, terrainMoveBlocked } from "../building/terrain-ladder.js";
export { ladderBetween };
import { shaftAwareHeight, updateShaftOccupancy } from "../building/terrain-hatch.js";
/**
 * Player movement (moved from apps/server protocol.ts). Same function on the server and in client prediction:
 * screen-aligned iso directions from action bits (GameplayActions MoveUp/Down/Left/Right/Sprint occupy bits 0..4,
 * identical to the demo protocol), speed = walkSpeed x sprintMul (sprinting with stamina) x encumbrance x wetness x
 * MoveSpeed buffs. Sprint stamina drain happens in vitalsSystem from PlayerIntent.moving/sprint. Movement is blocked
 * by edge walls/closed doors, solid cell pieces at the player's level and unwalkable terrain (per-axis slide).
 */
import { roadSpeedMul } from "../roads.js";
import { entityIndex, evaluate, Transform, type Entity, type World } from "@engine/core";
import { contractDisease, diseaseMoveMul } from "../diseases.js";
import { Anim, AnimState, DamageCause, Health, LootBag, Buffs, Dead, Driver, EdgeSide, Inventory, PlayerIntent, Stat, Survival, Wetness } from "../components.js";
import { gameplayDefs, isAuthority } from "../config.js";
import { skillMul } from "../skills/tree.js";
import { GameplayHoldBits as A, INPUT } from "../input_hooks.js";
import { isLCorner, rotParts, StructureIndexRes, type StructureIndex } from "../building/structure.js";
import type { PieceDef } from "../defs.js";
import { TerrainRes } from "../world.js";
import { WaterDepth, waterDepthAt, installSpatialIndex } from "@engine/world";
import { STANCE_ANIM, stanceAllowsSprint, stanceMode, stanceMoveMul } from "../stance.js";

/**
 * World-space (tile) move vector from screen-space input, |v| <= 1 (ADR-127). Screen axes sx (right +) / sy (down +)
 * come from the analog stick (moveX/moveY, clamped to magnitude 1, proportional below that) when it is past the
 * deadzone, else from the 4 digital bits (normalized, so diagonals are not faster). The screen->iso mapping is a pure
 * 45 deg rotation (dx = (sx + sy) / sqrt2, dy = (sy - sx) / sqrt2), so it preserves length: every one of the 8 key
 * directions is exactly 1 and a stick at magnitude m is exactly m. W = up-screen = -x -y.
 */
export function moveVector(actions: number, analog?: { x?: number | undefined; y?: number | undefined }): { dx: number; dy: number } {
  let sx: number, sy: number;
  const ax = analog?.x ?? 0, ay = analog?.y ?? 0;
  if (analog && (analog.x !== undefined || analog.y !== undefined) && Math.hypot(ax, ay) > INPUT.moveDeadzone) { sx = ax; sy = ay; }
  else { sx = (actions & A.MoveRight ? 1 : 0) - (actions & A.MoveLeft ? 1 : 0); sy = (actions & A.MoveDown ? 1 : 0) - (actions & A.MoveUp ? 1 : 0); }
  const l = Math.hypot(sx, sy); if (l > 1) { sx /= l; sy /= l; }
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return { dx: 0, dy: 0 };
  const k = Math.SQRT1_2; const dx = (sx + sy) * k, dy = (sy - sx) * k;
  return { dx: Math.abs(dx) < 1e-12 ? 0 : dx, dy: Math.abs(dy) < 1e-12 ? 0 : dy };
}
/** Unit iso direction from the 4 digital move bits (|v| = 1 in all 8 directions, 0 when idle / opposing). */
export function moveDirection(actions: number): { dx: number; dy: number } { return moveVector(actions); }

/** Current speed multiplier from sprint/encumbrance/wetness/buffs (tiles/s = walkSpeed x this). */
export function speedMultiplier(world: World, e: Entity, sprint: boolean): number {
  const mv = gameplayDefs(world).movement; let m = 1;
  if (sprint && stanceAllowsSprint(world, e) && (world.getField(e, Survival, "stamina") ?? 0) > 0) m *= mv.sprintMul;
  m *= stanceMoveMul(world, e); // ADR-244 block / aim / crouch / carry
  const max = (world.getField(e, Inventory, "maxWeight") ?? 0) * skillMul(world, e, "carry"); const w = world.getField(e, Inventory, "weight") ?? 0;
  if (max > 0) { const f = w / max; if (f > mv.encumberedFrom) m *= 1 - (1 - mv.encumberedMinMul) * Math.min(1, (f - mv.encumberedFrom) / (1 - mv.encumberedFrom)); }
  m *= 1 - mv.wetSlowMul * ((world.getField(e, Wetness, "level") ?? 0) / 255);
  m *= diseaseMoveMul(world, e); // Task 13: active diseases slow the carrier (replicated Diseases component)
  const t = world.get(e, Transform); if (t) m *= roadSpeedMul(world, t.x, t.y); // ADR-119 road surface bonus
  return evaluate(world, e, Buffs, Stat.MoveSpeed, m, world.simTick(e)); // ADR-191: server-frame expiry while predicting
}

/** Movement collision query (terrain, edge walls/doors, solid cells); vehicles reuse it per footprint corner. */
export function movementBlocked(world: World, x0: number, y0: number, x1: number, y1: number, level: number, swim = false, traveler?: Entity): boolean {
  const defs = gameplayDefs(world); const terrain = world.getResource(TerrainRes);
  const tx0 = Math.floor(x0), ty0 = Math.floor(y0), tx1 = Math.floor(x1), ty1 = Math.floor(y1);
  if (terrain) { const tile = terrain.tileAt(tx1, ty1); if (defs.worldgen.unwalkableTiles.has(tile) && !(swim && defs.movement.swimTiles.has(tile)) && waterDepthAt(terrain.tileAt, tx1, ty1, defs.movement.shallowRadius) !== WaterDepth.Shallow) return true; }
  if (level === 0 && terrainMoveBlocked(world, tx0, ty0, tx1, ty1, false, traveler)) return true;
  const idx = world.getResource(StructureIndexRes); if (!idx || idx.count === 0) return false;
  if (tx1 !== tx0 && idx.edgeBlocker(Math.max(tx0, tx1), ty0, level, EdgeSide.West)) return true;
  if (ty1 !== ty0 && idx.edgeBlocker(tx1, Math.max(ty0, ty1), level, EdgeSide.North)) return true;
  // ADR-210: vertex-snapped corner posts sit on the tile corner, so they do not block the whole tile
  if (tx1 !== tx0 || ty1 !== ty0) return solidCell(idx, tx1, ty1, level);
  return false;
}
// Task 29: reused scratch for solidCell's layer scan (single-threaded sim; solidCell is a leaf).
const SOLID_IDS: number[] = [];
export const solidCell = (idx: StructureIndex, tx: number, ty: number, level: number): boolean => {
  // Task 29: one chunk-layer resolution for layers 1..3 (grid.cellsIn) instead of a full at() per
  // layer — same checks, same order. Empty tiles (the common case) cost one cells.get trio.
  SOLID_IDS.length = 0; idx.grid.cellsIn(tx, ty, level, 1, 3, SOLID_IDS);
  for (const id of SOLID_IDS) {
    const c = idx.byGrid.get(id) ?? 0; if (!c) continue; const d = idx.def(c);
    // Task 14: an OPEN free-placement gate (garden gate, clan gate) is passable — its DoorState attachment says so.
    // Edge doors were already handled by edgeBlocker; this is the grid-cell half, which used to block open gates too.
    if (d?.solid && d.snap !== "vertex" && !(d.door && idx.doorOpen(c))) return true;
  }
  return false;
};

/**
 * ADR-212 body collision for walkers (players, AI humans: same function on the server and in client prediction).
 * The body is a square of half-size bodyRadius: one axis moves at a time; the leading face is tested against edge
 * walls / closed doors (at the centre and both sides, so a body cannot clip half-way into a wall end or squeeze
 * past a doorway jamb) and against solid cell pieces (stations, furniture, pillars...) it would newly overlap.
 * Terrain keeps the centre-point test (shorelines). Returns the allowed coordinate along the axis.
 */
export function bodyAxisMove(world: World, x: number, y: number, n: number, axis: 0 | 1, level: number, swim: boolean, radius?: number, traveler?: Entity): number {
  const nx = axis === 0 ? n : x, ny = axis === 0 ? y : n;
  if (movementBlocked(world, x, y, nx, ny, level, swim, traveler)) return axis === 0 ? x : y; // centre point (terrain + legacy rules)
  const idx = world.getResource(StructureIndexRes); if (!idx || idx.count === 0) return n;
  const r = radius ?? gameplayDefs(world).movement.bodyRadius; if (!(r > 0)) return n;
  const m = edgeAxisMove(idx, x, y, n, axis, level, r);
  return idx.vertexPosts > 0 ? postAxisMove(idx, x, y, m, axis, level, r) : m;
}
function edgeAxisMove(idx: StructureIndex, x: number, y: number, n: number, axis: 0 | 1, level: number, r: number): number {
  const cur = axis === 0 ? x : y, lat = axis === 0 ? y : x; const s = Math.sign(n - cur); if (!s) return n;
  const lead0 = cur + s * r, lead1 = n + s * r; const b0 = Math.floor(lead0), b1 = Math.floor(lead1);
  if (b0 === b1) return n;
  const k = r * 0.8; const side = axis === 0 ? EdgeSide.West : EdgeSide.North; const edgeT = Math.max(b0, b1);
  const inSolid = solidCell(idx, Math.floor(x), Math.floor(y), level); // escape hatch: never trap a body already inside a solid
  // a wall end perpendicular to the move inside the newly entered row/column (T-junction, doorway jamb) also blocks
  let perp = false; const pside = axis === 0 ? EdgeSide.North : EdgeSide.West;
  for (let bl = Math.floor(lat - r) + 1; bl <= Math.floor(lat + r) && !perp; bl++) perp = !!(axis === 0 ? idx.edgeBlocker(b1, bl, level, pside) : idx.edgeBlocker(bl, b1, level, pside));
  for (const l of perp ? [lat] : [lat - k, lat, lat + k]) {
    if (perp) { const stop = s > 0 ? edgeT - r - 1e-4 : edgeT + r + 1e-4; return s > 0 ? Math.max(cur, Math.min(n, stop)) : Math.min(cur, Math.max(n, stop)); }
    const lt = Math.floor(l);
    const blocked = (axis === 0 ? idx.edgeBlocker(edgeT, lt, level, side) : idx.edgeBlocker(lt, edgeT, level, side))
      || (!inSolid && (axis === 0 ? solidCell(idx, b1, lt, level) : solidCell(idx, lt, b1, level)));
    if (blocked) { const stop = s > 0 ? edgeT - r - 1e-4 : edgeT + r + 1e-4; return s > 0 ? Math.max(cur, Math.min(n, stop)) : Math.min(cur, Math.max(n, stop)); }
  }
  return n;
}

// ---- ADR-215 vertex corner posts ------------------------------------------------------------------------------
/** Half-size of the square post on a tile corner (placement keeps a +-0.15 creature box clear there too). */
export const POST_HALF = 0.15;
/** Inner-corner stub half-length: the stub reaches 0.19 along its arm (art 0.22), so a body walking through the middle of
 *  the neighbouring edge (0.5 - bodyRadius = 0.2 of clearance) never snags on it. */
export const STUB_HALF = 0.095;
/** Collision boxes [cx, cy, hx, hy] (tile units, world axes) of a free-standing vertex corner at (vx, vy):
 *  the post, plus for wall_corner_inner (4 steps) two short stubs along the art row's +x/+y arms, and for
 *  wall_corner_angled (8 steps) the 45 deg wall run (to 0.48, 0.48 diagonally) as a chain of overlapping boxes.
 *  Art row as the renderer picks it (pieceArtRow: rot % 4 for 4 steps, round(rot * 4 / steps) % 4 otherwise);
 *  a row turns the art (x, y) -> (-y, x). ADR-211 L corners are edges, not posts. */
export function cornerPostBoxes(def: PieceDef, rot: number, vx: number, vy: number, out: number[] = []): number[] {
  out.length = 0; out.push(vx, vy, POST_HALF, POST_HALF);
  const rp = rotParts(def, rot); const row = rp.steps === 4 ? ((rp.rot % 4) + 4) % 4 : ((Math.round((rp.rot * 4) / Math.max(1, rp.steps)) % 4) + 4) % 4;
  const turn = (ax: number, ay: number): [number, number] => { let a = ax, b = ay; for (let i = 0; i < row; i++) { const t = a; a = -b; b = t; } return [a, b]; };
  if (rp.steps === 8) {
    for (let k = 0; k < 4; k++) { const c = 0.06 + 0.12 * k; const [cx, cy] = turn(c, -c); out.push(vx + cx, vy + cy, 0.08, 0.08); }
  } else {
    for (const [ax, ay] of [[1, 0], [0, 1]] as const) { const [dx, dy] = turn(ax, ay); out.push(vx + dx * STUB_HALF, vy + dy * STUB_HALF, Math.abs(dx) * STUB_HALF + Math.abs(dy) * 0.05, Math.abs(dy) * STUB_HALF + Math.abs(dx) * 0.05); }
  }
  return out;
}
const POST_REACH = 0.6; const boxScratch: number[] = [];
/** Clamps a one-axis move against corner post boxes the body would newly overlap (a body already overlapping one is let out). */
function postAxisMove(idx: StructureIndex, x: number, y: number, n: number, axis: 0 | 1, level: number, r: number): number {
  const cur = axis === 0 ? x : y, lat = axis === 0 ? y : x; const s = Math.sign(n - cur); if (!s) return n;
  const a0 = Math.min(cur, n) - r - POST_REACH, a1 = Math.max(cur, n) + r + POST_REACH, l0 = lat - r - POST_REACH, l1 = lat + r + POST_REACH;
  let out = n;
  for (let va = Math.ceil(a0); va <= Math.floor(a1); va++) for (let vl = Math.ceil(l0); vl <= Math.floor(l1); vl++) {
    const vx = axis === 0 ? va : vl, vy = axis === 0 ? vl : va;
    const e = idx.cell(vx, vy, level, 3); if (!e) continue; const d = idx.def(e);
    if (!d || d.snap !== "vertex" || !d.solid || isLCorner(d)) continue;
    const b = cornerPostBoxes(d, idx.info.get(e)?.slot.rot ?? 0, vx, vy, boxScratch);
    for (let i = 0; i < b.length; i += 4) {
      const bA = axis === 0 ? b[i]! : b[i + 1]!, bL = axis === 0 ? b[i + 1]! : b[i]!, hA = axis === 0 ? b[i + 2]! : b[i + 3]!, hL = axis === 0 ? b[i + 3]! : b[i + 2]!;
      if (Math.abs(lat - bL) >= r + hL) continue; // no lateral overlap
      if (Math.abs(cur - bA) < r + hA - 1e-6) continue; // already overlapping: escape hatch
      const stop = s > 0 ? bA - hA - r - 1e-4 : bA + hA + r + 1e-4;
      if (s > 0 ? stop < cur - 1e-6 : stop > cur + 1e-6) continue; // box is behind the body
      out = s > 0 ? Math.max(cur, Math.min(out, stop)) : Math.min(cur, Math.max(out, stop));
    }
  }
  return out;
}

/** ADR-212: stand height above the level floor on (x, y): foundation decks (art top 12 px / zStep 16), ramps/steps half. */
export function standHeightAt(world: World, x: number, y: number, level: number): number {
  const idx = world.getResource(StructureIndexRes); const mv = gameplayDefs(world).movement;
  const base = level * gameplayDefs(world).building.levelHeight; if (!idx || idx.count === 0) return base;
  const tx = Math.floor(x), ty = Math.floor(y);
  const d = idx.deck(tx, ty, level); const dd = d ? idx.def(d) : undefined;
  if (dd && !dd.roof) return base + (dd.family === "foundation" ? mv.deckStandHeight : mv.floorStandHeight);
  for (const t of idx.trisInTile(tx, ty, level)) { const td = idx.def(t); if (td?.roof) continue; const tt = world.get(t, Transform); if (tt && Math.hypot(tt.x - x, tt.y - y) < 0.5) return base + (td?.family === "foundation" ? mv.deckStandHeight : mv.floorStandHeight); }
  const ramp = idx.cell(tx, ty, level, 1); const rd = ramp ? idx.def(ramp) : undefined;
  if (rd && rd.family === "foundation") return base + mv.deckStandHeight * 0.5;
  return base;
}
/** ADR-212: ease Transform.z toward the stand height (smooth step-up / step-down, stepRate z units per second). */
export function settleStandZ(world: World, e: Entity, dt: number): void {
  const t = world.get(e, Transform); if (!t) return;
  const lh = gameplayDefs(world).building.levelHeight; const level = Math.max(0, Math.round(t.z / lh));
  const target = standHeightAt(world, t.x, t.y, level); const z = t.z ?? 0; if (Math.abs(target - z) < 1e-4) return;
  const step = gameplayDefs(world).movement.stepRate * dt;
  world.set(e, Transform, { z: Math.abs(target - z) <= step ? target : z + Math.sign(target - z) * step });
}

/** Three tiles are safe; each extra tile costs 4 HP, with a gentle quadratic increase.
 * 4 / 6 / 10 / 14-tile falls cost 4 / 15 / 49 / 99 HP. Armor does not cushion gravity. */
export function terrainFallDamage(tiles: number): number {
  const extra = Math.max(0, tiles - 3); return extra * (extra + 7) / 2;
}
/** Ground height is rendered separately from Transform.z (the building floor). Apply each crossed face once,
 * on the authority only via applyDamage; a full-height ladder protects both ascent and descent. */
export function applyTerrainFall(world: World, e: Entity, x: number, y: number, nx: number, ny: number, dt = 1 / 20): void {
  if (!isAuthority(world) || world.isReplaying || world.has(e, Dead)) return;
  const terrain = world.getResource(TerrainRes); if (!terrain) return;
  let tx = Math.floor(x), ty = Math.floor(y); const ux = Math.floor(nx), uy = Math.floor(ny);
  const idx = world.getResource(StructureIndexRes);
  const cross = (bx: number, by: number): void => {
    if (!ladderBetween(idx, tx, ty, bx, by)) {
      const drop = shaftAwareHeight(world, terrain, tx, ty, e, bx, by) - shaftAwareHeight(world, terrain, bx, by, e, tx, ty);
      const damage = terrainFallDamage(drop);
      if (damage > 0) {
        const before = world.getField(e, Health, "hp") ?? 0;
        applyDamage(world, e, damage, 0 as Entity, DamageCause.Fall);
        const after = world.getField(e, Health, "hp") ?? 0;
        // The shared human input path serves players and AI humans. Lethal falls never injure corpses.
        if (drop >= 5 && after > 0 && after < before && world.has(e, Survival) && contractDisease(world, e, "broken_leg", dt)) {
          // ADR-281: only this actual surviving fracture event rolls infection, never a generic Broken Leg cure/source.
          const chance = gameplayDefs(world).diseaseTuning.causes.woundChance;
          if (chance > 0 && world.rngFor("disease.fall_wound", e).next() < chance) contractDisease(world, e, "wound_infection", dt);
        }
      }
    }
    tx = bx; ty = by;
  };
  while (tx !== ux) cross(tx + Math.sign(ux - tx), ty);
  while (ty !== uy) cross(tx, ty + Math.sign(uy - ty));
}

/** Applies one tick of movement input (server authority + client prediction). Writes PlayerIntent.moving/sprint. */
export function applyMovementInput(world: World, e: Entity, actions: number, dt: number, analog?: { x?: number | undefined; y?: number | undefined }): void {
  const t = world.get(e, Transform); if (!t) return;
  if (world.has(e, Driver)) {
    autoSprintReady(world, e, 0, 0, dt);
    if (world.has(e, PlayerIntent)) world.set(e, PlayerIntent, { moving: 0, sprint: 0 });
    return;
  } // riders move with their vehicle (gameplay.vehicles)
  const dead = world.has(e, Dead);
  const { dx, dy } = dead ? { dx: 0, dy: 0 } : moveVector(actions, analog);
  const moving = dx || dy ? 1 : 0; const ready = autoSprintReady(world, e, dx, dy, dt);
  const sprint = ready && (world.getField(e, Survival, "stamina") ?? 0) > 0 && stanceAllowsSprint(world, e) && !(t.z < 0.5 && inDeepWater(world, t.x, t.y)) ? 1 : 0; // ADR-181: no sprint while swimming
  // ADR-147: PlayerIntent is not networked, so a client replica has none and its predicted vitals never drained sprint
  // stamina (the replica's stamina lagged the server by the snapshot delay, sprint ended a tick apart: a rubber-band).
  // The predicting client keeps a local PlayerIntent on its own entity so movement + vitals replay like the server.
  if (!world.has(e, PlayerIntent) && world.predicted.has(e)) world.add(e, PlayerIntent);
  if (world.has(e, PlayerIntent)) {
    const st = world.store(PlayerIntent); const i = entityIndex(e); const s = st.slot(i);
    if (st.data.moving[s] !== moving || st.data.sprint[s] !== sprint) { st.data.moving[s] = moving; st.data.sprint[s] = sprint; st.markChanged(i); }
  }
  if (moving) {
    const level = Math.max(0, Math.round(t.z / gameplayDefs(world).building.levelHeight));
    const swim = level === 0; // ground level only: no swimming off a deck
    const sp = gameplayDefs(world).movement.walkSpeed * speedMultiplier(world, e, sprint === 1) * (swim ? swimSpeedMulAt(world, t.x, t.y) : 1) * dt;
    let x = t.x, y = t.y;
    x = bodyAxisMove(world, x, y, x + dx * sp, 0, level, swim, undefined, e);
    if (level === 0) applyTerrainFall(world, e, t.x, t.y, x, y, dt);
    const beforeY = y;
    y = bodyAxisMove(world, x, y, y + dy * sp, 1, level, swim, undefined, e);
    if (level === 0) applyTerrainFall(world, e, x, beforeY, x, y, dt);
    // ADR-212 doorway assist: pushing straight into a wall beside an opening slides the body toward the opening's centre
    const assistX = x, assistY = y;
    if (x === t.x && dx && !dy) y = doorAssist(world, x, y, dx, 0, sp, level, swim, e);
    else if (y === t.y && dy && !dx) x = doorAssist(world, x, y, dy, 1, sp, level, swim, e);
    if (level === 0) applyTerrainFall(world, e, assistX, assistY, x, y, dt);
    // ADR-305: turn toward the move even when a wall or ledge blocks the step, and never reset facing on idle.
    const nextFacing = turnFacing(t.facing ?? 0, Math.atan2(dy, dx), dt);
    if (x !== t.x || y !== t.y) {
      world.set(e, Transform, { x, y, facing: nextFacing });
      updateShaftOccupancy(world, e, t.x, t.y, x, y);
    } else world.set(e, Transform, { facing: nextFacing });
  }
  settleStandZ(world, e, dt); // ADR-212: decks are walked on at deck-top height
}
/** Lateral nudge (up to `sp`) toward the centre of the neighbouring row whose centre line is free along `axis`. */
function doorAssist(world: World, x: number, y: number, d: number, axis: 0 | 1, sp: number, level: number, swim: boolean, traveler?: Entity): number {
  const lat = axis === 0 ? y : x; const c = Math.floor(lat) + 0.5; if (Math.abs(c - lat) < 1e-6) return lat;
  const probe = Math.sign(d) * (gameplayDefs(world).movement.bodyRadius + sp + 0.05);
  const free = axis === 0 ? bodyAxisMove(world, x, c, x + probe, 0, level, swim, undefined, traveler) !== x : bodyAxisMove(world, c, y, y + probe, 1, level, swim, undefined, traveler) !== y;
  if (!free) return lat;
  const nl = lat + Math.sign(c - lat) * Math.min(sp, Math.abs(c - lat));
  return bodyAxisMove(world, axis === 0 ? x : lat, axis === 0 ? lat : y, nl, axis === 0 ? 1 : 0, level, swim, undefined, traveler);
}

/** Player turn rate (rad/s): facing eases toward the move direction instead of snapping to it in one tick, so
 * turning while walking looks smooth. Position still moves in the input direction at full speed at once (responsive);
 * only the sprite's facing lags, at most ~0.16 s for a 90° turn. */
export const PLAYER_TURN_RATE = 10;
/** Wrap a world facing into (-π, π] so 8-bit net quantization does not clamp a spun-around angle. */
export function normalizeFacing(a: number): number {
  const x = ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return x === -Math.PI ? Math.PI : x;
}
/**
 * ADR-305: visual facing while moving stays `curFacing` (the sim heading, so walk frames keep matching
 * prediction). When the body stops, keep `last` travel heading instead of a stored pose that can snap
 * to north. A zero delta does not clear `last`.
 */
export function facingAfterTravel(curFacing: number, dx: number, dy: number, last?: number): { facing: number; last: number | undefined } {
  if (dx * dx + dy * dy > 1e-6) return { facing: curFacing, last: Math.atan2(dy, dx) };
  return { facing: last ?? curFacing, last };
}
/** Facing after `dt` seconds of turning from `cur` toward `target`, at most PLAYER_TURN_RATE rad/s, shortest way round. */
export function turnFacing(cur: number, target: number, dt: number): number {
  let d = (target - cur) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
  const step = PLAYER_TURN_RATE * dt;
  return normalizeFacing(cur + Math.max(-step, Math.min(step, d)));
}
export function walkAnimRate(world: World): number { const mv = gameplayDefs(world).movement; return mv.walkAnimRefSpeed > 0 ? mv.walkSpeed / mv.walkAnimRefSpeed : 1; }

// ---- swimming (ADR-107) -------------------------------------------------------------------------------------
/** True when (x, y) is on a swim tile (movement.json swimTiles). */
export function inWater(world: World, x: number, y: number): boolean {
  const terrain = world.getResource(TerrainRes); if (!terrain) return false;
  return gameplayDefs(world).movement.swimTiles.has(terrain.tileAt(Math.floor(x), Math.floor(y)));
}
/** ADR-181: 0 land, 1 shallow (wade), 2 deep (swim) at (x, y). Same function the renderers use. */
export function waterDepth(world: World, x: number, y: number): WaterDepth {
  const terrain = world.getResource(TerrainRes); if (!terrain) return WaterDepth.None;
  return waterDepthAt(terrain.tileAt, Math.floor(x), Math.floor(y), gameplayDefs(world).movement.shallowRadius);
}
export function inDeepWater(world: World, x: number, y: number): boolean { return waterDepth(world, x, y) === WaterDepth.Deep; }
/** Speed multiplier at (x, y): swimSpeedMul in deep water, wadeSpeedMul in shallow, else 1 (players, zombies, animals). */
export function swimSpeedMulAt(world: World, x: number, y: number): number {
  const d = waterDepth(world, x, y); const mv = gameplayDefs(world).movement;
  return d === WaterDepth.Deep ? mv.swimSpeedMul : d === WaterDepth.Shallow ? mv.wadeSpeedMul : 1;
}
/** ADR-181: terrain blocks non-swimmers (AI pathing, zombies, hordes) at tile (tx, ty): unwalkable tiles except shallow water. */
export function terrainBlocksWalker(world: World, tx: number, ty: number): boolean {
  const terrain = world.getResource(TerrainRes); if (!terrain) return false; const defs = gameplayDefs(world);
  return defs.worldgen.unwalkableTiles.has(terrain.tileAt(tx, ty)) && waterDepthAt(terrain.tileAt, tx, ty, defs.movement.shallowRadius) !== WaterDepth.Shallow;
}

const SWIM_OVER: ReadonlySet<number> = new Set([Anim.Idle, Anim.Walk, Anim.Run, Anim.Shamble, Anim.Crawl, Anim.Graze, Anim.Sit]);
/** One-shot anims on players (Punch/Attack/Hurt/Gather/Build) settle back to Idle after this many ticks (players have no AI to reset them). */
export const PLAYER_ONE_SHOT_TICKS = 8;
/** ADR-151: Punch/Attack settle sooner so the swing fits the fastest melee cooldown (0.3 s = 6 ticks). */
export const PLAYER_SWING_TICKS = 6;
const ONE_SHOT: ReadonlySet<number> = new Set([Anim.Attack, Anim.Punch, Anim.Hurt, Anim.Gather, Anim.Build, Anim.Eat, Anim.Harvest, Anim.Chop, Anim.Mine, Anim.Drink, Anim.BlockHit]);
/**
 * gameplay.animSettle (authority, ADR-107): locomotion anims become Swim on a swim tile at ground level and Swim reverts
 * to Idle on land; players' one-shot anims revert to Idle after PLAYER_ONE_SHOT_TICKS.
 */
export function animSettleSystem(world: World): void {
  const terrain = world.getResource(TerrainRes);
  // Task 29: store-direct reads — the old world.get() copies (AnimState + Transform per entity per
  // tick) were the whole cost of this loop. ONE_SHOT is checked before the Survival store lookup
  // (most entities are not mid-one-shot), and the water depth is computed inline with the hoisted
  // shallow radius instead of via inDeepWater's per-call getResource/gameplayDefs.
  const tfStore = world.store(Transform); const anStore = world.store(AnimState);
  // Task 29: Survival is only consulted for entities mid-one-shot; in a world where it is not
  // registered no entity can have it, so the check is simply false (the old code threw here instead).
  const svStore = world.isRegistered(Survival) ? world.store(Survival) : undefined;
  const shallowR = terrain ? gameplayDefs(world).movement.shallowRadius : 0;
  for (const e of world.query([AnimState, Transform], [Dead])) {
    const ei = entityIndex(e); const ts = tfStore.slot(ei); const ans = anStore.slot(ei);
    const x = tfStore.data.x[ts]!, y = tfStore.data.y[ts]!, z = tfStore.data.z[ts]!;
    let cur = anStore.data.anim[ans]!;
    if (ONE_SHOT.has(cur) && svStore?.has(ei) && world.tick - anStore.data.startTick[ans]! >= (cur === Anim.Attack || cur === Anim.Punch ? PLAYER_SWING_TICKS : PLAYER_ONE_SHOT_TICKS)) { cur = STANCE_ANIM[stanceMode(world, e)] ?? Anim.Idle; world.set(e, AnimState, { anim: cur, startTick: world.tick }); } // ADR-244: back to the held stance
    if (!terrain) continue;
    const wet = z < 0.5 && waterDepthAt(terrain.tileAt, Math.floor(x), Math.floor(y), shallowR) === WaterDepth.Deep; // ADR-181: wading keeps walk anims
    if (wet && SWIM_OVER.has(cur)) world.set(e, AnimState, { anim: Anim.Swim, startTick: world.tick });
    else if (!wet && cur === Anim.Swim) world.set(e, AnimState, { anim: Anim.Idle, startTick: world.tick });
  }
  floatLootAshore(world);
}

/** ADR-181: dropped loot bags float: in deep water they drift (1 tile/s) to the nearest wadeable/land tile within
 * FLOAT_SEARCH tiles so items stay reachable without swimming; with no shore in range they stay afloat where they fell. */
const FLOAT_SEARCH = 8;
export function floatLootAshore(world: World): void {
  if (world.tick % 10 !== 0 || !world.getResource(TerrainRes) || !world.isRegistered(LootBag)) return;
  for (const e of world.query([LootBag, Transform])) {
    const t = world.get(e, Transform)!; if ((t.z ?? 0) >= 0.5 || !inDeepWater(world, t.x, t.y)) continue;
    const tx = Math.floor(t.x), ty = Math.floor(t.y); let best: [number, number] | undefined; let bd = Infinity;
    for (let r = 1; r <= FLOAT_SEARCH && !best; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; const x = tx + dx + 0.5, y = ty + dy + 0.5;
      if (!inDeepWater(world, x, y)) { const d = Math.hypot(x - t.x, y - t.y); if (d < bd) { bd = d; best = [x, y]; } }
    }
    if (!best) continue; const k = Math.min(1, 0.5 / bd);
    const x = t.x + (best[0] - t.x) * k, y = t.y + (best[1] - t.y) * k;
    world.set(e, Transform, { x, y }); installSpatialIndex(world).hash.insert(e, x, y);
  }
}
