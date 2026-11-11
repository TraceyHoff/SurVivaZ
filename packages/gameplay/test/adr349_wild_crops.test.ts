/**
 * ADR-349: fruit trees and crops visible in the world.
 * Seeded worldgen scatters wild fruit trees (bearing visible fruit) and wild crop plants; wild plants
 * draw with their farmed mature art (resources.json `sprite: crop_<key>`), so the produce shows.
 * Seeds still come only from each crop's own wild plant (ADR-247); wild plants follow the seasonal
 * frost rule (fruit trees + wild plants die below 40°F, ordinary trees and berry bushes survive).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setSeason } from "@engine/core";
import { CHUNK_SIZE, ProceduralGenerator } from "@engine/world";
import * as G from "../src/index.js";
import { collect, makeWorld, steps } from "./helpers.js";
import { resolveSprite } from "../src/sprite-fallback.js";

const FRUIT_TREES = ["apple_tree", "pear_tree", "cherry_tree", "orange_tree", "peach_tree"] as const;
const FRUIT = ["apple", "pear", "cherry", "orange", "peach"] as const;
/** Wild plants that draw with farmed mature art: wild key -> crop art key. */
const WILD_TO_CROP: Readonly<Record<string, string>> = {
  wild_wheat: "crop_wheat", wild_corn: "crop_corn", wild_potato: "crop_potato", wild_carrot: "crop_carrot",
  wild_tomato: "crop_tomato", wild_pumpkin: "crop_pumpkin", wild_squash: "crop_squash", wild_beans: "crop_beans",
  wild_cabbage: "crop_cabbage", wild_onion: "crop_onion", wild_garlic: "crop_garlic", cotton_bush: "crop_cotton",
  flax_patch: "crop_flax", wild_hemp: "crop_hemp", herb_patch: "crop_herbs", wild_mushroom: "crop_mushroom",
  wild_yarrow: "crop_yarrow", wild_ginseng: "crop_ginseng", wild_aloe: "crop_aloe", wild_hay: "crop_hay",
  wild_lettuce: "crop_lettuce", wild_pepper: "crop_pepper", wild_beetroot: "crop_beetroot", wild_rice: "crop_rice",
};
const SEEDS = [1234, 11, 99, 4242, 7, 2024];

const manifestKeys = (rel: string): string[] => {
  const j = JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")) as { sprites: { key: string }[] };
  return j.sprites.map((s) => s.key);
};
const packHas = new Set<string>([
  ...manifestKeys("../../assets/pack/manifest.json"),
  ...manifestKeys("../../assets/pack/nature/manifest.nature.json"),
  ...manifestKeys("../../assets/pack/task34/manifest.task34.json"),
  ...manifestKeys("../../assets/pack/task256/manifest.task256.json"),
]);
const has = (k: string): boolean => packHas.has(k);

/** Node counts by key over the 5x5 chunks around the origin for one seed. */
function countNodes(seed: number): Map<string, number> {
  const defs = G.defaultDefs();
  const g = new ProceduralGenerator({ seed, bands: G.worldgenBands(defs) });
  const counts = new Map<string, number>();
  for (let cy = -2; cy <= 2; cy++) for (let cx = -2; cx <= 2; cx++)
    for (const n of g.load(cx, cy).nodes) {
      const k = defs.resources.get(n.kind)?.key ?? `#${n.kind}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  return counts;
}
const isWild = (k: string): boolean => k.startsWith("wild_") || k === "flax_patch" || k === "cotton_bush" || k === "herb_patch";
const isFruit = (k: string): boolean => (FRUIT_TREES as readonly string[]).includes(k);

/** Harvest `count` fresh `node` nodes with a player; returns item key -> total gathered. */
function harvest(node: string, count: number): Map<string, number> {
  const w = makeWorld({}, 7); const d = G.gameplayDefs(w); const got = collect(w, G.ItemGathered);
  const p = G.spawnPlayer(w, { x: 3.5, y: 3 });
  for (let i = 0; i < count; i++) {
    const n = G.spawnResourceNode(w, node, 3, 3);
    for (let k = 0; k < 12 && w.isAlive(n); k++) { G.setIntent(w, p, { action: G.IntentAction.Gather, target: n }); steps(w, 30); }
    if (w.isAlive(n)) w.destroy(n);
  }
  const out = new Map<string, number>();
  for (const g of got) { const k = d.items.get(g.item)!.key; out.set(k, (out.get(k) ?? 0) + g.count); }
  return out;
}

describe("ADR-349: fruit trees and crops visible in the world", () => {
  it("worldgen scatters wild crops and fruit trees on every seed — deterministic per seed, different across seeds", () => {
    for (const seed of SEEDS) {
      const counts = countNodes(seed);
      const wild = [...counts.entries()].filter(([k]) => isWild(k)).reduce((a, [, v]) => a + v, 0);
      const fruit = [...counts.entries()].filter(([k]) => isFruit(k)).reduce((a, [, v]) => a + v, 0);
      const total = [...counts.values()].reduce((a, b) => a + b, 0);
      expect(wild, `seed ${seed} wild plants`).toBeGreaterThanOrEqual(380);
      expect(fruit, `seed ${seed} fruit trees`).toBeGreaterThanOrEqual(100);
      expect(wild / total, `seed ${seed} wild share`).toBeGreaterThan(0.25);
      for (const k of [...Object.keys(WILD_TO_CROP), "wild_garden"]) expect(counts.get(k) ?? 0, `seed ${seed} ${k}`).toBeGreaterThan(0);
      for (const k of FRUIT_TREES) expect(counts.get(k) ?? 0, `seed ${seed} ${k}`).toBeGreaterThan(0);
    }
    const defs = G.defaultDefs();
    const bands = G.worldgenBands(defs);
    const nodes = (seed: number): string => {
      const out: string[] = [];
      for (let cy = -1; cy <= 1; cy++) for (let cx = -1; cx <= 1; cx++)
        for (const n of new ProceduralGenerator({ seed, bands }).load(cx, cy).nodes) out.push(`${n.tx},${n.ty},${n.kind}`);
      return out.sort().join("|");
    };
    expect(nodes(1234)).toBe(nodes(1234));
    expect(nodes(1234)).not.toBe(nodes(99));
    expect(nodes(11)).not.toBe(nodes(4242));
  });

  it("worldgen never plants on water, and every fruit tree / wild crop is on a land band", () => {
    const defs = G.defaultDefs();
    const g = new ProceduralGenerator({ seed: 1234, bands: G.worldgenBands(defs) });
    for (let cy = -2; cy <= 2; cy++) for (let cx = -2; cx <= 2; cx++) {
      const { chunk, nodes } = g.load(cx, cy);
      for (const n of nodes) {
        const key = defs.resources.get(n.kind)?.key ?? "";
        if (!isWild(key) && !isFruit(key)) continue;
        const li = (n.ty - cy * CHUNK_SIZE) * CHUNK_SIZE + (n.tx - cx * CHUNK_SIZE);
        expect(chunk.tiles[li], `${key} at ${n.tx},${n.ty}`).not.toBe(1); // water
        expect(chunk.tiles[li], `${key} at ${n.tx},${n.ty}`).not.toBe(8); // shallows
      }
    }
  });

  it("wild plants draw with their farmed mature art (produce shows); yields and ADR-247 rules are untouched", () => {
    const d = G.defaultDefs();
    for (const [wild, crop] of Object.entries(WILD_TO_CROP)) {
      const res = d.resources.get(d.resourceId(wild))!;
      expect(res.spriteKey, wild).toBe(crop);
      expect(resolveSprite(res.spriteKey, has), wild).toMatchObject({ key: crop, tint: 0, scale: 1 });
      expect(res.key).toBe(wild); // the node is still the wild species: yields / seed drops key off `key`
    }
    // wild_garden is a mixed garden with no single farmed counterpart: it keeps its own art.
    expect(d.resources.get(d.resourceId("wild_garden"))!.spriteKey).toBe("wild_garden");
    // Every plantable's wild source is either farmed-art (above), the mixed garden, or the plant
    // itself (berry bushes and trees regrow into the same node they are gathered from, and that
    // node already shows its berries / fruit).
    for (const p of G.FARMING.plantables) {
      expect(p.wild.some((k) => WILD_TO_CROP[k] !== undefined || k === "wild_garden" || k === p.becomes), p.key).toBe(true);
    }
    expect(G.seedSourceIssues(d)).toEqual([]);
  });

  it("fruit trees bear visible fruit: the idle frame differs from the bare (depleted) frame for every species", () => {
    const nature = JSON.parse(readFileSync(fileURLToPath(new URL("../../assets/pack/nature/manifest.nature.json", import.meta.url)), "utf8")) as {
      sprites: { key: string; animations: Record<string, { frames: number[] }> }[];
    };
    const byKey = new Map(nature.sprites.map((s) => [s.key, s]));
    for (const tree of FRUIT_TREES) {
      const s = byKey.get(tree)!;
      expect(s, tree).toBeDefined();
      const idle = s.animations["idle"]!.frames[0]!;
      const depleted = s.animations["depleted"]!.frames[0]!;
      expect(idle, `${tree} idle frame`).not.toBe(depleted);
      expect(resolveSprite(tree, has)).toMatchObject({ key: tree, tint: 0, scale: 1 });
    }
  });

  it("gathering a fruit tree yields its fruit through the existing interact/gather path", () => {
    for (let i = 0; i < FRUIT_TREES.length; i++) {
      const got = harvest(FRUIT_TREES[i]!, 12);
      expect(got.get(FRUIT[i]!) ?? 0, FRUIT_TREES[i]).toBeGreaterThan(0);
    }
  });

  it("gathering a wild crop yields its produce and its own seeds only (ADR-247)", () => {
    const got = harvest("wild_corn", 40);
    expect(got.get("corn") ?? 0).toBeGreaterThan(0);
    expect(got.get("corn_seeds") ?? 0).toBeGreaterThan(0);
    const seeds = new Set(G.FARMING.plantables.map((p) => p.seed));
    for (const k of got.keys()) if (seeds.has(k)) expect(k).toBe("corn_seeds");
  });

  it("wild plants and fruit trees die in the frost; ordinary trees and berry bushes survive", () => {
    const w = makeWorld();
    setSeason(w, 2, 0); // winter
    expect(G.surfaceTemperature(w)).toBeLessThan(G.FROST_KILL_C);
    const wild = G.spawnResourceNode(w, "wild_corn", 3, 3);
    const fruit = G.spawnResourceNode(w, "apple_tree", 5, 5);
    const bush = G.spawnResourceNode(w, "berry_bush", 7, 7);
    const tree = G.spawnResourceNode(w, "tree", 9, 9);
    G.cropGrowthSystem(w);
    expect(w.get(wild, G.ResourceNode)!.amount).toBe(0);
    expect(w.get(fruit, G.ResourceNode)!.amount).toBe(0);
    expect(w.get(bush, G.ResourceNode)!.amount).toBeGreaterThan(0);
    expect(w.get(tree, G.ResourceNode)!.amount).toBeGreaterThan(0);
    expect(G.frostKillsNode("wild_corn")).toBe(true);
    expect(G.frostKillsNode("apple_tree")).toBe(true);
    expect(G.frostKillsNode("berry_bush")).toBe(false);
    expect(G.frostKillsNode("tree")).toBe(false);
  });

  it("farming still works end to end: till -> plant -> water -> grow -> harvest the farmed crop", () => {
    const w = makeWorld(); const d = G.gameplayDefs(w); const p = G.spawnPlayer(w, { x: 10.5, y: 10.5 });
    expect(G.till(w, p, 11.5, 10.5)).toBe(0);
    expect(G.plant(w, p, "wheat_seeds", 11.5, 10.5)).toBe(0);
    const crop = [...w.query([G.Crop])][0]!;
    G.water(w, 11.5, 10.5);
    const grow = G.FARMING.plantables.find((x) => x.seed === "wheat_seeds")!.growSeconds;
    for (let i = 0; i < grow && w.isAlive(crop); i++) G.cropGrowthSystem(w);
    expect(w.isAlive(crop)).toBe(false);
    const node = [...w.query([G.ResourceNode])].find((n) => w.get(n, G.ResourceNode)!.kind === d.resourceId("crop_wheat"))!;
    expect(node).toBeDefined();
    G.setIntent(w, p, { action: G.IntentAction.Gather, target: node });
    steps(w, 40);
    expect(w.isAlive(node)).toBe(false); // oneShot harvest removes it
    expect(G.countItem(w, p, d.itemId("wheat"))).toBeGreaterThan(0);
    expect(G.countItem(w, p, d.itemId("wheat_seeds"))).toBeGreaterThan(0);
  });
});
