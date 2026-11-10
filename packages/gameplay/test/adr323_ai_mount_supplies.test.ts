// ADR-323: AI humans fetch liked mount food from allowed storage (else forage it) and plan saddle materials from raw.
import { describe, expect, it } from "vitest";
import { idleOutput, installPermissions, NetId, PlayerId, Transform, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { aiMemoryOf, makePlan } from "../src/ai/planner.js";
import { baseBehaviors } from "../src/ai/base_behaviors.js";
import { DT, ensureClaim, makeWorld, spawnLearned, steps } from "./helpers.js";

const B = G.MOUNT_BOTS;
let nid = 7000;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };
const pid = (w: World, e: Entity, id: number): Entity => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); return e; };
interface Rig { w: World; p: Entity; a: Agent; id: (k: string) => number; home: { x: number; y: number } }
function rig(opts: { pid?: number; seed?: number; base?: { x: number; y: number } } = {}): Rig {
  const w = makeWorld({}, opts.seed ?? 42); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }); pid(w, p, opts.pid ?? 7); net(w, p);
  const a = G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1); const d = G.gameplayDefs(w);
  if (opts.base) aiMemoryOf(a).base = opts.base;
  return { w, p, a, id: (k) => d.itemId(k), home: { x: 0, y: 0 } };
}
type Ctx = AgentContext<G.AgentWorldView>;
const ctxOf = (r: Rig): Ctx => { const v = G.buildAgentView(r.w, r.p, r.a, r.home)!; return { self: v.self, bb: r.a.bb, memory: r.a.memory, traits: { ...r.a.identity.traits }, rng: r.a.rng, agent: r.a, world: v.world }; };
/** View after one full sense cycle (goal sensors are cached SENSE_EVERY ticks; the mount pass feeds the next one). */
const settled = (r: Rig): Ctx => { ctxOf(r); steps(r.w, 11); return ctxOf(r); };
const out = (): AgentOutput & { commands?: G.AgentCommand[] } => ({ ...idleOutput(), actions: [] as string[] });
const place = (r: Rig, key: string, x: number, y: number, by: Entity = r.p): Entity => {
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

describe("ADR-323 liked food from storage", () => {
  it("fetches carrots from its own home box (only what taming needs + the buffer), then sets out to tame", () => {
    const r = rig({ base: { x: -1, y: -1 } }); const horse = G.spawnAnimal(r.w, "animal_horse", 9, 0);
    const box = place(r, "basic_storage_box", 1.5, 0.5); G.addItem(r.w, boxOf(r.w, box), r.id("carrot"), 30);
    const c = settled(r); expect(c.world.tameMount).toBeUndefined();
    expect(c.world.mountFood).toMatchObject({ piece: box, item: r.id("carrot"), count: B.tameFoodCount + B.foodBuffer, why: "tame" });
    const log: string[] = []; const b = beh("fetch_mount_food");
    for (let i = 0; i < 400 && G.countItem(r.w, r.p, r.id("carrot")) === 0; i++) { const cc = ctxOf(r); const o = out(); b.run(cc, o); apply(r, o, log); r.w.step(DT); }
    expect(log).toEqual([`withdraw:carrot:${B.tameFoodCount + B.foodBuffer}`]);
    expect(G.countItem(r.w, r.p, r.id("carrot"))).toBe(B.tameFoodCount + B.foodBuffer); expect(G.countItem(r.w, boxOf(r.w, box), r.id("carrot"))).toBe(30 - 8);
    r.a.bb.set("tameScanAt", -1e9); const after = ctxOf(r); expect(after.world.mountFood).toBeUndefined(); expect(after.world.tameMount?.id).toBe(horse);
  });
  it("feeds its own hurt mount from a box in its own claim", () => {
    const r = rig(); ensureClaim(r.w, r.p, 0, 0); const m = net(r.w, G.makeMount(r.w, "animal_horse", 2, 0, r.p));
    r.w.set(m, G.Health, { hp: r.w.get(m, G.Health)!.max * 0.3 });
    const box = place(r, "basic_storage_box", 3.5, 2.5); G.addItem(r.w, boxOf(r.w, box), r.id("apple"), 5);
    const c = settled(r); expect(c.world.mount?.id).toBe(m); expect(c.world.mountFood).toMatchObject({ piece: box, item: r.id("apple"), count: B.feedFoodCount + B.foodBuffer, why: "feed" });
  });
  it("never takes from someone else's storage: a stranger's claimed box or an unclaimed box away from home", () => {
    const r = rig({ base: { x: -20, y: -20 } }); r.w.set(r.p, Transform, { x: -52, y: 0 }); const m = net(r.w, G.makeMount(r.w, "animal_horse", -50, 0, r.p)); r.w.set(m, G.Health, { hp: r.w.get(m, G.Health)!.max * 0.3 });
    const other = net(r.w, pid(r.w, spawnLearned(r.w, { x: 6, y: 6, maxWeight: 0 }), 99)); ensureClaim(r.w, other, 6, 6);
    const theirs = place(r, "basic_storage_box", 6.5, 4.5, other); G.addItem(r.w, boxOf(r.w, theirs), r.id("carrot"), 30);
    const stray = place(r, "basic_storage_box", -60.5, 0.5); G.addItem(r.w, boxOf(r.w, stray), r.id("carrot"), 30); // unclaimed, nowhere near its home
    expect(G.zonesAt(r.w, -60.5, 0.5).length).toBe(0);
    let c = settled(r); expect(c.world.mount?.id).toBe(m); expect(c.world.mountFood).toBeUndefined(); expect(c.world.mountForage).toContain(r.id("carrot"));
    expect(G.mayTakeFromStorage(r.w, r.p, r.a, G.nearbyStorage(r.w, r.p, 24)[0]!)).toBe(false);
    r.w.set(r.p, Transform, { x: 2, y: 2 }); r.w.set(m, Transform, { x: 3, y: 2 }); r.a.bb.set("foodScanAt", -1e9); c = settled(r); expect(c.world.mountFood).toBeUndefined(); // the stranger's claimed box
    expect(G.mayTakeFromStorage(r.w, r.p, r.a, { piece: theirs, x: 6.5, y: 4.5 })).toBe(false);
  });
  it("a hired worker takes from its employer's stash (employer's claim at the work home)", () => {
    const r = rig({ pid: 55 }); const boss = net(r.w, pid(r.w, spawnLearned(r.w, { x: 4, y: 4, maxWeight: 0 }), 7)); ensureClaim(r.w, boss, 4, 4);
    r.w.add(r.p, G.Worker, { owner: 7, homeX: 4, homeY: 4 } as never);
    const stash = place(r, "basic_storage_box", 4.5, 2.5, boss); G.addItem(r.w, boxOf(r.w, stash), r.id("carrot"), 30);
    G.spawnAnimal(r.w, "animal_horse", 9, 0);
    const c = settled(r); expect(c.world.mountFood).toMatchObject({ piece: stash, item: r.id("carrot") });
    expect(G.mayTakeFromStorage(r.w, r.p, r.a, { piece: stash, x: 4.5, y: 2.5 })).toBe(true);
    // the same box is off limits to a bot that does not work for player 7
    const s = rig({ pid: 56 }); const b2 = net(s.w, pid(s.w, spawnLearned(s.w, { x: 4, y: 4, maxWeight: 0 }), 7)); ensureClaim(s.w, b2, 4, 4);
    const st2 = place(s, "basic_storage_box", 4.5, 2.5, b2); expect(G.mayTakeFromStorage(s.w, s.p, s.a, { piece: st2, x: 4.5, y: 2.5 })).toBe(false);
  });
  it("forages liked food with the normal gather pick when no allowed storage holds any", () => {
    const r = rig({ base: { x: -1, y: -1 } }); G.spawnAnimal(r.w, "animal_horse", 9, 0);
    const node = G.spawnResourceNode(r.w, "wild_carrot", 6, -4); r.a.memory.see({ id: node, kind: "node", x: 6, y: -4, tick: r.w.tick });
    const c = settled(r); expect(c.world.mountFood).toBeUndefined(); expect(c.world.mountForage?.[0]).toBe(r.id("carrot"));
    expect(c.world.needs).toContain(r.id("carrot")); expect(c.world.gatherNode).toMatchObject({ id: node, wanted: true });
  });
});

describe("ADR-323 saddle materials", () => {
  /** A base at (0,0) with a workbench (and optionally more stations), a box, and a tamed horse with no saddle. */
  function saddleRig(stations: string[] = ["workbench"]): Rig & { m: Entity; box: Entity } {
    const r = rig({ base: { x: 0, y: 0 } }); ensureClaim(r.w, r.p, -4, -4);
    // the planner's own base layout slots (planner.STATION_SLOTS)
    const spots: Record<string, [number, number]> = { workbench: [3.5, 0.5], campfire: [2.6, 2.9], furnace: [-1.5, 0.5], anvil: [-1.5, 1.6] };
    for (const k of stations) place(r, k, ...spots[k]!);
    const box = place(r, "basic_storage_box", 3.5, 1.6); const m = net(r.w, G.makeMount(r.w, "animal_horse", 6, 6, r.p));
    return { ...r, m, box };
  }
  it("plans the leather saddle from raw hide / fiber / flax: withdraw the hide, craft rope (hand), leather + thread (workbench), the saddle, then equips it", () => {
    const r = saddleRig(); G.addItem(r.w, boxOf(r.w, r.box), r.id("hide"), 8);
    G.addItem(r.w, r.p, r.id("fiber"), 8); G.addItem(r.w, r.p, r.id("flax"), 4); // gathered raw (grass fiber, flax)
    const c = settled(r); expect(c.world.saddleGoal).toMatchObject({ key: "saddle_leather", tier: 1 }); // the only tier the base's stations afford
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
  it("without hide on hand (knife in the bag) the chain hands hide to the existing gather / hunt behaviours (needs)", () => {
    const r = saddleRig(); G.addItem(r.w, r.p, r.id("stone_knife"), 1); const c = settled(r); expect(c.world.saddleGoal?.key).toBe("saddle_leather");
    expect(c.world.plan?.goal).toBe("saddle_leather"); expect([...c.world.plan!.leaves, ...c.world.plan!.hunt]).toContain(r.id("hide")); // carcass skinning / hunting
    expect(c.world.needs).toContain(r.id("hide"));
  });
  it("picks the best tier its stations afford and falls back a tier when that plan times out", () => {
    const r = saddleRig(["workbench", "campfire", "furnace", "anvil"]);
    const c = settled(r); expect(c.world.saddleGoal).toMatchObject({ key: "saddle_steel", tier: 4 });
    r.a.bb.set("saddleGoal", { ...c.world.saddleGoal!, since: r.w.tick - B.saddlePlanTimeoutTicks - 1 });
    ctxOf(r); expect(r.a.bb.get<Record<number, number>>("saddleTierBans")![4]).toBeGreaterThan(r.w.tick);
    steps(r.w, B.saddleScanEveryTicks); expect(ctxOf(r).world.saddleGoal).toMatchObject({ key: "saddle_iron", tier: 3 });
  });
  it("abandons the plan for danger / low needs, retries later, and falls back after repeated abandons", () => {
    const r = saddleRig(); expect(settled(r).world.saddleGoal?.tier).toBe(1);
    const sv = r.w.get(r.p, G.Survival)!; r.w.set(r.p, G.Survival, { hunger: 10 });
    expect(ctxOf(r).world.saddleGoal).toBeUndefined(); expect(r.a.bb.num("saddleRetryAt", 0)).toBe(r.w.tick + B.saddlePlanRetryTicks);
    r.w.set(r.p, G.Survival, { hunger: sv.hunger }); steps(r.w, B.saddleScanEveryTicks); expect(ctxOf(r).world.saddleGoal).toBeUndefined(); // still waiting out the retry
    steps(r.w, B.saddlePlanRetryTicks); expect(ctxOf(r).world.saddleGoal?.tier).toBe(1); // calm again: picked back up
    r.w.set(r.p, G.Survival, { hunger: 10 }); ctxOf(r); // second abandon of tier 1 -> banned (no lower tier left: no plan)
    expect(r.a.bb.get<Record<number, number>>("saddleTierBans")![1]).toBeGreaterThan(r.w.tick);
    r.w.set(r.p, G.Survival, { hunger: sv.hunger }); steps(r.w, B.saddlePlanRetryTicks + B.saddleScanEveryTicks); expect(ctxOf(r).world.saddleGoal).toBeUndefined();
  });
  it("caps the recipe depth: a chain deeper than planMaxDepth is not planned", () => {
    const r = saddleRig(); const d = G.gameplayDefs(r.w); const view = settled(r).world;
    const at = (maxDepth: number) => makePlan({ world: r.w, self: r.p, defs: d, base: view.base!, bs: view.bs!, fails: {}, priority: [{ key: "saddle_leather", count: 1 }], onlyPriority: true, maxDepth });
    const p6 = at(B.planMaxDepth), p1 = at(1);
    expect(p6.goal).toBe("saddle_leather"); expect(p6.leaves.length + p6.hunt.length).toBeGreaterThan(0);
    expect(p1.goal).toBe("idle"); // depth 1: the saddle's own ingredients cannot be chained
  });
  it("is deterministic: same world, same goal and same plan", () => {
    const run = (): string => { const r = saddleRig(); G.addItem(r.w, boxOf(r.w, r.box), r.id("hide"), 8); const c = settled(r); return JSON.stringify([c.world.saddleGoal, c.world.plan?.step, c.world.plan?.leaves]); };
    expect(run()).toBe(run());
  });
});
