// ADR-336 wiring: the life layer is actually used — buildAgentView (last sensor) sets lifeWant for an
// idle hired worker, the life_want behaviour runs it, a busy worker gets no want, and the registry
// carries the behaviour. The unhired idle path is covered by the slice tests on hand-built views;
// here the hired path is driven through the real view, because makePlan rarely returns "idle" for a
// fresh bot (it first wants a campfire, tools, a base) while hire.idle is directly observable.
import { describe, expect, it } from "vitest";
import { idleOutput, installPermissions, NetId, PlayerId, setTimeOfDay, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { personalityOf } from "../src/ai/life.js";
import { makeWorld, spawnLearned } from "./helpers.js";

let nid = 9600;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };
const pid = (w: World, e: Entity, id: number): Entity => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); return e; };
interface Rig { w: World; p: Entity; boss: Entity; a: Agent; home: { x: number; y: number } }
function rig(job: number): Rig {
  const w = makeWorld({}, 42); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const boss = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }); pid(w, boss, 7); net(w, boss);
  const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 55 }); pid(w, p, 55); net(w, p);
  w.add(p, G.Worker, { owner: 7, homeX: 0, homeY: 0, job } as never);
  const a = G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1);
  w.set(p, G.Survival, { hunger: 100, thirst: 100 });
  // park the clock inside the bot's own rhythm so routine gating does not block the pick
  setTimeOfDay(w, personalityOf(a).rhythm === "owl" ? 2 : 12);
  return { w, p, boss, a, home: { x: 0, y: 0 } };
}
const viewOf = (r: Rig): G.AgentWorldView => G.buildAgentView(r.w, r.p, r.a, r.home)!.world;
type Ctx = AgentContext<G.AgentWorldView>;
const ctxOf = (r: Rig): Ctx => { const v = G.buildAgentView(r.w, r.p, r.a, r.home)!; return { self: v.self, bb: r.a.bb, memory: r.a.memory, traits: r.a.identity.traits, rng: r.a.rng, agent: r.a, world: v.world }; };
const out = (): AgentOutput & { commands?: G.AgentCommand[] } => ({ ...idleOutput(), actions: [] as string[] });

describe("ADR-336 wiring: buildAgentView + registry + life_want behaviour", () => {
  it("an idle hired worker gets a want through the real view, and life_want eats the favourite food", () => {
    const r = rig(G.WorkerJob.None);
    const pers = personalityOf(r.a);
    G.addItem(r.w, r.p, G.gameplayDefs(r.w).itemId(pers.favouriteFood), 3);
    const v = viewOf(r);
    expect(v.hire?.idle).toBe(true);
    expect(v.lifeWant?.kind).toBe("eat_favourite");
    expect(v.lifeMood?.label).toBeTruthy();
    const c = ctxOf(r); const o = out();
    const b = G.lifeBehaviors()[0]!;
    expect(b.name).toBe("life_want");
    expect(b.considerations.every((k) => k.input(c) >= 0.5)).toBe(true);
    b.run(c, o);
    expect(o.actions).toContain(`eat:${v.lifeWant!.slot}`);
  });

  it("a Follow worker (never idle) gets no want through the real view", () => {
    const r = rig(G.WorkerJob.Follow);
    const v = viewOf(r);
    expect(v.hire?.idle).toBe(false);
    expect(v.lifeWant).toBeUndefined();
  });

  it("the survivor registry carries life_want", () => {
    expect(G.survivorRegistry().list().map((b) => b.name)).toContain("life_want");
  });

  it("running life_want records the completion in the bot's life state", () => {
    const r = rig(G.WorkerJob.None);
    const pers = personalityOf(r.a);
    G.addItem(r.w, r.p, G.gameplayDefs(r.w).itemId(pers.favouriteFood), 3);
    const v = viewOf(r);
    expect(v.lifeWant?.kind).toBe("eat_favourite");
    const c = ctxOf(r); const o = out();
    G.lifeBehaviors()[0]!.run(c, o);
    expect(o.actions).toContain(`eat:${v.lifeWant!.slot}`);
    expect(G.lifeStateOf(r.a).completed["favourite_food"]?.count).toBe(1);
  });
});
