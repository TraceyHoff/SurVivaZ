// ADR-536: more predators when zombies are off — wolf/bear spawn boost + bear aggression.
// With zombies off, the ~97 ambient zombies are gone, so the wolf/bear spawn entries scale up
// (density + caps x3, tunables in spawns.json `zombiesOff.predators`) and bears hunt instead of
// holding territory (ai.json `zombiesOff` override: hostile, range 8, leash 20, never flees).
// With zombies on, the spawn table and the bear are byte-identical to before this slice.
// Boosted bears count as aggressive for the safe radius, so they never spawn inside 20 tiles
// of a spawn point either.
import { describe, expect, it } from "vitest";
import { installPermissions, PlayerId, setTimeOfDay, Transform, type Entity, type World } from "@engine/core";
import { Health } from "../src/components.js";
import * as G from "../src/index.js";
import { DamageCause } from "../src/index.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";

/** AnimalState (const enum, not importable as a value in tests). */
const FLEE = 2;
const ATTACK = 3;
const stateOf = (w: World, e: Entity): number => w.getField(e, G.Animal, "state") ?? -1;
const hpOf = (w: World, e: Entity): number => w.get(e, Health)?.hp ?? 0;

/** Default spawn table installed over chunk "12,0" (x [384,416), y [0,32)), player at its corner. */
const tableRig = (zombies: boolean): { w: World; sp: ReturnType<typeof G.installPopulation> } => {
  const w = makeWorld({ worldRules: { zombies } }); installPermissions(w);
  if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = spawnLearned(w, { x: 384, y: 0, maxWeight: 0, clientId: 1 });
  w.add(p, PlayerId, { id: 1 });
  const sp = G.installPopulation(w, { chunks: () => ["12,0"], viewpoints: () => [{ x: 384, y: 0 }], tileAt: () => 3, mode: "sp" });
  return { w, sp };
};

describe("ADR-536 predator spawn boost when zombies are off", () => {
  it("zombies off: wolf/bear entries scale x3, other animals untouched, zombie entries absent", () => {
    const { sp } = tableRig(false);
    expect(sp.entry("zombie_walker")).toBeUndefined();
    const wolf = sp.entry("animal_wolf")!;
    expect(wolf).toMatchObject({ globalCap: 30, perChunkCap: 9, minPlayerDistance: 10, group: [1, 3] });
    expect(wolf.density).toBeCloseTo(0.81, 5); // base 0.15 x night 1.8 = 0.27, x3
    const bear = sp.entry("animal_bear")!;
    expect(bear).toMatchObject({ globalCap: 12, perChunkCap: 3, minPlayerDistance: 10, group: [1, 1] });
    expect(bear.density).toBeCloseTo(0.252, 5); // base 0.06 x night 1.4 = 0.084, x3
    // not predators, not boosted: the spawns.json numbers come through unchanged
    expect(sp.entry("animal_rabbit")!.globalCap).toBe(80);
    expect(sp.entry("animal_boar")!.globalCap).toBe(25);
    expect(sp.entry("animal_boar")!.density).toBeCloseTo(0.3, 5);
  });

  it("zombies on control: the table is the pre-ADR-536 table (wolf 10, bear 4, zombies present)", () => {
    const { sp } = tableRig(true);
    const wolf = sp.entry("animal_wolf")!;
    expect(wolf).toMatchObject({ globalCap: 10, perChunkCap: 3, minPlayerDistance: 10, group: [1, 3] });
    expect(wolf.density).toBeCloseTo(0.27, 5);
    const bear = sp.entry("animal_bear")!;
    expect(bear).toMatchObject({ globalCap: 4, perChunkCap: 1, minPlayerDistance: 10, group: [1, 1] });
    expect(bear.density).toBeCloseTo(0.084, 5);
    expect(sp.entry("zombie_walker")!.globalCap).toBe(60);
  });

  it("the boost is a pure table transform: it composes after the mode caps and leaves zombies alone", () => {
    const sp = G.applyZombiesOffPredatorBoost(G.toSpawnEntries("sp"));
    expect(sp.find((e) => e.kind === "animal_wolf")!.globalCap).toBe(30);
    expect(sp.find((e) => e.kind === "animal_bear")!.globalCap).toBe(12);
    expect(sp.find((e) => e.kind === "animal_rabbit")!.globalCap).toBe(80);
    // zombie entries pass through the boost untouched (installPopulation filters them, not the boost)
    expect(sp.find((e) => e.kind === "zombie_walker")!.globalCap).toBe(60);
    // mp caps first (wolf 10 -> 15, bear 4 -> 6), then the x3 boost
    const mp = G.applyZombiesOffPredatorBoost(G.toSpawnEntries("mp"));
    expect(mp.find((e) => e.kind === "animal_wolf")!.globalCap).toBe(45);
    expect(mp.find((e) => e.kind === "animal_bear")!.globalCap).toBe(18);
    // no data block, no boost: a table without zombiesOff comes back identical
    const raw = G.toSpawnEntries("sp");
    const noBoost = { ...G.populationData().spawns }; delete noBoost.zombiesOff;
    expect(G.applyZombiesOffPredatorBoost(raw, noBoost)).toEqual(raw);
  });

  it("bad boost data is rejected: a non-animal kind or a negative multiplier fails validation", () => {
    const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
    const d = clone(G.populationData().spawns);
    d.zombiesOff = { predators: { zombie_walker: { densityMul: 3, capMul: 3 } } };
    expect(G.validateSpawnData(d, G.populationData().ai).join("\n")).toMatch(/not an animal archetype/);
    const d2 = clone(G.populationData().spawns);
    d2.zombiesOff = { predators: { animal_wolf: { densityMul: -1 } } };
    expect(G.validateSpawnData(d2, G.populationData().ai).join("\n")).toMatch(/densityMul/);
    const ai = clone(G.populationData().ai);
    ai.archetypes.animal_bear!.zombiesOff = { aggro: { mode: "hostile", range: 9, leashRange: 5 } };
    expect(G.validateAiData(ai).join("\n")).toMatch(/zombiesOff.aggro ranges/);
  });
});

describe("ADR-536 bear aggression when zombies are off", () => {
  it("the boosted defs turn only the bear hostile (range 8, leash 20, never flees); base defs unchanged", () => {
    const base = new Map(G.animalDefs().map((a) => [a.key, a]));
    const boosted = new Map(G.animalDefsZombiesOff().map((a) => [a.key, a]));
    expect(base.get("animal_bear")!.aggro).toMatchObject({ mode: "territorial", range: 5, leashRange: 14 });
    expect(base.get("animal_bear")!.fleeHpFrac).toBe(0.1);
    expect(boosted.get("animal_bear")!.aggro).toMatchObject({ mode: "hostile", range: 8, leashRange: 20 });
    expect(boosted.get("animal_bear")!.fleeHpFrac).toBe(0);
    // every other species is the same def in both arrays (no override)
    for (const [k, def] of base) {
      if (k === "animal_bear") continue;
      expect(boosted.get(k)).toEqual(def);
    }
    expect(boosted.get("animal_wolf")!.aggro).toMatchObject({ mode: "hostile", range: 2.5, leashRange: 7 });
  });

  /** Bear at home (0,0), player `dist` tiles away at night: outside the territorial range 5 but
   * inside the boosted hostile range 8. The hold keeps the distance exactly `dist` — a wandering
   * bear would otherwise drift into (or out of) range and make the control flaky. */
  const huntRig = (zombies: boolean, dist = 7): { w: World; p: Entity; bear: Entity } => {
    const w = makeWorld({ worldRules: { zombies } });
    w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem);
    if (!w.isRegistered(PlayerId)) w.register(PlayerId);
    const p = G.spawnPlayer(w, { x: dist, y: 0, maxWeight: 0, clientId: 7 });
    w.add(p, PlayerId, { id: 7 });
    setTimeOfDay(w, 0, 0); // night: activity 1.0, so the range is the def's range, not the 0.4x day value
    const bear = G.spawnAnimal(w, "animal_bear", 0, 0);
    return { w, p, bear };
  };
  const holdAt = (w: World, bear: Entity, p: Entity, chunks: number, dist = 7, pinThink = false): void => {
    for (let i = 0; i < chunks; i++) {
      w.set(bear, Transform, { x: 0, y: 0 }); w.set(p, Transform, { x: dist, y: 0 });
      // ADR-538: the control sits 0.5 tiles outside the new 7.5 night range, so a single wander
      // step toward the player could cross it — pin thinkAt so the bear never takes a think tick.
      if (pinThink) w.setField(bear, G.Animal, "thinkAt", w.tick + 10000);
      steps(w, 20);
    }
  };

  it("a bear hunts a player 7 tiles away when zombies are off, and closes in to bite", () => {
    const { w, p, bear } = huntRig(false);
    const hp0 = hpOf(w, p);
    holdAt(w, bear, p, 2); // held at 7 tiles: already inside the boosted range 8
    expect(stateOf(w, bear)).toBe(ATTACK);
    // released, the bear closes the 7 tiles at full speed and bites (24 damage)
    steps(w, 120);
    expect(stateOf(w, bear)).toBe(ATTACK);
    expect(hpOf(w, p)).toBeLessThan(hp0);
  });

  it("control: the same bear at 8 tiles holds its territory when zombies are on", () => {
    const { w, p, bear } = huntRig(true, 8);
    const hp0 = hpOf(w, p);
    holdAt(w, bear, p, 5, 8, true); // 5 s held at 8 tiles — outside the ADR-538 night range 7.5
    expect(stateOf(w, bear)).not.toBe(ATTACK);
    expect(hpOf(w, p)).toBe(hp0);
  });

  it("a hurt bear never flees when zombies are off, and flees at 5% hp when they are on", () => {
    const { w, p, bear } = huntRig(false);
    G.applyDamage(w, bear, 247, p, DamageCause.Combat); // 13 / 260 hp
    holdAt(w, bear, p, 2);
    expect(stateOf(w, bear)).toBe(ATTACK); // fleeHpFrac 0: a mauled bear still hunts
    const on = huntRig(true);
    G.applyDamage(on.w, on.bear, 247, on.p, DamageCause.Combat);
    holdAt(on.w, on.bear, on.p, 2);
    expect(stateOf(on.w, on.bear)).toBe(FLEE); // base fleeHpFrac 0.1: 13 hp is below 26
  });
});

describe("ADR-536 safe radius still excludes boosted predators", () => {
  it("a boosted bear counts as aggressive for spawning only when zombies are off", () => {
    expect(G.isAggressiveSpawnKind("animal_bear", "animal")).toBe(false);
    expect(G.isAggressiveSpawnKind("animal_bear", "animal", false)).toBe(false);
    expect(G.isAggressiveSpawnKind("animal_bear", "animal", true)).toBe(true);
    expect(G.isAggressiveSpawnKind("animal_wolf", "animal", true)).toBe(true);
    expect(G.isAggressiveSpawnKind("animal_wolf", "animal")).toBe(true);
    expect(G.isAggressiveSpawnKind("animal_boar", "animal", true)).toBe(false); // defensive, not boosted
  });

  /** The ADR-348 bed rig: four owned beds at the quarter-centres of chunk "12,0" put every tile
   * in the chunk within ~13 tiles of a beside-bed centre, so the whole chunk is inside the
   * 20-tile safe radius. Wolf/bear entries at density 1 spawn freely without beds. */
  const wolf = { kind: "animal_wolf", category: "animal", density: 1, timeWeights: { day: 1, night: 1, dawn: 1, dusk: 1 }, minPlayerDistance: 10, perChunkCap: 5, globalCap: 50, despawnDistance: 70, group: [1, 1] as [number, number] };
  const bear = { kind: "animal_bear", category: "animal", density: 1, timeWeights: { day: 1, night: 1, dawn: 1, dusk: 1 }, minPlayerDistance: 10, perChunkCap: 5, globalCap: 50, despawnDistance: 70, group: [1, 1] as [number, number] };
  const placeBed = (w: World, pid: number, x: number, y: number): Entity => {
    const bed = [...G.gameplayDefs(w).pieces.values()].find((p) => p.key === "bed")!;
    const b = w.create();
    w.add(b, Transform, { x, y }).add(b, G.BuildPiece, { type: bed.id } as never).add(b, G.PieceOwner, { player: pid });
    return b;
  };
  const safeRig = (withBeds: boolean): { w: World; sp: ReturnType<typeof G.installPopulation> } => {
    const w = makeWorld({ worldRules: { zombies: false } }); installPermissions(w);
    if (!w.isRegistered(PlayerId)) w.register(PlayerId);
    const p = spawnLearned(w, { x: 384, y: 0, maxWeight: 0, clientId: 1 });
    w.add(p, PlayerId, { id: 1 });
    if (withBeds) for (const [x, y] of [[392, 8], [408, 8], [392, 24], [408, 24]] as const) placeBed(w, 1, x, y);
    G.installBedRespawn(w);
    const sp = G.installPopulation(w, { chunks: () => ["12,0"], viewpoints: () => [{ x: 384, y: 0 }], spawns: [wolf, bear], tileAt: () => 3 });
    return { w, sp };
  };

  it("no boosted wolf or bear spawns in a chunk covered by beds", () => {
    const { w, sp } = safeRig(true);
    for (let i = 0; i < 10; i++) sp.step();
    expect([...w.query([G.Animal, Transform])]).toHaveLength(0);
  });
  it("control: the same chunk spawns boosted wolves and bears with no beds", () => {
    const { w, sp } = safeRig(false);
    for (let i = 0; i < 10; i++) sp.step();
    const animals = [...w.query([G.Animal, Transform])];
    expect(animals.length).toBeGreaterThan(0);
    const kinds = new Set(animals.map((e) => G.animalDefs()[w.getField(e, G.Animal, "kind")!]?.key));
    expect(kinds.has("animal_wolf") || kinds.has("animal_bear")).toBe(true);
  });
});
