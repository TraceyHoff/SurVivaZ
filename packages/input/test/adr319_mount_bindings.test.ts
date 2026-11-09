/** ADR-319: Mount.Menu on every device (KBM U, pad LB+X, touch Mount button); no Gameplay binding conflicts; plain X stays Interact. */
import { describe, expect, it } from "vitest";
import { InputState } from "@engine/core";
import { InputSystem, GamepadDevice, KeyboardMouseDevice, TouchDevice, DEFAULT_ACTIONS, DEFAULT_CONTEXTS, DEFAULT_PROFILES, DEFAULT_FRAME_MAPPING, DEFAULT_TOUCH_LAYOUTS } from "../src/index.js";

function setup() {
  const c = { t: 0, now: () => c.t }; const sys = new InputSystem(c, { actions: DEFAULT_ACTIONS, contexts: DEFAULT_CONTEXTS, profiles: DEFAULT_PROFILES });
  const kbm = new KeyboardMouseDevice(); const pad = new GamepadDevice(0); const touch = new TouchDevice();
  sys.addDevice(kbm); sys.addDevice(pad); sys.addDevice(touch); sys.push("Gameplay");
  const st = new InputState(); let seq = 0;
  const tick = () => { c.t += 50; sys.update(); sys.writeFrame(st, DEFAULT_FRAME_MAPPING); return st.sample(++seq); };
  return { sys, kbm, pad, touch, tick };
}
describe("ADR-319 Mount.Menu bindings", () => {
  it("is bound on keyboard, gamepad and touch with no Gameplay conflicts", () => {
    const { sys } = setup();
    for (const cls of ["keyboardMouse", "gamepad", "touch"] as const) {
      expect(sys.bindings(cls, "Gameplay").some((b) => b.binding.action === "Mount.Menu"), cls).toBe(true);
      expect(sys.detectConflicts(cls).filter((c) => JSON.stringify(c).includes("Mount.Menu"))).toEqual([]);
    }
    expect(DEFAULT_TOUCH_LAYOUTS.gameplay.elements.some((e) => e.id === "mount")).toBe(true);
  });
  it("KBM U and pad LB+X press Mount.Menu; plain pad X does not open it", () => {
    const { sys, kbm, pad, tick } = setup();
    kbm.press("key.KeyU"); tick(); expect(sys.pressed("Mount.Menu")).toBe(true); kbm.releaseAll(); tick(); tick();
    pad.set("pad.lb", 1); tick(); pad.set("pad.x", 1); tick(); expect(sys.pressed("Mount.Menu")).toBe(true); expect(sys.pressed("Interact")).toBe(false);
    pad.set("pad.x", 0); pad.set("pad.lb", 0); tick(); tick();
    pad.set("pad.x", 1); tick(); expect(sys.pressed("Mount.Menu")).toBe(false); // plain X keeps its Interact binding
  });
});
