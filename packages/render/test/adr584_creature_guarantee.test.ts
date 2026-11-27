import { describe, expect, it } from "vitest";
import { loadMergedPackManifest } from "@engine/assets/node";
import { AtlasManager, CREATURE_PIN_RE, atlasPoolSets, sourcesFromManifest, splitStreamPages, vehSmallPages } from "../src/assets/atlasManager.js";
import { setKtx2Transcoder } from "../src/assets/ktx2.js";

/**
 * ADR-584: creature sheets are full-res by construction at phone-class budgets.
 *
 * ADR-573's pin tier 5 was validated on a 148-atlas subset of the registry with a flat 85 MB
 * reserve. Against the REAL boot registry this harness replicates AtlasManager.rebuild()'s
 * resident partition and pool-reserve computation (wear shards excluded per ADR-555, Mali-class
 * compressed caps installed, pageScale 1 as the Auto preset plans), and ADR-573's plan left
 * every creature sheet at the halved hot scale — the blurry cow/owl the user reported.
 *
 * The guarantee: with textureBudgetMB >= 256, planFit's scaleOf pins every non-cold creature
 * sheet at 1.0 in EVERY tier, so the outcome no longer depends on a tier winning the budget
 * contest. Measured on this registry: creatures at 1.0 mixed into the (0.5, 0.125) pack cost
 * the same 6 layers the phone plan already spends — no other family pays for it. This test
 * runs the real merged registry so the plan can never silently drift out from under it again.
 */
const MB = 1048576;
const TRIMMED_H: Record<string, number> = { buildings_twig: 896, openings: 640, furniture: 1152, decor: 1024, defenses: 384, defenses_glow: 192, cz_mirror: 384, decor_log_store: 256, decor_stick_store: 256, decor_crop_store: 256 };
const ROOF_PAGE_RE = /^rfx_/, STAIRS_PAGE_RE = /^building_stairs$/;
const POOL_MIN_SLOTS_LOWMEM = 24, WEAR_1X_SLOTS_LOWMEM = 18, WEAR_FLOOR_SLOTS = 4, STREAM_POOL_SLOTS_LOWMEM = 12,
  BLD_POOL_SLOTS_LOWMEM = 4, ROOF_POOL_SLOTS_LOWMEM = 4, VEH_POOL_SLOTS_LOWMEM = 8, VEH_SMALL_SLOTS = 8,
  BIG_STREAM_SLOTS_LOWMEM = 1, WEAR_SMALL_PX = 672, WEAR_SPLIT_MIN = 4, STREAM_BUDGET_SHARE = 0.25,
  WEAR_BUDGET_SHARE = 0.3, STREAM_FLOOR_SLOTS = 4;

describe("ADR-584 creature guarantee (real boot registry)", () => {
  it("plans every creature sheet at 1.0 at the 256 MB phone budget", async () => {
    const { result } = await loadMergedPackManifest({ excludeWearShards: true });
    const registry = result.registry as any;
    const sources = sourcesFromManifest(registry, "http://x/art/pack/manifest.json");
    const gl = { canvas: undefined, getParameter: () => 4096, isContextLost: () => false, getError: () => 0 } as never;
    const a = new AtlasManager(gl, { registerLoader: () => {} } as never, { textureBudgetMB: 256 }) as any;
    a.atlases = []; a.coldDownscale = 1; a.downscale = 1; a.sideShift = 2; a.pools = []; a.planningRebuild = true;
    setKtx2Transcoder(async () => { throw new Error("stub"); }); // phone installs the basis transcoder
    a.setCompressed({ etc2: true, astc: true, s3tc: false, bptc: false }); // Mali-G68-class phone caps

    const pools = atlasPoolSets(registry, sources, { streamWearables: true, streamVehicles: true, streamBuildingTiers: true, streamSheets: true, residentCreatures: true, ktx2: !!a.ktx2Target });
    const { lazyKeys, legacy, retired, vehKeys, bldKeys, streamKeys, bodyKeys } = pools;
    const list: any[] = []; const lazyList: any[] = [];
    for (const at of registry.atlases.values()) {
      const pooled = lazyKeys.has(at.key) || vehKeys.has(at.key) || legacy.has(at.key) || retired.has(at.key) || bldKeys.has(at.key) || bodyKeys.has(at.key) || streamKeys.has(at.key);
      const img = { width: at.columns * at.frameW, height: TRIMMED_H[at.key] ?? at.rows * at.frameH };
      if (pooled) {
        const pool = legacy.has(at.key) || retired.has(at.key) ? -1 : vehKeys.has(at.key) ? 1 : bldKeys.has(at.key) ? 2 : bodyKeys.has(at.key) ? 3 : streamKeys.has(at.key) ? 4 : 0;
        lazyList.push({ key: at.key, id: at.id, source: sources.get(at.key), img: null, emis: null, scale: 1, masks: {}, maskUrls: {}, base: 0, count: at.columns * at.rows, fw: at.frameW, fh: at.frameH, cols: at.columns, layer: -1, px: 0, py: 0, lazy: { w1: img.width, h1: img.height, state: 0, pool } });
      } else {
        list.push({ key: at.key, id: at.id, source: sources.get(at.key), img, emis: at.masks?.emissive ? {} : null, masks: { ...(at.masks?.sway ? { sway: {} } : {}), ...(at.masks?.sheen ? { sheen: {} } : {}), ...(at.masks?.tintmask ? { tintmask: {} } : {}) }, maskUrls: {}, scale: 1, cold: false, count: at.columns * at.rows, fw: at.frameW, fh: at.frameH, cols: at.columns, layer: 0, px: 0, py: 0 });
      }
    }
    // rebuild()'s pool groups + reserve computation (lowMem: budget <= 256)
    const groups: any[] = [];
    const wear = lazyList.filter((x) => x.lazy.pool === 0), veh = lazyList.filter((x) => x.lazy.pool === 1), bld = lazyList.filter((x) => x.lazy.pool === 2), body = lazyList.filter((x) => x.lazy.pool === 3);
    const [strm, strmBig] = splitStreamPages(lazyList.filter((x) => x.lazy.pool === 4));
    if (body.length) groups.push({ cls: "body", lazy: body, minSlots: body.length, cap: true });
    if (wear.length) {
      const min = Math.min(wear.length, a.poolPolicy.minSlots ?? POOL_MIN_SLOTS_LOWMEM);
      const small = a.poolPolicy.splitWear === false || a.layerSize < 2048 ? [] : wear.filter((x) => x.lazy.w1 <= WEAR_SMALL_PX && x.lazy.h1 <= WEAR_SMALL_PX);
      if (small.length >= WEAR_SPLIT_MIN && wear.length - small.length >= WEAR_SPLIT_MIN) {
        const share = small.length / wear.length, big = wear.filter((x) => !small.includes(x));
        const ms = Math.max(1, Math.min(small.length, Math.round(min * share))), mb = Math.max(1, Math.min(big.length, min - ms));
        groups.push({ cls: "wear", lazy: small, minSlots: ms, cap: false, share }, { cls: "wear", lazy: big, minSlots: mb, cap: false, share: 1 - share });
      } else groups.push({ cls: "wear", lazy: wear, minSlots: min, cap: false });
    }
    const bldTier = bld.filter((x) => !ROOF_PAGE_RE.test(x.key) && !STAIRS_PAGE_RE.test(x.key)), bldRoof = bld.filter((x) => ROOF_PAGE_RE.test(x.key)), bldStairs = bld.filter((x) => STAIRS_PAGE_RE.test(x.key));
    if (bldTier.length) groups.push({ cls: "bld", lazy: bldTier, minSlots: Math.min(bldTier.length, BLD_POOL_SLOTS_LOWMEM), cap: true });
    if (bldRoof.length) groups.push({ cls: "bld", lazy: bldRoof, minSlots: Math.min(bldRoof.length, ROOF_POOL_SLOTS_LOWMEM), cap: true });
    if (bldStairs.length) groups.push({ cls: "bld", lazy: bldStairs, minSlots: 1, cap: true });
    const vehSmall = vehSmallPages(veh), vehBig = veh.filter((x) => !vehSmall.includes(x));
    if (vehBig.length) groups.push({ cls: "veh", lazy: vehBig, minSlots: Math.min(vehBig.length, VEH_POOL_SLOTS_LOWMEM), cap: true });
    if (vehSmall.length) groups.push({ cls: "veh", lazy: vehSmall, minSlots: Math.min(vehSmall.length, VEH_SMALL_SLOTS), cap: true });
    if (strm.length) {
      const want = Math.min(strm.length, STREAM_POOL_SLOTS_LOWMEM), g1 = a.poolGeom(strm, 1);
      const layerCost = g1.perLayer > 0 ? a.poolReserveBytes(strm, g1.perLayer, list, 1) : 0;
      const fit = layerCost > 0 ? Math.floor(a.textureBudgetMB * MB * STREAM_BUDGET_SHARE / layerCost) * g1.perLayer : want;
      groups.push({ cls: "stream", lazy: strm, minSlots: Math.max(Math.min(want, fit), Math.min(want, STREAM_FLOOR_SLOTS)), cap: true });
    }
    if (strmBig.length) groups.push({ cls: "stream", lazy: strmBig, minSlots: Math.min(strmBig.length, BIG_STREAM_SLOTS_LOWMEM), cap: true });
    const w1x = WEAR_1X_SLOTS_LOWMEM; const wk = a.wearScale();
    const wearG = groups.filter((g) => g.cls === "wear");
    const keepWear = wearG.reduce((t, g) => t + a.poolReserveBytes(g.lazy, Math.min(g.minSlots, Math.ceil(w1x * (g.share ?? 1))), list, wk), 0);
    const wantWear = wearG.reduce((t, g) => t + a.poolReserveBytes(g.lazy, g.minSlots, list, wk), 0);
    const keepVis = groups.filter((g) => g.cls !== "wear").reduce((t, g) => t + a.poolReserveBytes(g.lazy, g.minSlots, list, 1), 0);
    const wearCap = a.textureBudgetMB * MB * WEAR_BUDGET_SHARE;
    const wearFloor = wearG.reduce((t, g) => t + a.poolReserveBytes(g.lazy, Math.min(g.minSlots, Math.ceil(WEAR_FLOOR_SLOTS * (g.share ?? 1))), list, wk), 0);
    const wearRes = Math.max(wearFloor, Math.min(Math.max(keepWear, wantWear), wearCap));
    const keep = keepVis + Math.max(wearFloor, Math.min(keepWear, wantWear, wearCap) / 2), reserve = keepVis + wearRes;

    a.planFit(list, reserve, keep, keepVis + wearFloor);

    const creatures = list.filter((x) => CREATURE_PIN_RE.test(x.key));
    expect(creatures.length, "the real registry carries the creature set").toBeGreaterThan(40);
    for (const c of creatures) expect(c.fitK, `creature sheet ${c.key} must plan at full res`).toBe(1);
    // The two sheets the user named, pinned explicitly so a rename fails loudly here.
    expect(list.find((x) => x.key === "nature_critters_a_40x40")?.fitK, "cow sheet").toBe(1);
    expect(list.find((x) => x.key === "pets_owl")?.fitK, "owl sheet").toBe(1);
    // ?diag=1 truthfulness: the guarantee is reported in the pinned set.
    for (const c of creatures) expect(a.pinnedKeys.has(c.key), `pinnedKeys reports ${c.key}`).toBe(true);
    // Nobody else pays: the hot tier never drops below the pre-guarantee plan's hot scale on
    // this registry (0.25), and the plan stays inside the budget it was given.
    expect(a.downscale).toBeGreaterThanOrEqual(0.25);
    expect(a.residentBytes(list)).toBeLessThanOrEqual(256 * MB);
  });
});
