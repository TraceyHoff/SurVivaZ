import { describe, expect, it } from "vitest";
import { idleOutput, installPermissions, NetId, PlayerId, Transform, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { DT, makeWorld, spawnLearned } from "./helpers.js";

let nid = 1200;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };
const pid = (w: World, e: Entity, id: number): Entity => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); return e; };
function setup(): { w: World; p: Entity; id: (k: string) => number } {
  const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }); pid(w, p, 7); net(w, p);
  // vehicle_state.test.ts precedent: a fresh player has no AnimState (added lazily by gather/consume/stance),
  // so the Sit/Idle assertions add it, as a player who has acted in the world already carries it.
  w.add(p, G.AnimState, { anim: G.Anim.Idle, startTick: 0 });
  return { w, p, id: (k) => G.gameplayDefs(w).itemId(k) };
}
/** Horse at (1, 0) facing east; its rear pin sits at (-0.5, 0). Harnessed, so it may tow. */
const horse = (w: World, p: Entity): Entity => {
  const m = net(w, G.makeMount(w, "animal_horse", 1, 0, p));
  const hid = G.gameplayDefs(w).itemId("harness"); G.addItem(w, p, hid, 1);
  const v = G.readSlots(w, p); let slot = -1; for (let i = 0; i < v.slotCount; i++) if (v.item(i) === hid) { slot = i; break; }
  if (slot < 0 || !G.harnessMount(w, p, m, slot)) throw new Error("ADR-360 setup: harnessing the horse failed");
  return m;
};
/** A drawn vehicle whose front hitch sits exactly on the horse's rear pin. */
const atPin = (w: World, id: string): Entity => {
  const d = G.VEHICLE_DEFS.find((x) => x.id === id)!; const front = d.hitches.find((h) => h.at === "front")!.offset;
  return net(w, G.spawnVehicle(w, id, -0.5 - front, 0, 0));
};
const pinGap = (w: World, m: Entity, v: Entity): number => {
  const d = G.vehicleDefOf(w, v)!; const t = w.get(v, Transform)!;
  const front = G.hitchPoint(d, "front", t.x, t.y, w.getField(v, G.Vehicle, "heading")!)!; const pin = G.mountRearPin(w, m)!;
  return Math.hypot(pin.x - front.x, pin.y - front.y);
};
/** Drive input for `n` ticks through the production funnel (applyMovementInput + step). */
const driveFor = (w: World, p: Entity, actions: number, n: number): void => { for (let i = 0; i < n; i++) { G.applyMovementInput(w, p, actions, DT); w.step(DT); } };
const moved = (w: World, e: Entity, from: { x: number; y: number }): number => { const t = w.get(e, Transform)!; return Math.hypot(t.x - from.x, t.y - from.y); };
/** A hitched rig: harnessed horse + wagon_medium on its pin, nobody seated yet. */
const rig = (w: World, p: Entity): { m: Entity; v: Entity } => {
  const m = horse(w, p); const v = atPin(w, "wagon_medium");
  if (G.hitchVehicles(w, p, v, m) !== undefined) throw new Error("ADR-360 setup: hitching failed");
  return { m, v };
};
const extraPlayer = (w: World, x: number, y: number, clientId: number): Entity => {
  const q = spawnLearned(w, { x, y, maxWeight: 0, clientId }); pid(w, q, clientId); net(w, q);
  w.add(q, G.AnimState, { anim: G.Anim.Idle, startTick: 0 }); return q;
};

describe("ADR-360 driver seat pose", () => {
  it("seat-0 driver sits at the def's seat-0 anchor facing the vehicle heading, all 8 directions", () => {
    // Sim side: the rider is snapped to the vehicle centre facing its heading with the Sit anim (vehicleSystem);
    // the seat anchor is where the client puts the rider (render test below). The anchor itself is data, pinned here.
    const anchors: Record<string, readonly [number, number, number]> = {
      wagon_small: [1.0, 0.35, 0.3], wagon_medium: [1.4, 0.4, 0.3], wagon_large: [1.8, 0.45, 0.3],
      cart: [0.5, 0.3, 0.3], carriage: [1.2, 0.35, 0.35], chariot: [0.3, 0.3, 0.3],
    };
    for (const [id, a] of Object.entries(anchors)) {
      const d = G.VEHICLE_DEFS.find((x) => x.id === id)!;
      expect(d.seatAnchors[0]).toEqual({ x: a[0], y: a[1], z: a[2] });
      expect(d.seatAnchors[0]!.x).toBeGreaterThan(0); // front bench / box
      expect(Math.max(...d.seatAnchors.map((s) => s.x)) - d.seatAnchors[0]!.x).toBeLessThanOrEqual(0.01 + 1e-9); // seat 0 foremost
      for (let dir = 0; dir < 8; dir++) {
        const heading = dir * Math.PI / 4;
        const { w, p } = setup();
        const v = net(w, G.spawnVehicle(w, id, 0, 0, heading));
        expect(G.enterVehicle(w, p, v, 0)).toBeUndefined();
        w.step(DT);
        expect(w.getField(p, G.Driver, "seat")).toBe(0);
        const t = w.get(p, Transform)!;
        expect(t.x).toBeCloseTo(0); expect(t.y).toBeCloseTo(0); expect(t.facing).toBeCloseTo(heading);
        expect(w.getField(p, G.AnimState, "anim")).toBe(G.Anim.Sit);
      }
    }
  });
  it("passengers sit at their own anchors too (carriage, 4 seats)", () => {
    const { w, p } = setup();
    const v = net(w, G.spawnVehicle(w, "carriage", 0, 0, Math.PI / 2));
    const riders = [p, extraPlayer(w, 0, 1, 8), extraPlayer(w, 0, -1, 9), extraPlayer(w, 1, 0, 10)];
    riders.forEach((r, i) => expect(G.enterVehicle(w, r, v, i)).toBeUndefined());
    w.step(DT);
    const d = G.VEHICLE_DEFS.find((x) => x.id === "carriage")!;
    expect(d.seatAnchors).toEqual([
      { x: 1.2, y: 0.35, z: 0.35 }, { x: 1.2, y: -0.35, z: 0.35 }, { x: -0.4, y: 0.35, z: 0.3 }, { x: -0.4, y: -0.35, z: 0.3 },
    ]);
    for (const [i, r] of riders.entries()) {
      expect(w.getField(r, G.Driver, "seat")).toBe(i);
      expect(w.getField(r, G.AnimState, "anim")).toBe(G.Anim.Sit);
      const t = w.get(r, Transform)!;
      expect(t.x).toBeCloseTo(0); expect(t.y).toBeCloseTo(0); expect(t.facing).toBeCloseTo(Math.PI / 2);
    }
  });
});

describe("ADR-360 driver steers the mount", () => {
  it("the seat-0 driver steers the mount; the wagon follows on the pin joint at the drawn cap", () => {
    const { w, p } = setup(); const { m, v } = rig(w, p);
    expect(G.drawnDriven(w, m)).toBe(false); // nobody in the driver seat yet
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined();
    expect(G.drawnDriven(w, m)).toBe(true);
    const vt0 = { ...w.get(v, Transform)! }; const mt0 = { ...w.get(m, Transform)! };
    driveFor(w, p, G.GameplayActions.MoveRight | G.GameplayActions.Sprint, 100);
    expect(pinGap(w, m, v)).toBeLessThan(1e-3); // front hitch still exactly on the mount's rear pin
    expect(moved(w, v, vt0)).toBeGreaterThan(20); expect(moved(w, v, vt0)).toBeLessThan(28); // ~5.5 tiles/s x 5 s minus the ramp
    expect(moved(w, m, mt0)).toBeGreaterThan(20); // the mount itself moved, not just the wagon
    expect(w.get(v, G.Vehicle)!.speed).toBeCloseTo(5.5, 1); // capped: galloping horse, wagon x0.62
    expect(w.getField(m, G.AnimState, "anim")).toBe(G.Anim.Walk); // the load slows the horse below its run threshold (same rule as a ridden mount)
  });
  it("a chariot driver gallops at the horse's full speed; a walking driver pulls the wagon slowly", () => {
    const { w, p } = setup(); const m = horse(w, p); const c = atPin(w, "chariot");
    expect(G.hitchVehicles(w, p, c, m)).toBeUndefined(); expect(G.enterVehicle(w, p, c, 0)).toBeUndefined();
    const ct0 = { ...w.get(c, Transform)! };
    driveFor(w, p, G.GameplayActions.MoveRight | G.GameplayActions.Sprint, 100);
    expect(pinGap(w, m, c)).toBeLessThan(1e-3);
    expect(moved(w, c, ct0)).toBeGreaterThan(35); // light chariot: the horse runs at its full gallop, ~9.6 tiles/s
    expect(w.get(c, G.Vehicle)!.speed).toBeCloseTo(9.6, 1); // cap 11.5 exceeds the horse's gallop, so the mount is not slowed at all
    expect(w.getField(m, G.AnimState, "anim")).toBe(G.Anim.Run); // unslowed, the horse runs
    const { w: w2, p: p2 } = setup(); const { v: v2 } = rig(w2, p2);
    expect(G.enterVehicle(w2, p2, v2, 0)).toBeUndefined();
    const vt0 = { ...w2.get(v2, Transform)! };
    driveFor(w2, p2, G.GameplayActions.MoveRight, 40);
    expect(moved(w2, v2, vt0)).toBeGreaterThan(5); // walking horse, wagon x0.62 -> ~3.35 tiles/s
    expect(w2.get(v2, G.Vehicle)!.speed).toBeCloseTo(5.4 * 0.62, 1); // the mount itself is slowed by the load
  });
  it("a passenger's input moves nothing; the driver's does", () => {
    const { w, p } = setup(); const { m, v } = rig(w, p);
    const q = extraPlayer(w, -2, 0, 8);
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined(); expect(G.enterVehicle(w, q, v, 1)).toBeUndefined();
    const vt0 = { ...w.get(v, Transform)! };
    driveFor(w, q, G.GameplayActions.MoveRight | G.GameplayActions.Sprint, 20); // the passenger pushes east for a second
    expect(moved(w, v, vt0)).toBeLessThan(1e-3); expect(w.get(v, G.Vehicle)!.speed).toBeLessThan(1e-3); // f32 pose rounding only, no drive
    driveFor(w, p, G.GameplayActions.MoveRight | G.GameplayActions.Sprint, 40); // the driver pushes east
    expect(moved(w, v, vt0)).toBeGreaterThan(5); expect(pinGap(w, m, v)).toBeLessThan(1e-3);
  });
  it("an unhitched wagon with a driver and drive input stays put", () => {
    const { w, p } = setup(); const v = net(w, G.spawnVehicle(w, "wagon_small", 0, 0, 0));
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined();
    driveFor(w, p, G.GameplayActions.MoveRight | G.GameplayActions.Sprint, 20);
    expect(w.get(v, Transform)!.x).toBe(0); expect(w.get(v, Transform)!.y).toBe(0);
    expect(w.get(v, G.Vehicle)!.speed).toBe(0);
  });
  it("rider vs driver: the mount's own rider steers, the wagon driver's input is dropped", () => {
    const { w, p } = setup(); const { m, v } = rig(w, p);
    const q = extraPlayer(w, -2, 0, 8);
    expect(G.enterVehicle(w, q, v, 0)).toBeUndefined(); // q is the wagon driver
    expect(G.rideMount(w, p, m)).toBe(true); // p rides the mount itself
    for (let i = 0; i < 40; i++) { // the driver pushes east, the rider pushes west, same ticks
      G.applyMovementInput(w, q, G.GameplayActions.MoveRight, DT);
      G.applyMovementInput(w, p, G.GameplayActions.MoveLeft, DT);
      w.step(DT);
    }
    expect(w.get(m, Transform)!.x).toBeLessThan(0); // west: the rider won
    expect(w.get(v, Transform)!.x).toBeLessThan(0); // the wagon followed the mount west, not the driver east
    expect(pinGap(w, m, v)).toBeLessThan(1e-3);
  });
  it("the animal AI does not fight the driver (its goal points west, the driver steers east)", () => {
    const { w, p } = setup(); const { m, v } = rig(w, p);
    w.setField(m, G.Animal, "state", G.AnimalState.Wander);
    w.setField(m, G.Animal, "goalX", -30); w.setField(m, G.Animal, "goalY", 0);
    w.setField(m, G.Animal, "thinkAt", w.tick + 100000); // keep the west goal for the whole drive
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined();
    driveFor(w, p, G.GameplayActions.MoveRight | G.GameplayActions.Sprint, 100);
    expect(w.get(m, Transform)!.x).toBeGreaterThan(15); // east, at gallop — the AI never pulled it west
    expect(pinGap(w, m, v)).toBeLessThan(1e-3);
  });
});

describe("ADR-360 enter / exit coherence", () => {
  it("exiting restores Idle, frees the seat, places the driver beside the wagon, hitch + harness intact", () => {
    const { w, p } = setup(); const { m, v } = rig(w, p);
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined(); w.step(DT);
    expect(w.getField(p, G.AnimState, "anim")).toBe(G.Anim.Sit);
    expect(G.exitVehicle(w, p)).toBeUndefined();
    expect(w.has(p, G.Driver)).toBe(false);
    expect(w.getField(p, G.AnimState, "anim")).toBe(G.Anim.Idle);
    const t = w.get(p, Transform)!;
    expect(t.x).toBeCloseTo(w.get(v, Transform)!.x); // left side, heading east: same x, +y
    expect(t.y).toBeCloseTo(w.get(v, Transform)!.y + 1.6 / 2 + 0.6);
    expect(G.drawnDriven(w, m)).toBe(false);
    expect(w.getField(v, G.Hitch, "parentNetId")).toBe(w.getField(m, NetId, "id")); // still hitched
    expect(w.getField(m, G.Hitch, "towNetId")).toBe(w.getField(v, NetId, "id"));
    expect(G.isHarnessed(w, m)).toBe(true);
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined(); // and the seat takes a driver again
  });
  it("dismounting the mount while it tows leaves the wagon hitched; the seated driver can then steer", () => {
    const { w, p } = setup(); const m = horse(w, p); const v = atPin(w, "wagon_medium");
    expect(G.rideMount(w, p, m)).toBe(true); expect(G.hitchVehicles(w, p, v, m)).toBeUndefined();
    expect(G.dismount(w, p)).toBe(true);
    expect(w.has(p, G.Riding)).toBe(false);
    expect(w.getField(v, G.Hitch, "parentNetId")).toBe(w.getField(m, NetId, "id")); // the tow survives the dismount
    expect(w.getField(m, G.Hitch, "towNetId")).toBe(w.getField(v, NetId, "id"));
    // the dismount spot (beside the mount) is just outside the wagon's enter reach — walk up to the bench first
    for (let i = 0; i < 20 && G.validateEnter(w, p, v, 0) === "too_far"; i++) { G.applyMovementInput(w, p, G.GameplayActions.MoveLeft, DT); w.step(DT); }
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined();
    const vt0 = { ...w.get(v, Transform)! };
    driveFor(w, p, G.GameplayActions.MoveRight | G.GameplayActions.Sprint, 40);
    expect(moved(w, v, vt0)).toBeGreaterThan(5); expect(pinGap(w, m, v)).toBeLessThan(1e-3);
  });
  it("exiting the wagon while hitched leaves the hitch; re-entering drives again from a standing start", () => {
    const { w, p } = setup(); const { m, v } = rig(w, p);
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined();
    driveFor(w, p, G.GameplayActions.MoveRight | G.GameplayActions.Sprint, 40);
    const vx = w.get(v, Transform)!.x; expect(vx).toBeGreaterThan(5);
    expect(G.exitVehicle(w, p)).toBeUndefined();
    for (let i = 0; i < 20; i++) w.step(DT); // the mount coasts to a stop; the wagon does not roll away
    expect(w.get(v, G.Vehicle)!.speed).toBeLessThan(1e-3); // f32 residual only
    expect(w.getField(v, G.Hitch, "parentNetId")).toBe(w.getField(m, NetId, "id"));
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined();
    const vt0 = { ...w.get(v, Transform)! };
    driveFor(w, p, G.GameplayActions.MoveRight | G.GameplayActions.Sprint, 40);
    expect(moved(w, v, vt0)).toBeGreaterThan(5); // the driven speed ramped up from 0, not from a stale value
  });
  it("a wrecked wagon refuses entry, keeps its driver seated, and the mount still pulls", () => {
    const { w, p } = setup(); const { m, v } = rig(w, p);
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined();
    const q = extraPlayer(w, -2, 0, 8);
    w.setField(v, G.Vehicle, "health", 0); w.step(DT);
    expect(w.has(p, G.Driver)).toBe(true); // no eject-on-wreck: the driver stays seated (motor rule)
    expect(w.getField(p, G.AnimState, "anim")).toBe(G.Anim.Sit);
    expect(G.enterVehicle(w, q, v, 1)).toBe("wrecked"); // nobody else gets in
    const vt0 = { ...w.get(v, Transform)! };
    driveFor(w, p, G.GameplayActions.MoveRight | G.GameplayActions.Sprint, 40);
    expect(moved(w, v, vt0)).toBeGreaterThan(5); // the mount still pulls the wreck, like a motor trailer
    expect(pinGap(w, m, v)).toBeLessThan(1e-3);
  });
});

// ---- AI driver (ADR-359 rig, extended: the bot's apply must handle VehicleEnter/Exit) -------------------
type Rig = { w: World; p: Entity; a: Agent; id: (k: string) => number; home: { x: number; y: number } };
function aiRig(opts: { learned?: boolean; x?: number; y?: number; pid?: number; seed?: number } = {}): Rig {
  const w = makeWorld({}, opts.seed ?? 42); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const x = opts.x ?? 0, y = opts.y ?? 0;
  const p = opts.learned === false ? G.spawnPlayer(w, { x, y, maxWeight: 0, clientId: 7 }) : spawnLearned(w, { x, y, maxWeight: 0, clientId: 7 });
  pid(w, p, opts.pid ?? 7); net(w, p);
  w.add(p, G.AnimState, { anim: G.Anim.Idle, startTick: 0 }); // as in setup(): the Sit/Idle cycle needs it
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
/** Apply the bot's mount / vehicle commands the way the server handlers do, plus its movement. */
function apply(r: Rig, o: AgentOutput & { commands?: G.AgentCommand[] }, log: string[]): void {
  const { w, p } = r; for (const a of o.actions) if (a.startsWith("equip:")) { const s = Number(a.slice(6)); w.set(p, G.Equipment, { mainHandSlot: s, mainHandItem: G.readSlots(w, p).item(s) }); log.push(a); }
  G.emitAgentCommands(o);
  for (const c of o.commands ?? []) {
    const v = c.payload as { target: number; tow: number; item: number; slot: number; recipe: number; seat: number }; const t = v.target as Entity; log.push(c.type);
    if (c.type === G.MountFeedCmd.name) { if (!G.checkFeed(w, p, t, v.item)) G.feedMount(w, p, t, v.item); }
    else if (c.type === G.MountRideCmd.name) G.rideMount(w, p, t);
    else if (c.type === G.MountDismountCmd.name) G.dismount(w, p);
    else if (c.type === G.MountSaddleCmd.name) G.saddleMount(w, p, t, v.slot);
    else if (c.type === G.MountHarnessCmd.name) G.harnessMount(w, p, t, v.slot);
    else if (c.type === G.MountUnharnessCmd.name) G.unharnessMount(w, p, t);
    else if (c.type === G.MountRepairCmd.name) G.repairSaddle(w, p, t);
    else if (c.type === G.VehicleHitchCmd.name) G.hitchVehicles(w, p, t, v.tow as Entity);
    else if (c.type === G.VehicleUnhitchCmd.name) G.unhitchVehicle(w, p, t);
    else if (c.type === G.VehicleEnterCmd.name) G.enterVehicle(w, p, t, v.seat ?? 255);
    else if (c.type === G.VehicleExitCmd.name) G.exitVehicle(w, p);
    else if (c.type === G.QueueCraftCmd.name) G.enqueueCraft(w, p, v.recipe, 1);
  }
  let bits = 0; const len = Math.hypot(o.moveX, o.moveY);
  if (len > 1e-6) { if (o.moveX > 0.38 * len) bits |= G.GameplayActions.MoveRight; else if (o.moveX < -0.38 * len) bits |= G.GameplayActions.MoveLeft; if (o.moveY > 0.38 * len) bits |= G.GameplayActions.MoveDown; else if (o.moveY < -0.38 * len) bits |= G.GameplayActions.MoveUp; }
  // Analog steering, like a production bot (bot_input): the bits alone quantise to 8 iso diagonals, which cannot
  // ride a mount onto a 1.5-tile pin.
  G.applyMovementInput(w, p, bits, DT, { x: o.moveX, y: o.moveY });
}
/** Run one behaviour (+ the ADR-321 mount policy) for up to n ticks, with the drive goal pinned each tick. */
function driveGoal(r: Rig, name: string, n: number, goal: { x: number; y: number }, until: () => boolean, log: string[] = []): number {
  const b = behavior(name);
  for (let i = 0; i < n; i++) {
    const c = ctxOf(r); c.world.driveGoal = goal; const o = out(); b.run(c, o); G.mountPolicy(c, o, name); apply(r, o, log); r.w.step(DT);
    if (until()) return i;
  }
  return -1;
}
const harnessIt = (w: World, p: Entity, m: Entity): void => {
  const hid = G.gameplayDefs(w).itemId("harness"); G.addItem(w, p, hid, 1);
  const v = G.readSlots(w, p); let slot = -1; for (let i = 0; i < v.slotCount; i++) if (v.item(i) === hid) { slot = i; break; }
  if (slot < 0 || !G.harnessMount(w, p, m, slot)) throw new Error("setup: harnessing failed");
};

describe("ADR-360 AI drives drawn vehicles", () => {
  it("the survivor registry carries drive_drawn; pickRide never picks a drawn vehicle", () => {
    const names = G.survivorRegistry().list().map((b) => b.name);
    expect(names).toContain("drive_drawn");
    const r = aiRig(); net(r.w, G.spawnVehicle(r.w, "wagon_medium", 5, 0, 0));
    const c = ctxOf(r);
    expect(G.pickRide(c.world)).toBeUndefined(); // the only vehicle near is drawn
    expect(passes(behavior("drive"), c)).toBe(false); // motor driving does not fire for a wagon
    expect(passes(behavior("drive_drawn"), c)).toBe(false); // and drive_drawn needs a towed wagon, not just one nearby
  });
  it("a riding bot gets off its mount for drive_drawn (mount policy)", () => {
    const r = aiRig(); const m = net(r.w, G.makeMount(r.w, "animal_horse", 1, 0, r.p));
    harnessIt(r.w, r.p, m);
    const v = atPin(r.w, "wagon_medium"); // front hitch on the pin: a direct hitch is in range
    expect(G.hitchVehicles(r.w, r.p, v, m)).toBeUndefined();
    expect(G.rideMount(r.w, r.p, m)).toBe(true);
    const c = ctxOf(r); c.world.driveGoal = { x: 30, y: 0 };
    expect(passes(behavior("drive_drawn"), c)).toBe(true);
    const o = out(); G.mountPolicy(c, o, "drive_drawn");
    expect(o.actions).toContain("mdismount"); // off the mount, so it can climb into the wagon
  });
  it("a bot drives its hitched wagon to the goal, arrives, and gets out", () => {
    const r = aiRig(); const m = net(r.w, G.makeMount(r.w, "animal_horse", 1, 0, r.p));
    harnessIt(r.w, r.p, m);
    const v = atPin(r.w, "wagon_medium"); // front hitch on the pin: a direct hitch is in range
    expect(G.hitchVehicles(r.w, r.p, v, m)).toBeUndefined();
    const log: string[] = [];
    const goal = { x: 30, y: 0 };
    const ticks = driveGoal(r, "drive_drawn", 600, goal,
      () => !r.w.has(r.p, G.Driver) && r.w.get(v, Transform)!.x > 20, log);
    expect(ticks).toBeGreaterThanOrEqual(0); // entered, drove, arrived, exited within 30 s
    expect(log).toContain(G.VehicleEnterCmd.name); expect(log).toContain(G.VehicleExitCmd.name);
    const vx = r.w.get(v, Transform)!.x;
    expect(vx).toBeGreaterThan(20); expect(vx).toBeLessThan(goal.x + 6); // arrived in the neighbourhood (coast past the goal is one arrival radius at most)
    expect(r.w.getField(v, G.Hitch, "parentNetId")).toBe(r.w.getField(m, NetId, "id")); // still hitched at the goal
    expect(r.w.has(r.p, G.Driver)).toBe(false);
    expect(r.w.getField(r.p, G.AnimState, "anim")).toBe(G.Anim.Idle);
  });
});

describe("ADR-360 schema", () => {
  it("no new component: the world schema hash is unchanged from ADR-359", () => {
    expect(makeWorld().getSchemaHash()).toBe(0x35deea19); // ADR-398: +3 roof pieces in the id lock salt (no new component)
  });
  it("the drawn drive speed is sim-local: a resource, cleared on exit, never a component", () => {
    const { w, p } = setup(); const { m, v } = rig(w, p);
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined();
    driveFor(w, p, G.GameplayActions.MoveRight | G.GameplayActions.Sprint, 20);
    const speeds = w.getResource(G.DrawnDriveSpeeds)!;
    expect(speeds.get(m)).toBeGreaterThan(0);
    expect(G.GAMEPLAY_COMPONENTS).not.toContain(G.DrawnDriveSpeeds); // resources are not replicated or persisted
    expect(G.exitVehicle(w, p)).toBeUndefined();
    expect(speeds.get(m)).toBeUndefined(); // the next drive ramps up from 0
  });
});
