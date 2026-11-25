// ADR-534: huge lakes / small oceans — the great lake scaled up (r 100..130) with bigger
// islands, >= 2 feeder rivers in and >= 1 outflow out per lake, so the ADR-533 network is a
// system, not scattered ponds. The lake is sited where its shore works (ADR-534): a lake in
// a deep sub-0 basin gets no feeder (a walk needs ground >= 0) and no boat can land on a
// 42-level cliff shore, so siteGreatLake moves the lake to the best-shored candidate.
// Region zero keeps the ADR-255/423 starter layout exactly (see adr534_cross_region_sea).
import { describe, expect, it } from "vitest";
import {
  ProceduralGenerator, REGION_SIZE, isWaterId,
  GREAT_LAKE_MIN_RADIUS, GREAT_LAKE_MAX_RADIUS,
  ISLAND_MAIN_MIN_RADIUS, ISLAND_MAIN_MAX_RADIUS,
  BOAT_ENTERABLE_MOUTH_LEVEL,
} from "../src/index.js";

const SEEDS = [1, 42, 1234, 424242, 9001];
const RX = REGION_SIZE, RY = 0;

function greatLake(seed: number) {
  const g = new ProceduralGenerator({ seed });
  const L = g.regionLayout(RX, RY)!;
  return { gen: g, lake: L.greatLake! };
}

/** Channels whose mouth (end tile) lies inside the lake disc — rivers flowing INTO it. */
function feedersInto(gen: ProceduralGenerator, lake: { x: number; y: number; r: number }) {
  const cx = RX + lake.x, cy = RY + lake.y;
  return gen.riversInRegion(1, 0).channels.filter(
    (c) => c.endKind === "water" && Math.hypot(c.end.x + 0.5 - cx, c.end.y + 0.5 - cy) <= lake.r,
  );
}

/** The lake's outflow: an outflow-kind channel leaving from the shore to other water. */
function outflowsOf(gen: ProceduralGenerator, lake: { x: number; y: number; r: number }) {
  const cx = RX + lake.x, cy = RY + lake.y;
  return gen.riversInRegion(1, 0).channels.filter(
    (c) => c.source.kind === "outflow" && c.endKind === "water"
      && Math.hypot(c.centreline[0]!.x + 0.5 - cx, c.centreline[0]!.y + 0.5 - cy) <= lake.r + 3,
  );
}

describe("ADR-534 huge lakes: size and islands", () => {
  it.each(SEEDS)("seed %i: great lake is huge (r 100..130, realised water area >= 25k tiles)", (seed) => {
    const { gen, lake } = greatLake(seed);
    expect(lake.r).toBeGreaterThanOrEqual(GREAT_LAKE_MIN_RADIUS);
    expect(lake.r).toBeLessThanOrEqual(GREAT_LAKE_MAX_RADIUS);
    // Literal bounds too (the constants above revert with the code, so they cannot prove
    // the new size on their own): the huge lake is r 100..130, not the old r 55..80.
    expect(lake.r).toBeGreaterThanOrEqual(100);
    expect(lake.r).toBeLessThanOrEqual(130);
    // Realised area: water tiles in the disc, sampled step 2 (x4). The old r 55..80 lake
    // tops out at ~20k tiles; a huge lake clears 25k even after its islands are cut out.
    const cx = RX + lake.x, cy = RY + lake.y;
    let water = 0;
    for (let y = Math.floor(cy - lake.r); y <= Math.ceil(cy + lake.r); y += 2)
      for (let x = Math.floor(cx - lake.r); x <= Math.ceil(cx + lake.r); x += 2) {
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > lake.r) continue;
        if (isWaterId(gen.tileAt(x, y))) water++;
      }
    expect(water * 4, `seed ${seed} huge-lake water area`).toBeGreaterThanOrEqual(25_000);
    expect(lake.islands.length).toBeGreaterThanOrEqual(1);
  });

  it.each(SEEDS)("seed %i: >= 1 island per huge lake, main island r 12..22 with a grass core", (seed) => {
    const { gen, lake } = greatLake(seed);
    expect(lake.islands.length).toBeGreaterThanOrEqual(1);
    const main = lake.islands[0]!;
    expect(main.r).toBeGreaterThanOrEqual(ISLAND_MAIN_MIN_RADIUS);
    expect(main.r).toBeLessThanOrEqual(ISLAND_MAIN_MAX_RADIUS);
    // Literal bounds too (the constants revert with the code): the main island is scaled
    // up to r 12..22, not the old r 6..12.
    expect(main.r).toBeGreaterThanOrEqual(12);
    expect(main.r).toBeLessThanOrEqual(22);
    for (const isl of lake.islands) {
      const cx = RX + Math.floor(isl.x), cy = RY + Math.floor(isl.y);
      const centre = gen.sampleAt(cx, cy);
      expect(centre.tile, `seed ${seed} island centre is grass`).toBe(3);
      expect(centre.height, `seed ${seed} island centre height 2 (climbable)`).toBe(2);
    }
  });

  it.each(SEEDS)("seed %i: the sited shore works — at least 40%% of the shore ring is dry land at >= 0", (seed) => {
    // The siting guarantee (ADR-534): a lake whose shore is a sub-0 basin gets no feeder and
    // no boat landing. The sited lake's shore ring (r+1..r+4) is at least 40% dry land >= 0
    // — the best candidate on the hardest seed (424242: 44%); the other seeds clear 50%.
    // 40% is plenty for two feeder corridors and an outflow (proven by the connectivity
    // tests below); the siting takes the best candidate when none reaches half.
    const { gen, lake } = greatLake(seed);
    const cx = RX + lake.x, cy = RY + lake.y;
    let good = 0, total = 0;
    for (let a = 0; a < 360; a += 6) {
      const th = (a * Math.PI) / 180;
      for (let d = lake.r + 1; d <= lake.r + 4; d += 2) {
        const x = Math.round(cx + Math.cos(th) * d), y = Math.round(cy + Math.sin(th) * d);
        total++;
        if (!isWaterId(gen.tileAt(x, y)) && gen.heightAt(x, y) >= 0) good++;
      }
    }
    expect(good / total, `seed ${seed} sited-shore fraction`).toBeGreaterThanOrEqual(0.4);
  });
});

describe("ADR-534 huge lakes: feeder / outflow connectivity", () => {
  it.each(SEEDS)("seed %i: every huge lake has >= 2 feeder rivers in and >= 1 outflow out", (seed) => {
    const { gen, lake } = greatLake(seed);
    const feeders = feedersInto(gen, lake);
    expect(feeders.length, `seed ${seed} feeders into the huge lake`).toBeGreaterThanOrEqual(2);
    const outs = outflowsOf(gen, lake);
    expect(outs.length, `seed ${seed} outflows out of the huge lake`).toBeGreaterThanOrEqual(1);
    // The outflow leaves the lake: its mouth is other water, not the lake itself.
    for (const o of outs) {
      expect(Math.hypot(o.end.x + 0.5 - (RX + lake.x), o.end.y + 0.5 - (RY + lake.y))).toBeGreaterThan(lake.r);
    }
  });

  it.each(SEEDS)("seed %i: a boat can sail from the lake into the outflow and down to its mouth", (seed) => {
    // The boat enters at the outflow's first tile (the shore outlet): it must be at most
    // BOAT_ENTERABLE_MOUTH_LEVEL (a boat climbs at most 3), and the channel descends
    // non-increasingly to still water — the boat sails DOWN to the sea, never uphill.
    const { gen, lake } = greatLake(seed);
    const outs = outflowsOf(gen, lake);
    expect(outs.length).toBeGreaterThanOrEqual(1);
    const enterable = outs.filter((o) => o.centreline[0]!.level <= BOAT_ENTERABLE_MOUTH_LEVEL);
    expect(enterable.length, `seed ${seed} boat-enterable outflows`).toBeGreaterThanOrEqual(1);
    for (const o of enterable) {
      for (let i = 1; i < o.centreline.length; i++) {
        expect(o.centreline[i]!.level, `seed ${seed} outflow levels never rise`).toBeLessThanOrEqual(o.centreline[i - 1]!.level);
      }
      expect(o.endKind).toBe("water");
    }
  });

  it.each(SEEDS)("seed %i: land still connects around the huge lake (region BFS >= 99%%)", (seed) => {
    // Region (1,0), the ADR-411/533 survey window and BFS (|dh| <= 3 between step-2
    // samples), start at the west edge: the huge lake and the sea must not sever the
    // region's land. A small lake-centred window is NOT the measure — the lake's steep
    // basin fragments a local BFS on |dh| <= 3 (98.5-98.9% in a 1024 window) while the
    // region's land is 99.1%+ connected around it.
    const gen = new ProceduralGenerator({ seed });
    const ox = REGION_SIZE, oy = 0;
    const x0 = ox - REGION_SIZE / 2, y0 = -REGION_SIZE / 2, x1 = ox + REGION_SIZE / 2, y1 = REGION_SIZE / 2;
    const step = 2;
    const nx = Math.floor((x1 - x0) / step) + 1, ny = Math.floor((y1 - y0) / step) + 1;
    const h = new Int16Array(nx * ny); const land = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = x0 + i * step, y = y0 + j * step;
      h[j * nx + i] = gen.heightAt(x, y);
      land[j * nx + i] = isWaterId(gen.tileAt(x, y)) ? 0 : 1;
    }
    let total = 0; for (let i = 0; i < land.length; i++) if (land[i]) total++;
    let si = Math.round((x0 + 8 - x0) / step), sj = Math.round((0 - y0) / step);
    si = Math.max(0, Math.min(nx - 1, si)); sj = Math.max(0, Math.min(ny - 1, sj));
    if (!land[sj * nx + si]) {
      outer: for (let r = 1; r < 20; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        const ii = si + di, jj = sj + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        if (land[jj * nx + ii]) { si = ii; sj = jj; break outer; }
      }
    }
    const seen = new Uint8Array(nx * ny); const q = new Int32Array(nx * ny);
    let qh = 0, qt = 0; q[qt++] = sj * nx + si; seen[sj * nx + si] = 1;
    let reach = 0;
    while (qh < qt) {
      const c = q[qh++]!; reach++;
      const px = c % nx, py = Math.floor(c / nx), ch = h[c]!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const a = px + dx, b = py + dy;
        if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const n = b * nx + a;
        if (seen[n] || !land[n]) continue;
        if (Math.abs(h[n]! - ch) > 3) continue;
        seen[n] = 1; q[qt++] = n;
      }
    }
    expect(reach / total, `seed ${seed} BFS around the huge lake`).toBeGreaterThanOrEqual(0.99);
  });
});
