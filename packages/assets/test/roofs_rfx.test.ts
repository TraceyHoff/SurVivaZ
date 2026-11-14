import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

// docs/ART_KEYS_ROOFS.md: seamless neighbour-aware roof set (rfx_*), add-only on its own pages.
const root = "packages/assets/pack/";
const man = JSON.parse(readFileSync(root + "building/manifest.building.json", "utf8"));
const items = JSON.parse(readFileSync(root + "items/manifest.items.json", "utf8"));
const lock = JSON.parse(readFileSync(root + "ids.lock.json", "utf8"));
type Spr = { key: string; atlas: string; anchor: { x: number; y: number }; rotationArt?: string; attach?: Record<string, { x: number; y: number }>;
  building?: { piece: string; footprint: { w: number; h: number }; layer: number; frames: number[][]; crackOverlay?: string } };
const byKey = new Map<string, Spr>(man.sprites.map((s: Spr) => [s.key, s]));
const TIERS: Record<string, number[]> = { hip: [0, 1, 2, 3, 4], gab: [1, 2, 3, 4], flt: [0, 1, 2, 3, 4], cot: [1, 2, 3, 4], gam: [1, 2, 3, 4], shd: [0, 1, 2, 3, 4] };
const HIP = ["lo_e", "lo_o", "lo_i", "lo_r", "lo_h", "lo_p", "up_e", "up_o", "up_i", "up_r", "up_h", "up_p", "up_f", "lo_ec", "up_ec", "lo_e_v1", "lo_e_v2", "up_e_v1", "up_e_v2", "up_f_v1", "up_f_v2"];
const GAB = ["lo_e", "lo_r", "up_e", "up_r", "up_f", "lo_ec", "up_ec", "lo_e_v1", "lo_e_v2", "up_e_v1", "up_e_v2", "up_f_v1", "up_f_v2", "lo_vel", "lo_ver", "lo_vr", "up_vel", "up_ver", "up_vr", "up_vf"];
const PARTS: Record<string, string[]> = {
  hip: HIP, cot: HIP, gab: [...GAB, "wall"], gam: [...GAB, "wall_lo", "wall_up"],
  shd: ["lo_e", "up_e", "top_e", "lotop_e", "lo_e_v1", "lo_e_v2", "up_e_v1", "up_e_v2", "lo_vel", "lo_ver", "up_vel", "up_ver", "wall"],
  flt: ["lo_e", "lo_o", "lo_i", "lo_r", "lo_h", "lo_p", "f", "f_v1", "f_v2"],
};
const BASE: Record<string, string> = { hip: "roof_slope", cot: "roof_slope", shd: "roof_slope", gab: "roof_gable", gam: "roof_gable", flt: "roof_flat" };
const page = (form: string, t: number) => `rfx_t${t}_${["hip", "gab", "flt"].includes(form) ? "a" : "b"}`;

describe("rfx seamless roofs", () => {
  it("ships every key of the grammar on lean streamed 72x68 pages", () => {
    let n = 0;
    for (const [form, tiers] of Object.entries(TIERS)) for (const t of tiers) for (const part of PARTS[form]!) {
      const key = `rfx_${form}_${part}_t${t}`; const s = byKey.get(key);
      expect(s, key).toBeDefined();
      expect(s!.atlas).toBe(page(form, t));
      expect(s!.anchor).toEqual({ x: 0.5, y: 44 / 68 });
      expect(s!.rotationArt).toBe("unique4");
      expect(s!.building!.piece).toBe(`${BASE[form]}@${key}`);
      expect(s!.building!.frames.length).toBe(4);
      for (const row of s!.building!.frames) expect(new Set(row).size).toBe(1);   // one baked stage + bld_crack
      expect(s!.building!.crackOverlay).toBe("bld_crack");
      expect(lock.sprites[key]).toBeTypeOf("number");
      n++;
    }
    for (const t of [1, 2, 3, 4]) expect(byKey.get(`rfx_chimney_t${t}`)?.attach?.smoke).toBeDefined();
    expect(n).toBe(man.sprites.filter((s: Spr) => /^rfx_(?!chimney)/.test(s.key)).length);
    for (const a of man.atlases.filter((a: { key: string }) => a.key.startsWith("rfx_"))) {
      expect(a.frameW).toBe(72); expect(a.frameH).toBe(68); expect(a.residency).toBe("stream");
      expect(Math.max(a.columns * 72, a.rows * 68)).toBeLessThanOrEqual(2048);
      expect(statSync(root + "building/" + a.image).size).toBeLessThan(64 * 1024);
      expect(statSync(root + "building/" + a.ktx2).size).toBeLessThan(160 * 1024);
    }
  });
  it("keeps the legacy roof keys as fallbacks and adds one build icon per form per tier", () => {
    for (const k of ["bld_roof_flat_t1", "bld_roof_gable_t2", "bld_roof_hip_t3", "bld_roof_corner_t4", "bld_roof_chimney"]) expect(byKey.has(k)).toBe(true);
    for (const [form, tiers] of Object.entries(TIERS)) for (const t of tiers)
      expect(items.sprites.find((s: { key: string }) => s.key === `build_rfx_${form}_t${t}`)?.atlas).toBe("items_build_rfx");
  });
});
