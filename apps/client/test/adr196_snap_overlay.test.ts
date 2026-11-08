import { describe, it, expect } from "vitest";
import { snapOverlayLines, targetOverlayLines, SNAP_COLORS } from "../src/snap-overlay.js";

const cam = { x: 0, y: 0, viewW: 800, viewH: 600, dpr: 1, drawZoom: 1, cssToWorld: (x: number, y: number) => ({ x, y }) };
const base = { pieceKey: "foundation", piece: 1, tier: 1, variant: 0, paint: 0, x: 7.5, y: 5.5, level: 0, z: 0, rot: 0, rotSteps: 4, reason: 0, request: { x: 7.5, y: 5.5, rot: 0 } };
const outline = [{ x0: 7, y0: 5, x1: 8, y1: 5 }, { x0: 8, y0: 5, x1: 8, y1: 6 }, { x0: 7, y0: 6, x1: 8, y1: 6 }, { x0: 7, y0: 5, x1: 7, y1: 6 }];

describe("ADR-196 snap overlay", () => {
  it("valid magnet ghost: green outline + thick yellow shared edge on top", () => {
    const l = snapOverlayLines({ ...base, valid: true, magnet: true, outline, snapEdge: { x0: 7, y0: 5, x1: 7, y1: 6 } }, cam);
    expect(l).toHaveLength(5); expect(l.slice(0, 4).every((q) => q.color === SNAP_COLORS.valid)).toBe(true);
    expect(l[4]!.color).toBe(SNAP_COLORS.edge); expect(l[4]!.width).toBeGreaterThan(l[0]!.width);
  });
  it("invalid ghost: red outline, no edge highlight", () => {
    const l = snapOverlayLines({ ...base, valid: false, reason: 8, outline, snapEdge: { x0: 7, y0: 5, x1: 7, y1: 6 } }, cam);
    expect(l).toHaveLength(4); expect(l.every((q) => q.color === SNAP_COLORS.invalid)).toBe(true);
  });
  it("nothing without a preview", () => { expect(snapOverlayLines(undefined, cam)).toEqual([]); });
  it("ADR-302: aimed piece outline is amber and thicker than the ghost", () => {
    const l = targetOverlayLines({ segments: outline, z: 0 }, cam);
    expect(l).toHaveLength(4); expect(l.every((q) => q.color === SNAP_COLORS.target)).toBe(true);
    expect(l[0]!.width).toBeGreaterThan(2);
    expect(targetOverlayLines(undefined, cam)).toEqual([]);
  });
});
