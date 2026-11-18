/**
 * ADR-418: the textured ground instance's triangulation — the single source of truth shared by the
 * terrain-tiles vertex shader (terrainTiles.ts, which embeds TERRAIN_TILE_TABLE_GLSL) and the
 * regression tests (packages/render/test/adr418_instance_mesh_seam.test.ts).
 *
 * Why a new triangulation: the old instance was one quad drawn as a TRIANGLE_STRIP (4 vertices,
 * triangles (0,1,2),(1,2,3), folded on the frame diagonal top-right to bottom-left), while the
 * vertex-colour mesh top face (tilemap.ts) is two triangles folded on the N-S diamond diagonal
 * (corners 0-2). The shader tilted the quad by bilinear interpolation of the four corner drops over
 * the frame, but a bilinear field sampled at the frame corners and linearly interpolated over the
 * strip's fold cannot reproduce the mesh's fold: the instance's diamond corners sat up to +0.83
 * levels (13 px) above and -0.55 levels (9 px) below the mesh corners, so sloped instances floated
 * over their low neighbours and sank into their high ones. Solving for frame-vertex drops that hit
 * the mesh corners exactly is not an alternative: the system is near-singular (determinant 0.006
 * at the 2x frame) and the solution swings to +/-22 levels, which would throw the skirt hundreds
 * of px off. The fold itself has to change.
 *
 * The table below is 10 triangles (30 vertices, drawn as TRIANGLES). The diamond is triangulated
 * exactly like the mesh — (N,E,S),(N,S,W) — so the instance surface inside the diamond IS the mesh
 * top face: same triangles, same corner heights, exact at every point of the diamond, not just its
 * corners. The ring between the diamond and the frame is triangulated with the frame corners:
 * one triangle against each diamond edge ((B,E,N),(D,S,E),(C,W,S),(A,N,W)) plus one in each frame
 * corner ((A,B,N),(B,D,E),(D,C,S),(C,A,W)). The ring is outside the diamond, so its exact shape
 * only has to be continuous (shared vertices) and cover the frame — it does (0 gaps / 0 overlaps
 * over both shipped frames, verified numerically).
 *
 * Each entry is [x, y, kind]:
 *   kind 0 — a frame corner at fraction (x, y) of the cell (A=(0,0), B=(1,0), C=(0,1), D=(1,1)).
 *     Its drop is the old bilinear value at that vertex, so the skirt below the diamond hangs
 *     exactly as before.
 *   kind 1 — a diamond corner at anchor + (x, y) * uIso (N=(0,-1), E=(1,0), S=(0,1), W=(-1,0) in
 *     uIso units: the diamond is 64x32 px around the anchor whatever the frame scale — the same
 *     diamond the fragment shader's inDiamond test defines). Its drop is that corner's drop, so
 *     the diamond corners sit exactly on the mesh corners.
 * The entries are in triangle order with the strip's old winding (positive cross product in
 * frame coords, y down). Flat tiles are unaffected: all four corner drops are 0, so every vertex
 * drop is 0 and the 10 triangles tile the same flat quad the strip drew.
 */
export type TerrainTileVertexKind = 0 | 1;

/** One triangulation vertex: [x, y, kind] as documented above. */
export type TerrainTileVertex = readonly [number, number, TerrainTileVertexKind];

/** Frame corners (kind 0) and diamond corners (kind 1, uIso units from the anchor). */
export const TERRAIN_TILE_FRAME = { A: [0, 0, 0] as const, B: [1, 0, 0] as const, C: [0, 1, 0] as const, D: [1, 1, 0] as const };
export const TERRAIN_TILE_DIAMOND = { N: [0, -1, 1] as const, E: [1, 0, 1] as const, S: [0, 1, 1] as const, W: [-1, 0, 1] as const };

/** The 30 vertices: 10 triangles in the order the vertex shader draws them. */
export const TERRAIN_TILE_VERTEX_TABLE: readonly TerrainTileVertex[] = (() => {
  const { A, B, C, D } = TERRAIN_TILE_FRAME;
  const { N, E, S, W } = TERRAIN_TILE_DIAMOND;
  return [
    N, E, S, // diamond, exactly the mesh top face (tilemap.ts: fold on the N-S diagonal)
    N, S, W,
    B, E, N, // ring: one triangle against each diamond edge …
    D, S, E,
    C, W, S,
    A, N, W,
    A, B, N, // … plus one in each frame corner
    B, D, E,
    D, C, S,
    C, A, W,
  ];
})();

export const TERRAIN_TILE_VERTEX_COUNT = TERRAIN_TILE_VERTEX_TABLE.length;

/** GLSL const-array initializer for the table, generated from the same data the tests use. */
export const TERRAIN_TILE_TABLE_GLSL: string = (() => {
  const f = (n: number): string => (Number.isInteger(n) ? `${n}.0` : `${n}`);
  const rows = TERRAIN_TILE_VERTEX_TABLE.map(([x, y, k]) => `vec3(${f(x)}, ${f(y)}, ${f(k)})`).join(", ");
  return `const vec3 ADR418_T[${TERRAIN_TILE_VERTEX_COUNT}] = vec3[${TERRAIN_TILE_VERTEX_COUNT}](${rows});`;
})();
