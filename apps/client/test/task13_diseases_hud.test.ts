// @vitest-environment jsdom
// Task 13: HUD disease chips — one small chip per active disease on the local player,
// disappearing when the disease is cured.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { World } from "@engine/core";
import * as G from "@engine/gameplay";
import { mountHud } from "../src/hud.js";

const world = (): World => { const w = new World({ seed: 1, maxEntities: 1 << 12 }); G.installGameplay(w, {}); return w; };
let h: { destroy(): void } | undefined;
beforeEach(() => { document.head.innerHTML = ""; document.body.innerHTML = `<div id="game-root"></div>`; localStorage.clear(); });
afterEach(() => { h?.destroy(); h = undefined; });

describe("Task 13: HUD disease chips", () => {
  test("a chip per active disease appears, and disappears on cure", () => {
    const w = world(); const p = G.spawnPlayer(w, { x: 0, y: 0, clientId: 1 });
    h = mountHud(() => w, () => p, {});
    expect(document.querySelector("#hud [data-role=disease-chips]")).not.toBeNull();
    expect(document.querySelectorAll("#hud .dchip").length).toBe(0);
    expect(G.contractDisease(w, p, "common_cold")).toBe(true);
    h.destroy(); h = mountHud(() => w, () => p, {}); // mount calls update() synchronously
    const chips = Array.from(document.querySelectorAll<HTMLElement>("#hud .dchip"));
    expect(chips.map((c) => c.dataset["disease"])).toEqual(["common_cold"]);
    expect(chips[0]!.textContent).toContain("Cold");
    expect(chips[0]!.title).toBe("Common Cold");
    // Task 31: each chip carries its custom sprite (snowflake for a cold)
    expect(chips[0]!.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(G.cureDisease(w, p, "common_cold")).toBe(true);
    h.destroy(); h = mountHud(() => w, () => p, {});
    expect(document.querySelectorAll("#hud .dchip").length).toBe(0);
  });

  test("multiple diseases render multiple chips", () => {
    const w = world(); const p = G.spawnPlayer(w, { x: 0, y: 0, clientId: 1 });
    G.contractDisease(w, p, "dysentery"); G.contractDisease(w, p, "heatstroke");
    h = mountHud(() => w, () => p, {});
    expect(Array.from(document.querySelectorAll<HTMLElement>("#hud .dchip")).map((c) => c.dataset["disease"]).sort())
      .toEqual(["dysentery", "heatstroke"]);
  });

  test("ADR-278: Wet uses its dedicated status key, separate from the flu disease", () => {
    const w = world(); const p = G.spawnPlayer(w, { x: 0, y: 0, clientId: 1 });
    w.setField(p, G.Exposure, "wetness", 0.5);
    G.contractDisease(w, p, "influenza");
    h = mountHud(() => w, () => p, {});
    const chips = Array.from(document.querySelectorAll<HTMLElement>("#hud .dchip"));
    expect(chips.map((c) => c.dataset["disease"] ?? c.dataset["status"]).sort()).toEqual(["influenza", "wet"]);
    const wet = chips.find((c) => c.dataset["status"] === "wet")!;
    expect(wet.textContent).toContain("Wet");
    expect(wet.title).toContain("dry indoors or by a fire");
    expect(wet.querySelector("img")?.dataset["uiIcon"]).toBe("wet");
    const flu = chips.find((c) => c.dataset["disease"] === "influenza")!;
    expect(flu.textContent).toContain("Flu");
    expect(flu.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    // dry again: the wet chip vanishes, the flu chip stays
    w.setField(p, G.Exposure, "wetness", 0);
    h.destroy(); h = mountHud(() => w, () => p, {});
    expect(Array.from(document.querySelectorAll<HTMLElement>("#hud .dchip")).map((c) => c.dataset["disease"])).toEqual(["influenza"]);
  });
});
