/** 2:1 dimetric isometric projection. World = float tile-grid units (x, y), z = height in tiles. Geographic axes live in geography.ts. */
export interface IsoConfig { tileW: number; tileH: number; zStep: number;
  /** ADR-253 camera view rotation in quarter turns (0..3, default 0). World (x, y) is rotated by R_view (+90° per step:
   *  (x, y) -> (-y, x)) into view space (u, v) before the 2:1 projection; painter depth is u + v. Renderer-local: the
   *  client mutates its renderer's own IsoConfig copy, never DEFAULT_ISO. */
  view?: number }
export const DEFAULT_ISO: IsoConfig = { tileW: 64, tileH: 32, zStep: 16 };
/**
 * Height convention: 1 terrain level = zStep (16 px); 1 building floor = FLOOR_HEIGHT_LEVELS terrain levels (ADR-511: walls are
 * 80 px tall, was 3 levels / 48 px). Transform.z is in terrain levels; BuildingGrid z is a floor index. Roofs of floor f sit at terrain level (f+1)*5.
 */
export const FLOOR_HEIGHT_LEVELS = 5;
/** Terrain-level z of the bottom of building floor `floor` above a base terrain height. */
export const floorToTerrainZ = (floor: number, baseZ = 0): number => baseZ + floor * FLOOR_HEIGHT_LEVELS;
/** Building floor index containing terrain-level z (relative to base terrain height). */
export const terrainZToFloor = (z: number, baseZ = 0): number => Math.max(0, Math.floor((z - baseZ + 1e-6) / FLOOR_HEIGHT_LEVELS));
/** ADR-253: cos / sin of the view rotation per quarter (exact integers: no float drift in projections or keys). */
export const VIEW_COS: readonly number[] = [1, 0, -1, 0];
export const VIEW_SIN: readonly number[] = [0, 1, 0, -1];
/** Quarter turns 0..3 of any integer (negative / > 3 wrap). */
export const viewQuarter = (q: number | undefined): number => ((Math.round(q ?? 0) % 4) + 4) % 4;
/** ADR-253: world (x, y) -> view space (u, v) for quarter q. */
export function toView(x: number, y: number, q: number): { u: number; v: number } {
  const k = q & 3, c = VIEW_COS[k]!, s = VIEW_SIN[k]!; return { u: c * x - s * y, v: s * x + c * y };
}
/** ADR-253: view space (u, v) -> world (x, y) for quarter q (inverse of toView). */
export function fromView(u: number, v: number, q: number): { x: number; y: number } {
  const k = q & 3, c = VIEW_COS[k]!, s = VIEW_SIN[k]!; return { x: c * u + s * v, y: -s * u + c * v };
}
/**
 * ADR-253: an axis-aligned world tile rect [ax, ax+fw) x [ay, ay+fh) in view space (the same cells, rotated): the view
 * rect's min corner and size. Tile grid maps to tile grid (tile (tx, ty) under q1 is view cell (-ty-1, tx)).
 */
export function viewRect(ax: number, ay: number, fw: number, fh: number, q: number): { x: number; y: number; w: number; h: number } {
  switch (q & 3) {
    case 1: return { x: -ay - fh, y: ax, w: fh, h: fw };
    case 2: return { x: -ax - fw, y: -ay - fh, w: fw, h: fh };
    case 3: return { x: ay, y: -ax - fw, w: fh, h: fw };
    default: return { x: ax, y: ay, w: fw, h: fh };
  }
}
/** ADR-253: a world facing angle (atan2(dy, dx), radians) as seen in view space (what directional art should show). */
export const viewFacing = (facing: number, q: number): number => facing + (q & 3) * (Math.PI / 2);
export function worldToScreen(x: number, y: number, z = 0, c: IsoConfig = DEFAULT_ISO): { sx: number; sy: number } {
  const k = (c.view ?? 0) & 3; const u = VIEW_COS[k]! * x - VIEW_SIN[k]! * y, v = VIEW_SIN[k]! * x + VIEW_COS[k]! * y;
  return { sx: (u - v) * (c.tileW / 2), sy: (u + v) * (c.tileH / 2) - z * c.zStep };
}
/** Inverse at a given z plane (default ground). */
export function screenToWorld(sx: number, sy: number, z = 0, c: IsoConfig = DEFAULT_ISO): { x: number; y: number } {
  const a = sx / (c.tileW / 2); const b = (sy + z * c.zStep) / (c.tileH / 2);
  const u = (a + b) / 2, v = (b - a) / 2; const k = (c.view ?? 0) & 3;
  return k === 0 ? { x: u, y: v } : { x: VIEW_COS[k]! * u + VIEW_SIN[k]! * v, y: -VIEW_SIN[k]! * u + VIEW_COS[k]! * v };
}
export const screenToTile = (sx: number, sy: number, c: IsoConfig = DEFAULT_ISO): { tx: number; ty: number } => {
  const w = screenToWorld(sx, sy, 0, c); return { tx: Math.floor(w.x), ty: Math.floor(w.y) };
};
/** Painter's sort key: larger draws later. */
export const isoDepth = (x: number, y: number, z = 0, view = 0): number => { const p = toView(x, y, view); return p.u + p.v + z * 0.001; };
