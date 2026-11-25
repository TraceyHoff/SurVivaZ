// ADR-532: canyons — navigability + flat-land budget on the new terrain.
// The canyons live in scaled regions, so the §3 invariants are asserted per region (flat
// ≥40%, BFS ≥99% of land, no canyon severs its region) as well as from spawn (flat ≥60%
// within 384, BFS ≥99% — the ADR-530/531 invariants, region zero has no canyons).
// Survey method: ADR-411/530/531 (±512 step 2 from spawn; one scaled region step 2).
import { describe, expect, it } from "vitest";
import { ProceduralGenerator, REGION_SIZE, computeSpawnPoints, canyonCentreAt } from "../src/index.js";

const SEEDS = [1, 42, 1234, 424242, 9001];

interface Survey { h: Int16Array; land: Uint8Array; nx: number; ny: number; x0: number; y0: number; step: number }

function survey(g: ProceduralGenerator, x0: number, y0: number, x1: number, y1: number, step: number): Survey {
  const nx = Math.floor((x1 - x0) / step) + 1, ny = Math.floor((y1 - y0) / step) + 1;
  const h = new Int16Array(nx * ny); const land = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = x0 + i * step, y = y0 + j * step;
    h[j * nx + i] = g.heightAt(x, y);
    const t = g.tileAt(x, y);
    land[j * nx + i] = t === 1 || t === 8 ? 0 : 1;
  }
  return { h, land, nx, ny, x0, y0, step };
}

function flatShare(g: ProceduralGenerator, s: Survey, pred: (x: number, y: number) => boolean): [number, number] {
  let flat = 0, total = 0;
  for (let j = 1; j < s.ny - 1; j++) for (let i = 1; i < s.nx - 1; i++) {
    const x = s.x0 + i * s.step, y = s.y0 + j * s.step;
    if (!pred(x, y) || !s.land[j * s.nx + i]) continue;
    total++;
    const h0 = s.h[j * s.nx + i]!;
    if (Math.abs(h0 - g.heightAt(x + 1, y)) <= 1 && Math.abs(h0 - g.heightAt(x - 1, y)) <= 1
      && Math.abs(h0 - g.heightAt(x, y + 1)) <= 1 && Math.abs(h0 - g.heightAt(x, y - 1)) <= 1) flat++;
  }
  return [flat, total];
}

/** BFS from (sx, sy) over the survey grid (steps of ≤3 levels); returns the reached set. */
function bfsSeen(s: Survey, sx: number, sy: number): { reach: number; total: number; seen: Uint8Array } {
  const { h, land, nx, ny } = s;
  let total = 0; for (let i = 0; i < land.length; i++) if (land[i]) total++;
  let si = Math.round((sx - s.x0) / s.step), sj = Math.round((sy - s.y0) / s.step);
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
    const cx = c % nx, cy = Math.floor(c / nx), ch = h[c]!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const a = cx + dx, b = cy + dy;
      if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
      const n = b * nx + a;
      if (seen[n] || !land[n]) continue;
      if (Math.abs(h[n]! - ch) > 3) continue;
      seen[n] = 1; q[qt++] = n;
    }
  }
  return { reach, total, seen };
}

/** Nearest land sample to (x, y) on the survey grid, within `rad` samples, or undefined. */
function nearestLand(s: Survey, x: number, y: number, rad: number): { i: number; j: number } | undefined {
  const ci = Math.round((x - s.x0) / s.step), cj = Math.round((y - s.y0) / s.step);
  for (let r = 0; r <= rad; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
    if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
    const i = ci + di, j = cj + dj;
    if (i < 0 || j < 0 || i >= s.nx || j >= s.ny) continue;
    if (s.land[j * s.nx + i]) return { i, j };
  }
  return undefined;
}

describe("ADR-532 navigability + flat budget", () => {
  it.each(SEEDS)("seed %i: region (1,0) flat >=40%% and BFS >=99%%, and no canyon severs the region", (seed) => {
    const g = new ProceduralGenerator({ seed });
    const ox = REGION_SIZE, oy = 0;
    const s = survey(g, ox - REGION_SIZE / 2, -REGION_SIZE / 2, ox + REGION_SIZE / 2, REGION_SIZE / 2, 2);
    const [flat, total] = flatShare(g, s, () => true);
    expect(flat / total, `seed ${seed} flat in region (1,0)`).toBeGreaterThanOrEqual(0.40);
    // BFS from the region's west edge: if a canyon split the region, the far side would
    // be unreachable (or reachable only around the region edge, which the survey's own
    // border cuts off — the start sits mid-edge so both directions are inside the grid).
    const { reach, total: landTotal, seen } = bfsSeen(s, ox - REGION_SIZE / 2 + 8, 0);
    expect(reach / landTotal, `seed ${seed} BFS in region (1,0)`).toBeGreaterThanOrEqual(0.99);
    // Crossing per canyon: land on both sides of the midpoint is in the reached set — the
    // walker gets across without detouring around the region edge (the termination / ford
    // / bridge guarantee, proven on the real field rather than on the record).
    let sides = 0;
    for (const c of g.canyonsInRegion(1, 0)) {
      const mid = canyonCentreAt(c, Math.round(c.length / 2));
      const px = -c.uy, py = c.ux;
      for (const sign of [1, -1]) {
        const sx = mid.x + sign * px * (c.wallReach + 15), sy = mid.y + sign * py * (c.wallReach + 15);
        const near = nearestLand(s, sx, sy, 8);
        expect(near, `seed ${seed} no land beside canyon midpoint (${sx | 0},${sy | 0})`).toBeDefined();
        expect(seen[near!.j * s.nx + near!.i], `seed ${seed} canyon side unreachable`).toBe(1);
        sides++;
      }
    }
    expect(sides, "at least one canyon side pair checked").toBeGreaterThan(0);
    console.log(`ADR-532 seed ${seed} region (1,0): flat=${(100 * flat / total).toFixed(1)}% bfs=${(100 * reach / landTotal).toFixed(2)}% sides=${sides}`);
  }, 300_000);

  it.each(SEEDS)("seed %i: flat >=60%% within 384 and BFS >=99%% from spawn", (seed) => {
    const g = new ProceduralGenerator({ seed });
    const s = survey(g, -512, -512, 512, 512, 2);
    const [f384, t384] = flatShare(g, s, (x, y) => Math.max(Math.abs(x), Math.abs(y)) <= 384);
    expect(f384 / t384, `seed ${seed} flat within 384`).toBeGreaterThanOrEqual(0.60);
    const spawn = computeSpawnPoints(g)[0]!;
    const { reach, total } = bfsSeen(s, spawn.x, spawn.y);
    expect(reach / total, `seed ${seed} BFS reachable`).toBeGreaterThanOrEqual(0.99);
    console.log(`ADR-532 seed ${seed}: flat384=${(100 * f384 / t384).toFixed(1)}% bfs=${(100 * reach / total).toFixed(2)}%`);
  }, 300_000);
});
