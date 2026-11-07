import { describe, expect, it } from "vitest";
import { Transform } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

// ADR-125: slower on-foot movement so vehicles are worth using.
describe("ADR-125 player speed tuning", () => {
  const mv = G.defaultDefs().movement;
  const walk = mv.walkSpeed, sprint = mv.walkSpeed * mv.sprintMul;
  it("walk is a jog (~2.5-3 tiles/s) and sprint ~25-30% below the old 6.4 (ADR-274)", () => {
    expect(walk).toBeGreaterThanOrEqual(2.4); expect(walk).toBeLessThanOrEqual(3);
    expect(sprint / 6.4).toBeGreaterThan(0.7); expect(sprint / 6.4).toBeLessThan(0.75);
    expect(walk * mv.swimSpeedMul).toBeGreaterThan(0.9); // swimming still usable
  });
  it("motor vehicles are 2.5-6x sprint; zombie runners stay escapable but not trivial", () => {
    for (const d of G.VEHICLE_DEFS) if (d.class !== "bicycle" && d.class !== "trailer") {
      expect(d.maxSpeed / sprint).toBeGreaterThanOrEqual(2.5); expect(d.maxSpeed / sprint).toBeLessThanOrEqual(6);
    }
    const zs = [...G.defaultDefs().zombies.values()];
    const runner = zs.find((z) => z.key === "zombie_runner")!;
    expect(runner.speed).toBeLessThan(sprint); expect(runner.speed).toBe(2.8); // ADR-274: unchanged runners are now marginally below the 2.9 walk
    for (const z of zs) expect(z.speed).toBeLessThan(sprint);
  });
  it("applyMovementInput moves at the shared walk / sprint constants (server == client prediction)", () => {
    const w = makeWorld(); const p = G.spawnPlayer(w, { x: 20, y: 20 });
    const dir = G.GameplayActions.MoveUp; const k = 1; // ADR-127: normalized
    const d = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y);
    const a0 = { ...w.get(p, Transform)! }; G.applyMovementInput(w, p, dir, .05);
    expect(d(a0, w.get(p, Transform)!)).toBeCloseTo(.05 * k * walk * G.speedMultiplier(w, p, false), 4);
    for (let i = 0; i < 80; i++) G.applyMovementInput(w, p, dir, .05);
    const a1 = { ...w.get(p, Transform)! }; G.applyMovementInput(w, p, dir, .05);
    expect(d(a1, w.get(p, Transform)!)).toBeCloseTo(.05 * k * walk * G.speedMultiplier(w, p, true), 4);
  });
  it("walk anim playback scales with walk speed (no foot sliding)", () => {
    expect(G.walkAnimRate(makeWorld())).toBeCloseTo(mv.walkSpeed / mv.walkAnimRefSpeed, 6);
    expect(mv.walkAnimRefSpeed).toBe(4);
  });
});
