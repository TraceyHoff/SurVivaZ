// @vitest-environment jsdom
// ADR-282: one temperature format helper renders the same Celsius value in the player's unit everywhere; no player-facing
// copy hardcodes a unit. ADR-284: the 12-hour AM/PM world clock.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { formatBodyTemp, formatTemp, formatTempDelta, loadTempUnit, localizeTemps, saveTempUnit, TEMP_UNIT_EVENT } from "../src/hud-temp.js";
import { formatClock12 } from "../src/clock-format.js";
import { TIPS } from "../src/tips.js";
import { tempUnitControl } from "../src/menu.js";

beforeEach(() => { localStorage.clear(); });
describe("ADR-282 temperature units", () => {
  test("same Celsius value -> Fahrenheit or Celsius in every helper", () => {
    expect(formatTemp(0, "F")).toBe("32°F"); expect(formatTemp(0, "C")).toBe("0°C");
    expect(formatTemp(-20, "F")).toBe("−4°F"); expect(formatTemp(-20, "C")).toBe("−20°C");
    expect(formatBodyTemp(37, "F")).toBe("98.6°F"); expect(formatBodyTemp(37, "C")).toBe("37.0°C");
    expect(formatBodyTemp(35, "F")).toBe("95.0°F"); expect(formatBodyTemp(39, "F")).toBe("102.2°F");
    expect(formatTempDelta(2.5, "F")).toBe("4.5°F"); expect(formatTempDelta(2.5, "C")).toBe("2.5°C"); // a difference: no +32
    expect(localizeTemps("{temp:8}–{temp:32}", "F")).toBe("46°F–90°F"); expect(localizeTemps("{temp:8}–{temp:32}", "C")).toBe("8°C–32°C");
  });
  test("tips carry tokens, not a hardcoded unit, and render in both units", () => {
    for (const t of TIPS) expect(t).not.toMatch(/°[CF]/);
    const tip = TIPS.find((t) => t.includes("{temp:"))!; expect(localizeTemps(tip, "F")).toContain("°F"); expect(localizeTemps(tip, "C")).toContain("°C");
  });
  test("client UI sources never hardcode °C/°F next to a number (everything goes through hud-temp)", () => {
    const dir = join(__dirname, "../src"); const bad: string[] = [];
    const walk = (d: string): void => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.ts$/.test(f) && !p.endsWith("hud-temp.ts")) {
      readFileSync(p, "utf8").split("\n").forEach((l, i) => { const code = l.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, ""); if (/(\d|\})°[CF]/.test(code)) bad.push(`${f}:${i + 1}`); }); } } };
    walk(dir); expect(bad).toEqual([]);
  });
  test("toggling the setting saves at once and notifies open screens (display only)", () => {
    let got = ""; addEventListener(TEMP_UNIT_EVENT, (e) => { got = String((e as CustomEvent).detail); });
    const c = tempUnitControl(undefined); document.body.append(c.el);
    (c.el.querySelector('[data-unit="C"]') as HTMLButtonElement).click(); expect(loadTempUnit()).toBe("C"); expect(got).toBe("C");
    (c.el.querySelector('[data-unit="F"]') as HTMLButtonElement).click(); expect(loadTempUnit()).toBe("F"); expect(got).toBe("F");
    saveTempUnit("C"); expect(loadTempUnit()).toBe("C");
  });
});
describe("ADR-284 AM/PM clock", () => {
  test("midnight, noon and typical hours", () => {
    expect(formatClock12(0)).toBe("12:00 AM"); expect(formatClock12(24)).toBe("12:00 AM"); expect(formatClock12(0.5)).toBe("12:30 AM");
    expect(formatClock12(12)).toBe("12:00 PM"); expect(formatClock12(12.75)).toBe("12:45 PM");
    expect(formatClock12(6.5)).toBe("6:30 AM"); expect(formatClock12(11 + 59 / 60)).toBe("11:59 AM");
    expect(formatClock12(18.75)).toBe("6:45 PM"); expect(formatClock12(23 + 59.9 / 60)).toBe("11:59 PM"); expect(formatClock12(13)).toBe("1:00 PM");
    for (let h = 0; h < 24; h += 0.25) expect(formatClock12(h)).not.toMatch(/^0:|24:|^00/);
  });
});
