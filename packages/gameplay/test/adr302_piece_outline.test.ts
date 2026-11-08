import { describe, expect, it } from "vitest";
import { installPermissions, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

const d = G.defaultDefs();
function setup() {
  const w = makeWorld(); installPermissions(w);
  const me = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 });
  return { w, me };
}
function place(w: World, key: string, x: number, y: number): Entity {
  const sn = G.snapPlacement(w, { piece: d.pieceId(key), x, y, level: 0, rot: 0, tier: 1, variant: 0 });
  if (typeof sn === "number") throw new Error(`snap ${key} ${sn}`);
  return G.placePiece(w, 0, sn, { pay: false });
}
const span = (segs: { x0: number; y0: number; x1: number; y1: number }[]) => {
  const xs = segs.flatMap((s) => [s.x0, s.x1]), ys = segs.flatMap((s) => [s.y0, s.y1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};

describe("ADR-302 piece footprint outline", () => {
  it("puts the claim flag in the crafting (Hand Crafted) category", () => {
    expect(d.piece("claim_totem").category).toBe("crafting");
    expect(d.piece("clan_flag").category).toBe("decor");
  });
  it("outlines a foundation as a 1×1 cell rectangle", () => {
    const { w } = setup();
    const e = place(w, "foundation", 1, 1);
    const out = G.pieceFootprintOutline(w, e)!;
    expect(out.segments).toHaveLength(4);
    expect(span(out.segments)).toEqual({ x0: 1, y0: 1, x1: 2, y1: 2 });
  });
  it("outlines a wall as a single edge segment", () => {
    const { w } = setup();
    place(w, "foundation", 1, 1);
    const wall = place(w, "wall", 1, 1);
    const out = G.pieceFootprintOutline(w, wall)!;
    expect(out.segments).toHaveLength(1);
    const s = out.segments[0]!;
    expect(s.x0 === s.x1 || s.y0 === s.y1).toBe(true);
    expect(Math.abs(s.x1 - s.x0) + Math.abs(s.y1 - s.y0)).toBe(1);
  });
  it("outlines free-placement furniture from its footprint", () => {
    const { w } = setup();
    const e = place(w, "claim_totem", 0.5, 3.5);
    const out = G.pieceFootprintOutline(w, e)!;
    expect(out.segments.length).toBeGreaterThanOrEqual(4);
    const box = span(out.segments);
    expect(box.x1 - box.x0).toBeGreaterThan(0);
    expect(box.y1 - box.y0).toBeGreaterThan(0);
  });
});
