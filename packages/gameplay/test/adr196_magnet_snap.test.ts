import { describe, it, expect } from "vitest";
import { type Entity, type World } from "@engine/core";
import { pieceCost, addItem, buildPreviewFor, defaultDefs, placePiece, snapPlacement, spawnPlayer } from "../src/index.js";
import { makeWorld, plantClaim, spawnLearned } from "./helpers.js";

const d = defaultDefs(); const id = (k: string) => d.pieceId(k);
function place(w: World, b: Entity, key: string, x: number, y: number, level = 0): Entity {
  const sn = snapPlacement(w, { piece: id(key), x, y, level, rot: 0, tier: 1, variant: 0 }); if (typeof sn === "number") throw new Error(`snap ${key} ${sn}`);
  return placePiece(w, b, sn, { pay: false });
}
const sel = (k: string) => ({ piece: id(k), tier: 1, variant: 0, paint: 0 });
function setup() { const w = makeWorld(); const p = spawnLearned(w, { x: 5.5, y: 8.5 }); for (const k of ['foundation','wall','floor']) for (const c of pieceCost(d, d.pieces.get(d.pieceId(k))!, 1)) addItem(w, p, c.item, c.count * 4); plantClaim(w, p, 10, 4); return { w, p }; } // ADR-310: a claim covering the test cells, clear of them

describe("ADR-196 structural magnet snap", () => {
  it("aiming inside an existing foundation keeps the red 'spot taken' (no surprise jump)", () => {
    const { w, p } = setup(); place(w, p, "foundation", 6.5, 5.5);
    const g = buildPreviewFor(w, p, sel("foundation"), 0, { mode: 1, x: 6.9, y: 5.5 }, 0)!;
    expect(g.valid).toBe(false); expect(g.reason).toBe(8); expect(g.magnet).toBeFalsy();
  });
  it("an isolated aim within ~0.5 tile of a neighbour's cell is pulled flush (no 1-tile gap)", () => {
    const { w, p } = setup(); place(w, p, "foundation", 4.5, 5.5);
    const g = buildPreviewFor(w, p, sel("foundation"), 0, { mode: 1, x: 6.2, y: 5.5 }, 0)!; // aim in cell 6, 0.2 past cell 5
    expect([g.x, g.y]).toEqual([5.5, 5.5]); expect(g.snapEdge).toBeDefined();
  });
  it("snap off never pulls", () => {
    const { w, p } = setup(); place(w, p, "foundation", 4.5, 5.5);
    const g = buildPreviewFor(w, p, sel("foundation"), 0, { mode: 1, x: 6.2, y: 5.5 }, 0, false)!;
    expect(g.magnet).toBeUndefined(); expect(g.x).toBe(6.5);
  });
  it("far from structure: no magnet, plain grid snap", () => {
    const { w, p } = setup(); place(w, p, "foundation", 2.5, 2.5);
    const g = buildPreviewFor(w, p, sel("foundation"), 0, { mode: 1, x: 7.5, y: 7.5 }, 0)!;
    expect(g.magnet).toBeUndefined(); expect(g.snapEdge).toBeUndefined(); expect([g.x, g.y]).toEqual([7.5, 7.5]);
  });
  it("a wall highlights the foundation edge it sits on", () => {
    const { w, p } = setup(); for (const x of [5.5, 6.5, 7.5]) place(w, p, "foundation", x, 5.5); // ADR-211: not a corner slot
    const g = buildPreviewFor(w, p, sel("wall"), 0, { mode: 1, x: 6.5, y: 5.1 }, 0)!;
    expect(g.valid).toBe(true); expect(g.snapEdge).toEqual({ x0: 6, y0: 5, x1: 7, y1: 5 });
  });
});
