/**
 * ADR-383: the renderer needs no new code for elevated lakes — both ground paths already draw water at
 * renderTileHeight, which returns the ADR-263/297 flow level for elevated water and the flat ADR-182
 * level for ordinary water. This pins that contract at the tilemap level.
 */
import { describe, expect, it } from "vitest";
import { ProceduralGenerator, CHUNK_SIZE, TileMap, WATER_SURFACE_HEIGHT } from "@engine/world";
import { tileHeight } from "../src/tilemap.js";

describe("ADR-383: elevated lakes render at their own surface level", () => {
  it("tileHeight is the elevated level over the lake and the flat sea level over the ordinary lake", () => {
    // ADR-386: the lake's position is the SITED one (g.regionLayout), not the hash baseline.
    let sited = 0;
    for (let i = 0; i < 8; i++) {
      const seed = ((i * 40503 + 9) >>> 0) || 1;
      const g = new ProceduralGenerator({ seed });
      const L = g.regionLayout(0, 0)!;
      const el = L.elevatedLake;
      if (!el) continue;
      sited++;
      const map = new TileMap();
      for (const [cx, cy] of [[Math.floor(el.x), Math.floor(el.y)], [Math.floor(L.lake.x), Math.floor(L.lake.y)]] as const) {
        const ccx = Math.floor(cx / CHUNK_SIZE), ccy = Math.floor(cy / CHUNK_SIZE);
        for (let y = ccy - 1; y <= ccy + 1; y++) for (let x = ccx - 1; x <= ccx + 1; x++) map.insertChunk(g.load(x, y).chunk);
      }
      expect(tileHeight(map, Math.floor(el.x), Math.floor(el.y))).toBe(el.level);
      expect(tileHeight(map, Math.floor(L.lake.x), Math.floor(L.lake.y))).toBe(WATER_SURFACE_HEIGHT);
      // The whole disc renders at one level, and the rim land renders above it.
      let rimMin = Infinity;
      for (let y = Math.floor(el.y) - el.r - 2; y <= Math.floor(el.y) + el.r + 2; y++)
        for (let x = Math.floor(el.x) - el.r - 2; x <= Math.floor(el.x) + el.r + 2; x++) {
          const d = Math.hypot(x + 0.5 - el.x, y + 0.5 - el.y);
          if (d <= el.r) expect(tileHeight(map, x, y)).toBe(el.level);
          else if (d <= el.r + 1 && map.getTile(x, y) !== 1 && map.getTile(x, y) !== 8) rimMin = Math.min(rimMin, tileHeight(map, x, y));
        }
      expect(rimMin).toBeGreaterThan(el.level);
    }
    expect(sited).toBeGreaterThanOrEqual(6); // ~2% of regions skip the lake; the rest are covered
  });
});
