import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PrevTransform, Transform, World } from "@engine/core";
import { loadManifest, type AssetRegistry } from "@engine/assets";
import { PACK_DIR } from "@engine/assets/node";
import { DEFAULT_ISO } from "@engine/world";
import {
  AtlasManager, ENTRY_MISS_TRIGGER, ENTRY_WANT_TRIGGER, ENTRY_WINDOW_FRAMES,
  STREAM_UPLOADS_PER_FRAME, STREAM_UPLOADS_PER_FRAME_BOOST,
} from "../src/assets/atlasManager.js";
import { PageLRU } from "../src/gl/vram.js";
import { newResolved as newAtlasResolved, type ResolvedFrame } from "../src/assets/atlasManager.js";
import { SpriteBatch, type PrepareContext } from "../src/sprites.js";
import { PieceCoverIndex } from "../src/building/modular.js";
import { DeckNeighbors } from "../src/building/deckFaces.js";
import { RENDER_COMPONENTS, Sprite } from "../src/components.js";
import { DEFAULT_STYLE } from "../src/style.js";
import { SUMMER_VISUAL } from "../src/season.js";
import { isoZDepthFactor } from "../src/depth.js";
import { INSTANCE_FLOATS } from "../src/sprites.js";

/**
 * ADR-575: dense-area ENTRY page-in. Measured context (measure-perf.md §3): during normal play stream
 * sheets page in at 2/frame; ADR-545's boost to 6/frame fires only under the loading overlay or when
 * frames are already <= 8 ms — never while walking into a new area. The boost compresses a real but
 * small placeholder trickle (K=6 sheets: base 2 frames / 6 miss page-frames -> boost 1 frame / 0 after
 * frame 1; K=12: base 5 frames / 30 -> boost 1 frame / 6). Above 12 simultaneously-wanted stream pages
 * the pool is capacity-bound — no rate change helps, and none is attempted here. The dominant entry
 * cost (chunk-build burst, ~7 ms/chunk) is out of scope (ADR-546 territory, deferred with ADR-576).
 *
 * This slice: (1) an entry window — opened by a stream-miss spike (>= ENTRY_MISS_TRIGGER drawn misses
 * in one frame), a burst of >= ENTRY_WANT_TRIGGER new stream wants in one frame (above any single
 * on-screen family's 6 sheets, so ADR-545's base-rate contract for small bursts is unchanged), or
 * noteAreaEntry() (SpriteBatch calls it when the visible chunk set changes materially) — during which
 * page-ins run at the existing ADR-545 boost rate; the window closes when the stream queue drains or
 * after ENTRY_WINDOW_FRAMES. (2) A resource prefetch ring mirroring the character ring
 * (PREFETCH_RING_PX = 768, every 8 frames): static (non-character, non-animated) stream sprites in the
 * ring band outside the load margin request their page ahead of entry at padded priority.
 * No budget/pool/keep constants change: STREAM_BUDGET_SHARE, pool slots, STREAM_KEEP_FACTOR,
 * STREAM_UNLOAD_FRAMES and the ADR-559 loading decode cap are untouched.
 */

const json = (p: string) => JSON.parse(readFileSync(PACK_DIR + p, "utf8"));
const img = (k: string) => ({ key: k, image: `atlases/${k}.png`, frameW: 32, frameH: 32, columns: 4, rows: 4 });
const spr = (key: string, atlas: string, extra: object = {}) => ({ key, category: "resource", atlas, animations: { idle: { frames: [0], fps: 1 } }, ...extra });
function pack(n = 6): { m: any; reg: AssetRegistry } {
  const m = json("manifest.json");
  m.atlases.push(img("nature_placeholder")); m.sprites.push(spr("ph_sprout", "nature_placeholder"));
  for (let i = 0; i < n; i++) { m.atlases.push({ ...img(`crop_t${i}`), residency: "stream", placeholder: "ph_sprout" }); m.sprites.push(spr(`crop_t${i}_a`, `crop_t${i}`)); }
  return { m, reg: loadManifest(m).registry };
}
const id = (reg: AssetRegistry, k: string) => reg.ids.sprites.id(k);
/** GL-free manager (adr545 double): page-in lands on the next microtask; evictions counted at the LRU. */
function mgr(reg: AssetRegistry, slots = 12): any {
  const am = Object.create(AtlasManager.prototype) as any; let base = 0;
  const lru = new PageLRU<string>(slots, 90);
  am.evictions = 0;
  const alloc = lru.allocate.bind(lru);
  lru.allocate = (k: string, f: number, p?: number) => { const r = alloc(k, f, p); if (r?.evicted !== undefined) am.evictions++; return r; };
  am.registry = reg; am.frame = 1; am.gen = 0; am.inflight = 0; am.queue = []; am.wearablesOn = true; am.placeholderCache = new Map(); am.streamStarts = 0;
  am.vram = { misses: 0, pending: 0, pageIn() {}, evict() {} }; am.table = new Float32Array(0); am.tintRowMap = new Map(); am.writeFrames = () => {};
  am.pools = [{ cls: "stream", lru, slotBytes: 1, k: 1 }];
  am.atlases = [...reg.atlases.values()].sort((a, b) => a.id - b.id).map((a) => { const r = { key: a.key, id: a.id, source: { url: a.key }, base, count: 16, fw: 32, fh: 32, cols: 4, ...(a.residency === "stream" ? { lazy: { w1: 128, h1: 128, state: 0, pool: 0 } } : {}) }; base += 16; return r; });
  am.sprites = []; for (const s of reg.allSprites()) am.sprites[s.id] = { atlasIdx: am.atlases.findIndex((x: any) => x.id === s.atlas.id), anchorX: 0.5, anchorY: 0.9, anims: s.animList, dirAt: s.animList.map(() => null), stateAnim: new Int16Array(16), damage: [] };
  am.started = [] as string[];
  // Starts are recorded synchronously (pump calls pageIn in-frame); the page LANDS on a microtask,
  // so a draw in the same frame still misses it — the measurement harness's protocol.
  am.pageIn = async (a: any) => { am.started.push(a.key); await Promise.resolve(); lru.allocate(a.key, am.frame, a.lazy.prio); a.lazy.state = 2; };
  return am;
}
const flush = () => new Promise((r) => setTimeout(r, 0));
/** One frame of draws against K stream sprites: returns the miss page-frames (draws that found no page). */
function drawFrame(am: any, reg: AssetRegistry, crops: number[]): number {
  let miss = 0;
  for (const c of crops) if (!am.streamPageReady(am.sprites[c].atlasIdx, 4)) miss++;
  return miss;
}

describe("ADR-575: entry window — page-ins run at the boost rate on area entry", () => {
  it("constants: window 180 frames (the measured 3 s entry window), miss trigger 3, want trigger 7", () => {
    expect(ENTRY_WINDOW_FRAMES).toBe(180);
    expect(ENTRY_MISS_TRIGGER).toBe(3); // a handful of drawn stream misses in one frame = new-area sheets
    expect(ENTRY_WANT_TRIGGER).toBe(7); // above the largest single family burst (6 season sheets: ADR-545's base-rate test)
    expect(STREAM_UPLOADS_PER_FRAME_BOOST).toBe(6);
    expect(STREAM_UPLOADS_PER_FRAME).toBe(2);
  });

  it("(a) K=6 teleport-in: all 6 sheets start in frame 1 and 0 miss page-frames follow", async () => {
    const { reg } = pack(6); const am = mgr(reg);
    const crops = [0, 1, 2, 3, 4, 5].map((i) => id(reg, `crop_t${i}_a`));
    const miss1 = drawFrame(am, reg, crops); // frame 1: every draw misses (nothing resident yet)
    await flush();
    expect(miss1).toBe(6);
    expect(am.started.length).toBe(6); // pre-fix: 2 (base rate; the ADR-545 boost never engages on entry)
    expect(am.streamUploadsPerFrame()).toBe(STREAM_UPLOADS_PER_FRAME_BOOST); // window is open
    am.beginFrame(); await flush();
    expect(drawFrame(am, reg, crops)).toBe(0); // 0 miss page-frames after frame 1 (boost column of the measurement)
  });

  it("(a) K=12 teleport-in: 6 start in frame 1, the rest in frame 2 — 6 miss page-frames after frame 1", async () => {
    const { reg } = pack(12); const am = mgr(reg, 12);
    const crops = Array.from({ length: 12 }, (_, i) => id(reg, `crop_t${i}_a`));
    drawFrame(am, reg, crops); await flush();
    expect(am.started.length).toBe(6); // the per-frame boost cap binds, not the base 2 (pre-fix: 2)
    am.beginFrame(); // pump starts the remaining 6; the frame's draws run before those page-ins land
    const miss2 = drawFrame(am, reg, crops);
    expect(miss2).toBe(6); // the 6 sheets that could not start in frame 1 (boost column; base rate: 30 total)
    await flush();
    expect(am.started.length).toBe(12); // fully drained in 2 frames (base rate: 6 frames)
    am.beginFrame();
    expect(drawFrame(am, reg, crops)).toBe(0);
  });

  it("(b) after the window drains it closes: steady-state rate is the base 2/frame again", async () => {
    const { reg } = pack(12); const am = mgr(reg, 12);
    const crops = [0, 1, 2, 3, 4, 5].map((i) => id(reg, `crop_t${i}_a`));
    drawFrame(am, reg, crops); await flush();
    expect(am.streamUploadsPerFrame()).toBe(6);
    am.beginFrame(); await flush(); // queue empty, nothing loading: the window closes on drain
    expect(am.streamUploadsPerFrame()).toBe(STREAM_UPLOADS_PER_FRAME);
    // Steady state: a slow trickle of new wants (<= 2/frame, no burst, no misses) never reopens it.
    const more = [6, 7, 8, 9].map((i) => id(reg, `crop_t${i}_a`));
    am.streamNear(more[0]!, true, 4); am.streamNear(more[1]!, true, 4); await flush();
    expect(am.started.length).toBe(8);
    expect(am.streamUploadsPerFrame()).toBe(2);
    am.beginFrame(); await flush();
    am.streamNear(more[2]!, true, 4); am.streamNear(more[3]!, true, 4); await flush();
    expect(am.started.length).toBe(10);
    expect(am.streamUploadsPerFrame()).toBe(2);
  });

  it("(b) the window is hard-capped: a page stuck loading cannot hold the boost past ENTRY_WINDOW_FRAMES", async () => {
    const { reg } = pack(2); const am = mgr(reg);
    const stuck = am.atlases[am.sprites[id(reg, "crop_t0_a")].atlasIdx];
    stuck.lazy.state = 1; // a stream page-in that never lands: the drain-close must not fire
    am.noteAreaEntry(); // the chunk-set trigger (SpriteBatch calls this on material chunk-set change)
    expect(am.streamUploadsPerFrame()).toBe(6);
    for (let f = 0; f < ENTRY_WINDOW_FRAMES; f++) am.beginFrame();
    expect(am.streamUploadsPerFrame()).toBe(6); // last frame of the window
    am.beginFrame();
    expect(am.streamUploadsPerFrame()).toBe(2); // capped: back to base despite the stuck page
  });

  it("(d) eviction churn at an area boundary: burst entry (window open) evicts no more than trickle entry", async () => {
    const run = async (burst: boolean): Promise<number> => {
      const { reg } = pack(12); const am = mgr(reg, 9); // 9 slots, two 6-sheet areas: crossings must evict
      const A = [0, 1, 2, 3, 4, 5].map((i) => id(reg, `crop_t${i}_a`));
      const B = [6, 7, 8, 9, 10, 11].map((i) => id(reg, `crop_t${i}_a`));
      const phase = async (inside: number[], frames: number) => {
        // A crossing: the chunk set changes materially, so the burst run opens the entry window
        // (noteAreaEntry, the SpriteBatch trigger); the trickle run presents the same pages with
        // no window. Inside the area, drawn pages re-request every frame until resident (as in
        // play) and stay touched; the area left behind is never touched again — its pages age
        // out of the LRU protect window (90 frames) and become eviction victims.
        if (burst && typeof am.noteAreaEntry === "function") am.noteAreaEntry(); // absent pre-fix: the guard then compares identical runs
        for (let f = 0; f < frames; f++) {
          for (const c of inside) am.streamNear(c, true, 4);
          am.beginFrame(); await flush();
        }
      };
      await phase(A, 120); await phase(B, 120); await phase(A, 120); await phase(B, 120);
      return am.evictions;
    };
    const trickle = await run(false);
    const burst = await run(true);
    expect(trickle).toBeGreaterThan(0); // the script really forces evictions (12 wanted pages, 9 slots)
    expect(burst).toBeLessThanOrEqual(trickle); // the window changes WHEN pages start, never the LRU policy
  });
});

// ---- (c) resource prefetch ring through the real SpriteBatch.prepare -------------------------------

const RECT = { x0: -700, y0: -100, x1: 700, y1: 700 };
function ringWorld(resId: number, plainId: number): { world: World; player: number } {
  const world = new World({ seed: 1 });
  for (const c of RENDER_COMPONENTS) world.register(c);
  world.register(Transform); world.register(PrevTransform);
  const add = (x: number, y: number, sid: number): number => {
    const e = world.create();
    world.add(e, Transform, { x, y, z: 0, facing: 0 });
    world.add(e, PrevTransform, { x, y, z: 0, facing: 0 });
    world.add(e, Sprite, { spriteId: sid, frameId: 0, flags: 0, scale: 1, tint: 0 });
    return e;
  };
  const player = add(0, 0, plainId);
  // sx = (x - y) * 32, sy = (x + y) * 16 (DEFAULT_ISO). Ring band: outside the keep margin
  // (rect.x0 - 512 = -1212) but inside the ring (draw margin -256 - 768 => rect.x0 - 1024 = -1724).
  add(-23.4375, 23.4375, resId); // sx = -1500: in the ring band
  add(-29.6875, 29.6875, resId); // sx = -1900: beyond the ring
  return { world, player };
}
function ringBatch(): SpriteBatch {
  return Object.assign(Object.create(SpriteBatch.prototype) as object, {
    gl: { createBuffer: () => ({}), createVertexArray: () => ({}), bindVertexArray: () => {}, bindBuffer: () => {}, enableVertexAttribArray: () => {}, vertexAttribPointer: () => {}, vertexAttribDivisor: () => {}, deleteBuffer: () => {}, deleteVertexArray: () => {}, bufferData: () => {} },
    iso: { ...DEFAULT_ISO }, zFactor: isoZDepthFactor(DEFAULT_ISO),
    capacity: 0, inst: new Float32Array(0), tmp: new Float32Array(0), sortKeys: new Uint32Array(0),
    gpuBytes: 0, n: 0, depthMin: 0, depthRange: 1, res: newAtlasResolved(), crackRes: newAtlasResolved(),
    cover: new PieceCoverIndex(), coverNext: new PieceCoverIndex(),
    tierFallbacks: 0, crackOverlays: 0, statics: new Map(), staticScratch: new Map(),
    dynamicChunkKeys: new Set(), pieceChecks: new Map(), pieceTmp: [] as number[],
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
    intVbo: null, intVao: null, intKeys: [] as number[], intIdx: [] as number[], intRoutes: [] as number[],
    late: [] as number[], lateVbo: null, lateVao: null, lateCount: 0,
    windVec: new Float32Array([1, 0]), shadowColor: new Float32Array(3),
    one: new Float32Array(INSTANCE_FLOATS), layerBase: new Float32Array(INSTANCE_FLOATS),
    heldRes: newAtlasResolved(), heldStats: [0, 0, 0] as [number, number, number],
    offHandStats: [0, 0, 0, 0] as [number, number, number, number],
    decks: new DeckNeighbors(), deckTops: new Map(), interiorRegions: [], interiorFloorIds: new Set<number>(),
    interiorWallSprite: -1, interiorCut: false, prefetches: 0,
  }) as unknown as SpriteBatch;
}

describe("ADR-575: resource prefetch ring (mirrors the character ring)", () => {
  it("(c) a static stream sprite in the ring band requests its page ahead of entry, at padded priority; beyond the ring it does not", () => {
    const { reg } = pack(1);
    const resId = id(reg, "crop_t0_a"), plainId = id(reg, "ph_sprout");
    const calls: { sid: number; load: boolean; prio: number }[] = [];
    const fixed = (out: ResolvedFrame): boolean => { out.sprite = 0; out.anim = "idle"; out.frame = 0; out.dfi = -1; out.w = 32; out.h = 48; out.ax = 16; out.ay = 48; out.atlas = 0; out.entry = 0; out.hasDamageFrames = false; out.flipX = false; return true; };
    const atlas = {
      registry: reg, layoutVersion: 1,
      beginFrame: () => {}, isRoof: () => false, isCrisp: () => false, isDirectional: () => true,
      isStreamSprite: (sid: number) => sid === resId, isStreamed: () => false,
      streamNear: (sid: number, load: boolean, prio: number) => { calls.push({ sid, load, prio }); },
      pageInfo: (sid: number) => sid === resId ? { state: "missing" as const, scale: 1, streamed: true } : { state: "resident" as const, scale: 1, streamed: false },
      markUsed: () => {}, markUsedAt: () => {}, streamPageReady: () => true, pageReady: () => true, pageReadyAt: () => true,
      placeholderOf: () => -1, streamClass: () => null, buildingFallback: () => -1, swayOf: () => undefined, handOf: () => undefined,
      fireAnim: () => -1, animName: () => undefined, chainAnim: () => -1, sharedChainAnim: () => -1,
      sharedStateAnim: () => -1, findAnim: () => -1, animIndex: () => -1, headOffsetOf: () => ({ x: 0, y: 0 }),
      isHeadSprite: () => false, pieceInfo: () => ({ fw: 1, fh: 1, layer: 1 }), lArmOf: () => -1,
      crackOverlayOf: () => -1, isEnclosure: () => false, namedAnim: () => -1,
      resolve: (_i: number, _a: number, _f: number, _t: number, _fr: number, out: ResolvedFrame) => fixed(out),
      resolvePiece: (_v: number, _va: number, _r: number, _d: number, out: ResolvedFrame) => fixed(out),
    } as unknown as AtlasManager;
    const { world, player } = ringWorld(resId, plainId);
    const batch = ringBatch(); batch.focusEntity = player;
    const ctx: PrepareContext = { world, alpha: 0.5, rect: RECT, atlas, depthMin: -100, depthRange: 500, tickHz: 20, style: DEFAULT_STYLE, bindings: {}, now: 100, zoom: 1 };
    for (let f = 0; f < 16; f++) batch.prepare(ctx); // the ring is staggered: each entity every 8 frames
    const loads = calls.filter((c) => c.sid === resId && c.load);
    expect(loads.length).toBeGreaterThanOrEqual(1); // pre-fix: 0 — outside the keep margin nothing was requested
    // Padded priority: unpadded sprio for the ring sprite = 2 * 23.4375^2 = 1098.63; the ring adds the pad (64).
    expect(loads[0]!.prio).toBeGreaterThan(1098.63 + 60);
    expect(loads[0]!.prio).toBeLessThan(1098.63 + 68);
    // The beyond-ring sprite (sx -1900) must never request: both sprites share resId, so bound the total —
    // the in-ring entity fires at most twice in 16 frames (its stagger beat every 8 frames); if the
    // beyond-ring entity also fired, the count would reach 3-4.
    expect(loads.length).toBeLessThanOrEqual(2);
  });
});
