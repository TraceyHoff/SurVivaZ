// Task 34: dedicated bee / owl / Apiary art, painted at runtime (no PNG files on disk — the snapshot push route
// carries text only, and the pack pipeline cannot ship new binary atlases). The pixels are rasterized here with a
// tiny software canvas (same shape/outline approach as packages/assets/scripts/gen-placeholders.mjs, no deps),
// declared in the pack/task34 fragment (layout only), and turned into blob URLs by task34AtlasSources() — the
// packages/render/src/vehicles/atlas.ts pattern — which view.ts merges into the atlas sources before setRegistry.
// The art is NEW pixels: the bee is a striped insect, the owl has a round face disc + ear tufts + wide eyes, the
// Apiary is a stacked wooden hive. Nothing here tints or scales an existing sheet (the Task 32 crow reuse is gone
// as the primary art: the bee/owl draw their dedicated painted art; sprite_fallbacks.json maps animal_bee /
// animal_owl to animal_crow only as an ADR-485 safety net, used if the painted art is ever missing).
import type { AtlasSource } from "@engine/render";

/** Atlas keys this module paints (also the fragment's atlas keys). */
export const TASK34_ATLAS_KEYS = ["pets_bee", "pets_owl", "decor_apiary"] as const;

type RGBA = readonly [number, number, number, number?];
/** Game-art outline (same dark plum as the placeholder generator). */
const OUTLINE: RGBA = [40, 30, 50];
const SHADOW: RGBA = [0, 0, 0, 70];

/** Small software rasterizer: a pixel buffer with filled-shape helpers. */
export class Px {
  readonly w: number; readonly h: number; readonly data: Uint8ClampedArray;
  constructor(w: number, h: number) { this.w = w; this.h = h; this.data = new Uint8ClampedArray(w * h * 4); }
  set(x: number, y: number, c: RGBA): void {
    x |= 0; y |= 0; if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4; this.data[i] = c[0]; this.data[i + 1] = c[1]; this.data[i + 2] = c[2]; this.data[i + 3] = c[3] ?? 255;
  }
  get(x: number, y: number): readonly [number, number, number, number] {
    x |= 0; y |= 0; if (x < 0 || y < 0 || x >= this.w || y >= this.h) return [0, 0, 0, 0];
    const i = (y * this.w + x) * 4; return [this.data[i]!, this.data[i + 1]!, this.data[i + 2]!, this.data[i + 3]!];
  }
  /** Filled shape via predicate (absolute coords) with a 1px dark outline; outline null = no outline. */
  shape(x0: number, y0: number, w: number, h: number, inside: (x: number, y: number) => boolean, fill: RGBA, outline: RGBA | null = OUTLINE): void {
    for (let y = -2; y < h + 2; y++) for (let x = -2; x < w + 2; x++) {
      if (inside(x0 + x, y0 + y)) this.set(x0 + x, y0 + y, fill);
      else if (outline) {
        let near = false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const) if (inside(x0 + x + dx, y0 + y + dy)) { near = true; break; }
        if (near) this.set(x0 + x, y0 + y, outline);
      }
    }
  }
  ellipse(cx: number, cy: number, rx: number, ry: number, fill: RGBA, outline: RGBA | null = OUTLINE): void {
    this.shape(cx - rx, cy - ry, rx * 2, ry * 2, (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1, fill, outline);
  }
  /** Ellipse rotated by `ang` radians (screen space, y down). */
  ellipseRot(cx: number, cy: number, rx: number, ry: number, ang: number, fill: RGBA, outline: RGBA | null = OUTLINE): void {
    const c = Math.cos(ang), s = Math.sin(ang);
    this.shape(cx - rx - 2, cy - ry - 2, (rx + 2) * 2, (ry + 2) * 2, (x, y) => {
      const dx = x - cx, dy = y - cy; const u = dx * c + dy * s, v = -dx * s + dy * c;
      return (u / rx) ** 2 + (v / ry) ** 2 <= 1;
    }, fill, outline);
  }
  rect(x: number, y: number, w: number, h: number, fill: RGBA, outline: RGBA | null = OUTLINE): void {
    this.shape(x, y, w, h, (a, b) => a >= x && b >= y && a < x + w && b < y + h, fill, outline);
  }
  /** 1px line (DDA). */
  line(x0: number, y0: number, x1: number, y1: number, fill: RGBA): void {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n; i++) this.set(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), fill);
  }
  /** Filled triangle. */
  tri(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, fill: RGBA, outline: RGBA | null = OUTLINE): void {
    const minX = Math.min(x0, x1, x2), maxX = Math.max(x0, x1, x2), minY = Math.min(y0, y1, y2), maxY = Math.max(y0, y1, y2);
    const sign = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number => (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);
    this.shape(minX, minY, maxX - minX + 1, maxY - minY + 1, (x, y) => {
      const d0 = sign(x, y, x0, y0, x1, y1), d1 = sign(x, y, x1, y1, x2, y2), d2 = sign(x, y, x2, y2, x0, y0);
      return !((d0 < 0 || d1 < 0 || d2 < 0) && (d0 > 0 || d1 > 0 || d2 > 0));
    }, fill, outline);
  }
}

const shade = (c: RGBA, k: number): RGBA => [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k), c[3] ?? 255];

/**
 * Screen-space facing unit vectors for the 8 world facings (rows of the creature sheets). The renderer adds the
 * view rotation to the facing when picking a row (ADR-253), so rows are world facings; under the 2:1 dimetric
 * projection world (cos t, sin t) -> screen (cos t - sin t, (cos t + sin t) / 2), i.e. dir 0 (+x, east) reads
 * down-right at 26.6 deg, dir 1 (+x+y, south-east) straight down, dir 2 (+y, south) down-left, dir 3 straight left,
 * dir 5 straight up, dir 7 straight right. Same convention as the placeholder creature atlas (DIRS8).
 */
export const TASK34_DIR_VEC: readonly (readonly [number, number])[] = [
  [0.894, 0.447], [0, 1], [-0.894, 0.447], [-1, 0],
  [-0.894, -0.447], [0, -1], [0.894, -0.447], [1, 0],
];

// ---- bee ------------------------------------------------------------------
// A small striped insect, not a bird: gold abdomen with two black bands, dark head at the facing end, a stinger at
// the back, translucent wings that flap (idle) and six legs that step (walk). Drawn small inside the 64px cell so
// it reads at the game's animal scale (the Task 32 tint had scale 0.5 on the crow sheet).
const BEE_GOLD: RGBA = [240, 192, 64];
const BEE_DARK: RGBA = [38, 32, 28];
const BEE_WING: RGBA = [255, 255, 255, 110];
const BEE_EYE: RGBA = [255, 240, 200];

/** One 64x64 bee cell at (ox, oy): `dir` 0-7 world facing, `frame` 0-3, `walk` = leg-step cycle instead of wing flap. */
export function paintBeeCell(px: Px, ox: number, oy: number, dir: number, frame: number, walk: boolean): void {
  const [dx, dy] = TASK34_DIR_VEC[dir & 7]!;
  const ang = Math.atan2(dy, dx);
  const bob = walk ? (frame % 2 === 0 ? 0 : -1) : frame === 2 ? -1 : 0;
  const cx = ox + 32, cy = oy + 40 + bob;
  // Ground shadow.
  px.ellipse(cx, oy + 53, 9, 3, SHADOW, null);
  // Wings first (behind the body): two translucent ellipses across the body axis, flapping with the frame.
  const flap = walk ? 1 : [0, 1, 2, 1][frame]!;
  const wx = -dy, wy = dx; // perpendicular to the body axis
  for (const s of [-1, 1]) {
    const wcx = cx + wx * 5 * s, wcy = cy - 7 - flap * 2;
    px.ellipseRot(wcx, wcy, 7, 3, ang + s * 0.9, BEE_WING, null);
  }
  // Abdomen: gold ellipse along the facing axis.
  px.ellipseRot(cx, cy, 11, 6.5, ang, BEE_GOLD);
  // Two black bands across the abdomen (clipped to the ellipse, no outline: they are markings, not edges).
  const c = Math.cos(-ang), s = Math.sin(-ang);
  const inBody = (ax: number, ay: number): boolean => {
    const u = (ax - cx) * c - (ay - cy) * s, v = (ax - cx) * s + (ay - cy) * c;
    return (u / 10) ** 2 + (v / 5.5) ** 2 <= 1;
  };
  for (const [lo, hi] of [[-7, -3.5], [1, 4.5]] as const) {
    px.shape(cx - 12, cy - 8, 24, 16, (ax, ay) => {
      const u = (ax - cx) * c - (ay - cy) * s;
      return inBody(ax, ay) && u >= lo && u <= hi;
    }, BEE_DARK, null);
  }
  // Head: dark circle at the facing end, with two pale eyes; stinger at the back.
  const hx = cx + dx * 11, hy = cy + dy * 11;
  px.ellipse(hx, hy, 4.5, 4.5, BEE_DARK);
  for (const s of [-1, 1]) px.set(Math.round(hx - dy * 2 * s + dx * 1.5), Math.round(hy + dx * 2 * s + dy * 1.5), BEE_EYE);
  const sx = cx - dx * 12, sy = cy - dy * 12;
  px.tri(sx, sy, sx - dx * 4 - dy * 2, sy - dy * 4 + dx * 2, sx - dx * 4 + dy * 2, sy - dy * 4 - dx * 2, BEE_DARK, null);
  // Antennae: two short lines forward from the head.
  for (const s of [-1, 1]) px.line(Math.round(hx + dx * 2), Math.round(hy + dy * 2), Math.round(hx + dx * 6 - dy * 2 * s), Math.round(hy + dy * 6 + dx * 2 * s), BEE_DARK);
  // Legs: three short lines under the body; walk steps them, idle tucks them.
  for (let i = -1; i <= 1; i++) {
    const step = walk ? (frame % 2 === 0 ? (i % 2 === 0 ? 1 : -1) : (i % 2 === 0 ? -1 : 1)) : 0;
    const lx = cx + i * 5 + dx * step, ly = cy + 5;
    px.line(Math.round(lx), Math.round(ly), Math.round(lx - dy * 2), Math.round(ly + 3), BEE_DARK);
  }
}

// ---- owl ------------------------------------------------------------------
// An owl, not a crow: upright brown body, round pale face disc with two wide dark eyes and a small orange beak,
// ear tufts on top, folded wings at the sides. The face turns with the facing; from behind (dirs 4-6) the disc is
// hidden and only the tufted back of the head shows.
const OWL_BROWN: RGBA = [138, 107, 74];
const OWL_DARK: RGBA = [107, 79, 51];
const OWL_BELLY: RGBA = [201, 164, 106];
const OWL_FACE: RGBA = [242, 232, 213];
const OWL_EYE: RGBA = [28, 22, 18];
const OWL_BEAK: RGBA = [232, 140, 60];

/** One 64x64 owl cell at (ox, oy): `dir` 0-7 world facing, `frame` 0-3, `walk` = stepping / wings-out cycle. */
export function paintOwlCell(px: Px, ox: number, oy: number, dir: number, frame: number, walk: boolean): void {
  const [dx, dy] = TASK34_DIR_VEC[dir & 7]!;
  const bob = frame % 2 === 0 ? 0 : -1;
  const cx = ox + 32, cy = oy + 36 + bob;
  const facingAway = dy < -0.3; // dirs 4-6: the owl's back is to the camera
  // Ground shadow.
  px.ellipse(cx, oy + 54, 10, 3, SHADOW, null);
  // Tail: short dark fan below the body, toward the back.
  px.tri(cx - dx * 4 - 4, cy + 12, cx - dx * 10, cy + 18, cx - dx * 4 + 4, cy + 12, OWL_DARK, null);
  // Folded wings at the body sides (walk frames hold them a touch out).
  const out = walk && frame % 2 === 1 ? 1 : 0;
  px.ellipse(cx - 12 - out, cy + 2, 4.5, 9, OWL_DARK);
  px.ellipse(cx + 12 + out, cy + 2, 4.5, 9, OWL_DARK);
  // Body: upright oval + lighter belly (belly is a front feature: hidden from behind).
  px.ellipse(cx, cy, 13, 16, OWL_BROWN);
  if (!facingAway) px.ellipse(cx + dx * 2, cy + 7, 8, 7, OWL_BELLY, null);
  // Ear tufts: two dark triangles on top, leaning with the facing.
  for (const s of [-1, 1]) {
    const tx = cx + s * 7 + dx * 2;
    px.tri(tx - 3, cy - 13, tx + 3, cy - 13, tx + s * 1 + dx * 3, cy - 20, OWL_DARK);
  }
  if (!facingAway) {
    // Round face disc, turned toward the facing.
    const fx = cx + dx * 4, fy = cy - 4 + dy * 3;
    px.ellipse(fx, fy, 9.5, 8.5, OWL_FACE);
    // Two wide eyes on the disc, either side of the facing axis.
    for (const s of [-1, 1]) {
      const ex = fx - dy * 4 * s + dx * 1, ey = fy + dx * 4 * s + dy * 1;
      px.ellipse(ex, ey, 2.6, 3, OWL_EYE, null);
      px.set(Math.round(ex - 1), Math.round(ey - 1), [255, 255, 255]);
    }
    // Small orange beak below the eyes.
    px.tri(fx - 2 + dx * 2, fy + 4, fx + 2 + dx * 2, fy + 4, fx + dx * 3, fy + 8, OWL_BEAK, null);
  } else {
    // Back of the head: a darker crown over the body top.
    px.ellipse(cx, cy - 10, 8, 5, OWL_DARK, null);
  }
  // Feet: two orange talon lines at the bottom.
  for (const s of [-1, 1]) {
    const step = walk ? (frame % 2 === 0 ? s : -s) : 0;
    px.line(Math.round(cx + s * 5), Math.round(cy + 15), Math.round(cx + s * 5 + step), Math.round(cy + 18), OWL_BEAK);
  }
}

// ---- apiary ---------------------------------------------------------------
// A beehive that reads as a beehive: three stacked wooden boxes (Langstroth hive) in warm wood tones, tapering
// upward, with a wider roof cap, plank lines, a dark entrance hole with a landing ledge, and a few bees buzzing
// around the roof. Compared against the neighbours in the building pack (dec_barrel_storage, dec_feeding_trough,
// salt_barrel): same 128px frame, same dark-plum outline, same warm palette — but a stacked-box silhouette no
// other storage piece has. Damage stages: 0 intact, 1 hairline cracks, 2 cracks + a shifted box, 3 tipped top
// box + fallen plank + heavy cracks (wood darkens with the stage, like the placeholder building atlas).
const WOOD: RGBA = [185, 138, 78];
const WOOD_MID: RGBA = [161, 118, 58];
const WOOD_DARK: RGBA = [122, 79, 38];
const WOOD_LIGHT: RGBA = [201, 160, 106];
const HIVE_HOLE: RGBA = [46, 32, 22];

/** One 128x128 Apiary cell at (ox, oy): `rot` 0 = front, 1 = side; `stage` 0-3 damage. */
export function paintApiaryCell(px: Px, ox: number, oy: number, rot: number, stage: number): void {
  const k = 1 - stage * 0.16;
  const narrow = rot === 1; // side view: the stack reads narrower
  const cx = ox + 64;
  const wBot = narrow ? 52 : 72, wMid = narrow ? 46 : 64, wTop = narrow ? 40 : 56;
  // Ground shadow + base platform.
  px.ellipse(cx, oy + 108, 34, 5, SHADOW, null);
  px.rect(cx - 42, oy + 100, 84, 8, shade(WOOD_DARK, k));
  // Stack: bottom / middle / top boxes (top shifts when badly damaged).
  const topShift = stage >= 3 ? 7 : stage === 2 ? 2 : 0;
  const boxes: { y: number; h: number; w: number; c: RGBA }[] = [
    { y: 78, h: 22, w: wBot, c: shade(WOOD, k) },
    { y: 58, h: 20, w: wMid, c: shade(WOOD_MID, k) },
    { y: 38, h: 20, w: wTop, c: shade(WOOD, k) },
  ];
  for (const [i, b] of boxes.entries()) {
    const bx = cx - b.w / 2 + (i === 2 ? topShift : 0);
    px.rect(bx, oy + b.y, b.w, b.h, b.c);
    // Plank line + vertical seams.
    px.line(Math.round(bx + 2), Math.round(oy + b.y + b.h / 2), Math.round(bx + b.w - 2), Math.round(oy + b.y + b.h / 2), shade(WOOD_DARK, k));
    px.line(Math.round(bx + b.w / 3), Math.round(oy + b.y + 2), Math.round(bx + b.w / 3), Math.round(oy + b.y + b.h - 2), shade(WOOD_DARK, k));
    px.line(Math.round(bx + (2 * b.w) / 3), Math.round(oy + b.y + 2), Math.round(bx + (2 * b.w) / 3), Math.round(oy + b.y + b.h - 2), shade(WOOD_DARK, k));
  }
  // Roof cap: wider than the top box, lighter top edge.
  const rw = wTop + 12;
  px.rect(cx - rw / 2 + topShift, oy + 30, rw, 9, shade(WOOD_DARK, k));
  px.line(Math.round(cx - rw / 2 + topShift + 2), Math.round(oy + 31), Math.round(cx + rw / 2 + topShift - 2), Math.round(oy + 31), shade(WOOD_LIGHT, k));
  // Entrance hole + landing ledge (front view: centre; side view: right edge).
  const ex = narrow ? cx + wBot / 2 - 10 : cx - 6;
  px.rect(ex, oy + 88, 12, 7, HIVE_HOLE, null);
  px.rect(ex - 3, oy + 95, 18, 3, shade(WOOD_LIGHT, k), null);
  // Bees around the roof: gold dots with a white wing pixel.
  const bees: readonly (readonly [number, number])[] = narrow
    ? [[-26, 22], [24, 18], [14, 40]]
    : [[-30, 24], [28, 20], [18, 44]];
  for (const [bx, by] of bees) {
    px.set(cx + bx, oy + by, BEE_GOLD);
    px.set(cx + bx + 1, oy + by - 1, [255, 255, 255]);
  }
  // Damage: cracks grow with the stage; stage 3 also drops a plank at the base.
  const crack = (x0: number, y0: number, x1: number, y1: number): void => px.line(ox + x0, oy + y0, ox + x1, oy + y1, shade([52, 36, 26], k));
  if (stage >= 1) { crack(48, 62, 54, 74); crack(82, 42, 78, 54); }
  if (stage >= 2) { crack(58, 84, 66, 96); crack(74, 60, 70, 72); crack(40, 44, 46, 56); }
  if (stage >= 3) {
    crack(52, 40, 60, 52); crack(88, 66, 80, 78); crack(44, 86, 52, 98);
    px.rect(cx - 46, oy + 104, 16, 4, shade(WOOD_MID, k)); // fallen plank
  }
}

// ---- atlas assembly -------------------------------------------------------
export interface PaintedAtlas { key: string; width: number; height: number; pixels: Uint8ClampedArray }

/**
 * Paint all three Task 34 atlases (pure: no DOM, unit-testable). Creature grid is 8 cols x 16 rows of 64px:
 * idle rows 0-7, walk rows 8-15, 4 frames per row (dirStride 8 = columns); Apiary is 4 cols x 2 rows of 128px
 * (stage, rot). Matches the pack/task34 fragment layout exactly.
 */
export function paintTask34Atlases(): PaintedAtlas[] {
  const bee = new Px(512, 1024);
  const owl = new Px(512, 1024);
  for (let d = 0; d < 8; d++) for (let f = 0; f < 4; f++) {
    paintBeeCell(bee, f * 64, d * 64, d, f, false);
    paintBeeCell(bee, f * 64, (8 + d) * 64, d, f, true);
    paintOwlCell(owl, f * 64, d * 64, d, f, false);
    paintOwlCell(owl, f * 64, (8 + d) * 64, d, f, true);
  }
  const apiary = new Px(512, 256);
  for (let rot = 0; rot < 2; rot++) for (let stage = 0; stage < 4; stage++) paintApiaryCell(apiary, stage * 128, rot * 128, rot, stage);
  return [
    { key: "pets_bee", width: 512, height: 1024, pixels: bee.data },
    { key: "pets_owl", width: 512, height: 1024, pixels: owl.data },
    { key: "decor_apiary", width: 512, height: 256, pixels: apiary.data },
  ];
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
 * Atlas sources for the three generated atlases (same { url, emissiveUrl } shape as sourcesFromManifest; the
 * vehicles debug pack does the same). view.ts merges these over the manifest's debug/*.png paths before
 * setRegistry, so the registry's bee / owl / apiary sprites draw the painted pixels. Returns only the atlases
 * that converted (empty in a canvas-less environment).
 */
export async function task34AtlasSources(): Promise<Map<string, AtlasSource>> {
  const out = new Map<string, AtlasSource>();
  for (const a of paintTask34Atlases()) {
    const url = await canvasToBlobURL(a.width, a.height, a.pixels);
    if (url) out.set(a.key, { url, emissiveUrl: null });
  }
  return out;
}
