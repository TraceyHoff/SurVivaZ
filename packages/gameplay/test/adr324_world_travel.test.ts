// ADR-324: world-scale travel for AI humans (ai/travel.ts): long-range goals, region routes, attachment, off-screen sim, budget.
import { describe, expect, it } from "vitest";
import { idleOutput, installPermissions, NetId, PlayerId, Transform, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { aiMemoryOf } from "../src/ai/planner.js";
import { DT, makeWorld, spawnLearned } from "./helpers.js";

const T = G.TRAVEL;
let nid = 9000;
interface Rig { w: World; p: Entity; a: Agent; home: { x: number; y: number } }
function rig(opts: { seed?: number; slot?: number; x?: number; y?: number; w?: World } = {}): Rig {
  const w = opts.w ?? makeWorld({}, opts.seed ?? 42); if (!opts.w) { installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId); }
  const x = opts.x ?? 0, y = opts.y ?? 0; const p = spawnLearned(w, { x, y, maxWeight: 0, clientId: 7 }); w.add(p, PlayerId, { id: 7 + (opts.slot ?? 0) }); w.add(p, NetId, { id: ++nid });
  const a = G.makeAgent(G.makeAgentIdentity(3, opts.slot ?? 0, "bot_gatherer"), 1);
  return { w, p, a, home: { x, y } };
}
type Mem = { travel?: G.TravelState; travelAt?: number; roamSince?: number; base?: { x: number; y: number } };
const mem = (r: Rig): Mem => aiMemoryOf(r.a) as unknown as Mem;
type Ctx = AgentContext<G.AgentWorldView>;
const ctxOf = (r: Rig): Ctx => { const v = G.buildAgentView(r.w, r.p, r.a, r.home)!; return { self: v.self, bb: r.a.bb, memory: r.a.memory, traits: r.a.identity.traits, rng: r.a.rng, agent: r.a, world: v.world }; };
const out = (): AgentOutput => ({ ...idleOutput(), actions: [] as string[] });
const pos = (r: Rig): { x: number; y: number } => r.w.get(r.p, Transform)!;
function move(r: Rig, o: AgentOutput): void {
  let bits = 0; const len = Math.hypot(o.moveX, o.moveY);
  if (len > 1e-6) { if (o.moveX > 0.38 * len) bits |= G.GameplayActions.MoveRight; else if (o.moveX < -0.38 * len) bits |= G.GameplayActions.MoveLeft; if (o.moveY > 0.38 * len) bits |= G.GameplayActions.MoveDown; else if (o.moveY < -0.38 * len) bits |= G.GameplayActions.MoveUp; }
  G.applyMovementInput(r.w, r.p, bits, DT);
}
const fed = (r: Rig): void => { r.w.set(r.p, G.Survival, { hunger: 100, thirst: 100 }); };
/** Run the travel behaviour (+ the ADR-321 mount policy) for `trips` goals; returns the farthest distance from `from`. */
function travelFor(r: Rig, trips: number, maxTicks: number, from = r.home, each?: () => void): { far: number; done: number; kinds: string[] } {
  const b = G.travelBehaviors()[0]!; let far = 0, done = 0; const kinds: string[] = [];
  for (let i = 0; i < maxTicks && done < trips; i++) {
    if (!mem(r).travel) mem(r).travelAt = -1e9; // skip the idle cooldown between goals
    const had = !!mem(r).travel; const c = ctxOf(r); const o = out();
    if (c.world.travel?.route) { if (!kinds.length || kinds.at(-1) !== `${c.world.travel.kind}@${c.world.travel.since}`) kinds.push(`${c.world.travel.kind}@${c.world.travel.since}`); b.run(c, o); G.mountPolicy(c, o, "travel"); }
    move(r, o); r.w.step(DT); fed(r); each?.();
    if (had && !mem(r).travel) done++;
    const p = pos(r); far = Math.max(far, Math.hypot(p.x - from.x, p.y - from.y));
  }
  return { far, done, kinds: kinds.map((k) => k.split("@")[0]!) };
}

describe("ADR-324 long-range goals and routes", () => {
  it("an unattached AI walks a hierarchical route far past the old caps (48-tile home, 192-tile base, 36-tile trips, 24-tile nav)", () => {
    const r = rig(); mem(r).travelAt = -1e9; const c = ctxOf(r);
    expect(c.world.travelMode).toBe("free");
    const tr = c.world.travel!; expect(tr.kind).toBe("explore"); expect(Math.hypot(tr.x, tr.y)).toBeGreaterThanOrEqual(T.exploreMinTiles - 1);
    expect(tr.route!.length).toBeGreaterThan(8); // region legs, each within local nav reach
    for (let i = 1; i < tr.route!.length; i++) expect(Math.hypot(tr.route![i]!.x - tr.route![i - 1]!.x, tr.route![i]!.y - tr.route![i - 1]!.y)).toBeLessThan(24);
    const res = travelFor(r, 1, 9000);
    expect(res.done).toBe(1); expect(res.far).toBeGreaterThan(4 * G.HOME_MAX_DIST);
    const p = pos(r); expect(Math.hypot(p.x - tr.x, p.y - tr.y)).toBeLessThanOrEqual(T.arriveTiles + 0.5);
  });
  it("routes around impassable (all-water) regions and is deterministic", () => {
    const w = makeWorld(); for (let ry = -3; ry <= 3; ry++) G.setRegionCost(w, 3, ry, Infinity); // a lake wall at x 48..64
    const a = G.planRegionRoute(w, 0, 0, 300, 0)!, b = G.planRegionRoute(w, 0, 0, 300, 0)!;
    const s = T.regionTiles; expect(a.every((p) => Math.floor(p.x / s) !== 3 || Math.abs(Math.floor(p.y / s)) > 3)).toBe(true);
    expect(a.some((p) => Math.abs(Math.floor(p.y / s)) > 3)).toBe(true); // detoured around
    const gx = Math.floor(300 / s); for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === 2) G.setRegionCost(w, gx + dx, dy, Infinity);
    expect(G.planRegionRoute(w, 0, 0, 300, 0)).toBeUndefined(); // a goal ringed by water: unreachable, the budget ends the search
    expect(a).toEqual(b); expect(a.at(-1)).toEqual({ x: 300, y: 0 });
  });
});

describe("ADR-324 attachment", () => {
  const clan = (r: Rig, goal = 0): void => { r.w.add(r.p, G.ClanStatus, { clan: 5, role: 1, goal, goalX: 0, goalY: 0, contrib: 0 }); };
  const traits = (r: Rig, roam: boolean): void => { Object.assign(r.a.identity.traits, roam ? { bravery: 1, sociability: 0, industriousness: 1, greed: 1 } : { bravery: 0, sociability: 1, industriousness: 0, greed: 0 }); };
  it("a clan member who prefers to stay keeps every trip within clanStayRadius of the clan anchor", () => {
    const r = rig(); clan(r); traits(r, false); expect(G.roamPreference(r.a.identity.traits)).toBeLessThan(T.roamTraitMin);
    mem(r).travelAt = -1e9; expect(ctxOf(r).world.travelMode).toBe("stay");
    const res = travelFor(r, 3, 12000); expect(res.done).toBe(3); expect(res.far).toBeLessThanOrEqual(T.clanStayRadius + T.arriveTiles);
  });
  it("a clan order (Defend) holds even a roamer at home", () => {
    const r = rig(); clan(r, 3); traits(r, true); expect(G.travelMode(r.w, r.p, r.a)).toBe("stay");
  });
  it("a roaming clan member goes far and comes back after roamReturnTicks", () => {
    const r = rig(); clan(r); traits(r, true); mem(r).travelAt = -1e9; const c = ctxOf(r); expect(c.world.travelMode).toBe("roam");
    expect(Math.hypot(c.world.travel!.x, c.world.travel!.y)).toBeGreaterThan(T.clanStayRadius);
    const out1 = travelFor(r, 1, 9000); expect(out1.far).toBeGreaterThan(T.clanStayRadius * 3);
    mem(r).roamSince = r.w.tick - T.roamReturnTicks - 1; mem(r).travelAt = -1e9;
    const back = ctxOf(r).world.travel!; expect(back.kind).toBe("return"); expect(back).toMatchObject({ x: 0, y: 0 });
    const res = travelFor(r, 1, 9000); expect(res.done).toBe(1);
    expect(Math.hypot(pos(r).x, pos(r).y)).toBeLessThanOrEqual(T.arriveTiles + 0.5); expect(mem(r).roamSince).toBeUndefined();
  });
  it("a hired worker stays with its employer unless sent", () => {
    const r = rig(); r.w.add(r.p, G.Worker, { owner: 7, homeX: 0, homeY: 0 } as never); mem(r).travelAt = -1e9;
    let c = ctxOf(r); expect(c.world.travelMode).toBe("worker"); expect(c.world.travel).toBeUndefined();
    r.w.step(DT); mem(r).travelAt = -1e9; expect(ctxOf(r).world.travel).toBeUndefined();
    G.orderTravel(r.a, 60, 10, r.w.tick); c = ctxOf(r); expect(c.world.travel).toMatchObject({ kind: "sent", x: 60, y: 10 });
  });
});

describe("ADR-324 off-screen simulation", () => {
  it("steps a far bot coarsely along its route and keeps position + leg continuous across a reload and the hand-back", () => {
    const r = rig(); G.orderTravel(r.a, 400, 0, r.w.tick); ctxOf(r); const tr = mem(r).travel!; expect(tr.route?.length).toBeGreaterThan(10);
    const far = [{ x: -2000, y: 0 }]; expect(G.wantsOffscreen(r.a, 0, 0, far)).toBe(true); expect(G.wantsOffscreen(r.a, 0, 0, [{ x: 20, y: 0 }])).toBe(false);
    r.w.set(r.p, G.Survival, { hunger: 10 });
    for (let i = 0; i < 20; i++) expect(G.offscreenStep(r.w, r.p, r.a, T.offscreen.stepTicks)).toBe("moved");
    const p1 = { ...pos(r) }; expect(p1.x).toBeGreaterThan(18 * T.offscreen.speedTilesPerSec); expect(p1.x).toBeLessThanOrEqual(20 * T.offscreen.speedTilesPerSec + 1e-3); // 20 s of coarse walking
    expect(r.w.get(r.p, G.Survival)!.hunger).toBeGreaterThanOrEqual(T.offscreen.needsFloor);
    const leg = mem(r).travel!.leg;
    // reload: the identity (with AiMemory) goes through JSON like game.agents, a fresh agent picks up the same trip
    const id = JSON.parse(JSON.stringify(r.a.identity)); const a2 = G.makeAgent(id, 1); const r2: Rig = { ...r, a: a2 };
    expect((aiMemoryOf(a2) as unknown as Mem).travel?.leg).toBe(leg);
    expect(G.offscreenStep(r2.w, r2.p, a2, T.offscreen.stepTicks)).toBe("moved");
    const p2 = pos(r2); expect(Math.hypot(p2.x - p1.x, p2.y - p1.y)).toBeCloseTo(T.offscreen.speedTilesPerSec, 2); // one more coarse second, no jump
    // hand-back: full sim walks on toward the same waypoint, then to the goal
    const c = ctxOf(r2); const wp = G.currentWaypoint(c.world.travel!, c.self.x, c.self.y)!; expect(wp.x).toBeGreaterThan(p2.x);
    const res = travelFor(r2, 1, 12000); expect(res.done).toBe(1); expect(pos(r2).x).toBeGreaterThan(400 - T.arriveTiles - 0.5);
  });
});

describe("ADR-324 budget", () => {
  it("plans at most maxPlansPerTick long routes per tick; the rest are served on later ticks", () => {
    const w = makeWorld(); const got: (unknown)[] = [];
    for (let i = 0; i < 10; i++) got.push(G.requestRoute(w, `a${i}`, 0, 0, 200 + i, 0));
    expect(got.filter((g) => Array.isArray(g)).length).toBe(T.maxPlansPerTick); expect(got.slice(T.maxPlansPerTick).every((g) => g === undefined)).toBe(true);
    expect(G.plansThisTick(w)).toBe(T.maxPlansPerTick);
    w.step(DT); expect(Array.isArray(G.requestRoute(w, "a5", 0, 0, 205, 0))).toBe(true);
  });
  it("ten bots choosing goals on the same tick never plan more than the budget", () => {
    const base = rig(); const rs: Rig[] = [base]; for (let i = 1; i < 10; i++) rs.push(rig({ w: base.w, slot: i, x: i * 3 }));
    for (const r of rs) mem(r).travelAt = -1e9;
    for (const r of rs) ctxOf(r);
    expect(G.plansThisTick(base.w)).toBeLessThanOrEqual(T.maxPlansPerTick);
    expect(rs.filter((r) => mem(r).travel?.route).length).toBe(T.maxPlansPerTick);
    for (let t = 0; t < 3; t++) { base.w.step(DT); for (const r of rs) ctxOf(r); expect(G.plansThisTick(base.w)).toBeLessThanOrEqual(T.maxPlansPerTick); }
    expect(rs.every((r) => mem(r).travel?.route)).toBe(true);
  });
});
