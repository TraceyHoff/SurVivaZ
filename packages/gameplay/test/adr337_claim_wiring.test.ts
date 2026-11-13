// ADR-337 wiring: the claim layer is actually used — buildAgentView (via fillGoalSensors ->
// fillClaimSensors, before the plan sensors) sets claimTarget/claimPlan for a homeless bot near a
// ruin, the claim materials reach the planner through claimPriority, the planner does not pick a
// competing site while a ruin is targeted, a bot with no ruin nearby plans a new home, a hired bot
// claims nothing, and the registry carries claim_build.
import { describe, expect, it } from "vitest";
import { installPermissions, NetId, PlayerId, Transform, type Agent, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { aiMemoryOf } from "../src/ai/planner.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";

let nid = 9800;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };
const pid = (w: World, e: Entity, id: number): Entity => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); return e; };
interface Rig { w: World; p: Entity; a: Agent; home: { x: number; y: number } }
function rig(opts: { x?: number; y?: number; hired?: boolean } = {}): Rig {
  const w = makeWorld({}, 42); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const x = opts.x ?? 10, y = opts.y ?? 10;
  const p = spawnLearned(w, { x, y, maxWeight: 0, clientId: 7 }); pid(w, p, 7); net(w, p);
  if (opts.hired) w.add(p, G.Worker, { owner: 3, homeX: x, homeY: y, job: G.WorkerJob.None } as never);
  const a = G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1);
  w.set(p, G.Survival, { hunger: 100, thirst: 100, bodyTemp: 37 });
  return { w, p, a, home: { x, y } };
}
const viewOf = (r: Rig): G.AgentWorldView => G.buildAgentView(r.w, r.p, r.a, r.home)!.world;
const stampRuin = (r: Rig, ox: number, oy: number, kind: number, ruin: number): Entity => {
  const res = G.stampAbandonedSite(r.w, ox, oy, { kind: kind as never, rot: 0, ruin, tier: 1 });
  G.drainAbandonedStamps(r.w); // ADR-382: the stamp completes over ticks; drain it for the assertions below
  expect(res.skipped, `stamp at ${ox},${oy}`).toBe(false);
  return res.marker as Entity;
};

describe("ADR-337 wiring: buildAgentView + planner + registry", () => {
  it("a homeless bot near a ruin targets it through the real view, and the claim materials reach the planner", () => {
    const r = rig();
    const marker = stampRuin(r, 8, 8, G.AbandonedKind.Shed, 0.1);
    const v = viewOf(r);
    expect(v.claimTarget?.kind).toBe("ruin");
    expect(v.claimTarget?.marker).toBe(marker);
    expect(v.claimPlan).toBeDefined();
    expect(v.claimPlan!.target.stage).not.toBe("done");
    // the claim materials reach the gather needs (the planner's goal is NOT hijacked: claim
    // materials are gather targets, not a plan goal — coordinator fix for the ADR-252 live
    // regression). The sensor still publishes them on the claimPriority blackboard.
    expect(r.a.bb.get<{ key: string; count: number }[]>("claimPriority")).toBeDefined();
    expect(v.needs?.length).toBeGreaterThan(0);
    // ruin homes never get mem.base — the planner must not own a competing site
    expect(aiMemoryOf(r.a).base).toBeUndefined();
  });

  it("the planner picks no competing site while a ruin is targeted, even after the site-pick cooldown", () => {
    const r = rig();
    stampRuin(r, 8, 8, G.AbandonedKind.Shed, 0.1);
    viewOf(r); steps(r.w, 250); // past the 200-tick sitePickAt cooldown; goal sensors re-sense
    const v = viewOf(r);
    expect(v.claimTarget?.kind).toBe("ruin");
    expect(aiMemoryOf(r.a).base).toBeUndefined();
    expect(v.base).toBeUndefined();
  });

  it("a bot with no ruin nearby plans a new home of its own design, and the planner adopts the claim site", () => {
    const r = rig({ x: 100, y: 100 });
    const v = viewOf(r);
    expect(v.claimTarget?.kind).toBe("new");
    expect(v.claimPlan).toBeDefined();
    expect(v.claimPlan!.target.stage).not.toBe("done");
    // coordinator fix for the ADR-331 regression: the planner adopts the claim layer's new site as
    // the home record (the claim layer already ran pickBaseSite), so the ladder can start; the flag
    // is still built first before any hut piece. Ruin targets are never adopted (see the test above).
    const base = aiMemoryOf(r.a).base;
    expect(base).toBeDefined();
    expect(Math.hypot(base!.x - v.claimTarget!.x, base!.y - v.claimTarget!.y)).toBeLessThan(1);
  });

  it("a hired bot claims nothing", () => {
    const r = rig({ hired: true });
    stampRuin(r, 8, 8, G.AbandonedKind.Shed, 0.1);
    const v = viewOf(r);
    expect(v.claimTarget).toBeUndefined();
    expect(v.claimPlan).toBeUndefined();
  });

  it("a bot far from home claims near HOME, not under its feet — so return_home still rides the long trip (ADR-321 regression)", () => {
    const r = rig({ x: 0, y: 0 });
    r.home = { x: 70, y: 0 };
    net(r.w, G.makeMount(r.w, "animal_horse", 1, 0, r.p));
    const v = viewOf(r);
    expect(v.claimTarget?.kind).toBe("new");
    expect(Math.hypot(v.claimTarget!.x - 70, v.claimTarget!.y)).toBeLessThan(12);
    expect(Math.hypot(v.claimTarget!.x, v.claimTarget!.y)).toBeGreaterThan(40);
    // the adopted base is near home too, so return_home's porch is a long trip away and the mount policy rides
    const base = aiMemoryOf(r.a).base;
    expect(base).toBeDefined();
    expect(Math.hypot(base!.x - 70, base!.y)).toBeLessThan(12);
    const full = G.buildAgentView(r.w, r.p, r.a, r.home)!;
    const c = { self: full.self, bb: r.a.bb, memory: r.a.memory, traits: r.a.identity.traits, rng: r.a.rng, agent: r.a, world: full.world } as never;
    const o = { moveX: 0, moveY: 0, aimX: 0, aimY: 0, sprint: false, actions: [] as string[] };
    const ret = G.referenceBehaviors().find((b) => b.name === "return_home")!;
    ret.run(c as never, o as never);
    const goal = G.navGoal(c as never);
    expect(goal).toBeDefined();
    expect(Math.hypot(goal!.x, goal!.y)).toBeGreaterThan(30); // porch near home, not beside the bot
    expect(G.wantsRide(c as never, o as never, "return_home")).toBe(true);
  });

  it("the survivor registry carries claim_build", () => {
    expect(G.survivorRegistry().list().map((b) => b.name)).toContain("claim_build");
  });

  it("the claim_build behaviour drives the claim plan's step (walks to the flag stand)", () => {
    const r = rig();
    const d = G.gameplayDefs(r.w);
    for (const k of ["wood", "stone", "sticks", "planks", "rope", "nails", "fiber", "clay", "dye", "berries"] as const) G.addItem(r.w, r.p, d.itemId(k), 20);
    stampRuin(r, 8, 8, G.AbandonedKind.Shed, 0.1);
    const v = viewOf(r);
    expect(v.claimPlan?.step?.k).toBe("build");
    const self = G.buildAgentSelf(r.w, r.p, r.a)!;
    const c = { self, bb: r.a.bb, memory: r.a.memory, traits: r.a.identity.traits, rng: r.a.rng, agent: r.a, world: v } as never;
    const o = { moveX: 0, moveY: 0, aimX: 0, aimY: 0, sprint: false, actions: [] as string[] };
    const b = G.claimBuildBehaviors()[0]!;
    expect(b.considerations.every((k) => k.input(c as never) >= 0.5)).toBe(true);
    b.run(c as never, o as never);
    expect(Math.hypot(o.moveX, o.moveY) > 0 || o.actions.length > 0).toBe(true);
  });
});
