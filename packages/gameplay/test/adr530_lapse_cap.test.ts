// ADR-530: gameplay climate model caps the altitude lapse (same cap as the world model).
// environment.json carries the knobs (altitudeLapseColdCap 30 / altitudeLapseWarmCap 15);
// without the cap a +100 peak reads -60 C and a -100 canyon floor +60 C through this path.
import { describe, expect, it } from "vitest";
import { defaultDefs, gameplayClimateModel } from "../src/index.js";
import type { TimeOfDayInfo } from "@engine/core";

const env = defaultDefs().environment;
const NOON: TimeOfDayInfo = { t: 0.5, hours: 12, day: 1, tickOfDay: 0, dayLengthTicks: 1200 };
const CALM = { kind: 0, intensity: 0, windDir: 0, windSpeed: 0 };

function tempAt(altitude: number): number {
  // No world: OFF_SEASON, so the seasonal curve is the deterministic legacy path and the
  // altitude difference isolates the lapse term exactly.
  return gameplayClimateModel(env).sample(
    { temperature: env.baseTemp, humidity: 0.5, altitude },
    { time: NOON, weather: CALM, x: 0, y: 0 },
  ).temperature;
}

describe("ADR-530 lapse cap (gameplay climate model)", () => {
  it("environment.json carries the lapse cap knobs", () => {
    expect(env.altitudeLapse).toBe(0.6);
    expect(env.altitudeLapseColdCap).toBe(30);
    expect(env.altitudeLapseWarmCap).toBe(15);
  });

  it("the altitude term caps at -30 C up / +15 C down", () => {
    const base = tempAt(0);
    expect(tempAt(10) - base).toBeCloseTo(-6, 9);
    expect(tempAt(25) - base).toBeCloseTo(-15, 9);
    expect(tempAt(50) - base).toBeCloseTo(-30, 9);
    expect(tempAt(-10) - base).toBeCloseTo(6, 9);
    expect(tempAt(-25) - base).toBeCloseTo(15, 9);
    expect(tempAt(100) - base).toBe(-30);
    expect(tempAt(-100) - base).toBe(15);
    expect(tempAt(75) - base).toBe(-30);
    expect(tempAt(-75) - base).toBe(15);
  });
});
