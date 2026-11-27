import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AtlasManager, CREATURE_PIN_RE, RESIDENT_CREATURE_RE, RESIDENT_GROUND_RE, RESIDENT_PLANT_RE, RETIRED_BUILD_RE } from "../src/assets/atlasManager.js";

/**
 * ADR-573: every creature sheet (animals_* x4, pets_* x15, nature_critters_* x61) booted at x0.5 on the
 * 256 MB phone plan and stayed there forever. Measured root cause (measure-animals.md): mechanism A from
 * the prep is REFUTED at this budget — animals_* are resident by default (no residency field), pets/critters
 * are already rescued from streaming by atlasPoolSets at >= 128 MB, and the pig is on
 * nature_critters_c_40x32, not an animals_* sheet. The only mechanism is the boot pin: planFit's tier 2
 * (vis + core + base + all fidelity, 107 pins) is judged on the SHELF estimate and misses the 171 MB
 * resident allowance (256 - 85 reserve) by 117 MB, so tier 4 (base + core, 20 pins, judged PACKED) won at
 * 6 layers / hot x0.5 and all 80 creature sheets sat at the hot scale; the re-tier rebuild re-ran the same
 * plan, landed tier 4 again, recorded x0.5 in retierScale and closed retierOpen behind itself.
 *
 * Fix: pin tier 5 = core + base + creatures, judged on the PACKED yardstick like tiers 3/4 (ADR-438
 * precedent), tried after tier 1 and before tier 4 in both tier ladders. It must win at the FULL reserve
 * (allowance 171 MB) or not at all: no reserve, pool-share or existing-tier changes (user ruling R2).
 */
const MB = 1048576;
/** trimmed heights measured by trimGridAtlas on the shipped sheets (width unchanged) — the ADR-512 harness values */
const TRIMMED_H: Record<string, number> = { buildings_twig: 896, openings: 640, furniture: 1152, decor: 1024, defenses: 384, defenses_glow: 192, cz_mirror: 384, decor_log_store: 256, decor_stick_store: 256, decor_crop_store: 256 };
function am(budget: number): any {
  const gl = { canvas: undefined, getParameter: () => 4096, isContextLost: () => false, getError: () => 0 } as never;
  const a = new AtlasManager(gl, { registerLoader: () => {} } as never, { textureBudgetMB: budget }) as any;
  a.atlases = []; a.coldDownscale = 1; a.downscale = 1; a.sideShift = 2;
  return a;
}
/** Runtime-true resident list: the real merged manifests, retired sheets excluded, trim heights applied, and
 *  the stream sheets atlasPoolSets rescues at >= 128 MB (pets / critters / gt_ / plants) included resident —
 *  this is what rebuild() actually loads resident on the phone. */
function residentList(): any[] {
  const atl = new Map<string, any>();
  for (const p of ["../../assets/pack/manifest.json", "../../assets/pack/nature/manifest.nature.json", "../../../assets/manifest.json"]) {
    const m = JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
    for (const a of m.atlases) if (!atl.has(a.key)) atl.set(a.key, a);
  }
  const rescued = (k: string) => RESIDENT_CREATURE_RE.test(k) || RESIDENT_GROUND_RE.test(k) || RESIDENT_PLANT_RE.test(k);
  const resident = [...atl.values()].filter((a) => (a.residency !== "stream" || rescued(a.key)) && !RETIRED_BUILD_RE.test(a.key));
  return resident.map((a, i) => ({
    key: a.key, id: i, img: { width: a.columns * a.frameW, height: TRIMMED_H[a.key] ?? a.rows * a.frameH }, emis: a.masks?.emissive ? {} : null,
    masks: { ...(a.masks?.sway ? { sway: {} } : {}), ...(a.masks?.sheen ? { sheen: {} } : {}), ...(a.masks?.tintmask ? { tintmask: {} } : {}) },
    scale: 1, cold: false, count: a.columns * a.rows,
  }));
}
/** The 20 keys the pre-fix tier-4 plan pinned at 1.0 on this list (measure-animals.md §2). */
const BASELINE_PINNED = ["buildings_twig", "decor", "defenses", "defenses_glow", "furniture", "openings", "nature_crops", "nature_saplings", "nature_sprouts", "nature_trees", "resources", "resources_huge", "resources_tall", "zombies", "zombies_brute", "zombies_mummy", "zombies_pumpkin", "zombies_runner", "zombies_snuffer", "pets_trough"];

describe("ADR-573: creature pin tier", () => {
  it("CREATURE_PIN_RE covers the animal / pet / critter sheets and nothing else", () => {
    for (const k of ["animals_large", "animals_medium_sp", "pets_dog_lab", "pets_trough_crack", "nature_critters_c_40x32"]) expect(CREATURE_PIN_RE.test(k), k).toBe(true);
    for (const k of ["zombies", "characters", "resources", "nature_trees", "critters", "nature_mounts_horse_0", "v2_body"]) expect(CREATURE_PIN_RE.test(k), k).toBe(false);
  });

  it("at 256 MB with the full 85 MB reserve, every creature sheet is planned at 1.0 and nobody else pays", async () => {
    const list = residentList();
    const creatures = list.filter((x: any) => CREATURE_PIN_RE.test(x.key));
    expect(creatures.length).toBe(80); // animals_* x4 + pets_* x15 + nature_critters_* x61 in the resident list
    const a = am(256); const KEEP = 85 * MB;
    await a.fitBudget(list, KEEP, KEEP, KEEP);
    // (a) every creature atlas in the resident list at full res
    for (const x of creatures) expect(x.fitK, `${x.key} fitK`).toBe(1);
    // (b) the 20 baseline tier-4 pins are still at 1.0
    for (const k of BASELINE_PINNED) {
      const x = list.find((y: any) => y.key === k)!;
      expect(x.fitK, `${k} fitK`).toBe(1); expect(a.pinnedKeys.has(k), `${k} pinned`).toBe(true);
    }
    // the winning pin set is exactly baseline + creatures: nothing else was promoted to pay for them
    expect([...a.pinnedKeys].sort()).toEqual([...BASELINE_PINNED, ...creatures.map((x: any) => x.key).filter((k: string) => !BASELINE_PINNED.includes(k))].sort());
    // (c) the winning plan fits the resident allowance at the FULL reserve, in at most one extra layer
    expect(a.fitInfo.reserveMB).toBe(85);
    expect(a.residentBytes(list)).toBeLessThanOrEqual(171 * MB);
    expect(a.layers).toBeLessThanOrEqual(7);
    // (d) the hot scale is unchanged and the cold scale did not drop to fund the pin
    expect(a.downscale).toBe(0.5);
    expect(a.coldDownscale).toBe(0.5);
    for (const x of list) if (!CREATURE_PIN_RE.test(x.key) && !BASELINE_PINNED.includes(x.key)) expect(x.fitK, `${x.key} fitK`).toBeLessThanOrEqual(0.5);
  });
});
