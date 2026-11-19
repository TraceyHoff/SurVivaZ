/**
 * ADR-178: the client replica's terrain lookup over replicated tiles, so prediction runs the same swim speed /
 * water collision as the server (which reads ChunkManager via TerrainRes). Tiles not yet replicated read 0 (land).
 */
import { terrainFromTileMap, type Terrain } from "@engine/gameplay";
import type { TileMap } from "@engine/world";

export function replicaTerrain(tiles: () => TileMap | undefined): Terrain {
  const cache = new WeakMap<TileMap, Terrain>();
  const of = (): Terrain | undefined => { const m = tiles(); if (!m) return undefined; let t = cache.get(m); if (!t) cache.set(m, (t = terrainFromTileMap(m))); return t; };
  // ADR-439: forward the raw stored height too — the ledge warning needs it to tell natural water
  // (surface 0) from flowed water (its own level) when measuring a drop onto water.
  return { tileAt: (x, y) => of()?.tileAt(x, y) ?? 0, heightAt: (x, y) => of()?.heightAt(x, y) ?? 0, rawHeightAt: (x, y) => of()?.rawHeightAt?.(x, y) ?? 0 };
}
