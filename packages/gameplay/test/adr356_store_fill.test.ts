/**
 * ADR-356: store fill mirror — gameplay.storeFill copies each store's Container fill into the networked
 * StoreFill component (0 empty, 1 half, 2 full) so every peer draws the matching building state. The system
 * runs postSim (authority-only); the client never recomputes it from the viewers-scoped Container.
 */
import { describe, expect, it } from "vitest";
import { Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { DT, ensureClaim, makeWorld, steps } from "./helpers.js";

const d = G.defaultDefs();
const item = (k: string) => d.itemId(k);
const piece = (k: string) => d.pieces.get(d.pieceId(k))!;
const STORES = ["ore_store", "log_store", "stick_store", "crop_store", "stone_store"] as const;
// One item per family, so filling N slots means N distinct stacks (stacks merge within a slot).
const FILL_ITEM: Record<string, string> = {
  ore_store: "copper_ore", log_store: "wood", stick_store: "sticks", crop_store: "wheat", stone_store: "stone",
};
const OTHER_ITEM: Record<string, string> = {
  ore_store: "tin_ore", log_store: "hardwood", stick_store: "sticks", crop_store: "lettuce", stone_store: "clay",
};

function fresh(): { w: World; p: Entity } {
  const w = makeWorld(); const p = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); steps(w, 1);
  ensureClaim(w, p, 3, 1); w.set(p, Transform, { x: 3.5, y: 1.5 }); return { w, p };
}
const give = (w: World, e: Entity, key: string, n = 1): void => { for (const c of G.pieceCost(d, piece(key), 1)) G.addItem(w, e, c.item, c.count * n); };
const place = (w: World, e: Entity, key: string, x: number, y: number): Entity => {
  give(w, e, key); const def = piece(key);
  const r = G.tryPlace(w, e, { piece: d.pieceId(key), x, y, level: 0, rot: 0, tier: def.fixedTier, variant: 0 });
  expect(r.ok, `${key} places`).toBe(true); return (r as { piece: Entity }).piece;
};
/** Storage attachment of a placed piece. */
const boxOf = (w: World, p: Entity): Entity => G.resolveAttachment(w, p, G.AttachKind.Storage)!;
/** Fill `n` slots of the store directly (two alternating kinds — addItem would merge same-kind stacks into one slot). */
const fillSlots = (w: World, p: Entity, key: string, n: number): void => {
  const box = boxOf(w, p);
  const items = w.getArray(box, G.Container, "items")!;
  const counts = w.getArray(box, G.Container, "counts")!;
  const ids = [FILL_ITEM[key]!, OTHER_ITEM[key]!];
  for (let i = 0; i < n; i++) { items[i] = item(ids[i % 2]!); counts[i] = 1; }
};
/** Empty every slot of the store directly. */
const drainSlots = (w: World, p: Entity): void => {
  const box = boxOf(w, p);
  const items = w.getArray(box, G.Container, "items")!;
  const counts = w.getArray(box, G.Container, "counts")!;
  for (let i = 0; i < items.length; i++) { items[i] = 0; counts[i] = 0; }
};
const levelOf = (w: World, p: Entity): number | undefined => w.has(p, G.StoreFill) ? w.getField(p, G.StoreFill, "level") : undefined;

describe("ADR-356 store fill", () => {
  it("storeFillLevel buckets: 0 empty, 1 half (1–5 of 12), 2 full (6–12 of 12)", () => {
    expect(G.storeFillLevel(0, 12)).toBe(0);
    expect(G.storeFillLevel(1, 12)).toBe(1);
    expect(G.storeFillLevel(5, 12)).toBe(1);
    expect(G.storeFillLevel(6, 12)).toBe(2);
    expect(G.storeFillLevel(12, 12)).toBe(2);
    expect(G.storeFillLevel(0, 0)).toBe(0);
    expect(G.STORE_FILL_STATE_NAMES).toEqual(["empty", "half", "full"]);
    expect(G.STORE_PIECE_KEYS).toEqual(["ore_store", "log_store", "stick_store", "crop_store", "stone_store"]);
  });

  it("an empty store mirrors level 0, a stocked store 1, a mostly-full store 2 — and back down on emptying", () => {
    const { w, p } = fresh();
    // ADR-355 layout: all spots within buildReach 4 of the player at (3.5, 1.5).
    const spots: Record<string, [number, number]> = {
      ore_store: [1.5, 0.5], log_store: [1.5, 2.5], stick_store: [3.5, 0.5], crop_store: [3.5, 2.5], stone_store: [5.5, 0.5],
    };
    for (const key of STORES) {
      const [x, y] = spots[key]!;
      const s = place(w, p, key, x, y);
      steps(w, 25); // past one STORE_FILL_EVERY cadence
      expect(levelOf(w, s), `${key} empty`).toBe(0);
      fillSlots(w, s, key, 1);
      steps(w, 25); expect(levelOf(w, s), `${key} 1 slot`).toBe(1);
      fillSlots(w, s, key, 6); // 6 slots total
      steps(w, 25); expect(levelOf(w, s), `${key} 6 slots`).toBe(2);
      // Empty it again: withdrawing everything drops the level back to 0.
      drainSlots(w, s);
      steps(w, 25); expect(levelOf(w, s), `${key} emptied`).toBe(0);
    }
  });

  it("a generic container never gets StoreFill, and syncStoreFill reports changes only on a diff", () => {
    const { w, p } = fresh();
    const box = place(w, p, "basic_storage_box", 5.5, 2.5);
    steps(w, 25);
    expect(w.has(box, G.StoreFill)).toBe(false);
    const store = place(w, p, "ore_store", 1.5, 0.5);
    expect(G.syncStoreFill(w, store)).toBe(true); // first add
    expect(G.syncStoreFill(w, store)).toBe(false); // no change
    expect(levelOf(w, store)).toBe(0);
    fillSlots(w, store, "ore_store", 2);
    expect(G.syncStoreFill(w, store)).toBe(true);
    expect(levelOf(w, store)).toBe(1);
    expect(G.syncStoreFill(w, store)).toBe(false);
  });

  it("the fill system is postSim and in the pinned system order", () => {
    expect(G.GAMEPLAY_SYSTEM_ORDER).toContainEqual(["postSim", "gameplay.storeFill", G.STORE_FILL_EVERY]);
    const w = makeWorld();
    expect(w.systemOrder().filter((s) => s.name === "gameplay.storeFill").map((s) => [s.phase, s.name])).toEqual([["postSim", "gameplay.storeFill"]]);
  });

  it("StoreFill replicates scope all (every peer sees the fill)", () => {
    expect(G.replicationOf(G.StoreFill)).toMatchObject({ scope: "all" });
  });
});
