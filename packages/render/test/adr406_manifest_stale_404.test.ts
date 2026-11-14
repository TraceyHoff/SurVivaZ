// ADR-406: a stale 404 for a manifest shard must not brick a boot.
// Tracey's phone (2026-11-14 ~09:20/09:25 CST, build 76e4b165) shows
// "manifest shard missing: manifest.customization.top.json" [E-5B80] deterministically across
// reloads, on both Wi-Fi and mobile data, 11+ minutes after the Pages deploy finished — the file
// itself is live and valid (200, valid gzip/JSON). ADR-405's loader makes three back-to-back
// attempts against the SAME cache key (force-cache, default, reload) in the same instant: a 404
// stuck in the browser HTTP cache and/or the nearby CDN edge (404s carry an ETag and are cached
// heuristically; a reload revalidates into a 304 and serves the stale 404 again) defeats all three
// identically, and a user reload repeats the identical sequence. The fix: delayed retries with
// `cache: "no-store"`, then a final retry against a cache-busting URL (`?v=<token>`, a fresh cache
// key at every layer — GitHub Pages ignores the query string for static files), and index-listed
// (required) shards THROW with the cause instead of returning undefined.
import { afterEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { assetJsonGz, resetAssetFetchForTests } from "../src/assets/asset-fetch.js";

const URL = "https://x/art/pack/customization/manifest.customization.top.json";
const JSON_TEXT = JSON.stringify({ version: 2, name: "customization", shards: [] });
const gz = (t: string): Response => new Response(gzipSync(t));
const notFound = (): Response => new Response("", { status: 404 });

describe("ADR-406 stale-404 manifest recovery", () => {
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
  it("healthy path unchanged: first fetch succeeds, one force-cache call", async () => {
    stubCache();
    const seen: (string | undefined)[] = [];
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => { seen.push(init?.cache); return gz(JSON_TEXT); });
    expect(await assetJsonGz(URL, { retryDelays: [0, 0] })).toEqual({ version: 2, name: "customization", shards: [] });
    expect(seen).toEqual(["force-cache"]);
  });

  it("stale 404 that clears after the instant attempts heals via the delayed retry", async () => {
    stubCache();
    const seen: (string | undefined)[] = [];
    let calls = 0;
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
      seen.push(init?.cache); calls++;
      return calls <= 3 ? notFound() : gz(JSON_TEXT);
    });
    expect(await assetJsonGz(URL, { retryDelays: [0, 0] })).toEqual({ version: 2, name: "customization", shards: [] });
    // force-cache, default, reload, then the delayed no-store retry that heals
    expect(seen).toEqual(["force-cache", undefined, "reload", "no-store"]);
  });

  it("stale 404 that never clears for the plain key heals via the cache-busting retry", async () => {
    const store = stubCache();
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      urls.push(String(u));
      return String(u).includes("?v=") ? gz(JSON_TEXT) : notFound();
    });
    expect(await assetJsonGz(URL, { retryDelays: [0, 0], bustToken: "boot-1" })).toEqual({ version: 2, name: "customization", shards: [] });
    expect(urls).toContain(`${URL}.gz?v=boot-1`);
    // the healed text is cached under the PLAIN url, so the next boot reads Cache Storage, not the network
    await new Promise((r) => setTimeout(r, 0));
    expect(await store.get(URL)!.clone().json()).toEqual({ version: 2, name: "customization", shards: [] });
  });

  it("genuinely missing shard throws with cause (URL + status + attempts) for a required load", async () => {
    stubCache();
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => { urls.push(String(u)); return notFound(); });
    await expect(assetJsonGz(URL, { required: true, retryDelays: [0, 0], bustToken: "boot-1" }))
      .rejects.toThrow(/manifest\.customization\.top\.json.*HTTP 404 on every fetch attempt/);
    // the full schedule runs first: force-cache, default, reload, delayed no-store, cache-busted no-store
    expect(urls).toHaveLength(5);
    expect(urls[4]).toBe(`${URL}.gz?v=boot-1`);
  });

  it("genuinely missing shard is still undefined for an optional load", async () => {
    stubCache();
    vi.stubGlobal("fetch", async () => notFound());
    expect(await assetJsonGz(URL, { retryDelays: [0, 0] })).toBeUndefined();
  });

  it("poisoned cache entry still heals (ADR-405 behaviour preserved)", async () => {
    const store = stubCache([[URL, "NOT JSON {{{ garbage"]]);
    vi.stubGlobal("fetch", async () => gz(JSON_TEXT));
    expect(await assetJsonGz(URL, { retryDelays: [0, 0] })).toEqual({ version: 2, name: "customization", shards: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(await store.get(URL)!.clone().json()).toEqual({ version: 2, name: "customization", shards: [] });
  });

  it("a 503 on every attempt still throws (never reads as 'missing')", async () => {
    stubCache();
    vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
    await expect(assetJsonGz(URL, { retryDelays: [0, 0] })).rejects.toThrow(/manifest load failed: .*top\.json/);
  });

  it("cacheBustUrl appends a fresh query key (and & when a query already exists)", async () => {
    const { cacheBustUrl } = await import("../src/assets/asset-fetch.js");
    expect(cacheBustUrl("https://x/a.json.gz")).toMatch(/^https:\/\/x\/a\.json\.gz\?v=[0-9a-z-]+$/);
    expect(cacheBustUrl("https://x/a.json.gz?x=1")).toMatch(/^https:\/\/x\/a\.json\.gz\?x=1&v=[0-9a-z-]+$/);
    expect(cacheBustUrl("https://x/a.json.gz")).not.toBe(cacheBustUrl("https://x/a.json.gz"));
  });
});
