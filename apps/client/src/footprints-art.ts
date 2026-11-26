// ADR-455: footprints' own sprite, painted at runtime (no PNG file on disk — the snapshot push
// route carries text only, and the pack pipeline cannot ship new binary art).
//
// A footprint is NOT a dirt-road decal with a tint: it is a single boot print (sole + toe ball +
// heel pad), so it gets dedicated pixels, painted with the same tiny software canvas as the ADR-387
// Guide book icon and the ADR-457 wet-wood icon (Px, ./task34-art.ts). The print is a dark,
// semi-transparent mark that reads on both white snow and brown mud; it is painted pre-sheared for
// the iso ground plane (the Flat flag only fixes the depth key — the art itself must already be an
// iso-aligned oval, like the road decals), one frame per facing (8 directions, the bee's
// TASK34_DIR_VEC convention: frame f points along the facing-f ground direction). Nothing here
// tints or reuses another sprite, and no sprite is reused for a different thing — a footprint is a
// footprint.
//
// Installed once at startup (view.ts, next to the task34/task256/task355 atlas sources): the painted
// PNG is registered as the `footprint` atlas source, so the registry's footprint sprite draws the
// painted pixels. The fragment (pack/task455/manifest.task455.json) carries layout only. Idempotent;
// safe no-op (returns an empty map) when no canvas exists. A future binary art pass should ship a
// real footprint atlas and remove footprintAtlasSources().
import { Px, TASK34_DIR_VEC } from "./task34-art.js";
import { type PaintedCacheEnv } from "./painted-cache.js";
import { defaultAssemble, paintPaintedGroup, type PaintWorkerPool } from "./painted-core.js";
import type { AtlasSource } from "@engine/render";

/** The atlas key (fragment + painter agree) and the sprite key the renderer resolves. */
export const FOOTPRINT_ATLAS_KEY = "footprint";
export const FOOTPRINT_SPRITE_KEY = "footprint";
/** ADR-501: the animal track's own atlas + sprite key (same fragment/painter contract as the boot print). */
export const TRACK_ATLAS_KEY = "animal_track";
export const TRACK_SPRITE_KEY = "animal_track";

type RGBA = readonly [number, number, number, number?];
const PRINT: RGBA = [46, 38, 30, 200]; // dark warm grey-brown print, semi-transparent (ground shows through)
const PRINT_DARK: RGBA = [30, 24, 18, 210]; // toe ball / heel pad, a touch darker
const FRAME = 64; // one 64x64 frame per facing; the print is ~26px long (~0.4 tiles) inside it

/**
 * Paint one boot print in frame `f` (facing 0..7), pointing along TASK34_DIR_VEC[f] (the facing-f
 * ground direction, already iso-sheared: (0.894, 0.447) is world (1,0)). The sole is an elongated
 * ellipse along the facing axis, the toe ball a wider ellipse at the front, the heel pad a smaller
 * ellipse at the back with a gap for the arch — so the print reads as a boot from any angle and the
 * left/right alternation comes from the stamp's lateral offset, not from mirroring the sprite.
 */
export function paintFootprintCell(px: Px, ox: number, f: number): void {
  const [dx, dy] = TASK34_DIR_VEC[f & 7]!;
  const ang = Math.atan2(dy, dx);
  const cx = ox + FRAME / 2, cy = FRAME / 2;
  // Sole: the main print, slightly forward of centre, long axis along the facing.
  px.ellipseRot(cx + dx * 3, cy + dy * 3, 13, 5, ang, PRINT, null);
  // Toe ball: the wide front of the boot.
  px.ellipseRot(cx + dx * 11, cy + dy * 11, 6.5, 5, ang, PRINT_DARK, null);
  // Heel pad: smaller, behind, with a gap for the arch.
  px.ellipseRot(cx - dx * 11, cy - dy * 11, 5.5, 4.5, ang, PRINT_DARK, null);
}

/** Paint the whole footprint atlas (8 frames in a row, 512x64), pure — no DOM. */
export function paintFootprintPixels(): { width: number; height: number; pixels: Uint8ClampedArray } {
  const px = new Px(FRAME * 8, FRAME);
  for (let f = 0; f < 8; f++) paintFootprintCell(px, f * FRAME, f);
  return { width: FRAME * 8, height: FRAME, pixels: px.data };
}

/**
 * ADR-501: paint one animal track in frame `f` — two small iso-aligned ovals along the facing
 * axis, in the same colours as the boot print so it reads on both white snow and brown mud. The
 * front pad is a touch larger than the rear pad, so the track has a direction (like the boot's
 * toe/heel), and the left/right alternation comes from the stamp's lateral offset, not from
 * mirroring the sprite. Deliberately smaller than the boot print (~24 px long vs ~37 px): a track
 * is a paw, not a boot. One generic track in v1 — per-species tracks (hoof vs paw vs claw) are a
 * follow-up art task, not part of this ADR.
 */
export function paintTrackCell(px: Px, ox: number, f: number): void {
  const [dx, dy] = TASK34_DIR_VEC[f & 7]!;
  const ang = Math.atan2(dy, dx);
  const cx = ox + FRAME / 2, cy = FRAME / 2;
  // Front pad: the larger leading oval.
  px.ellipseRot(cx + dx * 7, cy + dy * 7, 5, 3.5, ang, PRINT_DARK, null);
  // Rear pad: smaller, behind, with a gap between the pads.
  px.ellipseRot(cx - dx * 7, cy - dy * 7, 4.5, 3.5, ang, PRINT, null);
}

/** Paint the whole track atlas (8 frames in a row, 512x64), pure — no DOM. */
export function paintTrackPixels(): { width: number; height: number; pixels: Uint8ClampedArray } {
  const px = new Px(FRAME * 8, FRAME);
  for (let f = 0; f < 8; f++) paintTrackCell(px, f * FRAME, f);
  return { width: FRAME * 8, height: FRAME, pixels: px.data };
}

/**
 * ADR-550: content-hash inputs — the rasterizer + the decal cell painter's source.
 */
const FOOTPRINT_SPEC = `${Px.toString()}|${paintFootprintCell.toString()}`;
const TRACK_SPEC = `${Px.toString()}|${paintTrackCell.toString()}`;

/** ADR-551: content-hash inputs (exported for `painted-core.ts` + `painted-parallel.ts`). */
export const footprintSpecs = (): Map<string, string> => new Map([[FOOTPRINT_ATLAS_KEY, FOOTPRINT_SPEC]]);
export const trackSpecs = (): Map<string, string> => new Map([[TRACK_ATLAS_KEY, TRACK_SPEC]]);

/**
 * Atlas sources for the footprint atlas (same { url, emissiveUrl } shape as sourcesFromManifest).
 * view.ts merges this over the manifest's debug path before setRegistry, so the registry's footprint
 * sprite draws the painted pixels. Returns an empty map in a canvas-less environment.
 */
export async function footprintAtlasSources(env: PaintedCacheEnv = {}, pool?: PaintWorkerPool): Promise<Map<string, AtlasSource>> {
  // ADR-551: thin delegate to `painted-core.ts` (cache-first, groups in parallel, misses in a Worker).
  return paintPaintedGroup({ name: "footprint", specs: footprintSpecs, paint: () => [{ key: FOOTPRINT_ATLAS_KEY, ...paintFootprintPixels() }], assemble: defaultAssemble }, env, pool);
}

/** ADR-501: atlas sources for the animal-track atlas (same contract as footprintAtlasSources). */
export async function trackAtlasSources(env: PaintedCacheEnv = {}, pool?: PaintWorkerPool): Promise<Map<string, AtlasSource>> {
  // ADR-551: thin delegate to `painted-core.ts` (cache-first, groups in parallel, misses in a Worker).
  return paintPaintedGroup({ name: "track", specs: trackSpecs, paint: () => [{ key: TRACK_ATLAS_KEY, ...paintTrackPixels() }], assemble: defaultAssemble }, env, pool);
}
