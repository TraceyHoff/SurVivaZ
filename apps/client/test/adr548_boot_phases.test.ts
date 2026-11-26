import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { LoadCostBreakdown, partitionPhase } from "../src/load-progress.js";
import { paintTask34Atlases } from "../src/task34-art.js";
import { paintTask256Atlases } from "../src/task256-art.js";
import { paintTask355Atlases } from "../src/task355-art.js";
import { paintTask361Atlases } from "../src/task361-art.js";
import { downsampleTask410Atlas, paintTask410Atlases } from "../src/task410-art.js";
import { paintTask420Atlases } from "../src/task420-art.js";
import { paintTask421Atlases, paintTask422Atlases, paintTask479Atlases } from "../src/task421-art.js";
import { paintTask540Atlases } from "../src/task540-art.js";
import { paintFootprintPixels, paintTrackPixels } from "../src/footprints-art.js";
import { paintRodPixels } from "../src/fishing-rod-art.js";

/**
 * ADR-548: the painted bracket is split into per-group phase() marks in view.ts (+ blob.size per
 * atlas), and the registry sub-splits surface through the same ?diag=1 + __survivazLoadCost()
 * path. IsoView.create itself needs a canvas + GL, so it cannot run in this VM — what runs here
 * is the real splitting helper (partitionPhase), the real wiring (asserted against view.ts /
 * main.ts source, the same pin this repo uses for wiring-only changes), the real LoadCostBreakdown
 * rendering, and the real pure painters timed per group (paint-only: PNG encode needs a canvas,
 * so the VM numbers are lower bounds — the phone split is what apportions paint vs encode).
 */

const GROUPS = ["task34", "task256", "task355", "task361", "task410", "task420", "task421", "task422", "task479", "task540", "footprint", "track", "rod"] as const;

describe("ADR-548 partitionPhase (painted split)", () => {
  it("one entry per painter group (+ icons) summing to the painted total, residual in painted.other", () => {
    const groups = [
      { name: "painted.task34", ms: 46 }, { name: "painted.task256", ms: 8 }, { name: "painted.task355", ms: 66 },
      { name: "painted.task361", ms: 926 }, { name: "painted.task410", ms: 482 }, { name: "painted.task420", ms: 9 },
      { name: "painted.task421", ms: 711 }, { name: "painted.task422", ms: 1867 }, { name: "painted.task479", ms: 404 },
      { name: "painted.task540", ms: 133 }, { name: "painted.footprint", ms: 1 }, { name: "painted.track", ms: 1 },
      { name: "painted.rod", ms: 1 }, { name: "painted.icons", ms: 31 },
    ];
    const total = groups.reduce((s, g) => s + g.ms, 0) + 12; // 12 ms between groups (paper-doll loop, watcher)
    const out = partitionPhase("painted", total, groups);
    expect(out.map((e) => e.name)).toEqual([...groups.map((g) => g.name), "painted.other"]);
    expect(out.reduce((s, e) => s + e.ms, 0)).toBe(total);
    expect(out.at(-1)).toEqual({ name: "painted.other", ms: 12, parent: "painted" });
    for (const e of out) expect(e.parent).toBe("painted"); // main.ts renders them, never double-counts
  });

  it("no groups: only the residual; a negative residual (rounding) is dropped, never negative", () => {
    expect(partitionPhase("painted", 5, [])).toEqual([{ name: "painted.other", ms: 5, parent: "painted" }]);
    // Groups rounded up by ~1 ms each can exceed the parent by a few ms — the split still stands,
    // the (negative) residual is just not shown.
    expect(partitionPhase("painted", 100, [{ name: "painted.a", ms: 60 }, { name: "painted.b", ms: 45 }]))
      .toEqual([{ name: "painted.a", ms: 60, parent: "painted" }, { name: "painted.b", ms: 45, parent: "painted" }]);
  });
});

describe("ADR-548 view.ts / main.ts wiring (source pins)", () => {
  const viewSrc = readFileSync(new URL("../src/view.ts", import.meta.url), "utf8");
  const mainSrc = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

  it("every painter group is timed through paintGroup (13 groups + icons), same start order — now under one Promise.all (ADR-551)", () => {
    const calls = [...viewSrc.matchAll(/paintGroup\("([a-z0-9]+)", \(\) => (\w+)AtlasSources\(\{\}, paintPool\)\)/g)].map((m) => [m[1], m[2]]);
    expect(calls.map(([g]) => g)).toEqual([...GROUPS]);
    expect(calls.map(([, fn]) => fn)).toEqual([
      "task34", "task256", "task355", "task361", "task410",
      "task420", "task421", "task422", "task479", "task540",
      "footprint", "track", "rod",
    ]);
    // ADR-551: the groups start together (one Promise.all) instead of one after another;
    // the pool is created before the phase and terminated once it closes.
    expect(viewSrc).toContain(`const paintPool = createPaintWorkerPool();`);
    expect(viewSrc.indexOf(`await Promise.all([`)).toBeLessThan(viewSrc.indexOf(`paintGroup("task34"`));
    expect(viewSrc).toContain(`paintPool?.terminate();`);
    expect(viewSrc).not.toContain(`await paintGroup("task34", task34AtlasSources);`);
    expect(viewSrc).toContain(`paintedGroups.push({ name: "painted.icons"`);
    expect(viewSrc).toContain(`partitionPhase("painted", phases[phases.length - 1]!.ms, paintedGroups)`);
    // blob.size per atlas: the blob: URLs the painters return are re-read for their size.
    expect(viewSrc).toContain(`paintedAtlasBytes.push({ key: k, bytes })`);
    expect(viewSrc).toContain(`view.paintedAtlasBytes = paintedAtlasBytes; view.registryNote = registryNote;`);
  });

  it("the registry sub-splits are mapped (new labels only — the old phase names are untouched)", () => {
    for (const label of ["registry.fetch.fetch", "registry.fetch.decode", "registry.fitBudget.search", "registry.fitBudget.resizes",
      "registry.upload.alloc", "registry.upload.copies", "registry.upload.mips"]) expect(viewSrc).toContain(label);
    for (const label of ["registry.fetch", "registry.fitBudget", "registry.halveSide", "registry.layout",
      "registry.upload", "registry.tables", "registry.bodies", "registry.restore"]) expect(viewSrc).toContain(`"${label}"`);
    expect(viewSrc).toContain("registry: ${vs?.coldAtlases ?? 0} cold atlases");
  });

  it("main.ts renders parent-marked entries but keeps them out of the 'other' residual", () => {
    expect(mainSrc).toContain("if (!p.parent) sub += p.ms;");
    expect(mainSrc).toContain("if (iso?.registryNote) loadCost.note(iso.registryNote);");
    expect(mainSrc).toContain("painted PNG: ${(total / 1048576).toFixed(1)} MB in ${iso.paintedAtlasBytes.length} atlases");
  });
});

describe("ADR-548 load-cost rendering with the new splits", () => {
  it("the per-group split renders inside the boot bracket and never changes the total", () => {
    const b = new LoadCostBreakdown();
    b.record("boot", 31946);
    for (const [name, ms] of [["renderer", 345], ["manifest", 5486], ["painted", 14217], ["painted.task422", 5800],
      ["painted.task361", 2900], ["registry.fetch", 4362], ["registry.fetch.fetch", 1200], ["registry.fetch.decode", 3162],
      ["registry.upload", 1548], ["registry.upload.alloc", 300], ["registry.upload.copies", 900], ["registry.upload.mips", 348],
      ["warmup", 1503]] as const) b.recordSub("boot", name, ms);
    b.note("registry: 116 cold atlases (42.3 MB) · 27 body pages");
    b.note("painted PNG: 3.1 MB in 43 atlases");
    expect(b.totalMs).toBe(31946);
    const f = b.format();
    expect(f).toContain("painted.task422 5800ms");
    expect(f).toContain("registry.fetch.fetch 1200ms");
    expect(f).toContain("registry.upload.mips 348ms");
    expect(f).toContain("registry: 116 cold atlases (42.3 MB) · 27 body pages");
    expect(f).toContain("painted PNG: 3.1 MB in 43 atlases");
  });
});

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };

describe("ADR-548 per-group painter timings (VM, paint-only — indicative only)", () => {
  it("times every painter group the boot split will show, 3 reps, median", () => {
    const time = (fn: () => unknown): number => { const ts: number[] = []; for (let i = 0; i < 3; i++) { const t0 = performance.now(); fn(); ts.push(performance.now() - t0); } return median(ts); };
    const groups: { name: string; ms: number; atlases: number }[] = [
      { name: "task34", ms: time(() => paintTask34Atlases()), atlases: paintTask34Atlases().length },
      { name: "task256", ms: time(() => paintTask256Atlases()), atlases: paintTask256Atlases().length },
      { name: "task355", ms: time(() => paintTask355Atlases()), atlases: paintTask355Atlases().length },
      { name: "task361", ms: time(() => paintTask361Atlases()), atlases: paintTask361Atlases().length },
      { name: "task410", ms: time(() => paintTask410Atlases().map((a) => downsampleTask410Atlas(a))), atlases: paintTask410Atlases().length },
      { name: "task420", ms: time(() => paintTask420Atlases()), atlases: paintTask420Atlases().length },
      { name: "task421", ms: time(() => paintTask421Atlases()), atlases: paintTask421Atlases().length },
      { name: "task422", ms: time(() => paintTask422Atlases()), atlases: paintTask422Atlases().length },
      { name: "task479", ms: time(() => paintTask479Atlases()), atlases: paintTask479Atlases().length },
      { name: "task540", ms: time(() => paintTask540Atlases()), atlases: paintTask540Atlases().length },
      { name: "footprint", ms: time(() => paintFootprintPixels()), atlases: 1 },
      { name: "track", ms: time(() => paintTrackPixels()), atlases: 1 },
      { name: "rod", ms: time(() => paintRodPixels()), atlases: 1 },
    ];
    const total = groups.reduce((s, g) => s + g.ms, 0);
    console.log(`[adr548] VM paint-only per-group (median of 3, no PNG encode — the phone split apportions paint vs encode):\n` +
      groups.map((g) => `  painted.${g.name} ${g.ms.toFixed(1)}ms (${g.atlases} atlases)`).join("\n") +
      `\n  painted total (VM paint-only) ${total.toFixed(1)}ms in ${groups.reduce((s, g) => s + g.atlases, 0)} atlases`);
    expect(groups.map((g) => g.name)).toEqual([...GROUPS]);
    for (const g of groups) { expect(g.ms).toBeGreaterThanOrEqual(0); expect(Number.isFinite(g.ms)).toBe(true); }
    // Concentration check (prep §1): boats + vehicles + sailboat dominate VM paint.
    const top = groups.filter((g) => ["task422", "task361", "task421", "task479"].includes(g.name)).reduce((s, g) => s + g.ms, 0);
    expect(top / total).toBeGreaterThan(0.5);
  }, 120000);
});
