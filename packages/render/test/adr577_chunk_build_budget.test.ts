/**
 * ADR-577: terrain chunk-build burst time-slicing (the ADR-577 scope, built as ADR-578).
 *
 * Pre-577, TilemapRenderer.sync() rebuilt every stale chunk mesh in the caller's frame:
 * measured ~7 ms per chunk, so a 36-chunk entry/teleport burst was a single ~224 ms frame
 * (measure-perf.md §2). sync() now builds in priority order — the focus chunk (the player's
 * own, set via setFocusChunk) first and exempt from the budget, never-built chunks (holes)
 * before rebuilds, then nearest-first — and stops when syncBudgetMs is spent; deferred
 * chunks keep their old mesh and are re-queued by the stamp check next frame.
 *
 * The clock is injected (nowFn), so the profiles asserted here are structural — builds per
 * sync and syncs to settle — not wall-clock numbers that would flake under load. The final
 * mesh bytes after settling must equal the unlimited-budget build exactly.
 */
import { describe, it, expect } from "vitest";
import { TileMap, tileToChunk, type Chunk } from "@engine/world";
import { TilemapRenderer } from "../src/tilemap.js";

/** Minimal mock GL: captures every vertex ArrayBuffer handed to bufferData, in build order. */
function makeMockGl(buffers: ArrayBuffer[]) {
  return {
    createVertexArray: () => ({}),
    createBuffer: () => ({}),
    bindVertexArray: () => {},
    bindBuffer: () => {},
    bufferData: (_t: unknown, data: ArrayBuffer | Uint16Array | Uint32Array) => {
      if (data instanceof ArrayBuffer) buffers.push(data);
    },
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    deleteVertexArray: () => {},
    deleteBuffer: () => {},
  };
}
function makeRenderer(buffers: ArrayBuffer[]): TilemapRenderer {
  return Object.assign(Object.create(TilemapRenderer.prototype), {
    gl: makeMockGl(buffers),
    meshes: new Map(),
    iso: { view: 0 },
    zFactor: 1,
    maxZ: 1,
  });
}

/** A 6x6 chunk world (-3..2), one grass tile at each chunk's origin so every chunk builds a mesh. */
function burstMap(): TileMap {
  const map = new TileMap();
  for (let cy = -3; cy <= 2; cy++) for (let cx = -3; cx <= 2; cx++) {
    map.ensureChunk(cx, cy);
    map.setTile(cx * 32, cy * 32, 4);
    map.getChunk(cx, cy)!.setHeight(0, 0, 5);
  }
  return map;
}
/** Fake clock: every read advances 10 ms, so a 25 ms budget admits exactly 2 checked builds. */
function fakeClock(): () => number { let t = 0; return () => (t += 10); }
/** Chunk coords of each captured vertex buffer, in build order (first vertex = origin tile corner). */
function builtChunks(buffers: ArrayBuffer[]): [number, number][] {
  return buffers.map((b) => {
    const f = new Float32Array(b);
    return [tileToChunk(Math.round(f[0]!)), tileToChunk(Math.round(f[1]!))] as [number, number];
  });
}
const meshOf = (r: TilemapRenderer, map: TileMap, cx: number, cy: number): unknown =>
  (r as unknown as { meshes: Map<Chunk, unknown> }).meshes.get(map.getChunk(cx, cy)!);

describe("ADR-577 chunk-build budget", () => {
  it("spreads a 36-chunk burst across syncs (worst sync 3 builds, settles in 12), focus first, nearest-first", () => {
    const map = burstMap();
    const buffers: ArrayBuffer[] = [];
    const r = makeRenderer(buffers);
    r.syncBudgetMs = 25; r.nowFn = fakeClock();
    r.setFocusChunk(0, 0);
    r.sync(map);
    expect(r.syncBuilds).toBe(3); // focus (exempt) + 2 budget-checked builds
    expect(r.syncDeferred).toBe(33);
    // Priority: focus chunk, then Chebyshev distance 1 in (cx, cy) order.
    expect(builtChunks(buffers)).toEqual([[0, 0], [-1, -1], [-1, 0]]);
    let syncs = 1;
    while (r.syncDeferred > 0 && syncs < 40) { r.sync(map); syncs++; expect(r.syncBuilds).toBeLessThanOrEqual(3); }
    expect(syncs).toBe(12);
    expect(buffers).toHaveLength(36);
  });

  it("settled output is byte-identical to the unlimited build (as a multiset — order differs)", () => {
    const mapA = burstMap();
    const bufA: ArrayBuffer[] = [];
    const ra = makeRenderer(bufA);
    ra.syncBudgetMs = 25; ra.nowFn = fakeClock(); ra.setFocusChunk(0, 0);
    ra.sync(mapA);
    for (let n = 0; n < 20 && ra.syncDeferred > 0; n++) ra.sync(mapA);
    expect(ra.syncDeferred).toBe(0);
    const mapB = burstMap();
    const bufB: ArrayBuffer[] = [];
    const rb = makeRenderer(bufB); // no budget fields set by hand: Object.create stub -> unlimited
    rb.sync(mapB);
    expect(rb.syncBuilds).toBe(36);
    expect(rb.syncDeferred).toBe(0);
    const bytes = (bs: ArrayBuffer[]): string[] => bs.map((b) => Buffer.from(b).toString("base64")).sort();
    expect(bytes(bufA)).toEqual(bytes(bufB));
  });

  it("budget 0 still builds the focus chunk in its entry frame — and only it", () => {
    const map = burstMap();
    const buffers: ArrayBuffer[] = [];
    const r = makeRenderer(buffers);
    r.syncBudgetMs = 0; r.nowFn = fakeClock();
    r.setFocusChunk(2, 2); // key order would put this chunk near-last; the exemption must win
    r.sync(map);
    expect(r.syncBuilds).toBe(1);
    expect(r.syncDeferred).toBe(35);
    expect(meshOf(r, map, 2, 2)).toBeDefined();
    expect(meshOf(r, map, -3, -3)).toBeUndefined();
    expect(builtChunks(buffers)).toEqual([[2, 2]]);
  });

  it("a deferred rebuild keeps its old mesh drawing until its turn comes", () => {
    const map = burstMap();
    const buffers: ArrayBuffer[] = [];
    const r = makeRenderer(buffers);
    r.sync(map); // unlimited stub: everything built
    const target = map.getChunk(2, 2)!;
    const meshBefore = meshOf(r, map, 2, 2);
    const nearBefore = meshOf(r, map, 1, 1);
    target.version++; // an edit: (2,2) and its 8 neighbours go stale
    r.syncBudgetMs = 0; r.nowFn = fakeClock();
    r.setFocusChunk(0, 0); // (0,0) itself is fresh — not in the stale list
    r.sync(map);
    // Nearest stale chunk (1,1) rebuilt (the one free build); (2,2) still pending, old mesh intact.
    expect(meshOf(r, map, 1, 1)).not.toBe(nearBefore);
    expect(meshOf(r, map, 2, 2)).toBe(meshBefore);
    expect(r.syncDeferred).toBeGreaterThan(0);
    r.syncBudgetMs = Number.POSITIVE_INFINITY;
    r.sync(map);
    expect(meshOf(r, map, 2, 2)).not.toBe(meshBefore);
    expect(r.syncDeferred).toBe(0);
  });

  it("holes (never-built chunks) build before stale rebuilds at the same distance", () => {
    const map = burstMap();
    const buffers: ArrayBuffer[] = [];
    const r = makeRenderer(buffers);
    r.sync(map); // all built
    buffers.length = 0;
    map.getChunk(2, 2)!.version++; // (2,2) + its in-grid neighbours stale — all rebuilds with meshes
    const hole = map.ensureChunk(0, 3); // a fresh chunk streams in outside the built grid
    map.setTile(0, 96, 4); hole.setHeight(0, 0, 5);
    r.syncBudgetMs = 25; r.nowFn = fakeClock();
    r.setFocusChunk(0, 0); // (0,0) is fresh — not in the stale list
    r.sync(map);
    // Sort order is focus, then holes before rebuilds, then distance — so the hole at
    // distance 3 builds ahead of the distance-1 rebuilds: a hole in the ground outranks
    // a stale-but-drawn mesh.
    expect(builtChunks(buffers)[0]).toEqual([0, 3]);
  });
});
