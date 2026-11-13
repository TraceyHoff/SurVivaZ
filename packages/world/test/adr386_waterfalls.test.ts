/**
 * ADR-386: waterfalls — elevated lakes never merge with sea-level water; the only connection is a
 * waterfall (a spillway channel from the lake's rim down to lower water, with one 2-level drop).
 * Noise-aware siting picks the lake's cardinal/position by the height field, so every sited lake has
 * a full land shore; a region with no valid placement has no lake at all (skipped, not merged).
 */
import { describe, it, expect } from "vitest";
import {
  ProceduralGenerator, CHUNK_SIZE, WATER_FEATURE_RADIUS,
  waterFeatureLayout, waterFeatureAt, elevatedLakeDist,
  flowWaterRaw, renderTileHeight, terrainLevel, waterDepthAt, WaterDepth, isWaterId,
  sampleWorldPreview,
  encodeChunk, decodeChunk,
} from "../src/index.js";

function seeds(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(((i * 2654435761) >>> 0) || 1);
  return out;
}

/** Sited elevated lake for a seed's region 0 (undefined when siting skipped the region's lake). */
function sitedLake(seed: number): { g: ProceduralGenerator; L: NonNullable<ReturnType<ProceduralGenerator["regionLayout"]>>; el: NonNullable<NonNullable<ReturnType<ProceduralGenerator["regionLayout"]>>["elevatedLake"]> } | undefined {
  const g = new ProceduralGenerator({ seed });
  const L = g.regionLayout(0, 0);
  const el = L?.elevatedLake;
  if (!L || !el) return undefined;
  return { g, L, el };
}

/** Tiles of the elevated system (disc + spillway) at region-local coords, for one sited lake. */
function systemTiles(L: NonNullable<ReturnType<ProceduralGenerator["regionLayout"]>>, el: { x: number; y: number; r: number }): Set<string> {
  const s = new Set<string>();
  const cx = Math.floor(el.x), cy = Math.floor(el.y);
  for (let y = cy - el.r - 1; y <= cy + el.r + 1; y++) for (let x = cx - el.r - 1; x <= cx + el.r + 1; x++)
    if (elevatedLakeDist(L, x, y) <= el.r) s.add(`${x},${y}`);
  for (const t of L.spillway?.tiles ?? []) s.add(`${t.x},${t.y}`);
  return s;
}

describe("ADR-386 noise-aware siting: no sea contact, full land shore", () => {
  it("no sited lake touches sea-level water (no untagged water within disc+2), and every sited lake has a land shore", () => {
    let sited = 0, skipped = 0, noShore = 0;
    for (const seed of seeds(200)) {
      const s = sitedLake(seed);
      if (!s) { skipped++; continue; }
      sited++;
      const { g, L, el } = s;
      expect(el.level).toBeGreaterThanOrEqual(4);
      expect(el.level).toBeLessThanOrEqual(7);
      expect(el.r).toBeGreaterThanOrEqual(6);
      expect(el.r).toBeLessThanOrEqual(10);
      // Distance 84..104 normally; the fallback tier (no valid placement that far out) sits closer in, 63..83.
      // (The centre sits half a tile off the axis, so the hypot reads up to 0.5 either side of the distance.)
      const dist = Math.hypot(el.x, el.y);
      expect(dist).toBeGreaterThanOrEqual(62);
      expect(dist).toBeLessThanOrEqual(105);
      expect(Math.abs(el.x)).toBeLessThan(WATER_FEATURE_RADIUS);
      expect(Math.abs(el.y)).toBeLessThan(WATER_FEATURE_RADIUS);
      const sys = systemTiles(L, el);
      const cx = Math.floor(el.x), cy = Math.floor(el.y);
      let hasShore = false;
      for (let y = cy - el.r - 2; y <= cy + el.r + 2; y++) for (let x = cx - el.r - 2; x <= cx + el.r + 2; x++) {
        const d = Math.hypot(x + 0.5 - el.x, y + 0.5 - el.y);
        if (d > el.r + 2) continue;
        if (d > el.r && d <= el.r + 1 && !isWaterId(g.tileAt(x, y))) hasShore = true;
        if (!isWaterId(g.tileAt(x, y))) continue;
        if (d <= el.r) continue; // disc
        if (sys.has(`${x},${y}`)) continue; // spillway
        // Any other water within disc+2 must be a tagged forced feature (river/lake/pond at sea
        // level) — never untagged biome sea.
        expect(waterFeatureAt(seed, x, y, L)).not.toBe("none");
      }
      if (!hasShore) noShore++;
    }
    expect(sited).toBeGreaterThanOrEqual(190); // skip rate <= 5% (measured ~2%)
    expect(skipped).toBeLessThanOrEqual(10);
    expect(noShore).toBe(0); // the ADR-383 ~5% no-land-shore case is gone for sited lakes
  });

  it("skipped regions skip because the lake would have merged with the sea (the hash placement touches it)", () => {
    // The skip is the fallback, not a bug: for every skipped region, the hash placement itself is
    // sea-merged, so there was nothing valid to relocate to on the primary tier.
    let skipped = 0, justified = 0;
    for (const seed of seeds(500)) {
      const s = sitedLake(seed);
      if (s) continue;
      skipped++;
      const g = new ProceduralGenerator({ seed });
      const hash = waterFeatureLayout(seed).elevatedLake!;
      const hcx = Math.floor(hash.x), hcy = Math.floor(hash.y);
      let touches = false;
      for (let y = hcy - hash.r - 2; y <= hcy + hash.r + 2 && !touches; y++) for (let x = hcx - hash.r - 2; x <= hcx + hash.r + 2; x++) {
        if (Math.hypot(x + 0.5 - hash.x, y + 0.5 - hash.y) > hash.r + 2) continue;
        if (!isWaterId(g.tileAt(x, y))) continue;
        if (waterFeatureAt(seed, x, y, waterFeatureLayout(seed)) !== "none") continue;
        touches = true; break;
      }
      if (touches) justified++;
    }
    expect(skipped).toBeGreaterThanOrEqual(1); // the skip path is exercised (~2% of seeds)
    expect(skipped).toBeLessThanOrEqual(25); // <= 5%
    expect(justified).toBe(skipped); // every skip is a sea-merge avoided, not a siting failure
  });

  it("far regions are sited the same way (no sea contact there either)", () => {
    let sited = 0, skipped = 0, seaTouch = 0;
    for (const seed of seeds(40)) {
      const g = new ProceduralGenerator({ seed });
      for (const [rx, ry] of [[2, -1], [-3, 2], [1, 1]] as const) {
        const L = g.regionLayout(rx * 512, ry * 512);
        const el = L?.elevatedLake;
        if (!L || !el) { skipped++; continue; }
        sited++;
        const sys = systemTiles(L, el);
        const ox = rx * 512, oy = ry * 512;
        const cx = Math.floor(el.x), cy = Math.floor(el.y);
        for (let y = cy - el.r - 2; y <= cy + el.r + 2; y++) for (let x = cx - el.r - 2; x <= cx + el.r + 2; x++) {
          const d = Math.hypot(x + 0.5 - el.x, y + 0.5 - el.y);
          if (d > el.r + 2 || d <= el.r) continue;
          if (sys.has(`${x},${y}`)) continue;
          if (!isWaterId(g.tileAt(ox + x, oy + y))) continue;
          if (waterFeatureAt(0, x, y, L) !== "none") continue;
          seaTouch++;
        }
      }
    }
    expect(sited).toBeGreaterThanOrEqual(110); // skip rate <= ~8% out here
    expect(skipped).toBeLessThanOrEqual(10);
    expect(seaTouch).toBe(0);
  });
});

describe("ADR-386 spillway + waterfall: structure, levels, no flat merge", () => {
  it("a spillway is a 4-connected channel from the rim to lower water, with exactly one 2-level waterfall drop", () => {
    let withSpill = 0, sited = 0;
    for (const seed of seeds(200)) {
      const s = sitedLake(seed);
      if (!s) continue;
      sited++;
      const { g, L, el } = s;
      const sp = L.spillway;
      if (!sp) continue;
      withSpill++;
      const tiles = sp.tiles;
      expect(tiles.length).toBeGreaterThanOrEqual(2);
      expect(tiles.length).toBeLessThanOrEqual(64);
      // 4-connected, starting 4-adjacent to the disc.
      expect(elevatedLakeDist(L, tiles[0]!.x, tiles[0]!.y)).toBeGreaterThan(el.r);
      const adj0 = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(([dx, dy]) => elevatedLakeDist(L, tiles[0]!.x + dx, tiles[0]!.y + dy) <= el.r);
      expect(adj0).toBe(true);
      for (let i = 1; i < tiles.length; i++)
        expect(Math.abs(tiles[i]!.x - tiles[i - 1]!.x) + Math.abs(tiles[i]!.y - tiles[i - 1]!.y)).toBe(1);
      // Levels: breach at L-1, the waterfall drops exactly 2 to L-3, then 1 per tile to a floor of 1.
      expect(tiles[0]!.level).toBe(el.level - 1);
      expect(tiles[1]!.level).toBe(el.level - 3);
      for (let i = 2; i < tiles.length; i++) {
        expect(tiles[i]!.level).toBeLessThanOrEqual(tiles[i - 1]!.level);
        expect(tiles[i - 1]!.level - tiles[i]!.level).toBeLessThanOrEqual(1);
        expect(tiles[i]!.level).toBeGreaterThanOrEqual(1);
      }
      // Every channel tile is water at its own flow-encoded level; the end is sea-level water.
      for (const t of tiles) {
        const smp = g.sampleAt(t.x, t.y);
        expect(isWaterId(smp.tile)).toBe(true);
        expect(renderTileHeight(smp.tile, smp.height)).toBe(t.level);
        expect(terrainLevel(smp.tile, smp.height)).toBe(t.level);
      }
      const end = g.sampleAt(sp.end.x, sp.end.y);
      expect(isWaterId(end.tile)).toBe(true);
      expect(renderTileHeight(end.tile, end.height)).toBe(0);
      // The end is 4-adjacent to the last channel tile.
      const last = tiles[tiles.length - 1]!;
      expect(Math.abs(sp.end.x - last.x) + Math.abs(sp.end.y - last.y)).toBe(1);
    }
    expect(sited).toBeGreaterThanOrEqual(190);
    expect(withSpill).toBeGreaterThanOrEqual(60); // >= ~30% of sited lakes spill (measured ~48%)
  });

  it("no flat merge anywhere: no disc tile touches sea-level water, and only the spillway's end does", () => {
    let sited = 0;
    for (const seed of seeds(200)) {
      const s = sitedLake(seed);
      if (!s) continue;
      sited++;
      const { g, L, el } = s;
      const sys = systemTiles(L, el);
      const cx = Math.floor(el.x), cy = Math.floor(el.y);
      // No disc tile is 4-adjacent to sea-level water.
      for (let y = cy - el.r; y <= cy + el.r; y++) for (let x = cx - el.r; x <= cx + el.r; x++) {
        if (elevatedLakeDist(L, x, y) > el.r) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx, ny = y + dy;
          if (sys.has(`${nx},${ny}`)) continue;
          if (!isWaterId(g.tileAt(nx, ny))) continue;
          // A water neighbour of the disc must be a tagged forced feature, never untagged sea.
          expect(waterFeatureAt(seed, nx, ny, L)).not.toBe("none");
        }
      }
      // The only elevated-system tile 4-adjacent to sea-level water is the last spillway tile
      // (or none, for a closed lake / a rim that already meets a river).
      const last = L.spillway?.tiles.at(-1);
      for (const key of sys) {
        const [x, y] = key.split(",").map(Number);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x! + dx, ny = y! + dy;
          if (sys.has(`${nx},${ny}`)) continue;
          if (!isWaterId(g.tileAt(nx, ny))) continue;
          if (waterFeatureAt(seed, nx, ny, L) !== "none") continue; // forced river/lake/pond junction
          // Untagged sea water: only the spillway's last tile may touch it.
          expect(last).toBeDefined();
          expect(x).toBe(last!.x);
          expect(y).toBe(last!.y);
        }
      }
    }
    expect(sited).toBeGreaterThanOrEqual(190);
  });

  it("the spillway is shallow (fordable) and load() agrees with sampleAt() across it", () => {
    let withSpill = 0;
    for (const seed of seeds(40)) {
      const s = sitedLake(seed);
      if (!s) continue;
      const sp = s.L.spillway;
      if (!sp) continue;
      withSpill++;
      const { g, L } = s;
      const t = (x: number, y: number): number => g.tileAt(x, y);
      for (const tile of sp.tiles) {
        // A 1-wide channel always has land within radius 2: it reads shallow, like a stream ford.
        expect(waterDepthAt(t, tile.x, tile.y)).toBe(WaterDepth.Shallow);
      }
      // load() chunks agree with sampleAt() across the whole channel + end.
      const xs = sp.tiles.map((tile) => tile.x), ys = sp.tiles.map((tile) => tile.y);
      const x0 = Math.min(...xs, sp.end.x) - 2, x1 = Math.max(...xs, sp.end.x) + 2;
      const y0 = Math.min(...ys, sp.end.y) - 2, y1 = Math.max(...ys, sp.end.y) + 2;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const smp = g.sampleAt(x, y);
        const cx2 = Math.floor(x / CHUNK_SIZE), cy2 = Math.floor(y / CHUNK_SIZE);
        const c = g.load(cx2, cy2).chunk;
        const lx = ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE, ly = ((y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
        expect(smp.tile).toBe(c.get(lx, ly));
        expect(smp.height).toBe(c.getHeight(lx, ly));
        // Codec round-trip preserves the flow-encoded channel levels (streaming persistence).
        const d = decodeChunk(encodeChunk(c)).chunk;
        expect(d.get(lx, ly)).toBe(c.get(lx, ly));
        expect(d.getHeight(lx, ly)).toBe(c.getHeight(lx, ly));
      }
    }
    expect(withSpill).toBeGreaterThanOrEqual(12); // ~48% of 40 seeds spill
  });

  it("preview thumbnails agree with the sited lake + spillway (no flow-encoding blow-out)", () => {
    for (const seed of [0, 1234, 424242, 0xffffffff]) {
      const p = sampleWorldPreview(seed);
      for (let i = 0; i < p.tiles.length; i++) {
        const level = terrainLevel(p.tiles[i]!, p.heights[i]!);
        expect(level).toBeGreaterThanOrEqual(0);
        expect(level).toBeLessThanOrEqual(22);
      }
    }
  });
});

describe("ADR-386 gate fix: a length-1 spillway is a closed lake, not a 3..6-level drop", () => {
  it("the 15 named length-1 seeds from the gate's 2,000-seed probe are closed lakes (no spillway)", () => {
    // Gate probe: on these seeds the rim breach sat directly adjacent to lower water, so the walk
    // ended on step 0 with a 1-tile channel and no tiles[1] — no 2-level falls, just a 3..6-level
    // drop to the sea (fall damage going down, unclimbable back up). The guard in spillwayFor
    // (path.length < 2) treats them as closed lakes; the lake itself is still sited, with its
    // full land shore, and the swimmer climbs out onto land and walks to the sea.
    for (const seed of [
      586608029, 1143392920, 777697452, 3819410130, 3932415446, 328819806, 2356628258,
      1203039196, 1646818771, 2682304446, 105952792, 1324286201, 3782534468, 2881635558,
      3425080689,
    ]) {
      const s = sitedLake(seed);
      expect(s).toBeDefined();
      expect(s!.L.spillway).toBeUndefined();
    }
  });

  it("every spillway over 2,000 seeds has >= 2 tiles, so the 2-level falls always exists", () => {
    // The 200-seed structure test above cannot see a 1.6%-of-spillways defect; this sweep is the
    // gate's probe as a test (~35 s: one regionLayout per seed). Any spillway shorter than 2
    // tiles would leave tiles[1] undefined and the falls a sheer drop.
    let sited = 0, withSpill = 0;
    for (const seed of seeds(2000)) {
      const s = sitedLake(seed);
      if (!s) continue;
      sited++;
      const sp = s.L.spillway;
      if (!sp) continue;
      withSpill++;
      expect(sp.tiles.length).toBeGreaterThanOrEqual(2);
      expect(sp.tiles[1]!.level).toBe(s.el.level - 3);
    }
    expect(sited).toBeGreaterThanOrEqual(1900); // sited ~98% (gate probe: 1,964/2,000)
    expect(withSpill).toBeGreaterThanOrEqual(850); // ~46% of sited spill (gate probe, post-fix: 906/1,964)
  });
});
