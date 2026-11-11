// ADR-342 wiring: stock_turret is actually used — buildAgentView (after the hire sensors) sets
// turretAmmoTarget for an idle bot with a low turret and ammo in the base box, the stock_turret
// behaviour is in the registry, and a busy planner gets no target.
import { describe, expect, it } from "vitest";
import { installPermissions, NetId, PlayerId, type Agent, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { aiMemoryOf } from "../src/ai/planner.js";
import { makeWorld, plantClaim, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
const iid = (k: string): number => d.itemId(k);
const BASE = { x: 10, y: 10 };
let nid = 9800;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };
const pid = (w: World, e: Entity, id: number): Entity => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); return e; };
interface Rig { w: World; p: Entity; a: Agent; home: { x: number; y: number } }
function rig(opts: { hired?: boolean } = {}): Rig {
  const w = makeWorld(); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = spawnLearned(w, { x: BASE.x + 1, y: BASE.y + 3.3, maxWeight: 0, clientId: 1 }); pid(w, p, 9); net(w, p);
  steps(w, 1);
  plantClaim(w, p, BASE.x - 2, BASE.y - 2);
  const a = G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1);
  (aiMemoryOf(a) as unknown as { base: { x: number; y: number } }).base = { ...BASE };
  if (opts.hired) w.add(p, G.Worker, { owner: 7, homeX: BASE.x, homeY: BASE.y, job: G.WorkerJob.None } as never);
  // an empty arrow turret + a base box holding a full load of flint arrows
  const tdef = d.pieces.get(d.pieceId("arrow_turret"))!;
  const tsn = G.snapPlacement(w, { piece: tdef.id, x: BASE.x - 4, y: BASE.y - 4, level: 0, rot: 0, tier: tdef.fixedTier, variant: 0 });
  if (typeof tsn === "number") throw new Error(`turret snap failed: ${tsn}`);
  G.placePiece(w, p, tsn, { pay: false });
  const bdef = d.pieces.get(d.pieceId("basic_storage_box"))!;
  const bsn = G.snapPlacement(w, { piece: bdef.id, x: BASE.x + 3.5, y: BASE.y + 1.6, level: 0, rot: 0, tier: bdef.fixedTier, variant: 0 });
  if (typeof bsn === "number") throw new Error(`box snap failed: ${bsn}`);
  const box = G.placePiece(w, p, bsn, { pay: false });
  const att = G.resolveAttachment(w, box, G.AttachKind.Storage)!;
  G.addItem(w, att, iid("flint_arrow"), 30);
  steps(w, 25);
  return { w, p, a, home: { x: BASE.x + 1, y: BASE.y + 1 } };
}
const viewOf = (r: Rig): G.AgentWorldView => G.buildAgentView(r.w, r.p, r.a, r.home)!.world;
/** Snooze the whole ladder (the ADR-341 isolation pattern): the plan comes back idle, no step. */
const snoozeAll = (): Record<string, number> => {
  const key = (g: { k: string; name?: string; key?: string }): string =>
    g.k === "tool" ? g.name! : g.k === "item" ? g.key! : g.k === "piece" ? g.key! : g.k === "wear" ? `wear:${g.key}` : g.k === "furnish" ? `furnish:${g.key}` : g.k;
  return Object.fromEntries(G.GOAL_LADDER.map((g) => [key(g), 10_000_000]));
};

describe("ADR-342 wiring: buildAgentView + registry", () => {
  it("an idle bot with a low turret and ammo in the base box gets a turretAmmoTarget through the real view", () => {
    const r = rig();
    (aiMemoryOf(r.a) as unknown as { snooze: Record<string, number> }).snooze = snoozeAll();
    const v = viewOf(r);
    expect(v.plan?.step).toBeUndefined();
    expect(v.turretAmmoTarget).toBeDefined();
    expect(v.turretAmmoTarget!.key).toBe("arrow_turret");
    expect(v.turretAmmoTarget!.itemKey).toBe("flint_arrow");
    expect(v.turretAmmoTarget!.count).toBe(20);
    expect(v.turretAmmoTarget!.box).toBeDefined();
  });

  it("the same bot with a busy planner gets no target", () => {
    const r = rig(); // no snooze: the ladder wants wood/stone for the first tools (gather leaves, no step yet)
    const v = viewOf(r);
    expect(v.plan && (v.plan.step !== undefined || v.plan.leaves.length > 0)).toBe(true);
    expect(v.turretAmmoTarget).toBeUndefined();
  });

  it("a hired idle worker stocks the turret through the real view (no snooze: the hire sensors clear the plan)", () => {
    const r = rig({ hired: true });
    const v = viewOf(r);
    expect(v.hire?.idle).toBe(true);
    expect(v.plan?.step).toBeUndefined();
    expect(v.turretAmmoTarget).toBeDefined();
    expect(v.turretAmmoTarget!.key).toBe("arrow_turret");
    expect(v.defenceTarget).toBeUndefined(); // hired workers still build nothing
  });

  it("the survivor registry carries stock_turret next to build_defence", () => {
    const names = G.survivorRegistry().list().map((b) => b.name);
    expect(names).toContain("stock_turret");
    expect(names).toContain("build_defence");
  });
});
