/**
 * ADR-263 (Task 36) leaf module (no gameplay imports beyond components, so environment / farming / lights can use it
 * without ESM cycles): TerrainEdit tile index and underground depth.
 */
import { Transform, type Entity, type World } from "@engine/core";
import { worldTileKey, worldTileFromKey } from "@engine/world";
import { TerrainEdit } from "./components.js";

/** ADR-411: absolute terrain level bounds. ADR-529: the bounds are exactly ±100 total (user decision
 * 2026-11-24: the shovel matches the range; the raise to ±250 comes later, once ±100 is proven) — the
 * ceiling is the range itself, NOT generated ground + range. Shovel edits clamp to these absolute bounds:
 * from generated ground g you can raise at most 100−g and dig at most g+100. Raising to ±250 later is a
 * single-knob change to TERRAIN_EDIT_RANGE (plus HEIGHT_MAX in ADR-530's successor). */
export const TERRAIN_EDIT_RANGE = 100;

export const TERRAIN = {
  /** ADR-411: absolute terrain levels, relative to the world height-zero datum. Shovel edits clamp to
   *  [-TERRAIN_EDIT_RANGE, +TERRAIN_EDIT_RANGE] = [-100, 100] (ADR-529: was [-300, 326] via the additive
   *  HEIGHT_MAX + range formula — that formula is gone; generated ground spans [0, HEIGHT_MAX] but the
   *  ceiling is absolute, so ground at 26 can rise only 74).
   *  (ADR-297's bounds were -60..75.) */
  minLevel: -TERRAIN_EDIT_RANGE, maxLevel: TERRAIN_EDIT_RANGE,
  /** Reach (tiles from the body centre to the target tile centre). */ reach: 3,
  /** Dug this many levels below ground (or more) = underground. */ undergroundDepth: 3,
  /** Underground air temperature (60°F). */ undergroundTempC: (60 - 32) * 5 / 9,
  /** Flow step period (ticks) and max tiles flooded per step (bounded cost). */ flowEveryTicks: 8, flowPerStep: 64,
  /** Re-seed the flow frontier from dug tiles every this many ticks (after a restart / chunk reload). */ reseedEveryTicks: 200,
  /** Tile id for freshly dug / piled earth (render TileId.Dirt). */ earthTile: 4,
} as const;

/** Absolute level bounds (flowing-water height encoding range, ADR-263 waterDepth.ts; ADR-411: -300..326; ADR-529: -100..100 — the flow-water cap now equals the land ceiling). */
export const LEVEL_MIN = TERRAIN.minLevel, LEVEL_MAX = TERRAIN.maxLevel;
interface EditIdx { tiles: Map<number, Entity>; size: number; tick: number }
const idxCache = new WeakMap<World, EditIdx>();
export const tkey = worldTileKey;
export const untkey = worldTileFromKey;
export function editIndex(world: World): EditIdx {
  if (!world.isRegistered(TerrainEdit)) return { tiles: new Map(), size: 0, tick: 0 };
  const st = world.store(TerrainEdit); let c = idxCache.get(world);
  if (c && c.size === st.size && (c.tick === world.tick || world.tick - c.tick < 20)) return c;
  const tiles = new Map<number, Entity>();
  for (const e of world.query([TerrainEdit, Transform])) { const t = world.get(e, Transform)!; tiles.set(tkey(Math.floor(t.x), Math.floor(t.y)), e); }
  c = { tiles, size: st.size, tick: world.tick }; idxCache.set(world, c); return c;
}
export function invalidateTerrainIndex(world: World): void { idxCache.delete(world); }
export function editAt(world: World, tx: number, ty: number): Entity | undefined {
  const e = editIndex(world).tiles.get(tkey(Math.floor(tx), Math.floor(ty)));
  return e !== undefined && world.isAlive(e) && world.has(e, TerrainEdit) ? e : undefined;
}
/** Levels the tile at (x,y) was raised (+) or dug (-) relative to its generated ground (0 = untouched). */
export function terrainDigAt(world: World, x: number, y: number): number {
  const e = editAt(world, x, y); return e === undefined ? 0 : world.getField(e, TerrainEdit, "dig") ?? 0;
}
/** How many levels below the generated ground (x,y) lies (0 at or above ground). */
export function undergroundDepthAt(world: World, x: number, y: number): number { return Math.max(0, -terrainDigAt(world, x, y)); }
/** True when (x,y) is underground (dug >= TERRAIN.undergroundDepth levels below ground). */
export function isUnderground(world: World, x: number, y: number): boolean { return undergroundDepthAt(world, x, y) >= TERRAIN.undergroundDepth; }

