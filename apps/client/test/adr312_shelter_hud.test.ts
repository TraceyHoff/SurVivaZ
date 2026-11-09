// @vitest-environment jsdom
// ADR-312: HUD shelter chip (house icon + "Sheltered N%" / "Indoors") from the replicated Exposure.sheltered percent.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { World } from "@engine/core";
import * as G from "@engine/gameplay";
import { mountHud, shelterChipState } from "../src/hud.js";

const world = (): World => { const w = new World({ seed: 1, maxEntities: 1 << 12 }); G.installGameplay(w, {}); return w; };
let h: { destroy(): void } | undefined;
beforeEach(() => { document.head.innerHTML = ""; document.body.innerHTML = `<div id="game-root"></div>`; localStorage.clear(); });
afterEach(() => { h?.destroy(); h = undefined; });
const chip = () => document.querySelector<HTMLElement>('#hud .dchip[data-status="sheltered"]');

describe("ADR-312 shelter chip", () => {
  test("state: hidden under 10%, partial 'Sheltered N%' in 5% steps, 'Indoors' at 100%", () => {
    expect(shelterChipState(0).show).toBe(false); expect(shelterChipState(9).show).toBe(false);
    expect(shelterChipState(60)).toEqual({ show: true, full: false, pct: 60, label: "Sheltered 60%" });
    expect(shelterChipState(87).label).toBe("Sheltered 85%"); expect(shelterChipState(99).label).toBe("Sheltered 95%");
    expect(shelterChipState(100)).toEqual({ show: true, full: true, pct: 100, label: "Indoors" });
  });
  test("the chip appears in the status row with the house icon, and goes away outside", () => {
    const w = world(); const p = G.spawnPlayer(w, { x: 0, y: 0, clientId: 1 });
    h = mountHud(() => w, () => p, {}); expect(chip()).toBeNull();
    w.setField(p, G.Exposure, "sheltered", 62); h.destroy(); h = mountHud(() => w, () => p, {});
    const c = chip()!; expect(c).not.toBeNull();
    expect(c.textContent).toContain("Sheltered 60%"); expect(c.dataset["shelter"]).toBe("partial");
    expect(c.closest("[data-role=disease-chips]")).not.toBeNull(); // same row as wet / cold chips: wraps, no overlap
    expect(c.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    w.setField(p, G.Exposure, "sheltered", 100); h.destroy(); h = mountHud(() => w, () => p, {});
    expect(chip()!.textContent).toContain("Indoors"); expect(chip()!.dataset["shelter"]).toBe("full");
    w.setField(p, G.Exposure, "sheltered", 0); h.destroy(); h = mountHud(() => w, () => p, {});
    expect(chip()).toBeNull();
  });
});
