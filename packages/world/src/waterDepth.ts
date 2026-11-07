/**
 * ADR-181: two water depths without a new persisted tile. A water tile is SHALLOW when any land tile lies within
 * `radius` (Chebyshev) of it: shore bands, rivers and ponds. Otherwise it is DEEP (lake / sea centres). The explicit
 * shallow tile id (8, render TileId.ShallowWater) is always shallow. Tile 0 (not loaded / unknown) never counts as
 * land, so a lake at the edge of the loaded area reads as deep rather than flickering to shallow.
 * Gameplay (server + client prediction) and every renderer call this one function, so they always agree.
 */
export const WATER_TILE = 1, SHALLOW_WATER_TILE = 8;
export const WaterDepth = { None: 0, Shallow: 1, Deep: 2 } as const;
export type WaterDepth = (typeof WaterDepth)[keyof typeof WaterDepth];
export const SHALLOW_RADIUS = 2;

export function isWaterId(id: number): boolean { return id === WATER_TILE || id === SHALLOW_WATER_TILE; }

export function waterDepthAt(tileAt: (tx: number, ty: number) => number, tx: number, ty: number, radius = SHALLOW_RADIUS): WaterDepth {
  const id = tileAt(tx, ty);
  if (id === SHALLOW_WATER_TILE) return WaterDepth.Shallow;
  if (id !== WATER_TILE) return WaterDepth.None;
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    if (!dx && !dy) continue; const n = tileAt(tx + dx, ty + dy); if (n !== 0 && !isWaterId(n)) return WaterDepth.Shallow;
  }
  return WaterDepth.Deep;
}

/**
 * ADR-182: render-only. Worldgen gives water tiles height floor(n*4), i.e. 0 or 1 inside one lake, which drew the
 * surface as two levels. Every water tile renders at this one flat surface height, whatever its stored height.
 * Gameplay heights and depth rules are unchanged.
 */
export const WATER_SURFACE_HEIGHT = 0;
/**
 * ADR-263 (Task 36): water that flowed into a shovel-dug channel keeps its own surface level instead of the flat
 * ADR-182 lake surface. Legacy levels use `level + FLOW_WATER_OFFSET` (raw >= FLOW_WATER_MIN_RAW);
 * ADR-297 adds negative-byte codes below. Generated water is 0..12, so natural lakes still draw flat.
 */
export const FLOW_WATER_OFFSET = 80, FLOW_WATER_MIN_RAW = 50;
/** ADR-297: retain legacy 50..127 encoding (-30..47), use unused negative bytes for the
 * added -60..-31 and 48..75 levels. Natural generated water is nonnegative (0..12).
 * No chunk format migration, wider arrays, or extra per-column layers. */
export function isFlowWater(id: number, raw: number): boolean { return isWaterId(id) && (raw >= FLOW_WATER_MIN_RAW || raw <= -71); }
export function flowWaterRaw(level: number): number {
  const n = Math.max(-60, Math.min(75, Math.round(level)));
  return n < -30 ? n - 68 : n > 47 ? n - 146 : n + FLOW_WATER_OFFSET;
}
function flowLevel(raw: number): number { return raw >= FLOW_WATER_MIN_RAW ? raw - FLOW_WATER_OFFSET : raw <= -99 ? raw + 68 : raw + 146; }
/** Terrain level of a tile (decodes flowing water; natural water = its stored height). */
export function terrainLevel(id: number, raw: number): number { return isFlowWater(id, raw) ? flowLevel(raw) : raw; }
/** Natural water is flat; flowed water keeps its own surface level. */
export function renderTileHeight(id: number, h: number): number { return isWaterId(id) ? (isFlowWater(id, h) ? flowLevel(h) : WATER_SURFACE_HEIGHT) : h; }
/** ADR-184: shore tint reaches this many tiles out (was 3, stepped per tile). */
export const SHORE_TINT_RANGE = 6;
/**
 * 0..1 shore tint for one water tile: 1 next to land, falling linearly to 0 at SHORE_TINT_RANGE tiles (Chebyshev).
 * Renderers never draw this per tile; they sample `waterCornerTint` at tile corners and interpolate (ADR-184).
 */
export function waterShoreTint(tileAt: (tx: number, ty: number) => number, tx: number, ty: number): number {
  const id = tileAt(tx, ty); if (!isWaterId(id)) return 0; if (id === SHALLOW_WATER_TILE) return 1;
  const R = SHORE_TINT_RANGE;
  for (let r = 1; r < R; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; const n = tileAt(tx + dx, ty + dy); if (n !== 0 && !isWaterId(n)) return 1 - (r - 1) / (R - 1);
  }
  return 0;
}
/**
 * ADR-184: tint at the shared corner (cx, cy) of tiles (cx-1..cx, cy-1..cy): the mean of those four tiles, with land
 * counting as 1 (fully shallow) and unloaded tiles skipped. Every tile touching a corner reads the same value, so a
 * bilinear blend of the four corners is continuous across tile edges (no per-tile steps).
 */
export function waterCornerTint(tileAt: (tx: number, ty: number) => number, cx: number, cy: number,
  tintAt: (tx: number, ty: number) => number = (x, y) => waterShoreTint(tileAt, x, y)): number {
  let s = 0, n = 0;
  for (let dy = -1; dy <= 0; dy++) for (let dx = -1; dx <= 0; dx++) {
    const id = tileAt(cx + dx, cy + dy); if (id === 0) continue; n++; s += isWaterId(id) ? tintAt(cx + dx, cy + dy) : 1;
  }
  return n ? s / n : 0;
}
/** Bilinear blend of corner tints c00 (x,y), c10 (x+1,y), c11 (x+1,y+1), c01 (x,y+1) at fractional (fx, fy). */
export function bilerpTint(c00: number, c10: number, c11: number, c01: number, fx: number, fy: number): number {
  return (c00 * (1 - fx) + c10 * fx) * (1 - fy) + (c01 * (1 - fx) + c11 * fx) * fy;
}
