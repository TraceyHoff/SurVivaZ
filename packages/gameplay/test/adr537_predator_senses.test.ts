/**
 * ADR-537: predators hunt by noise and smell, like zombies. On its think tick, a hostile-mode
 * animal (the wolf; the zombies-off bear, whose ADR-536 override makes it hostile) investigates
 * a heard survivor (NoiseLevel x ai.json perception.hearingMul — today 1.4 wolf, 1.2 bear) or the
 * strongest nearby smell (strongestSmell(), max 8 emitters, threshold 0.25: carcass / rot / kill
 * loot bag / lit fire, plus dropped uncooked meat from this slice) instead of wandering. A heard
 * target is Investigated (walk to the noise at wander speed), never instantly chased — the bite
 * still goes through the animal's own `wants` check once the prey is in aggro range. Senses never
 * bypass the spawn safe radius, the tameable-initiation guard (ADR-354), or the leash/chase limit
 * (the goal must sit within pressHome of home). Carried meat never smells: only rot attaches to
 * an Inventory, so a player carrying raw meat does not draw predators (user ruling 2026-11-25:
 * no player scent — meat smell is a WORLD emitter only, on ground loot bags).
 */
import { describe, expect, it } from "vitest";
import { setTimeOfDay, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

const d = G.defaultDefs();
const WOLF = "animal_wolf";
const BEAR = "animal_bear";
const MOOSE = "animal_moose";
const RAW_MEAT = d.itemId("raw_meat");
const COOKED_MEAT = d.itemId("cooked_meat");
const ROT = d.itemId("rot");

const defOf = (key: string, zombiesOff = false): G.AnimalDef =>
  (zombiesOff ? G.animalDefsZombiesOff() : G.animalDefs()).find((a) => a.key === key)!;

function rig(zombies = true, hour = 12): World {
  const w = makeWorld({ worldRules: { zombies } });
  setTimeOfDay(w, hour, 0);
  w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem);
  return w;
}
const stateOf = (w: World, e: Entity): number => w.get(e, G.Animal)!.state;
const goalOf = (w: World, e: Entity): { x: number; y: number } => { const a = w.get(e, G.Animal)!; return { x: a.goalX, y: a.goalY }; };
const distTo = (w: World, e: Entity, x: number, y: number): number => { const t = w.get(e, Transform)!; return Math.hypot(t.x - x, t.y - y); };
/** The Smell emitter on an entity, if it carries one. */
const smellOf = (w: World, e: Entity): { radius: number; strength: number } | undefined => {
  const em = w.get(e, G.Emitter);
  return em && em.kind === G.EmitterKind.Smell ? { radius: em.radius, strength: em.strength } : undefined;
};
/** A bare smell source at (x, y) — a stand-in for a carcass / rot / fire in the unit tests. */
const smellSource = (w: World, x: number, y: number, radius: number, strength: number): Entity => {
  const e = w.create();
  w.add(e, Transform, { x, y }).add(e, G.Emitter, { kind: G.EmitterKind.Smell, radius, strength, falloff: 1 });
  return e;
};
/** A player that stands still and makes no noise of its own (no input, no movement). */
const quietPlayer = (w: World, x: number, y: number): Entity =>
  G.spawnPlayer(w, { x, y, maxWeight: 0, clientId: 1 });

describe("ADR-537 predators hunt by noise and smell", () => {
  it("tables: hearingMul is wired from ai.json perception (wolf 1.4, bear 1.2); Investigate is state 6; meat smell tuning", () => {
    expect(defOf(WOLF).hearingMul).toBe(1.4);
    expect(defOf(BEAR).hearingMul).toBe(1.2);
    expect(G.AnimalState.Investigate).toBe(6);
    const s = G.defaultDefs().ai.smell;
    expect(s.threshold).toBe(0.25);
    expect(s.meat).toEqual({ radius: 8, strength: 1 });
    // The pre-existing specs are untouched.
    expect(s.carcass).toEqual({ radius: 8, strength: 1 });
    expect(s.kill).toEqual({ radius: 6, strength: 0.8 });
    expect(s.fire).toEqual({ radius: 12, strength: 1 });
  });

  it("a wolf hears a loud survivor and investigates (walks to the noise, does not instantly attack)", () => {
    const w = rig(true, 12); // day: aggro range 0.625, so the 10-tile player is far outside it
    const p = quietPlayer(w, 400, 0);
    const wolf = G.spawnAnimal(w, WOLF, 410, 0);
    G.makeNoise(w, p, 12); // walk: heard at 12 x 1.4 = 16.8 tiles
    steps(w, 5);
    expect(stateOf(w, wolf)).toBe(G.AnimalState.Investigate);
    expect(goalOf(w, wolf).x).toBeCloseTo(400, 0);
    expect(goalOf(w, wolf).y).toBeCloseTo(0, 0);
    // It closes in at wander speed over the next seconds (and still has not bitten from range).
    steps(w, 60);
    expect(distTo(w, wolf, 400, 0)).toBeLessThan(8);
    expect(stateOf(w, wolf)).not.toBe(G.AnimalState.Attack);
  });

  it("hearing is noise-gated and hearingMul-gated: quiet noise at 10 tiles is nothing, at 6 it draws the wolf", () => {
    // Door noise (5) at 10 tiles: heard at 5 x 1.4 = 7 — out of earshot.
    const w1 = rig(true, 12);
    const p1 = quietPlayer(w1, 400, 0);
    const wolf1 = G.spawnAnimal(w1, WOLF, 410, 0);
    G.makeNoise(w1, p1, 5);
    steps(w1, 5);
    expect(stateOf(w1, wolf1)).not.toBe(G.AnimalState.Investigate);
    // The same quiet noise at 6 tiles: inside the 7-tile hearing range.
    const w2 = rig(true, 12);
    const p2 = quietPlayer(w2, 400, 0);
    const wolf2 = G.spawnAnimal(w2, WOLF, 406, 0);
    G.makeNoise(w2, p2, 5);
    steps(w2, 5);
    expect(stateOf(w2, wolf2)).toBe(G.AnimalState.Investigate);
    expect(goalOf(w2, wolf2).x).toBeCloseTo(400, 0);
  });

  it("a heard goal past the chase limit is not investigated (leash / chase limit still binds)", () => {
    const w = rig(true, 12);
    const p = quietPlayer(w, 400, 0);
    // Sprint noise (18) is heard at 18 x 1.4 = 25.2 tiles — but the goal is 15 tiles from the
    // wolf's home, past pressHome = min(leash 7 x 2, chaseLimit 18) = 14, so the wolf stays put.
    const wolf = G.spawnAnimal(w, WOLF, 415, 0);
    G.makeNoise(w, p, 18);
    steps(w, 5);
    expect(stateOf(w, wolf)).not.toBe(G.AnimalState.Investigate);
  });

  it("a wolf investigates a carcass smell and a rot smell; a below-threshold smell is ignored", () => {
    // The EmitterIndex refreshes in postSim, so each wolf's first think is pinned to tick 2 —
    // after the index has seen the smell source created at tick 0.
    const w1 = rig(true, 12);
    const wolf1 = G.spawnAnimal(w1, WOLF, 410, 0);
    smellSource(w1, 414, 0, 8, 1); // carcass: 4 tiles, 1 x (1 - 4/8) = 0.5 > 0.25
    w1.setField(wolf1, G.Animal, "thinkAt", 2);
    steps(w1, 5);
    expect(stateOf(w1, wolf1)).toBe(G.AnimalState.Investigate);
    expect(goalOf(w1, wolf1).x).toBeCloseTo(414, 0);
    const w2 = rig(true, 12);
    const wolf2 = G.spawnAnimal(w2, WOLF, 410, 0);
    smellSource(w2, 413, 0, 6, 1); // rot: 3 tiles, 1 x (1 - 3/6) = 0.5 > 0.25
    w2.setField(wolf2, G.Animal, "thinkAt", 2);
    steps(w2, 5);
    expect(stateOf(w2, wolf2)).toBe(G.AnimalState.Investigate);
    expect(goalOf(w2, wolf2).x).toBeCloseTo(413, 0);
    // Below threshold: carcass 7 tiles out contributes 1 x (1 - 7/8) = 0.125 < 0.25.
    const w3 = rig(true, 12);
    const wolf3 = G.spawnAnimal(w3, WOLF, 410, 0);
    smellSource(w3, 417, 0, 8, 1);
    w3.setField(wolf3, G.Animal, "thinkAt", 2);
    steps(w3, 5);
    expect(stateOf(w3, wolf3)).not.toBe(G.AnimalState.Investigate);
  });

  it("a wolf investigates a lit campfire's smoke", () => {
    const w = rig(true, 12);
    const wolf = G.spawnAnimal(w, WOLF, 410, 0);
    const sn = G.snapPlacement(w, { piece: d.pieceId("campfire"), x: 414.5, y: 0.5, level: 0, rot: 0, tier: 1, variant: 0 });
    if (typeof sn === "number") throw new Error(`snap campfire ${sn}`);
    const camp = G.placePiece(w, 0 as Entity, sn, { pay: false });
    const fire = G.attachmentsOf(w, camp).find((a) => w.has(a, G.Fuel))!;
    G.addItem(w, fire, d.itemId("coal"), 50);
    w.set(fire, G.Fuel, { lit: 1, burnUntilTick: 0 });
    G.setEmittersLit(w, fire, 1);
    // The wolf's first think must come after the fire's smell is up: pin it to tick 30.
    w.setField(wolf, G.Animal, "thinkAt", 30);
    steps(w, 40); // the fire's smell sibling lights up; the wolf's think fires
    expect(stateOf(w, wolf)).toBe(G.AnimalState.Investigate);
    expect(goalOf(w, wolf).x).toBeCloseTo(414.5, 0);
    expect(goalOf(w, wolf).y).toBeCloseTo(0.5, 0);
  });

  it("a wolf investigates dropped uncooked meat (ground bag, meat spec); cooked meat keeps the kill spec", () => {
    const w = rig(true, 12);
    const wolf = G.spawnAnimal(w, WOLF, 410, 0);
    // The real drop path: a Dropped loot bag at the wolf's feet holding raw meat.
    const bag = G.dropOwnedBag(w, { x: 414, y: 0, z: 0 }, 0, [{ item: RAW_MEAT, count: 2 }])!;
    // The wolf's first think must come after the spoilage pass (tick 20) attaches the smell.
    w.setField(wolf, G.Animal, "thinkAt", 30);
    steps(w, 40); // spoilage passes (every 20 ticks) attach the meat smell
    const s = smellOf(w, bag);
    expect(s).toBeDefined();
    expect(s!.radius).toBe(8);
    expect(s!.strength).toBeCloseTo(1, 5);
    expect(stateOf(w, wolf)).toBe(G.AnimalState.Investigate);
    expect(goalOf(w, wolf).x).toBeCloseTo(414, 0);
    // A bag holding only cooked meat (spoilable, not raw) keeps the kill spec, not meat.
    const w2 = rig(true, 12);
    const bag2 = G.dropOwnedBag(w2, { x: 414, y: 0, z: 0 }, 0, [{ item: COOKED_MEAT, count: 2 }])!;
    steps(w2, 40);
    const s2 = smellOf(w2, bag2);
    expect(s2).toBeDefined();
    expect(s2!.radius).toBe(6);
    expect(s2!.strength).toBeCloseTo(0.8, 5);
  });

  it("a kill's loot bag upgrades to the meat spec while it holds raw meat (ADR-486 kill spec at creation)", () => {
    const w = rig(true, 12);
    const prey = G.spawnAnimal(w, WOLF, 414, 0);
    const bag = G.dropAnimalLoot(w, prey)!; // wolf loot always has raw_meat (chance 1)
    expect(smellOf(w, bag)?.radius).toBe(6); // kill spec at creation (strength is f32)
    expect(smellOf(w, bag)?.strength).toBeCloseTo(0.8, 5);
    steps(w, 40);
    const s = smellOf(w, bag);
    expect(s).toBeDefined();
    expect(s!.radius).toBe(8); // meat spec once the spoilage pass has seen the raw meat
    expect(s!.strength).toBeCloseTo(1, 5);
  });

  it("carried meat does NOT attract: the carrier has no smell and the wolf does not investigate", () => {
    const w = rig(true, 12);
    const p = quietPlayer(w, 400, 0);
    G.addItem(w, p, RAW_MEAT, 3);
    const wolf = G.spawnAnimal(w, WOLF, 404, 0); // 4 tiles: outside the 0.625 day aggro range
    steps(w, 5);
    expect(stateOf(w, wolf)).not.toBe(G.AnimalState.Investigate);
    steps(w, 60); // spoilage passes run — carried meat must still not smell
    expect(smellOf(w, p)).toBeUndefined();
    expect(stateOf(w, wolf)).not.toBe(G.AnimalState.Investigate);
    // Control: the same player carrying rot DOES smell (pre-existing ADR-486 behaviour).
    const w2 = rig(true, 12);
    const p2 = quietPlayer(w2, 400, 0);
    G.addItem(w2, p2, ROT, 3);
    steps(w2, 60);
    expect(smellOf(w2, p2)).toBeDefined();
  });

  it("no acquisition inside the safe radius via senses: a loud player at home, or a smell at home, is ignored", () => {
    const w = rig(true, 12);
    G.setSpawnPoints(w, [{ x: 400, y: 0 }]);
    const p = quietPlayer(w, 400, 0); // inside the 20-tile safe radius of the spawn point
    const wolf = G.spawnAnimal(w, WOLF, 410, 0);
    G.makeNoise(w, p, 18); // sprint: heard at 25.2 tiles — but the player is safe
    steps(w, 5);
    expect(stateOf(w, wolf)).not.toBe(G.AnimalState.Investigate);
    // A smell inside the safe radius is ignored too.
    const w2 = rig(true, 12);
    G.setSpawnPoints(w2, [{ x: 400, y: 0 }]);
    const wolf2 = G.spawnAnimal(w2, WOLF, 410, 0);
    smellSource(w2, 405, 0, 8, 1); // carcass 5 tiles out: 0.375 > 0.25, but inside the radius
    w2.setField(wolf2, G.Animal, "thinkAt", 2); // first think after the EmitterIndex refresh
    steps(w2, 5);
    expect(stateOf(w2, wolf2)).not.toBe(G.AnimalState.Investigate);
  });

  it("a tameable animal never initiates via senses (ADR-354 guard holds for hearing and smell)", () => {
    // The moose is tameable (a mount species) with an attack — it must still never hunt by sense.
    const w1 = rig(true, 12);
    const p1 = quietPlayer(w1, 400, 0);
    const moose1 = G.spawnAnimal(w1, MOOSE, 410, 0);
    G.makeNoise(w1, p1, 18); // heard at 18 x 1.2 = 21.6 tiles if the moose could hear
    steps(w1, 5);
    expect(stateOf(w1, moose1)).not.toBe(G.AnimalState.Investigate);
    const w2 = rig(true, 12);
    const moose2 = G.spawnAnimal(w2, MOOSE, 410, 0);
    smellSource(w2, 414, 0, 8, 1);
    steps(w2, 5);
    expect(stateOf(w2, moose2)).not.toBe(G.AnimalState.Investigate);
  });

  it("senses work with zombies on and with zombies off", () => {
    for (const zombies of [true, false]) {
      const w = rig(zombies, 12);
      const p = quietPlayer(w, 400, 0);
      const wolf = G.spawnAnimal(w, WOLF, 410, 0);
      G.makeNoise(w, p, 12);
      steps(w, 5);
      expect(stateOf(w, wolf)).toBe(G.AnimalState.Investigate);
    }
  });

  it("the zombies-off bear hunts by noise; the zombies-on bear (territorial) does not", () => {
    // Off: the ADR-536 bear is hostile, so it investigates a walk heard at 12 x 1.2 = 14.4 tiles.
    const wOff = rig(false, 12);
    const pOff = quietPlayer(wOff, 400, 0);
    const bearOff = G.spawnAnimal(wOff, BEAR, 408, 0); // 8 tiles: inside hearing, outside the 2.0 day aggro range
    G.makeNoise(wOff, pOff, 12);
    steps(wOff, 5);
    expect(stateOf(wOff, bearOff)).toBe(G.AnimalState.Investigate);
    expect(goalOf(wOff, bearOff).x).toBeCloseTo(400, 0);
    // On: the same bear is territorial — it holds its ground and does not hunt by noise.
    const wOn = rig(true, 12);
    const pOn = quietPlayer(wOn, 400, 0);
    const bearOn = G.spawnAnimal(wOn, BEAR, 408, 0);
    G.makeNoise(wOn, pOn, 12);
    steps(wOn, 5);
    expect(stateOf(wOn, bearOn)).not.toBe(G.AnimalState.Investigate);
  });
});
