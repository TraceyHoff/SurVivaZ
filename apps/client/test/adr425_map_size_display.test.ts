// @vitest-environment jsdom
// ADR-425: the map-generation window states exactly how big the map is, in numbers computed
// from the same constants worldgen uses — so the note and the world cannot drift apart
// silently. If PREVIEW, REGION_SIZE or the walk speed changes, this test fails until menu.ts
// (which builds the note from those constants) is re-checked.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PREVIEW, REGION_SIZE } from "@engine/world";
import { defaultDefs } from "@engine/gameplay";
import { BootUI } from "../src/menu.js";

(globalThis as { matchMedia?: unknown }).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
let ui: BootUI | undefined;
afterEach(() => { ui?.hide(); document.body.innerHTML = ""; vi.useRealTimers(); });
const click = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === name)!.click();
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

describe("ADR-425: map size display in the map-generation window", () => {
  it("note shows the preview extent from PREVIEW and the region walk-across time from REGION_SIZE", async () => {
    vi.useFakeTimers();
    ui = new BootUI("/");
    void ui.menu({ hostedStatic: true, defaultUrl: "", initialSeed: "424242", savedSeed: async () => undefined, mp: { probe: async () => 1 } });
    click("Singleplayer"); await flush();
    const note = document.querySelector(".preview-note")!;
    // The preview covers exactly one starter region: width px x stride tiles/px == REGION_SIZE.
    const previewExtent = PREVIEW.width * PREVIEW.stride;
    expect(previewExtent).toBe(REGION_SIZE);
    expect(note.textContent).toContain(`${previewExtent} × ${previewExtent} tiles`);
    // Human-readable scale: minutes to walk across one region at the player walk speed
    // (movement.json walkSpeed, tiles/s). No metres-per-tile constant exists, so no metres.
    const walkMinutes = Math.max(1, Math.round(REGION_SIZE / defaultDefs().movement.walkSpeed / 60));
    expect(note.textContent).toContain(`about ${walkMinutes} minutes' walk across`);
    // The preview is one region, not the whole world: no fixed edge.
    expect(note.textContent).toMatch(/streams on beyond it/i);
    expect(note.textContent).toMatch(/no fixed edge/i);
  });

  it("note is seed-independent and the preview still renders for a fixed seed", async () => {
    vi.useFakeTimers();
    ui = new BootUI("/");
    void ui.menu({ hostedStatic: true, defaultUrl: "", initialSeed: "424242", savedSeed: async () => undefined, mp: { probe: async () => 1 } });
    click("Singleplayer"); await flush();
    const note = document.querySelector(".preview-note")!;
    const noteBefore = note.textContent;
    const img = document.querySelector<HTMLImageElement>("[data-role=world-preview]")!;
    vi.advanceTimersByTime(100);
    expect(img.dataset["seed"]).toBe("424242");
    expect(img.src).toContain("data:image/svg+xml");
    // A different seed redraws the preview but leaves the size note untouched.
    const input = document.querySelector<HTMLInputElement>("[data-role=world-seed]")!;
    input.value = "7"; input.dispatchEvent(new Event("input"));
    vi.advanceTimersByTime(100);
    expect(img.dataset["seed"]).toBe("7");
    expect(img.src).toContain("data:image/svg+xml");
    expect(note.textContent).toBe(noteBefore);
  });
});
