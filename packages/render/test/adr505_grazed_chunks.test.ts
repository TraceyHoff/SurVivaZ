/**
 * ADR-505: a graze invalidates only the chunk holding the tile. The ADR-256 global revision rebuilt every
 * visible TileTerrain chunk (plus both prewarmed rotation quarters) and re-baked every Canvas2D gt block on
 * each GrazedTile add/remove — a rebuild burst every second or two with grazing animals in view.
 */
import { describe, expect, it } from "vitest";
import { TileMap, CHUNK_SIZE } from "@engine/world";
import { GrazedTiles, grazedTileKey } from "../src/grazedTiles.js";
import { TileTerrain } from "../src/terrainTiles.js";

const stampOf = (t: TileTerrain, map: TileMap, cx: number, cy: number): number => (t as unknown as { stamp(m: TileMap, c: unknown): number }).stamp(map, map.getChunk(cx, cy));

describe("ADR-505 GrazedTiles", () => {
  it("diffs sets and bumps only the chunks whose grazed tiles changed (negative coords too)", () => {
    const g = new GrazedTiles();
    g.begin(); g.add(3, 4); g.add(-1, -1); expect(g.commit()).toBe(true);
    expect(g.at(3, 4)).toBe(true); expect(g.at(-1, -1)).toBe(true); expect(g.at(4, 3)).toBe(false); expect(g.size).toBe(2);
    const a0 = g.chunkRev(0, 0), n0 = g.chunkRev(-1, -1), far = g.chunkRev(5, 5);
    expect(a0).toBeGreaterThan(0); expect(n0).toBeGreaterThan(0); expect(far).toBe(0);
    // same set again: nothing changes
    g.begin(); g.add(-1, -1); g.add(3, 4); expect(g.commit()).toBe(false);
    expect(g.chunkRev(0, 0)).toBe(a0); expect(g.chunkRev(-1, -1)).toBe(n0);
    // one tile regrows in chunk (0,0), one new graze in chunk (1,0): chunk (-1,-1) untouched
    g.begin(); g.add(-1, -1); g.add(CHUNK_SIZE + 2, 0); expect(g.commit()).toBe(true);
    expect(g.chunkRev(0, 0)).not.toBe(a0); expect(g.chunkRev(1, 0)).toBeGreaterThan(0); expect(g.chunkRev(-1, -1)).toBe(n0);
    expect(g.at(3, 4)).toBe(false);
  });
  it("keys are unique across the signed tile range", () => {
    const seen = new Set<number>();
    for (const x of [-70000, -33, -1, 0, 1, 31, 32, 70000]) for (const y of [-70000, -33, -1, 0, 1, 31, 32, 70000]) seen.add(grazedTileKey(x, y));
    expect(seen.size).toBe(64);
  });
  it("TileTerrain: a graze changes the stamp of its own chunk only (was: every chunk)", () => {
    const map = new TileMap();
    for (let cy = 0; cy < 3; cy++) for (let cx = 0; cx < 3; cx++) map.setTile(cx * CHUNK_SIZE + 1, cy * CHUNK_SIZE + 1, 4);
    const t = Object.assign(Object.create(TileTerrain.prototype), { grazedRev: 0 }) as TileTerrain;
    const g = new GrazedTiles(); t.grazedTiles = g;
    const before = [0, 1, 2].flatMap((cy) => [0, 1, 2].map((cx) => stampOf(t, map, cx, cy)));
    g.begin(); g.add(CHUNK_SIZE + 5, CHUNK_SIZE + 7); g.commit(); // a tile in chunk (1,1)
    const after = [0, 1, 2].flatMap((cy) => [0, 1, 2].map((cx) => stampOf(t, map, cx, cy)));
    const changed = after.map((s, i) => s !== before[i]);
    expect(changed).toEqual([false, false, false, false, true, false, false, false, false]);
  });
});
