/**
 * ADR-488: humidity that matters. Humidity was already computed by climateAt and then ignored by
 * everything. Now it does two things, both inside passes that already run:
 * (1) clothes drying (exposureSystem, every 4 ticks) is multiplied by max(0.25, 1 - humidity) —
 * clothes only in v1, ground drying is untouched; (2) spoilage decay is multiplied by (1 + humidity),
 * up to 2x in the dampest places, reading temperature and humidity from one climateAt sample per
 * holder. Holders with no position use the 0.5 band default. Humidity is band base + wet-weather
 * bonus only — a place effect, not a season effect.
 */
import { describe, it, expect } from "vitest";
import { Transform, type Entity, type World } from "@engine/core";
import { installClimate } from "@engine/world";
import * as G from "../src/index.js";
import { humidityDryMul, humiditySpoilMul } from "../src/systems/environment.js";
import { makeWorld, spawnLearned, steps, ensureClaim } from "./helpers.js";

const d = G.defaultDefs();
const piece = (k: string) => d.pieces.get(d.pieceId(k))!;

/** World whose climate source reports `humidity` at every tile (temperature 20 everywhere). */
function humidWorld(humidity: number): World {
  const w = makeWorld();
  installClimate(
    w,
    { baseClimate: () => ({ temperature: 20, humidity, altitude: 0 }) },
    G.gameplayClimateModel(d.environment, w),
  );
  return w;
}

function driedWetness(w: World, ticks: number): number {
  const p = G.spawnPlayer(w, { x: 0, y: 0 });
  w.setField(p, G.Exposure, "wetness", 1);
  steps(w, ticks);
  return w.getField(p, G.Exposure, "wetness")!;
}

const placeBox = (w: World, p: Entity, x: number, y: number): Entity => {
  ensureClaim(w, p, x - 3, y + 3);
  const def = piece("basic_storage_box");
  for (const c of G.pieceCost(d, def, def.fixedTier)) G.addItem(w, p, c.item, c.count);
  const r = G.tryPlace(w, p, { piece: def.id, x, y, level: 0, rot: 0, tier: def.fixedTier, variant: 0 });
  expect(r.ok, "basic_storage_box places").toBe(true);
  return (r as { piece: Entity }).piece;
};
const storageOf = (w: World, p: Entity): Entity => G.resolveAttachment(w, p, G.AttachKind.Storage)!;
const spoilMulOf = (w: World, c: Entity): number => w.getField(c, G.Container, "spoilMul") ?? 1;

describe("ADR-488 humidity that matters", () => {
  it("formulas: drying is floored at a quarter, spoilage runs up to twice as fast", () => {
    expect(humidityDryMul(0)).toBe(1);
    expect(humidityDryMul(0.35)).toBeCloseTo(0.65, 10);
    expect(humidityDryMul(0.5)).toBe(0.5);
    expect(humidityDryMul(0.9)).toBe(0.25); // floored, not 0.1
    expect(humidityDryMul(1)).toBe(0.25);
    expect(humiditySpoilMul(0)).toBe(1);
    expect(humiditySpoilMul(0.5)).toBe(1.5);
    expect(humiditySpoilMul(0.9)).toBeCloseTo(1.9, 10);
  });

  it("damp air dries clothes slower: dry hills beat the default band beat the wet lowlands", () => {
    const dry = driedWetness(humidWorld(0.35), 800);
    const mid = driedWetness(makeWorld(), 800); // no ClimateRes: the 0.5 band default
    const wet = driedWetness(humidWorld(0.9), 800);
    expect(dry).toBeLessThan(mid);
    expect(mid).toBeLessThan(wet);
    expect(wet - dry).toBeGreaterThan(0.05);
    expect(wet).toBeGreaterThan(0.9); // still soaked after 40 s in the lowlands
  });

  it("the drying floor: humidity 1.0 dries exactly as fast as humidity 0.9 — and slower than the 0.5 default", () => {
    const at09 = driedWetness(humidWorld(0.9), 800);
    const at10 = driedWetness(humidWorld(1.0), 800);
    const mid = driedWetness(makeWorld(), 800); // no ClimateRes: the 0.5 band default
    expect(at10).toBeCloseTo(at09, 6); // both hit the 0.25 floor
    expect(at10).toBeGreaterThan(mid); // the floor still damps: 1.0 is slower than 0.5, not equal
  });

  it("damp storage rots food faster: two identical boxes, one in the lowlands, one on dry ground", () => {
    const w = makeWorld();
    installClimate(
      w,
      { baseClimate: (tx: number) => ({ temperature: 20, humidity: tx < 2 ? 0.9 : 0.35, altitude: 0 }) },
      G.gameplayClimateModel(d.environment, w),
    );
    const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
    steps(w, 1);
    const damp = storageOf(w, placeBox(w, p, 1.5, 0.5));
    const dry = storageOf(w, placeBox(w, p, 3.5, 0.5));
    steps(w, 60); // 3 spoilage passes: the multiplier re-bases
    const ratio = spoilMulOf(w, damp) / spoilMulOf(w, dry);
    // (1 + 0.9) / (1 + 0.35) = 1.407…; the shared temperature cancels in the ratio.
    expect(ratio).toBeGreaterThan(1.38);
    expect(ratio).toBeLessThan(1.43);
  });

  it("without a ClimateRes both boxes read the 0.5 default and spoil at the same rate", () => {
    const w = makeWorld();
    const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
    steps(w, 1);
    const a = storageOf(w, placeBox(w, p, 1.5, 0.5));
    const b = storageOf(w, placeBox(w, p, 3.5, 0.5));
    steps(w, 60);
    expect(spoilMulOf(w, a) / spoilMulOf(w, b)).toBeCloseTo(1, 2);
  });
});
