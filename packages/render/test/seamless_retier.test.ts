import { describe, it, expect } from "vitest";
import { AtlasManager } from "../src/assets/atlasManager.js";
import { QUALITY_TIERS } from "../src/quality.js";
import { SettleHold, SETTLE_HOLD_MS, atlasFootprint } from "../src/IsoRenderer.js";

/** Hiccup / player blink (Android Mali): governor tier steps changed camera.scale (dpr x resScale) -> atlas footprint ->
 *  needsRetier -> full atlas rebuild that dropped every resident wear/body/stream page (player undressed / invisible). */
function am(): any {
  const gl = { canvas: undefined, getParameter: () => 4096, isContextLost: () => false, getError: () => 0 } as never;
  const a = new AtlasManager(gl, { registerLoader: () => {} } as never, { textureBudgetMB: 128 }) as any;
  a.atlases = []; a.coldDownscale = 1; a.downscale = 1; return a;
}

describe("seamless quality tiers: no atlas re-tier from a governor step", () => {
  it("atlas footprint (hence wear scale) is the same on every quality tier", () => {
    for (const dpr of [1, 2, 2.625, 3.5]) {
      const ws = new Set<number>();
      for (const _t of QUALITY_TIERS) { const a = am(); a.setCharFootprint(atlasFootprint(1, dpr)); ws.add(a.wearScale()); }
      expect(ws.size).toBe(1);
    }
  });
  it("needsRetier: only when crisper art / more mip levels are needed, never for a smaller footprint (no oscillation)", () => {
    const a = am(); const own = { levels: 3 }; const pools = [{ cls: "wear", own, k: 1 }];
    a.tailPools = () => pools; a.wearPool = () => undefined;
    a.ownLevelsFor = () => 2; expect(a.needsRetier).toBe(false); // fewer levels needed: keep
    a.ownLevelsFor = () => 3; expect(a.needsRetier).toBe(false);
    a.ownLevelsFor = () => 4; expect(a.needsRetier).toBe(true); // zoomed out past the allocated range
    a.ownLevelsFor = () => 3; a.tailPools = () => []; const wp = { k: 1 }; a.wearPool = () => wp; a.poolScales = () => [0.25, 0.5, 1];
    a.setCharFootprint(0.3); expect(a.wearScale()).toBe(0.5); expect(a.needsRetier).toBe(false); // pool already crisper
    wp.k = 0.5; a.setCharFootprint(1); expect(a.needsRetier).toBe(true); // zoomed in: crisper wear needed
  });
  it("retier never fires repeatedly while the footprint just oscillates between tiers", async () => {
    const a = am(); const wp = { k: 1 }; a.tailPools = () => []; a.wearPool = () => wp; a.poolScales = () => [0.25, 0.5, 1];
    a.registry = {}; let rebuilds = 0; a.rebuild = async () => { rebuilds++; };
    for (let f = 0, i = 0; f < 20000; f += 600, i++) { a.setCharFootprint(i % 2 ? 0.3 : 0.9); await a.retier(f); }
    expect(rebuilds).toBe(0);
  });
});

describe("atlas rebuild holds the last frame instead of drawing missing art", () => {
  it("SettleHold: holds while settling, bounded by SETTLE_HOLD_MS, resets after", () => {
    const h = new SettleHold();
    expect(h.hold(false, 0)).toBe(false);
    expect(h.hold(true, 100)).toBe(true); expect(h.hold(true, 100 + SETTLE_HOLD_MS - 1)).toBe(true);
    expect(h.hold(true, 100 + SETTLE_HOLD_MS)).toBe(false);
    expect(h.hold(false, 5000)).toBe(false); expect(h.hold(true, 6000)).toBe(true);
  });
  it("rebuild restores pages that were resident before it (local player stays dressed) and clears settling", async () => {
    const a = am(); const pool = { cls: "wear", lru: { has: () => true, prioOf: () => 0 } };
    a.poolOfA = () => pool; a.poolOn = () => true;
    a.atlases = [{ key: "hair", lazy: { state: 2 } }, { key: "far", lazy: { state: 0 } }];
    const paged: string[] = []; let settlingDuringPageIn = false;
    a.pageIn = async (x: any) => { settlingDuringPageIn ||= a.settling; paged.push(x.key); x.lazy.state = 2; };
    // drive only the tail of rebuild: the residency restore runs after the swap
    const reg = { atlases: new Map([["hair", { key: "hair", id: 1, columns: 1, rows: 1, frameW: 8, frameH: 8, residency: "stream" }], ["far", { key: "far", id: 2, columns: 1, rows: 1, frameW: 8, frameH: 8, residency: "stream" }]]), allSprites: () => [] };
    a.streamWearables = true; a.streamSheets = true; a.assets = { load: async () => ({}), release: () => {} };
    a.fitBudget = async () => ({ search: 0, resizes: 0 }); a.pack = () => {}; a.planPool = () => {}; a.upload = () => ({ alloc: 0, copies: 0, mips: 0 }); a.uploadTints = () => {}; a.frameTintRows = () => new Map();
    a.limitProblem = () => null; a.resolveSway = a.resolveVariants = a.resolveRoofs = a.resolveHands = () => {}; a.gl.getError = () => 0;
    let err: unknown; try { await a.rebuild(reg, new Map([["hair", { url: "hair.png" }], ["far", { url: "far.png" }]])); } catch (e) { err = e; }
    expect(err).toBeUndefined(); expect(paged).toEqual(["hair"]); expect(settlingDuringPageIn).toBe(true);
    expect(a.settling).toBe(false);
  });
});
