/**
 * ADR-239: the ONE place the renderer reads the season (Summer -> Fall -> Winter -> Spring) and turns it into visuals.
 * - `readSeason(world)`: a host override (client: seasonAtDays on the server-tick day count, ADR-115 style) or the
 *   world's own Season env singleton; undefined without seasons (renders as summer = the original art, unchanged).
 * - `seasonVisual`: blended weights -> shader/CPU amounts (fall recolour, winter frost, ground snow floor, ice).
 * - Sprite classes: Foliage (deciduous: fall colours, dry/frosted winter canopy) and Snowcap (snow on upward edges:
 *   evergreens, rocks, buildings, props), chosen from the sprite key (overridable).
 * - Art variants: `<key>_<season>` (Art & Assets' season-suffixed keys, e.g. tree_oak_fall / tree_winter; "autumn" is
 *   accepted as an alias of fall) win over procedural tinting when the registry has them; procedural otherwise.
 * GLSL + CPU (Canvas2D) recolours share the same maths so WebGL2 and the 2D fallback match.
 */
import { Season, SEASON_NAMES, seasonAt, type SeasonInfo, type World } from "@engine/core";

/** Instance flag bits (sprite shader; above SpriteFlag u8 + CRISP 1024). */
export const SEASON_FOLIAGE = 2048, SEASON_SNOWCAP = 4096;
/** ADR-246: flat ground decals (roads, paths, soil) without `_fall`/`_winter` art: fallen-leaf speckle + snow dusting. */
export const SEASON_GROUND = 8192;
/** ADR-399: continuous-roof snow (rfx roof tiles). Coverage comes from world-space noise on the drawn iso position, so it
 *  runs across tile seams like the roof itself, instead of the per-sprite SNOWCAP edge line that would redraw every seam. */
export const SEASON_ROOFSNOW = 16384;

const override = new WeakMap<World, SeasonInfo>();
/** Host-supplied season (client: from the smoothed server-tick day count, since the view world's tick is not the server's). */
export function setSeasonState(world: World, s: SeasonInfo | undefined): void { if (s) override.set(world, s); else override.delete(world); }
export function readSeason(world: World): SeasonInfo | undefined {
  const o = override.get(world); if (o) return o;
  if (!world.isAlive(world.environment) || !world.isRegistered(Season) || !world.has(world.environment, Season)) return undefined;
  if (!(world.env(Season).lengthDays > 0)) return undefined;
  return seasonAt(world);
}

export interface SeasonVisual {
  summer: number; fall: number; winter: number; spring: number;
  /** ground snow floor 0..1 (winter snowpack; weather snow adds on top) */ snow: number;
  /** water ice cover 0..1 */ ice: number;
  /** dominant season (0 summer, 1 fall, 2 winter, 3 spring) — picks `<key>_<season>` art */ art: number;
}
export const SUMMER_VISUAL: SeasonVisual = Object.freeze({ summer: 1, fall: 0, winter: 0, spring: 0, snow: 0, ice: 0, art: 0 });
export function seasonVisualOf(s: SeasonInfo | undefined): SeasonVisual {
  if (!s) return SUMMER_VISUAL;
  const [su, fa, wi, sp] = s.weights; const w = wi ?? 0;
  const art = s.blend >= 0.5 ? s.next : s.index;
  return { summer: su ?? 0, fall: fa ?? 0, winter: w, spring: sp ?? 0, snow: 0.82 * smooth(0.15, 0.85, w), ice: smooth(0.3, 0.9, w), art };
}
export function seasonVisual(world: World): SeasonVisual { return seasonVisualOf(readSeason(world)); }
const smooth = (a: number, b: number, x: number): number => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---- sprite classes ----
export interface SeasonClassRule { re: RegExp; flags: number }
/** First matching rule wins. Evergreens: snow only (stay green in fall); deciduous: recolour + snow; props/buildings: snow. */
export const SEASON_CLASS_RULES: SeasonClassRule[] = [
  { re: /^(icon_|held_|item_|fx_|tile_|char|body_|hair|wear|ui_|floor|foundation|stairs|road|path)/, flags: 0 },
  { re: /(_fall|_autumn|_winter|_summer|_spring)$/, flags: 0 }, // explicit season art: no procedural pass
  { re: /^(tree_pine|pine_)/, flags: SEASON_SNOWCAP },
  { re: /^(tree_stump)/, flags: SEASON_SNOWCAP },
  { re: /^(tree|oak_tree|birch|willow|bush|berry_bush|blueberry_bush|fiber_grass|flowers|reeds|hedge|shrub|fern|grass_)/, flags: SEASON_FOLIAGE | SEASON_SNOWCAP },
  { re: /^(roof|wall|fence|door|pillar|window|boulder|rock|loose_rocks|stone$|chest|large_chest|workbench|table|stall|tent|crate|barrel|cabin|hut|house|bench|well|planter|flower_box|potted_plant)/, flags: SEASON_SNOWCAP },
  { re: /_ore$/, flags: SEASON_SNOWCAP },
];
export function seasonClassOf(key: string | undefined, rules: readonly SeasonClassRule[] = SEASON_CLASS_RULES): number {
  if (!key) return 0;
  for (const r of rules) if (r.re.test(key)) return r.flags;
  return 0;
}

/** ADR-246: explicit per-season art for keys that are themselves season art without twins: [summer, fall, winter]. */
export const SEASON_ALIASES: Readonly<Record<string, readonly (string | undefined)[]>> = { tree_autumn: [undefined, undefined, "tree_winter", undefined] };
/** Suffixes tried for `<key>_<season>` art (first hit wins). */
export const SEASON_SUFFIXES: readonly (readonly string[])[] = [["summer"], ["fall", "autumn"], ["winter"], ["spring"]];
interface SpriteIds { ids: { sprites: { tryId(k: string): number | undefined } }; sprite(id: number): { key: string } }

/**
 * Per-registry sprite lookup: season class flags and `<key>_<season>` variant ids, cached per sprite id.
 * `variant(sid, season)` returns the variant id or -1; `flags(sid)` the class bits (0 for the variant itself).
 */
export class SeasonArt {
  private cls = new Map<number, number>();
  private vars = new Map<number, Int32Array>();
  constructor(private reg: SpriteIds, private rules: readonly SeasonClassRule[] = SEASON_CLASS_RULES) {}
  private keyOf(sid: number): string | undefined { try { return this.reg.sprite(sid).key; } catch { return undefined; } }
  flags(sid: number): number { let f = this.cls.get(sid); if (f === undefined) { f = seasonClassOf(this.keyOf(sid), this.rules); this.cls.set(sid, f); } return f; }
  variant(sid: number, season: number): number {
    let v = this.vars.get(sid);
    if (!v) {
      v = new Int32Array(SEASON_SUFFIXES.length).fill(-1); const k = this.keyOf(sid);
      if (k) for (let s = 0; s < SEASON_SUFFIXES.length; s++) for (const suf of SEASON_SUFFIXES[s]!) { const id = this.reg.ids.sprites.tryId(`${k}_${suf}`); if (id !== undefined) { v[s] = id; break; } }
      const al = k ? SEASON_ALIASES[k] : undefined; // ADR-246: e.g. tree_autumn (maple) has no own winter art -> tree_winter
      if (al) for (let s = 0; s < SEASON_SUFFIXES.length; s++) { const a = al[s]; if (v[s]! < 0 && a) { const id = this.reg.ids.sprites.tryId(a); if (id !== undefined) v[s] = id; } }
      this.vars.set(sid, v);
    }
    return v[season] ?? -1;
  }
  /** Sprite to draw + class flags for the current season: the variant (no procedural flags) when it exists. */
  resolve(sid: number, vis: SeasonVisual): { sid: number; flags: number } {
    const v = vis.art > 0 || vis.fall + vis.winter + vis.spring > 0 ? this.variant(sid, vis.art) : -1;
    return v >= 0 ? { sid: v, flags: 0 } : { sid, flags: this.flags(sid) };
  }
}
export function seasonName(i: number): string { return SEASON_NAMES[i] ?? "summer"; }

// ---- shared recolour maths (GLSL + CPU mirror) ----
/** GLSL: needs h21 + vnoise in scope. uSeason = (fall, winter, groundSnow); uIce = ice cover. */
export const SEASON_GROUND_GLSL = /* glsl */ `
vec3 seasonGround(vec3 c, vec2 w, vec3 s) {
  if (s.x + s.y < 0.002) return c;
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  float green = smoothstep(0.01, 0.09, c.g - max(c.r, c.b) * 0.92);
  float n = vnoise(w * 0.35 + 5.0) * 0.7 + h21(floor(w * 3.0)) * 0.3;
  vec3 fall = mix(vec3(0.80, 0.60, 0.22), vec3(0.78, 0.40, 0.16), smoothstep(0.35, 0.75, n)) * (0.45 + 1.05 * lum);
  fall = mix(fall, vec3(0.55, 0.52, 0.22) * (0.5 + lum), 0.35 * (1.0 - smoothstep(0.2, 0.6, n)));
  vec3 dead = mix(vec3(0.62, 0.56, 0.42), vec3(0.50, 0.46, 0.38), n) * (0.55 + 0.9 * lum);
  c = mix(c, fall, green * s.x * 0.85);
  c = mix(c, dead, green * s.y * 0.9);
  float g2 = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(c, vec3(g2) * vec3(0.92, 0.97, 1.08), s.y * 0.28); // winter: cold, desaturated light
  return c;
}
vec3 seasonSnow(vec3 c, vec2 w, float m, float snow) {
  if (snow < 0.001) return c;
  float cover = smoothstep(1.0 - snow, 1.0 - snow + 0.15, m * 0.6 + 0.2 * h21(floor(w * 6.0)) + 0.2);
  return mix(c, vec3(0.9, 0.93, 0.98) * (0.94 + 0.06 * h21(floor(w * 16.0))), cover);
}
vec3 seasonIce(vec3 c, vec2 w, float ice, float shore) {
  if (ice < 0.001) return c;
  float n = vnoise(w * 0.6) * 0.6 + vnoise(w * 2.3 + 3.0) * 0.4;
  float cover = smoothstep(1.0 - ice * 1.15, 1.0 - ice * 1.15 + 0.12, n * 0.55 + shore * 0.45 + 0.05);
  vec2 g = fract(w * 1.7 + vnoise(w * 4.0) * 0.4) - 0.5; float crack = 1.0 - smoothstep(0.0, 0.035, min(abs(g.x), abs(g.y)));
  vec3 icec = mix(vec3(0.70, 0.84, 0.93), vec3(0.88, 0.94, 0.98), n) * (1.0 - 0.12 * crack);
  return mix(c, icec, cover);
}`;

/** GLSL for sprites (self-contained hash sHash): needs alphaAt/uTexel. uSeason = (fall, winter, snowCap). */
export const SEASON_SPRITE_GLSL = /* glsl */ `
float sHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec3 seasonSprite(vec3 c, int fl, vec2 uv, float seed, vec2 px) {
  if (uSeason.x + uSeason.y < 0.002) return c;
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  if ((fl & ${SEASON_FOLIAGE}) != 0) {
    float green = smoothstep(0.0, 0.08, c.g - max(c.r, c.b) * 0.9);
    float pick = fract(seed * 7.31); float pn = sHash(floor(px / 3.0) + seed * 17.0);
    vec3 pal = pick < 0.4 ? vec3(0.95, 0.66, 0.16) : pick < 0.75 ? vec3(0.93, 0.42, 0.12) : vec3(0.78, 0.22, 0.14);
    pal = mix(pal, vec3(0.96, 0.78, 0.25), step(0.82, pn) * 0.6);
    vec3 fall = pal * (0.32 + 1.35 * lum);
    vec3 bare = mix(vec3(0.46, 0.38, 0.30), vec3(0.60, 0.56, 0.52), step(0.55, pn)) * (0.45 + 1.0 * lum);
    c = mix(c, fall, green * uSeason.x);
    c = mix(c, bare, green * uSeason.y * 0.92);
  }
  float g2 = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(c, vec3(g2) * vec3(0.93, 0.98, 1.08), uSeason.y * 0.22);
  if ((fl & ${SEASON_GROUND}) != 0) { // ADR-246: seasonal roads (no road art variants): leaves in fall, dusting in winter
    vec2 cell = floor(px / 2.0); float lh = sHash(cell + seed * 3.0);
    vec3 leaf = lh < 0.5 ? vec3(0.86, 0.48, 0.14) : lh < 0.8 ? vec3(0.74, 0.26, 0.12) : vec3(0.90, 0.70, 0.22);
    c = mix(c, leaf * (0.75 + 0.5 * lum), step(1.0 - 0.16 * uSeason.x, sHash(cell + 41.0)));
    float dust = max(uSeason.y * 0.5, uSeason.z * 0.55); float n = sHash(floor(px / 3.0) + 7.0) * 0.6 + sHash(cell + 13.0) * 0.4;
    c = mix(c, vec3(0.90, 0.93, 0.98) * (0.94 + 0.06 * sHash(floor(px))), smoothstep(1.0 - dust, 1.0 - dust + 0.12, n));
  }
  if ((fl & ${SEASON_SNOWCAP}) != 0 && uSeason.z > 0.001) {
    float up1 = 1.0 - alphaAt(uv - vec2(0.0, uTexel * 2.0)), up2 = 1.0 - alphaAt(uv - vec2(0.0, uTexel * 4.5));
    float edge = max(up1, up2 * 0.85) * (0.75 + 0.25 * sHash(floor(px / 2.0) + seed));
    float flatF = smoothstep(0.55, 0.85, lum) * 0.25; // bright upward faces (roof planes, rock tops) dust over
    float cover = clamp(edge + flatF, 0.0, 1.0) * uSeason.z;
    c = mix(c, vec3(0.92, 0.95, 1.0) * (0.92 + 0.08 * sHash(floor(px))), smoothstep(0.15, 0.6, cover));
  }
  return c;
}
// ADR-399: whole-roof snow. w = drawn iso position (world px), continuous across neighbouring roof tiles; brighter (sky-
// facing) roof faces hold more snow, darker eave / gable faces less. uSeason.z = snow cover 0..1.
vec3 roofSnow(vec3 c, vec2 w) {
  if (uSeason.z < 0.001) return c;
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  float n = sHash(floor(w / 9.0) + 5.0) * 0.6 + sHash(floor(w / 3.0) + 11.0) * 0.4;
  float cover = smoothstep(1.0 - uSeason.z, 1.0 - uSeason.z + 0.22, n * 0.55 + smoothstep(0.2, 0.7, lum) * 0.45);
  return mix(c, vec3(0.92, 0.95, 1.0) * (0.93 + 0.07 * sHash(floor(w))), cover);
}`;

/** CPU mirror of seasonSprite for Canvas2D (RGBA8 in place, image width w). */
export function seasonSpritePixels(px: Uint8ClampedArray, w: number, h: number, flags: number, seed: number, fall: number, winter: number, snowCap: number): void {
  if (fall + winter < 0.002) return;
  const pick = fract(seed * 7.31);
  const pal = pick < 0.4 ? [0.95, 0.66, 0.16] : pick < 0.75 ? [0.93, 0.42, 0.12] : [0.78, 0.22, 0.14];
  const a0 = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) a0[i] = px[i * 4 + 3]!;
  const alpha0 = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h ? 0 : a0[y * w + x]! / 255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4; if (px[i + 3]! < 90) continue;
    let r = px[i]! / 255, g = px[i + 1]! / 255, b = px[i + 2]! / 255; const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (flags & SEASON_FOLIAGE) {
      const green = smooth(0, 0.08, g - Math.max(r, b) * 0.9); const pn = hash(Math.floor(x / 3) + seed * 17, Math.floor(y / 3) + seed * 17);
      const k = pn >= 0.82 ? 0.6 : 0; const pc = [pal[0]! + (0.96 - pal[0]!) * k, pal[1]! + (0.78 - pal[1]!) * k, pal[2]! + (0.25 - pal[2]!) * k];
      const fm = 0.32 + 1.35 * lum; const bs = pn >= 0.55 ? [0.6, 0.56, 0.52] : [0.46, 0.38, 0.3]; const bm = 0.45 + lum;
      const af = green * fall, aw = green * winter * 0.92;
      r += (pc[0]! * fm - r) * af; g += (pc[1]! * fm - g) * af; b += (pc[2]! * fm - b) * af;
      r += (bs[0]! * bm - r) * aw; g += (bs[1]! * bm - g) * aw; b += (bs[2]! * bm - b) * aw;
    }
    const g2 = 0.299 * r + 0.587 * g + 0.114 * b; const cw = winter * 0.22;
    r += (g2 * 0.93 - r) * cw; g += (g2 * 0.98 - g) * cw; b += (g2 * 1.08 - b) * cw;
    if (flags & SEASON_GROUND) { // ADR-246 (mirror of the GLSL road pass)
      const cx = Math.floor(x / 2), cy = Math.floor(y / 2); const lh = hash(cx + seed * 3, cy + seed * 3);
      const lc = lh < 0.5 ? [0.86, 0.48, 0.14] : lh < 0.8 ? [0.74, 0.26, 0.12] : [0.9, 0.7, 0.22]; const lm = 0.75 + 0.5 * lum;
      if (hash(cx + 41, cy + 41) >= 1 - 0.16 * fall) { r = lc[0]! * lm; g = lc[1]! * lm; b = lc[2]! * lm; }
      const dust = Math.max(winter * 0.5, snowCap * 0.55); const n = hash(Math.floor(x / 3) + 7, Math.floor(y / 3) + 7) * 0.6 + hash(cx + 13, cy + 13) * 0.4;
      const cv = smooth(1 - dust, 1 - dust + 0.12, n); const sn = 0.94 + 0.06 * hash(x, y);
      r += (0.9 * sn - r) * cv; g += (0.93 * sn - g) * cv; b += (0.98 * sn - b) * cv;
    }
    if ((flags & SEASON_SNOWCAP) && snowCap > 0.001) {
      const up1 = 1 - alpha0(x, y - 2), up2 = 1 - alpha0(x, y - 5);
      const edge = Math.max(up1, up2 * 0.85) * (0.75 + 0.25 * hash(Math.floor(x / 2) + seed, Math.floor(y / 2) + seed));
      const cover = smooth(0.15, 0.6, Math.min(1, edge + smooth(0.55, 0.85, lum) * 0.25) * snowCap); const sn = 0.92 + 0.08 * hash(x, y);
      r += (0.92 * sn - r) * cover; g += (0.95 * sn - g) * cover; b += (1.0 * sn - b) * cover;
    }
    px[i] = r * 255; px[i + 1] = g * 255; px[i + 2] = b * 255;
  }
}
/** CPU ground colour (Canvas2D flat diamonds): same seasonGround maths on an RGB triple (0..1); n = per-tile noise 0..1. */
export function seasonGroundRgb(c: readonly number[], fall: number, winter: number, n: number): [number, number, number] {
  let [r, g, b] = c as [number, number, number]; const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const green = smooth(0.01, 0.09, g - Math.max(r, b) * 0.92); const t = smooth(0.35, 0.75, n);
  let f = [0.8 + (0.78 - 0.8) * t, 0.6 + (0.4 - 0.6) * t, 0.22 + (0.16 - 0.22) * t].map((v) => v * (0.45 + 1.05 * lum));
  const ol = 0.35 * (1 - smooth(0.2, 0.6, n)); f = [f[0]! + (0.55 * (0.5 + lum) - f[0]!) * ol, f[1]! + (0.52 * (0.5 + lum) - f[1]!) * ol, f[2]! + (0.22 * (0.5 + lum) - f[2]!) * ol];
  const d = [0.62 + (0.5 - 0.62) * n, 0.56 + (0.46 - 0.56) * n, 0.42 + (0.38 - 0.42) * n].map((v) => v * (0.55 + 0.9 * lum));
  const af = green * fall * 0.85, aw = green * winter * 0.9;
  r += (f[0]! - r) * af; g += (f[1]! - g) * af; b += (f[2]! - b) * af;
  r += (d[0]! - r) * aw; g += (d[1]! - g) * aw; b += (d[2]! - b) * aw;
  const g2 = 0.299 * r + 0.587 * g + 0.114 * b; const cw = winter * 0.28;
  return [r + (g2 * 0.92 - r) * cw, g + (g2 * 0.97 - g) * cw, b + (g2 * 1.08 - b) * cw];
}
const fract = (v: number): number => v - Math.floor(v);
function hash(x: number, y: number): number { return fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453); }
