// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { installPermissions, World } from "@engine/core";
import * as G from "@engine/gameplay";
import { BuildMode } from "../src/build-mode.js";
import { GameMenus } from "../src/game-menus.js";

describe("ADR-279 active build selection", () => {
  it.each(["keyboardMouse", "gamepad", "touch"] as const)("foundation → wall → other piece without context teardown (%s)", device => {
    const w = new World({ seed: 1, maxEntities: 4096 }); G.installGameplay(w, {}); installPermissions(w);
    const p = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0 }); const defs = G.gameplayDefs(w); G.grantSkillUnlocks(w, p);
    for (const key of ["wood", "stone", "fiber", "sticks", "planks", "rope"]) G.addItem(w, p, defs.itemId(key), 30);
    const pressed = new Set<string>(), stack: string[] = [], changes: boolean[] = [], sent: G.MenuIntent[] = [];
    const ctx = () => ({ world: w, player: p, names: new Map<number, string>() }); let picker = 0; let aim = { mode: 1, x: 2.5, y: 0.5 };
    const bm = new BuildMode({ input: { pressed: a => pressed.has(a), push: c => { stack.push(c); }, pop: () => { stack.pop(); } }, ctx,
      device: () => device, aim: () => aim, send: i => { sent.push(i); return true; }, onActiveChange: active => changes.push(active), onPickPiece: () => { picker++; } });
    const selection = (key: string) => ({ piece: defs.pieceId(key), tier: 1, variant: 0, paint: 0 });
    bm.start(selection("foundation")); bm.update(); expect(bm.preview?.pieceKey).toBe("foundation"); expect(bm.place(), bm.toast).toBe(true);
    const sn = G.snapPlacement(w, { ...bm.preview!.request, ...selection("foundation"), level: 0 }); expect(typeof sn).not.toBe("number"); if (typeof sn !== "number") G.placePiece(w, p, sn, { pay: false });
    // ADR-211 reserves isolated-deck corners for L pieces: add a straight supported span.
    for (const x of [1.5, 3.5]) {
      const support = G.snapPlacement(w, { ...selection("foundation"), x, y: 0.5, level: 0, rot: 0 });
      if (typeof support !== "number") G.placePiece(w, p, support, { pay: false });
    }
    pressed.add("ToggleBuild"); bm.update(); pressed.clear(); expect(picker).toBe(1); expect(bm.active).toBe(true);
    aim = { mode: 1, x: 2.5, y: 0 }; bm.select(selection("wall")); expect(bm.preview?.pieceKey).toBe("wall"); expect(bm.selection?.piece).toBe(defs.pieceId("wall")); expect(bm.place(), bm.toast).toBe(true);
    expect(sent.at(-1)?.args).toMatchObject({ piece: defs.pieceId("wall") });
    bm.select(selection("foundation_triangle")); expect(bm.preview?.pieceKey).toBe("foundation_triangle");
    expect(stack).toEqual(["Building"]); expect(changes).toEqual([true]);
  });
  it("real catalog focus and choose refresh an active hologram without a stop/start", () => {
    document.body.innerHTML = '<div id="game-root"></div>'; globalThis.matchMedia = (() => ({ matches: false })) as never;
    const w = new World({ seed: 1, maxEntities: 4096 }); G.installGameplay(w, {}); installPermissions(w); G.installEconomy(w); G.installCraftQueue(w);
    const p = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0 }); G.grantSkillUnlocks(w, p); const defs = G.gameplayDefs(w);
    for (const key of ["wood", "stone", "fiber", "sticks", "planks", "rope"]) G.addItem(w, p, defs.itemId(key), 30);
    const ctx = () => ({ world: w, player: p, names: new Map<number, string>() }); const active: boolean[] = [];
    const bm = new BuildMode({ input: { pressed: () => false, push() {}, pop() {} }, ctx, aim: () => ({ mode: 1, x: 2.5, y: 0.5 }), send: () => true, onActiveChange: a => active.push(a) });
    bm.start({ piece: defs.pieceId("foundation"), tier: 1, variant: 0, paint: 0 });
    const menus = new GameMenus({ root: document.getElementById("game-root")!, pollGamepads: false, onQuit() {}, gameplay: { ctx, send: () => true, onBuildSelect: s => bm.select(s), startPlacing: s => bm.start(s, { fromMenu: true }) } });
    menus.open("build"); document.querySelector<HTMLElement>('[data-key="bcat-structure"]')!.click();
    const selector = `[data-role="piece-grid"] [data-key="piece-${defs.pieceId("wall")}"]`;
    document.querySelector<HTMLElement>(selector)!.focus(); expect(bm.preview?.pieceKey).toBe("wall");
    document.querySelector<HTMLElement>(selector)!.click(); expect(menus.nav.isOpen).toBe(false); expect(bm.preview?.pieceKey).toBe("wall"); expect(active).toEqual([true]); expect(bm.awaitingRelease).toBe(true); menus.destroy();
  });
});
