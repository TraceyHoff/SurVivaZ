// ADR-356: dedicated store art — painted at runtime (apps/client/src/task355-art.ts), declared in the
// pack/task355 fragment, fill states wired through building.states + StoreFill. Verified numerically like
// Task 34 (pixel checks, not eyeballs): distinct non-empty cells per store, empty vs half vs full differ,
// the dark-plum outline is present, no two stores share pixels, and buildPieceVisual resolves a different
// frame per fill state from the merged registry.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildPieceVisual } from "@engine/assets";
import { loadMergedPackManifest } from "@engine/assets/node";
import { defaultDefs, STORE_FILL_STATE_NAMES } from "@engine/gameplay";
import { paintTask355Atlases, task355Frame, TASK355_ATLAS_KEYS, TASK355_FILL_STATES } from "../src/task355-art.js";

const STORES = ["ore_store", "log_store", "stick_store", "crop_store", "stone_store"] as const;
const FRAMES = { ore_store: 297, log_store: 298, stick_store: 299, crop_store: 300, stone_store: 301 } as const;
const POS = { ore_store: "60% 100%", log_store: "66.67% 100%", stick_store: "73.33% 100%", crop_store: "80% 100%", stone_store: "86.67% 100%" } as const;

/** "opaque:meanR:meanG:meanB" signature of one 128px cell, plus its outline-pixel count. */
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

describe("ADR-356 task355 art", () => {
  it("paints five 1024×384 atlases with distinct non-empty cells", () => {
    expect(TASK355_ATLAS_KEYS).toEqual(["decor_ore_store", "decor_log_store", "decor_stick_store", "decor_crop_store", "decor_stone_store"]);
    expect(TASK355_FILL_STATES).toEqual(STORE_FILL_STATE_NAMES);
    expect(task355Frame(0, 0, 0)).toBe(0); expect(task355Frame(1, 0, 0)).toBe(8); expect(task355Frame(2, 0, 0)).toBe(16);
    expect(task355Frame(0, 1, 0)).toBe(4); expect(task355Frame(2, 1, 3)).toBe(23);
    const atlases = paintTask355Atlases();
    expect(atlases.map((a) => a.key)).toEqual([...TASK355_ATLAS_KEYS]);
    const whole = new Set<string>();
    for (const a of atlases) {
      expect(a.width).toBe(1024); expect(a.height).toBe(384);
      // Whole-atlas signature: no two stores share identical pixels.
      let opaque = 0, r = 0, g = 0, b = 0;
      for (let i = 0; i < a.pixels.length; i += 4) if (a.pixels[i + 3]! > 16) { opaque++; r += a.pixels[i]!; g += a.pixels[i + 1]!; b += a.pixels[i + 2]!; }
      const sig = `${opaque}:${Math.round(r / opaque)}:${Math.round(g / opaque)}:${Math.round(b / opaque)}`;
      expect(whole.has(sig)).toBe(false); whole.add(sig);
    }
    expect(whole.size).toBe(5);
  });

  it("empty vs half vs full render differently, with the 1px dark outline, and full holds more pixels", () => {
    for (const a of paintTask355Atlases()) {
      const empty = cellSig(a, 0, 0), half = cellSig(a, 0, 1), full = cellSig(a, 0, 2);
      expect(empty.sig).not.toBe(half.sig);
      expect(half.sig).not.toBe(full.sig);
      expect(empty.sig).not.toBe(full.sig);
      expect(empty.outline).toBeGreaterThan(0);
      expect(half.outline).toBeGreaterThan(0);
      expect(full.outline).toBeGreaterThan(0);
      expect(full.opaque).toBeGreaterThan(empty.opaque); // stocked stores show more contents
      // Damage stages differ too (darkening + cracks).
      expect(cellSig(a, 0, 0).sig).not.toBe(cellSig(a, 3, 0).sig);
      // Rotation 1 is the narrower side view, not a copy of rotation 0.
      expect(cellSig(a, 0, 0).sig).not.toBe(cellSig(a, 4, 0).sig);
    }
  });

  it("the merged registry resolves every store sprite with fill states in StoreFill order", async () => {
    const { result, collisions } = await loadMergedPackManifest();
    expect(collisions.filter((c) => c.key.startsWith("dec_") && c.key.endsWith("_store"))).toEqual([]);
    expect(result.warnings).toEqual([]);
    const d = defaultDefs();
    for (const key of STORES) {
      expect(result.registry.atlases.has(`decor_${key}`), key).toBe(true);
      const sprite = result.registry.spriteForPiece(key);
      expect(sprite, key).toBeGreaterThan(0);
      const s = result.registry.sprite(sprite!);
      expect(s.key, key).toBe(`dec_${key}`);
      expect(s.building!.stateNames, key).toEqual([...STORE_FILL_STATE_NAMES]);
      const pk = (t: number): string | undefined => d.pieces.get(t)?.key;
      const frames = [0, 1, 2].map((level) => {
        const v = buildPieceVisual(result.registry, { type: d.pieceId(key), rot: 0, tint: 0, paint: 0, damageStage: 0, state: level }, { pieceKey: pk });
        expect(v.stateIndex, `${key} level ${level}`).toBe(level);
        return v.frame!.frame;
      });
      expect(frames, key).toEqual([0, 8, 16]); // row = fill state
      expect(new Set(frames).size).toBe(3);
      // Damage stage 3 is a different frame than intact, same state.
      const dmg = buildPieceVisual(result.registry, { type: d.pieceId(key), rot: 0, tint: 0, paint: 0, damageStage: 3, state: 2 }, { pieceKey: pk });
      expect(dmg.frame!.frame).toBe(19);
    }
  });

  it("build icons are declared at frames 297–301 with matching stylesheet positions", () => {
    const manifest = JSON.parse(readFileSync(resolve(__dirname, "../../../packages/assets/pack/items/manifest.items.json"), "utf8")) as {
      sprites: { key: string; atlas?: string; animations?: { idle?: { frames?: number[] } } }[];
      atlases: { key: string; columns: number; rows: number }[];
    };
    const atlas = manifest.atlases.find((a) => a.key === "items_build")!;
    expect(atlas.columns * atlas.rows).toBe(304); // frames 297–301 are the last free cells
    for (const key of STORES) {
      const s = manifest.sprites.find((x) => x.key === `build_${key}`);
      expect(s, key).toBeDefined();
      expect(s!.atlas).toBe("items_build");
      expect(s!.animations!.idle!.frames).toEqual([FRAMES[key]]);
    }
    const css = readFileSync(resolve(__dirname, "../src/gameplay-panels.css"), "utf8");
    for (const key of STORES) {
      const f = FRAMES[key];
      const col = f % 16, row = Math.floor(f / 16);
      expect(col / 15 * 100).toBeCloseTo(parseFloat(POS[key].split(" ")[0]!), 1);
      expect(row / 18 * 100).toBeCloseTo(parseFloat(POS[key].split(" ")[1]!), 1);
      expect(css).toContain(`[data-icon="build_${key}"]{--cz-ipos:${POS[key]}}`);
    }
  });
});
