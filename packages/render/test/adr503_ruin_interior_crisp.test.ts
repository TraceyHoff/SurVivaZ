import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AtlasManager, isStreamedBuildingAtlas } from "../src/assets/atlasManager.js";

/**
 * ADR-503: things inside abandoned structures are blurry (WebGL2, phone budgets).
 *
 * Measured in the browser (real client IsoView, Galaxy A16 emulation: Mali GPU string, 2.625 DPR, ASTC, 256 MB atlas
 * budget): after the resident hot tier (7 RGBA8 layers at 0.5x) and the forced body/wear floors, the building-tier
 * (building_t1..t4: walls, floors, foundations, wall windows/doorways), rfx roof and stream (decor_furn_* / hearth_* /
 * decor_deco_* / decor_light_*: the rustic ruin furniture) pools each reach planPool with ZERO free layers. That branch
 * gave each one layer "at the smallest scale" = 0.25x, so a ruin interior — made almost entirely of those pages —
 * drew at 16 device px per texel while the player (body pool, 1x) and the nature core set (pinned 1x) stayed sharp.
 * One layer costs the same bytes at any scale; at 0.5x it still holds every tier page / the stream working set.
 *
 * Fix (planPool's no-budget branch): one layer at the LARGEST scale (<= 1x) whose layer still holds the pool's working
 * set (min(minSlots, pages)), the smallest scale only when nothing larger holds it. Same layer count, same VRAM.
 */
function am(budget: number): any {
  const gl = { canvas: undefined, getParameter: () => 4096, isContextLost: () => false, getError: () => 0 } as never;
  const a = new AtlasManager(gl, { registerLoader: () => {} } as never, { textureBudgetMB: budget }) as any;
  a.atlases = []; a.coldDownscale = 1; a.downscale = 1; a.sideShift = 2;
  a.layerSize = 2048; a.layers = 20; a.planLayers = 20; a.packedLayers = 20; a.pools = []; // no free layer left
  return a;
}
type Src = { key: string; residency?: string; columns: number; rows: number; frameW: number; frameH: number };
function atlases(): Map<string, Src> {
  const m = new Map<string, Src>();
  for (const p of ["../../assets/pack/manifest.json", "../../assets/pack/building/manifest.building.json", "../../../assets/manifest.json"]) {
    const j = JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")) as { atlases: Src[] };
    for (const a of j.atlases) if (!m.has(a.key)) m.set(a.key, a);
  }
  return m;
}
const page = (a: Src, pool: number) => ({ key: a.key, source: {}, count: 1, lazy: { w1: a.columns * a.frameW, h1: a.rows * a.frameH, state: 0, pool } });
const ALL = atlases();
/** The building-tier pages the bld pool streams (walls / floors / foundations / wall openings of every tier). */
const tierPages = () => [...ALL.values()].filter((a) => isStreamedBuildingAtlas(a.key, "x.png") && !/^rfx_/.test(a.key) && a.key !== "building_stairs").map((a) => page(a, 1));
const roofPages = () => [...ALL.values()].filter((a) => isStreamedBuildingAtlas(a.key, "x.png") && /^rfx_/.test(a.key)).map((a) => page(a, 2));
/** The rustic furniture / hearth / lamp / decor pages a ruin interior draws (stream residency). */
const RUIN_DECOR = /^(decor_furn_|decor_deco_|decor_light_|hearth_)/;
const decorPages = () => [...ALL.values()].filter((a) => a.residency === "stream" && RUIN_DECOR.test(a.key)).map((a) => page(a, 3));

describe("ADR-503: ruin interiors stay crisp when the pools are out of budget", () => {
  it("the real ruin pages: 4 building tiers (2016x2040 since ADR-504 84x120 cells, one per layer at 1x), rfx roofs, 19 rustic decor pages", () => {
    const t = tierPages(); expect(t.map((p) => p.key).sort()).toEqual(["building_t1", "building_t2", "building_t3", "building_t4", "building_t5"]); // ADR-593: powered tier page, same 24x17 grid
    for (const p of t) expect([p.lazy.w1, p.lazy.h1]).toEqual([2016, 2040]);
    expect(roofPages().length).toBeGreaterThanOrEqual(12);
    expect(decorPages().length).toBeGreaterThanOrEqual(19);
    for (const k of ["decor_furn_s", "decor_furn_w_1", "decor_furn_wt", "hearth_wt", "decor_deco_wt", "decor_light_t"]) expect(decorPages().some((p) => p.key === k), k).toBe(true);
    const a = am(256); expect(a.poolGeom(t, 1).perLayer).toBe(1); expect(a.poolGeom(t, 0.5).perLayer).toBe(4);
  });
  it("ADR-511: Art's per-tier stairs page streams with the buildings in its own one-page group, at 1x even when starved", () => {
    expect(isStreamedBuildingAtlas("building_stairs", "x.png")).toBe(true); expect(isStreamedBuildingAtlas("building_stairs", "blob:x")).toBe(false);
    const st = ALL.get("building_stairs")!; expect(st.residency).toBe("stream"); expect([st.columns * st.frameW, st.rows * st.frameH]).toEqual([1344, 480]);
    const a = am(256); a.planPool([page(st, 1)], 1, [], "bld", true);
    expect(a.pools[0].k).toBe(1); expect(a.pools[0].layers).toBe(1); expect(a.pools[0].lru.capacity).toBeGreaterThanOrEqual(1);
  });
  it("starved building-tier pool: every tier page at 0.5x in its one layer (was 0.25x: walls / floors / foundations)", () => {
    const a = am(256); a.planPool(tierPages(), 4, [], "bld", true);
    const p = a.pools[0]; expect(p.k).toBe(0.5); expect(p.layers).toBe(1); expect(p.lru.capacity).toBeGreaterThanOrEqual(4);
    expect(a.layers).toBe(21); // one layer, exactly as before: no extra VRAM
  });
  it("starved rfx roof pool: 0.5x holding its 4-page working set (was 0.25x)", () => {
    const a = am(256); a.planPool(roofPages(), 4, [], "bld", true);
    const p = a.pools[0]; expect(p.k).toBe(0.5); expect(p.layers).toBe(1); expect(p.lru.capacity).toBeGreaterThanOrEqual(4);
  });
  it("starved stream pool: the rustic furniture / hearth / lamp pages at 0.5x with the 12-slot working set (was 0.25x)", () => {
    const a = am(256); a.planPool(decorPages(), 12, [], "stream", true);
    const p = a.pools[0]; expect(p.k).toBe(0.5); expect(p.layers).toBe(1); expect(p.lru.capacity).toBeGreaterThanOrEqual(12);
  });
  it("same on the 128 MB budget (smaller phones)", () => {
    const a = am(128); a.planPool(tierPages(), 4, [], "bld", true); a.planPool(decorPages(), 12, [], "stream", true);
    expect(a.pools.map((p: any) => p.k)).toEqual([0.5, 0.5]); expect(a.layers).toBe(22);
  });
  it("a single-page working set takes 1x (the oversize door-swing pool)", () => {
    const a = am(256); a.planPool([page({ key: "door_swing_openings", columns: 1, rows: 1, frameW: 2048, frameH: 1792 }, 4)], 1, [], "stream", true);
    expect(a.pools[0].k).toBe(1); expect(a.pools[0].lru.capacity).toBe(1);
  });
  it("a working set only the smallest scale holds keeps the smallest scale (degraded extreme unchanged)", () => {
    const small = Array.from({ length: 64 }, (_, i) => page({ key: `p${i}`, columns: 1, rows: 1, frameW: 1024, frameH: 1024 }, 3));
    const a = am(256); a.planPool(small, 40, [], "stream", true);
    expect(a.pools[0].k).toBe(0.25); expect(a.pools[0].layers).toBe(1);
  });
  it("with free layers the planner is unchanged: building tiers at 1x", () => {
    const a = am(768); a.layers = 4; a.planLayers = 4; a.packedLayers = 4;
    a.planPool(tierPages(), 4, [], "bld", true);
    expect(a.pools[0].k).toBe(1); expect(a.pools[0].lru.capacity).toBe(4);
  });
});
