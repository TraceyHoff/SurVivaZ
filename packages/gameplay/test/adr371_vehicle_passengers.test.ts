import { describe, expect, it } from "vitest";
import { idleOutput, installPermissions, NetId, PlayerId, Transform, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { DT, makeWorld, spawnLearned } from "./helpers.js";
import { world215 } from "./nav215_fixture.js";

let nid = 4200;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };
const pid = (w: World, e: Entity, id: number): Entity => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); return e; };
function setup(): { w: World; p: Entity; id: (k: string) => number } {
  const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }); pid(w, p, 7); net(w, p);
  w.add(p, G.AnimState, { anim: G.Anim.Idle, startTick: 0 });
  return { w, p, id: (k) => G.gameplayDefs(w).itemId(k) };
}
const extraPlayer = (w: World, x: number, y: number, clientId: number): Entity => {
  const q = spawnLearned(w, { x, y, maxWeight: 0, clientId }); pid(w, q, clientId); net(w, q);
  w.add(q, G.AnimState, { anim: G.Anim.Idle, startTick: 0 }); return q;
};
/** Horse at (1, 0) facing east; its rear pin sits at (-0.5, 0). Harnessed, so it may tow. */
const horse = (w: World, p: Entity): Entity => {
  const m = net(w, G.makeMount(w, "animal_horse", 1, 0, p));
  const hid = G.gameplayDefs(w).itemId("harness"); G.addItem(w, p, hid, 1);
  const v = G.readSlots(w, p); let slot = -1; for (let i = 0; i < v.slotCount; i++) if (v.item(i) === hid) { slot = i; break; }
  if (slot < 0 || !G.harnessMount(w, p, m, slot)) throw new Error("ADR-371 setup: harnessing the horse failed");
  return m;
};
/** A drawn vehicle whose front hitch sits exactly on the horse's rear pin. */
const atPin = (w: World, id: string): Entity => {
  const d = G.VEHICLE_DEFS.find((x) => x.id === id)!; const front = d.hitches.find((h) => h.at === "front")!.offset;
  return net(w, G.spawnVehicle(w, id, -0.5 - front, 0, 0));
};
/** A hitched rig: harnessed horse + wagon_medium on its pin, nobody seated yet. */
const rig = (w: World, p: Entity): { m: Entity; v: Entity } => {
  const m = horse(w, p); const v = atPin(w, "wagon_medium");
  if (G.hitchVehicles(w, p, v, m) !== undefined) throw new Error("ADR-371 setup: hitching failed");
  return { m, v };
};
/** Drive input for `n` ticks through the production funnel (applyMovementInput + step). */
const driveFor = (w: World, p: Entity, actions: number, n: number): void => { for (let i = 0; i < n; i++) { G.applyMovementInput(w, p, actions, DT); w.step(DT); } };
const pos = (w: World, e: Entity): { x: number; y: number } => { const t = w.get(e, Transform)!; return { x: t.x, y: t.y }; };
/** The legacy left-side exit point for a vehicle pose (width/2 + 0.6, ADR-360 spot). */
const legacyPoint = (w: World, v: Entity): { x: number; y: number } => {
  const d = G.vehicleDefOf(w, v)!; const t = w.get(v, Transform)!; const h = w.getField(v, G.Vehicle, "heading")!;
  const side = d.footprint.width / 2 + 0.6;
  return { x: t.x - Math.sin(h) * side, y: t.y + Math.cos(h) * side };
};

describe("ADR-371 passenger boarding", () => {
  it("seat 254 boards the first free passenger seat and never the driver seat", () => {
    const { w, p } = setup(); const v = net(w, G.spawnVehicle(w, "wagon_medium", 0, 0, 0));
    const q = extraPlayer(w, 0, 1, 8); const r = extraPlayer(w, 0, -1, 9);
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined(); // driver
    expect(G.enterVehicleAsPassenger(w, q, v)).toBeUndefined();
    expect(w.getField(q, G.Driver, "seat")).toBe(1);
    expect(G.enterVehicle(w, r, v, G.PASSENGER_SEAT)).toBe("full"); // wagon has 2 seats, both taken
    expect(G.enterVehicle(w, r, v, 255)).toBe("full");
    expect(w.has(r, G.Driver)).toBe(false);
  });
  it("a key-holder boarding with 254 still gets a passenger seat, not the free driver seat", () => {
    const w = makeWorld(); const owner = net(w, G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }));
    const d = G.defaultDefs(); const id = (k: string) => d.itemId(k);
    const slotOf = (ww: World, pp: Entity, item: number): number => { const s = G.readSlots(ww, pp); for (let i = 0; i < s.slotCount; i++) if (s.item(i) === item && s.count(i)) return i; return -1; };
    G.addItem(w, owner, id("vehicle_kit_car_sedan"), 1, 77);
    const v = G.deployVehicleKit(w, owner, slotOf(w, owner, id("vehicle_kit_car_sedan")), 2, 0) as Entity; net(w, v);
    expect(G.hasKeyFor(w, owner, v)).toBe(true); // the crafter holds the key: 255 would take the driver seat
    expect(G.enterVehicle(w, owner, v, 254)).toBeUndefined();
    expect(w.getField(owner, G.Driver, "seat")).toBe(1); // passenger, even with the key in hand
    expect(G.enterVehicle(w, owner, v, 255)).toBe("already_riding");
  });
  it("seat 254 on a single-seat vehicle reports no_passenger_seats", () => {
    const { w, p } = setup(); const bike = net(w, G.spawnVehicle(w, "bike_basic", 0, 0, 0));
    expect(G.enterVehicle(w, p, bike, 254)).toBe("no_passenger_seats");
    expect(w.has(p, G.Driver)).toBe(false);
    expect(G.firstFreePassengerSeat(w, bike)).toBeUndefined();
  });
  it("firstFreePassengerSeat / vehicleHasDriver track the seats (carriage, 4 seats)", () => {
    const { w, p } = setup(); const v = net(w, G.spawnVehicle(w, "carriage", 0, 0, 0));
    expect(G.vehicleHasDriver(w, v)).toBe(false); expect(G.firstFreePassengerSeat(w, v)).toBe(1);
    const q = extraPlayer(w, 0, 1, 8); const r = extraPlayer(w, 0, -1, 9);
    expect(G.enterVehicle(w, q, v, 254)).toBeUndefined(); expect(w.getField(q, G.Driver, "seat")).toBe(1);
    expect(G.firstFreePassengerSeat(w, v)).toBe(2);
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined(); expect(G.vehicleHasDriver(w, v)).toBe(true);
    expect(G.enterVehicle(w, r, v, 254)).toBeUndefined(); expect(w.getField(r, G.Driver, "seat")).toBe(2);
    expect(G.firstFreePassengerSeat(w, v)).toBe(3);
  });
  it("chariot shares the passenger path (2 seats, drawn)", () => {
    const { w, p } = setup(); const v = net(w, G.spawnVehicle(w, "chariot", 0, 0, 0));
    const q = extraPlayer(w, 0, 1, 8);
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined(); expect(G.enterVehicle(w, q, v, 254)).toBeUndefined();
    expect(w.getField(q, G.Driver, "seat")).toBe(1); expect(G.isDrawnDef(G.vehicleDefOf(w, v)!)).toBe(true);
  });
});

describe("ADR-371 passenger follow + dismount", () => {
  it("a passenger follows the wagon while it moves and sits (no independent movement)", () => {
    const { w, p } = setup(); const { v } = rig(w, p);
    const q = extraPlayer(w, -2, 0, 8);
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined(); expect(G.enterVehicle(w, q, v, 1)).toBeUndefined();
    driveFor(w, p, G.GameplayActions.MoveRight | G.GameplayActions.Sprint, 40);
    expect(w.get(v, Transform)!.x).toBeGreaterThan(5); // the wagon rolled east
    const vt = w.get(v, Transform)!; const qt = w.get(q, Transform)!;
    expect(qt.x).toBeCloseTo(vt.x); expect(qt.y).toBeCloseTo(vt.y); expect(qt.facing).toBeCloseTo(vt.facing);
    expect(w.getField(q, G.AnimState, "anim")).toBe(G.Anim.Sit);
    expect(w.getField(q, G.Driver, "seat")).toBe(1);
  });
  it("a passenger's input moves nothing while the driver steers", () => {
    const { w, p } = setup(); const { v } = rig(w, p);
    const q = extraPlayer(w, -2, 0, 8);
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined(); expect(G.enterVehicle(w, q, v, 1)).toBeUndefined();
    const vt0 = { ...w.get(v, Transform)! };
    driveFor(w, q, G.GameplayActions.MoveRight | G.GameplayActions.Sprint, 20); // the passenger pushes east
    expect(Math.hypot(w.get(v, Transform)!.x - vt0.x, w.get(v, Transform)!.y - vt0.y)).toBeLessThan(1e-3);
  });
  it("dismount lands on the legacy left-side spot on open ground and frees the seat", () => {
    const { w, p } = setup(); const { v } = rig(w, p);
    const q = extraPlayer(w, -2, 0, 8);
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined(); expect(G.enterVehicle(w, q, v, 1)).toBeUndefined();
    w.step(DT);
    const want = legacyPoint(w, v);
    expect(G.exitVehicle(w, q)).toBeUndefined();
    expect(w.has(q, G.Driver)).toBe(false);
    expect(w.getField(q, G.AnimState, "anim")).toBe(G.Anim.Idle);
    expect(pos(w, q).x).toBeCloseTo(want.x); expect(pos(w, q).y).toBeCloseTo(want.y);
    expect(G.firstFreePassengerSeat(w, v)).toBe(1); // the seat is free again
    expect(G.vehicleHasDriver(w, v)).toBe(true); // the driver is unaffected
  });
  it("a blocked legacy spot falls back to another tile (lake shore: deep water refused, shallow taken)", () => {
    const { w, p } = setup(); const v = net(w, G.spawnVehicle(w, "wagon_medium", 0, 0, 0));
    // Water (tile 1) everywhere south of y = -1; land (tile 3) north of it. The legacy spot (0, +1.4) is
    // deep water (no land within the shallow radius); the near-side ring tiles are shallow / land.
    w.setResource(G.TerrainRes, { tileAt: (_tx: number, ty: number) => (ty >= -1 ? 1 : 3), heightAt: () => 0 });
    const q = extraPlayer(w, 0, 1, 8);
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined(); expect(G.enterVehicle(w, q, v, 1)).toBeUndefined();
    const legacy = legacyPoint(w, v);
    expect(G.waterDepth(w, legacy.x, legacy.y)).toBe(2); // Deep
    expect(G.exitVehicle(w, q)).toBeUndefined();
    const qp = pos(w, q);
    expect(Math.hypot(qp.x - legacy.x, qp.y - legacy.y)).toBeGreaterThan(0.5); // not the refused spot
    expect(G.waterDepth(w, qp.x, qp.y)).not.toBe(2); // land or shallow — never deep when a wadeable tile exists
    expect(qp.y).toBeLessThan(1); // the wadeable side (tiles ty <= 0 are shallow; ty >= 1 is deep here)
    const d = G.vehicleDefOf(w, v)!; const vt = w.get(v, Transform)!;
    const lx = qp.x - vt.x, ly = qp.y - vt.y;
    expect(Math.abs(lx) > d.footprint.length / 2 + 0.3 || Math.abs(ly) > d.footprint.width / 2 + 0.3).toBe(true); // outside the footprint
  });
  it("deep water is the last resort when nothing wadeable exists (all-water world)", () => {
    const { w, p } = setup(); const v = net(w, G.spawnVehicle(w, "wagon_medium", 0, 0, 0));
    w.setResource(G.TerrainRes, { tileAt: () => 1, heightAt: () => 0 });
    const q = extraPlayer(w, 0, 1, 8);
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined(); expect(G.enterVehicle(w, q, v, 1)).toBeUndefined();
    expect(G.exitVehicle(w, q)).toBeUndefined(); // a ground-level rider can swim out
    expect(G.waterDepth(w, pos(w, q).x, pos(w, q).y)).toBe(2);
    expect(w.has(q, G.Driver)).toBe(false);
  });
  it("findSafeDismountTile reports undefined when the only candidate is unsafe (radius 0, deep water)", () => {
    const { w, p } = setup(); const v = net(w, G.spawnVehicle(w, "wagon_medium", 0, 0, 0));
    w.setResource(G.TerrainRes, { tileAt: () => 1, heightAt: () => 0 });
    const legacy = legacyPoint(w, v);
    expect(G.waterDepth(w, legacy.x, legacy.y)).toBe(2);
    expect(G.findSafeDismountTile(w, p, 0, 0, 0, 1.8, 0.8, 0, 0)).toBeUndefined();
  });
  it("no safe tile anywhere in range: exit refuses and the rider stays seated (walled-in wagon)", () => {
    const { w, put } = world215();
    if (!w.isRegistered(PlayerId)) w.register(PlayerId);
    const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }); pid(w, p, 7); net(w, p);
    w.add(p, G.AnimState, { anim: G.Anim.Idle, startTick: 0 });
    const q = extraPlayer(w, 0, 1, 8);
    const v = net(w, G.spawnVehicle(w, "wagon_medium", 0, 0, 0));
    // A solid workbench on every tile of the 7x7 block around the wagon (search radius 3): no candidate survives.
    for (let ty = -3; ty <= 3; ty++) for (let tx = -3; tx <= 3; tx++) put("workbench", tx + 0.5, ty + 0.5);
    for (let i = 0; i < 2; i++) w.step(DT);
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined(); expect(G.enterVehicle(w, q, v, 1)).toBeUndefined();
    expect(G.exitVehicle(w, q)).toBe("no_safe_spot");
    expect(w.has(q, G.Driver)).toBe(true); // still seated — retry later, never stranded in a solid
    expect(w.getField(q, G.Driver, "seat")).toBe(1);
    expect(w.get(v, G.VehicleSeats)!.occupant[1]).toBe(w.getField(q, NetId, "id"));
  });
});

describe("ADR-371 driver leaves / unhitch / destroyed", () => {
  it("the driver leaving leaves passengers seated in the parked wagon (safe: they exit on demand)", () => {
    const { w, p } = setup(); const { m, v } = rig(w, p);
    const q = extraPlayer(w, -2, 0, 8);
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined(); expect(G.enterVehicle(w, q, v, 1)).toBeUndefined();
    expect(G.exitVehicle(w, p)).toBeUndefined();
    expect(w.has(q, G.Driver)).toBe(true); expect(w.getField(q, G.Driver, "seat")).toBe(1);
    expect(w.getField(v, G.Vehicle, "speed")).toBe(0);
    expect(G.exitVehicle(w, q)).toBeUndefined(); // and the passenger can still get out afterwards
    void m;
  });
  it("unhitching leaves passengers seated; the wagon stays put", () => {
    const { w, p } = setup(); const { m, v } = rig(w, p);
    const q = extraPlayer(w, -2, 0, 8);
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined(); expect(G.enterVehicle(w, q, v, 1)).toBeUndefined();
    expect(G.unhitchVehicle(w, p, v)).toBeUndefined();
    expect(w.has(q, G.Driver)).toBe(true); expect(w.getField(v, G.Vehicle, "speed")).toBe(0);
    expect(w.getField(v, G.Hitch, "parentNetId")).toBe(0);
    void m;
  });
  it("ejectVehicleOccupants puts every rider on a safe tile and frees the seats", () => {
    const { w, p } = setup(); const { v } = rig(w, p);
    const q = extraPlayer(w, -2, 0, 8);
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined(); expect(G.enterVehicle(w, q, v, 1)).toBeUndefined();
    G.ejectVehicleOccupants(w, v);
    for (const r of [p, q]) {
      expect(w.has(r, G.Driver)).toBe(false); expect(w.getField(r, G.AnimState, "anim")).toBe(G.Anim.Idle);
      expect(w.get(r, Transform)).toBeDefined();
    }
    expect(w.get(v, G.VehicleSeats)!.occupant[0]).toBe(0);
    expect(w.get(v, G.VehicleSeats)!.occupant[1]).toBe(0);
  });
  it("a destroyed vehicle ejects its riders on the next tick instead of stranding them", () => {
    const { w, p } = setup(); const { v } = rig(w, p);
    const q = extraPlayer(w, -2, 0, 8);
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined(); expect(G.enterVehicle(w, q, v, 1)).toBeUndefined();
    w.step(DT);
    const vx = w.get(v, Transform)!.x, vy = w.get(v, Transform)!.y;
    w.destroy(v);
    w.step(DT); // vehicleSystem: dangling Driver -> forceExitVehicle
    for (const r of [p, q]) {
      expect(w.has(r, G.Driver)).toBe(false);
      const rp = pos(w, r);
      expect(Math.hypot(rp.x - vx, rp.y - vy)).toBeLessThan(8); // nearby, on a checked tile — not lost
    }
  });
  it("exiting a vehicle that is already gone just frees the rider where they stand", () => {
    const { w, p } = setup(); const v = net(w, G.spawnVehicle(w, "wagon_medium", 0, 0, 0));
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined();
    w.destroy(v);
    expect(G.exitVehicle(w, p)).toBeUndefined(); expect(w.has(p, G.Driver)).toBe(false);
  });
});

// ---- AI passenger (ADR-371) ---------------------------------------------------------------------------
type Rig = { w: World; p: Entity; a: Agent; id: (k: string) => number; home: { x: number; y: number } };
function aiRig(opts: { learned?: boolean; x?: number; y?: number; pid?: number; seed?: number } = {}): Rig {
  const w = makeWorld({}, opts.seed ?? 42); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const x = opts.x ?? 0, y = opts.y ?? 0;
  const p = opts.learned === false ? G.spawnPlayer(w, { x, y, maxWeight: 0, clientId: 7 }) : spawnLearned(w, { x, y, maxWeight: 0, clientId: 7 });
  pid(w, p, opts.pid ?? 7); net(w, p);
  w.add(p, G.AnimState, { anim: G.Anim.Idle, startTick: 0 });
  const a = G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1); const d = G.gameplayDefs(w);
  return { w, p, a, id: (k) => d.itemId(k), home: { x, y } };
}
type Ctx = AgentContext<G.AgentWorldView>;
function ctxOf(r: Rig | { w: World; p: Entity; a: Agent; home: { x: number; y: number } }): Ctx {
  const v = G.buildAgentView(r.w, r.p, r.a, r.home)!;
  return { self: v.self, bb: r.a.bb, memory: r.a.memory, traits: { ...r.a.identity.traits, bravery: 0.8, industriousness: 0.8 }, rng: r.a.rng, agent: r.a, world: v.world };
}
const out = (): AgentOutput & { commands?: G.AgentCommand[] } => ({ ...idleOutput(), actions: [] as string[] });
const behavior = (name: string): G.GameBehavior => [...G.mountBehaviors(), ...G.vehicleBehaviors(), ...G.referenceBehaviors()].find((b) => b.name === name)!;
const passes = (b: G.GameBehavior, c: Ctx): boolean => b.considerations.every((k) => (k.weight ?? 1) * (k.input(c) >= 0.5 ? 1 : 0) > 0 || (k.curve.type === "linear" && k.input(c) > 0));
/** Apply the bot's mount / vehicle commands the way the server handlers do, plus its movement. */
function apply(r: { w: World; p: Entity }, o: AgentOutput & { commands?: G.AgentCommand[] }, log: string[]): void {
  const { w, p } = r;
  G.emitAgentCommands(o);
  for (const c of o.commands ?? []) {
    const v = c.payload as { target: number; tow: number; seat: number }; const t = v.target as Entity; log.push(c.type);
    if (c.type === G.VehicleEnterCmd.name) G.enterVehicle(w, p, t, v.seat ?? 255);
    else if (c.type === G.VehicleExitCmd.name) G.exitVehicle(w, p);
  }
  let bits = 0; const len = Math.hypot(o.moveX, o.moveY);
  if (len > 1e-6) { if (o.moveX > 0.38 * len) bits |= G.GameplayActions.MoveRight; else if (o.moveX < -0.38 * len) bits |= G.GameplayActions.MoveLeft; if (o.moveY > 0.38 * len) bits |= G.GameplayActions.MoveDown; else if (o.moveY < -0.38 * len) bits |= G.GameplayActions.MoveUp; }
  G.applyMovementInput(w, p, bits, DT, { x: o.moveX, y: o.moveY });
}
/** A second bot in the same world (the passenger), with its own agent + blackboard. */
const passengerBot = (w: World, x: number, y: number, clientId: number): { p: Entity; a: Agent; home: { x: number; y: number } } => {
  const p = extraPlayer(w, x, y, clientId);
  const a = G.makeAgent(G.makeAgentIdentity(4, 0, "bot_gatherer"), 1);
  return { p, a, home: { x, y } };
};

describe("ADR-371 AI passenger", () => {
  it("the survivor registry carries ride_passenger; pickPassengerRide needs a driven drawn vehicle", () => {
    const names = G.survivorRegistry().list().map((b) => b.name);
    expect(names).toContain("ride_passenger");
    const r = aiRig();
    const v = atPin(r.w, "wagon_medium");
    expect(G.hitchVehicles(r.w, r.p, v, horse(r.w, r.p))).toBeUndefined();
    const c = ctxOf(r); c.world.driveGoal = { x: 30, y: 0 };
    expect(G.pickPassengerRide(c.world)).toBeUndefined(); // no driver yet: nobody to ride with
    expect(passes(behavior("ride_passenger"), c)).toBe(false);
    expect(G.enterVehicle(r.w, r.p, v, 0)).toBeUndefined(); // the driver climbs in
    const c2 = ctxOf(r); c2.world.driveGoal = { x: 30, y: 0 };
    const ride = G.pickPassengerRide(c2.world);
    expect(ride?.id).toBe(v); expect(ride?.driverSeated).toBe(true); expect(ride?.freePassengerSeats).toBe(1);
    expect(passes(behavior("ride_passenger"), c2)).toBe(true); // far from the goal + a ride available
  });
  it("a passenger does not board a driverless wagon, a motor vehicle, or a full one", () => {
    const r = aiRig();
    const wagon = atPin(r.w, "wagon_medium");
    const car = net(r.w, G.spawnVehicle(r.w, "car_sedan", 10, 0, 0));
    const c = ctxOf(r); c.world.driveGoal = { x: 30, y: 0 };
    expect(G.pickPassengerRide(c.world)).toBeUndefined(); // wagon driverless, car is motor
    const driver = extraPlayer(r.w, 12, 0, 8);
    expect(G.enterVehicle(r.w, driver, car, 0)).toBeUndefined(); // a driven motor vehicle…
    const c2 = ctxOf(r); c2.world.driveGoal = { x: 30, y: 0 };
    expect(G.pickPassengerRide(c2.world)).toBeUndefined(); // …is still not a passenger ride (drawn only)
    expect(G.enterVehicle(r.w, r.p, wagon, 0)).toBeUndefined(); // the bot itself drives the wagon now
    const q = extraPlayer(r.w, 0, 1, 9);
    expect(G.enterVehicle(r.w, q, wagon, 1)).toBeUndefined(); // and a passenger fills the last seat
    const c3 = ctxOf({ w: r.w, p: extraPlayer(r.w, -5, 0, 10), a: G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1), home: { x: -5, y: 0 } });
    c3.world.driveGoal = { x: 30, y: 0 };
    expect(G.pickPassengerRide(c3.world)).toBeUndefined(); // full: no free passenger seat
  });
  it("a bot boards a driven wagon, rides to its goal, and gets out there", () => {
    const r = aiRig();
    const m = horse(r.w, r.p); const v = atPin(r.w, "wagon_medium");
    expect(G.hitchVehicles(r.w, r.p, v, m)).toBeUndefined();
    expect(G.enterVehicle(r.w, r.p, v, 0)).toBeUndefined(); // the driver is seated, wagon parked
    const pas = passengerBot(r.w, 0, 2, 8);
    const goal = { x: 30, y: 0 };
    const log: string[] = [];
    const bRide = behavior("ride_passenger"); const bDrive = behavior("drive_drawn");
    // Phase 1: the passenger walks to the parked wagon and boards (the driver waits).
    let boarded = -1;
    for (let i = 0; i < 200 && boarded < 0; i++) {
      const c = ctxOf({ w: r.w, p: pas.p, a: pas.a, home: pas.home }); c.world.driveGoal = goal;
      const o = out(); bRide.run(c, o); G.mountPolicy(c, o, "ride_passenger"); apply({ w: r.w, p: pas.p }, o, log); r.w.step(DT);
      if (r.w.has(pas.p, G.Driver)) boarded = i;
    }
    expect(boarded).toBeGreaterThanOrEqual(0);
    expect(r.w.getField(pas.p, G.Driver, "seat")).toBe(1); // passenger seat, never the driver seat
    expect(log).toContain(G.VehicleEnterCmd.name);
    // Phase 2: the driver hauls the wagon to the shared goal while the passenger rides along.
    let done = -1;
    for (let i = 0; i < 900 && done < 0; i++) {
      const cd = ctxOf(r); cd.world.driveGoal = goal; const od = out(); bDrive.run(cd, od); G.mountPolicy(cd, od, "drive_drawn"); apply(r, od, log); r.w.step(DT);
      const cp = ctxOf({ w: r.w, p: pas.p, a: pas.a, home: pas.home }); cp.world.driveGoal = goal;
      const op = out(); bRide.run(cp, op); G.mountPolicy(cp, op, "ride_passenger"); apply({ w: r.w, p: pas.p }, op, log); r.w.step(DT);
      if (!r.w.has(pas.p, G.Driver) && r.w.get(v, Transform)!.x > 20) done = i;
    }
    expect(done).toBeGreaterThanOrEqual(0); // rode, arrived, got out
    expect(log).toContain(G.VehicleExitCmd.name);
    const pp = pos(r.w, pas.p);
    expect(Math.hypot(pp.x - goal.x, pp.y - goal.y)).toBeLessThanOrEqual(8); // at the destination, not stranded
    expect(r.w.getField(pas.p, G.AnimState, "anim")).toBe(G.Anim.Idle);
    expect(G.firstFreePassengerSeat(r.w, v)).toBe(1); // the seat is free again
  }, 120_000);
  it("a riding passenger gets out when the driver leaves (parked)", () => {
    const r = aiRig();
    const m = horse(r.w, r.p); const v = atPin(r.w, "wagon_medium");
    expect(G.hitchVehicles(r.w, r.p, v, m)).toBeUndefined();
    expect(G.enterVehicle(r.w, r.p, v, 0)).toBeUndefined();
    const pas = passengerBot(r.w, 0, 1, 8);
    expect(G.enterVehicle(r.w, pas.p, v, 1)).toBeUndefined();
    expect(G.exitVehicle(r.w, r.p)).toBeUndefined(); // the driver gets out and walks away
    const c = ctxOf({ w: r.w, p: pas.p, a: pas.a, home: pas.home }); c.world.driveGoal = { x: 30, y: 0 };
    const o = out(); behavior("ride_passenger").run(c, o);
    expect(o.actions).toContain("vexit");
    G.emitAgentCommands(o);
    for (const cmd of o.commands ?? []) if (cmd.type === G.VehicleExitCmd.name) G.exitVehicle(r.w, pas.p);
    expect(r.w.has(pas.p, G.Driver)).toBe(false);
  });
  it("a riding passenger gets out when the ride goes the wrong way (parked, 10+ tiles worse)", () => {
    const r = aiRig();
    const v = net(r.w, G.spawnVehicle(r.w, "wagon_medium", 0, 0, 0));
    const driver = extraPlayer(r.w, 0, 1, 8);
    expect(G.enterVehicle(r.w, driver, v, 0)).toBeUndefined();
    const pas = passengerBot(r.w, 0, -1, 9);
    expect(G.enterVehicle(r.w, pas.p, v, 1)).toBeUndefined();
    const c = ctxOf({ w: r.w, p: pas.p, a: pas.a, home: pas.home }); c.world.driveGoal = { x: 30, y: 0 };
    c.bb.set("rideFrom", { x: 25, y: 0 }); // boarded 5 tiles from the goal; the wagon is now 30 away
    const o = out(); behavior("ride_passenger").run(c, o);
    expect(o.actions).toContain("vexit");
  });
  it("a riding passenger stays seated while the wagon is still rolling toward its goal", () => {
    const r = aiRig();
    const v = net(r.w, G.spawnVehicle(r.w, "wagon_medium", 0, 0, 0));
    const driver = extraPlayer(r.w, 0, 1, 8);
    expect(G.enterVehicle(r.w, driver, v, 0)).toBeUndefined();
    const pas = passengerBot(r.w, 0, -1, 9);
    expect(G.enterVehicle(r.w, pas.p, v, 1)).toBeUndefined();
    const c = ctxOf({ w: r.w, p: pas.p, a: pas.a, home: pas.home }); c.world.driveGoal = { x: 30, y: 0 };
    const o = out(); behavior("ride_passenger").run(c, o);
    expect(o.actions).toEqual([]); // no exit, no move: the passenger's input moves nothing
    expect(o.moveX).toBe(0); expect(o.moveY).toBe(0);
  });
});

describe("ADR-371 schema + tuning", () => {
  it("no new component: the world schema hash is unchanged from ADR-360", () => {
    expect(makeWorld().getSchemaHash()).toBe(0xb629eab2);
  });
  it("passenger tuning loads from data (search 3, fallback 6) and rejects bad values", () => {
    expect(G.VEHICLE_PASSENGER_TUNING.dismountSearchRadiusTiles).toBe(3);
    expect(G.VEHICLE_PASSENGER_TUNING.dismountFallbackRadiusTiles).toBe(6);
    expect(() => G.loadVehiclePassengerTuning({ dismountSearchRadiusTiles: 0, dismountFallbackRadiusTiles: 6 })).toThrow();
    expect(() => G.loadVehiclePassengerTuning({ dismountSearchRadiusTiles: 3, dismountFallbackRadiusTiles: 2 })).toThrow();
  });
  it("vehicleInteractCommand offers the passenger seat when asked", () => {
    const { w, p } = setup(); const v = net(w, G.spawnVehicle(w, "wagon_medium", 0, 0, 0));
    expect(G.vehicleInteractCommand(w, p, v)).toEqual({ def: G.VehicleEnterCmd, values: { target: v, seat: 255 } });
    expect(G.vehicleInteractCommand(w, p, v, { asPassenger: true })).toEqual({ def: G.VehicleEnterCmd, values: { target: v, seat: 254 } });
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined();
    expect(G.vehicleInteractCommand(w, p, v)).toEqual({ def: G.VehicleExitCmd, values: {} });
  });
});
