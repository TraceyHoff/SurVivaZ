/**
 * ADR-463: carrion birds — a fresh animal or zombie kill near a survivor draws 2 crows that circle
 * the kill on the ground (no flight logic). The crows circle the kill's loot bag (or the death spot
 * when there is no bag), leave when the bag is gone (looted / despawned) or when the 120 s cap
 * expires, and never spawn for a kill far from any player or for a player death.
 */
import { describe, it, expect } from "vitest";
import { Transform, type Entity, type World } from "@engine/core";
import { TileMap } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld as baseWorld, steps } from "./helpers.js";

const makeWorld = (): World => {
  const w = baseWorld();
  w.setResource(G.TerrainRes, G.terrainFromTileMap(new TileMap())); // open ground, no water
  w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem);
  return w;
};
const kill = (w: World, e: Entity) => { const h = w.get(e, G.Health)!; w.set(e, G.Health, { hp: 0, max: h.max }); };
const crows = (w: World) => [...w.query([G.Animal, G.Carrion])];
const bags = (w: World) => [...w.query([G.LootBag, Transform])];
/** Kill a rabbit at (x, y) with a player at (0, 0); step until the crows arrive (or 20 ticks). */
function killNearPlayer(w: World, x: number, y: number): Entity {
  G.spawnPlayer(w, { x: 0, y: 0 });
  const rabbit = G.spawnAnimal(w, "animal_rabbit", x, y);
  kill(w, rabbit);
  return rabbit;
}
function awaitCrows(w: World, n: number, maxTicks = 20): Entity[] {
  for (let i = 0; i < maxTicks; i++) { steps(w, 1); if (crows(w).length >= n) break; }
  return crows(w);
}

describe("ADR-463 carrion birds", () => {
  it("carrion tuning ships with the scoped defaults", () => {
    expect(G.carrionTuning()).toEqual({ crowsPerKill: 2, circleRadius: 2.5, maxSeconds: 120, nearPlayerTiles: 40 });
  });

  it("a rabbit kill near a player draws 2 crows that adopt the kill's loot bag", () => {
    const w = makeWorld();
    killNearPlayer(w, 10, 0);
    const cs = awaitCrows(w, 2);
    expect(cs.length).toBe(2);
    for (const c of cs) {
      const carr = w.get(c, G.Carrion)!;
      expect(carr.bag).not.toBe(0); // rabbit loot is guaranteed (raw_meat chance 1), so a bag exists
      expect(w.isAlive(carr.bag)).toBe(true);
      const home = w.get(c, G.Animal)!;
      expect(home.homeX).toBe(10); expect(home.homeY).toBe(0); // circle the kill, not the spawn spot
      expect(w.get(c, G.Animal)!.kind).toBe(G.animalKindOf("animal_crow"));
    }
    const bag = bags(w);
    expect(bag.length).toBe(1);
    const bt = w.get(bag[0]!, Transform)!;
    expect(bt.x).toBeCloseTo(10, 0); expect(bt.y).toBeCloseTo(0, 0); // the bag is at the death spot
  });

  it("the crows circle the kill on the ground (they move, and stay near the death spot)", () => {
    const w = makeWorld();
    killNearPlayer(w, 10, 0);
    const cs = awaitCrows(w, 2);
    expect(cs.length).toBe(2);
    const crow = cs[0]!;
    let moved = 0; let maxDist = 0;
    let prev = w.get(crow, Transform)!;
    for (let i = 0; i < 1200; i++) { // 60 s
      steps(w, 1);
      if (!w.isAlive(crow)) break;
      const t = w.get(crow, Transform)!;
      moved += Math.hypot(t.x - prev.x, t.y - prev.y);
      maxDist = Math.max(maxDist, Math.hypot(t.x - 10, t.y - 0));
      prev = t;
    }
    expect(w.isAlive(crow)).toBe(true); // still circling at 60 s (cap is 120 s)
    expect(moved).toBeGreaterThan(2); // it walked around the circle
    expect(maxDist).toBeLessThan(6); // and never strayed from the kill
  });

  it("the crows leave when the 120 s cap expires", () => {
    const w = makeWorld();
    killNearPlayer(w, 10, 0);
    const cs = awaitCrows(w, 2);
    expect(cs.length).toBe(2);
    for (let i = 0; i < 3000 && crows(w).length > 0; i += 20) steps(w, 20); // 150 s
    expect(crows(w).length).toBe(0);
  });

  it("the crows leave when the kill's loot bag is gone", () => {
    const w = makeWorld();
    killNearPlayer(w, 10, 0);
    const cs = awaitCrows(w, 2);
    expect(cs.length).toBe(2);
    const bag = bags(w);
    expect(bag.length).toBe(1);
    w.destroy(bag[0]!); // looted / despawned
    for (let i = 0; i < 200 && crows(w).length > 0; i++) steps(w, 1); // next think is ≤ 6 s away
    expect(crows(w).length).toBe(0);
  });

  it("a kill far from any player draws no crows", () => {
    const w = makeWorld();
    G.spawnPlayer(w, { x: 0, y: 0 });
    const rabbit = G.spawnAnimal(w, "animal_rabbit", 100, 0);
    kill(w, rabbit);
    steps(w, 10);
    expect(w.has(rabbit, G.Dead)).toBe(true); // the kill really happened
    expect(crows(w).length).toBe(0);
  });

  it("a player death draws no crows", () => {
    const w = makeWorld();
    const p1 = G.spawnPlayer(w, { x: 0, y: 0 });
    G.spawnPlayer(w, { x: 5, y: 0 }); // a witness nearby
    kill(w, p1);
    steps(w, 10);
    expect(w.has(p1, G.Dead)).toBe(true); // the player really died
    expect(crows(w).length).toBe(0);
  });
});
