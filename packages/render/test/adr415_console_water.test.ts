// ADR-415: water tiles show on the console browser.
// Root cause (traced, not guessed): the Xbox browser lands on the Canvas2D fallback whenever WebGL2
// cannot be created (chooseRenderer: "Xbox Edge after GPU reset"; view.ts falls back to Canvas2D when
// the IsoRenderer constructor throws). On that path water was drawn ONLY as the flat ADR-184 gradient
// image (drawWater) — gtBlock explicitly skipped every GroundLayerKind.Water layer — so water showed
// no tiles, while the WebGL2 path draws gt_water instances with a shore tint. The fix draws the
// gt_water / gt_water_shallow art in gtBlock with the same deep->shallow brightness ramp the WebGL2
// shader applies (0.80 deep -> 1.06 shallow). The WebGL2 builders are pinned here too: they were
// verified to emit water instances correctly, so the missing tiles are specific to the fallback path.
import { describe, it, expect, afterEach } from "vitest";
import { TileMap } from "@engine/world";
import { World } from "@engine/core";
import { TileTerrain } from "../src/terrainTiles.js";
import { TilemapRenderer } from "../src/tilemap.js";
import { Canvas2DRenderer, chooseRenderer } from "../src/canvas2d.js";
import type { AtlasManager } from "../src/assets/atlasManager.js";
import type { AtlasSource } from "../src/assets/atlasManager.js";

/** Lake map: grass everywhere, deep water (1) x10..22/y10..22, shallow water (8) x24..27/y10..13. */
function lakeMap(): TileMap {
  const map = new TileMap();
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const deep = x >= 10 && x < 22 && y >= 10 && y < 22;
    const shallow = x >= 24 && x < 28 && y >= 10 && y < 14;
    map.setTile(x, y, deep ? 1 : shallow ? 8 : 3);
    map.getChunk(0, 0)!.setHeight(x, y, 0);
  }
  return map;
}
/** Run the REAL TileTerrain chunk builder, capture its GPU upload (16 floats per instance). */
function buildTerrain(map: TileMap, art: number): { up: Float32Array; seen: string[] } {
  let uploaded = new Float32Array();
  const gl = {
    createVertexArray: () => ({}), createBuffer: () => ({}), bindVertexArray: () => {}, bindBuffer: () => {},
    bufferData: (_t: unknown, data: Float32Array<ArrayBuffer>) => { uploaded = data; },
    enableVertexAttribArray: () => {}, vertexAttribPointer: () => {}, vertexAttribDivisor: () => {},
  };
  const seen: string[] = [];
  const ground = { id: (k: string): number => { seen.push(k); return 1; } };
  const terrain = Object.assign(Object.create(TileTerrain.prototype), { gl, builds: 0, grazedRev: 0, ground: () => ground });
  const atlas = { registry: { ids: { sprites: { tryId: () => 1 } } }, animEntries: (_id: number) => ({ first: 0, count: 1, fps: 0, ax: 34, ay: 18 }), version: 0 } as unknown as AtlasManager;
  terrain.build(map, map.getChunk(0, 0), atlas, undefined, art, 0);
  return { up: uploaded, seen };
}
/** Instances (16-float rows) for one view cell. Row: [x, y, z, first, count, fps, mask, 0, ax, ay, water, mode, d0..d3]. */
const rowsAt = (up: Float32Array, cx: number, cy: number): number[][] => {
  const out: number[][] = [];
  for (let i = 0; i < up.length; i += 16) if (up[i] === cx + 0.5 && up[i + 1] === cy + 0.5) out.push([...up.slice(i, i + 16)]);
  return out;
};
/** Run the REAL mesh builder, decode its vertex buffer: {x, y, z, flag} per vertex (flag 1 = water top). */
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

describe("ADR-415 WebGL2 path (control): water tiles are emitted", () => {
  it("gt mode: deep water emits gt_water with shore corner tints; shallow emits gt_water_shallow", () => {
    const { up, seen } = buildTerrain(lakeMap(), 1);
    expect(seen).toContain("gt_water"); expect(seen).toContain("gt_water_shallow");
    const deep = rowsAt(up, 16, 16); expect(deep).toHaveLength(1);
    expect(deep[0]![10]).toBe(1); // water flag
    expect(deep[0]![11]).toBe(1); // gt art mode
    expect(deep[0]!.slice(12).every((v) => v >= 0 && v <= 0.2)).toBe(true); // deep: low corner tints
    const shore = rowsAt(up, 10, 16); expect(shore).toHaveLength(1);
    expect(shore[0]![10]).toBe(1); expect(shore[0]![11]).toBe(1);
    expect(Math.min(...shore[0]!.slice(12))).toBeGreaterThan(0.85); // shore: high corner tints
    const shallow = rowsAt(up, 25, 11); expect(shallow).toHaveLength(1);
    expect(shallow[0]![10]).toBe(1); expect(shallow[0]![11]).toBe(1);
  });
  it("legacy mode: water still emits tile_water instances", () => {
    const { up } = buildTerrain(lakeMap(), 0);
    const deep = rowsAt(up, 16, 16); expect(deep).toHaveLength(1);
    expect(deep[0]![10]).toBe(1); expect(deep[0]![11]).toBe(0); // legacy art mode
  });
  it("mesh: water top faces carry flag 1 at the flat surface (z - 0.25)", () => {
    const verts = buildMesh(lakeMap());
    const top = verts.filter((v) => v.flag === 1 && v.x >= 10 && v.x <= 22 && v.y >= 10 && v.y <= 22);
    expect(top).toHaveLength(12 * 12 * 4); // one flag-1 quad per deep-water tile
    expect(top.every((v) => v.z === -0.25)).toBe(true);
  });
});

// ---- Canvas2D fallback (the console browser's path) ----

type LogEntry = { op: string; [k: string]: unknown };
/** Recording stand-in for a 2D context: every call is logged, filter sets are logged too. */
class RecCtx {
  log: LogEntry[] = [];
  filter = "none"; globalAlpha = 1; globalCompositeOperation = "source-over"; fillStyle = ""; imageSmoothingEnabled = false; imageSmoothingQuality = "high";
  private rec(op: string, extra: Record<string, unknown> = {}): void { this.log.push({ op, ...extra }); }
  setTransform(...a: number[]): void { this.rec("setTransform", { a }); }
  save(): void { this.rec("save"); } restore(): void { this.rec("restore"); }
  translate(...a: number[]): void { this.rec("translate", { a }); }
  transform(...a: number[]): void { this.rec("transform", { a }); }
  scale(...a: number[]): void { this.rec("scale", { a }); }
  rotate(...a: number[]): void { this.rec("rotate", { a }); }
  clip(): void { this.rec("clip"); }
  beginPath(): void { this.rec("beginPath"); }
  moveTo(...a: number[]): void { this.rec("moveTo", { a }); }
  lineTo(...a: number[]): void { this.rec("lineTo", { a }); }
  closePath(): void { this.rec("closePath"); }
  arc(...a: number[]): void { this.rec("arc", { a }); }
  fill(): void { this.rec("fill"); }
  clearRect(...a: number[]): void { this.rec("clearRect", { a }); }
  fillRect(...a: number[]): void { this.rec("fillRect", { a }); }
  drawImage(img: unknown, ...a: number[]): void { this.rec("drawImage", { img, a }); }
  putImageData(img: unknown, ...a: number[]): void { this.rec("putImageData", { img, a }); }
  createImageData(w: number, h: number): { width: number; height: number; data: Uint8ClampedArray } { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }
  getImageData(_x: number, _y: number, w: number, h: number): { width: number; height: number; data: Uint8ClampedArray } { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }
  createRadialGradient(): { addColorStop(): void } { return { addColorStop: (): void => {} }; }
}
interface StubCanvas { width: number; height: number; ctx: RecCtx; getContext(k: string): RecCtx | null }
const stubCanvas = (): StubCanvas => {
  const ctx = new RecCtx();
  const c: StubCanvas = { width: 0, height: 0, ctx, getContext: (_k: string) => ctx };
  // Route filter assignments through the log (the renderer sets g.filter = ...).
  let f = "none"; Object.defineProperty(ctx, "filter", { get: () => f, set: (v: string) => { f = v; ctx.log.push({ op: "filter", value: v }); } });
  return c;
};

/** Minimal registry: every gt_/tile_ key resolves, each to its own atlas page; waterfall/fx keys are absent. */
function fakeRegistry(): { registry: unknown; keys: Map<string, number> } {
  const keys = new Map<string, number>();
  const idOf = (k: string): number => { let id = keys.get(k); if (id === undefined) { id = keys.size; keys.set(k, id); } return id; };
  const frames = (k: string): { atlas: { key: string }; x: number; y: number; w: number; h: number; anchorX: number; anchorY: number; flipX: boolean } =>
    k.startsWith("tile_")
      ? { atlas: { key: `atl:${k}` }, x: 0, y: 0, w: 64, h: 48, anchorX: 32, anchorY: 16, flipX: false }
      : { atlas: { key: `atl:${k}` }, x: 0, y: 0, w: 68, h: 52, anchorX: 34, anchorY: 18, flipX: false };
  const registry = {
    ids: { sprites: { tryId: (k: string): number | undefined => (k.includes("waterfall") || k.startsWith("fx_") ? undefined : idOf(k)) } },
    sprite: (id: number): { key: string; atlas: { key: string }; animList: never[] } => {
      const key = [...keys.entries()].find(([, v]) => v === id)?.[0] ?? `k${id}`;
      return { key, atlas: { key: `atl:${key}` }, animList: [] };
    },
    dirFrame: (id: number): ReturnType<typeof frames> => frames([...keys.entries()].find(([, v]) => v === id)?.[0] ?? `k${id}`),
  };
  return { registry, keys };
}

describe("ADR-415 console path (Canvas2D fallback): water tiles are drawn", () => {
  const prevDocument = (globalThis as { document?: unknown }).document;
  const created: StubCanvas[] = [];
  afterEach(() => { (globalThis as { document?: unknown }).document = prevDocument; created.length = 0; });

  const renderLake = async (): Promise<{ main: RecCtx; blocks: StubCanvas[]; waterCanvas: StubCanvas | undefined }> => {
    (globalThis as { document?: unknown }).document = { createElement: (_tag: string): StubCanvas => { const c = stubCanvas(); created.push(c); return c; } };
    const main = new RecCtx();
    const canvas = { width: 0, height: 0 } as unknown as HTMLCanvasElement;
    const r = new Canvas2DRenderer(canvas, main as unknown as CanvasRenderingContext2D);
    const { registry } = fakeRegistry();
    const want = ["gt_grass", "gt_grass_b", "gt_grass_c", "gt_grass_d", "gt_grass_e", "gt_grass_f", "gt_water", "gt_water_shallow", "gt_ice", "gt_water_leaves_a"];
    const sources = new Map<string, AtlasSource>(want.map((k) => [`atl:${k}`, { url: `atlases/atl:${k}.png` } as unknown as AtlasSource]));
    await r.atlas.setRegistry(registry as never, sources);
    r.loadImage = async (url: string) => ({ url }) as never;
    r.tilemap = lakeMap();
    r.resize(640, 480, 1);
    r.camera.lookAt(16, 16);
    const world = new World();
    r.render(world, 1); // frame 1: atlas image loads start
    await new Promise((res) => setTimeout(res, 0)); await new Promise((res) => setTimeout(res, 0));
    // A gt block aborts on its first still-loading image, so blocks bake progressively as the atlas
    // images land (same as the real fallback boot); yield between frames so the loads resolve.
    for (let f = 0; f < 12; f++) { r.render(world, 1); await Promise.resolve(); }
    // ADR-414: gt block canvases are GT_H + topPad + botPad tall (shore cells carry a -0.25 water-inset
    // low, so lake blocks are 280 px, not 276); width still identifies them.
    const blocks = created.filter((c) => c.width === 516 && c.height >= 276);
    const waterCanvas = created.find((c) => c.width === 45 && c.height === 45);
    return { main, blocks, waterCanvas };
  };
  /** (filter brightness, image url) pairs for every frame drawn into a gt block, in log order. */
  const blockDraws = (blocks: StubCanvas[]): { br: number | undefined; url: string }[] => {
    const out: { br: number | undefined; url: string }[] = [];
    for (const b of blocks) {
      let cur: number | undefined;
      for (const e of b.ctx.log) {
        if (e.op === "filter") { const m = /^brightness\(([0-9.]+)\)$/.exec(String(e.value ?? "")); cur = m ? Number(m[1]) : undefined; }
        if (e.op === "drawImage") { const img = e.img as { url?: string }; if (typeof img?.url === "string") out.push({ br: cur, url: img.url }); }
      }
    }
    return out;
  };

  it("chooseRenderer picks Canvas2D when WebGL2 cannot be created (Xbox Edge after a GPU reset)", () => {
    const probe = (k: "webgl2" | "2d"): unknown => (k === "webgl2" ? null : {});
    expect(chooseRenderer(probe)).toBe("canvas2d");
  });
  it("deep + shallow water draw their gt tile art into the baked ground blocks", async () => {
    const { blocks } = await renderLake();
    expect(blocks.length).toBeGreaterThan(0);
    const draws = blockDraws(blocks);
    expect(draws.some((d) => d.url.includes("atl:gt_water.png"))).toBe(true);
    expect(draws.some((d) => d.url.includes("atl:gt_water_shallow.png"))).toBe(true);
    expect(draws.some((d) => d.url.includes("atl:gt_grass"))).toBe(true); // land unchanged
  });
  it("water brightness follows the deep->shallow ramp (0.80 deep, 1.06 shore), as the WebGL2 shader", async () => {
    const { blocks } = await renderLake();
    const water = blockDraws(blocks).filter((d) => d.url.includes("atl:gt_water.png"));
    expect(water.length).toBeGreaterThan(0);
    const brs = water.map((d) => d.br).filter((b): b is number => b !== undefined);
    expect(brs.length).toBe(water.length);
    expect(Math.min(...brs)).toBeLessThan(0.9); // deep lake centre
    expect(Math.max(...brs)).toBeGreaterThan(1.0); // shoreline
    expect(brs.every((b) => b >= 0.79 && b <= 1.07)).toBe(true);
  });
  it("the flat gradient under-layer still runs, and the baked blocks reach the screen", async () => {
    const { main, blocks, waterCanvas } = await renderLake();
    expect(waterCanvas).toBeDefined(); // drawWater's 45x45 gradient canvas
    expect(waterCanvas!.ctx.log.some((e) => e.op === "putImageData")).toBe(true);
    expect(main.log.some((e) => e.op === "drawImage" && (e.img as StubCanvas)?.width === 45)).toBe(true);
    expect(blocks.length).toBeGreaterThan(0);
    expect(main.log.some((e) => e.op === "drawImage" && (e.img as StubCanvas)?.width === 516)).toBe(true); // block presented
  });
});
