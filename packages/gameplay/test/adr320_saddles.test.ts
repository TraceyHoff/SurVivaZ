import { describe, expect, it } from "vitest";
import { NetId, PlayerId, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned } from "./helpers.js";

let nid = 1900;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };
const pid = (w: World, e: Entity, id: number): Entity => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); return e; };
function setup(learned = true): { w: World; p: Entity; id: (k: string) => number; m: Entity } {
  const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = learned ? spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }) : G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 });
  pid(w, p, 7); net(w, p); const m = net(w, G.makeMount(w, "animal_elk", 1, 0, p));
  const d = G.gameplayDefs(w); return { w, p, m, id: (k) => d.itemId(k) };
}
const slotOf = (w: World, e: Entity, item: number): number => G.listSlots(w, e).find((s) => s.item === item)!.slot;
const give = (w: World, p: Entity, id: number): number => { G.addItem(w, p, id, 1); return slotOf(w, p, id); };
const KEYS = ["saddle_leather", "saddle_reinforced", "saddle_iron", "saddle_steel"];

describe("ADR-320 saddles", () => {
  it("four tiers: the basic saddle has 3 slots + defense; slots, defense and durability rise every tier; items + recipes exist", () => {
    expect(G.SADDLES.map((s) => s.item)).toEqual(KEYS); expect(G.SADDLES[0]!.slots).toBe(3); expect(G.SADDLES[0]!.defense).toBeGreaterThan(0);
    for (let i = 1; i < G.SADDLES.length; i++) for (const f of ["slots", "defense", "durability"] as const) expect(G.SADDLES[i]![f]).toBeGreaterThan(G.SADDLES[i - 1]![f]);
    const w = makeWorld(); const d = G.gameplayDefs(w);
    for (const k of KEYS) { const it = d.items.get(d.itemId(k))!; expect(it.maxStack).toBe(1); expect(it.maxDurability).toBeGreaterThan(0); expect([...d.recipes.values()].some((r) => r.output.item === it.id)).toBe(true); }
  });
  it("bareback = no slots, no defense, saddlebag closed; a leather saddle opens a 3-slot bag and adds 10 armor to rider and mount", () => {
    const { w, p, m, id } = setup();
    expect(w.get(m, G.Container)!.slotCount).toBe(0); expect(G.canOpenSaddlebag(w, p, m)).toBe(false); expect(G.saddleArmorOf(w, m)).toBe(0);
    const before = G.armorOf(w, p);
    expect(G.saddleMount(w, p, m, give(w, p, id("saddle_leather")))).toBe(true);
    expect(w.get(m, G.Container)!.slotCount).toBe(3); expect(G.canOpenSaddlebag(w, p, m)).toBe(true); expect(G.countItem(w, p, id("saddle_leather"))).toBe(0);
    expect(G.saddleArmorOf(w, m)).toBe(10); expect(G.armorOf(w, p)).toBe(before); // rider gets it only while riding
    G.rideMount(w, p, m); expect(G.armorOf(w, p)).toBe(before + 10);
    const stranger = net(w, pid(w, spawnLearned(w, { x: 0, y: 0, maxWeight: 0 }), 99)); expect(G.canOpenSaddlebag(w, stranger, m)).toBe(false);
    expect(G.saddleInfo(w, m)).toMatchObject({ tier: 1, slots: 3, defense: 10 });
  });
  it("swapping saddles returns the old one (with its wear); a smaller saddle needs the extra slots emptied; unsaddling needs an empty bag", () => {
    const { w, p, m, id } = setup();
    G.saddleMount(w, p, m, give(w, p, id("saddle_steel"))); expect(w.get(m, G.Container)!.slotCount).toBe(9);
    w.set(m, G.Mount, { saddleDur: 500 });
    G.addItem(w, m, id("apple"), 1);
    for (let i = 0; i < 8; i++) G.addItem(w, m, id(["hay", "wheat", "carrot", "berries", "rope", "leather", "thread", "nails"][i]!), 1);
    const leather = give(w, p, id("saddle_leather"));
    expect(G.checkSaddle(w, p, m, leather)).toBe("bag_too_full");
    expect(G.checkUnsaddle(w, p, m)).toBe("bag_not_empty");
    for (const s of G.listSlots(w, m)) G.removeItem(w, m, s.item, s.count);
    expect(G.listSlots(w, m)).toHaveLength(0);
    expect(G.saddleMount(w, p, m, slotOf(w, p, id("saddle_leather")))).toBe(true);
    expect(w.getField(m, G.Mount, "saddle")).toBe(1); expect(w.get(m, G.Container)!.slotCount).toBe(3);
    const back = G.listSlots(w, p).find((s) => s.item === id("saddle_steel"))!; expect(back).toBeDefined(); expect(back.durability).toBe(500);
    expect(G.unsaddleMount(w, p, m)).toBe(true); expect(w.getField(m, G.Mount, "saddle")).toBe(0); expect(w.get(m, G.Container)!.slotCount).toBe(0);
    expect(G.countItem(w, p, id("saddle_leather"))).toBe(1);
  });
  it("hits wear the saddle; a broken saddle gives no defense; repair needs the Saddlery unlock + materials and restores it", () => {
    const { w, p, m, id } = setup(); G.saddleMount(w, p, m, give(w, p, id("saddle_iron")));
    const dur0 = w.getField(m, G.Mount, "saddleDur")!; G.applyDamage(w, m, 20, p); w.step(1 / 20); expect(w.getField(m, G.Mount, "saddleDur")).toBeLessThan(dur0);
    w.set(m, G.Mount, { saddleDur: 0 }); expect(G.saddleArmorOf(w, m)).toBe(0);
    expect(G.checkRepair(w, p, m)).toBe("cannot_afford");
    for (const c of G.saddleRepairCost(w, id("saddle_iron"))) G.addItem(w, p, c.item, c.count);
    expect(G.repairSaddle(w, p, m)).toBe(true); expect(w.getField(m, G.Mount, "saddleDur")).toBe(G.saddleInfo(w, m)!.max); expect(G.saddleArmorOf(w, m)).toBe(32);
    expect(G.checkRepair(w, p, m)).toBe("not_damaged");
  });
  it("a hit on a rider is split with the mount", () => {
    const { w, p, m } = setup(); G.rideMount(w, p, m);
    const hp0 = w.getField(p, G.Health, "hp")!, mh0 = w.getField(m, G.Health, "hp")!;
    const z = G.spawnPlayer(w, { x: 0.5, y: 0, maxWeight: 0 }); G.applyDamage(w, p, 20, z);
    expect(hp0 - w.getField(p, G.Health, "hp")!).toBeLessThan(20); expect(mh0 - w.getField(m, G.Health, "hp")!).toBeGreaterThan(0);
  });
  it("crafting a saddle needs its Saddlery node (`item:<saddle>`), repair the same node", () => {
    const raw = setup(false); const d = G.gameplayDefs(raw.w);
    const r = [...d.recipes.values()].find((x) => x.output.item === raw.id("saddle_leather"))!;
    expect(G.recipeOutputUnlocked(raw.w, raw.p, r)).toBe(false); expect(G.itemRepairUnlocked(raw.w, raw.p, raw.id("saddle_leather"))).toBe(false);
    const ok = setup(); expect(G.recipeOutputUnlocked(ok.w, ok.p, r)).toBe(true);
    expect(G.unlockRequirement("item:saddle_steel")?.name).toBe("Master Saddler"); expect(G.unlockRequirement("mount:tame")?.name).toBe("Horsemanship");
    void Transform;
  });
});
