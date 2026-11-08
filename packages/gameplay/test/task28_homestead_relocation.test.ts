/**
 * Task 28: bot homesteading (furnish + upgrade goals, garden sensor, livestock taming) and hire relocation
 * (old base demolished, rebuilt near the player's home, stored resources moved, hire never lost on failure).
 */
import { describe, expect, it } from "vitest";
import { Blackboard, Rng, scoreBehavior, installPermissions, Membership, PlayerId, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { collect, makeWorld, spawnLearned, steps, ensureClaim } from "./helpers.js";

const d = G.defaultDefs();
const pid = (k: string) => d.pieceId(k);
const iid = (k: string) => d.itemId(k);
const BASE = { x: 10, y: 10 };
const STAND = { x: BASE.x + G.BUILD_STAND.x, y: BASE.y + G.BUILD_STAND.y };
function fresh(): { w: World; p: Entity } {
  const w = makeWorld(); const p = spawnLearned(w, { x: BASE.x + 1, y: BASE.y + 3.3, maxWeight: 0, clientId: 1 }); steps(w, 1); ensureClaim(w, p, BASE.x + 4, BASE.y + 4); return { w, p };
}
const give = (w: World, e: Entity, key: string, tier = 0): void => { const def = d.pieces.get(pid(key))!; for (const c of G.pieceCost(d, def, def.tiered ? tier : def.fixedTier)) G.addItem(w, e, c.item, c.count); };
const put = (w: World, e: Entity, key: string, x: number, y: number, level = 0, rot = 0, tier?: number, stand?: { x: number; y: number }) => {
  const def = d.pieces.get(pid(key))!; const t = tier ?? (def.tiered ? 0 : def.fixedTier); give(w, e, key, t);
  w.set(e, Transform, stand ?? { x, y: y + 1.2 });
  return G.tryPlace(w, e, { piece: pid(key), x, y, level, rot, tier: t, variant: 0 });
};
const plan = (w: World, p: Entity, extra: Partial<G.PlanInput> = {}) => { const bs = G.scanBase(w, d, BASE); return G.makePlan({ world: w, self: p, defs: d, base: BASE, bs, fails: {}, ...extra }); };
const tools = (w: World, p: Entity) => { G.addItem(w, p, iid("stone_axe"), 1); G.addItem(w, p, iid("stone_pickaxe"), 1); };
/** Snooze every ladder goal except `keep` (same naming as the planner's goalName). */
const snoozeAllBut = (keep: string): Record<string, number> => {
  const s: Record<string, number> = {};
  for (const g of G.GOAL_LADDER) {
    const n = g.k === "tool" ? g.name : g.k === "item" ? g.key : g.k === "piece" ? g.key : g.k === "wear" ? `wear:${g.key}` : g.k === "furnish" ? `furnish:${g.key}` : g.k;
    if (n !== keep) s[n] = 1e9;
  }
  return s;
};
/** A complete hut (all BASE_SLOTS) + hearth campfire + bed, like the ADR-252 bed test. */
const completeHut = (w: World, p: Entity): void => {
  tools(w, p);
  for (const sl of G.BASE_SLOTS) expect(put(w, p, sl.key, BASE.x + sl.x, BASE.y + sl.y, sl.level, sl.rot ?? 0, sl.tier ?? 0, STAND).ok, sl.id).toBe(true);
  expect(put(w, p, "campfire", BASE.x + G.HEARTH.x, BASE.y + G.HEARTH.y, 0, 0, undefined, { x: BASE.x + G.DOOR_IN.x, y: BASE.y + G.DOOR_IN.y }).ok).toBe(true);
  steps(w, 25); expect(G.scanBase(w, d, BASE).complete).toBe(true);
  give(w, p, "bed");
  expect(G.tryPlace(w, p, { piece: pid("bed"), x: BASE.x + G.BED_SLOT.x, y: BASE.y + G.BED_SLOT.y, level: 0, rot: 0, tier: d.pieces.get(pid("bed"))!.fixedTier, variant: 0 }).ok).toBe(true);
  steps(w, 25); expect(G.scanBase(w, d, BASE).bed).toBeDefined();
};

describe("Task 28: bot homesteading — furnish + upgrade goals", () => {
  it("the ladder furnishes the home after the bed and upgrades to the max tier last", () => {
    const furnish = G.GOAL_LADDER.findIndex((g) => g.k === "furnish" && g.key === "table");
    const bed = G.GOAL_LADDER.findIndex((g) => g.k === "bed");
    const upgrade = G.GOAL_LADDER.findIndex((g) => g.k === "upgrade");
    expect(furnish).toBeGreaterThan(bed); expect(upgrade).toBe(G.GOAL_LADDER.length - 1);
    expect(G.GOAL_LADDER.filter((g) => g.k === "furnish").map((g) => (g as { key: string }).key))
      .toEqual(["table", "torch_stand", "shelf_rustic", "feeding_trough", "salt_barrel"]);
    for (const k of ["table", "torch_stand", "shelf_rustic", "feeding_trough", "salt_barrel"]) expect(G.STATION_SLOTS[k]?.length).toBeGreaterThan(0);
  });
  it("the furnish goal builds the table inside the hut (SE tile), then moves on once it stands", () => {
    const { w, p } = fresh(); completeHut(w, p); give(w, p, "table");
    const s = plan(w, p, { snooze: snoozeAllBut("furnish:table") });
    expect(s.goal).toBe("furnish:table");
    expect(s.step).toMatchObject({ k: "build", piece: pid("table"), x: BASE.x + 1.5, y: BASE.y + 1.5 });
    // once the table stands, the next furnish goal is the torch stand by the door
    w.set(p, Transform, { x: BASE.x + 1.5, y: BASE.y + 2.7 });
    expect(G.tryPlace(w, p, { piece: pid("table"), x: BASE.x + 1.5, y: BASE.y + 1.5, level: 0, rot: 0, tier: d.pieces.get(pid("table"))!.fixedTier, variant: 0 }).ok).toBe(true);
    steps(w, 25); give(w, p, "torch_stand");
    const s2 = plan(w, p, { snooze: snoozeAllBut("furnish:torch_stand") });
    expect(s2.goal).toBe("furnish:torch_stand"); expect(s2.step).toMatchObject({ k: "build", piece: pid("torch_stand") });
  });
  it("the upgrade goal picks the lowest-tier hut piece and sends it straight to the max tier", () => {
    const { w, p } = fresh(); completeHut(w, p);
    give(w, p, "foundation", d.tiers.length - 1); give(w, p, "wall", d.tiers.length - 1);
    const s = plan(w, p, { snooze: snoozeAllBut("upgrade") });
    expect(s.goal).toBe("upgrade");
    expect(s.step?.k).toBe("upgrade");
    if (s.step?.k === "upgrade") {
      expect(s.step.tier).toBe(d.tiers.length - 1); // reinforced, the max tier
      const type = w.getField(s.step.piece, G.BuildPiece, "type")!;
      expect(["foundation", "wall", "wall_window", "doorway", "door"]).toContain(d.pieces.get(type)!.key);
      expect(w.getField(s.step.piece, G.BuildPiece, "tier")).toBe(0);
    }
  });
  it("the upgrade: bot action maps to the same Upgrade command a player sends", () => {
    expect(G.actionCommand("upgrade:12:4")).toEqual({ type: G.UpgradeCmd.name, payload: { target: 12, tier: 4 } });
    expect(G.actionCommand("upgrade:x:4")).toBeUndefined();
    expect(G.actionCommand("upgrade:12:-1")).toBeUndefined();
  });
});

describe("Task 28: bot homesteading — garden + livestock sensors", () => {
  it("an unhired bot gardens: empty tilled soil + seeds -> plant; seeds + hoe and no soil -> till", () => {
    const { w, p } = fresh();
    G.addItem(w, p, iid("wheat_seeds"), 5); G.addItem(w, p, iid("hoe"), 1);
    // a tilled, unplanted crop near the base
    const crop = w.create();
    w.add(crop, Transform, { x: BASE.x + 3, y: BASE.y }).add(crop, G.Crop, { kind: 0, stage: 0, growth: 0, waterUntilTick: 0, fertilized: 0 });
    G.indexEntity(w, crop);
    const f1 = G.computeFarmSensor(w, p, d, BASE, G.scanBase(w, d, BASE));
    expect(f1?.tend?.kind).toBe("plant"); expect(f1?.tend?.slot).toBeGreaterThanOrEqual(0);
    w.destroy(crop); steps(w, 1);
    const f2 = G.computeFarmSensor(w, p, d, BASE, G.scanBase(w, d, BASE));
    expect(f2?.till).toBeDefined(); expect(f2?.till?.slot).toBeGreaterThanOrEqual(0);
    expect(Math.hypot(f2!.till!.x - BASE.x, f2!.till!.y - BASE.y)).toBeLessThanOrEqual(12);
  });
  it("an unhired bot with animal_feed targets a nearby cow to tame for food", () => {
    const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId); installPermissions(w);
    const bot = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); steps(w, 1);
    G.addItem(w, bot, iid("animal_feed"), 3);
    const cow = G.spawnAnimal(w, "animal_cow", 3, 0);
    const agent = G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1);
    const v = G.buildAgentView(w, bot, agent, { x: 0, y: 0 })!;
    expect(v.world.tameLivestock?.id).toBe(cow);
    expect(v.world.tameLivestock?.slot).toBeGreaterThanOrEqual(0);
  });
  it("garden never outranks ladder work: it scores 0 with a plan step or a wanted trip, and scores when idle", () => {
    // Regression: an ungated garden starved the home build — a wild berry bush near the base is a permanent
    // harvest target, so the bot harvested instead of gathering foundation materials or building (ADR-252 live).
    const garden = G.hireBehaviors().find((b) => b.name === "garden")!;
    const mkCtx = (world: Partial<G.AgentWorldView>) => {
      const id = G.makeAgentIdentity(7, 0, "bot_gatherer"); const agent = G.makeAgent(id, 1);
      return { self: { x: 0, y: 0, facing: 0, hp: 1, hunger: 1, thirst: 1, stamina: 1, tick: 0, dayT: 0.5, phase: "day" as const }, bb: new Blackboard(), memory: agent.memory, traits: id.traits, rng: new Rng(1), agent, world: { seen: [], home: { x: 0, y: 0 }, playerName: "p", ...world } };
    };
    const farm = { harvest: { id: 1, x: 0, y: 0 } };
    const step = { k: "build", piece: 1, x: 0, y: 0, level: 0, slot: "", stand: { x: 0, y: 0 } };
    const plan = { goal: "base", step, leaves: [], hunt: [], keep: new Set(), blocked: [] };
    expect(scoreBehavior(garden, mkCtx({ farm, plan: plan as unknown as G.Plan }), undefined, [])).toBe(0); // building
    expect(scoreBehavior(garden, mkCtx({ farm, tripWanted: true }), undefined, [])).toBe(0); // gathering trip
    expect(scoreBehavior(garden, mkCtx({ farm, hire: { job: 2, owner: 7, ax: 0, ay: 0 } }), undefined, [])).toBe(0); // hired: work_farm instead
    expect(scoreBehavior(garden, mkCtx({ farm }), undefined, [])).toBeGreaterThan(0); // idle: garden fills the gap
  });
});

// ---- hire relocation ----------------------------------------------------------------------------------
const pidOf = (w: World, e: Entity, id: number): void => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); };
const mkPlayer = (w: World, x: number, y: number, id: number): Entity => { const e = G.spawnPlayer(w, { x, y, maxWeight: 0, clientId: id }); pidOf(w, e, id); if (w.isRegistered(Membership)) w.add(e, Membership, { partyId: 0, clanId: 0 }); return e; };
const setupReloc = (): { w: World; p: Entity; bot: Entity } => {
  const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId); installPermissions(w);
  const p = mkPlayer(w, 10, 10, 7); const bot = mkPlayer(w, 12, 10, 9);
  G.setAiHumanPredicate(w, (e) => e === bot); G.ensureWorker(w, bot);
  return { w, p, bot };
};
const giveWanted = (w: World, e: Entity, bot: Entity, n = 1): number => { const item = w.get(bot, G.Worker)!.wantedItem; G.addItem(w, e, item, n); return item; };
const storageOf = (w: World, piece: Entity): Entity => G.resolveAttachment(w, piece, G.AttachKind.Storage)!;
const botPieces = (w: World, bot: Entity): Entity[] => { const pid = w.getField(bot, PlayerId, "id") ?? 0; return [...w.query([G.BuildPiece, G.PieceOwner])].filter((e) => w.getField(e, G.PieceOwner, "player") === pid); };
/** The bot's own base: a storage box (with food + stone inside) and a salt barrel (with salt inside). */
const botBase = (w: World, bot: Entity): { box: Entity; barrel: Entity } => {
  const place = (key: string, x: number, y: number): Entity => {
    const def = d.pieces.get(pid(key))!;
    const sn = G.snapPlacement(w, { piece: def.id, x, y, level: 0, rot: 0, tier: def.fixedTier, variant: 0 });
    if (typeof sn === "number") throw new Error(`${key} snap ${sn}`);
    return G.placePiece(w, bot, sn, { pay: false });
  };
  const box = place("basic_storage_box", 13.5, 10.5);
  const barrel = place("salt_barrel", 14.5, 10.5);
  G.addItem(w, storageOf(w, box), iid("wood"), 5); G.addItem(w, storageOf(w, box), iid("stone"), 3);
  G.addItem(w, storageOf(w, barrel), iid("salt"), 4);
  return { box, barrel };
};
const pieceAt = (w: World, x: number, y: number): Entity | undefined =>
  [...w.query([G.BuildPiece, Transform])].find((e) => { const t = w.get(e, Transform)!; return Math.hypot(t.x - x, t.y - y) < 0.6; });

describe("Task 28: hire relocation", () => {
  it("a hired bot's base is demolished and rebuilt near the player's home with everything moved", () => {
    const { w, p, bot } = setupReloc();
    const { box, barrel } = botBase(w, bot);
    const item = giveWanted(w, p, bot, 1);
    const ev = collect(w, G.WorkerEvent);
    expect(G.hireWorker(w, p, bot)).toBe(G.WorkerFail.None);
    steps(w, 1);
    expect(G.countItem(w, p, item)).toBe(0); // the payment is taken exactly once
    expect(ev.some((e) => e.result === G.WorkerResult.Hired)).toBe(true);
    expect(ev.some((e) => e.result === G.WorkerResult.Relocated)).toBe(true);
    // the old base is gone
    expect(pieceAt(w, 13.5, 10.5)).toBeUndefined();
    expect(pieceAt(w, 14.5, 10.5)).toBeUndefined();
    // the same two pieces stand near the player's home (5-9 tile site + layout offsets)
    const owned = botPieces(w, bot);
    expect(owned.length).toBe(2);
    for (const e of owned) { const t = w.get(e, Transform)!; expect(Math.hypot(t.x - 10, t.y - 10)).toBeLessThanOrEqual(12); expect(Math.hypot(t.x - 13.5, t.y - 10.5)).toBeGreaterThan(1); }
    // everything stored moved with it — including the full salvage of both pieces (no 50% demolish loss)
    const newBox = owned.find((e) => d.pieces.get(w.getField(e, G.BuildPiece, "type")!)!.key === "basic_storage_box")!;
    const newBarrel = owned.find((e) => d.pieces.get(w.getField(e, G.BuildPiece, "type")!)!.key === "salt_barrel")!;
    expect(G.countItem(w, storageOf(w, newBox), iid("wood"))).toBe(5);
    expect(G.countItem(w, storageOf(w, newBox), iid("stone"))).toBe(3);
    expect(G.countItem(w, storageOf(w, newBarrel), iid("salt"))).toBe(4);
    // the demolished home's salvage (100%, not the 50% demolish refund) is back in the bot's pack
    expect(G.countItem(w, bot, iid("sticks"))).toBe(10);
    expect(G.countItem(w, bot, iid("fiber"))).toBe(6);
    expect(G.countItem(w, bot, iid("wood"))).toBe(2);
    expect(G.countItem(w, bot, iid("planks"))).toBe(6);
    expect(G.countItem(w, bot, iid("rope"))).toBe(1);
    expect(G.countItem(w, bot, iid("salt"))).toBe(2);
    // the bot's planner now anchors on the new home (BotHome == the rebuilt box position)
    const home = w.get(bot, G.BotHome)!; expect(home).toBeDefined();
    const bt = w.get(newBox, Transform)!; expect(home.x).toBeCloseTo(bt.x, 0); expect(home.y).toBeCloseTo(bt.y, 0);
    void box; void barrel;
  });
  it("a bot with no base hires normally (no relocation, no BotHome)", () => {
    const { w, p, bot } = setupReloc();
    giveWanted(w, p, bot, 1);
    const ev = collect(w, G.WorkerEvent);
    expect(G.hireWorker(w, p, bot)).toBe(G.WorkerFail.None);
    steps(w, 1);
    expect(ev.some((e) => e.result === G.WorkerResult.Relocated)).toBe(false);
    expect(w.has(bot, G.BotHome)).toBe(false);
  });
  it("a failed relocation never loses the hire, the payment, or the old base", () => {
    const { w, p, bot } = setupReloc();
    // ring the player's home with the owner's own boxes so no 5-9 tile site is clear of pieces
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2, rx = 10 + Math.cos(a) * 7, ry = 10 + Math.sin(a) * 7;
      const def = d.pieces.get(pid("basic_storage_box"))!;
      for (const c of G.pieceCost(d, def, def.fixedTier)) G.addItem(w, p, c.item, c.count);
      w.set(p, Transform, { x: rx, y: ry + 1.2 });
      const sn = G.snapPlacement(w, { piece: def.id, x: rx, y: ry, level: 0, rot: 0, tier: def.fixedTier, variant: 0 });
      if (typeof sn === "number") throw new Error(`ring ${i} snap ${sn}`);
      G.placePiece(w, p, sn, { pay: false });
    }
    w.set(p, Transform, { x: 10, y: 10 });
    const { box, barrel } = botBase(w, bot);
    const item = giveWanted(w, p, bot, 1);
    const ev = collect(w, G.WorkerEvent);
    expect(G.hireWorker(w, p, bot)).toBe(G.WorkerFail.None);
    steps(w, 1);
    expect(G.countItem(w, p, item)).toBe(0); // paid once, hire stands
    expect(w.get(bot, G.Worker)!.owner).toBe(7);
    expect(ev.some((e) => e.result === G.WorkerResult.Relocated)).toBe(false);
    expect(w.has(bot, G.BotHome)).toBe(false);
    // the old base is intact, contents and all
    expect(pieceAt(w, 13.5, 10.5)).toBe(box);
    expect(pieceAt(w, 14.5, 10.5)).toBe(barrel);
    expect(G.countItem(w, storageOf(w, box), iid("wood"))).toBe(5);
    expect(G.countItem(w, storageOf(w, barrel), iid("salt"))).toBe(4);
  });
  it("a bot's planner follows BotHome (its relocated home) instead of re-picking the old site", () => {
    const { w, bot } = setupReloc();
    if (w.has(bot, G.BotHome)) w.set(bot, G.BotHome, { x: 20, y: 20 }); else w.add(bot, G.BotHome, { x: 20, y: 20 });
    const agent = G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1);
    const v = G.buildAgentView(w, bot, agent, { x: 0, y: 0 })!;
    expect(v.world.base?.x).toBeCloseTo(20, 0); expect(v.world.base?.y).toBeCloseTo(20, 0);
  });
});
