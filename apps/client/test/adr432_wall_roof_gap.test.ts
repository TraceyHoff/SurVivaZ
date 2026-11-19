import { describe, expect, it } from "vitest";
import { CHUNK_SIZE, FLOOR_HEIGHT_LEVELS, floorToTerrainZ, type TileMap } from "@engine/world";
import { deckTileKey, groundZ, pieceBoundaryGroundZ, pieceGroundZ } from "../src/view.js";

/**
 * ADR-432: on a flat footprint whose outside neighbour drops one level, the perimeter wall sinks
 * one level while the roof above it does not — a see-through gap between the wall top and the roof.
 *
 * Root cause (established, not re-litigated here): `pieceBoundaryGroundZ` (view.ts) grounds a
 * boundary-anchored piece (edge wall, corner vertex) on the MINIMUM height of all tiles touching
 * its anchor — including the tile OUTSIDE the building — while a cell-anchored piece (roof / floor
 * deck tile) uses `pieceGroundZ`, a single-tile read of its own tile. So the wall base drops to
 * the outside neighbour's level and the wall top ends 1 level (16 px) below the roof seat, which
 * sits on the footprint's own level. ADR-412's comment (view.ts:149-156) claims "a lower neighbour
 * only sinks the base … never a floating gap" — true at the bottom, false at the top: the base
 * sinking IS the gap, because the roof does not sink with it. The placement ghost uses the same
 * lift (view.ts:543-546), so it shows the gap faithfully.
 *
 * Constants: levelHeight = 3 (tiers.json); 1 terrain level = 16 px; 1 floor = 3 levels = 48 px;
 * walls are 48 px tall, so a wall top is its base + FLOOR_HEIGHT_LEVELS. Roof / floor sim z = 3
 * (level 1). Every assertion below is the wall-top/roof pair, not just a grounding value.
 *
 * Scenario (one chunk, same harness as the ADR-412 test): a flat 5x5 footprint at origin (4,4),
 * ground level 3, with the south row (y=9) and east column (x=9) dropped to level 2.
 *
 * ADR-433 (fix): the wall-top pins below now pass the footprint's deck set — foundations (level 0)
 * + roof (level 1) over every footprint cell — to `pieceBoundaryGroundZ`, which grounds a boundary
 * piece on its inside (decked) tile when one is known. The bare calls without decks are kept
 * alongside: they pin that the no-deck fallback is still ADR-412's min, so a freestanding wall
 * with no deck above still sinks, and only a roofed wall stands on its inside ground. The step-line
 * vertex pin was deliberately updated (see below): with two decked inside tiles at different heights
 * the rule takes the max, so it meets the higher roof.
 */
function makeTiles(): TileMap {
  const height = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(3);
  const at = (x: number, y: number) => y * CHUNK_SIZE + x;
  for (let x = 4; x <= 8; x++) height[at(x, 9)] = 2; // south neighbours
  for (let y = 4; y <= 8; y++) height[at(9, y)] = 2; // east neighbours
  height[at(9, 9)] = 2; // SE diagonal
  return { getChunk: () => ({ height }) } as unknown as TileMap;
}

/** Deck tiles for a footprint: foundations (level 0) + roof (level 1) over every cell (x0..x1, y0..y1). */
const footprintDecks = (x0: number, y0: number, x1: number, y1: number): Set<number> => {
  const s = new Set<number>();
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { s.add(deckTileKey(x, y, 0)); s.add(deckTileKey(x, y, 1)); }
  return s;
};

/** Draw z of the top of a ground-floor wall anchored at (x, y): base + one wall height. */
const wallTopZ = (tiles: TileMap, x: number, y: number, decks?: ReadonlySet<number>): number =>
  floorToTerrainZ(0, pieceBoundaryGroundZ(tiles, x, y, 0, FLOOR_HEIGHT_LEVELS, decks)) + FLOOR_HEIGHT_LEVELS;
/** Draw z of the level-1 roof / floor deck over the cell centred at (x, y) (sim z = 3). */
const roofDrawZ = (tiles: TileMap, x: number, y: number): number =>
  floorToTerrainZ(1, pieceBoundaryGroundZ(tiles, x, y, FLOOR_HEIGHT_LEVELS, FLOOR_HEIGHT_LEVELS));

describe("ADR-432 wall top meets the roof on a flat footprint next to a one-level drop", () => {
  const tiles = makeTiles();
  const decks = footprintDecks(4, 4, 8, 8);

  it("the screenshot case: south wall top meets the roof above the south row", () => {
    // Bare (no deck info) the min read is still 2 — ADR-412's fallback, unchanged. With the roof
    // deck known, the wall grounds on its inside tile (6,8) = 3, not the dropped neighbour (6,9) = 2.
    expect(pieceBoundaryGroundZ(tiles, 6.5, 9, 0, 3)).toBe(2);
    expect(pieceBoundaryGroundZ(tiles, 6.5, 9, 0, 3, decks)).toBe(3);
    expect(pieceGroundZ(tiles, 6.5, 8.5, 0, 3)).toBe(3);
    // The pair: wall top 6 == roof seat 6 — no gap. (Was 5 vs 6 before ADR-433.)
    expect(wallTopZ(tiles, 6.5, 9, decks)).toBe(roofDrawZ(tiles, 6.5, 8.5));
  });

  it("same gap on the east wall", () => {
    expect(pieceBoundaryGroundZ(tiles, 9, 6.5, 0, 3)).toBe(2);
    expect(pieceBoundaryGroundZ(tiles, 9, 6.5, 0, 3, decks)).toBe(3);
    expect(pieceGroundZ(tiles, 8.5, 6.5, 0, 3)).toBe(3);
    // Wall top 6 vs roof seat 6. (Was 5 vs 6 before ADR-433.)
    expect(wallTopZ(tiles, 9, 6.5, decks)).toBe(roofDrawZ(tiles, 8.5, 6.5));
  });

  it("control: north wall, whose outside neighbour is level with the footprint, has no gap", () => {
    expect(pieceBoundaryGroundZ(tiles, 6.5, 4, 0, 3, decks)).toBe(3);
    expect(wallTopZ(tiles, 6.5, 4, decks)).toBe(roofDrawZ(tiles, 6.5, 4.5));
    expect(wallTopZ(tiles, 6.5, 4, decks)).toBe(6);
  });

  it("the SE corner vertex (9,9) touches 4 tiles, min 2 — its wall top meets the roof too", () => {
    expect(pieceBoundaryGroundZ(tiles, 9, 9, 0, 3)).toBe(2);
    // Only one touching tile is decked — the diagonal inside tile (8,8) = 3 — so the vertex
    // grounds on it. (Was wall top 5 vs roof 6 before ADR-433.)
    expect(pieceBoundaryGroundZ(tiles, 9, 9, 0, 3, decks)).toBe(3);
    expect(wallTopZ(tiles, 9, 9, decks)).toBe(roofDrawZ(tiles, 8.5, 8.5));
  });
});

describe("ADR-432 straddle variant: a footprint split across the step (pins current behaviour)", () => {
  /**
   * 3x3 footprint at origin (4,4): the west column (x=4) is level 2, the east columns (x=5,6)
   * are level 3, and the outside matches its column (x=3 and the south/north neighbours under
   * the west column are 2, the rest 3). No gap is asserted here — the roof steps 16 px
   * mid-footprint and the wall tops follow their own side. These pass today and must keep
   * passing: the fix is about the outside neighbour, not about re-levelling a split footprint.
   */
  const straddle = (): TileMap => {
    const height = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(3);
    const at = (x: number, y: number) => y * CHUNK_SIZE + x;
    for (let y = 4; y <= 6; y++) height[at(4, y)] = 2; // west column
    for (let y = 4; y <= 6; y++) height[at(3, y)] = 2; // west outside
    height[at(4, 7)] = 2; // south outside under the west column
    height[at(4, 3)] = 2; // north outside under the west column
    return { getChunk: () => ({ height }) } as unknown as TileMap;
  };
  const tiles = straddle();
  const decks = footprintDecks(4, 4, 6, 6);

  it("wall tops meet the roof on both sides of the step", () => {
    expect(wallTopZ(tiles, 4.5, 7, decks)).toBe(roofDrawZ(tiles, 4.5, 6.5)); // west: 5 == 5
    expect(wallTopZ(tiles, 5.5, 7, decks)).toBe(roofDrawZ(tiles, 5.5, 6.5)); // east: 6 == 6
    expect(roofDrawZ(tiles, 5.5, 6.5) - roofDrawZ(tiles, 4.5, 6.5)).toBe(1); // roof steps 16 px mid-footprint
  });

  it("the vertex on the step line is the one place a single grounding cannot meet both roofs", () => {
    // ADR-433 DELIBERATE UPDATE (was: wall top 5, meeting the west roof): the vertex (5,7) touches
    // two decked inside tiles at different heights, (4,6)=2 and (5,6)=3, and the deck rule takes the
    // max of the decked tiles, so its top is now 6 — it meets the east roof (6) and sits 1 level
    // above the west roof (5). No single wall top can meet both roof heights here; max was chosen
    // over min because the gap it would leave under the higher roof is the see-through defect being
    // fixed, while the lower side reads as the corner post continuing past the lower roof step.
    // In a real building this anchor is not a piece at all: corners sit only at the footprint's
    // four corners, where a single diagonal tile is decked, and mid-edge vertices have no piece —
    // this pin is arithmetic for the rule, not a rendered case. The bare (no-deck) read is
    // unchanged: min 2, top 5, meeting the west roof instead.
    expect(wallTopZ(tiles, 5, 7, decks)).toBe(6);
    expect(roofDrawZ(tiles, 4.5, 6.5)).toBe(5);
    expect(roofDrawZ(tiles, 5.5, 6.5)).toBe(6);
    expect(wallTopZ(tiles, 5, 4, decks)).toBe(6); // same on the north step-line vertex
    expect(wallTopZ(tiles, 5, 7)).toBe(5);
  });
});

describe("ADR-432 must not trade the defect for ADR-412's: raised neighbours still cannot lift a wall", () => {
  /**
   * Replicates the ADR-412 test's key assertions (same harness: 5x5 footprint at origin (4,4),
   * level 2, south row y=9 and east column x=9 RAISED to level 5). A fix that grounds walls on
   * the max touching tile, or on the neighbour, would pass ADR-432 and re-open ADR-412.
   */
  const raised = (): TileMap => {
    const height = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(2);
    const at = (x: number, y: number) => y * CHUNK_SIZE + x;
    for (let x = 4; x <= 9; x++) height[at(x, 9)] = 5; // south neighbours
    for (let y = 4; y <= 9; y++) height[at(9, y)] = 5; // east neighbours
    return { getChunk: () => ({ height }) } as unknown as TileMap;
  };
  const tiles = raised();
  const decks = footprintDecks(4, 4, 8, 8);

  it("a raised outside neighbour does not lift the wall base", () => {
    // With decks known the wall grounds on its decked inside tile (2), not the raised neighbour
    // (5) — ADR-412's property, now via the inside tile rather than the min. The bare calls pin
    // the same values through the min fallback (see the sunk test below).
    expect(pieceBoundaryGroundZ(tiles, 6.5, 9, 0, 3, decks)).toBe(2); // south wall: was 5 pre-ADR-412
    expect(pieceBoundaryGroundZ(tiles, 9, 6.5, 0, 3, decks)).toBe(2); // east wall: was 5
    expect(pieceBoundaryGroundZ(tiles, 9, 9, 0, 3, decks)).toBe(2); // SE corner: was 5
    expect(pieceBoundaryGroundZ(tiles, 9, 4, 0, 3, decks)).toBe(2); // NE corner: was 5
    expect(pieceBoundaryGroundZ(tiles, 4, 9, 0, 3, decks)).toBe(2); // SW corner: was 5
    expect(pieceBoundaryGroundZ(tiles, 6.5, 9, 0, 3)).toBe(2);
    expect(pieceBoundaryGroundZ(tiles, 9, 9, 0, 3)).toBe(2);
  });

  it("a lower neighbour only sinks the base behind the higher ground", () => {
    const height = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(2);
    for (let x = 4; x <= 8; x++) height[3 * CHUNK_SIZE + x] = 0;
    const sunk = { getChunk: () => ({ height }) } as unknown as TileMap;
    expect(pieceBoundaryGroundZ(sunk, 6.5, 4, 0, 3)).toBe(0);
    // ADR-433: the same wall WITH a roof deck above it does not sink — the distinction is the
    // deck, not the heights. Bare (freestanding, no roof) it sinks to 0; decked (roofed) it
    // stands on its inside tile (2) and its top meets the roof (5 == 5). This is the pin that
    // separates the two properties: min is the no-deck fallback, not the roofed rule.
    expect(pieceBoundaryGroundZ(sunk, 6.5, 4, 0, 3, decks)).toBe(2);
    expect(wallTopZ(sunk, 6.5, 4, decks)).toBe(roofDrawZ(sunk, 6.5, 4.5));
    expect(wallTopZ(sunk, 6.5, 4, decks)).toBe(5);
  });

  it("and in the raised-neighbour geometry the wall top already meets the roof — the fix must keep it so", () => {
    // Base 2, top 5; roof over the footprint's own level 2 sits at floorToTerrainZ(1, 2) = 5.
    expect(wallTopZ(tiles, 6.5, 9, decks)).toBe(roofDrawZ(tiles, 6.5, 8.5));
    expect(wallTopZ(tiles, 9, 6.5, decks)).toBe(roofDrawZ(tiles, 8.5, 6.5));
    expect(wallTopZ(tiles, 9, 9, decks)).toBe(roofDrawZ(tiles, 8.5, 8.5));
    expect(groundZ(tiles, 6.5, 9, 0)).toBe(5); // the old single-tile read still lifts — the pin is on the boundary read, not it
  });
});
