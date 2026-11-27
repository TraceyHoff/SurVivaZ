/**
 * ADR-572: sky-through-tiles on the Canvas2D gt-block path — permanent coverage oracle, ported
 * from the ADR-572 measurement harness (~/workspace/work/measure-sky.md).
 *
 * MEASURED VERDICT this pins: S1 CONVICTED — on the Canvas2D gt path every camera-facing
 * 1-level face leaked the background through the gt art skirt (the skirt covers only ~21% of a
 * 1-level face; the old below-skirt fill started at z-1, i.e. nothing at drop = 1). Isolated +1
 * leaked 268 px at zoom 0.709 (worst column run 10 scaled px), the screenshot arrangement
 * 414 px, slope-to-flat 579 px where the ramp side faces the camera (the gt path draws sloped
 * tiles as flat art, so the strip between the flat diamond edge and the tilted top was bare).
 * The WebGL2 mesh and the Canvas2D flat path measured 0 in every configuration — the WebGL2
 * assertions below are the S4 documentation pin: they prove the mesh is sealed, so a wedge
 * seen on WebGL2 is a drawn surface reading as sky, not a coverage hole.
 *
 * THE FIX (canvas2d.ts gtBlock + canvasGroundHeight.ts slopeFaces): the FULL near-face polygon
 * is filled in the cliff colour UNDER the gt art for all drops (subsuming the below-skirt fill),
 * and camera-facing slope sides get their flat->tilted strip quad (geom.slopeFaces) filled
 * under the art likewise. Far faces were already filled in full.
 *
 * ORACLE (as measured): expected silhouette = the core tiles' tops + cliff faces from the
 * shared slope model (c2dGroundGeometry — the definition the measurement used; it is immune to
 * the interval-window corner false positives at 90/270 degrees, and water tops ARE included,
 * as both real paths draw them). Drawn sets come from the REAL builders:
 *  - gt: the real Canvas2DRenderer.gtBlock op stream (fill polygons verbatim; each art
 *    drawImage modelled as covering exactly its top diamond — the real skirt fringe below the
 *    diamond covers only ~21% of a face, so modelling it as 0 is conservative: pre-fix leaks
 *    here read larger than the measured ones, post-fix the geometric fill covers everything).
 *  - mesh: the real TilemapRenderer.build vertex/index buffers, projected with the iso math.
 *  - flat: the real c2dGroundGeometry polygons the flat path paints (top + all faces).
 * Rasterization is a scanline fill at the pixel-centre rule, in scaled (zoom) px.
 *
 * MATRIX (as measured, pruned the same way): 12 configurations; the 4 key configurations
 * (isolated +1, plateau convex corner diag-lower, screenshot arrangement, chunk-border +1)
 * run rotations 0/90/180/270 x zooms {0.557, 0.709, 1.10}; the other 8 run all 4 rotations
 * x zoom 0.709. "Rotation" r rotates the pattern in view space and drives both renderers at
 * view quarter r, so the view-rotation plumbing is exercised, not just pattern rotation.
 */
import { describe, expect, it } from "vitest";
import { TileMap, fromView, toView, tileToLocal } from "@engine/world";
import { Canvas2DRenderer } from "../src/canvas2d.js";
import { c2dGroundGeometry, c2dNeighbourLow, c2dTileHeight } from "../src/canvasGroundHeight.js";
import { GroundArt } from "../src/groundArt.js";
import { TilemapRenderer } from "../src/tilemap.js";
import { TileId } from "../src/ids.js";
import type { AtlasSource } from "../src/assets/atlasManager.js";

const GRASS = TileId.Grass, DIRT = TileId.Dirt, WATER = TileId.Water;
/** gt block geometry (canvas2d.ts GT_* constants): block 8x8, origin pads. */
const B = 8, GT_OX = (B - 1) * 32 + 34, GT_OY = 18;

// ---------- recording 2D context (adr415 pattern) ----------
type LogEntry = { op: string; [k: string]: unknown };
class RecCtx {
  log: LogEntry[] = [];
  filter = "none"; globalAlpha = 1; fillStyle = ""; imageSmoothingEnabled = false;
  private pts: [number, number][] = [];
  private rec(op: string, extra: Record<string, unknown> = {}): void { this.log.push({ op, ...extra }); }
  save(): void {} restore(): void {} translate(): void {} scale(): void {} transform(): void {} setTransform(): void {}
  clip(): void {} closePath(): void {} clearRect(): void {} fillRect(): void {} putImageData(): void {}
  beginPath(): void { this.pts = []; }
  moveTo(x: number, y: number): void { this.pts.push([x, y]); }
  lineTo(x: number, y: number): void { this.pts.push([x, y]); }
  fill(): void { this.rec("fill", { style: this.fillStyle, pts: this.pts }); this.pts = []; }
  drawImage(img: unknown, ...a: number[]): void { this.rec("drawImage", { img, a }); }
  createImageData(w: number, h: number): { width: number; height: number; data: Uint8ClampedArray } { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }
  getImageData(_x: number, _y: number, w: number, h: number): { width: number; height: number; data: Uint8ClampedArray } { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }
}
interface StubCanvas { width: number; height: number; ctx: RecCtx; getContext(k: string): RecCtx | null }
const stubCanvas = (): StubCanvas => { const ctx = new RecCtx(); return { width: 0, height: 0, ctx, getContext: () => ctx }; };

/** Fake registry (adr415 pattern): every key resolves to its own atlas page, 68x52 frame, anchor (34,18). */
function fakeRegistry(): { registry: never; sources: Map<string, AtlasSource> } {
  const keys = new Map<string, number>();
  const idOf = (k: string): number => { let id = keys.get(k); if (id === undefined) { id = keys.size; keys.set(k, id); } return id; };
  const keyOf = (id: number): string => [...keys.entries()].find(([, v]) => v === id)?.[0] ?? `k${id}`;
  const registry = {
    ids: { sprites: { tryId: (k: string): number | undefined => idOf(k) } },
    sprite: (id: number): { key: string; atlas: { key: string }; animList: never[] } => ({ key: keyOf(id), atlas: { key: `atl:${keyOf(id)}` }, animList: [] }),
    dirFrame: (id: number): { atlas: { key: string }; x: number; y: number; w: number; h: number; anchorX: number; anchorY: number; flipX: boolean } =>
      ({ atlas: { key: `atl:${keyOf(id)}` }, x: 0, y: 0, w: 68, h: 52, anchorX: 34, anchorY: 18, flipX: false }),
  };
  const sources = new Map<string, AtlasSource>();
  const add = (k: string): void => { sources.set(`atl:${k}`, { url: `atl:${k}` } as unknown as AtlasSource); };
  for (const m of ["grass", "dirt"]) for (const v of ["", "_b", "_c", "_d", "_e", "_f"]) add(`gt_${m}${v}`);
  add("gt_water"); add("gt_water_shallow");
  for (let m = 1; m < 256; m++) { add(`gt_grass_edge_${m}`); add(`gt_dirt_edge_${m}`); }
  return { registry: registry as never, sources };
}

// ---------- configurations (view-space offsets from the centre tile) ----------
type TileSpec = number | string; // number = land height; "W:<bed>" = water with that stored bed height
interface Cfg { name: string; key?: boolean; baseId: number; base: number; tiles: Record<string, TileSpec>; centreWorld?: [number, number] }
const CORE: [number, number][] = [];
for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) CORE.push([du, dv]);
const CONFIGS: Cfg[] = [
  { name: "isolated +1", key: true, baseId: GRASS, base: 0, tiles: { "0,0": 1 } },
  { name: "isolated +1, dirt", baseId: DIRT, base: 0, tiles: { "0,0": 1 } },
  { name: "pair +1 (one equal neighbour)", baseId: GRASS, base: 0, tiles: { "0,0": 1, "1,0": 1 } },
  { name: "plateau convex corner, diagonal lower", key: true, baseId: GRASS, base: 0, tiles: { "0,0": 1, "-1,0": 1, "0,-1": 1, "-1,-1": 1 } },
  { name: "plateau convex corner, diagonal equal", baseId: GRASS, base: 0, tiles: { "0,0": 1, "-1,0": 1, "0,-1": 1, "-1,-1": 1, "1,1": 1 } },
  { name: "plateau concave corner (diagonal-only low)", baseId: GRASS, base: 0, tiles: { "0,0": 1, "1,0": 1, "-1,0": 1, "0,1": 1, "0,-1": 1, "1,-1": 1, "-1,1": 1, "-1,-1": 1, "1,1": 0 } },
  { name: "slope-to-flat (ramp, +u face)", baseId: GRASS, base: 0, tiles: { "0,0": 1, "-1,0": 1, "0,-1": 1, "0,1": 1, "-1,-1": 1, "-1,1": 1, "1,0": 0, "1,-1": 0, "1,1": 0 } },
  { name: "{3,2,2,1} vertex", baseId: GRASS, base: 1, tiles: { "0,0": 3, "1,0": 2, "0,1": 2, "1,1": 1 } },
  { name: "+1 beside water, bed -1", baseId: GRASS, base: 0, tiles: { "0,0": 1, "1,0": "W:-1" } },
  { name: "+1 beside water, bed -71", baseId: GRASS, base: 0, tiles: { "0,0": 1, "1,0": "W:-71" } },
  { name: "screenshot arrangement", key: true, baseId: GRASS, base: 0, tiles: { "0,0": 1, "-1,-1": 1 } },
  { name: "chunk-border +1 (world 31,16)", key: true, baseId: GRASS, base: 0, tiles: { "0,0": 1 }, centreWorld: [31, 16] },
];
const rotOff = (du: number, dv: number, r: number): [number, number] => {
  switch (r & 3) { case 1: return [-dv, du]; case 2: return [-du, -dv]; case 3: return [dv, -du]; default: return [du, dv]; }
};

/** Build the world map for (cfg, rotation r): the pattern sits rotated by r in view space;
 *  the centre view tile is (4,4) of block (0,0), or the view tile of centreWorld for the border case. */
function buildScene(cfg: Cfg, r: number): { map: TileMap; cu: number; cv: number; bx: number; by: number } {
  const q = r & 3;
  const centreView: [number, number] = cfg.centreWorld ? (() => { const p = toView(cfg.centreWorld[0], cfg.centreWorld[1], q); return [p.u, p.v]; })() : [4, 4];
  const [cu, cv] = centreView;
  const spec = new Map<string, TileSpec>();
  for (let dv = -9; dv <= 9; dv++) for (let du = -9; du <= 9; du++) spec.set(`${cu + du},${cv + dv}`, cfg.base);
  for (const [k, v] of Object.entries(cfg.tiles)) {
    const [du, dv] = k.split(",").map(Number) as [number, number];
    const [ru, rv] = rotOff(du, dv, r);
    spec.set(`${cu + ru},${cv + rv}`, v);
  }
  const map = new TileMap();
  for (const [k, v] of spec) {
    const [u, vv] = k.split(",").map(Number) as [number, number];
    const w = fromView(u, vv, q);
    if (typeof v === "string") { map.setTile(w.x, w.y, WATER); map.getChunk(Math.floor(w.x / 32), Math.floor(w.y / 32))!.setHeight(tileToLocal(w.x), tileToLocal(w.y), Number(v.slice(2))); }
    else { map.setTile(w.x, w.y, cfg.baseId); map.getChunk(Math.floor(w.x / 32), Math.floor(w.y / 32))!.setHeight(tileToLocal(w.x), tileToLocal(w.y), v); }
  }
  // Fill every touched chunk completely with the base tile (as the measurement's scenes did):
  // a half-empty chunk would make the mesh emit void cliffs to NO_TILE_HEIGHT at the window edge.
  for (const ch of map.loadedChunks()) for (let ly = 0; ly < 32; ly++) for (let lx = 0; lx < 32; lx++)
    if (ch.get(lx, ly) === 0) { ch.set(lx, ly, cfg.baseId); ch.setHeight(lx, ly, cfg.base); }
  return { map, cu, cv, bx: Math.floor(cu / B), by: Math.floor(cv / B) };
}

// ---------- scanline rasterizer (pixel-centre rule, scaled px) ----------
type Pt = readonly [number, number];
interface Clip { x0: number; y0: number; x1: number; y1: number }
function fillPoly(set: Set<string>, poly: readonly Pt[], zoom: number, clip?: Clip): void {
  const pts = poly.map(([x, y]) => [x * zoom, y * zoom] as const);
  let ymin = Infinity, ymax = -Infinity;
  for (const [, y] of pts) { ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
  // The clip bounds the row/span loops: drawn sets include far-away geometry (e.g. mesh void
  // cliffs at chunk borders, 10k px tall) that can never cover the expected silhouette.
  const rowLo = Math.max(Math.floor(ymin), clip?.y0 ?? -Infinity), rowHi = Math.min(Math.ceil(ymax), clip?.y1 ?? Infinity);
  for (let py = rowLo; py <= rowHi; py++) {
    const yc = py + 0.5; if (yc < ymin || yc >= ymax) continue;
    const xs: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
      if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) xs.push(a[0] + ((yc - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = xs[i]!, x1 = xs[i + 1]!;
      const pxLo = Math.max(Math.floor(x0), clip?.x0 ?? -Infinity), pxHi = Math.min(Math.ceil(x1), clip?.x1 ?? Infinity);
      for (let px = pxLo; px <= pxHi; px++) if (px + 0.5 >= x0 && px + 0.5 < x1) set.add(`${px},${py}`);
    }
  }
}
const rasterize = (polys: readonly (readonly Pt[])[], zoom: number, clip?: Clip): Set<string> => { const s = new Set<string>(); for (const p of polys) fillPoly(s, p, zoom, clip); return s; };
const bboxOf = (polys: readonly (readonly Pt[])[], zoom: number, pad: number): Clip => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (const [x, y] of p) { x0 = Math.min(x0, x * zoom); y0 = Math.min(y0, y * zoom); x1 = Math.max(x1, x * zoom); y1 = Math.max(y1, y * zoom); }
  return { x0: Math.floor(x0) - pad, y0: Math.floor(y0) - pad, x1: Math.ceil(x1) + pad, y1: Math.ceil(y1) + pad };
};
function leakOf(expected: Set<string>, drawn: Set<string>): { leak: number; worstRun: number } {
  let leak = 0; const cols = new Map<number, number[]>();
  for (const k of expected) if (!drawn.has(k)) {
    leak++;
    const [x, y] = k.split(",").map(Number) as [number, number];
    const c = cols.get(x); if (c) c.push(y); else cols.set(x, [y]);
  }
  let worstRun = 0;
  for (const ys of cols.values()) {
    ys.sort((a, b) => a - b); let run = 1;
    for (let i = 1; i <= ys.length; i++) { if (i < ys.length && ys[i] === ys[i - 1]! + 1) run++; else { worstRun = Math.max(worstRun, run); run = 1; } }
  }
  return { leak, worstRun };
}

// ---------- drawn sets from the real builders ----------
/** Real gtBlock op stream -> drawn polygons in CENTRE-block coords (fills verbatim + art
 *  diamonds). Every block overlapping the core tiles is baked (a core tile on a block border —
 *  the chunk-border configuration — is drawn by its own block, not the centre one) and its
 *  polygons are translated into the centre block's frame (block origins differ by whole block
 *  steps; each block's own topPad shifts its local y). */
async function gtPolys(map: TileMap, q: number, cu: number, cv: number, bx: number, by: number): Promise<{ polys: Pt[][]; topPad: number }> {
  const prevDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = { createElement: (_t: string): StubCanvas => stubCanvas() };
  try {
    const { registry, sources } = fakeRegistry();
    const main = new RecCtx();
    const canvas = stubCanvas();
    const r = new Canvas2DRenderer(canvas as unknown as HTMLCanvasElement, main as unknown as CanvasRenderingContext2D);
    await r.atlas.setRegistry(registry, sources);
    r.loadImage = async (url: string) => ({ url }) as never;
    for (const k of sources.keys()) r.image(k); // start all atlas loads
    await new Promise((res) => setTimeout(res, 0)); await new Promise((res) => setTimeout(res, 0));
    const ga = new GroundArt(registry as never);
    const gt = r as unknown as { gtBlock(tm: TileMap, reg: never, ga: GroundArt, bx: number, by: number, s: number, b: boolean, q: number): { cv: StubCanvas; topPad: number } | null };
    const bake = async (i: number, j: number): Promise<{ cv: StubCanvas; topPad: number }> => {
      for (let n = 0; n < 30; n++) { const blk = gt.gtBlock(map, registry, ga, i, j, 0, true, q); if (blk) return blk; await new Promise((res) => setTimeout(res, 0)); }
      throw new Error("gtBlock never baked (an atlas image never landed)");
    };
    const centre = await bake(bx, by);
    const polys: Pt[][] = [];
    const collect = (cvx: StubCanvas, dxT: number, dyT: number): void => {
      for (const e of cvx.ctx.log) {
        if (e.op === "fill") polys.push((e.pts as [number, number][]).map(([x, y]) => [x + dxT, y + dyT] as Pt));
        else if (e.op === "drawImage") {
          const a = e.a as number[]; // drawImage args after img: (sx, sy, sw, sh, dx, dy, dw, dh); dest + anchor (34,18) = diamond centre
          const cx = a[4]! + 34 + dxT, cy = a[5]! + 18 + dyT;
          polys.push([[cx, cy - 16], [cx + 32, cy], [cx, cy + 16], [cx - 32, cy]]);
        }
      }
    };
    collect(centre.cv, 0, 0);
    for (let j = Math.floor((cv - 1) / B); j <= Math.floor((cv + 1) / B); j++) for (let i = Math.floor((cu - 1) / B); i <= Math.floor((cu + 1) / B); i++) {
      if (i === bx && j === by) continue;
      const blk = await bake(i, j);
      collect(blk.cv, ((i - bx) - (j - by)) * B * 32, ((i - bx) + (j - by)) * B * 16 - blk.topPad + centre.topPad);
    }
    return { polys, topPad: centre.topPad };
  } finally { (globalThis as { document?: unknown }).document = prevDocument; }
}
/** Real TilemapRenderer.build buffers -> drawn triangles in block coords (iso projection, view quarter q). */
function meshPolys(map: TileMap, q: number, bx: number, by: number, topPad: number): Pt[][] {
  const polys: Pt[][] = [];
  const ox = (bx - by) * B * 32 - GT_OX, oy = (bx + by) * B * 16 - GT_OY - topPad;
  for (const chunk of map.loadedChunks()) {
    let buf: ArrayBuffer | null = null; let idx: number[] = [];
    const gl = {
      createVertexArray: () => ({}), createBuffer: () => ({}), bindVertexArray: () => {}, bindBuffer: () => {},
      bufferData: (_t: unknown, data: ArrayBuffer | Uint16Array | Uint32Array) => { if (data instanceof ArrayBuffer) buf = data; else idx = [...data]; },
      enableVertexAttribArray: () => {}, vertexAttribPointer: () => {},
    };
    const renderer = Object.assign(Object.create(TilemapRenderer.prototype), { gl }) as { build(m: TileMap, c: unknown, o?: unknown): void };
    renderer.build(map, chunk, undefined);
    const f = new Float32Array(buf!);
    const proj = (k: number): Pt => {
      const vp = toView(f[k * 4]! - 0.5, f[k * 4 + 1]! - 0.5, q); // mesh corners are tile-corner coords; C2D centres tiles on integer points
      return [(vp.u - vp.v) * 32 - ox, (vp.u + vp.v) * 16 - f[k * 4 + 2]! * 16 - oy];
    };
    for (let i = 0; i + 2 < idx.length; i += 3) polys.push([proj(idx[i]!), proj(idx[i + 1]!), proj(idx[i + 2]!)]);
  }
  return polys;
}
/** Expected silhouette + flat-path drawn set, both from the shared slope model (c2dGroundGeometry). */
function expectedAndFlat(map: TileMap, q: number, cu: number, cv: number, bx: number, by: number, topPad: number): { expected: Pt[][]; flat: Pt[][] } {
  const geomAt = (u: number, v: number): ReturnType<typeof c2dGroundGeometry> | null => {
    const w = fromView(u, v, q);
    const z = c2dTileHeight(map, w.x, w.y); if (z === undefined) return null;
    return c2dGroundGeometry(z, (dx, dy) => { const n = fromView(u + dx, v + dy, q); return c2dNeighbourLow(map, n.x, n.y); });
  };
  const off = (u: number, v: number): [number, number] => [(u - bx * B - (v - by * B)) * 32 + GT_OX, ((u - bx * B) + (v - by * B)) * 16 + GT_OY + topPad];
  const shift = (poly: readonly Pt[], o: [number, number]): Pt[] => poly.map(([x, y]) => [x + o[0], y + o[1]] as Pt);
  const expected: Pt[][] = [], flat: Pt[][] = [];
  for (const [du, dv] of CORE) {
    const g = geomAt(cu + du, cv + dv); if (!g) continue;
    const o = off(cu + du, cv + dv);
    expected.push(shift(g.top, o)); for (const f of g.faces) expected.push(shift(f.poly, o));
  }
  for (let v = by * B - 1; v <= by * B + B; v++) for (let u = bx * B - 1; u <= bx * B + B; u++) {
    const g = geomAt(u, v); if (!g) continue;
    const o = off(u, v);
    flat.push(shift(g.top, o)); for (const f of g.faces) flat.push(shift(f.poly, o));
  }
  return { expected, flat };
}

// ---------- the oracle ----------
describe("ADR-572 coverage oracle: no background inside the ground silhouette", () => {
  for (const cfg of CONFIGS) {
    const zooms = cfg.key ? [0.557, 0.709, 1.1] : [0.709];
    for (let r = 0; r < 4; r++) for (const zoom of zooms) {
      it(`${cfg.name} — rot ${r * 90}°, zoom ${zoom}: gt / mesh / flat leak = 0`, async () => {
        const { map, cu, cv, bx, by } = buildScene(cfg, r);
        const gt = await gtPolys(map, r, cu, cv, bx, by);
        const { expected, flat } = expectedAndFlat(map, r, cu, cv, bx, by, gt.topPad);
        const expSet = rasterize(expected, zoom);
        expect(expSet.size, "oracle sanity: the expected silhouette is non-trivial").toBeGreaterThan(400);
        const clip = bboxOf(expected, zoom, 2);
        const cases: [string, Pt[][]][] = [["gt", gt.polys], ["mesh", meshPolys(map, r, bx, by, gt.topPad)], ["flat", flat]];
        for (const [path, polys] of cases) {
          const { leak, worstRun } = leakOf(expSet, rasterize(polys, zoom, clip));
          expect(leak, `${cfg.name} rot ${r * 90}° zoom ${zoom} ${path}: leak ${leak} px, worst column run ${worstRun}`).toBe(0);
        }
      });
    }
  }

  it("geometry pin: a ramp's slopeFaces quad is the flat->neighbour strip on the slope side only", () => {
    const map = new TileMap();
    for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) { map.setTile(x, y, GRASS); map.getChunk(Math.floor(x / 32), Math.floor(y / 32))!.setHeight(tileToLocal(x), tileToLocal(y), 1); }
    map.getChunk(0, 0)!.setHeight(tileToLocal(1), tileToLocal(0), 0);
    map.getChunk(0, 0)!.setHeight(tileToLocal(1), tileToLocal(-1), 0);
    map.getChunk(0, 0)!.setHeight(tileToLocal(1), tileToLocal(1), 0);
    const g = c2dGroundGeometry(1, (dx, dy) => c2dNeighbourLow(map, dx, dy));
    expect(g.faces).toEqual([]); // slope side: no cliff face, as in the mesh
    expect(g.slopeFaces).toHaveLength(1);
    expect(g.slopeFaces[0]!.side).toBe(0);
    // [corner(R, z=1), corner(B, z=1), corner(B, low=0), corner(R, low=0)] — the strip the flat gt art leaves bare.
    expect(g.slopeFaces[0]!.poly).toEqual([[32, -16], [0, 0], [0, 16], [32, 0]]);
    expect(g.slopeFaces[0]!.low).toBe(0);
  });

  it("geometry pin: a near face with a tilted top edge fills as the flat-top quad (step beside water)", () => {
    // +1 tile, +u neighbour water (low -0.25), all other neighbours 0: the +v face's top edge is
    // tilted (its L corner drops toward the 0 ground, its B corner is held up by the water
    // vertex), so the face polygon starts at the tilted edge — but the gt fill must start at
    // the FLAT edge (both top corners at z) or the protruding tilted-top sliver stays bare.
    const map = new TileMap();
    for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) { map.setTile(x, y, GRASS); map.getChunk(Math.floor(x / 32), Math.floor(y / 32))!.setHeight(tileToLocal(x), tileToLocal(y), 0); }
    map.getChunk(0, 0)!.setHeight(tileToLocal(0), tileToLocal(0), 1);
    map.setTile(1, 0, WATER);
    const g = c2dGroundGeometry(1, (dx, dy) => c2dNeighbourLow(map, dx, dy));
    const face = g.faces.find((f) => f.side === 2)!;
    const fill = g.fillFaces.find((f) => f.side === 2)!;
    expect(face.poly).toEqual([[-32, 0], [0, 0], [0, 16], [-32, 0]]); // tilted top edge: L corner dropped to 0 (face degenerates to a triangle there)
    expect(fill.poly).toEqual([[-32, -16], [0, 0], [0, 16], [-32, 0]]); // flat-top quad: L corner back up at z=1, same bottom span
    const far = g.fillFaces.find((f) => f.side === 3)!;
    expect(far.poly).toEqual(g.faces.find((f) => f.side === 3)!.poly); // far faces fill as-is (side 1 here is a slope side, not a face)
  });
});
