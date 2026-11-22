/** ADR-516: demolishing a host piece refunds what comes down with it (door / window / hatch / wall insert) by the
 *  same own (100%) / other (50%) rule; unloaded rounds and a picked-up sign drop in a bag when the pack is full. */
import { describe, expect, it } from "vitest";
import { installPermissions, Membership, PlayerId, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs(); const id = (k: string) => d.itemId(k);
const cost = (key: string) => G.pieceCost(d, d.pieces.get(d.pieceId(key))!, 1);
const half = (key: string) => cost(key).map((c) => ({ item: c.item, count: Math.max(1, Math.floor(c.count * d.building.demolishRefund)) }));
const sum = (...ls: { item: number; count: number }[][]) => { const m = new Map<number, number>(); for (const l of ls) for (const c of l) m.set(c.item, (m.get(c.item) ?? 0) + c.count); return m; };
function rig() {
  const w = makeWorld(); installPermissions(w); G.installEconomy(w);
  const mk = (pid: number, x: number) => { const p = spawnLearned(w, { x, y: 0, maxWeight: 0, clientId: pid }); w.add(p, PlayerId, { id: pid }).add(p, Membership, { partyId: 0, clanId: 0 }); return p; };
  const A = mk(1, 1), B = mk(2, 2);
  G.clanCreate(w, A); const clan = G.clanOf(w, 1); G.clanInvite(w, A, B); G.clanAccept(w, B, clan);
  const put = (key: string, x: number, y: number, rot = 0) => { const s = G.snapPlacement(w, { piece: d.pieceId(key), x, y, level: 0, rot, tier: 1, variant: 0 }); if (typeof s === "number") throw new Error(`${key} ${s}`); return G.placePiece(w, A, s, { pay: false }); };
  put("claim_totem", 0.5, 4.5); put("foundation", 1.5, 1.5);
  const wall = put("wall_doorway", 1.5, 1.02, 0); const door = put("door_wood", 1.5, 1.02, 0);
  return { w, A, B, wall, door };
}
const have = (w: World, e: Entity, items: Map<number, number>) => [...items.keys()].map((k) => G.countItem(w, e, k));
const demolish = (w: World, who: Entity, p: Entity) => { w.set(who, G.PlayerIntent, { action: G.IntentAction.Demolish, target: p }); steps(w, 1); w.set(who, G.PlayerIntent, { action: G.IntentAction.None }); };

describe("ADR-516 attachments refund with their host", () => {
  it("own wall + door: both refund in full", () => {
    const { w, A, wall, door } = rig(); const want = sum(cost("wall_doorway"), cost("door_wood"));
    expect(G.attachedPieces(w, wall)).toEqual([door]);
    expect(new Map(G.demolishRefundAll(w, A, wall).items.map((c) => [c.item, c.count]))).toEqual(want); // preview agrees
    demolish(w, A, wall); expect(w.isAlive(wall)).toBe(false); expect(w.isAlive(door)).toBe(false);
    expect(have(w, A, want)).toEqual([...want.values()]);
  });
  it("a clanmate's wall + door: both refund half", () => {
    const { w, B, wall } = rig(); const want = sum(half("wall_doorway"), half("door_wood"));
    demolish(w, B, wall); expect(have(w, B, want)).toEqual([...want.values()]);
  });
  it("a wall insert on a plain wall comes back too", () => {
    const { w, A } = rig();
    const s = G.snapPlacement(w, { piece: d.pieceId("wall"), x: 1.02, y: 1.5, level: 0, rot: 3, tier: 1, variant: 0 }); if (typeof s === "number") throw new Error(`wall ${s}`);
    const wall = G.placePiece(w, A, s, { pay: false });
    const ms = G.snapPlacement(w, { piece: d.pieceId("wall_sconce"), x: 1.02, y: 1.5, level: 0, rot: 3, tier: 1, variant: 0 }); if (typeof ms === "number") throw new Error(`sconce ${ms}`);
    const sconce = G.placePiece(w, A, ms, { pay: false });
    expect(G.attachedPieces(w, wall)).toContain(sconce);
    const want = sum(cost("wall"), cost("wall_sconce")); demolish(w, A, wall); expect(have(w, A, want)).toEqual([...want.values()]);
  });
});

describe("ADR-516 overflow drops instead of vanishing", () => {
  const fill = (w: World, e: Entity, keep: number[]) => { const f = [...d.items.values()].find((it) => it.maxStack === 1 && !keep.includes(it.id))!.id; while (G.addItem(w, e, f, 1) === 1) { /* fill */ } };
  it("rounds unloaded by a weapon swap with a full pack land in an owned bag", () => {
    const w = makeWorld(); installPermissions(w); const a = G.spawnPlayer(w, { x: 0, y: 0, clientId: 1 }); w.add(a, PlayerId, { id: 1 });
    G.addItem(w, a, id("revolver"), 1); let s = 0; while (G.slotItem(w, a, s).item !== id("revolver")) s++;
    w.set(a, G.Equipment, { mainHandSlot: s, mainHandItem: id("revolver") }); G.addItem(w, a, id("pistol_round"), 6); steps(w, 1);
    G.setIntent(w, a, { action: G.IntentAction.Reload }); steps(w, 1); G.setIntent(w, a, { action: G.IntentAction.None }); steps(w, 75);
    expect(w.getField(a, G.WeaponState, "loaded")).toBe(6); expect(G.countItem(w, a, id("pistol_round"))).toBe(0);
    fill(w, a, [id("pistol_round")]);
    w.set(a, G.Equipment, { mainHandSlot: G.NO_SLOT, mainHandItem: 0 }); steps(w, 2); // swap away: unload
    const bag = [...w.query([G.LootBag])].find((b) => G.countItem(w, b, id("pistol_round")) > 0);
    expect(bag).toBeDefined(); expect(G.countItem(w, bag!, id("pistol_round"))).toBe(6); expect(w.getField(bag!, G.LootBag, "owner")).toBe(1);
  });
  it("picking up a sign with a full pack drops the sign item in an owned bag", () => {
    const w = makeWorld(); installPermissions(w); const a = spawnLearned(w, { x: 10, y: 10, maxWeight: 0, clientId: 1 }); w.add(a, PlayerId, { id: 1 });
    const item = id("sign_wooden_post"); G.addItem(w, a, item, 1);
    const r = G.placeSign(w, a, G.signKindOf("sign_wooden_post"), 11, 11, 0, "x"); expect(r.fail).toBe(G.SignFail.None);
    fill(w, a, [item]); expect(G.removeSign(w, a, r.sign!)).toBe(G.SignFail.None);
    const bag = [...w.query([G.LootBag])].find((b) => G.countItem(w, b, item) > 0);
    expect(bag).toBeDefined(); expect(w.getField(bag!, G.LootBag, "owner")).toBe(1);
  });
});
