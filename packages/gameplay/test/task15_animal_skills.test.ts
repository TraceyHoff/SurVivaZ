import { describe, expect, it } from "vitest";
import { PlayerId, setTimeOfDay, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

const pid = (w: World, e: Entity, id: number): void => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); };
const setup = (px = 0, py = 0): { w: World; p: Entity; id: (k: string) => number } => {
  const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem); // not installed by installGameplay (Task 14 pattern)
  const p = G.spawnPlayer(w, { x: px, y: py, maxWeight: 0, clientId: 7 }); pid(w, p, 7);
  w.add(p, G.Tribe, { id: 5 });
  return { w, p, id: (k) => G.gameplayDefs(w).itemId(k) };
};
const tame = (w: World, p: Entity, a: Entity, item: number): void => {
  G.addItem(w, p, item, 50);
  for (let i = 0; i < 40 && !w.has(a, G.Pet); i++) { G.offerTreat(w, p, a, item); w.step(1 / 20); }
};
const pos = (w: World, e: Entity): { x: number; y: number } => w.get(e, Transform)!;
const trough = (w: World, x = 2, y = 0): Entity => {
  const tr = w.create();
  w.add(tr, Transform, { x, y }).add(tr, G.BuildPiece, { type: G.gameplayDefs(w).pieceId(G.SKILLS.husbandry.trough) }).add(tr, G.Container, { slotCount: 8 });
  G.indexEntity(w, tr); return tr;
};
const tamedCow = (w: World, p: Entity, x: number, y: number, over: Partial<{ produceAt: number; fedUntil: number }> = {}): Entity => {
  const a = G.spawnAnimal(w, "animal_cow", x, y); const kind = w.get(a, G.Animal)!.kind;
  w.add(a, G.Tamed, { kind, owner: p, fedUntil: over.fedUntil ?? w.tick + 100000, produceAt: over.produceAt ?? w.tick + 100000, breedAt: w.tick + 100000 });
  return a;
};
const claim = (w: World, x: number, y: number, radius = 10, tribe = 5): Entity => {
  const z = w.create();
  w.add(z, Transform, { x, y }).add(z, G.PrivilegeZone, { radius, tribe }); G.indexEntity(w, z);
  return z;
};
/** Grant the player Husbandry 2 ("pens") so trough production is not gated by canUsePens (ADR-234 pattern). */
const pens = (w: World, p: Entity): void => {
  for (const k of G.TREE_KEYS) G.grantTreePoints(w, p, k, 5000 - G.treePoints(w, p, k));
  const unlock = (i: number): void => { for (const r of G.SKILL_REQS[i]!) unlock(r); const why = G.unlockSkill(w, p, i); if (why) throw new Error(`unlock ${G.SKILLS.nodes[i]!.key}: ${why}`); };
  unlock(G.SKILLS.nodes.findIndex((n) => n.key === "husbandry_pens"));
};
/** AnimalState.Attack (const enum, not importable as a value in tests). */
const ATTACK = 3;

describe("animal skill trees (Task 15)", () => {
  it("every tameable / farmable species has a valid tree (26 kinds, no strays)", () => {
    const { w } = setup();
    const defs = G.gameplayDefs(w);
    const petKinds = G.PET_SPECIES.map((s) => s.animal);
    const farmKinds = Object.keys(G.SKILLS.husbandry.animals);
    const roster = new Set([...petKinds, ...farmKinds]);
    expect(roster.size).toBe(26);
    expect(defs.animalSkills.size).toBe(26);
    const EFFECTS = new Set(["produce", "produceSpeed", "fertility", "damage", "health", "speed"]);
    for (const kind of roster) {
      const tree = defs.animalSkillTree(kind);
      expect(tree, kind).toBeDefined();
      expect(tree!.nodes.length).toBeGreaterThanOrEqual(1);
      expect(tree!.nodes.length).toBeLessThanOrEqual(32);
      const keys = new Set<string>();
      tree!.nodes.forEach((n, i) => {
        expect(keys.has(n.key), `${kind}.${n.key} duplicate`).toBe(false); keys.add(n.key);
        expect(n.cost).toBeGreaterThanOrEqual(1);
        expect(EFFECTS.has(n.effect.type), `${kind}.${n.key} effect`).toBe(true);
        if (n.requires !== null) {
          const reqIdx = tree!.nodes.findIndex((o) => o.key === n.requires);
          expect(reqIdx).toBeGreaterThanOrEqual(0); expect(reqIdx).toBeLessThan(i); // prereq is an earlier rank
        }
      });
    }
    // spot checks: the user's cow example, and the shared chicken tree
    const cow = defs.animalSkillTree("animal_cow")!;
    expect(cow.nodes.filter((n) => n.effect.type === "produce").length).toBe(3); // Milk Production I/II/III
    expect(cow.nodes[0]!.name).toBe("Milk Production");
    expect(defs.animalSkillTree("animal_chicken")!.nodes.some((n) => n.effect.type === "produce")).toBe(true);
  });

  it("skill points land exactly at levels 1, 6, 11, 16 (and nowhere else)", () => {
    const expected = [1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4];
    for (let level = 1; level <= 20; level++) expect(G.pointsForAnimalLevel(level)).toBe(expected[level - 1]);
    const deltas = expected.map((v, i) => (i === 0 ? v : v - expected[i - 1]!));
    expect(deltas.filter((d) => d > 0).length).toBe(4); // exactly four grants in 20 levels
  });

  it("a fresh pet starts with 1 point; leveling grants points at 6 / 11 / 16", () => {
    const { w, p, id } = setup();
    const a = G.spawnAnimal(w, "animal_dog_dachshund", 1, 0); tame(w, p, a, id("dog_biscuit"));
    expect(w.get(a, G.AnimalSkills)).toMatchObject({ level: 1, points: 1, nodes: 0 });
    const to = (from: number, toLevel: number): number => { let s = 0; for (let l = from; l < toLevel; l++) s += G.petXpToNext(l); return s; };
    G.grantXp(w, a, to(1, 5)); expect(w.getField(a, G.Pet, "level")).toBe(5); expect(w.getField(a, G.AnimalSkills, "points")).toBe(1); // no grant at 5
    G.grantXp(w, a, to(5, 6)); expect(w.getField(a, G.Pet, "level")).toBe(6); expect(w.getField(a, G.AnimalSkills, "points")).toBe(2);
    G.grantXp(w, a, to(6, 11)); expect(w.getField(a, G.Pet, "level")).toBe(11); expect(w.getField(a, G.AnimalSkills, "points")).toBe(3);
    G.grantXp(w, a, to(11, 16)); expect(w.getField(a, G.Pet, "level")).toBe(16); expect(w.getField(a, G.AnimalSkills, "points")).toBe(4);
  });

  it("migration: spent points are grandfathered, only the non-negative difference is granted", () => {
    const { w, p, id } = setup();
    const a = G.spawnAnimal(w, "animal_dog_dachshund", 1, 0); tame(w, p, a, id("dog_biscuit"));
    // legacy level-16 pet that already spent 1 point: total 4, spent 1 -> 3 left (not 4, not 0)
    w.set(a, G.Pet, { level: 16 }); w.set(a, G.AnimalSkills, { nodes: 1, points: 0 });
    G.reconcileAnimalSkills(w, a);
    expect(w.getField(a, G.AnimalSkills, "points")).toBe(3);
    expect(w.getField(a, G.AnimalSkills, "nodes")).toBe(1); // spent node kept
    // over-spent legacy pet (3 spent at level 6, total 2): points floor at 0, nodes kept, never negative
    w.set(a, G.Pet, { level: 6 }); w.set(a, G.AnimalSkills, { nodes: 0b111, points: 0 });
    G.reconcileAnimalSkills(w, a);
    expect(w.getField(a, G.AnimalSkills, "points")).toBe(0);
    expect(w.getField(a, G.AnimalSkills, "nodes")).toBe(0b111);
    // farm animal with no skills row at all (pre-Task 15 save): ensure gives level 1 + 1 point
    const cow = tamedCow(w, p, 2, 0);
    expect(w.has(cow, G.AnimalSkills)).toBe(false);
    G.ensureAnimalSkills(w, cow);
    expect(w.get(cow, G.AnimalSkills)).toMatchObject({ level: 1, points: 1, nodes: 0 });
  });

  it("spending validates (owner, distance, prereq, points, already-owned) and applies stat multipliers", () => {
    const { w, p, id } = setup();
    const a = G.spawnAnimal(w, "animal_dog_dachshund", 1, 0); tame(w, p, a, id("dog_biscuit"));
    const other = G.spawnPlayer(w, { x: 1, y: 0, clientId: 8 }); pid(w, other, 8);
    expect(G.spendAnimalSkill(w, other, a, 0)).toBe(G.ANIMAL_SKILL_FAIL.NotOwner);
    expect(G.spendAnimalSkill(w, p, a, 1)).toBe(G.ANIMAL_SKILL_FAIL.MissingReq); // Bite II needs Bite I
    expect(G.spendAnimalSkill(w, p, a, 0)).toBe(G.ANIMAL_SKILL_FAIL.None);
    expect(w.get(a, G.AnimalSkills)).toMatchObject({ points: 0, nodes: 1 });
    expect(G.spendAnimalSkill(w, p, a, 0)).toBe(G.ANIMAL_SKILL_FAIL.Owned);
    expect(G.spendAnimalSkill(w, p, a, 1)).toBe(G.ANIMAL_SKILL_FAIL.NoPoints); // prereq met, but no points left
    w.set(p, Transform, { x: 50, y: 0 });
    expect(G.spendAnimalSkill(w, p, a, 1)).toBe(G.ANIMAL_SKILL_FAIL.TooFar);
    // stat effects: Bite I (+15% damage), Tough Hide I (+15% health), Swift Paws I (+10% speed)
    const sp = w.getField(a, G.Pet, "species")!;
    w.set(a, G.AnimalSkills, { nodes: 0b10101, points: 0 }); // bite_1 (0), hide_1 (2), swift_1 (4)
    const base = G.petStats(sp, 1); const skilled = G.petStatsWithSkills(w, a, sp, 1);
    expect(skilled.damage).toBeCloseTo(base.damage * 1.15, 6);
    expect(skilled.maxHp).toBe(Math.round(base.maxHp * 1.15));
    expect(skilled.walk).toBeCloseTo(base.walk * 1.1, 6);
    expect(skilled.run).toBeCloseTo(base.run * 1.1, 6);
  });

  it("production skill increases harvest yield; produce-speed shortens the interval; production grants farm XP", () => {
    const { w, p, id } = setup();
    pens(w, p);
    const tr = trough(w); const milk = id("milk");
    const cow = tamedCow(w, p, 2, 0, { produceAt: w.tick });
    G.husbandrySystem(w);
    expect(G.countItem(w, tr, milk)).toBe(1); // baseline: exactly 1 milk
    expect(w.getField(cow, G.AnimalSkills, "xp")).toBe(2); // produceXp
    // milk_1 + milk_2 bought: 1 + 2 = 3 milk per harvest
    w.set(cow, G.AnimalSkills, { nodes: 0b11, points: 0 });
    w.set(cow, G.Tamed, { produceAt: w.tick });
    G.husbandrySystem(w);
    expect(G.countItem(w, tr, milk)).toBe(1 + 3);
    // quick_1 bought: next interval is shorter than the 420 s base (8400 ticks)
    w.set(cow, G.AnimalSkills, { nodes: 0b1000, points: 0 });
    w.set(cow, G.Tamed, { produceAt: w.tick });
    G.husbandrySystem(w);
    const interval = w.get(cow, G.Tamed)!.produceAt - w.tick;
    expect(interval).toBeGreaterThan(0); expect(interval).toBeLessThan(8400);
  });
});

describe("calmer moose (Task 15)", () => {
  it("moose aggro values: range 4 -> 2, leashRange unchanged at 12; mode territorial -> defensive (ADR-354: a tameable mount must not attack on sight)", () => {
    const def = G.animalDefs().find((a) => a.key === "animal_moose")!;
    expect(def.aggro).toMatchObject({ mode: "defensive", range: 2, leashRange: 12 });
  });

  it("a moose does not attack unprovoked at 3 tiles, retaliates when hit, and flees when badly hurt", () => {
    const { w, p } = setup(3, 0);
    const moose = G.spawnAnimal(w, "animal_moose", 0, 0);
    steps(w, 2); // decide only: 3 tiles > new range 2, so no engagement (longer runs let wander drift it into range)
    expect(w.getField(moose, G.Animal, "state")).not.toBe(ATTACK); // 3 tiles > new range 2 (was in range at 4)
    // hit from 8 tiles (inside leashRange 12, outside aggro.range 2): retaliation engages
    G.applyDamage(w, moose, 10, p, G.DamageCause.Combat);
    w.set(p, Transform, { x: 8, y: 0 });
    steps(w, 5);
    expect(w.getField(moose, G.Animal, "state")).toBe(ATTACK);
    // badly hurt: fear wins over retaliation (flee at/below 15% HP)
    w.set(moose, G.Health, { hp: 22 });
    G.applyDamage(w, moose, 1, p, G.DamageCause.Combat);
    steps(w, 5);
    expect(w.getField(moose, G.Animal, "state")).not.toBe(ATTACK);
  });
});

describe("chase limits (Task 15)", () => {
  it("a wild animal gives up beyond 18 tiles from home and heads home (bear: old 2x leash was 28)", () => {
    const { w, p } = setup(24, 0);
    const bear = G.spawnAnimal(w, "animal_bear", 0, 0);
    // simulate an engaged chase that has carried the bear 20 tiles from home, player still within leashRange
    w.set(bear, Transform, { x: 20, y: 0 });
    w.setField(bear, G.Animal, "state", ATTACK);
    steps(w, 2);
    expect(w.getField(bear, G.Animal, "state")).not.toBe(ATTACK); // gave up: homeD 20 > 18
    // goal is home-centered (old goal 0, or a new wander goal within radius 12 of home), never toward the player
    expect(w.getField(bear, G.Animal, "goalX")).toBeLessThan(20);
    steps(w, 100);
    expect(pos(w, bear).x).toBeLessThanOrEqual(20); // idles or walks home; never advances on the player at (24, 0)
  });

  it("a zombie gives up beyond 20 tiles from its spawn anchor and does not instantly re-acquire", () => {
    const w = makeWorld(); setTimeOfDay(w, 0, 0); // night: aggressive
    const p = G.spawnPlayer(w, { x: 33, y: 0 });
    const z = G.spawnZombie(w, "zombie_walker", 30, 0);
    steps(w, 20);
    expect([G.ZState.Chase, G.ZState.AttackPlayer]).toContain(w.getField(z, G.ZombieBrain, "state"));
    expect(w.getField(z, G.ZombieBrain, "target")).toBe(p);
    // carry the chase 25 tiles from the anchor, player still in sight (3 tiles away)
    w.set(z, Transform, { x: 55, y: 0 });
    w.set(p, Transform, { x: 58, y: 0 });
    steps(w, 10);
    expect(w.getField(z, G.ZombieBrain, "state")).toBe(G.ZState.Wander);
    expect(w.getField(z, G.ZombieBrain, "target")).toBe(0);
    steps(w, 100); // 5 s, inside the 10 s give-up cooldown, player still visible
    expect(w.getField(z, G.ZombieBrain, "state")).toBe(G.ZState.Wander);
  });

  it("a zombie in AttackPlayer finishes a due swing before giving up", () => {
    const w = makeWorld(); setTimeOfDay(w, 0, 0);
    const p = G.spawnPlayer(w, { x: 58, y: 0 });
    const z = G.spawnZombie(w, "zombie_walker", 30, 0);
    // engaged at point-blank range, 25 tiles from home, attack due this tick
    w.set(z, Transform, { x: 57, y: 0 });
    w.setField(z, G.ZombieBrain, "state", G.ZState.AttackPlayer);
    w.setField(z, G.ZombieBrain, "target", p);
    w.setField(z, G.ZombieBrain, "attackAt", w.tick);
    const hp0 = w.getField(p, G.Health, "hp")!;
    steps(w, 6); // think runs (thinkTicks 5): swing lands, then the next think gives up
    expect(w.getField(p, G.Health, "hp")!).toBeLessThan(hp0);
    steps(w, 10);
    expect(w.getField(z, G.ZombieBrain, "state")).toBe(G.ZState.Wander);
  });
});

describe("guard / territory unaffected by chase limits (Task 15)", () => {
  it("a tame cow still defends its owner's claim (territory branch has no home-distance cap)", () => {
    const { w, p } = setup(30, 0);
    claim(w, 2, 0, 10, 5);
    const cow = tamedCow(w, p, 2, 0);
    const z = G.spawnZombie(w, "zombie_walker", 5, 0); // inside the claim, 3 tiles from the cow
    const hp0 = w.getField(z, G.Health, "hp")!;
    steps(w, 120);
    expect(w.getField(z, G.Health, "hp")!).toBeLessThan(hp0);
    void cow;
  });

  it("a guard pet still engages far from its own home anchor (pets have no animal chase limit)", () => {
    const { w, p, id } = setup(30, 0);
    const a = G.spawnAnimal(w, "animal_dog_dachshund", 30, 0); tame(w, p, a, id("dog_biscuit"));
    w.setField(a, G.Pet, "fullness", 100);
    w.set(a, G.Animal, { homeX: 0, homeY: 0 }); // pet's animal home is 30 tiles away (> 18 limit)
    expect(G.setGuard(w, p, a, G.GuardKind.Entity, p, 0, 0)).toBe(G.PetFail.None);
    const z = G.spawnZombie(w, "zombie_walker", 33, 0); // near the guarded owner
    const hp0 = w.getField(z, G.Health, "hp")!;
    steps(w, 120);
    expect(w.getField(z, G.Health, "hp")!).toBeLessThan(hp0);
  });
});
