/**
 * ADR-480: the mesh rebuild stamp loses diagonal-neighbour version changes, so a chunk
 * mesh goes stale and a side face stays open to the sky (the blue triangle in Tracey's
 * 2026-11-20 phone photo 1).
 *
 * Root cause (PROVEN by the stamp arithmetic below, not by a sweep): TilemapRenderer.stamp
 * (tilemap.ts) is a floating-point polynomial hash of the chunk's version and its 8
 * neighbours' versions. The stamp is ~1.2e21 even in a fresh world (every version + 1),
 * where an IEEE-754 double's spacing is 2^18 = 262,144 — so a +1 increment at the tail of
 * the polynomial rounds away entirely. The diagonal neighbours sit at the tail:
 *   fresh world (all versions 0): a +1 at d3/d4 does NOT change the stamp;
 *   versions >= 1: a +1 at d2/d3/d4 does NOT change it;
 *   versions >= 100: a +1 at d1..d4 does NOT change it.
 * sync() therefore does not rebuild the mesh when a diagonal chunk loads or is edited, and
 * the diagonal feeds the shared-vertex corner drops (slope.ts) — a stale corner drop
 * flips a slope side into a missing cliff, or leaves the top edge a level above the
 * neighbour's fresh edge. The open region is a TRIANGLE, full height at the vertex where
 * the stale and fresh corners disagree, tapering to a point at the vertex where they
 * agree — exactly the shape of the blue region in the photo (measured on the original
 * 945x2048 image: 53 px wide, ~27 px tall at the left end, tapering to 2 px at x=551).
 * The single-consistent-build model was already proved airtight by ADR-418 (81 combos);
 * this is the remaining hole: cross-BUILD staleness, not a bad build.
 *
 * The fix (tilemap.ts): the stamp is now the exact 32-bit Math.imul mixing already used
 * by TileTerrain.stamp (terrainTiles.ts) — a +1 at any of the 9 positions always changes
 * it, at any version. The Canvas2D gt-block stamp (string) and the TileTerrain stamp
 * were already exact; only the mesh stamp was a float polynomial.
 *
 * These tests FAIL on the pre-fix stamp and PASS on the fixed one (revert check).
 */
import { describe, it, expect } from "vitest";
import { TileMap, tileToChunk, tileToLocal, type Chunk } from "@engine/world";
import { TilemapRenderer, CLIFF_PX } from "../src/tilemap.js";

/** Minimal mock GL: captures every vertex ArrayBuffer handed to bufferData. */
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
  };
}
/** A TilemapRenderer without its constructor (no real GL program): sync/build/stamp only. */
function makeRenderer(buffers: ArrayBuffer[]): TilemapRenderer {
  return Object.assign(Object.create(TilemapRenderer.prototype), {
    gl: makeMockGl(buffers),
    meshes: new Map(),
    iso: { view: 0 },
    zFactor: 1,
    maxZ: 1,
  });
}
const stampOf = (r: TilemapRenderer, map: TileMap, c: Chunk): number =>
  (r as unknown as { stamp(map: TileMap, c: Chunk): number }).stamp(map, c);

type Vert = { x: number; y: number; z: number; flag: number };
function decode(buf: ArrayBuffer): Vert[] {
  const f = new Float32Array(buf);
  const u8 = new Uint8Array(buf);
  const out: Vert[] = [];
  for (let k = 0; k < f.length / 4; k++) {
    out.push({ x: f[k * 4]!, y: f[k * 4 + 1]!, z: f[k * 4 + 2]!, flag: u8[k * 16 + 15]! });
  }
  return out;
}
/** Cliff quads are emitted as 4 consecutive vertices: group the flat vertex list into quads. */
const quads = (verts: Vert[]): Vert[][] => {
  const out: Vert[][] = [];
  for (let i = 0; i + 3 < verts.length; i += 4) out.push(verts.slice(i, i + 4));
  return out;
};
/** Fill a world rect with grass (tile 4) at height h. */
function fillRect(map: TileMap, x0: number, y0: number, x1: number, y1: number, h = 5): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      map.setTile(x, y, 4);
      map.getChunk(tileToChunk(x), tileToChunk(y))!.setHeight(tileToLocal(x), tileToLocal(y), h);
    }
  }
}
function setH(map: TileMap, x: number, y: number, h: number): void {
  map.getChunk(tileToChunk(x), tileToChunk(y))!.setHeight(tileToLocal(x), tileToLocal(y), h);
}

describe("ADR-480 mesh stamp: a +1 version change at any of the 9 positions must change the stamp", () => {
  // Stamp positions in tilemap.ts order: own, +x, +y, -x, -y, (+x,+y), (-x,+y), (+x,-y), (-x,-y).
  const POSITIONS: [number, number][] = [
    [0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1],
  ];
  for (const V of [0, 1, 100, 1024]) {
    it(`all 9 positions move the stamp at version ${V}`, () => {
      const map = new TileMap();
      for (let cy = -1; cy <= 1; cy++) {
        for (let cx = -1; cx <= 1; cx++) map.ensureChunk(cx, cy).version = V;
      }
      const renderer = makeRenderer([]);
      const c = map.getChunk(0, 0)!;
      const base = stampOf(renderer, map, c);
      for (const [dx, dy] of POSITIONS) {
        const n = map.getChunk(dx, dy)!;
        n.version = V + 1;
        expect(stampOf(renderer, map, c), `V=${V} +1 at (${dx},${dy}) must change the stamp`).not.toBe(base);
        n.version = V;
      }
    });
  }
});

describe("ADR-480 mesh staleness: a diagonal chunk loading must rebuild the mesh (the photo's gap)", () => {
  it("loading the (1,-1) diagonal chunk with a low tile rebuilds chunk (0,0) and emits T's +x cliff", () => {
    // T=(31,0) h=5 at the +x edge of chunk (0,0); N=(32,0) h=4 in chunk (1,0);
    // (31,-1)=5 in chunk (0,-1); the (1,-1) diagonal chunk is NOT loaded yet, so the
    // diagonal tile (32,-1) is void and T's corner at (32,0) drops (vertex min 4 = h-1):
    // T's +x edge is a slope side and correctly emits NO cliff.
    const map = new TileMap();
    fillRect(map, 0, 0, 31, 31); // chunk (0,0), all h=5
    fillRect(map, 32, 0, 63, 31); // chunk (1,0), all h=5
    setH(map, 32, 0, 4); // N
    fillRect(map, 0, -32, 31, -1); // chunk (0,-1), all h=5
    for (const c of map.loadedChunks()) c.version = 0; // fresh-world versions
    const buffers: ArrayBuffer[] = [];
    const renderer = makeRenderer(buffers);
    renderer.sync(map);
    // CONTROL: no +x cliff quad for T yet — the slope side is correct while the diagonal is void.
    const first = buffers.flatMap((b) => quads(decode(b)));
    const tCliffBefore = first.filter((q) =>
      q.every((v) => v.flag === CLIFF_PX && v.x === 32 && (v.y === 0 || v.y === 1)),
    );
    expect(tCliffBefore).toHaveLength(0);

    // The diagonal chunk streams in with a LOW tile (32,-1)=3: the vertex min at (32,0)
    // becomes 3, so T's corner no longer drops — T's +x edge is [5,4], not a slope side,
    // and a +x cliff is needed (top [5,4], bottom = N's edge [3,4]).
    fillRect(map, 32, -32, 63, -1); // chunk (1,-1), all h=5
    setH(map, 32, -1, 3);
    map.getChunk(1, -1)!.version = 0; // a freshly streamed chunk: version 0
    const before = buffers.length;
    renderer.sync(map);
    const after = buffers.slice(before).flatMap((b) => quads(decode(b)));
    const tCliff = after.filter((q) =>
      q.every((v) => v.flag === CLIFF_PX && v.x === 32 && (v.y === 0 || v.y === 1)),
    );
    // INVARIANT: the mesh was rebuilt, so T's +x cliff is present with the exact trapezoid
    // [top (32,0)=5, top (32,1)=4, bottom (32,1)=4, bottom (32,0)=3]. On the pre-fix
    // float-polynomial stamp the (1,-1) load does not move chunk (0,0)'s stamp (d3 +1
    // vanishes), sync() skips the rebuild, and this quad is absent — the triangular
    // sky gap in the photo.
    expect(tCliff).toHaveLength(1);
    expect(tCliff[0]!.map((v) => v.z)).toEqual([5, 4, 4, 3]);
    expect(tCliff[0]!.map((v) => [v.x, v.y])).toEqual([[32, 0], [32, 1], [32, 1], [32, 0]]);
  });
});
