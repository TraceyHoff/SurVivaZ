/** ADR-506: TileMap.getChunk's one-entry cache stays exact across inserts, unloads and ChunkManager streaming. */
import { describe, expect, it } from "vitest";
import { Chunk, ChunkManager, TileMap, CHUNK_SIZE } from "../src/index.js";

describe("ADR-506 getChunk cache", () => {
  it("never returns a stale chunk or a stale miss", () => {
    const m = new TileMap();
    expect(m.getChunk(0, 0)).toBeUndefined(); // cached miss
    m.setTile(1, 1, 4); const a = m.getChunk(0, 0)!; expect(a).toBeDefined(); // ensureChunk insert invalidates the miss
    expect(m.getChunk(0, 0)).toBe(a); expect(m.getTile(1, 1)).toBe(4);
    const b = new Chunk(0, 0); m.insertChunk(b); expect(m.getChunk(0, 0)).toBe(b); // replaced chunk
    expect(m.unloadChunk(0, 0)).toBe(true); expect(m.getChunk(0, 0)).toBeUndefined(); expect(m.getTile(1, 1)).toBe(0);
    m.setTile(-1, -1, 3); expect(m.getChunk(-1, -1)!.cx).toBe(-1); expect(m.getTile(-1, -1)).toBe(3); expect(m.getTile(CHUNK_SIZE, 0)).toBe(0);
  });
  it("follows ChunkManager's direct map edits (stream in, LRU eviction)", () => {
    const cm = new ChunkManager({ provider: { load: (cx: number, cy: number) => { const c = new Chunk(cx, cy); c.set(0, 0, 4); return { chunk: c, nodes: [] }; } }, loadRadius: 0, unloadMargin: 0, cacheSize: 0 });
    cm.setSource({ id: 1, x: 0, y: 0 }); cm.update();
    expect(cm.getChunk(0, 0)).toBeDefined(); expect(cm.getTile(0, 0)).toBe(4); // cached hit
    cm.setSource({ id: 1, x: 50 * CHUNK_SIZE, y: 0 }); cm.update(); cm.update();
    expect(cm.getChunk(0, 0)).toBeUndefined(); expect(cm.getTile(0, 0)).toBe(0); // evicted: no stale hit
    expect(cm.getChunk(50, 0)).toBeDefined();
    cm.setSource({ id: 1, x: 0, y: 0 }); cm.update();
    expect(cm.getTile(0, 0)).toBe(4); // reloaded: no stale miss
  });
});
