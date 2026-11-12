import { describe, expect, test } from "vitest";
import { LoadCostBreakdown } from "../src/load-progress.js";

describe("LoadCostBreakdown (ADR-370)", () => {
  test("empty breakdown says it was not measured yet", () => {
    const b = new LoadCostBreakdown();
    expect(b.totalMs).toBe(0);
    expect(b.format()).toBe("load cost: not measured yet");
  });

  test("records sequential phases in order with shares of the total", () => {
    const b = new LoadCostBreakdown();
    b.record("boot", 4200);
    b.record("world-ready", 1800);
    b.record("warmup-drain", 600);
    expect(b.totalMs).toBe(6600);
    expect(b.format()).toBe("load cost: boot 4200ms (64%) · world-ready 1800ms (27%) · warmup-drain 600ms (9%) · total 6600ms");
  });

  test("notes (warm-up sub-timings) append after the phases", () => {
    const b = new LoadCostBreakdown();
    b.record("boot", 1000);
    b.note("boot warm-up: 24/24 first-view pages resident in 900ms");
    b.note("2 first-view page(s) still pending after 1500ms");
    expect(b.format()).toBe("load cost: boot 1000ms (100%) · total 1000ms; boot warm-up: 24/24 first-view pages resident in 900ms; 2 first-view page(s) still pending after 1500ms");
  });

  test("ignores invalid records and notes", () => {
    const b = new LoadCostBreakdown();
    b.record("boot", Number.NaN);
    b.record("boot", -5);
    b.record("", 100);
    b.note("");
    expect(b.totalMs).toBe(0);
    expect(b.format()).toBe("load cost: not measured yet");
    b.record("boot", 123.6);
    expect(b.totalMs).toBe(124); // rounded
  });

  test("a single phase is 100% of its own total", () => {
    const b = new LoadCostBreakdown();
    b.record("boot", 50);
    expect(b.format()).toBe("load cost: boot 50ms (100%) · total 50ms");
  });
});
