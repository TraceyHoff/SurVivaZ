/** ADR-515: a demolish refund that does not fit the pack drops in a loot bag at the actor's feet (it used to vanish). */
import { describe, expect, it } from "vitest";
import { installPermissions, Membership, PlayerId, Transform } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
describe("ADR-515 demolish refund with a full pack", () => {
  it("the part that does not fit lands in a Dropped bag owned by the demolisher", () => {
    const w = makeWorld(); installPermissions(w); G.installEconomy(w);
    const A = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); w.add(A, PlayerId, { id: 1 }).add(A, Membership, { partyId: 0, clanId: 0 });
    const sn = G.snapPlacement(w, { piece: d.pieceId("claim_totem"), x: 0.5, y: 3.5, level: 0, rot: 0, tier: 1, variant: 0 }); if (typeof sn === "number") throw new Error("snap");
    G.placePiece(w, A, sn, { pay: false });
    const fs = G.snapPlacement(w, { piece: d.pieceId("foundation"), x: 1, y: 1, level: 0, rot: 0, tier: 1, variant: 0 }); if (typeof fs === "number") throw new Error("snap");
    const f = G.placePiece(w, A, fs, { pay: false });
    const cost = G.pieceCost(d, d.pieces.get(d.pieceId("foundation"))!, 1);
    // fill every slot with something the refund can't stack onto
    const filler = [...d.items.values()].find((it) => it.maxStack === 1 && !cost.some((c) => c.item === it.id))!.id;
    while (G.addItem(w, A, filler, 1) === 1) { /* fill */ }
    const bagsBefore = [...w.query([G.LootBag])].length;
    w.set(A, G.PlayerIntent, { action: G.IntentAction.Demolish, target: f }); steps(w, 1);
    expect(w.isAlive(f)).toBe(false);
    const bags = [...w.query([G.LootBag])]; expect(bags.length).toBe(bagsBefore + 1);
    const bag = bags[bags.length - 1]!;
    for (const c of cost) expect(G.countItem(w, A, c.item) + G.countItem(w, bag, c.item)).toBe(c.count);
    expect(w.getField(bag, G.LootBag, "owner")).toBe(1);
    const bt = w.get(bag, Transform)!, at = w.get(A, Transform)!; expect(Math.hypot(bt.x - at.x, bt.y - at.y)).toBeLessThan(0.01);
  });
  it("a pack with room gets everything and no bag is made", () => {
    const w = makeWorld(); const A = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
    expect(G.refundOrDrop(w, A, [{ item: d.itemId("wood"), count: 3 }])).toBeUndefined();
    expect(G.countItem(w, A, d.itemId("wood"))).toBe(3);
  });
});
