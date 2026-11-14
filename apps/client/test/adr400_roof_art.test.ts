// ADR-400: Art's rfx base set is live. Every key the ADR-397 selection asks for resolves to a packed sprite at every tier the
// piece can be built at; rfx pages stream with buildings; hip / gable / flat build tiles show Art's dedicated form icons;
// the ADR-398 forms are in the menu with their own icons; the Guide's spring row shows ic_blossom.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { rfxPickLevel, rfxSpriteKeys, type RfxTile } from "@engine/assets";
import { isStreamedBuildingAtlas } from "@engine/render";
import { guideFactIcon } from "@engine/gameplay";
import { iconKeysFromCss, buildIconKey } from "../src/gameplay-panels.js";
import { roofMenu, roofMenuIconKey, roofMenuLabel } from "../src/roof-menu.js";
import { rfxStandIn } from "../src/roof-tiler.js";
import { ICON_DATA } from "../src/game-icons-data.js";

const read = (p: string): string => readFileSync(resolve(__dirname, "../../..", p), "utf8");
const BLD = JSON.parse(read("packages/assets/pack/building/manifest.building.json")) as { atlases: { key: string }[]; sprites: { key: string; atlas: string; building?: { piece?: string } }[] };
const ITEMS = JSON.parse(read("packages/assets/pack/items/manifest.items.json")) as { sprites: { key: string; atlas?: string }[] };
const PIECES = (JSON.parse(read("packages/gameplay/data/pieces.json")) as { pieces: { key: string; minTier?: number }[] }).pieces;
const KEYS = new Set(BLD.sprites.map((s) => s.key));
const ROOF_PIECES = ["roof_flat", "roof_slope", "roof_corner", "roof_hip", "roof_gable", "roof_chimney", "roof_cottage", "roof_gambrel", "roof_shed"];
const minTier = (k: string): number => PIECES.find((p) => p.key === k)!.minTier ?? 0;

const rect = (key: string, w: number, h: number, rot: number, tier: number, x0 = 0, y0 = 0): RfxTile[] => {
  const out: RfxTile[] = []; for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) out.push({ x, y, key, rot, tier }); return out;
};
/** Rectangles 1..14 square-ish and long, an L, a T, a plus, a ring, a notched block: every shape class the table has. */
function shapes(key: string, rot: number, tier: number): RfxTile[][] {
  const out: RfxTile[][] = [];
  for (const [w, h] of [[1, 1], [1, 2], [2, 2], [3, 3], [1, 6], [2, 7], [3, 9], [4, 4], [5, 5], [6, 6], [7, 7], [8, 8], [9, 9], [10, 10], [11, 11], [12, 13], [14, 14], [13, 3], [3, 13], [20, 2]] as const) out.push(rect(key, w, h, rot, tier));
  out.push([...rect(key, 9, 9, rot, tier), ...rect(key, 4, 6, rot, tier, 0, 9)]); // L
  out.push([...rect(key, 9, 3, rot, tier), ...rect(key, 3, 6, rot, tier, 3, 3)]); // T
  out.push([...rect(key, 3, 9, rot, tier, 3, 0), ...rect(key, 3, 3, rot, tier, 0, 3), ...rect(key, 3, 3, rot, tier, 6, 3)]); // plus
  out.push(rect(key, 7, 7, rot, tier).filter((t) => !(t.x >= 2 && t.x <= 4 && t.y >= 2 && t.y <= 4))); // ring (courtyard)
  out.push(rect(key, 6, 6, rot, tier).filter((t) => !(t.x >= 4 && t.y <= 1))); // notched
  out.push(rect(key, 5, 5, rot, tier).filter((t) => (t.x + t.y) % 2 === 0 || t.x === 2)); // diagonal-only links (8-connected)
  return out;
}

describe("ADR-400 every rfx key the engine requests resolves", () => {
  it("tiles and overlays, all forms, all ridge / pitch directions, every buildable tier (mixed legacy regions too)", () => {
    const missing = new Set<string>(); let picks = 0, overlays = 0;
    const regions: [string, RfxTile[]][] = [];
    for (const key of ROOF_PIECES) for (let tier = minTier(key); tier <= 4; tier++) for (let rot = 0; rot < 4; rot++) for (const r of shapes(key, rot, tier)) regions.push([key, r]);
    for (let tier = 1; tier <= 4; tier++) { // a hip region with a chimney and gable members, a gable region with a chimney
      const mix = rect("roof_slope", 6, 5, 0, tier); mix[8] = { ...mix[8]!, key: "roof_chimney" }; mix[0] = { ...mix[0]!, key: "roof_gable" }; regions.push(["mix", mix]);
      const gch = rect("roof_gable", 5, 4, 1, tier); gch[6] = { ...gch[6]!, key: "roof_chimney" }; regions.push(["gch", gch]);
    }
    for (const [label, r] of regions) {
      for (const [cell, p] of rfxPickLevel(r, 1)) {
        const tier = r.find((t) => `${t.x},${t.y}` === cell)!.tier; picks++;
        if (!rfxSpriteKeys(p.stem, tier).some((k) => KEYS.has(k))) missing.add(`${label}: ${p.stem}_t${tier}`);
        for (const o of p.overlays) { overlays++; if (!rfxSpriteKeys(o.key, tier).some((k) => KEYS.has(k))) missing.add(`${label}: ${o.key}_t${tier}`); }
      }
    }
    expect([...missing].sort()).toEqual([]);
    expect(picks).toBeGreaterThan(50_000); expect(overlays).toBeGreaterThan(5_000);
  });
  it("the hashed variants and crests the selection names are all packed (no silent fallback to the base stem)", () => {
    for (const k of ["rfx_hip_up_e_v1_t0", "rfx_hip_up_f_v2_t4", "rfx_flt_f_v1_t0", "rfx_gab_up_ec_t1", "rfx_gam_up_vf_t4", "rfx_shd_lotop_e_t0", "rfx_chimney_t1"]) expect(KEYS.has(k), k).toBe(true);
  });
});

describe("ADR-400 rfx pages stream and evict with buildings", () => {
  it("bld pool: building tier pages and every rfx page; not other sheets, never a blob page", () => {
    const rfx = BLD.atlases.map((a) => a.key).filter((k) => k.startsWith("rfx_"));
    expect(rfx.length).toBe(12); // + rfx_shk_t0 / rfx_shk_t1 (Art 5793d0e9)
    expect(rfx).toEqual(expect.arrayContaining(["rfx_shk_t0", "rfx_shk_t1"]));
    for (const k of rfx) expect(isStreamedBuildingAtlas(k, `/art/pack/building/atlases/${k}.png`), k).toBe(true);
    expect(isStreamedBuildingAtlas("building_t2", "/x.png")).toBe(true);
    expect(isStreamedBuildingAtlas("rfx_t1_a", "blob:x")).toBe(false);
    expect(isStreamedBuildingAtlas("items_build_rfx", "/x.png")).toBe(false); // UI icon sheet: the build window's CSS, not the world
  });
});

describe("ADR-400 build menu with Art's roof art", () => {
  const forms = new Set(["hip", "gab", "flt", "cot", "gam", "shd"]);
  const ART = new Set(ITEMS.sprites.filter((s) => s.atlas === "items_build" || s.atlas === "items_build_rfx").map((s) => s.key));
  const CSS = iconKeysFromCss([read("apps/client/src/gameplay-panels.css")]);
  const has = (k: string): boolean => ART.has(k) && CSS.has(k);
  it("one entry per form, labelled by form", () => {
    expect(roofMenu(ROOF_PIECES.map((key) => ({ key })), forms).map((p) => p.key)).toEqual(["roof_flat", "roof_slope", "roof_gable", "roof_chimney", "roof_cottage", "roof_gambrel", "roof_shed"]);
    expect(["roof_slope", "roof_gable", "roof_flat", "roof_cottage", "roof_gambrel", "roof_shed"].map((k) => roofMenuLabel(k, forms))).toEqual(["hip roof", "gable roof", "flat roof", "cottage roof", "gambrel roof", "shed roof"]);
  });
  it("hip / gable / flat tiles show Art's dedicated form icons at every buildable tier; the new forms their own", () => {
    const want: Record<string, string> = { roof_slope: "rfx_hip", roof_gable: "rfx_gab", roof_flat: "rfx_flt", roof_cottage: "roof_cottage", roof_gambrel: "roof_gambrel", roof_shed: "roof_shed" };
    for (const [piece, icon] of Object.entries(want)) {
      expect(roofMenuIconKey(piece, forms)).toBe(icon);
      for (let t = minTier(piece); t <= 4; t++) expect(buildIconKey(roofMenuIconKey(piece, forms), t, true, has), `${piece}@t${t}`).toBe(`build_${icon}_t${t}`);
    }
    expect(roofMenuIconKey("roof_slope", new Set())).toBe("roof_slope"); // before the form ships: the legacy piece icon
    expect(roofMenuIconKey("roof_chimney", forms)).toBe("roof_chimney");
  });
});

describe("ADR-400 the Guide's spring row", () => {
  it("shows Art's spring icon ic_blossom, embedded like the other season icons", () => {
    expect(guideFactIcon("seasons.spring.tempRange", "tempRangeF")).toEqual({ kind: "file", file: "ic_blossom.png" });
    expect(ICON_DATA["ic_blossom.png"]?.startsWith("data:image/png")).toBe(true);
  });
});

describe("ADR-400 rfx-only forms have a picture before they join a roof", () => {
  const PIECE = new Map(BLD.sprites.map((s) => [s.key, s.building?.piece]));
  const art = (k: string): string | undefined => PIECE.get(k);
  it("cottage / gambrel / shed alone: Art's own lone-tile pick for that form and tier (sprite piece base @ key)", () => {
    expect(rfxStandIn("roof_cottage", 0, 2, art)).toEqual({ ...split(PIECE.get("rfx_cot_lo_p_t2")!, "rfx_cot_lo_p_t2"), row: 0 });
    expect(rfxStandIn("roof_gambrel", 1, 1, art)!.variant).toBe("rfx_gam_lo_r_t1");
    expect(rfxStandIn("roof_shed", 3, 0, art)).toMatchObject({ variant: "rfx_shd_lotop_e_t0", row: 3 });
    for (const k of ["roof_cottage", "roof_gambrel", "roof_shed"]) for (let t = minTier(k); t <= 4; t++) for (let r = 0; r < 4; r++) expect(rfxStandIn(k, r, t, art), `${k} t${t} r${r}`).toBeDefined();
  });
  it("pieces with legacy art keep it (no stand-in)", () => { for (const k of ["roof_slope", "roof_gable", "roof_flat", "roof_chimney", "wall"]) expect(rfxStandIn(k, 0, 1, art)).toBeUndefined(); });
});
function split(piece: string, key: string): { pieceKey: string; variant: string } { const at = piece.indexOf("@"); expect(piece.slice(at + 1)).toBe(key); return { pieceKey: piece.slice(0, at), variant: key }; }
