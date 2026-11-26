import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { World, Transform, PrevTransform, TimeOfDay, Appearance, PlayerId, type Entity } from "@engine/core";
import { loadManifest, mergeManifests, type FrameRef } from "@engine/assets";
import { PACK_DIR, readManifestJson } from "@engine/assets/node";
import { CHUNK_SIZE, FLOOR_HEIGHT_LEVELS, type TileMap } from "@engine/world";
import {
  DEFAULT_ID_LOCK, DEFAULT_RAW_DEFS, loadDefs, BuildPiece, installGameplay, structureIndexSystem,
  type GameDefs,
} from "@engine/gameplay";
import { Canvas2DRenderer } from "@engine/render";
import { IsoView } from "../src/view.js";
import { LightTable } from "../src/lights.js";
import { decodeRgba } from "./png-rgba.js";
import {
  collectStructureDump, serializeStructureDump, parseStructureDump, dumpHeightAt,
  STRUCTURE_DUMP_RADIUS, type StructureDumpPiece,
} from "../src/structure-dump.js";

/**
 * ADR-566 — ?diag=1 structure dump round-trip gate.
 *
 * Builds the ADR-562 two-storey house (same layout/helpers as the pin), serializes it with
 * the dump function, parses the text back, rebuilds the parsed pieces + terrain heights
 * verbatim through the same IsoView mirror path the pin uses (raw BuildPiece entities +
 * structureIndexSystem + IsoView.render + Canvas2D gatherPieces drawn-pixel raster), and
 * asserts the re-measured roof-coverage numbers match the original house's exactly:
 * per-face bare-column counts / worst clear bands, corner clear bands, and the ADR-404
 * pair statistics. A stub serializer that emits nothing fails here: parseStructureDump
 * throws on empty text and the round-trip pieces/heights would not match.
 */

const reg = loadManifest(mergeManifests([
  { name: "pack", manifest: readManifestJson(PACK_DIR + "manifest.json") },
  { name: "building", manifest: readManifestJson(PACK_DIR + "building/manifest.building.json") },
] as never).manifest).registry;
const DEFS: GameDefs = loadDefs(DEFAULT_RAW_DEFS, { lock: DEFAULT_ID_LOCK });
const ROOT = resolve(__dirname, "../../..");

/* ------------------------------------------------------------------ atlas pixels (ADR-562 port) */

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
    if (im.rgba[((f.y + py) * im.w + f.x + px) * 4 + 3]! >= 128) {
      out.push([f.flipX ? f.anchorX - px - 1 : px - f.anchorX, py - f.anchorY]);
    }
  }
  framePixCache.set(ck, out); return out;
}

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
function rasterFrame(occ: Occ, f: FrameRef, sx: number, sy: number, clip?: [number, number][]): void {
  for (const [dx, dy] of framePixels(f)) {
    if (clip && !pointInPoly(clip, dx, dy)) continue;
    occAdd(occ, Math.round(sx + dx), Math.round(sy + dy));
  }
}

/* ------------------------------------------------------------------ house + mirror (ADR-562 port) */

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

interface Placed extends StructureDumpPiece { e: Entity }
const X0 = 4, Y0 = 4, N = 5;
const placeInto = (net: World, p: StructureDumpPiece): Placed => {
  const e = net.create();
  net.add(e, Transform, { x: p.x, y: p.y, z: p.z, facing: 0 });
  net.add(e, PrevTransform, { x: p.x, y: p.y, z: p.z, facing: 0 });
  net.add(e, BuildPiece, { type: DEFS.pieceId(p.key), rot: p.rot, variant: p.variant, tier: p.tier, hp: 100, damageStage: 0, paint: 0, tint: 0 });
  return { ...p, e };
};
/** The ADR-562 house as a dump-piece list: two storeys, wood tier 1, 5x5 at (4..9)^2. */
const housePieces = (): StructureDumpPiece[] => {
  const out: StructureDumpPiece[] = [];
  const place = (key: string, x: number, y: number, z: number, rot = 0): void => { out.push({ key, x, y, z, rot, tier: 1, variant: 0 }); };
  const x1 = X0 + N, y1 = Y0 + N, F = FLOOR_HEIGHT_LEVELS;
  for (let y = Y0; y < y1; y++) for (let x = X0; x < x1; x++) place("foundation", x + 0.5, y + 0.5, 0);
  for (const s of [0, 1]) {
    const z = s * F;
    place("wall_corner_outer", X0, Y0, z, 0); place("wall_corner_outer", x1, Y0, z, 1);
    place("wall_corner_outer", x1, y1, z, 2); place("wall_corner_outer", X0, y1, z, 3);
    for (let x = X0 + 1; x < x1; x++) place("wall", x + 0.5, Y0, z);
    for (let x = X0; x < x1; x++) place(x === X0 + 2 ? "wall_doorway" : x === X0 + 3 ? "wall_window" : "wall", x + 0.5, y1, z);
    for (let y = Y0 + 1; y < y1; y++) { place("wall", X0, y + 0.5, z); place("wall", x1, y + 0.5, z); }
    if (s === 0) for (let y = Y0; y < y1; y++) for (let x = X0; x < x1; x++) place("floor", x + 0.5, y + 0.5, F);
  }
  for (let y = Y0; y < y1; y++) for (let x = X0; x < x1; x++) place("roof_hip", x + 0.5, y + 0.5, 2 * F);
  return out;
};

/* ------------------------------------------------------------------ measurement (Canvas2D pass of the pin) */

type Face = "N" | "S" | "E" | "W";
const FACES: Face[] = ["N", "S", "E", "W"];
interface Stats {
  faces: Record<Face, { cols: number; bare: number; maxClear: number }>;
  corners: { id: string; maxClear: number; wideCols: number }[];
  pair: { cols: number; minOverlap: number; medianOverlap: number; maxGap: number };
}
const faceOf = (p: StructureDumpPiece): Face[] => {
  const x1 = X0 + N, y1 = Y0 + N, out: Face[] = [];
  if (p.y === Y0) out.push("N");
  if (p.y === y1) out.push("S");
  if (p.x === X0) out.push("W");
  if (p.x === x1) out.push("E");
  return out;
};
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

function measure(pieces: StructureDumpPiece[], h: (x: number, y: number) => number): Stats {
  const renderer = mkRenderer();
  const iso = mkIso(renderer);
  renderer.camera.setView(0);
  const net = mkNet();
  const placed = pieces.map((p) => placeInto(net, p));
  structureIndexSystem(net);
  iso.render(net, tilesWith(h), undefined, 1);
  const map = (iso as unknown as { map: Map<Entity, Entity> }).map;
  const byView = new Map<Entity, Placed>(); for (const p of placed) { const ve = map.get(p.e); if (ve !== undefined) byView.set(ve, p); }

  const all = newOcc(), roofOcc = newOcc(), pairWall = newOcc();
  const wallByFace = new Map<Face, Occ>(FACES.map((f) => [f, newOcc()]));
  const cornerOcc = new Map<string, Occ>();
  const gathered = (renderer as unknown as { gatherPieces(w: unknown, r: unknown, t: number): { e: Entity; sx: number; sy: number; f: FrameRef; clip?: [number, number][] }[] })
    .gatherPieces(iso.view, reg, 0);
  for (const pc of gathered) {
    const p = byView.get(pc.e); if (!p) continue;
    const draw = (occ: Occ): void => rasterFrame(occ, pc.f, pc.sx, pc.sy, pc.clip);
    draw(all);
    if (p.key === "roof_hip") draw(roofOcc);
    if (p.z === FLOOR_HEIGHT_LEVELS && p.key.startsWith("wall")) {
      for (const f of faceOf(p)) draw(wallByFace.get(f)!);
      if (p.key === "wall_corner_outer") {
        const id = `${p.x},${p.y}`;
        let occ = cornerOcc.get(id); if (!occ) cornerOcc.set(id, (occ = newOcc()));
        draw(occ);
      }
      if (p.key === "wall" && p.x === X0 + 1.5 && p.y === Y0 + N) draw(pairWall);
    }
  }

  const faces = {} as Stats["faces"];
  for (const f of FACES) {
    const clear = clearAbove(all, wallByFace.get(f) ?? newOcc());
    let bare = 0, maxClear = 0;
    for (const v of clear.values()) { if (v >= 300) bare++; if (v < 300) maxClear = Math.max(maxClear, v); }
    faces[f] = { cols: clear.size, bare, maxClear };
  }
  const corners: Stats["corners"] = [];
  for (const [id, occ] of cornerOcc) {
    const clear = clearAbove(all, occ);
    let maxClear = 0, wideCols = 0;
    for (const v of clear.values()) { maxClear = Math.max(maxClear, v); if (v >= 10) wideCols++; }
    corners.push({ id, maxClear, wideCols });
  }
  corners.sort((a, b) => (a.id < b.id ? -1 : 1));
  const overlaps: number[] = []; let maxGap = 0;
  for (const [col, rows] of pairWall) {
    const top = Math.min(...rows); const roofRows = roofOcc.get(col); if (!roofRows) continue;
    const bottom = Math.max(...roofRows);
    overlaps.push(bottom - top);
    if (bottom < top) maxGap = Math.max(maxGap, top - bottom);
  }
  overlaps.sort((a, b) => a - b);
  return {
    faces, corners,
    pair: { cols: overlaps.length, minOverlap: overlaps[0] ?? -999, medianOverlap: overlaps[Math.floor(overlaps.length / 2)] ?? -999, maxGap },
  };
}

/* ------------------------------------------------------------------ the gate */

const FLAT = (): number => 3;
const CENTER = { x: X0 + 2, y: Y0 + 2 };

describe("ADR-566 structure dump format", () => {
  it("collects pieces + raw heights within the radius, excludes outside pieces, and round-trips through text", () => {
    const pieces = [...housePieces(), { key: "wall", x: CENTER.x + 40.5, y: CENTER.y + 0.5, z: 0, rot: 0, tier: 1, variant: 0 }];
    const data = collectStructureDump({ center: CENTER, view: 2, pieces, heightAt: (x, y) => (x < X0 + 3 ? 3 : 2) });
    expect(data.radius).toBe(STRUCTURE_DUMP_RADIUS);
    expect(data.w).toBe(STRUCTURE_DUMP_RADIUS * 2 + 1);
    expect(data.heights.length).toBe(data.h);
    expect(data.pieces.length).toBe(housePieces().length); // the far wall is excluded
    expect(data.pieces.some((p) => p.x > CENTER.x + 20)).toBe(false);
    // terrace step survives in the grid: west side 3, east side 2 (raw chunk.height values)
    expect(dumpHeightAt(data, X0, Y0)).toBe(3);
    expect(dumpHeightAt(data, X0 + 4, Y0)).toBe(2);
    expect(dumpHeightAt(data, CENTER.x + 100, CENTER.y)).toBeUndefined();

    const text = serializeStructureDump(data);
    expect(text.split("\n")[0]).toBe("SURVIVAZ_STRUCTURE_DUMP 1");
    expect(text).toContain(`center ${CENTER.x} ${CENTER.y}`);
    expect(text).toContain("view 2");
    expect(parseStructureDump(text)).toEqual(data);
  });

  it("rejects empty / stub output — a serializer that emits nothing cannot pass", () => {
    expect(() => parseStructureDump("")).toThrow();
    expect(() => parseStructureDump("SURVIVAZ_STRUCTURE_DUMP 1\n")).toThrow();
    expect(() => parseStructureDump("not a dump")).toThrow();
  });
});

describe("ADR-566 round-trip rebuild", () => {
  it("the dumped house rebuilds verbatim and re-measures identical roof coverage", () => {
    const original = housePieces();
    const text = serializeStructureDump(collectStructureDump({
      center: CENTER, view: 0, pieces: original, heightAt: FLAT,
    }));
    const parsed = parseStructureDump(text);
    // pieces round-trip exactly (key, x, y, z, rot, tier, variant), in dump sort order
    const sorted = [...original].sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || a.rot - b.rot);
    expect(parsed.pieces).toEqual(sorted);
    expect(parsed.center).toEqual(CENTER);
    expect(parsed.view).toBe(0);

    const before = measure(original, FLAT);
    // sanity: the original measures like the (now green) ADR-562 pin at view 0
    expect(before.faces.W.bare).toBe(0);
    expect(before.faces.S.bare).toBe(0);
    expect(before.pair.cols).toBeGreaterThan(40);
    expect(before.pair.maxGap).toBeLessThanOrEqual(3);
    expect(before.pair.medianOverlap).toBeGreaterThanOrEqual(5);

    const rebuilt = measure(parsed.pieces, (x, y) => dumpHeightAt(parsed, x, y) ?? parsed.heights[parsed.center.y - parsed.y0]![parsed.center.x - parsed.x0]!);
    // eslint-disable-next-line no-console
    console.log(`ADR-566 round-trip\n  before  ${JSON.stringify(before)}\n  rebuilt ${JSON.stringify(rebuilt)}`);
    expect(rebuilt).toEqual(before);
  }, 300_000);
});
