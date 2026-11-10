// ADR-329: route water sampling uses seeded terrain for unloaded regions (ai/travel.ts).
// Before: regionCost sampled inWater, which reads the loaded TileMap (tile 0 = land when the chunk is not
// loaded, and false with no TerrainRes at all), so unloaded lakes costed as cheap dry land and routes planned
// across water. Now each sample resolves loaded terrain first, else the seeded ProceduralGenerator (the same
// generator the server builds chunks from), so unloaded water is wet and unloaded land is dry, deterministically.
import { describe, expect, it } from "vitest";
import { ProceduralGenerator, TileMap } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

const T = G.TRAVEL;
const S = T.regionTiles;
const SAMPLES = [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]] as const;
/** Wet sample count of a region straight from the seeded generator (the router's samples, same coordinates). */
function wetOf(w: ReturnType<typeof makeWorld>, gen: ProceduralGenerator, rx: number, ry: number): number {
  const swim = G.gameplayDefs(w).movement.swimTiles; let wet = 0;
  for (const [fx, fy] of SAMPLES) if (swim.has(gen.tileAt(Math.floor(rx * S + fx * S), Math.floor(ry * S + fy * S)))) wet++;
  return wet;
}
const expectedCost = (wet: number): number => (wet === 5 ? Infinity : 1 + T.waterCostMul * (wet / 5));
/** First all-water region (wet == 5) whose 8 neighbours are all passable, for one of the fixed seeds. */
function findLake(): { seed: number; rx: number; ry: number } {
  for (const seed of [42, 1, 7, 99, 1234, 2024, 31337]) {
    const w = makeWorld({}, seed), gen = new ProceduralGenerator({ seed });
    for (let ry = -48; ry <= 48; ry++) for (let rx = -48; rx <= 48; rx++) {
      if (wetOf(w, gen, rx, ry) !== 5) continue;
      let ring = true;
      for (let dy = -1; dy <= 1 && ring; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && wetOf(w, gen, rx + dx, ry + dy) === 5) ring = false;
      if (ring) return { seed, rx, ry };
    }
  }
  throw new Error("no all-water region with a passable ring in the scanned seeds");
}
/** First all-water region for a seed (no ring requirement). */
function findWaterRegion(seed: number): { rx: number; ry: number } {
  const w = makeWorld({}, seed), gen = new ProceduralGenerator({ seed });
  for (let ry = -48; ry <= 48; ry++) for (let rx = -48; rx <= 48; rx++) if (wetOf(w, gen, rx, ry) === 5) return { rx, ry };
  throw new Error(`no all-water region for seed ${seed}`);
}

describe("ADR-329 route water sampling", () => {
  it("a region that is actually water costs Infinity even when its chunk is unloaded (no TerrainRes at all)", () => {
    const { rx, ry } = findWaterRegion(42);
    const w = makeWorld({}, 42); // no TerrainRes attached: before ADR-329 every sample read as land (cost 1)
    expect(G.regionCost(w, rx, ry)).toBe(Infinity);
    expect(G.regionCost(w, rx, ry)).toBe(Infinity); // cached value is the same water cost
  });

  it("an unloaded region is never silently treated as cheap dry land: cost matches the seeded terrain everywhere", () => {
    const w = makeWorld({}, 42), gen = new ProceduralGenerator({ seed: 42 });
    let wetRegions = 0, waterRegions = 0;
    for (let ry = -16; ry <= 16; ry++) for (let rx = -16; rx <= 16; rx++) {
      const wet = wetOf(w, gen, rx, ry); if (wet > 0) wetRegions++; if (wet === 5) waterRegions++;
      expect(G.regionCost(w, rx, ry)).toBe(expectedCost(wet));
      if (wet > 0) expect(G.regionCost(w, rx, ry)).toBeGreaterThan(1);
    }
    expect(wetRegions).toBeGreaterThan(0); expect(waterRegions).toBeGreaterThan(0); // the scan really covers water
  });

  it("a route across a seeded lake detours around the all-water region instead of planning through it", () => {
    const { seed, rx, ry } = findLake();
    const w = makeWorld({}, seed); // nothing loaded: the lake is known only from the seed
    const from = { x: (rx - 3) * S + S / 2, y: ry * S + S / 2 }, to = { x: (rx + 3) * S + S / 2, y: ry * S + S / 2 };
    const route = G.planRegionRoute(w, from.x, from.y, to.x, to.y);
    expect(route).toBeDefined();
    const regions = route!.map((p) => ({ rx: Math.floor(p.x / S), ry: Math.floor(p.y / S) }));
    expect(regions.some((r) => r.rx === rx && r.ry === ry)).toBe(false); // never enters the lake region
    expect(regions.some((r) => r.rx === rx && r.ry !== ry)).toBe(true); // crosses the lake's column off-row: a detour
    expect(route!.at(-1)).toEqual(to);
  });

  it("loaded terrain wins over the seed: a loaded land map over a seeded lake is cheap, loaded water over seeded land is impassable", () => {
    const { rx, ry } = findWaterRegion(42);
    const land = makeWorld({}, 42), map = new TileMap();
    for (let y = ry * S; y < (ry + 1) * S; y++) for (let x = rx * S; x < (rx + 1) * S; x++) map.setTile(x, y, 3);
    land.setResource(G.TerrainRes, G.terrainFromTileMap(map));
    expect(G.regionCost(land, rx, ry)).toBe(1); // loaded land, not the seeded lake
    // ...and the reverse: a seeded dry region under loaded water
    const dry = makeWorld({}, 42), gen = new ProceduralGenerator({ seed: 42 });
    let dx = 0, dy = 0; outer: for (let y = -16; y <= 16; y++) for (let x = -16; x <= 16; x++) if (wetOf(dry, gen, x, y) === 0) { dx = x; dy = y; break outer; }
    const map2 = new TileMap();
    for (let y = dy * S; y < (dy + 1) * S; y++) for (let x = dx * S; x < (dx + 1) * S; x++) map2.setTile(x, y, 1);
    dry.setResource(G.TerrainRes, G.terrainFromTileMap(map2));
    expect(G.regionCost(dry, dx, dy)).toBe(Infinity);
  });

  it("determinism: the same seed plans the same route and costs the same regions on fresh worlds", () => {
    const { seed, rx, ry } = findLake();
    const from = { x: (rx - 3) * S + S / 2, y: ry * S + S / 2 }, to = { x: (rx + 3) * S + S / 2, y: ry * S + S / 2 };
    const a = makeWorld({}, seed), b = makeWorld({}, seed);
    expect(G.planRegionRoute(a, from.x, from.y, to.x, to.y)).toEqual(G.planRegionRoute(b, from.x, from.y, to.x, to.y));
    expect(G.planRegionRoute(a, from.x, from.y, to.x, to.y)).toEqual(G.planRegionRoute(a, from.x, from.y, to.x, to.y));
    for (let y = -8; y <= 8; y++) for (let x = -8; x <= 8; x++) expect(G.regionCost(a, x, y)).toBe(G.regionCost(b, x, y));
  });
});
