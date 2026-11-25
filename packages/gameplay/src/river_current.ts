/**
 * ADR-490: river current — forced rivers push swimmers and paddle/motor boats downstream.
 *
 * A forced river is the hash layout's river (packages/world/src/waterFeatures.ts): a straight
 * channel of half-length ~70-100 tiles with a sinusoidal meander. `+u` is downstream by
 * convention (there is no stored downhill — the direction is a documented arbitrary choice,
 * matching the meander derivative). The river's centreline at parameter u is
 * `riverPoint(layout, u)` and its downstream direction is the meander derivative there.
 *
 * Cost: this is the scope's cached lookup, NOT a per-tick layout build. `waterFeatureLayout`
 * is a pure function of (seed, region), so layouts are memoised per world in a WeakMap keyed by
 * region (cap 16, the generator's own cap); a classification is a Map lookup plus ~30 flops.
 * The helper is deterministic (no RNG, no new replicated state), so the client prediction in
 * `applyMovementInput` and the server's `stepPowered` agree.
 *
 * v1 boundaries: forced rivers only (no biome water, lakes/seas, spillways — spillway tiles are
 * flow-encoded but `waterFeatureAt` returns "none" there). The elevated-lake precedence uses the
 * HASH disc, while the generated world's lake may be relocated ±20 tiles by the siter, so a river
 * tile under a relocated lake's hash disc reads as lake, not river (and a river tile the siter
 * moved the lake away from still reads as river — either way the current is only ever felt on a
 * water tile, because callers also gate on `waterDepth`).
 */
import { fnv1a, type World } from "@engine/core";
import { REGION_FEATURE_SCALE, REGION_HALF, REGION_SIZE, waterFeatureAt, waterFeatureLayout, ProceduralGenerator, type WaterFeatureLayout } from "@engine/world";

/** Per-world memo of region feature layouts (the generator's own cap-16 pattern). */
const layoutCache = new WeakMap<World, Map<string, WaterFeatureLayout>>();
/** ADR-533: per-world seeded generator for the network-river lookup (the travel.ts pattern:
 *  `new ProceduralGenerator({ seed })` with the default bands is the same generator the server
 *  builds its chunks from, so its network layout is the generated one. Memoised per world; the
 *  network itself is memoised per region inside the generator, so the first river query in a
 *  region pays the one-time planning cost and later ticks pay a bbox + map lookup. */
const genCache = new WeakMap<World, ProceduralGenerator>();
const seededGenerator = (world: World): ProceduralGenerator => {
  let g = genCache.get(world); if (!g) genCache.set(world, (g = new ProceduralGenerator({ seed: world.seed })));
  return g;
};
const layoutFor = (world: World, rx: number, ry: number): WaterFeatureLayout => {
  let m = layoutCache.get(world);
  if (!m) layoutCache.set(world, (m = new Map()));
  const key = `${rx},${ry}`;
  let layout = m.get(key);
  if (!layout) {
    layout = rx === 0 && ry === 0
      ? waterFeatureLayout(world.seed)
      : waterFeatureLayout(fnv1a(key, world.seed >>> 0), undefined, REGION_FEATURE_SCALE);
    if (m.size >= 16) m.delete(m.keys().next().value!);
    m.set(key, layout);
  }
  return layout;
};

/** The region feature layout covering a region, with the region's seed (the layout is a pure function
 * of (seed, region), so it is memoised per world; cap 16, the generator's own cap). */
export function layoutForRegion(world: World, rx: number, ry: number): { layout: WaterFeatureLayout; seed: number } {
  const layout = layoutFor(world, rx, ry);
  const seed = rx === 0 && ry === 0 ? world.seed : fnv1a(`${rx},${ry}`, world.seed >>> 0);
  return { layout, seed };
}

/**
 * The region feature layout covering a world tile, with the tile's region-local coords, the region
 * seed, and the region itself. ADR-498 reuses this for the discovery scan (a chunk can straddle a
 * region boundary, so the scan resolves per tile and caches the region).
 */
export function regionLayoutFor(world: World, tx: number, ty: number): { layout: WaterFeatureLayout; lx: number; ly: number; seed: number; rx: number; ry: number } {
  const rx = Math.floor((tx + REGION_HALF) / REGION_SIZE);
  const ry = Math.floor((ty + REGION_HALF) / REGION_SIZE);
  const { layout, seed } = layoutForRegion(world, rx, ry);
  const lx = rx === 0 && ry === 0 ? tx : tx - rx * REGION_SIZE;
  const ly = rx === 0 && ry === 0 ? ty : ty - ry * REGION_SIZE;
  return { layout, lx, ly, seed, rx, ry };
}

/**
 * Downstream unit direction at a world position on a forced river, or undefined when the floored
 * tile is not one. The direction is the meander derivative at the entity's own `u` (region-local
 * CONTINUOUS position, not the tile), so it is smooth as the entity moves and swings with the
 * meander (up to ~38° off the river's base angle).
 *
 * ADR-533: network rivers push too — a network channel tile's downstream direction comes from
 * the generator's network layout (the channel record stores the walk direction per tile, so
 * the current follows the channel's bends and points at the mouth). Still water (sink ponds)
 * and delta sand have no current. The forced-river check runs first (cheap: a cached layout +
 * ~30 flops); the network lookup is a bbox + map lookup once the region's network is planned.
 */
export function riverCurrentAt(world: World, x: number, y: number): { x: number; y: number } | undefined {
  const tx = Math.floor(x), ty = Math.floor(y);
  const { layout, lx, ly, seed, rx, ry } = regionLayoutFor(world, tx, ty);
  if (waterFeatureAt(seed, lx, ly, layout) === "river") {
    // dx/du = cos(a) - sin(a)*(amp/period)*cos(u/period + phase),
    // dy/du = sin(a) + cos(a)*(amp/period)*cos(u/period + phase). +u is downstream by convention.
    const r = layout.river;
    const cx = x - rx * REGION_SIZE, cy = y - ry * REGION_SIZE;
    const u = cx * Math.cos(r.angle) + cy * Math.sin(r.angle);
    const slope = (r.amp / r.period) * Math.cos(u / r.period + r.phase);
    const dx = Math.cos(r.angle) - Math.sin(r.angle) * slope;
    const dy = Math.sin(r.angle) + Math.cos(r.angle) * slope;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
  }
  return seededGenerator(world).networkCurrentAt(tx, ty);
}
