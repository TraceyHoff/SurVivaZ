import { describe, it, expect } from "vitest";
import { LEGACY_FLOOR_LEVELS, legacyFloorZ, standFloor } from "../src/building/legacy_floors.js";

// ADR-514: pre-ADR-511 saves store z on 3-level floors; the floor is 5 levels now.
describe("ADR-514 legacy floor heights", () => {
  const lh = 5, max = 7;
  it("moves a 3-level floor stand height to the same floor on the 5-level grid", () => {
    expect(LEGACY_FLOOR_LEVELS).toBe(3);
    expect(legacyFloorZ(3.3125, lh, max)).toBeCloseTo(5.3125, 9); // 1st floor deck
    expect(legacyFloorZ(6.3125, lh, max)).toBeCloseTo(10.3125, 9); // 2nd floor deck
    expect(legacyFloorZ(3.75, lh, max)).toBeCloseTo(5.75, 9); // foundation deck on floor 1
    expect(legacyFloorZ(9, lh, max)).toBeCloseTo(15, 9); // bare floor 3 height
  });
  it("keeps current heights, the ground floor and in-between z (mid-stairs / falling)", () => {
    for (const z of [0, 0.3125, 0.75, 5.3125, 10.3125, 10.75, 20]) expect(legacyFloorZ(z, lh, max)).toBeUndefined();
    for (const z of [1.7, 4.2, 7.9]) expect(legacyFloorZ(z, lh, max)).toBeUndefined(); // on a ramp: the settle handles it
    expect(legacyFloorZ(3.3125, LEGACY_FLOOR_LEVELS, max)).toBeUndefined(); // grid unchanged
    expect(legacyFloorZ(27, lh, max)).toBeUndefined(); // old floor 9 > maxLevel: not a 3-level floor height
  });
  it("is idempotent: a re-seated height is left alone on the next load", () => {
    for (const z of [3.3125, 6.3125, 3.75, 9.375]) { const z1 = legacyFloorZ(z, lh, max)!; expect(standFloor(z1, lh)).toBeGreaterThan(0); expect(legacyFloorZ(z1, lh, max)).toBeUndefined(); }
  });
  it("uses the decks under the tile when the structures are loaded", () => {
    // 3-level floor 2 with a deck there, nothing at 5-level floor 2 -> moves
    expect(legacyFloorZ(6.3125, lh, max, (f) => f === 2)).toBeCloseTo(10.3125, 9);
    // structures loaded but no deck at the 3-level floor: keep (never drop it into a void)
    expect(legacyFloorZ(6.3125, lh, max, () => false)).toBeUndefined();
    // ambiguous z = 15.3125 (5-level floor 3, 3-level floor 5): keep unless only floor 5 has a deck
    expect(legacyFloorZ(15.3125, lh, max)).toBeUndefined();
    expect(legacyFloorZ(15.3125, lh, max, (f) => f === 3)).toBeUndefined();
    expect(legacyFloorZ(15.3125, lh, max, (f) => f === 5)).toBeCloseTo(25.3125, 9);
  });
});
