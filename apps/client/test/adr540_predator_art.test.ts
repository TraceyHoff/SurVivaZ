// @vitest-environment jsdom
// ADR-540: dedicated cougar + wolverine art — painted at runtime (apps/client/src/task540-art.ts),
// declared in the pack/task540 fragment. Verified numerically like Task 34 / ADR-421 (pixel
// checks, not eyeballs): two distinct non-empty atlases, anims and directions differ, the
// dark-plum outline is present, no cell bleeds into its neighbour, and the two species are
// separable by their own palette (tawny cougar vs dark wolverine with a pale saddle stripe).
// The merged-registry half (fragment sprites, frame math, parity) lives in the ADR-248 parity
// test. The user is the final visual check (no GL in the VM).
import { describe, expect, it } from "vitest";
import {
  paintQuadrupedCell, paintTask540Atlases, predatorFrame,
  COUGAR_SPEC, WOLVERINE_SPEC, TASK540_ATLAS_KEYS, TASK540_SPECIES,
  PREDATOR_ATLAS_COLS, PREDATOR_ATLAS_ROWS, PREDATOR_ROWS, PREDATOR_FRAMES,
} from "../src/task540-art.js";
import { Px } from "../src/task34-art.js";

/** "opaque:meanR:meanG:meanB" signature of one frame cell, plus outline- and species-pixel counts. */
function cellSig(atlas: { width: number; height: number; pixels: Uint8ClampedArray }, col: number, row: number, cell: number): { sig: string; opaque: number; outline: number; tawny: number; stripe: number } {
  const ox = col * cell, oy = row * cell;
  let opaque = 0, r = 0, g = 0, b = 0, outline = 0, tawny = 0, stripe = 0;
  for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
    const i = ((oy + y) * atlas.width + (ox + x)) * 4;
    const a = atlas.pixels[i + 3]!;
    if (a > 16) {
      opaque++; r += atlas.pixels[i]!; g += atlas.pixels[i + 1]!; b += atlas.pixels[i + 2]!;
      if (atlas.pixels[i] === 40 && atlas.pixels[i + 1] === 30 && atlas.pixels[i + 2] === 50) outline++;
      if (atlas.pixels[i] === 198 && atlas.pixels[i + 1] === 158 && atlas.pixels[i + 2] === 104) tawny++;
      if (atlas.pixels[i] === 214 && atlas.pixels[i + 1] === 196 && atlas.pixels[i + 2] === 160) stripe++;
    }
  }
  expect(opaque).toBeGreaterThan(40);
  return { sig: `${opaque}:${Math.round(r / opaque)}:${Math.round(g / opaque)}:${Math.round(b / opaque)}`, opaque, outline, tawny, stripe };
}
/** Cell (frame f, direction d) of animation `anim` in an atlas. */
const cell = (atlas: { width: number; height: number; pixels: Uint8ClampedArray }, spec: { cell: number }, anim: keyof typeof PREDATOR_ROWS, d: number, f: number) =>
  cellSig(atlas, f, PREDATOR_ROWS[anim] + d, spec.cell);

describe("ADR-540 task540 art", () => {
  it("paints two atlases (8 cols x 32 rows) with distinct non-empty cells; frame math matches the fragment", () => {
    expect(TASK540_ATLAS_KEYS).toEqual(["pred_cougar", "pred_wolverine"]);
    expect(TASK540_SPECIES).toEqual(["animal_cougar", "animal_wolverine"]);
    expect(PREDATOR_ATLAS_COLS).toBe(8); expect(PREDATOR_ATLAS_ROWS).toBe(32);
    expect(PREDATOR_FRAMES).toEqual({ idle: 4, walk: 4, attack: 2, death: 2 });
    expect(predatorFrame("idle", 0, 0)).toBe(0);
    expect(predatorFrame("idle", 1, 3)).toBe(11);
    expect(predatorFrame("walk", 0, 0)).toBe(64);
    expect(predatorFrame("attack", 0, 1)).toBe(129);
    expect(predatorFrame("death", 7, 1)).toBe(249);
    expect(COUGAR_SPEC.cell).toBe(56); expect(WOLVERINE_SPEC.cell).toBe(48);
    const atlases = paintTask540Atlases();
    expect(atlases.map((a) => a.key)).toEqual([...TASK540_ATLAS_KEYS]);
    expect(atlases[0]!.width).toBe(8 * 56); expect(atlases[0]!.height).toBe(32 * 56);
    expect(atlases[1]!.width).toBe(8 * 48); expect(atlases[1]!.height).toBe(32 * 48);
    const whole = new Set<string>();
    for (const a of atlases) {
      expect(a.width).toBeLessThanOrEqual(2048); expect(a.height).toBeLessThanOrEqual(2048); // mobile texture cap
      let opaque = 0, r = 0, g = 0, b = 0;
      for (let i = 0; i < a.pixels.length; i += 4) if (a.pixels[i + 3]! > 16) { opaque++; r += a.pixels[i]!; g += a.pixels[i + 1]!; b += a.pixels[i + 2]!; }
      const sig = `${opaque}:${Math.round(r / opaque)}:${Math.round(g / opaque)}:${Math.round(b / opaque)}`;
      expect(whole.has(sig)).toBe(false); whole.add(sig);
    }
    expect(whole.size).toBe(2);
  });

  it("anims and directions differ within each atlas, with the 1px dark outline", () => {
    const [cougar, wolverine] = paintTask540Atlases();
    for (const [a, spec] of [[cougar, COUGAR_SPEC], [wolverine, WOLVERINE_SPEC]] as const) {
      // Idle frames differ (bob + blink + tail wag); walk frames differ (leg cycle).
      const idle0 = cell(a, spec, "idle", 1, 0), idle2 = cell(a, spec, "idle", 1, 2);
      expect(idle0.sig).not.toBe(idle2.sig);
      expect(cell(a, spec, "walk", 1, 0).sig).not.toBe(cell(a, spec, "walk", 1, 2).sig);
      // Attack crouch vs lunge differ; death slump vs lying-flat differ.
      expect(cell(a, spec, "attack", 1, 0).sig).not.toBe(cell(a, spec, "attack", 1, 1).sig);
      expect(cell(a, spec, "death", 1, 0).sig).not.toBe(cell(a, spec, "death", 1, 1).sig);
      // Directions differ (SE vs SW, same anim + frame).
      expect(cell(a, spec, "idle", 1, 0).sig).not.toBe(cell(a, spec, "idle", 3, 0).sig);
      expect(cell(a, spec, "walk", 1, 1).sig).not.toBe(cell(a, spec, "walk", 5, 1).sig);
      // Every sampled cell carries the dark-plum outline.
      for (const c of [idle0, idle2]) expect(c.outline).toBeGreaterThan(0);
    }
  });

  it("the two species are separable by their own palette — no shared body colour", () => {
    const [cougar, wolverine] = paintTask540Atlases();
    // Cougar idle cells are tawny (R > G > B, warm); wolverine idle cells are dark.
    const c = cell(cougar, COUGAR_SPEC, "idle", 1, 0);
    const v = cell(wolverine, WOLVERINE_SPEC, "idle", 1, 0);
    expect(c.tawny).toBeGreaterThan(50); // cougar fur [198,158,104] paints the body
    expect(v.tawny).toBe(0); // no tawny pixel on the wolverine
    expect(v.stripe).toBeGreaterThan(0); // wolverine pale saddle stripe [214,196,160]
    expect(c.stripe).toBe(0); // the cougar has no pale stripe
    const [, cr, cg, cb] = c.sig.split(":").map(Number);
    const [, vr, vg, vb] = v.sig.split(":").map(Number);
    expect(cr!).toBeGreaterThan(vr!); // the cougar reads lighter than the wolverine
    expect(cr! > cg! && cg! > cb!).toBe(true); // warm tawny mean
  });

  it("no cell bleeds into its neighbour (the 1px cell border stays transparent)", () => {
    for (const [a, spec] of [[paintTask540Atlases()[0]!, COUGAR_SPEC], [paintTask540Atlases()[1]!, WOLVERINE_SPEC]] as const) {
      for (const anim of ["idle", "walk", "attack", "death"] as const) {
        for (let d = 0; d < 8; d++) {
          for (let f = 0; f < PREDATOR_FRAMES[anim]; f++) {
            const ox = f * spec.cell, oy = (PREDATOR_ROWS[anim] + d) * spec.cell;
            for (let x = 0; x < spec.cell; x++) {
              expect(a.pixels[((oy * a.width) + ox + x) * 4 + 3]).toBe(0);
              expect(a.pixels[(((oy + spec.cell - 1) * a.width) + ox + x) * 4 + 3]).toBe(0);
            }
            for (let y = 0; y < spec.cell; y++) {
              expect(a.pixels[(((oy + y) * a.width) + ox) * 4 + 3]).toBe(0);
              expect(a.pixels[(((oy + y) * a.width) + ox + spec.cell - 1) * 4 + 3]).toBe(0);
            }
          }
        }
      }
    }
  });

  it("paintQuadrupedCell draws the same cell standalone as inside the atlas", () => {
    const px = new Px(COUGAR_SPEC.cell, COUGAR_SPEC.cell);
    paintQuadrupedCell(px, 0, 0, 1, 0, "idle", COUGAR_SPEC);
    const solo = { width: px.w, height: px.h, pixels: px.data };
    const atlas = paintTask540Atlases()[0]!;
    expect(cellSig(solo, 0, 0, COUGAR_SPEC.cell).sig).toBe(cell(atlas, COUGAR_SPEC, "idle", 1, 0).sig);
  });
});
