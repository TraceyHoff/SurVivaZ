import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as AM from "../src/assets/atlasManager.js";
import { AtlasManager, atlasPoolSets, FIDELITY_ATLAS_RE, VISIBLE_PIN_RE } from "../src/assets/atlasManager.js";

/**
 * ADR-438: plants, zombies and berry bushes are blurry on the phone / console budgets.
 *
 * Root cause (measured, not guessed): on the 128 MB mobile budget (and the 256 MB console
 * budget) fitBudget halves the whole hot tier (downscale 0.5) and the pin that should keep
 * visible art at 1x drops ENTIRELY — pin=2 (FIDELITY + VISIBLE_PIN at 1x) and pin=1
 * (VISIBLE_PIN only) both fail the shelf planner, so pinned=[] and every hot atlas is
 * stored at 0.5x, then magnified ~2-4x on a DPR phone through LINEAR magnification:
 *  - berry bushes live on `resources` (64px frames -> 32px), trees/plants on `nature_trees`
 *    (96px -> 48px) and `resources_tall`: none of them is in FIDELITY_ATLAS_RE or
 *    VISIBLE_PIN_RE, so no code path ever stores them at 1x on a halved hot tier.
 *  - zombies ARE in FIDELITY_ATLAS_RE, but the pin is all-or-nothing: when the full pin
 *    set does not fit, zombies halve with everything else (and the re-tier can never
 *    rescue them: retier records the 0.5x scale and never re-asks).
 *  - wild / farmed crops live on `nature_crops`, residency "stream": the stream pool on
 *    a 128 MB budget holds 4 slots (its floor) for 131 stream pages, so the crop page is
 *    usually evicted and the plant draws the soft `placeholder_sprout` blob instead.
 *
 * Fix (same file, AtlasManager):
 *  - CORE_PIN_RE: the small always-visible world atlases (resources, nature_trees,
 *    nature_crops/sprouts/saplings, zombies) get a third pin tier, tried after pin=2
 *    and pin=1 fail, judged on the PACKED (MaxRects) layer count instead of the shelf
 *    estimate: the core set packs into 5 real layers (120 MB <= 128 MB) while the
 *    shelf planner charges 7 (168 MB). The shelf margin is planning headroom; the
 *    core tier spends it on the sprites the player actually looks at, and the real
 *    GPU total stays inside the budget (the upload OOM retry still halves on a real
 *    driver refusal).
 *  - RESIDENT_PLANT_RE: the small plant sheets (nature_crops/sprouts/saplings) load
 *    resident on >= 128 MB budgets (the ADR-156/246 creature/ground precedent), so
 *    crops never draw the placeholder sprout; the core pin then keeps them at 1x.
 */
const CORE_PIN_RE = (AM as unknown as { CORE_PIN_RE?: RegExp }).CORE_PIN_RE;
const RESIDENT_PLANT_RE = (AM as unknown as { RESIDENT_PLANT_RE?: RegExp }).RESIDENT_PLANT_RE;
const MB = 1048576;

function am(budget: number): any {
  const gl = { canvas: undefined, getParameter: () => 4096, isContextLost: () => false, getError: () => 0 } as never;
  const a = new AtlasManager(gl, { registerLoader: () => {} } as never, { textureBudgetMB: budget }) as any;
  a.atlases = []; a.coldDownscale = 1; a.downscale = 1; a.sideShift = 2; // low-mem budgets halve the side arrays
  return a;
}
/** Resident atlas list from the real merged manifests (74 resident + the 3 plant sheets ADR-438 makes resident). */
function residentList(): any[] {
  const atl = new Map<string, any>();
  for (const p of ["../../assets/pack/manifest.json", "../../assets/pack/nature/manifest.nature.json", "../../../assets/manifest.json"]) {
    const m = JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
    for (const a of m.atlases) if (!atl.has(a.key)) atl.set(a.key, a);
  }
  const resident = [...atl.values()].filter((a) => a.residency !== "stream" || /^nature_(crops|sprouts|saplings)$/.test(a.key));
  return resident.map((a, i) => ({ key: a.key, id: i, img: { width: a.columns * a.frameW, height: a.rows * a.frameH }, emis: a.masks?.emissive ? {} : null, masks: a.masks?.sway ? { sway: {} } : {}, scale: 1, cold: false, count: a.columns * a.rows }));
}
/** Atlases drawn in a played session (the camera sits on all of them). */
const WORLD = ["tiles", "decor", "resources", "resources_tall", "resources_huge", "nature_trees", "nature_crops", "nature_sprouts", "nature_saplings", "characters", "characters_b", "zombies", "zombies_brute", "zombies_runner", "zombies_mummy", "zombies_pumpkin", "animals_medium", "buildings", "furniture", "openings", "items", "equipment", "held"];
/** The atlases ADR-438 keeps crisp: berry bushes, trees/plants, zombies. */
const CORE_KEYS = ["resources", "resources_tall", "resources_huge", "nature_trees", "nature_crops", "nature_sprouts", "nature_saplings", "zombies", "zombies_brute", "zombies_runner", "zombies_mummy", "zombies_pumpkin", "zombies_snuffer"];
/** Effective stored scale of one atlas after fitBudget (1 = pinned full res). */
function effScale(a: any, list: any[], key: string): number {
  const it = list.find((x: any) => x.key === key)!;
  if (it.cold) return a.coldDownscale;
  if ((a.pinnedKeys as Set<string>).has(key)) return 1;
  return a.downscale;
}

describe("ADR-438: blurry plants, zombies and berry bushes", () => {
  it("CORE_PIN_RE covers the small always-visible world atlases (and nothing else in the pin set)", () => {
    expect(CORE_PIN_RE, "CORE_PIN_RE exported").toBeDefined();
    for (const k of CORE_KEYS) expect(CORE_PIN_RE!.test(k), k).toBe(true);
    for (const k of ["tiles", "decor", "characters", "buildings", "furniture", "ui", "nature_mounts_horse_0", "wear_hats_a"]) expect(CORE_PIN_RE!.test(k), k).toBe(false);
    // the old pin sets never covered the plant / bush atlases: that is the bug this tier closes
    for (const k of ["resources", "resources_tall", "resources_huge", "nature_trees", "nature_crops"]) {
      expect(FIDELITY_ATLAS_RE.test(k), `${k} in FIDELITY`).toBe(false);
      expect(VISIBLE_PIN_RE.test(k), `${k} in VISIBLE_PIN`).toBe(false);
    }
  });
  it("RESIDENT_PLANT_RE covers the small streamed plant sheets only", () => {
    expect(RESIDENT_PLANT_RE, "RESIDENT_PLANT_RE exported").toBeDefined();
    for (const k of ["nature_crops", "nature_sprouts", "nature_saplings"]) expect(RESIDENT_PLANT_RE!.test(k), k).toBe(true);
    for (const k of ["nature_trees", "nature_mounts_horse_0", "nature_critters_a_24x24", "pets_dog_lab"]) expect(RESIDENT_PLANT_RE!.test(k), k).toBe(false);
  });

  it("at the 128 MB phone budget the core atlases stay at 1x while the hot tier halves (packed 120 MB <= 128 MB)", async () => {
    const list = residentList(); expect(list.length).toBe(77);
    const a = am(128); for (const k of WORLD) a.recentlyUsed.add(k);
    await a.fitBudget(list, 0, 0);
    expect(a.downscale).toBe(0.5); // the hot tier still halves: the pin is paid for, not free
    for (const k of CORE_KEYS) expect(effScale(a, list, k), `${k} stored scale`).toBe(1);
    expect([...a.fitInfo.pinned].sort()).toEqual([...CORE_KEYS].sort());
    // the real GPU cost of the winning plan stays inside the budget (packed layers, not the shelf estimate)
    expect((a.layers * a.layerBytes(list)) / MB).toBeLessThanOrEqual(128);
    // the rest of the hot tier still pays the 0.5x (tiles / decor were halved before too: no new blur elsewhere)
    expect(effScale(a, list, "tiles")).toBe(0.5);
    expect(effScale(a, list, "decor")).toBe(0.5);
    // characters keep their ADR-237 pin whenever the full pin set fits; they are not demoted by the core tier
    expect(effScale(a, list, "characters")).toBeGreaterThanOrEqual(0.5);
  });

  it("at the 256 MB console budget the core atlases stay at 1x too", async () => {
    const list = residentList();
    const a = am(256); for (const k of WORLD) a.recentlyUsed.add(k);
    await a.fitBudget(list, 0, 0);
    for (const k of CORE_KEYS) expect(effScale(a, list, k), `${k} stored scale`).toBe(1);
    for (const k of CORE_KEYS) expect(a.fitInfo.pinned, `pinned contains ${k}`).toContain(k);
    expect((a.layers * a.layerBytes(list)) / MB).toBeLessThanOrEqual(256);
  });

  it("unseen core atlases are never demoted to cold: a bush/tree/zombie the player walks up to is crisp on first sight", async () => {
    const list = residentList();
    const a = am(128);
    for (const k of ["tiles", "decor", "characters"]) a.recentlyUsed.add(k); // no bush, tree or zombie drawn yet
    await a.fitBudget(list, 0, 0);
    for (const k of CORE_KEYS) {
      expect(list.find((x: any) => x.key === k)!.cold, `${k} not cold`).toBe(false);
      expect(effScale(a, list, k), `${k} stored scale`).toBe(1);
    }
  });

  it("at a 768 MB desktop budget nothing halves (control: the fix changes nothing where the budget fits)", async () => {
    const list = residentList();
    const a = am(768); for (const k of WORLD) a.recentlyUsed.add(k);
    await a.fitBudget(list, 0, 0);
    expect(a.downscale).toBe(1);
    for (const k of CORE_KEYS) expect(effScale(a, list, k), `${k} stored scale`).toBe(1);
  });

  it("atlasPoolSets loads the plant sheets resident on >= 128 MB budgets (no stream placeholder for crops)", () => {
    const atlases = new Map<string, any>([
      ["nature_crops", { key: "nature_crops", residency: "stream" }],
      ["nature_sprouts", { key: "nature_sprouts", residency: "stream" }],
      ["nature_mounts_horse_0", { key: "nature_mounts_horse_0", residency: "stream" }],
      ["pets_dog_lab", { key: "pets_dog_lab", residency: "stream" }],
      ["gt_summer_p0", { key: "gt_summer_p0", residency: "stream" }],
    ]);
    const registry = { atlases, allSprites: () => [], cosmetics: undefined } as never;
    const sources = new Map([...atlases.keys()].map((k) => [k, { url: `atlases/${k}.png` }]));
    const flags = { streamWearables: true, streamVehicles: true, streamBuildingTiers: true, streamSheets: true, residentCreatures: true, ktx2: false };
    const p = atlasPoolSets(registry, sources, flags);
    expect(p.streamKeys.has("nature_crops"), "crops resident").toBe(false);
    expect(p.streamKeys.has("nature_sprouts"), "sprouts resident").toBe(false);
    expect(p.streamKeys.has("nature_mounts_horse_0"), "mounts still stream").toBe(true);
    expect(p.streamKeys.has("pets_dog_lab"), "pets stay resident via creatures").toBe(false);
    expect(p.streamKeys.has("gt_summer_p0"), "ground stays resident via ground rule").toBe(false);
    // below the 128 MB resident-creatures budget the plant sheets keep streaming (old behaviour, no crash)
    const pLow = atlasPoolSets(registry, sources, { ...flags, residentCreatures: false });
    expect(pLow.streamKeys.has("nature_crops"), "crops stream below 128 MB").toBe(true);
  });
});
