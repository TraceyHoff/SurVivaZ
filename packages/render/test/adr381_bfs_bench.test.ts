/**
 * ADR-381 BFS micro-bench (standalone): cover.region + cutawayRegion on a 600-tile
 * roofed building, same start tile every call. PERF=1 only.
 * The end-of-run numbers in adr381_prepare_bench.test.ts scattered wildly across
 * runs (cover.region 0.29 / 1.35 / 0.61 ms across three runs of near-identical code),
 * so this file isolates the BFS cost: 500 warmup calls, then 5 timed batches of 2000.
 * Even isolated, the numbers are VM-noise dominated: a 4-variant diagnostic run
 * scored string+shift (pristine-style) SLOWEST and number+index-once fastest, the
 * reverse of the first isolated comparison — so no BFS speedup (or slowdown) is
 * claimable from these numbers. One robust lesson did survive: computing the tile
 * key once per neighbour beats twice (1.49 vs 2.76 ms/call in the diagnostic), so
 * cutawayRegion hoists it. Run on both the patched tree and pristine and compare
 * batch medians, not one batch — and treat even those as indicative only.
 */
import { describe, expect, it } from "vitest";
import { BuildingGrid, loadBuildPieces } from "@engine/world";
import { cutawayRegion } from "../src/sprites.js";
import { PieceCoverIndex } from "../src/building/modular.js";

const PERF = !!process.env.PERF;
const med = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;

describe.skipIf(!PERF)("ADR-381 BFS micro-bench", () => {
  it("600-tile flood-fill, 5 batches of 2000", () => {
    const cover = new PieceCoverIndex();
    for (let y = 0; y < 24; y++) for (let x = 0; x < 25; x++) { cover.add(x, y, 1, 1, 0, true, false); cover.add(x, y, 1, 1, 1, true, true); }
    const { registry } = loadBuildPieces([{ key: "floor", footprint: { w: 1, h: 1 }, layer: 0, hp: 1 }, { key: "roof", footprint: { w: 1, h: 1 }, layer: 3, hp: 1 }]);
    const g = new BuildingGrid(registry); const f = registry.byKey("floor").id, r = registry.byKey("roof").id;
    for (let y = 0; y < 24; y++) for (let x = 0; x < 25; x++) { g.place(f, x, y, 0); g.place(r, x, y, 1); }
    for (let i = 0; i < 500; i++) { cover.region(12, 12, 0); cutawayRegion(g, 12, 12, 0); }
    const coverBatches: number[] = [];
    const cutBatches: number[] = [];
    for (let b = 0; b < 5; b++) {
      const t0 = performance.now(); for (let i = 0; i < 2000; i++) cover.region(12, 12, 0); coverBatches.push((performance.now() - t0) / 2000);
      const t1 = performance.now(); for (let i = 0; i < 2000; i++) cutawayRegion(g, 12, 12, 0); cutBatches.push((performance.now() - t1) / 2000);
    }
    console.log(`[bench381-bfs] cover.region batches: ${coverBatches.map((x) => x.toFixed(4)).join(" ")} median ${med(coverBatches).toFixed(4)} ms/call`);
    console.log(`[bench381-bfs] cutawayRegion batches: ${cutBatches.map((x) => x.toFixed(4)).join(" ")} median ${med(cutBatches).toFixed(4)} ms/call`);
    expect(med(coverBatches)).toBeLessThan(50);
    expect(med(cutBatches)).toBeLessThan(50);
  }, 300_000);
});
