import { describe, expect, it } from "vitest";
import { World, Transform, PrevTransform, Appearance, setAppearance, slotIndex, type CosmeticCatalogLike, type WearableDef, type AppearanceValue } from "@engine/core";
import { loadManifest, mergeManifests } from "@engine/assets";
import { PACK_DIR, readManifestJson } from "@engine/assets/node";
import { worldToScreen, DEFAULT_ISO } from "@engine/world";
import { SpriteBatch, INSTANCE_FLOATS, GLASS_QUAD, GLASS_DEPTH_MARGIN, type PrepareContext } from "../src/sprites.js";
import { coreAppearanceBinding, Canvas2DRenderer, RIDER_GLASS_TINT } from "../src/index.js";
import { Sprite, RENDER_COMPONENTS } from "../src/components.js";
import { newResolved as newAtlasResolved, type AtlasManager, type ResolvedFrame } from "../src/assets/atlasManager.js";
import { DEFAULT_STYLE } from "../src/style.js";
import { SUMMER_VISUAL } from "../src/season.js";
import { DeckNeighbors } from "../src/building/deckFaces.js";
import { PieceCoverIndex } from "../src/building/modular.js";

/**
 * ADR-528: the ADR-527 window-sized glass quad can tint over a pedestrian standing in front of a vehicle
 * window. The old key (maxKey + maxBelt * zPerPx + HELD_BIAS) double-counts the beltline drop the vertex
 * shader already adds per row, so the quad sits ~0.76 above the riders in this harness (real game ~0.2-0.65)
 * and wins the depth test against anything within ~half a tile in front of the window plane. The quad must
 * tint the riders behind the glass but not anything in front of the window: its per-vertex margin over the
 * deepest rider must be just GLASS_DEPTH_MARGIN (0.06 = HELD_BIAS + 10 x LAYER_BIAS), so a pedestrian more
 * than ~0.045 tiles in front of the rider's plane — a position inside the vehicle body — wins the depth test.
 * The per-vertex key of an instance at screen row y is pivot key + clamped height term x zFactor/zStep
 * (zFactor 1/3, zStep 16, so zPerPx = 1/48); the difference between two instances is row-independent while
 * both are above their pivots, which is the overlap the window rows cover.
 */
const VM = readManifestJson(PACK_DIR + "vehicles/manifest.vehicles.json") as any;
const reg = loadManifest(mergeManifests([{ name: "pack", manifest: readManifestJson(PACK_DIR + "manifest.json") }, { name: "vehicles", manifest: VM }] as never).manifest).registry;
/** Minimal cosmetic catalog (the ADR-527 shape): a body layer only, no wearables. */
const cat528: CosmeticCatalogLike = {
  wearable: () => undefined, bodySprite: () => ({ sprite: 1, anim: "idle" }),
  skinTones: [{ index: 0, key: "s", color: 0xffccaa }], hairColors: [{ index: 0, key: "h", color: 0x332211 }], clothingColors: [{ index: 0, key: "c", color: 0x2244aa }],
};
const app528 = (ids: Partial<Record<WearableDef["slot"], number>>): AppearanceValue => {
  const p = new Array(8).fill(0); for (const [s, id] of Object.entries(ids)) p[slotIndex(s as WearableDef["slot"])] = id;
  return { bodyType: 0, skinTone: 0, parts: p, primary: new Array(8).fill(0), secondary: new Array(8).fill(0) };
};
function stubAtlas528(): AtlasManager {
  const fixed = (out: ResolvedFrame): boolean => {
    out.sprite = 0; out.anim = "idle"; out.frame = 0; out.dfi = -1; out.w = 32; out.h = 48; out.ax = 16; out.ay = 48;
    out.atlas = 0; out.entry = 0; out.hasDamageFrames = false; out.flipX = false; return true;
  };
  return {
    registry: reg, layoutVersion: 1,
    beginFrame: () => {}, isRoof: () => false, isCrisp: () => false, isDirectional: () => true,
    isStreamSprite: () => false, isStreamed: () => false, streamNear: () => {}, markUsed: () => {}, markUsedAt: () => {},
    streamPageReady: () => true, pageReady: () => true, pageReadyAt: () => true, placeholderOf: () => -1,
    streamClass: () => null, buildingFallback: () => -1, swayOf: () => undefined, handOf: () => undefined,
    retainSprite: () => {}, releaseSprite: () => {},
    fireAnim: () => -1, animName: () => undefined, chainAnim: () => -1, sharedChainAnim: () => -1,
    sharedStateAnim: () => -1, findAnim: () => -1, animIndex: () => -1, headOffsetOf: () => ({ x: 0, y: 0 }),
    isHeadSprite: () => false, pieceInfo: () => ({ fw: 1, fh: 1, layer: 1 }), lArmOf: () => -1,
    crackOverlayOf: () => -1, isEnclosure: () => false, namedAnim: () => -1,
    resolve: (_id: number, _a: number, _f: number, _t: number, _fr: number, out: ResolvedFrame) => fixed(out),
    resolvePiece: (_v: number, _va: number, _r: number, _d: number, out: ResolvedFrame, _s: number) => fixed(out),
  } as unknown as AtlasManager;
}
const glStub528 = {
  createBuffer: () => ({}), createVertexArray: () => ({}), bindVertexArray: () => {}, bindBuffer: () => {},
  enableVertexAttribArray: () => {}, vertexAttribPointer: () => {}, vertexAttribDivisor: () => {},
  deleteBuffer: () => {}, deleteVertexArray: () => {}, bufferData: () => {},
} as unknown as WebGL2RenderingContext;
function makeBatch528(): SpriteBatch {
  const b = Object.assign(Object.create(SpriteBatch.prototype) as object, {
    gl: glStub528, iso: { ...DEFAULT_ISO }, zFactor: 1 / 3,
    capacity: 0, inst: new Float32Array(0), tmp: new Float32Array(0), sortKeys: new Uint32Array(0),
    gpuBytes: 0, n: 0, depthMin: 0, depthRange: 1, res: newAtlasResolved(), crackRes: newAtlasResolved(),
    cover: new PieceCoverIndex(), coverNext: new PieceCoverIndex(),
    tierFallbacks: 0, crackOverlays: 0, statics: new Map(), staticScratch: new Map(),
    dynamicChunkKeys: new Set(), pieceTmp: [] as number[],
    pieceParts: [] as { vis: number; rot: number; layer: number; x: number; y: number; last: boolean }[],
    cutCache: null, piecePartScratch: { vis: 0, rot: 0, layer: 0, x: 0, y: 0, last: true },
    pieceCache: new Map(), pieceSig: new Float64Array(32), chunkAgg: new Map(), chunkSlots: new Map(),
    pieceInfoCache: new Map(), pieceInfoLayout: -1,
    ckCache: new Map(), lateOrder: new Uint32Array(0), lateBuf: new Float32Array(0),
    sortIncremental: 0, sortFull: 0, culledChunks: 0, streamPlaceholders: 0, streamBodyFallbacks: 0,
    lastGoodLayout: -1, lastGood: new Map(), lastGoodHits: 0, partialLayers: 0, layerPlan: [],
    prevPerm: new Uint16Array(0), prevN: 0, seedBuf: new Uint32Array(0), seedUsed: new Uint8Array(0),
    frameNo: 0, xf: new Float32Array(4), chunkFadeIn: 0.35, visible: 0,
    staticInstances: 0, staticChunksDrawn: 0, staticRebuilds: 0, streamFallbacks: 0,
    focusEntity: -1, season: SUMMER_VISUAL, seasonSnowCap: 0, seasonArt: null, seasonArtReg: null,
    occT: new Float32Array(1024), occLast: -1, silInst: new Float32Array(INSTANCE_FLOATS), silOn: false,
    focusScr: [0, 0] as [number, number],
    occ: { occAmount: () => 0, peek: () => 0, overlapsFocus: () => false, occOn: false, fk: 0 },
    layerCache: null,
    characterOpts: { outline: "union", minorLayerMinZoom: 0.75, outlineWidthPx: 0, outlineColor: [0, 0, 0, 0], faceMipBias: -0.75, faceContrast: 1.12, faceUnlit: 0.3 },
    characters: 0, layerInstances: 0,
    nearInfo: Array.from({ length: 8 }, () => ({ e: -1, d: 0, layers: 0, resident: 0, drawn: 0, scale: 1, missing: [] as string[] })),
    nearN: 0, maxDressed: Infinity, dressFaces: true, dressCapped: 0,
    dressD2: new Float32Array(64), dressN: 0, dressCut: Infinity, dressDrawn: 0,
    layerRes: newAtlasResolved(), cutawayActive: false, nightGate: 1,
    route: new Uint8Array(0), curRoute: 0, intBuf: new Float32Array(0), intCount: 0,
    intVbo: null, intVao: null, intKeys: [] as number[], intRoutes: [] as number[], intIdx: [] as number[],
    late: [] as number[], lateVbo: null, lateVao: null, lateCount: 0,
    windVec: new Float32Array([1, 0]), shadowColor: new Float32Array(3),
    one: new Float32Array(INSTANCE_FLOATS), layerBase: new Float32Array(INSTANCE_FLOATS),
    heldRes: newAtlasResolved(), heldStats: [0, 0, 0] as [number, number, number],
    offHandStats: [0, 0, 0, 0] as [number, number, number, number],
    decks: new DeckNeighbors(), deckTops: new Map(), interiorRegions: [], interiorFloorIds: new Set<number>(),
    interiorWallSprite: -1, interiorCut: false,
  }) as unknown as SpriteBatch;
  return b;
}

describe("ADR-528 the glass quad must not tint over a pedestrian in front of the window", () => {
  // the sorted instance buffer is private on SpriteBatch; the test reads it through a cast
  const instOf = (b: SpriteBatch): Float32Array => (b as unknown as { inst: Float32Array }).inst;
  /** per-vertex depth key of an instance at screen row y: pivot key + clamped height term x zPerPx (1/48). */
  const Z_PER_PX = 1 / 48;
  const vertexKey = (o: Float32Array, y: number): number => o[2]! + Math.max((o[1]! - y) + o[15]!, 0) * Z_PER_PX;
  const mkChar = (world: World, x: number, y: number): number => {
    const e = world.create();
    world.add(e, Transform, { x, y, z: 0, facing: 0 });
    world.add(e, PrevTransform, { x, y, z: 0, facing: 0 });
    world.add(e, Sprite, { spriteId: 1, frameId: 0, flags: 0, scale: 1, tint: 0 });
    setAppearance(world, e, app528({}));
    return e;
  };

  it("a pedestrian 0.1 or 0.3 tiles in front of the window beats the quad at every overlapping row; the rider stays tinted", () => {
    const world = new World({ seed: 1 });
    for (const c of RENDER_COMPONENTS) world.register(c);
    world.register(Transform); world.register(PrevTransform); world.register(Appearance);
    const rider = mkChar(world, 10, 10);
    const pedNear = mkChar(world, 10, 10.1); // 0.1 tiles in front of the rider's plane: tinted by the old key
    const pedMid = mkChar(world, 10, 10.3); // 0.3 tiles: still inside the old key's ~0.57-tile reach
    const pedFar = mkChar(world, 10, 11); // 1 tile: already untinted by the old key (control)
    // the rider's window: beltline 17 px below the pivot, roof 20 px above; the window spans 150 px left
    // to 35 px right of the pivot, with a flat roofline at the band top. Screen pivot is (0, 320).
    const clip = { bottom: -17, top: 20, glass: { lo: -150, hi: 35, vehicle: 1, roof: { x0: -150, y0: 20, x1: 35, y1: 20 } } };
    const batch = makeBatch528();
    batch.prepare({
      world, alpha: 0.5, rect: { x0: -700, y0: -100, x1: 700, y1: 700 }, atlas: stubAtlas528(), depthMin: -100, depthRange: 500,
      tickHz: 20, style: DEFAULT_STYLE,
      bindings: { appearance: coreAppearanceBinding(cat528), riderWindow: (en: number) => (en === rider ? clip : undefined) },
      now: 100, zoom: 1,
    } as PrepareContext);
    const insts: Float32Array[] = [];
    for (let j = 0; j < batch.visible; j++) insts.push(instOf(batch).subarray(j * INSTANCE_FLOATS, (j + 1) * INSTANCE_FLOATS));
    const quads = insts.filter((o) => (o[5]! & GLASS_QUAD) !== 0);
    expect(quads).toHaveLength(1);
    const q = quads[0]!;
    expect(q[1]).toBeCloseTo(337, 4); // the pivot sits on the window's bottom edge (sy - bottom = 320 + 17)
    // the quad's pivot key: the deepest rider's undropped pivot key (20) less the drop from that pivot to the
    // window's bottom edge (17 px x 1/48), plus GLASS_DEPTH_MARGIN — the old formula (maxKey + maxBelt x
    // zPerPx + HELD_BIAS = 19.904) double-counts the beltline drop the vertex shader already adds per row.
    expect(q[2]).toBeCloseTo(20 - 17 / 48 + GLASS_DEPTH_MARGIN, 4);
    const atPivot = (x: number, y: number): Float32Array[] => insts.filter((o) => (o[5]! & GLASS_QUAD) === 0 && Math.abs(o[0]! - x) < 0.5 && Math.abs(o[1]! - y) < 0.5);
    const pivotOf = (x: number, y: number): { sx: number; sy: number } => worldToScreen(x, y, 0, { tileW: 64, tileH: 32, zStep: 16 });
    // window rows 300..337; every character's frame covers rows 300..320, so sample those (the margin is
    // row-independent while both instances are above their pivots, so a few rows pin it).
    const rows = [300, 305, 310, 315, 320];
    // the rider stays tinted: the quad beats even the rider's foremost paper-doll layer (+0.01) by 0.05
    const rp = pivotOf(10, 10);
    const riderInsts = atPivot(rp.sx, rp.sy);
    expect(riderInsts.length).toBeGreaterThanOrEqual(1);
    const foremostRider = riderInsts.reduce((m, o) => (o[2]! > m[2]! ? o : m), riderInsts[0]!);
    for (const y of rows) expect(vertexKey(q, y) - vertexKey(foremostRider, y)).toBeGreaterThan(0.04);
    // no pedestrian is tinted: even the weakest (body) instance of each pedestrian beats the quad at every
    // overlapping row — the old key lost to the 0.1-tile pedestrian by 0.625 and to the 0.3-tile one by 0.358
    for (const [px, py] of [[10, 10.1], [10, 10.3], [10, 11]] as const) {
      const pp = pivotOf(px, py);
      const pedInsts = atPivot(pp.sx, pp.sy);
      expect(pedInsts.length).toBeGreaterThanOrEqual(1);
      const weakestPed = pedInsts.reduce((m, o) => (o[2]! < m[2]! ? o : m), pedInsts[0]!);
      for (const y of rows) expect(vertexKey(weakestPed, y) - vertexKey(q, y)).toBeGreaterThan(0);
    }
    expect(pedNear).toBeGreaterThan(0); expect(pedMid).toBeGreaterThan(0); expect(pedFar).toBeGreaterThan(0);
  });
});

/** --- Canvas2D twin: the merged glass must draw in depth order, not after the whole loop --- */
/** Recording 2D context (the ADR-522 harness): every call is logged with the translate active at the time. */
type Ev528 = { op: string; args: unknown[]; tx: number; ty: number; style?: string };
class RecCtx528 {
  events: Ev528[] = [];
  fillStyle = ""; globalAlpha = 1; globalCompositeOperation = "source-over"; imageSmoothingEnabled = true; filter = "";
  private stack: { tx: number; ty: number }[] = [{ tx: 0, ty: 0 }];
  private get cur(): { tx: number; ty: number } { return this.stack[this.stack.length - 1]!; }
  private log(op: string, ...args: unknown[]): void { this.events.push({ op, args, tx: this.cur.tx, ty: this.cur.ty }); }
  save(): void { this.stack.push({ ...this.cur }); this.log("save"); }
  restore(): void { this.stack.pop(); this.log("restore"); }
  translate(x: number, y: number): void { this.cur.tx += x; this.cur.ty += y; this.log("translate", x, y); }
  setTransform(...a: unknown[]): void { this.log("setTransform", ...a); }
  beginPath(): void { this.log("beginPath"); }
  moveTo(x: number, y: number): void { this.log("moveTo", x, y); }
  lineTo(x: number, y: number): void { this.log("lineTo", x, y); }
  closePath(): void { this.log("closePath"); }
  rect(x: number, y: number, w: number, h: number): void { this.log("rect", x, y, w, h); }
  clip(): void { this.log("clip"); }
  fill(): void { this.events.push({ op: "fill", args: [], tx: this.cur.tx, ty: this.cur.ty, style: this.fillStyle }); }
  fillRect(x: number, y: number, w: number, h: number): void { this.events.push({ op: "fillRect", args: [x, y, w, h], tx: this.cur.tx, ty: this.cur.ty, style: this.fillStyle }); }
  drawImage(...a: unknown[]): void { this.log("drawImage", ...a); }
  rotate(...a: unknown[]): void { this.log("rotate", ...a); }
  scale(...a: unknown[]): void { this.log("scale", ...a); }
}
function makeRecCtx528(): { ctx: CanvasRenderingContext2D; events: Ev528[] } {
  const target = new RecCtx528();
  const universal = (..._a: unknown[]): unknown => proxy;
  const proxy = new Proxy(target, {
    get(t, p) { if (p in t) { const v = (t as unknown as Record<string | symbol, unknown>)[p]; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v; } return universal; },
    set(t, p, v) { (t as unknown as Record<string | symbol, unknown>)[p] = v; return true; },
  });
  return { ctx: proxy as unknown as CanvasRenderingContext2D, events: target.events };
}
interface SceneDrive528 { x: number; y: number; z: number; clip?: { bottom: number; top: number; glass?: { lo: number; hi: number; vehicle: number; roof?: { x0: number; y0: number; x1: number; y1: number } } } }
/** Drive Canvas2DRenderer.render() with the given plain sprites (sprite path, no paper doll) and record every ctx call. */
function driveScene528(entries: SceneDrive528[]): { events: Ev528[] } {
  const canvas = { width: 320, height: 240, getContext: () => ({}) } as unknown as HTMLCanvasElement;
  const { ctx, events } = makeRecCtx528();
  const r = new Canvas2DRenderer(canvas, ctx);
  r.resize(640, 480, 1);
  void r.atlas.setRegistry(reg, new Map());
  (r as unknown as { image: unknown }).image = () => ({});
  const w = new World({ seed: 1 });
  w.register(Transform); w.register(PrevTransform); w.register(Sprite); w.register(Appearance);
  const byEntity = new Map<number, SceneDrive528["clip"]>();
  entries.forEach((rd) => {
    const e = w.create();
    w.add(e, Transform, { x: rd.x, y: rd.y, z: rd.z, facing: 0 });
    w.add(e, PrevTransform, { x: rd.x, y: rd.y, z: rd.z, facing: 0 });
    w.add(e, Sprite, { spriteId: reg.id("player"), frameId: 0, flags: 0, scale: 1, tint: 0 });
    byEntity.set(e, rd.clip);
  });
  r.bindGameplay({ riderWindow: (e: number) => byEntity.get(e) } as never);
  const rc = r as unknown as { clock: number; clockAt: number };
  rc.clock = 0; rc.clockAt = -1; // pin the render clock (ADR-414's trick)
  r.render(w, 1);
  return { events };
}

describe("ADR-528 Canvas2D: the merged glass draws in depth order, not after the whole loop", () => {
  it("the glass fillRect comes after the rider's drawImage and before the pedestrian's", () => {
    const clip = { bottom: -17, top: 20, glass: { lo: -150, hi: 35, vehicle: 1, roof: { x0: -150, y0: 20, x1: 35, y1: 20 } } };
    const { events } = driveScene528([
      { x: 10, y: 10, z: 0, clip }, // the rider, in the window
      { x: 10, y: 10.3, z: 0 }, // a pedestrian 0.3 tiles in front of the window: drawn after the rider, must not be tinted
    ]);
    const draws = events.map((e, i) => (e.op === "drawImage" ? i : -1)).filter((i) => i >= 0);
    expect(draws).toHaveLength(2); // exactly the rider and the pedestrian, in depth order
    const glass = events.findIndex((e) => e.op === "fillRect" && e.style === RIDER_GLASS_TINT);
    expect(glass).toBeGreaterThan(-1); // the merged glass is drawn
    expect(glass).toBeGreaterThan(draws[0]!); // after the rider it tints
    expect(glass).toBeLessThan(draws[1]!); // before the pedestrian in front of the window (the old post-loop flush drew it after both)
  });
});
