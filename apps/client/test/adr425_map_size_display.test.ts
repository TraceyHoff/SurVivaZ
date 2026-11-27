// @vitest-environment jsdom
// ADR-425: the map-generation window states exactly how big the map is, in numbers computed
// from the same constants worldgen uses — so the note and the world cannot drift apart
// silently. If PREVIEW, SURVEY_STRIDES or the walk speed changes, this test fails until
// menu.ts (which builds the note from those constants) is re-checked.
// ADR-585: the window is now a zoomable survey (see adr585_survey_map.test.ts); the note
// states the CURRENT survey extent (PREVIEW.width x the current stride).
import { afterEach, describe, expect, it, vi } from "vitest";
import { PREVIEW, SURVEY_STRIDES } from "@engine/world";
import { defaultDefs } from "@engine/gameplay";
import { BootUI } from "../src/menu.js";

(globalThis as { matchMedia?: unknown }).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
let ui: BootUI | undefined;
afterEach(() => { ui?.hide(); document.body.innerHTML = ""; vi.useRealTimers(); });
const click = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === name)!.click();
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

describe("ADR-425: map size display in the map-generation window", () => {
  it("note shows the survey extent from PREVIEW x the default stride and the walk-across time from that extent", async () => {
    vi.useFakeTimers();
    ui = new BootUI("/");
    void ui.menu({ hostedStatic: true, defaultUrl: "", initialSeed: "424242", savedSeed: async () => undefined, mp: { probe: async () => 1 } });
    click("Singleplayer"); await flush();
    const note = document.querySelector(".preview-note")!;
    // ADR-585: the default survey stride is SURVEY_STRIDES[3] (24) — the note's extent is
    // PREVIEW.width x that stride. If the menu's default zoom changes, this fails until
    // the note (built from the same constants in menu.ts) is re-checked.
    const extent = PREVIEW.width * SURVEY_STRIDES[3]!;
    expect(note.textContent).toContain(`${extent} × ${extent} tiles`);
    // Human-readable scale: minutes to walk across the surveyed extent at the player walk
    // speed (movement.json walkSpeed, tiles/s). No metres-per-tile constant exists, so no metres.
    const walkMinutes = Math.max(1, Math.round(extent / defaultDefs().movement.walkSpeed / 60));
    expect(note.textContent).toContain(`about ${walkMinutes} minutes' walk across`);
    // The survey is one window on an endless world: no fixed edge.
    expect(note.textContent).toMatch(/streams on beyond/i);
    expect(note.textContent).toMatch(/no fixed edge/i);
    // ADR-585/586 legends: spawn points and abandoned structures are marked on the survey.
    expect(note.textContent).toMatch(/spawn point/i);
    expect(note.textContent).toMatch(/abandoned structure/i);
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
