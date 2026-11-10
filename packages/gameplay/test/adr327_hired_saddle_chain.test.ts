// ADR-327: hired workers run the saddle-material chain as a LOW-priority goal — only when no employer
// job work is pending and survival needs are met (same danger thresholds ADR-323 abandons on). The chain
// uses the employer's base (stations + storage), never the worker's own, and the same timeout -> lower-tier
// fallback and danger-abandon behaviour as unhired bots. A Follow worker never runs it (its duty is proximity).
import { describe, expect, it } from "vitest";
import { idleOutput, installPermissions, NetId, PlayerId, Transform, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { aiMemoryOf, makePlan } from "../src/ai/planner.js";
import { baseBehaviors } from "../src/ai/base_behaviors.js";
import { DT, ensureClaim, makeWorld, spawnLearned, steps } from "./helpers.js";

const B = G.MOUNT_BOTS;
let nid = 8000;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };
const pid = (w: World, e: Entity, id: number): Entity => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); return e; };
interface Rig { w: World; p: Entity; boss: Entity; a: Agent; id: (k: string) => number; home: { x: number; y: number } }
function rig(opts: { job?: number; seed?: number } = {}): Rig {
  const w = makeWorld({}, opts.seed ?? 42); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const boss = net(w, pid(w, spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }), 7));
  const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 55 }); pid(w, p, 55); net(w, p);
  w.add(p, G.Worker, { owner: 7, homeX: 0, homeY: 0, job: opts.job ?? G.WorkerJob.Gather } as never);
  const a = G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1); const d = G.gameplayDefs(w);
  return { w, p, boss, a, id: (k) => d.itemId(k), home: { x: 0, y: 0 } };
}
type Ctx = AgentContext<G.AgentWorldView>;
const ctxOf = (r: Rig): Ctx => { const v = G.buildAgentView(r.w, r.p, r.a, r.home)!; return { self: v.self, bb: r.a.bb, memory: r.a.memory, traits: { ...r.a.identity.traits }, rng: r.a.rng, agent: r.a, world: v.world }; };
/** View after one full sense cycle (goal sensors are cached SENSE_EVERY ticks; the mount pass feeds the next one). */
const settled = (r: Rig): Ctx => { ctxOf(r); steps(r.w, 11); return ctxOf(r); };
const out = (): AgentOutput & { commands?: G.AgentCommand[] } => ({ ...idleOutput(), actions: [] as string[] });
const place = (r: Rig, key: string, x: number, y: number, by: Entity = r.boss): Entity => {
  const d = G.gameplayDefs(r.w); const sn = G.snapPlacement(r.w, { piece: d.pieceId(key), x, y, level: 0, rot: 0, tier: 0, variant: 0 }); if (typeof sn === "number") throw new Error(`snap ${key} ${sn}`);
  const e = G.placePiece(r.w, by, sn, { pay: false }); steps(r.w, 1); return e;
};
const boxOf = (w: World, piece: Entity): Entity => G.resolveAttachment(w, piece, G.AttachKind.Storage)!;
/** Server-side effects of the bot's commands: container ops (reach + ADR-207 gate as containerSystem), crafts, saddling, movement. */
function apply(r: Rig, o: AgentOutput & { commands?: G.AgentCommand[] }, log: string[]): void {
  const { w, p } = r;
  for (const a of o.actions) {
    const [k, t, i, n] = a.split(":");
    if (k === "craft") { const rid = Number(t); G.enqueueCraft(w, p, rid, Number(i ?? 1)); log.push(`craft:${G.gameplayDefs(w).items.get(G.gameplayDefs(w).recipes.get(rid)!.output.item)!.key}`); continue; }
    if (k !== "cwithdraw") continue; const c = boxOf(w, Number(t) as Entity);
    if (G.canUseBaseStorage(w, p, c)) { G.transferItem(w, c, p, Number(i), Number(n)); log.push(`withdraw:${G.gameplayDefs(w).items.get(Number(i))!.key}:${n}`); }
  }
  G.emitAgentCommands(o);
  for (const c of o.commands ?? []) {
    const v = c.payload as { target: number; slot: number };
    if (c.type === G.MountSaddleCmd.name) { G.saddleMount(w, p, v.target as Entity, v.slot); log.push("msaddle"); }
  }
  let bits = 0; const len = Math.hypot(o.moveX, o.moveY);
  if (len > 1e-6) { if (o.moveX > 0.38 * len) bits |= G.GameplayActions.MoveRight; else if (o.moveX < -0.38 * len) bits |= G.GameplayActions.MoveLeft; if (o.moveY > 0.38 * len) bits |= G.GameplayActions.MoveDown; else if (o.moveY < -0.38 * len) bits |= G.GameplayActions.MoveUp; }
  G.applyMovementInput(w, p, bits, DT);
}
const beh = (name: string): G.GameBehavior => [...G.mountBehaviors(), ...baseBehaviors(), ...G.survivorRegistry().list()].find((b) => b.name === name)!;

/** The employer's base at (0,0) with a workbench (and optionally more stations), a box, and the employer's
 *  tamed horse with no saddle — the hired worker's mount (Mount.owner is the employer's PlayerId). */
function hiredSaddleRig(stations: string[] = ["workbench"]): Rig & { m: Entity; box: Entity } {
  const r = rig(); ensureClaim(r.w, r.boss, 0, 0);
  const spots: Record<string, [number, number]> = { workbench: [3.5, 0.5], campfire: [2.6, 2.9], furnace: [-1.5, 0.5], anvil: [-1.5, 1.6] };
  for (const k of stations) place(r, k, ...spots[k]!);
  const box = place(r, "basic_storage_box", 3.5, 1.6); const m = net(r.w, G.makeMount(r.w, "animal_horse", 6, 6, r.boss));
  return { ...r, m, box };
}

describe("ADR-327 hired workers run the saddle chain", () => {
  it("an idle hired worker with its employer's mount plans saddle materials (employer's stations + storage)", () => {
    const r = hiredSaddleRig(); G.addItem(r.w, boxOf(r.w, r.box), r.id("hide"), 8);
    G.addItem(r.w, r.p, r.id("fiber"), 8); G.addItem(r.w, r.p, r.id("flax"), 4);
    const c = settled(r);
    expect(c.world.mount?.id).toBe(r.m); // the employer's mount is the worker's own mount
    expect(c.world.hire?.idle).toBe(true);
    expect(c.world.saddleGoal).toMatchObject({ key: "saddle_leather", tier: 1 }); // the only tier the employer's base affords
    expect(c.world.plan?.goal).toBe("saddle_leather");
    expect(c.world.plan?.step).toMatchObject({ k: "withdraw", item: r.id("hide") }); // hide comes from the employer's box
  });
  it("without hide on hand the chain hands hide to the gather / hunt behaviours (needs), like an unhired bot", () => {
    const r = hiredSaddleRig(); G.addItem(r.w, r.p, r.id("stone_knife"), 1); const c = settled(r); expect(c.world.saddleGoal?.key).toBe("saddle_leather");
    expect(c.world.plan?.goal).toBe("saddle_leather"); expect([...c.world.plan!.leaves, ...c.world.plan!.hunt]).toContain(r.id("hide"));
    expect(c.world.needs).toContain(r.id("hide"));
  });
  it("no stations at the employer's base: no saddle goal (the worker's own base is never consulted)", () => {
    const r = hiredSaddleRig([]); const c = settled(r);
    expect(c.world.mount?.id).toBe(r.m); expect(c.world.saddleGoal).toBeUndefined(); expect(c.world.plan?.goal).not.toBe("saddle_leather");
  });
  it("end to end: the hired worker withdraws the hide, crafts rope / leather / thread / saddle, then equips it", () => {
    const r = hiredSaddleRig(); G.addItem(r.w, boxOf(r.w, r.box), r.id("hide"), 8);
    G.addItem(r.w, r.p, r.id("fiber"), 8); G.addItem(r.w, r.p, r.id("flax"), 4);
    expect(settled(r).world.saddleGoal?.key).toBe("saddle_leather");
    const log: string[] = []; const order = ["saddle_up", "base_work", "craft"];
    for (let i = 0; i < 20000 && !r.w.getField(r.m, G.Mount, "saddle"); i++) {
      const cc = ctxOf(r); const o = out();
      const b = order.map(beh).find((x) => (x.name === "saddle_up" ? !!cc.world.saddleUp : x.name === "base_work" ? !!cc.world.plan?.step && (cc.world.plan.step.k !== "craft" || cc.world.plan.step.station !== 0) : cc.world.craftRecipe !== undefined) && (x.name !== "craft" || cc.self.tick - cc.bb.num("craftedAt", -1e9) >= 200));
      if (b) b.run(cc, o); apply(r, o, log); r.w.step(DT);
    }
    expect(r.w.getField(r.m, G.Mount, "saddle")).toBe(1);
    const first = (k: string): number => log.findIndex((x) => x.startsWith(k));
    expect(first("withdraw:hide")).toBeGreaterThanOrEqual(0);
    for (const k of ["craft:rope", "craft:leather", "craft:thread", "craft:saddle_leather"]) expect(first(k), k).toBeGreaterThanOrEqual(0);
    expect(first("craft:leather")).toBeLessThan(first("craft:saddle_leather"));
    expect(first("craft:saddle_leather")).toBeLessThan(first("msaddle"));
    expect(ctxOf(r).world.saddleGoal).toBeUndefined();
  });
  it("a hired worker with pending job work does NOT start the chain (Craft job with a tool to make)", () => {
    const r = rig({ job: G.WorkerJob.Craft }); ensureClaim(r.w, r.boss, 0, 0); place(r, "workbench", 3.5, 0.5);
    net(r.w, G.makeMount(r.w, "animal_horse", 6, 6, r.boss));
    G.addItem(r.w, r.p, r.id("wood"), 5); G.addItem(r.w, r.p, r.id("stone"), 5); G.addItem(r.w, r.p, r.id("fiber"), 2); // stone_axe is wood x3 + stone x2 + fiber x2, by hand
    const c = settled(r);
    expect(c.world.craftRecipe).toBeDefined(); // the job work is real and waiting
    expect(c.world.hire?.idle).toBe(false); expect(c.world.saddleGoal).toBeUndefined(); expect(c.world.plan?.goal).not.toBe("saddle_leather");
  });
  it("a hired Defend worker with a zombie at the anchor does NOT start the chain", () => {
    const r = rig({ job: G.WorkerJob.Defend }); ensureClaim(r.w, r.boss, 0, 0); place(r, "workbench", 3.5, 0.5);
    net(r.w, G.makeMount(r.w, "animal_horse", 6, 6, r.boss));
    G.spawnZombie(r.w, "zombie_walker", 2, 0);
    const c = settled(r);
    expect(c.world.defend).toBeDefined(); expect(c.world.hire?.idle).toBe(false); expect(c.world.saddleGoal).toBeUndefined();
  });
  it("a Follow worker never runs the chain (its duty is proximity, even standing next to the owner)", () => {
    const r = rig({ job: G.WorkerJob.Follow }); ensureClaim(r.w, r.boss, 0, 0); place(r, "workbench", 3.5, 0.5);
    net(r.w, G.makeMount(r.w, "animal_horse", 6, 6, r.boss));
    const c = settled(r);
    expect(c.world.hire?.idle).toBe(false); expect(c.world.saddleGoal).toBeUndefined();
  });
  it("never takes saddle materials from storage it may not use (a stranger's claimed box)", () => {
    const r = hiredSaddleRig(); G.addItem(r.w, r.p, r.id("stone_knife"), 1); // hide needs a skinning tool (else the plan chains the tool first)
    const other = net(r.w, pid(r.w, spawnLearned(r.w, { x: 30, y: 30, maxWeight: 0 }), 99)); ensureClaim(r.w, other, 30, 30);
    const theirs = place(r, "basic_storage_box", 30.5, 28.5, other); G.addItem(r.w, boxOf(r.w, theirs), r.id("hide"), 30);
    expect(G.mayTakeFromStorage(r.w, r.p, r.a, { piece: theirs, x: 30.5, y: 28.5 })).toBe(false);
    const c = settled(r); expect(c.world.saddleGoal?.key).toBe("saddle_leather");
    // the stranger's hide is not in the plan's stock: no withdraw from it, hide is a leaf / hunt instead
    expect(c.world.plan?.step?.k).not.toBe("withdraw");
    expect([...(c.world.plan?.leaves ?? []), ...(c.world.plan?.hunt ?? [])]).toContain(r.id("hide"));
    // ...while the employer's own box IS used when it holds the hide
    G.addItem(r.w, boxOf(r.w, r.box), r.id("hide"), 8); r.a.bb.set("saddleGoalScanAt", -1e9); steps(r.w, 11);
    expect(ctxOf(r).world.plan?.step).toMatchObject({ k: "withdraw", item: r.id("hide") });
  });
  it("picks the best tier its stations afford and falls back a tier when that plan times out", () => {
    const r = hiredSaddleRig(["workbench", "campfire", "furnace", "anvil"]);
    const c = settled(r); expect(c.world.saddleGoal).toMatchObject({ key: "saddle_steel", tier: 4 });
    r.a.bb.set("saddleGoal", { ...c.world.saddleGoal!, since: r.w.tick - B.saddlePlanTimeoutTicks - 1 });
    ctxOf(r); expect(r.a.bb.get<Record<number, number>>("saddleTierBans")![4]).toBeGreaterThan(r.w.tick);
    steps(r.w, B.saddleScanEveryTicks); expect(ctxOf(r).world.saddleGoal).toMatchObject({ key: "saddle_iron", tier: 3 });
  });
  it("abandons the plan for danger / low needs, drops the plan too, retries later, and falls back after repeated abandons", () => {
    const r = hiredSaddleRig(); expect(settled(r).world.saddleGoal?.tier).toBe(1);
    const sv = r.w.get(r.p, G.Survival)!; r.w.set(r.p, G.Survival, { hunger: 10 });
    const c = ctxOf(r); expect(c.world.saddleGoal).toBeUndefined(); expect(c.world.plan?.goal).not.toBe("saddle_leather");
    expect(r.a.bb.num("saddleRetryAt", 0)).toBe(r.w.tick + B.saddlePlanRetryTicks);
    r.w.set(r.p, G.Survival, { hunger: sv.hunger }); steps(r.w, B.saddleScanEveryTicks); expect(ctxOf(r).world.saddleGoal).toBeUndefined(); // still waiting out the retry
    steps(r.w, B.saddlePlanRetryTicks); expect(ctxOf(r).world.saddleGoal?.tier).toBe(1); // calm again: picked back up
    r.w.set(r.p, G.Survival, { hunger: 10 }); ctxOf(r); // second abandon of tier 1 -> banned (no lower tier left: no plan)
    expect(r.a.bb.get<Record<number, number>>("saddleTierBans")![1]).toBeGreaterThan(r.w.tick);
    r.w.set(r.p, G.Survival, { hunger: sv.hunger }); steps(r.w, B.saddlePlanRetryTicks + B.saddleScanEveryTicks); expect(ctxOf(r).world.saddleGoal).toBeUndefined();
  });
  it("is deterministic: same world, same goal and same plan", () => {
    const run = (): string => { const r = hiredSaddleRig(); G.addItem(r.w, boxOf(r.w, r.box), r.id("hide"), 8); const c = settled(r); return JSON.stringify([c.world.saddleGoal, c.world.plan?.step, c.world.plan?.leaves]); };
    expect(run()).toBe(run());
  });
  it("caps the recipe depth for the hired plan too: a chain deeper than planMaxDepth is not planned", () => {
    const r = hiredSaddleRig(); const d = G.gameplayDefs(r.w); const view = settled(r).world;
    const at = (maxDepth: number) => makePlan({ world: r.w, self: r.p, defs: d, base: view.base!, bs: view.bs!, fails: {}, priority: [{ key: "saddle_leather", count: 1 }], onlyPriority: true, maxDepth });
    const p6 = at(B.planMaxDepth), p1 = at(1);
    expect(p6.goal).toBe("saddle_leather"); expect(p6.leaves.length + p6.hunt.length).toBeGreaterThan(0);
    expect(p1.goal).toBe("idle");
  });
});
