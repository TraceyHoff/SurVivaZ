import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rfxPickLevel, rfxSpriteKeys, type RfxTile } from "../src/roofRfx.js";
import { decodeRgba } from "../../../apps/client/test/png-rgba.js";

// docs/ART_KEYS_ROOFS.md: seamless neighbour-aware roof set (rfx_*), add-only on its own pages. Eaves pass (§9): 96x80 cells,
// pivot (48,44), anchor (0.5, 0.55); the surface overhangs every outer edge.
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
const ICON: Record<string, string> = { hip: "build_rfx_hip", gab: "build_rfx_gab", flt: "build_rfx_flt", cot: "build_roof_cottage", gam: "build_roof_gambrel", shd: "build_roof_shed" };
const BASE: Record<string, string> = { hip: "roof_slope", cot: "roof_slope", shd: "roof_slope", gab: "roof_gable", gam: "roof_gable", flt: "roof_flat" };
const page = (form: string, t: number) => `rfx_t${t}_${["hip", "gab", "flt"].includes(form) ? "a" : "b"}`;

describe("rfx seamless roofs", () => {
  it("ships every key of the grammar on lean streamed 96x80 pages", () => {
    let n = 0;
    for (const [form, tiers] of Object.entries(TIERS)) for (const t of tiers) for (const part of PARTS[form]!) {
      const key = `rfx_${form}_${part}_t${t}`; const s = byKey.get(key);
      expect(s, key).toBeDefined();
      expect(s!.atlas).toBe(page(form, t));
      expect(s!.anchor).toEqual({ x: 0.5, y: 44 / 80 });
      expect(s!.rotationArt).toBe("unique4");
      expect(s!.building!.piece).toBe(`${BASE[form]}@${key}`);
      expect(s!.building!.frames.length).toBe(4);
      for (const row of s!.building!.frames) expect(new Set(row).size).toBe(1);   // one baked stage + bld_crack
      expect(s!.building!.crackOverlay).toBe("bld_crack");
      expect(lock.sprites[key]).toBeTypeOf("number");
      n++;
    }
    for (const t of [1, 2, 3, 4]) expect(byKey.get(`rfx_chimney_t${t}`)?.attach?.smoke).toBeDefined();
    expect(n).toBe(man.sprites.filter((s: Spr) => /^rfx_(?!chimney)/.test(s.key) && !/_shk_t\d$/.test(s.key)).length);
    for (const a of man.atlases.filter((a: { key: string }) => a.key.startsWith("rfx_t"))) {
      expect(a.frameW).toBe(96); expect(a.frameH).toBe(80); expect(a.residency).toBe("stream");
      expect(Math.max(a.columns * 96, a.rows * 80)).toBeLessThanOrEqual(2048);
      expect(statSync(root + "building/" + a.image).size).toBeLessThan(64 * 1024);
      expect(statSync(root + "building/" + a.ktx2).size).toBeLessThan(192 * 1024);
    }
  });
  it("keeps the legacy roof keys as fallbacks and adds one build icon per form per tier", () => {
    for (const k of ["bld_roof_flat_t1", "bld_roof_gable_t2", "bld_roof_hip_t3", "bld_roof_corner_t4", "bld_roof_chimney"]) expect(byKey.has(k)).toBe(true);
    for (const [form, tiers] of Object.entries(TIERS)) for (const t of tiers)
      expect(items.sprites.find((s: { key: string }) => s.key === `${ICON[form]}_t${t}`)?.atlas).toBe("items_build_rfx");
  });
  it("ships the shk split-log shake skin on log-cabin tiers with the same piece grammar (§8)", () => {
    const SHK: Record<string, number[]> = { hip: [0, 1], gab: [1], shd: [0, 1], cot: [1] };
    let n = 0;
    for (const [form, tiers] of Object.entries(SHK)) for (const t of tiers) for (const part of PARTS[form]!) {
      const key = `rfx_${form}_${part}_shk_t${t}`; const s = byKey.get(key);
      expect(s, key).toBeDefined(); expect(byKey.has(`rfx_${form}_${part}_t${t}`), key).toBe(true);   // base twin = fallback
      expect(s!.atlas).toBe(`rfx_shk_t${t}`); expect(s!.anchor).toEqual({ x: 0.5, y: 44 / 80 });
      expect(s!.building!.piece).toBe(`${BASE[form]}@${key}`); expect(s!.building!.crackOverlay).toBe("bld_crack");
      expect(lock.sprites[key]).toBeTypeOf("number"); n++;
    }
    expect(byKey.get("rfx_chimney_shk_t1")?.attach?.smoke).toBeDefined();
    expect(n + 1).toBe(man.sprites.filter((s: Spr) => /_shk_t\d$/.test(s.key)).length);
    for (const t of [0, 1]) {
      const a = man.atlases.find((x: { key: string }) => x.key === `rfx_shk_t${t}`);
      expect(a.frameW).toBe(96); expect(a.frameH).toBe(80); expect(a.residency).toBe("stream");
      expect(statSync(root + "building/" + a.image).size).toBeLessThan(64 * 1024);
      expect(statSync(root + "building/" + a.ktx2).size).toBeLessThan(240 * 1024);
    }
    expect(man.atlases.filter((x: { key: string }) => x.key.startsWith("rfx_shk_")).length).toBe(2);
  });
  it("a wood-walled cabin resolves shk_t1 art at t1 and falls back to base at t2+ (§8)", () => {
    const cabin = (key: string, tier: number, wall: string): RfxTile[] => { const o: RfxTile[] = []; for (let x = 0; x < 6; x++) for (let y = 0; y < 4; y++) o.push({ x, y, key: x === 4 && y === 1 && (key === "roof_gable" || key === "roof_slope") ? "roof_chimney" : key, rot: 0, tier, ...(x === 0 || y === 0 || x === 5 || y === 3 ? { wallMaterial: wall } : {}) }); return o; };
    const resolve = (st: string[], tier: number, skin?: string): string | undefined => { for (const s of st) for (const k of rfxSpriteKeys(s, tier, skin)) if (byKey.has(k)) return k; return undefined; };
    const keysOf = (tiles: RfxTile[]): string[] => [...rfxPickLevel(tiles, 1).values()].flatMap((p) => [resolve([p.stem], tiles[0]!.tier, p.skin), ...p.overlays.map((o) => resolve([o.key], tiles[0]!.tier, p.skin))]).map((k) => k ?? "MISSING");
    for (const form of ["roof_gable", "roof_slope", "roof_cottage", "roof_shed"]) {
      const t1 = keysOf(cabin(form, 1, "wood")); expect(t1.every((k) => /_shk_t1$/.test(k)), `${form} ${t1.filter((k) => !/_shk_t1$/.test(k))}`).toBe(true);
      for (const t of [2, 3, 4]) { const k = keysOf(cabin(form, t, "wood")); expect(k.every((x) => x !== "MISSING" && !x.includes("_shk_") && x.endsWith(`_t${t}`)), `${form} t${t}`).toBe(true); }
    }
    expect(keysOf(cabin("roof_gable", 1, "stone")).some((k) => k.includes("_shk_"))).toBe(false);   // stone walls keep base shingles
  });
  it("eaves pass: the roof overhangs every outer edge, never an interior seam (§9)", () => {
    const atl = new Map<string, { image: string; frameW: number; frameH: number; columns: number }>(man.atlases.map((a: { key: string }) => [a.key, a]));
    const pages = new Map<string, { w: number; rgba: Uint8Array }>();
    /** opaque pixels of key at row r as a set of "x,y" relative to the pivot (48,44) */
    const px = (key: string, r: number): Set<string> => {
      const s = byKey.get(key)!; const a = atl.get(s.atlas)!; const f = s.building!.frames[r]![0]!;
      let im = pages.get(a.image); if (!im) { im = decodeRgba(readFileSync(root + "building/" + a.image)); pages.set(a.image, im); }
      const out = new Set<string>(); const fx = (f % a.columns) * a.frameW, fy = Math.floor(f / a.columns) * a.frameH;
      for (let y = 0; y < a.frameH; y++) for (let x = 0; x < a.frameW; x++) { const al = im.rgba[((fy + y) * im.w + fx + x) * 4 + 3]!; expect(al === 0 || al === 255).toBe(true); if (al) out.add(`${x - 48},${y - 44}`); }
      return out;
    };
    const lowest = (p: Set<string>, x: number): number => Math.max(...[...p].map((k) => k.split(",").map(Number) as [number, number]).filter(([px_]) => px_ === x).map(([, y]) => y));
    for (const [form, tiers] of Object.entries(TIERS)) for (const t of tiers) {
      // S eave (row 0): at screen column -8 the tile diamond ends at y = +11; the eave (6 px) + fascia / flat face hang >= 8 px lower
      const e = px(`rfx_${form}_lo_e_t${t}`, 0);
      expect(lowest(e, -8), `${form} t${t} S eave`).toBeGreaterThanOrEqual(11 + 6 + (form === "flt" ? 3 : 4));
      // interior pieces stay inside the diamond's x range (no overhang on member seams)
      const inner = px(form === "flt" ? `rfx_flt_f_t${t}` : form === "shd" ? `rfx_shd_up_e_t${t}` : `rfx_${form}_up_f_t${t}`, 0);
      for (const k of inner) expect(Math.abs(Number(k.split(",")[0])), `${form} t${t} interior`).toBeLessThanOrEqual(32);
      if (form === "hip" || form === "cot" || form === "flt") {
        // outer corner S+E (row 0): the corner reaches 8 px past the S vertex (row +15) plus its fascia / flat face
        expect(lowest(px(`rfx_${form}_lo_o_t${t}`, 0), 0), `${form} t${t} corner`).toBeGreaterThanOrEqual(15 + 8 + (form === "flt" ? 3 : 4));
      }
    }
  });
});
