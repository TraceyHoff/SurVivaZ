import { describe, expect, it } from "vitest";
import { hashU32 } from "@engine/gameplay";
import { rfxHashU32, rfxSeat } from "@engine/assets";
const G = rfxSeat("gab");
import { RoofTiler, type RoofCell } from "../src/roof-tiler.js";

const tiler = (keys: string[]) => { const ids = new Map(keys.map((k, i) => [k, i + 100])); let probes = 0; return { ids, get probes() { return probes; }, t: new RoofTiler({ roofSpriteId: (k) => { probes++; return ids.get(k); } }) }; };
const cells = (key: string, w: number, h: number, level = 1, tier = 1, rot = 0): RoofCell[] => { const o: RoofCell[] = []; let ve = 1; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o.push({ ve: ve++, x, y, level, key, rot, tier }); return o; };

describe("ADR-397 RoofTiler (client)", () => {
  it("rfxHashU32 is abandoned.ts hashU32", () => {
    for (const [a, b, c] of [[0, 0, 0], [5, -3, 1], [-100, 77, 2], [123456, -654321, 7]] as const) expect(rfxHashU32(0x52f00396, a, b, c)).toBe(hashU32(0x52f00396, a, b, c));
  });
  it("no rfx art: no bindings, so every roof draws its legacy sprite unchanged", () => {
    const { t } = tiler([]); for (const c of cells("roof_slope", 4, 3)) t.add(c);
    expect(t.flush()).toEqual([]); for (let ve = 1; ve <= 12; ve++) expect(t.binding(ve)).toBeUndefined();
    expect(t.pick(5)?.form).toBe("hip"); // the selection itself still ran
  });
  it("resolves Art's keys with tier, lift and overlays; re-picks the level on place / remove only", () => {
    const k = tiler(["rfx_gab_lo_e_t1", "rfx_gab_up_r_t1", "rfx_gab_up_vr_t1", "rfx_gab_wall_t1"]);
    for (const c of cells("roof_gable", 4, 3)) k.t.add(c);
    const changed = k.t.flush(); expect(changed.length).toBe(12);
    const mid = k.t.binding(5)!; // (0,1): up_r with a verge and one wall strip
    expect(mid).toEqual({ vis: k.ids.get("rfx_gab_up_r_t1"), row: 0, liftPx: 14 + G, overlays: [{ vis: k.ids.get("rfx_gab_up_vr_t1"), row: 1, liftPx: 14 + G }, { vis: k.ids.get("rfx_gab_wall_t1"), row: 1, liftPx: G }] }); // ADR-404: + the gable seat
    expect(k.t.binding(1)!.vis).toBe(k.ids.get("rfx_gab_lo_e_t1")); // lo_vel art missing -> no overlay
    expect(k.t.binding(1)!.overlays).toEqual([]);
    const probes = k.probes; expect(k.t.flush()).toEqual([]); expect(k.probes).toBe(probes); // steady frame: no work
    const v0 = k.t.version.get(1); k.t.remove(9); expect(k.t.version.get(1)).toBe(v0! + 1);
    expect(k.t.flush().length).toBeGreaterThan(0);
  });
  it("tier picks the art per tile; levels are separate", () => {
    const k = tiler(["rfx_flt_f_t2", "rfx_flt_lo_e_t2", "rfx_flt_lo_o_t2"]);
    for (const c of cells("roof_flat", 3, 3, 1, 2)) k.t.add(c);
    k.t.add({ ve: 50, x: 1, y: 1, level: 2, key: "roof_flat", rot: 0, tier: 2 });
    k.t.flush();
    expect(k.t.binding(5)?.vis).toBe(k.ids.get("rfx_flt_f_t2"));
    expect(k.t.pick(50)?.stem).toBe("rfx_flt_lo_p");
  });
  it("placement preview runs the same selection with the ghost as a member", () => {
    const k = tiler(["rfx_hip_up_p_t1", "rfx_hip_lo_e_t1"]);
    for (const c of cells("roof_slope", 3, 3)) if (!(c.x === 1 && c.y === 1)) k.t.add(c);
    const p = k.t.preview({ x: 1, y: 1, key: "roof_slope", rot: 0, tier: 1 }, 1)!;
    expect(p.pick).toMatchObject({ band: 1, shape: "p" }); expect(p.fx).toMatchObject({ vis: k.ids.get("rfx_hip_up_p_t1"), liftPx: 14 + rfxSeat("hip") }); // ADR-404 seat
    expect(k.t.preview({ x: 0, y: 0, key: "wall", rot: 0, tier: 1 }, 1)).toBeUndefined();
  });
});
