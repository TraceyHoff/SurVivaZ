// ADR-530: generated ground spans [-100, 100] (HEIGHT_MAX 26 -> 100, HEIGHT_MIN -100).
// The old formula (plateau x relief 2..8) topped out at 26 and, worse, its 8-level terrace
// faces are closed walls: the baseline BFS from spawn reaches only 42-60% of land (5 seeds).
// The new field fades the terraces out past the spawn disc (160) into a smooth signed field,
// so the whole survey window stays walkable. Survey method: ADR-411, +/-512 step 2.
import { describe, expect, it } from "vitest";
import { ProceduralGenerator, HEIGHT_MAX, HEIGHT_MIN, computeSpawnPoints, REGION_SIZE } from "../src/index.js";

const SEEDS = [1, 42, 1234, 424242, 9001];
const STEP = 2, EXTENT = 512;

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

/** Flat share over sampled land points: exact 1-tile 4-neighbour faces all <= 1. */
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

/** BFS over the sampled grid from (sx, sy): edges between sampled land neighbours with |dh| <= 3
 *  (down steps > 3 are fall-damage steps, so they do not count as a path down). Step-2 grid with
 *  the same connectivity semantics, per the prep's §3. */
function bfsShare(s: Survey, sx: number, sy: number): [number, number] {
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
  return [reach, total];
}

describe("ADR-530 height range", () => {
  it("HEIGHT_MAX is 100 and HEIGHT_MIN is -100", () => {
    expect(HEIGHT_MAX).toBe(100); expect(HEIGHT_MIN).toBe(-100);
  });

  it.each(SEEDS)("seed %i: 5-seed survey reaches near -100 and +100, stays in bounds, stays flat and walkable", (seed) => {
    const g = new ProceduralGenerator({ seed });
    const s = survey(g, -EXTENT, -EXTENT, EXTENT, EXTENT, STEP);
    let min = Infinity, max = -Infinity;
    for (const v of s.h) { expect(v).toBeGreaterThanOrEqual(HEIGHT_MIN); expect(v).toBeLessThanOrEqual(HEIGHT_MAX); if (v < min) min = v; if (v > max) max = v; }
    expect(min, `seed ${seed} min`).toBeLessThanOrEqual(-95);
    expect(max, `seed ${seed} max`).toBeGreaterThanOrEqual(95);
    const [f384, t384] = flatShare(g, s, (x, y) => Math.max(Math.abs(x), Math.abs(y)) <= 384);
    const flat384 = f384 / t384;
    expect(flat384, `seed ${seed} flat within 384`).toBeGreaterThanOrEqual(0.60);
    const spawn = computeSpawnPoints(g)[0]!;
    const [reach, total] = bfsShare(s, spawn.x, spawn.y);
    const bfs = reach / total;
    expect(bfs, `seed ${seed} BFS reachable from spawn`).toBeGreaterThanOrEqual(0.99);
    // Flat budget per region: ±256 windows around four far region centres (deep wilderness).
    for (const [rx, ry] of [[1, 0], [0, 1], [1, 1], [-1, -1]] as const) {
      const cx = rx * REGION_SIZE, cy = ry * REGION_SIZE;
      const w = survey(g, cx - 256, cy - 256, cx + 256, cy + 256, 4);
      const [f, t] = flatShare(g, w, () => true);
      expect(f / t, `seed ${seed} region (${rx},${ry}) flat`).toBeGreaterThanOrEqual(0.40);
    }
    console.log(`ADR-530 seed ${seed}: min=${min} max=${max} flat384=${(100 * flat384).toFixed(1)}% bfs=${(100 * bfs).toFixed(2)}%`);
  }, 180_000);

  it.each(SEEDS)("seed %i: spawn stays gentle with features on (faces <= 3 within 160)", (seed) => {
    const g = new ProceduralGenerator({ seed });
    for (const p of computeSpawnPoints(g)) for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
      const tx = Math.floor(p.x) + x, ty = Math.floor(p.y) + y, h = g.heightAt(tx, ty);
      expect(Math.abs(h - g.heightAt(tx + 1, ty))).toBeLessThanOrEqual(3);
      expect(Math.abs(h - g.heightAt(tx, ty + 1))).toBeLessThanOrEqual(3);
    }
    // The byte-identical inner zone, on the pure field (features off): heights within 160 stay
    // at the old gentle scale (<= 7). With features on, an elevated-lake bowl rim can raise a
    // tile to level+1 (8), so the bound is only meaningful on the pure field — as in ADR-411.
    const pure = new ProceduralGenerator({ seed, waterFeatures: false, elevatedLakes: false });
    for (let y = -160; y <= 160; y += 7) for (let x = -160; x <= 160; x += 7) {
      expect(pure.heightAt(x, y)).toBeLessThanOrEqual(7);
    }
  });

  it("region-zero starter layout is byte-identical (lake/pond/elevated lake/spillway pins)", () => {
    // Pins measured on the ADR-529 base. The starter river is hash-placed (lake/pond pins cover
    // it); the elevated lake siting and spillway walk read the height field, so these pins fail
    // if the new relief leaks inside the spawn disc.
    const pins: Record<number, { lake: [number, number, number]; pond: [number, number, number]; el: [number, number, number, number] | null; spill: number; spillFirst: [number, number] | null; spillLast: [number, number] | null }> = {
      1: { lake: [0.5, 72.5, 12], pond: [-51.5, 0.5, 4], el: [0.5, -103.5, 9, 6], spill: 20, spillFirst: [0, -114], spillLast: [-1, -118] },
      42: { lake: [0.5, 50.5, 17], pond: [43.5, 0.5, 3], el: [-86.5, 0.5, 8, 7], spill: 15, spillFirst: [-81, 6], spillLast: [-71, 10] },
      1234: { lake: [0.5, 81.5, 12], pond: [0.5, -70.5, 3], el: [-85.5, 0.5, 9, 7], spill: 0, spillFirst: null, spillLast: null },
      424242: { lake: [-51.5, 0.5, 13], pond: [0.5, -44.5, 4], el: [0.5, 101.5, 10, 7], spill: 27, spillFirst: [-8, 94], spillLast: [-24, 94] },
      9001: { lake: [71.5, 0.5, 17], pond: [-40.5, 0.5, 3], el: [0.5, -101.5, 7, 7], spill: 0, spillFirst: null, spillLast: null },
    };
    for (const [seed, pin] of Object.entries(pins)) {
      const g = new ProceduralGenerator({ seed: Number(seed) });
      const lay = g.regionLayout(0, 0)!;
      expect([lay.lake.x, lay.lake.y, lay.lake.r]).toEqual(pin.lake);
      expect([lay.pond.x, lay.pond.y, lay.pond.r]).toEqual(pin.pond);
      const el = lay.elevatedLake;
      if (pin.el === null) expect(el).toBeUndefined();
      else { expect(el).toBeDefined(); expect([el!.x, el!.y, el!.r, el!.level]).toEqual(pin.el); }
      expect(lay.spillway ? lay.spillway.tiles.length : 0).toBe(pin.spill);
      if (pin.spillFirst) {
        expect([lay.spillway!.tiles[0]!.x, lay.spillway!.tiles[0]!.y]).toEqual(pin.spillFirst);
        const last = lay.spillway!.tiles[lay.spillway!.tiles.length - 1]!;
        expect([last.x, last.y]).toEqual(pin.spillLast);
      }
    }
  });
});
