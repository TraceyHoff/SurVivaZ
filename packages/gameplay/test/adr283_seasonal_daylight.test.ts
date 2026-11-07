// ADR-283/285: seasonal daylight on the shared world clock. Season midpoints: summer 4:20 AM-9:00 PM, fall / spring
// 4:30 AM-7:30 PM, winter 5:30 AM-6:30 PM; smooth through the year; days gain light from winter through spring into summer.
import { describe, expect, test } from "vitest";
import { dayLengthHours, setSeason, setTimeOfDay, sunFractionFor, sunScheduleAt, timeOfDay, wallHoursForSun, World } from "@engine/core";
import { currentPhaseKey, dayPhase, DayPhase, defaultDefs, installGameplay, newWorldStartHours } from "../src/index.js";

const L = 15;
const SUMMER = sunScheduleAt(0.5 * L, L), FALL = sunScheduleAt(1.5 * L, L), WINTER = sunScheduleAt(2.5 * L, L), SPRING = sunScheduleAt(3.5 * L, L);
describe("ADR-285 schedule", () => {
  test("season midpoints hit the exact sunrise / sunset pairs", () => {
    const want: [typeof SUMMER, number, number][] = [[SUMMER, 4 + 20 / 60, 21], [FALL, 4.5, 19.5], [WINTER, 5.5, 18.5], [SPRING, 4.5, 19.5], [sunScheduleAt(4.5 * L, L), 4 + 20 / 60, 21]];
    for (const [s, sr, ss] of want) { expect(s.sunrise).toBeCloseTo(sr, 9); expect(s.sunset).toBeCloseTo(ss, 9); }
    expect(dayLengthHours(0.5 * L, L)).toBeCloseTo(16 + 40 / 60, 9); expect(dayLengthHours(1.5 * L, L)).toBeCloseTo(15, 9); expect(dayLengthHours(2.5 * L, L)).toBeCloseTo(13, 9);
    expect(sunScheduleAt(3, 0)).toEqual({ sunrise: 6, sunset: 18 }); // seasons off
  });
  test("smooth across every season boundary (no pop), daylight within 13 h .. 16 h 40 m", () => {
    let prev = sunScheduleAt(0, L);
    for (let d = 0.05; d <= 4 * L; d += 0.05) { const v = sunScheduleAt(d, L); expect(Math.abs(v.sunrise - prev.sunrise)).toBeLessThan(0.01); expect(Math.abs(v.sunset - prev.sunset)).toBeLessThan(0.01);
      const D = v.sunset - v.sunrise; expect(D).toBeGreaterThanOrEqual(13 - 1e-9); expect(D).toBeLessThanOrEqual(16 + 40 / 60 + 1e-9); prev = v; }
    for (const b of [L, 2 * L, 3 * L]) expect(Math.abs(dayLengthHours(b + 1e-3, L) - dayLengthHours(b - 1e-3, L))).toBeLessThan(1e-3);
  });
  test("days gain light from mid-winter through spring to mid-summer, then lose it through fall (strictly monotone)", () => {
    for (let d = 2.5 * L; d < 4.5 * L - 0.05; d += 0.1) expect(dayLengthHours(d + 0.1, L)).toBeGreaterThan(dayLengthHours(d, L));
    for (let d = 0.5 * L; d < 2.5 * L - 0.05; d += 0.1) expect(dayLengthHours(d + 0.1, L)).toBeLessThan(dayLengthHours(d, L));
    expect(dayLengthHours(3.25 * L, L)).toBeLessThan(dayLengthHours(3.75 * L, L)); // gain underway inside spring
  });
  test("sun remap: sunrise -> 0.25, sunset -> 0.75, monotone; inverse round-trips", () => {
    for (const S of [SUMMER, FALL, WINTER]) {
      expect(sunFractionFor(S.sunrise / 24, S)).toBeCloseTo(0.25, 9); expect(sunFractionFor(S.sunset / 24, S)).toBeCloseTo(0.75, 9);
      expect(wallHoursForSun(6, S)).toBeCloseTo(S.sunrise, 9); expect(wallHoursForSun(18, S)).toBeCloseTo(S.sunset, 9);
      for (let h = 0; h < 24; h += 0.5) expect(wallHoursForSun(sunFractionFor(h / 24, S) * 24, S)).toBeCloseTo(h, 6);
    }
  });
  test("same clock hours: winter dark after 6:30 PM and light at 6:30 AM; summer light at 7:30 PM, dark after 9 PM; fall/spring dark after 7:30 PM", () => {
    expect(sunFractionFor(19.5 / 24, WINTER)).toBeGreaterThan(0.75); expect(dayPhase(sunFractionFor(6.5 / 24, WINTER))).not.toBe(DayPhase.Night); expect(sunFractionFor(6.5 / 24, WINTER)).toBeGreaterThan(0.25);
    expect(sunFractionFor(19.5 / 24, SUMMER)).toBeLessThan(0.75); expect(sunFractionFor(21.5 / 24, SUMMER)).toBeGreaterThan(0.75); expect(sunFractionFor(4 / 24, SUMMER)).toBeLessThan(0.25);
    for (const S of [FALL, SPRING]) { expect(sunFractionFor(19 / 24, S)).toBeLessThan(0.75); expect(sunFractionFor(20 / 24, S)).toBeGreaterThan(0.75); }
  });
});

describe("ADR-283 shared world schedule", () => {
  test("timeOfDay carries the seasonal sun fraction; zombie phase follows it", () => {
    const w = new World({ seed: 3 }); installGameplay(w, { role: "server" });
    setSeason(w, 2, 7); setTimeOfDay(w, 4.5); // mid-winter 4:30 AM, before ~5:30 sunrise
    const tod = timeOfDay(w); expect(tod.daylightHours!).toBeLessThan(13.1); expect(tod.sunT!).toBeLessThan(0.25); expect(currentPhaseKey(w)).not.toBe("day");
    setSeason(w, 0, 7); setTimeOfDay(w, 7); expect(timeOfDay(w).daylightHours!).toBeGreaterThan(16.6); expect(currentPhaseKey(w)).not.toBe("night");
  });
  test("new world spawn time is just after that day's dawn in every start season", () => {
    for (const startSeason of [0, 1, 2, 3]) {
      const defs = defaultDefs(); const env = defs.environment as { seasons?: { startSeason: number } };
      if (env.seasons) env.seasons.startSeason = startSeason;
      const w = new World({ seed: 5 }); installGameplay(w, { role: "server", defs });
      const tod = timeOfDay(w); const sunrise = tod.sun!.sunrise;
      expect(tod.hours).toBeGreaterThan(sunrise); expect(tod.hours).toBeLessThan(sunrise + 3);
      expect(tod.sunT!).toBeCloseTo(defs.environment.startTimeOfDay, 2);
      expect(newWorldStartHours(w, defs.environment.startTimeOfDay)).toBeCloseTo(tod.hours, 2);
    }
  });
});
