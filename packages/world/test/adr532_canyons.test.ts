// ADR-532: canyons — carved channels with graded entries, exits, and crossings.
// Per the prep §3/§4 (with §0 user decisions: ±100, new worlds only, large features rare,
// flat budget ≥60% near spawn / ≥40% per region, starter layout byte-identical, canyon
// floors may go below sea level and carry rivers).
// Survey method: ADR-411/530/531 (5 seeds, scaled regions are 1536-tile).
import { describe, expect, it } from "vitest";
import { ProceduralGenerator, REGION_SIZE, HEIGHT_MIN, HEIGHT_MAX, canyonCentreAt, canyonFloorAt, type Canyon } from "../src/index.js";

const SEEDS = [1, 42, 1234, 424242, 9001];
const REGIONS: readonly (readonly [number, number])[] = [[1, 0], [0, 1], [1, 1], [-1, -1], [2, 0]];

interface CanyonHit { seed: number; rx: number; ry: number; c: Canyon }

function allCanyons(): CanyonHit[] {
  const out: CanyonHit[] = [];
  for (const seed of SEEDS) {
    const g = new ProceduralGenerator({ seed });
    for (const [rx, ry] of REGIONS) for (const c of g.canyonsInRegion(rx, ry)) out.push({ seed, rx, ry, c });
  }
  return out;
}

/** Perpendicular distance from (x, y) to a canyon's centreline curve (the generator's own
 *  math: projection t onto the axis, lateral offset minus the two-sine meander). */
function curveDistance(c: Canyon, x: number, y: number): { d: number; t: number } {
  const dx = x - c.sx, dy = y - c.sy;
  const t = dx * c.ux + dy * c.uy;
  const lat = -dx * c.uy + dy * c.ux;
  const meander = (tt: number): number =>
    c.amp1 * Math.sin((2 * Math.PI * tt) / c.lam1 + c.ph1) + c.amp2 * Math.sin((2 * Math.PI * tt) / c.lam2 + c.ph2);
  if (t < 0) {
    const p = canyonCentreAt(c, 0);
    return { d: Math.hypot(x - p.x, y - p.y), t: 0 };
  }
  if (t > c.length) {
    const p = canyonCentreAt(c, c.length);
    return { d: Math.hypot(x - p.x, y - p.y), t: c.length };
  }
  return { d: Math.abs(lat - meander(t)), t };
}
function bfsWalkable(g: ProceduralGenerator, from: { x: number; y: number }, to: { x: number; y: number }, rad: number): boolean {
  const x0 = Math.min(from.x, to.x) - rad, x1 = Math.max(from.x, to.x) + rad;
  const y0 = Math.min(from.y, to.y) - rad, y1 = Math.max(from.y, to.y) + rad;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const seen = new Uint8Array(w * h); const q = new Int32Array(w * h);
  const idx = (x: number, y: number) => (y - y0) * w + (x - x0);
  const s = idx(from.x, from.y), t = idx(to.x, to.y);
  let qh = 0, qt = 0; q[qt++] = s; seen[s] = 1;
  const H = new Map<number, number>();
  const heightAt = (x: number, y: number): number => {
    const k = idx(x, y); let v = H.get(k);
    if (v === undefined) { v = g.heightAt(x, y); H.set(k, v); }
    return v;
  };
  while (qh < qt) {
    const c = q[qh++]!;
    if (c === t) return true;
    const cx = x0 + (c % w), cy = y0 + Math.floor(c / w); const ch = heightAt(cx, cy);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
      const n = idx(nx, ny);
      if (seen[n]) continue;
      if (Math.abs(heightAt(nx, ny) - ch) > 3) continue;
      seen[n] = 1; q[qt++] = n;
    }
  }
  return false;
}

describe("ADR-532 canyon layout", () => {
  it("region zero has no canyons; every scaled region has 1-2, outside 384 of origin, footprints inside their region", () => {
    for (const seed of SEEDS) {
      const g = new ProceduralGenerator({ seed });
      expect(g.canyonsInRegion(0, 0)).toEqual([]);
      expect(new ProceduralGenerator({ seed, canyons: false }).canyonsInRegion(1, 0)).toEqual([]);
      for (const [rx, ry] of REGIONS) {
        const cs = g.canyonsInRegion(rx, ry);
        expect(cs.length, `seed ${seed} region (${rx},${ry}) count`).toBeGreaterThanOrEqual(1);
        expect(cs.length, `seed ${seed} region (${rx},${ry}) count`).toBeLessThanOrEqual(2);
        const ox = rx * REGION_SIZE, oy = ry * REGION_SIZE;
        for (const c of cs) {
          expect(c.length, `seed ${seed} length`).toBeGreaterThanOrEqual(200);
          expect(c.length, `seed ${seed} length`).toBeLessThanOrEqual(400);
          expect(c.length, `seed ${seed} length spans a region`).toBeLessThan(REGION_SIZE);
          expect(Number.isInteger(c.depth) && c.depth >= 12 && c.depth <= 100, `seed ${seed} depth ${c.depth}`).toBe(true);
          expect(["v", "slot"]).toContain(c.profile);
          expect(c.wallGrade, `seed ${seed} wall grade`).toBeLessThanOrEqual(1.6);
          expect(c.floorHalf, `seed ${seed} floor half-width`).toBe(c.profile === "v" ? 7 : 3);
          // The whole carve footprint stays inside its region (no cross-region lookup, no seam).
          expect(c.bbox.x0, `seed ${seed} bbox west`).toBeGreaterThanOrEqual(ox - REGION_SIZE / 2);
          expect(c.bbox.x1, `seed ${seed} bbox east`).toBeLessThanOrEqual(ox + REGION_SIZE / 2);
          expect(c.bbox.y0, `seed ${seed} bbox north`).toBeGreaterThanOrEqual(oy - REGION_SIZE / 2);
          expect(c.bbox.y1, `seed ${seed} bbox south`).toBeLessThanOrEqual(oy + REGION_SIZE / 2);
          // Never inside the spawn blend: no centreline point within 384 of the origin.
          for (let t = 0; t <= c.length; t += 8) {
            const p = canyonCentreAt(c, t);
            expect(Math.max(Math.abs(p.x), Math.abs(p.y)), `seed ${seed} canyon near origin`).toBeGreaterThanOrEqual(384);
          }
        }
      }
      // Deterministic: a second lookup returns the same layout.
      expect(g.canyonsInRegion(1, 0)).toEqual(g.canyonsInRegion(1, 0));
    }
  }, 120_000);

  it("depth/length stats: depths span 12..100, deep canyons (>=85) are rare, a >=60 canyon exists", () => {
    const all = allCanyons();
    expect(all.length).toBeGreaterThan(0);
    const depths = all.map((e) => e.c.depth);
    const deep = depths.filter((d) => d >= 85).length;
    const mid = depths.filter((d) => d >= 60).length;
    console.log(`ADR-532 survey: ${all.length} canyons, depths min=${Math.min(...depths)} max=${Math.max(...depths)} >=60: ${mid}, >=85: ${deep}`);
    expect(deep, "full-depth (>=85) canyons must be rare").toBeLessThanOrEqual(Math.max(2, Math.ceil(all.length * 0.2)));
    expect(mid, "at least one deep (>=60) canyon in the survey").toBeGreaterThanOrEqual(1);
    // Realised depth: the rim beside the midpoint stands at least 10 above the floor.
    const bySeed = new Map<number, ProceduralGenerator>();
    for (const { seed, c } of all) {
      let g = bySeed.get(seed); if (!g) bySeed.set(seed, (g = new ProceduralGenerator({ seed })));
      const mid = Math.round(c.length / 2);
      const p = canyonCentreAt(c, mid);
      let rimMax = -Infinity;
      for (let d = -(c.floorHalf + c.wallReach + 10); d <= c.floorHalf + c.wallReach + 10; d++) {
        const h = g.heightAt(Math.round(p.x - c.uy * d), Math.round(p.y + c.ux * d));
        if (h > rimMax) rimMax = h;
      }
      const floorMid = canyonFloorAt(c, mid);
      expect(floorMid, `seed ${seed} floor within bounds`).toBeGreaterThanOrEqual(HEIGHT_MIN);
      expect(floorMid, `seed ${seed} floor within bounds`).toBeLessThanOrEqual(HEIGHT_MAX);
      expect(rimMax - floorMid, `seed ${seed} realised depth at midpoint`).toBeGreaterThanOrEqual(10);
    }
  }, 180_000);

  it("the design floor grades <=1/tile along its whole length and is anchored at both rims (termination)", () => {
    const all = allCanyons();
    let maxStep = 0;
    for (const { c } of all) {
      for (let t = 1; t <= c.length; t++) {
        const s = Math.abs(canyonFloorAt(c, t) - canyonFloorAt(c, t - 1));
        if (s > maxStep) maxStep = s;
        expect(s, `floor step at t=${t}`).toBeLessThanOrEqual(1);
      }
      // Termination: the floor meets the rim at both ends (depth envelope is 0 there), so
      // the canyon peters out instead of ending in a wall — that is its crossing.
      expect(canyonFloorAt(c, 0), "floor(0) = rim at the entry end").toBe(c.floorStart);
      expect(canyonFloorAt(c, c.length), "floor(L) = rim at the exit end").toBe(c.floorEnd);
    }
    console.log(`ADR-532 max design floor step: ${maxStep}`);
  }, 120_000);

  it("the realised floor is walkable end-to-end (centreline steps <=3) and has a graded entry AND exit per canyon", () => {
    const all = allCanyons();
    const bySeed = new Map<number, ProceduralGenerator>();
    const freeBySeed = new Map<number, ProceduralGenerator>();
    let maxReal = 0, maxMouth = 0, preExisting = 0;
    for (const { seed, c } of all) {
      let g = bySeed.get(seed); if (!g) bySeed.set(seed, (g = new ProceduralGenerator({ seed })));
      let free = freeBySeed.get(seed); if (!free) freeBySeed.set(seed, (free = new ProceduralGenerator({ seed, canyons: false })));
      // Realised centreline walk: min(ground, floor) — where the ground dips below the
      // floor the walk follows the dip at the natural gradient (<=3); a straight-line sample
      // can straddle a bench edge diagonally, so the bound is walkability (3), not the
      // design grade (1, asserted on canyonFloorAt above). A step over 3 is allowed only
      // when the canyon-free field steps over 3 at the same tiles (a natural bench edge the
      // canyon did not create — measured on seed 1234, where the floor walk steps 4 exactly
      // where the control field steps 4).
      let prev: { x: number; y: number; h: number } | undefined;
      for (let t = 0; t <= c.length; t++) {
        const p = canyonCentreAt(c, t);
        const pt = { x: Math.round(p.x), y: Math.round(p.y), h: g.heightAt(Math.round(p.x), Math.round(p.y)) };
        if (prev !== undefined) {
          const s = Math.abs(pt.h - prev.h);
          if (s > maxReal) maxReal = s;
          if (s > 3) {
            const fs = Math.abs(free.heightAt(pt.x, pt.y) - free.heightAt(prev.x, prev.y));
            if (fs > 3) preExisting++;
            else expect(s, `seed ${seed} floor walk step at t=${t} (canyon-created)`).toBeLessThanOrEqual(3);
          }
        }
        prev = pt;
      }
      // Graded entry and exit: a <=3-step path exists from the rim outside each end to the
      // floor just inside it (a BFS that may jog around natural noise, not a straight ray).
      const start = canyonCentreAt(c, 0), end = canyonCentreAt(c, c.length);
      const rimIn = { x: Math.round(start.x - c.ux * 30), y: Math.round(start.y - c.uy * 30) };
      const floorIn = { x: Math.round(canyonCentreAt(c, 12).x), y: Math.round(canyonCentreAt(c, 12).y) };
      const floorOut = { x: Math.round(canyonCentreAt(c, c.length - 12).x), y: Math.round(canyonCentreAt(c, c.length - 12).y) };
      const rimOut = { x: Math.round(end.x + c.ux * 30), y: Math.round(end.y + c.uy * 30) };
      expect(bfsWalkable(g, rimIn, floorIn, 45), `seed ${seed} no graded entry`).toBe(true);
      expect(bfsWalkable(g, floorOut, rimOut, 45), `seed ${seed} no graded exit`).toBe(true);
      // The mouth itself has no cliff: the walk in from 20 tiles out never steps >3 on the
      // straight centreline either (a bench edge on the approach can add a diagonal 4 — the
      // BFS above is the binding check, so this only logs the worst straight step).
      for (const [a, b] of [[-20, 20], [c.length - 20, c.length + 20]] as const) {
        let p2: number | undefined;
        for (let t = a; t <= b; t++) {
          const p = canyonCentreAt(c, t);
          const h = g.heightAt(Math.round(p.x), Math.round(p.y));
          if (p2 !== undefined) maxMouth = Math.max(maxMouth, Math.abs(h - p2));
          p2 = h;
        }
      }
    }
    console.log(`ADR-532 max realised floor step: ${maxReal} (design floor: 1; ${preExisting} steps over 3 pre-exist in the canyon-free field), max straight mouth step: ${maxMouth} (BFS entry/exit is the binding check)`);
  }, 300_000);

  it("floors below sea level hold water (never dry land below 0 on a canyon floor)", () => {
    const all = allCanyons();
    const gens = new Map<number, ProceduralGenerator>();
    let subZero = 0, waterTiles = 0, checked = 0, designBelow = 0;
    for (const { seed, c } of all) {
      let g = gens.get(seed); if (!g) gens.set(seed, (g = new ProceduralGenerator({ seed })));
      let minFloor = Infinity;
      for (let t = 0; t <= c.length; t++) minFloor = Math.min(minFloor, canyonFloorAt(c, t));
      if (minFloor < 0) designBelow++;
      for (let t = 0; t <= c.length; t += 4) {
        const p = canyonCentreAt(c, t);
        for (let off = -c.floorHalf; off <= c.floorHalf; off += 2) {
          const x = Math.round(p.x - c.uy * off), y = Math.round(p.y + c.ux * off);
          const h = g.heightAt(x, y);
          // The floor is defined by curve distance, not by the axis-perpendicular offset
          // the sample walks (the meander tilts the two by up to ~1 tile): only assert
          // water where the tile is truly on the floor (d <= floorHalf) or the wall profile
          // itself is below 0 (a submerged bank) — the implementation's rule, mirrored here.
          // A wall tile whose NATURAL ground dips a level below 0 (profile >= 0) keeps the
          // engine's pre-existing dry-below-0 behaviour, which is out of this slice's scope.
          const { d, t: tt } = curveDistance(c, x, y);
          const floor = canyonFloorAt(c, tt);
          const profile = d <= c.floorHalf ? floor : floor + c.wallGrade * (d - c.floorHalf);
          checked++;
          if (h < 0 && (d <= c.floorHalf || profile < 0)) {
            subZero++;
            // 1 = water, 8 = shallow water (the ADR-249 shore cover on a biome-water tile):
            // both are water at surface 0, never dry land below sea level.
            expect([1, 8], `seed ${seed} dry land below sea level on a canyon floor at (${x},${y}) h=${h} tile=${g.tileAt(x, y)}`).toContain(g.tileAt(x, y));
            waterTiles++;
          }
        }
      }
    }
    console.log(`ADR-532 sub-sea-level floor tiles checked: ${checked}, below 0: ${subZero}, all water: ${waterTiles}; canyons with a below-0 design floor: ${designBelow}/${all.length}`);
    expect(designBelow, "at least one canyon floor dips below sea level in the survey (water-filled)").toBeGreaterThan(0);
  }, 180_000);

  it("the canyon adds no >3-level 4-neighbour step: every >3 step in the canyon field pre-exists in the canyon-free field", () => {
    // The wall's own gradient (<=1.6) plus the meander drift caps the profile step at ~2.7
    // before flooring, so a >3 step beside a canyon can only be a natural bench/field step
    // the canyon did not create. The control generator (canyons: false) is the same world
    // without the carve — a step that is >3 there too is pre-existing, not a canyon wall.
    const bySeed = new Map<number, ProceduralGenerator>();
    const freeBySeed = new Map<number, ProceduralGenerator>();
    let checked = 0, preExisting = 0;
    for (const { seed, c } of allCanyons()) {
      let g = bySeed.get(seed); if (!g) bySeed.set(seed, (g = new ProceduralGenerator({ seed })));
      let free = freeBySeed.get(seed); if (!free) freeBySeed.set(seed, (free = new ProceduralGenerator({ seed, canyons: false })));
      for (const frac of [0.25, 0.5, 0.75]) {
        const t = Math.round(c.length * frac);
        const p = canyonCentreAt(c, t);
        const R = c.wallReach + 12;
        const x0 = Math.floor(p.x - R), x1 = Math.ceil(p.x + R);
        const y0 = Math.floor(p.y - R), y1 = Math.ceil(p.y + R);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
            const hc1 = g.heightAt(x, y), hc2 = g.heightAt(x + dx, y + dy);
            if (Math.abs(hc2 - hc1) <= 3) continue;
            checked++;
            const hf1 = free.heightAt(x, y), hf2 = free.heightAt(x + dx, y + dy);
            if (Math.abs(hf2 - hf1) > 3) { preExisting++; continue; }
            expect(
              Math.abs(hc2 - hc1),
              `seed ${seed} canyon ADDED a >3 step at (${x},${y})->(${x + dx},${y + dy}): canyon ${hc1}->${hc2}, free ${hf1}->${hf2}`,
            ).toBeLessThanOrEqual(3);
          }
        }
      }
    }
    console.log(`ADR-532 wall-step comparison: ${checked} >3 steps in canyon fields, ${preExisting} pre-existing in the canyon-free field, 0 added`);
  }, 300_000);
});
