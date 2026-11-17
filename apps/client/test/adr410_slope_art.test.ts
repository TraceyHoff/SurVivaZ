// ADR-410: sloped-ground tilesets — painted at runtime (apps/client/src/task410-art.ts), declared in the
// pack/task410 fragment. Verified numerically like Task 34 / ADR-356 (pixel checks, not eyeballs): every
// slope key resolves from the merged registry, every painted cell is non-blank with the material's
// palette, ramp shading follows the downhill direction and wedge shading follows the low corner
// (brightness ordering, not just non-blank), and flat ground art is untouched.
import { describe, expect, it } from "vitest";
import { loadMergedPackManifest } from "@engine/assets/node";
import { GROUND_PRIORITY, GroundArt, groundSlopeKey, type GroundMaterial } from "@engine/render";
import {
  TASK410_ATLAS_KEYS, TASK410_COLUMNS, TASK410_ROWS, TASK410_CELL_W, TASK410_CELL_H,
  downsampleTask410Atlas, paintTask410Atlases, slopeLight, task410Frame, task410Key, task410Shape,
  type PaintedAtlas,
} from "../src/task410-art.js";

const SEASONS = [0, 1, 2, 3] as const;
/** Cell pixels at 2x: opaque count, mean colour, distinct colours, and mean brightness per uv region. */
function cellStats(a: PaintedAtlas, frame: number, scale = 2): {
  opaque: number; mean: [number, number, number]; distinct: number;
  corners: [number, number, number, number];
  bright: (t: (u: number, v: number) => number) => { lo: number; hi: number };
} {
  const cw = TASK410_CELL_W * scale, ch = TASK410_CELL_H * scale;
  const col = frame % TASK410_COLUMNS, row = Math.floor(frame / TASK410_COLUMNS);
  const ox = col * cw, oy = row * ch;
  let opaque = 0, r = 0, g = 0, b = 0;
  const colors = new Set<number>();
  const samples: { u: number; v: number; lum: number }[] = [];
  // Mean luminance near each diamond corner (top/right/bottom/left) — the shape signal: a ramp's
  // downhill corners are dark, a wedge's low corner is darkest, the opposite corner brightest.
  const cornerXY: readonly (readonly [number, number])[] = [
    [34 * scale, 2 * scale], [66 * scale, 18 * scale], [34 * scale, 34 * scale], [2 * scale, 18 * scale],
  ];
  const cornerSum = [0, 0, 0, 0], cornerN = [0, 0, 0, 0];
  const cr = 4 * scale;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const i = ((oy + y) * a.width + (ox + x)) * 4;
    if (a.pixels[i + 3]! <= 16) continue;
    opaque++; r += a.pixels[i]!; g += a.pixels[i + 1]!; b += a.pixels[i + 2]!;
    colors.add((a.pixels[i]! << 16) | (a.pixels[i + 1]! << 8) | a.pixels[i + 2]!);
    const lum = (a.pixels[i]! + a.pixels[i + 1]! + a.pixels[i + 2]!) / 3;
    for (let c = 0; c < 4; c++) {
      const [cx, cy] = cornerXY[c]!;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= cr * cr) { cornerSum[c]! += lum; cornerN[c]!++; }
    }
    const sx = x / scale - 34, sy = y / scale - 18;
    if (Math.abs(sx) / 32 + Math.abs(sy) / 16 > 1.02) continue;
    const u = (sx / 32 + sy / 16) / 2 + 0.5, v = (sy / 16 - sx / 32) / 2 + 0.5;
    samples.push({ u, v, lum });
  }
  expect(opaque).toBeGreaterThan(0);
  return {
    opaque,
    mean: [Math.round(r / opaque), Math.round(g / opaque), Math.round(b / opaque)],
    distinct: colors.size,
    corners: cornerSum.map((s, i) => Math.round(s / Math.max(1, cornerN[i]!))) as [number, number, number, number],
    bright: (t) => {
      let lo = 0, loN = 0, hi = 0, hiN = 0;
      for (const s of samples) {
        const tv = t(s.u, s.v);
        if (tv < 1 / 3) { lo += s.lum; loN++; } else if (tv > 2 / 3) { hi += s.lum; hiN++; }
      }
      return { lo: lo / loN, hi: hi / hiN };
    },
  };
}
/** "opaque:meanR:meanG:meanB:distinct:cornerT:cornerR:cornerB:cornerL" signature of one cell. */
const sig = (a: PaintedAtlas, frame: number): string => {
  const s = cellStats(a, frame);
  return `${s.opaque}:${s.mean[0]}:${s.mean[1]}:${s.mean[2]}:${s.distinct}:${s.corners.join(":")}`;
};

describe("ADR-410 slope tilesets", () => {
  it("layout: 4 season atlases, frame = material*8 + shape, keys match the ADR-409 contract", () => {
    expect(TASK410_ATLAS_KEYS).toEqual(["gt_slope_summer", "gt_slope_fall", "gt_slope_winter", "gt_slope_spring"]);
    expect(TASK410_COLUMNS).toBe(15); expect(TASK410_ROWS).toBe(4);
    expect(task410Frame(0, 0)).toBe(0); expect(task410Frame(0, 7)).toBe(7);
    expect(task410Frame(5, 0)).toBe(40); expect(task410Frame(6, 7)).toBe(55);
    expect(task410Shape("ramp", 2)).toBe(2); expect(task410Shape("wedge", 3)).toBe(7);
    for (const [mi, mat] of GROUND_PRIORITY.entries()) {
      for (const s of SEASONS) for (const kind of ["ramp", "wedge"] as const) for (let d = 0; d < 4; d++) {
        expect(task410Key(mat, s, kind, d)).toBe(groundSlopeKey(mat, s, kind, d));
        expect(task410Frame(mi, task410Shape(kind, d))).toBeLessThan(56);
      }
    }
  });

  it("paints four 2040x416 atlases; every one of the 56 cells per season is non-blank, in-palette, cel", () => {
    const atlases = paintTask410Atlases();
    expect(atlases.map((a) => a.key)).toEqual([...TASK410_ATLAS_KEYS]);
    // Material mid tones (t1) per season — the cell mean must sit near its own material's palette.
    const T1: Record<GroundMaterial, readonly (readonly [number, number, number])[]> = {
      rock: [[184, 178, 176], [180, 172, 168], [173, 178, 194], [176, 176, 168]],
      sand: [[246, 223, 164], [238, 219, 158], [226, 216, 192], [234, 218, 166]],
      dirt: [[201, 148, 100], [188, 134, 88], [166, 138, 118], [168, 126, 96]],
      mud: [[140, 100, 72], [134, 94, 68], [128, 105, 92], [114, 90, 80]],
      forest: [[95, 156, 74], [201, 130, 68], [234, 241, 250], [166, 212, 94]],
      grass: [[143, 209, 92], [198, 194, 87], [169, 194, 154], [202, 231, 108]],
      snow: [[238, 244, 251], [238, 244, 251], [242, 247, 253], [220, 220, 214]],
    };
    for (const a of atlases) {
      expect(a.width).toBe(2040); expect(a.height).toBe(416);
      const season = TASK410_ATLAS_KEYS.indexOf(a.key as (typeof TASK410_ATLAS_KEYS)[number]);
      for (let mi = 0; mi < GROUND_PRIORITY.length; mi++) {
        const mat = GROUND_PRIORITY[mi]!;
        for (let shape = 0; shape < 8; shape++) {
          const s = cellStats(a, task410Frame(mi, shape));
          expect(s.opaque, `${a.key} ${mat} shape ${shape} opaque`).toBeGreaterThan(4000); // diamond at 2x
          expect(s.distinct, `${a.key} ${mat} shape ${shape} distinct`).toBeLessThan(320); // cel bands, not an airbrush gradient
          const [tr, tg, tb] = T1[mat]![season]!;
          expect(Math.abs(s.mean[0] - tr), `${a.key} ${mat} mean R`).toBeLessThan(45);
          expect(Math.abs(s.mean[1] - tg), `${a.key} ${mat} mean G`).toBeLessThan(45);
          expect(Math.abs(s.mean[2] - tb), `${a.key} ${mat} mean B`).toBeLessThan(45);
        }
        // The 4 unused grid slots stay transparent (no paint outside the 56 frames).
        for (const frame of [56, 57, 58, 59]) {
          const cw = TASK410_CELL_W * 2, ch = TASK410_CELL_H * 2;
          const col = frame % TASK410_COLUMNS, row = Math.floor(frame / TASK410_COLUMNS);
          let opaque = 0;
          for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++)
            if (a.pixels[((row * ch + y) * a.width + (col * cw + x)) * 4 + 3]! > 16) opaque++;
          expect(opaque, `${a.key} unused frame ${frame}`).toBe(0);
        }
      }
    }
  });

  it("the 8 shapes of a tile differ; ramp shading follows the downhill axis, wedge shading the low corner", () => {
    const [summer] = paintTask410Atlases();
    for (let mi = 0; mi < GROUND_PRIORITY.length; mi++) {
      const mat = GROUND_PRIORITY[mi]!;
      const sigs = new Set<string>();
      for (let shape = 0; shape < 8; shape++) sigs.add(sig(summer!, task410Frame(mi, shape)));
      expect(sigs.size, `${mat} shapes differ`).toBe(8);
      // Opposite ramp dirs are not mirrors of each other in brightness (the light flips, the field does not).
      expect(sig(summer!, task410Frame(mi, 0))).not.toBe(sig(summer!, task410Frame(mi, 2)));
      for (let d = 0; d < 4; d++) {
        const s = cellStats(summer!, task410Frame(mi, d));
        const t = (u: number, v: number): number => [u, v, 1 - u, 1 - v][d]!;
        const { lo, hi } = s.bright(t);
        expect(hi, `${mat} ramp ${d} downhill darker`).toBeLessThan(lo * 0.93);
      }
      for (let c = 0; c < 4; c++) {
        const s = cellStats(summer!, task410Frame(mi, 4 + c));
        const t = (u: number, v: number): number => {
          const a = c === 0 ? 1 - u : c === 1 ? u : c === 2 ? u : 1 - u;
          const b = c === 0 ? 1 - v : c === 1 ? 1 - v : c === 2 ? v : v;
          return (a + b) / 2;
        };
        const { lo, hi } = s.bright(t);
        expect(hi, `${mat} wedge ${c} low corner darker`).toBeLessThan(lo * 0.93);
      }
    }
    // slopeLight itself: uphill bright, downhill dark, wedge corners agree with the ramp axes.
    expect(slopeLight("ramp", 0, 0.1, 0.5)).toBeGreaterThan(1.05);
    expect(slopeLight("ramp", 0, 0.9, 0.5)).toBeLessThan(0.9);
    expect(slopeLight("wedge", 2, 0.05, 0.05)).toBeGreaterThan(1.1);
    expect(slopeLight("wedge", 2, 1, 1)).toBeLessThan(0.8);
  });

  it("seasons and materials differ; the 1x downsample keeps every cell non-blank and cel", () => {
    const atlases = paintTask410Atlases();
    const [summer, fall, winter, spring] = atlases as [PaintedAtlas, PaintedAtlas, PaintedAtlas, PaintedAtlas];
    for (let mi = 0; mi < GROUND_PRIORITY.length; mi++) {
      const g = task410Frame(mi, 0);
      expect(sig(summer!, g)).not.toBe(sig(winter!, g));
      expect(sig(summer!, g)).not.toBe(sig(fall!, g));
      expect(sig(summer!, g)).not.toBe(sig(spring!, g));
      expect(sig(summer!, task410Frame(mi, 0))).not.toBe(sig(summer!, task410Frame((mi + 1) % 7, 0)));
    }
    for (const a of atlases) {
      const lo = downsampleTask410Atlas(a);
      expect(lo.width).toBe(1020); expect(lo.height).toBe(208);
      for (let mi = 0; mi < GROUND_PRIORITY.length; mi++) for (let shape = 0; shape < 8; shape++) {
        const s = cellStats(lo, task410Frame(mi, shape), 1);
        expect(s.opaque, `${lo.key} 1x ${mi}/${shape} opaque`).toBeGreaterThan(1000);
        expect(s.distinct, `${lo.key} 1x ${mi}/${shape} distinct`).toBeLessThan(210);
      }
    }
  });

  it("the merged registry resolves every slope key; flat ground art is untouched", async () => {
    const { result, collisions } = await loadMergedPackManifest();
    expect(collisions.filter((c) => c.key.includes("_slope_"))).toEqual([]);
    expect(result.warnings).toEqual([]);
    for (const key of TASK410_ATLAS_KEYS) expect(result.registry.atlases.has(key), key).toBe(true);
    const g = new GroundArt(result.registry as unknown as {
      ids: { sprites: { tryId(k: string): number | undefined } };
      sprite(id: number): { key: string; atlas: { key: string } };
    });
    expect(g.available).toBe(true);
    for (const mat of GROUND_PRIORITY) for (const s of SEASONS) for (const kind of ["ramp", "wedge"] as const) for (let d = 0; d < 4; d++) {
      const key = groundSlopeKey(mat, s, kind, d);
      const id = g.id(key);
      expect(id, key).toBeGreaterThanOrEqual(0);
      expect(result.registry.sprite(id).atlas.key, key).toBe(TASK410_ATLAS_KEYS[s]!);
      expect(result.registry.sprite(id).key, key).toBe(key);
    }
    // The season's slope atlas is pinned in pageSprites (stream keep-alive), like the flat gt pages.
    for (const s of SEASONS) {
      const pages = g.pageSprites(s).map((id) => result.registry.sprite(id).atlas.key);
      expect(pages).toContain(TASK410_ATLAS_KEYS[s]!);
    }
    // Flat bases still resolve to the flat atlases, not the slope atlases.
    expect(result.registry.sprite(g.id("gt_grass")).atlas.key).toBe("gt_summer_p0");
    expect(result.registry.sprite(g.id("gt_grass_fall")).atlas.key).toBe("gt_fall_p0");
    expect(result.registry.sprite(g.id("gt_dirt_winter")).atlas.key).toBe("gt_winter_p0");
    expect(result.registry.sprite(g.id("gt_snow_spring")).atlas.key).toBe("gt_spring_p0");
  });
});
