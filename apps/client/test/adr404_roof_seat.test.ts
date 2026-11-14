// ADR-404: the roof sits ON the wall tops. Pixel check against the real art (building + main pack atlases): every roof form,
// seated by its data seatPx (rfxSeat, added to zoffPx by RoofTiler.resolve), drawn over the walls it rests on (rfx depth bias / Canvas2D level order), must hide the back wall
// tops inside its footprint and meet the front wall tops with no gap and no sunk strip.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RFX, rfxClipsAt, rfxPickLevel, rfxSeat, type RfxPick, rfxSpriteKeys, type RfxForm, type RfxTile } from "@engine/assets";
import { RFX_SEAT_BIAS, roofClipAt, roofClipLine } from "@engine/render";
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
  const roof = new Set<string>(); let form: RfxForm = "hip"; const picks = new Map<string, RfxPick>();
  const tiles: RfxTile[] = []; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) tiles.push({ x, y, key, rot: 0, tier, wallMaterial: "stone" });
  for (const [cell, p] of rfxPickLevel(tiles, 1)) {
    const [tx, ty] = cell.split(",").map(Number) as [number, number]; const [cx, cy] = P(tx + 0.5, ty + 0.5); form = p.form; picks.set(cell, p);
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
    const ix = e === "E" ? W - 1 : Math.floor(wx), iy = e === "S" ? H - 1 : Math.floor(wy); // the roofed tile inside this wall
    const cut = clip && rfxClipsAt(picks.get(`${ix},${iy}`)!, wx - ix - 0.5, wy - iy - 0.5); // ADR-509: the form's clip rule
    expect(line.k).toBe(e === "N" || e === "S" ? -0.5 : 0.5); // N/S edges run along world x (view u at view 0): down-right
    const colTop = new Map<number, number>();
    for (const [x, y] of pixels(wall, r)) { if (cut && -y > line.h0 + line.k * x) continue; colTop.set(x, Math.min(colTop.get(x) ?? 1e9, y)); }
    for (const [x, t] of colTop) { if (Math.abs(x) > span) continue; meet[e].n++; if (roof.has(`${sx + x},${sy + t - 1}`)) meet[e].ok++; }
  }
  return meet;
}
const frac = (m: { ok: number; n: number }): number => m.ok / Math.max(1, m.n);

describe("ADR-404 roof seat", () => {
  it("clip line follows the edge: view-u edges slope down-right, view-v edges down-left, posts / centres level", () => {
    expect(roofClipLine(3.5, 2, 57, 0, 16, 32)).toEqual({ h0: 57, k: -0.5, apex: false, c: 0 });
    expect(roofClipLine(3, 2.5, 57, 4, 16, 32)).toEqual({ h0: 53, k: 0.5, apex: false, c: 0 });
    expect(roofClipLine(3, 2, 57, 0, 16, 32).k).toBe(0); expect(roofClipLine(3.5, 2.5, 57, 0, 16, 32).k).toBe(0);
    // vertex posts: roofed view cells around the post pick the line (far corner = V, far edge = that edge, else level)
    const at = (cells: string[]) => (du: number, dv: number): boolean => cells.includes(`${du},${dv}`);
    expect(roofClipLine(3, 2, 57, 0, 16, 32, at(["0.5,0.5"]))).toEqual({ h0: 57, k: 0, apex: true, c: 0 });
    expect(roofClipLine(3, 2, 57, 0, 16, 32, at(["0.5,0.5", "0.5,-0.5"]))).toEqual({ h0: 57, k: 0.5, apex: false, c: 0 });
    expect(roofClipLine(3, 2, 57, 0, 16, 32, at(["0.5,0.5", "-0.5,0.5"]))).toEqual({ h0: 57, k: -0.5, apex: false, c: 0 });
    expect(roofClipLine(3, 2, 57, 0, 16, 32, at(["-0.5,-0.5"]))).toEqual({ h0: 57, k: 0, apex: false, c: 0 });
    // a far wall ending at the roof's far corner: past that end its post follows the other eave down
    const w = roofClipLine(3.5, 2, 57, 0, 16, 32, at(["0,0.5"])); // view-u wall (3.5, 2); far corner at its -u end (3, 2)
    expect(w).toEqual({ h0: 57, k: -0.5, apex: true, c: -16 });
    expect(roofClipAt(w, 0)).toBeCloseTo(0); expect(roofClipAt(w, -16)).toBe(8); expect(roofClipAt(w, -24)).toBe(4);
  });
  it("seats lie between the floor and the wall-top height of the plain wall art", () => {
    const tops = PLAIN_WALLS.flatMap((k) => [0, 1].map((r) => -top(k, r) - RFX.levelPx));
    expect(PLAIN_WALLS.length).toBeGreaterThanOrEqual(6);
    for (const [f] of FORMS) { const s = RFX.forms[f].seatPx ?? 0; expect(s, f).toBeGreaterThan(0); expect(s, f).toBeLessThanOrEqual(Math.max(...tops)); }
  });
  it("rfx parts out-rank the walls they rest on in the WebGL2 depth key (front wall top + vertex post)", () => {
    expect(RFX_SEAT_BIAS).toBeGreaterThan(0.45 + 61 / 48 + 0.53 - 1 - 0.05 - 13 / 48);
  });
  // ADR-509: Art's eave pass (c203cbec) + data seats / clip modes: every facing meets the roof on the wall's edge span,
  // and the near/far facings also with the posts past the tile corners (+-23 px; the 8 px corner flare covers most)
  for (const [f, key, tier] of FORMS) for (const wall of PLAIN_WALLS) it(`${f} on ${wall}: wall tops meet the roof on every facing (clip ${RFX.forms[f].clip ?? "all"})`, () => {
    const m = house(key, tier, wall), full = house(key, tier, wall, 23);
    for (const e of ["N", "W", "S", "E"] as const) {
      expect(m[e].n, `${f}/${wall} ${e} columns`).toBeGreaterThan(50);
      expect(frac(m[e]), `${f}/${wall} ${e} meet ${m[e].ok}/${m[e].n}`).toBeGreaterThanOrEqual(0.9);
      if (e !== "E") expect(frac(full[e]), `${f}/${wall} ${e} meet with posts ${full[e].ok}/${full[e].n}`).toBeGreaterThanOrEqual(0.85);
    }
  });
  it("ADR-509 knobs are data: hip / cot seat at the wall top with no wall clip (posts only); low-seated forms (gab / gam / shd / flt) clip all", () => {
    for (const f of ["hip", "cot"] as const) { expect(RFX.forms[f].clip, f).toBe("posts"); expect(RFX.forms[f].seatPx, f).toBeGreaterThanOrEqual(12); }
    // until Art's ~8 px end strips land these sit low (<= 9) and must clip EVERY side: with "ends" the eave-side wall caps
    // and vertex posts stood ~6 px above the eave (rendered shake cabin: a cap strip along the far eave, post tops on the near one)
    for (const f of ["gab", "gam", "shd"] as const) { expect(RFX.forms[f].clip ?? "all", f).toBe("all"); expect(RFX.forms[f].seatPx!, f).toBeLessThanOrEqual(9); }
    expect(RFX.forms.flt.clip ?? "all").toBe("all"); expect(RFX.forms.flt.seatPx!).toBeLessThanOrEqual(9);
    // the rule itself: centre always, sides per mode, a corner when either side is an end
    const p = { form: "gab", ends: 1 << 3 } as unknown as RfxPick; // E end
    const ends = { ...RFX, forms: { ...RFX.forms, gab: { ...RFX.forms.gab, clip: "ends" as const } } }; // the "ends" mode (kept for the longer end strips)
    expect(rfxClipsAt(p, 0, 0, ends)).toBe(true); expect(rfxClipsAt(p, 0.5, 0, ends)).toBe(true); expect(rfxClipsAt(p, 0, 0.5, ends)).toBe(false); expect(rfxClipsAt(p, 0.5, 0.5, ends)).toBe(true);
    expect(rfxClipsAt(p, 0, 0.5)).toBe(true); // live gab data: all
    expect(rfxClipsAt({ ...p, form: "hip" } as RfxPick, 0.5, 0)).toBe(false); expect(rfxClipsAt({ ...p, form: "flt" } as RfxPick, 0, 0.5)).toBe(true);
    expect(rfxClipsAt({ ...p, form: "hip" } as RfxPick, 0.5, 0.5)).toBe(true); expect(rfxClipsAt({ ...p, form: "cot" } as RfxPick, -0.5, 0)).toBe(false); // posts mode
  });
  it("only a form seated at the wall top may leave wall panels unclipped (a low seat with clip ends / posts / none shows the wall caps)", () => {
    const tops = PLAIN_WALLS.flatMap((k) => [0, 1].map((r) => -top(k, r) - RFX.levelPx)), lo = Math.min(...tops);
    for (const [f] of FORMS) { const c = RFX.forms[f].clip ?? "all"; if (c !== "all") expect(RFX.forms[f].seatPx ?? 0, `${f} clip ${c}`).toBeGreaterThanOrEqual(lo - 1); }
  });
  it("the unseated, unclipped roof (before ADR-404) fails: back wall tops show above it", () => {
    for (const [f, key, tier] of FORMS) { if (f === "shd" || f === "flt" || f === "cot") continue;
      const s = RFX.forms[f].seatPx ?? 0; RFX.forms[f].seatPx = 0;
      try { const m = house(key, tier, "bld_wall_t1", 15, 7, 5, false); expect(frac(m.N), f).toBeLessThan(0.6); } finally { RFX.forms[f].seatPx = s; }
    }
  });
});
