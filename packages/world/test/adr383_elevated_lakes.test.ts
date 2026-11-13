/**
 * ADR-383: elevated lakes — a lake whose water sits above sea level (surface level 4..7, vs the flat
 * ADR-182 level 0), held in a bowl of higher terrain: a beach shelf clamped to [level+1, level+3] and a
 * raise-only rim out to 4 tiles. The lake reuses the existing water systems: tile 1/8 water, the
 * ADR-263/297 flow encoding for its surface, the same depth / swim / crossing rules as a normal lake.
 */
import { describe, it, expect } from "vitest";
import {
  ProceduralGenerator, CHUNK_SIZE, HEIGHT_MAX, WATER_FEATURE_RADIUS,
  waterFeatureLayout, waterFeatureAt, elevatedLakeAt, elevatedLakeDist,
  flowWaterRaw, renderTileHeight, terrainLevel, waterDepthAt, WaterDepth, isWaterId,
  surveyWaterFeatures, sampleWorldPreview, computeSpawnPoints,
  encodeChunk, decodeChunk,
} from "../src/index.js";

function seeds(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(((i * 2654435761) >>> 0) || 1);
  return out;
}

describe("ADR-383 elevated lake layout", () => {
  it("every seed gets one elevated lake on a free cardinal, above sea level, inside the survey window", () => {
    for (const seed of seeds(40)) {
      const L = waterFeatureLayout(seed);
      // ADR-386: waterFeatureLayout is the hash baseline and always returns one; only the generator's
      // sited layout may skip the lake (no placement clear of the sea).
      const el = L.elevatedLake!;
      expect(el.level).toBeGreaterThanOrEqual(4);
      expect(el.level).toBeLessThanOrEqual(7);
      expect(el.r).toBeGreaterThanOrEqual(6);
      expect(el.r).toBeLessThanOrEqual(10);
      const dist = Math.hypot(el.x, el.y);
      expect(dist).toBeGreaterThanOrEqual(84);
      expect(dist).toBeLessThanOrEqual(104);
      expect(Math.abs(el.x)).toBeLessThan(WATER_FEATURE_RADIUS);
      expect(Math.abs(el.y)).toBeLessThan(WATER_FEATURE_RADIUS);
      // On a cardinal (one axis ~0.5) and on a different cardinal from the lake and the pond.
      const axis = Math.abs(el.x) < 2 || Math.abs(el.y) < 2;
      expect(axis).toBe(true);
      const card = (x: number, y: number): string => (Math.abs(x) < 2 ? (y > 0 ? "S" : "N") : (x > 0 ? "E" : "W"));
      expect(card(el.x, el.y)).not.toBe(card(L.lake.x, L.lake.y));
      expect(card(el.x, el.y)).not.toBe(card(L.pond.x, L.pond.y));
      expect(waterFeatureAt(seed, Math.floor(el.x), Math.floor(el.y), L)).toBe("elevatedLake");
      expect(elevatedLakeAt(seed, Math.floor(el.x), Math.floor(el.y), L)).toBe(el.level);
      expect(waterFeatureAt(seed, Math.floor(L.lake.x), Math.floor(L.lake.y), L)).toBe("lake");
      expect(waterFeatureAt(seed, Math.floor(L.pond.x), Math.floor(L.pond.y), L)).toBe("pond");
    }
  });

  it("knobs move the lake (level / radius / distance ranges are honoured)", () => {
    const L = waterFeatureLayout(42, { minLevel: 9, maxLevel: 9, minRadius: 5, maxRadius: 5, minDistance: 90, maxDistance: 90 });
    expect(L.elevatedLake!.level).toBe(9);
    expect(L.elevatedLake!.r).toBe(5);
    expect(Math.hypot(L.elevatedLake!.x, L.elevatedLake!.y)).toBeCloseTo(90, 0);
  });
});

describe("ADR-383 elevated lake tiles, surface and bowl", () => {
  it("the disc is water whose rendered surface is the elevated level (not the flat sea level)", () => {
    // ADR-386: the lake's position is the SITED one (g.regionLayout), not the hash baseline — siting
    // moves most lakes to higher ground clear of the sea, and skips ~2% of regions outright.
    let sited = 0;
    for (const seed of seeds(24)) {
      const g = new ProceduralGenerator({ seed });
      const L = g.regionLayout(0, 0)!;
      const el = L.elevatedLake;
      if (!el) continue;
      sited++;
      const cx = Math.floor(el.x), cy = Math.floor(el.y);
      const s = g.sampleAt(cx, cy);
      expect(isWaterId(s.tile)).toBe(true);
      expect(s.height).toBe(flowWaterRaw(el.level)); // stored as the ADR-263/297 flow encoding
      expect(renderTileHeight(s.tile, s.height)).toBe(el.level);
      expect(terrainLevel(s.tile, s.height)).toBe(el.level);
      expect(g.heightAt(cx, cy)).toBe(el.level); // generator level agrees with the loaded chunk's terrainLevel
      // Contrast: the ordinary lake still renders at the flat ADR-182 sea level.
      const ls = g.sampleAt(Math.floor(L.lake.x), Math.floor(L.lake.y));
      expect(isWaterId(ls.tile)).toBe(true);
      expect(renderTileHeight(ls.tile, ls.height)).toBe(0);
      expect(terrainLevel(ls.tile, ls.height)).toBeLessThan(50); // not flow-encoded
    }
    expect(sited).toBeGreaterThanOrEqual(20); // ~2% of regions skip the lake; the rest are covered
  });

  it("load() chunks agree with sampleAt() across the whole disc + rim, deterministically", () => {
    let sited = 0;
    for (const seed of seeds(12)) {
      const g1 = new ProceduralGenerator({ seed });
      const g2 = new ProceduralGenerator({ seed });
      const L = g1.regionLayout(0, 0)!;
      const el = L.elevatedLake;
      if (!el) continue;
      sited++;
      const cx = Math.floor(el.x), cy = Math.floor(el.y);
      const x0 = cx - el.r - 5, x1 = cx + el.r + 5, y0 = cy - el.r - 5, y1 = cy + el.r + 5;
      const loaded = new Map<string, ReturnType<typeof g1.load>["chunk"]>();
      for (let cy2 = Math.floor(y0 / CHUNK_SIZE); cy2 <= Math.floor(y1 / CHUNK_SIZE); cy2++)
        for (let cx2 = Math.floor(x0 / CHUNK_SIZE); cx2 <= Math.floor(x1 / CHUNK_SIZE); cx2++) {
          const c1 = g1.load(cx2, cy2).chunk, c2 = g2.load(cx2, cy2).chunk;
          expect(c1.tiles).toEqual(c2.tiles);
          expect(c1.height).toEqual(c2.height);
          // Codec round-trip preserves the flow-encoded surface (streaming persistence).
          const d = decodeChunk(encodeChunk(c1)).chunk;
          expect(d.tiles).toEqual(c1.tiles);
          expect(d.height).toEqual(c1.height);
        }
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const s = g1.sampleAt(x, y);
        const cx2 = Math.floor(x / CHUNK_SIZE), cy2 = Math.floor(y / CHUNK_SIZE);
        const key = `${cx2},${cy2}`;
        let c = loaded.get(key);
        if (!c) loaded.set(key, (c = g1.load(cx2, cy2).chunk));
        const lx = ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE, ly = ((y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        expect(s.tile).toBe(c.get(lx, ly));
        expect(s.height).toBe(c.getHeight(lx, ly));
      }
    }
    expect(sited).toBeGreaterThanOrEqual(10); // ~2% of regions skip the lake; the rest are covered
  });

  it("the bowl holds: shelf land sits in [level+1, level+3] and the outer rim never drops below level+1", () => {
    for (const seed of seeds(40)) {
      const g = new ProceduralGenerator({ seed });
      const L = g.regionLayout(0, 0)!;
      const el = L.elevatedLake;
      if (!el) continue;
      const cx = Math.floor(el.x), cy = Math.floor(el.y);
      for (let y = cy - el.r - 5; y <= cy + el.r + 5; y++) for (let x = cx - el.r - 5; x <= cx + el.r + 5; x++) {
        const d = elevatedLakeDist(L, x, y);
        if (d <= el.r || isWaterId(g.tileAt(x, y))) continue;
        const h = g.heightAt(x, y);
        if (d <= el.r + 1) { expect(h).toBeGreaterThanOrEqual(el.level + 1); expect(h).toBeLessThanOrEqual(el.level + 3); }
        else if (d <= el.r + 4) expect(h).toBeGreaterThanOrEqual(el.level + 1);
      }
    }
  });

  it("every land tile touching the lake is climbable from the water (rise <= MAX_UNAIDED_CLIMB 3)", () => {
    for (const seed of seeds(40)) {
      const g = new ProceduralGenerator({ seed });
      const L = g.regionLayout(0, 0)!;
      const el = L.elevatedLake;
      if (!el) continue;
      const cx = Math.floor(el.x), cy = Math.floor(el.y);
      for (let y = cy - el.r - 1; y <= cy + el.r + 1; y++) for (let x = cx - el.r - 1; x <= cx + el.r + 1; x++) {
        if (elevatedLakeDist(L, x, y) > el.r) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx, ny = y + dy;
          if (elevatedLakeDist(L, nx, ny) <= el.r || isWaterId(g.tileAt(nx, ny))) continue;
          expect(g.heightAt(nx, ny) - el.level).toBeLessThanOrEqual(3);
        }
      }
    }
  });

  it("the lake is deep inside and, where it has a land shore, shallow at it — like a normal lake", () => {
    // ADR-386: noise-aware siting guarantees every sited lake a full land shore (no sea within
    // disc+2), so the shallow-shore assertion is unconditional now — the ADR-383 sea-merge
    // conditional (a lake merged with a biome sea has no shore) cannot occur for a sited lake.
    let withShore = 0, sited = 0;
    for (const seed of seeds(40)) {
      const g = new ProceduralGenerator({ seed });
      const L = g.regionLayout(0, 0)!;
      const el = L.elevatedLake;
      if (!el) continue;
      sited++;
      const t = (x: number, y: number): number => g.tileAt(x, y);
      expect(waterDepthAt(t, Math.floor(el.x), Math.floor(el.y))).toBe(WaterDepth.Deep);
      let sawShallow = false, hasShore = false;
      for (let y = Math.floor(el.y) - el.r - 1; y <= Math.floor(el.y) + el.r + 1; y++)
        for (let x = Math.floor(el.x) - el.r - 1; x <= Math.floor(el.x) + el.r + 1; x++) {
          const d = elevatedLakeDist(L, x, y);
          if (d <= el.r && waterDepthAt(t, x, y) === WaterDepth.Shallow) sawShallow = true;
          if (d > el.r && d <= el.r + 1 && !isWaterId(g.tileAt(x, y))) hasShore = true;
        }
      if (hasShore) { withShore++; expect(sawShallow).toBe(true); }
    }
    expect(sited).toBeGreaterThanOrEqual(36);
    expect(withShore).toBe(sited); // every sited lake has a land shore (ADR-386 siting)
  });

  it("the lake never drowns a spawn patch", () => {
    for (const seed of seeds(24)) {
      const g = new ProceduralGenerator({ seed });
      const L = g.regionLayout(0, 0)!;
      const el = L.elevatedLake;
      if (!el) continue;
      for (const p of computeSpawnPoints(g)) {
        const d = Math.hypot(p.x - el.x, p.y - el.y);
        expect(d).toBeGreaterThan(el.r + 5);
      }
    }
  });

  it("survey still finds the forced lake / river / pond, and counts lakes", () => {
    for (const seed of seeds(12)) {
      const g = new ProceduralGenerator({ seed });
      const s = surveyWaterFeatures(seed, (x, y) => g.tileAt(x, y), isWaterId, WATER_FEATURE_RADIUS);
      expect(s.forced).toEqual({ lake: true, river: true, pond: true });
      expect(s.lakes).toBeGreaterThanOrEqual(1);
    }
  });

  it("elevatedLakes: false (and waterFeatures: false) leave no elevated surface", () => {
    for (const seed of seeds(12)) {
      const L = waterFeatureLayout(seed);
      const el = L.elevatedLake!;
      const cx = Math.floor(el.x), cy = Math.floor(el.y);
      for (const g of [new ProceduralGenerator({ seed, elevatedLakes: false }), new ProceduralGenerator({ seed, waterFeatures: false })]) {
        const s = g.sampleAt(cx, cy);
        expect(s.height).toBeLessThan(50); // no flow encoding of an elevated level
        // No elevated surface: a water tile here renders at the flat sea level (land renders at its own height).
        if (isWaterId(s.tile)) expect(renderTileHeight(s.tile, s.height)).toBe(0);
        expect(g.heightAt(cx, cy)).toBeLessThanOrEqual(HEIGHT_MAX);
      }
    }
  });

  it("far regions get their own elevated lake too", () => {
    const seed = 424242;
    const g = new ProceduralGenerator({ seed });
    let sited = 0;
    for (const [rx, ry] of [[2, -1], [-3, 2]] as const) {
      // ADR-386: the region's SITED layout, not the hash baseline.
      const rl = g.regionLayout(rx * 512, ry * 512)!;
      const el = rl.elevatedLake;
      if (!el) continue;
      sited++;
      const tx = rx * 512 + Math.floor(el.x), ty = ry * 512 + Math.floor(el.y);
      const s = g.sampleAt(tx, ty);
      expect(isWaterId(s.tile)).toBe(true);
      expect(renderTileHeight(s.tile, s.height)).toBe(el.level);
      expect(g.heightAt(tx, ty)).toBe(el.level);
    }
    expect(sited).toBeGreaterThanOrEqual(1);
  });
});

describe("ADR-383 preview", () => {
  it("preview heights decode to real terrain levels (no flow-encoding blow-out in the thumbnail)", () => {
    for (const seed of [0, 1234, 424242, 0xffffffff]) {
      const p = sampleWorldPreview(seed);
      for (let i = 0; i < p.tiles.length; i++) {
        const level = terrainLevel(p.tiles[i]!, p.heights[i]!);
        expect(level).toBeGreaterThanOrEqual(0);
        expect(level).toBeLessThanOrEqual(HEIGHT_MAX);
      }
    }
  });
});
