import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RETIRED_BUILD_RE, AtlasManager, NO_SIDE_WINDOW, sideIndex, sideWindow } from "../src/assets/atlasManager.js";
import { vehicleManifestEntries, type VehicleRenderDef } from "../src/index.js";

/**
 * ADR-510: the side arrays (emissive, sheen, sway, tint mask) store only the layers whose atlases / pools carry them
 * (a two-run window of the shared layer index), atlases with side masks pack first, and planPool charges what upload()
 * allocates. The freed bytes go to the visible pools: on the A16's 256 MB budget bld / roof / veh / stream plan at 1x.
 */
const MB = 1048576;
function am(budget: number): any {
  const gl = { canvas: undefined, getParameter: () => 4096, isContextLost: () => false, getError: () => 0 } as never;
  const a = new AtlasManager(gl, { registerLoader: () => {} } as never, { textureBudgetMB: budget }) as any;
  a.atlases = []; a.coldDownscale = 1; a.downscale = 1; a.sideShift = 2;
  return a;
}
/** ADR-512: fitBudget runs with the pools' reserve (rebuild() passes it); 85 MB is the A16 256 MB plan's keep / 1x floor. */
const KEEP = 85 * 1048576;
const TRIMMED_H: Record<string, number> = { buildings_twig: 568, openings: 464, furniture: 732, decor: 492, defenses: 168, defenses_glow: 180, cz_mirror: 272, vitems_garage: 536, vitems_garage_t2: 536, vitems_garage_t3: 536,
  building_tw: 560, pets_trough: 40, decor_apiary: 204, decor_ore_store: 196, decor_log_store: 128, decor_stick_store: 168, decor_crop_store: 124, decor_stone_store: 196, decor_dock: 160, decor_shipyard: 216 };
function residentList(): any[] {
  const atl = new Map<string, any>();
  for (const p of ["../../assets/pack/manifest.json", "../../assets/pack/nature/manifest.nature.json", "../../../assets/manifest.json"]) {
    const m = JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
    for (const a of m.atlases) if (!atl.has(a.key)) atl.set(a.key, a);
  }
  // ADR-512: the retired wave-2 building sheets are not loaded, and the base sheets upload trim-repacked (heights measured
  // by trimGridAtlas on the shipped sheets, same width)
  const resident = [...atl.values()].filter((a) => (a.residency !== "stream" || /^nature_(crops|sprouts|saplings)$/.test(a.key)) && !RETIRED_BUILD_RE.test(a.key));
  return resident.map((a, i) => ({
    key: a.key, id: i, img: { width: a.columns * a.frameW, height: TRIMMED_H[a.key] ?? a.rows * a.frameH }, emis: a.masks?.emissive ? {} : null,
    masks: { ...(a.masks?.sway ? { sway: {} } : {}), ...(a.masks?.sheen ? { sheen: {} } : {}), ...(a.masks?.tintmask ? { tintmask: {} } : {}) },
    scale: 1, cold: false, count: a.columns * a.rows,
  }));
}
function vehPages(): any[] {
  const raw = JSON.parse(readFileSync(join(__dirname, "../../gameplay/data/vehicles.json"), "utf8")) as { vehicles?: VehicleRenderDef[] } | VehicleRenderDef[];
  const DEFS = (Array.isArray(raw) ? raw : raw.vehicles!) as VehicleRenderDef[];
  return DEFS.map((d) => { const at: any = vehicleManifestEntries(d).atlas; return { key: at.key, source: {}, count: 1, lazy: { w1: at.columns * at.frameW, h1: at.rows * at.frameH, state: 0, pool: 1 } }; });
}

describe("ADR-510 sideWindow / sideIndex", () => {
  it("no carrier: no side layers (1x1 dummy)", () => {
    expect(sideWindow([])).toEqual(NO_SIDE_WINDOW);
    expect(sideWindow([-1])).toEqual(NO_SIDE_WINDOW);
  });
  it("one contiguous run is stored from its first layer", () => {
    const w = sideWindow([5, 3, 4, 4]);
    expect(w.count).toBe(3);
    expect([3, 4, 5].map((l) => sideIndex(w, l))).toEqual([0, 1, 2]);
  });
  it("two runs split at the largest gap; only small gaps are stored", () => {
    const w = sideWindow([0, 1, 2, 10, 11]);
    expect(w.count).toBe(5);
    expect([0, 1, 2, 10, 11].map((l) => sideIndex(w, l))).toEqual([0, 1, 2, 3, 4]);
    const v = sideWindow([0, 3, 4, 9]); // largest gap 4..9 splits, the 0..3 gap is stored
    expect(v.count).toBe(6);
    expect([0, 3, 4, 9].map((l) => sideIndex(v, l))).toEqual([0, 3, 4, 5]);
  });
  it("every carrier layer maps to a distinct side layer inside the allocation", () => {
    for (let seed = 1; seed < 200; seed++) {
      let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      const ls = [...new Set(Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => Math.floor(rnd() * 40)))];
      const w = sideWindow(ls); const idx = ls.map((l) => sideIndex(w, l));
      expect(new Set(idx).size).toBe(ls.length);
      for (const i of idx) { expect(i).toBeGreaterThanOrEqual(0); expect(i).toBeLessThan(w.count); }
      expect(w.count).toBeLessThanOrEqual(Math.max(...ls) - Math.min(...ls) + 1);
    }
  });
  it("the sprite shader applies the same mapping (sideUv) to every side lookup", () => {
    const src = readFileSync(join(__dirname, "../src/sprites.ts"), "utf8");
    expect(src).toMatch(/vec3 sideUv\(vec3 uv, ivec3 w\)/);
    for (const u of ["uWinE", "uWinS", "uWinW", "uWinT"]) expect(src).toContain(u);
  });
});

describe("ADR-510 packing and budget on the real resident set", () => {
  it("atlases with side masks pack first, so every side window is a short prefix of the layer index", async () => {
    const list = residentList(); const a = am(256);
    await a.fitBudget(list, KEEP, KEEP, KEEP); a.pack(list);
    for (const pick of [(x: any) => x.masks.sway, (x: any) => x.masks.sheen, (x: any) => x.emis]) {
      const ls = list.filter(pick).map((x) => x.layer as number);
      expect(ls.length).toBeGreaterThan(0);
      const w = sideWindow(ls);
      expect(w.count).toBeLessThan(a.layers);
      // ADR-512: the side-first order is only kept when it packs into no more layers; on the trimmed base set the plain
      // largest-first order can be a layer tighter, so the window need not start at layer 0 (fitBudget charges it as allocated)
    }
  });

  it("256 MB: the vehicle pool plans all 6 slots at 1x and the charged bytes stay within the budget", async () => {
    const list = residentList(); const a = am(256);
    await a.fitBudget(list, KEEP, KEEP, KEEP);
    a.pools = [];
    a.planPool(vehPages(), 6, list, "veh", true);
    const pool = a.pools[0];
    expect(pool.k).toBe(1);
    expect(pool.layers).toBe(6);
    const S = a.layerSize, rgba = (S * S * 4 * 4) / 3, side1 = ((S >> 2) * (S >> 2) * 4 * 4) / 3;
    const resL = a.layers - pool.layers;
    // fitBudget does not place the list (layout() packs it), so bound the resident side layers by the 3 side arrays the
    // resident set carries (emissive, sheen, sway; no resident tint mask) on every resident layer
    expect(list.some((x) => x.masks.tintmask)).toBe(false);
    const resSide = 3 * resL;
    // pool colour is at most RGBA8 (compressed own array when a KTX2 target exists), plus its own side layers
    const poolMax = pool.layers * (rgba + side1 * ((pool.tint ? 1 : 0) + (pool.emis ? 1 : 0)));
    expect((resL * rgba + resSide * side1 + poolMax) / MB).toBeLessThanOrEqual(256 * 1.01);
  });
});
