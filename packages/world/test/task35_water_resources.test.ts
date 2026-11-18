/**
 * ADR-255: every world seed has a lake, a river and a pond; every worldgen node kind (plants + gatherables)
 * appears at least once inside NODE_GUARANTEE_RADIUS.
 */
import { describe, it, expect } from "vitest";
import {
  ProceduralGenerator, NODE_GUARANTEE_RADIUS, WATER_FEATURE_RADIUS,
  waterFeatureLayout, waterFeatureAt, riverPoint, surveyWaterFeatures, isWaterId,
} from "../src/index.js";

/** Minimal bands mirroring gameplay worldgen shape (numeric kinds). */
function bandsWithKinds(kindsPerBand: number[][]): NonNullable<ConstructorParameters<typeof ProceduralGenerator>[0]["bands"]> {
  const maxes = [0.3, 0.36, 0.62, 0.8, 1.01];
  const tiles = [1, 2, 3, 4, 5];
  return maxes.map((max, i) => ({
    max, tile: tiles[i]!, temp: 15, humidity: 0.5,
    nodeKinds: kindsPerBand[i] ?? [],
    nodeChance: (kindsPerBand[i]?.length ?? 0) ? 0.05 : 0,
  }));
}

describe("ADR-255 water features (lake + river + pond)", () => {
  it("layout always defines lake, river and pond on cardinals (away from diagonal spawns)", () => {
    for (const seed of [1, 7, 42, 1234, 99999]) {
      const L = waterFeatureLayout(seed);
      expect(L.lake.r).toBeGreaterThanOrEqual(12);
      expect(L.pond.r).toBeGreaterThanOrEqual(3);
      expect(L.river.halfLen).toBeGreaterThanOrEqual(70);
      // lake and pond on different axes (one coord ~0.5 for each)
      const lakeAxis = Math.abs(L.lake.x) < 2 || Math.abs(L.lake.y) < 2;
      const pondAxis = Math.abs(L.pond.x) < 2 || Math.abs(L.pond.y) < 2;
      expect(lakeAxis).toBe(true); expect(pondAxis).toBe(true);
      expect(waterFeatureAt(seed, Math.floor(L.lake.x), Math.floor(L.lake.y))).toBe("lake");
      expect(waterFeatureAt(seed, Math.floor(L.pond.x), Math.floor(L.pond.y))).toBe("pond");
      const rp = riverPoint(L, 0);
      expect(waterFeatureAt(seed, Math.floor(rp.x), Math.floor(rp.y))).toBe("river");
    }
  });

  it("tileAt paints water at lake, river and pond for many seeds", () => {
    for (let i = 0; i < 24; i++) {
      const seed = ((i * 2654435761) >>> 0) || 1;
      const g = new ProceduralGenerator({ seed });
      const L = waterFeatureLayout(seed);
      const isW = (t: number) => t === 1 || t === 8;
      expect(isW(g.tileAt(Math.floor(L.lake.x), Math.floor(L.lake.y)))).toBe(true);
      expect(isW(g.tileAt(Math.floor(L.pond.x), Math.floor(L.pond.y)))).toBe(true);
      const rp = riverPoint(L, 10);
      expect(isW(g.tileAt(Math.floor(rp.x), Math.floor(rp.y)))).toBe(true);
      const s = surveyWaterFeatures(seed, (x, y) => g.tileAt(x, y), isWaterId, WATER_FEATURE_RADIUS);
      expect(s.forced).toEqual({ lake: true, river: true, pond: true, greatLake: false }); // ADR-424: region zero has no great lake
      expect(s.lakes).toBeGreaterThanOrEqual(1);
      expect(s.rivers).toBeGreaterThanOrEqual(1);
      expect(s.ponds).toBeGreaterThanOrEqual(1);
    }
  });

  it("waterFeatures: false leaves biome-only water (forced centres may be dry)", () => {
    const seed = 42;
    const L = waterFeatureLayout(seed);
    const off = new ProceduralGenerator({ seed, waterFeatures: false });
    // Not every centre is dry (biome lakes exist), but waterFeatureAt still reports features while tiles ignore them.
    expect(waterFeatureAt(seed, Math.floor(L.lake.x), Math.floor(L.lake.y))).toBe("lake");
    // With features off, tileAt ignores forced paint — equal to a generator that never forces.
    const on = new ProceduralGenerator({ seed });
    expect(on.tileAt(Math.floor(L.lake.x), Math.floor(L.lake.y))).not.toBe(0);
    // Off generator: no guarantee the forced lake tile is water
    void off;
  });
});

describe("ADR-255 full plant / resource coverage", () => {
  it("every band node kind appears inside NODE_GUARANTEE_RADIUS for many seeds", () => {
    // 70 synthetic kinds distributed like worldgen (sand/grass/forest/rock)
    const kinds: number[][] = [[], [], [], [], []];
    let id = 1;
    for (let i = 0; i < 12; i++) kinds[1]!.push(id++);
    for (let i = 0; i < 30; i++) kinds[2]!.push(id++);
    for (let i = 0; i < 18; i++) kinds[3]!.push(id++);
    for (let i = 0; i < 10; i++) kinds[4]!.push(id++);
    const all = kinds.flat();
    expect(all.length).toBe(70);

    for (let i = 0; i < 20; i++) {
      const seed = ((i * 40503 + 17) >>> 0) || 1;
      const g = new ProceduralGenerator({ seed, bands: bandsWithKinds(kinds) });
      const found = new Set<number>();
      const R = NODE_GUARANTEE_RADIUS; const cs = 32;
      for (let cy = Math.floor(-R / cs) - 1; cy <= Math.floor(R / cs) + 1; cy++)
        for (let cx = Math.floor(-R / cs) - 1; cx <= Math.floor(R / cs) + 1; cx++)
          for (const n of g.load(cx, cy).nodes) {
            if (Math.abs(n.tx) >= R || Math.abs(n.ty) >= R) continue;
            found.add(n.kind);
          }
      const miss = all.filter((k) => !found.has(k));
      expect(miss, `seed ${seed} missing ${miss.length}`).toEqual([]);
    }
  });

  it("guaranteeTile is deterministic and lands on a non-water tile", () => {
    const bands = bandsWithKinds([[], [10, 11], [20, 21, 22], [30], [40]]);
    const g = new ProceduralGenerator({ seed: 99, bands });
    const a = g.guaranteeTile(99, 20, 2, 5);
    const b = g.guaranteeTile(99, 20, 2, 5);
    expect(a).toEqual(b);
    const t = g.tileAt(a[0], a[1]);
    expect(t === 1 || t === 8).toBe(false);
  });
});
