/**
 * ADR-418: terrain slope seam glitches — regression for the BLUE-GAP symptom (symptom 1).
 *
 * Root cause (hypothesis B, PROVEN here): a cliff quad spanned flat from the tile's top to the
 * neighbour's FLAT height, but the neighbour's top edge along that boundary is TILTED — one of its
 * corners dropped toward a third tile that is 2+ levels below the high tile. The flat-bottomed
 * cliff did not reach the neighbour's low endpoint, leaving a triangular hole (up to 1 level =
 * 16 px tall) in the vertical plane of the shared edge. Through it the clear colour (day sky,
 * IsoRenderer.ts:610, timeOfDay.ts:51) showed — the blue triangles in the screenshot.
 *
 * The hole needs a third tile 2+ below the high tile at the shared vertex: the high tile's corner
 * does not drop (vertex min != h-1) while the 1-below neighbour's corner DOES drop (vertex min ==
 * its h-1). This is exactly the terraced dirt in the screenshot (steps down on two axes at once).
 *
 * The fix (packages/world/src/slope.ts `cliffEdgeSpan`, used by the mesh in tilemap.ts and by the
 * Canvas2D fallback in canvasGroundHeight.ts): the cliff quad follows BOTH top faces — its top
 * edge is this tile's edge heights (a dropped corner lowers it, so no fin pokes above the tilted
 * top) and its bottom edge is the neighbour's edge heights at the same two vertices, so the quad
 * is a trapezoid meeting both top faces exactly. These tests call the REAL span function (not a
 * transcription) and assert the CLIFF COVERAGE invariant: along any shared edge, either the two
 * top faces share their endpoint heights (a slope side, no cliff needed) or the emitted cliff
 * spans from at or below the neighbour's lowest endpoint to at or above this tile's highest
 * endpoint — per endpoint, exactly.
 *
 * Controls that PASS on the fixed tree (disproving the neighbouring hypotheses):
 *  - hypothesis A (all-four-corners guard): when the guard fires, every vertex minimum is exactly
 *    h-1, so the neighbour's shared corners cannot drop — the guarded tile's cliff bottom meets
 *    the neighbour's flat edge exactly. The guard is NOT a slit source.
 *  - hypothesis D (slope-side suppression): a true slope side has both corners dropped, which
 *    forces the neighbour's shared edge flat at the same height — no cliff is needed there.
 */
import { describe, it, expect } from "vitest";
import { classifyGroundShape, cliffEdgeSpan, type GroundNeighbourhood, type GroundShape } from "../src/index.js";

type H = (x: number, y: number) => number;
/** Neighbourhood of tile (x, y) in world axes, from a height function. */
const nbAt = (h: H, x: number, y: number): GroundNeighbourhood => ({
  h: h(x, y),
  edge: [h(x + 1, y), h(x - 1, y), h(x, y + 1), h(x, y - 1)],
  diag: [h(x + 1, y - 1), h(x + 1, y + 1), h(x - 1, y + 1), h(x - 1, y - 1)],
});
/** Top-face corner heights, corner order [(x,y), (x+1,y), (x+1,y+1), (x,y+1)] (slope.ts). */
const cornerHeights = (s: GroundShape, h: number): [number, number, number, number] =>
  [h - s.cornerDrops[0], h - s.cornerDrops[1], h - s.cornerDrops[2], h - s.cornerDrops[3]] as [number, number, number, number];
/** Shared-edge endpoint heights of a tile on edge `e`, in GROUND_SHAPE_SIDE_CORNERS[e] order. */
const edgeEnds = (s: GroundShape, h: number, e: number): [number, number] => {
  const ch = cornerHeights(s, h);
  const SIDE_CORNERS: readonly (readonly [number, number])[] = [[1, 2], [0, 3], [2, 3], [0, 1]];
  const [a, b] = SIDE_CORNERS[e]!;
  return [ch[a]!, ch[b]!];
};

describe("ADR-418 slope seams: cliff quad vs tilted neighbour edge (blue gaps)", () => {
  it("1-level edge + 2-level diagonal: shared-edge endpoints disagree by 2 levels, cliff bottom reaches the low endpoint", () => {
    // Terraced dirt: T=5, +x neighbour N=4 (1 down), +y neighbour = 3 (2 down), rest 5.
    const h: H = (x, y) => (x === 1 && y === 0 ? 4 : x === 0 && y === 1 ? 3 : 5);
    const t = classifyGroundShape(nbAt(h, 0, 0));
    const n = classifyGroundShape(nbAt(h, 1, 0));
    // Documented by the pre-existing ADR-409 test: only one corner of T's +x edge drops.
    expect(t.cornerDrops).toEqual([0, 1, 0, 0]);
    expect(t.slopeSides).toEqual([]);
    // The neighbour DOES drop the shared vertex (its corner touches the height-3 tile).
    expect(n.cornerDrops).toEqual([0, 0, 0, 1]);
    // Shared edge x=1, y 0..1: T endpoints (corners 1,2) vs N endpoints (corners 0,3).
    // They disagree by 2 levels at the shared vertex (1,1) — the mechanism of the hole.
    const tEnds = edgeEnds(t, 5, 0);
    const nEnds = [cornerHeights(n, 4)[0], cornerHeights(n, 4)[3]] as [number, number];
    expect(tEnds).toEqual([4, 5]);
    expect(nEnds).toEqual([4, 3]);
    // The fixed cliff is a trapezoid: top follows T's edge [4,5], bottom follows N's edge [4,3].
    const cliff = cliffEdgeSpan(t, 5, n, 4, 0);
    expect(cliff.emitted).toBe(true);
    expect(cliff.top).toEqual([4, 5]);
    expect(cliff.bottom).toEqual([4, 3]);
    // INVARIANT: the cliff bottom reaches the neighbour's lowest endpoint, top covers T's highest.
    expect(cliff.bottom[0]).toBeLessThanOrEqual(nEnds[0]);
    expect(cliff.bottom[1]).toBeLessThanOrEqual(nEnds[1]);
    expect(cliff.top[0]).toBeGreaterThanOrEqual(tEnds[0]);
    expect(cliff.top[1]).toBeGreaterThanOrEqual(tEnds[1]);
  });

  it("2-level step + 2-level diagonal: same hole on a stepped edge", () => {
    const h: H = (x, y) => (x === 1 && y === 0 ? 3 : x === 0 && y === 1 ? 2 : 5);
    const t = classifyGroundShape(nbAt(h, 0, 0));
    const n = classifyGroundShape(nbAt(h, 1, 0));
    expect(t.cornerDrops).toEqual([0, 0, 0, 0]); // stepped: no corner drops
    expect(n.cornerDrops).toEqual([0, 0, 0, 1]); // neighbour drops its shared vertex to 2
    const tEnds = edgeEnds(t, 5, 0);
    const nEnds = [cornerHeights(n, 3)[0], cornerHeights(n, 3)[3]] as [number, number];
    expect(tEnds).toEqual([5, 5]);
    expect(nEnds).toEqual([3, 2]);
    const cliff = cliffEdgeSpan(t, 5, n, 3, 0);
    expect(cliff.emitted).toBe(true);
    expect(cliff.top).toEqual([5, 5]);
    expect(cliff.bottom).toEqual([3, 2]);
    // INVARIANT: the cliff bottom (2) reaches the neighbour's lowest endpoint.
    expect(cliff.bottom[1]).toBeLessThanOrEqual(nEnds[1]);
  });

  it("the cliff top follows this tile's own dropped corner (no fin above the tilted top)", () => {
    // Same terraced dirt as the first test: T's +x edge runs 4 -> 5, so a flat top at 5 would poke
    // a triangular fin above the top face at the (1,0) end.
    const h: H = (x, y) => (x === 1 && y === 0 ? 4 : x === 0 && y === 1 ? 3 : 5);
    const t = classifyGroundShape(nbAt(h, 0, 0));
    const n = classifyGroundShape(nbAt(h, 1, 0));
    const cliff = cliffEdgeSpan(t, 5, n, 4, 0);
    expect(cliff.top).toEqual([4, 5]); // not [5, 5]: the top edge is the tile's own edge, tilted
    expect(cliff.top).toEqual(edgeEnds(t, 5, 0));
  });

  it("sweep: any third tile 2 below at a shared vertex opens the hole (systematic, not a one-off)", () => {
    // T=(0,0) h=5, N=(1,0) h=4; the four tiles touching the shared edge's vertices vary.
    // A shared edge is sealed iff the cliff (when emitted) covers both top faces, or the
    // endpoints agree (when the cliff is correctly suppressed on a slope side).
    let violations = 0;
    let checked = 0;
    for (const a of [3, 4, 5]) for (const b of [3, 4, 5]) for (const c of [3, 4, 5]) for (const d of [3, 4, 5]) {
      const h: H = (x, y) =>
        x === 1 && y === 0 ? 4 : x === 0 && y === 1 ? a : x === 1 && y === 1 ? b : x === 0 && y === -1 ? c : x === 1 && y === -1 ? d : 5;
      const t = classifyGroundShape(nbAt(h, 0, 0));
      const n = classifyGroundShape(nbAt(h, 1, 0));
      const tEnds = edgeEnds(t, 5, 0);
      const nEnds = [cornerHeights(n, 4)[0], cornerHeights(n, 4)[3]] as [number, number];
      const cliff = cliffEdgeSpan(t, 5, n, 4, 0);
      checked++;
      const sealed = cliff.emitted
        ? cliff.bottom[0] <= nEnds[0] && cliff.bottom[1] <= nEnds[1] && cliff.top[0] >= tEnds[0] && cliff.top[1] >= tEnds[1]
        : tEnds[0] === nEnds[0] && tEnds[1] === nEnds[1];
      if (!sealed) violations++;
    }
    expect(checked).toBe(81);
    // INVARIANT: 0 unsealed shared edges over the whole sweep.
    expect(violations).toBe(0);
  });

  it("sweep over all four edges: the span seals the shared edge whichever side steps down", () => {
    // Per edge: T=(0,0) h=5, N at the edge direction h=4; the four tiles touching the shared
    // edge's vertices (other than T and N) vary over 3..5. The neighbour corner indices along the
    // edge differ per edge (slope.ts NEIGHBOUR_EDGE_CORNERS), so each edge is checked separately.
    const DIRS: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    // Third tiles per edge, in the order the sweep varies them: the two touching the first shared
    // vertex, then the two touching the second shared vertex.
    const THIRD: readonly (readonly (readonly [number, number])[])[] = [
      [[0, 1], [1, 1], [0, -1], [1, -1]],
      [[0, 1], [-1, 1], [0, -1], [-1, -1]],
      [[1, 0], [1, 1], [-1, 0], [-1, 1]],
      [[1, 0], [1, -1], [-1, 0], [-1, -1]],
    ];
    // Neighbour corner indices at the shared vertices, in edge traversal order.
    const NBR: readonly (readonly [number, number])[] = [[0, 3], [1, 2], [1, 0], [3, 2]];
    let checked = 0, violations = 0;
    for (let e = 0; e < 4; e++) {
      const [nx, ny] = DIRS[e]!;
      const third = THIRD[e]!;
      for (const a of [3, 4, 5]) for (const b of [3, 4, 5]) for (const c of [3, 4, 5]) for (const d of [3, 4, 5]) {
        const vals = [a, b, c, d];
        const h: H = (x, y) => {
          if (x === 0 && y === 0) return 5;
          if (x === nx && y === ny) return 4;
          for (let k = 0; k < 4; k++) if (x === third[k]![0] && y === third[k]![1]) return vals[k]!;
          return 5;
        };
        const t = classifyGroundShape(nbAt(h, 0, 0));
        const n = classifyGroundShape(nbAt(h, nx, ny));
        const tEnds = edgeEnds(t, 5, e);
        const nCh = cornerHeights(n, 4);
        const nEnds = [nCh[NBR[e]![0]]!, nCh[NBR[e]![1]]!] as [number, number];
        const cliff = cliffEdgeSpan(t, 5, n, 4, e);
        checked++;
        const sealed = cliff.emitted
          ? cliff.bottom[0] <= nEnds[0] && cliff.bottom[1] <= nEnds[1] && cliff.top[0] >= tEnds[0] && cliff.top[1] >= tEnds[1]
          : tEnds[0] === nEnds[0] && tEnds[1] === nEnds[1];
        if (!sealed) violations++;
      }
    }
    expect(checked).toBe(324);
    expect(violations).toBe(0);
  });

  it("per-edge span: the neighbour corner mapping is right on every side, including flat neighbours", () => {
    // Synthetic shapes (no height field): own tile drops one corner of the edge, neighbour drops
    // the shared vertex at the other end. The span must pick the neighbour's corner heights at the
    // shared vertices — a mapping that differs per edge.
    const flat: GroundShape = { kind: "flat", edgeDrops: [0, 0, 0, 0], cornerDrops: [0, 0, 0, 0], slopeSides: [], sloped: false, cornerMask: 0 };
    // Own drops: +x edge corner 1 down, -x edge corner 0 down, +y edge corner 2 down, -y edge corner 0 down.
    const ownDrops: [0 | 1, 0 | 1, 0 | 1, 0 | 1][] = [[0, 1, 0, 0], [1, 0, 0, 0], [0, 0, 1, 0], [1, 0, 0, 0]];
    // Neighbour drops: the shared vertex at the far end of the edge.
    const nbrDrops: [0 | 1, 0 | 1, 0 | 1, 0 | 1][] = [[0, 0, 0, 1], [0, 0, 1, 0], [1, 0, 0, 0], [0, 0, 1, 0]];
    const expectedTop: [number, number][] = [[4, 5], [4, 5], [4, 5], [4, 5]];
    const expectedBottom: [number, number][] = [[4, 3], [4, 3], [4, 3], [4, 3]];
    for (let e = 0; e < 4; e++) {
      const own: GroundShape = { ...flat, cornerDrops: ownDrops[e]!, sloped: true };
      const nbr: GroundShape = { ...flat, cornerDrops: nbrDrops[e]!, sloped: true };
      const span = cliffEdgeSpan(own, 5, nbr, 4, e);
      expect(span.emitted, `edge ${e}`).toBe(true);
      expect(span.top, `edge ${e} top`).toEqual(expectedTop[e]);
      expect(span.bottom, `edge ${e} bottom`).toEqual(expectedBottom[e]);
    }
    // Flat neighbours (water / void: no shape) contribute their flat height on both ends.
    const own: GroundShape = { ...flat, cornerDrops: [0, 1, 0, 0], sloped: true };
    expect(cliffEdgeSpan(own, 5, undefined, 4, 0)).toEqual({ emitted: true, top: [4, 5], bottom: [4, 4] });
    // A flat own tile keeps a flat top and a flat bottom.
    expect(cliffEdgeSpan(flat, 5, flat, 3, 0)).toEqual({ emitted: true, top: [5, 5], bottom: [3, 3] });
    // No cliff when the neighbour is not lower, or on a slope side.
    expect(cliffEdgeSpan(flat, 5, flat, 5, 0).emitted).toBe(false);
    expect(cliffEdgeSpan(flat, 5, flat, 6, 0).emitted).toBe(false);
    const ramp: GroundShape = { ...flat, edgeDrops: [1, 0, 0, 0], cornerDrops: [0, 1, 1, 0], slopeSides: [0], sloped: true };
    expect(cliffEdgeSpan(ramp, 5, flat, 4, 0).emitted).toBe(false);
  });

  it("rotation consistency: the same slope classified in 4 rotations gives the rotated span", () => {
    // Rotate the neighbourhood 90 deg CCW about the tile centre: edge [e3,e2,e0,e1], diag
    // [d3,d0,d1,d2], corner drops [d3,d0,d1,d2]. The step that sits on the +x edge moves to the
    // +y edge, then -x, then -y (cycle 0 -> 2 -> 1 -> 3), and a slope side follows the same cycle
    // (side i -> [2,3,1,0][i]); the neighbour tile moves with it, so its neighbourhood rotates too.
    const rot = (n: GroundNeighbourhood): GroundNeighbourhood => ({
      h: n.h,
      edge: [n.edge[3], n.edge[2], n.edge[0], n.edge[1]],
      diag: [n.diag[3], n.diag[0], n.diag[1], n.diag[2]],
    });
    const rotDrops = (d: [0 | 1, 0 | 1, 0 | 1, 0 | 1]): [0 | 1, 0 | 1, 0 | 1, 0 | 1] => [d[3], d[0], d[1], d[2]];
    const rotSides = (s: number[]): number[] => s.map((i) => [2, 3, 1, 0][i]!).sort();
    const EDGE_Q = [0, 2, 1, 3];
    const NBR: readonly (readonly [number, number])[] = [[0, 3], [1, 2], [1, 0], [3, 2]];
    const h: H = (x, y) => (x === 1 && y === 0 ? 4 : x === 0 && y === 1 ? 3 : 5);
    let nb = nbAt(h, 0, 0);
    let nbn = nbAt(h, 1, 0);
    for (let q = 0; q < 4; q++) {
      const t = classifyGroundShape(nb);
      const n = classifyGroundShape(nbn);
      // The step sits on edge EDGE_Q[q] in this rotation: check the span seals it.
      const e = EDGE_Q[q]!;
      const cliff = cliffEdgeSpan(t, 5, n, 4, e);
      const tEnds = edgeEnds(t, 5, e);
      const nCh = cornerHeights(n, 4);
      const nEnds = [nCh[NBR[e]![0]]!, nCh[NBR[e]![1]]!] as [number, number];
      const sealed = cliff.emitted
        ? cliff.bottom[0] <= nEnds[0] && cliff.bottom[1] <= nEnds[1] && cliff.top[0] >= tEnds[0] && cliff.top[1] >= tEnds[1]
        : tEnds[0] === nEnds[0] && tEnds[1] === nEnds[1];
      expect(sealed, `rotation ${q}`).toBe(true);
      if (q < 3) {
        const tNext = classifyGroundShape(rot(nb));
        const nNext = classifyGroundShape(rot(nbn));
        expect(tNext.cornerDrops, `rotation ${q + 1} corner drops`).toEqual(rotDrops(t.cornerDrops));
        expect(tNext.edgeDrops, `rotation ${q + 1} edge drops`).toEqual([t.edgeDrops[3], t.edgeDrops[2], t.edgeDrops[0], t.edgeDrops[1]]);
        expect(tNext.slopeSides, `rotation ${q + 1} slope sides`).toEqual(rotSides(t.slopeSides));
        expect(nNext.cornerDrops, `rotation ${q + 1} neighbour corner drops`).toEqual(rotDrops(n.cornerDrops));
        nb = rot(nb); nbn = rot(nbn);
      }
    }
  });

  it("CONTROL (passes): the all-four-corners guard does NOT open a slit — hypothesis A disproved", () => {
    // Peak: T=5, every edge/diagonal neighbour 4, so all four corners would drop and the guard fires.
    const h: H = (x, y) => (x === 0 && y === 0 ? 5 : 4);
    const t = classifyGroundShape(nbAt(h, 0, 0));
    expect(t.cornerDrops).toEqual([0, 0, 0, 0]);
    expect(t.sloped).toBe(false);
    expect(t.slopeSides).toEqual([]);
    const n = classifyGroundShape(nbAt(h, 1, 0));
    expect(n.cornerDrops).toEqual([0, 0, 0, 0]); // guard firing forces every vertex min to h-1, so N cannot drop
    // The top faces do NOT share edge heights here (5 vs 4) — that is fine for a stepped tile:
    // the cliff quad bridges the step. The sealing invariant is cliff coverage, and it holds.
    const tEnds = edgeEnds(t, 5, 0);
    const nEnds = [cornerHeights(n, 4)[0], cornerHeights(n, 4)[3]] as [number, number];
    expect(tEnds).toEqual([5, 5]);
    expect(nEnds).toEqual([4, 4]);
    const cliff = cliffEdgeSpan(t, 5, n, 4, 0);
    expect(cliff.emitted).toBe(true);
    expect(cliff.top).toEqual([5, 5]);
    expect(cliff.bottom).toEqual([4, 4]);
    expect(cliff.bottom[0]).toBeLessThanOrEqual(Math.min(...nEnds));
    expect(cliff.top[0]).toBeGreaterThanOrEqual(Math.max(...tEnds));
  });

  it("CONTROL (passes): a true slope side needs no cliff — hypothesis D disproved", () => {
    const h: H = (x, y) => (x === 1 && y === 0 ? 4 : 5);
    const t = classifyGroundShape(nbAt(h, 0, 0));
    const n = classifyGroundShape(nbAt(h, 1, 0));
    expect(t.kind).toBe("ramp");
    expect(t.slopeSides).toEqual([0]);
    const tEnds = edgeEnds(t, 5, 0);
    const nEnds = [cornerHeights(n, 4)[0], cornerHeights(n, 4)[3]] as [number, number];
    expect(tEnds).toEqual([4, 4]);
    expect(tEnds).toEqual(nEnds);
    expect(cliffEdgeSpan(t, 5, n, 4, 0).emitted).toBe(false); // correctly suppressed: the tilted top meets N exactly
  });
});
