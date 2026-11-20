// ADR-470: eating well matters — a varied diet earns a nutrition bonus, eating the same food in
// a row carries no penalty. Variety is the distinct diet-group count over the last 8 eats
// (RecentFoods, event-only); 4+ groups = 1.1x nutrition. Drinks, medicines and pet treats never count.
import { describe, expect, it } from "vitest";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";
import type { Entity, World } from "@engine/core";

const d = G.defaultDefs();
const id = (k: string): number => d.itemId(k);
const slotOf = (w: World, p: Entity, item: number): number => {
  const v = G.readSlots(w, p);
  for (let i = 0; i < v.slotCount; i++) if (v.item(i) === item && v.count(i)) return i;
  return -1;
};
const hungerOf = (w: World, p: Entity): number => w.get(p, G.Survival)!.hunger;

/** Eat one unit of `key` from its own slot and return the hunger gained (hunger pinned to 0 first). */
const eatGain = (w: World, p: Entity, key: string): number => {
  G.addItem(w, p, id(key), 1);
  const s = slotOf(w, p, id(key));
  w.set(p, G.Equipment, { mainHandSlot: s, mainHandItem: id(key) });
  w.set(p, G.Survival, { hunger: 0 });
  G.setIntent(w, p, { action: G.IntentAction.Use, slot: s });
  w.step(1 / 20);
  steps(w, 11); // past CONSUME_COOLDOWN_TICKS
  return hungerOf(w, p);
};
const freshPlayer = (): { w: World; p: Entity } => {
  const w = makeWorld();
  const p = G.spawnPlayer(w, { x: 0, y: 0 });
  return { w, p };
};

describe("ADR-470 varied diet bonus", () => {
  it("eating from 4 distinct groups earns 1.1x on the 4th food, and only then", () => {
    const { w, p } = freshPlayer();
    expect(eatGain(w, p, "cooked_meat")).toBeCloseTo(30, 1); // meat, 1 group: no bonus
    expect(eatGain(w, p, "apple")).toBeCloseTo(10, 1); // fruit, 2 groups
    expect(eatGain(w, p, "carrot")).toBeCloseTo(8, 1); // vegetable, 3 groups
    expect(eatGain(w, p, "bread")).toBeCloseTo(28 * 1.1, 1); // grain, 4 groups: bonus
    expect(G.recentFoodGroupCount(w, p)).toBe(4);
  });
  it("eating the same food in a row carries no penalty and no bonus", () => {
    const { w, p } = freshPlayer();
    for (let i = 0; i < 8; i++) expect(eatGain(w, p, "cooked_meat")).toBeCloseTo(30, 1);
    expect(G.recentFoodGroupCount(w, p)).toBe(1);
    expect(G.recentFoodGroups(w, p)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
  it("drinks and tonics never count toward variety", () => {
    const { w, p } = freshPlayer();
    expect(eatGain(w, p, "cooked_meat")).toBeCloseTo(30, 1); // meat
    expect(eatGain(w, p, "cooked_fish")).toBeCloseTo(24, 1); // fish
    expect(eatGain(w, p, "apple")).toBeCloseTo(10, 1); // fruit
    eatGain(w, p, "water_flask"); // drink: thirst only, no group recorded
    eatGain(w, p, "honey_tea"); // tonic: thirst + health, no group recorded
    expect(G.recentFoodGroupCount(w, p)).toBe(3);
    expect(eatGain(w, p, "bread")).toBeCloseTo(28 * 1.1, 1); // grain: 4th group, bonus
  });
  it("the window is the last 8 eats: 8 same-group eats push the old groups out", () => {
    const { w, p } = freshPlayer();
    eatGain(w, p, "cooked_meat"); eatGain(w, p, "apple"); eatGain(w, p, "carrot");
    expect(eatGain(w, p, "bread")).toBeCloseTo(28 * 1.1, 1); // 4 groups: bonus
    for (let i = 0; i < 8; i++) eatGain(w, p, "cooked_meat"); // window is all meat now
    expect(G.recentFoodGroupCount(w, p)).toBe(1);
    expect(eatGain(w, p, "bread")).toBeCloseTo(28, 1); // grain is only the 2nd group: no bonus
  });
  it("the queue records groups oldest-first and caps at 8", () => {
    const { w, p } = freshPlayer();
    eatGain(w, p, "cooked_meat"); // meat = 0
    eatGain(w, p, "cooked_fish"); // fish = 1
    expect(G.recentFoodGroups(w, p)).toEqual([0, 1]);
    eatGain(w, p, "cooked_meat");
    expect(G.recentFoodGroups(w, p)).toEqual([0, 1, 0]);
    expect(G.recentFoodGroupCount(w, p)).toBe(2);
  });
  it("every real food is in exactly one group; drinks, medicines and pet treats are in none", () => {
    const groups = d.vitals.dietGroups;
    const names = Object.keys(groups);
    expect(names).toEqual(["meat", "fish", "fruit", "vegetable", "grain", "dairy"]);
    const seen = new Map<string, string>();
    for (const g of names) for (const k of groups[g]!) {
      expect(seen.has(k)).toBe(false); // no food in two groups
      seen.set(k, g);
    }
    const petTreats = new Set(["dog_biscuit", "meaty_chew", "fish_treat", "seed_mix", "veggie_bites", "egg_crunch"]);
    for (const item of d.items.values()) {
      const food = item.food; if (!food) continue;
      if (item.sips > 0) { expect(seen.has(item.key)).toBe(false); continue; } // drink
      if (food.hunger === 0) { expect(seen.has(item.key)).toBe(false); continue; } // medicine / tonic
      if (petTreats.has(item.key)) { expect(seen.has(item.key)).toBe(false); continue; }
      expect(seen.has(item.key)).toBe(true); // a real food is grouped
    }
    expect(seen.size).toBe(94);
  });
  it("dietGroupOf maps keys to group indices and returns undefined off the list", () => {
    expect(G.dietGroupOf(d, "cooked_meat")).toBe(0);
    expect(G.dietGroupOf(d, "cooked_fish")).toBe(1);
    expect(G.dietGroupOf(d, "apple")).toBe(2);
    expect(G.dietGroupOf(d, "carrot")).toBe(3);
    expect(G.dietGroupOf(d, "bread")).toBe(4);
    expect(G.dietGroupOf(d, "milk")).toBe(5);
    expect(G.dietGroupOf(d, "water_flask")).toBeUndefined();
    expect(G.dietGroupOf(d, "bandage")).toBeUndefined();
    expect(G.dietGroupOf(d, "dog_biscuit")).toBeUndefined();
  });
});
