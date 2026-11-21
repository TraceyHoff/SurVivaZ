/**
 * ADR-494: wolves hunt in packs. On its think tick, a target-less wolf scans the already-built
 * live list for a packmate in Attack state whose prey is within its leashRange (7) of IT, and
 * joins the hunt: state Attack + the packmate's goal, so it closes at attack speed and bites
 * through its own wants check once in range. The scan is think-gated only (never per-tick, never
 * a radius query); between thinks a sharing wolf keeps its Attack state without re-scanning.
 * Wolf only in v1 (the sole hostile species); a wolf with its own target keeps it.
 */
import { describe, it, expect } from "vitest";
import { Transform } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

const WOLF = "animal_wolf";
const defOf = (key: string): G.AnimalDef => G.animalDefs().find((d) => d.key === key)!;
const kindOf = (key: string): number => G.animalDefs().findIndex((d) => d.key === key);

function worldWithAnimalAI(): ReturnType<typeof makeWorld> {
  const w = makeWorld();
  w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem);
  return w;
}
const dist = (w: ReturnType<typeof makeWorld>, e: number, x: number, y: number): number => {
  const t = w.get(e, Transform)!;
  return Math.hypot(t.x - x, t.y - y);
};

describe("ADR-494 wolves hunt in packs", () => {
  it("tables: wolf only — the pack flag is data-driven, no other species has it", () => {
    expect(defOf(WOLF).pack).toBe(true);
    expect(G.animalDefs().filter((d) => d.pack).map((d) => d.key)).toEqual([WOLF]);
    expect(defOf("animal_bear").pack).toBe(false);
    expect(defOf("animal_dog_lab").pack).toBe(false);
    const base = G.populationData().ai;
    const errs = G.validateAiData({
      ...base,
      archetypes: { ...base.archetypes, animal_wolf: { ...base.archetypes.animal_wolf!, pack: "yes" } as never },
    });
    expect(errs.length).toBeGreaterThan(0);
  });

  it("packShareTarget: joins when the prey is within leashRange of the joining wolf", () => {
    const w = makeWorld();
    const a = G.spawnAnimal(w, WOLF, 401, 0);
    const b = G.spawnAnimal(w, WOLF, 406, 0);
    const live = [a, b];
    // No mate attacking yet: nothing to share.
    expect(G.packShareTarget(w, b, kindOf(WOLF), 406, 0, 7, live)).toBeUndefined();
    // A attacks a prey at (400, 0) — 6 tiles from B, inside B's leashRange.
    w.setField(a, G.Animal, "state", G.AnimalState.Attack);
    w.setField(a, G.Animal, "goalX", 400);
    w.setField(a, G.Animal, "goalY", 0);
    expect(G.packShareTarget(w, b, kindOf(WOLF), 406, 0, 7, live)).toEqual({ x: 400, y: 0 });
    // The radius is measured to the PREY, not the packmate: a prey 12 away does not draw B in.
    expect(G.packShareTarget(w, b, kindOf(WOLF), 412, 0, 7, live)).toBeUndefined();
    // An idle packmate shares nothing, and a wolf never shares with itself.
    w.setField(a, G.Animal, "state", G.AnimalState.Idle);
    expect(G.packShareTarget(w, b, kindOf(WOLF), 406, 0, 7, live)).toBeUndefined();
    expect(G.packShareTarget(w, b, kindOf(WOLF), 406, 0, 7, [b])).toBeUndefined();
    // A different kind attacking the same prey does not count — wolf only in v1.
    const bear = G.spawnAnimal(w, "animal_bear", 401, 0);
    w.setField(bear, G.Animal, "state", G.AnimalState.Attack);
    w.setField(bear, G.Animal, "goalX", 400);
    w.setField(bear, G.Animal, "goalY", 0);
    expect(G.packShareTarget(w, b, kindOf(WOLF), 406, 0, 7, [bear, b])).toBeUndefined();
  });

  it("a target-less wolf joins the hunt and closes in on the prey", () => {
    const w = worldWithAnimalAI();
    G.spawnPlayer(w, { x: 400, y: 0, maxWeight: 0, clientId: 1 });
    G.spawnAnimal(w, WOLF, 401, 0); // A: in range, attacks on its own
    const b = G.spawnAnimal(w, WOLF, 406, 0); // B: no own target (6 > 2.5), prey within share range 7
    // B's first think must come after A's attack (tick 1): a think on tick 1 would find A still
    // Idle and roll a 2-6 s thinkAt, pushing B's next think past the window. Delay it to tick 10.
    w.setField(b, G.Animal, "thinkAt", 10);
    steps(w, 60);
    expect(w.get(b, G.Animal)!.state).toBe(G.AnimalState.Attack);
    expect(dist(w, b, 400, 0)).toBeLessThan(2);
  });

  it("control: a wolf beyond share range does not join (and cannot wander into range in 60 ticks)", () => {
    const w = worldWithAnimalAI();
    G.spawnPlayer(w, { x: 400, y: 0, maxWeight: 0, clientId: 1 });
    G.spawnAnimal(w, WOLF, 401, 0);
    const b = G.spawnAnimal(w, WOLF, 410, 0); // prey 10 away > leashRange 7
    steps(w, 60);
    expect(w.get(b, G.Animal)!.state).not.toBe(G.AnimalState.Attack);
    expect(dist(w, b, 400, 0)).toBeGreaterThan(2.5);
  });

  it("a wolf with its own target keeps it instead of sharing", () => {
    const w = worldWithAnimalAI();
    G.spawnPlayer(w, { x: 400, y: 0, maxWeight: 0, clientId: 1 }); // P1: A's prey
    G.spawnPlayer(w, { x: 407, y: 0, maxWeight: 0, clientId: 2 }); // P2: B's own prey, 1 tile away
    G.spawnAnimal(w, WOLF, 401, 0); // A attacks P1
    const b = G.spawnAnimal(w, WOLF, 406, 0); // B attacks P2 on its own
    steps(w, 5);
    expect(w.get(b, G.Animal)!.state).toBe(G.AnimalState.Attack);
    // B is biting P2 in place, so its goal is its own position — the point is it is NOT A's
    // target (400): a sharing wolf's goal would be the pack's prey.
    expect(w.get(b, G.Animal)!.goalX).not.toBeCloseTo(400, 0);
  });

  it("a non-pack species does not share: a bear watches the hunt and stays out of it", () => {
    const w = worldWithAnimalAI();
    G.spawnPlayer(w, { x: 400, y: 0, maxWeight: 0, clientId: 1 });
    G.spawnAnimal(w, WOLF, 401, 0); // wolf attacks
    const bear = G.spawnAnimal(w, "animal_bear", 406, 0); // bear: prey 6 away, outside its own range 5
    steps(w, 5);
    expect(w.get(bear, G.Animal)!.state).not.toBe(G.AnimalState.Attack);
  });
});
