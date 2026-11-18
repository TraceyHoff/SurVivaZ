// ADR-420: dedicated art for the deep-water Dock (tier 1) and Shipyard (tier 2), painted at runtime
// like Task 34 / ADR-356 — no binary PNGs in the push snapshot. Each structure gets its own atlas
// (4 cols x 2 rows of 128px): cols 0-3 = damage stages 0-3, rows 0-1 = rotation 0 (front) / 1 (side,
// narrower). Damage darkens the wood (k = 1 - stage * 0.16, the Apiary rule) and adds cracks; stage 3
// also drops or shifts a piece. Nothing here tints or scales an existing sheet: the dock is an open
// plank jetty on posts with a bollard and coiled rope; the shipyard is a roofed slipway with a hull
// frame under construction, sawhorses and stacked planks — a taller, roofed silhouette that never
// reads as a dock. Both stand in water: posts run down past a painted waterline at the cell base.
// The painter is pure (no DOM) and unit-testable; the fragment (pack/task420) carries layout only.
// The user is the final visual check — no GL in the VM, so these are verified numerically (pixel
// counts, distinct signatures), not by eye.
import type { AtlasSource } from "@engine/render";
import { Px } from "./task34-art.js";

/** Atlas keys this module paints (also the fragment's atlas keys). */
export const TASK420_ATLAS_KEYS = ["decor_dock", "decor_shipyard"] as const;
/** Frame index for (rotation 0-1, damage stage 0-3) in a dock / shipyard atlas. */
export const task420Frame = (rot: number, stage: number): number => (rot & 1) * 4 + (stage & 3);

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
const WOOD_PALE: RGBA = [214, 178, 128];
const IRON: RGBA = [96, 96, 104];
const IRON_DARK: RGBA = [58, 58, 66];
const IRON_LIGHT: RGBA = [150, 150, 160];
const ROPE: RGBA = [196, 164, 104];
const ROOF: RGBA = [148, 92, 58];
const ROOF_DARK: RGBA = [112, 66, 40];
const ROOF_LIGHT: RGBA = [178, 116, 76];
const WATER: RGBA = [52, 110, 150];
const WATER_LIGHT: RGBA = [96, 160, 195];
const WATER_DARK: RGBA = [34, 78, 112];
const HULL: RGBA = [172, 128, 72];
const SAWDUST: RGBA = [222, 196, 150];

/** Shared waterline at the cell base: dark water with two light wave ticks (the structures stand in it). */
function paintWaterline(px: Px, ox: number, oy: number, k: number): void {
  px.rect(ox + 14, oy + 104, 100, 10, shade(WATER_DARK, k), null);
  px.line(ox + 22, oy + 107, ox + 44, oy + 107, shade(WATER_LIGHT, k));
  px.line(ox + 72, oy + 109, ox + 98, oy + 109, shade(WATER_LIGHT, k));
  px.line(ox + 52, oy + 111, ox + 66, oy + 111, shade(WATER, k));
}

// ---- dock ---------------------------------------------------------------------------
// An open plank jetty: a plank deck on four posts, a bollard with a coiled rope at the near end and
// a mooring cleat at the far end. Side view is the same jetty seen end-on (narrower deck, two posts).
export function paintDockCell(px: Px, ox: number, oy: number, rot: number, stage: number): void {
  const k = 1 - stage * 0.16;
  const narrow = rot === 1;
  const cx = ox + 64;
  const w = narrow ? 46 : 84;
  px.ellipse(cx, oy + 108, 40, 5, SHADOW, null);
  paintWaterline(px, ox, oy, k);
  // Posts: down from the deck into the water (front pair taller in the frame than the back pair).
  for (const [dx, top] of [[-w / 2 + 4, 66], [w / 2 - 4, 66], [-w / 2 + 12, 60], [w / 2 - 12, 60]] as const) {
    px.rect(Math.round(cx + dx - 3), oy + top, 6, 108 - top, shade(WOOD_DARK, k));
    px.rect(Math.round(cx + dx - 3), oy + top, 6, 3, shade(WOOD_MID, k), null);
  }
  // Deck: plank courses with seams, a lighter rim board at the near edge.
  px.rect(cx - w / 2, oy + 58, w, 14, shade(WOOD, k));
  for (let i = 1; i < (narrow ? 3 : 5); i++) {
    const x = Math.round(cx - w / 2 + (w * i) / (narrow ? 3 : 5));
    px.line(x, oy + 59, x, oy + 71, shade(WOOD_DARK, k));
  }
  px.line(Math.round(cx - w / 2), Math.round(oy + 64), Math.round(cx + w / 2), Math.round(oy + 64), shade(WOOD_MID, k));
  px.rect(cx - w / 2, oy + 70, w, 2, shade(WOOD_LIGHT, k), null);
  if (!narrow) {
    // Bollard + coiled rope at the near (left) end.
    px.rect(cx - w / 2 + 4, oy + 44, 7, 14, shade(WOOD_DARK, k));
    px.rect(cx - w / 2 + 2, oy + 42, 11, 4, shade(WOOD_MID, k));
    px.ellipse(cx - w / 2 + 20, oy + 54, 8, 4, shade(ROPE, k));
    px.ellipse(cx - w / 2 + 20, oy + 54, 5, 2, shade(WOOD_DARK, k), null);
    // Mooring cleat at the far (right) end.
    px.rect(cx + w / 2 - 14, oy + 50, 10, 3, shade(IRON, k));
    px.rect(cx + w / 2 - 12, oy + 46, 6, 4, shade(IRON_DARK, k));
  } else {
    // End-on: one bollard centred on the near edge.
    px.rect(cx - 3, oy + 44, 7, 14, shade(WOOD_DARK, k));
    px.rect(cx - 5, oy + 42, 11, 4, shade(WOOD_MID, k));
  }
  // Damage: cracks in the deck, a leaning post and a missing plank at stage 3.
  const crack = (x0: number, y0: number, x1: number, y1: number): void => px.line(ox + x0, oy + y0, ox + x1, oy + y1, shade([52, 36, 26], k));
  if (stage >= 1) crack(48, 60, 54, 70);
  if (stage >= 2) { crack(76, 59, 70, 70); crack(58, 62, 64, 70); }
  if (stage >= 3) {
    crack(44, 59, 52, 69);
    px.rect(cx - w / 2 + 18, oy + 58, 10, 14, shade(WATER_DARK, k), null); // missing plank: water shows through
    px.line(Math.round(cx + w / 2 - 7), Math.round(oy + 66), Math.round(cx + w / 2 + 2), Math.round(oy + 70), shade(WOOD_DARK, k)); // leaning post
  }
}

// ---- shipyard -----------------------------------------------------------------------
// A roofed slipway: a gabled roof on four posts over a plank deck, a hull frame (ribs + keel) under
// construction on the slip, sawhorses and a stack of planks at the side, iron fittings on the posts.
// Taller and roofed — it never reads as the open dock.
export function paintShipyardCell(px: Px, ox: number, oy: number, rot: number, stage: number): void {
  const k = 1 - stage * 0.16;
  const narrow = rot === 1;
  const cx = ox + 64;
  const w = narrow ? 56 : 96;
  px.ellipse(cx, oy + 108, 46, 5, SHADOW, null);
  paintWaterline(px, ox, oy, k);
  // Posts: front pair to the deck, back pair up to the roof.
  for (const dx of [-w / 2 + 5, w / 2 - 5]) {
    px.rect(Math.round(cx + dx - 3), oy + 34, 6, 74, shade(WOOD_DARK, k));
    px.rect(Math.round(cx + dx - 3), oy + 34, 6, 3, shade(IRON, k), null); // iron collar
  }
  // Deck.
  px.rect(cx - w / 2, oy + 76, w, 12, shade(WOOD, k));
  for (let i = 1; i < (narrow ? 3 : 6); i++) {
    const x = Math.round(cx - w / 2 + (w * i) / (narrow ? 3 : 6));
    px.line(x, oy + 77, x, oy + 87, shade(WOOD_DARK, k));
  }
  px.rect(cx - w / 2, oy + 86, w, 2, shade(WOOD_LIGHT, k), null);
  // Gabled roof: two slopes + ridge beam + gable infill.
  px.tri(cx - w / 2 - 4, oy + 36, cx, oy + 14, cx + w / 2 + 4, oy + 36, shade(ROOF, k));
  px.line(Math.round(cx - w / 2 - 4), Math.round(oy + 36), Math.round(cx), Math.round(oy + 14), shade(ROOF_LIGHT, k));
  px.line(Math.round(cx), Math.round(oy + 14), Math.round(cx + w / 2 + 4), Math.round(oy + 36), shade(ROOF_DARK, k));
  px.rect(cx - 14, oy + 12, 28, 4, shade(WOOD_DARK, k));
  // Hull frame on the slip: keel + ribs rising from the deck.
  const keelY = 76;
  px.rect(cx - 26, oy + keelY - 4, 52, 4, shade(HULL, k));
  for (const dx of [-22, -11, 0, 11, 22]) {
    const h = 12 - Math.abs(dx) / 3;
    px.line(Math.round(cx + dx), Math.round(oy + keelY - 4), Math.round(cx + dx), Math.round(oy + keelY - 4 - h), shade(HULL, k));
  }
  px.line(Math.round(cx - 26), Math.round(oy + keelY - 14), Math.round(cx + 26), Math.round(oy + keelY - 14), shade(WOOD_PALE, k));
  if (!narrow) {
    // Sawhorse + stacked planks at the right side.
    px.rect(cx + w / 2 - 24, oy + 66, 16, 3, shade(WOOD_MID, k));
    px.line(Math.round(cx + w / 2 - 22), Math.round(oy + 69), Math.round(cx + w / 2 - 24), Math.round(oy + 76), shade(WOOD_DARK, k));
    px.line(Math.round(cx + w / 2 - 10), Math.round(oy + 69), Math.round(cx + w / 2 - 8), Math.round(oy + 76), shade(WOOD_DARK, k));
    for (let i = 0; i < 3; i++) px.rect(cx + w / 2 - 26, oy + 58 - i * 3, 20, 2, shade(i % 2 ? WOOD_LIGHT : WOOD, k), null);
    // Sawdust pile under the hull.
    px.ellipse(cx - 8, oy + 88, 10, 2, shade(SAWDUST, k), null);
  }
  // Damage: cracks in the roof + deck, a slipped roof board and a fallen rib at stage 3.
  const crack = (x0: number, y0: number, x1: number, y1: number): void => px.line(ox + x0, oy + y0, ox + x1, oy + y1, shade([52, 36, 26], k));
  if (stage >= 1) crack(50, 24, 56, 32);
  if (stage >= 2) { crack(76, 22, 70, 30); crack(58, 78, 64, 86); }
  if (stage >= 3) {
    crack(46, 22, 54, 30);
    px.line(Math.round(cx + 10), Math.round(oy + 18), Math.round(cx + 20), Math.round(oy + 26), shade(ROOF_DARK, k)); // slipped roof board
    px.line(Math.round(cx + 22), Math.round(oy + keelY - 4), Math.round(cx + 28), Math.round(oy + keelY - 4), shade(HULL, k)); // fallen rib
  }
}

const PAINTERS = { decor_dock: paintDockCell, decor_shipyard: paintShipyardCell } as const;

export interface PaintedAtlas { key: string; width: number; height: number; pixels: Uint8ClampedArray }

/**
 * Paint both atlases (pure: no DOM, unit-testable). Each atlas is 4 cols x 2 rows of 128px:
 * cols = damage stages 0-3, rows = rotation 0 (front) / 1 (side). Matches the pack/task420 fragment layout.
 */
export function paintTask420Atlases(): PaintedAtlas[] {
  const out: PaintedAtlas[] = [];
  for (const key of TASK420_ATLAS_KEYS) {
    const px = new Px(512, 256);
    const paint = PAINTERS[key];
    for (let rot = 0; rot < 2; rot++) for (let stage = 0; stage < 4; stage++) {
      paint(px, stage * 128, rot * 128, rot, stage);
    }
    out.push({ key, width: 512, height: 256, pixels: px.data });
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
 * Atlas sources for the two generated atlases (same { url, emissiveUrl } shape as sourcesFromManifest).
 * view.ts merges these over the manifest's debug paths before setRegistry once the pack/task420 fragment
 * declares the atlases, so the registry's dock / shipyard sprites draw the painted pixels. Returns only
 * the atlases that converted (empty in a canvas-less environment).
 */
export async function task420AtlasSources(): Promise<Map<string, AtlasSource>> {
  const out = new Map<string, AtlasSource>();
  for (const a of paintTask420Atlases()) {
    const url = await canvasToBlobURL(a.width, a.height, a.pixels);
    if (url) out.set(a.key, { url, emissiveUrl: null });
  }
  return out;
}

// ---- build-menu icons ---------------------------------------------------------------
// The build_<dock|shipyard> icons point at items_build cells that are transparent in the shipped atlas
// (no binary could ship through the snapshot route), so until a binary art pass paints those cells the
// build menu shows each structure's own world art, painted at runtime from the intact front cell below.
// The runtime-painted icons are the source of truth until then; a future binary art pass should remove
// installTask420MenuIcons() (one call in view.ts) and the icons will light up from the atlas.

/** The two structures, in the same order as TASK420_ATLAS_KEYS. */
export const TASK420_MENU_ICON_KEYS = ["dock", "shipyard"] as const;
export type Task420MenuIconKey = (typeof TASK420_MENU_ICON_KEYS)[number];

/**
 * Paint one structure's menu icon: the intact front cell (rot 0, stage 0) at 128x128. Pure — no DOM —
 * and pixel-identical to that cell of the structure's painted atlas.
 */
export function paintTask420MenuIconPixels(key: Task420MenuIconKey): { width: number; height: number; pixels: Uint8ClampedArray } {
  const px = new Px(128, 128);
  PAINTERS[`decor_${key}`](px, 0, 0, 0, 0);
  return { width: 128, height: 128, pixels: px.data };
}

/**
 * Painted 128px icon -> PNG data URL via a document canvas (sync); undefined when no canvas exists
 * (jsdom / headless). The browser downscales the 128px PNG into the 32px tile box (image-rendering:auto).
 */
export function task420MenuIconDataUrl(key: Task420MenuIconKey, doc?: Document): string | undefined {
  try {
    const d = doc ?? (globalThis as { document?: Document }).document;
    if (!d) return undefined;
    const { width, height, pixels } = paintTask420MenuIconPixels(key);
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
 * One override rule per structure: the tile's --cz-icon becomes the painted PNG, centred and contained in
 * the 32px tile box. Appended after the linked stylesheet, equal specificity wins over the generated
 * items_build block (same [data-icon="..."] attribute selector, later in document order).
 */
export function task420MenuIconsCss(urls: ReadonlyMap<string, string>): string {
  const rules: string[] = [];
  for (const key of TASK420_MENU_ICON_KEYS) {
    const url = urls.get(key);
    if (url) rules.push(`[data-icon="build_${key}"]{--cz-icon:url("${url}");--cz-ipos:center;--cz-isize:contain}`);
  }
  return rules.join("\n");
}

/**
 * Install the runtime menu icons for the dock and shipyard: paint each icon, build the override stylesheet,
 * and append (or replace) <style id="task420-menu-icons"> in the document head. Idempotent; safe no-op
 * (returns false, appends nothing) when no canvas exists and no URLs are supplied. `urls` is a test
 * seam — production callers omit it and the icons are painted from the canvas.
 */
export function installTask420MenuIcons(doc?: Document, urls?: ReadonlyMap<string, string>): boolean {
  const d = doc ?? (globalThis as { document?: Document }).document;
  if (!d) return false;
  const resolved = new Map<string, string>();
  for (const key of TASK420_MENU_ICON_KEYS) {
    const u = urls?.get(key) ?? task420MenuIconDataUrl(key, d);
    if (u) resolved.set(key, u);
  }
  if (resolved.size === 0) return false;
  const css = task420MenuIconsCss(resolved);
  let style = d.getElementById("task420-menu-icons") as HTMLStyleElement | null;
  if (!style) { style = d.createElement("style"); style.id = "task420-menu-icons"; d.head.appendChild(style); }
  style.textContent = css;
  return true;
}
