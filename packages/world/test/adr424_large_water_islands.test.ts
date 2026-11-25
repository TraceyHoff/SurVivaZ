import { describe, expect, it } from "vitest";
import {
  ProceduralGenerator, REGION_SIZE, REGION_FEATURE_SCALE, SCALED_WATER_FEATURE_RADIUS,
  WATER_FEATURE_RADIUS, computeSpawnPoints, waterFeatureLayout, waterFeatureAt, isForcedWater,
  surveyWaterFeatures, isWaterId, islandAt, greatLakeDist, WaterDepth, waterDepthAt,
  GREAT_LAKE_MIN_DIST, GREAT_LAKE_MAX_DIST, GREAT_LAKE_MIN_RADIUS, GREAT_LAKE_MAX_RADIUS,
  ISLAND_WATER_GAP, ISLAND_MIN_RADIUS, ISLAND_MAIN_MIN_RADIUS, ISLAND_MAIN_MAX_RADIUS,
  ISLAND_MAX_EXTRA,
} from "../src/index.js";

/** ADR-424: very large lakes (great lakes) with islands, seeded, in scaled regions only.
 *  Region zero keeps the ADR-255/423 starter layout exactly — no great lake there, spawn untouched.
 *  A scaled region gets one great lake (r 100..130, dist 230..340, on a diagonal) with
 *  >= 1 island guaranteed inside it (main island r 12..22, plus 0..3 islets r 8..14), each island
 *  ringed by >= ISLAND_WATER_GAP tiles of water so it is never a peninsula. Island ground is
 *  sand beach (tile 2, height 1) around grass (tile 3, height 2) — buildable land a boat can
 *  beach beside: deep water past the 2-tile shallow band, shallows, then sand. */

const SEEDS = [1, 7, 42, 1234, 424242, 999983, 20261117, 55555];
/** Absolute origin of region (1, 0): layout coords are region-local, centred on the region centre. */
const RX = REGION_SIZE, RY = 0;

function scaledLayout(seed: number) {
  return waterFeatureLayout(seed, undefined, REGION_FEATURE_SCALE);
}

describe("ADR-424 great lakes: layout numbers", () => {
  it("region zero has no great lake for any seed (starter layout pinned)", () => {
    for (const seed of SEEDS) expect(waterFeatureLayout(seed).greatLake).toBeUndefined();
  });

  it("every scaled region has exactly one great lake, r 100..130 at dist 230..340, extent inside 470", () => {
    for (const seed of SEEDS) {
      const L = scaledLayout(seed);
      const g = L.greatLake!;
      expect(g).toBeDefined();
      expect(g.r).toBeGreaterThanOrEqual(GREAT_LAKE_MIN_RADIUS);
      expect(g.r).toBeLessThanOrEqual(GREAT_LAKE_MAX_RADIUS);
      const dist = Math.hypot(g.x, g.y);
      expect(dist).toBeGreaterThanOrEqual(GREAT_LAKE_MIN_DIST);
      expect(dist).toBeLessThanOrEqual(GREAT_LAKE_MAX_DIST + 1);
      // ADR-534: the lake is sited (not just hashed), so its extent is the sited distance
      // plus its radius — up to GREAT_LAKE_MAX_DIST + GREAT_LAKE_MAX_RADIUS (470), past the
      // old SCALED_WATER_FEATURE_RADIUS (360) the ADR-424 layout used.
      expect(dist + g.r).toBeLessThanOrEqual(GREAT_LAKE_MAX_DIST + GREAT_LAKE_MAX_RADIUS);
      // Diagonal placement (ADR-424): |x| ~= |y|, both well off the axes — and geometrically
      // clear of the lake, pond and elevated lake on their cardinals (centre distance past the
      // radii sums). That clearance, not a cardinal rule, is what keeps the discs disjoint.
      expect(Math.abs(Math.abs(g.x) - Math.abs(g.y))).toBeLessThanOrEqual(2);
      expect(Math.abs(g.x)).toBeGreaterThan(100);
      for (const [o, or] of [[L.lake, L.lake.r], [L.pond, L.pond.r], [L.elevatedLake!, L.elevatedLake!.r]] as const) {
        expect(Math.hypot(g.x - o.x, g.y - o.y)).toBeGreaterThan(g.r + or + 2);
      }
    }
  });

  it("great lake is deterministic: same seed, same lake and islands", () => {
    for (const seed of SEEDS) {
      expect(scaledLayout(seed).greatLake).toEqual(scaledLayout(seed).greatLake);
      const a = new ProceduralGenerator({ seed }).regionLayout(RX, RY)!;
      const b = new ProceduralGenerator({ seed }).regionLayout(RX, RY)!;
      expect(a.greatLake).toEqual(b.greatLake);
    }
  });

  it("every non-zero region has a great lake (not just region (1,0))", () => {
    const g = new ProceduralGenerator({ seed: 424242 });
    for (const [rx, ry] of [[1, 0], [0, 1], [-1, -1], [2, 3], [-2, 1]] as const) {
      const L = g.regionLayout(rx * REGION_SIZE, ry * REGION_SIZE)!;
      expect(L.greatLake).toBeDefined();
      expect(L.greatLake!.islands.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("ADR-424 islands: placement guarantees", () => {
  it(">= 1 island per great lake, main island r 12..22, every island r >= 8", () => {
    for (const seed of SEEDS) {
      const g = scaledLayout(seed).greatLake!;
      expect(g.islands.length).toBeGreaterThanOrEqual(1);
      expect(g.islands.length).toBeLessThanOrEqual(1 + ISLAND_MAX_EXTRA);
      expect(g.islands[0]!.r).toBeGreaterThanOrEqual(ISLAND_MAIN_MIN_RADIUS);
      expect(g.islands[0]!.r).toBeLessThanOrEqual(ISLAND_MAIN_MAX_RADIUS);
      for (const isl of g.islands) {
        expect(isl.r).toBeGreaterThanOrEqual(ISLAND_MIN_RADIUS);
        // Fully inside the lake with the full water gap around it (1 tile slack for .5 rounding).
        const d = Math.hypot(isl.x - g.x, isl.y - g.y);
        expect(d + isl.r + ISLAND_WATER_GAP).toBeLessThanOrEqual(g.r + 1);
      }
      // Islands do not overlap each other (gap between discs, 1 tile slack for rounding).
      for (let i = 0; i < g.islands.length; i++) for (let j = i + 1; j < g.islands.length; j++) {
        const a = g.islands[i]!, b = g.islands[j]!;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.r + b.r + ISLAND_WATER_GAP - 1);
      }
    }
  });

  it("island ground is buildable land: grass core height 2, sand beach height 1", () => {
    for (const seed of SEEDS) {
      const gen = new ProceduralGenerator({ seed });
      const L = gen.regionLayout(RX, RY)!;
      const g = L.greatLake!;
      for (const isl of g.islands) {
        const cx = Math.floor(isl.x), cy = Math.floor(isl.y);
        const centre = gen.sampleAt(RX + cx, RY + cy);
        expect(centre.tile).toBe(3); // grass interior
        expect(centre.height).toBe(2);
        expect(isForcedWater(seed, cx, cy, L)).toBe(false);
        expect(waterFeatureAt(seed, cx, cy, L)).toBe("island");
        // Beach ring: a tile just inside the island edge is sand at height 1. (Offset r-0.4:
        // the tile centre lands at distance exactly r from the island centre — inside the disc
        // and past the r-1 beach boundary. r-0.6 would land exactly on r-1, which is grass.)
        const bx = Math.floor(isl.x + isl.r - 0.4), by = Math.floor(isl.y);
        const beach = gen.sampleAt(RX + bx, RY + by);
        expect(islandAt(L, bx, by)).toBeDefined();
        expect(beach.tile).toBe(2);
        expect(beach.height).toBe(1);
      }
    }
  });

  it("every island is fully surrounded by water (not a peninsula): the r+1..r+2 ring is all water", () => {
    for (const seed of SEEDS) {
      const gen = new ProceduralGenerator({ seed });
      const L = gen.regionLayout(RX, RY)!;
      const g = L.greatLake!;
      for (const isl of g.islands) {
        for (let y = Math.floor(isl.y - isl.r - 2); y <= Math.ceil(isl.y + isl.r + 2); y++)
          for (let x = Math.floor(isl.x - isl.r - 2); x <= Math.ceil(isl.x + isl.r + 2); x++) {
            const d = Math.hypot(x + 0.5 - isl.x, y + 0.5 - isl.y);
            if (d <= isl.r || d > isl.r + 2) continue;
            expect(isWaterId(gen.tileAt(RX + x, RY + y))).toBe(true);
          }
      }
    }
  });

  it("sited elevated lakes never overlap the great lake or its islands (ADR-386 siting vs ADR-424)", () => {
    // Regression: the first design put the great lake on the fourth cardinal, which ADR-386
    // siting can relocate the elevated lake onto — a relocated disc swallowed island grass into
    // elevated water (sampleAt height 1004 = flow-encoded level 4). The lake now sits on a
    // diagonal, geometrically clear of every cardinal-centred disc, so no siting change is needed
    // and the far-region siting rate is untouched. The invariant is geometric: the sited elevated
    // disc stays clear of the great disc, and every island tile stays island/grass/height 2.
    for (let i = 0; i < 24; i++) {
      const seed = ((i * 2654435761) >>> 0) || 1;
      const gen = new ProceduralGenerator({ seed });
      for (const [rx, ry] of [[1, 0], [0, 1], [2, 2], [-3, 1], [100, 110], [-100, -100]] as const) {
        const L = gen.regionLayout(rx * REGION_SIZE, ry * REGION_SIZE)!;
        const g = L.greatLake!;
        if (L.elevatedLake) {
          expect(Math.hypot(L.elevatedLake.x - g.x, L.elevatedLake.y - g.y))
            .toBeGreaterThan(L.elevatedLake.r + g.r + 2);
        }
        for (const isl of g.islands) {
          const cx = Math.floor(isl.x), cy = Math.floor(isl.y);
          expect(waterFeatureAt(seed, cx, cy, L)).toBe("island");
          const s = gen.sampleAt(rx * REGION_SIZE + cx, ry * REGION_SIZE + cy);
          expect(s.tile).toBe(3);
          expect(s.height).toBe(2);
        }
      }
    }
  });

  it("island tiles agree between sampleAt and loaded chunks", () => {
    const gen = new ProceduralGenerator({ seed: 424242 });
    const L = gen.regionLayout(RX, RY)!;
    const isl = L.greatLake!.islands[0]!;
    const cx = RX + Math.floor(isl.x), cy = RY + Math.floor(isl.y);
    const chunk = gen.load(Math.floor(cx / 32), Math.floor(cy / 32)).chunk;
    const lx = ((cx % 32) + 32) % 32, ly = ((cy % 32) + 32) % 32;
    const s = gen.sampleAt(cx, cy);
    expect(chunk.get(lx, ly)).toBe(s.tile);
    expect(chunk.getHeight(lx, ly)).toBe(s.height);
  });
});

describe("ADR-424 precedence: island > great lake > river", () => {
  it("an island tile reports island, a lake tile reports greatLake — never erased by the river", () => {
    for (const seed of SEEDS) {
      const L = scaledLayout(seed);
      const g = L.greatLake!;
      for (const isl of g.islands) {
        expect(waterFeatureAt(seed, Math.floor(isl.x), Math.floor(isl.y), L)).toBe("island");
      }
      // Open water in the disc (away from every island) is greatLake even where the river runs.
      let checked = 0;
      for (const [fx, fy] of [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5], [0.7, 0.7], [-0.7, -0.7]] as const) {
        const x = Math.floor(g.x + fx * g.r), y = Math.floor(g.y + fy * g.r);
        if (islandAt(L, x, y)) continue;
        expect(greatLakeDist(L, x, y)).toBeLessThanOrEqual(g.r);
        expect(waterFeatureAt(seed, x, y, L)).toBe("greatLake");
        checked++;
      }
      expect(checked).toBeGreaterThan(0);
    }
  });

  it("the regular lake, pond and river keep their kinds outside the great lake", () => {
    for (const seed of SEEDS) {
      const L = scaledLayout(seed);
      expect(waterFeatureAt(seed, Math.floor(L.lake.x), Math.floor(L.lake.y), L)).toBe("lake");
      expect(waterFeatureAt(seed, Math.floor(L.pond.x), Math.floor(L.pond.y), L)).toBe("pond");
    }
  });
});

describe("ADR-424 boats can reach the islands", () => {
  it("shallow band hugs the shore, deep water lies just beyond it", () => {
    for (const seed of SEEDS) {
      const gen = new ProceduralGenerator({ seed });
      const L = gen.regionLayout(RX, RY)!;
      const g = L.greatLake!;
      const isl = g.islands[0]!;
      const tileAt = (x: number, y: number) => gen.tileAt(x, y);
      // Probe toward the lake centre (not outward: the lake's far shore could make an outward
      // tile shallow). The main island sits >= ~12 tiles from the lake centre, so this is stable.
      const dl = Math.hypot(g.x - isl.x, g.y - isl.y);
      const ux = (g.x - isl.x) / dl, uy = (g.y - isl.y) / dl;
      // One tile out from the sand: shallow (the 2-tile band a boat slows through, then beaches).
      const sx = RX + Math.floor(isl.x + ux * (isl.r + 1)), sy = RY + Math.floor(isl.y + uy * (isl.r + 1));
      expect(isWaterId(gen.tileAt(sx, sy))).toBe(true);
      expect(waterDepthAt(tileAt, sx, sy)).toBe(WaterDepth.Shallow);
      // Three tiles out: deep water a boat sails at full speed on.
      const dx = RX + Math.floor(isl.x + ux * (isl.r + 3)), dy = RY + Math.floor(isl.y + uy * (isl.r + 3));
      expect(isWaterId(gen.tileAt(dx, dy))).toBe(true);
      expect(waterDepthAt(tileAt, dx, dy)).toBe(WaterDepth.Deep);
    }
  });
});

describe("ADR-424 survey, spawn safety and preview", () => {
  it("survey of a scaled region finds the great lake and its islands", () => {
    const seed = 424242;
    const gen = new ProceduralGenerator({ seed });
    const L = gen.regionLayout(RX, RY)!;
    const s = surveyWaterFeatures(seed, (x, y) => gen.tileAt(RX + x, RY + y), isWaterId, SCALED_WATER_FEATURE_RADIUS, L);
    expect(s.forced.greatLake).toBe(true);
    expect(s.greatLakes).toBeGreaterThanOrEqual(1);
    expect(s.islands).toBe(L.greatLake!.islands.length);
    expect(s.islands).toBeGreaterThanOrEqual(1);
  });

  it("region-zero survey still finds no great lake", () => {
    const seed = 424242;
    const gen = new ProceduralGenerator({ seed });
    const s = surveyWaterFeatures(seed, (x, y) => gen.tileAt(x, y), isWaterId, WATER_FEATURE_RADIUS);
    expect(s.forced.greatLake).toBe(false);
    expect(s.greatLakes).toBe(0);
    expect(s.islands).toBe(0);
  });

  it("spawn patches stay dry: region zero has no great lake and spawn tiles are land", () => {
    for (const seed of SEEDS) {
      expect(waterFeatureLayout(seed).greatLake).toBeUndefined();
      const gen = new ProceduralGenerator({ seed });
      for (const p of computeSpawnPoints(gen)) {
        const t = gen.tileAt(Math.floor(p.x), Math.floor(p.y));
        expect(isWaterId(t)).toBe(false);
      }
    }
  });

  it("a preview-style scan of a scaled region shows island land inside great-lake water", () => {
    // The menu preview (sampleWorldPreview) covers region zero only, so islands cannot appear
    // in it — this scans a scaled region the same way (stride 12) and checks the render path
    // sees grass/sand island pixels ringed by water, i.e. the palette already covers islands.
    const seed = 424242;
    const gen = new ProceduralGenerator({ seed });
    const L = gen.regionLayout(RX, RY)!;
    const g = L.greatLake!;
    let islandPixels = 0, waterPixels = 0;
    for (let y = -360; y < 360; y += 12) for (let x = -360; x < 360; x += 12) {
      const t = gen.tileAt(RX + x, RY + y);
      if (islandAt(L, x, y) && (t === 2 || t === 3)) islandPixels++;
      if (greatLakeDist(L, x, y) <= g.r && isWaterId(t)) waterPixels++;
    }
    expect(islandPixels).toBeGreaterThan(0);
    expect(waterPixels).toBeGreaterThan(islandPixels);
  });
});
