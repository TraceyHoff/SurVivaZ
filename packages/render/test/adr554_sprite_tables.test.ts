import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { AssetManager } from "@engine/core";
import { loadManifest, type AssetRegistry } from "@engine/assets";
import { PACK_DIR } from "@engine/assets/node";

/**
 * ADR-554(b): sprite tables are cached across rebuilds with an unchanged registry.
 *
 * buildSpriteTables is pure given (registry, list) and SpriteRT is scale-independent (no scale
 * or UV — UVs are computed in writeFrames from a.scale at upload), so a re-tier / preset-change /
 * context-restore rebuild with the same registry object and the same atlas-id list reuses the
 * cached SpriteRT array (reference equality). A different registry object rebuilds (new
 * reference, same values). frameTintRows is NOT cached: its keys are at.base + f and bases move
 * with every repack — it still runs on every rebuild.
 */
vi.mock("../src/assets/asset-fetch.js", () => ({
  assetFetch: async (_url: string) => ({
    ok: true, status: 200,
    blob: async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
  }),
  assetBytes: async (_url: string) => new ArrayBuffer(8),
  withAssetSlot: (fn: () => Promise<unknown>) => fn(),
  isLazyDollPageKey: (_k: string) => false,
}));

import { AtlasManager, defaultImageLoader, setResizeSlicing } from "../src/assets/atlasManager.js";

const json = (p: string) => JSON.parse(readFileSync(PACK_DIR + p, "utf8"));

function stubGl(): never {
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
    texStorage3D: () => {}, texSubImage3D: () => {}, texSubImage2D: () => {},
    texImage2D: () => {}, generateMipmap: () => {},
  };
  return gl as never;
}

afterEach(() => { vi.unstubAllGlobals(); setResizeSlicing(true); });

describe("ADR-554(b): sprite tables cached across rebuilds", () => {
  it("same registry object reuses the cached SpriteRT array; a changed registry rebuilds with the same values", async () => {
    vi.stubGlobal("createImageBitmap", async (_src: unknown, opts?: { resizeWidth?: number; resizeHeight?: number }) => {
      return { width: opts?.resizeWidth ?? 128, height: opts?.resizeHeight ?? 128, close: () => {} };
    });
    setResizeSlicing(false);
    const reg: AssetRegistry = loadManifest(json("manifest.json")).registry;
    const gl = stubGl();
    const am = new AtlasManager(gl, new AssetManager(), { textureBudgetMB: 256, layerSize: 256, imageLoader: defaultImageLoader }) as any;
    const sources = new Map([...reg.atlases.values()].map((a) => [a.key, { url: `atlases/${a.key}.png`, emissiveUrl: null }]));

    const t0 = performance.now();
    await am.setRegistry(reg, sources);
    const firstMs = performance.now() - t0;
    const first = am.sprites as unknown[];
    expect(first.filter(Boolean).length).toBeGreaterThan(0);
    expect(first.filter(Boolean).length).toBe(am.stats.sprites);
    const tables1 = am.rebuildTimings.tables;

    // Same registry object, same atlas-id list: the second rebuild reuses the cached array.
    const t1 = performance.now();
    await am.setRegistry(reg, sources);
    const secondMs = performance.now() - t1;
    const second = am.sprites as unknown[];
    expect(second).toBe(first);
    const tables2 = am.rebuildTimings.tables;
    console.log(`[adr554] same-registry rebuild: tables ${tables1.toFixed(1)}ms -> ${tables2.toFixed(1)}ms (wall ${firstMs.toFixed(1)}ms -> ${secondMs.toFixed(1)}ms)`);

    // A different registry object — same manifest content — rebuilds: new array, same values.
    const reg2: AssetRegistry = loadManifest(json("manifest.json")).registry;
    await am.setRegistry(reg2, sources);
    const third = am.sprites as unknown[];
    expect(third).not.toBe(first);
    expect(third).toEqual(first);
    expect(am.stats.sprites).toBe(first.filter(Boolean).length);
  }, 60000);
});
