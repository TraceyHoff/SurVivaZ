/**
 * ADR-368: sim hot paths — behavior-preserving perf work.
 * - inSpawnSafeRadius merges the safe-centre lists at most once per tick (provider calls counted);
 * - findPath records the first blocking piece during A* instead of re-scanning the path;
 * - expressionSystem reuses one entity array and getField reads (moods / emotes unchanged);
 * - spoilageSystem skips the per-item work for holders with no spoilable food (their spoilMul
 *   still re-bases with temperature — the Task 28 contract — and spoilable food still decays);
 * - cropGrowthSystem hoists the per-pass globals and writes growth via setField;
 * - husbandrySystem computes each animal's trough / apiary / owner lookups once per pass;
 * - respawnSystem scans nodes / regrow markers without per-tick spreads.
 */
import { describe, expect, it } from "vitest";
import { PlayerId, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, ensureClaim, spawnLearned, steps } from "./helpers.js";
import { room, world215 } from "./nav215_fixture.js";

const d = G.defaultDefs();
const iid = (k: string) => d.itemId(k);

describe("ADR-368 spawn safe radius: merged once per tick", () => {
  it("a live provider is evaluated at most once per tick; a mid-tick registration applies at once", () => {
    const w = makeWorld(); G.setSpawnPoints(w, [{ x: 0, y: 0 }]);
    let calls = 0;
    G.addSafeSpawnCentreProvider(w, "test-beds", () => { calls++; return [{ x: 50, y: 50 }]; });
    expect(G.inSpawnSafeRadius(w, 50, 50)).toBe(true);
    expect(G.inSpawnSafeRadius(w, 50, 50)).toBe(true);
    expect(G.inSpawnSafeRadius(w, 50, 50)).toBe(true);
    expect(calls).toBe(1);
    expect(G.inSpawnSafeRadius(w, 0, 0)).toBe(true); // installed point still works
    expect(G.inSpawnSafeRadius(w, 500, 500)).toBe(false);
    steps(w, 1);
    expect(G.inSpawnSafeRadius(w, 50, 50)).toBe(true);
    expect(calls).toBe(2); // re-evaluated on the next tick
  });
  it("temporary centres expire", () => {
    const w = makeWorld(); G.setSpawnPoints(w, [{ x: 0, y: 0 }]);
    G.addTemporarySafeSpawnPoint(w, { x: 80, y: 80 }, 1); // 1 s = 20 ticks
    expect(G.inSpawnSafeRadius(w, 80, 80)).toBe(true);
    steps(w, 25);
    expect(G.inSpawnSafeRadius(w, 80, 80)).toBe(false);
  });
  it("extraSafeSpawnPoints returns the same centres across calls in a tick", () => {
    const w = makeWorld();
    G.setExtraSafeSpawnPoints(w, [{ x: 10, y: 10 }, { x: -10, y: -10 }]);
    expect(G.extraSafeSpawnPoints(w)).toEqual([{ x: 10, y: 10 }, { x: -10, y: -10 }]);
    expect(G.extraSafeSpawnPoints(w)).toEqual([{ x: 10, y: 10 }, { x: -10, y: -10 }]);
  });
});

describe("ADR-368 findPath: blocker recorded during A*", () => {
  it("open ground: straight tiles, no blocker, deterministic across calls", () => {
    const w = makeWorld();
    const a = G.findPath(w, 0, 0, 3, 0, () => 0);
    expect(a).toBeDefined();
    expect(a!.tiles).toEqual([[0, 0], [1, 0], [2, 0], [3, 0]]);
    expect(a!.blocker).toBe(0); expect(a!.blockerIndex).toBe(-1);
    expect(a!.cost).toBe(3);
    expect(G.findPath(w, 0, 0, 3, 0, () => 0)).toEqual(a);
  });
  it("a walled room: the recorded blocker is the wall the path crosses", () => {
    const { w, put } = world215(); room(w, put, 0, 0, 4, { door: true });
    const p = G.findPath(w, 2, 6, 2, 2, () => 0);
    expect(p).toBeDefined();
    expect(p!.tiles).toEqual([[2, 6], [2, 5], [2, 4], [2, 3], [2, 2]]);
    expect(p!.blocker).not.toBe(0);
    expect(p!.blockerIndex).toBeGreaterThan(0); expect(p!.blockerIndex).toBeLessThan(p!.tiles.length);
    expect(w.has(p!.blocker, G.BuildPiece)).toBe(true);
    // the recorded blocker is exactly the piece stepBlocker reports for that step
    const i = p!.blockerIndex;
    expect(G.stepBlocker(w.getResource(G.StructureIndexRes), p!.tiles[i - 1]![0], p!.tiles[i - 1]![1], p!.tiles[i]![0], p!.tiles[i]![1])).toBe(p!.blocker);
    expect(p!.cost).toBe(p!.tiles.length - 1); // breakTicks 0: every step costs 1
    expect(G.findPath(w, 2, 6, 2, 2, () => 0)).toEqual(p);
  });
});

describe("ADR-368 expression: cached lookups, same moods and emotes", () => {
  it("emote / expression ids resolve from the cached tables", () => {
    expect(G.expressionId("happy")).toBeGreaterThan(0);
    expect(G.expressionKey(G.expressionId("happy"))).toBe("happy");
    expect(G.expressionId("no_such_expression")).toBe(0);
    expect(G.emoteId("wave")).toBeGreaterThan(0);
    expect(G.emoteNames()).toContain("wave");
  });
  it("a held mood expression is not rewritten by repeated runs", () => {
    const w = makeWorld(); const p = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
    steps(w, 6); expect(w.has(p, G.Expression)).toBe(false);
    w.set(p, G.Health, { hp: 10 }); steps(w, 6);
    expect(G.expressionKey(w.get(p, G.Expression)!.id)).toBe("hurt");
    const until = w.get(p, G.Expression)!.untilTick;
    G.expressionSystem(w); G.expressionSystem(w);
    expect(w.get(p, G.Expression)!.untilTick).toBe(until);
    G.requestEmote(w, p, "wave"); steps(w, 6);
    expect(G.expressionKey(w.get(p, G.Expression)!.id)).toBe("happy");
  });
});

describe("ADR-368 spoilage: holders without spoilable food are skipped", () => {
  it("a pack with only non-spoilable items still re-bases spoilMul with temperature; spoilable food still decays", () => {
    const w = makeWorld(); const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); steps(w, 1);
    G.addItem(w, p, iid("wood"), 5);
    expect(w.getField(p, G.Inventory, "spoilMul")).toBe(1);
    steps(w, 60); // 3 spoilage passes
    // the holder's spoilMul still tracks temperature even with no spoilable food (Task 28:
    // a salt barrel holding only salt reads 0.5x); only the per-item decay work is skipped.
    // makeWorld's day is warm, so the temperature multiplier is above 1.
    expect(w.getField(p, G.Inventory, "spoilMul")).toBeGreaterThan(1);
    G.addItem(w, p, iid("fish"), 3);
    const slot = (() => { const v = G.readSlots(w, p); for (let i = 0; i < v.slotCount; i++) if (v.item(i) === iid("fish")) return i; throw new Error("no fish slot"); })();
    expect(G.slotFreshness(w, p, slot)).toBe(1);
    steps(w, 1200); // 60 s: fish (600 s spoil) decays to ~0.9
    const f = G.slotFreshness(w, p, slot);
    expect(f).toBeLessThan(0.99); expect(f).toBeGreaterThan(0.8);
  });
});

describe("ADR-368 crops: hoisted pass globals, setField growth", () => {
  const cropAt = (w: World, x: number, y: number, seed: string): Entity => {
    const c = w.create();
    w.add(c, Transform, { x, y }).add(c, G.Crop, { kind: G.plantableBySeed(seed), stage: 0, growth: 0, waterUntilTick: 0, fertilized: 0 });
    G.indexEntity(w, c); return c;
  };
  it("a watered crop still grows at the watered rate; an unwatered one does not", () => {
    const w = makeWorld(); const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); steps(w, 1);
    const wet = cropAt(w, 2.5, 2.5, "wheat_seeds");
    const dry = cropAt(w, 5.5, 5.5, "wheat_seeds");
    G.water(w, 2.5, 2.5);
    const mul = G.growthMul(w, w.get(wet, G.Crop)!);
    expect(mul).toBeGreaterThan(0);
    G.cropGrowthSystem(w);
    expect(w.get(wet, G.Crop)!.growth).toBeCloseTo(mul / 540, 6); // 1 s of growth at the 540 s wheat rate
    expect(w.get(dry, G.Crop)!.growth).toBe(0);
  });
  it("a crop at full growth still matures into its node", () => {
    const w = makeWorld(); const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); steps(w, 1);
    const crop = cropAt(w, 2.5, 2.5, "wheat_seeds");
    G.water(w, 2.5, 2.5);
    w.set(crop, G.Crop, { growth: 1 });
    G.cropGrowthSystem(w);
    expect(w.isAlive(crop)).toBe(false);
    expect([...w.query([G.ResourceNode])].some((e) => d.resources.get(w.get(e, G.ResourceNode)!.kind)?.key === "crop_wheat")).toBe(true);
  });
});

describe("ADR-368 husbandry: one station lookup per animal per pass", () => {
  const setPid = (w: World, e: Entity, id: number): void => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); };
  const BASE = { x: 10, y: 10 };
  const STAND = { x: BASE.x + G.BUILD_STAND.x, y: BASE.y + G.BUILD_STAND.y };
  const pid = (k: string) => d.pieceId(k);
  const fresh = (): { w: World; p: Entity } => {
    const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
    const p = spawnLearned(w, { x: BASE.x + 1, y: BASE.y + 3.3, maxWeight: 0, clientId: 1 }); setPid(w, p, 7);
    steps(w, 1); ensureClaim(w, p, BASE.x + 4, BASE.y + 4); return { w, p };
  };
  const give = (w: World, e: Entity, key: string, tier = 0): void => { const def = d.pieces.get(pid(key))!; for (const c of G.pieceCost(d, def, def.tiered ? tier : def.fixedTier)) G.addItem(w, e, c.item, c.count); };
  const put = (w: World, e: Entity, key: string, x: number, y: number, level = 0, rot = 0, tier?: number, stand?: { x: number; y: number }) => {
    ensureClaim(w, e, x - 2, y + 2);
    const def = d.pieces.get(pid(key))!; const t = tier ?? (def.tiered ? 0 : def.fixedTier); give(w, e, key, t);
    w.set(e, Transform, stand ?? { x, y: y + 1.2 });
    return G.tryPlace(w, e, { piece: pid(key), x, y, level, rot, tier: t, variant: 0 });
  };
  /** Grant the player Husbandry 2 ("pens") so trough production is not gated by canUsePens (ADR-234 pattern). */
  const pens = (w: World, p: Entity): void => {
    for (const k of G.TREE_KEYS) G.grantTreePoints(w, p, k, 5000 - G.treePoints(w, p, k));
    const unlock = (i: number): void => { for (const r of G.SKILL_REQS[i]!) unlock(r); const why = G.unlockSkill(w, p, i); if (why) throw new Error(`unlock ${G.SKILLS.nodes[i]!.key}: ${why}`); };
    unlock(G.SKILLS.nodes.findIndex((n) => n.key === "husbandry_pens"));
  };
  it("a fed cow at a real placed trough still produces milk into it", () => {
    const { w, p } = fresh(); pens(w, p);
    const r = put(w, p, "feeding_trough", BASE.x + 1.5, BASE.y + 0.5, 0, 0, undefined, STAND);
    expect(r.ok).toBe(true);
    const trough = G.resolveAttachment(w, (r as { piece: Entity }).piece, G.AttachKind.Storage)!;
    const a = G.spawnAnimal(w, "animal_cow", BASE.x + 3, BASE.y + 0.5);
    const kind = w.get(a, G.Animal)!.kind;
    w.add(a, G.Tamed, { kind, owner: p, fedUntil: w.tick + 100000, produceAt: 0, breedAt: w.tick + 100000 });
    G.husbandrySystem(w);
    expect(G.countItem(w, trough, iid("milk"))).toBeGreaterThanOrEqual(1);
  });
});

describe("ADR-368 respawn: legacy nodes and regrow markers without per-tick spreads", () => {
  it("an amount-0 node becomes a regrow marker, then regrows", () => {
    const w = makeWorld();
    const n = G.spawnResourceNode(w, "tree", 5.5, 5.5);
    w.setField(n, G.ResourceNode, "respawnAtTick", w.tick + 100000); // marker must not be due at once
    w.setField(n, G.ResourceNode, "amount", 0);
    steps(w, 2);
    expect(w.isAlive(n)).toBe(false);
    const marker = [...w.query([G.NodeRegrow])][0];
    expect(marker).toBeDefined();
    expect(w.get(marker!, G.NodeRegrow)!.kind).toBe(d.resourceId("tree"));
    w.setField(marker!, G.NodeRegrow, "respawnAtTick", w.tick);
    steps(w, 2);
    expect(w.isAlive(marker!)).toBe(false);
    expect([...w.query([G.ResourceNode])].filter((e) => w.get(e, G.ResourceNode)!.kind === d.resourceId("tree")).length).toBe(1);
  });
  it("live nodes are untouched by the per-tick scan", () => {
    const w = makeWorld();
    const nodes = Array.from({ length: 30 }, (_, i) => G.spawnResourceNode(w, "tree", 5.5 + (i % 6), 5.5 + Math.floor(i / 6)));
    steps(w, 3);
    expect(nodes.every((n) => w.isAlive(n))).toBe(true);
    expect(nodes.every((n) => (w.get(n, G.ResourceNode)?.amount ?? 0) > 0)).toBe(true);
  });
});
