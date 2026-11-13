import { describe, expect, it, vi } from "vitest";
import { Chunk, ChunkManager, ProceduralGenerator, chunkKey } from "../src/index.js";

/** ADR-379: the chunk-load budget is real — checked after every install (load + install, including the
 *  onLoad stamp hook) and predicted before starting the next chunk from the cost of the chunk just
 *  loaded. A chunk that starts always finishes; the budget only stops further chunks in the update. */

describe("ADR-379 chunk-load budget enforcement", () => {
  it("a site chunk (one chunk costing more than the whole budget) ends its update, and the next update still makes progress", () => {
    let clock = 0; const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      // First chunk is a site chunk (4.3 ms: terrain + stamp); the rest are plain (0.8 ms).
      let first = true;
      const cm = new ChunkManager({
        provider: { load(cx, cy) { clock += first ? 4.3 : 0.8; first = false; return { chunk: new Chunk(cx, cy), nodes: [] }; } },
        maxLoadsPerUpdate: 4, maxLoadTimeMs: 2,
      });
      cm.setSource({ id: 1, x: 0, y: 0 });
      cm.update();
      expect(cm.stats.loads).toBe(1); // the site chunk finished (never half-installed) and ended the update
      expect(cm.pendingLoads).toBe(24);
      cm.update();
      expect(cm.stats.loads).toBe(3); // progress resumes: two plain chunks fit the 2 ms budget
      expect(cm.pendingLoads).toBe(22);
    } finally { spy.mockRestore(); }
  });

  it("with no time budget configured, maxLoadsPerUpdate is the only cap (an expensive chunk does not lower it)", () => {
    // Deliberate: the site-chunk rule lives in the time budget (a site chunk's own cost ends its update via
    // the after-install check). Without a budget there is nothing to consume, and guessing "site chunk" from
    // cost misfires on JIT-warm-up chunks — so no cap rule applies here.
    let clock = 0; const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      let first = true;
      const cm = new ChunkManager({
        provider: { load(cx, cy) { clock += first ? 3 : 0.5; first = false; return { chunk: new Chunk(cx, cy), nodes: [] }; } },
        maxLoadsPerUpdate: 4, // no maxLoadTimeMs
      });
      cm.setSource({ id: 1, x: 0, y: 0 });
      cm.update();
      expect(cm.stats.loads).toBe(4);
      expect(cm.pendingLoads).toBe(21);
    } finally { spy.mockRestore(); }
  });

  it("plain-chunk updates stay near the budget: two 0.8 ms chunks fit, a third does not", () => {
    let clock = 0; const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const cm = new ChunkManager({
        provider: { load(cx, cy) { clock += 0.8; return { chunk: new Chunk(cx, cy), nodes: [] }; } },
        maxLoadsPerUpdate: 4, maxLoadTimeMs: 2,
      });
      cm.setSource({ id: 1, x: 0, y: 0 });
      for (let i = 0; i < 5; i++) { const before = cm.stats.loads; cm.update(); expect(cm.stats.loads - before).toBe(2); }
      expect(cm.stats.loads).toBe(10); expect(cm.pendingLoads).toBe(15);
    } finally { spy.mockRestore(); }
  });

  it("keeps FIFO order (the ADR-370 nearest-first revert stays reverted)", () => {
    let clock = 0; const spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const loaded: string[] = [];
      const cm = new ChunkManager({
        provider: { load(cx, cy) { clock += 0.1; return { chunk: new Chunk(cx, cy), nodes: [] }; } },
        loadRadius: 2, maxLoadsPerUpdate: 4, maxLoadTimeMs: 2,
      });
      cm.onLoad((c) => loaded.push(c.key));
      cm.setSource({ id: 1, x: 0, y: 0 });
      cm.update(); cm.update();
      // want is queued row-major (dy outer, dx inner) around the source; loads follow that order.
      const expected: string[] = [];
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) expected.push(chunkKey(dx, dy));
      expect(loaded).toEqual(expected.slice(0, 8));
    } finally { spy.mockRestore(); }
  });

  it("the boot drain still completes with the budget enforced (slower drain, no stuck boot)", () => {
    const cm = new ChunkManager({ provider: new ProceduralGenerator({ seed: 1234 }), loadRadius: 2, unloadMargin: 1, cacheSize: 64, maxLoadsPerUpdate: 4, maxLoadTimeMs: 2 });
    cm.setSource({ id: 1, x: 0, y: 0 });
    let guard = 0; let updates = 0;
    do { const before = cm.stats.loads; cm.update(); updates++; expect(cm.stats.loads - before).toBeLessThanOrEqual(4); } while (cm.pendingLoads && ++guard < 100);
    expect(cm.pendingLoads).toBe(0);
    expect(cm.activeKeys.size).toBe(25);
    expect(updates).toBeGreaterThan(6); // budget-bound: more updates than the old 4-per-update drain
  });
});
