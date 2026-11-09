/**
 * ADR-317 demolish refunds + claim permission (players and AI humans alike) and ADR-318 moving placed pieces.
 */
import { describe, expect, it } from "vitest";
import { installPermissions, Membership, PlayerId, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { collect, makeWorld, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
const iid = (k: string) => d.itemId(k);
function setup() {
  const w = makeWorld(); installPermissions(w); G.installEconomy(w);
  const mk = (pid: number, x = 0, y = 0) => { const p = spawnLearned(w, { x, y, maxWeight: 0, clientId: pid }); w.add(p, PlayerId, { id: pid }).add(p, Membership, { partyId: 0, clanId: 0 }); return p; };
  const fails = collect(w, G.BuildFailed);
  return { w, mk, fails };
}
const snap = (w: World, key: string, x: number, y: number, tier = 1) => G.snapPlacement(w, { piece: d.pieceId(key), x, y, level: 0, rot: 0, tier, variant: 0 });
function place(w: World, b: Entity | 0, key: string, x: number, y: number, tier = 1): Entity {
  const sn = snap(w, key, x, y, tier); if (typeof sn === "number") throw new Error(`snap ${key} ${sn}`); return G.placePiece(w, b, sn, { pay: false });
}
const intent = (w: World, p: Entity, action: number, target: Entity, extra: Record<string, number> = {}) => { w.set(p, G.PlayerIntent, { action, target, ...extra }); steps(w, 1); };
const bag = (w: World, e: Entity, keys: string[]) => keys.map((k) => G.countItem(w, e, iid(k)));
const costOf = (key: string, tier: number) => G.pieceCost(d, d.pieces.get(d.pieceId(key))!, tier);
const keysOf = (key: string, tier: number) => costOf(key, tier).map((c) => d.items.get(c.item)!.key);
const half = (key: string, tier: number) => costOf(key, tier).map((c) => Math.max(1, Math.floor(c.count * d.building.demolishRefund)));
const storageOf = (w: World, piece: Entity) => G.resolveAttachment(w, piece, G.AttachKind.Storage)!;
/** A (pid 1) owns a claim near the origin; B (pid 2) is A's clanmate; X (pid 3) is an outsider with a claim far away. */
function base() {
  const s = setup(); const { w, mk } = s; const A = mk(1, 0, 0), B = mk(2, 1, 0), X = mk(3, 1, 1);
  G.clanCreate(s.w, A); const clan = G.clanOf(w, 1); expect(G.clanInvite(w, A, B)).toBeUndefined(); expect(G.clanAccept(w, B, clan)).toBeUndefined();
  const flag = place(w, A, "claim_totem", 0.5, 3.5);
  return { ...s, A, B, X, clan, flag };
}

describe("ADR-317 demolish refunds", () => {
  it("your own build refunds 100% of its current-tier cost, even when damaged", () => {
    const { w, A } = base(); const f = place(w, A, "foundation", 1, 1, 1);
    w.setField(f, G.BuildPiece, "hp", 1);
    expect(G.demolishRefund(w, A, f)).toEqual({ items: costOf("foundation", 1), full: true });
    intent(w, A, G.IntentAction.Demolish, f); expect(w.isAlive(f)).toBe(false);
    expect(bag(w, A, keysOf("foundation", 1))).toEqual(costOf("foundation", 1).map((c) => c.count));
  });
  it("an upgraded piece refunds the current tier's cost only", () => {
    const { w, A } = base(); const f = place(w, A, "foundation", 1, 1, 2);
    intent(w, A, G.IntentAction.Demolish, f);
    expect(bag(w, A, keysOf("foundation", 2))).toEqual(costOf("foundation", 2).map((c) => c.count));
    expect(bag(w, A, keysOf("foundation", 1).filter((k) => !keysOf("foundation", 2).includes(k))).every((n) => n === 0)).toBe(true);
  });
  it("a clanmate's build refunds 50%, floored, at least 1 of each resource", () => {
    const { w, A, B } = base(); const f = place(w, A, "foundation", 1, 1, 1);
    expect(G.demolishRefund(w, B, f).full).toBe(false);
    intent(w, B, G.IntentAction.Demolish, f); expect(w.isAlive(f)).toBe(false);
    expect(bag(w, B, keysOf("foundation", 1))).toEqual(half("foundation", 1));
    expect(half("foundation", 1).every((n) => n >= 1)).toBe(true);
  });
  it("a reclaimed piece is not the reclaimer's build: 50% (PieceBuilder survives reclaim)", () => {
    const { w, A } = base();
    const ruin = place(w, 0, "foundation", 2, 1, 1); expect(w.getField(ruin, G.PieceBuilder, "player")).toBe(0);
    // what reclaimAbandonedSite writes: the reclaimer becomes owner + tribe; the builder stays the original one
    w.setField(ruin, G.Tribe, "id", G.tribeOf(w, A)); if (w.has(ruin, G.PieceOwner)) w.setField(ruin, G.PieceOwner, "player", 1); else w.add(ruin, G.PieceOwner, { player: 1 });
    expect(G.builtByActor(w, ruin, A)).toBe(false);
    intent(w, A, G.IntentAction.Demolish, ruin); expect(w.isAlive(ruin)).toBe(false);
    expect(bag(w, A, keysOf("foundation", 1))).toEqual(half("foundation", 1));
  });
  it("a hired worker's builds count as the employer's (both ways)", () => {
    const { w, mk, A } = base(); const bot = mk(9, 2, 2); G.setAiHumanPredicate(w, (e) => e === bot); G.ensureWorker(w, bot); w.setField(bot, G.Worker, "owner", 1);
    const byBot = place(w, bot, "foundation", 1, 1, 1); const byA = place(w, A, "foundation", 2, 1, 1);
    expect(w.getField(byBot, G.PieceBuilder, "player")).toBe(9);
    expect(G.demolishRefund(w, A, byBot).full).toBe(true); expect(G.demolishRefund(w, bot, byA).full).toBe(true);
    expect(G.demolishPermission(w, bot, byA)).toBe(0); // the employer's claim
    intent(w, A, G.IntentAction.Demolish, byBot); expect(bag(w, A, keysOf("foundation", 1))).toEqual(costOf("foundation", 1).map((c) => c.count));
  });
  it("builder identity is persisted (STRC v6) and legacy pieces fall back to their tribe", () => {
    const { w, A, B } = base(); const f = place(w, A, "foundation", 1, 1, 1);
    const blob = G.encodeStructures(w, 0, 0);
    G.destroyPiece(w, f, G.DestroyCause.Demolish); steps(w, 1);
    G.decodeStructures(w, blob); steps(w, 1);
    const back = [...w.query([G.BuildPiece, Transform])].find((e) => w.getField(e, G.BuildPiece, "type") === d.pieceId("foundation"))!;
    expect(w.getField(back, G.PieceBuilder, "player")).toBe(1); expect(w.getField(back, G.PieceOwner, "player")).toBe(1);
    expect(G.demolishRefund(w, A, back).full).toBe(true); expect(G.demolishRefund(w, B, back).full).toBe(false);
    w.remove(back, G.PieceBuilder); w.remove(back, G.PieceOwner); // legacy (pre-ADR-317) piece: builder unknown → same tribe counts as own
    expect(G.builtBy(w, back)).toBeUndefined(); expect(G.demolishRefund(w, A, back).full).toBe(true);
  });
});

describe("ADR-317 demolish permission", () => {
  it("own claim and clan claim allow; an outsider is refused with NoDemolishPermission and the piece stays", () => {
    const { w, A, B, X, fails } = base(); const f = place(w, A, "foundation", 1, 1, 1); const g = place(w, A, "foundation", 2, 1, 1);
    expect(G.demolishPermission(w, A, f)).toBe(0); expect(G.demolishPermission(w, B, f)).toBe(0);
    expect(G.demolishPermission(w, X, f)).toBe(G.BuildFail.NoDemolishPermission);
    intent(w, X, G.IntentAction.Demolish, f); expect(w.isAlive(f)).toBe(true);
    expect(fails.at(-1)?.reason).toBe(G.BuildFail.NoDemolishPermission); expect(G.BuildFail.NoDemolishPermission).toBe(28);
    intent(w, B, G.IntentAction.Demolish, g); expect(w.isAlive(g)).toBe(false);
  });
  it("claim flags: only the owner or clan may take them down", () => {
    const { w, A, B, X, flag } = base();
    intent(w, X, G.IntentAction.Demolish, flag); expect(w.isAlive(flag)).toBe(true);
    expect(G.demolishPermission(w, B, flag)).toBe(0); expect(G.demolishPermission(w, A, flag)).toBe(0);
  });
  it("wilderness: worldgen ruins and your own pieces may go; another tribe's piece may not", () => {
    const { w, A, X } = base(); const far = 200;
    w.set(A, Transform, { x: far, y: 0.5, z: 0 }); w.set(X, Transform, { x: far + 1, y: 0.5, z: 0 });
    const ruin = place(w, 0, "foundation", far + 1, 1, 1); const mine = place(w, A, "foundation", far, 2, 1);
    expect(G.zonesAt(w, far, 1).length).toBe(0);
    expect(G.demolishPermission(w, X, ruin)).toBe(0); expect(G.demolishPermission(w, A, mine)).toBe(0);
    expect(G.demolishPermission(w, X, mine)).toBe(G.BuildFail.NoDemolishPermission);
    intent(w, X, G.IntentAction.Demolish, ruin); expect(w.isAlive(ruin)).toBe(false); expect(bag(w, X, keysOf("foundation", 1))).toEqual(half("foundation", 1));
    intent(w, X, G.IntentAction.Demolish, mine); expect(w.isAlive(mine)).toBe(true);
  });
  it("AI humans use the same check: an unhired AI never demolishes a foreign claim's piece; a hired one may on its employer's", () => {
    const { w, mk, A } = base(); const bot = mk(9, 1, 2); G.setAiHumanPredicate(w, (e) => e === bot); G.ensureWorker(w, bot);
    const f = place(w, A, "foundation", 1, 1, 1);
    intent(w, bot, G.IntentAction.Demolish, f); expect(w.isAlive(f)).toBe(true);
    w.setField(bot, G.Worker, "owner", 1); expect(G.demolishPermission(w, bot, f)).toBe(0);
    intent(w, bot, G.IntentAction.Demolish, f); expect(w.isAlive(f)).toBe(false);
  });
});

describe("ADR-318 move placed pieces", () => {
  const moveTo = (w: World, p: Entity, piece: Entity, x: number, y: number, rot = 0) => intent(w, p, G.IntentAction.Move, piece, { x, y, level: 0, rot });
  it("moves the same entity, keeping hp, tier, tribe, builder and container contents; emits PieceMoved", () => {
    const { w, A, B, X } = base(); const moved = collect(w, G.PieceMoved);
    const box = place(w, A, "storage_box", 1.5, 1.5, 0); const st = storageOf(w, box); G.addItem(w, st, iid("stone"), 7);
    const before = { ...w.get(box, G.BuildPiece)! }; const tribe = w.getField(box, G.Tribe, "id");
    expect(G.validateMove(w, A, box, { x: 3.5, y: 1.5, level: 0, rot: 1 })).toBe(0);
    moveTo(w, A, box, 3.5, 1.5, 1);
    expect(w.isAlive(box)).toBe(true); const t = w.get(box, Transform)!; expect([t.x, t.y]).toEqual([3.5, 1.5]);
    expect(w.getField(box, G.BuildPiece, "rot")).toBe(1);
    expect(w.getField(box, G.BuildPiece, "hp")).toBe(before.hp); expect(w.getField(box, G.BuildPiece, "tier")).toBe(before.tier);
    expect(w.getField(box, G.Tribe, "id")).toBe(tribe); expect(w.getField(box, G.PieceBuilder, "player")).toBe(1);
    expect(storageOf(w, box)).toBe(st); expect(G.countItem(w, st, iid("stone"))).toBe(7);
    expect(moved.map((m) => m.piece)).toEqual([box]);
    // the index re-slotted the same entity: its slot is the new cell, the old cell is free, the new one is taken
    expect(G.structures(w).indexedAt(box)!.slot).toMatchObject({ tx: 3, ty: 1 });
    w.set(A, Transform, { x: 2.5, y: 0.5, z: 0 }); for (const o of [B, X]) w.set(o, Transform, { x: 6, y: 6, z: 0 });
    const a = snap(w, "storage_box", 1.5, 1.5, 0), b = snap(w, "storage_box", 3.5, 1.5, 0);
    if (typeof a !== "number") expect(G.validatePlacement(w, A, a, { ignoreCost: true })).toBe(0);
    if (typeof b !== "number") expect(G.validatePlacement(w, A, b, { ignoreCost: true })).toBe(G.BuildFail.Occupied);
  });
  it("refuses a damaged piece (Repair it first), a foreign piece (Not yours) and a destination without permission", () => {
    const { w, A, X, mk, fails } = base(); const box = place(w, A, "storage_box", 1.5, 1.5, 0);
    w.setField(box, G.BuildPiece, "hp", 1);
    expect(G.moveBlocker(w, A, box)).toBe(G.BuildFail.NeedsRepair);
    moveTo(w, A, box, 3.5, 1.5); expect(w.get(box, Transform)!.x).toBe(1.5); expect(fails.at(-1)?.reason).toBe(G.BuildFail.NeedsRepair);
    w.setField(box, G.BuildPiece, "hp", G.maxHpOf(w, box));
    expect(G.moveBlocker(w, X, box)).toBe(G.BuildFail.NotYours);
    moveTo(w, X, box, 2.5, 1.5); expect(w.get(box, Transform)!.x).toBe(1.5);
    // a piece of A's in the wilderness can't be moved into Y's claim
    const Y = mk(4, 100, 0); place(w, Y, "claim_totem", 100.5, 4.5); w.set(A, Transform, { x: 68, y: 0.5, z: 0 });
    const wild = place(w, A, "storage_box", 66.5, 0.5, 0);
    expect(G.validateMove(w, A, wild, { x: 69.5, y: 0.5, level: 0, rot: 0 })).toBe(G.BuildFail.NoMovePermission);
    expect(w.get(wild, Transform)!.x).toBe(66.5);
  });
  it("a clanmate may move clan pieces; validateMove (the client's cancel / preview path) changes nothing", () => {
    const { w, A, B } = base(); const box = place(w, A, "storage_box", 1.5, 1.5, 0);
    const slot = G.structures(w).indexedAt(box);
    expect(G.validateMove(w, B, box, { x: 2.5, y: 2.5, level: 0, rot: 0 })).toBe(0);
    expect(G.structures(w).indexedAt(box)).toEqual(slot); expect(w.get(box, Transform)!.x).toBe(1.5);
    const again = snap(w, "storage_box", 1.5, 1.5, 0); if (typeof again !== "number") expect(G.validatePlacement(w, A, again, { ignoreCost: true })).not.toBe(0);
  });
  it("the destination goes through validatePlacement (an occupied spot fails, nothing moves)", () => {
    const { w, A } = base(); const box = place(w, A, "storage_box", 1.5, 1.5, 0); place(w, A, "storage_box", 3.5, 1.5, 0);
    const why = G.validateMove(w, A, box, { x: 3.5, y: 1.5, level: 0, rot: 0 }); expect(why).not.toBe(0);
    moveTo(w, A, box, 3.5, 1.5); expect(w.get(box, Transform)!.x).toBe(1.5);
  });
  it("structural pieces holding others up are refused (HasDependents)", () => {
    const { w, A } = base(); const f = place(w, A, "foundation", 1, 1, 1);
    const ws = snap(w, "wall_corner_outer", 1, 1); if (typeof ws === "number") throw new Error(`wall ${ws}`); G.placePiece(w, A, ws, { pay: false });
    expect(G.moveBlocker(w, A, f)).toBe(G.BuildFail.HasDependents);
    const lone = place(w, A, "foundation", 4, 1, 1); expect(G.moveBlocker(w, A, lone)).toBe(0);
  });
  it("a moved Claim Flag ignores its own zone but still respects ADR-315 overlap", () => {
    const { w, A, mk } = base(); const flag = [...w.query([G.PrivilegeZone])][0]!;
    w.set(A, Transform, { x: 1.5, y: 2.5, z: 0 });
    expect(G.validateMove(w, A, flag, { x: 2.5, y: 3.5, level: 0, rot: 0 })).toBe(0); // overlaps only its own old border
    expect(G.movePiece(w, A, flag, { x: 2.5, y: 3.5, level: 0, rot: 0 })).toBe(0); steps(w, 1);
    expect(w.get(flag, Transform)!.x).toBe(2.5); expect(G.hasOwnClaim(w, A, 2.5, 3.5)).toBe(true);
    const Z = mk(5, 120, 0); place(w, Z, "claim_totem", 120.5, 0.5);
    const r = d.pieces.get(d.pieceId("claim_totem"))!.privilegeRadius; w.set(A, Transform, { x: 120.5 - r - 5, y: 0.5, z: 0 });
    expect(G.movePiece(w, A, flag, { x: 120.5 - r - 4, y: 0.5, level: 0, rot: 0 })).toBe(G.BuildFail.ClaimOverlap);
    expect(w.get(flag, Transform)!.x).toBe(2.5);
  });
});
