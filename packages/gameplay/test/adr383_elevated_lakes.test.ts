/**
 * ADR-383: an elevated lake behaves like a normal lake for the systems that route through water —
 * AI water crossing (depth profile -> the same ford/swim/around rule) and the terrain flow system
 * (waterSurfaceAt reads the elevated surface, so a dug channel below the rim floods from it).
 * The lake itself is tile-1/8 water, so swimming, wetness, thirst and depth rules need no changes.
 */
import { describe, it, expect } from "vitest";
import {
  ProceduralGenerator, CHUNK_SIZE, TileMap,
  waterFeatureLayout, waterDepthAt, WaterDepth,
} from "@engine/world";
import {
  profileFromDepths, structuralCrossing, decideCrossing, legUncrossableAtPlan, WATER_DATA,
} from "../src/ai/water_crossing.js";
import { waterSurfaceAt } from "../src/terrain.js";
import { terrainFromTileMap } from "../src/world.js";

const FIT_BOT = { riding: false, mountSwims: false, hp: 1, hunger: 100, thirst: 100, stamina: 100, staminaMax: 100, cold: false };
const SPEEDS = { foot: 3, ride: 5, wadeMul: 0.5, swimMul: 0.5 };

/** Depth profile sampled across a lake's diameter (2-tile steps, like travel.ts leg sampling). */
function transect(g: ProceduralGenerator, cx: number, cy: number, r: number) {
  const depths: WaterDepth[] = [];
  for (let x = cx - r; x <= cx + r; x += 2) depths.push(waterDepthAt((ax, ay) => g.tileAt(ax, ay), x, cy));
  return profileFromDepths(depths, r * 2);
}

describe("ADR-383 elevated lake: AI water crossing parity", () => {
  it("the elevated lake's depth profile has a normal lake's shape, and the same crossing rule governs both", () => {
    for (let i = 0; i < 16; i++) {
      const seed = ((i * 2654435761) >>> 0) || 1;
      const g = new ProceduralGenerator({ seed });
      const L = waterFeatureLayout(seed);
      const el = L.elevatedLake;
      const elevated = transect(g, Math.floor(el.x), Math.floor(el.y), el.r);
      const normal = transect(g, Math.floor(L.lake.x), Math.floor(L.lake.y), L.lake.r);
      for (const p of [elevated, normal]) {
        expect(p.deep).toBeGreaterThan(0); // a deep middle to swim
        // Shore before (or, where the lake merges with a biome sea, at) the deep water: the leg never
        // starts in deep water without the shore having been wet first.
        expect(p.firstWet).toBeLessThanOrEqual(p.firstDeep);
        // The rule, not a fixed outcome: a short deep run is swum, a long one is walked around — identically
        // for the elevated lake and the ordinary lake.
        const want = p.maxDeepRun <= WATER_DATA.swimMaxDeepTiles ? "swim" : "around";
        expect(structuralCrossing(p, false, false)).toBe(want);
        expect(decideCrossing(p, FIT_BOT, SPEEDS)).toBe(want);
        // A mount that cannot swim only forces a re-plan around a long deep run, for either lake.
        expect(legUncrossableAtPlan(p, true, false)).toBe(p.maxDeepRun > WATER_DATA.nonSwimmerPlanDeepTiles);
      }
      expect(elevated.deep).toBeGreaterThan(0);
    }
  });

  it("the elevated lake has a wadeable shore where it has a land shore (a lake merged with a biome sea has none)", () => {
    let withShore = 0;
    for (let i = 0; i < 40; i++) {
      const seed = ((i * 2654435761) >>> 0) || 1;
      const g = new ProceduralGenerator({ seed });
      const L = waterFeatureLayout(seed);
      const el = L.elevatedLake;
      const t = (x: number, y: number): number => g.tileAt(x, y);
      let sawShallow = false, hasShore = false;
      for (let y = Math.floor(el.y) - el.r - 1; y <= Math.floor(el.y) + el.r + 1; y++)
        for (let x = Math.floor(el.x) - el.r - 1; x <= Math.floor(el.x) + el.r + 1; x++) {
          const d = Math.hypot(x + 0.5 - el.x, y + 0.5 - el.y);
          if (d <= el.r && waterDepthAt(t, x, y) === WaterDepth.Shallow) sawShallow = true;
          if (d > el.r && d <= el.r + 1 && ![1, 8].includes(g.tileAt(x, y))) hasShore = true;
        }
      if (hasShore) { withShore++; expect(sawShallow).toBe(true); }
    }
    expect(withShore).toBeGreaterThanOrEqual(36); // >= 90% of seeds have a land shore
  });
});

describe("ADR-383 elevated lake: terrain flow sees the elevated surface", () => {
  it("waterSurfaceAt reads the elevated level at the lake and the flat level at the ordinary lake", () => {
    for (let i = 0; i < 8; i++) {
      const seed = ((i * 40503 + 9) >>> 0) || 1;
      const g = new ProceduralGenerator({ seed });
      const L = waterFeatureLayout(seed);
      const el = L.elevatedLake;
      const map = new TileMap();
      for (const [cx, cy] of [[Math.floor(el.x), Math.floor(el.y)], [Math.floor(L.lake.x), Math.floor(L.lake.y)]] as const) {
        const ccx = Math.floor(cx / CHUNK_SIZE), ccy = Math.floor(cy / CHUNK_SIZE);
        for (let y = ccy - 1; y <= ccy + 1; y++) for (let x = ccx - 1; x <= ccx + 1; x++) map.insertChunk(g.load(x, y).chunk);
      }
      const terrain = terrainFromTileMap(map);
      expect(waterSurfaceAt(terrain, Math.floor(el.x), Math.floor(el.y))).toBe(el.level);
      expect(waterSurfaceAt(terrain, Math.floor(L.lake.x), Math.floor(L.lake.y))).toBe(0);
      // A dry tile in the lake's neighbourhood has no water surface (the rim may be sea in some
      // seeds, so scan for land rather than assuming a fixed offset is dry).
      let dry: [number, number] | undefined;
      outer: for (let y = Math.floor(el.y) - el.r - 6; y <= Math.floor(el.y) + el.r + 6; y++)
        for (let x = Math.floor(el.x) - el.r - 6; x <= Math.floor(el.x) + el.r + 6; x++)
          if (![1, 8].includes(map.getTile(x, y))) { dry = [x, y]; break outer; }
      if (dry) expect(waterSurfaceAt(terrain, dry[0], dry[1])).toBeUndefined();
    }
  });
});
