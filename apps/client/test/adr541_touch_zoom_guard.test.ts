// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { InputSystem, TouchDevice, VirtualControls, DEFAULT_ACTIONS, DEFAULT_CONTEXTS, DEFAULT_PROFILES, DEFAULT_TOUCH_LAYOUTS } from "@engine/input";
import { attachZoom, USER_ZOOM_MAX, USER_ZOOM_MIN, loadUserZoom, type ZoomControl } from "../src/camera-zoom.js";
import { GameMenus } from "../src/game-menus.js";

/** ADR-541: moving with the virtual joystick while tapping a virtual touch button must not zoom the view.
 * The pinch tracker in attachZoom used to track EVERY touch pointer, including ones already claimed by
 * VirtualControls (the painted touch overlay is pointer-events:none, so button taps land on #game). */

const W = 844, H = 390; // landscape phone reference, same geometry as packages/input/test/input.test.ts
const mem = () => { const m = new Map<string, string>(); let writes = 0;
  return { st: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { writes++; m.set(k, v); } }, writes: () => writes }; };

function setup(enabled: () => boolean = () => true) {
  let now = 0; const clock = { now: () => now, advance: (ms: number) => { now += ms; } };
  const sys = new InputSystem(clock as never, { actions: DEFAULT_ACTIONS, contexts: DEFAULT_CONTEXTS, profiles: DEFAULT_PROFILES });
  const touch = new TouchDevice(); sys.addDevice(touch); sys.push("Gameplay");
  const tick = (ms = 16) => { clock.advance(ms); sys.update(); };
  const vc = new VirtualControls(DEFAULT_TOUCH_LAYOUTS.gameplay, touch);
  vc.resize({ w: W, h: H, insets: { top: 0, right: 30, bottom: 20, left: 30 } });
  const canvas = document.createElement("canvas"); document.body.append(canvas);
  const { st, writes } = mem();
  const cam = { zoom: 0 };
  const zc = attachZoom(cam, canvas, { storage: st, viewport: () => ({ w: W, h: H }), enabled, controls: () => vc });
  const atk = vc.geometry().find((g) => g.id === "attack")!;
  // Synthetic touch pointers, dispatched the way the browser delivers them: pointerdown on the canvas,
  // pointermove/pointerup bubbling up to attachZoom's window-level listeners. (jsdom has no PointerEvent
  // constructor, so the pointer fields are assigned onto a plain bubbling Event — handlers only read them.)
  const ev = (type: string, id: number, x: number, y: number, pointerType = "touch") => {
    const e = new Event(type, { bubbles: true, cancelable: true }) as unknown as PointerEvent;
    Object.assign(e, { pointerId: id, pointerType, clientX: x, clientY: y });
    canvas.dispatchEvent(e);
  };
  // Route through VirtualControls first, exactly like attachBrowserInput does (browser.ts:75) — it claims the
  // pointer before attachZoom's canvas listener sees it in the real app (browserInput is wired first).
  const down = (id: number, x: number, y: number) => { vc.pointerDown(id, x, y); ev("pointerdown", id, x, y); };
  const move = (id: number, x: number, y: number) => { vc.pointerMove(id, x, y); ev("pointermove", id, x, y); };
  const up = (id: number, x: number, y: number) => { vc.pointerUp(id); ev("pointerup", id, x, y); };
  return { sys, touch, vc, canvas, cam, zc, atk, tick, st, writes, down, move, up, ev };
}

const disposables: { dispose(): void }[] = [];
afterEach(() => { for (const d of disposables.splice(0)) d.dispose(); document.body.innerHTML = ""; });

describe("ADR-541 move + tap a touch button must not zoom", () => {
  it("repro: joystick held + attack tap, then joystick moves → no zoom, move + attack still work", () => {
    const s = setup(); disposables.push(s.zc);
    expect(s.vc.hasPointer(1)).toBe(false);
    s.down(1, 100, 300); // joystick finger (floating zone)
    expect(s.vc.hasPointer(1)).toBe(true);
    s.down(2, s.atk.x, s.atk.y); // attack button finger
    expect(s.vc.hasPointer(2)).toBe(true);
    s.tick(); expect(s.sys.down("Primary")).toBe(true); // attack still pressed
    s.move(1, 130, 300); s.move(1, 150, 300); s.tick(); // walk 20–50 px with the button held
    expect(s.zc.user).toBe(1); // was ~0.94 before the fix (accidental zoom-out)
    expect(s.sys.vector("Move")[0]).toBeGreaterThan(0); // joystick still drives movement
    expect(s.sys.down("Primary")).toBe(true); // attack still held
    s.up(2, s.atk.x, s.atk.y); s.up(1, 150, 300); s.tick();
    expect(s.sys.down("Primary")).toBe(false);
  });
  it("reverse order: button first, joystick second, move joystick → no zoom", () => {
    const s = setup(); disposables.push(s.zc);
    s.down(2, s.atk.x, s.atk.y); s.down(1, 100, 300); s.tick();
    expect(s.sys.down("Primary")).toBe(true);
    s.move(1, 140, 300); s.tick();
    expect(s.zc.user).toBe(1); expect(s.sys.vector("Move")[0]).toBeGreaterThan(0);
    s.up(2, s.atk.x, s.atk.y); s.up(1, 140, 300);
  });
  it("legit pinch still works: two unclaimed pointers zoom proportionally and clamp", () => {
    const s = setup(); disposables.push(s.zc);
    // (400,100) and (520,100) are outside every virtual control — VirtualControls claims neither.
    expect(s.vc.pointerDown(1, 400, 100)).toBe(false); expect(s.vc.pointerDown(2, 520, 100)).toBe(false);
    s.ev("pointerdown", 1, 400, 100); s.ev("pointerdown", 2, 520, 100);
    s.ev("pointermove", 2, 560, 100); // spread 120 → 160
    expect(s.zc.user).toBeCloseTo(160 / 120, 6);
    s.ev("pointermove", 2, 440, 100); // pinch together 160 → 40
    expect(s.zc.user).toBe(USER_ZOOM_MIN); // 40/120 clamps at the floor
    s.ev("pointermove", 2, 900, 100); // spread far apart
    expect(s.zc.user).toBe(USER_ZOOM_MAX);
    s.ev("pointerup", 1, 400, 100); s.ev("pointerup", 2, 900, 100);
  });
  it("pinch starting ≤40 px apart does not zoom (documents the current pinch0 threshold)", () => {
    const s = setup(); disposables.push(s.zc);
    s.ev("pointerdown", 1, 400, 100); s.ev("pointerdown", 2, 420, 100); // 20 px apart
    s.ev("pointermove", 2, 520, 100); // spread to 120 px — still no zoom: pinch0 was 20
    expect(s.zc.user).toBe(1);
    s.ev("pointerup", 1, 400, 100); s.ev("pointerup", 2, 520, 100);
  });
  it("joystick continuity: after the button lifts, joystick moves still drive touch.move; no stale pinch after both lift", () => {
    const s = setup(); disposables.push(s.zc);
    s.down(1, 100, 300); s.down(2, s.atk.x, s.atk.y);
    s.move(1, 130, 300); expect(s.zc.user).toBe(1);
    s.up(2, s.atk.x, s.atk.y); // button finger lifts
    s.move(1, 160, 300); s.tick(); expect(s.sys.vector("Move")[0]).toBe(1); expect(s.zc.user).toBe(1);
    s.up(1, 160, 300);
    // A later single-finger touch never zooms (no stale pinch0 from the earlier two-finger state).
    s.ev("pointerdown", 1, 400, 100); s.ev("pointermove", 1, 500, 100); s.ev("pointerup", 1, 500, 100);
    expect(s.zc.user).toBe(1);
  });
  it("claimed pointer that reached the tracker first is dropped on move (stale-baseline guard)", () => {
    const s = setup(); disposables.push(s.zc);
    // Listener-order flip: attachZoom's down() runs BEFORE VirtualControls claims the pointer.
    s.ev("pointerdown", 1, 100, 300); s.vc.pointerDown(1, 100, 300);
    s.ev("pointerdown", 2, s.atk.x, s.atk.y); s.vc.pointerDown(2, s.atk.x, s.atk.y);
    s.move(1, 150, 300); s.move(2, s.atk.x, s.atk.y); // both owned now: dropped, pinch0 reset
    expect(s.zc.user).toBe(1);
    // And the drop left no stale baseline: a fresh legit pinch afterwards zooms from user 1.
    s.up(1, 150, 300); s.up(2, s.atk.x, s.atk.y);
    s.ev("pointerdown", 1, 400, 100); s.ev("pointerdown", 2, 520, 100); s.ev("pointermove", 2, 560, 100);
    expect(s.zc.user).toBeCloseTo(160 / 120, 6);
    s.ev("pointerup", 1, 400, 100); s.ev("pointerup", 2, 560, 100);
  });
  it("DOM menu-bar button: pointerdown stops at the button while the joystick is held → no zoom", () => {
    const s = setup(); disposables.push(s.zc);
    const root = document.createElement("div"); document.body.append(root);
    const menus = new GameMenus({ root } as never); disposables.push({ dispose: () => menus.destroy() });
    const barBtn = menus.bar!.querySelector("button")!;
    s.down(1, 100, 300);
    let leaked = 0; const spy = () => leaked++; document.body.addEventListener("pointerdown", spy);
    const btnEv = new Event("pointerdown", { bubbles: true, cancelable: true }) as unknown as PointerEvent;
    Object.assign(btnEv, { pointerId: 2, pointerType: "touch", clientX: 0, clientY: 0 });
    barBtn.dispatchEvent(btnEv);
    expect(leaked).toBe(0); // menu-bar pointerdown never bubbles toward the canvas
    s.move(1, 150, 300); s.tick();
    expect(s.zc.user).toBe(1); expect(s.sys.vector("Move")[0]).toBeGreaterThan(0);
    document.body.removeEventListener("pointerdown", spy);
    s.up(1, 150, 300);
  });
  it("mouse/pen regression: mouse pointerdown + move never zooms; disabled still blocks nudge/move", () => {
    const s = setup(); disposables.push(s.zc);
    s.ev("pointerdown", 1, 400, 100, "mouse"); s.ev("pointermove", 1, 500, 100, "mouse");
    expect(s.zc.user).toBe(1); // down() returns early unless pointerType is touch
    s.ev("pointerdown", 2, 400, 100, "pen"); s.ev("pointermove", 2, 500, 100, "pen");
    expect(s.zc.user).toBe(1);
    s.ev("pointerup", 1, 500, 100, "mouse"); s.ev("pointerup", 2, 500, 100, "pen");
    const off = setup(() => false); disposables.push(off.zc);
    off.ev("pointerdown", 1, 400, 100); off.ev("pointerdown", 2, 520, 100); off.ev("pointermove", 2, 560, 100);
    expect(off.zc.user).toBe(1); // down() now checks enabled() too
    off.zc.nudge(1, 100); expect(off.zc.user).toBe(1);
    off.ev("pointerup", 1, 400, 100); off.ev("pointerup", 2, 560, 100);
  });
  it("no persistence on accident: the repro writes nothing to engine-settings", async () => {
    const s = setup(); disposables.push(s.zc);
    s.down(1, 100, 300); s.down(2, s.atk.x, s.atk.y);
    s.move(1, 130, 300); s.move(1, 150, 300);
    s.up(2, s.atk.x, s.atk.y); s.up(1, 150, 300);
    await new Promise((r) => setTimeout(r, 350)); // past the 300 ms debounced save
    expect(s.writes()).toBe(0); expect(loadUserZoom(s.st)).toBe(1);
  });
  it("hasPointer is a read-only ownership query (no behaviour change to VirtualControls)", () => {
    const s = setup(); disposables.push(s.zc);
    expect(s.vc.hasPointer(9)).toBe(false);
    s.vc.pointerDown(9, 100, 300); expect(s.vc.hasPointer(9)).toBe(true);
    s.vc.pointerUp(9); expect(s.vc.hasPointer(9)).toBe(false);
  });
});
