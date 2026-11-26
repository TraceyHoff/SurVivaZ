import { describe, expect, it } from "vitest";
import { AtlasManager, CHAR_POOL_CLS, LOSSLESS_CHAR_MIN_MB, losslessCharPools } from "../src/assets/atlasManager.js";

/** ADR-220: characters looked right, then turned undressed / garbled / blotchy after an atlas rebuild (re-tier, zoom). */
function am(budget: number): any {
  const gl = { canvas: undefined, getParameter: () => 4096, isContextLost: () => false, getError: () => 0 } as never;
  const a = new AtlasManager(gl, { registerLoader: () => {} } as never, { textureBudgetMB: budget }) as any;
  a.atlases = []; a.coldDownscale = 1; a.downscale = 1; return a;
}
const pool = (cls: string, first: number) => ({ cls, first, layers: 1, k: 1, sw: 256, sh: 256, slotBytes: 256 * 256 * 4 * 2, lru: { has: () => false } });

describe("ADR-220: paper-doll art stays exact and stable", () => {
  it("character pools are lossless (PNG, RGBA8) on desktop / ultra-console budgets, never part of the ETC1S tail there", () => {
    expect([...CHAR_POOL_CLS].sort()).toEqual(["body", "wear"]);
    expect(LOSSLESS_CHAR_MIN_MB).toBe(448);
    expect(losslessCharPools(1024)).toBe(true); expect(losslessCharPools(768)).toBe(true); expect(losslessCharPools(448)).toBe(true);
    for (const b of [256, 160, 128]) expect(losslessCharPools(b)).toBe(false);
    const a = am(768); Object.defineProperty(a, "ktx2Target", { value: "astc" }); a.layers = 4;
    a.pools = [pool("body", 1), pool("wear", 2), pool("veh", 3)]; a.planOwn();
    expect(a.pools[0].own).toBeUndefined(); expect(a.pools[1].own).toBeUndefined(); // main RGBA8 array: exact source texels
    expect(a.pools[2].own.fmt).not.toBeNull(); // vehicles keep the compressed tail
  });
  it("low budgets keep the whole tail compressed (no VRAM regression on mobile / console 256)", () => {
    const a = am(160); Object.defineProperty(a, "ktx2Target", { value: "astc" }); a.layers = 4;
    a.pools = [pool("body", 1), pool("wear", 2), pool("veh", 3)]; a.planOwn();
    for (const p of a.pools) expect(p.own.fmt).not.toBeNull();
  });
  it("character pools are planned before the compressed tail (bodies, wear, then buildings/vehicles/stream)", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("../src/assets/atlasManager.ts", import.meta.url), "utf8");
    const at = (s: string) => src.indexOf(s);
    expect(at('groups.push({ cls: "body"')).toBeGreaterThan(0);
    expect(at('groups.push({ cls: "body"')).toBeLessThan(at('{ cls: "wear", lazy: wear'));
    expect(at('{ cls: "wear", lazy: wear')).toBeLessThan(at('groups.push({ cls: "bld"'));
    expect(at('groups.push({ cls: "bld"')).toBeLessThan(at('groups.push({ cls: "veh"'));
  });
  it("rebuild keeps the live layout (pools, entries) until the swap: no undressed / stale-frame window while planning", async () => {
    const a = am(128); const live = [pool("wear", 1)]; a.pools = live; const lv0 = a.layoutVersion; const gen0 = a.gen;
    let during: any = null;
    a.registry = {}; a.streamWearables = true; a.streamSheets = true; a.assets = { load: async () => ({}), release: () => {} };
    a.fitBudget = async () => { during = { pools: a.pools, lv: a.layoutVersion, gen: a.gen, planning: a.planningRebuild }; return { search: 0, resizes: 0 }; };
    a.pack = () => {}; a.planPool = () => {}; a.upload = () => ({ alloc: 0, copies: 0, mips: 0 }); a.uploadTints = () => {}; a.frameTintRows = () => new Map();
    a.limitProblem = () => null; a.resolveSway = a.resolveVariants = a.resolveRoofs = a.resolveHands = () => {};
    const reg = { atlases: new Map(), allSprites: () => [] };
    await a.rebuild(reg, new Map());
    expect(during.pools).toBe(live); expect(during.lv).toBe(lv0); expect(during.gen).toBe(gen0); expect(during.planning).toBe(true);
    expect(a.layoutVersion).toBe(lv0 + 1); expect(a.gen).toBe(gen0 + 1); expect(a.planningRebuild).toBe(false);
  });
});
