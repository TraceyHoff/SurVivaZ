// @vitest-environment jsdom
import { describe, expect, test, vi, afterEach } from "vitest";
import { LoadCostBreakdown, serverLocationNote } from "../src/load-progress.js";
import { startDiag } from "../src/diag.js";

/**
 * ADR-543: the ?diag=1 surface the lag fixes depend on, rendered from a fixture world carrying
 * the phone's 2026-11-25 cold-start numbers (Mali-G68, ?diag=1 screenshot). The worker-vs-in-tab
 * line is the gap this slice closes: before it, the diag overlay only ever said `local server
 * running` (a lifecycle state), while worker-vs-in-tab lived in a console-only log the phone
 * screenshot cannot show.
 */

afterEach(() => {
  document.querySelector("#diag")?.remove();
  document.querySelector("#game-root")?.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

/** Load-cost breakdown built from the phone's cold-start numbers (boot 31,946 ms, total 35,935 ms). */
function phoneLoadCost(inWorker: boolean): string {
  const b = new LoadCostBreakdown();
  b.record("boot", 31946);
  for (const [name, ms] of [["renderer", 345], ["manifest", 5486], ["painted", 14217], ["registry.fetch", 4362],
    ["registry.fitBudget", 1112], ["registry.layout", 674], ["registry.upload", 1548], ["registry.tables", 609],
    ["registry.bodies", 1391], ["warmup", 1503], ["variants", 83], ["lighting", 177]] as const) b.recordSub("boot", name, ms);
  b.record("world-ready", 2219);
  b.record("warmup-drain", 1770);
  b.note("boot warm-up: 24/27 first-view pages resident in 1500ms (timed out, 3 pending)");
  b.note("world-entry warm-up: 0/1 first-view pages resident in 2134ms (timed out, 1 pending)");
  b.note("1 first-view page(s) still pending after 1770ms");
  b.note(serverLocationNote(inWorker));
  return b.format();
}

/** Fixture renderer carrying the phone's screenshot numbers (atlas/vram/phases/frame/renderer lines). */
function phoneRenderer(): unknown {
  return {
    capabilities: {
      renderer: "ANGLE (ARM, Mali-G68, OpenGL ES 3.2)", precision: { fragment: "highp", vertex: "highp" },
      lowEnd: false, mobile: true, flags: [], limits: { maxTextureSize: 4096, maxArrayLayers: 256, maxTextureUnits: 16 },
      textureBudgetMB: 256, fallbacks: [], problems: [],
    },
    atlas: { stats: { atlases: 835, layers: 24, layerSize: 2048, downscale: 0.5, gpuMB: 460, sprites: 6029 } },
    vram: { budgetMB: 256, residentMB: 165.3, streamedMB: 78.6, totalMB: 460, reservedMB: 294.7,
      pagesResident: 12, pageSlots: 71, pageIns: 23, evictions: 0, pending: 0, misses: 41, withinBudget: false },
    stats: { drawCalls: 17, sprites: 110, cpuMs: 5.0,
      phases: { prep: 0.4, sprites: 4.3, upload: 0.1, lightsPrep: 0, scene: 0, light: 0, bloom: 0, composite: 0, weather: 0 } },
    camera: { x: 0, y: 0, zoom: 0.934 },
    sceneDiag: { entities: 5, playerEid: 1, cameraTarget: undefined, localServer: "running", snapshots: 3 },
  };
}

function renderDiag(serverLocation: string | undefined, loadCost: string): string {
  window.history.replaceState(null, "", "/?diag=1");
  vi.useFakeTimers();
  const renderer = phoneRenderer();
  startDiag({
    renderer: () => renderer as never, entities: () => 5, tick: () => 120, player: () => ({}),
    loadCost: () => loadCost, serverLocation: () => serverLocation,
    snapshot: () => ({ received: true, latestTick: 120, snapshots: 3 }),
  });
  vi.advanceTimersByTime(500);
  return document.querySelector("#diag")?.textContent ?? "";
}

describe("serverLocationNote (ADR-543)", () => {
  test("worker, in-tab fallback, and forced ?worker=0 each read differently", () => {
    expect(serverLocationNote(true)).toBe("server: in Web Worker");
    expect(serverLocationNote(false)).toBe("server: in tab (worker unavailable or start timed out)");
    expect(serverLocationNote(false, true)).toBe("server: in tab (?worker=0)");
  });
});

describe("phone load-cost shape (ADR-543)", () => {
  test("boot bracket, world-ready, warm-up drain and the server note (phone numbers)", () => {
    const f = phoneLoadCost(true);
    expect(f).toContain("load cost: boot 31946ms (89%)");
    expect(f).toContain("painted 14217ms");
    expect(f).toContain("manifest 5486ms");
    expect(f).toContain("registry.fetch 4362ms");
    expect(f).toContain("world-ready 2219ms (6%)");
    expect(f).toContain("warmup-drain 1770ms (5%)");
    expect(f).toContain("total 35935ms");
    expect(f).toContain("boot warm-up: 24/27 first-view pages resident in 1500ms (timed out, 3 pending)");
    expect(f).toContain("world-entry warm-up: 0/1 first-view pages resident in 2134ms (timed out, 1 pending)");
    expect(f).toContain("1 first-view page(s) still pending after 1770ms");
    expect(f).toContain("server: in Web Worker");
  });
});

describe("?diag=1 overlay (ADR-543)", () => {
  test("renders the boot bracket, vram, phases, frame CPU, renderer and worker lines (phone fixture)", () => {
    const text = renderDiag("in Web Worker", phoneLoadCost(true));
    expect(text).toContain("gl ANGLE (ARM, Mali-G68, OpenGL ES 3.2)");
    expect(text).toContain("lowEnd=false mobile=true");
    expect(text).toContain("atlas 835 atl, 24 layers @2048px x0.5");
    expect(text).toContain("6029 sprites");
    expect(text).toContain("vram");
    expect(text).toContain("residentMB=165.3");
    expect(text).toContain("totalMB=460");
    expect(text).toContain("misses=41");
    expect(text).toContain("evictions=0");
    expect(text).toContain("pending=0");
    expect(text).toContain("withinBudget=false");
    expect(text).toContain("frame draws 17 sprites 110 cpu 5.0ms");
    expect(text).toContain("phases prep");
    expect(text).toContain("spr 4.3");
    expect(text).toContain("load cost: boot 31946ms (89%)");
    expect(text).toContain("painted 14217ms");
    expect(text).toContain("total 35935ms");
    expect(text).toContain("cam 0.0,0.0 z0.934");
    // The worker-vs-in-tab line itself — and it must not be confused with the lifecycle state line.
    expect(text).toContain("server in Web Worker");
    expect(text).toContain("server: in Web Worker");
    expect(text).toContain("local server running");
  });

  test("in-tab fallback reads as in-tab, not as a worker", () => {
    const text = renderDiag("in tab (worker unavailable or start timed out)", phoneLoadCost(false));
    expect(text).toContain("server in tab (worker unavailable or start timed out)");
    expect(text).toContain("server: in tab (worker unavailable or start timed out)");
    expect(text).not.toContain("server in Web Worker");
    expect(text).not.toContain("server: in Web Worker");
  });

  test("before singleplayer starts there is no worker/in-tab line (state line alone says nothing about location)", () => {
    const text = renderDiag(undefined, new LoadCostBreakdown().format());
    expect(text).toContain("local server running");
    expect(text).not.toContain("server in Web Worker");
    expect(text).not.toContain("server in tab");
  });

  test("the overlay refreshes on a 500 ms interval — diagnostics are read paths, not per-frame work", () => {
    window.history.replaceState(null, "", "/?diag=1");
    vi.useFakeTimers();
    const renderer = phoneRenderer();
    startDiag({
      renderer: () => renderer as never, entities: () => 5, tick: () => 120, player: () => ({}),
      loadCost: () => phoneLoadCost(true), serverLocation: () => "in Web Worker",
      snapshot: () => ({ received: true, latestTick: 120, snapshots: 3 }),
    });
    const el = document.querySelector("#diag");
    expect(el?.textContent).toBe("");
    vi.advanceTimersByTime(499);
    expect(el?.textContent).toBe("");
    vi.advanceTimersByTime(1);
    expect(el?.textContent).toContain("server in Web Worker");
  });
});
