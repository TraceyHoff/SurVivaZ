// Heat waves, ceiling/wall connection, enclosed-building protection, wall insulation.
import { describe, expect, it } from "vitest";
import { setSeason, setTimeOfDay, Weather, World } from "@engine/core";
import {
  addItem, BuildFail, defaultDefs, Exposure, exposureSystem, placePiece, snapPlacement, spawnPlayer,
  validatePlacement, wallInsulationAt, wallInsulationOf, WALL_INSULATION_PER_TIER, WeatherKind,
} from "../src/index.js";
import { makeWorld, steps, spawnLearned, DT, ensureClaim } from "./helpers.js";
import { ambientTemperature } from "../src/systems/environment.js";

const d = defaultDefs();
const id = (k: string) => d.pieceId(k);
type Ent = ReturnType<typeof spawnPlayer>;
function snap(w: World, key: string, x: number, y: number, o: { level?: number; rot?: number; tier?: number } = {}) {
  return snapPlacement(w, { piece: id(key), x, y, level: o.level ?? 0, rot: o.rot ?? 0, tier: o.tier ?? 1, variant: 0 });
}
function place(w: World, b: Ent, key: string, x: number, y: number, o: { level?: number; rot?: number; tier?: number } = {}) {
  const sn = snap(w, key, x, y, o); if (typeof sn === "number") throw new Error(`snap ${key} ${sn}`);
  return placePiece(w, b, sn, { pay: false });
}

describe("heat waves: frequency and timing", () => {
  it("summer heat is rarer and shorter than before (weight 8, max duration 240 s)", () => {
    const env = defaultDefs().environment;
    const summer = env.seasons!.seasons[0]!;
    const heat = summer.weather.find((w) => w.kind === WeatherKind.Heat)!;
    const clear = summer.weather.find((w) => w.kind === WeatherKind.Clear)!;
    expect(heat.weight).toBeLessThan(clear.weight);
    const base = env.weather.find((w) => w.kind === WeatherKind.Heat)!;
    expect(base.durationSeconds[1]).toBeLessThanOrEqual(240);
  });
  it("no heat wave rolls on the first day of summer", () => {
    const w = makeWorld({ liveWeather: true, dayLengthTicks: 1_000_000 }, 7);
    setSeason(w, 0, 0); setTimeOfDay(w, 12);
    const seen = new Set<number>();
    for (let i = 0; i < 300; i++) { w.env(Weather).endsAtTick = 0; steps(w, 1); seen.add(w.env(Weather).kind); }
    expect(seen.has(WeatherKind.Heat)).toBe(false);
  });
  it("heat waves can still roll later in summer", () => {
    const w = makeWorld({ liveWeather: true, dayLengthTicks: 1_000_000 }, 7);
    setSeason(w, 0, 1.5); setTimeOfDay(w, 12);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) { w.env(Weather).endsAtTick = 0; steps(w, 1); seen.add(w.env(Weather).kind); }
    expect(seen.has(WeatherKind.Heat)).toBe(true);
  });
});

describe("ceilings require a wall connection", () => {
  it("a roof on a pillar alone is rejected, a roof on walls is accepted, and a roof joined to a wall-backed roof is accepted", () => {
    const w = makeWorld(); const b = spawnLearned(w, { x: 5, y: 5 }); ensureClaim(w, b, 3, 8);
    // Pillar-only roof: foundation + pillar, no wall.
    place(w, b, "foundation", 5.5, 5.5);
    place(w, b, "pillar", 5.5, 5.5);
    const pillarRoof = snap(w, "roof_flat", 5.5, 5.5, { level: 1 });
    expect(typeof pillarRoof === "number" ? pillarRoof : validatePlacement(w, b, pillarRoof)).toBe(BuildFail.NoSupport);
    // Wall-backed roof: foundations + a wall on the east edge, then the roof over that tile.
    place(w, b, "foundation", 6.5, 5.5);
    place(w, b, "wall", 7, 5.5);
    for (const k of d.tiers[1]!.cost) addItem(w, b, k.item, 100);
    const wallRoof = snap(w, "roof_flat", 6.5, 5.5, { level: 1 });
    expect(typeof wallRoof === "number" ? wallRoof : validatePlacement(w, b, wallRoof)).toBe(0);
    place(w, b, "roof_flat", 6.5, 5.5, { level: 1 });
    // Interior roof tile: no wall below its own edges, but it joins the wall-backed roof cluster.
    const innerRoof = snap(w, "roof_flat", 5.5, 5.5, { level: 1 });
    expect(typeof innerRoof === "number" ? innerRoof : validatePlacement(w, b, innerRoof)).toBe(0);
    // An upper floor follows the same rule (ADR-315: away from b's now radius-32 claim, which would answer NoPrivilege first).
    const loneFloor = snap(w, "floor", 60.5, 60.5, { level: 1 });
    expect(typeof loneFloor === "number" ? loneFloor : validatePlacement(w, spawnLearned(w, { x: 60, y: 60 }), loneFloor)).toBe(BuildFail.NoSupport);
  });
});

describe("enclosed buildings and wall insulation", () => {
  /** A 1-tile room at (10,10): walls on all 4 edges, roof at level 1, player inside. */
  function room(w: World, b: Ent, tier = 1) {
    place(w, b, "foundation", 10.5, 10.5);
    place(w, b, "wall", 10.5, 10, { tier }); place(w, b, "wall", 10.5, 11, { tier });
    place(w, b, "wall", 10, 10.5, { tier }); place(w, b, "wall", 11, 10.5, { tier });
    place(w, b, "roof_flat", 10.5, 10.5, { level: 1, tier });
  }
  it("inside a fully enclosed roofed room, felt temperature never leaves the comfort band in a heat wave", () => {
    const w = makeWorld({ liveWeather: true }); const b = spawnLearned(w, { x: 10.5, y: 10.5 });
    room(w, b);
    const p = spawnLearned(w, { x: 10.5, y: 10.5 });
    setSeason(w, 0, 1.5); setTimeOfDay(w, 14);
    Object.assign(w.env(Weather), { kind: WeatherKind.Heat, intensity: 1, endsAtTick: 0xffffffff });
    const ambient = ambientTemperature(w, 10.5, 10.5);
    expect(ambient).toBeGreaterThan(32); // the test is only meaningful in real heat
    exposureSystem(w, DT);
    const felt = w.getField(p, Exposure, "feltTemp")!;
    expect(felt).toBeLessThanOrEqual(32); expect(felt).toBeGreaterThanOrEqual(8);
  });
  it("wall insulation rises with tier and is halved by a window", () => {
    expect(WALL_INSULATION_PER_TIER[1]!).toBeGreaterThan(WALL_INSULATION_PER_TIER[0]!);
    expect(WALL_INSULATION_PER_TIER[2]!).toBeGreaterThan(WALL_INSULATION_PER_TIER[1]!);
    expect(WALL_INSULATION_PER_TIER[3]!).toBeGreaterThan(WALL_INSULATION_PER_TIER[2]!);
    expect(WALL_INSULATION_PER_TIER[4]!).toBeGreaterThan(WALL_INSULATION_PER_TIER[3]!);
    const wall = d.pieces.get(id("wall"))!; const win = d.pieces.get(id("wall_window"))!;
    expect(wallInsulationOf(win, 1, true)).toBe(wallInsulationOf(wall, 1, false) / 2);
    // Around a room, swapping one solid wall for a window wall lowers the insulation.
    const w1 = makeWorld(); const b1 = spawnLearned(w1, { x: 10.5, y: 10.5 }); room(w1, b1);
    const w2 = makeWorld(); const b2 = spawnLearned(w2, { x: 10.5, y: 10.5 });
    place(w2, b2, "foundation", 10.5, 10.5);
    place(w2, b2, "wall_window", 10.5, 10); place(w2, b2, "wall", 10.5, 11);
    place(w2, b2, "wall", 10, 10.5); place(w2, b2, "wall", 11, 10.5);
    place(w2, b2, "roof_flat", 10.5, 10.5, { level: 1 });
    expect(wallInsulationAt(w1, 10.5, 10.5, 0)).toBeGreaterThan(wallInsulationAt(w2, 10.5, 10.5, 0));
    // And a higher tier room insulates better than a lower tier one.
    const w3 = makeWorld(); const b3 = spawnLearned(w3, { x: 10.5, y: 10.5 }); room(w3, b3, 2);
    expect(wallInsulationAt(w3, 10.5, 10.5, 0)).toBeGreaterThan(wallInsulationAt(w1, 10.5, 10.5, 0));
  });
});
