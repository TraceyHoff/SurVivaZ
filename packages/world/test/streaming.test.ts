import { describe, it, expect } from "vitest";
import { World, Transform, defineComponent, NetId } from "@engine/core";
import { ChunkManager, ProceduralGenerator, chunkKey, chunkOf, parseChunkKey, encodeChunk, decodeChunk, ChunkMembership, BuildingGrid, loadBuildPieces, WorldOrigin, Chunk, CHUNK_SIZE } from "../src/index.js";

describe("chunk keys", () => {
  it("signed 32-bit chunk coords roundtrip", () => {
    for (const [x, y] of [[0, 0], [-1, 5], [2147483647, -2147483648]] as const) expect(parseChunkKey(chunkKey(x, y))).toEqual({ cx: x, cy: y });
    expect(chunkOf({ x: -0.5, y: 32 })).toEqual({ cx: -1, cy: 1 });
  });
});

describe("ProceduralGenerator", () => {
  it("is deterministic per seed and places nodes inside the chunk", () => {
    const a = new ProceduralGenerator({ seed: 42 }).load(3, -7), b = new ProceduralGenerator({ seed: 42 }).load(3, -7);
    expect(a.chunk.tiles).toEqual(b.chunk.tiles); expect(a.nodes).toEqual(b.nodes);
    expect(new ProceduralGenerator({ seed: 43 }).load(3, -7).chunk.tiles).not.toEqual(a.chunk.tiles);
    for (const n of a.nodes) { expect(Math.floor(n.tx / CHUNK_SIZE)).toBe(3); expect(Math.floor(n.ty / CHUNK_SIZE)).toBe(-7); }
    let total = 0; for (let i = 0; i < 9; i++) total += new ProceduralGenerator({ seed: 42 }).load(i, i).nodes.length; expect(total).toBeGreaterThan(0);
  });
});

describe("ChunkManager", () => {
  it("streams around sources with hysteresis, LRU cache and onLoad/onUnload hooks", () => {
    const loaded: string[] = [], unloaded: string[] = [];
    const m = new ChunkManager({ provider: new ProceduralGenerator({ seed: 1 }), loadRadius: 1, unloadMargin: 1, cacheSize: 4 });
    m.onLoad((c, nodes) => { loaded.push(c.key); expect(Array.isArray(nodes)).toBe(true); });
    m.onUnload((c) => unloaded.push(c.key));
    m.setSource({ id: 1, x: 16, y: 16 }); m.update();
    expect(m.activeKeys.size).toBe(9); expect(loaded.length).toBe(9);
    m.setSource({ id: 1, x: 16 + 32, y: 16 }); m.update(); // within margin: nothing released
    expect(m.isActive(chunkKey(-1, 0))).toBe(true); expect(loaded.length).toBe(12);
    m.setSource({ id: 1, x: 16 + 32 * 10, y: 16 }); m.update();
    expect(unloaded.length).toBe(12 - 4); // 12 released into LRU of size 4
    m.setSource({ id: 1, x: 16, y: 16 }); m.update(); expect(m.stats.cacheHits).toBeGreaterThan(0);
  });
  it("respects per-update load budget", () => {
    const m = new ChunkManager({ provider: new ProceduralGenerator({ seed: 1 }), loadRadius: 2, maxLoadsPerUpdate: 5 });
    m.setSource({ id: 1, x: 0, y: 0 }); m.update(); expect(m.chunkCount).toBe(5); expect(m.pendingLoads).toBe(20);
    for (let i = 0; i < 4; i++) m.update(); expect(m.chunkCount).toBe(25);
  });
});

describe("chunk codec + persistence", () => {
  const Wall = defineComponent("Crate", { contents: { type: "u16", length: 3 }, hp: "f32" }, { persistent: true });
  const Temp = defineComponent("Temp", { a: "u8" });
  it("roundtrips tiles, buildings and persistent entities (chunk-relative positions)", () => {
    const { registry } = loadBuildPieces([{ key: "floor", footprint: { w: 2, h: 2 }, layer: 0, hp: 100, solid: false }]);
    const w = new World(); w.register(Wall); w.register(Temp);
    const g = new ProceduralGenerator({ seed: 9 }).load(-100000, 50);
    const grid = new BuildingGrid(registry); const fid = registry.byKey("floor").id;
    grid.place(fid, -100000 * 32 + 3, 50 * 32 + 4, 0, 1, 77);
    const e = w.create(); w.add(e, Transform, { x: -100000 * 32 + 5.25, y: 50 * 32 + 1.5, facing: 1 }).add(e, Wall, { contents: [1, 2, 3], hp: 9 }).add(e, Temp).add(e, NetId, { id: 5 });
    const plain = w.create(); w.add(plain, Temp);
    const bytes = encodeChunk(g.chunk, { world: w, entities: [e, plain], buildings: grid });
    const w2 = new World(); w2.register(Wall); w2.register(Temp); const grid2 = new BuildingGrid(registry);
    const d = decodeChunk(bytes, { world: w2, buildings: grid2 });
    expect(d.chunk.tiles).toEqual(g.chunk.tiles); expect(d.chunk.height).toEqual(g.chunk.height);
    expect(grid2.count).toBe(1); expect(grid2.at(-100000 * 32 + 4, 50 * 32 + 4, 0)).toBeGreaterThan(0); expect(d.buildings[0]!.hp).toBe(77);
    expect(d.entities.length).toBe(1); const e2 = d.entities[0]!;
    expect(w2.get(e2, Wall)).toEqual({ contents: [1, 2, 3], hp: 9 });
    expect(w2.get(e2, Transform)!.x - -3200000).toBeCloseTo(5.25 - 0, 0); // f32 precision at 3.2M tiles is ~0.25
    expect(w2.has(e2, Temp)).toBe(false); expect(w2.has(e2, NetId)).toBe(false);
    expect(() => decodeChunk(bytes.slice(0, 20))).toThrow();
    const w3 = new World(); expect(() => decodeChunk(bytes, { world: w3 })).toThrow(/schema/);
  });
  it("empty chunk encodes compactly via RLE", () => { expect(encodeChunk(new Chunk(0, 0)).length).toBeLessThan(2200); }); // ADR-411: heights are 2 bytes/tile now (2075 total), tiles still RLE
});

describe("membership + origin", () => {
  it("tracks entity chunk incrementally", () => {
    const w = new World(); const m = new ChunkMembership(w); w.addSystem("postSim", "m", () => m.update());
    const e = w.create(); w.add(e, Transform, { x: 1, y: 1 }); w.step(0.05);
    expect([...m.entitiesIn(chunkKey(0, 0))]).toEqual([e]);
    w.setField(e, Transform, "x", -1); w.step(0.05); expect(m.chunkOf(e)).toBe(chunkKey(-1, 0)); expect(m.entitiesIn(chunkKey(0, 0)).size).toBe(0);
    w.destroy(e); w.step(0.05); expect(m.size).toBe(0);
  });
  it("WorldOrigin rebases to chunk corners", () => {
    const o = new WorldOrigin(); expect(o.maybeRebase(100, 100)).toEqual({ dx: 0, dy: 0 });
    const d = o.maybeRebase(40000.5, 5); expect(d.dx).toBe(Math.floor(40000.5 / 32) * 32); expect(o.toLocal(40000.5, 5).x).toBeCloseTo(40000.5 - d.dx);
  });
});
