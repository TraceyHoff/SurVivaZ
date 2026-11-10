/** Vehicle netcode end-to-end (ADR-102): prediction/reconciliation, trailer smoothing, view bonus, command validation, guard. */
import { describe, it, expect, vi } from "vitest";
vi.setConfig({ testTimeout: 30_000 });
import { NetId, Transform, World, type Entity } from "@engine/core";
import {
  Driver, Hitch, Vehicle, VehicleEnterCmd, VehicleExitCmd, VehicleHitchCmd, VehicleUnhitchCmd, VehicleStationCmd, VehicleSeats,
  hitchVehicles, netIdEntity, setVehicleBlocker, spawnVehicle, vehicleViewChunks, VEHICLE_VIEW_BONUS,
} from "@engine/gameplay";
import { LoopbackNetwork, NetClient, type LinkConditions } from "@engine/net";
import { ClaimAccount, MemoryWorldStore } from "@engine/persist";
import {
  createGameServer, applyDemoInput, installDemoWorld, gameplayNet, onGameplayRejected, rejectReasonCode, DEMO_COMMANDS, DEMO_EVENTS,
  VEHICLE_CLIENT_OPTIONS, type GameplayRejection,
} from "../src/main.js";

const FWD = 2 | 16; // drive bits: forward (+x,+y) + boost

async function setup() {
  const net = new LoopbackNetwork(11);
  const gs = createGameServer({ transport: net.createServer(), store: new MemoryWorldStore(), seed: 5, population: false });
  setVehicleBlocker(gs.world, () => false);
  const clients: NetClient[] = [];
  const tick = (n = 1, each?: () => void): void => {
    for (let i = 0; i < n; i++) { net.advance(50); gs.step(1 / 20); for (const c of clients) { c.world.step(1 / 20); c.pollEvents(Infinity); } each?.(); }
  };
  const connect = async (cond: LinkConditions = {}) => {
    const world = new World({ seed: 1 }); installDemoWorld(world, "client"); setVehicleBlocker(world, () => false);
    const io = { buttons: 0 };
    const c = new NetClient({
      world, transport: net.createClient(cond), commands: DEMO_COMMANDS, events: DEMO_EVENTS,
      sampleInput: () => ({ buttons: io.buttons, aimX: 0, aimY: 0 }), applyInput: (w, e, cmd) => applyDemoInput(w, e, cmd), ...VEHICLE_CLIENT_OPTIONS,
    });
    const p = c.connect(); await new Promise((r) => setTimeout(r, 0)); for (let t = 0; t < 40; t++) { net.advance(50); await Promise.resolve(); } await p; clients.push(c);
    c.sendCommand(ClaimAccount, { t0: 0, t1: 0, t2: 0, t3: 0 }); tick(3);
    const e = gs.players.get(c.clientId!)!.entity;
    const rej: GameplayRejection[] = []; onGameplayRejected(c, (r) => rej.push(r));
    const anomalies: string[] = []; gs.net.onAnomaly((s, k) => { if (s.clientId === c.clientId) anomalies.push(k); });
    return { c, e, io, rej, anomalies, cid: c.clientId! };
  };
  const vehicle = (key: string, x: number, y: number, heading = 0): { v: Entity; id: number } => {
    const v = spawnVehicle(gs.world, key, x, y, heading); return { v, id: gs.net.netIds.netIdOf(v) ?? gs.net.netIds.assign(v) };
  };
  const pos = (w: World, e: Entity) => w.get(e, Transform)!;
  return { net, gs, tick, connect, vehicle, pos, w: gs.world };
}
/** Commands carry local entities; NetClient maps them to NetIds on the wire. */
const L = (c: NetClient, netId: number): number => { const e = netIdEntity(c.world, netId); if (e === undefined) throw new Error(`client lacks ${netId}`); return e; };
const enter = (c: NetClient, target: number, seat = 255): void => { expect(c.sendCommand(gameplayNet(VehicleEnterCmd), { target: L(c, target), seat })).toBe(true); };

describe("vehicle prediction + reconciliation", () => {
  it("driver predicts its vehicle; converges to the server under latency, jitter and 10% loss", async () => {
    const s = await setup(); const A = await s.connect({ latencyMs: 80, jitterMs: 20, loss: 0.1 });
    const p = s.pos(s.w, A.e); const car = s.vehicle("car_offroad", p.x + 1, p.y); s.tick(6);
    enter(A.c, car.id, 0); s.tick(10);
    expect(s.w.get(A.e, Driver)?.seat).toBe(0);
    expect(A.c.controlled.has(car.id)).toBe(true);
    const cv = netIdEntity(A.c.world, car.id)!; expect(A.c.world.predicted.has(cv)).toBe(true);
    let maxErr = 0;
    A.io.buttons = FWD;
    s.tick(80, () => { const a = s.pos(A.c.world, cv), b = s.pos(s.w, car.v); maxErr = Math.max(maxErr, Math.hypot(a.x - b.x, a.y - b.y)); });
    expect(s.w.getField(car.v, Vehicle, "speed")!).toBeGreaterThan(5);
    A.io.buttons = 0; s.tick(300); expect(s.w.getField(car.v, Vehicle, "speed")).toBe(0); // coast to a stop
    const a = s.pos(A.c.world, cv), b = s.pos(s.w, car.v);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(0.05);
    // ahead of the server by ~RTT at speed, never wildly off. ADR-330: the bound is the lead in ticks x one tick
    // of travel at top speed (car_offroad 13 tiles/s x boost 1.3 = 16.9 tiles/s, so 0.845 tiles/tick). The
    // lead is RTT-max (80+20 ms each way = 200 ms = 4 ticks = 3.38 tiles) plus the server input queue running
    // 1-3 ticks deeper after a loss burst / late snapshots (one input per tick, no catch-up, ADR-191); the
    // observed worst case is 5 ticks = 4.225 tiles, so 4 was inside the model's own range. 6 tiles covers
    // ~7 ticks of lead; a real prediction failure would be far larger and would also trip the < 0.05 final
    // convergence and snaps == 0 assertions above.
    expect(maxErr).toBeLessThan(6);
    expect(A.c.stats.snaps).toBe(0);
  });
  it("a large server correction snaps instead of sliding", async () => {
    const s = await setup(); const A = await s.connect({ latencyMs: 40 });
    const p = s.pos(s.w, A.e); const car = s.vehicle("car_sedan", p.x + 1, p.y); s.tick(6);
    enter(A.c, car.id, 0); s.tick(8); const cv = netIdEntity(A.c.world, car.id)!;
    const sx = s.pos(s.w, car.v).x;
    A.c.world.set(cv, Transform, { x: sx + 9, y: p.y }); // local desync (e.g. a missed collision): 9 tiles off
    s.tick(10);
    expect(A.c.stats.snaps).toBeGreaterThan(0);
    expect(Math.abs(s.pos(A.c.world, cv).x - s.pos(s.w, car.v).x)).toBeLessThan(0.05); // no multi-frame slide
  });
  it("only the seat-0 driver steers; a passenger's input does nothing", async () => {
    const s = await setup(); const A = await s.connect(); const B = await s.connect();
    const p = s.pos(s.w, A.e); s.w.set(B.e, Transform, { x: p.x, y: p.y + 1 }); const car = s.vehicle("car_sedan", p.x + 1, p.y); s.tick(6);
    enter(B.c, car.id, 1); s.tick(6); expect(s.w.get(B.e, Driver)?.seat).toBe(1);
    expect(B.c.controlled.size).toBe(0);
    B.io.buttons = FWD; s.tick(20);
    expect(s.w.getField(car.v, Vehicle, "speed")).toBe(0);
    enter(A.c, car.id, 0); s.tick(6); A.io.buttons = FWD; s.tick(20);
    expect(s.w.getField(car.v, Vehicle, "speed")!).toBeGreaterThan(2);
  });
});

describe("trailers on observers", () => {
  it("a remote hitched trailer moves smoothly in its tow's hitch frame", async () => {
    const s = await setup(); const A = await s.connect(); const B = await s.connect({ latencyMs: 60, jitterMs: 30, loss: 0.05 });
    const p = s.pos(s.w, A.e); s.w.set(B.e, Transform, { x: p.x - 2, y: p.y - 2 });
    const pk = s.vehicle("truck_pickup", p.x + 1, p.y); const tr = s.vehicle("trailer_cargo_medium", p.x + 1 - (2.9 + 2.6), p.y); s.tick(4);
    expect(hitchVehicles(s.w, A.e, tr.v, pk.v)).toBeUndefined();
    enter(A.c, pk.id, 0); s.tick(8); expect(A.c.controlled.has(tr.id)).toBe(true); // driver predicts the whole chain
    const bt = () => netIdEntity(B.c.world, tr.id)!, bp = () => netIdEntity(B.c.world, pk.id)!;
    A.io.buttons = FWD; s.tick(20);
    const steps: number[] = []; const pin: number[] = []; let last: { x: number; y: number } | undefined;
    s.tick(60, () => {
      const t = s.pos(B.c.world, bt()), q = s.pos(B.c.world, bp());
      if (last) steps.push(Math.hypot(t.x - last.x, t.y - last.y)); last = { x: t.x, y: t.y };
      pin.push(Math.hypot(t.x - q.x, t.y - q.y));
    });
    expect(B.c.world.getField(bt(), Hitch, "parentNetId")).toBe(pk.id);
    // per-frame motion never jumps or runs backwards: no step beyond the server's per-tick travel (0.91 t/tick at the end),
    // at most one held frame when a burst of snapshots is lost (render time holds instead of snapping back)
    const serverStep = s.w.getField(pk.v, Vehicle, "speed")! / 20;
    expect(Math.max(...steps)).toBeLessThanOrEqual(serverStep * 1.1);
    expect(steps.filter((x) => x < 0.05).length).toBeLessThanOrEqual(2);
    // trailer stays on the tow's rear pin (constant hitch distance)
    expect(Math.max(...pin) - Math.min(...pin)).toBeLessThan(0.3);
  });
});

describe("speed-scaled view radius bonus", () => {
  it("thresholds have hysteresis", () => {
    expect(vehicleViewChunks(0, 0)).toBe(0);
    expect(vehicleViewChunks(VEHICLE_VIEW_BONUS.up[0]!, 0)).toBe(1);
    expect(vehicleViewChunks(VEHICLE_VIEW_BONUS.up[1]!, 0)).toBe(2);
    expect(vehicleViewChunks(VEHICLE_VIEW_BONUS.up[0]! - 0.5, 1)).toBe(1); // between down and up: hold
    expect(vehicleViewChunks(VEHICLE_VIEW_BONUS.down[0]! - 0.1, 1)).toBe(0);
    expect(vehicleViewChunks(999, 0)).toBe(VEHICLE_VIEW_BONUS.up.length); // bounded
  });
  it("rises while driving fast and falls after stopping", async () => {
    const s = await setup(); const A = await s.connect();
    const p = s.pos(s.w, A.e); const car = s.vehicle("car_sedan", p.x + 1, p.y); s.tick(4);
    enter(A.c, car.id, 0); s.tick(6); expect(s.gs.net.viewRadiusBonus(A.cid)).toBe(0);
    A.io.buttons = FWD; let peak = 0; s.tick(120, () => { peak = Math.max(peak, s.gs.net.viewRadiusBonus(A.cid)); });
    expect(peak).toBeGreaterThan(0); expect(peak).toBeLessThanOrEqual(2);
    A.io.buttons = 0; s.tick(200);
    expect(s.gs.net.viewRadiusBonus(A.cid)).toBe(0);
  });
});

describe("vehicle command validation over the wire", () => {
  it("rejects each command with its reason code", async () => {
    const s = await setup(); const A = await s.connect(); const B = await s.connect();
    const p = s.pos(s.w, A.e); s.w.set(B.e, Transform, { x: p.x, y: p.y + 1 });
    const sedan = s.vehicle("car_sedan", p.x + 1, p.y); const far = s.vehicle("car_sedan", p.x + 20, p.y);
    const util = s.vehicle("trailer_utility_small", p.x - 3, p.y + 3); s.tick(6);
    const send = (c: NetClient, f: () => void): void => { f(); s.tick(4); void c; };
    send(A.c, () => A.c.sendCommand(gameplayNet(VehicleExitCmd), {} as never));
    send(A.c, () => enter(A.c, far.id));
    send(A.c, () => enter(A.c, s.gs.net.netIds.netIdOf(B.e)!));
    send(A.c, () => enter(A.c, sedan.id, 9));
    send(A.c, () => A.c.sendCommand(gameplayNet(VehicleHitchCmd), { target: L(A.c, util.id), tow: L(A.c, sedan.id) }));
    send(A.c, () => A.c.sendCommand(gameplayNet(VehicleUnhitchCmd), { target: L(A.c, util.id) }));
    send(A.c, () => A.c.sendCommand(gameplayNet(VehicleStationCmd), { target: L(A.c, sedan.id), station: 0 }));
    send(A.c, () => enter(A.c, sedan.id, 0)); expect(s.w.get(A.e, Driver)?.seat).toBe(0);
    send(A.c, () => enter(A.c, sedan.id, 1));
    send(B.c, () => enter(B.c, sedan.id, 0));
    expect(A.rej.map((r) => r.reason)).toEqual(["not_riding", "too_far", "not_vehicle", "bad_seat", "no_hitch", "not_hitched", "no_station", "already_riding"]);
    expect(B.rej.map((r) => r.reason)).toEqual(["seat_taken"]);
    for (const r of [...A.rej, ...B.rej]) { expect(r.code).toBe(rejectReasonCode(r.reason)); expect(r.code).toBeGreaterThan(0); }
  });
  it("drops out-of-AOI targets (badEntityRef) and rate-limits command spam", async () => {
    const s = await setup(); const A = await s.connect();
    const p = s.pos(s.w, A.e); const far = s.vehicle("car_sedan", p.x + 400, p.y + 400); s.tick(8);
    expect(netIdEntity(A.c.world, far.id)).toBeUndefined(); // never replicated to A
    // a modified client names the far vehicle's NetId directly (forge the client's local NetId map)
    const forged = A.c.world.create(); (A.c as unknown as { netOf: Map<number, number> }).netOf.set(forged, far.id);
    expect(A.c.sendCommand(gameplayNet(VehicleEnterCmd), { target: forged, seat: 255 })).toBe(true); s.tick(4);
    expect(A.anomalies).toContain("badEntityRef"); expect(A.rej).toEqual([]); expect(s.w.has(A.e, Driver)).toBe(false);
    for (let i = 0; i < 16; i++) A.c.sendCommand(gameplayNet(VehicleExitCmd), {} as never);
    s.tick(4);
    expect(A.anomalies).toContain("rateLimited");
    expect(A.rej.length).toBeGreaterThan(0); expect(A.rej.length).toBeLessThan(16);
  });
  it("speed/teleport guard reverts an impossible vehicle move and reports the driver", async () => {
    const s = await setup(); const A = await s.connect();
    const p = s.pos(s.w, A.e); const car = s.vehicle("car_sedan", p.x + 1, p.y); s.tick(4);
    enter(A.c, car.id, 0); s.tick(4); A.io.buttons = FWD; s.tick(10);
    const before = { ...s.pos(s.w, car.v) };
    s.w.set(car.v, Transform, { x: before.x + 30, y: before.y }); s.tick(1);
    const after = s.pos(s.w, car.v);
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(2);
    expect(A.anomalies.some((k) => k === "teleport" || k === "speed")).toBe(true);
    expect(s.w.getField(car.v, Vehicle, "speed")).toBeLessThan(1);
    expect(Array.from(s.w.get(car.v, VehicleSeats)!.occupant as ArrayLike<number>)[0]).toBe(s.w.getField(A.e, NetId, "id"));
  });
});
