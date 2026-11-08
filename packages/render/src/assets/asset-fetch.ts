/**
 * ADR-307: shared fetch for art and audio. Dedupes in-flight requests, serves a versioned Cache Storage
 * bucket (so a new deploy does not show stale sprites), and limits how many transfers run at once.
 */
export const ASSET_CACHE_PREFIX = "survivaz-art-";
export const ASSET_FETCH_CONCURRENCY = 8;

let version = "dev";
let limit = ASSET_FETCH_CONCURRENCY;
let active = 0;
const waiters: Array<() => void> = [];
const inflight = new Map<string, Promise<Response>>();

export function assetCacheName(ver = version): string { return ASSET_CACHE_PREFIX + ver; }
export function setAssetCacheVersion(v: string): Promise<void> { version = v || "dev"; return dropOldAssetCaches(); }
export function setAssetFetchConcurrency(n: number): void { limit = Math.max(1, n | 0); }
export function resetAssetFetchForTests(): void {
  version = "dev"; limit = ASSET_FETCH_CONCURRENCY; active = 0; waiters.length = 0; inflight.clear();
}

async function dropOldAssetCaches(): Promise<void> {
  if (typeof caches === "undefined") return;
  const keep = assetCacheName();
  try { for (const k of await caches.keys()) if (k.startsWith(ASSET_CACHE_PREFIX) && k !== keep) await caches.delete(k); } catch { /* private mode */ }
}

export async function withAssetSlot<T>(job: () => Promise<T>): Promise<T> {
  if (active >= limit) await new Promise<void>((r) => waiters.push(r));
  active++;
  try { return await job(); } finally { active--; waiters.shift()?.(); }
}

async function cacheStore(): Promise<Cache | null> {
  if (typeof caches === "undefined") return null;
  try { return await caches.open(assetCacheName()); } catch { return null; }
}

async function doFetch(url: string, init?: RequestInit): Promise<Response> {
  const cache = await cacheStore();
  try { const hit = cache ? await cache.match(url) : undefined; if (hit) return hit; } catch { /* ignore */ }
  let res: Response;
  try { res = await fetch(url, { cache: "force-cache", ...init }); if (!res.ok) throw new Error(String(res.status)); }
  catch { res = await fetch(url, init); }
  if (res.ok && cache) { try { await cache.put(url, res.clone()); } catch { /* quota / private mode */ } }
  return res;
}

/** Fetch `url`, preferring a same-deploy Cache Storage hit, then the HTTP cache, then the network. */
export async function assetFetch(url: string, init?: RequestInit): Promise<Response> {
  if (/^(blob|data):/i.test(url)) return fetch(url, init);
  let p = inflight.get(url);
  if (!p) {
    p = doFetch(url, init);
    inflight.set(url, p);
    void p.finally(() => { if (inflight.get(url) === p) inflight.delete(url); });
  }
  return (await p).clone();
}

export async function assetBytes(url: string): Promise<ArrayBuffer> {
  const res = await assetFetch(url);
  if (!res.ok) throw new Error(`asset fetch failed ${res.status}: ${url}`);
  return res.arrayBuffer();
}

/** Resident boot images we want warm before / during setRegistry. Streamed pages stay on-demand. */
export function shouldPrefetchAtlas(key: string, image: string, residency?: string): boolean {
  if (!key || !image || /^(blob|data):/i.test(image)) return false;
  if (/^veh_/.test(key) || /^building_t\d+$/.test(key)) return false;
  if (/(^|\/)customization(\/|_v2)/i.test(image) && !/^body_/.test(key)) return false;
  if (residency === "stream" && !/^body_/.test(key) && !/^gt_/.test(key)) return false;
  return true;
}

export function collectPrefetchUrls(manifest: unknown, base: string): string[] {
  const atlases = (manifest as { atlases?: unknown }).atlases;
  if (!Array.isArray(atlases)) return [];
  const root = base.endsWith("/") ? base : base.replace(/[^/]*$/, "");
  const resolve = (p: string): string => (/^(\/|[a-z]+:)/i.test(p) ? p : root + p.replace(/^\.\//, ""));
  const urls: string[] = [];
  for (const raw of atlases) {
    const a = raw as { key?: string; image?: string; residency?: string; emissiveImage?: string; masks?: Record<string, unknown> };
    if (typeof a.image !== "string" || !shouldPrefetchAtlas(a.key ?? "", a.image, a.residency)) continue;
    urls.push(resolve(a.image));
    if (typeof a.emissiveImage === "string") urls.push(resolve(a.emissiveImage));
    for (const v of Object.values(a.masks ?? {})) if (typeof v === "string") urls.push(resolve(v));
  }
  return urls;
}

/** Download each URL into Cache Storage (body consumed so the transfer actually completes). */
export async function warmAssetCache(urls: readonly string[]): Promise<void> {
  await Promise.all([...new Set(urls)].map((u) => withAssetSlot(async () => { const r = await assetFetch(u); if (r.ok) await r.arrayBuffer(); })));
}
