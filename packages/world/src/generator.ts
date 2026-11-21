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
import { isForcedWater, waterFeatureAt, waterFeatureLayout, REGION_FEATURE_SCALE, scaleElevatedLakeOptions, elevatedLakeDist, ELEVATED_LAKE_DEFAULTS, islandAt, type ElevatedLakeOptions, type Spillway, type WaterFeatureLayout } from "./waterFeatures.js";
import { flowWaterRaw, waterDepthAt, WaterDepth, WATER_TILE } from "./waterDepth.js";

/** ADR-423: the map triples. One region is now 1536x1536 tiles (was 512x512): the guaranteed-feature
 *  repeat period — the distance between one region's lake/river/pond set and the next — is 3x.
 *  Region zero keeps the ADR-255 starter layout exactly (scale 1 in layoutFor); non-zero regions use
 *  feature scale 3. The world is still infinite/streamed: chunk streaming (loadRadius) is unchanged,
 *  so tripling costs nothing per loaded chunk — only the generatable area, the region-layout memo
 *  (still capped at 16 regions) and the preview extent grow. */
export const REGION_SIZE = 1536;
export const REGION_HALF = REGION_SIZE / 2;

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
 * 22 was unreachable: plateau 3 x relief 6 + detail 2 topped out at 20 on every measured seed). */
export const HEIGHT_MAX = 26;
const HEIGHT_SALT = 0x6834; // "h4"
const TERRACE_SALT = 0x7465; // "te"

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
  private guaranteed: { kind: number; tx: number; ty: number }[] | undefined;
  /** kind -> band tile ids that may host it (from nodeKinds lists). */
  private readonly kindTiles: Map<number, number[]>;
  private readonly allKinds: number[];
  constructor(readonly opts: ProceduralOptions) {
    this.bands = opts.bands ?? DEFAULT_BANDS;
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
    const reg = this.layoutFor(tx, ty); if (!reg) return false;
    // ADR-386: a spillway channel is water too (its tiles are flow-encoded in load()/sampleAt).
    return isForcedWater(reg.seed, reg.lx, reg.ly, reg.layout) || spillLevelAt(reg.layout, reg.lx, reg.ly) !== undefined;
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
    const isSea = (lx: number, ly: number): boolean => this.bandOf(this.noiseAt(originX + lx, originY + ly)).tile === 1;
    const baseHeight = (lx: number, ly: number): number =>
      this.heightFromNoise(originX + lx, originY + ly, this.noiseAt(originX + lx, originY + ly), null, null);
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
        if (!ok) continue;
        const cand = { x: cx, y: cy, ringMean: ringN ? ringSum / ringN : 0, dOff: Math.abs(off), order };
        if (order === 0 && off === 0) hashScore = cand.ringMean;
        if (!best || cand.ringMean > best.ringMean || (cand.ringMean === best.ringMean && (cand.dOff < best.dOff || (cand.dOff === best.dOff && cand.order < best.order)))) best = cand;
      }
    }
    if (!best) {
      // Fallback tier: closer in (below the knob's minDistance, still on a free cardinal — clear of
      // the diagonal spawn patches and of the lake/pond on their own axes). A lake a little closer
      // beats no lake at all; only regions where every minDistance..maxDistance placement touches the
      // sea get here. ADR-423: distances derive from the region's effective minDistance (84 -> 83,
      // 78, 73, 68, 63 in region zero; x3 outside it).
      const fallbackDists = [1, 6, 11, 16, 21].map((step) => opts.minDistance - step);
      for (let order = 0; order < ordered.length; order++) {
        const ci = ordered[order]!; const [dx, dy] = cardinals[ci]!;
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
          const cand = { x: cx, y: cy, ringMean: ringN ? ringSum / ringN : 0, dOff: 0, order };
          if (!best || cand.ringMean > best.ringMean) best = cand;
        }
      }
    }
    if (!best) { layout.elevatedLake = undefined; return; } // skipped: no placement clear of the sea
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
      if (this.bandOf(this.noiseAt(originX + lx, originY + ly)).tile === 1) return true;
      const k = waterFeatureAt(regionSeed, lx, ly, layout);
      return k === "lake" || k === "river" || k === "pond" || k === "greatLake";
    };
    const inDisc = (lx: number, ly: number): boolean => elevatedLakeDist(layout, lx, ly) <= r;
    const inWindow = (lx: number, ly: number): boolean => Math.abs(lx) <= SPILLWAY_WINDOW && Math.abs(ly) <= SPILLWAY_WINDOW;
    const baseHeight = (lx: number, ly: number): number =>
      this.heightFromNoise(originX + lx, originY + ly, this.noiseAt(originX + lx, originY + ly), null, null);
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
   *  ADR-424: also the ADR-424 island disc holding the tile (undefined = not on an island). */
  private lakeAndSpill(tx: number, ty: number): { el: { level: number; r: number; dist: number } | undefined; sp: number | undefined; isl: { x: number; y: number; r: number; dist: number } | undefined } {
    if (!this.water) return { el: undefined, sp: undefined, isl: undefined };
    const reg = this.layoutFor(tx, ty); if (!reg) return { el: undefined, sp: undefined, isl: undefined };
    const sp = spillLevelAt(reg.layout, reg.lx, reg.ly);
    const isl = islandAt(reg.layout, reg.lx, reg.ly);
    if (!this.elevated) return { el: undefined, sp, isl };
    const held = reg.layout.elevatedLake;
    if (!held) return { el: undefined, sp, isl };
    const dist = Math.hypot(reg.lx + 0.5 - held.x, reg.ly + 0.5 - held.y);
    if (dist > held.r + this.elevated.rimWidth) return { el: undefined, sp, isl };
    return { el: { level: held.level, r: held.r, dist }, sp, isl };
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
   *  ADR-424: an island tile is land, never water — even where the biome noise under it is water. */
  private biomeOrForcedWater(tx: number, ty: number): boolean {
    if (this.islandAt(tx, ty)) return false;
    return this.forcedWater(tx, ty) || this.bandOf(this.noiseAt(tx, ty)).tile === 1;
  }
  private noiseAt(tx: number, ty: number): number {
    const seed = this.opts.seed >>> 0;
    return 0.65 * valueNoise(seed, tx, ty, 48) + 0.35 * valueNoise(seed ^ 0xabc, tx, ty, 12);
  }
  /**
   * ADR-254: continuous height in [0, heightMax]. Biome noise keeps shores low and peaks high; an independent
   * multi-octave field adds hills and ridges; a terrace field snaps some areas into plateaus so neighbouring tiles
   * form clear ledges (drops of 2+ levels) that the cliff / gt_side passes can draw.
   */
  heightAt(tx: number, ty: number): number { return this.heightFromNoise(tx, ty, this.noiseAt(tx, ty)); }
  private heightFromNoise(tx: number, ty: number, biome: number,
    /** ADR-383: precomputed elevated-lake hold for this tile (undefined = look it up; null = none). */
    el: { level: number; r: number; dist: number } | null | undefined = undefined,
    /** ADR-386: spillway level for this tile (undefined = look it up; null = known absent — the
     *  caller already checked, so the lookup is skipped; a number is the channel level itself). */
    spLevel: number | null | undefined = undefined,
    /** ADR-424: precomputed island disc for this tile (undefined = look it up; null = none). */
    isl: { x: number; y: number; r: number; dist: number } | null | undefined = undefined): number {
    const seed = this.opts.seed >>> 0; const H = this.opts.heightMax ?? HEIGHT_MAX;
    const field = 0.55 * valueNoise(seed ^ HEIGHT_SALT, tx, ty, 48)
      + 0.30 * valueNoise(seed ^ HEIGHT_SALT ^ 0x111, tx, ty, 18)
      + 0.15 * valueNoise(seed ^ HEIGHT_SALT ^ 0x222, tx, ty, 8);
    // Plateau bands (0..3), scaled below: gentle starter hills grow into eight-level wilderness cliffs.
    // Detail + a little biome keep rolling variation on top of each plateau so the ground is not a flat shelf.
    const plateau = Math.floor(valueNoise(seed ^ TERRACE_SALT, tx, ty, 28) * 4); // 0..3
    const detail = Math.floor(field * 2) + Math.floor(biome * 2); // 0..2
    // Gentle starter hills (all adjacent faces <=3); grow the relief over a wide transition,
    // not a ring-shaped cliff. Beyond it, eight-level terraces make real cliffs and deep valleys.
    // ADR-411: relief tops out at 8, so plateau 3 x 8 + detail 2 = HEIGHT_MAX (26) is actually reached.
    // ADR-423: the 160/224 transition stays — it is distance-from-spawn, not region size, so heights
    // at old coordinates are unchanged.
    const distance = Math.max(Math.abs(tx), Math.abs(ty));
    const blend = Math.max(0, Math.min(1, (distance - 160) / 224)), relief = 2 + 6 * blend;
    const gentleDetail = Math.floor(field + biome);
    const localDetail = Math.floor(gentleDetail + (detail - gentleDetail) * blend);
    const natural = Math.max(0, Math.min(H, Math.floor(plateau * relief) + localDetail));
    // ADR-386: a spillway channel overrides the bowl (the rim breach cuts the beach shelf) and the
    // natural field alike — the channel is carved water at its own descending levels. The base-field
    // probe (el === null, spLevel === null) never sees it: the spillway is computed from the base
    // field, not part of it.
    if (spLevel === undefined) {
      const sp = this.spillwayAt(tx, ty);
      if (sp !== undefined) return sp;
    } else if (spLevel !== null) return spLevel;
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
    const n = this.noiseAt(tx, ty); return this.tileFromNoise(tx, ty, n, this.bandOf(n));
  }
  /** Survey a tile and its height together without constructing a chunk, sharing the biome noise work.
   *  The height is the stored height: elevated-lake water stores the ADR-263/297 flow encoding of its
   *  surface level, exactly as load() stores it, so preview thumbnails agree with loaded chunks. */
  sampleAt(tx: number, ty: number): { tile: number; height: number } {
    const n = this.noiseAt(tx, ty);
    const tile = this.tileFromNoise(tx, ty, n, this.bandOf(n));
    const { el, sp, isl } = this.lakeAndSpill(tx, ty);
    // ADR-386: one layout lookup per tile (lakeAndSpill); the hold / spill level are threaded into
    // heightFromNoise as already-known (el ?? null, null) so it does not look them up again.
    // ADR-424: the island disc likewise (isl ?? null).
    const height = sp !== undefined ? flowWaterRaw(sp) : el && el.dist <= el.r ? flowWaterRaw(el.level) : this.heightFromNoise(tx, ty, n, el ?? null, null, isl ?? null);
    return { tile, height };
  }
  private tileFromNoise(tx: number, ty: number, n: number, band: NonNullable<ProceduralOptions["bands"]>[number]): number {
    // ADR-424: island ground overrides everything — the island disc is land inside the great lake
    // even where the biome noise underneath is water. Outer ring sand (beach), interior grass.
    // The biome band still drives node placement in load(), so islands can grow trees like any grass.
    const isl = this.islandAt(tx, ty);
    if (isl) return isl.dist > isl.r - 1 ? 2 : 3;
    if (this.forcedWater(tx, ty)) {
      const waterBand = this.bands.find((b) => b.tile === 1) ?? this.bands[0]!;
      return this.surface(tx, ty, 0, waterBand, true);
    }
    return this.surface(tx, ty, n, band, false);
  }
  /** Final ground tile: band tile, then ADR-246 mud, then ADR-249 cover. `forced` = ADR-255 water feature. */
  private surface(tx: number, ty: number, n: number, band: NonNullable<ProceduralOptions["bands"]>[number], forced = false): number {
    const t = forced ? 1 : this.mudOr(tx, ty, n, band); const c = this.opts.cover; if (c === false || (!forced && t !== band.tile)) return t;
    const o = { ...COVER_DEFAULTS, ...(c ?? {}) }; const bi = this.bands.indexOf(band); const lo = bi > 0 ? this.bands[bi - 1]!.max : 0;
    if (t === 1) { // shallows: shore end of the water band, or any water tile touching land (biome or non-feature)
      const up = this.bands[bi + 1];
      if (!forced && (!up || up.tile === 1)) return t;
      if (!forced && n >= band.max - o.shallowBand) return 8;
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
    const n = this.noiseAt(tx, ty); const band = this.bands.find((b) => n < b.max) ?? this.bands[this.bands.length - 1]!;
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
    const occupied = new Set<number>();
    for (let ly = 0; ly < CHUNK_SIZE; ly++) for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const tx = cx * CHUNK_SIZE + lx, ty = cy * CHUNK_SIZE + ly;
      const n = this.noiseAt(tx, ty);
      const band = this.bandOf(n);
      const i = ly * CHUNK_SIZE + lx; const tile = this.tileFromNoise(tx, ty, n, band); c.tiles[i] = tile;
      // ADR-383: elevated-lake water stores the ADR-263/297 flow encoding of its surface level, so the
      // renderer (renderTileHeight), terrainLevel and waterSurfaceAt all read the lake surface, not the
      // flat ADR-182 level. Every other tile stores its heightFromNoise level (bowl included) as before.
      // ADR-386: spillway channel water stores the flow encoding of its own descending level likewise.
      // One layout lookup per tile (lakeAndSpill); the hold / spill level are threaded into
      // heightFromNoise as already-known (el ?? null, null) so it does not look them up again.
      // ADR-424: the island disc likewise (isl ?? null) — island tiles store beach 1 / grass 2.
      const { el, sp, isl } = this.lakeAndSpill(tx, ty);
      c.height[i] = sp !== undefined ? flowWaterRaw(sp) : el && el.dist <= el.r ? flowWaterRaw(el.level) : this.heightFromNoise(tx, ty, n, el ?? null, null, isl ?? null);
      // No land resources on water (forced features or biome). Band chance still uses biome band kinds.
      if (tile !== 1 && tile !== 8 && band.nodeKinds?.length && rng.next() < (band.nodeChance ?? 0)) {
        nodes.push({ tx, ty, kind: rng.pick(band.nodeKinds) }); occupied.add(i);
      }
      this.trySunkenCache(cacheRng, cacheChance, tx, ty, tile, i, nodes, occupied);
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
    const occupied = new Set<number>();
    for (let ly = 0; ly < CHUNK_SIZE; ly++) for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const tx = cx * CHUNK_SIZE + lx, ty = cy * CHUNK_SIZE + ly;
      const n = this.noiseAt(tx, ty);
      const band = this.bandOf(n);
      const i = ly * CHUNK_SIZE + lx; const tile = this.tileFromNoise(tx, ty, n, band);
      // No land resources on water (forced features or biome). Band chance still uses biome band kinds.
      if (tile !== 1 && tile !== 8 && band.nodeKinds?.length && rng.next() < (band.nodeChance ?? 0)) {
        nodes.push({ tx, ty, kind: rng.pick(band.nodeKinds) }); occupied.add(i);
      }
      this.trySunkenCache(cacheRng, cacheChance, tx, ty, tile, i, nodes, occupied);
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
      const tile = this.bandOf(this.noiseAt(tx, ty)).tile;
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
      const tile = this.bandOf(this.noiseAt(tx, ty)).tile;
      if (tile !== 1) return [tx, ty];
    }
    return [Math.round(Math.cos(ang) * 56), Math.round(Math.sin(ang) * 56)];
  }
}
