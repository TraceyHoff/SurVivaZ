/**
 * ADR-454: bees pollinate — a planted crop (matured into a crop_* node with GrownPlant) harvested within
 * 15 tiles of an Apiary yields +1 on the first yield only. No stacking across apiaries; wild nodes get
 * nothing; an Apiary out of range gets nothing. ADR-482 raised the radius from 5 to 15 (farming.json);
 * the out-of-range case below was re-based from 10 tiles to 16 tiles accordingly.
 *
 * Determinism: every case builds the same entities in the same order (player, claim, two apiaries, one
 * crop node) and only moves the apiaries, so the gather RNG stream is identical and the base roll is
 * the same in every world — the Apiary worlds must read exactly base + 1.
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

describe("ADR-454 bees pollinate", () => {
  it("planted crop near an Apiary yields exactly +1 on the first yield", () => {
    const base = harvest([{ x: 20, y: 0 }, { x: 25, y: 0 }], true);
    const near = harvest([{ x: 4, y: 0 }, { x: 25, y: 0 }], true);
    expect(base).toBeGreaterThanOrEqual(2);
    expect(near).toBe(base + 1);
  });

  it("Apiary out of range (16 tiles) gives no bonus", () => {
    const base = harvest([{ x: 20, y: 0 }, { x: 25, y: 0 }], true);
    const far = harvest([{ x: 17, y: 0 }, { x: 25, y: 0 }], true);
    expect(far).toBe(base);
  });

  it("wild node (no GrownPlant) near an Apiary gives no bonus", () => {
    const base = harvest([{ x: 20, y: 0 }, { x: 25, y: 0 }], true);
    const wild = harvest([{ x: 4, y: 0 }, { x: 25, y: 0 }], false);
    expect(wild).toBe(base);
  });

  it("two Apiaries in range still give only +1 (no stacking)", () => {
    const base = harvest([{ x: 20, y: 0 }, { x: 25, y: 0 }], true);
    const two = harvest([{ x: 4, y: 0 }, { x: 5, y: 0 }], true);
    expect(two).toBe(base + 1);
  });

  it("apiaryWithin reads the cached station list (unit)", () => {
    const { w, p } = fresh();
    put(w, p, "apiary", 4, 0);
    expect(G.apiaryWithin(w, 0, 0, 5)).toBe(true);
    expect(G.apiaryWithin(w, 0, 0, 3)).toBe(false);
  });
});
