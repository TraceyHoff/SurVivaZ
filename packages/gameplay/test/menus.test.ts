import { describe, expect, it } from "vitest";
import { GroupRole, installPermissions, Membership, PlayerId, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

const d = G.defaultDefs(); const id = (k: string) => d.itemId(k);
function setup() {
  const w = makeWorld(); installPermissions(w); G.installEconomy(w); G.installCraftQueue(w); const names = G.playerNames(w);
  const mk = (pid: number, name: string, x = 0): Entity => { const p = G.spawnPlayer(w, { x, y: 0, maxWeight: 0, clientId: pid }); w.add(p, PlayerId, { id: pid }).add(p, Membership, { partyId: 0, clanId: 0 }); names.set(pid, name); return p; };
  return { w, names, mk };
}
const ctx = (w: World, player: Entity, names: G.NameLookup) => ({ world: w, player, names });

describe("menu view-models", () => {
  it("inventory: slots with crafter name in the tooltip", () => {
    const { w, names, mk } = setup(); const a = mk(7, "Ada");
    G.addItem(w, a, id("wood"), 5, 7);
    const v = G.inventoryView(ctx(w, a, names)); const wood = v.find((s) => s.item === id("wood"))!;
    expect(wood).toMatchObject({ count: 5, crafterName: "Ada" }); expect(wood.tooltip).toContain("Crafted by Ada");
  });
  it("crafting: recipes with have/need + reason, queue progress, owed, and intents", () => {
    const { w, names, mk } = setup(); const a = mk(7, "Ada"); const axe = d.recipeId("stone_axe");
    G.addItem(w, a, id("wood"), 10); G.addItem(w, a, id("stone"), 4); G.addItem(w, a, id("fiber"), 4);
    let v = G.craftingView(ctx(w, a, names)); const r = v.recipes.find((x) => x.id === axe)!;
    expect(r.reason).toBeUndefined(); expect(r.ingredients.every((i) => i.have >= i.count)).toBe(true);
    expect(G.enqueueCraft(w, a, axe, 2)).toBe(0); steps(w, 10);
    v = G.craftingView(ctx(w, a, names)); expect(v.queue[0]).toMatchObject({ slot: 0, recipe: axe, count: 2 }); expect(v.queue[0]!.progress).toBeGreaterThan(0);
    G.oweCraftOutput(w, a, { item: id("stone_axe"), count: 1, crafterId: 7 });
    expect(G.craftingView(ctx(w, a, names)).owed).toEqual([{ item: id("stone_axe"), name: expect.any(String), count: 1, crafterName: "Ada" }]);
    expect(G.queueCraftIntent(axe, 99)).toMatchObject({ cmd: G.QueueCraftCmd, args: { recipe: axe, count: G.MAX_CRAFT_COUNT } });
    expect(G.cancelQueuedCraftIntent(1)).toMatchObject({ cmd: G.CancelQueuedCraftCmd, args: { slot: 1 } });
  });
  it("build: pieces, tier costs with affordability, variants; place intent carries tier + variant", () => {
    const { w, names, mk } = setup(); const a = mk(7, "Ada");
    const v = G.buildView(ctx(w, a, names)); expect(v.length).toBe(d.pieces.size);
    const p = v.find((x) => x.tiers.some((t) => t.cost.length))!; expect(p.tiers[0]!.affordable).toBe(false);
    expect(p.variants.length).toBeGreaterThan(0);
    expect(G.placeIntent({ piece: p.id, tier: 1, variant: 2, paint: 0 }, { x: 3, y: 4 })).toMatchObject({ cmd: G.PlaceCmd, args: { piece: p.id, x: 3, y: 4, tier: 1, variant: 2, level: 0, rot: 0 } });
    expect(G.paintIntent(a, 3).entities).toEqual(["target"]);
  });
  it("wardrobe: slots, unlock list, equip/setAppearance intents", () => {
    const { w, names, mk } = setup(); const a = mk(7, "Ada");
    const v = G.wardrobeView(ctx(w, a, names)); expect(v.slots.length).toBe(9); expect(v.slots[8]!.key).toBe("hands"); expect(v.unlocks.map((u) => u.tag)).toEqual([...G.COSMETICS.unlockTags]);
    expect(G.equipCosmeticIntent(3, 12, 1, 2)).toMatchObject({ cmd: G.EquipCosmeticCmd, args: { slot: 3, wearable: 12, primary: 1, secondary: 2 } });
    expect(G.setAppearanceIntent({ bodyType: 1, skinTone: 2, parts: [1], primary: [0], secondary: [0] }).cmd).toBe(G.SetAppearanceCmd);
  });
  it("party: pending invite from PartyInvitePending, members, candidates, all five intents", () => {
    const { w, names, mk } = setup(); const a = mk(7, "Ada"); const b = mk(9, "Bo", 2);
    expect(G.partyView(ctx(w, b, names)).candidates.map((c) => c.name)).toEqual(["Ada"]);
    expect(G.partyInvite(w, a, b)).toBeUndefined();
    const pid = G.partyOf(w, 7); const v = G.partyView(ctx(w, b, names));
    expect(v.invite).toMatchObject({ party: pid, fromName: "Ada" }); expect(v.invite!.secondsLeft).toBeGreaterThan(0);
    G.partyAccept(w, b, pid); const m = G.partyView(ctx(w, a, names)); expect(m.members.map((x) => x.name).sort()).toEqual(["Ada", "Bo"]); expect(m.candidates).toEqual([]);
    expect([G.partyInviteIntent(b), G.partyAcceptIntent(pid), G.partyDeclineIntent(pid), G.partyLeaveIntent(), G.partyKickIntent(b)].map((i) => i.cmd)).toEqual([...G.PARTY_COMMANDS]);
  });
  it("clan: ClanStatus, ClanInvitePending, rank perms, every command intent", () => {
    const { w, names, mk } = setup(); const a = mk(7, "Ada"); const b = mk(9, "Bo", 2);
    expect(G.clanCreate(w, a)).toBeUndefined(); const v = G.clanView(ctx(w, a, names));
    expect(v.clan).toBeGreaterThan(0); expect(v.role).toBe(GroupRole.Leader); expect(v.perms.map((p) => p.roleName)).toEqual(["Member", "Officer"]);
    expect(G.clanInvite(w, a, b)).toBeUndefined(); expect(G.clanView(ctx(w, b, names)).invite).toMatchObject({ clan: v.clan, fromName: "Ada" });
    expect(G.togglePermMask(0, "collect")).toBe(G.clanPermBit("collect"));
    const all = [G.clanCreateIntent(), G.clanInviteIntent(b), G.clanAcceptIntent(1), G.clanLeaveIntent(), G.clanPromoteIntent(b), G.clanDemoteIntent(b), G.clanKickIntent(b), G.clanSetRankPermsIntent(1, 3), G.clanDisbandIntent(), G.clanSetGoalIntent(1, 2, 3)];
    expect(all.map((i) => i.cmd)).toEqual([...G.CLAN_COMMANDS]);
  });
  it("trade stall: listings with price/stock/affordability, till, buy intent that buyFromStallResult accepts, name bytes", () => {
    const { w, names, mk } = setup(); const a = mk(7, "Ada"); const b = mk(9, "Bo", 1);
    const sn = G.snapPlacement(w, { piece: d.pieceId("stall_booth"), x: 1, y: 1, level: 0, rot: 0, tier: 0, variant: 0 }); if (typeof sn === "number") throw new Error("snap");
    const stall = G.stallOf(w, G.placePiece(w, a, sn, { pay: false }))!;
    G.addItem(w, a, id("planks"), 20, 7); G.stockStall(w, a, stall, 0, 0, 20);
    G.setListing(w, a, stall, 0, { priceItem: id("coin"), priceCount: 3, qty: 5, enabled: 1 }); G.setStallOpen(w, a, stall, 1); G.addItem(w, b, id("coin"), 10);
    expect(G.nearestStall(ctx(w, b, names))).toBe(stall);
    const v = G.stallView(ctx(w, b, names), stall)!; expect(v.mine).toBe(false); expect(G.stallView(ctx(w, a, names), stall)!.mine).toBe(true);
    const l = v.listings[0]!; expect(l).toMatchObject({ stock: 20, qty: 5, priceCount: 3, canAfford: true });
    const it = G.buyFromStallIntent(v, l); expect(it.entities).toEqual(["stall"]);
    const r = G.buyFromStallResult(w, b, stall, { listingSlot: it.args["listingSlot"] as number, qty: it.args["qty"] as number, expectedRevision: it.args["expectedRevision"] as number, expectedPriceItem: it.args["expectedPriceItem"] as number, expectedPriceCount: it.args["expectedPriceCount"] as number });
    expect(r).toMatchObject({ crafterId: 7 });
    expect(G.stallView(ctx(w, a, names), stall)!.till).toEqual([{ item: id("coin"), name: expect.any(String), count: 3 }]);
    const n = G.setStallNameIntent(stall, "Ada's ✨ Planks"); expect(n.args["len"]).toBe(13); expect((n.args["name"] as number[]).length).toBe(24);
    expect(G.collectTillIntent(stall).cmd).toBe(G.CollectTillCmd);
  });
  it("ADR-142: a replica without the viewer-scoped till / stock containers still builds a stall view", () => {
    const { w, names, mk } = setup(); const a = mk(7, "Ada"); const b = mk(9, "Bo", 1);
    const sn = G.snapPlacement(w, { piece: d.pieceId("stall_booth"), x: 1, y: 1, level: 0, rot: 0, tier: 0, variant: 0 }); if (typeof sn === "number") throw new Error("snap");
    const stall = G.stallOf(w, G.placePiece(w, a, sn, { pay: false }))!;
    const till = G.tillOf(w, stall)!; w.remove(till, G.Container); w.remove(stall, G.Container); w.remove(stall, G.Listings);
    const v = G.stallView(ctx(w, b, names), stall)!; expect(v.till).toEqual([]); expect(v.listings).toEqual([]);
  });
});

describe("build placement preview", () => {
  it("clamps world-point aim to reach, snaps, validates, rotates and builds the PlaceCmd", () => {
    const { w, mk } = setup(); const a = mk(7, "Ada"); const reach = G.gameplayDefs(w).building.buildReach;
    const p = [...d.pieces.values()].find((x) => x.placement === G.Placement.Cell)!;
    const sel = { piece: p.id, tier: 0, variant: 0, paint: 0 };
    const far = G.buildPreviewFor(w, a, sel, 0, { x: 50, y: 0, mode: 1 })!;
    expect(far.pieceKey).toBe(p.key); expect(far.request.x).toBeCloseTo(reach - G.SNAP_REACH_MARGIN); // ADR-142: pulled in so the snap stays in reach expect(far.rotSteps).toBe(4);
    expect(far.valid).toBe(far.reason === 0);
    const dir = G.buildPreviewFor(w, a, sel, 1, { x: 0, y: -1, mode: 0 })!;
    expect(dir.request).toMatchObject({ x: 0, y: -G.PLACE_AHEAD, rot: 1 });
    expect(G.rotateStep(w, p.id, 3, 1)).toBe(0); expect(G.rotateStep(w, p.id, 0, -1)).toBe(3);
    // ADR-347: the PlaceCmd carries the ghost's snapped slot, not the raw aim (here the snapped cell centre).
    expect(G.placePreviewIntent(dir)).toMatchObject({ cmd: G.PlaceCmd, args: { piece: p.id, x: dir.x, y: dir.y, rot: 1 } });
    // unaffordable tiered piece is invalid with a BuildFail reason
    const tiered = [...d.pieces.values()].find((x) => x.tiered)!;
    const bad = G.buildPreviewFor(w, a, { piece: tiered.id, tier: 1, variant: 0, paint: 0 }, 0, { x: 1, y: 0, mode: 1 })!;
    expect(bad.valid).toBe(false); expect(bad.reason).not.toBe(0);
  });
});
