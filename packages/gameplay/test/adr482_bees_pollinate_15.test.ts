/**
 * ADR-482: bees pollinate 15 tiles — ADR-454 shipped radius 5; this ADR raises it to 15
 * (farming.json `pollination.radius`). The check is still a Euclidean circle over the cached
 * apiary list (apiaryWithin), checked once at harvest, +1 on the first yield only, planted
 * crops only, no stacking. Honey-deposit range deliberately stays 10 (farming/skills data
 * unchanged) — the fiction gap (bees pollinate further than they carry honey) is recorded
 * in the DECISIONS entry, not resolved here.
 *
 * Boundary discipline mirrors ADR-454: every case builds the same entities in the same order
 * (player, claim, two apiaries, one crop node) and only moves the apiaries, so the gather RNG
 * stream is identical and the base roll is the same in every world. The crop node sits at
 * (1, 0), so an apiary at (16, 0) is exactly 15 tiles away (in range) and (17, 0) is 16
 * (out of range); diagonally (11, 11) is sqrt(10^2 + 11^2) = 14.87 (in) and (12, 11) is
 * sqrt(11^2 + 11^2) = 15.56 (out) — proving circle, not square.
 */
import { describe, expect, it } from "vitest";
import { Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned, steps, ensureClaim } from "./helpers.js";

const d = G.defaultDefs();
const iid = (k: string) => d.itemId(k);
const pid = (k: string) => d.pieceId(k);
const WHEAT = iid("wheat");

function fresh(): { w: World; p: Entity } {
  const w = makeWorld();
  const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
  steps(w, 1);
  ensureClaim(w, p, 0, 0);
  return { w, p };
}

const give = (w: World, e: Entity, key: string): void => {
  const def = d.pieces.get(pid(key))!;
  for (const c of G.pieceCost(d, def, def.tiered ? 0 : def.fixedTier)) G.addItem(w, e, c.item, c.count);
};
const put = (w: World, e: Entity, key: string, x: number, y: number): void => {
  const def = d.pieces.get(pid(key))!;
  const t = def.tiered ? 0 : def.fixedTier;
  give(w, e, key);
  w.set(e, Transform, { x, y: y + 1.2 });
  const r = G.tryPlace(w, e, { piece: pid(key), x, y, level: 0, rot: 0, tier: t, variant: 0 });
  expect(r.ok).toBe(true);
};

/** Harvest one planted/wild crop_wheat node with two apiaries placed at the given spots. Returns wheat gained. */
function harvest(apiarySpots: readonly { x: number; y: number }[], grown: boolean): number {
  const { w, p } = fresh();
  for (const s of apiarySpots) put(w, p, "apiary", s.x, s.y);
  w.set(p, Transform, { x: 0, y: 0 });
  const node = G.spawnResourceNode(w, "crop_wheat", 1, 0);
  if (grown) w.add(node, G.GrownPlant, { kind: 1, waterUntilTick: 0, fertilizerUntilTick: 0 });
  G.setIntent(w, p, { action: G.IntentAction.Gather, target: node });
  w.step(1 / 20);
  steps(w, 30);
  return G.countItem(w, p, WHEAT);
}

describe("ADR-482 bees pollinate 15 tiles", () => {
  it("apiary at exactly 15 tiles (axis) still gives +1", () => {
    const base = harvest([{ x: 20, y: 0 }, { x: 25, y: 0 }], true);
    const edge = harvest([{ x: 16, y: 0 }, { x: 25, y: 0 }], true);
    expect(base).toBeGreaterThanOrEqual(2);
    expect(edge).toBe(base + 1);
  });

  it("apiary at 16 tiles (axis) gives no bonus", () => {
    const base = harvest([{ x: 20, y: 0 }, { x: 25, y: 0 }], true);
    const far = harvest([{ x: 17, y: 0 }, { x: 25, y: 0 }], true);
    expect(far).toBe(base);
  });

  it("diagonal inside the circle (10, 11) gives +1; outside it (11, 11) gives nothing", () => {
    const base = harvest([{ x: 20, y: 0 }, { x: 25, y: 0 }], true);
    const inside = harvest([{ x: 11, y: 11 }, { x: 25, y: 0 }], true);
    const outside = harvest([{ x: 12, y: 11 }, { x: 25, y: 0 }], true);
    expect(inside).toBe(base + 1);
    expect(outside).toBe(base);
  });

  it("two apiaries at 11-15 tiles still give only +1 (no stacking at the new range)", () => {
    const base = harvest([{ x: 20, y: 0 }, { x: 25, y: 0 }], true);
    const two = harvest([{ x: 13, y: 0 }, { x: 14, y: 0 }], true);
    expect(two).toBe(base + 1);
  });

  it("wild node (no GrownPlant) at 4 tiles still gives no bonus", () => {
    const base = harvest([{ x: 20, y: 0 }, { x: 25, y: 0 }], true);
    const wild = harvest([{ x: 4, y: 0 }, { x: 25, y: 0 }], false);
    expect(wild).toBe(base);
  });

  it("apiaryWithin unit boundary at radius 15", () => {
    const { w, p } = fresh();
    put(w, p, "apiary", 15, 0);
    expect(G.apiaryWithin(w, 0, 0, 15)).toBe(true);
    expect(G.apiaryWithin(w, 0, 0, 14)).toBe(false);
  });
});
