import { describe, it, expect } from "vitest";
import { defaultDefs, ItemCategory, ToolKind } from "../src/index.js";
import ai from "../data/ai.json";

const d = defaultDefs();
const key = (id: number) => d.items.get(id)!.key;
const recipes = [...d.recipes.values()];

/** Items available without crafting: node yields, zombie/animal loot keys, the spoiled item. */
function baseSources(): Set<number> {
  const s = new Set<number>([d.spoiledItem]);
  for (const r of d.resources.values()) for (const y of r.yields) if (y.chance > 0 && y.max > 0) s.add(y.item);
  const aiText = JSON.stringify(ai);
  for (const it of d.items.values()) if (aiText.includes(`"${it.key}"`)) s.add(it.id);
  s.add(d.itemId("dung")); // ADR-352: produced by dungSystem (data/dung.json), not gathered / crafted / looted
  return s;
}
function reachable(): Set<number> {
  const have = baseSources(); let grew = true;
  while (grew) { grew = false; for (const r of recipes) if (!have.has(r.output.item) && r.ingredients.every((i) => have.has(i.item))) { have.add(r.output.item); grew = true; }
    // ADR-264: Soil is obtained by digging once a shovel is obtainable (not a recipe / node yield).
    if (!have.has(d.itemId("soil")) && [...d.items.values()].some((it) => it.tool?.kind === ToolKind.Shovel && have.has(it.id))) {
      have.add(d.itemId("soil")); grew = true;
    }
    // Task 13: boiling is a container-preserving transform, not a recipe — a boiled variant is
    // reachable whenever its raw form is (use a filled container at a lit campfire).
    for (const it of d.items.values()) if (it.boilSource && have.has(it.boilSource) && !have.has(it.id)) { have.add(it.id); grew = true; } }
  return have;
}
/** Raw-material cost (sum of base-source units) of the cheapest recipe chain. */
const costMemo = new Map<number, number>();
function rawCost(id: number, base: Set<number>, depth = 0): number {
  if (costMemo.has(id)) return costMemo.get(id)!;
  if (base.has(id) || depth > 12) return 1;
  let best = Infinity;
  for (const r of recipes) if (r.output.item === id) {
    const c = r.ingredients.reduce((a, i) => a + i.count * rawCost(i.item, base, depth + 1), 0) / r.output.count; best = Math.min(best, c);
  }
  costMemo.set(id, best); return best;
}
const power = (it: ReturnType<typeof d.items.get> & object): number =>
  (it.explosive ? it.explosive.damage + it.explosive.structureDamage : undefined) ?? it.ranged?.damage ?? it.thrown?.damage ?? it.weapon?.damage ?? it.wear?.armor ?? it.wear?.insulation ?? it.tool?.tier ?? 0;

describe("content balance", () => {
  it("every item is obtainable (reachability fixpoint from gather/loot)", () => {
    const r = reachable();
    expect([...d.items.values()].filter((i) => !r.has(i.id) && i.key !== "vehicle_key").map((i) => i.key)).toEqual([]);
  });
  it("no free items: every recipe has ingredients, none outputs more of an input than it consumes", () => {
    for (const r of recipes) {
      expect(r.ingredients.length, r.key).toBeGreaterThan(0);
      for (const i of r.ingredients) if (i.item === r.output.item) expect(r.output.count, r.key).toBeLessThanOrEqual(i.count);
      expect(r.seconds, r.key).toBeGreaterThan(0);
    }
  });
  it("every crafted item has positive finite raw cost", () => {
    const base = baseSources();
    for (const r of recipes) { const c = rawCost(r.output.item, base); expect(Number.isFinite(c) && c > 0, key(r.output.item)).toBe(true); }
  });
  it("damage/armor, durability are monotonic per family across tiers", () => {
    const fam = new Map<string, NonNullable<ReturnType<typeof d.items.get>>[]>();
    for (const it of d.items.values()) if (it.family && it.tier > 0) { const k = `${it.family}`; (fam.get(k) ?? fam.set(k, []).get(k)!).push(it); }
    const bad: string[] = [];
    for (const [f, list] of fam) {
      const byTier = [...list].sort((a, b) => a.tier - b.tier);
      for (let i = 1; i < byTier.length; i++) {
        const a = byTier[i - 1]!, b = byTier[i]!;
        if (a.tier === b.tier || a.wear?.slot !== b.wear?.slot) continue;
        if (power(b) < power(a)) bad.push(`${f}: power ${a.key}>${b.key}`);
        if (b.maxDurability < a.maxDurability) bad.push(`${f}: durability ${a.key}>${b.key}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it("tier gating: no recipe uses a tiered part above its output's tier", () => {
    const bad: string[] = [];
    for (const r of recipes) { const o = d.items.get(r.output.item)!; if (!o.tier) continue;
      for (const i of r.ingredients) { const t = d.items.get(i.item)!.tier; if (t > o.tier) bad.push(`${r.key} uses ${key(i.item)}`); } }
    expect(bad).toEqual([]);
  });
  it("every new category is populated and every wearable/weapon has a tier", () => {
    const cats = new Map<number, number>();
    for (const it of d.items.values()) cats.set(it.category, (cats.get(it.category) ?? 0) + 1);
    for (const c of [ItemCategory.Clothing, ItemCategory.Armor, ItemCategory.Ammo, ItemCategory.Explosive]) expect(cats.get(c) ?? 0).toBeGreaterThan(5);
    for (const it of d.items.values()) if (it.wear || it.ranged || it.explosive || it.weapon) expect(it.tier, it.key).toBeGreaterThan(0);
  });
  it("ranged weapons reference ammo that is craftable", () => {
    const crafted = new Set(recipes.map((r) => r.output.item));
    for (const it of d.items.values()) if (it.ranged) for (const a of it.ranged.ammo) expect(crafted.has(a), `${it.key}->${key(a)}`).toBe(true);
  });
});
