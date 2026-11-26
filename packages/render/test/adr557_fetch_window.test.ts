import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ASSET_DECODE_CONCURRENCY, assetSlotStats, assetSourceStats, resetAssetFetchForTests, setAssetFetchConcurrency,
} from "../src/assets/asset-fetch.js";
import {
  defaultImageLoader, imageLoadStats, resetImageLoadStats, resizeStats, setResizeSlicing, sliced,
} from "../src/assets/atlasManager.js";

/**
 * ADR-557: the fetch-window instrumentation against the REAL modules (no asset-fetch mock):
 * slot-wait vs fetch vs decode inside defaultImageLoader, Cache-Storage-vs-network source, the
 * in-flight peak ADR-559 sizes its decode cap from, and resize chain-wait vs run in sliced().
 * Global fetch answers after 20 ms — long enough that the 2-lane fetch bound below has real
 * margin pressure (at 2 ms the +50 ms slack swallows it) — and the stubbed createImageBitmap
 * decodes after another 2 ms.
 */
const PNG = new Uint8Array([137, 80, 78, 71]);

function stubNetwork(): void {
  vi.stubGlobal("fetch", async (_u: string) => {
    await new Promise((r) => setTimeout(r, 20));
    return new Response(PNG, { status: 200, headers: { "Content-Type": "image/png" } });
  });
}
function stubDecode(): void {
  vi.stubGlobal("createImageBitmap", async (_src: unknown) => {
    await new Promise((r) => setTimeout(r, 2));
    return { width: 128, height: 128, close: () => {} };
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetAssetFetchForTests(); // restores concurrency 8 and zeroes the ADR-557 stats
  resetImageLoadStats();
  setResizeSlicing(true);
});

describe("ADR-557 fetch-window instrumentation (real asset-fetch + defaultImageLoader)", () => {
  it("slot-wait / fetch / decode split, network source, in-flight peak = the slot limit", async () => {
    stubNetwork(); stubDecode();
    setAssetFetchConcurrency(2);
    const t0 = performance.now();
    const imgs = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => defaultImageLoader(`https://x/atlas_${i}.png`)));
    const wallMs = performance.now() - t0;
    expect(imgs.every((im) => im.width === 128)).toBe(true);
    console.log(`[adr557] 6 loads through 2 slots: wall ${wallMs.toFixed(1)}ms · wait ${assetSlotStats.waitMs.toFixed(1)}ms (${assetSlotStats.waits} queued) · fetch ${imageLoadStats.fetchMs.toFixed(1)}ms · decode ${imageLoadStats.decodeMs.toFixed(1)}ms · peak ${assetSlotStats.peak} · cache ${assetSourceStats.cacheHits} / network ${assetSourceStats.networkFetches}`);
    expect(imageLoadStats.loads).toBe(6);
    expect(imageLoadStats.fetchMs).toBeGreaterThan(0);
    expect(imageLoadStats.decodeMs).toBeGreaterThan(0);
    // 6 jobs, 2 slots: the last four must queue, and occupancy must saturate at exactly the limit.
    expect(assetSlotStats.waits).toBe(4);
    expect(assetSlotStats.waitMs).toBeGreaterThan(0);
    expect(assetSlotStats.peak).toBe(2);
    expect(assetSlotStats.inFlight).toBe(0);
    // No Cache Storage in this env: every load is a network fetch, and sources account for all loads.
    expect(assetSourceStats.cacheHits).toBe(0);
    expect(assetSourceStats.networkFetches).toBe(6);
    expect(assetSourceStats.cacheHits + assetSourceStats.networkFetches).toBe(imageLoadStats.loads);
    // Sums reconcile: the summed per-load lifecycle (wait + fetch + decode) covers the wall time
    // (queued loads each live through most of it). The work sums are bounded per lane group:
    // fetch runs inside the fetch slot, so summed fetchMs can never exceed the fetch lanes in
    // force (2) x wall. ADR-559 split the slot this test was written against — decode no longer
    // holds a fetch slot but runs under its own cap (withDecodeSlot / ASSET_DECODE_CONCURRENCY
    // = 16 in asset-fetch.ts) — so summed decodeMs is bounded by 16 x wall, and fetch + decode
    // together are NOT bounded by the fetch lanes alone.
    const lifecycle = assetSlotStats.waitMs + imageLoadStats.fetchMs + imageLoadStats.decodeMs;
    expect(lifecycle).toBeGreaterThanOrEqual(wallMs);
    expect(imageLoadStats.fetchMs).toBeLessThanOrEqual(wallMs * 2 + 50);
    expect(imageLoadStats.decodeMs).toBeLessThanOrEqual(wallMs * ASSET_DECODE_CONCURRENCY + 50);
  });

  it("a Cache Storage hit is counted as cache, not network", async () => {
    stubDecode();
    const store = new Map<string, Response>([["https://x/cached.png", new Response(PNG, { status: 200 })]]);
    vi.stubGlobal("caches", {
      open: async (_name: string) => ({
        match: async (u: string) => store.get(u)?.clone(),
        put: async (u: string, r: Response) => { store.set(String(u), r); },
      }),
      keys: async () => [],
      delete: async () => true,
    });
    let networkCalls = 0;
    vi.stubGlobal("fetch", async (_u: string) => { networkCalls++; return new Response(PNG, { status: 200 }); });
    const img = await defaultImageLoader("https://x/cached.png");
    expect(img.width).toBe(128);
    expect(networkCalls).toBe(0);
    expect(assetSourceStats.cacheHits).toBe(1);
    expect(assetSourceStats.networkFetches).toBe(0);
    expect(imageLoadStats.loads).toBe(1);
  });

  it("sliced() splits resize chain-wait from run time", async () => {
    setResizeSlicing(false); // boot mode: no frame yields, the chain is pure serial CPU + queue
    const w0 = resizeStats.waitMs, r0 = resizeStats.runMs;
    const job = () => new Promise<void>((r) => setTimeout(r, 5));
    await Promise.all([sliced(job), sliced(job), sliced(job)]);
    const waitMs = resizeStats.waitMs - w0, runMs = resizeStats.runMs - r0;
    console.log(`[adr557] 3 x 5ms sliced jobs: chain wait ${waitMs.toFixed(1)}ms · run ${runMs.toFixed(1)}ms`);
    expect(runMs).toBeGreaterThanOrEqual(10); // three serial 5 ms jobs (timer slop aside)
    expect(waitMs).toBeGreaterThan(0); // jobs 2 and 3 queued behind the ones ahead of them
  });
});
