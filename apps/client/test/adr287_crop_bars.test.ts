// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Transform, World } from "@engine/core";
import * as G from "@engine/gameplay";
import { mountFarmPrompt } from "../src/farm-prompt.js";

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });
describe("ADR-287 plant bar DOM", () => {
  it("renders two bars, conditionally adds fertilizer without a gap, and hides everything when walking away", () => {
    vi.useFakeTimers(); const w = new World(); G.installGameplay(w);
    const p = G.spawnPlayer(w, { x: 10.5, y: 10.5, clientId: 1 }); w.set(p, Transform, { facing: 0 });
    const c = G.spawnCrop(w, 11.5, 10.5, G.plantableBySeed("wheat_seeds"));
    const ui = mountFarmPrompt(document.body, { world: () => w, player: () => p, device: () => "keyboardMouse", key: () => "X", hidden: () => false, use: () => {} });
    try {
      const panel = document.querySelector<HTMLElement>("#crop-bars")!;
      const fertilizer = panel.querySelector<HTMLElement>('[data-bar="fertilizer"]')!;
      expect(panel.hidden).toBe(false); expect(fertilizer.hidden).toBe(true);
      expect(panel.querySelector('[aria-label="Growth"]')?.getAttribute("aria-valuenow")).toBe("0");
      expect(panel.textContent).toContain("Dry");
      expect(document.querySelector("#farm-prompt")?.textContent).toContain("Plant needs water");
      G.fertilize(w, 11.5, 10.5); G.water(w, 11.5, 10.5); vi.advanceTimersByTime(200);
      expect(fertilizer.hidden).toBe(false); expect(panel.querySelector('[aria-label="Water"]')?.getAttribute("aria-valuenow")).toBe("100");
      w.tick += G.FARMING.fertilizerSeconds * 20; vi.advanceTimersByTime(200); expect(fertilizer.hidden).toBe(true);
      w.set(p, Transform, { x: 7.5 }); vi.advanceTimersByTime(200); expect(panel.hidden).toBe(true);
      w.set(p, Transform, { x: 10.5 }); w.set(c, G.Crop, { growth: 1 }); vi.advanceTimersByTime(200);
      expect(panel.hidden).toBe(false); expect(panel.textContent).toContain("Done");
      expect(panel.querySelectorAll("button,input,[tabindex]").length).toBe(0);
    } finally { ui.destroy(); }
    expect(document.querySelector("#plant-inspect")).toBeNull();
  });
});
