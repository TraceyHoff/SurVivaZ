import { describe, expect, it } from "vitest";
import { fnv1a } from "@engine/core";
import { ProceduralGenerator } from "../src/generator.js";
import { sampleWorldPreview } from "../src/preview.js";
import {
  REGION_SIZE, REGION_HALF, REGION_FEATURE_SCALE, SCALED_WATER_FEATURE_RADIUS,
  WATER_FEATURE_RADIUS, NODE_GUARANTEE_RADIUS, PREVIEW, previewWorldAt, worldPreviewSvg,
  computeSpawnPoints, waterFeatureLayout, waterFeatureAt, riverPoint,
} from "../src/index.js";

/** ADR-423: chunk-generation timing probe over the tripled area. Same probe before/after the
 *  change, so the numbers are comparable. Harness numbers only — not proof of real-play
 *  smoothness on a phone. Bounds are generous (flake guard); the reported ms/chunk is the signal. */

const SEED = 423423;

function stats(ms: number[]): { mean: number; p95: number; max: number } {
  const s = [...ms].sort((a, b) => a - b);
  const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
  return { mean, p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!, max: s[s.length - 1]! };
}

describe("ADR-423 chunk-gen probe (tripled area)", () => {
  it("probe: 9x9 chunk grid around the origin (region-zero core)", () => {
    const g = new ProceduralGenerator({ seed: SEED });
    const ms: number[] = [];
    for (let cy = -4; cy <= 4; cy++) for (let cx = -4; cx <= 4; cx++) {
      const t0 = performance.now(); g.load(cx, cy); ms.push(performance.now() - t0);
    }
    const s = stats(ms);
    console.log(`[adr423-probe] origin 9x9: n=${ms.length} mean=${s.mean.toFixed(3)}ms p95=${s.p95.toFixed(3)}ms max=${s.max.toFixed(3)}ms`);
    expect(s.mean).toBeLessThan(50);
  });

  it("probe: 7x7 chunk grid at 8-chunk stride spanning +-768 tiles (crosses region boundaries)", () => {
    const g = new ProceduralGenerator({ seed: SEED });
    const ms: number[] = [];
    for (const cy of [-24, -16, -8, 0, 8, 16, 24]) for (const cx of [-24, -16, -8, 0, 8, 16, 24]) {
      const t0 = performance.now(); g.load(cx, cy); ms.push(performance.now() - t0);
    }
    const s = stats(ms);
    console.log(`[adr423-probe] span +-768 7x7: n=${ms.length} mean=${s.mean.toFixed(3)}ms p95=${s.p95.toFixed(3)}ms max=${s.max.toFixed(3)}ms`);
    expect(s.mean).toBeLessThan(50);
  });

  it("probe: first-chunk cost per fresh region (region-layout + siting, memoized after)", () => {
    const g = new ProceduralGenerator({ seed: SEED });
    const ms: number[] = [];
    // Chunk coords 48 apart in tiles*32: each lands in a distinct region under both the old
    // 512-tile and the new 1536-tile region size (48 chunks = 1536 tiles apart).
    for (const [cx, cy] of [[48, 0], [96, 0], [0, 48], [-48, 48], [96, 96], [-96, -96], [144, -48], [0, -96]] as const) {
      const t0 = performance.now(); g.load(cx, cy); ms.push(performance.now() - t0);
    }
    const s = stats(ms);
    console.log(`[adr423-probe] fresh-region first chunk: n=${ms.length} mean=${s.mean.toFixed(3)}ms p95=${s.p95.toFixed(3)}ms max=${s.max.toFixed(3)}ms`);
    expect(s.max).toBeLessThan(500);
  });

  it("probe: preview sampling time (sampleWorldPreview)", () => {
    const t0 = performance.now(); const p = sampleWorldPreview(SEED); const ms = performance.now() - t0;
    console.log(`[adr423-probe] sampleWorldPreview: ${ms.toFixed(1)}ms for ${p.tiles.length} samples`);
    expect(p.tiles.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(5000);
  });
});

describe("ADR-423 tripled map size: definition", () => {
  it("region side 512 -> 1536, feature scale x3, windows 120 / 360", () => {
    expect(REGION_SIZE).toBe(1536);
    expect(REGION_HALF).toBe(768);
    expect(REGION_FEATURE_SCALE).toBe(3);
    expect(WATER_FEATURE_RADIUS).toBe(120); // starter region window, unchanged
    expect(SCALED_WATER_FEATURE_RADIUS).toBe(360);
    // What did NOT triple (deliberate — see DECISIONS ADR-423): starter guarantee, spawn radius,
    // climate wavelength, chunk size and streaming radius.
    expect(NODE_GUARANTEE_RADIUS).toBe(160);
  });

  it("preview covers 1536x1536 at the same 128x128 sample count", () => {
    expect(PREVIEW.width).toBe(128); expect(PREVIEW.height).toBe(128);
    expect(PREVIEW.width * PREVIEW.stride).toBe(1536);
    expect(PREVIEW.height * PREVIEW.stride).toBe(1536);
    expect(PREVIEW.x).toBe(-768); expect(PREVIEW.y).toBe(-768);
    expect(PREVIEW.stride).toBe(12);
    const p = sampleWorldPreview(SEED);
    expect(p.tiles.length).toBe(16384);
    const svg = worldPreviewSvg(p);
    expect(svg).toContain(`viewBox="0 0 128 128"`);
    expect(svg.length).toBeGreaterThan(1000);
  });
});

describe("ADR-423 region zero is preserved (same seed, same layout at old coordinates)", () => {
  const seeds = [1, 42, 1234, 424242, 0xffffffff];
  it("region zero's layout equals the pre-423 hash baseline (scale 1) for lake/pond/river/elevated lake", () => {
    for (const seed of seeds) {
      const g = new ProceduralGenerator({ seed });
      const sited = g.regionLayout(0, 0)!;
      const baseline = waterFeatureLayout(seed);
      expect(sited.lake).toEqual(baseline.lake);
      expect(sited.pond).toEqual(baseline.pond);
      expect(sited.river).toEqual(baseline.river);
      // The elevated lake may have been re-sited by ADR-386 (or skipped); the hash baseline it
      // starts from is unchanged, and any sited lake stays inside the old window.
      expect(Math.abs(baseline.elevatedLake!.x)).toBeLessThan(WATER_FEATURE_RADIUS);
      expect(Math.abs(baseline.elevatedLake!.y)).toBeLessThan(WATER_FEATURE_RADIUS);
      if (sited.elevatedLake) {
        expect(sited.elevatedLake.r).toBe(baseline.elevatedLake!.r);
        expect(sited.elevatedLake.level).toBe(baseline.elevatedLake!.level);
        expect(Math.max(Math.abs(sited.elevatedLake.x), Math.abs(sited.elevatedLake.y))).toBeLessThan(WATER_FEATURE_RADIUS);
      }
    }
  });

  it("the old lake/pond centres are still water, and samples are deterministic across generators", () => {
    for (const seed of seeds) {
      const g = new ProceduralGenerator({ seed });
      const L = waterFeatureLayout(seed);
      for (const f of [L.lake, L.pond]) expect([1, 8]).toContain(g.tileAt(Math.floor(f.x), Math.floor(f.y)));
      const g2 = new ProceduralGenerator({ seed });
      for (let y = -256; y <= 256; y += 16) for (let x = -256; x <= 256; x += 16) {
        expect(g.sampleAt(x, y)).toEqual(g2.sampleAt(x, y));
        expect(g.heightAt(x, y)).toBe(g2.heightAt(x, y));
      }
    }
  });

  it("region zero spans +-768 tiles now: its edge tiles share region zero's layout, the next tile does not", () => {
    const g = new ProceduralGenerator({ seed: SEED });
    expect(g.regionLayout(767, 0)).toBe(g.regionLayout(0, 0));
    expect(g.regionLayout(-768, 0)).toBe(g.regionLayout(0, 0));
    expect(g.regionLayout(768, 0)).not.toBe(g.regionLayout(0, 0));
    expect(g.regionLayout(-769, 0)).not.toBe(g.regionLayout(0, 0));
    expect(g.regionLayout(0, 767)).toBe(g.regionLayout(0, 0));
    expect(g.regionLayout(0, 768)).not.toBe(g.regionLayout(0, 0));
  });
});

describe("ADR-423 scaled regions: the x3 feature window is respected", () => {
  it("non-zero regions scale lake/pond/elevated distances and radii x3, inside +-360", () => {
    for (const seed of [1, 42, 1234, 424242, 7, 99]) {
      const g = new ProceduralGenerator({ seed });
      for (const [rx, ry] of [[1, 0], [0, 1], [-2, 1], [2, -2]] as const) {
        const L = g.regionLayout(rx * REGION_SIZE, ry * REGION_SIZE)!;
        const lakeDist = Math.max(Math.abs(L.lake.x), Math.abs(L.lake.y));
        const pondDist = Math.max(Math.abs(L.pond.x), Math.abs(L.pond.y));
        // Bounds carry a ±0.5 tolerance: centres are round(d)+0.5, so a negative-cardinal
        // feature at distance d reads as d-0.5.
        expect(lakeDist).toBeGreaterThanOrEqual(143.5); expect(lakeDist).toBeLessThanOrEqual(249.5);
        expect(pondDist).toBeGreaterThanOrEqual(107.5); expect(pondDist).toBeLessThanOrEqual(225.5);
        expect(L.lake.r).toBeGreaterThanOrEqual(36); expect(L.lake.r).toBeLessThanOrEqual(51);
        expect(L.pond.r).toBeGreaterThanOrEqual(9); expect(L.pond.r).toBeLessThanOrEqual(12);
        expect(L.river.halfLen).toBeGreaterThanOrEqual(210); expect(L.river.halfLen).toBeLessThanOrEqual(297);
        expect(L.river.width).toBeGreaterThanOrEqual(1.15); expect(L.river.width).toBeLessThanOrEqual(1.7);
        if (L.elevatedLake) {
          const elDist = Math.max(Math.abs(L.elevatedLake.x), Math.abs(L.elevatedLake.y));
          // Sited lakes may use the ADR-386 fallback tier (minDistance-1 .. minDistance-21),
          // so the floor is 252-21 = 231, not 252 (and -0.5 for the centre offset).
          expect(elDist).toBeGreaterThanOrEqual(230.5); expect(elDist).toBeLessThanOrEqual(312.5);
          expect(L.elevatedLake.r).toBeGreaterThanOrEqual(18); expect(L.elevatedLake.r).toBeLessThanOrEqual(30);
          expect(L.elevatedLake.level).toBeGreaterThanOrEqual(4); expect(L.elevatedLake.level).toBeLessThanOrEqual(7);
          expect(elDist + L.elevatedLake.r + 12).toBeLessThan(SCALED_WATER_FEATURE_RADIUS);
        }
        // The scaled lake/pond centres are water in the world, and the river crosses its region.
        const ox = rx * REGION_SIZE, oy = ry * REGION_SIZE;
        for (const f of [L.lake, L.pond]) expect([1, 8]).toContain(g.tileAt(ox + Math.floor(f.x), oy + Math.floor(f.y)));
        for (const u of [-200, -100, 0, 100, 200]) {
          const p = riverPoint(L, u);
          // Region-LOCAL coords (the layout is local). The point is forced water; which
          // kind reads back depends on overlap priority (elevatedLake > lake > pond > river).
          expect(waterFeatureAt(0, Math.floor(p.x), Math.floor(p.y), L)).not.toBe("none");
        }
      }
    }
  });

  it("scaled layout equals waterFeatureLayout(regionSeed, 3) for the same region seed", () => {
    // The generator's scaled region layout (lake/pond/river) must match the pure function at
    // scale 3; the elevated lake may be re-sited by ADR-386, so compare its radius/level only.
    for (const seed of [1, 1234, 424242]) {
      const g = new ProceduralGenerator({ seed });
      const regionSeed = fnv1a("1,0", seed >>> 0);
      const expected = waterFeatureLayout(regionSeed, undefined, REGION_FEATURE_SCALE);
      const L = g.regionLayout(1 * REGION_SIZE, 0)!;
      expect(L.lake).toEqual(expected.lake);
      expect(L.pond).toEqual(expected.pond);
      expect(L.river).toEqual(expected.river);
      if (L.elevatedLake && expected.elevatedLake) {
        expect(L.elevatedLake.r).toBe(expected.elevatedLake.r);
        expect(L.elevatedLake.level).toBe(expected.elevatedLake.level);
      }
    }
  });
});

describe("ADR-423 spawn patches stay dry and clear at the unchanged radius", () => {
  it("every spawn point sits on a diagonal in the [48,144] window with a dry 5x5 patch", () => {
    for (const seed of [1, 42, 1234, 424242, 7, 99, 2024, 55555]) {
      const g = new ProceduralGenerator({ seed });
      const pts = computeSpawnPoints(g);
      expect(pts).toHaveLength(4);
      for (const p of pts) {
        const tx = Math.floor(p.x), ty = Math.floor(p.y);
        expect(Math.abs(tx)).toBeGreaterThanOrEqual(48); expect(Math.abs(tx)).toBeLessThanOrEqual(144);
        expect(Math.abs(ty)).toBeGreaterThanOrEqual(48); expect(Math.abs(ty)).toBeLessThanOrEqual(144);
        // No diagonal-closeness bound: the search maximises outward distance first (score
        // (i+j)*1024 - |i-j|), so a clear patch at (144, 96) legitimately beats (120, 120).
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const t = g.tileAt(tx + dx, ty + dy);
          expect(t).not.toBe(1); expect(t).not.toBe(8); // never water
        }
      }
    }
  });
});
