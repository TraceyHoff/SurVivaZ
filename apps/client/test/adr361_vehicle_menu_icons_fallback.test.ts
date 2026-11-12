// @vitest-environment jsdom
// ADR-361: before the task361 override is installed, a kit tile falls back to the placeable category icon
// (fiber) — the bug ADR-361 fixes. Separate file from adr361_vehicle_menu_icons.test.ts because hasIcon's
// stylesheet scan caches once per module registry, so the before/after routes need separate registries.
import { beforeEach, describe, expect, it } from "vitest";
import { World } from "@engine/core";
import * as G from "@engine/gameplay";
import { panelIcon } from "../src/gameplay-panels.js";

beforeEach(() => { document.head.innerHTML = ""; document.body.innerHTML = `<div id="game-root"><canvas id="game"></canvas></div>`; localStorage.clear(); (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: false }); });

describe("ADR-361 kit icon fallback before install", () => {
  it("panelIcon routes a kit tile to the fiber category fallback while the override is absent", () => {
    const w = new World({ seed: 1, maxEntities: 1 << 12 });
    G.installGameplay(w, {});
    // A stylesheet the scan can see, with the real category fallback in it but no kit keys — so the
    // route is the placeable fallback, exactly as in production before IsoView installs.
    const seed = document.createElement("style");
    seed.textContent = `[data-icon="fiber"]{--cz-ipos:0% 0%}[data-icon="build_crate_decor"]{--cz-ipos:0% 0%}`;
    document.head.append(seed);
    expect(panelIcon(w, "item_vehicle_kit_wagon_small", String(G.gameplayDefs(w).itemId("vehicle_kit_wagon_small")))).toBe("fiber");
    expect(panelIcon(w, "harness", String(G.gameplayDefs(w).itemId("harness")))).toBe("fiber");
  });
});
