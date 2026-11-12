// @vitest-environment jsdom
/** ADR-360 client: the driver-seat rider lands on the seat anchor (applyVehicleRiderPlacements), and the
 * engine/lights HUD chip hides for drawn vehicles (no engine, no lights) while staying for motor vehicles. */
import { describe, expect, it } from "vitest";
import { NetId, PrevTransform, Transform, World, type Entity } from "@engine/core";
import { defaultDefs, Driver, installGameplay, spawnPlayer, spawnVehicle, type MenuIntent } from "@engine/gameplay";
import { registerNetIds } from "@engine/net";
import { applyVehicleRiderPlacements } from "../src/view.js";
import { mountVehicleControls } from "../src/vehicle-controls.js";

/** Transform stores f32, so exact equality fails — compare per field. */
const expectTransform = (t: { x: number; y: number; z: number; facing: number } | undefined, x: number, y: number, z: number, facing: number): void => {
  expect(t).toBeDefined();
  expect(t!.x).toBeCloseTo(x); expect(t!.y).toBeCloseTo(y); expect(t!.z).toBeCloseTo(z); expect(t!.facing).toBeCloseTo(facing);
};

const mkNet = (): World => { const w = new World({ seed: 1 }); w.register(Transform); w.register(NetId); return w; };
const mkView = (): World => { const w = new World({ seed: 1 }); w.register(Transform); w.register(PrevTransform); return w; };

describe("ADR-360 applyVehicleRiderPlacements", () => {
  it("lands the rider's view entity on the seat anchor (Transform + PrevTransform), all 8 headings", () => {
    const net = mkNet(); const view = mkView();
    const riderNet = net.create(); net.add(riderNet, NetId, { id: 101 }); net.add(riderNet, Transform, { x: 0, y: 0, z: 0, facing: 0 });
    const riderView = view.create(); view.add(riderView, Transform, { x: 0, y: 0, z: 0, facing: 0 }); view.add(riderView, PrevTransform, { x: 0, y: 0, z: 0, facing: 0 });
    const map = new Map<Entity, Entity>([[riderNet, riderView]]);
    for (let dir = 0; dir < 8; dir++) {
      const heading = dir * Math.PI / 4;
      applyVehicleRiderPlacements(net, view, map, [{ rider: 101, vehicle: 7, seat: 0, x: 10.3, y: 4.2, z: 0.3, facing: heading, cropped: false }]);
      expectTransform(view.get(riderView, Transform), 10.3, 4.2, 0.3, heading);
      expectTransform(view.get(riderView, PrevTransform), 10.3, 4.2, 0.3, heading); // no interpolation from the vehicle centre
    }
  });
  it("is rotation-invariant: the placement is world-space, so all four view rotations land the same spot", () => {
    // The helper takes no rotation input — the four rotations live in the renderer, which projects the same
    // world-space Transform. A rotation must never move the rider off the seat.
    const net = mkNet(); const view = mkView();
    const riderNet = net.create(); net.add(riderNet, NetId, { id: 101 });
    const riderView = view.create(); view.add(riderView, Transform, { x: 0, y: 0, z: 0, facing: 0 });
    const map = new Map<Entity, Entity>([[riderNet, riderView]]);
    for (let q = 0; q < 4; q++) {
      applyVehicleRiderPlacements(net, view, map, [{ rider: 101, vehicle: 7, seat: 0, x: 3, y: 5, z: 0.3, facing: Math.PI / 2, cropped: false }]);
      expectTransform(view.get(riderView, Transform), 3, 5, 0.3, Math.PI / 2);
    }
  });
  it("skips riders with no view entity or an unknown NetId, and riders without a PrevTransform", () => {
    const net = mkNet(); const view = mkView();
    const riderNet = net.create(); net.add(riderNet, NetId, { id: 101 });
    const riderView = view.create(); view.add(riderView, Transform, { x: 1, y: 2, z: 0, facing: 0 }); // no PrevTransform
    const map = new Map<Entity, Entity>([[riderNet, riderView]]);
    const ghost = net.create(); net.add(ghost, NetId, { id: 102 }); // no view entity
    expect(() => applyVehicleRiderPlacements(net, view, map, [
      { rider: 999, vehicle: 7, seat: 0, x: 9, y: 9, z: 9, facing: 0, cropped: false }, // unknown NetId
      { rider: 102, vehicle: 7, seat: 1, x: 9, y: 9, z: 9, facing: 0, cropped: false }, // no view entity
      { rider: 101, vehicle: 7, seat: 0, x: 3, y: 4, z: 0.3, facing: 1, cropped: false },
    ])).not.toThrow();
    expectTransform(view.get(riderView, Transform), 3, 4, 0.3, 1);
    expect(view.has(riderView, PrevTransform)).toBe(false); // still no PrevTransform: not invented
  });
});

describe("ADR-360 vehicle HUD chip", () => {
  const mkWorld = (): { w: World; p: Entity } => {
    const w = new World({ seed: 1, maxEntities: 1024 }); installGameplay(w, { defs: defaultDefs() } as never);
    const p = spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 });
    return { w, p };
  };
  const ride = (w: World, p: Entity, id: string): Entity => {
    const v = spawnVehicle(w, id, 0, 0, 0);
    if (!w.has(v, NetId)) w.add(v, NetId, { id: 500 + (id === "wagon_medium" ? 1 : 2) });
    // ridden() resolves through the net layer, and a bare test world has no NetClient — register a resolver
    // that reads the NetId component directly (the production client registers its own for its mirror world).
    registerNetIds(w, {
      netIdOf: (e) => w.getField(e, NetId, "id"),
      entityOf: (nid) => { for (const e of w.query([NetId])) if (w.getField(e, NetId, "id") === nid) return e; return undefined; },
    });
    w.add(p, Driver, { vehicleNetId: w.getField(v, NetId, "id")!, seat: 0 });
    return v;
  };
  const mount = (w: World, p: Entity, pressed: Set<string>): { sent: MenuIntent[]; hud: HTMLElement; update: () => boolean } => {
    const sent: MenuIntent[] = []; const root = document.createElement("div"); document.body.append(root);
    const ctl = mountVehicleControls(root, { world: () => w, player: () => p, send: (i) => { sent.push(i); return true; }, input: { pressed: (a) => pressed.has(a) } });
    return { sent, hud: root.querySelector("#vehicle-hud")!, update: () => ctl.update() };
  };
  it("hides the engine/lights chip for a wagon driver, and ignores the engine/lights buttons there", () => {
    const { w, p } = mkWorld(); ride(w, p, "wagon_medium");
    const pressed = new Set(["Vehicle.Engine", "Vehicle.Lights"]);
    const { sent, hud, update } = mount(w, p, pressed);
    expect(update()).toBe(false); // nothing sent
    expect(sent).toEqual([]); // no engine/lights intents for a vehicle with no engine or lights
    expect(hud.style.display).toBe("none");
    expect(hud.textContent).toBe(""); // the chip never got engine/lights text
  });
  it("shows the chip for a motor driver, and sends the engine/lights intents", () => {
    const { w, p } = mkWorld(); ride(w, p, "car_sedan");
    const { sent, hud, update } = mount(w, p, new Set(["Vehicle.Engine"]));
    expect(update()).toBe(true);
    expect(hud.style.display).toBe("flex");
    expect(hud.textContent).toBe("Engine off · Lights off");
    expect(sent.length).toBe(1);
    const { sent: sent2, update: update2 } = mount(w, p, new Set(["Vehicle.Lights"]));
    expect(update2()).toBe(true); expect(sent2.length).toBe(1);
  });
  it("Interact still exits a wagon (the chip is hidden, the exit is not)", () => {
    const { w, p } = mkWorld(); ride(w, p, "wagon_medium");
    const { sent, hud, update } = mount(w, p, new Set(["Interact"]));
    expect(update()).toBe(true);
    expect(sent.length).toBe(1);
    expect(hud.style.display).toBe("none");
  });
  it("no chip when not riding", () => {
    const { w, p } = mkWorld();
    const { sent, hud, update } = mount(w, p, new Set());
    expect(update()).toBe(false); expect(sent).toEqual([]);
    expect(hud.style.display).toBe("none");
  });
});
