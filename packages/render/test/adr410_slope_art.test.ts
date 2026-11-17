/**
 * ADR-410: the renderer draws the painted slope art — end to end through the REAL TileTerrain chunk
 * builder with the REAL merged registry: a ramp tile's base instance is the slope sprite (not the flat
 * base), a wedge tile picks its wedge key, and a flat tile keeps the flat base. (ADR-409 proved the
 * swap logic with a fake GroundArt; this proves the shipped art resolves through it.)
 */
import { describe, expect, it, beforeAll } from "vitest";
import { loadMergedPackManifest } from "@engine/assets/node";
import { TileMap, tileToLocal } from "@engine/world";
import { TileTerrain, viewCellToTile } from "../src/terrainTiles.js";
import { GroundArt } from "../src/groundArt.js";
import type { AtlasManager } from "../src/assets/atlasManager.js";

let g: GroundArt;
beforeAll(async () => {
  const { result } = await loadMergedPackManifest();
  g = new GroundArt(result.registry as unknown as {
    ids: { sprites: { tryId(k: string): number | undefined } };
    sprite(id: number): { key: string; atlas: { key: string } };
  });
});

/** Run the REAL TileTerrain chunk builder, capture its GPU upload (16 floats per instance). */
function buildTerrain(map: TileMap, wx: number, wy: number, q: number, art: number, seenKeys: string[] = []): Float32Array {
  let uploaded = new Float32Array();
  const gl = {
    createVertexArray: () => ({}), createBuffer: () => ({}), bindVertexArray: () => {}, bindBuffer: () => {},
    bufferData: (_t: unknown, data: Float32Array<ArrayBuffer>) => { uploaded = data; },
    enableVertexAttribArray: () => {}, vertexAttribPointer: () => {}, vertexAttribDivisor: () => {},
  };
  const ground = { id: (k: string): number => { seenKeys.push(k); return g.id(k); } };
  const terrain = Object.assign(Object.create(TileTerrain.prototype), { gl, builds: 0, grazedRev: 0, ground: () => ground });
  const atlas = { registry: { ids: { sprites: { tryId: () => 1 } } }, animEntries: (id: number) => ({ first: id, count: 1, fps: 0, ax: 34, ay: 18 }), version: 0 } as unknown as AtlasManager;
  terrain.build(map, map.getChunk(Math.floor(wx / 32), Math.floor(wy / 32)), atlas, undefined, art, q);
  return uploaded;
}
/** Instances (16-float rows) for one view cell. Row: [x, y, z, first, count, fps, mask, 0, ax, ay, water, mode, d0, d1, d2, d3]. */
const rowsAt = (up: Float32Array, cx: number, cy: number): number[][] => {
  const out: number[][] = [];
  for (let i = 0; i < up.length; i += 16) if (up[i] === cx + 0.5 && up[i + 1] === cy + 0.5) out.push([...up.slice(i, i + 16)]);
  return out;
};
/** Fill the 3x3 view-space neighbourhood of view cell (0,0) with dirt at height 5, except `low` overrides. */
function fillView(map: TileMap, q: number, low: Record<string, number>): { x: number; y: number } {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const w = viewCellToTile(dx, dy, q);
    map.setTile(w.x, w.y, 4);
    map.getChunk(Math.floor(w.x / 32), Math.floor(w.y / 32))!.setHeight(tileToLocal(w.x), tileToLocal(w.y), low[`${dx},${dy}`] ?? 5);
  }
  return viewCellToTile(0, 0, q);
}

describe("ADR-410 painted slope art in the renderer", () => {
  it("a ramp draws the painted slope sprite, not the flat base, in all 4 view rotations", () => {
    const slopeId = g.id("gt_dirt_slope_ramp_0");
    expect(slopeId).toBeGreaterThanOrEqual(0);
    for (let q = 0; q < 4; q++) {
      const seen: string[] = [];
      const map = new TileMap();
      const wc = fillView(map, q, { "1,0": 4 }); // +u neighbour 1 lower: ramp downhill +u
      const up = buildTerrain(map, wc.x, wc.y, q, 1, seen);
      expect(seen).toContain("gt_dirt_slope_ramp_0");
      expect(rowsAt(up, 0, 0)[0]![3]).toBe(slopeId);
    }
  });

  it("a wedge draws its low-corner sprite; a flat tile keeps the flat base", () => {
    const seen: string[] = [];
    const map = new TileMap();
    const wc = fillView(map, 0, { "1,0": 4, "0,1": 4 }); // +u and +v neighbours 1 lower: wedge, low corner (u+,v+)
    const up = buildTerrain(map, wc.x, wc.y, 0, 1, seen);
    expect(seen).toContain("gt_dirt_slope_wedge_2");
    expect(rowsAt(up, 0, 0)[0]![3]).toBe(g.id("gt_dirt_slope_wedge_2"));

    const seen2: string[] = [];
    const flat = new TileMap();
    const fc = fillView(flat, 0, {});
    const up2 = buildTerrain(flat, fc.x, fc.y, 0, 1, seen2);
    expect(seen2.some((k) => k.includes("_slope_"))).toBe(false);
    expect(rowsAt(up2, 0, 0)[0]![3]).toBe(g.id("gt_dirt")); // flat base (hash (0,0) -> variant "")
  });
});
