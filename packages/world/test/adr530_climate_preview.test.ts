// ADR-530: climate lapse cap + preview rescale.
// At 0.6 C/level the lapse is -60 C on a +100 peak and +60 C on a -100 canyon floor.
// The cap keeps the full rate where most play happens (first 50 levels up, first 25 down)
// and saturates beyond, so peaks stay survivable and canyon floors stay out of oven range.
// The preview relief light (0.86 + h*0.018) saturates at h >= 31; rescaled to h*0.0038.
import { describe, expect, it } from "vitest";
import { DefaultClimateModel, altitudeLapseEffect, sampleWorldPreview, worldPreviewSvg, PREVIEW, type WorldPreview } from "../src/index.js";
import type { TimeOfDayInfo } from "@engine/core";

const NOON: TimeOfDayInfo = { t: 0.5, hours: 12, day: 1, tickOfDay: 0, dayLengthTicks: 1200 };
const CALM = { kind: 0, intensity: 0, windDir: 0, windSpeed: 0 };

function noonTemp(altitude: number): number {
  return DefaultClimateModel.sample(
    { temperature: 15, humidity: 0.5, altitude },
    { time: NOON, weather: CALM, x: 0, y: 0 },
  ).temperature;
}

describe("ADR-530 lapse cap (world climate model)", () => {
  it("altitudeLapseEffect caps the altitude term at -30 C up / +15 C down", () => {
    // Exact rate inside the cap: -0.6/level up to 50 levels, +0.6/level down to 25 levels.
    expect(altitudeLapseEffect(0)).toBe(0);
    expect(altitudeLapseEffect(10)).toBeCloseTo(-6, 9);
    expect(altitudeLapseEffect(25)).toBeCloseTo(-15, 9);
    expect(altitudeLapseEffect(50)).toBeCloseTo(-30, 9);
    expect(altitudeLapseEffect(-10)).toBeCloseTo(6, 9);
    expect(altitudeLapseEffect(-25)).toBeCloseTo(15, 9);
    // Saturated beyond: a 100-level peak is -30, not -60; a 100-level canyon floor is +15, not +60.
    expect(altitudeLapseEffect(100)).toBe(-30);
    expect(altitudeLapseEffect(-100)).toBe(15);
    expect(altitudeLapseEffect(75)).toBe(-30);
    expect(altitudeLapseEffect(-75)).toBe(15);
  });

  it("a 100-level peak is survivable at noon and a 100-level canyon floor is not an oven", () => {
    const base = noonTemp(0); // 15 + 6 day curve
    expect(base).toBeCloseTo(21, 9);
    expect(noonTemp(100) - base).toBe(-30);
    expect(noonTemp(-100) - base).toBe(15);
    expect(noonTemp(100)).toBeCloseTo(-9, 9); // cold, needs fur — not -39
    expect(noonTemp(-100)).toBeCloseTo(36, 9); // hot midsummer floor — not 81
  });
});

describe("ADR-530 preview rescale", () => {
  const palette: Record<number, readonly [number, number, number]> = { 1: [36, 102, 149], 2: [201, 180, 117], 3: [106, 147, 69], 4: [85, 114, 58], 5: [137, 137, 130], 6: [220, 229, 230], 7: [50, 89, 53], 8: [67, 153, 177], 9: [116, 99, 65] };
  const flatPreview = (height: number): WorldPreview => ({
    seed: 1,
    tiles: new Uint16Array(PREVIEW.width * PREVIEW.height).fill(3),
    heights: new Int16Array(PREVIEW.width * PREVIEW.height).fill(height),
  });
  const fills = (svg: string): string[] => [...svg.matchAll(/fill="rgb\(([^)]+)\)"/g)].map((m) => m[1]!);

  it("100-level relief still shades instead of washing out (flat plateaus pin the light)", () => {
    // Grass palette x light: h=0 -> 0.86, h=50 -> 1.05, h=100 -> 1.24 (old code: 1.42 clamp at h>=31).
    expect(fills(worldPreviewSvg(flatPreview(0)))).toEqual(["91,126,59"]);
    expect(fills(worldPreviewSvg(flatPreview(50)))).toEqual(["111,154,72"]);
    expect(fills(worldPreviewSvg(flatPreview(100)))).toEqual(["131,182,86"]);
    expect(fills(worldPreviewSvg(flatPreview(-100)))).toEqual(["51,71,33"]); // 0.86 - 0.40 = 0.46 -> 0.48 floor
  });

  it("real seeds: relief still shades — many distinct colours, few pixels pinned at the clamps", () => {
    for (const seed of [1, 42, 1234, 424242, 9001]) {
      const p = sampleWorldPreview(seed);
      const svg = worldPreviewSvg(p);
      // Per-pixel (tile, colour) from the grouped paths.
      let landPixels = 0, pinned = 0;
      const distinct = new Set<string>();
      for (const m of svg.matchAll(/<path fill="rgb\(([^)]+)\)" d="([^"]*)"\/>/g)) {
        const rgb = m[1]!;
        for (const pt of m[2]!.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
          const x = Number(pt[1]), y = Number(pt[2]);
          const i = y * PREVIEW.width + x, tile = p.tiles[i]!;
          if (tile === 1 || tile === 8) continue; // water is flat light 1 by design
          landPixels++; distinct.add(rgb);
          const pal = palette[tile] ?? palette[3]!;
          const hi = pal.map((c) => Math.round(Math.min(255, c * 1.42))).join(",");
          const lo = pal.map((c) => Math.round(Math.min(255, c * 0.48))).join(",");
          if (rgb === hi || rgb === lo) pinned++;
        }
      }
      expect(distinct.size, `seed ${seed} distinct land shades`).toBeGreaterThan(40);
      expect(pinned / landPixels, `seed ${seed} pinned at a light clamp`).toBeLessThan(0.05);
    }
  });
});
