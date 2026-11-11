// ADR-356: dedicated art for the five resource-specific storage structures (ADR-355), painted at runtime like
// Task 34 — no binary PNGs in the push snapshot. Each store gets its own atlas (8 cols x 3 rows of 128px):
// row = fill state (0 empty, 1 half, 2 full — TASK355_FILL_STATES, same order as the fragment's building.states
// and gameplay's STORE_FILL_STATE_NAMES), cols 0-3 = rotation 0 damage stages 0-3, cols 4-7 = rotation 1
// (side view, narrower) damage stages 0-3. Damage darkens the wood/stone (k = 1 - stage * 0.16, the Apiary
// rule) and adds cracks; stage 3 also drops or shifts a piece. Nothing here tints or scales an existing sheet:
// every store is its own silhouette — ore bin, log rack, stick teepee, produce crate, dry-stone bin.
import type { AtlasSource } from "@engine/render";
import { Px } from "./task34-art.js";

/** Atlas keys this module paints (also the fragment's atlas keys). */
export const TASK355_ATLAS_KEYS = ["decor_ore_store", "decor_log_store", "decor_stick_store", "decor_crop_store", "decor_stone_store"] as const;
/** Fill-state row order in every store atlas (must match the pack/task355 fragment and STORE_FILL_STATE_NAMES). */
export const TASK355_FILL_STATES = ["empty", "half", "full"] as const;
/** Frame index for (fill state 0-2, rotation 0-1, damage stage 0-3) in a store atlas. */
export const task355Frame = (fill: number, rot: number, stage: number): number => fill * 8 + (rot & 1) * 4 + (stage & 3);

type RGBA = readonly [number, number, number, number?];
const OUTLINE: RGBA = [40, 30, 50];
const SHADOW: RGBA = [0, 0, 0, 70];
const shade = (c: RGBA, k: number): RGBA => [
  Math.max(0, Math.min(255, Math.round(c[0] * k))),
  Math.max(0, Math.min(255, Math.round(c[1] * k))),
  Math.max(0, Math.min(255, Math.round(c[2] * k))),
  c[3] ?? 255,
];

const WOOD: RGBA = [185, 138, 78];
const WOOD_MID: RGBA = [161, 118, 58];
const WOOD_DARK: RGBA = [122, 79, 38];
const WOOD_LIGHT: RGBA = [201, 160, 106];
const BARK: RGBA = [122, 90, 55];
const CUT: RGBA = [198, 164, 110];
const RING: RGBA = [150, 115, 70];
const STONE: RGBA = [150, 150, 155];
const STONE_DARK: RGBA = [110, 110, 118];
const STONE_LIGHT: RGBA = [178, 178, 184];
const MORTAR: RGBA = [88, 88, 96];
const DARK_IN: RGBA = [40, 32, 28];
const ROPE: RGBA = [196, 164, 104];

// ---- ore store ----------------------------------------------------------------
// A stone-lined open bin: low dry-stone front wall with block seams, wooden corner posts, a dark mouth.
// Stocked states show ore chunks in the mouth — copper orange, iron blue-grey, tin pale, lead dull, chromite
// near-black — heaped above the rim when full, with bright glints. No other store has the stone + post frame.
const ORE_CHUNK: readonly RGBA[] = [[198, 120, 60], [150, 160, 175], [200, 200, 205], [120, 120, 130], [70, 70, 80]];
const ORE_GLINT: RGBA = [240, 235, 220];

/** One 128x128 ore-store cell at (ox, oy): `rot` 0 = front, 1 = side (narrower); `stage` 0-3 damage; `fill` 0-2. */
export function paintOreCell(px: Px, ox: number, oy: number, rot: number, stage: number, fill: number): void {
  const k = 1 - stage * 0.16;
  const narrow = rot === 1;
  const cx = ox + 64;
  const w = narrow ? 52 : 72;
  px.ellipse(cx, oy + 108, 34, 5, SHADOW, null);
  // Dark bin interior (the mouth) behind the front wall.
  px.rect(cx - w / 2, oy + 60, w, 44, shade(DARK_IN, k), null);
  // Ore chunks: half = a low layer in the mouth, full = a mound heaped above the rim.
  const chunks: readonly (readonly [number, number, number, number, number])[] = fill === 0 ? [] : fill === 1
    ? [[-18, 72, 9, 5, 0], [0, 70, 10, 6, 1], [19, 73, 8, 5, 3]]
    : [[-24, 74, 10, 6, 0], [-6, 70, 11, 6, 1], [12, 72, 10, 6, 2], [-14, 60, 10, 6, 4], [4, 58, 11, 6, 0], [20, 62, 9, 5, 3], [-2, 50, 9, 5, 1]];
  for (const [dx, dy, rx, ry, ci] of chunks) {
    px.ellipse(cx + dx, oy + dy, rx, ry, shade(ORE_CHUNK[ci % ORE_CHUNK.length]!, k));
    px.set(Math.round(cx + dx - 2), Math.round(oy + dy - 2), shade(ORE_GLINT, k));
  }
  // Front wall: dry-stone courses with seams; the rim reads as the bin's lip.
  px.rect(cx - w / 2, oy + 82, w, 22, shade(STONE, k));
  px.line(Math.round(cx - w / 2 + 2), Math.round(oy + 93), Math.round(cx + w / 2 - 2), Math.round(oy + 93), shade(MORTAR, k));
  for (const fx of [-w / 6, w / 6]) px.line(Math.round(cx + fx), Math.round(oy + 84), Math.round(cx + fx), Math.round(oy + 102), shade(MORTAR, k));
  px.line(Math.round(cx - w / 2), Math.round(oy + 82), Math.round(cx + w / 2), Math.round(oy + 82), shade(STONE_LIGHT, k));
  // Wooden corner posts.
  px.rect(cx - w / 2 - 3, oy + 62, 6, 42, shade(WOOD_DARK, k));
  px.rect(cx + w / 2 - 3, oy + 62, 6, 42, shade(WOOD_DARK, k));
  // Damage: cracks in the wall, a leaning post and a spilled chunk at stage 3.
  const crack = (x0: number, y0: number, x1: number, y1: number): void => px.line(ox + x0, oy + y0, ox + x1, oy + y1, shade([52, 36, 26], k));
  if (stage >= 1) crack(48, 86, 54, 96);
  if (stage >= 2) { crack(78, 84, 72, 96); crack(58, 88, 64, 100); }
  if (stage >= 3) {
    crack(44, 84, 52, 94);
    px.ellipse(cx + w / 2 + 8, oy + 104, 6, 4, shade(ORE_CHUNK[1]!, k)); // spilled chunk
    px.line(Math.round(cx + w / 2 - 2), Math.round(oy + 62), Math.round(cx + w / 2 + 4), Math.round(oy + 66), shade(WOOD_DARK, k));
  }
}

// ---- log store ----------------------------------------------------------------
// A log rack: two upright posts and a base beam. The logs are long horizontals with a cut end (rings) on the
// left; the pile grows with the fill — bare rack when empty, two rows when half, four rows heaped when full.
export function paintLogCell(px: Px, ox: number, oy: number, rot: number, stage: number, fill: number): void {
  const k = 1 - stage * 0.16;
  const narrow = rot === 1;
  const cx = ox + 64;
  const w = narrow ? 44 : 60;
  const lw = narrow ? 40 : 56;
  px.ellipse(cx, oy + 108, 34, 5, SHADOW, null);
  // Uprights + base beam.
  px.rect(cx - w / 2 - 3, oy + 56, 6, 48, shade(WOOD_DARK, k));
  px.rect(cx + w / 2 - 3, oy + 56, 6, 48, shade(WOOD_DARK, k));
  px.rect(cx - w / 2 - 5, oy + 100, w + 10, 6, shade(WOOD_MID, k));
  // Log rows (bottom-up), alternating rows staggered so the pile reads stacked, not striped.
  const rows = fill === 0 ? [] : fill === 1 ? [92, 82] : [92, 82, 72, 62];
  for (const [i, y] of rows.entries()) {
    const shift = i % 2 === 0 ? 0 : 3;
    const lx = cx - lw / 2 + shift;
    px.rect(lx, oy + y, lw, 9, shade(BARK, k));
    px.line(Math.round(lx + 3), Math.round(oy + y + 2), Math.round(lx + lw - 3), Math.round(oy + y + 2), shade(WOOD_DARK, k));
    // Cut end with growth rings on the left.
    px.ellipse(lx + 3, oy + y + 4, 4.5, 4.5, shade(CUT, k), null);
    px.ellipse(lx + 3, oy + y + 4, 2.5, 2.5, shade(RING, k), null);
  }
  // Damage: a fallen log at the base and a cracked post.
  if (stage >= 2) px.line(Math.round(cx - w / 2), Math.round(oy + 62), Math.round(cx - w / 2 + 6), Math.round(oy + 74), shade([52, 36, 26], k));
  if (stage >= 3) {
    px.ellipseRot(cx - w / 2 - 8, oy + 105, 12, 4, 0.35, shade(BARK, k));
    px.line(Math.round(cx + w / 2 - 2), Math.round(oy + 58), Math.round(cx + w / 2 + 3), Math.round(oy + 70), shade([52, 36, 26], k));
  }
}

// ---- stick store --------------------------------------------------------------
// A teepee bundle: sticks leaning together from a rope-tied crown, feet splayed on the ground. The bundle
// fattens with the fill — a sparse tripod plus a rope coil when empty, a fat bundle when full.
export function paintStickCell(px: Px, ox: number, oy: number, rot: number, stage: number, fill: number): void {
  const k = 1 - stage * 0.16;
  const narrow = rot === 1;
  const cx = ox + 64;
  const s = narrow ? 20 : 30;
  px.ellipse(cx, oy + 108, 30, 5, SHADOW, null);
  const tx = cx, ty = oy + 40;
  // Sticks: lean from the crown to splayed feet; each is a 2px line in alternating bark shades.
  const feet: readonly number[] = fill === 0 ? [-s, 0, s] : fill === 1 ? [-s, -s / 2, -4, 5, s / 2, s] : [-s, -s * 0.75, -s / 2, -6, 0, 6, s / 2, s * 0.75, s, -s * 0.9];
  for (const [i, fx] of feet.entries()) {
    const c = shade(i % 2 === 0 ? BARK : WOOD_MID, k);
    px.line(tx, ty, Math.round(cx + fx), oy + 104, c);
    px.line(tx + 1, ty, Math.round(cx + fx + 1), oy + 104, c);
    px.set(Math.round(cx + fx), oy + 103, shade(OUTLINE, k));
  }
  // A couple of cross sticks brace the bundle when it is stocked.
  if (fill >= 1) { px.line(Math.round(cx - s * 0.7), oy + 78, Math.round(cx + s * 0.7), oy + 70, shade(WOOD_DARK, k)); }
  if (fill >= 2) { px.line(Math.round(cx - s * 0.7), oy + 62, Math.round(cx + s * 0.7), oy + 70, shade(WOOD_DARK, k)); }
  // Rope tie at the crown + knot.
  px.rect(cx - 7, oy + 37, 14, 5, shade(ROPE, k));
  px.ellipse(cx + 6, oy + 39, 2.5, 2.5, shade(WOOD_DARK, k), null);
  // Empty: a spare rope coil on the ground where the bundle will grow.
  if (fill === 0) { px.ellipse(cx + 16, oy + 102, 8, 3, shade(ROPE, k)); px.ellipse(cx + 16, oy + 102, 4, 1.5, shade(WOOD_DARK, k), null); }
  // Damage: a fallen stick at stage 2+, the tie slipped at stage 3.
  if (stage >= 2) { px.line(Math.round(cx - 6), oy + 88, Math.round(cx - s - 8), oy + 106, shade(BARK, k)); px.line(Math.round(cx - 5), oy + 88, Math.round(cx - s - 7), oy + 106, shade(BARK, k)); }
  if (stage >= 3) px.rect(cx - 7, oy + 44, 14, 4, shade(ROPE, k));
}

// ---- crop store ---------------------------------------------------------------
// A slatted produce crate: horizontal planks with dark gaps, side posts, a lighter rim. Stocked states show
// produce above the rim — lettuce leaves, carrots, a pumpkin, tomatoes and corn — heaped when full.
const LEAF: RGBA = [70, 170, 85];
const LEAF_DARK: RGBA = [52, 130, 62];
const CARROT: RGBA = [232, 130, 50];
const PUMPKIN: RGBA = [238, 150, 52];
const TOMATO: RGBA = [205, 60, 48];
const CORN: RGBA = [238, 205, 80];

export function paintCropCell(px: Px, ox: number, oy: number, rot: number, stage: number, fill: number): void {
  const k = 1 - stage * 0.16;
  const narrow = rot === 1;
  const cx = ox + 64;
  const w = narrow ? 52 : 68;
  px.ellipse(cx, oy + 108, 34, 5, SHADOW, null);
  // Dark interior behind the slats.
  px.rect(cx - w / 2, oy + 74, w, 30, shade(DARK_IN, k), null);
  // Produce (drawn before the rim so it sits behind the crate lip, above it when heaped).
  if (fill === 1) {
    px.ellipse(cx - 16, oy + 70, 9, 5, shade(LEAF, k));
    px.ellipse(cx + 2, oy + 68, 8, 5, shade(LEAF_DARK, k));
    px.tri(cx + 16, oy + 74, cx + 22, oy + 74, cx + 19, oy + 62, shade(CARROT, k), null);
  } else if (fill === 2) {
    px.ellipse(cx - 18, oy + 62, 12, 8, shade(PUMPKIN, k));
    px.ellipse(cx - 18, oy + 62, 5, 3, shade(CARROT, k), null);
    px.ellipse(cx + 2, oy + 60, 10, 6, shade(LEAF, k));
    px.ellipse(cx + 16, oy + 66, 7, 6, shade(TOMATO, k));
    px.ellipse(cx + 24, oy + 72, 5, 5, shade(TOMATO, k));
    px.ellipse(cx - 2, oy + 72, 6, 4, shade(CORN, k));
    px.tri(cx + 8, oy + 74, cx + 14, oy + 74, cx + 11, oy + 64, shade(CARROT, k), null);
  }
  // Slats + side posts + rim (the rim overlaps the produce bases).
  const askew = stage >= 2 ? 3 : 0;
  for (const [i, y] of [80, 88, 96].entries()) {
    const shift = i === 1 ? askew : 0;
    px.rect(cx - w / 2 + shift, oy + y, w, 6, shade(i % 2 === 0 ? WOOD : WOOD_MID, k));
  }
  px.rect(cx - w / 2 - 3, oy + 76, 5, 28, shade(WOOD_DARK, k));
  px.rect(cx + w / 2 - 2, oy + 76, 5, 28, shade(WOOD_DARK, k));
  px.rect(cx - w / 2 - 2, oy + 73, w + 4, 5, shade(WOOD_LIGHT, k));
  // Damage: cracks in the slats, a fallen tomato at stage 3.
  if (stage >= 1) px.line(Math.round(cx - 10), Math.round(oy + 82), Math.round(cx - 6), Math.round(oy + 92), shade([52, 36, 26], k));
  if (stage >= 3) {
    px.line(Math.round(cx + 12), Math.round(oy + 84), Math.round(cx + 18), Math.round(oy + 94), shade([52, 36, 26], k));
    px.ellipse(cx + w / 2 + 8, oy + 104, 5, 5, shade(TOMATO, k));
  }
}

// ---- stone store --------------------------------------------------------------
// A dry-stone bin: three courses of grey blocks with offset seams and a cap course, a dark mouth. Stocked
// states show masonry stock in the mouth — grey stone, tan clay lumps and red-brown bricks — heaped when full.
const CLAY: RGBA = [198, 164, 120];
const BRICK: RGBA = [172, 92, 62];

export function paintStoneCell(px: Px, ox: number, oy: number, rot: number, stage: number, fill: number): void {
  const k = 1 - stage * 0.16;
  const narrow = rot === 1;
  const cx = ox + 64;
  const w = narrow ? 52 : 72;
  px.ellipse(cx, oy + 108, 34, 5, SHADOW, null);
  // Dark mouth behind the front courses.
  px.rect(cx - w / 2, oy + 60, w, 44, shade(DARK_IN, k), null);
  // Masonry stock in the mouth: half = one low course, full = a heap above the rim.
  if (fill === 1) {
    px.ellipse(cx - 18, oy + 72, 9, 5, shade(STONE_DARK, k));
    px.ellipse(cx, oy + 70, 9, 5, shade(CLAY, k));
    px.ellipse(cx + 18, oy + 73, 8, 5, shade(BRICK, k));
  } else if (fill === 2) {
    px.ellipse(cx - 22, oy + 74, 10, 6, shade(STONE, k));
    px.ellipse(cx - 2, oy + 70, 11, 6, shade(CLAY, k));
    px.ellipse(cx + 16, oy + 73, 10, 6, shade(BRICK, k));
    px.ellipse(cx - 12, oy + 60, 10, 6, shade(STONE_DARK, k));
    px.ellipse(cx + 8, oy + 58, 10, 6, shade(BRICK, k));
    px.ellipse(cx, oy + 50, 9, 5, shade(STONE_LIGHT, k));
  }
  // Front courses: three block rows with offset seams + cap course.
  for (const [i, y] of [82, 91, 100].entries()) {
    px.rect(cx - w / 2, oy + y, w, 8, shade(i % 2 === 0 ? STONE : STONE_DARK, k));
    const seam = i % 2 === 0 ? 0 : w / 4;
    for (const fx of [-w / 4 + seam, w / 4 + seam]) {
      if (Math.abs(fx) < w / 2 - 2) px.line(Math.round(cx + fx), Math.round(oy + y + 1), Math.round(cx + fx), Math.round(oy + y + 7), shade(MORTAR, k));
    }
  }
  px.rect(cx - w / 2 - 2, oy + 78, w + 4, 5, shade(STONE_LIGHT, k));
  // Damage: cracks, a toppled block at stage 3.
  if (stage >= 1) px.line(Math.round(cx - 8), Math.round(oy + 84), Math.round(cx - 2), Math.round(oy + 94), shade([52, 36, 26], k));
  if (stage >= 2) px.line(Math.round(cx + 14), Math.round(oy + 92), Math.round(cx + 20), Math.round(oy + 100), shade([52, 36, 26], k));
  if (stage >= 3) {
    px.rect(cx + w / 2 + 2, oy + 100, 12, 7, shade(STONE_DARK, k));
    px.line(Math.round(cx - 20), Math.round(oy + 86), Math.round(cx - 14), Math.round(oy + 96), shade([52, 36, 26], k));
  }
}

// ---- atlas assembly -------------------------------------------------------
export interface PaintedAtlas { key: string; width: number; height: number; pixels: Uint8ClampedArray }

const PAINTERS = {
  decor_ore_store: paintOreCell,
  decor_log_store: paintLogCell,
  decor_stick_store: paintStickCell,
  decor_crop_store: paintCropCell,
  decor_stone_store: paintStoneCell,
} as const;

/**
 * Paint all five store atlases (pure: no DOM, unit-testable). Each atlas is 8 cols x 3 rows of 128px:
 * row = fill state (empty / half / full), cols 0-3 = rotation 0 damage stages 0-3, cols 4-7 = rotation 1.
 * Matches the pack/task355 fragment layout exactly.
 */
export function paintTask355Atlases(): PaintedAtlas[] {
  const out: PaintedAtlas[] = [];
  for (const key of TASK355_ATLAS_KEYS) {
    const px = new Px(1024, 384);
    const paint = PAINTERS[key];
    for (let fill = 0; fill < 3; fill++) for (let rot = 0; rot < 2; rot++) for (let stage = 0; stage < 4; stage++) {
      paint(px, task355Frame(fill, rot, stage) % 8 * 128, fill * 128, rot, stage, fill);
    }
    out.push({ key, width: 1024, height: 384, pixels: px.data });
  }
  return out;
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
 * Atlas sources for the five generated atlases (same { url, emissiveUrl } shape as sourcesFromManifest; the
 * vehicles debug pack does the same). view.ts merges these over the manifest's debug/*.png paths before
 * setRegistry, so the registry's store sprites draw the painted pixels. Returns only the atlases that
 * converted (empty in a canvas-less environment).
 */
export async function task355AtlasSources(): Promise<Map<string, AtlasSource>> {
  const out = new Map<string, AtlasSource>();
  for (const a of paintTask355Atlases()) {
    const url = await canvasToBlobURL(a.width, a.height, a.pixels);
    if (url) out.set(a.key, { url, emissiveUrl: null });
  }
  return out;
}

// ---- build-menu icons (ADR-357) -------------------------------------------------------
// ADR-356 declared build_<store> icons at items_build frames 297–301, but those cells are transparent
// in the shipped atlas (0 opaque pixels, parent-verified; the snapshot push route carries text only, so
// no PNG could ship the pixels). Until a binary art pass paints those cells, the build menu shows each
// store's own world art, painted at runtime from the half-full front cell below (half-full reads best at
// 32px: the store plus its contents, not an empty bin or a heap). The manifest + CSS entries for frames
// 297–301 stay in place as the documented home for these icons; a future binary art pass should remove
// installStoreMenuIcons() (one call in view.ts) and the icons will light up from the atlas with no other
// code change. Runtime-painted icons are the source of truth until then — the code does not probe the
// atlas pixels at startup (that would need an async fetch + decode for five cells on every load).

/** The five stores, in the same order as TASK355_ATLAS_KEYS. */
export const STORE_MENU_ICON_KEYS = ["ore_store", "log_store", "stick_store", "crop_store", "stone_store"] as const;
export type StoreMenuIconKey = (typeof STORE_MENU_ICON_KEYS)[number];

/**
 * Paint one store's menu icon: the half-full front cell (fill 1, rot 0, stage 0) at 128×128. Pure —
 * no DOM — and pixel-identical to that cell of the store's painted atlas (asserted in adr357 tests).
 */
export function paintStoreMenuIconPixels(store: StoreMenuIconKey): { width: number; height: number; pixels: Uint8ClampedArray } {
  const px = new Px(128, 128);
  PAINTERS[`decor_${store}`](px, 0, 0, 0, 0, 1);
  return { width: 128, height: 128, pixels: px.data };
}

/**
 * Painted 128px icon -> PNG data URL via a document canvas (sync); undefined when no canvas exists
 * (jsdom / headless). The browser downscales the 128px PNG into the 32px tile box (image-rendering:auto).
 */
export function storeMenuIconDataUrl(store: StoreMenuIconKey, doc?: Document): string | undefined {
  try {
    const d = doc ?? (globalThis as { document?: Document }).document;
    if (!d) return undefined;
    const { width, height, pixels } = paintStoreMenuIconPixels(store);
    // Same TS 5.9 note as canvasToBlobURL: copy into a fresh ArrayBuffer-backed array.
    const data = new ImageData(new Uint8ClampedArray(pixels), width, height);
    const cv = d.createElement("canvas"); cv.width = width; cv.height = height;
    const ctx = cv.getContext("2d");
    if (!ctx) return undefined;
    ctx.putImageData(data, 0, 0);
    const url = cv.toDataURL("image/png");
    return url && url !== "data:," ? url : undefined;
  } catch { return undefined; }
}

/**
 * One override rule per store: the tile's --cz-icon becomes the painted PNG, centred and contained in
 * the 32px tile box. Appended after the linked stylesheet, equal specificity wins over the generated
 * items_build block (same [data-icon="..."] attribute selector, later in document order).
 */
export function storeMenuIconsCss(urls: ReadonlyMap<string, string>): string {
  const rules: string[] = [];
  for (const store of STORE_MENU_ICON_KEYS) {
    const url = urls.get(store);
    if (url) rules.push(`[data-icon="build_${store}"]{--cz-icon:url("${url}");--cz-ipos:center;--cz-isize:contain}`);
  }
  return rules.join("\n");
}

/**
 * Install the runtime menu icons for the five stores: paint each icon, build the override stylesheet,
 * and append (or replace) <style id="task355-menu-icons"> in the document head. Idempotent; safe no-op
 * (returns false, appends nothing) when no canvas exists and no URLs are supplied. `urls` is a test
 * seam — production callers omit it and the icons are painted from the canvas.
 */
export function installStoreMenuIcons(doc?: Document, urls?: ReadonlyMap<string, string>): boolean {
  const d = doc ?? (globalThis as { document?: Document }).document;
  if (!d) return false;
  const resolved = new Map<string, string>();
  for (const store of STORE_MENU_ICON_KEYS) {
    const u = urls?.get(store) ?? storeMenuIconDataUrl(store, d);
    if (u) resolved.set(store, u);
  }
  if (resolved.size === 0) return false;
  const css = storeMenuIconsCss(resolved);
  let style = d.getElementById("task355-menu-icons") as HTMLStyleElement | null;
  if (!style) { style = d.createElement("style"); style.id = "task355-menu-icons"; d.head.appendChild(style); }
  style.textContent = css;
  return true;
}
