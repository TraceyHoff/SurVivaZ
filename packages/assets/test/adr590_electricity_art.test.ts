import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeRgba } from "../../../apps/client/test/png-rgba.js";

// docs/ART_KEYS_ELECTRICITY.md (ADR-590): dedicated electricity-tier art on its own streamed pages elec_<class> (+ @2x,
// + emissive mask). Hearth convention (ADR-218): `idle` = looping active animation, `unlit` = 1 frame per painted
// facing, building.frames = first active frame, building.states.unlit = the unlit frame. True scale: 30.29 px / m.
const root = "packages/assets/pack/building/";
const man = JSON.parse(readFileSync(root + "manifest.building.json", "utf8"));
const lock = JSON.parse(readFileSync("packages/assets/pack/ids.lock.json", "utf8"));
type Anim = { frames: number[]; fps: number; loop?: boolean; rotations?: number[][] };
type Spr = { key: string; atlas: string; anchor: { x: number; y: number }; rotationArt?: string; animations: Record<string, Anim>;
  building?: { piece: string; footprint: { w: number; h: number }; layer: number; frames: number[][]; states?: Record<string, number[][]>; crackOverlay?: string } };
type Atlas = { key: string; image: string; frameW: number; frameH: number; columns: number; rows: number; ktx2?: string; residency?: string;
  pages?: { scale: number; image: string; ktx2?: string; masksKtx2?: Record<string, string> }[]; masks?: Record<string, string>; masksKtx2?: Record<string, string> };
const byKey = new Map<string, Spr>(man.sprites.map((s: Spr) => [s.key, s]));
const FB = JSON.parse(readFileSync("packages/gameplay/data/sprite_fallbacks.json", "utf8")) as { sprites: Record<string, unknown>; icons: Record<string, string> };
const atlas = new Map<string, Atlas>(man.atlases.map((a: Atlas) => [a.key, a]));
// brief §2 / §4: class -> [frameW, frameH, pivot y]. Wider than the brief where a wheel overhangs its footprint in every
// facing: wt 144 (2.4 m wheel on a 2 m footprint), xw 184 x 216 (3.4 m wheel on a 2x2 diamond, pivot 180 so the front
// corner of the 128 px diamond fits under it).
const CLS: Record<string, [number, number, number]> = { s: [64, 88, 70], t: [72, 120, 102], w: [104, 120, 94], wt: [144, 152, 118], xt: [72, 168, 144], xw: [184, 216, 180], xxl_t: [112, 240, 216], xxl_l: [176, 376, 348] };
// key: [batch, class, rows (1 mirror / 2 or 4 unique4), active frames, fps, footprint w, h, height m, brief top px]
const P: Record<string, [number, string, number, number, number, number, number, number, number]> = {
  generator_fuel: [1, "w", 2, 6, 12, 2, 1, 1.2, 60], generator_solar: [1, "s", 1, 4, 4, 1, 1, 0.9, 43], battery_small: [1, "s", 1, 4, 2, 1, 1, 0.6, 34],
  battery_medium: [1, "t", 1, 4, 2, 1, 1, 1.3, 55], battery_large: [1, "w", 2, 4, 2, 2, 1, 2.0, 85], power_pylon: [1, "xt", 1, 6, 8, 1, 1, 3.0, 107],
  solar_panel: [2, "w", 2, 4, 3, 2, 1, 1.4, 66], wind_turbine: [2, "xxl_t", 1, 8, 12, 1, 1, 6.2, 204], wind_turbine_large: [2, "xxl_l", 1, 8, 10, 2, 2, 10.2, 341],
  water_wheel: [2, "wt", 2, 8, 8, 2, 1, 2.6, 103], water_wheel_overshot: [2, "xw", 2, 8, 8, 2, 2, 4.0, 153], water_turbine: [2, "s", 1, 6, 12, 1, 1, 1.0, 46],
  electrician_workstation: [3, "wt", 2, 6, 10, 2, 1, 2.0, 85], electric_stove: [3, "s", 2, 4, 6, 1, 1, 1.1, 49], electric_furnace: [3, "t", 2, 6, 10, 1, 1, 1.6, 64],
  power_workbench: [3, "w", 2, 6, 10, 2, 1, 1.6, 72], power_hammer: [3, "t", 2, 6, 10, 1, 1, 2.2, 83], fridge: [3, "t", 2, 4, 4, 1, 1, 1.8, 71],
  chest_freezer: [3, "w", 2, 4, 4, 2, 1, 0.85, 50], electric_floor_lamp: [3, "t", 1, 4, 4, 1, 1, 1.6, 64], electric_table_lamp: [3, "s", 1, 4, 4, 1, 1, 0.5, 31],
  // mounted: the wall light's fixture band is 55-64 px above the edge pivot (rot 0; the back facings sit on the far wall
  // face, +5 px), the ceiling light hangs from the 80 px ceiling (body 70-79 px) -> ceiling = mount height, not the brief's object size
  electric_wall_light: [3, "t", 4, 4, 4, 1, 1, 0.3, 70], ceiling_light: [3, "t", 1, 4, 4, 1, 1, 0.25, 80],
  flood_light: [3, "xt", 1, 4, 4, 1, 1, 3.0, 107], electric_heater: [3, "s", 2, 4, 4, 1, 1, 0.65, 36], hydroponic_table: [3, "w", 2, 4, 6, 2, 1, 1.7, 75],
};
const DELIVERED = Object.keys(P);
const png = (p: string) => { const d = decodeRgba(readFileSync(root + p)); return { width: d.w, height: d.h, data: d.rgba }; };
const PX_M = 53 / 1.75;

describe("ADR-590 electricity-tier art", () => {
  it("every delivered key has its own sprite on an elec_<class> page with the hearth lit/unlit convention", () => {
    for (const k of DELIVERED) {
      const [, cls, rows, nf, fps, fw, fh] = P[k]!; const s = byKey.get(k)!;
      expect(s, k).toBeDefined(); expect(s.atlas, k).toMatch(new RegExp(`^elec_${cls}(_\\d+)?$`));
      // the placeholders are gone now that build_<key> ships too (items_build_elec): no tinted neighbour anywhere
      expect(FB.sprites[k], k).toBeUndefined();
      const a = atlas.get(s.atlas)!; const [w, h, oy] = CLS[cls]!;
      expect([a.frameW, a.frameH], k).toEqual([w, h]); expect(s.anchor, k).toEqual({ x: 0.5, y: oy / h });
      expect(s.rotationArt, k).toBe(rows === 1 ? "mirror" : "unique4");
      expect(s.animations.idle!.loop, k).toBe(true); expect(s.animations.idle!.fps, k).toBe(fps); expect(s.animations.idle!.frames.length, k).toBe(nf);
      expect(s.animations.unlit!.frames.length, k).toBe(1);
      expect(s.building!.piece, k).toBe(k); expect(s.building!.footprint, k).toEqual({ w: fw, h: fh }); expect(s.building!.crackOverlay).toBe("bld_crack");
      expect(s.building!.frames.length, k).toBe(rows === 1 ? 1 : 4); expect(s.building!.states!.unlit!.length, k).toBe(rows === 1 ? 1 : 4);
      if (rows > 1) {
        const r = s.animations.idle!.rotations!; expect(r.length, k).toBe(4); for (let i = 0; i < 4; i++) expect(r[i], k).toEqual(r[i % rows]);
        expect(new Set(r.slice(0, rows).flat()).size, k).toBe(rows * nf);   // painted facings, every frame its own cell
        expect(s.building!.frames.map((x) => x[0]), k).toEqual(r.map((x) => x[0]));
        expect(s.building!.states!.unlit!.map((x) => x[0]), k).toEqual(s.animations.unlit!.rotations!.map((x) => x[0]));
      } else {
        expect(s.building!.frames[0], k).toEqual(Array(4).fill(s.animations.idle!.frames[0]));
        expect(s.building!.states!.unlit![0], k).toEqual(Array(4).fill(s.animations.unlit!.frames[0]));
      }
      expect(lock.sprites?.[k] ?? lock[k] ?? JSON.stringify(lock).includes(`"${k}"`), k).toBeTruthy();
    }
  });

  it("pages: 1x + @2x + emissive (+@2x) PNG and KTX2, streamed, inside the 2048 px layer limit", () => {
    for (const a of man.atlases as Atlas[]) {
      if (!a.key.startsWith("elec_")) continue;
      expect(a.residency, a.key).toBe("stream"); expect(a.masks?.emissive, a.key).toBe(`atlases/${a.key}_emissive.png`);
      expect(a.ktx2 && a.masksKtx2?.emissive && a.pages?.[0]?.ktx2 && a.pages?.[0]?.masksKtx2?.emissive, a.key).toBeTruthy();
      for (const f of [a.image, a.ktx2!, a.masks!.emissive!, a.masksKtx2!.emissive!, a.pages![0]!.image, a.pages![0]!.ktx2!, a.pages![0]!.masksKtx2!.emissive!]) expect(statSync(root + f).size, f).toBeGreaterThan(0);
      const im = png(a.image); expect([im.width, im.height], a.key).toEqual([a.columns * a.frameW, a.rows * a.frameH]);
      const i2 = png(a.pages![0]!.image); expect([i2.width, i2.height]).toEqual([2 * im.width, 2 * im.height]);
      expect(Math.max(i2.width, i2.height), a.key).toBeLessThanOrEqual(2048);
    }
  });

  it("true scale: the art stands round(height m x 30.29) px or more and never above the brief's top px; glow only while active", () => {
    for (const k of DELIVERED) {
      const [, cls, rows, nf, , , , hm, briefTop] = P[k]!; const s = byKey.get(k)!; const a = atlas.get(s.atlas)!;
      const col = png(a.image); const em = png(a.masks!.emissive!); const oy = CLS[cls]![2];
      const cell = (img: { width: number; data: Uint8Array }, i: number, fn: (x: number, y: number, al: number) => void) => {
        const x0 = (i % a.columns) * a.frameW, y0 = Math.floor(i / a.columns) * a.frameH;
        for (let y = 0; y < a.frameH; y++) for (let x = 0; x < a.frameW; x++) fn(x, y, img.data[((y0 + y) * img.width + x0 + x) * 4 + 3]!);
      };
      const lit = rows === 1 ? [s.animations.idle!.frames] : s.animations.idle!.rotations!.slice(0, rows);
      const cold = rows === 1 ? [s.animations.unlit!.frames[0]!] : s.animations.unlit!.rotations!.slice(0, rows).map((x) => x[0]!);
      let top = 0;
      for (const fr of lit) for (const i of fr) {
        let minY = a.frameH, glow = 0; cell(col, i, (_x, y, al) => { if (al >= 128 && y < minY) minY = y; });
        cell(em, i, (_x, _y, al) => { if (al > 0) glow++; });
        top = Math.max(top, oy - minY); expect(glow, `${k} frame ${i} has emissive pixels`).toBeGreaterThan(0);
      }
      for (const i of cold) { let glow = 0; cell(em, i, (_x, _y, al) => { if (al > 0) glow++; }); expect(glow, `${k} unlit frame ${i}`).toBe(0); }
      expect(top, k).toBeGreaterThanOrEqual(Math.round(hm * PX_M)); expect(top, k).toBeLessThanOrEqual(briefTop + 4);
      expect(nf).toBeGreaterThan(1);
    }
  });
});

describe("ADR-590 mounted electric lights", () => {
  it("wall light: 4 painted facings, fixture 55-64 px above the edge pivot at rot 0; ceiling light body under the 80 px ceiling", () => {
    const s = byKey.get("electric_wall_light")!; const a = atlas.get(s.atlas)!; const col = png(a.image); const oy = CLS.t![2];
    const rows = s.animations.idle!.rotations!; expect(new Set(rows.map((r) => r[0])).size).toBe(4);
    const i = rows[0]![0]!; const x0 = (i % a.columns) * a.frameW, y0 = Math.floor(i / a.columns) * a.frameH; let minY = a.frameH, maxY = 0;
    for (let y = 0; y < a.frameH; y++) for (let x = 0; x < a.frameW; x++) if (col.data[((y0 + y) * col.width + x0 + x) * 4 + 3]! >= 128) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    expect(oy - minY).toBeGreaterThanOrEqual(60); expect(oy - minY).toBeLessThanOrEqual(68); expect(oy - maxY).toBeGreaterThanOrEqual(40);   // no ground parts
    const c = byKey.get("ceiling_light")!; const ca = atlas.get(c.atlas)!; const cc = png(ca.image); const ci = c.animations.unlit!.frames[0]!;
    const cx0 = (ci % ca.columns) * ca.frameW, cy0 = Math.floor(ci / ca.columns) * ca.frameH; let cmax = 0;
    for (let y = 0; y < ca.frameH; y++) for (let x = 0; x < ca.frameW; x++) if (cc.data[((cy0 + y) * cc.width + cx0 + x) * 4 + 3]! >= 128) cmax = Math.max(cmax, y);
    expect(oy - cmax).toBeGreaterThanOrEqual(64);   // lowest solid pixel of the hanging body stays ~2.1 m+ up (no shadow on the floor)
  });
});

// brief section 5 (ADR-593): powered building tier = building_t4 layout rules, own art. 15 pieces, painted rows as t4.
const T5: Record<string, number> = { foundation: 4, foundation_triangle: 4, floor: 4, floor_triangle: 4, floor_hatch_frame: 4, floor_stairwell: 2,
  wall: 2, wall_low: 2, wall_window: 2, wall_doorway: 2, wall_arched: 2, wall_corner_inner: 4, wall_corner_outer: 4, wall_corner_angled: 4, pillar: 4 };
describe("ADR-593 powered building tier art (building_t5)", () => {
  const topOf = (a: Atlas, img: { width: number; data: Uint8Array }, i: number): number => {
    const x0 = (i % a.columns) * a.frameW, y0 = Math.floor(i / a.columns) * a.frameH;
    for (let y = 0; y < a.frameH; y++) for (let x = 0; x < a.frameW; x++) if (img.data[((y0 + y) * img.width + x0 + x) * 4 + 3]! >= 128) return 99 - y;
    return 0;
  };
  const glowOf = (a: Atlas, img: { width: number; data: Uint8Array }, i: number): number => {
    const x0 = (i % a.columns) * a.frameW, y0 = Math.floor(i / a.columns) * a.frameH; let n = 0;
    for (let y = 0; y < a.frameH; y++) for (let x = 0; x < a.frameW; x++) if (img.data[((y0 + y) * img.width + x0 + x) * 4 + 3]! > 0) n++;
    return n;
  };
  it("15 bld_<piece>_t5 sprites: t4 layout (84x120, anchor .825, unique4, 4 damage stages, crack overlay) + lit / unlit / idle", () => {
    expect(Object.keys(T5).sort()).toEqual([...JSON.parse(readFileSync("packages/gameplay/data/power.json", "utf8")).poweredTier.pieces].sort());
    for (const [p, rows] of Object.entries(T5)) {
      const k = `bld_${p}_t5`; const s = byKey.get(k)!; expect(s, k).toBeDefined();
      expect(s.atlas, k).toMatch(/^building_t5(_floor)?$/); const a = atlas.get(s.atlas)!;
      expect([a.frameW, a.frameH, a.residency], k).toEqual([84, 120, "stream"]); expect(s.anchor, k).toEqual({ x: 0.5, y: 0.825 });
      expect(s.rotationArt, k).toBe("unique4"); expect(s.building!.piece, k).toBe(`${p}@tier5`); expect(s.building!.crackOverlay, k).toBe("bld_crack");
      expect(s.building!.layer, k).toBe(byKey.get(`bld_${p}_t4`)!.building!.layer);
      const fr = s.building!.frames, un = s.building!.states!.unlit!, idle = s.animations.idle!;
      expect(fr.length, k).toBe(4); expect(un.length, k).toBe(4); expect(idle.fps, k).toBe(4); expect(idle.loop, k).toBe(true);
      for (let r = 0; r < 4; r++) {
        expect(fr[r]!.length, k).toBe(4); expect(un[r]!.length, k).toBe(4); expect(fr[r], k).toEqual(fr[r % rows]); expect(un[r], k).toEqual(un[r % rows]);
        expect(idle.rotations![r]!.length, k).toBe(4); expect(idle.rotations![r]![0], k).toBe(fr[r]![0]);
        expect(s.animations.unlit!.rotations![r]![0], k).toBe(un[r]![0]);
      }
      const cells = new Set([...fr.slice(0, rows).flat(), ...un.slice(0, rows).flat(), ...idle.rotations!.slice(0, rows).flat()]);
      expect(cells.size, k).toBe(rows * 11);   // every painted cell its own (4 powered + 4 unlit damage stages + 3 extra animation frames)
      expect(JSON.stringify(lock).includes(`"${k}"`), k).toBe(true);
    }
  });
  it("pages: indexed PNG + KTX2 + emissive mask inside 2048 px (building_t5 = a 2016x2040 tier page); tops match t4 (80 px floor); glow only while powered", () => {
    for (const ak of ["building_t5", "building_t5_floor"]) {
      const a = atlas.get(ak)!; expect(a.masks?.emissive).toBe(`atlases/${ak}_emissive.png`);
      for (const f of [a.image, a.ktx2!, a.masks!.emissive!, a.masksKtx2!.emissive!]) expect(statSync(root + f).size, f).toBeGreaterThan(0);
      const im = png(a.image); expect([im.width, im.height]).toEqual([a.columns * 84, a.rows * 120]); expect(Math.max(im.width, im.height)).toBeLessThanOrEqual(2048);
    }
    expect([atlas.get("building_t5")!.columns, atlas.get("building_t5")!.rows]).toEqual([24, 17]);
    const t4 = atlas.get("building_t4")!; const i4 = png(t4.image);
    for (const [p, rows] of Object.entries(T5)) {
      const s = byKey.get(`bld_${p}_t5`)!; const a = atlas.get(s.atlas)!; const col = png(a.image); const em = png(a.masks!.emissive!);
      const s4 = byKey.get(`bld_${p}_t4`)!;
      for (let r = 0; r < rows; r++) {
        expect(Math.abs(topOf(a, col, s.building!.frames[r]![0]!) - topOf(t4, i4, s4.building!.frames[r]![0]!)), `${p} rot ${r}`).toBeLessThanOrEqual(1);
        for (const i of s.animations.idle!.rotations![r]!) expect(glowOf(a, em, i), `${p} idle ${i}`).toBeGreaterThan(0);
        for (const i of s.building!.states!.unlit![r]!) expect(glowOf(a, em, i), `${p} unlit ${i}`).toBe(0);
      }
    }
  });
});

describe("ADR-590 / ADR-593 electricity icons", () => {
  const items = JSON.parse(readFileSync("packages/assets/pack/items/manifest.items.json", "utf8")) as { atlases: Atlas[]; sprites: { key: string; atlas: string; category: string; animations: { idle: { frames: number[] } } }[] };
  const ik = new Map(items.sprites.map((s) => [s.key, s]));
  const css = readFileSync("apps/client/src/gameplay-panels.css", "utf8");
  const ELEC = Object.keys(P);
  it("build_<key> for the 26 pieces and build_<piece>_t5 for the 15 tier pieces, each its own cell; kits point at build_<key>", () => {
    const keys = [...ELEC.map((k) => `build_${k}`), ...Object.keys(T5).map((p) => `build_${p}_t5`)]; expect(keys.length).toBe(41);
    const cells = new Set<number>();
    for (const k of keys) {
      const s = ik.get(k)!; expect(s?.atlas, k).toBe("items_build_elec"); expect(s.category, k).toBe("ui"); cells.add(s.animations.idle.frames[0]!);
      expect(css.includes(`[data-icon="${k}"]`), k).toBe(true);
    }
    expect(cells.size).toBe(41);
    const kits = (JSON.parse(readFileSync("packages/gameplay/data/items.json", "utf8")).items as { key: string }[]).filter((i) => i.key.startsWith("kit_"));
    expect(kits.length).toBe(25);
    for (const it of kits) {   // the kit's inventory icon is its build_<key> cell (brief section 6: same object, no second painting)
      expect(ELEC, it.key).toContain(it.key.slice(4)); const kit = ik.get(it.key)!; const b = ik.get(`build_${it.key.slice(4)}`)!;
      expect([kit?.atlas, kit?.category], it.key).toEqual(["items_build_elec", "item"]); expect(kit.animations.idle.frames, it.key).toEqual(b.animations.idle.frames);
      expect(css.includes(`[data-icon="${it.key}"]`), it.key).toBe(true); expect(FB.icons[it.key], it.key).toBeUndefined();
    }
  });
  it("components, skill medallions and power-prompt glyphs on the resident items_elec page (32 px + @2x); skills.json uses them", () => {
    const a = items.atlases.find((x) => x.key === "items_elec")!; expect(a.residency).toBe("resident"); expect([a.frameW, a.frameH]).toEqual([32, 32]);
    expect(a.pages?.[0]?.scale).toBe(2);
    const comp = ["circuit_board", "electric_motor", "solar_cell", "led_bulb"]; const ui = ["skill_electrician", "skill_power_grid", "skill_powered_tier", "skill_hydroponics", "icon_power_on", "icon_power_off", "icon_battery"];
    for (const k of [...comp, ...ui]) { const s = ik.get(k)!; expect(s?.atlas, k).toBe("items_elec"); expect(s.category, k).toBe(comp.includes(k) ? "item" : "ui"); expect(css.includes(`[data-icon="${k}"]`), k).toBe(true); }
    expect(new Set([...comp, ...ui].map((k) => ik.get(k)!.animations.idle.frames[0])).size).toBe(11);
    const nodes = JSON.parse(readFileSync("packages/gameplay/data/skills.json", "utf8")).nodes as { key: string; icon: string }[];
    const icon = (k: string) => nodes.find((n) => n.key === k)!.icon;
    expect([icon("electrician_craft"), icon("power_grid"), icon("hydroponics"), icon("powered_tier")]).toEqual(["skill_electrician", "skill_power_grid", "skill_hydroponics", "skill_powered_tier"]);
  });
});
