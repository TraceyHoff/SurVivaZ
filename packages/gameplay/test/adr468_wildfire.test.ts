/**
 * ADR-468: wildfire — fire on vegetation and across terrain.
 *
 * Trees, fruit trees and dry grass can burn (a Burning node decays and depletes — tree → stump +
 * regrow, grass → gone); stumps, berry bushes and crops do not burn. A burning node spreads to
 * nearby fuel with chance 0.08 × dryness (1 − chunk wetness) × the ADR-465 wind factor, capped at
 * 128 concurrently burning vegetation nodes. Spread children are plain fires (rain quenches them,
 * even when the parent is an exempt lightning fire). Lightning now ignites the tree it strikes
 * instead of scorching it outright — it burns ~8 s, can spread, and depletes to the same stump +
 * regrow end state (see the updated ADR-451 tests).
 *
 * The spread roll is `rng.next()` on the per-entity "fire.spread" stream, which is hashed from
 * (seed, tick, key, entity) — so the tests pin the world seed to one whose first draw at tick 20
 * (the first burning check) is known (probed once, deterministic for the pinned seed and the
 * creation order player → burning tree → neighbour): seed 80 draws 0.0056 (spreads dry/calm),
 * seed 73 draws 0.0540 (spreads dry at chance 0.08, not at wetness 0.5 / chance 0.04), seed 55
 * draws 0.1110 (spreads downwind at chance 0.16, not calm at 0.08 or upwind at 0.008).
 */
import { describe, expect, it } from "vitest";
import { Weather, type Entity, type World } from "@engine/core";
import { chunkKeyOf } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

const d = G.defaultDefs();
/** Run one burning check (checkSeconds 1 s = 20 ticks at 20 Hz). */
const check = (w: World): void => { w.tick += 20; G.burningSystem(w, 1 / 20); };
const setWeather = (w: World, kind: number, intensity = 1, windSpeed = 0, windDir = 0): void => {
  Object.assign(w.env(Weather), { kind, intensity, windSpeed, windDir, endsAtTick: 0xffffffff });
};
/** Chunk wetness 0..255 for the chunk containing the origin (created after the trees, so the burning tree keeps entity id 2 — the probed stream). */
const setWetness = (w: World, wetness: number): void => {
  const s = G.ensureChunkSurface(w, chunkKeyOf(0, 0));
  w.set(s, G.ChunkSurface, { cx: 0, cy: 0, wetness, snow: 0 });
};
/** Player, then a burning tree at (0, 0) and a neighbour at (1.5, 0) — inside the 2.0 spread radius. */
const pair = (seed: number): { w: World; a: Entity; b: Entity } => {
  const w = makeWorld({}, seed);
  G.spawnPlayer(w, { x: 0, y: 0 });
  const a = G.spawnResourceNode(w, "tree", 0, 0);
  const b = G.spawnResourceNode(w, "tree", 1.5, 0);
  return { w, a, b };
};

describe("ADR-468 wildfire fuel and burn-out", () => {
  it("isVegetationFuel: axe and fruit trees and dry grass burn; stumps, bushes and crops do not", () => {
    const w = makeWorld();
    for (const k of ["tree", "oak_tree", "pine_tree", "birch_tree", "maple_tree", "willow_tree", "palm_tree", "resin_tree", "apple_tree", "pear_tree", "cherry_tree", "orange_tree", "peach_tree", "fiber_grass"]) {
      expect(G.isVegetationFuel(w, d.resourceId(k))).toBe(true);
    }
    for (const k of ["tree_stump", "rotten_stump", "berry_bush", "blueberry_bush", "raspberry_bush", "blackberry_bush", "strawberry_bush", "cotton_bush", "fiber_bush"]) {
      expect(G.isVegetationFuel(w, d.resourceId(k))).toBe(false);
    }
    expect(G.isVegetationFuel(w, 99999)).toBe(false);
  });

  it("ignite: a tree and dry grass ignite, a stump and a berry bush do not", () => {
    const w = makeWorld();
    const tree = G.spawnResourceNode(w, "tree", 0, 0);
    expect(G.ignite(w, tree)).toBe(true);
    expect(w.get(tree, G.Burning)?.lit).toBe(1);
    expect(w.get(tree, G.Burning)?.intensity).toBe(128);
    const grass = G.spawnResourceNode(w, "fiber_grass", 5, 0);
    expect(G.ignite(w, grass)).toBe(true);
    const stump = G.spawnResourceNode(w, "tree_stump", 10, 0);
    expect(G.ignite(w, stump)).toBe(false);
    expect(w.has(stump, G.Burning)).toBe(false);
    const bush = G.spawnResourceNode(w, "berry_bush", 15, 0);
    expect(G.ignite(w, bush)).toBe(false);
    expect(w.has(bush, G.Burning)).toBe(false);
  });

  it("a burning tree decays 16 per check and depletes to a stump regrow marker at 0", () => {
    const w = makeWorld();
    const tree = G.spawnResourceNode(w, "tree", 0, 0);
    expect(G.ignite(w, tree)).toBe(true);
    check(w);
    expect(w.get(tree, G.Burning)?.intensity).toBe(112);
    for (let i = 0; i < 7; i++) check(w); // 8 checks total: 128 → 0
    expect(w.isAlive(tree)).toBe(false);
    expect(w.has(tree, G.Burning)).toBe(false);
    const markers = [...w.query([G.NodeRegrow])];
    expect(markers.length).toBe(1);
    const m = w.get(markers[0]!, G.NodeRegrow)!;
    expect(m.kind).toBe(d.resourceId("tree"));
    expect(m.stumpUntilTick).toBeGreaterThan(w.tick); // a stump stands for stumpSeconds
  });

  it("burnt-out grass leaves no stump (gone for its respawn, then regrows)", () => {
    const w = makeWorld();
    const grass = G.spawnResourceNode(w, "fiber_grass", 0, 0);
    expect(G.ignite(w, grass)).toBe(true);
    for (let i = 0; i < 8; i++) check(w);
    expect(w.isAlive(grass)).toBe(false);
    const markers = [...w.query([G.NodeRegrow])];
    expect(markers.length).toBe(1);
    expect(w.get(markers[0]!, G.NodeRegrow)!.stumpUntilTick).toBe(0);
  });

  it("rain quenches a vegetation fire in ~3 checks (and the tree is still consumed)", () => {
    const w = makeWorld();
    setWeather(w, G.WeatherKind.Rain, 1);
    const tree = G.spawnResourceNode(w, "tree", 0, 0);
    expect(G.ignite(w, tree)).toBe(true);
    check(w);
    expect(w.get(tree, G.Burning)?.intensity).toBe(72); // 128 - 16 decay - 40 quench
    check(w);
    expect(w.get(tree, G.Burning)?.intensity).toBe(16);
    check(w);
    expect(w.isAlive(tree)).toBe(false); // burnt out: fire out, tree gone
    expect([...w.query([G.NodeRegrow])].length).toBe(1);
  });

  it("a lightning-ignited tree is exempt from storm quench and grows (node version of the ADR-451 piece test)", () => {
    const w = makeWorld();
    setWeather(w, G.WeatherKind.Storm, 1);
    const tree = G.spawnResourceNode(w, "tree", 0, 0);
    expect(G.igniteLightning(w, tree)).toBe(true);
    for (let i = 0; i < 7; i++) check(w);
    const b = w.get(tree, G.Burning);
    expect(b?.lit).toBe(1);
    // nodes decay 16 per check (they do not grow like pieces) — the exemption only removes the
    // 40/check storm quench, so after 7 checks the tree is at 128 - 7*16 = 16 and still burning,
    // where a plain fire in the same storm would have burnt out at check 3
    expect(b!.intensity).toBe(16);
    expect(w.has(tree, G.LightningFire)).toBe(true);
  });
});

describe("ADR-468 wildfire spread", () => {
  it("a burning tree ignites a neighbour in dry calm air (seed 80, first draw 0.0056 < 0.08)", () => {
    const { w, a, b } = pair(80);
    expect(G.ignite(w, a)).toBe(true);
    check(w);
    expect(w.get(b, G.Burning)?.lit).toBe(1);
    expect(w.has(b, G.LightningFire)).toBe(false); // a spread child is a plain fire
  });

  it("soaked ground throttles spread: the same draw spreads dry but not at wetness 0.5 (seed 73)", () => {
    const dry = pair(73);
    expect(G.ignite(dry.w, dry.a)).toBe(true);
    check(dry.w);
    expect(dry.w.get(dry.b, G.Burning)?.lit).toBe(1); // draw 0.0706 < 0.08
    const wet = pair(73);
    setWetness(wet.w, 128); // wetness 0.5 → chance 0.08 × 0.5 = 0.04
    expect(G.ignite(wet.w, wet.a)).toBe(true);
    check(wet.w);
    expect(wet.w.has(wet.b, G.Burning)).toBe(false); // draw 0.0706 >= 0.04
  });

  it("wind fans spread: the same draw spreads downwind, not calm and not upwind (seed 55, draw 0.1110)", () => {
    // calm: chance 0.08, draw 0.0925 → no spread
    const calm = pair(55);
    setWeather(calm.w, G.WeatherKind.Clear, 1, 0, 0);
    expect(G.ignite(calm.w, calm.a)).toBe(true);
    check(calm.w);
    expect(calm.w.has(calm.b, G.Burning)).toBe(false);
    // downwind (wind blows east, toward the neighbour): chance 0.16 → spread
    const down = pair(55);
    setWeather(down.w, G.WeatherKind.Clear, 1, 12, 0);
    expect(G.ignite(down.w, down.a)).toBe(true);
    check(down.w);
    expect(down.w.get(down.b, G.Burning)?.lit).toBe(1);
    // upwind (wind blows west, away): chance 0.008 → no spread
    const up = pair(55);
    setWeather(up.w, G.WeatherKind.Clear, 1, 12, Math.PI);
    expect(G.ignite(up.w, up.a)).toBe(true);
    check(up.w);
    expect(up.w.has(up.b, G.Burning)).toBe(false);
  });

  it("a spread child in a storm is quenched (no LightningFire) and burns out in ~3 checks", () => {
    const { w, a, b } = pair(80);
    setWeather(w, G.WeatherKind.Storm, 1);
    expect(G.igniteLightning(w, a)).toBe(true); // the parent is exempt
    check(w); // the child ignites (draw 0.0006) at intensity 128
    expect(w.get(b, G.Burning)?.lit).toBe(1);
    expect(w.has(b, G.LightningFire)).toBe(false);
    check(w);
    expect(w.get(b, G.Burning)?.intensity).toBe(72); // 128 - 16 - 40
    check(w);
    check(w);
    expect(w.isAlive(b)).toBe(false); // quenched out and consumed
    expect(w.get(a, G.Burning)?.lit).toBe(1); // the exempt parent is still burning
  });

  it("the cap: at 128 burning vegetation nodes, spread ignitions fail and the fire burns down", () => {
    const w = makeWorld({}, 47);
    G.spawnPlayer(w, { x: 0, y: 0 });
    const burning: Entity[] = [];
    for (let i = 0; i < 127; i++) {
      const t = G.spawnResourceNode(w, "tree", -60 + (i % 16) * 5, -60 + Math.floor(i / 16) * 5);
      expect(G.ignite(w, t)).toBe(true);
      burning.push(t);
    }
    const near = G.spawnResourceNode(w, "tree", 0, 0);
    expect(G.ignite(w, near)).toBe(true); // the 128th burning node, adjacent to the neighbour
    const neighbour = G.spawnResourceNode(w, "tree", 1.5, 0);
    check(w); // the near tree's spread roll would succeed (draw 0.0056 at tick 20) — the cap blocks it
    expect(w.has(neighbour, G.Burning)).toBe(false);
    expect([...w.query([G.Burning])].length).toBe(128);
    void burning;
  });

  it("fire.json vegetation tuning", () => {
    expect(G.FIRE.vegetation.spreadRadius).toBe(2.0);
    expect(G.FIRE.vegetation.spreadChance).toBe(0.08);
    expect(G.FIRE.vegetation.maxBurning).toBe(128);
  });
});
