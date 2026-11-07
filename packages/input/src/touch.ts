import { deadzoneRadial } from "./processors.js";
import type { MapDevice } from "./devices.js";

/** Data-only virtual control layout (Renderer/Art draw it from geometry()). Units: dp in a reference resolution. */
export interface Anchor { x: number; y: number; portrait?: { x: number; y: number } } // normalized 0..1 inside the safe area
export type VirtualElement =
  | { id: string; kind: "joystick"; mode: "fixed" | "floating"; anchor: Anchor; radius: number; deadzone?: number; /** floating activation zone (normalized rect) */ zone?: { x: number; y: number; w: number; h: number }; control: string }
  | { id: string; kind: "button"; anchor: Anchor; radius: number; control: string; /** extra dp before a drag cancels the press */ slop?: number; label?: string; glyph?: string }
  | { id: string; kind: "radial"; anchor: Anchor; radius: number; innerRadius?: number; items: string[]; /** control prefix; item i pulses `${control}.${items[i]}` */ control: string };
export interface VirtualLayout { id: string; reference: { w: number; h: number }; elements: VirtualElement[] }
export interface Insets { top: number; right: number; bottom: number; left: number }
export interface Screen { w: number; h: number; dpr?: number; insets?: Insets }
export interface ElementGeometry { id: string; kind: VirtualElement["kind"]; x: number; y: number; r: number; pressed: boolean; knob?: { x: number; y: number }; highlighted?: number; visible: boolean }

/**
 * Virtual controls: hit-tests pointers against the resolved layout and writes `touch.*` controls into a TouchDevice
 * (joystick: `${control}.x|y`, buttons: control 0/1 with hold-cancel when the finger leaves, radial: pulses).
 * Pointers that hit nothing are returned false so the caller can route them to a GestureRecognizer.
 */
/** Min gap (px) between a touch control's edge and the screen/safe-area edge. */
export const TOUCH_EDGE_MARGIN = 4;
export class VirtualControls {
  leftHanded = false;
  /** Element ids hidden right now (context-only controls, ADR-133): not drawn (visible=false) and not hit-tested. */
  hidden = new Set<string>();
  private screen: Screen = { w: 1, h: 1 };
  private owners = new Map<number, { el: VirtualElement; cx: number; cy: number; sel?: number }>();
  private pressed = new Set<string>();
  private knobs = new Map<string, { x: number; y: number; cx: number; cy: number }>();
  private radialSel = new Map<string, number>();
  constructor(public layout: VirtualLayout, readonly device: MapDevice) {}
  resize(s: Screen): void { this.screen = s; }
  /** Scale from reference dp to screen px: fit-min, clamped to [1, 1.15]: thumb-sized (44-64 px) on every phone, never bloated on tablets (ADR-133). */
  get scale(): number { const s = this.screen; return Math.max(1, Math.min(1.15, Math.min(s.w / this.layout.reference.w, s.h / this.layout.reference.h))); }
  private place(el: VirtualElement): { x: number; y: number; r: number } {
    const s = this.screen, i = s.insets ?? { top: 0, right: 0, bottom: 0, left: 0 };
    const anchor = s.w < s.h ? el.anchor.portrait ?? el.anchor : el.anchor;
    const ax = this.leftHanded ? 1 - anchor.x : anchor.x; const w = s.w - i.left - i.right, h = s.h - i.top - i.bottom;
    // ADR-142: fractional anchors put edge buttons (e.g. Crouch at x=0.05) partly off a 390 px-wide phone; keep every control fully on screen
    const r = el.radius * this.scale, m = el.kind === "joystick" ? 0 : r + TOUCH_EDGE_MARGIN, cl = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v)));
    return { x: cl(i.left + ax * w, i.left + m, s.w - i.right - m), y: cl(i.top + anchor.y * h, i.top + m, s.h - i.bottom - m), r };
  }
  geometry(): ElementGeometry[] {
    return this.layout.elements.map((el) => {
      const p = this.place(el); const k = this.knobs.get(el.id);
      const g: ElementGeometry = { id: el.id, kind: el.kind, x: k?.cx ?? p.x, y: k?.cy ?? p.y, r: p.r, pressed: this.pressed.has(el.id), visible: !this.hidden.has(el.id) && (el.kind !== "joystick" || el.mode === "fixed" || !!k) };
      if (k) g.knob = { x: k.x, y: k.y }; const sel = this.radialSel.get(el.id); if (sel !== undefined) g.highlighted = sel; return g;
    });
  }
  private hit(x: number, y: number): VirtualElement | undefined {
    const els = [...this.layout.elements].sort((a, b) => Number(a.kind === "joystick" && a.mode === "floating") - Number(b.kind === "joystick" && b.mode === "floating"));
    for (const el of els) {
      if (this.hidden.has(el.id)) continue; const p = this.place(el);
      if (el.kind === "joystick" && el.mode === "floating") {
        const z = el.zone ?? { x: 0, y: 0.4, w: 0.5, h: 0.6 }; const zx = this.leftHanded ? 1 - z.x - z.w : z.x;
        if (x >= zx * this.screen.w && x <= (zx + z.w) * this.screen.w && y >= z.y * this.screen.h && y <= (z.y + z.h) * this.screen.h) return el;
      } else if (Math.hypot(x - p.x, y - p.y) <= p.r) return el;
    }
    return undefined;
  }
  pointerDown(id: number, x: number, y: number): boolean {
    const el = this.hit(x, y); if (!el) return false; const p = this.place(el);
    const cx = el.kind === "joystick" && el.mode === "floating" ? x : p.x, cy = el.kind === "joystick" && el.mode === "floating" ? y : p.y;
    this.owners.set(id, { el, cx, cy }); this.pressed.add(el.id);
    if (el.kind === "button") this.device.press(el.control);
    if (el.kind === "joystick") { this.knobs.set(el.id, { x, y, cx, cy }); this.pointerMove(id, x, y); }
    if (el.kind === "radial") this.radialSel.delete(el.id);
    return true;
  }
  pointerMove(id: number, x: number, y: number): boolean {
    const o = this.owners.get(id); if (!o) return false; const el = o.el; const r = this.place(el).r;
    if (el.kind === "joystick") {
      const v = deadzoneRadial([(x - o.cx) / r, (y - o.cy) / r], el.deadzone ?? 0.12, 1); const m = Math.hypot(v[0], v[1]); const k = m > 1 ? 1 / m : 1;
      this.device.set(`${el.control}.x`, v[0] * k); this.device.set(`${el.control}.y`, v[1] * k);
      const dx = x - o.cx, dy = y - o.cy, d = Math.hypot(dx, dy), c = d > r ? r / d : 1; this.knobs.set(el.id, { x: o.cx + dx * c, y: o.cy + dy * c, cx: o.cx, cy: o.cy });
    } else if (el.kind === "button") {
      if (this.pressed.has(el.id) && Math.hypot(x - o.cx, y - o.cy) > r + (el.slop ?? 12) * this.scale) { this.device.cancel(el.control); this.pressed.delete(el.id); } // hold-cancel
    } else {
      const d = Math.hypot(x - o.cx, y - o.cy); if (d < (el.innerRadius ?? r * 0.3)) { this.radialSel.delete(el.id); return true; }
      const a = (Math.atan2(y - o.cy, x - o.cx) + Math.PI * 2.5) % (Math.PI * 2); this.radialSel.set(el.id, Math.floor((a / (Math.PI * 2)) * el.items.length) % el.items.length);
    }
    return true;
  }
  pointerUp(id: number): boolean {
    const o = this.owners.get(id); if (!o) return false; this.owners.delete(id); const el = o.el; this.pressed.delete(el.id);
    if (el.kind === "button") this.device.release(el.control);
    if (el.kind === "joystick") { this.device.set(`${el.control}.x`, 0); this.device.set(`${el.control}.y`, 0); this.knobs.delete(el.id); }
    if (el.kind === "radial") { const s = this.radialSel.get(el.id); if (s !== undefined) this.device.pulse(`${el.control}.${el.items[s]}`, 1); this.radialSel.delete(el.id); }
    return true;
  }
  /** Release everything (blur, orientation change). */
  reset(): void { for (const id of [...this.owners.keys()]) this.pointerUp(id); }
}

export type Gesture =
  | { type: "tap" | "doubleTap" | "longPress"; x: number; y: number }
  | { type: "dragStart" | "drag" | "dragEnd"; x: number; y: number; dx: number; dy: number }
  | { type: "pinch"; scale: number; cx: number; cy: number }
  | { type: "rotate"; angle: number; cx: number; cy: number }
  | { type: "swipe"; direction: "left" | "right" | "up" | "down"; x: number; y: number };
export interface GestureOptions { tapSlop?: number; tapMs?: number; doubleGapMs?: number; longPressMs?: number; swipeMinDist?: number; swipeMinVelocity?: number }
/**
 * Pointer gesture recognition (times in ms, positions in px). Feed pointer events + update(now) for long-press.
 * Optional `device` gets pulses: touch.tap, touch.swipe.<dir>, touch.pinch.in|out, touch.rotate.cw|ccw.
 */
export class GestureRecognizer {
  private pts = new Map<number, { x: number; y: number; sx: number; sy: number; t0: number; moved: boolean; long: boolean }>();
  private lastTap = { t: -1e9, x: 0, y: 0 }; private dragging = false; private pinch0 = 0; private angle0 = 0; private rotAcc = 0;
  readonly o: Required<GestureOptions>;
  constructor(private onGesture: (g: Gesture) => void, opts: GestureOptions = {}, private device?: MapDevice) {
    this.o = { tapSlop: 10, tapMs: 250, doubleGapMs: 300, longPressMs: 500, swipeMinDist: 60, swipeMinVelocity: 0.4, ...opts };
  }
  private emit(g: Gesture): void {
    this.onGesture(g); const d = this.device; if (!d) return;
    if (g.type === "tap") d.pulse("touch.tap", 1);
    if (g.type === "doubleTap") d.pulse("touch.doubleTap", 1);
    if (g.type === "longPress") d.pulse("touch.longPress", 1);
    if (g.type === "swipe") d.pulse(`touch.swipe.${g.direction}`, 1);
  }
  private two(): [{ x: number; y: number }, { x: number; y: number }] | undefined { const v = [...this.pts.values()]; return v.length >= 2 ? [v[0]!, v[1]!] : undefined; }
  down(id: number, x: number, y: number, t: number): void {
    this.pts.set(id, { x, y, sx: x, sy: y, t0: t, moved: false, long: false });
    const two = this.two(); if (two) { this.pinch0 = Math.hypot(two[1].x - two[0].x, two[1].y - two[0].y); this.angle0 = Math.atan2(two[1].y - two[0].y, two[1].x - two[0].x); this.rotAcc = 0; if (this.dragging) { this.dragging = false; } }
    if (this.device && this.pts.size === 1) this.device.press("touch.hold");
  }
  move(id: number, x: number, y: number, _t: number): void {
    const p = this.pts.get(id); if (!p) return; const px = p.x, py = p.y; p.x = x; p.y = y;
    if (Math.hypot(x - p.sx, y - p.sy) > this.o.tapSlop) p.moved = true;
    const two = this.two();
    if (two) {
      const d = Math.hypot(two[1].x - two[0].x, two[1].y - two[0].y), a = Math.atan2(two[1].y - two[0].y, two[1].x - two[0].x); const cx = (two[0].x + two[1].x) / 2, cy = (two[0].y + two[1].y) / 2;
      if (this.pinch0 > 0 && Math.abs(d / this.pinch0 - 1) > 0.02) { const sc = d / this.pinch0; this.emit({ type: "pinch", scale: sc, cx, cy }); this.device?.pulse(sc > 1 ? "touch.pinch.out" : "touch.pinch.in", 1); this.pinch0 = d; }
      let da = a - this.angle0; da = Math.atan2(Math.sin(da), Math.cos(da));
      if (Math.abs(da) > 0.01) { this.emit({ type: "rotate", angle: da, cx, cy }); this.angle0 = a; this.rotAcc += da; if (Math.abs(this.rotAcc) >= Math.PI / 4) { this.device?.pulse(this.rotAcc > 0 ? "touch.rotate.cw" : "touch.rotate.ccw", 1); this.rotAcc = 0; } }
      return;
    }
    if (p.moved) {
      if (!this.dragging) { this.dragging = true; this.emit({ type: "dragStart", x: p.sx, y: p.sy, dx: 0, dy: 0 }); }
      this.emit({ type: "drag", x, y, dx: x - px, dy: y - py });
    }
  }
  up(id: number, x: number, y: number, t: number): void {
    const p = this.pts.get(id); if (!p) return; this.pts.delete(id); const wasMulti = this.pts.size > 0;
    if (this.device && this.pts.size === 0) this.device.release("touch.hold");
    if (wasMulti) return;
    if (this.dragging) {
      this.dragging = false; this.emit({ type: "dragEnd", x, y, dx: x - p.sx, dy: y - p.sy });
      const dist = Math.hypot(x - p.sx, y - p.sy), v = dist / Math.max(1, t - p.t0);
      if (dist >= this.o.swipeMinDist && v >= this.o.swipeMinVelocity) {
        const dx = x - p.sx, dy = y - p.sy; this.emit({ type: "swipe", direction: Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down", x, y });
      }
      return;
    }
    if (!p.moved && !p.long && t - p.t0 <= this.o.tapMs) {
      if (t - this.lastTap.t <= this.o.doubleGapMs && Math.hypot(x - this.lastTap.x, y - this.lastTap.y) <= this.o.tapSlop * 3) { this.emit({ type: "doubleTap", x, y }); this.lastTap.t = -1e9; }
      else { this.emit({ type: "tap", x, y }); this.lastTap = { t, x, y }; }
    }
  }
  cancel(id: number): void { this.pts.delete(id); if (this.dragging && !this.pts.size) this.dragging = false; }
  /** Drives long-press detection. */
  update(t: number): void {
    for (const p of this.pts.values()) if (!p.moved && !p.long && this.pts.size === 1 && t - p.t0 >= this.o.longPressMs) { p.long = true; this.emit({ type: "longPress", x: p.x, y: p.y }); }
  }
}
