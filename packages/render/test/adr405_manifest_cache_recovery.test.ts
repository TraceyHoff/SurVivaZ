// ADR-405: a poisoned Cache Storage entry under a manifest URL must heal, not fail every boot.
// One bad write (a 200 with an error body, a flap during deploy) used to make `assetJsonGz` return
// undefined for that shard forever, so the boot failed with "manifest shard missing" on every reload
// (reproduced live in Chrome: a garbage entry under the hat shard URL shows exactly the phone's
// [E-1AC6] overlay on load #1 and again after a reload). Real failures (503, cut connection, corrupt
// gzip, unparsable JSON) must now throw with the cause instead of reading as "missing".
import { afterEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { assetJsonGz, dropAssetCacheEntry, resetAssetFetchForTests } from "../src/assets/asset-fetch.js";

const URL = "https://x/art/pack/customization/manifest.customization.hat.json";
const JSON_TEXT = JSON.stringify({ version: 2, name: "customization", shards: [] });
const gz = (t: string): Response => new Response(gzipSync(t));

describe("ADR-405 manifest cache recovery", () => {
  afterEach(() => { vi.unstubAllGlobals(); resetAssetFetchForTests(); });
  const stubCache = (seed?: [string, string][]): Map<string, Response> => {
    const store = new Map<string, Response>(seed?.map(([u, t]) => [u, new Response(t)] as [string, Response]) ?? []);
    vi.stubGlobal("caches", {
      open: async () => ({
        match: async (u: string) => store.get(String(u))?.clone(),
        put: async (u: string, r: Response) => { store.set(String(u), r); },
        delete: async (u: string) => store.delete(String(u)),
      }),
      keys: async () => [], delete: async () => true,
    });
    return store;
  };

  it("poisoned cache entry heals: garbage under the URL is evicted, the .gz is refetched, the cache holds valid JSON", async () => {
    const store = stubCache([[URL, "NOT JSON {{{ garbage"]]);
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => { seen.push(u); return gz(JSON_TEXT); });
    expect(await assetJsonGz(URL)).toEqual({ version: 2, name: "customization", shards: [] });
    expect(seen).toEqual([`${URL}.gz`]);
    await new Promise((r) => setTimeout(r, 0));
    expect(await store.get(URL)!.clone().json()).toEqual({ version: 2, name: "customization", shards: [] });
  });

  it("poisoned cache entry + network 404 on retry -> undefined (genuinely missing, not a crash)", async () => {
    stubCache([[URL, "garbage"]]);
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
    expect(await assetJsonGz(URL, { retryDelays: [0, 0] })).toBeUndefined();
  });

  it("poisoned cache entry + network garbage -> throws with the URL, not undefined", async () => {
    stubCache([[URL, "garbage"]]);
    vi.stubGlobal("fetch", async () => new Response("still not json"));
    await expect(assetJsonGz(URL)).rejects.toThrow(/manifest JSON parse failed: .*hat\.json/);
  });

  it("fetch failures are retried once bypassing the caches, then the real error surfaces", async () => {
    stubCache();
    let calls = 0;
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
      calls++;
      if (init?.cache === "reload") return gz(JSON_TEXT);
      throw new Error("flap");
    });
    expect(await assetJsonGz(URL)).toEqual({ version: 2, name: "customization", shards: [] });
    expect(calls).toBe(3); // force-cache throw, plain throw, reload success
  });

  it("a 503 on every attempt throws (never reads as 'missing')", async () => {
    stubCache();
    vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
    await expect(assetJsonGz(URL)).rejects.toThrow(/manifest load failed: .*hat\.json/);
  });

  it("a stale cached 404 heals via the cache-bypassing reload fetch", async () => {
    stubCache();
    const seen: (string | undefined)[] = [];
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
      seen.push(init?.cache);
      return init?.cache === "reload" ? gz(JSON_TEXT) : new Response("", { status: 404 });
    });
    expect(await assetJsonGz(URL)).toEqual({ version: 2, name: "customization", shards: [] });
    expect(seen).toEqual(["force-cache", undefined, "reload"]);
  });

  it("a genuine 404 on every attempt (including reload, delayed and cache-busting retries) is still undefined", async () => {
    stubCache();
    const seen: (string | undefined)[] = [];
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => { seen.push(init?.cache); return new Response("", { status: 404 }); });
    expect(await assetJsonGz(URL, { retryDelays: [0, 0] })).toBeUndefined();
    // ADR-406: the schedule is now force-cache, default, reload, delayed no-store, cache-busting no-store
    expect(seen).toEqual(["force-cache", undefined, "reload", "no-store", "no-store"]);
  });

  it("dropAssetCacheEntry removes one entry and leaves the rest", async () => {
    const store = stubCache([[URL, '{"a":1}'], ["https://x/art/other.json", '{"b":2}']]);
    await dropAssetCacheEntry(URL);
    expect(store.has(URL)).toBe(false);
    expect(store.has("https://x/art/other.json")).toBe(true);
  });
});
