// ADR-283: seasonal daylight (~40°N): long summer days, short winter days, equinoxes near 12 h, smooth across boundaries;
// new worlds start just after that day's sunrise; day/night consumers read the remapped sun fraction.
import { describe, expect, test } from "vitest";
import { dayLengthHours, setSeason, setTimeOfDay, sunFractionFor, sunTimes, timeOfDay, wallHoursForSun, World } from "@engine/core";
import { currentPhaseKey, dayPhase, DayPhase, defaultDefs, installGameplay, newWorldStartHours } from "../src/index.js";

const L = 15;
describe("ADR-283 day length", () => {
  test("season midpoints: summer ~15 h, winter ~9 h, fall / spring ~12 h", () => {
    expect(dayLengthHours(0.5 * L, L)).toBeCloseTo(15, 5);
    expect(dayLengthHours(1.5 * L, L)).toBeCloseTo(12, 5);
    expect(dayLengthHours(2.5 * L, L)).toBeCloseTo(9, 5);
    expect(dayLengthHours(3.5 * L, L)).toBeCloseTo(12, 5);
    expect(dayLengthHours(4.5 * L, L)).toBeCloseTo(15, 5); // next year
    expect(dayLengthHours(3, 0)).toBe(12); // seasons off
  });
  test("interpolates smoothly across every season boundary (no pop) and stays within 9..15 h", () => {
    let prev = dayLengthHours(0, L);
    for (let d = 0.05; d <= 4 * L; d += 0.05) { const v = dayLengthHours(d, L); expect(Math.abs(v - prev)).toBeLessThan(0.02); expect(v).toBeGreaterThanOrEqual(9 - 1e-9); expect(v).toBeLessThanOrEqual(15 + 1e-9); prev = v; }
    for (const b of [L, 2 * L, 3 * L]) expect(Math.abs(dayLengthHours(b + 1e-3, L) - dayLengthHours(b - 1e-3, L))).toBeLessThan(1e-3);
    expect(dayLengthHours(L, L)).toBeGreaterThan(12); expect(dayLengthHours(L, L)).toBeLessThan(15); // summer->fall boundary is in between
  });
  test("sun remap: sunrise -> 0.25, noon -> 0.5, sunset -> 0.75, monotone; inverse round-trips", () => {
    for (const D of [9, 12, 15]) {
      const { sunrise, sunset } = sunTimes(D);
      expect(sunFractionFor(sunrise / 24, D)).toBeCloseTo(0.25, 9); expect(sunFractionFor(0.5, D)).toBeCloseTo(0.5, 9); expect(sunFractionFor(sunset / 24, D)).toBeCloseTo(0.75, 9);
      expect(wallHoursForSun(6, D)).toBeCloseTo(sunrise, 9); expect(wallHoursForSun(18, D)).toBeCloseTo(sunset, 9);
      for (let h = 0; h < 24; h += 0.5) expect(wallHoursForSun(sunFractionFor(h / 24, D) * 24, D)).toBeCloseTo(h, 6);
    }
  });
  test("same clock hour: 6:00 AM is day in summer and night in winter; 6:30 PM is day in summer, dark in winter", () => {
    expect(dayPhase(sunFractionFor(6 / 24, 15))).not.toBe(DayPhase.Night);
    expect(sunFractionFor(6 / 24, 9)).toBeLessThan(0.25); expect(dayPhase(sunFractionFor(5.5 / 24, 9))).toBe(DayPhase.Night); // pre-sunrise in winter
    expect(sunFractionFor(18.5 / 24, 15)).toBeLessThan(0.75); expect(sunFractionFor(18.5 / 24, 9)).toBeGreaterThan(0.75);
  });
});

describe("ADR-283 shared world schedule", () => {
  test("timeOfDay carries the seasonal sun fraction; zombie phase follows it", () => {
    const w = new World({ seed: 3 }); installGameplay(w, { role: "server" });
    setSeason(w, 2, 7); setTimeOfDay(w, 7); // mid-winter, 7:00 AM: still before ~7:30 sunrise
    const tod = timeOfDay(w); expect(tod.daylightHours!).toBeLessThan(9.2); expect(tod.sunT!).toBeLessThan(0.25); expect(currentPhaseKey(w)).not.toBe("day");
    setSeason(w, 0, 7); setTimeOfDay(w, 7); expect(timeOfDay(w).daylightHours!).toBeGreaterThan(14.8); expect(currentPhaseKey(w)).not.toBe("night");
  });
  test("new world spawn time is just after that day's dawn in every start season", () => {
    for (const startSeason of [0, 1, 2, 3]) {
      const defs = defaultDefs(); const env = defs.environment as { seasons?: { startSeason: number } };
      if (env.seasons) env.seasons.startSeason = startSeason;
      const w = new World({ seed: 5 }); installGameplay(w, { role: "server", defs });
      const tod = timeOfDay(w); const sunrise = sunTimes(tod.daylightHours!).sunrise;
      expect(tod.hours).toBeGreaterThan(sunrise); expect(tod.hours).toBeLessThan(sunrise + 3);
      expect(tod.sunT!).toBeCloseTo(defs.environment.startTimeOfDay, 2);
      expect(newWorldStartHours(w, defs.environment.startTimeOfDay)).toBeCloseTo(tod.hours, 2);
    }
  });
});
