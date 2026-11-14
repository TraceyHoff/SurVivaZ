import { describe, it, expect } from "vitest";
import { AtlasManager } from "../src/assets/atlasManager.js";

describe("ADR-154 frame-table upload", () => {
  it("uploads only the patched rows, not the min..max span", () => {
    const calls: number[][] = [];
    const gl = { canvas: new EventTarget(), getParameter: () => 4096, isContextLost: () => false, getError: () => 0, NO_ERROR: 0, deleteTexture: () => {},
      bindTexture: () => {}, texSubImage2D: (_t: number, _l: number, _x: number, y: number, _w: number, h: number) => calls.push([y, h]) } as never;
    const am = new AtlasManager(gl, { registerLoader: () => {} } as never, { textureBudgetMB: 160 }) as any;
    am.frameTex = {}; am.table = new Float32Array(1024 * 8 * 100); am.tableRowDirty = new Uint8Array(100);
    am.markTable({ base: 2 * 1024, count: 10 }); am.markTable({ base: 90 * 1024, count: 2048 });
    am.beginFrame();
    expect(calls).toEqual([[2, 1], [90, 2]]);
    expect(am.tableRowUploads).toBe(3); expect(am.tableSpanRows).toBe(90);
    calls.length = 0; am.beginFrame(); expect(calls).toEqual([]);
  });
});

describe("ADR-154 page-in sync checks", () => {
  const gl = { canvas: new EventTarget(), getParameter: () => 4096, isContextLost: () => false, getError: () => 0, NO_ERROR: 0, deleteTexture: () => {} } as never;
  it("only small (mobile) budgets pay a glGetError per page-in", () => {
    expect((new AtlasManager(gl, { registerLoader: () => {} } as never, { textureBudgetMB: 160 }) as any).syncChecks).toBe(true);
    expect((new AtlasManager(gl, { registerLoader: () => {} } as never, { textureBudgetMB: 768 }) as any).syncChecks).toBe(false);
    // ADR-187: console budgets (256, ADR-407: consoles run at high) skip the per-page getError drain
    expect((new AtlasManager(gl, { registerLoader: () => {} } as never, { textureBudgetMB: 256 }) as any).syncChecks).toBe(false);
  });
});
