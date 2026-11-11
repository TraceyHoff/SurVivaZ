// ADR-341: defence wired into makePlan — the `defence` ladder goal (after `bed`, before
// `furnish`) calls ADR-338's planDefence, so a threatened bot with surplus fortifies as a
// first-class plan goal instead of only when the planner has no step. The sensor no longer
// plans: fillDefenceSensors records threat events and translates the planner's defence step
// into view.defenceTarget for build_defence, and base_work skips defence steps.
import { describe, expect, it } from "vitest";
import { installPermissions, NetId, PlayerId, Transform, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import * as D from "../src/ai/defence.js";
import { aiMemoryOf, GOAL_LADDER, scanBase, type BaseState } from "../src/ai/planner.js";
import { fillClaimSensors, ruinHomeAnchor, type ClaimView } from "../src/ai/claim_build.js";
import { makeWorld, plantClaim, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
const iid = (k: string): number => d.itemId(k);
const BASE = { x: 10, y: 10 };
const SNOOZE = 10_000_000;
let nid = 9800;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };
const pid = (w: World, e: Entity, id: number): Entity => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); return e; };

interface Rig { w: World; p: Entity; a: Agent; home: { x: number; y: number } }
function rig(opts: { claim?: boolean; hired?: boolean; lean?: boolean; noBase?: boolean } = {}): Rig {
  const w = makeWorld(); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = spawnLearned(w, { x: BASE.x + 1, y: BASE.y + 3.3, maxWeight: 0, clientId: 1 }); pid(w, p, 9); net(w, p);
  steps(w, 1);
  if (opts.claim !== false) plantClaim(w, p, BASE.x - 2, BASE.y - 2);
  const a = G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1);
  if (!opts.noBase) (aiMemoryOf(a) as unknown as { base: { x: number; y: number } }).base = { ...BASE };
  if (opts.hired) { G.ensureWorker(w, p); w.setField(p, G.Worker, "owner", 7); }
  for (const k of ["stone_axe", "stone_pickaxe"] as const) G.addItem(w, p, iid(k), 1);
  // ADR-338's rich basket: every defence material with surplus, plus fuel stock (unless lean)
  const basket: readonly (readonly [string, number])[] = opts.lean
    ? [["scrap_metal", 50], ["sticks", 99], ["planks", 50], ["rope", 30], ["spring", 50], ["iron_ingot", 30], ["nails", 99], ["crude_oil", 20]]
    : [["scrap_metal", 50], ["sticks", 99], ["planks", 50], ["rope", 30], ["spring", 50], ["iron_ingot", 30], ["nails", 99], ["crude_oil", 20], ["wood", 50], ["stone", 50]];
  for (const [k, n] of basket) G.addItem(w, p, iid(k), n);
  return { w, p, a, home: { x: BASE.x + 1, y: BASE.y + 1 } };
}
/** A complete home scan (every BASE_SLOT, campfire + workbench stations, storage, bed, hearth) so the ladder's pre-defence goals are met for real. */
const completeBs = (): BaseState => ({
  pieces: new Map(G.BASE_SLOTS.map((s) => [s.id, 1 as Entity])),
  stations: new Map([
    [G.StationKind.Campfire, { id: 10 as Entity, x: BASE.x + 1.5, y: BASE.y + 0.5, fired: true, lit: true, fuelTicks: 99999 }],
    [G.StationKind.Workbench, { id: 11 as Entity, x: BASE.x + 3.5, y: BASE.y + 0.5, fired: false, lit: false, fuelTicks: 0 }],
  ]),
  storage: { id: 12 as Entity, x: BASE.x + 3.5, y: BASE.y + 1.6, counts: new Map(), free: 10 },
  bed: { id: 13 as Entity, x: BASE.x + 0.5, y: BASE.y + 1 },
  complete: true,
  hearth: 10 as Entity,
});
const threaten = (r: Rig, n = 3): void => { for (let i = 0; i < n; i++) G.noteDefenceEvent(r.a, "sighting", r.w.tick); };
/** Wear the torch the ladder wants, the way the walk in adr340 does (wearSlot + refreshWorn). */
const wearTorch = (r: Rig): void => {
  const tid = iid("torch"); G.addItem(r.w, r.p, tid, 1);
  const sl = G.readSlots(r.w, r.p);
  const slot = sl.items.findIndex((it) => it === tid);
  expect(slot, "torch slot in the bag").toBeGreaterThanOrEqual(0);
  expect(G.wearSlot(r.w, r.p, slot), "wear the torch").toBe(true);
  G.refreshWorn(r.w, r.p);
};
const planOf = (r: Rig, extra: Partial<G.PlanInput> = {}): G.Plan => {
  const mem = D.defenceMemoryOf(r.a);
  const { level } = D.assessThreat(mem.events, r.w.tick);
  return G.makePlan({ world: r.w, self: r.p, defs: G.gameplayDefs(r.w), base: BASE, bs: completeBs(), fails: {}, threat: level, defenceMem: mem, winter: false, evening: false, ...extra });
};
/** Snooze every ladder goal before `defence` (the ADR-340 isolation pattern). */
const snoozeBeforeDefence = (): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const g of GOAL_LADDER) {
    if (g.k === "defence") break;
    out[g.k === "tool" ? g.name : g.k === "item" ? g.key : g.k === "piece" ? g.key : g.k === "wear" ? `wear:${g.key}` : g.k === "furnish" ? `furnish:${g.key}` : g.k] = SNOOZE;
  }
  return out;
};
/** Plan one piece and really place it (bot teleported to the stand, like a player in reach). */
const placeNext = (r: Rig, t: { piece: number; x: number; y: number; level: number; rot?: number; tier?: number; stand: { x: number; y: number } }): void => {
  r.w.set(r.p, Transform, { x: t.stand.x, y: t.stand.y });
  const res = G.tryPlace(r.w, r.p, { piece: t.piece, x: t.x, y: t.y, level: t.level, rot: t.rot ?? 0, tier: t.tier ?? 0, variant: 0 });
  expect(res.ok, `place at ${t.x},${t.y}`).toBe(true);
  steps(r.w, 25);
};
const viewFor = (w: World, over: Record<string, unknown> = {}): G.AgentWorldView & D.DefenceSensors => {
  const bs = G.scanBase(w, d, BASE);
  return { seen: [], home: { x: BASE.x + 1, y: BASE.y + 1 }, playerName: "tester", base: BASE, bs, plan: { goal: "idle", leaves: [], hunt: [], keep: new Set<number>(), blocked: [] }, ...over } as unknown as G.AgentWorldView & D.DefenceSensors;
};
const out = (): AgentOutput => ({ moveX: 0, moveY: 0, aimX: 0, aimY: 0, sprint: false, actions: [] });
const ctxFor = (w: World, agent: Agent, view: G.AgentWorldView, selfOver: Record<string, unknown> = {}): AgentContext<G.AgentWorldView> => {
  const self = { x: BASE.x + 1, y: BASE.y + 3.3, tick: 0, facing: 0, hp: 1, hunger: 1, thirst: 1, stamina: 1, dayT: 0.5, phase: "day", ...selfOver };
  return { self, world: view, memory: agent.memory, bb: agent.bb, traits: agent.identity.traits, rng: agent.rng, agent } as unknown as AgentContext<G.AgentWorldView>;
};
const viewOf = (r: Rig): G.AgentWorldView => G.buildAgentView(r.w, r.p, r.a, r.home)!.world;
const snoozeAgent = (r: Rig, snooze: Record<string, number>): void => { (aiMemoryOf(r.a) as unknown as { snooze: Record<string, number> }).snooze = snooze; };

describe("ADR-341 planner: the defence goal", () => {
  it("defence sits in the ladder after bed and before furnish", () => {
    const names = GOAL_LADDER.map((g) => (g.k === "tool" ? g.name : g.k === "item" ? g.key : g.k === "piece" ? g.key : g.k === "wear" ? `wear:${g.key}` : g.k === "furnish" ? `furnish:${g.key}` : g.k));
    expect(names).toContain("defence");
    expect(names.indexOf("defence")).toBeGreaterThan(names.indexOf("bed"));
    expect(names.indexOf("defence")).toBeLessThan(names.indexOf("furnish:table"));
  });

  it("a threatened bot with surplus and a met home plans one barbed-wire build step", () => {
    const r = rig(); threaten(r); wearTorch(r);
    const plan = planOf(r);
    expect(plan.goal).toBe("defence");
    expect(plan.step?.k).toBe("build");
    if (plan.step?.k !== "build") throw new Error("expected a defence build step");
    expect(G.gameplayDefs(r.w).pieces.get(plan.step.piece)?.key).toBe("barbed_wire");
    expect(plan.leaves).toEqual([]);
    expect(plan.hunt).toEqual([]);
    // the wire's materials are kept, never junk / stash fodder while the goal is live
    expect(plan.keep.has(iid("scrap_metal"))).toBe(true);
    expect(plan.keep.has(iid("sticks"))).toBe(true);
    expect(G.hasOwnClaim(r.w, r.p, plan.step.x, plan.step.y), "wire inside the bot's own claim").toBe(true);
  });

  it("no defence goal at threat level 0 or 1 — the ladder walks on to furnish", () => {
    const r = rig(); wearTorch(r);
    expect(planOf(r).goal).toBe("furnish:table");
    threaten(r, 1);
    expect(planOf(r).goal).toBe("furnish:table");
  });

  it("no defence goal without surplus materials", () => {
    const w = makeWorld(); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
    const p = spawnLearned(w, { x: BASE.x + 1, y: BASE.y + 3.3, maxWeight: 0, clientId: 1 }); pid(w, p, 9); net(w, p);
    steps(w, 1);
    plantClaim(w, p, BASE.x - 2, BASE.y - 2);
    const a = G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1);
    (aiMemoryOf(a) as unknown as { base: { x: number; y: number } }).base = { ...BASE };
    // tools + fuel only: nothing a wire or turret is built from
    for (const k of ["stone_axe", "stone_pickaxe"] as const) G.addItem(w, p, iid(k), 1);
    for (const [k, n] of [["wood", 50], ["stone", 50]] as const) G.addItem(w, p, iid(k), n);
    const r = { w, p, a, home: { x: BASE.x + 1, y: BASE.y + 1 } };
    threaten(r, 3); wearTorch(r);
    expect(planOf(r).goal).toBe("furnish:table");
  });

  it("no defence goal without a claim of its own", () => {
    const r = rig({ claim: false }); threaten(r); wearTorch(r);
    expect(planOf(r).goal).toBe("furnish:table");
  });

  it("no defence goal when hired", () => {
    const r = rig({ hired: true }); threaten(r); wearTorch(r);
    expect(planOf(r).goal).toBe("furnish:table");
  });

  it("a ruin home plans defence against its own claim, never the base goal", () => {
    const r = rig(); threaten(r); wearTorch(r);
    const plan = G.makePlan({ world: r.w, self: r.p, defs: G.gameplayDefs(r.w), ruinBase: { x: 7, y: 7 }, bs: completeBs(), fails: {}, threat: 2, defenceMem: D.defenceMemoryOf(r.a), winter: false, evening: false });
    expect(plan.goal).toBe("defence");
    expect(plan.step?.k).toBe("build");
  });

  it("one defence step at a time: after the wire stands, the next plan is the next wire slot", () => {
    const r = rig(); threaten(r); wearTorch(r);
    const first = planOf(r);
    expect(first.goal).toBe("defence");
    if (first.step?.k !== "build") throw new Error("expected a defence build step");
    const slot0 = first.step.slot;
    placeNext(r, first.step);
    const second = planOf(r);
    expect(second.goal).toBe("defence");
    expect(second.step?.k).toBe("build");
    if (second.step?.k !== "build") throw new Error("expected a second defence build step");
    expect(second.step.slot).not.toBe(slot0);
  });
});

describe("ADR-341 ordering: defence never starves a need", () => {
  it("a starving bot cooks first, even at high threat with surplus", () => {
    const r = rig(); threaten(r); wearTorch(r);
    G.addItem(r.w, r.p, iid("raw_meat"), 3);
    const plan = planOf(r, { hungry: true });
    expect(plan.goal).toBe("cook");
  });

  it("a freezing bot with no fuel gathers wood first, even at high threat with surplus", () => {
    const r = rig({ lean: true }); threaten(r); wearTorch(r);
    const plan = planOf(r, { freezing: true });
    expect(plan.goal).toBe("wood");
    expect(plan.leaves).toContain(iid("wood"));
  });

  it("an unsheltered bot builds its base first, even at high threat with surplus", () => {
    const r = rig(); threaten(r); wearTorch(r);
    const emptyBs: BaseState = { pieces: new Map(), stations: new Map(), complete: false };
    const snooze = { campfire: SNOOZE, basic_storage_box: SNOOZE, wood: SNOOZE, workbench: SNOOZE, "wear:torch": SNOOZE, earthworks: SNOOZE };
    const plan = planOf(r, { bs: emptyBs, snooze });
    expect(plan.goal).toBe("base");
    expect(plan.step?.k).toBe("build");
  });

  it("thirst still reaches drink_water while a defence plan is active (thirst is served by the behaviour, not the planner)", () => {
    const r = rig(); threaten(r); wearTorch(r);
    const plan = planOf(r);
    expect(plan.goal).toBe("defence");
    const view = viewFor(r.w, { plan, waterAt: { x: BASE.x + 2, y: BASE.y + 2 } });
    const dw = G.autonomyBehaviors().find((b) => b.name === "drink_water")!;
    const c = ctxFor(r.w, r.a, view, { thirst: 0.2 });
    const thirsty = dw.considerations.find((cc) => cc.name === "thirsty")!.input(c);
    const waterKnown = dw.considerations.find((cc) => cc.name === "waterKnown")!.input(c);
    expect(thirsty).toBe(0.8); // the input is 1 - thirst (the logistic curve is applied by scoring, not the input)
    expect(waterKnown).toBe(1);
  });
});

describe("ADR-341 executors: one owner for the defence step", () => {
  it("base_work scores nothing and does nothing for a defence plan", () => {
    const r = rig(); threaten(r); wearTorch(r);
    const plan = planOf(r);
    expect(plan.goal).toBe("defence");
    const bw = G.baseBehaviors().find((b) => b.name === "base_work")!;
    const c = ctxFor(r.w, r.a, viewFor(r.w, { plan, bs: completeBs() }));
    expect(bw.considerations.find((cc) => cc.name === "step")!.input(c)).toBe(0);
    const o = out();
    expect(bw.run(c, o)).toBe(false);
    expect(o.actions).toEqual([]);
  });

  it("build_defence's planFree allows the planner's own defence step, but no other plan step", () => {
    const { w, a: agent } = rig();
    const b = D.defenceBehaviors()[0]!;
    const input = (name: string, view: G.AgentWorldView): number => b.considerations.find((cc) => cc.name === name)!.input(ctxFor(w, agent, view));
    const wire = d.pieceId("barbed_wire");
    const defencePlan = { goal: "defence", step: { k: "build", piece: wire, x: 1, y: 1, level: 0, rot: 0, tier: 0, slot: "wire0", stand: { x: 1, y: 1 } }, leaves: [], hunt: [], keep: new Set<number>(), blocked: [] };
    const otherPlan = { goal: "wood", step: { k: "wear", invSlot: 0 }, leaves: [], hunt: [], keep: new Set<number>(), blocked: [] };
    expect(input("planFree", viewFor(w, { plan: defencePlan }))).toBe(1);
    expect(input("planFree", viewFor(w, { plan: otherPlan }))).toBe(0);
    expect(input("planFree", viewFor(w))).toBe(1);
  });
});

describe("ADR-341 wiring: the sensor translates the planner's target, it plans nothing", () => {
  it("a threatened bot with its needs met gets the planner's barbed-wire target through the real view", () => {
    const r = rig(); threaten(r);
    snoozeAgent(r, snoozeBeforeDefence());
    const v = viewOf(r);
    expect(v.plan?.goal).toBe("defence");
    expect(v.plan?.step?.k).toBe("build");
    expect(v.defenceTarget).toBeDefined();
    expect(v.defenceTarget!.key).toBe("barbed_wire");
    expect(v.defenceTarget!.threat).toBeGreaterThanOrEqual(2);
    if (v.plan?.step?.k !== "build") throw new Error("expected a defence build step");
    expect(v.defenceTarget!.slot).toBe(v.plan.step.slot);
    expect(v.defenceTarget!.x).toBe(v.plan.step.x);
    expect(v.defenceTarget!.y).toBe(v.plan.step.y);
  });

  it("at high threat but with the plan busy building the campfire, the sensor sets no target", () => {
    const r = rig(); threaten(r);
    const v = viewOf(r);
    expect(v.plan?.goal).toBe("campfire");
    expect(v.defenceTarget).toBeUndefined();
  });

  it("the translated target is stable across sense passes (one plan, one target)", () => {
    const r = rig(); threaten(r);
    snoozeAgent(r, snoozeBeforeDefence());
    const first = viewOf(r);
    expect(first.defenceTarget).toBeDefined();
    const second = viewOf(r);
    expect(second.defenceTarget).toBeDefined();
    expect(second.defenceTarget!.slot).toBe(first.defenceTarget!.slot);
    expect(second.defenceTarget!.x).toBe(first.defenceTarget!.x);
    expect(second.defenceTarget!.y).toBe(first.defenceTarget!.y);
  });

  it("a threatened ruin home defends through the real view (plan + target, no mem.base, no view.base)", () => {
    const r = rig({ claim: false, noBase: true }); // a ruin bot has no mem.base (ADR-337/340)
    const res = G.stampAbandonedSite(r.w, 8, 8, { kind: G.AbandonedKind.Shed, rot: 0, ruin: 0.1, tier: 1 });
    expect(res.skipped, "stamp the ruin").toBe(false);
    const marker = res.marker as Entity;
    const stub = { seen: [], home: { ...r.home }, playerName: "bot" } as unknown as G.AgentWorldView;
    fillClaimSensors(r.w, r.p, stub, r.a);
    expect((stub as unknown as ClaimView).claimTarget?.kind).toBe("ruin");
    plantClaim(r.w, r.p, 6.5, 8.5);
    expect(G.reclaimAbandonedSite(r.w, r.p, marker)).toBe(0);
    r.w.tick += 25;
    const anchor = ruinHomeAnchor(r.w, r.p, r.a);
    expect(anchor, "ruin home after claim + reclaim").toBeDefined();
    threaten(r);
    snoozeAgent(r, { ...snoozeBeforeDefence(), hearth: SNOOZE, bed: SNOOZE });
    const v = viewOf(r);
    expect(v.plan?.goal).toBe("defence");
    expect(v.defenceTarget).toBeDefined();
    expect(v.defenceTarget!.key).toBe("barbed_wire");
    expect(v.base).toBeUndefined();
    expect(aiMemoryOf(r.a).base).toBeUndefined();
    expect(v.ruinBase).toEqual({ x: anchor!.x, y: anchor!.y });
    expect(v.bs).toBeDefined();
    void anchor;
  });
});
