import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { World, Transform } from "@engine/core";
import { AssetRegistry, loadManifest, mergeManifests, type ManifestJson } from "@engine/assets";
import {
  LightSource, Occluder, Sprite, VehicleView, quantizeDir8,
  seatAnchors, toWorld, vehicleManifestEntries, modelZScale, type VehicleRenderDef,
} from "../src/index.js";

const raw = JSON.parse(readFileSync(join(__dirname, "../../gameplay/data/vehicles.json"), "utf8")) as { vehicles?: VehicleRenderDef[] } | VehicleRenderDef[];
const DEFS = (Array.isArray(raw) ? raw : raw.vehicles!) as VehicleRenderDef[];
const def = (id: string): VehicleRenderDef => DEFS.find((d) => d.id === id)!;
const DRAWN = ["wagon_small", "wagon_small_covered", "wagon_medium", "wagon_medium_covered", "wagon_large", "wagon_large_covered", "cart", "carriage", "chariot"];
const ART = join(__dirname, "../../../assets");
const stalls = JSON.parse(readFileSync(join(ART, "stalls/manifest.fragment.json"), "utf8")) as ManifestJson;
const vm: ManifestJson = { ...stalls, atlases: [], sprites: [] } as ManifestJson;
for (const d of DEFS) { const e = vehicleManifestEntries(d); vm.atlases.push(e.atlas); vm.sprites.push(...e.sprites); }
const { registry: reg } = loadManifest(mergeManifests([{ name: "stalls", manifest: stalls }, { name: "veh", manifest: vm }]).manifest);
const mk = () => { const w = new World(); w.register(Transform); for (const c of [Sprite, LightSource, Occluder]) w.register(c); return w; };

describe("ADR-360 drawn riders", () => {
  it("every drawn def seats its driver (and passengers) at the seat anchors, all 8 directions", () => {
    for (const id of DRAWN) {
      const d = def(id); const w = mk(); const v = new VehicleView(w, reg);
      const anchors = seatAnchors(d, modelZScale(d));
      expect(anchors.length).toBe(d.seats);
      for (let dir = 0; dir < 8; dir++) {
        const heading = dir * Math.PI / 4;
        const occupants = anchors.map((_, i) => 101 + i);
        const out = v.sync([{ key: 100 + dir, def: d, x: 10, y: 10, heading, occupants }], 0, { darkness: 0 });
        expect(out.map((r) => [r.rider, r.seat])).toEqual(occupants.map((r, i) => [r, i]));
        for (const [i, r] of out.entries()) {
          expect(r.vehicle).toBe(100 + dir);
          expect(r.facing).toBe(heading); // quantized heading, exactly on the 8-grid
          // screen position = seat anchor (depth nudge only slides along the view ray)
          const a = anchors[i]!, [ax, ay] = toWorld(10, 10, heading, a.u, a.v);
          expect((r.x - r.y) * 32).toBeCloseTo((ax - ay) * 32);
          expect((r.x + r.y) * 16 - r.z * 16).toBeCloseTo((ax + ay) * 16 - a.z * 16);
        }
      }
    }
  });
  it("off-grid headings quantize: the rider faces the vehicle's quantized heading, anchor rotated by it", () => {
    for (const id of ["wagon_medium", "chariot"]) {
      const d = def(id); const w = mk(); const v = new VehicleView(w, reg);
      const a = seatAnchors(d, modelZScale(d))[0]!;
      for (let dir = 0; dir < 8; dir++) {
        const heading = dir * Math.PI / 4 + 0.2; // between grid lines
        const out = v.sync([{ key: 7 + dir, def: d, x: 0, y: 0, heading, occupants: [55] }], 0, { darkness: 0 }); // fresh key: the smoother snaps to the snapshot heading
        expect(out.length).toBe(1);
        expect(out[0]!.facing).toBe(dir * Math.PI / 4); // the quantized heading, as an angle
        expect(quantizeDir8(heading)).toBe(dir); // and the index agrees
        const [ax, ay] = toWorld(0, 0, dir * Math.PI / 4, a.u, a.v);
        expect((out[0]!.x - out[0]!.y) * 32).toBeCloseTo((ax - ay) * 32);
      }
    }
  });
  it("a carriage carries four riders (front bench + rear seats); a chariot two, side by side", () => {
    const w = mk(); const v = new VehicleView(w, reg);
    const car = v.sync([{ key: 3, def: def("carriage"), x: 0, y: 0, heading: Math.PI / 4, occupants: [201, 202, 203, 204] }], 0, { darkness: 0 });
    expect(car.map((r) => [r.rider, r.seat])).toEqual([[201, 0], [202, 1], [203, 2], [204, 3]]);
    const anchors = seatAnchors(def("carriage"), modelZScale(def("carriage")));
    expect(anchors[2]!.u).toBeLessThan(anchors[0]!.u); // rear seats sit behind the front bench
    expect(anchors[0]!.v).toBeGreaterThan(0); expect(anchors[1]!.v).toBeLessThan(0); // left / right
    const ch = v.sync([{ key: 4, def: def("chariot"), x: 5, y: 5, heading: 0, occupants: [301, 302] }], 0, { darkness: 0 });
    expect(ch.map((r) => [r.rider, r.seat])).toEqual([[301, 0], [302, 1]]);
    // side by side on screen (their z differs by design: depth-nudging slides each to its own segment's key)
    expect(Math.abs((ch[0]!.x - ch[0]!.y) - (ch[1]!.x - ch[1]!.y))).toBeGreaterThan(0.1);
  });
  it("drawn vehicles never light headlights, even with a driver seated at full dark", () => {
    const w = mk(); const v = new VehicleView(w, reg);
    const list = DRAWN.map((id, i) => ({ key: 10 + i, def: def(id), x: i * 10, y: 0, heading: 0, occupants: [400 + i] }));
    v.sync(list, 0, { darkness: 1 });
    expect(w.store(LightSource).size).toBe(0); // no engine, no lights — unlike a motor vehicle with its driver in
    const moving = DRAWN.map((id, i) => ({ key: 10 + i, def: def(id), x: i * 10, y: 0, heading: 0, occupants: [400 + i], speed: 5 }));
    v.sync(moving, 0, { darkness: 1 });
    expect(w.store(LightSource).size).toBe(0); // moving changes nothing: headlightCone is empty for unpowered defs
  });
});
