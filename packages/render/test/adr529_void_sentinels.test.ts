// ADR-529: void sentinels moved below any real ground (NO_TILE_HEIGHT -99 -> -9999, SLOPE_VOID -90 -> -9000)
// and the absolute terrain bounds narrowed to ±100 (shovel range 300 -> 100). Every render path that reads
// "void" must treat ground at -100 — and at -250, the follow-up raise, via direct calls — as real ground,
// while unloaded / empty tiles still read as void. Each path is exercised through the exact helper that
// path uses: tileHeight + cliffFlagFor (WebGL2 mesh), groundSideLevels + terrainDropEdges (textured
// instances), c2dGroundGeometry (Canvas2D), tileSurfaceHeight + classifyWaterfallFaces (waterfalls).
// The GL mesh / instance builders themselves need a GL context, which the VM has none of; their height
// decisions all funnel through these helpers, so a sentinel missed anywhere here is a missed sentinel.
import { describe, expect, it } from "vitest";
import {
  TileMap, Chunk, encodeChunk, decodeChunk, DEFAULT_ISO, SLOPE_VOID, classifyGroundShape,
  flowWaterRaw, terrainLevel, renderTileHeight, isFlowWater,
  FLOW_WATER_LEVEL_MIN, FLOW_WATER_LEVEL_MAX, FLOW_WATER_OFFSET_V2, FLOW_WATER_MIN_RAW_V2,
} from "@engine/world";
import { tileHeight, NO_TILE_HEIGHT, cliffFlagFor, CLIFF_PX } from "../src/tilemap.js";
import { groundSideLevels, GROUND_SIDE_MAX_LEVELS } from "../src/groundArt.js";
import { terrainDropEdges } from "../src/dropEdges.js";
import { c2dGroundGeometry, c2dTileHeight } from "../src/canvasGroundHeight.js";
import { tileSurfaceHeight, classifyWaterfallFaces } from "../src/waterfallTiles.js";

/** One-chunk TileMap with land at the given (x, height) pairs (tile 3) and water at (x, raw) pairs (tile 1). */
function mapWith(land: [number, number][], water: [number, number][] = []): TileMap {
  const m = new TileMap();
  for (const [x, h] of land) { m.setTile(x, 1, 3); m.ensureChunk(0, 0).setHeight(x, 1, h); }
  for (const [x, raw] of water) { m.setTile(x, 2, 1); m.ensureChunk(0, 0).setHeight(x, 2, raw); }
  return m;
}

describe("ADR-529 void sentinels", () => {
  it("the sentinels sit below any real ground: NO_TILE_HEIGHT -9999, SLOPE_VOID -9000", () => {
    expect(NO_TILE_HEIGHT).toBe(-9999);
    expect(SLOPE_VOID).toBe(-9000);
  });

  it("tileHeight (WebGL2 mesh lookup): ground at -100 and -250 is real; unloaded / empty tiles are void", () => {
    const m = mapWith([[1, -100], [2, -250], [3, 0]], [[1, flowWaterRaw(-100)]]);
    expect(tileHeight(m, 1, 1)).toBe(-100);
    expect(tileHeight(m, 2, 1)).toBe(-250);
    expect(tileHeight(m, 3, 1)).toBe(0);
    expect(tileHeight(m, 1, 2)).toBe(-100); // flowed water at the floor keeps its level
    // the discriminator: real deep ground must be distinguishable from void (greater than the sentinel)
    expect(tileHeight(m, 1, 1)).toBeGreaterThan(NO_TILE_HEIGHT);
    expect(tileHeight(m, 2, 1)).toBeGreaterThan(NO_TILE_HEIGHT);
    expect(tileHeight(m, 99, 99)).toBe(NO_TILE_HEIGHT); // unloaded chunk
    expect(tileHeight(m, 5, 5)).toBe(NO_TILE_HEIGHT); // empty tile in a loaded chunk
  });

  it("mesh cliff / waterfall gate: a -100 neighbour is a real 100-level drop, a void neighbour is not", () => {
    expect(cliffFlagFor(true, CLIFF_PX, 0, -100)).toBe(CLIFF_PX + 4); // waterfall face, not a plain cliff
    expect(cliffFlagFor(true, CLIFF_PX, 0, NO_TILE_HEIGHT)).toBe(CLIFF_PX); // missing neighbour never shimmers
    expect(cliffFlagFor(false, CLIFF_PX, 0, -100)).toBe(CLIFF_PX); // land cliffs never get a waterfall flag
    // the slope classifier the mesh feeds: -100 is a cliff neighbour (stepped), never void
    const stepped = classifyGroundShape({ h: 0, edge: [-100, 0, 0, 0], diag: [0, 0, 0, 0] });
    expect(stepped.edgeDrops[0]).toBe(100); expect(stepped.kind).toBe("stepped"); expect(stepped.sloped).toBe(false);
    // a 1-level step down to -100 is a ramp, with its slope side — the tilted top meets the low neighbour
    const ramp = classifyGroundShape({ h: -99, edge: [-100, -99, -99, -99], diag: [-99, -99, -99, -99] });
    expect(ramp.kind).toBe("ramp"); expect(ramp.slopeSides).toEqual([0]); expect(ramp.sloped).toBe(true);
  });

  it("slope classifier: ground at -250 is real (a ramp down to -251); void neighbours are ignored", () => {
    const ramp = classifyGroundShape({ h: -250, edge: [-251, -250, -250, -250], diag: [-250, -250, -250, -250] });
    expect(ramp.kind).toBe("ramp"); expect(ramp.slopeSides).toEqual([0]); expect(ramp.sloped).toBe(true);
    const alone = classifyGroundShape({ h: -250, edge: [SLOPE_VOID, SLOPE_VOID, SLOPE_VOID, SLOPE_VOID], diag: [SLOPE_VOID, SLOPE_VOID, SLOPE_VOID, SLOPE_VOID] });
    expect(alone.edgeDrops).toEqual([0, 0, 0, 0]); expect(alone.kind).toBe("flat"); expect(alone.sloped).toBe(false);
  });

  it("textured instances: -100 / -250 neighbours draw side faces and drop relief; void draws none", () => {
    const sides = groundSideLevels(0, -100, -100);
    expect(sides).toHaveLength(GROUND_SIDE_MAX_LEVELS);
    expect(sides.every((s) => s.mask === 3)).toBe(true); // both faces, every level up to the cap
    expect(groundSideLevels(-100, -250, -250)).toHaveLength(GROUND_SIDE_MAX_LEVELS);
    expect(groundSideLevels(0, SLOPE_VOID, -100)).toEqual(
      Array.from({ length: GROUND_SIDE_MAX_LEVELS }, (_, i) => ({ level: i, mask: 2 })),
    );
    expect(groundSideLevels(0, SLOPE_VOID, SLOPE_VOID)).toEqual([]);
    expect(terrainDropEdges(0, -100, -250, NO_TILE_HEIGHT, 0)).toEqual([8, 8, 0, 0]);
    expect(terrainDropEdges(-100, -101, -100, -100, -100)).toEqual([1, 0, 0, 0]);
  });

  it("Canvas2D: ground at -100 tilts and cliffs; a void neighbour draws nothing", () => {
    const m = mapWith([[1, -100], [2, 0]]);
    expect(c2dTileHeight(m, 1, 1)).toBe(-100);
    expect(c2dTileHeight(m, 99, 99)).toBe(undefined);
    // a 1-level step from -100 down to -101 tilts the top exactly like the mesh (ramp, no cliff face)
    const ramp = c2dGroundGeometry(-100, (dx, dy) => (dx === 1 && dy === 0 ? -101 : undefined));
    expect(ramp.faces).toEqual([]);
    expect(ramp.top[1]![1]).toBe(-DEFAULT_ISO.zStep * -101); // R corner dropped to -101
    expect(ramp.top[3]![1]).toBe(-DEFAULT_ISO.zStep * -100); // L corner stays at -100
    expect(ramp.minLow).toBe(-100);
    // a 100-level drop to -100 emits a cliff face down to -100; a void neighbour emits none
    const cliff = c2dGroundGeometry(0, (dx, dy) => (dx === 1 && dy === 0 ? -100 : undefined));
    expect(cliff.faces).toHaveLength(1);
    expect(cliff.faces[0]!.low).toBe(-100); expect(cliff.minLow).toBe(-100);
    const alone = c2dGroundGeometry(0, () => undefined);
    expect(alone.faces).toEqual([]); expect(alone.minLow).toBe(0);
  });

  it("waterfalls: a -100 water neighbour is a real fall target; a void neighbour is not", () => {
    const m = mapWith([[1, 0]], [[1, flowWaterRaw(-100)]]);
    expect(tileSurfaceHeight(m, 1, 2)).toBe(-100.25); // flowed water at the floor, with the 0.25 inset
    expect(tileSurfaceHeight(m, 9, 9)).toBe(NO_TILE_HEIGHT);
    const height = (x: number, y: number): number => (x === 1 && y === 0 ? -100 : 0);
    const segs = classifyWaterfallFaces(() => true, height, 0, 0);
    expect(segs.map((s) => s.role)).toEqual(["lip", "fall"]);
    expect(segs.every((s) => s.drop === 100 && s.topZ === 0 && s.botZ === -100)).toBe(true);
    const voidSegs = classifyWaterfallFaces(() => true, (x, y) => (x === 1 && y === 0 ? NO_TILE_HEIGHT : 0), 0, 0);
    expect(voidSegs).toEqual([]);
  });

  it("codec: flow water round-trips -100..100 through the v2 code and clamps outside it", () => {
    expect(FLOW_WATER_LEVEL_MIN).toBe(-100); expect(FLOW_WATER_LEVEL_MAX).toBe(100);
    expect(FLOW_WATER_MIN_RAW_V2).toBe(900); // v2 raws are 900..1100; legacy raws are -128..127
    for (let level = -100; level <= 100; level++) {
      const raw = flowWaterRaw(level);
      expect(raw).toBe(level + FLOW_WATER_OFFSET_V2);
      expect(isFlowWater(1, raw)).toBe(true);
      expect(terrainLevel(1, raw)).toBe(level);
      expect(renderTileHeight(1, raw)).toBe(level);
    }
    expect(flowWaterRaw(101)).toBe(1100); expect(flowWaterRaw(-101)).toBe(900);
    expect(terrainLevel(1, 1100)).toBe(100); expect(terrainLevel(1, 900)).toBe(-100);
    // legacy ADR-297 bytes still decode (old saves keep their water levels)
    expect(terrainLevel(1, -99)).toBe(-31); expect(terrainLevel(1, -71)).toBe(75);
  });

  it("codec: land and flow water at -100..100 round-trip the chunk codec and agree at the shared cap", () => {
    expect(new Chunk(0, 0).height).toBeInstanceOf(Int16Array);
    const c = new Chunk(0, 0);
    c.set(0, 0, 1); c.setHeight(0, 0, flowWaterRaw(-100));
    c.set(1, 0, 1); c.setHeight(1, 0, flowWaterRaw(100));
    c.set(2, 0, 3); c.setHeight(2, 0, -100);
    c.set(3, 0, 3); c.setHeight(3, 0, 100);
    c.set(4, 0, 1); c.setHeight(4, 0, flowWaterRaw(100)); // flow water at the cap decodes to the same 100 as land
    const back = decodeChunk(encodeChunk(c)).chunk;
    expect(terrainLevel(1, back.getHeight(0, 0))).toBe(-100); expect(renderTileHeight(1, back.getHeight(0, 0))).toBe(-100);
    expect(terrainLevel(1, back.getHeight(1, 0))).toBe(100); expect(renderTileHeight(1, back.getHeight(1, 0))).toBe(100);
    expect(back.getHeight(2, 0)).toBe(-100); expect(back.getHeight(3, 0)).toBe(100);
    expect(terrainLevel(1, back.getHeight(4, 0))).toBe(100);
    expect(terrainLevel(1, back.getHeight(4, 0))).toBe(back.getHeight(3, 0)); // land and flow water agree at 100
  });
});
