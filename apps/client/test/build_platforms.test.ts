// @vitest-environment jsdom
/** ADR-136: building on every platform — kbm, gamepad, touch flows through BuildMode + the compact build HUD. */
import { describe, expect, test } from "vitest";
import { installPermissions, Transform, World, type Entity } from "@engine/core";
import * as G from "@engine/gameplay";
import { InputSystem, KeyboardMouseDevice, GamepadDevice, DEFAULT_ACTIONS, DEFAULT_CONTEXTS, DEFAULT_PROFILES } from "@engine/input";
import { BuildMode, type BuildDevice } from "../src/build-mode.js";
import { renderBuildHud, onTouchControl, mountBuildHud, buildFailText } from "../src/build-hud.js";
import { plantClaim } from "../../../packages/gameplay/test/helpers.js";

function setup(device: BuildDevice, aimAt = { x: 2, y: 0, mode: 1 }) {
  const w = new World({ seed: 1, maxEntities: 1 << 12 }); G.installGameplay(w, {}); installPermissions(w);
  const me = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); const d = G.gameplayDefs(w);
  plantClaim(w, me, -2, 2);
  for (const k of ["sticks", "planks", "rope"]) G.addItem(w, me, d.itemId(k), 50);
  const clock = { t: 0, now: () => clock.t };
  const sys = new InputSystem(clock as never, { actions: DEFAULT_ACTIONS, contexts: DEFAULT_CONTEXTS, profiles: DEFAULT_PROFILES });
  const kbm = new KeyboardMouseDevice(); const pad = new GamepadDevice(0); sys.addDevice(kbm); sys.addDevice(pad); sys.push("Gameplay");
  const sent: G.MenuIntent[] = []; let aim = aimAt; let picked = 0;
  const bm = new BuildMode({ input: sys, ctx: () => ({ world: w, player: me, names: new Map() }), aim: () => aim, send: (i) => { sent.push(i); return true; }, device: () => device, now: () => clock.t, onPickPiece: () => picked++ });
  const tick = () => { clock.t += 50; sys.update(); bm.update(); };
  const foundation = d.pieceId("foundation");
  const placeAt = (x: number, y: number, level = 0): Entity => {
    const r = G.tryPlace(w, me, { piece: foundation, x, y, level, rot: 0, tier: 0, variant: 0 }); expect(r.ok).toBe(true);
    return [...w.query([G.BuildPiece, Transform])].find((e) => { const t = w.get(e, Transform)!; return Math.abs(t.x - Math.floor(x) - 0.5) < 0.6 && Math.abs(t.y - Math.floor(y) - 0.5) < 0.6; })!;
  };
  return { w, me, d, sys, kbm, pad, sent, bm, tick, foundation, placeAt, clock, setAim: (a: typeof aim) => { aim = a; }, picked: () => picked };
}
const names = (s: G.MenuIntent[]) => s.map((i) => i.cmd.name);

describe("keyboard + mouse", () => {
  test("place, rotate, wheel piece / Shift+wheel tier, PgUp floor, H/U/X contextual actions with demolish confirm, Esc", () => {
    const s = setup("keyboardMouse"); s.bm.start({ piece: s.foundation, tier: 0, variant: 0, paint: 0 });
    const tap = (c: string, mods: string[] = []) => { for (const m of mods) s.kbm.press(m); s.kbm.press(c); s.tick(); s.kbm.releaseAll(); s.tick(); };
    tap("key.KeyR"); expect(s.bm.rot).toBe(1); tap("key.KeyQ"); expect(s.bm.rot).toBe(0);
    tap("mouse.left"); expect(names(s.sent)).toEqual(["gameplay.place"]);
    const before = s.bm.selection!.piece; tap("mouse.wheelDown"); expect(s.bm.selection!.piece).not.toBe(before); tap("mouse.wheelUp"); expect(s.bm.selection!.piece).toBe(before);
    tap("mouse.wheelDown", ["key.ShiftLeft"]); expect(s.bm.selection!.piece).toBe(before); expect(s.bm.selection!.tier).toBe(1); // Shift+wheel: tier only
    tap("mouse.wheelUp", ["key.ShiftLeft"]); expect(s.bm.selection!.tier).toBe(0);
    tap("key.PageUp"); expect(s.bm.level).toBe(1); expect(s.bm.preview?.level).toBe(1); tap("key.PageDown"); expect(s.bm.level).toBe(0);
    const e = s.placeAt(2, 0); s.sent.length = 0; s.tick();
    expect(s.bm.target?.entity).toBe(e); const ctx = s.bm.context!; expect(ctx.actions.map((a) => a.hint)).toEqual(["H", "U", "X"]);
    expect(ctx.actions[1]!.label).toMatch(/Upgrade → /);
    tap("key.KeyU"); expect(names(s.sent)).toEqual(["gameplay.upgrade"]); expect(s.sent[0]!.entities).toEqual(["target"]);
    tap("key.KeyX"); expect(s.sent.length).toBe(1); expect(s.bm.context!.actions[2]!.armed).toBe(true);
    tap("key.Escape"); expect(s.bm.active).toBe(true); expect(s.bm.demolishArmed).toBe(false); // Esc disarms first
    tap("key.KeyX"); tap("key.KeyX"); expect(names(s.sent)).toEqual(["gameplay.upgrade", "gameplay.demolish"]);
    s.setAim({ x: -3, y: -3, mode: 1 }); s.tick(); expect(s.bm.target).toBeUndefined(); expect(s.bm.context).toBeUndefined(); // menu only when targeted
    tap("key.Escape"); expect(s.bm.active).toBe(false);
  });
});

describe("gamepad (Xbox)", () => {
  test("right stick moves the build cursor within reach; A places; D-pad piece/tier; LT+up floor wins over tier; X/Y/hold X", () => {
    const s = setup("gamepad", { x: 1, y: 0, mode: 0 }); s.bm.start({ piece: s.foundation, tier: 0, variant: 0, paint: 0 });
    const btn = (c: string, ms = 50) => { s.pad.set(c, 1); for (let t = 0; t < ms; t += 50) s.tick(); s.pad.set(c, 0); s.tick(); s.tick(); };
    const x0 = s.bm.preview!.request.x;
    s.pad.set("pad.rx", 1); for (let i = 0; i < 10; i++) s.tick(); s.pad.set("pad.rx", 0); s.tick();
    expect(s.bm.padOffset).toBeDefined(); expect(Math.hypot(s.bm.padOffset!.x, s.bm.padOffset!.y)).toBeLessThanOrEqual(s.d.building.buildReach + 1e-6);
    expect(s.bm.preview!.request.x).not.toBe(x0);
    s.pad.set("pad.rx", 1); for (let i = 0; i < 60; i++) s.tick(); s.pad.set("pad.rx", 0); s.tick();
    expect(Math.hypot(s.bm.padOffset!.x, s.bm.padOffset!.y)).toBeCloseTo(s.d.building.buildReach, 3); // clamped
    btn("pad.rb"); expect(s.bm.rot).toBe(1); btn("pad.lb"); expect(s.bm.rot).toBe(0);
    const p0 = s.bm.selection!.piece; btn("pad.dright"); expect(s.bm.selection!.piece).not.toBe(p0); btn("pad.dleft"); expect(s.bm.selection!.piece).toBe(p0);
    btn("pad.dup"); expect(s.bm.selection!.tier).toBe(1); btn("pad.ddown"); expect(s.bm.selection!.tier).toBe(0);
    s.pad.set("pad.lt", 1); s.tick(); btn("pad.dup"); s.pad.set("pad.lt", 0); s.tick();
    expect(s.bm.level).toBe(1); expect(s.bm.selection!.tier).toBe(0); // LevelUp wins
    s.pad.set("pad.lt", 1); s.tick(); btn("pad.ddown"); s.pad.set("pad.lt", 0); s.tick(); expect(s.bm.level).toBe(0);
    s.bm.padOffset = { x: 2, y: 0 }; btn("pad.a"); expect(names(s.sent)).toEqual(["gameplay.place"]);
    const e = s.placeAt(2, 0); s.sent.length = 0; s.tick(); expect(s.bm.target?.entity).toBe(e);
    expect(s.bm.context!.actions.map((a) => a.hint)).toEqual(["X", "Y", "hold X"]);
    btn("pad.y"); expect(names(s.sent)).toEqual(["gameplay.upgrade"]);
    btn("pad.x", 600); expect(names(s.sent)).toEqual(["gameplay.upgrade", "gameplay.demolish"]); // hold = confirmed
    s.pad.set("pad.lb", 1); s.tick(); btn("pad.y"); s.pad.set("pad.lb", 0); s.tick(); expect(s.picked()).toBe(1); expect(s.bm.active).toBe(true); // ADR-279: picker suspends placement without leaving Building
  });
  test("B cancels", () => {
    const s = setup("gamepad"); s.bm.start({ piece: s.foundation, tier: 0, variant: 0, paint: 0 });
    s.pad.set("pad.b", 1); s.tick(); expect(s.bm.active).toBe(false);
  });
});

describe("touch (Android)", () => {
  test("tap positions, drag adjusts, confirm places; HUD buttons for floor and contextual actions", () => {
    const s = setup("touch", { x: 1, y: 0, mode: 0 }); s.bm.start({ piece: s.foundation, tier: 0, variant: 0, paint: 0 });
    document.body.innerHTML = ""; const root = document.createElement("div"); const canvas = document.createElement("canvas"); document.body.append(root, canvas);
    let world = (x: number, y: number) => ({ x: x / 10, y: y / 10 });
    const hud = mountBuildHud(root, { buildMode: s.bm, device: () => "touch", target: canvas, screenToWorld: (x, y) => world(x, y), blocked: (x) => x < 5 });
    hud.update(); expect(root.textContent).toContain("Tap to position");
    const ev = (type: string, x: number, y: number) => { const e = new Event(type, { bubbles: true }) as PointerEvent; Object.assign(e, { pointerType: "touch", pointerId: 1, clientX: x, clientY: y }); return e; };
    canvas.dispatchEvent(ev("pointerdown", 30, 48)); expect(s.bm.touchPoint).toEqual({ x: 3, y: 0 }); // lifted above the finger
    canvas.dispatchEvent(ev("pointermove", 20, 48)); expect(s.bm.touchPoint).toEqual({ x: 2, y: 0 });
    dispatchEvent(ev("pointerup", 20, 48)); canvas.dispatchEvent(ev("pointermove", 40, 48)); expect(s.bm.touchPoint).toEqual({ x: 2, y: 0 }); // not dragging
    canvas.dispatchEvent(ev("pointerdown", 2, 48)); expect(s.bm.touchPoint).toEqual({ x: 2, y: 0 }); // on a virtual control: ignored
    s.tick(); expect(s.bm.preview!.request).toMatchObject({ x: 2, y: 0 });
    expect(s.bm.place()).toBe(true); expect(names(s.sent)).toEqual(["gameplay.place"]);
    hud.update(); root.querySelector<HTMLButtonElement>("[data-bh=level-up]")!.click(); expect(s.bm.level).toBe(1);
    root.querySelector<HTMLButtonElement>("[data-bh=level-down]")!.click(); expect(s.bm.level).toBe(0);
    expect(root.querySelector("[data-bh=repair]")).toBeNull(); // no strip without a target
    s.placeAt(2, 0); s.sent.length = 0; s.tick(); hud.update();
    const strip = root.querySelector(".bh-ctx")!; expect(strip.getAttribute("role")).toBe("menu"); expect(strip.querySelectorAll("button").length).toBe(3);
    root.querySelector<HTMLButtonElement>("[data-bh=demolish]")!.click(); expect(s.sent.length).toBe(0); expect(root.querySelector("[data-bh=demolish]")!.textContent).toContain("Confirm");
    root.querySelector<HTMLButtonElement>("[data-bh=demolish]")!.click(); expect(names(s.sent)).toEqual(["gameplay.demolish"]);
    hud.destroy(); world = () => ({ x: 0, y: 0 });
  });
  test("touch control hit test and build layout bindings", () => {
    const layout = { reference: { w: 844, h: 390 }, elements: [{ kind: "joystick", anchor: { x: 0.18, y: 0.75 }, zone: { x: 0, y: 0.35, w: 0.45, h: 0.65 } }, { kind: "button", anchor: { x: 0.92, y: 0.8 }, radius: 28 }] };
    expect(onTouchControl(layout, 100, 300, 844, 390)).toBe(true); expect(onTouchControl(layout, 776, 312, 844, 390)).toBe(true); expect(onTouchControl(layout, 600, 100, 844, 390)).toBe(false);
    const s = setup("touch"); const b = s.sys.bindings("touch", "Building").map((x) => x.binding.action);
    for (const a of ["Build.PlaceConfirm", "Build.Cancel", "Build.RotateCW"]) expect(b).toContain(a);
    s.bm.start({ piece: s.foundation, tier: 0, variant: 0, paint: 0 }); expect(renderBuildHud(s.bm, "touch")).not.toContain("<kbd>");
  });
  test("QA2: a red ghost says why (out of range / spot taken / materials)", () => {
    expect(buildFailText(3)).toBe("Too far away"); expect(buildFailText(12)).toBe("Not enough materials"); expect(buildFailText(99)).toBe("Can't place here");
    const s = setup("keyboardMouse"); s.bm.start({ piece: s.foundation, tier: 0, variant: 0, paint: 0 }); s.tick();
    expect(s.bm.preview?.valid).toBe(true); expect(renderBuildHud(s.bm, "keyboardMouse")).not.toContain("bh-why");
    s.placeAt(2, 0); s.tick(); expect(s.bm.preview?.valid).toBe(false);
    expect(renderBuildHud(s.bm, "keyboardMouse")).toContain(`data-role="bh-why">${buildFailText(s.bm.preview!.reason)}<`);
  });
});
