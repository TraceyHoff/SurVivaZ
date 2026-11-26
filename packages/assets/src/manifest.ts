import { loadCosmetics, type CosmeticCatalog, type CosmeticsJson, type WearableJson } from "./cosmetics.js";
import { fnv1a, StableIdRegistry, type World } from "@engine/core";

export const MANIFEST_VERSION = 1;
export const CATEGORIES = ["character", "zombie", "item", "equipment", "resource", "building", "tile", "ui", "vfx"] as const;
/** Optional categories: accepted by validation but not required to be present (e.g. by "covers every category" checks). */
/** decal: ground overlays (territory edges, puddles) with optional autotile neighbor rules (ADR-078). */
/** vehicle: segmented 8-dir vehicle sprites (packages/render/docs/VEHICLES_RENDER.md, ADR-101). */
export const OPTIONAL_CATEGORIES = ["critter", "glyph", "decal", "vehicle"] as const;
export const ALL_CATEGORIES = [...CATEGORIES, ...OPTIONAL_CATEGORIES] as const;
export type Category = (typeof ALL_CATEGORIES)[number];
export const ROTATION_ART = ["mirror", "unique4"] as const;
/** mirror: 1 row (symmetric), 2 rows (rotations 2/3 = rows 0/1 flipped on X) or 4 drawn rows; unique4: 4 rows required. */
export type RotationArt = (typeof ROTATION_ART)[number];
export interface SwayJson { /** px at frame top */ amp: number; /** Hz */ freq: number; /** 0..1, higher = stiffer */ stiffness: number; /** optional sway weight mask page (overrides the atlas sway mask) */ mask?: string }
export interface LoopPoints { /** seconds */ start: number; /** seconds (> start) */ end: number }
export const SOUND_CATEGORIES = ["sfx", "ambience", "ui"] as const;
export type SoundCategory = (typeof SOUND_CATEGORIES)[number];
export const BLEND_MODES = ["normal", "additive", "multiply"] as const;
export type BlendMode = (typeof BLEND_MODES)[number];
/** Iso facings: 1 (none), 4 (NE,SE,SW,NW) or 8 (E,SE,S,SW,W,NW,N,NE). */
export type Directions = 1 | 4 | 8;
/** Id namespaces, each with its own StableIdRegistry and lock section. */
export const ID_KINDS = ["sprites", "sounds", "vfx", "variants", "tints", "palettes"] as const;
export type IdKind = (typeof ID_KINDS)[number];
export type IdLock = Partial<Record<IdKind, Record<string, number>>>;

// ---------- JSON shapes ----------
export interface NineSlice { l: number; t: number; r: number; b: number }
export interface AtlasJson {
  key: string; image: string; frameW: number; frameH: number; columns: number; rows: number;
  /** An emissive page `<image base>_emissive.<ext>` with the same layout exists. */
  emissive?: boolean;
  /** UI atlases: nine-slice insets (pixels) per frame index. */
  nineSlice?: Record<string, NineSlice>;
  /** Extra resolution variants of `image` (same grid, pixel sizes × scale). `image` is the scale-1 page. */
  pages?: AtlasPageJson[];
  /** Same-layout mask pages (sampled by UV, so they work with every scale page). `emissive: true` = derived `<image>_emissive.<ext>`. */
  masks?: AtlasMasksJson;
  /** Optional GPU-compressed (KTX2/Basis, ETC1S) twin of `image`; PNG stays the fallback. */
  ktx2?: string;
  /** Optional KTX2 (UASTC) twins of string mask paths, keyed by mask kind. */
  masksKtx2?: Partial<Record<MaskKind, string>>;
  /** Streaming hint (optional, default "resident"): "stream" sheets page in near the camera and out when off-screen. */
  residency?: AtlasResidency;
  /** Sprite key drawn while a "stream" sheet loads (must live on a resident atlas); null = draw nothing. Sprites may override. */
  placeholder?: string | null;
}
export const ATLAS_RESIDENCY = ["resident", "stream"] as const;
export type AtlasResidency = (typeof ATLAS_RESIDENCY)[number];
export interface AtlasPageJson { scale: number; image: string; /** Optional KTX2 twin of this page image. */ ktx2?: string;
  /** Optional KTX2 (UASTC) twins of this page's `<mask>@<scale>x` mask variants, keyed by mask kind (scale-1 masks use atlas.masksKtx2). */
  masksKtx2?: Partial<Record<MaskKind, string>> }
export const MASK_KINDS = ["emissive", "sheen", "sway", "tintmask"] as const;
export type MaskKind = (typeof MASK_KINDS)[number];
export type AtlasMasksJson = { emissive?: string | true; sheen?: string; sway?: string; tintmask?: string };
export const TINT_MODES = ["multiply", "add", "screen", "lerp"] as const;
export type TintMode = (typeof TINT_MODES)[number];
/** Per-sprite status tint (wet, frost, exhausted, flush...): gameplay/render pick by name and scale strength at runtime. */
/** saturation (default 1) is applied before the color mode (0 = grayscale, >1 = boost). */
export interface SpriteTintJson { color: string; strength: number; mode?: TintMode; saturation?: number }
/** Input prompt glyph: id like "gamepad.xbox.a", "kbm.key.e", "touch.tap" -> sprite (+ optional frame index within its idle animation). */
export interface GlyphJson { sprite: string; frame?: number }
export const GLYPH_ID = /^(kbm|gamepad|touch)(\.[a-z0-9_]+)+$/;
export interface AnimationJson { /** Per-frame metadata keyed by atlas frame index; overrides the sprite's frameMeta for this anim. */ frameMeta?: Record<string, FrameMeta>; frames: number[]; fps: number; directions?: Directions; /** frame offset per direction row (default: atlas columns) */ dirStride?: number; loop?: boolean;
  /** Optional per-rotation frame rows for building anims: 1, 2 (rotations 2/3 = rows 0/1 mirrored) or 4 rows, each the same length as frames. Replaces the `<anim>_r1` naming hack (still honored as fallback). */
  rotations?: number[][];
  /** Optional facing-split art (non-breaking): [frameIdx * directions + dir] -> the frame on its own atlas with its own
   * anchor. Lets one facing group (E/W, N/S, diagonals) live on a tightly trimmed page. `frames`/sprite.atlas stay the
   * legacy uniform layout for consumers that ignore this; resolve with AssetRegistry.dirFrame(). */
  dirFrames?: DirFrameJson[] }
/** One explicit (page, frame) of an anim at one facing. `rect` (page px at 1x) addresses any region of the page directly
 *  (no grid / TexturePacker table needed) and wins over `frame`; identical rects (across frames, facings, anims or
 *  sprites, e.g. a held frame or a mirrored-pose reuse) share one frame-table entry. `anchor` is relative to the rect and
 *  may lie outside it (see DIRFRAME_ANCHOR_SLACK). */
export interface DirFrameJson { atlas: string; frame?: number; rect?: DirFrameRect; anchor: { x: number; y: number } }
/** dirFrames anchors may lie outside their trimmed rect (e.g. a feet pivot under a head-only face/eyes rect, or a held
 *  item's grip off the art): rect-relative, any finite value within this many rect sizes either side. */
export const DIRFRAME_ANCHOR_SLACK = 8;
const dfAnchorOk = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= -DIRFRAME_ANCHOR_SLACK && v <= 1 + DIRFRAME_ANCHOR_SLACK;
export interface DirFrameRect { x: number; y: number; w: number; h: number }
/** Building state -> vfx spawned at a named attach point (e.g. burning: fire/ember/smoke). */
export interface StateVfxJson { vfx: string; attach: string }
export const STRETCH_MODES = ["none", "velocity"] as const;
export type StretchMode = (typeof STRETCH_MODES)[number];
/** Decal autotile: first rule whose (neighbors & care) === (mask & care) wins; a rule with care 0 is the required fallback. Bits: N=1,E=2,S=4,W=8 (+ NE=16,SE=32,SW=64,NW=128 when neighbors = 8). Neighbors count when they share `group` (default: same sprite). */
export interface AutotileJson { neighbors: 4 | 8; group?: string; rules: { mask: number; care?: number; frame: number }[] }
/** Clan palette pair: tintmask R channel <- primary, G <- secondary. BuildPiece.tint (u8): 0 = none, 1..N = clanPalettes[tint-1] (clanPaletteForTint). */
export interface ClanPaletteJson { key: string; primary: string; secondary: string }
export interface BuildingSpriteJson {
  /** BuildPieceDef key (cross-checked with validateBuildingSprites). */
  piece: string; footprint: { w: number; h: number }; layer: number;
  /** frames[rotation][damageStage]: 1 or 4 rotations (0-3), exactly 4 damage stages (0 = intact .. 3 = wrecked). */
  frames: number[][];
  /** Optional piece states (e.g. closed/open), each with its own frames[rotation][damageStage]. State index = declaration order (BuildingGrid state u8). */
  states?: Record<string, number[][]>;
  /** Fallback crack overlay sprite (anims stage1..stage3, drawn over damage stages 1-3) for pieces without bespoke damage frames. */
  crackOverlay?: string;
  /** State name (a building state or a gameplay status like "burning") -> vfx at attach points of this sprite. */
  stateVfx?: Record<string, StateVfxJson[]>;
}
/** Named attach point (stall display slots, price tags, name labels, vfx sockets): px offsets from the pivot at 1x scale; x is mirrored when flipX. Optional w/h = slot box. */
export interface AttachPoint { x: number; y: number; z?: number; w?: number; h?: number }
export type AttachMap = Record<string, AttachPoint>;
/** Per-frame anchor (ADR-082): an AttachPoint plus optional held-item hints. angle = deg clockwise from up, len = px per unit item length, behind = draw held item behind the body. flipX mirrors x and angle. */
export interface AnchorPoint extends AttachPoint { angle?: number; len?: number; behind?: boolean }
export type AnchorMap = Record<string, AnchorPoint>;
/** Per-frame metadata (handR, handL, head, ...). Keys: an atlas frame index ("12", legacy), or for facing-split
 *  (dirFrames) art, stable keys that survive repacking: "df:<i>" (entry i of the anim's dirFrames; anim-level only) or
 *  "rect:<atlas>/<x>,<y>,<w>,<h>" (a dirFrames rect, shared by every entry drawing that rect). Lookup order for a
 *  dirFrames entry: df -> rect -> its frame index (anim-level beats sprite-level per anchor name). */
export interface FrameMeta { anchors?: AnchorMap }
export interface SpriteJson {
  /** Sprite-level attach points (see AttachPoint). */
  attach?: AttachMap;
  /** Per-frame attach overrides keyed by atlas frame index; frame keys override sprite keys. */
  frameAttach?: Record<string, AttachMap>;
  /** Per-frame metadata keyed by atlas frame index (anim-level frameMeta wins per anchor name). */
  frameMeta?: Record<string, FrameMeta>;
  key: string; category: Category; atlas: string;
  /** Draw group of a paper-doll layer. "head": the layer follows the body frame's `head` anchor (ADR-128 neck). Untagged
   *  face_*, eyes_*, hair_*, hat_* / headwear_* keys default to "head" (see headGroupOf). */
  group?: string;
  /** Pivot in [0,1] of the frame; feet for characters (default 0.5, 0.9). */
  anchor?: { x: number; y: number };
  animations: Record<string, AnimationJson>;
  building?: BuildingSpriteJson;
  rotationArt?: RotationArt;
  sway?: SwayJson;
  tints?: Record<string, SpriteTintJson>;
  /** Overrides the atlas placeholder while its "stream" sheet loads (sprite key on a resident atlas; null = nothing). */
  placeholder?: string | null;
  /** decal sprites only. */
  autotile?: AutotileJson;
}
export interface SoundJson { key: string; files: string[]; volume?: number; pitchJitter?: number; /** true, or loop points in seconds */ loop?: boolean | LoopPoints; category: SoundCategory }
export interface ParticleJson { rate: number; count: number; speed: [number, number]; spread: number; gravity: number; fade: boolean; scaleCurve: number[] }
export interface VfxJson { key: string; sprite: string; anim?: string; lifetime: number; blend?: BlendMode; particles?: ParticleJson;
  /** velocity: stretch the sprite along its velocity (trails, projectiles); stretchMax caps the length factor (default 4). */ stretch?: StretchMode; stretchMax?: number }
export interface TintSetJson { key: string; tints: string[] }
export interface PaletteJson { key: string; source: string[]; target: string[] }
export interface VariantJson { key: string; sprite?: string; tint?: string; tintIndex?: number; palette?: string }
export interface VariantSetJson { key: string; base: string; variants: VariantJson[] }
export interface ManifestJson extends CosmeticsJson {
  version: number; name?: string; atlases: AtlasJson[]; sprites: SpriteJson[];
  sounds?: SoundJson[]; vfx?: VfxJson[]; tintSets?: TintSetJson[]; palettes?: PaletteJson[]; variantSets?: VariantSetJson[];
  /** Input prompt glyphs keyed by glyph id (see GLYPH_ID). */
  glyphs?: Record<string, GlyphJson>;
  /** Clan two-tone palettes, index = array order (u8). */
  clanPalettes?: ClanPaletteJson[];
  /** @deprecated legacy survival_fx extension; mapped onto pages/masks/sway with a warning. */
  x_survival?: { hiDpiAtlases?: Record<string, string>; emissivePages?: string[]; sheenMasks?: string[]; swayMasks?: string[]; sway?: Record<string, SwayJson>; [k: string]: unknown };
}

// ---------- resolved ----------
export interface AtlasPage { scale: number; image: string; ktx2?: string; masksKtx2?: Partial<Record<MaskKind, string>> }
export type AtlasMasks = Partial<Record<MaskKind, string>>;
export interface Atlas extends Omit<AtlasJson, "emissive" | "nineSlice" | "pages" | "masks"> {
  id: number; /** = masks.emissive (kept for compatibility) */ emissiveImage?: string; nineSlice: Map<number, NineSlice>;
  /** All pages ascending by scale; pages[0] is scale 1 (= image). */ pages: AtlasPage[]; masks: AtlasMasks;
}
export interface SpriteTint { color: number; strength: number; mode: TintMode; saturation: number }
export interface GlyphDef { id: string; sprite: number; frame: number }
export interface Animation { id: number; name: string; frames: number[]; fps: number; directions: Directions; dirStride: number; loop: boolean; rotations?: number[][]; frameMeta?: Map<number, FrameMeta>; /** "df:i" / "rect:..." keyed frameMeta */ frameMetaKeyed?: Map<string, FrameMeta>; dirFrames?: { atlas: Atlas; frame: number; rect?: DirFrameRect; anchor: { x: number; y: number } }[] }
export interface BuildingSprite { piece: string; footprint: { w: number; h: number }; layer: number; frames: number[][]; rotationArt: RotationArt; stateNames: string[]; states: number[][][];
  /** crack overlay sprite id */ crackOverlay?: number; stateVfx: Record<string, { vfx: number; attach: string }[]> }
export interface SpriteDef { id: number; key: string; category: Category; atlas: Atlas; anchor: { x: number; y: number }; animations: Map<string, Animation>; animList: Animation[]; building?: BuildingSprite; sway?: SwayJson; tints: Record<string, SpriteTint>;
  autotile?: AutotileJson;
  /** Sprite-level attach points. */ attach?: AttachMap; /** Per-frame overrides by atlas frame index. */ frameAttach?: Map<number, AttachMap>;
  /** Per-frame metadata by atlas frame index. */ frameMeta?: Map<number, FrameMeta>; /** "rect:..." keyed frameMeta */ frameMetaKeyed?: Map<string, FrameMeta>;
  /** Sprite-level placeholder override (key; null = nothing) while a "stream" sheet loads. */ placeholder?: string | null;
  /** Draw group (SpriteJson.group, or the key default: "head" for face/eyes/hair/hat/headwear) */ group?: string }
export interface FrameRef { atlas: Atlas; frame: number; x: number; y: number; w: number; h: number; anchorX: number; anchorY: number; emissiveImage?: string; nineSlice?: NineSlice; /** draw mirrored on X (mirror rotationArt) */ flipX?: boolean;
  /** Effective attach points: sprite attach merged with this frame's override (frame wins). Unmirrored: negate x when flipX (see attachPoint). */ attach?: AttachMap;
  /** Per-frame anchors (sprite frameMeta merged with the anim's; set by frame()). Unmirrored: use AssetRegistry.anchorPoint. */ anchors?: AnchorMap;
  /** Scale pages of the atlas (x/y/w/h above are scale-1 pixels; multiply by page.scale). */ pages: AtlasPage[]; masks: AtlasMasks }
/** A frame resolved on a concrete page. */
export interface ScaledFrame { image: string; scale: number; x: number; y: number; w: number; h: number }
export interface SoundDef { id: number; key: string; files: string[]; volume: number; pitchJitter: number; loop: boolean; loopPoints?: LoopPoints; category: SoundCategory }
export interface VfxDef { id: number; key: string; sprite: number; anim: string; lifetime: number; blend: BlendMode; particles?: ParticleJson; stretch: StretchMode; stretchMax: number }
export interface ClanPalette { index: number; key: string; primary: number; secondary: number }
/** Colors are packed 0xRRGGBB. */
export interface TintSet { id: number; key: string; tints: number[] }
export interface Palette { id: number; key: string; map: Map<number, number>; source: number[]; target: number[] }
export interface Variant { id: number; key: string; set: string; sprite: number; tint?: number; palette?: number }

export class ManifestError extends Error { constructor(readonly issues: string[]) { super(`Asset manifest invalid:\n${issues.join("\n")}`); } }

const HEX = /^#[0-9a-fA-F]{6}$/;
export const parseColor = (s: string): number => parseInt(s.slice(1), 16);
export const emissivePath = (image: string): string => image.replace(/(\.[a-z]+)$/, "_emissive$1");

/** ADR-555: state for a boot registry whose wear shards are merged in lazily. `base` is the boot manifest's
 * cosmetics source (bodyTypes / palettes / requiredSlots / faceAnims); `wearables` accumulates every merged
 * shard's wearables so the catalog is rebuilt from the same input the full merge would have had. */
export interface WearMergeState { base: CosmeticsJson; wearables: WearableJson[]; loaded: string[] }

/** Registry of all asset kinds with stable numeric ids (u16) per kind. */
export class AssetRegistry {
  constructor(
    readonly atlases: Map<string, Atlas>, private sprites: Map<number, SpriteDef>, readonly ids: Record<IdKind, StableIdRegistry>,
    readonly sounds = new Map<number, SoundDef>(), readonly vfx = new Map<number, VfxDef>(), readonly tintSets = new Map<number, TintSet>(),
    readonly palettes = new Map<number, Palette>(), readonly variants = new Map<number, Variant>(),
  ) {}
  /** ADR-555: wear-merge state, set by loadManifest({ deferWear: true }); undefined for a full-merge registry. */
  wearMerge: WearMergeState | undefined;
  /** ADR-555: add one atlas built by buildAtlas (throws on a duplicate key); atlas ids are append order,
   * which may differ from the full merge's — atlas ids are internal only (sprite ids and registry.hash
   * are the stable, net-visible values and are unaffected). */
  addAtlas(atlas: Atlas): void { if (this.atlases.has(atlas.key)) throw new Error(`duplicate atlas "${atlas.key}"`); this.atlases.set(atlas.key, atlas); }
  /** ADR-555: add one sprite built by buildSpriteDef (throws on a duplicate key or id). */
  addSprite(sprite: SpriteDef): void {
    if ([...this.sprites.values()].some((s) => s.key === sprite.key)) throw new Error(`duplicate sprite "${sprite.key}"`);
    if (this.sprites.has(sprite.id)) throw new Error(`duplicate sprite id ${sprite.id} ("${sprite.key}")`);
    this.sprites.set(sprite.id, sprite);
  }
  /** Combined hash over every id namespace (for the handshake). */
  get hash(): number { let h = 0x811c9dc5; for (const k of ID_KINDS) h = fnv1a(`${k}:${this.ids[k].hash};`, h); if (this.cosmetics?.size) h = fnv1a(`cosmetics:${this.cosmetics.hash};`, h); return h; }
  /** Character customization catalog (manifest wearables/bodyTypes/skinTones/hairColors/clothingColors); undefined if none. */
  cosmetics: CosmeticCatalog | undefined;
  get size(): number { return this.sprites.size; }
  id(key: string): number { return this.ids.sprites.id(key); }
  sprite(id: number): SpriteDef { const s = this.sprites.get(id); if (!s) throw new Error(`unknown sprite ${id}`); return s; }
  byKey(key: string): SpriteDef { return this.sprite(this.ids.sprites.id(key)); }
  byCategory(c: Category): SpriteDef[] { return [...this.sprites.values()].filter((s) => s.category === c); }
  allSprites(): IterableIterator<SpriteDef> { return this.sprites.values(); }
  sound(key: string): SoundDef { return this.sounds.get(this.ids.sounds.id(key))!; }
  effect(key: string): VfxDef { return this.vfx.get(this.ids.vfx.id(key))!; }
  tintSet(key: string): TintSet { return this.tintSets.get(this.ids.tints.id(key))!; }
  palette(key: string): Palette { return this.palettes.get(this.ids.palettes.id(key))!; }
  variant(key: string): Variant { return this.variants.get(this.ids.variants.id(key))!; }
  variantsOf(set: string): Variant[] { return [...this.variants.values()].filter((v) => v.set === set); }
  /** Direction index for a facing angle (radians, 0 = +x tile axis) quantized to the animation's directions. */
  static directionIndex(facing: number, directions: Directions): number {
    if (directions === 1) return 0; const a = ((facing % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return Math.round(a / ((2 * Math.PI) / directions)) % directions;
  }
  private ref(s: SpriteDef, f: number): FrameRef {
    const at = s.atlas; const ns = at.nineSlice.get(f); const fa = s.frameAttach?.get(f);
    const attach = fa ? { ...(s.attach ?? {}), ...fa } : s.attach;
    return { atlas: at, frame: f, x: (f % at.columns) * at.frameW, y: Math.floor(f / at.columns) * at.frameH, w: at.frameW, h: at.frameH,
      anchorX: s.anchor.x * at.frameW, anchorY: s.anchor.y * at.frameH, ...(at.emissiveImage ? { emissiveImage: at.emissiveImage } : {}), ...(ns ? { nineSlice: ns } : {}), ...(attach ? { attach } : {}), pages: at.pages, masks: at.masks };
  }
  /** Resolve the atlas rect for sprite/animation/facing at time t (seconds). */
  frame(spriteId: number, anim: string, facing: number, timeSec: number): FrameRef {
    const s = this.sprite(spriteId); const a = s.animations.get(anim) ?? s.animList[0]!;
    const n = a.frames.length; let i = Math.floor(timeSec * a.fps); i = a.loop ? i % n : Math.min(i, n - 1);
    const f = a.frames[i]! + AssetRegistry.directionIndex(facing, a.directions) * a.dirStride; const ref = this.ref(s, f);
    const an = this.frameAnchors(spriteId, f, a.name); return an ? { ...ref, anchors: an } : ref;
  }
  /**
   * Like frame(), but honours the anim's facing-split `dirFrames` (own atlas + anchor per facing) when present; attach
   * points still come from the legacy frame (they are pivot-relative, so identical). Falls back to frame().
   */
  dirFrame(spriteId: number, anim: string, facing: number, timeSec: number): FrameRef {
    const s = this.sprite(spriteId); const a = s.animations.get(anim) ?? s.animList[0]!; const base = this.frame(spriteId, anim, facing, timeSec);
    if (!a.dirFrames) return base;
    const n = a.frames.length; let i = Math.floor(timeSec * a.fps); i = a.loop ? i % n : Math.min(i, n - 1);
    const di = i * a.directions + AssetRegistry.directionIndex(facing, a.directions); const d = a.dirFrames[di]; if (!d) return base;
    const at = d.atlas; const f = d.frame; const { emissiveImage: _e, anchors: _an, ...rest } = base; const an = this.dirFrameAnchors(spriteId, a.name, di, base.frame);
    const r = d.rect; const w = r ? r.w : at.frameW, h = r ? r.h : at.frameH;
    return { ...rest, atlas: at, frame: f, x: r ? r.x : (f % at.columns) * at.frameW, y: r ? r.y : Math.floor(f / at.columns) * at.frameH, w, h,
      anchorX: d.anchor.x * w, anchorY: d.anchor.y * h, pages: at.pages, masks: at.masks, ...(at.emissiveImage ? { emissiveImage: at.emissiveImage } : {}), ...(an ? { anchors: an } : {}) };
  }
  /** Per-frame metadata for an atlas frame: sprite frameMeta merged with the anim's (anim anchors win by name). */
  frameMeta(spriteId: number, frame: number, anim?: string): FrameMeta | undefined {
    const s = this.sprite(spriteId); const sm = s.frameMeta?.get(frame); const am = anim !== undefined ? s.animations.get(anim)?.frameMeta?.get(frame) : undefined;
    if (!sm && !am) return undefined; if (!am) return sm; if (!sm) return am;
    return { anchors: { ...(sm.anchors ?? {}), ...(am.anchors ?? {}) } };
  }
  /**
   * frameMeta of entry `dirIndex` of `anim`'s dirFrames (frame * directions + dir): per source (sprite, then anim, anim
   * wins per anchor name) the first of "df:<i>", "rect:<atlas>/x,y,w,h", then frame index `legacyFrame` (default: the
   * entry's page frame) so existing index-keyed metadata keeps working.
   */
  dirFrameMeta(spriteId: number, anim: string, dirIndex: number, legacyFrame?: number): FrameMeta | undefined {
    const s = this.sprite(spriteId); const a = s.animations.get(anim); const d = a?.dirFrames?.[dirIndex];
    if (!a || !d) return undefined;
    const rk = d.rect ? rectMetaKey(d.atlas.key, d.rect) : undefined;
    const pick = (keyed: Map<string, FrameMeta> | undefined, byFrame: Map<number, FrameMeta> | undefined, df: boolean): FrameMeta | undefined =>
      (df ? keyed?.get(`df:${dirIndex}`) : undefined) ?? (rk ? keyed?.get(rk) : undefined) ?? byFrame?.get(legacyFrame ?? d.frame);
    const sm = pick(s.frameMetaKeyed, s.frameMeta, false), am = pick(a.frameMetaKeyed, a.frameMeta, true);
    if (!sm && !am) return undefined; if (!am) return sm; if (!sm) return am;
    return { anchors: { ...(sm.anchors ?? {}), ...(am.anchors ?? {}) } };
  }
  dirFrameAnchors(spriteId: number, anim: string, dirIndex: number, legacyFrame?: number): AnchorMap | undefined { return this.dirFrameMeta(spriteId, anim, dirIndex, legacyFrame)?.anchors; }
  /** True when the sprite draws in the "head" group (ADR-128: follows the body's head anchor). */
  isHeadGroup(spriteId: number): boolean { try { return this.sprite(spriteId).group === "head"; } catch { return false; } }
  /**
   * ADR-128 neck: offset (unmirrored 1x px, +y down) to add to head-group layers drawn over body frame `body` =
   * frame anchor `head` - reference head point. The reference is the body's attach point `head` (sprite attach, or a
   * frameAttach override), i.e. where the current head art was drawn; without either point the offset is 0, so art
   * without head metadata draws exactly as before.
   */
  static headOffset(body: Pick<FrameRef, "anchors" | "attach">): { x: number; y: number } {
    const h = body.anchors?.[HEAD_ANCHOR], r = body.attach?.[HEAD_ANCHOR];
    return h && r ? { x: h.x - r.x, y: h.y - r.y } : { x: 0, y: 0 };
  }
  /** Anchors of a frame (see frameMeta), or undefined. */
  frameAnchors(spriteId: number, frame: number, anim?: string): AnchorMap | undefined { return this.frameMeta(spriteId, frame, anim)?.anchors; }
  /** Anchor `name` of a resolved frame (frame().anchors), x and angle mirrored when ref.flipX (same rule as attachPoint). */
  static anchorPoint(ref: FrameRef, name: string): AnchorPoint | undefined {
    const a = ref.anchors?.[name]; if (!a) return undefined;
    return ref.flipX ? { ...a, x: -a.x, ...(a.angle !== undefined ? { angle: -a.angle } : {}) } : a;
  }
  /** Building piece frame by rotation (0-3) and damage stage (0-3). Single-rotation sprites reuse rotation 0. */
  /** Frame for rotation (0-3), damage stage (0-3) and optional piece state index (out of range = default frames). */
  buildingFrame(spriteId: number, rotation: number, damageStage: number, state = -1): FrameRef {
    const s = this.sprite(spriteId); const b = s.building; if (!b) throw new Error(`${s.key} is not a building sprite`);
    const rows = (state >= 0 && b.states[state]) || b.frames; const r = rotation & 3;
    const ri = rows.length === 1 ? 0 : rows.length === 2 ? r & 1 : r;
    const ref = this.ref(s, rows[ri]![Math.max(0, Math.min(3, damageStage | 0))]!);
    return rows.length === 2 && r >= 2 ? { ...ref, flipX: true } : ref;
  }
  /** Attach point `name` of a resolved frame in pivot-relative 1x px, x mirrored when ref.flipX. */
  static attachPoint(ref: FrameRef, name: string): AttachPoint | undefined {
    const a = ref.attach?.[name]; if (!a) return undefined; return ref.flipX ? { ...a, x: -a.x } : a;
  }
  /**
   * Animation frame for a building rotation (0-3): uses anim.rotations rows when present (2 rows: rotations 2/3 mirror
   * rows 0/1 with flipX), else the legacy `<anim>_r1` anim for odd rotations, else the plain anim.
   */
  animFrame(spriteId: number, anim: string, rotation: number, timeSec: number): FrameRef {
    const s = this.sprite(spriteId); const r = rotation & 3; let a = s.animations.get(anim) ?? s.animList[0]!;
    const pick = (n: number, loop: boolean) => { let i = Math.floor(timeSec * a.fps); return loop ? i % n : Math.min(i, n - 1); };
    if (a.rotations) {
      const rows = a.rotations; const ri = rows.length === 1 ? 0 : rows.length === 2 ? r & 1 : r; const row = rows[ri]!;
      const ref = this.ref(s, row[pick(row.length, a.loop)]!); return rows.length === 2 && r >= 2 ? { ...ref, flipX: true } : ref;
    }
    let flip = false;
    if (r & 1) { const alt = s.animations.get(`${a.name}_r1`); if (alt) a = alt; }
    if (r >= 2 && s.building?.rotationArt === "mirror") flip = true;
    const ref = this.ref(s, a.frames[pick(a.frames.length, a.loop)]!); return flip ? { ...ref, flipX: true } : ref;
  }
  /** Decal frame for a neighbor bitmask (see AutotileJson); undefined if the sprite has no autotile rules. */
  decalFrame(spriteId: number, neighbors: number): FrameRef | undefined {
    const s = this.sprite(spriteId); const at = s.autotile; if (!at) return undefined;
    for (const rule of at.rules) { const care = rule.care ?? (at.neighbors === 8 ? 0xff : 0xf); if ((neighbors & care) === (rule.mask & care)) return this.ref(s, rule.frame); }
    return undefined;
  }
  /** Clan palettes by array index. BuildPiece.tint is 1-based: use clanPaletteForTint. */
  clanPalettes: ClanPalette[] = [];
  clanPalette(index: number): ClanPalette | undefined { return this.clanPalettes[index]; }
  /**
   * Clan palette for a BuildPiece.tint value (ADR-081): 0 = no clan tint, 1..N = clanPalettes[tint - 1]. Out-of-range or
   * non-integer values give undefined (no tint; never wrapped with modulo).
   */
  clanPaletteForTint(tint: number): ClanPalette | undefined {
    return Number.isInteger(tint) && tint >= 1 && tint <= this.clanPalettes.length ? this.clanPalettes[tint - 1] : undefined;
  }
  private pieceSprites?: Map<string, number>;
  /** Building sprite id for a BuildPieceDef key (sprite.building.piece; first declared wins), undefined if none. */
  spriteForPiece(pieceKey: string): number | undefined {
    if (!this.pieceSprites) { this.pieceSprites = new Map(); for (const s of this.sprites.values()) if (s.building && !this.pieceSprites.has(s.building.piece)) this.pieceSprites.set(s.building.piece, s.id); }
    return this.pieceSprites.get(pieceKey);
  }
  /** Input prompt glyphs by id (manifest `glyphs`). */
  glyphs = new Map<string, GlyphDef>();
  glyph(id: string): GlyphDef | undefined { return this.glyphs.get(id); }
  /** Frame for a glyph id (undefined if Art hasn't supplied it). */
  glyphFrame(id: string): FrameRef | undefined { const g = this.glyphs.get(id); return g ? this.ref(this.sprite(g.sprite), g.frame) : undefined; }
  /** Page for a device pixel ratio: smallest scale >= dpr, else the largest available. */
  static pickPage(atlas: Atlas, dpr = 1): AtlasPage {
    for (const p of atlas.pages) if (p.scale >= dpr - 1e-6) return p; return atlas.pages[atlas.pages.length - 1]!;
  }
  pickPage(atlas: Atlas, dpr = 1): AtlasPage { return AssetRegistry.pickPage(atlas, dpr); }
  /** Frame coordinates on the page chosen for `dpr`. */
  static scaled(ref: FrameRef, dpr = 1): ScaledFrame {
    const p = AssetRegistry.pickPage(ref.atlas, dpr); const k = p.scale;
    return { image: p.image, scale: k, x: ref.x * k, y: ref.y * k, w: ref.w * k, h: ref.h * k };
  }
  /** State index by name for a building sprite (-1 if none). */
  stateIndex(spriteId: number, name: string): number { return this.sprite(spriteId).building?.stateNames.indexOf(name) ?? -1; }
}

/** Minimal BuildPieceDef view (from @engine/world BuildPieceRegistry) for cross-checking. */
export interface PieceLookup { byKey(key: string): { footprint: { w: number; h: number }; layer: number } }
/** Cross-checks building sprites against BuildPieceDefs: piece exists, footprint and layer match. Returns issues. */
export function validateBuildingSprites(reg: AssetRegistry, pieces: PieceLookup): string[] {
  const issues: string[] = [];
  for (const s of reg.allSprites()) {
    if (!s.building) continue; let d;
    try { d = pieces.byKey(s.building.piece); } catch { issues.push(`${s.key}: unknown build piece "${s.building.piece}"`); continue; }
    if (d.footprint.w !== s.building.footprint.w || d.footprint.h !== s.building.footprint.h) issues.push(`${s.key}: footprint ${s.building.footprint.w}x${s.building.footprint.h} != piece ${d.footprint.w}x${d.footprint.h}`);
    if (d.layer !== s.building.layer) issues.push(`${s.key}: layer ${s.building.layer} != piece layer ${d.layer}`);
  }
  return issues;
}

/** Validate + build a registry. Throws ManifestError listing every issue. Returns the updated (namespaced) id lock. */
/** Maps the deprecated `x_survival` block onto typed fields (on a copy). Typed fields already present win. */
export function applyLegacySurvival(src: ManifestJson, warnings: string[]): ManifestJson {
  const m = structuredClone(src); const x = m.x_survival!; delete m.x_survival;
  warnings.push("x_survival is deprecated: use atlas pages/masks and sprite sway/tints (mapped automatically)");
  const stem = (path: string) => path.replace(/^.*\//, "").replace(/\.[a-z]+$/, "");
  const byKey = new Map(m.atlases.map((a) => [a.key, a]));
  for (const [k, img] of Object.entries(x.hiDpiAtlases ?? {})) {
    const a = byKey.get(k); if (!a) { warnings.push(`x_survival.hiDpiAtlases: unknown atlas "${k}"`); continue; }
    if (!(a.pages ?? []).some((pg) => pg.scale === 2)) a.pages = [...(a.pages ?? []), { scale: 2, image: img }];
  }
  const mapMasks = (list: string[] | undefined, kind: MaskKind, suffix: string) => {
    for (const path of list ?? []) {
      const base = stem(path).replace(new RegExp(`_${suffix}$`), "");
      const a = m.atlases.find((at) => (kind === "emissive" ? emissivePath(at.image) === path : stem(at.image) === base));
      if (!a) { warnings.push(`x_survival: no atlas for ${kind} mask ${path}`); continue; }
      a.masks = { ...(a.masks ?? {}) }; if (a.masks[kind] === undefined) a.masks[kind] = path;
    }
  };
  mapMasks(x.emissivePages, "emissive", "emissive"); mapMasks(x.sheenMasks, "sheen", "sheen"); mapMasks(x.swayMasks, "sway", "sway");
  for (const [k, sw] of Object.entries(x.sway ?? {})) {
    const s = m.sprites.find((sp) => sp.key === k); if (!s) { warnings.push(`x_survival.sway: unknown sprite "${k}"`); continue; }
    if (!s.sway) s.sway = { ...sw };
  }
  const known = new Set(["doc", "hiDpiAtlases", "emissivePages", "sheenMasks", "swayMasks", "sway"]);
  const rest = Object.keys(x).filter((k) => !known.has(k)); if (rest.length) warnings.push(`x_survival: not mapped (renderer-owned): ${rest.join(", ")}`);
  return m;
}

/** Key-based default draw group (ADR-128): face_*, eyes_*, hair_*, hat_*, headwear_* (any prefix, e.g. cz_hair_bob_female)
 *  and the head-worn accessories (glasses, sunglasses, eyepatch, earrings, flower) -> "head". Tag others explicitly. */
export const HEAD_GROUP_KEY = /(^|_)(face|eyes|hair|hat|headwear|glasses|sunglasses|eyepatch|earrings|flower)_/;
export const defaultGroupOf = (key: string): string | undefined => HEAD_GROUP_KEY.test(key) ? "head" : undefined;
/** Body frameMeta anchor naming the top of the neck (pivot-relative 1x px, like handR). */
export const HEAD_ANCHOR = "head";
/** A head anchor may lie this many px outside its frame rect (pivot-relative bounds). */
export const HEAD_RECT_SLACK_PX = 16;
const cloneAttach = (m: AttachMap): AttachMap => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { ...v }]));
/** Validates an attach map: names match [a-z0-9_.]+, x/y finite, z finite, w/h > 0. */
export function checkAttach(m: unknown, where: string, issues: string[], names: RegExp = /^[a-z0-9_.]+$/): void {
  if (m === undefined) return;
  if (!m || typeof m !== "object" || Array.isArray(m)) { issues.push(`${where} must be an object`); return; }
  const fin = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  for (const [n, a] of Object.entries(m as Record<string, AttachPoint>)) {
    if (!names.test(n)) issues.push(`${where}: bad attach name "${n}"`);
    if (!a || !fin(a.x) || !fin(a.y)) { issues.push(`${where}.${n}: x and y must be finite numbers`); continue; }
    if (a.z !== undefined && !fin(a.z)) issues.push(`${where}.${n}: z must be a finite number`);
    for (const k of ["w", "h"] as const) if (a[k] !== undefined && !(fin(a[k]) && a[k]! > 0)) issues.push(`${where}.${n}: ${k} must be > 0`);
  }
}

/** Validates frameMeta (anchor names [A-Za-z0-9_.]+): frame keys are atlas frame indices in range; anchors are attach maps + optional angle/len (finite) and behind (boolean). */
export const FRAME_META_DF = /^df:(\d+)$/, FRAME_META_RECT = /^rect:([^/]+)\/(\d+),(\d+),(\d+),(\d+)$/;
/** frameMeta key of a dirFrames rect */
export const rectMetaKey = (atlas: string, r: DirFrameRect): string => `rect:${atlas}/${r.x},${r.y},${r.w},${r.h}`;
export function checkFrameMeta(m: unknown, where: string, total: number | undefined, issues: string[], dirFrameCount?: number): void {
  if (m === undefined) return;
  if (!m || typeof m !== "object" || Array.isArray(m)) { issues.push(`${where} must be an object`); return; }
  for (const [fs, fm] of Object.entries(m as Record<string, FrameMeta>)) {
    const df = FRAME_META_DF.exec(fs);
    if (df) { if (dirFrameCount === undefined) issues.push(`${where}: "${fs}" needs an anim with dirFrames (anim-level frameMeta)`); else if (Number(df[1]) >= dirFrameCount) issues.push(`${where}: ${fs} out of dirFrames range`); }
    else if (!FRAME_META_RECT.test(fs)) { const f = Number(fs); if (!(fs !== "" && Number.isInteger(f) && f >= 0 && (total === undefined || f < total))) issues.push(`${where}: frame ${fs} out of atlas range`); }
    if (!fm || typeof fm !== "object") { issues.push(`${where}.${fs} must be an object`); continue; }
    for (const k of Object.keys(fm)) if (k !== "anchors") issues.push(`${where}.${fs}: unknown key "${k}"`);
    checkAttach(fm.anchors, `${where}.${fs}.anchors`, issues, /^[A-Za-z0-9_.]+$/); // camelCase allowed (handR, handL)
    for (const [n, a] of Object.entries(fm.anchors ?? {})) {
      for (const k of ["angle", "len"] as const) if (a?.[k] !== undefined && !(typeof a[k] === "number" && Number.isFinite(a[k]))) issues.push(`${where}.${fs}.anchors.${n}: ${k} must be a finite number`);
      if (a?.behind !== undefined && typeof a.behind !== "boolean") issues.push(`${where}.${fs}.anchors.${n}: behind must be a boolean`);
    }
  }
}
const cloneFm = (fm: FrameMeta): FrameMeta => fm.anchors ? { anchors: Object.fromEntries(Object.entries(fm.anchors).map(([k, v]) => [k, { ...v }])) } : {};
const isKeyed = (k: string): boolean => FRAME_META_DF.test(k) || FRAME_META_RECT.test(k);
const cloneMeta = (m: Record<string, FrameMeta>): Map<number, FrameMeta> =>
  new Map(Object.entries(m).filter(([f]) => !isKeyed(f)).map(([f, fm]) => [Number(f), cloneFm(fm)]));
/** spread: { frameMetaKeyed } when the JSON has df:/rect: keys */
const keyedMeta = (m: Record<string, FrameMeta> | undefined): { frameMetaKeyed?: Map<string, FrameMeta> } => {
  const e = Object.entries(m ?? {}).filter(([f]) => isKeyed(f)); return e.length ? { frameMetaKeyed: new Map(e.map(([f, fm]) => [f, cloneFm(fm)])) } : {};
};

/** Build one resolved Atlas from its JSON (shared by loadManifest and ADR-555 mergeWearShard, so a
 * lazily merged wear atlas is byte-identical to one built by the full merge). `where` labels issues. */
export function buildAtlas(a: AtlasJson, id: number, where: string, issues: string[]): Atlas {
  const p = where;
    if (!a.image || !/\.(png|webp)$/.test(a.image)) issues.push(`${p}: image must be .png/.webp`);
    for (const f of ["frameW", "frameH", "columns", "rows"] as const) if (!(Number.isInteger(a[f]) && a[f] > 0)) issues.push(`${p}: ${f} must be a positive integer`);
    const nine = new Map<number, NineSlice>();
    for (const [fs, n] of Object.entries(a.nineSlice ?? {})) {
      const f = Number(fs);
      if (!(Number.isInteger(f) && f >= 0 && f < a.columns * a.rows)) issues.push(`${p}: nineSlice frame ${fs} out of range`);
      if (![n.l, n.t, n.r, n.b].every((v) => Number.isInteger(v) && v >= 0) || n.l + n.r >= a.frameW || n.t + n.b >= a.frameH) issues.push(`${p}: nineSlice ${fs} insets invalid`);
      nine.set(f, n);
    }
    if (a.residency !== undefined && !(ATLAS_RESIDENCY as readonly string[]).includes(a.residency)) issues.push(`${p}: residency must be "resident" | "stream"`);
    if (a.placeholder !== undefined && a.placeholder !== null && typeof a.placeholder !== "string") issues.push(`${p}: placeholder must be a sprite key or null`);
    const IMG = /\.(png|webp)$/;
    if (a.ktx2 !== undefined && !(typeof a.ktx2 === "string" && /\.ktx2$/.test(a.ktx2))) issues.push(`${p}: ktx2 must be a .ktx2 path`);
    if (a.masksKtx2 !== undefined) for (const [k, v] of Object.entries(a.masksKtx2 ?? {})) if (!(MASK_KINDS as readonly string[]).includes(k) || typeof v !== "string" || !/\.ktx2$/.test(v)) issues.push(`${p}: masksKtx2.${k} must be a known mask kind with a .ktx2 path`);
    const pages: AtlasPage[] = [{ scale: 1, image: a.image, ...(a.ktx2 ? { ktx2: a.ktx2 } : {}) }];
    if (a.pages !== undefined) {
      if (!Array.isArray(a.pages)) issues.push(`${p}: pages must be an array`);
      else for (const pg of a.pages) {
        if (!(typeof pg?.scale === "number" && pg.scale > 0 && pg.scale <= 8)) { issues.push(`${p}: page scale must be in (0, 8]`); continue; }
        if (!pg.image || !IMG.test(pg.image)) issues.push(`${p}: page image must be .png/.webp`);
        if (pg.ktx2 !== undefined && !(typeof pg.ktx2 === "string" && /\.ktx2$/.test(pg.ktx2))) issues.push(`${p}: page ktx2 must be a .ktx2 path`);
        if (pages.some((x) => x.scale === pg.scale)) issues.push(`${p}: duplicate page scale ${pg.scale}`); else {
          if (pg.masksKtx2 !== undefined) for (const [k, v] of Object.entries(pg.masksKtx2 ?? {})) if (!(MASK_KINDS as readonly string[]).includes(k) || typeof v !== "string" || !/\.ktx2$/.test(v)) issues.push(`${p}: pages[scale ${pg.scale}].masksKtx2.${k} must be a known mask kind with a .ktx2 path`);
          pages.push({ scale: pg.scale, image: pg.image, ...(pg.ktx2 ? { ktx2: pg.ktx2 } : {}), ...(pg.masksKtx2 ? { masksKtx2: { ...pg.masksKtx2 } } : {}) });
        }
      }
      pages.sort((x, y) => x.scale - y.scale);
    }
    const masks: AtlasMasks = {};
    if (a.emissive) masks.emissive = emissivePath(a.image);
    if (a.masks !== undefined) {
      if (!a.masks || typeof a.masks !== "object") issues.push(`${p}: masks must be an object`);
      else for (const [k, v] of Object.entries(a.masks)) {
        if (!(MASK_KINDS as readonly string[]).includes(k)) { issues.push(`${p}: unknown mask "${k}" (emissive|sheen|sway|tintmask)`); continue; }
        if (k === "emissive" && v === true) { masks.emissive = emissivePath(a.image); continue; }
        if (typeof v !== "string" || !IMG.test(v)) { issues.push(`${p}: mask ${k} must be a .png/.webp path`); continue; }
        masks[k as MaskKind] = v;
      }
    }
    const { emissive: _e, nineSlice: _n, pages: _p, masks: _m, ...rest } = a;
  return { ...rest, id, nineSlice: nine, pages, masks, ...(masks.emissive ? { emissiveImage: masks.emissive } : {}) };
}

/** Build one resolved SpriteDef from its JSON (shared by loadManifest and ADR-555 mergeWearShard).
 * Callers must have assigned `s.key` (and any crackOverlay / stateVfx sprite keys) in `ids` first;
 * dirFrames atlas keys must already exist in `atlases` (wear shards only reference their own atlases
 * plus the base shard's pose atlases, which the boot manifest already carries). */
export function buildSpriteDef(s: SpriteJson, atlases: Map<string, Atlas>, ids: Record<IdKind, StableIdRegistry>): SpriteDef {
    const at = atlases.get(s.atlas)!; const animList: Animation[] = [];
    Object.entries(s.animations).forEach(([name, a], i) => animList.push({ id: i, name, frames: a.frames, fps: a.fps, directions: a.directions ?? 1, dirStride: a.dirStride ?? at.columns, loop: a.loop ?? true, ...(a.rotations ? { rotations: a.rotations.map((r) => [...r]) } : {}), ...(a.frameMeta ? { frameMeta: cloneMeta(a.frameMeta), ...keyedMeta(a.frameMeta) } : {}), ...(a.dirFrames ? { dirFrames: a.dirFrames.map((d) => ({ atlas: atlases.get(d.atlas)!, frame: d.frame ?? 0, ...(d.rect ? { rect: { x: d.rect.x, y: d.rect.y, w: d.rect.w, h: d.rect.h } } : {}), anchor: { ...d.anchor } })) } : {}) }));
    const id = ids.sprites.id(s.key);
  return { id, key: s.key, category: s.category, atlas: at, anchor: s.anchor ?? { x: 0.5, y: 0.9 }, animations: new Map(animList.map((a) => [a.name, a])), animList,
      ...(s.building ? { building: { piece: s.building.piece, footprint: { ...s.building.footprint }, layer: s.building.layer, frames: s.building.frames.map((r) => [...r]),
        rotationArt: s.rotationArt ?? "mirror", stateNames: Object.keys(s.building.states ?? {}), states: Object.values(s.building.states ?? {}).map((rows) => rows.map((r) => [...r])),
        ...(s.building.crackOverlay ? { crackOverlay: ids.sprites.id(s.building.crackOverlay) } : {}),
        stateVfx: Object.fromEntries(Object.entries(s.building.stateVfx ?? {}).map(([st, l]) => [st, l.map((e) => ({ vfx: ids.vfx.id(e.vfx), attach: e.attach }))])) } } : {}),
      ...(s.autotile ? { autotile: { neighbors: s.autotile.neighbors, ...(s.autotile.group ? { group: s.autotile.group } : {}), rules: s.autotile.rules.map((r) => ({ ...r })) } } : {}),
      ...(s.sway ? { sway: { ...s.sway } } : {}),
      ...(s.placeholder !== undefined ? { placeholder: s.placeholder } : {}),
      ...((s.group ?? defaultGroupOf(s.key)) ? { group: s.group ?? defaultGroupOf(s.key)! } : {}),
      ...(s.attach ? { attach: cloneAttach(s.attach) } : {}),
      ...(s.frameMeta ? { frameMeta: cloneMeta(s.frameMeta), ...keyedMeta(s.frameMeta) } : {}),
      ...(s.frameAttach ? { frameAttach: new Map(Object.entries(s.frameAttach).map(([f, am]) => [Number(f), cloneAttach(am)])) } : {}),
      tints: Object.fromEntries(Object.entries(s.tints ?? {}).map(([n, t]) => [n, { color: parseColor(t.color), strength: t.strength, mode: t.mode ?? "multiply", saturation: t.saturation ?? 1 }])) };
}

export function loadManifest(json: unknown, opts: { lock?: IdLock | Record<string, number>; /** ADR-555: boot manifest without the wear shards — build a catalog that tolerates missing wearables and remember the cosmetics source so mergeWearShard can rebuild it. */ deferWear?: boolean } = {}): { registry: AssetRegistry; lock: Required<IdLock> & { wearables?: Record<string, number> }; warnings: string[] } {
  const issues: string[] = []; let m = json as ManifestJson;
  if (!m || typeof m !== "object") throw new ManifestError(["manifest is not an object"]);
  if (m.version !== MANIFEST_VERSION) issues.push(`version must be ${MANIFEST_VERSION}`);
  if (!Array.isArray(m.atlases)) issues.push("atlases must be an array");
  if (!Array.isArray(m.sprites)) issues.push("sprites must be an array");
  for (const k of ["sounds", "vfx", "tintSets", "palettes", "variantSets"] as const) if (m[k] !== undefined && !Array.isArray(m[k])) issues.push(`${k} must be an array`);
  if (issues.length) throw new ManifestError(issues);
  const warnings: string[] = [];
  if (m.x_survival !== undefined) m = applyLegacySurvival(m, warnings);
  const KEY = /^[a-z0-9_]+$/;
  const uniq = (list: { key: string }[], what: string) => { const seen = new Set<string>(); list.forEach((x, i) => {
    if (!KEY.test(x.key ?? "")) issues.push(`${what}[${i}](${x.key}): bad key`);
    if (seen.has(x.key)) issues.push(`${what}[${i}](${x.key}): duplicate key`); seen.add(x.key); }); return seen; };

  // atlases
  const atlases = new Map<string, Atlas>(); uniq(m.atlases, "atlases");
  m.atlases.forEach((a, i) => { atlases.set(a.key, buildAtlas(a, atlases.size + 1, `atlases[${i}](${a.key})`, issues)); });

  // sprites
  const spriteKeys = uniq(m.sprites, "sprites");
  m.sprites.forEach((s, i) => {
    const p = `sprites[${i}](${s.key})`;
    if (!(ALL_CATEGORIES as readonly string[]).includes(s.category)) issues.push(`${p}: unknown category "${s.category}"`);
    if (s.rotationArt !== undefined && !ROTATION_ART.includes(s.rotationArt)) issues.push(`${p}: rotationArt must be mirror|unique4`);
    if (s.rotationArt !== undefined && !s.building) issues.push(`${p}: rotationArt only applies to building sprites`);
    if (s.sway?.mask !== undefined && !(typeof s.sway.mask === "string" && /\.(png|webp)$/.test(s.sway.mask))) issues.push(`${p}: sway.mask must be a .png/.webp path`);
    if (s.tints !== undefined) {
      if (!s.tints || typeof s.tints !== "object") issues.push(`${p}: tints must be an object`);
      else for (const [n, t] of Object.entries(s.tints)) {
        if (!KEY.test(n)) issues.push(`${p}: bad tint name "${n}"`);
        if (!/^#[0-9a-fA-F]{6}$/.test(t?.color ?? "")) issues.push(`${p}: tint ${n} color must be #rrggbb`);
        if (!(typeof t?.strength === "number" && t.strength >= 0 && t.strength <= 1)) issues.push(`${p}: tint ${n} strength must be within [0,1]`);
        if (t?.mode !== undefined && !TINT_MODES.includes(t.mode)) issues.push(`${p}: tint ${n} mode must be multiply|add|screen|lerp`);
        if (t?.saturation !== undefined && !(typeof t.saturation === "number" && t.saturation >= 0 && t.saturation <= 4)) issues.push(`${p}: tint ${n} saturation must be within [0,4]`);
      }
    }
    if (s.sway !== undefined && !(s.sway && s.sway.amp >= 0 && s.sway.freq >= 0 && s.sway.stiffness >= 0 && s.sway.stiffness <= 1)) issues.push(`${p}: sway needs amp >= 0, freq >= 0, stiffness in [0,1]`);
    const at = atlases.get(s.atlas); if (!at) issues.push(`${p}: unknown atlas "${s.atlas}"`);
    checkAttach(s.attach, `${p}.attach`, issues);
    if (s.group !== undefined && !(typeof s.group === "string" && KEY.test(s.group))) issues.push(`${p}: group must be a lowercase key`);
    // fully facing-split sprites: `atlas` is just their first facing page; frames/frameAttach keep legacy indices (attach keys)
    const allDf = Object.values(s.animations ?? {}).length > 0 && Object.values(s.animations ?? {}).every((a) => Array.isArray(a?.dirFrames));
    if (s.frameAttach !== undefined) {
      if (!s.frameAttach || typeof s.frameAttach !== "object") issues.push(`${p}: frameAttach must be an object`);
      else for (const [fs, am] of Object.entries(s.frameAttach)) {
        const f = Number(fs); if (!(Number.isInteger(f) && f >= 0 && (!at || allDf || f < at.columns * at.rows))) issues.push(`${p}: frameAttach frame ${fs} out of atlas range`);
        checkAttach(am, `${p}.frameAttach.${fs}`, issues);
      }
    }
    checkFrameMeta(s.frameMeta, `${p}.frameMeta`, at ? at.columns * at.rows : undefined, issues);
    for (const [an, aj] of Object.entries(s.animations ?? {})) checkFrameMeta(aj?.frameMeta, `${p}.${an}.frameMeta`, at ? at.columns * at.rows : undefined, issues, Array.isArray(aj?.dirFrames) ? aj!.dirFrames!.length : undefined);
    // head anchors (ADR-128) must lie near their frame: pivot-relative bounds of the frame rect +- HEAD_RECT_SLACK_PX
    if (at) { const sa = s.anchor ?? { x: 0.5, y: 0.9 };
      const near = (hp: AnchorPoint | undefined, w: number, h: number, ax: number, ay: number, where: string): void => {
        if (!hp || typeof hp.x !== "number" || typeof hp.y !== "number") return; const S = HEAD_RECT_SLACK_PX;
        if (!(hp.x >= -ax * w - S && hp.x <= (1 - ax) * w + S && hp.y >= -ay * h - S && hp.y <= (1 - ay) * h + S)) issues.push(`${where}.anchors.head: must lie within ${S}px of the frame rect`);
      };
      for (const [fs, fm] of Object.entries(s.frameMeta ?? {})) if (!FRAME_META_DF.test(fs)) { const r = FRAME_META_RECT.exec(fs); near(fm?.anchors?.head, r ? +r[4]! : at.frameW, r ? +r[5]! : at.frameH, sa.x, sa.y, `${p}.frameMeta.${fs}`); }
      for (const [an, aj] of Object.entries(s.animations ?? {})) for (const [fs, fm] of Object.entries(aj?.frameMeta ?? {})) {
        const df = FRAME_META_DF.exec(fs), r = FRAME_META_RECT.exec(fs); const d = df ? aj!.dirFrames?.[+df[1]!] : undefined;
        const dat = d ? atlases.get(d.atlas) : undefined; const w = d ? (d.rect?.w ?? dat?.frameW ?? at.frameW) : r ? +r[4]! : at.frameW, h = d ? (d.rect?.h ?? dat?.frameH ?? at.frameH) : r ? +r[5]! : at.frameH;
        near(fm?.anchors?.head, w, h, d?.anchor?.x ?? sa.x, d?.anchor?.y ?? sa.y, `${p}.${an}.frameMeta.${fs}`);
      } }

    const total = at ? at.columns * at.rows : 0;
    if (s.anchor && !(s.anchor.x >= 0 && s.anchor.x <= 1 && s.anchor.y >= 0 && s.anchor.y <= 1)) issues.push(`${p}: anchor must be within [0,1]`);
    const anims = Object.entries(s.animations ?? {}); if (!anims.length) issues.push(`${p}: needs at least one animation`);
    for (const [name, a] of anims) {
      const q = `${p}.${name}`; const dirs = a.directions ?? 1;
      if (![1, 4, 8].includes(dirs)) issues.push(`${q}: directions must be 1, 4 or 8`);
      if (!(a.fps > 0)) issues.push(`${q}: fps must be > 0`);
      if (!Array.isArray(a.frames) || !a.frames.length) issues.push(`${q}: frames required`);
      if (a.dirFrames !== undefined) {
        if (!Array.isArray(a.dirFrames) || !Array.isArray(a.frames) || a.dirFrames.length !== a.frames.length * dirs) issues.push(`${q}: dirFrames must have frames.length x directions entries`);
        else a.dirFrames.forEach((d, i) => { const da = atlases.get(d?.atlas);
          if (!da) issues.push(`${q}.dirFrames[${i}]: unknown atlas ${d?.atlas}`);
          else if (d.rect !== undefined) { const r = d.rect; const pw = da.columns * da.frameW, ph = da.rows * da.frameH;
            if (!r || ![r.x, r.y, r.w, r.h].every((v) => Number.isInteger(v)) || r.x < 0 || r.y < 0 || r.w <= 0 || r.h <= 0 || r.x + r.w > pw || r.y + r.h > ph) issues.push(`${q}.dirFrames[${i}]: rect must be integer px inside the ${pw}x${ph} page`); }
          else if (!(Number.isInteger(d.frame) && d.frame! >= 0 && d.frame! < da.columns * da.rows)) issues.push(`${q}.dirFrames[${i}]: frame ${d.frame} out of range`);
          if (!d?.anchor || !(dfAnchorOk(d.anchor.x) && dfAnchorOk(d.anchor.y))) issues.push(`${q}.dirFrames[${i}]: anchor must be finite and within [${-DIRFRAME_ANCHOR_SLACK},${1 + DIRFRAME_ANCHOR_SLACK}] of the rect`); });
      }
      else if (at) {
        const stride = a.dirStride ?? at.columns;
        for (const f of a.frames) if (!(Number.isInteger(f) && f >= 0 && f + (dirs - 1) * stride < total)) issues.push(`${q}: frame ${f} out of atlas range`);
      }
      if (a.rotations !== undefined) {
        if (!s.building) issues.push(`${q}: rotations only apply to building sprites`);
        if (!Array.isArray(a.rotations) || ![1, 2, 4].includes(a.rotations.length)) issues.push(`${q}: rotations must have 1, 2 or 4 rows`);
        else { if (s.rotationArt === "unique4" && a.rotations.length !== 4) issues.push(`${q}: rotations needs 4 rows for rotationArt unique4`);
          a.rotations.forEach((row, r) => {
            if (!Array.isArray(row) || row.length !== (a.frames?.length ?? 0)) issues.push(`${q}: rotation row ${r} must have ${a.frames?.length ?? 0} frames`);
            else if (at) for (const f of row) if (!(Number.isInteger(f) && f >= 0 && f < total)) issues.push(`${q}: rotation ${r} frame ${f} out of atlas range`);
          }); }
      }
    }
    if (s.building) {
      const b = s.building; const q = `${p}.building`;
      if (s.category !== "building") issues.push(`${q}: only building sprites may have building data`);
      if (!b.piece) issues.push(`${q}: piece required`);
      if (!(Number.isInteger(b.footprint?.w) && b.footprint.w >= 1 && Number.isInteger(b.footprint?.h) && b.footprint.h >= 1)) issues.push(`${q}: bad footprint`);
      if (!(Number.isInteger(b.layer) && b.layer >= 0 && b.layer <= 3)) issues.push(`${q}: layer must be 0-3`);
      const art = s.rotationArt ?? "mirror";
      const checkRows = (rows: unknown, label: string) => {
        if (!Array.isArray(rows)) { issues.push(`${q}: ${label} must be an array of rotations`); return; }
        const okN = art === "unique4" ? [4] : [1, 2, 4];
        if (!okN.includes(rows.length)) { issues.push(art === "unique4" ? `${q}: ${label} needs 4 rotations for rotationArt unique4` : `${q}: ${label} must have 1, 2 or 4 rotations`); return; }
        (rows as number[][]).forEach((row, r) => {
          if (!Array.isArray(row) || row.length !== 4) issues.push(`${q}: rotation ${r} needs 4 damage stages`);
          else if (at) for (const f of row) if (!(Number.isInteger(f) && f >= 0 && f < total)) issues.push(`${q}: frame ${f} out of atlas range`);
        });
      };
      checkRows(b.frames, "frames");
      if (b.states !== undefined) {
        const names = b.states && typeof b.states === "object" ? Object.keys(b.states) : [];
        if (!names.length) issues.push(`${q}: states must be a non-empty object`); if (names.length > 255) issues.push(`${q}: at most 255 states`);
        for (const n of names) { if (!/^[a-z0-9_]+$/.test(n)) issues.push(`${q}: bad state name "${n}"`); checkRows(b.states[n], `states.${n}`); }
      }
      if (b.crackOverlay !== undefined) {
        const cs = m.sprites.find((x) => x.key === b.crackOverlay);
        if (!cs) issues.push(`${q}: unknown crackOverlay sprite "${b.crackOverlay}"`);
        else for (const st of ["stage1", "stage2", "stage3"]) if (!(st in (cs.animations ?? {}))) issues.push(`${q}: crackOverlay ${b.crackOverlay} lacks animation "${st}"`);
      }
      if (b.stateVfx !== undefined) {
        if (!b.stateVfx || typeof b.stateVfx !== "object") issues.push(`${q}: stateVfx must be an object`);
        else for (const [st, list] of Object.entries(b.stateVfx)) {
          if (!/^[a-z0-9_]+$/.test(st)) issues.push(`${q}: bad stateVfx state "${st}"`);
          if (!Array.isArray(list) || !list.length) { issues.push(`${q}: stateVfx.${st} must be a non-empty array`); continue; }
          const names = new Set([...Object.keys(s.attach ?? {}), ...Object.values(s.frameAttach ?? {}).flatMap((am) => Object.keys(am ?? {}))]);
          for (const e of list) {
            if (!(m.vfx ?? []).some((v) => v.key === e?.vfx)) issues.push(`${q}: stateVfx.${st}: unknown vfx "${e?.vfx}"`);
            if (!names.has(e?.attach)) issues.push(`${q}: stateVfx.${st}: unknown attach point "${e?.attach}"`);
          }
        }
      }
    }
    if (s.autotile !== undefined) {
      const t = s.autotile; const q = `${p}.autotile`;
      if (s.category !== "decal") issues.push(`${q}: only decal sprites may autotile`);
      if (!t || (t.neighbors !== 4 && t.neighbors !== 8)) issues.push(`${q}: neighbors must be 4 or 8`);
      else if (t.group !== undefined && !/^[a-z0-9_]+$/.test(t.group)) issues.push(`${q}: bad group`);
      else if (!Array.isArray(t.rules) || !t.rules.length) issues.push(`${q}: rules required`);
      else {
        const lim = t.neighbors === 8 ? 0xff : 0xf;
        t.rules.forEach((r, k) => {
          if (!(Number.isInteger(r?.mask) && r.mask >= 0 && r.mask <= lim) || (r.care !== undefined && !(Number.isInteger(r.care) && r.care >= 0 && r.care <= lim))) issues.push(`${q}: rule ${k} mask/care must be integers within 0..${lim}`);
          if (!(Number.isInteger(r?.frame) && r.frame >= 0 && r.frame < total)) issues.push(`${q}: rule ${k} frame out of atlas range`);
        });
        if (!t.rules.some((r) => r.care === 0)) issues.push(`${q}: needs a fallback rule with care 0`);
      }
    }
  });

  // sounds
  const sounds = m.sounds ?? []; uniq(sounds, "sounds");
  sounds.forEach((s, i) => {
    const p = `sounds[${i}](${s.key})`;
    if (!Array.isArray(s.files) || !s.files.length) issues.push(`${p}: files must list at least one variant`);
    else for (const f of s.files) if (!/\.(ogg|mp3|wav|webm)$/.test(f)) issues.push(`${p}: unsupported audio file ${f}`);
    if (s.volume !== undefined && !(s.volume >= 0 && s.volume <= 1)) issues.push(`${p}: volume must be within [0,1]`);
    if (s.pitchJitter !== undefined && !(s.pitchJitter >= 0 && s.pitchJitter <= 1)) issues.push(`${p}: pitchJitter must be within [0,1]`);
    if (!SOUND_CATEGORIES.includes(s.category)) issues.push(`${p}: category must be sfx|ambience|ui`);
    if (s.loop !== undefined && typeof s.loop !== "boolean" && !(s.loop && s.loop.start >= 0 && s.loop.end > s.loop.start)) issues.push(`${p}: loop points need 0 <= start < end (seconds)`);
  });

  // vfx
  const vfx = m.vfx ?? []; uniq(vfx, "vfx");
  vfx.forEach((v, i) => {
    const p = `vfx[${i}](${v.key})`;
    const sp = m.sprites.find((s) => s.key === v.sprite);
    if (!sp) issues.push(`${p}: unknown sprite "${v.sprite}"`);
    else if (v.anim !== undefined && !(v.anim in (sp.animations ?? {}))) issues.push(`${p}: sprite ${v.sprite} has no animation "${v.anim}"`);
    if (!(v.lifetime > 0)) issues.push(`${p}: lifetime must be > 0`);
    if (v.blend !== undefined && !BLEND_MODES.includes(v.blend)) issues.push(`${p}: blend must be normal|additive|multiply`);
    if (v.stretch !== undefined && !STRETCH_MODES.includes(v.stretch)) issues.push(`${p}: stretch must be none|velocity`);
    if (v.stretchMax !== undefined && !(typeof v.stretchMax === "number" && v.stretchMax >= 1 && v.stretchMax <= 64)) issues.push(`${p}: stretchMax must be within [1,64]`);
    const pt = v.particles;
    if (pt) {
      if (!(pt.rate >= 0) || !(Number.isInteger(pt.count) && pt.count >= 0) || pt.rate + pt.count <= 0) issues.push(`${p}: particles need rate >= 0, integer count >= 0, and one of them > 0`);
      if (!Array.isArray(pt.speed) || pt.speed.length !== 2 || !(pt.speed[0] >= 0 && pt.speed[1] >= pt.speed[0])) issues.push(`${p}: speed must be [min,max] with 0 <= min <= max`);
      if (!(pt.spread >= 0 && pt.spread <= 2 * Math.PI)) issues.push(`${p}: spread must be within [0, 2π]`);
      if (typeof pt.gravity !== "number" || !Number.isFinite(pt.gravity)) issues.push(`${p}: gravity must be a number`);
      if (typeof pt.fade !== "boolean") issues.push(`${p}: fade must be boolean`);
      if (!Array.isArray(pt.scaleCurve) || !pt.scaleCurve.length || !pt.scaleCurve.every((x) => x >= 0)) issues.push(`${p}: scaleCurve must be non-empty, values >= 0`);
    }
  });

  // tints / palettes / variants
  const tints = m.tintSets ?? []; const tintKeys = uniq(tints, "tintSets");
  tints.forEach((t, i) => { if (!Array.isArray(t.tints) || !t.tints.length || !t.tints.every((c) => HEX.test(c))) issues.push(`tintSets[${i}](${t.key}): tints must be non-empty #rrggbb list`); });
  const pals = m.palettes ?? []; const palKeys = uniq(pals, "palettes");
  pals.forEach((pl, i) => {
    const p = `palettes[${i}](${pl.key})`;
    if (!Array.isArray(pl.source) || !Array.isArray(pl.target) || pl.source.length !== pl.target.length || !pl.source.length) issues.push(`${p}: source and target must be equal-length, non-empty`);
    else { if (![...pl.source, ...pl.target].every((c) => HEX.test(c))) issues.push(`${p}: colors must be #rrggbb`); if (new Set(pl.source.map((c) => c.toLowerCase())).size !== pl.source.length) issues.push(`${p}: duplicate source color`); }
  });
  const clanPals = m.clanPalettes ?? [];
  if (!Array.isArray(clanPals)) issues.push("clanPalettes must be an array");
  else { uniq(clanPals, "clanPalettes"); if (clanPals.length > 256) issues.push("clanPalettes: at most 256 (u8 index)");
    clanPals.forEach((c, i) => { if (!HEX.test(c?.primary ?? "") || !HEX.test(c?.secondary ?? "")) issues.push(`clanPalettes[${i}](${c?.key}): primary and secondary must be #rrggbb`); }); }
  const sets = m.variantSets ?? []; uniq(sets, "variantSets");
  const variantKeys: string[] = [];
  sets.forEach((vs, i) => {
    const p = `variantSets[${i}](${vs.key})`; const base = m.sprites.find((s) => s.key === vs.base);
    if (!base) issues.push(`${p}: unknown base sprite "${vs.base}"`);
    else if (base.category !== "character" && base.category !== "zombie") issues.push(`${p}: base must be a character or zombie sprite`);
    if (!Array.isArray(vs.variants) || !vs.variants.length) issues.push(`${p}: needs variants`);
    for (const v of vs.variants ?? []) {
      const q = `${p}.${v.key}`;
      if (!KEY.test(v.key ?? "")) issues.push(`${q}: bad key`);
      if (variantKeys.includes(v.key)) issues.push(`${q}: duplicate variant key`); variantKeys.push(v.key);
      if (v.sprite !== undefined && !spriteKeys.has(v.sprite)) issues.push(`${q}: unknown sprite "${v.sprite}"`);
      if (v.tint !== undefined) {
        if (!tintKeys.has(v.tint)) issues.push(`${q}: unknown tint set "${v.tint}"`);
        else { const n = tints.find((t) => t.key === v.tint)!.tints.length; if (!(Number.isInteger(v.tintIndex ?? 0) && (v.tintIndex ?? 0) >= 0 && (v.tintIndex ?? 0) < n)) issues.push(`${q}: tintIndex out of range`); }
      }
      if (v.palette !== undefined && !palKeys.has(v.palette)) issues.push(`${q}: unknown palette "${v.palette}"`);
    }
  });
  // stream placeholders: a sprite key whose atlas is resident (it is what draws while the stream sheet loads)
  {
    const atOf = new Map(m.sprites.map((s) => [s.key, s.atlas])); const resOf = new Map(m.atlases.map((a) => [a.key, a.residency ?? "resident"]));
    const chk = (q: string, ph: unknown) => { if (ph === undefined || ph === null) return; if (typeof ph !== "string") { issues.push(`${q}: placeholder must be a sprite key or null`); return; }
      const at = atOf.get(ph); if (at === undefined) issues.push(`${q}: unknown placeholder sprite "${ph}"`); else if (resOf.get(at) === "stream") issues.push(`${q}: placeholder "${ph}" must live on a resident atlas ("${at}" is stream)`); };
    m.atlases.forEach((a, i) => chk(`atlases[${i}](${a.key})`, a.placeholder));
    m.sprites.forEach((s, i) => chk(`sprites[${i}](${s.key})`, s.placeholder));
  }
  if (issues.length) throw new ManifestError(issues);

  // ids
  const rawLock = (opts.lock ?? {}) as Record<string, unknown>;
  const nsLock: IdLock = ID_KINDS.some((k) => typeof rawLock[k] === "object") ? (rawLock as IdLock) : { sprites: rawLock as Record<string, number> };
  const ids = Object.fromEntries(ID_KINDS.map((k) => [k, new StableIdRegistry(k)])) as Record<IdKind, StableIdRegistry>;
  const lock = {} as Required<IdLock>;
  const keysOf: Record<IdKind, string[]> = { sprites: m.sprites.map((s) => s.key), sounds: sounds.map((s) => s.key), vfx: vfx.map((v) => v.key), variants: variantKeys, tints: tints.map((t) => t.key), palettes: pals.map((p) => p.key) };
  for (const k of ID_KINDS) lock[k] = ids[k].assign(keysOf[k], nsLock[k] ?? {});

  const sprites = new Map<number, SpriteDef>();
  for (const s of m.sprites) { const id = ids.sprites.id(s.key); sprites.set(id, buildSpriteDef(s, atlases, ids)); }
  const soundMap = new Map<number, SoundDef>(sounds.map((s) => { const id = ids.sounds.id(s.key); return [id, { id, key: s.key, files: [...s.files], volume: s.volume ?? 1, pitchJitter: s.pitchJitter ?? 0, loop: !!s.loop, ...(typeof s.loop === "object" ? { loopPoints: { ...s.loop } } : {}), category: s.category }]; }));
  const vfxMap = new Map<number, VfxDef>(vfx.map((v) => { const id = ids.vfx.id(v.key); const sp = m.sprites.find((s) => s.key === v.sprite)!;
    return [id, { id, key: v.key, sprite: ids.sprites.id(v.sprite), anim: v.anim ?? Object.keys(sp.animations)[0]!, lifetime: v.lifetime, blend: v.blend ?? "normal", stretch: v.stretch ?? "none", stretchMax: v.stretchMax ?? 4, ...(v.particles ? { particles: v.particles } : {}) }]; }));
  const tintMap = new Map<number, TintSet>(tints.map((t) => { const id = ids.tints.id(t.key); return [id, { id, key: t.key, tints: t.tints.map(parseColor) }]; }));
  const palMap = new Map<number, Palette>(pals.map((p) => { const id = ids.palettes.id(p.key); const source = p.source.map(parseColor), target = p.target.map(parseColor);
    return [id, { id, key: p.key, source, target, map: new Map(source.map((c, i) => [c, target[i]!])) }]; }));
  const varMap = new Map<number, Variant>();
  for (const vs of sets) for (const v of vs.variants) {
    const id = ids.variants.id(v.key);
    varMap.set(id, { id, key: v.key, set: vs.key, sprite: ids.sprites.id(v.sprite ?? vs.base),
      ...(v.tint !== undefined ? { tint: tintMap.get(ids.tints.id(v.tint))!.tints[v.tintIndex ?? 0]! } : {}),
      ...(v.palette !== undefined ? { palette: ids.palettes.id(v.palette) } : {}) });
  }
  const glyphs = new Map<string, GlyphDef>();
  if (m.glyphs !== undefined) {
    if (!m.glyphs || typeof m.glyphs !== "object") issues.push("glyphs must be an object");
    else for (const [gid, g] of Object.entries(m.glyphs)) {
      if (!GLYPH_ID.test(gid)) { issues.push(`glyphs.${gid}: id must look like kbm.key.e / gamepad.xbox.a / touch.tap`); continue; }
      const sp = [...sprites.values()].find((x) => x.key === g?.sprite);
      if (!sp) { issues.push(`glyphs.${gid}: unknown sprite "${g?.sprite}"`); continue; }
      const total = sp.atlas.columns * sp.atlas.rows; const frame = g.frame ?? sp.animList[0]?.frames[0] ?? 0;
      if (!(Number.isInteger(frame) && frame >= 0 && frame < total)) { issues.push(`glyphs.${gid}: frame out of atlas range`); continue; }
      glyphs.set(gid, { id: gid, sprite: sp.id, frame });
    }
    if (issues.length) throw new ManifestError(issues);
  }
  if (warnings.length && typeof console !== "undefined") for (const w of warnings) console.warn(`[assets] ${w}`);
  const registry = new AssetRegistry(atlases, sprites, ids, soundMap, vfxMap, tintMap, palMap, varMap); registry.glyphs = glyphs;
  registry.clanPalettes = clanPals.map((c, index) => ({ index, key: c.key, primary: parseColor(c.primary), secondary: parseColor(c.secondary) }));
  if (m.wearables !== undefined || m.bodyTypes !== undefined || m.skinTones !== undefined || m.hairColors !== undefined || m.clothingColors !== undefined) {
    const ci: string[] = []; const wl = rawLock.wearables;
    const c = loadCosmetics(m, registry, wl && typeof wl === "object" ? (wl as Record<string, number>) : undefined, ci, opts.deferWear ? { allowMissingWearables: true } : {});
    if (ci.length) throw new ManifestError(ci);
    registry.cosmetics = c.catalog;
    if (opts.deferWear) {
      const base: CosmeticsJson = {};
      if (m.bodyTypes !== undefined) base.bodyTypes = m.bodyTypes;
      if (m.skinTones !== undefined) base.skinTones = m.skinTones;
      if (m.hairColors !== undefined) base.hairColors = m.hairColors;
      if (m.clothingColors !== undefined) base.clothingColors = m.clothingColors;
      if (m.tintNeutral !== undefined) base.tintNeutral = m.tintNeutral;
      if (m.requiredSlots !== undefined) base.requiredSlots = m.requiredSlots;
      if (m.faceAnims !== undefined) base.faceAnims = m.faceAnims;
      registry.wearMerge = { base, wearables: [...(m.wearables ?? [])], loaded: [] };
      // ADR-555: the boot catalog is empty (size 0), but the wearables lock must still ride along —
      // loadCosmetics' assign() copies every locked key into the returned lock even for an empty
      // wearables list, and loadWearShard needs that lock to give wearables their full-merge ids.
      return { registry, lock: { ...lock, wearables: c.lock }, warnings };
    }
    if (c.catalog.size) return { registry, lock: { ...lock, wearables: c.lock }, warnings };
  }
  return { registry, lock, warnings };
}

/**
 * ADR-555: merge one customization wear shard (one category: top, hair, …) into a boot registry built
 * with loadManifest({ deferWear: true }), in place. Sprite ids come from the SAME ids.lock.json the
 * full merge uses (StableIdRegistry.assign honors the lock regardless of call order), so a sprite's id
 * is identical to the full merge's; the cosmetics catalog is rebuilt from base + all merged wearables,
 * so once every shard is merged the registry (sprite ids, cosmetics size/hash, registry.hash) is
 * identical to the full merge. Atlas ids are append order and may differ from the full merge — they
 * are internal only and never go over the net. Throws on a duplicate atlas/sprite, on a shard that
 * references an atlas the boot registry does not have (wear shards only reference their own atlases
 * plus the base shard's pose atlases), or on a second merge of the same category. A shard carrying
 * bodyTypes / palettes / sounds / vfx (i.e. not a wear shard) is rejected: merge only wear shards here.
 */
export function mergeWearShard(registry: AssetRegistry, shard: ManifestJson, opts: { lock?: IdLock | Record<string, number> | undefined; category: string }): { category: string; atlases: number; sprites: number; wearables: number; wearablesLock: Record<string, number> } {
  const { category } = opts;
  const state = registry.wearMerge;
  if (!state) throw new Error(`mergeWearShard(${category}): registry was not built with loadManifest({ deferWear: true })`);
  if (state.loaded.includes(category)) throw new Error(`mergeWearShard(${category}): shard already merged`);
  if (shard.bodyTypes !== undefined || shard.skinTones !== undefined || shard.hairColors !== undefined || shard.clothingColors !== undefined) throw new Error(`mergeWearShard(${category}): shard carries cosmetics source (bodyTypes/palettes) — only wear shards merge here`);
  if (shard.sounds !== undefined || shard.vfx !== undefined || shard.tintSets !== undefined || shard.palettes !== undefined || shard.variantSets !== undefined) throw new Error(`mergeWearShard(${category}): shard carries sounds/vfx/tints/palettes/variants — only wear shards merge here`);
  const issues: string[] = [];
  const rawLock = (opts.lock ?? {}) as Record<string, unknown>;
  const nsLock: IdLock = ID_KINDS.some((k) => typeof rawLock[k] === "object") ? (rawLock as IdLock) : { sprites: rawLock as Record<string, number> };
  const spriteLock = nsLock.sprites ?? {};
  // Assign sprite ids from the full lock BEFORE building (buildSpriteDef resolves ids + dirFrames atlases).
  const spriteKeys = (shard.sprites ?? []).map((s) => s.key);
  registry.ids.sprites.assign(spriteKeys, spriteLock);
  for (const a of shard.atlases ?? []) {
    if (registry.atlases.has(a.key)) { issues.push(`mergeWearShard(${category}): duplicate atlas "${a.key}"`); continue; }
    registry.addAtlas(buildAtlas(a, registry.atlases.size + 1, `wear:${category}.atlases.${a.key}`, issues));
  }
  for (const s of shard.sprites ?? []) {
    if (s.building !== undefined || s.autotile !== undefined) { issues.push(`mergeWearShard(${category}): sprite "${s.key}" carries building/autotile data — only character wear sprites merge here`); continue; }
    const missingDf = Object.values(s.animations ?? {}).flatMap((an) => an.dirFrames ?? []).map((d) => d.atlas).filter((k) => !registry.atlases.has(k));
    if (!registry.atlases.has(s.atlas) || missingDf.length) { issues.push(`mergeWearShard(${category}): sprite "${s.key}" references missing atlas "${!registry.atlases.has(s.atlas) ? s.atlas : missingDf[0]}"`); continue; }
    registry.addSprite(buildSpriteDef(s, registry.atlases, registry.ids));
  }
  if (issues.length) throw new ManifestError(issues);
  state.wearables.push(...(shard.wearables ?? []));
  state.loaded.push(category);
  // Rebuild the catalog from base + every merged shard's wearables. Missing-wearable tolerance stays
  // on: bodyTypes.cosmeticDefaults may still name a shard that has not merged yet; once all nine are
  // in, no reference is missing and the catalog equals the full merge's (same lock, same input order).
  const ci: string[] = [];
  const wl = (rawLock as Record<string, unknown>).wearables;
  const c = loadCosmetics({ ...state.base, wearables: state.wearables }, registry, wl && typeof wl === "object" ? (wl as Record<string, number>) : undefined, ci, { allowMissingWearables: true });
  if (ci.length) throw new ManifestError(ci);
  registry.cosmetics = c.catalog;
  return { category, atlases: (shard.atlases ?? []).length, sprites: spriteKeys.length, wearables: (shard.wearables ?? []).length, wearablesLock: c.lock };
}

/** File IO for validateAssetFiles: exists + image pixel size (undefined if unreadable). Paths are manifest paths. */
export interface AssetFileIO {
  exists(path: string): boolean; imageSize(path: string): { w: number; h: number } | undefined;
  /** Optional byte size; when given, 0-byte .ktx2 files are reported (an empty KTX2 fails to upload at runtime). */
  fileSize?(path: string): number | undefined;
}
/**
 * Checks atlas images, scale pages and mask pages (emissive, sheen, sway, tintmask) exist and that every mask matches its
 * atlas page size (scale-1 mask = atlas image size; `<mask>@Nx` variants, when present, = page N size). Sprite
 * `sway.mask` must match the atlas image or one frame. Returns issues (empty = ok).
 */
export function validateAssetFiles(reg: AssetRegistry, io: AssetFileIO): string[] {
  const issues: string[] = []; const atSize = new Map<string, { w: number; h: number } | undefined>();
  const size = (p: string) => { if (!atSize.has(p)) atSize.set(p, io.imageSize(p)); return atSize.get(p); };
  const at2x = (p: string, k: number) => p.replace(/(\.[a-z]+)$/, `@${k}x$1`);
  for (const a of reg.atlases.values()) {
    const empty = (k: string) => io.fileSize?.(k) === 0;
    for (const pg of a.pages) {
      if (!io.exists(pg.image)) issues.push(`atlas ${a.key}: missing page ${pg.image}`);
      if (pg.ktx2 && !io.exists(pg.ktx2)) issues.push(`atlas ${a.key}: missing ktx2 ${pg.ktx2}`); else if (pg.ktx2 && empty(pg.ktx2)) issues.push(`atlas ${a.key}: ktx2 ${pg.ktx2} is 0 bytes`);
      for (const kp of Object.values(pg.masksKtx2 ?? {})) if (kp && !io.exists(kp)) issues.push(`atlas ${a.key}: missing ktx2 mask ${kp}`); else if (kp && empty(kp)) issues.push(`atlas ${a.key}: ktx2 mask ${kp} is 0 bytes`);
    }
    for (const kp of Object.values(a.masksKtx2 ?? {})) if (kp && !io.exists(kp)) issues.push(`atlas ${a.key}: missing ktx2 mask ${kp}`); else if (kp && empty(kp)) issues.push(`atlas ${a.key}: ktx2 mask ${kp} is 0 bytes`);
    const base = io.exists(a.image) ? size(a.image) : undefined;
    for (const [kind, path] of Object.entries(a.masks) as [MaskKind, string][]) {
      if (!io.exists(path)) { issues.push(`atlas ${a.key}: missing ${kind} mask ${path}`); continue; }
      const ms = size(path); if (!ms || !base) continue;
      if (ms.w !== base.w || ms.h !== base.h) issues.push(`atlas ${a.key}: ${kind} mask ${path} is ${ms.w}x${ms.h}, atlas image is ${base.w}x${base.h}`);
      for (const pg of a.pages) { if (pg.scale === 1) continue; const mp = at2x(path, pg.scale); if (!io.exists(mp) || !io.exists(pg.image)) continue;
        const a2 = size(pg.image), m2 = size(mp); if (a2 && m2 && (a2.w !== m2.w || a2.h !== m2.h)) issues.push(`atlas ${a.key}: ${kind} mask ${mp} is ${m2.w}x${m2.h}, page is ${a2.w}x${a2.h}`); }
    }
  }
  for (const s of reg.allSprites()) {
    const mp = s.sway?.mask; if (!mp) continue;
    if (!io.exists(mp)) { issues.push(`sprite ${s.key}: missing sway mask ${mp}`); continue; }
    const ms = size(mp), base = size(s.atlas.image); if (!ms) continue;
    const okAtlas = base && ms.w === base.w && ms.h === base.h, okFrame = ms.w === s.atlas.frameW && ms.h === s.atlas.frameH;
    if (!okAtlas && !okFrame) issues.push(`sprite ${s.key}: sway mask ${mp} is ${ms.w}x${ms.h}, expected atlas ${base ? `${base.w}x${base.h}` : "?"} or frame ${s.atlas.frameW}x${s.atlas.frameH}`);
  }
  return issues;
}

/** Mix the asset id hash into the world schema hash so client/server handshakes reject mismatched content. */
export function installAssetHash(world: World, reg: AssetRegistry): void { world.addSchemaSalt("assets", reg.hash); }

/** Browser/Node fetch-based loader: manifest + optional lock (ids.lock.json next to it). */
export async function fetchManifest(url: string, fetcher: (u: string) => Promise<{ ok: boolean; json(): Promise<unknown> }> = fetch): Promise<ReturnType<typeof loadManifest>> {
  const res = await fetcher(url); if (!res.ok) throw new Error(`manifest fetch failed: ${url}`);
  const lockUrl = url.replace(/[^/]+$/, "ids.lock.json"); let lock: IdLock | undefined;
  try { const l = await fetcher(lockUrl); if (l.ok) lock = (await l.json()) as IdLock; } catch { /* optional */ }
  return loadManifest(await res.json(), lock ? { lock } : {});
}
