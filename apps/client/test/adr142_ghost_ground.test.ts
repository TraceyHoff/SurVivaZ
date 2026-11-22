import { describe, it, expect } from "vitest";
import { CHUNK_SIZE, FLOOR_HEIGHT_LEVELS as L, floorToTerrainZ, type TileMap } from "@engine/world";
import { groundZ, pieceGroundZ } from "../src/view.js";

describe("ADR-142 build ghost is lifted onto the terrain step like placed pieces", () => {
  const height = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(1);
  const tiles = { getChunk: () => ({ height }) } as unknown as TileMap;
  it("raised ground lifts a z=0 preview to the tile height (was buried under terrain)", () => { expect(groundZ(tiles, 3.5, 2.5, 0)).toBe(1); });
  it("upper floors stay above ground; no tiles → sim z", () => { expect(groundZ(tiles, 3.5, 2.5, 4)).toBe(4); expect(groundZ(undefined, 1, 1, 0)).toBe(0); });
});

describe("ADR-303 upper-floor draw height", () => {
  const height = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(1);
  const tiles = { getChunk: () => ({ height }) } as unknown as TileMap;
  it("strips story height so floorToTerrainZ restores exactly one story (not two)", () => {
    // ADR-511: one story = FLOOR_HEIGHT_LEVELS (5) terrain levels
    expect(pieceGroundZ(undefined, 1, 1, L, L)).toBe(0);
    expect(floorToTerrainZ(1, pieceGroundZ(undefined, 1, 1, L, L))).toBe(L);
    expect(pieceGroundZ(undefined, 1, 1, 0, L)).toBe(0);
    expect(floorToTerrainZ(0, pieceGroundZ(undefined, 1, 1, 0, L))).toBe(0);
    expect(pieceGroundZ(undefined, 1, 1, L + 0.3125, L)).toBeCloseTo(0.3125);
    expect(floorToTerrainZ(1, pieceGroundZ(undefined, 1, 1, L + 0.3125, L))).toBeCloseTo(L + 0.3125);
    expect(pieceGroundZ(tiles, 3.5, 2.5, L, L)).toBe(1);
    expect(floorToTerrainZ(1, pieceGroundZ(tiles, 3.5, 2.5, L, L))).toBe(L + 1);
  });
});
