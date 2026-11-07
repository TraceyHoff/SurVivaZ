// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { mountTouchOverlay, syncTouchHidden, TOUCH_LABELS } from "../src/touch-overlay.js";
import { iconUrl } from "../src/game-icons.js";
import { blockLongPressMenus, isEditable } from "../src/ui-root.js";

describe("ADR-133 touch overlay", () => {
  it("labels every control, hides context-only Reload and controls not in the active layout", () => {
    const root = document.createElement("div"); document.body.append(root); const hidden = new Set<string>();
    let geo = [{ id: "attack", kind: "button" as const, x: 50, y: 50, r: 28, pressed: false, visible: true }, { id: "reload", kind: "button" as const, x: 150, y: 50, r: 22, pressed: false, visible: true }];
    const o = mountTouchOverlay(root, () => { syncTouchHidden(hidden, { reload: false }); return geo.map((g) => ({ ...g, visible: !hidden.has(g.id) })); }); o.draw();
    const el = (id: string): HTMLElement => root.querySelector(`[data-touch=${id}]`)!;
    // Task 25: the attack button carries the custom sword icon (was ⚔ emoji) + the "Hit" text.
    // Icons are embedded as data URIs (see game-icons-data.ts), so compare against iconUrl, not a filename.
    expect(el("attack").textContent).toBe("Hit"); expect(el("attack").querySelector("img")?.getAttribute("src")).toBe(iconUrl("ic_sword.png")); expect(el("reload").style.display).toBe("none");
    geo = [{ id: "confirm", kind: "button" as const, x: 50, y: 50, r: 28, pressed: false, visible: true }]; o.draw();
    expect(el("attack").style.display).toBe("none"); expect(el("confirm").getAttribute("aria-label")).toBe("Place");
    for (const id of ["attack", "context", "boost", "reload", "confirm", "cancel", "rotate"]) expect(TOUCH_LABELS[id]?.text, id).toBeTruthy();
    syncTouchHidden(hidden, { reload: true }); expect(hidden.has("reload")).toBe(false); o.destroy();
  });
  it("long-press / selection menus are blocked except in text fields", () => {
    const host = document.createElement("div"); const div = document.createElement("div"); const input = document.createElement("input"); host.append(div, input); document.body.append(host); blockLongPressMenus(host);
    const fire = (t: Element, type: string): boolean => { const e = new Event(type, { bubbles: true, cancelable: true }); t.dispatchEvent(e); return e.defaultPrevented; };
    expect(fire(div, "contextmenu")).toBe(true); expect(fire(div, "selectstart")).toBe(true); expect(fire(input, "contextmenu")).toBe(false); expect(isEditable(input)).toBe(true);
  });
});
