import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { World, Transform, defineComponent } from "@engine/core";
import { loadManifest, mergeManifests, type ManifestJson } from "@engine/assets";
import { FLOOR_HEIGHT_LEVELS, DEFAULT_ISO } from "@engine/world";
import {
  attachToWorld, BuildGhost, chimneySmokePoint, crackAnim, isoZDepthFactor, isEnclosurePieceKey, pieceArtRow, PieceCoverIndex, pieceDepthKey, pieceHiddenByStory, pieceShouldCutaway,
  ROT_EXACT_PIVOT, splitTierKey, streamingFallbackKeys, triArtRow, type BuildPieceDefT,
} from "../src/index.js";

const ROOT = join(__dirname, "../../..");
const json = <T>(p: string): T => JSON.parse(readFileSync(join(ROOT, p), "utf8")) as T;
const bld = json<ManifestJson>("packages/assets/pack/building/manifest.building.json");
const base = json<ManifestJson>("packages/assets/pack/manifest.json");
const { registry: reg } = loadManifest(mergeManifests([{ name: "base", manifest: base }, { name: "building", manifest: bld }]).manifest);
const pieces = json<{ pieces: { key: string; placement?: string; rotSteps?: number; layer?: number }[] }>("packages/gameplay/data/pieces.json").pieces;

describe("triangle pieces: 30° steps on art rows (ADR-104)", () => {
  it("Survival's defs: tri pieces use 12 rotation steps (placement.ts rotationSteps), corners 4/8", () => {
    const src = readFileSync(join(ROOT, "packages/gameplay/src/ui/placement.ts"), "utf8");
    expect(src).toMatch(/placement === Placement\.Tri \? 12/);
    const tri = pieces.filter((p) => p.placement === "tri").map((p) => p.key).sort();
    expect(tri).toEqual(["floor_triangle", "foundation_triangle"]);
    expect(pieces.find((p) => p.key === "wall_corner_angled")?.rotSteps).toBe(8);
    expect(pieces.find((p) => p.key === "wall_corner_inner")?.rotSteps).toBe(4);
  });
  it("every 30° step maps exactly (mod 120°) onto one of the unique4 rows at 0/90/180/270°", () => {
    for (let r = 0; r < 12; r++) {
      const row = triArtRow(r);
      expect(((row * 90 - r * 30) % 120 + 120) % 120).toBe(0);
    }
    expect([0, 1, 2, 3].map(triArtRow)).toEqual([0, 3, 2, 1]);
    expect(pieceArtRow(5, 12)).toBe(triArtRow(5)); // not quarterTurn(5,12)=2
    expect(pieceArtRow(3, 4)).toBe(3); expect(pieceArtRow(6, 16)).toBe(2); expect(pieceArtRow(7, 8)).toBe(0);
  });
  it("foundation_triangle art has 4 unique rows at every tier", () => {
    for (let t = 1; t <= 4; t++) {
      const id = reg.spriteForPiece(`foundation_triangle@tier${t}`)!; const b = reg.sprite(id).building!;
      expect(b.rotationArt).toBe("unique4"); expect(new Set(b.frames.map((r) => r[0])).size).toBe(4);
    }
  });
});

describe("tier keys and streaming fallback", () => {
  it("splits <piece>@tier<N>", () => { expect(splitTierKey("wall@tier3")).toEqual({ base: "wall", tier: 3 }); expect(splitTierKey("wall")).toEqual({ base: "wall", tier: 0 }); });
  it("falls back to the bare key first, then other tiers, then the family default", () => {
    expect(streamingFallbackKeys("wall@tier2")).toEqual(["wall", "wall@tier1", "wall@tier3", "wall@tier4"]);
    expect(streamingFallbackKeys("wall_arched@tier3").slice(-1)).toEqual(["wall"]);
    expect(streamingFallbackKeys("roof_chimney@tier1")).toContain("roof_flat");
    expect(streamingFallbackKeys("wall_corner_outer@tier4")).toContain("wall_corner");
  });
  it("every tiered building sprite has a resident (non building_t<N>) fallback in the base pack", () => {
    const missing: string[] = [];
    for (const s of reg.allSprites()) {
      const p = s.building?.piece; if (!p || !/@tier\d$/.test(p)) continue;
      const ok = streamingFallbackKeys(p).some((k) => { const id = reg.spriteForPiece(k); return id !== undefined && !/^building_t\d$/.test(reg.sprite(id).atlas.key); });
      if (!ok) missing.push(p);
    }
    expect(missing).toEqual([]);
  });
});

describe("damage crack overlay", () => {
  it("building sprites declare bld_crack with stage1-3 anims", () => {
    const id = reg.spriteForPiece("wall@tier2")!; const c = reg.sprite(id).building!.crackOverlay!;
    expect(reg.sprite(c).key).toBe("bld_crack");
    for (let s = 1; s <= 3; s++) expect(reg.sprite(c).animations.has(crackAnim(s)!)).toBe(true);
    expect(crackAnim(0)).toBeUndefined(); expect(crackAnim(4)).toBeUndefined();
  });
  it("sprites.ts draws the overlay instance above the piece and suppresses the procedural crack", () => {
    const src = readFileSync(join(__dirname, "../src/sprites.ts"), "utf8");
    expect(src).toMatch(/crackOverlayOf\(drawVis\)/); expect(src).toMatch(/!res\.hasDamageFrames && !crack/);
  });
});

describe("stacked floors depth (levelHeight 3 = FLOOR_HEIGHT_LEVELS)", () => {
  const zf = isoZDepthFactor(DEFAULT_ISO); const Z = (lv: number) => lv * FLOOR_HEIGHT_LEVELS;
  it("one floor = exactly one tile row of depth", () => { expect(Z(1) * zf).toBeCloseTo(1, 6); });
  it("orders upper levels above lower ones on the same tile and keeps ground pieces in front where they are", () => {
    const deck = (x: number, y: number, lv: number) => pieceDepthKey(x, y, 1, 1, Z(lv), zf, 0);
    const wall = (x: number, y: number, lv: number) => pieceDepthKey(x, y, 1, 1, Z(lv), zf, 0.01);
    const roof = (x: number, y: number, lv: number) => pieceDepthKey(x, y, 1, 1, Z(lv), zf, 0.05);
    expect(deck(5, 5, 1)).toBeGreaterThan(wall(5, 5, 0)); // level-1 floor over the wall below it
    expect(deck(5, 5, 2)).toBeGreaterThan(wall(5, 5, 1));
    expect(roof(5, 5, 2)).toBeGreaterThan(wall(5, 5, 1));
    expect(wall(6, 6, 0)).toBeGreaterThan(deck(5, 5, 1)); // ground wall two rows in front draws after the deck behind/above
    expect(wall(5, 6, 0)).toBeGreaterThan(deck(5, 5, 1)); // front wall top meets the upper deck edge: wall wins
    expect(deck(6, 6, 1)).toBeGreaterThan(wall(5, 5, 1));
  });
});

describe("gridless cutaway (client has no BuildingGrid)", () => {
  const house = () => {
    const c = new PieceCoverIndex();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { c.add(x, y, 1, 1, 0, true, false); c.add(x, y, 1, 1, 1, true, false); c.add(x, y, 1, 1, 2, true, true); }
    c.add(0, 0, 1, 1, 1, false, false); return c;
  };
  it("inside on the ground floor: region = the building footprint", () => {
    const r = house().region(1, 1, 0)!; expect(r.size).toBe(16); expect(r.has("3,3")).toBe(true); expect(r.has("4,4")).toBe(false);
  });
  it("on the upper floor under the roof: still cut (roof covers)", () => { expect(house().region(2, 2, 1)?.size).toBe(16); });
  it("outside / on top: no cutaway", () => { expect(house().region(6, 6, 0)).toBeNull(); expect(house().region(1, 1, 3)).toBeNull(); });
  it("ADR-309: a missing ceiling tile still cutaways when the rest of the building is roofed", () => {
    const c = new PieceCoverIndex();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      c.add(x, y, 1, 1, 0, true, false);
      if (!(x === 1 && y === 1)) c.add(x, y, 1, 1, 1, false, true);
    }
    const r = c.region(1, 1, 0)!;
    expect(r.has("1,1")).toBe(true);
    expect(r.size).toBe(16);
    expect(c.region(2, 2, 0)?.size).toBe(16);
  });
  it("ADR-309: an outdoor deck with no roof anywhere is not indoor", () => {
    const c = new PieceCoverIndex();
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) c.add(x, y, 1, 1, 0, true, false);
    expect(c.region(0, 0, 0)).toBeNull();
  });
});

describe("chimney smoke attach", () => {
  it("bld_roof_chimney sprites have the smoke attach point", () => {
    for (let t = 1; t <= 4; t++) { const id = reg.spriteForPiece(`roof_chimney@tier${t}`)!; expect(reg.sprite(id).attach?.smoke).toEqual({ x: 0, y: -46 }); }
  });
  it("px attach -> world point above the pivot (x mirrored when flipped)", () => {
    const iso = DEFAULT_ISO;
    expect(attachToWorld(0, -46, false, iso)).toEqual({ x: 0, y: -0, z: 46 / 16 });
    const a = attachToWorld(32, 0, false, iso), b = attachToWorld(32, 0, true, iso);
    expect((a.x - a.y) * iso.tileW / 2).toBeCloseTo(32); expect(b.x).toBeCloseTo(-a.x);
    const p = chimneySmokePoint(10, 4, false, 0, 1, 1, 3, { x: 0, y: -46 }, false, iso);
    expect(p).toEqual({ x: 10.5, y: 4.5, z: 3 + 46 / 16 });
    expect(chimneySmokePoint(10.3, 4.6, true, 0, 1, 1, 0, { x: 0, y: 0 }, false, iso)).toMatchObject({ x: 10.3, y: 4.6 });
  });
});

describe("BuildGhost: tri rotation + exact pivot", () => {
  const BP = defineComponent("ModularGhostBP", { visualId: "u16", variant: "u8", tint: "u32", damageStage: "u8", rotation: "u8", level: "u8", layer: "u8", ghost: "u8" }) as unknown as BuildPieceDefT;
  it("rotSteps 12 -> exact art row, exactPivot sets the flag, tier art selected", () => {
    const w = new World(); w.register(Transform); w.register(BP); const g = new BuildGhost(w, BP, reg);
    const v = g.sync({ pieceKey: "foundation_triangle", x: 3.333, y: 4.667, rot: 5, valid: true }, { tier: 2, rotSteps: 12, exactPivot: true, level: 1, z: 3 })!;
    expect(v.visualId).toBe(reg.spriteForPiece("foundation_triangle@tier2"));
    const c = w.get(g.entity!, BP)!; expect(c.rotation & 3).toBe(triArtRow(5)); expect(c.rotation & ROT_EXACT_PIVOT).toBe(ROT_EXACT_PIVOT);
    const t = w.get(g.entity!, Transform)!; expect(t.x).toBeCloseTo(3.333, 4); expect(t.y).toBeCloseTo(4.667, 4); expect(t.z).toBe(3);
  });
});

describe("triArtRow vs screen convention", () => {
  // Art: row r = model rotated r x 90 deg clockwise ON SCREEN, row 0 edge 0 faces SE. Gameplay (triEdges): edge k normal at
  // world angle (rot + 4k) x 30 deg. Screen = ((x - y) hw, (x + y) hh), y down.
  const scr = (a: number) => { const x = Math.cos(a), y = Math.sin(a); return [x - y, (x + y) / 2] as const; };
  const cw = (a: readonly [number, number], b: readonly [number, number]) => a[0] * b[1] - a[1] * b[0] > 0; // y-down: >0 = clockwise
  it("rot 0 edge 0 faces SE and increasing rot turns clockwise on screen", () => {
    const e0 = scr(0); expect(e0[0]).toBeGreaterThan(0); expect(e0[1]).toBeGreaterThan(0);
    expect(cw(scr(0), scr(Math.PI / 6))).toBe(true);
  });
  it("each 30 deg step lands exactly on the row with the same edge set (mod 120 deg)", () => {
    for (let rot = 0; rot < 12; rot++) {
      const row = triArtRow(rot); // row r = r x 90 deg CW from rot 0, so edges at (3r + 4k) x 30 deg
      const want = new Set([0, 1, 2].map((k) => (rot + 4 * k) % 12)), got = new Set([0, 1, 2].map((k) => (3 * row + 4 * k) % 12));
      expect(got).toEqual(want);
    }
  });
});

describe("ADR-304 indoor cutaway", () => {
  it("classifies enclosure pieces and leaves furniture alone", () => {
    expect(isEnclosurePieceKey("wall")).toBe(true);
    expect(isEnclosurePieceKey("wall_doorway@tier2")).toBe(true);
    expect(isEnclosurePieceKey("wall_window")).toBe(true);
    expect(isEnclosurePieceKey("wall_corner_outer@tier1")).toBe(true);
    expect(isEnclosurePieceKey("door_wood")).toBe(true);
    expect(isEnclosurePieceKey("garden_gate")).toBe(true);
    expect(isEnclosurePieceKey("floor")).toBe(false);
    expect(isEnclosurePieceKey("roof_flat")).toBe(false);
    expect(isEnclosurePieceKey("basic_storage_box")).toBe(false);
    expect(isEnclosurePieceKey("bed")).toBe(false);
    expect(isEnclosurePieceKey("wood_stove")).toBe(false);
  });
  it("fades roofs and stories above the player, plus camera-near walls in front", () => {
    const front = 10, back = 6, player = 8;
    expect(pieceShouldCutaway(true, 1, 0, false, false, 0, front, player)).toBe(true); // ceiling / upper floor
    expect(pieceShouldCutaway(true, 0, 0, true, false, 0, front, player)).toBe(true); // roof this story
    expect(pieceShouldCutaway(true, 0, 0, false, true, 2, front, player)).toBe(true); // south wall in front
    expect(pieceShouldCutaway(true, 0, 0, false, true, 3, front, player)).toBe(true); // east wall in front
    expect(pieceShouldCutaway(true, 0, 0, false, true, 2, back, player)).toBe(false); // south-facing wall behind the player
    expect(pieceShouldCutaway(true, 0, 0, false, true, 0, back, player)).toBe(false); // north back wall
    expect(pieceShouldCutaway(true, 0, 0, false, true, 1, back, player)).toBe(false); // west back wall
    expect(pieceShouldCutaway(true, 0, 0, false, false, 2, front, player)).toBe(false); // furniture in front
    expect(pieceShouldCutaway(false, 1, 0, true, true, 2, front, player)).toBe(false); // outside the region
  });
});

describe("ADR-308 story isolation", () => {
  it("hides other stories inside the building and leaves this story and outdoor pieces", () => {
    expect(pieceHiddenByStory(true, 1, 0)).toBe(true); // floor above
    expect(pieceHiddenByStory(true, 2, 0)).toBe(true);
    expect(pieceHiddenByStory(true, 0, 1)).toBe(true); // floor below
    expect(pieceHiddenByStory(true, 0, 0)).toBe(false);
    expect(pieceHiddenByStory(true, 1, 1)).toBe(false);
    expect(pieceHiddenByStory(false, 1, 0)).toBe(false); // outside the building
    expect(pieceHiddenByStory(false, 0, 1)).toBe(false);
  });
});
