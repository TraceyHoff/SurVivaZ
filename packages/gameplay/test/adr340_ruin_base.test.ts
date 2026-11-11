// ADR-340: ruin homes get full base behaviour — a bot that claimed + reclaimed an abandoned
// ruin never gets mem.base (ADR-337), so the planner's behaviour goals (furnish / hearth / bed /
// upgrade / piece / storage) run against the adopted ruin home instead, while the `base` goal
// that builds BASE_SLOTS over the ruin never fires. The ruin marker is the home record; the
// anchor is the ruin centre minus 1 (anchor+1 = ruin centre, the hut anchor convention).
import { describe, expect, it } from "vitest";
import { installPermissions, NetId, PlayerId, setTimeOfDay, Transform, type Agent, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { fillClaimSensors, ruinHomeAnchor, type ClaimView } from "../src/ai/claim_build.js";
import { aiMemoryOf, RUIN_DATA, scanBase } from "../src/ai/planner.js";
import { makeWorld, plantClaim, spawnLearned, steps } from "./helpers.js";

let nid = 9900;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };
const pid = (w: World, e: Entity, id: number): Entity => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); return e; };

interface Rig { w: World; p: Entity; a: Agent; home: { x: number; y: number } }
function rig(opts: { x?: number; y?: number; pid?: number } = {}): Rig {
  const w = makeWorld({}, 42); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const x = opts.x ?? 10, y = opts.y ?? 10; const p = spawnLearned(w, { x, y, maxWeight: 0, clientId: opts.pid ?? 7 }); pid(w, p, opts.pid ?? 7); net(w, p);
  const a = G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1);
  return { w, p, a, home: { x, y } };
}
const d = G.defaultDefs();
const iid = (k: string) => d.itemId(k);
const pos = (w: World, e: Entity): { x: number; y: number } => w.get(e, Transform)!;
const fed = (r: Rig): void => { r.w.set(r.p, G.Survival, { hunger: 100, thirst: 100, bodyTemp: 37 }); };
/** Senses run 10 ticks apart and the ruin layout / base scan cache 20 ticks: advance the clock after mutating the world. */
const tick = (r: Rig, n = 25): void => { r.w.tick += n; };
const stock = (r: Rig, keys: readonly string[] = ["wood", "stone", "sticks", "planks", "rope", "nails", "fiber", "cloth"], n = 20): void => {
  // Lean on purpose: the player bag is 24 slots (16 pack + 8 hotbar), so 99 x 25 types overflows
  // it and the tail items never land (the torch loop in the first run). Eight types cover every
  // goal the bed / furnish walks reach; the walk stocks any other leaf as it appears.
  for (const k of keys) { try { G.addItem(r.w, r.p, iid(k), n); } catch { /* renamed */ } }
};
const stubView = (r: Rig): G.AgentWorldView => ({ seen: [], home: { ...r.home }, playerName: "bot" }) as unknown as G.AgentWorldView;
const viewOf = (r: Rig): G.AgentWorldView => G.buildAgentView(r.w, r.p, r.a, r.home)!.world;
/** Stamp a Shed ruin at (8,8) and return its marker. */
const stampRuin = (r: Rig, ox = 8, oy = 8, ruin = 0.1): Entity => {
  const res = G.stampAbandonedSite(r.w, ox, oy, { kind: G.AbandonedKind.Shed, rot: 0, ruin, tier: 1 });
  expect(res.skipped, `stamp at ${ox},${oy}`).toBe(false);
  return res.marker as Entity;
};
const keyOf = (r: Rig, e: Entity): string => G.gameplayDefs(r.w).pieces.get(r.w.getField(e, G.BuildPiece, "type")!)?.key ?? "?";
/** Claim + reclaim the ruin through the real sensor, then read the adopted home anchor. */
function adoptRuin(r: Rig, marker: Entity): { x: number; y: number; ox: number; oy: number; marker: Entity } {
  const view = stubView(r);
  fillClaimSensors(r.w, r.p, view, r.a);
  expect((view as unknown as ClaimView).claimTarget?.kind).toBe("ruin");
  expect((view as unknown as ClaimView).claimTarget?.marker).toBe(marker);
  plantClaim(r.w, r.p, 6.5, 8.5); // the flag slot the claim plan picked (STATION_SLOTS.claim_totem[0])
  expect(G.reclaimAbandonedSite(r.w, r.p, marker)).toBe(0);
  tick(r);
  const anchor = ruinHomeAnchor(r.w, r.p, r.a);
  expect(anchor, "ruin home after claim + reclaim").toBeDefined();
  return anchor!;
}
const planOf = (r: Rig, anchor: { x: number; y: number }, extra: Partial<G.PlanInput> = {}): G.Plan =>
  G.makePlan({ world: r.w, self: r.p, defs: G.gameplayDefs(r.w), ruinBase: anchor, bs: scanBase(r.w, G.gameplayDefs(r.w), anchor), fails: {}, ...extra });
const giveTools = (r: Rig): void => { for (const k of ["stone_axe", "stone_pickaxe", "stone_knife", "stone_shovel", "bronze_axe", "bronze_pickaxe", "bronze_spear"] as const) G.addItem(r.w, r.p, iid(k), 1); };
/** Give the bot the materials for one piece, then place it (bot teleported to a stand in reach). */
const placeAt = (r: Rig, key: string, x: number, y: number, level = 0, rot = 0, tier?: number): Entity => {
  const defs = G.gameplayDefs(r.w); const def = defs.pieces.get(defs.pieceId(key))!;
  const t = tier ?? (def.tiered ? 0 : def.fixedTier);
  for (const c of G.pieceCost(defs, def, t)) G.addItem(r.w, r.p, c.item, c.count);
  r.w.set(r.p, Transform, { x, y: y + 1.2 });
  const res = G.tryPlace(r.w, r.p, { piece: def.id, x, y, level, rot, tier: t, variant: 0 });
  expect(res.ok, `place ${key} at ${x},${y} (ruin anchor)`).toBe(true);
  return (res as { piece: Entity }).piece;
};
const storageOf = (w: World, piece: Entity): Entity => G.resolveAttachment(w, piece, G.AttachKind.Storage)!;
/**
 * Drive the planner from its current state to `wanted`: each pass executes the emitted build /
 * wear / craft step, or stocks the emitted leaves, until the plan's goal is `wanted`. Returns the
 * plan at `wanted` plus every goal observed on the way (so a test can assert the `base` goal never
 * appeared). Throws with the stalled goal when no step and no leaves can advance it.
 */
function walkTo(r: Rig, anchor: { x: number; y: number }, wanted: string, extra: Partial<G.PlanInput> = {}, maxIter = 60): { plan: G.Plan; seen: string[] } {
  const seen: string[] = [];
  for (let i = 0; i < maxIter; i++) {
    const plan = planOf(r, anchor, extra);
    seen.push(plan.goal);
    if (plan.goal === wanted) return { plan, seen };
    const s = plan.step;
    if (s?.k === "build") {
      const def = G.gameplayDefs(r.w).pieces.get(s.piece)!;
      r.w.set(r.p, Transform, { x: s.stand.x, y: s.stand.y });
      const res = G.tryPlace(r.w, r.p, { piece: s.piece, x: s.x, y: s.y, level: s.level, rot: s.rot ?? 0, tier: s.tier ?? (def.tiered ? 0 : def.fixedTier), variant: 0 });
      expect(res.ok, `${plan.goal}: build ${def.key} at ${s.x},${s.y}`).toBe(true);
      steps(r.w, 25);
    } else if (s?.k === "wear") {
      expect(G.wearSlot(r.w, r.p, s.invSlot), `${plan.goal}: wear slot ${s.invSlot}`).toBe(true);
      G.refreshWorn(r.w, r.p);
    } else if (s?.k === "craft") {
      const out = G.gameplayDefs(r.w).recipes.get(s.recipe)?.output;
      expect(out, `${plan.goal}: craft recipe ${s.recipe}`).toBeDefined();
      const recipe = G.gameplayDefs(r.w).recipes.get(s.recipe)!;
      for (const g of recipe.ingredients) expect(G.removeItem(r.w, r.p, g.item, g.count * s.count), `${plan.goal}: consume ${g.count * s.count}x ${g.item}`).toBe(true);
      G.addItem(r.w, r.p, out!.item, out!.count * s.count);
    } else if (plan.leaves.length) {
      for (const id of plan.leaves) G.addItem(r.w, r.p, id, 20);
    } else if (s) {
      throw new Error(`walkTo(${wanted}) stalled at goal ${plan.goal}: cannot execute step ${JSON.stringify(s)}`);
    } else {
      throw new Error(`walkTo(${wanted}) stalled at goal ${plan.goal} with no step, leaves ${JSON.stringify(plan.leaves)} hunt ${JSON.stringify(plan.hunt)} blocked ${JSON.stringify(plan.blocked)}`);
    }
  }
  throw new Error(`walkTo(${wanted}) did not reach ${wanted} in ${maxIter} passes; saw ${seen.join(" -> ")}`);
}

describe("ADR-340 ruin adoption gate", () => {
  it("ruinBase is undefined until the ruin is claimed + reclaimed, and the anchor centres the ruin", () => {
    const r = rig(); fed(r);
    const marker = stampRuin(r);
    const view = stubView(r);
    fillClaimSensors(r.w, r.p, view, r.a);
    expect(ruinHomeAnchor(r.w, r.p, r.a), "targeted but no flag yet").toBeUndefined();
    plantClaim(r.w, r.p, 6.5, 8.5);
    expect(ruinHomeAnchor(r.w, r.p, r.a), "flag down but not reclaimed").toBeUndefined();
    expect(G.reclaimAbandonedSite(r.w, r.p, marker)).toBe(0);
    tick(r);
    const anchor = ruinHomeAnchor(r.w, r.p, r.a);
    expect(anchor).toBeDefined();
    const w = r.w.getField(marker, G.AbandonedSite, "width") ?? 8, h = r.w.getField(marker, G.AbandonedSite, "height") ?? 8;
    const ox = r.w.getField(marker, G.AbandonedSite, "originX")!, oy = r.w.getField(marker, G.AbandonedSite, "originY")!;
    expect(anchor!.x).toBeCloseTo(ox + w / 2 - 1, 6);
    expect(anchor!.y).toBeCloseTo(oy + h / 2 - 1, 6);
    expect(anchor!.ox).toBe(ox); expect(anchor!.oy).toBe(oy);
    expect(aiMemoryOf(r.a).base, "a ruin home never gets mem.base").toBeUndefined();
  });
  it("a hired bot, and a bot whose ruin was taken, adopt no ruin home", () => {
    const r = rig(); fed(r);
    const marker = stampRuin(r);
    G.ensureWorker(r.w, r.p);
    r.w.setField(r.p, G.Worker, "owner", 7);
    expect(fillClaimSensors(r.w, r.p, stubView(r), r.a)).toBeUndefined();
    expect(ruinHomeAnchor(r.w, r.p, r.a)).toBeUndefined();
    // unhire, adopt, then lose the ruin to another bot
    r.w.setField(r.p, G.Worker, "owner", 0);
    const anchor = adoptRuin(r, marker);
    expect(anchor).toBeDefined();
    r.w.setField(marker, G.AbandonedSite, "claimedBy", 99);
    tick(r);
    expect(ruinHomeAnchor(r.w, r.p, r.a), "ruin taken by another bot").toBeUndefined();
  });
  it("a new-home bot adopts no ruin home", () => {
    const r = rig({ x: 100, y: 100 }); fed(r);
    const view = stubView(r);
    fillClaimSensors(r.w, r.p, view, r.a);
    expect((view as unknown as ClaimView).claimTarget?.kind).toBe("new");
    expect(ruinHomeAnchor(r.w, r.p, r.a)).toBeUndefined();
  });
});

describe("ADR-340 planner: the base goal never fires for a ruin home", () => {
  it("a ruin bot walks the ladder straight past `base` to `bed`", () => {
    const r = rig(); fed(r);
    const marker = stampRuin(r);
    const anchor = adoptRuin(r, marker);
    giveTools(r); stock(r);
    const { seen } = walkTo(r, anchor, "bed");
    expect(seen).not.toContain("base");
    for (const g of ["campfire", "bed"]) expect(seen).toContain(g);
  });
});

describe("ADR-340 planner behaviour goals", () => {
  it("a ruin bot builds its campfire (the hearth) inside the ruin, then moves on to the workbench", () => {
    const r = rig(); fed(r);
    const marker = stampRuin(r);
    const anchor = adoptRuin(r, marker);
    giveTools(r);
    G.addItem(r.w, r.p, iid("wood"), 20); G.addItem(r.w, r.p, iid("stone"), 20);
    const plan = planOf(r, anchor);
    expect(plan.goal).toBe("campfire");
    expect(plan.step?.k).toBe("build");
    if (plan.step?.k !== "build") throw new Error("expected a campfire build step");
    const cx = anchor.x + 1, cy = anchor.y + 1;
    expect(Math.hypot(plan.step.x - cx, plan.step.y - cy)).toBeLessThanOrEqual(RUIN_DATA.furnishRadius); // at the ruin home, not somewhere random
    r.w.set(r.p, Transform, { x: plan.step.stand.x, y: plan.step.stand.y });
    const def = G.gameplayDefs(r.w).pieces.get(plan.step.piece)!;
    expect(G.tryPlace(r.w, r.p, { piece: plan.step.piece, x: plan.step.x, y: plan.step.y, level: plan.step.level, rot: plan.step.rot ?? 0, tier: def.fixedTier, variant: 0 }).ok).toBe(true);
    steps(r.w, 25);
    const next = planOf(r, anchor);
    // the fire is in, and the ruin's own barrel_storage already satisfies the storage-box goal:
    // no `hearth` goal, no `base` goal — the next goal is the workbench
    expect(next.goal).toBe("workbench");
  });
  it("a ruin with a campfire never plans a redundant hearth", () => {
    const r = rig(); fed(r);
    const marker = stampRuin(r);
    const anchor = adoptRuin(r, marker);
    giveTools(r); stock(r);
    const { plan } = walkTo(r, anchor, "workbench");
    expect(plan.goal).toBe("workbench");
    expect(plan.goal).not.toBe("hearth");
    // the campfire the walk built is the ruin's hearth: the scan sees it as the campfire station
    const bs = scanBase(r.w, G.gameplayDefs(r.w), anchor);
    expect(bs.stations.has(G.StationKind.Campfire)).toBe(true);
  });
  it("hearth fallback: when every campfire spot fails, the HEARTH slot is the second chance", () => {
    const r = rig(); fed(r);
    // a bare marker: no pieces at all, so the ruin interior is empty ground. chooseClaim would
    // skip it (intact 0 < minIntact), so the claim target is set directly — this test is about
    // the planner fallback, not ruin selection.
    const m = r.w.create();
    r.w.add(m, Transform, { x: 8.5, y: 8.5, z: 0 });
    r.w.add(m, G.AbandonedSite, { originX: 8, originY: 8, width: 3, height: 3, kind: G.AbandonedKind.Shed, stories: 1, claimed: 0, claimedBy: 0 });
    r.a.bb.set("claimTarget", { kind: "ruin", x: 8, y: 8, marker: m });
    plantClaim(r.w, r.p, 6.5, 8.5);
    expect(G.reclaimAbandonedSite(r.w, r.p, m)).toBe(0);
    tick(r);
    const anchor = ruinHomeAnchor(r.w, r.p, r.a);
    expect(anchor).toBeDefined();
    giveTools(r);
    G.addItem(r.w, r.p, iid("wood"), 20); G.addItem(r.w, r.p, iid("stone"), 20);
    // every campfire station / spare spot has failed: the piece goal is stuck, so the ladder must
    // reach the hearth goal (the goals between them are snoozed to isolate the fallback).
    const fails: Record<string, number> = {};
    for (let i = 0; i < 12; i++) fails[`campfire${i}`] = 4;
    const plan = planOf(r, anchor!, { fails, snooze: { basic_storage_box: 10_000_000, wood: 10_000_000, workbench: 10_000_000, "wear:torch": 10_000_000 } });
    expect(plan.goal).toBe("hearth");
    expect(plan.step?.k).toBe("build");
    if (plan.step?.k !== "build") throw new Error("expected a hearth build step");
    expect(G.gameplayDefs(r.w).pieces.get(plan.step.piece)?.key).toBe("campfire");
    expect(plan.step.x).toBeCloseTo(anchor!.x + G.HEARTH.x, 6);
    expect(plan.step.y).toBeCloseTo(anchor!.y + G.HEARTH.y, 6);
  });
  it("a ruin bot gets the bed goal on a free spare spot, then furnishes", () => {
    const r = rig(); fed(r);
    const marker = stampRuin(r);
    const anchor = adoptRuin(r, marker);
    giveTools(r); stock(r);
    const { plan, seen } = walkTo(r, anchor, "bed");
    expect(plan.goal).toBe("bed");
    expect(seen).not.toContain("base");
    expect(plan.step?.k).toBe("build");
    if (plan.step?.k !== "build") throw new Error("expected a bed build step");
    expect(G.gameplayDefs(r.w).pieces.get(plan.step.piece)?.key).toBe("bed");
    const cx = anchor.x + 1, cy = anchor.y + 1;
    expect(Math.hypot(plan.step.x - cx, plan.step.y - cy)).toBeLessThanOrEqual(RUIN_DATA.furnishRadius + 1);
    r.w.set(r.p, Transform, { x: plan.step.stand.x, y: plan.step.stand.y });
    expect(G.tryPlace(r.w, r.p, { piece: plan.step.piece, x: plan.step.x, y: plan.step.y, level: plan.step.level, rot: plan.step.rot ?? 0, tier: 0, variant: 0 }).ok).toBe(true);
    steps(r.w, 25);
    expect(scanBase(r.w, G.gameplayDefs(r.w), anchor).bed).toBeDefined();
    const next = walkTo(r, anchor, "furnish:table");
    expect(next.seen).not.toContain("base");
    expect(next.plan.goal).toBe("furnish:table");
    expect(next.plan.step?.k).toBe("build");
  });
  it("a standing table satisfies the furnish goal, so the bot moves on to the torch stand", () => {
    const r = rig(); fed(r);
    const marker = stampRuin(r);
    const anchor = adoptRuin(r, marker);
    giveTools(r); stock(r);
    placeAt(r, "table", anchor.x + 1.5, anchor.y + 1.5);
    steps(r.w, 25);
    const { plan, seen } = walkTo(r, anchor, "furnish:torch_stand");
    expect(seen).not.toContain("furnish:table");
    expect(seen).not.toContain("base");
    expect(plan.goal).toBe("furnish:torch_stand");
  });
  it("ruin storage counts toward goals, and bed materials withdraw from the ruin box", () => {
    const r = rig(); fed(r);
    const marker = stampRuin(r);
    const anchor = adoptRuin(r, marker);
    giveTools(r); stock(r);
    // the ruin's own barrel_storage IS the storage box (the storage-box goal is already
    // satisfied); raise the campfire through the plan step, then empty the bot's bag of wood
    const fire = planOf(r, anchor);
    expect(fire.goal).toBe("campfire");
    expect(fire.step?.k).toBe("build");
    if (fire.step?.k !== "build") throw new Error("expected a campfire build step");
    r.w.set(r.p, Transform, { x: fire.step.stand.x, y: fire.step.stand.y });
    const fireDef = G.gameplayDefs(r.w).pieces.get(fire.step.piece)!;
    expect(G.tryPlace(r.w, r.p, { piece: fire.step.piece, x: fire.step.x, y: fire.step.y, level: fire.step.level, rot: fire.step.rot ?? 0, tier: fireDef.fixedTier, variant: 0 }).ok).toBe(true);
    steps(r.w, 25);
    const box = scanBase(r.w, G.gameplayDefs(r.w), anchor).storage;
    expect(box, "ruin storage (barrel) in the scan").toBeDefined();
    const woodId = iid("wood");
    const bagWood = G.countItem(r.w, r.p, woodId);
    if (bagWood > 0) expect(G.dropItem(r.w, r.p, woodId, bagWood)).toBeDefined();
    // negative control: with no wood anywhere, the wood goal fires with wood leaves
    expect(planOf(r, anchor).goal).toBe("wood");
    expect(planOf(r, anchor).leaves).toContain(woodId);
    // wood only in the ruin box: the wood goal is satisfied from storage, so the plan moves on
    G.addItem(r.w, storageOf(r.w, box!.id), woodId, 20);
    steps(r.w, 25);
    expect(scanBase(r.w, G.gameplayDefs(r.w), anchor).storage?.counts.get(woodId)).toBe(20);
    const after = planOf(r, anchor);
    expect(after.goal).not.toBe("wood");
    expect(after.goal).toBe("workbench");
    // bed materials only in the box: the bed goal withdraws them instead of gathering
    G.addItem(r.w, r.p, woodId, 20); // the workbench needs bag wood; the withdraw is tested on the bed below
    const { plan: bedPlan } = walkTo(r, anchor, "bed");
    expect(bedPlan.goal).toBe("bed");
    const planks = iid("planks"), cloth = iid("cloth");
    const bagPlanks = G.countItem(r.w, r.p, planks), bagCloth = G.countItem(r.w, r.p, cloth);
    if (bagPlanks > 0) G.dropItem(r.w, r.p, planks, bagPlanks);
    if (bagCloth > 0) G.dropItem(r.w, r.p, cloth, bagCloth);
    G.addItem(r.w, storageOf(r.w, box!.id), planks, 6);
    G.addItem(r.w, storageOf(r.w, box!.id), cloth, 4);
    steps(r.w, 25);
    const withdraw = planOf(r, anchor);
    expect(withdraw.goal).toBe("bed");
    expect(withdraw.step?.k).toBe("withdraw");
    if (withdraw.step?.k !== "withdraw") throw new Error("expected a withdraw step for bed materials");
    expect(withdraw.step.item).toBe(planks);
    expect(withdraw.step.count).toBe(6);
  });
  it("a ruin bot upgrades its lowest-tier wall to the max tier", () => {
    const r = rig(); fed(r);
    const marker = stampRuin(r);
    const anchor = adoptRuin(r, marker);
    // Isolate the upgrade branch: every earlier ladder goal is snoozed (the full-ladder walk
    // cannot fit every goal's materials in one 24-slot bag), and only the upgrade materials
    // are stocked. The traversal proof lives in the bed / furnish tests above.
    const snooze: Record<string, number> = {};
    for (const g of G.GOAL_LADDER) {
      const name = g.k === "tool" ? g.name : g.k === "item" ? g.key : g.k === "piece" ? g.key : g.k === "wear" ? `wear:${g.key}` : g.k === "furnish" ? `furnish:${g.key}` : g.k;
      if (name !== "upgrade") snooze[name] = 10_000_000;
    }
    for (const k of ["steel_plate", "nails", "clay_brick"] as const) G.addItem(r.w, r.p, iid(k), 20);
    const plan = planOf(r, anchor, { snooze });
    expect(plan.goal).toBe("upgrade");
    expect(plan.step?.k).toBe("upgrade");
    if (plan.step?.k !== "upgrade") throw new Error("expected an upgrade step");
    const maxTier = G.gameplayDefs(r.w).tiers.length - 1;
    expect(plan.step.tier).toBe(maxTier);
    const def = G.gameplayDefs(r.w).pieces.get(r.w.getField(plan.step.piece, G.BuildPiece, "type")!)!;
    expect(def.tiered).toBe(true);
    expect(r.w.getField(plan.step.piece, G.BuildPiece, "tier")).toBeLessThan(maxTier);
    const p = pos(r.w, plan.step.piece);
    expect(Math.hypot(p.x - (anchor.x + 1), p.y - (anchor.y + 1))).toBeLessThanOrEqual(RUIN_DATA.upgradeRadius + 1);
    expect(keyOf(r, plan.step.piece)).toMatch(/^(wall|roof|deck|foundation)/);
  });
});

describe("ADR-340 wiring: buildAgentView + planner + refuel", () => {
  it("an adopted ruin bot plans base behaviour through the real view, with no mem.base and no view.base", () => {
    const r = rig(); fed(r);
    const marker = stampRuin(r);
    const anchor = adoptRuin(r, marker);
    const v = viewOf(r);
    expect(v.claimTarget?.kind).toBe("ruin");
    expect(v.plan).toBeDefined();
    expect(v.plan!.goal).not.toBe("base");
    expect(v.bs).toBeDefined();
    expect(v.base).toBeUndefined();
    expect(aiMemoryOf(r.a).base).toBeUndefined();
    // the ruin scan the view carries is centred on the ruin, not the bot
    expect(v.bs).toBe(scanBase(r.w, G.gameplayDefs(r.w), anchor));
    steps(r.w, 250); // past the site-pick cooldown; the planner must not adopt a competing site
    const v2 = viewOf(r);
    expect(aiMemoryOf(r.a).base).toBeUndefined();
    expect(v2.base).toBeUndefined();
    expect(v2.plan!.goal).not.toBe("base");
    void marker;
  });
  it("a lit low ruin campfire is the Task 30 refuel target", () => {
    const r = rig(); fed(r);
    const marker = stampRuin(r);
    const anchor = adoptRuin(r, marker);
    giveTools(r); stock(r);
    setTimeOfDay(r.w, 0); // night: the fire is needed, so lowFire considers it
    const { plan } = walkTo(r, anchor, "workbench");
    expect(plan.goal).toBe("workbench");
    // the walk already built the campfire: light it with almost no burn left
    const bs = scanBase(r.w, G.gameplayDefs(r.w), anchor);
    const fire = bs.stations.get(G.StationKind.Campfire);
    expect(fire, "ruin campfire station in the scan").toBeDefined();
    const fa = G.attachmentsOf(r.w, fire!.id).find((a) => r.w.has(a, G.Fuel))!;
    expect(fa).toBeDefined();
    r.w.set(fa, G.Fuel, { lit: 1, burnUntilTick: r.w.tick + 100 });
    G.setEmittersLit(r.w, fa, 1);
    steps(r.w, 25);
    const v = viewOf(r);
    expect(v.bs?.stations.get(G.StationKind.Campfire)?.lit).toBe(true);
    expect(v.bs?.fires?.some((f) => f.id === fire!.id && f.lit && f.fuelTicks < G.REFUEL_BELOW_TICKS)).toBe(true);
    const c = { self: { x: r.home.x, y: r.home.y, tick: r.w.tick, stamina: 1, phase: "night" }, world: v, memory: { nearest: () => undefined }, bb: r.a.bb, agent: r.a } as never;
    const low = G.lowFire(c as never);
    expect(low?.id).toBe(fire!.id);
    void marker;
  });
  it("the new-build mem.base handoff is unchanged", () => {
    const r = rig({ x: 100, y: 100 }); fed(r); stock(r);
    const view = stubView(r);
    fillClaimSensors(r.w, r.p, view, r.a);
    const t0 = (view as unknown as ClaimView).claimTarget!;
    expect(t0.kind).toBe("new");
    expect(aiMemoryOf(r.a).base).toBeUndefined();
    expect(ruinHomeAnchor(r.w, r.p, r.a)).toBeUndefined();
    plantClaim(r.w, r.p, t0.x - 1.5, t0.y + 0.5);
    fillClaimSensors(r.w, r.p, view, r.a);
    const base = aiMemoryOf(r.a).base;
    expect(base).toBeDefined();
    expect(Math.hypot(base!.x - t0.x, base!.y - t0.y)).toBeLessThan(1);
    expect(ruinHomeAnchor(r.w, r.p, r.a)).toBeUndefined();
  });
});

describe("ADR-340 data", () => {
  it("ai_ruin.json knobs load with sane radii", () => {
    expect(RUIN_DATA.furnishRadius).toBeGreaterThan(0);
    expect(RUIN_DATA.upgradeRadius).toBeGreaterThan(0);
    expect(RUIN_DATA.furnishRadius).toBeLessThanOrEqual(12);
    expect(RUIN_DATA.upgradeRadius).toBeLessThanOrEqual(12);
  });
});
