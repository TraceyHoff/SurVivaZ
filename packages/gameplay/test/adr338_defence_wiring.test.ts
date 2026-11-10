// ADR-338 wiring: the defence layer is actually used — buildAgentView (after the hire sensors) sets
// defenceTarget for a threatened bot with its own claim and surplus, the build_defence behaviour
// is in the registry, and a bot with no threat / no claim / hired gets no target.
import { describe, expect, it } from "vitest";
import { installPermissions, NetId, PlayerId, type Agent, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { aiMemoryOf } from "../src/ai/planner.js";
import { makeWorld, plantClaim, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
const iid = (k: string): number => d.itemId(k);
const BASE = { x: 10, y: 10 };
let nid = 9700;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };
const pid = (w: World, e: Entity, id: number): Entity => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); return e; };
interface Rig { w: World; p: Entity; a: Agent; home: { x: number; y: number } }
function rig(opts: { claim?: boolean; hired?: boolean } = {}): Rig {
  const w = makeWorld(); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = spawnLearned(w, { x: BASE.x + 1, y: BASE.y + 3.3, maxWeight: 0, clientId: 1 }); pid(w, p, 9); net(w, p);
  steps(w, 1);
  if (opts.claim !== false) plantClaim(w, p, BASE.x - 2, BASE.y - 2);
  const a = G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1);
  (aiMemoryOf(a) as unknown as { base: { x: number; y: number } }).base = { ...BASE };
  if (opts.hired) w.add(p, G.Worker, { owner: 7, homeX: BASE.x, homeY: BASE.y, job: G.WorkerJob.None } as never);
  // surplus materials (same basket as the slice tests)
  for (const [k, n] of [["scrap_metal", 50], ["sticks", 99], ["planks", 50], ["rope", 30], ["spring", 50], ["iron_ingot", 30], ["nails", 99], ["crude_oil", 20], ["wood", 50], ["stone", 50]] as const) G.addItem(w, p, iid(k), n);
  return { w, p, a, home: { x: BASE.x + 1, y: BASE.y + 1 } };
}
const viewOf = (r: Rig): G.AgentWorldView => G.buildAgentView(r.w, r.p, r.a, r.home)!.world;
const threaten = (r: Rig, n = 3): void => { for (let i = 0; i < n; i++) G.noteDefenceEvent(r.a, "sighting", r.w.tick); };

describe("ADR-338 wiring: buildAgentView + registry", () => {
  it("a threatened bot with its own claim and surplus gets a barbed-wire target through the real view", () => {
    const r = rig(); threaten(r);
    const v = viewOf(r);
    expect(v.base).toBeDefined();
    expect(v.defenceTarget).toBeDefined();
    expect(v.defenceTarget!.key).toBe("barbed_wire");
    expect(v.defenceTarget!.threat).toBeGreaterThanOrEqual(2);
  });

  it("the same bot with no threat history gets no target", () => {
    const r = rig();
    expect(viewOf(r).defenceTarget).toBeUndefined();
  });

  it("one sighting (level 1) is not enough to build", () => {
    const r = rig(); threaten(r, 1);
    expect(viewOf(r).defenceTarget).toBeUndefined();
  });

  it("a threatened bot with no claim of its own gets no target", () => {
    const r = rig({ claim: false }); threaten(r);
    expect(viewOf(r).defenceTarget).toBeUndefined();
  });

  it("a threatened hired worker gets no target (defence is for one's own territory)", () => {
    const r = rig({ hired: true }); threaten(r);
    expect(viewOf(r).defenceTarget).toBeUndefined();
  });

  it("the survivor registry carries build_defence", () => {
    expect(G.survivorRegistry().list().map((b) => b.name)).toContain("build_defence");
  });

  it("threat events persist through flushDefenceMemory", () => {
    const r = rig(); threaten(r);
    viewOf(r); // sensor pass prunes/keeps the events
    const seen: { id: string; partial: { defence: unknown } }[] = [];
    expect(G.flushDefenceMemory([r.a], (id, partial) => { seen.push({ id, partial }); }, r.w.tick, true)).toEqual([r.a.identity.id]);
    expect(seen).toHaveLength(1);
    expect((seen[0]!.partial.defence as { events: { kind: string }[] }).events.filter((e) => e.kind === "sighting")).toHaveLength(3);
  });
});
