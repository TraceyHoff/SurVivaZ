/**
 * ADR-257: unique wild lettuce / hay plant art + hay item icons (wheat already has dedicated pack frames).
 * Painted at runtime like Task 34 — no binary PNGs in the push snapshot. Distinct silhouettes so hay is never
 * a wheat sheaf and lettuce is never a tinted carrot/herb. Art & Assets can replace these by shipping real
 * pack sprites under the same keys (resolveSprite prefers a pack hit).
 */
import type { AtlasSource } from "@engine/render";
import { Px } from "./task34-art.js";
import { type PaintedCacheEnv } from "./painted-cache.js";
import { defaultAssemble, paintPaintedGroup, type PaintWorkerPool } from "./painted-core.js";

export const TASK256_ATLAS_KEYS = ["crops_task256"] as const;

type RGBA = readonly [number, number, number, number?];
const OUTLINE: RGBA = [40, 30, 50];
const shade = (c: RGBA, k: number): RGBA => [
  Math.max(0, Math.min(255, Math.round(c[0] * k))),
  Math.max(0, Math.min(255, Math.round(c[1] * k))),
  Math.max(0, Math.min(255, Math.round(c[2] * k))),
  c[3] ?? 255,
];

/** Frame indices in crops_task256 (8×4 grid of 64px; first row holds frames 0–7). */
export const Task256Frame = {
  wildLettuce: 0,
  cropLettuce: 1,
  wildLettuceEmpty: 2,
  wildHay: 3,
  cropHay: 4,
  wildHayEmpty: 5,
  hayItem: 6,
  haySeeds: 7,
} as const;

function paintLettuce(px: Px, ox: number, oy: number, mature: boolean, empty: boolean): void {
  const cx = ox + 32, cy = oy + 40;
  if (empty) {
    // Cut stump / pale core left behind
    px.shape(cx - 6, cy - 4, 12, 8, (x, y) => (x - cx) ** 2 / 36 + (y - cy) ** 2 / 16 <= 1, [120, 140, 90]);
    return;
  }
  const leaf = mature ? [70, 170, 85] as RGBA : [95, 195, 110] as RGBA;
  const dark = shade(leaf, 0.72);
  // Rosette: several overlapping ovals (butterhead), not a carrot-patch mound
  const lobes: readonly (readonly [number, number, number, number])[] = mature
    ? [[-14, -2, 16, 10], [14, -2, 16, 10], [0, -12, 14, 12], [-10, 8, 14, 9], [10, 8, 14, 9], [0, 2, 18, 12]]
    : [[-10, 0, 12, 8], [10, 0, 12, 8], [0, -8, 11, 10], [0, 4, 14, 9]];
  for (const [dx, dy, w, h] of lobes) {
    px.shape(cx + dx - w / 2, cy + dy - h / 2, w, h,
      (x, y) => ((x - (cx + dx)) ** 2) / ((w / 2) ** 2) + ((y - (cy + dy)) ** 2) / ((h / 2) ** 2) <= 1,
      leaf, OUTLINE);
  }
  // Heart
  px.shape(cx - 5, cy - 4, 10, 8, (x, y) => ((x - cx) ** 2) / 25 + ((y - cy) ** 2) / 16 <= 1, dark, null);
  // Ground shadow
  px.shape(cx - 16, oy + 54, 32, 6, (x, y) => ((x - cx) ** 2) / 256 + ((y - (oy + 57)) ** 2) / 9 <= 1, [0, 0, 0, 50], null);
}

function paintHay(px: Px, ox: number, oy: number, bale: boolean, empty: boolean): void {
  const cx = ox + 32, cy = oy + 38;
  if (empty) {
    px.ellipse(cx, cy + 2, 10, 3, [140, 120, 70], OUTLINE);
    return;
  }
  const straw: RGBA = bale ? [210, 175, 70] : [195, 160, 60];
  const dark = shade(straw, 0.75);
  const twine: RGBA = [120, 90, 50];
  if (bale) {
    // Rectangular tied bale (clearly not a wheat grain head)
    px.rect(cx - 18, cy - 12, 36, 28, straw, OUTLINE);
    px.rect(cx - 2, cy - 12, 4, 28, twine, null);
    px.rect(cx - 18, cy - 2, 36, 3, twine, null);
    for (let i = 0; i < 5; i++) px.rect(cx - 14, cy - 8 + i * 5, 28, 1, dark, null);
  } else {
    // Wild standing dried-grass clump: many vertical blades, no wheat ear
    for (let i = -4; i <= 4; i++) {
      const h = 22 + (Math.abs(i) % 3) * 4;
      const x = cx + i * 3;
      px.rect(x, cy + 8 - h, 2, h, i % 2 ? straw : dark, null);
      px.set(x, cy + 8 - h - 1, OUTLINE);
    }
    px.ellipse(cx, cy + 10, 12, 4, dark, OUTLINE);
  }
  px.ellipse(cx, oy + 56, 14, 2.5, [0, 0, 0, 45], null);
}

function paintHayItem(px: Px, ox: number, oy: number): void {
  // Compact inventory bale
  paintHay(px, ox, oy - 4, true, false);
}

function paintHaySeeds(px: Px, ox: number, oy: number): void {
  const cx = ox + 32, cy = oy + 32;
  // Small pouch of loose straw seeds — not the wheat grain pile (frame 8)
  px.shape(cx - 12, cy - 8, 24, 20, (x, y) => ((x - cx) ** 2) / 144 + ((y - cy) ** 2) / 100 <= 1, [180, 150, 70], OUTLINE);
  for (const [dx, dy] of [[-6, -2], [0, 2], [6, -4], [-2, 6], [5, 5]] as const) {
    px.set(cx + dx, cy + dy, [230, 200, 90]);
    px.set(cx + dx + 1, cy + dy, [200, 160, 60]);
  }
}

export interface PaintedAtlas { key: string; width: number; height: number; pixels: Uint8ClampedArray }

/** 8×4 grid of 64px cells → 512×256 atlas (matches nature_icons dummy PNG size). */
export function paintTask256Atlases(): PaintedAtlas[] {
  const px = new Px(512, 256);
  const cell = (i: number): [number, number] => [(i % 8) * 64, Math.floor(i / 8) * 64];
  let x: number, y: number;
  [x, y] = cell(Task256Frame.wildLettuce); paintLettuce(px, x, y, false, false);
  [x, y] = cell(Task256Frame.cropLettuce); paintLettuce(px, x, y, true, false);
  [x, y] = cell(Task256Frame.wildLettuceEmpty); paintLettuce(px, x, y, false, true);
  [x, y] = cell(Task256Frame.wildHay); paintHay(px, x, y, false, false);
  [x, y] = cell(Task256Frame.cropHay); paintHay(px, x, y, true, false);
  [x, y] = cell(Task256Frame.wildHayEmpty); paintHay(px, x, y, false, true);
  [x, y] = cell(Task256Frame.hayItem); paintHayItem(px, x, y);
  [x, y] = cell(Task256Frame.haySeeds); paintHaySeeds(px, x, y);
  return [{ key: "crops_task256", width: 512, height: 256, pixels: px.data }];
}

/**
 * ADR-550: content-hash input — the rasterizer + crop painters' source (literal colours count).
 */
const TASK256_SPEC = `${Px.toString()}|${paintLettuce.toString()}|${paintHay.toString()}|${paintHayItem.toString()}|${paintHaySeeds.toString()}|${JSON.stringify(Task256Frame)}`;
export const task256Specs = (): Map<string, string> => new Map(TASK256_ATLAS_KEYS.map((k) => [k, TASK256_SPEC]));

/** ADR-551: thin delegate to `painted-core.ts` (cache-first, groups in parallel, misses in a Worker). */
export async function task256AtlasSources(env: PaintedCacheEnv = {}, pool?: PaintWorkerPool): Promise<Map<string, AtlasSource>> {
  return paintPaintedGroup({ name: "task256", specs: task256Specs, paint: paintTask256Atlases, assemble: defaultAssemble }, env, pool);
}
