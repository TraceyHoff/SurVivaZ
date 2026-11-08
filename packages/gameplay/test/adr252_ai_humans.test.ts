/**
 * ADR-252: AI humans finished: ADR-250 storage ladder (campfire -> basic storage box -> workbench), ADR-221 gating,
 * one container action per think tick, ADR-244 stances (block / crouch / sleep in a bed), ADR-238 (no ground-bag
 * perception), ADR-247 seeds kept, ADR-239 winter fuel, ADR-217 held light (torch goal).
 */
import { describe, expect, it } from "vitest";
import { Transform, setSeason, setTimeOfDay, type AgentOutput, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, plantClaim, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
const pid = (k: string) => d.pieceId(k);
const iid = (k: string) => d.itemId(k);
const BASE = { x: 10, y: 10 };
function fresh(learned = true): { w: World; p: Entity } {
  const w = makeWorld(); const p = learned ? spawnLearned(w, { x: BASE.x + 1, y: BASE.y + 3.3, maxWeight: 0, clientId: 1 }) : G.spawnPlayer(w, { x: BASE.x + 1, y: BASE.y + 3.3, maxWeight: 0, clientId: 1 }); steps(w, 1); plantClaim(w, p, BASE.x - 2, BASE.y - 2); return { w, p };
}
const give = (w: World, e: Entity, key: string, tier = 0): void => { const def = d.pieces.get(pid(key))!; for (const c of G.pieceCost(d, def, def.tiered ? tier : def.fixedTier)) G.addItem(w, e, c.item, c.count); };
const put = (w: World, e: Entity, key: string, x: number, y: number, level = 0, rot = 0, tier?: number, stand?: { x: number; y: number }) => {
  const def = d.pieces.get(pid(key))!; const t = tier ?? (def.tiered ? 0 : def.fixedTier); give(w, e, key, t);
  w.set(e, Transform, stand ?? { x, y: y + 1.2 }); // stand in reach like the planner's build stand
  return G.tryPlace(w, e, { piece: pid(key), x, y, level, rot, tier: t, variant: 0 });
};
const STAND = { x: BASE.x + G.BUILD_STAND.x, y: BASE.y + G.BUILD_STAND.y };
const plan = (w: World, p: Entity, extra: Partial<G.PlanInput> = {}) => { const bs = G.scanBase(w, d, BASE); return G.makePlan({ world: w, self: p, defs: d, base: BASE, bs, fails: {}, ...extra }); };
const tools = (w: World, p: Entity) => { G.addItem(w, p, iid("stone_axe"), 1); G.addItem(w, p, iid("stone_pickaxe"), 1); };
const goalIdx = (pred: (g: (typeof G.GOAL_LADDER)[number]) => boolean) => G.GOAL_LADDER.findIndex(pred);
const fakeCtx = (over: Record<string, unknown> = {}) => {
  const bb = new Map<string, unknown>();
  const c = { self: { x: 0, y: 0, tick: 0, stamina: 1, ...(over.self as object) }, world: { ...(over.world as object) }, memory: { nearest: () => over.zombie },
    bb: { get: (k: string) => bb.get(k), set: (k: string, v: unknown) => { if (v === undefined) bb.delete(k); else bb.set(k, v); }, num: (k: string, def = 0) => (typeof bb.get(k) === "number" ? (bb.get(k) as number) : def) } };
  return c as never as Parameters<typeof G.stancePolicy>[0] & { self: { tick: number; stamina: number; x: number; y: number }; world: G.StanceSensors };
};
const out = (): AgentOutput => ({ moveX: 0.5, moveY: 0, aimX: 0, aimY: 0, sprint: false, actions: [] });

describe("ADR-252 build ladder: campfire -> basic storage box -> workbench (ADR-250)", () => {
  it("the ladder lists the campfire, then the starter box, then the workbench; the box has slot-table spots", () => {
    const fire = goalIdx((g) => g.k === "piece" && g.key === "campfire"), box = goalIdx((g) => g.k === "piece" && g.key === G.STARTER_STORAGE_PIECE), wb = goalIdx((g) => g.k === "piece" && g.key === "workbench");
    expect(fire).toBeGreaterThanOrEqual(0); expect(box).toBe(fire + 1); expect(wb).toBeGreaterThan(box);
    expect(G.STARTER_STORAGE_PIECE).toBe("basic_storage_box"); expect(G.STATION_SLOTS.basic_storage_box?.length).toBeGreaterThan(0);
    expect(G.GOAL_LADDER.some((g) => g.k === "piece" && g.key === "storage_box")).toBe(false); // the ADR-250 box replaced the old storage goal
  });
  it("a planner walk: tools -> campfire -> basic box -> workbench, each placed where the planner says", () => {
    const { w, p } = fresh(); tools(w, p); for (const k of ["campfire", "basic_storage_box", "workbench"]) give(w, p, k); G.addItem(w, p, iid("wood"), G.WOOD_RESERVE + 8);
    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      const pl = plan(w, p); order.push(pl.goal);
      const key = pl.goal; const def = d.pieces.get(pid(key))!;
      const s = pl.step; expect(s?.k, `${key}: ${JSON.stringify(pl)}`).toBe("build");
      if (s?.k !== "build") break; w.set(p, Transform, { x: s.stand.x, y: s.stand.y });
      expect(G.tryPlace(w, p, { piece: def.id, x: s.x, y: s.y, level: s.level, rot: 0, tier: def.fixedTier, variant: 0 }).ok, key).toBe(true);
      steps(w, 25);
    }
    expect(order).toEqual(["campfire", "basic_storage_box", "workbench"]);
    const bs = G.scanBase(w, d, BASE); expect(bs.storage).toBeDefined(); expect(G.isBaseStoragePiece(d.pieces.get(w.getField(bs.storage!.id, G.BuildPiece, "type")!))).toBe(true);
  });
  it("any other ADR-250 base storage piece that stands on the ground satisfies the box goal", () => {
    const { w, p } = fresh(); tools(w, p);
    expect(put(w, p, "campfire", BASE.x + 3.5, BASE.y + 0.5).ok).toBe(true); steps(w, 25);
    let placed: string | undefined;
    for (const def of d.pieces.values()) {
      if (!G.isBaseStoragePiece(def) || def.key === G.STARTER_STORAGE_PIECE) continue;
      if (put(w, p, def.key, BASE.x - 1.6, BASE.y - 0.7).ok) { placed = def.key; break; }
    }
    expect(placed).toBeDefined(); steps(w, 25);
    expect(plan(w, p).goal).not.toBe("basic_storage_box");
  });
});

describe("ADR-252 ADR-221 gating", () => {
  it("a fresh (unlearned) bot: the locked campfire holds every later build goal (no box before the fire); learned, it builds in order", () => {
    const { w, p } = fresh(false); tools(w, p); for (const k of ["campfire", "basic_storage_box"]) give(w, p, k); G.addItem(w, p, iid("wood"), 16);
    const cf = d.pieces.get(pid("campfire"))!; expect(G.pieceUnlocked(w, p, cf, cf.fixedTier)).toBe(false);
    expect(G.pieceUnlocked(w, p, d.pieces.get(pid(G.STARTER_STORAGE_PIECE))!, 1)).toBe(true); // ADR-250: never gated
    let pl = plan(w, p); expect(pl.step?.k === "build").toBe(false); expect(pl.goal).not.toBe("basic_storage_box"); expect(pl.blocked).toContain("locked:campfire");
    G.grantSkillUnlocks(w, p); // what skill_pick learns first
    pl = plan(w, p); expect(pl.goal).toBe("campfire"); expect(pl.step?.k).toBe("build");
  });
  it("the locked workbench holds the base / bed builds after it (ADR-221 order kept)", () => {
    const { w, p } = fresh(); tools(w, p);
    expect(put(w, p, "campfire", BASE.x + 3.5, BASE.y + 0.5).ok).toBe(true); expect(put(w, p, "basic_storage_box", BASE.x + 3.5, BASE.y + 1.6).ok).toBe(true); steps(w, 25);
    const wb = d.pieces.get(pid("workbench"))!; const r = new Set<string>();
    const pl = G.makePlan({ world: w, self: p, defs: d, base: BASE, bs: G.scanBase(w, d, BASE), fails: {} }); r.add(pl.goal);
    expect(G.pieceUnlocked(w, p, wb, wb.fixedTier)).toBe(true); expect(["wood", "workbench"]).toContain(pl.goal);
  });
});

describe("ADR-252 one container action per think tick", () => {
  it("storage API sequences are open -> one op -> close", () => {
    expect(G.storageDepositActions(7 as Entity, 3, 5)).toEqual(["copen:7", "cdeposit:7:3:5", "cclose"]);
    expect(G.storageWithdrawActions(7 as Entity, 3, 5)).toEqual(["copen:7", "cwithdraw:7:3:5", "cclose"]);
    expect(G.CONTAINER_STEP).toBeGreaterThanOrEqual(10); // one think (thinkEvery 10) per action
  });
});

describe("ADR-252 stances (ADR-244)", () => {
  it("agentStanceInput maps block / crouch / rest to Guard / Crouch / Rest and nothing else", () => {
    expect(G.agentStanceInput({ actions: ["block"] })).toEqual({ guard: true, crouch: false, rest: false });
    expect(G.agentStanceInput({ actions: ["crouch", "rest", "gather"] })).toEqual({ guard: false, crouch: true, rest: true });
    expect(G.agentStanceInput({ actions: ["sleep", "gather"] })).toEqual({ guard: false, crouch: false, rest: false });
    for (const a of ["block", "crouch", "rest"]) { expect(G.actionIntent(a)).toBeUndefined(); expect(G.actionCommand(a)).toBeUndefined(); }
  });
  it("defend strikes, then guards while stamina lasts, then strikes again", () => {
    const c = fakeCtx(); const seq: string[] = [];
    for (let t = 0; t < 60; t += 10) { c.self.tick = t; seq.push(G.defendAction(c as never)); }
    expect(seq).toEqual(["gather", "block", "block", "gather", "block", "block"]);
    c.self.stamina = 0.1; c.self.tick = 70; expect(G.defendAction(c as never)).toBe("gather"); // winded: no guard
  });
  it("defend emits a targeted combat attack, never hand/interact, then holds guard", () => {
    const ctx = fakeCtx({ zombie: { id: 7, x: 1, y: 0 }, self: { hp: 1 } });
    const c = { ...ctx, world: { ...ctx.world, seen: [], home: { x: 0, y: 0 }, playerName: "AI" } };
    const defend = G.autonomyBehaviors().find((b) => b.name === "defend")!;
    let o = out(); defend.run(c, o); expect(o.actions).toEqual(["attack:7"]); expect(o.moveX).toBe(0); expect(o.aimX).toBe(1);
    c.self.tick = 20; o = out(); defend.run(c, o); expect(o.actions).toEqual(["block"]);
  });
  it("sneak: crouch toggles when a zombie lurks 4..10 tiles away, at most every CROUCH_EVERY ticks; stands up beyond 13", () => {
    const c = fakeCtx({ zombie: { x: 7, y: 0 } }); let o = out(); G.stancePolicy(c, o, "gather"); expect(o.actions).toEqual(["crouch"]);
    c.world.crouched = false; c.self.tick = 10; o = out(); G.stancePolicy(c, o, "gather"); expect(o.actions).toEqual([]); // throttled
    c.world.crouched = true; c.self.tick = 100; o = out(); G.stancePolicy(c, o, "gather"); expect(o.actions).toEqual([]); // crouched: stay
    o = out(); G.stancePolicy(c, o, "defend"); c.self.tick = 200; o = out(); G.stancePolicy(c, o, "defend"); expect(o.actions).toEqual(["crouch"]); // fighting: stand up
    const far = fakeCtx({ zombie: { x: 20, y: 0 }, world: { crouched: false } }); o = out(); G.stancePolicy(far, o, "gather"); expect(o.actions).toEqual([]);
  });
  it("asleep in the sleep behaviour: no movement, no wake inputs", () => {
    const c = fakeCtx({ world: { stance: G.StanceMode.Sleep } }); const o = out(); o.actions = ["sleep", "gather", "block", "crouch"]; o.sprint = true;
    G.stancePolicy(c, o, "sleep"); expect(o.moveX).toBe(0); expect(o.sprint).toBe(false); expect(o.actions).toEqual(["sleep"]);
  });
  it("the bed slot is a valid placement inside a complete base; scanBase finds it and the bed is in reach of the hearth-side stand", () => {
    const { w, p } = fresh(); setTimeOfDay(w, 12);
    for (const sl of G.BASE_SLOTS) { const r = put(w, p, sl.key, BASE.x + sl.x, BASE.y + sl.y, sl.level, sl.rot ?? 0, sl.tier ?? 0, STAND); expect(r.ok, `${sl.id}: ${JSON.stringify(r)}`).toBe(true); steps(w, 2); }
    steps(w, 25); expect(G.scanBase(w, d, BASE).complete).toBe(true);
    const pl = plan(w, p, { bs: { ...G.scanBase(w, d, BASE) } }); void pl;
    w.set(p, Transform, { x: BASE.x + G.DOOR_IN.x, y: BASE.y + G.DOOR_IN.y });
    give(w, p, "bed"); const r = G.tryPlace(w, p, { piece: pid("bed"), x: BASE.x + G.BED_SLOT.x, y: BASE.y + G.BED_SLOT.y, level: 0, rot: 0, tier: d.pieces.get(pid("bed"))!.fixedTier, variant: 0 });
    expect(r.ok, JSON.stringify(r)).toBe(true); steps(w, 25);
    const bs = G.scanBase(w, d, BASE); expect(bs.bed).toBeDefined(); expect(bs.complete).toBe(true);
    expect(G.bedNear(w, p)).toBeDefined(); // the Rest edge from the stand finds the bed
  });
  it("the planner's bed goal builds the bed at BED_SLOT once the base is complete (stand inside, by the door)", () => {
    const { w, p } = fresh(); tools(w, p);
    for (const sl of G.BASE_SLOTS) expect(put(w, p, sl.key, BASE.x + sl.x, BASE.y + sl.y, sl.level, sl.rot ?? 0, sl.tier ?? 0, STAND).ok).toBe(true);
    expect(put(w, p, "campfire", BASE.x + G.HEARTH.x, BASE.y + G.HEARTH.y, 0, 0, undefined, { x: BASE.x + G.DOOR_IN.x, y: BASE.y + G.DOOR_IN.y }).ok).toBe(true);
    steps(w, 25); const bs = G.scanBase(w, d, BASE); expect(bs.complete).toBe(true); expect(bs.hearth).toBeDefined();
    give(w, p, "bed");
    const order = G.GOAL_LADDER.findIndex((g) => g.k === "bed"); expect(order).toBeGreaterThan(G.GOAL_LADDER.findIndex((g) => g.k === "hearth"));
    const s = G.makePlan({ world: w, self: p, defs: d, base: BASE, bs, fails: { basic_storage_box0: 9, basic_storage_box1: 9 }, snooze: { basic_storage_box: 1e9, workbench: 1e9, "wear:torch": 1e9, wood: 1e9 } });
    expect(s.goal).toBe("bed"); expect(s.step).toMatchObject({ k: "build", piece: pid("bed"), x: BASE.x + G.BED_SLOT.x, y: BASE.y + G.BED_SLOT.y, stand: { x: BASE.x + G.DOOR_IN.x, y: BASE.y + G.DOOR_IN.y } });
  });
});

describe("ADR-252 ADR-239 winter, ADR-217 held light, ADR-247 seeds", () => {
  it("isWinter follows the season; in winter a cold fire is fuelled (WINTER_WOOD) before the storage box", () => {
    const { w, p } = fresh(); tools(w, p); expect(G.isWinter(w)).toBe(false);
    setSeason(w, 2, 0.2); expect(G.isWinter(w)).toBe(true); setSeason(w, 0, 0.2);
    expect(put(w, p, "campfire", BASE.x + 3.5, BASE.y + 0.5).ok).toBe(true); steps(w, 25);
    expect(plan(w, p).goal).toBe("basic_storage_box");
    const win = plan(w, p, { winter: true }); expect(win.goal).toBe("wood"); expect(win.leaves).toContain(iid("wood"));
    G.addItem(w, p, iid("wood"), G.WINTER_WOOD + 8); expect(plan(w, p, { winter: true }).goal).toBe("basic_storage_box"); // stocked: back to the ladder
  });
  it("winter with no fire at all: axe and campfire first", () => {
    const { w, p } = fresh(); expect(["axe", "campfire"]).toContain(plan(w, p, { winter: true }).goal);
  });
  it("a torch is worn (off hand) after the workbench: the planner wears one from the bag", () => {
    const t = goalIdx((g) => g.k === "wear" && g.key === "torch"); expect(t).toBeGreaterThan(goalIdx((g) => g.k === "piece" && g.key === "workbench"));
    expect(d.items.get(iid("torch"))!.heldLight).toBeGreaterThan(0); expect(d.items.get(iid("torch"))!.wear).toBeDefined();
    const { w, p } = fresh(); tools(w, p);
    for (const [k, x, y] of [["campfire", 3.5, 0.5], ["basic_storage_box", 3.5, 1.6], ["workbench", -1.6, -0.7]] as const) { expect(put(w, p, k, BASE.x + x, BASE.y + y).ok, k).toBe(true); steps(w, 25); }
    G.addItem(w, p, iid("wood"), 40); G.addItem(w, p, iid("torch"), 1);
    const pl = plan(w, p); expect(pl.goal).toBe("wear:torch"); expect(pl.step?.k).toBe("wear");
  });
  it("every plantable seed is a seed item (kept / stashed, never dropped as junk); produce is not", () => {
    for (const pl of G.FARMING.plantables) { const id = d.items.get(iid(pl.seed)); if (id) expect(G.isSeedItem(d, id.id), pl.seed).toBe(true); }
    expect(G.isSeedItem(d, iid("berry_seeds"))).toBe(true); expect(G.isSeedItem(d, iid("wood"))).toBe(false); expect(G.isSeedItem(d, iid("blueberry"))).toBe(false);
  });
});

describe("ADR-252 base site claims (two bots picking in the same window)", () => {
  it("a second agent never settles within SITE_SPACING of a site another agent claimed (no pieces down yet)", () => {
    const w = makeWorld(); const p = spawnLearned(w, { x: BASE.x + 1, y: BASE.y + 3.3, maxWeight: 0, clientId: 1 }); const q = spawnLearned(w, { x: BASE.x + 1, y: BASE.y + 3.3, maxWeight: 0, clientId: 2 }); steps(w, 1);
    const near = { x: BASE.x + 1, y: BASE.y + 3.3 };
    const a = G.pickBaseSite(w, p, near, 0.25)!; expect(a).toBeDefined();
    expect(G.pickBaseSite(w, q, near, 0.25)).toEqual(a); // unclaimed: the same empty spot looks fine to both
    G.claimBaseSite(w, p, a);
    const b = G.pickBaseSite(w, q, near, 0.25);
    expect(b).toBeDefined(); expect(Math.hypot(b!.x - a.x, b!.y - a.y)).toBeGreaterThanOrEqual(G.SITE_SPACING);
    expect(G.pickBaseSite(w, p, near, 0.25)).toEqual(a); // the owner's own claim never blocks it
    G.claimBaseSite(w, p, undefined); expect(G.pickBaseSite(w, q, near, 0.25)).toEqual(a); // released (relocation)
  });
});
