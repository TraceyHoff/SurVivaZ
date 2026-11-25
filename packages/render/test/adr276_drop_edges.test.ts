import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { TileMap, tileToLocal, viewRect } from "@engine/world";
import { terrainDropEdges, DROP_EDGE_GLSL } from "../src/dropEdges.js";
import { NO_TILE_HEIGHT } from "../src/tilemap.js";
import { TileTerrain } from "../src/terrainTiles.js";
import type { AtlasManager } from "../src/assets/atlasManager.js";

/** Run the REAL chunk builder, capture its GPU upload, not a duplicate of its direction maths. */
function build(map: TileMap, x: number, y: number, q: number, art = 0): Float32Array {
  let uploaded: Float32Array = new Float32Array();
  const gl = {
    createVertexArray: () => ({}), createBuffer: () => ({}), bindVertexArray: () => {}, bindBuffer: () => {},
    bufferData: (_target: unknown, data: Float32Array) => { uploaded = data; },
    enableVertexAttribArray: () => {}, vertexAttribPointer: () => {}, vertexAttribDivisor: () => {},
  };
  const terrain = Object.assign(Object.create(TileTerrain.prototype), { gl, builds: 0, grazedRev: 0, ground: () => ({ id: () => 1 }) });
  const atlas = { registry: { ids: { sprites: { tryId: () => 1 } } }, animEntries: () => ({ first: 0, count: 1, fps: 0, ax: 32, ay: 16 }), version: 0 } as unknown as AtlasManager;
  terrain.build(map, map.getChunk(Math.floor(x / 32), Math.floor(y / 32)), atlas, undefined, art, q);
  const cell = viewRect(x, y, 1, 1, q);
  for (let i = 0; i < uploaded.length; i += 16) if (uploaded[i] === cell.x + 0.5 && uploaded[i + 1] === cell.y + 0.5) return uploaded.slice(i, i + 16);
  throw new Error("missing terrain instance");
}
function height(map: TileMap, x: number, y: number, z: number): void {
  map.setTile(x, y, 4); map.getChunk(Math.floor(x / 32), Math.floor(y / 32))!.setHeight(tileToLocal(x), tileToLocal(y), z);
}

describe("ADR-276 camera-hidden terrain cuts", () => {
  it("ignores flat ground, uphill, void / unloaded neighbours and water's fractional inset", () => {
    expect(terrainDropEdges(3, 3, 4, NO_TILE_HEIGHT, 2.75)).toEqual([0, 0, 0, 0]);
    expect(terrainDropEdges(0, -6, -2, -25, -1)).toEqual([6, 2, 8, 1]);
    const map = new TileMap();
    for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) height(map, x, y, 0);
    for (let q = 0; q < 4; q++) expect([...build(map, 0, 0, q).slice(12)]).toEqual([0, 0, 0, 0]);
  });
  it("carries an actually hidden -x drop onto the textured top, and rotates the cue with all four quarters", () => {
    const map = new TileMap();
    // Straddles x=32 so neighbouring chunk height edits exercise the cache stamp too.
    for (let y = -1; y <= 1; y++) for (let x = 31; x <= 33; x++) height(map, x, y, 0);
    height(map, 31, 0, -6);
    const expected = [[0, 0, 6, 0], [0, 0, 0, 6], [6, 0, 0, 0], [0, 6, 0, 0]];
    for (const art of [0, 1, 2, 3, 4]) for (let q = 0; q < 4; q++) expect([...build(map, 32, 0, q, art).slice(12)]).toEqual(expected[q]);
    const terrain = Object.assign(Object.create(TileTerrain.prototype), { grazedRev: 0 });
    const chunk = map.getChunk(1, 0)!; const stamp = terrain.stamp(map, chunk);
    height(map, 31, 0, 0);
    expect(terrain.stamp(map, chunk)).not.toBe(stamp);
    for (let q = 0; q < 4; q++) expect([...build(map, 32, 0, q).slice(12)]).toEqual([0, 0, 0, 0]);
  });
  it("uses top-surface relief after weather / snow, stronger on hidden edges, without extra draws or instance bytes", () => {
    const src = readFileSync(new URL("../src/terrainTiles.ts", import.meta.url), "utf8");
    expect(src).toContain("const FLOATS = 16");
    expect(src).toContain("${DROP_EDGE_GLSL}");
    expect(src.indexOf("c = terrainDropRelief")).toBeGreaterThan(src.indexOf("c = seasonSnow"));
    expect(src).toContain("vInfo.w == 0.0"); // never turn water corner tints into drop depths
    expect(DROP_EDGE_GLSL).toContain("cell.x, cell.y");
    expect(DROP_EDGE_GLSL).toContain("0.34, 0.34, 0.60, 0.60");
  });
});
