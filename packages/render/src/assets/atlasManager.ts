import { reportRenderError } from "../report.js";
/**
 * AtlasManager: GPU side of the @engine/assets registry.
 *
 * - Loads atlas images (and optional `<atlas>_emissive.png` masks) through core's ref-counted
 *   AssetManager, packs every atlas image into layers of ONE RGBA8 TEXTURE_2D_ARRAY (default 2048²,
 *   mipmapped) plus a parallel emissive array with the identical layout, so all sprites from all
 *   atlases draw in a single instanced call.
 * - Scale pages (Atlas.pages, ADR-070): the page for the current quality tier's target scale is picked with
 *   AssetRegistry.pickPage(atlas, scale) and packed instead of the 1x image; frame sizes stay in 1x px, only the
 *   uv rect changes. Mask pages (Atlas.masks emissive/sheen/sway/tintmask) share the 1x layout and are sampled by
 *   the same UVs: they are resized to the chosen page on upload, so one mask covers every scale.
 * - Status tint table (RGBA32F, 8 texels/row): row 0 = global status tints (render_tuning), one row per sprite with
 *   SpriteDef.tints overrides. The row index rides in the frame table flags.
 * - Builds a frame table (RGBA32F texture, 2 texels/entry: uv rect, size+layer+flags; flags = mask bits | tintRow << 4)
 *   indexed by `atlasBase[atlasId] + frameIndex`. Grid atlases use the manifest grid; TexturePacker
 *   atlases supply a RectTable (see texturePacker.ts).
 * - Precomputes per-sprite animation tables at load time so render-time resolution is array math
 *   (never string lookups).
 * - Wearable streaming (VRAM budget): atlases used only by cosmetics wearables are "lazy". They are not loaded at
 *   rebuild; a slot pool (extra layers of the same arrays, sized from the budget left after the resident art) holds
 *   the pages in use. pageReady(sprite) requests a page (fetch + createImageBitmap, resized to the pool scale, own
 *   mip chain) and returns false until it is uploaded, so callers draw a fallback (body only). Pages are
 *   refcounted by LayerCache entries (retainSprite/releaseSprite) and evicted LRU (unreferenced first). Budget and
 *   bytes are tracked by gl/vram.ts VramAccountant (vramStats). Mips are counted in every estimate.
 * - Runtime switching: swapAtlas()/setTheme() replace atlas images (same layout & sprite keys -> same
 *   numeric ids), so ECS data is untouched. Old images are released (ref-counted) after the swap.
 */
import { isV2BodyKey, isV2WearKey } from "../character/charArt.js";
import { AnimState as CoreAnimState, ANIM_STATE_NAMES } from "@engine/core";
import { FRAME_ANIM } from "../frame-select.js";
import { AssetRegistry, type Animation, type Atlas, type DirFrameRect, type FrameRef } from "@engine/assets";
import { STATUS_TINTS, TINT_MODE_INDEX, type StatusTint, type StatusTintName } from "../style.js";
import type { AssetManager } from "@engine/core";
import type { RectTable } from "./texturePacker.js";
import { PageLRU, PRIO_NEAR, VramAccountant, rgbaBytes, type VramStats } from "../gl/vram.js";
import { blockBytes, GL_FORMAT, ktx2Target, loadKtx2, loadKtx2Rgba, type Ktx2Target } from "./ktx2.js";
import { assetFetch, isLazyDollPageKey, withAssetSlot } from "./asset-fetch.js";
import { WARMUP_MAX_PAGES, WARMUP_POLL_MS, WARMUP_PRIO, WARMUP_WINDOW_MS, isWarmupCandidate, sortWarmupKeys, warmupPageBudget, type WarmupResult } from "./warmup.js";
import type { CompressedTextureSupport } from "../gl/capabilities.js";
import { isEnclosurePieceKey, lCornerArmPiece, streamingFallbackKeys } from "../building/modular.js";

export const NO_HEAD_OFFSET: Readonly<{ x: number; y: number }> = Object.freeze({ x: 0, y: 0 });
/** Held-item hand anchor of one character frame (Art hands.json). */
export interface HandAnchor { x: number; y: number; angle: number; len?: number; behind: boolean }
export type MaskName = "sheen" | "sway" | "tintmask";
/** Frame-table flag bits (low 4 bits of the flags float; tint row = flags >> 4). */
export const FrameBits = { Emissive: 1, Sheen: 2, Sway: 4, TintMask: 8 } as const;
/**
 * Where an atlas' images live. `pages` = extra scale pages (1x = url). `masks`: one URL or candidate URLs tried in
 * order (explicit manifest path, then sibling `<atlas>_<mask>.png`, then a fallback folder); missing ones are skipped.
 */
export interface AtlasSource { url: string; emissiveUrl?: string | null; rects?: RectTable; pages?: { scale: number; url: string; /** KTX2 twin of this page */ ktx2?: string; /** KTX2 twins of this page's masks (Art 64a18d2: body tintmask@2x) */ masksKtx2?: Partial<Record<MaskName, string>> }[]; masks?: Partial<Record<MaskName, string | string[]>>;
  /** KTX2 twins (Art 211785f): colour page (ETC1S) and masks (UASTC). Used for the streamed wearable pool when a transcode target exists. */
  ktx2?: string; masksKtx2?: Partial<Record<MaskName, string>> }
export type ImageLike = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas;

/**
 * AnimState.state -> animation names tried in order. Indexed by core's wire-stable AnimState (ADR-093); never use
 * numeric literals here. Unknown / out-of-range states resolve to idle.
 */
const STATE_ANIM_TABLE: Record<CoreAnimState, readonly string[]> = {
  [CoreAnimState.Idle]: ["idle"], [CoreAnimState.Walk]: ["walk"], [CoreAnimState.Run]: ["run", "gallop", "walk"], // ADR-319: mount sheets name their run `gallop`
  [CoreAnimState.Attack]: ["attack"], [CoreAnimState.Hurt]: ["hit", "hurt", "idle"], [CoreAnimState.Die]: ["death", "die", "idle"],
  [CoreAnimState.Gather]: ["gather", "idle"], [CoreAnimState.Build]: ["build", "idle"],
  // animals: manifest anims `eat` / `graze`, each falls back to the other, then idle
  [CoreAnimState.Eat]: ["eat", "graze", "idle"], [CoreAnimState.Graze]: ["graze", "eat", "idle"],
  // zombies: zombie_*_shamble / _crawl / _feed (pack wave 2)
  [CoreAnimState.Shamble]: ["shamble", "walk"], [CoreAnimState.Crawl]: ["crawl", "shamble", "walk"], [CoreAnimState.Feed]: ["feed", "attack", "idle"],
  // vehicle riders (ADR-101): `sit`, else idle (the body crops the legs anyway)
  [CoreAnimState.Sit]: ["sit", "idle"],
  [CoreAnimState.Swim]: ["swim", "walk", "idle"], [CoreAnimState.Punch]: ["punch", "attack", "idle"],
  // ADR-128 gathering/consume: dedicated frames when the pack has them, else the swing/eat they read as
  [CoreAnimState.Harvest]: ["harvest", "gather", "punch", "attack", "idle"], [CoreAnimState.Chop]: ["chop", "attack", "punch", "idle"],
  [CoreAnimState.Mine]: ["mine", "attack", "punch", "idle"], [CoreAnimState.Drink]: ["drink", "eat", "idle"],
  // ADR-241 v2 player states (default chains; character/animChain.ts picks walk / weapon / bed variants per entity)
  [CoreAnimState.Block]: ["block", "idle"], [CoreAnimState.Aim]: ["bow_draw", "gun_aim", "idle"],
  [CoreAnimState.Crouch]: ["crouch_idle", "idle"], [CoreAnimState.Carry]: ["carry_idle", "idle"], [CoreAnimState.Sleep]: ["sleep", "sit", "idle"],
  [CoreAnimState.BlockHit]: ["block_hit", "block", "idle"],
};
export const STATE_ANIMS: readonly (readonly string[])[] = ANIM_STATE_NAMES.map((_, i) => STATE_ANIM_TABLE[i as CoreAnimState] ?? ["idle"]);
/** @deprecated use core `AnimState` (ADR-093); kept as an alias so render callers read one numbering. */
export { CoreAnimState as AnimStateId };

/** ADR-380: exported so buildSpriteTables (public) can name its tables in its signature. */
export interface SpriteRT {
  atlasIdx: number; anchorX: number; anchorY: number;
  anims: Animation[];
  /** per anim: atlas index of each dirFrames entry (facing-split pages, Art 62e55cf), or null (legacy layout via frame()) */
  dirAt: (Int32Array | null)[];
  /** per anim: atlas-local frame of each dirFrames entry (`frame`, or the shared extra entry of an explicit `rect`) */
  dirF: (Int32Array | null)[];
  /** state -> index into anims */
  stateAnim: Int16Array;
  /** "damaged"/"damage1.." frames for build pieces: list of frame indices per stage (stage 0 = idle). */
  damage: number[];
  /** From the manifest's `building` block: footprint, layer, frames[rotation][damageStage]. */
  building?: { fw: number; fh: number; layer: number; frames: number[][] };
}
/** ADR-380: exported so buildSpriteTables (public) can name its atlas rows in its signature. */
export interface AtlasRT { key: string; id: number; source: AtlasSource; img: ImageLike | null; emis: ImageLike | null; scale: number;
  masks: Partial<Record<MaskName, ImageLike>>; maskUrls: Partial<Record<MaskName, string>>; base: number; count: number; fw: number; fh: number; cols: number; layer: number; px: number; py: number;
  /** streamed wearable page: not loaded at rebuild (see header); w1/h1 = 1x page size */ lazy?: { w1: number; h1: number; state: 0 | 1 | 2; pool: number; prio?: number };
  /** budget tier: cold art is downscaled before hot art (see fitBudget) */ cold?: boolean;
  /** explicit dirFrames rects (deduped), frame-table entries n0.. after the grid/TexturePacker frames */ extra?: { n0: number; rects: DirFrameRect[]; byKey: Map<string, number>; /** ADR-190: same index by rect object (no string key per lookup) */ byRect: Map<DirFrameRect, number> } }
/** One streaming pool (wearables, vehicles): own slot geometry, layers and LRU; all pools share the VRAM accountant. */
/** ADR-220: pool classes holding paper-doll character art: always RGBA8 from the PNG, never ETC1S. */
export const LOSSLESS_CHAR_MIN_MB = 448;
/**
 * ADR-220: character pages are uploaded from the PNG (RGBA8, exact) instead of the ETC1S twin when the atlas budget is a
 * desktop or ultra-console one (>= 448 MB). Lower budgets (console 256, mobile 128, lowmem/safe 160) cannot hold the 4x larger wear
 * working set without crushing vehicles/buildings to 0.25x (measured: 130 -> 246 MB at 160), so they keep ETC1S.
 */
export function losslessCharPools(budgetMB: number): boolean { return budgetMB >= LOSSLESS_CHAR_MIN_MB; }
export const CHAR_POOL_CLS: ReadonlySet<PoolClass> = new Set<PoolClass>(["body", "wear"]);
interface Pool { k: number; sw: number; sh: number; /** slot pitch (16-aligned: KTX2 4x4 blocks stay aligned down to mip 2) */ pw: number; ph: number; cols: number; perLayer: number; first: number; layers: number; lru: PageLRU<string>; slotBytes: number; tint: boolean; emis: boolean; cls: PoolClass;
  /** wear pool: its own colour array (poolTex), KTX2-compressed (`fmt` = GL internal format) or RGBA8 (fmt null), `levels` mips only */
  own?: { fmt: number | null; target: Ktx2Target | null; levels: number } }
export type PoolClass = "wear" | "veh" | "bld" | "body" | "stream";
/** Max mip levels of the compressed tail array: slot pitch is 16-aligned, so offsets stay 4x4-block aligned down to level 2. */
const OWN_MAX_LEVELS = 3;
/** Vehicle art pages kept resident at once (one page = one grouped Art sheet, ~1024^2 at 1x): desktop / low memory. */
// 15 Art vehicle sheets exceed 1020px at 1x, so the vehicle pool slot is a whole 2048 layer (1 vehicle/layer, 6.7 MB ASTC);
// once every 1x sheet fits 1020x1020 a layer holds 4 (6 slots: 13 MB instead of 40)
const VEH_POOL_SLOTS_DESKTOP = 8, VEH_POOL_SLOTS_LOWMEM = 6;
/** Building tier pages (building_t1..t4) resident at once: every tier on desktop; 2 on <=256 MB budgets (a base mixes ~2 tiers). */
const BLD_POOL_SLOTS_DESKTOP = 4, BLD_POOL_SLOTS_LOWMEM = 4; // ADR-211: one slot per tier page (0.7 MB each at 0.5x): 2 slots thrashed a mixed-tier base onto the legacy fallback art
/** Building tier sheets streamed per tier present nearby (BuildingTierStreamer): `building_t<N>` atlases from files. */
export function isStreamedBuildingAtlas(key: string, url: string): boolean { return /^building_t\d+$/.test(key) && !/^(blob|data):/.test(url); }
/** ADR-244 (b): v2 per-group sheets (`<core>__combat|ranged|pose|sleep`) stream in the stream pool; only the core sheet
 *  stays resident in the body / wear pools. */
export const isV2StreamSheet = (key: string): boolean => /^v2s?_.*__(combat|ranged|pose|sleep)$/.test(key);
/** Character body sheets (`body_*`): with a KTX2 target they live compressed in the tail array (body pool), not RGBA8. */
export function isBodyAtlasKey(key: string): boolean { return /^body_/.test(key); }
/** Every page character bodies draw from (sprite.atlas + multi-page dirFrames pages, e.g. a swim/punch page), whatever its key. */
export function bodyAtlasKeys(registry: AssetRegistry): Set<string> {
  const cat = registry.cosmetics as unknown as { bodySprite?: (b: string) => { sprite: number } | undefined } | undefined;
  const out = new Set<string>(); const ids = new Set<number>();
  for (const s of registry.allSprites()) if (isBodyAtlasKey(s.atlas.key) || isV2BodyKey(s.key)) ids.add(s.id); // ADR-240: v2 body sheets
  try { for (const b of ["male", "female"]) { const x = cat?.bodySprite?.(b); if (x) ids.add(x.sprite); } } catch { /* catalog shape differs: key rule only */ }
  for (const s of registry.allSprites()) if (ids.has(s.id)) { out.add(s.atlas.key); for (const a of s.animList) for (const d of a.dirFrames ?? []) out.add(d.atlas.key); }
  for (const k of out) if (isV2StreamSheet(k)) out.delete(k); // ADR-244 (b)
  for (const k of out) if (isLazyDollPageKey(k)) out.delete(k); // ride / crouch body pages stream (wear pool), never eager
  return out;
}
/** Art vehicle sheets: `veh_*` atlases loaded from files (the procedural placeholders are blob: URLs and stay resident). */
export function isStreamedVehicleAtlas(key: string, url: string): boolean { return /^veh_/.test(key) && !/^(blob|data):/.test(url); }
/** Minimum streamed pages kept resident at once (working set: ~8 wearables x a few distinct outfits on screen). */
/** Emissive + mask arrays are stored at layerSize >> SIDE_SHIFT (same normalized UVs, 1/4 the bytes). */
export const SIDE_SHIFT: number = 1;
/** Low-memory (mobile) side arrays at 1/4 res: masks / emissive are cold-tier data (lights, tint, sheen), the colour
 *  array stays full res so visible art never gets blurrier to save memory. */
export const SIDE_SHIFT_LOWMEM: number = 2;
const POOL_MIN_SLOTS_DESKTOP = 48, POOL_MIN_SLOTS_LOWMEM = 24, POOL_GAP = 4, PAGE_CONCURRENCY = 6, POOL_PROTECT_FRAMES = 90;
/** 1x wear pool slots when the budget cannot hold minSlots at 1x: the local player's worn set + the nearest neighbour's (~9 layers each); farther characters page by distance priority. */
/** Manifest residency "stream" sheets (crops, saplings, clutter, ADR-110 animals): pool slots, page-in starts per
 *  frame (upload budget), frames off-screen before a page is dropped (~3 s at 60 fps; touched again inside the keep
 *  radius = hysteresis), and screen-px margins around the view: load radius, keep radius (x1.5), animals (move into view). */
/** ADR-148: GPU page uploads per frame (see uploadTurn). */
export const PAGE_UPLOADS_PER_FRAME = 2;
export const STREAM_POOL_SLOTS_DESKTOP = 24, STREAM_POOL_SLOTS_LOWMEM = 12, STREAM_UPLOADS_PER_FRAME = 2, STREAM_UNLOAD_FRAMES = 180;
/** ADR-314: stream pages larger than this (either side, 1x px) are planned in their own pool (see splitStreamPages). */
export const STREAM_PAGE_MAX_PX = 1024;
export const BIG_STREAM_SLOTS_DESKTOP = 2, BIG_STREAM_SLOTS_LOWMEM = 1;
/** ADR-314: [regular, oversize] stream pages; an oversize page in the regular pool would size every slot to it. */
export function splitStreamPages<T extends { lazy?: { w1: number; h1: number } | null }>(pages: readonly T[], maxPx = STREAM_PAGE_MAX_PX): [T[], T[]] {
  const small: T[] = [], big: T[] = [];
  for (const a of pages) (Math.max(a.lazy?.w1 ?? 0, a.lazy?.h1 ?? 0) > maxPx ? big : small).push(a);
  return [small, big];
}
export const STREAM_MARGIN_PX = 256, STREAM_MARGIN_ANIMAL_PX = 640, STREAM_KEEP_FACTOR = 1.5;
const WEAR_1X_SLOTS_LOWMEM = 18, WEAR_1X_SLOTS_DESKTOP = 32;
/** Wear pages whose 1x size fits WEAR_SMALL_PX square (faces, eyes, shoes, small accessories: ~1/3 of the MaxRects-
 *  trimmed customization pages) get their own wear pool sized to them: 672 + 2x688 pitch = 2048 -> 3x3 slots per 2048 layer instead
 *  of the 2x2 the largest (1016px hair/coat) pages force on everyone. Split only when each side has >= WEAR_SPLIT_MIN pages and layers are >= 2048 (at 1024 every slot is one layer, so splitting
 *  only shrinks the large pool and thrashes it: spMobile 146.2 MB / 256 misses vs 140.5 MB / 85). */
export const WEAR_SMALL_PX = 672, WEAR_SPLIT_MIN = 4;
/** ADR-251: the streamed wearables pools together never take more than this share of the atlas budget (they page by
 *  distance priority / LRU instead); the visible pools (buildings, vehicles, stream sheets incl. furniture-tier and gt
 *  ground pages) keep their 1x working set reserved ahead of them. */
export const WEAR_BUDGET_SHARE = 0.3;
/** ADR-251: the 1x wear floor kept even when the cap is tight: one fully dressed character (a worn set is ~8 pages). */
export const WEAR_FLOOR_SLOTS = 4;
/** ADR-251: budget share of the stream-sheet pool's 1x working set, and its floor (slots). */
export const STREAM_BUDGET_SHARE = 0.25, STREAM_FLOOR_SLOTS = 4;

export interface SwayParams { amp: number; freq: number; stiffness: number }
/** Read optional per-sprite `sway: {amp, freq, stiffness}` blocks from raw manifest JSON (loadManifest ignores them). */
export function swayFromManifest(json: unknown): { table: Record<string, SwayParams>; issues: string[] } {
  const table: Record<string, SwayParams> = {}; const issues: string[] = [];
  const sprites = (json as { sprites?: unknown[] } | null)?.sprites; if (!Array.isArray(sprites)) return { table, issues };
  for (const sp of sprites as { key?: string; sway?: Partial<SwayParams> }[]) {
    if (!sp?.sway || !sp.key) continue; const w = sp.sway;
    if (![w.amp, w.freq].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) { issues.push(`${sp.key}: bad sway`); continue; }
    table[sp.key] = { amp: w.amp!, freq: w.freq!, stiffness: typeof w.stiffness === "number" ? w.stiffness : 0.5 };
  }
  return { table, issues };
}
export interface AtlasStats { layers: number; layerSize: number; /** atlas images scaled by this to fit the GPU memory budget (1 = full res) */ downscale: number; gpuMB: number; atlases: number; frames: number; sprites: number; version: number }

/** ADR-154 / ADR-187: budgets at or above this skip the per-page-in glGetError sync (200: console 256/448 skip it, mobile 128/160 keep it) */
export const SYNC_CHECK_MAX_MB = 200;
const TABLE_W = 1024; // entries per frame-table row

/**
 * Image sources for every atlas of a manifest-loaded registry: scale pages (Atlas.pages) and masks (Atlas.masks).
 * `resolve` maps a manifest image path to a URL (default: relative to the manifest URL). Masks the manifest does not
 * name are looked up as siblings `<atlas image stem>_<mask>.png` and then under `fallbackMaskDirs[mask]`.
 */
export function sourcesFromManifest(registry: AssetRegistry, manifestUrl: string, rects: Record<string, RectTable> = {},
  opts: { resolve?: (path: string) => string; fallbackMaskDirs?: Partial<Record<MaskName, string>>; probeSiblings?: boolean } = {}): Map<string, AtlasSource> {
  const base = manifestUrl.replace(/[^/]*$/, "");
  const resolve = opts.resolve ?? ((p: string) => (/^(\/|[a-z]+:)/i.test(p) ? p : base + p));
  const out = new Map<string, AtlasSource>();
  for (const a of registry.atlases.values()) {
    const r = rects[a.key];
    // KTX2 twins sit beside the image: resolve them like the image (the client rewrites image paths of merged packs)
    const img = resolve(a.image); const sib = (p: string): string => (/^(\/|[a-z]+:)/i.test(p) ? p : img.replace(/[^/]*$/, "") + p.replace(/^.*\//, ""));
    const pages = (a.pages ?? []).filter((p) => p.scale !== 1).map((p) => { const k2 = (p as { ktx2?: unknown }).ktx2; const pm: Partial<Record<MaskName, string>> = {};
      for (const [m, v] of Object.entries((p as { masksKtx2?: Record<string, unknown> }).masksKtx2 ?? {})) if (typeof v === "string") pm[m as MaskName] = sib(v);
      return { scale: p.scale, url: resolve(p.image), ...(typeof k2 === "string" ? { ktx2: sib(k2) } : {}), ...(Object.keys(pm).length ? { masksKtx2: pm } : {}) }; });
    const masks: Partial<Record<MaskName, string[]>> = {};
    for (const m of ["sheen", "sway", "tintmask"] as const) {
      const c: string[] = []; const explicit = a.masks?.[m];
      if (explicit) c.push(resolve(explicit));
      if (opts.probeSiblings !== false) c.push(resolve(a.image).replace(/(\.[a-z]+)$/i, `_${m}$1`));
      const dir = opts.fallbackMaskDirs?.[m]; if (dir) c.push(`${dir.replace(/\/?$/, "/")}${a.image.replace(/^.*\//, "").replace(/(\.[a-z]+)$/i, `_${m}$1`)}`);
      if (c.length) masks[m] = [...new Set(c)];
    }
    const mk2: Partial<Record<MaskName, string>> = {}; for (const m of ["sheen", "sway", "tintmask"] as const) { const v = a.masksKtx2?.[m as keyof typeof a.masksKtx2]; if (typeof v === "string") mk2[m] = sib(v); }
    out.set(a.key, { url: resolve(a.image), emissiveUrl: a.emissiveImage ? resolve(a.emissiveImage) : null, ...(r ? { rects: r } : {}), ...(pages.length ? { pages } : {}), masks,
      ...(a.ktx2 ? { ktx2: sib(a.ktx2) } : {}), ...(Object.keys(mk2).length ? { masksKtx2: mk2 } : {}) });
  }
  return out;
}

/** 1x1 transparent array (stands in for unused emissive / mask arrays). */
function dummyArray(gl: WebGL2RenderingContext): WebGLTexture {
  const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 1, 1, 1);
  gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  setLevelRange(gl, gl.TEXTURE_2D_ARRAY, 1);
  return t;
}

/** Texture completeness: BASE/MAX_LEVEL = the levels actually allocated; a single level uses LINEAR (no mip filter).
 *  `magNearest`: magnify with NEAREST (pixel-art doll at an integer scale, e.g. the character preview). */
export function setLevelRange(gl: WebGL2RenderingContext, target: number, levels: number, magNearest = false): void {
  gl.texParameteri(target, gl.TEXTURE_BASE_LEVEL, 0);
  gl.texParameteri(target, gl.TEXTURE_MAX_LEVEL, Math.max(0, levels - 1));
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, magNearest ? gl.NEAREST : gl.LINEAR);
}

/** Smallest atlas budget downscale (x0.125 below the old x0.25 floor: phones that refuse 107 MB of arrays). */
export const MIN_ATLAS_DOWNSCALE = 0.125;

export type AtlasTier = "hot" | "cold";
/** Always hot: terrain, bodies/characters, common props, UI and fonts. */
export const HOT_ATLAS_RE = /(^|[_/-])(tiles?|terrain|ground|characters?|bod(y|ies)|base|resources|decor|items|animals|equipment|held|buildings?|openings|furniture|fog|ui|fonts?|sdf)([_@/-]|$)/i;
/** Cold: rare variants, distant LODs, one-shot fx, huge set pieces. Anything matching neither stays hot. */
/** ADR-145: pixel-art creature sheets sampled crisp (sharp bilinear) when magnified.
 * Task 17: zombie sheets join them in the idle-demotion exclusion below (fitBudget's
 * `idle` filter): zombies were the one fidelity-pinned creature family that could be
 * demoted to the cold tier (x0.125) while off-screen, unlike animals / pets / critters. */
export const CRISP_ATLAS_RE = /^(animals|pets|nature_critters|zombies)(_|$)/;
/** Crisp sampling for all world art (not just creatures): the style guide's art is "crisp at 1x (close to
 *  pixel-art clarity)", but on a DPR 2-3 phone a 1x frame is magnified ~3x, so plain LINEAR magnification smears
 *  ground, characters and buildings into the blur in the screenshot -- on every preset, not just Full. Only soft
 *  art stays bilinear: UI, fog, and particle FX (vfx / se_fx / weather flakes), which must stay soft when scaled. */
export const NON_CRISP_ATLAS_RE = /^(ui|fog|vfx|se_fx|season_(snowflake|blizzard|heat_haze))(_|$)/;
/** ADR-211: player-built art (resident building tiers, openings, furniture, defenses). Demoted to the cold tier last:
 *  the idle demotion ran before any base was on screen and stored them at x0.125 (walls drawn as orange blobs). */
export const BUILD_ATLAS_RE = /^(buildings?(_[a-z0-9]+)?|openings|furniture|defenses)$/;
/** ADR-156: creature sheets (wild critters, pets: 62 small sheets, ~4.8 MPx) load resident instead of through the stream
 *  pool. One species spans 4-11 frame-size sheets, so 12-24 fixed (704x400) stream slots starved as soon as a few species
 *  were near: the rest drew the soft placeholder blob and ETC1S-compressed pages -> "blurry animals" while bushes (resident) stayed sharp. */
/** ADR-237: lowered from 384 to the mobile budget (128): with FIDELITY_ATLAS_RE pinning, a phone keeps the creature sheets
 *  resident (drawn ones x1, the rest x0.5 hot) instead of the stream pool's ETC1S x0.25 slots (8x8 texel critters). */
export const RESIDENT_CREATURE_MIN_MB = 128;
export const RESIDENT_CREATURE_RE = /^(pets|nature_critters)_/;
/** ADR-246: gt_ ground pages (manifest residency "stream") load resident + hot on >= RESIDENT_CREATURE_MIN_MB budgets: in the
 *  stream pool's ETC1S x0.25 slots every 68x52 cell became a flat colour diamond (a visible tile grid, no texture). */
export const RESIDENT_GROUND_RE = /^gt_/;
/** ADR-237: creature, character and zombie sheets (small pixel art, magnified ~2-4x on a dpr-3 phone) keep x1 when the
 *  budget halves the hot tier: the rest of the hot art takes the x0.5, these never become 2x-magnified mush (mobile only
 *  ever ran them at x0.5 / the stream pool's x0.25 - "animals blurry on mobile, sharp on desktop"). */
/** ADR-240: + the v2 character sheets (v2s_* sample, v2_* full set): same x1 pin as the v1 characters. */
/** ADR-251: hot resident art pinned at 1x like FIDELITY_ATLAS_RE while the rest of the hot tier is halved: furniture (bed +
 *  sleeper read as a blurred quarter-size smear) and the gt ground pages (ADR-246 wanted them 1x; fitBudget halved them).
 *  Base building pieces join them: a halved buildings atlas is the blurry-wall complaint, and walls are what the
 *  camera sits on just as much as the ground under them. */
export const VISIBLE_PIN_RE = /^(gt_|furniture(_|$)|buildings?(_|$)|openings(_|$)|defenses(_|$))/;
export const FIDELITY_ATLAS_RE = /^(animals|pets|nature_critters|characters|zombies|v2s?)(_|$)/;
/** ADR-149: hi-res painted pet sheets (streamed, drawn well below their stored size: need the mip tail). */
export const PET_SHEET_RE = /^pets_/;
export const COLD_ATLAS_RE = /(^brand_|lod\d*|_far|distant|rare|_huge|_big|^fx_|death_bag|critters|wear|cosmetic|hair|hats?|accessor|tops?|bottoms?|shoes|faces?|eyes)/i; // Task 17: zombie variants (brute/mummy/pumpkin/runner) are core enemies, not rare variants — they no longer default to the cold tier
/** Default tier: HOT_ATLAS_RE wins; atlases holding body sprites are hot; COLD_ATLAS_RE or mostly-wearable atlases are cold. */
export function defaultAtlasTier(key: string, opts: { bodies?: boolean; wearShare?: number } = {}): AtlasTier {
  if (opts.bodies || HOT_ATLAS_RE.test(key)) return "hot";
  if (COLD_ATLAS_RE.test(key) || (opts.wearShare ?? 0) >= 0.5) return "cold";
  return "hot";
}

/**
 * ADR-190: every rebuild-time resize goes through resizeImage. Chrome does the createImageBitmap resize of an
 * ImageBitmap synchronously inside the call, so the old `Promise.all(list.map(createImageBitmap))` ran ~100 resizes in one
 * task (a 0.3-0.8 s freeze on every re-tier). Now (1) results are memoized per source image + size + filter, so a re-tier
 * reuses the resizes of the previous rebuild (same pixels: same source, same options), and (2) uncached resizes are
 * serialized and time-sliced: after RESIZE_SLICE_MS of resize work the next one waits for the next frame.
 */
export const RESIZE_SLICE_MS = 6;
/** ADR-190: re-tier hysteresis - consecutive positive checks (IsoRenderer checks every 30 frames) and minimum spacing. */
export const RETIER_CONFIRM = 3;
export const RETIER_MIN_GAP_FRAMES = 1800;
const RESIZE_CACHE_PER_SOURCE = 2;
const resizeCache = new WeakMap<object, Map<string, Promise<ImageLike>>>();
let resizeChain: Promise<unknown> = Promise.resolve(); let sliceStart = -1; let pendingJobs = 0;
/** stats for tests / diag: resizes actually run, cache hits, frame yields */
export const resizeStats = { runs: 0, hits: 0, yields: 0 };
const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
const nextFrame = (): Promise<void> => new Promise<void>((r) => { if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(r, 0)); else setTimeout(r, 0); });
let yieldImpl = nextFrame; let sliceClock = now;
/** Tests: replace the "wait for the next frame" primitive and the clock used by the slicer (null: defaults). */
export function setResizeYield(y: (() => Promise<void>) | null, clock?: () => number): void { yieldImpl = y ?? nextFrame; sliceClock = clock ?? now; }
/**
 * ADR-380: boot runs the same resizes as a re-tier (fitBudget / halveSide / fitToPage) but has no frames to protect —
 * the 6 ms slice + frame yield turns ~1 s of resize CPU into several seconds of wall time (one frame per slice: at
 * 60 fps each 6 ms of resize work costs ~16 ms of wall, so the resizes alone can stretch boot by a low-single-digit
 * multiple of their own CPU time). IsoView.create disables slicing around the initial setRegistry only; re-tiers keep
 * it on, so a mid-game re-tier still cannot freeze a frame. Only call while no resize jobs are in flight (the toggle
 * resets the slice clock, so a job mid-slice would lose its budget).
 */
let slicingEnabled = true;
export function setResizeSlicing(on: boolean): void { slicingEnabled = on; sliceStart = -1; }
/** Run `job` serialized behind earlier jobs; yields one frame first once the current slice spent RESIZE_SLICE_MS. */
export function sliced<T>(job: () => Promise<T> | T): Promise<T> {
  pendingJobs++;
  const run = async (): Promise<T> => {
    try {
      if (sliceStart < 0) sliceStart = sliceClock();
      if (slicingEnabled && sliceClock() - sliceStart >= RESIZE_SLICE_MS) { resizeStats.yields++; await yieldImpl(); sliceStart = sliceClock(); }
      return await job();
    } finally { if (--pendingJobs === 0) sliceStart = -1; }
  };
  const p = resizeChain.then(run, run); resizeChain = p.catch(() => undefined); return p;
}
export function resizeImage(im: ImageLike, w: number, h: number, q: "high" | "pixelated"): Promise<ImageLike> {
  const key = `${w}x${h}:${q}`; let m = resizeCache.get(im as object); if (!m) resizeCache.set(im as object, (m = new Map()));
  const hit = m.get(key); if (hit) { resizeStats.hits++; m.delete(key); m.set(key, hit); return hit; }
  const p = sliced(() => { resizeStats.runs++; return createImageBitmap(im as ImageBitmapSource, { resizeWidth: w, resizeHeight: h, resizeQuality: q, premultiplyAlpha: "none", colorSpaceConversion: "none" } as ImageBitmapOptions) as Promise<ImageLike>; });
  m.set(key, p); p.catch(() => m!.delete(key));
  while (m.size > RESIZE_CACHE_PER_SOURCE) m.delete(m.keys().next().value!);
  return p;
}
const resizeBy = (im: ImageLike, k: number, q: "high" | "pixelated"): Promise<ImageLike> => resizeImage(im, Math.max(1, Math.floor(im.width * k)), Math.max(1, Math.floor(im.height * k)), q);

/** Halve emissive + mask images for the half-size side arrays (no-op without createImageBitmap). */
async function halveSide(list: AtlasRT[], shift: number = SIDE_SHIFT): Promise<boolean> {
  if (typeof createImageBitmap !== "function" || shift === 0) return false;
  const k = 1 / (1 << shift);
  await Promise.all(list.map(async (a) => { if (a.emis) a.emis = await resizeBy(a.emis, k, "high"); for (const m of Object.keys(a.masks) as MaskName[]) a.masks[m] = await resizeBy(a.masks[m]!, k, "pixelated"); }));
  return true;
}

/** Downscale every image of the list by k (colour/emissive smooth, masks pixelated); frame sizes stay in 1x px via a.scale. */
async function scaleList(list: AtlasRT[], k: number): Promise<void> {
  if (typeof createImageBitmap !== "function") return;
  await Promise.all(list.map(async (a) => {
    a.img = await resizeBy(a.img!, k, "high"); if (a.emis) a.emis = await resizeBy(a.emis, k, "high");
    for (const m of Object.keys(a.masks) as MaskName[]) a.masks[m] = await resizeBy(a.masks[m]!, k, "pixelated");
    a.scale *= k;
  }));
}

/** Resize a mask to the chosen page size (masks share the 1x layout; sampled by the same UVs). null when impossible. */
async function fitToPage(img: ImageLike, w: number, h: number): Promise<ImageLike | null> {
  if (img.width === w && img.height === h) return img;
  if (typeof createImageBitmap !== "function") return null;
  if (Math.abs(img.width / img.height - w / h) > 0.01) return null; // not the same layout
  return resizeImage(img, w, h, "pixelated");
}

export async function defaultImageLoader(url: string): Promise<ImageLike> {
  return withAssetSlot(async () => {
    const res = await assetFetch(url);
    if (!res.ok) throw new Error(`image fetch failed ${res.status}: ${url}`);
    return createImageBitmap(await res.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  });
}

export class AtlasManager {
  readonly layerSize: number;
  tex: WebGLTexture | null = null;
  /** Wearable pool colour array (compressed when KTX2 is usable); sampled for layers >= poolFirst (shader uPoolFirst). */
  poolTex: WebGLTexture | null = null; poolFirst = 1 << 20;
  private compressedCaps: CompressedTextureSupport | null = null;
  /** GPU compressed-texture support (IsoRenderer passes capabilities.compressed); KTX2 is used only with a transcoder installed. */
  setCompressed(c: CompressedTextureSupport | null): void { this.compressedCaps = c; }
  get ktx2Target(): Ktx2Target | null { return this.compressedCaps ? ktx2Target(this.compressedCaps) : null; }
  /**
   * Device px per 1x texel of nearby characters (camera scale x sprite scale), set every frame by IsoRenderer. The wear
   * pool is stored at the smallest page scale whose texels are still >= 1 device px (never blurrier than the 1:1 mip):
   * magnified (r >= 1) -> 1x with no mip chain (levels never sampled are not allocated).
   */
  charFootprint = 1;
  /** Magnify atlas/pool arrays with NEAREST instead of LINEAR (set before setRegistry; the character preview draws at an
   *  integer device scale and must stay as crisp as Canvas2D's imageSmoothingEnabled = false). */
  magNearest = false;
  setCharFootprint(r: number): void { if (r > 0 && Number.isFinite(r)) this.charFootprint = r; }
  wearScale(): number { const r = this.charFootprint; return r > 0.5 ? 1 : r > 0.25 ? 0.5 : 0.25; }
  private wearPool(): Pool | undefined { return this.pools.find((p) => p.cls === "wear"); }
  /** Colour bytes of one layer of the own wear array (vs rgbaBytes(S,S,true) in the shared array). */
  private ownLayerBytes(o: NonNullable<Pool["own"]>): number { let b = 0, s = this.layerSize; for (let l = 0; l < o.levels; l++, s = Math.max(1, s >> 1)) b += o.fmt !== null ? blockBytes(s, s) : s * s * 4; return b; }
  private ownSaving(): number { return this.pools.reduce((t, p) => t + (p.own ? p.layers * (rgbaBytes(this.layerSize, this.layerSize, true) - this.ownLayerBytes(p.own)) : 0), 0); }
  /**
   * Streamed pools (vehicles, then wearables) are the tail layers: give them their own colour array, KTX2-compressed
   * (ETC1S -> probe target, level 0) when every streamed atlas has a KTX2 twin and pages are 1x, else RGBA8. Only the
   * levels that are sampled are allocated: magnified (footprint >= page scale) -> 1 level.
   */
  /** Side-array bytes not allocated for pool layers (sheen/sway always, emissive unless a pool streams emissive). */
  private sideSaving(list: AtlasRT[]): number {
    const h = Math.max(1, this.layerSize >> this.sideShift); const poolLayers = this.pools.reduce((t, p) => t + p.layers, 0);
    const skipped = (["sheen", "sway"] as const).filter((m) => list.some((a) => a.masks[m])).length + (!this.pools.some((p) => p.emis) && list.some((a) => a.emis) ? 1 : 0);
    return poolLayers * skipped * rgbaBytes(h, h, true);
  }
  /** KTX2 level of an atlas's file feeding pool level 0, and the scale it is stored at: 2x pools read the @2x KTX2 (1x-only
   *  sheets: the 1x file at scale 1), k <= 1 pools skip log2(1/k) levels of the 1x file (magnified top levels never sampled). */
  private ownSource(a: AtlasRT, k: number): { url: string | undefined; base: number; scale: number } {
    if (k >= 2) { const p2 = a.source.pages?.find((q) => q.scale === 2) as { scale: number; url: string; ktx2?: string } | undefined; return p2?.ktx2 ? { url: p2.ktx2, base: 0, scale: 2 } : { url: a.source.ktx2, base: 0, scale: 1 }; }
    return { url: a.source.ktx2, base: Math.max(0, Math.round(Math.log2(1 / k))), scale: k };
  }
  /** Mip levels the tail array needs at the current on-screen footprint: stored texels per device px = k / footprint;
   *  magnified (<= 1) -> level 0 only; minified by m -> ceil(log2 m) + 1 levels (trilinear), at most OWN_MAX_LEVELS. */
  private ownLevelsFor(pools: Pool[]): number {
    let n = 1; for (const p of pools) { if (p.cls === "body") continue; const m = Math.log2(p.k / this.charFootprint); if (m > 0) n = Math.max(n, Math.ceil(m) + 1); }
    // ADR-149: hi-res painted pet sheets (704px frames) are drawn far below their stored size, independent of the character
    // footprint: without the mip tail they were point-sampled from level 0 (sparkly, then smeared by the upscale = "blurry")
    if (pools.some((p) => p.cls === "stream") && this.streamPets) n = OWN_MAX_LEVELS;
    return Math.min(OWN_MAX_LEVELS, n);
  }
  /** ADR-149: a streamed pool holds hi-res pet sheets (set by upload before planOwn). */
  private streamPets = false;
  private tailPools(): Pool[] { return [...this.pools].sort((x, y) => x.first - y.first); }
  /**
   * Streamed pools (building tiers, bodies, vehicles, wearables) are the tail layers: they get their own colour array, KTX2-compressed
   * (ETC1S -> probe target, full mip chains) when every tail atlas has a KTX2 twin and every pool scale is a power of two
   * <= 2 (the KTX2 mips are those scales), else RGBA8. Only sampled levels are allocated (ownLevelsFor).
   */
  private planOwn(): void {
    for (const p of this.pools) delete p.own;
    // ADR-220: with the VRAM for it, character pools (body/wear) are not part of the compressed tail (lossless paper-doll art)
    const lossless = losslessCharPools(this.textureBudgetMB);
    const tail = this.tailPools().filter((p) => !lossless || !CHAR_POOL_CLS.has(p.cls));
    if (!tail.length) return;
    let at = tail[0]!.first; for (const p of tail) { if (p.first !== at) return; at += p.layers; } if (at !== this.layers) return;
    const t = this.ktx2Target; const pow2 = (k: number) => k <= 2 && Number.isInteger(Math.log2(k));
    const comp = t !== null && tail.every((p) => pow2(p.k)) && this.atlases.every((a) => !a.lazy || !tail.includes(this.poolOfA(a)!) || !!a.source.ktx2);
    const levels = this.ownLevelsFor(tail);
    for (const p of tail) {
      p.own = { fmt: comp ? GL_FORMAT[t!][0] : null, target: comp ? t : null, levels };
      let cb = 0; for (let l = 0, w = p.sw, h = p.sh; l < levels; l++, w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) cb += comp ? blockBytes(w, h) : w * h * 4;
      p.slotBytes = p.slotBytes - rgbaBytes(p.sw, p.sh, true) + cb;
    }
  }
  emisTex: WebGLTexture | null = null;
  /** sheen (R sheen, G darken, B drip spawn), sway weight (R) and tint mask arrays, same layout as `tex`. */
  sheenTex: WebGLTexture | null = null; swayTex: WebGLTexture | null = null; tintMaskTex: WebGLTexture | null = null;
  /** Status tint table (see header). */
  tintTex: WebGLTexture | null = null;
  frameTex: WebGLTexture | null = null;
  /** Target page scale (quality tier x dpr x zoom); pages are chosen with AssetRegistry.pickPage. */
  private pageScale = 1;
  private statusTints: Record<StatusTintName, StatusTint> | null = null;
  private tintRows: (Record<string, { color: number; strength: number; mode: string; saturation?: number }> | null)[] = [null];
  private maskPixels = new Map<string, { w: number; h: number; data: Uint8ClampedArray } | null>();
  registry: AssetRegistry | null = null;
  /** Bumped on every successful (re)build. */
  version = 0;
  private atlases: AtlasRT[] = [];
  private atlasById = new Map<number, AtlasRT>();
  private sprites: (SpriteRT | undefined)[] = [];
  private held: [string, string][] = []; // (kind,url) pairs held in AssetManager
  private themes = new Map<string, Record<string, AtlasSource>>();
  private baseSources = new Map<string, AtlasSource>();
  /** Image sources passed to setRegistry (e.g. for a second renderer / the creator preview). */
  get sources(): ReadonlyMap<string, AtlasSource> { return this.baseSources; }
  private layers = 0; private maxLayers = 256;
  private totalFrames = 0;
  private hasEmissive = false;
  static readonly IMAGE_KIND = "render:image";
  private swayByKey = new Map<string, SwayParams>();
  private swayById: (Float32Array | undefined)[] = [];
  /** Stream cosmetics-only atlases through the page pool (false = load everything at rebuild, the old behaviour). */
  streamWearables = true;
  /** Pool sizing (set before setRegistry). Default: the best scale that holds every streamed page, else the best
   *  scale holding minSlots. A creator preview wants sharp art and few pages: { coverAll: false, minSlots: 16 }. */
  poolPolicy: { coverAll: boolean; minSlots?: number; /** false: one wear pool sized to the largest page (pre-split behaviour) */ splitWear?: boolean } = { coverAll: true };
  /** VRAM accountant (bytes resident / budget / page-ins / evictions); see vramStats. */
  readonly vram: VramAccountant;
  private pools: Pool[] = [];
  /** bodyAtlasKeys() of the current registry (body pool membership + scale rule). */
  private bodyPageKeys = new Set<string>();
  /** Stream Art vehicle sheets per vehicle (refcounted by VehicleView through retainSprite/releaseSprite). */
  streamVehicles = true;
  /** Stream building_t1..t4 per tier present nearby (refcounted by IsoRenderer's BuildingTierStreamer). */
  streamBuildingTiers = true;
  /** Page manifest `residency: "stream"` atlases through the stream pool (false = load them resident like before). */
  streamSheets = true;
  /** Bumped on every rebuild (pools / sprite tables replaced): refcount holders re-retain. */
  layoutVersion = 0;
  /** glGetError after each page-in (a CPU/GPU sync). IsoRenderer.syncPoints=false turns it off for honest profiling. */
  syncChecks = true;
  private poolOfA(a: AtlasRT): Pool | undefined { return a.lazy ? this.pools[a.lazy.pool] : undefined; }
  /** Pool may page now (fallback step 1 stops the wearable pool only; vehicles keep their placeholder fallback). */
  /** Wearables off (ladder EvictWearables) still pages in the local player + nearby characters (prio <= PRIO_NEAR). */
  private poolOn(p: Pool, prio = Infinity): boolean { return (p.cls !== "wear" && p.cls !== "stream") || this.wearablesOn || prio <= PRIO_NEAR; }
  private table: Float32Array = new Float32Array(0); private tableDirty0 = -1; private tableDirty1 = -1; /** ADR-154: rows patched since the last upload (only these go to the GPU) */ private tableRowDirty = new Uint8Array(0);
  private tintRowMap = new Map<number, number>();
  private frame = 1; private gen = 0; private inflight = 0; private queue: AtlasRT[] = [];
  private loader: (url: string) => Promise<ImageLike>;

  /** Per-sprite wind sway overrides {amp px at frame top, freq Hz, stiffness 0..1 (higher = stiffer)}; SpriteDef.sway is the default source. */
  setSway(table: Record<string, SwayParams>): void { for (const [k, v] of Object.entries(table)) this.swayByKey.set(k, v); this.resolveSway(); }
  swayOf(spriteId: number): Float32Array | undefined { return this.swayById[spriteId]; }
  private resolveSway(): void {
    this.swayById = [];
    if (!this.registry) return;
    // SpriteDef.sway (manifest) is the source; setSway() entries override per key
    for (const sp of this.registry.allSprites()) if (sp.sway) this.swayById[sp.id] = new Float32Array([sp.sway.amp, sp.sway.freq, sp.sway.stiffness]);
    for (const [k, v] of this.swayByKey) { const id = this.registry.ids.sprites.tryId(k); if (id !== undefined) this.swayById[id] = new Float32Array([v.amp, v.freq, v.stiffness]); }
  }

  /** GPU memory budget for the atlas texture arrays (MB); over budget -> images are downscaled (0.5, 0.25). */
  textureBudgetMB: number;
  /** ADR-156: creature sheets (pets, wild critters) are resident hot art at full res when the budget holds them
   * (>= RESIDENT_CREATURE_MIN_MB); smaller budgets keep streaming them so the hot tier never drops below x1. */
  get residentCreatures(): boolean { return this.textureBudgetMB >= RESIDENT_CREATURE_MIN_MB; }
  /** Current budget downscale (1 = full res). */
  downscale = 1;
  /** Downscale applied to cold-tier atlases (<= downscale). */
  coldDownscale = 1;
  /** Scale of the side (emissive/mask) images vs the colour page (1/2 when halved). */
  private sideScale = 1;
  /** Side-array (emissive / masks) shift for this build: SIDE_SHIFT, or SIDE_SHIFT_LOWMEM on <=256 MB budgets. */
  sideShift: number = SIDE_SHIFT;
  /** How fitBudget met the budget (diag): pool reserve actually kept, hot atlases demoted to cold. */
  fitInfo: { reserveMB: number; reserveWantedMB: number; demoted: number; /** ADR-237: sheets kept x1 while the hot tier is halved */ pinned?: string[] } = { reserveMB: 0, reserveWantedMB: 0, demoted: 0 };
  /** ADR-380: ms per phase of the last rebuild (diag: the ?diag=1 boot sub-phases). Undefined until a rebuild
   *  completes; IsoView.create reads it right after the initial setRegistry. */
  rebuildTimings: { fetchDecode: number; fitBudget: number; halveSide: number; layout: number; upload: number; tables: number; bodies: number; restore: number } | undefined = undefined;
  /** Override the hot/cold budget tier per atlas key (default defaultAtlasTier). */
  atlasTier?: (key: string, info: { bodies: boolean; wearShare: number }) => AtlasTier;
  /** Atlas keys used recently (renderer marks them); always treated hot at the next rebuild. */
  readonly recentlyUsed = new Set<string>();
  /** GL errors seen while allocating/uploading the arrays (diagnostics). */
  uploadErrors: string[] = [];
  private oomFlag = false;
  /** Layer count vs MAX_ARRAY_TEXTURE_LAYERS / size vs MAX_TEXTURE_SIZE, or null when within limits. */
  limitProblem(): string | null {
    const gl = this.gl; const maxL = Number(gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS)) || 256, maxS = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 2048;
    if (this.layers > maxL) return `atlas uses ${this.layers} array layers > MAX_ARRAY_TEXTURE_LAYERS ${maxL}`;
    if (this.layerSize > maxS) return `atlas layer ${this.layerSize}px > MAX_TEXTURE_SIZE ${maxS}`;
    return null;
  }
  /** Diagnostics: array layer count, size, downscale, completeness-relevant state, upload errors. */
  get diagInfo(): { layers: number; layerSize: number; downscale: number; levels: number; pool: boolean; errors: string[] } {
    return { layers: this.layers, layerSize: this.layerSize, downscale: this.downscale, levels: this.texLevels || Math.floor(Math.log2(this.layerSize)) + 1, pool: this.pools.length > 0, errors: [...this.uploadErrors] };
  }
  private gpuBytes = 0;
  /** Reports GL out-of-memory on upload (the client overlay listens through IsoRenderer.onError). */
  onError: ((e: { kind: "oom" | "limits"; message: string }) => void) | null = null;
  /** Runtime allocation fault (GL error after an array / page allocation): IsoRenderer escalates its fallback ladder. */
  onFault: ((source: "atlas" | "page", detail: string) => void) | null = null;
  /** Streamed wearable pages enabled (fallback step 1 turns them off: body-only, pool slots emptied). */
  private wearablesOn = true;
  /** Mip levels actually allocated for the colour array (page-ins never upload past them). */
  private texLevels = 0;
  /** Page-ins refused by the driver / the VRAM budget (diagnostics). */
  pageFaults = 0; pageBudgetRefusals = 0;
  get wearablesEnabled(): boolean { return this.wearablesOn; }
  /** Fallback step 1: drop every streamed page and stop paging (layers draw the body-only fallback). */
  setWearables(on: boolean): void {
    if (on === this.wearablesOn) return; this.wearablesOn = on; if (on || !this.pools.some((p) => p.cls === "wear" || p.cls === "stream")) return;
    // stream sheets ride the same ladder step: far ones drop to their placeholder
    const ev = (p: Pool | undefined) => p?.cls === "wear" || p?.cls === "stream";
    this.gen++; this.queue = this.queue.filter((a) => !ev(this.poolOfA(a)));
    for (const a of this.atlases) { const p = this.poolOfA(a); if (!p || !ev(p) || a.lazy!.state === 0) continue;
      if (a.lazy!.state === 2 && p.lru.prioOf(a.key) <= PRIO_NEAR) continue; // local player / nearby characters stay dressed
      if (a.lazy!.state === 2) { p.lru.remove(a.key); this.vram.evict(p.slotBytes); } a.lazy!.state = 0; a.layer = -1; this.writeFrames(a, this.table, this.tintRowMap, true); }
    this.vram.pending = this.queue.length;
  }
  /** Fallback step 3: every resident atlas on the cold tier and half the texture budget, then rebuild (frees GPU memory). */
  async forceLowTier(): Promise<void> {
    const prev = this.atlasTier; this.atlasTier = () => "cold"; this.recentlyUsed.clear(); if (!this.tierBudgetMB) { this.tierBudgetMB = this.textureBudgetMB; this.prevTier = prev; }
    this.textureBudgetMB = Math.max(32, Math.floor(this.textureBudgetMB / 2));
    if (!this.registry) return;
    await this.rebuild(this.registry, new Map(this.atlases.map((a) => [a.key, a.source] as [string, AtlasSource])));
  }

  private readonly retiered = new Set<string>();
  /** Task 17: effective scale each atlas was left at by its last re-tier (see needsRetier).
   * Entries are only written by retier() after a successful rebuild; a key in
   * `retiered` with no entry here was added by another path (or a test) and keeps
   * the old one-shot behaviour. */
  private readonly retierScale = new Map<string, number>();
  private tierBudgetMB = 0; private prevTier: AtlasManager["atlasTier"] | undefined; private retierAt = -Infinity;
  /** Undo forceLowTier (fallback ladder stepping back up once memory freed): default tiers + the original budget. */
  async restoreTier(): Promise<void> {
    if (!this.tierBudgetMB) return; if (this.prevTier) this.atlasTier = this.prevTier; else delete this.atlasTier; this.prevTier = undefined; this.textureBudgetMB = this.tierBudgetMB; this.tierBudgetMB = 0;
    if (this.registry) await this.rebuild(this.registry, new Map(this.atlases.map((a) => [a.key, a.source] as [string, AtlasSource])));
  }
  /** Effective stored scale of one resident atlas under the current fit (1 = pinned full res). */
  private scaleOf(a: { key: string; cold?: boolean }): number { return a.cold ? this.coldDownscale : this.pinnedKeys.has(a.key) ? 1 : this.downscale; }
  /** Task 17: an atlas may ask for a re-tier when it never had one, OR when its stored
   * scale has FALLEN since its last re-tier (crisp once, demoted later — the stuck-blurry
   * case: a zombie atlas demoted after its one re-tier never recovered). An atlas that
   * still sits at its re-tier scale never re-asks, so a budget that cannot hold it at
   * full res still cannot loop rebuilds (and a re-tier can only raise scales, never
   * lower them, so a re-trigger always needs a fresh demotion first). */
  private retierOpen(a: { key: string; cold?: boolean }): boolean {
    if (!this.retiered.has(a.key)) return true;
    const at = this.retierScale.get(a.key); return at !== undefined && this.scaleOf(a) < at;
  }
  /** True when an atlas drawn near the camera is stored downscaled (cold tier): a re-tier would make it crisp again. */
  get needsRetier(): boolean {
    const own = this.tailPools().find((p) => p.own)?.own; if (own && own.levels < this.ownLevelsFor(this.tailPools())) return true; // zoomed out past the sampled mip range (more levels needed; fewer is never worth a rebuild)
    const wp = this.wearPool(); if (wp && wp.k <= 1 && wp.k < this.wearScale() && this.poolScales(this.atlases.filter((a) => a.lazy && this.poolOfA(a)?.cls === "wear")).includes(this.wearScale())) return true; // zoomed in: wear needs a crisper scale (a smaller one never triggers a rebuild)
    if (this.coldDownscale >= 1 && this.downscale >= 1) return false;
    return this.atlases.some((a) => !a.lazy && this.recentlyUsed.has(a.key) && this.retierOpen(a) && this.scaleOf(a) < 1);
  }
  /** Rebuild so recently drawn atlases move to the hot (full-res) tier; at most once per `minGap` frames. */
  async retier(frame: number, minGap = RETIER_MIN_GAP_FRAMES): Promise<boolean> {
    // ADR-190 hysteresis: the need must hold on RETIER_CONFIRM consecutive checks (a passing zoom / a sprite drawn
    // for a moment never rebuilds), never while a rebuild is still in flight, and at most once per minGap frames
    if (!this.registry || this.retierBusy) return false;
    if (!this.needsRetier) { this.retierWant = 0; return false; }
    if (++this.retierWant < RETIER_CONFIRM || frame - this.retierAt < minGap) return false;
    this.retierWant = 0; this.retierAt = frame; this.retierBusy = true;
    try { for (const k of this.recentlyUsed) this.retiered.add(k);
    await this.rebuild(this.registry, new Map(this.atlases.map((a) => [a.key, a.source] as [string, AtlasSource])));
    // record POST-rebuild scales (rebuild replaced this.atlases and refit the tiers):
    // a later demotion below the scale the re-tier left the atlas at re-opens the
    // re-tier; an atlas the rebuild could not lift keeps its scale and never re-asks
    for (const k of this.recentlyUsed) { const a = this.atlases.find((x) => x.key === k); if (a) this.retierScale.set(k, this.scaleOf(a)); }
    } finally { this.retierBusy = false; }
    return true;
  }
  private retierWant = 0; private retierBusy = false;

  constructor(private gl: WebGL2RenderingContext, private assets: AssetManager, opts: { layerSize?: number; imageLoader?: (url: string) => Promise<ImageLike>; textureBudgetMB?: number } = {}) {
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.layerSize = Math.min(opts.layerSize ?? 2048, max || 2048);
    this.textureBudgetMB = opts.textureBudgetMB ?? 768;
    // ADR-154: the per-page-in glGetError is a full CPU<->GPU-process round trip (pipeline drain) on every stream upload -
    // a hitch source on desktop/console ANGLE. Keep it only on small (mobile) budgets where lazily-committed OOM must free
    // the exact slot; big budgets rely on the renderer watchdog's once-a-second getError.
    this.syncChecks = this.textureBudgetMB < SYNC_CHECK_MAX_MB;
    this.vram = new VramAccountant(this.textureBudgetMB * 1048576);
    this.loader = opts.imageLoader ?? defaultImageLoader;
    this.maxLayers = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number;
    assets.registerLoader<ImageLike>(AtlasManager.IMAGE_KIND, opts.imageLoader ?? defaultImageLoader);
    const cv = (gl as { canvas?: unknown }).canvas as HTMLCanvasElement | undefined;
    if (cv && typeof cv.addEventListener === "function") { cv.addEventListener("webglcontextlost", this.onCtxLost, false); cv.addEventListener("webglcontextrestored", this.onCtxRestored, false); this.ctxCanvas = cv; }
  }

  // ---- context loss: page-ins stop, residency is forgotten (the GL objects are gone), never reported as OOM ----------
  private ctxCanvas: HTMLCanvasElement | undefined;
  private ctxLost = false;
  /** Context losses seen and lazy pages dropped by them (diag / tests). */
  readonly ctxStats = { losses: 0, restores: 0, pagesDropped: 0, uploadsSkipped: 0 };
  /** True between webglcontextlost and webglcontextrestored (or while the GL reports a lost context). */
  get contextLost(): boolean { return this.ctxLost || (typeof this.gl?.isContextLost === "function" && this.gl.isContextLost()); }
  /** After a restore every lazy page must be uploaded again into recreated arrays: setRegistry()/rebuildAfterRestore(). */
  needsReupload = false;
  private onCtxLost = (): void => {
    this.ctxLost = true; this.ctxStats.losses++; this.gen++; // in-flight page-ins finish as no-ops (gen check)
    for (const a of this.queue) if (a.lazy) a.lazy.state = 0;
    this.queue = []; this.vram.pending = this.inflight;
  };
  private onCtxRestored = (): void => { this.ctxLost = false; this.ctxStats.restores++; this.resetLazyResidency(); this.needsReupload = true; };
  /** Forget every stream / wear / vehicle / building page (state 0, fallback frames) and empty the pool LRUs. */
  resetLazyResidency(): void {
    for (const a of this.atlases) {
      if (!a.lazy) continue; const p = this.poolOfA(a);
      if (a.lazy.state === 2 || (p && p.lru.has(a.key))) { this.ctxStats.pagesDropped++; if (p) { p.lru.remove(a.key); this.vram.evict(p.slotBytes); } }
      a.lazy.state = 0; a.lazy.prio = Infinity; a.layer = -1; this.writeFrames(a, this.table, this.tintRowMap, true);
    }
    for (const p of this.pools) for (const k of p.lru.keys()) { p.lru.remove(k); this.vram.evict(p.slotBytes); }
    this.queue = []; this.vram.pending = this.inflight;
  }
  /** In-place recovery for embedders that keep the AtlasManager across a restore: recreate every array and table. */
  async rebuildAfterRestore(): Promise<void> {
    if (!this.registry || this.contextLost) return;
    this.resetLazyResidency(); await this.rebuild(this.registry, new Map(this.atlases.map((a) => [a.key, a.source] as [string, AtlasSource]))); this.needsReupload = false;
  }
  /** Upload finished on a lost context: the slot holds nothing. Free it quietly (no fault, no ladder step). */
  private droppedByLoss(a: AtlasRT, p: Pool): boolean {
    if (!this.contextLost) return false;
    p.lru.remove(a.key); a.lazy!.state = 0; a.layer = -1; this.ctxStats.uploadsSkipped++; return true;
  }

  get stats(): AtlasStats { return { layers: this.layers, layerSize: this.layerSize, downscale: this.downscale, gpuMB: Math.round(this.gpuBytes / 1048576), atlases: this.atlases.length, frames: this.totalFrames, sprites: this.sprites.filter(Boolean).length, version: this.version }; }

  /** Install a registry and where its atlas images live. Resolves once GPU data is ready. */
  async setRegistry(registry: AssetRegistry, sources: Map<string, AtlasSource> | Record<string, AtlasSource>): Promise<void> {
    this.baseSources = new Map(sources instanceof Map ? sources : Object.entries(sources));
    for (const k of registry.atlases.keys()) if (!this.baseSources.has(k)) throw new Error(`no image source for atlas "${k}"`);
    await this.rebuild(registry, this.baseSources);
  }

  /** Register a theme: per-atlas overrides with identical layout (e.g. a player skin set or a whole visual theme). */
  registerTheme(name: string, overrides: Record<string, AtlasSource>): void { this.themes.set(name, overrides); }

  /** Activate a theme (or null for base). Sprite/frame ids are unchanged, so ECS data needs no rebuild. */
  async setTheme(name: string | null): Promise<void> {
    if (!this.registry) throw new Error("setTheme before setRegistry");
    const merged = new Map(this.baseSources);
    if (name !== null) { const t = this.themes.get(name); if (!t) throw new Error(`unknown theme ${name}`); for (const [k, v] of Object.entries(t)) merged.set(k, v); }
    await this.rebuild(this.registry, merged);
  }

  /**
   * Quality-tier page selection: atlases with scale pages use AssetRegistry.pickPage(atlas, scale). Rebuilds (async)
   * when the choice changes. Pages that do not fit a layer fall back to the next smaller page.
   */
  async setPageScale(scale: number): Promise<boolean> {
    const s = scale >= 1.5 ? 2 : 1; if (s === this.pageScale) return false;
    this.pageScale = s;
    if (!this.registry) return false;
    const changes = this.atlases.some((a) => !a.lazy && this.pickScale(this.registry!.atlases.get(a.key)!, a.source) !== a.scale / (a.cold ? this.coldDownscale : this.downscale));
    if (!changes) return false;
    await this.rebuild(this.registry, new Map(this.atlases.map((a) => [a.key, a.source] as [string, AtlasSource])));
    return true;
  }
  get currentPageScale(): number { return this.pageScale; }
  private pickScale(atlas: Atlas | undefined, src: AtlasSource): number {
    if (!src.pages?.length || !atlas) return 1;
    // Ground: only the drawn season may use its @2x page (the other seasons stay 1x). All seasons
    // at @2x would be ~+120 MB; the drawn season alone is the ground the camera actually sits on,
    // and at 1x a 68x52 cell magnified on a phone screen is exactly the screenshot's soft ground.
    if (RESIDENT_GROUND_RE.test(atlas.key) && !this.groundPinOk(atlas.key)) return 1;
    const want = atlas.pages?.length ? AssetRegistry.pickPage(atlas, this.pageScale).scale : this.pageScale;
    const ok = (k: number) => k === 1 || ((src.pages!.some((p) => p.scale === k)) && atlas.columns * atlas.frameW * k <= this.layerSize && atlas.rows * atlas.frameH * k <= this.layerSize);
    for (const k of [...new Set([want, ...src.pages.map((p) => p.scale).filter((k) => k < want).sort((a, b) => b - a), 1])]) if (ok(k)) return k;
    return 1;
  }

  /** Global status tints (row 0 of the tint table). Per-sprite SpriteDef.tints override by name. */
  setStatusTints(t: Record<StatusTintName, StatusTint>): void { this.statusTints = t; if (this.registry) this.uploadTints(); }

  /** Replace the image of one atlas (same layout). */
  async swapAtlas(atlasKey: string, source: AtlasSource): Promise<void> {
    if (!this.registry) throw new Error("swapAtlas before setRegistry");
    const merged = new Map(this.atlases.map((a) => [a.key, a.source] as [string, AtlasSource])); merged.set(atlasKey, source);
    await this.rebuild(this.registry, merged);
  }

  private async rebuild(registry: AssetRegistry, sources: Map<string, AtlasSource>): Promise<void> {
    // ADR-380: per-phase ms for the ?diag=1 boot split (fetchDecode = fetch + decode + fitToPage of the resident
    // set; layout = pack/plan + the sort/rect/classify planning around the rescale steps; tables = the sprite
    // runtime tables + tint rows + resolve* passes). Cleared here so a failed rebuild leaves no stale split.
    const ph = { fetchDecode: 0, fitBudget: 0, halveSide: 0, layout: 0, upload: 0, tables: 0, bodies: 0, restore: 0 };
    this.rebuildTimings = undefined;
    const prevHeld = this.held; const held: [string, string][] = [];
    // seamless rebuild (re-tier / zoom): remember the lazy pages resident now (local player, nearby characters, visible
    // stream/building art) so the new layout pages them back in before the renderer draws again (see `settling`)
    const wasResident = new Map<string, number>(); for (const a of this.atlases) if (a.lazy?.state === 2) { const p = this.poolOfA(a); wasResident.set(a.key, p?.lru.has(a.key) ? p.lru.prioOf(a.key) : (a.lazy.prio ?? Infinity)); }
    const load = async (url: string): Promise<ImageLike> => { held.push([AtlasManager.IMAGE_KIND, url]); return this.assets.load<ImageLike>(AtlasManager.IMAGE_KIND, url); };
    const loadOpt = async (url: string | null | undefined): Promise<ImageLike | null> => {
      if (!url) return null;
      try { return await load(url); } catch (e) { reportRenderError(`atlas optional layer ${url}`, e); held.pop(); this.assets.release(AtlasManager.IMAGE_KIND, url); return null; }
    };
    const firstOf = async (c: string | string[] | undefined): Promise<[ImageLike | null, string | undefined]> => {
      for (const u of c === undefined ? [] : Array.isArray(c) ? c : [c]) { const im = await loadOpt(u); if (im) return [im, u]; }
      return [null, undefined];
    };
    const list: AtlasRT[] = []; const lazyList: AtlasRT[] = [];
    const { lazyKeys, legacy, vehKeys, bldKeys, streamKeys, bodyKeys, bodyPages } = atlasPoolSets(registry, sources, { streamWearables: this.streamWearables, streamVehicles: this.streamVehicles,
      streamBuildingTiers: this.streamBuildingTiers, streamSheets: this.streamSheets, residentCreatures: this.residentCreatures, ktx2: !!this.ktx2Target });
    this.placeholderCache.clear();
    this.bodyPageKeys = bodyPages;
    const ldT0 = now();
    await Promise.all([...registry.atlases.values()].map(async (a) => {
      const src = sources.get(a.key); if (!src) throw new Error(`no image source for atlas "${a.key}"`);
      if (lazyKeys.has(a.key) || vehKeys.has(a.key) || legacy.has(a.key) || bldKeys.has(a.key) || bodyKeys.has(a.key) || streamKeys.has(a.key)) {
        let w1 = a.columns * a.frameW, h1 = a.rows * a.frameH;
        if (src.rects?.length) { w1 = 0; h1 = 0; for (const r of src.rects) { w1 = Math.max(w1, r.x + r.w); h1 = Math.max(h1, r.y + r.h); } }
        // legacy full-size pages of facing-split sprites: never drawn (resolve uses dirFrames), so no pool slot and no
        // part in slot sizing (pool -1: pageReady refuses, nothing requests them)
        const pool = legacy.has(a.key) ? -1 : vehKeys.has(a.key) ? 1 : bldKeys.has(a.key) ? 2 : bodyKeys.has(a.key) ? 3 : streamKeys.has(a.key) ? 4 : 0;
        lazyList.push({ key: a.key, id: a.id, source: src, img: null, emis: null, scale: 1, masks: {}, maskUrls: {}, base: 0, count: src.rects ? src.rects.length : a.columns * a.rows, fw: a.frameW, fh: a.frameH, cols: a.columns, layer: -1, px: 0, py: 0, lazy: { w1, h1, state: 0, pool } });
        return;
      }
      let scale = this.pickScale(a, src);
      const pageUrl = scale === 1 ? src.url : src.pages!.find((p) => p.scale === scale)!.url;
      let [img, emis] = await Promise.all([loadOpt(pageUrl), loadOpt(src.emissiveUrl)]);
      if (!img) { scale = 1; img = await load(src.url); }
      const masks: AtlasRT["masks"] = {}; const maskUrls: AtlasRT["maskUrls"] = {};
      for (const m of ["sheen", "sway", "tintmask"] as const) { const [im, u] = await firstOf(src.masks?.[m]); if (im && u) { masks[m] = im; maskUrls[m] = u; } }
      // masks (and the 1x emissive page) are resized to the chosen page so they line up under the same UVs
      if (emis) emis = await fitToPage(emis, img.width, img.height);
      for (const m of Object.keys(masks) as MaskName[]) { const f = await fitToPage(masks[m]!, img.width, img.height); if (f) masks[m] = f; else { delete masks[m]; delete maskUrls[m]; } }
      list.push({ key: a.key, id: a.id, source: src, img, emis, scale, masks, maskUrls, base: 0, count: src.rects ? src.rects.length : a.columns * a.rows, fw: a.frameW, fh: a.frameH, cols: a.columns, layer: 0, px: 0, py: 0 });
    }));
    ph.fetchDecode += now() - ldT0;
    const layT0 = now();
    list.sort((a, b) => a.id - b.id); lazyList.sort((a, b) => a.id - b.id);
    addDirFrameRects(registry, [...list, ...lazyList]);
    // ADR-220: the live layout (pools, LRUs, frame entries, fallback caches) stays intact while the new one is planned:
    // fitBudget/halveSide take seconds (image rescales), and clearing `pools` here left the renderer drawing the old
    // arrays with no pool residency for that whole window (undressed bodies, held frames from a dead layout, a stranger's
    // head at the feet) - the old state is replaced only at the swap below, where `settling` starts
    this.planningRebuild = true;
    const lowMem = this.textureBudgetMB <= 256; this.sideShift = lowMem ? SIDE_SHIFT_LOWMEM : SIDE_SHIFT;
    const groups: { cls: PoolClass; lazy: AtlasRT[]; minSlots: number; cap: boolean; /** wear split: fraction of the 1x working set */ share?: number }[] = [];
    const wear = lazyList.filter((a) => a.lazy!.pool === 0), veh = lazyList.filter((a) => a.lazy!.pool === 1), bld = lazyList.filter((a) => a.lazy!.pool === 2), body = lazyList.filter((a) => a.lazy!.pool === 3); const [strm, strmBig] = splitStreamPages(lazyList.filter((a) => a.lazy!.pool === 4));
    // ADR-220: character pools (bodies, then wearables) come first and stay in the main RGBA8 colour array: their pages are
    // uploaded losslessly from the PNG (never the ETC1S tail: ~10% of a paper-doll sheet's texels came back >32 off, which
    // read as smeared, blotchy clothes/faces once the KTX2 page replaced the first look). One slot per body sheet
    if (body.length) groups.push({ cls: "body", lazy: body, minSlots: body.length, cap: true });
    if (wear.length) {
      const min = Math.min(wear.length, this.poolPolicy.minSlots ?? (lowMem ? POOL_MIN_SLOTS_LOWMEM : POOL_MIN_SLOTS_DESKTOP));
      const small = this.poolPolicy.splitWear === false || this.layerSize < 2048 ? [] : wear.filter((a) => a.lazy!.w1 <= WEAR_SMALL_PX && a.lazy!.h1 <= WEAR_SMALL_PX);
      if (small.length >= WEAR_SPLIT_MIN && wear.length - small.length >= WEAR_SPLIT_MIN) {
        // slots (and the forced 1x working set) shared by page count: a worn set has small and large pages in about that ratio
        const share = small.length / wear.length, big = wear.filter((a) => !small.includes(a));
        const ms = Math.max(1, Math.min(small.length, Math.round(min * share))), mb = Math.max(1, Math.min(big.length, min - ms));
        // small first: it covers all its pages in a few layers (faces/eyes never miss), the large pool takes what is left
        groups.push({ cls: "wear", lazy: small, minSlots: ms, cap: false, share }, { cls: "wear", lazy: big, minSlots: mb, cap: false, share: 1 - share });
      } else groups.push({ cls: "wear", lazy: wear, minSlots: min, cap: false });
    }
    // building tiers: first pool of the compressed tail (ETC1S own array) with vehicles and stream sheets
    if (bld.length) groups.push({ cls: "bld", lazy: bld, minSlots: Math.min(bld.length, lowMem ? BLD_POOL_SLOTS_LOWMEM : BLD_POOL_SLOTS_DESKTOP), cap: true });
    // vehicles: compressed tail
    if (veh.length) groups.push({ cls: "veh", lazy: veh, minSlots: Math.min(veh.length, lowMem ? VEH_POOL_SLOTS_LOWMEM : VEH_POOL_SLOTS_DESKTOP), cap: true });
    // manifest stream sheets: visible art (kept at 1x, counted in keepVis like vehicles), a small LRU working set
    if (strm.length) {
      // ADR-251: stream sheets are mostly whole 2048 pages (one slot per layer at 1x): 24 slots asked ~640 MB, which the
      // planner met by downscaling every resident atlas (furniture x0.125). The 1x working set is capped at
      // STREAM_BUDGET_SHARE of the budget (LRU pages the rest), never below STREAM_FLOOR_SLOTS
      const want = Math.min(strm.length, lowMem ? STREAM_POOL_SLOTS_LOWMEM : STREAM_POOL_SLOTS_DESKTOP), g1 = this.poolGeom(strm, 1);
      const layerCost = g1.perLayer > 0 ? this.poolReserveBytes(strm, g1.perLayer, list, 1) : 0;
      const fit = layerCost > 0 ? Math.floor(this.textureBudgetMB * 1048576 * STREAM_BUDGET_SHARE / layerCost) * g1.perLayer : want;
      groups.push({ cls: "stream", lazy: strm, minSlots: Math.max(Math.min(want, fit), Math.min(want, STREAM_FLOOR_SLOTS)), cap: true });
    }
    // ADR-314: oversize stream pages (door swing sheets, 2048x1792) get their own small pool so they never widen every
    // stream slot (1024 pages tile a 2048 layer 2x2; one 2048 page in the group made each slot a whole layer)
    if (strmBig.length) groups.push({ cls: "stream", lazy: strmBig, minSlots: Math.min(strmBig.length, lowMem ? BIG_STREAM_SLOTS_LOWMEM : BIG_STREAM_SLOTS_DESKTOP), cap: true });
    // vehicles are visible art: their pool keeps a full-res (1x) working set that fitBudget never trades away; the
    // wearables pool is the streaming tier and may shrink (more paging) before any visible art is blurred
    // wear is never planned below wearScale and always keeps its 1x working set (planPool forces it even over budget), so
    // that floor belongs to `keep` too: reserving it at 0.5x left resident art at full res and the forced wear layers then
    // overshot the budget (mobile: 140 MB at 128)
    const w1x = lowMem ? WEAR_1X_SLOTS_LOWMEM : WEAR_1X_SLOTS_DESKTOP; const wk = this.wearScale();
    const wearG = groups.filter((g) => g.cls === "wear");
    const keepWear = wearG.reduce((t, g) => t + this.poolReserveBytes(g.lazy, Math.min(g.minSlots, Math.ceil(w1x * (g.share ?? 1))), list, wk), 0);
    const wantWear = wearG.reduce((t, g) => t + this.poolReserveBytes(g.lazy, g.minSlots, list, wk), 0);
    const keepVis = groups.filter((g) => g.cls !== "wear").reduce((t, g) => t + this.poolReserveBytes(g.lazy, g.minSlots, list, 1), 0);
    // ADR-251: wear never asks for more than its budget share (it streams / LRU-pages the rest), so resident art (furniture,
    // props) is not downscaled to make room for a wardrobe that only planPool's cap would refuse anyway
    const wearCap = this.textureBudgetMB * 1048576 * WEAR_BUDGET_SHARE;
    // the wear floor planPool forces (WEAR_FLOOR_SLOTS at wearScale, split by share) is the least wear ever takes
    const wearFloor = wearG.reduce((t, g) => t + this.poolReserveBytes(g.lazy, Math.min(g.minSlots, Math.ceil(WEAR_FLOOR_SLOTS * (g.share ?? 1))), list, wk), 0);
    const wearRes = Math.max(wearFloor, Math.min(Math.max(keepWear, wantWear), wearCap));
    const keep = keepVis + Math.max(wearFloor, Math.min(keepWear, wantWear, wearCap) / 2), reserve = keepVis + wearRes;
    // 1x working set of each visible (non-char) pool, held free while the earlier (character) pools are planned
    const visHold = groups.map((g) => (CHAR_POOL_CLS.has(g.cls) ? 0 : this.poolReserveBytes(g.lazy, g.minSlots, list, 1)));
    // buildings must not starve vehicles / the stream floor (furniture, decor): they hold veh 1x + STREAM_FLOOR_SLOTS at 1x
    const bldHold = groups.reduce((t, g, i) => t + (g.cls === "veh" ? visHold[i]! : g.cls === "stream" ? this.poolReserveBytes(g.lazy, Math.min(g.minSlots, STREAM_FLOOR_SLOTS), list, 1) : 0), 0);
    ph.layout += now() - layT0; // sort + rect tables + pool-group planning, before the rescale steps
    this.registryForTier = registry;
    const fbT0 = now(); await this.fitBudget(list, reserve, keep); ph.fitBudget += now() - fbT0;
    const hsT0 = now(); this.sideScale = (await halveSide(list, this.sideShift)) ? 1 / (1 << this.sideShift) : 1; ph.halveSide += now() - hsT0;
    const layT1 = now();
    const layout = (): void => { this.pack(list); this.pools = []; groups.forEach((g, i) => this.planPool(g.lazy, g.minSlots, list, g.cls, g.cap, g.share, g.cls === "wear" ? visHold.slice(i + 1).reduce((t, b) => t + b, 0) : g.cls === "bld" ? bldHold : 0)); let b = this.totalFrames; for (const a of lazyList) { a.base = b; b += a.count; } this.totalFrames = b; };
    this.planningRebuild = false;
    this.gen++; this.queue = []; this.layoutVersion++; this.fallbackCache.clear(); this.lArmCache.clear();
    layout();
    ph.layout += now() - layT1;
    const all = [...list, ...lazyList];
    this.settling = true; // from the first new texture until the old residency is restored: the renderer holds its last frame
    try {
    // ADR-380: tint rows are pure given (registry, all) — compute once and reuse for the OOM re-uploads (was
    // recomputed per upload call, each doing a list.find per tinted sprite). Timed under `tables`, not `upload`.
    const tintT0 = now(); const tintRows = this.frameTintRows(registry, all); ph.tables += now() - tintT0;
    const upT0 = now();
    this.upload(list, tintRows, all);
    const lim = this.limitProblem(); if (lim) { this.uploadErrors.push(lim); console.error("[render] " + lim); this.onError?.({ kind: "limits", message: lim }); }
    while ((this.oomFlag || this.gl.getError() === this.gl.OUT_OF_MEMORY) && this.downscale > MIN_ATLAS_DOWNSCALE) {
      this.oomFlag = false;
      // the driver refused the arrays: halve again and re-upload (once per step)
      const msg = `atlas upload out of GPU memory at ${this.gpuMB()} MB (downscale ${this.downscale}); retrying at ${this.downscale / 2}`;
      console.warn("[render] " + msg); this.onError?.({ kind: "oom", message: msg });
      await scaleList(list, 0.5); this.downscale /= 2; this.coldDownscale = Math.max(MIN_ATLAS_DOWNSCALE / 2, this.coldDownscale / 2); layout(); this.upload(list, tintRows, all);
    }
    if (this.oomFlag) { this.oomFlag = false; const msg = `atlas arrays still out of GPU memory at the minimum downscale x${this.downscale}`; this.uploadErrors.push(msg); this.onFault?.("atlas", msg); }
    ph.upload += now() - upT0;
    list.push(...lazyList);
    // sprite runtime tables (ADR-380: buildSpriteTables — Map lookups, byte-identical to the old list.find loop)
    const tbT0 = now();
    const sprites = buildSpriteTables(registry, list);
    this.usedMark = new Uint8Array(list.length); this.crispMark = []; this.atlases = list; this.atlasById = new Map(list.map((a) => [a.id, a])); this.sprites = sprites; this.registry = registry; this.headGroup.clear(); this.resolveSway(); this.resolveVariants(); this.resolveRoofs(); this.resolveEnclosures(); this.resolveHands();
    this.uploadTints();
    this.maskPixels.clear();
    ph.tables += now() - tbT0;
    // body pages: resident from the first frame (prio 0: no budget refusal; one slot each, so never evicted)
    const g0 = this.gen; const bodies = list.filter((a) => a.lazy && this.poolOfA(a)?.cls === "body");
    const bdT0 = now();
    await Promise.all(bodies.map(async (a) => { a.lazy!.prio = 0; a.lazy!.state = 1; try { await this.pageIn(a, g0); } catch (e) { reportRenderError(`body page-in ${a.key}`, e, true); } if ((a.lazy!.state as number) !== 2) { a.lazy!.state = 0; const m = `body page ${a.key} not resident`; if (this.uploadErrors.length < 32) this.uploadErrors.push(m); } }));
    ph.bodies += now() - bdT0;
    // previously resident pages (closest first) back in before drawing resumes: no undressed / missing-art frames
    const back = list.filter((a) => a.lazy && a.lazy.state === 0 && wasResident.has(a.key) && this.poolOfA(a)).sort((x, y) => wasResident.get(x.key)! - wasResident.get(y.key)!);
    const rsT0 = now();
    await Promise.all(back.map(async (a) => { const pr = wasResident.get(a.key)!; a.lazy!.prio = pr; if (!this.poolOn(this.poolOfA(a)!, pr)) return; a.lazy!.state = 1; try { await this.pageIn(a, g0); } catch { /* re-requested by pageReady */ } if ((a.lazy!.state as number) !== 2) a.lazy!.state = 0; }));
    ph.restore += now() - rsT0;
    this.held = held; this.version++;
    for (const [k, u] of prevHeld) this.assets.release(k, u);
    this.rebuildTimings = { ...ph };
    } finally { this.settling = false; }
  }
  /** True while a rebuild has replaced the GPU arrays but not yet restored the pages that were resident before it
   *  (IsoRenderer skips drawing, so the last presented frame stays on screen instead of a flash of missing art). */
  settling = false;
  /** ADR-220: a rebuild is planning its new layout; the live pools still serve the renderer and are not planner input. */
  private planningRebuild = false;

  /** ADR-251 diagnostics: approximate MB held by one pool's layers. */
  private poolMB(p: Pool): number { const res = this.atlases.filter((a) => !a.lazy); return Math.round(p.layers * (p.own ? this.poolLayerBytes(res, p.tint, p.emis) : this.layerBytes(res)) / 1048576); }
  private gpuMB(): number { return Math.round(this.gpuBytes / 1048576); }
  /** Estimated bytes of the atlas arrays for a packing (colour + emissive + present masks, full mip chains). */
  private estimate(list: AtlasRT[]): number {
    return this.layerBytes(list) * this.layers;
  }
  /** Planner estimate: like estimate() but charging the shelf layer count (see shelfLayers). */
  private planEstimate(list: AtlasRT[]): number { return this.layerBytes(list) * this.planLayers; }
  /** Arrays allocated for a list (colour + emissive + masks present; pool pages add a tint mask array). */
  private arrayCount(list: AtlasRT[], poolTint = this.pools.some((p) => p.tint), poolEmis = this.pools.some((p) => p.emis)): number {
    return 1 + (poolEmis || list.some((a) => a.emis) ? 1 : 0) + (["sheen", "sway"] as const).filter((m) => list.some((a) => a.masks[m])).length + (poolTint || list.some((a) => a.masks.tintmask) ? 1 : 0);
  }
  /** Bytes of one layer across every allocated array, full mip chain included. */
  private layerBytes(list: AtlasRT[], poolTint?: boolean, poolEmis?: boolean): number { const h = Math.max(1, this.layerSize >> this.sideShift); return rgbaBytes(this.layerSize, this.layerSize, true) + rgbaBytes(h, h, true) * (this.arrayCount(list, poolTint, poolEmis) - 1); }
  /** One streamed-pool layer: like layerBytes, but the colour layer is block-compressed (1 B/texel, <= OWN_MAX_LEVELS
   *  levels) when a KTX2 target exists, which is how planOwn stores the tail (RGBA fallback is the rare case). */
  private poolLayerBytes(list: AtlasRT[], poolTint?: boolean, poolEmis?: boolean): number {
    if (!this.ktx2Target) return this.layerBytes(list, poolTint, poolEmis);
    const S = this.layerSize; let c = 0; for (let l = 0, w = S; l < OWN_MAX_LEVELS; l++, w = Math.max(1, w >> 1)) c += blockBytes(w, w);
    return this.layerBytes(list, poolTint, poolEmis) - rgbaBytes(S, S, true) + c;
  }
  private poolGeom(lazy: AtlasRT[], k: number): { sw: number; sh: number; pw: number; ph: number; cols: number; perLayer: number } {
    const S = this.layerSize; const w1 = Math.max(...lazy.map((a) => a.lazy!.w1)), h1 = Math.max(...lazy.map((a) => a.lazy!.h1));
    // slots on 4px boundaries: compressed (KTX2 4x4-block) page uploads need block-aligned offsets once a layer holds >1 page
    const al4 = (v: number) => Math.ceil(v / 4) * 4;
    const sw = al4(Math.max(1, Math.ceil(w1 * k))), sh = al4(Math.max(1, Math.ceil(h1 * k)));
    // slot pitch on 16px: mip l of a compressed page lands at (px >> l, py >> l), block-aligned for l <= 2 (OWN_MAX_LEVELS);
    // the last slot of a row/column needs no gap after it (1020px sheets: pitch 1024 -> 2x2 per 2048 layer)
    // ADR-251: a power-of-two page that tiles the layer exactly (1024 in 2048) needs no gap: its mips never share a texel
    // with a neighbour, and the sprite shader clamps bilinear taps inside the frame rect (rectClamp). With the gap a
    // 1024 stream page took a whole 2048 layer (one slot instead of four)
    const tiles = (v: number) => v >= 16 && (v & (v - 1)) === 0 && S % v === 0;
    const al16 = (v: number) => Math.ceil(v / 16) * 16; const pw = tiles(sw) ? sw : al16(sw + POOL_GAP), ph = tiles(sh) ? sh : al16(sh + POOL_GAP);
    const cols = S >= sw ? Math.floor((S - sw) / pw) + 1 : 0, rows = S >= sh ? Math.floor((S - sh) / ph) + 1 : 0;
    return { sw, sh, pw, ph, cols, perLayer: cols * rows };
  }
  /** Pool scales to try, best first: the 2x page (when the quality tier asks for it), 1x, 0.5, 0.25 (low-end layer size shrinks these too). */
  private poolScales(lazy: AtlasRT[]): number[] {
    // bodies: resident (see rebuild); @2x when the quality tier asks for it and every body has the @2x colour + tint mask
    // KTX2 (1760x1680 fits a layer; planPool's cap rule takes 2x only when it leaves half the free layers), else 1x
    if (lazy.length && (this.bodyPageKeys?.has(lazy[0]!.key) || isBodyAtlasKey(lazy[0]!.key))) {
      const b2 = this.pageScale >= 2 && lazy.every((a) => { const p2 = a.source.pages?.find((q) => q.scale === 2); return !!p2?.ktx2 && !!p2.masksKtx2?.tintmask; });
      return (b2 ? [2, 1] : [1]).filter((k) => this.poolGeom(lazy, k).perLayer > 0);
    }
    // vehicles: 2x when any sheet has a 2x page (1x-only sheets are stored at 1x in their 2x slot, a.scale = 1)
    const two = (a: AtlasRT) => a.source.pages?.some((p) => p.scale === 2);
    const has2 = this.pageScale >= 2 && (lazy.length && /^veh_/.test(lazy[0]!.key) ? lazy.some(two) : lazy.every(two));
    return (has2 ? [2, 1, 0.5, 0.25] : [1, 0.5, 0.25]).filter((k) => this.poolGeom(lazy, k).perLayer > 0);
  }
  /** Budget held back for the pool before the resident art is downscaled: minSlots at the smallest workable scale. */
  private poolReserveBytes(lazy: AtlasRT[], minSlots: number, resident: AtlasRT[], k?: number): number {
    const tint = (!this.planningRebuild && this.pools.some((p) => p.tint)) || lazy.some((a) => a.source.masks?.tintmask), emis = lazy.some((a) => a.source.emissiveUrl);
    const ks = this.poolScales(lazy); if (!ks.length) return 0;
    const g = this.poolGeom(lazy, k !== undefined && ks.includes(k) ? k : ks.includes(0.5) ? 0.5 : ks[ks.length - 1]!);
    const char = losslessCharPools(this.textureBudgetMB) && lazy.length > 0 && (lazy[0]!.lazy!.pool === 0 || lazy[0]!.lazy!.pool === 3);
    return Math.ceil(minSlots / g.perLayer) * (char ? this.layerBytes(resident, tint, emis) : this.poolLayerBytes(resident, tint, emis)); // ADR-251: lossless char pools are RGBA8
  }
  /**
   * Choose pool scale + layer count from the budget left after the packed resident layers (and earlier pools); appends
   * the pool layers. `cap`: never more layers than minSlots needs (vehicles: a small working set, refcounted per
   * vehicle; the 2x page only when that still leaves half the free layers).
   */
  private planPool(lazy: AtlasRT[], minSlots: number, resident: AtlasRT[], cls: PoolClass = "wear", cap = false, share = 1, holdBytes = 0): void {
    if (!lazy.length) return;
    const tint = lazy.some((a) => a.source.masks?.tintmask), emis = cls !== "wear" && lazy.some((a) => a.source.emissiveUrl);
    const anyTint = tint || this.pools.some((p) => p.tint), anyEmis = emis || this.pools.some((p) => p.emis);
    const per = this.layerBytes(resident, anyTint, anyEmis); const budget = this.textureBudgetMB * 1048576;
    // resident layers at RGBA8 cost, pool layers (earlier pools and this one) at their compressed cost
    const pper = this.poolLayerBytes(resident, anyTint, anyEmis); const poolL = this.pools.reduce((t, p) => t + p.layers, 0);
    const resL = this.layers - poolL; // ADR-251: the real packed layer count (pack() ran just before; the shelf estimate planLayers left ~2 layers idle on Xbox)
    // ADR-251: lossless character pools live in the main RGBA8 array (ADR-220), so a layer costs `per`, not the compressed
    // tail cost (charging pper let wear coverAll take ~27 layers = 1.1 GB on a 1 GB budget); `holdBytes` is the 1x
    // working set of the visible pools planned after this one (bld / veh / stream), which wear must leave free
    const lossless = losslessCharPools(this.textureBudgetMB);
    const costOf = (p: { cls: PoolClass }) => (lossless && CHAR_POOL_CLS.has(p.cls) ? per : pper);
    const lcost = costOf({ cls }); const used = this.pools.reduce((t, p) => t + p.layers * costOf(p), 0);
    let freeLayers = Math.max(0, Math.min(this.maxLayers - this.layers, Math.floor((budget - per * resL - used - holdBytes) / lcost)));
    if (cls === "wear") {
      const wearUsed = this.pools.reduce((t, p) => t + (p.cls === "wear" ? p.layers * costOf(p) : 0), 0);
      freeLayers = Math.max(0, Math.min(freeLayers, Math.floor((budget * WEAR_BUDGET_SHARE * (share + (wearUsed > 0 ? 1 - share : 0)) - wearUsed) / lcost)));
    }
    const sh = this.sideShift; const slotBytes = (g: { sw: number; sh: number }) => rgbaBytes(g.sw, g.sh, true) + rgbaBytes(Math.max(1, g.sw >> sh), Math.max(1, g.sh >> sh), true) * ((tint ? 1 : 0) + (emis ? 1 : 0)); // side arrays at layerSize >> sideShift
    const mk = (k: number, g: ReturnType<AtlasManager["poolGeom"]>, layers: number): Pool => ({ k, ...g, first: this.layers, layers, lru: new PageLRU<string>(layers * g.perLayer, POOL_PROTECT_FRAMES), slotBytes: slotBytes(g), tint, emis, cls });
    let pick: Pool | null = null;
    if (cap) {
      for (const k of this.poolScales(lazy)) {
        const g = this.poolGeom(lazy, k); const layers = Math.ceil(minSlots / g.perLayer);
        const room = k > 1 ? Math.floor(freeLayers / 2) : freeLayers;
        // ADR-251: a visible stream pool keeps full res with fewer slots (LRU) down to STREAM_FLOOR_SLOTS before it blurs
        if (layers > room) { if (cls === "stream" && room > 0 && room * g.perLayer >= Math.min(minSlots, STREAM_FLOOR_SLOTS)) { pick = mk(k, g, room); break; } continue; }
        pick = mk(k, g, layers); break;
      }
    } else {
      // Character wearables are never planned below 1x: a downscaled wear pool is what made mobile characters blurry
      // blobs (0.25x, 12 slots). Memory pressure is met by fewer slots (distance-priority eviction), not by blur.
      const wk = this.wearScale(); const ks = this.poolScales(lazy).filter((k) => cls !== "wear" || k >= wk);
      // 1) the best scale whose pool holds every streamed page (no misses at all), 2) else the best scale holding minSlots
      if (this.poolPolicy.coverAll) for (const k of ks) {
        const g = this.poolGeom(lazy, k); const layers = Math.ceil(lazy.length / g.perLayer);
        if (layers > freeLayers) continue;
        pick = mk(k, g, layers); break;
      }
      if (!pick) for (const k of ks) {
        const g = this.poolGeom(lazy, k);
        const layers = Math.min(freeLayers, Math.ceil(lazy.length / g.perLayer));
        if (layers <= 0) continue;
        pick = mk(k, g, layers); if (pick.lru.capacity >= minSlots) break;
      }
      if (cls === "wear" && (!pick || pick.lru.capacity < minSlots)) {
        // 1x wear pool holding minSlots even over budget (reported by vramStats.withinBudget) - the local player and
        // nearby characters must always be fully dressed at full res
        // ADR-251: the floor is what the wear cap holds at 1x, never below one dressed character (WEAR_FLOOR_SLOTS)
        const k1 = ks.includes(wk) ? wk : 1; const g = this.poolGeom(lazy, k1); const fit = Math.max(freeLayers, 0) * g.perLayer;
        const n = Math.min(minSlots, lazy.length, Math.max(Math.ceil(WEAR_FLOOR_SLOTS * share), Math.min(fit, Math.ceil((this.textureBudgetMB <= 256 ? WEAR_1X_SLOTS_LOWMEM : WEAR_1X_SLOTS_DESKTOP) * share))));
        if (!pick || pick.k < wk || pick.lru.capacity < n) pick = mk(k1, g, Math.max(1, Math.ceil(n / g.perLayer)));
      }
    }
    if (!pick && freeLayers <= 0) {
      // no budget left at all: one layer at the smallest scale (over budget is reported by vramStats.withinBudget)
      const ks = this.poolScales(lazy); const k = ks[ks.length - 1]; if (k === undefined) return;
      pick = mk(k, this.poolGeom(lazy, k), 1);
    }
    if (!pick) return;
    const idx = this.pools.length; this.pools.push(pick); this.layers += pick.layers;
    for (const a of lazy) { a.scale = pick.k; a.lazy!.state = 0; a.lazy!.pool = idx; a.layer = -1; }
  }
  /**
   * Hot/cold budget fit. Hot atlases (terrain, bodies, common props, UI, recently used) keep the largest scale; cold ones
   * (rare variants, distant LODs, one-shot fx, unreferenced) are shrunk first. Tries (hot, cold) best-first: hot 1 with cold
   * 1..MIN, then hot 0.5 with cold 0.5..MIN, ... Atlases larger than a layer are always shrunk.
   */
  private async fitBudget(list: AtlasRT[], reserveBytes = 0, keepBytes = 0): Promise<void> {
    const S = this.layerSize; const full = this.textureBudgetMB * 1048576;
    this.classify(list);
    for (const a of list) if (a.cold && VISIBLE_PIN_RE.test(a.key) && this.groundPinOk(a.key)) a.cold = false; // ADR-251: furniture / drawn-season gt never go cold (they are what the camera sits on)
    const cap = (a: AtlasRT) => { let d = 1; const t = Math.max(a.img!.width, a.img!.height) / S; while (d > 1 / Math.max(1, t)) d /= 2; return d; };
    const caps = list.map(cap);
    // ADR-237: hot creature/character/zombie sheets (drawn recently; before anything was drawn every one but the 62 small
    // resident creature sheets, which follow once drawn via retier) stay x1 while
    // the rest of the hot tier is halved - tried first at every hot scale, dropped only when even that does not fit
    const visPin = list.map((a) => !a.cold && VISIBLE_PIN_RE.test(a.key) && this.groundPinOk(a.key));
    const pinned = list.map((a, i) => visPin[i]! || (!a.cold && FIDELITY_ATLAS_RE.test(a.key) && (this.recentlyUsed.size ? this.recentlyUsed.has(a.key) : !RESIDENT_CREATURE_RE.test(a.key))));
    let pin = 0; // 2 = creature + visible pins, 1 = ADR-251 visible pins only (furniture / drawn-season gt), 0 = none
    const scaleOf = (i: number, h: number, c: number): number => { const a = list[i]!; return Math.min(caps[i]!, a.cold ? c : (pin === 2 ? pinned[i] : pin === 1 && visPin[i]) ? 1 : h); };
    const dims = (h: number, c: number) => list.map((a, i) => { const k = scaleOf(i, h, c); return { ...a, img: { width: Math.max(1, Math.floor(a.img!.width * k)), height: Math.max(1, Math.floor(a.img!.height * k)) } as ImageLike }; });
    const fits1 = (h: number, budget: number): number | null => {
      const anyCold = list.some((a) => a.cold);
      for (let c = h; c >= MIN_ATLAS_DOWNSCALE; c /= 2) { this.pack(dims(h, c)); if (this.planEstimate(list) <= budget) return c; if (!anyCold) break; }
      return null;
    };
    const fits = (h: number, budget: number): number | null => {
      if (h < 1 && pinned.some(Boolean)) { pin = 2; const c = fits1(h, budget); if (c !== null) return c; }
      if (h < 1 && visPin.some(Boolean) && visPin.some((v, i) => v !== pinned[i])) { pin = 1; const c = fits1(h, budget); if (c !== null) return c; }
      pin = 0; return fits1(h, budget);
    };
    // Blur-safe order: visible (hot) art keeps full res. Memory comes from (1) shrinking cold atlases, (2) a smaller
    // streaming-pool reserve (the pools then page more often instead of blurring resident art), (3) demoting hot
    // atlases that were not drawn recently to cold, and only then (4) halving the hot tier.
    let best: [number, number] | null = null; let keptReserve = reserveBytes; let demoted = 0;
    for (const r of [reserveBytes, keepBytes + (reserveBytes - keepBytes) / 2, keepBytes + (reserveBytes - keepBytes) / 4, keepBytes]) { const c = fits(1, full - r); if (c !== null) { best = [1, c]; keptReserve = r; break; } }
    if (!best && this.recentlyUsed.size) {
      const idle = list.filter((a, i) => !a.cold && !visPin[i] && !this.recentlyUsed.has(a.key) && !CRISP_ATLAS_RE.test(a.key)) /* ADR-145: creature sheets stay full res; pinned visible art (ground/furniture/buildings) is never demoted to cold, or its 1x pin would be overridden by the cold scale */.sort((a, b) => (BUILD_ATLAS_RE.test(a.key) ? 1 : 0) - (BUILD_ATLAS_RE.test(b.key) ? 1 : 0) || b.img!.width * b.img!.height - a.img!.width * a.img!.height); // ADR-211: building art last
      for (const a of idle) { a.cold = true; demoted++; const c = fits(1, full - keepBytes); if (c !== null) { best = [1, c]; keptReserve = keepBytes; break; } }
    }
    if (!best) {
      // halving the hot tier still keeps the visible pools' floor (vehicles/buildings/bodies at 1x): giving resident art
      // the whole budget only appended those pools over it (mobile: 187 MB of arrays at a 128 MB budget -> fbo OOM)
      // ADR-251: hot resolution before reserve size - at each hot scale try the full keep, then half of it (the pools
      // still get their floors; Xbox kept a 372 MB reserve at 0.25 while 150 MB of it stayed idle and furniture blurred)
      for (let h = 0.5; h >= MIN_ATLAS_DOWNSCALE && !best; h /= 2) for (const r of [keepBytes, keepBytes / 2]) { if (best) break; keptReserve = r; const c = fits(h, full - r); if (c !== null) best = [h, c]; }
      // ADR-251: the pools are forced to their floor anyway (body, wear floor, one layer per visible pool), so a smaller
      // share of that floor is still held before resident art takes the whole budget (mobile ended 25 MB over 128)
      for (const r of [keepBytes / 2, keepBytes / 4, 0]) {
        if (best) break; keptReserve = r;
        for (let h = 0.5; h >= MIN_ATLAS_DOWNSCALE && !best; h /= 2) { const c = fits(h, full - r); if (c !== null) best = [h, c]; }
      }
    }
    const [h, c] = best ?? [MIN_ATLAS_DOWNSCALE, MIN_ATLAS_DOWNSCALE];
    this.downscale = h; this.coldDownscale = c;
    if (!best) pin = 0;
    this.pinnedKeys = new Set(pin ? list.filter((_, i) => (pin === 2 ? pinned : visPin)[i]).map((a) => a.key) : []);
    this.fitInfo = { reserveMB: Math.round(keptReserve / 1048576), reserveWantedMB: Math.round(reserveBytes / 1048576), demoted, pinned: [...this.pinnedKeys] };
    this.pack(dims(h, c));
    if (h < 1) {
      const nc = list.filter((a) => a.cold).length;
      console.warn(`[render] atlas arrays over the ${this.textureBudgetMB} MB GPU budget at full res: hot x${h} (${list.length - nc} atlases), cold x${c} (${nc}) (~${Math.round(this.estimate(list) / 1048576)} MB)`);
    }
    await Promise.all(list.map((a, i) => { const k = scaleOf(i, h, c); return k < 1 ? scaleList([a], k) : undefined; }));
  }
  /** Tier every resident atlas (see defaultAtlasTier / atlasTier / recentlyUsed). */
  private classify(list: AtlasRT[]): void {
    const reg = this.registryForTier; const wear = new Map<string, [number, number]>(); const bodies = new Set<string>();
    if (reg) {
      const ws = wearableSpriteIds(reg);
      for (const sp of reg.allSprites()) { const e = wear.get(sp.atlas.key) ?? [0, 0]; e[1]++; if (ws.has(sp.id)) e[0]++; wear.set(sp.atlas.key, e); if (/body|bodies/i.test(sp.key ?? "")) bodies.add(sp.atlas.key); }
    }
    for (const a of list) {
      const e = wear.get(a.key); const info = { bodies: bodies.has(a.key), wearShare: e && e[1] ? e[0] / e[1] : 0 };
      a.cold = !this.recentlyUsed.has(a.key) && !(this.residentCreatures && (RESIDENT_CREATURE_RE.test(a.key) || RESIDENT_GROUND_RE.test(a.key))) /* ADR-156: resident creature sheets are hot (never x0.125 mosaics) */ && (this.atlasTier ?? defaultAtlasTier)(a.key, info) === "cold";
    }
  }
  private registryForTier: AssetRegistry | null = null;
  /** ADR-237: resident atlases the last fitBudget kept x1 while the hot tier was halved. */
  private pinnedKeys = new Set<string>();
  /** Hot/cold split of the resident atlases (keys) after the last rebuild. */
  get tiers(): { hot: string[]; cold: string[]; hotScale: number; coldScale: number } {
    const r = this.atlases.filter((a) => !a.lazy);
    return { hot: r.filter((a) => !a.cold).map((a) => a.key), cold: r.filter((a) => a.cold).map((a) => a.key), hotScale: this.downscale, coldScale: this.coldDownscale };
  }

  /** Layer count the old shelf packer needs for `list` (budget planning only: tier scales and pool sizes are chosen
   *  against it, so the tighter MaxRects placement lowers the total instead of being refilled with more/larger pages). */
  private shelfLayers(list: AtlasRT[]): number {
    const S = this.layerSize, GAP = 2;
    const order = [...list].sort((a, b) => (b.img ? b.img.height : 0) - (a.img ? a.img.height : 0));
    let layer = 0, x = 0, y = 0, rowH = 0;
    for (const a of order) {
      const w = a.img!.width, h = a.img!.height;
      if (w > S || h > S) throw new Error(`atlas ${a.key} (${w}x${h}) exceeds layer size ${S}`);
      if (x + w > S) { x = 0; y += rowH + GAP; rowH = 0; }
      if (y + h > S) { layer++; x = 0; y = 0; rowH = 0; }
      x += w + GAP; rowH = Math.max(rowH, h);
    }
    return layer + 1;
  }
  /** Resident layers the budget planner charges for (shelf count of the last pack; >= the real MaxRects count). */
  private planLayers = 0; private packedLayers = 0;
  /** ADR-251: season whose gt_<season>_p* pages are pinned at 1x (TileTerrain sets the drawn one; the others may halve). */
  groundPinSeason: "summer" | "fall" | "winter" | "spring" = "summer";
  private groundPinOk(key: string): boolean { const m = /^gt_(summer|fall|winter|spring)_/.exec(key); return !m || m[1] === this.groundPinSeason; }
  /**
   * Pack whole atlas images into array layers: MaxRects (best short side fit) across layers, largest first, rects
   * padded by a 2px gutter and rounded to 4px so side arrays (>> sideShift <= 2) stay texel-exact. Only placement
   * changed (layer/px/py); side arrays keep one layer per colour layer (no sparse side map).
   */
  private pack(list: AtlasRT[]): void {
    const S = this.layerSize, GAP = 2; const al = (v: number) => (v + 3) & ~3;
    const order = [...list].sort((a, b) => Math.max(b.img!.width, b.img!.height) - Math.max(a.img!.width, a.img!.height) || b.img!.width * b.img!.height - a.img!.width * a.img!.height || a.id - b.id);
    type R = { x: number; y: number; w: number; h: number };
    const free: R[][] = [];
    const place = (fr: R[], w: number, h: number): R | null => { let best: R | null = null, bs = Infinity, bl = Infinity;
      for (const f of fr) if (w <= f.w && h <= f.h) { const ss = Math.min(f.w - w, f.h - h), ls = Math.max(f.w - w, f.h - h); if (ss < bs || (ss === bs && ls < bl)) { bs = ss; bl = ls; best = { x: f.x, y: f.y, w, h }; } }
      return best; };
    const split = (fr: R[], u: R): R[] => { const out: R[] = [];
      for (const f of fr) {
        if (u.x >= f.x + f.w || u.x + u.w <= f.x || u.y >= f.y + f.h || u.y + u.h <= f.y) { out.push(f); continue; }
        if (u.x > f.x) out.push({ x: f.x, y: f.y, w: u.x - f.x, h: f.h });
        if (u.x + u.w < f.x + f.w) out.push({ x: u.x + u.w, y: f.y, w: f.x + f.w - u.x - u.w, h: f.h });
        if (u.y > f.y) out.push({ x: f.x, y: f.y, w: f.w, h: u.y - f.y });
        if (u.y + u.h < f.y + f.h) out.push({ x: f.x, y: u.y + u.h, w: f.w, h: f.y + f.h - u.y - u.h });
      }
      return out.filter((r, i) => !out.some((o, j) => j !== i && o.x <= r.x && o.y <= r.y && o.x + o.w >= r.x + r.w && o.y + o.h >= r.y + r.h && (j < i || o.w !== r.w || o.h !== r.h || o.x !== r.x || o.y !== r.y))); };
    for (const a of order) {
      const w = a.img!.width, h = a.img!.height;
      if (w > S || h > S) throw new Error(`atlas ${a.key} (${w}x${h}) exceeds layer size ${S}`);
      const pw = Math.min(S, al(w + GAP)), ph = Math.min(S, al(h + GAP));
      let l = 0, r: R | null = null;
      for (; l < free.length; l++) if ((r = place(free[l]!, pw, ph))) break;
      if (!r) { free.push([{ x: 0, y: 0, w: S, h: S }]); l = free.length - 1; r = place(free[l]!, pw, ph)!; }
      free[l] = split(free[l]!, r);
      a.layer = l; a.px = r.x; a.py = r.y;
    }
    this.layers = Math.max(1, free.length); this.packedLayers = this.layers;
    this.planLayers = Math.max(this.layers, list.length ? this.shelfLayers(list) : 1);
    let base = 0; for (const a of list) { a.base = base; base += a.count; }
    this.totalFrames = base;
  }

  /** frame entry -> tint row (sprites with SpriteDef.tints get their own row; 0 = globals). */
  private frameTintRows(registry: AssetRegistry, list: AtlasRT[]): Map<number, number> {
    const rows: AtlasManager["tintRows"] = [null]; const map = new Map<number, number>();
    const byId = new Map(list.map((a) => [a.id, a])); // ADR-380: was list.find per tinted sprite
    for (const s of registry.allSprites()) {
      const tints = s.tints; // typed SpriteDef.tints (batch 11/12)
      if (!tints || !Object.keys(tints).length) continue;
      const at = byId.get(s.atlas.id); if (!at) continue;
      const row = rows.length; rows.push(tints);
      const mark = (f: number) => { if (f >= 0 && f < at.count) map.set(at.base + f, row); };
      for (const an of s.animList) for (let d = 0; d < an.directions; d++) for (const f of an.frames) mark(f + d * an.dirStride);
      for (const r of s.building?.frames ?? []) for (const f of r) mark(f);
      for (const st of s.building?.states ?? []) for (const r of st) for (const f of r) mark(f);
    }
    this.tintRows = rows;
    return map;
  }

  private uploadTints(): void {
    const gl = this.gl; const rows = this.tintRows; const W = STATUS_TINTS.length * 2;
    const data = new Float32Array(W * rows.length * 4);
    const g = this.statusTints;
    rows.forEach((over, r) => {
      STATUS_TINTS.forEach((name, i) => {
        const o = (r * W + i * 2) * 4; const t = over?.[name]; const d = g?.[name];
        if (t) {
          data[o] = ((t.color >>> 16) & 255) / 255; data[o + 1] = ((t.color >>> 8) & 255) / 255; data[o + 2] = (t.color & 255) / 255; data[o + 3] = t.strength;
          data[o + 4] = TINT_MODE_INDEX[t.mode as keyof typeof TINT_MODE_INDEX] ?? 0; data[o + 5] = t.saturation ?? 1; data[o + 6] = 1;
        } else if (d) {
          data[o] = d.color[0]; data[o + 1] = d.color[1]; data[o + 2] = d.color[2]; data[o + 3] = d.strength;
          data[o + 4] = TINT_MODE_INDEX[d.mode]; data[o + 5] = d.saturation;
        } else { data[o] = data[o + 1] = data[o + 2] = 1; data[o + 3] = 0; data[o + 5] = 1; }
      });
    });
    if (this.tintTex) gl.deleteTexture(this.tintTex);
    const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, W, rows.length, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.tintTex = t;
  }

  /**
   * A random drip spawn point (sheen mask B > 0.5) of a frame, relative to the pivot in 1x px, or null (no sheen mask /
   * no B pixels / no 2D canvas). Pixels are read once per atlas and cached.
   */
  dripPoint(spriteId: number, entryHint: number, rnd: () => number): [number, number] | null {
    const s = this.sprites[spriteId]; if (!s) return null; const a = this.atlases[s.atlasIdx]!;
    const mask = a.masks.sheen; if (!mask) return null;
    let px = this.maskPixels.get(a.key);
    if (px === undefined) {
      px = null;
      try {
        if (typeof OffscreenCanvas !== "undefined") {
          const c = new OffscreenCanvas(mask.width, mask.height); const g = c.getContext("2d")!; g.drawImage(mask as CanvasImageSource, 0, 0);
          px = { w: mask.width, h: mask.height, data: g.getImageData(0, 0, mask.width, mask.height).data };
        }
      } catch { px = null; }
      this.maskPixels.set(a.key, px);
    }
    if (!px) return null;
    const f = entryHint - a.base; if (f < 0 || f >= a.count) return null;
    const k = a.scale; const r = rectOf(a, f);
    const fx = (r ? r.x : (f % a.cols) * a.fw) * k, fy = (r ? r.y : Math.floor(f / a.cols) * a.fh) * k, fw = (r ? r.w : a.fw) * k, fh = (r ? r.h : a.fh) * k;
    const ms = this.sideScale; // side masks are stored at half size
    for (let tries = 0; tries < 24; tries++) {
      const x = Math.floor(rnd() * fw), y = Math.floor(rnd() * fh);
      const mx = Math.min(px.w - 1, Math.floor((fx + x) * ms)), my = Math.min(px.h - 1, Math.floor((fy + y) * ms)); const o = (my * px.w + mx) * 4;
      if (px.data[o + 2]! > 127 && px.data[o + 3]! > 0) return [x / k - s.anchorX, y / k - s.anchorY];
    }
    return null;
  }

  private upload(list: AtlasRT[], tintRows: Map<number, number> = new Map(), all: AtlasRT[] = list): void {
    this.tintRowMap = tintRows;
    const gl = this.gl;
    // side arrays (emissive/masks) at half size: images were halved in halveSide(); offsets shift with them
    const sub = (im: ImageLike, a: AtlasRT) => { const x = a.px >> this.sideShift, y = a.py >> this.sideShift, H = this.layerSize >> this.sideShift;
      const w = Math.min(im.width, H - x), h = Math.min(im.height, H - y); if (w <= 0 || h <= 0) return;
      if (w !== im.width || h !== im.height) { this.uploadErrors.push(`side image ${a.key} ${im.width}x${im.height} clipped`); return; }
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, x, y, a.layer, w, h, 1, gl.RGBA, gl.UNSIGNED_BYTE, im as TexImageSource); };
    this.streamPets = all.some((a) => !!a.lazy && PET_SHEET_RE.test(a.key)); this.planOwn();
    const owned = this.pools.filter((p) => p.own); const own = owned[0];
    const ownLayers = owned.reduce((t, p) => t + p.layers, 0);
    const colourLayers = Math.max(1, this.layers - ownLayers);
    // streamed pool layers (the tail) never carry sheen/sway masks (and emissive only for vehicle pools): those side
    // arrays stop at the first pool layer (their flag bits are never set for pool pages, so they are never sampled there)
    const firstPool = this.pools.length ? Math.min(...this.pools.map((p) => p.first)) : this.layers;
    const residentLayers = Math.max(1, firstPool);
    const mk = (side = false, nLayers?: number): WebGLTexture => {
      const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
      const S = side ? Math.max(1, this.layerSize >> this.sideShift) : this.layerSize;
      const levels = Math.floor(Math.log2(S)) + 1;
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl.RGBA8, S, S, nLayers ?? (side ? this.layers : colourLayers)); if (!side) this.texLevels = levels;
      const err = gl.getError(); if (err !== gl.NO_ERROR) { this.uploadErrors.push(`texStorage3D ${S}x${S}x${this.layers} levels ${levels}: 0x${err.toString(16)}`); if (err === gl.OUT_OF_MEMORY) this.oomFlag = true; }
      setLevelRange(gl, gl.TEXTURE_2D_ARRAY, levels, this.magNearest);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    if (this.tex) gl.deleteTexture(this.tex); if (this.emisTex) gl.deleteTexture(this.emisTex);
    for (const t of [this.sheenTex, this.swayTex, this.tintMaskTex]) if (t) gl.deleteTexture(t);
    if (this.poolTex) { gl.deleteTexture(this.poolTex); this.poolTex = null; } // before the new arrays: never hold old + new at once (peak)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.tex = mk();
    if (own) {
      const o = own.own!; const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, o.levels, o.fmt ?? gl.RGBA8, this.layerSize, this.layerSize, ownLayers);
      const err = gl.getError(); if (err !== gl.NO_ERROR) { this.uploadErrors.push(`pool texStorage3D ${o.fmt ?? "RGBA8"} x${ownLayers}: 0x${err.toString(16)}`); if (err === gl.OUT_OF_MEMORY) this.oomFlag = true; }
      setLevelRange(gl, gl.TEXTURE_2D_ARRAY, o.levels, this.magNearest);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.poolTex = t; this.poolFirst = own.first;
    } else { for (const p of this.pools) delete p.own; this.poolTex = dummyArray(gl); this.poolFirst = 1 << 20; }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    for (const a of list) gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, a.px, a.py, a.layer, a.img!.width, a.img!.height, 1, gl.RGBA, gl.UNSIGNED_BYTE, a.img as TexImageSource);
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    this.hasEmissive = list.some((a) => a.emis) || this.pools.some((p) => p.emis);
    this.emisTex = this.hasEmissive ? mk(true, this.pools.some((p) => p.emis) ? this.layers : residentLayers) : dummyArray(gl); // emissive is gated by a frame flag: no full array when unused
    const sideSave = this.sideSaving(list);
    this.gpuBytes = this.estimate(list) - this.ownSaving() - sideSave;
    const poolBytes = this.pools.reduce((t, p) => t + p.layers * this.layerBytes(list), 0) - this.ownSaving() - sideSave;
    this.vram.budgetBytes = this.textureBudgetMB * 1048576; this.vram.setResident(this.gpuBytes - poolBytes, poolBytes);
    this.vram.pageSlots = this.pools.reduce((t, p) => t + p.lru.capacity, 0); this.vram.pending = 0;
    for (const a of list) if (a.emis) sub(a.emis, a);
    if (this.hasEmissive) gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    // mask arrays: full layout only when some atlas has that mask, else a 1x1 dummy (never sampled: flag bit unset)
    const maskArray = (m: MaskName): WebGLTexture => {
      if (!list.some((a) => a.masks[m]) && !(m === "tintmask" && this.pools.some((p) => p.tint))) {
        const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
        gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 1, 1, 1);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
        setLevelRange(gl, gl.TEXTURE_2D_ARRAY, 1);
        return t;
      }
      const t = mk(true, m === "tintmask" ? this.layers : residentLayers);
      for (const a of list) { const im = a.masks[m]; if (im) sub(im, a); }
      gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
      return t;
    };
    this.sheenTex = maskArray("sheen"); this.swayTex = maskArray("sway"); this.tintMaskTex = maskArray("tintmask");
    // frame table
    const n = Math.max(1, this.totalFrames); const rows = Math.ceil(n / TABLE_W);
    const data = new Float32Array(TABLE_W * 2 * rows * 4); this.table = data; this.tableDirty0 = this.tableDirty1 = -1; this.tableRowDirty = new Uint8Array(rows);
    void all;
    for (const a of list) this.writeFrames(a, data, tintRows);
    if (this.frameTex) gl.deleteTexture(this.frameTex);
    const ft = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, ft);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TABLE_W * 2, rows, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.frameTex = ft;
  }

  /** Frame-table rows of one atlas at its packed position (or zeroed when `clear`: a streamed page that is not resident). */
  private writeFrames(a: AtlasRT, data: Float32Array, tintRows: Map<number, number>, clear = false): void {
    const S = this.layerSize;
    if (clear) { data.fill(0, a.base * 8, (a.base + a.count) * 8); this.markTable(a); return; }
    for (let f = 0; f < a.count; f++) {
      const r = rectOf(a, f);
      const x = r ? r.x : (f % a.cols) * a.fw, y = r ? r.y : Math.floor(f / a.cols) * a.fh;
      const w = r ? r.w : a.fw, h = r ? r.h : a.fh; const k = a.scale;
      const o = (a.base + f) * 8;
      data[o] = (a.px + x * k) / S; data[o + 1] = (a.py + y * k) / S; data[o + 2] = (a.px + (x + w) * k) / S; data[o + 3] = (a.py + (y + h) * k) / S;
      const bits = (a.emis ? FrameBits.Emissive : 0) | (a.masks.sheen ? FrameBits.Sheen : 0) | (a.masks.sway ? FrameBits.Sway : 0) | (a.masks.tintmask ? FrameBits.TintMask : 0);
      data[o + 4] = w; data[o + 5] = h; data[o + 6] = a.layer; data[o + 7] = bits + (tintRows.get(a.base + f) ?? 0) * 16;
    }
    if (a.lazy) this.markTable(a);
  }
  private markTable(a: AtlasRT): void {
    const r0 = Math.floor(a.base / TABLE_W), r1 = Math.floor((a.base + Math.max(1, a.count) - 1) / TABLE_W);
    this.tableDirty0 = this.tableDirty0 < 0 ? r0 : Math.min(this.tableDirty0, r0); this.tableDirty1 = Math.max(this.tableDirty1, r1);
    for (let r = r0; r <= r1 && r < this.tableRowDirty.length; r++) this.tableRowDirty[r] = 1;
  }

  // ---- wearable page streaming -------------------------------------------------------------------------------------

  /** Once per frame before drawing: advances the LRU clock and uploads frame-table rows patched by page-ins/evictions. */
  beginFrame(): void {
    this.frame++; this.streamStarts = 0; this.uploadsThisFrame = 0;
    while (this.uploadWaiters?.length && this.uploadsThisFrame < PAGE_UPLOADS_PER_FRAME) { this.uploadsThisFrame++; this.uploadWaiters.shift()!(); }
    if ((this.frame & 15) === 0) this.unloadIdleStream();
    if (this.queue.length) this.pump();
    if (this.tableDirty0 < 0 || !this.frameTex) return;
    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, this.frameTex);
    // ADR-154: upload only the contiguous runs of patched rows. The old min..max span re-sent most of the table (MBs of
    // RGBA32F) whenever two far-apart sheets paged in/out in the same frame - the main per-frame cost while streaming.
    const d = this.tableRowDirty, hi = Math.min(this.tableDirty1, d.length - 1); this.tableSpanRows += hi - this.tableDirty0 + 1;
    for (let r = this.tableDirty0; r <= hi; r++) {
      if (!d[r]) continue; let e = r; while (e + 1 <= hi && d[e + 1]) e++;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r, TABLE_W * 2, e - r + 1, gl.RGBA, gl.FLOAT, this.table.subarray(r * TABLE_W * 8, (e + 1) * TABLE_W * 8));
      this.tableRowUploads += e - r + 1; d.fill(0, r, e + 1); r = e;
    }
    this.tableDirty0 = this.tableDirty1 = -1;
  }
  /** frame-table rows uploaded (ADR-154 stat) */
  tableRowUploads = 0;
  /** rows the pre-ADR-154 min..max span upload would have sent */
  tableSpanRows = 0;
  private streamStarts = 0;
  /** ADR-148: decoded pages wait here for their GPU upload turn - at most PAGE_UPLOADS_PER_FRAME uploads per frame (the
   *  local player's own pages never wait), so a burst of finished decodes no longer lands as one long frame. */
  private uploadsThisFrame = 0; private uploadWaiters: (() => void)[] = [];
  private uploadTurn(prio: number): Promise<void> | void {
    if (prio === 0 || this.settling || this.uploadsThisFrame < PAGE_UPLOADS_PER_FRAME) { this.uploadsThisFrame++; return; }
    return new Promise<void>((res) => (this.uploadWaiters ??= []).push(res));
  }
  /** Stream pool pages not touched for STREAM_UNLOAD_FRAMES (off-screen and outside the keep radius) are dropped. */
  private unloadIdleStream(): void {
    if (this.ctxLost) return;
    const sp = this.pools.find((p) => p.cls === "stream"); if (!sp || !sp.lru.size) return;
    const cut = this.frame - STREAM_UNLOAD_FRAMES;
    for (const a of this.atlases) { if (a.lazy?.state !== 2 || this.poolOfA(a) !== sp) continue; const lu = sp.lru.lastUsedOf(a.key);
      if (lu >= 0 && lu < cut && sp.lru.refCount(a.key) === 0) { sp.lru.remove(a.key); this.vram.evict(sp.slotBytes); a.lazy!.state = 0; a.layer = -1; this.writeFrames(a, this.table, this.tintRowMap, true); } }
  }
  /** Stream sheets: is this resolved frame's page drawable? Non-stream atlases: always true (no request, no miss). */
  streamPageReady(atlasIdx: number, prio = Infinity): boolean { const a = this.atlases[atlasIdx]; if (!a?.lazy || this.poolOfA(a)?.cls !== "stream") return true; return this.pageReadyA(a, prio); }
  /** True when the sprite's (first) sheet is a manifest stream sheet. */
  isStreamSprite(spriteId: number): boolean { const a = this.lazyOf(spriteId); return !!a && this.poolOfA(a)?.cls === "stream"; }
  /** Near-view prefetch for stream sprites: `load` = inside the load radius (request when missing), else inside the keep
   *  radius (touch only: keeps a resident page from timing out, never requests). No miss is counted. */
  streamNear(spriteId: number, load: boolean, prio = Infinity): void {
    const a = this.lazyOf(spriteId); const p = a && this.poolOfA(a); if (!a || !p || p.cls !== "stream" || !this.poolOn(p, prio)) return;
    if (a.lazy!.state === 2) p.lru.touch(a.key, this.frame, prio); else if (load) this.request(a, prio);
  }
  private placeholderCache = new Map<number, number>();
  /** Sprite drawn while a stream sheet loads: sprite.placeholder ?? atlas.placeholder (sprite key on a resident atlas);
   *  -1 = draw nothing (null, missing, unknown, or itself streamed). */
  placeholderOf(spriteId: number): number {
    const c = this.placeholderCache.get(spriteId); if (c !== undefined) return c;
    let id = -1; const reg = this.registry;
    if (reg) { try { const s = reg.sprite(spriteId); const k = s.placeholder !== undefined ? s.placeholder : s.atlas.placeholder;
      if (typeof k === "string") { const pid = reg.ids.sprites.tryId(k); if (pid !== undefined && !this.lazyOf(pid)) id = pid; } } catch { id = -1; } }
    this.placeholderCache.set(spriteId, id); return id;
  }
  private lazyOf(spriteId: number, facing?: number): AtlasRT | null { const a = this.atlasAt(spriteId, facing); return a?.lazy ? a : null; }
  /** Atlas a sprite draws from at `facing` (first anim, first frame): its dirFrames page when facing-split (facing
   *  undefined = facing 0), else sprite.atlas. */
  private atlasAt(spriteId: number, facing?: number): AtlasRT | undefined {
    const s = this.sprites[spriteId]; if (!s) return undefined; const d = s.dirAt[0]; const an = s.anims[0];
    if (d && an) { const i = d[AssetRegistry.directionIndex(facing ?? 0, an.directions)]; if (i !== undefined && i >= 0) return this.atlases[i]; }
    return this.atlases[s.atlasIdx];
  }
  /** Page key a sprite streams at `facing` (facing-split sprites: that facing's page), or null when resident. */
  pageKeyAt(spriteId: number, facing?: number): string | null { return this.lazyOf(spriteId, facing)?.key ?? null; }
  /** True when the sprite's art can be drawn now. Streamed pages are touched (LRU) and requested when missing. */
  pageReady(spriteId: number, prio = Infinity, facing?: number): boolean { return this.pageReadyA(this.lazyOf(spriteId, facing), prio); }
  /** pageReady() for the page a resolve() actually read (`ResolvedFrame.atlas`): multi-page sprites (swim/punch on a
   *  second body/wear page via dirFrames) stream the page of the drawn anim + facing, not the sprite's first page. */
  pageReadyAt(atlasIdx: number, prio = Infinity): boolean { const a = this.atlases[atlasIdx]; return this.pageReadyA(a?.lazy ? a : null, prio); }
  private pageReadyA(a: AtlasRT | null, prio: number): boolean {
    if (!a) return true;
    const p = this.poolOfA(a); if (!p || !this.poolOn(p, prio)) { this.vram.misses++; return false; }
    if (a.lazy!.state === 2 && p.lru.touch(a.key, this.frame, prio)) return true;
    this.vram.misses++; this.request(a, prio); return false;
  }
  /** Residency of a sprite's page for ?diag: "resident" | "loading" | "missing" | "resident" (non-streamed) + pool scale. */
  pageInfo(spriteId: number): { state: "resident" | "loading" | "missing"; scale: number; streamed: boolean } {
    const a = this.lazyOf(spriteId); const s = this.sprites[spriteId]; const r = s ? this.atlases[s.atlasIdx] : undefined;
    if (!a) return { state: "resident", scale: r?.scale ?? 1, streamed: false };
    const p = this.poolOfA(a); return { state: a.lazy!.state === 2 ? "resident" : a.lazy!.state === 1 ? "loading" : "missing", scale: p?.k ?? 0, streamed: true };
  }
  /** Page refcount (+1) for a sprite's atlas; held pages are evicted only after unreferenced ones. Prefetches. */
  /** Facing-split sprites (dirFrames) are refcounted per facing page: pass the facing (undefined = facing 0); a holder
   *  that turns retains the new facing before releasing the old one. */
  retainSprite(spriteId: number, facing?: number): void { const a = this.lazyOf(spriteId, facing); const p = a && this.poolOfA(a); if (!a || !p) return; p.lru.retain(a.key); this.request(a); }
  releaseSprite(spriteId: number, facing?: number): void { const a = this.lazyOf(spriteId, facing); const p = a && this.poolOfA(a); if (a && p) p.lru.release(a.key); }
  /** Mark a drawn sprite's atlas as recently used: it is classified hot at the next rebuild (budget / fallback refit). */
  /** markUsed() for a resolved page (multi-page sprites: the anim's own page is hot too). */
  /** Atlas drawn with crisp (sharp bilinear) sampling: all world art except the soft NON_CRISP set (ADR-145
   *  creatures were the only crisp ones before; characters, buildings and ground were plain LINEAR, hence blurry
   *  at phone magnification on every preset). Minified art is untouched: crispUv is a no-op at >= 1 texel/px. */
  isCrisp(atlasIdx: number): boolean { let c = this.crispMark[atlasIdx]; if (c === undefined) { const a = this.atlases[atlasIdx]; if (!a) return false; c = this.crispMark[atlasIdx] = NON_CRISP_ATLAS_RE.test(a.key) ? 0 : 1; } return c === 1; }
  private crispMark: (0 | 1)[] = [];
  markUsedAt(atlasIdx: number): void { const a = this.atlases[atlasIdx]; if (a && !a.lazy && this.usedMark[atlasIdx] !== 1) { this.usedMark[atlasIdx] = 1; this.recentlyUsed.add(a.key); } }
  markUsed(spriteId: number): void { const s = this.sprites[spriteId]; if (!s) return; const a = this.atlases[s.atlasIdx]; if (a && !a.lazy && this.usedMark[s.atlasIdx] !== 1) { this.usedMark[s.atlasIdx] = 1; this.recentlyUsed.add(a.key); } }
  private usedMark = new Uint8Array(0);
  /** Pool class of a sprite's streamed page ("wear" | "veh"), or null when resident. */
  streamClass(spriteId: number): PoolClass | null { const a = this.lazyOf(spriteId); return a ? this.poolOfA(a)?.cls ?? null : null; }
  /** Request pages for these sprites (e.g. a creator preview selection); resolves when all are resident or failed. */
  async prefetch(spriteIds: Iterable<number>): Promise<void> {
    const want = [...new Set([...spriteIds].map((id) => this.lazyOf(id)).filter((a): a is AtlasRT => !!a))];
    for (const a of want) this.request(a);
    const g = this.gen;
    for (let i = 0; i < 600 && g === this.gen && want.some((a) => a.lazy!.state === 1 || this.queue.includes(a)); i++) await new Promise((r) => setTimeout(r, 16));
  }
  /**
   * ADR-374: one warm-up pump tick — the per-frame page-in budget reset that beginFrame() does,
   * without a rendered frame. Resets the stream-start and GPU-upload counters, releases the next
   * decoded pages waiting for their upload turn (at most PAGE_UPLOADS_PER_FRAME), and re-drives
   * pump(). Deliberately NOT beginFrame(): it does not advance `this.frame` (the LRU clock, and
   * the unloadIdleStream cadence that runs off it — a warm-up tick can never evict a page), and it
   * does no frame-table GL upload (dirty rows upload on the first rendered frame's beginFrame).
   * The tick itself issues no GL calls; the only GL work it can trigger is pageIn's own
   * texSubImage3D uploads — the same uploads a rendered frame performs, on the same context,
   * which IsoRenderer owns and which is current (setRegistry has run before the boot warm-up;
   * no other GL user runs during the boot window). The 2/frame caps are unchanged: the tick
   * resets the same counters beginFrame resets, to the same limits.
   */
  pumpWarmupTick(): void {
    this.streamStarts = 0; this.uploadsThisFrame = 0;
    while (this.uploadWaiters?.length && this.uploadsThisFrame < PAGE_UPLOADS_PER_FRAME) { this.uploadsThisFrame++; this.uploadWaiters.shift()!(); }
    if (this.queue.length) this.pump();
  }
  /** ADR-374: slots of the main manifest stream-sheet pool (24 desktop / 12 low-memory) — the
   * warm-up page budget clamps to it. The oversize stream pool (2 / 1 slots) is not counted:
   * the clamp is conservative. Undefined when no stream pool is planned yet. */
  streamPoolSlots(): number | undefined {
    return this.pools?.find((p) => p.cls === "stream")?.lru.capacity;
  }
  /**
   * ADR-370: warm-up window — request the first-view / visible-pin lazy pages first, at
   * near-player priority, and wait (bounded) for them to land before the first paint.
   * Reuses request()/pump()/pageIn: prio WARMUP_PRIO (1) is <= PRIO_NEAR, so the pages are
   * budget-exempt like near art, but != 0, so they still go through the per-frame upload turn
   * (PAGE_UPLOADS_PER_FRAME) and never jump the local player's own pages. A timeout never
   * blocks boot: the caller continues with a soft start, and the world-ready warm-up
   * (main.ts drainFirstView) retries the drain once the player has spawned.
   *
   * ADR-374: the wait loop used to idle — beginFrame() is the only place that resets
   * streamStarts / uploadsThisFrame, and it only runs during a rendered frame, which does not
   * exist yet at boot (iso is assigned after IsoView.create resolves). After 2 stream starts +
   * 2 GPU uploads both gates stalled, so the 1500 ms window expired with ~2 pages landed and
   * the first view still blurry. Each poll now gap-fills with pumpWarmupTick() when no rendered
   * frame has run since the last poll, so the window becomes real page-ins instead of idle
   * waiting. When frames ARE running (world entry), beginFrame already pumps and the tick
   * stays out of the way — at most one extra pump per poll, each bounded by the same 2/frame
   * caps, inside the same bounded window. The request count is clamped to the stream pool
   * (warmupPageBudget): a 12-slot low-memory pool caps at 12 pages, not 24.
   */
  async warmupFirstView(keys: Iterable<string>, opts: { firstView?: Iterable<string>; maxPages?: number; timeoutMs?: number } = {}): Promise<WarmupResult> {
    const t0 = Date.now();
    const firstView = new Set(opts.firstView ?? []);
    const ordered = sortWarmupKeys([...new Set(keys)], firstView).filter((k) => isWarmupCandidate(k, firstView));
    const maxPages = warmupPageBudget(this.streamPoolSlots(), opts.maxPages ?? WARMUP_MAX_PAGES);
    const timeoutMs = Math.max(0, opts.timeoutMs ?? WARMUP_WINDOW_MS);
    const want: AtlasRT[] = [];
    let alreadyResident = 0, skipped = 0;
    for (const k of ordered) {
      const a = this.atlases.find((x) => x.key === k);
      if (!a) { skipped++; continue; }
      if (!a.lazy) { alreadyResident++; continue; } // resident atlases are already on the GPU
      if (a.lazy.state === 2) { alreadyResident++; continue; }
      if (want.length >= maxPages) { skipped++; continue; }
      want.push(a);
    }
    for (const a of want) this.request(a, WARMUP_PRIO);
    const g = this.gen;
    const deadline = t0 + timeoutMs;
    let lastFrame = this.frame;
    while (g === this.gen && want.some((a) => a.lazy!.state !== 2) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, WARMUP_POLL_MS));
      // ADR-374: pump while no rendered frame is doing it — the boot window has no frames at all.
      if (g === this.gen && want.some((a) => a.lazy!.state !== 2) && this.frame === lastFrame) this.pumpWarmupTick();
      lastFrame = this.frame;
    }
    const landed = want.filter((a) => a.lazy!.state === 2).length;
    return { requested: want.length, alreadyResident, resident: alreadyResident + landed, stillPending: want.length - landed, skipped, ms: Date.now() - t0, timedOut: want.some((a) => a.lazy!.state !== 2) };
  }
  /** ADR-370: lazy page keys for sprites (deduped, first-seen order) — the caller passes the sprites in the first view so they sort tier 0 in warmupFirstView. */
  warmupKeysForSprites(spriteIds: Iterable<number>): string[] {
    const out: string[] = []; const seen = new Set<string>();
    for (const id of spriteIds) { const k = this.pageKey(id); if (k && !seen.has(k)) { seen.add(k); out.push(k); } }
    return out;
  }
  /**
   * ADR-370: wait (bounded) for the page-in queue to drain — used after the world is ready, while the
   * second loading screen still covers the first frames, so the overlay lifts onto a sharp frame.
   * Returns immediately when nothing is queued (no draws have requested pages yet).
   */
  async warmupDrain(timeoutMs: number = WARMUP_WINDOW_MS): Promise<{ pending: number; ms: number; drained: boolean }> {
    const t0 = Date.now(); const deadline = t0 + Math.max(0, timeoutMs);
    while (Date.now() < deadline) {
      if (this.queue.length + this.inflight === 0) return { pending: 0, ms: Date.now() - t0, drained: true };
      await new Promise((r) => setTimeout(r, WARMUP_POLL_MS));
    }
    const pending = this.queue.length + this.inflight;
    return { pending, ms: Date.now() - t0, drained: pending === 0 };
  }
  /** Atlas key of a sprite's streamed page (null when resident / not streamed). */
  pageKey(spriteId: number): string | null { return this.lazyOf(spriteId)?.key ?? null; }
  /** Streamed wearable atlases resident / known. */
  isStreamed(spriteId: number): boolean { return !!this.lazyOf(spriteId); }
  get vramStats(): VramStats & { pools: { cls: PoolClass; scale: number; slots: number; layers: number; resident: number; slotMB: number; /** ADR-251: approx. MB of the pool's layers (compressed own array or RGBA8 + side arrays) */ mb: number }[]; poolScale: number; layerSize: number; downscale: number; coldDownscale: number; hotAtlases: number; coldAtlases: number } {
    return { ...this.vram.stats(), poolScale: this.pools[0]?.k ?? 0, pools: this.pools.map((p) => ({ cls: p.cls, scale: p.k, slots: p.lru.capacity, layers: p.layers, resident: p.lru.size, slotMB: +(p.slotBytes / 1048576).toFixed(1), mb: this.poolMB(p) })), layerSize: this.layerSize, downscale: this.downscale, coldDownscale: this.coldDownscale, hotAtlases: this.tiers.hot.length, coldAtlases: this.tiers.cold.length };
  }
  private request(a: AtlasRT, prio = Infinity): void {
    if (this.ctxLost) return;
    const p = this.poolOfA(a); if (!p || !this.poolOn(p, prio) || a.lazy!.state !== 0) return;
    const qi = this.queue.indexOf(a);
    if (qi >= 0) { if (prio < (a.lazy!.prio ?? Infinity)) { a.lazy!.prio = prio; this.queue.splice(qi, 1); this.enqueue(a); } return; }
    if (!p.lru.canAllocate(a.key, this.frame, prio)) return; // every slot holds a nearer page in use: keep the fallback, retry later
    a.lazy!.prio = prio; this.enqueue(a); this.vram.pending = this.queue.length + this.inflight; this.pump();
  }
  /** Insert by priority (local player first, then by distance). */
  private enqueue(a: AtlasRT): void { const pr = a.lazy!.prio ?? Infinity; let i = this.queue.length; while (i > 0 && (this.queue[i - 1]!.lazy!.prio ?? Infinity) > pr) i--; this.queue.splice(i, 0, a); }
  private pump(): void {
    if (this.contextLost) return;
    while (this.inflight < PAGE_CONCURRENCY && this.queue.length) {
      // stream sheets: at most STREAM_UPLOADS_PER_FRAME page-in starts per frame (the rest wait in the queue)
      const qi = this.streamStarts >= STREAM_UPLOADS_PER_FRAME ? this.queue.findIndex((q) => this.poolOfA(q)?.cls !== "stream") : 0; if (qi < 0) break;
      const a = this.queue.splice(qi, 1)[0]!; const g = this.gen;
      const pr = a.lazy!.prio ?? Infinity; const p = this.poolOfA(a); if (!p || !this.poolOn(p, pr) || !p.lru.canAllocate(a.key, this.frame, pr)) continue;
      if (p.cls === "stream") this.streamStarts++;
      a.lazy!.state = 1; this.inflight++;
      this.pageIn(a, g).catch((e: unknown) => { reportRenderError(`atlas page-in ${a.key}`, e); if (g === this.gen) a.lazy!.state = 0; })
        .finally(() => { this.inflight--; this.vram.pending = this.queue.length + this.inflight; this.pump(); });
    }
  }
  private async pageIn(a: AtlasRT, g: number): Promise<void> {
    const p = this.poolOfA(a)!; const src = a.source;
    if (p.own) return this.pageInOwn(a, g, p);
    const p2 = p.k >= 2 ? src.pages?.find((q) => q.scale === 2) : undefined; const url = p2?.url ?? src.url; const ak = p.k >= 2 && !p2 ? 1 : p.k; // 1x-only sheet in a 2x pool
    const tintUrls = src.masks?.tintmask === undefined ? [] : Array.isArray(src.masks.tintmask) ? src.masks.tintmask : [src.masks.tintmask];
    const [img, tint, emi] = await Promise.all([this.loader(url), (async () => { if (!p.tint) return null; for (const u of tintUrls) { try { return await this.loader(u); } catch { /* next */ } } return null; })(),
      (async () => { if (!p.emis || !src.emissiveUrl) return null; try { return await this.loader(src.emissiveUrl); } catch { return null; } })()]);
    await this.uploadTurn(a.lazy!.prio ?? Infinity);
    if (g !== this.gen) return;
    const W = Math.max(1, Math.round(a.lazy!.w1 * ak)), H = Math.max(1, Math.round(a.lazy!.h1 * ak));
    const chain = async (im: ImageLike, q: "high" | "pixelated"): Promise<ImageLike[]> => {
      const out: ImageLike[] = []; let w = W, h = H; let cur = im;
      const levels = Math.floor(Math.log2(this.layerSize)) + 1;
      for (let l = 0; l < levels; l++) {
        if (cur.width !== w || cur.height !== h) cur = await createImageBitmap(cur as ImageBitmapSource, { resizeWidth: w, resizeHeight: h, resizeQuality: q, premultiplyAlpha: "none", colorSpaceConversion: "none" } as ImageBitmapOptions);
        out.push(cur); if (w === 1 && h === 1) break; w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
      }
      return out;
    };
    const [cc, tc, ec] = await Promise.all([chain(img, "high"), tint ? chain(tint, "pixelated") : Promise.resolve(null), emi ? chain(emi, "high") : Promise.resolve(null)]);
    if (g !== this.gen) return;
    if ((a.lazy!.prio ?? Infinity) > PRIO_NEAR && !this.vram.canPageIn(p.slotBytes)) { this.pageBudgetRefusals++; a.lazy!.state = 0; return; } // pages count against the budget
    if (this.contextLost) { a.lazy!.state = 0; this.ctxStats.uploadsSkipped++; return; }
    const slot = p.lru.allocate(a.key, this.frame, a.lazy!.prio ?? Infinity);
    if (!slot) { a.lazy!.state = 0; return; } // pool full of pages drawn this frame: retried on next pageReady
    if (slot.evicted !== undefined) {
      const ev = this.atlases.find((x) => x.key === slot.evicted);
      if (ev?.lazy) { ev.lazy.state = 0; ev.layer = -1; this.writeFrames(ev, this.table, this.tintRowMap, true); }
      this.vram.evict(p.slotBytes);
    }
    const layer = p.first + Math.floor(slot.slot / p.perLayer), si = slot.slot % p.perLayer;
    const px = (si % p.cols) * p.pw, py = Math.floor(si / p.cols) * p.ph;
    const gl = this.gl; gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    const pre = this.syncChecks ? gl.getError() : gl.NO_ERROR; if (pre === gl.OUT_OF_MEMORY) this.onFault?.("page", `GL_OUT_OF_MEMORY pending before page-in ${a.key}`);
    const maxL = this.texLevels || Math.floor(Math.log2(this.layerSize)) + 1;
    const put = (tex: WebGLTexture | null, levels: ImageLike[], cap: number) => {
      if (!tex) return; gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
      levels.slice(0, cap).forEach((im, l) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, l, px >> l, py >> l, layer, im.width, im.height, 1, gl.RGBA, gl.UNSIGNED_BYTE, im as TexImageSource));
    };
    put(this.tex, cc, maxL);
    if (tc && this.tintMaskTex) { gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tintMaskTex); tc.slice(this.sideShift, this.sideShift + Math.max(1, maxL - this.sideShift)).forEach((im, l) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, l, px >> (l + this.sideShift), py >> (l + this.sideShift), layer, im.width, im.height, 1, gl.RGBA, gl.UNSIGNED_BYTE, im as TexImageSource)); }
    // emissive (vehicle lights): cold tier, stored like the tint mask at side resolution (layerSize >> this.sideShift)
    if (ec && this.emisTex) { gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.emisTex); ec.slice(this.sideShift, this.sideShift + Math.max(1, maxL - this.sideShift)).forEach((im, l) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, l, px >> (l + this.sideShift), py >> (l + this.sideShift), layer, im.width, im.height, 1, gl.RGBA, gl.UNSIGNED_BYTE, im as TexImageSource)); }
    for (const im of [...cc, ...(tc ?? []), ...(ec ?? [])]) if (im !== img && im !== tint && im !== emi && typeof (im as ImageBitmap).close === "function") (im as ImageBitmap).close();
    for (const im of [img, tint, emi]) if (im && typeof (im as ImageBitmap).close === "function") (im as ImageBitmap).close();
    if (this.droppedByLoss(a, p)) { if (this.syncChecks) gl.getError(); return; }
    const err = this.syncChecks ? gl.getError() : gl.NO_ERROR;
    if (err !== gl.NO_ERROR) {
      // the driver refused the upload (Mali commits pages lazily: OOM shows up here, not at texStorage3D); free the slot,
      // keep the body-only fallback and report so the renderer steps down its fallback ladder
      p.lru.remove(a.key); a.lazy!.state = 0; a.layer = -1; this.pageFaults++;
      const msg = `page-in ${a.key}: ${err === gl.OUT_OF_MEMORY ? "OUT_OF_MEMORY" : "0x" + err.toString(16)}`;
      if (this.uploadErrors.length < 32) this.uploadErrors.push(msg); this.onFault?.("page", msg); return;
    }
    a.layer = layer; a.px = px; a.py = py; a.scale = ak;
    a.masks = tc ? { tintmask: { width: W, height: H } as ImageLike } : {}; // flag only (CPU pixels released)
    a.emis = ec ? ({ width: W, height: H } as ImageLike) : null; // flag only
    this.writeFrames(a, this.table, this.tintRowMap);
    a.lazy!.state = 2; this.vram.pageIn(p.slotBytes);
  }

  /** KTX2 page-ins (compressed colour) and KTX2 mask decodes, PNG fallbacks (diag). */
  ktx2Stats = { colour: 0, masks: 0, pngFallback: 0, failed: 0 };
  /**
   * Page-in for the wear pool's own array: colour from KTX2 (ETC1S -> probe target, compressedTexSubImage3D, level 0 only)
   * or PNG (RGBA8, only the allocated levels); tint mask from the UASTC KTX2 twin (decoded to RGBA, side resolution) or PNG.
   */
  private async pageInOwn(a: AtlasRT, g: number, p: Pool): Promise<void> {
    const src = a.source; const o = p.own!; const gl = this.gl;
    const os = this.ownSource(a, p.k); const p2 = p.k >= 2 ? src.pages?.find((q) => q.scale === 2) : undefined;
    const ak = o.fmt !== null ? os.scale : p.k >= 2 && !p2 ? 1 : p.k; // stored scale (1x-only sheet in a 2x pool: 1)
    const W = Math.max(1, Math.round(a.lazy!.w1 * ak)), H = Math.max(1, Math.round(a.lazy!.h1 * ak));
    const tintUrls = src.masks?.tintmask === undefined ? [] : Array.isArray(src.masks.tintmask) ? src.masks.tintmask : [src.masks.tintmask];
    const bmp = (im: ImageLike | ImageData, w: number, h: number, q: "high" | "pixelated") => createImageBitmap(im as ImageBitmapSource, { resizeWidth: w, resizeHeight: h, resizeQuality: q, premultiplyAlpha: "none", colorSpaceConversion: "none" } as ImageBitmapOptions);
    const colourP = (async (): Promise<{ kt: Awaited<ReturnType<typeof loadKtx2>>; levels: ImageLike[] }> => {
      if (o.fmt !== null && os.url && this.compressedCaps) { const kt = await loadKtx2(os.url, this.compressedCaps, false); if (kt && kt.target === o.target && kt.levels.length > os.base) return { kt, levels: [] }; }
      if (o.fmt !== null) return { kt: null, levels: [] }; // compressed array cannot take RGBA: page fails (body-only)
      const im = await this.loader(p2?.url ?? src.url); const out: ImageLike[] = []; let w = W, h = H, cur: ImageLike = im;
      for (let l = 0; l < o.levels; l++) { if (cur.width !== w || cur.height !== h) cur = await bmp(cur, w, h, "high"); out.push(cur); w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); }
      return { kt: null, levels: out };
    })();
    const sideW = Math.max(1, W >> this.sideShift), sideH = Math.max(1, H >> this.sideShift);
    const tintP = (async (): Promise<ImageLike[] | null> => {
      if (!p.tint) return null;
      let base: ImageLike | null = null;
      const k2 = os.scale >= 2 ? (p2 as { masksKtx2?: Partial<Record<MaskName, string>> } | undefined)?.masksKtx2?.tintmask ?? src.masksKtx2?.tintmask : src.masksKtx2?.tintmask; if (k2) { const r = await loadKtx2Rgba(k2); if (r) { base = await bmp(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), sideW, sideH, "pixelated"); this.ktx2Stats.masks++; } }
      if (!base) for (const u of tintUrls) { try { base = await this.loader(u); break; } catch { /* next */ } }
      if (!base) return null;
      const out: ImageLike[] = []; let w = sideW, h = sideH, cur = base; const n = Math.floor(Math.log2(Math.max(1, this.layerSize >> this.sideShift))) + 1;
      for (let l = 0; l < n; l++) { if (cur.width !== w || cur.height !== h) cur = await bmp(cur, w, h, "pixelated"); out.push(cur); if (w === 1 && h === 1) break; w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); }
      return out;
    })();
    const emisP = (async (): Promise<ImageLike[] | null> => {
      if (!p.emis || !src.emissiveUrl) return null; let cur: ImageLike; try { cur = await this.loader(src.emissiveUrl); } catch { return null; }
      const out: ImageLike[] = []; let w = sideW, h = sideH; const n = Math.floor(Math.log2(Math.max(1, this.layerSize >> this.sideShift))) + 1;
      for (let l = 0; l < n; l++) { if (cur.width !== w || cur.height !== h) cur = await bmp(cur, w, h, "high"); out.push(cur); if (w === 1 && h === 1) break; w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); }
      return out;
    })();
    const [col, tc, ec] = await Promise.all([colourP, tintP, emisP]);
    await this.uploadTurn(a.lazy!.prio ?? Infinity);
    if (g !== this.gen) return;
    if (!col.kt && !col.levels.length) { this.ktx2Stats.failed++; a.lazy!.state = 0; return; }
    if (col.kt) this.ktx2Stats.colour++; else if (src.ktx2 && this.ktx2Target) this.ktx2Stats.pngFallback++;
    if ((a.lazy!.prio ?? Infinity) > PRIO_NEAR && !this.vram.canPageIn(p.slotBytes)) { this.pageBudgetRefusals++; a.lazy!.state = 0; return; }
    if (this.contextLost) { a.lazy!.state = 0; this.ctxStats.uploadsSkipped++; return; }
    const slot = p.lru.allocate(a.key, this.frame, a.lazy!.prio ?? Infinity);
    if (!slot) { a.lazy!.state = 0; return; }
    if (slot.evicted !== undefined) {
      const ev = this.atlases.find((x) => x.key === slot.evicted);
      if (ev?.lazy) { ev.lazy.state = 0; ev.layer = -1; this.writeFrames(ev, this.table, this.tintRowMap, true); }
      this.vram.evict(p.slotBytes);
    }
    const layer = p.first + Math.floor(slot.slot / p.perLayer), si = slot.slot % p.perLayer;
    const px = (si % p.cols) * p.pw, py = Math.floor(si / p.cols) * p.ph;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (this.syncChecks) gl.getError();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.poolTex);
    if (col.kt) {
      // full chain: pool level l <- file level base + l at (px >> l, py >> l) (16px pitch keeps both 4-aligned up to l = 2);
      // block data covers ceil4 sizes, so the sub-rect is the level size rounded up to 4 (never past the slot pitch)
      for (let l = 0; l < o.levels; l++) {
        const data = col.kt.levels[os.base + l]; if (!data) break;
        const S = Math.max(1, this.layerSize >> l), lw = Math.max(1, col.kt.width >> (os.base + l)), lh = Math.max(1, col.kt.height >> (os.base + l));
        const w4 = Math.min(S - (px >> l), Math.ceil(lw / 4) * 4), h4 = Math.min(S - (py >> l), Math.ceil(lh / 4) * 4);
        gl.compressedTexSubImage3D(gl.TEXTURE_2D_ARRAY, l, px >> l, py >> l, layer - this.poolFirst, w4, h4, 1, o.fmt!, data);
      }
    } else col.levels.forEach((im, l) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, l, px >> l, py >> l, layer - this.poolFirst, im.width, im.height, 1, gl.RGBA, gl.UNSIGNED_BYTE, im as TexImageSource));
    if (tc && this.tintMaskTex) { gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tintMaskTex); tc.forEach((im, l) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, l, px >> (l + this.sideShift), py >> (l + this.sideShift), layer, im.width, im.height, 1, gl.RGBA, gl.UNSIGNED_BYTE, im as TexImageSource)); }
    if (ec && this.emisTex) { gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.emisTex); ec.forEach((im, l) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, l, px >> (l + this.sideShift), py >> (l + this.sideShift), layer, im.width, im.height, 1, gl.RGBA, gl.UNSIGNED_BYTE, im as TexImageSource)); }
    for (const im of [...col.levels, ...(tc ?? []), ...(ec ?? [])]) if (typeof (im as ImageBitmap).close === "function") (im as ImageBitmap).close();
    if (this.droppedByLoss(a, p)) { if (this.syncChecks) gl.getError(); return; }
    const err = this.syncChecks ? gl.getError() : gl.NO_ERROR;
    if (err !== gl.NO_ERROR) {
      p.lru.remove(a.key); a.lazy!.state = 0; a.layer = -1; this.pageFaults++;
      const msg = `page-in ${a.key}${col.kt ? " (ktx2 " + o.target + ")" : ""}: ${err === gl.OUT_OF_MEMORY ? "OUT_OF_MEMORY" : "0x" + err.toString(16)}`;
      if (this.uploadErrors.length < 32) this.uploadErrors.push(msg); this.onFault?.("page", msg); return;
    }
    a.layer = layer; a.px = px; a.py = py; a.scale = ak;
    a.masks = tc ? { tintmask: { width: W, height: H } as ImageLike } : {};
    a.emis = ec ? ({ width: W, height: H } as ImageLike) : null;
    this.writeFrames(a, this.table, this.tintRowMap);
    a.lazy!.state = 2; this.vram.pageIn(p.slotBytes);
  }
  /** Wear pool storage for ?diag. */
  get wearPoolInfo(): string { const p = this.wearPool(); if (!p) return "none"; const o = p.own; const v = this.pools.find((q) => q.cls === "veh"); return `${v ? `veh x${v.k} ${v.lru.capacity} slots ${(v.slotBytes / 1048576).toFixed(1)}MB/slot; ` : ""}wear x${p.k} ${p.lru.capacity} slots ${(p.slotBytes / 1048576).toFixed(1)}MB/slot, ${o ? (o.fmt !== null ? `KTX2->${o.target}` : "RGBA8") + ` ${o.levels} lvl` : "shared RGBA8"}; ktx2 target ${this.ktx2Target ?? "none"}; ktx2 pages ${this.ktx2Stats.colour}, masks ${this.ktx2Stats.masks}, png fallback ${this.ktx2Stats.pngFallback}, failed ${this.ktx2Stats.failed}; footprint ${this.charFootprint.toFixed(2)} px/texel`; }

  /**
   * VRAM consumers (MB, diag / spMobile): every allocated array split into resident atlases (colour share by packed
   * area incl. mips, side arrays by the same share), unused resident layer space, and each streamed pool. Sorted desc.
   */
  get vramBreakdown(): { name: string; mb: number }[] {
    const S = this.layerSize, sh = this.sideShift, out: { name: string; mb: number }[] = [];
    const resident = this.atlases.filter((a) => !a.lazy && a.img); const firstPool = this.pools.length ? Math.min(...this.pools.map((p) => p.first)) : this.layers;
    const sides = this.arrayCount(resident) - 1; const sideLayer = rgbaBytes(Math.max(1, S >> sh), Math.max(1, S >> sh), true);
    // side arrays sized for the resident layers (sheen/sway/emissive w/o pool emis) or every layer (tint mask, pool emis)
    const perResLayer = rgbaBytes(S, S, true) + sideLayer * sides; let used = 0;
    for (const a of resident) { const share = (a.img!.width * a.img!.height) / (S * S); used += share; out.push({ name: a.key, mb: share * perResLayer }); }
    out.push({ name: "(resident layer slack)", mb: Math.max(0, firstPool - used) * perResLayer });
    const sideFor = (p: Pool) => (p.tint ? 1 : 0) + (p.emis ? 1 : 0);
    for (const p of this.pools) {
      const colour = p.own ? this.ownLayerBytes(p.own) : rgbaBytes(S, S, true);
      out.push({ name: `pool:${p.cls} x${p.k} ${p.layers}L ${p.lru.capacity} slots${p.own?.fmt != null ? " ktx2" : ""} ${p.own ? p.own.levels + "lvl" : ""}`.trim(), mb: p.layers * (colour + sideLayer * sideFor(p)) });
    }
    return out.map((e) => ({ name: e.name, mb: Math.round((e.mb / 1048576) * 10) / 10 })).sort((x, y) => y.mb - x.mb);
  }

  get anyEmissive(): boolean { return this.hasEmissive; }

  /**
   * Resolve sprite + animation + facing + time to a frame-table entry and anchor (px). Allocation-free.
   * `anim` < 0 means "frame index `frame` of the first animation" (static sprites / variants).
   * Returns false when the sprite id is unknown.
   */
  resolve(spriteId: number, anim: number, facing: number, timeSec: number, frame: number, out: ResolvedFrame): boolean {
    const s = this.sprites[spriteId]; if (!s) return false;
    if (anim < 0 && (frame & FRAME_ANIM) !== 0) { anim = frame & 0x7fff; timeSec = 0; frame = 0; } // frame-select.ts: named anim, first frame
    const a = this.atlases[s.atlasIdx]!;
    const ai = anim < 0 ? 0 : s.anims[anim] ? anim : 0; const an = s.anims[ai]; if (!an) return false;
    let i: number; const n = an.frames.length;
    if (anim < 0) i = frame % n;
    else { i = Math.floor(timeSec * an.fps); i = an.loop ? ((i % n) + n) % n : Math.min(Math.max(0, i), n - 1); }
    // facing-split sprites: AssetRegistry.dirFrame() semantics (own page, frame and anchor per facing), allocation-free
    const dz = s.dirAt[ai]; const dirs = an.dirFrames;
    if (dz && dirs) {
      const di = i * an.directions + AssetRegistry.directionIndex(facing, an.directions); const d = dirs[di]; const ia = dz[di];
      if (d && ia !== undefined && ia >= 0) {
        const da = this.atlases[ia]!; const fz = s.dirF?.[ai]; const fi = fz ? fz[di]! : d.frame; this.fill(da, fi, s, out);
        if (d.rect) { out.w = d.rect.w; out.h = d.rect.h; out.ax = d.anchor.x * d.rect.w; out.ay = d.anchor.y * d.rect.h; }
        else if (!da.source.rects?.[fi]) { out.ax = d.anchor.x * da.fw; out.ay = d.anchor.y * da.fh; }
        out.sprite = spriteId; out.frame = fi; out.anim = an.name ?? ""; out.atlas = ia; out.dfi = di; return true;
      }
    }
    let f = an.frames[i]!;
    f += AssetRegistry.directionIndex(facing, an.directions) * (an.directions > 1 ? an.dirStride : 0);
    this.fill(a, f, s, out); out.sprite = spriteId; out.frame = f; out.anim = an.name ?? ""; out.atlas = s.atlasIdx;
    return true;
  }

  /** ADR-253: art with more than one facing (or rotation-aware building art). Non-directional sprites mirror on odd
   *  view quarters as the rotation fallback (sprites.ts); directional ones resolve facing + view instead. */
  isDirectional(spriteId: number): boolean {
    const s = this.sprites[spriteId]; if (!s) return false; if (s.building) return true;
    for (const an of s.anims) if (an && an.directions > 1) return true;
    return false;
  }

  /**
   * Resolve a build-piece frame through AssetRegistry.buildingFrame (rotation, damage stage, piece state, mirror
   * rotationArt -> out.flipX). out.hasDamageFrames is false when the stage has no own frame (crack overlay fallback).
   */
  resolvePiece(spriteId: number, variant: number, rotation: number, damage: number, out: ResolvedFrame, state = -1): boolean {
    if (variant > 0) { const g = this.variantById.get(spriteId); if (g?.length) { spriteId = g[variant % g.length]!; variant = 0; } }
    const s = this.sprites[spriteId]; if (!s || !this.registry) return false;
    const a = this.atlases[s.atlasIdx]!;
    if (s.building) {
      const ref = this.registry.buildingFrame(spriteId, rotation, damage, state);
      const intact = damage > 0 ? this.registry.buildingFrame(spriteId, rotation, 0, state) : ref;
      this.fill(a, ref.frame, s, out);
      out.flipX = !!ref.flipX; out.hasDamageFrames = damage > 0 && ref.frame !== intact.frame; return true;
    }
    const an = s.anims[0]; if (!an) return false;
    let f = damage > 0 && s.damage[damage] !== undefined ? s.damage[damage]! : an.frames[variant % an.frames.length]!;
    if (an.directions > 1) f += AssetRegistry.directionIndex((rotation & 3) * (Math.PI / 2), an.directions) * an.dirStride;
    this.fill(a, f, s, out);
    out.hasDamageFrames = damage > 0 && s.damage[damage] !== undefined;
    return true;
  }

  /**
   * Frame-table entries of one animation (for shader-side animation by frame offset, e.g. terrain water).
   * `contiguous` is true when frames[i] = frames[0] + i (then entry = first + floor(t * fps) % count is valid).
   */
  animEntries(spriteId: number, anim = 0): { first: number; count: number; fps: number; contiguous: boolean; w: number; h: number; ax: number; ay: number } | null {
    const s = this.sprites[spriteId]; if (!s) return null; const a = this.atlases[s.atlasIdx]!; const an = s.anims[anim] ?? s.anims[0]; if (!an) return null;
    const contiguous = an.frames.every((f, i) => f === an.frames[0]! + i);
    const r = newResolved(); this.fill(a, an.frames[0]!, s, r);
    return { first: r.entry, count: contiguous ? an.frames.length : 1, fps: an.fps, contiguous, w: r.w, h: r.h, ax: r.ax, ay: r.ay };
  }

  /**
   * BuildPiece.variant groups: base sprite key -> sprite keys by variant index (variant 0 = the base), e.g. Art's
   * pack/piece_variants.json `pieces` or pvp_clan wall looks (`wall` + variant). Unknown keys are reported, not thrown.
   * Building sprites without a group fall back to the variant-th frame of their first animation only when non-building.
   */
  setPieceVariants(table: Record<string, string[]>): string[] {
    this.variantKeys = table; return this.resolveVariants();
  }
  private variantKeys: Record<string, string[]> = {};
  private handsByAtlas = new Map<string, Record<string, HandAnchor>>();
  private handByEntry = new Map<number, HandAnchor>();
  /** Per-frame hand anchors of an atlas (Art `<atlas>.hands.json` `hands`: frame -> {x, y (1x px from frame top-left), angle deg, behind}). */
  setHands(atlasKey: string, json: { hands: Record<string, HandAnchor> }): void { this.handsByAtlas.set(atlasKey, json.hands); this.resolveHands(); }
  /** Hand anchor of a frame-table entry (ResolvedFrame.entry), if its atlas has one for that frame. */
  handAt(entry: number): HandAnchor | undefined { return this.handByEntry.get(entry); }
  /**
   * Hand anchor of a resolved frame (ADR-082): frameMeta `name` (default handR) via AssetRegistry.anchorPoint (pivot-relative,
   * unmirrored here; the caller mirrors with the instance flip), converted to frame top-left px like hands.json. Falls back to
   * Art's legacy `<atlas>.hands.json` only when the frame has no such anchor.
   */
  handOf(r: ResolvedFrame, name = "handR"): HandAnchor | undefined {
    const reg = this.registry;
    if (reg && r.sprite >= 0) {
      const anchors = r.dfi >= 0 && r.anim ? reg.dirFrameAnchors(r.sprite, r.anim, r.dfi, r.frame) : reg.frameAnchors(r.sprite, r.frame, r.anim || undefined);
      const a = anchors ? AssetRegistry.anchorPoint({ anchors } as FrameRef, name) : undefined;
      if (a) return { x: r.ax + a.x, y: r.ay + a.y, angle: a.angle ?? 0, ...(a.len !== undefined ? { len: a.len } : {}), behind: a.behind ?? false };
    }
    return name === "handR" ? this.handByEntry.get(r.entry) : undefined; // legacy hands.json only carries the main hand
  }
  /**
   * ADR-128 neck: offset (unmirrored 1x frame px, +y down) of head-group layers over body frame `r`: the frame's `head`
   * anchor (frameMeta, keyed df -> rect -> frame like handR) minus the body's reference `head` attach point. {0,0}
   * without a head anchor or reference, so art without neck metadata draws unchanged.
   */
  headOffsetOf(r: ResolvedFrame): { x: number; y: number } {
    const reg = this.registry; if (!reg || r.sprite < 0) return NO_HEAD_OFFSET;
    const anchors = r.dfi >= 0 && r.anim ? reg.dirFrameAnchors(r.sprite, r.anim, r.dfi, r.frame) : reg.frameAnchors(r.sprite, r.frame, r.anim || undefined);
    if (!anchors?.head) return NO_HEAD_OFFSET;
    const s = reg.sprite(r.sprite); const fa = s.frameAttach?.get(r.frame); const attach = fa ? { ...(s.attach ?? {}), ...fa } : s.attach;
    return AssetRegistry.headOffset(attach ? { anchors, attach } : { anchors });
  }
  /** Head-group sprite (ADR-128), cached per sprite id. */
  isHeadSprite(sprite: number): boolean {
    let v = this.headGroup.get(sprite); if (v === undefined) { v = !!this.registry?.isHeadGroup(sprite); this.headGroup.set(sprite, v); } return v;
  }
  private headGroup = new Map<number, boolean>();
  private resolveHands(): void {
    this.handByEntry.clear();
    for (const a of this.atlases) { const hs = this.handsByAtlas.get(a.key); if (!hs) continue; for (const [f, h] of Object.entries(hs)) { const n = Number(f); if (n >= 0 && n < a.count) this.handByEntry.set(a.base + n, h); } }
  }
  private variantById = new Map<number, number[]>();
  private roofById = new Set<number>();
  private enclosureById = new Set<number>();
  private resolveVariants(): string[] {
    const issues: string[] = []; this.variantById.clear(); const reg = this.registry; if (!reg) return issues;
    for (const [base, keys] of Object.entries(this.variantKeys)) {
      const b = reg.ids.sprites.tryId(base); if (b === undefined) { issues.push(`piece variants: unknown base ${base}`); continue; }
      const ids = keys.map((k) => { const id = reg.ids.sprites.tryId(k); if (id === undefined) issues.push(`piece variants: unknown ${k}`); return id ?? b; });
      this.variantById.set(b, ids);
    }
    return issues;
  }
  /**
   * Roof pieces: detected from the sprite (building.piece / key `roof*`, Art wave 2 roof_slope/ridge/... tiers), never from
   * the layer number. Roofs sit on the deck layer (gameplay LAYER_DECK = 0) of the level above the walls.
   */
  isRoof(spriteId: number): boolean { return this.roofById.has(spriteId); }
  private resolveRoofs(): void {
    this.roofById.clear(); if (!this.registry) return;
    for (const s of this.registry.allSprites()) if ((s.building?.piece ?? s.key).startsWith("roof")) this.roofById.add(s.id);
  }
  /** Walls, doors, and gates that enclose a room (ADR-304 indoor cutaway). */
  isEnclosure(spriteId: number): boolean { return this.enclosureById.has(spriteId); }
  private resolveEnclosures(): void {
    this.enclosureById.clear(); if (!this.registry) return;
    for (const s of this.registry.allSprites()) if (isEnclosurePieceKey(s.building?.piece ?? s.key)) this.enclosureById.add(s.id);
  }

  /**
   * Sprite to draw instead of a streamed `<piece>@tier<N>` sprite whose page is not resident yet (ADR-104 lookup order
   * reversed for streaming): bare key, another already-resident tier, then the family default. -1 = nothing drawable.
   * Non-streamed results are cached; a resident other tier is used only while it stays resident.
   */
  buildingFallback(spriteId: number, prio = Infinity): number {
    const reg = this.registry; if (!reg) return -1;
    const c = this.fallbackCache.get(spriteId); if (c !== undefined) return c;
    let piece: string | undefined; try { piece = reg.sprite(spriteId).building?.piece; } catch { piece = undefined; }
    if (!piece) return -1;
    let resident = -1;
    for (const k of streamingFallbackKeys(piece)) {
      const id = reg.spriteForPiece(k); if (id === undefined || id === spriteId) continue;
      if (!this.lazyOf(id)) { this.fallbackCache.set(spriteId, id); return id; }
      if (resident < 0 && this.lazyOf(id)!.lazy!.state === 2 && this.pageReady(id, prio)) resident = id;
    }
    if (resident >= 0) return resident;
    return -1;
  }
  private fallbackCache = new Map<number, number>();
  /**
   * ADR-211: arm sprite of an L corner piece (building.piece `wall_corner_outer[@tierN]`): the same tier's straight wall
   * (`wall[@tierN]`), drawn once per arm at the arm's edge pivot by both renderers. -1 = not an L corner.
   */
  lArmOf(spriteId: number): number {
    const c = this.lArmCache.get(spriteId); if (c !== undefined) return c;
    const reg = this.registry; let out = -1;
    if (reg) { let piece: string | undefined; try { piece = reg.sprite(spriteId).building?.piece; } catch { piece = undefined; }
      const k = lCornerArmPiece(piece); if (k) out = reg.spriteForPiece(k) ?? -1; }
    if (reg) this.lArmCache.set(spriteId, out); return out;
  }
  private lArmCache = new Map<number, number>();
  /** Crack overlay of a building sprite (manifest building.crackOverlay, e.g. bld_crack), or -1. */
  crackOverlayOf(spriteId: number): number { const r = this.registry; if (!r) return -1; try { return r.sprite(spriteId).building?.crackOverlay ?? -1; } catch { return -1; } }
  /** Sprite-level attach point (px from pivot, 1x, unmirrored) or undefined. */
  attachOf(spriteId: number, name: string): { x: number; y: number } | undefined { const r = this.registry; if (!r) return undefined; try { return r.sprite(spriteId).attach?.[name]; } catch { return undefined; } }

  /** Footprint/layer of a building sprite (null for non-building sprites). Rotation 1/3 swaps w/h. */
  pieceInfo(spriteId: number): { fw: number; fh: number; layer: number } | null { const b = this.sprites[spriteId]?.building; return b ? { fw: b.fw, fh: b.fh, layer: b.layer } : null; }

  /** Animation index of `name` on a sprite (-1 = unknown; resolve() then uses the first animation's frame list). */
  /** Exact index of the animation `name` (-1 when the sprite has none; animIndex falls back to 0). */
  namedAnim(spriteId: number, name: string): number { const s = this.sprites[spriteId]; return s ? s.anims.findIndex((a) => a.name === name) : -1; }
  /** ADR-218: the looping multi-frame `idle` animation of a fire sprite (bonfire, furnace, held torch...), else -1. */
  fireAnim(spriteId: number): number {
    const s = this.sprites[spriteId]; if (!s) return -1;
    const i = s.anims.findIndex((a) => a.name === "idle"); const a = s.anims[i];
    return a && a.loop && a.fps > 0 && a.frames.length > 1 ? i : -1;
  }
  animIndex(spriteId: number, name: string): number { const s = this.sprites[spriteId]; if (!s) return -1; const i = s.anims.findIndex((a) => a.name === name); return i < 0 ? 0 : i; }
  /** Animation index of `name`, or -1 when the sprite has no such anim (animIndex() falls back to 0). */
  findAnim(spriteId: number, name: string): number { const s = this.sprites[spriteId]; if (!s) return -1; for (let i = 0; i < s.anims.length; i++) if (s.anims[i]!.name === name) return i; return -1; }
  /**
   * Paper-doll frame alignment: the first anim of `state`'s fallback chain (STATE_ANIMS) the body has that every wear
   * layer can follow. A layer follows when it has that anim, or has none of the chain (face/eyes expression layers
   * keep their own anims). So when the body has swim/punch frames (possibly on a second page) but a worn item does
   * not, the whole character drops to the next shared anim (walk + swim clip-and-bob, attack) instead of the item
   * playing other frames than the body. Returns the body's anim index (stateAnim() when nothing is shared). Allocation-free.
   */
  sharedStateAnim(body: number, layers: readonly { sprite: number }[], state: number): number {
    return this.sharedChainAnim(body, layers, STATE_ANIMS[state] ?? STATE_ANIMS[CoreAnimState.Idle]!, state);
  }
  /** ADR-241: sharedStateAnim over an explicit chain (character/animChain.ts); `state` = stateAnim() fallback. */
  sharedChainAnim(body: number, layers: readonly { sprite: number }[], chain: readonly string[], state: number): number {
    for (const name of chain) {
      const bi = this.findAnim(body, name); if (bi < 0) continue;
      let ok = true;
      for (const l of layers) { if (l.sprite === body || this.findAnim(l.sprite, name) >= 0) continue;
        let any = false; for (const n2 of chain) if (this.findAnim(l.sprite, n2) >= 0) { any = true; break; }
        if (any) { ok = false; break; } }
      if (ok) return bi;
    }
    return this.stateAnim(body, state);
  }
  animName(spriteId: number, anim: number): string | undefined { return this.sprites[spriteId]?.anims[anim]?.name; }
  /** ADR-241: first anim of `chain` the sprite has, else stateAnim(state). */
  chainAnim(spriteId: number, chain: readonly string[] | undefined, state: number): number {
    if (chain) for (const n of chain) { const ai = this.findAnim(spriteId, n); if (ai >= 0) return ai; }
    return this.stateAnim(spriteId, state);
  }
  stateAnim(spriteId: number, state: number): number { const s = this.sprites[spriteId]; return s ? s.stateAnim[state] ?? s.stateAnim[CoreAnimState.Idle] ?? 0 : 0; }

  private fill(a: AtlasRT, f: number, s: SpriteRT, out: ResolvedFrame): void {
    const fi = Math.min(Math.max(0, f), a.count - 1);
    const r = a.source.rects?.[fi];
    out.entry = a.base + fi;
    if (r) { out.w = r.w; out.h = r.h; out.ax = r.ax; out.ay = r.ay; }
    else { out.w = a.fw; out.h = a.fh; out.ax = s.anchorX * a.fw; out.ay = s.anchorY * a.fh; }
    out.hasDamageFrames = false; out.flipX = false; out.sprite = -1; out.frame = -1; out.anim = ""; out.atlas = -1; out.dfi = -1;
  }

  /** For galleries/tools: every atlas with its frame count and loaded image. */
  listAtlases(): { key: string; id: number; count: number; image: ImageLike | null; emissive: ImageLike | null; rects?: RectTable; fw: number; fh: number; cols: number; scale: number; masks: Partial<Record<MaskName, string>> }[] {
    return this.atlases.map((a) => ({ key: a.key, id: a.id, count: a.count, image: a.img, emissive: a.emis, ...(a.source.rects ? { rects: a.source.rects } : {}), fw: a.fw, fh: a.fh, cols: a.cols, scale: a.scale, masks: { ...a.maskUrls } }));
  }

  dispose(): void {
    if (this.ctxCanvas) { this.ctxCanvas.removeEventListener("webglcontextlost", this.onCtxLost); this.ctxCanvas.removeEventListener("webglcontextrestored", this.onCtxRestored); this.ctxCanvas = undefined; }
    for (const [k, u] of this.held) this.assets.release(k, u);
    this.held = [];
    const gl = this.gl; if (this.tex) gl.deleteTexture(this.tex); if (this.emisTex) gl.deleteTexture(this.emisTex); if (this.frameTex) gl.deleteTexture(this.frameTex);
  }
}

/** Atlases whose sprites are only referenced as cosmetics wearable art (not bodies, not world sprites). */
/** Sprite ids referenced by cosmetic wearables (hair, hats, tops, ...). */
/** Frame rect of atlas-local frame `f`: an explicit dirFrames rect (extra entries), a TexturePacker rect, or undefined (grid). */
function rectOf(a: AtlasRT, f: number): { x: number; y: number; w: number; h: number } | undefined {
  const e = a.extra; return e && f >= e.n0 ? e.rects[f - e.n0] : a.source.rects?.[f];
}
/** Gives every distinct explicit dirFrames rect of each page its own frame-table entry (identical rects share one), so
 *  any anim (body, wear, swim/punch pages...) can list arbitrary per-frame (page, rect) pairs; grid frames keep their
 *  arithmetic indices. Idempotent across rebuilds (counts are recomputed from the grid/TexturePacker base). */
export function addDirFrameRects(registry: AssetRegistry, atlases: AtlasRT[]): void {
  const byId = new Map(atlases.map((a) => [a.id, a]));
  for (const a of atlases) if (a.extra) { a.count = a.extra.n0; delete a.extra; }
  for (const s of registry.allSprites()) for (const an of s.animList) for (const d of an.dirFrames ?? []) {
    if (!d.rect) continue; const a = byId.get(d.atlas.id); if (!a) continue;
    const e = (a.extra ??= { n0: a.count, rects: [], byKey: new Map(), byRect: new Map() }); if (e.byRect.has(d.rect)) continue;
    const k = `${d.rect.x},${d.rect.y},${d.rect.w},${d.rect.h}`;
    let i = e.byKey.get(k); if (i === undefined) { i = e.n0 + e.rects.length; e.byKey.set(k, i); e.rects.push(d.rect); }
    e.byRect.set(d.rect, i);
  }
  for (const a of atlases) if (a.extra) a.count = a.extra.n0 + a.extra.rects.length;
}
/** Atlas-local frame-table index of one dirFrames entry. */
export function dirFrameIndex(a: AtlasRT | undefined, d: { frame: number; rect?: DirFrameRect }): number {
  if (!a || !d.rect) return d.frame; const r = a.extra?.byRect.get(d.rect); if (r !== undefined) return r; return a.extra?.byKey.get(`${d.rect.x},${d.rect.y},${d.rect.w},${d.rect.h}`) ?? d.frame;
}
/**
 * ADR-380: sprite runtime tables (atlas index, per-anim dirFrames pages/frames, state anims, damage frames) for a
 * rebuild. Was O(S×A): `list.find` / `list.findIndex` / `list.indexOf` per sprite — 5,326 sprites × ~654 atlases,
 * plus one findIndex per dirFrames entry. Now two id->atlas/index Maps built once; the output is byte-identical:
 * the same atlas object and index per sprite, and -1 for a missing dirFrames page (`list[-1]` is undefined, so
 * dirFrameIndex falls back to d.frame exactly as before). Pure given (registry, list) — `list` must already include
 * the lazy atlases (rebuild pushes them in first) and have `addDirFrameRects` applied.
 */
export function buildSpriteTables(registry: AssetRegistry, list: AtlasRT[]): (SpriteRT | undefined)[] {
  const byId = new Map(list.map((a) => [a.id, a]));
  const idxById = new Map(list.map((a, i) => [a.id, i]));
  const sprites: (SpriteRT | undefined)[] = [];
  for (const s of registry.allSprites()) {
    const id = s.id;
    const at = byId.get(s.atlas.id); if (!at) continue;
    const stateAnim = new Int16Array(STATE_ANIMS.length);
    STATE_ANIMS.forEach((names, st) => {
      let idx = 0; for (const n of names) { const i = s.animList.findIndex((a) => a.name === n); if (i >= 0) { idx = i; break; } }
      stateAnim[st] = idx;
    });
    const damage: number[] = [];
    const dmgAnim = s.animations.get("damaged");
    for (let st = 1; st <= 3; st++) {
      const named = s.animations.get(`damage${st}`);
      if (named) damage[st] = named.frames[0]!;
      else if (dmgAnim) damage[st] = dmgAnim.frames[Math.min(st - 1, dmgAnim.frames.length - 1)]!;
    }
    const b = s.building;
    const dirAt = s.animList.map((an) => an.dirFrames ? Int32Array.from(an.dirFrames, (d) => idxById.get(d.atlas.id) ?? -1) : null);
    const dirF = s.animList.map((an, k) => an.dirFrames ? Int32Array.from(an.dirFrames, (d, j) => dirFrameIndex(list[dirAt[k]![j]!], d)) : null);
    sprites[id] = { atlasIdx: idxById.get(s.atlas.id)!, anchorX: s.anchor.x, anchorY: s.anchor.y, anims: s.animList, dirAt, dirF, stateAnim, damage,
      ...(b ? { building: { fw: b.footprint.w, fh: b.footprint.h, layer: b.layer, frames: b.frames } } : {}) };
  }
  return sprites;
}

/** Streaming flags `AtlasManager.rebuild` sorts atlases by (ADR-392 replays them at build time). */
export interface AtlasPoolFlags { streamWearables: boolean; streamVehicles: boolean; streamBuildingTiers: boolean; streamSheets: boolean; residentCreatures: boolean; ktx2: boolean }
/**
 * The lazy pool sets `AtlasManager.rebuild` uses: an atlas in none of lazy/legacy/veh/bld/body/stream is resident
 * (its PNG page loads at rebuild; its KTX2 twins are never read). Pure, so the build can replay it (ADR-392).
 */
export function atlasPoolSets(registry: AssetRegistry, sources: ReadonlyMap<string, AtlasSource>, f: AtlasPoolFlags): { lazyKeys: Set<string>; legacy: Set<string>; vehKeys: Set<string>; bldKeys: Set<string>; streamKeys: Set<string>; bodyKeys: Set<string>; bodyPages: Set<string> } {
  const lazyKeys = f.streamWearables ? wearableOnlyAtlases(registry) : new Set<string>();
  const legacy = f.streamVehicles ? legacyDirFrameAtlases(registry) : new Set<string>();
  const vehKeys = new Set<string>(); if (f.streamVehicles) for (const a of registry.atlases.values()) { const src = sources.get(a.key); if (src && !lazyKeys.has(a.key) && !legacy.has(a.key) && isStreamedVehicleAtlas(a.key, src.url)) vehKeys.add(a.key); }
  const bldKeys = new Set<string>(); if (f.streamBuildingTiers) for (const a of registry.atlases.values()) { const src = sources.get(a.key); if (src && !lazyKeys.has(a.key) && !vehKeys.has(a.key) && isStreamedBuildingAtlas(a.key, src.url)) bldKeys.add(a.key); }
  // bodies (page geometry from the manifest: columns x rows x frame size per page, any number of pages) go compressed when KTX2 is available: KTX2 colour + tint mask KTX2
  // (@2x: pages[].ktx2 + pages[].masksKtx2.tintmask) at the scale poolScales picks; paged in eagerly at rebuild, never evicted
  const bodyPages0 = bodyAtlasKeys(registry); // ADR-240: body sheets (v2 sample ships them "stream") stay in the character pools
  const streamKeys = new Set<string>(); if (f.streamSheets) for (const a of registry.atlases.values()) { const src = sources.get(a.key); if (src && a.residency === "stream" && !lazyKeys.has(a.key) && !bodyPages0.has(a.key) && !vehKeys.has(a.key) && !bldKeys.has(a.key) && !legacy.has(a.key) && !(f.residentCreatures && (RESIDENT_CREATURE_RE.test(a.key) || RESIDENT_GROUND_RE.test(a.key))) && !/^(blob|data):/.test(src.url)) streamKeys.add(a.key); }
  const bodyPages = bodyAtlasKeys(registry);
  const bodyKeys = new Set<string>(); if (f.ktx2 && f.streamWearables) for (const a of registry.atlases.values()) { const src = sources.get(a.key); if (src?.ktx2 && bodyPages.has(a.key) && !lazyKeys.has(a.key) && !vehKeys.has(a.key) && !bldKeys.has(a.key) && !streamKeys.has(a.key) && !/^(blob|data):/.test(src.url)) bodyKeys.add(a.key); }
  return { lazyKeys, legacy, vehKeys, bldKeys, streamKeys, bodyKeys, bodyPages };
}
/** ADR-392: atlases resident under every streaming configuration, so no device path ever reads their KTX2 twins
 *  (all flags on, low-budget residency: pets / critters / ground stay streamed, hence keep their KTX2). */
export function ktx2UnreadAtlases(registry: AssetRegistry, sources: ReadonlyMap<string, AtlasSource>): Set<string> {
  const p = atlasPoolSets(registry, sources, { streamWearables: true, streamVehicles: true, streamBuildingTiers: true, streamSheets: true, residentCreatures: false, ktx2: true });
  const out = new Set<string>();
  for (const a of registry.atlases.values()) if (sources.has(a.key) && ![p.lazyKeys, p.legacy, p.vehKeys, p.bldKeys, p.streamKeys, p.bodyKeys].some((x) => x.has(a.key))) out.add(a.key);
  return out;
}

/** Atlases only the legacy full-size layout of facing-split sprites (anims with dirFrames) uses: sprite.atlas of such
 *  sprites, unless a sprite without dirFrames or any dirFrames entry also uses it. Art may delete these pages. */
export function legacyDirFrameAtlases(registry: AssetRegistry): Set<string> {
  const old = new Set<string>(), used = new Set<string>();
  for (const s of registry.allSprites()) {
    // fully facing-split sprites only (vehicles): multi-page sprites (body/wear/animals with swim/punch on an extra
    // page via dirFrames on just those anims) still draw their other anims from sprite.atlas
    const split = s.animList.length > 0 && s.animList.every((a) => a.dirFrames);
    if (split) old.add(s.atlas.key); else used.add(s.atlas.key);
    for (const a of s.animList) for (const d of a.dirFrames ?? []) used.add(d.atlas.key);
  }
  for (const k of used) old.delete(k); return old;
}
export function wearableSpriteIds(registry: AssetRegistry): Set<number> {
  const cat = registry.cosmetics as unknown as { bySlot?: (s: string) => unknown[]; size?: number } | undefined;
  const wear = new Set<number>(); if (!cat?.bySlot || !cat.size) return wear;
  const walk = (v: unknown, depth: number): void => {
    if (!v || typeof v !== "object" || depth > 6) return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) { if (k === "sprite" && typeof x === "number") wear.add(x); else walk(x, depth + 1); }
  };
  for (const s of ["hair", "hat", "accessory", "top", "bottom", "shoes", "face", "eyes", "hands"]) for (const w of cat.bySlot(s)) walk(w, 0);
  for (const s of registry.allSprites()) if (isV2WearKey(s.key)) wear.add(s.id); // ADR-240: v2 wearables (not in the v1 catalog) use the wear pool
  return wear;
}

export function wearableOnlyAtlases(registry: AssetRegistry): Set<string> {
  const cat = registry.cosmetics as unknown as { bySlot?: (s: string) => unknown[]; bodySprite?: (b: string) => { sprite: number } | undefined; size?: number } | undefined;
  const out = new Set<string>(); if (!cat?.bySlot || !cat.size) return out;
  const wear = new Set<number>();
  const walk = (v: unknown, depth: number): void => {
    if (!v || typeof v !== "object" || depth > 6) return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) { if (k === "sprite" && typeof x === "number") wear.add(x); else walk(x, depth + 1); }
  };
  for (const s of ["hair", "hat", "accessory", "top", "bottom", "shoes", "face", "eyes", "hands"]) for (const w of cat.bySlot(s)) walk(w, 0);
  for (const s of registry.allSprites()) if (isV2WearKey(s.key)) wear.add(s.id); // ADR-240: v2 wearables (not in the v1 catalog) use the wear pool
  // every page a sprite draws from: sprite.atlas plus multi-page anims' dirFrames pages (swim/punch wear pages)
  const pagesOf = (s: { atlas: { key: string }; animList: { dirFrames?: { atlas: { key: string } }[] }[] }): string[] => { const k = new Set([s.atlas.key]); for (const a of s.animList) for (const d of a.dirFrames ?? []) k.add(d.atlas.key); return [...k]; };
  for (const s of registry.allSprites()) if (wear.has(s.id)) for (const k of pagesOf(s)) out.add(k);
  // an atlas shared with anything else (bodies, mirrors, world props) stays resident
  for (const s of registry.allSprites()) if (!wear.has(s.id)) for (const k of pagesOf(s)) out.delete(k);
  for (const k of out) if (isV2StreamSheet(k)) out.delete(k); // ADR-244 (b): per-group v2 sheets go to the stream pool
  // ADR-322 / crouch: every ride / crouch doll page (body + all live layers) is lazy: paged in only when that anim is drawn
  for (const s of registry.allSprites()) for (const k of pagesOf(s)) if (isLazyDollPageKey(k)) out.add(k);
  return out;
}

export interface ResolvedFrame { /** atlas table index the frame was read from (multi-page sprites: the dirFrames page; -1 outside resolve()) */ atlas: number; entry: number; w: number; h: number; ax: number; ay: number; hasDamageFrames: boolean; /** draw mirrored (mirror rotationArt) */ flipX: boolean;
  /** source sprite id / atlas frame index / anim name (resolve() only; -1 / "" otherwise): frameMeta anchor lookup */ sprite: number; frame: number; anim: string;
  /** dirFrames entry index (frame * directions + dir) when resolved from facing-split art, else -1: frameMeta "df:"/"rect:" lookup */ dfi: number }
export const newResolved = (): ResolvedFrame => ({ atlas: -1, entry: 0, w: 0, h: 0, ax: 0, ay: 0, hasDamageFrames: false, flipX: false, sprite: -1, frame: -1, anim: "", dfi: -1 });
