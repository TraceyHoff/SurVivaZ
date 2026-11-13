/**
 * ADR-387: no sprint with a broken leg.
 * The sprint gate lives in the shared applyMovementInput (server authority + client prediction):
 * while "broken_leg" is active the auto-sprint latch can warm up but sprint stays 0 — walk speed
 * only (walk x the disease moveMul 0.5), and vitalsSystem never sees a sprint to drain stamina for.
 * Other diseases do not block sprint, and sprint resumes the moment the leg heals (cure or expiry)
 * because the warmed-up latch is untouched by the gate.
 * Riding gallop and driving boost are deliberately NOT gated here: the mount's speed is not the
 * rider's leg (see the ADR-387 report). Relative imports only (ADR-347).
 */
import { describe, expect, it } from "vitest";
import { entityIndex, idleOutput, Transform, type InputFrame } from "@engine/core";
import type { Entity, World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

const DT = .05;
const WALK = 2.9; // gameplayDefs().movement.walkSpeed (ADR-274 pins it)

function setup() {
  const w = makeWorld(), p = G.spawnPlayer(w, { x: 20, y: 20, maxWeight: 0 });
  const reg = G.registerGameplayCommands();
  const move = (x: number, y = 0, n = 1) => {
    for (let i = 0; i < n; i++) {
      const f: InputFrame = { tick: w.tick, actions: 0, aimX: 0, aimY: 0, moveX: x, moveY: y, commands: [] };
      G.applyMovementInput(w, p, f.actions, DT, { x: f.moveX, y: f.moveY });
    }
  };
  const sprint = () => w.getField(p, G.PlayerIntent, "sprint");
  const step = () => {
    const t = w.get(p, Transform)!;
    move(1);
    const n = w.get(p, Transform)!;
    return Math.hypot(n.x - t.x, n.y - t.y);
  };
  return { w, p, reg, move, sprint, step };
}

function expiry(w: World, p: Entity): number {
  const st = w.store(G.Diseases), s = st.slot(entityIndex(p));
  const slot = G.diseaseSlot(w, p, G.gameplayDefs(w).diseaseIndex("broken_leg"));
  return slot < 0 ? 0 : st.data.untilTick[s * G.MAX_DISEASES + slot]!;
}

function useSplint(w: World, p: Entity): void {
  G.setIntent(w, p, { action: G.IntentAction.Use, slot: 0 }); G.consumeSystem(w);
  G.setIntent(w, p, { action: G.IntentAction.None });
}

describe("ADR-387 no sprint with a broken leg", () => {
  it("blocks auto-sprint while the leg is broken: sprint stays 0, speed is walk x 0.5", () => {
    const { w, p, move, sprint, step } = setup();
    G.contractDisease(w, p, "broken_leg");
    move(1, 0, 80); // a full warm-up: a healthy player would be sprinting now
    expect(sprint()).toBe(0);
    expect(step()).toBeCloseTo(WALK * 0.5 * DT, 5);
    // still blocked after more running: the latch warms up, the gate holds
    move(1, 0, 40);
    expect(sprint()).toBe(0);
    expect(step()).toBeCloseTo(WALK * 0.5 * DT, 5);
  });

  it("a healthy player still sprints after the same warm-up (control)", () => {
    const { move, sprint, step } = setup();
    move(1, 0, 79); expect(sprint()).toBe(0);
    move(1); expect(sprint()).toBe(1);
    expect(step()).toBeCloseTo(WALK * 1.6 * DT, 5);
  });

  it("other diseases do not block sprint — a cold still runs at full sprint speed", () => {
    const { w, p, move, sprint, step } = setup();
    G.contractDisease(w, p, "common_cold");
    move(1, 0, 80);
    expect(sprint()).toBe(1);
    // common_cold moveMul is 0.95 (diseases.json): the step is the sprint stride slowed by the cold
    expect(step()).toBeCloseTo(WALK * 1.6 * 0.95 * DT, 5);
    expect(G.hasDisease(w, p, "common_cold")).toBe(true);
  });

  it("no sprint stamina drain while the leg is broken", () => {
    const { w, p, move, sprint } = setup();
    G.contractDisease(w, p, "broken_leg");
    move(1, 0, 80);
    expect(sprint()).toBe(0);
    const before = w.getField(p, G.Survival, "stamina")!;
    G.vitalsSystem(w, DT);
    expect(w.getField(p, G.Survival, "stamina")).toBe(before);
    // control: the same run healthy drains stamina through the sprint intent
    const healthy = setup();
    healthy.move(1, 0, 80);
    expect(healthy.sprint()).toBe(1);
    const hBefore = healthy.w.getField(healthy.p, G.Survival, "stamina")!;
    G.vitalsSystem(healthy.w, DT);
    expect(healthy.w.getField(healthy.p, G.Survival, "stamina")).toBeLessThan(hBefore);
  });

  it("sprint resumes immediately after the leg is cured (the latch stays warm)", () => {
    const { w, p, move, sprint } = setup();
    G.contractDisease(w, p, "broken_leg");
    move(1, 0, 80);
    expect(sprint()).toBe(0);
    const item = G.gameplayDefs(w).itemId("leg_splint");
    G.addItem(w, p, item, 2);
    useSplint(w, p);
    expect(G.hasDisease(w, p, "broken_leg")).toBe(false);
    expect(G.countItem(w, p, item)).toBe(1);
    move(1);
    expect(sprint()).toBe(1);
  });

  it("sprint resumes after the leg expires on its own", () => {
    const { w, p, move, sprint } = setup();
    G.contractDisease(w, p, "broken_leg");
    move(1, 0, 80);
    expect(sprint()).toBe(0);
    const until = expiry(w, p);
    w.tick = until - 1; G.diseaseSystem(w, .05);
    expect(G.hasDisease(w, p, "broken_leg")).toBe(true);
    w.tick = until; G.diseaseSystem(w, .05);
    expect(G.hasDisease(w, p, "broken_leg")).toBe(false);
    move(1);
    expect(sprint()).toBe(1);
  });

  it("blocks sprint for AI humans on the same shared path", () => {
    const w = makeWorld(), p = G.spawnPlayer(w, { x: 20, y: 20, maxWeight: 0 });
    const reg = G.registerGameplayCommands();
    G.contractDisease(w, p, "broken_leg");
    const out = idleOutput(); out.moveX = 1; out.moveY = 0; out.sprint = true;
    for (let i = 0; i < 80; i++) {
      const f = G.agentOutputFrame({ ...out }, w.tick, reg);
      G.applyMovementInput(w, p, f.actions, DT, { x: f.moveX, y: f.moveY });
    }
    expect(w.getField(p, G.PlayerIntent, "sprint")).toBe(0);
  });

  it("the tutorial Run step cannot complete while the leg is broken (it reads PlayerIntent.sprint)", () => {
    // The probe counts "sprint" distance only when PlayerIntent.sprint is set (main.ts:748) — with
    // the gate, a broken-legged player never sets it, so the step's grew("sprint", 3) never fires.
    // This test pins the sim side of that contract: sprint intent stays 0 through a full warm-up.
    const { w, p, move, sprint } = setup();
    G.contractDisease(w, p, "broken_leg");
    move(1, 0, 200);
    expect(sprint()).toBe(0);
    expect(G.hasDisease(w, p, "broken_leg")).toBe(true);
  });
});
