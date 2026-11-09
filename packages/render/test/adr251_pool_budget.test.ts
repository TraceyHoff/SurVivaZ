import { describe, expect, it } from "vitest";
import { AtlasManager, STREAM_FLOOR_SLOTS, VISIBLE_PIN_RE, WEAR_BUDGET_SHARE, WEAR_FLOOR_SLOTS } from "../src/assets/atlasManager.js";

/** ADR-251: pool rebalancing (furniture / vehicles / ground stay full res inside the VRAM budget) + slot bleed. */
function am(budget: number): any {
  const gl = { canvas: undefined, getParameter: () => 4096, isContextLost: () => false, getError: () => 0 } as never;
  const a = new AtlasManager(gl, { registerLoader: () => {} } as never, { textureBudgetMB: budget }) as any;
  a.atlases = []; a.coldDownscale = 1; a.downscale = 1; a.layerSize = 2048; a.layers = 4; a.planLayers = 4; a.packedLayers = 4; a.pools = [];
  return a;
}
const page = (key: string, w: number, h: number, pool = 1) => ({ key, source: {}, count: 1, lazy: { w1: w, h1: h, state: 0, pool } });
const mb = (a: any) => {
  const per = a.layerBytes([]), pper = a.poolLayerBytes([]);
  return (a.layers - a.pools.reduce((t: number, p: any) => t + p.layers, 0)) * per / 1048576
    + a.pools.reduce((t: number, p: any) => t + p.layers * (p.cls === "wear" || p.cls === "body" ? per : pper), 0) / 1048576;
};

describe("ADR-251: atlas pool rebalancing", () => {
  it("furniture and ground-tile atlases are pinned at full res (fitBudget), creature/ui atlases are not", () => {
    for (const k of ["furniture", "furniture_beds", "gt_summer_p0", "gt_winter_p1"]) expect(VISIBLE_PIN_RE.test(k)).toBe(true);
    for (const k of ["furniturex", "zombies", "ui_icons", "decor"]) expect(VISIBLE_PIN_RE.test(k)).toBe(false);
  });
  it("a 1024 power-of-two page tiles a 2048 layer 2x2 (no gap); odd sizes keep the POOL_GAP gutter", () => {
    const a = am(1024);
    expect(a.poolGeom([page("s", 1024, 1024)], 1).perLayer).toBe(4);
    expect(a.poolGeom([page("s", 1020, 1020)], 1).perLayer).toBe(4);
    expect(a.poolGeom([page("s", 1000, 600)], 1).pw).toBeGreaterThan(1000);
  });
  for (const budget of [1024, 448]) it(`wear is capped at ${WEAR_BUDGET_SHARE * 100}% of a ${budget} MB budget and leaves room for the visible pools`, () => {
    const a = am(budget);
    const wear = Array.from({ length: 400 }, (_, i) => page("cz_w" + i, 1024, 1024, 3));
    const hold = a.poolReserveBytes([page("veh_a", 2048, 2048, 1)], 4, [], 1);
    a.planPool(wear, 200, [], "wear", false, 1, hold);
    const w = a.pools[0]; expect(w.k).toBe(1);
    expect(w.lru.capacity).toBeGreaterThanOrEqual(WEAR_FLOOR_SLOTS);
    expect(w.layers * a.layerBytes([]) / 1048576).toBeLessThanOrEqual(budget * WEAR_BUDGET_SHARE + a.layerBytes([]) / 1048576);
    a.planPool(Array.from({ length: 60 }, (_, i) => page("decor_furn_" + i, 1024, 1024)), 24, [], "stream", true);
    const s = a.pools[1]; expect(s.k).toBe(1); expect(s.lru.capacity).toBeGreaterThanOrEqual(STREAM_FLOOR_SLOTS);
    expect(mb(a)).toBeLessThanOrEqual(budget);
  });
  it("the sprite shader clamps atlas taps inside the frame rect (no neighbouring-slot bleed)", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("../src/sprites.ts", import.meta.url), "utf8");
    expect(src).toContain("vec2 rectClamp(vec2 uv, int l, vec2 fw)");
    expect(src).toContain("vec3 su = inUv(uv, cw)");
    expect(src).not.toMatch(/texture\(uTintM, uv\)/);
  });
});

describe("ADR-251 ground follow-ups", () => {
  it("side faces: one instance per level with the +x / +y skirt mask bits; _low below the top level; void / sub-level drops none", async () => {
    const { groundSideKey, groundSideLevels, GROUND_SIDE_MAX_LEVELS } = await import("../src/groundArt.js");
    expect(groundSideLevels(3, 1, 2)).toEqual([{ level: 0, mask: 3 }, { level: 1, mask: 1 }]);
    expect(groundSideLevels(2, 2, 0)).toEqual([{ level: 0, mask: 2 }, { level: 1, mask: 2 }]);
    expect(groundSideLevels(1, 0.75, 1)).toEqual([]); // water inset (0.25) is not a cliff
    expect(groundSideLevels(1, -99, -99)).toEqual([]); // void: the mesh skirt handles it
    expect(groundSideLevels(40, 0, 40).length).toBe(GROUND_SIDE_MAX_LEVELS);
    expect(groundSideKey("grass", 0, 0)).toBe("gt_side_grass"); expect(groundSideKey("grass", 1, 2)).toBe("gt_side_grass_low_fall"); expect(groundSideKey("dirt", 2, 0)).toBe("gt_side_dirt_winter");
  });
  it("gt_water (art == 1) keeps its baked colour: no doubled detail term, no tint palette", async () => {
    const fs = await import("node:fs"); const src = fs.readFileSync(new URL("../src/terrainTiles.ts", import.meta.url), "utf8");
    const art = src.slice(src.indexOf("if (int(vArt.z + 0.5) == 1) { // ADR-251"), src.indexOf("} else { // legacy grey tile_water"));
    expect(art.length).toBeGreaterThan(0); expect(art).not.toMatch(/detail\s*\*/); expect(art).not.toMatch(/vec3\(0\.09, 0\.27/);
  });
  it("only the drawn season's gt pages pin at 1x", () => {
    const a = am(448); expect(a.groundPinOk("gt_summer_p0")).toBe(true); expect(a.groundPinOk("gt_winter_p0")).toBe(false); expect(a.groundPinOk("gt_shared")).toBe(true);
    a.groundPinSeason = "winter"; expect(a.groundPinOk("gt_winter_p1")).toBe(true); expect(a.groundPinOk("gt_summer_p1")).toBe(false);
  });
  it("basic_storage_box has real art: its crate_decor fallback is gone", async () => {
    const fs = await import("node:fs"); const fb = JSON.parse(fs.readFileSync(new URL("../../gameplay/data/sprite_fallbacks.json", import.meta.url), "utf8"));
    expect(JSON.stringify(fb)).not.toContain("basic_storage_box");
  });
});

describe("ADR-314: oversize stream pages get their own pool", () => {
  it("splitStreamPages keeps 1024 pages together and moves the 2048 door swing sheets out", async () => {
    const { splitStreamPages, STREAM_PAGE_MAX_PX } = await import("../src/assets/atlasManager.js");
    const pages = [page("decor_furn_s", 1024, 440, 4), page("season_bld_winter_p0", 1024, 1024, 4), page("door_swing_openings", 2048, 1792, 4), page("door_swing_clan", 1920, 1536, 4), page("door_swing_yard", 864, 240, 4)];
    const [small, big] = splitStreamPages(pages);
    expect(small.map((p) => p.key)).toEqual(["decor_furn_s", "season_bld_winter_p0", "door_swing_yard"]);
    expect(big.map((p) => p.key)).toEqual(["door_swing_openings", "door_swing_clan"]);
    expect(STREAM_PAGE_MAX_PX).toBe(1024);
    const a = am(1024);
    expect(a.poolGeom(small, 1).perLayer).toBe(4); // still 2x2 per 2048 layer
    expect(a.poolGeom(pages, 1).perLayer).toBe(1); // what one big page did to every stream slot
  });
});
