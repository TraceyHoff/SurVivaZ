// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { fillBar, fillKey, fillLabel, fillLevel } from "../src/fill-bar.js";
import { hotbarCells, hotbarKey, mountHotbar } from "../src/hotbar.js";

const f = (sips: number, max: number, liquid = "water") => ({ sips, max, frac: sips / max, liquid });

describe("ADR-290 liquid fill bar", () => {
  it("levels: full / partial / low (near-empty) / empty", () => {
    expect(fillLevel(f(6, 6))).toBe("full"); expect(fillLevel(f(4, 6))).toBe("partial"); expect(fillLevel(f(1, 2))).toBe("partial");
    expect(fillLevel(f(2, 6))).toBe("low"); expect(fillLevel(f(1, 3))).toBe("low"); expect(fillLevel(f(1, 4))).toBe("low"); expect(fillLevel(f(0, 4))).toBe("empty");
    expect(fillLabel(f(0, 4))).toBe("empty"); expect(fillLabel(f(3, 6))).toBe("3/6 sips left");
  });
  it("bar width = remaining %, liquid + level hooks, empty keeps a visible track", () => {
    for (const [s, m, w] of [[6, 6, "100%"], [3, 6, "50%"], [1, 6, "17%"], [0, 6, "0%"]] as const) {
      const b = fillBar(document, f(s, m)); expect(b.className).toBe("lfill"); expect((b.firstElementChild as HTMLElement).style.width).toBe(w);
      expect(b.dataset["sips"]).toBe(String(s)); expect(b.dataset["max"]).toBe(String(m));
    }
    expect(fillBar(document, f(0, 2)).dataset["level"]).toBe("empty"); expect(fillBar(document, f(2, 4, "boiled_water")).dataset["liquid"]).toBe("boiled_water");
    expect(document.getElementById("lfill-css")).not.toBeNull(); expect(document.querySelectorAll("#lfill-css")).toHaveLength(1);
  });
  it("HUD hotbar draws the bar on liquid containers only and rebuilds when the fill changes", () => {
    let fill = f(6, 6); const view = () => [{ slot: 16, item: 1, icon: "canteen", name: "Canteen", count: 1, fill }, { slot: 17, item: 2, icon: "stone_axe", name: "Stone axe", count: 1 }];
    const k0 = hotbarKey(hotbarCells(view()), "kbm");
    const hb = mountHotbar({ view, equip: () => {}, device: () => "kbm" }); hb.update(true);
    const bar = (): HTMLElement | null => hb.el.querySelector("button[data-slot='16'] .lfill");
    expect(bar()!.dataset["level"]).toBe("full"); expect(hb.el.querySelector("button[data-slot='17'] .lfill")).toBeNull();
    expect(hb.el.querySelector("button[data-slot='16']")!.getAttribute("title")).toContain("6/6 sips left");
    fill = f(1, 6); expect(hotbarKey(hotbarCells(view()), "kbm")).not.toBe(k0); hb.update(true); expect(bar()!.dataset["level"]).toBe("low");
    fill = f(0, 6); hb.update(true); expect(bar()!.dataset["level"]).toBe("empty"); expect((bar()!.firstElementChild as HTMLElement).style.width).toBe("0%");
    expect(fillKey(undefined)).toBe(""); hb.destroy();
  });
});
