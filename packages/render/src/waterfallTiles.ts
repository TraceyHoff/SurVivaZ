/**
 * ADR-389: waterfall tile classification and the animated-tile art hook.
 *
 * Geometry follows ADR-386: a water tile's face is a fall when it drops >= WATERFALL_MIN_DROP
 * levels to a neighbour that exists (a missing / unloaded neighbour is never a fall). Roles:
 *   lip  — foam / spray / mist at the ledge (source water tile, flow direction)
 *   fall — the falling sheet (source tile, direction, drop height)
 *   pool — impact overlay (foam / mist) on top of the destination water tile, same flow dir as the sheet
 *
 * Art (e8c03108, docs/ART_KEYS_WATERFALL.md): unique packed keys
 *   gt_waterfall_{lip,sheet_1,sheet_2,pool}_{px,nx}
 * with py/ny drawn as flipX of px/nx. 6 frames @ 8 fps, anim `idle`. Until those sprites
 * are in the registry, planWaterfallArt returns [] and the ADR-386 mesh-face fallback stays.
 */
import { type TileMap } from "@engine/world";
import { isWaterTile } from "./ids.js";
import { NO_TILE_HEIGHT, WATERFALL_MIN_DROP, tileHeight } from "./tilemap.js";

/** World-space flow directions, same suffixes as ADR-386 cliff / waterfall flags. */
export const WATERFALL_DIRS = ["px", "py", "nx", "ny"] as const;
export type WaterfallDir = (typeof WATERFALL_DIRS)[number];
export const WATERFALL_DIR_DELTA: Record<WaterfallDir, readonly [number, number]> = {
  px: [1, 0], py: [0, 1], nx: [-1, 0], ny: [0, -1],
};
const OPPOSITE: Record<WaterfallDir, WaterfallDir> = { px: "nx", py: "ny", nx: "px", ny: "py" };
/** Packed unique art is only px / nx; py and ny are flipX mirrors (Art's page, not a second paint). */
export const packedWaterfallDir = (dir: WaterfallDir): { keyDir: "px" | "nx"; flipX: boolean } =>
  (dir === "px" || dir === "py") ? { keyDir: "px", flipX: dir === "py" } : { keyDir: "nx", flipX: dir === "ny" };

/** Mask bit 8: flip the instance on X (py/ny). Bits 1 and 2 stay the camera-facing skirt bits. */
export const WATERFALL_FLIP_X = 8;
export const WATERFALL_ART_MAX_DROP = 8;
export const WATERFALL_ANIM = "idle";
/** Authored loop Art shipped (the renderer uses whatever the manifest actually has). */
export const WATERFALL_EXPECT_FRAMES = 6;
export const WATERFALL_EXPECT_FPS = 8;
/** Terrain-instance art mode: full-frame fall sheet (no diamond / skirt discard). */
export const WATERFALL_ART_MODE = 3;
/** Lip / pool impact overlay: diamond decal, soft alpha, drawn on top of the dest/source water (not instead of it). */
export const WATERFALL_OVERLAY_MODE = 4;

export type WaterfallRole = "lip" | "fall" | "pool";
export interface WaterfallSeg {
  role: WaterfallRole;
  dir: WaterfallDir;
  /** Tile the sprite is anchored on (lip / fall = source water; pool = destination water). */
  x: number;
  y: number;
  topZ: number;
  botZ: number;
  drop: number;
}

export function tileSurfaceHeight(map: TileMap, x: number, y: number): number {
  const h = tileHeight(map, x, y);
  if (h <= NO_TILE_HEIGHT) return NO_TILE_HEIGHT;
  return h - (isWaterTile(map.getTile(x, y)) ? 0.25 : 0);
}
export const tileIsWaterAt = (map: TileMap, x: number, y: number): boolean => isWaterTile(map.getTile(x, y));

export function classifyWaterfallFaces(
  isWater: (x: number, y: number) => boolean,
  height: (x: number, y: number) => number,
  x: number,
  y: number,
): WaterfallSeg[] {
  const out: WaterfallSeg[] = [];
  if (!isWater(x, y)) return out;
  const z = height(x, y);
  if (z <= NO_TILE_HEIGHT) return out;
  for (const dir of WATERFALL_DIRS) {
    const [dx, dy] = WATERFALL_DIR_DELTA[dir]!;
    const nx = x + dx, ny = y + dy;
    const h = height(nx, ny);
    if (h <= NO_TILE_HEIGHT) continue;
    const drop = z - h;
    // Lip only on the real waterfall (>= 2, the breach / tiles[0] drop edge). Sheets: that face, plus
    // 1-level water-to-water steps that sit on a cascade after a >= 2 fall. Ordinary stream ledges stay bare.
    if (drop >= WATERFALL_MIN_DROP) out.push({ role: "lip", dir, x, y, topZ: z, botZ: h, drop });
    if (drop >= WATERFALL_MIN_DROP || (drop >= 1 && isWater(nx, ny) && feedsFromWaterfall(isWater, height, x, y))) {
      out.push({ role: "fall", dir, x, y, topZ: z, botZ: h, drop });
    }
  }
  for (const dir of WATERFALL_DIRS) {
    const [dx, dy] = WATERFALL_DIR_DELTA[dir]!;
    const sx = x + dx, sy = y + dy;
    if (!isWater(sx, sy)) continue;
    const h = height(sx, sy);
    if (h <= NO_TILE_HEIGHT) continue;
    const drop = h - z;
    // Pool uses the same flow dir as the sheet that lands here (source → dest), not the dir toward the source.
    const cascade = drop >= WATERFALL_MIN_DROP || (drop >= 1 && feedsFromWaterfall(isWater, height, sx, sy));
    if (cascade) out.push({ role: "pool", dir: OPPOSITE[dir], x, y, topZ: h, botZ: z, drop });
  }
  return out;
}

export function classifyWaterfallAt(map: TileMap, x: number, y: number): WaterfallSeg[] {
  return classifyWaterfallFaces((tx, ty) => tileIsWaterAt(map, tx, ty), (tx, ty) => tileSurfaceHeight(map, tx, ty), x, y);
}

/** Preferred unique (or flip-source) keys for a segment, first pick wins. */
export function waterfallArtKeys(seg: WaterfallSeg): string[] {
  const { keyDir } = packedWaterfallDir(seg.dir);
  if (seg.role === "lip") return [`gt_waterfall_lip_${keyDir}`];
  if (seg.role === "pool") return [`gt_waterfall_pool_${keyDir}`];
  const n = Math.max(1, Math.round(seg.drop));
  return n >= 2 ? [`gt_waterfall_sheet_2_${keyDir}`, `gt_waterfall_sheet_1_${keyDir}`] : [`gt_waterfall_sheet_1_${keyDir}`];
}

export function pickWaterfallArt(has: (key: string) => boolean, seg: WaterfallSeg): string | undefined {
  for (const k of waterfallArtKeys(seg)) if (has(k)) return k;
  return undefined;
}

export interface WaterfallFallSlice { z: number; key: string; flipX: boolean }

/**
 * Stack Art's 2-level sheet, then the 1-level sheet for any remainder. Do not stretch a sheet
 * (docs/ART_KEYS_WATERFALL.md). Taller than 2: sheet_2 + sheet_1 as needed.
 */
export function waterfallFallPlacements(seg: WaterfallSeg, has: (key: string) => boolean): WaterfallFallSlice[] {
  const { keyDir, flipX } = packedWaterfallDir(seg.dir);
  const k2 = `gt_waterfall_sheet_2_${keyDir}`, k1 = `gt_waterfall_sheet_1_${keyDir}`;
  const out: WaterfallFallSlice[] = [];
  let remaining = Math.max(1, Math.round(seg.drop));
  let z = seg.topZ;
  while (remaining > 0) {
    if (remaining >= 2 && has(k2)) { out.push({ z, key: k2, flipX }); z -= 2; remaining -= 2; continue; }
    if (has(k1)) { out.push({ z, key: k1, flipX }); z -= 1; remaining -= 1; continue; }
    if (has(k2)) { out.push({ z, key: k2, flipX }); break; }
    break;
  }
  return out;
}

/** World dir of the view-space +X / +Y face for camera quarter q (ADR-253). */
export const VIEW_PLUS_X: readonly WaterfallDir[] = ["px", "ny", "nx", "py"];
export const VIEW_PLUS_Y: readonly WaterfallDir[] = ["py", "px", "ny", "nx"];

export function viewMaskForWorldDir(dir: WaterfallDir, q: number): 0 | 1 | 2 {
  const i = q & 3;
  if (dir === VIEW_PLUS_X[i]) return 1;
  if (dir === VIEW_PLUS_Y[i]) return 2;
  return 0;
}

/** How far uphill a 1-level cascade may walk to find the originating >= 2 drop. */
const CASCADE_WALK = 8;

/** True when (x, y) is downhill of a real waterfall, possibly via 1-level water steps (the cascade after tiles[1]). */
function feedsFromWaterfall(
  isWater: (x: number, y: number) => boolean,
  height: (x: number, y: number) => number,
  x: number,
  y: number,
  seen: Set<number> = new Set(),
  depth = 0,
): boolean {
  if (depth > CASCADE_WALK) return false;
  const key = ((x + 0x8000) << 16) | ((y + 0x8000) & 0xffff);
  if (seen.has(key)) return false;
  seen.add(key);
  let stepped: Array<[number, number]> | undefined;
  for (const dir of WATERFALL_DIRS) {
    const [dx, dy] = WATERFALL_DIR_DELTA[dir]!;
    const sx = x + dx, sy = y + dy;
    if (!isWater(sx, sy)) continue;
    const h = height(sx, sy);
    if (h <= NO_TILE_HEIGHT) continue;
    const drop = h - height(x, y);
    if (drop >= WATERFALL_MIN_DROP) return true;
    if (drop >= 1) (stepped ??= []).push([sx, sy]);
  }
  if (!stepped) return false;
  for (const [sx, sy] of stepped) {
    if (feedsFromWaterfall(isWater, height, sx, sy, seen, depth + 1)) return true;
  }
  return false;
}

/** A face that should get a falling sheet: a >= 2 drop, or a 1-level water-to-water step on a cascade. */
export function isWaterfallSheetFace(
  isWater: (x: number, y: number) => boolean,
  height: (x: number, y: number) => number,
  x: number,
  y: number,
  dir: WaterfallDir,
): boolean {
  if (!isWater(x, y)) return false;
  const [dx, dy] = WATERFALL_DIR_DELTA[dir]!;
  const nx = x + dx, ny = y + dy;
  const h = height(nx, ny);
  if (h <= NO_TILE_HEIGHT) return false;
  const z = height(x, y);
  if (z <= NO_TILE_HEIGHT) return false;
  const drop = z - h;
  if (drop >= WATERFALL_MIN_DROP) return true;
  return drop >= 1 && isWater(nx, ny) && feedsFromWaterfall(isWater, height, x, y);
}

export function isWaterfallSheetAt(map: TileMap, x: number, y: number, dir: WaterfallDir): boolean {
  return isWaterfallSheetFace((tx, ty) => tileIsWaterAt(map, tx, ty), (tx, ty) => tileSurfaceHeight(map, tx, ty), x, y, dir);
}

/** True when Art's packed waterfall page is in the registry (one key is enough). */
export const waterfallArtResident = (has: (key: string) => boolean): boolean => has("gt_waterfall_sheet_2_px") || has("gt_waterfall_lip_px");

export function allWaterfallArtKeys(): string[] {
  const keys: string[] = [];
  for (const d of ["px", "nx"] as const) {
    keys.push(`gt_waterfall_lip_${d}`, `gt_waterfall_sheet_1_${d}`, `gt_waterfall_sheet_2_${d}`, `gt_waterfall_pool_${d}`);
  }
  return keys;
}

export interface WaterfallArtInstance {
  role: WaterfallRole;
  dir: WaterfallDir;
  key: string;
  x: number;
  y: number;
  z: number;
  /** 1 = view +X, 2 = view +Y, 0 = top-face decal (lip / pool). OR'd with WATERFALL_FLIP_X when py/ny. */
  mask: number;
  mode: number;
  flipX: boolean;
}

export function planWaterfallArt(
  map: TileMap, x: number, y: number, has: (key: string) => boolean, q = 0,
): WaterfallArtInstance[] {
  const out: WaterfallArtInstance[] = [];
  for (const seg of classifyWaterfallAt(map, x, y)) {
    const { flipX } = packedWaterfallDir(seg.dir);
    const flipBit = flipX ? WATERFALL_FLIP_X : 0;
    if (seg.role === "fall") {
      const bit = viewMaskForWorldDir(seg.dir, q); if (!bit) continue;
      for (const pl of waterfallFallPlacements(seg, has)) {
        out.push({ role: "fall", dir: seg.dir, key: pl.key, x, y, z: pl.z, mask: bit | flipBit, mode: WATERFALL_ART_MODE, flipX: pl.flipX });
      }
    } else {
      const key = pickWaterfallArt(has, seg); if (!key) continue;
      out.push({ role: seg.role, dir: seg.dir, key, x, y, z: seg.role === "pool" ? seg.botZ : seg.topZ, mask: flipBit, mode: WATERFALL_OVERLAY_MODE, flipX });
    }
  }
  return out;
}
