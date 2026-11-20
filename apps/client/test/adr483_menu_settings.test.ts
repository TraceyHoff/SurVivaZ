// @vitest-environment jsdom
// ADR-483: the in-game settings are available in the start menu Settings too — graphics quality,
// audio rows, FX rows and the three toggles (tool hints / name tags / ledge warnings), using the
// same standalone row builders as the in-game panel. Graphics/audio/FX live-apply in the menu;
// the toggles save with the rest of engine-settings on Save. World-rules readout, tutorial replay
// and the error log stay in-game only (they need a live world / are debug tools, not settings).
import { describe, expect, test, afterEach } from "vitest";
import { BootUI, type Settings } from "../src/menu.js";
import { DEFAULT_AUDIO, type AudioSettings } from "../src/audio/settings.js";
import { DEFAULT_FX, type FxSettings } from "../src/fx/settings.js";
import type { QualityPreset } from "@engine/render";

(globalThis as { matchMedia?: unknown }).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

let ui: BootUI | undefined;
afterEach(() => { ui?.hide(); ui = undefined; document.body.innerHTML = ""; });

const button = (text: string): HTMLButtonElement =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === text)!;

function mocks() {
  const audioSettings: AudioSettings = structuredClone(DEFAULT_AUDIO);
  const audioCalls: string[] = [];
  const audio = {
    settings: audioSettings,
    setVolume(b: string, v: number) { (audioSettings.volume as Record<string, number>)[b] = v; audioCalls.push(`vol:${b}=${v}`); },
    setMuted(b: string, m: boolean) { (audioSettings.muted as Record<string, boolean>)[b] = m; audioCalls.push(`mute:${b}=${m}`); },
    setSettings(s: AudioSettings) { Object.assign(audioSettings, s); audioCalls.push(`settings:${s.lowCpu}`); },
    play(key: string) { audioCalls.push(`play:${key}`); return 0; },
  };
  const fxSettings: FxSettings = { ...DEFAULT_FX };
  const fxCalls: string[] = [];
  const fx = {
    get: () => ({ ...fxSettings }),
    set: (s: FxSettings) => { Object.assign(fxSettings, s); fxCalls.push(`set:${s.effects}`); },
    click: () => { fxCalls.push("click"); },
  };
  const qualityCalls: QualityPreset[] = [];
  return { audio, audioCalls, audioSettings, fx, fxCalls, fxSettings, qualityCalls };
}

const openSettings = async (opts: Record<string, unknown> = {}) => {
  document.body.innerHTML = ""; localStorage.clear();
  const m = mocks();
  ui = new BootUI("/");
  const choice = ui.menu({ hostedStatic: true, defaultUrl: "", ...opts, audio: m.audio as never, fx: m.fx as never, setQuality: (p: QualityPreset) => { m.qualityCalls.push(p); } });
  void choice;
  button("Settings").click();
  return m;
};

describe("ADR-483 start menu Settings shows the in-game rows", () => {
  test("graphics select, audio rows, FX rows and the three toggles are all present", async () => {
    await openSettings();
    expect(document.querySelector("h2")?.textContent).toBe("Settings");
    const q = document.querySelector<HTMLSelectElement>("select[data-key=graphics-quality]")!;
    expect(q).not.toBeNull();
    expect(q.value).toBe("auto");
    expect(Array.from(q.options).map((o) => o.value)).toEqual(["auto", "low", "medium", "high", "ultra", "full"]);
    expect(document.querySelector("[data-role=audio-settings]")).not.toBeNull();
    expect(document.querySelector("[data-role=fx-settings]")).not.toBeNull();
    for (const k of ["tool-hints", "name-tags", "ledge-warnings"]) {
      expect(document.querySelector(`input[data-key=${k}]`)).not.toBeNull();
    }
    // In-game-only items stay out of the menu screen.
    expect(document.querySelector("[data-role=world-rules]")).toBeNull();
    expect(document.querySelector("[data-role=error-log]")).toBeNull();
    expect(Array.from(document.querySelectorAll("button")).some((b) => b.textContent === "🐞 Error log")).toBe(false);
  });

  test("graphics change live-applies and persists", async () => {
    const m = await openSettings();
    const q = document.querySelector<HTMLSelectElement>("select[data-key=graphics-quality]")!;
    q.value = "low";
    q.dispatchEvent(new Event("change", { bubbles: true }));
    expect(m.qualityCalls).toEqual(["low"]);
    expect(localStorage.getItem("survivaz.render.quality")).toBe("low");
  });

  test("audio volume / mute apply live through the passed controls", async () => {
    const m = await openSettings();
    (document.querySelector("[data-key=vol-master-up]") as HTMLButtonElement).click();
    expect(m.audioCalls).toContain("vol:master=0.9");
    expect(m.audioSettings.volume.master).toBe(0.9);
    (document.querySelector("[data-key=mute-master]") as HTMLButtonElement).click();
    expect(m.audioCalls).toContain("mute:master=true");
    expect(m.audioSettings.muted.master).toBe(true);
  });

  test("FX cycle applies live through the passed controls", async () => {
    const m = await openSettings();
    const b = document.querySelector("[data-key=fx-effects]") as HTMLButtonElement;
    expect(b.textContent).toContain("Full");
    b.click();
    expect(m.fxCalls).toContain("set:reduced");
    expect(m.fxSettings.effects).toBe("reduced");
    expect(b.textContent).toContain("Reduced");
  });

  test("Save persists the three toggles into engine-settings", async () => {
    await openSettings();
    (document.querySelector("input[data-key=tool-hints]") as HTMLInputElement).click();
    (document.querySelector("input[data-key=ledge-warnings]") as HTMLInputElement).click();
    button("Save").click();
    const saved = JSON.parse(localStorage.getItem("engine-settings") ?? "{}") as Partial<Settings>;
    expect(saved.toolHints).toBe(false);
    expect(saved.nameTags).toBe(true);
    expect(saved.ledgeWarnings).toBe(false);
    expect(saved.showHud).toBe(true);
  });

  test("without audio/fx/quality opts the screen still works, quality persists only", async () => {
    document.body.innerHTML = ""; localStorage.clear();
    ui = new BootUI("/");
    void ui.menu({ hostedStatic: true, defaultUrl: "" });
    button("Settings").click();
    expect(document.querySelector("[data-role=audio-settings]")).toBeNull();
    expect(document.querySelector("[data-role=fx-settings]")).toBeNull();
    expect(document.querySelector("input[data-key=tool-hints]")).not.toBeNull();
    const q = document.querySelector<HTMLSelectElement>("select[data-key=graphics-quality]")!;
    q.value = "medium";
    q.dispatchEvent(new Event("change", { bubbles: true }));
    expect(localStorage.getItem("survivaz.render.quality")).toBe("medium");
  });
});
