/**
 * ADR-338: AI defends its OWN claimed territory with barbed wire and turrets.
 * Threat levels from canned histories; no defence when threat is low or the bot lacks
 * surplus; wire-before-turret ordering; placement only inside the bot's own claim; one
 * piece at a time; no claim -> no plan; turret choice escalates with resources.
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
const DATA = { ...D.DEFENCE_DATA, maxWire: 2, wireRingInset: 26 }; // small ring near home: deterministic terrain

function fresh(claim = true): { w: World; p: Entity; agent: Agent } {
  const w = makeWorld(); installPermissions(w); // registers PlayerId (adr259 pattern)
  const p = spawnLearned(w, { x: BASE.x + 1, y: BASE.y + 3.3, maxWeight: 0, clientId: 1 });
  w.add(p, PlayerId, { id: 9 });
  steps(w, 1);
  if (claim) plantClaim(w, p, BASE.x - 2, BASE.y - 2);
  const agent = G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1);
  return { w, p, agent };
}
const mem = (): D.DefenceMemory => ({ v: 1, events: [], livestockSeen: 0, killIds: [], wireIndex: 0, turretIndex: 0, fails: {} });
const rich = (w: World, p: Entity): void => {
  // one stack each (maxStacks are 20..99; 100 of everything overflows the bag and later grants silently add 0)
  for (const [k, n] of [["scrap_metal", 50], ["sticks", 99], ["planks", 50], ["rope", 30], ["spring", 50], ["iron_ingot", 30], ["nails", 99], ["crude_oil", 20], ["wood", 50], ["stone", 50]] as const) G.addItem(w, p, iid(k), n);
};
const viewFor = (w: World, over: Record<string, unknown> = {}): G.AgentWorldView & D.DefenceSensors => {
  const bs = G.scanBase(w, d, BASE);
  return { seen: [], home: { x: BASE.x + 1, y: BASE.y + 1 }, playerName: "tester", base: BASE, bs, plan: { goal: "idle", leaves: [], hunt: [], keep: new Set<number>(), blocked: [] }, ...over } as unknown as G.AgentWorldView & D.DefenceSensors;
};
const planFor = (w: World, p: Entity, m: D.DefenceMemory, threat = 2, data: D.DefenceData = DATA, leaves = new Set<number>()): D.DefenceTarget | undefined => {
  const bs = G.scanBase(w, d, BASE);
  return D.planDefence({ world: w, self: p, defs: d, base: BASE, ...(bs ? { bs } : {}), threat, leaves, mem: m }, data);
};
/** Plan one piece and really place it (bot teleported to the stand, like a player in reach). */
const placeNext = (w: World, p: Entity, t: D.DefenceTarget): void => {
  w.set(p, Transform, { x: t.stand.x, y: t.stand.y });
  const r = G.tryPlace(w, p, { piece: t.piece, x: t.x, y: t.y, level: t.level, rot: t.rot, tier: t.tier, variant: 0 });
  expect(r.ok, `${t.key} at ${t.x},${t.y}`).toBe(true);
  steps(w, 25);
};
const out = (): AgentOutput => ({ moveX: 0, moveY: 0, aimX: 0, aimY: 0, sprint: false, actions: [] });
const ctxFor = (w: World, agent: Agent, view: G.AgentWorldView, tick = 0): AgentContext<G.AgentWorldView> => {
  const self = { x: BASE.x + 1, y: BASE.y + 3.3, tick, facing: 0, hp: 1, hunger: 1, thirst: 1, stamina: 1, dayT: 0.5, phase: "day" };
  return { self, world: view, memory: agent.memory, bb: agent.bb, traits: agent.identity.traits, rng: agent.rng, agent } as unknown as AgentContext<G.AgentWorldView>;
};

describe("ADR-338 threat assessment (pure)", () => {
  it("no events -> level 0; one sighting -> level 1; three sightings -> level 2", () => {
    expect(D.assessThreat([], 1000)).toEqual({ level: 0, score: 0 });
    expect(D.assessThreat([{ tick: 1000, kind: "sighting" }], 1000).level).toBe(1);
    const three = [0, 1, 2].map((i) => ({ tick: 1000 + i, kind: "sighting" as const }));
    expect(D.assessThreat(three, 1002)).toEqual({ level: 2, score: 3 });
  });
  it("kills and livestock losses weigh more; a recent close attack adds its weight once", () => {
    const ev: D.ThreatEvent[] = [{ tick: 1000, kind: "kill" }, { tick: 1000, kind: "livestock" }, { tick: 1000, kind: "sighting" }];
    expect(D.assessThreat(ev, 1000)).toEqual({ level: 3, score: 6 }); // 2 + 3 + 1
    const atk: D.ThreatEvent[] = [{ tick: 1000, kind: "attack" }, { tick: 1000, kind: "sighting" }];
    expect(D.assessThreat(atk, 1000)).toEqual({ level: 2, score: 3 }); // 1 sighting + 2 recent-attack
    expect(D.assessThreat(atk, 1000 + D.DEFENCE_DATA.recentAttackTicks + 1).score).toBe(1); // attack no longer recent
  });
  it("events older than the threat window are forgotten; future events do not count", () => {
    const ev: D.ThreatEvent[] = [{ tick: 0, kind: "sighting" }, { tick: 5000, kind: "sighting" }, { tick: 99999, kind: "sighting" }];
    expect(D.assessThreat(ev, 24000 + 5000)).toEqual({ level: 1, score: 1 }); // only the tick-5000 sighting is in window
  });
  it("levels come from the data thresholds, not hardcoded numbers", () => {
    const data = { ...D.DEFENCE_DATA, levelThresholds: [2, 5] };
    expect(D.assessThreat([{ tick: 0, kind: "sighting" }], 0, data).level).toBe(0);
    expect(D.assessThreat([{ tick: 0, kind: "kill" }], 0, data).level).toBe(1);
    expect(D.assessThreat([{ tick: 0, kind: "kill" }, { tick: 0, kind: "livestock" }], 0, data).level).toBe(2);
  });
  it("data knobs: build at level 2, wire first, 8 wire max, arrow -> bolt -> flame", () => {
    expect(D.DEFENCE_DATA.buildThreatLevel).toBe(2);
    expect(D.DEFENCE_DATA.maxWire).toBe(8);
    expect(D.DEFENCE_DATA.turretOrder).toEqual(["arrow_turret", "bolt_turret", "flame_turret"]);
    expect(D.DEFENCE_PIECE_KEYS).toEqual(["barbed_wire", "arrow_turret", "bolt_turret", "flame_turret"]);
  });
});

describe("ADR-338 defence memory", () => {
  it("noteDefenceEvent records and flushDefenceMemory writes debounced, like social memory", () => {
    const { agent } = fresh();
    D.noteDefenceEvent(agent, "sighting", 0);
    expect(D.defenceMemoryOf(agent).events).toEqual([{ tick: 0, kind: "sighting" }]);
    expect(D.defenceMemoryDirty(agent)).toBe(true);
    const puts: { id: string; partial: unknown }[] = [];
    const put = (id: string, partial: { defence: D.DefenceMemory }): unknown => { puts.push({ id, partial }); return undefined; };
    expect(D.flushDefenceMemory([agent], put, 0)).toEqual([]); // inside the debounce window
    expect(D.flushDefenceMemory([agent], put, D.DEFENCE_WRITE_DEBOUNCE_TICKS + 1)).toEqual([agent.identity.id]);
    expect(puts[0]?.partial).toMatchObject({ defence: { events: [{ tick: 0, kind: "sighting" }] } });
    expect(D.defenceMemoryDirty(agent)).toBe(false);
  });
  it("defenceMemoryOf validates garbage from the store into defaults", () => {
    const { agent } = fresh();
    (agent.identity as unknown as { defence: unknown }).defence = { events: [{ tick: "x", kind: "bogus" }], livestockSeen: "no", fails: { wire0: "n" } };
    const m = D.defenceMemoryOf(agent);
    expect(m.events).toEqual([]); expect(m.livestockSeen).toBe(0); expect(m.fails).toEqual({});
  });
});

describe("ADR-338 choice: threat, claim, surplus", () => {
  it("no defence when threat is below the build level", () => {
    const { w, p } = fresh(); rich(w, p);
    expect(planFor(w, p, mem(), 1)).toBeUndefined();
    expect(planFor(w, p, mem(), 0)).toBeUndefined();
  });
  it("a bot with no claim gets no defence plan", () => {
    const { w, p } = fresh(false); rich(w, p);
    expect(D.ownClaim(w, p, BASE.x + 1, BASE.y + 1)).toBeUndefined();
    expect(planFor(w, p, mem(), 3)).toBeUndefined();
  });
  it("no defence when the bot lacks surplus materials", () => {
    const { w, p } = fresh();
    expect(planFor(w, p, mem(), 3)).toBeUndefined(); // empty bag, empty storage
    G.addItem(w, p, iid("scrap_metal"), 3); G.addItem(w, p, iid("sticks"), 1); // one stick short of the wire
    expect(planFor(w, p, mem(), 3)).toBeUndefined();
  });
  it("the per-item reserve counts: an arrow turret needs cost + reserve planks", () => {
    const { w, p } = fresh(); const m = mem();
    const noWire = { ...DATA, maxWire: 0 };
    for (const [k, n] of [["rope", 3], ["spring", 1]] as const) G.addItem(w, p, iid(k), n);
    G.addItem(w, p, iid("planks"), 13); // cost 10 + reserve 4 = 14
    expect(planFor(w, p, m, 2, noWire)).toBeUndefined();
    G.addItem(w, p, iid("planks"), 1);
    expect(planFor(w, p, m, 2, noWire)?.key).toBe("arrow_turret");
  });
  it("a cost item still on the ladder's gather list is not spent on defence", () => {
    const { w, p } = fresh(); const m = mem();
    const noWire = { ...DATA, maxWire: 0 };
    rich(w, p);
    // planks are on the ladder's list: the arrow turret (planks 10) is skipped, the bolt (no planks) is not
    expect(planFor(w, p, m, 2, noWire, new Set([iid("planks")]))?.key).toBe("bolt_turret");
    // spring is in every turret's cost: nothing can be built while the ladder still needs it
    expect(planFor(w, p, m, 2, noWire, new Set([iid("spring")]))).toBeUndefined();
    expect(planFor(w, p, m, 2, noWire, new Set())).toBeDefined();
  });
  it("materials in base storage count toward surplus, not just the bag", () => {
    const { w, p } = fresh(); const m = mem();
    const def = d.pieces.get(pid("basic_storage_box"))!;
    const sn = G.snapPlacement(w, { piece: def.id, x: BASE.x + 3.5, y: BASE.y + 1.6, level: 0, rot: 0, tier: def.fixedTier, variant: 0 });
    if (typeof sn === "number") throw new Error(`storage snap failed: ${sn}`);
    const box = G.placePiece(w, p, sn, { pay: false });
    const att = G.resolveAttachment(w, box, G.AttachKind.Storage)!;
    G.addItem(w, att, iid("scrap_metal"), 3); G.addItem(w, att, iid("sticks"), 2);
    steps(w, 25);
    expect(planFor(w, p, m, 2)?.key).toBe("barbed_wire"); // bag is empty: storage alone suffices
  });
});

describe("ADR-338 ordering and placement", () => {
  it("wire before turret, then arrow -> bolt -> flame, one piece at a time, all inside the bot's own claim", () => {
    const { w, p } = fresh(); rich(w, p); const m = mem();
    const keys: string[] = [];
    for (let i = 0; i < 8; i++) {
      const t = planFor(w, p, m, 2);
      if (!t) break;
      expect(G.hasOwnClaim(w, p, t.x, t.y), `${t.key} at ${t.x},${t.y} must be on the bot's own claim`).toBe(true);
      keys.push(t.key);
      placeNext(w, p, t);
    }
    expect(keys).toEqual(["barbed_wire", "barbed_wire", "arrow_turret", "bolt_turret", "flame_turret"]);
    expect(planFor(w, p, m, 2)).toBeUndefined(); // fully defended: wire cap + one of each turret
  });
  it("the target is stable until the piece stands, then moves to the next slot", () => {
    const { w, p } = fresh(); rich(w, p); const m = mem();
    const a = planFor(w, p, m, 2)!; const b = planFor(w, p, m, 2)!;
    expect(a.slot).toBe(b.slot); expect(a.x).toBe(b.x); expect(a.y).toBe(b.y); // one piece at a time, no second plan
    placeNext(w, p, a);
    const c = planFor(w, p, m, 2)!;
    expect(c.slot).not.toBe(a.slot); // next wire slot, not the same one again
  });
  it("turret choice escalates with resources: unaffordable arrow is skipped for bolt, then arrow wins when affordable", () => {
    const { w, p } = fresh(); const m = mem();
    const noWire = { ...DATA, maxWire: 0 };
    // bolt materials only: no planks, so the arrow turret is unaffordable
    for (const [k, n] of [["iron_ingot", 30], ["nails", 99], ["rope", 30], ["spring", 50]] as const) G.addItem(w, p, iid(k), n);
    expect(planFor(w, p, m, 2, noWire)?.key).toBe("bolt_turret");
    G.addItem(w, p, iid("planks"), 50); // arrow affordable now: cheapest first
    expect(planFor(w, p, m, 2, noWire)?.key).toBe("arrow_turret");
  });
  it("a foreign claim does not change where the bot builds: targets stay on its own claim", () => {
    const { w, p } = fresh(); rich(w, p);
    const q = spawnLearned(w, { x: BASE.x + 40, y: BASE.y + 40, maxWeight: 0, clientId: 2 });
    plantClaim(w, q, BASE.x + 38, BASE.y + 38);
    const t = planFor(w, p, mem(), 2)!;
    expect(G.hasOwnClaim(w, p, t.x, t.y)).toBe(true);
    expect(G.hasOwnClaim(w, q, t.x, t.y)).toBe(false);
  });
});

describe("ADR-338 sensors", () => {
  it("zombies seen inside the claim record sightings (once per cooldown), and enough threat + surplus sets a target", () => {
    const { w, p, agent } = fresh(); rich(w, p);
    const z = { id: 999, kind: "zombie" as const, x: BASE.x + 1, y: BASE.y + 1 };
    const view = viewFor(w, { seen: [z] });
    D.fillDefenceSensors(w, p, view, agent);
    expect(D.defenceMemoryOf(agent).events).toContainEqual({ tick: w.tick, kind: "sighting" });
    expect(D.defenceMemoryOf(agent).events).toContainEqual({ tick: w.tick, kind: "attack" }); // within attackRadius of the base
    // sighting (1) + recent close attack (2) = level 2, and the bot is rich: a piece is planned at once
    expect(view.defenceTarget).toBeDefined();
    expect(D.DEFENCE_PIECE_KEYS).toContain(view.defenceTarget!.key);
    D.fillDefenceSensors(w, p, view, agent); // same tick: no duplicate events
    expect(D.defenceMemoryOf(agent).events.filter((e) => e.kind === "sighting")).toHaveLength(1);
    expect(D.defenceMemoryOf(agent).events.filter((e) => e.kind === "attack")).toHaveLength(1);
    steps(w, 201); // past the event cooldown: the same zombie is recorded again
    D.fillDefenceSensors(w, p, view, agent);
    expect(D.defenceMemoryOf(agent).events.filter((e) => e.kind === "sighting")).toHaveLength(2);
  });
  it("no target when threat is high but the bot is poor", () => {
    const { w, p, agent } = fresh();
    D.noteDefenceEvent(agent, "sighting", 0); D.noteDefenceEvent(agent, "sighting", 0); D.noteDefenceEvent(agent, "sighting", 0);
    const view = viewFor(w);
    D.fillDefenceSensors(w, p, view, agent);
    expect(view.defenceTarget).toBeUndefined();
  });
  it("a witnessed kill near home records a kill event", () => {
    const { w, p, agent } = fresh();
    const z = G.spawnZombie(w, "zombie_walker", BASE.x + 1, BASE.y + 1);
    agent.memory.see({ id: z, kind: "zombie", x: BASE.x + 1, y: BASE.y + 1, tick: w.tick });
    w.add(z, G.Dead);
    D.fillDefenceSensors(w, p, viewFor(w), agent);
    expect(D.defenceMemoryOf(agent).events).toContainEqual({ tick: w.tick, kind: "kill" });
  });
  it("a lost owned animal near home records a livestock event", () => {
    const { w, p, agent } = fresh();
    const tame = (x: number, y: number): Entity => { const e = w.create(); w.add(e, Transform, { x, y }).add(e, G.Tamed, { kind: 0, owner: 9, fedUntil: w.tick + 100000, produceAt: w.tick + 100000, breedAt: w.tick + 100000 }); return e; };
    const a1 = tame(BASE.x + 2, BASE.y + 2); tame(BASE.x + 3, BASE.y + 2);
    D.fillDefenceSensors(w, p, viewFor(w), agent);
    expect(D.defenceMemoryOf(agent).livestockSeen).toBe(2);
    w.add(a1, G.Dead); // the animal died: one fewer head near home
    D.fillDefenceSensors(w, p, viewFor(w), agent);
    expect(D.defenceMemoryOf(agent).events).toContainEqual({ tick: w.tick, kind: "livestock" });
  });
  it("hired workers get no defence target: the employer's land is not theirs to fortify", () => {
    const { w, p, agent } = fresh(); rich(w, p);
    G.ensureWorker(w, p); w.setField(p, G.Worker, "owner", 7);
    D.noteDefenceEvent(agent, "sighting", 0); D.noteDefenceEvent(agent, "sighting", 0); D.noteDefenceEvent(agent, "sighting", 0);
    const view = viewFor(w);
    D.fillDefenceSensors(w, p, view, agent);
    expect(view.defenceTarget).toBeUndefined();
  });
  it("no base or no claim -> no target, even at high threat", () => {
    const { w, p, agent } = fresh(false); rich(w, p);
    D.noteDefenceEvent(agent, "sighting", 0); D.noteDefenceEvent(agent, "sighting", 0); D.noteDefenceEvent(agent, "sighting", 0);
    const view = viewFor(w);
    D.fillDefenceSensors(w, p, view, agent);
    expect(view.defenceTarget).toBeUndefined();
  });
});

describe("ADR-338 behaviour: build_defence", () => {
  it("considerations gate on target, a free planner, own land, and calm", () => {
    const { w, p, agent } = fresh();
    const b = D.defenceBehaviors()[0]!;
    expect(b.name).toBe("build_defence");
    const input = (name: string, view: G.AgentWorldView): number => b.considerations.find((c) => c.name === name)!.input(ctxFor(w, agent, view));
    const withTarget = viewFor(w, { defenceTarget: { piece: 1, key: "barbed_wire", x: 1, y: 1, level: 0, rot: 0, tier: 0, slot: "wire0", stand: { x: 1, y: 1 }, threat: 2 } });
    expect(input("target", withTarget)).toBe(1);
    expect(input("target", viewFor(w))).toBe(0);
    expect(input("planFree", viewFor(w, { plan: { goal: "wood", step: { k: "wear", invSlot: 0 }, leaves: [], hunt: [], keep: new Set(), blocked: [] } }))).toBe(0); // planner busy: defence waits
    expect(input("planFree", viewFor(w))).toBe(1);
    expect(input("ownLand", viewFor(w, { hire: { job: 0, owner: 7, ax: 0, ay: 0 } }))).toBe(0);
    expect(input("ownLand", viewFor(w))).toBe(1);
    agent.memory.see({ id: 5, kind: "zombie", x: BASE.x + 2, y: BASE.y + 3.3, tick: 0 }); // zombie on top of the bot
    expect(input("calm", viewFor(w))).toBe(0);
    const agent2 = G.makeAgent(G.makeAgentIdentity(5, 1, "bot_gatherer"), 1); // no zombie in memory: calm
    expect(b.considerations.find((c) => c.name === "calm")!.input(ctxFor(w, agent2, viewFor(w)))).toBe(1);
  });
  it("with materials in the bag, standing at the stand, it emits the build action", () => {
    const { w, p, agent } = fresh(); rich(w, p);
    const t = planFor(w, p, mem(), 2)!; expect(t.key).toBe("barbed_wire");
    const view = viewFor(w, { defenceTarget: t });
    agent.bb.set("selfEntity", p);
    G.bindAgentWorld(agent, w);
    w.set(p, Transform, { x: t.stand.x, y: t.stand.y });
    const c = ctxFor(w, agent, view);
    c.self.x = t.stand.x; c.self.y = t.stand.y;
    const o = out(); const b = D.defenceBehaviors()[0]!;
    expect(b.run(c, o)).toBe(false);
    expect(o.actions).toEqual([`build:${t.piece}:${t.x}:${t.y}:${t.level}:${t.rot}:${t.tier}`]);
  });
  it("with no target it does nothing", () => {
    const { w, p, agent } = fresh();
    G.bindAgentWorld(agent, w);
    const c = ctxFor(w, agent, viewFor(w));
    const o = out();
    expect(D.defenceBehaviors()[0]!.run(c, o)).toBe(false);
    expect(o.actions).toEqual([]);
  });
  it("missing materials are withdrawn from base storage first (open -> withdraw -> close), then it builds", () => {
    const { w, p, agent } = fresh();
    const def = d.pieces.get(pid("basic_storage_box"))!;
    const sn = G.snapPlacement(w, { piece: def.id, x: BASE.x + 3.5, y: BASE.y + 1.6, level: 0, rot: 0, tier: def.fixedTier, variant: 0 });
    if (typeof sn === "number") throw new Error(`storage snap failed: ${sn}`);
    const box = G.placePiece(w, p, sn, { pay: false });
    const att = G.resolveAttachment(w, box, G.AttachKind.Storage)!;
    G.addItem(w, att, iid("scrap_metal"), 10); G.addItem(w, att, iid("sticks"), 10);
    steps(w, 25);
    const t = planFor(w, p, mem(), 2)!; expect(t.key).toBe("barbed_wire"); // surplus lives in storage, not the bag
    const view = viewFor(w, { defenceTarget: t });
    agent.bb.set("selfEntity", p);
    G.bindAgentWorld(agent, w);
    const b = D.defenceBehaviors()[0]!;
    const sb = view.bs!.storage!;
    w.set(p, Transform, { x: sb.x, y: sb.y + 1 });
    const c = ctxFor(w, agent, view);
    c.self.x = sb.x; c.self.y = sb.y + 1;
    // withdraw scrap (server effect simulated: move it into the bag after the action goes out).
    // Mid-sequence runs return undefined (the base_behaviors idiom: only the final step returns false).
    let o = out(); b.run(c, o); expect(o.actions).toEqual([`copen:${sb.id}`]);
    c.self.tick += 11; o = out(); b.run(c, o);
    expect(o.actions).toEqual([`cwithdraw:${sb.id}:${iid("scrap_metal")}:3`]);
    expect(G.transferItem(w, att, p, iid("scrap_metal"), 3)).toBe(3);
    // the next item restarts the container sequence (containerSeq keys by item): copen, then withdraw
    c.self.tick += 11; o = out(); b.run(c, o); expect(o.actions).toEqual([`copen:${sb.id}`]);
    c.self.tick += 11; o = out(); b.run(c, o);
    expect(o.actions).toEqual([`cwithdraw:${sb.id}:${iid("sticks")}:2`]);
    expect(G.transferItem(w, att, p, iid("sticks"), 2)).toBe(2);
    // bag full now: the pending cclose goes out before the bot walks off to build
    c.self.tick += 11; o = out(); expect(b.run(c, o)).toBe(false); expect(o.actions).toEqual(["cclose"]);
    // bag full: walk to the stand and build
    w.set(p, Transform, { x: t.stand.x, y: t.stand.y });
    c.self.x = t.stand.x; c.self.y = t.stand.y; c.self.tick += 11;
    o = out(); expect(b.run(c, o)).toBe(false);
    expect(o.actions).toEqual([`build:${t.piece}:${t.x}:${t.y}:${t.level}:${t.rot}:${t.tier}`]);
  });
});
