// @vitest-environment jsdom
// ADR-585/586: the world-generation survey map — zoom buttons step the stride ladder (the
// note's extent follows), and the rendered SVG carries the spawn-point rings and the
// abandoned-structure diamonds for the seed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BootUI } from "../src/menu.js";

(globalThis as { matchMedia?: unknown }).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
let ui: BootUI | undefined;
afterEach(() => { ui?.hide(); document.body.innerHTML = ""; vi.useRealTimers(); });
const click = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === name)!.click();
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const openSeedPage = async () => {
  ui = new BootUI("/");
  void ui.menu({ hostedStatic: true, defaultUrl: "", initialSeed: "424242", savedSeed: async () => undefined, mp: { probe: async () => 1 } });
  click("Singleplayer"); await flush();
};

describe("ADR-585 world-generation survey map", () => {
  it("zoom buttons step the survey extent through the stride ladder and disable at the ends", async () => {
    vi.useFakeTimers();
    await openSeedPage();
    const note = document.querySelector(".preview-note")!;
    const zoomIn = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Zoom in +")!;
    const zoomOut = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Zoom out −")!;
    expect(note.textContent).toContain("3072 × 3072 tiles"); // default stride 24
    expect(zoomIn.disabled).toBe(false); expect(zoomOut.disabled).toBe(false);
    zoomOut.click();
    expect(note.textContent).toContain("6144 × 6144 tiles"); // stride 48, the widest
    expect(zoomOut.disabled).toBe(true);
    zoomIn.click();
    expect(note.textContent).toContain("3072 × 3072 tiles");
    zoomIn.click();
    expect(note.textContent).toContain("1536 × 1536 tiles"); // stride 12, the old preview extent
    zoomIn.click();
    expect(note.textContent).toContain("768 × 768 tiles");
    zoomIn.click();
    expect(note.textContent).toContain("384 × 384 tiles"); // stride 3, the finest
    expect(zoomIn.disabled).toBe(true);
  });

  it("the survey SVG gains spawn rings immediately and ruin diamonds as the enumeration fills in", async () => {
    await openSeedPage();
    const img = document.querySelector<HTMLImageElement>("[data-role=world-preview]")!;
    const svg = () => decodeURIComponent(img.src);
    // Poll with real timers: the seed debounce (100 ms) draws relief + spawn rings first;
    // the ruin enumeration then fills in over the next frames.
    const deadline = Date.now() + 25_000;
    let sawRings = false;
    while (Date.now() < deadline) {
      if (img.src.includes("data:image/svg+xml")) {
        if (svg().includes("<circle")) sawRings = true;
        if (sawRings && svg().includes("#ffb347")) break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(sawRings).toBe(true);
    expect(svg()).toContain("#ffb347"); // at least one abandoned-structure diamond on the survey
  }, 30_000);
});
