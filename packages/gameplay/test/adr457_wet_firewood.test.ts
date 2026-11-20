/**
 * ADR-457: wet firewood — wood gathered in the rain is wet wood (burns 10 s, not 20 s), gathered
 * INSTEAD of wood; dry stored wood is untouched. A data-only drying recipe (wet_wood -> wood, no
 * station, 30 s) dries it. Rain = Rain + Storm kinds (Snow does not wet wood). The wet-wood icon is
 * runtime-painted (apps/client/src/wetwood-art.ts, tested in apps/client/test/adr457_*).
 */
import { describe, it, expect } from "vitest";
import { setTimeOfDay, Weather } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld as baseWorld, steps, spawnLearned } from "./helpers.js";

const d = G.defaultDefs();
const id = (k: string) => d.itemId(k);

function gatherOnce(w: ReturnType<typeof baseWorld>, p: number, node: number): void {
  G.setIntent(w, p, { action: G.IntentAction.Gather, target: node });
  w.step(1 / 20);
  steps(w, 30);
}
/** Pin the weather (day 1, past the first-day no-rain rule) so the gather happens under `kind`. */
function setWeather(w: ReturnType<typeof baseWorld>, kind: number): void {
  setTimeOfDay(w, 12, 1);
  Object.assign(w.env(Weather), { kind, intensity: 1, endsAtTick: 0xffffffff, windSpeed: 0 });
}
function lumberjack(w: ReturnType<typeof baseWorld>, kind: number): { w: ReturnType<typeof baseWorld>; p: number; tree: number } {
  const p = G.spawnPlayer(w, { x: 0, y: 0 });
  const tree = G.spawnResourceNode(w, "tree", 1, 0);
  G.addItem(w, p, id("iron_axe"), 1);
  w.set(p, G.Equipment, { mainHandSlot: 0 }); // the axe is the only item, so it sits in slot 0
  setWeather(w, kind);
  return { w, p, tree };
}

describe("ADR-457 wet firewood", () => {
  it("wet_wood is its own item: 10 s of fuel (wood is 20 s), same stack and weight", () => {
    const wet = d.items.get(id("wet_wood"))!;
    const dry = d.items.get(id("wood"))!;
    expect(wet.name).toBe("Wet Pine Log");
    expect(wet.fuelSeconds).toBe(10);
    expect(dry.fuelSeconds).toBe(20);
    expect(wet.maxStack).toBe(dry.maxStack);
    expect(wet.weight).toBe(dry.weight);
    expect(wet.spriteKey).toBe("wet_wood"); // dedicated runtime-painted icon, not the dry-wood sprite
    expect(id("wet_wood")).toBe(521); // ids.lock.json, append-only
  });

  it("gathering a tree in the rain yields wet wood, never dry wood", () => {
    const { w, p, tree } = lumberjack(baseWorld(), G.WeatherKind.Rain);
    gatherOnce(w, p, tree);
    expect(G.countItem(w, p, id("wet_wood"))).toBeGreaterThanOrEqual(4); // 3..5 + 1 tier bonus
    expect(G.countItem(w, p, id("wood"))).toBe(0);
  });

  it("gathering a tree in a storm yields wet wood; in clear weather and snow it yields dry wood", () => {
    const storm = lumberjack(baseWorld(), G.WeatherKind.Storm);
    gatherOnce(storm.w, storm.p, storm.tree);
    expect(G.countItem(storm.w, storm.p, id("wet_wood"))).toBeGreaterThanOrEqual(4);
    expect(G.countItem(storm.w, storm.p, id("wood"))).toBe(0);

    const clear = lumberjack(baseWorld(), G.WeatherKind.Clear);
    gatherOnce(clear.w, clear.p, clear.tree);
    expect(G.countItem(clear.w, clear.p, id("wood"))).toBeGreaterThanOrEqual(4);
    expect(G.countItem(clear.w, clear.p, id("wet_wood"))).toBe(0);

    const snow = lumberjack(baseWorld(), G.WeatherKind.Snow);
    gatherOnce(snow.w, snow.p, snow.tree);
    expect(G.countItem(snow.w, snow.p, id("wood"))).toBeGreaterThanOrEqual(4);
    expect(G.countItem(snow.w, snow.p, id("wet_wood"))).toBe(0);
  });

  it("hardwood gathered in the rain stays dry (no wet_hardwood)", () => {
    const w = baseWorld();
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    const oak = G.spawnResourceNode(w, "oak_tree", 1, 0);
    G.addItem(w, p, id("iron_axe"), 1);
    w.set(p, G.Equipment, { mainHandSlot: 0 }); // the axe is the only item, so it sits in slot 0
    setWeather(w, G.WeatherKind.Rain);
    gatherOnce(w, p, oak);
    expect(G.countItem(w, p, id("hardwood"))).toBeGreaterThanOrEqual(1);
    expect(G.countItem(w, p, id("wet_wood"))).toBe(0);
  });

  it("a campfire burns wet wood for 10 s and dry wood for 20 s (fuelSeconds data, no code)", () => {
    const wet = baseWorld();
    const fireWet = G.spawnStation(wet, G.StationKind.Campfire, 0, 0, { burnSeconds: 0 });
    G.addItem(wet, fireWet, id("wet_wood"), 1);
    expect(G.fuelSecondsLeft(wet, fireWet)).toBe(10);

    const dry = baseWorld();
    const fireDry = G.spawnStation(dry, G.StationKind.Campfire, 0, 0, { burnSeconds: 0 });
    G.addItem(dry, fireDry, id("wood"), 1);
    expect(G.fuelSecondsLeft(dry, fireDry)).toBe(20);
  });

  it("drying recipe: wet_wood -> wood, no station, 30 s", () => {
    const r = d.recipes.get(d.recipeId("dry_wet_wood"))!;
    expect(r.station).toBe(G.StationKind.None);
    expect(r.seconds).toBe(30);
    expect([...r.ingredients]).toEqual([{ item: id("wet_wood"), count: 1 }]);
    expect(r.output).toEqual({ item: id("wood"), count: 1 });
    expect(d.recipeId("dry_wet_wood")).toBe(407); // ids.lock.json, append-only

    const w = baseWorld();
    const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0 });
    G.addItem(w, p, id("wet_wood"), 2);
    G.setIntent(w, p, { action: G.IntentAction.Craft, recipe: d.recipeId("dry_wet_wood") });
    w.step(1 / 20);
    steps(w, 600); // 30 s
    expect(G.countItem(w, p, id("wet_wood"))).toBe(1);
    expect(G.countItem(w, p, id("wood"))).toBe(1);
  });
});
