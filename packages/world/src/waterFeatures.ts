/**
 * ADR-255: every world seed gets at least one lake, one river and one pond.
 * Features are pure functions of (seed, tx, ty) so chunk generation stays deterministic and streamable.
 *
 * ADR-383: every seed also gets one elevated lake per region — a lake whose water sits above
 * sea level (surface level 4..7, vs the flat ADR-182 level 0), held in a bowl of higher terrain by the
 * generator's rim (see generator.ts). Placement keeps clear of the four diagonal spawn quadrants (ADR-106 /
 * Task 33): features sit on the cardinal axes so the grass spawn patches around (±R, ±R) are not drowned.
 *
 * ADR-423: the map triples (REGION_SIZE 512 -> 1536, see generator.ts). A region's feature layout
 * scales with it — but region zero keeps the ADR-255 starter layout exactly (scale 1), so the same
 * seed still puts the same lake/river/pond at the same coordinates around spawn. Only non-zero
 * regions use scale REGION_FEATURE_SCALE (3): their lake/pond/elevated distances and radii and the
 * river's length/meander are x3, so the guaranteed features span the bigger region instead of
 * clustering within +/-120 of a 1536-tile region's centre.
 *
 * ADR-424: very large lakes (great lakes) with islands, seeded, in scaled regions only. Region zero
 * keeps the ADR-255/423 starter layout exactly (no great lake at scale 1), so spawn is untouched.
 * A scaled region gets one great lake on a diagonal — with >= 1 island guaranteed inside it (plus
 * 0..3 extra islets, ADR-534: the first islets form an island chain along one seeded ray).
 * ADR-534 grows the lake (r 100..130, dist 230..340) and chooses the diagonal by neighbour size.
 * A diagonal is the only placement geometrically clear of every cardinal-centred feature: the
 * elevated lake's siting can relocate onto any free cardinal, so a fourth-cardinal great lake
 * would collide with it and cost far-region siting rate; at 45 degrees the closest an
 * elevated centre can come is ~186 tiles, past elevated r + rim + great r. An island is land
 * inside the lake disc: the inverse of a lake, so it needs its own precedence slot (island
 * beats greatLake, loses to elevatedLake) and its own ground in the generator.
 */
import { hash2 } from "./noise.js";

export type WaterFeatureKind = "none" | "lake" | "river" | "pond" | "elevatedLake" | "greatLake" | "island";

/** Survey window used by tests / docs: guaranteed features of the starter region (scale 1) always lie inside |x|,|y| < this. */
export const WATER_FEATURE_RADIUS = 120;

/** ADR-423: non-zero regions scale their feature layout by this (region zero stays scale 1). */
export const REGION_FEATURE_SCALE = 3;
/** ADR-423: the scaled-region feature window (WATER_FEATURE_RADIUS * REGION_FEATURE_SCALE). A scaled
 *  region's features lie inside |x|,|y| < this of its centre: elevated lake max extent
 *  312 + 30 + rim 12 = 354; river max coordinate ~297. */
export const SCALED_WATER_FEATURE_RADIUS = WATER_FEATURE_RADIUS * REGION_FEATURE_SCALE;

const LAKE_SALT = 0x6c616b; // "lak"
const POND_SALT = 0x706f6e; // "pon"
const RIVER_SALT = 0x726976; // "riv"
const ELEVATED_SALT = 0x656c76; // "elv"
const GREAT_SALT = 0x677274; // "grt"
const ISLAND_SALT = 0x69736c; // "isl"

/** ADR-424: great-lake knobs (scaled regions only — region zero has no great lake, scale 1).
 *  ADR-534: the lake grows into a HUGE lake — radius 100..130 (was 55..80), dist 230..340
 *  (was 190..270). The old 360 feature window no longer bounds it: max extent 340+130 = 470,
 *  still far inside the 1536-tile region (half 768). The diagonal is chosen to keep the discs
 *  disjoint (see waterFeatureLayout): the closest a neighbouring cardinal disc can come is
 *  ~163 tiles (great at min dist, neighbour at the 45-degree closest approach), so a lake
 *  neighbour (r <= 51) needs the great lake pushed out (dist >= 280) while a pond (r <= 12)
 *  or elevated (r <= 30) neighbour is clear at dist >= 230. The lake sits on a diagonal, so
 *  it cannot overlap the lake (144..249, r 36..51), pond, or elevated lake (252..312, r 18..30)
 *  on their cardinals — closest approach ~163 tiles, past the radii sums at the chosen dist. */
export const GREAT_LAKE_MIN_DIST = 230;
export const GREAT_LAKE_MAX_DIST = 340;
export const GREAT_LAKE_MIN_RADIUS = 100;
export const GREAT_LAKE_MAX_RADIUS = 130;
/** ADR-424: water ring (tiles) guaranteed between an island's edge and the great lake's edge, so
 *  every island is fully surrounded by water (never a peninsula) and a boat finds deep water
 *  beyond the 2-tile shallow band (SHALLOW_RADIUS) before it beaches on the sand. */
export const ISLAND_WATER_GAP = 4;
/** ADR-424: smallest island radius. A 1-tile island is all shore; r >= 5 leaves a grass core
 *  past the 1-tile sand beach ring and the 2-tile shallow band, so the island reads as land. */
export const ISLAND_MIN_RADIUS = 5;
/** ADR-534: islands scale up with the huge lake — main island radius 12..22 (was 6..12), extra
 *  islets 8..14 (was 5..8), up to 3 of them (was 2). The first islets are placed as an island
 *  CHAIN along one seeded ray from the main island where they fit; the rest fall back to the
 *  golden-angle spread. Bigger grass cores, still beach ring + climbable 1–2 heights (ADR-424). */
export const ISLAND_MAIN_MIN_RADIUS = 12;
export const ISLAND_MAIN_MAX_RADIUS = 22;
export const ISLAND_ISLET_MIN_RADIUS = 8;
export const ISLAND_ISLET_MAX_RADIUS = 14;
export const ISLAND_MAX_EXTRA = 3;

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

/** ADR-423: the elevated-lake knobs for a region at feature scale `scale` (1 = starter region).
 *  Distances, radii and rim width scale; levels do not (heights are ADR-411's, not map size). */
export function scaleElevatedLakeOptions(opts: Required<ElevatedLakeOptions>, scale: number): Required<ElevatedLakeOptions> {
  return scale === 1 ? { ...opts } : {
    ...opts,
    minDistance: opts.minDistance * scale, maxDistance: opts.maxDistance * scale,
    minRadius: opts.minRadius * scale, maxRadius: opts.maxRadius * scale,
    rimWidth: opts.rimWidth * scale,
  };
}

export interface WaterFeatureLayout {
  lake: { x: number; y: number; r: number };
  pond: { x: number; y: number; r: number };
  river: { angle: number; phase: number; amp: number; period: number; halfLen: number; width: number; offset: number };
  /** ADR-383: elevated lake — centre, radius and water surface level (above the flat sea level 0).
   *  ADR-386: undefined when the generator's noise-aware siting found no placement clear of the sea —
   *  the region has no elevated lake at all (better a missing lake than a sea-merged one).
   *  `waterFeatureLayout` itself always returns one (the hash baseline); only sited layouts skip. */
  elevatedLake: { x: number; y: number; r: number; level: number } | undefined;
  /** ADR-386: spillway + waterfall, if the sited lake spills to lower water (undefined = closed lake,
   *  or no lake). Set by the generator's siting pass, never by `waterFeatureLayout` (which has no
   *  height field to walk). Tiles are region-local coords in walk order, starting at the rim breach. */
  spillway?: Spillway | undefined;
  /** ADR-424: great lake with islands — undefined in region zero (scale 1: the starter layout is
   *  pinned) and when the caller asks for a layout without one. The islands live inside the lake
   *  disc with ISLAND_WATER_GAP of water around each, so each is land fully surrounded by water. */
  greatLake: { x: number; y: number; r: number; islands: { x: number; y: number; r: number }[] } | undefined;
}

/** ADR-424: one island disc of a great lake. */
export interface GreatLakeIsland { x: number; y: number; r: number }

/** ADR-386: a spillway channel from an elevated lake's rim down to lower water. `tiles[0]` is the rim
 *  breach (the first tile outside the disc, at level L-1); `tiles[1]` is the waterfall (level L-3, a
 *  2-level drop off the breach); later tiles step down 1 per tile to a floor of 1, then run flat to the
 *  sea. `end` is the sea-level water tile the channel meets (biome sea or a forced lake/river/pond at
 *  level 0) — the only place the elevated water touches lower water. `bbox` bounds the channel for a
 *  cheap lookup (most tiles are outside it). */
export interface Spillway {
  tiles: { x: number; y: number; level: number }[];
  end: { x: number; y: number };
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** Seed-derived lake / pond centres and river parameters (stable for the life of the world).
 *  ADR-423: `scale` multiplies the hash-derived distances/radii and the river's length/meander
 *  (lake 48..83 -> x3, pond 36..75 -> x3, elevated distance/radius via the scaled knobs, river
 *  halfLen 70..99 -> x3). River width and lake levels do NOT scale. Default 1 = the ADR-255 starter
 *  layout, byte-identical to before ADR-423. */
export function waterFeatureLayout(seed: number, elevated: ElevatedLakeOptions = ELEVATED_LAKE_DEFAULTS, scale = 1): WaterFeatureLayout {
  const s = seed >>> 0;
  const el = scaleElevatedLakeOptions({ ...ELEVATED_LAKE_DEFAULTS, ...elevated }, scale);
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
  const lakeDist = (48 + Math.floor(hash2(s ^ LAKE_SALT, 3, 0) * 36)) * scale; // 48..83 (x3 scaled)
  const pondDist = (36 + Math.floor(hash2(s ^ POND_SALT, 3, 0) * 40)) * scale; // 36..75 (x3 scaled)
  const lakeR = (12 + Math.floor(hash2(s ^ LAKE_SALT, 4, 0) * 6)) * scale; // 12..17 (x3 scaled)
  const pondR = (3 + Math.floor(hash2(s ^ POND_SALT, 4, 0) * 2)) * scale; // 3..4 (x3 scaled)
  const elevatedDist = el.minDistance + Math.floor(hash2(s ^ ELEVATED_SALT, 2, 0) * (el.maxDistance - el.minDistance + 1));
  const elevatedR = el.minRadius + Math.floor(hash2(s ^ ELEVATED_SALT, 3, 0) * (el.maxRadius - el.minRadius + 1));
  const elevatedLevel = el.minLevel + Math.floor(hash2(s ^ ELEVATED_SALT, 4, 0) * (el.maxLevel - el.minLevel + 1));
  const angle = hash2(s ^ RIVER_SALT, 1, 0) * Math.PI * 2;
  // ADR-424: the great lake sits on a DIAGONAL, not the fourth cardinal. The four cardinals are
  // taken (lake, pond, elevated, and the fourth is one ADR-386 siting can relocate the elevated
  // lake onto — a relocated disc there would swallow the great lake's islands, since precedence
  // puts elevatedLake above island, and rejecting those candidates cut the far-region siting rate
  // from ~92% to ~72%). A diagonal is geometrically clear of every cardinal-centred disc: the
  // closest an elevated centre (231..312 out) can come to a great-lake centre (230..340 out at
  // 45 degrees) is ~186 tiles, past elevated r 30 + rim 12 + great r 130 = 172 — so no siting
  // change is needed at all, and no island can ever sit inside an elevated disc. Region zero
  // (scale 1) has none: the starter layout is pinned byte-identical, spawn included (spawn
  // patches are diagonal, but only in region zero, where there is no great lake).
  // ADR-534: the lake grows (r 100..130, dist 230..340) and the diagonal is now CHOSEN, not
  // hashed blind: each diagonal neighbours the two cardinals at ±45° to it, and the pick is
  // the diagonal whose neighbouring discs are smallest (free cardinal = 0, pond <= 12,
  // elevated <= 30, lake <= 51). A diagonal neighbouring the big lake disc is pushed out
  // (dist >= 280: closest approach ~198 > 130 + 51 + 2); the other diagonals sit at >= 230.
  // The ADR-386 siting clearance (generator.ts) additionally keeps a relocated elevated disc
  // off the great lake, so the ADR-424 siting invariant holds at the new size.
  let greatLake: WaterFeatureLayout["greatLake"];
  if (scale > 1) {
    const cardRadius = new Map<string, number>([
      [`${cardinals[lakePick]![0]},${cardinals[lakePick]![1]}`, lakeR],
      [`${cardinals[pondPick]![0]},${cardinals[pondPick]![1]}`, pondR],
      [`${cardinals[elevatedPick]![0]},${cardinals[elevatedPick]![1]}`, elevatedR],
    ]);
    const diagonals: readonly (readonly [number, number])[] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    const scored = diagonals.map((d) => ({
      d,
      score: Math.max(cardRadius.get(`${d[0]},0`) ?? 0, cardRadius.get(`0,${d[1]}`) ?? 0),
    }));
    const bestScore = Math.min(...scored.map((x) => x.score));
    const best = scored.filter((x) => x.score === bestScore);
    const [gdx, gdy] = best[Math.floor(hash2(s ^ GREAT_SALT, 3, 0) * best.length) % best.length]!.d;
    const distMin = bestScore > 40 ? 280 : GREAT_LAKE_MIN_DIST;
    const greatDist = distMin + Math.floor(hash2(s ^ GREAT_SALT, 1, 0) * (GREAT_LAKE_MAX_DIST - distMin + 1));
    const greatR = GREAT_LAKE_MIN_RADIUS + Math.floor(hash2(s ^ GREAT_SALT, 2, 0) * (GREAT_LAKE_MAX_RADIUS - GREAT_LAKE_MIN_RADIUS + 1));
    const gx = Math.round(gdx * greatDist * Math.SQRT1_2) + 0.5, gy = Math.round(gdy * greatDist * Math.SQRT1_2) + 0.5;
    const islands: { x: number; y: number; r: number }[] = [];
    const placeIsland = (r: number, salt: number, attempt: number): boolean => {
      // Golden-angle walk from a hash angle: candidate 0 sits at 30% of the max reach, so it is
      // always valid (the main island is guaranteed); later candidates spread around the lake.
      const maxReach = greatR - r - ISLAND_WATER_GAP;
      const a = hash2(s ^ salt, 1, 0) * Math.PI * 2 + attempt * 2.399963;
      const frac = attempt === 0 ? 0.3 : hash2(s ^ salt, 2 + attempt, 0) * 0.85;
      const d = frac * maxReach;
      const x = gx + Math.cos(a) * d, y = gy + Math.sin(a) * d;
      if (Math.hypot(x - gx, y - gy) + r + ISLAND_WATER_GAP > greatR) return false;
      for (const o of islands) if (Math.hypot(x - o.x, y - o.y) < r + o.r + ISLAND_WATER_GAP) return false;
      islands.push({ x: Math.round(x) + 0.5, y: Math.round(y) + 0.5, r });
      return true;
    };
    const mainR = ISLAND_MAIN_MIN_RADIUS + Math.floor(hash2(s ^ ISLAND_SALT, 1, 0) * (ISLAND_MAIN_MAX_RADIUS - ISLAND_MAIN_MIN_RADIUS + 1));
    for (let attempt = 0; attempt < 24 && islands.length === 0; attempt++) placeIsland(mainR, ISLAND_SALT, attempt);
    // ADR-534: island chain — the first extra islets step out from the main island along one
    // seeded ray (spacing = the two radii + the water gap + 6), where they fit inside the
    // lake; an islet that doesn't fit on the ray falls back to the golden-angle spread.
    const chainDir = hash2(s ^ ISLAND_SALT, 9, 0) * Math.PI * 2;
    let chainD = 0;
    const placeChainIslet = (r: number): boolean => {
      const main = islands[0]!;
      const d = chainD + main.r + r + ISLAND_WATER_GAP + 6;
      const x = main.x + Math.cos(chainDir) * d, y = main.y + Math.sin(chainDir) * d;
      if (Math.hypot(x - gx, y - gy) + r + ISLAND_WATER_GAP > greatR) return false;
      for (const o of islands) if (Math.hypot(x - o.x, y - o.y) < r + o.r + ISLAND_WATER_GAP) return false;
      islands.push({ x: Math.round(x) + 0.5, y: Math.round(y) + 0.5, r });
      chainD = d;
      return true;
    };
    const extra = Math.floor(hash2(s ^ ISLAND_SALT, 5, 0) * (ISLAND_MAX_EXTRA + 1)); // 0..3 islets
    for (let n = 0; n < extra; n++) {
      const r = ISLAND_ISLET_MIN_RADIUS + Math.floor(hash2(s ^ ISLAND_SALT, 6 + n, 0) * (ISLAND_ISLET_MAX_RADIUS - ISLAND_ISLET_MIN_RADIUS + 1));
      if (placeChainIslet(r)) continue;
      for (let attempt = 0; attempt < 12; attempt++) if (placeIsland(r, ISLAND_SALT ^ (0x100 + n), attempt)) break;
    }
    greatLake = { x: gx, y: gy, r: greatR, islands };
  }
  return {
    lake: { x: Math.round(ldx * lakeDist) + 0.5, y: Math.round(ldy * lakeDist) + 0.5, r: lakeR },
    pond: { x: Math.round(pdx * pondDist) + 0.5, y: Math.round(pdy * pondDist) + 0.5, r: pondR },
    elevatedLake: { x: Math.round(edx * elevatedDist) + 0.5, y: Math.round(edy * elevatedDist) + 0.5, r: elevatedR, level: elevatedLevel },
    greatLake,
    river: {
      angle,
      phase: hash2(s ^ RIVER_SALT, 2, 0) * Math.PI * 2,
      amp: (6 + hash2(s ^ RIVER_SALT, 3, 0) * 8) * scale,
      period: (18 + hash2(s ^ RIVER_SALT, 4, 0) * 14) * scale,
      halfLen: (70 + Math.floor(hash2(s ^ RIVER_SALT, 5, 0) * 30)) * scale, // 70..99 each side (x3 scaled)
      width: 1.15 + hash2(s ^ RIVER_SALT, 6, 0) * 0.55, // ~1.15..1.7 tiles (NOT scaled)
      offset: (hash2(s ^ RIVER_SALT, 7, 0) - 0.5) * 24 * scale, // lateral shift so it is not always through origin
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

/** Euclidean distance from the tile centre (tx+0.5, ty+0.5) to the elevated lake's centre (Infinity when the region has no elevated lake). */
export function elevatedLakeDist(layout: WaterFeatureLayout, tx: number, ty: number): number {
  const el = layout.elevatedLake; if (!el) return Infinity;
  return Math.hypot(tx + 0.5 - el.x, ty + 0.5 - el.y);
}

/** ADR-424: distance to the great lake's centre (Infinity when the region has none). */
export function greatLakeDist(layout: WaterFeatureLayout, tx: number, ty: number): number {
  const g = layout.greatLake; if (!g) return Infinity;
  return Math.hypot(tx + 0.5 - g.x, ty + 0.5 - g.y);
}

/** ADR-424: the island disc covering (tx, ty) — its centre, radius and the tile's distance from
 *  it — or undefined (no great lake in this region, or the tile is not on an island). The
 *  generator uses this for island ground (sand beach ring / grass interior, height 1 / 2). */
export function islandAt(layout: WaterFeatureLayout, tx: number, ty: number): { x: number; y: number; r: number; dist: number } | undefined {
  const g = layout.greatLake; if (!g) return undefined;
  const x = tx + 0.5, y = ty + 0.5;
  for (const isl of g.islands) {
    const dist = Math.hypot(x - isl.x, y - isl.y);
    if (dist <= isl.r) return { ...isl, dist };
  }
  return undefined;
}

/** Water surface level of the elevated lake covering (tx, ty), or undefined when the tile is not in it. */
export function elevatedLakeAt(seed: number, tx: number, ty: number, layout = waterFeatureLayout(seed)): number | undefined {
  const el = layout.elevatedLake; if (!el) return undefined;
  return elevatedLakeDist(layout, tx, ty) <= el.r ? el.level : undefined;
}

/** Which guaranteed feature covers (tx, ty). Elevated lake > island > great lake > lake > pond >
 *  river so the elevated disc swallows a river crossing it, an island is land inside its great
 *  lake instead of being erased by it, the great lake swallows a river crossing it, and small
 *  ponds are not erased by a river crossing. */
export function waterFeatureAt(seed: number, tx: number, ty: number, layout = waterFeatureLayout(seed)): WaterFeatureKind {
  const x = tx + 0.5, y = ty + 0.5;
  if (layout.elevatedLake && elevatedLakeDist(layout, tx, ty) <= layout.elevatedLake.r) return "elevatedLake";
  if (islandAt(layout, tx, ty)) return "island";
  if (layout.greatLake && greatLakeDist(layout, tx, ty) <= layout.greatLake.r) return "greatLake";
  const dlx = x - layout.lake.x, dly = y - layout.lake.y;
  if (dlx * dlx + dly * dly <= layout.lake.r * layout.lake.r) return "lake";
  const dpx = x - layout.pond.x, dpy = y - layout.pond.y;
  if (dpx * dpx + dpy * dpy <= layout.pond.r * layout.pond.r) return "pond";
  const { u, v, meander } = riverLocal(x, y, layout.river);
  if (Math.abs(u) <= layout.river.halfLen && Math.abs(v - meander) <= layout.river.width) return "river";
  return "none";
}

/** True when a guaranteed water feature covers this tile (biome water is separate). An island is
 *  land, not water — it reports its own kind above, and this stays false on it. */
export function isForcedWater(seed: number, tx: number, ty: number, layout?: WaterFeatureLayout): boolean {
  const k = waterFeatureAt(seed, tx, ty, layout);
  return k !== "none" && k !== "island";
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
  /** ADR-424: water components tagged greatLake, and islands in the surveyed layout (0 in region zero). */
  greatLakes: number; islands: number;
  /** True when the seed's forced layout is present (always, by construction). */
  forced: { lake: boolean; river: boolean; pond: boolean; greatLake: boolean };
}

export function surveyWaterFeatures(
  seed: number,
  tileAt: (tx: number, ty: number) => number,
  isWater: (id: number) => boolean,
  half = WATER_FEATURE_RADIUS,
  /** ADR-424: the layout the window belongs to (default: the region-zero layout). Pass a scaled
   *  region's layout with a region-centred tileAt to survey that region's great lake/islands. */
  layout = waterFeatureLayout(seed),
): WaterSurvey {
  const forced = {
    lake: waterFeatureAt(seed, Math.floor(layout.lake.x), Math.floor(layout.lake.y), layout) === "lake",
    pond: waterFeatureAt(seed, Math.floor(layout.pond.x), Math.floor(layout.pond.y), layout) === "pond",
    river: [-50, -20, 0, 20, 50].some((u) => {
      const p = riverPoint(layout, u);
      return waterFeatureAt(seed, Math.floor(p.x), Math.floor(p.y), layout) === "river";
    }),
    greatLake: !!layout.greatLake && (() => {
      // The lake centre itself may be an island — sample the centre and four half-radius points;
      // at least one is open water (islands are r <= 12, the points sit >= 27 tiles out).
      const g = layout.greatLake!;
      return ([[0, 0], [0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]] as const).some(([fx, fy]) =>
        waterFeatureAt(seed, Math.floor(g.x + fx * g.r), Math.floor(g.y + fy * g.r), layout) === "greatLake");
    })(),
  };
  // Morphology: flood-fill water components inside the window (also counts biome seas).
  const W = half * 2; const seen = new Uint8Array(W * W);
  const idx = (x: number, y: number) => (y + half) * W + (x + half);
  let lakes = 0, rivers = 0, ponds = 0, greatLakes = 0;
  for (let y = -half; y < half; y++) for (let x = -half; x < half; x++) {
    const i = idx(x, y); if (seen[i]) continue;
    if (!isWater(tileAt(x, y))) { seen[i] = 1; continue; }
    // BFS
    const q: number[] = [x, y]; seen[i] = 1;
    let area = 0, minX = x, maxX = x, minY = y, maxY = y;
    let hasLake = false, hasRiver = false, hasPond = false, hasGreatLake = false;
    while (q.length) {
      const cy = q.pop()!, cx = q.pop()!;
      area++; minX = Math.min(minX, cx); maxX = Math.max(maxX, cx); minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
      const k = waterFeatureAt(seed, cx, cy, layout);
      if (k === "lake" || k === "elevatedLake") hasLake = true; else if (k === "greatLake") hasGreatLake = true; else if (k === "river") hasRiver = true; else if (k === "pond") hasPond = true;
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
    if (hasGreatLake) { lakes++; greatLakes++; }
    else if (hasLake || area >= LAKE_MIN_AREA) lakes++;
    else if (hasRiver || aspect >= RIVER_ASPECT) rivers++;
    else if (hasPond || (area >= POND_MIN_AREA && area <= POND_MAX_AREA)) ponds++;
  }
  // Forced features always count even if morphology merged them into a larger body.
  if (forced.lake && lakes === 0) lakes = 1;
  if (forced.river && rivers === 0) rivers = 1;
  if (forced.pond && ponds === 0) ponds = 1;
  if (forced.greatLake && greatLakes === 0) { greatLakes = 1; if (lakes === 0) lakes = 1; }
  return { lakes, rivers, ponds, greatLakes, islands: layout.greatLake?.islands.length ?? 0, forced };
}

