import { describe, expect, it } from "vitest";
import { World } from "@engine/core";
import { PopulationSpawner, type PopulationHost } from "@engine/world";
import { Health, LootBag, Container } from "../src/components.js";
import * as G from "../src/index.js";
import { makeWorld as baseWorld, steps } from "./helpers.js";

const makeWorld = (): World => { const w = baseWorld(); w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem); return w; };

describe("animals (spawns.json -> PopulationSpawner, ai.json behavior)", () => {
  it("toSpawnEntries feeds every animal kind (art keys) incl. boar, wolf and chicken in both modes", () => {
    for (const mode of ["sp", "mp"] as const) {
      const es = G.toSpawnEntries(mode); const kinds = es.filter((e) => e.category === "animal").map((e) => e.kind);
      expect(kinds).toEqual(["animal_rabbit", "animal_deer", "animal_boar", "animal_wolf", "animal_chicken", "animal_stag", "animal_red_deer", "animal_elk", "animal_moose", "animal_bear", "animal_fox", "animal_hare", "animal_squirrel", "animal_turkey", "animal_duck", "animal_goose", "animal_goat", "animal_sheep", "animal_cow", "animal_bison", "animal_snake", /* ADR-145 pets */ "animal_dog_dachshund", "animal_dog_lab", "animal_dog_husky", "animal_dog_shepherd", "animal_dog_beagle", "animal_cat_tabby", "animal_cat_siamese", "animal_cat_black", "animal_parrot", "animal_crow", "animal_ferret", /* Task 32 */ "animal_owl", "animal_turtle", "animal_pig", "animal_alpaca", "animal_bee", /* ADR-319 */ "animal_horse", "animal_donkey", "animal_yak"]);
      for (const e of es) { expect(e.density).toBeGreaterThan(0); expect(Math.max(...Object.values(e.timeWeights!))).toBeCloseTo(1); expect(e.tiles!.length).toBeGreaterThan(0); }
      expect(es.some((e) => e.category === "human_bot")).toBe(mode === "sp");
    }
    expect(G.animalDefs().map((a) => a.spriteKey)).toEqual(["animal_rabbit", "animal_deer", "animal_boar", "animal_wolf", "animal_chicken", "animal_stag", "animal_red_deer", "animal_elk", "animal_moose", "animal_bear", "animal_fox", "animal_hare", "animal_squirrel", "animal_turkey", "animal_duck", "animal_goose", "animal_goat", "animal_sheep", "animal_cow", "animal_bison", "animal_snake", /* ADR-145 pets */ "animal_dog_dachshund", "animal_dog_lab", "animal_dog_husky", "animal_dog_shepherd", "animal_dog_beagle", "animal_cat_tabby", "animal_cat_siamese", "animal_cat_black", "animal_parrot", "animal_crow", "animal_ferret", /* Task 32 */ "animal_owl", "animal_turtle", "animal_pig", "animal_alpaca", "animal_bee", /* ADR-319 */ "animal_horse", "animal_donkey", "animal_yak"]);
  });
  it("the spawner actually spawns boar and wolf (and chicken) over forest/grass", () => {
    const w = new World(); const got: Record<string, number> = {}; let n = 0;
    const chunks = Array.from({ length: 64 }, (_, i) => `${(i % 8) - 4},${Math.floor(i / 8) - 4}`);
    const host: PopulationHost = {
      chunks: () => chunks, viewpoints: () => [{ x: 0, y: 0 }], phase: () => "dawn",
      tileAt: (tx) => (tx % 2 ? 4 : 3), blocked: () => false,
      spawn: (entry) => { got[entry.kind] = (got[entry.kind] ?? 0) + 1; return ++n as never; },
      despawn: () => {}, position: () => ({ x: 20, y: 20 }),
    };
    const sp = new PopulationSpawner(w, G.toSpawnEntries("mp"), host);
    for (let i = 0; i < 30; i++) { sp.step(); w.step(1 / 20); }
    for (const k of ["animal_boar", "animal_wolf", "animal_chicken", "animal_deer", "animal_rabbit"]) expect(got[k] ?? 0).toBeGreaterThan(0);
  });
  it("goofy wolf: bites only at close range, flees once lightly hurt", () => {
    const wolfAi = G.populationData().ai.archetypes.animal_wolf!;
    expect(wolfAi.aggro.range).toBeLessThanOrEqual(3); expect(wolfAi.flee.hpFrac).toBeGreaterThanOrEqual(0.6);
    const w = makeWorld(); const p = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
    const far = G.spawnAnimal(w, "animal_wolf", 6, 0); const hp0 = w.get(p, Health)!.hp;
    steps(w, 10); expect(w.get(far, G.Animal)!.state).not.toBe(G.AnimalState.Attack); expect(w.get(p, Health)!.hp).toBe(hp0);
    const near = G.spawnAnimal(w, "animal_wolf", 1.2, 0); steps(w, 40);
    expect(w.get(p, Health)!.hp).toBeLessThan(hp0);
    const max = w.get(near, Health)!.max; w.set(near, Health, { hp: max * 0.6 }); steps(w, 3);
    expect(w.get(near, G.Animal)!.state).toBe(G.AnimalState.Flee);
  });
  it("chicken flees, and dead animals drop ai.json loot then despawn", () => {
    const w = makeWorld(); G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
    const c = G.spawnAnimal(w, "animal_chicken", 2, 0); steps(w, 2); expect(w.get(c, G.Animal)!.state).toBe(G.AnimalState.Flee);
    w.set(c, Health, { hp: 0 }); steps(w, 2);
    const bags = [...w.query([LootBag, Container])]; expect(bags.length).toBe(1);
    expect(w.get(c, G.Animal)!.state).toBe(G.AnimalState.Dead);
    steps(w, G.ANIMAL_CORPSE_SECONDS * 20 + 2); expect(w.isAlive(c)).toBe(false);
  });
});
