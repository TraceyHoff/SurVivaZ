// ADR-414: terrain height on the Canvas2D fallback path (the renderer Xbox Edge lands on when WebGL2
// cannot be created, e.g. after a GPU reset). The WebGL2 mesh expresses height through vertex z; the
// Canvas2D ground drew every tile as a flat diamond at z = 0 and never read tile heights, so the ground
// read flat on the console while the same build showed slopes and cliffs on the phone. These tests drive
// the shared geometry the console path uses (canvasGroundHeight.ts) and the flat-cell drawing that
// flatTiles will call: distinct heights must produce distinct output, with cliff faces closing the drop.
// (The Canvas2DRenderer.render() wiring is covered by the integration step: canvas2d.ts is owned by the
// sibling ADR-415/417 work until it lands, see docs/DECISIONS.md ADR-414.)
import { describe, expect, it } from "vitest";
import { World } from "@engine/core";
import { TileMap, tileToLocal } from "@engine/world";
import { Canvas2DRenderer, TILE_COLORS } from "../src/canvas2d.js";
import { TileId } from "../src/ids.js";
import {
  C2D_GT_Z_CLAMP, c2dClampHeight, c2dCliffShade, c2dGroundGeometry, c2dGtFaceBelowSkirt, c2dGtPads,
  c2dNeighbourLow, c2dTileHeight, drawC2DGroundCell, type C2DGroundGeom,
} from "../src/canvasGroundHeight.js";

const GRASS = TileId.Grass, WATER = TileId.Water;
/** Fill a 3x3 block centred on (0,0) with grass at height `h`, except `low` overrides ("dx,dy" -> height). */
const fill3 = (map: TileMap, h: number, low: Record<string, number> = {}): void => {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    map.setTile(dx, dy, GRASS);
    map.getChunk(Math.floor(dx / 32), Math.floor(dy / 32))!.setHeight(tileToLocal(dx), tileToLocal(dy), low[`${dx},${dy}`] ?? h);
  }
};
/** Neighbour lookup over the 3x3 block, in the caller's axes (q = 0: view == world). */
const lowOf = (map: TileMap) => (dx: number, dy: number): number | undefined => c2dNeighbourLow(map, dx, dy);

describe("ADR-414 Canvas2D ground heights", () => {
  it("c2dTileHeight reads the chunk height (water = flat surface 0, missing / empty = undefined)", () => {
    const map = new TileMap();
    map.setTile(2, 3, GRASS); map.getChunk(0, 0)!.setHeight(tileToLocal(2), tileToLocal(3), 5);
    map.setTile(4, 3, WATER);
    expect(c2dTileHeight(map, 2, 3)).toBe(5);
    expect(c2dTileHeight(map, 4, 3)).toBe(0); // WATER_SURFACE_HEIGHT
    expect(c2dTileHeight(map, 9, 9)).toBeUndefined();
    map.getChunk(0, 0)!.setHeight(tileToLocal(6), tileToLocal(6), 7); // height but no tile
    expect(c2dTileHeight(map, 6, 6)).toBeUndefined();
  });

  it("c2dNeighbourLow applies the 0.25 water inset, so a shore is a 0.25 drop and never a slope", () => {
    const map = new TileMap();
    map.setTile(1, 0, GRASS); map.getChunk(0, 0)!.setHeight(tileToLocal(1), tileToLocal(0), 3);
    map.setTile(0, 1, WATER);
    expect(c2dNeighbourLow(map, 1, 0)).toBe(3);
    expect(c2dNeighbourLow(map, 0, 1)).toBe(-0.25);
    expect(c2dNeighbourLow(map, 5, 5)).toBeUndefined();
  });

  it("flat ground: top is the old diamond at its height, no faces", () => {
    const map = new TileMap(); fill3(map, 2);
    const g = c2dGroundGeometry(2, lowOf(map));
    expect(g.top).toEqual([[0, -48], [32, -32], [0, -16], [-32, -32]]); // diamond lifted 2 levels (32 px)
    expect(g.faces).toEqual([]);
    expect(g.minLow).toBe(2);
  });

  it("a 1-level step tilts the top into a ramp (corner drops) and draws no cliff on the slope side", () => {
    const map = new TileMap(); fill3(map, 1, { "1,0": 0 }); // +u neighbour 1 lower
    const g = c2dGroundGeometry(1, lowOf(map));
    // R and B corners drop to the low height; T and L stay up: the same tilt as the mesh top face.
    expect(g.top).toEqual([[0, -32], [32, 0], [0, 16], [-32, -16]]);
    expect(g.faces).toEqual([]); // the tilted top meets the low neighbour: no face, as in tilemap.ts
  });

  it("a plateau 3 levels up draws a flat top at height 3 with a cliff face on every lower side", () => {
    const map = new TileMap(); fill3(map, 3, { "1,0": 0, "-1,0": 0, "0,1": 0, "0,-1": 0 });
    const g = c2dGroundGeometry(3, lowOf(map));
    expect(g.top).toEqual([[0, -64], [32, -48], [0, -32], [-32, -48]]);
    expect(g.faces.map((f) => f.side).sort()).toEqual([0, 1, 2, 3]);
    const u = g.faces.find((f) => f.side === 0)!; // +u face: top edge at height 3, bottom edge at 0
    expect(u.poly).toEqual([[32, -48], [0, -32], [0, 16], [32, 0]]);
    expect(u.low).toBe(0);
    expect(g.minLow).toBe(0);
  });

  it("a 2-level drop keeps a flat top and a full cliff face (never a slope)", () => {
    const map = new TileMap(); fill3(map, 2, { "1,0": 0 });
    const g = c2dGroundGeometry(2, lowOf(map));
    expect(g.top).toEqual([[0, -48], [32, -32], [0, -16], [-32, -32]]);
    expect(g.faces).toHaveLength(1);
    expect(g.faces[0]!.poly).toEqual([[32, -32], [0, -16], [0, 16], [32, 0]]);
  });

  it("a water neighbour draws a 4 px cliff face (the 0.25 inset), a void neighbour draws none", () => {
    const map = new TileMap(); fill3(map, 0);
    map.setTile(1, 0, WATER); // +u neighbour is water: low -0.25
    const g = c2dGroundGeometry(0, lowOf(map));
    expect(g.faces).toHaveLength(1);
    expect(g.faces[0]!.side).toBe(0);
    expect(g.faces[0]!.low).toBe(-0.25);
    expect(g.faces[0]!.poly).toEqual([[32, 0], [0, 16], [0, 20], [32, 4]]); // 4 px tall
    const map2 = new TileMap(); fill3(map2, 1);
    map2.unloadChunk(0, 0); // every neighbour is void now
    const g2 = c2dGroundGeometry(1, (dx, dy) => c2dNeighbourLow(map2, dx, dy));
    expect(g2.faces).toEqual([]); // no giant void faces at the load edge (the mesh draws to NO_TILE_HEIGHT there)
  });

  it("cliff shades match the mesh (tilemap.ts cliffShade): +u 0.62, +v 0.8, far sides 0.28", () => {
    expect(c2dCliffShade(0)).toBe(0.62); expect(c2dCliffShade(2)).toBe(0.8);
    expect(c2dCliffShade(1)).toBe(0.28); expect(c2dCliffShade(3)).toBe(0.28);
  });

  it("gt height clamp + pads: worldgen relief is never clamped, shovel extremes compress monotonically", () => {
    expect(c2dClampHeight(26)).toBe(26); expect(c2dClampHeight(-300)).toBe(-C2D_GT_Z_CLAMP);
    expect(c2dClampHeight(326)).toBe(C2D_GT_Z_CLAMP); expect(c2dClampHeight(0)).toBe(0);
    expect(c2dGtPads(3, -2)).toEqual({ topPad: 48, botPad: 32 });
    expect(c2dGtPads(0, 0)).toEqual({ topPad: 0, botPad: 0 });
    expect(c2dGtPads(-5, -5)).toEqual({ topPad: 0, botPad: 80 }); // all below zero: no top pad, z = 0 stays put
  });

  it("gt near face below the skirt: the top level is covered by the cell's own 16 px skirt", () => {
    const poly = [[32, -32], [0, -16], [0, 16], [32, 0]] as [number, number][]; // +u face, z = 2 -> 0
    expect(c2dGtFaceBelowSkirt(poly)).toEqual([[32, -16], [0, 0], [0, 16], [32, 0]]); // top edge down 1 level
  });
});

/** Recording 2D context: captures every filled polygon with its style. */
class RecCtx {
  fills: { style: string; pts: [number, number][] }[] = [];
  fillStyle = "";
  private pts: [number, number][] = [];
  beginPath(): void { this.pts = []; }
  moveTo(x: number, y: number): void { this.pts.push([x, y]); }
  lineTo(x: number, y: number): void { this.pts.push([x, y]); }
  closePath(): void {}
  fill(): void { this.fills.push({ style: this.fillStyle, pts: this.pts }); this.pts = []; }
}
/** The flatTiles loop over an n x n view square (diagonal order), driving the shared drawing code. */
const drawFlatSquare = (map: TileMap, x0: number, y0: number, n: number, g: RecCtx): void => {
  for (let d = 0; d <= 2 * (n - 1); d++) for (let lx = Math.max(0, d - n + 1); lx <= Math.min(n - 1, d); lx++) {
    const x = x0 + lx, y = y0 + d - lx;
    const t = map.getTile(x, y); if (!t || t === WATER) continue;
    const z = c2dTileHeight(map, x, y); if (z === undefined) continue;
    const geom: C2DGroundGeom = c2dGroundGeometry(z, (dx, dy) => c2dNeighbourLow(map, x + dx, y + dy));
    // Screen centre of the tile (C2D: tile (x, y) sits on the view point (x, y), tileW 64 / tileH 32).
    drawC2DGroundCell(g as unknown as CanvasRenderingContext2D, geom, (x - y) * 32, (x + y) * 16, "top", (s) => `cliff${s}`);
  }
};

describe("ADR-414 flat-cell drawing on the console path", () => {
  it("distinct heights produce distinct output: a plateau draws 48 px above the low ground, with a cliff face closing the drop", () => {
    const map = new TileMap();
    for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) { map.setTile(x, y, GRASS); map.getChunk(Math.floor(x / 32), Math.floor(y / 32))!.setHeight(tileToLocal(x), tileToLocal(y), x >= 0 ? 3 : 0); }
    const g = new RecCtx(); drawFlatSquare(map, -2, -2, 5, g);
    const tops = g.fills.filter((f) => f.style === "top");
    // Tile (0,0) is the plateau edge (height 3): its top sits 48 px above the low ground's.
    const high = tops.find((f) => f.pts[0]![0] === 0 && f.pts[0]![1] === -64);
    const low = tops.find((f) => f.pts[0]![0] === -64 && f.pts[0]![1] === -48);
    expect(high).toBeDefined(); expect(low).toBeDefined();
    expect(high!.pts).toEqual([[0, -64], [32, -48], [0, -32], [-32, -48]]); // plateau top, lifted 3 levels
    expect(low!.pts).toEqual([[-64, -48], [-32, -32], [-64, -16], [-96, -32]]); // low ground, unlifted
    // The plateau edge tile (0,0)'s -u face (toward the low ground behind it) closes the 3-level drop.
    const far = g.fills.filter((f) => f.style === "cliff1");
    expect(far.some((f) => JSON.stringify(f.pts) === JSON.stringify([[0, -64], [-32, -48], [-32, 0], [0, -16]]))).toBe(true);
  });

  it("flat ground draws exactly the old diamonds (no regression when every height is 0)", () => {
    const map = new TileMap();
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) { map.setTile(x, y, GRASS); map.getChunk(0, 0)!.setHeight(tileToLocal(x), tileToLocal(y), 0); }
    const g = new RecCtx(); drawFlatSquare(map, 0, 0, 3, g);
    expect(g.fills).toHaveLength(9); // tops only: no faces on flat ground
    expect(g.fills.every((f) => f.style === "top")).toBe(true);
    const centre = g.fills.find((f) => f.pts[0]![0] === 0 && f.pts[0]![1] === 16); // tile (1,1): centre (0, 32)
    expect(centre!.pts).toEqual([[0, 16], [32, 32], [0, 48], [-32, 32]]);
  });
});

/** Recording 2D context for a full render() drive: captures every filled polygon with its style; every other
 *  method is a no-op (the flat fallback path only fills polygons, plus the sky fillRect / transform setup). */
function makeRenderCtx(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; fills: { style: string; pts: [number, number][] }[] } {
  const fills: { style: string; pts: [number, number][] }[] = [];
  const target: Record<string, unknown> = { fillStyle: "", globalAlpha: 1, canvas };
  const state = { pts: [] as [number, number][] };
  const universal = (..._a: unknown[]): unknown => proxy;
  const proxy = new Proxy(target, {
    get(t, p) {
      if (p === "beginPath") return () => { state.pts = []; };
      if (p === "moveTo") return (x: number, y: number) => { state.pts.push([x, y]); };
      if (p === "lineTo") return (x: number, y: number) => { state.pts.push([x, y]); };
      if (p === "closePath") return () => {};
      if (p === "fill") return () => { fills.push({ style: t.fillStyle as string, pts: state.pts }); state.pts = []; };
      if (p in t) return t[p as string];
      return universal;
    },
    set(t, p, v) { t[p as string] = v; return true; },
  });
  return { ctx: proxy as unknown as CanvasRenderingContext2D, fills };
}

/** Drive Canvas2DRenderer.render() on the console path (no registry -> flat fallback) and return the fills. */
function renderFills(map: TileMap): { style: string; pts: [number, number][] }[] {
  const canvas = { width: 0, height: 0, getContext: () => ({}) } as unknown as HTMLCanvasElement;
  const { ctx, fills } = makeRenderCtx(canvas);
  const r = new Canvas2DRenderer(canvas, ctx);
  r.resize(640, 480, 1);
  r.tilemap = map;
  const w = new World({ seed: 1 });
  const rc = r as unknown as { clock: number; clockAt: number };
  rc.clock = 0; rc.clockAt = -1; // pin the render clock (ADR-417's setClock trick)
  r.render(w, 1);
  return fills;
}

describe("ADR-414 Canvas2DRenderer.render() end-to-end (flat fallback, no registry)", () => {
  it("a 3-level plateau next to flat ground draws 48 px above it, with a cliff face closing the drop", () => {
    const map = new TileMap();
    for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) { map.setTile(x, y, GRASS); map.getChunk(Math.floor(x / 32), Math.floor(y / 32))!.setHeight(tileToLocal(x), tileToLocal(y), x >= 0 ? 3 : 0); }
    const fills = renderFills(map);
    const top = TILE_COLORS[TileId.Grass]!; // summer grass diamond colour
    const tops = fills.filter((f) => f.style === top);
    // Tile (0,0), the plateau edge: its top sits 48 px above the flat ground's.
    expect(tops.some((f) => JSON.stringify(f.pts) === JSON.stringify([[0, -64], [32, -48], [0, -32], [-32, -48]]))).toBe(true);
    // Tile (-1,0), flat ground next to it: the old unlifted diamond.
    expect(tops.some((f) => JSON.stringify(f.pts) === JSON.stringify([[-32, -32], [0, -16], [-32, 0], [-64, -16]]))).toBe(true);
    // The plateau edge tile (0,0)'s -u cliff face (grass [112,84,56] x the 0.28 far-side shade),
    // spanning the full 3-level drop from y -64 down to y 0.
    expect(fills.some((f) => f.style === "rgb(31,24,16)" && JSON.stringify(f.pts) === JSON.stringify([[0, -64], [-32, -48], [-32, 0], [0, -16]]))).toBe(true);
    expect(fills.some((f) => f.style !== top)).toBe(true); // a cliff-face fill, not just tops
  });

  it("a second render of an all-flat map produces the old diamonds (regression)", () => {
    const map = new TileMap();
    for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) { map.setTile(x, y, GRASS); map.getChunk(Math.floor(x / 32), Math.floor(y / 32))!.setHeight(tileToLocal(x), tileToLocal(y), 0); }
    const fills = renderFills(map);
    const top = TILE_COLORS[TileId.Grass]!;
    expect(fills).toHaveLength(25); // tops only: no faces on flat ground
    expect(fills.every((f) => f.style === top)).toBe(true);
    expect(fills.some((f) => JSON.stringify(f.pts) === JSON.stringify([[0, -16], [32, 0], [0, 16], [-32, 0]]))).toBe(true); // tile (0,0)
  });
});
