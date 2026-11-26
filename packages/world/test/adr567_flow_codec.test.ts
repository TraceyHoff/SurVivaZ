// ADR-567: flow-water codec collision fix (decode side). Only ADR-411 v2 raws (900..1100) decode as flow
// water; natural water raws across the full legal bed range (-100..100) decode as natural water. The
// ADR-297 legacy branches (raw >= 50 / raw <= -71) are retired — since ADR-530 widened generated beds to
// ±100 they misread deep natural water as flowed water (bed -71 -> phantom surface +75, the waterfall wall).
import { describe, expect, it } from "vitest";
import { ProceduralGenerator, flowWaterRaw, isFlowWater, isWaterId, renderTileHeight, terrainLevel, WATER_TILE, SHALLOW_WATER_TILE } from "../src/index.js";

const WATER_IDS = [WATER_TILE, SHALLOW_WATER_TILE];

describe("ADR-567 natural water never decodes as flow water", () => {
  it("every natural raw in -100..100: not flow, renders flat at 0, terrainLevel = raw (both water ids)", () => {
    for (const id of WATER_IDS) for (let raw = -100; raw <= 100; raw++) {
      expect(isFlowWater(id, raw)).toBe(false);
      expect(renderTileHeight(id, raw)).toBe(0);
      expect(terrainLevel(id, raw)).toBe(raw);
    }
  });

  it("the screenshot case: water bed -71 beside sand at -71 decodes to surface 0, not the phantom +75", () => {
    expect(renderTileHeight(SHALLOW_WATER_TILE, -71)).toBe(0); // was +75 pre-fix (-71 + 146)
    expect(terrainLevel(SHALLOW_WATER_TILE, -71)).toBe(-71);
    expect(isFlowWater(SHALLOW_WATER_TILE, -71)).toBe(false);
    expect(renderTileHeight(2, -71)).toBe(-71); // the sand neighbour itself is untouched
  });

  it("beds +50..+79 decode to surface 0, not sunken (raw - 80 pre-fix)", () => {
    for (let raw = 50; raw <= 79; raw++) {
      expect(renderTileHeight(WATER_TILE, raw)).toBe(0);
      expect(terrainLevel(WATER_TILE, raw)).toBe(raw);
    }
    // the rest of the old legacy bands are natural too
    expect(terrainLevel(WATER_TILE, 127)).toBe(127); expect(renderTileHeight(WATER_TILE, 127)).toBe(0);
    expect(terrainLevel(WATER_TILE, -99)).toBe(-99); expect(terrainLevel(WATER_TILE, -100)).toBe(-100);
  });

  it("v2 raws 900..1100 keep decoding exactly as before (flowLevel = raw - 1000)", () => {
    for (const id of WATER_IDS) for (let level = -100; level <= 100; level++) {
      const raw = flowWaterRaw(level);
      expect(raw).toBe(level + 1000);
      expect(isFlowWater(id, raw)).toBe(true);
      expect(terrainLevel(id, raw)).toBe(level);
      expect(renderTileHeight(id, raw)).toBe(level);
    }
    // a v2-range raw on a land id is not flow water
    expect(isFlowWater(2, flowWaterRaw(10))).toBe(false);
  });
});

describe("ADR-567 worldgen sweep: no natural water tile in a real region decodes as flow water", () => {
  it("seed 42, 512x512 tiles of region (0,1) via the real ProceduralGenerator.sampleAt", () => {
    const g = new ProceduralGenerator({ seed: 42 });
    let waterTiles = 0, deepBeds = 0, highBeds = 0, flowTiles = 0;
    for (let y = 1536; y < 1536 + 512; y++) for (let x = 0; x < 512; x++) {
      const s = g.sampleAt(x, y);
      if (!isWaterId(s.tile)) continue;
      waterTiles++;
      if (s.height >= 900) { // genuine v2 flow water (spillway / network channel / elevated lake)
        flowTiles++;
        expect(isFlowWater(s.tile, s.height)).toBe(true);
        expect(terrainLevel(s.tile, s.height)).toBe(s.height - 1000);
      } else {
        if (s.height <= -71) deepBeds++;
        if (s.height >= 50) highBeds++;
        expect(isFlowWater(s.tile, s.height)).toBe(false);
        expect(renderTileHeight(s.tile, s.height)).toBe(0);
        expect(terrainLevel(s.tile, s.height)).toBe(s.height);
      }
    }
    // the sweep must actually cover the phantom ranges, or the assertions above are vacuous
    expect(waterTiles).toBeGreaterThan(1000);
    expect(deepBeds).toBeGreaterThan(0); // beds <= -71 decoded to +48..+75 pre-fix
    expect(highBeds).toBeGreaterThan(0); // beds >= 50 decoded sunken/raised pre-fix
    expect(flowTiles).toBeGreaterThanOrEqual(0);
  }, 120_000);
});
