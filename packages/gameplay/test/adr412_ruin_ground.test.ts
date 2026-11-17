import { describe, expect, it } from "vitest";
import { Transform } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

/**
 * ADR-412: abandoned-structure corners/walls floated when the ruin was bumped up against raised
 * ground. Root cause (pinned here on the gameplay side): the pieces anchor exactly on the footprint
 * boundary lines and carry story level only — no terrain height — so the renderer's single-tile
 * floor() read lifts them onto the neighbour tile. The fix is render-side (pieceBoundaryGroundZ in
 * apps/client/src/view.ts), which grounds every already-stamped piece in place; these tests pin the
 * geometry that makes the fix necessary and the gate behaviour that must NOT change (a flat footprint
 * next to raised ground still stamps — the fix is grounding, not skipping the site).
 */
function stepTerrain(w: ReturnType<typeof makeWorld>, h: (x: number, y: number) => number): void {
  w.setResource(G.TerrainRes, { tileAt: () => 3, heightAt: h, loaded: () => true });
}

describe("ADR-412 ruin corners and walls anchor on the footprint boundary", () => {
  it("a flat footprint next to raised ground still stamps (neighbours do not gate the site)", () => {
    const w = makeWorld();
    // Footprint x 8..12, y 8..12 at level 2; raised level 5 starts at x/y 13, just OUTSIDE it.
    stepTerrain(w, (x, y) => (x >= 13 || y >= 13 ? 5 : 2));
    expect(G.siteTerrainOk(w, 8, 8, 5, 5)).toBe(true);
    const r = G.stampAbandonedSite(w, 8, 8, { kind: G.AbandonedKind.Cottage, rot: 0, ruin: 0, tier: 1 });
    G.drainAbandonedStamps(w);
    expect(r.skipped).toBe(false);
    expect(r.marker).not.toBe(0);
  });

  it("corners anchor on the four vertices and south/east walls on the boundary lines", () => {
    const w = makeWorld();
    stepTerrain(w, (x, y) => (x >= 13 || y >= 13 ? 5 : 2));
    const r = G.stampAbandonedSite(w, 8, 8, { kind: G.AbandonedKind.Cottage, rot: 0, ruin: 0, tier: 1 });
    G.drainAbandonedStamps(w);
    expect(r.skipped).toBe(false);
    const walls: { key: string; x: number; y: number }[] = [];
    for (const e of w.query([G.BuildPiece, Transform])) {
      const def = G.gameplayDefs(w).pieces.get(w.getField(e, G.BuildPiece, "type")!)!;
      if (def.key === "wall" || def.key === "wall_corner_outer") {
        const t = w.get(e, Transform)!;
        walls.push({ key: def.key, x: t.x, y: t.y });
      }
    }
    expect(walls.length).toBeGreaterThan(0);
    // Cottage is 5x5 at origin (8,8): every wall/corner anchor sits on a boundary line (8 or 13).
    for (const p of walls) expect(p.x === 8 || p.x === 13 || p.y === 8 || p.y === 13).toBe(true);
    const corners = walls.filter((p) => p.key === "wall_corner_outer");
    expect(corners.map((p) => `${p.x},${p.y}`).sort()).toEqual(["13,13", "13,8", "8,13", "8,8"]);
    // Three of the four corners floor onto raised tiles under the old single-tile read…
    expect(corners.filter((p) => Math.floor(p.x) >= 13 || Math.floor(p.y) >= 13)).toHaveLength(3);
    // …and the south/east straight walls anchor on the raised side too.
    expect(walls.some((p) => p.key === "wall" && p.y === 13)).toBe(true);
    expect(walls.some((p) => p.key === "wall" && p.x === 13)).toBe(true);
  });

  it("stamped pieces carry story level only — no terrain height, so the render fix covers old ruins", () => {
    const w = makeWorld();
    stepTerrain(w, (x, y) => (x >= 13 || y >= 13 ? 5 : 2));
    const r = G.stampAbandonedSite(w, 8, 8, { kind: G.AbandonedKind.Cottage, rot: 0, ruin: 0, tier: 1 });
    G.drainAbandonedStamps(w);
    expect(r.skipped).toBe(false);
    const lh = G.gameplayDefs(w).building.levelHeight;
    for (const e of w.query([G.BuildPiece, Transform])) {
      const t = w.get(e, Transform)!;
      // z is exactly story * levelHeight (0 for ground floor): the terrain lift is entirely
      // the renderer's, so grounding it there fixes pieces stamped before ADR-412 as well.
      expect(t.z % lh).toBe(0);
      expect(t.z).toBeGreaterThanOrEqual(0);
    }
  });
});
