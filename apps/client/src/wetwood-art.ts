// ADR-457: wet firewood's own icon, painted at runtime (no PNG file on disk — the snapshot push
// route carries text only, and the pack pipeline cannot ship new binary art).
//
// Wet wood is NOT dry wood with a tint: it is a different thing (it burns half as long), so it gets
// dedicated pixels, painted with the same tiny software canvas as the ADR-387 Guide book icon
// (Px, ./task34-art.ts): a pine log soaked dark by the rain, pale sawn end with growth rings, water
// droplets beaded on top and one drip falling off. Nothing here tints or scales the dry-wood icon,
// and no sprite is reused for a different thing — a wet log is a wet log.
//
// Installed once at startup (view.ts, next to installGuideMenuIcon): the painted PNG is registered
// in ICON_DATA under `wet_wood.png`, so the inventory / hotbar / toast / crafting icons render it
// through the existing iconImg/iconUrl path, and a [data-icon="wet_wood"] override rule is installed
// so [data-icon] spans work too (the same mechanism as the Guide book). Idempotent; safe no-op
// (returns false, registers nothing) when no canvas exists and no URLs are supplied.
// A future binary art pass should ship a real wet-wood icon and remove installWetWoodIcon().
//
// Note: dropped items are loot bags (dropItem in pets.ts), so an item sprite never renders in the
// world — the UI icon is the only surface wet wood appears on, and this covers it. If Art ships a
// real wet_wood pack sprite under the same key, the manifest takes over (spriteKey is "wet_wood").
import { ICON_DATA } from "./game-icons-data.js";
import { Px } from "./task34-art.js";

/** The ICON_DATA key (and [data-icon] key) the painted wet wood is installed under. */
export const WET_WOOD_ICON_FILE = "wet_wood.png";

type RGBA = readonly [number, number, number, number?];
const BARK: RGBA = [74, 52, 30]; // dark wet bark (dry pine is much paler)
const BARK_DARK: RGBA = [50, 34, 19];
const BARK_LIGHT: RGBA = [98, 70, 40]; // wet sheen along the top
const DAMP: RGBA = [42, 28, 16]; // soaked band along the bottom
const CUT: RGBA = [198, 166, 112]; // pale sawn end
const RING: RGBA = [150, 118, 72];
const WATER: RGBA = [150, 200, 235]; // rain droplets beaded on the log
const DROP_HI: RGBA = [235, 245, 255];
const SHADOW: RGBA = [0, 0, 0, 70];

/**
 * Paint the wet-log icon (128x128, pure — no DOM). A horizontal pine log, soaked dark, with a pale
 * sawn end (growth rings), rain droplets on top, one drip falling off, ground shadow underneath.
 * The log fills most of the frame so it still reads at 24px.
 */
export function paintWetWoodPixels(): { width: number; height: number; pixels: Uint8ClampedArray } {
  const px = new Px(128, 128);
  // Ground shadow.
  px.ellipse(64, 104, 36, 5, SHADOW, null);
  // Log body: dark wet bark.
  px.rect(24, 48, 72, 36, BARK);
  // Rounded bark cap on the left end.
  px.ellipse(24, 66, 8, 18, BARK_DARK);
  // Sawn end on the right: pale wood with growth rings.
  px.ellipse(96, 66, 10, 18, CUT);
  px.ellipse(96, 66, 6, 11, RING, null);
  px.ellipse(96, 66, 3, 6, CUT, null);
  px.ellipse(96, 66, 1, 2, BARK_DARK, null);
  // Wet sheen along the top edge.
  px.rect(28, 50, 64, 4, BARK_LIGHT, null);
  // Bark ridges down the body.
  for (const x of [36, 48, 60, 72, 84]) px.line(x, 54, x, 78, BARK_DARK);
  // Soaked dark band along the bottom.
  px.rect(28, 76, 64, 6, DAMP, null);
  // Rain droplets beaded on top, each with a white highlight.
  for (const [dx, dy, r] of [[40, 46, 4], [58, 44, 5], [76, 46, 4]] as const) {
    px.ellipse(dx, dy, r, r, WATER);
    px.set(dx - 1, dy - 1, DROP_HI);
  }
  // One drip falling off the bottom edge.
  px.line(66, 86, 66, 90, WATER);
  px.ellipse(66, 93, 3, 4, WATER);
  px.set(65, 92, DROP_HI);
  return { width: 128, height: 128, pixels: px.data };
}

/**
 * Painted 128px wet-log icon -> PNG data URL via a document canvas (sync); undefined when no canvas
 * exists (jsdom / headless). The browser downscales the 128px PNG into the 24px slot box
 * (image-rendering:pixelated in iconImg).
 */
export function wetWoodIconDataUrl(doc?: Document): string | undefined {
  try {
    const d = doc ?? (globalThis as { document?: Document }).document;
    if (!d) return undefined;
    const { width, height, pixels } = paintWetWoodPixels();
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

/** One override rule: the [data-icon="wet_wood"] span shows the painted PNG, centred and contained. */
export function wetWoodMenuIconsCss(url: string): string {
  return `[data-icon="wet_wood"]{--cz-icon:url("${url}");--cz-ipos:center;--cz-isize:contain}`;
}

/**
 * Install the wet-wood icon: paint it, register the PNG in ICON_DATA under `wet_wood.png`
 * (so iconImg/iconUrl serve it like the embedded ic_ icons), and append (or replace) the
 * <style id="wetwood-icons"> override rule for [data-icon="wet_wood"] spans. Idempotent; safe
 * no-op (returns false, registers nothing) when no canvas exists and no URLs are supplied.
 * `urls` is a test seam — production callers omit it and the icon is painted from the canvas.
 */
export function installWetWoodIcon(doc?: Document, urls?: ReadonlyMap<string, string>): boolean {
  const d = doc ?? (globalThis as { document?: Document }).document;
  if (!d) return false;
  const url = urls?.get(WET_WOOD_ICON_FILE) ?? wetWoodIconDataUrl(d);
  if (!url) return false;
  ICON_DATA[WET_WOOD_ICON_FILE] = url;
  let style = d.getElementById("wetwood-icons") as HTMLStyleElement | null;
  if (!style) { style = d.createElement("style"); style.id = "wetwood-icons"; d.head.appendChild(style); }
  style.textContent = wetWoodMenuIconsCss(url);
  return true;
}
