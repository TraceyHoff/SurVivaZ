/**
 * ADR-386: a waterfall must READ as falling water. The mesh renderer (always drawn as the under-layer;
 * the textured renderer draws no side faces for water, so the mesh cliff is the visible face) emits a
 * waterfall flag (6..9, the cliff normal + 4) for a water tile's face when it drops >= 2 levels, and
 * the fragment shader animates those faces as downward-scrolling streaks. The textured renderer's
 * water skirt is suppressed on waterfall faces so the full animated face shows.
 *
 * Headless (mock GL that captures the vertex buffer): the flag bytes in the built mesh are the test.
 * The GLSL itself was validated by a real compiler by the ADR-386 gate (glslangValidator 16.6.0,
 * both shader stages exit 0, no errors, no warnings); the animated streaks are additionally checked
 * by Tracey's eyes on the live build (the flag plumbing is what this test pins).
 */
import { describe, expect, it } from "vitest";
import { CHUNK_SIZE, DEFAULT_ISO, TileMap, Chunk, flowWaterRaw } from "@engine/world";
import {
  TilemapRenderer, tileHeight, cliffFlagFor, cliffShade,
  CLIFF_PX, CLIFF_PY, CLIFF_NX, CLIFF_NY,
  WATERFALL_PX, WATERFALL_PY, WATERFALL_NX, WATERFALL_NY, WATERFALL_MIN_DROP,
  NO_TILE_HEIGHT, CLIFF_HIDDEN_SHADE,
} from "../src/tilemap.js";
import { TileId } from "../src/ids.js";
import { isoZDepthFactor } from "../src/depth.js";

describe("ADR-386 waterfall flags: the rule", () => {
  it("a water face dropping >= 2 levels is a waterfall face; anything else is a plain cliff", () => {
    expect(WATERFALL_MIN_DROP).toBe(2);
    // Water, 2-level drop -> waterfall flag (normal + 4), on every normal.
    expect(cliffFlagFor(true, CLIFF_PX, 5.75, 3.75)).toBe(WATERFALL_PX);
    expect(cliffFlagFor(true, CLIFF_PY, 5.75, 3.75)).toBe(WATERFALL_PY);
    expect(cliffFlagFor(true, CLIFF_NX, 5.75, 3.75)).toBe(WATERFALL_NX);
    expect(cliffFlagFor(true, CLIFF_NY, 5.75, 3.75)).toBe(WATERFALL_NY);
    // A bigger drop is still a waterfall.
    expect(cliffFlagFor(true, CLIFF_PX, 5.75, 0)).toBe(WATERFALL_PX);
    // A 1-level step is an ordinary stream ledge, not a waterfall.
    expect(cliffFlagFor(true, CLIFF_PX, 5.75, 4.75)).toBe(CLIFF_PX);
    expect(cliffFlagFor(true, CLIFF_PY, 5.75, 4.75)).toBe(CLIFF_PY);
    // Land cliffs never get a waterfall flag, however steep.
    expect(cliffFlagFor(false, CLIFF_PX, 6, 1)).toBe(CLIFF_PX);
    expect(cliffFlagFor(false, CLIFF_PY, 6, 1)).toBe(CLIFF_PY);
    // A missing neighbour (view edge / unloaded chunk) never reads as a waterfall.
    expect(cliffFlagFor(true, CLIFF_PX, 5.75, NO_TILE_HEIGHT)).toBe(CLIFF_PX);
    expect(cliffFlagFor(true, CLIFF_PY, 5.75, NO_TILE_HEIGHT)).toBe(CLIFF_PY);
    // Exactly at the threshold counts; just below it does not.
    expect(cliffFlagFor(true, CLIFF_PX, 5.75, 3.75)).toBe(WATERFALL_PX);
    expect(cliffFlagFor(true, CLIFF_PX, 5.75, 3.76)).toBe(CLIFF_PX);
  });

  it("waterfall faces share their cliff normal's shade", () => {
    for (const q of [0, 1, 2, 3]) {
      expect(cliffShade(WATERFALL_PX, q)).toBe(cliffShade(CLIFF_PX, q));
      expect(cliffShade(WATERFALL_PY, q)).toBe(cliffShade(CLIFF_PY, q));
      expect(cliffShade(WATERFALL_NX, q)).toBe(cliffShade(CLIFF_NX, q));
      expect(cliffShade(WATERFALL_NY, q)).toBe(cliffShade(CLIFF_NY, q));
      expect(cliffShade(WATERFALL_PX, q)).toBeGreaterThan(0);
    }
    expect(cliffShade(CLIFF_NX, 0)).toBe(CLIFF_HIDDEN_SHADE);
  });
});

/** Mock GL that captures the vertex buffer the mesh builder uploads (flag = alpha byte of each vertex). */
function mockGl(captured: ArrayBuffer[]): WebGL2RenderingContext {
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
    bufferData: (t: number, data: ArrayBuffer | ArrayBufferView) => {
      if (t !== 6) return; // ARRAY_BUFFER only: the index buffer's bytes are not vertex flags
      if (data instanceof ArrayBuffer) captured.push(data);
      else if (ArrayBuffer.isView(data)) captured.push(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    },
    enableVertexAttribArray: () => {}, vertexAttribPointer: () => {},
    deleteVertexArray: () => {}, deleteBuffer: () => {},
    useProgram: () => {}, uniform1f: () => {}, uniform2f: () => {}, uniform3f: () => {}, uniform4fv: () => {}, uniform2fv: () => {},
    drawElements: () => {},
  } as unknown as WebGL2RenderingContext;
  return gl;
}

describe("ADR-386 waterfall faces: the built mesh", () => {
  it("a 2-level water drop emits a waterfall flag; a 1-level drop, a land cliff and a view-edge face do not", () => {
    // One chunk of grass at height 5 (a plateau), so only the designed drops make faces.
    const map = new TileMap();
    const c = new Chunk(0, 0);
    for (let ly = 0; ly < CHUNK_SIZE; ly++) for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      c.set(lx, ly, TileId.Grass); c.setHeight(lx, ly, 5);
    }
    // A: water at 6 next to B: water at 4 — A's +x face drops exactly 2 -> waterfall (flag 6).
    // A's other faces drop 0.75 to the height-5 plateau -> plain cliffs.
    c.set(5, 5, TileId.Water); c.setHeight(5, 5, flowWaterRaw(6));
    c.set(6, 5, TileId.Water); c.setHeight(6, 5, flowWaterRaw(4));
    // C: water at 6 next to D: water at 5 — a 1-level ledge -> plain cliff (flag 2).
    c.set(5, 7, TileId.Water); c.setHeight(5, 7, flowWaterRaw(6));
    c.set(6, 7, TileId.Water); c.setHeight(6, 7, flowWaterRaw(5));
    // E: land at 8 next to F: land at 1 — a 7-level land cliff -> plain cliff (flag 2), never a waterfall.
    c.setHeight(5, 9, 8); c.setHeight(6, 9, 1);
    // G: water at 6 on the chunk's +x edge, neighbour chunk NOT loaded -> the face runs to the void
    // and must stay a plain cliff (flag 2), never a waterfall.
    c.set(15, 5, TileId.Water); c.setHeight(15, 5, flowWaterRaw(6));
    map.insertChunk(c);
    // Sanity: the designed drops read as designed at the tileHeight level.
    expect(tileHeight(map, 5, 5)).toBe(6);
    expect(tileHeight(map, 6, 5)).toBe(4);
    expect(tileHeight(map, 5, 7)).toBe(6);
    expect(tileHeight(map, 6, 7)).toBe(5);

    const captured: ArrayBuffer[] = [];
    const renderer = new TilemapRenderer(mockGl(captured), { ...DEFAULT_ISO }, isoZDepthFactor(DEFAULT_ISO));
    renderer.sync(map);
    // The vertex buffer is interleaved: 3 floats (12 bytes) + 4 colour bytes; the flag is the alpha byte.
    const flags = new Set<number>();
    let waterfallVerts = 0;
    for (const buf of captured) {
      const u8 = new Uint8Array(buf);
      for (let k = 0; k < u8.length / 16; k++) {
        const flag = u8[k * 16 + 15]!;
        flags.add(flag);
        if (flag >= WATERFALL_PX && flag <= WATERFALL_NY) waterfallVerts++;
      }
    }
    expect(flags.has(1)).toBe(true); // water tops
    expect(flags.has(CLIFF_PX)).toBe(true); // plain cliffs (1-level ledge, land cliff, view edge)
    expect(flags.has(WATERFALL_PX)).toBe(true); // the 2-level water drop
    expect(flags.has(WATERFALL_PY)).toBe(false);
    expect(flags.has(WATERFALL_NX)).toBe(false);
    expect(flags.has(WATERFALL_NY)).toBe(false);
    expect(waterfallVerts).toBe(4); // exactly one waterfall quad (A's +x face)
  });
});
