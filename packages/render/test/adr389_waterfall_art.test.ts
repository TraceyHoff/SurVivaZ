/**
 * ADR-389: waterfall detection / classification (lip, 1- and 2-level sheets, splash pool)
 * and the animated-tile hook for Art's packed keys (docs/ART_KEYS_WATERFALL.md).
 */
import { describe, expect, it } from "vitest";
import { CHUNK_SIZE, DEFAULT_ISO, TileMap, Chunk, flowWaterRaw } from "@engine/world";
import { TileId } from "../src/ids.js";
import {
  WATERFALL_PX, WATERFALL_PY, WATERFALL_NX, WATERFALL_NY, WATERFALL_MIN_DROP, tileHeight,
} from "../src/tilemap.js";
import {
  WATERFALL_DIRS, WATERFALL_ART_MAX_DROP, WATERFALL_ANIM, WATERFALL_EXPECT_FRAMES, WATERFALL_EXPECT_FPS,
  WATERFALL_ART_MODE, WATERFALL_OVERLAY_MODE, WATERFALL_FLIP_X, classifyWaterfallAt, waterfallArtKeys, pickWaterfallArt,
  waterfallFallPlacements, viewMaskForWorldDir, planWaterfallArt, allWaterfallArtKeys, tileSurfaceHeight,
  packedWaterfallDir, waterfallArtResident,
} from "../src/waterfallTiles.js";
import { TERRAIN_TILES_VS, TERRAIN_TILES_FS } from "../src/terrainTiles.js";
import { TilemapRenderer, TILEMAP_FS } from "../src/tilemap.js";
import { isoZDepthFactor } from "../src/depth.js";

function plateau(): { map: TileMap; c: Chunk } {
  const map = new TileMap();
  const c = new Chunk(0, 0);
  for (let ly = 0; ly < CHUNK_SIZE; ly++) for (let lx = 0; lx < CHUNK_SIZE; lx++) {
    c.set(lx, ly, TileId.Grass); c.setHeight(lx, ly, 5);
  }
  map.insertChunk(c);
  return { map, c };
}

const HAS_ART = new Set(allWaterfallArtKeys());
const hasArt = (k: string): boolean => HAS_ART.has(k);

describe("ADR-389 waterfall classification", () => {
  it("a 2-level water-to-water drop is lip + fall on the source and a pool on the destination, flowing +x", () => {
    const { map, c } = plateau();
    c.set(5, 5, TileId.Water); c.setHeight(5, 5, flowWaterRaw(6));
    c.set(6, 5, TileId.Water); c.setHeight(6, 5, flowWaterRaw(4));
    expect(tileHeight(map, 5, 5)).toBe(6);
    expect(tileSurfaceHeight(map, 5, 5) - tileSurfaceHeight(map, 6, 5)).toBe(2);

    const src = classifyWaterfallAt(map, 5, 5);
    expect(src.map((s) => s.role).sort()).toEqual(["fall", "lip"]);
    expect(src.every((s) => s.dir === "px" && s.drop === 2)).toBe(true);
    expect(src[0]!.x).toBe(5); expect(src[0]!.y).toBe(5);

    const dst = classifyWaterfallAt(map, 6, 5);
    expect(dst).toHaveLength(1);
    // Pool uses the same flow dir as the incoming sheet (px), not the dir toward the source.
    expect(dst[0]).toMatchObject({ role: "pool", dir: "px", x: 6, y: 5, drop: 2 });
  });

  it("an ordinary 1-level ledge, a land cliff, and a void neighbour are not waterfalls", () => {
    const { map, c } = plateau();
    c.set(5, 7, TileId.Water); c.setHeight(5, 7, flowWaterRaw(6));
    c.set(6, 7, TileId.Water); c.setHeight(6, 7, flowWaterRaw(5));
    c.setHeight(5, 9, 8); c.setHeight(6, 9, 1);
    c.set(15, 5, TileId.Water); c.setHeight(15, 5, flowWaterRaw(6)); // +x edge, no neighbour chunk
    expect(classifyWaterfallAt(map, 5, 7)).toEqual([]);
    expect(classifyWaterfallAt(map, 5, 9)).toEqual([]);
    expect(classifyWaterfallAt(map, 15, 5)).toEqual([]);
  });

  it("a 1-level water-to-water step after a 2-level fall is sheet_1 + pool, with no lip", () => {
    const { map, c } = plateau();
    c.set(5, 5, TileId.Water); c.setHeight(5, 5, flowWaterRaw(6));
    c.set(6, 5, TileId.Water); c.setHeight(6, 5, flowWaterRaw(4));
    c.set(7, 5, TileId.Water); c.setHeight(7, 5, flowWaterRaw(3));
    const mid = classifyWaterfallAt(map, 6, 5);
    expect(mid.some((s) => s.role === "pool" && s.dir === "px" && s.drop === 2)).toBe(true);
    expect(mid.some((s) => s.role === "fall" && s.dir === "px" && s.drop === 1)).toBe(true);
    expect(mid.some((s) => s.role === "lip")).toBe(false);
    const pool = classifyWaterfallAt(map, 7, 5);
    expect(pool).toEqual([expect.objectContaining({ role: "pool", dir: "px", x: 7, y: 5, drop: 1 })]);
    expect(planWaterfallArt(map, 6, 5, hasArt, 0).some((i) => i.role === "fall" && i.key === "gt_waterfall_sheet_1_px")).toBe(true);
    expect(planWaterfallArt(map, 7, 5, hasArt, 0).some((i) => i.role === "pool" && i.key === "gt_waterfall_pool_px")).toBe(true);
  });

  it("classifies all four flow directions and records drop height", () => {
    const { map, c } = plateau();
    c.set(8, 8, TileId.Water); c.setHeight(8, 8, flowWaterRaw(8));
    c.set(9, 8, TileId.Water); c.setHeight(9, 8, flowWaterRaw(5));
    c.set(8, 9, TileId.Water); c.setHeight(8, 9, flowWaterRaw(5));
    c.set(7, 8, TileId.Water); c.setHeight(7, 8, flowWaterRaw(5));
    c.set(8, 7, TileId.Water); c.setHeight(8, 7, flowWaterRaw(5));
    const src = classifyWaterfallAt(map, 8, 8);
    const faces = src.filter((s) => s.role === "fall").map((s) => s.dir).sort();
    expect(faces).toEqual(["nx", "ny", "px", "py"]);
    expect(src.filter((s) => s.role === "fall").every((s) => s.drop === 3)).toBe(true);
    expect(classifyWaterfallAt(map, 9, 8).some((s) => s.role === "pool" && s.dir === "px")).toBe(true);
    expect(classifyWaterfallAt(map, 8, 7).some((s) => s.role === "pool" && s.dir === "ny")).toBe(true);
  });
});

describe("ADR-389 art keys and hook", () => {
  it("names Art's packed px/nx keys; py/ny are flipX of those", () => {
    expect(WATERFALL_MIN_DROP).toBe(2);
    expect(WATERFALL_ART_MAX_DROP).toBe(8);
    expect(WATERFALL_ANIM).toBe("idle");
    expect(WATERFALL_EXPECT_FRAMES).toBe(6);
    expect(WATERFALL_EXPECT_FPS).toBe(8);
    expect(WATERFALL_DIRS).toEqual(["px", "py", "nx", "ny"]);
    expect(packedWaterfallDir("px")).toEqual({ keyDir: "px", flipX: false });
    expect(packedWaterfallDir("py")).toEqual({ keyDir: "px", flipX: true });
    expect(packedWaterfallDir("nx")).toEqual({ keyDir: "nx", flipX: false });
    expect(packedWaterfallDir("ny")).toEqual({ keyDir: "nx", flipX: true });
    expect(waterfallArtKeys({ role: "fall", dir: "px", x: 0, y: 0, topZ: 6, botZ: 2, drop: 4 })[0]).toBe("gt_waterfall_sheet_2_px");
    expect(waterfallArtKeys({ role: "fall", dir: "py", x: 0, y: 0, topZ: 4, botZ: 3, drop: 1 })[0]).toBe("gt_waterfall_sheet_1_px");
    expect(waterfallArtKeys({ role: "lip", dir: "py", x: 0, y: 0, topZ: 1, botZ: 0, drop: 2 })[0]).toBe("gt_waterfall_lip_px");
    expect(waterfallArtKeys({ role: "pool", dir: "ny", x: 0, y: 0, topZ: 1, botZ: 0, drop: 2 })[0]).toBe("gt_waterfall_pool_nx");
    expect(pickWaterfallArt(() => false, { role: "fall", dir: "px", x: 0, y: 0, topZ: 4, botZ: 2, drop: 2 })).toBeUndefined();
    expect(allWaterfallArtKeys()).toEqual([
      "gt_waterfall_lip_px", "gt_waterfall_sheet_1_px", "gt_waterfall_sheet_2_px", "gt_waterfall_pool_px",
      "gt_waterfall_lip_nx", "gt_waterfall_sheet_1_nx", "gt_waterfall_sheet_2_nx", "gt_waterfall_pool_nx",
    ]);
    expect(waterfallArtResident(hasArt)).toBe(true);
    expect(waterfallArtResident(() => false)).toBe(false);
  });

  it("stacks sheet_2 then sheet_1 for a drop greater than 2; does not stretch", () => {
    const seg = { role: "fall" as const, dir: "px" as const, x: 1, y: 1, topZ: 5.75, botZ: 1.75, drop: 4 };
    expect(waterfallFallPlacements(seg, hasArt)).toEqual([
      { z: 5.75, key: "gt_waterfall_sheet_2_px", flipX: false },
      { z: 3.75, key: "gt_waterfall_sheet_2_px", flipX: false },
    ]);
    const d3 = { ...seg, botZ: 2.75, drop: 3 };
    expect(waterfallFallPlacements(d3, hasArt)).toEqual([
      { z: 5.75, key: "gt_waterfall_sheet_2_px", flipX: false },
      { z: 3.75, key: "gt_waterfall_sheet_1_px", flipX: false },
    ]);
    const py = { ...seg, dir: "py" as const, drop: 2, botZ: 3.75 };
    expect(waterfallFallPlacements(py, hasArt)).toEqual([
      { z: 5.75, key: "gt_waterfall_sheet_2_px", flipX: true },
    ]);
  });

  it("view quarter maps world flow dir to the camera-facing mask bit (far faces are 0)", () => {
    expect(viewMaskForWorldDir("px", 0)).toBe(1);
    expect(viewMaskForWorldDir("py", 0)).toBe(2);
    expect(viewMaskForWorldDir("nx", 0)).toBe(0);
    expect(viewMaskForWorldDir("ny", 0)).toBe(0);
    expect(viewMaskForWorldDir("px", 1)).toBe(2);
    expect(viewMaskForWorldDir("ny", 1)).toBe(1);
    expect(viewMaskForWorldDir("nx", 2)).toBe(1);
    expect(viewMaskForWorldDir("py", 3)).toBe(1);
  });

  it("planWaterfallArt is empty without sprites and emits lip + camera-facing fall + pool when they exist", () => {
    const { map, c } = plateau();
    c.set(5, 5, TileId.Water); c.setHeight(5, 5, flowWaterRaw(6));
    c.set(6, 5, TileId.Water); c.setHeight(6, 5, flowWaterRaw(4));
    expect(planWaterfallArt(map, 5, 5, () => false, 0)).toEqual([]);
    const src = planWaterfallArt(map, 5, 5, hasArt, 0);
    expect(src.some((i) => i.role === "lip" && i.key === "gt_waterfall_lip_px" && i.mode === WATERFALL_OVERLAY_MODE && !i.flipX)).toBe(true);
    expect(src.some((i) => i.role === "fall" && i.key === "gt_waterfall_sheet_2_px" && i.mode === WATERFALL_ART_MODE && i.mask === 1)).toBe(true);
    const dst = planWaterfallArt(map, 6, 5, hasArt, 0);
    expect(dst.some((i) => i.role === "pool" && i.key === "gt_waterfall_pool_px" && i.mode === WATERFALL_OVERLAY_MODE)).toBe(true);
    expect(dst.every((i) => i.role === "pool")).toBe(true); // dest water stays; pool is only the overlay
    const far = planWaterfallArt(map, 5, 5, hasArt, 2); // view +X is world -X, so world +X is far
    expect(far.some((i) => i.role === "fall")).toBe(false);
    expect(far.some((i) => i.role === "lip")).toBe(true);
    const pyMap = plateau();
    pyMap.c.set(5, 5, TileId.Water); pyMap.c.setHeight(5, 5, flowWaterRaw(6));
    pyMap.c.set(5, 6, TileId.Water); pyMap.c.setHeight(5, 6, flowWaterRaw(4));
    const pyFall = planWaterfallArt(pyMap.map, 5, 5, hasArt, 0).find((i) => i.role === "fall");
    expect(pyFall).toMatchObject({ key: "gt_waterfall_sheet_2_px", flipX: true, mask: 2 | WATERFALL_FLIP_X });
  });
});

describe("ADR-389 shader / renderer wiring", () => {
  it("the terrain-tile shader still animates by uTime, has a mode-3 full-frame path, and flips on mask bit 8", () => {
    expect(TERRAIN_TILES_VS).toContain("uTime");
    expect(TERRAIN_TILES_VS).toContain("mod(floor(uTime * aB.y + aB.w), float(frames))");
    expect(TERRAIN_TILES_VS).toContain("int(aB.z + 0.5) & 8");
    expect(TERRAIN_TILES_FS).toContain("art != 3");
    expect(TERRAIN_TILES_FS).toContain("art == 3");
    expect(TERRAIN_TILES_FS).toContain("art == 4");
    expect(TERRAIN_TILES_FS).toContain("oColor = vec4(c, t.a)");
    expect(WATERFALL_ART_MODE).toBe(3);
    expect(WATERFALL_OVERLAY_MODE).toBe(4);
    expect(WATERFALL_FLIP_X).toBe(8);
  });

  it("the mesh face skips procedural streaks when uWaterfallArt is set", () => {
    expect(TILEMAP_FS).toContain("uWaterfallArt");
    expect(TILEMAP_FS).toContain("if (uWaterfallArt < 0.5)");
  });

  it("the mesh fallback still marks a 2-level water drop as a waterfall face (flags 6..9)", () => {
    const { map, c } = plateau();
    c.set(5, 5, TileId.Water); c.setHeight(5, 5, flowWaterRaw(6));
    c.set(6, 5, TileId.Water); c.setHeight(6, 5, flowWaterRaw(4));
    const captured: ArrayBuffer[] = [];
    const gl = {
      VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, ACTIVE_UNIFORMS: 5,
      ARRAY_BUFFER: 6, ELEMENT_ARRAY_BUFFER: 7, STATIC_DRAW: 8, FLOAT: 9, UNSIGNED_BYTE: 10,
      TRIANGLES: 11, UNSIGNED_SHORT: 12, UNSIGNED_INT: 13,
      createProgram: () => ({}), createShader: () => ({}), shaderSource: () => {}, compileShader: () => {},
      getShaderParameter: () => true, getShaderInfoLog: () => "",
      attachShader: () => {}, linkProgram: () => {},
      getProgramParameter: (_p: unknown, name: number): unknown => (name === 4 ? true : 0),
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
    const renderer = new TilemapRenderer(gl, { ...DEFAULT_ISO }, isoZDepthFactor(DEFAULT_ISO));
    renderer.sync(map);
    const flags = new Set<number>();
    for (const buf of captured) {
      const u8 = new Uint8Array(buf);
      for (let k = 0; k < u8.length / 16; k++) flags.add(u8[k * 16 + 15]!);
    }
    expect(flags.has(WATERFALL_PX)).toBe(true);
    expect(flags.has(WATERFALL_PY)).toBe(false);
    expect(flags.has(WATERFALL_NX)).toBe(false);
    expect(flags.has(WATERFALL_NY)).toBe(false);
  });
});
