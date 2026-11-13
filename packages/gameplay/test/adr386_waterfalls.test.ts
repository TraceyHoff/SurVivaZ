/**
 * ADR-386: a waterfall connects the two water bodies for the systems that route through water —
 * waterSurfaceAt reads the spillway's descending surfaces, the channel is a shallow ford (the same
 * AI crossing rule as any stream), and the falls themselves are passable both ways: the 2-level drop
 * is within MAX_UNAIDED_CLIMB (3) and costs no fall damage (drops of <= 3 are free), so the waterfall
 * connects the lake to the sea instead of barring it. No new behaviour rules were needed: a waterfall
 * is ordinary flow water at descending levels.
 */
import { describe, it, expect } from "vitest";
import {
  ProceduralGenerator, CHUNK_SIZE, TileMap,
  renderTileHeight, waterDepthAt, WaterDepth, isWaterId,
} from "@engine/world";
import { waterSurfaceAt } from "../src/terrain.js";
import { terrainFromTileMap } from "../src/world.js";
import * as G from "../src/index.js";

function seeds(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(((i * 2654435761) >>> 0) || 1);
  return out;
}

/** Sited lake + spillway for a seed's region 0 (undefined when there is no lake or no spillway). */
function spillingLake(seed: number): { g: ProceduralGenerator; el: { x: number; y: number; r: number; level: number }; spill: NonNullable<NonNullable<ReturnType<ProceduralGenerator["regionLayout"]>>["spillway"]> } | undefined {
  const g = new ProceduralGenerator({ seed });
  const L = g.regionLayout(0, 0);
  const el = L?.elevatedLake;
  if (!L || !el || !L.spillway) return undefined;
  return { g, el, spill: L.spillway };
}

describe("ADR-386 waterfall: terrain flow and crossing parity", () => {
  it("waterSurfaceAt reads the spillway's descending surfaces, and the flat level at the sea it meets", () => {
    let withSpill = 0;
    for (const seed of seeds(24)) {
      const s = spillingLake(seed);
      if (!s) continue;
      withSpill++;
      const { g, spill } = s;
      const map = new TileMap();
      const xs = spill.tiles.map((t) => t.x), ys = spill.tiles.map((t) => t.y);
      const ccx = Math.floor((Math.min(...xs) + Math.max(...xs)) / 2 / CHUNK_SIZE);
      const ccy = Math.floor((Math.min(...ys) + Math.max(...ys)) / 2 / CHUNK_SIZE);
      for (let y = ccy - 2; y <= ccy + 2; y++) for (let x = ccx - 2; x <= ccx + 2; x++) map.insertChunk(g.load(x, y).chunk);
      const terrain = terrainFromTileMap(map);
      for (const t of spill.tiles) {
        expect(isWaterId(map.getTile(t.x, t.y))).toBe(true);
        expect(waterSurfaceAt(terrain, t.x, t.y)).toBe(t.level);
        expect(renderTileHeight(map.getTile(t.x, t.y), g.sampleAt(t.x, t.y).height)).toBe(t.level);
      }
      expect(waterSurfaceAt(terrain, spill.end.x, spill.end.y)).toBe(0);
    }
    expect(withSpill).toBeGreaterThanOrEqual(8); // ~48% of 24 seeds spill
  });

  it("the channel is a shallow ford, and the falls drop is climbable both ways with no fall damage", () => {
    let withSpill = 0;
    for (const seed of seeds(24)) {
      const s = spillingLake(seed);
      if (!s) continue;
      withSpill++;
      const { g, el, spill } = s;
      const t = (x: number, y: number): number => g.tileAt(x, y);
      for (const tile of spill.tiles) {
        // Shallow: a swimmer fords it, exactly like a stream (ADR-345 depth rule, unchanged).
        expect(waterDepthAt(t, tile.x, tile.y)).toBe(WaterDepth.Shallow);
      }
      // The falls drop itself: 2 levels up (within MAX_UNAIDED_CLIMB 3, so a swimmer can climb back
      // up the falls) and 2 levels down into the channel, then at most 1 per step to the sea.
      expect(spill.tiles[0]!.level - spill.tiles[1]!.level).toBe(2);
      for (let i = 1; i < spill.tiles.length; i++)
        expect(spill.tiles[i - 1]!.level - spill.tiles[i]!.level).toBeLessThanOrEqual(2);
      const last = spill.tiles[spill.tiles.length - 1]!;
      expect(last.level).toBeLessThanOrEqual(3);
      // A drop of <= 3 levels costs no fall damage (terrainFallDamage), so riding the falls down to
      // the sea never hurts — and the lake's own level is at most 7, so no channel step ever falls far.
      expect(G.terrainFallDamage(last.level)).toBe(0);
      expect(G.terrainFallDamage(el.level - spill.tiles[0]!.level)).toBe(0);
    }
    expect(withSpill).toBeGreaterThanOrEqual(8);
  });
});
