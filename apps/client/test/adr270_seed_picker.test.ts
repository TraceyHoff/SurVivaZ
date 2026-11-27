// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BootUI } from "../src/menu.js";
import { parseWorldSeed } from "../src/world-seed.js";

(globalThis as { matchMedia?: unknown }).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const button = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === text)!;
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
let ui: BootUI | undefined;
afterEach(() => { ui?.hide(); document.body.innerHTML = ""; });
function open(savedSeed = vi.fn(async (_mode: "singleplayer" | "host"): Promise<number | undefined> => undefined)) {
  ui = new BootUI("/");
  const choice = ui.menu({ hostedStatic: true, defaultUrl: "", savedSeed, mp: { probe: async () => 1 } });
  return { choice, savedSeed };
}

describe("ADR-270: world seed before character creation", () => {
  for (const mode of ["singleplayer", "host"] as const) it(`${mode}: new-world seed is editable, shown and chosen before the menu resolves`, async () => {
    const { choice, savedSeed } = open(); let resolved = false; void choice.then(() => { resolved = true; });
    if (mode === "host") { button("Multiplayer").click(); button("Host game").click(); }
    else button("Singleplayer").click();
    await flush();
    expect(savedSeed).toHaveBeenCalledWith(mode); expect(resolved).toBe(false);
    const input = document.querySelector<HTMLInputElement>("[data-role=world-seed]")!;
    expect(input).not.toBeNull(); expect(document.activeElement).toBe(input);
    input.value = " 424242 "; input.dispatchEvent(new Event("input"));
    expect(document.querySelector("[data-role=chosen-seed]")?.textContent).toContain("424242");
    button("Create world").click();
    await expect(choice).resolves.toEqual({ kind: mode, seed: 424242 });
  });
  it("blank uses the displayed generated seed; Random chooses a valid reusable seed", async () => {
    const { choice } = open(); button("Singleplayer").click(); await flush();
    button("Random").click(); const input = document.querySelector<HTMLInputElement>("[data-role=world-seed]")!;
    const generated = Number(input.value); expect(generated).toBeGreaterThan(0); expect(generated).toBeLessThanOrEqual(0xffffffff);
    input.value = ""; input.dispatchEvent(new Event("input"));
    expect(document.querySelector("[data-role=chosen-seed]")?.textContent).toContain(String(generated));
    input.focus(); input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await expect(choice).resolves.toEqual({ kind: "singleplayer", seed: generated });
  });
  it("invalid seeds do not proceed; unsigned zero is valid", () => {
    for (const text of ["abc", "-1", "1.5", "4294967296", "Infinity"]) expect(parseWorldSeed(text, 1)).toBeUndefined();
    expect(parseWorldSeed("0", 1)).toBe(0); expect(parseWorldSeed("4294967295", 1)).toBe(0xffffffff); expect(parseWorldSeed(" ", 7)).toBe(7);
  });
  for (const mode of ["singleplayer", "host"] as const) it(`${mode}: continuing skips the picker and supplies no replacement seed`, async () => {
    const { choice } = open(vi.fn(async () => 12345));
    if (mode === "host") { button("Multiplayer").click(); button("Host game").click(); } else button("Singleplayer").click();
    await expect(choice).resolves.toEqual({ kind: mode }); expect(document.querySelector("[data-role=world-seed]")).toBeNull();
  });
  it("joining never reads a local save or chooses a seed", async () => {
    const { choice, savedSeed } = open(); button("Multiplayer").click();
    document.querySelector<HTMLInputElement>("[data-role=room-code]")!.value = "ABC234"; button("Join").click();
    await expect(choice).resolves.toEqual({ kind: "join", code: "ABC234" }); expect(savedSeed).not.toHaveBeenCalled();
  });
  it("gamepad navigation reaches field, Random, zoom buttons, Create, Back; B returns without creating a world", async () => {
    open(); button("Singleplayer").click(); await flush();
    const press = (key: string) => { for (const type of ["keydown", "keyup"]) document.activeElement!.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true })); };
    press("GamepadDPadDown"); expect(document.activeElement).toBe(button("Random"));
    // ADR-585: the survey zoom buttons are gamepad-reachable stops between Random and Create.
    press("GamepadDPadDown"); expect(document.activeElement).toBe(button("Zoom out −"));
    press("GamepadDPadDown"); expect(document.activeElement).toBe(button("Zoom in +"));
    press("GamepadDPadDown"); expect(document.activeElement).toBe(button("Create world"));
    press("GamepadDPadDown"); expect(document.activeElement).toBe(button("Back"));
    press("GamepadB"); expect(document.querySelector("[data-role=world-seed]")).toBeNull(); expect(button("Singleplayer")).toBeDefined();
  });
  it("production waits for the picker before the creator, forwards the same seed to worker/fallback and host, and displays it in Session", () => {
    const main = readFileSync(resolve(__dirname, "../src/main.ts"), "utf8");
    expect(main.indexOf("const choice = await boot.menu")).toBeLessThan(main.indexOf("activeChar = await ensureCharacter(kind)"));
    expect(main).toContain("await startSingleplayer(choice.seed)"); expect(main).toContain("await startHost(choice.seed)");
    expect(main).toContain("...seedOpt"); expect(main).toContain("World seed:");
  });
});
