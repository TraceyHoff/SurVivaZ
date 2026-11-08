/** ADR-307: start warming resident atlas images as soon as the page opens, in parallel with the main bundle. */
import { assetFetch, collectPrefetchUrls, setAssetCacheVersion, warmAssetCache } from "../../../packages/render/src/assets/asset-fetch.js";

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
    const urls: string[] = [];
    await Promise.all(frags.map(async (f) => {
      if (f.stream) return;
      const url = new URL(f.url, art).href;
      const m = await get(url);
      if (m) urls.push(...collectPrefetchUrls(m, url));
    }));
    await warmAssetCache(urls);
  } catch { /* boot continues without a warm cache */ }
})();
