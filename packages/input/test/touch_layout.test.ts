import { describe, it, expect } from "vitest";
import { VirtualControls, TouchDevice, DEFAULT_TOUCH_LAYOUTS } from "../src/index.js";

/** ADR-133: compact, non-overlapping touch cluster at common phone landscape sizes. */
const PHONES: [number, number, number][] = [[844, 390, 47], [915, 412, 0], [780, 360, 0], [740, 360, 0], [667, 375, 0], [896, 414, 44], [932, 430, 59], [1024, 480, 0], [375, 667, 0], [390, 844, 0], [320, 568, 0]];
const MENU = new Set(["inventory", "crafting", "map", "chat", "social", "build", "back"]); // replaced by the DOM menu bar

for (const name of ["gameplay", "building"] as const) describe(`touch layout ${name}`, () => {
  for (const [w, h, notch] of PHONES) it(`${w}x${h} (insets ${notch}) has no overlaps, stays on screen, thumb-sized`, () => {
    const layout = { ...DEFAULT_TOUCH_LAYOUTS[name], elements: DEFAULT_TOUCH_LAYOUTS[name].elements.filter((e) => !MENU.has(e.id)) };
    const vc = new VirtualControls(layout, new TouchDevice()); vc.resize({ w, h, insets: { top: 0, right: notch, bottom: notch ? 21 : 0, left: notch } });
    const g = vc.geometry().filter((e) => e.kind !== "joystick");
    for (const a of g) {
      expect(a.r * 2, a.id).toBeGreaterThanOrEqual(44); expect(a.r * 2, a.id).toBeLessThanOrEqual(65);
      expect(a.x - a.r, a.id).toBeGreaterThanOrEqual(notch); expect(a.x + a.r, a.id).toBeLessThanOrEqual(w - notch);
      expect(a.y + a.r, a.id).toBeLessThanOrEqual(h - (notch ? 21 : 0)); expect(a.y - a.r, a.id).toBeGreaterThanOrEqual(56); // below the top menu bar
      for (const b of g) if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y), `${a.id}/${b.id}`).toBeGreaterThanOrEqual(a.r + b.r + 4);
    }
  });
});

describe("touch layout audit (ADR-133)", () => {
  it("gameplay keeps only controls with a consumer; no large aim pad", () => {
    const ids = DEFAULT_TOUCH_LAYOUTS.gameplay.elements.filter((e) => !MENU.has(e.id)).map((e) => e.id).sort();
    expect(ids).toEqual(["attack", "carry", "context", "crouch", "move", "reload", "secondary", "sleep"]); // ADR-244 adds block / crouch + contextual carry / sleep
    expect(DEFAULT_TOUCH_LAYOUTS.building.elements.filter((e) => !MENU.has(e.id)).map((e) => e.id).sort()).toEqual(["cancel", "confirm", "move", "rotate"]);
    for (const e of DEFAULT_TOUCH_LAYOUTS.gameplay.elements) if (e.kind !== "joystick") expect(e.radius, e.id).toBeLessThanOrEqual(28);
  });
  it("hidden controls are not drawn and not hit-tested", () => {
    const touch = new TouchDevice(); const vc = new VirtualControls(DEFAULT_TOUCH_LAYOUTS.gameplay, touch); vc.resize({ w: 844, h: 390 });
    const r = vc.geometry().find((e) => e.id === "reload")!;
    vc.hidden.add("reload"); expect(vc.geometry().find((e) => e.id === "reload")!.visible).toBe(false);
    expect(vc.pointerDown(1, r.x, r.y)).toBe(false);
    vc.hidden.delete("reload"); expect(vc.pointerDown(2, r.x, r.y)).toBe(true);
  });
});
