/**
 * ADR-587 — drawn-geometry coverage of the player's own house, rebuilt verbatim from
 * their ?diag=1 structure dump (2026-11-27, "roofs still show a gap"). The house is a
 * single-storey 3x3 (wood tier 1) whose roof has 6 of 9 tiles placed: back row 3x
 * roof_hip, middle row 2x roof_gable (west + centre), front row 1x roof_hip (centre).
 * Pre-fix measurement (both renderer passes agreeing exactly): the back wall's top
 * stood bare in a 4-9 px wedge rising toward the NE corner, and the NE corner post
 * had sky above it in 42 of its 55 columns — the two roof tiles beside the missing
 * east-middle tile picked the 'h' hip-end shape, whose part pulls inside the tile.
 * ADR-587 re-picks those notch corners as 'o' in rfxPickLevel (assets), and this test
 * pins the result on the real dump. Harness machinery follows adr562_roof_coverage.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { World, Transform, PrevTransform, TimeOfDay, Appearance, PlayerId, type Entity } from "@engine/core";
import { loadManifest, mergeManifests, type FrameRef } from "@engine/assets";
import { PACK_DIR, readManifestJson } from "@engine/assets/node";
import { CHUNK_SIZE, type TileMap } from "@engine/world";
import { DEFAULT_ID_LOCK, DEFAULT_RAW_DEFS, loadDefs, BuildPiece, installGameplay, structureIndexSystem, type GameDefs } from "@engine/gameplay";
import { Canvas2DRenderer, SpriteBatch, DEFAULT_STYLE, PIECE_PARTS_MAX, PIECE_SIG_N, INSTANCE_FLOATS, ROOF_CLIP, isoZDepthFactor, lCornerArmPiece, isEnclosurePieceKey, roofClipAt } from "@engine/render";
type RoofClipLine = { h0: number; k: number; apex: boolean; c: number };
import { IsoView } from "../src/view.js";
import { LightTable } from "../src/lights.js";
import { parseStructureDump } from "../src/structure-dump.js";
import { decodeRgba } from "./png-rgba.js";

const DUMP = `SURVIVAZ_STRUCTURE_DUMP 1
center -50 -135
radius 12
view 0
bounds -62 -147 25 25
heights
6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6
6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6
6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6
6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6
6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6
6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6
6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6
6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6
6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6
6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6
6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6
6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,7
6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,7,7
6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,7,7,7
7,7,7,7,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,7,7,7
7,7,7,7,7,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,7,7,7,7
7,7,7,7,7,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,7,7,7,7
7,7,7,7,7,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,7,7,7,7
7,7,7,7,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,7,7,5,5
5,7,7,7,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,4,4,5,5,5,5
5,5,5,7,6,6,6,6,6,6,6,6,6,6,5,5,4,4,4,4,5,5,5,5,5
5,5,5,5,4,4,4,4,4,4,4,5,5,5,5,5,5,5,5,5,5,5,5,5,5
5,5,5,5,4,4,4,4,4,4,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5
5,5,5,5,5,4,4,4,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5
5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5
pieces 43
P wall_corner_outer -56 -140 0 0 1 0
P wall -54.5 -140 0 0 1 0
P wall_corner_outer -53 -140 0 1 1 0
P foundation -55.5 -139.5 0 0 1 0
P foundation -54.5 -139.5 0 0 1 0
P foundation -53.5 -139.5 0 0 1 0
P door_wood -56 -138.5 0 1 1 0
P wall_doorway -56 -138.5 0 1 1 0
P foundation -55.5 -138.5 0 0 1 0
P foundation -54.5 -138.5 0 0 1 0
P bed -54 -138.5 0 1 1 0
P foundation -53.5 -138.5 0 0 1 0
P wall_window -53 -138.5 0 1 1 0
P window_shutters -53 -138.5 0 1 1 0
P foundation -55.5 -137.5 0 0 1 0
P foundation -54.5 -137.5 0 0 1 0
P foundation -53.5 -137.5 0 0 1 0
P wall_corner_outer -56 -137 0 3 1 0
P wall_window -54.5 -137 0 0 1 0
P window_shutters -54.5 -137 0 0 1 0
P wall_corner_outer -53 -137 0 2 1 0
P garden_gate -54.5 -135.75 0 2 1 0
P fence_picket -55.75 -135.5 0 1 1 0
P fence_picket -53.25 -135.5 0 1 1 0
P fence_picket -55.75 -134.5 0 1 1 0
P fence_picket -53.25 -134.5 0 1 1 0
P fence_picket -55.75 -133.5 0 1 1 0
P fence_picket -53.25 -133.5 0 1 1 0
P fence_picket -55.75 -132.5 0 1 1 0
P herb_planter -55.5 -132.5 0 1 1 0
P flower_bed -54.5 -132.5 0 1 1 0
P fence_picket -53.25 -132.5 0 1 1 0
P fence_picket -55.75 -131.5 0 1 1 0
P apiary -55.5 -131.5 0 1 1 0
P apiary -54.5 -131.5 0 1 1 0
P fence_picket -53.25 -131.5 0 1 1 0
P fence_picket -54.5 -131.25 0 2 1 0
P roof_hip -55.5 -139.5 5.005 3 1 0
P roof_hip -54.5 -139.5 5.005 3 1 0
P roof_hip -53.5 -139.5 5.005 3 1 0
P roof_gable -55.5 -138.5 5.005 1 1 0
P roof_gable -54.5 -138.5 5.005 1 1 0
P roof_hip -54.5 -137.5 5.005 1 1 0
end`;
const data = parseStructureDump(DUMP);
const OX = -data.x0, OY = -data.y0; // shift so dump bounds start at local (0,0)

const reg = loadManifest(mergeManifests([
  { name: "pack", manifest: readManifestJson(PACK_DIR + "manifest.json") },
  { name: "building", manifest: readManifestJson(PACK_DIR + "building/manifest.building.json") },
] as never).manifest).registry;
const DEFS: GameDefs = loadDefs(DEFAULT_RAW_DEFS, { lock: DEFAULT_ID_LOCK });
const ROOT = resolve(__dirname, "../../..");

interface AtlasFile { dir: string; image: string }
const atlasFile = new Map<string, AtlasFile>();
for (const [dir, file] of [["packages/assets/pack/building/", "manifest.building.json"], ["packages/assets/pack/", "manifest.json"]] as const) {
  const m = JSON.parse(readFileSync(resolve(ROOT, dir, file), "utf8")) as { atlases: { key: string; image: string }[] };
  for (const a of m.atlases) if (!atlasFile.has(a.key)) atlasFile.set(a.key, { dir, image: a.image });
}
const imgCache = new Map<string, { w: number; rgba: Uint8Array }>();
const atlasImg = (key: string): { w: number; rgba: Uint8Array } => {
  let im = imgCache.get(key);
  if (!im) { const f = atlasFile.get(key)!; const d = decodeRgba(readFileSync(resolve(ROOT, f.dir, f.image))); im = { w: d.w, rgba: d.rgba }; imgCache.set(key, im); }
  return im;
};
const framePixCache = new Map<string, [number, number][]>();
function framePixels(f: FrameRef): [number, number][] {
  const ck = `${f.atlas.key}|${f.x}|${f.y}|${f.w}|${f.h}|${f.anchorX}|${f.anchorY}|${f.flipX ? 1 : 0}`;
  const hit = framePixCache.get(ck); if (hit) return hit;
  const im = atlasImg(f.atlas.key); const out: [number, number][] = [];
  for (let py = 0; py < f.h; py++) for (let px = 0; px < f.w; px++) {
    if (im.rgba[((f.y + py) * im.w + f.x + px) * 4 + 3]! >= 128) out.push([f.flipX ? f.anchorX - px - 1 : px - f.anchorX, py - f.anchorY]);
  }
  framePixCache.set(ck, out); return out;
}

type Occ = Map<number, Set<number>>;
const newOcc = (): Occ => new Map();
function occAdd(occ: Occ, col: number, row: number): void { let s = occ.get(col); if (!s) occ.set(col, (s = new Set())); s.add(row); }
const pointInPoly = (poly: [number, number][], x: number, y: number): boolean => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
interface FrameOpts { clip?: [number, number][] | undefined; sliceL?: number | undefined; sliceR?: number | undefined; roofLine?: RoofClipLine | undefined }
function rasterFrame(occ: Occ, f: FrameRef, sx: number, sy: number, opts: FrameOpts = {}): void {
  for (const [dx, dy] of framePixels(f)) {
    if (opts.sliceL !== undefined && (dx < opts.sliceL || dx >= opts.sliceR!)) continue;
    if (opts.roofLine && -dy > opts.roofLine.h0 + roofClipAt(opts.roofLine, dx, 16, 32)) continue;
    if (opts.clip && !pointInPoly(opts.clip, dx, dy)) continue;
    occAdd(occ, Math.round(sx + dx), Math.round(sy + dy));
  }
}

const stubCtx = new Proxy({}, { get: (_t, p) => (p === "canvas" ? {} : () => ({})) }) as unknown as CanvasRenderingContext2D;
const mkRenderer = (): Canvas2DRenderer => {
  const canvas = { width: 320, height: 240, getContext: () => ({}) } as unknown as HTMLCanvasElement;
  const r = new Canvas2DRenderer(canvas, stubCtx);
  (r as unknown as { image: unknown }).image = () => ({});
  return r;
};
const mkIso = (renderer: Canvas2DRenderer): IsoView => {
  const Ctor = IsoView as unknown as new (r: unknown, reg: unknown, ov: unknown, lights: unknown) => IsoView;
  return new Ctor(renderer as never, reg, {}, new LightTable());
};
const tilesWith = (h: (x: number, y: number) => number): TileMap => {
  const height = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(0);
  for (let y = 0; y < CHUNK_SIZE; y++) for (let x = 0; x < CHUNK_SIZE; x++) height[y * CHUNK_SIZE + x] = h(x, y);
  const chunk = { tiles: new Uint16Array(CHUNK_SIZE * CHUNK_SIZE), height };
  return { getChunk: () => chunk, getTile: () => 9999 } as unknown as TileMap;
};
const mkNet = (): World => {
  const net = new World({ seed: 1 });
  net.register(Transform); net.register(PrevTransform);
  net.register(Appearance); net.register(PlayerId);
  installGameplay(net, { defs: DEFS, role: "client" });
  net.env(TimeOfDay).epochTick = 0;
  return net;
};

function mockGl(): WebGL2RenderingContext {
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
    getUniformLocation: () => null,
    getShaderInfoLog: () => "", getProgramInfoLog: () => "",
    getParameter: (param: number) => (param === 0x0d33 ? 4096 : param === 0x88ff ? 256 : 0),
    isContextLost: () => false,
    uniform1f: noop, uniform2f: noop, uniform3f: noop, uniform4fv: noop, uniform1i: noop, uniform2fv: noop, uniform3fv: noop,
  };
  return gl as unknown as WebGL2RenderingContext;
}
interface StubAtlas { atlas: unknown; frames: Map<number, FrameRef> }
const mkStubAtlas = (): StubAtlas => {
  const frames = new Map<number, FrameRef>(); const byKey = new Map<string, number>(); let next = 1;
  const atlas = {
    registry: reg, layoutVersion: 0,
    beginFrame: () => {},
    pageReady: () => true, pageReadyAt: () => true, streamPageReady: () => true,
    streamClass: () => null, buildingFallback: () => -1, placeholderOf: () => -1, isStreamed: () => false,
    resolve: () => false, animIndex: () => -1, namedAnim: () => -1, fireAnim: () => -1,
    retainSprite: () => {}, releaseSprite: () => {}, markUsedAt: () => {},
    swayOf: () => undefined, attachOf: () => undefined, handOf: () => undefined, crackOverlayOf: () => -1,
    isCrisp: () => false, isDirectional: () => true,
    isRoof: (vis: number): boolean => { try { const s = reg.sprite(vis); return (s.building?.piece ?? s.key).startsWith("roof"); } catch { return false; } },
    isEnclosure: (vis: number): boolean => { try { const s = reg.sprite(vis); return isEnclosurePieceKey(s.building?.piece ?? s.key); } catch { return false; } },
    lArmOf: (vis: number): number => { try { const k = lCornerArmPiece(reg.sprite(vis).building?.piece); return k ? (reg.spriteForPiece(k) ?? -1) : -1; } catch { return -1; } },
    pieceInfo: (vis: number): { fw: number; fh: number; layer: number } | null => { try { const b = reg.sprite(vis).building; return b ? { fw: b.footprint.w, fh: b.footprint.h, layer: b.layer } : null; } catch { return null; } },
    resolvePiece: (vis: number, variant: number, rotation: number, damage: number, out: Record<string, unknown>, state = -1): boolean => {
      let ref: FrameRef; try { ref = reg.buildingFrame(vis, rotation, damage, state); } catch { return false; }
      const ck = `${vis}|${variant}|${rotation}|${damage}|${state}`;
      let id = byKey.get(ck); if (id === undefined) { id = next++; byKey.set(ck, id); frames.set(id, ref); }
      out.entry = id; out.w = ref.w; out.h = ref.h; out.ax = ref.anchorX; out.ay = ref.anchorY;
      out.flipX = !!ref.flipX; out.hasDamageFrames = false; out.atlas = 0; return true;
    },
  };
  return { atlas, frames };
};

interface Placed { e: Entity; key: string; x: number; y: number; z: number; rot: number }

describe("ADR-587 the player's dumped house: walls under placed roof tiles are covered", () => {
  it("back wall and NE corner are covered in both renderers; the unroofed SW corner stays bare (pinned residual)", () => {
    const renderer = mkRenderer();
    const iso = mkIso(renderer);
    renderer.camera.setView(0);
    const net = mkNet();
    const placed: Placed[] = [];
    for (const p of data.pieces) {
      const e = net.create();
      const x = p.x + OX, y = p.y + OY;
      net.add(e, Transform, { x, y, z: p.z, facing: 0 });
      net.add(e, PrevTransform, { x, y, z: p.z, facing: 0 });
      net.add(e, BuildPiece, { type: DEFS.pieceId(p.key), rot: p.rot, variant: p.variant, tier: p.tier, hp: 100, damageStage: 0, paint: 0, tint: 0 });
      placed.push({ e, key: p.key, x: p.x, y: p.y, z: p.z, rot: p.rot });
    }
    structureIndexSystem(net);
    iso.render(net, tilesWith((lx, ly) => data.heights[ly]?.[lx] ?? 0), undefined, 1);
    const map = (iso as unknown as { map: Map<Entity, Entity> }).map;
    const byView = new Map<Entity, Placed>(); for (const p of placed) { const ve = map.get(p.e); if (ve !== undefined) byView.set(ve, p); }

    interface WallStat { worst: number; badCols: number }
    const analyze = (label: string, all: Occ, perPiece: Map<Entity, Occ>): Map<string, WallStat> => {
      const stats = new Map<string, WallStat>();
      for (const [ve, occ] of perPiece) {
        const p = byView.get(ve)!;
        if (!/^(wall|roof)/.test(p.key)) continue;
        let worst = 0, badCols = 0;
        for (const [col, rows] of occ) {
          const top = Math.min(...rows); const allRows = all.get(col); if (!allRows) continue;
          let clear = 0; while (clear < 400 && !allRows.has(top - 1 - clear)) clear++;
          if (clear > worst) worst = clear;
          if (clear >= 4) badCols++;
        }
        stats.set(`${p.key} @(${p.x},${p.y})`, { worst, badCols });
      }
      return stats;
    };
    const checkStats = (label: string, stats: Map<string, WallStat>): void => {
      // The back wall's 4-9 px wedge and the NE corner post's 42 bare columns (pre-fix)
      // are closed by the ADR-587 notch-corner re-pick: both now match the completed
      // roof's profile (worst 5 px at a single corner column).
      expect(stats.get("wall @(-54.5,-140)")!.worst, `${label} back wall`).toBeLessThanOrEqual(3);
      const ne = stats.get("wall_corner_outer @(-53,-140)")!;
      expect(ne.worst, `${label} NE corner worst`).toBeLessThanOrEqual(7);
      expect(ne.badCols, `${label} NE corner bad cols`).toBeLessThanOrEqual(2);
      // Every other wall under a placed roof tile is fully covered.
      for (const [id, s] of stats) {
        if (id.includes("(-56,-137)")) continue; // the unroofed corner, pinned below
        if (id.startsWith("roof")) continue;
        expect(s.worst, `${label} ${id}`).toBeLessThanOrEqual(7);
      }
      // PINNED RESIDUAL: the SW corner post @(-56,-137) stands below a roof tile the
      // player never placed (front-left, like the front-right and east-middle). No
      // placed tile's part covers its north arm; it stays bare until that tile is
      // placed (the completed-roof measurement: worst 7 px at 2 columns). If a future
      // change covers it, update this pin deliberately.
      const sw = stats.get("wall_corner_outer @(-56,-137)")!;
      expect(sw.badCols, `${label} SW corner unroofed residual`).toBeGreaterThanOrEqual(20);
    };

    // C2D pass
    {
      const all = newOcc(); const perPiece = new Map<Entity, Occ>();
      const pieces = (renderer as unknown as { gatherPieces(w: unknown, r: unknown, t: number): { e: Entity; sx: number; sy: number; f: FrameRef; clip?: [number, number][] }[] }).gatherPieces(iso.view, reg, 0);
      for (const pc of pieces) {
        let occ = perPiece.get(pc.e); if (!occ) perPiece.set(pc.e, (occ = newOcc()));
        rasterFrame(all, pc.f, pc.sx, pc.sy, { clip: pc.clip });
        rasterFrame(occ, pc.f, pc.sx, pc.sy, { clip: pc.clip });
      }
      checkStats("Canvas2D", analyze("Canvas2D", all, perPiece));
    }
    // GL pass
    {
      const all = newOcc(); const perPiece = new Map<Entity, Occ>();
      const stub = mkStubAtlas();
      const isoCfg = { ...renderer.camera.iso };
      const batch = new SpriteBatch(mockGl(), isoCfg, isoZDepthFactor(isoCfg));
      const bindings = (renderer as unknown as { bindings: never }).bindings;
      batch.prepare({ world: iso.view, alpha: 1, rect: { x0: -100000, y0: -100000, x1: 100000, y1: 100000 }, atlas: stub.atlas as never, depthMin: -1000, depthRange: 2000, tickHz: 20, style: DEFAULT_STYLE, bindings, now: 0 });
      const cache = (batch as unknown as { pieceCache: Map<number, { tmp: Float32Array; len: number; sig: Float64Array }> }).pieceCache;
      expect(PIECE_SIG_N).toBe(35);
      const store = iso.view.store((bindings as { buildPiece: never }).buildPiece) as unknown as { dense: Entity[] };
      for (const [key, entry] of cache) {
        const ve = store.dense[Math.floor(key / PIECE_PARTS_MAX)]!; if (ve === undefined) continue;
        let occ = perPiece.get(ve); if (!occ) perPiece.set(ve, (occ = newOcc()));
        for (let j = 0; j < entry.len; j += INSTANCE_FLOATS) {
          const o = entry.tmp.subarray(j, j + INSTANCE_FLOATS);
          const f = stub.frames.get(o[4]!); if (!f) continue;
          const roofLine: RoofClipLine | undefined = (o[5]! & ROOF_CLIP) !== 0 ? { h0: o[20]!, k: o[21]!, apex: o[22]! > 0, c: o[23]! } : undefined;
          rasterFrame(all, f, o[0]!, o[1]!, { sliceL: o[10]!, sliceR: o[11]!, roofLine });
          rasterFrame(occ, f, o[0]!, o[1]!, { sliceL: o[10]!, sliceR: o[11]!, roofLine });
        }
      }
      checkStats("WebGL2", analyze("WebGL2", all, perPiece));
    }
  }, 120_000);
});
