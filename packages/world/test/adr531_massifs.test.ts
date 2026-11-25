// ADR-531: mountains — massifs with shape variety + guaranteed slope sides.
// Per the prep §3/§4 (with §0 user decisions: ±100, new worlds only, large features rare,
// flat budget ≥60% near spawn / ≥40% per region, starter layout byte-identical).
// Survey method: ADR-411/530 (±512 step 2); regions are 1536-tile (REGION_SIZE).
import { describe, expect, it } from "vitest";
import { ProceduralGenerator, REGION_SIZE, computeSpawnPoints, massifBumpAt, type Massif } from "../src/index.js";

const SEEDS = [1, 42, 1234, 424242, 9001];
const REGIONS: readonly (readonly [number, number])[] = [[1, 0], [0, 1], [1, 1], [-1, -1], [2, 0]];

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

/** Nominal summit tile: the centre, except a volcano whose summit is its crater rim. */
export function peakTile(m: Massif): { x: number; y: number } {
  if (m.shape === "volcano") {
    const d = Math.round(0.22 * m.amp * m.wSlope);
    return { x: m.cx + Math.round(Math.cos(m.slopeDir) * d), y: m.cy + Math.round(Math.sin(m.slopeDir) * d) };
  }
  return { x: m.cx, y: m.cy };
}

function angDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

/**
 * A 1-level-step approach path from the base ring to the summit, inside the slope sector.
 * The natural field itself steps 2 levels on ~10% of wilderness tiles (measured ADR-531 probe),
 * so a straight ray cannot promise ≤1 steps — the path is a BFS that may jog around natural
 * noise bumps, confined to the slope wedge. Every step on the found path is ≤1 by construction.
 */
function slopePathExists(g: ProceduralGenerator, m: Massif): boolean {
  const peak = peakTile(m); const R = m.radius;
  // RB is the wedge radius: R + 8 for the base ring, +1 more so a start tile whose rounded
  // coordinates sit a fraction past R + 8 is still inside the wedge and its bounding box.
  const RB = R + 9;
  const half = m.slopeHalfWidth + 0.35;
  const pts = [{ x: m.cx, y: m.cy }];
  for (const a of [m.slopeDir - half, m.slopeDir + half, m.slopeDir])
    pts.push({ x: m.cx + Math.cos(a) * RB, y: m.cy + Math.sin(a) * RB });
  const x0 = Math.floor(Math.min(...pts.map((p) => p.x))), x1 = Math.ceil(Math.max(...pts.map((p) => p.x)));
  const y0 = Math.floor(Math.min(...pts.map((p) => p.y))), y1 = Math.ceil(Math.max(...pts.map((p) => p.y)));
  const w = x1 - x0 + 1, hgt = y1 - y0 + 1;
  const heights = new Int16Array(w * hgt); const known = new Uint8Array(w * hgt);
  const heightAtIdx = (idx: number): number => {
    if (known[idx]) return heights[idx]!;
    const x = x0 + (idx % w), y = y0 + Math.floor(idx / w);
    const v = g.heightAt(x, y); heights[idx] = v; known[idx] = 1; return v;
  };
  const inWedge = (x: number, y: number): boolean => {
    const dx = x - m.cx, dy = y - m.cy; const d = Math.hypot(dx, dy);
    if (d > RB) return false;
    if (d <= 4) return true;
    return angDiff(Math.atan2(dy, dx), m.slopeDir) <= half;
  };
  // Base-ring start: first land tile walking inward along the slope ray from outside the disc.
  let start: { x: number; y: number } | undefined;
  for (let r = R + 8; r >= 0; r--) {
    const x = Math.round(m.cx + Math.cos(m.slopeDir) * r), y = Math.round(m.cy + Math.sin(m.slopeDir) * r);
    const t = g.tileAt(x, y);
    if (t !== 1 && t !== 8) { start = { x, y }; break; }
  }
  if (!start || !inWedge(start.x, start.y)) return false;
  const sIdx = (start.y - y0) * w + (start.x - x0);
  const pIdx = (peak.y - y0) * w + (peak.x - x0);
  if (pIdx < 0 || pIdx >= w * hgt) return false;
  const seen = new Uint8Array(w * hgt); const q = new Int32Array(w * hgt);
  let qh = 0, qt = 0; q[qt++] = sIdx; seen[sIdx] = 1;
  while (qh < qt) {
    const c = q[qh++]!;
    if (c === pIdx) return true;
    const cx = x0 + (c % w), cy = y0 + Math.floor(c / w); const ch = heightAtIdx(c);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
      if (!inWedge(nx, ny)) continue;
      const n = (ny - y0) * w + (nx - x0);
      if (seen[n]) continue;
      if (Math.abs(heightAtIdx(n) - ch) > 1) continue;
      seen[n] = 1; q[qt++] = n;
    }
  }
  return false;
}

function allMassifs(seeds: readonly number[] = SEEDS): { seed: number; rx: number; ry: number; m: Massif }[] {
  const out: { seed: number; rx: number; ry: number; m: Massif }[] = [];
  for (const seed of seeds) {
    const g = new ProceduralGenerator({ seed });
    for (const [rx, ry] of REGIONS) for (const m of g.massifsInRegion(rx, ry)) out.push({ seed, rx, ry, m });
  }
  return out;
}

describe("ADR-531 massif layout", () => {
  it("region zero has no massifs; every scaled region has 1-3, outside 384 of origin, discs inside their region", () => {
    for (const seed of SEEDS) {
      const g = new ProceduralGenerator({ seed });
      expect(g.massifsInRegion(0, 0)).toEqual([]);
      for (const [rx, ry] of REGIONS) {
        const ms = g.massifsInRegion(rx, ry);
        expect(ms.length, `seed ${seed} region (${rx},${ry}) count`).toBeGreaterThanOrEqual(1);
        expect(ms.length, `seed ${seed} region (${rx},${ry}) count`).toBeLessThanOrEqual(3);
        for (const m of ms) {
          expect(Math.max(Math.abs(m.cx), Math.abs(m.cy)), `seed ${seed} massif near origin`).toBeGreaterThanOrEqual(384);
          const lx = m.cx - rx * REGION_SIZE, ly = m.cy - ry * REGION_SIZE;
          expect(Math.abs(lx) + m.radius, `seed ${seed} disc crosses region edge`).toBeLessThanOrEqual(REGION_SIZE / 2);
          expect(Math.abs(ly) + m.radius, `seed ${seed} disc crosses region edge`).toBeLessThanOrEqual(REGION_SIZE / 2);
          expect(["cone", "ridge", "mesa", "dome", "volcano"]).toContain(m.shape);
        }
      }
      // Deterministic: a second lookup returns the same layout.
      expect(g.massifsInRegion(1, 0)).toEqual(g.massifsInRegion(1, 0));
    }
  });

  it("peak-height distribution spans the range: foothills present, a massif >=80 exists, full-100 peaks are rare", () => {
    const all = allMassifs();
    expect(all.length).toBeGreaterThan(0);
    const shapes = new Set(all.map((e) => e.m.shape));
    expect(shapes.size, `shapes seen: ${[...shapes].join(",")}`).toBeGreaterThanOrEqual(3);
    const foothills = all.filter((e) => e.m.peak >= 30 && e.m.peak <= 65);
    expect(foothills.length, "foothill massifs (target peak 30-65)").toBeGreaterThan(0);
    let ge80 = 0, ge95 = 0, shortfall = 0;
    const summits: number[] = [];
    // Summits measured on the real height field, one generator per seed.
    const bySeed = new Map<number, ProceduralGenerator>();
    for (const { seed, m } of all) {
      let g = bySeed.get(seed); if (!g) bySeed.set(seed, (g = new ProceduralGenerator({ seed })));
      const p = peakTile(m); const summit = g.heightAt(p.x, p.y);
      summits.push(summit);
      if (summit >= 80) ge80++;
      if (summit >= 95) ge95++;
      if (summit < m.peak - 12) shortfall++;
    }
    console.log(`ADR-531 survey: ${all.length} massifs, summits min=${Math.min(...summits)} max=${Math.max(...summits)} >=80: ${ge80}, >=95: ${ge95}`);
    expect(ge80, "at least one massif summit >= 80").toBeGreaterThanOrEqual(1);
    expect(ge95, "full-100 peaks (summit >= 95) must be rare").toBeLessThanOrEqual(2);
    expect(shortfall, "summits far below their target peak").toBe(0);
  }, 120_000);

  it("every massif has a 1-level-step approach path from its base ring to its summit inside its slope sector", () => {
    const all = allMassifs();
    const bySeed = new Map<number, ProceduralGenerator>();
    let checked = 0;
    for (const { seed, m } of all) {
      let g = bySeed.get(seed); if (!g) bySeed.set(seed, (g = new ProceduralGenerator({ seed })));
      expect(slopePathExists(g, m), `seed ${seed} massif ${m.shape} at (${m.cx},${m.cy}) peak ${m.peak}: no <=1-step slope path`).toBe(true);
      checked++;
    }
    console.log(`ADR-531 slope paths checked: ${checked}`);
  }, 180_000);

  it("every massif has a saddle/pass to its nearest neighbour (the ridge dips between them)", () => {
    // Only CLOSE pairs owe a saddle: the prep's rule is "between adjacent massifs where they
    // are close" — two massifs separated by a lake or a wide lowland have no ridge between them
    // to dip (measured: a peak-32 mesa 474 tiles from its neighbour across a lake, whose
    // segment min is just its own flat top). Far massifs are crossed via their slope sectors
    // (proven by the slope-path test). Close = discs overlapping or nearly touching.
    let pairs = 0;
    for (const seed of SEEDS) {
      const g = new ProceduralGenerator({ seed });
      for (const [rx, ry] of REGIONS) {
        const ms = g.massifsInRegion(rx, ry);
        if (ms.length < 2) continue;
        for (const m of ms) {
          let best: Massif | undefined; let bestD = Infinity;
          for (const o of ms) {
            if (o === m) continue;
            const d = Math.hypot(o.cx - m.cx, o.cy - m.cy);
            if (d < bestD) { bestD = d; best = o; }
          }
          const o = best!;
          if (bestD > m.radius + o.radius + 40) continue; // not close — no ridge, no saddle owed
          const p1 = peakTile(m), p2 = peakTile(o);
          const h1 = g.heightAt(p1.x, p1.y), h2 = g.heightAt(p2.x, p2.y);
          const n = Math.max(Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
          let col = Infinity;
          for (let i = 0; i <= n; i++) {
            const x = Math.round(p1.x + ((p2.x - p1.x) * i) / n), y = Math.round(p1.y + ((p2.y - p1.y) * i) / n);
            if (g.tileAt(x, y) === 1 || g.tileAt(x, y) === 8) continue;
            col = Math.min(col, g.heightAt(x, y));
          }
          expect(col, `seed ${seed} saddle between (${m.cx},${m.cy}) and (${o.cx},${o.cy})`).toBeLessThanOrEqual(Math.min(h1, h2) - 5);
          pairs++;
        }
      }
    }
    expect(pairs, "at least one close pair must exist in the survey").toBeGreaterThan(0);
    console.log(`ADR-531 saddles checked: ${pairs}`);
  }, 180_000);

  it("the massif profile itself never steps more than 3 levels (no >3 wall from any massif)", () => {
    const all = allMassifs();
    let maxStep = 0;
    for (const { m } of all) {
      const R = Math.ceil(m.radius);
      for (let y = m.cy - R; y <= m.cy + R; y += 2) for (let x = m.cx - R; x <= m.cx + R; x += 2) {
        const b = massifBumpAt(m, x, y);
        for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
          const d = Math.abs(massifBumpAt(m, x + dx, y + dy) - b);
          if (d > maxStep) maxStep = d;
        }
      }
    }
    console.log(`ADR-531 max massif-profile step: ${maxStep}`);
    // The prep allows 2-3 level steps on non-slope faces ("climbable cliffs") but never a
    // continuous >3 wall; the profile's own worst step is the angular gradient where the
    // slope sector transitions to cliff faces. The BFS >=99% bar is the no-wall guarantee
    // on the real field.
    expect(maxStep).toBeLessThanOrEqual(3);
  });
});

describe("ADR-531 flat budget + navigability on the new terrain", () => {
  it.each(SEEDS)("seed %i: flat >=60% within 384 and BFS >=99% from spawn", (seed) => {
    const g = new ProceduralGenerator({ seed });
    const s = survey(g, -512, -512, 512, 512, 2);
    const [f384, t384] = flatShare(g, s, (x, y) => Math.max(Math.abs(x), Math.abs(y)) <= 384);
    expect(f384 / t384, `seed ${seed} flat within 384`).toBeGreaterThanOrEqual(0.60);
    const spawn = computeSpawnPoints(g)[0]!;
    const [reach, total] = bfsShare(s, spawn.x, spawn.y);
    expect(reach / total, `seed ${seed} BFS reachable`).toBeGreaterThanOrEqual(0.99);
    console.log(`ADR-531 seed ${seed}: flat384=${(100 * f384 / t384).toFixed(1)}% bfs=${(100 * reach / total).toFixed(2)}%`);
  }, 180_000);
});
