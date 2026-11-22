import { Shadow } from "../src/components.js";
import { modelZScale, targetHeightPx, PLAYER_HEIGHT_PX, modelHeight, VEHICLE_STATE_HEADLIGHTS, VEHICLE_STATE_ENGINE_ON } from "../src/index.js";
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { World, Transform } from "@engine/core";
import { AssetRegistry, loadManifest, mergeManifests, type ManifestJson } from "@engine/assets";
import {
  LightSource, Occluder, Sprite, VehicleView, PoseSmoother, quantizeDir8, lerpAngleShortest, wrapAngle, trailerPose, hitchU, segmentCount, segmentU,
  seatAnchors, toWorld, vehicleManifestEntries, vehicleSpriteKey, vehicleFrame, depthNudge, insideFootprint, type VehicleRenderDef,
} from "../src/index.js";

const raw = JSON.parse(readFileSync(join(__dirname, "../../gameplay/data/vehicles.json"), "utf8")) as { vehicles?: VehicleRenderDef[] } | VehicleRenderDef[];
const DEFS = (Array.isArray(raw) ? raw : raw.vehicles!) as VehicleRenderDef[];
const def = (id: string): VehicleRenderDef => DEFS.find((d) => d.id === id)!;
const ART = join(__dirname, "../../../assets");
const stalls = JSON.parse(readFileSync(join(ART, "stalls/manifest.fragment.json"), "utf8")) as ManifestJson;
const vm: ManifestJson = { ...stalls, atlases: [], sprites: [] } as ManifestJson;
for (const d of DEFS) { const e = vehicleManifestEntries(d); vm.atlases.push(e.atlas); vm.sprites.push(...e.sprites); }
const { registry: reg } = loadManifest(mergeManifests([{ name: "stalls", manifest: stalls }, { name: "veh", manifest: vm }]).manifest);
const mk = () => { const w = new World(); w.register(Transform); for (const c of [Sprite, LightSource, Occluder]) w.register(c); return w; };
const ZF = 1 / 3, key = (t: { x: number; y: number; z: number }) => t.x + t.y + t.z * ZF;

describe("vehicle direction quantization", () => {
  it("8 rows, round to nearest 45deg, wraps negatives; matches AssetRegistry.directionIndex", () => {
    expect([0, 0.39, 0.4, Math.PI / 2, Math.PI, -Math.PI / 4, -0.1, 2 * Math.PI - 0.1, 7 * Math.PI].map(quantizeDir8)).toEqual([0, 0, 1, 2, 4, 7, 0, 0, 4]);
    for (let a = -7; a < 7; a += 0.13) expect(quantizeDir8(a)).toBe(AssetRegistry.directionIndex(a, 8));
  });
  it("manifest: one atlas per def, 8 rows, segment columns (+ _int for interiors), dirStride = columns", () => {
    const rv = def("camper_rv"), n = segmentCount(rv), e = vehicleManifestEntries(rv);
    expect(n).toBe(6); expect(e.atlas).toMatchObject({ key: "veh_camper_rv", rows: 8, columns: 2 * n });
    expect(e.sprites.map((s) => s.key)).toContain("veh_camper_rv_s5_int");
    const f = reg.frame(reg.id(vehicleSpriteKey("camper_rv", 2)), "idle", Math.PI / 2, 0);
    expect(f.frame).toBe(2 + 2 * (2 * n)); // row 2 (heading 90deg), column 2
    expect(segmentCount(def("bike_basic"))).toBe(2); expect(segmentCount(def("semi_trailer_box"))).toBe(8);
    const fr = vehicleFrame(def("car_sedan")); expect(fr.w).toBeLessThan(256); expect(fr.h).toBeLessThan(200);
  });
});

describe("smoothing", () => {
  it("shortest-arc lerp across the +-PI wrap never spins the long way", () => {
    const a = Math.PI - 0.1, b = -Math.PI + 0.1;
    const m = lerpAngleShortest(a, b, 0.5); expect(Math.abs(wrapAngle(m - Math.PI))).toBeLessThan(1e-9);
    expect(lerpAngleShortest(a, b, 0.25)).toBeCloseTo(Math.PI - 0.05);
    const s = new PoseSmoother(0.1); s.update({ x: 0, y: 0, z: 0, heading: a, drift: 0 }, 0.016);
    let maxStep = 0, prev = s.heading;
    for (let i = 0; i < 60; i++) { s.update({ x: 0.1 * i, y: 0, z: 0, heading: b, drift: 0 }, 0.016); maxStep = Math.max(maxStep, Math.abs(wrapAngle(s.heading - prev))); prev = s.heading; }
    expect(maxStep).toBeLessThan(0.05); expect(Math.abs(wrapAngle(s.heading - b))).toBeLessThan(0.01);
  });
  it("position approaches exponentially and snaps on teleport", () => {
    const s = new PoseSmoother(0.1, 4); s.update({ x: 0, y: 0, z: 0, heading: 0, drift: 0 }, 0);
    s.update({ x: 1, y: 0, z: 0, heading: 0, drift: 0 }, 0.1); expect(s.x).toBeCloseTo(1 - Math.exp(-1));
    s.update({ x: 50, y: 50, z: 0, heading: 1, drift: 0 }, 0.016); expect(s).toMatchObject({ x: 50, y: 50, heading: 1 });
  });
});

describe("trailers", () => {
  it("front hitch pinned to the tow's rear hitch, own heading", () => {
    const tow = def("truck_pickup"), tr = def("trailer_cargo_medium");
    for (const th of [0, 0.9, -2.5]) for (const rel of [0, 0.6, -1.2]) {
      const p = trailerPose(tow, 3, 4, th, tr, th + rel)!; expect(p.heading).toBe(th + rel);
      const pin = toWorld(3, 4, th, hitchU(tow, "rear")!, 0), front = toWorld(p.x, p.y, p.heading, hitchU(tr, "front")!, 0);
      expect(front[0]).toBeCloseTo(pin[0]); expect(front[1]).toBeCloseTo(pin[1]);
    }
    expect(trailerPose(def("car_sedan"), 0, 0, 0, tr, 0)).toBeUndefined();
  });
  it("VehicleView re-poses the trailer from the smoothed tow (joint stays closed mid-smoothing)", () => {
    const w = mk(); const v = new VehicleView(w, reg); const tow = def("truck_pickup"), tr = def("trailer_cargo_medium");
    const snap = (x: number) => [{ key: 1, def: tow, x, y: 0, heading: 0 }, { key: 2, def: tr, x: x - 2.9 - 2.6 + 0.3, y: 0.3, heading: 0.2, parent: 1 }];
    v.sync(snap(0), 0.016, { darkness: 0 }); v.sync(snap(1), 0.016, { darkness: 0 });
    const a = v.pose(1)!, b = v.pose(2)!; const pin = toWorld(a.x, a.y, a.heading, -2.9, 0), fr = toWorld(b.x, b.y, b.heading, 2.6, 0);
    expect(Math.hypot(pin[0] - fr[0], pin[1] - fr[1])).toBeLessThan(1e-9); expect(b.heading).toBeCloseTo(0.2);
  });
});

describe("depth order for long footprints", () => {
  it("segments along the heading; a character beside the rear is behind/in front of the right segment", () => {
    const w = mk(); const v = new VehicleView(w, reg); const d = def("semi_trailer_box");
    v.sync([{ key: 7, def: d, x: 20, y: 20, heading: Math.PI / 4 }], 0, { darkness: 0 }); // nose toward the camera (+x+y)
    const segs = v.recs.get(7)!.segs.map((e) => w.get(e, Transform)!); expect(segs.length).toBe(8);
    for (let i = 1; i < segs.length; i++) expect(key(segs[i]!)).toBeLessThan(key(segs[i - 1]!)); // front closest
    // a character standing 0.5 tiles behind the tail is behind every segment except none; one beside the nose is in front of the tail
    const tail = toWorld(20, 20, Math.PI / 4, -d.footprint.length / 2 - 0.5, 0), nose = toWorld(20, 20, Math.PI / 4, d.footprint.length / 2 - 0.5, 1.6);
    expect(key({ x: tail[0], y: tail[1], z: 0 })).toBeLessThan(key(segs[segs.length - 1]!));
    expect(key({ x: nose[0], y: nose[1], z: 0 })).toBeGreaterThan(key(segs[segs.length - 1]!));
    expect(Math.abs(segmentU(d, 0) - segmentU(d, 1))).toBeCloseTo(13 / 8);
  });
  it("depthNudge keeps the screen position", () => {
    const p = { x: 3, y: 5, z: 1 }; const sx = (p.x - p.y) * 32, sy = (p.x + p.y) * 16 - p.z * 16; depthNudge(p, -0.2, { tileH: 32, zStep: 16 }, ZF);
    expect((p.x - p.y) * 32).toBeCloseTo(sx); expect((p.x + p.y) * 16 - p.z * 16).toBeCloseTo(sy); expect(key(p)).toBeCloseTo(3 + 5 + 1 / 3 - 0.2);
  });
});

describe("seats", () => {
  it("driver front-left, rows of two, bikes on the centreline; riders cropped behind their segment", () => {
    const s = seatAnchors(def("car_sedan")); expect(s.length).toBe(4);
    expect(s[0]!.v).toBeGreaterThan(0); expect(s[1]!.v).toBeLessThan(0); expect(s[2]!.u).toBeLessThan(s[0]!.u); expect(s[0]!.cabin).toBe(true);
    expect(seatAnchors(def("bike_tandem")).every((a) => a.v === 0 && !a.cabin)).toBe(true);
    // ADR-101: anchors come from vehicles.json (ported from the computed layout) and hitches carry anchor.x
    for (const d of DEFS) {
      expect(d.seatAnchors?.length).toBe(d.seats);
      const k = modelZScale(d); seatAnchors(d, k).forEach((a, i) => { expect(a.u).toBe(d.seatAnchors![i]!.x); expect(a.z).toBeCloseTo(d.seatAnchors![i]!.z * k, 5); });
      for (const h of d.hitches) expect(hitchU(d, h.at)).toBe(h.anchor!.x);
    }
    expect(seatAnchors({ ...def("car_sedan"), seatAnchors: [{ x: 9, y: 8, z: 7 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }] })[0]).toEqual({ u: 9, v: 8, z: 7, cabin: true });
    const w = mk(); const v = new VehicleView(w, reg); const d = def("car_sedan");
    const out = v.sync([{ key: 3, def: d, x: 10, y: 10, heading: 0.1, occupants: [101, 0, 0, 104] }], 0, { darkness: 0 });
    expect(out.map((r) => [r.rider, r.seat])).toEqual([[101, 0], [104, 3]]);
    const r0 = out[0]!; expect(r0.facing).toBe(0); expect(r0.cropped).toBe(true);
    const seg = w.get(v.recs.get(3)!.segs[0]!, Transform)!, seg1 = w.get(v.recs.get(3)!.segs[1]!, Transform)!;
    expect(key(r0)).toBeLessThan(Math.max(key(seg), key(seg1)));
    // screen position = seat anchor (depth nudge only slides along the view ray)
    const a = seatAnchors(d, modelZScale(d))[0]!, [ax, ay] = toWorld(10, 10, 0, a.u, a.v);
    expect((r0.x - r0.y) * 32).toBeCloseTo((ax - ay) * 32); expect((r0.x + r0.y) * 16 - r0.z * 16).toBeCloseTo((ax + ay) * 16 - a.z * 16);
    const bike = v.sync([{ key: 4, def: def("bike_basic"), x: 0, y: 0, heading: 0, occupants: [9] }], 0, { darkness: 0 })[0]!;
    expect(bike.cropped).toBe(false);
  });
});

describe("headlights", () => {
  it("lit only when on and dark; 3 cone lights ahead of the heading, 1 on lowend; trailers never", () => {
    const w = mk(); const v = new VehicleView(w, reg); const d = def("car_sedan");
    const s = [{ key: 1, def: d, x: 0, y: 0, heading: Math.PI / 2, occupants: [5] }, { key: 2, def: def("trailer_tanker"), x: 0, y: -8, heading: 0, on: true }];
    v.sync(s, 0, { darkness: 0 }); expect(w.store(LightSource).size).toBe(0);
    v.sync(s, 0, { darkness: 1 }); expect(w.store(LightSource).size).toBe(3);
    for (const e of v.recs.get(1)!.lights) expect(w.get(e, Transform)!.y).toBeGreaterThan(d.footprint.length / 2);
    v.sync(s, 0, { darkness: 1, lowEnd: true }); expect(w.store(LightSource).size).toBe(1);
    v.sync([{ ...s[0]!, occupants: [0], speed: 0 }], 0, { darkness: 1 }); expect(w.store(LightSource).size).toBe(0);
  });
});

describe("camper interior", () => {
  it("swaps to _int cutaway sprites when the local rider is inside or standing in it; others stay exterior", () => {
    const w = mk(); const v = new VehicleView(w, reg); const d = def("camper_van");
    const ids = () => v.recs.get(1)!.segs.map((e) => w.get(e, Sprite)!.spriteId);
    const ext = [...Array(segmentCount(d)).keys()].map((i) => reg.id(vehicleSpriteKey(d.id, i))), int = ext.map((_, i) => reg.id(vehicleSpriteKey(d.id, i, true)));
    const s = { key: 1, def: d, x: 5, y: 5, heading: 0, occupants: [0, 77] };
    v.sync([s], 0, { darkness: 0, localRider: 12 }); expect(ids()).toEqual(ext); expect(v.pose(1)!.interior).toBe(false);
    v.sync([s], 0, { darkness: 0, localRider: 77 }); expect(ids()).toEqual(int); expect(v.pose(1)!.interior).toBe(true);
    v.sync([s], 0, { darkness: 0, localRider: 12, localPos: { x: 5.5, y: 5 } }); expect(ids()).toEqual(int);
    v.sync([s], 0, { darkness: 0, localRider: 12, localPos: { x: 9, y: 5 } }); expect(ids()).toEqual(ext);
    v.sync([{ key: 2, def: def("car_sedan"), x: 0, y: 0, heading: 0, occupants: [77] }], 0, { darkness: 0, localRider: 77 });
    expect(v.pose(2)!.interior).toBe(false); expect(v.recs.has(1)).toBe(false); // camper gone -> entities dropped
    expect(insideFootprint(d, 0, 0, Math.PI / 2, 0, 2.5)).toBe(true);
  });
});

describe("per-type scale (ADR-518: true real-world scale next to the 53 px / 1.75 m player)", () => {
  it("sedan roof 1.45 m (0.83x player), semi 3.9 m (2.23x), ordering bike < car < pickup < van/camper < semi", () => {
    const h = (id: string) => targetHeightPx(def(id)) / PLAYER_HEIGHT_PX;
    expect(PLAYER_HEIGHT_PX).toBe(53);
    expect(h("car_sedan")).toBeCloseTo(1.45 / 1.75, 3); expect(targetHeightPx(def("car_sedan"))).toBeCloseTo(44, 0);
    expect(h("semi_tractor")).toBeCloseTo(3.9 / 1.75, 3);
    expect(h("bike_basic")).toBeLessThan(h("car_sedan")); expect(h("car_sedan")).toBeLessThan(h("truck_pickup"));
    expect(h("truck_pickup")).toBeLessThan(h("van_cargo")); expect(h("van_cargo")).toBeLessThan(h("camper_rv")); expect(h("camper_rv")).toBeLessThan(h("semi_tractor"));
    for (const d of DEFS) expect(modelHeight(d)).toBeCloseTo(targetHeightPx(d) / 16, 3);
  });
  it("headlights follow the VehicleState byte", () => {
    const w = mk(); const v = new VehicleView(w, reg); const d = def("car_sedan");
    const lights = (state: number) => { v.sync([{ key: 1, def: d, x: 0, y: 0, heading: 0, state }], 0, { darkness: 1 }); return v.recs.get(1)!.lights.length; };
    expect(lights(VEHICLE_STATE_ENGINE_ON)).toBe(0); expect(lights(VEHICLE_STATE_ENGINE_ON | VEHICLE_STATE_HEADLIGHTS)).toBeGreaterThan(0);
  });
});

describe("seated riders", () => {
  it("ground shadow suppressed while seated, restored on exit", () => {
    const w = mk(); w.register(Shadow); const v = new VehicleView(w, reg); const d = def("car_sedan"); const r = w.create();
    w.add(r, Transform, { x: 0, y: 0, z: 0, facing: 0 }); w.add(r, Shadow, { alpha: 0.8, length: 1 });
    v.sync([{ key: 1, def: d, x: 0, y: 0, heading: 0, occupants: [r, 0, 0, 0] }], 0, { darkness: 0 }); expect(w.get(r, Shadow)!.alpha).toBe(0);
    v.sync([{ key: 1, def: d, x: 0, y: 0, heading: 0, occupants: [0, 0, 0, 0] }], 0, { darkness: 0 }); expect(w.get(r, Shadow)!.alpha).toBeCloseTo(0.8);
  });
});
