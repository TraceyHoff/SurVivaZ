/**
 * ADR-550: painted PNG cache — the painted phase (~14.2 s on the user's phone) is ~43 atlases
 * drawn pixel-by-pixel in JS and PNG-encoded one by one on every cold boot. The PNG bytes are
 * deterministic given the painter source + spec constants, so cache them in Cache Storage and
 * skip paint + encode entirely on warm boots.
 *
 * Bucket: `survivaz-painted-v1` — deliberately NOT `survivaz-art-<version>` (asset-fetch.ts
 * deletes that whole bucket on every deploy, which would wipe the cache exactly when the user
 * needs it most: the cold-cache first load after a push). Invalidation is by content hash, not
 * deploy version: key `painted/<atlas-key>/<content-hash>`, where the hash covers the painter
 * source (function bodies, so literal palette constants count) + the spec data (JSON). Changing
 * one spec byte changes the hash, so a painter change repaints once (correct — art changed) and
 * the stale entry is pruned on boot. First boot after a painter change still pays full price.
 *
 * Every Cache Storage interaction is best-effort: unavailable / quota / private mode falls back
 * to painting, never fails boot. The menu-icon paints (sync toDataURL, ~31 small icons) are NOT
 * cached — out of scope, small individually. ADR-548 instrumentation is untouched: a cached
 * blob still comes back as a blob: URL, so view.ts's fetch(blob:) blob.size read works the same.
 */
import type { AtlasSource } from "@engine/render";

/** Separate Cache Storage bucket (see header): never wiped by a deploy version bump. */
export const PAINTED_CACHE_NAME = "survivaz-painted-v1";
/** Key prefix inside the bucket: `painted/<atlas-key>/<content-hash>`. */
export const PAINTED_CACHE_KEY_PREFIX = "painted/";
/** Prune is bounded per boot so a painter rework can never stall boot deleting entries. */
export const PAINTED_CACHE_MAX_PRUNE_PER_BOOT = 64;

/** cyrb53 content hash (deterministic, sync, good avalanche): one changed byte → new hash. */
export function hashPaintedSpec(spec: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < spec.length; i++) {
    const ch = spec.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/** Cache key for one painted atlas: `painted/<atlas-key>/<content-hash>`. */
export function paintedCacheKey(atlasKey: string, specHash: string): string {
  return `${PAINTED_CACHE_KEY_PREFIX}${atlasKey}/${specHash}`;
}

/** Minimal structural view of one Cache Storage bucket (real Cache satisfies this). */
export interface PaintedCache {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
  delete(request: string): Promise<boolean>;
  keys(): Promise<readonly { readonly url: string }[]>;
}
/** Minimal structural view of CacheStorage (real CacheStorage satisfies this). */
export interface PaintedCaches {
  open(name: string): Promise<PaintedCache>;
  delete(name: string): Promise<boolean>;
  keys(): Promise<string[]>;
}

/** Rasterized pixels (same shape as every art module's PaintedAtlas). */
export interface PaintedAtlasInput { key: string; width: number; height: number; pixels: Uint8ClampedArray }
/** Pixels -> PNG blob (the shared canvas encode; undefined when no canvas exists). */
export type PaintedEncode = (w: number, h: number, pixels: Uint8ClampedArray) => Promise<Blob | undefined>;

/**
 * Injectable seams (tests pass fakes; production omits `env` and uses the real globals).
 * `caches: null` means Cache Storage is unavailable (private mode); `caches: undefined`
 * (the default) means "use globalThis.caches".
 */
export interface PaintedCacheEnv {
  caches?: PaintedCaches | null | undefined;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  encode?: PaintedEncode;
}

const resolveCaches = (env: PaintedCacheEnv): PaintedCaches | undefined => {
  if (env.caches !== undefined) return env.caches ?? undefined;
  try { return (globalThis as { caches?: PaintedCaches }).caches; } catch { return undefined; }
};

const createPaintedObjectURL = (blob: Blob, env: PaintedCacheEnv): string =>
  env.createObjectURL ? env.createObjectURL(blob) : URL.createObjectURL(blob);

/** Object URL for a freshly painted blob (honours the test seam in `env`). */
export function paintedObjectURL(blob: Blob, env: PaintedCacheEnv = {}): string {
  return createPaintedObjectURL(blob, env);
}

/** Atlas keys seen (looked up or stored) this boot — the prune keep-set. */
const liveKeys = new Set<string>();

/**
 * Rasterized pixels -> PNG blob (OffscreenCanvas, else a document canvas; undefined when no
 * canvas exists). This is the one shared copy of the `canvasToBlobURL` body the art modules
 * used to duplicate; it returns the Blob (so callers can store it) instead of an object URL.
 */
export async function encodePaintedBlob(w: number, h: number, pixels: Uint8ClampedArray): Promise<Blob | undefined> {
  try {
    // TS 5.9 (CI's pinned version) types ImageData's data as Uint8ClampedArray<ArrayBuffer>; our pixels are
    // Uint8ClampedArray<ArrayBufferLike>, so copy into a fresh ArrayBuffer-backed array (once, at load).
    const data = new ImageData(new Uint8ClampedArray(pixels), w, h);
    const OC = (globalThis as { OffscreenCanvas?: typeof OffscreenCanvas }).OffscreenCanvas;
    if (OC) {
      const cv = new OC(w, h); const ctx = cv.getContext("2d");
      if (ctx) { ctx.putImageData(data, 0, 0); if (typeof cv.convertToBlob === "function") return cv.convertToBlob({ type: "image/png" }); }
    }
    const doc = (globalThis as { document?: Document }).document;
    if (doc) {
      const cv = doc.createElement("canvas"); cv.width = w; cv.height = h; const ctx = cv.getContext("2d");
      if (!ctx) return undefined;
      ctx.putImageData(data, 0, 0);
      return await new Promise<Blob | undefined>((res) => cv.toBlob((b) => res(b ?? undefined), "image/png"));
    }
  } catch { /* no canvas in this environment: the caller keeps the manifest's debug path */ }
  return undefined;
}

/**
 * Cache lookup for one atlas: hit → object URL for the cached blob (+ its size, for the
 * ADR-548 `paintedAtlasBytes` read) without painting; miss / any Cache Storage failure →
 * undefined (the caller paints). Never throws.
 */
export async function lookupPaintedBlobURL(atlasKey: string, specHash: string, env: PaintedCacheEnv = {}): Promise<{ url: string; bytes: number } | undefined> {
  try {
    const caches = resolveCaches(env);
    if (!caches) return undefined;
    const key = paintedCacheKey(atlasKey, specHash);
    const res = await (await caches.open(PAINTED_CACHE_NAME)).match(key);
    if (!res) return undefined;
    const blob = await res.blob();
    liveKeys.add(key);
    return { url: createPaintedObjectURL(blob, env), bytes: blob.size };
  } catch { return undefined; }
}

/**
 * All-or-nothing batch lookup for a painter group: every atlas hit → the full map (paint is
 * skipped entirely); any miss → undefined, and any object URLs minted for the partial hits
 * are revoked so they never leak. Never throws.
 */
export async function lookupPaintedBlobURLs(specs: ReadonlyMap<string, string>, env: PaintedCacheEnv = {}): Promise<Map<string, { url: string; bytes: number }> | undefined> {
  const out = new Map<string, { url: string; bytes: number }>();
  for (const [key, spec] of specs) {
    const hit = await lookupPaintedBlobURL(key, hashPaintedSpec(spec), env);
    if (!hit) {
      const revoke = env.revokeObjectURL ?? ((u: string): void => { try { URL.revokeObjectURL(u); } catch { /* already gone */ } });
      for (const h of out.values()) revoke(h.url);
      return undefined;
    }
    out.set(key, hit);
  }
  return out;
}

/** Store one freshly painted PNG blob (best-effort: a put failure never fails boot). */
export async function storePaintedBlob(atlasKey: string, specHash: string, blob: Blob, env: PaintedCacheEnv = {}): Promise<void> {
  try {
    const caches = resolveCaches(env);
    if (!caches) return;
    const key = paintedCacheKey(atlasKey, specHash);
    await (await caches.open(PAINTED_CACHE_NAME)).put(key, new Response(blob, { headers: { "Content-Type": "image/png" } }));
    liveKeys.add(key);
  } catch { /* best-effort: painting already succeeded, boot must not fail */ }
}

/**
 * One atlas, cache-first: hit → the cached blob (no paint call, byte-identical bytes);
 * miss → paint once, encode, store, return the fresh blob. Any Cache Storage failure falls
 * back to painting. `undefined` only when there is no canvas to encode with (the caller
 * keeps the manifest's debug path, as before).
 */
export async function paintedAtlasURL(o: {
  key: string;
  /** Hash input: painter source + spec constants (one changed byte → new hash → repaint). */
  spec: string;
  paint: () => PaintedAtlasInput | Promise<PaintedAtlasInput>;
  encode?: PaintedEncode;
}, env: PaintedCacheEnv = {}): Promise<{ url: string; bytes: number; cached: boolean } | undefined> {
  const hash = hashPaintedSpec(o.spec);
  const hit = await lookupPaintedBlobURL(o.key, hash, env);
  if (hit) return { url: hit.url, bytes: hit.bytes, cached: true };
  const a = await o.paint();
  const blob = await (o.encode ?? env.encode ?? encodePaintedBlob)(a.width, a.height, a.pixels);
  if (!blob) return undefined;
  await storePaintedBlob(o.key, hash, blob, env);
  return { url: createPaintedObjectURL(blob, env), bytes: blob.size, cached: false };
}

/** Build an AtlasSource map from a full batch lookup (the warm-boot path for a group). */
export function paintedSourcesFromHits(hits: ReadonlyMap<string, { url: string; bytes: number }>): Map<string, AtlasSource> {
  const out = new Map<string, AtlasSource>();
  for (const [key, hit] of hits) out.set(key, { url: hit.url, emissiveUrl: null });
  return out;
}

/** Strip a Cache key URL back to its `painted/<atlas-key>/<hash>` suffix (absolute in browsers). */
const paintedSuffix = (url: string): string => {
  const i = url.indexOf(PAINTED_CACHE_KEY_PREFIX);
  return i >= 0 ? url.slice(i) : url;
};

/**
 * Prune stale hashes on boot: delete `painted/*` entries that are not in `keep` (default:
 * the keys looked up or stored this boot). Bounded to PAINTED_CACHE_MAX_PRUNE_PER_BOOT
 * deletions, async, never blocks boot, never throws — call it fire-and-forget from view.ts
 * after the painted phase. Entries outside the `painted/` prefix are left alone.
 */
export async function prunePaintedCache(env: PaintedCacheEnv = {}, keep?: ReadonlySet<string>): Promise<{ deleted: number }> {
  try {
    const caches = resolveCaches(env);
    if (!caches) return { deleted: 0 };
    const cache = await caches.open(PAINTED_CACHE_NAME);
    const live = keep ?? liveKeys;
    let deleted = 0;
    for (const req of await cache.keys()) {
      if (deleted >= PAINTED_CACHE_MAX_PRUNE_PER_BOOT) break;
      const key = paintedSuffix(req.url);
      if (!key.startsWith(PAINTED_CACHE_KEY_PREFIX) || live.has(key)) continue;
      if (await cache.delete(req.url)) deleted++;
    }
    return { deleted };
  } catch { return { deleted: 0 }; }
}

/**
 * ADR-526: "Delete everything" also clears this cache — it is the game's own generated data.
 * Only the painted bucket is deleted; other Cache Storage buckets are left alone. Never throws.
 */
export async function deletePaintedCache(env: PaintedCacheEnv = {}): Promise<boolean> {
  try {
    const caches = resolveCaches(env);
    if (!caches) return false;
    return await caches.delete(PAINTED_CACHE_NAME);
  } catch { return false; }
}
