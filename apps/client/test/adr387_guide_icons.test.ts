// @vitest-environment jsdom
// ADR-387: guide listings show their icons; the Guide's pages show the book icon, not emoji.
// - The book icon (guide-art.ts) paints real pixels, installs into ICON_DATA + a [data-icon] rule,
//   and appears on the Guide's entry buttons (pause, settings) and page headers (in-game + boot).
// - Every fact row with an icon renders it immediately before its label: [data-icon] spans for
//   guide keys, conditionIconImg <img>s (data-uiIcon) for disease status art, iconImg <img>s for
//   embedded ic_ files. The broken-leg rows show the broken-leg icon (data-uiIcon="broken_leg").
// - Quick-jump buttons show their section icons. No 📖 remains anywhere in the Guide UI.
// - A row whose icon has no art renders text-only, never a broken image (guideIconKey -> undefined).
import { afterEach, describe, expect, test } from "vitest";
import { getGuideSections, resolvedGuideSection } from "@engine/gameplay";
import { BootUI } from "../src/menu.js";
import { GameMenus, GAME_MENUS } from "../src/game-menus.js";
import { buildGuidePanel, guideIconKey } from "../src/guide-panel.js";
import { ICON_DATA } from "../src/game-icons-data.js";
import { GUIDE_BOOK_ICON_FILE, guideBookIconDataUrl, installGuideMenuIcon, paintGuideBookPixels } from "../src/guide-art.js";

(globalThis as { matchMedia?: unknown }).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const TEST_URL = "data:image/png;base64,ADR387TEST";
const hasAll = () => true;

const sectionButton = (root: ParentNode, id: string): HTMLButtonElement =>
  root.querySelector<HTMLButtonElement>(`[data-guide-section="${id}"]`)!;
const detailText = (root: ParentNode): string =>
  root.querySelector("[data-role=guide-detail]")?.textContent ?? "";
const pxAt = (pixels: Uint8ClampedArray, x: number, y: number): readonly [number, number, number, number] => {
  const i = (y * 128 + x) * 4;
  return [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!, pixels[i + 3]!];
};

describe("ADR-387 the Guide book icon (guide-art.ts)", () => {
  test("the painter draws a book: leather cover, gilt medallion, spine, page block, ribbon", () => {
    const { width, height, pixels } = paintGuideBookPixels();
    expect(width).toBe(128); expect(height).toBe(128);
    expect(pxAt(pixels, 64, 20)).toEqual([122, 59, 46, 255]); // cover
    expect(pxAt(pixels, 50, 50)).toEqual([146, 74, 56, 255]); // inset cover panel
    expect(pxAt(pixels, 65, 56)).toEqual([201, 162, 39, 255]); // gilt medallion ring
    expect(pxAt(pixels, 65, 64)).toEqual([122, 59, 46, 255]); // medallion centre
    expect(pxAt(pixels, 32, 60)).toEqual([88, 40, 32, 255]); // spine
    expect(pxAt(pixels, 101, 60)).toEqual([242, 230, 200, 255]); // page block
    expect(pxAt(pixels, 101, 52)).toEqual([214, 196, 160, 255]); // page line
    expect(pxAt(pixels, 64, 112)).toEqual([201, 162, 39, 255]); // bookmark ribbon
    expect(pxAt(pixels, 10, 10)).toEqual([0, 0, 0, 0]); // transparent corner
    expect(pxAt(pixels, 40, 116)).toEqual([0, 0, 0, 70]); // ground shadow
  });

  test("install is a safe no-op without a canvas and registers the icon with the test seam", () => {
    document.body.innerHTML = "";
    expect(guideBookIconDataUrl(document)).toBeUndefined(); // jsdom has no 2d canvas
    expect(installGuideMenuIcon(document)).toBe(false);
    expect(ICON_DATA[GUIDE_BOOK_ICON_FILE]).toBeUndefined();
    expect(installGuideMenuIcon(document, new Map([[GUIDE_BOOK_ICON_FILE, TEST_URL]]))).toBe(true);
    expect(ICON_DATA[GUIDE_BOOK_ICON_FILE]).toBe(TEST_URL);
    const style = document.getElementById("guide-menu-icons");
    expect(style?.textContent).toContain("[data-icon=\"guide_book\"]");
    expect(style?.textContent).toContain(TEST_URL);
    // idempotent: a second install replaces the rule, it does not duplicate the style element
    expect(installGuideMenuIcon(document, new Map([[GUIDE_BOOK_ICON_FILE, TEST_URL]]))).toBe(true);
    expect(document.querySelectorAll("#guide-menu-icons")).toHaveLength(1);
    delete ICON_DATA[GUIDE_BOOK_ICON_FILE];
    document.getElementById("guide-menu-icons")?.remove();
  });
});

describe("ADR-387 guide fact-row icons in the panel", () => {
  test("every fact row with an icon renders it before its label; broken-leg rows show the broken-leg icon", () => {
    document.body.innerHTML = "";
    const el = buildGuidePanel();
    document.body.append(el);
    const sections = getGuideSections();
    let checked = 0;
    for (const s of sections) {
      sectionButton(el, s.id).click();
      const r = resolvedGuideSection(s.id)!;
      const detail = el.querySelector("[data-role=guide-detail]")!;
      const rows = Array.from(detail.querySelectorAll<HTMLElement>("[data-role=guide-fact]"));
      const facts = r.items.filter((i) => i.kind === "fact");
      expect(rows.length).toBe(facts.length);
      facts.forEach((item, i) => {
        const row = rows[i]!;
        const label = row.querySelector(".guide-fact-label")!;
        expect(label.textContent).toBe(item.label);
        const first = label.firstElementChild;
        if (!item.icon) { expect(first).toBeNull(); return; }
        checked++;
        expect(first, `${s.id}: ${item.label}`).not.toBeNull();
        if (item.icon.kind === "guide") {
          expect(first!.tagName).toBe("SPAN");
          expect(first!.getAttribute("data-icon")).toBe(guideIconKey(item.icon.key, hasAll));
        } else if (item.icon.kind === "condition" && !item.icon.icon.endsWith(".png")) {
          // atlas-key status art (broken_leg, infected): conditionIconImg tags the <img> so the
          // UI atlas can fill it in when it loads
          expect(first!.tagName).toBe("IMG");
          expect(first!.getAttribute("data-ui-icon")).toBe(item.icon.icon);
        } else {
          // condition icons that are .png files (ic_health/snowflake/temp) delegate to iconImg,
          // exactly like file icons: a plain <img> with the embedded data: src, no data-ui-icon
          expect(first!.tagName).toBe("IMG");
          expect(first!.getAttribute("data-ui-icon")).toBeNull();
          expect((first as HTMLImageElement).src.startsWith("data:image/png")).toBe(true);
        }
      });
    }
    expect(checked).toBe(65); // ADR-400: + the spring temperatures row (ic_blossom)
    // the broken-leg listing specifically: the broken-leg status icon before "Broken Leg"
    sectionButton(el, "diseases").click();
    const detail = el.querySelector("[data-role=guide-detail]")!;
    const broken = Array.from(detail.querySelectorAll<HTMLElement>("[data-role=guide-fact]"))
      .filter((row) => row.textContent?.includes("Broken Leg"));
    expect(broken).toHaveLength(2);
    for (const row of broken) {
      expect(row.querySelector("img[data-ui-icon=\"broken_leg\"]")).not.toBeNull();
    }
    expect(detailText(el)).not.toContain("📖");
  });

  test("quick-jump buttons show their section icons", () => {
    document.body.innerHTML = "";
    const el = buildGuidePanel();
    document.body.append(el);
    for (const s of getGuideSections()) {
      const b = sectionButton(el, s.id);
      expect(b.textContent).toBe(s.title); // the icon span carries no text
      expect(b.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe(guideIconKey(s.icon, hasAll));
    }
  });

  test("a row whose icon has no art renders text-only (pet cat/fox/owl have no CSS rule yet)", () => {
    // guideIconKey with the shipped stylesheet's keys: only pet_dog_lab exists, so the other
    // treats rows resolve to nothing and render with no icon node — never a broken image.
    const hasShipped = (k: string): boolean => ["pet_dog_lab", "torch"].includes(k);
    expect(guideIconKey("pet:dog_lab", hasShipped)).toBe("pet_dog_lab");
    expect(guideIconKey("pet:cat_tabby", hasShipped)).toBeUndefined();
    expect(guideIconKey("pet:fox", hasShipped)).toBeUndefined();
    expect(guideIconKey("pet:owl", hasShipped)).toBeUndefined();
    // in the panel, the dog row still renders its icon when the stylesheet has it
    document.body.innerHTML = "";
    const el = buildGuidePanel();
    document.body.append(el);
    sectionButton(el, "animals").click();
    const detail = el.querySelector("[data-role=guide-detail]")!;
    const dog = Array.from(detail.querySelectorAll<HTMLElement>("[data-role=guide-fact]"))
      .find((row) => row.textContent?.includes("A Labrador loves"))!;
    expect(dog.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe("pet_dog_lab");
  });
});

describe("ADR-387 the Guide's entry buttons and page headers show the book, not emoji", () => {
  let ui: BootUI | undefined;
  let menus: GameMenus | undefined;
  afterEach(() => { ui?.hide(); menus?.destroy(); document.body.innerHTML = ""; delete ICON_DATA[GUIDE_BOOK_ICON_FILE]; document.getElementById("guide-menu-icons")?.remove(); });

  const openMenus = (): GameMenus => {
    document.body.innerHTML = `<div id="game-root"></div>`;
    installGuideMenuIcon(document, new Map([[GUIDE_BOOK_ICON_FILE, TEST_URL]]));
    menus = new GameMenus({
      root: document.getElementById("game-root")!,
      onQuit: () => {},
      pollGamepads: false,
      tutorial: { active: () => false, replay: () => {}, next: () => {}, skip: () => {} },
    });
    return menus;
  };

  test("the menu def carries the book icon, not the 📖 emoji", () => {
    expect(GAME_MENUS.find((m) => m.id === "guide")?.icon).toBe("guide_book.png");
  });

  test("pause lists Guide with the book icon; the in-game Guide header shows it too", () => {
    const m = openMenus();
    m.pause();
    const guideBtn = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-menu=pause] button"))
      .find((b) => b.textContent === "Guide")!;
    expect(guideBtn).toBeTruthy();
    expect(guideBtn.querySelector("img")?.getAttribute("src")).toBe(TEST_URL);
    expect(guideBtn.textContent).not.toContain("📖");
    const replayBtn = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-menu=pause] button"))
      .find((b) => b.textContent === "Play the guide again")!;
    expect(replayBtn.querySelector("img")?.getAttribute("src")).toBe(TEST_URL);
    guideBtn.click();
    expect(m.nav.top).toBe("guide");
    const h2 = document.querySelector("[data-menu=guide] h2")!;
    expect(h2.querySelector("img")?.getAttribute("src")).toBe(TEST_URL);
    expect(h2.textContent).toContain("Guide");
    expect(document.querySelector("[data-menu=guide]")?.textContent).not.toContain("📖");
  });

  test("settings replays the guide with the book icon and no 📖", () => {
    const m = openMenus();
    m.open("settings");
    const replayBtn = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-menu=settings] button"))
      .find((b) => b.textContent === "Play the guide again")!;
    expect(replayBtn).toBeTruthy();
    expect(replayBtn.querySelector("img")?.getAttribute("src")).toBe(TEST_URL);
    expect(replayBtn.textContent).not.toContain("📖");
    expect(document.querySelector("[data-menu=settings]")?.textContent).not.toContain("📖");
  });

  test("the boot-menu Guide screen header shows the book icon", async () => {
    ui = new BootUI("/");
    const choice = ui.menu({ hostedStatic: true, defaultUrl: "" });
    let resolved = false; void choice.then(() => { resolved = true; });
    installGuideMenuIcon(document, new Map([[GUIDE_BOOK_ICON_FILE, TEST_URL]]));
    const button = (text: string): HTMLButtonElement =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === text)!;
    expect(button("Guide")).not.toBeUndefined();
    button("Guide").click();
    const guide = document.querySelector("[data-role=guide]")!;
    expect(guide).not.toBeNull();
    const h2 = document.querySelector("h2");
    expect(h2?.querySelector("img")?.getAttribute("src")).toBe(TEST_URL);
    expect(h2?.textContent).toContain("Guide");
    expect(resolved).toBe(false);
    await Promise.resolve();
  });
});
