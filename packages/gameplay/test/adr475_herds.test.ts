/**
 * ADR-475: wild-deer herds graze and move on when the patch is bare.
 * A herd is a spawn-centre cohort (no Herd component — the scope's migrationSystem / wildlife.ts do
 * not exist in this tree; the real system is animalAISystem + the tamed graze path). Deer only:
 * an Idle deer on ungrazed grass starts a 20 s graze (at most one start per deer per 30 s); on
 * completion the tile becomes a bare GrazedTile (180 s regrow, shared with the tamed path). When
 * more than half the grass within 5 tiles of the herd centre is bare, the shared home shifts
 * deterministically 40-100 tiles in the seasonal direction (winter west, summer east) and the deer
 * drift toward it. Scope corrections recorded here: the "grass nodes" the scope imagined do not
 * exist — grazing reuses the tamed GrazedTile/Grazing path exactly (same timings, same shared tile
 * state); the move is a drift by wandering, not the scope's migration machinery.
 */
import { describe, it, expect } from "vitest";
import { setSeason, Transform, type Entity, type World } from "@engine/core";
import { TileMap } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld as baseWorld, steps } from "./helpers.js";

const makeWorld = (): World => { const w = baseWorld(); w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem); return w; };
/** A grass meadow big enough for a 40-100 tile move-on in any direction from the test homes. */
function grassWorld(w: World): TileMap {
  const map = new TileMap();
  w.setResource(G.TerrainRes, G.terrainFromTileMap(map));
  for (let x = 0; x <= 120; x++) for (let y = 0; y <= 40; y++) map.setTile(x, y, G.GRASS_TILE);
  return map;
}
const deerAt = (w: World, x: number, y: number): Entity => {
  const d = G.spawnAnimal(w, "animal_deer", x, y);
  // Keep the think branch out of the way: the graze runs per-tick regardless of thinkAt, and the
  // deer stays Idle until a graze completes (or the test sets thinkAt itself).
  w.setField(d, G.Animal, "thinkAt", w.tick + 100000);
  return d;
};
const graze = (w: World, e: Entity) => w.get(e, G.Grazing);
const grazedTiles = (w: World): Entity[] => [...w.query([G.GrazedTile])];
const grazePatch = (w: World, homeX: number, homeY: number, radius = 5): void => {
  // Bare out the whole patch around the home (every grass tile within the radius gets a live
  // GrazedTile), so the next graze completion (or think tick) must move the herd on.
  const cx = Math.floor(homeX), cy = Math.floor(homeY);
  for (let ty = cy - radius; ty <= cy + radius; ty++) for (let tx = cx - radius; tx <= cx + radius; tx++) {
    if (Math.hypot(tx + 0.5 - homeX, ty + 0.5 - homeY) > radius) continue;
    const g = w.create(); w.add(g, G.GrazedTile, { tx, ty, regrowTick: w.tick + 3600 }); G.indexEntity(w, g);
  }
};

describe("ADR-475 wild-deer herds graze and move on", () => {
  it("herd tuning reads ai.json (30 s cooldown, radius 5, half bare, 40-100 tiles)", () => {
    expect(G.herdTuning()).toEqual({ grazeCooldownSeconds: 30, bareRadius: 5, bareFrac: 0.5, moveMinTiles: 40, moveMaxTiles: 100 });
  });

  it("herdPatchState counts grass and live grazed tiles (expired grazed tiles do not count)", () => {
    const w = makeWorld(); grassWorld(w);
    expect(G.herdPatchState(w, 10.5, 10.5, 5).grass).toBeGreaterThan(50);
    expect(G.herdPatchState(w, 10.5, 10.5, 5).grazed).toBe(0);
    const g = w.create(); w.add(g, G.GrazedTile, { tx: 10, ty: 10, regrowTick: w.tick + 3600 }); G.indexEntity(w, g);
    expect(G.herdPatchState(w, 10.5, 10.5, 5).grazed).toBe(1);
    const stale = w.create(); w.add(stale, G.GrazedTile, { tx: 11, ty: 10, regrowTick: w.tick }); G.indexEntity(w, stale);
    expect(G.herdPatchState(w, 10.5, 10.5, 5).grazed).toBe(1); // regrown: grass again, not bare
  });

  it("herdNewHome is deterministic, 40-100 tiles out, winter west / summer east", () => {
    const w = makeWorld(); grassWorld(w);
    setSeason(w, 2, 1.5); // winter
    const winter = G.herdNewHome(w, 100.5, 20.5)!;
    expect(G.herdNewHome(w, 100.5, 20.5)).toEqual(winter); // same home + season -> same new home
    expect(winter.x).toBeLessThan(100.5);
    expect(Math.hypot(winter.x - 100.5, winter.y - 20.5)).toBeGreaterThanOrEqual(40);
    expect(Math.hypot(winter.x - 100.5, winter.y - 20.5)).toBeLessThanOrEqual(100);
    setSeason(w, 0, 1.5); // summer
    const summer = G.herdNewHome(w, 10.5, 10.5)!;
    expect(summer.x).toBeGreaterThan(10.5);
    expect(Math.hypot(summer.x - 10.5, summer.y - 10.5)).toBeGreaterThanOrEqual(40);
    expect(Math.hypot(summer.x - 10.5, summer.y - 10.5)).toBeLessThanOrEqual(100);
  });

  it("an Idle deer on grass starts a graze, and after 20 s the tile is bare", () => {
    const w = makeWorld(); grassWorld(w);
    const deer = deerAt(w, 10.5, 10.5);
    steps(w, 1);
    expect(graze(w, deer)).toBeDefined(); // starts on the first tick: Idle on ungrazed grass
    expect(graze(w, deer)!.tx).toBe(10);
    steps(w, 19 * 20 - 1); // 19 s more: still grazing
    expect(graze(w, deer)).toBeDefined();
    steps(w, 21); // 20 s total (401 ticks: the graze completes on the first run at/after doneTick)
    expect(graze(w, deer)).toBeUndefined();
    const bare = grazedTiles(w);
    expect(bare).toHaveLength(1);
    expect(w.get(bare[0]!, G.GrazedTile)).toMatchObject({ tx: 10, ty: 10 });
    expect(w.get(bare[0]!, G.GrazedTile)!.regrowTick).toBeGreaterThan(w.tick); // bare for 180 s
  });

  it("a deer does not start a second graze within the 30 s cooldown", () => {
    const w = makeWorld(); grassWorld(w);
    const deer = deerAt(w, 10.5, 10.5);
    steps(w, 20 * 20 + 1); // graze completes at 20 s (start was tick 0/1)
    expect(graze(w, deer)).toBeUndefined();
    expect(grazedTiles(w)).toHaveLength(1);
    // Fresh grass one tile over, still inside the cooldown (started at tick 0/1, cooldown 30 s).
    w.set(deer, Transform, { x: 11.5, y: 10.5 });
    steps(w, 9 * 20); // 29 s after the start: still cooling down
    expect(graze(w, deer)).toBeUndefined();
    steps(w, 20); // 30 s after the start: a new graze may begin
    expect(graze(w, deer)).toBeDefined();
    expect(graze(w, deer)!.tx).toBe(11);
  });

  it("a bare patch moves the herd on: home shifts 40-100 tiles east (summer) and the deer walks to it", () => {
    const w = makeWorld(); grassWorld(w);
    setSeason(w, 0, 1.5); // summer: east
    const deer = deerAt(w, 10.5, 10.5);
    grazePatch(w, 10.5, 10.5);
    const expected = G.herdNewHome(w, 10.5, 10.5)!;
    // A graze that completes now: the tile is already bare (refresh path), then the patch check fires.
    w.add(deer, G.Grazing, { tx: 10, ty: 10, doneTick: w.tick });
    steps(w, 1);
    const a = w.get(deer, G.Animal)!;
    expect(a.homeX).toBeCloseTo(expected.x);
    expect(a.homeY).toBeCloseTo(expected.y);
    expect(a.state).toBe(G.AnimalState.Wander);
    expect(a.goalX).toBeCloseTo(expected.x);
    expect(a.goalY).toBeCloseTo(expected.y);
  });

  it("a patch that is not bare keeps the herd where it is", () => {
    const w = makeWorld(); grassWorld(w);
    setSeason(w, 0, 1.5);
    const deer = deerAt(w, 10.5, 10.5);
    w.add(deer, G.Grazing, { tx: 10, ty: 10, doneTick: w.tick });
    steps(w, 1);
    const a = w.get(deer, G.Animal)!;
    expect(a.homeX).toBeCloseTo(10.5);
    expect(a.homeY).toBeCloseTo(10.5);
    expect(grazedTiles(w)).toHaveLength(1); // the graze still depletes its tile
  });

  it("a deer standing on bare ground checks the patch on its think tick (no graze needed)", () => {
    const w = makeWorld(); grassWorld(w);
    setSeason(w, 0, 1.5);
    const deer = G.spawnAnimal(w, "animal_deer", 10.5, 10.5);
    grazePatch(w, 10.5, 10.5); // the deer stands on a grazed tile; the patch is bare
    const expected = G.herdNewHome(w, 10.5, 10.5)!;
    steps(w, 1); // thinkAt is the spawn tick, so the think branch runs on the first tick
    const a = w.get(deer, G.Animal)!;
    expect(a.homeX).toBeCloseTo(expected.x);
    expect(a.homeY).toBeCloseTo(expected.y);
  });

  it("a rabbit never grazes (deer only)", () => {
    const w = makeWorld(); grassWorld(w);
    const rabbit = G.spawnAnimal(w, "animal_rabbit", 10.5, 10.5);
    w.setField(rabbit, G.Animal, "thinkAt", w.tick + 100000);
    steps(w, 25 * 20);
    expect(graze(w, rabbit)).toBeUndefined();
    expect(grazedTiles(w)).toHaveLength(0);
  });

  it("a grazing deer stays put on its think tick (it does not wander off mid-graze)", () => {
    const w = makeWorld(); grassWorld(w);
    const deer = G.spawnAnimal(w, "animal_deer", 10.5, 10.5);
    w.add(deer, G.Grazing, { tx: 10, ty: 10, doneTick: w.tick + 400 });
    // Think runs now (thinkAt is the spawn tick); without the keep-grazing branch the deer would
    // wander off half the time and abandon the graze.
    for (let i = 0; i < 20; i++) {
      w.setField(deer, G.Animal, "thinkAt", w.tick);
      steps(w, 1);
      expect(w.get(deer, G.Animal)!.state).toBe(G.AnimalState.Idle);
    }
    expect(graze(w, deer)).toBeDefined();
  });
});
