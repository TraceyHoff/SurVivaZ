/**
 * ADR-418: the Canvas2D fallback path (packages/render/src/canvasGroundHeight.ts) shared the
 * flat-cliff assumption of the WebGL2 mesh: a cliff-face polygon ran flat from the tile's height
 * to the neighbour's FLAT height. On the fallback that is the same two defects, in 2D paint:
 *  - the face bottom stopped short of a neighbour whose top edge is tilted (a corner dropped
 *    toward a third tile 2+ below), leaving a triangular gap under the face — whatever was painted
 *    beneath shows through instead of the cliff;
 *  - the face top ran flat at the tile's height while the top face edge is tilted, so a near face
 *    (drawn after the top) painted a cliff-coloured triangle over the tilted top.
 * The fix is the same `cliffEdgeSpan` the mesh uses (packages/world/src/slope.ts): the face
 * polygon follows both top faces, and `low` is the lowest bottom corner (so the gt-block path's
 * below-skirt fill and canvas pads cover the deepest drop). Flat cases are bit-identical.
 */
import { describe, expect, it } from "vitest";
import { TileMap, tileToLocal } from "@engine/world";
import { TileId } from "../src/ids.js";
import {
  c2dGroundGeometry, c2dGtFaceBelowSkirt, c2dNeighbourLow,
} from "../src/canvasGroundHeight.js";

const GRASS = TileId.Grass, WATER = TileId.Water;
/** Fill a 3x3 block centred on (0,0) with grass at height `h`, except `low` overrides (mirrors adr414). */
const fill3 = (map: TileMap, h: number, low: Record<string, number> = {}): void => {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    map.setTile(dx, dy, GRASS);
    map.getChunk(Math.floor(dx / 32), Math.floor(dy / 32))!.setHeight(tileToLocal(dx), tileToLocal(dy), low[`${dx},${dy}`] ?? h);
  }
};
const lowOf = (map: TileMap) => (dx: number, dy: number): number | undefined => c2dNeighbourLow(map, dx, dy);

describe("ADR-418 Canvas2D cliff faces follow both top faces", () => {
  it("terraced dirt: the +u face bottom reaches the neighbour's dropped corner, top follows the tile's own edge", () => {
    // T=(0,0) h=5, +u neighbour (1,0)=4, +v neighbour (0,1)=3 — the mesh repro case in 2D.
    // The neighbour's shared vertex (1,1) drops to 3, so the old flat face (top 5, bottom 4)
    // left a triangular gap under it; the old flat top also overpainted the tilted top.
    const map = new TileMap();
    fill3(map, 5, { "1,0": 4, "0,1": 3 });
    const g = c2dGroundGeometry(5, lowOf(map));
    const u = g.faces.find((f) => f.side === 0)!;
    // Top edge is T's edge [4,5] (R at 4, B at 5); bottom edge is the neighbour's edge [4,3].
    expect(u.poly).toEqual([[32, -64], [0, -64], [0, -32], [32, -64]]);
    expect(u.low).toBe(3); // the deepest bottom corner, not the neighbour's flat height 4
    // The +v face drops to the flat neighbour (0,1)=3 on both ends.
    const v = g.faces.find((f) => f.side === 2)!;
    expect(v.poly).toEqual([[-32, -80], [0, -64], [0, -32], [-32, -48]]);
    expect(v.low).toBe(3);
    expect(g.minLow).toBe(3);
  });

  it("the below-skirt fill follows the tilted face (gt-block path)", () => {
    const map = new TileMap();
    fill3(map, 5, { "1,0": 4, "0,1": 3 });
    const g = c2dGroundGeometry(5, lowOf(map));
    const u = g.faces.find((f) => f.side === 0)!;
    // The skirt covers the first level below the tilted top edge, so the fill starts 16 px below
    // the tilted top and runs to the tilted bottom — no gap under the skirt at the dropped end.
    expect(c2dGtFaceBelowSkirt(u.poly)).toEqual([[32, -48], [0, -48], [0, -32], [32, -64]]);
  });

  it("a 2-level step keeps its flat cliff (no slope involved: bit-identical behaviour)", () => {
    const map = new TileMap();
    fill3(map, 5, { "1,0": 3 });
    const g = c2dGroundGeometry(5, lowOf(map));
    expect(g.faces).toHaveLength(1);
    expect(g.faces[0]!.poly).toEqual([[32, -80], [0, -64], [0, -32], [32, -48]]);
    expect(g.faces[0]!.low).toBe(3);
  });

  it("a water neighbour stays flat (never classified as land)", () => {
    const map = new TileMap();
    fill3(map, 0);
    map.setTile(1, 0, WATER); // +u neighbour is water: low -0.25
    const g = c2dGroundGeometry(0, lowOf(map));
    expect(g.faces).toHaveLength(1);
    expect(g.faces[0]!.low).toBe(-0.25);
    expect(g.faces[0]!.poly).toEqual([[32, 0], [0, 16], [0, 20], [32, 4]]);
  });

  it("a ramp's slope side still draws no face", () => {
    const map = new TileMap();
    fill3(map, 1, { "1,0": 0 });
    const g = c2dGroundGeometry(1, lowOf(map));
    expect(g.faces).toEqual([]);
  });
});
