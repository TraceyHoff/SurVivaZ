/**
 * ADR-372 stairs and second-floor access.
 *
 * What was already there: abandoned two-story kinds stamp a `stairs` piece (layer 1, not solid) on a
 * foundation deck plus a `floor_stairwell` hole in the level-1 floor above it — but nothing ever moved an
 * entity between levels on them, so the upper floors were unreachable.
 *
 * How traversal works now (no new state, no input, no per-tick scan): a stairs piece underfoot is a ramp.
 * `standHeightAt` (systems/movement.ts) asks `stairRampHeight` first: when the tile holds a stairs piece at
 * the entity's level and a landing exists one level up (the stairwell tile itself, or the adjacent tile past
 * the top edge, e.g. an outside balcony), the stand height is `level * levelHeight + frac * levelHeight`,
 * where frac is the entity's progress across the tile toward the top edge. Walking up the tile raises z at
 * the existing stepRate (6 z/s); walking back down lowers it; `settleStandZ` eases both ways, so stopping
 * mid-flight, turning back, or stepping off sideways settles onto the nearest level instead of sticking.
 * The same rule in reverse (stairs piece one level below + a landing at this level) is the way down: an
 * entity at level 1 standing on the stairwell tile descends as it walks back across it. Because the ramp
 * lives in `standHeightAt`, every mover that settles — players and AI humans through `applyMovementInput`,
 * creatures through `creatureStep`, zombies through their step — climbs the same way, and keyboard, gamepad
 * and touch all work by walking, with no button and no UI.
 *
 * Pathfinding: `stairLinkUp` / `stairLinkDown` are the O(1) local-tile predicates the level-aware
 * pathfinders use (combat/path.ts `findPath`, systems/creature_nav.ts `route`): a stair tile links its
 * level to the one above / below when the landing exists. No new pathfinder, no scan over all pieces.
 */
import type { Entity, World } from "@engine/core";
import { gameplayDefs } from "../config.js";
import { LAYER_STRUCT, type StructureIndex } from "./structure.js";
import { STAIRS_DATA, type StairsData } from "./stairs_data.js";
export { STAIRS_DATA, type StairsData };

/** True when an abandoned kind key gets an outside stair run (data/stairs.json `exteriorKinds`). */
export const exteriorStairsFor = (kindKey: string): boolean => STAIRS_DATA.exteriorKinds.includes(kindKey);

/**
 * Up direction of a stairs piece with rotation `rot`: the data `upDir` (rot 0) rotated by the same basis
 * `rotPoint` rotates site layouts (rot 1: (x, y) -> (-y, x), i.e. north -> east -> south -> west).
 */
export function stairUpDir(rot: number): [number, number] {
  const [ux, uy] = STAIRS_DATA.upDir;
  switch (((rot % 4) + 4) % 4) {
    case 1: return [-uy, ux];
    case 2: return [-ux, -uy];
    case 3: return [uy, -ux];
    default: return [ux, uy];
  }
}

/** The `stairs` piece (layer 1) at tile (tx, ty, level), or 0. */
export function stairPieceAt(idx: StructureIndex, tx: number, ty: number, level: number): Entity | 0 {
  const e = idx.cell(tx, ty, level, LAYER_STRUCT);
  return e && idx.def(e)?.key === "stairs" ? e : 0;
}

/** Rotation of an indexed stairs piece (0 when unindexed). */
export const stairRot = (idx: StructureIndex, e: Entity): number => idx.info.get(e)?.slot.rot ?? 0;

/** Progress 0..1 across tile (tx, ty) toward `dir` (0 at the low edge, 1 at the high edge). */
export function stairRampFrac(x: number, y: number, tx: number, ty: number, dir: readonly [number, number]): number {
  const f = 0.5 + (x - (tx + 0.5)) * dir[0]! + (y - (ty + 0.5)) * dir[1]!;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/**
 * True when a landing exists at `level` for a stair run on tile (tx, ty) whose top edge faces `dir`:
 * a non-roof deck on the stair tile itself (the `floor_stairwell` hole) or on the tile past the top edge
 * (an outside balcony). Only local-tile lookups.
 */
export function stairLandingAt(idx: StructureIndex, tx: number, ty: number, level: number, dir: readonly [number, number]): boolean {
  return idx.isDeck(idx.deck(tx, ty, level)) || idx.isDeck(idx.deck(tx + dir[0]!, ty + dir[1]!, level));
}

/** True when tile (tx, ty) links `level` up to `level + 1` (stairs here + a landing above). */
export function stairLinkUp(idx: StructureIndex, tx: number, ty: number, level: number): boolean {
  const e = stairPieceAt(idx, tx, ty, level);
  return e !== 0 && stairLandingAt(idx, tx, ty, level + 1, stairUpDir(stairRot(idx, e)));
}

/** True when tile (tx, ty) links `level` down to `level - 1` (stairs below + a landing here). */
export function stairLinkDown(idx: StructureIndex, tx: number, ty: number, level: number): boolean {
  if (level <= 0) return false;
  const e = stairPieceAt(idx, tx, ty, level - 1);
  return e !== 0 && stairLandingAt(idx, tx, ty, level, stairUpDir(stairRot(idx, e)));
}

/**
 * Stand height on a stair ramp tile, or undefined when this tile is not a ramp at `level`.
 * `structEnt` / `structDefKey` are the layer-1 cell at (tx, ty, level) the caller already fetched for the
 * foundation ramp, so the common (no-stairs) case costs no extra grid lookup; the below-stairs lookup
 * only runs above ground level. Up: stairs at this level, landing above. Down: stairs one level below,
 * landing at this level. Either way the height is `baseLevel * levelHeight + frac * levelHeight`, so it
 * is continuous across the `round(z / levelHeight)` level flip halfway up.
 */
export function stairRampHeight(
  world: World, idx: StructureIndex, x: number, y: number, tx: number, ty: number, level: number,
  structEnt: Entity | 0, structDefKey: string | undefined,
): number | undefined {
  const lh = gameplayDefs(world).building.levelHeight;
  if (structEnt && structDefKey === "stairs") {
    const dir = stairUpDir(stairRot(idx, structEnt));
    if (!stairLandingAt(idx, tx, ty, level + 1, dir)) return undefined;
    return level * lh + stairRampFrac(x, y, tx, ty, dir) * lh;
  }
  if (level > 0) {
    const below = stairPieceAt(idx, tx, ty, level - 1);
    if (below) {
      const dir = stairUpDir(stairRot(idx, below));
      if (!stairLandingAt(idx, tx, ty, level, dir)) return undefined;
      return (level - 1) * lh + stairRampFrac(x, y, tx, ty, dir) * lh;
    }
  }
  return undefined;
}
