import { describe, expect, it } from "vitest";
import { RFX, rfxCell, rfxHashU32, rfxPickLevel, rfxRegionForm, rfxShapeOf, rfxSpriteKeys, rfxVariant, rfxZoff, type RfxConfig, type RfxTile } from "../src/roofRfx.js";

const rect = (key: string, w: number, h: number, rot = 0, tier = 1, x0 = 0, y0 = 0): RfxTile[] => {
  const out: RfxTile[] = []; for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) out.push({ x, y, key, rot, tier }); return out;
};
const at = (m: ReturnType<typeof rfxPickLevel>, x: number, y: number) => m.get(rfxCell(x, y))!;
const base = (stem: string) => stem.replace(/_v\d$/, "");

describe("ADR-397 rfx selection (Art's ART_KEYS_ROOFS.md §4)", () => {
  it("shape and row for all 16 n values plus the inner-corner rows", () => {
    const T: Record<number, [string, number]> = { 4: ["e", 0], 8: ["e", 1], 1: ["e", 2], 2: ["e", 3], 6: ["o", 0], 12: ["o", 1], 9: ["o", 2], 3: ["o", 3], 5: ["r", 0], 10: ["r", 1], 14: ["h", 0], 13: ["h", 1], 11: ["h", 2], 7: ["h", 3], 15: ["p", 0] };
    for (const [n, [shape, row]] of Object.entries(T)) expect(rfxShapeOf(Number(n))).toEqual({ shape, row });
    expect(rfxShapeOf(0)).toEqual({ shape: "f", row: 0 });
    expect(rfxShapeOf(32)).toEqual({ shape: "i", row: 0 }); expect(rfxShapeOf(64)).toEqual({ shape: "i", row: 1 });
    expect(rfxShapeOf(128)).toEqual({ shape: "i", row: 2 }); expect(rfxShapeOf(16)).toEqual({ shape: "i", row: 3 });
    expect(rfxShapeOf(16 | 128)).toEqual({ shape: "i", row: 2 }); // several: first of SE, SW, NW, NE
  });
  it("region form: legacy hip > gab > flt, chimney-only = hip, new pieces are their own form", () => {
    expect(rfxRegionForm("legacy", ["roof_flat", "roof_slope"])).toBe("hip");
    expect(rfxRegionForm("legacy", ["roof_flat", "roof_gable"])).toBe("gab");
    expect(rfxRegionForm("legacy", ["roof_flat", "roof_chimney"])).toBe("flt");
    expect(rfxRegionForm("legacy", ["roof_chimney"])).toBe("hip");
    expect(rfxRegionForm("gam", ["roof_gambrel"])).toBe("gam");
  });
  it("hip 3x3: band from Chebyshev distance, perimeter lo, raised peak", () => {
    const m = rfxPickLevel(rect("roof_slope", 3, 3), 1);
    expect(at(m, 1, 1)).toMatchObject({ form: "hip", band: 1, shape: "p", seg: "up", zoffPx: 14, stem: "rfx_hip_up_p" });
    expect(at(m, 1, 0)).toMatchObject({ band: 0, shape: "e", row: 2, seg: "lo", crest: false, zoffPx: 0 });
    expect(base(at(m, 1, 0).stem)).toBe("rfx_hip_lo_e");
    expect(at(m, 2, 1)).toMatchObject({ shape: "e", row: 3 }); expect(at(m, 1, 2)).toMatchObject({ shape: "e", row: 0 }); expect(at(m, 0, 1)).toMatchObject({ shape: "e", row: 1 });
    expect(at(m, 2, 2)).toMatchObject({ shape: "o", row: 0 }); // S+E
    expect(at(m, 0, 0)).toMatchObject({ shape: "o", row: 2 }); // N+W
  });
  it("hip 2x2: every tile an outer corner (no o-crest: Art ships none)", () => {
    const m = rfxPickLevel(rect("roof_slope", 2, 2), 1);
    expect(at(m, 0, 0).stem).toBe("rfx_hip_lo_o"); expect(at(m, 1, 1)).toMatchObject({ shape: "o", row: 0, crest: false });
  });
  it("hip 4x3: crest on edge tiles whose uphill neighbour has the same band; KMAX clamps wide roofs", () => {
    const m = rfxPickLevel(rect("roof_slope", 4, 4), 1);
    expect(at(m, 1, 1)).toMatchObject({ band: 1, shape: "o", row: 2, crest: false, stem: "rfx_hip_up_o" });
    const wide = rfxPickLevel(rect("roof_slope", 11, 11), 1);
    expect(at(wide, 5, 5)).toMatchObject({ band: 3, shape: "f", seg: "up", zoffPx: 42 });
    expect(base(at(wide, 5, 5).stem)).toBe("rfx_hip_up_f");
    // the whole band-kmax ring is the flat crown (no sloped e climbing above it)
    expect(at(wide, 3, 5)).toMatchObject({ band: 3, shape: "f", seg: "up", zoffPx: 42 }); expect(at(wide, 2, 5)).toMatchObject({ band: 2, shape: "e", row: 1 });
    const shed = rfxPickLevel(rect("roof_shed", 2, 7, 0), 1); expect(at(shed, 0, 0)).toMatchObject({ band: 6, zoffPx: 54 }); // sheds are not clamped
  });
  it("concave L: the inner corner gets an i tile, holes close their own eaves", () => {
    const tiles = [...rect("roof_slope", 5, 5)].filter((t) => !(t.x >= 3 && t.y <= 1)); // notch NE
    const m = rfxPickLevel(tiles, 1);
    expect(at(m, 2, 2)).toMatchObject({ band: 0, shape: "i", row: 3 }); // NE diagonal is the non-member
    const holed = rfxPickLevel(rect("roof_slope", 5, 5).filter((t) => !(t.x === 2 && t.y === 2)), 1);
    for (const [x, y] of [[2, 1], [1, 2], [3, 2], [2, 3]] as const) expect(at(holed, x, y).band).toBe(0);
  });
  it("gable 4x3 E-W ridge: eave rows, ridge row up_r, verges and gable walls at the ends", () => {
    const m = rfxPickLevel(rect("roof_gable", 4, 3, 0), 1);
    expect(at(m, 1, 0)).toMatchObject({ form: "gab", band: 0, shape: "e", row: 2 });
    expect(at(m, 1, 2)).toMatchObject({ band: 0, shape: "e", row: 0 });
    expect(at(m, 1, 1)).toMatchObject({ band: 1, shape: "r", row: 0, seg: "up", stem: "rfx_gab_up_r", zoffPx: 14 });
    expect(at(m, 0, 0).overlays).toEqual([{ key: "rfx_gab_verge_el", alts: ["rfx_gab_lo_vel"], row: 2, zoffPx: 0, order: 0 }]);
    expect(at(m, 3, 0).overlays).toEqual([{ key: "rfx_gab_verge_er", alts: ["rfx_gab_lo_ver"], row: 2, zoffPx: 0, order: 0 }]);
    expect(at(m, 0, 1).overlays).toEqual([{ key: "rfx_gab_verge_r", alts: ["rfx_gab_up_vr"], row: 1, zoffPx: 14, order: 0 }, { key: "rfx_gab_wall", alts: [], row: 1, zoffPx: 0, order: 1 }]);
    expect(at(m, 1, 1).overlays).toEqual([]);
    const ns = rfxPickLevel(rect("roof_gable", 3, 4, 1), 1);
    expect(at(ns, 1, 1)).toMatchObject({ shape: "r", row: 1 });
  });
  it("gable 4-deep: equal bands across the ridge crest", () => {
    const m = rfxPickLevel(rect("roof_gable", 3, 4, 0), 1);
    expect(at(m, 1, 1)).toMatchObject({ band: 1, shape: "e", row: 2, crest: true, stem: "rfx_gab_up_ec" });
  });
  it("gambrel: band rise 22 then 8; wall_lo then wall_up strips", () => {
    expect(rfxZoff("gam", 1)).toBe(22); expect(rfxZoff("gam", 3)).toBe(38); expect(rfxZoff("cot", 2)).toBe(26); expect(rfxZoff("flt", 3)).toBe(0);
    const m = rfxPickLevel(rect("roof_gambrel", 3, 5, 0), 1);
    expect(at(m, 1, 2)).toMatchObject({ form: "gam", band: 2, shape: "r", zoffPx: 30 });
    expect(at(m, 0, 2).overlays.map((o) => [o.key, o.zoffPx])).toEqual([["rfx_gam_verge_r", 30], ["rfx_gam_wall_lo", 0], ["rfx_gam_wall_up", 22]]);
  });
  it("flat: band 0 everywhere, parapet lo pieces on the edge, f field inside", () => {
    const m = rfxPickLevel(rect("roof_flat", 3, 3), 1);
    expect(base(at(m, 1, 1).stem)).toBe("rfx_flt_f"); expect(at(m, 1, 1).zoffPx).toBe(0);
    expect(base(at(m, 1, 0).stem)).toBe("rfx_flt_lo_e"); expect(at(m, 0, 0).stem).toBe("rfx_flt_lo_o");
    expect(rfxPickLevel(rect("roof_flat", 1, 1), 1).get("0,0")!.stem).toBe("rfx_flt_lo_p");
    expect(base(at(m, 1, 1).alts[0]!)).toBe("rfx_flt_lo_f"); // Art's packed field name
  });
  it("shed: one pitch down the majority rot, lotop / lo / top / up, side verges and walls", () => {
    const m = rfxPickLevel(rect("roof_shed", 2, 3, 0), 1); // D = S (+y)
    expect(at(m, 0, 2)).toMatchObject({ form: "shd", band: 0, seg: "lo", shape: "e", row: 0 });
    expect(at(m, 0, 1)).toMatchObject({ band: 1, seg: "up", zoffPx: 9 });
    expect(at(m, 0, 0)).toMatchObject({ band: 2, seg: "top", zoffPx: 18 });
    expect(base(rfxPickLevel(rect("roof_shed", 2, 1, 0), 1).get("0,0")!.stem)).toBe("rfx_shd_lotop_e");
    const ov = at(m, 0, 0).overlays.map((o) => [o.key, o.row, o.zoffPx]);
    expect(at(m, 0, 0).overlays[0]!.alts).toEqual(["rfx_shd_up_ver"]);
    expect(ov).toEqual([["rfx_shd_verge_er", 0, 18], ["rfx_shd_wall", 1, 0], ["rfx_shd_wall", 1, 9], ["rfx_shd_wall", 2, 0], ["rfx_shd_wall", 2, 9], ["rfx_shd_wall", 2, 18]]);
  });
  it("different groups never merge; same level only is the caller's job", () => {
    const m = rfxPickLevel([...rect("roof_slope", 2, 1), ...rect("roof_shed", 2, 1, 0, 1, 2, 0)], 1);
    expect(at(m, 1, 0).region).not.toBe(at(m, 2, 0).region);
    expect(at(m, 1, 0).form).toBe("hip"); expect(at(m, 2, 0).form).toBe("shd");
  });
  it("chimney: normal member plus the rfx_chimney stack at the tile surface height", () => {
    const tiles = rect("roof_slope", 3, 3); tiles[4] = { ...tiles[4]!, key: "roof_chimney" };
    expect(at(rfxPickLevel(tiles, 1), 1, 1).overlays).toEqual([{ key: "rfx_chimney", alts: [], row: 0, zoffPx: 21, order: 0 }]);
  });
  it("interior variants: hashU32(0x52F00396, tx, ty, level) & 3 -> v0 v0 v1 v2, only on lo_e / up_e / f without crest", () => {
    const seen = new Set<number>();
    for (let x = 0; x < 16; x++) { const k = rfxHashU32(0x52f00396, x, 3, 1) & 3; const v = rfxVariant(x, 3, 1); expect(v).toBe(k === 3 ? 2 : k === 2 ? 1 : 0); seen.add(v); }
    expect(seen.size).toBe(3);
    const m = rfxPickLevel(rect("roof_slope", 12, 3), 1);
    const stems = new Set([...m.values()].filter((p) => p.shape === "e").map((p) => p.stem));
    expect([...stems].some((s) => s.endsWith("_v1")) && [...stems].some((s) => s.endsWith("_v2"))).toBe(true);
    for (const p of m.values()) if (p.shape !== "e" && p.shape !== "f") expect(p.variant).toBe(0);
  });
  it("sprite keys: tier suffix, then variant / crest dropped; skin first when a material rule matches", () => {
    expect(rfxSpriteKeys("rfx_hip_up_e_v2", 1)).toEqual(["rfx_hip_up_e_v2_t1", "rfx_hip_up_e_t1"]);
    expect(rfxSpriteKeys("rfx_hip_lo_oc", 3)).toEqual(["rfx_hip_lo_oc_t3", "rfx_hip_lo_o_t3"]);
    expect(rfxSpriteKeys("rfx_flt_f", 0, "shake")).toEqual(["rfx_flt_f_shake_t0", "rfx_flt_f_t0"]);
    const cfg: RfxConfig = { ...RFX, materials: { skinKey: "{base}_{skin}{tier}", rules: [{ wall: "wood:log", skin: "shake", forms: ["gab", "hip"] }] } };
    const tiles = rect("roof_gable", 3, 3).map((t, i) => (i < 3 ? { ...t, wallMaterial: "wood:log" } : t));
    for (const p of rfxPickLevel(tiles, 1, cfg).values()) expect(p.skin).toBe("shake"); // region-wide
    for (const p of rfxPickLevel(rect("roof_flat", 2, 2).map((t) => ({ ...t, wallMaterial: "wood:log" })), 1, cfg).values()) expect(p.skin).toBeUndefined(); // form not listed
    expect(RFX.materials.rules.every((r) => r.skin === "shk")).toBe(true); // Art's split-log shake skin (§8)
  });
  it("shk rule: twig and wood walls vote shakes, stone/metal walls vote base, majority wins, a tie goes to base", () => {
    const withWalls = (mats: (string | undefined)[]): RfxTile[] => rect("roof_slope", 4, 3).map((t, i) => ({ ...t, ...(mats[i] !== undefined ? { wallMaterial: mats[i] } : {}) }));
    const skinOf = (mats: (string | undefined)[]) => [...rfxPickLevel(withWalls(mats), 1).values()].map((p) => p.skin);
    expect(new Set(skinOf(Array(12).fill("twig")))).toEqual(new Set(["shk"]));
    expect(new Set(skinOf(Array(12).fill("wood")))).toEqual(new Set(["shk"]));                          // wood-wall cabin
    expect(new Set(skinOf(Array(12).fill("stone")))).toEqual(new Set([undefined]));
    expect(new Set(skinOf(["twig", "wood", "wood", "stone", "stone"]))).toEqual(new Set(["shk"]));        // 3 log : 2 stone
    expect(new Set(skinOf(["wood", "wood", "stone", "metal"]))).toEqual(new Set([undefined]));            // 2 log : 2 base, tie -> base
    expect(new Set(skinOf(["site:cabin", "stone", "site:cabin"]))).toEqual(new Set(["shk"]));           // cabin ruin
    expect(rfxSpriteKeys("rfx_hip_lo_e_v1", 1, "shk")).toEqual(["rfx_hip_lo_e_v1_shk_t1", "rfx_hip_lo_e_v1_t1", "rfx_hip_lo_e_shk_t1", "rfx_hip_lo_e_t1"]);
    const flat = rfxPickLevel(rect("roof_flat", 2, 2).map((t) => ({ ...t, wallMaterial: "twig" })), 1);
    for (const p of flat.values()) expect(p.skin).toBeUndefined();                                        // no flat shakes
  });
});
