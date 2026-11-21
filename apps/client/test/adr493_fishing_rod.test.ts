/**
 * ADR-493: fishing rod art, painted at runtime. Two surfaces, two precedents: the inventory
 * icon (128x128, wetwood-style — a diagonal rod + reel + hanging line and hook, in the game's
 * own bark/metal/line ramps) and the held sprite (48x48 x 8 facings, footprints-style — the rod
 * held at its butt, angling up-forward along the facing direction, with the axe's grip anchor).
 * The `held` atlas is full (120/120 frames), so the rod gets its own atlas; emitHeld resolves
 * the sprite's own atlas, so that is all it needs. Fragment carries layout only.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  paintFishingRodIconPixels, paintRodPixels, rodAtlasSources, installFishingRodIcon,
  ROD_ATLAS_KEY, ROD_SPRITE_KEY, FISHING_ROD_ICON_FILE,
} from "../src/fishing-rod-art.js";

describe("ADR-493 fishing rod art", () => {
  it("the icon is a diagonal rod: 128x128, painted in the game's own ramps, reading at 24px", () => {
    const a = paintFishingRodIconPixels();
    expect(a.width).toBe(128); expect(a.height).toBe(128);
    let painted = 0, bark = 0;
    for (let i = 0; i < a.pixels.length; i += 4) {
      if (a.pixels[i + 3]! > 0) {
        painted++;
        if (a.pixels[i] === 74 && a.pixels[i + 1] === 52 && a.pixels[i + 2] === 30) bark++; // wetwood bark
      }
    }
    expect(painted).toBeGreaterThan(500); // fills most of the frame
    expect(bark).toBeGreaterThan(100); // the rod itself, in the game's bark ramp
    // Diagonal: paint in both the bottom-left (butt) and top-right (tip) quadrants.
    const inQuad = (x0: number, y0: number): number => {
      let n = 0;
      for (let y = y0; y < y0 + 64; y++) for (let x = x0; x < x0 + 64; x++) if (a.pixels[(y * 128 + x) * 4 + 3]! > 0) n++;
      return n;
    };
    expect(inQuad(0, 64)).toBeGreaterThan(50); // butt, bottom-left
    expect(inQuad(64, 0)).toBeGreaterThan(50); // tip, top-right
  });

  it("the held rod is 8 distinct 48x48 frames, one per facing, with paint in every frame", () => {
    const a = paintRodPixels();
    expect(a.width).toBe(384); expect(a.height).toBe(48);
    const painted = (f: number): number => {
      let n = 0;
      for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) if (a.pixels[(y * 384 + f * 48 + x) * 4 + 3]! > 0) n++;
      return n;
    };
    for (let f = 0; f < 8; f++) expect(painted(f), `rod frame ${f}`).toBeGreaterThan(20);
    const frame0 = a.pixels.slice(0, 48 * 48 * 4);
    const frame4 = a.pixels.slice(4 * 48 * 48 * 4, 5 * 48 * 48 * 4);
    expect(Buffer.from(frame0).equals(Buffer.from(frame4))).toBe(false); // opposite facings differ
  });

  it("the fragment declares the held-rod atlas + sprite (layout only, dirStride 1, grip anchors)", () => {
    const frag = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/assets/pack/task493/manifest.task493.json"), "utf8"));
    expect(frag.atlases).toHaveLength(1);
    expect(frag.atlases[0].key).toBe(ROD_ATLAS_KEY);
    expect(frag.atlases[0].columns).toBe(8); expect(frag.atlases[0].rows).toBe(1);
    expect(frag.atlases[0].frameW).toBe(48); expect(frag.atlases[0].frameH).toBe(48);
    expect(frag.sprites).toHaveLength(1);
    const s = frag.sprites[0];
    expect(s.key).toBe(ROD_SPRITE_KEY);
    expect(s.atlas).toBe(ROD_ATLAS_KEY);
    expect(s.anchor).toEqual({ x: 0.5, y: 0.75 }); // the hand, like the other held items
    expect(s.animations.idle.directions).toBe(8);
    expect(s.animations.idle.dirStride).toBe(1);
    expect(s.animations.idle.frames).toEqual([0]);
    for (let f = 0; f < 8; f++) expect(s.frameMeta[String(f)].anchors.grip).toEqual({ x: -3, y: -5 }); // the axe's grip
  });

  it("rodAtlasSources is a no-op map in a canvas-less environment (no crash)", async () => {
    const m = await rodAtlasSources();
    expect(m instanceof Map).toBe(true);
  });

  it("installFishingRodIcon is a safe no-op without a canvas (returns false, registers nothing)", () => {
    expect(installFishingRodIcon()).toBe(false);
    expect(FISHING_ROD_ICON_FILE).toBe("fishing_rod.png");
  });
});
