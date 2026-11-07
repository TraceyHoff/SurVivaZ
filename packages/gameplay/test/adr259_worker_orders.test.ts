import { describe, expect, it } from "vitest";
import { idleOutput, installPermissions, scoreBehavior, PlayerId, setTimeOfDay, Transform, type AgentContext } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

function setup() {
  const w = makeWorld(); installPermissions(w);
  const mk = (id: number, x: number) => { const e = G.spawnPlayer(w, { x, y: 0, maxWeight: 0 }); w.add(e, PlayerId, { id }); return e; };
  const p = mk(7, 0), q = mk(8, 3), bot = mk(9, 1);
  G.setAiHumanPredicate(w, (e) => e === bot); G.ensureWorker(w, bot);
  G.addItem(w, p, w.get(bot, G.Worker)!.wantedItem, 1); expect(G.hireWorker(w, p, bot)).toBe(0);
  const agent = G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1);
  const view = () => G.buildAgentView(w, bot, agent, { x: 0, y: 0 })!;
  const ctx = (): AgentContext<G.AgentWorldView> => ({ ...view(), bb: agent.bb, memory: agent.memory, traits: agent.identity.traits, rng: agent.rng, agent });
  return { w, p, q, bot, agent, view, ctx, defs: G.gameplayDefs(w) };
}

describe("ADR-259 detailed hired-human orders", () => {
  it("validates ownership, AI-off, bounded selections, recipe skills, and typed living targets without changing the job", () => {
    const { w, p, q, bot, defs } = setup();
    expect(G.setWorkerJob(w, q, bot, G.WorkerJob.Follow)).toBe(G.WorkerFail.NotOwner);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Gather, { selections: [65535] })).toBe(G.WorkerFail.BadDetails);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Gather, { selections: Array(17).fill(defs.itemId("wood")) })).toBe(G.WorkerFail.BadDetails);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Defend, { kind: 1, x: NaN })).toBe(G.WorkerFail.BadDetails);
    const zombie = G.spawnZombie(w, "zombie_walker", 2, 1);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Defend, { kind: 2, target: zombie })).toBe(G.WorkerFail.BadDetails);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Farm, { kind: 2, target: q })).toBe(G.WorkerFail.BadDetails);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Maintain, { kind: 2, target: q })).toBe(G.WorkerFail.BadDetails);
    G.setWorldRules(w, { aiHumans: false });
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Follow)).toBe(G.WorkerFail.AiHumansOff);
    expect(w.getField(bot, G.Worker, "job")).toBe(G.WorkerJob.Gather);
  });
  it("selected gather resources beat closer unrelated nodes; empty picks retain gather-any", () => {
    const { w, p, bot, defs, view } = setup();
    G.spawnResourceNode(w, "berry_bush", 1.5, 0);
    const rocks = G.spawnResourceNode(w, "loose_rocks", 5, 0);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Gather, { selections: [defs.itemId("stone")] })).toBe(0);
    expect(view().world.gatherNode?.id).toBe(rocks);
    expect(G.workerView(w, p, bot)!.assignment).toContain("Stone");
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Gather)).toBe(0);
    expect(view().world.gatherNode).toBeDefined();
  });
  it("Guard uses the chosen point or a moving player's live position, without moving storage home", () => {
    const { w, p, q, bot, view } = setup();
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Defend, { kind: 1, x: 30, y: 0 })).toBe(0);
    const z = G.spawnZombie(w, "zombie_walker", 32, 0);
    expect(view().world.hire).toMatchObject({ ax: 30, ay: 0 }); expect(view().world.defend?.id).toBe(z);
    expect(view().world.base).toEqual({ x: 0, y: 0 });
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Defend, { kind: 2, target: q })).toBe(0);
    w.set(q, Transform, { x: 28, y: 0 });
    expect(view().world.hire?.ax).toBe(28); expect(view().world.defend?.id).toBe(z);
    w.add(q, G.Dead); expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Defend, { kind: 2, target: q })).toBe(G.WorkerFail.BadDetails);
  });
  it("Guard allows owned pets and structures, never someone else's pets", () => {
    const { w, p, bot } = setup();
    const pet = w.create(); w.add(pet, Transform, { x: 2, y: 0 }).add(pet, G.Pet, { owner: 8, hp: 100 });
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Defend, { kind: 2, target: pet })).toBe(G.WorkerFail.BadDetails);
    w.setField(pet, G.Pet, "owner", 7);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Defend, { kind: 2, target: pet })).toBe(0);
    expect(G.workerOrderTarget(w, bot)).toBe(pet);
    w.set(pet, Transform, { x: 9, y: 1 }); expect(G.workerWorkAnchor(w, bot)).toEqual({ x: 9, y: 1 });
  });
  it("Craft chooses selected affordable hand recipes instead of automatic axes; same skill gate as players", () => {
    const { w, p, bot, defs, view } = setup();
    const recipe = [...defs.recipes.values()].find((r) => r.key === "torch")!;
    for (const g of recipe.ingredients) G.addItem(w, bot, g.item, g.count * 2);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Craft, { selections: [recipe.id] })).toBe(0);
    expect(view().world.craftRecipe).toBe(recipe.id);
    const gated = [...defs.recipes.values()].find((r) => r.station === G.StationKind.None && r.skill)!;
    G.setSkillLevelProvider(w, () => 0);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Craft, { selections: [gated.id] })).toBe(G.WorkerFail.BadDetails);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Craft, { selections: [] })).toBe(0);
  });
  it("Farm selected plot ignores a closer plot and disables tilling elsewhere", () => {
    const { w, p, bot, defs, view } = setup();
    G.spawnCrop(w, 2, 0, G.plantableBySeed("wheat_seeds"));
    const plot = G.spawnCrop(w, 6, 0, G.plantableBySeed("wheat_seeds"));
    for (const e of w.query([G.Crop])) w.set(e, G.Crop, { growth: 0.5, waterUntilTick: 0 });
    G.addItem(w, bot, defs.itemId("watering_can"), 1);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Farm, { kind: 2, target: plot })).toBe(0);
    expect(view().world.farm?.tend?.id).toBe(plot); expect(view().world.farm?.till).toBeUndefined();
  });
  it("Maintain stays on the selected damaged piece instead of the nearest repair", () => {
    const { w, p, bot, defs, view } = setup();
    const make = (x: number) => { const e = w.create(); w.add(e, Transform, { x, y: 0 }).add(e, G.BuildPiece, { type: defs.pieceId("wall"), hp: 1, tier: 0 }); G.indexEntity(w, e); return e; };
    make(2); const target = make(7);
    for (const cost of G.pieceCost(defs, defs.pieces.get(defs.pieceId("wall"))!, 0)) G.addItem(w, bot, cost.item, cost.count * 3);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Maintain, { kind: 2, target })).toBe(0);
    expect(view().world.repair?.id).toBe(target);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Maintain, { kind: 1, x: 7, y: 0 })).toBe(0);
    expect(view().world.hire?.ax).toBe(7); // area work moves, storage does not
  });
  it("selected crafting fetches missing ingredients from base storage", () => {
    const { w, p, bot, defs, view } = setup();
    const sn = G.snapPlacement(w, { piece: defs.pieceId("basic_storage_box"), x: 4, y: 4, level: 0, rot: 0, tier: 0, variant: 0 });
    if (typeof sn === "number") throw new Error("snap");
    const piece = G.placePiece(w, p, sn, { pay: false }), storage = G.resolveAttachment(w, piece, G.AttachKind.Storage)!;
    const recipe = [...defs.recipes.values()].find((r) => r.key === "torch")!, ingredient = recipe.ingredients[0]!;
    G.addItem(w, storage, ingredient.item, ingredient.count);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Craft, { selections: [recipe.id] })).toBe(0);
    expect(view().world.hire?.supply).toEqual({ item: ingredient.item, count: ingredient.count });
  });
  it("successful selected crafts rotate the persisted cursor to the next recipe", () => {
    const { w, p, bot, defs } = setup();
    const recipes = ["torch", "wooden_club"].map((key) => [...defs.recipes.values()].find((r) => r.key === key)!);
    for (const r of recipes) for (const g of r.ingredients) G.addItem(w, bot, g.item, g.count * 3);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Craft, { selections: recipes.map((r) => r.id) })).toBe(0);
    expect(G.hireCraftPick(w, bot, defs)).toBe(recipes[0]!.id);
    G.setIntent(w, bot, { action: G.IntentAction.Craft, recipe: recipes[0]!.id }); steps(w, 1);
    G.setIntent(w, bot, { action: G.IntentAction.None }); steps(w, Math.ceil(recipes[0]!.seconds * 20) + 2);
    expect(w.getField(bot, G.WorkerOrder, "craftCursor")).toBe(1);
    expect(G.hireCraftPick(w, bot, defs)).toBe(recipes[1]!.id);
  });
  it("a selected plot keeps its identity on maturity and returns to soil after harvest", () => {
    const { w, p, bot, view } = setup();
    const crop = G.spawnCrop(w, 2, 0, G.plantableBySeed("wheat_seeds"));
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Farm, { kind: 2, target: crop })).toBe(0);
    const id = w.getField(crop, G.WorkerTarget, "id"); w.set(crop, G.Crop, { growth: 1, waterUntilTick: w.tick + 1_000_000 }); setTimeOfDay(w, 12); G.cropGrowthSystem(w); // ADR-286: growth needs water + light
    const node = G.workerOrderTarget(w, bot)!; expect(node).toBeDefined(); expect(w.has(node, G.ResourceNode)).toBe(true);
    expect(w.getField(node, G.WorkerTarget, "id")).toBe(id); expect(view().world.farm?.harvest?.id).toBe(node);
    w.setField(node, G.ResourceNode, "amount", 1);
    G.setIntent(w, bot, { action: G.IntentAction.Gather, target: node }); steps(w, 1);
    expect(G.workerOrderTarget(w, bot)).toBe(node); expect(w.getField(node, G.Crop, "kind")).toBe(0);
  });
  it("the Follow duty wrapper leaves ordinary worker and unhired utility scores unchanged", () => {
    const { ctx } = setup(); const c = ctx();
    for (const hired of [true, false]) {
      if (!hired) delete c.world.hire;
      for (const b of [...G.referenceBehaviors(), ...G.survivalBehaviors()]) {
        expect(scoreBehavior(G.withHireDuty(b), c, b.name, [b.name]), b.name).toBe(scoreBehavior(b, c, b.name, [b.name]));
      }
    }
  });
  it("Follow night scheduling cannot override catching up or a concrete food/water trip", () => {
    const { w, p, bot, ctx } = setup(); G.setWorkerJob(w, p, bot, G.WorkerJob.Follow);
    w.set(p, Transform, { x: 15 }); const c = ctx(); c.self.phase = "night";
    const registry = G.survivorRegistry();
    expect(scoreBehavior(registry.get("sleep")!, c, "sleep", ["sleep"])).toBe(0);
    expect(scoreBehavior(registry.get("work_follow")!, c, undefined, [])).toBeGreaterThan(0);
    c.self.hunger = 0.1; c.world.gatherNode = { id: 123, x: 2, y: 0, wanted: true }; delete c.world.food;
    expect(scoreBehavior(registry.get("sleep")!, c, "sleep", ["sleep"])).toBe(0);
    expect(scoreBehavior(registry.get("work_forage")!, c, undefined, [])).toBeGreaterThan(0);
    expect(scoreBehavior(registry.get("work_follow")!, c, undefined, [])).toBe(0);
  });
  it("Follow tracks the owner, automatically guards, and yields for foraging / eating / drinking", () => {
    const { w, p, bot, defs, view, ctx } = setup();
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Follow)).toBe(0);
    w.set(p, Transform, { x: 20, y: 0 });
    const z = G.spawnZombie(w, "zombie_walker", 21, 0);
    expect(view().world.hire?.ax).toBe(20); expect(view().world.defend?.id).toBe(z);
    w.destroy(z); w.set(bot, G.Survival, { hunger: 10, thirst: 10 });
    const food = G.spawnResourceNode(w, "berry_bush", 3, 0);
    w.setResource(G.WaterProbeRes, { tileAt: (x) => x >= 3 ? 1 : 3 });
    const c = ctx(); expect(c.world.gatherNode?.id).toBe(food); expect(c.world.waterAt).toBeDefined();
    const follow = G.hireBehaviors().find((b) => b.name === "work_follow")!;
    expect(follow.considerations.find((x) => x.name === "fed")!.input(c)).toBe(0);
    const forage = G.hireBehaviors().find((b) => b.name === "work_forage")!;
    expect(forage.considerations.find((x) => x.name === "hungry")!.input(c)).toBe(1);
    const o = idleOutput(); forage.run(c, o); expect(o.moveX).toBeGreaterThan(0);
    const water = G.autonomyBehaviors().find((b) => b.name === "drink_water")!; const drink = idleOutput(); water.run(c, drink);
    expect(drink.moveX !== 0 || drink.moveY !== 0 || drink.actions.some((a) => a.startsWith("drink:"))).toBe(true);
    G.addItem(w, bot, defs.itemId("berries"), 2); G.addItem(w, bot, defs.itemId("water_flask"), 1);
    const ctl = G.survivorController({ seed: 1 }); const a = G.makeAgent(G.makeAgentIdentity(6, 0, "bot_gatherer"), 1); ctl.add(a);
    let use = false; for (let t = 0; t < 30; t++) { const out = ctl.tick(t, () => G.buildAgentView(w, bot, a, { x: 0, y: 0 })).get(a)!; use ||= (out.commands ?? []).some((cmd) => cmd.type === G.UseCmd.name); }
    expect(use).toBe(true);
  });
});
