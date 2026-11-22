/**
 * ADR-514: saves written before ADR-511 (6860324d, the 80 px floor flip) store Transform.z in 3-level floors; the floor is
 * 5 levels now (`building.levelHeight`). A player who logged out on the 2nd floor (z 6.31) came back at level round(6.31/5)
 * = 1 and eased down onto the 1st floor; bags / AI humans / animals upstairs sank into the storey below.
 *
 * Saves carry no wall-clock time, so a legacy record is re-seated by its stand height: z = floor * levels + one of the
 * stand offsets (ground 0, floor deck 0.3125, foundation ramp 0.375, foundation deck 0.75). A z that already sits on a
 * 5-level floor is kept; one that only sits on a 3-level floor (>= the 1st) moves to the same floor index on the 5-level
 * grid. When the structures under it are loaded, the move must land on a deck (and is skipped when it would leave one).
 * Anything in between (mid-stairs, mid-fall) is left to the normal stand-height settle. Building pieces store their floor
 * index, not z, and are unaffected.
 */
import { Transform, type Entity, type World } from "@engine/core";
import { chunkKeyOf } from "@engine/world";
import { gameplayDefs } from "../config.js";
import { StructureIndexRes } from "./structure.js";

/** Terrain levels per floor before ADR-511. */
export const LEGACY_FLOOR_LEVELS = 3;
const STAND_OFFSETS = [0, 0.3125, 0.375, 0.75];
const onStand = (r: number): boolean => STAND_OFFSETS.some((o) => Math.abs(r - o) < 0.02);
/** Floor index whose stand heights include z on a grid of `lh` levels per floor, or -1. */
export function standFloor(z: number, lh: number): number { const f = Math.floor((z + 0.02) / lh); return f >= 0 && onStand(z - f * lh) ? f : -1; }

/** The z a legacy (3-level floor) record should load at, or undefined to keep it. Pure apart from the optional deck probe. */
export function legacyFloorZ(z: number, lh: number, maxLevel: number, deckAt?: (floor: number) => boolean | undefined): number | undefined {
  if (lh === LEGACY_FLOOR_LEVELS || !(z > 1)) return undefined; // ground level reads the same on both grids
  const now = standFloor(z, lh), old = standFloor(z, LEGACY_FLOOR_LEVELS);
  if (old < 1 || old > maxLevel) return undefined;
  if (now >= 0) { // both grids fit (z = 15 + offset): keep it unless only the 3-level reading has a deck under it
    if (!deckAt || deckAt(now) !== false || deckAt(old) !== true) return undefined;
  } else if (deckAt && deckAt(old) === false) return undefined; // structures loaded and nothing to stand on there
  return z + old * (lh - LEGACY_FLOOR_LEVELS);
}

/** Re-seat one loaded entity saved before the floor stamp. True when its z changed. */
export function fixLegacyFloorZ(world: World, e: Entity): boolean {
  const t = world.get(e, Transform); if (!t) return false;
  const b = gameplayDefs(world).building; const idx = world.getResource(StructureIndexRes);
  const tx = Math.floor(t.x), ty = Math.floor(t.y);
  // the deck probe only answers when the chunk's structures are in the index (a player restores before its chunk loads)
  const loaded = !!idx && !!idx.chunkPieces.get(chunkKeyOf(t.x, t.y))?.size;
  const deckAt = loaded ? (f: number): boolean => idx!.deck(tx, ty, f) !== 0 : undefined;
  const z = legacyFloorZ(t.z ?? 0, b.levelHeight, b.maxLevel, deckAt); if (z === undefined) return false;
  world.set(e, Transform, { z }); return true;
}
