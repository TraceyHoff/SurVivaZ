import { describe, expect, it } from "vitest";
import { NetId, PlayerId, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import raw from "../data/vehicles.json";
import { collect, DT, makeWorld, spawnLearned } from "./helpers.js";

let nid = 1200;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };
const pid = (w: World, e: Entity, id: number): Entity => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); return e; };
function setup(): { w: World; p: Entity; id: (k: string) => number } {
  const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }); pid(w, p, 7); net(w, p);
  return { w, p, id: (k) => G.gameplayDefs(w).itemId(k) };
}
/** Horse at (1, 0) facing east; its rear pin sits at (-0.5, 0). ADR-359: harnessed, so it may tow (validateHitch "no_harness" otherwise). */
const horse = (w: World, p: Entity): Entity => {
  const m = net(w, G.makeMount(w, "animal_horse", 1, 0, p));
  const hid = G.gameplayDefs(w).itemId("harness"); G.addItem(w, p, hid, 1);
  const v = G.readSlots(w, p); let slot = -1; for (let i = 0; i < v.slotCount; i++) if (v.item(i) === hid) { slot = i; break; }
  if (slot < 0 || !G.harnessMount(w, p, m, slot)) throw new Error("ADR-358 setup: harnessing the horse failed");
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
const gallop = (w: World, p: Entity, n: number): void => { for (let i = 0; i < n; i++) { G.applyMovementInput(w, p, G.GameplayActions.MoveRight | G.GameplayActions.Sprint, DT); w.step(DT); } };

describe("ADR-358 drawn defs", () => {
  it("appends 9 defs (ids 31-39) after the 30 motor/trailer defs; every new class is covered", () => {
    expect(G.VEHICLE_DEFS.length).toBe(39);
    expect(G.vehicleDefId("bike_basic")).toBe(1); expect(G.vehicleDefId("semi_trailer_flatbed")).toBe(30);
    expect(["wagon_small", "wagon_small_covered", "wagon_medium", "wagon_medium_covered", "wagon_large", "wagon_large_covered", "cart", "carriage", "chariot"]
      .map((id) => G.vehicleDefId(id))).toEqual([31, 32, 33, 34, 35, 36, 37, 38, 39]);
    for (const c of ["wagon", "cart", "carriage", "chariot"]) { expect(G.VEHICLE_CLASSES).toContain(c); expect(G.VEHICLE_DEFS.some((d) => d.class === c)).toBe(true); }
    expect(G.validateVehicleDefs(G.VEHICLE_DEFS)).toEqual([]);
  });
  it("drawn defs are engineless, carry pullMul + cover flags, and validate them", () => {
    for (const d of G.VEHICLE_DEFS.filter((x) => G.isDrawnDef(x))) {
      expect(d.fuel).toBeNull(); expect(d.stamina).toBeNull(); expect(d.drawn!.pullMul).toBeGreaterThan(0); expect(d.drawn!.pullMul).toBeLessThanOrEqual(2);
      expect(d.maxSpeed).toBeGreaterThan(0); expect(d.hitches.some((h) => h.at === "front")).toBe(true);
    }
    expect(G.VEHICLE_DEFS.find((d) => d.id === "wagon_small_covered")!.covered).toBe(true);
    expect(G.VEHICLE_DEFS.find((d) => d.id === "wagon_small")!.covered).toBe(false);
    expect(G.VEHICLE_DEFS.find((d) => d.id === "cart")!.covered).toBeUndefined();
    const bad = structuredClone(raw) as { vehicles: G.VehicleDef[] };
    const w = bad.vehicles.find((d) => d.id === "wagon_small")!;
    expect(G.validateVehicleDefs([{ ...w, fuel: { capacity: 1, perSecond: 1 } }]).join()).toMatch(/no engine/);
    const noDrawn = { ...w }; delete (noDrawn as Partial<G.VehicleDef>).drawn;
    expect(G.validateVehicleDefs([noDrawn]).join()).toMatch(/pullMul/);
    expect(G.validateVehicleDefs([{ ...w, drawn: { pullMul: 0 } }]).join()).toMatch(/pullMul/);
    expect(G.validateVehicleDefs([{ ...bad.vehicles.find((d) => d.id === "cart")!, covered: true }]).join()).toMatch(/covered is only for wagons/);
    expect(G.validateVehicleDefs([{ ...bad.vehicles.find((d) => d.id === "car_sedan")!, drawn: { pullMul: 1 } }]).join()).toMatch(/drawn is only for/);
  });
  it("covered wagons share their uncovered twin's footprint, seats and storage", () => {
    for (const [open, covered] of [["wagon_small", "wagon_small_covered"], ["wagon_medium", "wagon_medium_covered"], ["wagon_large", "wagon_large_covered"]] as const) {
      const a = G.VEHICLE_DEFS.find((d) => d.id === open)!, b = G.VEHICLE_DEFS.find((d) => d.id === covered)!;
      expect(b.footprint).toEqual(a.footprint); expect(b.seats).toBe(a.seats); expect(b.storage).toEqual(a.storage); expect(b.seatAnchors).toEqual(a.seatAnchors);
      expect(b.mass).toBeGreaterThan(a.mass); // canvas + hoops
    }
  });
  it("storage grows with wagon size; a carriage carries less than a wagon of the same size; a chariot almost nothing", () => {
    const cap = (id: string): { slots: number; maxWeight: number } => G.storageCapacity(G.VEHICLE_DEFS.find((d) => d.id === id)!);
    expect(cap("wagon_large").slots).toBeGreaterThan(cap("wagon_medium").slots); expect(cap("wagon_medium").slots).toBeGreaterThan(cap("wagon_small").slots);
    expect(cap("carriage").slots).toBeLessThan(cap("wagon_medium").slots); expect(cap("carriage").maxWeight).toBeLessThan(cap("wagon_medium").maxWeight);
    expect(cap("chariot")).toEqual({ slots: 2, maxWeight: 40 }); expect(cap("cart").slots).toBe(8);
    for (const d of G.VEHICLE_DEFS.filter((x) => G.isDrawnDef(x))) expect(cap(d.id).slots).toBeLessThanOrEqual(G.VEHICLE_STORAGE.max[d.class]);
  });
  it("seat 0 is the front driver bench on every drawn vehicle", () => {
    for (const d of G.VEHICLE_DEFS.filter((x) => G.isDrawnDef(x))) {
      expect(d.seatAnchors.length).toBe(d.seats);
      expect(d.seatAnchors[0]!.x).toBeGreaterThan(0); // front
      expect(Math.max(...d.seatAnchors.map((a) => a.x)) - d.seatAnchors[0]!.x).toBeLessThanOrEqual(0.01 + 1e-9); // seat 0 is foremost (carriage: tied with seat 1)
    }
    expect(G.VEHICLE_DEFS.find((d) => d.id === "carriage")!.seats).toBe(4);
  });
});

describe("ADR-358 drawn speed rule (data, not a constant)", () => {
  it("chariot-with-horse at gallop beats the horse's walk and beats a wagon-with-horse at any gait", () => {
    const horseSp = G.mountSpeciesOfKey("horse");
    const cap = (id: string, gallop: boolean): number => G.drawnSpeedCap(G.VEHICLE_DEFS.find((d) => d.id === id)!, horseSp, gallop);
    expect(cap("chariot", true)).toBeCloseTo(11.5, 6); // min(11.5, 9.6 x 1.2)
    expect(cap("chariot", true)).toBeGreaterThan(G.mountSpecies(horseSp)!.walk); // 5.4
    expect(cap("chariot", true)).toBeGreaterThan(cap("wagon_large", true)); // 5.0
    expect(cap("wagon_large", false)).toBeCloseTo(5.4 * 0.55, 6); // walking horse pulls the big wagon slowly
    expect(cap("wagon_large", true)).toBeCloseTo(5.0, 6); // min(5.0, 9.6 x 0.55)
    expect(cap("cart", true)).toBeCloseTo(6.5, 6); // light cart, capped by its own maxSpeed
    expect(cap("carriage", true)).toBeGreaterThan(cap("wagon_large", true));
    const donkey = G.mountSpeciesOfKey("donkey");
    expect(G.drawnSpeedCap(G.VEHICLE_DEFS.find((d) => d.id === "chariot")!, donkey, true)).toBeCloseTo(6.9 * 1.2, 6);
    expect(G.drawnSpeedCap(G.VEHICLE_DEFS.find((d) => d.id === "bike_basic")!, horseSp, true)).toBe(0); // not drawn
  });
  it("drawnTowCap is undefined untowed and caps the mount while towing", () => {
    const { w, p } = setup(); const m = horse(w, p); const v = atPin(w, "wagon_medium");
    expect(G.drawnTowCap(w, m, true)).toBeUndefined();
    expect(G.rideMount(w, p, m)).toBe(true);
    expect(G.drawnTowCap(w, m, true)).toBeUndefined(); // ridden but nothing towed yet
    expect(G.hitchVehicles(w, p, v, m)).toBeUndefined();
    expect(G.drawnTowCap(w, m, true)).toBeCloseTo(5.5, 6); expect(G.drawnTowCap(w, m, false)).toBeCloseTo(5.4 * 0.62, 6);
  });
});

describe("ADR-358 mount hitch", () => {
  it("a mount can tow a drawn vehicle; motor tows and motor trailers are both incompatible", () => {
    const { w, p } = setup(); const m = horse(w, p); const v = atPin(w, "wagon_medium");
    expect(G.validateHitch(w, p, net(w, G.spawnVehicle(w, "wagon_small", -30, 0, 0)), m)).toBe("too_far"); // before anything is hitched
    expect(G.validateHitch(w, p, v, m)).toBeUndefined(); expect(G.hitchVehicles(w, p, v, m)).toBeUndefined();
    expect(w.getField(v, G.Hitch, "parentNetId")).toBe(w.getField(m, NetId, "id"));
    expect(w.getField(m, G.Hitch, "towNetId")).toBe(w.getField(v, NetId, "id"));
    expect(G.validateHitch(w, p, v, m)).toBe("already_hitched");
    const v2 = atPin(w, "cart"); expect(G.validateHitch(w, p, v2, m)).toBe("tow_busy");
    const truck = net(w, G.spawnVehicle(w, "truck_pickup", -2.9, 3, 0));
    expect(G.validateHitch(w, p, atPin(w, "wagon_small"), truck)).toBe("incompatible"); // motor cannot tow drawn
    expect(G.validateHitch(w, p, net(w, G.spawnVehicle(w, "trailer_utility_small", -3.3, 3, 0)), m)).toBe("incompatible"); // mount cannot tow a motor trailer
  });
  it("hitching while the mount moves is refused; unhitch clears both sides", () => {
    const { w, p } = setup(); const m = horse(w, p); const v = atPin(w, "wagon_medium");
    expect(G.rideMount(w, p, m)).toBe(true);
    w.set(p, G.Riding, { speed: 3 }); // mount moving (positions still at the pin)
    expect(G.validateHitch(w, p, v, m)).toBe("moving");
    w.set(p, G.Riding, { speed: 0 });
    expect(G.validateHitch(w, p, v, m)).toBeUndefined(); expect(G.hitchVehicles(w, p, v, m)).toBeUndefined();
    expect(G.unhitchVehicle(w, p, v)).toBeUndefined();
    expect(w.getField(v, G.Hitch, "parentNetId")).toBe(0); expect(w.getField(m, G.Hitch, "towNetId")).toBe(0);
    expect(G.unhitchVehicle(w, p, v)).toBe("not_hitched");
  });
  it("a drawn vehicle follows its mount on the pin joint while the horse gallops", () => {
    const { w, p } = setup(); const m = horse(w, p); const v = atPin(w, "wagon_medium");
    expect(G.rideMount(w, p, m)).toBe(true); expect(G.hitchVehicles(w, p, v, m)).toBeUndefined();
    const vt0 = { ...w.get(v, Transform)! }; gallop(w, p, 100);
    const moved = (e: Entity, from: { x: number; y: number }): number => { const t = w.get(e, Transform)!; return Math.hypot(t.x - from.x, t.y - from.y); };
    expect(pinGap(w, m, v)).toBeLessThan(1e-3); // front hitch still exactly on the mount's rear pin
    expect(moved(v, vt0)).toBeGreaterThan(20); // ~5.5 tiles/s x 5 s minus the accel ramp
    expect(moved(v, vt0)).toBeLessThan(28);
    expect(w.get(v, G.Vehicle)!.speed).toBeCloseTo(5.5, 1); // capped: galloping horse, wagon x0.62
    expect(Math.hypot(w.get(m, Transform)!.x - w.get(v, Transform)!.x, w.get(m, Transform)!.y - w.get(v, Transform)!.y)).toBeCloseTo(1.5 + 2.4, 3); // mount rear (1.5) + drawbar (2.4)
  });
  it("a chariot outruns the wagon behind the same galloping horse; a walking horse pulls the wagon slowly", () => {
    const { w, p } = setup(); const m = horse(w, p); const c = atPin(w, "chariot");
    expect(G.rideMount(w, p, m)).toBe(true); expect(G.hitchVehicles(w, p, c, m)).toBeUndefined();
    const ct0 = { ...w.get(c, Transform)! }; gallop(w, p, 100);
    const moved = (e: Entity, from: { x: number; y: number }): number => { const t = w.get(e, Transform)!; return Math.hypot(t.x - from.x, t.y - from.y); };
    expect(pinGap(w, m, c)).toBeLessThan(1e-3);
    expect(moved(c, ct0)).toBeGreaterThan(35); // light chariot: the horse runs at its full gallop, ~9.6 tiles/s
    expect(w.get(c, G.Vehicle)!.speed).toBeCloseTo(9.6, 1); // cap 11.5 exceeds the horse's gallop, so the mount is not slowed at all
    const { w: w2, p: p2 } = setup(); const m2 = horse(w2, p2); const v2 = atPin(w2, "wagon_medium");
    expect(G.rideMount(w2, p2, m2)).toBe(true); expect(G.hitchVehicles(w2, p2, v2, m2)).toBeUndefined();
    const vt0 = { ...w2.get(v2, Transform)! };
    for (let i = 0; i < 40; i++) { G.applyMovementInput(w2, p2, G.GameplayActions.MoveRight, DT); w2.step(DT); }
    const t2 = w2.get(v2, Transform)!;
    expect(Math.hypot(t2.x - vt0.x, t2.y - vt0.y)).toBeGreaterThan(5); // walking horse, wagon x0.62 -> ~3.35 tiles/s
    expect(w2.getField(p2, G.Riding, "speed")).toBeCloseTo(5.4 * 0.62, 1); // the mount itself is slowed by the load
  });
  it("a drawn vehicle never drives itself, even with a driver and drive input", () => {
    const { w, p } = setup(); const v = net(w, G.spawnVehicle(w, "wagon_small", 0, 0, 0));
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined();
    for (let i = 0; i < 20; i++) { G.setDriveInput(w, p, 1, 0, false); w.step(DT); }
    expect(w.get(v, Transform)!.x).toBe(0); expect(w.get(v, Transform)!.y).toBe(0);
    expect(w.get(v, G.Vehicle)!.speed).toBe(0);
  });
  it("poseTrailersInHitchFrame re-pins a stale drawn vehicle onto its mount (client interpolation)", () => {
    const { w, p } = setup(); const m = horse(w, p); const v = atPin(w, "wagon_medium");
    expect(G.hitchVehicles(w, p, v, m)).toBeUndefined();
    w.set(m, Transform, { x: 5, y: 5, facing: 0.5 }); w.set(v, Transform, { x: -40, y: 3, facing: 0 });
    expect(G.poseTrailersInHitchFrame(w)).toBe(1); expect(pinGap(w, m, v)).toBeLessThan(1e-6); // f32 Transform rounding
    w.predicted.add(v); w.set(v, Transform, { x: -40, y: 3, facing: 0 });
    expect(G.poseTrailersInHitchFrame(w)).toBe(0); expect(w.get(v, Transform)!.x).toBe(-40); // predicted: untouched
  });
});

describe("ADR-358 drawn crafting", () => {
  it("every drawn vehicle has a workbench kit recipe; rules validate", () => {
    const w = makeWorld(); expect(G.validateVehicleCraft(w)).toEqual([]);
    const d = G.defaultDefs();
    for (const v of G.VEHICLE_DEFS.filter((x) => G.isDrawnDef(x))) {
      expect(G.vehicleKitKey(v.id)).toBe(`vehicle_kit_${v.id}`);
      const r = [...d.recipes.values()].find((x) => d.items.get(x.output.item)?.key === `vehicle_kit_${v.id}`)!;
      expect(r).toBeDefined(); expect(r.station).toBe(G.StationKind.Workbench); expect(r.seconds).toBeGreaterThan(0);
      expect(r.ingredients.some((i) => d.items.get(i.item)?.key === "wooden_wheel")).toBe(true);
    }
    const cov = [...d.recipes.values()].find((x) => d.items.get(x.output.item)?.key === "vehicle_kit_wagon_small_covered")!;
    expect(cov.ingredients.some((i) => d.items.get(i.item)?.key === "canvas_cover")).toBe(true);
  });
  it("deploying a wagon kit spawns an engineless wagon with no VehicleState; it cannot be refuelled", () => {
    const { w, p, id } = setup(); const ev = collect(w, G.VehicleDeployed);
    G.addItem(w, p, id("vehicle_kit_wagon_medium"), 1, 77);
    const slot = (() => { const v = G.readSlots(w, p); for (let i = 0; i < v.slotCount; i++) if (v.item(i) === id("vehicle_kit_wagon_medium")) return i; return -1; })();
    const v = G.deployVehicleKit(w, p, slot, 2, 0) as Entity;
    expect(G.vehicleDefOf(w, v)!.id).toBe("wagon_medium"); expect(G.vehicleCrafter(w, v)).toBe(77);
    expect(w.has(v, G.VehicleState)).toBe(false); expect(w.get(v, G.Vehicle)!.fuel).toBe(0);
    expect(G.refuelVehicle(w, p, v, slot)).toBe("no_tank");
    w.step(DT); expect(ev.map((e) => e.vehicle)).toEqual([v]); // VehicleDeployed delivers at end of tick
  });
  it("a drawn wagon is repaired with a wooden wheel (field + wreck at a garage); engine toggles are refused", () => {
    const { w, p, id } = setup(); const v = net(w, G.spawnVehicle(w, "wagon_medium", 1, 0));
    const max = G.vehicleDefOf(w, v)!.health; w.setField(v, G.Vehicle, "health", max * 0.5);
    G.addItem(w, p, id("wooden_wheel"), 2);
    const slot = (() => { const s = G.readSlots(w, p); for (let i = 0; i < s.slotCount; i++) if (s.item(i) === id("wooden_wheel")) return i; return -1; })();
    expect(G.repairVehicle(w, p, v, slot) as number).toBeGreaterThan(max * 0.5);
    w.setField(v, G.Vehicle, "health", 0); expect(G.validateRepair(w, p, v, slot)).toBe("wrecked");
    G.spawnStation(w, G.StationKind.Garage, 0, 1);
    expect(typeof G.repairVehicle(w, p, v, slot)).toBe("number");
    expect(G.enterVehicle(w, p, v, 0)).toBeUndefined();
    expect(G.setVehicleToggle(w, p, v, G.VEHICLE_ENGINE_ON, 1)).toBe("no_controls");
    expect(G.setVehicleToggle(w, p, v, G.VEHICLE_HEADLIGHTS, 1)).toBe("no_controls");
  });
});
