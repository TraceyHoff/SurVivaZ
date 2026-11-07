import { describe, expect, it } from "vitest";
import { Transform } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

// ADR-127: every move direction (8 keys + analog) travels exactly walkSpeed x multipliers x stick magnitude.
const A = G.GameplayActions;
const DIRS: Record<string, number> = {
  up: A.MoveUp, down: A.MoveDown, left: A.MoveLeft, right: A.MoveRight,
  upLeft: A.MoveUp | A.MoveLeft, upRight: A.MoveUp | A.MoveRight, downLeft: A.MoveDown | A.MoveLeft, downRight: A.MoveDown | A.MoveRight,
};
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y);
function step(bits: number, analog?: { x: number; y: number }, sprint = false) {
  const w = makeWorld(); const p = G.spawnPlayer(w, { x: 20, y: 20 });
  if (sprint) for (let i = 0; i < 20; i++) G.applyMovementInput(w, p, bits, .05, analog);
  const a = { ...w.get(p, Transform)! }; G.applyMovementInput(w, p, bits, .05, analog);
  return { d: dist(a, w.get(p, Transform)!) / .05, mul: G.speedMultiplier(w, p, sprint), w, p };
}
describe("ADR-127 normalized movement", () => {
  const walk = G.defaultDefs().movement.walkSpeed;
  it("walkSpeed is 2.9 (ADR-274) and the effective cardinal (single key) speed equals it", () => {
    expect(walk).toBe(2.9);
    const { d, mul } = step(A.MoveUp); expect(mul).toBeCloseTo(1, 9); expect(d).toBeCloseTo(2.9, 4);
  });
  for (const [name, bits] of Object.entries(DIRS)) {
    it(`${name}: unit vector, moves walkSpeed (and walkSpeed x sprintMul sprinting)`, () => {
      const v = G.moveDirection(bits); expect(Math.hypot(v.dx, v.dy)).toBeCloseTo(1, 9);
      const r = step(bits); expect(r.d).toBeCloseTo(walk * r.mul, 4);
      const s = step(bits, undefined, true); expect(s.d).toBeCloseTo(walk * s.mul, 4);
    });
  }
  it("screen mapping: up = -x-y, right = +x-y, down+right = +x", () => {
    const k = Math.SQRT1_2;
    expect(G.moveDirection(A.MoveUp)).toEqual({ dx: -k, dy: -k });
    expect(G.moveDirection(A.MoveRight).dx).toBeCloseTo(k, 9); expect(G.moveDirection(A.MoveRight).dy).toBeCloseTo(-k, 9);
    const dr = G.moveDirection(A.MoveDown | A.MoveRight); expect(dr.dx).toBeCloseTo(1, 9); expect(dr.dy).toBe(0);
    expect(G.moveDirection(A.MoveUp | A.MoveDown)).toEqual({ dx: 0, dy: 0 });
  });
  it("analog: proportional below 1, clamped to 1 above, any angle", () => {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      expect(step(0, { x: Math.cos(a) * 0.5, y: Math.sin(a) * 0.5 }).d).toBeCloseTo(walk * 0.5, 4);
      expect(step(0, { x: Math.cos(a), y: Math.sin(a) }).d).toBeCloseTo(walk, 4);
    }
    expect(step(0, { x: 1, y: 1 }).d).toBeCloseTo(walk, 4); // corner of the square stick gate clamps to 1
    expect(step(0, { x: 0.05, y: 0 }).d).toBe(0); // inside deadzone, no bits -> idle
    expect(step(A.MoveUp, { x: 0, y: 0 }).d).toBeCloseTo(walk, 4); // idle stick falls back to digital bits
    const v = G.moveVector(0, { x: 0, y: -1 }); const u = G.moveDirection(A.MoveUp);
    expect(v.dx).toBeCloseTo(u.dx, 9); expect(v.dy).toBeCloseTo(u.dy, 9); // stick up == W
  });
  it("max on-foot speed stays under the anti-cheat / lag-comp bound (playerMaxSpeed x 1.25 tolerance)", () => {
    const d = G.defaultDefs(); const top = d.movement.walkSpeed * d.movement.sprintMul * 1.3; // fastest road
    expect(top).toBeLessThan(d.building.playerMaxSpeed * 1.25);
  });
  it("vehicle steering from bits is unchanged: unit length, same direction as walking", () => {
    for (const bits of Object.values(DIRS)) {
      const dv = G.driveFromBits(bits), mv = G.moveDirection(bits);
      expect(Math.hypot(dv.x, dv.y)).toBeCloseTo(1, 9); expect(dv.x).toBeCloseTo(mv.dx, 9); expect(dv.y).toBeCloseTo(mv.dy, 9);
    }
  });
});
