// @vitest-environment jsdom
/** ADR-316 demolish mode without a hologram (keyboard, gamepad, touch), touch select / confirm / deselect, and the
 *  ADR-318 move flow (lift into the normal hologram, cancel restores, confirm sends one MoveCmd). */
import { describe, expect, test } from "vitest";
import { installPermissions, Transform, World, type Entity } from "@engine/core";
import * as G from "@engine/gameplay";
import { InputSystem, KeyboardMouseDevice, GamepadDevice, DEFAULT_ACTIONS, DEFAULT_CONTEXTS, DEFAULT_PROFILES } from "@engine/input";
import { BuildMode, type BuildDevice } from "../src/build-mode.js";
import { mountBuildHud, renderBuildHud, buildFailText } from "../src/build-hud.js";
import { plantClaim } from "../../../packages/gameplay/test/helpers.js";

function setup(device: BuildDevice, aimAt = { x: 2, y: 0, mode: 1 }) {
  const w = new World({ seed: 1, maxEntities: 1 << 12 }); G.installGameplay(w, {}); installPermissions(w);
  const me = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); const d = G.gameplayDefs(w);
  plantClaim(w, me, -2, 2);
  const clock = { t: 0, now: () => clock.t };
  const sys = new InputSystem(clock as never, { actions: DEFAULT_ACTIONS, contexts: DEFAULT_CONTEXTS, profiles: DEFAULT_PROFILES });
  const kbm = new KeyboardMouseDevice(); const pad = new GamepadDevice(0); sys.addDevice(kbm); sys.addDevice(pad); sys.push("Gameplay");
  const sent: G.MenuIntent[] = []; let aim = aimAt; const gameplay: string[] = [];
  const bm = new BuildMode({ input: sys, ctx: () => ({ world: w, player: me, names: new Map() }), aim: () => aim, send: (i) => { sent.push(i); return true; }, device: () => device, now: () => clock.t });
  // main.ts onUiFrame order: build mode owns the frame while active; otherwise Gameplay's ToggleDemolish enters it
  const tick = () => { clock.t += 50; sys.update(); if (bm.active) bm.update(); else { if (sys.pressed("ToggleDemolish")) bm.startDemolish(); if (sys.pressed("QuickUse")) gameplay.push("QuickUse"); } };
  const foundation = d.pieceId("foundation");
  const placeAt = (x: number, y: number, by: Entity = me): Entity => {
    const sn = G.snapPlacement(w, { piece: foundation, x, y, level: 0, rot: 0, tier: 0, variant: 0 }); if (typeof sn === "number") throw new Error(`snap ${sn}`);
    return G.placePiece(w, by, sn, { pay: false });
  };
  return { w, me, d, sys, kbm, pad, sent, bm, tick, foundation, placeAt, gameplay, setAim: (a: typeof aim) => { aim = a; } };
}
const names = (s: G.MenuIntent[]) => s.map((i) => i.cmd.name);

describe("ADR-316 keyboard + mouse", () => {
  test("Delete enters demolish mode with no hologram; aim highlights; click arms then demolishes; Delete / Esc exit", () => {
    const s = setup("keyboardMouse"); const e = s.placeAt(2, 0);
    const tap = (c: string) => { s.kbm.press(c); s.tick(); s.kbm.releaseAll(); s.tick(); };
    tap("key.Delete"); expect(s.bm.active).toBe(true); expect(s.bm.demolishMode).toBe(true);
    expect(s.bm.selection).toBeUndefined(); expect(s.bm.preview).toBeUndefined(); // no ghost
    expect(s.bm.target?.entity).toBe(e); expect(s.bm.targetOutline?.segments.length).toBeGreaterThan(0); // ADR-302 amber outline
    const ctx = s.bm.context!; expect(ctx.refund).toMatch(/^Refund: .*\(100%\)$/);
    expect(renderBuildHud(s.bm, "keyboardMouse")).toContain("Demolish mode");
    tap("mouse.left"); expect(s.sent.length).toBe(0); expect(s.bm.demolishArmed).toBe(true); // armed, nothing sent
    tap("mouse.left"); expect(names(s.sent)).toEqual(["gameplay.demolish"]);
    tap("key.Delete"); expect(s.bm.active).toBe(false); // back to normal play
    tap("key.Backspace"); expect(s.bm.demolishMode).toBe(true); tap("key.Escape"); expect(s.bm.active).toBe(false);
  });
  test("while placing, Delete / the HUD Demolish button switch to demolish mode (the ghost goes away)", () => {
    const s = setup("keyboardMouse"); s.bm.start({ piece: s.foundation, tier: 0, variant: 0, paint: 0 }); s.tick();
    expect(s.bm.preview).toBeDefined(); expect(renderBuildHud(s.bm, "keyboardMouse")).toContain('data-bh="demolish-mode"');
    s.kbm.press("key.Delete"); s.tick(); s.kbm.releaseAll(); s.tick();
    expect(s.bm.demolishMode).toBe(true); expect(s.bm.preview).toBeUndefined();
  });
  test("a piece on someone else's claim still highlights, says why, and Demolish is disabled (nothing sent)", () => {
    const s = setup("keyboardMouse"); const other = G.spawnPlayer(s.w, { x: 200, y: 0, maxWeight: 0, clientId: 2 });
    s.w.set(s.me, Transform, { x: 200, y: 0.5, z: 0 }); plantClaim(s.w, other, 205, 3); const e = s.placeAt(202, 0, other);
    s.setAim({ x: 202, y: 0, mode: 1 }); s.bm.startDemolish(); s.tick();
    expect(s.bm.target?.entity).toBe(e); expect(s.bm.targetOutline).toBeDefined();
    const dem = s.bm.context!.actions.find((a) => a.id === "demolish")!;
    expect(dem.enabled).toBe(false); expect(dem.why).toBe("You don't have permission to demolish here");
    expect(renderBuildHud(s.bm, "keyboardMouse")).toContain("You don&#39;t have permission to demolish here".replace("&#39;", "'"));
    expect(s.bm.act("demolish", true)).toBe(false); expect(s.sent.length).toBe(0); expect(s.bm.toast).toBe(buildFailText(G.BuildFail.NoDemolishPermission));
  });
});

describe("ADR-316 gamepad", () => {
  test("LB+B enters demolish mode (QuickUse is shadowed); hold X demolishes; A arms + confirms; B exits", () => {
    const s = setup("gamepad"); const e = s.placeAt(2, 0); s.bm.padOffset = undefined;
    s.pad.set("pad.lb", 1); s.tick(); s.pad.set("pad.b", 1); s.tick(); s.pad.set("pad.b", 0); s.pad.set("pad.lb", 0); s.tick(); s.tick();
    expect(s.bm.demolishMode).toBe(true); expect(s.gameplay).toEqual([]); expect(s.bm.preview).toBeUndefined();
    expect(s.bm.target?.entity).toBe(e);
    const btn = (c: string, ms = 50) => { s.pad.set(c, 1); for (let t = 0; t < ms; t += 50) s.tick(); s.pad.set(c, 0); s.tick(); s.tick(); };
    btn("pad.a"); expect(s.sent.length).toBe(0); expect(s.bm.demolishArmed).toBe(true);
    btn("pad.a"); expect(names(s.sent)).toEqual(["gameplay.demolish"]);
    btn("pad.x", 600); expect(names(s.sent)).toEqual(["gameplay.demolish", "gameplay.demolish"]); // hold = confirmed
    btn("pad.b"); expect(s.bm.active).toBe(false);
  });
});

describe("ADR-316 touch", () => {
  test("tap selects + highlights, the fixed strip shows name / refund / Confirm, tapping empty ground or Deselect clears", () => {
    const s = setup("touch"); const e = s.placeAt(2, 0); s.placeAt(0, 2);
    document.body.innerHTML = ""; const root = document.createElement("div"); const canvas = document.createElement("canvas"); document.body.append(root, canvas);
    const hud = mountBuildHud(root, { buildMode: s.bm, device: () => "touch", target: canvas, screenToWorld: (x, y) => ({ x: x / 10, y: y / 10 }), blocked: (x) => x < 5 });
    s.bm.startDemolish(); hud.update(); expect(root.textContent).toContain("Tap a piece to select it"); expect(s.bm.target).toBeUndefined();
    const ev = (type: string, x: number, y: number) => { const v = new Event(type, { bubbles: true }) as PointerEvent; Object.assign(v, { pointerType: "touch", pointerId: 1, clientX: x, clientY: y }); return v; };
    canvas.dispatchEvent(ev("pointerdown", 25, 5)); // (2.5, 0.5): no finger lift in demolish mode
    expect(s.bm.target?.entity).toBe(e); expect(s.bm.targetOutline).toBeDefined(); expect(s.sent.length).toBe(0);
    hud.update(); expect(root.querySelector("[data-role=bh-refund]")!.textContent).toMatch(/Refund: .*100%/);
    expect(root.querySelector(".bh-title")!.textContent).toContain("Foundation");
    const confirm = root.querySelector<HTMLButtonElement>("[data-bh=demolish]")!; expect(confirm.textContent).toContain("Confirm demolish");
    canvas.dispatchEvent(ev("pointerdown", 5 + 1, 25)); hud.update(); // another piece (0.6, 2.5) changes the selection
    expect(s.bm.target?.entity).not.toBe(e); expect(s.bm.target).toBeDefined();
    canvas.dispatchEvent(ev("pointerdown", 25, 5)); hud.update(); expect(s.bm.target?.entity).toBe(e);
    root.querySelector<HTMLButtonElement>("[data-bh=deselect]")!.click(); expect(s.bm.target).toBeUndefined(); expect(s.bm.demolishMode).toBe(true);
    canvas.dispatchEvent(ev("pointerdown", 25, 5)); hud.update();
    canvas.dispatchEvent(ev("pointerdown", 39, 39)); expect(s.bm.target).toBeUndefined(); // empty ground clears
    canvas.dispatchEvent(ev("pointerdown", 25, 5)); hud.update();
    root.querySelector<HTMLButtonElement>("[data-bh=demolish]")!.click(); expect(names(s.sent)).toEqual(["gameplay.demolish"]); // one confirm tap
    root.querySelector<HTMLButtonElement>("[data-bh=exit]")!.click(); expect(s.bm.active).toBe(false);
    hud.destroy();
  });
  test("touch bindings: the demolish-mode toggle and Move exist on the touch profile", () => {
    const s = setup("touch");
    expect(s.sys.bindings("touch", "Gameplay").map((x) => x.binding.action)).toContain("ToggleDemolish");
    expect(s.sys.bindings("touch", "Building").map((x) => x.binding.action)).toEqual(expect.arrayContaining(["ToggleDemolish", "Build.Move"]));
  });
});

describe("ADR-318 move (client)", () => {
  test("F lifts an own, repaired piece into the hologram; Esc puts it back (nothing sent); click sends one MoveCmd", () => {
    const s = setup("keyboardMouse"); const e = s.placeAt(2, 0);
    const tap = (c: string) => { s.kbm.press(c); s.tick(); s.kbm.releaseAll(); s.tick(); };
    s.bm.startDemolish(); s.tick(); expect(s.bm.target?.entity).toBe(e);
    tap("key.KeyF"); expect(s.bm.moving).toBe(e); expect(s.bm.selection?.moving).toBe(e); expect(s.bm.preview).toBeDefined();
    expect(s.bm.targetOutline).toBeDefined(); // the amber outline stays on the original piece
    expect(renderBuildHud(s.bm, "keyboardMouse")).toContain('data-bh="cancel-move"');
    const piece0 = s.bm.selection!.piece; tap("mouse.wheelDown"); expect(s.bm.selection!.piece).toBe(piece0); // no piece cycling while moving
    tap("key.Escape"); expect(s.bm.moving).toBeUndefined(); expect(s.bm.demolishMode).toBe(true); expect(s.sent.length).toBe(0);
    expect(s.w.get(e, Transform)!.x).toBe(2.5);
    tap("key.KeyF"); s.setAim({ x: 3, y: 1, mode: 1 }); s.tick(); expect(s.bm.preview?.valid).toBe(true);
    tap("mouse.left"); expect(names(s.sent)).toEqual(["gameplay.move"]); expect(s.sent[0]!.entities).toEqual(["target"]);
    expect(s.sent[0]!.args).toMatchObject({ target: e }); expect(s.bm.moving).toBeUndefined(); expect(s.bm.demolishMode).toBe(true);
  });
  test("a damaged piece can't be moved: Move is disabled with 'Repair it first'", () => {
    const s = setup("keyboardMouse"); const e = s.placeAt(2, 0); s.w.setField(e, G.BuildPiece, "hp", 1);
    s.bm.startDemolish(); s.tick();
    const mv = s.bm.context!.actions.find((a) => a.id === "move")!; expect(mv.enabled).toBe(false); expect(mv.why).toBe("Repair it first");
    expect(s.bm.startMove()).toBe(false); expect(s.bm.toast).toBe("Repair it first"); expect(s.bm.moving).toBeUndefined();
  });
  test("gamepad hold Y lifts; B cancels the move back to demolish mode", () => {
    const s = setup("gamepad"); const e = s.placeAt(2, 0); s.bm.startDemolish(); s.tick(); expect(s.bm.target?.entity).toBe(e);
    const btn = (c: string, ms = 50) => { s.pad.set(c, 1); for (let t = 0; t < ms; t += 50) s.tick(); s.pad.set(c, 0); s.tick(); s.tick(); };
    btn("pad.y", 600); expect(s.bm.moving).toBe(e); expect(s.sent.length).toBe(0);
    btn("pad.b"); expect(s.bm.moving).toBeUndefined(); expect(s.bm.demolishMode).toBe(true);
  });
});
