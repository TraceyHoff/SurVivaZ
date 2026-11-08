/** ADR-265: full-height, bidirectional terrain-face connections. Rendering never changes sim floor levels. */
import type { Entity, World } from "@engine/core";
import { EdgeSide } from "../components.js";
import { StructureIndexRes, type StructureIndex } from "./structure.js";
import { TerrainRes, type Terrain } from "../world.js";
import { shaftAwareHeight } from "./terrain-hatch.js";

export function ladderBetween(idx: StructureIndex | undefined, x: number, y: number, nx: number, ny: number): boolean {
  if (!idx || Math.abs(nx - x) + Math.abs(ny - y) !== 1) return false;
  return !!(nx !== x ? idx.ladder(Math.max(x, nx), y, EdgeSide.West) : idx.ladder(x, Math.max(y, ny), EdgeSide.North));
}
/** A ladder spans the entire step, including a 25-level pit. Diagonal shortcuts cannot bypass a face. */
export const MAX_UNAIDED_CLIMB = 3;

export function terrainStepBlocked(terrain: Terrain | undefined, idx: StructureIndex | undefined, x: number, y: number, nx: number, ny: number, _world = idx?.world, traveler?: Entity): boolean {
  if (!terrain || (x === nx && y === ny)) return false;
  const world = _world ?? idx?.world;
  const fromH = shaftAwareHeight(world, terrain, x, y, traveler, nx, ny);
  const toH = shaftAwareHeight(world, terrain, nx, ny, traveler, x, y);
  // Descents are allowed (and hurt on landing); only upward faces require climbing.
  if (toH - fromH <= MAX_UNAIDED_CLIMB) return false;
  return !ladderBetween(idx, x, y, nx, ny);
}
export function terrainMoveBlocked(world: World, x: number, y: number, nx: number, ny: number, avoidFalls = false, traveler?: Entity): boolean {
  const terrain = world.getResource(TerrainRes), idx = world.getResource(StructureIndexRes);
  const blocked = (ax: number, ay: number, bx: number, by: number): boolean =>
    terrainStepBlocked(terrain, idx, ax, ay, bx, by, world, traveler) || !!(avoidFalls && terrain && shaftAwareHeight(world, terrain, ax, ay, traveler, bx, by) - shaftAwareHeight(world, terrain, bx, by, traveler, ax, ay) > MAX_UNAIDED_CLIMB && !ladderBetween(idx, ax, ay, bx, by));
  // Walk every crossed face, including long/low-rate input frames. Match per-axis body movement.
  for (let xx = x; xx !== nx;) { const next = xx + Math.sign(nx - xx); if (blocked(xx, y, next, y)) return true; xx = next; }
  for (let yy = y; yy !== ny;) { const next = yy + Math.sign(ny - yy); if (blocked(nx, yy, nx, next)) return true; yy = next; }
  return false;
}
