import { describe, expect, it } from "vitest";
import { idleOutput, installPermissions, NetId, PlayerId, Transform, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { collect, DT, ensureClaim, makeWorld, spawnLearned, steps } from "./helpers.js";

let nid = 9000;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };
const pid = (w: World, e: Entity, id: number): Entity => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); return e; };
function setup(): { w: World; p: Entity; id: (k: string) => number } {
  const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }); pid(w, p, 7); net(w, p);
  return { w, p, id: (k) => G.gameplayDefs(w).itemId(k) };
}
/** Horse at (1, 0) facing east; its rear pin sits at (-0.5, 0). Bare: no harness, so it may not tow yet. */
const horse = (w: World, p: Entity): Entity => net(w, G.makeMount(w, "animal_horse", 1, 0, p));
/** A drawn vehicle whose front hitch sits exactly on the horse's rear pin. */
const atPin = (w: World, id: string): Entity => {
  const d = G.VEHICLE_DEFS.find((x) => x.id === id)!; const front = d.hitches.find((h) => h.at === "front")!.offset;
  return net(w, G.spawnVehicle(w, id, -0.5 - front, 0, 0));
};
const slotOf = (w: World, e: Entity, item: number): number => { const v = G.readSlots(w, e); for (let i = 0; i < v.slotCount; i++) if (v.item(i) === item && v.count(i)) return i; return -1; };
/** Give `p` a harness and put it on `m` (throws when it fails — test setup, not the code under test). */
const harnessIt = (w: World, p: Entity, m: Entity): void => {
  const hid = G.gameplayDefs(w).itemId("harness"); G.addItem(w, p, hid, 1);
  const slot = slotOf(w, p, hid); if (slot < 0 || !G.harnessMount(w, p, m, slot)) throw new Error("setup: harnessing failed");
};
const gallop = (w: World, p: Entity, n: number): void => { for (let i = 0; i < n; i++) { G.applyMovementInput(w, p, G.GameplayActions.MoveRight | G.GameplayActions.Sprint, DT); w.step(DT); } };

describe("ADR-359 harness item + recipe", () => {
  it("a harness item exists (family harness, single stack) with a workbench recipe cheaper than a saddle", () => {
    const w = makeWorld(); const d = G.defaultDefs();
    const item = d.items.get(G.gameplayDefs(w).itemId("harness"))!;
    expect(item.key).toBe("harness"); expect(item.name).toBe("Harness"); expect(item.family).toBe("harness"); expect(item.maxStack).toBe(1);
    const r = [...d.recipes.values()].find((x) => d.items.get(x.output.item)?.key === "harness")!;
    expect(r).toBeDefined(); expect(r.station).toBe(G.StationKind.Workbench); expect(r.seconds).toBe(6);
    expect(r.ingredients).toEqual(expect.arrayContaining([
      expect.objectContaining({ item: d.itemId("leather"), count: 2 }),
      expect.objectContaining({ item: d.itemId("rope"), count: 2 }),
      expect.objectContaining({ item: d.itemId("iron_ingot"), count: 1 }),
    ]));
    const saddle = [...d.recipes.values()].find((x) => d.items.get(x.output.item)?.key === "saddle_leather")!;
    expect(r.seconds).toBeLessThan(saddle.seconds); // tack, not a seat: less leather, no thread, faster
    expect(r.ingredients.reduce((n, g) => n + g.count, 0)).toBeLessThan(saddle.ingredients.reduce((n, g) => n + g.count, 0));
    expect(G.recipeOutputUnlocked(w, spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }), r)).toBe(true); // no skill node gates it
  });
  it("the harness crafts at a workbench from leather + rope + iron", () => {
    const { w, p, id } = setup(); ensureClaim(w, p, 0, 0);
    const d = G.gameplayDefs(w); const sn = G.snapPlacement(w, { piece: d.pieceId("workbench"), x: -1.5, y: 0.5, level: 0, rot: 0, tier: 0, variant: 0 });
    if (typeof sn === "number") throw new Error(`snap ${sn}`); G.placePiece(w, p, sn, { pay: false }); steps(w, 1);
    for (const [it, n] of [["leather", 2], ["rope", 2], ["iron_ingot", 1]] as const) G.addItem(w, p, id(it), n);
    const r = [...d.recipes.values()].find((x) => d.items.get(x.output.item)?.key === "harness")!;
    expect(G.enqueueCraft(w, p, r.id, 1)).toBeGreaterThanOrEqual(0); // queued (a string would be a CraftFail reason)
    steps(w, 20 * 8); expect(G.countItem(w, p, id("harness"))).toBe(1);
  });
});

describe("ADR-359 harness equip / unequip", () => {
  it("a harness goes on a mount (not a consumable) and comes back off into the pack", () => {
    const { w, p, id } = setup(); const m = horse(w, p); const ev = collect(w, G.MountEvent);
    expect(G.isHarnessed(w, m)).toBe(false); expect(G.harnessInfo(w, m)).toBeUndefined();
    G.addItem(w, p, id("saddle_leather"), 1); // not a harness
    expect(G.checkHarness(w, p, m, slotOf(w, p, id("saddle_leather")))).toBe("not_harness");
    expect(G.checkHarness(w, p, m, 99)).toBe("no_item");
    G.addItem(w, p, id("harness"), 1);
    expect(G.harnessMount(w, p, m, slotOf(w, p, id("harness")))).toBe(true);
    expect(G.isHarnessed(w, m)).toBe(true); expect(G.harnessInfo(w, m)).toMatchObject({ item: id("harness"), name: "Harness" });
    expect(G.countItem(w, p, id("harness"))).toBe(0); // worn, not consumed into nothing: it lives on the mount
    steps(w, 1); // MountEvent delivers at end of tick
    expect(ev.some((e) => e.result === G.MountResult.Harnessed)).toBe(true);
    expect(G.checkUnharness(w, p, m)).toBeUndefined();
    expect(G.unharnessMount(w, p, m)).toBe(true);
    expect(G.isHarnessed(w, m)).toBe(false); expect(G.countItem(w, p, id("harness"))).toBe(1);
    steps(w, 1);
    expect(ev.some((e) => e.result === G.MountResult.Unharnessed)).toBe(true);
    expect(G.checkUnharness(w, p, m)).toBe("no_harness");
  });
  it("swapping a harness returns the old one to the pack; a stranger may not harness it", () => {
    const { w, p, id } = setup(); const m = horse(w, p); harnessIt(w, p, m);
    const q = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 8 }); pid(w, q, 8); net(w, q);
    G.addItem(w, q, id("harness"), 1);
    expect(G.checkHarness(w, q, m, slotOf(w, q, id("harness")))).toBe("not_owner");
    G.addItem(w, p, id("harness"), 1);
    expect(G.harnessMount(w, p, m, slotOf(w, p, id("harness")))).toBe(true); // swap: the old harness comes back
    expect(G.countItem(w, p, id("harness"))).toBe(1); expect(G.isHarnessed(w, m)).toBe(true);
  });
  it("a dead harnessed mount drops its harness in the loot bag with the saddle", () => {
    const { w, p, id } = setup(); const m = horse(w, p); harnessIt(w, p, m);
    w.add(m, G.Dead, {} as never); steps(w, 1);
    expect(w.has(m, G.Mount)).toBe(false); expect(w.has(m, G.MountHarness)).toBe(false);
    const bag = [...w.query([G.LootBag, G.Container])].find((b) => G.listSlots(w, b).some((s) => s.item === id("harness")));
    expect(bag).toBeDefined(); expect(G.countItem(w, bag!, id("harness"))).toBe(1);
  });
  it("MountHarness replicates and persists like the saddle fields (append-only component)", () => {
    expect(G.replicationOf(G.MountHarness)?.scope).toBe("all");
    expect(G.GAMEPLAY_COMPONENTS).toContain(G.MountHarness);
    expect(G.MountHarness.persistent).toBe(true); expect(G.MountHarness.networked).toBe(true);
  });
});

describe("ADR-359 hook up / detach", () => {
  it("an unharnessed mount is refused (no_harness); a harnessed mount hooks up to every drawn class", () => {
    const { w, p } = setup(); const m = horse(w, p);
    for (const d of G.VEHICLE_DEFS.filter((x) => G.isDrawnDef(x))) {
      const v = atPin(w, d.id);
      expect(G.validateHitch(w, p, v, m)).toBe("no_harness");
      expect(G.hitchVehicles(w, p, v, m)).toBe("no_harness");
      expect(w.getField(v, G.Hitch, "parentNetId")).toBe(0);
    }
    harnessIt(w, p, m);
    for (const d of G.VEHICLE_DEFS.filter((x) => G.isDrawnDef(x))) {
      const v = atPin(w, d.id);
      expect(G.validateHitch(w, p, v, m)).toBeUndefined();
      expect(G.hitchVehicles(w, p, v, m)).toBeUndefined();
      expect(w.getField(v, G.Hitch, "parentNetId")).toBe(w.getField(m, NetId, "id"));
      expect(w.getField(m, G.Hitch, "towNetId")).toBe(w.getField(v, NetId, "id"));
      expect(G.unhitchVehicle(w, p, v)).toBeUndefined(); // one mount, every class in turn
    }
    // the harness gate does not change the ADR-358 kind rules
    const truck = net(w, G.spawnVehicle(w, "truck_pickup", -2.9, 3, 0));
    expect(G.validateHitch(w, p, atPin(w, "wagon_small"), truck)).toBe("incompatible");
    expect(G.validateHitch(w, p, net(w, G.spawnVehicle(w, "trailer_utility_small", -3.3, 3, 0)), m)).toBe("incompatible");
  });
  it("detach frees the vehicle (it stays parked where it is) and the mount keeps its harness", () => {
    const { w, p } = setup(); const m = horse(w, p); harnessIt(w, p, m);
    const v = atPin(w, "wagon_medium"); expect(G.hitchVehicles(w, p, v, m)).toBeUndefined();
    const vt0 = { ...w.get(v, Transform)! };
    expect(G.unhitchVehicle(w, p, v)).toBeUndefined();
    expect(w.getField(v, G.Hitch, "parentNetId")).toBe(0); expect(w.getField(m, G.Hitch, "towNetId")).toBe(0);
    expect(w.get(v, G.Vehicle)!.speed).toBe(0); expect(G.isHarnessed(w, m)).toBe(true);
    for (let i = 0; i < 20; i++) w.step(DT); // the freed wagon does not roll away on its own
    expect(w.get(v, Transform)!.x).toBe(vt0.x); expect(w.get(v, Transform)!.y).toBe(vt0.y);
    expect(G.unhitchVehicle(w, p, v)).toBe("not_hitched");
  });
  it("unequipping the harness while hitched is refused (detach first); it works after detach", () => {
    const { w, p, id } = setup(); const m = horse(w, p); harnessIt(w, p, m);
    const v = atPin(w, "cart"); expect(G.hitchVehicles(w, p, v, m)).toBeUndefined();
    expect(G.checkUnharness(w, p, m)).toBe("hitched");
    expect(G.unharnessMount(w, p, m)).toBe(false); expect(G.isHarnessed(w, m)).toBe(true);
    expect(G.countItem(w, p, id("harness"))).toBe(0); // still on the mount, not in the pack
    expect(G.unhitchVehicle(w, p, v)).toBeUndefined();
    expect(G.unharnessMount(w, p, m)).toBe(true); expect(G.countItem(w, p, id("harness"))).toBe(1);
  });
  it("a harnessed mount and its wagon move as one unit (pin joint, through the harness path)", () => {
    const { w, p } = setup(); const m = horse(w, p); harnessIt(w, p, m);
    const v = atPin(w, "wagon_medium"); expect(G.rideMount(w, p, m)).toBe(true); expect(G.hitchVehicles(w, p, v, m)).toBeUndefined();
    const vt0 = { ...w.get(v, Transform)! }; gallop(w, p, 100);
    const d = G.vehicleDefOf(w, v)!; const t = w.get(v, Transform)!;
    const front = G.hitchPoint(d, "front", t.x, t.y, w.getField(v, G.Vehicle, "heading")!)!; const pin = G.mountRearPin(w, m)!;
    expect(Math.hypot(pin.x - front.x, pin.y - front.y)).toBeLessThan(1e-3);
    expect(Math.hypot(t.x - vt0.x, t.y - vt0.y)).toBeGreaterThan(20);
  });
});

describe("ADR-359 mount panel + HUD", () => {
  it("mountView shows the harness, the pack's harnesses, nearby drawn vehicles and the tow once hitched", () => {
    const { w, p, id } = setup(); const m = horse(w, p);
    const v = atPin(w, "wagon_small");
    let mv = G.mountView(w, p, m)!;
    expect(mv.harness).toBeUndefined(); expect(mv.towing).toBeUndefined();
    expect(mv.drawn.map((d) => d.id)).toEqual([v]); expect(mv.drawn[0]!.name).toBe("Wagon Small");
    G.addItem(w, p, id("harness"), 2);
    mv = G.mountView(w, p, m)!;
    expect(mv.harnesses).toHaveLength(2); expect(mv.harnesses[0]!.name).toBe("Harness");
    harnessIt(w, p, m); // adds one more harness and equips it: two of the three stay in the pack
    mv = G.mountView(w, p, m)!;
    expect(mv.harness).toMatchObject({ item: id("harness"), name: "Harness" }); expect(mv.harnesses).toHaveLength(2);
    expect(G.hitchVehicles(w, p, v, m)).toBeUndefined();
    mv = G.mountView(w, p, m)!;
    expect(mv.towing).toMatchObject({ id: v, name: "Wagon Small", cls: "wagon" }); expect(mv.drawn).toEqual([]);
    expect(G.rideMount(w, p, m)).toBe(true);
    expect(G.ridingHud(w, p)).toContain("towing Wagon Small");
  });
  it("mount event + reject text cover the harness (15/16, no_harness / hitched)", () => {
    expect(G.mountEventText(15, 0)).toMatch(/Harness on/); expect(G.mountEventText(16, 0)).toMatch(/Harness off/);
    expect(G.mountRejectText("gameplay.mountHarness", "not_harness")).toMatch(/isn't a harness/);
    expect(G.mountRejectText("gameplay.mountUnharness", "hitched")).toMatch(/Detach the wagon/);
    expect(G.mountRejectText("gameplay.vehicleHitch", "no_harness")).toMatch(/needs a harness/);
  });
});

// ---- AI -------------------------------------------------------------------------------
interface Rig { w: World; p: Entity; a: Agent; id: (k: string) => number; home: { x: number; y: number } }
function rig(opts: { learned?: boolean; x?: number; y?: number; pid?: number; seed?: number } = {}): Rig {
  const w = makeWorld({}, opts.seed ?? 42); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const x = opts.x ?? 0, y = opts.y ?? 0;
  const p = opts.learned === false ? G.spawnPlayer(w, { x, y, maxWeight: 0, clientId: 7 }) : spawnLearned(w, { x, y, maxWeight: 0, clientId: 7 });
  pid(w, p, opts.pid ?? 7); net(w, p);
  const a = G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1); const d = G.gameplayDefs(w);
  return { w, p, a, id: (k) => d.itemId(k), home: { x, y } };
}
type Ctx = AgentContext<G.AgentWorldView>;
function ctxOf(r: Rig): Ctx {
  const v = G.buildAgentView(r.w, r.p, r.a, r.home)!;
  return { self: v.self, bb: r.a.bb, memory: r.a.memory, traits: { ...r.a.identity.traits, bravery: 0.8, industriousness: 0.8 }, rng: r.a.rng, agent: r.a, world: v.world };
}
const out = (): AgentOutput & { commands?: G.AgentCommand[] } => ({ ...idleOutput(), actions: [] as string[] });
const behavior = (name: string): G.GameBehavior => [...G.mountBehaviors(), ...G.vehicleBehaviors(), ...G.referenceBehaviors()].find((b) => b.name === name)!;
const passes = (b: G.GameBehavior, c: Ctx): boolean => b.considerations.every((k) => (k.weight ?? 1) * (k.input(c) >= 0.5 ? 1 : 0) > 0 || (k.curve.type === "linear" && k.input(c) > 0));
/** Apply the bot's mount / vehicle / craft commands the way the server handlers do, plus its movement. */
function apply(r: Rig, o: AgentOutput & { commands?: G.AgentCommand[] }, log: string[]): void {
  const { w, p } = r; for (const a of o.actions) if (a.startsWith("equip:")) { const s = Number(a.slice(6)); w.set(p, G.Equipment, { mainHandSlot: s, mainHandItem: G.readSlots(w, p).item(s) }); log.push(a); }
  G.emitAgentCommands(o);
  for (const c of o.commands ?? []) {
    const v = c.payload as { target: number; tow: number; item: number; slot: number; recipe: number }; const t = v.target as Entity; log.push(c.type);
    if (c.type === G.MountFeedCmd.name) { if (!G.checkFeed(w, p, t, v.item)) G.feedMount(w, p, t, v.item); }
    else if (c.type === G.MountRideCmd.name) G.rideMount(w, p, t);
    else if (c.type === G.MountDismountCmd.name) G.dismount(w, p);
    else if (c.type === G.MountSaddleCmd.name) G.saddleMount(w, p, t, v.slot);
    else if (c.type === G.MountHarnessCmd.name) G.harnessMount(w, p, t, v.slot);
    else if (c.type === G.MountUnharnessCmd.name) G.unharnessMount(w, p, t);
    else if (c.type === G.MountRepairCmd.name) G.repairSaddle(w, p, t);
    else if (c.type === G.VehicleHitchCmd.name) G.hitchVehicles(w, p, t, v.tow as Entity);
    else if (c.type === G.VehicleUnhitchCmd.name) G.unhitchVehicle(w, p, t);
    else if (c.type === G.QueueCraftCmd.name) G.enqueueCraft(w, p, v.recipe, 1);
  }
  let bits = 0; const len = Math.hypot(o.moveX, o.moveY);
  if (len > 1e-6) { if (o.moveX > 0.38 * len) bits |= G.GameplayActions.MoveRight; else if (o.moveX < -0.38 * len) bits |= G.GameplayActions.MoveLeft; if (o.moveY > 0.38 * len) bits |= G.GameplayActions.MoveDown; else if (o.moveY < -0.38 * len) bits |= G.GameplayActions.MoveUp; }
  // Analog steering, like a production bot (bot_input): the bits alone quantise to 8 iso diagonals, which cannot
  // ride a mount onto a 1.5-tile pin.
  G.applyMovementInput(w, p, bits, DT, { x: o.moveX, y: o.moveY });
}
/** Run one behaviour (+ the ADR-321 mount policy, exactly as survivorRegistry wraps it) for up to n ticks. */
function drive(r: Rig, name: string, n: number, until: () => boolean, log: string[] = [], hook?: (o: AgentOutput) => void): number {
  const b = behavior(name);
  for (let i = 0; i < n; i++) {
    const c = ctxOf(r); const o = out(); b.run(c, o); G.mountPolicy(c, o, name); hook?.(o); apply(r, o, log); r.w.step(DT);
    if (until()) return i;
  }
  return -1;
}
/** Fill every inventory slot (pack + hotbar) so the bot wants cargo space. */
const fillPack = (r: Rig): void => { for (let i = 0; i < 24; i++) G.addItem(r.w, r.p, r.id("stone"), 50); };
const emptyPack = (r: Rig): void => { for (const s of [...G.listSlots(r.w, r.p)]) G.removeItem(r.w, r.p, s.item, s.count); };

describe("ADR-359 AI action strings", () => {
  it("mharness / munharness become the ADR-359 net commands", () => {
    const o = out(); o.actions = ["mharness:12:3", "munharness:12", "mharness:12:x", "mharness:12"]; G.emitAgentCommands(o);
    expect(o.actions).toEqual([]);
    expect(o.commands!.map((c) => c.type)).toEqual([G.MountHarnessCmd.name, G.MountUnharnessCmd.name]);
    expect(o.commands![0]!.payload).toEqual({ target: 12, slot: 3 }); expect(o.commands![1]!.payload).toEqual({ target: 12 });
  });
  it("the survivor registry carries harness_up / hitch_drawn / unhitch_drawn", () => {
    const names = G.survivorRegistry().list().map((b) => b.name);
    for (const n of ["harness_up", "hitch_drawn", "unhitch_drawn"]) expect(names).toContain(n);
  });
});

describe("ADR-359 AI harness_up", () => {
  it("equips a harness from the bag when a drawn vehicle is near, and never without one to tow", () => {
    const r = rig(); const m = net(r.w, G.makeMount(r.w, "animal_horse", 1, 0, r.p));
    G.addItem(r.w, r.p, r.id("harness"), 1);
    let c = ctxOf(r); expect(c.world.harnessUp).toBeUndefined(); // no drawn vehicle in range: nothing to pull
    expect(passes(behavior("harness_up"), c)).toBe(false);
    net(r.w, G.spawnVehicle(r.w, "cart", 5, 0, 0));
    r.a.bb.set("harnessScanAt", -1e9); // the first scan (no vehicle) cached null; re-scan now
    c = ctxOf(r); expect(c.world.harnessUp?.kind).toBe("equip"); expect(passes(behavior("harness_up"), c)).toBe(true);
    const log: string[] = []; drive(r, "harness_up", 60, () => G.isHarnessed(r.w, m), log);
    expect(G.isHarnessed(r.w, m)).toBe(true); expect(log).toContain(G.MountHarnessCmd.name);
    r.a.bb.set("harnessScanAt", -1e9); expect(ctxOf(r).world.harnessUp).toBeUndefined(); // already harnessed
  });
  it("crafts the harness at a base workbench when the materials are on hand", () => {
    const r = rig(); const m = net(r.w, G.makeMount(r.w, "animal_horse", 1, 0, r.p)); ensureClaim(r.w, r.p, 0, 0);
    net(r.w, G.spawnVehicle(r.w, "wagon_small", 5, 0, 0));
    const d = G.gameplayDefs(r.w); const sn = G.snapPlacement(r.w, { piece: d.pieceId("workbench"), x: -1.5, y: 0.5, level: 0, rot: 0, tier: 0, variant: 0 });
    if (typeof sn === "number") throw new Error(`snap ${sn}`); G.placePiece(r.w, r.p, sn, { pay: false }); steps(r.w, 1);
    for (const [it, n] of [["leather", 2], ["rope", 2], ["iron_ingot", 1]] as const) G.addItem(r.w, r.p, r.id(it), n);
    const c = ctxOf(r); expect(c.world.harnessUp).toMatchObject({ kind: "craft", here: true });
    const log: string[] = []; drive(r, "harness_up", 2, () => false, log); expect(log).toContain(G.QueueCraftCmd.name);
    steps(r.w, 20 * 8); expect(G.countItem(r.w, r.p, r.id("harness"))).toBe(1);
    r.a.bb.set("harnessScanAt", -1e9); r.a.bb.set("harnessAt", -1e9);
    drive(r, "harness_up", 60, () => G.isHarnessed(r.w, m));
    expect(G.isHarnessed(r.w, m)).toBe(true);
  });
});

describe("ADR-359 AI hitch_drawn / unhitch_drawn", () => {
  it("a bot with a harnessed mount hitches a wagon when its pack is full, and detaches it when the haul is done", () => {
    const r = rig(); const m = net(r.w, G.makeMount(r.w, "animal_horse", 1, 0, r.p));
    harnessIt(r.w, r.p, m);
    const v = net(r.w, G.spawnVehicle(r.w, "wagon_medium", 6, 0, 0)); // front hitch at 7.8; staging at 9.3
    fillPack(r);
    let c = ctxOf(r); expect(passes(behavior("hitch_drawn"), c)).toBe(true);
    const log: string[] = [];
    expect(drive(r, "hitch_drawn", 600, () => (r.w.getField(m, G.Hitch, "towNetId") ?? 0) !== 0, log)).toBeGreaterThanOrEqual(0);
    expect(r.w.getField(v, G.Hitch, "parentNetId")).toBe(r.w.getField(m, NetId, "id"));
    expect(log).toContain(G.VehicleHitchCmd.name);
    c = ctxOf(r); expect(c.world.mount?.towing).toBe(v); expect(passes(behavior("unhitch_drawn"), c)).toBe(false); // pack still full, not at goal
    emptyPack(r);
    c = ctxOf(r); expect(passes(behavior("unhitch_drawn"), c)).toBe(true);
    expect(drive(r, "unhitch_drawn", 120, () => (r.w.getField(m, G.Hitch, "towNetId") ?? 0) === 0, log)).toBeGreaterThanOrEqual(0);
    expect(r.w.getField(v, G.Hitch, "parentNetId")).toBe(0); expect(G.isHarnessed(r.w, m)).toBe(true); // detached, harness kept
    expect(log).toContain(G.VehicleUnhitchCmd.name);
  });
  it("a bot without a harness never hitches a drawn vehicle (sensor + server both refuse)", () => {
    const r = rig(); const m = net(r.w, G.makeMount(r.w, "animal_horse", 1, 0, r.p));
    net(r.w, G.spawnVehicle(r.w, "wagon_medium", 6, 0, 0)); fillPack(r);
    const c = ctxOf(r); expect(c.world.mount?.harness).toBe(false); expect(passes(behavior("hitch_drawn"), c)).toBe(false);
    expect(G.validateHitch(r.w, r.p, net(r.w, G.spawnVehicle(r.w, "cart", 2, 0, 0)), m)).toBe("no_harness");
  });
});
