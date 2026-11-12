// @vitest-environment jsdom
/** ADR-371 client: Interact boards a drawn vehicle as a passenger (seat 254) when it already has a driver,
 * drives (seat 255) otherwise, and the HUD chip tells a passenger how to get off. Boarding and dismounting
 * both go through Interact (E / pad X / touch "Use"), so all three devices work with no new binding. */
import { describe, expect, it } from "vitest";
import { NetId, Transform, World, type Entity } from "@engine/core";
import { defaultDefs, Driver, enterVehicle, installGameplay, spawnPlayer, spawnVehicle, VehicleEnterCmd, VehicleExitCmd, type MenuIntent } from "@engine/gameplay";
import { registerNetIds } from "@engine/net";
import { enterIntent, mountVehicleControls, passengerIntent } from "../src/vehicle-controls.js";

const mkWorld = (): { w: World; p: Entity } => {
  const w = new World({ seed: 1, maxEntities: 1024 }); installGameplay(w, { defs: defaultDefs() } as never);
  const p = spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 });
  registerNetIds(w, {
    netIdOf: (e) => w.getField(e, NetId, "id"),
    entityOf: (nid) => { for (const e of w.query([NetId])) if (w.getField(e, NetId, "id") === nid) return e; return undefined; },
  });
  return { w, p };
};
/** A vehicle at the player's feet, with `driver` (another player) seated in seat 0 when given. */
const wagonWith = (w: World, driver?: Entity): Entity => {
  const v = spawnVehicle(w, "wagon_medium", 0, 0, 0);
  if (!w.has(v, NetId)) w.add(v, NetId, { id: 501 });
  if (driver !== undefined) {
    if (!w.has(driver, NetId)) w.add(driver, NetId, { id: 502 });
    // Seat the driver through the real path so VehicleSeats agrees with the Driver component.
    expect(enterVehicle(w, driver, v, 0)).toBeUndefined();
  }
  return v;
};
const mount = (w: World, p: Entity, pressed: Set<string>): { sent: MenuIntent[]; hud: HTMLElement; update: () => boolean } => {
  const sent: MenuIntent[] = []; const root = document.createElement("div"); document.body.append(root);
  const ctl = mountVehicleControls(root, { world: () => w, player: () => p, send: (i) => { sent.push(i); return true; }, input: { pressed: (a) => pressed.has(a) } });
  return { sent, hud: root.querySelector("#vehicle-hud")!, update: () => ctl.update() };
};

describe("ADR-371 passenger intents", () => {
  it("passengerIntent sends seat 254; enterIntent still sends seat 255", () => {
    const { w } = mkWorld(); const v = spawnVehicle(w, "wagon_medium", 0, 0, 0);
    expect(passengerIntent(v)).toEqual({ cmd: VehicleEnterCmd, args: { target: v, seat: 254 }, entities: ["target"] });
    expect(enterIntent(v)).toEqual({ cmd: VehicleEnterCmd, args: { target: v, seat: 255 }, entities: ["target"] });
  });
  it("Interact on a driven wagon boards as a passenger (seat 254)", () => {
    const { w, p } = mkWorld();
    const driver = spawnPlayer(w, { x: 0, y: 1, maxWeight: 0, clientId: 8 });
    wagonWith(w, driver);
    const { sent, update } = mount(w, p, new Set(["Interact"]));
    expect(update()).toBe(true);
    expect(sent).toEqual([{ cmd: VehicleEnterCmd, args: { target: expect.any(Number), seat: 254 }, entities: ["target"] }]);
  });
  it("Interact on a driverless wagon drives (seat 255) — somebody has to drive", () => {
    const { w, p } = mkWorld(); wagonWith(w);
    const { sent, update } = mount(w, p, new Set(["Interact"]));
    expect(update()).toBe(true);
    expect(sent).toEqual([{ cmd: VehicleEnterCmd, args: { target: expect.any(Number), seat: 255 }, entities: ["target"] }]);
  });
  it("Interact on a motor vehicle still drives (seat 255), even with a driver seated", () => {
    const { w, p } = mkWorld();
    const car = spawnVehicle(w, "car_sedan", 0, 0, 0);
    if (!w.has(car, NetId)) w.add(car, NetId, { id: 503 });
    const { sent, update } = mount(w, p, new Set(["Interact"]));
    expect(update()).toBe(true);
    expect(sent[0]!.args["seat"]).toBe(255); // motor vehicles are out of the ADR-371 passenger scope
  });
});

describe("ADR-371 passenger HUD chip", () => {
  const rideAs = (w: World, p: Entity, seat: number): void => {
    const v = wagonWith(w);
    w.add(p, Driver, { vehicleNetId: w.getField(v, NetId, "id")!, seat });
  };
  it("a passenger sees 'Passenger · Interact to get off', and Interact exits", () => {
    const { w, p } = mkWorld(); rideAs(w, p, 1);
    const { sent, hud, update } = mount(w, p, new Set(["Interact"]));
    expect(update()).toBe(true);
    expect(sent).toEqual([{ cmd: VehicleExitCmd, args: {} }]);
    expect(hud.style.display).toBe("flex");
    expect(hud.textContent).toBe("Passenger · Interact to get off");
  });
  it("a wagon driver still sees no chip (ADR-360 behaviour unchanged)", () => {
    const { w, p } = mkWorld(); rideAs(w, p, 0);
    const { sent, hud, update } = mount(w, p, new Set());
    expect(update()).toBe(false); expect(sent).toEqual([]);
    expect(hud.style.display).toBe("none"); expect(hud.textContent).toBe("");
  });
});
