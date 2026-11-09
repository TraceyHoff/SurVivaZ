import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ADR-112/113: decor building sprites (building pack, decor_* pages) and the skill / animal_feed icons (items pack).
const dir = fileURLToPath(new URL("../pack/", import.meta.url));
const data = fileURLToPath(new URL("../../gameplay/data/", import.meta.url));
const read = (f: string) => JSON.parse(readFileSync(f, "utf8"));
type Sprite = { key: string; atlas: string; category: string; building?: { piece: string; footprint: { w: number; h: number }; layer: number; frames: number[][] } };
type Atlas = { key: string; image: string; masks?: Record<string, string>; ktx2?: string; pages?: { scale: number; image: string }[] };
const bld = read(dir + "building/manifest.building.json") as { atlases: Atlas[]; sprites: Sprite[] };
const items = read(dir + "items/manifest.items.json") as { atlases: Atlas[]; sprites: Sprite[] };
const pieces = (read(data + "pieces.json").pieces as { key: string; footprint?: { w: number; h: number }; layer: number; variantNames?: string[]; $decor?: boolean }[]).filter((p) => p.$decor);
const skills = read(data + "skills.json") as { branches: unknown; nodes: unknown };

describe("ADR-112/113 decor sprites", () => {
  const byKey = new Map(bld.sprites.map((s) => [s.key, s]));
  const drawn = pieces.filter((p) => byKey.has(`dec_${p.key}`));
  it("feeding_trough and the common furniture are drawn", () => { for (const k of ["feeding_trough", "chair_rustic", "bed_double_luxury", "table_dining_fine", "bookcase_rustic", "wardrobe_luxury", "chandelier"]) expect(drawn.map((p) => p.key)).toContain(k); });
  it("kitchen pieces and decorations are drawn", () => { for (const k of ["counter_rustic", "kitchen_sink", "cook_range", "clay_oven", "statue", "statue_large", "vase", "trophy_mount", "clan_flag", "curtains", "clock_wall", "mirror_standing", "pottery", "books", "basket"]) expect(drawn.map((p) => p.key)).toContain(k); });
  it("plants, wall hangings and rugs are drawn", () => { for (const k of ["plant_floor", "fern", "cactus", "flowers_pot", "hanging_plant", "bonsai", "herb_planter", "window_planter", "painting_wall", "poster", "tapestry", "weapon_rack", "wall_shelf", "shield_mount", "map_board", "rug_1x1", "rug_2x1", "rug_2x2", "rug_3x2", "rug_round", "rug_runner"]) expect(drawn.map((p) => p.key)).toContain(k); });
  it("outdoor decor is drawn", () => { for (const k of ["fence_picket", "fence_rail", "fence_iron", "garden_gate", "bench_park", "planter_box", "garden_bed", "fountain", "well", "scarecrow", "path_stone", "stepping_stone", "hedge", "flower_bed", "birdbath", "sundial"]) expect(drawn.map((p) => p.key)).toContain(k); });
  it("every drawn decor piece has a sprite per variant matching footprint and layer", () => {
    for (const p of drawn) {
      const fp = p.footprint ?? { w: 1, h: 1 };
      for (const v of p.variantNames ?? []) {
        const s = byKey.get(`dec_${p.key}__${v}`);
        expect(s, `${p.key}@${v}`).toBeDefined();
        expect(s!.building!.piece).toBe(`${p.key}@${v}`);
        expect(s!.building!.footprint).toEqual(fp);
        expect(s!.building!.layer).toBe(p.layer);
        expect(s!.building!.frames.length === 1 || s!.building!.frames.length === 4).toBe(true);
      }
    }
  });
  it("decor pages ship 1x+@2x PNG/KTX2 and a tintmask", () => {
    const pages = bld.atlases.filter((a) => a.key.startsWith("decor_"));
    expect(pages.length).toBeGreaterThan(0);
    for (const a of pages) {
      for (const f of [a.image, a.ktx2!, a.masks!.tintmask!, a.pages![0]!.image]) expect(existsSync(dir + "building/" + f), f).toBe(true);
      expect(existsSync(dir + "building/" + a.masks!.tintmask!.replace(".png", "@2x.png"))).toBe(true);
    }
  });
});

describe("ADR-113 icons", () => {
  const keys = new Set(items.sprites.map((s) => s.key));
  it("every skill branch and node icon exists", () => {
    const icons = [...JSON.stringify(skills).matchAll(/"icon":\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(icons.length).toBe(159); // ADR-132: +perks branch, +7 category tabs; ADR-221: +13 unlock nodes (reused icons); ADR-319/320: +5 (Horsemanship + 4 Saddlery, reused icons)
    expect(icons.filter((k) => !keys.has(k))).toEqual([]);
  });
  it("animal_feed icon exists", () => expect(keys.has("animal_feed")).toBe(true));
});
