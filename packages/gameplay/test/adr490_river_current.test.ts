/**
 * ADR-490: rivers push you downstream. A forced river pushes an idle swimmer (and a steering
 * swimmer, on top of their steering) downstream at riverCurrentTilesPerSec (0.3 tiles/s), and
 * pushes a paddle/motor boat underway — but not a sailboat (wind-only) and not a parked boat.
 * The lookup is the cached region-aware layout: the naive default-layout call is blank outside
 * region zero, so a river in region (1,0) is the regression test for the scope's central trap.
 */
import { describe, it, expect } from "vitest";
import { fnv1a, NetId, Transform, Weather, type Entity, type World } from "@engine/core";
import { REGION_SIZE, riverPoint, waterFeatureAt, waterFeatureLayout } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

const SEED = 42;
const layout0 = waterFeatureLayout(SEED);

/** First river tile on the centreline with |u| <= 60 (a good stretch, near spawn). */
const riverTile = (): { tx: number; ty: number } => {
  for (let u = -60; u <= 60; u++) {
    const p = riverPoint(layout0, u);
    const tx = Math.floor(p.x), ty = Math.floor(p.y);
    if (waterFeatureAt(SEED, tx, ty, layout0) === "river") return { tx, ty };
  }
  throw new Error("no river tile found in region zero (seed 42)");
};
/** A land tile well away from the river (for the land control). */
const landTile = (): { tx: number; ty: number } => {
  const r = riverTile();
  for (let ty = -20; ty <= 20; ty++) for (let tx = -20; tx <= 20; tx++) {
    if (waterFeatureAt(SEED, tx, ty, layout0) !== "none") continue;
    if (Math.hypot(tx - r.tx, ty - r.ty) < 5) continue;
    return { tx, ty };
  }
  throw new Error("no land tile found near spawn (seed 42)");
};
/** Centre of the control lake: a land tile far from the river, ringed by water in the test world. */
const controlCentre = (): { tx: number; ty: number } => {
  const r = riverTile();
  for (let ty = -100; ty <= 100; ty += 10) for (let tx = -100; tx <= 100; tx += 10) {
    if (waterFeatureAt(SEED, tx, ty, layout0) !== "none") continue;
    if (Math.hypot(tx - r.tx, ty - r.ty) < 25) continue;
    return { tx, ty };
  }
  throw new Error("no control site found (seed 42)");
};
const CTRL = controlCentre();

/** River tiles are water, the control lake is water, everything else is land. Calm weather (no wind drift). */
function world(): World {
  const w = makeWorld();
  w.setResource(G.TerrainRes, {
    tileAt: (tx: number, ty: number) => {
      if (waterFeatureAt(SEED, tx, ty, layout0) === "river") return 1;
      if (Math.abs(tx - CTRL.tx) <= 10 && Math.abs(ty - CTRL.ty) <= 10) return 1;
      return 3;
    },
    heightAt: () => 0,
  });
  Object.assign(w.env(Weather), { windSpeed: 0, windDir: 0 });
  return w;
}
const pos = (w: World, e: Entity): { x: number; y: number } => {
  const t = w.get(e, Transform)!; return { x: t.x, y: t.y };
};
let nid = 4900;
const net = (w: World, e: Entity): Entity => { w.add(e, NetId, { id: ++nid }); return e; };
/** A boat coasting at speed 1 (no driver, no input) on the given heading. */
const boat = (w: World, bid: string, x: number, y: number, h: number): Entity => {
  const v = net(w, G.spawnVehicle(w, bid, x, y, h));
  w.setField(v, G.Vehicle, "speed", 1);
  return v;
};

describe("ADR-490 rivers push you downstream", () => {
  it("data: the current is 0.3 tiles/s (a swimmer swims ~1.45, so it is noticeable but fightable)", () => {
    expect(G.defaultDefs().movement.riverCurrentTilesPerSec).toBe(0.3);
    expect(G.gameplayDefs(makeWorld()).movement.riverCurrentTilesPerSec).toBe(0.3);
  });

  it("riverCurrentAt: unit downstream direction on a river tile, undefined on land and lake", () => {
    const w = makeWorld();
    const r = riverTile();
    const dir = G.riverCurrentAt(w, r.tx + 0.5, r.ty + 0.5);
    expect(dir).toBeDefined();
    expect(Math.hypot(dir!.x, dir!.y)).toBeCloseTo(1, 6);
    // independent check: the meander derivative at the same u.
    const rv = layout0.river;
    const u = (r.tx + 0.5) * Math.cos(rv.angle) + (r.ty + 0.5) * Math.sin(rv.angle);
    const slope = (rv.amp / rv.period) * Math.cos(u / rv.period + rv.phase);
    const ex = Math.cos(rv.angle) - Math.sin(rv.angle) * slope;
    const ey = Math.sin(rv.angle) + Math.cos(rv.angle) * slope;
    const len = Math.hypot(ex, ey);
    expect(dir!.x).toBeCloseTo(ex / len, 6);
    expect(dir!.y).toBeCloseTo(ey / len, 6);
    // downstream (+u), not upstream: within the meander's ~38° swing of the base angle.
    expect(dir!.x * Math.cos(rv.angle) + dir!.y * Math.sin(rv.angle)).toBeGreaterThan(0.78);
    // deterministic: the same tile twice gives the same direction.
    const again = G.riverCurrentAt(w, r.tx + 0.5, r.ty + 0.5)!;
    expect(again.x).toBe(dir!.x); expect(again.y).toBe(dir!.y);
    // land and lake are not rivers.
    const l = landTile();
    expect(G.riverCurrentAt(w, l.tx + 0.5, l.ty + 0.5)).toBeUndefined();
    expect(G.riverCurrentAt(w, layout0.lake.x + 0.5, layout0.lake.y + 0.5)).toBeUndefined();
  });

  it("a river in a non-zero region is found (the default-layout call is blank there)", () => {
    const w = makeWorld();
    const rx = 1, ry = 0;
    const regionSeed = fnv1a("1,0", SEED >>> 0);
    const layout1 = waterFeatureLayout(regionSeed, undefined, 3);
    let found: { lx: number; ly: number } | undefined;
    for (let u = -90; u <= 90 && !found; u++) {
      const p = riverPoint(layout1, u);
      const lx = Math.floor(p.x), ly = Math.floor(p.y);
      if (waterFeatureAt(regionSeed, lx, ly, layout1) === "river") found = { lx, ly };
    }
    expect(found).toBeDefined();
    const wx = found!.lx + rx * REGION_SIZE + 0.5, wy = found!.ly + ry * REGION_SIZE + 0.5;
    const dir = G.riverCurrentAt(w, wx, wy);
    expect(dir).toBeDefined();
    expect(Math.hypot(dir!.x, dir!.y)).toBeCloseTo(1, 6);
    // the trap: the default (region-zero) layout classifies this world tile as nothing.
    expect(waterFeatureAt(SEED, found!.lx + rx * REGION_SIZE, found!.ly + ry * REGION_SIZE, layout0)).toBe("none");
  });

  it("an idle swimmer drifts downstream at the river current (0.3 tiles in 1 s)", () => {
    const w = world();
    const r = riverTile();
    const x0 = r.tx + 0.5, y0 = r.ty + 0.5;
    const p = G.spawnPlayer(w, { x: x0, y: y0 });
    const dir = G.riverCurrentAt(w, x0, y0)!;
    for (let i = 0; i < 20; i++) { G.applyMovementInput(w, p, 0, 1 / 20); w.step(1 / 20); }
    const p1 = pos(w, p);
    const along = (p1.x - x0) * dir.x + (p1.y - y0) * dir.y;
    const across = Math.abs((p1.x - x0) * -dir.y + (p1.y - y0) * dir.x);
    expect(along).toBeGreaterThan(0.2);
    expect(along).toBeLessThan(0.4);
    expect(across).toBeLessThan(0.05);
  });

  it("a steering swimmer is pushed downstream on top of their steering (downstream plus upstream ~ 2 x 0.3)", () => {
    const r = riverTile();
    const x0 = r.tx + 0.5, y0 = r.ty + 0.5;
    const dir0 = G.riverCurrentAt(makeWorld(), x0, y0)!;
    const run = (analog: { x: number; y: number }): number => {
      const w = world();
      const p = G.spawnPlayer(w, { x: x0, y: y0 });
      for (let i = 0; i < 20; i++) { G.applyMovementInput(w, p, 0, 1 / 20, analog); w.step(1 / 20); }
      const p1 = pos(w, p);
      return (p1.x - x0) * dir0.x + (p1.y - y0) * dir0.y;
    };
    // Downstream along = swim + 0.3; upstream along = -(swim - 0.3) = -swim + 0.3. The SUM cancels
    // the swim speed and leaves 2 x the current; the difference would be 2 x the swim speed.
    const downstream = run({ x: dir0.x, y: dir0.y });
    const upstream = run({ x: -dir0.x, y: -dir0.y });
    expect(downstream).toBeGreaterThan(upstream);
    expect(downstream + upstream).toBeGreaterThan(0.4);
    expect(downstream + upstream).toBeLessThan(0.8);
  });

  it("a swimmer on land does not drift", () => {
    const w = world();
    const l = landTile();
    const p = G.spawnPlayer(w, { x: l.tx + 0.5, y: l.ty + 0.5 });
    for (let i = 0; i < 20; i++) { G.applyMovementInput(w, p, 0, 1 / 20); w.step(1 / 20); }
    const p1 = pos(w, p);
    expect(p1.x).toBe(l.tx + 0.5);
    expect(p1.y).toBe(l.ty + 0.5);
  });

  it("a paddle boat underway drifts downstream; a sailboat does not (wind-only)", () => {
    const r = riverTile();
    const rv = layout0.river;
    const x0 = r.tx + 0.5, y0 = r.ty + 0.5;
    const dir = G.riverCurrentAt(makeWorld(), x0, y0)!;
    const run = (bid: string, x: number, y: number): number => {
      const w = world();
      const v = boat(w, bid, x, y, rv.angle);
      for (let i = 0; i < 20; i++) w.step(1 / 20);
      const t = pos(w, v);
      return (t.x - x) * dir.x + (t.y - y) * dir.y;
    };
    // Same boat, same heading, same speed: the river run coasts identically to the lake run except for the current.
    const paddleRiver = run("rowboat", x0, y0);
    const paddleLake = run("rowboat", CTRL.tx + 0.5, CTRL.ty + 0.5);
    expect(paddleRiver - paddleLake).toBeGreaterThan(0.2);
    expect(paddleRiver - paddleLake).toBeLessThan(0.4);
    const sailRiver = run("sailboat", x0, y0);
    const sailLake = run("sailboat", CTRL.tx + 0.5, CTRL.ty + 0.5);
    expect(Math.abs(sailRiver - sailLake)).toBeLessThan(0.05);
  });

  it("a parked boat does not drift (the at-rest early return, like the wind drift)", () => {
    const w = world();
    const r = riverTile();
    const x0 = r.tx + 0.5, y0 = r.ty + 0.5;
    const v = net(w, G.spawnVehicle(w, "rowboat", x0, y0, layout0.river.angle));
    for (let i = 0; i < 20; i++) w.step(1 / 20);
    const t = pos(w, v);
    expect(t.x).toBe(x0);
    expect(t.y).toBe(y0);
  });
});
