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
};
const DELIVERED = Object.keys(P);
const png = (p: string) => { const d = decodeRgba(readFileSync(root + p)); return { width: d.w, height: d.h, data: d.rgba }; };
const PX_M = 53 / 1.75;

describe("ADR-590 electricity-tier art", () => {
  it("every delivered key has its own sprite on an elec_<class> page with the hearth lit/unlit convention", () => {
    for (const k of DELIVERED) {
      const [, cls, rows, nf, fps, fw, fh] = P[k]!; const s = byKey.get(k)!;
      expect(s, k).toBeDefined(); expect(s.atlas, k).toMatch(new RegExp(`^elec_${cls}(_\\d+)?$`));
      // sprite_fallbacks keeps its $placeholder entry until build_<key> ships (the build tile borrows it, adr229); resolveSprite
      // returns the key itself, untinted, whenever the pack has it, so the real art already wins in the world.
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
