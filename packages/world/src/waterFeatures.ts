/**
 * ADR-255: every world seed gets at least one lake, one river and one pond.
 * Features are pure functions of (seed, tx, ty) so chunk generation stays deterministic and streamable.
 *
 * ADR-383: every seed also gets one elevated lake per 512-tile region — a lake whose water sits above
 * sea level (surface level 4..7, vs the flat ADR-182 level 0), held in a bowl of higher terrain by the
 * generator's rim (see generator.ts). Placement keeps clear of the four diagonal spawn quadrants (ADR-106 /
 * Task 33): features sit on the cardinal axes so the grass spawn patches around (±R, ±R) are not drowned.
 */
import { hash2 } from "./noise.js";

export type WaterFeatureKind = "none" | "lake" | "river" | "pond" | "elevatedLake";

/** Survey window used by tests / docs: guaranteed features always lie inside |x|,|y| < this. */
export const WATER_FEATURE_RADIUS = 120;

const LAKE_SALT = 0x6c616b; // "lak"
const POND_SALT = 0x706f6e; // "pon"
const RIVER_SALT = 0x726976; // "riv"
const ELEVATED_SALT = 0x656c76; // "elv"

/** ADR-383: elevated-lake knobs (ProceduralOptions.elevatedLakes overrides these; `false` disables the feature).
 *  level: water surface above the flat ADR-182 sea level (4..7 — well under HEIGHT_MAX, so the rim stays a hill,
 *  not a sky lake). distance: far enough out that the starter lake/pond/river do not overlap it, close enough to
 *  stay inside WATER_FEATURE_RADIUS with its rim. rimWidth: bowl ring around the disc (generator.ts). */
export interface ElevatedLakeOptions {
  minLevel?: number; maxLevel?: number;
  minRadius?: number; maxRadius?: number;
  minDistance?: number; maxDistance?: number;
  rimWidth?: number;
}
export const ELEVATED_LAKE_DEFAULTS: Required<ElevatedLakeOptions> = {
  minLevel: 4, maxLevel: 7, minRadius: 6, maxRadius: 10, minDistance: 84, maxDistance: 104, rimWidth: 4,
};

export interface WaterFeatureLayout {
  lake: { x: number; y: number; r: number };
  pond: { x: number; y: number; r: number };
  river: { angle: number; phase: number; amp: number; period: number; halfLen: number; width: number; offset: number };
  /** ADR-383: elevated lake — centre, radius and water surface level (above the flat sea level 0). */
  elevatedLake: { x: number; y: number; r: number; level: number };
}

/** Seed-derived lake / pond centres and river parameters (stable for the life of the world). */
export function waterFeatureLayout(seed: number, elevated: ElevatedLakeOptions = ELEVATED_LAKE_DEFAULTS): WaterFeatureLayout {
  const s = seed >>> 0;
  const el = { ...ELEVATED_LAKE_DEFAULTS, ...elevated };
  // Cardinals: E, N, W, S — spawn points use diagonals, so these stay clear of the 20-tile safe radii at the patches.
  const cardinals: readonly (readonly [number, number])[] = [[1, 0], [0, -1], [-1, 0], [0, 1]];
  const lakePick = Math.floor(hash2(s ^ LAKE_SALT, 1, 0) * 4) % 4;
  const pondPick = (lakePick + 1 + Math.floor(hash2(s ^ POND_SALT, 2, 0) * 3)) % 4;
  // ADR-383: the elevated lake takes one of the two cardinals neither the lake nor the pond uses, further out.
  const remaining = [0, 1, 2, 3].filter((i) => i !== lakePick && i !== pondPick);
  const elevatedPick = remaining[Math.floor(hash2(s ^ ELEVATED_SALT, 1, 0) * remaining.length) % remaining.length]!;
  const [edx, edy] = cardinals[elevatedPick]!;
  const [ldx, ldy] = cardinals[lakePick]!;
  const [pdx, pdy] = cardinals[pondPick]!;
  const lakeDist = 48 + Math.floor(hash2(s ^ LAKE_SALT, 3, 0) * 36); // 48..83
  const pondDist = 36 + Math.floor(hash2(s ^ POND_SALT, 3, 0) * 40); // 36..75
  const lakeR = 12 + Math.floor(hash2(s ^ LAKE_SALT, 4, 0) * 6); // 12..17
  const pondR = 3 + Math.floor(hash2(s ^ POND_SALT, 4, 0) * 2); // 3..4
  const elevatedDist = el.minDistance + Math.floor(hash2(s ^ ELEVATED_SALT, 2, 0) * (el.maxDistance - el.minDistance + 1));
  const elevatedR = el.minRadius + Math.floor(hash2(s ^ ELEVATED_SALT, 3, 0) * (el.maxRadius - el.minRadius + 1));
  const elevatedLevel = el.minLevel + Math.floor(hash2(s ^ ELEVATED_SALT, 4, 0) * (el.maxLevel - el.minLevel + 1));
  const angle = hash2(s ^ RIVER_SALT, 1, 0) * Math.PI * 2;
  return {
    lake: { x: Math.round(ldx * lakeDist) + 0.5, y: Math.round(ldy * lakeDist) + 0.5, r: lakeR },
    pond: { x: Math.round(pdx * pondDist) + 0.5, y: Math.round(pdy * pondDist) + 0.5, r: pondR },
    elevatedLake: { x: Math.round(edx * elevatedDist) + 0.5, y: Math.round(edy * elevatedDist) + 0.5, r: elevatedR, level: elevatedLevel },
    river: {
      angle,
      phase: hash2(s ^ RIVER_SALT, 2, 0) * Math.PI * 2,
      amp: 6 + hash2(s ^ RIVER_SALT, 3, 0) * 8,
      period: 18 + hash2(s ^ RIVER_SALT, 4, 0) * 14,
      halfLen: 70 + Math.floor(hash2(s ^ RIVER_SALT, 5, 0) * 30), // 70..99 each side
      width: 1.15 + hash2(s ^ RIVER_SALT, 6, 0) * 0.55, // ~1.15..1.7 tiles
      offset: (hash2(s ^ RIVER_SALT, 7, 0) - 0.5) * 24, // lateral shift so it is not always through origin
    },
  };
}

function riverLocal(tx: number, ty: number, r: WaterFeatureLayout["river"]): { u: number; v: number; meander: number } {
  const c = Math.cos(r.angle), s = Math.sin(r.angle);
  const u = tx * c + ty * s;
  const v = -tx * s + ty * c - r.offset;
  const meander = r.amp * Math.sin(u / r.period + r.phase);
  return { u, v, meander };
}

/** Point on the river centreline at parameter `u` (tile units along the river axis). */
export function riverPoint(layout: WaterFeatureLayout, u: number): { x: number; y: number } {
  const r = layout.river; const c = Math.cos(r.angle), s = Math.sin(r.angle);
  const meander = r.amp * Math.sin(u / r.period + r.phase);
  const v = meander + r.offset; // matches riverLocal's v = rawV - offset
  return { x: u * c - v * s, y: u * s + v * c };
}

/** Euclidean distance from the tile centre (tx+0.5, ty+0.5) to the elevated lake's centre. */
export function elevatedLakeDist(layout: WaterFeatureLayout, tx: number, ty: number): number {
  return Math.hypot(tx + 0.5 - layout.elevatedLake.x, ty + 0.5 - layout.elevatedLake.y);
}

/** Water surface level of the elevated lake covering (tx, ty), or undefined when the tile is not in it. */
export function elevatedLakeAt(seed: number, tx: number, ty: number, layout = waterFeatureLayout(seed)): number | undefined {
  return elevatedLakeDist(layout, tx, ty) <= layout.elevatedLake.r ? layout.elevatedLake.level : undefined;
}

/** Which guaranteed feature covers (tx, ty). Elevated lake > lake > pond > river so the elevated disc swallows
 *  a river crossing it (the river runs at sea level either side) and small ponds are not erased by a river crossing. */
export function waterFeatureAt(seed: number, tx: number, ty: number, layout = waterFeatureLayout(seed)): WaterFeatureKind {
  const x = tx + 0.5, y = ty + 0.5;
  if (elevatedLakeDist(layout, tx, ty) <= layout.elevatedLake.r) return "elevatedLake";
  const dlx = x - layout.lake.x, dly = y - layout.lake.y;
  if (dlx * dlx + dly * dly <= layout.lake.r * layout.lake.r) return "lake";
  const dpx = x - layout.pond.x, dpy = y - layout.pond.y;
  if (dpx * dpx + dpy * dpy <= layout.pond.r * layout.pond.r) return "pond";
  const { u, v, meander } = riverLocal(x, y, layout.river);
  if (Math.abs(u) <= layout.river.halfLen && Math.abs(v - meander) <= layout.river.width) return "river";
  return "none";
}

/** True when a guaranteed water feature covers this tile (biome water is separate). */
export function isForcedWater(seed: number, tx: number, ty: number, layout?: WaterFeatureLayout): boolean {
  return waterFeatureAt(seed, tx, ty, layout) !== "none";
}

/**
 * Classify water bodies inside a window by scanning connected components of water tiles.
 * Used by tests: a seed is well-formed when the forced features (or biome water) yield ≥1 of each kind.
 * - lake: component area ≥ LAKE_MIN_AREA (or any tile tagged lake by waterFeatureAt)
 * - pond: component area in [POND_MIN_AREA, POND_MAX_AREA] and not elongated, or any tile tagged pond
 * - river: any tile tagged river, or an elongated water component (aspect ≥ RIVER_ASPECT)
 */
export const LAKE_MIN_AREA = 80;
export const POND_MIN_AREA = 5;
export const POND_MAX_AREA = 45;
export const RIVER_ASPECT = 4;

export interface WaterSurvey {
  lakes: number; rivers: number; ponds: number;
  /** True when the seed's forced layout is present (always, by construction). */
  forced: { lake: boolean; river: boolean; pond: boolean };
}

export function surveyWaterFeatures(
  seed: number,
  tileAt: (tx: number, ty: number) => number,
  isWater: (id: number) => boolean,
  half = WATER_FEATURE_RADIUS,
): WaterSurvey {
  const layout = waterFeatureLayout(seed);
  const forced = {
    lake: waterFeatureAt(seed, Math.floor(layout.lake.x), Math.floor(layout.lake.y), layout) === "lake",
    pond: waterFeatureAt(seed, Math.floor(layout.pond.x), Math.floor(layout.pond.y), layout) === "pond",
    river: [-50, -20, 0, 20, 50].some((u) => {
      const p = riverPoint(layout, u);
      return waterFeatureAt(seed, Math.floor(p.x), Math.floor(p.y), layout) === "river";
    }),
  };
  // Morphology: flood-fill water components inside the window (also counts biome seas).
  const W = half * 2; const seen = new Uint8Array(W * W);
  const idx = (x: number, y: number) => (y + half) * W + (x + half);
  let lakes = 0, rivers = 0, ponds = 0;
  for (let y = -half; y < half; y++) for (let x = -half; x < half; x++) {
    const i = idx(x, y); if (seen[i]) continue;
    if (!isWater(tileAt(x, y))) { seen[i] = 1; continue; }
    // BFS
    const q: number[] = [x, y]; seen[i] = 1;
    let area = 0, minX = x, maxX = x, minY = y, maxY = y;
    let hasLake = false, hasRiver = false, hasPond = false;
    while (q.length) {
      const cy = q.pop()!, cx = q.pop()!;
      area++; minX = Math.min(minX, cx); maxX = Math.max(maxX, cx); minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
      const k = waterFeatureAt(seed, cx, cy, layout);
      if (k === "lake" || k === "elevatedLake") hasLake = true; else if (k === "river") hasRiver = true; else if (k === "pond") hasPond = true;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < -half || nx >= half || ny < -half || ny >= half) continue;
        const j = idx(nx, ny); if (seen[j]) continue;
        if (!isWater(tileAt(nx, ny))) { seen[j] = 1; continue; }
        seen[j] = 1; q.push(nx, ny);
      }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const aspect = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
    if (hasLake || area >= LAKE_MIN_AREA) lakes++;
    else if (hasRiver || aspect >= RIVER_ASPECT) rivers++;
    else if (hasPond || (area >= POND_MIN_AREA && area <= POND_MAX_AREA)) ponds++;
  }
  // Forced features always count even if morphology merged them into a larger body.
  if (forced.lake && lakes === 0) lakes = 1;
  if (forced.river && rivers === 0) rivers = 1;
  if (forced.pond && ponds === 0) ponds = 1;
  return { lakes, rivers, ponds, forced };
}

