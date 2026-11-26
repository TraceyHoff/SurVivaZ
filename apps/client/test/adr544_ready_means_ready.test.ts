// ADR-544: ready means ready — no pop-in after entry.
import { describe, expect, test, vi } from "vitest";
import { Transform, World, type Entity } from "@engine/core";
import * as G from "@engine/gameplay";
import { chunkKeyOf } from "@engine/world";
import { FIRST_VIEW_DRAIN_CAP_MS, drainFirstView } from "../src/first-view-drain.js";
import { READY_CHUNK_COUNT, READY_TIMEOUT_MS, isWorldReady, readyFraction, waitForWorldReady, type ReadySessionLike } from "../src/ready.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Fake session with a chunk block of the given radius around the player (default: the 5x5 gate). */
const fake = (opts: { status?: string; withPlayer?: boolean; missing?: string[]; radius?: number } = {}): { s: ReadySessionLike; w: World; p: Entity } => {
  const w = new World({ seed: 1, maxEntities: 1 << 12 }); G.installGameplay(w, {});
  const p = w.create(); w.add(p, Transform, { x: 0, y: 0 });
  const r = opts.radius ?? 2;
  const keys = new Set<string>();
  for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) keys.add(chunkKeyOf(dx * 32, dy * 32));
  for (const m of opts.missing ?? []) keys.delete(m);
  const s: ReadySessionLike = { status: opts.status ?? "connected", world: w, player: opts.withPlayer === false ? undefined : p, client: { tiles: { tiles: { getChunkByKey: (k: string) => (keys.has(k) ? {} : undefined) } } } };
  return { s, w, p };
};

/**
 * Fake atlas whose pages land after a delay, or never (landMs undefined) — no GL. Records the
 * timeout each phase was given, so the tests can pin the shared-cap accounting.
 */
const fakeAtlas = (opts: { warmupLandMs?: number; drainLandMs?: number; warmupThrows?: boolean } = {}) => {
  const seen: { warmupTimeoutMs?: number | undefined; drainTimeoutMs?: number | undefined } = {};
  return {
    seen,
    warmupKeysForSprites: (ids: Iterable<number>) => [...ids].map((id) => `page_${id}`),
    warmupFirstView: async (keys: Iterable<string>, o: { timeoutMs?: number }) => {
      seen.warmupTimeoutMs = o.timeoutMs;
      if (opts.warmupThrows) throw new Error("boom");
      const ks = [...keys];
      const budget = o.timeoutMs ?? 0;
      if (opts.warmupLandMs === undefined) {
        await sleep(budget);
        return { requested: ks.length, alreadyResident: 0, resident: 0, stillPending: ks.length, skipped: 0, ms: budget, timedOut: true };
      }
      await sleep(Math.min(opts.warmupLandMs, budget));
      const landed = opts.warmupLandMs <= budget;
      return { requested: ks.length, alreadyResident: 0, resident: landed ? ks.length : 0, stillPending: landed ? 0 : ks.length, skipped: 0, ms: Math.min(opts.warmupLandMs, budget), timedOut: !landed };
    },
    warmupDrain: async (timeoutMs = 0) => {
      seen.drainTimeoutMs = timeoutMs;
      if (opts.drainLandMs === undefined) { await sleep(timeoutMs); return { pending: 2, ms: timeoutMs, drained: false }; }
      await sleep(Math.min(opts.drainLandMs, timeoutMs));
      const drained = opts.drainLandMs <= timeoutMs;
      return { pending: drained ? 0 : 2, ms: Math.min(opts.drainLandMs, timeoutMs), drained };
    },
  };
};

describe("ADR-544: ready gate waits for the full 5x5 loadRadius block", () => {
  test("a 3x3-complete world is NOT ready: the outer ring is part of the player's own view", () => {
    const innerOnly = fake({ radius: 1 }); // the old 3x3 gate: all 9 inner chunks present
    expect(readyFraction(innerOnly.s)).toBeCloseTo(9 / 25);
    expect(isWorldReady(innerOnly.s)).toBe(false);
  });
  test("ready only when all 25 chunks are present", () => {
    expect(isWorldReady(fake().s)).toBe(true);
    const corner = fake({ missing: [chunkKeyOf(-64, -64)] });
    expect(readyFraction(corner.s)).toBeCloseTo(24 / 25);
    expect(isWorldReady(corner.s)).toBe(false);
    expect(READY_CHUNK_COUNT).toBe(25);
  });
  test("absolute 30 s timeout still lifts a never-ready world (default timeout, fake clock)", async () => {
    const never = fake({ missing: [chunkKeyOf(0, 0)] }).s;
    vi.useFakeTimers();
    try {
      const p = waitForWorldReady(never); // no opts: the absolute timeout must apply
      await vi.advanceTimersByTimeAsync(30_400);
      await expect(p).resolves.toBe(false);
    } finally { vi.useRealTimers(); }
  });
  test("chunks arriving just before the absolute timeout still count as ready", async () => {
    const { s } = fake({ missing: [chunkKeyOf(0, 0)] });
    const keys = new Set<string>();
    const orig = s.client!.tiles.tiles.getChunkByKey;
    s.client!.tiles.tiles.getChunkByKey = (k: string) => (keys.has(k) ? {} : orig(k));
    vi.useFakeTimers();
    try {
      setTimeout(() => keys.add(chunkKeyOf(0, 0)), 29_000);
      const p = waitForWorldReady(s);
      await vi.advanceTimersByTimeAsync(29_500);
      await expect(p).resolves.toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

describe("ADR-544: entry drain waits until pending == 0 within one shared cap", () => {
  test("cap is 25 s and sits inside the 30 s absolute timeout", () => {
    expect(FIRST_VIEW_DRAIN_CAP_MS).toBe(25000);
    expect(READY_TIMEOUT_MS).toBe(30000);
    expect(FIRST_VIEW_DRAIN_CAP_MS).toBeLessThan(READY_TIMEOUT_MS);
  });
  test("overlay stays until pending == 0: the drain waits for pages that land late, then reports drained", async () => {
    const atlas = fakeAtlas({ warmupLandMs: 120, drainLandMs: 80 });
    const t0 = performance.now();
    const r = await drainFirstView(atlas, [1, 2], { capMs: 1000 });
    const elapsed = performance.now() - t0;
    expect(r.drained).toBe(true);
    expect(r.warmup?.stillPending).toBe(0);
    expect(r.warmup?.timedOut).toBe(false);
    expect(r.drain?.drained).toBe(true);
    expect(r.drain?.pending).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(150); // it actually waited for the late pages, not the old 1.5 s window
    expect(elapsed).toBeLessThan(1000);
    expect(atlas.seen.warmupTimeoutMs).toBe(1000); // the warm-up gets the full cap, not WARMUP_WINDOW_MS
  });
  test("cap respected: lifts at the cap even if pages never land — never forever", async () => {
    const atlas = fakeAtlas({}); // nothing ever lands
    const t0 = performance.now();
    const r = await drainFirstView(atlas, [1, 2], { capMs: 200 });
    const elapsed = performance.now() - t0;
    expect(r.drained).toBe(false);
    expect(r.warmup?.timedOut).toBe(true);
    expect(r.warmup?.stillPending).toBe(2);
    expect(r.drain?.drained).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(1000);
  });
  test("the drain gets only the time the warm-up left: the cap is shared, not per phase", async () => {
    const atlas = fakeAtlas({ warmupLandMs: 150 }); // warm-up lands at 150 ms of a 200 ms cap
    const t0 = performance.now();
    const r = await drainFirstView(atlas, [1], { capMs: 200 });
    const elapsed = performance.now() - t0;
    expect(r.drained).toBe(false); // the drain never lands, and it only had ~50 ms left
    expect(atlas.seen.drainTimeoutMs).toBeGreaterThanOrEqual(0);
    expect(atlas.seen.drainTimeoutMs).toBeLessThanOrEqual(100);
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(1000);
  });
  test("a warm-up failure still drains and never blocks ready", async () => {
    const atlas = fakeAtlas({ warmupThrows: true, drainLandMs: 10 });
    const r = await drainFirstView(atlas, [1], { capMs: 1000 });
    expect(r.warmup).toBeUndefined();
    expect(r.drain?.drained).toBe(true);
    expect(r.drained).toBe(true);
  });
  test("nothing to warm up drains immediately", async () => {
    const atlas = fakeAtlas({ drainLandMs: 0 });
    atlas.warmupKeysForSprites = () => [];
    const r = await drainFirstView(atlas, [1], { capMs: 1000 });
    expect(r.warmup).toBeUndefined();
    expect(r.drained).toBe(true);
    expect(r.ms).toBeLessThan(500);
  });
  test("default cap is passed to the warm-up when the caller gives no cap", async () => {
    const atlas = fakeAtlas({ warmupLandMs: 10, drainLandMs: 0 });
    const r = await drainFirstView(atlas, [1]);
    expect(r.capMs).toBe(25000);
    expect(atlas.seen.warmupTimeoutMs).toBe(25000);
    expect(r.drained).toBe(true);
  });
});
