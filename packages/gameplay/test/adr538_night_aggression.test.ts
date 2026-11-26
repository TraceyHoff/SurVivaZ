// ADR-538: predators more aggressive at night, with a larger aggro range — and only at night.
// The aggro range now uses its own per-phase window (`aggroActivity`, ai.json) instead of the
// wander/activity window: wolf and bear engage at 1.5x range at night (wolf 2.5 -> 3.75, bear
// 5 -> 7.5) and at 0.25x by day (wolf 0.625, bear 1.25), so the day/night contrast reads.
// The wander share still uses `activity` (wolf night 1.0, day 0.4), so night hunters are not
// also night restless wanderers. Wolves never flee at night (`nightFleeHpFrac` 0); by day they
// still break off at 70% hp. This slice is NOT gated on the zombies toggle — night predators
// are scarier whether zombies are on or off — and it composes with ADR-536: a zombies-off
// bear's boosted range 8 is 12 at night and 2 by day. Zombies are out of scope (their
// day/night temperament already exists in `zombieAggressive()`); defensive/passive animals
// are unchanged (their aggro window defaults to their activity window).
import { describe, expect, it } from "vitest";
import { setTimeOfDay, Transform, type Entity, type World } from "@engine/core";
import { Health } from "../src/components.js";
import * as G from "../src/index.js";
import { DamageCause } from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

/** AnimalState (const enum, not importable as a value in tests). */
const FLEE = 2;
const ATTACK = 3;
const stateOf = (w: World, e: Entity): number => w.getField(e, G.Animal, "state") ?? -1;
const hpOf = (w: World, e: Entity): number => w.get(e, Health)?.hp ?? 0;
const defOf = (key: string, zombiesOff = false): G.AnimalDef =>
  (zombiesOff ? G.animalDefsZombiesOff() : G.animalDefs()).find((d) => d.key === key)!;

/** World with the animal AI running at the given hour (0 = night, 12 = day). */
const rig = (zombies: boolean, hour: number): World => {
  const w = makeWorld({ worldRules: { zombies } });
  w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem);
  setTimeOfDay(w, hour, 1);
  return w;
};
/** Hold the animal and the player at exact positions — a wandering animal would otherwise drift
 * into (or out of) range and make a boundary pin flaky (ADR-536 pattern). `thinkAt` is pinned
 * far in the future, so the animal never takes a think tick (never wanders/drinks/shares) while
 * the per-tick engagement decision (`wants`) still runs every tick. */
const holdAt = (w: World, animal: Entity, p: Entity, ax: number, ay: number, px: number, py: number, chunks: number): void => {
  for (let i = 0; i < chunks; i++) {
    w.set(animal, Transform, { x: ax, y: ay }); w.set(p, Transform, { x: px, y: py });
    w.setField(animal, G.Animal, "thinkAt", w.tick + 10000);
    steps(w, 20);
  }
};
/** Plain hold (ADR-536): think ticks run, so the animal can bite once it closes in. */
const holdAtLive = (w: World, animal: Entity, p: Entity, ax: number, ay: number, px: number, py: number, chunks: number): void => {
  for (let i = 0; i < chunks; i++) {
    w.set(animal, Transform, { x: ax, y: ay }); w.set(p, Transform, { x: px, y: py });
    steps(w, 20);
  }
};
const playerAt = (w: World, x: number): Entity => G.spawnPlayer(w, { x, y: 0, maxWeight: 0, clientId: 1 });

describe("ADR-538 night aggression: tables", () => {
  it("wolf and bear: aggro 1.5x at night, 0.25x by day; activity (wander) unchanged", () => {
    for (const k of ["animal_wolf", "animal_bear"]) {
      expect(G.aggroActivityMul(defOf(k), "night")).toBe(1.5);
      expect(G.aggroActivityMul(defOf(k), "dawn")).toBe(0.4);
      expect(G.aggroActivityMul(defOf(k), "day")).toBe(0.25);
      expect(G.aggroActivityMul(defOf(k), "dusk")).toBe(1);
      // The wander window is untouched: night 1.0 (share 0.5), day 0.4 (share 0.2).
      expect(G.activityMul(defOf(k), "night")).toBe(1);
      expect(G.activityMul(defOf(k), "dusk")).toBe(1);
      expect(G.activityMul(defOf(k), "day")).toBe(0.4);
      expect(G.activityMul(defOf(k), "dawn")).toBe(0.4);
    }
    // Effective ranges: wolf 2.5 -> 3.75 at night, 0.625 by day; bear 5 -> 7.5 / 1.25.
    expect(defOf("animal_wolf").aggro.range * G.aggroActivityMul(defOf("animal_wolf"), "night")).toBeCloseTo(3.75, 5);
    expect(defOf("animal_wolf").aggro.range * G.aggroActivityMul(defOf("animal_wolf"), "day")).toBeCloseTo(0.625, 5);
    expect(defOf("animal_bear").aggro.range * G.aggroActivityMul(defOf("animal_bear"), "night")).toBeCloseTo(7.5, 5);
    expect(defOf("animal_bear").aggro.range * G.aggroActivityMul(defOf("animal_bear"), "day")).toBeCloseTo(1.25, 5);
    // Night flee: only the wolf commits at night; the bear keeps its 0.1 by-day threshold.
    expect(defOf("animal_wolf").nightFleeHpFrac).toBe(0);
    expect(defOf("animal_bear").nightFleeHpFrac).toBeUndefined();
  });

  it("composition with ADR-536: the zombies-off bear's boosted range 8 is 12 at night, 2 by day", () => {
    const boosted = defOf("animal_bear", true);
    expect(boosted.aggro).toMatchObject({ mode: "hostile", range: 8, leashRange: 20 });
    expect(G.aggroActivityMul(boosted, "night")).toBe(1.5);
    expect(boosted.aggro.range * G.aggroActivityMul(boosted, "night")).toBeCloseTo(12, 5);
    expect(boosted.aggro.range * G.aggroActivityMul(boosted, "day")).toBeCloseTo(2, 5);
    // The night range (12) still fits inside the boosted leash (20) and the chase limit (18),
    // so the threat scan (max(fleeRange, leashRange)) always sees a target it could engage.
    expect(12).toBeLessThan(boosted.aggro.leashRange);
    expect(defOf("animal_wolf", true).aggro.range * G.aggroActivityMul(defOf("animal_wolf", true), "night")).toBeCloseTo(3.75, 5);
  });

  it("aggroActivity defaults to activity for every other species (defensive/passive unchanged)", () => {
    for (const k of ["animal_deer", "animal_moose", "animal_elk", "animal_bison", "animal_boar", "animal_snake", "animal_chicken", "animal_dog_lab", "animal_rabbit"]) {
      const def = defOf(k);
      for (const ph of ["night", "dawn", "day", "dusk"] as const) {
        expect(G.aggroActivityMul(def, ph)).toBe(G.activityMul(def, ph));
      }
      expect(def.nightFleeHpFrac).toBeUndefined();
    }
    // The sleepiness model is intact: a deer's defensive range is still 0.4x at night.
    expect(G.aggroActivityMul(defOf("animal_deer"), "night")).toBe(0.4);
    expect(G.aggroActivityMul(defOf("animal_snake"), "night")).toBe(0.4);
    expect(G.aggroActivityMul(defOf("animal_snake"), "day")).toBe(1);
  });

  it("validation: an aggro window is four phases in (0, 2]; a night flee threshold is a fraction", () => {
    const base = G.populationData().ai;
    const bad = (patch: Record<string, unknown>): string[] =>
      G.validateAiData({ ...base, archetypes: { ...base.archetypes, animal_wolf: { ...base.archetypes.animal_wolf!, ...patch } as never } });
    expect(bad({ aggroActivity: { night: 1.5, dawn: 0.4, day: 0.25, dusk: 1 } })).toEqual([]);
    expect(bad({ aggroActivity: { night: 2.5, dawn: 0.4, day: 0.25, dusk: 1 } }).join("\n")).toMatch(/aggroActivity\.night/);
    expect(bad({ aggroActivity: { night: 0, dawn: 0.4, day: 0.25, dusk: 1 } }).join("\n")).toMatch(/aggroActivity\.night/);
    expect(bad({ aggroActivity: { night: 1.5, day: 0.25 } }).join("\n")).toMatch(/aggroActivity/);
    expect(bad({ nightFleeHpFrac: 1.5 }).join("\n")).toMatch(/nightFleeHpFrac/);
    expect(bad({ nightFleeHpFrac: 0 })).toEqual([]);
  });
});

describe("ADR-538 live: wolf aggro range by phase", () => {
  it("a wolf engages at 3.5 tiles at night (inside 3.75) but not at 4.0 (outside)", () => {
    for (const [px, attacks] of [[403.5, true], [404, false]] as const) {
      const w = rig(true, 0);
      const p = playerAt(w, px);
      const wolf = G.spawnAnimal(w, "animal_wolf", 400, 0);
      const hp0 = hpOf(w, p);
      holdAt(w, wolf, p, 400, 0, px, 0, 3);
      if (attacks) expect(stateOf(w, wolf)).toBe(ATTACK);
      else {
        expect(stateOf(w, wolf)).not.toBe(ATTACK);
        expect(hpOf(w, p)).toBe(hp0);
      }
    }
  });

  it("the same night range applies with zombies off (not gated on the toggle)", () => {
    const w = rig(false, 0);
    const p = playerAt(w, 403.5);
    const wolf = G.spawnAnimal(w, "animal_wolf", 400, 0);
    holdAt(w, wolf, p, 400, 0, 403.5, 0, 3);
    expect(stateOf(w, wolf)).toBe(ATTACK);
  });

  it("by day a wolf engages at 0.5 tiles (inside 0.625) but not at 1.0 (outside)", () => {
    for (const [px, attacks] of [[400.5, true], [401, false]] as const) {
      const w = rig(true, 12);
      const p = playerAt(w, px);
      const wolf = G.spawnAnimal(w, "animal_wolf", 400, 0);
      const hp0 = hpOf(w, p);
      holdAt(w, wolf, p, 400, 0, px, 0, 3);
      if (attacks) expect(stateOf(w, wolf)).toBe(ATTACK);
      else {
        expect(stateOf(w, wolf)).not.toBe(ATTACK);
        expect(hpOf(w, p)).toBe(hp0);
      }
    }
  });

  it("a hurt wolf never flees at night but breaks off by day", () => {
    for (const [hour, want] of [[0, ATTACK], [12, FLEE]] as const) {
      const w = rig(true, hour);
      const p = playerAt(w, 403);
      const wolf = G.spawnAnimal(w, "animal_wolf", 400, 0);
      G.applyDamage(w, wolf, 50, p, DamageCause.Combat); // 20 / 70 hp — below the 70% flee line
      holdAt(w, wolf, p, 400, 0, 403, 0, 2);
      expect(stateOf(w, wolf)).toBe(want);
    }
  });

  it("a night wolf still bites: released from 3.5 tiles it closes in and draws blood", () => {
    const w = rig(true, 0);
    const p = playerAt(w, 403.5);
    const wolf = G.spawnAnimal(w, "animal_wolf", 400, 0);
    const hp0 = hpOf(w, p);
    holdAtLive(w, wolf, p, 400, 0, 403.5, 0, 2);
    expect(stateOf(w, wolf)).toBe(ATTACK);
    steps(w, 120);
    expect(hpOf(w, p)).toBeLessThan(hp0);
  });

  it("a wolf wanders no more at night than before (share still 0.5, not 0.75)", () => {
    const w = rig(true, 0);
    const wolf = G.spawnAnimal(w, "animal_wolf", 400, 0);
    let n = 0;
    for (let i = 0; i < 150; i++) {
      w.setField(wolf, G.Animal, "thinkAt", w.tick);
      steps(w, 1);
      if (stateOf(w, wolf) === 1) n++; // Wander
    }
    // Wander share 0.5: ~75 of 150 thinks (binomial sd ~6). A 1.5x activity leak would give
    // a 0.75 share (~112); the band below is >4 sd from 75 on both sides and ~2 sd under 112.
    expect(n).toBeGreaterThan(50);
    expect(n).toBeLessThan(100);
  });
});

describe("ADR-538 live: bear aggro range by phase", () => {
  it("a bear engages at 7 tiles at night (inside 7.5, outside the old 5) but not at 2 by day", () => {
    const night = rig(true, 0);
    const pn = playerAt(night, 407);
    const bn = G.spawnAnimal(night, "animal_bear", 400, 0);
    holdAt(night, bn, pn, 400, 0, 407, 0, 3);
    expect(stateOf(night, bn)).toBe(ATTACK);
    const day = rig(true, 12);
    const pd = playerAt(day, 402);
    const bd = G.spawnAnimal(day, "animal_bear", 400, 0);
    const hp0 = hpOf(day, pd);
    holdAt(day, bd, pd, 400, 0, 402, 0, 5);
    expect(stateOf(day, bd)).not.toBe(ATTACK);
    expect(hpOf(day, pd)).toBe(hp0);
  });

  it("a zombies-off bear engages at 11 tiles at night (inside 8 x 1.5 = 12) but not at 3 by day", () => {
    const night = rig(false, 0);
    const pn = playerAt(night, 411);
    const bn = G.spawnAnimal(night, "animal_bear", 400, 0);
    holdAt(night, bn, pn, 400, 0, 411, 0, 3);
    expect(stateOf(night, bn)).toBe(ATTACK);
    const day = rig(false, 12);
    const pd = playerAt(day, 403);
    const bd = G.spawnAnimal(day, "animal_bear", 400, 0);
    const hp0 = hpOf(day, pd);
    holdAt(day, bd, pd, 400, 0, 403, 0, 5);
    expect(stateOf(day, bd)).not.toBe(ATTACK);
    expect(hpOf(day, pd)).toBe(hp0);
  });
});

describe("ADR-538 defensive / territorial animals unchanged", () => {
  it("a hurt boar still engages at 2.5 tiles at night (unwindowed, range 3)", () => {
    const w = rig(true, 0);
    const p = playerAt(w, 402.5);
    const boar = G.spawnAnimal(w, "animal_boar", 400, 0);
    G.applyDamage(w, boar, 45, p, DamageCause.Combat); // 45 / 90 hp — hurt, above the 20% flee line
    holdAt(w, boar, p, 400, 0, 402.5, 0, 2);
    expect(stateOf(w, boar)).toBe(ATTACK);
  });

  it("a snake still will not strike at 1.0 tile at night (range 1.6 x 0.4) but does by day", () => {
    for (const [hour, attacks] of [[0, false], [12, true]] as const) {
      const w = rig(true, hour);
      const p = playerAt(w, 401);
      const snake = G.spawnAnimal(w, "animal_snake", 400, 0);
      const hp0 = hpOf(w, p);
      holdAt(w, snake, p, 400, 0, 401, 0, 3);
      if (attacks) expect(stateOf(w, snake)).toBe(ATTACK);
      else {
        expect(stateOf(w, snake)).not.toBe(ATTACK);
        expect(hpOf(w, p)).toBe(hp0);
      }
    }
  });
});
