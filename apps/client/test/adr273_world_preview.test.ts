// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { BootUI } from "../src/menu.js";
(globalThis as { matchMedia?: unknown }).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
let ui: BootUI | undefined;
afterEach(() => { ui?.hide(); document.body.innerHTML = ""; vi.useRealTimers(); });
const click = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === name)!.click();
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
it.each(["singleplayer", "host"] as const)("%s seed preview debounces typing/paste, updates Random and preserves all gamepad controls", async mode => {
  vi.useFakeTimers(); ui = new BootUI("/"); void ui.menu({ hostedStatic: true, defaultUrl: "", initialSeed: "1234", savedSeed: async () => undefined, mp: { probe: async () => 1 } });
  if (mode === "host") { click("Multiplayer"); click("Host game"); } else click("Singleplayer"); await flush();
  const input = document.querySelector<HTMLInputElement>("[data-role=world-seed]")!, img = document.querySelector<HTMLImageElement>("[data-role=world-preview]")!;
  vi.advanceTimersByTime(100); const before = img.src; expect(img.dataset["seed"]).toBe("1234");
  input.value = "424242"; input.dispatchEvent(new Event("input")); expect(img.getAttribute("aria-busy")).toBe("true");
  vi.advanceTimersByTime(99); expect(img.src).toBe(before); vi.advanceTimersByTime(1); expect(img.src).not.toBe(before); expect(img.dataset["seed"]).toBe("424242");
  input.value = "12"; input.dispatchEvent(new Event("input")); input.value = "56789"; input.dispatchEvent(new Event("input")); vi.advanceTimersByTime(100); expect(img.dataset["seed"]).toBe("56789");
  click("Random"); vi.advanceTimersByTime(100); expect(img.dataset["seed"]).toBe(input.value);
  input.value = "abc"; input.dispatchEvent(new Event("input")); expect(img.hidden).toBe(true);
  input.focus(); const press = (key: string) => { for (const type of ["keydown", "keyup"]) document.activeElement!.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true })); };
  // ADR-585: the survey zoom buttons join the gamepad stop list (DOM order).
  for (const text of ["Random", "Zoom out −", "Zoom in +", "Create world", "Back"]) { press("GamepadDPadDown"); expect(document.activeElement?.textContent).toBe(text); }
  press("GamepadB"); expect(document.querySelector("[data-role=world-preview]")).toBeNull(); vi.advanceTimersByTime(100); expect(document.querySelector("[data-role=world-preview]")).toBeNull();
});
