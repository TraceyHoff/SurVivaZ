/**
 * ADR-409: sloped ground shapes — the ground-shape model. Pure (no imports): a tile's shape is a deterministic
 * function of its own render height and its 8 neighbours' render heights, so the mesh (tilemap.ts) and the
 * textured instances (terrainTiles.ts) always agree, in all 4 view rotations (each caller feeds the
 * neighbourhood in its own axes — world axes for the mesh, view-space axes for the instances).
 *
 * Corner rule (what makes the surface continuous, with no slits): a top-face corner drops exactly 1 level iff
 * the lowest tile touching that vertex is exactly 1 level below this tile. Every tile sharing the vertex
 * computes the same drop for it (the vertex minimum is the same whoever asks), so adjacent top faces share
 * their edge heights exactly — a ramp's downhill edge sits at the low neighbour's height, a wedge's low
 * corner sits at the low neighbours' height, and a 2+-level drop never drops a corner (the cliff face keeps
 * its full height). Water neighbours carry the 0.25 surface inset, so their heights are fractional and can
 * never equal h-1: shores stay ledges, never slopes. Void neighbours (<= SLOPE_VOID) are ignored.
 *
 * Kinds (from the 4 edge drops; `sloped` says whether the top actually tilts):
 *   flat    — no edge drops (a diagonal-only low just dimples the shared corner; kind stays flat).
 *   ramp    — exactly one edge 1 lower: the top is one plane sloping down that axis.
 *   wedge   — two adjacent edges 1 lower: the top folds down toward the low corner (two triangles).
 *   valley  — two opposite edges 1 lower; peak — all four edges 1 lower; 3-edge wedge — three edges 1
 *             lower. All three would need all four corners down, which would drop the whole top to the
 *             low height and erase the tile (a lone peak would read as flat ground while the player
 *             stands 1 level above it), so the guard keeps the top flat and the 1-level cliff faces:
 *             they render exactly as before ADR-409. A centre vertex would be needed to slope them.
 *   stepped — any edge drops 2+ levels: flat top, cliff faces (the mesh cliff + gt_side faces below).
 * A `slopeSide` is an edge with a 1-level drop whose two corners both dropped: only there is the cliff
 * face suppressed (the tilted top meets the neighbour exactly). Any other 1-level edge keeps its cliff
 * face, which closes the strip between the descending top edge and the low neighbour — no holes.
 *
 * Gameplay truth is unchanged: this module only decides render geometry. Stand height, movement,
 * pathing, building placement and farming all still read the flat tile height h.
 *
 * ADR-410 contract (slope art): `groundSlopeArt(shape)` returns the art selector for a sloped tile, and
 * `groundSlopeKey(mat, season, kind, dir)` in render/groundArt.ts builds the sprite key:
 *   gt_<mat>_slope_ramp_<d>[_fall|_winter|_spring]   d = downhill axis in the shape's axes:
 *                                                     0=+u, 1=+v, 2=-u, 3=-v (view space in the renderer)
 *   gt_<mat>_slope_wedge_<c>[_fall|_winter|_spring]  c = low corner in the shape's axes:
 *                                                     0=(u-,v-), 1=(u+,v-), 2=(u+,v+), 3=(u-,v+)
 * Same 68x52 cell and anchor (34,18) as the flat gt_<mat> bases. Until ADR-410 paints them the renderer
 * keeps the flat base and tilts it geometrically, so nothing is ever invisible.
 * Corner encoding on a TileTerrain instance (aB.z skirt mask): bits 16/32/64/128 = corner drops for
 * corners 0..3 (see CORNER order below); the vertex shader bilinearly interpolates them over the diamond.
 * Canvas2D keeps flat diamonds (fallback renderer only) — not wired to this model yet.
 */

/** Render heights at or below this are a missing/void tile (cf. tilemap NO_TILE_HEIGHT = -9999; groundSideLevels uses SLOPE_VOID).
 * ADR-529: -9000 (was -90) — real ground now reaches -100 and -250 in the follow-up raise. */
export const SLOPE_VOID = -9000;

export type GroundShapeKind = "flat" | "ramp" | "wedge" | "valley" | "peak" | "stepped";

/** Edge order throughout this module: [+x, -x, +y, -y] in the caller's axes. */
export const GROUND_SHAPE_SIDE_CORNERS: readonly (readonly [number, number])[] = [[1, 2], [0, 3], [2, 3], [0, 1]];

/** Edge index (shape order [+x,-x,+y,-y]) -> index in [+u,+v,-u,-v] order (terrainDropEdges result and slope-art dirs). */
export const SHAPE_EDGE_TO_UV = [0, 2, 1, 3] as const;

export interface GroundNeighbourhood {
  /** Centre render height (land tile; integer levels). */
  h: number;
  /** Edge-neighbour render heights [+x, -x, +y, -y]; <= SLOPE_VOID = missing/void tile. */
  edge: [number, number, number, number];
  /** Diagonal-neighbour render heights [(+x,-y), (+x,+y), (-x,+y), (-x,-y)]; same void convention. */
  diag: [number, number, number, number];
}

export interface GroundShape {
  kind: GroundShapeKind;
  /** Per-edge drop in levels (0 = same height, higher, or void), order [+x, -x, +y, -y]. Fractional when the neighbour is water (0.25 inset). */
  edgeDrops: [number, number, number, number];
  /** Per-corner drop 0|1, order [(x,y), (x+1,y), (x+1,y+1), (x,y+1)] in the caller's axes: the top-face corner heights are h - cornerDrops[i]. */
  cornerDrops: [0 | 1, 0 | 1, 0 | 1, 0 | 1];
  /** Edge indices (0..3) whose 1-level drop is drawn as a slope, not a cliff face. */
  slopeSides: number[];
  /** True when the top face actually tilts (any corner dropped). */
  sloped: boolean;
  /** TileTerrain instance encoding: bits 16|32|64|128 for corners 0..3 with a drop. */
  cornerMask: number;
}

/** Corner i's two adjacent edge indices and diagonal index (corner order [(x,y), (x+1,y), (x+1,y+1), (x,y+1)]). */
const CORNER_NEIGHBOURS: readonly (readonly [number, number, number])[] = [[1, 3, 3], [0, 3, 0], [0, 2, 1], [1, 2, 2]];

export function classifyGroundShape(n: GroundNeighbourhood): GroundShape {
  const h = n.h;
  const drop = (v: number): number => (v <= SLOPE_VOID ? 0 : Math.max(0, h - v));
  const edgeDrops = [drop(n.edge[0]), drop(n.edge[1]), drop(n.edge[2]), drop(n.edge[3])] as [number, number, number, number];
  const cornerDrops = CORNER_NEIGHBOURS.map(([ea, eb, d]) => {
    let m = h;
    for (const v of [n.edge[ea]!, n.edge[eb]!, n.diag[d]!]) if (v > SLOPE_VOID) m = Math.min(m, v);
    return (m === h - 1 ? 1 : 0) as 0 | 1;
  }) as [0 | 1, 0 | 1, 0 | 1, 0 | 1];
  // Guard: all four corners down would erase the tile (flat at the low height while gameplay stands at h).
  if (cornerDrops[0] === 1 && cornerDrops[1] === 1 && cornerDrops[2] === 1 && cornerDrops[3] === 1) {
    cornerDrops[0] = cornerDrops[1] = cornerDrops[2] = cornerDrops[3] = 0;
  }
  const slopeSides: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [c0, c1] = GROUND_SHAPE_SIDE_CORNERS[i]!;
    if (edgeDrops[i] === 1 && cornerDrops[c0] === 1 && cornerDrops[c1] === 1) slopeSides.push(i);
  }
  const n1 = edgeDrops.filter((d) => d === 1).length;
  const big = edgeDrops.some((d) => d > 1);
  let kind: GroundShapeKind;
  if (n1 === 0) kind = big ? "stepped" : "flat";
  else if (n1 === 1) kind = "ramp";
  else if (n1 === 2) kind = (edgeDrops[0] === 1 && edgeDrops[1] === 1) || (edgeDrops[2] === 1 && edgeDrops[3] === 1) ? "valley" : "wedge";
  else if (n1 === 3) kind = "wedge";
  else kind = "peak";
  const sloped = cornerDrops.some((c) => c === 1);
  return { kind, edgeDrops, cornerDrops, slopeSides, sloped, cornerMask: (cornerDrops[0] ? 16 : 0) | (cornerDrops[1] ? 32 : 0) | (cornerDrops[2] ? 64 : 0) | (cornerDrops[3] ? 128 : 0) };
}

/**
 * ADR-418: cliff-quad span for one edge, following BOTH top faces. The old mesh cliff (tilemap.ts) was a
 * flat rectangle from this tile's height down to the neighbour's FLAT height, but the neighbour's top
 * edge along the shared boundary can be TILTED: a corner of the neighbour drops toward a third tile
 * 2+ levels below this tile (slope.ts:86-91 drops a corner only when the vertex minimum is exactly
 * h-1, so the high tile's corner stays up while the 1-below neighbour's corner drops). The flat
 * bottom then stops short of the neighbour's low endpoint and leaves a triangular hole in the plane
 * of the shared edge — up to 1 level (16 px) tall — through which the sky clear colour shows (the
 * blue gaps in the screenshot). The same flat top left a fin above the tilted top whenever this
 * tile's own edge corner dropped. The span therefore carries both edges: `top` is this tile's edge
 * heights at the edge's two corners (GROUND_SHAPE_SIDE_CORNERS order) and `bottom` is the
 * neighbour's edge heights at the SAME two vertices, so the quad is a trapezoid (two triangles, all
 * four points in the edge plane) that meets both top faces exactly. A neighbour with no shape
 * (water — always flat — or void) contributes its flat height on both ends. `emitted` is false on a
 * slope side (the tilted tops already meet) and when the neighbour is not lower; it can never be a
 * degenerate quad otherwise (top == bottom on both ends would be a slope side).
 *
 * NEIGHBOUR_EDGE_CORNERS[edge] is the neighbour's corner indices at the shared vertices, in the
 * same traversal order as GROUND_SHAPE_SIDE_CORNERS[edge]: +x [0,3], -x [1,2], +y [1,0], -y [3,2].
 * The y-edges read reversed because the neighbour's corner order runs the other way along the edge.
 */
export const NEIGHBOUR_EDGE_CORNERS: readonly (readonly [number, number])[] = [[0, 3], [1, 2], [1, 0], [3, 2]];

export interface CliffEdgeSpan {
  /** False when no cliff is needed (neighbour not lower, or a slope side). */
  emitted: boolean;
  /** This tile's top-edge heights at the edge's two corners (GROUND_SHAPE_SIDE_CORNERS order). */
  top: [number, number];
  /** The neighbour's top-edge heights at the same two vertices (same order). */
  bottom: [number, number];
}

export function cliffEdgeSpan(
  own: GroundShape | undefined, ownH: number,
  neighbour: GroundShape | undefined, neighbourH: number,
  edge: number,
): CliffEdgeSpan {
  const [c0, c1] = GROUND_SHAPE_SIDE_CORNERS[edge]!;
  const ownDrops = own?.cornerDrops ?? [0, 0, 0, 0];
  const top: [number, number] = [ownH - ownDrops[c0]!, ownH - ownDrops[c1]!];
  let bottom: [number, number];
  if (neighbour) {
    const [n0, n1] = NEIGHBOUR_EDGE_CORNERS[edge]!;
    bottom = [neighbourH - neighbour.cornerDrops[n0]!, neighbourH - neighbour.cornerDrops[n1]!];
  } else {
    bottom = [neighbourH, neighbourH];
  }
  const emitted = neighbourH < ownH && !(own?.slopeSides.includes(edge) ?? false);
  return { emitted, top, bottom };
}

/**
 * ADR-410 art selector for a sloped tile, or undefined when the tile keeps its flat top (flat, stepped,
 * valley, peak, guarded wedge, or a ramp whose slope side kept its cliff face). `dir` is in the shape's
 * own axes — the renderer passes a view-space shape, so dirs are view-space (see the contract above).
 */
export function groundSlopeArt(shape: GroundShape): { kind: "ramp" | "wedge"; dir: number } | undefined {
  if (!shape.sloped || !shape.slopeSides.length) return undefined;
  if (shape.kind === "ramp") {
    return { kind: "ramp", dir: SHAPE_EDGE_TO_UV[shape.slopeSides[0]!]! };
  }
  if (shape.kind === "wedge") {
    // Low corner = the corner whose two adjacent edges are both slope sides.
    // Corner c touches edges: 0:(−x,−y) 1:(+x,−y) 2:(+x,+y) 3:(−x,+y) in edge indices [1,3],[0,3],[0,2],[1,2].
    const cornerEdges: readonly (readonly [number, number])[] = [[1, 3], [0, 3], [0, 2], [1, 2]];
    for (let c = 0; c < 4; c++) {
      const [e0, e1] = cornerEdges[c]!;
      if (shape.slopeSides.includes(e0) && shape.slopeSides.includes(e1)) return { kind: "wedge", dir: c };
    }
  }
  return undefined;
}
