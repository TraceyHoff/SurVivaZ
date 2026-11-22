import { describe, expect, it } from "vitest";
import { CHUNK_SIZE, FLOOR_HEIGHT_LEVELS, floorToTerrainZ, type TileMap } from "@engine/world";
import { deckKeyFor, deckTileKey, pieceBoundaryGroundZ } from "../src/view.js";

/**
 * ADR-433: deck-aware grounding — the rules behind the wall/roof-gap fix, pinned directly.
 *
 * `pieceBoundaryGroundZ` takes an optional deck set (keys from `deckTileKey`, built by the render
 * loop from the deck pieces it already iterates). The rule, in order:
 *   1. a touching tile carrying a deck at level+1 (the deck the wall top must meet) wins — max
 *      height among those tiles;
 *   2. else a touching tile carrying a deck at the wall's own level (the deck it stands on) wins
 *      — max height among those tiles;
 *   3. else the ADR-412 min over all touching tiles (no decked tile: freestanding wall, or the
 *      caller passed no decks at all — the bare call is byte-identical to ADR-412).
 * The wall-top/roof pair cases live in the ADR-432 file; this file pins the rule itself: which
 * deck wins, the freestanding fallback, and the deck-key helper the render loop uses.
 */
const flat = (fill: number, patch: Record<string, number> = {}): TileMap => {
  const height = new Array(CHUNK_SIZE * CHUNK_SIZE).fill(fill);
  for (const [k, v] of Object.entries(patch)) { const [x, y] = k.split(",").map(Number); height[y! * CHUNK_SIZE + x!] = v; }
  return { getChunk: () => ({ height }) } as unknown as TileMap;
};
/** Deck set from [tx, ty, level] triples. */
const decks = (...keys: [number, number, number][]): Set<number> => new Set(keys.map(([x, y, l]) => deckTileKey(x, y, l)));

describe("ADR-433 deckTileKey / deckKeyFor", () => {
  it("keys are distinct per tile and level", () => {
    expect(deckTileKey(6, 8, 0)).not.toBe(deckTileKey(6, 8, 1));
    expect(deckTileKey(6, 8, 1)).not.toBe(deckTileKey(6, 9, 1));
    expect(deckTileKey(6, 8, 1)).not.toBe(deckTileKey(7, 8, 1));
    expect(deckTileKey(6, 8, 1)).toBe(deckTileKey(6, 8, 1));
    expect(deckTileKey(-3, -2, 0)).not.toBe(deckTileKey(3, 2, 0)); // negative coords (west/north of origin)
  });

  it("only deck families contribute, at the piece's story level from its centre tile", () => {
    expect(deckKeyFor("foundation", 6.5, 8.5, 0, 3)).toBe(deckTileKey(6, 8, 0));
    expect(deckKeyFor("floor", 6.5, 8.5, 3, 3)).toBe(deckTileKey(6, 8, 1));
    expect(deckKeyFor("roof", 6.5, 8.5, 3, 3)).toBe(deckTileKey(6, 8, 1));
    expect(deckKeyFor("roof", 6.5, 8.5, 6, 3)).toBe(deckTileKey(6, 8, 2)); // upper-story roof
    expect(deckKeyFor("wall", 6.5, 9, 0, 3)).toBeUndefined();
    expect(deckKeyFor("corner", 9, 9, 0, 3)).toBeUndefined();
    expect(deckKeyFor(undefined, 6.5, 8.5, 0, 3)).toBeUndefined();
    expect(deckKeyFor("furniture", 6.5, 8.5, 0, 3)).toBeUndefined();
  });
});

describe("ADR-433 the deck above the wall wins (upper beats own)", () => {
  it("balcony: the inside tile has a roof above it, the outside tile only a floor at the wall's level", () => {
    // Level-1 south wall of a 2-story house, anchor (6.5, 9), z = 3. Inside tile (6,8) is level 3
    // with a floor at level 1 AND a roof at level 2 above it; the outside tile (6,9) is level 4
    // with only a balcony floor at level 1. The wall must ground on the inside (3), not the
    // higher balcony ground (4) — the roof above is what the top has to meet.
    const tiles = flat(3, { "6,9": 4 });
    const d = decks([6, 8, 1], [6, 8, 2], [6, 9, 1]);
    expect(pieceBoundaryGroundZ(tiles, 6.5, 9, 3, 3, d)).toBe(3);
    // And the top meets the level-2 roof over the inside tile: base 3 + story 3 + wall 3 = 9.
    expect(floorToTerrainZ(1, pieceBoundaryGroundZ(tiles, 6.5, 9, 3, 3, d)) + FLOOR_HEIGHT_LEVELS).toBe(3 + 2 * FLOOR_HEIGHT_LEVELS);
    expect(floorToTerrainZ(2, 3)).toBe(3 + 2 * FLOOR_HEIGHT_LEVELS);
  });

  it("a deck at level+1 on the outside tile wins too — that is a party wall, and the trade is documented", () => {
    // Both sides roofed at level 1, outside higher (4 vs 2): the rule takes the max of the decked
    // tiles, so the top meets the higher roof. The lower side's mismatch is unavoidable — no
    // single wall top can meet both roofs — and is the same arithmetic as the ADR-432 step vertex.
    const tiles = flat(2, { "6,9": 4 });
    const d = decks([6, 8, 1], [6, 9, 1]);
    expect(pieceBoundaryGroundZ(tiles, 6.5, 9, 0, 3, d)).toBe(4);
  });
});

describe("ADR-433 no deck above yet: the deck the wall stands on wins", () => {
  it("walls placed before their roof ground on the inside foundation", () => {
    // South wall, foundation inside (6,8)=3 at level 0, no roof yet, outside dropped to 2.
    const tiles = flat(3, { "6,9": 2 });
    const d = decks([6, 8, 0]);
    expect(pieceBoundaryGroundZ(tiles, 6.5, 9, 0, 3, d)).toBe(3);
    expect(pieceBoundaryGroundZ(tiles, 6.5, 9, 0, 3, d) + FLOOR_HEIGHT_LEVELS).toBe(3 + FLOOR_HEIGHT_LEVELS);
  });

  it("an upper-story wall stands on its floor and meets the roof above it", () => {
    // Level-1 wall (z = 3) over a level-2 footprint, outside raised to 5: floor at level 1 and
    // roof at level 2 over the inside tile (6,8); the raised outside neighbour must not lift it.
    const tiles = flat(2, { "6,9": 5 });
    const d = decks([6, 8, 1], [6, 8, 2]);
    expect(pieceBoundaryGroundZ(tiles, 6.5, 9, 3, 3, d)).toBe(2);
    expect(floorToTerrainZ(1, pieceBoundaryGroundZ(tiles, 6.5, 9, 3, 3, d)) + FLOOR_HEIGHT_LEVELS).toBe(2 + 2 * FLOOR_HEIGHT_LEVELS);
    expect(floorToTerrainZ(2, 2)).toBe(2 + 2 * FLOOR_HEIGHT_LEVELS);
  });
});

describe("ADR-433 no decked tile: the ADR-412 min is the fallback", () => {
  it("a freestanding wall with decks elsewhere in the world still sinks to the min", () => {
    // Same heights as the screenshot case, but the deck set holds only far-away tiles: no deck
    // touches this anchor, so the wall is freestanding and the min rule applies (base 2).
    const tiles = flat(3, { "6,9": 2 });
    const d = decks([20, 20, 0], [20, 20, 1]);
    expect(pieceBoundaryGroundZ(tiles, 6.5, 9, 0, 3, d)).toBe(2);
    expect(pieceBoundaryGroundZ(tiles, 6.5, 9, 0, 3, new Set())).toBe(2); // empty set: same
  });

  it("a freestanding wall against raised ground still cannot be lifted", () => {
    const tiles = flat(2, { "6,9": 5 });
    const d = decks([20, 20, 0]);
    expect(pieceBoundaryGroundZ(tiles, 6.5, 9, 0, 3, d)).toBe(2);
    expect(pieceBoundaryGroundZ(tiles, 9, 9, 0, 3, d)).toBe(2);
  });

  it("an inside tile lower than outside still grounds the wall on inside ground (retaining wall)", () => {
    // Inside (6,8)=2 decked at level 1, outside (6,9)=4 bare: the wall stands on inside ground
    // (2) and the higher outside ground buries its lower portion — it must not be lifted to 4.
    const tiles = flat(2, { "6,9": 4 });
    const d = decks([6, 8, 1]);
    expect(pieceBoundaryGroundZ(tiles, 6.5, 9, 0, 3, d)).toBe(2);
  });
});
