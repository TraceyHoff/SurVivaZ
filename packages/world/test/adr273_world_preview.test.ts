import { describe, expect, it, vi } from "vitest";
import { fnv1a } from "@engine/core";
import { CHUNK_SIZE, Chunk, ChunkManager, HEIGHT_MAX, PREVIEW, previewWorldAt, ProceduralGenerator, WORLD_TILE_DIAMETER, WORLD_TILE_HALF_EXTENT, computeSpawnPoints, sampleWorldPreview, waterFeatureLayout, worldPreviewSvg, worldToNorthUp, worldTileFromKey, worldTileKey } from "../src/index.js";

describe("ADR-272 sampled seed preview and wilderness", () => {
  it.each([0, 1234, 424242, 0xffffffff])("seed %i: same thumbnail and exact playable terrain samples", seed => {
    const a = sampleWorldPreview(seed), b = sampleWorldPreview(seed); expect(a).toEqual(b); expect(worldPreviewSvg(a)).toBe(worldPreviewSvg(b));
    const g = new ProceduralGenerator({ seed }); const chunks = new Map<string, ReturnType<typeof g.load>>();
    for (let i = 0; i < a.tiles.length; i += 37) {
      const { x, y } = previewWorldAt(i % PREVIEW.width, Math.floor(i / PREVIEW.width));
      const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE), key = `${cx},${cy}`;
      let c = chunks.get(key); if (!c) chunks.set(key, (c = g.load(cx, cy)));
      const lx = ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE, ly = ((y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
      expect(a.tiles[i]).toBe(c.chunk.get(lx, ly)); expect(a.heights[i]).toBe(c.chunk.getHeight(lx, ly));
    }
  });
  it.each([0, 1234, 424242, 0xffffffff])("seed %i: the rotated survey still covers all starter areas", seed => {
    const g = new ProceduralGenerator({ seed });
    for (const p of computeSpawnPoints(g)) {
      const map = worldToNorthUp(p.x, p.y);
      expect(map.x).toBeGreaterThan(PREVIEW.x); expect(map.x).toBeLessThan(PREVIEW.x + PREVIEW.width * PREVIEW.stride);
      expect(map.y).toBeGreaterThan(PREVIEW.y); expect(map.y).toBeLessThan(PREVIEW.y + PREVIEW.height * PREVIEW.stride);
    }
  });
  it("different seeds change the land, water and relief rather than just a label", () => {
    const a = sampleWorldPreview(1), b = sampleWorldPreview(2);
    expect(a.tiles).not.toEqual(b.tiles); expect(a.heights).not.toEqual(b.heights); expect(worldPreviewSvg(a)).not.toBe(worldPreviewSvg(b));
    expect(a.tiles.some(t => t === 1 || t === 8)).toBe(true);
  });
  it.each([1234, 424242])("seed %i has large wilderness relief and safe starter patches", seed => {
    const g = new ProceduralGenerator({ seed }); let min = Infinity, max = -Infinity, face = 0;
    for (let y = 384; y < 640; y += 2) for (let x = 384; x < 640; x += 2) {
      const h = g.heightAt(x, y); min = Math.min(min, h); max = Math.max(max, h); face = Math.max(face, Math.abs(h - g.heightAt(x + 1, y)), Math.abs(h - g.heightAt(x, y + 1)));
    }
    expect(HEIGHT_MAX).toBe(22); expect(min).toBeLessThanOrEqual(3); expect(max).toBeGreaterThanOrEqual(19); expect(max).toBeLessThanOrEqual(22); expect(face).toBeGreaterThan(3);
    for (const p of computeSpawnPoints(g)) for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
      const tx = Math.floor(p.x) + x, ty = Math.floor(p.y) + y, h = g.heightAt(tx, ty);
      expect(Math.abs(h - g.heightAt(tx + 1, ty))).toBeLessThanOrEqual(3);
      expect(Math.abs(h - g.heightAt(tx, ty + 1))).toBeLessThanOrEqual(3);
    }
  });
  it("far regions contain genuine generated terrain, resources and seeded lakes/ponds", () => {
    const seed = 424242, g = new ProceduralGenerator({ seed }); let nodes = 0;
    for (const [rx, ry] of [[100, 110], [-100, -100], [80, -100]]) {
      const water = waterFeatureLayout(fnv1a(`${rx},${ry}`, seed));
      for (const p of [water.lake, water.pond]) expect([1, 8]).toContain(g.tileAt(rx! * 512 + Math.floor(p.x), ry! * 512 + Math.floor(p.y)));
      for (let j = 0; j < 4; j++) { const c = g.load(rx! * 16 + j, ry! * 16 + j); nodes += c.nodes.length; expect(c.chunk.tiles.some(t => t !== 0)).toBe(true); }
    }
    expect(nodes).toBeGreaterThan(0);
  });
  it("quadruples the collision-free terrain/road domain without an eager world allocation", () => {
    expect(WORLD_TILE_DIAMETER).toBe(262144); expect(WORLD_TILE_DIAMETER ** 2 / 131072 ** 2).toBe(4);
    const points: [number, number][] = [[0, 32768], [1, -32768], [0, 60000], [1, -5536], [-65536, -65536], [65535, 65535]];
    expect(new Set(points.map(([x, y]) => worldTileKey(x, y))).size).toBe(points.length);
    for (const [x, y] of points) expect(worldTileFromKey(worldTileKey(x, y))).toEqual([x, y]);
    expect(WORLD_TILE_HALF_EXTENT).toBe(131072);
  });
  it("streaming stays bounded at the new distant coordinates, with at most four loads per update", () => {
    const cm = new ChunkManager({ provider: new ProceduralGenerator({ seed: 1234 }), loadRadius: 2, unloadMargin: 1, cacheSize: 64, maxLoadsPerUpdate: 4, maxLoadTimeMs: 2 });
    for (let i = 0; i < 12; i++) {
      cm.setSource({ id: 1, x: (i % 2 ? -1 : 1) * (45000 + i * 1000), y: 50000 + i * 400 });
      let guard = 0;
      do { const old = cm.stats.loads; cm.update(); expect(cm.stats.loads - old).toBeLessThanOrEqual(4); expect(cm.chunkCount).toBeLessThanOrEqual(113); } while (cm.pendingLoads && ++guard < 100);
      expect(cm.pendingLoads).toBe(0); expect(cm.activeKeys.size).toBe(25);
    }
    expect(cm.stats.unloads).toBeGreaterThan(0);
  });
});

it("the wall-clock streaming budget stops before the four-chunk cap and always makes progress", () => {
  let clock = 0; const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
  try {
    const cm = new ChunkManager({ provider: { load(cx, cy) { clock += 1.2; return { chunk: new Chunk(cx, cy), nodes: [] }; } }, maxLoadsPerUpdate: 4, maxLoadTimeMs: 2 });
    cm.setSource({ id: 1, x: 0, y: 0 }); cm.update(); expect(cm.stats.loads).toBe(2); expect(cm.pendingLoads).toBe(23);
    cm.update(); expect(cm.stats.loads).toBe(4);
  } finally { spy.mockRestore(); }
});
