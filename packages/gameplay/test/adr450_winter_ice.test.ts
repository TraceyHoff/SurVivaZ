/**
 * ADR-450: winter ice — still water freezes below 32 °F (blended season mean < 0 °C) and becomes
 * walkable, thawing in spring. No slip physics; walk speed is unchanged (1.0×). Flow water (rivers,
 * dug channels, waterfalls) never freezes. Boats / fishing on frozen lakes are out of scope (a boat
 * on frozen water reads as beached — see the collision note in REPORT.md).
 */
import { describe, it, expect } from "vitest";
import { setSeason, type World } from "@engine/core";
import { flowWaterRaw, TileMap, WaterDepth } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld as baseWorld, steps } from "./helpers.js";

// An 8x8 lake of tile 1 (water) at (20..27, 0..7): the interior (22..25, 2..5) is deep water
// (no land within the shallow radius 2); the outer ring is shallow (wadeable already).
const LAKE = { x0: 20, y0: 0, x1: 27, y1: 7 };
const DEEP = { x: 23.5, y: 3.5 }; // deep-water centre
const SHALLOW = { x: 20.5, y: 3.5 }; // shore band (shallow)
const FLOW = { x: 32.5, y: 3.5 }; // deep flow-water centre (river/channel), set below
const makeWorld = (): World => {
  const w = baseWorld();
  const map = new TileMap();
  // Real land around the lake: tile 0 (unset/unknown) never counts as land for waterDepthAt,
  // so the shore band only exists when the surrounding tiles are genuine land (GRASS_TILE).
  for (let x = 0; x <= 40; x++) for (let y = 0; y <= 10; y++) map.setTile(x, y, G.GRASS_TILE);
  for (let x = LAKE.x0; x <= LAKE.x1; x++) for (let y = LAKE.y0; y <= LAKE.y1; y++) map.setTile(x, y, 1);
  // A 5x5 block of flow water at (30..34, 1..5): the centre (32, 3) is deep flow water.
  for (let x = 30; x <= 34; x++) for (let y = 1; y <= 5; y++) map.setTile(x, y, 1);
  const terrain = G.terrainFromTileMap(map);
  for (let x = 30; x <= 34; x++) for (let y = 1; y <= 5; y++) terrain.setRawHeight!(x, y, flowWaterRaw(3)); // flow encoding: this water never freezes
  w.setResource(G.TerrainRes, terrain);
  return w;
};
// Season ids: 0 summer, 1 fall, 2 winter, 3 spring (core SeasonId).
const winter = (w: World) => setSeason(w, 2, 1);
const summer = (w: World) => setSeason(w, 0, 1);

describe("ADR-450 winter ice", () => {
  it("still water is frozen in winter, liquid in summer / fall / spring", () => {
    const w = makeWorld();
    summer(w);
    expect(G.isWaterFrozen(w)).toBe(false);
    setSeason(w, 1, 1); // fall
    expect(G.isWaterFrozen(w)).toBe(false);
    winter(w);
    expect(G.isWaterFrozen(w)).toBe(true);
    setSeason(w, 3, 1); // spring: thawed again
    expect(G.isWaterFrozen(w)).toBe(false);
    // The four checks above all ran at the same tick (setSeason does not advance it) — the frozen
    // cache must follow the season, not go stale across a setSeason.
  });

  it("isFrozenWaterAt: frozen still water only — not land, not flow water, not summer water", () => {
    const w = makeWorld();
    expect(G.isFrozenWaterAt(w, 23, 3)).toBe(false); // summer: liquid
    winter(w);
    expect(G.isFrozenWaterAt(w, 23, 3)).toBe(true); // deep still water, frozen
    expect(G.isFrozenWaterAt(w, 20, 3)).toBe(true); // shallow still water freezes too
    expect(G.isFrozenWaterAt(w, 10, 3)).toBe(false); // land never freezes
    expect(G.isFrozenWaterAt(w, 30, 3)).toBe(false); // flow water never freezes
  });

  it("movementBlocked: deep water blocks in summer, is walkable when frozen", () => {
    const w = makeWorld();
    summer(w);
    expect(G.movementBlocked(w, 21.5, 3.5, 22.5, 3.5, 0, false)).toBe(true); // into deep water
    expect(G.movementBlocked(w, 19.5, 3.5, 20.5, 3.5, 0, false)).toBe(false); // shallow: wadeable already
    winter(w);
    expect(G.movementBlocked(w, 21.5, 3.5, 22.5, 3.5, 0, false)).toBe(false); // frozen: walk across
    expect(G.movementBlocked(w, 21.5, 3.5, 22.5, 3.5, 0, false)).toBe(false); // (repeat: same tick, cached)
  });

  it("terrainBlocksWalker: animals and zombies cross the ice (and not the liquid lake)", () => {
    const w = makeWorld();
    summer(w);
    expect(G.terrainBlocksWalker(w, 23, 3)).toBe(true);
    winter(w);
    expect(G.terrainBlocksWalker(w, 23, 3)).toBe(false);
  });

  it("waterDepth / inWater / swimSpeedMulAt read frozen still water as land", () => {
    const w = makeWorld();
    const mv = G.defaultDefs().movement;
    summer(w);
    expect(G.waterDepth(w, DEEP.x, DEEP.y)).toBe(WaterDepth.Deep);
    expect(G.inWater(w, DEEP.x, DEEP.y)).toBe(true);
    expect(G.swimSpeedMulAt(w, DEEP.x, DEEP.y)).toBe(mv.swimSpeedMul);
    winter(w);
    expect(G.waterDepth(w, DEEP.x, DEEP.y)).toBe(WaterDepth.None);
    expect(G.inWater(w, DEEP.x, DEEP.y)).toBe(false);
    expect(G.swimSpeedMulAt(w, DEEP.x, DEEP.y)).toBe(1); // walk speed on ice, no slip physics
  });

  it("animSettle: walking on frozen water keeps the walk anim; liquid water swims", () => {
    const w = makeWorld();
    const p = G.spawnPlayer(w, { x: DEEP.x, y: DEEP.y });
    winter(w);
    w.add(p, G.AnimState, { anim: G.Anim.Walk, startTick: w.tick });
    G.animSettleSystem(w);
    expect(w.getField(p, G.AnimState, "anim")).toBe(G.Anim.Walk); // walked on the ice, never swam
    summer(w);
    w.set(p, G.AnimState, { anim: G.Anim.Walk, startTick: w.tick });
    G.animSettleSystem(w);
    expect(w.getField(p, G.AnimState, "anim")).toBe(G.Anim.Swim); // same spot in summer: swimming
    void steps;
  });

  it("flow water still blocks movement when frozen (it never freezes)", () => {
    const w = makeWorld();
    winter(w);
    expect(G.movementBlocked(w, 31.5, 3.5, 32.5, 3.5, 0, false)).toBe(true); // into deep flow water
    expect(G.waterDepth(w, FLOW.x, FLOW.y)).toBe(WaterDepth.Deep); // still deep water, just not frozen
    expect(G.isFrozenWaterAt(w, 32, 3)).toBe(false);
  });
});
