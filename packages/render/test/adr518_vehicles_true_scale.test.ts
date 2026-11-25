import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { World, Transform } from "@engine/core";
import { loadManifest, mergeManifests } from "@engine/assets";
import { PACK_DIR, readManifestJson } from "@engine/assets/node";
import { RETIRED_BUILD_RE, AtlasManager } from "../src/assets/atlasManager.js";
import {
  LightSource, Occluder, Sprite, VehicleView, artScaleFor, artSeat, heightX, modelZScale, resolveVehicleArt, seatZScale, targetHeightPx, toWorld,
  PLAYER_HEIGHT_PX, Z_PER_M, VEHICLE_SEAT_ART, PX_PER_M_HEIGHT, RIDER_CLIP_HIDDEN, RIDER_DK_ART, RIDER_LEG_PX, RIDER_HEAD_PX, footprintKeyAt, windowBand, windowGlassSpan, windowGlassRoofline, VIEW_RISE, WINDSCREEN_RAKE_M, type VehicleRenderDef,
} from "../src/index.js";
// @ts-expect-error untyped build script
import { seatTable } from "../scripts/gen-vehicle-seats.mjs";

/**
 * ADR-518: Art's true-scale vehicle repaint (art/vehicles-true-scale a51f102d) draws 1:1 next to the 53 px / 1.75 m player:
 * no fit scale, real roof heights, riders seated from seats.vehicles.json (window band clip in cabs, over the frame on
 * bikes, hidden where Art has no window), tall bodies fade over the player, and the vehicle pool keeps 4 slots a layer.
 */
const raw = JSON.parse(readFileSync(join(__dirname, "../../gameplay/data/vehicles.json"), "utf8")) as { vehicles?: VehicleRenderDef[] } | VehicleRenderDef[];
const DEFS = (Array.isArray(raw) ? raw : raw.vehicles!) as VehicleRenderDef[];
const def = (id: string): VehicleRenderDef => DEFS.find((d) => d.id === id)!;
const SEATS = JSON.parse(readFileSync(PACK_DIR + "vehicles/seats.vehicles.json", "utf8"));
const VM = readManifestJson(PACK_DIR + "vehicles/manifest.vehicles.json") as any;
const reg = loadManifest(mergeManifests([{ name: "pack", manifest: readManifestJson(PACK_DIR + "manifest.json") }, { name: "vehicles", manifest: VM }] as never).manifest).registry;
const DIRS = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];
/** engine iso projection (tileW 64, tileH 32, zStep 16) of a vehicle-local point, relative to the pivot */
const scr = (hq: number, u: number, v: number, zUnits: number) => { const [x, y] = toWorld(0, 0, hq, u, v); return { x: (x - y) * 32, y: (x + y) * 16 - zUnits * 16 }; };
/** Art facing index a (E = 0) is engine row a - 1 (ART_DIR_OFFSET 1) */
const hqOf = (a: number) => ((a - 1) * Math.PI) / 4;

describe("ADR-518 true-scale vehicles", () => {
  it("seats.data.ts is the build-time fold of Art's seats.vehicles.json (no drift)", () => {
    const t = seatTable(SEATS);
    expect(Object.keys(VEHICLE_SEAT_ART).sort()).toEqual(Object.keys(t).sort());
    for (const [k, v] of Object.entries(t) as [string, any][]) expect(JSON.parse(JSON.stringify(VEHICLE_SEAT_ART[k]))).toEqual(v);
    expect(PX_PER_M_HEIGHT).toBeCloseTo(53 / 1.75, 2);
  });

  it("every Art vehicle draws 1:1 (no fit scale) and its roof is the real height x 30.29 px/m next to the 53 px player", () => {
    expect(PLAYER_HEIGHT_PX).toBe(53);
    let n = 0;
    for (const d of DEFS) {
      expect(artScaleFor(d, d.id)).toBe(1);
      const b = resolveVehicleArt(reg, d); if (!b) continue; n++;
      expect(b.scale, d.id).toBe(1);
    }
    expect(n).toBe(30); // 31 Art keys; trailer_log has no gameplay def
    // Art's centreline roof px (ART_KEYS_VEHICLES.md "True-scale pass")
    const roof: Record<string, number> = { car_sedan: 44, car_compact: 45, car_muscle: 41, car_offroad: 54, car_wagon: 45, truck_pickup: 56, truck_flatbed: 64, truck_box: 97, van_cargo: 61, van_passenger: 54, camper_van: 79, camper_rv: 103, semi_tractor: 118, bike_bmx: 28, bike_basic: 33 };
    for (const [id, px] of Object.entries(roof)) expect(Math.abs(targetHeightPx(def(id)) - px), id).toBeLessThanOrEqual(0.6);
    // the procedural placeholder (shown while a page streams) matches the same height
    expect(modelZScale(def("car_sedan")) * 1.3).toBeCloseTo((1.45 * PX_PER_M_HEIGHT) / 16, 3);
    expect(seatZScale(def("car_sedan"), 1.3)).toBe(Z_PER_M);
  });

  it("defs Art did not repaint (wagons, boats) keep their legacy stylized height and seat scale", () => {
    expect(targetHeightPx(def("wagon_small"))).toBeCloseTo(1.3 * 74, 6);
    expect(targetHeightPx(def("canoe"))).toBeCloseTo(1.3 * 74, 6);
    expect(heightX(def("wagon_small")) * PLAYER_HEIGHT_PX).toBeCloseTo(96.2, 6);
  });

  it("Art seat H-points project through the engine's iso camera onto Art's per-facing pixel offsets (u, v, z; engine +v = Art right)", () => {
    let n = 0;
    for (const [key, e] of Object.entries(SEATS.vehicles) as [string, any][]) e.seats.forEach((s: any, i: number) => {
      const a = artSeat({ id: key }, i)!;
      expect(a.draw).toBe(s.draw);
      DIRS.forEach((dn, k) => {
        const f = s.facings[dn]; const p = scr(hqOf(k), a.u, a.v, a.z);
        expect(Math.abs(p.x - f.x), `${key} ${s.name} ${dn} x`).toBeLessThan(0.15); expect(Math.abs(p.y - f.y), `${key} ${s.name} ${dn} y`).toBeLessThan(0.15);
        if (s.draw === "window") { expect(a.clipBottom).toBeCloseTo(f.y - f.clipBottom, 0); expect(a.clipTop).toBeCloseTo(f.y - f.clipTop, 0); }
        n++;
      });
    });
    expect(n).toBe(456); // 57 Art seats x 8 facings (ADR-521 adds 9: van rows 3-4, pickup bed, RV rows 2-3)
  });

  const mk = () => { const w = new World(); w.register(Transform); for (const c of [Sprite, LightSource, Occluder]) w.register(c); return w; };
  it("riders sit on Art's seats and beat the body over every row they show: cab seats through the glass only, bikes whole, extra seats hidden (van's 8th seat is on Art's row-4 seat since ADR-521)", () => {
    let shown = 0, hidden = 0, shown104 = 0; let w = mk(), v = new VehicleView(w, reg, { art: true });
    for (const view of [0, 1, 2, 3]) for (let dir = 0; dir < 8; dir++) {
      w = mk(); v = new VehicleView(w, reg, { art: true }); // fresh smoother: the first sync snaps to the snapshot pose
      const h = (dir * Math.PI) / 4, sedan = def("car_sedan"), bike = def("bike_road"), van = def("van_passenger");
      const out = v.sync([
        { key: 1, def: sedan, x: 10, y: 10, heading: h, occupants: [101, 102, 0, 0] },
        { key: 2, def: bike, x: 20, y: 5, heading: h, occupants: [103] },
        { key: 3, def: van, x: 30, y: 30, heading: h, occupants: [0, 0, 0, 0, 0, 0, 0, 104] },
      ], 0, { darkness: 0, view });
      const by = (r: number) => out.find((p) => p.rider === r)!;
      const c = [1, 0, -1, 0][view]!, sn = [0, 1, 0, -1][view]!; const vk = (p: { x: number; y: number; z: number }) => c * p.x - sn * p.y + (sn * p.x + c * p.y) + p.z / 3;
      for (const r of [101, 102, 103]) {
        const p = by(r), b = v.pose(p.vehicle)!, d = p.vehicle === 1 ? sedan : bike, a = artSeat(d, p.seat)!;
        // the rider pivot is the Art seat H-point on screen (in every view rotation)
        const sx = (q: { x: number; y: number; z: number }) => { const u = c * q.x - sn * q.y, vv = sn * q.x + c * q.y; return { x: (u - vv) * 32, y: (u + vv) * 16 - q.z * 16 }; };
        const [wx, wy] = toWorld(b.x, b.y, b.heading - b.heading + (b.dir * Math.PI) / 4, a.u, a.v);
        const want = sx({ x: wx, y: wy, z: b.z + a.z }), got = sx(p), piv = sx(b);
        expect(got.x).toBeCloseTo(want.x, 4); expect(got.y).toBeCloseTo(want.y, 4);
        // the band is the glass seen along the camera ray, never above the roof underside or below the door at the seat
        if (a.draw === "window") {
          if (p.clip && p.clip.bottom < 1e3) { shown++; expect(p.clip.top).toBeLessThanOrEqual(a.clipTop + 1e-6); expect(p.clip.top - p.clip.bottom).toBeGreaterThanOrEqual(a.clipTop - a.clipBottom - 1e-6); expect(p.clip.top - p.clip.bottom).toBeLessThanOrEqual(a.clipTop - a.clipBottom + WINDSCREEN_RAKE_M * VIEW_RISE * PX_PER_M_HEIGHT + 1e-6); }
          else { hidden++; expect(p.clip).toEqual(RIDER_CLIP_HIDDEN); continue; }
        } else expect(p.clip).toBeUndefined();
        // depth: every row it shows beats the body's drawn (Footprint, vertex-interpolated) key by >= RIDER_DK_ART, tight at one end
        const sp = reg.sprite(v.recs.get(p.vehicle)!.art!.spriteId); const f = reg.dirFrame(sp.id, sp.animList[0]!.name, ((b.dir + 1 + 2 * view) * Math.PI) / 4, 0);
        const top = f.anchorY + 1, below = f.h - f.anchorY + 1, K = vk(b), hs = piv.y - got.y, rk = vk(p);
        const rows = p.clip ? [p.clip.bottom, p.clip.top] : [-RIDER_LEG_PX, RIDER_HEAD_PX];
        const gaps = rows.map((dd) => (rk + 0.02 + dd / 48) - footprintKeyAt(K, hs + dd, top, below, 1 / 48, 16));
        expect(Math.min(...gaps)).toBeCloseTo(RIDER_DK_ART, 6);
        // ...which the pre-ADR-518 pivot-plane placement did not (the cab rider was a ghost behind the door)
        expect(K + (hs / 16) / 3).toBeLessThan(footprintKeyAt(K, hs + rows[0]!, top, below, 1 / 48, 16));
      }
      expect(by(103).cropped).toBe(false);
      // ADR-521: gameplay seat 8 of 8 is Art's row-4 seat (a window seat), so its clip is the windowBand for this
      // view/dir — a real band where the seat shows, RIDER_CLIP_HIDDEN only where the far side hides it (never hidden
      // for lack of a seat, as it was under ADR-518).
      const hv104 = h + view * (Math.PI / 2), cu104 = (Math.cos(hv104) + Math.sin(hv104)) / Math.SQRT2, cv104 = (Math.cos(hv104) - Math.sin(hv104)) / Math.SQRT2;
      const band104 = windowBand(van, 7, cu104, cv104);
      if (band104) { shown104++; const glass104 = windowGlassSpan(van, 7, cu104, cv104)!; expect(by(104).clip).toEqual({ bottom: band104.bottom, top: band104.top, glass: { ...glass104, vehicle: 3, roof: windowGlassRoofline(van, 7, cu104, cv104) } }); }
      else expect(by(104).clip).toEqual(RIDER_CLIP_HIDDEN);
    }
    expect(shown).toBeGreaterThan(16); expect(hidden).toBeGreaterThan(4); expect(shown104).toBeGreaterThan(0);
    // side view (Art "E"): the far-side driver is under the roof (hidden); the near-side passenger shows hip..chest through the glass
    w = mk(); v = new VehicleView(w, reg, { art: true });
    const e = v.sync([{ key: 1, def: def("car_sedan"), x: 10, y: 10, heading: -Math.PI / 4, occupants: [101, 102, 0, 0] }], 0, { darkness: 0 });
    expect(e.find((p) => p.rider === 101)!.clip).toEqual(RIDER_CLIP_HIDDEN);
    const band = windowBand(def("car_sedan"), 1, 0, 1)!; const c2 = e.find((p) => p.rider === 102)!.clip!;
    expect(c2.bottom).toBeCloseTo(band.bottom, 6); expect(c2.top).toBeCloseTo(band.top, 6);
    expect(band.bottom).toBeCloseTo((0.814 - 0.55 - 0.54 * VIEW_RISE) * PX_PER_M_HEIGHT, 3); expect(band.top).toBeCloseTo((1.366 - 0.55 - 0.54 * VIEW_RISE) * PX_PER_M_HEIGHT, 3);
  });

  it("tall true-scale bodies fade over the player (Occluder); cars and bikes do not", () => {
    const w = mk(); const v = new VehicleView(w, reg, { art: true });
    v.sync([{ key: 1, def: def("truck_box"), x: 0, y: 0, heading: 0 }, { key: 2, def: def("car_sedan"), x: 9, y: 0, heading: 0 }, { key: 3, def: def("bike_road"), x: 0, y: 9, heading: 0 }], 0, { darkness: 0 });
    const occ = (k: number) => w.has(v.recs.get(k)!.body!, Occluder);
    expect(occ(1)).toBe(true); expect(occ(2)).toBe(false); expect(occ(3)).toBe(false);
  });

  it("vehicle pool: every true-scale sheet fits a quarter layer at 1x, so the A16 (256 MB) plan keeps 8 slots at 1x in 2 layers", async () => {
    const pages = VM.atlases.filter((a: any) => /^veh_art_/.test(a.key)).map((a: any) => ({ key: a.key, source: {}, count: 1, lazy: { w1: a.columns * a.frameW, h1: a.rows * a.frameH, state: 0, pool: 1 } }));
    expect(pages.length).toBe(88);
    expect(pages.every((p: any) => p.lazy.w1 <= 1020 && p.lazy.h1 <= 1020)).toBe(true);
    const MB = 1048576, KEEP = 85 * MB;
    const gl = { canvas: undefined, getParameter: () => 4096, isContextLost: () => false, getError: () => 0 } as never;
    const a = new AtlasManager(gl, { registerLoader: () => {} } as never, { textureBudgetMB: 256 }) as any; a.atlases = []; a.coldDownscale = 1; a.downscale = 1; a.sideShift = 2;
    const atl = new Map<string, any>();
    for (const p of ["../../assets/pack/manifest.json", "../../assets/pack/nature/manifest.nature.json", "../../../assets/manifest.json"]) { const m = JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")); for (const x of m.atlases) if (!atl.has(x.key)) atl.set(x.key, x); }
    const list = [...atl.values()].filter((x) => (x.residency !== "stream" || /^nature_(crops|sprouts|saplings)$/.test(x.key)) && !RETIRED_BUILD_RE.test(x.key))
      .map((x, i) => ({ key: x.key, id: i, img: { width: x.columns * x.frameW, height: x.rows * x.frameH }, emis: x.masks?.emissive ? {} : null, masks: x.masks?.sway ? { sway: {} } : {}, scale: 1, cold: false, count: x.columns * x.rows }));
    await a.fitBudget(list, KEEP, KEEP, KEEP); a.pools = []; a.planPool(pages, 8, list, "veh", true);
    const pool = a.pools[0];
    expect(pool.perLayer).toBe(4); expect(pool.k).toBe(1); expect(pool.lru.capacity).toBe(8); expect(pool.layers).toBe(2);
  });
});
