import { describe, expect, it } from "vitest";
import { idleOutput, Transform, type InputFrame } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

const DT = .05;
for (const human of ["player", "AI human"] as const) describe(`ADR-289 ${human}`, () => {
  function setup() {
    const w = makeWorld(), p = G.spawnPlayer(w, { x: 20, y: 20, maxWeight: 0 });
    const reg = G.registerGameplayCommands();
    const move = (x: number, y = 0, n = 1) => {
      for (let i = 0; i < n; i++) {
        // Deliberately request instant sprint from AI's long-path hint: it must NOT skip the warmup.
        const f: InputFrame = human === "AI human" ? G.agentOutputFrame({ ...idleOutput(), moveX: x, moveY: y, sprint: true }, w.tick, reg) : { tick: w.tick, actions: 0, aimX: 0, aimY: 0, moveX: x, moveY: y, commands: [] };
        G.applyMovementInput(w, p, f.actions, DT, { x: f.moveX, y: f.moveY });
      }
    };
    const sprint = () => w.getField(p, G.PlayerIntent, "sprint");
    return { w, p, move, sprint };
  }
  it("warms up, maintains through a reversal, stops, and must build up again", () => {
    const { w, p, move, sprint } = setup();
    move(1, 0, 79); expect(sprint()).toBe(0);
    const before = w.get(p, Transform)!; move(1); expect(sprint()).toBe(1);
    const after = w.get(p, Transform)!; expect(Math.hypot(after.x-before.x, after.y-before.y)).toBeCloseTo(4.64 * DT, 5);
    move(-1); expect(sprint()).toBe(1); move(0, 1); expect(sprint()).toBe(1);
    move(0); expect(sprint()).toBe(0); expect(w.getField(p, G.AutoSprint, "seconds")).toBe(0);
    move(-1, 0, 79); expect(sprint()).toBe(0); move(-1); expect(sprint()).toBe(1);
  });
  it("allows 45-degree wobble but resets a sharp turn before engaging", () => {
    const { move, sprint } = setup(); move(1, 0, 40); move(1, 1, 40); expect(sprint()).toBe(1);
    move(0); move(1, 0, 60); move(-1, 0, 40); expect(sprint()).toBe(0); move(-1, 0, 40); expect(sprint()).toBe(1);
  });
  it("resets below the existing movement deadzone", () => {
    const { move, sprint } = setup(); move(1, 0, 80); expect(sprint()).toBe(1); move(human === "player" ? .01 : 0); expect(sprint()).toBe(0); move(1); expect(sprint()).toBe(0);
  });
  it.each([G.StanceMode.Block, G.StanceMode.Aim, G.StanceMode.Crouch, G.StanceMode.Carry, G.StanceMode.Sleep])("respects stance %i without losing the warmed-up latch", mode => {
    const { w, p, move, sprint } = setup(); w.add(p, G.Stance, { mode }); move(1, 0, 85); expect(sprint()).toBe(0);
    w.set(p, G.Stance, { mode: G.StanceMode.None }); move(1); expect(sprint()).toBe(1);
  });
  it("does not sprint in deep water, resumes on land if movement never stopped", () => {
    const { w, p, move, sprint } = setup(); w.setResource(G.TerrainRes, { tileAt: () => 1, heightAt: () => 0 }); move(1, 0, 85); expect(sprint()).toBe(0);
    w.setResource(G.TerrainRes, { tileAt: () => 3, heightAt: () => 0 }); move(-1); expect(sprint()).toBe(1);
  });
  it("drains stamina and resumes after exhaustion without a new warmup", () => {
    const { w, p, move, sprint } = setup(); move(1, 0, 80);
    const before = w.getField(p, G.Survival, "stamina")!; G.vitalsSystem(w, DT); expect(w.getField(p, G.Survival, "stamina")).toBeLessThan(before);
    w.setField(p, G.Survival, "stamina", 0); move(-1); expect(sprint()).toBe(0);
    w.setField(p, G.Survival, "stamina", 5); move(0, -1); expect(sprint()).toBe(1);
  });
});

it("ADR-289 HUD selection is idempotent for tools and remembers an empty active slot", () => {
  const w = makeWorld(), p = G.spawnPlayer(w, { x: 20, y: 20 }); const reg = G.registerGameplayCommands();
  const defs = G.gameplayDefs(w), slots = G.readSlots(w, p); slots.put(16, defs.itemId("stone_axe"), 1); G.writeSlots(w, p, slots, defs);
  for (let i = 0; i < 2; i++) { G.applyGameplayInput(w, p, { tick: w.tick, actions: 0, aimX: 0, aimY: 0, commands: [reg.make(G.SelectHotbarCmd, { slot: 16 })] }, reg); G.commandIntentSystem(w); G.equipSystem(w); }
  expect(w.getField(p, G.Equipment, "mainHandSlot")).toBe(16);
  // A slot selection is not the old Equip toggle, and empty slots still remain selected.
  for (let i = 0; i < 2; i++) { G.applyGameplayInput(w, p, { tick: w.tick, actions: 0, aimX: 0, aimY: 0, commands: [reg.make(G.SelectHotbarCmd, { slot: 23 })] }, reg); G.commandIntentSystem(w); G.equipSystem(w); }
  expect(w.getField(p, G.HotbarSelection, "slot")).toBe(23); expect(w.getField(p, G.Equipment, "mainHandSlot")).toBe(G.NO_SLOT);
});

it("ADR-289 never auto-boosts a vehicle, retains explicit boost, and clears the on-foot latch", () => {
  const w = makeWorld(), p = G.spawnPlayer(w, { x: 20, y: 20 }); const reg = G.registerGameplayCommands();
  for (let i = 0; i < 80; i++) G.applyMovementInput(w, p, G.GameplayActions.MoveRight, DT);
  expect(w.getField(p, G.AutoSprint, "seconds")).toBe(4);
  w.add(p, G.Driver, { vehicleNetId: 1, seat: 0 });
  for (let i = 0; i < 30; i++) G.applyGameplayInput(w, p, { tick: w.tick, actions: G.GameplayActions.MoveRight, aimX: 0, aimY: 0, commands: [] }, reg);
  expect(w.getResource(G.DriveInputs)?.get(p)?.boost).toBe(false); expect(w.getField(p, G.AutoSprint, "seconds")).toBe(0);
  G.applyGameplayInput(w, p, { tick: w.tick, actions: G.GameplayActions.MoveRight | G.GameplayActions.Sprint, aimX: 0, aimY: 0, commands: [] }, reg);
  expect(w.getResource(G.DriveInputs)?.get(p)?.boost).toBe(true);
  w.remove(p, G.Driver); G.applyMovementInput(w, p, G.GameplayActions.MoveRight, DT); expect(w.getField(p, G.PlayerIntent, "sprint")).toBe(0);
});
