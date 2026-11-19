/**
 * ADR-447: fruit-tree thinning that is neutral against the ADR-203/ADR-252 bot suites.
 *
 * The grass band is 83 -> 70 entries (berry 14->12, starters x3->x2, 4 wild kinds
 * x2->x1, apple/pear/cherry x2->x1, fiber_bush x2->x1). Measured over 5x5 chunks,
 * seeds [1234, 11, 99, 4242, 7, 2024] (see docs/DECISIONS.md ADR-447):
 * fruit mean 188.3 -> 170.7 (-9.3%, down on every seed), wild mean 478.2 -> 484.0
 * (flat, +1.2% reshuffle noise), berry mean 114.7 -> 117.5 (density ~0.0095 vs
 * 0.0093/tile of grass — held), total nodes identical per seed (thinning only
 * redistributes kinds, never adds/removes nodes).
 *
 * Why this dose: the V2 dose (83->61, wild -4.0%) and a middle dose (83->65,
 * wild -3.8%) both break ADR-349's wild floor (worst seed 337 / 339 < 340), so no
 * wild thinning beyond ~-1.5% survives the floor. The two ADR-252-live base
 * failures (raised-pad pad, 2x2-base foundation) are pre-existing at the ADR-441
 * base and fail identically with and without this change — see DECISIONS.md.
 */
import { describe, expect, it } from "vitest";
import { ProceduralGenerator } from "@engine/world";
import * as G from "../src/index.js";

const FRUIT_TREES = ["apple_tree", "pear_tree", "cherry_tree", "orange_tree", "peach_tree"] as const;
const SEEDS = [1234, 11, 99, 4242, 7, 2024];
/** Base (pre-ADR-447) counts over 5x5 chunks, same seeds — the thinning baseline. */
const BASE: Record<number, { wild: number; fruit: number; berry: number; total: number }> = {
  1234: { wild: 482, fruit: 261, berry: 106, total: 1731 },
  11: { wild: 426, fruit: 197, berry: 103, total: 1409 },
  99: { wild: 501, fruit: 168, berry: 122, total: 1327 },
  4242: { wild: 523, fruit: 209, berry: 122, total: 1557 },
  7: { wild: 353, fruit: 130, berry: 89, total: 1000 },
  2024: { wild: 584, fruit: 165, berry: 146, total: 1372 },
};

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

describe("ADR-447: fruit-tree thinning", () => {
  it("thins fruit on every seed, holds the wild floor and berry density, adds/removes no nodes", () => {
    let fruitMean = 0;
    for (const seed of SEEDS) {
      const counts = countNodes(seed);
      const wild = [...counts.entries()].filter(([k]) => isWild(k)).reduce((a, [, v]) => a + v, 0);
      const fruit = [...counts.entries()].filter(([k]) => isFruit(k)).reduce((a, [, v]) => a + v, 0);
      const berry = counts.get("berry_bush") ?? 0;
      const total = [...counts.values()].reduce((a, b) => a + b, 0);
      const b = BASE[seed]!;
      expect(fruit, `seed ${seed} fruit thinned vs base ${b.fruit}`).toBeLessThan(b.fruit);
      expect(wild, `seed ${seed} wild floor`).toBeGreaterThanOrEqual(340);
      expect(berry, `seed ${seed} berry held vs base ${b.berry}`).toBeGreaterThanOrEqual(Math.floor(b.berry * 0.9));
      expect(berry, `seed ${seed} berry held vs base ${b.berry}`).toBeLessThanOrEqual(Math.ceil(b.berry * 1.1));
      expect(total, `seed ${seed} total nodes unchanged`).toBe(b.total);
      fruitMean += fruit;
      console.log(`ADR447 seed=${seed} wild=${wild} fruit=${fruit} berry=${berry} total=${total}`);
    }
    fruitMean /= SEEDS.length;
    console.log(`ADR447 MEAN fruit=${fruitMean.toFixed(1)} (base 188.3)`);
    expect(fruitMean, "mean fruit thinned vs base 188.3").toBeLessThanOrEqual(175);
  });
});
