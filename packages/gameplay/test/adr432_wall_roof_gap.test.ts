import { describe, expect, it } from "vitest";
import { TileMap } from "@engine/world";
import { FLOOR_HEIGHT_LEVELS, floorToTerrainZ } from "@engine/world";
import { Transform } from "@engine/core";
import * as G from "../src/index.js";
import { ensureClaim, makeWorld, spawnLearned } from "./helpers.js";

/**
 * ADR-432 (player-level companion to apps/client/test/adr432_wall_roof_gap.test.ts): the
 * wall/roof gap is buildable by players, not just a ruin-rendering quirk. On the same heights
 * as the client test — a flat 5x5 footprint at level 3 whose south row (y=9) and east column
 * (x=9) drop to level 2 — a player can place a foundation row, a wall along the south edge and
 * a roof_flat at level 1, and every placement returns ok (no BuildFail.Terrain: a one-level
 * drop across the footprint boundary is not a slope failure). The gap itself is render-side
 * (pieceBoundaryGroundZ grounds the wall on the min touching tile, the roof on its own tile),
 * so this file pins the sim-side geometry in the same terms: the wall-top/roof pair computed
 * from TerrainRes.heightAt differs by exactly 1 level, and the placed pieces sit on the exact
 * anchors the client test renders (wall Transform (6.5, 9, 0), roof Transform (6.5, 8.5, 3)).
 */
function setup() {
  const w = makeWorld(), map = new TileMap();
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) map.setTile(x, y, 3);
  w.setResource(G.TerrainRes, G.terrainFromTileMap(map));
  const terrain = w.resource(G.TerrainRes);
  // Flat 5x5 footprint x 4..8, y 4..8 at level 3; the outside drops to 2 on the south and east.
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) terrain.setRawHeight!(x, y, 3);
  for (let x = 4; x <= 8; x++) terrain.setRawHeight!(x, 9, 2);
  for (let y = 4; y <= 8; y++) terrain.setRawHeight!(9, y, 2);
  terrain.setRawHeight!(9, 9, 2);
  const p = spawnLearned(w, { x: 6.5, y: 6.5, maxWeight: 0 }); // unlimited carry: 500 planks would hit the default weight cap and starve the rope below
  for (const k of ["planks", "rope"]) G.addItem(w, p, G.gameplayDefs(w).itemId(k), 500);
  ensureClaim(w, p, 6, 0);
  return { w, p, terrain };
}
const d = G.gameplayDefs;
const place = (w: ReturnType<typeof makeWorld>, p: ReturnType<typeof spawnLearned>, key: string, x: number, y: number, level = 0) =>
  G.tryPlace(w, p, { piece: d(w).pieceId(key), x, y, level, rot: 0, tier: 1, variant: 0 });

describe("ADR-432 the wall/roof gap is buildable by players", () => {
  it("a foundation row, a south-edge wall and a level-1 roof all place ok on the stepped footprint", () => {
    const { w, p } = setup();
    for (let x = 4; x <= 8; x++) {
      const r = place(w, p, "foundation", x + 0.5, 8.5);
      expect(r.ok, `foundation at ${x + 0.5},8.5`).toBe(true);
    }
    const wall = place(w, p, "wall", 6.5, 9);
    expect(wall.ok, `wall at 6.5,9: ${JSON.stringify(wall)}`).toBe(true);
    const roof = place(w, p, "roof_flat", 6.5, 8.5, 1);
    expect(roof.ok, `roof_flat at 6.5,8.5 level 1: ${JSON.stringify(roof)}`).toBe(true);
    // The placed pieces sit on the exact anchors the client test renders.
    if (wall.ok) {
      const t = w.get(wall.piece, Transform)!;
      expect([t.x, t.y, t.z]).toEqual([6.5, 9, 0]);
    }
    if (roof.ok) {
      const t = w.get(roof.piece, Transform)!;
      expect([t.x, t.y, t.z]).toEqual([6.5, 8.5, FLOOR_HEIGHT_LEVELS]);
    }
  });

  it("the rendered pair differs by 1 level on the sim heights (the gap, in sim terms)", () => {
    const { terrain } = setup();
    // Wall anchor (6.5, 9) touches tiles (6,8)=3 and (6,9)=2: the renderer's boundary read
    // takes the min, 2, so the wall top is floorToTerrainZ(0, 2) + 3 = 5 …
    const wallBase = Math.min(terrain.heightAt(6, 8), terrain.heightAt(6, 9));
    const wallTop = floorToTerrainZ(0, wallBase) + FLOOR_HEIGHT_LEVELS;
    // …while the roof over cell (6,8) sits on its own tile, 3: floorToTerrainZ(1, 3) = 6.
    const roofZ = floorToTerrainZ(1, terrain.heightAt(6, 8));
    expect(wallBase).toBe(2);
    expect(wallTop).toBe(5);
    expect(roofZ).toBe(6);
    expect(roofZ - wallTop).toBe(1); // 1 level = 16 px of see-through gap
    // Same on the east wall anchor (9, 6.5): min(3, 2) = 2 against the roof's 6.
    const eastBase = Math.min(terrain.heightAt(8, 6), terrain.heightAt(9, 6));
    expect(floorToTerrainZ(0, eastBase) + FLOOR_HEIGHT_LEVELS).toBe(5);
    expect(floorToTerrainZ(1, terrain.heightAt(8, 6))).toBe(6);
    // Control: the north wall's outside neighbour is level with the footprint, so no gap.
    const northBase = Math.min(terrain.heightAt(6, 3), terrain.heightAt(6, 4));
    expect(floorToTerrainZ(0, northBase) + FLOOR_HEIGHT_LEVELS).toBe(floorToTerrainZ(1, terrain.heightAt(6, 4)));
  });
});
