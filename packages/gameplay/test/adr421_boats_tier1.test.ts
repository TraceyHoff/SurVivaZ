// ADR-421: tier-1 boats (raft, canoe, rowboat) — paddle boats as a vehicle class.
// Defs (ids 40-42, append-only), stamina-not-fuel validation, dock crafting, water-only deploy
// and movement (boats move on water, stop at the shore, never clip onto land), boarding / safe
// dismount onto the shore, AI sensors + the water-crossing "boat" decision, and the no-hitch /
// no-engine guards. No sinking in this slice; beaching = stop.
import { describe, expect, it } from "vitest";
import { NetId, Transform, type Entity, type World } from "@engine/core";
import { TileMap, WaterDepth } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned } from "./helpers.js";

const d = G.defaultDefs();
const id = (k: string): number => d.itemId(k);
let nid = 4200;
const net = (w: World, e: Entity): Entity => { w.add(e, NetId, { id: ++nid }); return e; };
const player = (w: World, x = 0, y = 0): Entity => net(w, G.spawnPlayer(w, { x, y, maxWeight: 0, clientId: 1 }));
const boat = (w: World, bid: string, x = 30, y = 0, h = 0): Entity => net(w, G.spawnVehicle(w, bid, x, y, h));
const slotOf = (w: World, p: Entity, item: number): number => { const v = G.readSlots(w, p); for (let i = 0; i < v.slotCount; i++) if (v.item(i) === item && v.count(i)) return i; return -1; };
const drive = (w: World, p: Entity, x: number, y: number, n = 1): void => { for (let i = 0; i < n; i++) { G.setDriveInput(w, p, x, y, false); w.step(1 / 20); } };

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

describe("ADR-421 boat defs", () => {
  it("appends raft/canoe/rowboat (ids 40-42) as class boat; validation, storage and art geometry agree", () => {
    expect(G.VEHICLE_DEFS.length).toBe(46); // ADR-421: +3 paddle boats (ids 40-42); ADR-422: +3 motorboats (ids 43-45); ADR-479: +1 sailboat (id 46)
    expect(["raft", "canoe", "rowboat"].map((b) => G.vehicleDefId(b))).toEqual([40, 41, 42]);
    expect(G.VEHICLE_CLASSES).toContain("boat");
    expect(G.validateVehicleDefs(G.VEHICLE_DEFS)).toEqual([]);
    for (const b of ["raft", "canoe", "rowboat"]) {
      const def = G.VEHICLE_DEFS.find((x) => x.id === b)!;
      expect(def.class).toBe("boat"); expect(G.isBoatDef(def)).toBe(true);
      expect(def.fuel).toBeNull(); expect(def.stamina).not.toBeNull(); // paddling, never a fuel tank
      expect(def.hitches).toEqual([]); // nothing tows a boat, no boat tows anything
      expect(def.seats).toBeGreaterThanOrEqual(2);
    }
    // The trade-offs, fixed: raft slowest + biggest storage, canoe fastest + lightest, rowboat the middle.
    const cap = (b: string): { slots: number; maxWeight: number } => G.storageCapacity(G.VEHICLE_DEFS.find((x) => x.id === b)!);
    expect(cap("raft").slots).toBe(24); expect(cap("raft").maxWeight).toBe(600);
    expect(cap("canoe").slots).toBe(8); expect(cap("canoe").maxWeight).toBe(120);
    expect(cap("rowboat").slots).toBe(16); expect(cap("rowboat").maxWeight).toBe(300);
    const speed = (b: string): number => G.VEHICLE_DEFS.find((x) => x.id === b)!.maxSpeed;
    expect(speed("canoe")).toBeGreaterThan(speed("rowboat"));
    expect(speed("rowboat")).toBeGreaterThan(speed("raft"));
    expect(speed("canoe")).toBeGreaterThan(2.9); // faster than walking, ~4x swim speed (2.9 x 0.35)
    expect(G.VEHICLE_STORAGE.max.boat).toBe(36); expect(G.VEHICLE_STORAGE.scale.boat).toBe(2);
  });

  it("validation carve-out: a boat with fuel, or without stamina, fails; a boat with drawn fails", () => {
    const raft = G.VEHICLE_DEFS.find((x) => x.id === "raft")!;
    expect(G.validateVehicleDefs([{ ...raft, fuel: { capacity: 10, perSecond: 1 } }])).toEqual(["vehicle raft: boats use exactly one of fuel (motor), stamina (paddling), sail (wind)"]);
    expect(G.validateVehicleDefs([{ ...raft, stamina: null }])).toEqual(["vehicle raft: boats use exactly one of fuel (motor), stamina (paddling), sail (wind)"]);
    expect(G.validateVehicleDefs([{ ...raft, drawn: { pullMul: 1 } }])).toEqual(["vehicle raft: drawn is only for wagon/cart/carriage/chariot"]);
  });

  it("crafting: dock recipes, kit + fuel consistency, no tank, repair_kit fits every boat", () => {
    const w = makeWorld(); expect(G.validateVehicleCraft(w)).toEqual([]);
    for (const b of ["raft", "canoe", "rowboat"]) {
      const kit = G.vehicleKitKey(b)!; expect(kit).toBe(`vehicle_kit_${b}`);
      const r = [...d.recipes.values()].find((x) => d.items.get(x.output.item)?.key === kit)!;
      expect(r).toBeDefined(); expect(r.station).toBe(G.StationKind.Dock); expect(r.seconds).toBeGreaterThan(0);
      expect(G.VEHICLE_CRAFT.vehicles[b]!.fuel).toBe("none");
    }
    const p = player(w); const v = boat(w, "canoe", 0, 0);
    G.addItem(w, p, id("gasoline"), 1);
    expect(G.validateRefuel(w, p, v, slotOf(w, p, id("gasoline")))).toBe("no_tank");
    expect(G.setVehicleToggle(w, p, v, G.VEHICLE_ENGINE_ON, 1)).toBe("no_controls");
    expect(w.has(v, G.VehicleState)).toBe(false); // boats carry no engine/lights state
    // A damaged boat takes a generic repair_kit (classes [] = all classes).
    w.setField(v, G.Vehicle, "health", 50);
    G.addItem(w, p, id("repair_kit"), 1);
    expect(typeof G.repairVehicle(w, p, v, slotOf(w, p, id("repair_kit")))).toBe("number");
    expect(w.get(v, G.Vehicle)!.health).toBeGreaterThan(50);
  });
});

describe("ADR-421 deploy on water only", () => {
  it("boat kits deploy on shallow and deep water, never on land; motor kits still deploy on land", () => {
    const w = waterWorld(); const p = player(w, 8, 0);
    G.addItem(w, p, id("vehicle_kit_raft"), 2);
    const s = slotOf(w, p, id("vehicle_kit_raft"));
    expect(G.validateDeploy(w, p, s, 5, 0)).toBe("not_water"); // land, in reach
    expect(G.deployVehicleKit(w, p, s, 5, 0)).toBe("not_water");
    expect(G.countItem(w, p, id("vehicle_kit_raft"))).toBe(2); // refused deploy spends nothing
    const shallow = G.deployVehicleKit(w, p, s, 11, 0) as Entity; // shallow water (tile 11, bank at 9)
    expect(typeof shallow).toBe("number"); expect(G.vehicleDefOf(w, shallow)!.id).toBe("raft");
    expect(depthAt(w, 11, 0)).toBe(WaterDepth.Shallow);
    expect(G.countItem(w, p, id("vehicle_kit_raft"))).toBe(1);
    // Deep water, further out — the player walks to the bank first (deploy reach is 4).
    const q = player(w, 30, 0); G.addItem(w, q, id("vehicle_kit_canoe"), 1);
    const deep = G.deployVehicleKit(w, q, slotOf(w, q, id("vehicle_kit_canoe")), 32, 0) as Entity;
    expect(typeof deep).toBe("number"); expect(depthAt(w, 32, 0)).toBe(WaterDepth.Deep);
    // A motor kit still deploys on land.
    G.addItem(w, p, id("vehicle_kit_car_sedan"), 1);
    const car = G.deployVehicleKit(w, p, slotOf(w, p, id("vehicle_kit_car_sedan")), 5, 0) as Entity;
    expect(typeof car).toBe("number"); expect(G.vehicleDefOf(w, car)!.id).toBe("car_sedan");
  });
});

describe("ADR-421 water-only movement", () => {
  it("a canoe crosses deep water near maxSpeed, runs slower in the shallows, and drains stamina", () => {
    const w = waterWorld(); const p = player(w, 30, 0); const v = boat(w, "canoe", 30, 0);
    expect(G.enterVehicle(w, p, v)).toBeUndefined();
    const s0 = w.get(p, G.Survival)!.stamina;
    drive(w, p, 1, 0, 100);
    const deep = w.get(v, G.Vehicle)!;
    expect(deep.speed).toBeCloseTo(G.VEHICLE_DEFS.find((x) => x.id === "canoe")!.maxSpeed, 0);
    expect(w.get(v, Transform)!.x).toBeGreaterThan(45);
    expect(depthAt(w, w.get(v, Transform)!.x, 0)).not.toBe(WaterDepth.None);
    expect(w.get(p, G.Survival)!.stamina).toBeLessThan(s0); // paddling costs stamina
    // Shallows: same boat, same input, ~0.55x the speed — drive north along the bank so the boat
    // stays in the shallow strip (tiles 10-11) instead of crossing into deep water.
    const w2 = waterWorld(); const q = player(w2, 10.5, 0); const v2 = boat(w2, "canoe", 10.5, 0, Math.PI / 2);
    expect(G.enterVehicle(w2, q, v2)).toBeUndefined();
    drive(w2, q, 0, 1, 40); // already facing north: no turn carries it east into deep water
    const shallowSpeed = w2.get(v2, G.Vehicle)!.speed;
    expect(shallowSpeed).toBeGreaterThan(1.8); expect(shallowSpeed).toBeLessThan(2.8); // ~4.2 x 0.55
    expect(depthAt(w2, w2.get(v2, Transform)!.x, w2.get(v2, Transform)!.y)).toBe(WaterDepth.Shallow);
  });

  it("a boat driven at the shore beaches and stops — it never clips onto land", () => {
    const w = waterWorld(); const p = player(w, 30, 0); const v = boat(w, "canoe", 30, 0);
    expect(G.enterVehicle(w, p, v)).toBeUndefined();
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

  it("a boat on land cannot move at all (beached = 0 water drag)", () => {
    const w = waterWorld(); const p = player(w, 0, 0); const v = boat(w, "raft", 0, 0);
    expect(G.enterVehicle(w, p, v)).toBeUndefined();
    drive(w, p, 1, 0, 40);
    expect(w.get(v, Transform)!.x).toBe(0); expect(w.get(v, Transform)!.y).toBe(0);
    expect(w.get(v, G.Vehicle)!.speed).toBe(0);
  });

  it("boatPoseBlocked: open water is free, any footprint point on land blocks", () => {
    const w = waterWorld(); const def = G.VEHICLE_DEFS.find((x) => x.id === "canoe")!;
    expect(G.boatPoseBlocked(w, def, 30, 0, 0, 31, 0, 0)).toBe(false);
    expect(G.boatPoseBlocked(w, def, 30, 0, 0, 61, 0, 0)).toBe(true);
    expect(G.boatWaterMul(w, 30, 0)).toBe(1);
    expect(G.boatWaterMul(w, 11, 0)).toBeCloseTo(0.55);
    expect(G.boatWaterMul(w, 0, 0)).toBe(0);
  });
});

describe("ADR-421 boarding, dismount and hitching", () => {
  it("a rider exits a boat onto the shore when the shore is the near side; mid-lake exits land in the water", () => {
    const w = waterWorld();
    // Boat nosed at the west bank, left side to land: the legacy exit point is a land tile.
    const p = player(w, 9, 0); const v = boat(w, "rowboat", 11, 0, Math.PI / 2);
    expect(G.enterVehicle(w, p, v)).toBeUndefined();
    expect(G.exitVehicle(w, p)).toBeUndefined();
    const spot = w.get(p, Transform)!;
    expect(depthAt(w, spot.x, spot.y)).toBe(WaterDepth.None); // on the shore, not swimming
    expect(w.has(p, G.Driver)).toBe(false);
    // Mid-lake: the exit still succeeds (the rider can swim), landing in water, never on an unchecked tile.
    const q = player(w, 30, 0); const v2 = boat(w, "rowboat", 30, 0, 0);
    expect(G.enterVehicle(w, q, v2)).toBeUndefined();
    expect(G.exitVehicle(w, q)).toBeUndefined();
    const wet = w.get(q, Transform)!;
    expect(depthAt(w, wet.x, wet.y)).not.toBe(WaterDepth.None);
  });

  it("boats cannot be hitched to a mount or a motor tow, and cannot tow", () => {
    const w = makeWorld(); const p = player(w, 0, 0);
    const b = boat(w, "rowboat", 0, 0); const car = net(w, G.spawnVehicle(w, "truck_pickup", -4, 0));
    expect(G.validateHitch(w, p, b, car)).toBe("no_hitch"); // a boat has no front hitch
    const trailer = net(w, G.spawnVehicle(w, "trailer_utility_small", 4, 0));
    expect(G.validateHitch(w, p, trailer, b)).toBe("no_hitch"); // a boat has no rear hitch either
  });

  it("a second rider boards as a passenger (seat 254) without taking the driver seat", () => {
    const w = waterWorld(); const p = player(w, 30, 0); const q = player(w, 31, 0);
    const v = boat(w, "rowboat", 30, 0);
    expect(G.enterVehicle(w, p, v)).toBeUndefined(); // driver (key-holder path: seat 255 -> seat 0)
    expect(G.enterVehicleAsPassenger(w, q, v)).toBeUndefined();
    expect(w.getField(q, G.Driver, "seat")).toBeGreaterThanOrEqual(1);
    expect(w.get(p, Transform)!.x).toBeCloseTo(w.get(v, Transform)!.x, 5);
  });
});

describe("ADR-421 AI boats", () => {
  it("fillVehicleSensors sees boats and pickRide offers one; bots can board and drive it", () => {
    const w = waterWorld();
    const self = spawnLearned(w, { x: 30, y: 0, maxWeight: 0, clientId: 9 });
    w.add(self, NetId, { id: ++nid });
    const v = boat(w, "canoe", 32, 0);
    const view = { home: { x: 0, y: 0 } } as unknown as G.AgentWorldView;
    G.fillVehicleSensors(w, self, view);
    const seen = view.vehicles!.find((s) => s.cls === "boat");
    expect(seen).toBeDefined(); expect(seen!.fuel).toBe(1); expect(seen!.parked).toBe(true);
    expect(G.pickRide(view)).toBe(seen);
    expect(G.enterVehicle(w, self, v)).toBeUndefined();
    drive(w, self, 1, 0, 40);
    expect(w.get(v, Transform)!.x).toBeGreaterThan(32); // the bot paddled east
  });

  it("decideCrossing prefers a boat over swimming a long deep run; a cold bot still waits", () => {
    const SPEEDS: G.CrossingSpeeds = { foot: 2.9, ride: 5, wadeMul: 0.7, swimMul: 0.35 };
    const fit: G.CrossingBot = { riding: false, mountSwims: false, hp: 1, hunger: 1, thirst: 1, stamina: 100, staminaMax: 100, cold: false };
    const depths = [...Array<WaterDepth>(2).fill(WaterDepth.None), ...Array<WaterDepth>(30).fill(WaterDepth.Deep), ...Array<WaterDepth>(2).fill(WaterDepth.None)];
    const lake = G.profileFromDepths(depths, 34); // 30 deep tiles: far past the 12-tile swim cap
    expect(G.decideCrossing(lake, fit, SPEEDS)).toBe("around");
    expect(G.decideCrossing(lake, fit, SPEEDS, G.WATER_DATA, { boatAvailable: true })).toBe("boat");
    expect(G.decideCrossing(lake, { ...fit, riding: true }, SPEEDS, G.WATER_DATA, { boatAvailable: true })).toBe("around"); // a mounted bot never abandons its mount
    // No boat: the old five-way decision is unchanged (a short swim still swims).
    const river = G.profileFromDepths([...Array<WaterDepth>(2).fill(WaterDepth.None), ...Array<WaterDepth>(6).fill(WaterDepth.Deep)], 8);
    expect(G.decideCrossing(river, fit, SPEEDS)).toBe("swim");
    expect(G.decideCrossing(river, fit, SPEEDS, G.WATER_DATA, { boatAvailable: true })).toBe("boat");
    expect(G.decideCrossing(river, { ...fit, cold: true }, SPEEDS, G.WATER_DATA, { boatAvailable: true })).toBe("wait"); // an unfit bot waits even with a boat
  });
});
