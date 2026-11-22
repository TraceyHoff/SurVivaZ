import { describe, expect, it } from "vitest";
import { AtlasManager, COLD_ATLAS_RE, FIDELITY_ATLAS_RE, RESIDENT_CREATURE_MIN_MB, defaultAtlasTier } from "../src/assets/atlasManager.js";

/** ADR-237: animals (and characters / zombies) were blurry only on mobile: the 128 MB budget halved the whole hot tier
 *  (x0.5) and streamed pets / critters through ETC1S x0.25 slots, then a dpr-3 phone magnified them ~3.7x. */
function am(budget: number): any {
  const gl = { canvas: undefined, getParameter: () => 4096, isContextLost: () => false, getError: () => 0 } as never;
  const a = new AtlasManager(gl, { registerLoader: () => {} } as never, { textureBudgetMB: budget }) as any;
  a.atlases = []; a.coldDownscale = 1; a.downscale = 1; return a;
}
const rt = (key: string, w: number, h = w): any => ({ key, img: { width: w, height: h }, emis: null, masks: {}, scale: 1, cold: false });
/** Planner stub: bytes = sum of the packed (scaled) atlas areas at RGBA8; `last` holds the final packing. */
function planner(a: any): { last: () => Map<string, number> } {
  let last: any[] = [];
  a.pack = (l: any[]) => { last = l; };
  a.planEstimate = () => last.reduce((t, x) => t + x.img.width * x.img.height * 4, 0);
  a.estimate = a.planEstimate;
  return { last: () => new Map(last.map((x) => [x.key, x.img.width])) };
}
const MB = 1048576;
// hot scene art (terrain, decor) + the creature / character / zombie sheets drawn this session
const scene = (): any[] => [rt("tiles", 2048), rt("props", 2048), rt("animals_medium", 1008), rt("characters", 1152, 768), rt("zombies", 912), rt("animals_large_sp", 1024, 896)];
const used = ["tiles", "props", "animals_medium", "characters", "zombies"];

describe("ADR-237: creatures, characters and zombies stay crisp on the mobile budget", () => {
  it("FIDELITY_ATLAS_RE covers creature / character / zombie sheets only", () => {
    for (const k of ["animals_medium", "animals_large", "pets_dog_lab", "nature_critters_a_24x24", "characters", "characters_b", "zombies", "zombies_snuffer"]) expect(FIDELITY_ATLAS_RE.test(k)).toBe(true);
    for (const k of ["tiles", "decor", "buildings", "brand_menu_bg", "furniture", "wear_hats_a", "veh_car"]) expect(FIDELITY_ATLAS_RE.test(k)).toBe(false);
  });
  it("a halved hot tier keeps the drawn creature / character / zombie sheets at x1 when that fits", async () => {
    const a = am(128); const p = planner(a); for (const k of used) a.recentlyUsed.add(k);
    const list = scene(); const full = list.reduce((t, x) => t + x.img.width * x.img.height * 4, 0);
    a.textureBudgetMB = Math.floor((full - 0.4 * (2 * 2048 * 2048 * 4)) / MB); // terrain+decor halved frees 75% of their 32 MB
    await a.fitBudget(list, 0, 0);
    expect(a.downscale).toBe(0.5);
    const w = p.last();
    expect(w.get("tiles")).toBe(1024); expect(w.get("props")).toBe(1024); // the rest of the hot tier pays the x0.5
    expect(w.get("animals_medium")).toBe(1008); expect(w.get("characters")).toBe(1152); expect(w.get("zombies")).toBe(912);
    expect(w.get("animals_large_sp")).toBe(512); // hot but not drawn: no pin
    expect([...a.fitInfo.pinned].sort()).toEqual(["animals_medium", "characters", "zombies"]);
    a.atlases = list.map((x: any) => ({ ...x, lazy: undefined })); a.retiered.add("tiles"); a.retiered.add("props"); // halved art already had its re-tier
    expect(a.needsRetier).toBe(false); // pinned sheets at x1 never ask for another re-tier
  });
  it("when x1 sheets do not fit, the plan is exactly the old one (no extra blur elsewhere, never over budget for the pin)", async () => {
    const a = am(128); const p = planner(a); for (const k of used) a.recentlyUsed.add(k);
    const list = scene(); const half = list.reduce((t, x) => t + Math.floor(x.img.width / 2) * Math.floor(x.img.height / 2) * 4, 0);
    a.textureBudgetMB = Math.ceil(half / MB) + 1; // only everything-at-x0.5 fits
    await a.fitBudget(list, 0, 0);
    expect(a.downscale).toBe(0.5); expect(a.fitInfo.pinned).toEqual([]);
    expect(p.last().get("animals_medium")).toBe(504);
  });
  it("before anything is drawn, the 62 small resident creature sheets are not pinned (they follow via re-tier once drawn)", async () => {
    const a = am(128); planner(a);
    const list = [...scene(), rt("nature_critters_a_32x40", 480), rt("pets_dog_lab", 704, 400)];
    a.textureBudgetMB = 40; await a.fitBudget(list, 0, 0);
    expect(a.fitInfo.pinned).toContain("animals_medium"); expect(a.fitInfo.pinned).toContain("characters");
    expect(a.fitInfo.pinned).not.toContain("nature_critters_a_32x40"); expect(a.fitInfo.pinned).not.toContain("pets_dog_lab");
  });
  it("mobile keeps pets / critters resident (no ETC1S x0.25 stream slots), and never-drawn menu art is cold", () => {
    expect(RESIDENT_CREATURE_MIN_MB).toBe(128);
    expect(am(128).residentCreatures).toBe(true);
    for (const k of ["brand_menu_bg", "brand_menu_bg_sky", "brand_menu_bg_near", "brand_logo"]) { expect(COLD_ATLAS_RE.test(k)).toBe(true); expect(defaultAtlasTier(k)).toBe("cold"); }
    expect(defaultAtlasTier("animals_medium")).toBe("hot"); expect(defaultAtlasTier("characters")).toBe("hot");
  });
});
