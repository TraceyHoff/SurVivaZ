/**
 * ADR-418: terrain slope seam glitches — regression for the FLOATING PIECES / TEXTURE OVERLAP
 * symptoms (symptoms 2 and 3), plus the real-mesh cliff quads for symptom 1 (blue gaps).
 *
 * Root cause (hypothesis C, PROVEN here): the textured instance did NOT tilt the way its own
 * shader comment claimed. terrainTiles.ts VS said "the diamond tilts by bilinear interpolation
 * over the frame" — but `sdrop` was computed only at the FOUR FRAME-QUAD VERTICES, and the GPU
 * then linearly interpolated gl_Position across the two TRIANGLE_STRIP triangles, whose fold is
 * the frame diagonal v1-v2 (top-right to bottom-left frame corner). The vertex-colour mesh
 * (tilemap.ts:226-229) is two triangles folded on the N-S diamond diagonal (corners 0-2). Two
 * different folds + frame corners that are not on the mesh plane = the instance's diamond corners
 * sat at the wrong heights: from -0.55 levels (instance sunk 9 px into the
 * mesh) to +0.83 levels (instance floating 13 px above the mesh) at 2x frame scale, on every
 * sloped shape, while flat tiles agreed exactly (control below).
 * A sloped instance therefore floated above its low neighbour, sank into its high neighbour,
 * and disagreed with the adjacent instance at the shared vertex — the brown diamonds hovering
 * over / overlapping the dirt terraces in the screenshot.
 *
 * The fix (terrainTileTriangulation.ts + the VS in terrainTiles.ts): the instance is now 30
 * vertices (10 triangles, drawn as TRIANGLES) whose diamond is triangulated EXACTLY like the mesh
 * — (N,E,S),(N,S,W) — so the instance surface inside the diamond IS the mesh top face, exact at
 * every point, not just the corners. The frame corners keep the old bilinear drop so the skirt
 * hangs as before. Solving for frame-vertex drops that hit the mesh corners exactly was rejected:
 * the system is near-singular (determinant 0.006 at the 2x frame) and the solution swings to
 * +/-22 levels, which would throw the skirt hundreds of px off — the fold itself had to change.
 *
 * This test evaluates the REAL triangulation table (imported from the render source, the same
 * data the shader embeds) against the mesh surface, and drives the REAL mesh builder
 * (TilemapRenderer.build, mock GL — harness copied from adr409_slopes.test.ts) to pin the fixed
 * cliff quads. It asserts the invariant (instance height == mesh height) at the diamond corners,
 * the centre, and interior points, in both frame scales and all four view rotations.
 *
 * Transcription sources (unchanged parts):
 *  - Mesh: packages/render/src/tilemap.ts:226-229: top corners [(x,y),(x+1,y),(x+1,y+1),(x,y+1)]
 *    at h-cornerDrops, indices (0,1,2),(0,2,3) — fold on the 0-2 (N-S) diagonal.
 *  - Frame geometry: groundArt.ts:8-9 / task410-art.ts:16-18 — 68x52 cell, anchor (34,18);
 *    the drawn season may use the @2x page (136x104, anchor 68,36 — atlasManager.ts:744).
 *    Both scales are tested; both now agree.
 *  - Diamond corners in frame px (FS inDiamond test, |q.x|/32+|q.y|/16<=1.02): N=(ax,ay-16),
 *    E=(ax+32,ay), S=(ax,ay+16), W=(ax-32,ay).
 */
import { describe, it, expect } from "vitest";
import { classifyGroundShape, TileMap, tileToLocal, type GroundNeighbourhood } from "@engine/world";
import { TERRAIN_TILE_VERTEX_TABLE, TERRAIN_TILE_VERTEX_COUNT, TERRAIN_TILE_DIAMOND } from "../src/terrainTileTriangulation.js";
import { TilemapRenderer, CLIFF_PX, CLIFF_PY } from "../src/tilemap.js";

type CornerDrops = [0 | 1, 0 | 1, 0 | 1, 0 | 1];
interface Frame { w: number; h: number; ax: number; ay: number }
const FRAMES: Record<string, Frame> = {
  "1x": { w: 68, h: 52, ax: 34, ay: 18 },
  "2x": { w: 136, h: 104, ax: 68, ay: 36 },
};
const UISO = [32, 16] as const;

/** VS sdrop at frame pixel (px,py) for corner drops sc (view-space order sc00..sc11 = N,E,S,W corners). Kept for the FRAME-corner vertices, which still tilt by bilinear interpolation (ADR-418). */
function vsDrop(px: number, py: number, sc: CornerDrops, f: Frame): number {
  const sd = [(px - f.ax) / UISO[0], (py - f.ay) / UISO[1]];
  const sfu = Math.min(1, Math.max(0, ((sd[0]! + sd[1]!) * 0.5 + 0.5)));
  const sfv = Math.min(1, Math.max(0, ((sd[1]! - sd[0]!) * 0.5 + 0.5)));
  const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
  return mix(mix(sc[0], sc[1], sfu), mix(sc[3], sc[2], sfu), sfv);
}
type Pt = readonly [number, number];
function bary(p: Pt, a: Pt, b: Pt, c: Pt): [number, number, number] | null {
  const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (d === 0) return null; // degenerate triangle (legacy 64x48 frame: N sits on the top edge)
  const w0 = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / d;
  const w1 = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / d;
  const w2 = 1 - w0 - w1;
  return w0 >= -1e-9 && w1 >= -1e-9 && w2 >= -1e-9 && w0 <= 1 + 1e-9 && w1 <= 1 + 1e-9 && w2 <= 1 + 1e-9 ? [w0, w1, w2] : null;
}
/** Height of a piecewise-linear surface at p, given its triangles (vertex px + heights). */
function surfHeight(p: Pt, verts: Pt[], hs: number[], tris: [number, number, number][]): number {
  for (const t of tris) {
    const w = bary(p, verts[t[0]]!, verts[t[1]]!, verts[t[2]]!);
    if (w) return w[0] * hs[t[0]]! + w[1] * hs[t[1]]! + w[2] * hs[t[2]]!;
  }
  throw new Error(`point ${p} is in no triangle`);
}
/**
 * Instance (textured) surface height at frame point p, from the REAL triangulation table: 30
 * vertices, kind 0 = frame corner at fraction (x, y) with the bilinear drop, kind 1 = diamond
 * corner at anchor + (x, y) * uIso with its own corner's drop. Triangles are consecutive triples.
 */
function instanceHeight(p: Pt, sc: CornerDrops, h: number, f: Frame): number {
  const verts: Pt[] = [];
  const hs: number[] = [];
  for (const [x, y, kind] of TERRAIN_TILE_VERTEX_TABLE) {
    if (kind === 0) {
      const px: Pt = [x * f.w, y * f.h];
      verts.push(px);
      hs.push(h - vsDrop(px[0], px[1], sc, f));
    } else {
      const px: Pt = [f.ax + x * UISO[0], f.ay + y * UISO[1]];
      verts.push(px);
      const corner = x > 0 ? 1 : x < 0 ? 3 : y < 0 ? 0 : 2; // E=1, W=3, N=0, S=2
      hs.push(h - sc[corner]!);
    }
  }
  const tris: [number, number, number][] = [];
  for (let i = 0; i < TERRAIN_TILE_VERTEX_COUNT; i += 3) tris.push([i, i + 1, i + 2]);
  return surfHeight(p, verts, hs, tris);
}
/** Mesh (vertex-colour) surface height at frame point p: diamond corners, fold on the N-S diagonal. */
function meshHeight(p: Pt, sc: CornerDrops, h: number, f: Frame): number {
  const verts: Pt[] = [[f.ax, f.ay - 16], [f.ax + 32, f.ay], [f.ax, f.ay + 16], [f.ax - 32, f.ay]];
  const hs = [h - sc[0], h - sc[1], h - sc[2], h - sc[3]];
  return surfHeight(p, verts, hs, [[0, 1, 2], [0, 2, 3]]);
}
const diamondCorners = (f: Frame): Record<"N" | "E" | "S" | "W" | "C", Pt> => ({
  N: [f.ax, f.ay - 16], E: [f.ax + 32, f.ay], S: [f.ax, f.ay + 16], W: [f.ax - 32, f.ay], C: [f.ax, f.ay],
});
/** Interior points of the diamond (sd coords around the anchor): edge midpoints + off-centre points. */
const diamondInterior = (f: Frame): Pt[] => {
  const at = (dx: number, dy: number): Pt => [f.ax + dx * UISO[0], f.ay + dy * UISO[1]];
  return [at(0, 0), at(0.5, -0.5), at(0.5, 0.5), at(-0.5, 0.5), at(-0.5, -0.5), at(0.25, 0), at(-0.25, 0.25)];
};

const nb = (h: number, edge: [number, number, number, number], diag: [number, number, number, number] = [h, h, h, h]): GroundNeighbourhood => ({ h, edge, diag });
/** Real shapes from classifyGroundShape (view-space neighbourhoods; the VS math is view-space). */
const SHAPES: { name: string; shape: ReturnType<typeof classifyGroundShape> }[] = [
  { name: "ramp +u", shape: classifyGroundShape(nb(5, [4, 5, 5, 5])) },
  { name: "ramp +v", shape: classifyGroundShape(nb(5, [5, 5, 4, 5])) },
  { name: "wedge low S", shape: classifyGroundShape(nb(5, [4, 5, 4, 5])) },
  { name: "wedge low N", shape: classifyGroundShape(nb(5, [5, 4, 5, 4])) },
  { name: "diagonal dimple W", shape: classifyGroundShape(nb(5, [5, 5, 5, 5], [5, 5, 4, 5])) },
];
/** 90 deg CCW rotation of corner drops about the tile centre (view rotations permute them). */
const rotDrops = (d: CornerDrops): CornerDrops => [d[3], d[0], d[1], d[2]];

/** Run the REAL mesh builder, decode its vertex buffer: {x, y, z, flag} per vertex (flag 0 top, 1 water, 2..5 cliff). Harness copied from adr409_slopes.test.ts. */
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
/** Cliff quads are emitted as 4 consecutive vertices: group the flat vertex list into quads. */
const quads = (verts: { x: number; y: number; z: number; flag: number }[]): { x: number; y: number; z: number; flag: number }[][] => {
  const out: { x: number; y: number; z: number; flag: number }[][] = [];
  for (let i = 0; i + 3 < verts.length; i += 4) out.push(verts.slice(i, i + 4));
  return out;
};

describe("ADR-418 instance vs mesh: textured diamond corners must sit on the mesh top face", () => {
  it("the table triangulates the diamond exactly like the mesh (first two triangles) and has 30 vertices", () => {
    expect(TERRAIN_TILE_VERTEX_COUNT).toBe(30);
    expect(TERRAIN_TILE_VERTEX_TABLE.length).toBe(30);
    const { N, E, S, W } = TERRAIN_TILE_DIAMOND;
    expect(TERRAIN_TILE_VERTEX_TABLE.slice(0, 6)).toEqual([N, E, S, N, S, W]);
    for (const [x, y, kind] of TERRAIN_TILE_VERTEX_TABLE) {
      expect(kind === 0 || kind === 1).toBe(true);
      if (kind === 0) { expect(x === 0 || x === 1).toBe(true); expect(y === 0 || y === 1).toBe(true); }
      else expect([[0, -1], [1, 0], [0, 1], [-1, 0]]).toContainEqual([x, y]);
    }
  });

  for (const [scale, f] of Object.entries(FRAMES)) {
    it(`every sloped shape agrees with the mesh at all diamond corners (${scale} frame ${f.w}x${f.h})`, () => {
      for (const { name, shape } of SHAPES) {
        const sc = shape.cornerDrops;
        for (const [cn, p] of Object.entries(diamondCorners(f))) {
          const inst = instanceHeight(p, sc, 5, f);
          const mesh = meshHeight(p, sc, 5, f);
          // INVARIANT: the textured diamond corner sits exactly on the mesh corner.
          // Before the fix the worst was +0.71 levels (1x) / +0.83 (2x); now it is exact.
          expect(inst, `${name} ${scale} corner ${cn}: instance ${inst.toFixed(3)} vs mesh ${mesh.toFixed(3)}`).toBeCloseTo(mesh, 9);
        }
      }
    });

    it(`every sloped shape agrees with the mesh everywhere inside the diamond (${scale} frame)`, () => {
      // The diamond triangles are the mesh triangles, so the surfaces coincide at every interior
      // point too — not just the corners. (The old strip agreed only on flat tiles.)
      for (const { name, shape } of SHAPES) {
        const sc = shape.cornerDrops;
        for (const p of diamondInterior(f)) {
          const inst = instanceHeight(p, sc, 5, f);
          const mesh = meshHeight(p, sc, 5, f);
          expect(inst, `${name} ${scale} interior ${p}: instance ${inst.toFixed(3)} vs mesh ${mesh.toFixed(3)}`).toBeCloseTo(mesh, 9);
        }
      }
    });
  }

  it("all four view rotations: the fold holds for every rotated corner-drop pattern", () => {
    // A view rotation permutes the corner drops; the table is view-space, so the instance must
    // match the mesh for each rotation of each shape, in both frame scales.
    for (const f of Object.values(FRAMES)) {
      for (const { name, shape } of SHAPES) {
        let sc: CornerDrops = shape.cornerDrops;
        for (let q = 0; q < 4; q++) {
          for (const p of Object.values(diamondCorners(f))) {
            expect(instanceHeight(p, sc, 5, f), `${name} q${q} at ${p}`).toBeCloseTo(meshHeight(p, sc, 5, f), 9);
          }
          sc = rotDrops(sc);
        }
      }
    }
  });

  it("adjacent instances disagree at their shared vertex: the ramp's low corner floats above the flat neighbour", () => {
    // Ramp +u tile (h=5, corners [0,1,1,0]) shares its E vertex with the flat h=4 neighbour's W vertex.
    const f = FRAMES["1x"]!;
    const ramp = classifyGroundShape(nb(5, [4, 5, 5, 5]));
    const rampE = instanceHeight(diamondCorners(f).E, ramp.cornerDrops, 5, f);
    const flatW = instanceHeight(diamondCorners(f).W, [0, 0, 0, 0], 4, f);
    expect(rampE).toBeCloseTo(4, 9); // the mesh puts this vertex at 4.0; the instance used to put it at ~4.35
    // INVARIANT: the two textured diamonds must meet at the shared vertex.
    expect(rampE).toBeCloseTo(flatW, 9);
  });

  it("CONTROL (passes): flat tiles agree exactly — the defect is slope-only", () => {
    for (const f of Object.values(FRAMES)) {
      for (const p of Object.values(diamondCorners(f))) {
        expect(instanceHeight(p, [0, 0, 0, 0], 5, f)).toBeCloseTo(meshHeight(p, [0, 0, 0, 0], 5, f), 9);
      }
    }
  });
});

describe("ADR-418 mesh cliff quads follow both top faces (real TilemapRenderer.build)", () => {
  it("terraced dirt: the +x cliff bottom reaches the neighbour's dropped corner (z=3), top follows the tile's own edge", () => {
    // T=(11,11) h=5, +x neighbour (12,11)=4, +y neighbour (11,12)=3: the neighbour's shared
    // vertex (12,12) drops to 3, so the old flat-bottomed cliff (z 4..5) left a 1-level hole.
    const map = new TileMap();
    fillChunk(map, { "12,11": 4, "11,12": 3 });
    const verts = buildMesh(map);
    const px = quads(verts).filter((q) => q.every((v) => v.flag === CLIFF_PX && v.x === 12 && (v.y === 11 || v.y === 12)));
    expect(px).toHaveLength(1);
    // Quad order: [top (12,11), top (12,12), bottom (12,12), bottom (12,11)] — a trapezoid:
    // top follows T's edge [4,5], bottom follows the neighbour's edge [4,3].
    expect(px[0]!.map((v) => v.z)).toEqual([4, 5, 3, 4]);
    expect(px[0]!.map((v) => [v.x, v.y])).toEqual([[12, 11], [12, 12], [12, 12], [12, 11]]);
    // The +y cliff of the same tile drops to the flat neighbour (11,12)=3 on both ends.
    const py = quads(verts).filter((q) => q.every((v) => v.flag === CLIFF_PY && v.y === 12 && (v.x === 11 || v.x === 12)));
    expect(py).toHaveLength(1);
    expect(py[0]!.map((v) => v.z)).toEqual([5, 5, 3, 3]);
  });

  it("a 2-level step keeps its flat cliff (no slope involved: bit-identical behaviour)", () => {
    const map = new TileMap();
    fillChunk(map, { "12,11": 3 });
    const verts = buildMesh(map);
    const px = quads(verts).filter((q) => q.every((v) => v.flag === CLIFF_PX && v.x === 12 && (v.y === 11 || v.y === 12)));
    expect(px).toHaveLength(1);
    expect(px[0]!.map((v) => v.z)).toEqual([5, 5, 3, 3]);
  });

  it("a ramp's slope side still emits no cliff at all", () => {
    const map = new TileMap();
    fillChunk(map, { "12,11": 4 });
    const verts = buildMesh(map);
    const near = verts.filter((v) => v.x >= 11 && v.x <= 13 && v.y >= 11 && v.y <= 13);
    expect(near.filter((v) => v.flag >= 2)).toEqual([]);
  });
});
