import { loadManifest, mergeWearShard, type AssetRegistry, type IdLock, type ManifestJson } from "./manifest.js";
import { mergeManifests, type ManifestCollision, type ManifestFragment } from "./merge.js";
import { BASE_SHARD_CATEGORY, isShardIndex, isWearShardCategory, resolveManifestShards, resolveManifestShardsSplit, type ManifestShardRef } from "./shards.js";
/**
 * Sub-manifests merged onto the pack manifest (ADR-081 mergeManifests, first definition wins), urls relative to <art>/.
 * vite.config.ts writes `<art>/manifests.index.json` from this list, keeping only fragments that are actually served,
 * so the client never requests a missing optional fragment (no 404s). Without that file the client uses this list.
 */
export interface ManifestFragmentRef { name: string; url: string; optional?: boolean;
  /** ADR-242: image paths in this fragment are relative to this art-root dir ("" = `<art>/`), not to the fragment's own dir
   *  (Art's top-level drops write `pvp_clan/atlases/x.png`). */ root?: string;
  /** ADR-242: stream this fragment's atlases (`residency:"stream"`: fetched on first use, not at boot). */ stream?: boolean;
  /** ADR-242: strip `clanPalettes` (the building manifest carries the served copy; a second would double N). */ dropClanPalettes?: boolean }
export const MANIFEST_INDEX: readonly ManifestFragmentRef[] = [
  { name: "pack", url: "pack/manifest.json" },
  { name: "ui-kit", url: "ui/kit/manifest.ui.kit.json", optional: true },
  { name: "branding", url: "ui/branding/manifest.branding.json", optional: true },
  { name: "customization", url: "pack/customization/manifest.customization.json", optional: true },
  { name: "vehicles", url: "pack/vehicles/manifest.vehicles.json", optional: true },
  { name: "items", url: "pack/items/manifest.items.json", optional: true },
  { name: "vehicle_items", url: "pack/vehicle_items/manifest.vehicle_items.json", optional: true },
  { name: "building", url: "pack/building/manifest.building.json", optional: true },
  { name: "nature", url: "pack/nature/manifest.nature.json", optional: true },
  // Task 34: generated bee / owl / apiary art (atlases painted at runtime by apps/client/src/task34-art.ts; the
  // fragment carries layout only, no PNG files). Resident: the painter runs before setRegistry, so no stream pool.
  { name: "task34", url: "pack/task34/manifest.task34.json", optional: true },
  // ADR-257: unique wild lettuce / hay plant art (atlases painted at runtime by apps/client/src/task256-art.ts).
  { name: "task256", url: "pack/task256/manifest.task256.json", optional: true },
  // ADR-356: dedicated ore / log / stick / crop / stone store art (atlases painted at runtime by
  // apps/client/src/task355-art.ts; the fragment carries layout only, no PNG files).
  { name: "task355", url: "pack/task355/manifest.task355.json", optional: true },
  // ADR-361: dedicated drawn-vehicle + harness art (atlases painted at runtime by
  // apps/client/src/task361-art.ts; the fragment carries layout only, no PNG files).
  { name: "task361", url: "pack/task361/manifest.task361.json", optional: true },
  // ADR-410: sloped-ground tilesets (ramps/wedges per material x season, atlases painted at runtime by
  // apps/client/src/task410-art.ts; the fragment carries layout only, no PNG files).
  { name: "task410", url: "pack/task410/manifest.task410.json", optional: true },
  // ADR-420: dedicated dock / shipyard art (atlases painted at runtime by
  // apps/client/src/task420-art.ts; the fragment carries layout only, no PNG files).
  { name: "task420", url: "pack/task420/manifest.task420.json", optional: true },
  // ADR-421: dedicated tier-1 boat art (atlases painted at runtime by
  // apps/client/src/task421-art.ts; the fragment carries layout only, no PNG files).
  { name: "task421", url: "pack/task421/manifest.task421.json", optional: true },
  // ADR-422: dedicated tier-2 motorboat art (atlases painted at runtime by
  // apps/client/src/task421-art.ts; the fragment carries layout only, no PNG files).
  { name: "task422", url: "pack/task422/manifest.task422.json", optional: true },
  // ADR-479: dedicated sailboat art (atlas painted at runtime by
  // apps/client/src/task421-art.ts; the fragment carries layout only, no PNG files).
  { name: "task479", url: "pack/task479/manifest.task479.json", optional: true },
  // ADR-455: dedicated footprint art (atlases painted at runtime by
  // apps/client/src/footprints-art.ts; the fragment carries layout only, no PNG files).
  { name: "task455", url: "pack/task455/manifest.task455.json", optional: true },
  // ADR-501: dedicated animal-track art (atlas painted at runtime by
  // apps/client/src/footprints-art.ts; the fragment carries layout only, no PNG files).
  { name: "task501", url: "pack/task501/manifest.task501.json", optional: true },
  // ADR-493: dedicated fishing-rod art (atlas painted at runtime by
  // apps/client/src/fishing-rod-art.ts; the fragment carries layout only, no PNG files).
  { name: "task493", url: "pack/task493/manifest.task493.json", optional: true },
  // ADR-540: dedicated cougar + wolverine art (atlases painted at runtime by
  // apps/client/src/task540-art.ts; the fragment carries layout only, no PNG files).
  { name: "task540", url: "pack/task540/manifest.task540.json", optional: true },
  // ADR-242: Art's PvP/clan drop (raid fx, clan banners/gates, nameplates, loot beams) and the stalls drop (stall art,
  // sale coins). Both repeat keys the building pack already serves; mergeManifests keeps building's (first wins).
  { name: "pvp_clan", url: "pvp_clan/manifest.fragment.json", optional: true, root: "", stream: true, dropClanPalettes: true },
  { name: "stalls", url: "stalls/manifest.fragment.json", optional: true, root: "", stream: true },
];
/** ADR-242: directory (absolute URL) that `frag`'s relative image paths resolve against. */
export function fragmentBase(f: ManifestFragmentRef, fragUrl: string, artUrl: string): string {
  return f.root !== undefined ? new URL(f.root, artUrl).href.replace(/\/?$/, "/") : fragUrl.replace(/[^/]*$/, "");
}
/** ADR-242: apply a ref's flags to its fetched manifest (in place): `stream` marks every atlas `residency:"stream"`. */
export function applyFragmentFlags<M>(f: ManifestFragmentRef, m: M): M {
  const at = (m as { atlases?: { residency?: string }[] }).atlases;
  if (f.stream && Array.isArray(at)) for (const a of at) a.residency ??= "stream";
  if (f.dropClanPalettes) delete (m as { clanPalettes?: unknown }).clanPalettes;
  return m;
}
/** ADR-240: player v2 sample (spec §11.1). Not in MANIFEST_INDEX (Art keeps it isolated): loadMergedManifest appends it
 *  only when the charArt setting is v2s / v2s-all (v1 = default = not fetched). */
export const CHAR_ART_V2_FRAGMENT: ManifestFragmentRef = { name: "customization_v2_sample", url: "pack/customization_v2_sample/manifest.customization_v2_sample.json", optional: true };
export const withCharArtFragment = (list: readonly ManifestFragmentRef[], art: string): readonly ManifestFragmentRef[] =>
  art === "v1" || list.some((f) => f.name === CHAR_ART_V2_FRAGMENT.name) ? list : [...list, CHAR_ART_V2_FRAGMENT];
/** The served subset: required fragments always, optional ones only when `served(url)`. */
export const servedManifestIndex = (served: (url: string) => boolean): { fragments: ManifestFragmentRef[] } =>
  ({ fragments: MANIFEST_INDEX.filter((f) => !f.optional || served(f.url)) });

/**
 * ADR-248: the one merged-manifest builder, shared by the client (fetch over `<art>/`) and the dedicated server (files on
 * disk). `get(url)` returns parsed JSON or undefined; `urls` resolves a fragment url / shard file / fragment root against
 * the art root. Fragments are fetched concurrently (ADR-549, cap 6 — the sequential `for…await` serialised ~24
 * cold-cache round-trips), v2 shard indexes are expanded, flags applied, merged in list order (first definition wins),
 * and loaded with `pack/ids.lock.json`, so client and server get the same ids and cosmetics hash.
 */
/** ADR-549: fragment-load concurrency cap (matches the 6–8 range of ASSET_FETCH_CONCURRENCY in asset-fetch.ts). */
export const MANIFEST_LOAD_CONCURRENCY = 6;
export async function loadMergedManifestWith(list: readonly ManifestFragmentRef[], io: {
  get: (url: string) => Promise<unknown>;
  /** ADR-406: loader for REQUIRED manifest files — fragments that are not optional, and every shard of
   * a v2 index (a shard index lists files the merge cannot proceed without). When absent, `get` is
   * used (the dedicated server's file-based loader). A required loader must THROW with the cause
   * instead of returning undefined for a missing file, so the boot error names the real failure
   * (URL, HTTP status, attempts) rather than every failure reading as "manifest shard missing".
   * The `| undefined` keeps explicit `undefined` assignable under `exactOptionalPropertyTypes`. */
  getRequired?: ((url: string) => Promise<unknown>) | undefined;
  /** Absolute url of the art root (ends with "/"), e.g. `new URL(art, location.href).href` or a `file:` url. */
  artUrl: string;
  /** Atlas path rewrite for a fragment-relative image path (client: absolute pathname). Default: `new URL(p, base).pathname`. */
  resolveImage?: (path: string, fragmentBaseUrl: string) => string;
  /**
   * ADR-555: boot without the wear shards. A v2 customization index then merges only its `base` shard;
   * the nine wear shards are never fetched or parsed at boot and are returned as `deferredWearShards`
   * for loadWearShard. The registry is built with loadManifest({ deferWear: true }), so its cosmetics
   * catalog tolerates the missing wearables and core sprite ids still come from the full ids.lock.json.
   * ADR-549's parallel fragment fetch is unchanged — only the shard expansion inside the
   * customization slot narrows to `base`.
   */
  excludeWearShards?: boolean;
}): Promise<{ result: ReturnType<typeof loadManifest>; collisions: ManifestCollision[]; warnings: string[]; fragments: string[]; /** ADR-555: wear shard refs not loaded at boot (empty unless excludeWearShards). */ deferredWearShards: ManifestShardRef[] }> {
  const frags: ManifestFragment[] = []; const dirOf = new Map<string, string>();
  const deferredBySlot = new Map<number, ManifestShardRef[]>();
  // ADR-549: fetch all fragments concurrently (cap MANIFEST_LOAD_CONCURRENCY) instead of one at a time. Each slot
  // records its result (or error) and the merge below walks the slots in list order, so first-wins merge semantics,
  // optional-fragment skipping, and first-error-in-list-order are all unchanged from the sequential loop.
  type FragSlot =
    | { status: "loaded"; frag: ManifestFragment; base: string }
    | { status: "skipped" }
    | { status: "failed"; error: unknown };
  const slots: FragSlot[] = new Array<FragSlot>(list.length);
  let next = 0;
  const loadSlot = async (i: number): Promise<void> => {
    const f = list[i];
    if (f === undefined) { slots[i] = { status: "skipped" }; return; }
    const url = new URL(f.url, io.artUrl).href;
    // ADR-406: required fragments load through `getRequired` (which throws with cause when missing);
    // optional fragments keep `get` and skip when it returns undefined.
    const loadFrag = f.optional ? io.get : (io.getRequired ?? io.get);
    try {
      let m = await loadFrag(url);
      if (m === undefined) {
        if (f.optional) { slots[i] = { status: "skipped" }; return; }
        throw new Error(`manifest fetch failed: ${url}`);
      }
      // ADR-138: a v2 shard index fetches its shards in parallel and merges them (duplicate keys across shards throw).
      // ADR-406: shards are required by definition, so they load through `getRequired` too.
      // ADR-555: with excludeWearShards, a customization index merges only its `base` shard; the wear
      // shards are recorded as deferred (never fetched, never parsed at boot) for loadWearShard.
      const shardLoad = async (file: string) => (io.getRequired ?? io.get)(new URL(file, url).href);
      if (io.excludeWearShards && isShardIndex(m)) {
        const split = await resolveManifestShardsSplit(m, shardLoad, [BASE_SHARD_CATEGORY]);
        deferredBySlot.set(i, split.deferred); m = split.manifest;
      } else {
        m = await resolveManifestShards(m, shardLoad);
      }
      slots[i] = { status: "loaded", frag: { name: f.name, manifest: applyFragmentFlags(f, m) as ManifestJson }, base: fragmentBase(f, url, io.artUrl) }; // ADR-242 root/stream
    } catch (e) { slots[i] = { status: "failed", error: e }; }
  };
  await Promise.all(Array.from({ length: Math.min(MANIFEST_LOAD_CONCURRENCY, list.length) }, async () => {
    // `next++` runs synchronously before the first await, so two workers can never claim one slot.
    while (next < list.length) { const i = next++; await loadSlot(i); }
  }));
  for (const s of slots) {
    if (s === undefined) continue; // unreachable: every slot is filled by a worker
    if (s.status === "skipped") continue;
    if (s.status === "failed") throw s.error;
    frags.push(s.frag); dirOf.set(s.frag.name, s.base);
  }
  const img = io.resolveImage ?? ((p: string, base: string) => new URL(p, base).pathname);
  const { manifest, collisions, warnings } = mergeManifests(frags, { resolve: (p, frag) => (/^(\/|[a-z]+:)/i.test(p) ? p : img(p, dirOf.get(frag)!)) });
  const lock = await io.get(new URL("pack/ids.lock.json", io.artUrl).href) as IdLock | undefined;
  const deferredWearShards = [...deferredBySlot.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, refs]) => refs);
  return { result: loadManifest(manifest, lock ? { lock, ...(io.excludeWearShards ? { deferWear: true } : {}) } : io.excludeWearShards ? { deferWear: true } : {}), collisions, warnings, fragments: frags.map((f) => f.name), deferredWearShards };
}

/** ADR-555: the customization shard index, relative to the art root. */
export const CUSTOMIZATION_INDEX_URL = "pack/customization/manifest.customization.json";
export interface WearShardIO {
  get: (url: string) => Promise<unknown>;
  getRequired?: ((url: string) => Promise<unknown>) | undefined;
  /** Absolute url of the art root (ends with "/"). */
  artUrl: string;
  /** The ids.lock.json the boot registry was built with (sprite ids must match the full merge's). */
  lock?: IdLock | undefined;
  /** Atlas path rewrite, same contract as loadMergedManifestWith's resolveImage. */
  resolveImage?: (path: string, fragmentBaseUrl: string) => string;
}
/**
 * ADR-555: rewrite a wear shard's atlas image/page/mask paths against its shard file URL, exactly as
 * mergeManifests' `resolve` does for the full merge (absolute paths kept, relative ones resolved
 * against the shard directory). ktx2 twins stay relative: sourcesFromManifest resolves them as
 * siblings of the (already absolute) image, as in the full merge.
 */
export function resolveWearShardPaths(shard: ManifestJson, shardFileUrl: string, resolveImage?: WearShardIO["resolveImage"]): ManifestJson {
  const base = shardFileUrl.replace(/[^/]*$/, "");
  const abs = (p: string): string => (/^(\/|[a-z]+:)/i.test(p) ? p : (resolveImage ?? ((x: string, b: string) => new URL(x, b).pathname))(p, base));
  const atlases = (shard.atlases ?? []).map((a) => ({
    ...a, image: abs(a.image),
    ...(a.pages ? { pages: a.pages.map((pg) => ({ ...pg, image: abs(pg.image) })) } : {}),
    ...(a.masks ? { masks: Object.fromEntries(Object.entries(a.masks).map(([k, v]) => [k, typeof v === "string" ? abs(v) : v])) } : {}),
  }));
  return { ...shard, atlases };
}
/**
 * ADR-555: lazy-load one wear shard into a boot registry (loadMergedManifestWith({ excludeWearShards })
 * or loadManifest({ deferWear: true })). Fetches the customization index, then that category's shard,
 * resolves its atlas paths as the full merge would, and merges it in place via mergeWearShard — sprite
 * ids and the cosmetics catalog converge to the full merge's. Throws if the category is not a wear
 * shard, the index/shard is missing, or the shard was already merged. The caller owns the atlas
 * rebuild (client: extend sources + setRegistry) after the merge.
 */
export async function loadWearShard(registry: AssetRegistry, category: string, io: WearShardIO): Promise<ReturnType<typeof mergeWearShard>> {
  if (!isWearShardCategory(category)) throw new Error(`loadWearShard: "${category}" is not a wear shard category (base loads at boot)`);
  const load = io.getRequired ?? io.get;
  const indexUrl = new URL(CUSTOMIZATION_INDEX_URL, io.artUrl).href;
  const index = await load(indexUrl);
  if (!isShardIndex(index)) throw new Error(`loadWearShard: ${CUSTOMIZATION_INDEX_URL} is not a shard index`);
  const ref = index.shards.find((s) => s.category === category);
  if (!ref) throw new Error(`loadWearShard: no "${category}" shard in ${CUSTOMIZATION_INDEX_URL}`);
  const shardUrl = new URL(ref.file, indexUrl).href;
  const raw = await load(shardUrl);
  if (raw === undefined || raw === null) throw new Error(`manifest shard missing: ${ref.file}`);
  return mergeWearShard(registry, resolveWearShardPaths(raw as ManifestJson, shardUrl, io.resolveImage), { lock: io.lock, category });
}
