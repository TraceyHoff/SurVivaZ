// @vitest-environment jsdom
// ADR-498: the Guide journal — a 16th "Discoveries" section in the in-game Guide, rendered from the
// local player's Discoveries; the boot panel (no player) keeps the 15 static sections. Gamepad
// LB/RB cycles into it through the existing [data-tabs=tab] pattern.
import { describe, expect, test } from "vitest";
import { World } from "@engine/core";
import { AbandonedKind, DiscoveryKind, discoveriesOf, discoveryLabel, installGameplay, recordChunkDiscoveries, spawnPlayer, type Discovery } from "@engine/gameplay";
import { GameMenus, cycleTabs } from "../src/game-menus.js";
import { buildGuidePanel } from "../src/guide-panel.js";
import type { GameplaySource } from "../src/gameplay-panels.js";

(globalThis as { matchMedia?: unknown }).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const sectionButton = (root: ParentNode, id: string): HTMLButtonElement =>
  root.querySelector<HTMLButtonElement>(`[data-guide-section="${id}"]`)!;
const detailText = (root: ParentNode): string =>
  root.querySelector("[data-role=guide-detail]")?.textContent ?? "";
const journal: Discovery[] = [
  { kind: DiscoveryKind.River, cx: 3, cy: -1 },
  { kind: DiscoveryKind.Lake, cx: 1, cy: 2 },
  { kind: DiscoveryKind.RuinBase + AbandonedKind.Chapel, cx: 0, cy: 0 },
];

describe("ADR-498 the Guide journal panel", () => {
  test("no journal: the boot Guide keeps its 15 static sections, no Discoveries button", () => {
    document.body.innerHTML = "";
    const el = buildGuidePanel();
    document.body.append(el);
    expect(sectionButton(document, "discoveries")).toBeNull();
    expect(document.querySelectorAll("[data-guide-section]").length).toBe(15);
  });

  test("a journal adds a Discoveries section; its detail lists the discoveries, most recent first", () => {
    document.body.innerHTML = "";
    const el = buildGuidePanel(undefined, journal);
    document.body.append(el);
    expect(document.querySelectorAll("[data-guide-section]").length).toBe(16);
    const btn = sectionButton(document, "discoveries");
    expect(btn.textContent).toBe("Discoveries");
    btn.click();
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    const detail = detailText(document);
    expect(detail).toContain("Discoveries");
    expect(detail).toContain("A river");
    expect(detail).toContain("A lake");
    expect(detail).toContain("Chapel ruins");
    expect(detail).toContain("(3, -1)");
    expect(detail).toContain("(1, 2)");
    expect(detail).toContain("(0, 0)");
    // Most recent first: the river (first in the journal) renders before the lake.
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-role=guide-discovery]"));
    expect(rows.map((r) => r.textContent)).toEqual([
      `${discoveryLabel(DiscoveryKind.River)}(3, -1)`,
      `${discoveryLabel(DiscoveryKind.Lake)}(1, 2)`,
      `${discoveryLabel(DiscoveryKind.RuinBase + AbandonedKind.Chapel)}(0, 0)`,
    ]);
  });

  test("an empty journal gets an invitation, not a blank page", () => {
    document.body.innerHTML = "";
    const el = buildGuidePanel(undefined, []);
    document.body.append(el);
    sectionButton(document, "discoveries").click();
    expect(detailText(document)).toContain("No discoveries yet");
  });

  test("initialId=discoveries opens on the journal", () => {
    document.body.innerHTML = "";
    const el = buildGuidePanel("discoveries", journal);
    document.body.append(el);
    expect(detailText(document)).toContain("Chapel ruins");
    expect(sectionButton(document, "discoveries").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("ADR-498 the in-game Guide carries the player's journal", () => {
  test("opening the Guide from pause shows the local player's discoveries; gamepad LB/RB cycles into it", () => {
    // A real gameplay world: the player explores two chunks, then opens the Guide.
    const w = new World({ seed: 42, maxEntities: 1 << 14 });
    installGameplay(w);
    const p = spawnPlayer(w, { x: 0, y: 0 });
    let found = 0;
    for (let cy = -3; cy <= 3 && found < 2; cy++) for (let cx = -3; cx <= 3 && found < 2; cx++) {
      found += recordChunkDiscoveries(w, p, cx, cy).length;
    }
    expect(found).toBeGreaterThanOrEqual(2);
    const mine = discoveriesOf(w, p);
    const src = { ctx: () => ({ world: w, player: p }), send: () => true } as unknown as GameplaySource;
    document.body.innerHTML = `<div id="game-root"></div>`;
    const menus = new GameMenus({ root: document.getElementById("game-root")!, onQuit: () => {}, pollGamepads: false, gameplay: src });
    menus.open("guide");
    expect(sectionButton(document, "discoveries")).not.toBeNull();
    sectionButton(document, "discoveries").click();
    for (const d of mine) {
      expect(detailText(document)).toContain(discoveryLabel(d.kind));
      expect(detailText(document)).toContain(`(${d.cx}, ${d.cy})`);
    }
    // Gamepad: cycling forward from the first static section 15 times lands on Discoveries.
    menus.open("guide");
    for (let i = 0; i < 15; i++) expect(cycleTabs(menus.nav, 1, "tab")).toBe(true);
    expect(detailText(document)).toContain("Discoveries");
    menus.destroy();
  });
});
