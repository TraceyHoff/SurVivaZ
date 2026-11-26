import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { World, Transform, PrevTransform, TimeOfDay, Appearance, PlayerId, type Entity } from "@engine/core";
import { loadManifest, mergeManifests, rfxSpriteKeys, type FrameRef } from "@engine/assets";
import { PACK_DIR, readManifestJson } from "@engine/assets/node";
import { CHUNK_SIZE, FLOOR_HEIGHT_LEVELS, type TileMap } from "@engine/world";
import {
  DEFAULT_ID_LOCK, DEFAULT_RAW_DEFS, loadDefs, BuildPiece, installGameplay, structureIndexSystem,
  type GameDefs,
} from "@engine/gameplay";
import {
  Canvas2DRenderer, SpriteBatch, DEFAULT_STYLE, PIECE_PARTS_MAX, PIECE_SIG_N, INSTANCE_FLOATS,
  ROOF_CLIP, isoZDepthFactor, lCornerArmPiece, isEnclosurePieceKey, roofClipAt, roofClipLine,
} from "@engine/render";
type RoofClipLine = ReturnType<typeof roofClipLine>;
import { IsoView } from "../src/view.js";
import { LightTable } from "../src/lights.js";
import { decodeRgba } from "./png-rgba.js";

/**
 * ADR-562 — drawn-geometry roof-coverage pin (test-only foundation for ADR-563/564/565).
 *
 * Ports the roof-gap prep harness (~/workspace/work/roof-gap-prep.md) into a permanent test:
 * a two-storey wood tier-1 house (foundation / walls / corners / doorway / window / floor z=5 /
 * walls z=5 / roof_hip z=10) is placed as raw BuildPiece entities in a net world, the real
 * structureIndexSystem runs (wood walls -> shk roof skin), IsoView.render builds the real view
 * mirror, and then DRAWN PIXELS are measured per screen column through BOTH renderer geometry
 * passes:
 *   - Canvas2D: Canvas2DRenderer.gatherPieces with image() forced ready; each gathered frame's
 *     opaque pixels (alpha >= 128, real atlas PNGs) projected to screen space, clip polygons applied.
 *   - WebGL2: SpriteBatch.prepare() with a stub GL context and a stub AtlasManager whose
 *     resolvePiece returns the REAL frames from the real registry (registry.buildingFrame);
 *     instances are read back from the per-part static cache (pieceCache).
 *
 * Terrain heights reach the mirror ONLY via chunk.height[localY*CHUNK_SIZE+localX] + chunk.tiles
 * with getTile: () => 9999 (the ADR-523 per-local-tile height array pattern, generalized to a
 * height function). A uniform chunk or TileMap.setTile silently produces flat terrain.
 *
 * PIN STATUS on the current tree (2026-11-26, measured by this port; both renderer passes agree
 * EXACTLY on every number below): the front-face / ADR-404 pair assertions PASS (pair per-column:
 * median overlap 9-10 px, worst ramp-end gap 2 px; straight front wall columns <= 3 px clear,
 * 7 px only at the NE corner-post columns), and the test FAILS at the three prep defects:
 *   (1) corner notch — DIVERGENCE from the prep's tier attribution: at tier 1 (shk skin) the SW
 *       corner post is covered (worst clear 3 px); the prep's 51 px notch reproduces EXACTLY at
 *       tier 2 (base skin): 51 px clear x 1 column above the SW corner post, view 0, both renderers.
 *   (2) the screen-back-left face's wall tops stand proud of the roof silhouette — bare columns
 *       (no pixel above the wall top for 300+ rows): 68 at 5x5, 85 at 6x6, 102 at 7x7 (view 0,
 *       W face; W in views 0/1, E in views 2/3) — bare counts identical to the prep's. (Per-face
 *       column totals differ from the prep's 184/230/276: this port's face raster counts the
 *       L-corner arm walls + posts in both adjacent faces, 215/247/279 columns per face.)
 *   (3) terrace step — DIVERGENCE in magnitude: a 1-level x-split step through the footprint
 *       adds +1 bare column on the N face (1 vs flat 0; +1 for every x-split position tried),
 *       where the prep reported +9. The pinned invariant is the same: a step adds NO bare columns.
 * ADR-563 (corner), ADR-564 (back-face eave) and ADR-565 (terrace step) must turn the failing
 * assertions green WITHOUT moving the front-face pair identity.
 *
 * VARIANT MEASUREMENT (prep §2.4 step 1, measured in the second describe block): the hip 'lo'
 * per-column bottom profiles of the v1/v2 (moss) sprites are PIXEL-IDENTICAL to variant 0 for
 * the only shape that has variant art ('e', base + shk skins, all 4 rows: maxAbsDiff 0, 0 of
 * ~70 columns differ); shapes o/i/p/h have NO variant art at all (rfxSpriteKeys falls back to
 * the v0 key). Verdict: NO variant can produce the screenshot's broad ~25 px front-face band.
 */

const reg = loadManifest(mergeManifests([
  { name: "pack", manifest: readManifestJson(PACK_DIR + "manifest.json") },
  { name: "building", manifest: readManifestJson(PACK_DIR + "building/manifest.building.json") },
] as never).manifest).registry;
const DEFS: GameDefs = loadDefs(DEFAULT_RAW_DEFS, { lock: DEFAULT_ID_LOCK });

const ROOT = resolve(__dirname, "../../..");

/* ------------------------------------------------------------------ atlas pixels */

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
/** Opaque (alpha >= 128) pixels of a frame, as [dx, dy] relative to the frame anchor (flipX mirrored about the anchor, as both renderers draw it). */
const framePixCache = new Map<string, [number, number][]>();
function framePixels(f: FrameRef): [number, number][] {
  const ck = `${f.atlas.key}|${f.x}|${f.y}|${f.w}|${f.h}|${f.anchorX}|${f.anchorY}|${f.flipX ? 1 : 0}`;
  const hit = framePixCache.get(ck); if (hit) return hit;
  const im = atlasImg(f.atlas.key); const out: [number, number][] = [];
  for (let py = 0; py < f.h; py++) for (let px = 0; px < f.w; px++) {
    if (im.rgba[((f.y + py) * im.w + f.x + px) * 4 + 3]! >= 128) {
      out.push([f.flipX ? f.anchorX - px - 1 : px - f.anchorX, py - f.anchorY]);
    }
  }
  framePixCache.set(ck, out); return out;
}

/* ------------------------------------------------------------------ occupancy raster */

/** Per-screen-column set of occupied rows. */
type Occ = Map<number, Set<number>>;
const newOcc = (): Occ => new Map();
function occAdd(occ: Occ, col: number, row: number): void {
  let s = occ.get(col); if (!s) occ.set(col, (s = new Set())); s.add(row);
}
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

/* ------------------------------------------------------------------ house + mirror (ADR-523 pattern) */

const stubCtx = new Proxy({}, { get: (_t, p) => (p === "canvas" ? {} : () => ({})) }) as unknown as CanvasRenderingContext2D;
const mkRenderer = (): Canvas2DRenderer => {
  const canvas = { width: 320, height: 240, getContext: () => ({}) } as unknown as HTMLCanvasElement;
  const r = new Canvas2DRenderer(canvas, stubCtx);
  (r as unknown as { image: unknown }).image = () => ({}); // force every atlas page ready
  return r;
};
const mkIso = (renderer: Canvas2DRenderer): IsoView => {
  const Ctor = IsoView as unknown as new (r: unknown, reg: unknown, ov: unknown, lights: unknown) => IsoView;
  return new Ctor(renderer as never, reg, {}, new LightTable());
};
/** One resident chunk whose height array is filled per local tile from h(worldX, worldY); tiles all 0. */
const tilesWith = (h: (x: number, y: number) => number): TileMap => {
  const height = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(0);
  for (let y = 0; y < CHUNK_SIZE; y++) for (let x = 0; x < CHUNK_SIZE; x++) height[y * CHUNK_SIZE + x] = h(x, y);
  const chunk = { tiles: new Uint16Array(CHUNK_SIZE * CHUNK_SIZE), height };
  return { getChunk: () => chunk, getTile: () => 9999 } as unknown as TileMap;
};

interface Placed { e: Entity; key: string; x: number; y: number; z: number }
const X0 = 4, Y0 = 4;
/** Two-storey wood tier-1 house on an N x N footprint at tiles (4..4+N-1)^2, ADR-523 layout generalized. */
const buildHouse = (net: World, n: number, tier = 1, floorDeck = true): Placed[] => {
  const out: Placed[] = [];
  const place = (key: string, x: number, y: number, z: number, rot = 0): Placed => {
    const e = net.create();
    net.add(e, Transform, { x, y, z, facing: 0 });
    net.add(e, PrevTransform, { x, y, z, facing: 0 });
    net.add(e, BuildPiece, { type: DEFS.pieceId(key), rot, variant: 0, tier, hp: 100, damageStage: 0, paint: 0, tint: 0 });
    const p = { e, key, x, y, z }; out.push(p); return p;
  };
  const x1 = X0 + n, y1 = Y0 + n, F = FLOOR_HEIGHT_LEVELS;
  for (let y = Y0; y < y1; y++) for (let x = X0; x < x1; x++) place("foundation", x + 0.5, y + 0.5, 0);
  for (const s of [0, 1]) {
    const z = s * F;
    place("wall_corner_outer", X0, Y0, z, 0); place("wall_corner_outer", x1, Y0, z, 1);
    place("wall_corner_outer", x1, y1, z, 2); place("wall_corner_outer", X0, y1, z, 3);
    for (let x = X0 + 1; x < x1; x++) place("wall", x + 0.5, Y0, z); // north edge
    for (let x = X0; x < x1; x++) place(x === X0 + 2 ? "wall_doorway" : x === X0 + 3 ? "wall_window" : "wall", x + 0.5, y1, z); // south edge
    for (let y = Y0 + 1; y < y1; y++) { place("wall", X0, y + 0.5, z); place("wall", x1, y + 0.5, z); } // west + east edges
    if (s === 0 && floorDeck) for (let y = Y0; y < y1; y++) for (let x = X0; x < x1; x++) place("floor", x + 0.5, y + 0.5, F);
  }
  for (let y = Y0; y < y1; y++) for (let x = X0; x < x1; x++) place("roof_hip", x + 0.5, y + 0.5, 2 * F);
  return out;
};
const mkNet = (): World => {
  const net = new World({ seed: 1 });
  net.register(Transform); net.register(PrevTransform);
  net.register(Appearance); net.register(PlayerId);
  installGameplay(net, { defs: DEFS, role: "client" });
  net.env(TimeOfDay).epochTick = 0;
  return net;
};

/* ------------------------------------------------------------------ stub AtlasManager (WebGL2 pass) */

/** Stub GL: shader compile/link always succeed (mirrors adr397's mock). */
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
/** Stub AtlasManager: resolvePiece returns the REAL registry frames (registry.buildingFrame);
 *  each distinct resolved frame gets an entry id so cached instances can be traced back to it.
 *  The stub field list lives ONLY here (prep fragility note); the signature width is imported
 *  as PIECE_SIG_N, never hardcoded. */
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
    lArmOf: (vis: number): number => {
      try { const k = lCornerArmPiece(reg.sprite(vis).building?.piece); return k ? (reg.spriteForPiece(k) ?? -1) : -1; } catch { return -1; }
    },
    pieceInfo: (vis: number): { fw: number; fh: number; layer: number } | null => {
      try { const b = reg.sprite(vis).building; return b ? { fw: b.footprint.w, fh: b.footprint.h, layer: b.layer } : null; } catch { return null; }
    },
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

/* ------------------------------------------------------------------ scene measurement */

type Face = "N" | "S" | "E" | "W";
const FACES: Face[] = ["N", "S", "E", "W"];
interface FaceStat { cols: number; bare: number; maxClear: number }
interface SceneStats {
  faces: Record<Face, FaceStat>;
  front: Face[]; backLeft: Face; backRight: Face;
  corners: { id: string; maxClear: number; wideCols: number }[];
  pair: { cols: number; minOverlap: number; medianOverlap: number; maxGap: number };
}
interface Scene { c2d: SceneStats; gl: SceneStats }

const faceOf = (p: Placed, n: number): Face[] => {
  const x1 = X0 + n, y1 = Y0 + n, out: Face[] = [];
  if (p.y === Y0) out.push("N");
  if (p.y === y1) out.push("S");
  if (p.x === X0) out.push("W");
  if (p.x === x1) out.push("E");
  return out;
};
/** Consecutive empty rows directly above `top` in `all` (capped), per column of `wallOcc`. */
const clearAbove = (all: Occ, wallOcc: Occ, cap = 400): Map<number, number> => {
  const out = new Map<number, number>();
  for (const [col, rows] of wallOcc) {
    const top = Math.min(...rows); const allRows = all.get(col);
    let clear = 0;
    while (clear < cap && !(allRows && allRows.has(top - 1 - clear))) clear++;
    out.set(col, clear);
  }
  return out;
};
const VIEW_CS: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
function classifyFaces(placed: Placed[], n: number, view: number): { front: Face[]; backLeft: Face; backRight: Face } {
  const [c, s] = VIEW_CS[view & 3]!;
  const score = new Map<Face, { uv: number; sx: number; k: number }>();
  for (const p of placed) {
    if (p.z !== FLOOR_HEIGHT_LEVELS || !p.key.startsWith("wall")) continue;
    for (const f of faceOf(p, n)) {
      const u = c * p.x - s * p.y, v = s * p.x + c * p.y;
      const cur = score.get(f) ?? { uv: 0, sx: 0, k: 0 };
      cur.uv += u + v; cur.sx += (u - v) * 32; cur.k++; score.set(f, cur);
    }
  }
  const byUv = [...FACES].sort((a, b) => (score.get(b)!.uv / score.get(b)!.k) - (score.get(a)!.uv / score.get(a)!.k));
  const front = byUv.slice(0, 2);
  const back = byUv.slice(2);
  const backLeft = back.sort((a, b) => (score.get(a)!.sx / score.get(a)!.k) - (score.get(b)!.sx / score.get(b)!.k))[0]!;
  return { front, backLeft, backRight: back.find((f) => f !== backLeft)! };
}

function statsFromRasters(all: Occ, wallByFace: Map<Face, Occ>, cornerOcc: Map<string, Occ>, pairWall: Occ, roofOcc: Occ, placed: Placed[], n: number, view: number): SceneStats {
  const faces = {} as Record<Face, FaceStat>;
  for (const f of FACES) {
    const clear = clearAbove(all, wallByFace.get(f) ?? newOcc());
    let bare = 0, maxClear = 0;
    for (const v of clear.values()) { if (v >= 300) bare++; if (v < 300) maxClear = Math.max(maxClear, v); }
    faces[f] = { cols: clear.size, bare, maxClear };
  }
  const corners: SceneStats["corners"] = [];
  for (const [id, occ] of cornerOcc) {
    const clear = clearAbove(all, occ);
    let maxClear = 0, wideCols = 0;
    for (const v of clear.values()) { maxClear = Math.max(maxClear, v); if (v >= 10) wideCols++; }
    corners.push({ id, maxClear, wideCols });
  }
  // ADR-404 pair: storey-2 S wall at (X0+1.5, y1) vs the roof above it — overlap per shared column
  const overlaps: number[] = []; let maxGap = 0;
  for (const [col, rows] of pairWall) {
    const top = Math.min(...rows); const roofRows = roofOcc.get(col); if (!roofRows) continue;
    const bottom = Math.max(...roofRows);
    overlaps.push(bottom - top);
    if (bottom < top) maxGap = Math.max(maxGap, top - bottom);
  }
  overlaps.sort((a, b) => a - b);
  const cls = classifyFaces(placed, n, view);
  return {
    faces, front: cls.front, backLeft: cls.backLeft, backRight: cls.backRight, corners,
    pair: { cols: overlaps.length, minOverlap: overlaps[0] ?? -999, medianOverlap: overlaps[Math.floor(overlaps.length / 2)] ?? -999, maxGap },
  };
}

const sceneCache = new Map<string, Scene>();
function measure(n: number, view: number, h: (x: number, y: number) => number, hKey: string, tier = 1, floorDeck = true): Scene {
  const ck = `${n}|${view}|${hKey}|${tier}|${floorDeck}`;
  const hit = sceneCache.get(ck); if (hit) return hit;
  const renderer = mkRenderer();
  const iso = mkIso(renderer);
  renderer.camera.setView(view);
  const net = mkNet();
  const placed = buildHouse(net, n, tier, floorDeck);
  structureIndexSystem(net);
  iso.render(net, tilesWith(h), undefined, 1);
  const map = (iso as unknown as { map: Map<Entity, Entity> }).map;
  const byView = new Map<Entity, Placed>(); for (const p of placed) { const ve = map.get(p.e); if (ve !== undefined) byView.set(ve, p); }

  const mkAcc = () => ({
    all: newOcc(), wallByFace: new Map<Face, Occ>(FACES.map((f) => [f, newOcc()])),
    cornerOcc: new Map<string, Occ>(), pairWall: newOcc(), roofOcc: newOcc(),
  });
  const accs = { c2d: mkAcc(), gl: mkAcc() };
  const feed = (acc: ReturnType<typeof mkAcc>, ve: Entity, draw: (occ: Occ) => void): void => {
    const p = byView.get(ve); if (!p) return;
    draw(acc.all);
    if (p.key === "roof_hip") draw(acc.roofOcc);
    if (p.z === FLOOR_HEIGHT_LEVELS && p.key.startsWith("wall")) {
      for (const f of faceOf(p, n)) draw(acc.wallByFace.get(f)!);
      if (p.key === "wall_corner_outer") {
        const id = `${p.x},${p.y}`;
        let occ = acc.cornerOcc.get(id); if (!occ) acc.cornerOcc.set(id, (occ = newOcc()));
        draw(occ);
      }
      if (p.key === "wall" && p.x === X0 + 1.5 && p.y === Y0 + n) draw(acc.pairWall);
    }
  };

  // Canvas2D pass
  {
    const acc = accs.c2d;
    const pieces = (renderer as unknown as { gatherPieces(w: unknown, r: unknown, t: number): { e: Entity; sx: number; sy: number; f: FrameRef; clip?: [number, number][] }[] })
      .gatherPieces(iso.view, reg, 0);
    for (const pc of pieces) feed(acc, pc.e, (occ) => rasterFrame(occ, pc.f, pc.sx, pc.sy, { clip: pc.clip }));
  }
  // WebGL2 pass: real SpriteBatch.prepare over the same view world, instances from the per-part static cache
  {
    const acc = accs.gl;
    const stub = mkStubAtlas();
    const isoCfg = { ...renderer.camera.iso };
    const batch = new SpriteBatch(mockGl(), isoCfg, isoZDepthFactor(isoCfg));
    const bindings = (renderer as unknown as { bindings: never }).bindings;
    batch.prepare({ world: iso.view, alpha: 1, rect: { x0: -100000, y0: -100000, x1: 100000, y1: 100000 }, atlas: stub.atlas as never, depthMin: -1000, depthRange: 2000, tickHz: 20, style: DEFAULT_STYLE, bindings, now: 0 });
    const cache = (batch as unknown as { pieceCache: Map<number, { tmp: Float32Array; len: number; sig: Float64Array }> }).pieceCache;
    expect(cache.size).toBeGreaterThan(0);
    expect(PIECE_SIG_N).toBe(35); // imported width, not a hardcoded stub field list (prep fragility note)
    const store = iso.view.store((bindings as { buildPiece: never }).buildPiece) as unknown as { dense: Entity[] };
    for (const [key, entry] of cache) {
      const ve = store.dense[Math.floor(key / PIECE_PARTS_MAX)]!; if (ve === undefined) continue;
      feed(acc, ve, (occ) => {
        for (let j = 0; j < entry.len; j += INSTANCE_FLOATS) {
          const o = entry.tmp.subarray(j, j + INSTANCE_FLOATS);
          const f = stub.frames.get(o[4]!); if (!f) continue;
          const roofLine: RoofClipLine | undefined = (o[5]! & ROOF_CLIP) !== 0
            ? { h0: o[20]!, k: o[21]!, apex: o[22]! > 0, c: o[23]! } : undefined;
          rasterFrame(occ, f, o[0]!, o[1]!, { sliceL: o[10]!, sliceR: o[11]!, roofLine });
        }
      });
    }
  }
  const scene: Scene = {
    c2d: statsFromRasters(accs.c2d.all, accs.c2d.wallByFace, accs.c2d.cornerOcc, accs.c2d.pairWall, accs.c2d.roofOcc, placed, n, view),
    gl: statsFromRasters(accs.gl.all, accs.gl.wallByFace, accs.gl.cornerOcc, accs.gl.pairWall, accs.gl.roofOcc, placed, n, view),
  };
  // eslint-disable-next-line no-console
  console.log(`ADR-562 scene n=${n} view=${view} h=${hKey} tier=${tier} floor=${floorDeck}\n  C2D ${JSON.stringify(scene.c2d)}\n  GL  ${JSON.stringify(scene.gl)}`);
  sceneCache.set(ck, scene);
  return scene;
}

const FLAT = (): number => 3;
const TERRACE_X = (x: number): number => (x < X0 + 3 ? 3 : 2); // 1-level step through the footprint (x-split)

/* ------------------------------------------------------------------ the pin */

describe("ADR-562 drawn-geometry roof coverage pin", () => {
  it("front faces meet the roof and the ADR-404 pair identity holds (view 0, 5x5) — PASSES on current code", () => {
    const s = measure(5, 0, FLAT, "flat");
    for (const st of [s.c2d, s.gl]) {
      expect(st.front.sort()).toEqual(["E", "S"]);
      for (const f of st.front) {
        expect(st.faces[f].cols, `${f} cols`).toBeGreaterThan(50);
        expect(st.faces[f].bare, `${f} bare columns`).toBe(0);
        // measured on current code: S worst 3 px; E worst 7 px, only at the NE corner-post columns
        // (the straight front wall columns are <= 3 px, matching the prep's 0-3 px)
        expect(st.faces[f].maxClear, `${f} worst clear band above wall tops`).toBeLessThanOrEqual(8);
      }
      // ADR-404 pair: storey-2 S wall (5.5, 9) vs its roof part — overlap, no gap.
      // Prep measured 21 px overlap at the pair's pivot column; per-column here: median overlap
      // 9-10 px, worst ramp-end gap 2 px (the 'lo' coverage ramps of prep §1).
      expect(st.pair.cols).toBeGreaterThan(40);
      expect(st.pair.maxGap).toBeLessThanOrEqual(3);
      expect(st.pair.medianOverlap).toBeGreaterThanOrEqual(5);
      expect(st.pair.minOverlap).toBeGreaterThanOrEqual(-3);
    }
    // both renderer geometry passes agree on the front faces
    expect(s.c2d.faces.S.bare).toBe(s.gl.faces.S.bare);
    expect(s.c2d.faces.E.bare).toBe(s.gl.faces.E.bare);
  }, 300_000);

  it("corner columns above corner posts are covered (view 0, 5x5) — PIN: fails at the 51 px SW notch, tier 2 (ADR-563)", () => {
    // Measured divergence from the prep (see header): at tier 1 the shk skin's vertex parts cover
    // the SW post (worst clear 3 px, both renderers); the prep's 51 px notch reproduces EXACTLY
    // at tier 2 (base skin): 51 px x 1 column above the SW corner post, both renderers.
    const wood = measure(5, 0, FLAT, "flat", 1);
    const stone = measure(5, 0, FLAT, "flat", 2);
    for (const [label, s] of [["wood t1", wood], ["stone t2", stone]] as const) {
      for (const st of [s.c2d, s.gl]) {
        const sw = st.corners.find((c) => c.id === `${X0},${Y0 + 5}`)!;
        expect(sw, `${label} SW corner post present`).toBeDefined();
        expect(sw.maxClear, `${label} SW corner post worst clear band (t2 measured: 51 px notch)`).toBeLessThanOrEqual(4);
      }
    }
  }, 300_000);

  it("back-left face wall tops are covered by the roof silhouette (view 0, 5x5/6x6/7x7) — PIN: fails, bare columns (ADR-564)", () => {
    const scenes = [5, 6, 7].map((n) => measure(n, 0, FLAT, "flat"));
    for (const [i, s] of scenes.entries()) {
      for (const st of [s.c2d, s.gl]) {
        expect(st.backLeft, `n=${i + 5} back-left face`).toBe("W");
        expect(st.faces[st.backLeft].bare, `n=${i + 5} back-left bare columns (measured: 68/85/102, = prep)`).toBe(0);
      }
      // the two geometry passes agree on the defect's size (measured: identical)
      expect(Math.abs(s.c2d.faces.W.bare - s.gl.faces.W.bare)).toBeLessThanOrEqual(2);
    }
  }, 300_000);

  it("the back-left coverage hole rotates with the view (5x5, views 0-3) — PIN: fails in every view (ADR-564)", () => {
    // The bare face per view, measured (= prep §1: W in views 0/1, E in views 2/3; 68 bare columns each).
    const expectedBareFace: Face[] = ["W", "W", "E", "E"];
    for (const view of [0, 1, 2, 3]) {
      const s = measure(5, view, FLAT, "flat");
      const st = s.c2d;
      for (const f of st.front) expect(st.faces[f].bare, `view ${view} front face ${f} bare`).toBe(0);
      const otherBack = FACES.find((f) => !st.front.includes(f) && f !== expectedBareFace[view])!;
      expect(st.faces[otherBack].bare, `view ${view} back-right face ${otherBack} bare`).toBe(0);
      expect(st.faces[expectedBareFace[view]!].bare, `view ${view} back-left face ${expectedBareFace[view]} bare columns (measured: 68)`).toBe(0);
    }
  }, 300_000);

  it("terrace step through the footprint adds no bare columns (5x5, x-split, view 0) — PIN: fails, +1 bare on the N face (ADR-565)", () => {
    // Measured divergence from the prep (see header): the prep reported +9 bare columns on the
    // step-side back face; this port measures +1 (N face: 1 vs flat 0) for the x-split at X0+3,
    // and +1 on N for every x-split position tried. The pin is the invariant: a step inside the
    // footprint must add NO bare columns on any face.
    const flat = measure(5, 0, FLAT, "flat");
    const step = measure(5, 0, TERRACE_X, "terraceX");
    for (const [a, b] of [[flat.c2d, step.c2d], [flat.gl, step.gl]] as const) {
      for (const f of FACES) expect(b.faces[f].bare, `terrace ${f} bare vs flat ${a.faces[f].bare}`).toBe(a.faces[f].bare);
      for (const f of b.front) expect(b.faces[f].bare, `terrace front ${f} bare`).toBe(0);
    }
  }, 300_000);
});

/* ------------------------------------------------------------------ roof tile variant profiles (prep §2.4 step 1) */

describe("ADR-562 roof tile variant per-column profiles", () => {
  // Sprite-bound method (as adr404): manifest sprites + decoded atlas PNGs, alpha >= 128.
  interface Spr { key: string; atlas: string; anchor: { x: number; y: number }; building?: { frames: number[][] } }
  interface Atl { key: string; image: string; frameW: number; frameH: number; columns: number; dir: string }
  const atl = new Map<string, Atl>(), spr = new Map<string, Spr>();
  for (const [dir, file] of [["packages/assets/pack/building/", "manifest.building.json"], ["packages/assets/pack/", "manifest.json"]] as const) {
    const m = JSON.parse(readFileSync(resolve(ROOT, dir, file), "utf8")) as { atlases: Omit<Atl, "dir">[]; sprites: Spr[] };
    for (const a of m.atlases) if (!atl.has(a.key)) atl.set(a.key, { ...a, dir });
    for (const s of m.sprites) if (!spr.has(s.key)) spr.set(s.key, s);
  }
  /** Per-column bottom profile of one sprite row: Map<dx, bottommost opaque dy> relative to the anchor. */
  const bottomProfile = (key: string, r: number): Map<number, number> => {
    const s = spr.get(key)!, a = atl.get(s.atlas)!, rows = s.building!.frames;
    const ri = rows.length === 1 ? 0 : rows.length === 2 ? r & 1 : r & 3;
    const f = rows[ri]![0]!, flip = rows.length === 2 && (r & 3) >= 2;
    const im = atlasImg(a.key);
    const fx = (f % a.columns) * a.frameW, fy = Math.floor(f / a.columns) * a.frameH;
    const ax = s.anchor.x * a.frameW, ay = s.anchor.y * a.frameH;
    const out = new Map<number, number>();
    for (let y = 0; y < a.frameH; y++) for (let x = 0; x < a.frameW; x++) {
      if (im.rgba[((fy + y) * im.w + fx + x) * 4 + 3]! >= 128) {
        const dx = Math.floor(flip ? ax - (x + 0.5 - ax) : x + 0.5 - ax), dy = Math.floor(y + 0.5 - ay);
        if (dy > (out.get(dx) ?? -Infinity)) out.set(dx, dy);
      }
    }
    return out;
  };
  const diffProfiles = (a: Map<number, number>, b: Map<number, number>): { maxAbs: number; colsDiffer: number; cols: number } => {
    const cols = new Set([...a.keys(), ...b.keys()]); let maxAbs = 0, colsDiffer = 0;
    for (const c of cols) {
      const d = Math.abs((a.get(c) ?? -Infinity) - (b.get(c) ?? -Infinity));
      if (d > 0) colsDiffer++;
      if (Number.isFinite(d)) maxAbs = Math.max(maxAbs, d); else maxAbs = Infinity;
    }
    return { maxAbs, colsDiffer, cols: cols.size };
  };

  it("every hip 'lo' variant (v1/v2 moss, base + shk) has the same per-column bottom profile as variant 0", () => {
    const report: string[] = [];
    for (const shape of ["e", "o", "i", "p", "h"] as const) {
      for (const skin of [undefined, "shk"] as const) {
        const stem0 = `rfx_hip_lo_${shape}`;
        const key0 = rfxSpriteKeys(stem0, 1, skin).find((k) => spr.has(k));
        expect(key0, `${stem0} skin=${skin} v0 key`).toBeDefined();
        for (const v of [1, 2] as const) {
          const stemV = `${stem0}_v${v}`;
          // the exact key the game would draw for this variant stem (rfxSpriteKeys fallback order)
          const keyV = rfxSpriteKeys(stemV, 1, skin).find((k) => spr.has(k));
          const hasOwnArt = spr.has(skin ? `${stemV}_${skin}_t1` : `${stemV}_t1`);
          if (!hasOwnArt) { report.push(`${stemV} skin=${skin ?? "base"}: no variant art (falls back to ${keyV})`); continue; }
          expect(keyV).toBe(skin ? `${stemV}_${skin}_t1` : `${stemV}_t1`);
          for (let r = 0; r < 4; r++) {
            const d = diffProfiles(bottomProfile(key0!, r), bottomProfile(keyV!, r));
            report.push(`${stemV} skin=${skin ?? "base"} row${r}: maxAbsBottomDiff=${d.maxAbs} colsDiffer=${d.colsDiffer}/${d.cols}`);
            // A broad (~25 px) clear band over the front faces would need the variant's bottom edge
            // ~25 px higher than v0's. Tolerance: 2 px (anti-aliasing / moss speckle at the edge).
            expect(d.maxAbs, `${stemV} skin=${skin} row${r} bottom profile vs v0`).toBeLessThanOrEqual(2);
          }
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log("ADR-562 variant profiles:\n  " + report.join("\n  "));
  }, 300_000);
});
