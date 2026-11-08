import { describe, expect, it } from "vitest";
import { AnimState as CoreAnim, ANIM_STATE_NAMES, CommandRegistry, CommandRejected, decodeSnapshot, encodeSnapshot, applySnapshot, installCommandHandlers, NetId, type World, type Entity } from "@engine/core";
import * as G from "../src/index.js";
import raw from "../data/vehicles.json";
import { makeWorld } from "./helpers.js";

let nid = 500;
const net = (w: World, e: Entity): Entity => { w.add(e, NetId, { id: ++nid }); return e; };
const player = (w: World, x = 0, y = 0): Entity => net(w, G.spawnPlayer(w, { x, y, maxWeight: 0, clientId: 1 }));
const car = (w: World, id: string, x = 0, y = 0, h = 0): Entity => net(w, G.spawnVehicle(w, id, x, y, h));

describe("ADR-101 vehicle follow-ups", () => {
  it("AnimState.Sit = 13 appended; riders sit, exit restores idle", () => {
    expect(CoreAnim.Sit).toBe(13); expect(ANIM_STATE_NAMES[13]).toBe("sit"); expect(ANIM_STATE_NAMES.length).toBe(26);
    const w = makeWorld(); const p = player(w); const v = car(w, "car_sedan", 1, 0);
    if (!w.has(p, G.AnimState)) w.add(p, G.AnimState, { anim: CoreAnim.Idle, startTick: 0 });
    expect(G.enterVehicle(w, p, v)).toBeUndefined(); w.step(1 / 20);
    expect(w.getField(p, G.AnimState, "anim")).toBe(CoreAnim.Sit);
    expect(G.exitVehicle(w, p)).toBeUndefined(); expect(w.getField(p, G.AnimState, "anim")).toBe(CoreAnim.Idle);
  });
  it("defs carry seat + hitch anchors and validate them", () => {
    for (const d of G.VEHICLE_DEFS) {
      expect(d.seatAnchors.length).toBe(d.seats);
      for (const h of d.hitches) expect(h.anchor.x).toBeCloseTo(h.at === "front" ? h.offset : -h.offset, 9);
    }
    const sedan = G.VEHICLE_DEFS[G.vehicleDefId("car_sedan") - 1]!; expect(sedan.seatAnchors[0]!.y).toBeGreaterThan(0); // driver front-left
    const bad = structuredClone(raw) as { vehicles: G.VehicleDef[] }; bad.vehicles[0]!.seatAnchors = [];
    const t = bad.vehicles.find((d) => d.hitches.length)!; t.hitches[0]!.anchor.x += 1;
    const errs = G.validateVehicleDefs(bad.vehicles); expect(errs.some((e) => /seatAnchors/.test(e))).toBe(true); expect(errs.some((e) => /anchor\.x/.test(e))).toBe(true);
  });
  it("engine/headlight toggles: driver only, validated commands appended last, replicated", () => {
    const w = makeWorld(); const p = player(w); const q = player(w, 0, 1); const v = car(w, "van_passenger", 1, 0); const bike = car(w, "bike_basic", 3, 0);
    const reg = G.registerGameplayCommands(new CommandRegistry()); const h = installCommandHandlers(w, reg); G.installVehicleCommands(w, h);
    const ids = G.VEHICLE_STATE_COMMANDS.map((d) => reg.idOf(d));
    const craftMax = Math.max(...G.VEHICLE_CRAFT_COMMANDS.map((d) => reg.idOf(d)));
    expect(Math.min(...ids)).toBeGreaterThan(craftMax);
    const rej: string[] = []; w.events.on(CommandRejected, (e) => rej.push(e.reason));
    let seq = 0; const send = (a: Entity, def: typeof G.VehicleEngineCmd, target: Entity, on: number): void => { h.enqueue(a, 1, ++seq, reg.make(def, { target, on })); w.step(1 / 20); };
    send(p, G.VehicleEngineCmd, v, 1); expect(rej).toEqual(["not_driver"]);
    G.enterVehicle(w, p, v, 0); G.enterVehicle(w, q, v, 1);
    send(q, G.VehicleHeadlightsCmd, v, 1); expect(rej.at(-1)).toBe("not_driver");
    send(p, G.VehicleEngineCmd, v, 1); send(p, G.VehicleHeadlightsCmd, v, 2);
    expect(G.isEngineOn(w, v)).toBe(true); expect(G.headlightsOn(w, v)).toBe(true); expect(G.vehicleFlags(w, v)).toBe(3);
    send(p, G.VehicleHeadlightsCmd, v, 2); expect(G.headlightsOn(w, v)).toBe(false);
    send(p, G.VehicleEngineCmd, v, 7); expect(rej.at(-1)).toBe("bad_value");
    const r = player(w, 3, 0); G.enterVehicle(w, r, bike);
    expect(G.setVehicleToggle(w, r, bike, G.VEHICLE_ENGINE_ON, 1)).toBe("no_engine");
    expect(G.setVehicleToggle(w, r, bike, G.VEHICLE_HEADLIGHTS, 1)).toBeUndefined();
    w.remove(v, G.VehicleState); expect(G.setVehicleToggle(w, p, v, G.VEHICLE_ENGINE_ON, 1)).toBeUndefined(); // pre-ADR-101 save: component added on demand
    const w2 = makeWorld(); for (let i = 0; i < 3; i++) G.spawnPlayer(w2, { x: 0, y: 0, maxWeight: 0 }); G.spawnVehicle(w2, "van_passenger", 0, 0); G.spawnVehicle(w2, "bike_basic", 0, 0);
    applySnapshot(w2, decodeSnapshot(w2, encodeSnapshot(w, { all: true })));
    expect(w2.getField(v, G.VehicleState, "flags")).toBe(1); expect(w2.getField(bike, G.VehicleState, "flags")).toBe(2);
  });
  it("trailer heading is broadcast (Vehicle scope all) and in snapshots", () => {
    for (const d of [G.Vehicle, G.VehicleSeats, G.Driver, G.Hitch, G.VehicleState]) expect(G.replicationOf(d)?.scope).toBe("all");
    const w = makeWorld(); const p = player(w); const v = car(w, "truck_pickup", 1, 0); const t = car(w, "trailer_cargo_medium", -3.5, 0, 0.3);
    expect(w.has(t, G.VehicleState)).toBe(false);
    G.enterVehicle(w, p, v); expect(G.hitchVehicles(w, p, t, v)).toBeUndefined();
    for (let i = 0; i < 30; i++) { G.setDriveInput(w, p, 1, 1, false); w.step(1 / 20); }
    const th = w.getField(t, G.Vehicle, "heading")!; expect(th).not.toBe(0);
    const w2 = makeWorld(); G.spawnPlayer(w2, { x: 0, y: 0, maxWeight: 0 }); G.spawnVehicle(w2, "truck_pickup", 0, 0); G.spawnVehicle(w2, "trailer_cargo_medium", 0, 0);
    applySnapshot(w2, decodeSnapshot(w2, encodeSnapshot(w, { all: true })));
    expect(w2.getField(t, G.Vehicle, "heading")).toBeCloseTo(th, 5);
  });
  it("localPlayerVehicle returns the ridden vehicle netId or null", () => {
    const w = makeWorld(); const p = player(w); const v = car(w, "camper_van", 1, 0);
    expect(G.localPlayerVehicle(w, p)).toBeNull(); G.enterVehicle(w, p, v);
    expect(G.localPlayerVehicle(w, p)).toBe(w.getField(v, NetId, "id")); G.exitVehicle(w, p); expect(G.localPlayerVehicle(w, p)).toBeNull();
  });
});
