// @vitest-environment jsdom
// ADR-363: the guide window — main-menu entry + pause-menu entry, section list + detail over the ADR-362
// accessors, close behaviour back to the right place, and the pause flow preserved (the pause menu stays
// in the stack under the guide, so main.ts's isOpenId("pause") singleplayer pause still holds).
import { afterEach, describe, expect, test } from "vitest";
import { getGuideSections, resolvedGuideSection } from "@engine/gameplay";
import { BootUI } from "../src/menu.js";
import { GameMenus, cycleTabs } from "../src/game-menus.js";
import { buildGuidePanel, guideIconKey } from "../src/guide-panel.js";

(globalThis as { matchMedia?: unknown }).matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const press = (key: string, target: Element = document.body): void => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
};
const sectionButton = (root: ParentNode, id: string): HTMLButtonElement =>
  root.querySelector<HTMLButtonElement>(`[data-guide-section="${id}"]`)!;
const detailText = (root: ParentNode): string =>
  root.querySelector("[data-role=guide-detail]")?.textContent ?? "";

describe("ADR-363 guideIconKey (the [data-icon] hook; pet:/mount: art landed in ADR-364)", () => {
  test("item: / piece: / vehicle: / pet: / mount: resolve when the stylesheet has the key", () => {
    const hasAll = () => true;
    expect(guideIconKey("item:torch", hasAll)).toBe("torch");
    expect(guideIconKey("item:stone_axe", hasAll)).toBe("stone_axe");
    // tiered candidates first, like the build menu (tier-1 art for a tier-1 piece)
    expect(guideIconKey("piece:claim_totem", hasAll)).toBe("build_claim_totem_t1");
    expect(guideIconKey("piece:ore_store", hasAll)).toBe("build_ore_store_t1");
    expect(guideIconKey("vehicle:chariot", hasAll)).toBe("item_vehicle_kit_chariot");
    // ADR-364: the pet/mount atlas-crop rules (gameplay-panels.css) close the two ADR-363 gaps
    expect(guideIconKey("pet:dog_lab", hasAll)).toBe("pet_dog_lab");
    expect(guideIconKey("mount:horse", hasAll)).toBe("mount_horse");
    expect(guideIconKey("item:no_such_item", hasAll)).toBeUndefined();
  });
  test("with the shipped stylesheet's keys (plain build_<key> only, no _tN variants), pieces resolve plain", () => {
    // the shipped gameplay-panels.css carries [data-icon="build_claim_totem"] but no build_*_tN rules
    const hasShipped = (k: string): boolean => ["torch", "build_claim_totem", "build_ore_store"].includes(k);
    expect(guideIconKey("piece:claim_totem", hasShipped)).toBe("build_claim_totem");
    expect(guideIconKey("piece:ore_store", hasShipped)).toBe("build_ore_store");
    expect(guideIconKey("item:torch", hasShipped)).toBe("torch");
  });
  test("a key the stylesheet lacks resolves to nothing (text-only fallback, never a broken image)", () => {
    const hasOnlyTorch = (k: string): boolean => k === "torch";
    expect(guideIconKey("item:torch", hasOnlyTorch)).toBe("torch");
    expect(guideIconKey("item:stone_axe", hasOnlyTorch)).toBeUndefined();
    expect(guideIconKey("piece:claim_totem", hasOnlyTorch)).toBeUndefined();
    expect(guideIconKey("vehicle:chariot", hasOnlyTorch)).toBeUndefined();
    expect(guideIconKey("item:torch", () => false)).toBeUndefined();
  });
});

describe("ADR-363 buildGuidePanel", () => {
  test("all 15 sections list in order; every section renders title, intro and all its items", () => {
    document.body.innerHTML = "";
    const el = buildGuidePanel();
    document.body.append(el);
    const sections = getGuideSections();
    expect(sections).toHaveLength(15);
    const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>("[data-guide-section]"));
    expect(buttons.map((b) => b.dataset["guideSection"])).toEqual(sections.map((s) => s.id));
    expect(buttons.map((b) => b.textContent)).toEqual(sections.map((s) => s.title));
    expect(el.querySelector("input,select,textarea")).toBeNull(); // no search box: the list IS the quick-jump
    for (const s of sections) {
      sectionButton(el, s.id).click();
      const r = resolvedGuideSection(s.id)!;
      const detail = el.querySelector("[data-role=guide-detail]")!;
      expect(detail.querySelector("[data-role=guide-title]")?.textContent).toContain(r.title);
      expect(detail.querySelector("[data-role=guide-intro]")?.textContent).toBe(r.intro);
      for (const item of r.items) {
        if (item.kind === "text") expect(detailText(el)).toContain(item.text);
        else if (item.kind === "fact") { expect(detailText(el)).toContain(item.label); expect(detailText(el)).toContain(item.value); }
        else if (item.kind === "image") {
          const fig = detail.querySelector(`[data-role=guide-image][data-image="${item.image}"]`);
          expect(fig, `${s.id}: ${item.image}`).not.toBeNull();
          expect(fig?.querySelector("figcaption")?.textContent).toBe(item.caption);
          expect(fig?.querySelectorAll("[data-role=guide-img-tile]").length).toBeGreaterThan(0);
        } else {
          expect(detailText(el)).toContain(item.label);
          for (const k of item.keys) expect(Array.from(detail.querySelectorAll("kbd")).map((c) => c.textContent)).toContain(k);
        }
      }
      // exactly one section is pressed, and it is this one
      expect(buttons.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset["guideSection"])).toEqual([s.id]);
    }
    expect(el.querySelector("img")).toBeNull(); // icons are [data-icon] spans, never <img>
  });
  test("icons render where the stylesheet has art — including the ADR-364 pet/mount icons", () => {
    document.body.innerHTML = "";
    const el = buildGuidePanel();
    document.body.append(el);
    sectionButton(el, "getting-started").click();
    expect(el.querySelector("[data-role=guide-title] [data-icon]")?.getAttribute("data-icon")).toBe("torch");
    sectionButton(el, "animals").click();
    expect(el.querySelector("[data-role=guide-title] [data-icon]")?.getAttribute("data-icon")).toBe("pet_dog_lab");
    sectionButton(el, "mounts-vehicles").click();
    expect(el.querySelector("[data-role=guide-title] [data-icon]")?.getAttribute("data-icon")).toBe("mount_horse");
    sectionButton(el, "storage").click();
    // jsdom has no bundled stylesheet, so has() is true for every candidate and the tiered key wins
    // (in production the shipped CSS has only the plain build_ore_store rule, so that is what renders)
    expect(el.querySelector("[data-role=guide-title] [data-icon]")?.getAttribute("data-icon")).toMatch(/^build_ore_store/);
  });
  test("initialId opens on that section", () => {
    document.body.innerHTML = "";
    const el = buildGuidePanel("diseases");
    document.body.append(el);
    expect(detailText(el)).toContain(resolvedGuideSection("diseases")!.title);
    expect(sectionButton(el, "diseases").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("ADR-363 guide in-game: pause menu", () => {
  const openMenus = (): GameMenus => {
    document.body.innerHTML = `<div id="game-root"></div>`;
    return new GameMenus({ root: document.getElementById("game-root")!, onQuit: () => {}, pollGamepads: false });
  };
  test("pause lists Guide; opening it stacks over pause and closing returns to pause", () => {
    const menus = openMenus();
    menus.pause();
    const guideBtn = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-menu=pause] button")).find((b) => b.textContent === "Guide");
    expect(guideBtn).toBeTruthy();
    guideBtn!.click();
    expect(menus.nav.top).toBe("guide");
    expect(document.querySelector("[data-menu=guide] [data-role=guide]")).not.toBeNull();
    expect(menus.nav.isOpenId("pause")).toBe(true); // pause stays in the stack: singleplayer pause holds
    expect(document.querySelector("#game-menubar [data-open=guide]")).toBeNull(); // not a menu-bar button
    menus.nav.close();
    expect(menus.nav.top).toBe("pause");
    expect(document.querySelector("[data-menu=guide]")).toBeNull();
    expect(document.querySelector("[data-menu=pause]")).not.toBeNull();
    menus.destroy();
  });
  test("the ✕ button and Esc both close the guide back to pause", () => {
    const menus = openMenus();
    menus.pause();
    menus.open("guide");
    expect(menus.nav.top).toBe("guide");
    document.querySelector<HTMLElement>("[data-menu=guide] [data-role=close]")!.click();
    expect(menus.nav.top).toBe("pause");
    menus.open("guide");
    press("Escape");
    expect(menus.nav.top).toBe("pause");
    expect(menus.nav.isOpenId("guide")).toBe(false);
    menus.destroy();
  });
  test("gamepad LB/RB cycles sections through the existing tab pattern", () => {
    const menus = openMenus();
    menus.open("guide");
    const sections = getGuideSections();
    expect(detailText(document)).toContain(sections[0]!.title);
    expect(cycleTabs(menus.nav, 1, "tab")).toBe(true);
    expect(detailText(document)).toContain(sections[1]!.title);
    expect(sectionButton(document, sections[1]!.id).getAttribute("aria-pressed")).toBe("true");
    expect(cycleTabs(menus.nav, -1, "tab")).toBe(true);
    expect(detailText(document)).toContain(sections[0]!.title);
    menus.destroy();
  });
});

describe("ADR-363 guide on the main menu", () => {
  let ui: BootUI | undefined;
  afterEach(() => { ui?.hide(); document.body.innerHTML = ""; });
  const openMenu = (): Promise<unknown> => {
    ui = new BootUI("/");
    return ui.menu({ hostedStatic: true, defaultUrl: "" });
  };
  const button = (text: string): HTMLButtonElement =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === text)!;
  test("Guide opens the guide; Back returns to the main menu without resolving a choice", async () => {
    const choice = openMenu();
    let resolved = false; void choice.then(() => { resolved = true; });
    expect(button("Guide")).not.toBeUndefined();
    button("Guide").click();
    const guide = document.querySelector("[data-role=guide]")!;
    expect(guide).not.toBeNull();
    expect(guide.querySelectorAll("[data-guide-section]")).toHaveLength(15);
    expect(document.activeElement).toBe(sectionButton(document, "getting-started")); // focus starts on the first section
    sectionButton(document, "diseases").click();
    expect(detailText(document)).toContain("Diseases");
    expect(detailText(document)).toContain(resolvedGuideSection("diseases")!.intro);
    button("Back").click();
    expect(document.querySelector("[data-role=guide]")).toBeNull();
    expect(button("Singleplayer")).not.toBeUndefined();
    expect(button("Guide")).not.toBeUndefined();
    expect(resolved).toBe(false);
    await Promise.resolve();
  });
  test("keyboard arrows move between sections; Esc goes back to the main menu", () => {
    openMenu();
    button("Guide").click();
    expect(document.activeElement).toBe(sectionButton(document, "getting-started"));
    press("ArrowDown");
    expect(document.activeElement).toBe(sectionButton(document, "controls"));
    press("ArrowUp");
    expect(document.activeElement).toBe(sectionButton(document, "getting-started"));
    press("Escape");
    expect(document.querySelector("[data-role=guide]")).toBeNull();
    expect(button("Singleplayer")).not.toBeUndefined();
  });
});
