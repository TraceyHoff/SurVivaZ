/**
 * ADR-342: turret ammo stocking. Each turret type stocks its own ammo from the bot's bag or its
 * own / employer's base storage (mayTakeFromStorage rules — never anyone else's box), only the
 * surplus above the data reserve, one trip per turret; never while a survival need is unmet or
 * while the planner has a higher-priority step; hired workers stock the employer's turrets.
 */
import { describe, expect, it } from "vitest";
import { installPermissions, PlayerId, Transform, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import * as D from "../src/ai/defence.js";
import { makeWorld, plantClaim, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
const pid = (k: string) => d.pieceId(k);
const iid = (k: string) => d.itemId(k);
const BASE = { x: 10, y: 10 };
const TURRET_AT = { x: BASE.x - 4, y: BASE.y - 4 }; // turretOffsets[0]
const BOX_AT = { x: BASE.x + 3.5, y: BASE.y + 1.6 };

function fresh(claim = true): { w: World; p: Entity; agent: Agent } {
  const w = makeWorld(); installPermissions(w); // registers PlayerId (adr259 pattern)
  const p = spawnLearned(w, { x: BASE.x + 1, y: BASE.y + 3.3, maxWeight: 0, clientId: 1 });
  w.add(p, PlayerId, { id: 9 });
  steps(w, 1);
  if (claim) plantClaim(w, p, BASE.x - 2, BASE.y - 2);
  const agent = G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1);
  return { w, p, agent };
}
/** Really place a piece (bot has every unlock) and let the world settle. */
const place = (w: World, p: Entity, key: string, x: number, y: number): Entity => {
  const def = d.pieces.get(pid(key))!;
  const sn = G.snapPlacement(w, { piece: def.id, x, y, level: 0, rot: 0, tier: def.fixedTier, variant: 0 });
  if (typeof sn === "number") throw new Error(`${key} snap failed: ${sn}`);
  const e = G.placePiece(w, p, sn, { pay: false });
  steps(w, 25);
  return e;
};
const boxWith = (w: World, p: Entity, items: [string, number][]): { box: Entity; att: Entity } => {
  const box = place(w, p, "basic_storage_box", BOX_AT.x, BOX_AT.y);
  const att = G.resolveAttachment(w, box, G.AttachKind.Storage)!;
  for (const [k, n] of items) G.addItem(w, att, iid(k), n);
  steps(w, 25);
  return { box, att };
};
const turretWith = (w: World, p: Entity, key: string, items: [string, number][] = []): { turret: Entity; att: Entity } => {
  const turret = place(w, p, key, TURRET_AT.x, TURRET_AT.y);
  const att = G.resolveAttachment(w, turret, G.AttachKind.Storage)!;
  for (const [k, n] of items) G.addItem(w, att, iid(k), n);
  steps(w, 25);
  return { turret, att };
};
const viewFor = (w: World, over: Record<string, unknown> = {}): G.AgentWorldView & D.DefenceSensors => {
  const bs = G.scanBase(w, d, BASE);
  return { seen: [], home: { x: BASE.x + 1, y: BASE.y + 1 }, playerName: "tester", base: BASE, bs, plan: { goal: "idle", leaves: [], hunt: [], keep: new Set<number>(), blocked: [] }, ...over } as unknown as G.AgentWorldView & D.DefenceSensors;
};
const out = (): AgentOutput => ({ moveX: 0, moveY: 0, aimX: 0, aimY: 0, sprint: false, actions: [] });
const ctxFor = (w: World, agent: Agent, view: G.AgentWorldView, tick = 0, hunger = 1): AgentContext<G.AgentWorldView> => {
  const self = { x: BASE.x + 1, y: BASE.y + 3.3, tick, facing: 0, hp: 1, hunger, thirst: 1, stamina: 1, dayT: 0.5, phase: "day" };
  return { self, world: view, memory: agent.memory, bb: agent.bb, traits: agent.identity.traits, rng: agent.rng, agent } as unknown as AgentContext<G.AgentWorldView>;
};
const pickFor = (w: World, p: Entity, bs?: G.BaseState, leaves = new Set<number>()): D.TurretAmmoTarget | undefined => {
  const claim = D.ownClaim(w, p, BASE.x + 1, BASE.y + 1)!;
  return D.pickTurretAmmo({ world: w, self: p, defs: d, claim, ...(bs ? { bs } : {}), leaves, home: { x: BASE.x + 1, y: BASE.y + 1 } });
};
const stockBehaviour = () => D.defenceBehaviors().find((b) => b.name === "stock_turret")!;

describe("ADR-342 data: knobs and what each turret shoots", () => {
  it("ammo knobs live in ai_defence.json, not in code", () => {
    expect(D.DEFENCE_DATA.ammoTargetCount).toBe(20);
    expect(D.DEFENCE_DATA.ammoLowFraction).toBe(0.25);
    expect(D.DEFENCE_DATA.ammoCooldownTicks).toBe(600);
    expect(D.DEFENCE_DATA.ammoHomeTiles).toBe(5);
  });
  it("each turret type consumes its own ammo, stored in the piece's 4-slot container", () => {
    expect(d.pieces.get(pid("arrow_turret"))!.features.turret!.ammo).toEqual(["flint_arrow", "iron_arrow", "fire_arrow"]);
    expect(d.pieces.get(pid("bolt_turret"))!.features.turret!.ammo).toEqual(["iron_bolt", "steel_bolt"]);
    expect(d.pieces.get(pid("flame_turret"))!.features.turret!.ammo).toEqual(["crude_oil", "lamp_oil"]);
    expect(d.pieces.get(pid("arrow_turret"))!.container).toBe(4);
    expect(d.pieces.get(pid("bolt_turret"))!.container).toBe(4);
    expect(d.pieces.get(pid("flame_turret"))!.container).toBe(4);
  });
  it("turretAmmoState counts only ammo kinds in the turret's storage, and its free slots", () => {
    const { w, p } = fresh();
    const { turret } = turretWith(w, p, "arrow_turret", [["flint_arrow", 12]]);
    const s = D.turretAmmoState(w, d, turret);
    expect(s.count).toBe(12); expect(s.byItem.get(iid("flint_arrow"))).toBe(12); expect(s.freeSlots).toBe(3);
    const { turret: t2, att } = turretWith(w, p, "bolt_turret", [["iron_bolt", 5]]);
    G.addItem(w, att, iid("stone"), 3); // junk in the box: not ammo, but it eats a slot
    const s2 = D.turretAmmoState(w, d, t2);
    expect(s2.count).toBe(5); expect(s2.freeSlots).toBe(2);
  });
});

describe("ADR-342 pick: the right ammo, only the surplus", () => {
  it("arrow turret takes flint arrows first, bolt takes iron bolts, flame takes crude oil", () => {
    const { w, p } = fresh();
    turretWith(w, p, "arrow_turret");
    boxWith(w, p, [["flint_arrow", 30], ["iron_arrow", 30], ["iron_bolt", 30], ["crude_oil", 30]]);
    const t = pickFor(w, p, G.scanBase(w, d, BASE))!;
    expect(t.key).toBe("arrow_turret"); expect(t.itemKey).toBe("flint_arrow");
    expect(t.count).toBe(20); // min(need 20, surplus 30 - reserve 10, stack 50)
    expect(t.box).toBeDefined(); // the bag is empty: the box is the source
  });
  it("a kind with no stock falls through to the next listed kind", () => {
    const { w, p } = fresh();
    turretWith(w, p, "bolt_turret");
    boxWith(w, p, [["steel_bolt", 30]]);
    expect(pickFor(w, p, G.scanBase(w, d, BASE))!.itemKey).toBe("steel_bolt");
    const { w: w2, p: p2 } = fresh();
    turretWith(w2, p2, "flame_turret");
    boxWith(w2, p2, [["lamp_oil", 30]]);
    expect(pickFor(w2, p2, G.scanBase(w2, d, BASE))!.itemKey).toBe("lamp_oil");
  });
  it("only the surplus above the reserve is deposited — never the bot's last arrows", () => {
    const { w, p } = fresh();
    turretWith(w, p, "arrow_turret");
    boxWith(w, p, [["flint_arrow", 10]]); // exactly the reserve: nothing to give
    expect(pickFor(w, p, G.scanBase(w, d, BASE))).toBeUndefined();
    G.addItem(w, p, iid("flint_arrow"), 3); // bag 3 + box 10 - reserve 10 = 3 to give
    const t = pickFor(w, p, G.scanBase(w, d, BASE))!;
    expect(t.count).toBe(3); expect(t.box).toBeUndefined(); // the bag covers the deposit: no trip to the box
  });
  it("a kind on the ladder's gather leaves is never spent on a turret", () => {
    const { w, p } = fresh();
    turretWith(w, p, "arrow_turret");
    boxWith(w, p, [["flint_arrow", 30], ["iron_arrow", 30]]);
    expect(pickFor(w, p, G.scanBase(w, d, BASE), new Set([iid("flint_arrow")]))!.itemKey).toBe("iron_arrow");
    expect(pickFor(w, p, G.scanBase(w, d, BASE), new Set([iid("flint_arrow"), iid("iron_arrow"), iid("fire_arrow")]))).toBeUndefined();
  });
  it("restock fires when low and not when full: below a quarter of the target, not at half", () => {
    const { w, p } = fresh();
    turretWith(w, p, "arrow_turret", [["flint_arrow", 4]]); // 4 < 20 * 0.25 = 5: low
    boxWith(w, p, [["flint_arrow", 30]]);
    const t = pickFor(w, p, G.scanBase(w, d, BASE))!;
    expect(t.count).toBe(16); // fill to the target, not past it
    const { w: w2, p: p2 } = fresh();
    turretWith(w2, p2, "arrow_turret", [["flint_arrow", 10]]); // half full: not low
    boxWith(w2, p2, [["flint_arrow", 30]]);
    expect(pickFor(w2, p2, G.scanBase(w2, d, BASE))).toBeUndefined();
    const { w: w3, p: p3 } = fresh();
    turretWith(w3, p3, "arrow_turret", [["flint_arrow", 20]]); // full
    boxWith(w3, p3, [["flint_arrow", 30]]);
    expect(pickFor(w3, p3, G.scanBase(w3, d, BASE))).toBeUndefined();
  });
  it("a new kind needs a free slot; a kind already inside tops its stack up", () => {
    const { w, p } = fresh();
    const { turret, att } = turretWith(w, p, "arrow_turret", [["iron_arrow", 4]]);
    for (const k of ["stone", "wood", "sticks"]) G.addItem(w, att, iid(k), 1); // all 4 slots taken
    steps(w, 25);
    boxWith(w, p, [["flint_arrow", 30], ["iron_arrow", 30]]);
    const t = pickFor(w, p, G.scanBase(w, d, BASE))!;
    expect(t.itemKey).toBe("iron_arrow"); // flint has nowhere to go; iron tops its stack up
    expect(t.count).toBe(16);
    expect(D.turretAmmoState(w, d, turret).freeSlots).toBe(0);
  });
  it("the neediest turret goes first", () => {
    const { w, p } = fresh();
    const t1 = place(w, p, "arrow_turret", BASE.x - 4, BASE.y - 4);
    const t2 = place(w, p, "bolt_turret", BASE.x + 6, BASE.y - 4);
    const a1 = G.resolveAttachment(w, t1, G.AttachKind.Storage)!;
    const a2 = G.resolveAttachment(w, t2, G.AttachKind.Storage)!;
    G.addItem(w, a1, iid("flint_arrow"), 4); // low
    G.addItem(w, a2, iid("iron_bolt"), 1); // lower: goes first
    steps(w, 25);
    boxWith(w, p, [["flint_arrow", 30], ["iron_bolt", 30]]);
    const t = pickFor(w, p, G.scanBase(w, d, BASE))!;
    expect(t.key).toBe("bolt_turret"); expect(t.itemKey).toBe("iron_bolt");
  });
  it("no box and an empty bag -> no pick", () => {
    const { w, p } = fresh();
    turretWith(w, p, "arrow_turret");
    expect(pickFor(w, p, G.scanBase(w, d, BASE))).toBeUndefined();
  });
});

describe("ADR-342 pick: never anyone else's storage", () => {
  it("a foreign box is never a source, even when it is the only box with ammo", () => {
    const { w, p } = fresh();
    turretWith(w, p, "arrow_turret");
    const q = spawnLearned(w, { x: BASE.x + 40, y: BASE.y + 40, maxWeight: 0, clientId: 2 });
    w.add(q, PlayerId, { id: 12 });
    plantClaim(w, q, BASE.x + 38, BASE.y + 38);
    const foreign = place(w, q, "basic_storage_box", BASE.x + 41.5, BASE.y + 39.6);
    const att = G.resolveAttachment(w, foreign, G.AttachKind.Storage)!;
    G.addItem(w, att, iid("flint_arrow"), 30);
    steps(w, 25);
    // the bot's own scan has no box at all: hand the pick a scan whose storage IS the foreign box
    const fakeBs: G.BaseState = { pieces: new Map(), stations: new Map(), complete: false, storage: { id: foreign, x: BASE.x + 41.5, y: BASE.y + 39.6, counts: new Map([[iid("flint_arrow"), 30]]), free: 0 } };
    expect(pickFor(w, p, fakeBs)).toBeUndefined();
    // the same box, owned by the bot, is a source
    const own = boxWith(w, p, [["flint_arrow", 30]]);
    const ownBs: G.BaseState = { pieces: new Map(), stations: new Map(), complete: false, storage: { id: own.box, x: BOX_AT.x, y: BOX_AT.y, counts: new Map([[iid("flint_arrow"), 30]]), free: 0 } };
    expect(pickFor(w, p, ownBs)?.itemKey).toBe("flint_arrow");
  });
  it("mayTakeFromStorageAt (the shared ADR-323/327 rule) still agrees: own yes, foreign no", () => {
    const { w, p } = fresh();
    const { box } = boxWith(w, p, []);
    expect(G.mayTakeFromStorageAt(w, p, { piece: box, x: BOX_AT.x, y: BOX_AT.y }, { x: BASE.x + 1, y: BASE.y + 1 }, 5)).toBe(true);
    const q = spawnLearned(w, { x: BASE.x + 40, y: BASE.y + 40, maxWeight: 0, clientId: 2 });
    w.add(q, PlayerId, { id: 12 });
    plantClaim(w, q, BASE.x + 38, BASE.y + 38);
    const foreign = place(w, q, "basic_storage_box", BASE.x + 41.5, BASE.y + 39.6);
    expect(G.mayTakeFromStorageAt(w, p, { piece: foreign, x: BASE.x + 41.5, y: BASE.y + 39.6 }, { x: BASE.x + 1, y: BASE.y + 1 }, 5)).toBe(false);
  });
});

describe("ADR-342 sensor: gating (no starvation, no stepping on the planner)", () => {
  it("a low turret with ammo in the base box gets a target through the real sensor", () => {
    const { w, p, agent } = fresh();
    turretWith(w, p, "arrow_turret");
    boxWith(w, p, [["flint_arrow", 30]]);
    const view = viewFor(w);
    D.fillDefenceSensors(w, p, view, agent);
    expect(view.turretAmmoTarget).toBeDefined();
    expect(view.turretAmmoTarget!.key).toBe("arrow_turret");
    expect(view.turretAmmoTarget!.itemKey).toBe("flint_arrow");
    expect(view.turretAmmoTarget!.count).toBe(20);
    expect(view.turretAmmoTarget!.box?.id).toBe(view.bs!.storage!.id);
    // the ammo is earmarked: it leaves the stash list and joins plan.keep
    expect(view.plan!.keep.has(iid("flint_arrow"))).toBe(true);
  });
  it("no target when the turret is full, and none when the planner has a step — or only gather leaves", () => {
    const { w, p, agent } = fresh();
    turretWith(w, p, "arrow_turret", [["flint_arrow", 20]]);
    boxWith(w, p, [["flint_arrow", 30]]);
    const view = viewFor(w);
    D.fillDefenceSensors(w, p, view, agent);
    expect(view.turretAmmoTarget).toBeUndefined();
    const { w: w2, p: p2, agent: a2 } = fresh();
    turretWith(w2, p2, "arrow_turret");
    boxWith(w2, p2, [["flint_arrow", 30]]);
    const busy = viewFor(w2, { plan: { goal: "wood", step: { k: "wear", invSlot: 0 }, leaves: [], hunt: [], keep: new Set<number>(), blocked: [] } });
    D.fillDefenceSensors(w2, p2, busy, a2);
    expect(busy.turretAmmoTarget).toBeUndefined(); // the planner is busy: stocking waits
    // a plan with gather leaves but no step is still planner work: stocking waits for that too
    const gathering = viewFor(w2, { plan: { goal: "axe", leaves: [iid("wood"), iid("stone")], hunt: [], keep: new Set<number>(), blocked: [] } });
    D.fillDefenceSensors(w2, p2, gathering, a2);
    expect(gathering.turretAmmoTarget).toBeUndefined();
  });
  it("no target while a survival need is unmet (hungry), and none during the trip cooldown", () => {
    const { w, p, agent } = fresh();
    turretWith(w, p, "arrow_turret");
    boxWith(w, p, [["flint_arrow", 30]]);
    w.setField(p, G.Survival, "hunger", 10); // starving: food first, turrets later
    const view = viewFor(w);
    D.fillDefenceSensors(w, p, view, agent);
    expect(view.turretAmmoTarget).toBeUndefined();
    expect(D.ammoNeedsMet(w, p)).toBe(false);
    w.setField(p, G.Survival, "hunger", 100);
    expect(D.ammoNeedsMet(w, p)).toBe(true);
    agent.bb.set("ammoAt", w.tick); // a trip just finished: one trip per turret, then a pause
    const view2 = viewFor(w);
    D.fillDefenceSensors(w, p, view2, agent);
    expect(view2.turretAmmoTarget).toBeUndefined();
    agent.bb.set("ammoAt", w.tick - D.DEFENCE_DATA.ammoCooldownTicks);
    const view3 = viewFor(w);
    D.fillDefenceSensors(w, p, view3, agent);
    expect(view3.turretAmmoTarget).toBeDefined();
  });
  it("no target without a claim, and the defence target is untouched by the ammo sensor", () => {
    const { w, p, agent } = fresh(false);
    turretWith(w, p, "arrow_turret");
    boxWith(w, p, [["flint_arrow", 30]]);
    const view = viewFor(w);
    D.fillDefenceSensors(w, p, view, agent);
    expect(view.turretAmmoTarget).toBeUndefined();
    expect(view.defenceTarget).toBeUndefined();
  });
});

describe("ADR-342 sensor: hired workers stock the employer's turrets", () => {
  const hiredRig = (): { w: World; p: Entity; agent: Agent; view: G.AgentWorldView & D.DefenceSensors } => {
    const w = makeWorld(); installPermissions(w);
    const boss = spawnLearned(w, { x: BASE.x + 1, y: BASE.y + 1, maxWeight: 0, clientId: 7 });
    w.add(boss, PlayerId, { id: 7 });
    steps(w, 1);
    plantClaim(w, boss, BASE.x - 2, BASE.y - 2); // the employer's claim
    turretWith(w, boss, "arrow_turret");
    boxWith(w, boss, [["flint_arrow", 30]]);
    const p = spawnLearned(w, { x: BASE.x + 1, y: BASE.y + 3.3, maxWeight: 0, clientId: 1 });
    w.add(p, PlayerId, { id: 9 });
    G.ensureWorker(w, p); w.setField(p, G.Worker, "owner", 7);
    w.setField(p, G.Worker, "homeX", BASE.x); w.setField(p, G.Worker, "homeY", BASE.y);
    const agent = G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1);
    const view = viewFor(w, { hire: { job: 0, owner: 7, ax: BASE.x, ay: BASE.y, idle: true } });
    return { w, p, agent, view };
  };
  it("a hired worker with hire.idle stocks the employer's turret from the employer's box", () => {
    const { w, p, agent, view } = hiredRig();
    D.fillDefenceSensors(w, p, view, agent);
    expect(view.defenceTarget).toBeUndefined(); // hired workers build nothing
    expect(view.turretAmmoTarget).toBeDefined();
    expect(view.turretAmmoTarget!.key).toBe("arrow_turret");
    expect(view.turretAmmoTarget!.itemKey).toBe("flint_arrow");
    expect(view.turretAmmoTarget!.box?.id).toBe(view.bs!.storage!.id);
  });
  it("a hired worker that is not idle does not stock", () => {
    const { w, p, agent, view } = hiredRig();
    (view as { hire: { idle: boolean } }).hire.idle = false; // job work pending
    D.fillDefenceSensors(w, p, view, agent);
    expect(view.turretAmmoTarget).toBeUndefined();
    const { w: w2, p: p2, agent: a2, view: v2 } = hiredRig();
    delete (v2 as { hire?: unknown }).hire; // no idle flag at all: never assume idle
    D.fillDefenceSensors(w2, p2, v2, a2);
    expect(v2.turretAmmoTarget).toBeUndefined();
  });
});

describe("ADR-342 behaviour: stock_turret", () => {
  it("considerations gate on target, a free planner, fed needs, hire idle, and calm", () => {
    const { w, p, agent } = fresh();
    const b = stockBehaviour();
    expect(b.name).toBe("stock_turret");
    const input = (name: string, view: G.AgentWorldView, hunger = 1): number => b.considerations.find((c) => c.name === name)!.input(ctxFor(w, agent, view, 0, hunger));
    const target: D.TurretAmmoTarget = { turret: 1 as Entity, key: "arrow_turret", x: 1, y: 1, item: iid("flint_arrow"), itemKey: "flint_arrow", count: 20 };
    expect(input("target", viewFor(w, { turretAmmoTarget: target }))).toBe(1);
    expect(input("target", viewFor(w))).toBe(0);
    expect(input("planFree", viewFor(w, { plan: { goal: "wood", step: { k: "wear", invSlot: 0 }, leaves: [], hunt: [], keep: new Set(), blocked: [] } }))).toBe(0);
    expect(input("planFree", viewFor(w, { plan: { goal: "axe", leaves: [iid("wood")], hunt: [], keep: new Set(), blocked: [] } }))).toBe(0); // gather leaves are planner work too
    expect(input("planFree", viewFor(w))).toBe(1);
    expect(input("needs", viewFor(w))).toBe(1);
    expect(input("needs", viewFor(w), 0.2)).toBe(0); // hungry: never stock while a need is unmet
    expect(input("hireIdle", viewFor(w, { hire: { job: 0, owner: 7, ax: 0, ay: 0, idle: false } }))).toBe(0);
    expect(input("hireIdle", viewFor(w, { hire: { job: 0, owner: 7, ax: 0, ay: 0, idle: true } }))).toBe(1);
    expect(input("hireIdle", viewFor(w))).toBe(1);
    agent.memory.see({ id: 5, kind: "zombie", x: BASE.x + 2, y: BASE.y + 3.3, tick: 0 }); // zombie on top of the bot
    expect(input("calm", viewFor(w))).toBe(0);
    const agent2 = G.makeAgent(G.makeAgentIdentity(5, 1, "bot_gatherer"), 1); // no zombie in memory: calm
    expect(b.considerations.find((c) => c.name === "calm")!.input(ctxFor(w, agent2, viewFor(w)))).toBe(1);
  });
  it("with ammo in the bag, standing at the turret, it deposits (open -> deposit -> close) and cools down", () => {
    const { w, p, agent } = fresh();
    const { turret, att } = turretWith(w, p, "arrow_turret");
    G.addItem(w, p, iid("flint_arrow"), 30); // surplus 30 - reserve 10 = the full 20-round target
    const t = pickFor(w, p, G.scanBase(w, d, BASE))!;
    expect(t.count).toBe(20);
    expect(t.box).toBeUndefined(); // the bag covers it: no box trip
    const view = viewFor(w, { turretAmmoTarget: t });
    agent.bb.set("selfEntity", p);
    G.bindAgentWorld(agent, w);
    w.set(p, Transform, { x: t.x, y: t.y });
    const c = ctxFor(w, agent, view);
    c.self.x = t.x; c.self.y = t.y;
    const b = stockBehaviour();
    let o = out(); b.run(c, o); expect(o.actions).toEqual([`copen:${turret}`]);
    c.self.tick += 11; o = out(); b.run(c, o);
    expect(o.actions).toEqual([`cdeposit:${turret}:${iid("flint_arrow")}:20`]);
    expect(G.transferItem(w, p, att, iid("flint_arrow"), 20)).toBe(20);
    c.self.tick += 11; o = out(); expect(b.run(c, o)).toBe(false); expect(o.actions).toEqual(["cclose"]);
    expect(agent.bb.num("ammoAt")).toBe(c.self.tick); // one trip done: the next turret waits
    c.self.tick += 11; o = out(); expect(b.run(c, o)).toBe(false); expect(o.actions).toEqual([]); // turret full now
    expect(D.turretAmmoState(w, d, turret).count).toBe(20);
  });
  it("with an empty bag it withdraws from the base box first, then deposits", () => {
    const { w, p, agent } = fresh();
    const { turret, att: tatt } = turretWith(w, p, "arrow_turret");
    const { box, att: batt } = boxWith(w, p, [["flint_arrow", 30]]);
    const t = pickFor(w, p, G.scanBase(w, d, BASE))!;
    expect(t.box?.id).toBe(box);
    const view = viewFor(w, { turretAmmoTarget: t });
    agent.bb.set("selfEntity", p);
    G.bindAgentWorld(agent, w);
    const b = stockBehaviour();
    w.set(p, Transform, { x: BOX_AT.x, y: BOX_AT.y });
    const c = ctxFor(w, agent, view);
    c.self.x = BOX_AT.x; c.self.y = BOX_AT.y;
    let o = out(); b.run(c, o); expect(o.actions).toEqual([`copen:${box}`]);
    c.self.tick += 11; o = out(); b.run(c, o);
    expect(o.actions).toEqual([`cwithdraw:${box}:${iid("flint_arrow")}:20`]);
    expect(G.transferItem(w, batt, p, iid("flint_arrow"), 20)).toBe(20);
    // the bag filled before the withdraw's cclose: the panel is closed first, then the bot walks off
    c.self.tick += 11; o = out(); expect(b.run(c, o)).toBe(false); expect(o.actions).toEqual(["cclose"]);
    // bag full: walk to the turret and deposit
    w.set(p, Transform, { x: t.x, y: t.y });
    c.self.x = t.x; c.self.y = t.y; c.self.tick += 11;
    o = out(); b.run(c, o); expect(o.actions).toEqual([`copen:${turret}`]);
    c.self.tick += 11; o = out(); b.run(c, o);
    expect(o.actions).toEqual([`cdeposit:${turret}:${iid("flint_arrow")}:20`]);
    expect(G.transferItem(w, p, tatt, iid("flint_arrow"), 20)).toBe(20);
    c.self.tick += 11; o = out(); expect(b.run(c, o)).toBe(false); expect(o.actions).toEqual(["cclose"]);
    expect(D.turretAmmoState(w, d, turret).count).toBe(20);
  });
  it("with no ammo anywhere it cools down instead of looping, and a full turret is left alone", () => {
    const { w, p, agent } = fresh();
    const { turret } = turretWith(w, p, "arrow_turret");
    const view = viewFor(w, { turretAmmoTarget: { turret, key: "arrow_turret", x: TURRET_AT.x, y: TURRET_AT.y, item: iid("flint_arrow"), itemKey: "flint_arrow", count: 20 } });
    agent.bb.set("selfEntity", p);
    G.bindAgentWorld(agent, w);
    const c = ctxFor(w, agent, view);
    const b = stockBehaviour();
    const o = out();
    expect(b.run(c, o)).toBe(false);
    expect(o.actions).toEqual([]);
    expect(agent.bb.num("ammoAt")).toBe(c.self.tick); // cooled down, not spinning
    const { w: w2, p: p2, agent: a2 } = fresh();
    const full = turretWith(w2, p2, "arrow_turret", [["flint_arrow", 20]]);
    G.addItem(w2, p2, iid("flint_arrow"), 20);
    const view2 = viewFor(w2, { turretAmmoTarget: { turret: full.turret, key: "arrow_turret", x: TURRET_AT.x, y: TURRET_AT.y, item: iid("flint_arrow"), itemKey: "flint_arrow", count: 20 } });
    a2.bb.set("selfEntity", p2);
    G.bindAgentWorld(a2, w2);
    const c2 = ctxFor(w2, a2, view2);
    const o2 = out();
    expect(b.run(c2, o2)).toBe(false);
    expect(o2.actions).toEqual([]);
  });
  it("with no target it does nothing", () => {
    const { w, p, agent } = fresh();
    G.bindAgentWorld(agent, w);
    const c = ctxFor(w, agent, viewFor(w));
    const o = out();
    expect(stockBehaviour().run(c, o)).toBe(false);
    expect(o.actions).toEqual([]);
  });
});
