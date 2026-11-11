import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as G from "@engine/gameplay";
import { GAMEPLAY_NET_COMMANDS as NET } from "../src/protocol.js";
const GAMEPLAY_NET_COMMANDS = NET.map((x) => x.core);

const root = join(__dirname, "../../..");
const profile = (f: string): string => readFileSync(join(root, "packages/input/profiles", f), "utf8");

describe("ADR-170: vehicles are drivable from the client on every input", () => {
  it("engine + headlights toggles are bridged (appended, so older ids keep their wire index)", () => {
    for (const c of G.VEHICLE_STATE_COMMANDS) expect(GAMEPLAY_NET_COMMANDS).toContain(c);
    const at = GAMEPLAY_NET_COMMANDS.indexOf(G.VEHICLE_STATE_COMMANDS[0]);
    expect(GAMEPLAY_NET_COMMANDS.slice(at, at + G.VEHICLE_STATE_COMMANDS.length)).toEqual([...G.VEHICLE_STATE_COMMANDS]);
    // later ADRs append after them (ADR-204 inventory ops, Task 9 map markers); nothing is inserted before.
    // ADR-351 appended the rope command after the mount commands.
    expect(GAMEPLAY_NET_COMMANDS.slice(at + G.VEHICLE_STATE_COMMANDS.length)).toEqual([...G.INVENTORY_OP_COMMANDS, ...G.MAP_MARKER_COMMANDS, ...G.DISEASE_COMMANDS.map(([d]) => d), ...G.READY_COMMANDS, ...G.ANIMAL_SKILL_COMMANDS, ...G.WORKER_COMMANDS, ...G.DYE_COMMANDS, ...G.TERRAIN_COMMANDS, ...G.HOTBAR_COMMANDS.map(([d]) => d), ...G.RECLAIM_COMMANDS.map(([d]) => d), ...G.MOVE_COMMANDS.map(([d]) => d), ...G.MOUNT_COMMANDS, ...G.ROPE_COMMANDS]);
    for (const c of [G.VehicleEnterCmd, G.VehicleExitCmd, G.VehicleDeployCmd]) expect(GAMEPLAY_NET_COMMANDS).toContain(c);
  });
  it("Vehicle.Engine / Vehicle.Lights are bound on keyboard, gamepad and touch", () => {
    for (const f of ["keyboardMouse.json", "gamepad.json", "touch.json"]) {
      const s = profile(f); expect(s, f).toContain("\"Vehicle.Engine\""); expect(s, f).toContain("\"Vehicle.Lights\"");
    }
    expect(profile("touch.json")).toContain("touch.btn.engine"); expect(profile("touch.json")).toContain("touch.btn.lights");
  });
  it("every vehicle kit fits a fresh player's bag (kits used to weigh 25-800 kg against a 60 kg limit)", () => {
    const items = JSON.parse(readFileSync(join(root, "packages/gameplay/data/vehicle_items.json"), "utf8"));
    const list: { key: string; weight: number }[] = Array.isArray(items) ? items : items.items;
    const kits = list.filter((i) => i.key.startsWith("vehicle_kit_")); expect(kits.length).toBeGreaterThan(20);
    for (const k of kits) expect(k.weight, k.key).toBeLessThanOrEqual(8);
  });
});
