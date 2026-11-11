import { loadManifest, type IdLock, type ManifestJson } from "./manifest.js";
import { mergeManifests, type ManifestCollision, type ManifestFragment } from "./merge.js";
import { resolveManifestShards } from "./shards.js";
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
 * the art root. Fragments are fetched in `list` order, v2 shard indexes are expanded, flags applied, merged (first
 * definition wins), and loaded with `pack/ids.lock.json`, so client and server get the same ids and cosmetics hash.
 */
export async function loadMergedManifestWith(list: readonly ManifestFragmentRef[], io: {
  get: (url: string) => Promise<unknown>;
  /** Absolute url of the art root (ends with "/"), e.g. `new URL(art, location.href).href` or a `file:` url. */
  artUrl: string;
  /** Atlas path rewrite for a fragment-relative image path (client: absolute pathname). Default: `new URL(p, base).pathname`. */
  resolveImage?: (path: string, fragmentBaseUrl: string) => string;
}): Promise<{ result: ReturnType<typeof loadManifest>; collisions: ManifestCollision[]; warnings: string[]; fragments: string[] }> {
  const frags: ManifestFragment[] = []; const dirOf = new Map<string, string>();
  for (const f of list) {
    const url = new URL(f.url, io.artUrl).href; let m = await io.get(url);
    if (m === undefined) { if (f.optional) continue; throw new Error(`manifest fetch failed: ${url}`); }
    // ADR-138: a v2 shard index fetches its shards in parallel and merges them (duplicate keys across shards throw)
    m = await resolveManifestShards(m, async (file) => io.get(new URL(file, url).href));
    frags.push({ name: f.name, manifest: applyFragmentFlags(f, m) as ManifestJson }); dirOf.set(f.name, fragmentBase(f, url, io.artUrl)); // ADR-242 root/stream
  }
  const img = io.resolveImage ?? ((p: string, base: string) => new URL(p, base).pathname);
  const { manifest, collisions, warnings } = mergeManifests(frags, { resolve: (p, frag) => (/^(\/|[a-z]+:)/i.test(p) ? p : img(p, dirOf.get(frag)!)) });
  const lock = await io.get(new URL("pack/ids.lock.json", io.artUrl).href) as IdLock | undefined;
  return { result: loadManifest(manifest, lock ? { lock } : {}), collisions, warnings, fragments: frags.map((f) => f.name) };
}
