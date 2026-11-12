/** ADR-307: start warming resident atlas images as soon as the page opens, in parallel with the main bundle. */
import { assetFetch, collectPrefetchUrls, collectWarmupPrefetchUrls, setAssetCacheVersion, warmAssetCache } from "../../../packages/render/src/assets/asset-fetch.js";

declare const __BUILD_HASH__: string | undefined;
setAssetCacheVersion((typeof __BUILD_HASH__ !== "undefined" && __BUILD_HASH__) || "dev");

const art = new URL(`${import.meta.env.BASE_URL}art/`, location.href).href;
const get = async (u: string): Promise<unknown> => {
  try { const r = await assetFetch(u); return r.ok ? await r.json() : undefined; } catch { return undefined; }
};

void (async () => {
  try {
    const idx = await get(`${art}manifests.index.json`) as { fragments?: { url: string; stream?: boolean }[] } | undefined;
    const frags = idx?.fragments?.length ? idx.fragments : [{ url: "pack/manifest.json" }];
    const urls: string[] = []; const warmUrls: string[] = [];
    await Promise.all(frags.map(async (f) => {
      if (f.stream) return;
      const url = new URL(f.url, art).href;
      const m = await get(url);
      if (m) { urls.push(...collectPrefetchUrls(m, url)); warmUrls.push(...collectWarmupPrefetchUrls(m, url)); }
    }));
    await warmAssetCache(urls);
    // ADR-370: after the resident set, warm the first-view stream sheets (visible-pin pages the boot
    // warm-up will page in) so their first page-in is a cache hit, not a network fetch + decode.
    await warmAssetCache(warmUrls);
  } catch { /* boot continues without a warm cache */ }
})();
