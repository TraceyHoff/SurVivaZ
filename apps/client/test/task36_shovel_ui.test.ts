// ADR-263 (Task 36): shovel target per device + underground darkness easing.
import { describe, expect, it } from "vitest";
import { RAMP_LENGTHS, rampDir, rampPrompt, rampTiles, shovelPrompt, shovelTarget } from "../src/world-tools.js";
import { easeUnderground, undergroundTarget } from "../src/underground.js";

describe("ADR-263 shovel controls", () => {
  const body = { x: 10.5, y: 10.5, facing: 0 }; // facing +x
  it("keyboard/mouse digs the hovered tile within reach, else the faced tile; touch / gamepad use the faced tile", () => {
    expect(shovelTarget("keyboardMouse", body, { x: 12, y: 9 })).toEqual({ x: 12, y: 9 });
    expect(shovelTarget("keyboardMouse", body, { x: 20, y: 20 })).toEqual({ x: 11, y: 10 });
    expect(shovelTarget("touch", body, { x: 12, y: 9 })).toEqual({ x: 11, y: 10 });
    expect(shovelTarget("gamepad", { ...body, facing: Math.PI / 2 }, undefined)).toEqual({ x: 10, y: 11 });
  });
  it("prompts name the controls per device", () => {
    expect(shovelPrompt("keyboardMouse")).toMatch(/Y raise.*H dig/);
    expect(shovelPrompt("gamepad")).toMatch(/LT \+ D-pad ↑ raise/);
    expect(shovelPrompt("touch")).toMatch(/Raise.*Dig/);
  });
  it("darkness target: none on the surface, a little in shallow pits, full from 3 levels down; eased", () => {
    expect(undergroundTarget(0)).toBe(0); expect(undergroundTarget(2)).toBeCloseTo(0.3); expect(undergroundTarget(3)).toBe(1); expect(undergroundTarget(25)).toBe(1);
    let u = 0; for (let i = 0; i < 60; i++) u = easeUnderground(u, 1, 1 / 60); expect(u).toBeGreaterThan(0.99);
    expect(easeUnderground(0.5, 0, 0)).toBe(0.5);
  });
});

describe("ADR-419 ramp controls", () => {
  const body = { x: 10.5, y: 10.5, facing: 0 }; // facing +x
  it("direction follows the hovered tile's dominant axis, else the snapped facing", () => {
    expect(rampDir(body, { x: 12, y: 11 })).toEqual({ dx: 1, dy: 0 });
    expect(rampDir(body, { x: 9, y: 13 })).toEqual({ dx: 0, dy: 1 });
    expect(rampDir(body, undefined)).toEqual({ dx: 1, dy: 0 });
    expect(rampDir({ ...body, facing: Math.PI }, undefined)).toEqual({ dx: -1, dy: 0 });
    expect(rampDir({ ...body, facing: -Math.PI / 2 }, undefined)).toEqual({ dx: 0, dy: -1 });
  });
  it("the graded tiles run 1..|delta| from the foot tile (the foot itself is unchanged)", () => {
    expect(rampTiles({ x: 10, y: 10 }, 1, 0, 3)).toEqual([{ x: 11, y: 10 }, { x: 12, y: 10 }, { x: 13, y: 10 }]);
    expect(rampTiles({ x: 10, y: 10 }, 0, -1, -2)).toEqual([{ x: 10, y: 9 }, { x: 10, y: 8 }]);
    expect(RAMP_LENGTHS).toEqual([2, 3, 4, 6]);
  });
  it("prompts name the ramp length and the grade-up / grade-down controls per device", () => {
    expect(rampPrompt("keyboardMouse", 3)).toMatch(/Ramp 3.*Y grade up 3.*H grade down 3/);
    expect(rampPrompt("gamepad", 4)).toMatch(/Ramp 4.*LT \+ Y/);
    expect(rampPrompt("touch", 2)).toMatch(/Ramp 2/);
  });
});
