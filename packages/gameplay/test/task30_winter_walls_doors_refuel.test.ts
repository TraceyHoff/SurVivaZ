/**
 * Task 30: fur armor set (already complete — pinned, not duplicated), frozen stored food, walls on
 * 1-row foundations, doors that only snap into door frames, and AI humans refuelling their own fires.
 */
import { describe, expect, it } from "vitest";
import { Blackboard, Rng, idleOutput, installPermissions, Membership, PlayerId, Transform, scoreBehavior, setSeason, setTimeOfDay, type AgentContext, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { SALT_CONSUME_TICKS, saltCount } from "../src/systems/spoilage.js";
import { collect, makeWorld, spawnLearned, steps, ensureClaim } from "./helpers.js";

const d = G.defaultDefs();
const item = (k: string) => d.itemId(k);
const piece = (k: string) => d.pieces.get(d.pieceId(k))!;
const req = (key: string, x: number, y: number, level = 0, rot = 0, tier = 1) => ({ piece: d.pieceId(key)!, x, y, level, rot, tier, variant: 0 });
const snap = (w: World, key: string, x: number, y: number, level = 0, rot = 0, tier = 1) => G.snapPlacement(w, req(key, x, y, level, rot, tier)) as G.Snapped;
const ok = (w: World, sn: G.Snapped) => G.validatePlacement(w, 0 as Entity, sn, { ignoreCost: true, ignoreRange: true });
function place(w: World, key: string, x: number, y: number, level = 0, rot = 0, tier = 1): Entity {
  const sn = snap(w, key, x, y, level, rot, tier); const f = ok(w, sn); if (f) throw new Error(`validate ${key} ${f}`);
  return G.placePiece(w, 0, sn, { pay: false });
}
/** Place with a real player paying (tryPlace path, server validation). */
function placeAs(w: World, p: Entity, key: string, x: number, y: number, level = 0, rot = 0, tier?: number): Entity {
  ensureClaim(w, p, x - 4, y + 4);
  const def = piece(key); const t = tier ?? (def.tiered ? 0 : def.fixedTier);
  for (const c of G.pieceCost(d, def, t)) G.addItem(w, p, c.item, c.count);
  const r = G.tryPlace(w, p, { piece: def.id, x, y, level, rot, tier: t, variant: 0 });
  if (!r.ok) throw new Error(`tryPlace ${key} failed ${(r as { reason: number }).reason}`);
  return (r as { piece: Entity }).piece;
}
const storageOf = (w: World, p: Entity): Entity => G.resolveAttachment(w, p, G.AttachKind.Storage)!;
const fireOf = (w: World, p: Entity): Entity => G.resolveAttachment(w, p, G.AttachKind.Fire)!;
/** Light a placed fire with `ticks` of burn left (and `wood` units already in its box). */
function lightFire(w: World, p: Entity, ticks: number, wood = 0): Entity {
  const f = fireOf(w, p);
  w.setField(f, G.Fuel, "lit", 1); w.setField(f, G.Fuel, "burnUntilTick", w.tick + ticks);
  if (wood) G.addItem(w, f, item("wood"), wood);
  return f;
}
const spoilMulOf = (w: World, c: Entity): number => w.getField(c, G.Container, "spoilMul") ?? 1;
const createdOf = (w: World, c: Entity, slot = 0): number => G.readSlots(w, c).created(slot);

describe("Task 30: fur armor set — already complete, pinned (not duplicated)", () => {
  const FUR = [
    ["fur_hat", G.WearSlot.Head, 3], ["fur_coat", G.WearSlot.Torso, 7], ["fur_leggings", G.WearSlot.Legs, 5],
    ["fur_boots", G.WearSlot.Feet, 3], ["fur_mittens", G.WearSlot.Hands, 2.5], ["fur_cloak", G.WearSlot.Back, 3],
  ] as const;
  it("the full set exists: every body slot, craftable from fur pelts, high insulation", () => {
    let total = 0;
    for (const [key, slot, ins] of FUR) {
      const it = d.items.get(item(key))!;
      expect(it.wear?.slot, key).toBe(slot); expect(it.wear?.insulation, key).toBe(ins);
      total += ins;
      const r = [...d.recipes.values()].find((x) => x.output.item === it.id);
      expect(r, `${key} recipe`).toBeDefined(); expect(r!.station).toBe(G.StationKind.Workbench);
      expect(r!.ingredients.some((g) => d.items.get(g.item)?.key === "fur_pelt"), `${key} uses fur pelts`).toBe(true);
    }
    // cold damage is blocked at total worn insulation >= 10 (exposureSystem): the full set clears it twice over
    expect(total).toBe(23.5); expect(total).toBeGreaterThanOrEqual(10);
    // the coat and leggings are armour too (the set is a fur ARMOR set, not just clothing)
    expect(d.items.get(item("fur_coat"))!.wear?.armor).toBe(3);
    expect(d.items.get(item("fur_leggings"))!.wear?.armor).toBe(2);
    expect(d.items.get(item("fur_boots"))!.wear?.armor).toBe(1);
  });
  it("fur pelts come from fur + hide at the workbench, and the vest is a torso alternative", () => {
    const r = [...d.recipes.values()].find((x) => x.output.item === item("fur_pelt"))!;
    expect(r.ingredients.map((g) => [d.items.get(g.item)?.key, g.count])).toEqual([["fur", 3], ["hide", 1]]);
    expect(d.items.get(item("fur_vest"))!.wear?.slot).toBe(G.WearSlot.Torso);
  });
});

describe("Task 30: frozen stored food does not spoil", () => {
  const winter = (w: World) => { setSeason(w, 2 as never, 1); setTimeOfDay(w, 0); expect(G.ambientTemperature(w, 0, 0)).toBeLessThan(0); };
  const summer = (w: World) => { setSeason(w, 0 as never, 1); setTimeOfDay(w, 0); expect(G.ambientTemperature(w, 0, 0)).toBeGreaterThan(0); };
  it("food in a container holds its freshness while frozen, then resumes from where it left off", () => {
    const w = makeWorld(); const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); steps(w, 1);
    const box = placeAs(w, p, "basic_storage_box", 1.5, 0.5); const xs = storageOf(w, box);
    summer(w);
    G.addItem(w, xs, item("cooked_meat"), 5);
    steps(w, 24000); // 1200 s warm: well decayed, not yet rotten
    const f0 = G.slotFreshness(w, xs, 0); expect(f0).toBeGreaterThan(0.2); expect(f0).toBeLessThan(0.6);
    const c0 = createdOf(w, xs);
    winter(w); // below 32 F / 0 C: frozen
    steps(w, 12000); // 600 s frozen
    const f1 = G.slotFreshness(w, xs, 0);
    expect(f1).toBeCloseTo(f0, 2); // no spoilage progress while frozen (old 0.1x floor would have lost ~0.025)
    expect(createdOf(w, xs) - c0).toBeGreaterThan(10000); // the clock was held still, not reset
    summer(w); // thaw: resumes from the frozen freshness, it does not reset to fresh
    steps(w, 6000); // 300 s warm
    const f2 = G.slotFreshness(w, xs, 0);
    expect(f2).toBeLessThan(0.4); expect(f2).toBeGreaterThan(0.1); // decayed on from f0, not from 1 (a reset would read ~0.85)
  });
  it("food in a player's pack freezes outdoors in winter (felt temp below 0)", () => {
    const w = makeWorld(); const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); steps(w, 1);
    // Task 33: the player must stay alive through both phases for this to mean anything — a bare
    // player standing outside dies to night zombies in summer and to hypothermia in winter, and a
    // dead player's pack is empty (freshness 1 == 1), so the test used to pass vacuously. Noon keeps
    // the zombies calm (ADR-194) and a large health pool outlasts the winter cold; winter noon is
    // still below freezing (-0.4 C), so the frozen assertion is unchanged.
    w.setField(p, G.Health, "max", 10000); w.setField(p, G.Health, "hp", 10000);
    summer(w); setTimeOfDay(w, 12);
    G.addItem(w, p, item("cooked_meat"), 5);
    steps(w, 12000);
    const f0 = G.slotFreshness(w, p, G.readSlots(w, p).items.findIndex((x) => x === item("cooked_meat")));
    winter(w); setTimeOfDay(w, 12); steps(w, 20); // let the exposure system read the cold
    expect(w.getField(p, G.Exposure, "feltTemp")!).toBeLessThan(0);
    const slot = G.readSlots(w, p).items.findIndex((x) => x === item("cooked_meat"));
    steps(w, 12000);
    expect(G.slotFreshness(w, p, slot)).toBeCloseTo(f0, 2);
  });
  it("a fuelled salt barrel burns no salt while frozen, and burns again once thawed", () => {
    const w = makeWorld(); const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); steps(w, 1);
    const barrel = placeAs(w, p, "salt_barrel", 1.5, 0.5); const bs = storageOf(w, barrel);
    G.addItem(w, bs, item("salt"), 2); G.addItem(w, bs, item("cooked_meat"), 5);
    winter(w);
    steps(w, SALT_CONSUME_TICKS + 40); // food present, but frozen: nothing burns
    expect(saltCount(w, bs)).toBe(2); expect(spoilMulOf(w, bs)).toBeGreaterThan(0); // multiplier preserved, not zeroed
    summer(w);
    steps(w, SALT_CONSUME_TICKS + 40); // thawed: the salt burn resumes
    expect(saltCount(w, bs)).toBe(1);
  });
});

describe("Task 30: walls on a 1-row foundation", () => {
  it("a bare 1-row foundation still reserves its outer corners for the L corner (ADR-211)", () => {
    const w = makeWorld();
    for (const x of [20, 21, 22]) place(w, "foundation", x + 0.5, 20.5);
    expect(ok(w, snap(w, "wall", 20.5, 20.05))).toBe(G.BuildFail.CornerSlot);
    expect(ok(w, snap(w, "wall", 20.05, 20.5))).toBe(G.BuildFail.CornerSlot);
    expect(ok(w, snap(w, "wall", 21.5, 20.05))).toBe(0); // middle of the row was never a corner
  });
  it("once an L claims one end corner, the other long edge takes a straight wall — the row can be fully walled", () => {
    const w = makeWorld();
    for (const x of [20, 21, 22]) place(w, "foundation", x + 0.5, 20.5);
    place(w, "wall_corner_outer", 20, 20, 0, 0); // L on the NW corner: claims the N + W edges
    expect(ok(w, snap(w, "wall", 20.5, 20.95))).toBe(0); // S edge: its corner's other arm is taken, so the L can never fit there
    expect(ok(w, snap(w, "wall_corner_outer", 20, 21, 0, 3))).toBe(G.BuildFail.Occupied); // second L still conflicts on the shared W edge
    // finish the ring: the other end corner's L, then straight walls everywhere else
    place(w, "wall_corner_outer", 23, 20, 0, 1);
    for (const [x, y] of [[21.5, 20.05], [21.5, 20.95], [20.5, 20.95], [22.5, 20.95]] as const) expect(ok(w, snap(w, "wall", x, y)), `${x},${y}`).toBe(0);
    for (const [x, y] of [[21.5, 20.05], [21.5, 20.95], [20.5, 20.95], [22.5, 20.95]] as const) place(w, "wall", x, y);
    // and a 1x1 foundation walls with two opposite L corners: they claim all four edges, so the tile is
    // fully enclosed with nothing left to place (the pre-fix code could not wall it at all)
    const w1 = makeWorld(); place(w1, "foundation", 20.5, 20.5);
    place(w1, "wall_corner_outer", 20, 20, 0, 0); place(w1, "wall_corner_outer", 21, 21, 0, 2);
    expect(ok(w1, snap(w1, "wall", 20.5, 20.95))).toBe(G.BuildFail.Occupied);
    expect(ok(w1, snap(w1, "wall", 21.5, 20.05))).toBe(G.BuildFail.Occupied);
  });
  it("the real support rule still holds: a wall-less upper deck is rejected", () => {
    const w = makeWorld();
    for (const x of [20, 21, 22]) for (const y of [20, 21, 22]) place(w, "foundation", x + 0.5, y + 0.5);
    expect(ok(w, snap(w, "floor", 21.5, 21.5, 1))).toBe(G.BuildFail.NoSupport); // level-1 floor, no walls below
    // straight walls below anchor the deck (an L corner alone does not: it is Placement.Free, so
    // supportsAt does not count it as deck support — pre-existing engine rule, unchanged here)
    place(w, "wall", 21.5, 20.05); place(w, "wall", 21.5, 22.95);
    expect(ok(w, snap(w, "floor", 21.5, 20.5, 1))).toBe(0); // the floor sits over the walled tile: anchored
  });
});

describe("Task 30: doors only snap into door frame walls", () => {
  function row(): { w: World; door: Entity } {
    const w = makeWorld();
    for (const x of [20, 21, 22, 23, 24]) place(w, "foundation", x + 0.5, 20.5);
    place(w, "wall", 21.5, 20.05); place(w, "wall", 23.5, 20.05);
    const door = place(w, "wall_doorway", 22.5, 20.05);
    return { w, door };
  }
  it("a door aimed at the frame — or up to a tile off toward a plain wall — snaps into the frame", () => {
    const { w, door } = row();
    for (const [ax, ay] of [[22.5, 20.05], [23.1, 20.05], [21.9, 20.05]] as const) {
      const sn = snap(w, "door_wood", ax, ay);
      expect(typeof sn === "number" ? sn : ok(w, sn), `aim ${ax},${ay}`).toBe(0);
      expect((sn as G.Snapped).parent).toBe(door);
      const dt = w.get(door, Transform)!; // the door snaps onto the frame's own position
      expect((sn as G.Snapped).pos.x).toBeCloseTo(dt.x); expect((sn as G.Snapped).pos.y).toBeCloseTo(dt.y);
    }
    // end to end: the placed door hangs on the doorway
    const p = spawnLearned(w, { x: 22.5, y: 22, maxWeight: 0, clientId: 1 });
    const placed = placeAs(w, p, "door_wood", 23.1, 20.05);
    expect(G.structures(w).opening(door)).toBe(placed);
  });
  it("with no frame anywhere, a door fails with NoSocket — plain wall, foundation edge, open ground", () => {
    const w = makeWorld();
    for (const x of [20, 21, 22]) place(w, "foundation", x + 0.5, 20.5);
    place(w, "wall", 21.5, 20.05);
    expect(ok(w, snap(w, "door_wood", 21.5, 20.05))).toBe(G.BuildFail.NoSocket); // onto a plain wall
    expect(ok(w, snap(w, "door_wood", 20.5, 20.05))).toBe(G.BuildFail.NoSocket); // onto a bare foundation edge
    expect(ok(w, snap(w, "door_wood", 25.5, 25.5))).toBe(G.BuildFail.NoSocket); // open ground
    // a window shutter snaps into a window frame the same way, and not into a plain wall
    place(w, "wall_window", 22.5, 20.05);
    expect(ok(w, snap(w, "window_shutters", 22.5, 20.05))).toBe(0);
    expect(ok(w, snap(w, "window_shutters", 21.5, 20.05))).toBe(G.BuildFail.NoSocket);
  });
  it("a door frame wall itself still places in a corner slot (small huts keep a door)", () => {
    const w = makeWorld();
    for (const x of [20, 21, 22]) for (const y of [20, 21, 22]) place(w, "foundation", x + 0.5, y + 0.5);
    expect(ok(w, snap(w, "wall_doorway", 20.5, 20.05))).toBe(0); // the NW corner edge: a frame is not a straight wall, so no CornerSlot
  });
});

describe("Task 30: AI humans refuel their own fires", () => {
  const BASE = { x: 10, y: 10 };
  function baseWithFires(w: World, p: Entity): { camp: Entity; fire: Entity; furnace: Entity } {
    for (const x of [10, 11]) for (const y of [10, 11]) place(w, "foundation", x + 0.5, y + 0.5);
    const camp = placeAs(w, p, "campfire", BASE.x + 1.5, BASE.y + 1.5);
    const fire = placeAs(w, p, "fireplace", BASE.x + 3.5, BASE.y + 1.5);
    const furnace = placeAs(w, p, "furnace", BASE.x + 3.5, BASE.y + 3.5);
    return { camp, fire, furnace };
  }
  /** A hand-built agent context over a base scan, like the Task 28 garden test's mkCtx. */
  function mkCtx(w: World, bot: Entity, agent: ReturnType<typeof G.makeAgent>, bs: G.BaseState, woodTotal: number, phase: "day" | "night" | "dusk" = "night", at: { x: number; y: number } = { x: BASE.x + 1.5, y: BASE.y + 1.5 }): AgentContext<G.AgentWorldView> {
    G.bindAgentWorld(agent, w);
    const self = { x: at.x, y: at.y, facing: 0, hp: 1, hunger: 1, thirst: 1, stamina: 1, tick: w.tick, dayT: 0.5, phase };
    return { self, bb: new Blackboard(), memory: agent.memory, traits: agent.identity.traits, rng: new Rng(1), agent, world: { seen: [], home: BASE, playerName: "p", base: BASE, bs, woodTotal } };
  }
  const runBeh = (beh: G.GameBehavior, c: AgentContext<G.AgentWorldView>) => { const o = idleOutput(); beh.run!(c as never, o as never); return o.actions; };
  it("scanBase lists every heat fire (campfire, fireplace, furnace) with lit + fuel, but not light-only lamps", () => {
    const w = makeWorld(); installPermissions(w); const p = spawnLearned(w, { x: 12, y: 12, maxWeight: 0, clientId: 1 }); steps(w, 1);
    const { camp, fire, furnace } = baseWithFires(w, p);
    lightFire(w, camp, 100); lightFire(w, fire, 5000); lightFire(w, furnace, 100);
    const lamp = placeAs(w, p, "candle", BASE.x + 4.5, BASE.y + 0.5);
    steps(w, 25);
    const bs = G.scanBase(w, d, BASE);
    const byId = new Map((bs.fires ?? []).map((f) => [f.id, f]));
    expect(byId.get(camp)?.lit).toBe(true); expect(byId.get(camp)?.fuelTicks).toBeLessThan(2400);
    expect(byId.get(fire)?.fuelTicks).toBeGreaterThan(2400);
    expect(byId.get(furnace)?.lit).toBe(true);
    expect(byId.has(lamp)).toBe(false); // a candle is light-only, not a fire to refuel
    expect(G.fireState(w, d, camp).fuelTicks).toBe(byId.get(camp)?.fuelTicks);
  });
  it("lowFire picks the lowest lit fire; a campfire waits for night but a furnace does not", () => {
    const w = makeWorld(); installPermissions(w); const p = spawnLearned(w, { x: 12, y: 12, maxWeight: 0, clientId: 1 }); steps(w, 1);
    const { camp, furnace } = baseWithFires(w, p);
    lightFire(w, camp, 100); lightFire(w, furnace, 200);
    steps(w, 25);
    const bs = G.scanBase(w, d, BASE);
    const bot = spawnLearned(w, { x: BASE.x + 1.5, y: BASE.y + 1.5, maxWeight: 0, clientId: 2 });
    const agent = G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1);
    // day: the campfire (warmth) is gated, the furnace (work fire) qualifies — even though the campfire is lower
    expect(G.lowFire(mkCtx(w, bot, agent, bs, 10, "day"))?.id).toBe(furnace);
    // night: both qualify, so the lowest wins
    expect(G.lowFire(mkCtx(w, bot, agent, bs, 10, "night"))?.id).toBe(camp);
  });
  it("refuel tops a low campfire up from the bag: open, deposit 10 wood, close", () => {
    const w = makeWorld(); installPermissions(w); const p = spawnLearned(w, { x: 12, y: 12, maxWeight: 0, clientId: 1 }); steps(w, 1);
    const { camp } = baseWithFires(w, p);
    lightFire(w, camp, 100);
    steps(w, 25);
    const bs = G.scanBase(w, d, BASE);
    const bot = spawnLearned(w, { x: BASE.x + 1.5, y: BASE.y + 1.5, maxWeight: 0, clientId: 2 });
    G.addItem(w, bot, item("wood"), 12);
    const agent = G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1);
    const c = mkCtx(w, bot, agent, bs, 12, "night");
    const beh = G.baseBehaviors().find((b) => b.name === "refuel")!;
    expect(scoreBehavior(beh, c, undefined, [])).toBeGreaterThan(0);
    const run = () => runBeh(beh, c);
    expect(run()).toEqual([`copen:${camp}`]);
    c.self.tick += 10; expect(run()).toEqual([`cdeposit:${camp}:${item("wood")}:10`]);
    c.self.tick += 10; expect(run()).toEqual(["cclose"]);
  });
  it("with no wood in the bag, the bot fetches it from base storage first, then refuels", () => {
    const w = makeWorld(); installPermissions(w); const p = spawnLearned(w, { x: 12, y: 12, maxWeight: 0, clientId: 1 }); steps(w, 1);
    const { camp } = baseWithFires(w, p);
    lightFire(w, camp, 100);
    const box = placeAs(w, p, "basic_storage_box", BASE.x + 3.5, BASE.y + 0.5);
    G.addItem(w, storageOf(w, box), item("wood"), 20);
    steps(w, 25);
    const bs = G.scanBase(w, d, BASE);
    expect(bs.storage?.counts.get(item("wood"))).toBe(20);
    const bot = spawnLearned(w, { x: BASE.x + 3.5, y: BASE.y + 0.5, maxWeight: 0, clientId: 2 });
    const agent = G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1);
    const c = mkCtx(w, bot, agent, bs, 0, "night", { x: BASE.x + 3.5, y: BASE.y + 0.5 }); // bag empty, standing at the box
    const beh = G.baseBehaviors().find((b) => b.name === "refuel")!;
    expect(scoreBehavior(beh, c, undefined, [])).toBeGreaterThan(0); // storage wood counts: the behaviour still fires
    const run = () => runBeh(beh, c);
    expect(run()).toEqual([`copen:${box}`]); // withdraw from the box first...
    c.self.tick += 10; expect(run()).toEqual([`cwithdraw:${box}:${item("wood")}:10`]);
    c.self.tick += 10; expect(run()).toEqual(["cclose"]);
    // ...the server executes the withdraw; the bot's bag now holds the wood, so the next run deposits it
    G.addItem(w, bot, item("wood"), 10);
    const c2 = mkCtx(w, bot, agent, G.scanBase(w, d, BASE), 10, "night");
    expect(runBeh(beh, c2)).toEqual([`copen:${camp}`]);
  });
  it("with no fuel anywhere the bot cools down instead of looping, and a cold fire is never a refuel target", () => {
    const w = makeWorld(); installPermissions(w); const p = spawnLearned(w, { x: 12, y: 12, maxWeight: 0, clientId: 1 }); steps(w, 1);
    const { camp, furnace } = baseWithFires(w, p);
    lightFire(w, camp, 100); // lit, low — but no wood in bag or storage
    steps(w, 25);
    const bs = G.scanBase(w, d, BASE);
    const bot = spawnLearned(w, { x: BASE.x + 1.5, y: BASE.y + 1.5, maxWeight: 0, clientId: 2 });
    const agent = G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1);
    const c = mkCtx(w, bot, agent, bs, 0, "night");
    const beh = G.baseBehaviors().find((b) => b.name === "refuel")!;
    expect(runBeh(beh, c)).toEqual([]); // nothing to fetch: no walk, no container spam
    expect(scoreBehavior(beh, c, undefined, [])).toBe(0); // cooled down for 200 ticks
    // an unlit furnace is not a refuel target even with wood in the bag
    const bs2 = G.scanBase(w, d, BASE);
    expect(bs2.fires?.find((f) => f.id === furnace)?.lit).toBe(false);
    expect(G.lowFire(mkCtx(w, bot, agent, bs2, 10, "day"))?.id).not.toBe(furnace);
  });
  it("a hired worker tends the owner's fires: fillHireSensors anchors bs on the owner's base", () => {
    const w = makeWorld(); installPermissions(w);
    const owner = spawnLearned(w, { x: 12, y: 12, maxWeight: 0, clientId: 1 });
    w.add(owner, PlayerId, { id: 1 }).add(owner, Membership, { partyId: 0, clanId: 0 });
    const { camp } = baseWithFires(w, owner);
    lightFire(w, camp, 100);
    steps(w, 25);
    const bot = spawnLearned(w, { x: BASE.x + 1.5, y: BASE.y + 1.5, maxWeight: 0, clientId: 2 });
    w.add(bot, G.Worker, { wantedItem: 0, owner: 1, job: G.WorkerJob.Gather, homeX: BASE.x, homeY: BASE.y });
    const agent = G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1);
    const view = G.buildAgentView(w, bot, agent, { x: BASE.x, y: BASE.y })!.world;
    expect(view.hire?.job).toBe(G.WorkerJob.Gather);
    expect(G.lowFire(mkCtx(w, bot, agent, view.bs!, 10, "night"))?.id).toBe(camp);
  });
});
