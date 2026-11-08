/**
 * Task 28: salt-preserved food storage — a tiered container family (salt barrel / curing box / cold store) whose
 * spoil multiplier only applies while the container holds salt (1 salt per 3 min while it holds spoilable food).
 * Without salt each behaves like ordinary storage.
 */
import { describe, expect, it } from "vitest";
import { Transform, type Entity, type World } from "@engine/core";
import ids from "../data/ids.lock.json";
import * as G from "../src/index.js";
import { SALT_CONSUME_TICKS, saltCount } from "../src/systems/spoilage.js";
import { resolveSprite } from "../src/sprite-fallback.js";
import { makeWorld, spawnLearned, steps, ensureClaim } from "./helpers.js";

const d = G.defaultDefs();
const item = (k: string) => d.itemId(k);
const piece = (k: string) => d.pieces.get(d.pieceId(k))!;

const placeSalt = (w: World, p: Entity, key: string, x: number, y: number): Entity => {
  ensureClaim(w, p, x - 3, y + 3);
  const def = piece(key);
  for (const c of G.pieceCost(d, def, def.fixedTier)) G.addItem(w, p, c.item, c.count);
  const r = G.tryPlace(w, p, { piece: def.id, x, y, level: 0, rot: 0, tier: def.fixedTier, variant: 0 });
  expect(r.ok, `${key} places`).toBe(true);
  return (r as { piece: Entity }).piece;
};
const storageOf = (w: World, p: Entity): Entity => G.resolveAttachment(w, p, G.AttachKind.Storage)!;
const spoilMulOf = (w: World, c: Entity): number => w.getField(c, G.Container, "spoilMul") ?? 1;

describe("Task 28: salt-preserved storage — data", () => {
  it("the three tiers exist with ascending ids, slots and preservation", () => {
    expect((ids.pieces as Record<string, number>)["salt_barrel"]).toBe(183);
    expect((ids.pieces as Record<string, number>)["curing_box"]).toBe(184);
    expect((ids.pieces as Record<string, number>)["cold_store"]).toBe(185);
    const t = [["salt_barrel", 12, 0.5, 1], ["curing_box", 16, 0.33, 2], ["cold_store", 24, 0.2, 3]] as const;
    for (const [key, slots, mul, tier] of t) {
      const def = piece(key);
      expect(def.container).toBe(slots); expect(def.spoilMul).toBe(mul); expect(def.saltFuel).toBe(true);
      expect(def.fixedTier).toBe(tier); expect(def.station).toBe(0); expect(def.fired).toBe(false);
    }
    // plain storage is not salt-fuelled: its spoilMul always applies
    expect(piece("basic_storage_box").saltFuel).toBe(false);
    expect(piece("barrel_storage").spoilMul).toBe(0.9);
  });
  it("salt is a real resource: salt flats near shore yield it with a pickaxe", () => {
    const res = d.resources.get(d.resourceId("salt_flat"))!;
    expect(res.requiredTool).toBe(G.ToolKind.Pickaxe); expect(res.minTier).toBe(1);
    expect(res.yields.some((y) => y.item === item("salt") && y.chance === 1)).toBe(true);
    expect(d.items.get(item("salt"))!.key).toBe("salt");
  });
  it("the new pieces resolve to real pack art through the text-only fallback chain", () => {
    // has() mirrors the pack: only storage_box / large_chest art exists; barrel_storage itself falls back.
    const has = (k: string) => ["storage_box", "large_chest"].includes(k);
    expect(resolveSprite("salt_barrel", has)?.key).toBe("storage_box");
    expect(resolveSprite("curing_box", has)?.key).toBe("storage_box");
    expect(resolveSprite("cold_store", has)?.key).toBe("large_chest");
  });
});

describe("Task 28: salt-preserved storage — spoilage", () => {
  it("a fuelled salt barrel preserves at 0.5x the plain-box rate; unfuelled it is ordinary storage", () => {
    const w = makeWorld(); const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); steps(w, 1);
    const barrel = placeSalt(w, p, "salt_barrel", 1.5, 0.5);
    const box = placeSalt(w, p, "basic_storage_box", 3.5, 0.5);
    const bs = storageOf(w, barrel), xs = storageOf(w, box);
    G.addItem(w, bs, item("salt"), 3); // fuelled
    steps(w, 60); // 3 spoilage passes: the multiplier re-bases
    const bm = spoilMulOf(w, bs), xm = spoilMulOf(w, xs);
    expect(bm).toBeGreaterThan(0); expect(bm).toBeLessThan(xm * 0.6); // 0.5x (same temperature both sides)
    expect(xm).toBeGreaterThan(0.9); // plain box: ~1x
    // salt runs out -> the barrel re-bases back to ordinary storage
    expect(G.removeItem(w, bs, item("salt"), 3)).toBe(true);
    steps(w, 60);
    expect(spoilMulOf(w, bs)).toBeGreaterThan(0.9);
  });
  it("higher tiers preserve more: curing box 0.33x, cold store 0.2x (fuelled, ratio to a plain box)", () => {
    const w = makeWorld(); const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); steps(w, 1);
    const curing = placeSalt(w, p, "curing_box", 1.5, 0.5);
    const cold = placeSalt(w, p, "cold_store", 3.5, 0.5);
    const box = placeSalt(w, p, "basic_storage_box", 1.5, 2.5);
    const cs = storageOf(w, curing), ls = storageOf(w, cold), xs = storageOf(w, box);
    G.addItem(w, cs, item("salt"), 2); G.addItem(w, ls, item("salt"), 2);
    steps(w, 60);
    const xm = spoilMulOf(w, xs); // same temperature for all three: ratios cancel the temp multiplier
    expect(spoilMulOf(w, cs) / xm).toBeGreaterThan(0.3); expect(spoilMulOf(w, cs) / xm).toBeLessThan(0.36);
    expect(spoilMulOf(w, ls) / xm).toBeGreaterThan(0.17); expect(spoilMulOf(w, ls) / xm).toBeLessThan(0.23);
  });
  it("salt burns 1 per 3 minutes only while the container holds spoilable food", () => {
    const w = makeWorld(); const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); steps(w, 1);
    const barrel = placeSalt(w, p, "salt_barrel", 1.5, 0.5);
    const bs = storageOf(w, barrel);
    G.addItem(w, bs, item("salt"), 2);
    steps(w, SALT_CONSUME_TICKS + 40); // no food: nothing burns
    expect(saltCount(w, bs)).toBe(2);
    G.addItem(w, bs, item("cooked_meat"), 5);
    steps(w, SALT_CONSUME_TICKS + 40); // food present: one salt burns
    expect(saltCount(w, bs)).toBe(1);
    steps(w, SALT_CONSUME_TICKS + 40); // and another
    expect(saltCount(w, bs)).toBe(0);
    // empty of salt: the barrel is ordinary storage again
    steps(w, 60);
    expect(spoilMulOf(w, bs)).toBeGreaterThan(0.9);
  });
  it("freshness decays at the container rate (unit check of the pinned numbers)", () => {
    // cooked_meat spoils in 2400 s; 600 s elapsed at 0.5x preserves 0.875, at 1x only 0.75.
    const f = (mul: number) => G.freshness(d, item("cooked_meat"), 0, mul, 600 * 20, 1 / 20);
    expect(f(0.5)).toBeGreaterThan(f(1));
    expect(f(0.5)).toBeCloseTo(0.875, 2); expect(f(1)).toBeCloseTo(0.75, 2);
    expect(f(0.2)).toBeCloseTo(0.95, 2);
  });
});
