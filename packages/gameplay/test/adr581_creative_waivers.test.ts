// ADR-581: Creative waivers. In a Creative world (ADR-580) a human player:
//  - takes NO damage of any cause through applyDamage (combat, fall, explosion...) — so no
//    broken legs (the fall fracture roll needs hp to actually drop) and no death;
//  - never drains hunger/thirst, holds body temperature at normal, and takes no starvation /
//    dehydration / exposure / drowning damage in vitalsSystem;
//  - crafts free on BOTH craft paths (queued and timed): no ingredient check, nothing
//    consumed, and cancelling a queued craft refunds nothing (no items from thin air);
//  - builds free: validatePlacement never returns CannotAfford and placePiece pays nothing,
//    while claim and support checks still apply; the build menu reports every tier affordable.
// AI humans in the same world get none of this (adr580 pins the identification), and a
// survival world is unchanged — every waiver case below runs with its survival control.
import { describe, expect, it } from "vitest";
import { installPermissions, Membership, PlayerId, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { collect, makeWorld, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs(); const id = (k: string) => d.itemId(k); const axe = d.recipeId("stone_axe");

function player(w: World, pid = 1, x = 0, y = 0): Entity {
  const p = G.spawnPlayer(w, { x, y, maxWeight: 0 });
  if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  w.add(p, PlayerId, { id: pid });
  return p;
}
const hp = (w: World, e: Entity) => w.getField(e, G.Health, "hp")!;
const maxHp = (w: World, e: Entity) => w.getField(e, G.Health, "max")!;

describe("ADR-581 damage and death", () => {
  it("a creative player takes no damage of any cause and never dies; the survival control does", () => {
    const cw = makeWorld({ worldRules: { creative: true } });
    const cp = player(cw);
    for (const cause of [G.DamageCause.Combat, G.DamageCause.Fall, G.DamageCause.Explosion, G.DamageCause.Contact]) {
      G.applyDamage(cw, cp, 9999, 0 as Entity, cause);
      expect(hp(cw, cp)).toBe(maxHp(cw, cp));
    }
    G.deathSystem(cw);
    expect(cw.has(cp, G.Dead)).toBe(false);

    const sw = makeWorld();
    const sp = player(sw);
    G.applyDamage(sw, sp, 25, 0 as Entity, G.DamageCause.Combat);
    expect(hp(sw, sp)).toBe(maxHp(sw, sp) - 25);
    G.applyDamage(sw, sp, 9999, 0 as Entity, G.DamageCause.Fall);
    expect(hp(sw, sp)).toBe(0);
    G.deathSystem(sw);
    expect(sw.has(sp, G.Dead)).toBe(true);
  });

  it("an AI human in a Creative world still takes damage (no waiver for bots)", () => {
    const w = makeWorld({ worldRules: { creative: true } });
    const bot = player(w, 2);
    G.setAiHumanPredicate(w, (e) => e === bot);
    G.applyDamage(w, bot, 25, 0 as Entity, G.DamageCause.Combat);
    expect(hp(w, bot)).toBe(maxHp(w, bot) - 25);
  });
});

describe("ADR-581 vitals", () => {
  it("hunger/thirst pin to full, body temperature holds at normal, starvation never lands", () => {
    const w = makeWorld({ worldRules: { creative: true } });
    const p = player(w);
    w.setField(p, G.Survival, "hunger", 0); w.setField(p, G.Survival, "thirst", 0);
    w.setField(p, G.Survival, "bodyTemp", 26); // freezing body, empty stomach: lethal in survival
    for (let i = 0; i < 10; i++) G.vitalsSystem(w, 1);
    expect(w.getField(p, G.Survival, "hunger")).toBe(100);
    expect(w.getField(p, G.Survival, "thirst")).toBe(100);
    expect(w.getField(p, G.Survival, "bodyTemp")).toBe(d.vitals.bodyTempNormal);
    expect(hp(w, p)).toBe(maxHp(w, p));
  });

  it("the survival control starves: hunger drains and hp falls at zero", () => {
    const w = makeWorld();
    const p = player(w);
    w.setField(p, G.Survival, "hunger", 0); w.setField(p, G.Survival, "thirst", 100);
    const before = hp(w, p);
    for (let i = 0; i < 10; i++) G.vitalsSystem(w, 1);
    expect(hp(w, p)).toBeLessThan(before);
  });
});

describe("ADR-581 free crafting", () => {
  it("queued craft: no ingredients needed, nothing consumed, output still delivered; cancel refunds nothing", () => {
    const w = makeWorld({ worldRules: { creative: true } });
    const p = player(w); const q = G.installCraftQueue(w);
    expect(G.enqueueCraft(w, p, axe, 2)).toBe(0); // empty inventory, still enqueues
    expect(G.countItem(w, p, id("wood"))).toBe(0);
    steps(w, 90);
    expect(G.countItem(w, p, id("stone_axe"))).toBe(2); // both units completed and delivered

    const p2 = player(w, 2, 5, 5);
    expect(G.enqueueCraft(w, p2, axe, 2)).toBe(0);
    expect(q.cancel(p2, 0)).toBe(true);
    expect(G.countItem(w, p2, id("wood"))).toBe(0); // no refund of ingredients never paid
    expect(G.countItem(w, p2, id("stone"))).toBe(0);
    expect(G.countItem(w, p2, id("fiber"))).toBe(0);
  });

  it("queued craft control: a survival player without ingredients is rejected", () => {
    const w = makeWorld();
    const p = player(w); G.installCraftQueue(w);
    expect(G.enqueueCraft(w, p, axe, 1)).toBe("missing_ingredients");
  });

  it("timed craft: starts and completes with an empty inventory", () => {
    const w = makeWorld({ worldRules: { creative: true } });
    const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0 });
    if (!w.isRegistered(PlayerId)) w.register(PlayerId);
    w.add(p, PlayerId, { id: 1 });
    const started = collect(w, G.CraftStarted); const done = collect(w, G.CraftCompleted);
    G.setIntent(w, p, { action: G.IntentAction.Craft, recipe: axe });
    w.step(1 / 20);
    expect(started.length).toBe(1);
    steps(w, 45);
    expect(done.length).toBe(1);
    expect(G.countItem(w, p, id("stone_axe"))).toBe(1);
    expect(G.countItem(w, p, id("wood"))).toBe(0);
  });
});

describe("ADR-581 free building", () => {
  const rig = (creative: boolean) => {
    const w = makeWorld({ worldRules: { creative } });
    const p = player(w, 1, 10.5, 10.5);
    const sn = G.snapPlacement(w, { piece: d.pieceId("foundation")!, x: 12, y: 12, level: 0, rot: 0, tier: 0, variant: 0 });
    if (typeof sn !== "object") throw new Error("snap");
    return { w, p, sn };
  };

  it("validatePlacement: creative never fails on cost; the survival control does", () => {
    const c = rig(true);
    expect(G.validatePlacement(c.w, c.p, c.sn, { ignoreClaim: true, ignoreRange: true })).toBe(0);
    const s = rig(false);
    expect(G.validatePlacement(s.w, s.p, s.sn, { ignoreClaim: true, ignoreRange: true })).toBe(G.BuildFail.CannotAfford);
  });

  it("placePiece: a creative placement pays nothing; a survival placement pays the cost", () => {
    for (const creative of [true, false]) {
      const { w, p, sn } = rig(creative);
      const cost = G.pieceCost(d, sn.def, sn.tier);
      for (const cst of cost) G.addItem(w, p, cst.item, cst.count + 5);
      G.placePiece(w, p, sn);
      for (const cst of cost) expect(G.countItem(w, p, cst.item)).toBe(creative ? cst.count + 5 : 5);
    }
  });

  it("build menu: every costly tier reads affordable for a creative player, not for a survival one", () => {
    const setup = (creative: boolean) => {
      const w = makeWorld({ worldRules: { creative } }); installPermissions(w);
      const names = G.playerNames(w);
      const p = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 });
      if (!w.isRegistered(PlayerId)) w.register(PlayerId);
      w.add(p, PlayerId, { id: 7 }).add(p, Membership, { partyId: 0, clanId: 0 });
      return { w, names, p };
    };
    const c = setup(true);
    const costly = G.buildView({ world: c.w, player: c.p, names: c.names }).find((x) => x.tiers.some((t) => t.cost.length))!;
    expect(costly.tiers.every((t) => t.affordable)).toBe(true);
    const s = setup(false);
    const costlyS = G.buildView({ world: s.w, player: s.p, names: s.names }).find((x) => x.tiers.some((t) => t.cost.length))!;
    expect(costlyS.tiers[0]!.affordable).toBe(false);
  });
});
