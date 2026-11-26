import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ASSET_DECODE_CONCURRENCY, ASSET_FETCH_CONCURRENCY, assetSlotStats, decodeSlotStats,
  resetAssetFetchForTests, setAssetDecodeConcurrency,
} from "../src/assets/asset-fetch.js";
import {
  decodeImageBlob, defaultImageLoader, imageLoadStats, resetImageLoadStats,
} from "../src/assets/atlasManager.js";

/**
 * ADR-559: the asset slot covers fetch + blob() only; decode runs under a SEPARATE cap
 * (ASSET_DECODE_CONCURRENCY = 16) shared by defaultImageLoader (page-in / legacy resident)
 * and decodeImageBlob (ADR-558's decode-at-scale path). Against the REAL modules: before the
 * split a slot was held across fetch+decode, so N loads cost ceil(N/8) x (fetch + decode);
 * now the wall is fetch rounds + ONE decode wave, fetch occupancy never exceeds 8, and total
 * in-flight decodes never exceed the cap no matter which path they came from.
 */
const PNG = new Uint8Array([137, 80, 78, 71]);

function stubNetwork(ms = 2): void {
  vi.stubGlobal("fetch", async (_u: string) => {
    await new Promise((r) => setTimeout(r, ms));
    return new Response(PNG, { status: 200, headers: { "Content-Type": "image/png" } });
  });
}
function stubDecode(ms: number): void {
  vi.stubGlobal("createImageBitmap", async (_src: unknown) => {
    await new Promise((r) => setTimeout(r, ms));
    return { width: 128, height: 128, close: () => {} };
  });
}
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error("until() timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetAssetFetchForTests(); // restores fetch concurrency 8, decode cap 16, zeroes both stats
  resetImageLoadStats();
});

describe("ADR-559 split asset slot (real asset-fetch + loaders)", () => {
  it("caps are pinned: fetch stays 8, decode is its own 16", () => {
    expect(ASSET_FETCH_CONCURRENCY).toBe(8);
    expect(ASSET_DECODE_CONCURRENCY).toBe(16);
  });

  it("slow decode: N loads complete in fetch-bound + one decode wave, not (fetch+decode)/8 time", async () => {
    stubNetwork(2); stubDecode(80);
    const N = 16;
    const t0 = performance.now();
    const imgs = await Promise.all(Array.from({ length: N }, (_, i) => defaultImageLoader(`https://x/atlas_${i}.png`)));
    const wallMs = performance.now() - t0;
    expect(imgs.every((im) => im.width === 128)).toBe(true);
    expect(imageLoadStats.loads).toBe(N);
    // Slot-held-across-decode bound: ceil(16/8) rounds x (fetch + decode) = summed/8 ≈ 165ms.
    // Split bound: 2 fetch rounds overlapped with ONE decode wave (cap 16 >= N) ≈ half that.
    // Ratio assertion (not absolute ms): timer stretch under load inflates both shapes alike.
    const summed = imageLoadStats.fetchMs + imageLoadStats.decodeMs;
    console.log(`[adr559] ${N} loads, decode 80ms: wall ${wallMs.toFixed(1)}ms · summed fetch+decode ${summed.toFixed(1)}ms (slot-bound prediction ~${(summed / 8).toFixed(0)}ms) · fetch peak ${assetSlotStats.peak} · decode peak ${decodeSlotStats.peak}`);
    expect(summed / 8).toBeGreaterThan(120); // the old shape really would cost this much
    expect(wallMs).toBeLessThan((summed / 8) * 0.75);
    // Fetch occupancy never exceeded the 8 slots; decodes ran WIDER than the fetch pool.
    expect(assetSlotStats.peak).toBeLessThanOrEqual(8);
    expect(decodeSlotStats.peak).toBeGreaterThan(8);
    expect(decodeSlotStats.peak).toBeLessThanOrEqual(ASSET_DECODE_CONCURRENCY);
    expect(assetSlotStats.inFlight).toBe(0);
    expect(decodeSlotStats.inFlight).toBe(0);
  });

  it("the fetch slot is released before decode starts (occupancy drops while decodes run)", async () => {
    stubNetwork(2); stubDecode(60);
    const loads = Array.from({ length: 8 }, (_, i) => defaultImageLoader(`https://x/slow_${i}.png`));
    // All 8 decodes in flight at once — and not one fetch slot still held.
    await until(() => decodeSlotStats.inFlight === 8);
    expect(assetSlotStats.inFlight).toBe(0);
    const imgs = await Promise.all(loads);
    expect(imgs.every((im) => im.width === 128)).toBe(true);
  });

  it("decodeImageBlob holds no fetch slot while decoding", async () => {
    stubDecode(60);
    const p = decodeImageBlob(new Blob([PNG], { type: "image/png" }));
    await until(() => decodeSlotStats.inFlight === 1);
    expect(assetSlotStats.inFlight).toBe(0);
    await p;
  });

  it("one decode cap bounds BOTH paths together (loader + decodeImageBlob interleaved)", async () => {
    stubNetwork(2); stubDecode(20);
    setAssetDecodeConcurrency(4);
    const blob = new Blob([PNG], { type: "image/png" });
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) jobs.push(defaultImageLoader(`https://x/mix_${i}.png`));
    for (let i = 0; i < 10; i++) jobs.push(decodeImageBlob(blob));
    await Promise.all(jobs);
    console.log(`[adr559] 20 mixed decodes under cap 4: decode peak ${decodeSlotStats.peak} · fetch peak ${assetSlotStats.peak}`);
    expect(imageLoadStats.loads).toBe(20);
    expect(decodeSlotStats.peak).toBe(4); // saturated at the cap, never above it
    expect(assetSlotStats.peak).toBeLessThanOrEqual(8);
    expect(decodeSlotStats.inFlight).toBe(0);
  });
});
