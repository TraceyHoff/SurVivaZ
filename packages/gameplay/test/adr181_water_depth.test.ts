import { describe, expect, it } from "vitest";
import { Transform } from "@engine/core";
import { waterDepthAt, WaterDepth } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

// lake: water for 0 <= x < 20 (any y), grass elsewhere. Shallow band = x 0..1 and 18..19; deep = x 2..17.
const lake = (tx: number): number => (tx >= 0 && tx < 20 ? 1 : 3);
function world() { const w = makeWorld(); w.setResource(G.TerrainRes, { tileAt: (tx: number) => lake(tx), heightAt: () => 0 }); return w; }
const dx = (w: ReturnType<typeof makeWorld>, x: number, actions: number, running = false): number => {
  const p = G.spawnPlayer(w, { x, y: 5.5 }); if (running) { for (let i = 0; i < 20; i++) { G.applyMovementInput(w, p, actions, .05); w.set(p, Transform, { x, y: 5.5 }); } }
  const a = w.get(p, Transform)!.x; G.applyMovementInput(w, p, actions, 0.05); return w.get(p, Transform)!.x - a;
};
const R = G.GameplayActions.MoveDown | G.GameplayActions.MoveRight;

describe("ADR-181 shallow vs deep water", () => {
  it("depth derives from distance to shore (no new persisted tile); tile 8 is always shallow", () => {
    expect(waterDepthAt(lake, -1, 0)).toBe(WaterDepth.None);
    expect(waterDepthAt(lake, 0, 0)).toBe(WaterDepth.Shallow); expect(waterDepthAt(lake, 1, 0)).toBe(WaterDepth.Shallow);
    expect(waterDepthAt(lake, 2, 0)).toBe(WaterDepth.Deep); expect(waterDepthAt(lake, 10, 0)).toBe(WaterDepth.Deep);
    expect(waterDepthAt(lake, 18, 0)).toBe(WaterDepth.Shallow);
    expect(waterDepthAt(() => 8, 0, 0)).toBe(WaterDepth.Shallow);
    expect(waterDepthAt((x) => (x === 0 ? 1 : 0), 0, 0)).toBe(WaterDepth.Deep); // unloaded neighbours are not shore
  });
  it("wade at ~0.7x in shallow, swim slower in deep, and deep water ignores sprint", () => {
    const w = world(); const land = dx(w, -5.5, R);
    expect(dx(w, 0.5, R) / land).toBeCloseTo(0.7, 2);
    expect(dx(w, 10.5, R) / land).toBeCloseTo(G.defaultDefs().movement.swimSpeedMul, 2);
    expect(G.defaultDefs().movement.swimSpeedMul).toBeLessThan(0.4);
    expect(dx(w, 10.5, R, true)).toBeCloseTo(dx(w, 10.5, R), 5);
    expect(dx(w, 0.5, R, true)).toBeGreaterThan(dx(w, 0.5, R) * 1.2);
  });
  it("shallow is walkable for non-swimmers (AI, vehicles); deep blocks them", () => {
    const w = world();
    expect(G.movementBlocked(w, -0.5, 5.5, 0.5, 5.5, 0, false)).toBe(false);
    expect(G.movementBlocked(w, 1.5, 5.5, 2.5, 5.5, 0, false)).toBe(true);
    expect(G.movementBlocked(w, 1.5, 5.5, 2.5, 5.5, 0, true)).toBe(false);
    expect(G.terrainBlocksWalker(w, 1, 5)).toBe(false); expect(G.terrainBlocksWalker(w, 5, 5)).toBe(true);
  });
  it("Swim anim only in deep water; wading keeps Walk", () => {
    const w = world();
    const a = G.spawnPlayer(w, { x: 0.5, y: 5.5 }); w.add(a, G.AnimState, { anim: G.Anim.Walk, startTick: w.tick });
    const b = G.spawnPlayer(w, { x: 10.5, y: 5.5 }); w.add(b, G.AnimState, { anim: G.Anim.Walk, startTick: w.tick });
    steps(w, 1);
    expect(w.getField(a, G.AnimState, "anim")).toBe(G.Anim.Walk); expect(w.getField(b, G.AnimState, "anim")).toBe(G.Anim.Swim);
  });
  it("drinking works from shallow water", () => {
    const w = world(); expect(G.nearWater(w, 0.5, 5.5)).toBe(true); expect(G.nearWater(w, -0.5, 5.5)).toBe(true);
  });
  it("a loot bag dropped in deep water floats to the nearest wadeable tile", () => {
    const w = world(); const p = G.spawnPlayer(w, { x: 4.5, y: 5.5 }); const d = G.defaultDefs();
    G.addItem(w, p, d.itemId("stone"), 3); w.set(p, Transform, { facing: Math.PI });
    const bag = G.dropItem(w, p, d.itemId("stone"), 3)!; expect(bag).toBeDefined();
    steps(w, 20 * 6);
    const t = w.get(bag, Transform)!; expect(G.inDeepWater(w, t.x, t.y)).toBe(false); expect(t.x).toBeLessThan(2.5);
  });
});
