import { describe, expect, it } from "vitest";
import { Transform, Weather } from "@engine/core";
import { addItem, animalDefs, clutterForChunk, CLUTTER_KEYS, Crop, cropGrowthSystem, FARMING, gameplayDefs, IntentAction, plant, ResourceNode, scaleAnimalCaps, setIntent, spawnPlayer, spawnResourceNode, till, water, fertilize, growthMul, CROP_EVERY, countItem, WeatherKind } from "../src/index.js";
import { toSpawnEntries } from "../src/ai/population.js";
import { makeWorld, steps } from "./helpers.js";

describe("ADR-110 wildlife, farming, flora, clutter", () => {
  it("content: 21 animals with yields, every plantable seed/sapling exists and is only gathered (never crafted)", () => {
    const w = makeWorld(); const d = gameplayDefs(w);
    expect(animalDefs().length).toBe(40); // 21 + 11 ADR-145 pet species + 5 Task 32 kinds + 3 ADR-319 mounts (horse, donkey, yak)
    for (const a of animalDefs()) expect(a.loot.length).toBeGreaterThan(0);
    const crafted = new Set([...d.recipes.values()].map((r) => r.output.item));
    for (const p of FARMING.plantables) {
      const id = d.itemId(p.seed); expect(id).toBeGreaterThan(0); expect(crafted.has(id)).toBe(false);
      expect(d.resourceId(p.becomes)).toBeGreaterThan(0);
      expect([...d.resources.values()].some((r) => r.yields.some((y) => y.item === id))).toBe(true);
    }
    expect(d.resources.get(d.resourceId("crop_wheat"))!.oneShot).toBe(true);
  });
  it("till -> plant -> water/fertilize -> grows through stages -> mature oneShot node; harvest removes it", () => {
    const w = makeWorld(); const p = spawnPlayer(w, { x: 10.5, y: 10.5 });
    expect(plant(w, p, "wheat_seeds", 11.5, 10.5)).toBe(6); // no hoe (NeedsHoe); with a hoe it is NeedsSoil (4) — needs soil
    expect(till(w, p, 11.5, 10.5)).toBe(0); expect(till(w, p, 11.5, 10.5)).toBe(3);
    expect(plant(w, p, "wheat_seeds", 11.5, 10.5)).toBe(0);
    const crop = [...w.query([Crop])][0]!; expect(w.get(crop, Crop)!.kind).toBeGreaterThan(0);
    w.env(Weather).kind = WeatherKind.Clear; expect(growthMul(w, w.get(crop, Crop)!)).toBe(0); // ADR-286: a dry plant does not grow
    water(w, 11.5, 10.5); const wet = growthMul(w, w.get(crop, Crop)!); expect(wet).toBeGreaterThan(0); expect(fertilize(w, 11.5, 10.5)).toBe(true);
    expect(growthMul(w, w.get(crop, Crop)!)).toBeCloseTo(wet * FARMING.fertilizerMul);
    const grow = FARMING.plantables.find((x) => x.seed === "wheat_seeds")!.growSeconds;
    const stages = new Set<number>();
    for (let i = 0; i < grow && w.isAlive(crop); i++) { cropGrowthSystem(w); if (w.isAlive(crop)) stages.add(w.get(crop, Crop)!.stage); }
    expect(w.isAlive(crop)).toBe(false); expect(stages.size).toBe(4);
    const node = [...w.query([ResourceNode])].find((n) => w.get(n, ResourceNode)!.kind === gameplayDefs(w).resourceId("crop_wheat"));
    expect(node).toBeDefined(); expect(w.get(node!, Transform)!.x).toBe(11.5);
  });
  it("Use with a sapling plants a tree spot in front of the player and consumes it", () => {
    const w = makeWorld(); const d = gameplayDefs(w); const p = spawnPlayer(w, { x: 5.5, y: 5.5 });
    addItem(w, p, d.itemId("apple_sapling"), 2);
    setIntent(w, p, { action: IntentAction.Use, slot: 0 }); steps(w, 1);
    expect(countItem(w, p, d.itemId("apple_sapling"))).toBe(1);
    expect([...w.query([Crop])].length).toBe(1);
  });
  it("oneShot nodes vanish on depletion; gathering wild plants can yield seeds", () => {
    const w = makeWorld(); const d = gameplayDefs(w);
    const n = spawnResourceNode(w, "crop_carrot", 3, 3); const p = spawnPlayer(w, { x: 3.5, y: 3 });
    setIntent(w, p, { action: IntentAction.Gather, target: n }); steps(w, 40);
    expect(w.isAlive(n)).toBe(false); expect(countItem(w, p, d.itemId("carrot"))).toBeGreaterThan(0);
  });
  it("clutter is deterministic, biome-based and density-scaled", () => {
    const tile = (x: number, y: number) => ((x >> 3) + (y >> 3)) % 4 + 2;
    const a = clutterForChunk(7, 1, 2, 32, tile), b = clutterForChunk(7, 1, 2, 32, tile);
    expect(a).toEqual(b); expect(a.length).toBeGreaterThan(20);
    expect(clutterForChunk(7, 1, 2, 32, tile, 0.35).length).toBeLessThan(a.length * 0.6);
    expect(clutterForChunk(7, 1, 2, 32, () => 1)).toEqual([]);
    for (const c of a) expect(CLUTTER_KEYS).toContain(c.key);
  });
  it("animal caps scale for mobile / lowend", () => {
    const e = toSpawnEntries("sp"); const s = scaleAnimalCaps(e, 0.4);
    const bear = (l: typeof e) => l.find((x) => x.kind === "animal_bear")!;
    expect(bear(s).perChunkCap).toBeGreaterThanOrEqual(1);
    const sum = (l: typeof e) => l.filter((x) => x.category === "animal").reduce((a, x) => a + x.globalCap, 0);
    expect(sum(s)).toBeLessThan(sum(e) * 0.6);
    expect(s.filter((x) => x.category === "zombie")).toEqual(e.filter((x) => x.category === "zombie"));
    expect(CROP_EVERY).toBeGreaterThan(0);
  });
});
