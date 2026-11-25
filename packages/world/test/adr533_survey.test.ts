// ADR-533 survey: the §3 invariants on the new terrain (flat budget, BFS navigability) plus
// river feature counts and chunk-gen timing, over 5 seeds (ADR-411 method). The rivers must
// not push the landforms half's thin margins under: flat >=60% within 384 of spawn, >=40%
// per region, BFS >=99%.
// Survey method: ADR-411/530/531/532 (±512 step 2 from spawn; one scaled region step 2).
import { describe, expect, it } from "vitest";
import { ProceduralGenerator, REGION_SIZE, computeSpawnPoints } from "../src/index.js";

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

function bfsSeen(s: Survey, sx: number, sy: number): { reach: number; total: number } {
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
  return { reach, total };
}

describe("ADR-533 survey", () => {
  it.each(SEEDS)("seed %i: region (1,0) flat >=40%% and BFS >=99%%, with a river network", (seed) => {
    const g = new ProceduralGenerator({ seed });
    const ox = REGION_SIZE, oy = 0;
    const s = survey(g, ox - REGION_SIZE / 2, -REGION_SIZE / 2, ox + REGION_SIZE / 2, REGION_SIZE / 2, 2);
    const [flat, total] = flatShare(g, s, () => true);
    expect(flat / total, `seed ${seed} flat in region (1,0)`).toBeGreaterThanOrEqual(0.40);
    const { reach, total: landTotal } = bfsSeen(s, ox - REGION_SIZE / 2 + 8, 0);
    expect(reach / landTotal, `seed ${seed} BFS in region (1,0)`).toBeGreaterThanOrEqual(0.99);
    const net = g.riversInRegion(1, 0);
    const waters = net.channels.filter((c) => c.endKind === "water").length;
    const conf = net.channels.filter((c) => c.endKind === "channel").length;
    const sinks = net.channels.filter((c) => c.endKind === "sink").length;
    const painted = net.tiles.size;
    console.log(`ADR-533 seed ${seed} region (1,0): flat=${(100 * flat / total).toFixed(1)}% bfs=${(100 * reach / landTotal).toFixed(2)}% channels=${net.channels.length} water=${waters} conf=${conf} sinks=${sinks} painted=${painted}`);
  }, 300_000);

  it.each(SEEDS)("seed %i: flat >=60%% within 384 and BFS >=99%% from spawn", (seed) => {
    const g = new ProceduralGenerator({ seed });
    const s = survey(g, -512, -512, 512, 512, 2);
    const [f384, t384] = flatShare(g, s, (x, y) => Math.max(Math.abs(x), Math.abs(y)) <= 384);
    expect(f384 / t384, `seed ${seed} flat within 384`).toBeGreaterThanOrEqual(0.60);
    const spawn = computeSpawnPoints(g)[0]!;
    const { reach, total } = bfsSeen(s, spawn.x, spawn.y);
    expect(reach / total, `seed ${seed} BFS reachable`).toBeGreaterThanOrEqual(0.99);
    console.log(`ADR-533 seed ${seed}: flat384=${(100 * f384 / t384).toFixed(1)}% bfs=${(100 * reach / total).toFixed(2)}%`);
  }, 300_000);

  it("chunk-gen timing: the river plan is once per region, not per chunk", () => {
    // Load 25 chunks spread across region (1,0): the first chunk pays the region plan
    // (massifs + canyons + rivers, ~0.3–0.5 s), the rest pay only their own tiles. The median
    // per-chunk time must stay close to the rivers:false baseline (the plan amortises over
    // the region's ~2,300 chunks), so travelling into a new region costs one hitch, not a
    // permanently slower world.
    const chunks: [number, number][] = [];
    // All inside region (1,0) (chunk x 48..95, y -24..23 at CHUNK_SIZE 32).
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) chunks.push([48 + i * 8, -16 + j * 8]);
    const timeLoads = (rivers: boolean): { first: number; median: number } => {
      // `rivers` is a literal `false` flag (off = rivers: false; on = the option omitted).
      const g = rivers ? new ProceduralGenerator({ seed: 42 }) : new ProceduralGenerator({ seed: 42, rivers: false });
      const times: number[] = [];
      for (const [cx, cy] of chunks) {
        const t0 = Date.now();
        g.load(cx, cy);
        times.push(Date.now() - t0);
      }
      const sorted = [...times].sort((a, b) => a - b);
      return { first: times[0]!, median: sorted[Math.floor(sorted.length / 2)]! };
    };
    const on = timeLoads(true);
    const off = timeLoads(false);
    console.log(`ADR-533 chunk-gen seed 42: rivers on first=${on.first}ms median=${on.median}ms; rivers off first=${off.first}ms median=${off.median}ms`);
    expect(on.median, "median chunk-gen with rivers").toBeLessThanOrEqual(Math.max(5, off.median * 2));
  }, 300_000);
});
