// ADR-411: varied terrain heights (worldgen reaches HEIGHT_MAX) + dig/raise 100 storage (ADR-529: was 300)
// (chunk codec v2 i16 heights, v2 flow-water encoding, TerrainEdit dig i16).
import { describe, expect, it } from "vitest";
import { Chunk, CHUNK_AREA, CHUNK_MAGIC, ProceduralGenerator, HEIGHT_MAX, HEIGHT_MIN, computeSpawnPoints, flowWaterRaw, terrainLevel, renderTileHeight, isFlowWater, encodeChunk, decodeChunk, FLOW_WATER_LEVEL_MIN, FLOW_WATER_LEVEL_MAX, FLOW_WATER_OFFSET_V2 } from "../src/index.js";

const SEEDS = [1, 42, 1234, 424242, 9001];

describe("ADR-411 varied terrain height", () => {
  it.each(SEEDS)("seed %i: generated worlds reach the full minimum AND maximum heights", (seed) => {
    const g = new ProceduralGenerator({ seed });
    let min = Infinity, max = -Infinity;
    // Step 4 samples ~65k tiles/seed — plenty: ~6% of wilderness tiles sit at the max.
    for (let y = -512; y <= 512; y += 4) for (let x = -512; x <= 512; x += 4) {
      const h = g.heightAt(x, y);
      expect(h).toBeGreaterThanOrEqual(HEIGHT_MIN); expect(h).toBeLessThanOrEqual(HEIGHT_MAX);
      if (h < min) min = h; if (h > max) max = h;
    }
    expect(min).toBeLessThanOrEqual(-95); expect(max).toBeGreaterThanOrEqual(95); // ADR-530: [-100, 100]
  });

  it.each([1, 1234, 424242])("seed %i: flat buildable areas near spawn still place (faces <= 3 on every spawn patch)", (seed) => {
    const g = new ProceduralGenerator({ seed });
    for (const p of computeSpawnPoints(g)) for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
      const tx = Math.floor(p.x) + x, ty = Math.floor(p.y) + y, h = g.heightAt(tx, ty);
      expect(Math.abs(h - g.heightAt(tx + 1, ty))).toBeLessThanOrEqual(3);
      expect(Math.abs(h - g.heightAt(tx, ty + 1))).toBeLessThanOrEqual(3);
    }
  });

  it("HEIGHT_MAX is 100 and HEIGHT_MIN is -100: plateau 3 x relief 2 + detail 1, gentle near spawn (relief 2 within 160 tiles)", () => {
    expect(HEIGHT_MAX).toBe(100); expect(HEIGHT_MIN).toBe(-100);
    // Water features off: the pure height field (lake bowls raise their own rims on top of it).
    const g = new ProceduralGenerator({ seed: 7, waterFeatures: false, elevatedLakes: false });
    for (let y = -160; y <= 160; y += 7) for (let x = -160; x <= 160; x += 7) {
      const h = g.heightAt(x, y);
      expect(h).toBeLessThanOrEqual(7); // plateau 3 x 2 + detail 1 at most, same as before
      expect(Math.abs(h - g.heightAt(x + 1, y))).toBeLessThanOrEqual(3);
    }
  });
});

describe("ADR-411 flow-water encoding at the new extremes", () => {
  it("flowed water round-trips -100..100 through the v2 code (raw = level + 1000)", () => {
    expect(FLOW_WATER_LEVEL_MIN).toBe(-100); expect(FLOW_WATER_LEVEL_MAX).toBe(100);
    for (const level of [-100, -99, -1, 0, 1, 26, 100]) {
      const raw = flowWaterRaw(level);
      expect(raw).toBe(level + FLOW_WATER_OFFSET_V2);
      expect(isFlowWater(1, raw)).toBe(true);
      expect(terrainLevel(1, raw)).toBe(level);
      expect(renderTileHeight(1, raw)).toBe(level);
    }
    // natural water is still flat (ADR-182) and never flow-coded
    expect(isFlowWater(1, 6)).toBe(false); expect(terrainLevel(1, 6)).toBe(6); expect(renderTileHeight(1, 6)).toBe(0);
    expect(isFlowWater(1, 0)).toBe(false);
  });

  it("ADR-567 re-pin: legacy ADR-297 bytes now decode as natural water (legacy flow branches retired)", () => {
    // Pre-ADR-567 this asserted the legacy decode (raw 50..127 -> -30..47, raw -128..-99 -> -60..-31,
    // raw -98..-71 -> 48..75). ADR-530 widened natural beds to ±100, so those branches misread natural
    // water as flowed water; ADR-567 retires them — only v2 raws are flow water now.
    expect(terrainLevel(1, 50)).toBe(50); expect(terrainLevel(1, 127)).toBe(127);
    expect(terrainLevel(1, -99)).toBe(-99); expect(terrainLevel(1, -128)).toBe(-128);
    expect(terrainLevel(1, -98)).toBe(-98); expect(terrainLevel(1, -71)).toBe(-71);
    expect(renderTileHeight(1, 50)).toBe(0); expect(renderTileHeight(1, -71)).toBe(0);
    expect(isFlowWater(1, 50)).toBe(false); expect(isFlowWater(1, -71)).toBe(false); expect(isFlowWater(1, -70)).toBe(false);
  });

  it("chunk heights are i16 and land + flow water at -100/100 round-trip the v2 codec", () => {
    expect(new Chunk(0, 0).height).toBeInstanceOf(Int16Array);
    const c = new Chunk(0, 0);
    c.set(0, 0, 1); c.setHeight(0, 0, flowWaterRaw(-100));
    c.set(1, 0, 1); c.setHeight(1, 0, flowWaterRaw(100));
    c.set(2, 0, 3); c.setHeight(2, 0, -100);
    c.set(3, 0, 3); c.setHeight(3, 0, 100);
    const back = decodeChunk(encodeChunk(c)).chunk;
    expect(terrainLevel(1, back.getHeight(0, 0))).toBe(-100); expect(renderTileHeight(1, back.getHeight(0, 0))).toBe(-100);
    expect(terrainLevel(1, back.getHeight(1, 0))).toBe(100); expect(renderTileHeight(1, back.getHeight(1, 0))).toBe(100);
    expect(back.getHeight(2, 0)).toBe(-100); expect(back.getHeight(3, 0)).toBe(100);
  });
});

/** Hand-built v1 chunk blob (1 tile run, 1024 u8 heights, no buildings/components/entities unless given). */
function v1ChunkBytes(runs: [number, number][], heights: number[]): Uint8Array {
  const out = new Uint8Array(14 + 2 + runs.length * 4 + CHUNK_AREA + 2 + 1 + 4);
  const d = new DataView(out.buffer);
  d.setUint32(0, CHUNK_MAGIC, true); d.setUint16(4, 1, true); d.setInt32(6, 0, true); d.setInt32(10, 0, true);
  d.setUint16(14, runs.length, true);
  let o = 16;
  for (const [len, id] of runs) { d.setUint16(o, len, true); d.setUint16(o + 2, id, true); o += 4; }
  for (let i = 0; i < CHUNK_AREA; i++) out[o + i] = heights[i]! & 0xff;
  o += CHUNK_AREA;
  d.setUint16(o, 0, true); o += 2; out[o] = 0; o += 1; d.setUint32(o, 0, true);
  return out;
}

describe("ADR-411 chunk codec v1 backward compatibility", () => {
  it("a v1 blob still decodes: u8 heights sign-extend; ADR-567: legacy flow bytes now read as natural water", () => {
    // v1 stored heights survive the codec verbatim; only their DECODE changed in ADR-567 — the bytes that
    // were legacy flow codes (-128 was level -60, -71 was level 75) are now indistinguishable from natural
    // water beds and read flat (the accepted pre-ADR-411 regression, recorded in ADR-567).
    const heights = new Array<number>(CHUNK_AREA).fill(2);
    heights[0] = -128; heights[1] = -71; heights[2] = -5; heights[3] = 26;
    const back = decodeChunk(v1ChunkBytes([[2, 1], [CHUNK_AREA - 2, 3]], heights)).chunk;
    expect(back.getHeight(0, 0)).toBe(-128); expect(terrainLevel(1, back.getHeight(0, 0))).toBe(-128);
    expect(back.getHeight(1, 0)).toBe(-71); expect(renderTileHeight(1, back.getHeight(1, 0))).toBe(0);
    expect(back.getHeight(2, 0)).toBe(-5); expect(back.getHeight(3, 0)).toBe(26);
  });
});
