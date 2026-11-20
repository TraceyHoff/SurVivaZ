/**
 * ADR-451: lightning in storms — one gameplay strike per storm, rolled server-side on WeatherChanged.
 * Tree scorch = node depletion (dies, regrows; a stump for stumpSeconds). A strike on a flammable
 * piece starts a lightning fire, exempt from storm quench. Strikes land near survivors, never on them.
 */
import { describe, it, expect } from "vitest";
import { setTimeOfDay, Weather, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
const id = (k: string) => d.itemId(k);
/** Stub rng: angle 0, minimum distance — the strike point is exactly 5 tiles east of the anchor. */
const eastRng = { next: () => 0, int: () => 0 };
const TREE_ID = d.resourceId("tree");

function storm(w: World): void {
  setTimeOfDay(w, 12, 1); // day 1: past the first-day no-rain rule
  Object.assign(w.env(Weather), { kind: G.WeatherKind.Storm, intensity: 1, endsAtTick: 0xffffffff });
}
/** Place a wooden wall at (x,y) (same builder pattern as Task 24). */
function wallAt(w: World, b: Entity, x: number, y: number): Entity {
  const sn = G.snapPlacement(w, { piece: d.pieceId("wall"), x, y, level: 0, rot: 0, tier: 1, variant: 0 });
  if (typeof sn === "number") throw new Error(`snap wall ${sn}`);
  return G.placePiece(w, b, sn, { pay: false });
}

describe("ADR-451 lightning in storms", () => {
  it("a strike on a tree depletes it, leaving a stump regrow marker", () => {
    const w = makeWorld();
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    const tree = G.spawnResourceNode(w, "tree", 5, 0);
    const hit = G.resolveLightningStrike(w, eastRng);
    expect(hit?.kind).toBe("tree");
    expect(hit?.entity).toBe(tree);
    expect(w.isAlive(tree)).toBe(false);
    const markers = [...w.query([G.NodeRegrow])];
    expect(markers.length).toBe(1);
    const m = w.get(markers[0]!, G.NodeRegrow)!;
    expect(m.kind).toBe(TREE_ID);
    expect(m.stumpUntilTick).toBeGreaterThan(w.tick); // a stump stands for stumpSeconds
    expect(m.respawnAtTick).toBe(w.tick + 300 * 20); // respawnSeconds 300 x respawnMul 1
    void p;
  });

  it("a strike with no tree ignites the nearest flammable piece as a lightning fire", () => {
    const w = makeWorld();
    const b = spawnLearned(w, { x: 0, y: 0 });
    const wall = wallAt(w, b, 5, 0);
    const hit = G.resolveLightningStrike(w, eastRng);
    expect(hit?.kind).toBe("fire");
    expect(hit?.entity).toBe(wall);
    expect(w.get(wall, G.Burning)?.lit).toBe(1);
    expect(w.has(wall, G.LightningFire)).toBe(true);
  });

  it("a storm start (WeatherChanged) rolls exactly one strike", () => {
    const w = makeWorld();
    G.spawnPlayer(w, { x: 0, y: 0 });
    // a ring of trees: any strike point 5..15 tiles out is within 15 of a tree
    const trees: Entity[] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      trees.push(G.spawnResourceNode(w, "tree", 8 * Math.cos(a), 8 * Math.sin(a)));
    }
    G.emit(w, G.WeatherChanged, { from: G.WeatherKind.Clear, to: G.WeatherKind.Storm, intensity: 1, ticks: 1200 });
    steps(w, 1); // emit is deferred: delivery happens on the step
    const dead = trees.filter((t) => !w.isAlive(t));
    expect(dead.length).toBe(1);
    expect([...w.query([G.NodeRegrow])].length).toBe(1);
  });

  it("a storm start with no survivors strikes nothing", () => {
    const w = makeWorld();
    const tree = G.spawnResourceNode(w, "tree", 5, 0);
    G.emit(w, G.WeatherChanged, { from: G.WeatherKind.Clear, to: G.WeatherKind.Storm, intensity: 1, ticks: 1200 });
    steps(w, 1); // emit is deferred: delivery happens on the step
    expect(w.isAlive(tree)).toBe(true);
    expect([...w.query([G.NodeRegrow])].length).toBe(0);
  });

  it("an ordinary fire dies in a storm but a lightning fire survives and grows", () => {
    const w = makeWorld();
    const b = spawnLearned(w, { x: 0, y: 0 });
    const plain = wallAt(w, b, 5, 0);
    const struck = wallAt(w, b, -5, 0);
    expect(G.ignite(w, plain)).toBe(true);
    expect(G.igniteLightning(w, struck)).toBe(true);
    storm(w);
    steps(w, 140); // 7 burning checks at 1 s cadence
    expect(w.has(plain, G.Burning)).toBe(false); // quenched: 128 + 16 - 40 per check
    const b2 = w.get(struck, G.Burning);
    expect(b2?.lit).toBe(1);
    expect(b2!.intensity).toBeGreaterThan(128); // exempt: grows 16 per check
    expect(w.has(struck, G.LightningFire)).toBe(true);
  });

  it("extinguishing a lightning fire removes the exemption", () => {
    const w = makeWorld();
    const b = spawnLearned(w, { x: 0, y: 0 });
    const wall = wallAt(w, b, 5, 0);
    G.igniteLightning(w, wall);
    expect(w.has(wall, G.LightningFire)).toBe(true);
    G.extinguish(w, wall);
    expect(w.has(wall, G.Burning)).toBe(false);
    expect(w.has(wall, G.LightningFire)).toBe(false);
  });

  it("lightning tuning lives in fire.json", () => {
    expect(G.FIRE.lightning.strikesPerStorm).toBe(1);
    expect(G.FIRE.lightning.radius).toBe(15);
    expect(G.FIRE.lightning.minDistance).toBe(5);
  });
});
