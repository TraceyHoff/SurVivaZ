import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { AssetManager } from "@engine/core";
import { loadManifest, type AssetRegistry } from "@engine/assets";
import { PACK_DIR } from "@engine/assets/node";

/**
 * ADR-548: boot-phase instrumentation in AtlasManager.rebuild — the rebuild runs for real here
 * (stub GL + stubbed fetch/decode, real manifest), so the new sub-fields are measured on the
 * instrumented code, not on a fixture object.
 *
 * The mock assetFetch answers every atlas URL after a 2 ms delay and the stubbed
 * createImageBitmap decodes after another 2 ms, so the fetch/decode split is nonzero and
 * measurable; the stub GL counts texStorage3D / texSubImage3D / generateMipmap calls so the
 * upload split can be cross-checked against the GL calls that produced it.
 */
vi.mock("../src/assets/asset-fetch.js", () => {
  // ADR-557: the mock slot is a real 8-wide semaphore (production limit) that maintains the same
  // stats shape as the real withAssetSlot, so slot-wait / in-flight peak are measured, not faked.
  // Every mock fetch counts as a network fetch (the mock has no Cache Storage).
  const assetSlotStats = { waitMs: 0, waits: 0, inFlight: 0, peak: 0 };
  const assetSourceStats = { cacheHits: 0, networkFetches: 0 };
  let active = 0; const waiters: Array<() => void> = [];
  // ADR-559: the mock decode slot is a real 16-wide semaphore (production cap) maintaining the
  // same stats shape as the real withDecodeSlot, so the decode peak is measured, not faked.
  const decodeSlotStats = { inFlight: 0, peak: 0 };
  let dActive = 0; const dWaiters: Array<() => void> = [];
  return {
    assetFetch: async (_url: string) => {
      assetSourceStats.networkFetches++;
      return {
        ok: true, status: 200,
        blob: async () => { await new Promise((r) => setTimeout(r, 2)); return new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }); },
      };
    },
    assetBytes: async (_url: string) => new ArrayBuffer(8),
    withAssetSlot: async (fn: () => Promise<unknown>) => {
      const t0 = performance.now();
      if (active >= 8) { assetSlotStats.waits++; await new Promise<void>((r) => waiters.push(r)); }
      assetSlotStats.waitMs += performance.now() - t0;
      active++; assetSlotStats.inFlight = active; assetSlotStats.peak = Math.max(assetSlotStats.peak, active);
      try { return await fn(); } finally { active--; assetSlotStats.inFlight = active; waiters.shift()?.(); }
    },
    withDecodeSlot: async (fn: () => Promise<unknown>) => {
      if (dActive >= 16) { await new Promise<void>((r) => dWaiters.push(r)); }
      dActive++; decodeSlotStats.inFlight = dActive; decodeSlotStats.peak = Math.max(decodeSlotStats.peak, dActive);
      try { return await fn(); } finally { dActive--; decodeSlotStats.inFlight = dActive; dWaiters.shift()?.(); }
    },
    decodeSlotStats,
    resetDecodeSlotPeak: () => { decodeSlotStats.peak = decodeSlotStats.inFlight; },
    assetSlotStats,
    assetSourceStats,
    resetAssetSlotPeak: () => { assetSlotStats.peak = assetSlotStats.inFlight; },
    isLazyDollPageKey: (_k: string) => false,
  };
});

import { AtlasManager, defaultImageLoader, imageLoadStats, resetImageLoadStats, setResizeSlicing } from "../src/assets/atlasManager.js";

const json = (p: string) => JSON.parse(readFileSync(PACK_DIR + p, "utf8"));
const spr = (key: string, atlas: string) => ({ key, category: "resource", atlas, animations: { idle: { frames: [0], fps: 1 } } });

/** Pack manifest + one body sheet, so bodyAtlasKeys() is non-empty (ADR-553's count). */
function packWithBody(): AssetRegistry {
  const m = json("manifest.json");
  m.atlases.push({ key: "body_test", image: "atlases/body_test.png", frameW: 32, frameH: 32, columns: 4, rows: 4 });
  m.sprites.push(spr("body_test_sprite", "body_test"));
  return loadManifest(m).registry;
}

function stubGl(): { gl: never; calls: { texStorage3D: number; texSubImage3D: number; generateMipmap: number; texImage2D: number } } {
  const calls = { texStorage3D: 0, texSubImage3D: 0, generateMipmap: 0, texImage2D: 0 };
  let tex = 0;
  const gl = {
    canvas: undefined,
    TEXTURE_2D_ARRAY: 0x8c1a, TEXTURE_2D: 0x0de1, RGBA8: 0x8058, RGBA: 0x1908, RGBA32F: 0x8814,
    UNSIGNED_BYTE: 0x1401, FLOAT: 0x1406, NO_ERROR: 0, OUT_OF_MEMORY: 0x0505,
    CLAMP_TO_EDGE: 0x812f, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
    TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800, TEXTURE_BASE_LEVEL: 0x813c, TEXTURE_MAX_LEVEL: 0x813d,
    LINEAR: 0x2601, LINEAR_MIPMAP_LINEAR: 0x2703, NEAREST: 0x2600,
    MAX_TEXTURE_SIZE: 0x0d33, MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241, UNPACK_FLIP_Y_WEBGL: 0x9240,
    getParameter: () => 4096, getError: () => 0, isContextLost: () => false,
    createTexture: () => ({ id: ++tex }), deleteTexture: () => {},
    bindTexture: () => {}, texParameteri: () => {}, pixelStorei: () => {},
    texStorage3D: () => { calls.texStorage3D++; },
    texSubImage3D: () => { calls.texSubImage3D++; },
    texSubImage2D: () => {},
    texImage2D: () => { calls.texImage2D++; },
    generateMipmap: () => { calls.generateMipmap++; },
  };
  return { gl: gl as never, calls };
}

afterEach(() => { vi.unstubAllGlobals(); setResizeSlicing(true); });

describe("ADR-548 rebuildTimings sub-splits (real setRegistry, stub GL)", () => {
  it("upload / fitBudget sub-fields sum to their parents; fetch splits + cold bytes + body pages present", async () => {
    vi.stubGlobal("createImageBitmap", async (_src: unknown, opts?: { resizeWidth?: number; resizeHeight?: number }) => {
      await new Promise((r) => setTimeout(r, 2));
      return { width: opts?.resizeWidth ?? 128, height: opts?.resizeHeight ?? 128, close: () => {} };
    });
    setResizeSlicing(false); // boot disables the ADR-190 slicer around the initial setRegistry
    const reg = packWithBody();
    const { gl, calls } = stubGl();
    // 2 MB budget at 256 px layers forces the hot tier down, so fitBudget resizes run; the 4
    // resident-cold pack atlases (critters / vfx_fire_big / vfx_fire_huge / se_death_bag) stay cold
    // (the season_huge pair matches COLD too but streams, and resources_huge is pinned hot).
    const am = new AtlasManager(gl, new AssetManager(), { textureBudgetMB: 2, layerSize: 256, imageLoader: defaultImageLoader }) as any;
    const sources = new Map([...reg.atlases.values()].map((a) => [a.key, { url: `atlases/${a.key}.png`, emissiveUrl: null }]));
    const t0 = performance.now();
    await am.setRegistry(reg, sources);
    const wallMs = performance.now() - t0;
    const rt = am.rebuildTimings;
    expect(rt).toBeDefined();
    console.log(`[adr548] rebuild on real pack manifest (${reg.atlases.size} atlases): wall ${wallMs.toFixed(1)}ms ` +
      `fetchDecode ${rt.fetchDecode.toFixed(1)}ms (fetch ${rt.fetchDecodeFetch.toFixed(1)} / decode ${rt.fetchDecodeDecode.toFixed(1)}) · ` +
      `fitBudget ${rt.fitBudget.toFixed(1)}ms (search ${rt.fitBudgetSearch.toFixed(1)} / resizes ${rt.fitBudgetResizes.toFixed(1)}) · ` +
      `upload ${rt.upload.toFixed(1)}ms (alloc ${rt.uploadAlloc.toFixed(1)} / copies ${rt.uploadCopies.toFixed(1)} / mips ${rt.uploadMips.toFixed(1)}) · ` +
      `cold ${(rt.coldAtlasBytes / 1048576).toFixed(2)} MB · body pages ${rt.bodyPages} · ` +
      `GL texStorage3D x${calls.texStorage3D} texSubImage3D x${calls.texSubImage3D} generateMipmap x${calls.generateMipmap}`);
    // Parents keep their old meaning (all eight still present).
    for (const k of ["fetchDecode", "fitBudget", "halveSide", "layout", "upload", "tables", "bodies", "restore"]) {
      expect(typeof rt[k], k).toBe("number"); expect(rt[k]).toBeGreaterThanOrEqual(0);
    }
    // Upload: alloc + copies + mips sum to the parent (the OOM-retry scaleList/layout between
    // re-uploads stays under `upload` only — it never runs here: the stub GL never reports OOM).
    // Tolerance is the outer-wall gap (limitProblem / OOM check between the inner marks and the
    // wall read) — it can stretch when the box is descheduled under parallel load; the sums
    // themselves are exact by construction (copies is the residual).
    expect(Math.abs(rt.upload - (rt.uploadAlloc + rt.uploadCopies + rt.uploadMips))).toBeLessThanOrEqual(25);
    expect(rt.uploadAlloc).toBeGreaterThanOrEqual(0); expect(rt.uploadCopies).toBeGreaterThan(0); expect(rt.uploadMips).toBeGreaterThanOrEqual(0);
    expect(calls.texStorage3D).toBeGreaterThan(0); expect(calls.texSubImage3D).toBeGreaterThan(0); expect(calls.generateMipmap).toBeGreaterThan(0);
    // fitBudget: search + resizes sum to the parent; the 2 MB budget forces real resizes.
    // (Same outer-wall-gap tolerance as the upload sum above.)
    expect(Math.abs(rt.fitBudget - (rt.fitBudgetSearch + rt.fitBudgetResizes))).toBeLessThanOrEqual(25);
    expect(rt.fitBudgetSearch).toBeGreaterThan(0); expect(rt.fitBudgetResizes).toBeGreaterThan(0);
    expect(am.downscale).toBeLessThan(1);
    // fetchDecode: summed per-call durations (concurrent loads overlap), so the sum apportions
    // work rather than wall time — it must cover the wall time, not equal it.
    expect(rt.fetchDecodeFetch).toBeGreaterThan(0); expect(rt.fetchDecodeDecode).toBeGreaterThan(0);
    expect(rt.fetchDecodeFetch + rt.fetchDecodeDecode).toBeGreaterThanOrEqual(rt.fetchDecode);
    // ADR-557: slot-wait / load count / source split / in-flight peak + resize chain split.
    console.log(`[adr557] loads ${rt.fetchDecodeLoads} (cache ${rt.fetchDecodeCacheHits} / network ${rt.fetchDecodeNetwork}) · slot wait ${rt.fetchDecodeWait.toFixed(1)}ms · slot peak ${rt.fetchDecodePeak} · resize chain wait ${rt.resizeChainWait.toFixed(1)}ms / run ${rt.resizeChainRun.toFixed(1)}ms`);
    expect(rt.fetchDecodeLoads).toBeGreaterThan(0);
    expect(rt.fetchDecodeCacheHits).toBe(0); // the mock has no Cache Storage — everything is network
    expect(rt.fetchDecodeNetwork).toBe(rt.fetchDecodeLoads); // each mock load fetched exactly once and succeeded
    expect(rt.fetchDecodeWait).toBeGreaterThan(0); // hundreds of ~4 ms loads through 8 slots must queue
    expect(rt.fetchDecodePeak).toBeGreaterThan(1); expect(rt.fetchDecodePeak).toBeLessThanOrEqual(8);
    // ADR-559: decodes ran under the separate decode cap (16), never on the fetch slots.
    expect(rt.fetchDecodeDecodePeak).toBeGreaterThan(0); expect(rt.fetchDecodeDecodePeak).toBeLessThanOrEqual(16);
    // wait + fetch + decode is the summed per-load lifecycle: it must cover the fetchDecode wall,
    // exactly as ADR-548's fetch + decode alone did.
    expect(rt.fetchDecodeWait + rt.fetchDecodeFetch + rt.fetchDecodeDecode).toBeGreaterThanOrEqual(rt.fetchDecode);
    expect(rt.resizeChainRun).toBeGreaterThan(0); // the crushed budget ran real resizes through sliced()
    expect(rt.resizeChainWait).toBeGreaterThanOrEqual(0);
    // Cold-atlas bytes + body-page count (ADR-552/553 sizing inputs). ADR-553: bodyPages is the
    // eager count at this rebuild — no local body type is set here (boot: no appearance exists
    // yet), so no body page is eager and the count is 0; the fixture's one body page is deferred
    // to prio-0-on-first-draw / the drain.
    expect(rt.coldAtlasBytes).toBeGreaterThan(0);
    expect(rt.bodyPages).toBe(0);
    expect(am.vramStats.coldAtlasBytes).toBe(rt.coldAtlasBytes);
    expect(am.vramStats.bodyPages).toBe(rt.bodyPages);
    expect(am.vramStats.coldAtlases).toBeGreaterThan(0);
    // Same registry at a generous budget (1x, no resizes): the cold byte share at full scale — the
    // number ADR-552 sizes against. Every stub image is 128x128, so it must be exactly
    // coldCount x 64 KiB; the crushed-budget run above is only 4 KiB because everything sat at 0.125.
    am.textureBudgetMB = 256;
    await am.setRegistry(reg, sources);
    const rt1x = am.rebuildTimings;
    const cold1x = rt1x.coldAtlasBytes, coldCount1x = am.vramStats.coldAtlases;
    const resident1x = am.vramStats.hotAtlases + coldCount1x;
    console.log(`[adr548] same registry at 256 MB (1x): cold ${coldCount1x}/${resident1x} atlases, ${(cold1x / 1048576).toFixed(2)} MB of ${(resident1x * 65536 / 1048576).toFixed(2)} MB resident decoded bytes`);
    expect(coldCount1x).toBeGreaterThan(0);
    expect(cold1x).toBe(coldCount1x * 128 * 128 * 4);
    expect(Math.abs(rt1x.fitBudget - (rt1x.fitBudgetSearch + rt1x.fitBudgetResizes))).toBeLessThanOrEqual(25);
    expect(Math.abs(rt1x.upload - (rt1x.uploadAlloc + rt1x.uploadCopies + rt1x.uploadMips))).toBeLessThanOrEqual(25);
  }, 60000);

  it("ADR-557 fields are zero-filled when no defaultImageLoader loads run (custom imageLoader)", async () => {
    vi.stubGlobal("createImageBitmap", async (_src: unknown, opts?: { resizeWidth?: number; resizeHeight?: number }) => ({ width: opts?.resizeWidth ?? 128, height: opts?.resizeHeight ?? 128, close: () => {} }));
    const reg = packWithBody();
    const { gl } = stubGl();
    // A custom imageLoader bypasses defaultImageLoader (and withAssetSlot) entirely, and the
    // generous budget runs no resizes — every ADR-557 field must read exactly 0, not undefined.
    const am = new AtlasManager(gl, new AssetManager(), { textureBudgetMB: 256, layerSize: 256, imageLoader: async () => ({ width: 128, height: 128, close: () => {} }) as never }) as any;
    const sources = new Map([...reg.atlases.values()].map((a) => [a.key, { url: `atlases/${a.key}.png`, emissiveUrl: null }]));
    await am.setRegistry(reg, sources);
    const rt = am.rebuildTimings;
    expect(rt).toBeDefined();
    for (const k of ["fetchDecodeWait", "fetchDecodeLoads", "fetchDecodeCacheHits", "fetchDecodeNetwork", "fetchDecodePeak", "resizeChainWait", "resizeChainRun", "fetchDecodeDecodePeak"]) {
      expect(rt[k], k).toBe(0);
    }
  }, 60000);

  it("defaultImageLoader accumulates fetch vs decode in imageLoadStats (and reset clears it)", async () => {
    vi.stubGlobal("createImageBitmap", async (_src: unknown) => {
      await new Promise((r) => setTimeout(r, 2));
      return { width: 128, height: 128, close: () => {} };
    });
    resetImageLoadStats();
    const img = await defaultImageLoader("atlases/characters.png");
    expect(img.width).toBe(128);
    expect(imageLoadStats.loads).toBe(1);
    expect(imageLoadStats.fetchMs).toBeGreaterThan(0);
    expect(imageLoadStats.decodeMs).toBeGreaterThan(0);
    resetImageLoadStats();
    expect(imageLoadStats).toEqual({ fetchMs: 0, decodeMs: 0, loads: 0 });
  });
});
