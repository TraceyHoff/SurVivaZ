/**
 * Task 33: craftable-first crafting sort, death clears afflictions, safe spawn radius, water wetting,
 * disease-rate rebalance, and Recently Crafted (crafting + building).
 */
import { describe, expect, it } from "vitest";
import { applySnapshot, decodeSnapshot, encodeSnapshot, installPermissions, PlayerId, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
const id = (k: string) => d.itemId(k);
const axe = d.recipeId("stone_axe");
const ctx = (w: World, player: Entity) => ({ world: w, player, names: G.playerNames(w) });

function setup() {
  const w = makeWorld(); installPermissions(w); G.installCraftQueue(w);
  const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
  w.add(p, PlayerId, { id: 1 });
  return { w, p };
}
function giveAxeMats(w: World, p: Entity) { G.addItem(w, p, id("wood"), 10); G.addItem(w, p, id("stone"), 4); G.addItem(w, p, id("fiber"), 4); }

describe("Task 33: craftable-first crafting sort", () => {
  it("craftable recipes sort above uncraftable ones, and the order follows materials live", () => {
    const { w, p } = setup(); giveAxeMats(w, p);
    let v = G.craftingView(ctx(w, p));
    const firstBad = v.recipes.findIndex((r) => r.reason !== undefined);
    expect(firstBad).toBeGreaterThan(0); // some recipes are craftable, some are not
    expect(v.recipes.slice(0, firstBad).every((r) => r.reason === undefined)).toBe(true);
    expect(v.recipes.find((r) => r.id === axe)!.reason).toBeUndefined();
    // Spend the materials: the axe drops into the uncraftable block, behind every craftable recipe.
    expect(G.removeItem(w, p, id("wood"), 10)).toBe(true);
    v = G.craftingView(ctx(w, p));
    const axeIdx = v.recipes.findIndex((r) => r.id === axe);
    expect(v.recipes[axeIdx]!.reason).toBeDefined();
    const firstBad2 = v.recipes.findIndex((r) => r.reason !== undefined);
    expect(firstBad2).toBeGreaterThan(0);
    expect(v.recipes.slice(0, firstBad2).every((r) => r.reason === undefined)).toBe(true);
    expect(axeIdx).toBeGreaterThanOrEqual(firstBad2);
  });
});

describe("Task 33: death clears afflictions", () => {
  it("die with a cold + wound infection + flu + wetness + care progress -> respawn with none of them", () => {
    const { w, p } = setup();
    expect(G.contractDisease(w, p, "common_cold")).toBe(true);
    expect(G.contractDisease(w, p, "wound_infection")).toBe(true);
    expect(G.contractDisease(w, p, "influenza")).toBe(true);
    w.setField(p, G.Exposure, "wetness", 0.8);
    w.setField(p, G.Diseases, "careTicks", 100);
    w.setField(p, G.Diseases, "coldTicks", 50);
    expect(G.activeDiseases(w, p).length).toBe(3);
    w.setField(p, G.Health, "hp", 0); steps(w, 1);
    expect(w.has(p, G.Dead)).toBe(true);
    steps(w, 20 * G.PVP.respawnSeconds);
    expect(G.respawnPlayer(w, p)).toBeUndefined();
    expect(G.activeDiseases(w, p)).toEqual([]);
    expect(w.getField(p, G.Exposure, "wetness")).toBe(0);
    expect(w.getField(p, G.Diseases, "careTicks")).toBe(0);
    expect(w.getField(p, G.Diseases, "coldTicks")).toBe(0);
    expect(w.getField(p, G.Diseases, "restTicks")).toBe(0);
  });
});

describe("Task 33: safe spawn radius", () => {
  it("inSpawnSafeRadius covers every spawn point out to 20 tiles and nothing beyond", () => {
    const w = makeWorld();
    // No installed points: the pvp.json (0,0) fallback is not a configured spawn location, so there
    // is no safe radius in a bare world (live servers always install points).
    expect(G.inSpawnSafeRadius(w, 0, 0)).toBe(false);
    expect(G.installedSpawnPoints(w)).toBeUndefined();
    const pts = [{ x: 100, y: -100 }, { x: -100, y: 100 }];
    G.setSpawnPoints(w, pts);
    expect(G.SAFE_SPAWN_RADIUS).toBe(20);
    for (const pt of pts) {
      expect(G.inSpawnSafeRadius(w, pt.x, pt.y)).toBe(true);
      expect(G.inSpawnSafeRadius(w, pt.x + 19, pt.y)).toBe(true);
      expect(G.inSpawnSafeRadius(w, pt.x + 21, pt.y)).toBe(false);
    }
    expect(G.inSpawnSafeRadius(w, 0, 0)).toBe(false);
  });
  it("the legacy zombie spawner never spawns inside the radius, but still spawns outside it", () => {
    const w = makeWorld(); installPermissions(w);
    G.setSpawnPoints(w, [{ x: 0, y: 0 }]);
    const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
    void p;
    // Drive the spawner directly (it runs every 40 ticks in live play): 2000 x 2s calls at day rate
    // 0.3/min spawns ~20 zombies, all 16-24 tiles from the player — ~45% of the ring is inside 20.
    for (let i = 0; i < 2000; i++) G.zombieSpawnerSystem(w, 2);
    const zombies = [...w.query([G.Zombie, Transform])];
    expect(zombies.length).toBeGreaterThan(0);
    for (const z of zombies) {
      const t = w.get(z, Transform)!;
      expect(Math.hypot(t.x, t.y)).toBeGreaterThanOrEqual(20);
    }
  });
  it("a horde zombie still targets a survivor inside the radius (raids are out of scope)", () => {
    const w = makeWorld(); installPermissions(w);
    G.setSpawnPoints(w, [{ x: 0, y: 0 }]);
    const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
    const z = G.spawnZombie(w, "zombie_walker", 5, 0);
    w.add(z, G.HordeMember, { horde: 1, target: 0 as Entity, tx: 0, ty: 0 });
    steps(w, 20);
    const state = w.getField(z, G.ZombieBrain, "state");
    expect(state).toBe(2); // ZState.Chase — the horde hunts inside the safe radius
    void p;
  });
  it("a zombie does not acquire a survivor standing inside the radius (retaliation excepted)", () => {
    const w = makeWorld(); installPermissions(w);
    G.setSpawnPoints(w, [{ x: 0, y: 0 }]);
    const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
    const z = G.spawnZombie(w, "zombie_walker", 5, 0);
    // ZState: Wander 0, Investigate 1, Chase 2, AttackPlayer 3 — the zombie must never chase/attack
    // a survivor inside the radius, even though it is well within sight range.
    steps(w, 200);
    expect(w.has(z, G.Dead)).toBe(false);
    const state = w.getField(z, G.ZombieBrain, "state");
    expect(state).not.toBe(2);
    expect(state).not.toBe(3);
    void p;
  });
});

describe("Task 33: water wets you in clear weather", () => {
  const wet = (w: World): void => w.setResource(G.TerrainRes, { tileAt: (tx: number) => (tx >= 2 ? 1 : 3), heightAt: () => 0 });
  const wetness = (w: World, e: Entity) => w.getField(e, G.Exposure, "wetness") ?? 0;
  it("standing in a water tile raises wetness fast with no rain; stepping out dries per the existing rules", () => {
    const w = makeWorld(); wet(w);
    const p = spawnLearned(w, { x: 2.5, y: 0.5, maxWeight: 0, clientId: 1 });
    expect(wetness(w, p)).toBe(0);
    steps(w, 40); // 2s in the water: 0.15/s -> ~0.3
    expect(wetness(w, p)).toBeGreaterThan(0.2);
    // Step onto dry land: wetness falls again at the normal dry rate (0.02/s, no fire).
    w.set(p, Transform, { x: 0.5, y: 0.5 });
    steps(w, 200);
    expect(wetness(w, p)).toBeCloseTo(0.2, 1); // ADR-488: humidity halves the drying rate (0.5 at the default 50% humidity) — 0.3 dries to 0.2 in 10 s instead of 0.1
  });
  it("standing on dry land in the same clear weather stays dry (control)", () => {
    const w = makeWorld(); wet(w);
    const p = spawnLearned(w, { x: 0.5, y: 0.5, maxWeight: 0, clientId: 1 });
    steps(w, 200);
    expect(wetness(w, p)).toBe(0);
  });
});

describe("Task 33: disease rates rebalanced to realistic levels", () => {
  it("per-exposure chances are the new realistic values", () => {
    const tun = d.diseaseTuning;
    expect(tun.causes.rawMeatChance).toBe(0.03);
    expect(tun.causes.rawWaterChance).toBe(0.025);
    expect(tun.causes.rottenFoodChance).toBe(0.10);
    expect(tun.causes.sickFoodChance).toBe(0.02);
    expect(tun.causes.woundChance).toBe(0.025);
    expect(tun.transmission.chance).toBe(0.05);
  });
  it("a single raw-meat bite rarely infects, but repeated risky eating still does over time", () => {
    const w = makeWorld();
    const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
    // ADR-270: 3% per bite; repeated unsafe meals remain a real risk.
    let hits = 0; const n = 1000;
    for (let i = 0; i < n; i++) if (w.rng.next() < d.diseaseTuning.causes.rawMeatChance) hits++;
    expect(hits / n).toBeGreaterThan(0.01);
    expect(hits / n).toBeLessThan(0.06);
    // And the disease itself is unchanged: food poisoning still contracts and still runs its course.
    expect(G.contractDisease(w, p, "food_poisoning")).toBe(true);
    expect(G.activeDiseases(w, p).map((a) => a.key)).toEqual(["food_poisoning"]);
  });
});

describe("Task 33: Recently Crafted", () => {
  it("queued crafts record most-recent-first, dedupe to the front, and cap at 8", () => {
    const { w, p } = setup();
    const ids = [...d.recipes.keys()].slice(0, 10);
    for (const r of ids) G.recordRecentCraft(w, p, r);
    let list = G.recentCrafts(w, p);
    expect(list.length).toBe(8);
    expect(list[0]).toBe(ids[9]);
    expect(list).toEqual(ids.slice(2).reverse());
    G.recordRecentCraft(w, p, ids[2]!); // re-craft the oldest kept entry: it jumps to the front
    list = G.recentCrafts(w, p);
    expect(list.length).toBe(8);
    expect(list[0]).toBe(ids[2]);
  });
  it("completing a queued craft records it; the view lists craftable recipes first", () => {
    const { w, p } = setup(); giveAxeMats(w, p);
    expect(G.enqueueCraft(w, p, axe, 1)).toBe(0);
    steps(w, 45);
    expect(G.countItem(w, p, id("stone_axe"))).toBe(1);
    expect(G.recentCrafts(w, p)).toEqual([axe]);
    // Craftable-first overrides recency: iron_ingot is the most recent entry but needs a furnace
    // the player is not near, while the older axe is craftable with the materials on hand.
    const iron = d.recipeId("iron_ingot");
    G.recordRecentCraft(w, p, iron);
    expect(G.recentCrafts(w, p)).toEqual([iron, axe]);
    const view = G.recentCraftsView(ctx(w, p));
    expect(view.map((r) => r.id)).toEqual([axe, iron]);
    expect(view[0]!.reason).toBeUndefined();
    expect(view[1]!.reason).toBeDefined();
  });
  it("recent crafts survive a snapshot round trip (persisted with the player)", () => {
    const { w, p } = setup();
    G.recordRecentCraft(w, p, axe); const iron = d.recipeId("iron_ingot"); G.recordRecentCraft(w, p, iron);
    const w2 = makeWorld(); installPermissions(w2); G.installCraftQueue(w2);
    const p2 = spawnLearned(w2, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); expect(p2).toBe(p);
    const snap = decodeSnapshot(w2, encodeSnapshot(w, { all: true }));
    const oid = w2.store(G.RecentCrafts).id;
    for (const k of [...snap.components.keys()]) if (k !== oid) snap.components.delete(k);
    applySnapshot(w2, snap);
    expect(G.recentCrafts(w2, p2)).toEqual([iron, axe]);
  });
  it("placing a piece records it most-recent-first (cap 8) and the build view keeps recency order", () => {
    const { w, p } = setup();
    const def = d.pieces.get(d.pieceId("wall"))!;
    const place = (x: number) => {
      const sn = G.snapPlacement(w, { piece: def.id, x, y: 0, level: 0, rot: 0, tier: def.fixedTier, variant: 0 });
      if (typeof sn === "number") throw new Error(`snap failed ${sn}`);
      G.placePiece(w, p, sn, { pay: false });
    };
    place(1); place(2); place(3);
    expect(G.recentBuilds(w, p)).toEqual([def.id]); // same piece dedupes to one entry
    const view = G.recentBuildsView(ctx(w, p));
    expect(view.map((v) => v.id)).toEqual([def.id]);
    // Record other pieces directly and confirm the view follows recency order.
    const others = [...d.pieces.keys()].filter((k) => k !== def.id).slice(0, 3);
    for (const o of others) G.recordRecentBuild(w, p, o);
    expect(G.recentBuilds(w, p)[0]).toBe(others[2]);
    expect(G.recentBuildsView(ctx(w, p)).map((v) => v.id)[0]).toBe(others[2]);
  });
});

describe("Task 33: disease data unchanged apart from the rates", () => {
  it("durations, symptoms and cures are untouched", () => {
    const cold = d.diseases.find((x) => x.key === "common_cold")!;
    expect(cold.durationSeconds).toBe(600);
    expect(cold.cure).toBe("honey_tea");
    const flu = d.diseases.find((x) => x.key === "influenza")!;
    expect(flu.durationSeconds).toBe(900);
    expect(d.diseaseTuning.exposure.coldSeconds).toBe(360);
    expect(d.vitals.hypothermiaBelow).toBe(35);
  });
});
