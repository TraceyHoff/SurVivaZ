import { describe, expect, it } from "vitest";
import { PlayerId, setTimeOfDay, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { DamageCause, Health, spawnPlayer, spawnZombie, ZombieBrain, ZState } from "../src/index.js";
import { collect, DT, makeWorld, spawnLearned, steps } from "./helpers.js";

const pid = (w: World, e: Entity, id: number): void => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); };
const setup = (px = 0, py = 0): { w: World; p: Entity; id: (k: string) => number } => {
  const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem); // not installed by installGameplay (Task 14 pattern)
  const p = G.spawnPlayer(w, { x: px, y: py, maxWeight: 0, clientId: 7 }); pid(w, p, 7);
  w.add(p, G.Tribe, { id: 5 });
  return { w, p, id: (k) => G.gameplayDefs(w).itemId(k) };
};
/** AnimalState.Attack (const enum, not importable as a value in tests). */
const ATTACK = 3;
const stateOf = (w: World, e: Entity): number => w.getField(e, G.Animal, "state") ?? -1;
const hpOf = (w: World, e: Entity): number => w.get(e, Health)?.hp ?? 0;
/** Keep the animal 1 tile from the player in short chunks: wander would otherwise drift it out of range. */
const holdNear = (w: World, a: Entity, px: number, py: number, chunks: number): void => {
  for (let i = 0; i < chunks; i++) {
    w.set(a, Transform, { x: px + 1, y: py });
    steps(w, 20);
    expect(stateOf(w, a), `attack after chunk ${i}`).not.toBe(ATTACK);
  }
};
const claim = (w: World, x: number, y: number, radius = 10, tribe = 5): Entity => {
  const z = w.create();
  w.add(z, Transform, { x, y }).add(z, G.PrivilegeZone, { radius, tribe }); G.indexEntity(w, z);
  return z;
};
const place = (w: World, b: Entity | undefined, key: string, x: number, y: number): Entity => {
  const d = G.defaultDefs();
  const sn = G.snapPlacement(w, { piece: d.pieceId(key)!, x, y, level: 0, rot: 0, tier: 0, variant: 0 });
  if (typeof sn !== "object") throw new Error(`snap ${key} ${sn}`);
  return G.placePiece(w, b ?? 0, sn, { pay: false });
};
const boxOf = (w: World, piece: Entity): Entity => G.attachmentsOf(w, piece).find((a) => w.has(a, G.Container))!;

describe("ADR-354 tameable animals don't attack on sight", () => {
  it("the tameable set is exactly mounts + pets + husbandry, every key is a real animal, and no tameable is hostile/territorial in data", () => {
    const expected = new Set([
      ...G.MOUNT_SPECIES.flatMap((s) => s.animals.map((a) => a.key)),
      ...G.PET_SPECIES.map((s) => s.animal),
      ...Object.keys(G.SKILLS.husbandry.animals),
    ]);
    expect(new Set(G.TAMEABLE_ANIMAL_KEYS)).toEqual(expected);
    const defs = new Map(G.animalDefs().map((a) => [a.key, a]));
    for (const k of G.TAMEABLE_ANIMAL_KEYS) {
      const def = defs.get(k); expect(def, k).toBeDefined();
      expect(["defensive", "passive"], `${k} aggro.mode`).toContain(def!.aggro.mode);
      expect(G.isTameableAnimalKey(k)).toBe(true);
    }
    expect(G.isTameableAnimalKey("animal_moose")).toBe(true);
    for (const k of ["animal_wolf", "animal_bear", "animal_snake", "animal_boar"]) expect(G.isTameableAnimalKey(k), k).toBe(false);
    // the data pin that matters most: the moose is defensive now (was territorial), range/leash untouched
    expect(defs.get("animal_moose")!.aggro).toMatchObject({ mode: "defensive", range: 2, leashRange: 12 });
    // genuinely hostile by design: wolf (hostile animal) and zombies stay aggressive; the moose does not count
    expect(G.isAggressiveSpawnKind("animal_wolf", "animal")).toBe(true);
    expect(G.isAggressiveSpawnKind("zombie_walker", "zombie")).toBe(true);
    expect(G.isAggressiveSpawnKind("animal_moose", "animal")).toBe(false);
  });

  it("no tameable species initiates an attack on a nearby player over a sustained period", () => {
    for (const key of G.TAMEABLE_ANIMAL_KEYS) {
      const { w, p } = setup();
      const hp0 = hpOf(w, p);
      const a = G.spawnAnimal(w, key, 1, 0);
      holdNear(w, a, 0, 0, 5); // 5 x 20 ticks = 5 s held at 1 tile
      expect(hpOf(w, p), key).toBe(hp0);
    }
  });

  it("the moose specifically never attacks on sight: 30 s at 1 tile from a player, and from an AI human", () => {
    const { w, p } = setup();
    const hp0 = hpOf(w, p);
    const moose = G.spawnAnimal(w, "animal_moose", 1, 0);
    holdNear(w, moose, 0, 0, 30); // 30 s at 1 tile — inside its old territorial range 2
    expect(hpOf(w, p)).toBe(hp0);
    // an AI human is just another living survivor to the animal AI: same rule, same distance
    const { w: w2 } = setup(40, 0);
    const bot = G.spawnPlayer(w2, { x: 0, y: 0, maxWeight: 0, clientId: 8 }); pid(w2, bot, 8);
    const bhp0 = hpOf(w2, bot);
    const moose2 = G.spawnAnimal(w2, "animal_moose", 1, 0);
    holdNear(w2, moose2, 0, 0, 30);
    expect(hpOf(w2, bot)).toBe(bhp0);
  });

  it("every tameable species with an attack still retaliates when hurt by its attacker", () => {
    for (const def of G.animalDefs()) {
      if (!G.isTameableAnimalKey(def.key) || !def.attack || def.aggro.mode === "passive") continue;
      const { w, p } = setup();
      // outside every aggro.range but inside leashRange: only retaliation can engage here
      const d = Math.min(8, def.aggro.leashRange * 0.5);
      expect(d, `${def.key}: leash ${def.aggro.leashRange}`).toBeGreaterThan(def.aggro.range);
      const a = G.spawnAnimal(w, def.key, 0, 0);
      w.set(p, Transform, { x: d, y: 0 });
      steps(w, 2);
      expect(stateOf(w, a), `${def.key}: unprovoked`).not.toBe(ATTACK);
      G.applyDamage(w, a, 1, p, DamageCause.Combat);
      steps(w, 5);
      expect(stateOf(w, a), `${def.key}: retaliation`).toBe(ATTACK);
    }
  });

  it("the wolf still attacks on sight, and a night zombie still hunts the player (hordes exempt as before)", () => {
    const { w, p } = setup();
    const hp0 = hpOf(w, p);
    const wolf = G.spawnAnimal(w, "animal_wolf", 1.2, 0);
    steps(w, 40);
    expect(stateOf(w, wolf)).toBe(ATTACK);
    expect(hpOf(w, p)).toBeLessThan(hp0);
    const w2 = makeWorld(); setTimeOfDay(w2, 0, 0); // night: aggressive
    const p2 = spawnPlayer(w2, { x: 10, y: 10 });
    const z = spawnZombie(w2, "zombie_walker", 13, 10);
    const zhp0 = hpOf(w2, p2);
    steps(w2, 20);
    expect(w2.getField(z, ZombieBrain, "state")).toBe(ZState.Chase);
    expect(w2.getField(z, ZombieBrain, "target")).toBe(p2);
    steps(w2, 400);
    expect(hpOf(w2, p2)).toBeLessThan(zhp0);
  });

  it("a tameable moose near a base triggers no defence response; a zombie in the same spot does", () => {
    const d = G.defaultDefs();
    const { w, p } = setup(9, 9);
    const t = place(w, p, "arrow_turret", 10, 10);
    G.addItem(w, boxOf(w, t), d.itemId("flint_arrow"), 3);
    const moose = G.spawnAnimal(w, "animal_moose", 15, 10);
    const mhp0 = hpOf(w, moose);
    const fired = collect(w, G.TurretFired);
    expect(G.isHostileTo(w, t, moose)).toBe(false);
    steps(w, 20 * 5);
    expect(fired.length).toBe(0);
    expect(hpOf(w, moose)).toBe(mhp0);
    // claim threat assessment is zombies-only too: the moose is not a claim hostile, the zombie is
    claim(w, 10, 0, 10, 5);
    const mooseIn = G.spawnAnimal(w, "animal_moose", 10, 0);
    expect(G.nearestClaimHostile(w, 10, 0, 8, 5)).toBeUndefined();
    const zIn = spawnZombie(w, "zombie_walker", 12, 0);
    expect(G.nearestClaimHostile(w, 10, 0, 8, 5)).toBe(zIn);
    void mooseIn;
    // control: the same turret, same spot, same ammo shoots a zombie
    const w2 = makeWorld(); setTimeOfDay(w2, 12, 0);
    const owner = G.spawnPlayer(w2, { x: 9, y: 9 }); w2.set(owner, G.Health, { hp: 1e6, max: 1e6 });
    const t2 = place(w2, owner, "arrow_turret", 10, 10);
    G.addItem(w2, boxOf(w2, t2), d.itemId("flint_arrow"), 3);
    const z2 = spawnZombie(w2, "zombie_walker", 15, 10); w2.set(z2, G.Health, { hp: 1e4, max: 1e4 });
    const fired2 = collect(w2, G.TurretFired);
    steps(w2, 20 * 5);
    expect(fired2.length).toBe(3);
    expect(fired2.every((e) => e.target === z2)).toBe(true);
  });

  it("taming still works: a moose tames by feeding (spook / kick path intact)", () => {
    const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
    const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }); pid(w, p, 7);
    const id = (k: string): number => G.gameplayDefs(w).itemId(k);
    const moose = G.spawnAnimal(w, "animal_moose", 1, 0);
    G.addItem(w, p, id("apple"), 120);
    const ev = collect(w, G.MountEvent);
    for (let i = 0; i < 120 && !w.has(moose, G.Mount); i++) {
      w.set(p, Transform, { x: 0, y: 0 }); w.set(moose, Transform, { x: 1, y: 0 });
      G.feedMount(w, p, moose, id("apple")); w.step(DT);
    }
    expect(w.has(moose, G.Mount)).toBe(true);
    expect(w.getField(moose, G.Mount, "owner")).toBe(7);
    expect(ev.some((x) => x.result === G.MountResult.Tamed)).toBe(true);
    expect(ev.some((x) => x.result === G.MountResult.Progress)).toBe(true);
  });
});
