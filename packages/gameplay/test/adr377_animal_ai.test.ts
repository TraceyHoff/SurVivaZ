/**
 * ADR-377: animalAI per-tick list/sort + Math.hypot removal must not change behaviour.
 * The golden hash pins the exact decisions of a deterministic 800-tick world (open + walled
 * base): every live animal's id/kind/state/position/goal/thinkAt/hp, every loot bag's id/position,
 * and the entity count. Any change in iteration order, threat choice, flee/attack boundary or
 * cache staleness changes the hash. Golden values were recorded from the pre-377 code.
 */
import { describe, expect, it } from "vitest";
import { PlayerId, Rng, Transform, type Entity } from "@engine/core";
import * as G from "../src/index.js";
import { Animal, Container, Health, LootBag } from "../src/components.js";
import { room, world215 } from "./nav215_fixture.js";
import { steps } from "./helpers.js";

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

function buildWorld(withBase: boolean): { w: ReturnType<typeof world215>["w"]; players: Entity[] } {
  const { w, put } = world215();
  if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem);
  if (withBase) for (let gy = 0; gy < 4; gy++) for (let gx = 0; gx < 4; gx++) room(w, put, gx * 6, gy * 6, 4, { door: (gx + gy) % 2 === 0, bench: true });
  const rng = new Rng(7);
  const kinds = G.animalDefs().filter((a) => !a.spriteKey.includes("dog_") && !a.spriteKey.includes("cat_")).map((a) => a.spriteKey);
  for (let i = 0; i < 160; i++) G.spawnAnimal(w, kinds[i % kinds.length]!, rng.range(-4, 26), rng.range(-4, 26));
  const players: Entity[] = [];
  for (let i = 0; i < 4; i++) {
    const p = G.spawnPlayer(w, { x: 2 + i * 6, y: -1.5, maxWeight: 0, clientId: 10 + i });
    if (w.has(p, PlayerId)) w.set(p, PlayerId, { id: 10 + i }); else w.add(p, PlayerId, { id: 10 + i });
    players.push(p);
  }
  for (let i = 0; i < 16; i++) { const a = G.spawnAnimal(w, "animal_dog_dachshund", 2 + (i % 4) * 6, -2); G.makePet(w, a, players[i % 4]!); }
  const zk = G.gameplayDefs(w).zombies.keys().next().value!;
  for (let i = 0; i < 20; i++) G.spawnZombie(w, zk, rng.range(-4, 26), rng.range(-4, 26));
  return { w, players };
}

function snapshot(w: ReturnType<typeof world215>["w"]): string {
  const parts: string[] = [];
  const animals = [...w.query([Animal, Transform])].sort((a, b) => a - b);
  for (const e of animals) {
    const a = w.get(e, Animal)!; const t = w.get(e, Transform)!; const h = w.get(e, Health);
    parts.push(`${e}:${a.kind},${a.state},${t.x.toFixed(6)},${t.y.toFixed(6)},${a.goalX.toFixed(6)},${a.goalY.toFixed(6)},${a.thinkAt},${h ? h.hp.toFixed(3) : "-"}`);
  }
  const bags = [...w.query([LootBag, Container])].sort((a, b) => a - b);
  for (const b of bags) { const t = w.get(b, Transform)!; parts.push(`bag:${b},${t.x.toFixed(6)},${t.y.toFixed(6)}`); }
  parts.push(`entities:${w.entityCount}`);
  return fnv1a(parts.join("|"));
}

const GOLDEN = { open: "64878346", base: "6402418b" };

describe("ADR-377 animalAI behaviour identity", () => {
  it("golden hash: 800 ticks, open ground", () => {
    const { w, players } = buildWorld(false);
    const tick = (i: number): void => {
      players.forEach((p, k) => {
        const a = ((i / 60) | 0) % 4; const dx = [1, 0, -1, 0][(a + k) % 4]!, dy = [0, 1, 0, -1][(a + k) % 4]!;
        G.applyMovementInput(w, p, 0, 1 / 20, { x: (dx - dy) * Math.SQRT1_2, y: (dx + dy) * Math.SQRT1_2 });
      });
      w.step(1 / 20);
    };
    for (let i = 0; i < 800; i++) tick(i);
    const hash = snapshot(w);
    console.log(`[adr377] golden open=${hash}`);
    expect(hash).toBe(GOLDEN.open);
  }, 120_000);
  it("golden hash: 800 ticks, walled base", () => {
    const { w, players } = buildWorld(true);
    const tick = (i: number): void => {
      players.forEach((p, k) => {
        const a = ((i / 60) | 0) % 4; const dx = [1, 0, -1, 0][(a + k) % 4]!, dy = [0, 1, 0, -1][(a + k) % 4]!;
        G.applyMovementInput(w, p, 0, 1 / 20, { x: (dx - dy) * Math.SQRT1_2, y: (dx + dy) * Math.SQRT1_2 });
      });
      w.step(1 / 20);
    };
    for (let i = 0; i < 800; i++) tick(i);
    const hash = snapshot(w);
    console.log(`[adr377] golden base=${hash}`);
    expect(hash).toBe(GOLDEN.base);
  }, 120_000);

  it("dead sweep still drops loot in ascending animal-id order", () => {
    const { w } = world215();
    w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem);
    G.spawnPlayer(w, { x: -30, y: -30, maxWeight: 0, clientId: 1 });
    // Three chickens at distinct spots, spawned in id order; kill all on the same tick.
    const spots: [number, number][] = [[2, 0], [5, 0], [8, 0]];
    const chickens = spots.map(([x, y]) => G.spawnAnimal(w, "animal_chicken", x, y));
    steps(w, 2);
    for (const c of chickens) w.set(c, Health, { hp: 0 });
    steps(w, 2);
    expect(chickens.map((c) => w.get(c, G.Animal)!.state)).toEqual([G.AnimalState.Dead, G.AnimalState.Dead, G.AnimalState.Dead]);
    const bags = [...w.query([LootBag, Container])].sort((a, b) => a - b);
    expect(bags.length).toBe(3);
    // Bag i sits on chicken i's body: creation order (ascending bag id) matches ascending animal id.
    // (The chickens may wander a fraction of a tile before dying, so compare order, not exact spots.)
    const bagXs = bags.map((b) => w.get(b, Transform)!.x);
    expect(bagXs[0]!).toBeLessThan(bagXs[1]!);
    expect(bagXs[1]!).toBeLessThan(bagXs[2]!);
    bagXs.forEach((x, i) => expect(Math.abs(x - spots[i]![0])).toBeLessThan(1));
  });

  it("a newly spawned animal is thought about on its very first tick (cache invalidates on spawn)", () => {
    const { w } = world215();
    w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem);
    const p = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
    steps(w, 5);
    const wolf = G.spawnAnimal(w, "animal_wolf", 1.2, 0);
    steps(w, 2);
    expect(w.get(wolf, G.Animal)!.state).toBe(G.AnimalState.Attack);
    expect(w.get(p, Health)!.hp).toBeLessThan(w.get(p, Health)!.max);
  });

  it("destroying an animal mid-run neither crashes nor stalls the others (cache invalidates on destroy)", () => {
    const { w } = world215();
    w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem);
    G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
    const a = G.spawnAnimal(w, "animal_chicken", 2, 0);
    const b = G.spawnAnimal(w, "animal_chicken", 3, 0);
    steps(w, 5);
    expect(w.get(a, G.Animal)!.state).toBe(G.AnimalState.Flee);
    expect(w.get(b, G.Animal)!.state).toBe(G.AnimalState.Flee);
    w.destroy(a);
    steps(w, 5);
    expect(w.isAlive(a)).toBe(false);
    // b keeps being processed after a is gone: still fleeing away from the player (+x).
    expect(w.get(b, G.Animal)!.state).toBe(G.AnimalState.Flee);
    expect(w.get(b, Transform)!.x).toBeGreaterThan(3);
  });

  it("a pet made mid-run leaves the animalAI live list (cache invalidates on Pet add)", () => {
    const { w } = world215();
    w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem);
    const p = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
    // A wild dog re-rolls its wander goal on think ticks (every 2–6 s); once it is a pet,
    // animalAI must stop touching it — petSystem owns pets and never writes Animal.goal*.
    const dog = G.spawnAnimal(w, "animal_dog_dachshund", 10, 0);
    steps(w, 2);
    G.makePet(w, dog, p);
    const goal = { x: w.get(dog, G.Animal)!.goalX, y: w.get(dog, G.Animal)!.goalY };
    steps(w, 200);
    expect(w.get(dog, G.Animal)!.goalX).toBe(goal.x);
    expect(w.get(dog, G.Animal)!.goalY).toBe(goal.y);
  });

  it("nearest-threat tie breaks to the lower entity id (squared-distance ordering)", () => {
    const { w } = world215();
    w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem);
    const p1 = G.spawnPlayer(w, { x: 2, y: 0, maxWeight: 0, clientId: 1 });
    const p2 = G.spawnPlayer(w, { x: -2, y: 0, maxWeight: 0, clientId: 2 });
    expect(p1).toBeLessThan(p2);
    const wolf = G.spawnAnimal(w, "animal_wolf", 0, 0);
    steps(w, 2);
    expect(w.get(wolf, G.Animal)!.state).toBe(G.AnimalState.Attack);
    const hp1 = w.get(p1, Health)!.hp; const hp2 = w.get(p2, Health)!.hp;
    // The wolf engages p1 (lower id at exactly equal distance); only p1 takes damage.
    steps(w, 40);
    expect(w.get(p1, Health)!.hp).toBeLessThan(hp1);
    expect(w.get(p2, Health)!.hp).toBe(hp2);
  });
});
