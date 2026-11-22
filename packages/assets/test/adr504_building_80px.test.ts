/**
 * ADR-504 Art delivery: base building pieces at the 80 px floor (docs/art-requests/ADR504_BUILDING_SCALE.md, "Art delivered").
 * Frames 84x120 with the pivot at (42,99) on the tier pages (17 rows x 120 = 2040 keeps every shipped index inside the 2048
 * layer), dedicated stairs per tier on a stream page, and the measured heights (tools/measure-building-scale.py) inside the
 * targets of packages/gameplay/data/building_scale.json — independent of the engine's floor flip.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = "packages/assets/pack/";
const man = JSON.parse(readFileSync(root + "building/manifest.building.json", "utf8"));
const pack = JSON.parse(readFileSync(root + "manifest.json", "utf8"));
const lock = JSON.parse(readFileSync(root + "ids.lock.json", "utf8"));
const C = JSON.parse(readFileSync("packages/gameplay/data/building_scale.json", "utf8"));
const M = JSON.parse(readFileSync("packages/gameplay/data/building_scale.measured.json", "utf8"));
type Atlas = { key: string; image: string; frameW: number; frameH: number; columns: number; rows: number; residency?: string };
type Sprite = { key: string; atlas: string; anchor: { x: number; y: number }; building?: { piece: string; frames: number[][]; layer: number; crackOverlay?: string }; rotationArt?: string };
const atlas = (k: string): Atlas => man.atlases.find((a: Atlas) => a.key === k);
const png = (p: string): [number, number] => { const b = readFileSync(p); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
const PAGES = ["building_t1", "building_t2", "building_t3", "building_t4", "building_tw", "building_fx", "building_stairs"];
const tops = (k: string): number[] => Object.values(M.pieces[k].tiers as Record<string, { topPx: number }>).map((m) => m.topPx);
const within = (v: number[], [lo, hi]: [number, number]): boolean => v.every((x) => x >= lo && x <= hi);

describe("ADR-504: 80 px building frames", () => {
  it("tier / twig-corner / crack / stairs pages are 84x120 grids that fit one 2048 layer, image size = grid", () => {
    for (const k of PAGES) {
      const a = atlas(k); expect(a, k).toBeTruthy();
      expect([a.frameW, a.frameH], k).toEqual([84, 120]);
      expect(a.columns * a.frameW).toBeLessThanOrEqual(2048); expect(a.rows * a.frameH).toBeLessThanOrEqual(2048);
      expect(png(root + "building/" + a.image), k).toEqual([a.columns * a.frameW, a.rows * a.frameH]);
    }
    for (const t of [1, 2, 3, 4]) expect(atlas(`building_t${t}`).rows).toBe(17); // every shipped frame index kept
  });
  it("every sprite on those pages has the pivot at (42,99): anchor (0.5, 0.825)", () => {
    const on = man.sprites.filter((s: Sprite) => PAGES.includes(s.atlas));
    expect(on.length).toBeGreaterThan(140);
    for (const s of on) expect(s.anchor, s.key).toEqual({ x: 0.5, y: 0.825 });
  });
  it("dedicated stairs per tier: stairs@tier1..4 on the building_stairs stream page, 4 drawn rotations x 4 damage stages", () => {
    expect(atlas("building_stairs").residency).toBe("stream");
    const seen = new Set<number>();
    for (const t of [1, 2, 3, 4]) {
      const s: Sprite = man.sprites.find((x: Sprite) => x.key === `bld_stairs_t${t}`);
      expect(s.atlas).toBe("building_stairs"); expect(s.rotationArt).toBe("unique4");
      expect(s.building).toMatchObject({ piece: `stairs@tier${t}`, layer: 1, crackOverlay: "bld_crack" });
      const f = s.building!.frames; expect(f.length).toBe(4);
      for (const row of f) { expect(row.length).toBe(4); for (const i of row) { expect(seen.has(i)).toBe(false); seen.add(i); } }
      expect(lock.sprites[s.key]).toBeTypeOf("number");
      expect(M.pieces.stairs.tiers[`t${t}`].sprite).toBe(`bld_stairs_t${t}`); // the game resolves the dedicated art, not stairs_twig
    }
    expect(pack.sprites.find((s: Sprite) => s.key === "stairs_twig")?.building?.piece).toBe("stairs"); // t0 + resident fallback
  });
});

describe("ADR-504: measured heights meet the 80 px targets", () => {
  const T = C.target;
  it("walls, corners and pillars reach one 80 px floor (+ cap) and agree with each other", () => {
    for (const k of ["wall", "wall_window", "wall_doorway", "wall_arched", "wall_corner_inner", "wall_corner_outer", "wall_corner_angled"]) expect(within(tops(k), T.wallTopPx), k).toBe(true);
    expect(within(tops("pillar"), T.pillarTopPx)).toBe(true);
    expect(within(tops("wall_fortified"), T.fortifiedTopPx)).toBe(true);
    expect(within(tops("wall_low"), T.wallLowTopPx)).toBe(true); // untouched, still waist high
  });
  it("doorways open to ~1.13x the player from the floor; leaves and window inserts fill their openings", () => {
    for (const m of Object.values(M.pieces.wall_doorway.tiers) as { openTopPx: number; openSillPx: number }[]) { expect(within([m.openTopPx], T.doorOpenTopPx)).toBe(true); expect(m.openSillPx).toBeLessThanOrEqual(10); }
    for (const m of Object.values(M.pieces.wall_window.tiers) as { openTopPx: number; openSillPx: number }[]) { expect(within([m.openSillPx], T.windowSillPx)).toBe(true); expect(m.openTopPx).toBeGreaterThanOrEqual(58); expect(m.openTopPx).toBeLessThanOrEqual(62); }
    for (const k of ["door_wood", "door_metal"]) expect(within(tops(k), T.doorLeafTopPx), k).toBe(true);
    for (const k of ["window_glass", "window_shutters", "window_bars"]) expect(within(tops(k), T.windowOpenTopPx), k).toBe(true);
    expect(Math.min(...tops("door_wood")) / C.playerPx).toBeGreaterThan(1.1);
  });
  it("stairs climb one 80 px floor: top tread at the tile's back corner (floorPx + 16 +- 3), every tier", () => {
    expect(within(tops("stairs"), T.stairsTopPx)).toBe(true);
    for (const v of tops("stairs")) expect(Math.abs(v - (T.floorPx + 16))).toBeLessThanOrEqual(C.tierTolerancePx);
  });
});
