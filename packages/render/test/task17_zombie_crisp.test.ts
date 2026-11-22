// Task 17, Problem B: zombie atlases must stay crisp like animals / pets / critters.
// Defects fixed in atlasManager.ts:
//  (1) zombie variants defaulted to the cold tier (COLD_ATLAS_RE matched them);
//  (2) zombies were eligible for fitBudget idle demotion (not in CRISP_ATLAS_RE);
//  (3) an atlas demoted AFTER its one re-tier never re-triggered (retiered was a
//      one-shot set), so it stayed blurry for the session despite being drawn.
import { describe, expect, it } from "vitest";
import { AtlasManager, COLD_ATLAS_RE, CRISP_ATLAS_RE, defaultAtlasTier, FIDELITY_ATLAS_RE } from "../src/assets/atlasManager.js";

const rt = (key: string, w: number): any => ({ key, img: { width: w, height: w }, emis: null, masks: {}, scale: 1, cold: false });
// Planner stub mirroring adr237_mobile_crisp_creatures: pack records the placed
// (scaled) list; planEstimate sums its 4-byte pages.
const am = (budgetMB: number): any => {
  const gl = { canvas: undefined, getParameter: () => 4096, isContextLost: () => false, getError: () => 0 } as never;
  const a = new AtlasManager(gl, { registerLoader: () => {} } as never, { textureBudgetMB: budgetMB }) as any;
  let last: any[] = [];
  a.pack = (l: any[]) => { last = l; };
  a.packedWidths = () => last.map((x) => x.img.width);
  a.planEstimate = () => last.reduce((t, x) => t + x.img.width * x.img.height * 4, 0);
  a.estimate = a.planEstimate;
  return a;
};
const any = (a: any) => a as any;

describe("Task 17: zombie art crisp", () => {
  it("zombie family is fidelity-pinned and idle-demotion-excluded, like animals/pets/critters", () => {
    for (const k of ["zombies", "zombies_brute", "zombies_runner", "zombies_mummy", "zombies_pumpkin", "zombies_snuffer"]) {
      expect(FIDELITY_ATLAS_RE.test(k)).toBe(true);
      expect(CRISP_ATLAS_RE.test(k)).toBe(true);
    }
    for (const k of ["animals_medium", "pets_dog", "nature_critters_a"]) expect(CRISP_ATLAS_RE.test(k)).toBe(true);
    expect(CRISP_ATLAS_RE.test("tiles")).toBe(false); // non-creature art still demotable
  });
  it("zombie variants default to the hot tier (were cold); unrelated cold kinds stay cold", () => {
    for (const k of ["zombies", "zombies_brute", "zombies_runner", "zombies_mummy", "zombies_pumpkin", "zombies_snuffer"])
      expect(defaultAtlasTier(k)).toBe("hot");
    expect(defaultAtlasTier("brand_menu_bg")).toBe("cold");
    expect(COLD_ATLAS_RE.test("zombies_brute")).toBe(false);
  });
  it("fitBudget idle demotion skips an undrawn zombie atlas and demotes a generic atlas instead", async () => {
    const a = am(21); // 1x total 23.3 MB; demoting props (generic art; ADR-512 pins decor) to cold (0.5) leaves 20.3 MB
    const tiles = rt("tiles", 2048), zombies = rt("zombies", 912), decor = rt("props", 1024);
    const list = [tiles, zombies, decor];
    (a as any).recentlyUsed = new Set(["tiles"]); // tiles drawn; zombies present but not drawn this frame
    await a.fitBudget(list, 0, 0);
    expect(a.fitInfo.demoted).toBe(1);
    expect(decor.cold).toBe(true); // generic art demoted to cold
    expect(zombies.cold).toBe(false); // zombie art NOT demoted
    expect(a.packedWidths()).toEqual([2048, 912, 512]); // zombie packed at 1x, decor at cold 0.5
  });
  it("retier recovery: a demotion below the re-tier scale re-opens the re-tier; same scale does not", () => {
    const a = am(128); a.coldDownscale = 0.5; a.downscale = 0.5;
    const z = rt("zombies", 912); z.cold = true; a.atlases = [z];
    any(a).recentlyUsed = new Set(["zombies"]);
    // old one-shot behaviour preserved when no re-tier scale was recorded
    any(a).retiered = new Set(["zombies"]);
    expect(a.needsRetier).toBe(false);
    // re-tiered at 1x (pinned), then demoted to cold 0.5 -> re-tier opens again
    any(a).retierScale.set("zombies", 1);
    expect(a.needsRetier).toBe(true);
    // re-tiered at 0.5 and still at 0.5 -> no oscillation (budget cannot hold it at 1x)
    any(a).retierScale.set("zombies", 0.5);
    expect(a.needsRetier).toBe(false);
  });
  it("retier() records the POST-rebuild scale, so a later demotion re-opens the re-tier", async () => {
    const a = am(128); a.coldDownscale = 0.5; a.downscale = 1;
    const z = rt("zombies", 912); z.cold = true; a.atlases = [z];
    any(a).recentlyUsed = new Set(["zombies"]);
    any(a).registry = {};
    // stub rebuild: the re-tier lifts the atlas to the pinned 1x tier, as a real
    // rebuild does when the budget allows (fitBudget pins recentlyUsed fidelity art)
    any(a).rebuild = async () => { z.cold = false; a.pinnedKeys = new Set(["zombies"]); };
    expect(await a.retier(0)).toBe(false); // confirm 1/3
    expect(await a.retier(0)).toBe(false); // confirm 2/3
    expect(await a.retier(0)).toBe(true); // confirm 3/3 -> rebuild
    expect(any(a).retierScale.get("zombies")).toBe(1);
    // still pinned -> no re-tier; demoted to cold 0.5 -> re-tier opens again
    expect(a.needsRetier).toBe(false);
    z.cold = true; expect(a.needsRetier).toBe(true);
  });
});
