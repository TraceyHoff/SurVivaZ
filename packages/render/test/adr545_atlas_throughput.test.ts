import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadManifest, type AssetRegistry } from "@engine/assets";
import { PACK_DIR } from "@engine/assets/node";
import {
  AtlasManager, PAGE_IN_FRAME_BUDGET_MS, PAGE_UPLOADS_PER_FRAME, PAGE_UPLOADS_PER_FRAME_BOOST,
  STREAM_BUDGET_SHARE, STREAM_FLOOR_SLOTS, STREAM_KEEP_FACTOR, STREAM_POOL_SLOTS_DESKTOP,
  STREAM_POOL_SLOTS_LOWMEM, STREAM_UNLOAD_FRAMES, STREAM_UPLOADS_PER_FRAME,
  STREAM_UPLOADS_PER_FRAME_BOOST,
} from "../src/assets/atlasManager.js";
import { WARMUP_WINDOW_MS, type WarmupResult } from "../src/assets/warmup.js";
import { PageLRU } from "../src/gl/vram.js";

/**
 * ADR-545: atlas throughput + eviction, gated on the user's own phone numbers (Mali-G68, NOT the ADR-381
 * Galaxy A16 profile): vram total 460 MB vs a 256 MB budget (withinBudget=FALSE), 41 misses, 0 evictions,
 * pending 0 — the pop-in here is slow page-in + warm-up timeouts, not eviction thrash. So the safe levers are
 * the page-in *rate* (adaptive: 2 while frames are busy, boosted during the loading overlay / when frame time
 * allows), a longer stream-page keep (unload 180 -> 600 frames, keep factor 1.5x -> 2x), and a longer boot
 * warm-up window (1500 -> 5000 ms). Pool slots and STREAM_BUDGET_SHARE are deliberately NOT raised: there is
 * no VRAM headroom on this device class, and over-budgeting at 128 MB budgets risks OOM/context loss (ADR-407).
 */

const json = (p: string) => JSON.parse(readFileSync(PACK_DIR + p, "utf8"));
const img = (k: string) => ({ key: k, image: `atlases/${k}.png`, frameW: 32, frameH: 32, columns: 4, rows: 4 });
const spr = (key: string, atlas: string, extra: object = {}) => ({ key, category: "resource", atlas, animations: { idle: { frames: [0], fps: 1 } }, ...extra });
/** Base pack + N stream sheets (crop sprite each). */
function pack(n = 6): { m: any; reg: AssetRegistry } {
  const m = json("manifest.json");
  m.atlases.push(img("nature_placeholder")); m.sprites.push(spr("ph_sprout", "nature_placeholder"));
  for (let i = 0; i < n; i++) { m.atlases.push({ ...img(`crop_t${i}`), residency: "stream", placeholder: "ph_sprout" }); m.sprites.push(spr(`crop_t${i}_a`, `crop_t${i}`)); }
  return { m, reg: loadManifest(m).registry };
}
const id = (reg: AssetRegistry, k: string) => reg.ids.sprites.id(k);
/** GL-free manager with the stream sheets in a stream pool of `slots` (page-in stubbed: lands on the next microtask). */
function mgr(reg: AssetRegistry, slots = 12): any {
  const am = Object.create(AtlasManager.prototype) as any; let base = 0;
  const lru = new PageLRU<string>(slots, 90);
  am.registry = reg; am.frame = 1; am.gen = 0; am.inflight = 0; am.queue = []; am.wearablesOn = true; am.placeholderCache = new Map(); am.streamStarts = 0;
  am.vram = { misses: 0, pending: 0, pageIn() {}, evict() { am.evicted = (am.evicted ?? 0) + 1; } }; am.table = new Float32Array(0); am.tintRowMap = new Map(); am.writeFrames = () => {};
  am.pools = [{ cls: "stream", lru, slotBytes: 1, k: 1 }];
  am.atlases = [...reg.atlases.values()].sort((a, b) => a.id - b.id).map((a) => { const r = { key: a.key, id: a.id, source: { url: a.key }, base, count: 16, fw: 32, fh: 32, cols: 4, ...(a.residency === "stream" ? { lazy: { w1: 128, h1: 128, state: 0, pool: 0 } } : {}) }; base += 16; return r; });
  am.sprites = []; for (const s of reg.allSprites()) am.sprites[s.id] = { atlasIdx: am.atlases.findIndex((x: any) => x.id === s.atlas.id), anchorX: 0.5, anchorY: 0.9, anims: s.animList, dirAt: s.animList.map(() => null), stateAnim: new Int16Array(16), damage: [] };
  am.started = [] as string[];
  am.pageIn = async (a: any) => { am.started.push(a.key); lru.allocate(a.key, am.frame, a.lazy.prio); a.lazy.state = 2; };
  return am;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ADR-545: adaptive page-in rate (base 2, boosted 6)", () => {
  it("no signal, no overlay: the base rates apply — 2 stream starts per frame, 2 uploads per frame", async () => {
    const { reg } = pack(6); const am = mgr(reg);
    expect(am.streamUploadsPerFrame()).toBe(STREAM_UPLOADS_PER_FRAME);
    expect(am.pageUploadsPerFrame()).toBe(PAGE_UPLOADS_PER_FRAME);
    expect(STREAM_UPLOADS_PER_FRAME).toBe(2);
    expect(PAGE_UPLOADS_PER_FRAME).toBe(2);
    const crops = [0, 1, 2, 3, 4, 5].map((i) => id(reg, `crop_t${i}_a`));
    for (const c of crops) am.streamNear(c, true, 4);
    await flush();
    expect(am.started.length).toBe(2); // the rest wait in the queue: the 2/frame gate is the binding one
    for (let f = 0; f < 4; f++) { am.beginFrame(); await flush(); }
    expect(am.started.length).toBe(6);
  });

  it("loading overlay: the boosted rates apply and restore to the base when the overlay lifts", async () => {
    const { reg } = pack(6); const am = mgr(reg);
    am.setLoadingBoost(true);
    expect(am.streamUploadsPerFrame()).toBe(STREAM_UPLOADS_PER_FRAME_BOOST);
    expect(am.pageUploadsPerFrame()).toBe(PAGE_UPLOADS_PER_FRAME_BOOST);
    expect(STREAM_UPLOADS_PER_FRAME_BOOST).toBe(6);
    expect(PAGE_UPLOADS_PER_FRAME_BOOST).toBe(6);
    const crops = [0, 1, 2, 3, 4, 5].map((i) => id(reg, `crop_t${i}_a`));
    for (const c of crops) am.streamNear(c, true, 4);
    await flush();
    expect(am.started.length).toBe(6); // all six start in the first frame: the drain converges 3x faster
    am.setLoadingBoost(false);
    expect(am.streamUploadsPerFrame()).toBe(2);
    expect(am.pageUploadsPerFrame()).toBe(2);
  });

  it("frame time adapts the rate: the phone's once-loaded 5.0 ms boosts, a busy frame does not", () => {
    const { reg } = pack(2); const am = mgr(reg);
    am.noteFrameTime(5.0); // the user's phone, once loaded: frame CPU 5.0 ms
    expect(am.streamUploadsPerFrame()).toBe(6);
    expect(am.pageUploadsPerFrame()).toBe(6);
    am.noteFrameTime(PAGE_IN_FRAME_BUDGET_MS); // boundary is inclusive: 8 ms still leaves half the 16.7 ms budget
    expect(am.streamUploadsPerFrame()).toBe(6);
    am.noteFrameTime(8.5);
    expect(am.streamUploadsPerFrame()).toBe(2);
    expect(am.pageUploadsPerFrame()).toBe(2);
    am.noteFrameTime(12); // busy frame (sprint chunk-gen, heavy draws): back to the base 2
    expect(am.streamUploadsPerFrame()).toBe(2);
    am.noteFrameTime(5.0);
    expect(am.streamUploadsPerFrame()).toBe(6); // recovers as soon as a frame leaves headroom again
    am.noteFrameTime(Number.NaN); // a bad reading never changes the rate
    expect(am.streamUploadsPerFrame()).toBe(6);
    am.noteFrameTime(-1);
    expect(am.streamUploadsPerFrame()).toBe(6);
  });

  it("pumpWarmupTick drains the boosted waiter cap while loading-boosted, 2 otherwise, and never advances the frame", () => {
    const am = Object.create(AtlasManager.prototype) as any;
    const called: number[] = [];
    am.streamStarts = 0; am.uploadsThisFrame = 0; am.frame = 7; am.queue = []; am.pumpCalls = 0;
    am.pump = () => { am.pumpCalls++; };
    am.uploadWaiters = Array.from({ length: 8 }, (_, i) => () => { called.push(i); });
    am.pumpWarmupTick();
    expect(called).toEqual([0, 1]); // base cap: the rest keep waiting for the next tick
    expect(am.uploadsThisFrame).toBe(PAGE_UPLOADS_PER_FRAME);
    expect(am.uploadWaiters).toHaveLength(6);
    expect(am.frame).toBe(7);
    // Loading overlay up: the same tick drains the boosted cap.
    am.setLoadingBoost(true);
    am.uploadWaiters = Array.from({ length: 8 }, (_, i) => () => { called.push(10 + i); });
    am.uploadsThisFrame = 0;
    am.pumpWarmupTick();
    expect(called.slice(2)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(am.uploadsThisFrame).toBe(PAGE_UPLOADS_PER_FRAME_BOOST);
    expect(am.uploadWaiters).toHaveLength(2);
    expect(am.frame).toBe(7); // LRU clock untouched: a warm-up tick can never evict a page
    expect(am.pumpCalls).toBe(0); // empty queue: no pump call
  });
});

describe("ADR-545: the loading overlay boost is held by the warm-up windows themselves", () => {
  /** Gated fake (ADR-374 shape): request never lands, frame frozen so the tick fires every poll. */
  function gatedFake(pageCount: number, poolSlots = 12): any {
    const am = Object.create(AtlasManager.prototype) as any;
    am.atlases = Array.from({ length: pageCount }, (_, i) => ({ key: `furniture_chair_${i}`, lazy: { state: 0 } }));
    am.gen = 0; am.frame = 1; am.queue = []; am.inflight = 0;
    am.streamStarts = 0; am.uploadsThisFrame = 0; am.uploadWaiters = [];
    am.pools = [{ cls: "stream", lru: { capacity: poolSlots } }];
    am.pump = () => { /* gated out: the boost flag is what is under test */ };
    am.request = () => { /* never lands */ };
    return am;
  }
  const keysOf = (n: number): string[] => Array.from({ length: n }, (_, i) => `furniture_chair_${i}`);

  it("warmupFirstView holds the boost for the whole window and restores it after", async () => {
    const am = gatedFake(2, 12);
    const seen: unknown[] = [];
    const protoTick = AtlasManager.prototype.pumpWarmupTick;
    am.pumpWarmupTick = function (this: any) { seen.push(this.loadingBoost); return protoTick.call(this); };
    const r: WarmupResult = await am.warmupFirstView(keysOf(2), { timeoutMs: 150 });
    expect(r.timedOut).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.every((v) => v === true)).toBe(true); // every pump tick inside the window ran boosted
    expect(am.loadingBoost).toBeFalsy(); // restored when the window ended
  });

  it("warmupDrain holds the boost while it waits and restores it after", async () => {
    const am = Object.create(AtlasManager.prototype) as any;
    am.queue = [{}]; am.inflight = 1;
    setTimeout(() => { am.queue = []; am.inflight = 0; }, 100);
    const observed: boolean[] = [];
    const iv = setInterval(() => observed.push(am.loadingBoost === true), 5);
    const r = await am.warmupDrain(300);
    clearInterval(iv);
    expect(r.drained).toBe(true);
    expect(observed).toContain(true); // the drain waited with the boost on
    expect(am.loadingBoost).toBeFalsy();
  });
});

describe("ADR-545: longer stream-page keep (unload 180 -> 600 frames, keep factor 1.5x -> 2x)", () => {
  it("constants: idle pages survive ~10 s off-screen, and the keep radius doubles", () => {
    expect(STREAM_UNLOAD_FRAMES).toBe(600); // ~10 s at 60 fps (was 180, ~3 s): backtracking while walking/sprinting no longer re-pages
    expect(STREAM_KEEP_FACTOR).toBe(2); // keep radius = load margin x2 (was x1.5): 512 px ground / 1280 px animals
  });

  it("hysteresis: a page touched inside the keep radius stays; off-screen for STREAM_UNLOAD_FRAMES it is dropped", async () => {
    const { reg } = pack(2); const am = mgr(reg); const a = id(reg, "crop_t0_a"), b = id(reg, "crop_t1_a");
    am.streamNear(a, true, 4); am.streamNear(b, true, 4); await flush();
    expect(am.started.length).toBe(2);
    for (let f = 0; f < STREAM_UNLOAD_FRAMES + 40; f++) { am.streamNear(a, false, 4); am.beginFrame(); }
    expect(am.atlases[am.sprites[a].atlasIdx].lazy.state).toBe(2); // touched every frame: kept
    expect(am.atlases[am.sprites[b].atlasIdx].lazy.state).toBe(0); // untouched for 600 frames: dropped
    expect(am.evicted).toBe(1);
    expect(am.streamPageReady(am.sprites[b].atlasIdx, 4)).toBe(false); // back in view: miss + re-request
    await flush(); expect(am.atlases[am.sprites[b].atlasIdx].lazy.state).toBe(2);
  });
});

describe("ADR-545: pool slots and budget share are NOT raised (no VRAM headroom on this device class)", () => {
  /** Real manager, ADR-251 shape: planPool only (no rebuild / GL upload). */
  function planAm(budget: number): any {
    const gl = { canvas: undefined, getParameter: () => 4096, isContextLost: () => false, getError: () => 0 } as never;
    const a = new AtlasManager(gl, { registerLoader: () => {} } as never, { textureBudgetMB: budget }) as any;
    a.atlases = []; a.coldDownscale = 1; a.downscale = 1; a.layerSize = 2048; a.layers = 4; a.planLayers = 4; a.packedLayers = 4; a.pools = [];
    return a;
  }
  const streamPages = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `crop_t${i}`, source: {}, count: 1, lazy: { w1: 1024, h1: 1024, state: 0, pool: 4 } }));

  it("constants: the low-memory pool stays 12 slots, desktop 24, stream share 0.25, floor 4", () => {
    // The user's phone is in the low-memory class (256 MB budget <= 256): 12 stream slots against 131+ stream pages.
    expect(STREAM_POOL_SLOTS_LOWMEM).toBe(12);
    expect(STREAM_POOL_SLOTS_DESKTOP).toBe(24);
    expect(STREAM_BUDGET_SHARE).toBe(0.25);
    expect(STREAM_FLOOR_SLOTS).toBe(4);
  });

  it("the planner still plans 12 stream slots at 256 MB (the phone's class) and 24 on desktop budgets", () => {
    const a = planAm(256);
    a.planPool(streamPages(24), STREAM_POOL_SLOTS_LOWMEM, [], "stream", true);
    expect(a.pools[0].lru.capacity).toBe(12);
    expect(a.pools[0].k).toBe(1); // full-res slots: no downscaling to buy slots
    const desk = planAm(768);
    desk.planPool(streamPages(24), STREAM_POOL_SLOTS_DESKTOP, [], "stream", true);
    expect(desk.pools[0].lru.capacity).toBe(24);
    expect(desk.pools[0].k).toBe(1);
  });

  it("at 128 MB the pool keeps full res with fewer slots, never below the stream floor", () => {
    // The planner trims the 12-slot want to what fits at 1x rather than blurring the pool (ADR-449): the ask is
    // still STREAM_POOL_SLOTS_LOWMEM, the floor is STREAM_FLOOR_SLOTS, and the scale stays 1.
    const a = planAm(128);
    a.planPool(streamPages(24), STREAM_POOL_SLOTS_LOWMEM, [], "stream", true);
    expect(a.pools[0].k).toBe(1);
    expect(a.pools[0].lru.capacity).toBeGreaterThanOrEqual(STREAM_FLOOR_SLOTS);
    expect(a.pools[0].lru.capacity).toBeLessThanOrEqual(STREAM_POOL_SLOTS_LOWMEM);
  });
});

describe("ADR-545: longer boot warm-up window (1500 -> 5000 ms)", () => {
  it("WARMUP_WINDOW_MS is 5000: the boot window no longer expires mid-page on a cold cache", () => {
    // ADR-544's world-entry drain passes its own explicit 25 s cap, so this constant now bounds only the boot
    // warm-up (view.ts passes no timeout) and direct callers. The phone's boot warm-up landed 24/27 pages in
    // 1500 ms and timed out; 5 s lets cold-cache fetch + decode + mip chains land. The window is a bound, not a
    // fixed wait: warmupFirstView returns as soon as every page lands.
    expect(WARMUP_WINDOW_MS).toBe(5000);
  });
});
