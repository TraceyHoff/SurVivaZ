// ADR-540: new predator species with full art — cougar + wolverine. Two solitary hostile
// hunters (pack: false, so they never join the ADR-539 pack director — packs stay wolf:bear
// 4:1). Both ship the ADR-537 senses (hearingMul from ai.json perception, zombie-style smell)
// and the ADR-538 night windows (aggroActivity 1.5x at night, nightFleeHpFrac 0), plus spawn
// entries with the ADR-536 zombies-off x3 boost. They are real predators: they engage, close
// in, and bite — they do not flee like the goofy wolf unless hurt below their flee line by day.
import { describe, expect, it } from "vitest";
import { installPermissions, PlayerId, setTimeOfDay, Transform, type Entity, type World } from "@engine/core";
import { Health } from "../src/components.js";
import * as G from "../src/index.js";
import { DamageCause } from "../src/index.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";

const COUGAR = "animal_cougar";
const WOLVERINE = "animal_wolverine";
/** AnimalState (const enum, not importable as a value in tests). */
const FLEE = 2;
const ATTACK = 3;
const stateOf = (w: World, e: Entity): number => w.getField(e, G.Animal, "state") ?? -1;
const hpOf = (w: World, e: Entity): number => w.get(e, Health)?.hp ?? 0;
const defOf = (key: string, zombiesOff = false): G.AnimalDef =>
  (zombiesOff ? G.animalDefsZombiesOff() : G.animalDefs()).find((d) => d.key === key)!;
const goalOf = (w: World, e: Entity): { x: number; y: number } => { const a = w.get(e, G.Animal)!; return { x: a.goalX, y: a.goalY }; };

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
/** A player that stands still and makes no noise of its own (no input, no movement). */
const quietPlayer = (w: World, x: number, y: number): Entity =>
  G.spawnPlayer(w, { x, y, maxWeight: 0, clientId: 1 });
/** A bare smell source at (x, y) — a stand-in for a carcass / rot / fire in the unit tests. */
const smellSource = (w: World, x: number, y: number, radius: number, strength: number): Entity => {
  const e = w.create();
  w.add(e, Transform, { x, y }).add(e, G.Emitter, { kind: G.EmitterKind.Smell, radius, strength, falloff: 1 });
  return e;
};
/** Default spawn table installed over chunk "12,0" (x [384,416), y [0,32)), player at its corner. */
const tableRig = (zombies: boolean): { w: World; sp: ReturnType<typeof G.installPopulation> } => {
  const w = makeWorld({ worldRules: { zombies } }); installPermissions(w);
  if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = spawnLearned(w, { x: 384, y: 0, maxWeight: 0, clientId: 1 });
  w.add(p, PlayerId, { id: 1 });
  const sp = G.installPopulation(w, { chunks: () => ["12,0"], viewpoints: () => [{ x: 384, y: 0 }], tileAt: () => 3, mode: "sp" });
  return { w, sp };
};

describe("ADR-540 new predators: defs", () => {
  it("cougar + wolverine load as hostile predators with their own stats, not wolf/bear copies", () => {
    const c = defOf(COUGAR), v = defOf(WOLVERINE);
    expect(c.aggro).toEqual({ mode: "hostile", range: 4, leashRange: 12 });
    expect(c.hp).toBe(120); expect(c.speed).toBeCloseTo(3.8 * 0.45, 5); // animalDefs stores wander speed
    expect(c.fleeSpeed).toBe(3.8); expect(c.attack).toMatchObject({ damage: 10, range: 1.2, cooldownSeconds: 1.3 });
    expect(c.fleeHpFrac).toBe(0.3); expect(c.fleeRange).toBe(10);
    expect(c.hearingMul).toBe(1.5); expect(c.pack).toBe(false);
    expect(v.aggro).toEqual({ mode: "hostile", range: 3, leashRange: 10 });
    expect(v.hp).toBe(90); expect(v.fleeSpeed).toBe(3.2); expect(v.attack).toMatchObject({ damage: 8, range: 1.0, cooldownSeconds: 1.2 });
    expect(v.fleeHpFrac).toBe(0.2); expect(v.fleeRange).toBe(8);
    expect(v.hearingMul).toBe(1.3); expect(v.pack).toBe(false);
    // Both are new species: distinct hp / speed / damage / range from the wolf (70 / 3.4 / 4 / 2.5)
    // and the bear (260 / 3.3 / 24 / 5); the wolf stays goofy and the bear stays territorial.
    const wolf = defOf("animal_wolf"), bear = defOf("animal_bear");
    expect([c.hp, v.hp]).not.toContain(wolf.hp);
    expect([c.attack!.damage, v.attack!.damage]).not.toContain(wolf.attack!.damage);
    expect(bear.aggro.mode).toBe("territorial");
    // Loot: meat + fur + bone + sinew, no mount/pet items; every row is a real item key.
    for (const d of [c, v]) {
      expect(d.loot.length).toBeGreaterThan(0);
      for (const l of d.loot) expect(l.item).toMatch(/^(raw_meat|raw_prime_cut|fur|fur_pelt|bone|sinew|animal_fat|hide)$/);
    }
    expect(c.loot.map((l) => l.item)).toContain("raw_prime_cut");
    expect(v.loot.map((l) => l.item)).toContain("animal_fat");
  });

  it("night windows: aggro 1.5x at night, 0.25x by day; never flee at night, flee when hurt by day", () => {
    for (const k of [COUGAR, WOLVERINE]) {
      const d = defOf(k);
      expect(G.aggroActivityMul(d, "night")).toBe(1.5);
      expect(G.aggroActivityMul(d, "dawn")).toBe(0.4);
      expect(G.aggroActivityMul(d, "day")).toBe(0.25);
      expect(G.aggroActivityMul(d, "dusk")).toBe(1);
      expect(G.activityMul(d, "night")).toBe(1);
      expect(G.activityMul(d, "day")).toBe(0.4);
      expect(d.nightFleeHpFrac).toBe(0);
    }
    // Effective ranges: cougar 4 -> 6.0 at night, 1.0 by day; wolverine 3 -> 4.5 / 0.75.
    expect(defOf(COUGAR).aggro.range * G.aggroActivityMul(defOf(COUGAR), "night")).toBeCloseTo(6, 5);
    expect(defOf(COUGAR).aggro.range * G.aggroActivityMul(defOf(COUGAR), "day")).toBeCloseTo(1, 5);
    expect(defOf(WOLVERINE).aggro.range * G.aggroActivityMul(defOf(WOLVERINE), "night")).toBeCloseTo(4.5, 5);
    expect(defOf(WOLVERINE).aggro.range * G.aggroActivityMul(defOf(WOLVERINE), "day")).toBeCloseTo(0.75, 5);
  });

  it("solo hunters: neither joins packs, and the pack director composition is still wolf:bear 4:1", () => {
    expect(defOf(COUGAR).pack).toBe(false);
    expect(defOf(WOLVERINE).pack).toBe(false);
    expect(G.PACKS.composition).toEqual({ animal_wolf: 4, animal_bear: 1 });
  });

  it("aggressive for the spawn safe radius, zombies on and off (hostile mode, not tameable)", () => {
    for (const k of [COUGAR, WOLVERINE]) {
      expect(G.isAggressiveSpawnKind(k, "animal", false)).toBe(true);
      expect(G.isAggressiveSpawnKind(k, "animal", true)).toBe(true);
    }
  });
});

describe("ADR-540 new predators: spawn table", () => {
  it("spawn entries exist (caps, groups, biomes); zombies-off boost x3 like wolf/bear", () => {
    const { sp } = tableRig(true);
    const c = sp.entry(COUGAR)!;
    expect(c).toMatchObject({ globalCap: 4, perChunkCap: 1, minPlayerDistance: 10, group: [1, 1] });
    expect(c.density).toBeCloseTo(0.08, 5); // base 0.05 x night 1.6
    const v = sp.entry(WOLVERINE)!;
    expect(v).toMatchObject({ globalCap: 6, perChunkCap: 2, minPlayerDistance: 10, group: [1, 2] });
    expect(v.density).toBeCloseTo(0.112, 5); // base 0.08 x night 1.4
    const off = tableRig(false).sp;
    expect(off.entry(COUGAR)).toMatchObject({ globalCap: 12, perChunkCap: 3 });
    expect(off.entry(COUGAR)!.density).toBeCloseTo(0.24, 5);
    expect(off.entry(WOLVERINE)).toMatchObject({ globalCap: 18, perChunkCap: 6 });
    expect(off.entry(WOLVERINE)!.density).toBeCloseTo(0.336, 5);
    // The boost is the same pure transform as ADR-536 (mp composes after the mode caps).
    const mp = G.applyZombiesOffPredatorBoost(G.toSpawnEntries("mp"));
    expect(mp.find((e) => e.kind === COUGAR)!.globalCap).toBe(18); // 4 -> 6 mp, x3
    expect(mp.find((e) => e.kind === WOLVERINE)!.globalCap).toBe(27); // 6 -> 9 mp, x3
  });

  it("data validates: new archetypes + spawn rows + boost entries pass the population validators", () => {
    expect(G.validateAiData(G.populationData().ai)).toEqual([]);
    expect(G.validateSpawnData(G.populationData().spawns)).toEqual([]);
  });
});

describe("ADR-540 new predators: senses (ADR-537)", () => {
  it("a cougar hears a walk at 12 x 1.5 = 18 tiles and investigates", () => {
    const w = rig(true, 12); // day: aggro range 1.0, so the 10-tile player is far outside it
    const p = quietPlayer(w, 400, 0);
    const cougar = G.spawnAnimal(w, COUGAR, 410, 0);
    G.makeNoise(w, p, 12); // walk: heard at 12 x 1.5 = 18 tiles
    steps(w, 5);
    expect(stateOf(w, cougar)).toBe(G.AnimalState.Investigate);
    expect(goalOf(w, cougar).x).toBeCloseTo(400, 0);
    expect(goalOf(w, cougar).y).toBeCloseTo(0, 0);
  });

  it("a wolverine hears at 12 x 1.3 = 15.6 tiles; a quiet noise out of earshot draws nothing", () => {
    const w1 = rig(true, 12);
    const p1 = quietPlayer(w1, 400, 0);
    const v1 = G.spawnAnimal(w1, WOLVERINE, 410, 0);
    G.makeNoise(w1, p1, 5); // door: heard at 5 x 1.3 = 6.5 — out of earshot at 10 tiles
    steps(w1, 5);
    expect(stateOf(w1, v1)).not.toBe(G.AnimalState.Investigate);
    const w2 = rig(true, 12);
    const p2 = quietPlayer(w2, 400, 0);
    const v2 = G.spawnAnimal(w2, WOLVERINE, 406, 0);
    G.makeNoise(w2, p2, 5); // same noise at 6 tiles: inside the 6.5-tile hearing range
    steps(w2, 5);
    expect(stateOf(w2, v2)).toBe(G.AnimalState.Investigate);
    expect(goalOf(w2, v2).x).toBeCloseTo(400, 0);
  });

  it("a cougar investigates a carcass smell the way a wolf does (zombie-style smell, no player scent)", () => {
    // The EmitterIndex refreshes in postSim, so the first think is pinned to tick 2 — after the
    // index has seen the smell source created at tick 0 (ADR-537 pattern).
    const w = rig(true, 12);
    const cougar = G.spawnAnimal(w, COUGAR, 410, 0);
    smellSource(w, 414, 0, 8, 1); // carcass: 4 tiles, 1 x (1 - 4/8) = 0.5 > 0.25
    w.setField(cougar, G.Animal, "thinkAt", 2);
    steps(w, 5);
    expect(stateOf(w, cougar)).toBe(G.AnimalState.Investigate);
    expect(goalOf(w, cougar).x).toBeCloseTo(414, 0);
  });
});

describe("ADR-540 new predators: live hunts", () => {
  it("a cougar engages at 5 tiles at night (inside 6.0) but not at 6.5 (outside)", () => {
    for (const [px, attacks] of [[405, true], [406.5, false]] as const) {
      const w = rig(true, 0);
      const p = playerAt(w, px);
      const cougar = G.spawnAnimal(w, COUGAR, 400, 0);
      const hp0 = hpOf(w, p);
      holdAt(w, cougar, p, 400, 0, px, 0, 3);
      if (attacks) expect(stateOf(w, cougar)).toBe(ATTACK);
      else {
        expect(stateOf(w, cougar)).not.toBe(ATTACK);
        expect(hpOf(w, p)).toBe(hp0);
      }
    }
  });

  it("a wolverine engages at 4 tiles at night (inside 4.5) but not at 5 (outside)", () => {
    for (const [px, attacks] of [[404, true], [405, false]] as const) {
      const w = rig(true, 0);
      const p = playerAt(w, px);
      const v = G.spawnAnimal(w, WOLVERINE, 400, 0);
      const hp0 = hpOf(w, p);
      holdAt(w, v, p, 400, 0, px, 0, 3);
      if (attacks) expect(stateOf(w, v)).toBe(ATTACK);
      else {
        expect(stateOf(w, v)).not.toBe(ATTACK);
        expect(hpOf(w, p)).toBe(hp0);
      }
    }
  });

  it("a night cougar closes in and bites (10 damage a hit, faster than the wolf)", () => {
    const w = rig(true, 0);
    const p = playerAt(w, 403.5);
    const cougar = G.spawnAnimal(w, COUGAR, 400, 0);
    const hp0 = hpOf(w, p);
    holdAtLive(w, cougar, p, 400, 0, 403.5, 0, 2);
    expect(stateOf(w, cougar)).toBe(ATTACK);
    steps(w, 120);
    expect(hpOf(w, p)).toBeLessThan(hp0);
  });

  it("a hurt cougar never flees at night but breaks off by day (flee line 30% hp)", () => {
    for (const [hour, want] of [[0, ATTACK], [12, FLEE]] as const) {
      const w = rig(true, hour);
      const p = playerAt(w, 403);
      const cougar = G.spawnAnimal(w, COUGAR, 400, 0);
      G.applyDamage(w, cougar, 90, p, DamageCause.Combat); // 30 / 120 hp — below the 30% flee line
      holdAt(w, cougar, p, 400, 0, 403, 0, 2);
      expect(stateOf(w, cougar)).toBe(want);
    }
  });

  it("a hurt wolverine never flees at night but breaks off by day (flee line 20% hp)", () => {
    for (const [hour, want] of [[0, ATTACK], [12, FLEE]] as const) {
      const w = rig(true, hour);
      const p = playerAt(w, 403);
      const v = G.spawnAnimal(w, WOLVERINE, 400, 0);
      G.applyDamage(w, v, 80, p, DamageCause.Combat); // 10 / 90 hp — below the 20% flee line
      holdAt(w, v, p, 400, 0, 403, 0, 2);
      expect(stateOf(w, v)).toBe(want);
    }
  });
});
