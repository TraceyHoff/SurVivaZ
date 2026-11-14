/**
 * ADR-307: shared fetch for art and audio. Dedupes in-flight requests, serves a versioned Cache Storage
 * bucket (so a new deploy does not show stale sprites), and limits how many transfers run at once.
 */
import { isWarmupCandidate } from "./warmup.js";
import { gunzipText, isGzip } from "./gzip-json.js";

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
  version = "dev"; limit = ASSET_FETCH_CONCURRENCY; active = 0; waiters.length = 0; inflight.clear(); inflightText.clear();
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

const inflightText = new Map<string, Promise<string | undefined>>();
async function gzText(url: string): Promise<string | undefined> {
  const cache = await cacheStore();
  try { const hit = cache ? await cache.match(url) : undefined; if (hit) return await hit.text(); } catch { /* ignore */ }
  let res: Response;
  try { res = await fetch(url + ".gz", { cache: "force-cache" }); if (!res.ok) throw new Error(String(res.status)); }
  catch { try { res = await fetch(url + ".gz"); } catch { return undefined; } }
  if (!res.ok) return undefined;
  const b = new Uint8Array(await res.arrayBuffer());
  const text = isGzip(b) ? await gunzipText(b) : new TextDecoder().decode(b); // a host may have decoded it already
  if (cache) void cache.put(url, new Response(text, { headers: { "Content-Type": "application/json" } })).catch(() => { /* quota / private mode */ });
  return text;
}
/**
 * ADR-394: JSON the build ships only as `<url>.gz` (merged-manifest fragments, shards, ids.lock). The first
 * boot downloads the gzip (~17x smaller) and decodes it once; the decoded text is kept in this deploy's Cache
 * Storage under `url`, so a repeat boot reads the plain JSON exactly as before ADR-394 (no decompression).
 * Returns undefined when the file is missing (optional fragments).
 */
export async function assetJsonGz(url: string): Promise<unknown> {
  let p = inflightText.get(url);
  if (!p) { p = gzText(url); inflightText.set(url, p); void p.finally(() => { if (inflightText.get(url) === p) inflightText.delete(url); }); }
  const t = await p; return t === undefined ? undefined : JSON.parse(t);
}

export async function assetBytes(url: string): Promise<ArrayBuffer> {
  const res = await assetFetch(url);
  if (!res.ok) throw new Error(`asset fetch failed ${res.status}: ${url}`);
  return res.arrayBuffer();
}

/** ADR-322: `cz_ride_<slot>_<n>` doll pages (ride_idle / ride_walk / ride_gallop): never prefetched, never resident. */
export const isRidePageKey = (key: string): boolean => /^cz_ride_/.test(key);
/** `cz_crouch_<slot>_<n>` doll pages (crouch_idle / crouch_walk): streamed like ride pages, never prefetched. */
export const isCrouchPageKey = (key: string): boolean => /^cz_crouch_/.test(key);
/** Streamed extra doll-anim pages (ride + crouch): wear-pool, not eager body, not warmed at boot. */
export const isLazyDollPageKey = (key: string): boolean => isRidePageKey(key) || isCrouchPageKey(key);
/** Resident boot images we want warm before / during setRegistry. Streamed pages stay on-demand. */
export function shouldPrefetchAtlas(key: string, image: string, residency?: string): boolean {
  if (!key || !image || /^(blob|data):/i.test(image)) return false;
  if (/^veh_/.test(key) || /^building_t\d+$/.test(key)) return false;
  if (isLazyDollPageKey(key)) return false; // ride / crouch doll pages stream on use, not at boot
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

/**
 * ADR-370: Cache-warm the first-view stream sheets (visible-pin pages the boot warm-up will page
 * in: furniture / buildings / openings / defenses, including building tiers) so their first page-in
 * is a Cache Storage hit, not a network fetch + decode. Disjoint from collectPrefetchUrls: resident
 * atlases are already warmed there, ride pages and cold sheets stay on demand.
 */
export function collectWarmupPrefetchUrls(manifest: unknown, base: string): string[] {
  const atlases = (manifest as { atlases?: unknown }).atlases;
  if (!Array.isArray(atlases)) return [];
  const root = base.endsWith("/") ? base : base.replace(/[^/]*$/, "");
  const resolve = (p: string): string => (/^(\/|[a-z]+:)/i.test(p) ? p : root + p.replace(/^\.\//, ""));
  const urls: string[] = [];
  for (const raw of atlases) {
    const a = raw as { key?: string; image?: string; residency?: string; emissiveImage?: string };
    const key = a.key ?? "";
    if (typeof a.image !== "string" || !isWarmupCandidate(key)) continue;
    if (isLazyDollPageKey(key)) continue; // ride / crouch: stream on use, never cache-warmed at boot
    if (a.residency !== "stream") continue;
    if (shouldPrefetchAtlas(key, a.image, a.residency)) continue; // already warmed by collectPrefetchUrls
    urls.push(resolve(a.image));
    if (typeof a.emissiveImage === "string") urls.push(resolve(a.emissiveImage));
  }
  return urls;
}

/** Download each URL into Cache Storage (body consumed so the transfer actually completes). */
export async function warmAssetCache(urls: readonly string[]): Promise<void> {
  await Promise.all([...new Set(urls)].map((u) => withAssetSlot(async () => { const r = await assetFetch(u); if (r.ok) await r.arrayBuffer(); })));
}
