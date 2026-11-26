import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadManifest, validateAssetFiles, type AssetRegistry, type IdLock } from "./manifest.js";
import { DEFAULT_MANIFEST, FIXTURE_MANIFEST } from "./paths.js";
import type { ManifestJson } from "./manifest.js";
import { readManifestJson } from "./readManifest.js";
import { MANIFEST_INDEX, loadMergedManifestWith, type ManifestFragmentRef } from "./manifest-index.js";
export { readManifestJson };

/** Node-only helpers (import "@engine/assets/node"). */
export const ASSETS_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const PACK_DIR = ASSETS_ROOT + "pack/";
export const FIXTURE_DIR = ASSETS_ROOT + "sample/";
/** Load a manifest file plus the ids.lock.json beside it (if present). */
export function loadManifestFile(path: string): ReturnType<typeof loadManifest> & { dir: string } {
  const dir = path.replace(/[^/]*$/, ""); const json = readManifestJson<ManifestJson>(path);
  const lockPath = dir + "ids.lock.json"; const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) as IdLock : undefined;
  return { ...loadManifest(json, lock ? { lock } : {}), dir };
}
/** The default content manifest (art pack). */
export const loadDefaultManifest = () => loadManifestFile(ASSETS_ROOT + DEFAULT_MANIFEST);
/** Repo root (packages/assets/../../). */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/**
 * ADR-248: art-root url prefix -> directory on disk, mirroring the client dev server's MOUNTS (apps/client/vite.config.ts)
 * for the manifest JSON the merged manifest reads (images are not needed headless).
 */
export const ART_DIRS: Readonly<Record<string, string>> = {
  "pack/": PACK_DIR, "pvp_clan/": REPO_ROOT + "assets/pvp_clan/", "stalls/": REPO_ROOT + "assets/stalls/", "ui/": REPO_ROOT + "assets/ui/",
};
const ART_URL = "http://art.invalid/";
/** Read `<art>/<rel>` from ART_DIRS (undefined if unmapped or missing). */
export function readArtJson(rel: string, dirs: Readonly<Record<string, string>> = ART_DIRS): unknown {
  for (const [prefix, dir] of Object.entries(dirs)) if (rel.startsWith(prefix)) {
    const f = dir + rel.slice(prefix.length); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined;
  }
  return undefined;
}
/**
 * ADR-248: the client's merged manifest (MANIFEST_INDEX fragments: pack + customization shards + vehicles/items/building/
 * nature/... + ids.lock) built from disk, so a dedicated server has the same cosmetics catalog (and hash) as the client.
 * The v2 character sample (CHAR_ART_V2_FRAGMENT) is sprites only and does not change cosmetics; pass it in `list` if needed.
 */
export async function loadMergedPackManifest(opts: { list?: readonly ManifestFragmentRef[]; dirs?: Readonly<Record<string, string>>; /** ADR-555: boot without the wear shards (see loadMergedManifestWith). */ excludeWearShards?: boolean } = {}): ReturnType<typeof loadMergedManifestWith> {
  const dirs = opts.dirs ?? ART_DIRS;
  return loadMergedManifestWith(opts.list ?? MANIFEST_INDEX, {
    artUrl: ART_URL,
    get: async (url) => (url.startsWith(ART_URL) ? readArtJson(decodeURIComponent(url.slice(ART_URL.length)), dirs) : undefined),
    ...(opts.excludeWearShards ? { excludeWearShards: true } : {}),
  });
}
/** The placeholder test fixture. */
export const loadFixtureManifest = () => loadManifestFile(ASSETS_ROOT + FIXTURE_MANIFEST);

/** PNG/WebP pixel size from the file header (undefined if not a readable PNG/WebP). */
export function imageSizeOf(path: string): { w: number; h: number } | undefined {
  try {
    const b = readFileSync(path);
    if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
      const kind = b.toString("ascii", 12, 16);
      if (kind === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
      if (kind === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (kind === "VP8L") { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
    }
  } catch { /* unreadable */ }
  return undefined;
}
/** validateAssetFiles against the filesystem; manifest paths resolve relative to baseDir. */
export function validateAssetFilesOnDisk(reg: AssetRegistry, baseDir: string): string[] {
  const abs = (p: string) => (p.startsWith("/") ? p : baseDir.replace(/\/?$/, "/") + p);
  return validateAssetFiles(reg, { exists: (p) => existsSync(abs(p)), imageSize: (p) => imageSizeOf(abs(p)), fileSize: (p) => (existsSync(abs(p)) ? statSync(abs(p)).size : undefined) });
}
