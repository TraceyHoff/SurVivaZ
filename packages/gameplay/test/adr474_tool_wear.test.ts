/**
 * ADR-474: tool wear + repair. Wear is 1 durability per successful gather swing / landed melee hit; a tool
 * that reaches 0 is BROKEN but stays in the bag (never vanishes, never a loot bag) and the hand falls back
 * to bare hands / fists. Below 25 % a tool is DULL (one tier lower for the gather bonus only). Repair is
 * in place for ~30 % of the tool's own recipe: first-tier tools anywhere, later tiers need an anvil in
 * range (Tracey). Bots repair through the `tool_repair` behaviour (`irepair:<slot>`).
 *
 * Skill-gate note (verified in build): no tool or weapon has an `item:<key>` unlock node in the skill tree
 * (only the four saddles do), so `itemRepairUnlocked` is a pass-through for every tool/weapon today — the
 * check follows the saddle pattern and will bind automatically if a tool is ever gated.
 */
import { describe, expect, it } from "vitest";
import { CommandRegistry, idleOutput, installCommandHandlers, installPermissions, Membership, PlayerId, Transform, CommandRejected, type AgentContext, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { addItem, countItem, defaultDefs, Equipment, GatherFail, GatherFailed, Health, IntentAction, ItemGathered, readSlots, setIntent, slotItem, spawnPlayer, spawnResourceNode, writeSlots } from "../src/index.js";
import { collect, makeWorld, plantClaim, spawnLearned, steps } from "./helpers.js";

const d = defaultDefs();
const I = (k: string): number => d.itemId(k);
const P = (k: string): number => d.pieceId(k);
const slotOf = (w: World, e: Entity, item: number): number => { for (let s = 0; s < 32; s++) if (slotItem(w, e, s).item === item) return s; throw new Error("no slot"); };
const hold = (w: World, e: Entity, key: string, n = 1): number => { addItem(w, e, I(key), n); const s = slotOf(w, e, I(key)); w.set(e, Equipment, { mainHandSlot: s, mainHandItem: I(key) }); return s; };
const mk = (w: World, pid: number, x = 0): Entity => { const p = spawnPlayer(w, { x, y: 0, maxWeight: 0, clientId: pid }); w.add(p, PlayerId, { id: pid }); return p; };
const hp = (w: World, e: Entity): number => w.getField(e, Health, "hp")!;
const setDur = (w: World, e: Entity, slot: number, dur: number): void => { const v = readSlots(w, e); v.put(slot, v.item(slot), v.count(slot), v.created(slot), dur, v.crafter(slot)); writeSlots(w, e, v, d); };
const durOf = (w: World, e: Entity, slot: number): number => readSlots(w, e).durability(slot);
const gather = (w: World, p: Entity, node: Entity): void => { setIntent(w, p, { action: IntentAction.Gather, target: node }); w.step(1 / 20); steps(w, 30); };
const attack = (w: World, a: Entity, b: Entity): void => { setIntent(w, a, { action: IntentAction.Attack, target: b }); steps(w, 1); setIntent(w, a, { action: IntentAction.None }); };
/** Place an anvil one tile from the player (claim + cost + tryPlace, the ADR-478 hearth pattern). */
function placeAnvil(w: World, p: Entity): Entity {
  plantClaim(w, p, 0, 0);
  const def = d.pieces.get(P("anvil"))!;
  for (const c of G.pieceCost(d, def, 0)) addItem(w, p, c.item, c.count);
  w.set(p, Transform, { x: 0, y: 1.2 });
  const res = G.tryPlace(w, p, { piece: P("anvil"), x: 1, y: 0, level: 0, rot: 0, tier: 0, variant: 0 });
  if (!res.ok) throw new Error(`place anvil failed: ${res.reason}`);
  return res.piece as Entity;
}

describe("ADR-474 gather wear", () => {
  it("a successful gather swing wears the held tool by 1", () => {
    const w = makeWorld(); const p = spawnPlayer(w, { x: 0, y: 0, maxWeight: 0 });
    const tree = spawnResourceNode(w, "tree", 1, 0);
    const s = hold(w, p, "iron_axe");
    expect(durOf(w, p, s)).toBe(400);
    gather(w, p, tree);
    expect(durOf(w, p, s)).toBe(399);
    expect(countItem(w, p, I("wood"))).toBeGreaterThan(0);
  });
  it("a tool worn to 0 stays in the bag, broken, and the hand falls back to bare hands", () => {
    const w = makeWorld(); const p = spawnPlayer(w, { x: 0, y: 0, maxWeight: 0 });
    const tree = spawnResourceNode(w, "tree", 1, 0);
    const s = hold(w, p, "iron_axe"); setDur(w, p, s, 1);
    const failed = collect(w, GatherFailed);
    gather(w, p, tree);
    expect(durOf(w, p, s)).toBe(0);
    expect(slotItem(w, p, s)).toEqual({ item: I("iron_axe"), count: 1 }); // still in the bag, not vanished, not a loot bag
    expect(G.isBrokenSlot(w, p, s, d)).toBe(true);
    expect(G.heldTool(w, p, d).kind).toBe(G.ToolKind.None); // bare hands (the existing bare-hands path)
    // A tree is fist-gatherable (minTier 1), so the broken axe just means fists — an oak (minTier 2) is not.
    const oak = spawnResourceNode(w, "oak_tree", 1, 0.5);
    gather(w, p, oak);
    expect(failed.at(-1)!.reason).toBe(GatherFail.WrongTool); // an oak needs an axe; fists cannot do it
    expect(durOf(w, p, s)).toBe(0); // a failed swing wears nothing
  });
  it("a dull tool counts one tier lower for the gather bonus only", () => {
    // Two identical worlds (same seed, same spawn order) share the node's deterministic rng stream, so the
    // base roll is identical and only the bonus differs: full iron axe 6 wood, dull iron axe 5 wood.
    const run = (dur: number): number => {
      const w = makeWorld({}, 42); const p = spawnPlayer(w, { x: 0, y: 0, maxWeight: 0 });
      const tree = spawnResourceNode(w, "tree", 1, 0);
      const s = hold(w, p, "iron_axe"); setDur(w, p, s, dur);
      const got = collect(w, ItemGathered); gather(w, p, tree);
      return got.filter((g) => g.item === I("wood")).reduce((a, g) => a + g.count, 0);
    };
    const w0 = makeWorld(); const p0 = spawnPlayer(w0, { x: 0, y: 0, maxWeight: 0 });
    expect(G.isDullSlot(w0, p0, 0, d)).toBe(false); // empty slot is not dull
    expect(run(400)).toBe(6);
    expect(run(80)).toBe(5); // 80 < 25 % of 400: dull, one tier lower
    const w = makeWorld(); const p = spawnPlayer(w, { x: 0, y: 0, maxWeight: 0 }); const s = hold(w, p, "iron_axe");
    setDur(w, p, s, 80); expect(G.isDullSlot(w, p, s, d)).toBe(true);
    setDur(w, p, s, 100); expect(G.isDullSlot(w, p, s, d)).toBe(false); // exactly 25 % is not dull
    setDur(w, p, s, 0); expect(G.isDullSlot(w, p, s, d)).toBe(false); // broken, not dull
  });
  it("a wrong tool and a toolless harvest wear nothing", () => {
    const w = makeWorld(); const p = spawnPlayer(w, { x: 0, y: 0, maxWeight: 0 });
    // An oak (minTier 2) cannot be punched, so the wrong tool fails outright — a tree (minTier 1) would
    // fall back to fists and succeed, which is also no wear but not a WrongTool.
    const oak = spawnResourceNode(w, "oak_tree", 1, 0.5);
    const s = hold(w, p, "stone_pickaxe"); const failed = collect(w, GatherFailed);
    gather(w, p, oak);
    expect(failed.at(-1)!.reason).toBe(GatherFail.WrongTool);
    expect(durOf(w, p, s)).toBe(150); // the pickaxe was never used
    const branches = spawnResourceNode(w, "fallen_branches", 1, 0);
    const a = hold(w, p, "iron_axe");
    gather(w, p, branches);
    expect(countItem(w, p, I("sticks"))).toBeGreaterThan(0);
    expect(durOf(w, p, a)).toBe(400); // a toolless harvest uses no tool
  });
});

describe("ADR-474 melee wear", () => {
  it("a landed melee hit wears the held weapon by 1", () => {
    const w = makeWorld(); installPermissions(w);
    const a = mk(w, 1, 0); const b = mk(w, 2, 1);
    const s = hold(w, a, "iron_axe");
    const h0 = hp(w, b); attack(w, a, b);
    expect(hp(w, b)).toBeLessThan(h0);
    expect(durOf(w, a, s)).toBe(399);
  });
  it("a weapon worn to 0 stays in the bag, broken, and the hand falls back to fists", () => {
    const w = makeWorld(); installPermissions(w);
    const a = mk(w, 1, 0); const b = mk(w, 2, 1);
    const s = hold(w, a, "iron_axe"); setDur(w, a, s, 1);
    const h0 = hp(w, b); attack(w, a, b);
    expect(hp(w, b)).toBeLessThan(h0); // the axe still landed this hit
    expect(durOf(w, a, s)).toBe(0);
    expect(slotItem(w, a, s)).toEqual({ item: I("iron_axe"), count: 1 });
    expect(G.isBrokenSlot(w, a, s, d)).toBe(true);
    expect(G.heldWeapon(w, a)).toBe(G.FISTS);
    steps(w, 20); // axe cooldown
    const h1 = hp(w, b); attack(w, a, b);
    expect(h1 - hp(w, b)).toBeCloseTo(5, 1); // fists do 5 (f32: reads back 4.9875) — the axe hit was 20, so the fist hit is weaker
    expect(durOf(w, a, s)).toBe(0); // fists wear nothing
  });
  it("a ranged shot does not wear the weapon", () => {
    const w = makeWorld(); installPermissions(w);
    const a = mk(w, 1, 0); const b = mk(w, 2, 8);
    const s = hold(w, a, "revolver"); addItem(w, a, I("pistol_round"), 10);
    steps(w, 1);
    setIntent(w, a, { action: IntentAction.Reload }); steps(w, 1); setIntent(w, a, { action: IntentAction.None });
    steps(w, 75);
    expect(w.getField(a, G.WeaponState, "loaded")).toBe(6);
    const h0 = hp(w, b); attack(w, a, b);
    expect(hp(w, b)).toBeLessThan(h0);
    expect(w.getField(a, G.WeaponState, "loaded")).toBe(5);
    expect(durOf(w, a, s)).toBe(600); // the shot spent a round, not durability
  });
});

describe("ADR-474 repair", () => {
  it("repair cost is 30 % of the tool's own recipe, rounded up per ingredient", () => {
    const w = makeWorld();
    expect(G.itemRepairCost(w, I("stone_axe"))).toEqual([
      { item: I("wood"), count: 1 }, { item: I("stone"), count: 1 }, { item: I("fiber"), count: 1 },
    ]); // recipe: wood 3, stone 2, fiber 2
    expect(G.itemRepairCost(w, I("bronze_axe"))).toEqual([
      { item: I("planks"), count: 1 }, { item: I("bronze_ingot"), count: 1 },
    ]); // recipe: planks 2, bronze_ingot 3
  });
  it("repairing a broken first-tier tool restores it to full in place and spends the cost", () => {
    const w = makeWorld(); const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
    const s = hold(w, p, "stone_axe"); setDur(w, p, s, 0);
    addItem(w, p, I("wood"), 2); addItem(w, p, I("stone"), 2); addItem(w, p, I("fiber"), 2);
    expect(G.checkItemRepair(w, p, s)).toBeUndefined();
    expect(G.repairItem(w, p, s)).toBe(true);
    expect(durOf(w, p, s)).toBe(150);
    expect(slotItem(w, p, s)).toEqual({ item: I("stone_axe"), count: 1 }); // same slot, same item
    expect(countItem(w, p, I("wood"))).toBe(1); expect(countItem(w, p, I("stone"))).toBe(1); expect(countItem(w, p, I("fiber"))).toBe(1);
  });
  it("repair validation: not damaged, cannot afford, not repairable, needs anvil", () => {
    const w = makeWorld(); const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
    const s = hold(w, p, "stone_axe");
    expect(G.checkItemRepair(w, p, s)).toBe("not_damaged"); // full durability
    setDur(w, p, s, 50);
    expect(G.checkItemRepair(w, p, s)).toBe("cannot_afford"); // no resources in the bag
    const wood = hold(w, p, "wood");
    expect(G.checkItemRepair(w, p, wood)).toBe("not_repairable"); // wood is not a tool or weapon
    const b = hold(w, p, "bronze_axe"); setDur(w, p, b, 10);
    addItem(w, p, I("planks"), 2); addItem(w, p, I("bronze_ingot"), 2);
    expect(G.checkItemRepair(w, p, b)).toBe("needs_anvil"); // tier 2 needs an anvil in range
    expect(G.repairItem(w, p, b)).toBe(false);
    expect(durOf(w, p, b)).toBe(10);
  });
  it("a later-tier tool repairs at an anvil", () => {
    const w = makeWorld(); const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
    placeAnvil(w, p);
    const b = hold(w, p, "bronze_axe"); setDur(w, p, b, 0);
    addItem(w, p, I("planks"), 1); addItem(w, p, I("bronze_ingot"), 1);
    expect(G.checkItemRepair(w, p, b)).toBeUndefined();
    expect(G.repairItem(w, p, b)).toBe(true);
    expect(durOf(w, p, b)).toBe(250);
    expect(countItem(w, p, I("planks"))).toBe(0); expect(countItem(w, p, I("bronze_ingot"))).toBe(0);
  });
  it("the repair command round-trips through the handler (accept + reject)", () => {
    const w = makeWorld(); const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
    const reg = G.registerGameplayCommands(new CommandRegistry()); const h = installCommandHandlers(w, reg); G.installItemRepairCommands(w, h);
    const rej: string[] = []; w.events.on(CommandRejected, (e) => rej.push(e.reason));
    const run = (v: Record<string, number>): void => { h.enqueue(p, 1, 1, reg.make(G.ItemRepairCmd as never, v as never)); w.step(1 / 20); };
    const s = hold(w, p, "stone_axe"); setDur(w, p, s, 0);
    addItem(w, p, I("wood"), 1); addItem(w, p, I("stone"), 1); addItem(w, p, I("fiber"), 1);
    run({ slot: s });
    expect(rej).toEqual([]);
    expect(durOf(w, p, s)).toBe(150);
    run({ slot: s }); // now full
    expect(rej).toEqual(["not_damaged"]);
    expect(durOf(w, p, s)).toBe(150);
  });
  it("itemRepairView: the inventory panel's Repair button data", () => {
    const w = makeWorld(); const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
    const c = { world: w, player: p };
    const s = hold(w, p, "stone_axe"); setDur(w, p, s, 50);
    addItem(w, p, I("wood"), 1); addItem(w, p, I("stone"), 1); addItem(w, p, I("fiber"), 1);
    const v = G.itemRepairView(c, s)!;
    expect(v.needsAnvil).toBe(false); expect(v.anvilInRange).toBe(false); expect(v.reason).toBeUndefined();
    expect(v.cost).toEqual([
      { item: I("wood"), name: "Pine Log", count: 1, have: 1 },
      { item: I("stone"), name: "Stone", count: 1, have: 1 },
      { item: I("fiber"), name: "Plant Fiber", count: 1, have: 1 },
    ]);
    const b = hold(w, p, "bronze_axe"); setDur(w, p, b, 10);
    const vb = G.itemRepairView(c, b)!;
    expect(vb.needsAnvil).toBe(true); expect(vb.anvilInRange).toBe(false); expect(vb.reason).toBe("needs_anvil");
    expect(G.itemRepairView(c, slotOf(w, p, I("wood")))).toBeUndefined(); // not a tool or weapon
    setDur(w, p, s, 150);
    expect(G.itemRepairView(c, s)!.reason).toBe("not_damaged");
  });
});

describe("ADR-474 bot repair", () => {
  function botSetup() {
    const w = makeWorld(); installPermissions(w); G.installEconomy(w);
    const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
    w.add(p, PlayerId, { id: 1 }).add(p, Membership, { partyId: 0, clanId: 0 });
    const agent = G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1);
    agent.bb.set("sitePickAt", 0);
    const ctx = (): AgentContext<G.AgentWorldView> => { const v = G.buildAgentView(w, p, agent, { x: 0, y: 0 })!; return { ...v, bb: agent.bb, memory: agent.memory, traits: agent.identity.traits, rng: agent.rng, agent }; };
    const run = (name: string, c: AgentContext<G.AgentWorldView>) => { const o = idleOutput(); const r = G.survivalBehaviors().find((b) => b.name === name)!.run(c, o); return { o, r }; };
    return { w, p, agent, ctx, run };
  }
  it("a bot with a broken repairable tool gets the sensor and the tool_repair behaviour pushes irepair", () => {
    const { w, p, ctx, run } = botSetup();
    const s = hold(w, p, "stone_axe"); setDur(w, p, s, 0);
    addItem(w, p, I("wood"), 1); addItem(w, p, I("stone"), 1); addItem(w, p, I("fiber"), 1);
    const c = ctx();
    expect(c.world.repairTool).toEqual({ slot: s });
    const { o } = run("tool_repair", c);
    expect(o.actions).toEqual([`irepair:${s}`]);
    expect(G.actionCommand(`irepair:${s}`)).toMatchObject({ type: G.ItemRepairCmd.name, payload: { slot: s } });
  });
  it("the sensor stays clear when the repair is unaffordable, needs an anvil, or the tool is only dull", () => {
    const { w, p, ctx } = botSetup();
    const s = hold(w, p, "stone_axe"); setDur(w, p, s, 0);
    expect(ctx().world.repairTool).toBeUndefined(); // no resources in the bag
    addItem(w, p, I("wood"), 1); addItem(w, p, I("stone"), 1); addItem(w, p, I("fiber"), 1);
    expect(ctx().world.repairTool).toEqual({ slot: s });
    setDur(w, p, s, 50); // dull, not broken: still works, so no repair chore
    expect(ctx().world.repairTool).toBeUndefined();
    const b = hold(w, p, "bronze_axe"); setDur(w, p, b, 0);
    addItem(w, p, I("planks"), 1); addItem(w, p, I("bronze_ingot"), 1);
    expect(ctx().world.repairTool).toBeUndefined(); // tier 2, no anvil in range
  });
});
