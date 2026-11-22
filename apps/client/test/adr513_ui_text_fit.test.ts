// @vitest-environment jsdom
/**
 * ADR-513 (bug pass): text cut off / covered on the Galaxy A16 (412 px portrait). Found in the menu sweep
 * (/workspace/share/bug_pass/menus): build tile costs ended in "…" ("8 Pine Plank…"), recipe names were clamped
 * ("Rope (plant…"), the selected ✓ badge sat on the label ("×1", "Screen shake: On") and the HUD weather read "Cle…".
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { World } from "@engine/core";
import { mountHud } from "../src/hud.js";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/gameplay-panels.css"), "utf8");
const rule = (sel: string): string => { const i = css.indexOf(`${sel}{`); expect(i, sel).toBeGreaterThanOrEqual(0); return css.slice(i + sel.length + 1, css.indexOf("}", i)); };

describe("ADR-513 menu text is never cut off", () => {
  test("build tiles: name and cost wrap, the tile grows (no ellipsis, no clamp, no fixed height)", () => {
    const ct = rule(".gm-modal .gm-panel [data-role=piece-grid] button .ct"), nm = rule(".gm-modal .gm-panel [data-role=piece-grid] button .nm");
    expect(ct).not.toMatch(/ellipsis|nowrap/); expect(nm).not.toMatch(/line-clamp/);
    const tile = rule(".gm-modal .gm-panel [data-role=body] [data-role=piece-grid] button[data-role=piece]");
    expect(tile).toMatch(/height:auto;min-height:102px/);
  });
  test("recipe tiles: the whole name shows", () => {
    expect(rule(".gm-modal .gm-panel [data-role=recipe-grid] button .nm")).not.toMatch(/line-clamp/);
    expect(rule(".gm-modal .gm-panel [data-role=body] [data-role=recipe-grid] button[data-role=recipe]")).toMatch(/height:auto;min-height:86px/);
  });
  test("the ✓ badge sits on the gold frame's corner, outside the label; segmented ×1/×5/×10 shows selection by colour only", () => {
    const badge = rule(".gm-modal .gm-panel [data-role=body] button[aria-pressed=true]::after");
    const top = Number(/top:(-?\d+)px/.exec(badge)![1]), right = Number(/right:(-?\d+)px/.exec(badge)![1]), w = Number(/width:(\d+)px/.exec(badge)![1]);
    // pressed frame: border 14 px top / 16 px right, padding 4 px; the badge is placed from the padding box
    expect(w + right).toBeLessThanOrEqual(4); // its left edge stays in the frame + padding, clear of the text box
    expect(top).toBeLessThanOrEqual(-14);
    expect(css).toMatch(/\[data-role=craft-counts\]\) button\[aria-pressed=true\]::after\{display:none\}/);
  });
});

describe("ADR-513 HUD weather label", () => {
  let h: { destroy(): void } | undefined;
  afterEach(() => { h?.destroy(); h = undefined; document.head.innerHTML = ""; document.body.innerHTML = ""; });
  test("the clock row wraps the weather onto its own line instead of cutting it to 'Cle…'", () => {
    h = mountHud(() => new World(), () => undefined, { hours: 6, weather: 0 });
    const s = Array.from(document.querySelectorAll("style")).map((x) => x.textContent).join("\n");
    expect(s).toMatch(/#hud \.clock\{display:flex;flex-wrap:wrap;/);
    expect(s).toMatch(/\[data-hud=weather\]\{[^}]*margin-left:auto/);
  });
});
