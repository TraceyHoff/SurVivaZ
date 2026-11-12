// ADR-364: guide art — every picture the guide shows, composed from the game's own art, nothing invented.
//
// Two halves:
//  1. The section icons ADR-363 deferred: `pet:dog_lab` and `mount:horse` now resolve through the menus'
//     own `[data-icon]` mechanism — the rules live in gameplay-panels.css (hand-written after the generated
//     ICONS block, ADR-264/265 pattern), cropping the SW idle frame out of the shipped pet/mount atlases.
//     guide-panel.ts maps `pet:` -> `pet_<key>` and `mount:` -> `mount_<key>` the same way it maps the
//     other kinds. No runtime painting needed there: the atlases already ship.
//  2. Images of key actions (guide.json `{ image, caption }` items). Each image is a small composed scene:
//     a row of tiles, each tile a `[data-icon]` key — the same atlas art and runtime-painted icons the
//     menus already show (items_build / items_icons / items_pets cells, the ADR-357 store icons, the
//     ADR-361 vehicle/harness icons, the new pet/mount rules). The one tile with no menu-icon art is the
//     placement hologram: it is painted at runtime below, from the ore store's own world art (ADR-357
//     pattern), in the game's own ghost treatment (packages/render/src/ghost.ts + sprites.ts: the valid
//     ghost mixes the sprite toward green (0.3, 1.0, 0.4) by 0.68 at ~0.62 alpha) — so the guide shows the
//     hologram exactly as the game draws it, ghost next to the solid piece it becomes.
//
// No new sprites, no recolors, no binary art: every tile is a shipped sprite or a runtime painting of one.
// The ADR-364 tests pixel-check every tile (atlas cells decoded from the shipped PNGs, painted tiles from
// the painters) — manifest/CSS presence alone is never proof of pixels (the ADR-357 lesson).
import { paintStoreMenuIconPixels, type StoreMenuIconKey } from "./task355-art.js";

/** One action image: the `[data-icon]` keys of its tiles, left to right, and the join between them. */
export interface GuideActionImage {
  readonly id: string;
  readonly tiles: readonly string[];
  /** "+" joins things used together; "→" joins a before into its after (the hologram becoming a piece). */
  readonly join: "+" | "→";
}

/**
 * The six action images the guide shows (guide.json `{ image }` ids). Tiles are `[data-icon]` keys only:
 * - place-hologram: the runtime-painted ghost ore store (installed below) becoming the solid ore store
 *   (the ADR-357 runtime icon — the shipped items_build frame is blank, so the build menu's painted icon
 *   is the real art here, not the atlas cell).
 * - claim-base: the claim totem + clan flag atlas cells (items_build frames 72 and 226).
 * - cook-fire: the campfire piece + a bowl of stew (items_build frame 61, items_icons frame 197).
 * - tame-feed: the Labrador's own sprite + its favourite treat, a dog biscuit (items_pets frame 0).
 * - use-trough: the feeding trough + animal feed (items_build frame 263, items_icons frame 200).
 * - harness-mount: the horse's own sprite + the harness + a cart kit (both ADR-361 runtime icons).
 */
export const GUIDE_ACTION_IMAGES: readonly GuideActionImage[] = [
  { id: "place-hologram", tiles: ["guide_ghost_ore_store", "build_ore_store"], join: "→" },
  { id: "claim-base", tiles: ["build_claim_totem", "build_clan_flag"], join: "+" },
  { id: "cook-fire", tiles: ["build_campfire", "stew_bowl"], join: "+" },
  { id: "tame-feed", tiles: ["pet_dog_lab", "dog_biscuit"], join: "+" },
  { id: "use-trough", tiles: ["build_feeding_trough", "animal_feed"], join: "+" },
  { id: "harness-mount", tiles: ["mount_horse", "harness", "item_vehicle_kit_cart"], join: "+" },
];

/** One action image by id, or undefined. */
export function guideActionImage(id: string): GuideActionImage | undefined {
  return GUIDE_ACTION_IMAGES.find((g) => g.id === id);
}

// ---- the placement hologram (the only guide tile with no menu-icon art) -------------------------------

/** The store the hologram image places (its half-full front cell is the most readable at tile size). */
export const GUIDE_GHOST_STORE: StoreMenuIconKey = "ore_store";
/** The `[data-icon]` key the painted ghost is installed under. */
export const GUIDE_GHOST_ICON_KEY = "guide_ghost_ore_store";
/** The valid-ghost tint from packages/render/src/sprites.ts (mix toward green by 0.68, alpha ~0.62). */
export const GUIDE_GHOST_TINT: readonly [number, number, number] = [77, 255, 102];
export const GUIDE_GHOST_MIX = 0.68;
export const GUIDE_GHOST_ALPHA = 0.62;

const smoothstep = (lo: number, hi: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

/**
 * Paint the hologram tile: the ore store's half-full front cell (the same pixels as its menu icon) run
 * through the game's own ghost treatment — `col = mix(col, green, 0.68)`, `alpha = smoothstep(0.35, 0.75,
 * a) * 0.62` (the shader's alpha ramp, so the soft ground shadow drops out and only solid shapes ghost).
 * Pure — no DOM — and pixel-identical to the solid icon except for the ghost treatment (asserted in the
 * ADR-364 tests). The ghost is a rendering of an existing sprite, not a new sprite: the game draws every
 * placement preview this way.
 */
export function paintGuideGhostPixels(store: StoreMenuIconKey = GUIDE_GHOST_STORE): { width: number; height: number; pixels: Uint8ClampedArray } {
  const { width, height, pixels } = paintStoreMenuIconPixels(store);
  const out = new Uint8ClampedArray(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3]!;
    if (a === 0) continue;
    out[i] = Math.round(pixels[i]! * (1 - GUIDE_GHOST_MIX) + GUIDE_GHOST_TINT[0]! * GUIDE_GHOST_MIX);
    out[i + 1] = Math.round(pixels[i + 1]! * (1 - GUIDE_GHOST_MIX) + GUIDE_GHOST_TINT[1]! * GUIDE_GHOST_MIX);
    out[i + 2] = Math.round(pixels[i + 2]! * (1 - GUIDE_GHOST_MIX) + GUIDE_GHOST_TINT[2]! * GUIDE_GHOST_MIX);
    out[i + 3] = Math.round(255 * smoothstep(0.35, 0.75, a / 255) * GUIDE_GHOST_ALPHA);
  }
  return { width, height, pixels: out };
}

/**
 * Painted 128px ghost icon -> PNG data URL via a document canvas (sync); undefined when no canvas exists
 * (jsdom / headless). Same pattern as task355-art's storeMenuIconDataUrl.
 */
export function guideGhostDataUrl(store: StoreMenuIconKey = GUIDE_GHOST_STORE, doc?: Document): string | undefined {
  try {
    const d = doc ?? (globalThis as { document?: Document }).document;
    if (!d) return undefined;
    const { width, height, pixels } = paintGuideGhostPixels(store);
    // TS 5.9 (CI's pinned version) types ImageData's data as Uint8ClampedArray<ArrayBuffer>; our pixels
    // are Uint8ClampedArray<ArrayBufferLike>, so copy into a fresh ArrayBuffer-backed array.
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
 * One override rule for the ghost tile: the tile's --cz-icon becomes the painted PNG, centred and
 * contained in the tile box. Appended after the linked stylesheet, equal specificity wins over any
 * generated block (same [data-icon="..."] attribute selector, later in document order).
 */
export function guideArtCss(urls: ReadonlyMap<string, string>): string {
  const url = urls.get(GUIDE_GHOST_STORE);
  return url ? `[data-icon="${GUIDE_GHOST_ICON_KEY}"]{--cz-icon:url("${url}");--cz-ipos:center;--cz-isize:contain}` : "";
}

/**
 * Install the runtime guide art: paint the hologram ghost, build the override stylesheet, and append (or
 * replace) <style id="task364-guide-art"> in the document head. Idempotent; safe no-op (returns false,
 * appends nothing) when no canvas exists and no URLs are supplied. `urls` is a test seam — production
 * callers omit it and the ghost is painted from the canvas. Call once at startup, next to
 * installStoreMenuIcons / installVehicleMenuIcons in view.ts.
 */
export function installGuideArt(doc?: Document, urls?: ReadonlyMap<string, string>): boolean {
  const d = doc ?? (globalThis as { document?: Document }).document;
  if (!d) return false;
  const resolved = new Map<string, string>();
  const u = urls?.get(GUIDE_GHOST_STORE) ?? guideGhostDataUrl(GUIDE_GHOST_STORE, d);
  if (u) resolved.set(GUIDE_GHOST_STORE, u);
  if (resolved.size === 0) return false;
  const css = guideArtCss(resolved);
  let style = d.getElementById("task364-guide-art") as HTMLStyleElement | null;
  if (!style) { style = d.createElement("style"); style.id = "task364-guide-art"; d.head.appendChild(style); }
  style.textContent = css;
  return true;
}
