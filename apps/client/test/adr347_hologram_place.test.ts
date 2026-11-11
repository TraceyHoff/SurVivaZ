// @vitest-environment jsdom
/**
 * ADR-347: the piece lands exactly where the hologram shows.
 *
 * Two divergences made it land elsewhere:
 *  1. Touch, portrait: a tap on the ✓ confirm button also reached the canvas as a world tap
 *     (onTouchControl hit-tested the landscape anchor, ~90 px from the rendered portrait button),
 *     so the ghost jumped to the world point under the button — a couple of tiles in front of the
 *     player — and the confirm then placed it there.
 *  2. Every device: the Place/Move command carried the raw unsnapped aim (`preview.request`) while
 *     the ghost is the snapped slot (`preview.x/y/rot`) — magnet / snap-assist / claim bump / corner
 *     auto-fit all move the ghost off the raw request, so the server re-snapped the request and the
 *     piece landed in a different slot from the hologram.
 */
import { describe, expect, it } from "vitest";
import { installPermissions, Transform, World } from "@engine/core";
import * as G from "@engine/gameplay";
import { DEFAULT_TOUCH_LAYOUTS, TouchDevice, VirtualControls } from "@engine/input";
import { BuildMode, type BuildDevice } from "../src/build-mode.js";
import { mountBuildHud, onTouchControl } from "../src/build-hud.js";
import { plantClaim } from "../../../packages/gameplay/test/helpers.js";

/** main.ts filters the DOM menu-bar buttons out of the building touch layout. */
const MENU_BAR_IDS = new Set(["inventory", "crafting", "map", "chat", "social", "build", "back"]);
const buildTouchLayout = { ...DEFAULT_TOUCH_LAYOUTS.building, elements: DEFAULT_TOUCH_LAYOUTS.building.elements.filter((e) => !MENU_BAR_IDS.has(e.id)) };
/** Where VirtualControls (the code that draws and hit-tests the buttons) puts each building button. */
const renderedAt = (w: number, h: number): Map<string, { x: number; y: number; r: number }> => {
  const c = new VirtualControls(buildTouchLayout, new TouchDevice()); c.resize({ w, h });
  return new Map(c.geometry().map((g) => [g.id, { x: g.x, y: g.y, r: g.r }]));
};

describe("ADR-347 onTouchControl follows the rendered touch layout", () => {
  it("portrait: the confirm / cancel / rotate buttons block world taps at their rendered spots", () => {
    const at = renderedAt(390, 844);
    for (const id of ["confirm", "cancel", "rotate"]) {
      const p = at.get(id)!;
      expect(onTouchControl(buildTouchLayout, p.x, p.y, 390, 844)).toBe(true);
    }
    expect(onTouchControl(buildTouchLayout, 100, 200, 390, 844)).toBe(false); // open world: not on a control
  });
  it("landscape is unchanged: confirm blocks, open world does not", () => {
    const at = renderedAt(844, 390);
    expect(onTouchControl(buildTouchLayout, at.get("confirm")!.x, at.get("confirm")!.y, 844, 390)).toBe(true);
    expect(onTouchControl(buildTouchLayout, 600, 100, 844, 390)).toBe(false);
  });
});

describe("ADR-347 portrait tap on ✓ confirms without moving the ghost", () => {
  it("the confirm tap never reaches the world, while a world tap still positions the ghost", () => {
    const w = new World({ seed: 1, maxEntities: 4096 }); G.installGameplay(w, {}); installPermissions(w);
    const p = G.spawnPlayer(w, { x: 0, y: 0, clientId: 1, maxWeight: 0 }), d = G.gameplayDefs(w);
    plantClaim(w, p, -2, 2);
    for (const k of ["sticks", "planks", "rope", "stone"]) G.addItem(w, p, d.itemId(k), 99);
    const bm = new BuildMode({ input: { pressed: () => false, down: () => false, push: () => {}, pop: () => {} },
      ctx: () => ({ world: w, player: p, names: new Map() }), device: () => "touch", aim: () => undefined, send: () => true });
    document.body.innerHTML = ""; const root = document.createElement("div"); const canvas = document.createElement("canvas"); document.body.append(root, canvas);
    // main.ts wiring, on a portrait phone: blocked() is onTouchControl over the building layout.
    const hud = mountBuildHud(root, { buildMode: bm, device: () => "touch", target: canvas,
      screenToWorld: (x, y) => ({ x: x / 10, y: y / 10 }), blocked: (x, y) => onTouchControl(buildTouchLayout, x, y, 390, 844) });
    bm.start({ piece: d.pieceId("foundation"), tier: 0, variant: 0, paint: 0 });
    const ev = (type: string, x: number, y: number) => { const e = new Event(type, { bubbles: true }) as PointerEvent; Object.assign(e, { pointerType: "touch", pointerId: 1, clientX: x, clientY: y }); return e; };
    canvas.dispatchEvent(ev("pointerdown", 30, 48)); // world tap: ghost at (3, 0) — lifted 48 px above the finger
    expect(bm.touchPoint).toEqual({ x: 3, y: 0 });
    const ghost = { ...bm.preview! }; expect(ghost.valid).toBe(true);
    const confirm = renderedAt(390, 844).get("confirm")!;
    canvas.dispatchEvent(ev("pointerdown", confirm.x, confirm.y)); // the ✓ button, portrait position
    expect(bm.touchPoint).toEqual({ x: 3, y: 0 }); // unchanged: the tap never reached the world
    expect(bm.preview).toMatchObject({ x: ghost.x, y: ghost.y });
    canvas.dispatchEvent(ev("pointerdown", 20, 48)); // a real world tap still moves the ghost
    expect(bm.touchPoint).toEqual({ x: 2, y: 0 });
    hud.destroy();
  });
});

describe("ADR-347 confirm places at the hologram on every device", () => {
  it.each(["keyboardMouse", "gamepad", "touch"] as const)("%s: off-centre aim places at the ghost's snapped cell, not the raw aim point", (device: BuildDevice) => {
    const w = new World({ seed: 1, maxEntities: 4096 }); G.installGameplay(w, {}); installPermissions(w);
    const p = G.spawnPlayer(w, { x: 0, y: 0, clientId: 1, maxWeight: 0 }), d = G.gameplayDefs(w);
    plantClaim(w, p, -2, 2);
    for (const k of ["sticks", "planks", "rope", "stone", "cloth"]) G.addItem(w, p, d.itemId(k), 99);
    const foundation = d.pieceId("foundation");
    let aim = { mode: 1, x: 2.3, y: 0.7 }; const buttons = new Set<string>(), sent: G.MenuIntent[] = [];
    const bm = new BuildMode({ input: { pressed: (a) => buttons.has(a), down: (a) => buttons.has(a), push: () => {}, pop: () => {} },
      ctx: () => ({ world: w, player: p, names: new Map() }), device: () => device, aim: () => aim, send: (i) => { sent.push(i); return true; } });
    bm.start({ piece: foundation, tier: 0, variant: 0, paint: 0 });
    bm.update(); // releases the ADR-222 confirm latch (PlaceConfirm up)
    if (device === "touch") bm.setTouchPoint({ x: 2.3, y: 0.7 });
    else if (device === "gamepad") bm.padOffset = { x: 2.3, y: 0.7 };
    else aim = { mode: 1, x: 2.3, y: 0.7 };
    bm.update();
    const ghost = { ...bm.preview! };
    expect(ghost.valid).toBe(true); expect(ghost).toMatchObject({ x: 2.5, y: 0.5 });
    expect(ghost.request.x).not.toBeCloseTo(ghost.x); // the raw aim point is not the ghost's snapped slot
    buttons.add("Build.PlaceConfirm"); bm.update();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.args).toMatchObject({ x: ghost.x, y: ghost.y });
    const result = G.tryPlace(w, p, sent[0]!.args as unknown as G.PlaceRequest);
    expect(result.ok).toBe(true);
    if (result.ok) expect(w.get(result.piece, Transform)).toMatchObject({ x: ghost.x, y: ghost.y });
  });
  it.each([["gamepad", { mode: 1, x: 2.5, y: 0.5 }], ["keyboardMouse", { mode: 0, x: 1, y: 0 }]] as const)("%s: assist-hopped ghost places at the ghost, not the raw aim", (device: BuildDevice, aimAt: { mode: number; x: number; y: number }) => {
    const w = new World({ seed: 1, maxEntities: 4096 }); G.installGameplay(w, {}); installPermissions(w);
    const p = G.spawnPlayer(w, { x: 0, y: 0, clientId: 1, maxWeight: 0 }), d = G.gameplayDefs(w);
    plantClaim(w, p, -2, 2);
    for (const k of ["sticks", "planks", "rope", "stone", "cloth"]) G.addItem(w, p, d.itemId(k), 99);
    const foundation = d.pieceId("foundation");
    const taken = G.tryPlace(w, p, { piece: foundation, x: 2.5, y: 0.5, level: 0, rot: 0, tier: 0, variant: 0 });
    expect(taken.ok).toBe(true); // the aimed cell is taken, so the ghost assist-hops to a neighbour
    let aim = aimAt; const buttons = new Set<string>(), sent: G.MenuIntent[] = [];
    const bm = new BuildMode({ input: { pressed: (a) => buttons.has(a), down: (a) => buttons.has(a), push: () => {}, pop: () => {} },
      ctx: () => ({ world: w, player: p, names: new Map() }), device: () => device, aim: () => aim, send: (i) => { sent.push(i); return true; } });
    bm.start({ piece: foundation, tier: 0, variant: 0, paint: 0 });
    bm.update(); // releases the ADR-222 confirm latch (PlaceConfirm up)
    if (device === "gamepad") bm.padOffset = { x: aimAt.x, y: aimAt.y };
    bm.update();
    const ghost = { ...bm.preview! };
    expect(ghost.valid).toBe(true); expect(ghost.assisted).toBe(true);
    expect(ghost.request.x).not.toBeCloseTo(ghost.x); // the raw aim point is not the ghost's snapped slot
    buttons.add("Build.PlaceConfirm"); bm.update();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.args).toMatchObject({ x: ghost.x, y: ghost.y });
    const result = G.tryPlace(w, p, sent[0]!.args as unknown as G.PlaceRequest);
    expect(result.ok).toBe(true);
    if (result.ok) expect(w.get(result.piece, Transform)).toMatchObject({ x: ghost.x, y: ghost.y });
  });
});
