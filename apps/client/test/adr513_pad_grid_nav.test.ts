// @vitest-environment jsdom
/**
 * ADR-513 (bug pass): D-pad navigation in grid modals. Geometry is the live inventory at 1280x720 (pack grid 8x2, hotbar
 * row, equipment panel to the right). Before: Down on Hotbar 8 wrapped in DOM order UP into the equipment panel (and looped
 * Main hand -> Hands -> Feet -> Hotbar 8 -> Main hand), and Up from the pack grid's right column jumped to "Back".
 */
import { beforeEach, describe, expect, test } from "vitest";
import { UINav, edgeWrap } from "../src/ui-nav.js";

type Box = [label: string, x: number, y: number, w: number, h: number];
const CELL = 45;
const boxes: Box[] = [["Close", 773, 89, 34, 34]];
for (let i = 0; i < 16; i++) boxes.push([`Slot ${i + 1}`, 220 + (i % 8) * 50, 191 + Math.floor(i / 8) * 48, CELL, CELL]);
for (let i = 0; i < 8; i++) boxes.push([`Hotbar ${i + 1}`, 220 + i * 50, 299, CELL, CELL]);
boxes.push(["Head", 688, 186, 57, 36], ["Accessory", 749, 186, 57, 36], ["Back", 625, 226, 57, 36], ["Main hand", 749, 226, 57, 36],
  ["Off hand", 625, 264, 57, 36], ["Hands", 749, 264, 57, 36], ["Body", 625, 302, 57, 36], ["Legs", 688, 302, 57, 36], ["Feet", 749, 302, 57, 36]);

let nav: UINav;
beforeEach(() => {
  document.body.innerHTML = "";
  const el = document.createElement("div");
  for (const [label, x, y, w, h] of boxes) {
    const b = document.createElement("button"); b.textContent = label; if (label === "Close") b.dataset["role"] = "close";
    b.getBoundingClientRect = () => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, x, y, toJSON: () => ({}) }) as DOMRect;
    el.append(b);
  }
  nav = new UINav({ root: document.body, pollGamepads: false } as unknown as ConstructorParameters<typeof UINav>[0]);
  nav.open("inventory", el);
});
const focus = (label: string): void => { [...document.querySelectorAll("button")].find((b) => b.textContent === label)!.focus(); };
const at = (): string => document.activeElement?.textContent ?? "";
const press = (d: "up" | "down" | "left" | "right"): string => { nav.move(d); return at(); };

describe("ADR-513 pad grid navigation", () => {
  test("Up from the pack grid's right column stays in the column (was: jumped to Back)", () => {
    focus("Slot 16"); expect(press("up")).toBe("Slot 8");
  });
  test("Left from Head goes toward the pack, not down to Back", () => {
    focus("Head"); expect(press("left")).toBe("Slot 8");
  });
  test("Down at the bottom of a column wraps to its top, never up into another panel", () => {
    focus("Hotbar 8"); expect(press("down")).toBe("Slot 8");
    focus("Hotbar 1"); expect(press("down")).toBe("Slot 1");
    focus("Feet"); expect(press("down")).toBe("Close"); // the top of its column (Close sits above Accessory)
  });
  test("every pack slot is reachable from the equipment panel with D-pad only", () => {
    focus("Back"); const seen = new Set<string>();
    for (const d of ["left", "up", "left", "left", "left", "left", "left", "left", "left", "down", "right", "right", "right", "right", "right", "right", "right"] as const) seen.add(press(d));
    for (let i = 1; i <= 16; i++) expect(seen.has(`Slot ${i}`)).toBe(true);
  });
  test("edgeWrap: a lone control in its column has nowhere to wrap to", () => {
    const r = (l: number, t: number) => ({ left: l, top: t, right: l + 10, bottom: t + 10 });
    expect(edgeWrap([r(0, 0), r(0, 20), r(0, 40)], 2, "down")).toBe(0);
    expect(edgeWrap([r(0, 0), r(50, 20)], 0, "down")).toBeUndefined();
  });
});
