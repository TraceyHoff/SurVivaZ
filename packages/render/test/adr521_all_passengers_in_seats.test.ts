import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { World, Transform } from "@engine/core";
import { loadManifest, mergeManifests } from "@engine/assets";
import { PACK_DIR, readManifestJson } from "@engine/assets/node";
import { LightSource, Occluder, Sprite, VehicleView, artSeat, windowBand, VEHICLE_SEAT_ART, PX_PER_M_HEIGHT, RIDER_CLIP_HIDDEN, RIDER_HEAD_PX, VIEW_RISE, type VehicleRenderDef } from "../src/index.js";

/**
 * ADR-521: every player/AI-human occupant draws in a seat. ADR-518 seated riders on Art's seats but hid gameplay
 * seats beyond Art's (van 8 vs 4, pickup 3 vs 2, RV 6 vs 2) and had no seat at all for the pickup bed or the van's
 * rear rows. ADR-521 adds the missing seats as data only (no new art): van rows 3-4 under the side glass, the pickup
 * bed rider clipped to the bed rail, and RV rows 2-3 under the box's rear side windows. The cabin box the window
 * clip is measured against is the cabin seats only, so the bed seat (behind the cab) cannot close the cab riders'
 * rear-view band.
 */
const raw = JSON.parse(readFileSync(join(__dirname, "../../gameplay/data/vehicles.json"), "utf8")) as { vehicles?: VehicleRenderDef[] } | VehicleRenderDef[];
const DEFS = (Array.isArray(raw) ? raw : raw.vehicles!) as VehicleRenderDef[];
const def = (id: string): VehicleRenderDef => DEFS.find((d) => d.id === id)!;
const VM = readManifestJson(PACK_DIR + "vehicles/manifest.vehicles.json") as any;
const reg = loadManifest(mergeManifests([{ name: "pack", manifest: readManifestJson(PACK_DIR + "manifest.json") }, { name: "vehicles", manifest: VM }] as never).manifest).registry;
const mk = () => { const w = new World(); w.register(Transform); for (const c of [Sprite, LightSource, Occluder]) w.register(c); return w; };
/** engine heading for Art's facing: E -pi/4, S pi/4, W 3pi/4, N 5pi/4 (ART_DIR_OFFSET 1, as in adr518). */
const H = { E: -Math.PI / 4, S: Math.PI / 4, W: (3 * Math.PI) / 4, N: (5 * Math.PI) / 4 } as const;

describe("ADR-521 all passengers in seats", () => {
  it("every gameplay seat has an Art window seat: van 8/8, pickup 3/3, RV 6/6 (was 4/2/2)", () => {
    for (const [id, n] of [["van_passenger", 8], ["truck_pickup", 3], ["camper_rv", 6]] as const) {
      const d = def(id);
      expect(VEHICLE_SEAT_ART[id]!.seats.length).toBe(n);
      for (let i = 0; i < n; i++) {
        const a = artSeat(d, i)!;
        expect(a.draw, `${id} seat ${i}`).toBe("window");
        expect(a.clipTop, `${id} seat ${i}`).toBeGreaterThan(a.clipBottom);
      }
    }
    // the added seats sit under the measured glass: van rows 3-4 share the cab's belt/roof, RV rows 2-3 the box's
    // rear side windows (belt 1.66 = the window's lower edge on both sides, roof 2.29 = the W side's upper edge).
    expect(artSeat(def("van_passenger"), 4)!.clipBottom).toBeCloseTo((0.813 - 0.7) * PX_PER_M_HEIGHT, 6);
    expect(artSeat(def("van_passenger"), 4)!.clipTop).toBeCloseTo((1.704 - 0.7) * PX_PER_M_HEIGHT, 6);
    expect(artSeat(def("camper_rv"), 2)!.clipBottom).toBeCloseTo((1.66 - 1.05) * PX_PER_M_HEIGHT, 6);
    expect(artSeat(def("camper_rv"), 2)!.clipTop).toBeCloseTo((2.29 - 1.05) * PX_PER_M_HEIGHT, 6);
    // the bed seat is outside the cabin (cabin 0): it is clipped to its own rail band but does not extend the cabin box.
    expect(VEHICLE_SEAT_ART["truck_pickup"]!.seats[2]![6]).toBe(0);
    expect(VEHICLE_SEAT_ART["van_passenger"]!.seats.every((s) => s[6] === 1)).toBe(true);
    expect(VEHICLE_SEAT_ART["camper_rv"]!.seats.every((s) => s[6] === 1)).toBe(true);
  });

  it("a full house syncs every occupant onto a seat: near-side riders show through the glass, far-side hide", () => {
    const w = mk(); const v = new VehicleView(w, reg, { art: true });
    // E view: the +v side is near, so the right-hand riders show and the left-hand riders hide.
    const e = v.sync([
      { key: 1, def: def("van_passenger"), x: 10, y: 10, heading: H.E, occupants: [201, 202, 203, 204, 205, 206, 207, 208] },
      { key: 2, def: def("truck_pickup"), x: 20, y: 5, heading: H.E, occupants: [211, 212, 213] },
      { key: 3, def: def("camper_rv"), x: 30, y: 30, heading: H.E, occupants: [221, 222, 223, 224, 225, 226] },
    ], 0, { darkness: 0 });
    const by = (r: number) => e.find((p) => p.rider === r)!;
    for (const r of [201, 202, 203, 204, 205, 206, 207, 208]) expect(by(r).seat, `van rider ${r}`).toBe(r - 201);
    for (const r of [211, 212, 213]) expect(by(r).seat, `pickup rider ${r}`).toBe(r - 211);
    for (const r of [221, 222, 223, 224, 225, 226]) expect(by(r).seat, `rv rider ${r}`).toBe(r - 221);
    const shows = (r: number) => by(r).clip !== undefined && by(r).clip!.bottom < 1e3;
    // van: every right-hand seat (odd index) shows, every left-hand seat hides.
    for (const r of [202, 204, 206, 208]) expect(shows(r), `van rider ${r} shows (E)`).toBe(true);
    for (const r of [201, 203, 205, 207]) expect(by(r).clip, `van rider ${r} hides (E)`).toEqual(RIDER_CLIP_HIDDEN);
    // pickup: passenger + bed rider show, driver hides.
    expect(shows(212)).toBe(true); expect(shows(213)).toBe(true); expect(by(211).clip).toEqual(RIDER_CLIP_HIDDEN);
    // RV: passenger + both right-hand box rows show, driver + both left-hand box rows hide.
    for (const r of [222, 224, 226]) expect(shows(r), `rv rider ${r} shows (E)`).toBe(true);
    for (const r of [221, 223, 225]) expect(by(r).clip, `rv rider ${r} hides (E)`).toEqual(RIDER_CLIP_HIDDEN);
    // W view: the mirror image — the left-hand riders show.
    const wv = new VehicleView(mk(), reg, { art: true });
    const wout = wv.sync([
      { key: 1, def: def("van_passenger"), x: 10, y: 10, heading: H.W, occupants: [201, 202, 203, 204, 205, 206, 207, 208] },
      { key: 2, def: def("truck_pickup"), x: 20, y: 5, heading: H.W, occupants: [211, 212, 213] },
      { key: 3, def: def("camper_rv"), x: 30, y: 30, heading: H.W, occupants: [221, 222, 223, 224, 225, 226] },
    ], 0, { darkness: 0 });
    const byW = (r: number) => wout.find((p) => p.rider === r)!;
    const showsW = (r: number) => byW(r).clip !== undefined && byW(r).clip!.bottom < 1e3;
    for (const r of [201, 203, 205, 207]) expect(showsW(r), `van rider ${r} shows (W)`).toBe(true);
    for (const r of [202, 204, 206, 208]) expect(byW(r).clip, `van rider ${r} hides (W)`).toEqual(RIDER_CLIP_HIDDEN);
    expect(showsW(211)).toBe(true); expect(showsW(213)).toBe(true); expect(byW(212).clip).toEqual(RIDER_CLIP_HIDDEN);
    for (const r of [221, 223, 225]) expect(showsW(r), `rv rider ${r} shows (W)`).toBe(true);
    for (const r of [222, 224, 226]) expect(byW(r).clip, `rv rider ${r} hides (W)`).toEqual(RIDER_CLIP_HIDDEN);
  });

  it("the bed rider sits in the bed: clipped to the rail in the side view, hidden from ahead, seen from behind", () => {
    // side view (E): the rail is the beltline — the band bottom is the rail lowered by the side distance; the roof
    // is open sky (2.8 m), unlowered since ADR-525 (a), so the head clears; the legs below the rail are hidden.
    const bandE = windowBand(def("truck_pickup"), 2, 0, 1)!;
    expect(bandE.bottom).toBeCloseTo((1.39 - 1.0 - 1.0 * VIEW_RISE) * PX_PER_M_HEIGHT, 3);
    expect(bandE.top).toBeCloseTo((2.8 - 1.0) * PX_PER_M_HEIGHT, 3); // ADR-525 (a): open sky, no lowering
    expect(bandE.top).toBeGreaterThan(RIDER_HEAD_PX - 3); // the head shows (top within 3 px of the head top)
    const w = mk(); const v = new VehicleView(w, reg, { art: true });
    const out = v.sync([{ key: 1, def: def("truck_pickup"), x: 10, y: 10, heading: H.E, occupants: [0, 0, 213] }], 0, { darkness: 0 });
    const bed = out.find((p) => p.rider === 213)!;
    expect(bed.clip!.bottom).toBeCloseTo(bandE.bottom, 6); expect(bed.clip!.top).toBeCloseTo(bandE.top, 6);
    // from ahead (S) the cab hides the bed rider entirely: the open-sky roof (2.8 m) is below the front-view hide
    // threshold (2.86 m), so no lap shows through the cab. With roof 3.0 the lap would show — a ghost.
    const w2 = new VehicleView(mk(), reg, { art: true });
    const outS = w2.sync([{ key: 1, def: def("truck_pickup"), x: 10, y: 10, heading: H.S, occupants: [0, 0, 213] }], 0, { darkness: 0 });
    expect(outS.find((p) => p.rider === 213)!.clip).toEqual(RIDER_CLIP_HIDDEN);
    expect(windowBand(def("truck_pickup"), 2, 1, 0)).toBeUndefined();
    // from behind (N) the bed rider shows above the tailgate.
    const w3 = new VehicleView(mk(), reg, { art: true });
    const outN = w3.sync([{ key: 1, def: def("truck_pickup"), x: 10, y: 10, heading: H.N, occupants: [0, 0, 213] }], 0, { darkness: 0 });
    const bedN = outN.find((p) => p.rider === 213)!;
    expect(bedN.clip).not.toEqual(RIDER_CLIP_HIDDEN);
    expect(bedN.clip!.bottom).toBeCloseTo((1.39 - 1.0) * PX_PER_M_HEIGHT, 3); // unlowered: the tailgate is at the seat
  });

  it("the cabin box is the cabin seats only: the bed seat does not extend it (front view + bed rear view pin the box)", () => {
    // ADR-525 (b): the pickup has no rear window, so the cab riders' rear-view band is now undefined by the
    // rear-glass rule — not by the box. The box is still pinned by the front view (u1, the windscreen) and by the
    // bed seat's own rear-view band: without the cabin flag the bed seat (u -1.5) would extend the box to u0 -2.25,
    // the bed's rear-view D would be 0.75 (not 0), and its bottom would dip to -5.2 instead of +11.8.
    expect(windowBand(def("truck_pickup"), 0, -1, 0)).toBeUndefined();
    expect(windowBand(def("truck_pickup"), 1, -1, 0)).toBeUndefined();
    const bandS = windowBand(def("truck_pickup"), 0, 1, 0)!; // front view, through the windscreen
    expect(bandS.bottom).toBeCloseTo((1.066 - 0.85 - 0.75 * VIEW_RISE) * PX_PER_M_HEIGHT, 3);
    expect(bandS.top).toBeCloseTo((1.755 - 0.85 - 0.25 * VIEW_RISE) * PX_PER_M_HEIGHT, 3);
    const bedN = windowBand(def("truck_pickup"), 2, -1, 0)!; // the bed seat's rear view: D 0, bottom unlowered
    expect(bedN.bottom).toBeCloseTo((1.39 - 1.0) * PX_PER_M_HEIGHT, 3);
    expect(bedN.top).toBeCloseTo((2.8 - 1.0) * PX_PER_M_HEIGHT, 3); // ADR-525 (a): open sky
    const w = mk(); const v = new VehicleView(w, reg, { art: true });
    const out = v.sync([{ key: 1, def: def("truck_pickup"), x: 10, y: 10, heading: H.S, occupants: [211, 212, 0] }], 0, { darkness: 0 });
    const by = (r: number) => out.find((p) => p.rider === r)!;
    expect(by(211).clip!.bottom).toBeCloseTo(bandS.bottom, 6); expect(by(211).clip!.top).toBeCloseTo(bandS.top, 6);
    expect(by(212).clip!.bottom).toBeCloseTo(bandS.bottom, 6); expect(by(212).clip!.top).toBeCloseTo(bandS.top, 6);
  });

  it("rear rows show from behind and hide from ahead (van rows 3-4, RV rows 2-3)", () => {
    const w = mk(); const v = new VehicleView(w, reg, { art: true });
    const outN = v.sync([
      { key: 1, def: def("van_passenger"), x: 10, y: 10, heading: H.N, occupants: [201, 202, 203, 204, 205, 206, 207, 208] },
      { key: 2, def: def("camper_rv"), x: 30, y: 30, heading: H.N, occupants: [221, 222, 223, 224, 225, 226] },
    ], 0, { darkness: 0 });
    const byN = (r: number) => outN.find((p) => p.rider === r)!;
    const showsN = (r: number) => byN(r).clip !== undefined && byN(r).clip!.bottom < 1e3;
    // van: rows 3-4 (the rearmost) show through the rear window; rows 1-2 hide behind them.
    for (const r of [205, 206, 207, 208]) expect(showsN(r), `van rider ${r} shows (N)`).toBe(true);
    for (const r of [201, 202, 203, 204]) expect(byN(r).clip, `van rider ${r} hides (N)`).toEqual(RIDER_CLIP_HIDDEN);
    // RV: every row hides — the RV has no rear window (ADR-525 (b)), so there is no glass to show through;
    // the van's rearmost rows show through its rear window, as before.
    for (const r of [223, 224, 225, 226]) expect(byN(r).clip, `rv rider ${r} hides (N)`).toEqual(RIDER_CLIP_HIDDEN);
    for (const r of [221, 222]) expect(byN(r).clip, `rv rider ${r} hides (N)`).toEqual(RIDER_CLIP_HIDDEN);
    // from ahead the rear rows hide behind the front rows / cab.
    const w2 = new VehicleView(mk(), reg, { art: true });
    const outS = w2.sync([
      { key: 1, def: def("van_passenger"), x: 10, y: 10, heading: H.S, occupants: [201, 202, 203, 204, 205, 206, 207, 208] },
      { key: 2, def: def("camper_rv"), x: 30, y: 30, heading: H.S, occupants: [221, 222, 223, 224, 225, 226] },
    ], 0, { darkness: 0 });
    const byS = (r: number) => outS.find((p) => p.rider === r)!;
    for (const r of [205, 206, 207, 208]) expect(byS(r).clip, `van rider ${r} hides (S)`).toEqual(RIDER_CLIP_HIDDEN);
    for (const r of [223, 224, 225, 226]) expect(byS(r).clip, `rv rider ${r} hides (S)`).toEqual(RIDER_CLIP_HIDDEN);
    for (const r of [201, 202, 203, 204]) expect(byS(r).clip!.bottom, `van rider ${r} shows (S)`).toBeLessThan(1e3);
    for (const r of [221, 222]) expect(byS(r).clip!.bottom, `rv rider ${r} shows (S)`).toBeLessThan(1e3);
  });
});
