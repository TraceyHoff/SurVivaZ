// ADR-343: resource expeditions for AI humans (ai/travel.ts): a bot whose plan needs an item no known node near
// home yields prospects the seeded world for the nearest node of that kind and travels to it (a round trip), instead
// of wandering 18-36 tiles on the local trip and snoozing the goal. Bottlenecks found: the gather sensor only sees
// agent memory (sightRange 12, memorySeconds 20); the trip caps at 36 tiles / 3600 ticks; travel explore is random
// and never resource-directed; off-screen bots never perceive, so a far trip only ends in gathering when the
// destination IS the resource. Non-bottlenecks (verified, unchanged): goalTimeoutTicks 72000 (a 1200-tile leg is
// ~9k ticks off-screen), offscreen speeds, poiSearchTiles (POIs, not resources), homeMaxDist 48 (trips keep home
// via the corridor — now measured to the leg segment).
import { describe, expect, it } from "vitest";
import { installPermissions, NetId, PlayerId, scoreBehavior, Transform, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import { ProceduralGenerator } from "@engine/world";
import * as G from "../src/index.js";
import { aiMemoryOf } from "../src/ai/planner.js";
import { DT, makeWorld, spawnLearned } from "./helpers.js";

const T = G.TRAVEL;
const D = G.defaultDefs();
const IRON_ORE = D.itemId("iron_ore");
const WOOD = D.itemId("wood");
const STONE = D.itemId("stone");
const FIBER = D.itemId("fiber");
const IRON_VEIN = D.resourceId("iron_vein");
const COPPER_VEIN = D.resourceId("copper_vein");
let nid = 9100;
interface Rig { w: World; p: Entity; a: Agent; home: { x: number; y: number } }
function rig(opts: { seed?: number; slot?: number; x?: number; y?: number } = {}): Rig {
  const w = makeWorld({}, opts.seed ?? 42); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const x = opts.x ?? 0, y = opts.y ?? 0; const p = spawnLearned(w, { x, y, maxWeight: 0, clientId: 7 }); w.add(p, PlayerId, { id: 7 + (opts.slot ?? 0) }); w.add(p, NetId, { id: ++nid });
  const a = G.makeAgent(G.makeAgentIdentity(3, opts.slot ?? 0, "bot_gatherer"), 1);
  return { w, p, a, home: { x, y } };
}
type Mem = { travel?: G.TravelState; travelAt?: number; roamSince?: number; base?: { x: number; y: number }; resourceNeed?: { items: number[]; at: number }; resourceBanned?: { x: number; y: number; at: number }[]; resourceReturn?: boolean; spawnOff?: boolean };
const mem = (r: Rig): Mem => aiMemoryOf(r.a) as unknown as Mem;
type Ctx = AgentContext<G.AgentWorldView>;
const ctxOf = (r: Rig): Ctx => { const v = G.buildAgentView(r.w, r.p, r.a, r.home)!; return { self: v.self, bb: r.a.bb, memory: r.a.memory, traits: r.a.identity.traits, rng: r.a.rng, agent: r.a, world: v.world }; };
const pos = (r: Rig): { x: number; y: number } => r.w.get(r.p, Transform)!;
function move(r: Rig, o: AgentOutput): void {
  let bits = 0; const len = Math.hypot(o.moveX, o.moveY);
  if (len > 1e-6) { if (o.moveX > 0.38 * len) bits |= G.GameplayActions.MoveRight; else if (o.moveX < -0.38 * len) bits |= G.GameplayActions.MoveLeft; if (o.moveY > 0.38 * len) bits |= G.GameplayActions.MoveDown; else if (o.moveY < -0.38 * len) bits |= G.GameplayActions.MoveUp; }
  G.applyMovementInput(r.w, r.p, bits, DT);
}
const fed = (r: Rig): void => { r.w.set(r.p, G.Survival, { hunger: 100, thirst: 100 }); };
/** Drive the off-screen sim until the trip ends (or the cap): returns the last step result. */
function offscreenUntil(r: Rig, cap = 1200): "arrived" | "moved" | "idle" {
  let s: "arrived" | "moved" | "idle" = "idle";
  for (let i = 0; i < cap; i++) { s = G.offscreenStep(r.w, r.p, r.a, T.offscreen.stepTicks); if (s === "arrived") break; }
  return s;
}

describe("ADR-343 nodesInChunk agrees with load()", () => {
  it("same placements as the chunk the server spawns (seed 42 + seed 7, origin + far chunks)", () => {
    for (const seed of [42, 7]) {
      const g = new ProceduralGenerator({ seed });
      for (const [cx, cy] of [[0, 0], [0, 1], [-2, 3], [62, 0], [-40, -40], [5, -7]] as const) {
        expect(g.nodesInChunk(cx, cy)).toEqual(g.load(cx, cy).nodes);
      }
    }
  });
});

describe("ADR-343 prospecting", () => {
  it("finds the nearest placed node, and a far one when it is the only source", () => {
    const r = rig();
    G.spawnResourceNode(r.w, "iron_vein", 800.5, 0.5);
    expect(G.prospectResource(r.w, 0, 0, new Set([IRON_VEIN]))).toEqual({ x: 800.5, y: 0.5, kind: IRON_VEIN });
    G.spawnResourceNode(r.w, "iron_vein", 300.5, 0.5);
    expect(G.prospectResource(r.w, 0, 0, new Set([IRON_VEIN]))).toEqual({ x: 300.5, y: 0.5, kind: IRON_VEIN });
  });
  it("skips a depleted placed node and falls back to the seeded generator (deterministic, a real generated node)", () => {
    const r = rig();
    const n = G.spawnResourceNode(r.w, "iron_vein", 800.5, 0.5);
    r.w.set(n, G.ResourceNode, { amount: 0 });
    const hit = G.prospectResource(r.w, 0, 0, new Set([IRON_VEIN]))!;
    expect(hit.kind).toBe(IRON_VEIN); expect(hit).not.toEqual({ x: 800.5, y: 0.5, kind: IRON_VEIN });
    expect(Math.hypot(hit.x, hit.y)).toBeLessThanOrEqual(T.prospectMaxTiles);
    // the hit is a real generated node: its chunk's placement list contains it
    const gen = new ProceduralGenerator({ seed: 42 });
    const nodes = gen.nodesInChunk(Math.floor((hit.x - 0.5) / 32), Math.floor((hit.y - 0.5) / 32));
    expect(nodes.some((p) => p.tx + 0.5 === hit.x && p.ty + 0.5 === hit.y && p.kind === IRON_VEIN)).toBe(true);
    // deterministic: same world again, and a fresh identical world, agree
    expect(G.prospectResource(r.w, 0, 0, new Set([IRON_VEIN]))).toEqual(hit);
    const r2 = rig();
    expect(G.prospectResource(r2.w, 0, 0, new Set([IRON_VEIN]))).toEqual(hit);
  });
  it("returns undefined for a kind the generator never places (copper is not in its bands)", () => {
    const r = rig();
    expect(G.prospectResource(r.w, 0, 0, new Set([COPPER_VEIN]))).toBeUndefined();
  });
  it("resourceKindsFor maps items to the node kinds that yield them (and nothing for a crafted item)", () => {
    // iron_ore: iron_vein (1.0) and chromite_vein (0.4) both yield it
    expect(G.resourceKindsFor(D, [IRON_ORE])).toEqual(new Set([IRON_VEIN, D.resourceId("chromite_vein")]));
    expect(G.resourceKindsFor(D, [WOOD])).toEqual(new Set(["tree", "fallen_branches", "resin_tree", "pine_tree", "birch_tree", "willow_tree", "palm_tree", "fallen_log", "mossy_log", "tree_stump"].map((k) => D.resourceId(k))));
    expect(G.resourceKindsFor(D, [D.itemId("bronze_ingot")])).toEqual(new Set());
  });
});

describe("ADR-343 goal selection", () => {
  it("a free bot with a fresh need picks a resource goal to the far node (not a random explore)", () => {
    const r = rig();
    G.spawnResourceNode(r.w, "iron_vein", 800.5, 0.5);
    mem(r).resourceNeed = { items: [IRON_ORE], at: r.w.tick };
    const g = G.pickTravelGoal(r.w, r.p, r.a, r.home, false)!;
    expect(g.kind).toBe("resource"); expect(g).toMatchObject({ x: 800.5, y: 0.5 }); expect(g.items).toEqual([IRON_ORE]);
    expect(Math.hypot(g.x, g.y)).toBeGreaterThan(600);
  });
  it("no expedition when the nearest source is inside resourceMinTiles (the local trip's job)", () => {
    const r = rig();
    G.spawnResourceNode(r.w, "iron_vein", 30.5, 0.5);
    mem(r).resourceNeed = { items: [IRON_ORE], at: r.w.tick };
    expect(G.pickTravelGoal(r.w, r.p, r.a, r.home, false)!.kind).not.toBe("resource");
  });
  it("a stale need launches nothing", () => {
    const r = rig();
    G.spawnResourceNode(r.w, "iron_vein", 800.5, 0.5);
    mem(r).resourceNeed = { items: [IRON_ORE], at: r.w.tick - T.resourceNeedTtlTicks - 1 };
    expect(G.pickTravelGoal(r.w, r.p, r.a, r.home, false)!.kind).not.toBe("resource");
  });
  it("a failed destination is banned and the next prospect goes to the next-nearest source", () => {
    const r = rig();
    G.spawnResourceNode(r.w, "iron_vein", 800.5, 0.5);
    G.spawnResourceNode(r.w, "iron_vein", 1000.5, 0.5);
    mem(r).resourceNeed = { items: [IRON_ORE], at: r.w.tick };
    const g1 = G.pickTravelGoal(r.w, r.p, r.a, r.home, false)!;
    expect(g1).toMatchObject({ kind: "resource", x: 800.5, y: 0.5 });
    mem(r).travel = { ...g1 }; G.endTravel(r.a, r.w.tick, false); // unreachable / timed out
    expect(mem(r).resourceBanned).toEqual([{ x: 800.5, y: 0.5, at: r.w.tick }]);
    const g2 = G.pickTravelGoal(r.w, r.p, r.a, r.home, false)!;
    expect(g2).toMatchObject({ kind: "resource", x: 1000.5, y: 0.5 });
  });
  it("clan-stay bots and hired workers get no expedition", () => {
    const r = rig();
    G.spawnResourceNode(r.w, "iron_vein", 800.5, 0.5);
    mem(r).resourceNeed = { items: [IRON_ORE], at: r.w.tick };
    r.w.add(r.p, G.ClanStatus, { clan: 5, role: 1, goal: 0, goalX: 0, goalY: 0, contrib: 0 });
    Object.assign(r.a.identity.traits, { bravery: 0, sociability: 1, industriousness: 0, greed: 0 });
    expect(G.travelMode(r.w, r.p, r.a)).toBe("stay");
    const stay = G.pickTravelGoal(r.w, r.p, r.a, r.home, false)!;
    expect(stay.kind).toBe("explore"); expect(Math.hypot(stay.x, stay.y)).toBeLessThanOrEqual(T.clanStayRadius + 1);
    const r2 = rig({ slot: 1 });
    G.spawnResourceNode(r2.w, "iron_vein", 800.5, 0.5);
    mem(r2).resourceNeed = { items: [IRON_ORE], at: r2.w.tick };
    r2.w.add(r2.p, G.Worker, { owner: 7, homeX: 0, homeY: 0 } as never);
    expect(G.travelMode(r2.w, r2.p, r2.a)).toBe("worker");
    expect(G.pickTravelGoal(r2.w, r2.p, r2.a, r2.home, false)).toBeUndefined();
  });
  it("noteTripWanted records the unmet need for the travel layer and clears it when the plan needs nothing", () => {
    const r = rig();
    const view = { base: { x: 0, y: 0 } } as unknown as G.AgentWorldView;
    G.noteTripWanted(view, new Set([IRON_ORE]), false, r.a, 5);
    expect(mem(r).resourceNeed).toEqual({ items: [IRON_ORE], at: 5 });
    expect(view.tripWanted).toBe(true);
    G.noteTripWanted(view, new Set([WOOD]), true, r.a, 6); // a known node: no new expedition, the record stands
    expect(mem(r).resourceNeed).toEqual({ items: [IRON_ORE], at: 5 });
    G.noteTripWanted(view, new Set(), false, r.a, 7);
    expect(mem(r).resourceNeed).toBeUndefined();
  });
});

describe("ADR-343 long-range travel to a distant resource", () => {
  it("a 1200-tile region route plans, even around a lake wall", () => {
    const r = rig();
    const route = G.planRegionRoute(r.w, 0, 0, 1200, 0);
    expect(route).toBeDefined(); expect(route!.at(-1)).toEqual({ x: 1200, y: 0 });
    for (let ry = -10; ry <= 10; ry++) G.setRegionCost(r.w, 37, ry, Infinity); // a lake wall at x 592..608
    const detour = G.planRegionRoute(r.w, 0, 0, 1200, 0);
    expect(detour).toBeDefined(); expect(detour!.at(-1)).toEqual({ x: 1200, y: 0 });
    expect(detour!.some((p) => Math.abs(Math.floor(p.y / T.regionTiles)) > 10)).toBe(true); // went around the wall
  });
  it("off-screen: the expedition reaches a far resource 800 tiles away, deterministically, and comes home", () => {
    // The plan's real leaf for a fresh bot is wood (WOOD_RESERVE holds 8 back, so the axe goal still needs it) —
    // the need recorded by the sensors is [wood], so the trip's items match it and the early-end check holds.
    const run = (): { end: { x: number; y: number }; home: { x: number; y: number } } => {
      const r = rig();
      G.spawnResourceNode(r.w, "tree", 800.5, 0.5);
      mem(r).resourceNeed = { items: [WOOD], at: r.w.tick };
      G.markSpawnOffscreen(r.a, true); // a far-spawned bot starts in the coarse sim
      const g = G.pickTravelGoal(r.w, r.p, r.a, r.home, false)!;
      expect(g.kind).toBe("resource"); expect(g).toMatchObject({ x: 800.5, y: 0.5 });
      mem(r).travel = { ...g, pending: true };
      const c = ctxOf(r); expect(c.world.travel?.route!.length).toBeGreaterThan(10);
      expect(G.wantsOffscreen(r.a, 0, 0, [{ x: -2000, y: 0 }])).toBe(true);
      expect(offscreenUntil(r)).toBe("arrived");
      const end = pos(r);
      expect(Math.hypot(end.x - 800.5, end.y - 0.5)).toBeLessThanOrEqual(T.arriveTiles + 0.5);
      expect(mem(r).resourceReturn).toBe(true); // the round trip's return leg is queued
      expect(G.spawnedOffscreen(r.a)).toBe(false); // surfaced at the node to gather (full sim), not re-departed blind
      // the return leg home
      const back = G.pickTravelGoal(r.w, r.p, r.a, r.home, false)!;
      expect(back.kind).toBe("return"); expect(back).toMatchObject({ x: 0, y: 0 });
      mem(r).travel = { ...back, pending: true };
      ctxOf(r); expect(offscreenUntil(r)).toBe("arrived");
      const home = pos(r);
      expect(Math.hypot(home.x, home.y)).toBeLessThanOrEqual(T.arriveTiles + 0.5);
      expect(mem(r).resourceReturn).toBeUndefined();
      return { end, home };
    };
    const one = run(), two = run();
    expect(one.end).toEqual(two.end); // same seed -> same arrival
    expect(one.home).toEqual(two.home);
  });
  it("full-sim: the bot follows the resource route instead of wandering locally (trip never starts)", () => {
    const r = rig();
    const first = ctxOf(r); const leaves = first.world.plan!.leaves;
    expect(leaves.length).toBeGreaterThan(0);
    G.spawnResourceNode(r.w, "tree", 800.5, 0.5); // a far tree yields the plan's wood leaf
    mem(r).travel = { kind: "resource", x: 800.5, y: 0.5, since: 0, leg: 0, origin: { x: 0, y: 0 }, pending: true, items: [...leaves] };
    mem(r).resourceNeed = { items: [...leaves], at: 0 };
    const c0 = ctxOf(r); expect(c0.world.travel?.route!.length).toBeGreaterThan(10);
    const ctl = G.survivorController({ seed: 1 }); ctl.add(r.a);
    let far = 0;
    for (let i = 0; i < 6000 && far <= 100; i++) {
      const o = ctl.tick(r.w.tick, () => G.buildAgentView(r.w, r.p, r.a, r.home)!).get(r.a)!;
      move(r, o); r.w.step(DT); fed(r);
      expect(r.a.bb.get("trip")).toBeUndefined(); // the local wander never hijacks the expedition
      const p = pos(r); far = Math.max(far, Math.hypot(p.x, p.y));
    }
    expect(far).toBeGreaterThan(100);
    expect(mem(r).travel?.kind).toBe("resource"); // still on the expedition, not snoozed / re-routed
  });
  it("the trip ends early when the need is gone, but not while a plan step is executing", () => {
    const r = rig();
    // need gone, no plan step: the trip ends on the next sensor pass
    mem(r).travel = { kind: "resource", x: 800.5, y: 0.5, since: 0, leg: 0, origin: { x: 0, y: 0 }, items: [IRON_ORE] };
    delete mem(r).resourceNeed;
    ctxOf(r);
    expect(mem(r).travel).toBeUndefined();
    // same stale trip, but the bot is mid-craft (plan step): the trip survives the transiently empty leaves
    const r2 = rig({ slot: 1 });
    G.addItem(r2.w, r2.p, WOOD, 12); G.addItem(r2.w, r2.p, STONE, 4); G.addItem(r2.w, r2.p, FIBER, 2); // 12 wood: WOOD_RESERVE holds 8 back, 4 is enough for the axe
    expect(ctxOf(r2).world.plan?.step?.k).toBe("craft"); // stone_axe, hand craft
    mem(r2).travel = { kind: "resource", x: 800.5, y: 0.5, since: 0, leg: 0, origin: { x: 0, y: 0 }, items: [IRON_ORE] };
    delete mem(r2).resourceNeed;
    ctxOf(r2);
    expect(mem(r2).travel?.kind).toBe("resource");
  });
});

describe("ADR-343 home is kept on a long trip", () => {
  it("travelKeepsHome is measured to the leg segment, not the waypoint points", () => {
    const r = rig();
    mem(r).travel = { kind: "resource", x: 200, y: 0, since: 0, leg: 1, origin: { x: 0, y: 0 }, route: [{ x: 100, y: 0 }, { x: 200, y: 0 }] };
    // 25 tiles off the middle of the leg: 56 tiles from either waypoint (the old point rule said "off the trip")
    expect(G.travelKeepsHome(r.a, 150, 25)).toBe(true);
    expect(G.travelKeepsHome(r.a, 150, 100)).toBe(false); // genuinely off the corridor
    mem(r).travel = { kind: "resource", x: 200, y: 0, since: 0, leg: 0, origin: { x: 0, y: 0 }, route: [{ x: 100, y: 0 }, { x: 200, y: 0 }] };
    expect(G.travelKeepsHome(r.a, 5, 5)).toBe(true); // near the origin at the start of leg 0
    mem(r).travel = { kind: "relocate", x: 200, y: 0, since: 0, leg: 1, origin: { x: 0, y: 0 }, route: [{ x: 100, y: 0 }, { x: 200, y: 0 }] };
    expect(G.travelKeepsHome(r.a, 150, 0)).toBe(false); // relocations never keep the base
    mem(r).travel = { kind: "resource", x: 200, y: 0, since: 0, leg: 0, origin: { x: 0, y: 0 } };
    expect(G.travelKeepsHome(r.a, 150, 0)).toBe(true); // no route yet (pending): kept
  });
});

describe("ADR-343 the travel layer owns movement while a route is active", () => {
  it("trip and return_home score 0 with a route, and run without one", () => {
    const r = rig();
    const reg = G.survivorRegistry();
    const route: G.TravelState = { kind: "resource", x: 800, y: 0, since: 0, leg: 0, origin: { x: 0, y: 0 }, route: [{ x: 100, y: 0 }, { x: 800, y: 0 }] };
    const base = ctxOf(r);
    const withRoute: Ctx = { ...base, self: { ...base.self, x: 400, y: 0, phase: "night" }, world: { ...base.world, home: { x: 0, y: 0 }, tripWanted: true, travel: route } };
    // trip's day consideration zeroes it at night (trips turn back at night by design), so the no-route trip check
    // runs in daylight; return_home's evening consideration needs night, so it gets its own no-route ctx.
    const withoutRouteDay: Ctx = { ...base, self: { ...base.self, x: 400, y: 0, phase: "day" }, world: { ...base.world, home: { x: 0, y: 0 }, tripWanted: true } };
    const withoutRouteNight: Ctx = { ...base, self: { ...base.self, x: 400, y: 0, phase: "night" }, world: { ...base.world, home: { x: 0, y: 0 }, tripWanted: true } };
    expect(scoreBehavior(reg.get("trip")!, withRoute, undefined, [])).toBe(0);
    // return_home's farFromHome is a logistic curve, which never reaches 0 — the gate pins it at its floor (~0.07),
    // far below travel's 0.55, so the route still owns movement; without a route it pulls hard.
    expect(scoreBehavior(reg.get("return_home")!, withRoute, undefined, [])).toBeLessThan(0.1);
    expect(scoreBehavior(reg.get("trip")!, withoutRouteDay, undefined, [])).toBeGreaterThan(0);
    expect(scoreBehavior(reg.get("return_home")!, withoutRouteNight, undefined, [])).toBeGreaterThan(0.5);
  });
});
