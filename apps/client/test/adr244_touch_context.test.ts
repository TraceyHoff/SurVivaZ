/** ADR-244: contextual touch carry / sleep buttons and their live captions. */
import { describe, expect, it } from "vitest";
import { syncTouchHidden, touchLabel, TOUCH_LABELS } from "../src/touch-overlay.js";
import layout from "../../../packages/input/profiles/touchLayout.json";

describe("ADR-244 touch context", () => {
  it("carry shows only near a liftable bag or while carrying; sleep only near a bed or while asleep", () => {
    const h = new Set<string>();
    syncTouchHidden(h, { reload: false }); expect([...h].sort()).toEqual(["carry", "mount", "reload", "sleep"]); // ADR-319: mount only near a rideable animal / while riding
    syncTouchHidden(h, { reload: false, carry: true }); expect(h.has("carry")).toBe(false); expect(h.has("sleep")).toBe(true);
    syncTouchHidden(h, { reload: true, carrying: true, sleep: true, mount: true }); expect(h.size).toBe(0);
    syncTouchHidden(h, { reload: false, sleeping: true }); expect(h.has("sleep")).toBe(false); expect(h.has("carry")).toBe(true);
  });
  it("captions flip to Drop / Wake / Aim", () => {
    expect(touchLabel("carry", { reload: false })).toBe(TOUCH_LABELS.carry); expect(touchLabel("carry", { reload: false, carrying: true })?.text).toBe("Drop");
    expect(touchLabel("sleep", { reload: false, sleeping: true })?.text).toBe("Wake"); expect(touchLabel("secondary", { reload: false, aim: true })?.text).toBe("Aim");
    expect(touchLabel("secondary", { reload: false })?.text).toBe("Block"); expect(touchLabel("crouch", { reload: false })?.text).toBe("Crouch");
  });
  it("no gameplay button sits over the bottom-centre hotbar strip (8 slots, ~400x60 css px at the 844x390 reference)", () => {
    const g = (layout as unknown as { gameplay: { reference: { w: number; h: number }; elements: { id: string; anchor: { x: number; y: number }; radius: number }[] } }).gameplay;
    const { w, h } = g.reference; const sx0 = (w - 400) / 2, sx1 = sx0 + 400, sy0 = h - 60;
    for (const e of g.elements) { const cx = e.anchor.x * w, cy = e.anchor.y * h, r = e.radius;
      const nx = Math.max(sx0, Math.min(cx, sx1)), ny = Math.max(sy0, Math.min(cy, h)); expect(Math.hypot(cx - nx, cy - ny) >= r, e.id).toBe(true); }
  });
});
