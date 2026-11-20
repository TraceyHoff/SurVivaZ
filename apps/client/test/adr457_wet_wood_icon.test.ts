// @vitest-environment jsdom
// ADR-457: wet firewood — wood gathered in the rain is wet wood (burns 10 s, not 20 s), with its own
// runtime-painted icon (a wet pine log, not a tinted dry log). The painter draws real pixels, installs
// into ICON_DATA + a [data-icon] rule, and the inventory / hotbar / toast / crafting icons render it.
import { describe, expect, test } from "vitest";
import { ICON_DATA } from "../src/game-icons-data.js";
import { WET_WOOD_ICON_FILE, wetWoodIconDataUrl, installWetWoodIcon, paintWetWoodPixels } from "../src/wetwood-art.js";

const TEST_URL = "data:image/png;base64,ADR457TEST";

const pxAt = (pixels: Uint8ClampedArray, x: number, y: number): readonly [number, number, number, number] => {
  const i = (y * 128 + x) * 4;
  return [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!, pixels[i + 3]!];
};

describe("ADR-457 the wet-wood icon (wetwood-art.ts)", () => {
  test("the painter draws a wet log: dark bark, pale sawn end with rings, droplets, drip, shadow", () => {
    const { width, height, pixels } = paintWetWoodPixels();
    expect(width).toBe(128); expect(height).toBe(128);
    expect(pxAt(pixels, 64, 60)).toEqual([74, 52, 30, 255]); // dark wet bark
    expect(pxAt(pixels, 64, 51)).toEqual([98, 70, 40, 255]); // wet sheen along the top
    expect(pxAt(pixels, 60, 66)).toEqual([50, 34, 19, 255]); // bark ridge
    expect(pxAt(pixels, 24, 66)).toEqual([50, 34, 19, 255]); // rounded bark cap (left end)
    expect(pxAt(pixels, 104, 66)).toEqual([198, 166, 112, 255]); // pale sawn end
    expect(pxAt(pixels, 100, 66)).toEqual([150, 118, 72, 255]); // growth ring
    expect(pxAt(pixels, 96, 66)).toEqual([50, 34, 19, 255]); // ring centre
    expect(pxAt(pixels, 64, 79)).toEqual([42, 28, 16, 255]); // soaked band along the bottom
    expect(pxAt(pixels, 58, 44)).toEqual([150, 200, 235, 255]); // rain droplet on top
    expect(pxAt(pixels, 57, 43)).toEqual([235, 245, 255, 255]); // droplet highlight
    expect(pxAt(pixels, 66, 93)).toEqual([150, 200, 235, 255]); // drip falling off
    expect(pxAt(pixels, 64, 104)).toEqual([0, 0, 0, 70]); // ground shadow
    expect(pxAt(pixels, 10, 10)).toEqual([0, 0, 0, 0]); // transparent corner
  });

  test("install is a safe no-op without a canvas and registers the icon with the test seam", () => {
    document.body.innerHTML = "";
    expect(wetWoodIconDataUrl(document)).toBeUndefined(); // jsdom has no 2d canvas
    expect(installWetWoodIcon(document)).toBe(false);
    expect(ICON_DATA[WET_WOOD_ICON_FILE]).toBeUndefined();
    expect(installWetWoodIcon(document, new Map([[WET_WOOD_ICON_FILE, TEST_URL]]))).toBe(true);
    expect(ICON_DATA[WET_WOOD_ICON_FILE]).toBe(TEST_URL);
    const style = document.getElementById("wetwood-icons");
    expect(style?.textContent).toContain("[data-icon=\"wet_wood\"]");
    expect(style?.textContent).toContain(TEST_URL);
    // idempotent: a second install replaces the rule, it does not duplicate the style element
    expect(installWetWoodIcon(document, new Map([[WET_WOOD_ICON_FILE, TEST_URL]]))).toBe(true);
    expect(document.querySelectorAll("#wetwood-icons")).toHaveLength(1);
  });
});
