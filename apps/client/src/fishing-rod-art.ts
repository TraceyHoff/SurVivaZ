// ADR-493: fishing rod art, painted at runtime (no PNG file on disk — the snapshot push
// route carries text only, and the pack pipeline cannot ship new binary art).
//
// A rod needs TWO surfaces, and the two runtime-paint precedents cover them:
//  - Inventory icon (128x128, wetwood-style): a diagonal rod + reel + hanging line and hook,
//    painted with the same Px software canvas as the ADR-457 wet-wood icon, installed into
//    ICON_DATA under `fishing_rod.png`, so inventory / hotbar / toast / crafting render it
//    through the existing icon path. The rod fills most of the frame so it still reads at 24px.
//  - Held in hand (48x48 x 8 facings, footprints-style): the rod is held at its butt (the grip
//    anchor, like the axe's) and angles up-forward along the facing direction, so the character
//    renderer draws it at the hand from any facing. Registered as the `held_fishing_rod` atlas
//    source and merged over the manifest's debug path in view.ts — the fragment
//    (pack/task493/manifest.task493.json) carries layout only. The `held` atlas itself is full
//    (120/120 frames), so the rod gets its own atlas; emitHeld resolves the sprite's own atlas,
//    so that is all it needs. Idempotent; safe no-op (returns an empty map / false) when no
//    canvas exists. A future binary art pass should ship a real rod atlas + icon and remove this.
//
// Colours are the game's own ramps (wetwood's bark browns, cut-wood pale, water blue for the
// line, dark metal for the reel and hook) — never invented in a different style. Nothing here
// tints or reuses another sprite, and no sprite is reused for a different thing — a rod is a rod.
import { ICON_DATA } from "./game-icons-data.js";
import { Px, TASK34_DIR_VEC } from "./task34-art.js";
import type { AtlasSource } from "@engine/render";

/** The ICON_DATA key (and [data-icon] key) the painted rod icon is installed under. */
export const FISHING_ROD_ICON_FILE = "fishing_rod.png";
/** The atlas key (fragment + painter agree) and the sprite key the renderer resolves. */
export const ROD_ATLAS_KEY = "held_fishing_rod";
export const ROD_SPRITE_KEY = "held_fishing_rod";

type RGBA = readonly [number, number, number, number?];
const BARK: RGBA = [74, 52, 30]; // dark rod wood (wetwood's bark)
const BARK_LIGHT: RGBA = [98, 70, 40]; // sheen along the top edge
const CUT: RGBA = [198, 166, 112]; // pale cork grip
const METAL: RGBA = [58, 58, 66]; // dark metal reel + hook
const METAL_LIGHT: RGBA = [150, 150, 160]; // reel hub highlight
const LINE: RGBA = [220, 225, 215, 230]; // pale fishing line
const SHADOW: RGBA = [0, 0, 0, 70];

const FRAME = 48; // one 48x48 frame per facing (the held atlas cell, like the `held` atlas)
const GRIP: readonly [number, number] = [-3, -5]; // hand-grip anchor, like the axe's (frameMeta)

/**
 * Paint the rod icon (128x128, pure — no DOM). A diagonal rod from the bottom-left butt to the
 * top-right tip, a cork grip and a metal reel near the butt, a pale line hanging from the tip
 * with a small hook. The rod fills most of the frame so it still reads at 24px.
 */
export function paintFishingRodIconPixels(): { width: number; height: number; pixels: Uint8ClampedArray } {
  const px = new Px(128, 128);
  const ang = Math.atan2(28 - 100, 100 - 28); // butt (28,100) -> tip (100,28): -45 degrees
  // Ground shadow under the butt.
  px.ellipse(30, 108, 16, 4, SHADOW, null);
  // Rod: butt section (thicker) + tip section (thinner) — a stepped taper along the diagonal.
  px.ellipseRot(46, 82, 27, 4.5, ang, BARK);
  px.ellipseRot(82, 46, 27, 3, ang, BARK);
  // Sheen along the top edge.
  px.line(30, 96, 98, 28, BARK_LIGHT);
  // Cork grip at the butt.
  px.ellipseRot(32, 96, 8, 5, ang, CUT);
  // Reel: a dark-metal circle below the rod near the butt, with a lighter hub.
  px.ellipse(40, 102, 7, 7, METAL);
  px.ellipse(40, 102, 3, 3, METAL_LIGHT, null);
  // Line hanging from the tip, with a small hook at the end.
  px.line(100, 28, 104, 52, LINE);
  px.ellipse(104, 56, 3, 4, METAL, null);
  px.line(104, 56, 108, 52, METAL);
  return { width: 128, height: 128, pixels: px.data };
}

/**
 * Painted 128px rod icon -> PNG data URL via a document canvas (sync); undefined when no canvas
 * exists (jsdom / headless). The browser downscales the 128px PNG into the 24px slot box
 * (image-rendering:pixelated in iconImg).
 */
export function fishingRodIconDataUrl(doc?: Document): string | undefined {
  try {
    const d = doc ?? (globalThis as { document?: Document }).document;
    if (!d) return undefined;
    const { width, height, pixels } = paintFishingRodIconPixels();
    const data = new ImageData(new Uint8ClampedArray(pixels), width, height);
    const cv = d.createElement("canvas"); cv.width = width; cv.height = height;
    const ctx = cv.getContext("2d");
    if (!ctx) return undefined;
    ctx.putImageData(data, 0, 0);
    const url = cv.toDataURL("image/png");
    return url && url !== "data:," ? url : undefined;
  } catch { return undefined; }
}

/** One override rule: the [data-icon="fishing_rod"] span shows the painted PNG, centred and contained. */
export function fishingRodMenuIconsCss(url: string): string {
  return `[data-icon="fishing_rod"]{--cz-icon:url("${url}");--cz-ipos:center;--cz-isize:contain}`;
}

/**
 * Install the rod icon: paint it, register the PNG in ICON_DATA under `fishing_rod.png`
 * (so iconImg/iconUrl serve it like the embedded ic_ icons), and append (or replace) the
 * <style id="fishing-rod-icons"> override rule for [data-icon="fishing_rod"] spans. Idempotent;
 * safe no-op (returns false, registers nothing) when no canvas exists and no URLs are supplied.
 * `urls` is a test seam — production callers omit it and the icon is painted from the canvas.
 */
export function installFishingRodIcon(doc?: Document, urls?: ReadonlyMap<string, string>): boolean {
  const d = doc ?? (globalThis as { document?: Document }).document;
  if (!d) return false;
  const url = urls?.get(FISHING_ROD_ICON_FILE) ?? fishingRodIconDataUrl(d);
  if (!url) return false;
  ICON_DATA[FISHING_ROD_ICON_FILE] = url;
  let style = d.getElementById("fishing-rod-icons") as HTMLStyleElement | null;
  if (!style) { style = d.createElement("style"); style.id = "fishing-rod-icons"; d.head.appendChild(style); }
  style.textContent = fishingRodMenuIconsCss(url);
  return true;
}

/**
 * Paint one held rod in frame `f` (facing 0..7). The grip sits at the sprite anchor's grip point
 * (24 + GRIP.x, 36 + GRIP.y = 21, 31 — the hand), and the rod angles up-forward along the facing
 * ground direction (TASK34_DIR_VEC[f], lifted by -0.9 so the tip points up, not along the ground),
 * 26 px long with a 4 px butt behind the grip. A pale line hangs from the tip with a tiny hook.
 * The rod stays inside the 48x48 frame at every facing (the direction is normalised first).
 */
export function paintRodCell(px: Px, ox: number, f: number): void {
  const [dx, dy] = TASK34_DIR_VEC[f & 7]!;
  const len = Math.hypot(dx, dy - 0.9);
  const ux = dx / len, uy = (dy - 0.9) / len;
  const gx = ox + 24 + GRIP[0], gy = 36 + GRIP[1];
  const ang = Math.atan2(uy, ux);
  // Rod: butt section (thicker, behind + ahead of the grip) + tip section (thinner).
  px.ellipseRot(gx + ux * 5, gy + uy * 5, 9, 2, ang, BARK);
  px.ellipseRot(gx + ux * 18, gy + uy * 18, 9, 1.3, ang, BARK);
  // Sheen along the top edge (1 px above the rod axis).
  px.line(Math.round(gx - ux * 2 - uy), Math.round(gy - uy * 2 + ux), Math.round(gx + ux * 25 - uy), Math.round(gy + uy * 25 + ux), BARK_LIGHT);
  // Line hanging from the tip, with a tiny hook.
  const tx = gx + ux * 26, ty = gy + uy * 26;
  px.line(Math.round(tx), Math.round(ty), Math.round(tx), Math.round(ty + 6), LINE);
  px.ellipse(Math.round(tx), Math.round(ty + 8), 1.5, 2, METAL, null);
}

/** Paint the whole rod atlas (8 frames in a row, 384x48), pure — no DOM. */
export function paintRodPixels(): { width: number; height: number; pixels: Uint8ClampedArray } {
  const px = new Px(FRAME * 8, FRAME);
  for (let f = 0; f < 8; f++) paintRodCell(px, f * FRAME, f);
  return { width: FRAME * 8, height: FRAME, pixels: px.data };
}

/** Rasterized pixels -> PNG blob URL (the task34/task256/task355 copy; undefined when no canvas exists). */
async function canvasToBlobURL(w: number, h: number, pixels: Uint8ClampedArray): Promise<string | undefined> {
  try {
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
 * Atlas sources for the held-rod atlas (same { url, emissiveUrl } shape as sourcesFromManifest).
 * view.ts merges this over the manifest's debug path before setRegistry, so the registry's
 * held_fishing_rod sprite draws the painted pixels. Returns an empty map in a canvas-less environment.
 */
export async function rodAtlasSources(): Promise<Map<string, AtlasSource>> {
  const out = new Map<string, AtlasSource>();
  const a = paintRodPixels();
  const url = await canvasToBlobURL(a.width, a.height, a.pixels);
  if (url) out.set(ROD_ATLAS_KEY, { url, emissiveUrl: null });
  return out;
}
