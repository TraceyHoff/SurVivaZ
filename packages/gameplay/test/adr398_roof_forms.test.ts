import { describe, expect, it } from "vitest";
import { AbandonedKind, ROOF_FORMS, RoofStyle, planAbandonedSite, roofFormStyle } from "../src/building/abandoned.js";
import { defaultDefs } from "../src/data.js";

describe("ADR-398 continuous-roof forms on abandoned sites", () => {
  it("the new pieces exist as tiered cell roofs (appended, so older piece ids are unchanged)", () => {
    const d = defaultDefs(); const keys = [...d.pieces.values()].map((p) => p.key);
    expect(keys.slice(-3)).toEqual(["roof_cottage", "roof_gambrel", "roof_shed"]);
    for (const k of ["roof_cottage", "roof_gambrel", "roof_shed"]) { const p = d.pieces.get(d.pieceId(k))!; expect(p.roof).toBe(true); expect(p.tiered).toBe(true); }
  });
  it("ADR-400: live with Art's rfx pages; mapped kinds get their form, the others keep their ADR-311 pick", () => {
    expect(ROOF_FORMS.live).toBe(true);
    for (let s = 0; s < 40; s++) {
      const roofs = planAbandonedSite(s, 0, 0, { kind: AbandonedKind.Barn }).pieces.filter((p) => p.role === "roof" && p.key !== "roof_chimney");
      expect(roofs.length).toBeGreaterThan(0); expect(roofs.some((p) => p.key === "roof_gambrel")).toBe(true);
      for (const p of planAbandonedSite(s, 0, 0, { kind: AbandonedKind.Manor }).pieces) expect(["roof_gambrel", "roof_shed", "roof_cottage"]).not.toContain(p.key);
    }
    const off = { ...ROOF_FORMS, live: false };
    for (const k of Object.values(AbandonedKind)) expect(roofFormStyle(k, off)).toBeUndefined();
  });
  it("when live: barn / mill / stable -> gambrel, shed / hunter shack -> shed, cottage / farmhouse -> cottage", () => {
    const live = { ...ROOF_FORMS, live: true };
    expect(roofFormStyle(AbandonedKind.Barn, live)).toBe(RoofStyle.Gambrel); expect(roofFormStyle(AbandonedKind.Mill, live)).toBe(RoofStyle.Gambrel); expect(roofFormStyle(AbandonedKind.Stable, live)).toBe(RoofStyle.Gambrel);
    expect(roofFormStyle(AbandonedKind.Shed, live)).toBe(RoofStyle.Shed); expect(roofFormStyle(AbandonedKind.HunterShack, live)).toBe(RoofStyle.Shed);
    expect(roofFormStyle(AbandonedKind.Cottage, live)).toBe(RoofStyle.Cottage); expect(roofFormStyle(AbandonedKind.Farmhouse, live)).toBe(RoofStyle.Cottage);
    expect(roofFormStyle(AbandonedKind.Manor, live)).toBeUndefined();
  });
  it("a forced form roofs the whole top story with that piece; the rest of the plan is unchanged", () => {
    for (const [style, key] of [[RoofStyle.Gambrel, "roof_gambrel"], [RoofStyle.Shed, "roof_shed"], [RoofStyle.Cottage, "roof_cottage"]] as const) {
      const a = planAbandonedSite(7, 10, 20, { kind: AbandonedKind.Barn, roof: style }); const f = planAbandonedSite(7, 10, 20, { kind: AbandonedKind.Barn, roof: RoofStyle.Flat });
      const roofs = a.pieces.filter((p) => p.role === "roof"); expect(roofs.length).toBeGreaterThan(0);
      for (const p of roofs) expect(p.key).toBe(key);
      expect(a.pieces.filter((p) => p.role !== "roof")).toEqual(f.pieces.filter((p) => p.role !== "roof"));
      expect(a.roofStyle).toBe(style);
    }
  });
});
