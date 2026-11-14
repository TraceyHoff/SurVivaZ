// ADR-404: the roof sits ON the wall tops. Pixel check against the real art (building + main pack atlases): every roof form,
// seated by its data seatPx (rfxSeat, added to zoffPx by RoofTiler.resolve), drawn over the walls it rests on (rfx depth bias / Canvas2D level order), must hide the back wall
// tops inside its footprint and meet the front wall tops with no gap and no sunk strip.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RFX, rfxPickLevel, rfxSeat, rfxSpriteKeys, type RfxForm, type RfxTile } from "@engine/assets";
import { RFX_SEAT_BIAS, roofClipLine } from "@engine/render";
import { decodeRgba } from "./png-rgba.js";

const ROOT = resolve(__dirname, "../../..");
interface Spr { key: string; atlas: string; anchor: { x: number; y: number }; building?: { piece: string; frames: number[][] } }
interface Atl { key: string; image: string; frameW: number; frameH: number; columns: number; dir: string }
const atl = new Map<string, Atl>(), spr = new Map<string, Spr>(), img = new Map<string, { w: number; rgba: Uint8Array }>();
for (const [dir, file] of [["packages/assets/pack/building/", "manifest.building.json"], ["packages/assets/pack/", "manifest.json"]] as const) {
  const m = JSON.parse(readFileSync(resolve(ROOT, dir, file), "utf8")) as { atlases: Omit<Atl, "dir">[]; sprites: Spr[] };
  for (const a of m.atlases) if (!atl.has(a.key)) atl.set(a.key, { ...a, dir }); for (const s of m.sprites) if (!spr.has(s.key)) spr.set(s.key, s);
}
const cache = new Map<string, [number, number][]>();
/** opaque (alpha >= 128) pixels of a building sprite at rotation r, relative to its anchor (2-row art: r >= 2 is flipX) */
function pixels(key: string, r: number): [number, number][] {
  const ck = key + "|" + r; const hit = cache.get(ck); if (hit) return hit;
  const s = spr.get(key)!, a = atl.get(s.atlas)!, rows = s.building!.frames; const ri = rows.length === 1 ? 0 : rows.length === 2 ? r & 1 : r & 3;
  const f = rows[ri]![0]!, flip = rows.length === 2 && (r & 3) >= 2;
  let im = img.get(a.key); if (!im) { im = decodeRgba(readFileSync(resolve(ROOT, a.dir, a.image))); img.set(a.key, im); }
  const fx = (f % a.columns) * a.frameW, fy = Math.floor(f / a.columns) * a.frameH, ax = s.anchor.x * a.frameW, ay = s.anchor.y * a.frameH, out: [number, number][] = [];
  for (let y = 0; y < a.frameH; y++) for (let x = 0; x < a.frameW; x++) if (im.rgba[((fy + y) * im.w + fx + x) * 4 + 3]! >= 128) out.push([Math.floor(flip ? ax - (x + 0.5 - ax) : x + 0.5 - ax), Math.floor(y + 0.5 - ay)]);
  cache.set(ck, out); return out;
}
const P = (wx: number, wy: number): [number, number] => [(wx - wy) * 32, (wx + wy) * 16];
const top = (key: string, r: number): number => Math.min(...pixels(key, r).map((p) => p[1]));
/** plain straight-wall art of every tier (main pack twig/wood/stone/metal + the building pack t1..t4) */
const PLAIN_WALLS = ["wall_twig", "wall", "wall_stone", "wall_metal", "bld_wall_t1", "bld_wall_t2", "bld_wall_t3", "bld_wall_t4"].filter((k) => spr.has(k));
/** row of a wall sprite whose face runs along world x (the N/S edges) */
const rowAlongX = (k: string): number => { const p = pixels(k, 0); let c = 0; for (const [x, y] of p) c += x * (y + 25); return c > 0 ? 0 : 1; };

const FORMS: [RfxForm, string, number][] = [["hip", "roof_slope", 1], ["gab", "roof_gable", 1], ["cot", "roof_cottage", 2], ["gam", "roof_gambrel", 1], ["shd", "roof_shed", 1], ["flt", "roof_flat", 1]];
/** W x H house at level 0, walls on every outer edge, one roof form on level 1 over the whole footprint. Walls are drawn
 *  with the ADR-404 clip (pixels above the seated roof plane dropped), the roof over them; per facing, how many visible
 *  wall columns meet roof art directly above their top (no strip above the roof, no background gap under it). */
function house(key: string, tier: number, wall: string, span = 15, W = 7, H = 5, clip = true) {
  const roof = new Set<string>(); let form: RfxForm = "hip";
  const tiles: RfxTile[] = []; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) tiles.push({ x, y, key, rot: 0, tier, wallMaterial: "stone" });
  for (const [cell, p] of rfxPickLevel(tiles, 1)) {
    const [tx, ty] = cell.split(",").map(Number) as [number, number]; const [cx, cy] = P(tx + 0.5, ty + 0.5); form = p.form;
    for (const [stem, row, z] of [[p.stem, p.row, p.zoffPx], ...p.overlays.map((o) => [o.key, o.row, o.zoffPx])] as [string, number, number][]) {
      const k = rfxSpriteKeys(stem, tier, p.skin).find((s) => spr.has(s)); if (!k) continue;
      for (const [x, y] of pixels(k, row)) roof.add(`${cx + x},${cy + y - RFX.levelPx - z - rfxSeat(p.form)}`);
    }
  }
  const rx = rowAlongX(wall), meet: Record<"N" | "S" | "W" | "E", { ok: number; n: number }> = { N: { ok: 0, n: 0 }, S: { ok: 0, n: 0 }, W: { ok: 0, n: 0 }, E: { ok: 0, n: 0 } };
  const edges: [number, number, "N" | "S" | "W" | "E", number][] = [];
  for (let x = 0; x < W; x++) edges.push([x + 0.5, 0, "N", rx], [x + 0.5, H, "S", rx]);
  for (let y = 0; y < H; y++) edges.push([0, y + 0.5, "W", rx ^ 1], [W, y + 0.5, "E", rx ^ 1]);
  for (const [wx, wy, e, r] of edges) {
    const [sx, sy] = P(wx, wy); const line = roofClipLine(wx, wy, RFX.levelPx + rfxSeat(form), 0, 16, 32);
    expect(line.k).toBe(e === "N" || e === "S" ? -0.5 : 0.5); // N/S edges run along world x (view u at view 0): down-right
    const colTop = new Map<number, number>();
    for (const [x, y] of pixels(wall, r)) { if (clip && -y > line.h0 + line.k * x) continue; colTop.set(x, Math.min(colTop.get(x) ?? 1e9, y)); }
    for (const [x, t] of colTop) { if (Math.abs(x) > span) continue; meet[e].n++; if (roof.has(`${sx + x},${sy + t - 1}`)) meet[e].ok++; }
  }
  return meet;
}
const frac = (m: { ok: number; n: number }): number => m.ok / Math.max(1, m.n);

describe("ADR-404 roof seat", () => {
  it("clip line follows the edge: view-u edges slope down-right, view-v edges down-left, posts / centres level", () => {
    expect(roofClipLine(3.5, 2, 57, 0, 16, 32)).toEqual({ h0: 57, k: -0.5, apex: false });
    expect(roofClipLine(3, 2.5, 57, 4, 16, 32)).toEqual({ h0: 53, k: 0.5, apex: false });
    expect(roofClipLine(3, 2, 57, 0, 16, 32).k).toBe(0); expect(roofClipLine(3.5, 2.5, 57, 0, 16, 32).k).toBe(0);
    // vertex posts: roofed view cells around the post pick the line (far corner = V, far edge = that edge, else level)
    const at = (cells: string[]) => (du: number, dv: number): boolean => cells.includes(`${du},${dv}`);
    expect(roofClipLine(3, 2, 57, 0, 16, 32, at(["0.5,0.5"]))).toEqual({ h0: 57, k: 0, apex: true });
    expect(roofClipLine(3, 2, 57, 0, 16, 32, at(["0.5,0.5", "0.5,-0.5"]))).toEqual({ h0: 57, k: 0.5, apex: false });
    expect(roofClipLine(3, 2, 57, 0, 16, 32, at(["0.5,0.5", "-0.5,0.5"]))).toEqual({ h0: 57, k: -0.5, apex: false });
    expect(roofClipLine(3, 2, 57, 0, 16, 32, at(["-0.5,-0.5"]))).toEqual({ h0: 57, k: 0, apex: false });
  });
  it("seats lie between the floor and the wall-top height of the plain wall art", () => {
    const tops = PLAIN_WALLS.flatMap((k) => [0, 1].map((r) => -top(k, r) - RFX.levelPx));
    expect(PLAIN_WALLS.length).toBeGreaterThanOrEqual(6);
    for (const [f] of FORMS) { const s = RFX.forms[f].seatPx ?? 0; expect(s, f).toBeGreaterThan(0); expect(s, f).toBeLessThanOrEqual(Math.max(...tops)); }
  });
  it("rfx parts out-rank the walls they rest on in the WebGL2 depth key (front wall top + vertex post)", () => {
    expect(RFX_SEAT_BIAS).toBeGreaterThan(0.45 + 61 / 48 + 0.53 - 1 - 0.05 - 13 / 48);
  });
  // E is the gable / shed / flat end on these houses: there the end strip art, not the roof surface, sits above the wall
  // (checked in the composites); every other facing must meet the roof on >= 90% of the wall's edge columns
  for (const [f, key, tier] of FORMS) for (const wall of PLAIN_WALLS) it(`${f} on ${wall}: clipped wall tops meet the roof on every facing`, () => {
    const m = house(key, tier, wall);
    for (const e of ["N", "W", "S", "E"] as const) {
      if (e === "E" && f !== "hip" && f !== "cot") continue;
      expect(m[e].n, `${f}/${wall} ${e} columns`).toBeGreaterThan(50);
      expect(frac(m[e]), `${f}/${wall} ${e} meet ${m[e].ok}/${m[e].n}`).toBeGreaterThanOrEqual(0.9);
    }
  });
  it("the unseated, unclipped roof (before ADR-404) fails: back wall tops show above it", () => {
    for (const [f, key, tier] of FORMS) { if (f === "shd" || f === "flt" || f === "cot") continue;
      const s = RFX.forms[f].seatPx ?? 0; RFX.forms[f].seatPx = 0;
      try { const m = house(key, tier, "bld_wall_t1", 15, 7, 5, false); expect(frac(m.N), f).toBeLessThan(0.6); } finally { RFX.forms[f].seatPx = s; }
    }
  });
});
