// ADR-348: the Task 33 safe spawn radius (20 tiles) also covers the spawn points ADR-326 left out:
// owned beds (bed respawn), AI homes (home respawn) and one-shot friend-code guest arrivals. Same
// radius, same rules (no aggressive spawns inside; zombies / aggressive animals do not acquire or engage
// survivors inside; retaliation still re-engages; horde zombies exempt). No starter spawn points are
// installed anywhere in this file, so every protection here comes from the new kinds alone.
import { describe, expect, it } from "vitest";
import { installPermissions, PlayerId, Transform, type Entity, type World } from "@engine/core";
import { Health } from "../src/components.js";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";

/** A bed piece owned by `pid` at (x, y) — the lightweight rig from the ADR-325 respawn tests. Its
 * respawn point (and safe centre) is beside the bed at (x + 1, y + 0.5). */
function placeBed(w: World, pid: number, x: number, y: number): Entity {
  const bed = [...G.gameplayDefs(w).pieces.values()].find((p) => p.key === "bed")!;
  const b = w.create();
  w.add(b, Transform, { x, y }).add(b, G.BuildPiece, { type: bed.id } as never).add(b, G.PieceOwner, { player: pid });
  return b;
}
/** A player (PlayerId 1) standing at their bed at (400, 0); the bed provider is registered, so the
 * 20-tile zone around (401, 0.5) is live. No starter points are installed. */
function bedRig(): { w: World; p: Entity; bed: Entity } {
  const w = makeWorld(); installPermissions(w);
  if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = spawnLearned(w, { x: 401, y: 0.5, maxWeight: 0, clientId: 1 });
  w.add(p, PlayerId, { id: 1 });
  const bed = placeBed(w, 1, 400, 0);
  G.installBedRespawn(w);
  return { w, p, bed };
}
/** An AI human (bot, PlayerId 2) whose home is (520, -40); the home provider is registered by
 * setAiHomeLocator. A human player stands far away at (100, 100). No starter points installed. */
function homeRig(): { w: World; bot: Entity; human: Entity } {
  const w = makeWorld(); installPermissions(w);
  if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const human = spawnLearned(w, { x: 100, y: 100, maxWeight: 0, clientId: 1 });
  w.add(human, PlayerId, { id: 1 });
  const bot = spawnLearned(w, { x: 520, y: -40, maxWeight: 0, clientId: 2 });
  w.add(bot, PlayerId, { id: 2 });
  G.setAiHumanPredicate(w, (e) => e === bot);
  G.setAiHomeLocator(w, (e) => (e === bot ? { x: 520, y: -40 } : undefined));
  return { w, bot, human };
}

describe("ADR-348 safe spawn radius around beds", () => {
  it("inSpawnSafeRadius covers every owned bed out to 20 tiles and nothing beyond", () => {
    const { w } = bedRig();
    // The bed's beside-bed respawn point (401, 0.5) is the centre; the bare-world rule is pinned
    // by the next test (no beds at all -> no safe radius).
    expect(G.inSpawnSafeRadius(w, 401, 0.5)).toBe(true);
    expect(G.SAFE_SPAWN_RADIUS).toBe(20);
    expect(G.inSpawnSafeRadius(w, 401 + 19, 0.5)).toBe(true);
    expect(G.inSpawnSafeRadius(w, 401 + 21, 0.5)).toBe(false);
    expect(G.inSpawnSafeRadius(w, 401, 0.5 + 19)).toBe(true);
    expect(G.inSpawnSafeRadius(w, 401, 0.5 + 21)).toBe(false);
    expect(G.inSpawnSafeRadius(w, 0, 0)).toBe(false);
  });
  it("a bed nobody owns is not a centre, and a demolished bed stops being one", () => {
    const w = makeWorld(); installPermissions(w);
    if (!w.isRegistered(PlayerId)) w.register(PlayerId);
    const p = spawnLearned(w, { x: 401, y: 0.5, maxWeight: 0, clientId: 1 });
    w.add(p, PlayerId, { id: 1 });
    G.installBedRespawn(w);
    expect(G.inSpawnSafeRadius(w, 401, 0.5)).toBe(false); // no beds at all
    const stray = placeBed(w, 0, 400, 0); // PieceOwner.player 0: abandoned / unowned furniture
    steps(w, 1);
    expect(G.inSpawnSafeRadius(w, 401, 0.5)).toBe(false);
    w.destroy(stray);
    const bed = placeBed(w, 1, 400, 0);
    steps(w, 1);
    expect(G.inSpawnSafeRadius(w, 401, 0.5)).toBe(true);
    w.destroy(bed);
    expect(G.inSpawnSafeRadius(w, 401, 0.5)).toBe(true); // per-tick provider cache: still this tick's view
    steps(w, 1);
    expect(G.inSpawnSafeRadius(w, 401, 0.5)).toBe(false); // next tick the demolished bed is gone
    void p;
  });
  it("bed respawn still returns the nearest owned bed (refactor guard)", () => {
    const { w, p } = bedRig();
    placeBed(w, 1, 500, 500);
    expect(G.bedRespawnPoint(w, p)).toEqual({ x: 401, y: 0.5 });
    w.set(p, Transform, { x: 502, y: 500 });
    expect(G.bedRespawnPoint(w, p)).toEqual({ x: 501, y: 500.5 });
  });
  it("the legacy zombie spawner never spawns inside the radius around a bed, but still spawns outside it", () => {
    const { w, p } = bedRig();
    void p;
    for (let i = 0; i < 2000; i++) G.zombieSpawnerSystem(w, 2);
    const zombies = [...w.query([G.Zombie, Transform])];
    expect(zombies.length).toBeGreaterThan(0);
    for (const z of zombies) {
      const t = w.get(z, Transform)!;
      expect(Math.hypot(t.x - 401, t.y - 0.5)).toBeGreaterThanOrEqual(20);
    }
  });
  it("a zombie does not acquire a survivor standing at their bed", () => {
    const { w, p } = bedRig();
    const z = G.spawnZombie(w, "zombie_walker", 406, 0.5);
    steps(w, 200);
    expect(w.has(z, G.Dead)).toBe(false);
    const state = w.getField(z, G.ZombieBrain, "state");
    expect(state).not.toBe(2);
    expect(state).not.toBe(3);
    void p;
  });
  it("retaliation: a zombie re-engages a survivor at their bed after being hit", () => {
    const { w, p } = bedRig();
    const z = G.spawnZombie(w, "zombie_walker", 406, 0.5);
    steps(w, 20);
    expect(w.getField(z, G.ZombieBrain, "state")).not.toBe(2); // safe before the hit
    G.applyDamage(w, z, 5, p);
    steps(w, 20);
    expect(w.getField(z, G.ZombieBrain, "state")).toBe(2); // ZState.Chase — the zone is not a free shooting gallery
    void p;
  });
  it("a horde zombie still targets a survivor at their bed (raids are out of scope)", () => {
    const { w, p } = bedRig();
    const z = G.spawnZombie(w, "zombie_walker", 406, 0.5);
    w.add(z, G.HordeMember, { horde: 1, target: 0 as Entity, tx: 0, ty: 0 });
    steps(w, 20);
    const state = w.getField(z, G.ZombieBrain, "state");
    expect(state).toBe(2); // ZState.Chase — the horde hunts inside the safe radius
    void p;
  });
  it("an aggressive animal does not engage a survivor at their bed, but retaliates when hurt", () => {
    const w = makeWorld(); w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem);
    installPermissions(w);
    if (!w.isRegistered(PlayerId)) w.register(PlayerId);
    const p = spawnLearned(w, { x: 401, y: 0.5, maxWeight: 0, clientId: 1 });
    w.add(p, PlayerId, { id: 1 });
    placeBed(w, 1, 400, 0);
    G.installBedRespawn(w);
    const wolf = G.spawnAnimal(w, "animal_wolf", 402.2, 0.5);
    const hp0 = w.get(p, Health)!.hp;
    steps(w, 40); // a wolf this close bites within 40 steps when it may engage (see the ADR-326 control)
    expect(w.get(wolf, G.Animal)!.state).not.toBe(G.AnimalState.Attack);
    expect(w.get(p, Health)!.hp).toBe(hp0);
    G.applyDamage(w, wolf, 5, p); // the survivor fights back: retaliation still applies inside the zone
    steps(w, 120); // the wolf needs a few thinks to re-engage and land a bite after the hit
    expect(w.get(wolf, G.Animal)!.state).toBe(G.AnimalState.Attack);
    expect(w.get(p, Health)!.hp).toBeLessThan(hp0);
    void p;
  });
});

describe("ADR-348 population spawner gate around beds", () => {
  // One walker entry, flat rates so the phase never matters. Chunk "12,0" is x in [384, 416),
  // y in [0, 32) (CHUNK_SIZE 32); four beds at the quarter-centres put every tile in the chunk
  // within ~13 tiles of a beside-bed centre, so the whole chunk is inside the safe radius.
  const walker = { kind: "zombie_walker", category: "zombie", density: 1, timeWeights: { day: 1, night: 1, dawn: 1, dusk: 1 }, minPlayerDistance: 10, perChunkCap: 5, globalCap: 50, despawnDistance: 60, group: [1, 1] as [number, number] };
  const rig = (withBeds: boolean): { w: World; sp: ReturnType<typeof G.installPopulation> } => {
    const w = makeWorld(); installPermissions(w);
    if (!w.isRegistered(PlayerId)) w.register(PlayerId);
    const p = spawnLearned(w, { x: 384, y: 0, maxWeight: 0, clientId: 1 });
    w.add(p, PlayerId, { id: 1 });
    if (withBeds) for (const [x, y] of [[392, 8], [408, 8], [392, 24], [408, 24]] as const) placeBed(w, 1, x, y);
    G.installBedRespawn(w);
    const sp = G.installPopulation(w, { chunks: () => ["12,0"], viewpoints: () => [{ x: 384, y: 0 }], spawns: [walker], tileAt: () => 3 });
    return { w, sp };
  };
  it("spawns no aggressive creature in a chunk covered by beds", () => {
    const { w, sp } = rig(true);
    for (let i = 0; i < 10; i++) sp.step();
    expect([...w.query([G.Zombie, Transform])]).toHaveLength(0);
  });
  it("control: the same chunk spawns zombies with no beds", () => {
    const { w, sp } = rig(false);
    for (let i = 0; i < 10; i++) sp.step();
    expect([...w.query([G.Zombie, Transform])].length).toBeGreaterThan(0);
  });
});

describe("ADR-348 safe spawn radius around AI homes", () => {
  it("inSpawnSafeRadius covers an AI human's home out to 20 tiles and nothing beyond", () => {
    const { w } = homeRig();
    expect(G.SAFE_SPAWN_RADIUS).toBe(20);
    expect(G.inSpawnSafeRadius(w, 520, -40)).toBe(true);
    expect(G.inSpawnSafeRadius(w, 520 + 19, -40)).toBe(true);
    expect(G.inSpawnSafeRadius(w, 520 + 21, -40)).toBe(false);
    expect(G.inSpawnSafeRadius(w, 100, 100)).toBe(false); // the human player's spot is not a centre
    expect(G.inSpawnSafeRadius(w, 0, 0)).toBe(false);
  });
  it("a hired worker's home is not a safe centre (hired workers keep the ADR-153 rule)", () => {
    const { w, bot } = homeRig();
    expect(G.inSpawnSafeRadius(w, 520, -40)).toBe(true);
    G.ensureWorker(w, bot); w.setField(bot, G.Worker, "owner", 1);
    steps(w, 1);
    expect(G.inSpawnSafeRadius(w, 520, -40)).toBe(false);
    expect(G.aiRespawnPoint(w, bot)).toBeUndefined();
  });
  it("a home the locator no longer returns stops being a centre", () => {
    const { w, bot } = homeRig();
    expect(G.inSpawnSafeRadius(w, 520, -40)).toBe(true);
    G.setAiHomeLocator(w, (e) => (e === bot ? { x: 700, y: 10 } : undefined));
    steps(w, 1);
    expect(G.inSpawnSafeRadius(w, 520, -40)).toBe(false);
    expect(G.inSpawnSafeRadius(w, 700, 10)).toBe(true);
  });
  it("a zombie does not acquire a survivor standing at an AI home", () => {
    const { w, bot } = homeRig();
    const z = G.spawnZombie(w, "zombie_walker", 525, -40);
    steps(w, 200);
    expect(w.has(z, G.Dead)).toBe(false);
    const state = w.getField(z, G.ZombieBrain, "state");
    expect(state).not.toBe(2);
    expect(state).not.toBe(3);
    void bot;
  });
  it("a horde zombie still targets a survivor at an AI home (raids are out of scope)", () => {
    const { w, bot } = homeRig();
    const z = G.spawnZombie(w, "zombie_walker", 525, -40);
    w.add(z, G.HordeMember, { horde: 1, target: 0 as Entity, tx: 0, ty: 0 });
    steps(w, 20);
    expect(w.getField(z, G.ZombieBrain, "state")).toBe(2); // ZState.Chase
    void bot;
  });
});

describe("ADR-348 safe spawn radius around guest arrivals (temporary centres)", () => {
  it("a temporary centre covers its point for guestSafeSeconds, then lapses", () => {
    const w = makeWorld();
    expect(G.PVP.guestSafeSeconds).toBe(300);
    expect(G.inSpawnSafeRadius(w, 400, 0)).toBe(false); // no centres at all yet
    G.addTemporarySafeSpawnPoint(w, { x: 400, y: 0 }, G.PVP.guestSafeSeconds);
    expect(G.inSpawnSafeRadius(w, 400, 0)).toBe(true);
    expect(G.inSpawnSafeRadius(w, 400 + 19, 0)).toBe(true);
    expect(G.inSpawnSafeRadius(w, 400 + 21, 0)).toBe(false);
    w.tick += 20 * G.PVP.guestSafeSeconds - 1;
    expect(G.inSpawnSafeRadius(w, 400, 0)).toBe(true); // last tick of the window
    w.tick += 1;
    expect(G.inSpawnSafeRadius(w, 400, 0)).toBe(false); // expired and pruned
  });
  it("a zombie does not acquire a survivor inside a temporary centre", () => {
    const w = makeWorld(); installPermissions(w);
    const p = spawnLearned(w, { x: 400, y: 0, maxWeight: 0, clientId: 1 });
    G.addTemporarySafeSpawnPoint(w, { x: 400, y: 0 }, G.PVP.guestSafeSeconds);
    const z = G.spawnZombie(w, "zombie_walker", 405, 0);
    steps(w, 200);
    expect(w.has(z, G.Dead)).toBe(false);
    const state = w.getField(z, G.ZombieBrain, "state");
    expect(state).not.toBe(2);
    expect(state).not.toBe(3);
    void p;
  });
  it("a horde zombie still targets a survivor inside a temporary centre", () => {
    const w = makeWorld(); installPermissions(w);
    const p = spawnLearned(w, { x: 400, y: 0, maxWeight: 0, clientId: 1 });
    G.addTemporarySafeSpawnPoint(w, { x: 400, y: 0 }, G.PVP.guestSafeSeconds);
    const z = G.spawnZombie(w, "zombie_walker", 405, 0);
    w.add(z, G.HordeMember, { horde: 1, target: 0 as Entity, tx: 0, ty: 0 });
    steps(w, 20);
    expect(w.getField(z, G.ZombieBrain, "state")).toBe(2); // ZState.Chase
    void p;
  });
  it("temporary centres coexist with static centres and outlive nothing", () => {
    const w = makeWorld();
    G.setSpawnPoints(w, [{ x: 0, y: 0 }]);
    G.addTemporarySafeSpawnPoint(w, { x: 400, y: 0 }, 5);
    expect(G.inSpawnSafeRadius(w, 0, 0)).toBe(true);
    expect(G.inSpawnSafeRadius(w, 400, 0)).toBe(true);
    w.tick += 20 * 5;
    expect(G.inSpawnSafeRadius(w, 400, 0)).toBe(false);
    expect(G.inSpawnSafeRadius(w, 0, 0)).toBe(true); // the installed point is untouched
  });
});
