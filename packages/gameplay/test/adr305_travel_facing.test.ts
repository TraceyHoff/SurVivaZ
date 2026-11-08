import { describe, expect, it } from "vitest";
import { Transform } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

const SOUTH = Math.PI / 4;
const NORTH = -3 * Math.PI / 4;

describe("ADR-305 travel facing", () => {
  it("keeps the last travel heading when idle even if stored facing snapped north", () => {
    const moving = G.facingAfterTravel(NORTH, 1, 1);
    expect(moving.last).toBeCloseTo(SOUTH, 5);
    expect(moving.facing).toBeCloseTo(NORTH, 5);
    const idle = G.facingAfterTravel(NORTH, 0, 0, moving.last);
    expect(idle.facing).toBeCloseTo(SOUTH, 5);
    expect(idle.last).toBeCloseTo(SOUTH, 5);
  });

  it("does not invent a heading before the first step", () => {
    const idle = G.facingAfterTravel(0, 0, 0);
    expect(idle.facing).toBe(0);
    expect(idle.last).toBeUndefined();
  });

  it("wraps spun-around facing into (-π, π]", () => {
    expect(G.normalizeFacing(SOUTH)).toBeCloseTo(SOUTH, 8);
    expect(G.normalizeFacing(NORTH)).toBeCloseTo(NORTH, 8);
    expect(G.normalizeFacing(5 * Math.PI / 4)).toBeCloseTo(NORTH, 8);
    expect(Math.abs(G.normalizeFacing(3 * Math.PI))).toBeCloseTo(Math.PI, 8);
  });

  it("walking south then stopping stays south, not north", () => {
    const w = makeWorld(), p = G.spawnPlayer(w, { x: 20, y: 20, maxWeight: 0 });
    for (let i = 0; i < 16; i++) G.applyMovementInput(w, p, G.GameplayActions.MoveDown, .05);
    expect(w.get(p, Transform)!.facing).toBeCloseTo(SOUTH, 5);
    for (let i = 0; i < 20; i++) G.applyMovementInput(w, p, 0, .05);
    expect(w.get(p, Transform)!.facing).toBeCloseTo(SOUTH, 5);
    expect(Math.abs(Math.atan2(Math.sin(w.get(p, Transform)!.facing - NORTH), Math.cos(w.get(p, Transform)!.facing - NORTH)))).toBeGreaterThan(1);
  });
});
