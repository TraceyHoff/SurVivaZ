// ADR-534: small oceans — a cross-region sea. The biome sea widens designated ocean sectors
// (a coarse absolute-coordinate noise field, so a sector is continuous across region
// boundaries) to pure water. The sea is RARE (sector coverage < 10% per region) and stays
// clear of spawn: no ocean within Chebyshev 768 of the origin, so region zero's starter
// layout stays byte-identical. A sea counts as cross-region when one water component has
// >= 200 tiles on EACH side of a region boundary.
import { describe, expect, it } from "vitest";
import { ProceduralGenerator, REGION_SIZE, isWaterId } from "../src/index.js";

const SEEDS = [1, 42, 1234, 424242, 9001];

/** True when one OCEAN component has >= 200 tiles on each side of the boundary. BFS from a
 *  sea tile beside the boundary, early-exit once both sides reach 200 (the component is
 *  explored only as far as the proof needs). The BFS follows ocean-SECTOR tiles only
 *  (oceanSectorAt + realised water) — any-water would chain old rivers/lakes across a
 *  boundary and pass without a sea. `vertical` boundaries are x = `at` (side = x);
 *  horizontal ones are y = `at` (side = y). The along-boundary scan runs [lo, hi). */
function crossesBoundary(g: ProceduralGenerator, vertical: boolean, at: number, lo: number, hi: number): boolean {
  const isSea = (x: number, y: number): boolean => g.oceanSectorAt(x, y) && isWaterId(g.tileAt(x, y));
  let start: { x: number; y: number } | undefined;
  for (let t = lo; t < hi; t += 4) {
    const x = vertical ? at - 2 : t, y = vertical ? t : at - 2;
    if (isSea(x, y)) { start = { x, y }; break; }
  }
  if (!start) return false;
  const seen = new Set<string>([`${start.x},${start.y}`]);
  const q: { x: number; y: number }[] = [start];
  let left = 0, right = 0;
  const side = (x: number, y: number): number => (vertical ? (x < at ? 0 : 1) : (y < at ? 0 : 1));
  while (q.length) {
    const cur = q.shift()!;
    if (side(cur.x, cur.y) === 0) left++; else right++;
    if (left >= 200 && right >= 200) return true;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (seen.has(`${nx},${ny}`)) continue;
      seen.add(`${nx},${ny}`);
      if (isSea(nx, ny)) q.push({ x: nx, y: ny });
      if (seen.size > 20000) return left >= 200 && right >= 200;
    }
  }
  return left >= 200 && right >= 200;
}

// Region (1,0)'s four boundaries, plus region (1,1)'s south boundary (a sea sector is
// seeded — a seed whose (1,0) has no sector still has one nearby, e.g. 424242 at (1,1)).
const BOUNDARIES: { name: string; vertical: boolean; at: number; lo: number; hi: number }[] = [
  { name: "(1,0) west x=1536", vertical: true, at: 1536, lo: 0, hi: 1536 },
  { name: "(1,0) east x=3072", vertical: true, at: 3072, lo: 0, hi: 1536 },
  { name: "(1,0) north y=0", vertical: false, at: 0, lo: 1536, hi: 3072 },
  { name: "(1,0) south y=1536", vertical: false, at: 1536, lo: 1536, hi: 3072 },
  { name: "(1,1) south y=3072", vertical: false, at: 3072, lo: 1536, hi: 3072 },
];

describe("ADR-534 cross-region sea", () => {
  it.each(SEEDS)("seed %i: the sea crosses at least one region boundary (>= 200 tiles each side)", (seed) => {
    const g = new ProceduralGenerator({ seed });
    const crossed = BOUNDARIES.filter((b) => crossesBoundary(g, b.vertical, b.at, b.lo, b.hi));
    expect(crossed.length, `seed ${seed} crossed boundaries: ${crossed.map((b) => b.name).join(", ") || "none"}`).toBeGreaterThanOrEqual(1);
  });

  it("the sea is rare: ocean sector coverage < 10% of region (1,0) on every seed", () => {
    for (const seed of SEEDS) {
      const g = new ProceduralGenerator({ seed });
      let sectors = 0, total = 0;
      for (let y = 0; y < REGION_SIZE; y += 8)
        for (let x = REGION_SIZE; x < 2 * REGION_SIZE; x += 8) {
          total++;
          if (g.oceanSectorAt(x, y)) sectors++;
        }
      expect(sectors / total, `seed ${seed} ocean sector coverage`).toBeLessThan(0.10);
    }
  });

  it("region zero stays byte-identical: no great lake, no ocean within Chebyshev 768 of origin", () => {
    for (const seed of SEEDS) {
      const g = new ProceduralGenerator({ seed });
      expect(g.regionLayout(0, 0)!.greatLake).toBeUndefined();
      for (let y = -768; y <= 768; y += 64)
        for (let x = -768; x <= 768; x += 64) {
          expect(g.oceanSectorAt(x, y), `seed ${seed} ocean at (${x},${y})`).toBe(false);
        }
    }
  });
});
