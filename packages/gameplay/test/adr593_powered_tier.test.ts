/**
 * ADR-593 powered building tier: tier 5 "powered" for walls / floors / foundations / pillars only; a powered piece
 * is an always-in-use consumer that lights and heats its spot while the grid powers it; upgrades into the tier gain
 * the grid state; the AI never upgrades into it; the build menu offers it only on its pieces.
 */
import { describe, expect, it } from "vitest";
import { type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
const PT = G.poweredTierIndex(d.tiers);
function put(w: World, key: string, x: number, y: number, tier: number): Entity {
  const def = d.pieces.get(d.pieceId(key))!;
  const sn = G.snapPlacement(w, { piece: def.id, x, y, level: 0, rot: 0, tier, variant: 0 });
  if (typeof sn === "number") throw new Error(`${key} snap ${sn}`);
  return G.placePiece(w, 0, sn, { pay: false, tribe: 4 });
}
const emitter = (w: World, p: Entity, kind: number): number | undefined => {
  const a = G.attachmentsOf(w, p).find((x) => w.getField(x, G.PieceLink, "kind") === kind); return a === undefined ? undefined : w.getField(a, G.Emitter, "strength");
};

describe("ADR-593 powered building tier", () => {
  it("is tier 5, gated by its own skill node, after reinforced", () => {
    expect(PT).toBe(5); expect(d.tiers[PT]!.key).toBe("powered"); expect(d.tiers[PT]!.hpMul).toBeGreaterThanOrEqual(d.tiers[4]!.hpMul);
    expect(G.UNLOCK_NODE.has("tier:powered")).toBe(true);
  });
  it("only walls / floors / foundations / pillars take it", () => {
    const w = makeWorld(); steps(w, 1);
    const other = [...d.pieces.values()].find((p) => p.tiered && !G.poweredTierAllowed(p.key))!;
    expect(G.snapPlacement(w, { piece: other.id, x: 5, y: 5, level: 0, rot: 0, tier: PT, variant: 0 })).toBe(G.BuildFail.BadTier);
    for (const k of G.POWER.poweredTier.pieces) expect(d.pieces.get(d.pieceId(k))?.tiered, k).toBe(true);
  });
  it("a powered foundation lights and warms its spot only while the grid powers it", () => {
    const w = makeWorld(); steps(w, 1);
    const f = put(w, "foundation", 10.5, 10.5, PT);
    expect(w.has(f, G.Power)).toBe(true); expect(emitter(w, f, G.AttachKind.Light)).toBe(0); expect(emitter(w, f, G.AttachKind.Heat)).toBe(0);
    steps(w, G.POWER.everyTicks); expect(w.getField(f, G.Power, "powered")).toBe(0);
    const gen = put(w, "generator_fuel", 13.5, 10.5, 3); G.addItem(w, G.resolveAttachment(w, gen, G.AttachKind.Storage)!, d.itemId("lamp_oil"), 2);
    steps(w, G.POWER.everyTicks);
    expect(w.getField(f, G.Power, "active")).toBe(1); expect(emitter(w, f, G.AttachKind.Light)).toBe(1); expect(emitter(w, f, G.AttachKind.Heat)).toBe(G.POWER.poweredTier.heat);
  });
  it("a reinforced foundation upgraded to powered gains its grid state and emitters", () => {
    const w = makeWorld(); steps(w, 1);
    const f = put(w, "foundation", 10.5, 10.5, 4); expect(w.has(f, G.Power)).toBe(false);
    w.setField(f, G.BuildPiece, "tier", PT); G.grantPoweredTier(w, f);
    expect(w.has(f, G.Power)).toBe(true); expect(emitter(w, f, G.AttachKind.Heat)).toBe(0);
    G.grantPoweredTier(w, f); expect(G.attachmentsOf(w, f).filter((a) => w.getField(a, G.PieceLink, "kind") === G.AttachKind.Heat).length).toBe(1); // idempotent
  });
  it("the build menu offers the powered tier on its pieces only", () => {
    const w = makeWorld(); steps(w, 1); const p = spawnLearned(w, { x: 0, y: 0 });
    const v = G.buildView({ world: w, player: p } as G.MenuCtx);
    const tiersOf = (k: string) => v.find((x) => x.key === k)!.tiers.map((t) => t.tier);
    expect(tiersOf("foundation")).toContain(PT);
    const other = v.find((x) => x.tiers.length > 1 && !G.poweredTierAllowed(x.key))!; expect(tiersOf(other.key)).not.toContain(PT);
  });
});
