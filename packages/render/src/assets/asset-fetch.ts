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

/** ADR-405: evict one entry from this deploy's asset cache (a poisoned manifest entry must not survive). */
export async function dropAssetCacheEntry(url: string): Promise<void> {
  const cache = await cacheStore();
  try { await cache?.delete(url); } catch { /* private mode */ }
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
    // `.then(cleanup, cleanup)`, not `.finally(cleanup)`: a finally-derived promise re-rejects when `p`
    // rejects, which would surface as an unhandled rejection (ADR-405: gzText now throws on real failures).
    void p.then(() => { if (inflight.get(url) === p) inflight.delete(url); }, () => { if (inflight.get(url) === p) inflight.delete(url); });
  }
  return (await p).clone();
}

const inflightText = new Map<string, Promise<string | undefined>>();
/** ADR-406: a cache-busting query key for a manifest `.gz` URL. A URL never requested before has no
 * entry in any cache — browser HTTP cache, CDN edge, or proxy — so it must be served from origin.
 * GitHub Pages ignores the query string for static files, so `?v=<token>` still serves the file.
 * The token is unique per call, so a busted fetch can never itself be served a stale entry. */
let bustCounter = 0;
export function cacheBustUrl(url: string, token?: string): string {
  const t = token ?? `${Date.now().toString(36)}-${(bustCounter++).toString(36)}`;
  return `${url}${url.includes("?") ? "&" : "?"}v=${t}`;
}

/** Options for `assetJsonGz` (and the `gzText` it reads through). */
export interface AssetJsonGzOptions {
  /** ADR-406: the file is listed in a manifest index, so it is REQUIRED — a 404 on every attempt
   * throws with the cause instead of returning undefined (undefined stays reserved for genuinely
   * optional fragments, which still skip when missing). */
  required?: boolean;
  /** Delays (ms) before the delayed retries. Tests pass [0, 0] so the schedule runs instantly. */
  retryDelays?: readonly number[];
  /** Fixed token for the cache-busting retry (tests); production generates a unique one per call. */
  bustToken?: string;
  /** Skip the Cache Storage read and fetch with `cache: "reload"` (the ADR-405 heal retry). */
  bypassCache?: boolean;
}
/** ADR-406: delays before the delayed retries (the instant attempts run back-to-back, as before). */
export const GZ_TEXT_RETRY_DELAYS: readonly number[] = [600, 1800];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * ADR-405: the decoded text of `<url>.gz` (or undefined when the file is genuinely missing).
 * A fetch/gunzip failure THROWS (it used to return undefined, so every failure — a 503, a cut
 * connection, a corrupt gzip — was reported downstream as "manifest shard missing" with no
 * cause). Only a 404 on every attempt (including one cache-bypassing `reload` fetch, so a stale
 * cached 404 cannot fake a missing file) returns undefined. `bypassCache` skips the Cache
 * Storage read and fetches with `cache: "reload"`, so a poisoned entry cannot survive a retry.
 * ADR-406: the instant attempts all hit the SAME cache key in the same millisecond window — a 404
 * stuck in the browser HTTP cache and/or the nearby CDN edge (Pages 404s carry an ETag and are
 * cached heuristically; a reload revalidates into a 304 and serves the stale 404 again) defeats
 * all three identically, and a user reload repeats the identical sequence (proven live: the top
 * shard 404s deterministically on both Wi-Fi and mobile data, 11+ minutes after the deploy
 * finished). So a 404 now also gets delayed retries: a plain `no-store` fetch (no validators, no
 * cache read or write) and, last, a fetch against a cache-busting URL (a fresh key at every layer).
 * A flap that clears, or a stuck cache, heals inside this boot instead of bricking it.
 */
async function gzText(url: string, opts?: AssetJsonGzOptions): Promise<string | undefined> {
  const cache = await cacheStore();
  if (cache && !opts?.bypassCache) { try { const hit = await cache.match(url); if (hit) return await hit.text(); } catch { /* ignore */ } }
  const delays = opts?.retryDelays ?? GZ_TEXT_RETRY_DELAYS;
  const tryFetch = async (init?: RequestInit, bust = false): Promise<Response | undefined> => {
    try { return await fetch(bust ? cacheBustUrl(url + ".gz", opts?.bustToken) : url + ".gz", init); } catch { return undefined; }
  };
  // A fetch that throws (network error) returns undefined here; the caller reassigns `res` only when
  // a response actually arrived, so a transient blip on one attempt never overwrites an earlier
  // response's evidence (a 404 stays a 404; a missing response stays missing and throws below).
  let res = await tryFetch(opts?.bypassCache ? { cache: "reload" } : { cache: "force-cache" });
  if (!res || !res.ok) { const r2 = await tryFetch(); if (r2) res = r2; }
  if (res && res.status === 404 && !opts?.bypassCache) { const r3 = await tryFetch({ cache: "reload" }); if (r3) res = r3; }
  // ADR-406: delayed retries, only while the file is still 404ing after the instant attempts.
  if (res?.status === 404) {
    await sleep(delays[0] ?? 0);
    const r4 = await tryFetch({ cache: "no-store" }); if (r4) res = r4;
    if (res?.status === 404) {
      await sleep(delays[1] ?? 0);
      const r5 = await tryFetch({ cache: "no-store" }, true); if (r5) res = r5;
    }
  }
  if (!res) throw new Error(`manifest fetch failed: network error: ${url}.gz`);
  if (!res.ok) {
    if (res.status === 404) return undefined;
    throw new Error(`manifest fetch failed: HTTP ${res.status}: ${url}.gz`);
  }
  const b = new Uint8Array(await res.arrayBuffer());
  let text: string;
  try { text = isGzip(b) ? await gunzipText(b) : new TextDecoder().decode(b); } // a host may have decoded it already
  catch (e) { throw new Error(`manifest gunzip failed: ${url}.gz`, { cause: e }); }
  if (cache) void cache.put(url, new Response(text, { headers: { "Content-Type": "application/json" } })).catch(() => { /* quota / private mode */ });
  return text;
}
/**
 * ADR-394: JSON the build ships only as `<url>.gz` (merged-manifest fragments, shards, ids.lock). The first
 * boot downloads the gzip (~17x smaller) and decodes it once; the decoded text is kept in this deploy's Cache
 * Storage under `url`, so a repeat boot reads the plain JSON exactly as before ADR-394 (no decompression).
 * Returns undefined when the file is missing (optional fragments).
 * ADR-405: a cached entry that is not JSON is a poisoned cache (one bad write used to fail every boot with
 * "manifest shard missing" and no cause): evict it and retry once from the network, bypassing both caches,
 * so a single bad write heals on the next load instead of bricking the deploy. A fetch/gunzip failure is
 * retried once the same way, then the real error surfaces (never undefined).
 * ADR-406: `opts.required` (index-listed shards and required fragments) — a 404 on every attempt now
 * THROWS with the cause (URL, HTTP 404, and the retries that ran, including the cache-busting one)
 * instead of returning undefined, so the boot error names the real failure: a file genuinely missing
 * from the deploy reads as a 404 after a cache-busting retry, never as "manifest shard missing".
 */
export async function assetJsonGz(url: string, opts?: AssetJsonGzOptions): Promise<unknown> {
  let text: string | undefined;
  try { text = await readGzText(url, opts); }
  catch {
    try { text = await gzText(url, { ...opts, bypassCache: true }); }
    catch (e2) { throw new Error(`manifest load failed: ${url}`, { cause: e2 instanceof Error ? e2 : new Error(String(e2)) }); }
  }
  if (text === undefined) {
    if (opts?.required) throw new Error(`manifest load failed: ${url}: HTTP 404 on every fetch attempt (instant, delayed, and cache-busting retries included)`);
    return undefined;
  }
  try { return JSON.parse(text); }
  catch {
    await dropAssetCacheEntry(url);
    const retry = await gzText(url, { ...opts, bypassCache: true });
    if (retry === undefined) {
      if (opts?.required) throw new Error(`manifest load failed: ${url}: HTTP 404 on every fetch attempt (instant, delayed, and cache-busting retries included)`);
      return undefined;
    }
    try { return JSON.parse(retry); }
    catch (e2) { throw new Error(`manifest JSON parse failed: ${url} (cached entry evicted, network retry also failed)`, { cause: e2 }); }
  }
}

/** Deduped `gzText` read (concurrent readers share one in-flight fetch + decode). */
async function readGzText(url: string, opts?: AssetJsonGzOptions): Promise<string | undefined> {
  let p = inflightText.get(url);
  if (!p) {
    p = gzText(url, opts); inflightText.set(url, p);
    // `.then(cleanup, cleanup)`, not `.finally(cleanup)`: a finally-derived promise re-rejects when `p`
    // rejects, which would surface as an unhandled rejection (ADR-405: gzText now throws on real failures).
    void p.then(() => { if (inflightText.get(url) === p) inflightText.delete(url); }, () => { if (inflightText.get(url) === p) inflightText.delete(url); });
  }
  return p;
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
