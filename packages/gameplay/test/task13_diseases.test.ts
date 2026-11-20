import { describe, expect, it } from "vitest";
import { Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { collect, makeWorld, steps } from "./helpers.js";

const d = G.defaultDefs();
const id = (k: string): number => d.itemId(k);
/** Test defs: every disease roll succeeds and every threshold is seconds, so cause -> disease wiring is deterministic. */
const testDefs = (): G.GameDefs => {
  const raw = JSON.parse(JSON.stringify(G.DEFAULT_RAW_DEFS)) as G.RawDefs;
  raw.diseases.causes = { rawMeatChance: 1, sickFoodChance: 1, rottenFoodChance: 1, rawWaterChance: 1, woundChance: 1, riverWaterChance: 1, isolatedWaterChance: 1 };
  raw.diseases.transmission = { radiusTiles: 2, contactSeconds: 5, chance: 1, scanEveryTicks: 20 };
  raw.diseases.exposure = { coldSeconds: 5, heatSeconds: 5, sprintSeconds: 3, restSeconds: 2 };
  raw.diseases.diseases.find((x) => x.key === "food_poisoning")!.durationSeconds = 2;
  return G.loadDefs(raw, { lock: G.DEFAULT_ID_LOCK });
};
const mk = (w: World, pid: number, x = 0, y = 0): Entity => G.spawnPlayer(w, { x, y, clientId: pid });
const use = (w: World, p: Entity, slot: number): void => { G.setIntent(w, p, { action: G.IntentAction.Use, slot }); w.step(1 / 20); G.setIntent(w, p, { action: G.IntentAction.None }); };
const wet = (w: World): void => w.setResource(G.TerrainRes, { tileAt: (tx: number) => (tx >= 2 ? 1 : 3), heightAt: () => 0 });
const has = (w: World, p: Entity, key: string): boolean => G.hasDisease(w, p, key);
const give = (w: World, p: Entity, key: string, count = 1): void => { G.addItem(w, p, id(key), count); };

describe("Task 13: diseases", () => {
  it("defs: 6 diseases, cures, boil pairs and mask/waterskin items", () => {
    expect(d.diseases.map((x) => x.key)).toEqual(["food_poisoning", "dysentery", "common_cold", "heatstroke", "exhaustion", "wound_infection", "influenza", "broken_leg"]);
    expect(d.diseases.find((x) => x.key === "common_cold")!.contagious).toBe(true);
    expect(d.diseases.find((x) => x.key === "influenza")!.contagious).toBe(true); // Task 31: flu, worse than a cold
    expect(d.diseases.find((x) => x.key === "exhaustion")!.cure).toBeNull();
    for (const [rawKey, boiledKey] of [["water_flask", "boiled_water_flask"], ["canteen", "boiled_canteen"], ["water_bottle", "boiled_water_bottle"], ["waterskin", "boiled_waterskin"]] as const) {
      const raw = d.items.get(id(rawKey))!, boiled = d.items.get(id(boiledKey))!;
      expect(raw.boilTarget).toBe(boiled.id); expect(boiled.boilSource).toBe(raw.id);
      expect(boiled.boiled).toBe(true); expect(boiled.sips).toBe(raw.sips);
    }
    expect(d.items.get(id("cloth_mask"))!.mask).toBe(true);
    expect(d.items.get(id("cloth_mask"))!.wear?.slot).toBe(G.WearSlot.Accessory);
    expect(d.recipes.get(d.recipeId("waterskin"))!.station).toBe(G.StationKind.None);
    expect(d.items.get(id("raw_meat"))!.rawMeat).toBe(true);
    expect(d.items.get(id("charcoal_tonic"))!.cures).toEqual(["food_poisoning"]);
  });

  it("eating raw meat contracts food poisoning", () => {
    const w = makeWorld({ defs: testDefs() }); const p = mk(w, 1);
    give(w, p, "raw_meat"); use(w, p, 0);
    expect(has(w, p, "food_poisoning")).toBe(true);
  });

  it("eating spoiling-stage food contracts food poisoning; rotten is refused unless iron_stomach, then it contracts", () => {
    const w = makeWorld({ defs: testDefs() }); const p = mk(w, 1);
    steps(w, 1); // tick 1, so age = 1 tick for the spoilMul trick below
    give(w, p, "raw_meat");
    // spoiling stage (freshness 0.4): raw_meat spoils in 900s; at age 1 tick, spoilMul 10800
    // gives freshness = 1 - (0.05/900) * 10800 = 0.4 (spoiling, i.e. sick stage)
    w.getArray(p, G.Inventory, "createdTick")![0] = 0;
    w.setField(p, G.Inventory, "spoilMul", 10800);
    use(w, p, 0);
    expect(has(w, p, "food_poisoning")).toBe(true);
    // rotten without the perk: refused, no disease (spoilMul 20000 drives freshness to 0 in one tick)
    const q = mk(w, 2, 10, 0); give(w, q, "raw_meat");
    w.getArray(q, G.Inventory, "createdTick")![0] = 0;
    w.setField(q, G.Inventory, "spoilMul", 20000);
    const fails = collect(w, G.ConsumeFailed); use(w, q, 0);
    expect(fails.at(-1)!.reason).toBe(G.ConsumeFail.Rotten); expect(has(w, q, "food_poisoning")).toBe(false);
    // rotten with iron_stomach: eaten, disease contracts
    const r = mk(w, 3, 20, 0); give(w, r, "raw_meat");
    for (const k of G.TREE_KEYS) G.grantTreePoints(w, r, k, 5);
    expect(G.unlockSkill(w, r, G.skillNodeIndex("iron_stomach"))).toBeUndefined();
    w.getArray(r, G.Inventory, "createdTick")![0] = 0;
    w.setField(r, G.Inventory, "spoilMul", 20000);
    use(w, r, 0);
    expect(has(w, r, "food_poisoning")).toBe(true);
  });

  it("drinking untreated water (tile and raw container) contracts dysentery; boiled water never does", () => {
    const w = makeWorld({ defs: testDefs() }); wet(w);
    const p = mk(w, 1, 1.6, 0.5);
    w.set(p, G.Survival, { thirst: 20 }); use(w, p, G.NO_SLOT);
    expect(has(w, p, "dysentery")).toBe(true);
    const q = mk(w, 2, 10, 0); give(w, q, "water_flask"); use(w, q, 0);
    expect(has(w, q, "dysentery")).toBe(true);
    const r = mk(w, 3, 20, 0); give(w, r, "boiled_water_flask"); use(w, r, 0);
    expect(has(w, r, "dysentery")).toBe(false);
  });

  it("boiling at a lit campfire converts the container and keeps its sips; an unlit fire fails with NoFire", () => {
    const w = makeWorld({ defs: testDefs() }); const p = mk(w, 1);
    give(w, p, "water_flask");
    const fire = G.spawnStation(w, G.StationKind.Campfire, 1, 0, { burnSeconds: 600 });
    expect(w.getField(fire, G.Fuel, "lit")).toBe(1);
    G.setIntent(w, p, { action: G.IntentAction.Boil, slot: 0 }); w.step(1 / 20);
    expect(G.slotItem(w, p, 0).item).toBe(id("boiled_water_flask"));
    expect(w.getArray(p, G.Inventory, "durability")![0]).toBe(4);
    // unlit fire: stays raw, NoFire failure
    const q = mk(w, 2, 10, 0); give(w, q, "canteen");
    G.spawnStation(w, G.StationKind.Campfire, 11, 0, { burnSeconds: 0 });
    const fails = collect(w, G.ConsumeFailed);
    G.setIntent(w, q, { action: G.IntentAction.Boil, slot: 0 }); w.step(1 / 20);
    expect(G.slotItem(w, q, 0).item).toBe(id("canteen"));
    expect(fails.at(-1)!.reason).toBe(G.ConsumeFail.NoFire);
  });

  it("refilling a boiled container at untreated water reverts it to raw", () => {
    const w = makeWorld({ defs: testDefs() }); wet(w);
    const p = mk(w, 1, 1.6, 0.5); give(w, p, "boiled_water_flask");
    w.getArray(p, G.Inventory, "durability")![0] = 0;
    use(w, p, 0);
    expect(G.slotItem(w, p, 0).item).toBe(id("water_flask"));
    expect(w.getArray(p, G.Inventory, "durability")![0]).toBe(4);
  });

  it("cure items clear their disease when consumed", () => {
    const w = makeWorld({ defs: testDefs() }); const p = mk(w, 1);
    expect(G.contractDisease(w, p, "food_poisoning")).toBe(true);
    expect(has(w, p, "food_poisoning")).toBe(true);
    give(w, p, "charcoal_tonic"); use(w, p, 0);
    expect(has(w, p, "food_poisoning")).toBe(false);
    // a cure for a disease you do not have is just consumed, harmlessly (after the consume cooldown)
    steps(w, G.CONSUME_COOLDOWN_TICKS);
    give(w, p, "salt_brew"); use(w, p, 0);
    expect(G.countItem(w, p, id("salt_brew"))).toBe(0);
  });

  it("diseases expire after their duration (food poisoning: 2s in test defs)", () => {
    const w = makeWorld({ defs: testDefs() }); const p = mk(w, 1);
    G.contractDisease(w, p, "food_poisoning");
    expect(has(w, p, "food_poisoning")).toBe(true);
    steps(w, 45);
    expect(has(w, p, "food_poisoning")).toBe(false);
  });

  it("sustained cold contracts a cold, sustained heat contracts heatstroke", () => {
    const w = makeWorld({ defs: testDefs() });
    const cold = mk(w, 1); w.set(cold, G.Survival, { bodyTemp: 30 });
    const hot = mk(w, 2, 10, 0); w.set(hot, G.Survival, { bodyTemp: 42 });
    steps(w, 120);
    expect(has(w, cold, "common_cold")).toBe(true);
    expect(has(w, hot, "heatstroke")).toBe(true);
    expect(has(w, cold, "heatstroke")).toBe(false);
  });

  it("sprinting too long contracts exhaustion; resting clears it", () => {
    const w = makeWorld({ defs: testDefs() }); const p = mk(w, 1);
    G.setIntent(w, p, { action: G.IntentAction.None, moving: 1, sprint: 1 });
    steps(w, 70);
    expect(has(w, p, "exhaustion")).toBe(true);
    G.setIntent(w, p, { action: G.IntentAction.None, moving: 0, sprint: 0 });
    steps(w, 50);
    expect(has(w, p, "exhaustion")).toBe(false);
  });

  it("symptom drains lower hp and needs; disease move penalty slows the carrier", () => {
    const w = makeWorld({ defs: testDefs() }); const p = mk(w, 1);
    const base = G.speedMultiplier(w, p, false);
    G.contractDisease(w, p, "exhaustion"); // moveMul 0.7, stamina drain 4/s, no hp drain
    expect(G.speedMultiplier(w, p, false)).toBeCloseTo(base * 0.7, 9);
    const hp0 = w.get(p, G.Health)!.hp, th0 = w.get(p, G.Survival)!.thirst;
    G.contractDisease(w, p, "dysentery"); // hpDps 0.3, thirstMul 2
    steps(w, 20);
    expect(w.get(p, G.Health)!.hp).toBeLessThan(hp0);
    expect(w.get(p, G.Survival)!.thirst).toBeLessThan(th0 - 0.08); // base 0.08/s + disease extra
  });

  it("a contagious cold spreads after close contact; a mask on either side blocks it", () => {
    const w = makeWorld({ defs: testDefs() });
    const carrier = mk(w, 1, 0, 0); const near = mk(w, 2, 1, 0);
    G.contractDisease(w, carrier, "common_cold");
    steps(w, 140);
    expect(has(w, near, "common_cold")).toBe(true);
    // masked carrier does not spread
    const w2 = makeWorld({ defs: testDefs() });
    const c2 = mk(w2, 1, 0, 0); const n2 = mk(w2, 2, 1, 0);
    give(w2, c2, "cloth_mask");
    G.setIntent(w2, c2, { action: G.IntentAction.Wear, slot: 0 }); w2.step(1 / 20);
    expect(G.wearsMask(w2, c2)).toBe(true);
    G.contractDisease(w2, c2, "common_cold");
    steps(w2, 140);
    expect(has(w2, n2, "common_cold")).toBe(false);
    // masked susceptible does not catch it either
    const w3 = makeWorld({ defs: testDefs() });
    const c3 = mk(w3, 1, 0, 0); const n3 = mk(w3, 2, 1, 0);
    give(w3, n3, "cloth_mask");
    G.setIntent(w3, n3, { action: G.IntentAction.Wear, slot: 0 }); w3.step(1 / 20);
    expect(G.wearsMask(w3, n3)).toBe(true);
    G.contractDisease(w3, c3, "common_cold");
    steps(w3, 140);
    expect(has(w3, n3, "common_cold")).toBe(false);
  });

  it("zombie bites roll wound infection; player hits do not", () => {
    const w = makeWorld({ defs: testDefs() });
    const p = mk(w, 1);
    const z = w.create(); w.add(z, Transform, { x: 1, y: 0 }); w.add(z, G.Zombie, { kind: 0, variant: 0 });
    G.applyDamage(w, p, 5, z);
    steps(w, 2);
    expect(has(w, p, "wound_infection")).toBe(true);
    const q = mk(w, 2, 10, 0);
    G.applyDamage(w, q, 5, p); // player-on-player: no infection
    steps(w, 2);
    expect(has(w, q, "wound_infection")).toBe(false);
  });

  it("worn mask renders through the worn-cosmetics mapping", () => {
    expect(G.wearableKeyFor("cloth_mask", undefined)).toBe("acc_gear_cloth_mask");
  });
});
