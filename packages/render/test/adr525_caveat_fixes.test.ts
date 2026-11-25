import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { World, Transform, PrevTransform, Appearance } from "@engine/core";
import { loadManifest, mergeManifests } from "@engine/assets";
import { PACK_DIR, readManifestJson } from "@engine/assets/node";
import { worldToScreen } from "@engine/world";
import {
  Canvas2DRenderer, RIDER_GLASS_SHEEN, RIDER_GLASS_TINT, RIDER_HEAD_PX, RIDER_LEG_PX, RIDER_CLIP_HIDDEN,
  VehicleView, drawWindowGlass, windowBand, windowGlassSpan, VEHICLE_SEAT_ART,
  PX_PER_M_HEIGHT, PX_PER_M_LENGTH, VIEW_RISE, type VehicleRenderDef,
} from "../src/index.js";
import { Sprite, LightSource, Occluder } from "../src/components.js";

/**
 * ADR-525: the honest caveats from ADR-521/522, fixed at the user's request.
 *  (a) the pickup bed seat's head was clipped ~2 px in side view — the band top is open sky, not a roof edge;
 *  (b) RV / pickup riders ghosted from a direct rear view, where those vehicles have no rear window;
 *  (c) the glass tint + sheen followed the rider — it now spans the window's own outline, drawn once per vehicle.
 * WebGL2: the sheen was already screen-anchored (sprites.ts vScr is the fragment's screen position), so no shader
 * change was needed there; the tint still covers only the rider's pixels on WebGL2 (a window-sized glass quad would
 * need a new quad path in the sprite pass — see the DECISIONS entry). ADR-527 added that quad path (GLASS_QUAD):
 * one window-sized quad per vehicle, so the tint reads as one window on WebGL2 too.
 */
const raw = JSON.parse(readFileSync(join(__dirname, "../../gameplay/data/vehicles.json"), "utf8")) as { vehicles?: VehicleRenderDef[] } | VehicleRenderDef[];
const DEFS = (Array.isArray(raw) ? raw : raw.vehicles!) as VehicleRenderDef[];
const def = (id: string): VehicleRenderDef => DEFS.find((d) => d.id === id)!;
const VM = readManifestJson(PACK_DIR + "vehicles/manifest.vehicles.json") as any;
const reg = loadManifest(mergeManifests([{ name: "pack", manifest: readManifestJson(PACK_DIR + "manifest.json") }, { name: "vehicles", manifest: VM }] as never).manifest).registry;
const PLAYER = reg.id("player");
/** engine heading for Art's facing: E -pi/4 (ADR-518/521). In the E view the camera ray is (cu, cv) = (0, 1). */
const H_E = -Math.PI / 4;
/** engine heading for a direct rear view in view quarter 0: the camera ray is (cu, cv) = (-1, 0). */
const H_N = (5 * Math.PI) / 4;

const mkViewWorld = () => { const w = new World(); w.register(Transform); for (const c of [Sprite, LightSource, Occluder]) w.register(c); return w; };
const syncAt = (heading: number, list: { key: number; def: VehicleRenderDef; x: number; y: number; occupants: number[] }[]) => {
  const w = mkViewWorld(); const v = new VehicleView(w, reg, { art: true });
  return v.sync(list.map((s) => ({ ...s, heading })), 0, { darkness: 0 });
};
/** Cabin box for a def, from the seat data (the same box windowBand measures against): CABIN seats only, ±0.75 m. */
const cabinBox = (id: string): { u0: number; u1: number; hw: number } => {
  const t = VEHICLE_SEAT_ART[id]!; let u0 = Infinity, u1 = -Infinity;
  for (const q of t.seats) { if (q[6] === 0) continue; u0 = Math.min(u0, q[0]); u1 = Math.max(u1, q[0]); }
  return { u0: u0 - 0.75, u1: u1 + 0.75, hw: t.w / 2 };
};

describe("ADR-525 (a) the bed seat's head clears the rail band", () => {
  it("the open seat's band top is the unlowered roof (open sky), while a cab seat's top is still lowered", () => {
    const bed = windowBand(def("truck_pickup"), 2, 0, 1)!;
    expect(bed.top).toBeCloseTo((2.8 - 1.0) * PX_PER_M_HEIGHT, 9); // open sky: no camera-ray lowering
    expect(bed.top).toBeGreaterThan(RIDER_HEAD_PX); // the head (~34 px) clears, no ~2 px clip
    // the rail still hides the legs: the bottom is lowered by the side distance, as before
    const bs = VEHICLE_SEAT_ART["truck_pickup"]!.seats[2]!;
    const blow = (VEHICLE_SEAT_ART["truck_pickup"]!.w / 2 - bs[1]!) * VIEW_RISE * PX_PER_M_HEIGHT;
    expect(bed.bottom).toBeCloseTo((1.39 - 1.0) * PX_PER_M_HEIGHT - blow, 9);
    expect(bed.bottom).toBeGreaterThan(-RIDER_LEG_PX);
    expect(bed.bottom).toBeLessThan(0);
    // a cabin seat is untouched by the open-sky rule: its top is still lowered by the side distance
    const van = windowBand(def("van_passenger"), 5, 0, 1)!;
    const vs = VEHICLE_SEAT_ART["van_passenger"]!.seats[5]!;
    const vlow = (VEHICLE_SEAT_ART["van_passenger"]!.w / 2 - vs[1]!) * VIEW_RISE * PX_PER_M_HEIGHT;
    expect(van.top).toBeCloseTo((1.704 - 0.7) * PX_PER_M_HEIGHT - vlow, 9);
    expect(van.top).toBeLessThanOrEqual(RIDER_HEAD_PX); // a cab roof still clips the head, as designed
  });

  it("the bed rider's clip clears the head through VehicleView, in every side view", () => {
    const out = syncAt(H_E, [{ key: 2, def: def("truck_pickup"), x: 20, y: 5, occupants: [211, 212, 213] }]);
    const bed = out.find((p) => p.rider === 213)!;
    expect(bed.clip).toBeDefined();
    expect(bed.clip!.top).toBeGreaterThan(RIDER_HEAD_PX);
  });
});

describe("ADR-525 (b) no rear window, no ghost rider", () => {
  it("a direct rear view hides RV and pickup cab riders, but not the open bed rider or a car with a rear window", () => {
    // direct rear view: the camera ray is (-1, 0) — it leaves through the rear end, where there is no glass
    for (const i of [0, 1, 2, 3, 4, 5]) expect(windowBand(def("camper_rv"), i, -1, 0)).toBeUndefined();
    for (const i of [0, 1]) expect(windowBand(def("truck_pickup"), i, -1, 0)).toBeUndefined();
    expect(windowBand(def("truck_pickup"), 2, -1, 0)).toBeDefined(); // the bed rider is in the open air
    // a car with a rear window still shows its rearmost riders through it; the front rows hide behind the roofline
    // (the band math, not the rule — they sit too far from the glass at this camera angle for the roof to clear them)
    expect(windowBand(def("car_sedan"), 2, -1, 0)).toBeDefined();
    expect(windowBand(def("car_sedan"), 3, -1, 0)).toBeDefined();
    expect(windowBand(def("car_sedan"), 0, -1, 0)).toBeUndefined(); // roofline, not the rule
    // the front view (windscreen) and the side view (side glass) still show the same riders
    expect(windowBand(def("camper_rv"), 0, 1, 0)).toBeDefined();
    expect(windowBand(def("truck_pickup"), 0, 1, 0)).toBeDefined();
    // the side view shows the near-side passenger (the far-side driver hides behind the roofline, ADR-518)
    expect(windowBand(def("camper_rv"), 1, 0, 1)).toBeDefined();
    expect(windowBand(def("truck_pickup"), 1, 0, 1)).toBeDefined();
  });

  it("a diagonal rear view still shows the rider through the side glass", () => {
    // the ray leaves through the side (Dv < Du), not the glassless rear end — the rule does not fire
    expect(windowBand(def("car_sedan"), 1, -0.7071, 0.7071)).toBeDefined();
    expect(windowBand(def("car_sedan"), 2, -0.7071, 0.7071)).toBeDefined();
    // ...but a rear-row rider whose ray leaves through the rear end still hides, even diagonally (camper_rv)
    expect(windowBand(def("camper_rv"), 4, -0.7071, 0.7071)).toBeUndefined();
  });

  it("VehicleView hides the ghost riders end to end (rear view), and keeps the bed rider and the sedan driver", () => {
    const out = syncAt(H_N, [
      { key: 1, def: def("camper_rv"), x: 10, y: 10, occupants: [201, 202, 203, 204, 205, 206] },
      { key: 2, def: def("truck_pickup"), x: 20, y: 5, occupants: [211, 212, 213] },
      { key: 3, def: def("car_sedan"), x: 30, y: 10, occupants: [0, 0, 223, 224] },
    ]);
    for (const r of [201, 202, 203, 204, 205, 206]) expect(out.find((p) => p.rider === r)!.clip).toEqual(RIDER_CLIP_HIDDEN);
    for (const r of [211, 212]) expect(out.find((p) => p.rider === r)!.clip).toEqual(RIDER_CLIP_HIDDEN);
    const bed = out.find((p) => p.rider === 213)!;
    expect(bed.clip).toBeDefined(); expect(bed.clip).not.toEqual(RIDER_CLIP_HIDDEN);
    expect(bed.clip!.top).toBeGreaterThan(RIDER_HEAD_PX); // open sky, even from the rear
    // the sedan's rear rows show through its rear window; its front rows hide behind the roofline, not the rule
    for (const r of [223, 224]) { const c = out.find((p) => p.rider === r)!.clip; expect(c).toBeDefined(); expect(c).not.toEqual(RIDER_CLIP_HIDDEN); }
  });
});

describe("ADR-525 (c) windowGlassSpan: the window's own outline", () => {
  it("spans the projected cabin box, wider than the rider and containing the seat", () => {
    const span = windowGlassSpan(def("van_passenger"), 5, 0, 1)!;
    const { u0, u1, hw } = cabinBox("van_passenger");
    const s = VEHICLE_SEAT_ART["van_passenger"]!.seats[5]!;
    // E view: the screen-x axis is (1, 0) in vehicle-local coords (increasing screen-x is increasing u), so the
    // interval is the u-range from the seat: lo at the rear end, hi at the front end (ADR-527: the negated axis
    // mirrored every span about its pivot, so the merged rect overhung the window on both ends).
    const lo = Math.min((u0 - s[0]) * PX_PER_M_LENGTH, (u1 - s[0]) * PX_PER_M_LENGTH);
    const hi = Math.max((u0 - s[0]) * PX_PER_M_LENGTH, (u1 - s[0]) * PX_PER_M_LENGTH);
    expect(span.lo).toBeCloseTo(lo, 9); expect(span.hi).toBeCloseTo(hi, 9);
    expect(span.hi - span.lo).toBeCloseTo((u1 - u0) * PX_PER_M_LENGTH, 9); // the whole side window
    expect(span.lo).toBeLessThan(0); expect(span.hi).toBeGreaterThan(0); // the seat sits inside its window
    expect(span.hi - span.lo).toBeGreaterThan(100); // far wider than the ~53 px doll
    expect(hw).toBeGreaterThan(0);
  });

  it("a front view spans the cab width, not its length", () => {
    const span = windowGlassSpan(def("van_passenger"), 0, 1, 0)!;
    const { hw } = cabinBox("van_passenger");
    const v = VEHICLE_SEAT_ART["van_passenger"]!.seats[0]![1];
    expect(span.hi - span.lo).toBeCloseTo(2 * hw * PX_PER_M_LENGTH, 9); // the windscreen, kerb to kerb
    // front view: the screen-x axis is (0, -1) in vehicle-local coords (increasing screen-x is decreasing v),
    // so lo is the +hw side and hi the -hw side (ADR-527: the negated axis mirrored the span).
    expect(span.lo).toBeCloseTo((v - hw) * PX_PER_M_LENGTH, 9);
    expect(span.hi).toBeCloseTo((v + hw) * PX_PER_M_LENGTH, 9);
  });

  it("returns undefined where there is no glass: open seats and over-drawn seats", () => {
    expect(windowGlassSpan(def("truck_pickup"), 2, 0, 1)).toBeUndefined(); // the bed: open air
    expect(windowGlassSpan(def("bike_basic"), 0, 0, 1)).toBeUndefined(); // "over" seats have no window
    expect(windowGlassSpan(def("van_passenger"), 99, 0, 1)).toBeUndefined(); // no such seat
  });

  it("the clip carries the span with the vehicle key, for the once-per-vehicle glass pass", () => {
    const out = syncAt(H_E, [{ key: 1, def: def("van_passenger"), x: 10, y: 10, occupants: [201, 202, 203, 204, 205, 206, 207, 208] }]);
    const shown = out.filter((p) => p.clip && p.clip.bottom < 1e3); // the near side; the far side hides behind the body
    expect(shown).toHaveLength(4);
    for (const p of shown) {
      expect(p.clip?.glass).toBeDefined();
      expect(p.clip!.glass!.vehicle).toBe(1);
      const span = windowGlassSpan(def("van_passenger"), p.seat, 0, 1)!;
      expect(p.clip!.glass!.lo).toBeCloseTo(span.lo, 9);
      expect(p.clip!.glass!.hi).toBeCloseTo(span.hi, 9);
    }
    for (const p of out.filter((p) => !shown.includes(p))) expect(p.clip).toEqual(RIDER_CLIP_HIDDEN);
  });
});

/** Recording 2D context (the ADR-522 harness): every call is logged with the translate active at the time. */
type Ev = { op: string; args: unknown[]; tx: number; ty: number; style?: string };
class RecCtx {
  events: Ev[] = [];
  fillStyle = ""; globalAlpha = 1; globalCompositeOperation = "source-over"; imageSmoothingEnabled = true; filter = "";
  private stack: { tx: number; ty: number }[] = [{ tx: 0, ty: 0 }];
  private get cur(): { tx: number; ty: number } { return this.stack[this.stack.length - 1]!; }
  private log(op: string, ...args: unknown[]): void { this.events.push({ op, args, tx: this.cur.tx, ty: this.cur.ty }); }
  save(): void { this.stack.push({ ...this.cur }); this.log("save"); }
  restore(): void { this.stack.pop(); this.log("restore"); }
  translate(x: number, y: number): void { this.cur.tx += x; this.cur.ty += y; this.log("translate", x, y); }
  setTransform(...a: unknown[]): void { this.log("setTransform", ...a); }
  beginPath(): void { this.log("beginPath"); }
  moveTo(x: number, y: number): void { this.log("moveTo", x, y); }
  lineTo(x: number, y: number): void { this.log("lineTo", x, y); }
  closePath(): void { this.log("closePath"); }
  rect(x: number, y: number, w: number, h: number): void { this.log("rect", x, y, w, h); }
  clip(): void { this.log("clip"); }
  fill(): void { this.events.push({ op: "fill", args: [], tx: this.cur.tx, ty: this.cur.ty, style: this.fillStyle }); }
  fillRect(x: number, y: number, w: number, h: number): void { this.events.push({ op: "fillRect", args: [x, y, w, h], tx: this.cur.tx, ty: this.cur.ty, style: this.fillStyle }); }
  drawImage(...a: unknown[]): void { this.log("drawImage", ...a); }
  rotate(...a: unknown[]): void { this.log("rotate", ...a); }
  scale(...a: unknown[]): void { this.log("scale", ...a); }
}
function makeRecCtx(): { ctx: CanvasRenderingContext2D; events: Ev[] } {
  const target = new RecCtx();
  const universal = (..._a: unknown[]): unknown => proxy;
  const proxy = new Proxy(target, {
    get(t, p) { if (p in t) { const v = (t as unknown as Record<string | symbol, unknown>)[p]; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v; } return universal; },
    set(t, p, v) { (t as unknown as Record<string | symbol, unknown>)[p] = v; return true; },
  });
  return { ctx: proxy as unknown as CanvasRenderingContext2D, events: target.events };
}

interface RiderDrive { clip: { bottom: number; top: number; glass?: { lo: number; hi: number; vehicle: number } }; x: number; y: number; z: number }
/** Drive Canvas2DRenderer.render() with the given riders (sprite path, no paper doll) and record every ctx call. */
function driveRiders(riders: RiderDrive[]): { events: Ev[] } {
  const canvas = { width: 320, height: 240, getContext: () => ({}) } as unknown as HTMLCanvasElement;
  const { ctx, events } = makeRecCtx();
  const r = new Canvas2DRenderer(canvas, ctx);
  r.resize(640, 480, 1);
  void r.atlas.setRegistry(reg, new Map());
  (r as unknown as { image: unknown }).image = () => ({});
  const w = new World({ seed: 1 });
  w.register(Transform); w.register(PrevTransform); w.register(Sprite); w.register(Appearance);
  const byEntity = new Map<number, RiderDrive["clip"]>();
  riders.forEach((rd) => {
    const e = w.create();
    w.add(e, Transform, { x: rd.x, y: rd.y, z: rd.z, facing: 0 });
    w.add(e, PrevTransform, { x: rd.x, y: rd.y, z: rd.z, facing: 0 });
    w.add(e, Sprite, { spriteId: PLAYER, frameId: 0, flags: 0, scale: 1, tint: 0 });
    byEntity.set(e, rd.clip);
  });
  r.bindGameplay({ riderWindow: (e: number) => byEntity.get(e) } as never);
  const rc = r as unknown as { clock: number; clockAt: number };
  rc.clock = 0; rc.clockAt = -1; // pin the render clock (ADR-414's trick)
  r.render(w, 1);
  return { events };
}

describe("ADR-525 (c) the Canvas2D glass pass draws each window once", () => {
  it("drawWindowGlass tints the window rect and stripes it from the window, not the rider", () => {
    const { ctx, events } = makeRecCtx();
    drawWindowGlass(ctx, { x0: -100, y0: -30, x1: 60, y1: -3 });
    const tint = events.find((e) => e.op === "fillRect")!;
    expect(tint.style).toBe(RIDER_GLASS_TINT);
    expect(tint.args).toEqual([-100, -30, 160, 27]);
    const sheen = events.find((e) => e.op === "fill" && e.style === RIDER_GLASS_SHEEN)!;
    expect(sheen).toBeDefined();
    const pts = events.filter((e) => e.op === "moveTo" || e.op === "lineTo").map((e) => e.args as [number, number]);
    expect(pts).toHaveLength(4);
    expect(pts[0]![1]).toBe(-30); expect(pts[1]![1]).toBe(-3); // stripe runs top edge -> bottom edge
    expect(pts[1]![0]).toBeGreaterThan(pts[0]![0]); // slanted, not vertical
    expect(pts[0]![0]).toBeGreaterThan(-100); // anchored inside the window, 30% across it — not on the rider
    expect(pts[0]![0]).toBeCloseTo(-100 + 160 * 0.3, 9);
    for (const p of pts) { expect(p[0]).toBeGreaterThanOrEqual(-100); expect(p[0]).toBeLessThanOrEqual(60); }
  });

  it("two riders in one van get one merged tint, spanning the window, after the last rider draw", () => {
    const out = syncAt(H_E, [{ key: 1, def: def("van_passenger"), x: 10, y: 10, occupants: [201, 202, 203, 204, 205, 206, 207, 208] }]);
    const picks = [202, 206].map((r) => out.find((p) => p.rider === r)!); // two near-side riders that show
    expect(picks.every((p) => p.clip?.glass)).toBe(true);
    const { events } = driveRiders(picks.map((p) => ({ clip: p.clip!, x: p.x, y: p.y, z: p.z })));
    const tints = events.filter((e) => e.op === "fillRect" && e.style === RIDER_GLASS_TINT);
    expect(tints).toHaveLength(1); // one window, one tint — never one per rider (the tint must not stack)
    const draws = events.map((e, i) => (e.op === "drawImage" ? i : -1)).filter((i) => i >= 0);
    expect(draws.length).toBeGreaterThanOrEqual(2); // both riders drew
    expect(events.indexOf(tints[0]!)).toBeGreaterThan(draws[draws.length - 1]!); // glass after every rider
    // the merged rect is the union of the two riders' window rects: it covers both pivots' windows
    const w = tints[0]!.args[2] as number;
    expect(w).toBeGreaterThan(100); // the whole side window, not one rider
    const pivots = picks.map((p) => worldToScreen(p.x, p.y, p.z, { tileW: 64, tileH: 32, zStep: 16 }));
    const x0 = tints[0]!.args[0] as number;
    for (const pv of pivots) { expect(x0).toBeLessThan(pv.sx); expect(x0 + w).toBeGreaterThan(pv.sx); }
    expect(events.some((e) => e.op === "fill" && e.style === RIDER_GLASS_SHEEN)).toBe(true);
  });

  it("a clip with no window outline keeps the rider-width glass (fallback for open seats)", () => {
    const clip = windowBand(def("van_passenger"), 5, 0, 1)!;
    const { events } = driveRiders([{ clip: { bottom: clip.bottom, top: clip.top }, x: 10, y: 10, z: 0 }]);
    const tint = events.find((e) => e.op === "fillRect" && e.style === RIDER_GLASS_TINT)!;
    expect(tint).toBeDefined();
    const f = reg.dirFrame(PLAYER, "idle", 0, 0);
    expect(tint.args).toEqual([-f.w / 2 - 2, -clip.top, f.w + 4, clip.top - clip.bottom]);
  });
});
