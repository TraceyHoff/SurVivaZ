// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { InputSystem, KeyboardMouseDevice, GamepadDevice, DEFAULT_ACTIONS, DEFAULT_CONTEXTS, DEFAULT_PROFILES } from "@engine/input";
import { hotbarCells, hotbarCycle, hotbarKey, mountHotbar, pressedHotbarSlot, HOTBAR_SLOTS } from "../src/hotbar.js";

const view = [{ slot: 16, item: 1, icon: "stone_axe", name: "Stone axe", count: 1, equipped: true }, { slot: 18, item: 5, icon: "wood", name: "Wood", count: 16 }, { slot: 12, item: 9, icon: "stone", name: "Stone", count: 3 }];

describe("ADR-179 hotbar model", () => {
  it("8 cells for hotbar slots 16..23, empties included, pack slots beyond ignored", () => {
    const c = hotbarCells(view); expect(c).toHaveLength(HOTBAR_SLOTS); expect(c[0]).toMatchObject({ icon: "stone_axe", equipped: true, slot: 16 }); expect(c[1]!.count).toBe(0); expect(c[2]!.count).toBe(16);
    expect(c.some((x) => x.icon === "stone")).toBe(false);
  });
  it("cycle skips empties and wraps", () => {
    const c = hotbarCells(view); expect(hotbarCycle(c, 0, 1)).toBe(2); expect(hotbarCycle(c, 2, 1)).toBe(0); expect(hotbarCycle(c, 0, -1)).toBe(2); expect(hotbarCycle(c, -1, 1)).toBe(0);
    expect(hotbarCycle(hotbarCells([]), -1, 1)).toBe(-1);
  });
  it("key changes only with content / equip / device", () => {
    const k = hotbarKey(hotbarCells(view), "gamepad"); expect(hotbarKey(hotbarCells([...view]), "gamepad")).toBe(k);
    expect(hotbarKey(hotbarCells(view), "touch")).not.toBe(k); expect(hotbarKey(hotbarCells([{ ...view[0]!, equipped: false }, view[1]!]), "gamepad")).not.toBe(k);
  });
});

describe("ADR-179 hotbar input (keys, simulated gamepad)", () => {
  const mk = () => { let now = 0; const clock = { now: () => now, advance: (ms: number) => { now += ms; } };
    const sys = new InputSystem(clock as never, { actions: DEFAULT_ACTIONS, contexts: DEFAULT_CONTEXTS, profiles: DEFAULT_PROFILES });
    const kbm = new KeyboardMouseDevice(); const pad = new GamepadDevice(0); sys.addDevice(kbm); sys.addDevice(pad); sys.push("Gameplay");
    return { sys, kbm, pad, tick: () => { clock.advance(16); sys.update(); } }; };
  it("digit keys map to slots", () => { const { sys, kbm, tick } = mk(); kbm.press("key.Digit4"); tick(); expect(pressedHotbarSlot((a) => sys.pressed(a))).toBe(3); });
  it("D-pad = slots 1-4, LB + D-pad = slots 5-8, RB + D-pad (zoom) selects nothing", () => {
    const { sys, pad, tick } = mk();
    pad.set("pad.dright", 1); tick(); expect(pressedHotbarSlot((a) => sys.pressed(a))).toBe(1); pad.set("pad.dright", 0); tick();
    pad.set("pad.lb", 1); tick(); pad.set("pad.ddown", 1); tick(); expect(pressedHotbarSlot((a) => sys.pressed(a))).toBe(6); pad.set("pad.ddown", 0); pad.set("pad.lb", 0); tick();
    pad.set("pad.rb", 1); tick(); pad.set("pad.dup", 1); tick(); expect(pressedHotbarSlot((a) => sys.pressed(a))).toBe(-1);
  });
});

describe("ADR-179 hotbar DOM", () => {
  it("bottom-centre strip, change-only rebuild, click equips, hidden when not visible", () => {
    const equip = vi.fn(); let v = view; const h = mountHotbar({ view: () => v, equip, device: () => "keyboardMouse" });
    expect(document.head.textContent).toMatch(/#hotbar\{position:absolute;left:50%;bottom:calc\(8px \+ var\(--sab,0px\)\);transform:translateX\(-50%\)/);
    h.update(true); expect(h.el.hidden).toBe(false); expect(h.el.querySelectorAll("button")).toHaveLength(8); expect(h.el.className).toContain("hotbar");
    const first = h.el.querySelector("button"); h.update(true); expect(h.el.querySelector("button")).toBe(first); // ADR-158: no rebuild without change
    (h.el.querySelector('[data-slot="18"]') as HTMLElement).click(); expect(equip).toHaveBeenCalledWith(18);
    v = [{ ...view[1]!, count: 15 }]; h.update(true); expect(h.el.querySelector("button")).not.toBe(first); expect(h.el.querySelector('[data-slot="18"] .c')!.textContent).toBe("15");
    h.update(false); expect(h.el.hidden).toBe(true); h.destroy();
  });
});

describe("ADR-289 direct hotbar taps", () => {
  it("single tap selects, double tap activates once, slow/different taps only select; no canvas fall-through", () => {
    let now = 0; const equip = vi.fn(), activate = vi.fn(), canvas = vi.fn();
    const h = mountHotbar({ view: () => view, equip, activate, now: () => now, device: () => "touch" }); h.update(true);
    document.body.addEventListener("pointerdown", canvas);
    const tap = (slot: number) => { const b = h.el.querySelector(`[data-slot="${slot}"]`)!; b.dispatchEvent(new Event("pointerdown", { bubbles: true })); (b as HTMLElement).click(); };
    tap(18); expect(equip).toHaveBeenLastCalledWith(18); expect(activate).not.toHaveBeenCalled();
    now = 120; tap(18); expect(activate).toHaveBeenCalledTimes(1); expect(activate).toHaveBeenCalledWith(18);
    now = 500; tap(18); now = 1000; tap(18); expect(activate).toHaveBeenCalledTimes(1);
    now = 1100; tap(16); expect(equip).toHaveBeenLastCalledWith(16); expect(activate).toHaveBeenCalledTimes(1);
    expect(canvas).not.toHaveBeenCalled(); document.body.removeEventListener("pointerdown", canvas); h.destroy();
  });
  it("rebuilds between taps do not lose the double tap; hidden bar clears pending taps", () => {
    let now = 0, v = view; const activate = vi.fn(); const h = mountHotbar({ view: () => v, equip: vi.fn(), activate, now: () => now, device: () => "touch" }); h.update(true);
    (h.el.querySelector('[data-slot="18"]') as HTMLElement).click(); v = [{ ...view[1]!, equipped: true }]; h.update(true); now = 100;
    (h.el.querySelector('[data-slot="18"]') as HTMLElement).click(); expect(activate).toHaveBeenCalledTimes(1);
    now = 500; (h.el.querySelector('[data-slot="18"]') as HTMLElement).click(); h.update(false); h.update(true); now = 600;
    (h.el.querySelector('[data-slot="18"]') as HTMLElement).click(); expect(activate).toHaveBeenCalledTimes(1); h.destroy();
  });
  it("selected empty slots and equipped tools have a high-contrast yellow inset ring without changing geometry", () => {
    let selected = 23; const h = mountHotbar({ view: () => view, equip: vi.fn(), selectedSlot: () => selected, device: () => "touch" }); h.update(true);
    expect(h.el.querySelector('[data-slot="23"]')?.getAttribute("data-selected")).toBe("true"); expect(h.el.querySelector('[data-slot="23"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(document.head.textContent).toContain("inset 0 0 0 2px #FFDF00");
    selected = 18; h.update(true); expect(h.el.querySelector('[data-slot="23"]')?.getAttribute("data-selected")).toBe("false"); expect(h.el.querySelector('[data-slot="18"]')?.getAttribute("data-selected")).toBe("true"); h.destroy();
  });
});
