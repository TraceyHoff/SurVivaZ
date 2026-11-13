import { describe, expect, test } from "vitest";
import { LoadCostBreakdown } from "../src/load-progress.js";

describe("LoadCostBreakdown sub-phases (ADR-380)", () => {
  test("sub-phases render in a bracket after the parent stage and never change the total", () => {
    const b = new LoadCostBreakdown();
    b.record("boot", 28506);
    b.recordSub("boot", "renderer", 120);
    b.recordSub("boot", "manifest", 340);
    b.recordSub("boot", "registry.fetch", 9200);
    b.recordSub("boot", "registry.upload", 2400);
    b.recordSub("boot", "warmup", 1506);
    b.record("world-ready", 3907);
    b.record("warmup-drain", 1628);
    expect(b.totalMs).toBe(34041);
    expect(b.format()).toBe(
      "load cost: boot 28506ms (84%) [renderer 120ms · manifest 340ms · registry.fetch 9200ms · registry.upload 2400ms · warmup 1506ms] · world-ready 3907ms (11%) · warmup-drain 1628ms (5%) · total 34041ms",
    );
  });

  test("a stage without sub-phases formats exactly as before (ADR-370 output unchanged)", () => {
    const b = new LoadCostBreakdown();
    b.record("boot", 4200);
    b.record("world-ready", 1800);
    b.record("warmup-drain", 600);
    expect(b.format()).toBe("load cost: boot 4200ms (64%) · world-ready 1800ms (27%) · warmup-drain 600ms (9%) · total 6600ms");
  });

  test("subs for an unknown stage and invalid subs are ignored", () => {
    const b = new LoadCostBreakdown();
    b.recordSub("boot", "manifest", 100); // no "boot" stage recorded yet
    b.record("boot", 1000);
    b.recordSub("boot", "", 100);
    b.recordSub("boot", "manifest", Number.NaN);
    b.recordSub("boot", "manifest", -5);
    b.recordSub("missing-stage", "x", 100);
    b.recordSub("boot", "manifest", 123.6);
    expect(b.format()).toBe("load cost: boot 1000ms (100%) [manifest 124ms] · total 1000ms");
  });

  test("sub-phases keep insertion order and coexist with notes", () => {
    const b = new LoadCostBreakdown();
    b.record("boot", 1000);
    b.recordSub("boot", "other", 50);
    b.note("boot warm-up: 22/26 first-view pages resident in 1506ms (timed out, 4 pending)");
    expect(b.format()).toBe("load cost: boot 1000ms (100%) [other 50ms] · total 1000ms; boot warm-up: 22/26 first-view pages resident in 1506ms (timed out, 4 pending)");
  });
});
