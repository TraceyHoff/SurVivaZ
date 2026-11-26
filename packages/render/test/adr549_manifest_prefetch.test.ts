// ADR-549: prefetch expands the customization shard index and warms the shards + ids.lock
// (fetch + gunzip only, no JSON.parse) during bundle load, so view.ts's manifest load starts
// from Cache Storage hits instead of paying cold-cache round-trips.
import { afterEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { assetJsonGz, collectShardManifestUrls, resetAssetFetchForTests, warmManifestGz } from "../src/assets/asset-fetch.js";

const ART = "https://x/art/";
const CATS = ["top", "hair", "hat", "bottom", "shoes", "gloves", "coat", "dress", "belt", "base"];
const SHARD_URLS = CATS.map((c) => `${ART}pack/customization/manifest.customization.${c}.json`);
const LOCK_URL = `${ART}pack/ids.lock.json`;
const INDEX = { version: 2, name: "customization", shards: CATS.map((c) => ({ category: c, file: `manifest.customization.${c}.json`, bytes: 0, sha: "" })) };

describe("ADR-549 manifest prefetch", () => {
  afterEach(() => { vi.unstubAllGlobals(); resetAssetFetchForTests(); });
  const stubCache = (): Map<string, Response> => {
    const store = new Map<string, Response>();
    vi.stubGlobal("caches", { open: async () => ({ match: async (u: string) => store.get(u)?.clone(), put: async (u: string, r: Response) => { store.set(String(u), r); } }), keys: async () => [], delete: async () => true });
    return store;
  };

  it("collectShardManifestUrls expands a v2 index to its shard urls (v1 → [])", () => {
    expect(collectShardManifestUrls(INDEX, `${ART}pack/customization/manifest.customization.json`)).toEqual(SHARD_URLS);
    expect(collectShardManifestUrls({ version: 1, name: "pack", atlases: [] }, `${ART}pack/manifest.json`)).toEqual([]);
    expect(collectShardManifestUrls(null, `${ART}pack/manifest.json`)).toEqual([]);
  });

  it("warmManifestGz stores decoded text without parsing (invalid JSON warms fine)", async () => {
    const store = stubCache();
    const seen: string[] = [];
    const url = SHARD_URLS[0]!;
    const text = "{not json";
    vi.stubGlobal("fetch", async (u: string) => { seen.push(String(u)); return new Response(gzipSync(text)); });
    await warmManifestGz([url]);
    expect(seen).toEqual([`${url}.gz`]);
    await new Promise((r) => setTimeout(r, 0));
    expect(await store.get(url)!.clone().text()).toBe(text);
    // A second warm is a cache hit, not a refetch.
    await warmManifestGz([url]);
    expect(seen).toEqual([`${url}.gz`]);
  });

  it("warmManifestGz swallows a fetch failure and still warms the rest (best-effort)", async () => {
    const store = stubCache();
    const good = SHARD_URLS[1]!;
    vi.stubGlobal("fetch", async (u: string) => {
      if (String(u).includes("customization.top")) throw new Error("network down");
      return new Response(gzipSync(JSON.stringify({ version: 1, name: "hair" })));
    });
    await expect(warmManifestGz([SHARD_URLS[0]!, good])).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(await store.get(good)!.clone().text()).toBe(JSON.stringify({ version: 1, name: "hair" }));
  });

  it("cold-cache simulation: shards + ids.lock are fetched by the prefetch path before the manifest load, which then reads them from cache with no further fetch", async () => {
    const store = stubCache();
    const seen: string[] = [];
    const bodies = new Map<string, string>();
    for (let i = 0; i < CATS.length; i++) bodies.set(SHARD_URLS[i]!, JSON.stringify({ version: 1, name: `shard-${CATS[i]}`, atlases: [], sprites: [] }));
    bodies.set(LOCK_URL, JSON.stringify({ lock: true }));
    vi.stubGlobal("fetch", async (u: string) => {
      seen.push(String(u));
      const body = bodies.get(String(u).replace(/\.gz$/, ""));
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(gzipSync(body));
    });
    // Prefetch path (what prefetch-art.ts does during bundle load): expand the index, warm the
    // shards + ids.lock — fetch + gunzip only, no JSON.parse.
    const shardUrls = collectShardManifestUrls(INDEX, `${ART}pack/customization/manifest.customization.json`);
    await warmManifestGz([...shardUrls, LOCK_URL]);
    expect(seen).toEqual([...SHARD_URLS, LOCK_URL].map((u) => `${u}.gz`));
    await new Promise((r) => setTimeout(r, 0));
    // view.ts's manifest load starts now: every shard + the lock read from Cache Storage.
    for (let i = 0; i < CATS.length; i++) {
      expect(await assetJsonGz(SHARD_URLS[i]!)).toEqual({ version: 1, name: `shard-${CATS[i]}`, atlases: [], sprites: [] });
    }
    expect(await assetJsonGz(LOCK_URL)).toEqual({ lock: true });
    expect(seen).toEqual([...SHARD_URLS, LOCK_URL].map((u) => `${u}.gz`));
    expect(store.size).toBe(SHARD_URLS.length + 1);
  });
});
