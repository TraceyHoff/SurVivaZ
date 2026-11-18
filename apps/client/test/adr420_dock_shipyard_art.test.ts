// @vitest-environment jsdom
// ADR-420: dedicated dock / shipyard art — painted at runtime (apps/client/src/task420-art.ts).
// Verified numerically like Task 34 / ADR-356 (pixel checks, not eyeballs): two distinct non-empty
// atlases, front vs side and damage stages differ, the dark-plum outline is present, the menu icons
// are non-blank and pixel-identical to the intact front cell, and the installer writes one style
// element. The pack/task420 fragment + view.ts hook landed with ADR-421, so the merged-registry
// resolution is asserted in apps/client/test/adr421_boats_art.test.ts — the user is the final
// visual check (no GL in the VM).
import { describe, expect, it } from "vitest";
import {
  installTask420MenuIcons, paintTask420Atlases, paintTask420MenuIconPixels, task420Frame,
  TASK420_ATLAS_KEYS, TASK420_MENU_ICON_KEYS,
} from "../src/task420-art.js";

/** Extract one 128px cell's pixels (row-major) from a painted atlas. */
function cellPixels(atlas: { width: number; pixels: Uint8ClampedArray }, col: number, row: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(128 * 128 * 4);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const src = (((row * 128 + y) * atlas.width) + col * 128 + x) * 4;
    const dst = (y * 128 + x) * 4;
    out[dst] = atlas.pixels[src]!; out[dst + 1] = atlas.pixels[src + 1]!; out[dst + 2] = atlas.pixels[src + 2]!; out[dst + 3] = atlas.pixels[src + 3]!;
  }
  return out;
}
function cellSig(atlas: { width: number; pixels: Uint8ClampedArray }, col: number, row: number): { sig: string; opaque: number; outline: number } {
  const ox = col * 128, oy = row * 128;
  let opaque = 0, r = 0, g = 0, b = 0, outline = 0;
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const i = ((oy + y) * atlas.width + (ox + x)) * 4;
    const a = atlas.pixels[i + 3]!;
    if (a > 16) {
      opaque++; r += atlas.pixels[i]!; g += atlas.pixels[i + 1]!; b += atlas.pixels[i + 2]!;
      if (atlas.pixels[i] === 40 && atlas.pixels[i + 1] === 30 && atlas.pixels[i + 2] === 50) outline++;
    }
  }
  expect(opaque).toBeGreaterThan(40);
  return { sig: `${opaque}:${Math.round(r / opaque)}:${Math.round(g / opaque)}:${Math.round(b / opaque)}`, opaque, outline };
}

describe("ADR-420 task420 art", () => {
  it("paints two 512x256 atlases with distinct non-empty cells", () => {
    expect(TASK420_ATLAS_KEYS).toEqual(["decor_dock", "decor_shipyard"]);
    expect(task420Frame(0, 0)).toBe(0); expect(task420Frame(0, 3)).toBe(3);
    expect(task420Frame(1, 0)).toBe(4); expect(task420Frame(1, 3)).toBe(7);
    const atlases = paintTask420Atlases();
    expect(atlases.map((a) => a.key)).toEqual([...TASK420_ATLAS_KEYS]);
    const whole = new Set<string>();
    for (const a of atlases) {
      expect(a.width).toBe(512); expect(a.height).toBe(256);
      let opaque = 0, r = 0, g = 0, b = 0;
      for (let i = 0; i < a.pixels.length; i += 4) if (a.pixels[i + 3]! > 16) { opaque++; r += a.pixels[i]!; g += a.pixels[i + 1]!; b += a.pixels[i + 2]!; }
      const sig = `${opaque}:${Math.round(r / opaque)}:${Math.round(g / opaque)}:${Math.round(b / opaque)}`;
      expect(whole.has(sig)).toBe(false); whole.add(sig);
    }
    expect(whole.size).toBe(2);
  });

  it("front vs side and damage stages differ, with the 1px dark outline; the shipyard holds more pixels than the dock", () => {
    const [dock, yard] = paintTask420Atlases();
    for (const a of [dock!, yard!]) {
      expect(cellSig(a, 0, 0).sig).not.toBe(cellSig(a, 0, 1).sig); // rotation 1 is the narrower side view
      expect(cellSig(a, 0, 0).sig).not.toBe(cellSig(a, 3, 0).sig); // damage stage 3 differs
      expect(cellSig(a, 0, 0).outline).toBeGreaterThan(0);
    }
    // The shipyard is the taller roofed silhouette; the dock is the low open jetty.
    expect(cellSig(yard!, 0, 0).opaque).toBeGreaterThan(cellSig(dock!, 0, 0).opaque);
    expect(cellSig(dock!, 0, 0).sig).not.toBe(cellSig(yard!, 0, 0).sig);
  });

  it("menu icons are non-blank and pixel-identical to the intact front cell", () => {
    const [dock, yard] = paintTask420Atlases();
    for (const [key, atlas] of [["dock", dock!], ["shipyard", yard!]] as const) {
      const icon = paintTask420MenuIconPixels(key);
      expect(icon.width).toBe(128); expect(icon.height).toBe(128);
      let opaque = 0;
      for (let i = 3; i < icon.pixels.length; i += 4) if (icon.pixels[i]! > 16) opaque++;
      expect(opaque).toBeGreaterThan(40);
      expect(icon.pixels).toEqual(cellPixels(atlas, 0, 0)); // the intact front cell of the atlas
    }
    expect(TASK420_MENU_ICON_KEYS).toEqual(["dock", "shipyard"]);
  });

  it("installTask420MenuIcons writes one idempotent style element from supplied URLs", () => {
    const urls = new Map([["dock", "data:image/png;base64,dock"], ["shipyard", "data:image/png;base64,yard"]]);
    expect(installTask420MenuIcons(document, urls)).toBe(true);
    expect(installTask420MenuIcons(document, urls)).toBe(true);
    expect(document.querySelectorAll("#task420-menu-icons").length).toBe(1);
    const style = document.getElementById("task420-menu-icons") as HTMLStyleElement;
    expect(style.textContent).toContain("[data-icon=\"build_dock\"]");
    expect(style.textContent).toContain("[data-icon=\"build_shipyard\"]");
  });
});
