// ADR-397: continuous-roof draw path in SpriteBatch (pieceRoofFx binding): lift, overlays, legacy fallback.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadManifest, mergeManifests, type ManifestJson } from "@engine/assets";
import { readManifestJson } from "@engine/assets/node";
import { World, defineComponent, PrevTransform, Transform } from "@engine/core";
import { AtlasManager, DEFAULT_STYLE, LightSource, Occluder, PIECE_PARTS_MAX, ROOF_OVERLAY_BIAS, Shadow, Sprite, SpriteBatch, type RoofFxBinding } from "@engine/render";
import { DEFAULT_ISO } from "@engine/world";
import { MANIFEST_INDEX } from "../src/manifest-index.js";

const root = resolve(__dirname, "../../..");
const repoPath = (url: string) => resolve(root, url.startsWith("pack/") ? "packages/assets/" + url : "assets/" + url);
const served = MANIFEST_INDEX.filter((f) => existsSync(repoPath(f.url))).map((f) => ({ name: f.name, manifest: readManifestJson<ManifestJson>(repoPath(f.url)) }));
const { registry } = loadManifest(mergeManifests(served).manifest, { lock: JSON.parse(readFileSync(resolve(root, "packages/assets/pack/ids.lock.json"), "utf8")) });

// Mock GL: shader compile/link always succeed, ACTIVE_UNIFORMS reports only uAlphaMul so the
// test can read the exact per-chunk alpha drawStatic uploads (the pop is an alpha-0 first frame).
const ALPHA_LOC = { name: "uAlphaMul" };
function mockGl(alphaCalls: number[]): WebGL2RenderingContext {
  const noop = () => {};
  const gl = {
    VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b20, COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82,
    ACTIVE_UNIFORMS: 0x8b86, ARRAY_BUFFER: 0x8892, STATIC_DRAW: 0x88e4, DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406, TEXTURE_2D: 0x0de1, TEXTURE_2D_ARRAY: 0x8c1a, MAX_TEXTURE_SIZE: 0x0d33, MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
    TEXTURE0: 0x84c0, TEXTURE1: 0x84c1, TEXTURE2: 0x84c2, TEXTURE3: 0x84c3, TEXTURE4: 0x84c4, TEXTURE5: 0x84c5, TEXTURE6: 0x84c6, TEXTURE7: 0x84c7,
    createProgram: () => ({}), createShader: () => ({}), createBuffer: () => ({}), createVertexArray: () => ({}), createTexture: () => ({}),
    shaderSource: noop, compileShader: noop, attachShader: noop, linkProgram: noop,
    bindVertexArray: noop, bindBuffer: noop, enableVertexAttribArray: noop, vertexAttribPointer: noop, vertexAttribDivisor: noop,
    deleteBuffer: noop, deleteVertexArray: noop, bufferData: noop, bufferSubData: noop, useProgram: noop,
    drawArraysInstanced: noop, bindTexture: noop, texSubImage2D: noop, activeTexture: noop,
    getShaderParameter: () => true,
    getProgramParameter: (_p: unknown, param: number) => (param === 0x8b82 ? true : param === 0x8b86 ? 1 : 0),
    getActiveUniform: () => ({ name: "uAlphaMul" }),
    getUniformLocation: (_p: unknown, name: string) => (name === "uAlphaMul" ? ALPHA_LOC : null),
    getShaderInfoLog: () => "", getProgramInfoLog: () => "",
    getParameter: (param: number) => (param === 0x0d33 ? 4096 : param === 0x88ff ? 256 : 0),
    isContextLost: () => false,
    uniform1f: (loc: unknown, v: number) => { if (loc === ALPHA_LOC) alphaCalls.push(v); },
    uniform2f: noop, uniform3f: noop, uniform4fv: noop, uniform1i: noop, uniform2fv: noop, uniform3fv: noop,
  };
  return gl as unknown as WebGL2RenderingContext;
}


// Stand-ins: the test hands the binding real building sprites (Art's rfx_* keys are not packed yet); only the draw path is under test.
const LEGACY = registry.ids.sprites.id("bld_roof_flat_t1"), RFXV = registry.ids.sprites.id("bld_roof_slope_t1"), OVL = registry.ids.sprites.id("bld_roof_hip_t1");

function scene(fx: RoofFxBinding | undefined, resident = true) {
  const gl = mockGl([]);
  const am = new AtlasManager(gl, { registerLoader: () => {} } as never, { textureBudgetMB: 160 });
  (am as unknown as { registry: unknown }).registry = registry;
  const mkAtlas = (key: string, id: number) => ({ key, id, source: {}, img: null, emis: null, scale: 1, masks: {}, maskUrls: {}, base: 0, count: 408, fw: 84, fh: 96, cols: 24, layer: 0, px: 0, py: 0 });
  const mkSprite = (sid: number) => { const s = registry.sprite(sid); const b = s.building!; return { atlasIdx: 0, anchorX: s.anchor.x, anchorY: s.anchor.y, anims: [], dirAt: [], dirF: [], stateAnim: new Int16Array(0), damage: [], building: { fw: b.footprint.w, fh: b.footprint.h, layer: b.layer, frames: b.frames } }; };
  const sprites: unknown[] = []; for (const s of [LEGACY, RFXV, OVL]) sprites[s] = mkSprite(s);
  (am as unknown as { sprites: unknown[] }).sprites = sprites;
  (am as unknown as { atlases: unknown[] }).atlases = [mkAtlas("building_t1", 0)];
  (am as unknown as { tex: unknown }).tex = {};
  if (!resident) (am as unknown as { pageReady: (s: number) => boolean }).pageReady = (s: number) => s === LEGACY;
  const batch = new SpriteBatch(gl, DEFAULT_ISO, 1);
  const VP = defineComponent("ViewBuildPieceT397", { visualId: "u16", variant: "u8", tint: "u32", damageStage: "u8", rotation: "u8", level: "u8", layer: "u8", ghost: "u8" });
  const w = new World({ seed: 1 });
  w.register(Transform); w.register(PrevTransform); w.register(Sprite); w.register(Shadow); w.register(Occluder); w.register(LightSource); w.register(VP);
  const e = w.create();
  w.add(e, Transform, { x: 2, y: 2, z: 0 });
  w.add(e, VP, { visualId: LEGACY, variant: 0, tint: 0, damageStage: 0, rotation: 0, level: 1, layer: 0, ghost: 0 });
  const rect = { x0: -1000, y0: -1000, x1: 2000, y1: 2000 };
  batch.prepare({ world: w, alpha: 1, rect, atlas: am, depthMin: -100, depthRange: 200, tickHz: 20, style: DEFAULT_STYLE, bindings: { buildPiece: VP, pieceRoofFx: () => fx }, now: 0 });
  const cache = (batch as unknown as { pieceCache: Map<number, { tmp: Float32Array; len: number; sig: Float64Array }> }).pieceCache;
  return [...cache.entries()].sort((a, b) => a[0] - b[0]).map(([key, en]) => ({ key, vis: en.sig[0]!, rot: en.sig[2]!, lift: en.sig[25]!, y: en.tmp[1]!, depth: en.tmp[2]!, n: en.len }));
}

describe("ADR-397 roof fx draw path", () => {
  it("no binding: the legacy sprite draws unchanged", () => {
    const p = scene(undefined); expect(p.length).toBe(1); expect(p[0]!.vis).toBe(LEGACY); expect(p[0]!.lift).toBe(0);
  });
  it("resident rfx: drawn at its row, raised by the band lift, overlays follow with their own lift", () => {
    const base = scene(undefined)[0]!;
    const p = scene({ vis: RFXV, row: 2, liftPx: 14, overlays: [{ vis: OVL, row: 1, liftPx: 0 }, { vis: OVL, row: 3, liftPx: 14 }] });
    expect(p.map((x) => x.vis)).toEqual([RFXV, OVL, OVL]);
    expect(p.map((x) => x.rot & 3)).toEqual([2, 1, 3]);
    expect(p.map((x) => x.lift)).toEqual([14, 0, 14]);
    expect(p[0]!.key).toBe(p[1]!.key - 1); // one piece, consecutive parts (k * PIECE_PARTS_MAX + part)
    expect(base.y - p[0]!.y).toBeCloseTo(14, 3); // 14 px higher on screen
  });
  it("rfx page not resident yet: the legacy sprite with no lift and no overlays", () => {
    const p = scene({ vis: RFXV, row: 2, liftPx: 14, overlays: [{ vis: OVL, row: 1, liftPx: 0 }] }, false);
    expect(p.length).toBe(1); expect(p[0]!.vis).toBe(LEGACY); expect(p[0]!.lift).toBe(0);
  });
  it("part budget", () => { expect(PIECE_PARTS_MAX).toBeGreaterThanOrEqual(2 + 1 + 7); expect(ROOF_OVERLAY_BIAS).toBeGreaterThan(0); });
});

describe("ADR-399 whole-roof snow", () => {
  it("the shader samples world-space noise on the drawn iso position, behind its own flag", async () => {
    const { SEASON_SPRITE_GLSL, SEASON_ROOFSNOW, SEASON_GROUND, SEASON_SNOWCAP, SEASON_FOLIAGE } = await import("@engine/render");
    expect(SEASON_SPRITE_GLSL).toContain("vec3 roofSnow(vec3 c, vec2 w)");
    expect(new Set([SEASON_ROOFSNOW, SEASON_GROUND, SEASON_SNOWCAP, SEASON_FOLIAGE, 1024]).size).toBe(5);
    expect(SEASON_ROOFSNOW & (SEASON_GROUND | SEASON_SNOWCAP | SEASON_FOLIAGE | 1024)).toBe(0);
  });
});
