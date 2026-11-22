import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AtlasManager, BASE_PIN_COLD_FLOOR, BASE_PIN_RE, CORE_PIN_RE, RETIRED_BUILD_RE, TRIM_ATLAS_RE } from "../src/assets/atlasManager.js";
import { planTrim, TRIM_ALIGN, TRIM_GUTTER } from "../src/assets/trimAtlas.js";

/**
 * ADR-512: base building pieces (doors, windows, beds, furniture, decor, twig walls, defenses, stores) draw at 1x on the
 * A16's 256 MB budget. Four parts: the pool reserve charges what upload() allocates (the over-charge had halved the whole
 * hot tier to 0.25x once ADR-511's stairs page landed), the unused wave-2 building sheets are retired, the base grid sheets
 * (and resident vehicle art) are trim-repacked losslessly, and fitBudget gained pin tier 4 (base + core).
 */
const MB = 1048576;
function am(budget: number): any {
  const gl = { canvas: undefined, getParameter: () => 4096, isContextLost: () => false, getError: () => 0 } as never;
  const a = new AtlasManager(gl, { registerLoader: () => {} } as never, { textureBudgetMB: budget }) as any;
  a.atlases = []; a.coldDownscale = 1; a.downscale = 1; a.sideShift = 2;
  return a;
}
/** trimmed heights measured by trimGridAtlas on the shipped sheets (width unchanged) */
const TRIMMED_H: Record<string, number> = { buildings_twig: 568, openings: 464, furniture: 732, decor: 492, defenses: 168, defenses_glow: 180, cz_mirror: 272, vitems_garage: 536, vitems_garage_t2: 536, vitems_garage_t3: 536,
  building_tw: 560, pets_trough: 40, decor_apiary: 204, decor_ore_store: 196, decor_log_store: 128, decor_stick_store: 168, decor_crop_store: 124, decor_stone_store: 196, decor_dock: 160, decor_shipyard: 216 };
function residentList(): any[] {
  const atl = new Map<string, any>();
  for (const p of ["../../assets/pack/manifest.json", "../../assets/pack/nature/manifest.nature.json", "../../../assets/manifest.json"]) {
    const m = JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
    for (const a of m.atlases) if (!atl.has(a.key)) atl.set(a.key, a);
  }
  const resident = [...atl.values()].filter((a) => (a.residency !== "stream" || /^nature_(crops|sprouts|saplings)$/.test(a.key)) && !RETIRED_BUILD_RE.test(a.key));
  return resident.map((a, i) => ({
    key: a.key, id: i, img: { width: a.columns * a.frameW, height: TRIMMED_H[a.key] ?? a.rows * a.frameH }, emis: a.masks?.emissive ? {} : null,
    masks: { ...(a.masks?.sway ? { sway: {} } : {}), ...(a.masks?.sheen ? { sheen: {} } : {}), ...(a.masks?.tintmask ? { tintmask: {} } : {}) },
    scale: 1, cold: false, count: a.columns * a.rows,
  }));
}

describe("ADR-512: trim plan", () => {
  // 4x3 grid of 128x96 cells; art boxes per cell (cell-local, inclusive) or null (empty frame)
  const cols = 4, rows = 3, fw = 128, fh = 96;
  const boxes: ([number, number, number, number] | null)[] = [[40, 30, 87, 95], null, [0, 0, 127, 95], [10, 50, 20, 60], [63, 2, 64, 3], null, [5, 5, 122, 90], [100, 70, 127, 95], [1, 1, 1, 1], [30, 10, 90, 40], [64, 48, 64, 48], [2, 80, 125, 93]];
  const opaque = (x0: number, y0: number) => { const i = (y0 / fh) * cols + x0 / fw; const b = boxes[i]; return b ? [x0 + b[0], y0 + b[1], x0 + b[2], y0 + b[3]] as [number, number, number, number] : null; };
  const plan = planTrim(cols, rows, fw, fh, 256, opaque);
  it("every crop covers its art (+ gutter where the cell has room), stays inside its cell and is aligned", () => {
    plan.frames.forEach((f, i) => {
      const b = boxes[i];
      if (!b) { expect(f).toEqual({ x: 0, y: 0, w: TRIM_ALIGN, h: TRIM_ALIGN, dx: 0, dy: 0 }); return; }
      expect(f.dx % TRIM_ALIGN).toBe(0); expect(f.dy % TRIM_ALIGN).toBe(0); expect(f.x % TRIM_ALIGN).toBe(0); expect(f.y % TRIM_ALIGN).toBe(0);
      expect(f.dx + f.w).toBeLessThanOrEqual(fw); expect(f.dy + f.h).toBeLessThanOrEqual(fh);
      expect(f.dx).toBeLessThanOrEqual(Math.max(0, b[0] - TRIM_GUTTER)); expect(f.dy).toBeLessThanOrEqual(Math.max(0, b[1] - TRIM_GUTTER));
      expect(f.dx + f.w).toBeGreaterThanOrEqual(Math.min(fw, b[2] + 1 + TRIM_GUTTER)); expect(f.dy + f.h).toBeGreaterThanOrEqual(Math.min(fh, b[3] + 1 + TRIM_GUTTER));
    });
  });
  it("crops never overlap each other (or the shared empty cell) and fit the packed page", () => {
    const real = plan.frames.filter((_, i) => boxes[i]);
    for (const f of real) { expect(f.x + f.w).toBeLessThanOrEqual(plan.w); expect(f.y + f.h).toBeLessThanOrEqual(plan.h); expect(f.x >= TRIM_ALIGN || f.y >= TRIM_ALIGN).toBe(true); }
    for (let i = 0; i < real.length; i++) for (let j = i + 1; j < real.length; j++) {
      const a = real[i]!, b = real[j]!;
      expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
    }
    expect(plan.w * plan.h).toBeLessThan(cols * fw * rows * fh);
  });
  it("a trimmed frame resolves to the same anchor point as the grid cell (anchor stays in cell px)", () => {
    const a = am(256); const out: any = {};
    const f = plan.frames[0]!; const s = { anchorX: 0.5, anchorY: 0.9 };
    a.fill({ source: {}, base: 0, count: cols * rows, fw, fh, trim: plan.frames }, 0, s, out);
    expect(out.w).toBe(f.w); expect(out.h).toBe(f.h);
    // the cell texel under the anchor is the same art texel: crop origin (cell px dx,dy) + anchor-in-crop == anchor-in-cell
    expect(out.ax + f.dx).toBe(s.anchorX * fw); expect(out.ay + f.dy).toBe(s.anchorY * fh);
    const g: any = {}; a.fill({ source: {}, base: 0, count: cols * rows, fw, fh }, 0, s, g);
    expect(g.w).toBe(fw); expect(g.ax).toBe(s.anchorX * fw);
  });
});

describe("ADR-512: atlas sets", () => {
  it("the base set is the resident base-building sheets; trimming adds resident vehicle art; neither touches characters", () => {
    for (const k of ["openings", "furniture", "decor", "buildings_twig", "building_tw", "defenses", "defenses_glow", "decor_ore_store", "decor_apiary", "decor_dock", "decor_shipyard", "cz_mirror", "pets_trough", "vitems_garage", "vitems_garage_t3"]) {
      expect(BASE_PIN_RE.test(k)).toBe(true); expect(TRIM_ATLAS_RE.test(k)).toBe(true);
    }
    for (const k of ["veh_art_rowboat", "veh_art_wagon_small", "veh_art_car_sedan_1"]) { expect(TRIM_ATLAS_RE.test(k)).toBe(true); expect(BASE_PIN_RE.test(k)).toBe(false); }
    for (const k of ["characters", "characters_b", "zombies", "v2_body", "wear_hats_a", "building_t1", "decor_furn_l_1", "tiles", "gt_summer_p0", "decorx"]) { expect(TRIM_ATLAS_RE.test(k)).toBe(false); expect(BASE_PIN_RE.test(k)).toBe(false); }
  });
  it("only the superseded wave-2 building sheets are retired", () => {
    for (const k of ["buildings", "buildings_stone", "buildings_metal"]) expect(RETIRED_BUILD_RE.test(k)).toBe(true);
    for (const k of ["buildings_twig", "building_tw", "building_t1", "building_stairs", "buildings_x"]) expect(RETIRED_BUILD_RE.test(k)).toBe(false);
  });
});

describe("ADR-512: the 256 MB plan keeps base pieces at 1x", () => {
  const KEEP = 85 * MB; // the A16 plan's pool keep / 1x floor
  it("with the pools' reserve held, every base sheet is pinned at 1x next to the core set, cold no worse than ADR-510", async () => {
    const list = residentList(); const a = am(256);
    for (const k of ["tiles", "characters", "zombies", "resources", "nature_trees", "furniture", "openings", "decor", "buildings_twig"]) a.recentlyUsed.add(k);
    await a.fitBudget(list, KEEP, KEEP, KEEP);
    expect(a.downscale).toBe(0.5);
    expect(a.coldDownscale).toBeGreaterThanOrEqual(BASE_PIN_COLD_FLOOR);
    const pinned = new Set<string>(a.pinnedKeys);
    for (const x of list) if (BASE_PIN_RE.test(x.key)) expect(pinned.has(x.key)).toBe(true);
    for (const x of list) if (CORE_PIN_RE.test(x.key) && !x.cold) expect(pinned.has(x.key)).toBe(true);
    expect(a.fitInfo.reserveMB).toBe(85);
    expect(a.residentBytes(list) / MB + 85).toBeLessThanOrEqual(256);
  });
  it("base sheets are never demoted to the cold tier", async () => {
    const list = residentList(); const a = am(256);
    for (const x of list) if (BASE_PIN_RE.test(x.key)) x.cold = true;
    await a.fitBudget(list, KEEP, KEEP, KEEP);
    for (const x of list) if (BASE_PIN_RE.test(x.key)) expect(x.cold).toBe(false);
  });
});

describe("ADR-512: pool reserve charges what upload() allocates", () => {
  const lazy = (key: string, pool: number, extra: any = {}) => ({ key, source: { ...extra }, count: 16, lazy: { w1: 1024, h1: 1024, state: 0, pool } });
  it("a streamed pool layer is the compressed colour layer plus only its own side layers (no phantom arrays)", () => {
    const a = am(256); Object.defineProperty(a, "ktx2Target", { value: "astc" });
    const S = a.layerSize, side1 = ((S >> 2) * (S >> 2) * 4 * 4) / 3;
    const plain = a.poolLayerCost([lazy("building_t1", 2)], 1);
    const tinted = a.poolLayerCost([lazy("decor_furn_l_1", 4, { masks: { tintmask: "x" }, emissiveUrl: "y" })], 1);
    expect(plain).toBeLessThan(S * S * 4); // never the RGBA8 + four side arrays the old model charged (~9.6 MB at 2048)
    expect(tinted - plain).toBeCloseTo(2 * side1, -3);
    // a stream group mixing KTX2 and PNG-only pages is still charged compressed: planOwn compresses the whole tail
    expect(a.poolLayerCost([lazy("decor_furn_l_1", 4, { pages: [{ scale: 1, url: "a", ktx2: "a.ktx2" }] }), lazy("hearth_s", 4, {})], 1)).toBe(plain);
  });
});
