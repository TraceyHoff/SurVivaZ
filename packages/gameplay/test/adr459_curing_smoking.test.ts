/**
 * ADR-459: salt curing and smoking meat — JSON-only. Curing already ships (jerky, salted_fish);
 * this ADR adds the smoked/cured variants on the jerky pattern: 2 raw + 1 salt -> 2 at a campfire
 * in 4 s, spoilSeconds 14400 (16x raw meat's 900 s). Smoked fish is the distinct smoking line
 * (fish + salt + wood). New items reuse existing sprites via "sprite" — no new art.
 */
import { describe, it, expect } from "vitest";
import { defaultDefs, StationKind } from "../src/index.js";

const d = defaultDefs();
const item = (k: string) => d.items.get(d.itemId(k))!;
const recipe = (k: string) => d.recipes.get(d.recipeId(k))!;

describe("ADR-459 salt curing and smoking meat", () => {
  it("new cured/smoked items exist with 14400 s spoilage and reused sprites", () => {
    for (const [key, sprite, hunger] of [
      ["cured_venison", "jerky", 30],
      ["cured_poultry", "jerky", 20],
      ["cured_prime_cut", "jerky", 40],
      ["smoked_fish", "salted_fish", 22],
    ] as const) {
      const it = item(key);
      expect(it.spoilSeconds).toBe(14400);
      expect(it.food!.hunger).toBe(hunger);
      expect(it.spriteKey).toBe(sprite);
    }
  });

  it("recipes follow the jerky pattern: 2 raw + 1 salt -> 2 at a campfire in 4 s", () => {
    const cases: [string, string, string][] = [
      ["cured_venison", "raw_venison", "cured_venison"],
      ["cured_poultry", "raw_poultry", "cured_poultry"],
      ["cured_prime_cut", "raw_prime_cut", "cured_prime_cut"],
    ];
    for (const [key, raw, out] of cases) {
      const r = recipe(key);
      expect(r.station).toBe(StationKind.Campfire);
      expect(r.seconds).toBe(4);
      expect(r.ingredients).toEqual([
        { item: d.itemId(raw), count: 2 },
        { item: d.itemId("salt"), count: 1 },
      ]);
      expect(r.output).toEqual({ item: d.itemId(out), count: 2 });
    }
  });

  it("smoked fish is the distinct smoking line: fish + salt + wood", () => {
    const r = recipe("smoked_fish");
    expect(r.station).toBe(StationKind.Campfire);
    expect(r.seconds).toBe(4);
    expect(r.ingredients).toEqual([
      { item: d.itemId("fish"), count: 2 },
      { item: d.itemId("salt"), count: 1 },
      { item: d.itemId("wood"), count: 1 },
    ]);
    expect(r.output).toEqual({ item: d.itemId("smoked_fish"), count: 2 });
  });

  it("cured meat spoils 16x slower than raw meat (14400 s vs 900 s)", () => {
    expect(item("raw_meat").spoilSeconds).toBe(900);
    expect(item("cured_venison").spoilSeconds! / item("raw_meat").spoilSeconds!).toBe(16);
    expect(item("smoked_fish").spoilSeconds! / item("fish").spoilSeconds!).toBe(24);
  });
});
