/** ADR-517: pieces that collapse because a player demolished their support refund that player (own 100% / other 50%,
 *  attachments included, once each); collapses from raid damage refund nothing; overflow / far-away refunds drop in
 *  a bag owned by the demolisher. */
import { describe, expect, it } from "vitest";
import { installPermissions, Membership, PlayerId, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
const cost = (key: string) => G.pieceCost(d, d.pieces.get(d.pieceId(key))!, 1);
const half = (key: string) => cost(key).map((c) => ({ item: c.item, count: Math.max(1, Math.floor(c.count * d.building.demolishRefund)) }));
const sum = (...ls: { item: number; count: number }[][]) => { const m = new Map<number, number>(); for (const l of ls) for (const c of l) m.set(c.item, (m.get(c.item) ?? 0) + c.count); return m; };
const of = (w: World, e: Entity, m: Map<number, number>) => new Map([...m.keys()].map((k) => [k, G.countItem(w, e, k)]));
const bags = (w: World) => [...w.query([G.LootBag])];
function rig() {
  const w = makeWorld(); installPermissions(w); G.installEconomy(w);
  const mk = (pid: number, x: number) => { const p = spawnLearned(w, { x, y: 5.5, maxWeight: 0, clientId: pid }); w.add(p, PlayerId, { id: pid }).add(p, Membership, { partyId: 0, clanId: 0 }); return p; };
  const A = mk(1, 6), B = mk(2, 6.5);
  G.clanCreate(w, A); const clan = G.clanOf(w, 1); G.clanInvite(w, A, B); G.clanAccept(w, B, clan);
  const put = (key: string, x: number, y: number, o: { level?: number; rot?: number } = {}) => {
    const s = G.snapPlacement(w, { piece: d.pieceId(key), x, y, level: o.level ?? 0, rot: o.rot ?? 0, tier: 1, variant: 0 }); if (typeof s === "number") throw new Error(`${key} ${s}`);
    return G.placePiece(w, A, s, { pay: false });
  };
  put("claim_totem", 4.5, 4.5); put("foundation", 5.5, 5.5); put("foundation", 6.5, 5.5);
  const wall = put("wall", 7, 5.5); const floor = put("floor", 6.5, 5.5, { level: 1 });
  const tri = put("floor_triangle", 7.3, 5.5, { level: 1 }); steps(w, 2);
  return { w, A, B, wall, floor, tri, put };
}
const demolish = (w: World, who: Entity, p: Entity) => { w.set(who, G.PlayerIntent, { action: G.IntentAction.Demolish, target: p }); steps(w, 1); w.set(who, G.PlayerIntent, { action: G.IntentAction.None }); steps(w, 3); };

const fill = (w: World, e: Entity) => { const f = [...d.items.values()].find((it) => it.maxStack === 1 && !cost("wall").some((c) => c.item === it.id))!.id; while (G.addItem(w, e, f, 1) === 1) { /* fill */ } };

describe("ADR-517 collapse refunds", () => {
  it("demolishing my own support: the piece it brings down refunds in full too", () => {
    const { w, A, wall, floor, tri } = rig(); const want = sum(cost("wall"), cost("floor"), cost("floor_triangle"));
    demolish(w, A, wall); for (const p of [wall, floor, tri]) expect(w.isAlive(p)).toBe(false); // the floor + triangle hung off the wall
    expect(of(w, A, want)).toEqual(want); expect(bags(w)).toEqual([]);
  });
  it("a clanmate demolishing it: the collapse refunds half", () => {
    const { w, A, B, wall, tri } = rig(); const want = sum(half("wall"), half("floor"), half("floor_triangle"));
    demolish(w, B, wall); expect(w.isAlive(tri)).toBe(false);
    expect(of(w, B, want)).toEqual(want); expect([...of(w, A, want).values()].every((n) => n === 0)).toBe(true);
  });
  it("a collapsing wall's insert refunds with it, once", () => {
    const { w, A, wall, put } = rig();
    const up = put("wall", 7.02, 5.5, { level: 1, rot: 1 }); const sconce = put("wall_sconce", 7.02, 5.5, { level: 1, rot: 1 }); steps(w, 2);
    expect(G.attachedPieces(w, up)).toContain(sconce);
    const want = sum(cost("wall"), cost("floor"), cost("floor_triangle"), cost("wall"), cost("wall_sconce"));
    demolish(w, A, wall); expect(w.isAlive(up)).toBe(false); expect(w.isAlive(sconce)).toBe(false);
    expect(of(w, A, want)).toEqual(want);
  });
  it("raid damage bringing the same piece down refunds nothing", () => {
    const { w, A, B, wall, tri } = rig(); const want = sum(cost("wall"), cost("floor"), cost("floor_triangle"));
    G.damagePiece(w, wall, 1e6); steps(w, 3); expect(w.isAlive(tri)).toBe(false);
    for (const p of [A, B]) expect([...of(w, p, want).values()].every((n) => n === 0)).toBe(true);
    expect(bags(w)).toEqual([]);
  });
  it("a full pack: the collapse refund lands in a bag owned by the demolisher", () => {
    const { w, A, wall } = rig(); fill(w, A); const want = sum(cost("wall"), cost("floor"), cost("floor_triangle"));
    demolish(w, A, wall);
    const got = new Map<number, number>(); for (const b of bags(w)) { expect(w.getField(b, G.LootBag, "owner")).toBe(1); for (const k of want.keys()) got.set(k, (got.get(k) ?? 0) + G.countItem(w, b, k)); }
    for (const [k, n] of got) got.set(k, n + G.countItem(w, A, k));
    expect(got).toEqual(want);
  });
  it("far away (or gone): the refund waits in their bag at the collapse spot", () => {
    const { w, A, tri } = rig(); const hook = w.getResource(G.CollapseRefundRes)!;
    w.set(A, Transform, { x: 6 + G.COLLAPSE_REFUND_NEAR + 5, y: 5.5 });
    const t = w.get(tri, Transform)!; hook.piece(w, { by: A, pid: 1 }, tri); hook.flush(w);
    const [bag] = bags(w); expect(bag).toBeDefined(); expect(w.getField(bag!, G.LootBag, "owner")).toBe(1);
    const bt = w.get(bag!, Transform)!; expect([bt.x, bt.y]).toEqual([t.x, t.y]);
    const want = sum(cost("floor_triangle")); expect(of(w, bag!, want)).toEqual(want); expect(G.countItem(w, A, [...want.keys()][0]!)).toBe(0);
  });
});
