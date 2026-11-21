/**
 * ADR-496: rare old animals. 2% of spawns of the eligible species (boar, wolf — the only
 * species with their own art in the live pack manifest that are not tameable; deer has real art
 * too but is a mount species, so the tameable exclusion removes it) are old: 1.25x draw scale,
 * 1.5x HP, and
 * an extra loot roll (prime cuts + a pelt) on top of the normal table. The roll lives in the
 * spawner host path only — spawnAnimal itself never rolls, so husbandry babies are born normal —
 * and tameable species are excluded twice (data list + roll-time guard).
 */
import { describe, it, expect } from "vitest";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

const defOf = (key: string): G.AnimalDef => G.animalDefs().find((d) => d.key === key)!;
const keyOf = (item: number): string => G.defaultDefs().items.get(item)?.key ?? "?";

describe("ADR-496 rare old animals", () => {
  it("tuning: 2% chance, 1.25x scale, 1.5x HP, eligible = boar/deer/wolf (real art only)", () => {
    const t = G.oldVariantTuning();
    expect(t.chance).toBe(0.02);
    expect(t.scaleMul).toBe(1.25);
    expect(t.hpMul).toBe(1.5);
    expect([...t.eligible].sort()).toEqual(["animal_boar", "animal_wolf"]);
    for (const k of t.eligible) {
      expect(G.isTameableAnimalKey(k)).toBe(false);
      expect(defOf(k).oldScaleMul).toBe(1.25);
      expect(defOf(k).oldLoot.map((l) => l.item)).toEqual(expect.arrayContaining(["raw_prime_cut", "fur_pelt"]));
      for (const l of defOf(k).oldLoot) expect(G.defaultDefs().itemId(l.item)).toBeGreaterThan(0);
    }
    // No other species carries old loot rows — including deer, which has real art but is a mount.
    expect(G.animalDefs().filter((d) => d.oldLoot.length > 0).map((d) => d.key).sort()).toEqual([
      "animal_boar", "animal_wolf",
    ]);
    expect(defOf("animal_deer").oldLoot).toEqual([]);
  });

  it("validation: bad tuning and stray oldLoot rows are errors", () => {
    const base = G.populationData().ai;
    const withTuning = (old: unknown): string[] => G.validateAiData({ ...base, tuning: { ...base.tuning, old } as never });
    expect(withTuning({ chance: 0.02, scaleMul: 1.25, hpMul: 1.5, eligible: ["animal_boar", "animal_wolf"] })).toEqual([]);
    expect(withTuning({ eligible: ["animal_deer"] }).length).toBeGreaterThan(0); // real art, but a mount
    expect(withTuning({ chance: 0 }).length).toBeGreaterThan(0);
    expect(withTuning({ chance: 1.5 }).length).toBeGreaterThan(0);
    expect(withTuning({ scaleMul: 0.5 }).length).toBeGreaterThan(0);
    expect(withTuning({ eligible: ["animal_horse"] }).length).toBeGreaterThan(0); // tameable
    expect(withTuning({ eligible: ["zombie_walker"] }).length).toBeGreaterThan(0); // not an animal
    // oldLoot on a species outside the eligible list is dead data.
    const stray = G.validateAiData({
      ...base,
      archetypes: { ...base.archetypes, animal_rabbit: { ...base.archetypes.animal_rabbit!, oldLoot: [{ item: "fur_pelt", min: 1, max: 1, chance: 1 }] } as never },
    });
    expect(stray.length).toBeGreaterThan(0);
  });

  it("spawnAnimal never marks old on its own (babies are born normal)", () => {
    const w = makeWorld({}, 7);
    for (let i = 0; i < 50; i++) {
      const d = G.spawnAnimal(w, "animal_wolf", 10 + i, 10);
      expect(w.get(d, G.Animal)!.old).toBe(0);
      expect(w.get(d, G.Health)!.hp).toBe(70);
    }
  });

  it("the host-path roll: ~2% of wolves are old (1.5x HP), chickens never are", () => {
    const w = makeWorld({}, 7);
    let old = 0;
    for (let i = 0; i < 300; i++) {
      const d = G.spawnAnimal(w, "animal_wolf", 10 + (i % 50), 10 + Math.floor(i / 50));
      if (G.maybeMarkOld(w, d)) {
        old++;
        expect(w.get(d, G.Animal)!.old).toBe(1);
        expect(w.get(d, G.Health)!.hp).toBe(105); // 70 x 1.5
        expect(w.get(d, G.Health)!.max).toBe(105);
      } else {
        expect(w.get(d, G.Health)!.hp).toBe(70);
      }
    }
    // Binomial(300, 0.02): mean 6, sd ~2.4 — [1, 15] is ~+/-4 sigma.
    expect(old).toBeGreaterThanOrEqual(1);
    expect(old).toBeLessThanOrEqual(15);
    let oldChickens = 0;
    for (let i = 0; i < 100; i++) {
      const c = G.spawnAnimal(w, "animal_chicken", 10 + (i % 50), 30 + Math.floor(i / 50));
      if (G.maybeMarkOld(w, c)) oldChickens++;
    }
    expect(oldChickens).toBe(0);
  });

  it("an old wolf drops its normal loot PLUS prime cuts and a pelt; a normal wolf drops neither", () => {
    const w = makeWorld({}, 7);
    let oldWolf: ReturnType<typeof G.spawnAnimal> | undefined;
    for (let i = 0; i < 300 && !oldWolf; i++) {
      const d = G.spawnAnimal(w, "animal_wolf", 10 + (i % 50), 10 + Math.floor(i / 50));
      if (G.maybeMarkOld(w, d)) oldWolf = d;
    }
    expect(oldWolf).toBeDefined();
    const bag = G.dropAnimalLoot(w, oldWolf!)!;
    expect(bag).toBeDefined();
    const loot = new Map(G.listSlots(w, bag).map((s) => [keyOf(s.item), s.count]));
    expect(loot.get("raw_meat")).toBeGreaterThanOrEqual(1); // normal table still rolls (wolf: 1-2)
    expect(loot.get("raw_prime_cut")).toBeGreaterThanOrEqual(1); // old extra
    expect(loot.get("fur_pelt")).toBe(1); // old extra, guaranteed
    // Control: normal wolves never drop prime cuts or pelts.
    for (let i = 0; i < 20; i++) {
      const d = G.spawnAnimal(w, "animal_wolf", 40 + i, 40);
      const b = G.dropAnimalLoot(w, d);
      if (!b) continue;
      const keys = G.listSlots(w, b).map((s) => keyOf(s.item));
      expect(keys).not.toContain("raw_prime_cut");
      expect(keys).not.toContain("fur_pelt");
    }
  });
});
