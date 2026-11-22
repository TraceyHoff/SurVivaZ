import { describe, expect, it } from "vitest";
import { CHUNK_SIZE, FLOOR_HEIGHT_LEVELS as L, floorToTerrainZ, type TileMap } from "@engine/world";
import { groundZ, pieceBoundaryGroundZ, pieceGroundZ } from "../src/view.js";

/**
 * ADR-412: abandoned-structure corners/walls floated above their own ground when the ruin was
 * bumped up against raised ground. The pieces anchor exactly on the footprint boundary lines, so
 * groundZ's single-tile floor() read the neighbour tile outside the structure. pieceBoundaryGroundZ
 * grounds a boundary-anchored piece on the lowest tile touching its anchor — the structure's own
 * tile is always one of them, so a raised neighbour can no longer lift it.
 *
 * Scenario (one chunk): a flat 5x5 footprint at origin (4,4), ground level 2, with the south row
 * (y=9), east column (x=9) and SE diagonal (9,9) raised to level 5.
 */
function makeTiles(): TileMap {
  const height = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(2);
  const at = (x: number, y: number) => y * CHUNK_SIZE + x;
  for (let x = 4; x <= 9; x++) height[at(x, 9)] = 5; // south neighbours
  for (let y = 4; y <= 9; y++) height[at(9, y)] = 5; // east neighbours
  return { getChunk: () => ({ height }) } as unknown as TileMap;
}

describe("ADR-412 ruin corners and walls sit on their own ground tile", () => {
  const tiles = makeTiles();

  it("the reported case, as a repro: the single-tile read lifts boundary pieces onto the raised neighbour", () => {
    // South wall (6.5, 9), east wall (9, 6.5) and the NE / SE / SW corners all floor onto raised tiles.
    expect(pieceGroundZ(tiles, 6.5, 9, 0, 3)).toBe(5);
    expect(pieceGroundZ(tiles, 9, 6.5, 0, 3)).toBe(5);
    expect(pieceGroundZ(tiles, 9, 4, 0, 3)).toBe(5);
    expect(pieceGroundZ(tiles, 9, 9, 0, 3)).toBe(5);
    expect(pieceGroundZ(tiles, 4, 9, 0, 3)).toBe(5);
    expect(groundZ(tiles, 6.5, 9, 0)).toBe(5);
  });

  it("every corner sits on the structure's own ground (level 2), not the raised neighbour", () => {
    expect(pieceBoundaryGroundZ(tiles, 4, 4, 0, 3)).toBe(2); // NW: was already 2
    expect(pieceBoundaryGroundZ(tiles, 9, 4, 0, 3)).toBe(2); // NE: was 5
    expect(pieceBoundaryGroundZ(tiles, 9, 9, 0, 3)).toBe(2); // SE: was 5
    expect(pieceBoundaryGroundZ(tiles, 4, 9, 0, 3)).toBe(2); // SW: was 5
  });

  it("south and east walls sit on the structure's ground; north/west walls are unchanged", () => {
    expect(pieceBoundaryGroundZ(tiles, 6.5, 9, 0, 3)).toBe(2); // south wall: was 5
    expect(pieceBoundaryGroundZ(tiles, 9, 6.5, 0, 3)).toBe(2); // east wall: was 5
    expect(pieceBoundaryGroundZ(tiles, 6.5, 4, 0, 3)).toBe(2); // north wall
    expect(pieceBoundaryGroundZ(tiles, 4, 6.5, 0, 3)).toBe(2); // west wall
  });

  it("upper-story boundary pieces keep their story on top of the structure's ground", () => {
    expect(pieceBoundaryGroundZ(tiles, 6.5, 9, L, L)).toBe(2);
    expect(floorToTerrainZ(1, pieceBoundaryGroundZ(tiles, 6.5, 9, L, L))).toBe(L + 2);
    expect(pieceBoundaryGroundZ(tiles, 9, 9, 2 * L, L)).toBe(2);
    expect(floorToTerrainZ(2, pieceBoundaryGroundZ(tiles, 9, 9, 2 * L, L))).toBe(2 * L + 2);
  });

  it("off-boundary anchors are identical to pieceGroundZ (foundations, furniture, interior pieces)", () => {
    for (const [x, y] of [[6.5, 6.5], [4.5, 4.5], [8.5, 8.5], [6.5, 9.5], [9.5, 6.5]] as const) {
      expect(pieceBoundaryGroundZ(tiles, x, y, 0, 3)).toBe(pieceGroundZ(tiles, x, y, 0, 3));
    }
    expect(pieceBoundaryGroundZ(tiles, 6.5, 6.5, 0, 3)).toBe(2);
    expect(pieceBoundaryGroundZ(undefined, 6.5, 9, 0, 3)).toBe(0);
    expect(pieceBoundaryGroundZ(undefined, 6.5, 9, L + 0.3125, L)).toBeCloseTo(0.3125);
  });

  it("a boundary anchor straddling a chunk edge reads both chunks (lowest wins)", () => {
    const low = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(2);
    const high = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(5);
    const chunked = {
      getChunk: (cx: number) => ({ height: cx === 0 ? low : high }),
    } as unknown as TileMap;
    // East wall anchor at x=32: west tile (31, 6) is level 2, east tile (32, 6) is level 5.
    expect(pieceBoundaryGroundZ(chunked, 32, 6.5, 0, 3)).toBe(2);
    expect(pieceGroundZ(chunked, 32, 6.5, 0, 3)).toBe(5);
  });

  it("a lower neighbour only sinks the base behind the higher ground — never a floating gap", () => {
    // Same footprint, but the north neighbour drops to level 0: the north wall's base reads as a
    // foundation down the slope (0), which is hidden behind the footprint's own ground (2).
    const height = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(2);
    for (let x = 4; x <= 8; x++) height[3 * CHUNK_SIZE + x] = 0;
    const sunk = { getChunk: () => ({ height }) } as unknown as TileMap;
    expect(pieceBoundaryGroundZ(sunk, 6.5, 4, 0, 3)).toBe(0);
    // …while a raised neighbour on that same edge still cannot lift it.
    expect(pieceBoundaryGroundZ(tiles, 6.5, 4, 0, 3)).toBe(2);
  });
});
