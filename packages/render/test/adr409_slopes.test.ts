/**
 * ADR-409: sloped ground shapes — the renderers tilt a 1-level step into a ramp/wedge instead of a cliff:
 * the textured instance carries the corner drops in its skirt-mask bits (16/32/64/128), the downhill skirt,
 * drop-edge relief and gt_side face are suppressed on slope sides, and the vertex-colour mesh top face
 * drops the same corners (checked in all 4 view rotations). 2+-level steps keep their cliffs.
 * Gameplay truth is untouched: rendering never writes chunk heights.
 */
import { describe, it, expect } from "vitest";
import { TileMap, viewRect, tileToLocal } from "@engine/world";
import { TileTerrain, viewCellToTile } from "../src/terrainTiles.js";
import { TilemapRenderer } from "../src/tilemap.js";
import { groundSlopeKey } from "../src/groundArt.js";
import type { AtlasManager } from "../src/assets/atlasManager.js";

/** Run the REAL TileTerrain chunk builder, capture its GPU upload (16 floats per instance). */
function buildTerrain(map: TileMap, wx: number, wy: number, q: number, art: number, slopeId = -1, seenKeys: string[] = []): Float32Array {
  let uploaded = new Float32Array();
  const gl = {
    createVertexArray: () => ({}), createBuffer: () => ({}), bindVertexArray: () => {}, bindBuffer: () => {},
    bufferData: (_t: unknown, data: Float32Array<ArrayBuffer>) => { uploaded = data; },
    enableVertexAttribArray: () => {}, vertexAttribPointer: () => {}, vertexAttribDivisor: () => {},
  };
  const ground = { id: (k: string): number => { seenKeys.push(k); return k.includes("_slope_") ? slopeId : 1; } };
  const terrain = Object.assign(Object.create(TileTerrain.prototype), { gl, builds: 0, grazedRev: 0, ground: () => ground });
  const atlas = { registry: { ids: { sprites: { tryId: () => 1 } } }, animEntries: (id: number) => ({ first: id === 7 ? 100 : 0, count: 1, fps: 0, ax: 32, ay: 16 }), version: 0 } as unknown as AtlasManager;
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
/** Run the REAL mesh builder, decode its vertex buffer: {x, y, z, flag} per vertex (flag 0 top, 1 water, 2..5 cliff). */
function buildMesh(map: TileMap): { x: number; y: number; z: number; flag: number }[] {
  let buf: ArrayBuffer | null = null;
  const gl = {
    createVertexArray: () => ({}), createBuffer: () => ({}), bindVertexArray: () => {}, bindBuffer: () => {},
    bufferData: (_t: unknown, data: ArrayBuffer | Uint16Array | Uint32Array) => { if (data instanceof ArrayBuffer) buf = data; },
    enableVertexAttribArray: () => {}, vertexAttribPointer: () => {},
  };
  const renderer = Object.assign(Object.create(TilemapRenderer.prototype), { gl });
  renderer.build(map, map.getChunk(0, 0), undefined);
  const f = new Float32Array(buf!); const u8 = new Uint8Array(buf!); const out: { x: number; y: number; z: number; flag: number }[] = [];
  for (let k = 0; k < f.length / 4; k++) out.push({ x: f[k * 4]!, y: f[k * 4 + 1]!, z: f[k * 4 + 2]!, flag: u8[k * 16 + 15]! });
  return out;
}
function fillChunk(map: TileMap, low: Record<string, number>): void {
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    map.setTile(x, y, 4); map.getChunk(0, 0)!.setHeight(x, y, low[`${x},${y}`] ?? 5);
  }
}

describe("ADR-409 sloped ground rendering", () => {
  it("ramp in every view rotation: slope bits set, downhill skirt cleared, drop relief zeroed", () => {
    for (let q = 0; q < 4; q++) {
      const map = new TileMap(); const wc = fillView(map, q, { "1,0": 4 });
      const up = buildTerrain(map, wc.x, wc.y, q, 0);
      const cell = viewRect(wc.x, wc.y, 1, 1, q);
      const rows = rowsAt(up, cell.x, cell.y);
      expect(rows).toHaveLength(1);
      const r = rows[0]!;
      expect(r[2]).toBe(5); // instance stays at the gameplay height; the shader tilts it
      expect(r[6]).toBe(32 | 64); // corners (u+,v-) + (u+,v+) dropped; skirt bits 1/2 clear
      expect(r.slice(12)).toEqual([0, 0, 0, 0]);
    }
    // Flat control: no bits, no relief.
    const map = new TileMap(); const wc = fillView(map, 0, {});
    const rows = rowsAt(buildTerrain(map, wc.x, wc.y, 0, 0), 0, 0);
    expect(rows).toHaveLength(1); expect(rows[0]![6]).toBe(0); expect(rows[0]!.slice(12)).toEqual([0, 0, 0, 0]);
  });

  it("wedge in every view rotation: three corners dropped, both downhill skirts cleared", () => {
    for (let q = 0; q < 4; q++) {
      const map = new TileMap(); const wc = fillView(map, q, { "1,0": 4, "0,1": 4 });
      const up = buildTerrain(map, wc.x, wc.y, q, 0);
      const cell = viewRect(wc.x, wc.y, 1, 1, q);
      const rows = rowsAt(up, cell.x, cell.y);
      expect(rows).toHaveLength(1);
      expect(rows[0]![6]).toBe(32 | 64 | 128);
      expect(rows[0]!.slice(12)).toEqual([0, 0, 0, 0]);
    }
  });

  it("a 2-level step keeps its skirt and drop relief (stepped, not sloped)", () => {
    const map = new TileMap(); const wc = fillView(map, 0, { "1,0": 3 });
    const rows = rowsAt(buildTerrain(map, wc.x, wc.y, 0, 0), 0, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]![6]).toBe(1); // +u skirt kept, no slope bits
    expect(rows[0]!.slice(12)).toEqual([2, 0, 0, 0]);
  });

  it("gt branch: a ramp draws no side face, a 2-level step draws two", () => {
    const ramp = new TileMap(); const wc1 = fillView(ramp, 0, { "1,0": 4 });
    expect(rowsAt(buildTerrain(ramp, wc1.x, wc1.y, 0, 1), 0, 0)).toHaveLength(1);
    const step = new TileMap(); const wc2 = fillView(step, 0, { "1,0": 3 });
    const stepRows = rowsAt(buildTerrain(step, wc2.x, wc2.y, 0, 1), 0, 0);
    expect(stepRows).toHaveLength(3); // base + one gt_side face per level of drop
    expect(stepRows.map((r) => r[2]).sort()).toEqual([4, 5, 5]);
  });

  it("slope art contract: flat base until ADR-410 paints it, slope key selected when it ships", () => {
    expect(groundSlopeKey("dirt", 0, "ramp", 0)).toBe("gt_dirt_slope_ramp_0");
    expect(groundSlopeKey("grass", 1, "wedge", 2)).toBe("gt_grass_slope_wedge_2_fall");
    expect(groundSlopeKey("rock", 2, "ramp", 3)).toBe("gt_rock_slope_ramp_3_winter");
    // Unshipped: the slope key is requested but resolves to nothing, so the flat base stays.
    const seen: string[] = [];
    const map = new TileMap(); const wc = fillView(map, 0, { "1,0": 4 });
    const up = buildTerrain(map, wc.x, wc.y, 0, 1, -1, seen);
    expect(seen).toContain("gt_dirt_slope_ramp_0");
    expect(rowsAt(up, 0, 0)[0]![3]).toBe(0); // flat base entry, not a slope entry
    // Shipped: the same tile picks the slope entry.
    const up2 = buildTerrain(map, wc.x, wc.y, 0, 1, 7, []);
    expect(rowsAt(up2, 0, 0)[0]![3]).toBe(100);
  });

  it("mesh top face tilts on a ramp and drops the cliff; a 2-level step keeps both", () => {
    const ramp = new TileMap(); fillChunk(ramp, { "12,11": 4 });
    const verts = buildMesh(ramp);
    const has = (x: number, y: number, z: number): boolean => verts.some((v) => v.x === x && v.y === y && v.z === z);
    expect(has(11, 11, 5)).toBe(true); expect(has(12, 11, 4)).toBe(true);
    expect(has(12, 12, 4)).toBe(true); expect(has(11, 12, 5)).toBe(true);
    expect(has(12, 11, 5)).toBe(false); expect(has(12, 12, 5)).toBe(false);
    const near = verts.filter((v) => v.x >= 11 && v.x <= 13 && v.y >= 11 && v.y <= 13);
    expect(near.filter((v) => v.flag >= 2)).toEqual([]); // no cliff faces around the ramp

    const step = new TileMap(); fillChunk(step, { "12,11": 3 });
    const sverts = buildMesh(step);
    const shas = (x: number, y: number, z: number): boolean => sverts.some((v) => v.x === x && v.y === y && v.z === z);
    expect(shas(12, 11, 5)).toBe(true); // top stays flat at the gameplay height
    expect(sverts.some((v) => v.flag === 2 && v.x === 12 && v.z === 3)).toBe(true); // +x cliff face, down to 3
  });

  it("rendering never writes chunk heights (gameplay truth unchanged)", () => {
    const map = new TileMap(); fillChunk(map, { "12,11": 4 });
    const before = [...map.getChunk(0, 0)!.height];
    buildMesh(map); buildTerrain(map, 11, 11, 0, 1);
    expect([...map.getChunk(0, 0)!.height]).toEqual(before);
  });
});
