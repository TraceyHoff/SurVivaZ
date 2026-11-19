// @vitest-environment jsdom
// fake-indexeddb is a dev dependency of @engine/persist (same import as agents_persist.test.ts).
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GameMenus } from "../src/game-menus.js";
import { uiRoot } from "../src/ui-root.js";
import { deleteConfirm, HOLD_MS } from "../src/delete-progress.js";

const key = (k: string, type = "keydown"): void => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent(type, { key: k, code: k === " " ? "Space" : k, bubbles: true, cancelable: true })); };
const q = <T extends HTMLElement>(s: string): T => document.querySelector<T>(s)!;

beforeEach(() => { document.body.innerHTML = `<div id="game-root"><canvas id="game"></canvas></div>`; localStorage.clear(); (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: false }); });

describe("confirm flow (keyboard / gamepad / touch)", () => {
  let menus: GameMenus | undefined;
  afterEach(() => menus?.destroy());
  test("Settings → Delete save is reachable with UINav; there is no typed confirmation — hold-to-delete is the only path, and a tap never deletes", async () => {
    const run = vi.fn(async () => "deleted");
    menus = new GameMenus({ root: uiRoot(), onQuit: () => {}, pollGamepads: false, deleteProgress: () => ({ label: "Delete save", message: "m", settingsOption: true, run }) });
    menus.open("settings");
    const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Delete save")!; expect(btn).toBeDefined();
    btn.focus(); key("Enter"); expect(menus.nav.top).toBe("delete-progress");
    const box = q<HTMLElement>("[data-role=delete-confirm]");
    expect(box.querySelector("[data-role=confirm-word]")).toBeNull(); // ADR-436: no type-DELETE input
    expect(box.querySelector("[data-action=confirm-delete]")).toBeNull(); // ADR-436: no Delete button
    expect(box.querySelector("input:not([type=checkbox])")).toBeNull(); // no text input of any kind
    const hold = box.querySelector<HTMLButtonElement>("[data-action=hold-delete]")!;
    expect(menus.nav.focusables()).toContain(hold);
    expect(box.querySelector("[data-role=delete-hint]")?.textContent).toContain("1.5 seconds");
    hold.click(); await Promise.resolve(); expect(run).not.toHaveBeenCalled(); // a tap never deletes
  });
  test("no typed path remains and the hold is still a deliberate 1500 ms hold", () => {
    expect(HOLD_MS).toBe(1500); // ADR-436: threshold not shortened to make the test easy
    const c = deleteConfirm({ message: "m", settingsOption: true, onConfirm: async () => "ok", onCancel: () => {}, manualTick: true });
    document.body.append(c.el);
    expect(c.el.querySelector("[data-role=confirm-word]")).toBeNull();
    expect(c.el.querySelector("[data-action=confirm-delete]")).toBeNull();
    expect(c.el.querySelectorAll("input")).toHaveLength(1); // only the "Also reset settings" checkbox
    expect(c.el.querySelector("[data-action=hold-delete]")).toBeTruthy();
    c.destroy();
  });
  test("Cancel closes; hold button: a tap never deletes, holding Enter/Space, pointer or gamepad A for HOLD_MS does", async () => {
    let t = 0; const pads = [{ buttons: [{ pressed: false }], axes: [] as number[] }];
    const mk = () => { const onConfirm = vi.fn(async (_o: { resetSettings: boolean }) => "ok"); const onCancel = vi.fn();
      const c = deleteConfirm({ message: "m", settingsOption: true, onConfirm, onCancel, now: () => t, getGamepads: () => pads as never, manualTick: true });
      document.body.append(c.el); return { c, onConfirm, onCancel, hold: c.el.querySelector<HTMLButtonElement>("[data-action=hold-delete]")! }; };
    const a = mk(); a.c.el.querySelector<HTMLButtonElement>("[data-action=cancel-delete]")!.click(); expect(a.onCancel).toHaveBeenCalled();
    a.hold.click(); a.c.tick(); expect(a.onConfirm).not.toHaveBeenCalled();
    // keyboard hold (UINav lets data-hold buttons own Enter/Space)
    a.hold.focus(); key(" "); a.c.tick(); t += HOLD_MS / 2; a.c.tick(); key(" ", "keyup"); a.c.tick(); t += HOLD_MS; a.c.tick();
    expect(a.onConfirm).not.toHaveBeenCalled(); // released early
    key("Enter"); a.c.tick(); t += HOLD_MS + 1; a.c.tick(); await Promise.resolve();
    expect(a.onConfirm).toHaveBeenCalledTimes(1);
    // gamepad A held while focused
    const b = mk(); b.hold.focus(); pads[0]!.buttons[0]!.pressed = true; b.c.tick(); t += HOLD_MS + 1; b.c.tick(); await Promise.resolve();
    expect(b.onConfirm).toHaveBeenCalledTimes(1); pads[0]!.buttons[0]!.pressed = false;
    // touch / pointer hold, with the settings opt-in
    const c = mk(); c.c.el.querySelector<HTMLInputElement>("[data-role=reset-settings]")!.checked = true;
    c.hold.dispatchEvent(new Event("pointerdown")); c.c.tick(); t += HOLD_MS + 1; c.c.tick(); await Promise.resolve();
    expect(c.onConfirm).toHaveBeenCalledWith({ resetSettings: true });
  });
});
