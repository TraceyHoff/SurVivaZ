// ADR-472: cold that bites — wet x wind synergy in the felt formula, a faster body-temperature
// drain when cold + soaked + gale coincide, and the ADR-458 wiring fix (the hot-meal Insulation
// buff was written at eat time and never evaluated, so hot meals did nothing in live play).
// No new damage channel: the bite only speeds arrival at the freezing tier.
import { describe, expect, it } from "vitest";
import { setSeason, setTimeOfDay, Weather, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

const d = G.defaultDefs();
const id = (k: string): number => d.itemId(k);
const env = d.environment, vt = d.vitals;

/** Pin the weather (no transition: endsAtTick never ends, so the wind never re-rolls). */
const pinWeather = (w: World, kind: number, windDir: number, windSpeed: number): void => {
  Object.assign(w.env(Weather), { kind, intensity: 1, endsAtTick: 0xffffffff, windSpeed, windDir });
};
/** Naked player outdoors (no worn insulation, no shelter) with a pinned wetness. */
const naked = (w: World, wet: number): Entity => {
  const p = G.spawnPlayer(w, { x: 0, y: 0 });
  w.set(p, G.Exposure, { wetness: wet, feltTemp: 20 });
  return p;
};
const felt = (w: World, p: Entity): number => w.getField(p, G.Exposure, "feltTemp")!;
const wetness = (w: World, p: Entity): number => w.getField(p, G.Exposure, "wetness")!;

describe("ADR-472 wet x wind synergy", () => {
  it("soaked in a gale loses windChillPerSpeed * sqrt(wind) * wet * 0.5 on top of the additive terms", () => {
    const w = makeWorld();
    pinWeather(w, G.WeatherKind.Clear, 0, 12);
    const p = naked(w, 0);
    G.exposureSystem(w, 0.2);
    const feltDry = felt(w, p), wetDry = wetness(w, p);
    w.set(p, G.Exposure, { wetness: 1 });
    G.exposureSystem(w, 0.2);
    const feltWet = felt(w, p), wetWet = wetness(w, p);
    // Same world, same ambient, same wind, no insulation, no fire: the felt delta isolates the
    // wet terms — the additive wet chill plus the new synergy term.
    const expected = (env.wetChill + env.windChillPerSpeed * Math.sqrt(12) * env.windWetSynergyMul) * (wetWet - wetDry);
    expect(feltDry - feltWet).toBeCloseTo(expected, 1);
    expect(expected).toBeGreaterThan(env.wetChill + 2); // the synergy adds ~2.6 C, not ~0
  });
  it("dry in the same gale loses only the wind term (no synergy without wetness)", () => {
    const w = makeWorld();
    pinWeather(w, G.WeatherKind.Clear, 0, 12);
    const p = naked(w, 0);
    G.exposureSystem(w, 0.2);
    const feltWindy = felt(w, p);
    pinWeather(w, G.WeatherKind.Clear, 0, 0);
    G.exposureSystem(w, 0.2);
    const feltCalm = felt(w, p);
    expect(feltCalm - feltWindy).toBeCloseTo(env.windChillPerSpeed * Math.sqrt(12), 1);
  });
  it("the tuning lives in environment.json", () => {
    expect(env.windWetSynergyMul).toBe(0.5);
    expect(env.windChillPerSpeed).toBe(1.5);
    expect(env.wetChill).toBe(6);
  });
});

describe("ADR-472 ADR-458 wiring fix: a hot meal actually warms the eater", () => {
  /** Winter noon (ambient below freezing) + gale; the player eats a hot meal by a lit fire, or not. */
  const mealWorld = (eat: boolean): { w: World; p: Entity } => {
    const w = makeWorld();
    setSeason(w, 2, 0); setTimeOfDay(w, 12, 1); // winter, day 1, noon: ambient < 0 C
    pinWeather(w, G.WeatherKind.Clear, 0, 12);
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    G.spawnStation(w, G.StationKind.Campfire, 2, 0, { burnSeconds: 600 });
    steps(w, 5); // let the emitter index pick the fire up
    if (eat) {
      G.addItem(w, p, id("cooked_meat"), 1);
      w.set(p, G.Equipment, { mainHandSlot: 0, mainHandItem: id("cooked_meat") });
      G.setIntent(w, p, { action: G.IntentAction.Use, slot: 0 });
      w.step(1 / 20);
    }
    return { w, p };
  };
  it("eating a hot meal by the fire raises felt by the +5 Insulation buff in the cold", () => {
    const a = mealWorld(true), b = mealWorld(false);
    expect(G.ambientTemperature(a.w, 0, 0)).toBeLessThan(vt.comfortMin); // cold enough for insulation to matter
    G.exposureSystem(a.w, 0.2); G.exposureSystem(b.w, 0.2);
    // Same seed, same weather, same fire heat in both worlds: the delta is the buff alone.
    expect(felt(a.w, a.p) - felt(b.w, b.p)).toBeCloseTo(vt.hotMeals.insulation, 1);
  });
  it("the buff still expires after 120 s (the fix wires evaluation, not permanence)", () => {
    const { w, p } = mealWorld(true);
    G.exposureSystem(w, 0.2);
    const feltWarm = felt(w, p);
    steps(w, 121 * 20);
    G.exposureSystem(w, 0.2);
    expect(felt(w, p)).toBeLessThan(feltWarm - 4);
  });
});

describe("ADR-472 cold bites: faster body-temperature drain", () => {
  /** Body 37 C, felt + wetness pinned, wind pinned; run vitalsSystem for 10 s and read the drop. */
  const dropAfter10s = (feltTemp: number, wet: number, windSpeed: number): number => {
    const w = makeWorld();
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    w.set(p, G.Exposure, { wetness: wet, feltTemp });
    w.set(p, G.Survival, { bodyTemp: 37 });
    pinWeather(w, G.WeatherKind.Clear, 0, windSpeed);
    for (let n = 0; n < 10; n++) { G.vitalsSystem(w, 1); w.tick++; }
    return 37 - w.getField(p, G.Survival, "bodyTemp")!;
  };
  it("cold + soaked + gale drains 1.5x faster than the same cold without the third factor", () => {
    const bite = dropAfter10s(0, 1, 12); // felt 0 (< 10), wet 1 (>= 0.7), wind 12 (>= 8)
    const noWind = dropAfter10s(0, 1, 0);
    const dry = dropAfter10s(0, 0, 12);
    expect(bite).toBeCloseTo((vt.comfortMin - 0) * vt.bodyTempChangePerDegreePerSec * 1.5 * 10, 2);
    expect(noWind).toBeCloseTo((vt.comfortMin - 0) * vt.bodyTempChangePerDegreePerSec * 10, 2);
    expect(dry).toBeCloseTo(noWind, 2);
    expect(bite / noWind).toBeCloseTo(1.5, 1);
  });
  it("the bite needs all three conditions: warm felt, dry body, or calm air each drain at the base rate", () => {
    expect(dropAfter10s(0, 0.69, 12)).toBeCloseTo(dropAfter10s(0, 1, 0), 2); // just under the wet gate
    expect(dropAfter10s(0, 1, 7)).toBeCloseTo(dropAfter10s(0, 1, 0), 2); // just under the wind gate
  });
  it("the bite adds no damage channel: 10 s in the bite leaves hp untouched", () => {
    const w = makeWorld();
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    w.set(p, G.Exposure, { wetness: 1, feltTemp: 0 });
    w.set(p, G.Survival, { bodyTemp: 37 });
    pinWeather(w, G.WeatherKind.Clear, 0, 12);
    for (let n = 0; n < 10; n++) { G.vitalsSystem(w, 1); w.tick++; }
    expect(w.getField(p, G.Health, "hp")).toBe(100); // body 35.8, still above the freezing tier
  });
  it("the tuning lives in vitals.json and the dead coldBuffBelow knob is wired", () => {
    expect(vt.coldDrain).toEqual({ wetMin: 0.7, windMin: 8, mul: 1.5 });
    expect(env.coldBuffBelow).toBe(10);
  });
});
