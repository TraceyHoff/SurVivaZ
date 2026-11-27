// ADR-535: zombies on/off setting (new worlds only). Off blocks every ambient zombie spawn path —
// the population spawner (zombie entries filtered out, PopulationZombies never set), the legacy
// per-player spawner, and the horde director (hordes ARE zombies, so zombies-off forces hordes off
// even when hordes are on) — while animals keep spawning and zombies-on behaviour is unchanged.
// Old saves load with zombies on (schema migration in the persist test; save-meta default in the
// client test).
import { describe, expect, it } from "vitest";
import { installPermissions, Membership, PlayerId, setTimeOfDay, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned } from "./helpers.js";

const d = G.defaultDefs();
const walker = { kind: "zombie_walker", category: "zombie", density: 1, timeWeights: { day: 1, night: 1, dawn: 1, dusk: 1 }, minPlayerDistance: 10, perChunkCap: 5, globalCap: 50, despawnDistance: 60, group: [1, 1] as [number, number] };
const wolf = { kind: "animal_wolf", category: "animal", density: 1, timeWeights: { day: 1, night: 1, dawn: 1, dusk: 1 }, minPlayerDistance: 10, perChunkCap: 5, globalCap: 50, despawnDistance: 70, group: [1, 1] as [number, number] };

/** One walker + one wolf entry over chunk "12,0" (x [384,416), y [0,32)), player at its corner. */
const popRig = (zombies: boolean): { w: World; sp: ReturnType<typeof G.installPopulation> } => {
  const w = makeWorld({ worldRules: { zombies } }); installPermissions(w);
  if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = spawnLearned(w, { x: 384, y: 0, maxWeight: 0, clientId: 1 });
  w.add(p, PlayerId, { id: 1 });
  const sp = G.installPopulation(w, { chunks: () => ["12,0"], viewpoints: () => [{ x: 384, y: 0 }], spawns: [walker, wolf], tileAt: () => 3 });
  return { w, sp };
};
/** Player + an ownerless foundation at night, grace 0 — a horde-eligible world. */
const directorRig = (zombies: boolean): { w: World } => {
  const w = makeWorld({ worldRules: { zombies, hordes: true, hordeGraceDays: 0 } }); installPermissions(w);
  const p = G.spawnPlayer(w, { x: 10.5, y: 10.5, maxWeight: 0, clientId: 1 });
  w.add(p, PlayerId, { id: 7 }).add(p, Membership, { partyId: 0, clanId: 0 });
  const sn = G.snapPlacement(w, { piece: d.pieceId("foundation")!, x: 12, y: 12, level: 0, rot: 0, tier: 0, variant: 0 });
  if (typeof sn !== "object") throw new Error("snap");
  G.placePiece(w, 0 as Entity, sn, { pay: false });
  setTimeOfDay(w, 0, 0); // night: hordes run at dusk / night
  return { w };
};
/** First director call arms nextTick; jump past it; the second call schedules (or, when gated, does not).
 *  Jumping the tick moves the clock (half a day), so re-set night before the second call. */
const driveDirector = (w: World): void => {
  G.hordeDirectorSystem(w);
  w.tick = G.hordeRuntime(w).nextTick + 1;
  setTimeOfDay(w, 0, 0); // back to night: the tick jump moved the clock to noon
  G.hordeDirectorSystem(w);
};

describe("ADR-535 zombies on/off setting", () => {
  it("world rules default to zombies on; setWorldRules merges the toggle without touching the rest", () => {
    const w = makeWorld();
    expect(G.worldRules(w)).toEqual({ hordes: true, hordeGraceDays: 3, aiHumans: true, zombies: true, creative: false });
    G.setWorldRules(w, { zombies: false });
    expect(G.worldRules(w)).toEqual({ hordes: true, hordeGraceDays: 3, aiHumans: true, zombies: false, creative: false });
    G.setWorldRules(w, { zombies: true, hordeGraceDays: 5 });
    expect(G.worldRules(w)).toEqual({ hordes: true, hordeGraceDays: 5, aiHumans: true, zombies: true, creative: false });
  });

  it("population spawner: zombies off spawns no zombies and never sets PopulationZombies; animals still spawn", () => {
    const { w, sp } = popRig(false);
    for (let i = 0; i < 10; i++) sp.step();
    expect([...w.query([G.Zombie, Transform])]).toHaveLength(0);
    expect(w.getResource(G.PopulationZombies)).toBeUndefined();
    expect([...w.query([G.Animal, Transform])].length).toBeGreaterThan(0); // wolves unaffected
  });
  it("population spawner control: zombies on spawns zombies and sets PopulationZombies", () => {
    const { w, sp } = popRig(true);
    for (let i = 0; i < 10; i++) sp.step();
    expect([...w.query([G.Zombie, Transform])].length).toBeGreaterThan(0);
    expect(w.getResource(G.PopulationZombies)).toBe(true);
  });

  it("legacy spawner: zombies off spawns nothing even with a player standing in the open", () => {
    const w = makeWorld({ worldRules: { zombies: false } }); installPermissions(w);
    if (!w.isRegistered(PlayerId)) w.register(PlayerId);
    const p = spawnLearned(w, { x: 100, y: 100, maxWeight: 0, clientId: 1 });
    w.add(p, PlayerId, { id: 1 });
    for (let i = 0; i < 2000; i++) G.zombieSpawnerSystem(w, 2);
    expect([...w.query([G.Zombie, Transform])]).toHaveLength(0);
    void p;
  });
  it("legacy spawner control: zombies on still spawns around a player", () => {
    const w = makeWorld({ worldRules: { zombies: true } }); installPermissions(w);
    if (!w.isRegistered(PlayerId)) w.register(PlayerId);
    const p = spawnLearned(w, { x: 100, y: 100, maxWeight: 0, clientId: 1 });
    w.add(p, PlayerId, { id: 1 });
    for (let i = 0; i < 2000; i++) G.zombieSpawnerSystem(w, 2);
    expect([...w.query([G.Zombie, Transform])].length).toBeGreaterThan(0);
    void p;
  });

  it("horde director: zombies off schedules no horde even with hordes on and a target base", () => {
    const { w } = directorRig(false);
    driveDirector(w);
    expect(G.hordeRuntime(w).pending).toBeUndefined();
    expect(w.get(w.environment, G.HordeStatus)?.phase ?? G.HordePhase.Idle).toBe(G.HordePhase.Idle);
    expect([...w.query([G.Zombie, Transform])]).toHaveLength(0);
  });
  it("horde director control: zombies on warns a horde against the same base", () => {
    const { w } = directorRig(true);
    driveDirector(w);
    expect(G.hordeRuntime(w).pending).toBeDefined();
    expect(w.get(w.environment, G.HordeStatus)?.phase).toBe(G.HordePhase.Warning);
  });

  it("a standing zombie is untouched by the toggle (only spawning is gated)", () => {
    const w = makeWorld({ worldRules: { zombies: false } });
    const z = G.spawnZombie(w, "zombie_walker", 100, 100); // direct spawns (tests / dev hooks) stay as-is
    expect(w.isAlive(z)).toBe(true);
    expect(w.has(z, G.Zombie)).toBe(true);
  });
});
