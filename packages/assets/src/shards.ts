import type { ManifestJson } from "./manifest.js";

/**
 * ADR-138 sharded manifests. A manifest file is either a v1 monolithic manifest (ManifestJson) or a v2 index:
 *   {"version":2,"name":"customization","shards":[{"category":"hat","file":"manifest.customization.hat.json","bytes":N,"sha":"<sha256 hex>"},...]}
 * Each shard is a v1 manifest fragment (same entry schema) holding one category; shard file paths are relative to the index.
 * mergeShards concatenates keyed arrays / unions record sections in index order. Unlike mergeManifests (first wins),
 * a key defined in two shards is an error (ShardMergeError). Scalars (version, name, tintNeutral...) must agree.
 */
export const MANIFEST_SHARD_MAX_BYTES = 20 * 1024 * 1024;
export interface ManifestShardRef { category: string; file: string; bytes: number; sha: string }
export interface ManifestShardIndex { version: 2; name?: string; shards: ManifestShardRef[] }
/** ADR-555: the customization shard that boots with the game (bodyTypes, skinTones, hairColors — 528 KB
 * parsed) and the nine wear shards that lazy-load later (35.6 MB of wear-sprite dirFrames between them).
 * A wear shard's sprites only reference its own atlases plus the base shard's pose atlases, so the boot
 * registry already carries every atlas a wear sprite's dirFrames can name. */
export const BASE_SHARD_CATEGORY = "base";
export const WEAR_SHARD_CATEGORIES: readonly string[] = ["hair", "hat", "top", "bottom", "shoes", "accessory", "face", "eyes", "hands"];
export const isWearShardCategory = (category: string): boolean => (WEAR_SHARD_CATEGORIES as readonly string[]).includes(category);
export class ShardMergeError extends Error {}
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

export const isShardIndex = (j: unknown): j is ManifestShardIndex => isObj(j) && j.version === 2 && Array.isArray(j.shards);

export function mergeShards(shards: { file: string; manifest: ManifestJson }[]): ManifestJson {
  const out: Obj = {}; const owner = new Map<string, string>();
  const claim = (id: string, file: string): void => {
    const prev = owner.get(id); if (prev !== undefined) throw new ShardMergeError(`manifest shards: duplicate ${id} in ${prev} and ${file}`); owner.set(id, file);
  };
  for (const { file, manifest } of shards) {
    for (const [sec, v] of Object.entries(manifest as unknown as Obj)) {
      const cur = out[sec];
      if (Array.isArray(v)) {
        const keyed = v.every((x) => isObj(x) && typeof x.key === "string");
        if (keyed) { for (const x of v as Obj[]) claim(`${sec}.${String(x.key)}`, file); out[sec] = [...((cur as unknown[]) ?? []), ...v]; }
        else { claim(sec, file); out[sec] = v; }
      } else if (isObj(v)) {
        if (cur !== undefined && !isObj(cur)) throw new ShardMergeError(`manifest shards: section ${sec} type differs in ${file}`);
        for (const k of Object.keys(v)) claim(`${sec}.${k}`, file);
        out[sec] = { ...((cur as Obj) ?? {}), ...v };
      } else if (cur === undefined) out[sec] = v;
      else if (cur !== v) throw new ShardMergeError(`manifest shards: ${sec} differs (${JSON.stringify(cur)} vs ${JSON.stringify(v)} in ${file})`);
    }
  }
  return out as unknown as ManifestJson;
}

/** Resolve a manifest JSON (v1 passes through; v2 fetches every shard in parallel via `load(file)` and merges). */
export async function resolveManifestShards(json: unknown, load: (file: string, ref: ManifestShardRef) => Promise<unknown>): Promise<ManifestJson> {
  if (!isShardIndex(json)) return json as ManifestJson;
  const parts = await Promise.all(json.shards.map(async (s) => {
    const m = await load(s.file, s); if (m === undefined || m === null) throw new Error(`manifest shard missing: ${s.file}`);
    return { file: s.file, manifest: m as ManifestJson };
  }));
  return mergeShards(parts);
}

/**
 * ADR-555: resolve a v2 shard index but fetch + merge only the `include` categories; the rest are
 * returned as `deferred` refs for a later lazy load (loadWearShard). The boot call passes
 * [BASE_SHARD_CATEGORY], so the 9 wear shards are never fetched or parsed at boot. A v1 manifest
 * passes through with no deferred refs. `load` is only called for included shards.
 */
export async function resolveManifestShardsSplit(json: unknown, load: (file: string, ref: ManifestShardRef) => Promise<unknown>, include: readonly string[]): Promise<{ manifest: ManifestJson; deferred: ManifestShardRef[] }> {
  if (!isShardIndex(json)) return { manifest: json as ManifestJson, deferred: [] };
  const wanted = new Set(include);
  const deferred = json.shards.filter((s) => !wanted.has(s.category));
  const parts = await Promise.all(json.shards.filter((s) => wanted.has(s.category)).map(async (s) => {
    const m = await load(s.file, s); if (m === undefined || m === null) throw new Error(`manifest shard missing: ${s.file}`);
    return { file: s.file, manifest: m as ManifestJson };
  }));
  return { manifest: mergeShards(parts), deferred };
}
