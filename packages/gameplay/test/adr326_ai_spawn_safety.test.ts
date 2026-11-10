// ADR-326: the Task 33 safe spawn radius (20 tiles) also covers the ADR-325 world-wide AI spawn
// points. Same radius, same rules (no aggressive spawns inside; zombies / aggressive animals do not
// acquire or engage survivors inside; horde zombies exempt). No starter spawn points are installed
// anywhere in this file, so every protection here comes from the AI points alone — not Task 33.
import { describe, expect, it } from "vitest";
import { installPermissions, PlayerId, Transform, type Entity, type World } from "@engine/core";
import { Health } from "../src/components.js";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";

/** One world point (used by the spawner / acquire / horde tests) plus a site point and a starter-source
 * point (used by the predicate test). Deliberately no setSpawnPoints call: the AI points are the only
 * safe centres in these worlds. */
const AI_PTS: G.AiSpawnPoint[] = [
  { x: 96, y: -96, source: "starter" },
  { x: 400, y: 0, source: "world" },
  { x: -500, y: 300, source: "site" },
];
const WORLD_PT: G.AiSpawnPoint = { x: 400, y: 0, source: "world" };

describe("ADR-326 safe spawn radius around world-wide AI spawn points", () => {
  it("inSpawnSafeRadius covers every AI point out to 20 tiles and nothing beyond", () => {
    const w = makeWorld();
    // Bare world: no points installed at all, so there is no safe radius (Task 33 rule unchanged).
    expect(G.inSpawnSafeRadius(w, 400, 0)).toBe(false);
    G.setAiSpawnPoints(w, AI_PTS);
    expect(G.SAFE_SPAWN_RADIUS).toBe(20);
    for (const pt of AI_PTS) {
      expect(G.inSpawnSafeRadius(w, pt.x, pt.y)).toBe(true);
      expect(G.inSpawnSafeRadius(w, pt.x + 19, pt.y)).toBe(true);
      expect(G.inSpawnSafeRadius(w, pt.x + 21, pt.y)).toBe(false);
    }
    expect(G.inSpawnSafeRadius(w, 0, 0)).toBe(false);
  });
  it("a lazily installed set is protected from the first spawn check, before any bot spawns", () => {
    const w = makeWorld();
    let built = 0;
    G.setAiSpawnPoints(w, () => { built++; return AI_PTS; });
    expect(built).toBe(0);
    expect(G.inSpawnSafeRadius(w, 400, 0)).toBe(true); // materialises the builder on read
    expect(built).toBe(1);
    expect(G.inSpawnSafeRadius(w, 400, 0)).toBe(true);
    expect(built).toBe(1); // cached, not rebuilt on the next check
    expect(G.aiSpawnPoints(w)).toEqual(AI_PTS); // the same materialised set bots will use
    expect(G.inSpawnSafeRadius(w, -500, 300)).toBe(true);
  });
  it("the legacy zombie spawner never spawns inside the radius around a world AI point, but still spawns outside it", () => {
    const w = makeWorld(); installPermissions(w);
    G.setAiSpawnPoints(w, [WORLD_PT]);
    const p = spawnLearned(w, { x: 400, y: 0, maxWeight: 0, clientId: 1 });
    void p;
    // Same drive as the Task 33 spawner test (2000 x 2s calls at day rate 0.3/min spawns ~20 zombies,
    // all 16-24 tiles from the player — ~45% of the ring is inside 20).
    for (let i = 0; i < 2000; i++) G.zombieSpawnerSystem(w, 2);
    const zombies = [...w.query([G.Zombie, Transform])];
    expect(zombies.length).toBeGreaterThan(0);
    for (const z of zombies) {
      const t = w.get(z, Transform)!;
      expect(Math.hypot(t.x - 400, t.y)).toBeGreaterThanOrEqual(20);
    }
  });
  it("a zombie does not acquire a survivor standing inside the radius around a world AI point", () => {
    const w = makeWorld(); installPermissions(w);
    G.setAiSpawnPoints(w, [WORLD_PT]);
    const p = spawnLearned(w, { x: 400, y: 0, maxWeight: 0, clientId: 1 });
    const z = G.spawnZombie(w, "zombie_walker", 405, 0);
    // ZState: Wander 0, Investigate 1, Chase 2, AttackPlayer 3 — the zombie must never chase/attack
    // a survivor inside the radius, even though it is well within sight range.
    steps(w, 200);
    expect(w.has(z, G.Dead)).toBe(false);
    const state = w.getField(z, G.ZombieBrain, "state");
    expect(state).not.toBe(2);
    expect(state).not.toBe(3);
    void p;
  });
  it("a horde zombie still targets a survivor inside the radius around a world AI point (raids are out of scope)", () => {
    const w = makeWorld(); installPermissions(w);
    G.setAiSpawnPoints(w, [WORLD_PT]);
    const p = spawnLearned(w, { x: 400, y: 0, maxWeight: 0, clientId: 1 });
    const z = G.spawnZombie(w, "zombie_walker", 405, 0);
    w.add(z, G.HordeMember, { horde: 1, target: 0 as Entity, tx: 0, ty: 0 });
    steps(w, 20);
    const state = w.getField(z, G.ZombieBrain, "state");
    expect(state).toBe(2); // ZState.Chase — the horde hunts inside the safe radius
    void p;
  });
  it("an aggressive animal does not engage a survivor inside the radius around a world AI point", () => {
    const w = makeWorld(); w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem);
    G.setAiSpawnPoints(w, [WORLD_PT]);
    const p = G.spawnPlayer(w, { x: 400, y: 0, maxWeight: 0, clientId: 1 });
    const wolf = G.spawnAnimal(w, "animal_wolf", 401.2, 0);
    const hp0 = w.get(p, Health)!.hp;
    steps(w, 40); // a wolf this close bites within 40 steps when it may engage (see the control below)
    expect(w.get(wolf, G.Animal)!.state).not.toBe(G.AnimalState.Attack);
    expect(w.get(p, Health)!.hp).toBe(hp0);
  });
  it("control: without AI points the same wolf attacks the same survivor", () => {
    const w = makeWorld(); w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem);
    const p = G.spawnPlayer(w, { x: 400, y: 0, maxWeight: 0, clientId: 1 });
    const wolf = G.spawnAnimal(w, "animal_wolf", 401.2, 0);
    const hp0 = w.get(p, Health)!.hp;
    steps(w, 40);
    expect(w.get(p, Health)!.hp).toBeLessThan(hp0);
    expect(w.get(wolf, G.Animal)!.state).toBe(G.AnimalState.Attack);
    void p;
  });
});

describe("ADR-326 population spawner gate around world-wide AI spawn points", () => {
  // One walker entry, flat rates so the phase never matters. Chunk "12,0" is x in [384, 416),
  // y in [0, 32) (CHUNK_SIZE 32); four AI points at the quarter-centres put every tile in the chunk
  // within ~11 tiles of a point, so the whole chunk is inside the safe radius. The viewpoint sits
  // at the chunk corner (384, 0) so spawns 10+ tiles away are possible in the control.
  const walker = { kind: "zombie_walker", category: "zombie", density: 1, timeWeights: { day: 1, night: 1, dawn: 1, dusk: 1 }, minPlayerDistance: 10, perChunkCap: 5, globalCap: 50, despawnDistance: 60, group: [1, 1] as [number, number] };
  const quarterPts: G.AiSpawnPoint[] = [
    { x: 392, y: 8, source: "world" }, { x: 408, y: 8, source: "world" },
    { x: 392, y: 24, source: "world" }, { x: 408, y: 24, source: "world" },
  ];
  const rig = (withAi: boolean): { w: World; sp: ReturnType<typeof G.installPopulation> } => {
    const w = makeWorld();
    if (withAi) G.setAiSpawnPoints(w, quarterPts);
    const sp = G.installPopulation(w, { chunks: () => ["12,0"], viewpoints: () => [{ x: 384, y: 0 }], spawns: [walker], tileAt: () => 3 });
    return { w, sp };
  };
  it("spawns no aggressive creature in a chunk covered by world AI points", () => {
    const { w, sp } = rig(true);
    for (let i = 0; i < 10; i++) sp.step();
    expect([...w.query([G.Zombie, Transform])]).toHaveLength(0);
  });
  it("control: the same chunk spawns zombies with no AI point installed", () => {
    const { w, sp } = rig(false);
    for (let i = 0; i < 10; i++) sp.step();
    expect([...w.query([G.Zombie, Transform])].length).toBeGreaterThan(0);
  });
});
