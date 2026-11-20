/**
 * ADR-465: wind that does things — fire spread fans downwind, boats get a tailwind bonus +
 * leeward drift, and wind dries wet clothes when unsheltered. Smoke drift is render-side
 * (packages/render/test/adr465_wind.test.ts). Wind drying of ground already shipped (ADR-449).
 */
import { describe, it, expect } from "vitest";
import { setTimeOfDay, Weather, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

/** ADR-312 pattern: drive exposureSystem directly (dt = 0.2 s per 4-tick pass), advancing the tick. */
const run = (w: World, secs: number) => { for (let i = 0; i < secs * 5; i++) { G.exposureSystem(w, 0.2); w.tick += 4; } };
/** Day 1 + pinned weather (no rain, so the dry branch runs). */
const pinWeather = (w: World, kind: G.WeatherKind, windSpeed: number) => {
  setTimeOfDay(w, 12, 1);
  Object.assign(w.env(Weather), { kind, intensity: 1, endsAtTick: 0xffffffff, windSpeed, windDir: 0 });
};
const wetnessOf = (w: World, p: Entity) => w.get(p, G.Exposure)!.wetness;

describe("ADR-465 windSpreadFactor (fire fanning)", () => {
  it("calm air spreads evenly (factor 1)", () => {
    expect(G.windSpreadFactor(0, 0, 0, 0, 1, 0)).toBe(1);
    expect(G.windSpreadFactor(0, 1.9, 0, 0, 1, 0)).toBe(1);
  });
  it("downwind doubles, upwind drops to the floor, crosswind is neutral", () => {
    expect(G.windSpreadFactor(0, 12, 0, 0, 1, 0)).toBeCloseTo(2, 10); // east wind, east candidate
    expect(G.windSpreadFactor(0, 12, 0, 0, -1, 0)).toBeCloseTo(0.1, 10); // east wind, west candidate
    expect(G.windSpreadFactor(0, 12, 0, 0, 0, 1)).toBeCloseTo(1, 10); // crosswind
    expect(G.windSpreadFactor(Math.PI / 2, 12, 0, 0, 0, 1)).toBeCloseTo(2, 10); // north wind, north candidate
  });
  it("a strong wind never exceeds the clamp", () => {
    expect(G.windSpreadFactor(0, 30, 0, 0, 1, 0)).toBeCloseTo(2, 10);
    expect(G.windSpreadFactor(0, 30, 0, 0, -1, 0)).toBeCloseTo(0.1, 10);
  });
  it("same-tile candidate is neutral (no direction)", () => {
    expect(G.windSpreadFactor(0, 12, 1, 1, 1, 1)).toBe(1);
  });
});

describe("ADR-465 boatWindBonus", () => {
  it("a paddle boat gets +25% with a full tailwind at windSpeed 12", () => {
    const b = G.boatWindBonus(0, 12, 0, false);
    expect(b.mul).toBeCloseTo(1.25, 10);
    expect(b.driftX).toBeCloseTo(0.24, 10); // 12 * 0.02 leeward, east
    expect(b.driftY).toBeCloseTo(0, 10);
  });
  it("a headwind gives no speed bonus but still drifts the hull leeward", () => {
    const b = G.boatWindBonus(0, 12, Math.PI, false);
    expect(b.mul).toBe(1);
    expect(b.driftX).toBeCloseTo(0.24, 10);
  });
  it("a motorboat gets half the tailwind bonus", () => {
    expect(G.boatWindBonus(0, 12, 0, true).mul).toBeCloseTo(1.125, 10);
  });
  it("a 45° quartering wind still counts as following; a beam wind does not", () => {
    expect(G.boatWindBonus(0, 12, Math.PI / 4 - 0.01, false).mul).toBeGreaterThan(1);
    expect(G.boatWindBonus(0, 12, Math.PI / 2, false).mul).toBe(1);
  });
  it("the bonus scales with wind speed and caps at the reference speed", () => {
    expect(G.boatWindBonus(0, 6, 0, false).mul).toBeCloseTo(1.125, 10);
    expect(G.boatWindBonus(0, 30, 0, false).mul).toBeCloseTo(1.25, 10);
  });
  it("calm air gives no bonus and no drift", () => {
    const b = G.boatWindBonus(0, 0, 0, false);
    expect(b.mul).toBe(1); expect(b.driftX).toBe(0); expect(b.driftY).toBe(0);
  });
});

describe("ADR-465 stepVehicleKinematics windMul", () => {
  it("a tailwind raises the speed target by the wind multiplier", () => {
    const d = G.vehicleDef(G.vehicleDefId("rowboat"))!;
    const mk = () => ({ x: 0, y: 0, speed: 0, heading: 0, drift: 0, steer: 0 });
    const a = mk(), b = mk();
    for (let i = 0; i < 200; i++) {
      G.stepVehicleKinematics(d, a, { x: 1, y: 0, boost: false }, 1, 0.05, 1, 1);
      G.stepVehicleKinematics(d, b, { x: 1, y: 0, boost: false }, 1, 0.05, 1, 1.25);
    }
    expect(b.speed).toBeGreaterThan(a.speed);
    expect(b.speed / a.speed).toBeCloseTo(1.25, 1);
  });
});

describe("ADR-465 wind dries wet clothes", () => {
  // dryWetness bands: 1.0→0.7 at 0.25× the 0.02/s base rate, 0.7→0.3 at 0.5×. 60 s calm dries 0.30
  // (to 0.70); wind 12 gives 1 + 0.5*12/12 = 1.5× the rate, so 60 s windy crosses the top band
  // in 40 s and dries 0.30 more in the middle band (to 0.40).
  it("a soaked player dries faster in a strong wind than in calm air", () => {
    const windy = makeWorld(); const wp = G.spawnPlayer(windy, { x: 0, y: 0 });
    const calm = makeWorld(); const cp = G.spawnPlayer(calm, { x: 0, y: 0 });
    pinWeather(windy, G.WeatherKind.Windy, 12);
    pinWeather(calm, G.WeatherKind.Clear, 0);
    windy.setField(wp, G.Exposure, "wetness", 1);
    calm.setField(cp, G.Exposure, "wetness", 1);
    run(windy, 60); run(calm, 60);
    expect(wetnessOf(windy, wp)).toBeCloseTo(0.4, 1);
    expect(wetnessOf(calm, cp)).toBeCloseTo(0.7, 1);
    expect(wetnessOf(windy, wp)).toBeLessThan(wetnessOf(calm, cp));
  });
  it("no wind, no extra drying (control: calm air dries at the base rate)", () => {
    const w = makeWorld(); const p = G.spawnPlayer(w, { x: 0, y: 0 });
    pinWeather(w, G.WeatherKind.Clear, 0);
    w.setField(p, G.Exposure, "wetness", 1);
    run(w, 60);
    expect(wetnessOf(w, p)).toBeCloseTo(0.7, 1);
  });
});
