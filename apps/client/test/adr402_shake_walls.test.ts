import { describe, expect, it } from "vitest";
import { World } from "@engine/core";
import * as G from "@engine/gameplay";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RFX, rfxPickLevel, rfxRuleMatches, rfxSpriteKeys, type RfxTile } from "@engine/assets";
import { RoofTiler, roofWallMaterial } from "../src/roof-tiler.js";

function world(): World { const w = new World({ seed: 7, maxEntities: 1 << 14 }); G.installGameplay(w, {}); return w; }
function place(w: World, key: string, x: number, y: number, level: number, rot: number, tier: number, variant = 0): number {
  const d = G.gameplayDefs(w); const sn = G.snapPlacement(w, { piece: d.pieceId(key), x, y, level, rot, tier, variant });
  if (typeof sn === "number") throw new Error(`${key} ${sn}`); return G.placePiece(w, 0, sn, {});
}
const rule = RFX.materials.rules[0]!;

describe("ADR-402: shake rule data (Art §8, compacted)", () => {
  it("is ONE rule whose log-wall tier set is one entry: twig + wood (owner decision, Art 4ff07a07)", () => {
    expect(RFX.materials.rules).toHaveLength(1);
    expect(rule).toMatchObject({ skin: "shk", wallTiers: ["twig", "wood"], wallVariants: ["clan_palisade"], sites: ["cabin", "hunter_shack", "fisher_hut"] });
    expect(rule.forms).toEqual(["hip", "gab", "shd", "cot"]);
  });
  it("matches exactly what Art's nine-entry list matched", () => {
    for (const m of ["twig", "wood", "twig:clan_palisade", "stone:clan_palisade", "reinforced:clan_palisade", "site:cabin", "site:hunter_shack", "site:fisher_hut"]) expect(rfxRuleMatches(rule, m), m).toBe(true);
    for (const m of ["stone", "metal", "reinforced", "twig:clan_wood", "stone:clan_stone", "site:barn", "site:cottage", "cabin"]) expect(rfxRuleMatches(rule, m), m).toBe(false);
  });
  it("Art's vote: strict majority of supporting walls, tie -> base; unlisted forms never take the skin", () => {
    const tiles = (mats: (string | undefined)[], key = "roof_slope"): RfxTile[] => mats.map((m, i) => ({ x: i, y: 0, key, rot: 0, tier: 1, ...(m ? { wallMaterial: m } : {}) }));
    const skin = (t: RfxTile[]) => [...rfxPickLevel(t, 1).values()][0]!.skin;
    expect(skin(tiles(["twig", "wood", "stone"]))).toBe("shk");
    expect(skin(tiles(["twig", "stone"]))).toBeUndefined();
    expect(skin(tiles(["site:cabin", undefined, undefined, "metal", "site:cabin"]))).toBe("shk");
    expect(skin(tiles(["twig", "twig"], "roof_flat"))).toBeUndefined();
    expect(skin(tiles(["twig", "twig"], "roof_gambrel"))).toBeUndefined();
  });
});

describe("ADR-402: every shake key the engine requests resolves to Art's shake art where §8 has it", () => {
  const KEYS = new Set((JSON.parse(readFileSync(resolve(__dirname, "../../../packages/assets/pack/building/manifest.building.json"), "utf8")) as { sprites: { key: string }[] }).sprites.map((s) => s.key));
  const MIN = new Map((JSON.parse(readFileSync(resolve(__dirname, "../../../packages/gameplay/data/pieces.json"), "utf8")) as { pieces: { key: string; minTier?: number }[] }).pieces.map((p) => [p.key, p.minTier ?? 0]));
  const SHK: Record<string, number[]> = { roof_slope: [0, 1], roof_shed: [0, 1], roof_gable: [1], roof_cottage: [1] }; // hip / shd t0; hip / gab / cot / shd t1
  it("hip / gab / cot / shd regions on log walls: every tile and overlay draws *_shk_t<N>; t2+ and other forms fall back to base", () => {
    const bad: string[] = [];
    for (const key of ["roof_slope", "roof_gable", "roof_cottage", "roof_shed", "roof_flat", "roof_gambrel"]) for (let tier = MIN.get(key)!; tier <= 4; tier++) for (let rot = 0; rot < 4; rot++) for (const [w, h] of [[1, 1], [2, 3], [4, 4], [6, 4], [9, 7], [5, 13]] as const) {
      const chimney = key === "roof_slope" && w > 3 && tier >= MIN.get("roof_chimney")!;
      const tiles: RfxTile[] = []; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tiles.push({ x, y, key: chimney && x === 1 && y === 1 ? "roof_chimney" : key, rot, tier, wallMaterial: "twig" });
      const want = SHK[key]?.includes(tier) ?? false;
      for (const p of rfxPickLevel(tiles, 1).values()) for (const stem of [p.stem, ...p.overlays.map((o) => o.key)]) {
        const got = rfxSpriteKeys(stem, tier, p.skin).find((k) => KEYS.has(k));
        if (!got) bad.push(`${key} t${tier} ${stem}: none`);
        else if (want !== got.includes("_shk_") && !(stem.startsWith("rfx_chimney") && tier !== 1)) bad.push(`${key} t${tier} ${stem}: ${got}`);
      }
    }
    expect([...new Set(bad)].sort()).toEqual([]);
  });
});

describe("ADR-402: wall variant names reach the roof", () => {
  it("wall exposes variantNames; the plain look reports the bare tier, palisade reports <tier>:clan_palisade", () => {
    const w = world(); const d = G.gameplayDefs(w);
    expect(d.pieces.get(d.pieceId("wall"))!.variantNames).toEqual(["plain", "clan_wood", "clan_stone", "clan_palisade"]);
    place(w, "foundation", 3.5, 3.5, 0, 0, 2); place(w, "wall", 3.5, 3.02, 0, 0, 2, 3);
    expect(roofWallMaterial(w, 3, 3, 0)).toBe("stone:clan_palisade");
    place(w, "foundation", 6.5, 3.5, 0, 0, 2); place(w, "wall", 6.5, 3.02, 0, 0, 0, 0);
    expect(roofWallMaterial(w, 6, 3, 0)).toBe("twig");
  });
});

describe("ADR-402: cabin ruins get shakes from their wood walls", () => {
  it("stamped cabin / hunter_shack / fisher_hut: the roof reads the wood walls and picks shk", () => {
    for (const kind of [G.AbandonedKind.Cabin, G.AbandonedKind.HunterShack, G.AbandonedKind.FisherHut]) {
      const w = world(); const r = G.stampAbandonedSite(w, 8, 8, { kind, rot: 0, ruin: 0 }); G.drainAbandonedStamps(w);
      expect(r.skipped).toBe(false);
      const d = G.gameplayDefs(w); const t = new RoofTiler({ roofSpriteId: () => undefined }); let ve = 0;
      for (const e of r.placed) {
        const def = d.pieces.get(w.getField(e, G.BuildPiece, "type")!)!; if (!def.roof) continue; const sl = w.get(e, G.PieceSlot)!;
        const wm = roofWallMaterial(w, sl.tx, sl.ty, sl.z - 1); if (wm) expect(wm).toBe("wood");
        t.add({ ve: ++ve, x: sl.tx, y: sl.ty, level: sl.z, key: def.key, rot: w.getField(e, G.BuildPiece, "rot")! & 3, tier: w.getField(e, G.BuildPiece, "tier")!, ...(wm ? { wallMaterial: wm } : {}) });
      }
      t.flush(); expect(ve).toBeGreaterThan(0);
      for (let i = 1; i <= ve; i++) expect(t.pick(i)!.skin, `kind ${kind}`).toBe("shk");
    }
  });
});

describe("ADR-402: RoofTiler.refreshWalls", () => {
  it("re-picks a level when the wall under a roof changes material, bounded per call", () => {
    const t = new RoofTiler({ roofSpriteId: () => undefined });
    for (let x = 0; x < 3; x++) t.add({ ve: x + 1, x, y: 0, level: 1, key: "roof_slope", rot: 0, tier: 1 });
    t.flush(); const v0 = t.version.get(1)!;
    let mat: string | undefined = undefined;
    expect(t.refreshWalls(() => mat)).toBe(0); expect(t.version.get(1)).toBe(v0);
    mat = "wood";
    expect(t.refreshWalls(() => mat, 2)).toBe(2); expect(t.refreshWalls(() => mat, 2)).toBe(1);
    t.flush(); expect(t.pick(1)!.skin).toBe("shk");
  });
});
