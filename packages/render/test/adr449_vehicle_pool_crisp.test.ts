import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AtlasManager } from "../src/assets/atlasManager.js";
import { vehicleManifestEntries, type VehicleRenderDef } from "../src/index.js";

/**
 * ADR-449: vehicle (and building-tier) pools go soft as a whole when the free layers run short.
 *
 * Measured, not guessed: vehicles.json now has 45 defs (bikes, cars, trucks, trailers, wagons, boats),
 * 35 of whose sheets exceed 1020 px, so the vehicle pool's slot is a whole 2048 layer (perLayer 1) and
 * 6 minSlots need 6 free layers at 1x. planPool's cap branch, on finding 6 > room, walked down the scale
 * ladder to 0.5x / 0.25x instead of keeping fewer slots at 1x — every vehicle on screen went soft at once
 * (probe at the 256 MB budget with 5 free layers: k=0.5, 2 layers; at 128 MB with no reserve: k=0.25).
 * Raising VEH_POOL_SLOTS would not help: the binding constraint is free layers, not minSlots (8 slots plan
 * identically to 6 when the room is short).
 *
 * Fix (same file, planPool cap branch): veh/bld take the stream floor — keep full res with fewer slots (LRU
 * pages the rest) down to STREAM_FLOOR_SLOTS before blurring as a whole. Same rule the stream pool already
 * had; veh/bld take it at 1x only (a 2x slot would waste a double-size layer on a 1x sheet, a 0.5x floor
 * would lock the blur in). Wear's "fewer slots, not blur" philosophy, extended to visible pools. Zero VRAM
 * cost: the pool takes at most the free layers it was already allowed.
 */
const MB = 1048576;
function am(budget: number): any {
  const gl = { canvas: undefined, getParameter: () => 4096, isContextLost: () => false, getError: () => 0 } as never;
  const a = new AtlasManager(gl, { registerLoader: () => {} } as never, { textureBudgetMB: budget }) as any;
  a.atlases = []; a.coldDownscale = 1; a.downscale = 1; a.sideShift = 2;
  return a;
}
/** Resident atlas list from the real merged manifests (ADR-438 harness): fitBudget packs it for real. */
function residentList(): any[] {
  const atl = new Map<string, any>();
  for (const p of ["../../assets/pack/manifest.json", "../../assets/pack/nature/manifest.nature.json", "../../../assets/manifest.json"]) {
    const m = JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
    for (const a of m.atlases) if (!atl.has(a.key)) atl.set(a.key, a);
  }
  const resident = [...atl.values()].filter((a) => a.residency !== "stream" || /^nature_(crops|sprouts|saplings)$/.test(a.key));
  return resident.map((a, i) => ({ key: a.key, id: i, img: { width: a.columns * a.frameW, height: a.rows * a.frameH }, emis: a.masks?.emissive ? {} : null, masks: a.masks?.sway ? { sway: {} } : {}, scale: 1, cold: false, count: a.columns * a.rows }));
}
const WORLD = ["tiles", "decor", "resources", "resources_tall", "resources_huge", "nature_trees", "nature_crops", "nature_sprouts", "nature_saplings", "characters", "characters_b", "zombies", "zombies_brute", "zombies_runner", "zombies_mummy", "zombies_pumpkin", "animals_medium", "buildings", "furniture", "openings", "items", "equipment", "held"];
/** The real vehicle pages: one lazy veh atlas per def in vehicles.json, at its manifest size. */
function vehPages(): any[] {
  const raw = JSON.parse(readFileSync(join(__dirname, "../../gameplay/data/vehicles.json"), "utf8")) as { vehicles?: VehicleRenderDef[] } | VehicleRenderDef[];
  const DEFS = (Array.isArray(raw) ? raw : raw.vehicles!) as VehicleRenderDef[];
  return DEFS.map((d) => {
    const at: any = vehicleManifestEntries(d).atlas;
    return { key: at.key, source: {}, count: 1, lazy: { w1: at.columns * at.frameW, h1: at.rows * at.frameH, state: 0, pool: 1 } };
  });
}
const page = (key: string, w: number, h: number, pool = 1) => ({ key, source: {}, count: 1, lazy: { w1: w, h1: h, state: 0, pool } });

describe("ADR-449: vehicle pool stays crisp under memory pressure", () => {
  it("the real vehicle set is 46 sheets, most over one layer's quarter (perLayer 1 at 1x)", () => {
    const pages = vehPages();
    expect(pages.length).toBe(46); // ADR-503: vehicles.json grew to 46 defs after this test was written (it pinned 45 and turned main CI red)
    expect(pages.filter((p) => p.lazy.w1 > 1020 || p.lazy.h1 > 1020).length).toBe(36);
    const a = am(256);
    expect(a.poolGeom(pages, 1).perLayer).toBe(1);
  });

  it("short on free layers the veh pool keeps 1x with fewer slots instead of dropping to 0.5x", async () => {
    const pages = vehPages();
    // 256 MB budget, real resident pack: 5 resident layers leave 5 free layers for a pool that wants 6.
    // (Pre-fix probe: k=0.5, 2 layers — every vehicle soft.)
    const list = residentList();
    const a = am(256); for (const k of WORLD) a.recentlyUsed.add(k);
    await a.fitBudget(list, 0, 0);
    expect(a.layers).toBe(5);
    a.pools = [];
    a.planPool(pages, 6, list, "veh", true);
    const pool = a.pools[0];
    expect(pool.k).toBe(1);
    expect(pool.layers).toBe(5);
    expect(pool.lru.capacity).toBe(5);
  });

  it("with room the veh pool still plans all 6 slots at 1x (no behaviour change when it fits)", async () => {
    const pages = vehPages();
    const list = residentList();
    const a = am(768); for (const k of WORLD) a.recentlyUsed.add(k);
    await a.fitBudget(list, 0, 0);
    a.pools = [];
    a.planPool(pages, 6, list, "veh", true);
    const pool = a.pools[0];
    expect(pool.k).toBe(1);
    expect(pool.layers).toBe(6);
    expect(pool.lru.capacity).toBe(6);
    expect((a.layers * a.layerBytes(list)) / MB).toBeLessThanOrEqual(768);
  });

  it("building tiers stay at 1x when their slots fit the free layer (no regression)", () => {
    const bld = [page("building_t1", 1024, 1024, 2), page("building_t2", 1024, 1024, 2), page("building_t3", 1024, 1024, 2), page("building_t4", 1024, 1024, 2)];
    const a = am(256);
    a.layerSize = 2048; a.layers = 9; a.planLayers = 9; a.packedLayers = 9; a.pools = [];
    a.planPool(bld, 4, [], "bld", true);
    const pool = a.pools[0];
    expect(pool.k).toBe(1);
    expect(pool.lru.capacity).toBeGreaterThanOrEqual(4);
  });

  it("with no free layer at all the pool still falls back to one layer at the smallest scale (degraded extreme, unchanged)", () => {
    const pages = vehPages();
    const a = am(256);
    a.layerSize = 2048; a.layers = 20; a.planLayers = 20; a.packedLayers = 20; a.pools = [];
    a.planPool(pages, 6, [], "veh", true);
    const pool = a.pools[0];
    expect(pool.k).toBe(0.25);
    expect(pool.layers).toBe(1);
  });
});
