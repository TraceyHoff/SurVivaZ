/**
 * ADR-495: night belongs to the night animals. Per-archetype activity windows (ai.json) multiply
 * wander chance and aggro range at the animal's think tick — 1.0 active, 0.4 sluggish. The window
 * is soft: a sluggish animal can still flee (flee is never windowed), an already-engaged one keeps
 * its fight, and a species with no entry (dogs, cats, bee, turtle) behaves exactly as before.
 * The phase is read once per animalAISystem run, not once per animal.
 */
import { describe, it, expect } from "vitest";
import { setTimeOfDay } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

const defOf = (key: string): G.AnimalDef => G.animalDefs().find((d) => d.key === key)!;

function worldWithAnimalAI(): ReturnType<typeof makeWorld> {
  const w = makeWorld();
  w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem);
  return w;
}

describe("ADR-495 night animals", () => {
  it("tables: wolf hunts at night/dusk, deer at dawn/dusk, chicken by day, dog unwindowed", () => {
    expect(G.activityMul(defOf("animal_wolf"), "night")).toBe(1);
    expect(G.activityMul(defOf("animal_wolf"), "dusk")).toBe(1);
    expect(G.activityMul(defOf("animal_wolf"), "day")).toBe(0.4);
    expect(G.activityMul(defOf("animal_wolf"), "dawn")).toBe(0.4);
    expect(G.activityMul(defOf("animal_deer"), "dawn")).toBe(1);
    expect(G.activityMul(defOf("animal_deer"), "dusk")).toBe(1);
    expect(G.activityMul(defOf("animal_deer"), "night")).toBe(0.4);
    expect(G.activityMul(defOf("animal_deer"), "day")).toBe(0.4);
    expect(G.activityMul(defOf("animal_owl"), "night")).toBe(1);
    expect(G.activityMul(defOf("animal_owl"), "day")).toBe(0.4);
    expect(G.activityMul(defOf("animal_chicken"), "day")).toBe(1);
    expect(G.activityMul(defOf("animal_chicken"), "night")).toBe(0.4);
    // Unwindowed in v1: no entry means today's behaviour at every phase.
    for (const k of ["animal_dog_lab", "animal_cat_tabby", "animal_bee", "animal_turtle", "animal_horse"]) {
      for (const ph of ["night", "dawn", "day", "dusk"] as const) expect(G.activityMul(defOf(k), ph)).toBe(1);
    }
  });

  it("validation: an activity window needs all four phases in (0, 1] — 0 would be a hard window", () => {
    const base = G.populationData().ai;
    const bad = (activity: unknown): string[] =>
      G.validateAiData({ ...base, archetypes: { ...base.archetypes, animal_wolf: { ...base.archetypes.animal_wolf!, activity } as never } });
    expect(bad({ night: 1, dawn: 1, day: 1, dusk: 1 })).toEqual([]);
    expect(bad({ night: 0, dawn: 1, day: 1, dusk: 1 }).length).toBeGreaterThan(0);
    expect(bad({ night: 1.5, dawn: 1, day: 1, dusk: 1 }).length).toBeGreaterThan(0);
    expect(bad({ night: 1, day: 1 }).length).toBeGreaterThan(0);
  });

  it("a wolf engages at 2.4 tiles by night (range 2.5) but not by day (windowed to 1.0)", () => {
    for (const [hour, attacks] of [[0, true], [12, false]] as const) {
      const w = worldWithAnimalAI();
      setTimeOfDay(w, hour, 1);
      const p = G.spawnPlayer(w, { x: 400, y: 0, maxWeight: 0, clientId: 1 });
      const wolf = G.spawnAnimal(w, "animal_wolf", 402.4, 0);
      const hp0 = w.get(p, G.Health)!.hp;
      steps(w, 5);
      if (attacks) expect(w.get(wolf, G.Animal)!.state).toBe(G.AnimalState.Attack);
      else {
        expect(w.get(wolf, G.Animal)!.state).not.toBe(G.AnimalState.Attack);
        expect(w.get(p, G.Health)!.hp).toBe(hp0);
      }
    }
  });

  it("a bedded chicken wanders far less at night than by day", () => {
    const wanders = (hour: number): number => {
      const w = worldWithAnimalAI();
      setTimeOfDay(w, hour, 1);
      const c = G.spawnAnimal(w, "animal_chicken", 400, 0);
      let n = 0;
      for (let i = 0; i < 150; i++) {
        w.setField(c, G.Animal, "thinkAt", w.tick);
        steps(w, 1);
        if (w.get(c, G.Animal)!.state === G.AnimalState.Wander) n++;
      }
      return n;
    };
    const night = wanders(0);
    const day = wanders(12);
    // Same rng stream in both runs, wander shares 0.2 (night) vs 0.5 (day): every night wander
    // is also a day wander, and the draws in the gap separate them by ~45 over 150 thinks.
    expect(night).toBeLessThan(day - 20);
    expect(night).toBeLessThan(60);
    expect(day).toBeGreaterThan(55);
  });

  it("flee is never windowed: a deer still runs from a player at night", () => {
    const w = worldWithAnimalAI();
    setTimeOfDay(w, 0, 1);
    G.spawnPlayer(w, { x: 400, y: 0, maxWeight: 0, clientId: 1 });
    const deer = G.spawnAnimal(w, "animal_deer", 405, 0);
    steps(w, 2);
    expect(w.get(deer, G.Animal)!.state).toBe(G.AnimalState.Flee);
  });
});
