/**
 * ADR-569: the falls envelope (WATERFALL_ART_MAX_DROP = 8) is enforced in both renderers.
 *
 * Art path: waterfallFallPlacements (the single planner consumed by WebGL instancing in
 * terrainTiles.ts and by Canvas2D's drawWaterfallArt) stacks sheets for at most 8 levels
 * from the top; below that the face is the quiet mesh face. Lip stays at the top, the pool
 * anchors at the bottom of the face (the destination surface), not at the capped stack.
 * Fallback path: the mesh builder splits an over-envelope waterfall face into an animated
 * top segment (flag 6..9, at most 8 levels — the band phase in TILEMAP_FS is unchanged and
 * now bounded) plus a quiet segment (flag 10..13, remapped to vFlags 7: shaded like a
 * waterfall face, never streaked). Drops within the envelope (2..8) are byte/instance
 * identical to the pre-ADR-569 behaviour — the exact counts at drops 2 and 8 are pinned.
 */
import { describe, expect, it } from "vitest";
import { CHUNK_SIZE, DEFAULT_ISO, TileMap, Chunk, flowWaterRaw } from "@engine/world";
import { TileId } from "../src/ids.js";
import {
  WATERFALL_ART_MAX_DROP, waterfallFallPlacements, planWaterfallArt, allWaterfallArtKeys,
  type WaterfallSeg,
} from "../src/waterfallTiles.js";
import {
  TilemapRenderer, TILEMAP_FS, cliffShade, CLIFF_PX,
  WATERFALL_PX, WATERFALL_QUIET_PX,
} from "../src/tilemap.js";
import { TileTerrain } from "../src/terrainTiles.js";
import { Canvas2DRenderer } from "../src/canvas2d.js";

const HAS_ART = new Set(allWaterfallArtKeys());
const hasArt = (k: string): boolean => HAS_ART.has(k);

const seg = (drop: number): WaterfallSeg => ({ role: "fall", dir: "px", x: 5, y: 5, topZ: 100.75, botZ: 100.75 - drop, drop });

describe("ADR-569 art path: sheet stacking is capped at the envelope", () => {
  it("within-envelope counts are EXACTLY the pre-fix behaviour (drops 2 and 8 pinned)", () => {
    expect(waterfallFallPlacements(seg(2), hasArt)).toEqual([
      { z: 100.75, key: "gt_waterfall_sheet_2_px", flipX: false },
    ]);
    expect(waterfallFallPlacements(seg(8), hasArt)).toEqual([
      { z: 100.75, key: "gt_waterfall_sheet_2_px", flipX: false },
      { z: 98.75, key: "gt_waterfall_sheet_2_px", flipX: false },
      { z: 96.75, key: "gt_waterfall_sheet_2_px", flipX: false },
      { z: 94.75, key: "gt_waterfall_sheet_2_px", flipX: false },
    ]);
    // A 1-level cascade step is untouched too.
    expect(waterfallFallPlacements(seg(1), hasArt)).toEqual([
      { z: 100.75, key: "gt_waterfall_sheet_1_px", flipX: false },
    ]);
  });

  it("over-envelope drops (9, 70, 100) stack no more sheets than a drop of 8, all in the top 8 levels", () => {
    const at8 = waterfallFallPlacements(seg(8), hasArt);
    for (const drop of [9, 70, 100]) {
      const pl = waterfallFallPlacements(seg(drop), hasArt);
      expect(pl).toEqual(at8); // same sheets, same z — the stack covers the top 8 levels only
      expect(pl.length).toBe(4);
      expect(Math.min(...pl.map((p) => p.z))).toBeGreaterThan(100.75 - WATERFALL_ART_MAX_DROP);
    }
  });

  it("the cap also bounds the sheet_1-only fallback stacking", () => {
    const only1 = (k: string): boolean => k.includes("sheet_1");
    expect(waterfallFallPlacements(seg(70), only1)).toHaveLength(WATERFALL_ART_MAX_DROP);
    expect(waterfallFallPlacements(seg(3), only1)).toHaveLength(3); // within envelope: unchanged
  });
});

/** Grass plateau at 5; a water source at (5,5) at level `drop`, dest water at (6,5) at level 0,
 *  the source's other neighbours are water at the source's level (no extra faces). */
function fallMap(drop: number): TileMap {
  const map = new TileMap();
  const c = new Chunk(0, 0);
  for (let ly = 0; ly < CHUNK_SIZE; ly++) for (let lx = 0; lx < CHUNK_SIZE; lx++) {
    c.set(lx, ly, TileId.Grass); c.setHeight(lx, ly, 5);
  }
  const water = (x: number, y: number, level: number): void => { c.set(x, y, TileId.Water); c.setHeight(x, y, flowWaterRaw(level)); };
  water(5, 5, drop); water(6, 5, 0);
  water(4, 5, drop); water(5, 4, drop); water(5, 6, drop);
  map.insertChunk(c);
  return map;
}

describe("ADR-569 plan: lip at the top, pool at the bottom, sheets capped — at every drop", () => {
  it.each([2, 8, 9, 70, 100])("drop %i: plan counts and anchors", (drop) => {
    const map = fallMap(drop);
    const src = planWaterfallArt(map, 5, 5, hasArt, 0);
    const falls = src.filter((i) => i.role === "fall");
    const lips = src.filter((i) => i.role === "lip");
    const expectedSheets = drop <= 2 ? 1 : Math.ceil(Math.min(drop, WATERFALL_ART_MAX_DROP) / 2);
    expect(falls).toHaveLength(expectedSheets);
    expect(falls.every((i) => i.z > drop - 0.25 - WATERFALL_ART_MAX_DROP)).toBe(true); // sheets live in the top 8 levels
    expect(lips).toHaveLength(1);
    expect(lips[0]!.z).toBe(drop - 0.25); // lip at the top of the face (source surface)
    const dst = planWaterfallArt(map, 6, 5, hasArt, 0);
    expect(dst).toHaveLength(1);
    expect(dst[0]).toMatchObject({ role: "pool", z: -0.25 }); // pool at the BOTTOM (dest surface), even for a 100-level fall
  });
});

/** Run the real WebGL instanced builder (TileTerrain.build) and return its instance rows. */
function buildTerrainRows(map: TileMap): number[][] {
  let uploaded = new Float32Array();
  const gl = {
    createVertexArray: () => ({}), createBuffer: () => ({}), bindVertexArray: () => {}, bindBuffer: () => {},
    bufferData: (_t: unknown, data: Float32Array<ArrayBuffer>) => { uploaded = data; },
    enableVertexAttribArray: () => {}, vertexAttribPointer: () => {}, vertexAttribDivisor: () => {},
    deleteVertexArray: () => {},
  };
  const ground = { id: (_k: string): number => 1 };
  const terrain = Object.assign(Object.create(TileTerrain.prototype), { gl, builds: 0, grazedRev: 0, ground: () => ground });
  const atlas = {
    registry: { ids: { sprites: { tryId: () => 1 } } },
    animEntries: (_id: number) => ({ first: 0, count: 1, fps: 0, ax: 34, ay: 18 }), version: 0,
  } as never;
  terrain.build(map, map.getChunk(0, 0), atlas, undefined, 1, 0);
  const rows: number[][] = [];
  for (let i = 0; i < uploaded.length; i += 16) rows.push([...uploaded.slice(i, i + 16)]);
  return rows;
}

/** Run the real Canvas2D drawWaterfallArt over ONE tile and return drawn image keys. */
function drawCanvas2D(map: TileMap, tx: number, ty: number): string[] {
  const drawn: string[] = [];
  const ctx = {
    save: () => {}, restore: () => {}, translate: () => {}, scale: () => {},
    drawImage: (img: { url: string }) => { drawn.push(img.url); },
  };
  const keys = allWaterfallArtKeys();
  const registry = {
    ids: { sprites: { tryId: (k: string) => { const i = keys.indexOf(k); return i >= 0 ? i : undefined; } } },
    dirFrame: (id: number) => ({ atlas: { key: keys[id]! }, x: 0, y: 0, w: 68, h: 52, anchorX: 34, anchorY: 18 }),
  };
  const r = Object.assign(Object.create(Canvas2DRenderer.prototype), {
    ctx, registry, camera: { iso: { ...DEFAULT_ISO } }, image: (k: string) => ({ url: k }),
  });
  (r as unknown as { drawWaterfallArt: (m: TileMap, x: number, y: number, n: number, t: number) => void })
    .drawWaterfallArt(map, tx, ty, 1, 0);
  return drawn;
}

describe("ADR-569 both renderers agree on placement counts for the same face", () => {
  it.each([2, 8, 9, 70, 100])("drop %i: WebGL instances == Canvas2D draws == plan", (drop) => {
    const map = fallMap(drop);
    const plan = planWaterfallArt(map, 5, 5, hasArt, 0);
    const planPool = planWaterfallArt(map, 6, 5, hasArt, 0);
    // WebGL instanced path: rows are [x, y, z, first, count, fps, mask, ?, ax, ay, water, mode, ...]; mode 3 = fall sheet, 4 = overlay.
    const rows = buildTerrainRows(map);
    const glFalls = rows.filter((r) => r[0] === 5.5 && r[1] === 5.5 && r[11] === 3);
    const glLips = rows.filter((r) => r[0] === 5.5 && r[1] === 5.5 && r[11] === 4);
    const glPools = rows.filter((r) => r[0] === 6.5 && r[1] === 5.5 && r[11] === 4);
    expect(glFalls).toHaveLength(plan.filter((i) => i.role === "fall").length);
    expect(glLips).toHaveLength(plan.filter((i) => i.role === "lip").length);
    expect(glPools).toHaveLength(planPool.filter((i) => i.role === "pool").length);
    // Canvas2D path: one drawImage per planned instance, per tile.
    const drawnSrc = drawCanvas2D(map, 5, 5);
    const drawnDst = drawCanvas2D(map, 6, 5);
    expect(drawnSrc.filter((k) => k.includes("sheet"))).toHaveLength(glFalls.length);
    expect(drawnSrc.filter((k) => k.includes("lip"))).toHaveLength(glLips.length);
    expect(drawnDst.filter((k) => k.includes("pool"))).toHaveLength(glPools.length);
  });
});

/** Run the real mesh builder with a stub GL (ADR-389/415 pattern) and decode {x,y,z,flag} verts. */
function buildMeshVerts(map: TileMap): { x: number; y: number; z: number; flag: number }[] {
  const captured: ArrayBuffer[] = [];
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, ACTIVE_UNIFORMS: 5,
    ARRAY_BUFFER: 6, ELEMENT_ARRAY_BUFFER: 7, STATIC_DRAW: 8, FLOAT: 9, UNSIGNED_BYTE: 10,
    TRIANGLES: 11, UNSIGNED_SHORT: 12, UNSIGNED_INT: 13,
    createProgram: () => ({}), createShader: () => ({}), shaderSource: () => {}, compileShader: () => {},
    getShaderParameter: () => true, getShaderInfoLog: () => "",
    attachShader: () => {}, linkProgram: () => {},
    getProgramParameter: (_p: unknown, name: number) => (name === 4 ? true : 0),
    getProgramInfoLog: () => "", getActiveUniform: () => null, getUniformLocation: () => null,
    createVertexArray: () => ({}), createBuffer: () => ({}),
    bindVertexArray: () => {}, bindBuffer: () => {},
    bufferData: (target: number, data: ArrayBuffer | ArrayBufferView) => {
      if (target !== 6) return;
      if (data instanceof ArrayBuffer) captured.push(data);
      else if (ArrayBuffer.isView(data)) captured.push(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    },
    enableVertexAttribArray: () => {}, vertexAttribPointer: () => {},
    deleteVertexArray: () => {}, deleteBuffer: () => {},
    useProgram: () => {}, uniform1f: () => {}, uniform2f: () => {}, uniform3f: () => {}, uniform4fv: () => {}, uniform2fv: () => {},
    drawElements: () => {},
  } as unknown as WebGL2RenderingContext;
  const renderer = new TilemapRenderer(gl, { ...DEFAULT_ISO }, 1);
  renderer.sync(map);
  const out: { x: number; y: number; z: number; flag: number }[] = [];
  for (const buf of captured) {
    const f = new Float32Array(buf); const u8 = new Uint8Array(buf);
    for (let k = 0; k < f.length / 4; k++) out.push({ x: f[k * 4]!, y: f[k * 4 + 1]!, z: f[k * 4 + 2]!, flag: u8[k * 16 + 15]! });
  }
  return out;
}

/** Mesh-only map: just the source and destination water tiles; every other face borders the
 *  void (plain cliff flags), so flag 6 / flag 10 verts belong to the source's +x face alone. */
function meshMap(drop: number): TileMap {
  const map = new TileMap();
  const c = new Chunk(0, 0);
  c.set(5, 5, TileId.Water); c.setHeight(5, 5, flowWaterRaw(drop));
  c.set(6, 5, TileId.Water); c.setHeight(6, 5, flowWaterRaw(0));
  map.insertChunk(c);
  return map;
}

describe("ADR-569 fallback path: over-envelope mesh faces split into animated top + quiet remainder", () => {
  it("a drop of exactly 8 stays ONE waterfall quad spanning the whole face (pre-fix geometry)", () => {
    const verts = buildMeshVerts(meshMap(8));
    const wf = verts.filter((v) => v.flag === WATERFALL_PX);
    const quiet = verts.filter((v) => v.flag === WATERFALL_QUIET_PX);
    expect(wf).toHaveLength(4);
    expect(quiet).toHaveLength(0);
    expect(new Set(wf.map((v) => v.z))).toEqual(new Set([7.75, -0.25])); // top surface to dest surface
  });

  it.each([9, 70, 100])("drop %i: waterfall quad covers only the top 8 levels; the rest is one quiet quad, no gap", (drop) => {
    const verts = buildMeshVerts(meshMap(drop));
    const wf = verts.filter((v) => v.flag === WATERFALL_PX);
    const quiet = verts.filter((v) => v.flag === WATERFALL_QUIET_PX);
    expect(wf).toHaveLength(4);
    expect(quiet).toHaveLength(4);
    const top = drop - 0.25, split = top - WATERFALL_ART_MAX_DROP, bot = -0.25;
    expect(new Set(wf.map((v) => v.z))).toEqual(new Set([top, split]));
    expect(new Set(quiet.map((v) => v.z))).toEqual(new Set([split, bot])); // shares the split edge: full coverage, no gap
  });

  it("quiet faces shade exactly like their waterfall normal, and the shader never streaks them", () => {
    for (let q = 0; q < 4; q++) expect(cliffShade(WATERFALL_QUIET_PX, q)).toBe(cliffShade(CLIFF_PX, q));
    // VS remaps quiet flags 10..13 to vFlags 7; FS streaks only flag 6 and treats 7 like 6 elsewhere.
    expect(TILEMAP_FS).toContain("vFlags == 6 || vFlags == 7");
    expect(TILEMAP_FS).toContain("if (vFlags == 6) {"); // streaks are gated to flag 6 only, inside the art-off branch
    expect(TILEMAP_FS).toContain("vFlags != 6 && vFlags != 7");
    // The band formula itself is unchanged — flag 6 now spans at most 8 levels by construction.
    expect(TILEMAP_FS).toContain("float band = 0.5 + 0.5 * sin(vZ * 9.0 + uTime * 6.0 + along * 2.0);");
  });
});
