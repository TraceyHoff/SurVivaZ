// @vitest-environment jsdom
// ADR-361 menu-icon injection (companion to adr361_drawn_vehicle_art.test.ts, which runs in node because
// @engine/assets/node needs file: URLs): the task361 override stylesheet installs idempotently, is a safe
// no-op without a canvas, and panelIcon routes a kit/harness tile to the painted icon once installed.
// The before-install route (fiber category fallback) lives in adr361_vehicle_menu_icons_fallback.test.ts
// — a separate file because hasIcon's stylesheet scan caches once per module registry. Same pattern as
// adr357_store_menu_icons.test.ts.
import { beforeEach, describe, expect, it } from "vitest";
import { World } from "@engine/core";
import * as G from "@engine/gameplay";
import { panelIcon } from "../src/gameplay-panels.js";
import {
  VEHICLE_MENU_ICON_KEYS,
  installVehicleMenuIcons,
  vehicleMenuIconDataUrl,
} from "../src/task361-art.js";

const fakeUrls = new Map(VEHICLE_MENU_ICON_KEYS.map((s) => [s, `data:image/png;base64,${s}`]));

beforeEach(() => { document.head.innerHTML = ""; document.body.innerHTML = `<div id="game-root"><canvas id="game"></canvas></div>`; localStorage.clear(); (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: false }); });

describe("ADR-361 runtime-painted vehicle menu icons (injection)", () => {
  it("install appends one style element, replaces it on re-install, and is a safe no-op without a canvas", () => {
    expect(installVehicleMenuIcons(document, fakeUrls)).toBe(true);
    const el = document.getElementById("task361-menu-icons") as HTMLStyleElement | null;
    expect(el).not.toBeNull();
    expect(el!.tagName).toBe("STYLE");
    for (const key of VEHICLE_MENU_ICON_KEYS) expect(el!.textContent).toContain(`[data-icon="${key}"]`);
    // Re-install with different URLs replaces the element in place (still exactly one).
    const other = new Map(VEHICLE_MENU_ICON_KEYS.map((s) => [s, `data:image/png;base64,other-${s}`]));
    expect(installVehicleMenuIcons(document, other)).toBe(true);
    expect(document.querySelectorAll("#task361-menu-icons").length).toBe(1);
    expect((document.getElementById("task361-menu-icons") as HTMLStyleElement).textContent).toContain("other-item_vehicle_kit_cart");
    // No canvas in jsdom and no URLs supplied: nothing installed, nothing thrown.
    document.head.innerHTML = "";
    expect(vehicleMenuIconDataUrl("item_vehicle_kit_cart", document)).toBeUndefined();
    expect(installVehicleMenuIcons(document)).toBe(false);
    expect(document.getElementById("task361-menu-icons")).toBeNull();
  });

  it("panelIcon routes a kit/harness tile to the painted icon once the override is installed", () => {
    const w = new World({ seed: 1, maxEntities: 1 << 12 });
    G.installGameplay(w, {});
    expect(installVehicleMenuIcons(document, fakeUrls)).toBe(true);
    expect(panelIcon(w, "item_vehicle_kit_wagon_small", String(G.gameplayDefs(w).itemId("vehicle_kit_wagon_small")))).toBe("item_vehicle_kit_wagon_small");
    expect(panelIcon(w, "harness", String(G.gameplayDefs(w).itemId("harness")))).toBe("harness");
  });
});
