// ADR-448: a full bag must not stall a pit / ramp dig forever. Root cause (ADR-252-live probe on the
// V2r worldgen layout): digging the pit yields 1 soil into the bot's bag, and with a 16/16 full bag
// editTerrain refuses with TerrainFail.InventoryFull — while nextTerrainWork returned undefined without
// abandoning and without any make-room step, so the planner returned the earthworks goal with NO step
// and no leaves, which also gates the base goal by design: no ladder, no foundation, no bed, forever.
// (Pure ADR-441 base passes adr252-live 8/8; the stall needs the V2r layout, whose fruit trees ring the
// pit bot's base so it gathers fruit until the bag fills — but any future worldgen reshuffle can
// re-trigger it, so the fix is in the planner, not the layout.) Fix: nextTerrainWork / nextRampWork
// return a distinct { k: "stash" } work item when the dig is blocked ONLY by InventoryFull; the planner
// maps it to a stash step (whole largest surplus stack, never a kept item / tool / worn gear, non-food
// first); base_work executes it through the existing storageDepositActions + containerSeq machinery.
// editTerrain is untouched: a full bag still never loses dug soil (the deliberate invariant).
import { describe, expect, it } from "vitest";
import { idleOutput, installPermissions, Transform, type Entity } from "@engine/core";
import { TileMap } from "@engine/world";
import * as G from "../src/index.js";
import { nextRampWork, nextTerrainWork, planRampPlan, planTerrainBase } from "../src/ai/terrain_base.js";
import { aiMemoryOf, makePlan, pickStashStep, scanBase } from "../src/ai/planner.js";
import { baseBehaviors, fillPlanSensors } from "../src/ai/base_behaviors.js";
import { makeWorld, ensureClaim } from "./helpers.js";

function setup() {
  const w = makeWorld(), map = new TileMap();
  for (let y = -10; y < 20; y++) for (let x = -10; x < 20; x++) map.setTile(x, y, 3);
  w.setResource(G.TerrainRes, G.terrainFromTileMap(map));
  const p = G.spawnPlayer(w, { x: .5, y: 2.5, maxWeight: 0 }); w.add(p, G.Worker, {} as never);
  G.grantSkillUnlocks(w, p);
  const d = G.gameplayDefs(w); G.addItem(w, p, d.itemId("stone_shovel"), 1);
  for (const k of ["wood", "sticks", "stone", "fiber"]) G.addItem(w, p, d.itemId(k), 50);
  ensureClaim(w, p, 6, -4);
  return { w, map, p, d };
}
/** Fill every pack slot (16/16, no soil) the way the ADR-265 full-bag tests do. Wood aggregates to
 *  50 across its slots, so the stash step picks the whole wood stack — which also exercises the
 *  withdraw-back path, since the entrance ladder (4 wood + 6 sticks) and the pit campfire
 *  (5 wood + 4 stone) still need wood from the box. Sticks and stone stay in the bag for them. */
const fillBag = (w: ReturnType<typeof makeWorld>, p: Entity, d: G.GameDefs): void => {
  G.mapSlots(w, p, (v) => { for (let i = 0; i < v.addLimit; i++) { const item = i === 0 ? d.itemId("dye") : i === 1 ? d.itemId("stone_shovel") : i < 4 ? d.itemId("sticks") : i < 6 ? d.itemId("stone") : d.itemId("wood"); v.put(i, item, i === 0 ? d.items.get(item)!.maxStack : i === 1 ? 1 : 5, w.tick, d.items.get(item)!.maxDurability, 0); } return true; });
};

describe("ADR-448 full-bag earthworks stash", () => {
  it("a full bag turns the pit dig into a stash step, not a stepless stall — and the plan still keeps its Soil", () => {
    const { w, p, d } = setup(); const earth = planTerrainBase(w, p, { x: 0, y: 0 }, "pit")!;
    fillBag(w, p, d);
    // Before the fix this was undefined with the plan neither done nor abandoned: the planner
    // returned the earthworks goal with no step, and the base goal behind it never ran.
    expect(nextTerrainWork(w, p, earth)).toEqual({ k: "stash" });
    expect(earth.abandoned).not.toBe(true); expect(earth.done).not.toBe(true);
    const plan = makePlan({ world: w, self: p, defs: d, base: { x: 0, y: 0 }, bs: scanBase(w, d, { x: 0, y: 0 }), fails: {}, earth, terrainOnly: true });
    expect(plan.goal).toBe("earthworks");
    expect(plan.step?.k).toBe("stash");
    if (plan.step?.k === "stash") {
      expect(plan.step.item).not.toBe(d.itemId("soil")); // never stashes the Soil the earthworks needs
      expect(plan.step.item).not.toBe(d.itemId("stone_shovel")); // never stashes the shovel it digs with
      expect(plan.step.count).toBeGreaterThan(0);
      expect(G.countItem(w, p, plan.step.item)).toBe(plan.step.count); // the whole stack: a partial deposit frees no slot
    }
    expect(plan.keep.has(d.itemId("soil"))).toBe(true);
  });

  it("pickStashStep prefers the largest non-food stack, never a kept item / tool / worn gear", () => {
    const d = G.defaultDefs();
    const wood = d.itemId("wood"), berries = d.itemId("berries"), shovel = d.itemId("stone_shovel");
    const inv = new Map([[wood, 50], [berries, 90], [shovel, 1]]);
    const s = pickStashStep(inv, new Set(), new Set(), d);
    expect(s).toEqual({ k: "stash", item: wood, count: 50 }); // berries are bigger, but food is the last resort
    expect(pickStashStep(inv, new Set([wood]), new Set(), d)).toEqual({ k: "stash", item: berries, count: 90 }); // wood kept: food will do
    expect(pickStashStep(new Map([[wood, 5]]), new Set([wood]), new Set(), d)).toBeUndefined(); // nothing expendable
    expect(pickStashStep(new Map([[shovel, 1]]), new Set(), new Set(), d)).toBeUndefined(); // a tool is never stashed
    expect(pickStashStep(new Map([[wood, 5]]), new Set(), new Set([wood]), d)).toBeUndefined(); // worn gear is never stashed
    const tie = pickStashStep(new Map([[d.itemId("stone"), 10], [d.itemId("sticks"), 10]]), new Set(), new Set(), d);
    expect(tie).toEqual({ k: "stash", item: Math.min(d.itemId("stone"), d.itemId("sticks")), count: 10 }); // deterministic tie-break
  });

  it("a full bag turns the ramp grade into a stash step too (down-ramp yields soil it cannot hold)", () => {
    const w = makeWorld(); const map = new TileMap();
    for (let y = -16; y <= 47; y++) for (let x = -16; x <= 47; x++) { map.setTile(x, y, 3); map.ensureChunk(Math.floor(x / 32), Math.floor(y / 32)).setHeight(((x % 32) + 32) % 32, ((y % 32) + 32) % 32, 2); }
    w.setResource(G.TerrainRes, G.terrainFromTileMap(map));
    const bot = G.spawnPlayer(w, { x: 0.5, y: 0.5, maxWeight: 0 });
    w.add(bot, G.Worker, {} as never);
    const d = G.gameplayDefs(w); G.addItem(w, bot, d.itemId("stone_shovel"), 1);
    for (let x = 5; x <= 10; x++) G.setTerrainDig(w, x, 0, 3); // plateau at 5 east of x=5
    const ramp = planRampPlan(w, bot, 4, 0, 1, 0, 3, { x: 10, y: 0 })!;
    expect(nextRampWork(w, bot, ramp)).toMatchObject({ k: "ramp" }); // room in the bag: grades at once
    // gradeRamp checks reach before capacity, so the bot must stand at the foot for the full-bag
    // check to be the one that fires (same walk-then-grade order base_work follows).
    w.set(bot, Transform, { x: 4.0, y: 0.5 });
    expect(nextRampWork(w, bot, ramp)).toMatchObject({ k: "ramp" });
    fillBag(w, bot, d);
    expect(nextRampWork(w, bot, ramp)).toEqual({ k: "stash" });
    expect(ramp.abandoned).not.toBe(true);
    const a = G.makeAgent(G.makeAgentIdentity(1, 1), 1); aiMemoryOf(a).ramp = ramp;
    const plan = makePlan({ ramp, world: w, self: bot, defs: d, fails: {}, snooze: { axe: 1e9, pickaxe: 1e9, campfire: 1e9, basic_storage_box: 1e9, wood: 1e9, workbench: 1e9, "wear:torch": 1e9, earthworks: 1e9 } });
    expect(plan.goal).toBe("ramp"); expect(plan.step?.k).toBe("stash");
  });

  it("driving stash -> dig completes the pit (earth done, four cells at target height, ladder present, stack in the box)", () => {
    const { w, p, d } = setup(); installPermissions(w);
    const sn = G.snapPlacement(w, { piece: d.pieceId("basic_storage_box"), x: 3.5, y: 3.5, level: 0, rot: 0, tier: 0, variant: 0 });
    expect(typeof sn).toBe("object"); if (typeof sn === "number") return;
    const box = G.placePiece(w, p, sn, { pay: false });
    const earth = planTerrainBase(w, p, { x: 0, y: 0 }, "pit")!;
    fillBag(w, p, d);
    const a = G.makeAgent(G.makeAgentIdentity(1, 1), 1); aiMemoryOf(a).base = { x: 0, y: 0 }; aiMemoryOf(a).earth = earth;
    fillPlanSensors(w, p, { seen: [], home: { x: 0, y: 0 }, playerName: "owner" }, a, d, G.readSlots(w, p));
    const baseWork = baseBehaviors().find((b) => b.name === "base_work")!;
    const reg = G.registerGameplayCommands();
    const soil = d.itemId("soil");
    const execAction = (act: string): void => {
      const [k, t, item, count] = act.split(":");
      if (k === "copen") { G.setIntent(w, p, { action: G.IntentAction.OpenContainer, target: Number(t) }); G.containerSystem(w); }
      else if (k === "cdeposit") { G.setIntent(w, p, { action: G.IntentAction.Deposit, target: Number(t), item: Number(item), count: Number(count) }); G.containerSystem(w); }
      else if (k === "cwithdraw") { G.setIntent(w, p, { action: G.IntentAction.Withdraw, target: Number(t), item: Number(item), count: Number(count) }); G.containerSystem(w); }
      else if (k === "cclose") G.closeContainer(w, p);
      else if (k === "fire") { G.setIntent(w, p, { action: G.IntentAction.ToggleFire, target: Number(t) }); G.fuelSystem(w, .05); }
      else expect.unreachable(`unexpected base_work action ${act}`);
    };
    let stashed = false, stashedItem = 0, stashedCount = 0, withdrawnWood = 0, digs = 0, ladder = false, lit = false, lastK = "";
    for (let n = 0; n < 900 && !earth.done && !earth.abandoned; n++) {
      const plan = makePlan({ world: w, self: p, defs: d, base: { x: 0, y: 0 }, bs: scanBase(w, d, { x: 0, y: 0 }), fails: {}, earth, terrainOnly: true });
      const step = plan.step; if (!step) break; // the old stall, verbatim: stepless earthworks
      const isNewStep = step.k !== lastK; lastK = step.k;
      if (step.k === "stash" || step.k === "withdraw") {
        // Stash: deposit the surplus stack. Withdraw: the ladder / pit-fire fuel still needs wood the
        // stash just banked (the whole wood stack went into the box, so the bot takes back what the
        // next piece needs) — base_work executes both through the same container sequence.
        if (step.k === "stash") { stashed = true; stashedItem = step.item; stashedCount = step.count; }
        // Count each withdraw episode once: the step persists for ~20 ticks while base_work walks
        // and runs the container sequence, but the count moves out of the box only once.
        if (step.k === "withdraw" && isNewStep && step.item === stashedItem) withdrawnWood += step.count;
        const v = G.buildAgentView(w, p, a, { x: 0, y: 0 })!;
        const c = { ...v, world: { ...v.world, plan, base: { x: 0, y: 0 }, bs: scanBase(w, d, { x: 0, y: 0 }) }, bb: a.bb, memory: a.memory, traits: a.identity.traits, rng: a.rng, agent: a };
        const out = idleOutput(); baseWork.run!(c, out);
        const frame = G.agentOutputFrame(out, w.tick, reg);
        G.applyMovementInput(w, p, frame.actions, .05);
        for (const act of out.actions) execAction(act);
        w.tick++;
        continue;
      }
      if (step.k === "terrain") {
        w.set(p, Transform, step.stand); const old = G.countItem(w, p, soil);
        expect(G.editTerrain(w, p, step.x, step.y, step.dir, true)).toBe(G.TerrainFail.None);
        expect(G.editTerrain(w, p, step.x, step.y, step.dir)).toBe(G.TerrainFail.None);
        expect(G.countItem(w, p, soil)).toBe(old - step.dir); if (step.dir < 0) digs++;
      } else if (step.k === "build") {
        // The ladder / pit-campfire work items come through obtainPiece as build steps (the planner
        // wraps nextTerrainWork's ladder/light items); execute the exact placement the planner chose.
        if (step.stand) w.set(p, Transform, step.stand); else w.set(p, Transform, { x: .5, y: 2.5 });
        const result = G.tryPlace(w, p, { piece: step.piece, x: step.x, y: step.y, level: step.level ?? 0, rot: step.rot ?? 0, tier: step.tier ?? 0, variant: 0 });
        expect(result.ok, JSON.stringify({ step, result })).toBe(true);
        if (d.pieces.get(step.piece)?.key === "ladder") ladder = true;
      } else if (step.k === "light") {
        // The pit's fuel work item: the campfire stands unlit — deposit wood and light it.
        w.set(p, Transform, { x: .5, y: 1.5 });
        G.setIntent(w, p, { action: G.IntentAction.OpenContainer, target: step.piece }); G.containerSystem(w);
        G.setIntent(w, p, { action: G.IntentAction.Deposit, target: step.piece, item: d.itemId("wood"), count: 4 }); G.containerSystem(w);
        G.setIntent(w, p, { action: G.IntentAction.ToggleFire, target: step.piece }); G.fuelSystem(w, .05);
        expect(w.getField(step.piece, G.Fuel, "lit")).toBe(1); G.closeContainer(w, p); lit = true;
      } else expect.unreachable(`unexpected earthworks step ${step.k}`);
      w.tick++;
    }
    expect(earth.abandoned).not.toBe(true); expect(earth.done).toBe(true);
    expect(stashed).toBe(true); // the stash actually ran: the pit did not complete on a full bag without it
    expect(digs).toBe(12);
    expect(ladder).toBe(true); expect(lit).toBe(true);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) { expect(w.resource(G.TerrainRes).heightAt(x, y)).toBe(earth.height); expect(G.isUnderground(w, x, y)).toBe(true); }
    expect(G.countItem(w, p, soil)).toBe(12); // every dug soil kept, none lost to a full bag
    const store = G.resolveAttachment(w, box, G.AttachKind.Storage)!;
    // The stashed stack is in the box, minus exactly what the ladder / campfire / fuel withdrew
    // back out of it (4 + 5 + 4 wood) — nothing was dropped on the ground or lost.
    expect(G.countItem(w, store, stashedItem)).toBe(stashedCount - withdrawnWood);
  });
});
