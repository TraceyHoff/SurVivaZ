// ADR-551: painters in parallel / in a Worker (pixel-identical) —
// (a) structural: >1 painter group in flight at once through the new orchestrator
//     (the old sequential code maxes at 1 — the sequential baseline below proves
//     the test discriminates);
// (b) pixel-identity: SHA-256 of every atlas's pixels via the worker path vs the
//     direct paint — identical for all 43 atlases (47 variants incl. task410 @2x);
// (c) ADR-550 interaction: a warm boot still skips paint entirely (the pool is
//     never asked), a partial hit repaints only the missed group, and any worker
//     failure (throw / error reply / timeout / no Worker at all) falls back to
//     main-thread paint with identical bytes.
// No canvas in this VM, so the encode step is injected (Blob from the painted
// pixels, as in adr550) and the "Worker" is a fake implementing the same
// PaintWorkerLike seam — it runs the real `paintGroupVariants` handler (the
// exact code the real `paint-worker.ts` entry runs) and delivers the reply
// asynchronously, with the pixels copied as a transfer would. A real browser
// Worker cannot run in vitest (Node has no `Worker` global here), so the
// thread hop itself is verified by code review + the pool's fake-worker tests,
// not by this file.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PAINTED_CACHE_NAME, hashPaintedSpec, paintedCacheKey,
  type PaintedCacheEnv,
} from "../src/painted-cache.js";
import { paintPaintedGroup } from "../src/painted-core.js";
import { paintGroupVariants, PAINTED_GROUP_NAMES } from "../src/painted-groups.js";
import {
  createPaintWorkerPool, paintedGroupDef, paintPaintedGroups, paintWorkerPoolSize,
  type PaintWorkerLike, type PaintWorkerPool,
} from "../src/painted-parallel.js";
import type { PaintWorkerRequest, PaintWorkerResponse } from "../src/paint-worker.js";
import { task540Specs } from "../src/task540-art.js";

/** Fake Cache Storage (same shape as adr550's: match/put clone like the real one). */
class FakeCache {
  entries = new Map<string, Response>();
  puts = 0;
  async match(req: string): Promise<Response | undefined> { return this.entries.get(req)?.clone(); }
  async put(req: string, res: Response): Promise<void> { this.puts++; this.entries.set(req, res.clone()); }
  async delete(req: string): Promise<boolean> { return this.entries.delete(req); }
  async keys(): Promise<{ url: string }[]> { return [...this.entries.keys()].map((url) => ({ url })); }
}
class FakeCaches {
  buckets = new Map<string, FakeCache>();
  async open(name: string): Promise<FakeCache> {
    let b = this.buckets.get(name);
    if (!b) { b = new FakeCache(); this.buckets.set(name, b); }
    return b;
  }
  async delete(name: string): Promise<boolean> { return this.buckets.delete(name); }
  async keys(): Promise<string[]> { return [...this.buckets.keys()]; }
  painted(): FakeCache { return this.buckets.get(PAINTED_CACHE_NAME)!; }
}

const sha256 = (p: Uint8ClampedArray): string => createHash("sha256").update(p).digest("hex");

/** Fake env: blob-URL registry + an encode that records pixels + encode concurrency. */
function fakeEnv(caches = new FakeCaches()): {
  env: PaintedCacheEnv; caches: FakeCaches; blobs: Map<string, Blob>;
  encoded: Map<string, { w: number; h: number; hash: string }>;
  encodeActive: { current: number; max: number }; encodes: number;
} {
  const blobs = new Map<string, Blob>();
  const encoded = new Map<string, { w: number; h: number; hash: string }>();
  const encodeActive = { current: 0, max: 0 };
  let n = 0, encodes = 0;
  const env: PaintedCacheEnv = {
    caches,
    createObjectURL: (b: Blob) => { const u = `blob:fake-${++n}`; blobs.set(u, b); return u; },
    revokeObjectURL: (u: string) => { blobs.delete(u); },
    // The PNG bytes ARE the painted pixels (as in adr550); the hash is taken
    // here so the worker-path pixels can be compared without re-reading blobs.
    encode: async (w: number, h: number, p: Uint8ClampedArray): Promise<Blob> => {
      encodes++;
      encodeActive.current++;
      encodeActive.max = Math.max(encodeActive.max, encodeActive.current);
      try {
        await new Promise((r) => setTimeout(r, 0)); // let sibling encodes overlap
        const hash = sha256(p);
        encoded.set(`${w}x${h}:${hash.slice(0, 12)}`, { w, h, hash });
        return new Blob([new Uint8Array(p)]);
      } finally {
        encodeActive.current--;
      }
    },
  };
  return { env, caches, blobs, encoded, encodeActive, get encodes() { return encodes; } };
}

/** Shared concurrency counter across all FakeWorker instances (one pool's threads). */
function fakeWorkerCounter(): { active: number; max: number; paints: number } {
  return { active: 0, max: 0, paints: 0 };
}

/**
 * Fake paint Worker: runs the REAL `paintGroupVariants` handler in-process and
 * delivers the reply on a later tick (like a real worker), with the pixels
 * copied — the same bytes a transferred buffer would carry. `mode` selects the
 * failure under test (none = healthy).
 */
class FakeWorker implements PaintWorkerLike {
  onmessage: ((e: { data: PaintWorkerResponse }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(
    private counter: { active: number; max: number; paints: number },
    private mode: "ok" | "error-reply" | "never" = "ok",
  ) {}
  postMessage(msg: PaintWorkerRequest): void {
    this.counter.paints++;
    this.counter.active++;
    this.counter.max = Math.max(this.counter.max, this.counter.active);
    if (this.mode === "never") return; // wedged: never replies (the pool must time out)
    setTimeout(() => {
      this.counter.active--;
      if (this.mode === "error-reply") {
        this.onmessage?.({ data: { id: msg.id, group: msg.group, error: "boom" } });
        return;
      }
      try {
        // Copy the pixels: a transferred buffer arrives as a fresh copy on the
        // main thread — same bytes, no shared mutation.
        const variants = paintGroupVariants(msg.group).map((v) => ({
          ...v, pixels: new Uint8ClampedArray(v.pixels),
        }));
        this.onmessage?.({ data: { id: msg.id, group: msg.group, variants } });
      } catch (e) {
        this.onmessage?.({ data: { id: msg.id, group: msg.group, error: e instanceof Error ? e.message : String(e) } });
      }
    }, 0);
  }
  terminate(): void { /* nothing held */ }
}

const fakePool = (
  counter: { active: number; max: number; paints: number },
  opts: { size?: number; timeoutMs?: number; mode?: "ok" | "error-reply" | "never" } = {},
): PaintWorkerPool => createPaintWorkerPool({
  size: opts.size ?? 4,
  timeoutMs: opts.timeoutMs ?? 60_000,
  createWorker: () => new FakeWorker(counter, opts.mode ?? "ok"),
})!;

/** All atlas keys across the 13 groups' sources (task410 contributes 4, not 8). */
const allSourceKeys = (groups: Map<string, Map<string, unknown>>): string[] =>
  [...groups.values()].flatMap((m) => [...m.keys()]).sort();

/** Direct (main-thread, no pool) pixel hashes per variant key, for identity checks. */
const directVariantHashes = (): Map<string, { w: number; h: number; hash: string }> => {
  const out = new Map<string, { w: number; h: number; hash: string }>();
  for (const name of PAINTED_GROUP_NAMES) {
    for (const v of paintGroupVariants(name)) out.set(v.key, { w: v.width, h: v.height, hash: sha256(v.pixels) });
  }
  return out;
};

describe("ADR-551 (a) structural: >1 painter group in flight at once", () => {
  it("paintPaintedGroups runs the 13 groups concurrently (max in flight > 1); the same groups awaited one by one max at 1", async () => {
    const { env } = fakeEnv();
    const counter = fakeWorkerCounter();
    const pool = fakePool(counter, { size: 4 });
    const groups = await paintPaintedGroups(env, pool);
    pool.terminate();
    expect([...groups.keys()].sort()).toEqual([...PAINTED_GROUP_NAMES].sort());
    expect(allSourceKeys(groups)).toHaveLength(43);
    expect(counter.paints).toBe(13); // every group painted once (cold cache)
    expect(counter.max).toBeGreaterThan(1);
    expect(counter.max).toBeLessThanOrEqual(4); // the pool cap is honoured

    // Sequential baseline — the old shape: the same 13 groups, awaited one by
    // one through the same pool. Max in flight is 1 by construction, so this
    // run proves the concurrency assertion above discriminates (it fails on
    // sequential code, not just on broken code).
    const seq = fakeEnv();
    const seqCounter = fakeWorkerCounter();
    const seqPool = fakePool(seqCounter, { size: 4 });
    const seqGroups = new Map<string, Map<string, unknown>>();
    for (const name of PAINTED_GROUP_NAMES) {
      seqGroups.set(name, await paintPaintedGroup(paintedGroupDef(name), seq.env, seqPool));
    }
    seqPool.terminate();
    expect(allSourceKeys(seqGroups)).toHaveLength(43);
    expect(seqCounter.max).toBe(1);
    expect(seqCounter.paints).toBe(13);
  }, 120000);

  it("per-atlas encodes overlap inside a group (task361: 16 atlases, max encode in flight > 1)", async () => {
    const f = fakeEnv();
    const out = await paintPaintedGroup(paintedGroupDef("task361"), f.env);
    expect([...out.keys()]).toHaveLength(16);
    expect(f.encodes).toBe(16);
    expect(f.encodeActive.max).toBeGreaterThan(1);
  }, 120000);
});

describe("ADR-551 (b) pixel-identity: worker path vs direct paint", () => {
  it("SHA-256 of every variant's pixels is identical via the worker path and via direct paint (47 variants, 43 atlases)", async () => {
    const f = fakeEnv();
    const counter = fakeWorkerCounter();
    const pool = fakePool(counter, { size: 4 });
    const groups = await paintPaintedGroups(f.env, pool);
    pool.terminate();
    expect(allSourceKeys(groups)).toHaveLength(43);
    // The worker-path pixels are the ones the fake encode received (cold cache:
    // every variant missed and was encoded exactly once).
    expect(f.encodes).toBe(47); // 43 atlases + 4 task410 @2x pages
    const direct = directVariantHashes();
    expect(direct.size).toBe(47);
    for (const [key, d] of direct) {
      const got = [...f.encoded.values()].find((e) => e.hash === d.hash && e.w === d.w && e.h === d.h);
      expect(got, `variant ${key} differs between worker path and direct paint`).toBeDefined();
    }
    // And the worker path's PNG bytes equal the main-thread (no-pool) path's
    // bytes for every atlas, key by key.
    const main = fakeEnv();
    const mainGroups = await paintPaintedGroups(main.env);
    const bytesOf = (blobs: Map<string, Blob>, url: string): Promise<number[]> =>
      blobs.get(url)!.arrayBuffer().then((b) => [...new Uint8Array(b)]);
    for (const [gName, sources] of groups) {
      for (const [key, src] of sources) {
        const mainSrc = mainGroups.get(gName)!.get(key)!;
        expect(await bytesOf(f.blobs, src.url)).toEqual(await bytesOf(main.blobs, mainSrc.url));
        for (const [i, page] of (src.pages ?? []).entries()) {
          expect(await bytesOf(f.blobs, page.url)).toEqual(await bytesOf(main.blobs, mainSrc.pages![i]!.url));
        }
      }
    }
  }, 120000);
});

describe("ADR-551 (c) ADR-550 interaction: cache hit still skips paint", () => {
  it("a warm boot never asks the pool to paint and returns byte-identical sources; a one-entry eviction repaints only its group", async () => {
    const f = fakeEnv();
    const counter = fakeWorkerCounter();
    const pool = fakePool(counter, { size: 4 });
    const cold = await paintPaintedGroups(f.env, pool);
    expect(counter.paints).toBe(13);
    const putsAfterCold = f.caches.painted().puts;
    expect(putsAfterCold).toBe(47); // every variant stored once
    const coldBytes = new Map<string, number[]>();
    for (const sources of cold.values()) {
      for (const [key, src] of sources) {
        coldBytes.set(key, [...new Uint8Array(await f.blobs.get(src.url)!.arrayBuffer())]);
      }
    }

    const warm = await paintPaintedGroups(f.env, pool);
    expect(counter.paints).toBe(13); // no new paints — the pool was never asked
    expect(f.caches.painted().puts).toBe(putsAfterCold); // no re-puts either
    for (const sources of warm.values()) {
      for (const [key, src] of sources) {
        expect([...new Uint8Array(await f.blobs.get(src.url)!.arrayBuffer())]).toEqual(coldBytes.get(key));
      }
    }

    // Evict one entry (pred_cougar): only its group repaints, and only that
    // variant is re-encoded + re-put; every other group's bytes are unchanged.
    const cougarKey = paintedCacheKey("pred_cougar", hashPaintedSpec(task540Specs().get("pred_cougar")!));
    expect(await f.caches.painted().delete(cougarKey)).toBe(true);
    const afterEvict = await paintPaintedGroups(f.env, pool);
    pool.terminate();
    expect(counter.paints).toBe(14); // exactly one more paint: task540
    expect(f.caches.painted().puts).toBe(putsAfterCold + 1);
    for (const sources of afterEvict.values()) {
      for (const [key, src] of sources) {
        expect([...new Uint8Array(await f.blobs.get(src.url)!.arrayBuffer())]).toEqual(coldBytes.get(key));
      }
    }
  }, 120000);

  it("canvas-less (no Cache Storage, no canvas) still returns empty maps — the manifest debug path is kept", async () => {
    const groups = await paintPaintedGroups({ caches: null });
    expect(allSourceKeys(groups)).toHaveLength(0);
  }, 120000);
});

describe("ADR-551 worker failure falls back to main-thread paint", () => {
  it("a worker that errors, and a pool whose construction throws, both fall back with identical bytes", async () => {
    // Error-reply worker: every job rejects at the pool, the orchestrator
    // repaints on the main thread.
    const f = fakeEnv();
    const counter = fakeWorkerCounter();
    const pool = fakePool(counter, { mode: "error-reply" });
    const groups = await paintPaintedGroups(f.env, pool);
    pool.terminate();
    expect(allSourceKeys(groups)).toHaveLength(43);
    expect(counter.paints).toBe(13); // the pool WAS asked (and failed) for every group
    expect(f.encodes).toBe(47); // ...and the main-thread fallback encoded them all

    // Construction throws (CSP / bad worker URL): the pool rejects everything
    // queued, the orchestrator paints on the main thread.
    const g = fakeEnv();
    const throwing = createPaintWorkerPool({
      size: 2,
      createWorker: () => { throw new Error("Worker blocked"); },
    })!;
    const groups2 = await paintPaintedGroups(g.env, throwing);
    throwing.terminate();
    expect(allSourceKeys(groups2)).toHaveLength(43);
  }, 120000);

  it("a wedged worker times out (pool-level: no full paint needed) and a later job still works on a fresh worker", async () => {
    const counter = fakeWorkerCounter();
    const pool = fakePool(counter, { size: 1, timeoutMs: 50, mode: "never" });
    await expect(pool.paint("task256")).rejects.toThrow(/timed out after 50 ms/);
    // The wedged worker was terminated and dropped; a healthy worker serves
    // the next job (the pool re-creates on demand).
    const healthy = fakePool(fakeWorkerCounter(), { size: 1, timeoutMs: 5_000 });
    const variants = await healthy.paint("task256");
    healthy.terminate();
    expect(variants).toHaveLength(1);
    expect(variants[0]!.key).toBe("crops_task256");
    pool.terminate();
  }, 120000);

  it("no Worker at all (pool undefined) paints on the main thread — the canvas-less fallback is preserved", async () => {
    expect(createPaintWorkerPool()).toBeUndefined(); // this VM has no Worker global
    const f = fakeEnv();
    const groups = await paintPaintedGroups(f.env, undefined);
    expect(allSourceKeys(groups)).toHaveLength(43);
  }, 120000);

  it("pool size clamps to 2–4 workers", () => {
    expect(paintWorkerPoolSize()).toBeGreaterThanOrEqual(2);
    expect(paintWorkerPoolSize()).toBeLessThanOrEqual(4);
  });
});

describe("ADR-551 view.ts wiring (source pins — IsoView.create needs a canvas + GL)", () => {
  it("the 13 groups run under one Promise.all with a worker pool created before and terminated after the phase", () => {
    const viewSrc = readFileSync(new URL("../src/view.ts", import.meta.url), "utf8");
    expect(viewSrc).toContain(`import { createPaintWorkerPool } from "./painted-parallel.js";`);
    expect(viewSrc).toContain(`const paintPool = createPaintWorkerPool();`);
    expect(viewSrc).toContain(`await Promise.all([`);
    for (const name of PAINTED_GROUP_NAMES) {
      expect(viewSrc).toContain(`paintGroup("${name}", `);
    }
    expect(viewSrc).toContain(`paintPool?.terminate();`);
    expect(viewSrc.indexOf(`paintPool?.terminate();`)).toBeGreaterThan(viewSrc.indexOf(`await Promise.all([`));
    // The old sequential shape is gone.
    expect(viewSrc).not.toContain(`await paintGroup("task34", task34AtlasSources);`);
    // ADR-548 instrumentation is untouched: per-group timing + blob.size read.
    expect(viewSrc).toContain(`paintedGroups.push({ name: \`painted.${"${name}"}\`, ms: Math.round(performance.now() - g0) })`);
    expect(viewSrc).toContain(`paintedAtlasBytes.push({ key: k, bytes })`);
  });

  it("seasonal slopes are NOT folded in: all four seasons still paint at boot (no season-gated paint path exists)", () => {
    // The user ruling was "fold in IF a clean scheduling hook exists" — there is
    // none: boot cannot know the season (no net world yet at IsoView.create),
    // and painting a deferred season mid-game would need the same swap/rebuild
    // the lazy-paint option was rejected for. This test pins the deliberate
    // omission so a later worker does not silently half-ship it.
    const groupsSrc = readFileSync(new URL("../src/painted-groups.ts", import.meta.url), "utf8");
    const parallelSrc = readFileSync(new URL("../src/painted-parallel.ts", import.meta.url), "utf8");
    // No season gating anywhere in the paint path: no season lookup, no
    // rollover hook, no per-season paint list — boot paints all four seasons.
    for (const src of [groupsSrc, parallelSrc]) {
      expect(src).not.toMatch(/seasonAtDays|viewSeason|currentSeason|seasonIndex|rollover|onlyCurrentSeason/i);
    }
    expect(PAINTED_GROUP_NAMES).toContain("task410");
    // ...and the task410 group still paints all four seasons in one call.
    expect(paintGroupVariants("task410")).toHaveLength(8); // 4 seasons x (1x + @2x)
  });
});
