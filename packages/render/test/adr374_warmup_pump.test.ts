import { describe, expect, it } from "vitest";
import {
  WARMUP_MAX_PAGES, WARMUP_WINDOW_MS, type WarmupResult,
} from "../src/assets/warmup.js";
import { AtlasManager, PAGE_UPLOADS_PER_FRAME, STREAM_UPLOADS_PER_FRAME } from "../src/assets/atlasManager.js";

/**
 * ADR-374: the ADR-370 warm-up window stalled. beginFrame() is the only place that resets
 * streamStarts / uploadsThisFrame, and it only runs during a rendered frame — which does not
 * exist yet at boot. warmupFirstView requested up to 24 pages, then polled for 1500 ms without
 * ever pumping, so after 2 stream starts + 2 GPU uploads both gates stalled: the window expired
 * with ~2 pages landed and the first view still blurry.
 *
 * These tests use a gated fake manager (real warmupFirstView / pumpWarmupTick / streamPoolSlots
 * off AtlasManager.prototype, fake request/pump that mirror the real gates): a page-in only
 * starts while streamStarts < STREAM_UPLOADS_PER_FRAME, and only a pump tick resets that
 * counter — exactly the gate the boot window used to starve.
 */
interface FakeAtlas { key: string; lazy: { state: number } | null }
interface GatedFake {
  atlases: FakeAtlas[];
  gen: number; frame: number; queue: FakeAtlas[]; inflight: number;
  streamStarts: number; uploadsThisFrame: number; uploadWaiters: (() => void)[];
  pools: { cls: string; lru: { capacity: number } }[];
  request(a: FakeAtlas, prio: number): void;
  pump(): void;
  pumpWarmupTick(): void;
  streamPoolSlots(): number | undefined;
  warmupFirstView(keys: Iterable<string>, opts?: { firstView?: Iterable<string>; maxPages?: number; timeoutMs?: number }): Promise<WarmupResult>;
  warmupDrain(timeoutMs?: number): Promise<{ pending: number; ms: number; drained: boolean }>;
}

/** Fake page-in: at most STREAM_UPLOADS_PER_FRAME starts per tick; a started page lands 5 ms later and re-drives the pump (like pageIn's .finally). */
function gatedFake(pageCount: number, poolSlots = 12): GatedFake {
  const am = Object.create(AtlasManager.prototype) as unknown as GatedFake;
  am.atlases = Array.from({ length: pageCount }, (_, i) => ({ key: `furniture_chair_${i}`, lazy: { state: 0 } }));
  am.gen = 0; am.frame = 1; am.queue = []; am.inflight = 0;
  am.streamStarts = 0; am.uploadsThisFrame = 0; am.uploadWaiters = [];
  am.pools = [{ cls: "stream", lru: { capacity: poolSlots } }];
  const pump = (): void => {
    // PAGE_CONCURRENCY is 6 in the real manager; the stream-start gate is the one under test.
    while (am.inflight < 6 && am.queue.length > 0 && am.streamStarts < STREAM_UPLOADS_PER_FRAME) {
      const a = am.queue.shift()!;
      am.streamStarts++; am.inflight++;
      a.lazy!.state = 1;
      setTimeout(() => { am.inflight--; a.lazy!.state = 2; pump(); }, 5);
    }
  };
  am.pump = pump;
  am.request = (a: FakeAtlas, _prio: number): void => {
    if (!a.lazy || a.lazy.state !== 0 || am.queue.includes(a)) return;
    am.queue.push(a); pump();
  };
  return am;
}

const keysOf = (n: number): string[] => Array.from({ length: n }, (_, i) => `furniture_chair_${i}`);

describe("ADR-374 warm-up pump (gated fake manager)", () => {
  it("lands all requested pages within the window — the pump tick drives the page-ins", async () => {
    const am = gatedFake(12, 12);
    const r = await am.warmupFirstView(keysOf(12));
    expect(r.requested).toBe(12);
    expect(r.resident).toBe(12);
    expect(r.stillPending).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.ms).toBeLessThan(WARMUP_WINDOW_MS);
  });

  it("without the pump tick the same fake stalls at ~2 pages and times out (the ADR-370 behaviour)", async () => {
    const am = gatedFake(12, 12);
    am.pumpWarmupTick = () => { /* no-op: simulates the old wait loop, which never pumped */ };
    const r = await am.warmupFirstView(keysOf(12), { timeoutMs: 200 });
    expect(r.requested).toBe(12);
    expect(r.resident).toBe(2); // only the request-time pump's 2 stream starts ever landed
    expect(r.stillPending).toBe(10);
    expect(r.timedOut).toBe(true);
    expect(r.ms).toBeGreaterThanOrEqual(180);
  });

  it("pumpWarmupTick resets the per-frame gates, drains at most 2 upload waiters, and does not advance the frame", () => {
    const am = Object.create(AtlasManager.prototype) as unknown as {
      streamStarts: number; uploadsThisFrame: number; uploadWaiters: (() => void)[];
      queue: unknown[]; frame: number; pumpCalls: number;
      pump(): void; pumpWarmupTick(): void;
    };
    const called: number[] = [];
    am.streamStarts = 2; am.uploadsThisFrame = 2;
    am.uploadWaiters = [() => { called.push(1); }, () => { called.push(2); }, () => { called.push(3); }];
    am.queue = [{}]; am.frame = 7; am.pumpCalls = 0;
    am.pump = () => { am.pumpCalls++; };
    am.pumpWarmupTick();
    expect(am.streamStarts).toBe(0);
    expect(am.uploadsThisFrame).toBe(PAGE_UPLOADS_PER_FRAME);
    expect(called).toEqual([1, 2]); // the third waiter keeps waiting for the next tick
    expect(am.uploadWaiters).toHaveLength(1);
    expect(am.pumpCalls).toBe(1);
    expect(am.frame).toBe(7); // LRU clock untouched: no unloadIdleStream, no eviction risk
    // Empty queue: no pump call, but waiters still drain.
    am.queue = []; am.pumpCalls = 0; am.streamStarts = 2; am.uploadsThisFrame = 0;
    am.pumpWarmupTick();
    expect(am.pumpCalls).toBe(0);
    expect(called).toEqual([1, 2, 3]);
  });

  it("warmupFirstView clamps requests to the stream pool", async () => {
    const syncFake = (pageCount: number, pools: { cls: string; lru: { capacity: number } }[]): GatedFake => {
      const am = gatedFake(pageCount, 12);
      am.pools = pools;
      am.request = (a: FakeAtlas, _prio: number): void => { if (a.lazy) a.lazy.state = 2; }; // lands synchronously: the clamp is what is under test
      return am;
    };
    // Low-memory pool (12 slots): 20 candidates -> 12 requested, 8 skipped.
    const low = syncFake(20, [{ cls: "stream", lru: { capacity: 12 } }]);
    const rLow = await low.warmupFirstView(keysOf(20));
    expect(rLow.requested).toBe(12);
    expect(rLow.skipped).toBe(8);
    // Desktop pool (24 slots): all 20 requested.
    const desk = syncFake(20, [{ cls: "stream", lru: { capacity: 24 } }]);
    const rDesk = await desk.warmupFirstView(keysOf(20));
    expect(rDesk.requested).toBe(20);
    expect(rDesk.skipped).toBe(0);
    // No stream pool planned yet: falls back to WARMUP_MAX_PAGES.
    const none = syncFake(20, []);
    const rNone = await none.warmupFirstView(keysOf(20));
    expect(rNone.requested).toBe(Math.min(20, WARMUP_MAX_PAGES));
    // An explicit smaller maxPages still wins.
    const small = syncFake(20, [{ cls: "stream", lru: { capacity: 12 } }]);
    const rSmall = await small.warmupFirstView(keysOf(20), { maxPages: 5 });
    expect(rSmall.requested).toBe(5);
    expect(rSmall.skipped).toBe(15);
  });

  it("the tick is gap-fill only: it stays out of the way while rendered frames run", async () => {
    // Pages never land; the loop runs the whole window. Frame advancing -> no tick calls.
    const advancing = gatedFake(2, 12);
    advancing.request = () => { /* never lands */ };
    let tickCalls = 0;
    advancing.pumpWarmupTick = () => { tickCalls++; };
    const startFrame = advancing.frame;
    const iv = setInterval(() => { advancing.frame++; }, 2);
    try {
      const r = await advancing.warmupFirstView(keysOf(2), { timeoutMs: 150 });
      expect(r.timedOut).toBe(true);
      expect(advancing.frame).toBeGreaterThan(startFrame);
      expect(tickCalls).toBe(0);
    } finally { clearInterval(iv); }
    // Frame frozen (the boot case: no rendered frames exist) -> the tick fires every poll.
    const frozen = gatedFake(2, 12);
    frozen.request = () => { /* never lands */ };
    let frozenCalls = 0;
    frozen.pumpWarmupTick = () => { frozenCalls++; };
    const r2 = await frozen.warmupFirstView(keysOf(2), { timeoutMs: 150 });
    expect(r2.timedOut).toBe(true);
    expect(frozenCalls).toBeGreaterThanOrEqual(3);
  });
});
