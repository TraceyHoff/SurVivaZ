// ADR-446: shared meals at the hearth.
//
// Root cause (audit 2026-11-19, base 8616271): bots eat alone from their own bags. The `eat`
// behavior and `instantChores` fire `eat:<slot>` wherever the bot happens to stand the moment
// hunger drops, and no sensor ever looks at clanmates, the hearth, or the shared store — so two
// hungry clanmates standing by the same campfire with food in the base box still eat alone,
// from their own bags, wherever they are. The first test below pins that behaviour; the rest
// pin the shared meal that replaces it.
import { describe, expect, it } from "vitest";
import { NetId, PlayerId, Transform, installPermissions, scoreBehavior, setTimeOfDay, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import {
  MEAL, bestReadyFood, fillSharedMealSensors, isCookableRaw, isReadyFood, mealDue, seatFor,
  sharedMealBehaviors, type SharedMealSensors,
} from "../src/ai/shared_meal.js";
import { makeWorld, plantClaim, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
const iid = (k: string): number => d.itemId(k);
const pid = (k: string): number => d.pieceId(k);
const BASE = { x: 10, y: 10 };
const FIRE = { x: BASE.x + 3.5, y: BASE.y + 0.5 };
const BOX = { x: BASE.x + 3.5, y: BASE.y + 1.6 };

let nid = 9700;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };

interface Rig { w: World; p: Entity; a: Agent; home: { x: number; y: number } }
function rig(slot = 0): Rig {
  const w = makeWorld({}, 42);
  installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = spawnLearned(w, { x: BASE.x + 1, y: BASE.y + 3.3, maxWeight: 0, clientId: 7 });
  if (w.has(p, PlayerId)) w.set(p, PlayerId, { id: 7 }); else w.add(p, PlayerId, { id: 7 });
  net(w, p);
  const a = G.makeAgent(G.makeAgentIdentity(3, slot, "bot_gatherer"), 1);
  a.bb.set("selfEntity", p);
  setTimeOfDay(w, 12); // day: the midday meal window
  return { w, p, a, home: { ...BASE } };
}
const clanOf = (w: World, e: Entity, clan = 5): void => {
  if (!w.has(e, G.ClanStatus)) w.add(e, G.ClanStatus, { clan, role: 1, goal: 0, goalX: 0, goalY: 0, contrib: 0 });
  else w.set(e, G.ClanStatus, { clan, role: 1, goal: 0, goalX: 0, goalY: 0, contrib: 0 });
};
/** A second bot in the same clan, visible to the rig bot's sensors. */
function clanmate(r: Rig, x: number, y: number): Entity {
  const q = spawnLearned(r.w, { x, y, maxWeight: 0, clientId: 8 });
  if (r.w.has(q, PlayerId)) r.w.set(q, PlayerId, { id: 8 }); else r.w.add(q, PlayerId, { id: 8 });
  net(r.w, q); clanOf(r.w, q);
  clanOf(r.w, r.p);
  return q;
}
const give = (r: Rig, key: string, n = 1): void => { G.addItem(r.w, r.p, iid(key), n); };
const hungry = (r: Rig, hunger = 40): void => { r.w.set(r.p, G.Survival, { hunger, thirst: 100 }); };
const moveBot = (r: Rig, x: number, y: number): void => { r.w.set(r.p, Transform, { x, y }); };
type View = G.AgentWorldView & SharedMealSensors;
/** Hand-built view: a lit-less campfire at FIRE, one clanmate, food already sensed in the bag. */
function viewOf(r: Rig, over: Partial<View> = {}): View {
  const v = { seen: [], home: r.home, playerName: "friend", fire: { id: 1 as Entity, x: FIRE.x, y: FIRE.y, lit: false } } as unknown as View;
  G.fillAgentSensors(r.w, r.p, v);
  return { ...v, clanMembers: [{ id: 99 as Entity, role: 1, contrib: 0 }], clan: { id: 5, role: 1, goal: 0, goalX: 0, goalY: 0, contrib: 0 }, ...over };
}
const out = (): AgentOutput => ({ moveX: 0, moveY: 0, aimX: 0, aimY: 0, sprint: false, actions: [] as string[] });
type Ctx = AgentContext<View>;
const ctxOf = (r: Rig, view: View, tick = 0, phase = "day"): Ctx => {
  const v = G.buildAgentSelf(r.w, r.p, r.a)!;
  return { self: { ...v, tick, phase }, bb: r.a.bb, memory: r.a.memory, traits: r.a.identity.traits, rng: r.a.rng, agent: r.a, world: view };
};
const mealBehavior = () => sharedMealBehaviors()[0]!;
const eatBehavior = () => G.survivalBehaviors().find((b) => b.name === "eat")!;
const score = (b: G.GameBehavior, c: Ctx): number => scoreBehavior(b, c, undefined, []);

/** Place the campfire + starter box the adr252 way (claim, then tryPlace), stock the box. */
function placeHearth(r: Rig, stock: [string, number][] = []): { fire: Entity; box: Entity } {
  plantClaim(r.w, r.p, BASE.x - 2, BASE.y - 2);
  const givePiece = (key: string): void => { const def = d.pieces.get(pid(key))!; for (const c of G.pieceCost(d, def, def.tiered ? 0 : def.fixedTier)) G.addItem(r.w, r.p, c.item, c.count); };
  const put = (key: string, x: number, y: number): Entity => {
    givePiece(key); const def = d.pieces.get(pid(key))!;
    r.w.set(r.p, Transform, { x, y: y + 1.2 });
    const res = G.tryPlace(r.w, r.p, { piece: pid(key), x, y, level: 0, rot: 0, tier: def.fixedTier, variant: 0 });
    expect(res.ok, `place ${key}`).toBe(true);
    if (!res.ok) throw new Error(`place ${key} failed: ${res.reason}`);
    return res.piece;
  };
  const fire = put("campfire", FIRE.x, FIRE.y);
  const box = put("basic_storage_box", BOX.x, BOX.y);
  steps(r.w, 25);
  const store = G.resolveAttachment(r.w, box, G.AttachKind.Storage)!;
  for (const [k, n] of stock) G.addItem(r.w, store, iid(k), n);
  return { fire, box };
}

describe("ADR-446 root cause: bots eat alone from their bags", () => {
  it("a hungry bot with a clanmate at the same hearth eats where it stands, from its own bag", () => {
    const r = rig(); clanmate(r, FIRE.x + 2, FIRE.y + 1);
    give(r, "cooked_meat", 2); hungry(r, 40);
    const v = viewOf(r);
    // No shared-meal sensor exists on the old code path: nothing in the view ever mentions
    // the hearth, the clanmate, or the shared store, and the lone eat fires immediately.
    expect(v.sharedMeal).toBeUndefined();
    const c = ctxOf(r, v);
    expect(score(eatBehavior(), c)).toBeGreaterThan(0);
    const o = out(); eatBehavior().run(c, o);
    expect(o.actions).toEqual([`eat:${v.food}`]);
    expect(Math.hypot(r.home.x - FIRE.x, r.home.y - FIRE.y)).toBeGreaterThan(2); // far from the hearth, still eating
  });
  it("a solo bot keeps eating alone (no clanmates = no shared meal, no regression)", () => {
    const r = rig();
    give(r, "cooked_meat", 2); hungry(r, 40);
    const v = viewOf(r);
    delete v.clanMembers; delete v.clan; // exactOptionalPropertyTypes: absence, not explicit undefined
    fillSharedMealSensors(r.w, r.p, v, r.a);
    expect(v.sharedMeal).toBeUndefined();
    const c = ctxOf(r, v);
    expect(score(eatBehavior(), c)).toBeGreaterThan(0);
  });
});

describe("ADR-446 meal rules (pure)", () => {
  it("ready food is safe food only: seeds have no food, raw meat/fish are cookable not ready", () => {
    expect(isReadyFood(d, iid("cooked_meat"))).toBe(true);
    expect(isReadyFood(d, iid("apple"))).toBe(true);
    expect(isReadyFood(d, iid("berries"))).toBe(true);
    expect(isReadyFood(d, iid("wheat_seeds"))).toBe(false); // no food at all: the seed stock can never be eaten
    expect(isReadyFood(d, iid("raw_meat"))).toBe(false); // health -5: never eaten raw at a meal
    expect(isReadyFood(d, iid("fish"))).toBe(false);
    expect(isReadyFood(d, iid("wood"))).toBe(false); // fuel is never food
    expect(isCookableRaw(d, iid("raw_meat"))).toBe(true);
    expect(isCookableRaw(d, iid("fish"))).toBe(true);
    expect(isCookableRaw(d, iid("potato"))).toBe(true); // baked_potato: a single-ingredient campfire roast
    expect(isCookableRaw(d, iid("flour"))).toBe(false); // stew/pie ingredient, not a roast on its own
    expect(isCookableRaw(d, iid("cooked_meat"))).toBe(false);
  });
  it("bestReadyFood picks the most filling food, ties break by lowest id (deterministic)", () => {
    expect(bestReadyFood(d, new Map([[iid("apple"), 3], [iid("cooked_meat"), 1]]))?.item).toBe(iid("cooked_meat"));
    expect(bestReadyFood(d, new Map([[iid("wheat_seeds"), 9]]))).toBeUndefined();
    expect(bestReadyFood(d, new Map())).toBeUndefined();
  });
  it("mealDue: hungry bots gather at any non-night phase; dusk pulls peckish bots; night does not", () => {
    expect(mealDue(0.4, "day", 0, -1e9)).toBe(true);
    expect(mealDue(0.4, "dawn", 0, -1e9)).toBe(true);
    expect(mealDue(0.4, "night", 0, -1e9)).toBe(false); // sleep owns the night unless starving
    expect(mealDue(0.15, "night", 0, -1e9)).toBe(true); // critical hunger beats sleep
    expect(mealDue(0.7, "dusk", 0, -1e9)).toBe(true); // the evening meal: peckish is enough at dusk
    expect(mealDue(0.7, "day", 0, -1e9)).toBe(false);
    expect(mealDue(0.9, "dusk", 0, -1e9)).toBe(false);
    expect(mealDue(0.4, "day", 100, 0)).toBe(false); // just ate: the cooldown holds
    expect(mealDue(0.4, "day", MEAL.mealCooldownTicks + 1, 0)).toBe(true);
  });
  it("seatFor puts each bot on its own ring seat around the fire (deterministic per bot)", () => {
    const s0 = seatFor("bot-3-0", FIRE); const s1 = seatFor("bot-3-1", FIRE);
    for (const s of [s0, s1]) expect(Math.hypot(s.x - FIRE.x, s.y - FIRE.y)).toBeCloseTo(MEAL.seatRing, 6);
    expect(s0).not.toEqual(s1);
    expect(seatFor("bot-3-0", FIRE)).toEqual(s0);
  });
});

describe("ADR-446 sensor: a meal is pending only with a hearth, a mate, and food to share", () => {
  it("hungry + clanmate + hearth + bag food -> meal pending, not yet at the hearth", () => {
    const r = rig(); clanmate(r, FIRE.x + 2, FIRE.y + 1);
    give(r, "cooked_meat", 2); hungry(r, 40);
    const v = viewOf(r);
    fillSharedMealSensors(r.w, r.p, v, r.a);
    expect(v.sharedMeal).toBeDefined();
    expect(v.sharedMeal!.atHearth).toBe(false);
    expect(v.sharedMeal!.mates).toBe(1);
    expect(v.sharedMeal!.cook).toBe(false);
    expect(Math.hypot(v.sharedMeal!.seat.x - FIRE.x, v.sharedMeal!.seat.y - FIRE.y)).toBeCloseTo(MEAL.seatRing, 6);
  });
  it("no hearth -> no meal; no mates -> no meal; fed -> no meal", () => {
    const r = rig(); clanmate(r, FIRE.x + 2, FIRE.y + 1);
    give(r, "cooked_meat", 2); hungry(r, 40);
    const noFire = viewOf(r);
    delete noFire.fire;
    fillSharedMealSensors(r.w, r.p, noFire, r.a); expect(noFire.sharedMeal).toBeUndefined();
    const noMate = viewOf(r);
    delete noMate.clanMembers; delete noMate.clan; delete noMate.partyMates;
    fillSharedMealSensors(r.w, r.p, noMate, r.a); expect(noMate.sharedMeal).toBeUndefined();
    const fed = viewOf(r); r.w.set(r.p, G.Survival, { hunger: 95, thirst: 100 });
    fillSharedMealSensors(r.w, r.p, fed, r.a); expect(fed.sharedMeal).toBeUndefined();
  });
  it("party mates count as company too (no clan needed)", () => {
    const r = rig();
    give(r, "cooked_meat", 2); hungry(r, 40);
    const v = viewOf(r, { partyMates: [{ id: 99 as Entity, x: FIRE.x, y: FIRE.y }] });
    delete v.clanMembers; delete v.clan; // party mates only: no clan at all
    fillSharedMealSensors(r.w, r.p, v, r.a);
    expect(v.sharedMeal?.mates).toBe(1);
  });
  it("a bot with no bag food but food in the shared store gets a withdraw target, not an empty meal", () => {
    const r = rig(); clanmate(r, FIRE.x + 2, FIRE.y + 1);
    placeHearth(r, [["cooked_meat", 5]]); hungry(r, 40);
    const v = viewOf(r);
    fillSharedMealSensors(r.w, r.p, v, r.a);
    expect(v.sharedMeal?.store?.item).toBe(iid("cooked_meat"));
    expect(v.sharedMeal?.store?.count).toBe(5);
    expect(v.sharedMeal?.cook).toBe(false);
  });
  it("the reserve holds: a store at exactly the reserve is not withdrawn from unless the bot is starving", () => {
    const r = rig(); clanmate(r, FIRE.x + 2, FIRE.y + 1);
    placeHearth(r, [["cooked_meat", MEAL.reserve]]);
    moveBot(r, BASE.x + 1, BASE.y + 3.3); // back home: placeHearth leaves the bot standing by the box
    hungry(r, 40);
    const v = viewOf(r);
    fillSharedMealSensors(r.w, r.p, v, r.a);
    expect(v.sharedMeal).toBeDefined();
    expect(v.sharedMeal?.store).toBeUndefined(); // 2 portions stay for survival
    hungry(r, 15); // critical: survival beats the reserve
    const v2 = viewOf(r);
    fillSharedMealSensors(r.w, r.p, v2, r.a);
    expect(v2.sharedMeal?.store?.item).toBe(iid("cooked_meat"));
  });
  it("surplus in the bag is earmarked for the store (keep two portions); seeds never are", () => {
    const r = rig(); clanmate(r, FIRE.x + 2, FIRE.y + 1);
    placeHearth(r); give(r, "cooked_meat", 5); give(r, "wheat_seeds", 9); hungry(r, 40);
    const v = viewOf(r);
    fillSharedMealSensors(r.w, r.p, v, r.a);
    expect(v.sharedMeal?.deposit?.item).toBe(iid("cooked_meat"));
    expect(v.sharedMeal?.deposit?.count).toBe(3); // 5 - keep 2
    expect(v.sharedMeal?.deposit?.item).not.toBe(iid("wheat_seeds"));
  });
  it("only raw meat and no ready food anywhere -> this bot is the cook, and it does not eat raw", () => {
    const r = rig(); clanmate(r, FIRE.x + 2, FIRE.y + 1);
    placeHearth(r); give(r, "raw_meat", 3); hungry(r, 40);
    const v = viewOf(r);
    // the placed campfire is the bot's Campfire station (what fillPlanSensors scans into view.bs)
    v.bs = { stations: new Map([[G.StationKind.Campfire, { id: 1 as Entity, x: FIRE.x, y: FIRE.y, fired: true, lit: false, fuelTicks: 0 }]]) } as unknown as NonNullable<View["bs"]>;
    fillSharedMealSensors(r.w, r.p, v, r.a);
    expect(v.sharedMeal?.cook).toBe(true);
    expect(v.sharedMeal?.store).toBeUndefined();
  });
  it("an empty hearth does not strand the bot: the meal clears and the bot goes back to finding food", () => {
    const r = rig(); clanmate(r, FIRE.x + 2, FIRE.y + 1);
    placeHearth(r); hungry(r, 40);
    moveBot(r, FIRE.x, FIRE.y);
    const v = viewOf(r);
    fillSharedMealSensors(r.w, r.p, v, r.a);
    expect(v.sharedMeal).toBeUndefined(); // nothing to eat, nothing to cook: no meal to wait for
    expect(r.a.bb.num("mealEmptyAt", -1)).toBeGreaterThan(-1);
    const v2 = viewOf(r); // still suppressed while the retry window holds
    fillSharedMealSensors(r.w, r.p, v2, r.a);
    expect(v2.sharedMeal).toBeUndefined();
  });
});

describe("ADR-446 behavior: gather first, share, then eat together", () => {
  it("away from the hearth the meal out-scores lone eating and walks to its seat (no eat action)", () => {
    const r = rig(); clanmate(r, FIRE.x + 2, FIRE.y + 1);
    give(r, "cooked_meat", 2); hungry(r, 40);
    const v = viewOf(r);
    fillSharedMealSensors(r.w, r.p, v, r.a);
    expect(v.sharedMeal?.nearHearth).toBe(true); // a short walk from home: lone eating stops here
    expect(v.sharedMeal?.suppressLoneEat).toBe(true);
    const c = ctxOf(r, v);
    expect(score(mealBehavior(), c)).toBeGreaterThan(score(eatBehavior(), c));
    expect(score(eatBehavior(), c)).toBe(0); // lone eating is suppressed while the meal waits
    const o = out(); mealBehavior().run(c, o);
    expect(o.actions).toEqual([]);
    expect(Math.hypot(o.moveX, o.moveY)).toBeGreaterThan(0);
    // and the movement heads for the seat, not away from it
    const before = Math.hypot(v.sharedMeal!.seat.x - c.self.x, v.sharedMeal!.seat.y - c.self.y);
    const after = Math.hypot(v.sharedMeal!.seat.x - (c.self.x + o.moveX), v.sharedMeal!.seat.y - (c.self.y + o.moveY));
    expect(after).toBeLessThan(before);
  });
  it("at the hearth the bot eats from its bag and waves at its mates", () => {
    const r = rig(); clanmate(r, FIRE.x + 2, FIRE.y + 1);
    give(r, "cooked_meat", 2); hungry(r, 40);
    const seat = seatFor(r.a.identity.id, FIRE);
    moveBot(r, seat.x, seat.y);
    const v = viewOf(r);
    fillSharedMealSensors(r.w, r.p, v, r.a);
    expect(v.sharedMeal?.atHearth).toBe(true);
    const c = ctxOf(r, v);
    const o = out(); expect(mealBehavior().run(c, o)).toBe(false);
    expect(o.actions).toEqual([`eat:${v.food}`]);
    expect(o.emote).toBe("wave");
    expect(r.a.bb.num("mealAt", -1)).toBe(0);
  });
  it("two bots at the same hearth get different seats and both eat there", () => {
    const r = rig(0); const q = clanmate(r, FIRE.x + 2, FIRE.y + 1);
    give(r, "cooked_meat", 2); hungry(r, 40);
    const a2 = G.makeAgent(G.makeAgentIdentity(3, 1, "bot_gatherer"), 1);
    a2.bb.set("selfEntity", q);
    G.addItem(r.w, q, iid("cooked_meat"), 2); r.w.set(q, G.Survival, { hunger: 40, thirst: 100 });
    const s0 = seatFor(r.a.identity.id, FIRE); const s1 = seatFor(a2.identity.id, FIRE);
    expect(s0).not.toEqual(s1);
    for (const [a, e, seat] of [[r.a, r.p, s0], [a2, q, s1]] as const) {
      r.w.set(e, Transform, { x: seat.x, y: seat.y });
      const v = { seen: [], home: r.home, playerName: "friend", fire: { id: 1 as Entity, x: FIRE.x, y: FIRE.y, lit: false } } as unknown as View;
      G.fillAgentSensors(r.w, e, v);
      v.clanMembers = [{ id: e === r.p ? q : r.p, role: 1, contrib: 0 }];
      v.clan = { id: 5, role: 1, goal: 0, goalX: 0, goalY: 0, contrib: 0 };
      fillSharedMealSensors(r.w, e, v, a);
      expect(v.sharedMeal?.atHearth).toBe(true);
      const self = G.buildAgentSelf(r.w, e, a)!;
      const c: Ctx = { self: { ...self, tick: 0, phase: "day" }, bb: a.bb, memory: a.memory, traits: a.identity.traits, rng: a.rng, agent: a, world: v };
      const o = out(); mealBehavior().run(c, o);
      expect(o.actions).toEqual([`eat:${v.food}`]);
    }
  });
  it("a foodless bot at the hearth withdraws exactly one portion from the shared store, then eats it", () => {
    const r = rig(); clanmate(r, FIRE.x + 2, FIRE.y + 1);
    placeHearth(r, [["cooked_meat", 5]]); hungry(r, 40);
    moveBot(r, BOX.x, BOX.y); // by the box and the fire: at the hearth and in container reach
    const v = viewOf(r);
    fillSharedMealSensors(r.w, r.p, v, r.a);
    expect(v.sharedMeal?.atHearth).toBe(true);
    expect(v.sharedMeal?.store?.item).toBe(iid("cooked_meat"));
    // open -> withdraw 1 -> close (CONTAINER_STEP ticks apart)
    let c = ctxOf(r, v, 0); let o = out(); mealBehavior().run(c, o);
    expect(o.actions[0]?.startsWith("copen:")).toBe(true);
    c = ctxOf(r, v, 10); o = out(); mealBehavior().run(c, o);
    expect(o.actions[0]).toMatch(/^cwithdraw:\d+:\d+:1$/);
    c = ctxOf(r, v, 20); o = out(); mealBehavior().run(c, o);
    expect(o.actions).toEqual(["cclose"]);
    // the server applies the withdraw (one cooked_meat lands in the bag); next sense tick the bot eats it
    G.addItem(r.w, r.p, iid("cooked_meat"), 1);
    const v2 = viewOf(r);
    fillSharedMealSensors(r.w, r.p, v2, r.a);
    expect(v2.sharedMeal?.atHearth).toBe(true);
    c = ctxOf(r, v2, 30); o = out(); mealBehavior().run(c, o);
    expect(o.actions).toEqual([`eat:${v2.food}`]);
  });
  it("a bot with surplus deposits it before eating (the store gains, the bag keeps two)", () => {
    const r = rig(); clanmate(r, FIRE.x + 2, FIRE.y + 1);
    placeHearth(r); give(r, "cooked_meat", 5); hungry(r, 40);
    moveBot(r, BOX.x, BOX.y); // by the box and the fire: at the hearth and in container reach
    const v = viewOf(r);
    fillSharedMealSensors(r.w, r.p, v, r.a);
    expect(v.sharedMeal?.deposit?.count).toBe(3);
    let c = ctxOf(r, v, 0); let o = out(); mealBehavior().run(c, o);
    expect(o.actions[0]?.startsWith("copen:")).toBe(true);
    c = ctxOf(r, v, 10); o = out(); mealBehavior().run(c, o);
    expect(o.actions[0]).toMatch(/^cdeposit:\d+:\d+:3$/);
  });
  it("the cook waits at the hearth instead of eating raw (the planner's cook pre-goal does the cooking)", () => {
    const r = rig(); clanmate(r, FIRE.x + 2, FIRE.y + 1);
    placeHearth(r); give(r, "raw_meat", 3); hungry(r, 40);
    const seat = seatFor(r.a.identity.id, FIRE);
    moveBot(r, seat.x, seat.y);
    const v = viewOf(r);
    v.bs = { stations: new Map([[G.StationKind.Campfire, { id: 1 as Entity, x: FIRE.x, y: FIRE.y, fired: true, lit: false, fuelTicks: 0 }]]) } as unknown as NonNullable<View["bs"]>;
    fillSharedMealSensors(r.w, r.p, v, r.a);
    expect(v.sharedMeal?.cook).toBe(true);
    const c = ctxOf(r, v);
    const o = out(); mealBehavior().run(c, o);
    expect(o.actions).toEqual([]); // no eat:<raw> — raw meat is never meal food
    expect(o.moveX).toBe(0); expect(o.moveY).toBe(0); // stays by the fire
  });
  it("a stuck walk to the hearth snoozes the meal and lone eating resumes", () => {
    const r = rig(); clanmate(r, FIRE.x + 2, FIRE.y + 1);
    give(r, "cooked_meat", 2); hungry(r, 40);
    const v = viewOf(r);
    fillSharedMealSensors(r.w, r.p, v, r.a);
    // same spot, ticks 0 then 61: stuckOn fires on the second run (STUCK_TICKS = 60)
    let c = ctxOf(r, v, 0); let o = out(); mealBehavior().run(c, o);
    expect(o.actions).toEqual([]);
    c = ctxOf(r, v, 61); o = out(); mealBehavior().run(c, o);
    expect(r.a.bb.num("mealSnoozeUntil", -1)).toBeGreaterThan(61);
    const v2 = viewOf(r);
    fillSharedMealSensors(r.w, r.p, v2, r.a);
    expect(v2.sharedMeal).toBeUndefined(); // snoozed: the bot may eat alone again rather than starve walking
    expect(score(eatBehavior(), ctxOf(r, v2, 61))).toBeGreaterThan(0);
  });
  it("instantChores does not eat alone while a meal is pending away from the hearth", () => {
    const r = rig(); clanmate(r, FIRE.x + 2, FIRE.y + 1);
    give(r, "cooked_meat", 2); hungry(r, 40);
    const v = viewOf(r);
    fillSharedMealSensors(r.w, r.p, v, r.a);
    const c = ctxOf(r, v);
    const o = out();
    G.instantChores(c as never, o);
    expect(o.actions.filter((a) => a.startsWith("eat:"))).toEqual([]);
  });
  it("far from the hearth (expedition) lone eating is NOT suppressed: a working bot never starves for dinner", () => {
    const r = rig(); clanmate(r, FIRE.x + 2, FIRE.y + 1);
    give(r, "cooked_meat", 2); hungry(r, 40);
    moveBot(r, FIRE.x + 30, FIRE.y); // 30 tiles out: the walk home is not a meal, it is an expedition
    const v = viewOf(r);
    fillSharedMealSensors(r.w, r.p, v, r.a);
    expect(v.sharedMeal).toBeDefined(); // the meal is still pending for when the bot comes home
    expect(v.sharedMeal?.nearHearth).toBe(false);
    expect(v.sharedMeal?.suppressLoneEat).toBe(false);
    expect(score(eatBehavior(), ctxOf(r, v))).toBeGreaterThan(0);
    expect(score(mealBehavior(), ctxOf(r, v))).toBe(0); // and the meal behavior does not drag it home
    const o = out();
    G.instantChores(ctxOf(r, v) as never, o);
    expect(o.actions.filter((a) => a.startsWith("eat:"))).toEqual([`eat:${v.food}`]);
  });
  it("a starving bot near the hearth eats alone right now: survival beats the meal", () => {
    const r = rig(); clanmate(r, FIRE.x + 2, FIRE.y + 1);
    give(r, "cooked_meat", 2); hungry(r, 15); // critical: below MEAL.criticalBelow
    const v = viewOf(r);
    fillSharedMealSensors(r.w, r.p, v, r.a);
    expect(v.sharedMeal).toBeDefined();
    expect(v.sharedMeal?.suppressLoneEat).toBe(false);
    expect(score(eatBehavior(), ctxOf(r, v))).toBeGreaterThan(0);
  });
});

describe("ADR-446 wiring: the meal is in the real view and the real registry", () => {
  it("buildAgentView sets sharedMeal for a hungry clan bot with a placed hearth and box", () => {
    const r = rig(); const q = clanmate(r, FIRE.x + 2, FIRE.y + 1);
    void q;
    placeHearth(r, [["cooked_meat", 5]]);
    give(r, "cooked_meat", 2); hungry(r, 40);
    moveBot(r, BASE.x + 1, BASE.y + 3.3);
    const built = G.buildAgentView(r.w, r.p, r.a, r.home);
    expect(built).toBeDefined();
    expect(built!.world.sharedMeal).toBeDefined();
    expect(built!.world.sharedMeal!.mates).toBeGreaterThanOrEqual(1);
    expect(built!.world.sharedMeal!.fire.x).toBeCloseTo(FIRE.x, 6);
  });
  it("survivorRegistry contains shared_meal and it out-scores eat on a pending meal", () => {
    const r = rig(); clanmate(r, FIRE.x + 2, FIRE.y + 1);
    give(r, "cooked_meat", 2); hungry(r, 40);
    const v = viewOf(r);
    fillSharedMealSensors(r.w, r.p, v, r.a);
    const c = ctxOf(r, v);
    const reg = G.survivorRegistry();
    const meal = reg.get("shared_meal"); const eat = reg.get("eat");
    expect(meal).toBeDefined(); expect(eat).toBeDefined();
    expect(score(meal!, c)).toBeGreaterThan(score(eat!, c));
  });
  it("a dusk meal pulls a peckish bot (hunger 0.7) to the hearth; midday does not", () => {
    const r = rig(); clanmate(r, FIRE.x + 2, FIRE.y + 1);
    give(r, "cooked_meat", 2);
    r.w.set(r.p, G.Survival, { hunger: 70, thirst: 100 });
    // Sunset is season-dependent (day 0 ≈ 20:30), so find dusk / day by probing the phase, not the clock.
    const hourFor = (want: string): number => {
      for (let h = 0; h < 24; h += 0.5) { setTimeOfDay(r.w, h); if (G.currentPhaseKey(r.w) === want) return h; }
      throw new Error(`no ${want} hour found`);
    };
    setTimeOfDay(r.w, hourFor("dusk"));
    const dusk = viewOf(r);
    fillSharedMealSensors(r.w, r.p, dusk, r.a);
    expect(dusk.sharedMeal).toBeDefined();
    setTimeOfDay(r.w, hourFor("day"));
    const day = viewOf(r);
    fillSharedMealSensors(r.w, r.p, day, r.a);
    expect(day.sharedMeal).toBeUndefined();
  });
});
