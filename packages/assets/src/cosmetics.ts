import { BODY_TYPES, DEFAULT_REQUIRED_SLOTS, DEFAULT_TINT_NEUTRAL, DIRECTIONS8, OUTLINE_MODES, TINT_MODES, type TintMode, StableIdRegistry, WEARABLE_SLOTS, fnv1a,
  normalizeOutline, type BodyType, type BodyTypeInfo, type CosmeticCatalogLike, type Direction8, type OutlineMode, type PaletteColor,
  type WearableDef, type WearableLayerDef, type WearableLayerProps, type WearableSlot } from "@engine/core";
import type { AssetRegistry, SpriteDef } from "./manifest.js";

/** Manifest JSON for character customization (see docs/CHARACTER_CUSTOMIZATION.md, ADR-082). */
export interface BodyArtJson { sprite: string; /** default "idle" (first anim if absent) */ anim?: string }
export interface BodyTypeJson extends BodyArtJson {
  displayName?: string; locKey?: string;
  /** slot -> wearable key: used by defaultAppearance and to fill requiredSlots in validateAppearance. */
  cosmeticDefaults?: Partial<Record<WearableSlot, string>>;
}
export interface WearableBodyJson extends BodyArtJson { /** hair only: art drawn under a hat with hatHair: true */ hatHair?: BodyArtJson }
/** layerByDir: 4 numbers (E,S,W,N), 8 numbers (E,SE,S,SW,W,NW,N,NE) or an object keyed by compass name (missing = `layer`). */
export type LayerByDirJson = number[] | Partial<Record<Direction8, number>>;
export interface WearableLayerPropsJson {
  layerByDir?: LayerByDirJson; z?: number;
  /** 0 untinted (default), 1 = tintmask R <- primary, 2 = + G <- secondary. Requires the atlas tintmask mask. */
  tintChannels?: 0 | 1 | 2;
  /** Optional render hints: tint blend mode (default multiply), strength 0..1, saturation 0..2, neutral grey 0..1 (default manifest tintNeutral); minor = droppable by crowd LOD. */
  tintMode?: TintMode; tintStrength?: number; tintSaturation?: number; tintNeutral?: number; minor?: boolean;
  /** "body" (default) | "none"; legacy boolean true = body, false = none. */
  outline?: boolean | OutlineMode;
}
export interface WearableLayerJson extends WearableLayerPropsJson { name: string; layer: number; bodies: Partial<Record<BodyType, WearableBodyJson>> }
export interface WearableJson extends WearableLayerPropsJson {
  key: string; slot: WearableSlot;
  /** Required for the single-layer form; optional with `layers` (then layers define the body set). */
  bodies?: Partial<Record<BodyType, WearableBodyJson>>;
  /** Required for the single-layer form; with `layers` defaults to layers[0].layer. */
  layer?: number;
  /** Multi-layer form: one DrawLayer per entry; unset layer props inherit from the wearable. */
  layers?: WearableLayerJson[];
  hidesSlots?: WearableSlot[]; hatHair?: boolean; unlockTags?: string[];
  displayName?: string; locKey?: string;
  /** face/eyes only: body anim -> expression key (overrides manifest faceAnims). */
  faceAnims?: Record<string, string>;
  /** face/eyes only: expression key -> per-body art. Every anim of the part's sprite is also an expression key. */
  expressions?: Record<string, Partial<Record<BodyType, BodyArtJson>>>;
}
/** Skin tones only (data, optional): intended on-screen cel ramp (`color` stays the multiply-tint input). See pack/customization/skin_tones.json. */
export interface SkinRampJson { base: string; shadow: string; highlight: string }
export interface PaletteColorJson { key: string; color: string; ramp?: SkinRampJson; undertone?: "cool" | "neutral" | "warm" | "olive"; monk?: number; fitzpatrick?: string }
export interface CosmeticsJson {
  bodyTypes?: Partial<Record<BodyType, BodyTypeJson>>; wearables?: WearableJson[];
  skinTones?: PaletteColorJson[]; hairColors?: PaletteColorJson[]; clothingColors?: PaletteColorJson[];
  /** Neutral grey of masked regions (0..1, default 0.78). */
  tintNeutral?: number;
  /** Slots that must be filled; default ["face","eyes"] when any body declares cosmeticDefaults, else none. */
  requiredSlots?: WearableSlot[];
  /** Catalog-wide face/eyes anim -> expression key. */
  faceAnims?: Record<string, string>;
}

/** Resolved cosmetics; implements the core CosmeticCatalogLike used by validateAppearance / resolveLayers. */
export class CosmeticCatalog implements CosmeticCatalogLike {
  constructor(readonly ids: StableIdRegistry, private readonly parts: Map<number, WearableDef>,
    private readonly bodies: Partial<Record<BodyType, BodyTypeInfo>>,
    readonly skinTones: PaletteColor[], readonly hairColors: PaletteColor[], readonly clothingColors: PaletteColor[],
    readonly tintNeutral: number = DEFAULT_TINT_NEUTRAL, readonly requiredSlots: readonly WearableSlot[] = [],
    readonly faceAnims?: Record<string, string>) {}
  get size(): number { return this.parts.size; }
  get hash(): number {
    let h = fnv1a(`cosmetics:${this.ids.hash}`);
    for (const k of ["skinTones", "hairColors", "clothingColors"] as const) h = fnv1a(`${k}:${this[k].map((c) => c.key).join(",")};`, h);
    return h;
  }
  wearable(id: number): WearableDef | undefined { return this.parts.get(id); }
  byKey(key: string): WearableDef | undefined { const id = this.ids.tryId(key); return id === undefined ? undefined : this.parts.get(id); }
  bySlot(slot: WearableSlot, body?: BodyType): WearableDef[] { return [...this.parts.values()].filter((w) => w.slot === slot && (!body || !!w.bodies[body])).sort((a, b) => a.id - b.id); }
  bodySprite(b: BodyType): { sprite: number; anim: string } | undefined { const x = this.bodies[b]; return x && { sprite: x.sprite, anim: x.anim }; }
  /** Body art + displayName/locKey + cosmeticDefaults (wearable ids). */
  bodyType(b: BodyType): BodyTypeInfo | undefined { return this.bodies[b]; }
  bodyDefaults(b: BodyType): Partial<Record<WearableSlot, number>> | undefined { return this.bodies[b]?.cosmeticDefaults; }
}

const KEY = /^[a-z0-9_]+$/; const COLOR = /^#[0-9a-fA-F]{6}$/;

/** Validate + build the cosmetics catalog against a loaded AssetRegistry. Pushes issues; ids honor `lock`.
 * ADR-555: `allowMissingWearables` tolerates a boot catalog whose wear shards are not loaded yet — a
 * bodyTypes.cosmeticDefaults entry (or a requiredSlots fill) naming a not-yet-loaded wearable is skipped
 * instead of an issue, so the boot manifest (base shard only) still builds. Any other issue (unknown
 * sprite art, bad slot, …) still fails: only the two missing-wearable sites are suppressed, and once
 * every wear shard is merged no reference is missing, so the lazy path converges to the strict result. */
export function loadCosmetics(m: CosmeticsJson, reg: AssetRegistry, lock: Record<string, number> | undefined, issues: string[], opts: { allowMissingWearables?: boolean } = {}): { catalog: CosmeticCatalog; lock: Record<string, number> } {
  const pal = (name: "skinTones" | "hairColors" | "clothingColors"): PaletteColor[] => {
    const list = m[name]; if (list === undefined) return [];
    if (!Array.isArray(list)) { issues.push(`${name} must be an array`); return []; }
    if (list.length > 256) issues.push(`${name}: at most 256 entries (u8 index)`);
    const seen = new Set<string>();
    return list.map((c, index) => {
      if (!KEY.test(c?.key ?? "")) issues.push(`${name}[${index}]: bad key`);
      if (seen.has(c.key)) issues.push(`${name}[${index}](${c.key}): duplicate key`); seen.add(c.key);
      if (!COLOR.test(c?.color ?? "")) issues.push(`${name}[${index}](${c.key}): color must be #rrggbb`);
      const out: PaletteColor = { index, key: c.key, color: parseInt((c.color ?? "#000000").slice(1), 16) };
      if (c?.ramp !== undefined) { // ADR-245: skin ramp (base / shadow / highlight); swatches show ramp.base
        const r = c.ramp as Partial<SkinRampJson>; const bad = (["base", "shadow", "highlight"] as const).filter((k) => !COLOR.test(r?.[k] ?? ""));
        if (bad.length) issues.push(`${name}[${index}](${c.key}): ramp.${bad.join("/")} must be #rrggbb`);
        else out.ramp = { base: parseInt(r.base!.slice(1), 16), shadow: parseInt(r.shadow!.slice(1), 16), highlight: parseInt(r.highlight!.slice(1), 16) };
      }
      return out;
    });
  };
  const skinTones = pal("skinTones"), hairColors = pal("hairColors"), clothingColors = pal("clothingColors");
  const sprite = (key: string): SpriteDef | undefined => { const id = reg.ids.sprites.tryId(key); return id === undefined ? undefined : reg.sprite(id); };
  const art = (p: string, a: BodyArtJson | undefined, tint: number): { sprite: number; anim: string } | undefined => {
    const s = a && typeof a.sprite === "string" ? sprite(a.sprite) : undefined;
    if (!s) { issues.push(`${p}: unknown sprite "${a?.sprite}"`); return undefined; }
    const anim = a!.anim ?? (s.animations.has("idle") ? "idle" : s.animList[0]?.name);
    const an = anim !== undefined ? s.animations.get(anim) : undefined;
    if (!an) { issues.push(`${p}: sprite ${s.key} has no anim "${anim}"`); return undefined; }
    if (an.directions === 1 && !an.rotations) issues.push(`${p}: anim ${s.key}.${an.name} needs per-direction frames (directions 4|8 or rotations)`);
    if (tint > 0 && !s.atlas.masks.tintmask) issues.push(`${p}: tintChannels ${tint} but atlas ${s.atlas.key} has no tintmask`);
    return { sprite: s.id, anim: an.name };
  };
  const bodies: Partial<Record<BodyType, BodyTypeInfo>> = {};
  const str = (p: string, k: string, v: unknown) => { if (v !== undefined && !(typeof v === "string" && v.length > 0)) issues.push(`${p}: ${k} must be a non-empty string`); };
  for (const [b, a] of Object.entries(m.bodyTypes ?? {})) {
    if (!(BODY_TYPES as readonly string[]).includes(b)) { issues.push(`bodyTypes.${b}: unknown body type (male|female)`); continue; }
    str(`bodyTypes.${b}`, "displayName", a?.displayName); str(`bodyTypes.${b}`, "locKey", a?.locKey);
    const r = art(`bodyTypes.${b}`, a, 1);
    if (r) bodies[b as BodyType] = { ...r, ...(a.displayName ? { displayName: a.displayName } : {}), ...(a.locKey ? { locKey: a.locKey } : {}) };
  }
  const tintNeutral = m.tintNeutral ?? DEFAULT_TINT_NEUTRAL;
  const unit = (v: unknown) => typeof v === "number" && v > 0 && v <= 1;
  if (!unit(tintNeutral)) issues.push("tintNeutral must be a number in (0,1]");
  const faceMap = (p: string, f: unknown): Record<string, string> | undefined => {
    if (f === undefined) return undefined;
    if (!f || typeof f !== "object" || Array.isArray(f)) { issues.push(`${p}: faceAnims must be an object`); return undefined; }
    for (const [k, v] of Object.entries(f)) if (!KEY.test(k) || typeof v !== "string" || !KEY.test(v)) issues.push(`${p}: faceAnims.${k} must map an anim name to an expression key`);
    return { ...(f as Record<string, string>) };
  };
  const catFace = faceMap("manifest", m.faceAnims);
  const list = m.wearables ?? [];
  if (!Array.isArray(list)) issues.push("wearables must be an array");
  const wl = Array.isArray(list) ? list : [];
  if (wl.length && !skinTones.length) issues.push("skinTones: at least one entry required when wearables are defined");
  const seen = new Set<string>();
  wl.forEach((w, i) => { if (!KEY.test(w?.key ?? "")) issues.push(`wearables[${i}]: bad key`); if (seen.has(w.key)) issues.push(`wearables[${i}](${w.key}): duplicate key`); seen.add(w.key); });
  const ids = new StableIdRegistry("wearables");
  let outLock: Record<string, number> = {};
  try { outLock = ids.assign(wl.map((w) => w.key), lock ?? {}); } catch (e) { issues.push(String((e as Error).message)); }
  const parts = new Map<number, WearableDef>(); const hides = new Map<WearableSlot, Set<WearableSlot>>();
  const dirs = (p: string, d: LayerByDirJson | undefined, layer: number): number[] | undefined => {
    if (d === undefined) return undefined;
    if (Array.isArray(d)) {
      if (!((d.length === 4 || d.length === 8) && d.every(Number.isInteger))) issues.push(`${p}: layerByDir must be 4 integers (E,S,W,N) or 8 (E,SE,S,SW,W,NW,N,NE)`);
      return [...d];
    }
    if (!d || typeof d !== "object") { issues.push(`${p}: layerByDir must be an array or a compass-keyed object`); return undefined; }
    for (const [k, v] of Object.entries(d)) {
      if (!(DIRECTIONS8 as readonly string[]).includes(k)) issues.push(`${p}: layerByDir has unknown direction "${k}" (N,NE,E,SE,S,SW,W,NW)`);
      else if (!Number.isInteger(v)) issues.push(`${p}: layerByDir.${k} must be an integer`);
    }
    return DIRECTIONS8.map((k) => (d as Partial<Record<Direction8, number>>)[k] ?? layer);
  };
  /** Validate + normalize shared layer props; `base` supplies inherited values for layers. */
  const props = (p: string, j: WearableLayerPropsJson, layer: unknown, slot: WearableSlot, base?: WearableLayerProps): WearableLayerProps => {
    if (!Number.isInteger(layer)) issues.push(`${p}: layer must be an integer`);
    const L = typeof layer === "number" ? layer : 0;
    if (j.z !== undefined && typeof j.z !== "number") issues.push(`${p}: z must be a number`);
    const tint = j.tintChannels ?? base?.tintChannels ?? 0; if (![0, 1, 2].includes(tint)) issues.push(`${p}: tintChannels must be 0|1|2`);
    if (j.tintMode !== undefined && !TINT_MODES.includes(j.tintMode)) issues.push(`${p}: tintMode must be one of ${TINT_MODES.join("|")}`);
    if (j.tintStrength !== undefined && !(typeof j.tintStrength === "number" && j.tintStrength >= 0 && j.tintStrength <= 1)) issues.push(`${p}: tintStrength must be a number in 0..1`);
    if (j.tintSaturation !== undefined && !(typeof j.tintSaturation === "number" && j.tintSaturation >= 0 && j.tintSaturation <= 2)) issues.push(`${p}: tintSaturation must be a number in 0..2`);
    if (j.tintNeutral !== undefined && !unit(j.tintNeutral)) issues.push(`${p}: tintNeutral must be a number in (0,1]`);
    if (j.minor !== undefined && typeof j.minor !== "boolean") issues.push(`${p}: minor must be a boolean`);
    if (j.outline !== undefined && typeof j.outline !== "boolean" && !OUTLINE_MODES.includes(j.outline)) issues.push(`${p}: outline must be "body" | "none" (or legacy boolean)`);
    if (tint > 0 && !(slot === "hair" || slot === "face" ? hairColors : clothingColors).length) issues.push(`${p}: tinted but its palette is empty`);
    const lbd = j.layerByDir !== undefined ? dirs(p, j.layerByDir, L) : base?.layerByDir;
    const om: OutlineMode | undefined = (typeof j.outline === "boolean" || OUTLINE_MODES.includes(j.outline as OutlineMode) ? normalizeOutline(j.outline) : undefined) ?? base?.outlineMode;
    const pick = <K extends "tintMode" | "tintStrength" | "tintSaturation" | "tintNeutral" | "minor">(k: K) => (j[k] !== undefined ? j[k] : base?.[k]);
    const o: WearableLayerProps = { layer: L, z: typeof j.z === "number" ? j.z : base?.z ?? 0, tintChannels: tint as 0 | 1 | 2 };
    if (lbd) o.layerByDir = lbd;
    for (const k of ["tintMode", "tintStrength", "tintSaturation", "tintNeutral", "minor"] as const) { const v = pick(k); if (v !== undefined) (o as unknown as Record<string, unknown>)[k] = v; }
    if (om) { o.outlineMode = om; o.outline = om === "body"; }
    return o;
  };
  const bodyArt = (p: string, src: Partial<Record<BodyType, WearableBodyJson>> | undefined, slot: WearableSlot, tint: number): WearableDef["bodies"] => {
    const bt = Object.keys(src ?? {});
    if (!bt.length) issues.push(`${p}: bodies must list at least one body type`);
    const out: WearableDef["bodies"] = {};
    for (const b of bt) {
      if (!(BODY_TYPES as readonly string[]).includes(b)) { issues.push(`${p}: unknown body type "${b}"`); continue; }
      if (!bodies[b as BodyType]) issues.push(`${p}: body type ${b} has no bodyTypes.${b} base art`);
      const ba = src![b as BodyType]!; const r = art(`${p}.bodies.${b}`, ba, tint); if (!r) continue;
      if (ba.hatHair !== undefined && slot !== "hair") issues.push(`${p}.bodies.${b}: hatHair art is only valid on hair`);
      const hh = ba.hatHair !== undefined ? art(`${p}.bodies.${b}.hatHair`, ba.hatHair, tint) : undefined;
      out[b as BodyType] = { ...r, ...(hh ? { hatHair: hh } : {}) };
    }
    return out;
  };
  wl.forEach((w, i) => {
    const p = `wearables[${i}](${w.key})`;
    if (!(WEARABLE_SLOTS as readonly string[]).includes(w.slot)) { issues.push(`${p}: unknown slot "${w.slot}"`); return; }
    str(p, "displayName", w.displayName); str(p, "locKey", w.locKey);
    for (const h of w.hidesSlots ?? []) {
      if (!(WEARABLE_SLOTS as readonly string[]).includes(h)) issues.push(`${p}: hidesSlots has unknown slot "${h}"`);
      else if (h === w.slot) issues.push(`${p}: cannot hide its own slot`);
      else { const s = hides.get(w.slot) ?? new Set(); s.add(h); hides.set(w.slot, s); }
    }
    if (w.hatHair && w.slot !== "hat") issues.push(`${p}: hatHair is only valid on hats`);
    if (w.hatHair && w.hidesSlots?.includes("hair")) issues.push(`${p}: hatHair conflicts with hidesSlots hair`);
    for (const t of w.unlockTags ?? []) if (!KEY.test(t)) issues.push(`${p}: bad unlock tag "${t}"`);
    const multi = w.layers !== undefined;
    if (multi && !(Array.isArray(w.layers) && w.layers.length > 0)) { issues.push(`${p}: layers must be a non-empty array`); return; }
    const top = props(p, w, multi && w.layer === undefined ? w.layers![0]?.layer : w.layer, w.slot);
    let out: WearableDef["bodies"]; let layers: WearableLayerDef[] | undefined;
    if (multi) {
      const names = new Set<string>(); let set: string | undefined;
      layers = w.layers!.map((lj, li) => {
        const q = `${p}.layers[${li}](${lj?.name})`;
        if (!KEY.test(lj?.name ?? "")) issues.push(`${q}: bad layer name`); else if (names.has(lj.name)) issues.push(`${q}: duplicate layer name`); names.add(lj?.name);
        const lp = props(q, lj, lj?.layer, w.slot, top);
        const b = bodyArt(q, lj?.bodies ?? w.bodies, w.slot, lp.tintChannels);
        const ks = Object.keys(lj?.bodies ?? w.bodies ?? {}).sort().join(",");
        if (set === undefined) set = ks; else if (ks !== set) issues.push(`${q}: bodies must cover the same body types as layers[0] (${set})`);
        return { name: lj?.name, ...lp, bodies: b };
      });
      out = layers[0]!.bodies;
      if (w.bodies !== undefined && Object.keys(w.bodies).sort().join(",") !== set) issues.push(`${p}: bodies must match the layers' body types (${set})`);
    } else out = bodyArt(p, w.bodies, w.slot, top.tintChannels);
    // face/eyes expressions: every anim of the base sprite + explicit expressions
    let expressions: WearableDef["expressions"]; let fa: Record<string, string> | undefined;
    if (w.faceAnims !== undefined || w.expressions !== undefined) if (w.slot !== "face" && w.slot !== "eyes") issues.push(`${p}: faceAnims/expressions are only valid on face and eyes`);
    if (w.slot === "face" || w.slot === "eyes") {
      expressions = {};
      for (const [b, a] of Object.entries(out)) { const s = reg.sprite(a.sprite); for (const an of s.animList) (expressions[an.name] ??= {})[b as BodyType] = { sprite: s.id, anim: an.name }; }
      if (w.expressions !== undefined) {
        if (!w.expressions || typeof w.expressions !== "object") issues.push(`${p}: expressions must be an object`);
        else for (const [k, per] of Object.entries(w.expressions)) {
          if (!KEY.test(k)) issues.push(`${p}: bad expression key "${k}"`);
          for (const [b, a] of Object.entries(per ?? {})) {
            if (!out[b as BodyType]) { issues.push(`${p}.expressions.${k}: body type ${b} not supported by this wearable`); continue; }
            const r = art(`${p}.expressions.${k}.${b}`, a, top.tintChannels); if (r) (expressions[k] ??= {})[b as BodyType] = r;
          }
        }
      }
      fa = faceMap(p, w.faceAnims);
      for (const [an, k] of Object.entries(fa ?? catFace ?? {})) if (!expressions[k] && (fa || Object.keys(catFace ?? {}).length)) {
        if (fa) issues.push(`${p}: faceAnims.${an} -> unknown expression "${k}" (not an anim of the part's sprite nor in expressions)`);
      }
      if (!Object.keys(expressions).length) expressions = undefined;
    }
    const id = ids.tryId(w.key); if (id === undefined) return;
    parts.set(id, { id, key: w.key, slot: w.slot, bodies: out, ...top, ...(layers ? { layers } : {}),
      hidesSlots: [...(w.hidesSlots ?? [])], hatHair: !!w.hatHair, unlockTags: [...(w.unlockTags ?? [])],
      ...(w.displayName ? { displayName: w.displayName } : {}), ...(w.locKey ? { locKey: w.locKey } : {}),
      ...(fa ? { faceAnims: fa } : {}), ...(expressions ? { expressions } : {}) });
  });
  for (const [a, hs] of hides) for (const b of hs) if (hides.get(b)?.has(a)) { if (a < b) issues.push(`slot conflict: ${a} and ${b} wearables hide each other`); }
  // per-body cosmeticDefaults + requiredSlots
  let anyDefaults = false;
  for (const [b, bj] of Object.entries(m.bodyTypes ?? {})) {
    const info = bodies[b as BodyType]; const d = bj?.cosmeticDefaults; if (d === undefined) continue; anyDefaults = true;
    if (!d || typeof d !== "object") { issues.push(`bodyTypes.${b}: cosmeticDefaults must be an object`); continue; }
    const ids2: Partial<Record<WearableSlot, number>> = {};
    for (const [slot, key] of Object.entries(d)) {
      const q = `bodyTypes.${b}.cosmeticDefaults.${slot}`;
      if (!(WEARABLE_SLOTS as readonly string[]).includes(slot)) { issues.push(`${q}: unknown slot`); continue; }
      const id = typeof key === "string" ? ids.tryId(key) : undefined; const wd = id !== undefined ? parts.get(id) : undefined;
      if (!wd) { if (!opts.allowMissingWearables) issues.push(`${q}: unknown wearable "${key}"`); continue; }
      if (wd.slot !== slot) issues.push(`${q}: ${key} belongs to slot ${wd.slot}`);
      else if (!wd.bodies[b as BodyType]) issues.push(`${q}: ${key} has no ${b} art`);
      else ids2[slot as WearableSlot] = id!;
    }
    if (info) info.cosmeticDefaults = ids2;
  }
  const requiredSlots = m.requiredSlots ?? (anyDefaults ? [...DEFAULT_REQUIRED_SLOTS] : []);
  if (!Array.isArray(requiredSlots)) issues.push("requiredSlots must be an array");
  else for (const r of requiredSlots) {
    if (!(WEARABLE_SLOTS as readonly string[]).includes(r)) { issues.push(`requiredSlots: unknown slot "${r}"`); continue; }
    for (const b of Object.keys(bodies)) if (!bodies[b as BodyType]!.cosmeticDefaults?.[r]) { if (!opts.allowMissingWearables) issues.push(`requiredSlots: ${r} is required but bodyTypes.${b}.cosmeticDefaults.${r} is missing`); }
  }
  return { catalog: new CosmeticCatalog(ids, parts, bodies, skinTones, hairColors, clothingColors, tintNeutral, Array.isArray(requiredSlots) ? requiredSlots : [], catFace), lock: outLock };
}
