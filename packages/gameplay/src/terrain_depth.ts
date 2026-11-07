/**
 * ADR-263 (Task 36) leaf module (no gameplay imports beyond components, so environment / farming / lights can use it
 * without ESM cycles): TerrainEdit tile index and underground depth.
 */
import { Transform, type Entity, type World } from "@engine/core";
import { worldTileKey, worldTileFromKey } from "@engine/world";
import { TerrainEdit } from "./components.js";

export const TERRAIN = {
  /** ADR-297: absolute terrain levels, relative to the world height-zero datum. */ minLevel: -60, maxLevel: 75,
  /** Reach (tiles from the body centre to the target tile centre). */ reach: 3,
  /** Dug this many levels below ground (or more) = underground. */ undergroundDepth: 3,
  /** Underground air temperature (60°F). */ undergroundTempC: (60 - 32) * 5 / 9,
  /** Flow step period (ticks) and max tiles flooded per step (bounded cost). */ flowEveryTicks: 8, flowPerStep: 64,
  /** Re-seed the flow frontier from dug tiles every this many ticks (after a restart / chunk reload). */ reseedEveryTicks: 200,
  /** Tile id for freshly dug / piled earth (render TileId.Dirt). */ earthTile: 4,
} as const;

/** Absolute level bounds (flowing-water height encoding range, ADR-263 waterDepth.ts). */
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

