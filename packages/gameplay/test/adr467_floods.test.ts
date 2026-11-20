/**
 * ADR-467: rivers that flood — a heavy rain or storm swells sea-level water onto low shore ground (at most
 * 3 tiles out), the flood water is natural water (so it freezes in winter), and it recedes GRADUALLY over
 * in-game time (never a single-step clear). Spring melt raises the lake level by 1 tile; summer drains it.
 * Flood water never touches an elevated lake or a spillway (waterfall rule): it spreads only from sea-level
 * water and never floods a tile adjacent to water whose surface is not 0. Distance is Manhattan, via the
 * 4-neighbour advance (the flow system's neighbour rule), capped at 3.
 */
import { describe, it, expect } from "vitest";
import { setSeason, type World } from "@engine/core";
import { flowWaterRaw, isFlowWater, TileMap, WATER_TILE } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

const F = G.FLOOD;
const DT = 20; // ticks per in-game second
const LAKE: [number, number] = [10, 10];
/** Tiles at Manhattan distance d from the lake (the flood's distance). */
function distTiles(d: number): [number, number][] {
  const out: [number, number][] = [];
  for (let dx = -d; dx <= d; dx++) for (let dy = -d; dy <= d; dy++) if (Math.abs(dx) + Math.abs(dy) === d) out.push([LAKE[0] + dx, LAKE[1] + dy]);
  return out;
}
/** A flat grass field (tile 3, height 0) with a 1-tile lake at (10,10) (tile 1, height 0), wired in as the world's terrain. `high` = tiles raised to height 2 (bed above the water surface, never flood). */
function shore(w: World, high: [number, number][] = []): TileMap {
  const map = new TileMap();
  for (let y = -16; y <= 47; y++) for (let x = -16; x <= 47; x++) {
    map.setTile(x, y, 3);
    map.ensureChunk(Math.floor(x / 32), Math.floor(y / 32)).setHeight(((x % 32) + 32) % 32, ((y % 32) + 32) % 32, 0);
  }
  map.setTile(LAKE[0], LAKE[1], WATER_TILE);
  for (const [hx, hy] of high) map.ensureChunk(Math.floor(hx / 32), Math.floor(hy / 32)).setHeight(((hx % 32) + 32) % 32, ((hy % 32) + 32) % 32, 2);
  w.setResource(G.TerrainRes, G.terrainFromTileMap(map));
  return map;
}
const tileAt = (w: World, x: number, y: number): number => w.resource(G.TerrainRes).tileAt(x, y);
const rawAt = (w: World, x: number, y: number): number => w.resource(G.TerrainRes).rawHeightAt!(x, y);
/** Emit a WeatherChanged and deliver it (emit is deferred: the delivery happens on the step). */
function rain(w: World, kind: number, intensity: number): void {
  G.emit(w, G.WeatherChanged, { from: G.WeatherKind.Clear, to: kind, intensity, ticks: 1200 });
  steps(w, 1);
}
/** Flood the shore: heavy rain, then 3 flood steps (one tile per step outward). Returns the tick the flood happened at. */
function floodShore(w: World): number {
  rain(w, G.WeatherKind.Rain, 0.8);
  expect(G.floodSeededCount(w)).toBeGreaterThan(0);
  const t = w.tick;
  for (let i = 0; i < 3; i++) G.floodSystem(w);
  return t;
}

describe("ADR-467 rivers that flood", () => {
  it("heavy rain seeds the shore and the flood advances to 3 tiles, then stops (cap); light rain does not seed", () => {
    const w = makeWorld();
    shore(w);
    G.spawnPlayer(w, { x: 10.5, y: 13.5 });
    rain(w, G.WeatherKind.Rain, 0.5); // light rain: below rainIntensityMin 0.7
    expect(G.floodSeededCount(w)).toBe(0);
    expect(G.floodTiles(w)).toHaveLength(0);
    floodShore(w);
    for (const d of [1, 2, 3]) for (const [x, y] of distTiles(d)) expect(tileAt(w, x, y)).toBe(WATER_TILE);
    for (const [x, y] of [[6, 10], [14, 10], [10, 6], [10, 14], [7, 7], [13, 13]] as [number, number][]) expect(tileAt(w, x, y)).toBe(3); // dist 4: the cap
    const tiles = G.floodTiles(w);
    expect(tiles).toHaveLength(24); // 4 + 8 + 12
    for (const t of tiles) { expect(t.kind).toBe(G.FLOOD_KIND_STORM); expect(t.dist).toBeGreaterThanOrEqual(1); expect(t.dist).toBeLessThanOrEqual(3); }
    // The drain is staggered outermost-first: dist 3 drains drainAfterSeconds after flooding, dist 1 two steps later.
    const byDist = (d: number) => tiles.find((t) => t.dist === d)!;
    expect(byDist(1).drainTick - byDist(3).drainTick).toBe(2 * F.drainStepSeconds * DT);
    expect(byDist(3).drainTick - w.tick).toBeLessThanOrEqual(F.drainAfterSeconds * DT + 1); // flooded at (or just after) the seed tick
    // Flood water is natural water (raw height = the bed, not flow-encoded), so it freezes like the lake.
    expect(isFlowWater(tileAt(w, 9, 10), rawAt(w, 9, 10))).toBe(false);
    expect(rawAt(w, 9, 10)).toBe(0);
  });

  it("a storm seeds even at low intensity", () => {
    const w = makeWorld();
    shore(w);
    G.spawnPlayer(w, { x: 10.5, y: 13.5 });
    rain(w, G.WeatherKind.Storm, 0.2);
    expect(G.floodSeededCount(w)).toBeGreaterThan(0);
  });

  it("high ground (bed above the water surface) never floods", () => {
    const w = makeWorld();
    shore(w, [[13, 10]]); // dist 3, raised to height 2
    G.spawnPlayer(w, { x: 10.5, y: 13.5 });
    floodShore(w);
    expect(tileAt(w, 13, 10)).toBe(3); // high: still land
    for (const [x, y] of distTiles(1)) expect(tileAt(w, x, y)).toBe(WATER_TILE); // the low shore still floods
    expect(G.floodTiles(w).some((t) => t.tx === 13 && t.ty === 10)).toBe(false);
  });

  it("a tile with a tree on it never floods (blocked), and the tree survives", () => {
    const w = makeWorld();
    shore(w);
    G.spawnPlayer(w, { x: 10.5, y: 13.5 });
    const tree = G.spawnResourceNode(w, "tree", 10, 11); // dist 1, south of the lake
    floodShore(w);
    expect(tileAt(w, 10, 11)).toBe(3); // blocked: still land
    expect(w.isAlive(tree)).toBe(true);
    for (const [x, y] of [[9, 10], [11, 10], [10, 9]] as [number, number][]) expect(tileAt(w, x, y)).toBe(WATER_TILE);
  });

  it("the flood recedes gradually, outermost first, and leaves the ground wet (mud)", () => {
    const w = makeWorld();
    shore(w);
    G.spawnPlayer(w, { x: 10.5, y: 13.5 });
    const t0 = floodShore(w);
    const tiles = G.floodTiles(w);
    expect(tiles).toHaveLength(24);
    const drain3 = tiles.find((t) => t.dist === 3)!.drainTick;
    const drain1 = tiles.find((t) => t.dist === 1)!.drainTick;
    expect(drain3).toBe(t0 + F.drainAfterSeconds * DT); // dist 3 drains first
    expect(drain1).toBe(t0 + (F.drainAfterSeconds + 2 * F.drainStepSeconds) * DT);
    // Jump to just past the dist-3 drain: the outer ring recedes, the inner rings stay flooded.
    w.tick = drain3 + 1;
    G.floodSystem(w);
    for (const [x, y] of distTiles(3)) expect(tileAt(w, x, y)).toBe(3);
    for (const [x, y] of distTiles(1)) expect(tileAt(w, x, y)).toBe(WATER_TILE);
    for (const [x, y] of distTiles(2)) expect(tileAt(w, x, y)).toBe(WATER_TILE);
    expect(G.chunkWetnessAt(w, 7, 10)).toBe(1); // the drained ground is wet (mud)
    expect(G.floodTiles(w)).toHaveLength(12); // 4 + 8 remain
    // Jump past the dist-1 drain: the whole flood is gone, and the ground stays wet.
    w.tick = drain1 + 1;
    G.floodSystem(w);
    for (const d of [1, 2]) for (const [x, y] of distTiles(d)) expect(tileAt(w, x, y)).toBe(3);
    expect(G.floodTiles(w)).toHaveLength(0);
    expect(G.chunkWetnessAt(w, 9, 10)).toBe(1);
    expect(tileAt(w, 10, 10)).toBe(WATER_TILE); // the lake itself is untouched
  });

  it("flood water freezes in winter like the lake (natural water, not flow water)", () => {
    const w = makeWorld();
    shore(w);
    G.spawnPlayer(w, { x: 10.5, y: 13.5 });
    floodShore(w);
    expect(G.isFrozenWaterAt(w, 9, 10)).toBe(false); // summer: liquid
    setSeason(w, 2, 1); // winter
    expect(G.isWaterFrozen(w)).toBe(true);
    expect(G.isFrozenWaterAt(w, 9, 10)).toBe(true); // the flood tile freezes
    expect(G.isFrozenWaterAt(w, 10, 10)).toBe(true); // the lake freezes too
  });

  it("the waterfall rule: a tile next to flow water (a spillway) never floods", () => {
    const w = makeWorld();
    const map = shore(w);
    // A spillway-like channel east of the lake: flow-encoded water at level 5 (surface 5, not sea level).
    map.setTile(12, 10, WATER_TILE);
    map.ensureChunk(0, 0).setHeight(12, 10, flowWaterRaw(5));
    G.spawnPlayer(w, { x: 10.5, y: 13.5 });
    floodShore(w);
    expect(tileAt(w, 11, 10)).toBe(3); // between the lake and the spillway: excluded, still land
    for (const [x, y] of [[9, 10], [10, 9], [10, 11]] as [number, number][]) expect(tileAt(w, x, y)).toBe(WATER_TILE); // the rest of the shore floods
    expect(G.waterSurfaceAt(w.resource(G.TerrainRes), 12, 10)).toBe(5); // the spillway reads at its level
  });

  it("seasonal lake levels: spring floods the +1 band (seasonal), summer schedules its drain, and it recedes", () => {
    const w = makeWorld();
    shore(w);
    G.spawnPlayer(w, { x: 10.5, y: 13.5 });
    setSeason(w, 3, 1); // spring
    G.floodSystem(w); // the season change seeds the spring band
    for (const [x, y] of distTiles(1)) expect(tileAt(w, x, y)).toBe(WATER_TILE);
    for (const [x, y] of distTiles(2)) expect(tileAt(w, x, y)).toBe(3); // the band is 1 tile only: no advance
    const band = G.floodTiles(w);
    expect(band).toHaveLength(4);
    for (const t of band) { expect(t.kind).toBe(G.FLOOD_KIND_SEASONAL); expect(t.drainTick).toBe(G.FLOOD_DRAIN_NEVER); }
    setSeason(w, 0, 1); // summer
    G.floodSystem(w); // the season change schedules the drain
    const scheduled = G.floodTiles(w);
    expect(scheduled).toHaveLength(4);
    for (const t of scheduled) expect(t.drainTick).not.toBe(G.FLOOD_DRAIN_NEVER);
    // The drain is hash-staggered over seasonalDrainDays: jumping past the whole window drains the band.
    const latest = Math.max(...scheduled.map((t) => t.drainTick));
    w.tick = latest + 1;
    G.floodSystem(w);
    for (const [x, y] of distTiles(1)) expect(tileAt(w, x, y)).toBe(3);
    expect(G.floodTiles(w)).toHaveLength(0);
    expect(tileAt(w, 10, 10)).toBe(WATER_TILE); // the lake itself is untouched
  });

  it("a second storm during a recession does not push the flood past the 3-tile cap", () => {
    const w = makeWorld();
    shore(w);
    G.spawnPlayer(w, { x: 10.5, y: 13.5 });
    floodShore(w);
    expect(G.floodTiles(w)).toHaveLength(24);
    rain(w, G.WeatherKind.Rain, 0.9); // a second storm while the first flood is still out
    for (let i = 0; i < 3; i++) G.floodSystem(w);
    for (const [x, y] of [[6, 10], [14, 10], [10, 6], [10, 14]] as [number, number][]) expect(tileAt(w, x, y)).toBe(3); // still the cap
    expect(G.floodTiles(w)).toHaveLength(24); // no new flood tiles
  });
});
