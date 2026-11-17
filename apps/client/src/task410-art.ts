// ADR-410: tilesets for ADR-409's sloped ground shapes (ramps + wedges), painted at runtime — no binary
// PNGs in the push snapshot. The pixels are rasterized here with the task34 software canvas (Px), declared
// in the pack/task410 fragment (layout only: one atlas per season, 15 cols x 4 rows of 68x52 cells), and
// turned into blob URLs by task410AtlasSources() — the vehicles/atlas.ts pattern — which view.ts merges
// into the atlas sources before setRegistry. The renderer (terrainTiles.ts, ADR-409) already swaps a
// sloped tile's base layer to `gt_<mat>_slope_ramp_<d>` / `gt_<mat>_slope_wedge_<c>` when GroundArt
// resolves it, so these pixels are what a ramp/wedge draws once they ship.
//
// Art language (same as the flat ground, packages/assets/pack/nature/src/ground_mats.py + ground_paint.py):
// the same per-material, per-season palettes (t0 highlight / t1 mid / t2 shade / t3 deep + the material's
// decoration colours), the same tone field (mid dominant, highlight/shade islands, fine specks), the same
// decorations (tufts, pebbles, leaves, flowers, cracks, slabs, puddles), the same diamond geometry
// (68x52 cell, centre (34,18), shader diamond 64x32 with the flat art's ~1.06 overshoot so no transparent
// fringe shows at the tile edge, no skirt — like land_tile, the base frame is the top diamond only).
// Nothing here tints or scales a flat tile: every ramp/wedge cell is drawn for its shape — the tone field
// is painted per pixel, then a quantized cel light model follows the slope (5 light bands from the uphill
// edge to the downhill edge/corner, a darker crease along the downhill edge(s), a light rim along the
// uphill edge(s)), and every decoration is shaded by the light at its own position. The vertex shader
// already foreshortens the tilted quad geometrically, so the texture itself is painted flat-on-the-ground
// (no skew) and the light is what makes the tilt read.
import type { AtlasSource } from "@engine/render";
import { GROUND_PRIORITY, groundSlopeKey, type GroundMaterial } from "@engine/render";
import { Px } from "./task34-art.js";

/** Atlas keys this module paints (also the fragment's atlas keys), one per season. */
export const TASK410_ATLAS_KEYS = ["gt_slope_summer", "gt_slope_fall", "gt_slope_winter", "gt_slope_spring"] as const;
export type Task410Season = 0 | 1 | 2 | 3;
/** Grid: 15 cols x 4 rows of 68x52 cells (1x); the 2x page is 136x104 cells. 56 of 60 slots used. */
export const TASK410_COLUMNS = 15;
export const TASK410_ROWS = 4;
export const TASK410_CELL_W = 68;
export const TASK410_CELL_H = 52;
/** Frame index for (material index in GROUND_PRIORITY, shape 0-3 ramp dirs / 4-7 wedge corners). */
export const task410Frame = (matIdx: number, shapeIdx: number): number => matIdx * 8 + shapeIdx;
/** Shape index for a slope-art kind + dir (dir = ramp downhill axis 0-3, or wedge low corner 0-3). */
export const task410Shape = (kind: "ramp" | "wedge", dir: number): number => (kind === "ramp" ? dir & 3 : 4 + (dir & 3));
/** Sprite key this module paints for (material, season, kind, dir) — the ADR-409 contract key. */
export const task410Key = (mat: GroundMaterial, season: number, kind: "ramp" | "wedge", dir: number): string =>
  groundSlopeKey(mat, season, kind, dir);

type RGBA = readonly [number, number, number, number?];
const OUTLINE: RGBA = [59, 36, 51]; // ground OUTL #3b2433 (same dark plum as the flat ground art)
const hx = (h: string): RGBA => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const shade = (c: RGBA, k: number): RGBA => [
  Math.max(0, Math.min(255, Math.round(c[0] * k))),
  Math.max(0, Math.min(255, Math.round(c[1] * k))),
  Math.max(0, Math.min(255, Math.round(c[2] * k))),
  c[3] ?? 255,
];

/** Per-material, per-season palette — ground_mats.py `P`, transcribed (t0 highlight, t1 mid, t2 shade, t3 deep). */
interface MatPal {
  t: readonly [string, string, string, string]; ol: string;
  blade?: readonly [string, string, string]; fl?: readonly (readonly [string, string])[]; clover?: string;
  leaves?: readonly string[]; leafol?: string; snow?: readonly string[]; frost?: string; bud?: string;
  peb?: readonly string[]; sprout?: readonly string[]; damp?: string;
  soil?: readonly string[]; fern?: readonly string[]; bloss?: readonly (readonly [string, string])[] | readonly string[];
  shell?: readonly string[]; star?: readonly string[]; wet?: string;
  moss?: readonly string[]; lichen?: string;
  pud?: readonly string[]; reed?: readonly string[];
  spark?: string; ice?: string; earth?: readonly string[]; slush?: string; needles?: readonly string[]; twig?: string;
}
const PAL: Record<GroundMaterial, readonly [MatPal, MatPal, MatPal, MatPal]> = {
  grass: [
    { t: ["#b4e46e", "#8fd15c", "#72bd50", "#4f9a48"], ol: "#3a7542", blade: ["#c4ec7a", "#64b04c", "#3f8a47"], fl: [["#fffaf0", "#ffd75e"], ["#ff9ec4", "#fff3b0"], ["#ffd75e", "#e8a93a"], ["#93c6ff", "#fffaf0"]], clover: "#a6dc6a" },
    { t: ["#e2d872", "#c6c257", "#a4a648", "#7c8540"], ol: "#5e5a32", blade: ["#ecd889", "#a8a24c", "#77783a"], fl: [["#c9a8f0", "#ffd75e"], ["#fffaf0", "#f5c95c"]], clover: "#d6cd6c", leaves: ["#f4a74a", "#e07a3a", "#f0c24c", "#c8503c"], leafol: "#8a3e2e" },
    { t: ["#cfe0c6", "#a9c29a", "#8fa982", "#6e8a6c"], ol: "#566a5a", blade: ["#e6dfb4", "#b8a676", "#8a7a58"], snow: ["#ffffff", "#eef4fb", "#cdd9ec", "#9fb0cf"], frost: "#f2f8ff" },
    { t: ["#e6f494", "#cae76c", "#a8d458", "#7ab24a"], ol: "#4a7e3e", blade: ["#f0fa9c", "#b0dc5a", "#6aa646"], fl: [["#ffe14a", "#f59a2a"], ["#b98cf0", "#ffe68a"], ["#ffc6dc", "#fff6c8"], ["#fffaf0", "#ffd75e"]], clover: "#c6ea78", bud: "#f2f8c8" },
  ],
  dirt: [
    { t: ["#e4b486", "#c99464", "#ab7a50", "#82593e"], ol: "#5c4034", peb: ["#e4e0d8", "#b8b2b0", "#8a8494"], sprout: ["#8fd15c", "#4f9a48"] },
    { t: ["#d8a678", "#bc8658", "#9c6a48", "#74503a"], ol: "#56392f", peb: ["#e4e0d8", "#b8b2b0", "#8a8494"], leaves: ["#f4a74a", "#e07a3a", "#f0c24c", "#b8483a"], leafol: "#7e3a2c" },
    { t: ["#c6ac98", "#a68a76", "#8a705f", "#66524a"], ol: "#4c3c3c", peb: ["#e2e6ee", "#b4b8c4", "#868aa0"], snow: ["#ffffff", "#eef4fb", "#cdd9ec", "#9fb0cf"], frost: "#e8eff8" },
    { t: ["#c89e7c", "#a87e60", "#8c664e", "#664a3e"], ol: "#4e382f", peb: ["#dcdcd4", "#acaaac", "#7e7c8c"], sprout: ["#c8ec6e", "#7cc24c"], damp: "#957058" },
  ],
  forest: [
    { t: ["#7fb85a", "#5f9c4a", "#4c8444", "#33623c"], ol: "#2a4a34", soil: ["#9a7650", "#7a5a40"], leaves: ["#a8a44c", "#c2924c", "#8a7a3c", "#6f8a40"], leafol: "#4a4430", fern: ["#7cc055", "#3d7f43"] },
    { t: ["#e6a456", "#c98244", "#a8663a", "#7a4a30"], ol: "#5a2e26", soil: ["#9a7050", "#7e5a40"], leaves: ["#f6c84e", "#e8743a", "#c8443a", "#9a6a3a", "#f4a74a"], leafol: "#6a2e26", fern: ["#c8a050", "#8a6a34"] },
    { t: ["#ffffff", "#eaf1fa", "#cbd7ea", "#9fb0cf"], ol: "#4a5470", soil: ["#8a7464", "#6a5850"], leaves: ["#a8805a", "#8a6248", "#c49a6a"], leafol: "#5a4038", needles: ["#4f8a6e", "#2f6052"], twig: "#6a4a3c" },
    { t: ["#c6e874", "#a6d45e", "#84b84e", "#5c9440"], ol: "#3a5e34", soil: ["#8e6a4c", "#6e5040"], leaves: ["#a88a5a", "#8e7450", "#c2a46e", "#d8ec78"], leafol: "#5a4834", fern: ["#c4ec6c", "#6eb448"], bloss: [["#ffffff", "#ffe14a"], ["#ffc6dc", "#fff6c8"], ["#b98cf0", "#ffe68a"]] },
  ],
  sand: [
    { t: ["#fff4cc", "#f6dfa4", "#e8c887", "#cfa86c"], ol: "#9a7a52", shell: ["#ffd6e8", "#ff9ec4", "#d47a96"], peb: ["#e4e0d8", "#b8b2b0", "#8a8494"], star: ["#ffb070", "#ff8436", "#c8582e"] },
    { t: ["#f8ecc4", "#eedb9e", "#dcc184", "#c0a26c"], ol: "#8e7250", shell: ["#ffe6cc", "#eba98a", "#b87a6a"], peb: ["#e4e0d8", "#b8b2b0", "#8a8494"], leaves: ["#f4a74a", "#e07a3a", "#f0c24c"], leafol: "#8a4a30" },
    { t: ["#f4eee0", "#e2d8c0", "#cbbfa4", "#a99c84"], ol: "#7a7064", shell: ["#f2eef8", "#cfc4dc", "#9a8eae"], peb: ["#e2e6ee", "#b4b8c4", "#868aa0"], snow: ["#ffffff", "#eef4fb", "#cdd9ec", "#9fb0cf"], frost: "#ffffff" },
    { t: ["#f6eccc", "#eadaa6", "#d6c08a", "#b8a070"], ol: "#8c7456", shell: ["#e8f0ff", "#b4c8f0", "#8494c8"], peb: ["#dcdcd4", "#acaaac", "#7e7c8c"], wet: "#cdb88e", bloss: ["#ffc6dc", "#ffe68a"] },
  ],
  rock: [
    { t: ["#dcd8d0", "#b8b2b0", "#9d97a2", "#6f6a80"], ol: "#4f4a60", moss: ["#a8cc6a", "#7fa856"], lichen: "#d8dc8a" },
    { t: ["#d8d2c8", "#b4aca8", "#98909a", "#6c6478"], ol: "#4c445a", moss: ["#b8b45a", "#8a8a44"], lichen: "#f0a24a", leaves: ["#f4a74a", "#e07a3a", "#f0c24c"], leafol: "#7e3a2c" },
    { t: ["#d4d8e2", "#adb2c2", "#9296aa", "#666a84"], ol: "#4a4c66", moss: ["#8aa08a", "#647a6a"], lichen: "#c8d0e0", snow: ["#ffffff", "#eef4fb", "#cdd9ec", "#9fb0cf"] },
    { t: ["#d6d8cc", "#b0b0a8", "#94969a", "#68687a"], ol: "#4a4a5c", moss: ["#c8ec6e", "#88c450"], lichen: "#e8f08a", bloss: ["#ffe14a", "#f59a2a"] },
  ],
  mud: [
    { t: ["#a98060", "#8c6448", "#74523c", "#553c30"], ol: "#3e2c28", wet: "#c39c7a", pud: ["#d8f0f4", "#9cc8d8", "#6e9cb4"], reed: ["#a6c46a", "#6f8a44"] },
    { t: ["#a47a5a", "#865e44", "#6e4c38", "#50382e"], ol: "#3a2a26", wet: "#bc9474", pud: ["#f2e2c4", "#b8b4a4", "#7e8a90"], leaves: ["#f4a74a", "#d8703a", "#b8483a"], leafol: "#5e2e26", reed: ["#c8b062", "#8a7a44"] },
    { t: ["#9e8a7c", "#80695c", "#68544c", "#4c3e3c"], ol: "#3a3036", wet: "#b8a698", pud: ["#ffffff", "#d4ecf6", "#a6cce2", "#7aa4c4"], snow: ["#ffffff", "#eef4fb", "#cdd9ec", "#9fb0cf"] },
    { t: ["#8e7468", "#725a50", "#5c4842", "#423436"], ol: "#342a2e", wet: "#a8a0a0", pud: ["#eef8ff", "#a4cce0", "#6c9cba"], reed: ["#c8ec6e", "#7cc24c"], sprout: ["#c8ec6e", "#7cc24c"] },
  ],
  snow: [
    { t: ["#ffffff", "#eef4fb", "#d6e1f0", "#aebdd8"], ol: "#7d8cae", peb: ["#d4d8e2", "#a9aebc", "#7f8498"], spark: "#ffffff", ice: "#cfeaf6" },
    { t: ["#ffffff", "#eef4fb", "#d6e1f0", "#aebdd8"], ol: "#7d8cae", peb: ["#d4d8e2", "#a9aebc", "#7f8498"], spark: "#ffffff", ice: "#cfeaf6", leaves: ["#e07a3a", "#f0c24c"], leafol: "#8a4a30" },
    { t: ["#ffffff", "#f2f7fd", "#d4e0f0", "#a8b8d6"], ol: "#7486aa", peb: ["#d4d8e2", "#a9aebc", "#7f8498"], spark: "#ffffff", ice: "#cfeaf6" },
    { t: ["#f2f2ec", "#dcdcd6", "#bcc0c4", "#949aa8"], ol: "#6e7486", peb: ["#c4c0b8", "#9a948e", "#726c6a"], spark: "#ffffff", ice: "#d8eef4", earth: ["#9a7a62", "#7c5e4a", "#5e4638"], slush: "#b8c8d0", sprout: ["#c8ec6e", "#7cc24c"] },
  ],
};
/** Tone-field seed per material (ground_paint.py SEED). */
const SEED: Record<GroundMaterial, number> = { grass: 11, dirt: 23, forest: 37, sand: 41, rock: 53, mud: 67, snow: 79 };
/** Tone island counts (n_hi, n_sh) per material (ground_paint.py tone() calls, variant 0). */
const TONE_N: Record<GroundMaterial, readonly [number, number]> = { grass: [3, 3], dirt: [2, 2], forest: [3, 3], sand: [2, 2], rock: [1, 2], mud: [3, 3], snow: [4, 1] };

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Lattice hash 0..1 (deterministic; the Python lattice is numpy PCG64 — same character, not the same bits). */
function hash2(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 974634211)) >>> 0;
  h = (Math.imul(h ^ (h >>> 13), 1274126177)) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
const quintic = (f: number): number => f * f * f * (f * (f * 6 - 15) + 10);
/** Periodic value noise on an n x n lattice (ground_core.py vn): period 1 in u and v, so tiles tile seamlessly. */
function vn(u: number, v: number, n: number, seed: number): number {
  const x = (((u % 1) + 1) % 1) * n, y = (((v % 1) + 1) % 1) * n;
  const i = Math.floor(x), j = Math.floor(y);
  const fx = quintic(x - i), fy = quintic(y - j);
  const i1 = (i + 1) % n, j1 = (j + 1) % n;
  const a = hash2(i, j, seed) * (1 - fx) + hash2(i1, j, seed) * fx;
  const b = hash2(i, j1, seed) * (1 - fx) + hash2(i1, j1, seed) * fx;
  return a * (1 - fy) + b * fy;
}
/** Shared high-frequency field (ground_mats.py fine). */
const fine = (u: number, v: number, seed: number): number =>
  vn(u, v, 8, seed) * 0.45 + vn(u, v, 16, seed + 1) * 0.35 + vn(u, v, 32, seed + 2) * 0.2;
/** One organic island (ground_mats.py patches): Gaussian blob, value > .5 inside. `nz` is the per-pixel
 *  wobble field (vn at n=12) — the island's height varies across it, like the Python version. */
interface Blob { cu: number; cv: number; r: number; el: number }
function blobField(blobs: readonly Blob[], u: number, v: number, nz: number): number {
  let m = 0;
  for (const b of blobs) {
    const dx = (u - b.cu) / b.el, dy = (v - b.cv) * b.el;
    const d2 = dx * dx + dy * dy;
    if (d2 > 9 * b.r * b.r) continue; // exp is negligible past 3 radii
    const val = Math.exp(-d2 / (b.r * b.r) * 0.69) * (0.8 + 0.45 * nz);
    if (val > m) m = val;
  }
  return m;
}
/** Deterministic island list (ground_mats.py patches): n blobs fully inside the tile. */
function makeBlobs(seed: number, n: number, rr: readonly [number, number]): Blob[] {
  const r = rng(seed);
  const out: Blob[] = [];
  for (let k = 0; k < n; k++) {
    const rad = rr[0] + r() * (rr[1] - rr[0]);
    const m = rad * 1.25 + 0.035;
    if (m >= 0.5) continue;
    const cu = m + r() * (1 - 2 * m), cv = m + r() * (1 - 2 * m);
    out.push({ cu, cv, r: rad, el: 0.7 + r() * 0.6 });
  }
  return out;
}
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (e0: number, e1: number, x: number): number => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

// ---- slope light ----------------------------------------------------------------
// Cel light model for one slope: 5 quantized bands from the uphill edge (bright) to the downhill
// edge/corner (dark), a darker crease hugging the downhill edge(s), a light rim on the uphill edge(s).
// Quantized (not a smooth gradient) so the tile keeps the flat art's solid-cel look; the bands are
// blended over a narrow smoothstep so the steps read as soft light, not stripes. Strength matches the
// drop-edge relief (terrainDropRelief: 0.22-0.34 cut, 0.085 bevel). A ramp is one tilted plane (one
// 1D band function); a wedge is two triangles split on the fold diagonal (low corner to high corner),
// each shaded by its own downhill axis — the fold reads as a crease where the gradient turns.
function band(a: number): number {
  const LEVELS = [1.14, 1.07, 1.0, 0.93, 0.86];
  const x = clamp01(a) * 4;
  const i = Math.min(3, Math.floor(x));
  const f = sstep(0.45, 0.55, x - i); // narrow blend: mostly flat cel bands, ~3px soft steps at 2x
  return LEVELS[i]! * (1 - f) + LEVELS[i + 1]! * f;
}
export function slopeLight(kind: "ramp" | "wedge", dir: number, u: number, v: number): number {
  const d = dir & 3;
  let a: number, b: number;
  if (kind === "ramp") {
    a = d === 0 ? u : d === 1 ? v : d === 2 ? 1 - u : 1 - v;
    b = a;
  } else if (d === 0) { a = 1 - u; b = 1 - v; }
  else if (d === 1) { a = u; b = 1 - v; }
  else if (d === 2) { a = u; b = v; }
  else { a = 1 - u; b = v; }
  // t = 0 uphill, 1 downhill (ramp: one axis; wedge: mean of the two axes toward the low corner).
  const downEdge = kind === "ramp" ? 1 - a : Math.min(1 - a, 1 - b);
  const upEdge = kind === "ramp" ? a : Math.min(a, b);
  let L = kind === "ramp" ? band(a) : a >= b ? band(a) : band(b);
  L *= 1 - 0.16 * (1 - sstep(0, 0.09, downEdge)); // downhill crease
  L *= 1 + 0.05 * (1 - sstep(0, 0.07, upEdge)); // uphill rim
  return Math.max(0.7, Math.min(1.2, L));
}

// ---- tone field ---------------------------------------------------------------
interface FieldSpec {
  hi: Blob[]; sh: Blob[];
  snow?: Blob[]; soil?: Blob[]; damp?: Blob[]; wet?: Blob[]; earth?: Blob[];
}
function fieldSpec(mat: GroundMaterial, season: number): FieldSpec {
  const seed = SEED[mat];
  const [nh, ns] = TONE_N[mat];
  const spec: FieldSpec = { hi: makeBlobs(seed * 1000 + 50, nh, [0.05, 0.12]), sh: makeBlobs(seed * 1000 + 60, ns, [0.05, 0.12]) };
  if (mat === "grass" && season === 2) spec.snow = makeBlobs(seed * 1000 + 900, 2, [0.08, 0.12]);
  if (mat === "rock" && season === 2) spec.snow = makeBlobs(seed * 1000 + 580, 1, [0.06, 0.14]);
  if (mat === "forest") spec.soil = makeBlobs(seed * 1000 + 310, 3, [0.05, 0.11]);
  if (mat === "dirt" && season === 3) spec.damp = makeBlobs(seed * 1000 + 2950, 2, [0.05, 0.1]);
  if (mat === "sand" && season === 3) spec.damp = makeBlobs(seed * 1000 + 4150, 2, [0.05, 0.1]);
  if (mat === "mud") spec.wet = makeBlobs(seed * 1000 + 680, 3, [0.03, 0.06]);
  if (mat === "snow" && season === 3) spec.earth = makeBlobs(seed * 1000 + 7950, 2, [0.05, 0.1]);
  return spec;
}
/** Tone colours as RGBA, cached per (material, season) — fieldColor runs per pixel, so no hex parsing there. */
const toneCache = new Map<string, readonly [RGBA, RGBA, RGBA, RGBA]>();
function toneRgb(mat: GroundMaterial, season: number): readonly [RGBA, RGBA, RGBA, RGBA] {
  const key = `${mat}|${season}`;
  let t = toneCache.get(key);
  if (!t) {
    const p = PAL[mat][season]!;
    t = [hx(p.t[0]), hx(p.t[1]), hx(p.t[2]), hx(p.t[3])];
    toneCache.set(key, t);
  }
  return t;
}
/** One tone-field pixel (ground_mats.py tone() + the material's field extras), unlit. */
function fieldColor(mat: GroundMaterial, season: number, spec: FieldSpec, u: number, v: number): RGBA {
  const pal = PAL[mat][season]!;
  const t = toneRgb(mat, season);
  const seed = SEED[mat];
  const F = fine(u, v, seed);
  const hi = blobField(spec.hi, u, v, vn(u, v, 12, seed + 53)), sh = blobField(spec.sh, u, v, vn(u, v, 12, seed + 63));
  const inHi = hi > 0.5, inSh = sh > 0.5 && !inHi;
  let c: RGBA = t[1]!;
  if (inHi) c = t[0]!;
  else if (inSh) c = t[2]!;
  else if (F < 0.33) c = t[2]!;
  else if (F > 0.67) c = t[0]!;
  if (inHi && F < 0.35) c = t[1]!;
  if (inSh && F < 0.37) c = t[3]!;
  // Material field extras (same order as the Python painters: after the tone).
  if (mat === "grass" && season === 2 && pal.snow) {
    const sn = blobField(spec.snow!, u, v, vn(u, v, 12, seed + 903));
    if (sn > 0.78) c = hx(pal.snow[0]!);
    else if (sn > 0.5) c = hx(pal.snow[1]!);
    if (vn(u, v, 22, 13) > 0.9) c = hx(pal.frost!);
  } else if (mat === "dirt" && season === 3 && pal.damp) {
    if (blobField(spec.damp!, u, v, vn(u, v, 12, seed + 2953)) > 0.55) c = hx(pal.damp);
  } else if (mat === "dirt" && season === 2 && pal.frost) {
    if (vn(u, v, 26, 29) > 0.9) c = hx(pal.frost);
  } else if (mat === "forest" && pal.soil) {
    const so = blobField(spec.soil!, u, v, vn(u, v, 12, seed + 313));
    if (season === 2) { if (so > 0.78) c = hx(pal.soil[0]!); else if (so > 0.5 && so < 0.62) c = t[2]!; }
    else if (so > 0.75) c = hx(pal.soil[1]!);
    else if (so > 0.5) c = hx(pal.soil[0]!);
  } else if (mat === "sand") {
    const rip = Math.sin((u * 2 + v * 3) * 6.2832 + vn(u, v, 3, 412) * 9);
    if (rip > 0.93 && vn(u, v, 4, 413) > 0.45) c = t[2]!;
    if (season === 3 && pal.wet && blobField(spec.damp!, u, v, vn(u, v, 12, seed + 4153)) > 0.55) c = hx(pal.wet);
    if (season === 2 && pal.frost && vn(u, v, 24, 47) > 0.91) c = hx(pal.frost);
  } else if (mat === "rock" && season === 2 && pal.snow) {
    const sn = blobField(spec.snow!, u, v, vn(u, v, 12, seed + 903));
    if (sn > 0.7) c = hx(pal.snow[0]!);
    else if (sn > 0.5) c = hx(pal.snow[1]!);
  } else if (mat === "mud" && pal.wet) {
    if (blobField(spec.wet!, u, v, vn(u, v, 12, seed + 683)) > 0.55) c = hx(pal.wet);
    if (season === 2 && vn(u, v, 26, 69) > 0.9) c = hx("#e8eff8");
  } else if (mat === "snow" && season === 3 && pal.earth) {
    const ea = blobField(spec.earth!, u, v, vn(u, v, 12, seed + 7953));
    if (ea > 0.72) c = hx(pal.earth[0]!);
    else if (ea > 0.5) c = hx(pal.earth[1]!);
    else if (ea > 0.4) c = hx(pal.slush!);
  }
  return c;
}
/** Diamond membership + uv for a cell pixel (1x units; the shader diamond is 64x32 at (34,18), the flat
 *  art's ~1.06 overshoot keeps the painted edge outside the shader's clip, so no transparent fringe). */
function cellUv(x: number, y: number, scale: number): { u: number; v: number } | undefined {
  const sx = x / scale - 34, sy = y / scale - 18;
  if (Math.abs(sx) / 32 + Math.abs(sy) / 16 > 1.06) return undefined;
  return { u: (sx / 32 + sy / 16) / 2 + 0.5, v: (sy / 16 - sx / 32) / 2 + 0.5 };
}
/** Tone field for one (material, season) at one scale, cached (shared by all 8 shapes of the tile). */
const fieldCache = new Map<string, Uint8ClampedArray>();
function getField(mat: GroundMaterial, season: number, scale: number): Uint8ClampedArray {
  const key = `${mat}|${season}|${scale}`;
  let f = fieldCache.get(key);
  if (f) return f;
  const w = TASK410_CELL_W * scale, h = TASK410_CELL_H * scale;
  const px = new Px(w, h);
  const spec = fieldSpec(mat, season);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const uv = cellUv(x, y, scale);
    if (uv) px.set(x, y, fieldColor(mat, season, spec, uv.u, uv.v));
  }
  f = px.data;
  fieldCache.set(key, f);
  return f;
}

// ---- decorations (uv space, ground_paint.py shapes at 1x px, scaled) -----------------
const toPx = (u: number, v: number, scale: number): [number, number] => [34 * scale + (u - v) * 32 * scale, 18 * scale + (u + v - 1) * 16 * scale];
function pointInPoly(x: number, y: number, pts: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!, [xj, yj] = pts[j]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function poly(px: Px, pts: readonly (readonly [number, number])[], fill: RGBA, outline: RGBA | null = OUTLINE): void {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  minX = Math.floor(minX); minY = Math.floor(minY); maxX = Math.ceil(maxX); maxY = Math.ceil(maxY);
  px.shape(minX, minY, maxX - minX + 1, maxY - minY + 1, (x, y) => pointInPoly(x + 0.5, y + 0.5, pts), fill, outline);
}
function blobPts(cx: number, cy: number, rx: number, ry: number, seed: number, wob = 0.18): [number, number][] {
  const r = rng(seed);
  const ph = [r() * 6.28, r() * 6.28];
  const pts: [number, number][] = [];
  for (let k = 0; k < 14; k++) {
    const a = (6.2832 * k) / 14;
    const rr = 1 + wob * (0.6 * Math.sin(2 * a + ph[0]!) + 0.4 * Math.sin(3 * a + ph[1]!));
    pts.push([cx + Math.cos(a) * rx * rr, cy + Math.sin(a) * ry * rr]);
  }
  return pts;
}
/** Poisson-ish uv scatter with a margin from the tile edges (ground_core.py Scatter). */
function scatter(seed: number, n: number, mind: number, margin: number): [number, number][] {
  const r = rng(seed);
  const pts: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    for (let t = 0; t < 60; t++) {
      const u = margin + r() * (1 - 2 * margin), v = margin + r() * (1 - 2 * margin);
      if (pts.some(([a, b]) => (u - a) ** 2 + (v - b) ** 2 < mind * mind)) continue;
      pts.push([u, v]);
      break;
    }
  }
  return pts;
}
interface DecoCtx { px: Px; ox: number; oy: number; s: number; lightAt: (u: number, v: number) => number }
function dTuft(d: DecoCtx, u: number, v: number, cols: readonly string[], seed: number, h = 4, n = 5): void {
  const r = rng(seed);
  const [bx, by] = toPx(u, v, d.s);
  const x = d.ox + bx, y = d.oy + by;
  const L = d.lightAt(u, v);
  const c = (i: number): RGBA => shade(hx(cols[i % cols.length]!), L);
  d.px.ellipse(x, y + 0.3 * d.s, 2.6 * 0.55 * d.s + 0.6, 0.75 * d.s, c(2), null);
  for (let k = 0; k < n; k++) {
    const f = n > 1 ? k / (n - 1) - 0.5 : 0;
    const x0 = x + f * 2.6 * d.s;
    const lean = f * 1.6 + (r() - 0.5) * 0.8;
    const hh = h * (1 - Math.abs(f) * 0.45) * (0.85 + r() * 0.25) * d.s;
    const col = Math.abs(f) < 0.2 ? c(0) : c(k % 2 === 0 ? 1 : 2);
    d.px.tri(Math.round(x0 - 0.75 * d.s), Math.round(y), Math.round(x0 + 0.75 * d.s), Math.round(y), Math.round(x0 + lean * d.s), Math.round(y - hh), col, null);
  }
}
function dPebble(d: DecoCtx, u: number, v: number, cols: readonly string[], ol: string, seed: number, r0 = 0.025): void {
  const [bx, by] = toPx(u, v, d.s);
  const x = d.ox + bx, y = d.oy + by;
  const L = d.lightAt(u, v);
  const pts = blobPts(x, y, r0 * 32 * d.s, r0 * 32 * d.s, seed);
  poly(d.px, pts.map(([px, py]) => [px, py] as [number, number]), shade(hx(ol), L));
  const inner = blobPts(x, y, r0 * 30 * d.s, r0 * 30 * d.s, seed + 1);
  poly(d.px, inner, shade(hx(cols[1]!), L), null);
  const hl = blobPts(x - r0 * 9 * d.s, y - r0 * 5 * d.s, r0 * 10 * d.s, r0 * 8 * d.s, seed + 2);
  poly(d.px, hl, shade(hx(cols[0]!), L), null);
}
function dLeaf(d: DecoCtx, u: number, v: number, col: string, ol: string, rot: number, size = 1.6): void {
  const [bx, by] = toPx(u, v, d.s);
  const x = d.ox + bx, y = d.oy + by;
  const L = d.lightAt(u, v);
  const ca = Math.cos(rot), sa = Math.sin(rot);
  const Ll = size * d.s, Wd = Ll * 0.42;
  const P = (a: number, b: number): [number, number] => [x + a * ca - b * sa, y + (a * sa + b * ca) * 0.62];
  const shape = [P(-Ll, 0), P(-Ll * 0.4, -Wd), P(Ll * 0.35, -Wd * 0.9), P(Ll, 0), P(Ll * 0.35, Wd * 0.9), P(-Ll * 0.4, Wd)];
  poly(d.px, shape, shade(hx(col), L));
  const [vx0, vy0] = P(-Ll * 0.8, 0), [vx1, vy1] = P(Ll * 0.7, 0);
  d.px.line(Math.round(vx0), Math.round(vy0), Math.round(vx1), Math.round(vy1), shade(hx(ol), L));
}
function dFlower(d: DecoCtx, u: number, v: number, petal: string, eye: string, r0 = 0.9): void {
  const [bx, by] = toPx(u, v, d.s);
  const x = d.ox + bx, y = d.oy + by;
  const L = d.lightAt(u, v);
  for (let k = 0; k < 5; k++) {
    const a = (6.2832 * k) / 5 - 1.57;
    d.px.ellipse(x + Math.cos(a) * r0 * 0.9 * d.s, y + Math.sin(a) * r0 * 0.6 * d.s, r0 * 0.62 * d.s, r0 * 0.5 * d.s, shade(hx(petal), L), null);
  }
  d.px.ellipse(x, y, r0 * 0.45 * d.s, r0 * 0.38 * d.s, shade(hx(eye), L), null);
}
function dCrack(d: DecoCtx, u: number, v: number, col: string, seed: number, len = 0.2): void {
  const r = rng(seed);
  let a = r() * 6.28;
  let cu = u, cv = v;
  const L = d.lightAt(u, v);
  let px0 = d.ox + toPx(cu, cv, d.s)[0], py0 = d.oy + toPx(cu, cv, d.s)[1];
  for (let k = 0; k < 5; k++) {
    a += (r() - 0.5) * 1.4;
    cu += Math.cos(a) * len / 5; cv += Math.sin(a) * len / 5;
    const [nx, ny] = toPx(cu, cv, d.s);
    d.px.line(Math.round(px0), Math.round(py0), Math.round(d.ox + nx), Math.round(d.oy + ny), shade(hx(col), L));
    px0 = d.ox + nx; py0 = d.oy + ny;
  }
}
function dSparkle(d: DecoCtx, u: number, v: number, col: string, s0 = 1): void {
  const [bx, by] = toPx(u, v, d.s);
  const x = d.ox + bx, y = d.oy + by;
  const L = d.lightAt(u, v);
  const c = shade(hx(col), L);
  poly(d.px, [[x - 1.1 * s0 * d.s, y], [x, y - 0.35 * s0 * d.s], [x + 1.1 * s0 * d.s, y], [x, y + 0.35 * s0 * d.s]], c, null);
  poly(d.px, [[x, y - 1.1 * s0 * d.s], [x + 0.3 * s0 * d.s, y], [x, y + 1.1 * s0 * d.s], [x - 0.3 * s0 * d.s, y]], c, null);
}
function dBlob(d: DecoCtx, u: number, v: number, col: string, seed: number, r0 = 0.06, sq = 1): void {
  const [bx, by] = toPx(u, v, d.s);
  const L = d.lightAt(u, v);
  poly(d.px, blobPts(d.ox + bx, d.oy + by, r0 * 32 * d.s, r0 * 32 * d.s * sq, seed), shade(hx(col), L), null);
}
function dSlab(d: DecoCtx, u: number, v: number, cols: readonly string[], seed: number, r0 = 0.09): void {
  const [bx, by] = toPx(u, v, d.s);
  const x = d.ox + bx, y = d.oy + by;
  const L = d.lightAt(u, v);
  const pts = blobPts(x, y, r0 * 32 * d.s, r0 * 32 * d.s * 0.85, seed);
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const grow = (k: number): [number, number][] => pts.map(([px, py]) => { const dx = px - cx, dy = py - cy, l = Math.hypot(dx, dy) || 1; return [px + (dx / l) * k, py + (dy / l) * k] as [number, number]; });
  const shrink = (k: number, dy: number): [number, number][] => pts.map(([px, py]) => [cx + (px - cx) * k, cy + (py - cy) * k + dy] as [number, number]);
  poly(d.px, grow(0.6 * d.s), shade(hx(cols[3]!), L), null);
  poly(d.px, pts, shade(hx(cols[2]!), L), null);
  poly(d.px, shrink(0.55, -0.5 * d.s), shade(hx(cols[0]!), L), null);
}
function dPuddle(d: DecoCtx, u: number, v: number, cols: readonly string[], rim: string, seed: number, r0 = 0.1): void {
  const [bx, by] = toPx(u, v, d.s);
  const x = d.ox + bx, y = d.oy + by;
  const L = d.lightAt(u, v);
  const pts = blobPts(x, y, r0 * 32 * d.s, r0 * 32 * d.s * 0.8, seed);
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const grow = (k: number): [number, number][] => pts.map(([px, py]) => { const dx = px - cx, dy = py - cy, l = Math.hypot(dx, dy) || 1; return [px + (dx / l) * k, py + (dy / l) * k] as [number, number]; });
  poly(d.px, grow(0.6 * d.s), shade(hx(rim), L), null);
  poly(d.px, pts, shade(hx(cols[1]!), L), null);
  poly(d.px, pts.map(([px, py]) => [cx + (px - cx) * 0.7, cy + (py - cy) * 0.7 + r0 * 6 * d.s] as [number, number]), shade(hx(cols[2]!), L), null);
  d.px.line(Math.round(x - r0 * 38 * d.s), Math.round(y - r0 * 10 * d.s), Math.round(x + r0 * 42 * d.s), Math.round(y - r0 * 14 * d.s), shade(hx(cols[0]!), L));
}

// ---- per-material decorations -------------------------------------------------
// Same positions for all 8 shapes of a (material, season) tile — the light is what differs per
// shape, so neighbouring slopes share their ground features and only the shading changes.
function paintDecorations(d: DecoCtx, mat: GroundMaterial, season: number): void {
  const pal = PAL[mat][season]!;
  const seed = SEED[mat] * 1000 + season * 100;
  const r = rng(seed + 7);
  const leaves = (n: number, size = 1.5): void => {
    if (!pal.leaves) return;
    for (const [u, v] of scatter(seed + 11, n, 0.09, 0.1))
      dLeaf(d, u, v, pal.leaves[Math.floor(r() * pal.leaves.length)]!, pal.leafol!, r() * 6.28, size * (0.8 + r() * 0.4));
  };
  const tufts = (n: number, cols: readonly string[], h: number, s0: number): void => {
    for (const [u, v] of scatter(seed + s0, n, 0.15, 0.13))
      dTuft(d, u, v, cols, seed + s0 + 10, h * (0.85 + r() * 0.3), 3 + Math.floor(r() * 3));
  };
  const sparkles = (n: number, col: string): void => {
    for (const [u, v] of scatter(seed + 31, n, 0.1, 0.12)) dSparkle(d, u, v, col, 0.8);
  };
  switch (mat) {
    case "grass": {
      if (season === 0) {
        tufts(3, pal.blade!, 4, 11);
        const [cu, cv] = scatter(seed + 31, 1, 0.1, 0.2)[0] ?? [0.5, 0.5];
        for (let k = 0; k < 1 + Math.floor(r() * 5); k++) {
          const u = cu + (r() - 0.5) * 0.18, v = cv + (r() - 0.5) * 0.18;
          if (u < 0.12 || u > 0.88 || v < 0.12 || v > 0.88) continue;
          const [pe, ey] = pal.fl![Math.floor(r() * pal.fl!.length)]!;
          dFlower(d, u, v, pe, ey, 0.8 + r() * 0.25);
        }
        for (const [u, v] of scatter(seed + 41, 3, 0.1, 0.15)) dBlob(d, u, v, pal.clover!, seed + 51, 0.022);
      } else if (season === 1) leaves(6);
      else if (season === 2) { tufts(3, pal.blade!, 3.8, 11); sparkles(3, "#ffffff"); }
      else {
        for (const [u, v] of scatter(seed + 11, 3, 0.12, 0.12)) {
          const [pe, ey] = pal.fl![Math.floor(r() * pal.fl!.length)]!;
          dFlower(d, u, v, pe, ey, 0.75 + r() * 0.2);
        }
        for (const [u, v] of scatter(seed + 21, 3, 0.1, 0.12)) dBlob(d, u, v, pal.bud!, seed + 61, 0.014);
        tufts(3, pal.blade!, 2.7, 31);
      }
      break;
    }
    case "dirt": {
      for (const [u, v] of scatter(seed + 11, 3, 0.12, 0.12))
        dPebble(d, u, v, pal.peb!, pal.ol, seed + 21 + Math.floor(r() * 100), 0.018 + r() * 0.016);
      if (r() < 0.6) { const [u, v] = scatter(seed + 41, 1, 0.1, 0.3)[0]!; dCrack(d, u, v, pal.t[3], seed + 51, 0.22); }
      if (season === 0 && pal.sprout) tufts(2, pal.sprout, 2.6, 61);
      else if (season === 1) leaves(2);
      else if (season === 2 && pal.snow) {
        for (const [u, v] of scatter(seed + 61, 2, 0.2, 0.25)) dBlob(d, u, v, pal.snow[1]!, seed + 71, 0.06 + r() * 0.04);
        sparkles(1, "#ffffff");
      } else if (season === 3 && pal.sprout) tufts(4, pal.sprout, 2.2, 61);
      break;
    }
    case "forest": {
      leaves(season === 1 ? 16 : season === 2 ? 6 : 12);
      if (season !== 2 && pal.fern && r() < 0.5) {
        const [u, v] = scatter(seed + 51, 1, 0.1, 0.25)[0]!;
        const [bx, by] = toPx(u, v, d.s);
        const L = d.lightAt(u, v);
        for (let j = 0; j < 5; j++) {
          const a = -2.6 + j * 0.55, len = (4.2 - Math.abs(j - 2) * 0.5) * d.s;
          d.px.line(Math.round(d.ox + bx), Math.round(d.oy + by), Math.round(d.ox + bx + Math.cos(a) * len), Math.round(d.oy + by + Math.sin(a) * len * 0.7), shade(hx(pal.fern[1]!), L));
        }
      }
      if (season !== 2 && r() < 0.3) {
        const [u, v] = scatter(seed + 61, 1, 0.1, 0.25)[0]!;
        const [bx, by] = toPx(u, v, d.s);
        const L = d.lightAt(u, v);
        const x = d.ox + bx, y = d.oy + by;
        d.px.ellipse(x, y + 0.4 * d.s, 1.6 * d.s, 0.6 * d.s, shade(hx("#4a3a34"), L), null);
        d.px.tri(Math.round(x - 0.6 * d.s), Math.round(y), Math.round(x + 0.6 * d.s), Math.round(y), Math.round(x + 0.5 * d.s), Math.round(y - 2 * d.s), shade(hx("#f6ead2"), L), null);
        d.px.tri(Math.round(x - 0.6 * d.s), Math.round(y), Math.round(x + 0.6 * d.s), Math.round(y), Math.round(x - 0.5 * d.s), Math.round(y - 2 * d.s), shade(hx("#f6ead2"), L), null);
        d.px.ellipse(x, y - 2.3 * d.s, 1.9 * d.s, 1.25 * d.s, shade(hx(season === 0 ? "#ec5a4d" : "#e0a868"), L));
      }
      if (r() < 0.4) { const [u, v] = scatter(seed + 71, 1, 0.1, 0.2)[0]!; dCrack(d, u, v, "#6a4632", seed + 81, 0.14); }
      if (season === 2) { sparkles(2, "#ffffff"); }
      else if (season === 3 && pal.bloss) {
        for (const [u, v] of scatter(seed + 91, 3, 0.1, 0.12)) {
          const b = pal.bloss[Math.floor(r() * pal.bloss.length)] as readonly [string, string];
          dFlower(d, u, v, b[0], b[1], 0.7);
        }
      }
      break;
    }
    case "sand": {
      if (r() < 0.6) {
        for (const [u, v] of scatter(seed + 11, 2, 0.2, 0.2)) {
          const [bx, by] = toPx(u, v, d.s);
          const x = d.ox + bx, y = d.oy + by;
          const L = d.lightAt(u, v);
          const s0 = (0.9 + r() * 0.3) * d.s;
          d.px.ellipse(x, y, 1.8 * s0, 1.2 * s0, shade(hx(pal.shell![2]!), L));
          d.px.ellipse(x, y - 0.15 * d.s, 1.45 * s0, 0.95 * s0, shade(hx(pal.shell![1]!), L), null);
          for (const j of [-1, 0, 1]) d.px.line(Math.round(x), Math.round(y + 0.6 * s0), Math.round(x + j * 0.9 * s0), Math.round(y - 0.7 * s0), shade(hx(pal.shell![0]!), L));
        }
      } else {
        for (const [u, v] of scatter(seed + 11, 2, 0.12, 0.12)) dPebble(d, u, v, pal.peb!, pal.ol, seed + 21, 0.02);
      }
      sparkles(2, "#ffffff");
      if (season === 1) leaves(1);
      else if (season === 2 && pal.snow) for (const [u, v] of scatter(seed + 61, 1, 0.2, 0.25)) dBlob(d, u, v, pal.snow[1]!, seed + 71, 0.08);
      else if (season === 3 && pal.bloss) for (const [u, v] of scatter(seed + 61, 2, 0.12, 0.12)) dFlower(d, u, v, (pal.bloss as readonly string[])[0]!, (pal.bloss as readonly string[])[1]!, 0.75);
      break;
    }
    case "rock": {
      for (const [u, v] of scatter(seed + 11, 1 + Math.floor(r() * 2), 0.2, 0.2)) dSlab(d, u, v, pal.t, seed + 21, 0.07 + r() * 0.04);
      if (r() < 0.6) { const [u, v] = scatter(seed + 41, 1, 0.1, 0.2)[0]!; dCrack(d, u, v, pal.t[3], seed + 51, 0.1 + r() * 0.04); }
      for (const [u, v] of scatter(seed + 61, 2, 0.12, 0.12)) dPebble(d, u, v, pal.t, pal.ol, seed + 71, 0.018 + r() * 0.012);
      if (season !== 2 && pal.moss) for (const [u, v] of scatter(seed + 81, 2, 0.12, 0.14)) dBlob(d, u, v, pal.moss[1]!, seed + 91, 0.03 + r() * 0.03);
      if (season === 1) leaves(2);
      else if (season === 2) sparkles(1, "#ffffff");
      else if (season === 3 && pal.bloss) for (const [u, v] of scatter(seed + 91, 1, 0.2, 0.25)) dFlower(d, u, v, (pal.bloss as readonly string[])[0]!, (pal.bloss as readonly string[])[1]!, 0.8);
      break;
    }
    case "mud": {
      if (r() < 0.6 && pal.pud) { const [u, v] = scatter(seed + 11, 1, 0.2, 0.25)[0]!; dPuddle(d, u, v, pal.pud, pal.t[3], seed + 21, 0.08 + r() * 0.05); }
      if (r() < 0.4) {
        const [bx, by] = toPx(0.32, 0.38, d.s);
        const L = d.lightAt(0.32, 0.38);
        for (let k = 0; k < 3; k++) {
          const x = d.ox + bx + k * 0.14 * 32 * d.s, y = d.oy + by + (k * 0.1 + (k % 2) * 0.06) * 16 * d.s;
          d.px.ellipse(x, y, 0.03 * 32 * d.s, 0.03 * 32 * d.s * 0.6, shade(hx(pal.t[2]), L), null);
        }
      }
      if (season === 0 && pal.reed) tufts(1, [pal.reed[0]!, pal.reed[1]!, "#4a6030"], 5.5, 51);
      else if (season === 1) leaves(2);
      else if (season === 2 && pal.snow) for (const [u, v] of scatter(seed + 61, 1, 0.2, 0.25)) dBlob(d, u, v, pal.snow[1]!, seed + 71, 0.06);
      else if (season === 3 && pal.sprout) tufts(2, pal.sprout, 2.2, 51);
      break;
    }
    case "snow": {
      if (r() < 0.5 && pal.peb) {
        const [u, v] = scatter(seed + 11, 1, 0.2, 0.25)[0]!;
        dPebble(d, u, v, pal.peb, pal.ol, seed + 21, 0.055);
        dBlob(d, u - 0.012, v - 0.012, pal.t[1], seed + 31, 0.045, 0.7);
      }
      if (r() < 0.4) {
        const L = d.lightAt(0.3, 0.6);
        for (let k = 0; k < 5; k++) {
          const [bx, by] = toPx(0.28 + k * 0.1, 0.62 - k * 0.06, d.s);
          d.px.ellipse(d.ox + bx, d.oy + by, 0.7 * d.s, 0.45 * d.s, shade(hx(pal.t[3]), L), null);
          d.px.ellipse(d.ox + bx + 1.1 * d.s, d.oy + by - 0.4 * d.s, 0.5 * d.s, 0.35 * d.s, shade(hx(pal.t[3]), L), null);
        }
      }
      sparkles(3, pal.spark!);
      if (season === 1) leaves(2);
      else if (season === 3 && pal.sprout) tufts(2, pal.sprout, 2, 51);
      break;
    }
  }
}

// ---- cell + atlas painting ----------------------------------------------------
/**
 * One slope cell at (ox, oy) in `px` (absolute px coords), at `scale` (1 = 68x52, 2 = 136x104):
 * tone field, slope light ramp, then decorations shaded by the light at their own position.
 */
export function paintSlopeCell(px: Px, ox: number, oy: number, scale: number, mat: GroundMaterial, season: number, kind: "ramp" | "wedge", dir: number): void {
  const w = TASK410_CELL_W * scale, h = TASK410_CELL_H * scale;
  const field = getField(mat, season, scale);
  for (let y = 0; y < h; y++) px.data.set(field.subarray(y * w * 4, (y + 1) * w * 4), ((oy + y) * px.w + ox) * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((oy + y) * px.w + (ox + x)) * 4;
    if (px.data[i + 3] === 0) continue;
    const uv = cellUv(x, y, scale);
    if (!uv) continue;
    const L = slopeLight(kind, dir, uv.u, uv.v);
    px.data[i] = Math.max(0, Math.min(255, Math.round(px.data[i]! * L)));
    px.data[i + 1] = Math.max(0, Math.min(255, Math.round(px.data[i + 1]! * L)));
    px.data[i + 2] = Math.max(0, Math.min(255, Math.round(px.data[i + 2]! * L)));
  }
  paintDecorations({ px, ox, oy, s: scale, lightAt: (u, v) => slopeLight(kind, dir, u, v) }, mat, season);
}

export interface PaintedAtlas { key: string; width: number; height: number; pixels: Uint8ClampedArray }

/**
 * Paint all four season atlases at 2x (136x104 cells, 2040x416). Pure — no DOM, unit-testable.
 * The 1x page is a box downsample of this (downsampleTask410Atlas), like the shipped pipeline.
 */
export function paintTask410Atlases(): PaintedAtlas[] {
  const out: PaintedAtlas[] = [];
  const scale = 2;
  for (let season = 0; season < 4; season++) {
    const px = new Px(TASK410_COLUMNS * TASK410_CELL_W * scale, TASK410_ROWS * TASK410_CELL_H * scale);
    for (let mi = 0; mi < GROUND_PRIORITY.length; mi++) {
      const mat = GROUND_PRIORITY[mi]!;
      for (let shape = 0; shape < 8; shape++) {
        const frame = task410Frame(mi, shape);
        paintSlopeCell(px, (frame % TASK410_COLUMNS) * TASK410_CELL_W * scale, Math.floor(frame / TASK410_COLUMNS) * TASK410_CELL_H * scale,
          scale, mat, season, shape < 4 ? "ramp" : "wedge", shape % 4);
      }
    }
    out.push({ key: TASK410_ATLAS_KEYS[season]!, width: px.w, height: px.h, pixels: px.data });
  }
  return out;
}

/**
 * Box-downsample a 2x atlas to 1x (the shipped pipeline's downs()): 2x2 average, snapped to the
 * nearest of the block's own painted colours (keeps the solid-cel look — no blended edge colours),
 * binary alpha (a >= 128 opaque). Pure.
 */
export function downsampleTask410Atlas(a: PaintedAtlas): PaintedAtlas {
  const w = a.width / 2, h = a.height / 2;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const src: [number, number, number, number][] = [];
    let aSum = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const i = ((2 * y + dy) * a.width + (2 * x + dx)) * 4;
      src.push([a.pixels[i]!, a.pixels[i + 1]!, a.pixels[i + 2]!, a.pixels[i + 3]!]);
      aSum += a.pixels[i + 3]!;
    }
    const oi = (y * w + x) * 4;
    if (aSum / 4 < 128) continue; // stays transparent
    const r = (src[0]![0] + src[1]![0] + src[2]![0] + src[3]![0]) / 4;
    const g = (src[0]![1] + src[1]![1] + src[2]![1] + src[3]![1]) / 4;
    const b = (src[0]![2] + src[1]![2] + src[2]![2] + src[3]![2]) / 4;
    let best = src[0]!, bd = Infinity;
    for (const c of src) {
      if (c[3] === 0) continue;
      const dd = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
      if (dd < bd) { bd = dd; best = c; }
    }
    out[oi] = best[0]; out[oi + 1] = best[1]; out[oi + 2] = best[2]; out[oi + 3] = 255;
  }
  return { key: a.key, width: w, height: h, pixels: out };
}

/** Rasterized pixels -> PNG blob URL (OffscreenCanvas, else a document canvas; undefined when no canvas exists). */
async function canvasToBlobURL(w: number, h: number, pixels: Uint8ClampedArray): Promise<string | undefined> {
  try {
    // TS 5.9 (CI's pinned version) types ImageData's data as Uint8ClampedArray<ArrayBuffer>; our pixels are
    // Uint8ClampedArray<ArrayBufferLike>, so copy into a fresh ArrayBuffer-backed array (once, at load).
    const data = new ImageData(new Uint8ClampedArray(pixels), w, h);
    const OC = (globalThis as { OffscreenCanvas?: typeof OffscreenCanvas }).OffscreenCanvas;
    if (OC) {
      const cv = new OC(w, h); const ctx = cv.getContext("2d");
      if (ctx) { ctx.putImageData(data, 0, 0); if (typeof cv.convertToBlob === "function") return URL.createObjectURL(await cv.convertToBlob({ type: "image/png" })); }
    }
    const doc = (globalThis as { document?: Document }).document;
    if (doc) {
      const cv = doc.createElement("canvas"); cv.width = w; cv.height = h; const ctx = cv.getContext("2d");
      if (!ctx) return undefined;
      ctx.putImageData(data, 0, 0);
      return await new Promise<string | undefined>((res) => cv.toBlob((b) => res(b ? URL.createObjectURL(b) : undefined), "image/png"));
    }
  } catch { /* no canvas in this environment: the caller keeps the manifest's debug path */ }
  return undefined;
}

/**
 * Atlas sources for the four slope atlases: the 2x paint as the scale-2 page, its box downsample as
 * the 1x image (same { url, emissiveUrl, pages } shape as sourcesFromManifest). view.ts merges these
 * over the manifest's placeholder paths before setRegistry, so the registry's slope sprites draw the
 * painted pixels. Returns only the atlases that converted (empty in a canvas-less environment).
 */
export async function task410AtlasSources(): Promise<Map<string, AtlasSource>> {
  const out = new Map<string, AtlasSource>();
  for (const a of paintTask410Atlases()) {
    const lo = downsampleTask410Atlas(a);
    const url = await canvasToBlobURL(lo.width, lo.height, lo.pixels);
    const url2x = await canvasToBlobURL(a.width, a.height, a.pixels);
    if (url) out.set(a.key, { url, emissiveUrl: null, ...(url2x ? { pages: [{ scale: 2, url: url2x }] } : {}) });
  }
  return out;
}
