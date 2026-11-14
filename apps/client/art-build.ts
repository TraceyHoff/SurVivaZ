// Build-time plan for dist/art (ADR-392 / 393): which mounted files ship and which shipped JSON is rewritten.
// Everything is derived from the same merged manifest + `sourcesFromManifest` resolution the client runs at
// boot, so a file the client can request is never dropped.
// Workspace packages are imported lazily: vite.config.ts registers tsx before calling planArt.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export interface ArtMount { prefix: string; dir: string; ok: (rel: string) => boolean }
export interface ArtPlanFile { url: string; src: string; bytes: number; /** shipped JSON value (minified at write) */ json?: unknown; }
export interface ArtDrop { url: string; bytes: number; why: string }
export interface ArtPlan {
  files: ArtPlanFile[]; dropped: ArtDrop[];
  /** atlas keys whose ktx2 / masksKtx2 fields were stripped (KTX2 never read on any device path) */
  ktx2Stripped: string[];
  /** duplicate tint mask url -> canonical url (byte-identical files, ADR-393) */
  aliases: Map<string, string>;
  index: { fragments: unknown[] };
  /** art urls the client resolves (manifest sources, prefetch lists) */
  refs: Set<string>;
}
export interface ArtPlanOptions {
  /** client source roots scanned for literal file names (atlas files named only by code stay shipped) */
  codeRoots: string[];
  /** BRANDING.bg resolved by vite.config ("parallax" | "flat" | "") */
  brandingBg: string;
}

/** Atlas directories the ADR-392 reference rule applies to (pack sub-packs, Art's top-level stalls / PvP drops). */
export const ATLAS_DIR_RE = /^(?:pack\/(?:[\w-]+\/)*atlases|pvp_clan\/atlases|stalls\/atlases)\/[^/]+$/;
/** ADR-393: customization tint masks aliased when byte-identical (colour pages stay unique). */
export const TINT_ALIAS_RE = /^pack\/customization\/atlases\/[^/]+\.tintmask(?:@2x)?\.(?:png|ktx2)$/;
/** ADR-392: UI files no runtime path loads (Art's engine-pack copies, branding mocks, the flat menu bg behind parallax). */
export function uiDropReason(url: string, brandingBg: string): string | undefined {
  if (/^ui\/(?:input|hooks)\/atlas\/engine\//.test(url)) return "ui engine-pack copy";
  if (/^ui\/branding\/preview\//.test(url)) return "branding mock";
  if (/^ui\/kit\/css\//.test(url)) return "kit css frame (bundled by Vite from the CSS)";
  if (url === "ui/branding/background/menu_bg_3840x2160.png") return "unreferenced flat menu bg";
  if (url === "ui/branding/background/menu_bg_1920x1080.png" && brandingBg === "parallax") return "flat menu bg (parallax ships)";
  return undefined;
}

function walk(dir: string, rel = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n), r = rel + n; return statSync(p).isDirectory() ? walk(p, r + "/") : [r]; });
}
const CODE_RE = /\.(?:ts|tsx|js|mjs|css|html)$/;
function codeCorpus(roots: string[]): string {
  const parts: string[] = [];
  const visit = (p: string): void => {
    if (!existsSync(p)) return; const st = statSync(p);
    if (st.isDirectory()) { for (const n of readdirSync(p)) if (n !== "node_modules" && n !== "test" && n !== "dist") visit(join(p, n)); return; }
    if (CODE_RE.test(p) && !/\.test\.tsx?$/.test(p)) parts.push(readFileSync(p, "utf8"));
  };
  for (const r of roots) visit(r);
  return parts.join("\n");
}
const sha = (f: string): string => createHash("sha256").update(readFileSync(f)).digest("hex");

type Atlasish = { key?: unknown; ktx2?: unknown; masksKtx2?: unknown; pages?: unknown };
/** ADR-392: drop the KTX2 twins of `keys` from one manifest JSON (fragments and shards); returns whether it changed. */
export function stripKtx2Fields(json: unknown, keys: ReadonlySet<string>): boolean {
  const atlases = (json as { atlases?: unknown })?.atlases; if (!Array.isArray(atlases)) return false;
  let changed = false;
  for (const a of atlases as Atlasish[]) {
    if (typeof a?.key !== "string" || !keys.has(a.key)) continue;
    if ("ktx2" in a) { delete a.ktx2; changed = true; }
    if ("masksKtx2" in a) { delete a.masksKtx2; changed = true; }
    if (Array.isArray(a.pages)) for (const p of a.pages as Atlasish[]) { if (p && "ktx2" in p) { delete p.ktx2; changed = true; } if (p && "masksKtx2" in p) { delete p.masksKtx2; changed = true; } }
  }
  return changed;
}
/** ADR-393: point every manifest path naming a duplicate tint mask at its canonical file (same directory). */
export function rewriteAliases(json: unknown, byBase: ReadonlyMap<string, string>): boolean {
  let changed = false;
  const visit = (v: unknown): unknown => {
    if (typeof v === "string") { const b = v.replace(/^.*\//, ""); const c = byBase.get(b); if (c) { changed = true; return v.slice(0, v.length - b.length) + c; } return v; }
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = visit(v[i]); return v; }
    if (v && typeof v === "object") { for (const k of Object.keys(v)) (v as Record<string, unknown>)[k] = visit((v as Record<string, unknown>)[k]); return v; }
    return v;
  };
  visit(json); return changed;
}

/** Fake origin the build replays the client's art URLs against. */
const ART = "https://art.invalid/art/";
// merged fragments resolve atlas paths origin-relative ("/art/pack/..."), the pack base absolute
const relOf = (u: string): string | undefined => { const h = new URL(u, ART).href; return h.startsWith(ART) ? decodeURIComponent(h.slice(ART.length).split(/[?#]/)[0]!) : undefined; };

/**
 * The client's view of the art tree: merged registry, resolved sources, prefetch lists and the manifest JSON
 * files it fetches, read through `read(url)` (parsed JSON or undefined).
 */
export async function replayClient(read: (url: string) => unknown, index: { fragments: readonly unknown[] }): Promise<{
  registry: import("@engine/assets").AssetRegistry; sources: Map<string, import("@engine/render").AtlasSource>; fetched: string[]; refs: Set<string>; ktx2Unread: Set<string> }> {
  const A = await import("@engine/assets");
  const M = await import("@engine/render/src/assets/atlasManager.js");
  const F = await import("@engine/render/src/assets/asset-fetch.js");
  const fetched: string[] = [];
  const get = async (u: string): Promise<unknown> => { const r = relOf(u); if (r === undefined) return undefined; const j = read(r); if (j !== undefined) fetched.push(r); return j === undefined ? undefined : structuredClone(j); };
  const list = index.fragments as import("@engine/assets").ManifestFragmentRef[];
  const { result } = await A.loadMergedManifestWith(list, { get, artUrl: ART });
  const registry = result.registry;
  const sources = M.sourcesFromManifest(registry, ART + "pack/manifest.json", {}, { probeSiblings: false });
  const ktx2Unread = M.ktx2UnreadAtlases(registry, sources);
  const refs = new Set<string>(); const add = (u: string | null | undefined): void => { const r = u ? relOf(u) : undefined; if (r) refs.add(r); };
  for (const s of sources.values()) {
    add(s.url); add(s.emissiveUrl); add(s.ktx2);
    for (const v of Object.values(s.masks ?? {})) for (const u of ([] as string[]).concat(v ?? [])) add(u);
    for (const v of Object.values(s.masksKtx2 ?? {})) add(v);
    for (const p of s.pages ?? []) { add(p.url); add(p.ktx2); for (const v of Object.values(p.masksKtx2 ?? {})) add(v); }
  }
  // prefetch-art.ts warms these from the raw (non-stream) fragments
  for (const f of list) { if (f.stream) continue; const url = new URL(f.url, ART).href; const m = read(relOf(url)!); if (m === undefined) continue; for (const u of [...F.collectPrefetchUrls(m, url), ...F.collectWarmupPrefetchUrls(m, url)]) add(u); }
  return { registry, sources, fetched: [...new Set(fetched)], refs, ktx2Unread };
}

export async function planArt(mounts: readonly ArtMount[], opts: ArtPlanOptions): Promise<ArtPlan> {
  const A = await import("@engine/assets");
  const all = new Map<string, string>(); // served url -> source file
  for (const m of mounts) for (const rel of walk(m.dir).filter(m.ok)) all.set(m.prefix + rel, join(m.dir, rel));
  const parsed = new Map<string, unknown>();
  const read = (url: string): unknown => { const f = all.get(url); if (!f || !url.endsWith(".json")) return undefined; if (!parsed.has(url)) parsed.set(url, JSON.parse(readFileSync(f, "utf8"))); return parsed.get(url); };
  const index = A.servedManifestIndex((u) => all.has(u));
  const { fetched, refs, ktx2Unread, sources } = await replayClient(read, index);
  const manifests = new Set(fetched);
  const dropped: ArtDrop[] = []; const size = (u: string): number => statSync(all.get(u)!).size;
  const drop = (u: string, why: string): void => { dropped.push({ url: u, bytes: size(u), why }); all.delete(u); };

  // ADR-392: resident atlases never read their KTX2 twins: strip the fields and the files go with the reference rule
  const stripKeys = new Set([...ktx2Unread].filter((k) => { const s = sources.get(k); return !!(s?.ktx2 || s?.masksKtx2 || s?.pages?.some((p) => p.ktx2 || p.masksKtx2)); }));
  const shippedJson = new Map<string, unknown>();
  for (const u of manifests) { const j = structuredClone(read(u)); if (stripKtx2Fields(j, stripKeys)) shippedJson.set(u, j); }
  // refs as the client resolves them from the stripped manifests (no KTX2 urls for stripKeys)
  const after = await replayClient((u) => shippedJson.get(u) ?? read(u), index);
  if (after.ktx2Unread.size !== ktx2Unread.size || [...ktx2Unread].some((k) => !after.ktx2Unread.has(k))) throw new Error("[art] KTX2 strip changed atlas residency classes");
  const used = after.refs;

  // ADR-392: atlas-dir files nothing resolves (merge losers, @2x masks / emissive the client never loads,
  // layout JSON, emissive KTX2, KTX2 of resident atlases) ship only when code names them literally
  const corpus = codeCorpus(opts.codeRoots);
  const jsonCorpus = [...all.keys()].filter((u) => u.endsWith(".json") && !manifests.has(u) && !ATLAS_DIR_RE.test(u)).map((u) => readFileSync(all.get(u)!, "utf8")).join("\n");
  for (const u of [...all.keys()]) {
    const ui = uiDropReason(u, opts.brandingBg); if (ui) { drop(u, ui); continue; }
    const strippedTwin = refs.has(u) && !used.has(u) && /\.ktx2$/.test(u); // only the stripped fields named it (mirror/ included)
    if (!(ATLAS_DIR_RE.test(u) || strippedTwin) || used.has(u) || /\.hands\.json$/.test(u)) continue;
    const b = basename(u); if (corpus.includes(b) || jsonCorpus.includes(b)) continue;
    drop(u, strippedTwin ? "KTX2 of an always-resident atlas" : "not resolved by the client");
  }

  // ADR-393: byte-identical customization tint masks share one file
  const aliases = new Map<string, string>(); const groups = new Map<string, string[]>();
  for (const u of [...all.keys()].filter((x) => TINT_ALIAS_RE.test(x)).sort()) { const h = sha(all.get(u)!); (groups.get(h) ?? groups.set(h, []).get(h)!).push(u); }
  for (const g of groups.values()) for (const d of g.slice(1)) aliases.set(d, g[0]!);
  if (aliases.size) {
    const byBase = new Map([...aliases].map(([d, c]) => [basename(d), basename(c)]));
    for (const u of manifests) if (u.startsWith("pack/customization/")) { const j = shippedJson.get(u) ?? structuredClone(read(u)); if (rewriteAliases(j, byBase)) shippedJson.set(u, j); }
    for (const d of aliases.keys()) drop(d, "duplicate tint mask (aliased)");
  }

  const files: ArtPlanFile[] = [...all].sort(([a], [b]) => (a < b ? -1 : 1)).map(([url, src]) => ({ url, src, bytes: statSync(src).size,
    ...(shippedJson.has(url) ? { json: shippedJson.get(url) } : {}) }));
  return { files, dropped, ktx2Stripped: [...stripKeys].sort(), aliases, index, refs: new Set([...used].map((u) => aliases.get(u) ?? u)) };
}
