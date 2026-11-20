// ADR-479: sailboat — a wind-driven boat (third boat kind: sail, no fuel, no stamina).
// Def (appended last, id 46), the fuel/stamina/sail validation split, sailFactor, the dock kit
// recipe, no engine/lights, and driven behaviour: ~2x paddle speed downwind, a paddle crawl
// upwind or in calm air, no stamina drain while sailing.
import { describe, expect, it } from "vitest";
import { NetId, setTimeOfDay, Transform, Weather, type Entity, type World } from "@engine/core";
import { TileMap } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";
import vehicleRecipesRaw from "../data/vehicle_recipes.json";

const d = G.defaultDefs();
const id = (k: string): number => d.itemId(k);
let nid = 4790;
const net = (w: World, e: Entity): Entity => { w.add(e, NetId, { id: ++nid }); return e; };
const player = (w: World, x = 0, y = 0): Entity => net(w, G.spawnPlayer(w, { x, y, maxWeight: 0, clientId: 1 }));
const boat = (w: World, bid: string, x = 30, y = 0, h = 0): Entity => net(w, G.spawnVehicle(w, bid, x, y, h));
const drive = (w: World, p: Entity, x: number, y: number, n = 1, boost = false): void => { for (let i = 0; i < n; i++) { G.setDriveInput(w, p, x, y, boost); w.step(1 / 20); } };
const def = (b: string): G.VehicleDef => G.VEHICLE_DEFS.find((x) => x.id === b)!;

/** Land tile 3 x -32..128, y -48..48, with water tile 1 in x 10..60 (deep in the middle, shallow at the banks). */
function waterWorld(): World {
  const w = makeWorld();
  const map = new TileMap();
  for (let y = -48; y <= 48; y++) for (let x = -32; x <= 128; x++) map.setTile(x, y, 3);
  for (let y = -48; y <= 48; y++) for (let x = 10; x <= 60; x++) map.setTile(x, y, 1);
  w.setResource(G.TerrainRes, G.terrainFromTileMap(map));
  return w;
}
/** Pin the wind for a drive test (endsAtTick never ends, so the weather system never re-rolls it). */
const pinWind = (w: World, windDir: number, windSpeed: number): void => {
  setTimeOfDay(w, 12, 1);
  Object.assign(w.env(Weather), { kind: "clear", intensity: 1, endsAtTick: 0xffffffff, windSpeed, windDir });
};

describe("ADR-479 sailboat def", () => {
  it("appends sailboat (id 46) as class boat with sail, no fuel, no stamina; validation is clean", () => {
    expect(G.VEHICLE_DEFS.length).toBe(46);
    expect(G.vehicleDefId("sailboat")).toBe(46);
    expect(G.validateVehicleDefs(G.VEHICLE_DEFS)).toEqual([]);
    const s = def("sailboat");
    expect(s.class).toBe("boat"); expect(G.isBoatDef(s)).toBe(true);
    expect(G.isSailBoatDef(s)).toBe(true);
    expect(G.isMotorBoatDef(s)).toBe(false); expect(G.isPaddleBoatDef(s)).toBe(false);
    expect(s.fuel).toBeNull(); expect(s.stamina).toBeNull(); expect(s.sail).toBe(true);
    expect(s.hitches).toEqual([]); // nothing tows a boat, no boat tows anything
    for (const b of ["raft", "canoe", "rowboat"]) {
      expect(G.isSailBoatDef(def(b))).toBe(false); expect(G.isPaddleBoatDef(def(b))).toBe(true);
    }
    for (const b of ["motorboat", "pontoon", "speedboat"]) {
      expect(G.isSailBoatDef(def(b))).toBe(false); expect(G.isMotorBoatDef(def(b))).toBe(true);
    }
  });
  it("geometry + storage: paddle-equivalent base speed, 4 seats, rowboat-size storage", () => {
    const s = def("sailboat");
    expect(s.maxSpeed).toBe(3.0); expect(s.seats).toBe(4); expect(s.seatAnchors).toHaveLength(4);
    expect(s.footprint).toEqual({ length: 3.6, width: 1.5 }); expect(s.health).toBe(220);
    expect(s.storage).toEqual({ slots: 8, maxWeight: 300 }); // def value; boat scale 2x -> 16 effective, same as the rowboat
    expect(G.storageCapacity(s)).toEqual(G.storageCapacity(def("rowboat")));
  });
});

describe("ADR-479 boat validation (fuel / stamina / sail)", () => {
  it("a boat uses exactly one of fuel, stamina, sail — two of three, or sail off a boat, is rejected", () => {
    const base = def("sailboat");
    const sailFuel = { ...base, fuel: { capacity: 10, perSecond: 0.1 } };
    const sailStamina = { ...base, stamina: { perSecond: 1 } };
    const carSail = { ...def("car_compact"), sail: true } as G.VehicleDef;
    const motorPaddle = { ...def("rowboat"), fuel: { capacity: 10, perSecond: 0.1 } };
    expect(G.validateVehicleDefs([sailFuel])).toHaveLength(2); // exactly-one + sailboats have no fuel
    expect(G.validateVehicleDefs([sailStamina])).toHaveLength(2); // exactly-one + sailboats have no stamina
    expect(G.validateVehicleDefs([carSail])).toEqual(expect.arrayContaining([expect.stringContaining("sail is only for boats")]));
    expect(G.validateVehicleDefs([motorPaddle]).length).toBeGreaterThan(0);
    expect(G.validateVehicleDefs(G.VEHICLE_DEFS)).toEqual([]);
  });
});

describe("ADR-479 sailFactor", () => {
  it("a full tailwind at windSpeed 12 doubles the base speed; headwind, beam wind and calm leave the 0.25x crawl", () => {
    expect(G.sailFactor(0, 12, 0)).toBeCloseTo(2, 10); // east wind, heading east
    expect(G.sailFactor(0, 12, Math.PI)).toBeCloseTo(0.25, 10); // headwind
    expect(G.sailFactor(0, 12, Math.PI / 2)).toBeCloseTo(0.25, 10); // beam wind
    expect(G.sailFactor(0, 0, 0)).toBeCloseTo(0.25, 10); // calm air
    expect(G.sailFactor(Math.PI / 2, 12, Math.PI / 2)).toBeCloseTo(2, 10); // north wind, heading north
  });
  it("the factor scales with wind speed and caps at the reference speed", () => {
    expect(G.sailFactor(0, 6, 0)).toBeCloseTo(1.125, 10); // half wind: 0.25 + 1.75 * 0.5
    expect(G.sailFactor(0, 30, 0)).toBeCloseTo(2, 10); // over the ref speed: capped
    expect(G.sailFactor(0, 12, Math.PI / 4)).toBeCloseTo(0.25 + 1.75 * Math.cos(Math.PI / 4), 10); // quartering wind
  });
});

describe("ADR-479 sailboat kit + dock recipe", () => {
  it("kitVehicle maps the sailboat kit to the def; other kits are untouched", () => {
    const w = makeWorld();
    expect(G.kitVehicle(w, id("vehicle_kit_sailboat"))).toBe("sailboat");
    expect(G.kitVehicle(w, id("vehicle_kit_rowboat"))).toBe("rowboat");
    expect(G.kitVehicle(w, id("vehicle_kit_motorboat"))).toBe("motorboat");
    expect(G.kitVehicle(w, id("wood"))).toBeUndefined();
  });
  it("the kit is crafted at the dock in 120 s: planks, wood, cloth for the sail, rope, seats", () => {
    const rec = (vehicleRecipesRaw as { recipes: { key: string; station: string; seconds: number; ingredients: { item: string; count: number }[]; output: { item: string; count: number } }[] }).recipes.find((r) => r.key === "vehicle_kit_sailboat")!;
    expect(rec.station).toBe("dock"); expect(rec.seconds).toBe(120);
    expect(rec.output).toEqual({ item: "vehicle_kit_sailboat", count: 1 });
    const ing = new Map(rec.ingredients.map((i) => [i.item, i.count]));
    expect(ing.get("planks")).toBe(12); expect(ing.get("wood")).toBe(6);
    expect(ing.get("cloth")).toBe(4); expect(ing.get("rope")).toBe(4); expect(ing.get("seat")).toBe(2);
  });
});

describe("ADR-479 sailboat has no engine", () => {
  it("spawn adds no VehicleState and the engine toggle refuses with no_controls", () => {
    const w = waterWorld(); const p = player(w, 30, 0); const v = boat(w, "sailboat", 30, 0);
    expect(w.has(v, G.VehicleState)).toBe(false);
    expect(G.enterVehicle(w, p, v)).toBeUndefined();
    expect(G.setVehicleToggle(w, p, v, G.VEHICLE_ENGINE_ON, 1)).toBe("no_controls");
    expect(G.setVehicleToggle(w, p, v, G.VEHICLE_HEADLIGHTS, 1)).toBe("no_controls");
  });
  it("sailing drains no stamina (the wind is the engine, not the driver)", () => {
    const w = waterWorld(); const p = player(w, 30, 0); const v = boat(w, "sailboat", 30, 0, Math.PI / 2);
    pinWind(w, Math.PI / 2, 12); // north wind, heading north: full tailwind
    expect(G.enterVehicle(w, p, v)).toBeUndefined();
    const s0 = w.getField(p, G.Survival, "stamina")!;
    drive(w, p, 0, 1, 40); // 2 s at full throttle
    expect(w.getField(p, G.Survival, "stamina")!).toBeCloseTo(s0, 6);
    expect(w.get(v, G.Vehicle)!.speed).toBeGreaterThan(2); // and it is actually moving
  });
});

describe("ADR-479 sailboat on water", () => {
  it("downwind it reaches ~2x the paddle-equivalent speed (target 6 t/s)", () => {
    const w = waterWorld(); const p = player(w, 30, 0); const v = boat(w, "sailboat", 30, 0);
    pinWind(w, 0, 12); // east wind, heading east: full tailwind
    expect(G.enterVehicle(w, p, v)).toBeUndefined();
    drive(w, p, 1, 0, 80); // 4 s east (accel 1.4 reaches 5.6 of the 6.0 target)
    expect(w.get(v, G.Vehicle)!.speed).toBeGreaterThan(5.0);
    expect(w.get(v, Transform)!.x).toBeGreaterThan(40); // well into the lake, not beached
  });
  it("upwind it crawls at 0.25x (target 0.75 t/s) but still makes headway", () => {
    const w = waterWorld(); const p = player(w, 30, 0); const v = boat(w, "sailboat", 30, 0);
    pinWind(w, Math.PI, 12); // west wind, heading east: full headwind
    expect(G.enterVehicle(w, p, v)).toBeUndefined();
    drive(w, p, 1, 0, 80); // 4 s east
    expect(w.get(v, G.Vehicle)!.speed).toBeCloseTo(0.75, 1);
    expect(w.get(v, Transform)!.x).toBeGreaterThan(30); // still moving forward, never stranded
  });
  it("in calm air it crawls at the same 0.25x floor", () => {
    const w = waterWorld(); const p = player(w, 30, 0); const v = boat(w, "sailboat", 30, 0);
    pinWind(w, 0, 0); // no wind at all
    expect(G.enterVehicle(w, p, v)).toBeUndefined();
    drive(w, p, 1, 0, 80); // 4 s east
    expect(w.get(v, G.Vehicle)!.speed).toBeCloseTo(0.75, 1);
  });
});
