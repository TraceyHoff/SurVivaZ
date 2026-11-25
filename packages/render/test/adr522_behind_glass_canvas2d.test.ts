import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { World, Transform, PrevTransform, Appearance, setAppearance, type CosmeticCatalogLike } from "@engine/core";
import { loadManifest, mergeManifests } from "@engine/assets";
import { PACK_DIR, readManifestJson } from "@engine/assets/node";
import { worldToScreen } from "@engine/world";
import {
  Canvas2DRenderer, RIDER_GLASS_SHEEN, RIDER_GLASS_TINT, RIDER_HEAD_PX, RIDER_LEG_PX, RIDER_WINDOW_HALF_W, RIDER_CLIP_HIDDEN,
  VehicleView, artSeat, coreAppearanceBinding, drawRiderGlass, riderWindowBand, windowBand, windowGlassSpan, VEHICLE_SEAT_ART,
  PX_PER_M_HEIGHT, VIEW_RISE, type VehicleRenderDef,
} from "../src/index.js";
import { Sprite, LightSource, Occluder } from "../src/components.js";

/**
 * ADR-522: behind-glass realism on the Canvas2D fallback. ADR-518's window clip lived in the WebGL2 sprite shader
 * only; Canvas2D drew every cab rider whole, legs through the door and head through the roof, and with no glass
 * cue the clipped rider reads as pasted on the window. ADR-522 clips the Canvas2D rider to the same windowBand
 * values WebGL2 uses (beltline..roof, incl. the pickup bed seat's rail band) and lays a subtle glass tint + sheen
 * over the clipped rider on both renderers, so the rider reads as inside behind glass.
 *
 * These tests pin the band math against the seat data, then drive Canvas2DRenderer.render() end to end with a
 * recording context: the clip rect, the rider draw inside it, and the glass fills after it.
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
/** VehicleView placements for a full van + pickup in the E view (near side faces the camera). */
const syncE = () => {
  const w = mkViewWorld(); const v = new VehicleView(w, reg, { art: true });
  return v.sync([
    { key: 1, def: def("van_passenger"), x: 10, y: 10, heading: H_E, occupants: [201, 202, 203, 204, 205, 206, 207, 208] },
    { key: 2, def: def("truck_pickup"), x: 20, y: 5, heading: H_E, occupants: [211, 212, 213] },
  ], 0, { darkness: 0 });
};
/** E-view lowering of a seat's band: the ray exits the cabin box through the side glass D m away (cu = 0). */
const sideLowering = (id: string, i: number): number => {
  const t = VEHICLE_SEAT_ART[id]!; const s = t.seats[i]!; const D = t.w / 2 - s[1]; // cv = 1, v = s[1]
  return D * VIEW_RISE * PX_PER_M_HEIGHT;
};

describe("ADR-522 rider window band (same values as WebGL2)", () => {
  it("reuses windowBand for the Canvas2D clip: van cab seat and pickup bed seat", () => {
    const out = syncE();
    const van = out.find((p) => p.rider === 206)!; // van row 3 (seat 5), near side in the E view (+v faces the camera)
    expect(van.clip).toBeDefined();
    const wb = windowBand(def("van_passenger"), 5, 0, 1)!;
    expect(van.clip!.bottom).toBeCloseTo(wb.bottom, 9); expect(van.clip!.top).toBeCloseTo(wb.top, 9); // last-bit trig noise only
    const band = riderWindowBand(van.clip, 1)!;
    expect(band.y).toBeCloseTo(-wb.top, 9);
    expect(band.h).toBeCloseTo(wb.top - wb.bottom, 9);
    // independent re-derivation from the seat tuple (belt 0.813 / roof 1.704 / z 0.7), lowered by the side distance
    const s = VEHICLE_SEAT_ART["van_passenger"]!.seats[5]!;
    const low = sideLowering("van_passenger", 5);
    expect(wb.bottom).toBeCloseTo((s[4]! - s[2]!) * PX_PER_M_HEIGHT - low, 9);
    expect(wb.top).toBeCloseTo((s[5]! - s[2]!) * PX_PER_M_HEIGHT - low, 9);
    // the bed seat's band is its own rail band — the bottom lowered by the side distance, not the cab's; the top is
    // open sky (ADR-525: no lowering), so the head clears
    const bed = out.find((p) => p.rider === 213)!;
    expect(bed.clip).toBeDefined();
    const bb = windowBand(def("truck_pickup"), 2, 0, 1)!;
    expect(bed.clip!.bottom).toBeCloseTo(bb.bottom, 9); expect(bed.clip!.top).toBeCloseTo(bb.top, 9); // last-bit trig noise only
    const bs = VEHICLE_SEAT_ART["truck_pickup"]!.seats[2]!;
    const blow = sideLowering("truck_pickup", 2);
    expect(bb.bottom).toBeCloseTo((bs[4]! - bs[2]!) * PX_PER_M_HEIGHT - blow, 9);
    expect(bb.top).toBeCloseTo((bs[5]! - bs[2]!) * PX_PER_M_HEIGHT, 9); // ADR-525 (a): open sky, unlowered
    const bedBand = riderWindowBand(bed.clip, 1)!;
    expect(bedBand.y).toBeCloseTo(-bb.top, 9); expect(bedBand.h).toBeCloseTo(bb.top - bb.bottom, 9);
    // the raw (unlowered) Art band is the seat's own belt..roof, for reference
    expect(artSeat(def("truck_pickup"), 2)!.clipBottom).toBeCloseTo((1.39 - 1.0) * PX_PER_M_HEIGHT, 9);
    expect(artSeat(def("truck_pickup"), 2)!.clipTop).toBeCloseTo((2.8 - 1.0) * PX_PER_M_HEIGHT, 9);
  });

  it("the bed seat band shows torso+head above the rail and hides the lower legs (cut at the rail, head clear of the sky)", () => {
    const bed = syncE().find((p) => p.rider === 213)!;
    const band = riderWindowBand(bed.clip, 1)!;
    // the side-view sightline over the rail crosses below the hip, so the band dips below the seat pivot (the lap
    // shows above the rail, as it does sitting in a real truck bed) — but it stays well above the feet, so the
    // lower legs are cut: the doll (RIDER_LEG_PX below the pivot to RIDER_HEAD_PX above it) is never drawn whole.
    expect(bed.clip!.bottom).toBeGreaterThan(-RIDER_LEG_PX);
    expect(bed.clip!.bottom).toBeLessThan(0);
    expect(bed.clip!.top).toBeGreaterThan(RIDER_HEAD_PX); // ADR-525 (a): open sky above the rail — the head clears, no ~2 px clip
    expect(bed.clip!.top).toBeCloseTo((2.8 - 1.0) * PX_PER_M_HEIGHT, 9); // the bed rail's open-sky cap, unlowered
    expect(band.y).toBe(-bed.clip!.top); expect(band.h).toBe(bed.clip!.top - bed.clip!.bottom);
    expect(band.h).toBeGreaterThan(RIDER_HEAD_PX); // a tall band: torso + head, not a slit
    // ADR-525 (a): the band is now taller than the whole doll (open sky above the head) — the legs are still cut,
    // by the bottom of the band, not by the band's height, so the doll's own rows bound what shows.
    expect(band.h).toBeGreaterThan(RIDER_LEG_PX + RIDER_HEAD_PX);
  });

  it("no window = no band (hidden rider), no clip = draw whole", () => {
    expect(riderWindowBand(RIDER_CLIP_HIDDEN, 1)).toBeUndefined();
    expect(riderWindowBand({ bottom: 10, top: 10 }, 1)).toBeUndefined();
    expect(riderWindowBand({ bottom: 20, top: 5 }, 1)).toBeUndefined();
    expect(riderWindowBand(undefined, 1)).toBeUndefined();
    expect(riderWindowBand({ bottom: 3, top: 30 }, 2)).toEqual({ y: -60, h: 54 }); // drawn scale k scales the band
  });
});

/** Recording 2D context: every call is logged with the translate active at the time (pivot-relative rects stay exact). */
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

const cat: CosmeticCatalogLike = {
  wearable: () => undefined,
  bodySprite: () => ({ sprite: PLAYER, anim: "idle" }),
  skinTones: [{ index: 0, key: "s", color: 0xffccaa }],
  hairColors: [{ index: 0, key: "h", color: 0x332211 }],
  clothingColors: [{ index: 0, key: "c", color: 0x2244aa }],
} as unknown as CosmeticCatalogLike;

interface DriveOpts { clip?: { bottom: number; top: number }; doll?: boolean }
function drive(opts: DriveOpts): { events: Ev[]; pivot: { sx: number; sy: number } } {
  const canvas = { width: 320, height: 240, getContext: () => ({}) } as unknown as HTMLCanvasElement;
  const { ctx, events } = makeRecCtx();
  const r = new Canvas2DRenderer(canvas, ctx);
  r.resize(640, 480, 1);
  void r.atlas.setRegistry(reg, new Map());
  (r as unknown as { image: unknown }).image = () => ({});
  const w = new World({ seed: 1 });
  w.register(Transform); w.register(PrevTransform); w.register(Sprite); w.register(Appearance);
  const e = w.create();
  w.add(e, Transform, { x: 10, y: 10, z: 0, facing: 0 });
  w.add(e, PrevTransform, { x: 10, y: 10, z: 0, facing: 0 });
  w.add(e, Sprite, { spriteId: PLAYER, frameId: 0, flags: 0, scale: 1, tint: 0 });
  const bindings: Record<string, unknown> = {};
  if (opts.clip) bindings.riderWindow = () => opts.clip;
  if (opts.doll) {
    setAppearance(w, e, { bodyType: 0, skinTone: 0, parts: new Array(8).fill(0), primary: new Array(8).fill(0), secondary: new Array(8).fill(0) });
    bindings.appearance = coreAppearanceBinding(cat);
  }
  r.bindGameplay(bindings as never);
  const rc = r as unknown as { clock: number; clockAt: number };
  rc.clock = 0; rc.clockAt = -1; // pin the render clock (ADR-414's trick)
  r.render(w, 1);
  return { events, pivot: worldToScreen(10, 10, 0, r.iso) };
}
const vanClip = (): { bottom: number; top: number } => syncE().find((p) => p.rider === 206)!.clip!;
const playerFrame = () => reg.dirFrame(PLAYER, "idle", 0, 0);

describe("ADR-522 Canvas2D rider clip + glass (render drive)", () => {
  it("a cab rider is clipped to the window band and glassed, not drawn whole", () => {
    const clip = vanClip();
    const { events, pivot } = drive({ clip });
    const clips = events.filter((e) => e.op === "clip");
    expect(clips).toHaveLength(1); // the rider's band clip: nothing else clips in this scene
    const rect = events[events.findIndex((e) => e.op === "clip") - 1]!;
    expect(rect.op).toBe("rect");
    expect(rect.args).toEqual([-RIDER_WINDOW_HALF_W, -clip.top, RIDER_WINDOW_HALF_W * 2, clip.top - clip.bottom]);
    // the clip sits on the rider's pivot (translate snapped to whole px)
    expect(Math.abs(clips[0]!.ty - pivot.sy)).toBeLessThanOrEqual(1);
    expect(Math.abs(clips[0]!.tx - pivot.sx)).toBeLessThanOrEqual(1);
    const ci = events.findIndex((e) => e.op === "clip");
    const di = events.findIndex((e) => e.op === "drawImage");
    expect(di).toBeGreaterThan(ci); // the rider draws inside the clip, after it
    // glass over the clipped rider: tint fill then the sheen stripe, both after the draw. ADR-525 (c): the glass is
    // drawn once after the loop and spans the window's own outline (the projected cabin box at the seat), not the
    // rider — so the tint is far wider than the rider and sits in absolute (loop-level) coords, not pivot-relative.
    const f = playerFrame();
    const tint = events.find((e) => e.op === "fillRect" && e.style === RIDER_GLASS_TINT)!;
    expect(tint).toBeDefined();
    const glass = windowGlassSpan(def("van_passenger"), 5, 0, 1)!;
    const tx0 = tint.args[0] as number, ty0 = tint.args[1] as number, tw = tint.args[2] as number, th = tint.args[3] as number;
    expect(Math.abs(tx0 - (pivot.sx + glass.lo))).toBeLessThanOrEqual(1); // pivot snap, as the clip above
    expect(Math.abs(ty0 - (pivot.sy - clip.top))).toBeLessThanOrEqual(1);
    expect(tw).toBeCloseTo(glass.hi - glass.lo, 6);
    expect(th).toBeCloseTo(clip.top - clip.bottom, 6);
    expect(tw).toBeGreaterThan(f.w + 4); // the window, not the rider
    expect(tx0).toBeLessThan(pivot.sx - f.w / 2); // ...extending past the rider on both sides
    expect(tx0 + tw).toBeGreaterThan(pivot.sx + f.w / 2);
    const ti = events.indexOf(tint);
    expect(ti).toBeGreaterThan(di);
    const sheen = events.find((e) => e.op === "fill" && e.style === RIDER_GLASS_SHEEN)!;
    expect(sheen).toBeDefined();
    expect(events.indexOf(sheen)).toBeGreaterThan(ti);
    // the sheen stripe is drawn inside the window rect (its path stays within the band rows, absolute coords)
    const si = events.indexOf(sheen);
    const stripe = events.slice(ti, si).filter((e) => e.op === "moveTo" || e.op === "lineTo");
    expect(stripe.length).toBe(4);
    for (const p of stripe) { expect(p.args[1] as number).toBeGreaterThanOrEqual(pivot.sy - clip.top - 1); expect(p.args[1] as number).toBeLessThanOrEqual(pivot.sy - clip.bottom + 1); }
  });

  it("with no riderWindow binding the rider draws whole: no clip, no glass", () => {
    const { events } = drive({});
    expect(events.some((e) => e.op === "clip")).toBe(false);
    expect(events.some((e) => e.style === RIDER_GLASS_TINT)).toBe(false);
    expect(events.filter((e) => e.op === "drawImage")).toHaveLength(1); // the rider, whole
  });

  it("a rider with no window (hidden clip) does not draw at all on Canvas2D", () => {
    const { events } = drive({ clip: { ...RIDER_CLIP_HIDDEN } });
    expect(events.filter((e) => e.op === "drawImage")).toHaveLength(0);
    expect(events.some((e) => e.style === RIDER_GLASS_TINT)).toBe(false);
  });

  it("the paper-doll rider (the real in-game path) is clipped and glassed layer by layer", () => {
    const clip = vanClip();
    const { events } = drive({ clip, doll: true });
    const clips = events.filter((e) => e.op === "clip");
    expect(clips).toHaveLength(1);
    const rect = events[events.findIndex((e) => e.op === "clip") - 1]!;
    expect(rect.args).toEqual([-RIDER_WINDOW_HALF_W, -clip.top, RIDER_WINDOW_HALF_W * 2, clip.top - clip.bottom]);
    const ci = events.findIndex((e) => e.op === "clip");
    const draws = events.map((e, i) => (e.op === "drawImage" ? i : -1)).filter((i) => i >= 0);
    expect(draws.length).toBeGreaterThanOrEqual(1); // the doll's layers, all inside the one band clip
    expect(draws[0]!).toBeGreaterThan(ci);
    const tint = events.find((e) => e.op === "fillRect" && e.style === RIDER_GLASS_TINT)!;
    expect(tint).toBeDefined();
    expect(events.indexOf(tint)).toBeGreaterThan(draws[draws.length - 1]!); // glass after every layer
    expect(events.some((e) => e.op === "fill" && e.style === RIDER_GLASS_SHEEN)).toBe(true);
  });
});

describe("ADR-522 drawRiderGlass geometry", () => {
  it("tints the rider-width band and stripes it diagonally, inside the band rows", () => {
    const { ctx, events } = makeRecCtx();
    drawRiderGlass(ctx, { y: -30, h: 27 }, 20);
    const tint = events.find((e) => e.op === "fillRect")!;
    expect(tint.style).toBe(RIDER_GLASS_TINT);
    expect(tint.args).toEqual([-20, -30, 40, 27]);
    const sheen = events.find((e) => e.op === "fill" && e.style === RIDER_GLASS_SHEEN)!;
    expect(sheen).toBeDefined();
    const pts = events.filter((e) => e.op === "moveTo" || e.op === "lineTo").map((e) => e.args as [number, number]);
    expect(pts).toHaveLength(4);
    expect(pts[0]![1]).toBe(-30); expect(pts[1]![1]).toBe(-3); // stripe runs top edge -> bottom edge
    expect(pts[1]![0]).toBeGreaterThan(pts[0]![0]); // slanted, not vertical
    expect(Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]))).toBeGreaterThan(8); // visible width
  });
});
