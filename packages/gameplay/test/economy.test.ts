import { describe, it, expect } from "vitest";
import { PlayerNames, GroupKind, GroupRole, installPermissions, Membership, PlayerId, transaction, type Entity, type World } from "@engine/core";
import {
  addItem, attachmentsOf, buyFromStall, countItem, collectTill, decodeStructures, defaultDefs, destroyPiece, DestroyCause, encodeStructures,
  executeStallPurchase, IntentAction, itemInfo, Listings, listSlots, LootBag, moveSlotTuples, placePiece, playerNames, setIntent,
  setListing, setStallOpen, snapPlacement, spawnPlayer, spawnStation, stallLedger, stallListing, stallOf, StallHeader, StallOwnerKind, StallSale,
  stockStall, tillOf, transferItem, unloadStructures, validateStallPurchase, StationKind, TillCollected, listingRevision, unstockStall, openStall,
  ECONOMY, Container, type PurchaseRequest,
} from "../src/index.js";
import { DEFAULT_RAW_DEFS } from "../src/data.js";
import { collect, makeWorld, steps, spawnLearned } from "./helpers.js";

const d = defaultDefs(); const id = (k: string) => d.itemId(k);
const COIN = id("coin"), AXE = id("iron_axe"), PLANK = id("planks");

function setup() {
  const w = makeWorld(); const perms = installPermissions(w);
  const { installEconomy } = mod; installEconomy(w);
  const names = playerNames(w);
  const mk = (pid: number, name: string, x = 0) => { const p = spawnLearned(w, { x, y: 0, maxWeight: 0, clientId: pid }); w.add(p, PlayerId, { id: pid }).add(p, Membership, { partyId: 0, clanId: 0 }); names.set(pid, name); return p; };
  return { w, perms, mk };
}
import * as mod from "../src/index.js";

function placeStall(w: World, builder: Entity, key: string, x = 1, y = 1): Entity {
  const sn = snapPlacement(w, { piece: d.pieceId(key), x, y, level: 0, rot: 0, tier: 0, variant: 0 });
  if (typeof sn === "number") throw new Error(`snap failed ${sn}`);
  const piece = placePiece(w, builder, sn, { pay: false }); return stallOf(w, piece)!;
}
const req = (w: World, stall: Entity, over: Partial<PurchaseRequest> = {}): PurchaseRequest => {
  const l = stallListing(w, stall, 0)!; return { listingSlot: 0, qty: 1, expectedRevision: listingRevision(w, stall), expectedPriceItem: l.priceItem, expectedPriceCount: l.priceCount, ...over };
};
function stocked() {
  const s = setup(); const A = s.mk(7, "Ada"); const B = s.mk(9, "Bo", 1);
  const stall = placeStall(s.w, A, "stall_booth");
  addItem(s.w, A, PLANK, 20, 7);
  expect(stockStall(s.w, A, stall, 0, 0, 20)).toBeUndefined();
  expect(setListing(s.w, A, stall, 0, { priceItem: COIN, priceCount: 3, qty: 5, enabled: 1 })).toBeUndefined();
  expect(setStallOpen(s.w, A, stall, 1)).toBeUndefined();
  addItem(s.w, B, COIN, 10);
  return { ...s, A, B, stall };
}

describe("economy data", () => {
  it("asserts no vendor sources: every item has a gather or craft source", () => {
    expect(ECONOMY.noVendorSources).toBe(true);
    const crafted = new Set([...d.recipes.values()].map((r) => r.output.item));
    const gathered = new Set<number>([id("soil")]); // ADR-264: terrain digging, covered by task36_terrain.test.ts
    for (const r of d.resources.values()) for (const y of (r as unknown as { yields?: { item: number }[] }).yields ?? []) gathered.add(y.item);
    for (const a of mod.animalDefs()) for (const l of a.loot) gathered.add(d.itemId(l.item)); // ADR-110: hunting yields
    gathered.add(id("dung")); // ADR-352: produced by dungSystem (data/dung.json), not gathered / crafted / looted
    const raw = JSON.stringify(DEFAULT_RAW_DEFS.resources);
    const missing = [...d.items.values()].filter((it) => !crafted.has(it.id) && !gathered.has(it.id) && !raw.includes(`"${it.key}"`) && it.key !== d.items.get(d.spoiledItem)?.key && it.key !== mod.KEY_ITEM && !(it.boilSource && (crafted.has(it.boilSource) || gathered.has(it.boilSource)))); // boiled variants come from the Boil action on their raw form, not a vendor/craft/gather source
    expect(missing.map((m) => m.key)).toEqual([]);
  });
  it("coin is crafted at the anvil; stall pieces carry listing counts", () => {
    const r = [...d.recipes.values()].find((x) => x.output.item === COIN)!; expect(r.station).toBe(StationKind.Anvil);
    expect([["stall_blanket", 4], ["stall_cart", 8], ["stall_booth", 12], ["clan_pavilion", 24]].map(([k]) => d.pieces.get(d.pieceId(k as string))!.stall!.listings)).toEqual([4, 8, 12, 24]);
    expect(d.pieces.get(d.pieceId("clan_pavilion"))!.stall!.clanOnly).toBe(true);
  });
});

describe("crafter provenance", () => {
  it("records the crafter on crafting and resolves the name (follows renames)", () => {
    const { w, mk } = setup(); const A = mk(7, "Ada");
    spawnStation(w, StationKind.Workbench, 0.5, 0);
    addItem(w, A, id("wood"), 2);
    setIntent(w, A, { action: IntentAction.Craft, recipe: d.recipeId("planks") }); steps(w, 60);
    const slot = listSlots(w, A).find((s) => s.item === PLANK)!;
    expect(itemInfo(w, A, slot.slot)).toMatchObject({ itemKey: "planks", count: 3, crafterId: 7, crafterName: "Ada", freshnessStage: 0 });
    playerNames(w).set(7, "Ada2"); expect(itemInfo(w, A, slot.slot)!.crafterName).toBe("Ada2");
    expect(itemInfo(w, A, slot.slot, { get: () => "client-cache" })!.crafterName).toBe("client-cache");
  });
  it("different crafters never stack; gathered = 0; survives transfer, core transfer and moveSlotTuples", () => {
    const { w, mk } = setup(); const A = mk(7, "Ada"); const B = mk(9, "Bo");
    addItem(w, A, PLANK, 5, 7); addItem(w, A, PLANK, 5, 9); addItem(w, A, PLANK, 5, 0);
    expect(listSlots(w, A).map((s) => s.crafterId)).toEqual([7, 9, 0]);
    expect(transferItem(w, A, B, PLANK, 15)).toBe(15);
    expect(listSlots(w, B).map((s) => [s.crafterId, s.count]).sort()).toEqual([[0, 5], [7, 5], [9, 5]]);
    // core transaction(): merging different crafters is rejected, into an empty slot keeps provenance
    const s7 = listSlots(w, B).find((s) => s.crafterId === 7)!, s9 = listSlots(w, B).find((s) => s.crafterId === 9)!;
    expect(transaction(w, (tx) => tx.transfer(B, s7.slot, B, s9.slot, 2)).ok).toBe(false); // core stack key: different crafter = occupied
    expect(transaction(w, (tx) => tx.transfer(B, s7.slot, A, 0, 5)).ok).toBe(true);
    expect(itemInfo(w, A, 0)!.crafterId).toBe(7);
    // trade/loot path (net coreTradeInventory uses tx.transfer into empty slots; death bags use moveSlotTuples)
    expect(moveSlotTuples(w, B, A, [{ slot: s9.slot, count: 5 }])).toBe(true);
    expect(listSlots(w, A).find((s) => s.crafterId === 9)!.count).toBe(5);
  });
  it("names come from core's PlayerNameRegistry resource", () => {
    const { w } = setup(); expect(w.resource(PlayerNames)).toBe(playerNames(w));
  });
});

describe("trade stalls", () => {
  it("personal stall: only the owner manages; others may only buy when open", () => {
    const { w, A, B, stall } = stocked();
    expect(w.get(stall, StallHeader)).toMatchObject({ ownerKind: StallOwnerKind.Player, ownerId: 7, open: 1, listingCount: 12 });
    addItem(w, B, PLANK, 5);
    expect(stockStall(w, B, stall, 1, listSlots(w, B).find((s) => s.item === PLANK)!.slot, 5)).toBe("forbidden");
    expect(setListing(w, B, stall, 0, { priceItem: COIN, priceCount: 0, qty: 1, enabled: 1 })).toBe("forbidden");
    expect(collectTill(w, B, stall)).toBe("forbidden");
    setStallOpen(w, A, stall, 0); expect(validateStallPurchase(w, B, stall, req(w, stall))).toBe("stall_closed");
  });
  it("clan stall: rank policies from data (leader/officer price+collect, member stock only, recruit buy only)", () => {
    const { w, perms, mk } = setup(); const L = mk(1, "Lead"), O = mk(2, "Off"), M = mk(3, "Mem"), R = mk(4, "Out");
    const clan = perms.groups.create(GroupKind.Clan, 1).id; perms.groups.setRole(clan, 2, GroupRole.Officer); perms.groups.setRole(clan, 3, GroupRole.Member);
    w.setField(L, Membership, "clanId", clan);
    const stall = placeStall(w, L, "clan_pavilion");
    expect(w.get(stall, StallHeader)).toMatchObject({ ownerKind: StallOwnerKind.Clan, ownerId: clan, listingCount: 24 });
    for (const p of [M, O, R]) addItem(w, p, PLANK, 5);
    const slotOf = (p: Entity) => listSlots(w, p).find((s) => s.item === PLANK)!.slot;
    expect(stockStall(w, M, stall, 0, slotOf(M), 5)).toBeUndefined();
    expect(setListing(w, M, stall, 0, { priceItem: COIN, priceCount: 1, qty: 1, enabled: 1 })).toBe("forbidden");
    expect(setListing(w, O, stall, 0, { priceItem: COIN, priceCount: 1, qty: 1, enabled: 1 })).toBeUndefined();
    expect(collectTill(w, M, stall)).toBe("forbidden");
    expect(stockStall(w, R, stall, 1, slotOf(R), 5)).toBe("forbidden");
    expect(setStallOpen(w, L, stall, 1)).toBeUndefined();
    addItem(w, R, COIN, 1); expect(buyFromStall(w, R, stall, req(w, stall))).toBeUndefined();
  });
  it("buy is atomic: goods with provenance to the buyer, payment to the till, ledger + stall_sale", () => {
    const { w, B, A, stall } = stocked(); const sales = collect(w, StallSale);
    expect(buyFromStall(w, B, stall, req(w, stall, { qty: 2 }))).toBeUndefined();
    expect(countItem(w, B, PLANK)).toBe(10); expect(countItem(w, B, COIN)).toBe(4);
    expect(listSlots(w, B).filter((s) => s.item === PLANK).every((s) => s.crafterId === 7)).toBe(true);
    const till = tillOf(w, stall)!; expect(countItem(w, till, COIN)).toBe(6); expect(stallListing(w, stall, 0)!.stock).toBe(10);
    expect(stallLedger(w, stall)).toEqual([expect.objectContaining({ item: PLANK, count: 10, priceItem: COIN, priceCount: 6, buyerId: 9, crafterId: 7 })]);
    w.step(1 / 20);
    expect(sales).toEqual([expect.objectContaining({ stall, item: PLANK, count: 10, priceItem: COIN, priceCount: 6, buyerId: 9, ownerKind: 1, ownerId: 7 })]);
    const col = collect(w, TillCollected);
    expect(collectTill(w, A, stall)).toBeUndefined(); expect(countItem(w, A, COIN)).toBe(6); expect(countItem(w, till, COIN)).toBe(0);
    expect(collectTill(w, A, stall)).toBe("till_empty");
    w.step(1 / 20); expect(col).toEqual([expect.objectContaining({ collectorId: 7, items: 6 })]);
  });
  it("rejection paths change nothing", () => {
    const { w, B, A, stall, mk } = stocked();
    const snap = () => JSON.stringify([listSlots(w, B), listSlots(w, stall), listSlots(w, tillOf(w, stall)!)]);
    const before = snap();
    expect(validateStallPurchase(w, B, stall, req(w, stall, { qty: 5 }))).toBe("sold_out");
    expect(validateStallPurchase(w, B, stall, req(w, stall, { qty: 4 }))).toBe("no_funds");
    expect(validateStallPurchase(w, B, stall, req(w, stall, { expectedPriceCount: 2 }))).toBe("price_changed");
    expect(validateStallPurchase(w, B, stall, req(w, stall, { expectedRevision: 0 }))).toBe("stale_listing");
    const far = mk(11, "Far", 50); addItem(w, far, COIN, 10); expect(validateStallPurchase(w, far, stall, req(w, stall))).toBe("out_of_range");
    // no space: fill B's inventory with axes (non-stackable) except the coin slot
    for (let i = 0; i < 15; i++) addItem(w, B, AXE, 1);
    expect(buyFromStall(w, B, stall, req(w, stall))).toBe("no_space");
    void A; void before; expect(stallListing(w, stall, 0)!.stock).toBe(20); expect(countItem(w, B, COIN)).toBe(10); expect(countItem(w, tillOf(w, stall)!, COIN)).toBe(0);
    void snap;
  });
  it("two buyers in one tick are serialized; the second sees the first's result (sold_out)", () => {
    const { w, B, stall, mk } = stocked(); const C = mk(12, "Cy", 1); addItem(w, C, COIN, 20);
    expect(buyFromStall(w, B, stall, req(w, stall, { qty: 3 }))).toBeUndefined();
    expect(buyFromStall(w, C, stall, req(w, stall, { qty: 2 }))).toBe("sold_out");
    expect(buyFromStall(w, C, stall, req(w, stall, { qty: 1 }))).toBeUndefined();
    expect(stallListing(w, stall, 0)!.stock).toBe(0);
  });
  it("executeStallPurchase is reusable inside a caller transaction (rolls back on failure)", () => {
    const { w, B, stall } = stocked(); const till = tillOf(w, stall)!;
    const r = transaction(w, (tx) => { const x = executeStallPurchase(tx, B, stall, till, req(w, stall)); return x.ok ? { ok: false, reason: "caller_abort" } : x; });
    expect(r).toEqual({ ok: false, reason: "caller_abort" }); expect(stallListing(w, stall, 0)!.stock).toBe(20);
  });
  it("stock containers are locked to plain container withdraw; unstock returns goods with provenance", () => {
    const { w, A, stall } = stocked();
    expect(unstockStall(w, A, stall, 0, 5)).toBeUndefined(); expect(listSlots(w, A).find((s) => s.item === PLANK)).toMatchObject({ count: 5, crafterId: 7 });
    expect(openStall(w, A, stall)).toBeUndefined();
    setIntent(w, A, { action: IntentAction.Withdraw, target: stall, item: PLANK, count: 5 }); w.step(1 / 20);
    expect(stallListing(w, stall, 0)!.stock).toBe(15);
  });
  it("ADR-143: browsing a stall lets the owner (not a buyer) view its till; closing drops it", () => {
    const { w, A, B, stall } = stocked(); const till = tillOf(w, stall)!;
    expect(openStall(w, A, stall)).toBeUndefined(); expect(openStall(w, B, stall)).toBeUndefined();
    expect(mod.containerViewersScope(w, stall, 7)).toBe(true); expect(mod.containerViewersScope(w, stall, 9)).toBe(true);
    expect(mod.containerViewersScope(w, till, 7)).toBe(true); expect(mod.containerViewersScope(w, till, 9)).toBe(false);
    expect(mod.closeStall(w, A)).toBeUndefined(); expect(mod.containerViewersScope(w, till, 7)).toBe(false); expect(mod.containerViewersScope(w, stall, 7)).toBe(false);
  });
  it("persistence round trip: header, listings, stock with provenance, till, ledger", () => {
    const { w, B, stall } = stocked(); buyFromStall(w, B, stall, req(w, stall));
    const rev = listingRevision(w, stall);
    const bytes = encodeStructures(w, 0, 0); unloadStructures(w, "0,0" as never);
    const keys = [...(mod.structures(w).chunkPieces.keys())]; for (const k of keys) unloadStructures(w, k);
    const dec = decodeStructures(w, bytes); const s2 = stallOf(w, dec.pieces[0]!)!;
    expect(w.get(s2, StallHeader)).toMatchObject({ ownerKind: 1, ownerId: 7, open: 1, listingCount: 12 });
    expect(listingRevision(w, s2)).toBe(rev); expect(w.getArray(s2, Listings, "priceCount")![0]).toBe(3);
    expect(itemInfo(w, s2, 0)).toMatchObject({ count: 15, crafterId: 7, crafterName: "Ada" });
    expect(countItem(w, tillOf(w, s2)!, COIN)).toBe(3); expect(stallLedger(w, s2)).toHaveLength(1);
    expect(encodeStructures(w, 0, 0)).toEqual(bytes);
  });
  it("destroyed stalls spill stock and till into loot bags (data flag)", () => {
    const { w, B, stall } = stocked(); buyFromStall(w, B, stall, req(w, stall));
    destroyPiece(w, mod.pieceOf(w, stall)!, DestroyCause.Damage);
    const bags = [...w.query([LootBag, Container])]; const all = bags.flatMap((b) => listSlots(w, b));
    expect(all.find((s) => s.item === PLANK)).toMatchObject({ count: 15, crafterId: 7 }); expect(all.find((s) => s.item === COIN)!.count).toBe(3);
    void attachmentsOf;
  });
});

describe("scenario: A crafts iron axes, a clan stall sells one to B for coins", () => {
  it("B's axe shows A's name", () => {
    const { w, perms, mk } = setup(); const A = mk(7, "Ada"); const B = mk(9, "Bo", 1);
    const clan = perms.groups.create(GroupKind.Clan, 7).id; w.setField(A, Membership, "clanId", clan);
    spawnStation(w, StationKind.Anvil, 0.5, 0);
    addItem(w, A, id("hardwood_planks"), 4); addItem(w, A, id("iron_ingot"), 6);
    for (let k = 0; k < 2; k++) { setIntent(w, A, { action: IntentAction.Craft, recipe: d.recipeId("iron_axe") }); steps(w, 100); }
    expect(countItem(w, A, AXE)).toBe(2);
    addItem(w, B, id("copper_ingot"), 1); spawnStation(w, StationKind.Anvil, 1.5, 0);
    setIntent(w, B, { action: IntentAction.Craft, recipe: d.recipeId("coin") }); steps(w, 60);
    expect(countItem(w, B, COIN)).toBe(10); expect(listSlots(w, B).find((s) => s.item === COIN)!.crafterId).toBe(0);
    const stall = placeStall(w, A, "clan_pavilion");
    const axeSlots = listSlots(w, A).filter((s) => s.item === AXE);
    axeSlots.forEach((s, i) => expect(stockStall(w, A, stall, i, s.slot, 1)).toBeUndefined());
    expect(setListing(w, A, stall, 0, { priceItem: COIN, priceCount: 8, qty: 1, enabled: 1 })).toBeUndefined();
    setStallOpen(w, A, stall, 1);
    expect(buyFromStall(w, B, stall, req(w, stall))).toBeUndefined();
    const s = listSlots(w, B).find((x) => x.item === AXE)!;
    expect(itemInfo(w, B, s.slot)).toMatchObject({ itemKey: "iron_axe", crafterId: 7, crafterName: "Ada" });
    expect(countItem(w, B, COIN)).toBe(2); expect(countItem(w, tillOf(w, stall)!, COIN)).toBe(8);
  });
});
