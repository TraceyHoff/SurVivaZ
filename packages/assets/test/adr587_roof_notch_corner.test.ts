import { describe, expect, it } from "vitest";
import { rfxPickLevel, rfxCell, type RfxTile } from "../src/roofRfx.js";

/**
 * ADR-587: a band-0 hip tile with three open cardinal sides is a hip END ('h') when the
 * roof really ends there (a 1-wide strip end: both diagonals beside its one present
 * neighbour are open too), but a NOTCH CORNER when the region continues diagonally beside
 * that neighbour — then it must pick the 'o' corner over the two open sides away from the
 * turn, or its end part leaves the corner post and wall ends below it bare (the ADR-587
 * dump measurement: back wall wedge 4-9 px, corner post bare in 42 of 55 columns).
 */
const T = (x: number, y: number, key = "roof_hip", rot = 0): RfxTile => ({ x, y, key, rot, tier: 1 });
const pick = (tiles: RfxTile[], x: number, y: number) => rfxPickLevel(tiles, 5).get(rfxCell(x, y))!;

describe("ADR-587 notch-corner roof picks", () => {
  it("the player's house (6 of 9 roof tiles): notch corners pick 'o', matching the completed roof", () => {
    const asis = [
      T(-56, -140, "roof_hip", 3), T(-55, -140, "roof_hip", 3), T(-54, -140, "roof_hip", 3),
      T(-56, -139, "roof_gable", 1), T(-55, -139, "roof_gable", 1),
      T(-55, -138, "roof_hip", 1),
    ];
    // NE tile: present neighbour W, SW diagonal filled (the centre tile) -> corner over N+E.
    expect(pick(asis, -54, -140)).toMatchObject({ shape: "o", row: 3 });
    // Front-middle tile: present neighbour N, NW diagonal filled -> corner over E+S.
    expect(pick(asis, -55, -138)).toMatchObject({ shape: "o", row: 0 });
    // Untouched classes: NW corner was already 'o'; the W-middle stays 'o' (S+W open mask).
    expect(pick(asis, -56, -140)).toMatchObject({ shape: "o", row: 2 });
    expect(pick(asis, -56, -139)).toMatchObject({ shape: "o", row: 1 });
  });

  it("a true 1-wide strip end keeps 'h' (both diagonals beside the present neighbour open)", () => {
    const strip = [T(0, 0), T(1, 0), T(2, 0)]; // E-W strip; the east end tile has only W present
    expect(pick(strip, 2, 0)).toMatchObject({ shape: "h", row: 3 });
    expect(pick(strip, 0, 0)).toMatchObject({ shape: "h", row: 1 });
  });

  it("both diagonals filled (region on both sides) keeps 'h' — no single turn to follow", () => {
    // Present neighbour W; NW and SW diagonals both filled (a T-junction end).
    const tiles = [T(0, 0), T(-1, 0), T(-1, -1), T(-1, 1), T(0, -1), T(0, 1)];
    // (0,0) has N and S present too, so it is not a 3-open tile at all; use the tile at
    // (0,-1): neighbours E open, S present... construct the exact case instead below.
    expect(pick(tiles, 0, 0).shape).not.toBe("h");
    const t2 = [T(0, 0), T(-1, 0), T(-1, -1), T(-1, 1)]; // W present; NW+SW filled; N,E,S open
    expect(pick(t2, 0, 0)).toMatchObject({ shape: "h", row: 3 });
  });

  it("upper bands are untouched: the re-pick is band-0 only", () => {
    // 4x3 block: tile (1,1) is band 1 with three lower cardinal sides (an 'h' by the
    // table). At band >= 1 the diagonal bits mean "lower band", not "absent", and 'h'
    // is a slope junction, not an eave — it must stay 'h'.
    const tiles: RfxTile[] = [];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) tiles.push(T(x, y));
    const t = pick(tiles, 1, 1);
    expect(t.band).toBe(1);
    expect(t.shape).toBe("h");
  });
});
