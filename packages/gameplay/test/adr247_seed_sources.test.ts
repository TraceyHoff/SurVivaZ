// ADR-247: seeds/saplings come only from harvesting their own plant species (wild in the world or farmed).
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ProceduralGenerator } from "@engine/world";
import { addItem, countItem, Crop, FARMING, gameplayDefs, IntentAction, ItemGathered, plantableBySeed, seedSourceIssues, seedSourceNodes, setIntent, spawnPlayer, spawnResourceNode, worldgenBands } from "../src/index.js";
import type { YieldDef } from "../src/index.js";
import { collect, makeWorld, steps } from "./helpers.js";

const SEEDS = new Set(FARMING.plantables.map((p) => p.seed));
const speciesOf = new Map(FARMING.plantables.map((p) => [p.seed, p]));
const dataDir = new URL("../data/", import.meta.url);

/** Harvest `count` fresh `node` nodes (no-tool plants) with a player; returns item key -> total gathered. */
function harvest(node: string, count: number, seed = 7): Map<string, number> {
  const w = makeWorld({}, seed); const d = gameplayDefs(w); const got = collect(w, ItemGathered); const p = spawnPlayer(w, { x: 3.5, y: 3 });
  for (let i = 0; i < count; i++) {
    const n = spawnResourceNode(w, node, 3, 3);
    for (let k = 0; k < 12 && w.isAlive(n); k++) { setIntent(w, p, { action: IntentAction.Gather, target: n }); steps(w, 30); }
    if (w.isAlive(n)) w.destroy(n);
  }
  const out = new Map<string, number>(); for (const g of got) { const k = d.items.get(g.item)!.key; out.set(k, (out.get(k) ?? 0) + g.count); }
  return out;
}

describe("ADR-247 seed sources", () => {
  it("rules hold on the shipped data: no cross-species seed drops, every plantable has a world-spawned wild source, crops return their seeds, no seed recipes", () => {
    expect(seedSourceIssues(gameplayDefs(makeWorld()))).toEqual([]);
  });
  it("the validator flags a cross-species drop and a seed recipe", () => {
    const d = gameplayDefs(makeWorld()); const bush = d.resources.get(d.resourceId("berry_bush"))! as unknown as { yields: readonly YieldDef[] }; const saved = bush.yields;
    bush.yields = [...saved, { item: d.itemId("carrot_seeds"), min: 1, max: 1, chance: 0.1, seasonal: false }];
    try { expect(seedSourceIssues(d).join("\n")).toMatch(/berry_bush.*carrot_seeds|carrot_seeds.*berry_bush/); } finally { bush.yields = saved; }
    expect(seedSourceIssues(d)).toEqual([]);
  });
  it("each node yields at most its own species' seed (berry bush -> berry seeds only; wild garden / rotten stump yield none)", () => {
    const d = gameplayDefs(makeWorld());
    for (const r of d.resources.values()) {
      const seeds = r.yields.map((y) => d.items.get(y.item)!.key).filter((k) => SEEDS.has(k));
      expect(seeds.length, r.key).toBeLessThanOrEqual(1);
      for (const s of seeds) expect(seedSourceNodes(speciesOf.get(s)!).has(r.key), `${r.key} -> ${s}`).toBe(true);
    }
    const ys = (k: string) => d.resources.get(d.resourceId(k))!.yields.map((y) => d.items.get(y.item)!.key).filter((x) => SEEDS.has(x));
    expect(ys("berry_bush")).toEqual(["berry_seeds"]); expect(ys("wild_garden")).toEqual([]); expect(ys("rotten_stump")).toEqual([]);
    expect(ys("blueberry_bush")).toEqual(["blueberry_seeds"]); expect(ys("crop_tomato")).toEqual(["tomato_seeds"]);
  });
  it("seed keys appear in no loot, trader, stall, bot, spawn, recipe or starter data (only resource yields name them)", () => {
    const allowed = new Set(["farming.json", "items.json", "ids.lock.json", "sprite_fallbacks.json", "resources.json"]);
    for (const f of readdirSync(dataDir).filter((x) => x.endsWith(".json") && !allowed.has(x))) {
      let raw = JSON.parse(readFileSync(new URL(f, dataDir), "utf8")) as unknown;
      if (f === "pets.json") raw = JSON.parse(JSON.stringify(raw, (k, v: unknown) => (k === "diet" || k === "likes" ? undefined : v))); // what pets eat, not a source
      const s = JSON.stringify(raw); for (const seed of SEEDS) expect(s.includes(`"${seed}"`), `${f} names ${seed}`).toBe(false);
    }
  });
  it("every plantable's wild node really generates in the world (worldgen sample), on a biome its band places", () => {
    const w = makeWorld(); const d = gameplayDefs(w); const gen = new ProceduralGenerator({ seed: 1234, bands: worldgenBands(d) });
    const seen = new Set<number>();
    for (let cx = -12; cx < 12; cx++) for (let cy = -12; cy < 12; cy++) for (const n of gen.load(cx, cy).nodes) seen.add(n.kind);
    for (const p of FARMING.plantables) expect(p.wild.some((k) => seen.has(d.resourceId(k))), `${p.key} wild ${p.wild.join("/")}`).toBe(true);
  });
  it("gathering a wild berry bush gives berries and berry-bush seeds, never another species' seeds", () => {
    const got = harvest("berry_bush", 40);
    expect(got.get("berry_seeds") ?? 0).toBeGreaterThan(0);
    for (const k of got.keys()) if (SEEDS.has(k)) expect(k).toBe("berry_seeds");
  });
  it("harvesting farmed crops returns that crop's own seeds only", () => {
    for (const [node, seed] of [["crop_tomato", "tomato_seeds"], ["crop_wheat", "wheat_seeds"], ["crop_potato", "seed_potato"]] as const) {
      const got = harvest(node, 12);
      expect(got.get(seed) ?? 0, node).toBeGreaterThan(0);
      for (const k of got.keys()) if (SEEDS.has(k)) expect(k, node).toBe(seed);
    }
  });
  it("berry-bush seeds plant a berry bush; existing plantable kinds keep their indices (saves and inventories unchanged)", () => {
    expect(plantableBySeed("wheat_seeds")).toBe(1); expect(plantableBySeed("peach_sapling")).toBe(34); expect(plantableBySeed("berry_seeds")).toBe(35);
    const w = makeWorld(); const d = gameplayDefs(w); const p = spawnPlayer(w, { x: 5.5, y: 5.5 });
    addItem(w, p, d.itemId("berry_seeds"), 2); addItem(w, p, d.itemId("blueberry_seeds"), 3);
    setIntent(w, p, { action: IntentAction.Use, slot: 0 }); steps(w, 1);
    expect(countItem(w, p, d.itemId("berry_seeds"))).toBe(1); expect(countItem(w, p, d.itemId("blueberry_seeds"))).toBe(3);
    const c = [...w.query([Crop])][0]!; expect(FARMING.plantables[w.get(c, Crop)!.kind - 1]!.becomes).toBe("berry_bush");
  });
});
