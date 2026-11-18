/**
 * ADR-409: sloped ground shapes — classification is correct for every neighbour-height pattern in all
 * 4 rotations (flat, single-axis ramps, corner wedges, multi-level steps), and the corner-drop rule keeps
 * adjacent top faces continuous (no slits): a corner drops exactly when the lowest tile touching that
 * vertex is exactly 1 level below this tile.
 */
import { describe, it, expect } from "vitest";
import { classifyGroundShape, groundSlopeArt, type GroundNeighbourhood } from "../src/index.js";

const VOID = -99;
const nb = (h: number, edge: [number, number, number, number] = [h, h, h, h], diag: [number, number, number, number] = [h, h, h, h]): GroundNeighbourhood => ({ h, edge, diag });

describe("ADR-409 ground-shape classification", () => {
  it("flat ground stays flat, void neighbours are ignored", () => {
    const s = classifyGroundShape(nb(5));
    expect(s).toMatchObject({ kind: "flat", edgeDrops: [0, 0, 0, 0], cornerDrops: [0, 0, 0, 0], slopeSides: [], sloped: false, cornerMask: 0 });
    expect(classifyGroundShape(nb(5, [VOID, VOID, 5, 5])).kind).toBe("flat");
    expect(classifyGroundShape(nb(-5, [-6, -5, -5, -5])).kind).toBe("ramp"); // deep-pit heights work too
  });

  it("ramps in all four directions, with the matching corner drops and slope-art dirs", () => {
    // edge order [+x, -x, +y, -y]; corner order [(x,y), (x+1,y), (x+1,y+1), (x,y+1)]
    const cases: { edge: [number, number, number, number]; corners: [0 | 1, 0 | 1, 0 | 1, 0 | 1]; side: number; dir: number }[] = [
      { edge: [4, 5, 5, 5], corners: [0, 1, 1, 0], side: 0, dir: 0 }, // downhill +x
      { edge: [5, 4, 5, 5], corners: [1, 0, 0, 1], side: 1, dir: 2 }, // downhill -x
      { edge: [5, 5, 4, 5], corners: [0, 0, 1, 1], side: 2, dir: 1 }, // downhill +y
      { edge: [5, 5, 5, 4], corners: [1, 1, 0, 0], side: 3, dir: 3 }, // downhill -y
    ];
    for (const c of cases) {
      const s = classifyGroundShape(nb(5, c.edge));
      expect(s.kind).toBe("ramp"); expect(s.cornerDrops).toEqual(c.corners);
      expect(s.slopeSides).toEqual([c.side]); expect(s.sloped).toBe(true);
      expect(groundSlopeArt(s)).toEqual({ kind: "ramp", dir: c.dir });
    }
  });

  it("corner wedges for all four adjacent pairs", () => {
    const cases: { edge: [number, number, number, number]; corners: [0 | 1, 0 | 1, 0 | 1, 0 | 1]; sides: number[]; dir: number }[] = [
      { edge: [4, 5, 4, 5], corners: [0, 1, 1, 1], sides: [0, 2], dir: 2 }, // low corner (x+1,y+1)
      { edge: [4, 5, 5, 4], corners: [1, 1, 1, 0], sides: [0, 3], dir: 1 }, // low corner (x+1,y)
      { edge: [5, 4, 5, 4], corners: [1, 1, 0, 1], sides: [1, 3], dir: 0 }, // low corner (x,y)
      { edge: [5, 4, 4, 5], corners: [1, 0, 1, 1], sides: [1, 2], dir: 3 }, // low corner (x,y+1)
    ];
    for (const c of cases) {
      const s = classifyGroundShape(nb(5, c.edge));
      expect(s.kind).toBe("wedge"); expect(s.cornerDrops).toEqual(c.corners);
      expect(s.slopeSides).toEqual(c.sides); expect(s.sloped).toBe(true);
      expect(groundSlopeArt(s)).toEqual({ kind: "wedge", dir: c.dir });
    }
  });

  it("valley, peak and 3-edge wedges keep a flat top (guard: all four corners would drop)", () => {
    for (const edge of [[4, 4, 5, 5], [5, 5, 4, 4], [4, 4, 4, 4], [4, 4, 4, 5]] as [number, number, number, number][]) {
      const s = classifyGroundShape(nb(5, edge));
      expect(s.cornerDrops).toEqual([0, 0, 0, 0]); expect(s.sloped).toBe(false);
      expect(s.slopeSides).toEqual([]); expect(groundSlopeArt(s)).toBeUndefined();
    }
    expect(classifyGroundShape(nb(5, [4, 4, 5, 5])).kind).toBe("valley");
    expect(classifyGroundShape(nb(5, [4, 4, 4, 4])).kind).toBe("peak");
    expect(classifyGroundShape(nb(5, [4, 4, 4, 5])).kind).toBe("wedge");
  });

  it("multi-level steps stay stepped with cliffs, never slopes", () => {
    const s = classifyGroundShape(nb(5, [3, 5, 5, 5]));
    expect(s).toMatchObject({ kind: "stepped", cornerDrops: [0, 0, 0, 0], slopeSides: [], sloped: false });
    expect(groundSlopeArt(s)).toBeUndefined();
    // A 1-level ramp next to a 2-level cliff: only one corner drops, the ramp side keeps its cliff face.
    const mixed = classifyGroundShape(nb(5, [4, 5, 3, 5]));
    expect(mixed.kind).toBe("ramp"); expect(mixed.cornerDrops).toEqual([0, 1, 0, 0]);
    expect(mixed.slopeSides).toEqual([]); expect(mixed.sloped).toBe(true);
    expect(groundSlopeArt(mixed)).toBeUndefined();
  });

  it("a diagonal-only low dimples the shared corner without changing the kind", () => {
    const s = classifyGroundShape(nb(5, [5, 5, 5, 5], [5, 4, 5, 5]));
    expect(s.kind).toBe("flat"); expect(s.cornerDrops).toEqual([0, 0, 1, 0]); expect(s.sloped).toBe(true);
    expect(s.slopeSides).toEqual([]);
  });

  it("water neighbours (fractional 0.25 inset) never read as a 1-level slope", () => {
    // Land at 5 next to water whose bed is 4 (render height 3.75): a shore ledge, not a ramp.
    const s = classifyGroundShape(nb(5, [3.75, 5, 5, 5]));
    expect(s.kind).toBe("stepped"); expect(s.cornerDrops).toEqual([0, 0, 0, 0]); expect(s.sloped).toBe(false);
  });

  it("cornerMask encodes the corner drops for the instance shader (bits 16/32/64/128)", () => {
    expect(classifyGroundShape(nb(5, [4, 5, 5, 5])).cornerMask).toBe(32 | 64);
    expect(classifyGroundShape(nb(5, [4, 5, 4, 5])).cornerMask).toBe(32 | 64 | 128);
    expect(classifyGroundShape(nb(5)).cornerMask).toBe(0);
  });
});

describe("ADR-419 ramp profiles classify as ramps", () => {
  /** Neighbourhood of tile (x, y) from a height function (cf. adr418 nbAt). */
  const nbAt = (h: (x: number, y: number) => number, x: number, y: number): GroundNeighbourhood => ({
    h: h(x, y),
    edge: [h(x + 1, y), h(x - 1, y), h(x, y + 1), h(x, y - 1)],
    diag: [h(x + 1, y - 1), h(x + 1, y + 1), h(x - 1, y + 1), h(x - 1, y - 1)],
  });
  it("a broad ±1 staircase (cross neighbours on the same profile) classifies every interior tile as a ramp", () => {
    // A wide ramp: heights rise 1 per tile along +x at every y, so each tile has exactly one
    // edge 1 lower (its downhill side) and no other drop — the shape a graded ramp is meant to be.
    const h = (x: number, _y: number): number => 2 + Math.max(0, Math.min(3, x));
    for (const x of [1, 2, 3]) {
      const s = classifyGroundShape(nbAt(h, x, 0));
      expect(s.kind).toBe("ramp"); expect(s.slopeSides).toEqual([1]); // downhill -x
      expect(groundSlopeArt(s)).toEqual({ kind: "ramp", dir: 2 });
    }
    // A 1-wide ramp on flat ground is NOT all ramps: its sides are cliffs by design (stepped /
    // wedge off-axis). Only the graded axis is a ±1 staircase — assert that, not the kind.
    const narrow = (x: number, y: number): number => (y === 0 ? 2 + Math.max(0, Math.min(3, x)) : 2);
    for (const x of [1, 2, 3]) {
      const s = classifyGroundShape(nbAt(narrow, x, 0));
      expect(s.edgeDrops[1]).toBe(1); // downhill axis edge is still exactly 1
      expect(s.edgeDrops[0]).toBe(0); // uphill axis edge never drops
    }
  });
});
