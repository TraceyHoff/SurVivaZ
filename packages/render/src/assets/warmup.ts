/**
 * ADR-370: render warm-up — atlas page-in priority for the first view, a bounded warm-up window on
 * load, and the chunk-prewarm ordering input.
 *
 * Pure (no GL, no DOM, no imports): the ordering, the budgets and the result shape live here so they
 * are unit-testable in node and reusable from the asset cache (asset-fetch.ts), the GPU page-in queue
 * (atlasManager.ts) and the boot / world-ready flow (apps/client view.ts / main.ts).
 *
 * Why this exists: today the first gameplay frames page stream sheets in at 2 uploads/frame, in the
 * order the draw happens to request them (AtlasManager.pump / PAGE_UPLOADS_PER_FRAME), while the
 * boot screen only waits for the *resident* atlases (IsoView.create -> setRegistry). A first view
 * with ~20 stream pages therefore spends its first ~10 frames drawing placeholders / body-only
 * fallbacks — the blurry start. The warm-up orders those pages (first-view, then the visible-pin
 * art that is in view at almost any spawn, then hot art) and requests them at near-player priority
 * before the first paint, inside a bounded window, instead of letting the draw order decide.
 *
 * Deliberately NOT changed here: resolution, mip levels, texture quality, preset defaults
 * (Full stays the default), bloom / lighting quality, the compass, or any art.
 */

/** Priority of a warm-up page-in: near-player, but not the local player. */
export const WARMUP_PRIO = 1;
/**
 * Max pages one warm-up window requests. 24 = the desktop stream-pool slot count
 * (STREAM_POOL_SLOTS_DESKTOP); the low-memory pool holds 12, and AtlasManager.request()
 * refuses what the pool cannot hold, so the cap never forces an eviction storm.
 */
export const WARMUP_MAX_PAGES = 24;
/** Wall-clock budget for one warm-up window (ms). Expiry never blocks boot: the caller continues with a soft start. */
export const WARMUP_WINDOW_MS = 1500;
/** Poll interval (ms) while waiting for warm-up page-ins to land (matches AtlasManager.prefetch). */
export const WARMUP_POLL_MS = 16;

/**
 * Tier regexes, mirrored from packages/render/src/assets/atlasManager.ts
 * (VISIBLE_PIN_RE / HOT_ATLAS_RE / COLD_ATLAS_RE). Keep them in sync: the ADR-370 test asserts
 * this module and the AtlasManager agree on a representative key list. Duplicated (not imported)
 * so this module stays import-free — the page-open prefetch script must not pull in the GPU code.
 */
const VISIBLE_PIN_RE = /^(gt_|furniture(_|$)|buildings?(_|$)|openings(_|$)|defenses(_|$))/;
const HOT_ATLAS_RE = /(^|[_/-])(tiles?|terrain|ground|characters?|bod(y|ies)|base|resources|decor|items|animals|equipment|held|buildings?|openings|furniture|fog|ui|fonts?|sdf)([_@/-]|$)/i;
const COLD_ATLAS_RE = /(^brand_|lod\d*|_far|distant|rare|_huge|_big|^fx_|death_bag|critters|wear|cosmetic|hair|hats?|accessor|tops?|bottoms?|shoes|faces?|eyes)/i;
/** ADR-322 / crouch: seated-rider and crouch doll pages stream on use — never a warm-up page. */
const LAZY_DOLL_PAGE_RE = /^cz_(ride|crouch)_/;

/**
 * Warm-up tier of an atlas key (lower = page it sooner).
 * 0 = in the caller's first-view set (sprites actually visible at spawn / in the initial camera rect);
 * 1 = visible-pin art (ground, furniture, buildings, openings, defenses — in view at almost any spawn,
 *     spawns sit beside abandoned structures, ADR-300/325);
 * 2 = hot art (characters, terrain, items, animals, ...);
 * 3 = everything else; 4 = cold / ride pages (rare, distant, cosmetic, or ride-only: never warmed up).
 * A key that is both hot and cold warms last: cold wins over hot, visible-pin wins over cold.
 */
export function warmupAtlasTier(key: string, firstView?: ReadonlySet<string>): number {
  if (!key) return 4;
  if (firstView?.has(key)) return 0;
  if (VISIBLE_PIN_RE.test(key)) return 1;
  if (LAZY_DOLL_PAGE_RE.test(key) || COLD_ATLAS_RE.test(key)) return 4;
  if (HOT_ATLAS_RE.test(key)) return 2;
  return 3;
}

/** True when the key belongs in a warm-up set: first-view or visible-pin art (tiers 0–1). */
export function isWarmupCandidate(key: string, firstView?: ReadonlySet<string>): boolean {
  return warmupAtlasTier(key, firstView) <= 1;
}

/** Stable sort of atlas keys into warm-up order (tier, then input order). */
export function sortWarmupKeys(keys: readonly string[], firstView?: ReadonlySet<string>): string[] {
  return keys
    .map((key, i) => ({ key, tier: warmupAtlasTier(key, firstView), i }))
    .sort((a, b) => a.tier - b.tier || a.i - b.i)
    .map((x) => x.key);
}

/**
 * How many pages a warm-up window may request, given the pool it pages into.
 * Unknown pool size -> WARMUP_MAX_PAGES; a smaller pool clamps it (low-memory stream pool: 12).
 */
export function warmupPageBudget(poolSlots?: number, maxPages: number = WARMUP_MAX_PAGES): number {
  const cap = Math.max(0, Math.floor(maxPages));
  if (poolSlots === undefined || !Number.isFinite(poolSlots)) return cap;
  return Math.max(0, Math.min(cap, Math.floor(poolSlots)));
}

/** Outcome of one warm-up window (AtlasManager.warmupFirstView / warmupDrain report). */
export interface WarmupResult {
  /** Pages newly requested in this window. */
  requested: number;
  /** Pages already resident when the window opened (resident atlases + already-paged stream pages). */
  alreadyResident: number;
  /** requested pages that landed + alreadyResident. */
  resident: number;
  /** Requested pages still not resident when the window ended. */
  stillPending: number;
  /** Candidate keys not requested (unknown key, over the page budget). */
  skipped: number;
  /** Wall-clock ms the window took. */
  ms: number;
  /** True when the window ended on its timeout with pages still pending. */
  timedOut: boolean;
}
