/**
 * ADR-471: water you can trust — river risk + wells run low.
 *
 * River risk: drinking straight from a tile (or sipping a raw container) is no longer one flat
 * rate — the chance depends on the water feature under the drinker (river 0.05, lake/pond the
 * old flat 0.025, elevated/great lake 0.01, anything else the flat rate). Wells: a well piece
 * holds 12 sips; rain recharges +1 per 60 s of rain, past the 2-day drought clock a well loses
 * 2 sips per further dry day (one drain per dry day, never a catch-up lump); drawing at a well
 * swaps a raw container for its well variant, and well water never rolls dysentery.
 *
 * Tile kinds are found by scanning the seed-42 layout (one shared layout per scan), not by
 * hardcoding coordinates — the siting is deterministic, the coordinates are not promised.
 */
import { describe, expect, it } from "vitest";
import { timeOfDay, Transform, type Entity, type World } from "@engine/core";
import { waterFeatureAt, waterFeatureLayout, type WaterFeatureKind } from "@engine/world";
import * as G from "../src/index.js";
import { collect, makeWorld, steps } from "./helpers.js";

const d = G.defaultDefs();
const id = (k: string): number => d.itemId(k);
const slotOf = (w: World, p: Entity, item: number): number => { const v = G.readSlots(w, p); for (let i = 0; i < v.slotCount; i++) if (v.item(i) === item && v.count(i)) return i; return -1; };
const use = (w: World, p: Entity, slot: number): void => { G.setIntent(w, p, { action: G.IntentAction.Use, slot }); w.step(1 / 20); G.setIntent(w, p, { action: G.IntentAction.None }); };
const mk = (w: World, pid: number, x = 0, y = 0): Entity => G.spawnPlayer(w, { x, y, clientId: pid });

/** First tile of each water kind on seed 42, found in a single scan of the starter region. */
const findTiles = (): Record<WaterFeatureKind, [number, number] | undefined> => {
  const layout = waterFeatureLayout(42);
  const found = {} as Record<WaterFeatureKind, [number, number] | undefined>;
  for (let y = -256; y <= 256 && Object.keys(found).length < 7; y++) {
    for (let x = -256; x <= 256; x++) {
      const k = waterFeatureAt(42, x, y, layout);
      if (!found[k]) found[k] = [x, y];
    }
  }
  return found;
};
const TILES = findTiles();

/** Defs where every disease roll is deterministic: river/lake/isolated chances as given, the rest 0. */
const testDefs = (river: number, lake: number, isolated: number): G.GameDefs => {
  const raw = JSON.parse(JSON.stringify(G.DEFAULT_RAW_DEFS)) as G.RawDefs;
  raw.diseases.causes = { rawMeatChance: 0, sickFoodChance: 0, rottenFoodChance: 0, rawWaterChance: lake, woundChance: 0, riverWaterChance: river, isolatedWaterChance: isolated };
  return G.loadDefs(raw, { lock: G.DEFAULT_ID_LOCK });
};

/** Terrain mock: water only at the given tile (the drinker's tile), land everywhere else. */
const wetAt = (w: World, x: number, y: number): void => w.setResource(G.TerrainRes, { tileAt: (tx: number, ty: number) => (tx === x && ty === y ? 1 : 3), heightAt: () => 0 });

const placeWell = (w: World, x: number, y: number): Entity => {
  const e = w.create();
  w.add(e, Transform, { x, y }).add(e, G.BuildPiece, { type: d.pieceId("well") });
  G.indexEntity(w, e);
  return e;
};

/** A fresh container arrives full (durability = sips); empty it via the slots view so the next Use refills / draws. */
const emptySlot = (w: World, p: Entity, slot: number): void => {
  const v = G.readSlots(w, p);
  v.put(slot, v.item(slot), v.count(slot), v.created(slot), 0);
  G.writeSlots(w, p, v, G.gameplayDefs(w));
};

describe("ADR-471 river risk", () => {
  it("drinkWaterChance: river 0.05, lake/pond the old flat rate, isolated lakes 0.01, land falls back", () => {
    const w = makeWorld();
    const causes = d.diseaseTuning.causes;
    const river = TILES.river!, lake = TILES.lake!, pond = TILES.pond!, elevated = TILES.elevatedLake!;
    expect(G.drinkWaterChance(w, river[0] + 0.5, river[1] + 0.5)).toBe(causes.riverWaterChance);
    expect(causes.riverWaterChance).toBe(0.05);
    expect(G.drinkWaterChance(w, lake[0] + 0.5, lake[1] + 0.5)).toBe(causes.rawWaterChance);
    expect(G.drinkWaterChance(w, pond[0] + 0.5, pond[1] + 0.5)).toBe(causes.rawWaterChance);
    expect(causes.rawWaterChance).toBe(0.025);
    expect(G.drinkWaterChance(w, elevated[0] + 0.5, elevated[1] + 0.5)).toBe(causes.isolatedWaterChance);
    expect(causes.isolatedWaterChance).toBe(0.01);
    // no great lake sits within the starter region on seed 42 — it shares the isolated branch
    // (`elevatedLake || greatLake` in drinkWaterChance), which the elevated lake above covers.
    expect(G.drinkWaterChance(w, 0.5, 0.5)).toBe(causes.rawWaterChance); // starter tile: no feature, flat rate
  });

  it("tile drink: a river contracts dysentery, a lake and an isolated lake do not (river chance 1, rest 0)", () => {
    const river = TILES.river!, lake = TILES.lake!, elevated = TILES.elevatedLake!;
    for (const [tx, ty, sick] of [[river[0], river[1], true], [lake[0], lake[1], false], [elevated[0], elevated[1], false]] as const) {
      const w = makeWorld({ defs: testDefs(1, 0, 0) });
      const p = mk(w, 1, tx + 0.5, ty + 0.5);
      wetAt(w, tx, ty);
      w.set(p, G.Survival, { thirst: 20 });
      use(w, p, G.NO_SLOT);
      expect(G.hasDisease(w, p, "dysentery")).toBe(sick);
      expect(w.get(p, G.Survival)!.thirst).toBeGreaterThan(20);
    }
  });

  it("tile drink: an isolated lake contracts when its chance is 1, a river does not", () => {
    const river = TILES.river!, elevated = TILES.elevatedLake!;
    for (const [tx, ty, sick] of [[elevated[0], elevated[1], true], [river[0], river[1], false]] as const) {
      const w = makeWorld({ defs: testDefs(0, 0, 1) });
      const p = mk(w, 1, tx + 0.5, ty + 0.5);
      wetAt(w, tx, ty);
      use(w, p, G.NO_SLOT);
      expect(G.hasDisease(w, p, "dysentery")).toBe(sick);
    }
  });

  it("well-water defs: raw containers map to well variants that are safe and reuse the raw sprite", () => {
    for (const [rawKey, wellKey] of [["waterskin", "well_waterskin"], ["water_flask", "well_water_flask"], ["canteen", "well_canteen"], ["water_bottle", "well_water_bottle"]] as const) {
      const rawDef = d.items.get(id(rawKey))!;
      const wellDef = d.items.get(id(wellKey))!;
      expect(rawDef.wellTarget).toBe(id(wellKey));
      expect(wellDef.safeWater).toBe(true);
      expect(wellDef.wellSource).toBe(id(rawKey));
      expect(wellDef.sips).toBe(rawDef.sips);
      expect(wellDef.spriteKey).toBe(rawKey); // no new art: the well variant draws the raw container
      expect(wellDef.boiled).toBe(false);
    }
  });
});

describe("ADR-471 wells", () => {
  it("drawing at a well swaps a raw container for its well variant and drops the level by sips drawn", () => {
    const w = makeWorld();
    const p = mk(w, 1, 0.5, 0.5);
    G.addItem(w, p, id("waterskin"), 1);
    const slot = slotOf(w, p, id("waterskin"));
    expect(slot).toBeGreaterThanOrEqual(0);
    emptySlot(w, p, slot);
    expect(G.readSlots(w, p).durability(slot)).toBe(0);
    const well = placeWell(w, 1.5, 0.5);
    expect(G.wellLevel(w, well)).toBe(12); // lazy-attached at full
    const drunk = collect(w, G.WaterDrunk);
    use(w, p, slot);
    expect(G.readSlots(w, p).item(slot)).toBe(id("well_waterskin"));
    expect(G.readSlots(w, p).durability(slot)).toBe(3);
    expect(G.wellLevel(w, well)).toBe(9);
    expect(drunk.length).toBe(1);
    expect(drunk[0]!.sips).toBe(3);
  });

  it("drawing at a well leaves a boiled container boiled (its water is already safe)", () => {
    const w = makeWorld();
    const p = mk(w, 1, 0.5, 0.5);
    G.addItem(w, p, id("boiled_waterskin"), 1);
    const slot = slotOf(w, p, id("boiled_waterskin"));
    emptySlot(w, p, slot);
    const well = placeWell(w, 1.5, 0.5);
    use(w, p, slot);
    expect(G.readSlots(w, p).item(slot)).toBe(id("boiled_waterskin"));
    expect(G.readSlots(w, p).durability(slot)).toBe(3);
    expect(G.wellLevel(w, well)).toBe(9);
  });

  it("a dry well fails Empty and draws nothing", () => {
    const w = makeWorld();
    const p = mk(w, 1, 0.5, 0.5);
    G.addItem(w, p, id("waterskin"), 1);
    const slot = slotOf(w, p, id("waterskin"));
    emptySlot(w, p, slot);
    const well = placeWell(w, 1.5, 0.5);
    G.setWellLevel(w, well, 0);
    const fails = collect(w, G.ConsumeFailed);
    use(w, p, slot);
    expect(fails.at(-1)!.reason).toBe(G.ConsumeFail.Empty);
    expect(G.readSlots(w, p).item(slot)).toBe(id("waterskin"));
    expect(G.readSlots(w, p).durability(slot)).toBe(0);
    expect(G.wellLevel(w, well)).toBe(0);
  });

  it("no well in reach fails Empty (the old behaviour on dry land)", () => {
    const w = makeWorld();
    const p = mk(w, 1, 0.5, 0.5);
    G.addItem(w, p, id("waterskin"), 1);
    const slot = slotOf(w, p, id("waterskin"));
    emptySlot(w, p, slot);
    placeWell(w, 50.5, 50.5); // far outside container reach
    const fails = collect(w, G.ConsumeFailed);
    use(w, p, slot);
    expect(fails.at(-1)!.reason).toBe(G.ConsumeFail.Empty);
  });

  it("rain recharges a well +1 sip per 60 s of rain, capped at capacity; under 60 s recharges nothing", () => {
    const w = makeWorld();
    const well = placeWell(w, 10.5, 10.5);
    const low = placeWell(w, 20.5, 20.5);
    G.setWellLevel(w, well, 12);
    G.setWellLevel(w, low, 10);
    G.emit(w, G.WeatherChanged, { from: G.WeatherKind.Clear, to: G.WeatherKind.Rain, intensity: 0.5, ticks: 1200 });
    w.step(1 / 20);
    w.tick += 1200; // 60 s of rain
    G.emit(w, G.WeatherChanged, { from: G.WeatherKind.Rain, to: G.WeatherKind.Clear, intensity: 0, ticks: 1200 });
    w.step(1 / 20);
    expect(G.wellLevel(w, well)).toBe(12); // full stays full
    expect(G.wellLevel(w, low)).toBe(11);
    // a second, 30 s shower recharges nothing (floor(30 / 60) = 0)
    G.emit(w, G.WeatherChanged, { from: G.WeatherKind.Clear, to: G.WeatherKind.Rain, intensity: 0.5, ticks: 600 });
    w.step(1 / 20);
    w.tick += 600;
    G.emit(w, G.WeatherChanged, { from: G.WeatherKind.Rain, to: G.WeatherKind.Clear, intensity: 0, ticks: 600 });
    w.step(1 / 20);
    expect(G.wellLevel(w, low)).toBe(11);
  });

  it("past the 2-day drought clock a well loses 2 sips per further dry day, one drain per day", () => {
    const w = makeWorld();
    const well = placeWell(w, 10.5, 10.5);
    expect(G.wellLevel(w, well)).toBe(12);
    const day = timeOfDay(w).dayLengthTicks;
    expect(day).toBeGreaterThan(0);
    // the last rain ended now (the dry clock starts here)
    G.emit(w, G.WeatherChanged, { from: G.WeatherKind.Rain, to: G.WeatherKind.Clear, intensity: 0, ticks: 1200 });
    w.step(1 / 20);
    const t0 = w.tick;
    w.tick = t0 + 2 * day + 1;
    steps(w, 3);
    expect(G.wellLevel(w, well)).toBe(10);
    steps(w, 100); // same dry day: no second drain
    expect(G.wellLevel(w, well)).toBe(10);
    w.tick = t0 + 3 * day + 1;
    steps(w, 3);
    expect(G.wellLevel(w, well)).toBe(8);
  });

  it("well water never rolls dysentery; raw water does (every water chance 1)", () => {
    const w = makeWorld({ defs: testDefs(1, 1, 1) });
    const p = mk(w, 1, 0.5, 0.5);
    // fill a well variant at the well, then drink one sip of it
    G.addItem(w, p, id("waterskin"), 1);
    const slot = slotOf(w, p, id("waterskin"));
    emptySlot(w, p, slot);
    placeWell(w, 1.5, 0.5);
    use(w, p, slot);
    expect(G.readSlots(w, p).item(slot)).toBe(id("well_waterskin"));
    steps(w, G.CONSUME_COOLDOWN_TICKS + 1);
    use(w, p, slot);
    expect(G.hasDisease(w, p, "dysentery")).toBe(false);
    // control: a raw waterskin filled at open water, drunk the same way, does contract
    const w2 = makeWorld({ defs: testDefs(1, 1, 1) });
    const p2 = mk(w2, 1, 2.5, 0.5);
    wetAt(w2, 2, 0);
    G.addItem(w2, p2, id("waterskin"), 1);
    const slot2 = slotOf(w2, p2, id("waterskin"));
    emptySlot(w2, p2, slot2);
    use(w2, p2, slot2); // fills with raw water
    expect(G.readSlots(w2, p2).item(slot2)).toBe(id("waterskin"));
    expect(G.readSlots(w2, p2).durability(slot2)).toBe(3);
    steps(w2, G.CONSUME_COOLDOWN_TICKS + 1);
    use(w2, p2, slot2);
    expect(G.hasDisease(w2, p2, "dysentery")).toBe(true);
  });

  it("refilling a well container at untreated water reverts it to its raw variant", () => {
    const w = makeWorld();
    const p = mk(w, 1, 2.5, 0.5);
    wetAt(w, 2, 0);
    G.addItem(w, p, id("well_waterskin"), 1);
    const slot = slotOf(w, p, id("well_waterskin"));
    emptySlot(w, p, slot); // a fresh container arrives full; empty it so the next Use refills
    expect(G.readSlots(w, p).durability(slot)).toBe(0);
    use(w, p, slot); // refill at open water
    expect(G.readSlots(w, p).item(slot)).toBe(id("waterskin"));
    expect(G.readSlots(w, p).durability(slot)).toBe(3);
  });
});
