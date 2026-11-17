/**
 * ADR-414: terrain height on the Canvas2D fallback path — the renderer Xbox Edge lands on when WebGL2
 * cannot be created (e.g. after a GPU reset; see canvas2d.ts chooseRenderer / the ADR-407 console notes).
 *
 * Root cause: the WebGL2 tilemap mesh expresses height through vertex z (1-level slopes tilt the top
 * face via classifyGroundShape corner drops, deeper drops get cliff faces), but Canvas2D drew every
 * ground tile as a flat diamond at z = 0 and never read tile heights — slope.ts even documents it
 * ("Canvas2D keeps flat diamonds (fallback renderer only) — not wired to this model yet"). So on the
 * console fallback the ground read flat while the same build showed slopes and cliffs on the phone
 * (WebGL2). The quality tier is not the cause: the WebGL2 mesh draws height at every tier.
 *
 * This module is the shared geometry both Canvas2D ground paths use, so the fallback expresses the
 * same model as the mesh: the flat-diamond path draws the tilted top quad + cliff faces, and the
 * gt-block path offsets each cell vertically by its height and fills the cliff faces the art skirt
 * does not cover. Pure (no renderer state): the renderer owns colours (groundColor / cliffColor) and
 * passes them in. The 2D polygons are tile-local px, origin = the diamond centre at height 0
 * (C2D centres tile (x, y) on the view point (x, y)); y down, 16 px per terrain level (DEFAULT_ISO).
 */
import { CHUNK_SIZE, DEFAULT_ISO, SLOPE_VOID, classifyGroundShape, isWaterId, renderTileHeight, tileToChunk, tileToLocal, type TileMap } from "@engine/world";

/** A 2D point in tile-local px. */
export type C2DVec = [number, number];
/** View-space edge indices: 0 = +u, 1 = -u, 2 = +v, 3 = -v (the caller's axes, as in world/slope.ts). */
export type C2DSide = 0 | 1 | 2 | 3;

export interface C2DGroundGeom {
  /** Top-face corners [T, R, B, L] (tile-local px): each corner sits at its dropped height, so a ramp / wedge tilts exactly like the mesh top face. */
  top: [C2DVec, C2DVec, C2DVec, C2DVec];
  /** Cliff faces on sides whose neighbour is lower (and which are not slope sides — the tilted top meets the low neighbour there). */
  faces: { poly: C2DVec[]; side: C2DSide; /** neighbour render height the face drops to (fractional for water: the 0.25 inset). */ low: number }[];
  /** Lowest neighbour height among the drawn faces (the centre height when there are none). */
  minLow: number;
}

/** Cliff-face shade by side (tilemap.ts cliffShade: +u 0.62, +v 0.8, far sides CLIFF_HIDDEN_SHADE 0.28). */
export const C2D_CLIFF_SHADE_U = 0.62, C2D_CLIFF_SHADE_V = 0.8, C2D_CLIFF_SHADE_FAR = 0.28;
export function c2dCliffShade(side: C2DSide): number { return side === 0 ? C2D_CLIFF_SHADE_U : side === 2 ? C2D_CLIFF_SHADE_V : C2D_CLIFF_SHADE_FAR; }

/** Render height of one world tile (tilemap.ts tileHeight, but undefined instead of NO_TILE_HEIGHT when missing / empty). Water reads its flat surface height (0). */
export function c2dTileHeight(tm: TileMap, x: number, y: number): number | undefined {
  const c = tm.getChunk(tileToChunk(x), tileToChunk(y)); if (!c) return undefined;
  const i = tileToLocal(y) * CHUNK_SIZE + tileToLocal(x);
  return c.tiles[i] === 0 ? undefined : renderTileHeight(c.tiles[i]!, c.height[i]!);
}

/** Neighbour height for cliff / slope decisions (tilemap.ts low(): water carries the 0.25 surface inset, so a shore is a 0.25 drop, never a slope). Undefined = void / missing tile. */
export function c2dNeighbourLow(tm: TileMap, x: number, y: number): number | undefined {
  const h = c2dTileHeight(tm, x, y); if (h === undefined) return undefined;
  return h - (isWaterId(tm.getTile(x, y)) ? 0.25 : 0);
}

/**
 * Height-aware ground geometry for one tile: the tilted top quad + cliff faces, in the caller's axes
 * (view space in both Canvas2D callers). `low(dx, dy)` is the neighbour render height with the water
 * inset applied (c2dNeighbourLow), undefined for a void / missing neighbour. The shape comes from
 * world/slope.ts classifyGroundShape, so the flat path and the mesh agree corner for corner.
 */
export function c2dGroundGeometry(z: number, low: (dx: number, dy: number) => number | undefined): C2DGroundGeom {
  const tw = DEFAULT_ISO.tileW, th = DEFAULT_ISO.tileH, zs = DEFAULT_ISO.zStep;
  const e = (dx: number, dy: number): number => { const v = low(dx, dy); return v === undefined ? SLOPE_VOID : v; };
  const rawE = [low(1, 0), low(-1, 0), low(0, 1), low(0, -1)] as (number | undefined)[];
  const shape = classifyGroundShape({ h: z, edge: [e(1, 0), e(-1, 0), e(0, 1), e(0, -1)], diag: [e(1, -1), e(1, 1), e(-1, 1), e(-1, -1)] });
  const corner = (i: 0 | 1 | 2 | 3, h: number): C2DVec => {
    const n0 = (v: number): number => (v === 0 ? 0 : v); // -16 * 0 is -0: vitest (and JSON) distinguish it from 0
    switch (i) {
      case 0: return [0, n0(-th / 2 - zs * h)];
      case 1: return [tw / 2, n0(-zs * h)];
      case 2: return [0, n0(th / 2 - zs * h)];
      default: return [-tw / 2, n0(-zs * h)];
    }
  };
  const top: C2DGroundGeom["top"] = [corner(0, z - shape.cornerDrops[0]!), corner(1, z - shape.cornerDrops[1]!), corner(2, z - shape.cornerDrops[2]!), corner(3, z - shape.cornerDrops[3]!)];
  const faces: C2DGroundGeom["faces"] = [];
  // Edge -> its two top corners (T=0, R=1, B=2, L=3): +u is R-B, -u is T-L, +v is L-B, -v is T-R.
  const edgeCorners: readonly (readonly [0 | 1 | 2 | 3, 0 | 1 | 2 | 3])[] = [[1, 2], [0, 3], [3, 2], [0, 1]];
  for (let s = 0; s < 4; s++) {
    const n = rawE[s]!; if (n === undefined || n >= z || shape.slopeSides.includes(s)) continue;
    const [c0, c1] = edgeCorners[s]!;
    faces.push({ poly: [corner(c0, z), corner(c1, z), corner(c1, n), corner(c0, n)], side: s as C2DSide, low: n });
  }
  return { top, faces, minLow: faces.reduce((m, f) => Math.min(m, f.low), z) };
}

/** Fill one polygon (tile-local coords + origin) in a flat colour. */
export function fillC2DPoly(g: CanvasRenderingContext2D, poly: readonly (readonly [number, number])[], ox: number, oy: number, style: string): void {
  g.fillStyle = style; g.beginPath();
  poly.forEach(([px, py], i) => { if (i) g.lineTo(ox + px, oy + py); else g.moveTo(ox + px, oy + py); });
  g.closePath(); g.fill();
}

/** A tile-local polygon shifted to absolute coords (for gt-block canvases, whose origin is the block origin). */
export function offsetC2DPoly(poly: readonly (readonly [number, number])[], ox: number, oy: number): C2DVec[] {
  return poly.map(([px, py]) => [px + ox, py + oy] as C2DVec);
}

/**
 * Draw one height-aware flat ground cell: far faces first (the tile top paints over their overlap,
 * as the mesh depth test does), then the tilted top, then the near faces. `cliffStyle` maps a side
 * to the caller's cliff colour (which already carries the c2dCliffShade for that side).
 */
export function drawC2DGroundCell(g: CanvasRenderingContext2D, geom: C2DGroundGeom, cx: number, cy: number, topStyle: string, cliffStyle: (side: C2DSide) => string): void {
  for (const f of geom.faces) if (f.side === 1 || f.side === 3) fillC2DPoly(g, f.poly, cx, cy, cliffStyle(f.side));
  fillC2DPoly(g, geom.top, cx, cy, topStyle);
  for (const f of geom.faces) if (f.side === 0 || f.side === 2) fillC2DPoly(g, f.poly, cx, cy, cliffStyle(f.side));
}

/**
 * ADR-414: gt-block height clamp (levels). A baked block canvas grows by the block's height range, so
 * shovel extremes (levels -300..326) are clamped to +/-32 levels (512 px each way) — worldgen relief
 * (<= ~26 levels) is never clamped, and an extreme pit / tower still reads as deep / high, just
 * compressed. Heights are clamped monotonically, so distinct heights stay distinct and faces still
 * meet the neighbour tops exactly.
 */
export const C2D_GT_Z_CLAMP = 32;
export const c2dClampHeight = (z: number): number => Math.max(-C2D_GT_Z_CLAMP, Math.min(C2D_GT_Z_CLAMP, z));

/** Vertical canvas padding (px) for a gt block whose clamped heights span [zLo, zHi]: the canvas is drawn topPad px above the block origin so z = 0 stays exactly where the flat block put it. */
export function c2dGtPads(zHi: number, zLo: number): { topPad: number; botPad: number } {
  const zs = DEFAULT_ISO.zStep;
  return { topPad: Math.max(0, zHi) * zs, botPad: Math.max(0, -zLo) * zs };
}

/**
 * Near-face polygon below the gt art skirt: the cell's own 16 px skirt already covers the first level
 * of a camera-facing drop, so only the part from z - 1 down to the neighbour height is filled (a
 * 1-level drop needs no fill at all). The face polygon is [P1(z), P2(z), P2(low), P1(low)]: the top
 * two vertices move down one level.
 */
export function c2dGtFaceBelowSkirt(poly: readonly (readonly [number, number])[]): [C2DVec, C2DVec, C2DVec, C2DVec] {
  const zs = DEFAULT_ISO.zStep;
  return [[poly[0]![0], poly[0]![1] + zs], [poly[1]![0], poly[1]![1] + zs], [poly[2]![0], poly[2]![1]], [poly[3]![0], poly[3]![1]]];
}
