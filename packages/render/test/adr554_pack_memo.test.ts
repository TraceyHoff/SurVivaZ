import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AtlasManager, packStats } from "../src/assets/atlasManager.js";

/**
 * ADR-554(a): fitBudget memoises pack(dims) per (h, c, pin) signature — the 4 reserve tries at
 * hot 1x and the idle-demotion loop re-pack identical dims, and the final pack repeats a trial
 * packing. The memo is keyed on the actual pack inputs (layerSize + per-atlas id/dims/side/count),
 * so the chosen (h, c, pin, pinnedKeys) — and the per-atlas placement — must be byte-identical to
 * the unmemoised run (proven by running this scenario with the memo stashed: calls, fitInfo,
 * cold keys and the final placement all matched exactly). Trial priority is untouched: no
 * reordering, so no different atlas can blur.
 *
 * Pinned numbers below are the measured values on the real merged manifests (77 resident atlases).
 *
 * ADR-573 re-pin: the call counts rose by exactly +6 in both scenarios (190→196, 170→176;
 * +3 real packings, +3 memo hits) — the new creature pin tier 5's trial packings in planFit's
 * search. The fit OUTCOME is byte-identical in both scenarios (tier 5 is tried but does not win
 * on this 77-atlas list, so the chosen scales, layers, demotions, pins and the final placement
 * are exactly the pre-ADR-573 ones); only the search trace grew.
 *
 * ADR-584 re-pin (256 MB scenario only): creature sheets are pinned at 1.0 by construction at
 * budgets >= 256 MB, so this scenario's outcome changes deliberately — the six creature sheets
 * (animals_medium/_sp, animals_large/_sp, pets_trough/_crack) join the pinned set at fitK 1,
 * funded by the cold tier stepping 0.5 -> 0.25 in this synthetic 85 MB-reserve harness (hot
 * scale, layers, frames and demotions unchanged; on the real phone plan the cold tier already
 * sat at 0.125, ADR-557 diag). Search trace: 177 calls, 118 real packings, 59 memo hits. The
 * 128 MB scenario is untouched (the guarantee is gated at >= 256 MB).
 */
const MB = 1048576;

function am(budget: number): any {
  const gl = { canvas: undefined, getParameter: () => 4096, isContextLost: () => false, getError: () => 0 } as never;
  const a = new AtlasManager(gl, { registerLoader: () => {} } as never, { textureBudgetMB: budget }) as any;
  a.atlases = []; a.coldDownscale = 1; a.downscale = 1; a.sideShift = 2; // low-mem budgets halve the side arrays
  return a;
}
/** Resident atlas list from the real merged manifests (ADR-438 harness). */
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

describe("ADR-554(a): fitBudget pack memoisation", () => {
  it("128 MB WORLD scenario: 196 pack calls run only 128 real packings; fit outcome byte-identical", async () => {
    const list = residentList(); expect(list.length).toBe(77);
    const a = am(128); for (const k of WORLD) a.recentlyUsed.add(k);
    let calls = 0; let lastPlacement = "";
    const orig = a.pack.bind(a);
    a.pack = (l: any[]) => { calls++; const r = orig(l); lastPlacement = JSON.stringify(l.map((x: any) => [x.key, x.layer, x.px, x.py, x.base])); return r; };
    const p0 = { ...packStats };
    await a.fitBudget(list, 0, 0);
    // The memo fires: a third of the trial packings are repeats of dims already packed.
    expect(calls).toBe(196);
    expect(packStats.runs - p0.runs).toBe(128);
    expect(packStats.hits - p0.hits).toBe(68);
    // The choice is unchanged: same scales, same layers, same demotions, same pins.
    expect(a.downscale).toBe(0.5);
    expect(a.coldDownscale).toBe(0.5);
    expect(a.layers).toBe(5);
    expect(a.planLayers).toBe(8);
    expect(a.totalFrames).toBe(8796);
    expect(a.fitInfo).toEqual({"reserveMB":0,"reserveWantedMB":0,"demoted":34,"pinned":["zombies","zombies_brute","zombies_runner","zombies_mummy","zombies_pumpkin","resources_tall","resources","resources_huge","zombies_snuffer","nature_trees","nature_sprouts","nature_crops","nature_saplings"],"keepMB":0,"floorMB":0});
    expect(list.filter((x: any) => x.cold).map((x: any) => x.key)).toEqual(["characters_c","critters","gt_fall_p0","gt_fall_p1","gt_fall_p2","gt_winter_p0","gt_winter_p1","gt_spring_p0","gt_spring_p1","gt_spring_p2","vfx","vfx_fire_big","vfx_fire_huge","fog","ui","se_death_bag","se_fx_deathbag_drop","se_fx_gate_breach","se_fx_puff","se_fx_respawn_poof","se_fx_splinter","adr134_hurt","crops_task256","nature_bushes","nature_ground","nature_shoal","nature_icons","nature_roads","nature_roadicons","nature_toolicons","nature_placeholder","nature_adr128","nature_adr128_fx","nature_adr128_hpbar","nature_adr128_toast","nature_adr134_hurt","nature_adr134_stumps","nature_adr134_hpbar"]);
    // And the final pack's per-atlas placement is identical too (memo-hit restore, not a re-pack).
    expect(lastPlacement).toBe("[[\"characters\",2,1028,1220,0],[\"characters_b\",2,1028,1608,288],[\"characters_c\",3,0,1480,576],[\"zombies\",1,0,0,864],[\"zombies_brute\",0,0,0,1225],[\"zombies_runner\",1,916,0,1586],[\"zombies_mummy\",2,0,0,1947],[\"zombies_pumpkin\",2,916,0,2308],[\"held\",1,1832,0,2669],[\"critters\",0,1864,1304,2789],[\"tiles\",1,1736,1220,2981],[\"gt_summer_p0\",3,1096,332,3029],[\"gt_summer_p1\",3,1028,828,3314],[\"gt_summer_p2\",4,1536,820,3599],[\"gt_fall_p0\",3,1096,1324,3749],[\"gt_fall_p1\",4,0,1288,4034],[\"gt_fall_p2\",4,1536,1612,4319],[\"gt_winter_p0\",4,512,1288,4454],[\"gt_winter_p1\",4,1536,1084,4739],[\"gt_spring_p0\",4,1024,1288,4889],[\"gt_spring_p1\",4,1536,0,5174],[\"gt_spring_p2\",4,1536,1348,5459],[\"gt_grazed\",0,1800,2016,5609],[\"gt_waterfall\",0,1800,1816,5613],[\"resources_tall\",1,1544,1772,5614],[\"resources\",1,1028,1772,5624],[\"resources_huge\",1,1832,364,5656],[\"items\",1,1832,660,5657],[\"equipment\",1,1832,776,5713],[\"buildings_twig\",3,0,836,5737],[\"buildings\",2,0,1220,5897],[\"buildings_stone\",4,0,0,6073],[\"buildings_metal\",4,0,644,6233],[\"openings\",0,0,1524,6393],[\"furniture\",3,0,0,6521],[\"decor\",1,0,1220,6729],[\"vfx\",1,1832,528,6921],[\"vfx_fire_big\",0,1800,1752,6985],[\"vfx_fire_huge\",1,484,1992,6993],[\"fog\",1,1736,1368,7001],[\"ui\",0,1948,1996,7003],[\"animals_medium\",4,1028,0,7005],[\"animals_medium_sp\",2,1608,1220,7446],[\"animals_large\",3,580,1480,7542],[\"animals_large_sp\",2,1608,1516,7766],[\"se_death_bag\",0,1800,1788,7814],[\"se_fx_deathbag_drop\",1,744,1992,7822],[\"se_fx_gate_breach\",3,0,1868,7830],[\"se_fx_puff\",0,1996,1752,7846],[\"se_fx_respawn_poof\",1,0,1992,7850],[\"se_fx_splinter\",0,1976,2036,7860],[\"zombies_snuffer\",0,1220,0,7864],[\"defenses\",0,1028,1524,8136],[\"defenses_glow\",2,1608,1368,8232],[\"adr134_hurt\",4,1536,496,8256],[\"crops_task256\",1,1736,1500,8257],[\"nature_trees\",0,1220,1028,8289],[\"nature_bushes\",0,1800,1692,8305],[\"nature_sprouts\",0,1220,1304,8321],[\"nature_crops\",1,1028,1220,8385],[\"nature_saplings\",1,1028,1672,8497],[\"nature_ground\",0,1976,2016,8529],[\"nature_shoal\",0,1948,1924,8530],[\"nature_icons\",1,1736,1632,8534],[\"nature_roads\",2,0,1928,8662],[\"nature_roadicons\",0,1800,1996,8710],[\"nature_toolicons\",0,1932,1816,8719],[\"nature_placeholder\",1,1832,828,8726],[\"nature_adr128\",2,260,1996,8731],[\"nature_adr128_fx\",0,1940,2016,8763],[\"nature_adr128_hpbar\",0,2028,1028,8775],[\"nature_adr128_toast\",0,1984,1996,8776],[\"nature_adr134_hurt\",3,1096,0,8777],[\"nature_adr134_stumps\",0,1948,1888,8778],[\"nature_adr134_hpbar\",0,2028,1040,8790],[\"pets_trough\",0,1932,1944,8791],[\"pets_trough_crack\",0,1948,1836,8793]]");
  });

  it("256 MB KEEP scenario: 177 pack calls run only 118 real packings; fit outcome byte-identical apart from the ADR-584 creature guarantee", async () => {
    const list = residentList(); expect(list.length).toBe(77);
    const a = am(256); for (const k of WORLD) a.recentlyUsed.add(k);
    let calls = 0;
    const orig = a.pack.bind(a);
    a.pack = (l: any[]) => { calls++; return orig(l); };
    const p0 = { ...packStats };
    await a.fitBudget(list, 85 * MB, 85 * MB, 85 * MB);
    expect(calls).toBe(177);
    expect(packStats.runs - p0.runs).toBe(118);
    expect(packStats.hits - p0.hits).toBe(59);
    expect(a.downscale).toBe(0.5);
    expect(a.coldDownscale).toBe(0.25); // ADR-584: funds the creature guarantee in this harness
    expect(a.layers).toBe(7);
    expect(a.planLayers).toBe(11);
    expect(a.totalFrames).toBe(8796);
    expect(a.fitInfo).toEqual({"reserveMB":85,"reserveWantedMB":85,"demoted":34,"pinned":["zombies","zombies_brute","zombies_runner","zombies_mummy","zombies_pumpkin","resources_tall","resources","resources_huge","buildings_twig","openings","furniture","decor","zombies_snuffer","nature_trees","nature_sprouts","nature_crops","nature_saplings","animals_medium","animals_medium_sp","animals_large","animals_large_sp","pets_trough","pets_trough_crack"],"keepMB":85,"floorMB":85});
  });
});
