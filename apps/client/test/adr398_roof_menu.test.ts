import { describe, expect, it } from "vitest";
import { roofMenu, roofMenuLabel, rfxFormsWithArt } from "../src/roof-menu.js";

const all = ["wall", "roof_flat", "roof_slope", "roof_gable", "roof_corner", "roof_hip", "roof_chimney", "roof_cottage", "roof_gambrel", "roof_shed"].map((key) => ({ key }));
const keys = (f: string[]) => roofMenu(all, new Set(f)).map((p) => p.key);

describe("ADR-398 build menu: one roof entry per form", () => {
  it("before any rfx art: the legacy list, minus the new forms (they have no art yet)", () => {
    expect(keys([])).toEqual(["wall", "roof_flat", "roof_slope", "roof_gable", "roof_corner", "roof_hip", "roof_chimney"]);
    expect(roofMenuLabel("roof_slope", new Set())).toBe("roof slope");
  });
  it("hip art ships: corner and hip leave the menu (picked automatically), slope reads hip roof", () => {
    expect(keys(["hip", "gab", "flt"])).toEqual(["wall", "roof_flat", "roof_slope", "roof_gable", "roof_chimney"]);
    expect(roofMenuLabel("roof_slope", new Set(["hip"]))).toBe("hip roof"); expect(roofMenuLabel("roof_gable", new Set(["gab"]))).toBe("gable roof");
  });
  it("each new form appears once its own art ships", () => {
    expect(keys(["hip", "gam"])).toContain("roof_gambrel"); expect(keys(["hip", "gam"])).not.toContain("roof_shed");
    expect(roofMenuLabel("roof_shed", new Set(["shd"]))).toBe("shed roof");
  });
  it("forms with art are read from the registry's rfx_ keys", () => {
    const reg = { allSprites: () => [{ key: "rfx_hip_lo_e_t1" }, { key: "rfx_gam_wall_lo_t2" }, { key: "bld_roof_slope_t1" }, { key: "rfx_chimney_t1" }] };
    expect([...rfxFormsWithArt(reg)].sort()).toEqual(["gam", "hip"]);
    expect(rfxFormsWithArt(undefined).size).toBe(0);
  });
});
