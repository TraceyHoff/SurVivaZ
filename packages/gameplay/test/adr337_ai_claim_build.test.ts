// ADR-337: AI claims and builds (Task 37, question 3) — an unhired AI human with no home
// and met survival needs claims land: it repairs / rebuilds the nearest mostly-intact
// abandoned ruin, or plants a Claim Flag and builds an enclosed hut of its own design.
// The layer is unwired here: these tests drive planClaimRuin / planOwnHome /
// chooseClaim / fillClaimSensors / claimBuildBehaviors directly (see
// /tmp/task37-337-integration.md for the coordinator wiring).
import { describe, expect, it } from "vitest";
import { idleOutput, installPermissions, NetId, PlayerId, Transform, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import {
  CLAIM_DATA, chooseClaim, claimBuildBehaviors, fillClaimSensors, hasPlannerHome, isHiredBot,
  planClaimRuin, planOwnHome, ruinLayout, scanClaimRuins, variantFor, type ClaimView,
} from "../src/ai/claim_build.js";
import { aiMemoryOf, claimBaseSite } from "../src/ai/planner.js";
import { makeWorld, plantClaim, spawnLearned } from "./helpers.js";

let nid = 9700;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };
const pid = (w: World, e: Entity, id: number): Entity => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); return e; };

interface Rig { w: World; p: Entity; a: Agent; home: { x: number; y: number } }
function rig(opts: { seed?: number; x?: number; y?: number; pid?: number } = {}): Rig {
  const w = makeWorld({}, opts.seed ?? 42); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const x = opts.x ?? 0, y = opts.y ?? 0; const p = spawnLearned(w, { x, y, maxWeight: 0, clientId: opts.pid ?? 7 }); pid(w, p, opts.pid ?? 7); net(w, p);
  const a = G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1);
  return { w, p, a, home: { x, y } };
}
const pos = (w: World, e: Entity): { x: number; y: number } => w.get(e, Transform)!;
const fed = (r: Rig): void => { r.w.set(r.p, G.Survival, { hunger: 100, thirst: 100, bodyTemp: 37 }); };
/** Senses run 10 ticks apart and the ruin layout is cached 20 ticks (like scanBase): advance the clock after mutating the world. */
const tick = (r: Rig, n = 25): void => { r.w.tick += n; };
const stock = (r: Rig, keys: readonly string[] = ["wood", "stone", "sticks", "planks", "rope", "nails", "fiber", "clay", "dye", "berries"], n = 20): void => {
  const d = G.gameplayDefs(r.w);
  for (const k of keys) { try { G.addItem(r.w, r.p, d.itemId(k), n); } catch { /* renamed */ } }
};
/** Stamp a ruin and return its marker + placed pieces. */
function stampRuin(r: Rig, ox: number, oy: number, kind: number, ruin: number): { marker: Entity; placed: Entity[] } {
  const res = G.stampAbandonedSite(r.w, ox, oy, { kind: kind as never, rot: 0, ruin, tier: 1 });
  expect(res.skipped, `stamp at ${ox},${oy}`).toBe(false);
  return { marker: res.marker as Entity, placed: res.placed };
}
const piecesIn = (r: Rig, ox: number, oy: number, w: number, h: number): Entity[] => {
  const out: Entity[] = [];
  for (const e of r.w.query([G.BuildPiece, Transform])) {
    const t = r.w.get(e, Transform)!;
    if (t.x >= ox - 0.6 && t.x <= ox + w + 0.6 && t.y >= oy - 0.6 && t.y <= oy + h + 0.6) out.push(e);
  }
  return out;
};
const keyOf = (r: Rig, e: Entity): string => G.gameplayDefs(r.w).pieces.get(r.w.getField(e, G.BuildPiece, "type")!)?.key ?? "?";
const damage = (r: Rig, e: Entity, frac: number): void => {
  const max = G.gameplayDefs(r.w).pieces.get(r.w.getField(e, G.BuildPiece, "type")!)!.hp;
  r.w.setField(e, G.BuildPiece, "hp", Math.max(1, Math.round(max * frac)));
};
type Ctx = AgentContext<G.AgentWorldView>;
const ctxOf = (r: Rig): Ctx => { const v = G.buildAgentView(r.w, r.p, r.a, r.home)!; return { self: v.self, bb: r.a.bb, memory: r.a.memory, traits: r.a.identity.traits, rng: r.a.rng, agent: r.a, world: v.world }; };
const out = (): AgentOutput & { commands?: G.AgentCommand[] } => ({ ...idleOutput(), actions: [] as string[] });
const stubView = (r: Rig): G.AgentWorldView => ({ seen: [], home: { ...r.home }, playerName: "bot" }) as unknown as G.AgentWorldView;

describe("ADR-337 ruin selection", () => {
  it("the nearest suitable ruin wins, and the choice is deterministic", () => {
    const r = rig({ x: 10, y: 10 }); fed(r);
    const near = stampRuin(r, 8, 8, G.AbandonedKind.Shed, 0.1);
    const far = stampRuin(r, 20, 20, G.AbandonedKind.Cottage, 0.1);
    const a = chooseClaim(r.w, r.p, r.a);
    expect(a?.kind).toBe("ruin"); expect(a?.marker).toBe(near.marker);
    expect(chooseClaim(r.w, r.p, r.a)).toEqual(a); // same (bot, world) -> same choice
    void far;
  });
  it("is deterministic for the same seed rebuilt from scratch", () => {
    const run = (): number | undefined => {
      const r = rig({ x: 10, y: 10 }); fed(r);
      stampRuin(r, 8, 8, G.AbandonedKind.Shed, 0.1);
      stampRuin(r, 20, 20, G.AbandonedKind.Cottage, 0.1);
      return chooseClaim(r.w, r.p, r.a)?.marker;
    };
    expect(run()).toBe(run());
  });
  it("a too-ruined ruin (mostly damaged) and a claimed ruin are skipped", () => {
    const r = rig({ x: 10, y: 10 }); fed(r);
    const ruined = stampRuin(r, 8, 8, G.AbandonedKind.Cottage, 0.9);
    const info = scanClaimRuins(r.w, 10, 10).find((q) => q.marker === ruined.marker)!;
    expect(info.intact).toBeGreaterThan(0.5); // walls/foundations still stand...
    expect(info.damagedFrac).toBeGreaterThan(CLAIM_DATA.maxDamagedFrac); // ...but most are damaged
    const other = stampRuin(r, 24, 8, G.AbandonedKind.Shed, 0.1);
    r.w.setField(other.marker, G.AbandonedSite, "claimed", 1);
    r.w.setField(other.marker, G.AbandonedSite, "claimedBy", 99);
    const a = chooseClaim(r.w, r.p, r.a);
    expect(a?.marker).not.toBe(ruined.marker);
    expect(a?.marker).not.toBe(other.marker);
  });
  it("a ruin demolished past minIntact is skipped", () => {
    const r = rig({ x: 10, y: 10 }); fed(r);
    const s = stampRuin(r, 8, 8, G.AbandonedKind.Cottage, 0.1);
    expect(ruinLayout(r.w, s.marker)?.intact).toBeCloseTo(1, 1);
    for (const e of piecesIn(r, 8, 8, 5, 5)) r.w.destroy(e);
    tick(r);
    expect(ruinLayout(r.w, s.marker)?.intact).toBe(0);
    const a = chooseClaim(r.w, r.p, r.a);
    expect(a?.marker).not.toBe(s.marker);
  });
  it("a ruin inside another agent's claim is rejected (no claim overlap)", () => {
    const r = rig({ x: 10, y: 10 }); fed(r);
    const s = stampRuin(r, 8, 8, G.AbandonedKind.Shed, 0.1);
    const other = spawnLearned(r.w, { x: 4, y: 4, maxWeight: 0, clientId: 8 }); pid(r.w, other, 8); net(r.w, other);
    plantClaim(r.w, other, 4, 4); // radius 32 covers the ruin at (8,8)
    expect(G.hasOwnClaim(r.w, other, 9.5, 9.5)).toBe(true);
    const a = chooseClaim(r.w, r.p, r.a);
    expect(a?.marker).not.toBe(s.marker);
  });
  it("another agent's reserved site beside the ruin is respected", () => {
    const r = rig({ x: 10, y: 10 }); fed(r);
    const s = stampRuin(r, 8, 8, G.AbandonedKind.Shed, 0.1);
    const other = spawnLearned(r.w, { x: 20, y: 20, maxWeight: 0, clientId: 8 }); pid(r.w, other, 8); net(r.w, other);
    claimBaseSite(r.w, other, { x: 8, y: 8 }); // in-memory site reservation on the ruin
    expect(chooseClaim(r.w, r.p, r.a)?.marker).not.toBe(s.marker);
  });
});

describe("ADR-337 rebuild-vs-new choice", () => {
  it("a near intact ruin wins; the same ruin far away loses to building new", () => {
    const r = rig({ x: 10, y: 10 }); fed(r);
    const s = stampRuin(r, 8, 8, G.AbandonedKind.Shed, 0.1);
    expect(chooseClaim(r.w, r.p, r.a)?.marker).toBe(s.marker);
    // walk the bot away: the ruin is now 20+ tiles off, past ruinPreferDist
    r.w.set(r.p, Transform, { x: 30, y: 30 });
    const a = chooseClaim(r.w, r.p, r.a);
    expect(a?.kind).toBe("new"); expect(a?.marker).toBeUndefined();
  });
  it("a near ruin that is too ruined loses to a farther good ruin", () => {
    const r = rig({ x: 10, y: 10 }); fed(r);
    const bad = stampRuin(r, 8, 8, G.AbandonedKind.Cottage, 0.9);
    const good = stampRuin(r, 16, 16, G.AbandonedKind.Shed, 0.1);
    expect(chooseClaim(r.w, r.p, r.a)?.marker).toBe(good.marker);
    expect(chooseClaim(r.w, r.p, r.a)?.marker).not.toBe(bad.marker);
  });
});

describe("ADR-337 claim-before-build ordering", () => {
  it("a ruin plan emits the flag first, then reclaim, then repair, then rebuild", () => {
    const r = rig({ x: 10, y: 10 }); fed(r); stock(r);
    const s = stampRuin(r, 8, 8, G.AbandonedKind.Cottage, 0.5);
    // 1. flag first: no build step before it
    let plan = planClaimRuin(r.w, r.p, s.marker);
    expect(plan.target.stage).toBe("claim");
    expect(plan.step?.k).toBe("build");
    if (plan.step?.k === "build") expect(G.gameplayDefs(r.w).pieces.get(plan.step.piece)?.key).toBe("claim_totem");
    // 2. flag down -> reclaim
    plantClaim(r.w, r.p, 6.5, 8.5);
    plan = planClaimRuin(r.w, r.p, s.marker);
    expect(plan.target.stage).toBe("reclaim");
    expect(plan.step).toEqual({ k: "reclaim", marker: s.marker });
    expect(G.reclaimAbandonedSite(r.w, r.p, s.marker)).toBe(0);
    // 3. damage one wall -> repair comes before any rebuild
    const wall = piecesIn(r, 8, 8, 5, 5).find((e) => keyOf(r, e) === "wall")!;
    expect(wall).toBeDefined(); damage(r, wall, 0.3); tick(r);
    plan = planClaimRuin(r.w, r.p, s.marker);
    expect(plan.target.stage).toBe("repair");
    expect(plan.step).toEqual({ k: "repair", piece: wall });
    // 4. repaired -> rebuild the missing pieces (one roof tile demolished by hand so a
    // rebuild is guaranteed regardless of the stamp's omit rolls)
    r.w.setField(wall, G.BuildPiece, "hp", G.gameplayDefs(r.w).pieces.get(r.w.getField(wall, G.BuildPiece, "type")!)!.hp);
    const roof = piecesIn(r, 8, 8, 5, 5).find((e) => keyOf(r, e).startsWith("roof_"))!;
    expect(roof).toBeDefined(); r.w.destroy(roof); tick(r);
    plan = planClaimRuin(r.w, r.p, s.marker);
    expect(plan.target.stage).toBe("rebuild");
    expect(plan.step?.k).toBe("build");
  });
  it("a ruin plan with no flag materials gathers first (leaves + planner priority, no step)", () => {
    const r = rig({ x: 10, y: 10 }); fed(r); // empty bag
    const s = stampRuin(r, 8, 8, G.AbandonedKind.Shed, 0.1);
    const plan = planClaimRuin(r.w, r.p, s.marker);
    expect(plan.target.stage).toBe("gather");
    expect(plan.step).toBeUndefined();
    const wood = G.gameplayDefs(r.w).itemId("wood");
    expect(plan.leaves).toContain(wood);
    expect(plan.priority?.some((p) => p.key === "wood" && p.count > 0)).toBe(true);
  });
  it("a new-home plan emits the flag first and no hut piece before it", () => {
    const r = rig({ x: 0, y: 0 }); fed(r); stock(r);
    const plan = planOwnHome(r.w, r.p);
    expect(plan.target.kind).toBe("new");
    expect(plan.target.stage).toBe("claim");
    expect(plan.step?.k).toBe("build");
    if (plan.step?.k === "build") expect(G.gameplayDefs(r.w).pieces.get(plan.step.piece)?.key).toBe("claim_totem");
  });
  it("a ruin whose layout cannot be matched falls back to rebuilding a 2x2 hut", () => {
    const r = rig({ x: 10, y: 10 }); fed(r); stock(r);
    // a bare marker: no pieces at all, so no rotation matches
    const m = r.w.create();
    r.w.add(m, Transform, { x: 8.5, y: 8.5, z: 0 });
    r.w.add(m, G.AbandonedSite, { originX: 8, originY: 8, width: 3, height: 3, kind: G.AbandonedKind.Shed, stories: 1, claimed: 0, claimedBy: 0 });
    expect(ruinLayout(r.w, m)?.fallback).toBe(true);
    plantClaim(r.w, r.p, 6.5, 8.5);
    expect(G.reclaimAbandonedSite(r.w, r.p, m)).toBe(0);
    const plan = planClaimRuin(r.w, r.p, m);
    expect(plan.target.stage).toBe("rebuild");
    expect(plan.step?.k).toBe("build");
    if (plan.step?.k === "build") expect(G.gameplayDefs(r.w).pieces.get(plan.step.piece)?.key).toBe("foundation");
  });
});

describe("ADR-337 who gets a claim plan", () => {
  it("a bot with no home and met needs gets a claim plan; a bot with a home does not", () => {
    const r = rig({ x: 10, y: 10 }); fed(r);
    stampRuin(r, 8, 8, G.AbandonedKind.Shed, 0.1);
    const view = stubView(r);
    expect(fillClaimSensors(r.w, r.p, view, r.a)).toBeDefined();
    expect((view as unknown as ClaimView).claimTarget?.kind).toBe("ruin");
    // a home in progress (site picked, nothing built yet) is still a home
    const r2 = rig({ x: 10, y: 10 }); fed(r2);
    stampRuin(r2, 8, 8, G.AbandonedKind.Shed, 0.1);
    aiMemoryOf(r2.a).base = { x: 0, y: 0 };
    expect(hasPlannerHome(r2.w, r2.p, r2.a)).toBe(true);
    const view2 = stubView(r2);
    expect(fillClaimSensors(r2.w, r2.p, view2, r2.a)).toBeUndefined();
    expect((view2 as unknown as ClaimView).claimTarget).toBeUndefined();
  });
  it("a ruined home (built, then destroyed) frees the bot to claim again", () => {
    const r = rig({ x: 10, y: 10 }); fed(r);
    stampRuin(r, 8, 8, G.AbandonedKind.Shed, 0.1);
    const mem = aiMemoryOf(r.a); mem.base = { x: 0, y: 0 }; mem.stats.built = 4; // was built, now nothing stands there
    expect(hasPlannerHome(r.w, r.p, r.a)).toBe(false);
    expect(fillClaimSensors(r.w, r.p, stubView(r), r.a)).toBeDefined();
  });
  it("a hungry bot, and a hired bot, get no claim plan", () => {
    const r = rig({ x: 10, y: 10 }); fed(r);
    stampRuin(r, 8, 8, G.AbandonedKind.Shed, 0.1);
    r.w.set(r.p, G.Survival, { hunger: 20, thirst: 100, bodyTemp: 37 });
    expect(fillClaimSensors(r.w, r.p, stubView(r), r.a)).toBeUndefined();
    fed(r);
    G.ensureWorker(r.w, r.p);
    r.w.setField(r.p, G.Worker, "owner", 7);
    expect(isHiredBot(r.w, r.p)).toBe(true);
    expect(fillClaimSensors(r.w, r.p, stubView(r), r.a)).toBeUndefined();
  });
  it("a chosen site that becomes invalid is abandoned cleanly", () => {
    const r = rig({ x: 10, y: 10 }); fed(r); stock(r);
    const s = stampRuin(r, 8, 8, G.AbandonedKind.Shed, 0.1);
    const view = stubView(r);
    fillClaimSensors(r.w, r.p, view, r.a);
    expect((view as unknown as ClaimView).claimTarget?.marker).toBe(s.marker);
    // someone else claims the ruin while the bot walks there
    r.w.setField(s.marker, G.AbandonedSite, "claimed", 1);
    r.w.setField(s.marker, G.AbandonedSite, "claimedBy", 99);
    fillClaimSensors(r.w, r.p, view, r.a);
    expect((view as unknown as ClaimView).claimTarget?.marker).not.toBe(s.marker);
  });
});

describe("ADR-337 own design", () => {
  it("the variant is deterministic per bot and uses only real pieces", () => {
    const defs = G.gameplayDefs(makeWorld());
    const variantOf = (pidN: number): string => { const r = rig({ pid: pidN }); return variantFor(r.w, r.p).key; };
    expect(variantOf(4)).toBe("homestead");
    expect(variantOf(1)).toBe("garden");
    expect(variantOf(2)).toBe("fenced");
    expect(variantOf(3)).toBe("workshop");
    for (const v of CLAIM_DATA.variants) {
      for (const ex of v.extras) {
        const def = [...defs.pieces.values()].find((p) => p.key === ex.key);
        expect(def, `variant ${v.key} extra ${ex.key}`).toBeDefined();
        expect(G.pieceCost(defs, def!, 0).length).toBeGreaterThan(0);
      }
    }
  });
  it("a new home hands its site to the planner once the flag is down, then builds its variant extras", () => {
    const r = rig({ x: 0, y: 0, pid: 1 }); fed(r); stock(r); // pid 1 -> garden variant
    const view = stubView(r);
    fillClaimSensors(r.w, r.p, view, r.a);
    const t0 = (view as unknown as ClaimView).claimTarget!;
    expect(t0.kind).toBe("new");
    expect(aiMemoryOf(r.a).base).toBeUndefined(); // no handoff before the flag
    plantClaim(r.w, r.p, t0.x - 1.5, t0.y + 0.5); // the flag slot the plan picked
    fillClaimSensors(r.w, r.p, view, r.a);
    const base = aiMemoryOf(r.a).base;
    expect(base).toBeDefined(); // handoff: the planner owns the hut now
    expect(Math.hypot(base!.x - t0.x, base!.y - t0.y)).toBeLessThan(1); // flag snap may shift the anchor a hair
    // coordinator fix: the extras are decoration, not shelter — they wait until the hut stands,
    // so the bot never gathers clay for a flower bed while its hut is unbuilt.
    let plan = (view as unknown as ClaimView).claimPlan!;
    expect(plan.target.stage).toBe("extras");
    expect(plan.step).toBeUndefined(); // waiting for the hut
    // raise the hut (BASE_SLOTS at the claim site, like the planner's ladder would)
    const d = G.gameplayDefs(r.w);
    for (const sl of G.BASE_SLOTS) {
      const sn = G.snapPlacement(r.w, { piece: d.pieceId(sl.key), x: t0.x + sl.x, y: t0.y + sl.y, level: sl.level, rot: sl.rot ?? 0, tier: sl.tier ?? 0, variant: 0 });
      expect(typeof sn, `snap ${sl.id}`).not.toBe("number");
      if (typeof sn !== "number") G.placePiece(r.w, r.p, sn, { pay: false });
    }
    tick(r); // the base scan is cached: advance the clock so it sees the new hut
    fillClaimSensors(r.w, r.p, view, r.a);
    plan = (view as unknown as ClaimView).claimPlan!;
    expect(plan.target.stage).toBe("extras");
    expect(plan.step?.k).toBe("build");
    if (plan.step?.k === "build") expect(G.gameplayDefs(r.w).pieces.get(plan.step.piece)?.key).toBe("garden_bed");
  });
});

describe("ADR-337 claim_build behavior", () => {
  it("drives the flag build step, then the reclaim step, then the repair step", () => {
    const r = rig({ x: 10, y: 10 }); fed(r); stock(r);
    const s = stampRuin(r, 8, 8, G.AbandonedKind.Cottage, 0.5);
    const b = claimBuildBehaviors()[0]!;
    // flag build
    let plan = planClaimRuin(r.w, r.p, s.marker);
    const flagStep = plan.step;
    expect(flagStep?.k).toBe("build");
    if (flagStep?.k !== "build") throw new Error("expected a flag build step");
    let c = ctxOf(r); (c.world as unknown as ClaimView).claimPlan = plan; (c.world as unknown as ClaimView).claimTarget = plan.target;
    r.w.set(r.p, Transform, { x: flagStep.stand.x, y: flagStep.stand.y });
    c = ctxOf(r); (c.world as unknown as ClaimView).claimPlan = plan; (c.world as unknown as ClaimView).claimTarget = plan.target;
    let o = out(); b.run(c, o);
    const flagPiece = G.gameplayDefs(r.w).pieceId("claim_totem");
    const flagTier = G.gameplayDefs(r.w).pieces.get(flagPiece)!.fixedTier; // the server normalizes to fixedTier for non-tiered pieces
    expect(o.actions).toEqual([`build:${flagPiece}:${flagStep.x}:${flagStep.y}:0:0:${flagTier}`]);
    // reclaim
    plantClaim(r.w, r.p, 6.5, 8.5);
    plan = planClaimRuin(r.w, r.p, s.marker);
    expect(plan.step).toEqual({ k: "reclaim", marker: s.marker });
    c = ctxOf(r); (c.world as unknown as ClaimView).claimPlan = plan; (c.world as unknown as ClaimView).claimTarget = plan.target;
    r.w.set(r.p, Transform, { x: 8.5, y: 8.5 });
    c = ctxOf(r); (c.world as unknown as ClaimView).claimPlan = plan; (c.world as unknown as ClaimView).claimTarget = plan.target;
    o = out(); b.run(c, o);
    expect(o.actions).toContain(`reclaim:${s.marker}`);
    expect(G.reclaimAbandonedSite(r.w, r.p, s.marker)).toBe(0);
    // repair
    const wall = piecesIn(r, 8, 8, 5, 5).find((e) => keyOf(r, e) === "wall")!;
    damage(r, wall, 0.3); tick(r);
    plan = planClaimRuin(r.w, r.p, s.marker);
    expect(plan.step).toEqual({ k: "repair", piece: wall });
    c = ctxOf(r); (c.world as unknown as ClaimView).claimPlan = plan; (c.world as unknown as ClaimView).claimTarget = plan.target;
    const wp = pos(r.w, wall); r.w.set(r.p, Transform, { x: wp.x, y: wp.y });
    tick(r); // the reclaim run set the claimAt cooldown; the next think tick is 25 ticks on
    c = ctxOf(r); (c.world as unknown as ClaimView).claimPlan = plan; (c.world as unknown as ClaimView).claimTarget = plan.target;
    o = out(); b.run(c, o);
    expect(o.actions).toContain(`repair:${wall}`);
  });
  it("emits nothing when the claim plan has no step (gathering)", () => {
    const r = rig({ x: 10, y: 10 }); fed(r); // empty bag: flag materials missing
    const s = stampRuin(r, 8, 8, G.AbandonedKind.Shed, 0.1);
    const plan = planClaimRuin(r.w, r.p, s.marker);
    expect(plan.step).toBeUndefined();
    const b = claimBuildBehaviors()[0]!;
    const c = ctxOf(r); (c.world as unknown as ClaimView).claimPlan = plan; (c.world as unknown as ClaimView).claimTarget = plan.target;
    const o = out(); expect(b.run(c, o)).toBe(false); expect(o.actions).toEqual([]);
  });
});

describe("ADR-337 sensor publishes planner priority", () => {
  it("an unstocked bot's flag materials land on the claimPriority blackboard and the returned leaves", () => {
    const r = rig({ x: 10, y: 10 }); fed(r); // empty bag
    stampRuin(r, 8, 8, G.AbandonedKind.Shed, 0.1);
    const leaves = fillClaimSensors(r.w, r.p, stubView(r), r.a);
    const wood = G.gameplayDefs(r.w).itemId("wood");
    expect(leaves?.has(wood)).toBe(true);
    const prio = r.a.bb.get<{ key: string; count: number }[]>("claimPriority");
    expect(prio?.some((p) => p.key === "wood" && p.count > 0)).toBe(true);
    expect(prio?.some((p) => p.key === "dye" && p.count > 0)).toBe(true); // the flag also costs stone + dye
  });
});
