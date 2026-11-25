// ADR-411: dig 100 down / raise 100 up through the real shovel flow, from generated ground at both ends
// (0 and HEIGHT_MAX 26); water / persist / render / underground at the new extremes (ADR-529: was 300).
import { describe, expect, it } from "vitest";
import { setSeason, type Entity, type World } from "@engine/core";
import { TileMap, FLOW_WATER_LEVEL_MIN, FLOW_WATER_LEVEL_MAX, flowWaterRaw, isFlowWater, renderTileHeight, terrainLevel, WATER_TILE } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

const d = G.defaultDefs();
const id = (k: string): number => d.itemId(k);
const F = (c: number): number => c * 9 / 5 + 32;
/** A flat grass field (tile 3, height `h`) over [x0..x1] x [y0..y1] wired in as the world's terrain. */
function field(w: World, h = 2, x0 = -16, x1 = 47, y0 = -16, y1 = 47): TileMap {
  const map = new TileMap();
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { map.setTile(x, y, 3); map.ensureChunk(Math.floor(x / 32), Math.floor(y / 32)).setHeight(((x % 32) + 32) % 32, ((y % 32) + 32) % 32, h); }
  w.setResource(G.TerrainRes, G.terrainFromTileMap(map)); return map;
}
const hold = (w: World, p: Entity, key: string): void => {
  if (!G.countItem(w, p, id(key))) G.addItem(w, p, id(key), 1);
  let slot = 0; while (G.slotItem(w, p, slot).item !== id(key)) slot++;
  w.set(p, G.Equipment, { mainHandSlot: slot, mainHandItem: id(key) });
};
const hAt = (w: World, x: number, y: number): number => w.resource(G.TerrainRes).heightAt(x, y);

describe("ADR-411 dig 100 / raise 100 (ADR-529)", () => {
  it("bounds are exactly [-100, 100]: the absolute ceiling is the range, not generated ground + range, and the flow encoding agrees", () => {
    expect(G.LEVEL_MIN).toBe(-100); expect(G.LEVEL_MAX).toBe(100);
    expect(G.TERRAIN.minLevel).toBe(-100); expect(G.TERRAIN.maxLevel).toBe(100);
    expect(FLOW_WATER_LEVEL_MIN).toBe(G.LEVEL_MIN); expect(FLOW_WATER_LEVEL_MAX).toBe(G.LEVEL_MAX);
    expect(G.TERRAIN_EDIT_RANGE).toBe(100);
  });

  it("from generated ground 26: raise 74 to the ceiling, then dig 200 to the floor, both through the shovel", () => {
    const w = makeWorld(); field(w, 26); const p = G.spawnPlayer(w, { x: 0.5, y: 0.5, clientId: 1, maxWeight: 0 });
    hold(w, p, "stone_shovel"); G.addItem(w, p, id("soil"), 74);
    for (let i = 0; i < 74; i++) expect(G.editTerrain(w, p, 1, 0, 1)).toBe(G.TerrainFail.None);
    expect(hAt(w, 1, 0)).toBe(100); expect(G.terrainDigAt(w, 1, 0)).toBe(74);
    expect(G.editTerrain(w, p, 1, 0, 1)).toBe(G.TerrainFail.Limit); // exactly at the bound, not before
    expect(G.countItem(w, p, id("soil"))).toBe(0);
    for (let i = 0; i < 200; i++) expect(G.editTerrain(w, p, 1, 0, -1)).toBe(G.TerrainFail.None);
    expect(hAt(w, 1, 0)).toBe(-100); expect(G.terrainDigAt(w, 1, 0)).toBe(-126);
    expect(G.editTerrain(w, p, 1, 0, -1)).toBe(G.TerrainFail.Limit);
    expect(G.countItem(w, p, id("soil"))).toBe(200);
  });

  it("from generated ground 0: dig 100 to the floor through the shovel (Limit exactly at -100)", () => {
    const w = makeWorld(); field(w, 0); const p = G.spawnPlayer(w, { x: 0.5, y: 0.5, clientId: 1, maxWeight: 0 });
    hold(w, p, "stone_shovel");
    for (let i = 0; i < 100; i++) expect(G.editTerrain(w, p, 1, 0, -1)).toBe(G.TerrainFail.None);
    expect(hAt(w, 1, 0)).toBe(-100); expect(G.terrainDigAt(w, 1, 0)).toBe(-100);
    expect(G.editTerrain(w, p, 1, 0, -1)).toBe(G.TerrainFail.Limit);
    expect(G.isUnderground(w, 1, 0)).toBe(true); expect(G.undergroundDepthAt(w, 1, 0)).toBe(100);
  });

  it("a -100 pit floods from a lake and keeps its level through flow / render; water at 100 encodes too", () => {
    const w = makeWorld(); const map = field(w, 0); map.setTile(0, 0, WATER_TILE);
    const t = w.resource(G.TerrainRes);
    G.setTerrainDig(w, 1, 0, -100); expect(G.terrainFlowStep(w)).toBe(1);
    expect(t.tileAt(1, 0)).toBe(WATER_TILE);
    const raw = t.rawHeightAt!(1, 0);
    expect(isFlowWater(WATER_TILE, raw)).toBe(true);
    expect(terrainLevel(WATER_TILE, raw)).toBe(-100); expect(renderTileHeight(WATER_TILE, raw)).toBe(-100);
    expect(hAt(w, 1, 0)).toBe(-100); expect(G.waterSurfaceAt(t, 1, 0)).toBe(-100);
    // a water tile set to the flow-water ceiling encodes through the same path (land and flow water
    // now share the 100 cap, so a water tile's dig record can no longer run ahead of its decoded height)
    map.setTile(5, 5, WATER_TILE);
    G.setTerrainDig(w, 5, 5, 100);
    expect(terrainLevel(WATER_TILE, t.rawHeightAt!(5, 5))).toBe(100);
    expect(renderTileHeight(WATER_TILE, t.rawHeightAt!(5, 5))).toBe(100);
    expect(flowWaterRaw(100)).toBe(1100);
  });

  it("TerrainEdit dig ±100 persists through the chunk codec (i16 field, v2 heights)", async () => {
    const { Chunk, encodeChunk, decodeChunk } = await import("@engine/world");
    const w = makeWorld(); const map = field(w, 0);
    G.setTerrainDig(w, 1, 0, -100); G.setTerrainDig(w, 2, 0, 100);
    const edits = [...w.query([G.TerrainEdit])]; expect(edits).toHaveLength(2);
    const chunk = map.getChunk(0, 0)!;
    expect(chunk.getHeight(1, 0)).toBe(-100); expect(chunk.getHeight(2, 0)).toBe(100);
    const bytes = encodeChunk(chunk, { world: w, entities: edits });
    const w2 = makeWorld();
    const dec = decodeChunk(bytes, { world: w2 });
    expect(dec.chunk.getHeight(1, 0)).toBe(-100); expect(dec.chunk.getHeight(2, 0)).toBe(100);
    expect(dec.entities).toHaveLength(2);
    const digs = dec.entities.map((e) => w2.getField(e, G.TerrainEdit, "dig")).sort((a, b) => a! - b!);
    expect(digs).toEqual([-100, 100]);
  });

  it("60°F at 100 levels down in winter, while shallow ground follows the season", () => {
    const w = makeWorld({ dayLengthTicks: 24_000 }); field(w, 2);
    G.setTerrainDig(w, 4, 4, -102); // height -100, 102 below ground
    G.setTerrainDig(w, 6, 4, -2); // height 0, 2 below ground: still surface weather
    setSeason(w, 2, 2); // winter
    expect(G.isUnderground(w, 4.5, 4.5)).toBe(true);
    expect(F(G.ambientTemperature(w, 4.5, 4.5))).toBeCloseTo(60, 6);
    expect(F(G.ambientTemperature(w, 6.5, 4.5))).not.toBeCloseTo(60, 6);
  });

  it("renderTileHeight passes land through at the extremes", () => {
    expect(renderTileHeight(3, -100)).toBe(-100); expect(renderTileHeight(3, 100)).toBe(100);
    expect(terrainLevel(3, -100)).toBe(-100); expect(terrainLevel(3, 100)).toBe(100);
  });
});
