// ADR-404: the roof sits ON the wall tops. Pixel check against the real art (building + main pack atlases): every roof form,
// seated by its data seatPx (rfxSeat, added to zoffPx by RoofTiler.resolve), drawn over the walls it rests on (rfx depth bias / Canvas2D level order), must hide the back wall
// tops inside its footprint and meet the front wall tops with no gap and no sunk strip.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RFX, rfxPickLevel, rfxSeat, rfxSpriteKeys, type RfxForm, type RfxTile } from "@engine/assets";
import { RFX_SEAT_BIAS } from "@engine/render";
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
/** W x H house at level 0, walls on every outer edge, one roof form on level 1 over the whole footprint */
function house(form: string, tier: number, wall: string, W = 7, H = 5) {
  const roof = new Set<string>(); let roofBottom = new Map<number, number>();
  const tiles: RfxTile[] = []; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) tiles.push({ x, y, key: form, rot: 0, tier, wallMaterial: "stone" });
  for (const [cell, p] of rfxPickLevel(tiles, 1)) {
    const [tx, ty] = cell.split(",").map(Number) as [number, number]; const [cx, cy] = P(tx + 0.5, ty + 0.5);
    for (const [stem, row, z] of [[p.stem, p.row, p.zoffPx], ...p.overlays.map((o) => [o.key, o.row, o.zoffPx])] as [string, number, number][]) {
      const k = rfxSpriteKeys(stem, tier, p.skin).find((s) => spr.has(s)); if (!k) continue;
      for (const [x, y] of pixels(k, row)) { const sx = cx + x, sy = cy + y - RFX.levelPx - z - rfxSeat(p.form); roof.add(`${sx},${sy}`); roofBottom.set(sx, Math.max(roofBottom.get(sx) ?? -1e9, sy)); }
    }
  }
  const rx = rowAlongX(wall), back = { covered: 0, total: 0 }, front: number[] = [], frontBy: Record<string, number[]> = {};
  const edges: [number, number, "N" | "S" | "W" | "E", number][] = [];
  for (let x = 0; x < W; x++) edges.push([x + 0.5, 0, "N", rx], [x + 0.5, H, "S", rx]);
  for (let y = 0; y < H; y++) edges.push([0, y + 0.5, "W", rx ^ 1], [W, y + 0.5, "E", rx ^ 1]);
  for (const [wx, wy, e, r] of edges) {
    const [sx, sy] = P(wx, wy); const colTop = new Map<number, number>(); for (const [x, y] of pixels(wall, r)) colTop.set(x, Math.min(colTop.get(x) ?? 1e9, y));
    for (const [x, t] of colTop) {
      if (Math.abs(x) > 15) continue; // the wall's own edge span (posts past the tile corners need eave art: ADR-404 Art request)
      const X = sx + x, Y = sy + t;
      if (e === "N" || e === "W") { back.total++; if (roof.has(`${X},${Y}`)) back.covered++; }
      else { front.push((roofBottom.get(X) ?? -1e9) - Y); (frontBy[e] ??= []).push((roofBottom.get(X) ?? -1e9) - Y); } // >= 0: the roof's lowest pixel in this column reaches the wall top (no gap)
    }
  }
  return { back, front, frontBy };
}

describe("ADR-404 roof seat", () => {
  it("seats lie between the floor and the wall-top height of the plain wall art, and seat 0 (the sunk roof) fails the check", () => {
    const tops = PLAIN_WALLS.flatMap((k) => [0, 1].map((r) => -top(k, r) - RFX.levelPx));
    expect(PLAIN_WALLS.length).toBeGreaterThanOrEqual(6);
    for (const [f, key, tier] of FORMS) {
      const s = RFX.forms[f].seatPx ?? 0; expect(s, f).toBeGreaterThan(0); expect(s, f).toBeLessThanOrEqual(Math.max(...tops));
      if (f === "shd" || f === "flt") continue; // their art already carries a low eave/parapet
      RFX.forms[f].seatPx = 0; try { const { back } = house(key, tier, "bld_wall_t1"); expect(back.covered / back.total, f).toBeLessThan(0.5); } finally { RFX.forms[f].seatPx = s; }
    }
  });
  it("rfx parts out-rank the walls they rest on in the WebGL2 depth key (front wall top + vertex post)", () => {
    // front edge wall pivot +0.45, its top ~61 px x uZPerPx (1/48), a vertex post +0.53; the eave pixels sit below the tile pivot (no height term)
    expect(RFX_SEAT_BIAS).toBeGreaterThan(0.45 + 61 / 48 + 0.53 - 1 - 0.05 - 13 / 48);
  });
  for (const [f, key, tier] of FORMS) for (const wall of PLAIN_WALLS) it(`${f} on ${wall}: back wall tops covered, front wall tops met`, () => {
    const { back, front } = house(key, tier, wall);
    expect(back.total).toBeGreaterThan(100);
    expect(back.covered / back.total, `${f}/${wall} back covered ${back.covered}/${back.total}`).toBeGreaterThanOrEqual(0.85);
    const gaps = front.filter((d) => d < -2).length; // a column whose roof stops > 2 px above the wall top = a visible gap
    expect(gaps / front.length, `${f}/${wall} front gap columns ${gaps}/${front.length}`).toBeLessThanOrEqual(0.05);
  });
});
