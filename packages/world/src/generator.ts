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
import { isForcedWater, waterFeatureLayout, ELEVATED_LAKE_DEFAULTS, type ElevatedLakeOptions, type WaterFeatureLayout } from "./waterFeatures.js";
import { flowWaterRaw } from "./waterDepth.js";

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

/** ADR-254: terrain height levels. Biome noise still drives tile bands; a separate height field adds hills, plateaus and ledges. */
export const HEIGHT_MAX = 22;
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
/** ADR-255: radius (tiles) around the origin that always contains every guaranteed resource node. */
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
    const kt = new Map<number, Set<number>>();
    for (const b of this.bands) for (const k of b.nodeKinds ?? []) {
      let s = kt.get(k); if (!s) kt.set(k, (s = new Set())); s.add(b.tile);
    }
    this.kindTiles = new Map([...kt].map(([k, s]) => [k, [...s]]));
    this.allKinds = [...this.kindTiles.keys()];
  }
  /** Region layout + region-local coords for (tx, ty). Region zero preserves ADR-255's starter layout; other
   *  regions are seeded from their key (fnv1a) and memoized (cap 16, like before). Undefined outside the
   *  ±120-tile feature window of a non-zero region, or when water features are off. */
  private layoutFor(tx: number, ty: number): { layout: WaterFeatureLayout; lx: number; ly: number; seed: number } | undefined {
    if (!this.water) return undefined;
    // Every 512-tile region has seeded features; region zero preserves ADR-255's starter layout.
    const rx = Math.floor((tx + 256) / 512), ry = Math.floor((ty + 256) / 512);
    if (rx === 0 && ry === 0) return { layout: this.water, lx: tx, ly: ty, seed: this.opts.seed };
    const lx = tx - rx * 512, ly = ty - ry * 512;
    if (Math.abs(lx) > 120 || Math.abs(ly) > 120) return undefined;
    const key = `${rx},${ry}`; let region = this.regionWater.get(key);
    if (!region) {
      const seed = fnv1a(key, this.opts.seed >>> 0);
      region = { seed, layout: waterFeatureLayout(seed, this.elevated) };
      if (this.regionWater.size >= 16) this.regionWater.delete(this.regionWater.keys().next().value!);
      this.regionWater.set(key, region);
    }
    return { layout: region.layout, lx, ly, seed: region.seed };
  }
  private forcedWater(tx: number, ty: number): boolean {
    const reg = this.layoutFor(tx, ty); if (!reg) return false;
    return isForcedWater(reg.seed, reg.lx, reg.ly, reg.layout);
  }
  /**
   * ADR-383: the elevated lake holding (tx, ty) — its surface level, radius and distance from its centre —
   * or undefined. The disc + rim never reach the ±120 feature window edge (max extent 104+10+4 = 118), so
   * a tile inside them always has a layout; tiles outside any disc+rim return undefined without a lookup.
   */
  private elevatedLakeAt(tx: number, ty: number): { level: number; r: number; dist: number } | undefined {
    if (!this.elevated || !this.water) return undefined;
    const reg = this.layoutFor(tx, ty); if (!reg) return undefined;
    const el = reg.layout.elevatedLake;
    const dist = Math.hypot(reg.lx + 0.5 - el.x, reg.ly + 0.5 - el.y);
    if (dist > el.r + this.elevated.rimWidth) return undefined;
    return { level: el.level, r: el.r, dist };
  }
  /** True when the final tile at (tx,ty) is water (biome or ADR-255 feature), without building cover. */
  private biomeOrForcedWater(tx: number, ty: number): boolean {
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
    el: { level: number; r: number; dist: number } | null | undefined = undefined): number {
    const seed = this.opts.seed >>> 0; const H = this.opts.heightMax ?? HEIGHT_MAX;
    const field = 0.55 * valueNoise(seed ^ HEIGHT_SALT, tx, ty, 48)
      + 0.30 * valueNoise(seed ^ HEIGHT_SALT ^ 0x111, tx, ty, 18)
      + 0.15 * valueNoise(seed ^ HEIGHT_SALT ^ 0x222, tx, ty, 8);
    // Plateau bands (0..3), scaled below: gentle starter hills grow into six-level wilderness cliffs.
    // Detail + a little biome keep rolling variation on top of each plateau so the ground is not a flat shelf.
    const plateau = Math.floor(valueNoise(seed ^ TERRACE_SALT, tx, ty, 28) * 4); // 0..3
    const detail = Math.floor(field * 2) + Math.floor(biome * 2); // 0..3
    // Gentle starter hills (all adjacent faces <=3); grow the relief over a wide transition,
    // not a ring-shaped cliff. Beyond it, six-level terraces make real cliffs and deep valleys.
    const distance = Math.max(Math.abs(tx), Math.abs(ty));
    const blend = Math.max(0, Math.min(1, (distance - 160) / 224)), relief = 2 + 4 * blend;
    const gentleDetail = Math.floor(field + biome);
    const localDetail = Math.floor(gentleDetail + (detail - gentleDetail) * blend);
    const natural = Math.max(0, Math.min(H, Math.floor(plateau * relief) + localDetail));
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
    const el = this.elevatedLakeAt(tx, ty);
    const height = el && el.dist <= el.r ? flowWaterRaw(el.level) : this.heightFromNoise(tx, ty, n, el);
    return { tile, height };
  }
  private tileFromNoise(tx: number, ty: number, n: number, band: NonNullable<ProceduralOptions["bands"]>[number]): number {
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
    const occupied = new Set<number>();
    for (let ly = 0; ly < CHUNK_SIZE; ly++) for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const tx = cx * CHUNK_SIZE + lx, ty = cy * CHUNK_SIZE + ly;
      const n = this.noiseAt(tx, ty);
      const band = this.bandOf(n);
      const i = ly * CHUNK_SIZE + lx; const tile = this.tileFromNoise(tx, ty, n, band); c.tiles[i] = tile;
      // ADR-383: elevated-lake water stores the ADR-263/297 flow encoding of its surface level, so the
      // renderer (renderTileHeight), terrainLevel and waterSurfaceAt all read the lake surface, not the
      // flat ADR-182 level. Every other tile stores its heightFromNoise level (bowl included) as before.
      const el = this.elevatedLakeAt(tx, ty);
      c.height[i] = el && el.dist <= el.r ? flowWaterRaw(el.level) : this.heightFromNoise(tx, ty, n, el);
      // No land resources on water (forced features or biome). Band chance still uses biome band kinds.
      if (tile !== 1 && tile !== 8 && band.nodeKinds?.length && rng.next() < (band.nodeChance ?? 0)) {
        nodes.push({ tx, ty, kind: rng.pick(band.nodeKinds) }); occupied.add(i);
      }
    }
    if (this.opts.guaranteeNodes !== false) this.placeGuaranteedNodes(cx, cy, nodes, occupied);
    c.dirty = false; return { chunk: c, nodes };
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
