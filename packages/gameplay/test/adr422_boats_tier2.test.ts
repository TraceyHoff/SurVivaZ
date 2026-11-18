// ADR-422: tier-2 motorboats (motorboat, pontoon, speedboat) — fuelled boats as a vehicle class.
// Defs (ids 43-45, append-only), the paddle/motor validation split, shipyard crafting with skill
// gates, fuel burn at perSecond (incl. the 1.3x boost multiplier), empty-tank stop, refuel classes
// (gasoline vs diesel vs biofuel), engine/lights toggles (motorboats only), 10%-fuel deploy, engine
// repair-item coverage for "boat", and AI sensors / pickRide / driving on water. Movement reuses the
// ADR-421 water path unchanged (deep 1x, shallows 0.55x, land 0x — no shallow-water stall).
import { describe, expect, it } from "vitest";
import { NetId, Transform, type Entity, type World } from "@engine/core";
import { TileMap, WaterDepth } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned } from "./helpers.js";

const d = G.defaultDefs();
const id = (k: string): number => d.itemId(k);
let nid = 4220;
const net = (w: World, e: Entity): Entity => { w.add(e, NetId, { id: ++nid }); return e; };
const player = (w: World, x = 0, y = 0): Entity => net(w, G.spawnPlayer(w, { x, y, maxWeight: 0, clientId: 1 }));
const boat = (w: World, bid: string, x = 30, y = 0, h = 0): Entity => net(w, G.spawnVehicle(w, bid, x, y, h));
const slotOf = (w: World, p: Entity, item: number): number => { const v = G.readSlots(w, p); for (let i = 0; i < v.slotCount; i++) if (v.item(i) === item && v.count(i)) return i; return -1; };
const drive = (w: World, p: Entity, x: number, y: number, n = 1, boost = false): void => { for (let i = 0; i < n; i++) { G.setDriveInput(w, p, x, y, boost); w.step(1 / 20); } };

/** Land tile 3 x -32..128, y -48..48, with water tile 1 in x 10..60 (deep in the middle, shallow at the banks). */
function waterWorld(): World {
  const w = makeWorld();
  const map = new TileMap();
  for (let y = -48; y <= 48; y++) for (let x = -32; x <= 128; x++) map.setTile(x, y, 3);
  for (let y = -48; y <= 48; y++) for (let x = 10; x <= 60; x++) map.setTile(x, y, 1);
  w.setResource(G.TerrainRes, G.terrainFromTileMap(map));
  return w;
}
const depthAt = (w: World, x: number, y: number): WaterDepth => G.waterDepth(w, x, y);
const def = (b: string): G.VehicleDef => G.VEHICLE_DEFS.find((x) => x.id === b)!;

describe("ADR-422 motorboat defs", () => {
  it("appends motorboat/pontoon/speedboat (ids 43-45) as class boat with fuel, no stamina; validation and storage agree", () => {
    expect(G.VEHICLE_DEFS.length).toBe(45);
    expect(["motorboat", "pontoon", "speedboat"].map((b) => G.vehicleDefId(b))).toEqual([43, 44, 45]);
    expect(G.validateVehicleDefs(G.VEHICLE_DEFS)).toEqual([]);
    for (const b of ["motorboat", "pontoon", "speedboat"]) {
      expect(def(b).class).toBe("boat"); expect(G.isBoatDef(def(b))).toBe(true);
      expect(G.isMotorBoatDef(def(b))).toBe(true); expect(G.isPaddleBoatDef(def(b))).toBe(false);
      expect(def(b).fuel).not.toBeNull(); expect(def(b).stamina).toBeNull(); // motor, never paddling
      expect(def(b).hitches).toEqual([]); // nothing tows a boat, no boat tows anything
    }
    for (const b of ["raft", "canoe", "rowboat"]) {
      expect(G.isMotorBoatDef(def(b))).toBe(false); expect(G.isPaddleBoatDef(def(b))).toBe(true);
    }
    // The trade-offs, fixed: speedboat fastest + smallest + thirstiest, pontoon slowest motorboat +
    // biggest storage, motorboat the balanced middle. Pontoon storage hits the boat class max (36).
    const cap = (b: string): { slots: number; maxWeight: number } => G.storageCapacity(def(b));
    expect(cap("motorboat")).toEqual({ slots: 12, maxWeight: 200 });
    expect(cap("pontoon")).toEqual({ slots: 36, maxWeight: 1500 });
    expect(cap("speedboat")).toEqual({ slots: 4, maxWeight: 60 });
    expect(def("speedboat").maxSpeed).toBeGreaterThan(def("motorboat").maxSpeed);
    expect(def("motorboat").maxSpeed).toBeGreaterThan(def("pontoon").maxSpeed);
    expect(def("pontoon").maxSpeed).toBeGreaterThan(def("canoe").maxSpeed); // even the slowest motorboat beats the fastest paddle boat
    expect(def("speedboat").maxSpeed).toBe(11.0);
    expect(def("speedboat").maxSpeed).toBeLessThan(def("chariot").maxSpeed); // fastest boat, still below the land record
    expect(def("speedboat").fuel!.perSecond).toBeGreaterThan(def("motorboat").fuel!.perSecond);
    expect(def("motorboat").fuel!.perSecond).toBeGreaterThan(def("pontoon").fuel!.perSecond);
    expect(def("pontoon").fuel!.capacity).toBeGreaterThan(def("motorboat").fuel!.capacity);
    expect(G.VEHICLE_STORAGE.max.boat).toBe(36); expect(G.VEHICLE_STORAGE.scale.boat).toBe(2);
  });

  it("validation split: a boat is exactly one of motor (fuel, no stamina) or paddle (stamina, no fuel)", () => {
    const motor = def("motorboat"), paddle = def("raft");
    expect(G.validateVehicleDefs([{ ...motor, stamina: { perSecond: 1 } }])).toEqual(["vehicle motorboat: boats use fuel (motor) or stamina (paddling), never both or neither"]);
    expect(G.validateVehicleDefs([{ ...motor, fuel: null }])).toEqual(["vehicle motorboat: boats use fuel (motor) or stamina (paddling), never both or neither"]);
    expect(G.validateVehicleDefs([{ ...paddle, fuel: { capacity: 10, perSecond: 1 } }])).toEqual(["vehicle raft: boats use fuel (motor) or stamina (paddling), never both or neither"]);
    expect(G.validateVehicleDefs([{ ...paddle, stamina: null }])).toEqual(["vehicle raft: boats use fuel (motor) or stamina (paddling), never both or neither"]);
    expect(G.validateVehicleDefs([{ ...motor, drawn: { pullMul: 1 } }])).toEqual(["vehicle motorboat: drawn is only for wagon/cart/carriage/chariot"]);
  });

  it("crafting: shipyard recipes with smithing gates, kit + fuel consistency, engine repair items cover boats", () => {
    const w = makeWorld(); expect(G.validateVehicleCraft(w)).toEqual([]);
    const gates: Record<string, { station: number; skill: number; fuel: string }> = {
      motorboat: { station: G.StationKind.Shipyard, skill: 2, fuel: "gasoline" },
      pontoon: { station: G.StationKind.Shipyard, skill: 3, fuel: "diesel" },
      speedboat: { station: G.StationKind.Shipyard, skill: 3, fuel: "gasoline" },
    };
    for (const [b, g] of Object.entries(gates)) {
      const kit = G.vehicleKitKey(b)!; expect(kit).toBe(`vehicle_kit_${b}`);
      const r = [...d.recipes.values()].find((x) => d.items.get(x.output.item)?.key === kit)!;
      expect(r).toBeDefined(); expect(r.station).toBe(g.station); expect(r.skill).toEqual({ key: "smithing", level: g.skill });
      expect(r.seconds).toBeGreaterThan(90); // tier-2 kits take longer than any tier-1 boat kit
      expect(r.ingredients.some((i) => d.items.get(i.item)?.key.startsWith("engine_"))).toBe(true); // every tier-2 kit needs an engine part
      expect(G.VEHICLE_CRAFT.vehicles[b]!.fuel).toBe(g.fuel);
    }
    // Repair: every engine item lists "boat", so a wrecked motorboat revives at a garage; repair_kit still covers the field.
    for (const e of ["engine_small", "engine_medium", "engine_large", "engine_diesel"])
      expect(G.VEHICLE_CRAFT.repair.items[e]!.classes).toContain("boat");
    expect(G.VEHICLE_CRAFT.repair.items["repair_kit"]!.classes).toEqual([]);
  });
});

describe("ADR-422 fuel burn, empty tank and refuel", () => {
  it("a motorboat burns perSecond at full throttle, 1.3x on boost", () => {
    // Northbound from (30, 0): the lake runs y -48..48, so 4 s of driving stays in open water
    // (eastbound would beach at the x = 61 shore mid-test).
    const w = waterWorld(); const p = player(w, 30, 0); const v = boat(w, "motorboat", 30, 0, Math.PI / 2);
    expect(G.enterVehicle(w, p, v)).toBeUndefined();
    const f0 = w.get(v, G.Vehicle)!.fuel;
    expect(f0).toBe(def("motorboat").fuel!.capacity); // spawn starts full
    drive(w, p, 0, 1, 40); // 2 s at full throttle
    const f1 = w.get(v, G.Vehicle)!.fuel;
    expect(f1).toBeCloseTo(f0 - def("motorboat").fuel!.perSecond * 2, 2);
    expect(w.get(v, G.Vehicle)!.speed).toBeCloseTo(def("motorboat").maxSpeed, 0);
    drive(w, p, 0, 1, 40, true); // 2 s boosted
    const f2 = w.get(v, G.Vehicle)!.fuel;
    expect(f2).toBeCloseTo(f1 - def("motorboat").fuel!.perSecond * 1.3 * 2, 2);
    expect(w.get(v, G.Vehicle)!.speed).toBeGreaterThan(def("motorboat").maxSpeed * 1.1);
  });

  it("an empty tank gives no thrust: a motorboat at rest stays put under full input", () => {
    const w = waterWorld(); const p = player(w, 30, 0); const v = boat(w, "motorboat", 30, 0);
    expect(G.enterVehicle(w, p, v)).toBeUndefined();
    w.setField(v, G.Vehicle, "fuel", 0);
    const x0 = w.get(v, Transform)!.x, y0 = w.get(v, Transform)!.y;
    drive(w, p, 1, 0, 40);
    expect(w.get(v, G.Vehicle)!.speed).toBe(0);
    expect(w.get(v, G.Vehicle)!.fuel).toBe(0); // never negative
    expect(w.get(v, Transform)!.x).toBeCloseTo(x0, 6); // unmoved on an empty tank
    expect(w.get(v, Transform)!.y).toBeCloseTo(y0, 6);
  });

  it("refuel classes: gasoline motorboats, diesel pontoon, biofuel either; the wrong fuel is refused", () => {
    const w = makeWorld(); const p = player(w, 0, 0);
    const m = boat(w, "motorboat", 1, 0), po = boat(w, "pontoon", -3, 0), s = boat(w, "speedboat", 0, 2);
    for (const v of [m, po, s]) w.setField(v, G.Vehicle, "fuel", 10);
    G.addItem(w, p, id("gasoline"), 5); G.addItem(w, p, id("diesel"), 5); G.addItem(w, p, id("biofuel"), 5);
    expect(G.refuelVehicle(w, p, m, slotOf(w, p, id("diesel")), 1)).toBe("wrong_fuel");
    expect(G.refuelVehicle(w, p, po, slotOf(w, p, id("gasoline")), 1)).toBe("wrong_fuel");
    expect(G.refuelVehicle(w, p, m, slotOf(w, p, id("gasoline")), 2)).toBe(2);
    expect(G.refuelVehicle(w, p, po, slotOf(w, p, id("diesel")), 2)).toBe(2);
    expect(G.refuelVehicle(w, p, s, slotOf(w, p, id("biofuel")), 2)).toBe(2); // biofuel fills a gasoline tank
    expect(G.refuelVehicle(w, p, po, slotOf(w, p, id("biofuel")), 1)).toBe(1); // ... and a diesel tank
    expect(w.get(m, G.Vehicle)!.fuel).toBeCloseTo(12);
    expect(w.get(po, G.Vehicle)!.fuel).toBeCloseTo(13);
    expect(w.get(s, G.Vehicle)!.fuel).toBeCloseTo(12);
    // A paddle boat still has no tank at all.
    const raft = boat(w, "raft", 0, -2);
    expect(G.validateRefuel(w, p, raft, slotOf(w, p, id("gasoline")))).toBe("no_tank");
  });

  it("deploy starts at 10% fuel and issues the key; the engine + lights toggles then work, paddle boats stay no_controls", () => {
    const w = waterWorld(); const p = player(w, 30, 0);
    G.addItem(w, p, id("vehicle_kit_motorboat"), 1);
    const v = net(w, G.deployVehicleKit(w, p, slotOf(w, p, id("vehicle_kit_motorboat")), 32, 0) as Entity);
    expect(typeof v).toBe("number");
    expect(w.get(v, G.Vehicle)!.fuel).toBeCloseTo(def("motorboat").fuel!.capacity * G.VEHICLE_CRAFT.deploy.startFuel);
    expect(w.has(v, G.VehicleState)).toBe(true); // motorboats carry engine/lights state
    expect(G.enterVehicle(w, p, v)).toBeUndefined();
    expect(G.setVehicleToggle(w, p, v, G.VEHICLE_ENGINE_ON, 1)).toBeUndefined();
    expect(G.isEngineOn(w, v)).toBe(true);
    expect(G.setVehicleToggle(w, p, v, G.VEHICLE_HEADLIGHTS, 1)).toBeUndefined();
    expect(G.headlightsOn(w, v)).toBe(true);
    expect(G.setVehicleToggle(w, p, v, G.VEHICLE_ENGINE_ON, 0)).toBeUndefined();
    expect(G.isEngineOn(w, v)).toBe(false);
    // Wrecked: the engine will not start.
    w.setField(v, G.Vehicle, "health", 0);
    expect(G.setVehicleToggle(w, p, v, G.VEHICLE_ENGINE_ON, 1)).toBe("wrecked");
    // A paddle boat deployed the same way has no state and no controls.
    const q = player(w, 30, 0); G.addItem(w, q, id("vehicle_kit_canoe"), 1);
    const c = net(w, G.deployVehicleKit(w, q, slotOf(w, q, id("vehicle_kit_canoe")), 32, 0) as Entity);
    expect(w.has(c, G.VehicleState)).toBe(false);
    expect(G.enterVehicle(w, q, c)).toBeUndefined();
    expect(G.setVehicleToggle(w, q, c, G.VEHICLE_ENGINE_ON, 1)).toBe("no_controls");
  });
});

describe("ADR-422 motorboat repair", () => {
  it("engine parts revive a wrecked motorboat at a garage (never in the field); repair_kit still works in the field", () => {
    const w = makeWorld(); const p = player(w, 0, 0);
    const v = boat(w, "speedboat", 1, 0); const max = def("speedboat").health;
    w.setField(v, G.Vehicle, "health", max * 0.2);
    G.addItem(w, p, id("engine_large"), 1);
    expect(G.validateRepair(w, p, v, slotOf(w, p, id("engine_large")))).toBe("needs_garage"); // engine parts are garage-only
    G.addItem(w, p, id("repair_kit"), 1);
    expect(typeof G.repairVehicle(w, p, v, slotOf(w, p, id("repair_kit")))).toBe("number");
    expect(w.get(v, G.Vehicle)!.health).toBeGreaterThan(max * 0.2);
    // Wrecked at a garage: the engine part revives it and restores full max health.
    w.setField(v, G.Vehicle, "health", 0);
    G.spawnStation(w, G.StationKind.Garage, 0, 1);
    expect(typeof G.repairVehicle(w, p, v, slotOf(w, p, id("engine_large")))).toBe("number");
    expect(w.get(v, G.Vehicle)!.health).toBeGreaterThan(0);
    expect(G.vehicleMaxHealth(w, v)).toBe(max);
    // A diesel part also fits the pontoon (class-gated, not def-gated).
    const po = boat(w, "pontoon", -3, 0); w.setField(po, G.Vehicle, "health", 0);
    G.addItem(w, p, id("engine_diesel"), 1);
    expect(typeof G.repairVehicle(w, p, po, slotOf(w, p, id("engine_diesel")))).toBe("number");
  });
});

describe("ADR-422 motorboats on water", () => {
  it("a speedboat crosses deep water near maxSpeed", () => {
    const w = waterWorld(); const p = player(w, 30, 0); const v = boat(w, "speedboat", 30, 0);
    expect(G.enterVehicle(w, p, v)).toBeUndefined();
    drive(w, p, 1, 0, 60); // 3 s: far enough to prove the speed, short of the x = 61 shore
    expect(w.get(v, G.Vehicle)!.speed).toBeCloseTo(def("speedboat").maxSpeed, 0);
    expect(w.get(v, Transform)!.x).toBeGreaterThan(45);
    expect(depthAt(w, w.get(v, Transform)!.x, 0)).not.toBe(WaterDepth.None);
  });

  it("a motorboat driven at the shore beaches and stops — it never clips onto land", () => {
    const w = waterWorld(); const p = player(w, 30, 0); const v = boat(w, "motorboat", 30, 0);
    expect(G.enterVehicle(w, p, v)).toBeUndefined();
    drive(w, p, 1, 0, 40);
    expect(w.get(v, G.Vehicle)!.speed).toBeCloseTo(def("motorboat").maxSpeed, 0);
    let lastX = 30;
    for (let i = 0; i < 20; i++) {
      drive(w, p, 1, 0, 20);
      const t = w.get(v, Transform)!;
      expect(depthAt(w, t.x, t.y)).not.toBe(WaterDepth.None); // never on a land tile, mid-drive
      expect(t.x).toBeLessThan(60.5); // the shore is at x = 61
      lastX = t.x;
    }
    expect(lastX).toBeGreaterThan(55); // it did reach the shore, then stopped
    drive(w, p, 1, 0, 40);
    expect(Math.abs(w.get(v, G.Vehicle)!.speed)).toBeLessThan(0.5); // beached: no way forward
    expect(w.get(v, Transform)!.x).toBeCloseTo(lastX, 0);
  });

  it("a pontoon moves in the shallows at ~0.55x — no shallow-water stall, even for the flat hull", () => {
    // The natural shallow band (tiles 10-11) is narrower than the pontoon's 2.4-tile beam, so this
    // world paints an explicit shallow band (tile 8, always shallow) at x 20..24 instead.
    const w = makeWorld();
    const map = new TileMap();
    for (let y = -48; y <= 48; y++) for (let x = -32; x <= 128; x++) map.setTile(x, y, 3);
    for (let y = -48; y <= 48; y++) for (let x = 10; x <= 60; x++) map.setTile(x, y, 1);
    for (let y = -48; y <= 48; y++) for (let x = 20; x <= 24; x++) map.setTile(x, y, 8);
    w.setResource(G.TerrainRes, G.terrainFromTileMap(map));
    const q = player(w, 22, 0); const v = boat(w, "pontoon", 22, 0, Math.PI / 2);
    expect(G.enterVehicle(w, q, v)).toBeUndefined();
    drive(w, q, 0, 1, 40); // facing north: stays in the shallow band
    const shallowSpeed = w.get(v, G.Vehicle)!.speed;
    expect(shallowSpeed).toBeGreaterThan(2.0); expect(shallowSpeed).toBeLessThan(3.5); // ~5.0 x 0.55
    expect(depthAt(w, w.get(v, Transform)!.x, w.get(v, Transform)!.y)).toBe(WaterDepth.Shallow);
  });
});

describe("ADR-422 AI motorboats", () => {
  it("fillVehicleSensors reports a motorboat's real fuel fraction and pickRide offers it; a bot boards, drives, and spends no stamina", () => {
    const w = waterWorld();
    const self = spawnLearned(w, { x: 30, y: 0, maxWeight: 0, clientId: 9 });
    w.add(self, NetId, { id: ++nid });
    const v = boat(w, "motorboat", 32, 0);
    w.setField(v, G.Vehicle, "fuel", def("motorboat").fuel!.capacity * 0.5);
    const view = { home: { x: 0, y: 0 } } as unknown as G.AgentWorldView;
    G.fillVehicleSensors(w, self, view);
    const seen = view.vehicles!.find((s) => s.cls === "boat");
    expect(seen).toBeDefined(); expect(seen!.fuel).toBeCloseTo(0.5); // real fraction, not the paddle-boat 1
    expect(seen!.parked).toBe(true);
    expect(G.pickRide(view)).toBe(seen);
    expect(G.enterVehicle(w, self, v)).toBeUndefined();
    const stamina0 = w.get(self, G.Survival)!.stamina;
    drive(w, self, 1, 0, 40);
    expect(w.get(v, Transform)!.x).toBeGreaterThan(32); // the bot motored east
    expect(w.get(self, G.Survival)!.stamina).toBe(stamina0); // an engine, not paddling: no stamina cost
    expect(w.get(v, G.Vehicle)!.fuel).toBeLessThan(def("motorboat").fuel!.capacity * 0.5); // ... but the tank drained
  });
});
