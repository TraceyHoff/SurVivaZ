/**
 * Renderer-side look knobs. Defaults are NEUTRAL (no outline, no banding, no grading) — the art
 * direction is owned by Art & Assets, who tune these per theme via `renderer.setStyle({...})`.
 */
export interface StyleConfig {
  /** Shader sprite outline (drawn outside the alpha silhouette). */
  outline: { enabled: boolean; widthPx: number; color: [number, number, number, number] };
  /** Light quantisation: 0 = smooth, N = N bands; `bandMix` blends smooth<->banded (0..1). */
  lightBands: number; bandMix: number;
  /** Floor for the ambient term (0..1 luminance) and the tint used to reach it at night. */
  nightMinBrightness: number; nightTint: [number, number, number];
  /** Colour grading applied in composite. */
  grading: { saturation: number; contrast: number; lift: [number, number, number]; gain: [number, number, number] };
  fogColor: [number, number, number];
  /** "blob" = soft ellipse under each Shadow entity; "projected" = sun-skewed silhouette; "none". */
  shadowMode: "blob" | "projected" | "none";
  blobShadow: { alpha: number; widthFactor: number; aspect: number };
  /** Multiplier for emissive masks / Emissive sprites (how strongly they ignore darkness). */
  emissiveStrength: number;
  /** Point-light contribution scale during full daylight (0..1). */
  daylightLightScale: number;
  /** Alpha for cut-away roofs / upper floors when the focus entity is inside. */
  cutawayAlpha: number;
  /**
   * Occlusion fade: tall sprites / walls that sort in front of the local player and overlap its screen rect either
   * fade to `alpha` ("fade") or get a dithered circle cut around the player ("dither"). `silhouette` draws the player
   * through remaining occluders in `silhouetteColor` (rgba).
   */
  occlusion: { enabled: boolean; mode: "fade" | "dither"; alpha: number; radiusPx: number; minHeightPx: number; fadeSpeed: number; silhouette: boolean; silhouetteColor: [number, number, number, number] };
  /** Bloom from emissive-masked / Emissive-flagged pixels only (fire, windows, eyes); never a global threshold. */
  bloom: { strength: number; radiusPx: number; nightBoost: number };
  /** Grading LUT strip (16³ 256x16 or 32³ 1024x32, auto-detected) and time-of-day keyframes; URLs resolve relative to the tuning file. */
  gradingLut: { url: string | null; strength: number; keyframes: string | null };
  /** Shadow colour (multiplied by alpha); keyframes may override per hour. */
  shadowTint: [number, number, number];
  /**
   * Global status tints (render_tuning wet/cold/hot/exhausted, at full intensity). Applied scaled by the status amount
   * 0..1; a sprite's SpriteDef.tints entry of the same name (wet, frost, flush, exhausted) overrides it.
   * saturation is optional in manifests (default 1).
   */
  statusTints: Record<StatusTintName, StatusTint>;
  /** Per-sprite survival FX: wet sheen, frost rim (alpha per cold level 0..3), shiver (px per cold level, Hz, burst). */
  fx: { sheenColor: [number, number, number]; sheenStrength: number; frostColor: [number, number, number]; frostAlpha: [number, number, number, number]; frostWidthPx: number;
    shiverPx: [number, number, number, number]; shiverHz: number; exhaustedDroop: number;
    flushStrength: number; flushTint: [number, number, number]; wetDarken: number; wetSheen: number };
  /** Ground overlays (procedural fallback). wetRate/dryRate: surface wetness per second under full rain / when dry. */
  surface: { wetDarken: number; puddles: number; skyReflection: [number, number, number]; wetRate: number; dryRate: number; snowRate: number; meltRate: number };
  /** Wind for sway when Weather.windSpeed is 0. dir in radians (tile axes), speed in tiles/s; refSpeed maps speed to sway strength 1. */
  wind: { defaultDir: number; defaultSpeed: number; refSpeed: number };
  /** Cloud shadows: tileable noise scrolled by wind (alpha 0 disables). */
  clouds: { alpha: number; scalePx: number; overcastBoost: number };
  /** Storm lightning: screen flash + optional bolt sprite (`fx_lightning` in the registry). */
  lightning: { enabled: boolean; flash: number; meanIntervalSec: number; color: [number, number, number] };
  /** Heat shimmer around heat Emitters (strength 0 disables). */
  shimmer: { strength: number; scale: number; speed: number };
}

export const STATUS_TINTS = ["wet", "frost", "flush", "exhausted"] as const;
export type StatusTintName = (typeof STATUS_TINTS)[number];
export type TintModeName = "multiply" | "add" | "screen" | "lerp";
export const TINT_MODE_INDEX: Record<TintModeName, number> = { multiply: 0, add: 1, screen: 2, lerp: 3 };
export interface StatusTint { color: [number, number, number]; strength: number; mode: TintModeName; saturation: number }

export const DEFAULT_STYLE: StyleConfig = {
  outline: { enabled: false, widthPx: 1, color: [0.1, 0.08, 0.12, 1] },
  lightBands: 0, bandMix: 0,
  nightMinBrightness: 0, nightTint: [0.55, 0.55, 0.8],
  grading: { saturation: 1, contrast: 1, lift: [0, 0, 0], gain: [1, 1, 1] },
  fogColor: [0.72, 0.76, 0.8],
  shadowMode: "blob",
  blobShadow: { alpha: 0.35, widthFactor: 0.55, aspect: 0.4 },
  emissiveStrength: 1,
  daylightLightScale: 0.2,
  cutawayAlpha: 0.10,
  occlusion: { enabled: true, mode: "fade", alpha: 0.35, radiusPx: 44, minHeightPx: 40, fadeSpeed: 8, silhouette: true, silhouetteColor: [0.85, 0.92, 1.0, 0.45] },
  bloom: { strength: 0.35, radiusPx: 6, nightBoost: 1 },
  gradingLut: { url: null, strength: 1, keyframes: null },
  shadowTint: [0, 0, 0],
  statusTints: {
    wet: { color: [0.8, 0.85, 0.97], strength: 0.9, mode: "multiply", saturation: 1.1 },
    frost: { color: [0.92, 0.96, 1.08], strength: 1, mode: "multiply", saturation: 0.86 },
    flush: { color: [1.1, 0.95, 0.92], strength: 1, mode: "multiply", saturation: 1.08 },
    exhausted: { color: [0.893, 0.884, 0.94], strength: 1, mode: "multiply", saturation: 0.78 },
  },
  fx: { sheenColor: [0.91, 0.965, 1], sheenStrength: 0.35, frostColor: [0.81, 0.92, 1], frostAlpha: [0, 0.35, 0.6, 0.85], frostWidthPx: 1.5,
    shiverPx: [0, 0.35, 0.7, 1.2], shiverHz: 16, exhaustedDroop: 0.03,
    flushStrength: 1, flushTint: [1, 0.6, 0.55], wetDarken: 0.8, wetSheen: 0.35 },
  surface: { wetDarken: 0.75, puddles: 1, skyReflection: [0.55, 0.62, 0.72], wetRate: 0.05, dryRate: 0.008, snowRate: 0.02, meltRate: 0.01 },
  wind: { defaultDir: 0.6, defaultSpeed: 2, refSpeed: 10 },
  clouds: { alpha: 0, scalePx: 900, overcastBoost: 0.5 },
  lightning: { enabled: true, flash: 0.7, meanIntervalSec: 7, color: [0.8, 0.85, 1] },
  shimmer: { strength: 1, scale: 1, speed: 1 },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type StylePatch = DeepPartial<StyleConfig>;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) continue; out[k] = isObj(out[k]) && isObj(v) ? deepMerge(out[k] as Record<string, unknown>, v) : v; }
  return out;
}
export function mergeStyle(base: StyleConfig, patch: StylePatch): StyleConfig {
  return deepMerge(cloneData(base) as unknown as Record<string, unknown>, patch as Record<string, unknown>) as unknown as StyleConfig;
}

/**
 * Validate a render_tuning.json (Art & Assets' look override layer) against the StyleConfig shape.
 * Unknown keys and type mismatches are dropped with a warning; the rest is merged over `base`.
 * Keys starting with "$" or "_" (comments/meta) are ignored silently.
 */
export function loadRenderTuning(json: unknown, base: StyleConfig = DEFAULT_STYLE): { style: StyleConfig; patch: StylePatch; warnings: string[] } {
  const warnings: string[] = [];
  const clean = (v: unknown, ref: unknown, path: string): unknown => {
    if (isObj(ref)) {
      if (!isObj(v)) { warnings.push(`${path}: expected object`); return undefined; }
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (k.startsWith("$") || k.startsWith("_")) continue;
        if (!(k in ref)) { warnings.push(`unknown key ${path ? path + "." : ""}${k}`); continue; }
        const c = clean(x, (ref as Record<string, unknown>)[k], path ? `${path}.${k}` : k); if (c !== undefined) out[k] = c;
      }
      return out;
    }
    if (Array.isArray(ref)) {
      if (!Array.isArray(v) || v.length !== ref.length || !v.every((n) => typeof n === "number" && Number.isFinite(n))) { warnings.push(`${path}: expected number[${ref.length}]`); return undefined; }
      return v;
    }
    if (ref === null) { if (v === null || typeof v === "string") return v; warnings.push(`${path}: expected string|null`); return undefined; }
    if (typeof ref === "string" && path.endsWith(".mode") && path.startsWith("statusTints.")) { if (v === "multiply" || v === "add" || v === "screen" || v === "lerp") return v; warnings.push(`${path}: expected multiply|add|screen|lerp`); return undefined; }
    if (typeof ref === "string" && path === "occlusion.mode") { if (v === "fade" || v === "dither") return v; warnings.push(`${path}: expected fade|dither`); return undefined; }
    if (typeof ref === "string" && path === "shadowMode") { if (v === "blob" || v === "projected" || v === "none") return v; warnings.push(`${path}: expected blob|projected|none`); return undefined; }
    if (typeof v !== typeof ref) { warnings.push(`${path}: expected ${typeof ref}`); return undefined; }
    if (typeof v === "number" && !Number.isFinite(v)) { warnings.push(`${path}: not finite`); return undefined; }
    return v;
  };
  let src = json;
  if (isSurvivalTuning(json)) { const a = survivalTuningToStyle(json); warnings.push(...a.warnings); src = { ...a.patch, ...(isObj(json.style) ? json.style : {}) }; }
  const patch = (clean(src, base, "") ?? {}) as StylePatch;
  return { style: mergeStyle(base, patch), patch, warnings };
}

// ---------- Art & Assets survival_fx render_tuning.json (its own schema: wet/cold/hot/exhausted/...) ----------
const hex3 = (v: unknown): [number, number, number] | null => {
  if (typeof v !== "string" || !/^#[0-9a-f]{6}$/i.test(v)) return null;
  const n = parseInt(v.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const num3 = (v: unknown): [number, number, number] | null => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number") ? [v[0], v[1], v[2]] as [number, number, number] : null;
const num4 = (v: unknown): [number, number, number, number] | null => Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === "number") ? [v[0], v[1], v[2], v[3]] as [number, number, number, number] : null;
const at = (o: unknown, ...path: string[]): unknown => path.reduce<unknown>((x, k) => (isObj(x) ? x[k] : undefined), o);
const last = <T>(v: unknown): T | undefined => (Array.isArray(v) && v.length ? (v[v.length - 1] as T) : undefined);

/** True for the survival_fx tuning schema (top-level wet/cold/hot blocks) rather than a StyleConfig patch. */
export function isSurvivalTuning(json: unknown): json is Record<string, unknown> {
  return isObj(json) && (isObj(json.wet) || isObj(json.cold) || isObj(json.hot)) && !("outline" in json);
}

/**
 * Map survival_fx render_tuning.json onto StyleConfig: status tints (multiply + saturation at level 3; the renderer scales
 * them linearly by the status amount), wet sheen, frost rim alpha per level, shiver amplitudes, lightning flash colour.
 * Blocks that drive gameplay-side VFX spawning (drips, breath, sweat, bubbles, food, heat light presets) are returned in
 * `extras` for the caller. A `style` block (StyleConfig-shaped) in the file is merged on top.
 */
export function survivalTuningToStyle(t: Record<string, unknown>): { patch: StylePatch; warnings: string[]; extras: Record<string, unknown> } {
  const warnings: string[] = []; const patch: StylePatch = {}; const tints: Partial<Record<StatusTintName, StatusTint>> = {}; const fx: StylePatch["fx"] = {};
  const wetTint = num3(at(t, "wet", "darkenTint"));
  if (wetTint) tints.wet = { color: wetTint, strength: 0.9, mode: "multiply", saturation: 1.1 };
  const sc = hex3(at(t, "wet", "sheenColor")); if (sc) fx.sheenColor = sc;
  const ss = at(t, "wet", "sheenStrength"); if (typeof ss === "number") fx.sheenStrength = ss;
  const cm = num3(last(at(t, "cold", "tint", "multiply"))); const cs = last<number>(at(t, "cold", "tint", "saturation"));
  if (cm) tints.frost = { color: cm, strength: 1, mode: "multiply", saturation: typeof cs === "number" ? cs : 1 };
  const fc = hex3(at(t, "cold", "frostRim", "color")); if (fc) fx.frostColor = fc;
  const fa = num4(at(t, "cold", "frostRim", "alpha")); if (fa) fx.frostAlpha = fa;
  const fw = last<number>(at(t, "cold", "frostRim", "widthPx")); if (typeof fw === "number") fx.frostWidthPx = fw;
  const sp = num4(at(t, "cold", "shiver", "amplitudePx")); if (sp) fx.shiverPx = sp;
  const sh = at(t, "cold", "shiver", "frequencyHz"); if (typeof sh === "number") fx.shiverHz = sh;
  const hm = num3(last(at(t, "hot", "flush", "multiply"))); const hs = last<number>(at(t, "hot", "flush", "saturation"));
  if (hm) tints.flush = { color: hm, strength: 1, mode: "multiply", saturation: typeof hs === "number" ? hs : 1 };
  const em = num3(at(t, "exhausted", "tint", "multiply")); const eb = at(t, "exhausted", "tint", "brightness"); const es = at(t, "exhausted", "tint", "saturation");
  if (em) { const b = typeof eb === "number" ? eb : 1; tints.exhausted = { color: [em[0] * b, em[1] * b, em[2] * b], strength: 1, mode: "multiply", saturation: typeof es === "number" ? es : 1 }; }
  const dr = at(t, "exhausted", "droop", "scaleY"); if (typeof dr === "number") fx.exhaustedDroop = 1 - dr;
  const flash = at(t, "weather", "lightning", "screenFlash");
  if (typeof flash === "string") { const m = flash.match(/#[0-9a-f]{6}/i); const c = m ? hex3(m[0]) : null; if (c) patch.lightning = { color: c }; }
  const shim = num4(at(t, "hot", "shimmer", "offsetPx")); const scroll = at(t, "hot", "shimmer", "scrollUpPxPerS");
  if (shim) patch.shimmer = { strength: shim[3] / 1.2, ...(typeof scroll === "number" ? { speed: scroll / 18 } : {}) };
  if (Object.keys(tints).length) patch.statusTints = tints as NonNullable<StylePatch["statusTints"]>;
  if (Object.keys(fx).length) patch.fx = fx;
  const consumed = new Set(["version", "units", "doc", "wet", "cold", "hot", "exhausted", "weather", "style"]);
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t)) if (!consumed.has(k)) extras[k] = v;
  return { patch, warnings, extras };
}

/** structuredClone for plain config data, with a fallback for browsers / WebViews without it (old Android WebViews). */
export function cloneData<T>(v: T): T {
  if (typeof structuredClone === "function") return structuredClone(v);
  const c = (x: unknown): unknown => {
    if (x === null || typeof x !== "object") return x;
    if (ArrayBuffer.isView(x)) return (x as unknown as { slice(): unknown }).slice();
    if (Array.isArray(x)) return x.map(c);
    const o: Record<string, unknown> = {}; for (const [k, y] of Object.entries(x)) o[k] = c(y); return o;
  };
  return c(v) as T;
}
