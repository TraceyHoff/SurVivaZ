import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { AssetManager } from "@engine/core";
import { loadManifest, type AssetRegistry } from "@engine/assets";
import { PACK_DIR } from "@engine/assets/node";

/**
 * ADR-558: decode at final scale. The resident load fetches blobs + PNG IHDR dims first, runs the
 * fitBudget search on the dims, and decodes each demoted image ONCE at its final size with exactly
 * the createImageBitmap resize options resizeImage uses today — instead of a full-size decode in
 * registry.fetch plus a second serial resize in fitBudget's scaleList pass.
 *
 * Pixel identity (user ruling: hash proof alone, the ADR-551 standard) is proven with a stub
 * decoder whose resampling is a pure function of (source pixels, target dims, quality): the
 * legacy route (decode full, then resizeImage) and the new route (decodeImageBlob with resize
 * options) must produce SHA-256-identical pixels for colour / emissive ("high") and masks
 * ("pixelated") at hot x0.5 and cold x0.125. The stub models the browser's one relevant property:
 * both routes make the SAME createImageBitmap resize call with the SAME options.
 *
 * The rebuild tests mock asset-fetch like adr548 (real 8-wide slot semaphore + stats) but serve
 * fixture PNG blobs (real IHDR header for 128x128 + payload), so pngImageDims succeeds and the
 * decode-at-scale path actually engages — adr548's 4-byte blobs stay on the legacy path there.
 */
vi.mock("../src/assets/asset-fetch.js", () => {
  const assetSlotStats = { waitMs: 0, waits: 0, inFlight: 0, peak: 0 };
  const assetSourceStats = { cacheHits: 0, networkFetches: 0 };
  let active = 0; const waiters: Array<() => void> = [];
  const decodeSlotStats = { inFlight: 0, peak: 0 };
  let dActive = 0; const dWaiters: Array<() => void> = [];
  const header = new Uint8Array(33);
  header.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  header.set([0, 0, 0, 13], 8); header.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  new DataView(header.buffer).setUint32(16, 128); new DataView(header.buffer).setUint32(20, 128);
  const fixture = new Blob([header, new Uint8Array(128 * 128 * 4)], { type: "image/png" });
  return {
    assetFetch: async (_url: string) => {
      assetSourceStats.networkFetches++;
      return { ok: true, status: 200, blob: async () => fixture };
    },
    assetBytes: async (_url: string) => new ArrayBuffer(8),
    withAssetSlot: async (fn: () => Promise<unknown>) => {
      const t0 = performance.now();
      if (active >= 8) { assetSlotStats.waits++; await new Promise<void>((r) => waiters.push(r)); }
      assetSlotStats.waitMs += performance.now() - t0;
      active++; assetSlotStats.inFlight = active; assetSlotStats.peak = Math.max(assetSlotStats.peak, active);
      try { return await fn(); } finally { active--; assetSlotStats.inFlight = active; waiters.shift()?.(); }
    },
    // ADR-559: decodeImageBlob now runs under the decode cap, not an asset slot — the mock
    // decode slot is a real 16-wide semaphore (production cap) with the same stats shape.
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

import {
  AtlasManager, decodeImageBlob, decodeScaleStats, defaultImageLoader, pngImageDims, resetDecodeScaleStats,
  resizeImage, resizeStats, setResizeSlicing, type ImageLike,
} from "../src/assets/atlasManager.js";

/* ---------------------------------- fixture pixels ---------------------------------- */

function fixtureBlob(w: number, h: number, seed: number): Blob {
  const head = new Uint8Array(33);
  head.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  head.set([0, 0, 0, 13], 8); head.set([0x49, 0x48, 0x44, 0x52], 12);
  const dv = new DataView(head.buffer); dv.setUint32(16, w); dv.setUint32(20, h);
  const px = new Uint8Array(w * h * 4);
  let s = seed >>> 0;
  for (let i = 0; i < px.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; px[i] = (s >>> 16) & 0xff; }
  return new Blob([head, px], { type: "image/png" });
}

type FakeImg = { width: number; height: number; close: () => void };
const pxOf = new WeakMap<object, Uint8Array>();
const decodeLog: { blob: boolean; resize: [number, number] | null; quality: string | undefined }[] = [];

/** Deterministic resample: "pixelated" = nearest, "high" = integer-block box average. */
function resample(px: Uint8Array, w: number, h: number, nw: number, nh: number, q: string): Uint8Array {
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    const o = (y * nw + x) * 4;
    if (q === "pixelated") {
      const sx = Math.floor(x * w / nw), sy = Math.floor(y * h / nh), so = (sy * w + sx) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = px[so + c]!;
    } else {
      const bw = w / nw, bh = h / nh; const acc: [number, number, number, number] = [0, 0, 0, 0];
      for (let yy = 0; yy < bh; yy++) for (let xx = 0; xx < bw; xx++) { const so = ((y * bh + yy) * w + x * bw + xx) * 4; for (let c = 0; c < 4; c++) acc[c] = acc[c]! + px[so + c]!; }
      for (let c = 0; c < 4; c++) out[o + c] = Math.round(acc[c]! / (bw * bh));
    }
  }
  return out;
}

function stubDecoder(): void {
  decodeLog.length = 0;
  vi.stubGlobal("createImageBitmap", async (src: unknown, opts?: { resizeWidth?: number; resizeHeight?: number; resizeQuality?: string }) => {
    let w = 0, h = 0, px: Uint8Array;
    const isBlob = src instanceof Blob;
    if (isBlob) {
      const buf = new Uint8Array(await (src as Blob).arrayBuffer());
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      w = dv.getUint32(16); h = dv.getUint32(20); px = buf.slice(33, 33 + w * h * 4);
    } else {
      const im = src as FakeImg; w = im.width; h = im.height; px = pxOf.get(im)!;
    }
    decodeLog.push({ blob: isBlob, resize: opts?.resizeWidth ? [opts.resizeWidth, opts.resizeHeight!] : null, quality: opts?.resizeQuality });
    let out: FakeImg;
    if (opts?.resizeWidth) {
      out = { width: opts.resizeWidth, height: opts.resizeHeight!, close: () => {} };
      pxOf.set(out, resample(px, w, h, out.width, out.height, opts.resizeQuality ?? "high"));
    } else {
      out = { width: w, height: h, close: () => {} };
      pxOf.set(out, px);
    }
    return out;
  });
}

const sha = (im: unknown): string => createHash("sha256").update(pxOf.get(im as object)!).digest("hex");

afterEach(() => { vi.unstubAllGlobals(); setResizeSlicing(true); });

describe("ADR-558 pngImageDims (IHDR without decode)", () => {
  it("reads dims from the header; rejects non-PNG and truncated blobs", async () => {
    expect(await pngImageDims(fixtureBlob(64, 48, 1))).toEqual({ width: 64, height: 48 });
    expect(await pngImageDims(new Blob([new Uint8Array([137, 80, 78, 71])]))).toBeNull(); // adr548's 4-byte mock shape
    expect(await pngImageDims(new Blob([new Uint8Array(64).fill(7)]))).toBeNull();
  });
});

describe("ADR-558 pixel identity: decode-at-scale vs decode-then-resize (SHA-256)", () => {
  const classes: { name: string; q: "high" | "pixelated"; seed: number }[] = [
    { name: "colour", q: "high", seed: 11 },
    { name: "emissive", q: "high", seed: 23 },
    { name: "mask", q: "pixelated", seed: 37 },
  ];
  for (const cls of classes) for (const k of [0.5, 0.125]) {
    it(`${cls.name} at x${k}: identical hash, one scaled decode, no full decode on the new route`, async () => {
      stubDecoder(); setResizeSlicing(false); resetDecodeScaleStats();
      const blob = fixtureBlob(64, 48, cls.seed);
      const tw = Math.max(1, Math.floor(64 * k)), th = Math.max(1, Math.floor(48 * k));
      // Legacy route: full-size decode, then the resizeImage pass fitBudget used to run.
      const full = await decodeImageBlob(blob);
      const legacy = await resizeImage(full as ImageLike, tw, th, cls.q);
      const legacyHash = sha(legacy);
      // New route: ONE decode, at final size, same options.
      const logBefore = decodeLog.length;
      const scaled = await decodeImageBlob(blob, { w: tw, h: th, q: cls.q });
      const scaledHash = sha(scaled);
      console.log(`[adr558] ${cls.name} x${k}: legacy ${legacyHash.slice(0, 16)}… scaled ${scaledHash.slice(0, 16)}… identical=${legacyHash === scaledHash}`);
      expect(scaledHash).toBe(legacyHash);
      expect(scaled.width).toBe(tw); expect(scaled.height).toBe(th);
      // The new route made exactly one decode call, with resize opts at the target dims + quality.
      const newCalls = decodeLog.slice(logBefore);
      expect(newCalls).toEqual([{ blob: true, resize: [tw, th], quality: cls.q }]);
      expect(decodeScaleStats.scaled).toBe(1); // only the new route's decode counts as scaled
      expect(decodeScaleStats.full).toBe(1); // the legacy route's full decode
    });
  }
});

/* ---------------------------------- rebuild harness ---------------------------------- */

const json = (p: string) => JSON.parse(readFileSync(PACK_DIR + p, "utf8"));
function stubGl(): { gl: never } {
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
    texStorage3D: () => {}, texSubImage3D: () => {}, texSubImage2D: () => {}, texImage2D: () => {},
    generateMipmap: () => {},
  };
  return { gl: gl as never };
}

type RT = { key: string; lazy?: unknown; img: { width: number; height: number } | null; scale: number; preScaled?: boolean; fitK?: number; trim?: unknown };

async function rebuild(budgetMB: number): Promise<{ am: any; reg: AssetRegistry }> {
  vi.stubGlobal("createImageBitmap", async (src: unknown, opts?: { resizeWidth?: number; resizeHeight?: number }) => {
    if (src instanceof Blob) {
      const buf = new Uint8Array(await src.arrayBuffer());
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      return { width: opts?.resizeWidth ?? dv.getUint32(16), height: opts?.resizeHeight ?? dv.getUint32(20), close: () => {} };
    }
    return { width: opts?.resizeWidth ?? 128, height: opts?.resizeHeight ?? 128, close: () => {} };
  });
  setResizeSlicing(false);
  const reg = loadManifest(json("manifest.json")).registry;
  const { gl } = stubGl();
  const am = new AtlasManager(gl, new AssetManager(), { textureBudgetMB: budgetMB, layerSize: 256, imageLoader: defaultImageLoader }) as any;
  const sources = new Map([...reg.atlases.values()].map((a) => [a.key, { url: `atlases/${a.key}.png`, emissiveUrl: null }]));
  await am.setRegistry(reg, sources);
  return { am, reg };
}

describe("ADR-558 rebuild: demoted atlases decode once at final scale", () => {
  it("crushed budget: preScaled atlases arrive at floor(128 * fitK), resize pass does no work for them, trim atlases stay legacy", async () => {
    resetDecodeScaleStats();
    const runs0 = resizeStats.runs;
    const { am } = await rebuild(2);
    const resident = (am.atlases as RT[]).filter((a) => !a.lazy);
    const pre = resident.filter((a) => a.preScaled);
    const demoted = resident.filter((a) => (a.fitK ?? 1) < 1);
    console.log(`[adr558] resident ${resident.length}, demoted ${demoted.length}, preScaled ${pre.length}, scaled decodes ${decodeScaleStats.scaled}, full decodes ${decodeScaleStats.full}, resize runs ${resizeStats.runs - runs0}`);
    expect(demoted.length).toBeGreaterThan(0);
    expect(pre.length).toBeGreaterThan(0);
    // Every preScaled atlas: exactly the dims a scaleList resize would have produced.
    for (const a of pre) {
      expect(a.img!.width, a.key).toBe(Math.max(1, Math.floor(128 * a.fitK!)));
      expect(a.img!.height, a.key).toBe(Math.max(1, Math.floor(128 * a.fitK!)));
      expect(a.scale, a.key).toBe(a.fitK);
    }
    // One scaled decode per preScaled atlas (sources carry colour only: no emissive, no masks).
    expect(decodeScaleStats.scaled).toBe(pre.length);
    // Trim-eligible atlases (BASE_PIN set: openings / furniture / decor / defenses …) are NEVER
    // preScaled — they decode full-size and the resize pass handles them, exactly as before.
    const trimKeys = resident.filter((a) => /^(openings|furniture|decor|buildings_twig|defenses|defenses_glow)$/.test(a.key));
    expect(trimKeys.length).toBeGreaterThan(0);
    for (const a of trimKeys) expect(a.preScaled, a.key).toBeFalsy();
    // The resize pass ran ONLY for demoted non-preScaled atlases: runs == their colour count
    // (no emissive/masks in these sources), never for a preScaled one.
    const legacyDemoted = demoted.filter((a) => !a.preScaled);
    expect(resizeStats.runs - runs0).toBe(legacyDemoted.length);
    // fitBudget split still sums: resizes now cover only the legacy remainder.
    const rt = am.rebuildTimings;
    expect(Math.abs(rt.fitBudget - (rt.fitBudgetSearch + rt.fitBudgetResizes))).toBeLessThanOrEqual(25);
    expect(rt.fetchDecodeLoads).toBeGreaterThan(0);
  }, 60000);

  it("generous budget (all fitK = 1): scale-1 exclusion — no scaled decode, no preScaled atlas", async () => {
    resetDecodeScaleStats();
    const { am: am2 } = await rebuild(256);
    const resident = (am2.atlases as RT[]).filter((a) => !a.lazy);
    expect(resident.every((a) => (a.fitK ?? 1) === 1)).toBe(true);
    expect(resident.some((a) => a.preScaled)).toBe(false);
    expect(decodeScaleStats.scaled).toBe(0);
    expect(decodeScaleStats.full).toBeGreaterThan(0); // every resident image decoded the legacy way
  }, 60000);
});
