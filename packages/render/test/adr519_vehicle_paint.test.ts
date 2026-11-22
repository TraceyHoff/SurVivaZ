import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { World, Transform } from "@engine/core";
import { loadManifest, mergeManifests } from "@engine/assets";
import { PACK_DIR, readManifestJson } from "@engine/assets/node";
import { LightSource, Occluder, Sprite, TintNeutral, VehicleView, VEHICLE_PAINT, VEHICLE_PAINT_SETS, vehiclePaint, type VehicleRenderDef } from "../src/index.js";
import { PAINT_MASK_ONLY, writePaint } from "../src/sprites.js";
import { tintPaintPixels } from "../src/canvas2d.js";
import { paintTable } from "../scripts/gen-vehicle-paint.mjs";

/**
 * ADR-519: in-game vehicles drew untinted grey-beige. Art's sheets are neutral grey where the paint goes (tintmask R) and
 * the manifest carries the paint contract (vehicles[].tint: tint set, default index, neutral 0.78), but VehicleView always
 * set Sprite.tint 0 and nothing read the contract. Now the body gets the paint colour + TintNeutral, WebGL2 and Canvas2D
 * apply out = base * mix(1, color / neutral, strength * mask.r), and gameplay's Vehicle.paint varies it per vehicle.
 */
const raw = JSON.parse(readFileSync(join(__dirname, "../../gameplay/data/vehicles.json"), "utf8")) as { vehicles?: VehicleRenderDef[] } | VehicleRenderDef[];
const DEFS = (Array.isArray(raw) ? raw : raw.vehicles!) as VehicleRenderDef[];
const def = (id: string): VehicleRenderDef => DEFS.find((d) => d.id === id)!;
const VM = readManifestJson(PACK_DIR + "vehicles/manifest.vehicles.json") as any;
const reg = loadManifest(mergeManifests([{ name: "pack", manifest: readManifestJson(PACK_DIR + "manifest.json") }, { name: "vehicles", manifest: VM }] as never).manifest).registry;
const mk = () => { const w = new World(); w.register(Transform); for (const c of [Sprite, LightSource, Occluder, TintNeutral]) w.register(c); return w; };
const rgba = (rgb: number) => ((rgb << 8) | 0xff) >>> 0;

describe("ADR-519 vehicle paint", () => {
  it("paint.data.ts is the build-time fold of Art's manifest paint contract (no drift), for every Art vehicle", () => {
    const t = paintTable(VM);
    expect(VEHICLE_PAINT).toEqual(t.vehicles); expect(VEHICLE_PAINT_SETS).toEqual(t.sets);
    for (const v of VM.vehicles) expect(VEHICLE_PAINT[v.sprite ?? v.key], v.key).toBeDefined();
    expect(VEHICLE_PAINT_SETS.vehicle_paint!.length).toBe(12); expect(VEHICLE_PAINT_SETS.bike_paint!.length).toBe(10);
  });

  it("picks map uniformly onto each tint set; no pick = Art's default colour", () => {
    const [set, di, n] = VEHICLE_PAINT.car_sedan!; const S = VEHICLE_PAINT_SETS[set]!;
    expect(vehiclePaint("car_sedan")!.rgb).toBe(S[di]); expect(vehiclePaint("car_sedan", 0)!.rgb).toBe(S[di]);
    expect(vehiclePaint("car_sedan", 1)!.rgb).toBe(S[0]); expect(vehiclePaint("car_sedan", 13)!.rgb).toBe(S[0]);
    expect(vehiclePaint("car_sedan", 240)!.rgb).toBe(S[11]); expect(vehiclePaint("car_sedan")!.neutral).toBe(n);
    for (const k of ["car_sedan", "bike_road"]) { const len = VEHICLE_PAINT_SETS[VEHICLE_PAINT[k]![0]]!.length; const c = new Map<number, number>();
      for (let p = 1; p <= 240; p++) { const r = vehiclePaint(k, p)!.rgb; c.set(r, (c.get(r) ?? 0) + 1); }
      expect(c.size).toBe(len); for (const v of c.values()) expect(v).toBe(240 / len); }
    expect(vehiclePaint("no_such_vehicle", 3)).toBeUndefined();
  });

  it("VehicleView paints the Art body (Sprite.tint + TintNeutral) instead of tint 0, and follows Vehicle.paint", () => {
    const w = mk(); const v = new VehicleView(w, reg, { art: true });
    v.sync([{ key: 1, def: def("car_sedan"), x: 0, y: 0, heading: 0 }, { key: 2, def: def("car_sedan"), x: 6, y: 0, heading: 0, paint: 2 },
      { key: 3, def: def("bike_road"), x: 12, y: 0, heading: 0, paint: 7 }], 0, { darkness: 0 });
    const body = (k: number) => v.recs.get(k)!.body!;
    for (const k of [1, 2, 3]) { expect(w.get(body(k), Sprite)!.tint, `key ${k}`).not.toBe(0); const tn = w.get(body(k), TintNeutral)!; expect(tn.neutral).toBeCloseTo(0.78, 5); expect(tn.strength).toBe(1); }
    expect(w.get(body(1), Sprite)!.tint >>> 0).toBe(rgba(vehiclePaint(v.recs.get(1)!.art!.key)!.rgb));
    expect(w.get(body(2), Sprite)!.tint >>> 0).toBe(rgba(VEHICLE_PAINT_SETS.vehicle_paint![1]!));
    expect(w.get(body(3), Sprite)!.tint >>> 0).toBe(rgba(VEHICLE_PAINT_SETS.bike_paint![6]!));
    v.sync([{ key: 2, def: def("car_sedan"), x: 6, y: 0, heading: 0, paint: 4 }], 0, { darkness: 0 }); // repaint (net update)
    expect(w.get(body(2), Sprite)!.tint >>> 0).toBe(rgba(VEHICLE_PAINT_SETS.vehicle_paint![3]!));
  });

  it("WebGL2: writePaint pre-divides by neutral and selects the mask-only paint path", () => {
    const o = new Float32Array(48); o[12] = o[13] = o[14] = 1; writePaint(o, rgba(0x3d7fd0), 0.78, 1);
    expect(o[12]).toBeCloseTo(0x3d / 255 / 0.78, 5); expect(o[13]).toBeCloseTo(0x7f / 255 / 0.78, 5); expect(o[14]).toBeCloseTo(0xd0 / 255 / 0.78, 5);
    expect(o[33]).toBe(PAINT_MASK_ONLY); expect(o[34]).toBe(1); expect(o[28]! + o[29]! + o[30]!).toBe(0);
    const src = readFileSync(join(__dirname, "../src/sprites.ts"), "utf8");
    expect(src).toMatch(/paintOnly \? vec4\(0\.0\)/); // no resident mask: unpainted, never a whole-frame tint over glass / tyres
    expect(src).toMatch(/int mode = int\(vLT\.y - 0\.5\) & 7/);
  });

  it("Canvas2D: tintPaintPixels turns a neutral-grey masked pixel into the paint colour, leaves unmasked pixels, ignores mask G", () => {
    const g = Math.round(0.78 * 255); const px = new Uint8ClampedArray([g, g, g, 255, 40, 50, 60, 255, g, g, g, 255]);
    const mask = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 0, 255, 0, 255]);
    tintPaintPixels(px, mask, rgba(0xc8362f), 0.78, 1);
    expect(Math.abs(px[0]! - 0xc8)).toBeLessThanOrEqual(1); expect(Math.abs(px[1]! - 0x36)).toBeLessThanOrEqual(1); expect(Math.abs(px[2]! - 0x2f)).toBeLessThanOrEqual(1);
    expect([...px.slice(4, 8)]).toEqual([40, 50, 60, 255]); expect([...px.slice(8, 12)]).toEqual([g, g, g, 255]);
  });
});
