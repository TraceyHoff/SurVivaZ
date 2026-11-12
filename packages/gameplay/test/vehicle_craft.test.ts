import { describe, expect, it } from "vitest";
import { idleOutput, NetId, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { collect, makeWorld, steps } from "./helpers.js";

const d = G.defaultDefs(); const id = (k: string) => d.itemId(k);
let nid = 500;
const net = (w: World, e: Entity): Entity => { w.add(e, NetId, { id: ++nid }); return e; };
const player = (w: World, x = 0, y = 0): Entity => net(w, G.spawnPlayer(w, { x, y, maxWeight: 0, clientId: 1 }));
const slotOf = (w: World, p: Entity, item: number): number => { const v = G.readSlots(w, p); for (let i = 0; i < v.slotCount; i++) if (v.item(i) === item && v.count(i)) return i; return -1; };

describe("vehicle crafting data", () => {
  it("every vehicle has a kit recipe at workbench/garage with craft time; costs scale with size; rules validate", () => {
    const w = makeWorld(); expect(G.validateVehicleCraft(w)).toEqual([]);
    const wb = G.StationKind.Workbench, gar = G.StationKind.Garage;
    const cost = new Map<string, number>();
    for (const v of G.VEHICLE_DEFS) {
      const kit = G.vehicleKitKey(v.id)!; expect(kit).toBe(`vehicle_kit_${v.id}`);
      const r = [...d.recipes.values()].find((x) => d.items.get(x.output.item)?.key === kit)!; expect(r).toBeDefined();
      expect([wb, gar]).toContain(r.station); expect(r.seconds).toBeGreaterThan(0);
      if (v.class !== "bicycle" && v.class !== "trailer" && !G.isDrawnDef(v)) expect(r.station).toBe(gar); // ADR-358: wooden drawn vehicles craft at the workbench
      cost.set(v.id, r.ingredients.reduce((a: number, i) => a + i.count, 0));
    }
    const avg = (s: G.VehicleSize) => { const xs = G.VEHICLE_DEFS.filter((v) => v.size === s); return xs.reduce((a, v) => a + cost.get(v.id)!, 0) / xs.length; };
    for (let i = 1; i < G.VEHICLE_SIZES.length; i++) expect(avg(G.VEHICLE_SIZES[i]!)).toBeGreaterThan(avg(G.VEHICLE_SIZES[i - 1]!));
    for (const v of G.VEHICLE_DEFS) expect(G.storageCapacity(v).slots).toBeLessThanOrEqual(G.CONTAINER_MAX_SLOTS);
    for (const f of ["gasoline", "diesel", "biofuel"]) expect([...d.recipes.values()].some((r) => d.items.get(r.output.item)?.key === f)).toBe(true);
  });
});

describe("deploy / refuel / repair", () => {
  it("deploys a kit as a vehicle, consuming it and recording the crafter", () => {
    const w = makeWorld(); const p = player(w); const ev = collect(w, G.VehicleDeployed);
    G.addItem(w, p, id("vehicle_kit_car_sedan"), 1, 77); const s = slotOf(w, p, id("vehicle_kit_car_sedan"));
    expect(G.deployVehicleKit(w, p, s, 50, 0)).toBe("too_far");
    const v = G.deployVehicleKit(w, p, s, 2, 0) as Entity; expect(typeof v).toBe("number");
    expect(G.vehicleDefOf(w, v)!.id).toBe("car_sedan"); expect(G.vehicleCrafter(w, v)).toBe(77); expect(G.countItem(w, p, id("vehicle_kit_car_sedan"))).toBe(0);
    expect(w.get(v, G.Vehicle)!.fuel).toBeCloseTo(G.vehicleDefOf(w, v)!.fuel!.capacity * G.VEHICLE_CRAFT.deploy.startFuel);
    w.step(1 / 20); expect(ev).toHaveLength(1);
    G.addItem(w, p, id("wood"), 1); expect(G.validateDeploy(w, p, slotOf(w, p, id("wood")), 1, 0)).toBe("not_kit");
  });
  it("refuels with matching fuel only; biofuel fits both; bikes have no tank", () => {
    const w = makeWorld(); const p = player(w); const car = net(w, G.spawnVehicle(w, "car_sedan", 1, 0)); const truck = net(w, G.spawnVehicle(w, "truck_flatbed", -3, 0)); const bike = net(w, G.spawnVehicle(w, "bike_basic", 0, 2));
    w.setField(car, G.Vehicle, "fuel", 0); w.setField(truck, G.Vehicle, "fuel", 0);
    G.addItem(w, p, id("diesel"), 5); G.addItem(w, p, id("gasoline"), 5); G.addItem(w, p, id("biofuel"), 5);
    expect(G.refuelVehicle(w, p, car, slotOf(w, p, id("diesel")), 1)).toBe("wrong_fuel");
    expect(G.refuelVehicle(w, p, car, slotOf(w, p, id("gasoline")), 3)).toBe(3); expect(G.countItem(w, p, id("gasoline"))).toBe(2);
    expect(G.refuelVehicle(w, p, truck, slotOf(w, p, id("biofuel")), 2)).toBe(2);
    expect(G.refuelVehicle(w, p, bike, slotOf(w, p, id("gasoline")), 1)).toBe("no_tank");
  });
  it("field repair wears max health; garage repair restores it; wrecks need a garage part", () => {
    const w = makeWorld(); const p = player(w); const car = net(w, G.spawnVehicle(w, "car_sedan", 1, 0)); const max = G.vehicleDefOf(w, car)!.health;
    w.setField(car, G.Vehicle, "health", max * 0.2); G.addItem(w, p, id("repair_kit"), 1);
    const hp = G.repairVehicle(w, p, car, slotOf(w, p, id("repair_kit"))) as number;
    expect(hp).toBeGreaterThan(max * 0.2); expect(G.vehicleMaxHealth(w, car)).toBeLessThan(max);
    w.setField(car, G.Vehicle, "health", 0); expect(G.validateRepair(w, p, car, slotOf(w, p, id("repair_kit")))).toBe("wrecked");
    G.spawnStation(w, G.StationKind.Garage, 0, 1); G.addItem(w, p, id("engine_medium"), 1);
    const key = Object.entries(G.VEHICLE_CRAFT.repair.items).find(([, r]) => r.wreckOk && (!r.classes.length || r.classes.includes("car")))![0];
    G.addItem(w, p, id(key), 1); expect(typeof G.repairVehicle(w, p, car, slotOf(w, p, id(key)))).toBe("number");
    expect(G.vehicleMaxHealth(w, car)).toBe(max);
  });
});

describe("camper stations", () => {
  it("a parked camper interior counts as workbench + campfire for crafting, and fires the station hook", () => {
    const w = makeWorld(); const p = player(w); const v = net(w, G.spawnVehicle(w, "camper_van", 2, 0)); const ev = collect(w, G.VehicleStationOpened);
    expect(G.nearbyVehicleStationKinds(w, p).has(G.StationKind.Workbench)).toBe(true);
    const r = [...d.recipes.values()].find((x) => x.station === G.StationKind.Workbench)!;
    for (const i of r.ingredients) G.addItem(w, p, i.item, i.count);
    const failed = collect(w, G.CraftFailed); G.setIntent(w, p, { action: G.IntentAction.Craft, recipe: r.id }); steps(w, 2);
    expect(failed.filter((f) => f.reason === G.CraftFail.NoStation)).toHaveLength(0);
    expect(G.useVehicleStation(w, p, v, 0)).toBeUndefined(); w.step(1 / 20); expect(ev).toHaveLength(1);
  });
});

describe("bot driving", () => {
  it("vehicle action strings become net commands", () => {
    const out = { ...idleOutput(), actions: ["venter:9", "vexit", "vhitch:3:4", "vrefuel:9:2:5", "vrepair:9:1", "vdeploy:0:1:2:0"] };
    G.emitAgentCommands(out); expect(out.actions).toEqual([]);
    expect(out.commands!.map((c) => c.type)).toEqual(["gameplay.vehicleEnter", "gameplay.vehicleExit", "gameplay.vehicleHitch", "gameplay.vehicleRefuel", "gameplay.vehicleRepair", "gameplay.vehicleDeploy"]);
  });
  it("sensors see vehicles; brave bots drive toward far goals, timid bots never do; low-fuel triggers refuel", () => {
    const w = makeWorld(); const p = player(w); const v = net(w, G.spawnVehicle(w, "car_sedan", 3, 0));
    G.addItem(w, p, id("gasoline"), 4); w.setField(v, G.Vehicle, "fuel", G.vehicleDefOf(w, v)!.fuel!.capacity * 0.1);
    const view = { driveGoal: { x: 200, y: 0 } } as G.AgentWorldView; G.fillVehicleSensors(w, p, view);
    expect(view.vehicles![0]!.id).toBe(v); expect(view.vehicles![0]!.fuelSlot).toBe(slotOf(w, p, id("gasoline")));
    const [drive, service] = G.vehicleBehaviors();
    const ctx = (bravery: number) => ({ world: view, traits: { bravery, industriousness: 0.8 }, self: { x: 0, y: 0, tick: 100, stamina: 1 }, bb: { num: (_k: string, f: number) => f, set: () => {} } }) as never;
    const score = (b: G.GameBehavior, c: never) => b.considerations.every((k) => k.input(c) >= 0.5);
    expect(score(drive!, ctx(0.9))).toBe(true); expect(score(drive!, ctx(0.1))).toBe(false);
    expect(score(service!, ctx(0.5))).toBe(true);
    const o = { ...idleOutput(), actions: [] as string[] }; service!.run(ctx(0.5), o); expect(o.moveX).toBeGreaterThan(0);
    void Transform;
  });
});
