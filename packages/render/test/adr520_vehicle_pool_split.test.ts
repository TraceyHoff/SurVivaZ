import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { World, Transform } from "@engine/core";
import { loadManifest, mergeManifests } from "@engine/assets";
import { PACK_DIR, readManifestJson } from "@engine/assets/node";
import { AtlasManager, RETIRED_BUILD_RE, VEH_SMALL_PX, vehSmallPages } from "../src/assets/atlasManager.js";
import { LightSource, Occluder, Sprite, VehicleView, type VehiclePages, type VehicleRenderDef } from "../src/index.js";

/**
 * ADR-520: bike_road (and whichever vehicle came last) did not draw in WebGL2 when 7+ vehicles were on screen: one vehicle
 * pool sized every slot for the biggest sheet (936x1000), so at 1024 layers (low memory: 6 slots) a bike took a whole car
 * slot and the pages beyond the capacity never became resident (Canvas2D draws straight from the images, so it showed
 * them). Small sheets now have their own pool (2x2 a layer, a slot for each), low memory keeps 8 big slots, and the client
 * passes inView so off-screen vehicles stop holding pages.
 */
const VM = readManifestJson(PACK_DIR + "vehicles/manifest.vehicles.json") as any;
const pages = VM.atlases.filter((a: any) => /^veh_art_/.test(a.key)).map((a: any) => ({ key: a.key, source: {}, count: 1, lazy: { w1: a.columns * a.frameW, h1: a.rows * a.frameH, state: 0, pool: 1 } }));

describe("ADR-520 vehicle pool split", () => {
  it("bike sheets go to the small pool; cars, trucks and trailers stay in the big one", () => {
    const small = vehSmallPages(pages).map((p: any) => p.key);
    for (const k of ["bike_road", "bike_basic", "bike_bmx", "bike_mountain", "bike_cruiser", "bike_fat_tire"]) expect(small).toContain(`veh_art_${k}`);
    expect(small.every((k: string) => /^veh_art_(bike_|car_compact_1$)/.test(k))).toBe(true);
    expect(small.length).toBeLessThanOrEqual(8); // VEH_SMALL_SLOTS: a slot for every small sheet
    expect(pages.filter((p: any) => small.includes(p.key)).every((p: any) => p.lazy.w1 <= VEH_SMALL_PX && p.lazy.h1 <= VEH_SMALL_PX)).toBe(true);
    expect(vehSmallPages(pages.filter((p: any) => !small.includes(p.key)))).toEqual([]);
  });

  it("the small pool tiles 4+ bike sheets a layer and holds every one at 1x (A16 256 MB plan)", async () => {
    const MB = 1048576, KEEP = 85 * MB;
    const gl = { canvas: undefined, getParameter: () => 4096, isContextLost: () => false, getError: () => 0 } as never;
    const a = new AtlasManager(gl, { registerLoader: () => {} } as never, { textureBudgetMB: 256 }) as any; a.atlases = []; a.coldDownscale = 1; a.downscale = 1; a.sideShift = 2;
    const atl = new Map<string, any>();
    for (const p of ["../../assets/pack/manifest.json", "../../assets/pack/nature/manifest.nature.json", "../../../assets/manifest.json"]) { const m = JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")); for (const x of m.atlases) if (!atl.has(x.key)) atl.set(x.key, x); }
    const list = [...atl.values()].filter((x) => (x.residency !== "stream" || /^nature_(crops|sprouts|saplings)$/.test(x.key)) && !RETIRED_BUILD_RE.test(x.key))
      .map((x, i) => ({ key: x.key, id: i, img: { width: x.columns * x.frameW, height: x.rows * x.frameH }, emis: x.masks?.emissive ? {} : null, masks: x.masks?.sway ? { sway: {} } : {}, scale: 1, cold: false, count: x.columns * x.rows }));
    await a.fitBudget(list, KEEP, KEEP, KEEP); a.pools = [];
    const small = vehSmallPages(pages); const big = pages.filter((p: any) => !small.includes(p));
    a.planPool(big, 8, list, "veh", true); a.planPool(small, small.length, list, "veh", true);
    const [pb, ps] = a.pools;
    expect(pb.lru.capacity).toBe(8); expect(pb.k).toBe(1);
    expect(ps.perLayer).toBeGreaterThanOrEqual(4); expect(ps.k).toBe(1); expect(ps.lru.capacity).toBeGreaterThanOrEqual(small.length);
    expect(ps.sw).toBeLessThanOrEqual(VEH_SMALL_PX); expect(ps.sh).toBeLessThanOrEqual(VEH_SMALL_PX);
  });

  it("low memory keeps 8 big vehicle slots; the client streams pages for on-screen vehicles only", () => {
    const src = readFileSync(join(__dirname, "../src/assets/atlasManager.ts"), "utf8");
    expect(src).toMatch(/VEH_POOL_SLOTS_DESKTOP = 8, VEH_POOL_SLOTS_LOWMEM = 8/);
    expect(readFileSync(join(__dirname, "../../../apps/client/src/view.ts"), "utf8")).toMatch(/inView: this\.vehInView\(\)/);
  });

  it("VehicleView leaves an off-screen vehicle's page alone (pageReady only for vehicles in view)", () => {
    const raw = JSON.parse(readFileSync(join(__dirname, "../../gameplay/data/vehicles.json"), "utf8")) as { vehicles?: VehicleRenderDef[] } | VehicleRenderDef[];
    const DEFS = (Array.isArray(raw) ? raw : raw.vehicles!) as VehicleRenderDef[];
    const reg = loadManifest(mergeManifests([{ name: "pack", manifest: readManifestJson(PACK_DIR + "manifest.json") }, { name: "vehicles", manifest: VM }] as never).manifest).registry;
    const w = new World(); w.register(Transform); for (const c of [Sprite, LightSource, Occluder]) w.register(c);
    const asked: number[] = []; const pg: VehiclePages = { retainSprite: () => {}, releaseSprite: () => {}, pageReady: (id) => { asked.push(id); return true; } };
    const v = new VehicleView(w, reg, { art: true, pages: pg });
    const d = (id: string) => DEFS.find((x) => x.id === id)!;
    v.sync([{ key: 1, def: d("bike_road"), x: 0, y: 0, heading: 0 }, { key: 2, def: d("car_sedan"), x: 500, y: 500, heading: 0 }], 0, { darkness: 0, inView: (x) => x < 100 });
    expect(asked).toEqual([v.recs.get(1)!.art!.spriteId]);
  });
});
