// ADR-387: the Guide's own book icon, painted at runtime (no PNG file on disk — the snapshot push
// route carries text only, and the pack pipeline cannot ship new binary art).
//
// The Guide had no icon of its own: its menu entry carried the 📖 emoji (game-menus.ts) and its pages
// opened under a bare "Guide" heading. The book below is NEW pixels, painted with the same tiny
// software canvas as the Task 34 / ADR-361 menu icons (Px, ./task34-art.ts): a closed leather book,
// gilt frame and medallion, cream page block on the right edge, dark spine on the left, a gold
// bookmark ribbon. Nothing here tints or scales an existing sheet, and no sprite is reused for a
// different thing — a book is a book.
//
// Installed once at startup (view.ts, next to installVehicleMenuIcons) and lazily on first Guide
// open (buildGuidePanel — the boot menu can show the Guide before the view exists): the painted PNG
// is registered in ICON_DATA under `guide_book.png`, so the menu buttons and panel headers render it
// through the existing iconImg/iconUrl path (the same mechanism as the embedded ic_ icons), and a
// [data-icon="guide_book"] override rule is installed so [data-icon] spans work too. Idempotent;
// safe no-op (returns false, registers nothing) when no canvas exists and no URLs are supplied.
// A future binary art pass should ship a real book icon and remove installGuideMenuIcon().
import { ICON_DATA } from "./game-icons-data.js";
import { Px } from "./task34-art.js";

/** The ICON_DATA key (and [data-icon] key) the painted book is installed under. */
export const GUIDE_BOOK_ICON_FILE = "guide_book.png";

type RGBA = readonly [number, number, number, number?];
const COVER: RGBA = [122, 59, 46]; // deep red leather
const COVER_LIGHT: RGBA = [146, 74, 56];
const SPINE: RGBA = [88, 40, 32];
const PAGES: RGBA = [242, 230, 200]; // cream page block
const PAGES_SHADE: RGBA = [214, 196, 160];
const GOLD: RGBA = [201, 162, 39];
const SHADOW: RGBA = [0, 0, 0, 70];

/**
 * Paint the book icon (128x128, pure — no DOM). The cover fills most of the frame so it still reads
 * at 24px: spine on the left, gilt frame and medallion on the cover, page block on the right edge,
 * bookmark ribbon hanging below the cover, ground shadow underneath.
 */
export function paintGuideBookPixels(): { width: number; height: number; pixels: Uint8ClampedArray } {
  const px = new Px(128, 128);
  // Ground shadow.
  px.ellipse(64, 116, 34, 5, SHADOW, null);
  // Cover: leather, with a lighter inset panel.
  px.rect(28, 16, 70, 92, COVER);
  px.rect(36, 24, 54, 76, COVER_LIGHT, null);
  // Gilt frame on the cover.
  px.line(40, 28, 90, 28, GOLD);
  px.line(40, 100, 90, 100, GOLD);
  px.line(40, 28, 40, 100, GOLD);
  px.line(90, 28, 90, 100, GOLD);
  // Medallion in the middle of the cover.
  px.ellipse(65, 64, 9, 11, GOLD);
  px.ellipse(65, 64, 4, 5, COVER, null);
  // Spine: darker leather on the left edge, with two gilt bands.
  px.rect(28, 16, 8, 92, SPINE);
  px.line(28, 36, 36, 36, GOLD);
  px.line(28, 88, 36, 88, GOLD);
  // Page block on the right edge, with page lines.
  px.rect(96, 20, 10, 88, PAGES);
  for (const y of [34, 52, 70, 88]) px.line(97, y, 105, y, PAGES_SHADE);
  // Bookmark ribbon hanging below the cover.
  px.rect(60, 106, 8, 12, GOLD);
  return { width: 128, height: 128, pixels: px.data };
}

/**
 * Painted 128px book icon -> PNG data URL via a document canvas (sync); undefined when no canvas
 * exists (jsdom / headless). The browser downscales the 128px PNG into the 24px button/header box
 * (image-rendering:pixelated in iconImg).
 */
export function guideBookIconDataUrl(doc?: Document): string | undefined {
  try {
    const d = doc ?? (globalThis as { document?: Document }).document;
    if (!d) return undefined;
    const { width, height, pixels } = paintGuideBookPixels();
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

/** One override rule: the [data-icon="guide_book"] span shows the painted PNG, centred and contained. */
export function guideBookMenuIconsCss(url: string): string {
  return `[data-icon="guide_book"]{--cz-icon:url("${url}");--cz-ipos:center;--cz-isize:contain}`;
}

/**
 * Install the Guide's book icon: paint it, register the PNG in ICON_DATA under `guide_book.png`
 * (so iconImg/iconUrl serve it like the embedded ic_ icons), and append (or replace) the
 * <style id="guide-menu-icons"> override rule for [data-icon="guide_book"] spans. Idempotent; safe
 * no-op (returns false, registers nothing) when no canvas exists and no URLs are supplied.
 * `urls` is a test seam — production callers omit it and the icon is painted from the canvas.
 */
export function installGuideMenuIcon(doc?: Document, urls?: ReadonlyMap<string, string>): boolean {
  const d = doc ?? (globalThis as { document?: Document }).document;
  if (!d) return false;
  const url = urls?.get(GUIDE_BOOK_ICON_FILE) ?? guideBookIconDataUrl(d);
  if (!url) return false;
  ICON_DATA[GUIDE_BOOK_ICON_FILE] = url;
  let style = d.getElementById("guide-menu-icons") as HTMLStyleElement | null;
  if (!style) { style = d.createElement("style"); style.id = "guide-menu-icons"; d.head.appendChild(style); }
  style.textContent = guideBookMenuIconsCss(url);
  return true;
}
