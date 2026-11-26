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
 * ADR-182 lake surface. ADR-567: ONLY the ADR-411 v2 code (raw = level + 1000) counts as flow water — the
 * ADR-297 legacy branches (raw >= 50 / raw <= -71) are retired; see the note at `isFlowWater`.
 */
export const FLOW_WATER_OFFSET = 80, FLOW_WATER_MIN_RAW = 50;
/** ADR-411: absolute terrain levels now span -300..326 (generated ground 0..26, shovel ±300), which no byte
 * encoding can hold. ADR-529: the range is now -100..100 (absolute bounds — the flow-water cap now equals
 * the land ceiling); the v2 code is unchanged, only its range narrows to raw 900..1100. Flowed water at those levels uses a v2 code:
 * raw = level + FLOW_WATER_OFFSET_V2 (700..1326 at ±300; 900..1100 now), stored in the chunk's i16 height
 * array. Natural water is still 0..12 and land is stored directly, so the v2 code is unambiguous — and a
 * ADR-567: the legacy branches are retired — only this v2 code decodes as flow water (see `isFlowWater`). */
export const FLOW_WATER_OFFSET_V2 = 1000;
/** ADR-411: flow-water level range — the same absolute bounds as gameplay's TERRAIN (see terrain_depth.ts);
 * kept here because the world package cannot import gameplay. The gameplay ADR-411 test asserts they agree.
 * ADR-529: -100..100 (was -300..326); the raise to ±250 comes later, once ±100 is proven. */
export const FLOW_WATER_LEVEL_MIN = -100, FLOW_WATER_LEVEL_MAX = 100;
/** ADR-411: smallest v2 raw (level -300 + offset 1000). v2 raws are 700..1326; legacy raws are -128..127,
 * so this threshold separates them — the offset itself (1000) would misread deep v2 water as legacy.
 * ADR-529: smallest v2 raw is now 900 (level -100 + 1000); v2 raws are 900..1100. */
export const FLOW_WATER_MIN_RAW_V2 = FLOW_WATER_OFFSET_V2 + FLOW_WATER_LEVEL_MIN;
/** ADR-567: v2 raws ONLY. The ADR-297 legacy branches read any water tile with raw >= 50 or <= -71 as flowed
 * water, safe only while natural water beds were 0..12; ADR-530 widened generated beds to -100..100, so deep
 * natural water decoded to phantom surfaces (bed -71 -> surface +75) — the waterfall-wall bug. Natural water
 * stores its bed directly across the full legal range and must never decode as flow. Accepted regression:
 * water flowed under the legacy v1 encoding in saves predating ADR-411 is now indistinguishable from natural
 * water and renders flat; current builds have written v2 since ADR-411. */
export function isFlowWater(id: number, raw: number): boolean { return isWaterId(id) && raw >= FLOW_WATER_MIN_RAW_V2; }
export function flowWaterRaw(level: number): number {
  const n = Math.max(FLOW_WATER_LEVEL_MIN, Math.min(FLOW_WATER_LEVEL_MAX, Math.round(level)));
  return n + FLOW_WATER_OFFSET_V2;
}
function flowLevel(raw: number): number {
  return raw - FLOW_WATER_OFFSET_V2; // ADR-411 v2 code; ADR-567: the only flow encoding (legacy branches retired)
}
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
