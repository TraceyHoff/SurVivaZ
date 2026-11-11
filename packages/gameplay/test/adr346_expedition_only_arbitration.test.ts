// ADR-346: the ADR-343 route gate applies to resource expeditions only. ADR-343 gated the local trip
// and return_home on ANY active route; that broke ADR-203 (a bot builds a campfire near home before
// night): once an explore route was assigned, a bot with unmet needs could no longer take the local trip
// that gathers flag/fire materials near home, and at dusk it could no longer come home — it walked the
// explore route instead. Bisect: adr203 passes 3/3 at base 5300607, fails 1/3 with ADR-343/344/345.
// The gate's rationale (the trip out-scores travel ~1.0 vs 0.55 and hijacks an expedition into 36-tile
// loops) only holds for an expedition with a destination that matters; an explore route is undirected
// wandering the trip is allowed to interrupt, as at base.
import { describe, expect, it } from "vitest";
import { installPermissions, NetId, PlayerId, scoreBehavior, Transform, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { aiMemoryOf } from "../src/ai/planner.js";
import { DT, makeWorld, spawnLearned } from "./helpers.js";

let nid = 9200;
interface Rig { w: World; p: Entity; a: Agent; home: { x: number; y: number } }
function rig(opts: { seed?: number; slot?: number; x?: number; y?: number } = {}): Rig {
  const w = makeWorld({}, opts.seed ?? 42); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const x = opts.x ?? 0, y = opts.y ?? 0; const p = spawnLearned(w, { x, y, maxWeight: 0, clientId: 7 }); w.add(p, PlayerId, { id: 7 + (opts.slot ?? 0) }); w.add(p, NetId, { id: ++nid });
  const a = G.makeAgent(G.makeAgentIdentity(3, opts.slot ?? 0, "bot_gatherer"), 1);
  return { w, p, a, home: { x, y } };
}
type Ctx = AgentContext<G.AgentWorldView>;
const ctxOf = (r: Rig): Ctx => { const v = G.buildAgentView(r.w, r.p, r.a, r.home)!; return { self: v.self, bb: r.a.bb, memory: r.a.memory, traits: r.a.identity.traits, rng: r.a.rng, agent: r.a, world: v.world }; };
const mem = (r: Rig): { travel?: G.TravelState } => aiMemoryOf(r.a) as unknown as { travel?: G.TravelState };
const route = (kind: G.TravelState["kind"]): G.TravelState => ({ kind, x: 800, y: 0, since: 0, leg: 0, origin: { x: 0, y: 0 }, route: [{ x: 100, y: 0 }, { x: 800, y: 0 }] });
function move(r: Rig, o: AgentOutput): void {
  let bits = 0; const len = Math.hypot(o.moveX, o.moveY);
  if (len > 1e-6) { if (o.moveX > 0.38 * len) bits |= G.GameplayActions.MoveRight; else if (o.moveX < -0.38 * len) bits |= G.GameplayActions.MoveLeft; if (o.moveY > 0.38 * len) bits |= G.GameplayActions.MoveDown; else if (o.moveY < -0.38 * len) bits |= G.GameplayActions.MoveUp; }
  G.applyMovementInput(r.w, r.p, bits, DT);
}
const fed = (r: Rig): void => { r.w.set(r.p, G.Survival, { hunger: 100, thirst: 100 }); };

describe("ADR-346 the route gate applies to resource expeditions only", () => {
  it("trip scores with an explore route (and runs without one); it is still 0 on a resource route", () => {
    const r = rig();
    const reg = G.survivorRegistry();
    const base = ctxOf(r);
    // daylight, far from home, a wanted node the trip could walk to: the ADR-203 early-game loop
    const explore: Ctx = { ...base, self: { ...base.self, x: 400, y: 0, phase: "day" }, world: { ...base.world, home: { x: 0, y: 0 }, tripWanted: true, travel: route("explore") } };
    const resource: Ctx = { ...base, self: { ...base.self, x: 400, y: 0, phase: "day" }, world: { ...base.world, home: { x: 0, y: 0 }, tripWanted: true, travel: route("resource") } };
    expect(scoreBehavior(reg.get("trip")!, explore, undefined, [])).toBeGreaterThan(0);
    expect(scoreBehavior(reg.get("trip")!, resource, undefined, [])).toBe(0);
  });
  it("return_home scores at night far from home on an explore route; still floored on a resource route", () => {
    const r = rig();
    const reg = G.survivorRegistry();
    const base = ctxOf(r);
    const explore: Ctx = { ...base, self: { ...base.self, x: 400, y: 0, phase: "night" }, world: { ...base.world, home: { x: 0, y: 0 }, travel: route("explore") } };
    const resource: Ctx = { ...base, self: { ...base.self, x: 400, y: 0, phase: "night" }, world: { ...base.world, home: { x: 0, y: 0 }, travel: route("resource") } };
    expect(scoreBehavior(reg.get("return_home")!, explore, undefined, [])).toBeGreaterThan(0.5);
    expect(scoreBehavior(reg.get("return_home")!, resource, undefined, [])).toBeLessThan(0.1);
  });
  it("an in-progress trip survives an explore route but is ended by a resource route", () => {
    const r = rig();
    const reg = G.survivorRegistry();
    const trip = { x: 20, y: 0, t0: 0, ret: false, max: 20 };
    const base = ctxOf(r);
    r.a.bb.set("trip", { ...trip });
    const explore: Ctx = { ...base, self: { ...base.self, x: 10, y: 0, phase: "day" }, world: { ...base.world, home: { x: 0, y: 0 }, tripWanted: true, travel: route("explore") } };
    expect(scoreBehavior(reg.get("trip")!, explore, undefined, [])).toBeGreaterThan(0);
    expect(r.a.bb.get("trip")).toBeDefined(); // not ended: the trip runs its course, the route waits
    const resource: Ctx = { ...base, self: { ...base.self, x: 10, y: 0, phase: "day" }, world: { ...base.world, home: { x: 0, y: 0 }, tripWanted: true, travel: route("resource") } };
    expect(scoreBehavior(reg.get("trip")!, resource, undefined, [])).toBe(0);
    expect(r.a.bb.get("trip")).toBeUndefined(); // ended, as ADR-343 pins
  });
  it("full-sim: a bot with unmet needs on an explore route starts a local trip instead of walking the route", () => {
    const r = rig();
    // a plan with unmet leaves (no wood/stone in the bag) makes tripWanted true on the sensor pass
    mem(r).travel = route("explore");
    const ctl = G.survivorController({ seed: 1 }); ctl.add(r.a);
    let started = false;
    for (let i = 0; i < 600 && !started; i++) {
      const o = ctl.tick(r.w.tick, () => G.buildAgentView(r.w, r.p, r.a, r.home)!).get(r.a)!;
      move(r, o); r.w.step(DT); fed(r);
      started = r.a.bb.get("trip") !== undefined;
    }
    expect(started).toBe(true);
  });
});
