import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assetCacheName, assetFetch, collectPrefetchUrls, resetAssetFetchForTests, setAssetCacheVersion,
  shouldPrefetchAtlas, warmAssetCache,
} from "../src/assets/asset-fetch.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); resetAssetFetchForTests(); });

function stubCache(): Map<string, Response> {
  const buckets = new Map<string, Map<string, Response>>();
  vi.stubGlobal("caches", {
    open: async (name: string) => {
      const store = buckets.get(name) ?? new Map<string, Response>(); buckets.set(name, store);
      return {
        match: async (u: string) => store.get(u)?.clone(),
        put: async (u: string, r: Response) => { store.set(String(u), r); },
      };
    },
    keys: async () => [...buckets.keys()],
    delete: async (name: string) => buckets.delete(name),
  });
  return buckets.get(assetCacheName()) ?? new Map();
}

describe("ADR-307 asset fetch cache", () => {
  it("skips streamed vehicles, building tiers, and wearable cosmetics", () => {
    expect(shouldPrefetchAtlas("characters", "atlases/characters.png")).toBe(true);
    expect(shouldPrefetchAtlas("body_male", "customization/atlases/body_male.png")).toBe(true);
    expect(shouldPrefetchAtlas("hair_long", "customization/atlases/hair_long.png")).toBe(false);
    expect(shouldPrefetchAtlas("veh_truck", "vehicles/atlases/veh_truck.png")).toBe(false);
    expect(shouldPrefetchAtlas("building_t2", "building/atlases/building_t2.png")).toBe(false);
    expect(shouldPrefetchAtlas("crops", "nature/atlases/crops.png", "stream")).toBe(false);
    expect(shouldPrefetchAtlas("gt_grass", "atlases/gt_grass.png", "stream")).toBe(true);
  });

  it("collects resident image and mask urls relative to the fragment", () => {
    const urls = collectPrefetchUrls({
      atlases: [
        { key: "characters", image: "atlases/characters.png", masks: { sheen: "atlases/characters_sheen.png" } },
        { key: "veh_cart", image: "atlases/veh_cart.png" },
      ],
    }, "https://game.example/art/pack/manifest.json");
    expect(urls).toEqual([
      "https://game.example/art/pack/atlases/characters.png",
      "https://game.example/art/pack/atlases/characters_sheen.png",
    ]);
  });

  it("dedupes parallel fetches and serves the second call from Cache Storage", async () => {
    stubCache();
    let n = 0;
    vi.stubGlobal("fetch", async (u: string) => { n++; return new Response(new Uint8Array([n]), { status: 200, headers: { "Content-Type": "image/png" } }); });
    const [a, b] = await Promise.all([assetFetch("https://x/a.png"), assetFetch("https://x/a.png")]);
    expect(n).toBe(1);
    expect(new Uint8Array(await a.arrayBuffer())[0]).toBe(1);
    expect(new Uint8Array(await b.arrayBuffer())[0]).toBe(1);
    const again = await assetFetch("https://x/a.png");
    expect(n).toBe(1);
    expect(new Uint8Array(await again.arrayBuffer())[0]).toBe(1);
  });

  it("drops older cache buckets when the build hash changes", async () => {
    const buckets = new Map<string, Map<string, Response>>();
    vi.stubGlobal("caches", {
      open: async (name: string) => { const store = buckets.get(name) ?? new Map(); buckets.set(name, store); return { match: async () => undefined, put: async () => undefined }; },
      keys: async () => [...buckets.keys()],
      delete: async (name: string) => buckets.delete(name),
    });
    buckets.set("survivaz-art-old", new Map());
    await setAssetCacheVersion("new");
    expect([...buckets.keys()]).not.toContain("survivaz-art-old");
    expect(assetCacheName()).toBe("survivaz-art-new");
  });
});
