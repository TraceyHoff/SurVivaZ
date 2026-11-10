// ADR-328: a lone gate_clan's swing ends with a pop on the WebGL2 path. The swing itself is
// frame-exact (ADR-314), but while it plays the gate leaves the static chunk buffers (drawn
// dynamically, like a lit fire), so a chunk whose only piece is the swinging gate is deleted
// as empty — and when the swing ends the chunk is recreated with born = now, so drawStatic
// fades it in from alpha 0 over chunkFadeIn (0.35 s): swing4 -> the gate blinks out and fades
// back in as open. The regression pins the last frame: on the first frame after the swing
// ends the gate's chunk must draw at full alpha, in both directions.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadManifest, mergeManifests, type ManifestJson } from "@engine/assets";
import { readManifestJson } from "@engine/assets/node";
import { World, defineComponent, PrevTransform, Transform } from "@engine/core";
import * as G from "@engine/gameplay";
import { AtlasManager, DEFAULT_STYLE, LightSource, Occluder, Shadow, Sprite, SpriteBatch, newStats } from "@engine/render";
import { DEFAULT_ISO } from "@engine/world";
import { MANIFEST_INDEX } from "../src/manifest-index.js";
import { DoorView, doorArt } from "../src/door-view.js";

const root = resolve(__dirname, "../../..");
const repoPath = (url: string) => resolve(root, url.startsWith("pack/") ? "packages/assets/" + url : "assets/" + url);
const served = MANIFEST_INDEX.filter((f) => existsSync(repoPath(f.url))).map((f) => ({ name: f.name, manifest: readManifestJson<ManifestJson>(repoPath(f.url)) }));
const { registry } = loadManifest(mergeManifests(served).manifest, { lock: JSON.parse(readFileSync(resolve(root, "packages/assets/pack/ids.lock.json"), "utf8")) });
const defs = G.defaultDefs();
const art = (key: string) => {
  const def = defs.pieces.get(defs.pieceId(key))!;
  return doorArt(registry, key, { type: def.id, rot: 0, tint: 0, paint: 0 }, { pieceKey: () => key });
};

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

describe("ADR-328 gate_clan door swing last-frame pop", () => {
  it("a lone gate's chunk draws at full alpha on the frame its swing ends (open and close)", () => {
    const a = art("gate_clan");
    const alphas: number[] = [];
    const gl = mockGl(alphas);
    // AtlasManager with hand-built runtime tables for just the two sprites this scene draws
    // (no GPU upload: both pages are treated as resident, the normal warmed case from ADR-314).
    const am = new AtlasManager(gl, { registerLoader: () => {} } as never, { textureBudgetMB: 160 });
    (am as unknown as { registry: unknown }).registry = registry;
    const mkAtlas = (key: string, id: number) => ({ key, id, source: {}, img: null, emis: null, scale: 1, masks: {}, maskUrls: {}, base: 0, count: 64, fw: 160, fh: 256, cols: 8, layer: 0, px: 0, py: 0 });
    const mkSprite = (atlasIdx: number, sid: number) => {
      const s = registry.sprite(sid); const b = s.building!;
      return { atlasIdx, anchorX: s.anchor.x, anchorY: s.anchor.y, anims: [], dirAt: [], dirF: [], stateAnim: new Int16Array(0), damage: [], building: { fw: b.footprint.w, fh: b.footprint.h, layer: b.layer, frames: b.frames } };
    };
    const sprites: unknown[] = []; sprites[a.visualId] = mkSprite(0, a.visualId); sprites[a.swingVis!] = mkSprite(1, a.swingVis!);
    (am as unknown as { sprites: unknown[] }).sprites = sprites;
    (am as unknown as { atlases: unknown[] }).atlases = [mkAtlas(registry.sprite(a.visualId).atlas.key, 0), mkAtlas(registry.sprite(a.swingVis!).atlas.key, 1)];
    (am as unknown as { tex: unknown }).tex = {}; // drawStatic no-ops without a texture

    const batch = new SpriteBatch(gl, DEFAULT_ISO, 1);
    const VP = defineComponent("ViewBuildPieceT328", { visualId: "u16", variant: "u8", tint: "u32", damageStage: "u8", rotation: "u8", level: "u8", layer: "u8", ghost: "u8" });
    const w = new World({ seed: 1 });
    w.register(Transform); w.register(PrevTransform); w.register(Sprite); w.register(Shadow); w.register(Occluder); w.register(LightSource); w.register(VP);
    const e = w.create();
    w.add(e, Transform, { x: 2.5, y: 2, z: 0 });
    w.add(e, VP, { visualId: a.visualId, variant: 0, tint: 0, damageStage: 0, rotation: 0, level: 0, layer: 1, ghost: 0 });

    const view = new DoorView();
    let state = view.sync(e, 0, () => a, a.visualId); // first sight: closed, no swing
    const rect = { x0: -1000, y0: -1000, x1: 2000, y1: 2000 };
    const frame = (now: number) => {
      batch.prepare({ world: w, alpha: 1, rect, atlas: am, depthMin: -100, depthRange: 200, tickHz: 20, style: DEFAULT_STYLE,
        bindings: { buildPiece: VP, pieceState: () => state, pieceSwing: (x: number, t: number) => view.swing(x, t), pieceSwingSprite: (x: number) => view.swingSprite(x) }, now });
      alphas.length = 0;
      batch.drawStatic(new Float32Array(4), new Float32Array(2), am, now, now, rect, undefined, DEFAULT_STYLE, newStats());
      return [...alphas];
    };

    expect(frame(0)).toContain(0); // harness check: a brand-new chunk fades in from alpha 0
    expect(Math.min(...frame(1))).toBe(1); // settled: the closed gate draws at full alpha

    state = view.sync(e, 1, () => a, a.visualId); // toggle open: the 11 fps swing starts
    frame(1); // swing frame 1 is dynamic (visible); the chunk is empty now
    expect(batch.visible).toBeGreaterThan(0); // 2 column slices for the 2-wide gate
    frame(1.1); expect(batch.visible).toBeGreaterThan(0); // 2 column slices for the 2-wide gate
    frame(1.2); expect(batch.visible).toBeGreaterThan(0); // 2 column slices for the 2-wide gate
    frame(1.3); expect(batch.visible).toBeGreaterThan(0); // swing4, the last swing frame
    const openEnd = frame(1.37); expect(batch.visible).toBe(0); // swing over: the gate is static open again
    expect(Math.min(...openEnd)).toBe(1); // THE POP: was 0 (chunk recreated, born = now, fading in)

    state = view.sync(e, 0, () => a, a.visualId); // toggle shut: the closing swing
    frame(2); expect(batch.visible).toBeGreaterThan(0); // 2 column slices for the 2-wide gate
    frame(2.1); frame(2.2); frame(2.3);
    const closeEnd = frame(2.37); expect(batch.visible).toBe(0);
    expect(Math.min(...closeEnd)).toBe(1); // same pop on the closing last frame
  });
});
