import { describe, expect, it } from "vitest";
import { installPermissions, Membership, PlayerId, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { collect, makeWorld, steps } from "./helpers.js";

const pid = (w: World, e: Entity, id: number): void => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); };
const mkPlayer = (w: World, x: number, y: number, id: number): Entity => { const e = G.spawnPlayer(w, { x, y, maxWeight: 0, clientId: id }); pid(w, e, id); if (w.isRegistered(Membership)) w.add(e, Membership, { partyId: 0, clanId: 0 }); return e; };
const setup = (): { w: World; p: Entity; q: Entity; bot: Entity; id: (k: string) => number } => {
  const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId); installPermissions(w);
  const p = mkPlayer(w, 0, 0, 7); const q = mkPlayer(w, 1, 1, 8); const bot = mkPlayer(w, 2, 0, 9);
  G.setAiHumanPredicate(w, (e) => e === bot);
  G.ensureWorker(w, bot);
  const d = G.gameplayDefs(w); return { w, p, q, bot, id: (k) => d.itemId(k) };
};
/** Give `e` the wanted item for `bot` (n units). */
const giveWanted = (w: World, e: Entity, bot: Entity, n = 1): number => {
  const item = w.get(bot, G.Worker)!.wantedItem; G.addItem(w, e, item, n); return item;
};
const agentView = (w: World, bot: Entity, home = { x: 0, y: 0 }) => {
  const agent = G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1);
  return G.buildAgentView(w, bot, agent, home)!;
};

describe("Task 22: AI-human recruitment", () => {
  it("wanted-item pool: every key resolves in the item catalog", () => {
    const d = G.gameplayDefs(makeWorld());
    for (const k of G.WANTED_ITEM_KEYS) expect(() => d.itemId(k), k).not.toThrow();
    expect(G.WANTED_ITEM_KEYS.length).toBeGreaterThan(10);
  });
  it("wanted item is deterministic per AI and stable across ticks", () => {
    const { w, bot } = setup();
    const first = G.wantedItemFor(w, bot);
    expect(first).toBeGreaterThan(0);
    expect(G.wantedItemFor(w, bot)).toBe(first);
    expect(w.get(bot, G.Worker)!.wantedItem).toBe(first);
    steps(w, 40);
    expect(w.get(bot, G.Worker)!.wantedItem).toBe(first);
    expect(G.wantedItemFor(w, bot)).toBe(first);
  });
  it("hire succeeds and consumes exactly the wanted item; worker starts on Gather, tribe shared", () => {
    const { w, p, bot } = setup();
    const item = giveWanted(w, p, bot, 3);
    const ev = collect(w, G.WorkerEvent);
    expect(G.hireWorker(w, p, bot)).toBe(G.WorkerFail.None);
    steps(w, 1); // gameplay events deliver at end of tick
    expect(G.countItem(w, p, item)).toBe(2);
    const wk = w.get(bot, G.Worker)!; expect(wk.owner).toBe(7); expect(wk.job).toBe(G.WorkerJob.Gather);
    expect(ev.some((e) => e.result === G.WorkerResult.Hired && e.value === item)).toBe(true);
  });
  it("hire with a tribe shares the owner's tribe so the worker can use the claim", () => {
    const { w, p, bot } = setup();
    w.add(p, G.Tribe, { id: 5 });
    giveWanted(w, p, bot, 1);
    expect(G.hireWorker(w, p, bot)).toBe(G.WorkerFail.None);
    expect(w.getField(bot, G.Tribe, "id")).toBe(5);
  });
  it("hire fails cleanly without the item: no hire, no consumption", () => {
    const { w, p, bot } = setup();
    const item = w.get(bot, G.Worker)!.wantedItem;
    expect(G.countItem(w, p, item)).toBe(0);
    expect(G.hireWorkerValidate(w, p, bot)).toBe(G.WorkerFail.NoItem);
    expect(G.hireWorker(w, p, bot)).toBe(G.WorkerFail.NoItem);
    expect(w.get(bot, G.Worker)!.owner).toBe(0);
    expect(G.countItem(w, p, item)).toBe(0);
  });
  it("hire cannot double-succeed: the second player is rejected and keeps their item", () => {
    const { w, p, q, bot } = setup();
    const item = giveWanted(w, p, bot, 1); giveWanted(w, q, bot, 1);
    expect(G.hireWorker(w, p, bot)).toBe(G.WorkerFail.None);
    expect(G.hireWorker(w, q, bot)).toBe(G.WorkerFail.AlreadyHired);
    expect(G.countItem(w, p, item)).toBe(0);
    expect(G.countItem(w, q, item)).toBe(1); // the loser keeps the payment
    expect(w.get(bot, G.Worker)!.owner).toBe(7);
  });
  it("job assignment changes the AI's behavior target (Defend finds a zombie at the anchor)", () => {
    const { w, p, bot } = setup();
    giveWanted(w, p, bot, 1); expect(G.hireWorker(w, p, bot)).toBe(G.WorkerFail.None);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Defend)).toBe(G.WorkerFail.None);
    const z = G.spawnZombie(w, "zombie_walker", 3, 0); // within 12 of the hire spot (0, 0)
    const v = agentView(w, bot);
    expect(v.world.hire?.job).toBe(G.WorkerJob.Defend);
    expect(v.world.defend?.id).toBe(z);
    // the owner can change the job; the sensors follow
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Farm)).toBe(G.WorkerFail.None);
    expect(w.get(bot, G.Worker)!.job).toBe(G.WorkerJob.Farm);
    expect(agentView(w, bot).world.hire?.job).toBe(G.WorkerJob.Farm);
  });
  it("job assignment is owner-only", () => {
    const { w, p, q, bot } = setup();
    giveWanted(w, p, bot, 1); expect(G.hireWorker(w, p, bot)).toBe(G.WorkerFail.None);
    expect(G.setWorkerJob(w, q, bot, G.WorkerJob.Farm)).toBe(G.WorkerFail.NotOwner);
    expect(w.get(bot, G.Worker)!.job).toBe(G.WorkerJob.Gather);
  });
  it("farm job finds a thirsty crop and a watering can to tend it with", () => {
    const { w, p, bot, id } = setup();
    giveWanted(w, p, bot, 1); expect(G.hireWorker(w, p, bot)).toBe(G.WorkerFail.None);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Farm)).toBe(G.WorkerFail.None);
    const crop = G.spawnCrop(w, 3, 0, G.plantableBySeed("wheat_seeds"));
    w.set(crop, G.Crop, { kind: G.plantableBySeed("wheat_seeds"), stage: 0, growth: 0.5, waterUntilTick: 0, fertilized: 0 });
    G.addItem(w, bot, id("watering_can"), 1);
    const v = agentView(w, bot);
    expect(v.world.hire?.job).toBe(G.WorkerJob.Farm);
    expect(v.world.farm?.tend?.kind).toBe("water");
    expect(v.world.farm?.tend?.id).toBe(crop);
  });
  it("farm job finds a mature crop node to harvest", () => {
    const { w, p, bot } = setup();
    giveWanted(w, p, bot, 1); expect(G.hireWorker(w, p, bot)).toBe(G.WorkerFail.None);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Farm)).toBe(G.WorkerFail.None);
    const node = G.spawnResourceNode(w, "crop_wheat", 4, 0);
    const v = agentView(w, bot);
    expect(v.world.farm?.harvest?.id).toBe(node);
  });
  it("maintain job finds a damaged piece when the bot carries the repair materials", () => {
    const { w, p, bot } = setup();
    giveWanted(w, p, bot, 1); expect(G.hireWorker(w, p, bot)).toBe(G.WorkerFail.None);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Maintain)).toBe(G.WorkerFail.None);
    const defs = G.gameplayDefs(w); const wall = defs.pieceId("wall");
    const piece = w.create();
    w.add(piece, Transform, { x: 3, y: 0 }).add(piece, G.BuildPiece, { type: wall, rot: 0, variant: 0, tier: 0, hp: 1, damageStage: 0, paint: 0, tint: 0 });
    G.indexEntity(w, piece);
    const def = defs.pieces.get(wall)!; const missing = 1 - 1 / G.maxHpOf(w, piece);
    for (const c of G.pieceCost(defs, def, 0, (defs.tiers[0]?.repairMul ?? 0.3) * missing)) G.addItem(w, bot, c.item, c.count + 2);
    const v = agentView(w, bot);
    expect(v.world.hire?.job).toBe(G.WorkerJob.Maintain);
    expect(v.world.repair?.id).toBe(piece);
    expect(v.world.repair?.lack).toBeUndefined();
  });
  it("a hired bot's sensors re-anchor it on the hire spot and drop its own base plan", () => {
    const { w, p, bot } = setup();
    giveWanted(w, p, bot, 1); expect(G.hireWorker(w, p, bot)).toBe(G.WorkerFail.None);
    const v = agentView(w, bot);
    expect(v.world.hire).toEqual({ job: G.WorkerJob.Gather, owner: 7, ax: 0, ay: 0, idle: true }); // ADR-327: idle (no job work, needs met) — the saddle chain may run
    expect(v.world.home).toEqual({ x: 0, y: 0 });
    expect(v.world.plan).toBeUndefined();
    expect(v.world.tripWanted).toBeUndefined();
  });
  it("dismiss releases the worker, keeps the wanted item, and clears the hire tribe", () => {
    const { w, p, bot } = setup();
    w.add(p, G.Tribe, { id: 5 });
    const item = giveWanted(w, p, bot, 1);
    expect(G.hireWorker(w, p, bot)).toBe(G.WorkerFail.None);
    expect(G.dismissWorker(w, p, bot)).toBe(G.WorkerFail.None);
    const wk = w.get(bot, G.Worker)!; expect(wk.owner).toBe(0); expect(wk.job).toBe(G.WorkerJob.None); expect(wk.wantedItem).toBe(item);
    expect(w.has(bot, G.Tribe)).toBe(false);
  });
  it("multiplayer toggle off blocks hiring (and on allows it)", () => {
    const { w, p, bot } = setup();
    giveWanted(w, p, bot, 1);
    G.setWorldRules(w, { aiHumans: false });
    expect(G.worldRules(w).aiHumans).toBe(false);
    expect(G.hireWorker(w, p, bot)).toBe(G.WorkerFail.AiHumansOff);
    expect(w.get(bot, G.Worker)!.owner).toBe(0);
    expect(G.countItem(w, p, w.get(bot, G.Worker)!.wantedItem)).toBe(1);
    G.setWorldRules(w, { aiHumans: true });
    expect(G.hireWorker(w, p, bot)).toBe(G.WorkerFail.None);
  });
  it("recruitment system backfills Worker onto AI humans only", () => {
    const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId); installPermissions(w);
    const human = mkPlayer(w, 0, 0, 7);
    const bot = mkPlayer(w, 2, 0, 9);
    G.setAiHumanPredicate(w, (e) => e === bot);
    expect(w.has(bot, G.Worker)).toBe(false);
    steps(w, 25); // recruitment system runs every 20 ticks
    expect(w.has(bot, G.Worker)).toBe(true);
    expect(w.has(human, G.Worker)).toBe(false);
  });
  it("Worker is declared networked + persistent, so hired state rides the player save path", () => {
    // The byte round-trip itself lives in apps/server/test/task22_recruitment.test.ts
    // (that package declares @engine/persist; gameplay must not depend on persist —
    // persist itself depends on gameplay, so the dep would be a cycle). What gameplay
    // owns is the declaration: the player codec saves every component store on the
    // entity, keyed by name, so a networked + persistent Worker is what makes a hired
    // worker (owner, job, wanted item) survive save/load.
    expect(G.Worker.networked).toBe(true);
    expect(G.Worker.persistent).toBe(true);
    const { w, p, bot } = setup();
    giveWanted(w, p, bot, 1); expect(G.hireWorker(w, p, bot)).toBe(G.WorkerFail.None);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Defend)).toBe(G.WorkerFail.None);
    const wk = w.get(bot, G.Worker)!;
    expect(wk.owner).toBe(7); expect(wk.job).toBe(G.WorkerJob.Defend); expect(wk.wantedItem).toBeGreaterThan(0);
  });
  it("interactPanel offers the worker panel for the nearest AI human", () => {
    const { w, p, bot } = setup();
    const c = { world: w, player: p, names: new Map() };
    expect(G.interactPanel(c)).toEqual({ panel: "worker", worker: bot });
  });
  it("workerView shows the wanted item and whether the player has it", () => {
    const { w, p, bot } = setup();
    const v0 = G.workerView(w, p, bot)!;
    expect(v0.hired).toBe(false); expect(v0.hasWanted).toBe(false); expect(v0.wantedItem).toBeGreaterThan(0); expect(v0.wantedName.length).toBeGreaterThan(0);
    giveWanted(w, p, bot, 2);
    const v1 = G.workerView(w, p, bot)!;
    expect(v1.hasWanted).toBe(true); expect(v1.hasCount).toBe(2);
  });
});
