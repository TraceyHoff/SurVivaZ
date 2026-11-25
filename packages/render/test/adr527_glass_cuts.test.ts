import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { World, Transform, PrevTransform, Appearance, setAppearance, slotIndex, type CosmeticCatalogLike, type WearableDef, type AppearanceValue } from "@engine/core";
import { loadManifest, mergeManifests } from "@engine/assets";
import { PACK_DIR, readManifestJson } from "@engine/assets/node";
import { worldToScreen, DEFAULT_ISO } from "@engine/world";
import {
  Canvas2DRenderer, RIDER_GLASS_TINT, coreAppearanceBinding,
  VehicleView, windowGlassRoofline, clampGlassRectToRoofline, windowGlassQuad, GLASS_QUAD, GLASS_DEPTH_MARGIN,
  VEHICLE_SEAT_ART,
  PX_PER_M_HEIGHT, PX_PER_M_LENGTH, VIEW_RISE, type VehicleRenderDef,
} from "../src/index.js";
import { Sprite, LightSource, Occluder, RENDER_COMPONENTS } from "../src/components.js";
import { SpriteBatch, INSTANCE_FLOATS, type PrepareContext } from "../src/sprites.js";
import { newResolved as newAtlasResolved, type AtlasManager, type ResolvedFrame } from "../src/assets/atlasManager.js";
import { DEFAULT_STYLE } from "../src/style.js";
import { SUMMER_VISUAL } from "../src/season.js";
import { isoZDepthFactor } from "../src/depth.js";
import { DeckNeighbors } from "../src/building/deckFaces.js";
import { PieceCoverIndex } from "../src/building/modular.js";

/**
 * ADR-527: the two honest cuts left by ADR-525's merged window glass, plus a third defect found while
 * reproducing cut 1 — windowGlassSpan's screen-x axis was negated, so every rider's span was mirrored about
 * its pivot and the merged rect overhung the window by ~119 px on both ends (a van's merged tint was 424 px
 * wide for a 186 px window). The glass must never draw outside the cabin box: the merged rect is the window's
 * own projected outline, clamped at the top to the roofline.
 *  (1) Canvas2D merged glass overhangs the RV cab roof by ~7 px (the rear roof is higher than the front);
 *  (2) WebGL2 glass tint still covers only the rider — no window-sized glass quad;
 *  (3) the span mirror (found here): the merged rect must match the projected cabin box, not its mirror.
 */
const raw = JSON.parse(readFileSync(join(__dirname, "../../gameplay/data/vehicles.json"), "utf8")) as { vehicles?: VehicleRenderDef[] } | VehicleRenderDef[];
const DEFS = (Array.isArray(raw) ? raw : raw.vehicles!) as VehicleRenderDef[];
const def = (id: string): VehicleRenderDef => DEFS.find((d) => d.id === id)!;
const VM = readManifestJson(PACK_DIR + "vehicles/manifest.vehicles.json") as any;
const reg = loadManifest(mergeManifests([{ name: "pack", manifest: readManifestJson(PACK_DIR + "manifest.json") }, { name: "vehicles", manifest: VM }] as never).manifest).registry;
const PLAYER = reg.id("player");
/** engine heading for Art's facing: E -pi/4 (ADR-518/521). In the E view the camera ray is (cu, cv) = (0, 1). */
const H_E = -Math.PI / 4;

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

/**
 * The RV's roofline in the E view, computed independently from the seat data (not via windowGlassSpan):
 * the cabin box's side face, with the roof of the rearmost cabin seat at the u0 end and the frontmost
 * cabin seat's roof at the u1 end. The screen-x axis in vehicle-local coords is (cv, -cu) = (1, 0) here
 * (increasing screen-x is increasing u: a rider at larger u sits further right — verified against the
 * pivots' worldToScreen positions), and the height of a roof edge above a seat pivot is
 * (roof - z) * PX_PER_M_HEIGHT less the camera-ray climb over the side distance to the face.
 * Returns the roofline's two absolute endpoints, from the front passenger's pivot.
 */
const rvRooflineE = (front: { x: number; y: number; z: number }): { ax0: number; ay0: number; ax1: number; ay1: number } => {
  const t = VEHICLE_SEAT_ART["camper_rv"]!;
  const { u0, u1, hw } = cabinBox("camper_rv");
  const cab = t.seats.filter((q) => q[6] === 1);
  const roofRear = cab.reduce((m, q) => (q[0] < m.u ? { u: q[0], roof: q[5] } : m), { u: Infinity, roof: 0 }).roof;
  const roofFront = cab.reduce((m, q) => (q[0] > m.u ? { u: q[0], roof: q[5] } : m), { u: -Infinity, roof: 0 }).roof;
  const s = t.seats[1]!; // the front near-side passenger: the reference pivot
  const pv = worldToScreen(front.x, front.y, front.z, { tileW: 64, tileH: 32, zStep: 16 });
  const ray = hw - s[1]; // side distance from the seat to the visible face, in metres
  const hAt = (roof: number) => (roof - s[2]) * PX_PER_M_HEIGHT - ray * VIEW_RISE * PX_PER_M_HEIGHT;
  return {
    ax0: pv.sx + (u0 - s[0]) * PX_PER_M_LENGTH, ay0: pv.sy - hAt(roofRear),
    ax1: pv.sx + (u1 - s[0]) * PX_PER_M_LENGTH, ay1: pv.sy - hAt(roofFront),
  };
};

describe("ADR-527 (2) the WebGL2 glass quad: one window-sized quad per vehicle", () => {
  it("clampGlassRectToRoofline keeps the rect below the roofline and drops a rect above it", () => {
    const roof = { x0: -100, y0: -30, x1: 60, y1: -20 }; // the roofline, absolute (y = height above the pivot, up is negative here)
    // a rect whose top (-40) is above the roofline is clamped to the roofline's lowest point on screen
    // (the max y over both ends: -20 at the right end), so it stays below the roofline at both ends
    const clamped = clampGlassRectToRoofline({ x0: -100, y0: -40, x1: 60, y1: -3 }, roof)!;
    expect(clamped.y0).toBeCloseTo(-20, 9); // the right end's roofline (the lower of the two on screen)
    expect(clamped.y1).toBe(-3); expect(clamped.x0).toBe(-100); expect(clamped.x1).toBe(60);
    // a rect already below the roofline at both ends (top -18, below the roofline's lowest point -20) is untouched
    expect(clampGlassRectToRoofline({ x0: -100, y0: -18, x1: 60, y1: -3 }, roof)).toEqual({ x0: -100, y0: -18, x1: 60, y1: -3 });
    // a rect entirely above its own roofline draws nothing
    expect(clampGlassRectToRoofline({ x0: -100, y0: -40, x1: 60, y1: -35 }, roof)).toBeUndefined();
    // no roofline: no clamp
    expect(clampGlassRectToRoofline({ x0: -100, y0: -40, x1: 60, y1: -3 }, undefined)).toEqual({ x0: -100, y0: -40, x1: 60, y1: -3 });
  });

  it("windowGlassQuad expresses the rect exactly with a virtual bottom-centre anchor", () => {
    // the rider's body frame is 48x64 with its anchor 5 px above the frame bottom (ay 59) — the authored
    // anchor would hang the glass (h - ay) * s below the window, so the quad uses a virtual anchor at the
    // frame's bottom centre and the pivot sits on the rect's bottom edge.
    const q = windowGlassQuad({ x0: -100, y0: -30, x1: 60, y1: -3 }, 12.5, { entry: 7, w: 48, h: 64 })!;
    expect(q.key).toBe(12.5); expect(q.entry).toBe(7);
    expect(q.scale).toBeCloseTo(Math.max(160 / 48, 27 / 64), 9); // the width dominates
    expect(q.x).toBeCloseTo(-20, 9); // the rect's centre x
    expect(q.y).toBe(-3); // the rect's bottom edge
    expect(q.ax).toBe(24); expect(q.ay).toBe(64); // the virtual anchor: bottom centre
    // the quad's corners, recomputed from the spec the way the vertex shader does, are the rect exactly
    expect(q.x + q.sliceL * q.scale).toBeCloseTo(-100, 9);
    expect(q.x + q.sliceR * q.scale).toBeCloseTo(60, 9);
    expect(q.y - q.topClip * q.scale).toBeCloseTo(-30, 9);
    expect(q.sliceL).toBeLessThan(0); expect(q.sliceR).toBeGreaterThan(0);
    expect(q.topClip).toBeGreaterThan(0); expect(q.topClip).toBeLessThanOrEqual(64);
    expect(windowGlassQuad({ x0: 10, y0: -5, x1: 10, y1: -3 }, 1, { entry: 7, w: 48, h: 64 })).toBeUndefined(); // no width
    expect(windowGlassQuad({ x0: -10, y0: -5, x1: 10, y1: -5 }, 1, { entry: 7, w: 48, h: 64 })).toBeUndefined(); // no height
  });

  it("the flush writes one glass quad per vehicle, flagged, with the virtual anchor and no shadow", () => {
    // exercise the real flush (the method prepare() calls) with a stubbed batch, ADR-270 style
    const batch = Object.create(SpriteBatch.prototype) as any;
    Object.assign(batch, { one: new Float32Array(40), n: 0, capacity: 0, tmp: new Float32Array(0), sortKeys: new Uint32Array(0), route: new Uint8Array(0), depthMin: 0, depthRange: 1, zFactor: 1 / 3, iso: { zStep: 16 } });
    const written: Float32Array[] = [];
    batch.writeOne = (x: number, y: number, key: number, scale: number, r: { entry: number; ax: number; ay: number }, flags: number, seed: number, alpha: number, sliceL: number, sliceR: number, tint: number, footDy: number, shadowA: number, ghost: number, dmg: number, shadowW: number) => {
      const o = new Float32Array(40); o[0] = x; o[1] = y; o[2] = key; o[3] = scale; o[4] = r.entry; o[5] = flags; o[6] = seed; o[7] = alpha; o[8] = r.ax; o[9] = r.ay; o[10] = sliceL; o[11] = sliceR; o[16] = shadowA; return o;
    };
    batch.push = (o: Float32Array) => { written.push(o); };
    batch.emitWindowGlassQuad({ vehicle: 1, x0: -100, y0: -30, x1: 60, y1: -3, roof: undefined, maxPivotKey: 12.5, pivotY: 0, frame: { entry: 7, w: 48, h: 64 } });
    expect(written).toHaveLength(1);
    const o = written[0]!;
    expect(o[5]! & GLASS_QUAD).toBe(GLASS_QUAD); // the glass-quad flag
    expect(o[5]! & 16).toBe(16); // NoOutline (no outline ring on the glass)
    expect(o[5]! & 8).toBe(0); // not Flat
    expect(o[7]).toBe(1); // full instance alpha; the shader outputs 0.12
    expect(o[16]).toBe(0); // no shadow
    expect(o[8]).toBe(24); expect(o[9]).toBe(64); // the virtual anchor, not the authored (24, 59)
    expect(o[39]).toBeGreaterThan(0); // the top clip (aJ.w)
    // the instance reproduces the rect exactly (pivot at the bottom centre, scale from the frame); the
    // instance is a Float32Array, so the recomputed corners carry float32 rounding (~2e-6)
    const s = o[3]!;
    expect(o[0]! + o[10]! * s).toBeCloseTo(-100, 5);
    expect(o[0]! + o[11]! * s).toBeCloseTo(60, 5);
    expect(o[1]! - o[39]! * s).toBeCloseTo(-30, 5);
    expect(o[1]).toBe(-3);
    expect(o[2]).toBeCloseTo(12.5 - (-3 - 0) / 48 + GLASS_DEPTH_MARGIN, 5); // ADR-528: the pivot key less the drop to the rect bottom (here -3 px, above the pivot) plus the margin
  });
});

describe("ADR-527 (1) windowGlassRoofline: the window's own top edge", () => {
  it("the RV roofline steps with the seats (rear roof higher than the front cab roof), in the pivot frame", () => {
    const out = syncAt(H_E, [{ key: 1, def: def("camper_rv"), x: 10, y: 10, occupants: [201, 202, 203, 204, 205, 206] }]);
    const front = out.find((p) => p.rider === 202)!;
    const roof = rvRooflineE(front); // the independent computation, absolute
    const pv = worldToScreen(front.x, front.y, front.z, { tileW: 64, tileH: 32, zStep: 16 });
    const r = windowGlassRoofline(def("camper_rv"), 1, 0, 1)!;
    expect(r.x0).toBeCloseTo(roof.ax0 - pv.sx, 9);
    expect(r.y0).toBeCloseTo(pv.sy - roof.ay0, 9);
    expect(r.x1).toBeCloseTo(roof.ax1 - pv.sx, 9);
    expect(r.y1).toBeCloseTo(pv.sy - roof.ay1, 9);
    expect(r.y0).toBeGreaterThan(r.y1); // the rear roof sits higher above the pivot than the front cab roof
    expect(r.y0 - r.y1).toBeCloseTo((2.29 - 2.047) * PX_PER_M_HEIGHT, 9); // the roof step, unlowered (same ray both ends)
    expect(r.x1 - r.x0).toBeCloseTo((3.177 - -3.45) * PX_PER_M_LENGTH, 9); // the whole side window
    // the clip carries the same roofline (VehicleView attaches it to the glass field); view.ts computes (cu, cv)
    // from the heading, so it is (~1e-17, ~1) rather than exactly (0, 1) — compare with tolerance, not toEqual
    const clipRoof = front.clip?.glass?.roof;
    expect(clipRoof).toBeDefined();
    expect(clipRoof!.x0).toBeCloseTo(r.x0, 9); expect(clipRoof!.y0).toBeCloseTo(r.y0, 9);
    expect(clipRoof!.x1).toBeCloseTo(r.x1, 9); expect(clipRoof!.y1).toBeCloseTo(r.y1, 9);
  });

  it("a single-roof window has a flat roofline; the windscreen's is the front roof", () => {
    const van = windowGlassRoofline(def("van_passenger"), 5, 0, 1)!;
    expect(van.y0).toBeCloseTo(van.y1, 9); // one roof: no step
    const s = VEHICLE_SEAT_ART["van_passenger"]!.seats[5]!;
    expect(van.x0).toBeCloseTo((-2.75 - s[0]) * PX_PER_M_LENGTH, 9);
    expect(van.x1).toBeCloseTo((1.37 - s[0]) * PX_PER_M_LENGTH, 9);
    // the windscreen (front view) is flat at the front seats' roof, spanning the cab width
    const screen = windowGlassRoofline(def("van_passenger"), 0, 1, 0)!;
    expect(screen.y0).toBeCloseTo(screen.y1, 9);
    expect(screen.x1 - screen.x0).toBeCloseTo(2 * (VEHICLE_SEAT_ART["van_passenger"]!.w / 2) * PX_PER_M_LENGTH, 9);
  });

  it("returns undefined where there is no glass: open seats, over seats, and the glassless rear view", () => {
    expect(windowGlassRoofline(def("truck_pickup"), 2, 0, 1)).toBeUndefined(); // the bed: open air
    expect(windowGlassRoofline(def("bike_basic"), 0, 0, 1)).toBeUndefined(); // "over" seats have no window
    expect(windowGlassRoofline(def("camper_rv"), 0, -1, 0)).toBeUndefined(); // rearGlass: 0, direct rear view
    expect(windowGlassRoofline(def("van_passenger"), 99, 0, 1)).toBeUndefined(); // no such seat
  });
});

describe("ADR-527 (1) the merged glass rect is the window's own outline, inside the roofline", () => {
  it("the RV merged tint spans the projected cabin box and never rises above its roofline", () => {
    const out = syncAt(H_E, [{ key: 1, def: def("camper_rv"), x: 10, y: 10, occupants: [201, 202, 203, 204, 205, 206] }]);
    const shown = out.filter((p) => p.clip && p.clip.bottom < 1e3); // the near side: seats 1, 3, 5
    expect(shown.map((p) => p.rider)).toEqual([202, 204, 206]);
    expect(shown.every((p) => p.clip?.glass)).toBe(true);
    const { events } = driveRiders(shown.map((p) => ({ clip: p.clip!, x: p.x, y: p.y, z: p.z })));
    const tints = events.filter((e) => e.op === "fillRect" && e.style === RIDER_GLASS_TINT);
    expect(tints).toHaveLength(1); // one window, one tint — never one per rider
    const [x0, y0, w, h] = tints[0]!.args as [number, number, number, number];
    const x1 = x0 + w;
    // (3) the rect IS the projected cabin box — not its mirror: the van's merged tint was 424 px wide
    // for a 186 px window before the axis fix, overhanging ~119 px on both ends.
    const front = shown.find((p) => p.rider === 202)!;
    const roof = rvRooflineE(front);
    expect(x0).toBeCloseTo(roof.ax0, 0); // within 1 px of the rear end (tolerance: pivot snap)
    expect(x1).toBeCloseTo(roof.ax1, 0);
    expect(Math.abs(w - (roof.ax1 - roof.ax0))).toBeLessThanOrEqual(1.5); // two snapped ends: up to ~1 px of rounding
    // (1) the rect's top never rises above the roofline: the rear roof (2.29 m) is higher than the front
    // (2.047 m), so the unclamped union's top (set by the rear riders) sat ~7 px above the front roofline.
    const roofY = (x: number): number => roof.ay0 + ((roof.ay1 - roof.ay0) * (x - roof.ax0)) / (roof.ax1 - roof.ax0);
    expect(y0).toBeGreaterThanOrEqual(roofY(x0) - 1);
    expect(y0).toBeGreaterThanOrEqual(roofY(x1) - 1);
    expect(h).toBeGreaterThan(0);
  });

  it("the van merged tint spans its (single-roof) window too", () => {
    const out = syncAt(H_E, [{ key: 1, def: def("van_passenger"), x: 10, y: 10, occupants: [201, 202, 203, 204, 205, 206, 207, 208] }]);
    const shown = out.filter((p) => p.clip && p.clip.bottom < 1e3);
    expect(shown).toHaveLength(4);
    const { events } = driveRiders(shown.map((p) => ({ clip: p.clip!, x: p.x, y: p.y, z: p.z })));
    const tints = events.filter((e) => e.op === "fillRect" && e.style === RIDER_GLASS_TINT);
    expect(tints).toHaveLength(1);
    const [x0, y0, w, h] = tints[0]!.args as [number, number, number, number];
    // the true projected cabin box: u0 = -2.75, u1 = 1.37 at PX_PER_M_LENGTH, from the front rider's pivot
    const front = shown.find((p) => p.rider === 202)!;
    const pv = worldToScreen(front.x, front.y, front.z, { tileW: 64, tileH: 32, zStep: 16 });
    const s = VEHICLE_SEAT_ART["van_passenger"]!.seats[1]!;
    expect(x0).toBeCloseTo(pv.sx + (-2.75 - s[0]) * PX_PER_M_LENGTH, 0);
    expect(x0 + w).toBeCloseTo(pv.sx + (1.37 - s[0]) * PX_PER_M_LENGTH, 0);
    expect(Math.abs(w - (1.37 - -2.75) * PX_PER_M_LENGTH)).toBeLessThanOrEqual(1.5); // two snapped ends
    expect(h).toBeGreaterThan(0);
    expect(y0).toBeLessThan(pv.sy); // above the pivot, as before
  });
});

/** --- prepare()-level wiring: the ADR-381 headless harness (stub atlas + stub GL), a real rider --- */
/** Minimal cosmetic catalog (the characters.test.ts shape): a body layer only, no wearables. */
const cat527: CosmeticCatalogLike = {
  wearable: () => undefined, bodySprite: () => ({ sprite: 1, anim: "idle" }),
  skinTones: [{ index: 0, key: "s", color: 0xffccaa }], hairColors: [{ index: 0, key: "h", color: 0x332211 }], clothingColors: [{ index: 0, key: "c", color: 0x2244aa }],
};
const app527 = (ids: Partial<Record<WearableDef["slot"], number>>): AppearanceValue => {
  const p = new Array(8).fill(0); for (const [s, id] of Object.entries(ids)) p[slotIndex(s as WearableDef["slot"])] = id;
  return { bodyType: 0, skinTone: 0, parts: p, primary: new Array(8).fill(0), secondary: new Array(8).fill(0) };
};
function stubAtlas527(): AtlasManager {
  const fixed = (out: ResolvedFrame): boolean => {
    out.sprite = 0; out.anim = "idle"; out.frame = 0; out.dfi = -1; out.w = 32; out.h = 48; out.ax = 16; out.ay = 48;
    out.atlas = 0; out.entry = 0; out.hasDamageFrames = false; out.flipX = false; return true;
  };
  return {
    registry: reg, layoutVersion: 1,
    beginFrame: () => {}, isRoof: () => false, isCrisp: () => false, isDirectional: () => true,
    isStreamSprite: () => false, isStreamed: () => false, streamNear: () => {}, markUsed: () => {}, markUsedAt: () => {},
    streamPageReady: () => true, pageReady: () => true, pageReadyAt: () => true, placeholderOf: () => -1,
    streamClass: () => null, buildingFallback: () => -1, swayOf: () => undefined, handOf: () => undefined,
    retainSprite: () => {}, releaseSprite: () => {},
    fireAnim: () => -1, animName: () => undefined, chainAnim: () => -1, sharedChainAnim: () => -1,
    sharedStateAnim: () => -1, findAnim: () => -1, animIndex: () => -1, headOffsetOf: () => ({ x: 0, y: 0 }),
    isHeadSprite: () => false, pieceInfo: () => ({ fw: 1, fh: 1, layer: 1 }), lArmOf: () => -1,
    crackOverlayOf: () => -1, isEnclosure: () => false, namedAnim: () => -1,
    resolve: (_id: number, _a: number, _f: number, _t: number, _fr: number, out: ResolvedFrame) => fixed(out),
    resolvePiece: (_v: number, _va: number, _r: number, _d: number, out: ResolvedFrame, _s: number) => fixed(out),
  } as unknown as AtlasManager;
}
const glStub527 = {
  createBuffer: () => ({}), createVertexArray: () => ({}), bindVertexArray: () => {}, bindBuffer: () => {},
  enableVertexAttribArray: () => {}, vertexAttribPointer: () => {}, vertexAttribDivisor: () => {},
  deleteBuffer: () => {}, deleteVertexArray: () => {}, bufferData: () => {},
} as unknown as WebGL2RenderingContext;
function makeBatch527(): SpriteBatch {
  const b = Object.assign(Object.create(SpriteBatch.prototype) as object, {
    gl: glStub527, iso: { ...DEFAULT_ISO }, zFactor: isoZDepthFactor(DEFAULT_ISO),
    capacity: 0, inst: new Float32Array(0), tmp: new Float32Array(0), sortKeys: new Uint32Array(0),
    gpuBytes: 0, n: 0, depthMin: 0, depthRange: 1, res: newAtlasResolved(), crackRes: newAtlasResolved(),
    cover: new PieceCoverIndex(), coverNext: new PieceCoverIndex(),
    tierFallbacks: 0, crackOverlays: 0, statics: new Map(), staticScratch: new Map(),
    dynamicChunkKeys: new Set(), pieceTmp: [] as number[],
    pieceParts: [] as { vis: number; rot: number; layer: number; x: number; y: number; last: boolean }[],
    cutCache: null, piecePartScratch: { vis: 0, rot: 0, layer: 0, x: 0, y: 0, last: true },
    pieceCache: new Map(), pieceSig: new Float64Array(32), chunkAgg: new Map(), chunkSlots: new Map(),
    pieceInfoCache: new Map(), pieceInfoLayout: -1,
    ckCache: new Map(), lateOrder: new Uint32Array(0), lateBuf: new Float32Array(0),
    sortIncremental: 0, sortFull: 0, culledChunks: 0, streamPlaceholders: 0, streamBodyFallbacks: 0,
    lastGoodLayout: -1, lastGood: new Map(), lastGoodHits: 0, partialLayers: 0, layerPlan: [],
    prevPerm: new Uint16Array(0), prevN: 0, seedBuf: new Uint32Array(0), seedUsed: new Uint8Array(0),
    frameNo: 0, xf: new Float32Array(4), chunkFadeIn: 0.35, visible: 0,
    staticInstances: 0, staticChunksDrawn: 0, staticRebuilds: 0, streamFallbacks: 0,
    focusEntity: -1, season: SUMMER_VISUAL, seasonSnowCap: 0, seasonArt: null, seasonArtReg: null,
    occT: new Float32Array(1024), occLast: -1, silInst: new Float32Array(INSTANCE_FLOATS), silOn: false,
    focusScr: [0, 0] as [number, number],
    occ: { occAmount: () => 0, peek: () => 0, overlapsFocus: () => false, occOn: false, fk: 0 },
    layerCache: null,
    characterOpts: { outline: "union", minorLayerMinZoom: 0.75, outlineWidthPx: 0, outlineColor: [0, 0, 0, 0], faceMipBias: -0.75, faceContrast: 1.12, faceUnlit: 0.3 },
    characters: 0, layerInstances: 0,
    nearInfo: Array.from({ length: 8 }, () => ({ e: -1, d: 0, layers: 0, resident: 0, drawn: 0, scale: 1, missing: [] as string[] })),
    nearN: 0, maxDressed: Infinity, dressFaces: true, dressCapped: 0,
    dressD2: new Float32Array(64), dressN: 0, dressCut: Infinity, dressDrawn: 0,
    layerRes: newAtlasResolved(), cutawayActive: false, nightGate: 1,
    route: new Uint8Array(0), curRoute: 0, intBuf: new Float32Array(0), intCount: 0,
    intVbo: null, intVao: null, intKeys: [] as number[], intRoutes: [] as number[], intIdx: [] as number[],
    late: [] as number[], lateVbo: null, lateVao: null, lateCount: 0,
    windVec: new Float32Array([1, 0]), shadowColor: new Float32Array(3),
    one: new Float32Array(INSTANCE_FLOATS), layerBase: new Float32Array(INSTANCE_FLOATS),
    heldRes: newAtlasResolved(), heldStats: [0, 0, 0] as [number, number, number],
    offHandStats: [0, 0, 0, 0] as [number, number, number, number],
    decks: new DeckNeighbors(), deckTops: new Map(), interiorRegions: [], interiorFloorIds: new Set<number>(),
    interiorWallSprite: -1, interiorCut: false,
  }) as unknown as SpriteBatch;
  return b;
}

describe("ADR-527 (2) prepare() emits the glass quad for a real rider", () => {
  // the sorted instance buffer is private on SpriteBatch; the test reads it through a cast
  const instOf = (b: SpriteBatch): Float32Array => (b as unknown as { inst: Float32Array }).inst;
  it("one rider in a vehicle yields a body instance and one window-sized glass quad, in front of the rider", () => {
    const world = new World({ seed: 1 });
    for (const c of RENDER_COMPONENTS) world.register(c);
    world.register(Transform); world.register(PrevTransform); world.register(Appearance);
    const e = world.create();
    world.add(e, Transform, { x: 10, y: 10, z: 0, facing: 0 });
    world.add(e, PrevTransform, { x: 10, y: 10, z: 0, facing: 0 });
    world.add(e, Sprite, { spriteId: 1, frameId: 0, flags: 0, scale: 1, tint: 0 });
    setAppearance(world, e, app527({}));
    // the rider's window: beltline 17 px below the pivot, roof 20 px above; the window spans 150 px left
    // to 35 px right of the pivot, with a flat roofline at the band top. Screen pivot is (0, 320).
    const clip = { bottom: -17, top: 20, glass: { lo: -150, hi: 35, vehicle: 1, roof: { x0: -150, y0: 20, x1: 35, y1: 20 } } };
    const batch = makeBatch527();
    const atlas = stubAtlas527();
    batch.prepare({
      world, alpha: 0.5, rect: { x0: -700, y0: -100, x1: 700, y1: 700 }, atlas, depthMin: -100, depthRange: 500,
      tickHz: 20, style: DEFAULT_STYLE,
      bindings: { appearance: coreAppearanceBinding(cat527), riderWindow: (en: number) => (en === e ? clip : undefined) },
      now: 100, zoom: 1,
    } as PrepareContext);
    const insts: Float32Array[] = [];
    for (let j = 0; j < batch.visible; j++) insts.push(instOf(batch).subarray(j * INSTANCE_FLOATS, (j + 1) * INSTANCE_FLOATS));
    const quads = insts.filter((o) => (o[5]! & GLASS_QUAD) !== 0);
    expect(quads).toHaveLength(1); // exactly one quad for the one vehicle
    const q = quads[0]!;
    expect(q[5]! & 16).toBe(16); // NoOutline
    expect(q[7]).toBe(1); // full instance alpha; the shader outputs 0.12
    expect(q[16]).toBe(0); // no shadow
    expect(q[1]).toBeCloseTo(337, 4); // the pivot sits on the window's bottom edge (sy - bottom = 320 + 17)
    const s = q[3]!;
    expect(q[0]! + q[10]! * s).toBeCloseTo(-150, 3); // the rect's left edge (float32)
    expect(q[0]! + q[11]! * s).toBeCloseTo(35, 3); // the rect's right edge
    expect(q[1]! - q[39]! * s).toBeCloseTo(300, 3); // the rect's top edge (sy - top)
    // the quad sorts in front of the rider's own instances at every row of the window
    const bodies = insts.filter((o) => (o[5]! & GLASS_QUAD) === 0);
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    for (const b of bodies) expect(q[2]!).toBeGreaterThan(b[2]!);
  });

  it("two riders in one vehicle merge into one quad; a rider with no glass gets none", () => {
    const world = new World({ seed: 1 });
    for (const c of RENDER_COMPONENTS) world.register(c);
    world.register(Transform); world.register(PrevTransform); world.register(Appearance);
    const mkRider = (x: number, y: number): number => {
      const e = world.create();
      world.add(e, Transform, { x, y, z: 0, facing: 0 });
      world.add(e, PrevTransform, { x, y, z: 0, facing: 0 });
      world.add(e, Sprite, { spriteId: 1, frameId: 0, flags: 0, scale: 1, tint: 0 });
      setAppearance(world, e, app527({}));
      return e;
    };
    const r1 = mkRider(10, 10), r2 = mkRider(12, 8), r3 = mkRider(20, 20);
    const clipFor = (en: number): { bottom: number; top: number; glass?: { lo: number; hi: number; vehicle: number; roof?: { x0: number; y0: number; x1: number; y1: number } } } | undefined => {
      if (en === r1 || en === r2) return { bottom: -17, top: 20, glass: { lo: -150, hi: 35, vehicle: 1, roof: { x0: -150, y0: 20, x1: 35, y1: 20 } } };
      if (en === r3) return { bottom: -17, top: 20 }; // an open seat: a band but no window outline
      return undefined;
    };
    const batch = makeBatch527();
    batch.prepare({
      world, alpha: 0.5, rect: { x0: -700, y0: -100, x1: 700, y1: 700 }, atlas: stubAtlas527(), depthMin: -100, depthRange: 500,
      tickHz: 20, style: DEFAULT_STYLE,
      bindings: { appearance: coreAppearanceBinding(cat527), riderWindow: clipFor },
      now: 100, zoom: 1,
    } as PrepareContext);
    let quads = 0;
    for (let j = 0; j < batch.visible; j++) if ((instOf(batch)[j * INSTANCE_FLOATS + 5]! & GLASS_QUAD) !== 0) quads++;
    expect(quads).toBe(1); // r1 + r2 merge into one quad for vehicle 1; r3 (no glass) adds none
  });
});
