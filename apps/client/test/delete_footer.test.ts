// @vitest-environment jsdom
// Regression: main-menu "Delete progress" lost its Delete button after ADR-107 added Back (nested max-height scroll
// box clipped it below the fold). Hold to delete now lives in a sticky footer next to Back, enabled only with a selection.
import { describe, expect, test, vi } from "vitest";
// @ts-expect-error untyped relative path into persist's dev dependency
import { IDBFactory } from "../../../packages/persist/node_modules/fake-indexeddb/build/esm/index.js";
import { deleteConfirm, HOLD_MS } from "../src/delete-progress.js";
import { BootUI } from "../src/menu.js"; // static: the dynamic import's first-use transform (~18 s cold) blew the 5 s test timeout

const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5)); };

describe("Delete progress sticky footer", () => {
  for (const [name, w, h] of [["mobile", 390, 640], ["desktop", 1920, 1080]] as const) test(name, async () => {
    Object.assign(window, { innerWidth: w, innerHeight: h }); (globalThis as { indexedDB?: unknown }).indexedDB = new IDBFactory();
    document.body.innerHTML = ""; localStorage.clear();
    const ui = new BootUI("/"); void ui.menu({ hostedStatic: true, defaultUrl: "" });
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === "Delete progress")!.click();
    await flush();
    const footer = document.querySelector<HTMLElement>("[data-role=sticky-footer]")!;
    expect(footer).toBeTruthy(); expect(footer.closest(".panel")?.classList.contains("has-footer")).toBe(true);
    const css = Array.from(document.querySelectorAll("style")).map((s) => s.textContent).join("");
    expect(css).toMatch(/\.sticky-footer\{position:sticky;bottom:0/);
    const labels = Array.from(footer.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).toEqual(["Back", "Hold to delete"]);
    const hold = footer.querySelector<HTMLButtonElement>("[data-action=hold-delete]")!;
    const confirmBox = document.querySelector<HTMLElement>("[data-role=delete-confirm]")!;
    expect(confirmBox.contains(hold)).toBe(false); expect(confirmBox.style.maxHeight).toBe("none");
    expect(confirmBox.querySelector("[data-role=confirm-word]")).toBeNull(); // ADR-436: no type-DELETE input
    expect(confirmBox.querySelector("[data-action=confirm-delete]")).toBeNull(); // ADR-436: no Delete button
    expect(hold.disabled).toBe(true); // nothing selected
    const cb = document.querySelector<HTMLInputElement>("input[data-save=settings]")!; expect(cb).toBeTruthy();
    cb.click(); expect(hold.disabled).toBe(false);
    hold.focus(); expect(document.activeElement).toBe(hold); // keyboard / gamepad focus
    // keyboard: ArrowDown cycles through to the footer buttons
    const seen = new Set<Element | null>(); for (let i = 0; i < 12; i++) { dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" })); seen.add(document.activeElement); }
    expect(seen.has(hold)).toBe(true);
    // hold to delete (touch/pointer): press and hold for HOLD_MS through the live rAF tick loop
    localStorage.setItem("engine-settings", "{}");
    hold.dispatchEvent(new Event("pointerdown"));
    await new Promise((r) => setTimeout(r, HOLD_MS + 400)); await flush();
    expect(document.querySelector("[data-role=delete-status]")!.textContent).toContain("Deleted: settings");
    expect(localStorage.getItem("engine-settings")).toBeNull();
    cb.click(); expect(hold.disabled).toBe(true); ui.hide();
  });

  test("in-game Delete save / Delete hosted world dialog has hold-to-delete only, enabled without a selection", async () => {
    const onConfirm = vi.fn(() => "ok");
    let t = 0;
    const c = deleteConfirm({ message: "x", settingsOption: true, onConfirm, onCancel: () => {}, manualTick: true, now: () => t });
    document.body.append(c.el);
    expect(c.el.querySelector("[data-action=confirm-delete]")).toBeNull();
    expect(c.el.querySelector("[data-role=confirm-word]")).toBeNull();
    const hold = c.el.querySelector<HTMLButtonElement>("[data-action=hold-delete]")!;
    expect(hold.disabled).toBe(false);
    hold.dispatchEvent(new Event("pointerdown")); c.tick(); t += HOLD_MS + 1; c.tick(); await flush();
    expect(onConfirm).toHaveBeenCalledTimes(1); c.destroy();
  });
});
