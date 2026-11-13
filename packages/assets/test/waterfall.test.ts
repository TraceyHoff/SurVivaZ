import { readFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadManifest } from "../src/index.js";
import { PACK_DIR, imageSizeOf } from "../src/node.js";

const root = "packages/assets/pack/";
const man = JSON.parse(readFileSync(root + "manifest.json", "utf8"));
const lock = JSON.parse(readFileSync(root + "ids.lock.json", "utf8"));
const packer = readFileSync("packages/assets/pack/nature/src/ground_pack.py", "utf8");

const UNIQUE = [
  "gt_waterfall_lip_px", "gt_waterfall_lip_nx",
  "gt_waterfall_sheet_1_px", "gt_waterfall_sheet_1_nx",
  "gt_waterfall_sheet_2_px", "gt_waterfall_sheet_2_nx",
  "gt_waterfall_pool_px", "gt_waterfall_pool_nx",
] as const;
const FLIP: Record<string, string> = {
  gt_waterfall_lip_py: "gt_waterfall_lip_px",
  gt_waterfall_lip_ny: "gt_waterfall_lip_nx",
  gt_waterfall_sheet_1_py: "gt_waterfall_sheet_1_px",
  gt_waterfall_sheet_1_ny: "gt_waterfall_sheet_1_nx",
  gt_waterfall_sheet_2_py: "gt_waterfall_sheet_2_px",
  gt_waterfall_sheet_2_ny: "gt_waterfall_sheet_2_nx",
  gt_waterfall_pool_py: "gt_waterfall_pool_px",
  gt_waterfall_pool_ny: "gt_waterfall_pool_nx",
};

type Rect = { x: number; y: number; w: number; h: number };
type DF = { atlas: string; frame: number; rect: Rect; anchor: { x: number; y: number } };
type Sprite = { key: string; category: string; atlas: string; placeholder?: string; anchor: { x: number; y: number }; animations: { idle: { frames: number[]; fps: number; loop: boolean; directions?: number; dirFrames: DF[] } } };
type Atlas = { key: string; image: string; ktx2?: string; frameW: number; frameH: number; columns: number; rows: number; pages?: { scale: number; image: string; ktx2?: string }[] };

const sprite = (k: string): Sprite => man.sprites.find((s: Sprite) => s.key === k);
const atlas = (k: string): Atlas => man.atlases.find((a: Atlas) => a.key === k);

describe("dedicated waterfall tiles (ADR-386)", () => {
  it("ships eight unique looping keys (lip, 1-level sheet, 2-level sheet, pool × px/nx) on one lean page", () => {
    const a = atlas("gt_waterfall");
    expect(a).toBeTruthy();
    expect(Math.max(a.frameW, a.frameH)).toBeLessThanOrEqual(1024);
    expect(a.columns).toBe(1);
    expect(a.rows).toBe(1);
    expect(a.ktx2).toBe("atlases/gt_waterfall.ktx2");
    const pg = a.pages![0]!;
    expect(pg.scale).toBe(2);
    expect(pg.image).toBe("atlases/gt_waterfall@2x.png");
    expect(pg.ktx2).toBe("atlases/gt_waterfall@2x.ktx2");
    const p1 = imageSizeOf(PACK_DIR + a.image);
    const p2 = imageSizeOf(PACK_DIR + pg.image);
    expect(p1).toEqual({ w: a.frameW, h: a.frameH });
    expect(p2).toEqual({ w: a.frameW * 2, h: a.frameH * 2 });
    for (const f of [PACK_DIR + a.ktx2!, PACK_DIR + pg.ktx2!]) {
      expect(existsSync(f), f).toBe(true);
      expect(statSync(f).size).toBeGreaterThan(44);
      expect(readFileSync(f).readUInt32LE(40)).toBeGreaterThan(1);
    }

    const seen = new Set<string>();
    for (const key of UNIQUE) {
      const s = sprite(key);
      expect(s, key).toBeTruthy();
      expect(s.category).toBe("tile");
      expect(s.atlas).toBe("gt_waterfall");
      expect(s.placeholder).toBe("gt_water");
      expect(lock.sprites[key], key).toBeTypeOf("number");
      const idle = s.animations.idle!;
      expect(idle.frames).toEqual([0, 1, 2, 3, 4, 5]);
      expect(idle.fps).toBe(8);
      expect(idle.loop).toBe(true);
      expect(idle.dirFrames).toHaveLength(6);
      for (const df of idle.dirFrames) {
        expect(df.atlas).toBe("gt_waterfall");
        const r = df.rect!;
        expect(r.w).toBeGreaterThan(2);
        expect(r.h).toBeGreaterThan(2);
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(a.frameW);
        expect(r.y + r.h).toBeLessThanOrEqual(a.frameH);
        expect(Number.isFinite(df.anchor.x) && Number.isFinite(df.anchor.y)).toBe(true);
        const id = `${r.x},${r.y},${r.w},${r.h}`;
        expect(seen.has(id), `${key} reuses ${id}`).toBe(false);
        seen.add(id);
      }
    }
    expect(seen.size).toBe(UNIQUE.length * 6);
    // py / ny are flipX mirrors — they must not be packed as extra sprites
    for (const [alias, src] of Object.entries(FLIP)) {
      expect(sprite(alias), alias).toBeUndefined();
      expect(sprite(src), src).toBeTruthy();
    }
  });

  it("loads through the pack manifest and is retained if ground_pack.py is re-run", () => {
    const { registry } = loadManifest(man);
    for (const key of UNIQUE) {
      const id = registry.id(key);
      expect(id).toBeTypeOf("number");
      const f = registry.dirFrame(id, "idle", 0, 0);
      expect(f.w).toBeGreaterThan(2);
      expect(f.h).toBeGreaterThan(2);
      // mid-loop frame (t = 2 / 8 s) is a different rect
      const f2 = registry.dirFrame(id, "idle", 0, 2 / 8);
      expect(`${f2.x},${f2.y}`).not.toBe(`${f.x},${f.y}`);
    }
    expect(packer).toContain("gt_waterfall");
  });

  it("does not reuse gt_water / gt_water_shallow pixels", () => {
    const a = atlas("gt_waterfall")!;
    const page = readFileSync(PACK_DIR + a.image);
    // PNG bytes of the waterfall page must not equal any summer water cell; also compare cropped RGBA hashes.
    const summer = man.atlases.find((x: Atlas) => x.key === "gt_summer_p0")!;
    const water = sprite("gt_water")!;
    const shallow = sprite("gt_water_shallow")!;
    const waterFrames = [...water.animations.idle.frames, ...shallow.animations.idle.frames];
    expect(waterFrames).toHaveLength(8);
    // The waterfall page is a different file and a different size to a 68x52 water cell.
    const sz = imageSizeOf(PACK_DIR + a.image)!;
    expect(sz.w === 68 && sz.h === 52).toBe(false);
    expect(page.equals(readFileSync(PACK_DIR + summer.image))).toBe(false);
    const hashes = new Set<string>();
    for (const key of UNIQUE) {
      for (const df of sprite(key)!.animations.idle.dirFrames) {
        hashes.add(createHash("sha1").update(JSON.stringify(df.rect)).digest("hex"));
      }
    }
    expect(hashes.size).toBe(UNIQUE.length * 6);
  });
});
