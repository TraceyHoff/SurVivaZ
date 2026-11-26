import { fnv1a, Rng } from "@engine/core";
import { Chunk, CHUNK_SIZE, type ChunkKey } from "./chunk.js";
import type { BaseClimate, BaseClimateSource } from "./climate.js";

/** A resource node to spawn in a freshly generated chunk (gameplay maps kind -> ResourceNode etc). */
export interface NodePlacement { tx: number; ty: number; kind: number }
export interface GeneratedChunk { chunk: Chunk; nodes: NodePlacement[] }

/** Pluggable chunk source. Return undefined if the provider has nothing (e.g. storage miss). */
/** Provider whose load may resolve later (remote/IndexedDB). ChunkManager accepts either kind. */
export interface AsyncChunkProvider {
  load(cx: number, cy: number): GeneratedChunk | undefined | Promise<GeneratedChunk | undefined>;
  save?(key: ChunkKey, bytes: Uint8Array): void;
}
export interface ChunkProvider {
  load(cx: number, cy: number): GeneratedChunk | undefined;
  /** Optional persistence of an unloaded chunk (encoded with encodeChunk). */
  save?(key: ChunkKey, bytes: Uint8Array): void;
}

export { hash2, valueNoise } from "./noise.js";
import { hash2, valueNoise } from "./noise.js";
import { isForcedWater, waterFeatureAt, waterFeatureLayout, riverPoint, REGION_FEATURE_SCALE, scaleElevatedLakeOptions, elevatedLakeDist, ELEVATED_LAKE_DEFAULTS, GREAT_LAKE_MIN_DIST, GREAT_LAKE_MAX_DIST, islandAt, type ElevatedLakeOptions, type Spillway, type WaterFeatureLayout } from "./waterFeatures.js";
import { planRiverNetwork, EMPTY_RIVER_NETWORK, type NetTileInfo, type RiverNetwork, type RiverNetworkContext } from "./riverNetwork.js";
import { flowWaterRaw, waterDepthAt, WaterDepth, WATER_TILE } from "./waterDepth.js";

/** ADR-423: the map triples. One region is now 1536x1536 tiles (was 512x512): the guaranteed-feature
 *  repeat period — the distance between one region's lake/river/pond set and the next — is 3x.
 *  Region zero keeps the ADR-255 starter layout exactly (scale 1 in layoutFor); non-zero regions use
 *  feature scale 3. The world is still infinite/streamed: chunk streaming (loadRadius) is unchanged,
 *  so tripling costs nothing per loaded chunk — only the generatable area, the region-layout memo
 *  (still capped at 16 regions) and the preview extent grow. */
export const REGION_SIZE = 1536;
export const REGION_HALF = REGION_SIZE / 2;

/** ADR-546: region-siting precompute tunables (see precomputeRegionPlans).
 *  DISTANCE_TILES: a neighbouring region's plan starts warming when the player comes within this
 *  many tiles of the shared boundary — ~55 s of sprint travel, far ahead of the 96-tile streaming
 *  radius, so the sliced warming (1 piece/call, 4 pieces/region) finishes long before arrival.
 *  MAX_REGIONS: at most this many adjacent regions are warmed per position (edge-adjacent only,
 *  nearest boundary first) — no wasted work on the diagonal region or regions the player never
 *  approaches. PIECES_PER_CALL: plan pieces warmed per precomputeRegionPlans call (one call per
 *  real player per server tick), so the 57–263 ms first-touch hitch is spread across ticks. */
export const REGION_PRECOMPUTE_DISTANCE_TILES = 256;
export const REGION_PRECOMPUTE_MAX_REGIONS = 2;
export const REGION_PRECOMPUTE_PIECES_PER_CALL = 1;
/** ADR-546: one region's siting plan, in dependency order — water first (massifs/canyons/rivers
 *  all read the sited water layout), then massifs, canyons, river network. */
export type RegionPlanPiece = "water" | "massifs" | "canyons" | "rivers";
export const REGION_PLAN_PIECES: readonly RegionPlanPiece[] = ["water", "massifs", "canyons", "rivers"];
/** ADR-546: the edge-adjacent regions whose siting plans should be precomputed for a player at
 *  (x, y) — the regions across a boundary the player is within REGION_PRECOMPUTE_DISTANCE_TILES
 *  of, nearest boundary first, capped at REGION_PRECOMPUTE_MAX_REGIONS. Pure (no generator
 *  state), so the trigger is unit-testable on its own. The diagonal region is deliberately not
 *  included: crossing into it means crossing one of these two regions' boundaries first, and
 *  its plan warms when the player nears that boundary. */
export function regionsToPrecompute(x: number, y: number): Array<[number, number]> {
  const rx = Math.floor((x + REGION_HALF) / REGION_SIZE), ry = Math.floor((y + REGION_HALF) / REGION_SIZE);
  const lx = x - rx * REGION_SIZE, ly = y - ry * REGION_SIZE;
  const cands: Array<{ r: [number, number]; d: number }> = [];
  if (lx > REGION_HALF - REGION_PRECOMPUTE_DISTANCE_TILES) cands.push({ r: [rx + 1, ry], d: REGION_HALF - lx });
  if (lx < -REGION_HALF + REGION_PRECOMPUTE_DISTANCE_TILES) cands.push({ r: [rx - 1, ry], d: lx + REGION_HALF });
  if (ly > REGION_HALF - REGION_PRECOMPUTE_DISTANCE_TILES) cands.push({ r: [rx, ry + 1], d: REGION_HALF - ly });
  if (ly < -REGION_HALF + REGION_PRECOMPUTE_DISTANCE_TILES) cands.push({ r: [rx, ry - 1], d: ly + REGION_HALF });
  cands.sort((a, b) => a.d - b.d);
  return cands.slice(0, REGION_PRECOMPUTE_MAX_REGIONS).map((c) => c.r);
}

/** ADR-386: noise-aware elevated-lake siting + spillway (waterfall) channel.
 *  SITING_SEA_MARGIN: a sited lake has no biome sea within disc + this many tiles (disc + beach
 *  shelf + one tile of land margin), so every sited lake has a full land shore.
 *  SITING_DIST_STEPS: distance offsets tried along each free cardinal, inside [minDistance, maxDistance].
 *  SITING_HEIGHT_MARGIN: a challenger must beat the hash placement's mean ring height by this much
 *  (levels) to displace it — the hash placement is kept unless another direction is clearly higher ground.
 *  SPILLWAY_MAX_LEN: longest channel (tiles) before the lake is treated as closed (no spillway).
 *  SPILLWAY_TARGET_RANGE: farthest sea (beyond the rim) a spillway will reach for.
 *  SPILLWAY_WINDOW: the walk stays inside the region's own span (a channel must not cross a region
 *  boundary, where the neighbouring region's layout would cut it off). ADR-423: the window is
 *  REGION_SIZE/2 - 1 (767); the range/len are per-region (x REGION_FEATURE_SCALE in scaled regions),
 *  so a scaled region's spillway may run 3x as far — the region-zero values are unchanged (64/64). */
const SITING_SEA_MARGIN = 2;
const SITING_DIST_STEPS = [0, -5, 5, -10, 10, -15, 15, -20, 20] as const;
const SITING_HEIGHT_MARGIN = 1;
const SPILLWAY_MAX_LEN = 64;
const SPILLWAY_TARGET_RANGE = 64;
const SPILLWAY_WINDOW = REGION_SIZE / 2 - 1; // the walk stays inside the region's own 1536-tile span (a channel must not cross into the next region, whose layout would cut it off)

/** ADR-386: spillway channel level at region-local (lx, ly), or undefined (the bbox rejects most tiles). */
function spillLevelAt(layout: WaterFeatureLayout, lx: number, ly: number): number | undefined {
  const sp = layout.spillway; if (!sp) return undefined;
  if (lx < sp.bbox.x0 || lx > sp.bbox.x1 || ly < sp.bbox.y0 || ly > sp.bbox.y1) return undefined;
  for (const t of sp.tiles) if (t.x === lx && t.y === ly) return t.level;
  return undefined;
}

/**
 * ADR-254: pick a fresh world seed for a new playthrough. Prefer crypto.getRandomValues; fall back to `random`.
 * Never returns 0 (0 collides with "unset" in a few call sites). Deterministic only when `random` is seeded.
 */
export function randomWorldSeed(random: () => number = Math.random): number {
  try {
    const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
    if (c?.getRandomValues) { const b = new Uint32Array(1); c.getRandomValues(b); const n = b[0]! >>> 0; if (n) return n; }
  } catch { /* ignore */ }
  const n = (Math.floor(random() * 0xffffffff) >>> 0); return n || 1;
}

/** ADR-254: terrain height levels. Biome noise still drives tile bands; a separate height field adds hills, plateaus and ledges.
 * ADR-411: raised 22 -> 26 (relief 2..8, so plateau 3 x 8 + detail 2 = 26 is actually reached — the old
 * 22 was unreachable: plateau 3 x relief 6 + detail 2 topped out at 20 on every measured seed).
 * ADR-530: raised to [-100, 100]. The old field never went below 0, and its plateau terraces are
 * 6..10-level faces at full relief — closed walls the BFS can never cross (baseline: only 42-60% of
 * land reachable from spawn on 5 seeds). Past the spawn disc the terraces fade out and a smooth
 * signed field fades in, so the whole window stays walkable; see heightFromNoise. */
export const HEIGHT_MAX = 100;
export const HEIGHT_MIN = -100;
const HEIGHT_SALT = 0x6834; // "h4"
const TERRACE_SALT = 0x7465; // "te"

/** ADR-534: small oceans — the TRUE cross-region sea (user decision 4, "if possible").
 *  Biome-sea widening: inside a designated ocean sector the sea band widens from the water
 *  band's max (0.3) to OCEAN_SEA_MAX (1.0 — every tile in the sector is sea). The sector field
 *  is a pure function of ABSOLUTE coords (a coarse valueNoise field, scale 512 + 128), so a
 *  sector is continuous across region boundaries — a sea that straddles a boundary is one
 *  water body on both sides, not two region-local lakes that happen to touch. The sector
 *  boundary is a smooth noise contour, so the coast is organic; inside it the sea is open
 *  water with deep tile 1 (shallow tile 8 only at the shore, via the normal cover rule).
 *  The widening is TOTAL, not partial, by necessity: a partial share (say 65% water) leaves
 *  scattered land islets inside the sea, and every islet is unreachable land for the BFS —
 *  region (1,0) already carries 0.70% unreachable land in 121 small pockets (seed 42), so
 *  even a few percent of islet land would push the 99% BFS floor under. A pure-water sector
 *  adds no unreachable land at all (its only BFS cost is land peninsulas the sea pinches
 *  off at its margin, measured in the ADR-534 survey). Region zero is excluded outright
 *  (Chebyshev <= REGION_HALF), so the starter layout, spawn BFS and adr384 stay byte-identical.
 *  Heights are NOT touched (the ocean only re-bands tiles), so the flat/BFS height structure
 *  is unchanged; massif / canyon / elevated-lake siting and the river network all read the
 *  widened sea through isBiomeSea, so no massif is sited in the ocean, no elevated lake
 *  spills into it unawares, and streams end at it as a mouth. Generation-time only. */
export const OCEAN_SALT = 0x306365; // "oce"
export const OCEAN_SCALE = 512;
export const OCEAN_FIELD_THRESHOLD = 0.72;
export const OCEAN_SEA_MAX = 1.0;

/** ADR-530 fix-up: flat benches restore single-level ruin footprints on the smooth relief.
 *  ADR-530's smooth field removed the ADR-411 terrace plateaus that made exactly-flat footprints
 *  common (flatRate 0.35 -> 0.111, realised ruin density 0.10 -> 0.028), so the wilderness gets
 *  seeded flat benches: one per lattice cell of `cell` tiles, present with probability `chance`,
 *  centre jittered by up to `jitter` tiles from the cell centre, core a Chebyshev SQUARE of
 *  half-side `coreMin..coreMax` pinned exactly flat at the bench level, and a skirt that grades
 *  back to the natural field linearly, completing exactly at the cell edge in Chebyshev distance
 *  (so both sides of a shared edge already read the natural field and the field is continuous
 *  across cells by construction). A square fits rectangular footprints far better than a disc of
 *  the same area (fit efficiency ~0.85 vs ~0.70), and its span to the cell edge is uniform in
 *  the Chebyshev metric, so the ramp's grade is the same in every direction. The bench level is
 *  the MID-RANGE of the pure bench-free natural field over its whole cell (not the core mean,
 *  which can sit at one end of the cell's range and leave the ramp to climb the full range on
 *  the far side): the mid-range minimises the worst |natural - level| over the skirt, and it
 *  alone lifted the BFS ~0.4%. A FACE GATE keeps the ramp inside the ADR-272 face bound (no
 *  single-tile step > 3): for each of 8 rays from the centre, the face there is (largest
 *  |natural - level| along the ray) / (ray span) + (local natural gradient); solving face <=
 *  `gradeGate` for the core radius gives the ray's cap, and an over-steep bench is SHRUNK to
 *  the smallest cap over rays instead of rejected — shrinking lengthens the span, which gentles
 *  the ramp, and keeps most of the capture (a grade-only reject gate cost too much capture for
 *  the same faces, and a face-aware reject gate's sparse sampling missed faces). Benches with a
 *  cap below 14 are rejected. Defaults (cell 64, core 24-26, gradeGate 2.7): flatRate 0.317,
 *  realised 0.082, BFS 99.09-99.88% over the 5 survey seeds, 0 faces over the ADR-272 window.
 *  A bench's whole influence fits inside its own lattice cell (`coreMax <= cell / 2 - jitter -
 *  2`, enforced in the constructor): each cell is self-contained, so two benches can never
 *  interact — no Voronoi step between pinned levels (measured up to 109 levels on a dense
 *  lattice, a wall network that cut the spawn BFS to 49%), no jump ring where a skirt ends.
 *  (Designs tried and rejected: a clamped skirt — its cap cut a jump ring around every bench,
 *  BFS 80% even with non-overlapping cores; a wide fixed-width smoothstep blend across cells —
 *  kept the Voronoi flip, BFS 52%, survey extremes muted to -92; a fixed 10-tile skirt confined
 *  to its cell — ramp too steep where the field varies most, BFS 97.8% with 7% of skirt tiles
 *  unreachable; smoothstep within the cell — worse BFS than linear (min 97.9% vs 98.4%) though
 *  better capture; an unbounded cone (clamp without a cap) — cell-edge steps, BFS 74-92%; a
 *  weighted multi-bench blend — weight normalisation diluted the core bench at its edge,
 *  faces up to 17; a grade-only reject gate — too blunt, flatRate 0.293 at 0 faces; a
 *  face-aware reject gate — sparse ray sampling missed faces, 31 faces at gg 3.0.) A bench
 *  centre must sit at Chebyshev distance >= 160 + cell/2 + jitter + 1 from the origin, so its
 *  cell can never reach the byte-identical inner zone (spawn disc / starter layout). Benches
 *  never touch massif discs: the override applies only where the massif bump is 0, and never
 *  within 10 tiles of a massif disc — the ADR-531 slope path starts up to R+8 outside the disc,
 *  and a bench skirt on the approach can wall the entry off with a >1 step. Benches also
 *  restore flat footprints for player building generally. Generation-time only; nothing per
 *  tick or per frame. */
/** Bench knobs (all numbers — widened from the const defaults so the constructor clamp below
 *  can narrow coreMin/coreMax without fighting literal types). `gradeGate` is the face
 *  threshold the shrink enforces (ADR-272 bound is 3; default 2.7 leaves margin for rounding
 *  and unsampled points); 0 disables the gate. */
export interface BenchOptions { cell: number; jitter: number; chance: number; coreMin: number; coreMax: number; gradeGate: number }
export const BENCH_DEFAULTS: BenchOptions = { cell: 64, jitter: 2, chance: 1.0, coreMin: 24, coreMax: 26, gradeGate: 2.7 };
const BENCH_SALT = 0x626e; // "bn"

/** One flat bench: centre tile, core half-side, and its pinned level (integer). The core is the
 *  Chebyshev square {max(|dx|, |dy|) <= r0} — a square fits rectangular footprints far better
 *  than a disc of the same area, and its span to the cell edge is uniform in the Chebyshev
 *  metric, so the ramp's grade is the same in every direction. */
export interface Bench { cx: number; cy: number; r0: number; level: number }
/** Bench geometry without its level (pure function of seed + lattice cell). `sMax` is the
 *  Chebyshev distance from the centre to the cell edge — the blend completes there. */
interface BenchGeom { cx: number; cy: number; r0: number; sMax: number }
/** ADR-531: mountains — massifs with shape variety + guaranteed slope sides.
 *  A massif is a seeded bump on the natural field: 1–3 per scaled region, never in region zero
 *  (so the starter layout stays byte-identical), discs never crossing a region edge (so no
 *  cross-region lookup and no seam). Heights sample the ±100 range — foothills ~30–65, major
 *  massifs 70–90, a full-100 peak rare (a ~3% signature roll per massif, roughly one per few
 *  regions) — and the bump is additive, so its edge meets the surrounding ground with no seam.
 *  The profile is terraced in tiles-per-level: the slope-side sector rises ≤1 level/tile (an
 *  ADR-409 ramp — walkable), other faces ≤2 levels/tile (climbable cliffs, never a >3 wall from
 *  the massif itself). Each massif also gets a saddle/pass where the ridge dips to its nearest
 *  neighbour. Generation-time only (valueNoise at 2–3 scales, existing salts); no new per-tick
 *  scans, nothing per frame. */
export const MASSIF_ROCK_LINE = 55;
export const MASSIF_SNOW_LINE = 70;
export const MASSIF_TREELINE = 55;
/** Kind 5 is `tree` in DEFAULT_BANDS (ids.lock.json resources) — the treeline suppresses it. */
export const TREE_KIND = 5;

export type MassifShape = "cone" | "ridge" | "mesa" | "dome" | "volcano";
export interface Massif {
  /** Peak tile (absolute coords). */
  cx: number; cy: number;
  /** Target summit height in absolute levels (the bump is sized so base + amp ≈ peak). */
  peak: number;
  /** Bump amplitude in levels above the local base height at the centre. */
  amp: number;
  shape: MassifShape;
  /** Centre of the slope-side sector (radians) and its half-width. */
  slopeDir: number; slopeHalfWidth: number;
  /** Tiles per level on the slope sector (≤1 level/tile) and on the other faces (≤2). */
  wSlope: number; wCliff: number;
  /** Max disc extent in tiles (amp × wSlope × ridge elongation). */
  radius: number;
  /** Ridge only: the long-axis direction and elongation (1 for other shapes). */
  ridgeDir: number; ridgeElongation: number;
}

function angNorm(a: number): number { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
/** Slope-sector factor: 1 inside the sector, cosine falloff over a 1.0-rad transition, 0 outside.
 *  The transition is wide on purpose: the sector edge changes the profile's radius with angle, and
 *  a narrow transition makes the tangential gradient steep enough to step 3 levels (measured). */
function sectorFactor(dTheta: number, halfWidth: number): number {
  const a = Math.abs(angNorm(dTheta));
  if (a <= halfWidth) return 1;
  const t = (a - halfWidth) / 1.0;
  if (t >= 1) return 0;
  return 0.5 + 0.5 * Math.cos(Math.PI * t);
}
/** Normalised profile (1 at the summit, 0 at the disc edge). The volcano is normalised so its
 *  crater rim is 1.0 and its bowl floor is ~0.69 — a real crater dip, not a flat top. */
function shapeProfile(shape: MassifShape, u: number): number {
  switch (shape) {
    case "dome": return 0.5 + 0.5 * Math.cos(Math.PI * Math.min(u, 1));
    case "mesa": return u <= 0.3 ? 1 : Math.max(0, 1 - (u - 0.3) / 0.7);
    case "volcano":
      if (u < 0.22) return 0.6875 + 0.3125 * (u / 0.22);
      return Math.max(0, 1 - (u - 0.22) / 0.78);
    default: return Math.max(0, 1 - u); // cone, ridge
  }
}
/** ADR-531: one massif's bump at (tx, ty) in levels (0 outside its disc). Pure function of the
 *  massif record — the generator and the tests share it. Max radial gradient is the profile's
 *  max derivative over tiles-per-level: ≤1 level/tile on the slope sector, ≤2 elsewhere
 *  (dome 1.57/1.0 at worst), so the massif itself never builds a >3-level wall. */
export function massifBumpAt(m: Massif, tx: number, ty: number): number {
  const dx = tx - m.cx, dy = ty - m.cy;
  if (Math.abs(dx) > m.radius || Math.abs(dy) > m.radius) return 0;
  const d = Math.hypot(dx, dy);
  const theta = Math.atan2(dy, dx);
  const w = m.wCliff + (m.wSlope - m.wCliff) * sectorFactor(theta - m.slopeDir, m.slopeHalfWidth);
  const elong = 1 + (m.ridgeElongation - 1) * Math.cos(theta - m.ridgeDir) ** 2;
  const R = m.amp * w * elong;
  if (d >= R) return 0;
  return Math.floor(m.amp * shapeProfile(m.shape, d / R));
}

/** ADR-532: canyons — carved channels with graded entries, exits, and crossings.
 *  A canyon is a seeded meandering path (same math family as the river centreline: a straight
 *  axis plus a two-sine lateral meander), 200–400 tiles long, 1–2 per scaled region, never in
 *  region zero (so the starter layout stays byte-identical) and never within 384 tiles of the
 *  origin (non-zero regions start 768 out). Profiles: V (wide floor, gentle 1.2-level/tile
 *  walls) and slot (narrow floor, steep but ≤1.6-level/tile walls — never a >3 wall from the
 *  canyon itself). Depth samples 25–60 most of the time, 60–80 sometimes, 85–100 rarely
 *  (~5% — a signature roll), capped by the ramp budget and by the absolute floor (HEIGHT_MIN).
 *  The floor is a 1-Lipschitz envelope of (rim line − depth × envelope, min the actual ground
 *  at the centreline), so it grades ≤1/tile along its whole length: you walk in at the low end
 *  and out the other end. The envelope ramps the depth in and out over ramp = depth / slope
 *  budget tiles, so the canyon peters out at both ends — that termination IS its crossing (no
 *  canyon spans region-edge to region-edge: length ≤ 400 < 1536, and its whole carve footprint
 *  stays inside its region). The wall is floor + grade x distance past the floor edge with
 *  no cutoff: carved = min(pre-canyon height, profile) ends the wall wherever the rising
 *  profile meets the local ground, so there is no footprint edge to step off (a fixed-reach
 *  wall left a 65-level cliff where a floor clamped at −100 faced ground at +72, and a per-t
 *  adaptive wall went stale at its own edge), and min() never steepens a step past the worse
 *  of the natural field and the profile. The 1.6 slot grade is the
 *  bound that keeps 4-neighbour profile steps ≤3 (the wall gradient plus the meander drift
 *  along a diagonal neighbour caps at ~2.7 before flooring; 2.0 reached 4). Carve order:
 *  after the base field (massifs + benches), before water features resolve — canyon beats
 *  biome, water beats canyon where a river runs in it (spillway / island / elevated-bowl
 *  overrides return after the carve). Siting keeps the whole carve footprint clear of massif
 *  discs, great lakes and elevated-lake bowls (a bowl rim across the floor would be a >3 wall
 *  across the walk), by the footprint's own wall reach. Floors MAY dip below sea level (user
 *  canyon-carved tile below 0 holds water (natural tile 1, bed at the floor, surface 0 — the
 *  same encoding as biome sea), never dry land below sea level; dry floors stay ≥ 0. Flood
 *  interaction (ADR-467): that water IS sea-level water, so a storm can seed a flood from a
 *  canyon river onto its low banks (bed ≤ surface, ≤3 tiles out) exactly as from any river —
 *  the canyon needs no flood exemption, and none is given. Generation-time only (valueNoise
 *  at 2–3 scales, existing salts); no new per-tick scans, nothing per frame. */
export type CanyonProfile = "v" | "slot";
export interface Canyon {
  /** Start of the axis (absolute coords); the centreline is axis + lateral meander. */
  sx: number; sy: number; ux: number; uy: number;
  /** Centreline length in tiles (200–400). */
  length: number;
  profile: CanyonProfile;
  /** Realised max depth in levels below the rim line (12–100). */
  depth: number;
  /** Rim levels at the two ends (pre-canyon heights at the centreline endpoints). */
  floorStart: number; floorEnd: number;
  /** The floor is a 1-Lipschitz function of t (rim line − depth × envelope, clamped to the
   *  absolute floor): it grades ≤1/tile along its whole length and is anchored at both rims.
   *  The realised centreline walk is min(ground, floor) — where the ground dips below the
   *  floor the walk follows the dip at the natural gradient (≤3), so the walk never steps
   *  past the worse of the natural field and the floor. The wall is floor + grade x distance
   *  past the floor edge with no cutoff: it runs until the rising profile meets the local
   *  ground, so there is no footprint edge to step off. */
  floor: number[];
  /** Half-width of the flat floor (V 7, slot 3) and wall grade in levels/tile (V 1.2, slot 1.6). */
  floorHalf: number; wallGrade: number;
  /** Lookup bound: floorHalf + the farthest the wall can reach (a 200-level climb at the
   *  profile grade) + slack. The wall itself has no cutoff — it runs until the rising
   *  profile meets the local ground, however far that is; the bound only limits the bbox. */
  wallReach: number;
  /** Two-sine lateral meander of the centreline (tiles, tiles, radians). */
  amp1: number; lam1: number; ph1: number; amp2: number; lam2: number; ph2: number;
  /** Carve footprint (centreline ± floorHalf + wallReach), fully inside the region. */
  bbox: { x0: number; y0: number; x1: number; y1: number };
}
const CANYON_SALT = 0x6361; // "ca"

/** Lateral meander of a canyon centreline at parameter t. */
function canyonMeander(c: Canyon, t: number): number {
  return c.amp1 * Math.sin((2 * Math.PI * t) / c.lam1 + c.ph1) + c.amp2 * Math.sin((2 * Math.PI * t) / c.lam2 + c.ph2);
}
/** Point on the canyon centreline at parameter t (0..length; defined either side of it too). */
export function canyonCentreAt(c: Canyon, t: number): { x: number; y: number } {
  const m = canyonMeander(c, t);
  return { x: c.sx + c.ux * t - c.uy * m, y: c.sy + c.uy * t + c.ux * m };
}
/** Floor level at parameter t (the 1-Lipschitz floor, integer levels). */
export function canyonFloorAt(c: Canyon, t: number): number {
  return c.floor[Math.max(0, Math.min(c.length, Math.round(t)))]!;
}
/** A canyon candidate before its floor array is built (scored on centreline samples only). */
interface CanyonSpec {
  sx: number; sy: number; ux: number; uy: number; length: number; profile: CanyonProfile;
  depth: number; floorStart: number; floorEnd: number;
  floorHalf: number; wallGrade: number;
  amp1: number; lam1: number; ph1: number; amp2: number; lam2: number; ph2: number;
}

export interface ProceduralOptions {
  seed: number;
  /** Tile ids by biome band (low -> high noise). Default: water, sand, grass, forest, rock. */
  bands?: { max: number; tile: number; nodeKinds?: number[]; nodeChance?: number; /** °C baseline */ temp?: number; /** 0..1 */ humidity?: number }[];
  /** Large-scale temperature variation amplitude in °C (default 8) over `climateScale` tiles (default 512). */
  climateAmplitude?: number; climateScale?: number;
  /** ADR-246: wet lowland mud (tile 9) on the grass/dirt band just above the shore band where a moisture field is high.
   *  false = off. Defaults: MUD_DEFAULTS. */
  mud?: false | { tile?: number; band?: number; moisture?: number; scale?: number };
  /** ADR-249: ground cover on the existing bands (tile ids / node placement; height is ADR-254). false = off.
   *  Defaults: COVER_DEFAULTS (shallow water ring at shores, forest floor in the woods' interior, snow on cold peaks). */
  cover?: false | Partial<typeof COVER_DEFAULTS>;
  /** ADR-254: cap on generated height levels (default HEIGHT_MAX). Tests may lower it. */
  heightMax?: number;
  /** ADR-530: floor on generated height levels (default HEIGHT_MIN). Tests may raise it. */
  heightMin?: number;
  /** ADR-255: forced lake / river / pond. false = off (tests). Default on. */
  waterFeatures?: false;
  /** ADR-383: elevated lake (water above sea level, held in a bowl of higher terrain). false = off (tests).
   *  Defaults: ELEVATED_LAKE_DEFAULTS (level 4..7, radius 6..10, distance 84..104, 4-tile rim). */
  elevatedLakes?: false | ElevatedLakeOptions;
  /** ADR-255: place every band node kind at least once near the origin. false = off. Default on. */
  guaranteeNodes?: false;
  /** ADR-500: sunken caches — the resource id of the `sunken_cache` node (resolved by the caller from the
   *  gameplay defs) and the per-deep-water-tile scatter chance. Off unless the kind is set, so generators
   *  built without it (travel, preview, spawn points, tests) are byte-identical to before. */
  sunkenCacheKind?: number;
  sunkenCacheChance?: number;
  /** ADR-532: canyons (carved channels with graded entries, exits, and crossings). false =
   *  off (tests — the canyon-free control for the wall-step comparison). Defaults on. */
  canyons?: false;
  /** ADR-533: dendritic river/stream networks (outside region zero — the starter river stays
   *  byte-identical). false = off (tests — the network-free control). Defaults on. */
  rivers?: false;
  /** ADR-533: sink-pond reeds — the resource id of the `reed_bed` node (resolved by the caller
   *  from the gameplay defs, like ADR-500's sunkenCacheKind) and the per-sink-mud-tile scatter
   *  chance. Off unless the kind is set, so generators built without it are byte-identical. */
  sinkReedKind?: number;
  sinkReedChance?: number;
  /** ADR-530 fix-up: flat benches / plateaus in the wilderness smooth field. false = off (tests).
   *  Defaults: BENCH_DEFAULTS. A bench is a seeded disc (one per lattice cell) whose core is pinned
   *  exactly flat at the local mean level, with a skirt that blends back to the natural field,
   *  completing exactly at the cell boundary — so no new >3-level wall appears and neighbouring
   *  benches never interact. Benches sit outside the protected spawn disc (their cell can never
   *  reach Chebyshev 160 of the origin), so the inner zone stays byte-identical and the
   *  region-zero starter layout is untouched. */
  benches?: false | Partial<BenchOptions>;
}
/** ADR-249 ground cover. shallow: water (1) within `shallowBand` noise of the shore -> 8. forest: forest-band dirt (4)
 *  at least `forestMargin` noise inside the band where a canopy field > `canopy` -> 7 (edges stay dirt / farmable).
 *  snow: rock (5) at noise >= `snowLine` whose base temperature (band temp + large-scale variation) <= `snowTemp` °C -> 6. */
const NEIGH4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
export const COVER_DEFAULTS = { shallowBand: 0.03, forestMargin: 0.03, canopy: 0.42, canopyScale: 14, snowLine: 0.86, snowTemp: 12 } as const;
const CANOPY_SALT = 0x666f72;
/** ADR-246 mud: tile, noise width above the sand band, moisture threshold (0..1), moisture noise scale (tiles). */
export const MUD_DEFAULTS = { tile: 9, band: 0.045, moisture: 0.56, scale: 9 } as const;
const MUD_SALT = 0x6d7564;
export const DEFAULT_BANDS = [
  { max: 0.3, tile: 1, temp: 16, humidity: 0.9 },                                   // water
  { max: 0.36, tile: 2, nodeKinds: [4], nodeChance: 0.01, temp: 22, humidity: 0.5 }, // sand: loose rocks
  { max: 0.62, tile: 3, nodeKinds: [1, 2, 3], nodeChance: 0.03, temp: 18, humidity: 0.55 }, // grass: branches, grass, bush
  { max: 0.8, tile: 4, nodeKinds: [5, 1], nodeChance: 0.08, temp: 15, humidity: 0.7 },  // forest: trees
  { max: 1.01, tile: 5, nodeKinds: [6, 7], nodeChance: 0.04, temp: 8, humidity: 0.35 }, // rock: boulder, iron
];
/** Seeded procedural generator stub: biome noise + resource node placement. Pure function of (seed, cx, cy). */
/** ADR-500: default per-deep-water-tile sunken-cache chance (~2 per lake; 1,287 deep tiles in the 49-chunk
 *  seed-42 grid give ~26 caches). */
export const SUNKEN_CACHE_CHANCE_DEFAULT = 0.02;
/** ADR-533: default per-sink-mud-tile reed chance (a sink has ~10 mud tiles, so ~2-3 reed beds each). */
export const SINK_REED_CHANCE_DEFAULT = 0.25;
/** ADR-255: radius (tiles) around the origin that always contains every guaranteed resource node.
 *  ADR-423: stays 160 — the guarantee is about the starter area around spawn, which region zero
 *  preserves exactly; scaling it would push guaranteed nodes away from the unchanged starter features. */
export const NODE_GUARANTEE_RADIUS = 160;

export class ProceduralGenerator implements ChunkProvider, BaseClimateSource {
  private bands: NonNullable<ProceduralOptions["bands"]>;
  private readonly water: WaterFeatureLayout | undefined;
  /** ADR-383: elevated-lake knobs (undefined = feature off). Always passed to waterFeatureLayout so region
   *  layouts use the same knobs; the layout still computes a lake when off, but nothing reads it. */
  private readonly elevated: Required<ElevatedLakeOptions> | undefined;
  private readonly regionWater = new Map<string, { seed: number; layout: WaterFeatureLayout }>();
  /** ADR-531: memoised massif layouts per scaled region (cap 16, like regionWater). */
  private readonly regionMassifs = new Map<string, Massif[]>();
  /** ADR-532: memoised canyon layouts per scaled region (cap 16, like regionMassifs). */
  private readonly regionCanyons = new Map<string, Canyon[]>();
  /** ADR-533: memoised river networks per scaled region (cap 16, like massifs/canyons). */
  private readonly regionRivers = new Map<string, RiverNetwork>();
  /** ADR-530 fix-up: memoised bench levels per lattice cell (cap 1024, FIFO like regionWater). */
  private readonly benchCellStatsCache = new Map<string, { level: number; range: number }>();
  private readonly benchMaxR0Cache = new Map<string, number>();
  /** ADR-530 fix-up: bench knobs (undefined = benches off). */
  private readonly benchOpts: BenchOptions | undefined;
  private guaranteed: { kind: number; tx: number; ty: number }[] | undefined;
  /** kind -> band tile ids that may host it (from nodeKinds lists). */
  private readonly kindTiles: Map<number, number[]>;
  private readonly allKinds: number[];
  /** ADR-534: the water band and its noise max (the normal sea threshold). */
  private readonly waterBand: NonNullable<ProceduralOptions["bands"]>[number];
  private readonly seaMax: number;
  constructor(readonly opts: ProceduralOptions) {
    this.bands = opts.bands ?? DEFAULT_BANDS;
    this.waterBand = this.bands.find((b) => b.tile === 1) ?? this.bands[0]!;
    this.seaMax = this.waterBand.max;
    this.benchOpts = opts.benches === false ? undefined : { ...BENCH_DEFAULTS, ...(opts.benches ?? {}) };
    if (this.benchOpts) {
      // The core must fit inside its own lattice cell with room for a ramp in every direction:
      // the centre sits at cell/2 (+/- jitter) from the cell's edges, so coreMax is clamped to
      // cell/2 - jitter - 2. Each cell is then self-contained — two benches can never interact,
      // so no Voronoi step between pinned levels and no jump ring where a skirt ends (measured
      // up to 109 levels / BFS 49-80% on cross-cell designs).
      const maxR0 = Math.floor(this.benchOpts.cell / 2 - this.benchOpts.jitter) - 2;
      this.benchOpts = { ...this.benchOpts, coreMax: Math.min(this.benchOpts.coreMax, maxR0), coreMin: Math.min(this.benchOpts.coreMin, maxR0) };
    }
    this.elevated = opts.elevatedLakes === false ? undefined : { ...ELEVATED_LAKE_DEFAULTS, ...(opts.elevatedLakes ?? {}) };
    this.water = opts.waterFeatures === false ? undefined : waterFeatureLayout(opts.seed, this.elevated);
    // ADR-386: noise-aware siting for region zero's elevated lake (uses the height field, so it runs
    // here, not in waterFeatureLayout — the hash layout is only the baseline).
    if (this.water) this.siteElevatedLake(0, 0, this.opts.seed, this.water, this.elevated, 1);
    const kt = new Map<number, Set<number>>();
    for (const b of this.bands) for (const k of b.nodeKinds ?? []) {
      let s = kt.get(k); if (!s) kt.set(k, (s = new Set())); s.add(b.tile);
    }
    this.kindTiles = new Map([...kt].map(([k, s]) => [k, [...s]]));
    this.allKinds = [...this.kindTiles.keys()];
  }
  /** Region layout + region-local coords for (tx, ty). Region zero preserves ADR-255's starter layout
   *  exactly (scale 1 — same seed, same lake/river/pond at the same coordinates as before ADR-423);
   *  other regions are seeded from their key (fnv1a) and memoized (cap 16, like before), with their
   *  feature layout scaled x3 (REGION_FEATURE_SCALE) to span the 1536-tile region. The layout covers
   *  the whole region (features sit within ±360 of its centre in scaled regions, ±120 in region zero,
   *  but an ADR-386 spillway may run to the region edge); undefined only when water features are off. */
  private layoutFor(tx: number, ty: number): { layout: WaterFeatureLayout; lx: number; ly: number; seed: number } | undefined {
    if (!this.water) return undefined;
    // Every 1536-tile region has seeded features; region zero preserves ADR-255's starter layout.
    const rx = Math.floor((tx + REGION_HALF) / REGION_SIZE), ry = Math.floor((ty + REGION_HALF) / REGION_SIZE);
    if (rx === 0 && ry === 0) return { layout: this.water, lx: tx, ly: ty, seed: this.opts.seed };
    const lx = tx - rx * REGION_SIZE, ly = ty - ry * REGION_SIZE;
    const key = `${rx},${ry}`; let region = this.regionWater.get(key);
    if (!region) {
      const seed = fnv1a(key, this.opts.seed >>> 0);
      // ADR-423: scaled feature layout (x3 distances/radii) + scaled elevated-lake knobs for siting.
      const elevated = this.elevated ? scaleElevatedLakeOptions(this.elevated, REGION_FEATURE_SCALE) : undefined;
      region = { seed, layout: waterFeatureLayout(seed, this.elevated, REGION_FEATURE_SCALE) };
      if (this.regionWater.size >= 16) this.regionWater.delete(this.regionWater.keys().next().value!);
      this.regionWater.set(key, region);
      // ADR-534: site the great lake where its shore works, BEFORE the elevated lake is sited
      // (the elevated siting's great-lake clearance then sees the final lake position).
      this.siteGreatLake(rx * REGION_SIZE, ry * REGION_SIZE, region.layout);
      // ADR-386: noise-aware siting + spillway for this region's elevated lake (stored in the map
      // first, so a re-entrant lookup during siting sees the in-progress region).
      this.siteElevatedLake(rx * REGION_SIZE, ry * REGION_SIZE, seed, region.layout, elevated, REGION_FEATURE_SCALE);
    }
    return { layout: region.layout, lx, ly, seed: region.seed };
  }
  /** ADR-386: the sited water-feature layout covering (tx, ty) — the elevated lake as noise-aware
   *  siting placed it (undefined when the region has no elevated lake), or undefined outside any
   *  feature window. Tests and callers that need the real lake position use this, not the hash layout. */
  regionLayout(tx: number, ty: number): WaterFeatureLayout | undefined {
    return this.layoutFor(tx, ty)?.layout;
  }
  private forcedWater(tx: number, ty: number): boolean {
    // ADR-533: a network channel is forced water too (its tiles are water even where the hash
    // layout says none) — biomeOrForcedWater (shore/shallow logic) must see it as water.
    const net = this.riverNetAt(tx, ty);
    if (net && (net.kind === "channel" || net.kind === "sinkWater")) return true;
    const reg = this.layoutFor(tx, ty); if (!reg) return false;
    // ADR-386: a spillway channel is water too (its tiles are flow-encoded in load()/sampleAt).
    return isForcedWater(reg.seed, reg.lx, reg.ly, reg.layout) || spillLevelAt(reg.layout, reg.lx, reg.ly) !== undefined;
  }
  /**
   * ADR-531: the massifs of region (rx, ry) — 1–3 seeded bumps, or [] in region zero (the starter
   * region keeps its layout exactly, and every non-zero region is ≥768 tiles from the origin, so
   * no massif ever comes within 384 of spawn). Memoised (cap 16, like regionWater); deterministic
   * in (seed, rx, ry). Centres sit on low-to-moderate base ground (preferred band −10..25, so a
   * massif is a prominence rising from its surroundings, not a bump on an already-high plateau),
   * clear of forced water, great lakes and biome sea, ≥280 tiles apart (so the saddle between
   * neighbours is a real dip), and with their discs inside the region (no cross-region lookup).
   */
  massifsInRegion(rx: number, ry: number): Massif[] {
    if (rx === 0 && ry === 0) return [];
    const key = `${rx},${ry}`;
    const hit = this.regionMassifs.get(key); if (hit) return hit;
    const ms = this.computeMassifs(rx, ry);
    if (this.regionMassifs.size >= 16) this.regionMassifs.delete(this.regionMassifs.keys().next().value!);
    this.regionMassifs.set(key, ms);
    return ms;
  }
  private computeMassifs(rx: number, ry: number): Massif[] {
    const seed = fnv1a(`${rx},${ry}`, this.opts.seed >>> 0);
    const rng = new Rng(seed);
    const n = 1 + rng.int(0, 3);
    const ox = rx * REGION_SIZE, oy = ry * REGION_SIZE;
    // Sited water layout for avoidance — waterFeatureLayout's hash position is only the baseline:
    // siting MOVES the elevated lake, and a massif centred on the sited disc has its summit
    // swallowed by the bowl override (measured: a peak-56 mesa reading 6, a peak-32 volcano
    // reading 100 at its rim). layoutFor triggers siting, which is deterministic here — its
    // probes read the base field with massifs off, so no circularity and no call-order dependence.
    // When water features are off there is nothing to avoid.
    const sited = this.water ? this.layoutFor(ox, oy)?.layout : undefined;
    const candidates: { x: number; y: number; base: number }[] = [];
    for (let i = 0; i < 10; i++) {
      // Centres stay 392 in from the region edge: the largest disc (a ridge at amp 130 ×
      // wSlope 1.6 × elongation 1.8 ≈ 374) still fits inside the region.
      const lx = Math.round(rng.range(-392, 392)), ly = Math.round(rng.range(-392, 392));
      const x = ox + lx, y = oy + ly;
      if (sited) {
        const k = waterFeatureAt(seed, lx, ly, sited);
        // The elevated-lake kind counts only when elevated lakes are on (otherwise the sited
        // layout still carries the hash baseline, which the generator ignores).
        if (k !== "none" && (k !== "elevatedLake" || this.elevated)) continue;
        if (sited.greatLake && Math.hypot(lx - sited.greatLake.x, ly - sited.greatLake.y) <= sited.greatLake.r + 10) continue;
        if (this.elevated && sited.elevatedLake) {
          // The bowl raises ground around the disc (rim + rimWidth); keep the centre clear of
          // it, so the massif's base is the true natural field, not the bowl's flat shelf.
          const el = sited.elevatedLake;
          const rim = this.elevated.rimWidth * REGION_FEATURE_SCALE;
          if (Math.hypot(lx - el.x, ly - el.y) <= el.r + rim + 10) continue;
        }
        // A spillway channel overrides heights to its own levels — a summit on one would read
        // as the channel, not the peak.
        if (sited.spillway && sited.spillway.tiles.some((t) => Math.abs(t.x - lx) < 25 && Math.abs(t.y - ly) < 25)) continue;
      }
      // ADR-534: the widened sea — no massif is sited in an ocean sector (it would be a
      // submarine mountain, its bump invisible under sea water).
      if (this.isBiomeSea(x, y)) continue;
      candidates.push({ x, y, base: this.naturalHeightAt(x, y) });
    }
    // Prefer base ground near −10..25 (distance from that band, then lower base first): a massif
    // rising from a deep basin would need an oversized bump to reach its target peak.
    const baseScore = (base: number): number => (base < -10 ? -10 - base : base > 25 ? base - 25 : 0);
    candidates.sort((a, b) => baseScore(a.base) - baseScore(b.base) || a.base - b.base);
    const picked: { x: number; y: number; base: number }[] = [];
    for (const cap of [30, 60, Infinity]) {
      for (const c of candidates) {
        if (picked.length >= n) break;
        if (picked.includes(c)) continue;
        if (c.base > cap) continue;
        if (picked.some((p) => Math.hypot(p.x - c.x, p.y - c.y) < 280)) continue;
        picked.push(c);
      }
      if (picked.length >= n) break;
    }
    if (!picked.length && candidates.length) picked.push(candidates[0]!); // unreachable in practice — never 0 massifs
    if (!picked.length) picked.push({ x: ox, y: oy, base: this.naturalHeightAt(ox, oy) });
    const out: Massif[] = [];
    for (const c of picked) {
      const roll = rng.next();
      const shape: MassifShape = roll < 0.25 ? "cone" : roll < 0.45 ? "ridge" : roll < 0.65 ? "mesa" : roll < 0.85 ? "dome" : "volcano";
      const pr = rng.next();
      const sampled = pr < 0.65 ? 30 + rng.next() * 35 : pr < 0.97 ? 70 + rng.next() * 20 : 95 + rng.next() * 5;
      // A full-100 peak is a ~3% signature roll, and a massif never overshoots its own bump:
      // the target is capped at base + 120 so the summit lands on it instead of under it.
      let peak = Math.round(Math.min(sampled, c.base + 120));
      let amp = Math.max(20, Math.min(130, Math.round(peak - c.base)));
      const wSlope = shape === "dome" ? 1.9 : shape === "mesa" ? 1.7 : 1.6;
      const ridgeElongation = shape === "ridge" ? 1.8 : 1;
      const ridgeDir = rng.next() * 2 * Math.PI;
      // The slope side faces the gentlest natural descent, not a random direction: a massif
      // sited on a steep natural hillside has no walkable face on its uphill side (measured:
      // a peak-34 cone whose slope ray climbed to 67 — its "summit" sat on a sustained
      // 2-levels/tile natural face no ≤1-step path could cross). Sample 16 directions; for
      // each, walk the ray to the disc edge on the combined field (natural + trial bump) and
      // score the worst 4-tile window gradient — scattered single 2-steps (common in the
      // natural field) score ~0.5, a sustained steep face ~2 — plus a penalty when the ray
      // ends above the summit (the base ring must be below the peak, or the approach climbs
      // over a higher hill to reach a lower "summit"). The gentlest direction is the slope
      // side; the approach path then jogs around scattered steps inside the wide wedge.
      let slopeDir = 0, bestScore = Infinity;
      for (let k = 0; k < 16; k++) {
        const th = (k / 16) * 2 * Math.PI;
        const elongTh = 1 + (ridgeElongation - 1) * Math.cos(th - ridgeDir) ** 2;
        const rTh = amp * wSlope * elongTh;
        const trial: Massif = {
          cx: c.x, cy: c.y, peak, amp, shape, slopeDir: th, slopeHalfWidth: 0.85,
          wSlope, wCliff: 1.0, radius: rTh, ridgeDir, ridgeElongation,
        };
        const steps = Math.max(8, Math.floor(rTh));
        const win: number[] = [this.naturalHeightAt(c.x, c.y) + massifBumpAt(trial, c.x, c.y)];
        for (let r = 1; r <= steps; r++) {
          const x = Math.round(c.x + Math.cos(th) * r), y = Math.round(c.y + Math.sin(th) * r);
          const h = this.naturalHeightAt(x, y) + massifBumpAt(trial, x, y);
          win.push(h);
        }
        let worst = 0;
        for (let r = 0; r + 4 <= steps; r++) worst = Math.max(worst, Math.abs(win[r + 4]! - win[r]!) / 4);
        const endPenalty = Math.max(0, win[steps]! - win[0]!) / 8;
        const score = worst + endPenalty;
        if (score < bestScore) { bestScore = score; slopeDir = th; }
      }
      // ADR-534: a volcano's summit is its rim, and no slope side is both gentle and high
      // (measured: seed 1 region (0,1) — the gentlest face sits on a rim 29 below its base,
      // the high rim is a cliff). When the rim cannot carry the target peak, cap the peak
      // to what the rim supports (summit + 12, the test's bar) — but keep amp (the bump
      // that builds the terrain) unchanged, so the massif's shape, radius and slope side
      // are untouched and only its honest target drops. Lowering amp too would drop the
      // summit by the same amount (shortfall = base - rimNatural is amp-invariant), so it
      // cannot fix a shortfall. The +10 (not +12) leaves a 2-level margin for the rounding
      // between this estimate and the test's heightAt at the rounded peak tile (measured: a
      // 1-level gap leaves a 13 shortfall against the 12 bar).
      if (shape === "volcano") {
        const rimR = 0.22 * amp * wSlope;
        const rimNatural = this.naturalHeightAt(Math.round(c.x + Math.cos(slopeDir) * rimR), Math.round(c.y + Math.sin(slopeDir) * rimR));
        const summit = rimNatural + amp;
        if (peak - summit > 12) peak = summit + 10;
      }
      out.push({
        cx: c.x, cy: c.y, peak, amp, shape,
        slopeDir, slopeHalfWidth: 0.85,
        wSlope, wCliff: 1.0, radius: amp * wSlope * ridgeElongation,
        ridgeDir, ridgeElongation,
      });
    }
    return out;
  }
  /** ADR-531: total massif bump at (tx, ty) — the max bump over the tile's own region's massifs
   *  (discs never cross a region edge, so no cross-region lookup). 0 in region zero. */
  private massifBump(tx: number, ty: number): number {
    const rx = Math.floor((tx + REGION_HALF) / REGION_SIZE), ry = Math.floor((ty + REGION_HALF) / REGION_SIZE);
    if (rx === 0 && ry === 0) return 0;
    let best = 0;
    for (const m of this.massifsInRegion(rx, ry)) {
      const b = massifBumpAt(m, tx, ty);
      if (b > best) best = b;
    }
    return best;
  }
  /**
   * ADR-532: the canyons of region (rx, ry) — 1–2 seeded channels, or [] in region zero (the
   * starter region keeps its layout exactly, and every non-zero region is ≥768 tiles from the
   * origin, so no canyon ever comes within 384 of spawn). Memoised (cap 16, like massifs);
   * deterministic in (seed, rx, ry).
   */
  canyonsInRegion(rx: number, ry: number): Canyon[] {
    if (rx === 0 && ry === 0) return [];
    if (this.opts.canyons === false) return [];
    const key = `${rx},${ry}`;
    const hit = this.regionCanyons.get(key); if (hit) return hit;
    const cs = this.computeCanyons(rx, ry);
    if (this.regionCanyons.size >= 16) this.regionCanyons.delete(this.regionCanyons.keys().next().value!);
    this.regionCanyons.set(key, cs);
    return cs;
  }
  private computeCanyons(rx: number, ry: number): Canyon[] {
    const seed = fnv1a(`canyon:${rx},${ry}`, this.opts.seed >>> 0);
    const rng = new Rng(seed);
    const ox = rx * REGION_SIZE, oy = ry * REGION_SIZE;
    // Sited water layout for avoidance — same reasoning as computeMassifs: siting MOVES the
    // elevated lake, and a bowl rim across the canyon floor would be a >3 wall across the
    // walk. layoutFor triggers siting, which reads the base field with canyons off, so no
    // circularity and no call-order dependence. When water features are off there is nothing
    // to avoid.
    const sited = this.water ? this.layoutFor(ox, oy)?.layout : undefined;
    const massifs = this.massifsInRegion(rx, ry);
    const H = this.opts.heightMax ?? HEIGHT_MAX, L = this.opts.heightMin ?? HEIGHT_MIN;
    const want = 1 + (rng.next() < 0.35 ? 1 : 0);
    const picked: Canyon[] = [];
    for (let slot = 0; slot < want; slot++) {
      let best: { spec: CanyonSpec; score: number } | undefined;
      // Tier 0 is strict (rim span ≤ 0.35L, separation ≥ 150); tier 1 relaxes the span and
      // the separation before a slot goes unfilled — the obstacle clearances never relax
      // (see tryCanyonCandidate). A missing canyon is a rarer world, not a broken one.
      for (let tier = 0; tier < 2 && !best; tier++) {
        for (let attempt = 0; attempt < 12; attempt++) {
          const cand = this.tryCanyonCandidate(rx, ry, ox, oy, rng, sited, massifs, H, L, tier, picked);
          if (cand && (!best || cand.score < best.score)) best = cand;
        }
      }
      if (best) picked.push(this.buildCanyon(best.spec, L));
    }
    return picked;
  }
  /** ADR-532: one canyon candidate, scored on centreline samples (its floor array is built
   *  only for the winning candidate). Returns undefined when the candidate fails a hard
   *  constraint: the carve footprint must stay inside the region, clear of massif discs,
   *  great lakes and elevated-lake bowls by its own wall reach, clear of already-picked
   *  canyons, and its two rim ends must be close enough that the floor can grade ≤1/tile
   *  between them with room left for the depth ramps. */
  private tryCanyonCandidate(rx: number, ry: number, ox: number, oy: number, rng: Rng,
    sited: WaterFeatureLayout | undefined, massifs: Massif[],
    _H: number, Lbound: number, tier: number, picked: Canyon[]): { spec: CanyonSpec; score: number } | undefined {
    void rx; void ry; void _H;
    const profile: CanyonProfile = rng.next() < 0.55 ? "v" : "slot";
    const floorHalf = profile === "v" ? 7 : 3;
    const wallGrade = profile === "v" ? 1.2 : 1.6;
    const length = 200 + Math.floor(rng.next() * 201);
    const roll = rng.next();
    const depthSampled = Math.round(roll < 0.65 ? 25 + rng.next() * 35 : roll < 0.95 ? 60 + rng.next() * 20 : 85 + rng.next() * 15);
    const theta = rng.next() * 2 * Math.PI;
    const ux = Math.cos(theta), uy = Math.sin(theta);
    // Gentle meander: the centreline's slope stays ≤ ~0.7, so the curve moves ≤1.22 tiles
    // per unit t — a steeper meander (measured 1.38) made consecutive centreline samples
    // span ~1.7 tiles and built 4-level steps on the entry walk and the cross-sections.
    const amp1 = 6 + rng.next() * 5, lam1 = 160 + rng.next() * 80, ph1 = rng.next() * 2 * Math.PI;
    const amp2 = 2 + rng.next() * 1.5, lam2 = 80 + rng.next() * 40, ph2 = rng.next() * 2 * Math.PI;
    const lx = Math.round(rng.range(-450, 450)), ly = Math.round(rng.range(-450, 450));
    const sx = ox + lx, sy = oy + ly;
    // Siting clearance is the WORST-case wall reach: the wall climbs at most the
    // full ±100 range (200 levels) at the profile grade, so a wall can reach
    // floorHalf + 200/grade past the centreline. The clearance is strict in both tiers —
    // relaxing it would let a wall run into a massif disc, where the carve suppression
    // would cut the wall off mid-climb and leave a cliff; only the rim span and the
    // canyon-canyon separation relax in tier 1. Between-sample slack (samples every 8
    // tiles) is covered by the +15.
    const wallReach = floorHalf + Math.ceil(200 / wallGrade) + 15;
    const clearance = wallReach;
    const spec0: Omit<CanyonSpec, "depth" | "floorStart" | "floorEnd"> = {
      sx, sy, ux, uy, length, profile, floorHalf, wallGrade,
      amp1, lam1, ph1, amp2, lam2, ph2,
    };
    const centre = (t: number): { x: number; y: number } => {
      const m = amp1 * Math.sin((2 * Math.PI * t) / lam1 + ph1) + amp2 * Math.sin((2 * Math.PI * t) / lam2 + ph2);
      return { x: sx + ux * t - uy * m, y: sy + uy * t + ux * m };
    };
    // Centreline samples (every 8 tiles) + rim heights, for the clearance and scoring checks.
    const samples: { x: number; y: number; rim: number }[] = [];
    for (let t = 0; t <= length; t += 8) {
      const p = centre(t);
      const lx2 = p.x - ox, ly2 = p.y - oy;
      if (Math.abs(lx2) > REGION_HALF - clearance || Math.abs(ly2) > REGION_HALF - clearance) return undefined;
      for (const m of massifs) {
        if (Math.hypot(p.x - m.cx, p.y - m.cy) - m.radius < clearance) return undefined;
      }
      if (sited?.greatLake && Math.hypot(p.x - (ox + sited.greatLake.x), p.y - (oy + sited.greatLake.y)) - sited.greatLake.r < clearance) return undefined;
      if (this.elevated && sited?.elevatedLake) {
        const rim = this.elevated.rimWidth * REGION_FEATURE_SCALE;
        if (Math.hypot(p.x - (ox + sited.elevatedLake.x), p.y - (oy + sited.elevatedLake.y)) - (sited.elevatedLake.r + rim) < clearance) return undefined;
      }
      samples.push({ ...p, rim: this.preCanyonHeightAt(Math.round(p.x), Math.round(p.y)) });
    }
    // The sample loop steps by 8, so the last sample can sit short of the endpoint —
    // add the endpoint itself so the spillway polyline check covers the whole floor.
    {
      const p = centre(length);
      const last = samples[samples.length - 1]!;
      if (Math.hypot(p.x - last.x, p.y - last.y) > 0.5) {
        const lx2 = p.x - ox, ly2 = p.y - oy;
        if (Math.abs(lx2) > REGION_HALF - clearance || Math.abs(ly2) > REGION_HALF - clearance) return undefined;
        samples.push({ ...p, rim: this.preCanyonHeightAt(Math.round(p.x), Math.round(p.y)) });
      }
    }
    // ADR-532: the spillway channel overrides the carve (water beats canyon — its tiles
    // read the channel level, not the canyon floor), so a spillway crossing the floor
    // band would cut the floor walk with a waterfall face (measured: a 53-level step
    // where a spillway crossed a floor). The channel is 1 tile wide, so the floor band
    // only needs floorHalf + 8 of clearance from its tiles — the walls may cross it
    // (water interrupts a wall harmlessly; it must not interrupt the floor). Checked
    // against the sample POLYLINE (point-to-segment), not the sample points: a 1-tile
    // channel can pass between two samples 8 tiles apart.
    if (sited?.spillway) {
      for (const st of sited.spillway.tiles) {
        const qx = ox + st.x, qy = oy + st.y;
        for (let i = 0; i + 1 < samples.length; i++) {
          const a = samples[i]!, b = samples[i + 1]!;
          const vx = b.x - a.x, vy = b.y - a.y;
          const len2 = vx * vx + vy * vy;
          const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((qx - a.x) * vx + (qy - a.y) * vy) / len2));
          const cx = a.x + u * vx, cy = a.y + u * vy;
          if (Math.hypot(qx - cx, qy - cy) < floorHalf + 8) return undefined;
        }
      }
    }
    for (const o of picked) {
      for (const s of samples) {
        for (let t = 0; t <= o.length; t += 8) {
          const q = canyonCentreAt(o, t);
          if (Math.hypot(q.x - s.x, q.y - s.y) < (tier === 0 ? 150 : 100)) return undefined;
        }
      }
    }
    const p0 = centre(0), p1 = centre(length);
    const floorStart = this.preCanyonHeightAt(Math.round(p0.x), Math.round(p0.y));
    const floorEnd = this.preCanyonHeightAt(Math.round(p1.x), Math.round(p1.y));
    const span = Math.abs(floorEnd - floorStart);
    if (span > (tier === 0 ? 0.35 : 0.5) * length) return undefined;
    const s = 1 - span / length;
    const rimMid = this.preCanyonHeightAt(Math.round(centre(length / 2).x), Math.round(centre(length / 2).y));
    const depth = Math.min(depthSampled, Math.floor(0.4 * s * length), rimMid - Lbound - 2);
    if (depth < 12) return undefined;
    // Score: prefer rims in the 0..70 band (room to dig without hitting the absolute floor,
    // and high enough that a good share of floors stay dry instead of every canyon becoming
    // a river gorge — the natural field centres on 0, so a band starting below 0 fills the
    // survey with sub-sea-level floors), then a small rim span, then depth.
    const meanRim = samples.reduce((a, b) => a + b.rim, 0) / samples.length;
    const bandPenalty = meanRim < 0 ? -meanRim : meanRim > 70 ? meanRim - 70 : 0;
    const score = bandPenalty + 40 * (span / length) - depth * 0.02;
    return { spec: { ...spec0, depth, floorStart, floorEnd }, score };
  }
  /** ADR-532: build a canyon record from a winning spec — the floor array and the carve
   *  footprint bbox. The floor is the rim line minus depth × envelope, clamped to the
   *  absolute floor: the rim line grades span/length ≤ 0.35 and the envelope ramps at
   *  depth/ramp ≤ 1 − span/length, so the floor grades ≤1/tile by construction (rounding a
   *  1-Lipschitz function keeps it 1-Lipschitz, and clamping does too), and it is anchored
   *  at both rims — floor(0) = rimStart, floor(L) = rimEnd, so the mouth has no step at all.
   *  (An earlier design took a 1-Lipschitz envelope of min(rim − depth, ground): the backward
   *  pass pulled floor(0) up to 40 levels below the rim when a bench skirt descended past
   *  the mouth — a cliff at the entry. The floor may sit above the actual ground where the
   *  centreline dips (the realised walk then follows the dip at the natural gradient, ≤3);
   *  the carved height is min(ground, floor), so the walk never steps past the worse of the
   *  natural field and the 1-Lipschitz floor.) */
  private buildCanyon(spec: CanyonSpec, Lbound: number): Canyon {
    const { length, floorStart, floorEnd, depth, floorHalf, wallGrade } = spec;
    const s = 1 - Math.abs(floorEnd - floorStart) / length;
    const ramp = Math.max(1, Math.ceil(depth / Math.max(s, 0.2)));
    const centre = (t: number): { x: number; y: number } => canyonCentreAt(spec as Canyon, t);
    const floor: number[] = [];
    for (let t = 0; t <= length; t++) {
      const rim = floorStart + ((floorEnd - floorStart) * t) / length;
      const env = Math.min(1, t / ramp, (length - t) / ramp);
      floor.push(Math.max(Lbound, Math.round(rim - depth * env)));
    }
    // No wall cutoff: the wall is floor + grade x distance past the floor edge, and it runs
    // until the rising profile meets the local ground (carved = min(ground, profile)), however
    // far that is. A fixed reach cut the wall off mid-climb and left a 65-level cliff where a
    // floor clamped at -100 faced ground at +72; an adaptive per-t wall (rim/width sampled at
    // its own edge) was tried next and was worse — the rim/width pair went stale between the
    // last sample and the stored width, and the hard u>1 cutoff stepped 4 levels at the wall
    // edge. wallReach is only the lookup bound for the bbox: floorHalf + a 200-level climb at
    // the profile grade + slack.
    const wallReach = floorHalf + Math.ceil(200 / wallGrade) + 5;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let t = 0; t <= length; t += 4) {
      const p = centre(t);
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
    const pad = wallReach + 2;
    return {
      ...spec, floor, wallReach,
      bbox: { x0: Math.floor(x0 - pad), y0: Math.floor(y0 - pad), x1: Math.ceil(x1 + pad), y1: Math.ceil(y1 + pad) },
    };
  }
  /** ADR-532: the base height without canyons (massifs + benches included). Canyon siting
   *  reads this, so a canyon never sits on its own carve; water/massif siting never sees a
   *  canyon either (they pass includeCanyons=false), so siting never depends on call order. */
  private preCanyonHeightAt(tx: number, ty: number): number {
    return this.heightFromNoise(tx, ty, this.noiseAt(tx, ty), null, null, null, true, true, false, null, false);
  }
  /** ADR-532: the canyon profile height at (tx, ty) — the floor level inside the floor band,
   *  rising at the wall grade past it, with no cutoff (the wall ends where the rising profile
   *  meets the local ground) — or undefined where no canyon reaches. The deepest (lowest)
   *  profile wins where two canyons would overlap (siting keeps them apart, so this is
   *  belt-and-braces). The profile is a pure function of the canyon record; the generator and
   *  the tests share it through canyonsInRegion + canyonCentreAt/canyonFloorAt. */
  private canyonProfileAt(tx: number, ty: number): { profile: number; d: number; floorHalf: number } | undefined {
    const rx = Math.floor((tx + REGION_HALF) / REGION_SIZE), ry = Math.floor((ty + REGION_HALF) / REGION_SIZE);
    if (rx === 0 && ry === 0) return undefined;
    let best: { profile: number; d: number; floorHalf: number } | undefined;
    for (const c of this.canyonsInRegion(rx, ry)) {
      if (tx < c.bbox.x0 || tx > c.bbox.x1 || ty < c.bbox.y0 || ty > c.bbox.y1) continue;
      const dx = tx - c.sx, dy = ty - c.sy;
      const t = dx * c.ux + dy * c.uy;
      const lat = -dx * c.uy + dy * c.ux;
      let tt: number, d: number;
      if (t < 0) {
        const p = canyonCentreAt(c, 0);
        d = Math.hypot(tx - p.x, ty - p.y); tt = 0;
      } else if (t > c.length) {
        const p = canyonCentreAt(c, c.length);
        d = Math.hypot(tx - p.x, ty - p.y); tt = c.length;
      } else {
        d = Math.abs(lat - canyonMeander(c, t)); tt = t;
      }
      if (d > c.floorHalf + c.wallReach) continue;
      const ti = Math.max(0, Math.min(c.length, Math.round(tt)));
      const floor = c.floor[ti]!;
      // Integer levels: the wall profile is continuous in d, so it must be floored — a
      // fractional profile would leak fractional heights out of heightAt (Chunk heights are
      // i16 and would truncate them on load, so the stored chunk and heightAt would disagree).
      // The wall rises at the profile grade with no cutoff: carved = min(ground, profile) ends
      // the wall wherever the rising profile meets the local ground, so there is no footprint
      // edge to step off (a fixed reach cut it off mid-climb; a per-t adaptive wall went
      // stale at its own edge). The profile step between 4-neighbours stays <=3: the wall
      // gradient plus the meander drift caps at ~2.7 before flooring at the 1.6 slot grade.
      const profile = d <= c.floorHalf ? floor : Math.floor(floor + c.wallGrade * (d - c.floorHalf));
      if (!best || profile < best.profile) best = { profile, d, floorHalf: c.floorHalf };
    }
    return best;
  }
  /**
   * ADR-533: the river network of region (rx, ry) — or the empty network in region zero (the
   * starter region keeps its layout exactly) and when rivers are off. Memoised (cap 16, like
   * massifs/canyons); deterministic in (seed, rx, ry). The empty network is stored first, so
   * a re-entrant lookup during planning sees the in-progress region instead of recomputing.
   */
  riversInRegion(rx: number, ry: number): RiverNetwork {
    if (rx === 0 && ry === 0) return EMPTY_RIVER_NETWORK;
    if (this.opts.rivers === false) return EMPTY_RIVER_NETWORK;
    const key = `${rx},${ry}`;
    const hit = this.regionRivers.get(key); if (hit) return hit;
    this.regionRivers.set(key, EMPTY_RIVER_NETWORK);
    const net = this.computeRivers(rx, ry);
    if (this.regionRivers.size >= 16) this.regionRivers.delete(this.regionRivers.keys().next().value!);
    this.regionRivers.set(key, net);
    return net;
  }
  /**
   * ADR-546: region-siting precompute — take the first-touch hitch off the chunk-load path.
   *
   * The first chunk in a fresh 1536-tile region pays the whole siting plan at once (water layout
   * + great/elevated-lake siting, massifs, canyons, river network: 57–263 ms VM, rivers alone
   * 13–194 ms). `precomputeRegionPlans` warms those memoised plans for the region(s) the player
   * is about to enter, sliced across calls: at most REGION_PRECOMPUTE_PIECES_PER_CALL plan
   * pieces per call, in dependency order (water → massifs → canyons → rivers), so the cost
   * lands while the player is still REGION_PRECOMPUTE_DISTANCE_TILES from the boundary — at
   * sprint speed (4.64 tiles/s) that is ~55 s of travel for a 4-piece region — instead of on
   * the first chunk load past it. Bound: at most REGION_PRECOMPUTE_MAX_REGIONS adjacent
   * regions (edge-adjacent only, nearest boundary first; the diagonal region is not warmed),
   * and only for real players — bots are world-wide, and warming around all 8 of them would
   * be wasted work if the player never crosses (see game.ts, which calls this per real player).
   *
   * Scheduling only, not new worldgen: every piece is the same memoised accessor load()
   * would call, with the same seed and inputs, so layouts are byte-identical with or without
   * warming (pinned by the ADR-546 test). Returns the pieces still queued (0 = everything the
   * player is near is warm). Region zero is skipped — its plan is the constructor's starter
   * layout (water) and empty massif/canyon/river plans, already warm.
   */
  precomputeRegionPlans(x: number, y: number): number {
    for (const [rx, ry] of regionsToPrecompute(x, y)) {
      if (rx === 0 && ry === 0) continue;
      for (const piece of REGION_PLAN_PIECES) {
        const key = `${rx},${ry}:${piece}`;
        if (this.precomputeQueued.has(key) || this.isPlanPieceWarm(piece, rx, ry)) continue;
        this.precomputeQueued.add(key);
        this.precomputeQueue.push({ rx, ry, piece });
      }
    }
    // Slice across calls: warm at most PIECES_PER_CALL pieces per call, in queue order
    // (dependency order within each region, nearest-boundary region first).
    for (let n = 0; n < REGION_PRECOMPUTE_PIECES_PER_CALL; n++) {
      const next = this.precomputeQueue.shift();
      if (!next) break;
      this.precomputeQueued.delete(`${next.rx},${next.ry}:${next.piece}`);
      this.warmPlanPiece(next.piece, next.rx, next.ry);
    }
    return this.precomputeQueue.length;
  }
  /** ADR-546: the pieces of one region's siting plan, in dependency order. */
  private readonly precomputeQueue: Array<{ rx: number; ry: number; piece: RegionPlanPiece }> = [];
  private readonly precomputeQueued = new Set<string>();
  private isPlanPieceWarm(piece: RegionPlanPiece, rx: number, ry: number): boolean {
    const key = `${rx},${ry}`;
    // Pieces whose accessor returns early without memoising (feature off) count as warm —
    // otherwise they would re-queue on every call and churn the queue.
    switch (piece) {
      case "water": return !this.water || this.regionWater.has(key);
      case "massifs": return this.regionMassifs.has(key);
      case "canyons": return this.opts.canyons === false || this.regionCanyons.has(key);
      case "rivers": return this.opts.rivers === false || this.regionRivers.has(key);
    }
  }
  private warmPlanPiece(piece: RegionPlanPiece, rx: number, ry: number): void {
    const ox = rx * REGION_SIZE, oy = ry * REGION_SIZE;
    switch (piece) {
      case "water": this.regionLayout(ox, oy); break;
      case "massifs": this.massifsInRegion(rx, ry); break;
      case "canyons": this.canyonsInRegion(rx, ry); break;
      case "rivers": this.riversInRegion(rx, ry); break;
    }
  }
  private computeRivers(rx: number, ry: number): RiverNetwork {
    const ox = rx * REGION_SIZE, oy = ry * REGION_SIZE;
    if (!this.water) return EMPTY_RIVER_NETWORK;
    const reg = this.layoutFor(ox, oy);
    if (!reg) return EMPTY_RIVER_NETWORK;
    const layout = reg.layout;
    const regionSeed = reg.seed;
    const scale = REGION_FEATURE_SCALE;
    const rim = this.elevated ? this.elevated.rimWidth * scale : 0;
    const isLowWater = (lx: number, ly: number): boolean => {
      if (islandAt(layout, lx, ly)) return false;
      // ADR-534: the widened sea — an ocean sector is a mouth like any other sea water.
      if (this.isBiomeSea(ox + lx, oy + ly)) return true;
      const k = waterFeatureAt(regionSeed, lx, ly, layout);
      if (k === "lake" || k === "river" || k === "pond" || k === "greatLake") return true;
      // ADR-532: canyon-floor water (a sub-sea-level floor holds water) is a valid mouth.
      const prof = this.canyonProfileAt(ox + lx, oy + ly);
      if (prof && this.preNetworkHeightAt(ox + lx, oy + ly) < 0 && (prof.d <= prof.floorHalf || prof.profile < 0)) return true;
      return false;
    };
    const isBlocked = (lx: number, ly: number): boolean => {
      if (this.elevated && layout.elevatedLake && elevatedLakeDist(layout, lx, ly) <= layout.elevatedLake.r + rim) return true;
      if (islandAt(layout, lx, ly)) return true;
      if (spillLevelAt(layout, lx, ly) !== undefined) return true;
      return false;
    };
    const ctx: RiverNetworkContext = {
      seed: this.opts.seed, rx, ry, ox, oy,
      heightAt: (tx, ty) => this.preNetworkHeightAt(tx, ty),
      isLowWater, isBlocked,
      massifs: this.massifsInRegion(rx, ry).map((m) => ({ cx: m.cx, cy: m.cy, radius: m.radius, slopeDir: m.slopeDir, slopeHalfWidth: m.slopeHalfWidth })),
      // Geometric water anchors (absolute coords) for the planner's room check and target
      // selection — the sited layout's lake/pond/greatLake discs and the sine river's
      // centreline sampled at 64 points. The ring scans they replace were the plan's dominant
      // cost (O(rings^2) layout lookups per source); a geometric distance is O(anchors).
      // The elevated lake is excluded: it is blocked ground for the planner, not a mouth.
      // The biome sea and canyon-floor water are not anchors (no feature to measure to) —
      // a source near one gets a conservative "no room" verdict and a target on a feature,
      // and the walk still ends at the first water it touches, sea included.
      // ADR-534: the huge lakes (absolute coords) — the planner guarantees each one >= 2
      // feeder rivers in and >= 1 outflow river out (see planRiverNetwork).
      hugeLakes: layout.greatLake ? [{ x: ox + layout.greatLake.x, y: oy + layout.greatLake.y, r: layout.greatLake.r }] : [],
      waterAnchors: {
        discs: [
          { x: ox + layout.lake.x, y: oy + layout.lake.y, r: layout.lake.r },
          { x: ox + layout.pond.x, y: oy + layout.pond.y, r: layout.pond.r },
          ...(layout.greatLake ? [{ x: ox + layout.greatLake.x, y: oy + layout.greatLake.y, r: layout.greatLake.r }] : []),
        ],
        riverPts: (() => {
          const pts: { x: number; y: number }[] = [];
          for (let i = 0; i <= 64; i++) {
            const p = riverPoint(layout, -layout.river.halfLen + (2 * layout.river.halfLen * i) / 64);
            pts.push({ x: ox + p.x, y: oy + p.y });
          }
          return pts;
        })(),
        riverWidth: layout.river.width,
      },
    };
    return planRiverNetwork(ctx);
  }
  /** ADR-533: the base height without networks (massifs + benches + canyons included). Network
   *  siting reads this, so a stream never sits on its own carve; every other siting probe
   *  passes includeRivers=false too, so no siting can trigger (or depend on) a network. */
  private preNetworkHeightAt(tx: number, ty: number): number {
    return this.heightFromNoise(tx, ty, this.noiseAt(tx, ty), null, null, null, true, true, true, null, false);
  }
  /** ADR-533: the painted network tile at (tx, ty) (channel / sink water / delta sand /
   *  sink mud), or undefined. Bbox-gated, so tiles nowhere near a channel pay one map lookup. */
  private riverNetAt(tx: number, ty: number): NetTileInfo | undefined {
    if (this.opts.rivers === false) return undefined;
    const rx = Math.floor((tx + REGION_HALF) / REGION_SIZE), ry = Math.floor((ty + REGION_HALF) / REGION_SIZE);
    if (rx === 0 && ry === 0) return undefined;
    const net = this.riversInRegion(rx, ry);
    if (!net.bbox || tx < net.bbox.x0 || tx > net.bbox.x1 || ty < net.bbox.y0 || ty > net.bbox.y1) return undefined;
    return net.tiles.get(`${tx},${ty}`);
  }
  /** ADR-533: downstream unit direction on a network river tile, or undefined (not a network
   *  channel, or still sink water). Used by riverCurrentAt (gameplay) via the seeded generator. */
  networkCurrentAt(tx: number, ty: number): { x: number; y: number } | undefined {
    const info = this.riverNetAt(tx, ty);
    if (!info || info.kind !== "channel") return undefined;
    if (info.dx === 0 && info.dy === 0) return undefined;
    return { x: info.dx, y: info.dy };
  }
  /** ADR-530 fix-up: true when (tx, ty) is within 10 tiles of a massif disc (Chebyshev distance
   *  to the centre <= radius + 10). Benches are suppressed there (see heightFromNoise): the
   *  ADR-531 slope path starts up to R+8 outside the disc, and a bench skirt on the approach
   *  can wall the disc entry off with a >1 step. Massif centres sit >=392 in from a region
   *  edge and the largest disc is ~374, so a disc edge is within 2 tiles of a region edge at
   *  most — the 10-tile buffer can cross it, so tiles near a region edge check the neighbour
   *  region(s) too. massifsInRegion is memoised, so this is cheap. */
  private nearMassif(tx: number, ty: number): boolean {
    const rx = Math.floor((tx + REGION_HALF) / REGION_SIZE), ry = Math.floor((ty + REGION_HALF) / REGION_SIZE);
    const ox = tx - rx * REGION_SIZE, oy = ty - ry * REGION_SIZE;
    const regions: [number, number][] = [[rx, ry]];
    if (ox > REGION_HALF - 12) regions.push([rx + 1, ry]);
    if (ox < -REGION_HALF + 12) regions.push([rx - 1, ry]);
    if (oy > REGION_HALF - 12) regions.push([rx, ry + 1]);
    if (oy < -REGION_HALF + 12) regions.push([rx, ry - 1]);
    for (const [arx, ary] of regions) {
      for (const m of this.massifsInRegion(arx, ary)) {
        if (Math.max(Math.abs(tx - m.cx), Math.abs(ty - m.cy)) <= m.radius + 10) return true;
      }
    }
    return false;
  }
  /** ADR-530 fix-up: the bench geometry of lattice cell (gx, gy) — pure function of (seed, gx, gy),
   *  or undefined when the cell has no bench. All sub-values derive from one hash2 call, split by
   *  multiplication, so a per-tile lookup stays cheap. A bench centre must sit at Chebyshev
   *  distance >= 160 + cell/2 + jitter + 1 from the origin: a cell tile sits at most cell/2 +
   *  jitter from its centre, so no influenced tile can reach the byte-identical inner zone. */
  private benchGeom(gx: number, gy: number): BenchGeom | undefined {
    const o = this.benchOpts; if (!o) return undefined;
    const u = hash2(((this.opts.seed >>> 0) ^ BENCH_SALT) >>> 0, gx, gy);
    if (u >= o.chance) return undefined;
    const frac = (x: number): number => x - Math.floor(x);
    const jx = (frac(u * 73.7) - 0.5) * 2 * o.jitter;
    const jy = (frac(u * 149.3) - 0.5) * 2 * o.jitter;
    const cx = gx * o.cell + o.cell / 2 + jx;
    const cy = gy * o.cell + o.cell / 2 + jy;
    // Outside the protected disc: no bench cell may reach Chebyshev 160 of the origin (the
    // byte-identical inner zone / spawn disc). A cell tile sits at most cell/2 + jitter from
    // its centre in Chebyshev distance, so a centre at >= 160 + cell/2 + jitter + 1 keeps every
    // influenced tile outside 160.
    if (Math.max(Math.abs(cx), Math.abs(cy)) < 160 + o.cell / 2 + o.jitter + 1) return undefined;
    let r0 = Math.max(1, o.coreMin + Math.floor(frac(u * 311.9) * (o.coreMax - o.coreMin + 1)));
    // Face gate: shrink (don't reject) an over-steep bench until its worst single-tile face —
    // the bench grade plus the local natural gradient, sampled per ray — fits the ADR-272 bound.
    // A grade-only gate rejects benches whose ramp is steep only where the natural field is
    // gentle (harmless), and a reject loses the whole bench; shrinking the core lengthens the
    // span, which gentles the ramp, and keeps most of the capture. 0 disables the gate.
    if (o.gradeGate > 0) {
      const maxR0 = this.benchMaxR0(gx, gy, cx, cy);
      if (maxR0 < 14) return undefined;
      r0 = Math.min(r0, maxR0);
    }
    const x0 = gx * o.cell, x1 = x0 + o.cell, y0 = gy * o.cell, y1 = y0 + o.cell;
    const sMax = Math.min(cx - x0, (x1 - 1) - cx, cy - y0, (y1 - 1) - cy);
    return { cx, cy, r0, sMax };
  }
  /** ADR-530 fix-up: the largest core half-side a bench may have without building a face over
   *  the ADR-272 bound (3 levels), or -1 to reject it. For each of 8 rays from the centre, the
   *  face there is (largest |natural - level| along the ray) / (ray span) + (local natural
   *  gradient); solving face <= FACE_T for the core radius gives the ray's cap, and the bench
   *  takes the smallest cap over rays. Memoised per lattice cell; pure in (seed, cell), so no
   *  call-order dependence. */
  private benchMaxR0(gx: number, gy: number, cx: number, cy: number): number {
    const key = `${gx},${gy}`;
    const hit = this.benchMaxR0Cache.get(key); if (hit !== undefined) return hit;
    const o = this.benchOpts!;
    const FACE_T = o.gradeGate; // ADR-272 bound is 3; the default 2.9 leaves margin for rounding
    const level = this.benchCellStats(gx, gy).level;
    const x0 = gx * o.cell, x1 = x0 + o.cell, y0 = gy * o.cell, y1 = y0 + o.cell;
    let cap = Infinity;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const dx = Math.cos(a), dy = Math.sin(a);
      let rEdge = Infinity;
      if (dx > 0) rEdge = Math.min(rEdge, (x1 - cx) / dx);
      else if (dx < 0) rEdge = Math.min(rEdge, (x0 - cx) / dx);
      if (dy > 0) rEdge = Math.min(rEdge, (y1 - cy) / dy);
      else if (dy < 0) rEdge = Math.min(rEdge, (y0 - cy) / dy);
      let maxDev = 0, grad = 0;
      for (const f of [1 / 3, 2 / 3, 1]) {
        const px = Math.round(cx + rEdge * f * dx), py = Math.round(cy + rEdge * f * dy);
        const n = this.pureNaturalHeightAt(px, py);
        maxDev = Math.max(maxDev, Math.abs(n - level));
        grad = Math.max(grad, Math.abs(this.pureNaturalHeightAt(px + 1, py) - n),
          Math.abs(this.pureNaturalHeightAt(px, py + 1) - n));
      }
      // Need maxDev / (rEdge - r0) + grad <= FACE_T. If the natural gradient alone is already
      // at the bound, no core size fixes this ray — reject the bench.
      if (grad >= FACE_T) { cap = -1; break; }
      cap = Math.min(cap, rEdge - maxDev / (FACE_T - grad));
    }
    const maxR0 = cap === -1 ? -1 : Math.floor(cap);
    if (this.benchMaxR0Cache.size >= 1024) this.benchMaxR0Cache.delete(this.benchMaxR0Cache.keys().next().value!);
    this.benchMaxR0Cache.set(key, maxR0);
    return maxR0;
  }
  /** ADR-530 fix-up: a bench cell's pure-field stats — the pinned level (mid-range over the cell,
   *  see benchLevel) and the range. Memoised per lattice cell; pure in (seed, cell), so no
   *  call-order dependence. */
  private benchCellStats(gx: number, gy: number): { level: number; range: number } {
    const key = `${gx},${gy}`;
    const hit = this.benchCellStatsCache.get(key); if (hit) return hit;
    const o = this.benchOpts!;
    let lo = Infinity, hi = -Infinity;
    for (let y = gy * o.cell; y < (gy + 1) * o.cell; y += 6)
      for (let x = gx * o.cell; x < (gx + 1) * o.cell; x += 6) {
        const n = this.pureNaturalHeightAt(x, y);
        if (n < lo) lo = n; if (n > hi) hi = n;
      }
    const stats = { level: Math.round((lo + hi) / 2), range: hi - lo };
    if (this.benchCellStatsCache.size >= 1024) this.benchCellStatsCache.delete(this.benchCellStatsCache.keys().next().value!);
    this.benchCellStatsCache.set(key, stats);
    return stats;
  }
  /** ADR-530 fix-up: a bench's pinned level — the mid-range (min+max)/2 of the pure bench-free
   *  natural field over its whole lattice cell, sampled on a 6-tile grid. The mid-range (not the
   *  core mean) minimises the worst |natural - level| over the skirt, which is what sets the
   *  ramp's steepest grade: the core mean can sit at one end of the cell's range, leaving the
   *  ramp to climb the full range on the far side. The core stays exactly flat at whatever level
   *  is pinned, so footprint capture is unaffected. Memoised per lattice cell; pure in (seed,
   *  cell), so no call-order dependence. */
  private benchLevel(gx: number, gy: number, b: BenchGeom): number {
    return this.benchCellStats(gx, gy).level;
  }
  /** ADR-530 fix-up: the bench-free natural field at (tx, ty) — no massifs, no benches, no
   *  lake/spill/island overrides. Bench levels and massif/siting probes read this, so neither
   *  depends on the other and neither depends on call order. */
  private pureNaturalHeightAt(tx: number, ty: number): number {
    return this.heightFromNoise(tx, ty, this.noiseAt(tx, ty), null, null, null, false, false, false, null, false);
  }
  /** ADR-530 fix-up: the bench of the tile's own lattice cell — with its pinned level — or
   *  undefined when the cell has no bench. A bench's whole influence fits inside its own cell,
   *  so only the tile's own cell can ever reach it: no 3x3 scan, no cross-cell interaction.
   *  Exported for the bench test, which pins the generator property directly. Tiles inside the
   *  protected inner zone never have a bench. */
  benchAt(tx: number, ty: number): Bench | undefined {
    const o = this.benchOpts; if (!o) return undefined;
    if (Math.max(Math.abs(tx), Math.abs(ty)) <= 160) return undefined;
    const gx = Math.floor(tx / o.cell), gy = Math.floor(ty / o.cell);
    const b = this.benchGeom(gx, gy);
    if (!b) return undefined;
    return { cx: b.cx, cy: b.cy, r0: b.r0, level: this.benchLevel(gx, gy, b) };
  }
  /** ADR-530 fix-up: the bench override on the natural field at (tx, ty). Inside the (square)
   *  core the height is pinned exactly flat at the bench level; outside it, a linear blend eases
   *  back to the natural field, completing exactly at the Chebyshev square's edge (s = sMax) —
   *  so both sides of a shared cell edge already read the natural field and the field is
   *  continuous across cell edges by construction. The blend factor depends only on Chebyshev
   *  distance from the centre, so it has no angular variation and builds no radial spoke walls.
   *  Linear, not smoothstep: for a fixed width the linear ramp has the lowest possible peak
   *  gradient (smoothstep concentrates it 1.5x in the middle — measured BFS 97.7% vs the 99% bar
   *  — and the BFS samples every 2 tiles, so peak gradient is what closes rings). Only where the
   *  massif bump is 0, so massif discs read exactly as ADR-531 left them. */
  private benchHeight(tx: number, ty: number, natural: number): number {
    const o = this.benchOpts; if (!o) return natural;
    if (Math.max(Math.abs(tx), Math.abs(ty)) <= 160) return natural;
    const gx = Math.floor(tx / o.cell), gy = Math.floor(ty / o.cell);
    const b = this.benchGeom(gx, gy);
    if (!b) return natural;
    const s = Math.max(Math.abs(tx - b.cx), Math.abs(ty - b.cy));
    const level = this.benchLevel(gx, gy, b);
    if (s <= b.r0) return level;
    if (s >= b.sMax) return natural;
    const u = (s - b.r0) / (b.sMax - b.r0);
    return Math.round(level + (natural - level) * u);
  }
  /** ADR-531: the base height without massifs (the ADR-530 field). Massif siting reads this, so
   *  a massif never sits on its own bump; the elevated-lake siting / spillway probes (which call
   *  heightFromNoise with massifs off) stay identical to ADR-530. */
  private naturalHeightAt(tx: number, ty: number): number {
    return this.heightFromNoise(tx, ty, this.noiseAt(tx, ty), undefined, undefined, undefined, false, false, false, null, false);
  }
  /**
   * ADR-534: noise-aware siting for one region's great lake (scaled regions only — region zero
   * has none). The hash layout puts the lake where the hash says, which can be a deep sub-0
   * basin (seed 42: the shore ring is 98% below sea level, mean −42), where no feeder can walk
   * in (a walk needs ground >= 0 — a channel at level 1 over −42 ground would be a 43-level
   * aqueduct) and no boat can land (the shore is a 42-level cliff). A lake belongs where its
   * shore is land at ~0. Candidates: the hash position, the same diagonal at ±25/±50 tiles,
   * then the other three diagonals at the hash distance. Each candidate is scored by its shore:
   * the fraction of ring samples (r+1..r+4, every 2 tiles, every 6 degrees) that are dry land
   * at base height >= 0. The first candidate scoring >= 0.5 wins; otherwise the best-scoring
   * candidate (the lake stays where its shore is least-bad, and the feeder pass may leave it
   * with fewer than two feeders — a closed basin lake, honestly reported by the ADR-534 survey).
   * The islands translate with the centre (their offsets are preserved). Reads the base field
   * (massifs/benches/canyons off — the same field the elevated siting uses), so there is no
   * circularity with massif/canyon siting (both keep clear of the lake anyway), and the region
   * is already in the map, so a re-entrant layoutFor during probing sees the in-progress region.
   * (originX, originY) is the region's absolute origin; all layout coords are region-local.
   */
  private siteGreatLake(originX: number, originY: number, layout: WaterFeatureLayout): void {
    const g = layout.greatLake; if (!g) return;
    const baseHeight = (lx: number, ly: number): number =>
      this.heightFromNoise(originX + lx, originY + ly, this.noiseAt(originX + lx, originY + ly), null, null, undefined, false, false, false, null, false);
    const isLandShore = (lx: number, ly: number): boolean => {
      if (this.isBiomeSea(originX + lx, originY + ly)) return false;
      return baseHeight(lx, ly) >= 0;
    };
    const shoreScore = (cx: number, cy: number): number => {
      let good = 0, total = 0;
      for (let a = 0; a < 360; a += 6) {
        const th = (a * Math.PI) / 180;
        for (let d = g.r + 1; d <= g.r + 4; d += 2) {
          const lx = Math.round(cx + Math.cos(th) * d), ly = Math.round(cy + Math.sin(th) * d);
          total++;
          if (isLandShore(lx, ly)) good++;
        }
      }
      return total ? good / total : 0;
    };
    const diagonals: readonly (readonly [number, number])[] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    const hashDiag: readonly [number, number] = [Math.sign(g.x), Math.sign(g.y)];
    const hashDist = Math.hypot(g.x, g.y);
    const at = (dx: number, dy: number, d: number): { x: number; y: number } =>
      ({ x: Math.round(dx * d * Math.SQRT1_2) + 0.5, y: Math.round(dy * d * Math.SQRT1_2) + 0.5 });
    const cands: { x: number; y: number }[] = [{ x: g.x, y: g.y }];
    for (const off of [25, -25, 50, -50]) {
      const d = hashDist + off;
      if (d < GREAT_LAKE_MIN_DIST || d > GREAT_LAKE_MAX_DIST) continue;
      cands.push(at(hashDiag[0], hashDiag[1], d));
    }
    for (const dg of diagonals) {
      if (dg[0] === hashDiag[0] && dg[1] === hashDiag[1]) continue;
      cands.push(at(dg[0], dg[1], hashDist));
    }
    let best = cands[0]!, bestScore = -1;
    for (const c of cands) {
      const s = shoreScore(c.x, c.y);
      if (s > bestScore) { bestScore = s; best = c; }
      if (s >= 0.5) break;
    }
    if (best.x !== g.x || best.y !== g.y) {
      const dx = best.x - g.x, dy = best.y - g.y;
      g.x = best.x; g.y = best.y;
      for (const isl of g.islands) { isl.x += dx; isl.y += dy; }
    }
  }

  /**
   * ADR-386: noise-aware siting for one region's elevated lake, then its spillway (see spillwayFor).
   * The hash layout is only the baseline: the lake's cardinal/distance are re-picked by the height
   * field, not the hash. Candidates are the two free cardinals (neither the lake nor the pond uses
   * them) at the hash distance and ±5/±10/±15/±20 tiles along the same cardinal. A candidate is valid only
   * when no biome sea lies within disc + SITING_SEA_MARGIN, so every sited lake has a full land shore
   * (the ADR-383 ~5% no-land-shore case cannot occur for a sited lake). Valid candidates are scored
   * by the MEAN base height in the shelf ring (disc+1..disc+2 — all land by validity; the mean, not
   * the min: one low tile must not tank a whole direction), ties broken by closeness to the hash
   * placement. No valid candidate → the region has no elevated lake
   * (layout.elevatedLake = undefined): skipping beats a sea-merged one.
   * Probing uses the BASE field (el = null: no bowl, no spillway), so there is no circularity — the
   * bowl only ever raises terrain, and a base field clear of sea stays clear once the bowl is in.
   * (originX, originY) is the region's absolute origin; all layout coords are region-local.
   */
  private siteElevatedLake(originX: number, originY: number, regionSeed: number, layout: WaterFeatureLayout,
    /** ADR-423: the region's effective elevated-lake knobs (scaled x3 outside region zero). */
    elevated: Required<ElevatedLakeOptions> | undefined, scale: number): void {
    if (!elevated) return;
    const el = layout.elevatedLake; if (!el) return;
    const opts = elevated;
    const cardinals: readonly (readonly [number, number])[] = [[1, 0], [0, -1], [-1, 0], [0, 1]]; // E, N, W, S
    const cardOf = (x: number, y: number): number => (Math.abs(x) < 2 ? (y > 0 ? 3 : 1) : (x > 0 ? 0 : 2));
    const hashCard = cardOf(el.x, el.y);
    const free = [0, 1, 2, 3].filter((i) => i !== cardOf(layout.lake.x, layout.lake.y) && i !== cardOf(layout.pond.x, layout.pond.y));
    const ordered = [hashCard, ...free.filter((i) => i !== hashCard)];
    const d0 = Math.round(Math.max(Math.abs(el.x), Math.abs(el.y)) - 0.5);
    const isSea = (lx: number, ly: number): boolean => this.isBiomeSea(originX + lx, originY + ly);
    const baseHeight = (lx: number, ly: number): number =>
      this.heightFromNoise(originX + lx, originY + ly, this.noiseAt(originX + lx, originY + ly), null, null, undefined, false, false, false, null, false);
    let best: { x: number; y: number; ringMean: number; dOff: number; order: number } | undefined;
    let hashScore: number | undefined;
    for (let order = 0; order < ordered.length; order++) {
      const ci = ordered[order]!; const [dx, dy] = cardinals[ci]!;
      for (const off of SITING_DIST_STEPS) {
        const d = d0 + off;
        if (d < opts.minDistance || d > opts.maxDistance) continue;
        const cx = Math.round(dx * d) + 0.5, cy = Math.round(dy * d) + 0.5;
        // One pass: valid only when no biome sea lies within disc + margin; score is the MEAN base
        // height of the shelf ring (disc+1 .. disc+2 — all land by validity). The mean, not the min:
        // one low tile must not tank a whole direction, and the mean is what "high surrounding land" is.
        const R = el.r + SITING_SEA_MARGIN;
        let ok = true, ringSum = 0, ringN = 0;
        for (let y = Math.floor(cy - R - 1); y <= Math.ceil(cy + R + 1) && ok; y++)
          for (let x = Math.floor(cx - R - 1); x <= Math.ceil(cx + R + 1); x++) {
            const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
            if (dist > R) continue;
            if (isSea(x, y)) { ok = false; break; }
            if (dist > el.r) { ringSum += baseHeight(x, y); ringN++; }
          }
        if (!ok) {
          continue;
        }
        // ADR-534: the sited disc + rim must stay clear of the enlarged great lake (a relocated
        // bowl rim across the lake would be a land wall across the water and could swallow an
        // island — the ADR-424 siting invariant at the new lake size). The hash cardinal is
        // always far from the diagonal lake, so at least one candidate survives this.
        const gl = layout.greatLake;
        if (gl && Math.hypot(cx - gl.x, cy - gl.y) <= el.r + opts.rimWidth + gl.r + 8) continue;
        const cand = { x: cx, y: cy, ringMean: ringN ? ringSum / ringN : 0, dOff: Math.abs(off), order };
        if (order === 0 && off === 0) hashScore = cand.ringMean;
        if (!best || cand.ringMean > best.ringMean || (cand.ringMean === best.ringMean && (cand.dOff < best.dOff || (cand.dOff === best.dOff && cand.order < best.order)))) best = cand;
      }
    }
    if (!best) {
      // Fallback tier: closer in (below the knob's minDistance) and farther out (d0+25 up to
      // maxDistance, step 10). A lake a little closer beats no lake at all; only regions where
      // every minDistance..maxDistance placement touches the sea get here. ADR-423: distances
      // derive from the region's effective minDistance (84 -> 83, 78, 73, 68, 63 in region
      // zero; x3 outside it). ADR-534: the ocean sectors can cover the whole main-tier ring
      // (d0 +/- 20) on the free cardinals, so the fallback also tries ALL FOUR cardinals —
      // the lake/pond axes included, at other distances, kept clear of the lake/pond discs
      // by the clearance below (the main tier's `ordered` exclusion is a shortcut, not a
      // hard rule) — in scaled regions only; region zero keeps the free cardinals so its
      // layout stays byte-identical. The sea-free ground is usually on another cardinal or
      // farther out.
      const fallbackDists = [1, 6, 11, 16, 21].map((step) => opts.minDistance - step);
      for (let d = d0 + 25; d <= opts.maxDistance; d += 10) fallbackDists.push(d);
      const fallbackCardinals = scale > 1 ? [0, 1, 2, 3] : ordered;
      for (let order = 0; order < fallbackCardinals.length; order++) {
        const ci = fallbackCardinals[order]!; const [dx, dy] = cardinals[ci]!;
        for (const d of fallbackDists) {
          const cx = Math.round(dx * d) + 0.5, cy = Math.round(dy * d) + 0.5;
          const R = el.r + SITING_SEA_MARGIN;
          let ok = true, ringSum = 0, ringN = 0;
          for (let y = Math.floor(cy - R - 1); y <= Math.ceil(cy + R + 1) && ok; y++)
            for (let x = Math.floor(cx - R - 1); x <= Math.ceil(cx + R + 1); x++) {
              const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
              if (dist > R) continue;
              if (isSea(x, y)) { ok = false; break; }
              if (dist > el.r) { ringSum += baseHeight(x, y); ringN++; }
            }
          if (!ok) continue;
          // ADR-534: same great-lake clearance as the main tier (see above), plus the
          // lake/pond clearance (the fallback now tries their axes too).
          const gl2 = layout.greatLake;
          if (gl2 && Math.hypot(cx - gl2.x, cy - gl2.y) <= el.r + opts.rimWidth + gl2.r + 8) continue;
          if (Math.hypot(cx - layout.lake.x, cy - layout.lake.y) <= el.r + opts.rimWidth + layout.lake.r + 8) continue;
          if (Math.hypot(cx - layout.pond.x, cy - layout.pond.y) <= el.r + opts.rimWidth + layout.pond.r + 8) continue;
          const cand = { x: cx, y: cy, ringMean: ringN ? ringSum / ringN : 0, dOff: 0, order };
          if (!best || cand.ringMean > best.ringMean) best = cand;
        }
      }
    }
    if (!best) {
      layout.elevatedLake = undefined; return;
    } // skipped: no placement clear of the sea
    // The hash placement stands unless another direction is CLEARLY higher ground (by
    // SITING_HEIGHT_MARGIN) — a hair's difference is noise, not a reason to move the lake.
    if (hashScore !== undefined && best.ringMean < hashScore + SITING_HEIGHT_MARGIN) {
      const [dx, dy] = cardinals[hashCard]!;
      best = { x: Math.round(dx * d0) + 0.5, y: Math.round(dy * d0) + 0.5, ringMean: hashScore, dOff: 0, order: 0 };
    }
    layout.elevatedLake = { x: best.x, y: best.y, r: el.r, level: el.level };
    layout.spillway = this.spillwayFor(originX, originY, regionSeed, layout, scale);
  }

  /**
   * ADR-386: the spillway from a sited lake's rim down to lower water, or undefined when the lake is
   * closed (no spillway: nothing to connect to, so no waterfall). The spill target is the nearest
   * sea-level water (biome sea, or a forced lake/river/pond at level 0) within SPILLWAY_TARGET_RANGE
   * of the rim (x the region's feature scale — ADR-423: 64 in region zero, 192 in scaled regions).
   * The walk starts at the rim breach — the 4-neighbour of a disc tile with the lowest
   * base height — and aims at the target: each step keeps (or barely increases) the distance to it,
   * taking the lowest ground among those steps, until a tile adjacent to lower water. It gives up
   * when boxed in, when it would leave the region's own span, or past its step budget
   * (the Manhattan distance + slack, capped at SPILLWAY_MAX_LEN, likewise x the feature scale). A breach directly adjacent to
   * lower water is also closed: a 1-tile channel has no tiles[1], so no 2-level falls — just a
   * 3..6-level drop to the sea (fall damage going down, unclimbable back up). When the rim already touches
   * lower water (a river passing the lake), no channel is carved: the junction face itself is the
   * waterfall (see tilemap.ts).
   * Channel levels: breach at L-1, then the waterfall — one 2-level drop to L-3 — then 1 per tile
   * to a floor of 1, running flat to the sea. A 2-level drop is the steepest face that stays
   * climbable/swimmable both ways (MAX_UNAIDED_CLIMB is 3, and drops of <= 3 cost no fall damage),
   * so the waterfall connects the two water bodies instead of barring them.
   */
  private spillwayFor(originX: number, originY: number, regionSeed: number, layout: WaterFeatureLayout, scale: number): Spillway | undefined {
    const el = layout.elevatedLake; if (!el || !this.elevated) return undefined;
    const targetRange = SPILLWAY_TARGET_RANGE * scale, maxLen = SPILLWAY_MAX_LEN * scale;
    const r = el.r, L = el.level;
    const isLowWater = (lx: number, ly: number): boolean => {
      // ADR-424: an island is land, not a spill target — even where the biome under it is water —
      // and a great lake is sea-level water, so it counts like any other low water body.
      if (islandAt(layout, lx, ly)) return false;
      if (this.isBiomeSea(originX + lx, originY + ly)) return true;
      const k = waterFeatureAt(regionSeed, lx, ly, layout);
      return k === "lake" || k === "river" || k === "pond" || k === "greatLake";
    };
    const inDisc = (lx: number, ly: number): boolean => elevatedLakeDist(layout, lx, ly) <= r;
    const inWindow = (lx: number, ly: number): boolean => Math.abs(lx) <= SPILLWAY_WINDOW && Math.abs(ly) <= SPILLWAY_WINDOW;
    const baseHeight = (lx: number, ly: number): number =>
      this.heightFromNoise(originX + lx, originY + ly, this.noiseAt(originX + lx, originY + ly), null, null, undefined, false, false, false, null, false);
    const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    // Nearest lower water to the lake (the spill target): ring scan out from the rim so the closest
    // sea is found first. Pure steepest descent was tried first and stalled on the terrace plateaus
    // (only ~2% of lakes spilled); aiming at the sea reaches it in the overwhelming majority of cases.
    const cx = Math.floor(el.x), cy = Math.floor(el.y);
    let target: { x: number; y: number } | undefined;
    const maxRing = el.r + targetRange;
    outer: for (let ring = el.r + 1; ring <= maxRing; ring++) {
      for (let y = cy - ring; y <= cy + ring; y++) for (let x = cx - ring; x <= cx + ring; x++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== ring) continue;
        if (!inWindow(x, y) || inDisc(x, y)) continue;
        if (isLowWater(x, y)) { target = { x, y }; break outer; }
      }
    }
    if (!target) return undefined; // no lower water in range — closed lake
    // Rim breach: the rim tile closest to the spill target, and among the near ones the lowest —
    // the lake spills where the rim is low AND the sea is near, so the walk does not have to fight
    // its way around the disc to reach the water. (Lowest-height alone faced away from the sea in
    // most seeds and the walk boxed itself in against the disc.)
    let start: { x: number; y: number } | undefined; let startH = Infinity; let startD = Infinity;
    for (let y = cy - r - 1; y <= cy + r + 1; y++) for (let x = cx - r - 1; x <= cx + r + 1; x++) {
      if (inDisc(x, y)) continue;
      if (!N4.some(([dx, dy]) => inDisc(x + dx, y + dy))) continue;
      const d = Math.hypot(x + 0.5 - (target.x + 0.5), y + 0.5 - (target.y + 0.5));
      startD = Math.min(startD, d);
    }
    for (let y = cy - r - 1; y <= cy + r + 1; y++) for (let x = cx - r - 1; x <= cx + r + 1; x++) {
      if (inDisc(x, y)) continue;
      if (!N4.some(([dx, dy]) => inDisc(x + dx, y + dy))) continue;
      const d = Math.hypot(x + 0.5 - (target.x + 0.5), y + 0.5 - (target.y + 0.5));
      if (d > startD + 2) continue;
      const h = baseHeight(x, y);
      if (h < startH) { startH = h; start = { x, y }; }
    }
    if (!start) return undefined;
    if (isLowWater(start.x, start.y)) return undefined; // rim already meets lower water — junction face is the falls
    // Walk toward the target: each step keeps (or barely increases) the distance to it, and among
    // those steps takes the lowest ground — a stream that aims at the sea down the fall line, not a
    // straight ditch. The channel carves through hills (a gorge) where the fall line demands it.
    // Bounded by twice the Euclidean distance + slack, capped at SPILLWAY_MAX_LEN: the walk needs
    // detour room around the disc rim and the low ground, and Manhattan + 12 proved too tight for
    // mid-range targets (it regressed the spill rate vs 2x Euclidean + 8).
    const path: { x: number; y: number }[] = [start];
    const seen = new Set<string>([`${start.x},${start.y}`]);
    const distTo = (x: number, y: number): number => Math.hypot(x + 0.5 - (target!.x + 0.5), y + 0.5 - (target!.y + 0.5));
    const maxSteps = Math.min(maxLen, 2 * Math.ceil(distTo(start.x, start.y)) + 8);
    let cur = start;
    let end: { x: number; y: number } | undefined;
    for (let step = 0; step < maxSteps && !end; step++) {
      for (const [dx, dy] of N4) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (inDisc(nx, ny) || islandAt(layout, nx, ny) || seen.has(`${nx},${ny}`)) continue;
        if (isLowWater(nx, ny)) { end = { x: nx, y: ny }; break; }
      }
      if (end) break;
      const curD = distTo(cur.x, cur.y);
      let best: { x: number; y: number; h: number } | undefined;
      for (const [dx, dy] of N4) {
        const nx = cur.x + dx, ny = cur.y + dy;
        if (inDisc(nx, ny) || islandAt(layout, nx, ny) || seen.has(`${nx},${ny}`) || !inWindow(nx, ny)) continue;
        if (distTo(nx, ny) > curD + 0.5) continue; // never walk away from the sea
        const h = baseHeight(nx, ny);
        if (!best || h < best.h) best = { x: nx, y: ny, h };
      }
      if (!best) return undefined; // boxed in — closed lake
      path.push({ x: best.x, y: best.y }); seen.add(`${best.x},${best.y}`);
      cur = best;
    }
    if (!end) return undefined; // never reached lower water — closed lake
    // A breach directly adjacent to lower water leaves a 1-tile channel with no tiles[1] —
    // no 2-level falls, just a 3..6-level drop to the sea (fall damage + unclimbable back
    // up). Treat it as closed: the junction face is the falls.
    if (path.length < 2) return undefined;
    const tiles = path.map((p, i) => ({ ...p, level: Math.max(1, i === 0 ? L - 1 : L - 2 - i) }));
    const xs = tiles.map((t) => t.x), ys = tiles.map((t) => t.y);
    return { tiles, end, bbox: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } };
  }

  /** ADR-386: spillway channel level at (tx, ty), or undefined. */
  private spillwayAt(tx: number, ty: number): number | undefined {
    if (!this.elevated || !this.water) return undefined;
    const reg = this.layoutFor(tx, ty); if (!reg) return undefined;
    return spillLevelAt(reg.layout, reg.lx, reg.ly);
  }
  /** ADR-386: the elevated-lake hold and spillway level at (tx, ty) from ONE layout lookup (load()
   *  and sampleAt() call this per tile; separate elevatedLakeAt/spillwayAt calls would triple it).
   *  ADR-424: also the ADR-424 island disc holding the tile (undefined = not on an island).
   *  ADR-533: also the painted network tile (channel / sink water / delta sand / sink mud). */
  private lakeAndSpill(tx: number, ty: number): { el: { level: number; r: number; dist: number } | undefined; sp: number | undefined; isl: { x: number; y: number; r: number; dist: number } | undefined; net: NetTileInfo | undefined } {
    if (!this.water) return { el: undefined, sp: undefined, isl: undefined, net: undefined };
    const reg = this.layoutFor(tx, ty); if (!reg) return { el: undefined, sp: undefined, isl: undefined, net: undefined };
    const sp = spillLevelAt(reg.layout, reg.lx, reg.ly);
    const isl = islandAt(reg.layout, reg.lx, reg.ly);
    const net = this.riverNetAt(tx, ty);
    if (!this.elevated) return { el: undefined, sp, isl, net };
    const held = reg.layout.elevatedLake;
    if (!held) return { el: undefined, sp, isl, net };
    const dist = Math.hypot(reg.lx + 0.5 - held.x, reg.ly + 0.5 - held.y);
    if (dist > held.r + this.elevated.rimWidth) return { el: undefined, sp, isl, net };
    return { el: { level: held.level, r: held.r, dist }, sp, isl, net };
  }
  /** ADR-424: the island disc holding (tx, ty), or undefined. Region zero has no great lake, so
   *  this is always undefined there — the starter layout stays byte-identical. */
  private islandAt(tx: number, ty: number): { x: number; y: number; r: number; dist: number } | undefined {
    if (!this.water) return undefined;
    const reg = this.layoutFor(tx, ty); if (!reg) return undefined;
    return islandAt(reg.layout, reg.lx, reg.ly);
  }
  /**
   * ADR-383: the elevated lake holding (tx, ty) — its surface level, radius and distance from its centre —
   * or undefined. The disc + rim never reach the feature window edge (region zero max extent
   * 104+10+4 = 118 < 120; scaled regions 312+30+12 = 354 < 360), so
   * a tile inside them always has a layout; tiles outside any disc+rim return undefined without a lookup.
   */
  private elevatedLakeAt(tx: number, ty: number): { level: number; r: number; dist: number } | undefined {
    if (!this.elevated || !this.water) return undefined;
    const reg = this.layoutFor(tx, ty); if (!reg) return undefined;
    const el = reg.layout.elevatedLake;
    if (!el) return undefined; // ADR-386: siting skipped this region's lake
    const dist = Math.hypot(reg.lx + 0.5 - el.x, reg.ly + 0.5 - el.y);
    if (dist > el.r + this.elevated.rimWidth) return undefined;
    return { level: el.level, r: el.r, dist };
  }
  /** True when the final tile at (tx,ty) is water (biome or ADR-255 feature), without building cover.
   *  ADR-424: an island tile is land, never water — even where the biome noise under it is water.
   *  ADR-534: the biome sea here is the widened sea (ocean sectors included). */
  private biomeOrForcedWater(tx: number, ty: number): boolean {
    if (this.islandAt(tx, ty)) return false;
    return this.forcedWater(tx, ty) || this.isBiomeSea(tx, ty);
  }
  private noiseAt(tx: number, ty: number): number {
    const seed = this.opts.seed >>> 0;
    return 0.65 * valueNoise(seed, tx, ty, 48) + 0.35 * valueNoise(seed ^ 0xabc, tx, ty, 12);
  }
  /** ADR-534: the ocean-sector field at (tx, ty) — coarse valueNoise in absolute coords, so a
   *  sector is one continuous shape across region boundaries. Two octaves (512 + 128): the
   *  512 octave sets the sector's broad shape, the 128 octave wiggles its coast. */
  private oceanFieldAt(tx: number, ty: number): number {
    const seed = this.opts.seed >>> 0;
    return 0.7 * valueNoise(seed ^ OCEAN_SALT, tx, ty, OCEAN_SCALE)
      + 0.3 * valueNoise(seed ^ OCEAN_SALT ^ 0x77, tx, ty, 128);
  }
  /** ADR-534: true when (tx, ty) lies in a designated ocean sector. Outside region zero only
   *  (Chebyshev > REGION_HALF) — region zero stays byte-identical. Public for the ADR-534
   *  survey tests, which count ocean water per region. */
  oceanSectorAt(tx: number, ty: number): boolean {
    if (Math.max(Math.abs(tx), Math.abs(ty)) <= REGION_HALF) return false;
    return this.oceanFieldAt(tx, ty) > OCEAN_FIELD_THRESHOLD;
  }
  /** ADR-534: the sea threshold at (tx, ty) — the water band's max normally, OCEAN_SEA_MAX
   *  (1.0: pure water) inside an ocean sector. */
  private seaThresholdAt(tx: number, ty: number): number {
    return this.oceanSectorAt(tx, ty) ? OCEAN_SEA_MAX : this.seaMax;
  }
  /** ADR-534: true when the biome noise at (tx, ty) is sea — the widened sea in ocean sectors,
   *  the normal water band elsewhere. Every sea check in the generator (massif / canyon /
   *  elevated-lake siting, river mouths, shore logic) reads this, never the raw band. */
  private isBiomeSea(tx: number, ty: number): boolean {
    return this.noiseAt(tx, ty) < this.seaThresholdAt(tx, ty);
  }
  /** ADR-534: the band at (tx, ty) for biome noise n — the water band when n is sea (widened
   *  in ocean sectors), else the normal band. Tile classification reads this, never bandOf. */
  private bandAt(tx: number, ty: number, n: number): NonNullable<ProceduralOptions["bands"]>[number] {
    return n < this.seaThresholdAt(tx, ty) ? this.waterBand : this.bandOf(n);
  }
  /**
   * ADR-254: continuous height in [heightMin, heightMax]. Biome noise keeps shores low and peaks high; an independent
   * multi-octave field adds hills and ridges; a terrace field snaps some areas into plateaus so neighbouring tiles
   * form clear ledges (drops of 2+ levels) that the cliff / gt_side passes can draw.
   * ADR-530: the range is [-100, 100]. The old field (plateau x relief 2..8, clamped >= 0) never went below 0,
   * and its terraces are 6..10-level faces at full relief — closed walls no walker can cross. Past the spawn
   * disc the terraces fade out (160 -> 288) and a smooth signed field fades in (160 -> 416), so the wilderness
   * is big rolling relief instead of walled plateaus: the BFS from spawn reaches >= 99% of land, and the flat
   * budget holds. At distance <= 160 both fades are 0, so the inner zone is byte-identical gentle ground
   * (and region zero's elevated-lake siting / spillway walk, which read the base field within ~180 tiles,
   * are unchanged — the starter layout stays byte-identical). The new field is valueNoise at 3 scales
   * reusing the HEIGHT_SALT family; generation-time only, nothing per tick or per frame.
   */
  heightAt(tx: number, ty: number): number { return this.heightFromNoise(tx, ty, this.noiseAt(tx, ty)); }
  private heightFromNoise(tx: number, ty: number, biome: number,
    /** ADR-383: precomputed elevated-lake hold for this tile (undefined = look it up; null = none). */
    el: { level: number; r: number; dist: number } | null | undefined = undefined,
    /** ADR-386: spillway level for this tile (undefined = look it up; null = known absent — the
     *  caller already checked, so the lookup is skipped; a number is the channel level itself). */
    spLevel: number | null | undefined = undefined,
    /** ADR-424: precomputed island disc for this tile (undefined = look it up; null = none). */
    isl: { x: number; y: number; r: number; dist: number } | null | undefined = undefined,
    /** ADR-531: false = the base field without massifs (elevated-lake siting / spillway probes
     *  and massif siting itself — those must read exactly the ADR-530 field, so the starter
     *  layout stays byte-identical and siting never depends on call order). */
    includeMassifs = true,
    /** ADR-530 fix-up: false = the base field without benches (bench levels themselves, massif
     *  siting, and the elevated-lake siting / spillway probes — all must read the bench-free
     *  field, so siting never depends on benches and bench levels never depend on themselves). */
    includeBenches = true,
    /** ADR-532: false = the base field without canyons (massif/bench/elevated-lake siting
     *  and canyon siting itself — a canyon never sits on its own carve, and siting never
     *  depends on call order). */
    includeCanyons = true,
    /** ADR-533: precomputed network tile for this tile (undefined = look it up; null = none). */
    net: NetTileInfo | null | undefined = undefined,
    /** ADR-533: false = the base field without networks (every siting probe — a stream never
     *  sits on its own carve, and siting never triggers (or depends on) a network). */
    includeRivers = true): number {
    const seed = this.opts.seed >>> 0; const H = this.opts.heightMax ?? HEIGHT_MAX; const L = this.opts.heightMin ?? HEIGHT_MIN;
    const field = 0.55 * valueNoise(seed ^ HEIGHT_SALT, tx, ty, 48)
      + 0.30 * valueNoise(seed ^ HEIGHT_SALT ^ 0x111, tx, ty, 18)
      + 0.15 * valueNoise(seed ^ HEIGHT_SALT ^ 0x222, tx, ty, 8);
    // Plateau bands (0..3), scaled below: gentle starter hills grow into eight-level wilderness cliffs.
    // Detail + a little biome keep rolling variation on top of each plateau so the ground is not a flat shelf.
    const plateau = Math.floor(valueNoise(seed ^ TERRACE_SALT, tx, ty, 28) * 4); // 0..3
    const detail = Math.floor(field * 2) + Math.floor(biome * 2); // 0..2
    // Gentle starter hills (all adjacent faces <=3); grow the relief over a wide transition,
    // not a ring-shaped cliff. Beyond it, eight-level terraces make real cliffs and deep valleys.
    // ADR-411: relief tops out at 8, so plateau 3 x 8 + detail 2 = 26 was actually reached.
    // ADR-423: the 160/224 transition stays — it is distance-from-spawn, not region size, so heights
    // at old coordinates are unchanged within the spawn disc.
    const distance = Math.max(Math.abs(tx), Math.abs(ty));
    const blend = Math.max(0, Math.min(1, (distance - 160) / 224)), relief = 2 + 6 * blend;
    const gentleDetail = Math.floor(field + biome);
    const localDetail = Math.floor(gentleDetail + (detail - gentleDetail) * blend);
    const base = Math.floor(plateau * relief) + localDetail; // 0..26, the ADR-411 field
    // ADR-530: terrace fade 160 -> 288 (plateau faces shrink to nothing) and signed-relief fade
    // 160 -> 416 (the smooth field grows to the full [L, H] range). The smooth field is the same
    // multi-octave field without terraces; the signed field is valueNoise at 2 wide scales, centred
    // on (H+L)/2 and amplified x1.3. The amplification matters: a weighted sum dilutes each octave's
    // extremes (at the 128-scale maximum the 48-scale octave sits near its mean), so a bare sum
    // tops out near +/-80 on some seeds; x1.3 puts the caps inside the sum's reach on all 5 survey
    // seeds. The 128-scale octave carries the broad shape (few cells, gentle gradients); the
    // 48-scale octave adds texture without steepening the field past walkable steps.
    const terraceFade = Math.max(0, Math.min(1, (distance - 160) / 128));
    const smooth = Math.floor(field * 26); // terrace-free 0..26 from the same multi-octave field
    const mid = Math.floor(base * (1 - terraceFade) + smooth * terraceFade);
    const reliefFade = Math.max(0, Math.min(1, (distance - 160) / 256));
    const outerField = 0.70 * valueNoise(seed ^ HEIGHT_SALT ^ 0x333, tx, ty, 128)
      + 0.30 * valueNoise(seed ^ HEIGHT_SALT ^ 0x444, tx, ty, 48);
    const outer = Math.max(L, Math.min(H, Math.floor((outerField - 0.5) * (H - L) * 1.3 + (H + L) / 2)));
    let natural = Math.max(L, Math.min(H, Math.floor(mid * (1 - reliefFade) + outer * reliefFade)));
    // ADR-531: massif bumps ride on the natural field (additive, so a disc edge meets the
    // surrounding ground with no seam; the bump itself falls to 0 at its own edge). Clamped
    // to [L, H] with the field. Skipped for base-field probes (includeMassifs false).
    const bump = includeMassifs ? this.massifBump(tx, ty) : 0;
    if (bump !== 0) natural = Math.max(L, Math.min(H, natural + bump));
    // ADR-530 fix-up: flat benches pin their core to the local mean level and grade back to the
    // natural field at <=1 level per tile of distance. Only where the massif bump is 0, so
    // massif discs read exactly as ADR-531 left them, and never within 10 tiles of a massif
    // disc — the ADR-531 slope path starts outside the disc, and a bench skirt on the approach
    // can wall the entry off with a >1 step. Skipped for base-field probes.
    if (includeBenches && bump === 0 && !this.nearMassif(tx, ty)) natural = this.benchHeight(tx, ty, natural);
    // ADR-532: canyon carve — after the base field (massifs + benches), before water features
    // resolve. carved = min(pre-canyon height, profile): the wall meets the local ground
    // wherever it reaches it, and min() never steepens a step past the worse of the natural
    // field and the profile. Never inside a massif disc or within 10 tiles of one (the same
    // suppression as the bench fix-up — siting already keeps the footprint clear, so this
    // only ever fires on the footprint's far edge, where the profile is already above the
    // ground and min() would return the natural height anyway). Spillway / island /
    // elevated-bowl overrides below still win (water beats canyon where a river runs in it).
    if (includeCanyons) {
      const p = this.canyonProfileAt(tx, ty);
      if (p && this.massifBump(tx, ty) === 0 && !this.nearMassif(tx, ty)) natural = Math.min(natural, p.profile);
    }
    // ADR-386: a spillway channel overrides the bowl (the rim breach cuts the beach shelf) and the
    // natural field alike — the channel is carved water at its own descending levels. The base-field
    // probe (el === null, spLevel === null) never sees it: the spillway is computed from the base
    // field, not part of it.
    if (spLevel === undefined) {
      const sp = this.spillwayAt(tx, ty);
      if (sp !== undefined) return sp;
    } else if (spLevel !== null) return spLevel;
    // ADR-533: a network channel overrides the natural field (and the canyon carve above —
    // water beats canyon where a river runs in it) with its own descending levels; a sink pond
    // holds its level; a delta fan sits at 1. Sink mud keeps the natural height (the tile
    // override lives in tileFromNoise). The base-field probe (net === null) never sees it.
    const netHeld = net === undefined ? (includeRivers ? this.riverNetAt(tx, ty) : undefined) : net;
    if (netHeld) {
      if (netHeld.kind === "channel" || netHeld.kind === "sinkWater") return netHeld.level;
      if (netHeld.kind === "delta") return 1;
    }
    // ADR-424: island ground. The outer ring is a beach at height 1, the interior grass at
    // height 2 — above the lake's water level 0, and climbable from the water in one step
    // (MAX_UNAIDED_CLIMB is 3), so a boater who beaches can step straight onto the island.
    // A spillway channel above carves through instead (the walk avoids islands, so this is
    // belt-and-braces); the elevated bowl below cannot overlap an island (other cardinal).
    const islHeld = isl === undefined ? this.islandAt(tx, ty) : isl;
    if (islHeld) return islHeld.dist > islHeld.r - 1 ? 1 : 2;
    // ADR-383: elevated lake bowl. Inside the disc the bed sits at the water surface level (the stored height
    // is the ADR-263/297 flow encoding of it — see load()/sampleAt — so heightAt reports the surface level,
    // matching terrainLevel of the loaded chunk). Around it a 1-tile beach shelf clamped to [level+1, level+3]:
    // the water never sits above its shore, and a swimmer can always climb out (MAX_UNAIDED_CLIMB is 3, and
    // descents are free). Beyond the shelf the rim only ever raises ground to level+1, so natural hills resume.
    const held = el === undefined ? this.elevatedLakeAt(tx, ty) : el;
    if (held) {
      if (held.dist <= held.r) return held.level;
      if (held.dist <= held.r + 1) return Math.max(held.level + 1, Math.min(natural, held.level + 3));
      return Math.max(natural, held.level + 1);
    }
    return natural;
  }
  /** Generated tile id at (tx,ty) (pure; no chunk load; same as load()). ADR-255: forced lake/river/pond override biome. */
  tileAt(tx: number, ty: number): number {
    const n = this.noiseAt(tx, ty); return this.tileFromNoise(tx, ty, n, this.bandAt(tx, ty, n));
  }
  /** Survey a tile and its height together without constructing a chunk, sharing the biome noise work.
   *  The height is the stored height: elevated-lake water stores the ADR-263/297 flow encoding of its
   *  surface level, exactly as load() stores it, so preview thumbnails agree with loaded chunks. */
  sampleAt(tx: number, ty: number): { tile: number; height: number } {
    const n = this.noiseAt(tx, ty);
    const { el, sp, isl, net } = this.lakeAndSpill(tx, ty);
    // ADR-386: one layout lookup per tile (lakeAndSpill); the hold / spill level are threaded into
    // heightFromNoise as already-known (el ?? null, null) so it does not look them up again.
    // ADR-424: the island disc likewise (isl ?? null).
    // ADR-531: the terrain height (massifs included) is threaded into the tile bands, so the
    // rock/snow bands agree with the stored height exactly as load() stores it.
    // ADR-533: the network tile likewise (net ?? null) — channel/sink levels and delta sand.
    const terrainH = this.heightFromNoise(tx, ty, n, el ?? null, null, isl ?? null, true, true, true, net ?? null, true);
    const height = sp !== undefined ? flowWaterRaw(sp) : net && (net.kind === "channel" || net.kind === "sinkWater") ? flowWaterRaw(net.level) : el && el.dist <= el.r ? flowWaterRaw(el.level) : terrainH;
    const tile = this.tileFromNoise(tx, ty, n, this.bandAt(tx, ty, n), terrainH, true, net ?? null);
    return { tile, height };
  }
  private tileFromNoise(tx: number, ty: number, n: number, band: NonNullable<ProceduralOptions["bands"]>[number],
    /** ADR-531: already-known terrain height (undefined = compute lazily for land bands). */
    height?: number,
    /** ADR-531: false = skip the altitude bands (nodesInChunk only needs water vs land, and the
     *  treeline check computes the banded tile lazily — see bandedTile). */
    altitudeBands = true,
    /** ADR-533: precomputed network tile (undefined = look it up; null = none). */
    net?: NetTileInfo | null): number {
    // ADR-424: island ground overrides everything — the island disc is land inside the great lake
    // even where the biome noise underneath is water. Outer ring sand (beach), interior grass.
    // The biome band still drives node placement in load(), so islands can grow trees like any grass.
    const isl = this.islandAt(tx, ty);
    if (isl) return isl.dist > isl.r - 1 ? 2 : 3;
    // ADR-533: network tiles — channel/sink water, delta sand, sink mud — override the biome
    // band (a channel is water even where the noise says grass; a delta is a sand fan in a lake).
    const netHeld = net === undefined ? this.riverNetAt(tx, ty) : net;
    if (netHeld) {
      if (netHeld.kind === "channel" || netHeld.kind === "sinkWater") return 1;
      if (netHeld.kind === "delta") return 2;
      if (netHeld.kind === "sinkMud") {
        // ADR-534: mud is a lowland feature — at/above the rock line the altitude band wins
        // (a sink's mud ring climbing a massif flank reads as rock/snow, not mud, so the
        // ADR-531 band test passes there). Otherwise the tile is mud as ADR-533 intends.
        // Falls through to surface() below when high, which applies the rock/snow band.
        let mud = true;
        if (altitudeBands && band.tile !== 1) {
          const hh = height ?? this.heightFromNoise(tx, ty, n);
          if (hh >= MASSIF_ROCK_LINE) mud = false;
        }
        if (mud) return 9;
      }
    }
    if (this.forcedWater(tx, ty)) {
      return this.surface(tx, ty, 0, this.waterBand, true);
    }
    // ADR-531: altitude bands need the tile height; land bands compute it lazily (the water band
    // never bands, so tileAt stays cheap on water).
    const h = altitudeBands && band.tile !== 1 ? (height ?? this.heightFromNoise(tx, ty, n)) : undefined;
    // ADR-532: a canyon-carved tile below sea level holds water (a river channel at the floor,
    // surface 0 — the same natural-water encoding as biome sea), never dry land below sea
    // level. Floor tiles (d <= floorHalf) are water whenever their height is below 0; wall
    // tiles are water only where the canyon profile itself is below 0 (a submerged bank) —
    // a natural dip below 0 beside a dry wall keeps the pre-existing dry-below-0 behaviour,
    // which is out of this slice's scope. The profile lookup is bbox-gated, so tiles nowhere
    // near a canyon pay one map lookup, not a height computation; the height is only computed
    // when a canyon profile actually covers the tile (nodesInChunk passes altitudeBands=false,
    // so h is undefined there and this is the only height it pays).
    if (band.tile !== 1) {
      const prof = this.canyonProfileAt(tx, ty);
      if (prof) {
        const hh = h ?? this.heightFromNoise(tx, ty, n);
        if (hh < 0 && (prof.d <= prof.floorHalf || prof.profile < 0)) return 1;
      }
    }
    return this.surface(tx, ty, n, band, false, h, this.seaThresholdAt(tx, ty));
  }
  /** Final ground tile: band tile, then ADR-246 mud, then ADR-249 cover. `forced` = ADR-255 water feature. */
  private surface(tx: number, ty: number, n: number, band: NonNullable<ProceduralOptions["bands"]>[number], forced = false,
    /** ADR-531: terrain height for the altitude bands (undefined = no banding). */
    height?: number,
    /** ADR-534: the effective sea threshold at this tile (1.0 in an ocean sector) — the shallow
     *  band is measured below the SEA threshold, not the water band's max, or the whole ocean
     *  would read as shallow (every ocean tile has n >= 0.3 - 0.03). */
    seaMax?: number): number {
    const t = forced ? 1 : this.mudOr(tx, ty, n, band);
    // ADR-531 altitude bands, independent of the cover knob: rock above MASSIF_ROCK_LINE, snow
    // above MASSIF_SNOW_LINE where the lapse-adjusted band temperature is cold enough (the
    // COVER_DEFAULTS snow rule + band temp — at 70+ levels the 0.6 °C/level lapse puts every band
    // under the snow temperature). Water (1) never bands. No new art: existing rock (5) / snow (6).
    if (!forced && height !== undefined && t !== 1) {
      if (height >= MASSIF_SNOW_LINE && (band.temp ?? 15) - 0.6 * height <= COVER_DEFAULTS.snowTemp) return 6;
      if (height >= MASSIF_ROCK_LINE) return 5;
    }
    const c = this.opts.cover; if (c === false || (!forced && t !== band.tile)) return t;
    const o = { ...COVER_DEFAULTS, ...(c ?? {}) }; const bi = this.bands.indexOf(band); const lo = bi > 0 ? this.bands[bi - 1]!.max : 0;
    if (t === 1) { // shallows: shore end of the water band, or any water tile touching land (biome or non-feature)
      const up = this.bands[bi + 1];
      if (!forced && (!up || up.tile === 1)) return t;
      if (!forced && n >= (seaMax ?? band.max) - o.shallowBand) return 8;
      for (const [dx, dy] of NEIGH4) if (!this.biomeOrForcedWater(tx + dx, ty + dy)) return 8;
      return t;
    }
    if (t === 4) {
      if (n - lo < o.forestMargin || band.max - n < o.forestMargin) return t;
      return valueNoise(((this.opts.seed >>> 0) ^ CANOPY_SALT) >>> 0, tx, ty, o.canopyScale) > o.canopy ? 7 : t;
    }
    if (t === 5 && n >= o.snowLine) return this.baseClimate(tx, ty).temperature <= o.snowTemp ? 6 : t;
    return t;
  }
  private bandOf(n: number): NonNullable<ProceduralOptions["bands"]>[number] { return this.bands.find((b) => n < b.max) ?? this.bands[this.bands.length - 1]!; }
  /** ADR-246: grass / dirt (3, 4) tiles within `band` noise of a shore (sand, 2) band below turn to mud where wet. */
  private mudOr(tx: number, ty: number, n: number, band: NonNullable<ProceduralOptions["bands"]>[number]): number {
    const m = this.opts.mud; if (m === false || (band.tile !== 3 && band.tile !== 4)) return band.tile;
    const bi = this.bands.indexOf(band); const below = this.bands[bi - 1]; if (!below || below.tile !== 2) return band.tile;
    const o = { ...MUD_DEFAULTS, ...(m ?? {}) }; if (n - below.max >= o.band) return band.tile;
    const wet = valueNoise(((this.opts.seed >>> 0) ^ MUD_SALT) >>> 0, tx, ty, o.scale) * 0.85 + hash2((this.opts.seed >>> 0) ^ MUD_SALT, tx, ty) * 0.15;
    return wet > o.moisture ? o.tile : band.tile;
  }
  /** Deterministic base climate for a tile (no chunk needs to be loaded). Altitude matches generated tile height. */
  baseClimate(tx: number, ty: number): BaseClimate {
    const n = this.noiseAt(tx, ty); const band = this.bandAt(tx, ty, n);
    const amp = this.opts.climateAmplitude ?? 8, scale = this.opts.climateScale ?? 512;
    // ADR-423: climateScale stays 512 — it is a temperature wavelength, not a map-size parameter;
    // changing it would alter temperatures at old coordinates.
    const large = (valueNoise((this.opts.seed ^ 0x5151) >>> 0, tx, ty, scale) - 0.5) * 2 * amp;
    return { temperature: (band.temp ?? 15) + large, humidity: band.humidity ?? 0.5, altitude: this.heightAt(tx, ty) };
  }
  /** Mean base climate of a chunk (sampled on a 4x4 grid). */
  chunkClimate(cx: number, cy: number): BaseClimate {
    let t = 0, h = 0, a = 0; const S = CHUNK_SIZE / 4;
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) { const b = this.baseClimate(cx * CHUNK_SIZE + i * S + S / 2, cy * CHUNK_SIZE + j * S + S / 2); t += b.temperature; h += b.humidity; a += b.altitude; }
    return { temperature: t / 16, humidity: h / 16, altitude: a / 16 };
  }
  load(cx: number, cy: number): GeneratedChunk {
    const c = new Chunk(cx, cy); const nodes: NodePlacement[] = []; const seed = this.opts.seed >>> 0;
    const rng = new Rng(fnv1a(`${cx},${cy}`, seed));
    // ADR-500: the cache stream is separate (salted `cache:`) and only advances on water tiles, so the land-node
    // distribution is byte-identical with the pass on or off (adr500 asserts the hash).
    const cacheRng = this.opts.sunkenCacheKind !== undefined ? new Rng(fnv1a(`cache:${cx},${cy}`, seed)) : undefined;
    const cacheChance = this.opts.sunkenCacheChance ?? SUNKEN_CACHE_CHANCE_DEFAULT;
    // ADR-533: the reed stream is separate (salted `reed:`) and only advances on sink-mud tiles, so the
    // land-node distribution is byte-identical with the pass on or off (same pattern as the cache stream).
    const reedRng = this.opts.sinkReedKind !== undefined ? new Rng(fnv1a(`reed:${cx},${cy}`, seed)) : undefined;
    const reedChance = this.opts.sinkReedChance ?? SINK_REED_CHANCE_DEFAULT;
    const occupied = new Set<number>();
    for (let ly = 0; ly < CHUNK_SIZE; ly++) for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const tx = cx * CHUNK_SIZE + lx, ty = cy * CHUNK_SIZE + ly;
      const n = this.noiseAt(tx, ty);
      const band = this.bandAt(tx, ty, n);
      const i = ly * CHUNK_SIZE + lx; const { el, sp, isl, net } = this.lakeAndSpill(tx, ty);
      // ADR-383: elevated-lake water stores the ADR-263/297 flow encoding of its surface level, so the
      // renderer (renderTileHeight), terrainLevel and waterSurfaceAt all read the lake surface, not the
      // flat ADR-182 level. Every other tile stores its heightFromNoise level (bowl included) as before.
      // ADR-386: spillway channel water stores the flow encoding of its own descending level likewise.
      // One layout lookup per tile (lakeAndSpill); the hold / spill level are threaded into
      // heightFromNoise as already-known (el ?? null, null) so it does not look them up again.
      // ADR-424: the island disc likewise (isl ?? null) — island tiles store beach 1 / grass 2.
      // ADR-531: the terrain height is computed once and threaded into the tile bands, so the
      // rock/snow bands agree with the stored height. (Flow water stores its own level instead.)
      // ADR-533: the network tile likewise (net ?? null) — channel/sink water stores the flow
      // encoding of its descending level, delta sand stores 1.
      const terrainH = this.heightFromNoise(tx, ty, n, el ?? null, null, isl ?? null, true, true, true, net ?? null, true);
      c.height[i] = sp !== undefined ? flowWaterRaw(sp) : net && (net.kind === "channel" || net.kind === "sinkWater") ? flowWaterRaw(net.level) : el && el.dist <= el.r ? flowWaterRaw(el.level) : terrainH;
      const tile = this.tileFromNoise(tx, ty, n, band, terrainH, true, net ?? null); c.tiles[i] = tile;
      // No land resources on water (forced features or biome). Band chance still uses biome band kinds.
      if (tile !== 1 && tile !== 8 && band.nodeKinds?.length && rng.next() < (band.nodeChance ?? 0)) {
        const kind = rng.pick(band.nodeKinds);
        // ADR-531 treeline: kind 5 is `tree` in DEFAULT_BANDS — no trees on rock/snow ground.
        // The tile here is already the altitude-banded tile, so this is the same pure check
        // nodesInChunk makes with its lazily banded tile (ADR-343 lockstep).
        if (kind !== TREE_KIND || (tile !== 5 && tile !== 6)) { nodes.push({ tx, ty, kind }); occupied.add(i); }
      }
      this.trySunkenCache(cacheRng, cacheChance, tx, ty, tile, i, nodes, occupied);
      this.trySinkReed(reedRng, reedChance, tx, ty, net?.kind === "sinkMud", i, nodes, occupied);
    }
    if (this.opts.guaranteeNodes !== false) this.placeGuaranteedNodes(cx, cy, nodes, occupied);
    c.dirty = false; return { chunk: c, nodes };
  }

  /**
   * ADR-500: one tile's sunken-cache roll, called from the tile loops of load() and nodesInChunk() (the two must
   * stay in lockstep — ADR-343). Tile 1 only (tile 8 is shallow by definition); the roll happens on every water
   * tile in tile order, so the stream is deterministic; the depth check runs only on a hit (rare). Deep = no land
   * within Chebyshev radius 2 (waterDepthAt, the same rule gameplay uses) — a cache is a find in open water, not
   * on a shore. The kind is NOT in any band, so the ADR-255 guarantee pass never places it on land.
   */
  private trySunkenCache(rng: Rng | undefined, chance: number, tx: number, ty: number, tile: number, i: number, nodes: NodePlacement[], occupied: Set<number>): void {
    if (!rng || tile !== WATER_TILE) return;
    if (rng.next() >= chance) return;
    if (waterDepthAt((x, y) => this.tileAt(x, y), tx, ty) !== WaterDepth.Deep) return;
    if (occupied.has(i)) return;
    nodes.push({ tx, ty, kind: this.opts.sunkenCacheKind! }); occupied.add(i);
  }

  /**
   * ADR-533: one tile's sink-reed roll, called from the tile loops of load() and nodesInChunk() (the two must
   * stay in lockstep — ADR-343). The roll happens only on sink-mud tiles (the marsh ring of a boxed-in
   * stream's sink pond), in tile order, so the stream is deterministic; the chance check runs only
   * there. A reed bed on the marsh fringe is the sink's harvestable half (mud tile + reeds).
   */
  private trySinkReed(rng: Rng | undefined, chance: number, tx: number, ty: number, isSinkMud: boolean, i: number, nodes: NodePlacement[], occupied: Set<number>): void {
    if (!rng || !isSinkMud) return;
    if (rng.next() >= chance) return;
    if (occupied.has(i)) return;
    nodes.push({ tx, ty, kind: this.opts.sinkReedKind! }); occupied.add(i);
  }

  /** ADR-531: the altitude-banded tile at (tx, ty) (rock/snow above the treeline), for the
   *  treeline check in nodesInChunk — load() already holds this tile, so it checks it directly. */
  private bandedTile(tx: number, ty: number, n: number, band: NonNullable<ProceduralOptions["bands"]>[number]): number {
    return this.tileFromNoise(tx, ty, n, band, this.heightFromNoise(tx, ty, n));
  }

  /**
   * ADR-343: node placements of a chunk only (no tiles / heights): the same tile loop as load(), with the same rng
   * draws in the same order, so the placements agree exactly with what the server spawns for the chunk — prospecting
   * reads the world without building it (a load() is ~0.75 ms/chunk; this skips the height field and tile storage).
   * The guarantee pass runs identically (placeGuaranteedNodes shares its lazy `guaranteed` list with load()).
   */
  nodesInChunk(cx: number, cy: number): NodePlacement[] {
    const nodes: NodePlacement[] = []; const seed = this.opts.seed >>> 0;
    const rng = new Rng(fnv1a(`${cx},${cy}`, seed));
    // ADR-500: same separate cache stream as load() (see above) — the two loops must agree exactly.
    const cacheRng = this.opts.sunkenCacheKind !== undefined ? new Rng(fnv1a(`cache:${cx},${cy}`, seed)) : undefined;
    const cacheChance = this.opts.sunkenCacheChance ?? SUNKEN_CACHE_CHANCE_DEFAULT;
    // ADR-533: same separate reed stream as load() — the two loops must agree exactly.
    const reedRng = this.opts.sinkReedKind !== undefined ? new Rng(fnv1a(`reed:${cx},${cy}`, seed)) : undefined;
    const reedChance = this.opts.sinkReedChance ?? SINK_REED_CHANCE_DEFAULT;
    const occupied = new Set<number>();
    for (let ly = 0; ly < CHUNK_SIZE; ly++) for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const tx = cx * CHUNK_SIZE + lx, ty = cy * CHUNK_SIZE + ly;
      const n = this.noiseAt(tx, ty);
      const band = this.bandAt(tx, ty, n);
      const i = ly * CHUNK_SIZE + lx; const tile = this.tileFromNoise(tx, ty, n, band, undefined, false);
      // No land resources on water (forced features or biome). Band chance still uses biome band kinds.
      // ADR-531: the tile here is unbanded (only water vs land matters for the roll); the treeline
      // check below computes the banded tile lazily, only when a tree is rolled — same pure check
      // as load(), so the two loops stay in lockstep (ADR-343).
      if (tile !== 1 && tile !== 8 && band.nodeKinds?.length && rng.next() < (band.nodeChance ?? 0)) {
        const kind = rng.pick(band.nodeKinds);
        let blocked = false;
        if (kind === TREE_KIND) { const bt = this.bandedTile(tx, ty, n, band); blocked = bt === 5 || bt === 6; }
        if (!blocked) { nodes.push({ tx, ty, kind }); occupied.add(i); }
      }
      this.trySunkenCache(cacheRng, cacheChance, tx, ty, tile, i, nodes, occupied);
      this.trySinkReed(reedRng, reedChance, tx, ty, tile === 9 && this.riverNetAt(tx, ty)?.kind === "sinkMud", i, nodes, occupied);
    }
    if (this.opts.guaranteeNodes !== false) this.placeGuaranteedNodes(cx, cy, nodes, occupied);
    return nodes;
  }

  /**
   * ADR-255: every node kind listed in any band is placed at least once inside NODE_GUARANTEE_RADIUS.
   * Slot = unique angle around the origin; we walk outward until the tile's biome matches a band that lists the kind
   * (or any non-water land as a last resort). Pure function of (seed, kind) so every peer agrees.
   */
  private placeGuaranteedNodes(cx: number, cy: number, nodes: NodePlacement[], occupied: Set<number>): void {
    if (!this.allKinds.length) return;
    const seed = this.opts.seed >>> 0; const N = this.allKinds.length;
    const x0 = cx * CHUNK_SIZE, y0 = cy * CHUNK_SIZE, x1 = x0 + CHUNK_SIZE, y1 = y0 + CHUNK_SIZE;
    if (x1 <= -NODE_GUARANTEE_RADIUS || x0 >= NODE_GUARANTEE_RADIUS || y1 <= -NODE_GUARANTEE_RADIUS || y0 >= NODE_GUARANTEE_RADIUS) return;
    this.guaranteed ??= this.allKinds.map((kind, i) => { const [tx, ty] = this.guaranteeTile(seed, kind, i, N); return { kind, tx, ty }; });
    for (const { kind, tx, ty } of this.guaranteed) {
      if (tx < x0 || tx >= x1 || ty < y0 || ty >= y1) continue;
      const li = (ty - y0) * CHUNK_SIZE + (tx - x0);
      if (occupied.has(li)) continue;
      const tile = this.tileAt(tx, ty); if (tile === 1 || tile === 8) continue; // never plant on water
      nodes.push({ tx, ty, kind }); occupied.add(li);
    }
  }

  /** Deterministic host tile for a guaranteed kind (inside NODE_GUARANTEE_RADIUS). */
  guaranteeTile(seed: number, kind: number, index: number, count = this.allKinds.length): [number, number] {
    const want = this.kindTiles.get(kind) ?? [3];
    const ang = (index + hash2(seed ^ 0x6775, kind, index)) / Math.max(1, count) * Math.PI * 2;
    const baseR = 52 + hash2(seed ^ 0x6775, kind, 1) * (NODE_GUARANTEE_RADIUS - 60);
    for (let attempt = 0; attempt < 48; attempt++) {
      const r = baseR + (attempt % 8) * 3;
      const a = ang + (attempt * 0.17);
      const tx = Math.round(Math.cos(a) * r);
      const ty = Math.round(Math.sin(a) * r);
      if (Math.abs(tx) >= NODE_GUARANTEE_RADIUS || Math.abs(ty) >= NODE_GUARANTEE_RADIUS) continue;
      if (this.forcedWater(tx, ty)) continue;
      const tile = this.bandAt(tx, ty, this.noiseAt(tx, ty)).tile;
      if (want.includes(tile)) return [tx, ty];
    }
    // Last resort: first non-water land near the base angle (still inside the radius).
    for (let attempt = 0; attempt < 64; attempt++) {
      const r = 40 + attempt * 2;
      const a = ang + attempt * 0.31;
      const tx = Math.round(Math.cos(a) * r);
      const ty = Math.round(Math.sin(a) * r);
      if (Math.abs(tx) >= NODE_GUARANTEE_RADIUS || Math.abs(ty) >= NODE_GUARANTEE_RADIUS) continue;
      if (this.forcedWater(tx, ty)) continue;
      const tile = this.bandAt(tx, ty, this.noiseAt(tx, ty)).tile;
      if (tile !== 1) return [tx, ty];
    }
    return [Math.round(Math.cos(ang) * 56), Math.round(Math.sin(ang) * 56)];
  }
}
