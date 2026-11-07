/**
 * Task 32: new pets (fox, owl, turtle, squirrel), new farmable crops (lettuce, pepper, beetroot, rice)
 * and new farm animals (pig, alpaca, bee, rabbit-as-angora). Pinned numbers:
 * - pets: fox = scout (fastest, hp 25, speed 4.0, dmgMul 0.9), owl = night scout (hp 14, speed 3.4),
 *   turtle = tank guard (hp 60, speed 1.2), squirrel = tiny forager (hp 5, speed 3.8); each has its own
 *   skill tree with the Task 15 points cadence (levels 1/6/11/16).
 * - crops: lettuce 420s, pepper 600s, beetroot 660s, rice 720s (4 stages each, plantable kinds 37-40);
 *   wild nodes yield produce 1-2 + own seed 1 @0.3, crop nodes yield 2-4 (+2-3 beetroot) + seeds 1-2 @0.6.
 * - farm animals: pig -> truffle 480s, alpaca -> wool 420s, bee -> honey 360s, rabbit -> wool 480s.
 * Art: every new kind resolves through sprite_fallbacks.json to a real pack sprite (Task 28 pattern);
 * every new item key is itself a real sprite in the nature/base manifest.
 * ADR-257 keys now ship as packed nature-pack art (wild + growth stages + icons); wheat already unique.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PlayerId, Season, setSeason, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned, steps } from "./helpers.js";
import { resolveIcon, resolveSprite } from "../src/sprite-fallback.js";
import ids from "../data/ids.lock.json";

const d = G.defaultDefs();
const iid = (k: string) => d.itemId(k);
const pid = (k: string) => d.pieceId(k);
const BASE = { x: 10, y: 10 };
const STAND = { x: BASE.x + G.BUILD_STAND.x, y: BASE.y + G.BUILD_STAND.y };
function fresh(): { w: World; p: Entity } {
  const w = makeWorld(); const p = spawnLearned(w, { x: BASE.x + 1, y: BASE.y + 3.3, maxWeight: 0, clientId: 1 }); steps(w, 1); return { w, p };
}
const give = (w: World, e: Entity, key: string, tier = 0): void => { const def = d.pieces.get(pid(key))!; for (const c of G.pieceCost(d, def, def.tiered ? tier : def.fixedTier)) G.addItem(w, e, c.item, c.count); };
const put = (w: World, e: Entity, key: string, x: number, y: number, level = 0, rot = 0, tier?: number, stand?: { x: number; y: number }) => {
  const def = d.pieces.get(pid(key))!; const t = tier ?? (def.tiered ? 0 : def.fixedTier); give(w, e, key, t);
  w.set(e, Transform, stand ?? { x, y: y + 1.2 });
  return G.tryPlace(w, e, { piece: pid(key), x, y, level, rot, tier: t, variant: 0 });
};
/** Grant the player Husbandry 1 so taming is not gated by NeedsSkill (ADR-234 pattern). */
const husbandry1 = (w: World, p: Entity): void => {
  for (const k of G.TREE_KEYS) G.grantTreePoints(w, p, k, 5000 - G.treePoints(w, p, k));
  const i = G.SKILLS.nodes.findIndex((n) => n.key === "husbandry_1");
  const why = G.unlockSkill(w, p, i);
  if (why) throw new Error(`unlock husbandry_1: ${why}`);
};
/** Grant the player Husbandry 2 ("pens") so trough production is not gated by canUsePens (ADR-234 pattern). */
const pens = (w: World, p: Entity): void => {
  for (const k of G.TREE_KEYS) G.grantTreePoints(w, p, k, 5000 - G.treePoints(w, p, k));
  const unlock = (i: number): void => { for (const r of G.SKILL_REQS[i]!) unlock(r); const why = G.unlockSkill(w, p, i); if (why) throw new Error(`unlock ${G.SKILLS.nodes[i]!.key}: ${why}`); };
  unlock(G.SKILLS.nodes.findIndex((n) => n.key === "husbandry_pens"));
};
const tillSpot = (w: World, p: Entity): { x: number; y: number } => {
  for (let dx = 2; dx < 10; dx++) for (let dy = 0; dy < 4; dy++) {
    const x = BASE.x + dx, y = BASE.y + dy;
    if (G.till(w, p, x, y) === G.FarmFail.None) return { x, y };
  }
  throw new Error("no tillable spot");
};
const cropAt = (w: World, x: number, y: number, seed: string, growth: number): Entity => {
  const c = w.create();
  w.add(c, Transform, { x, y }).add(c, G.Crop, { kind: G.plantableBySeed(seed), stage: 0, growth, waterUntilTick: 0, fertilized: 0 });
  G.indexEntity(w, c); return c;
};
/** A tamed farm animal; fedUntil/produceAt default far in the future (fed, not producing) unless overridden. */
const tamed = (w: World, owner: Entity, kind: string, x: number, y: number, over: Partial<{ fedUntil: number; produceAt: number }> = {}): Entity => {
  const a = G.spawnAnimal(w, kind, x, y); const k = w.get(a, G.Animal)!.kind;
  w.add(a, G.Tamed, { kind: k, owner, fedUntil: over.fedUntil ?? w.tick + 100000, produceAt: over.produceAt ?? w.tick + 100000, breedAt: w.tick + 100000 });
  return a;
};
/** A grass tile (tile 3) near (x, y) for grazing tests. */
const grassSpot = (w: World, x: number, y: number): { x: number; y: number } => {
  const terrain = w.getResource(G.TerrainRes)!;
  for (let dx = 0; dx < 12; dx++) for (let dy = 0; dy < 12; dy++) if (terrain.tileAt(x + dx, y + dy) === G.GRASS_TILE) return { x: x + dx + 0.5, y: y + dy + 0.5 };
  throw new Error("no grass tile near the base");
};
/** Install a TerrainRes stub: tiles (10..21, 10..21) are grass, everything else dirt. */
const withTerrain = (w: World): void => {
  w.setResource(G.TerrainRes, {
    tileAt: (tx: number, ty: number) => (tx >= 10 && tx < 22 && ty >= 10 && ty < 22 ? G.GRASS_TILE : 4),
    heightAt: () => 0,
  });
};
// Real sprite keys from the art pack manifests (base + nature + task34), exactly the set the runtime `has` is built from.
const manifestKeys = (rel: string): string[] => {
  const j = JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")) as { sprites: { key: string }[] };
  return j.sprites.map((s) => s.key);
};
const realSprites = new Set<string>([
  ...manifestKeys("../../assets/pack/manifest.json"),
  ...manifestKeys("../../assets/pack/nature/manifest.nature.json"),
  ...manifestKeys("../../assets/pack/task34/manifest.task34.json"), // Task 34: dedicated bee/owl art
  ...manifestKeys("../../assets/pack/task256/manifest.task256.json"), // ADR-257: unique lettuce/hay art
]);
const has = (k: string): boolean => realSprites.has(k);

describe("Task 32: new pets", () => {
  it("roster: 17 species; the 4 new pets have distinct roles, treats and diets", () => {
    expect(G.PET_SPECIES.length).toBe(17);
    expect(G.animalDefs().length).toBe(37);
    const fox = G.PET_SPECIES[G.petSpeciesOfKey("fox") - 1]!;
    expect(fox).toMatchObject({ animal: "animal_fox", family: "small", baseTame: 0.2, damageMul: 0.9 });
    expect(fox.treats).toMatchObject({ meaty_chew: "love", fish_treat: "love", dog_biscuit: "like", egg_crunch: "like", veggie_bites: "ok", seed_mix: "hate" });
    expect(fox.diet).toContain("raw_small_game");
    const owl = G.PET_SPECIES[G.petSpeciesOfKey("owl") - 1]!;
    expect(owl).toMatchObject({ animal: "animal_owl", family: "bird", baseTame: 0.18, damageMul: 0.6 });
    expect(owl.treats).toMatchObject({ meaty_chew: "love", fish_treat: "like", veggie_bites: "hate" });
    const turtle = G.PET_SPECIES[G.petSpeciesOfKey("turtle") - 1]!;
    expect(turtle).toMatchObject({ animal: "animal_turtle", family: "small", baseTame: 0.3, damageMul: 0.5 });
    expect(turtle.treats).toMatchObject({ veggie_bites: "love", seed_mix: "like", meaty_chew: "hate" });
    expect(turtle.diet).toContain("lettuce"); // the new crop feeds the new pet
    const squirrel = G.PET_SPECIES[G.petSpeciesOfKey("squirrel") - 1]!;
    expect(squirrel).toMatchObject({ animal: "animal_squirrel", family: "small", baseTame: 0.28, damageMul: 0.5 });
    expect(squirrel.treats).toMatchObject({ seed_mix: "love", veggie_bites: "like", meaty_chew: "hate" });
    // every new pet's animal kind exists with loot (adr110 rule) and a distinct stat line
    for (const kind of ["animal_fox", "animal_owl", "animal_turtle", "animal_squirrel"]) {
      const def = G.animalDefs().find((a) => a.key === kind)!;
      expect(def).toBeDefined(); expect(def.loot.length).toBeGreaterThan(0);
    }
    expect(G.animalDefs().find((a) => a.key === "animal_fox")!.hp).toBe(25);
    expect(G.animalDefs().find((a) => a.key === "animal_owl")!.hp).toBe(14);
    expect(G.animalDefs().find((a) => a.key === "animal_turtle")!.hp).toBe(60);
    expect(G.animalDefs().find((a) => a.key === "animal_squirrel")!.hp).toBe(5);
  });

  it("taming: loved treats tame best, hated treats never tame; diet foods feed, other foods do not", () => {
    const fox = G.petSpeciesOfKey("fox"); const owl = G.petSpeciesOfKey("owl");
    const turtle = G.petSpeciesOfKey("turtle"); const squirrel = G.petSpeciesOfKey("squirrel");
    // tameChance = baseTame x prefMul (love 1.0, like 0.6, ok 0.25, hate 0)
    expect(G.tameChance(fox, "meaty_chew")).toBeCloseTo(0.2, 6); // love
    expect(G.tameChance(fox, "dog_biscuit")).toBeCloseTo(0.12, 6); // like
    expect(G.tameChance(fox, "veggie_bites")).toBeCloseTo(0.05, 6); // ok
    expect(G.tameChance(fox, "seed_mix")).toBe(0); // hate
    expect(G.tameChance(owl, "meaty_chew")).toBeCloseTo(0.18, 6);
    expect(G.tameChance(owl, "veggie_bites")).toBe(0);
    expect(G.tameChance(turtle, "veggie_bites")).toBeCloseTo(0.3, 6);
    expect(G.tameChance(turtle, "meaty_chew")).toBe(0);
    expect(G.tameChance(squirrel, "seed_mix")).toBeCloseTo(0.28, 6);
    expect(G.tameChance(squirrel, "fish_treat")).toBe(0);
    // food value: treats feed (hate = 0), diet items feed, anything else is 0
    expect(G.petFoodValue(fox, "raw_meat")).toBeGreaterThan(0);
    expect(G.petFoodValue(fox, "lettuce")).toBe(0);
    expect(G.petFoodValue(turtle, "lettuce")).toBeGreaterThan(0);
    expect(G.petFoodValue(turtle, "raw_meat")).toBe(0);
    expect(G.petFoodValue(squirrel, "seed_mix")).toBeGreaterThan(0);
    expect(G.petFoodValue(squirrel, "fish")).toBe(0);
  });

  it("roles: fox is the fastest and hardest-hitting pet, turtle the toughest and slowest", () => {
    const fox = G.petSpeciesOfKey("fox"); const owl = G.petSpeciesOfKey("owl");
    const turtle = G.petSpeciesOfKey("turtle"); const squirrel = G.petSpeciesOfKey("squirrel");
    const f = G.petStats(fox, 1); const o = G.petStats(owl, 1); const t = G.petStats(turtle, 1); const s = G.petStats(squirrel, 1);
    expect(f.maxHp).toBe(25); expect(o.maxHp).toBe(14); expect(t.maxHp).toBe(60); expect(s.maxHp).toBe(5);
    expect(f.run).toBeCloseTo(5.0, 6); // fox 4.0 x 1.25 — fastest land animal
    expect(s.run).toBeCloseTo(4.75, 6); // squirrel 3.8 x 1.25
    expect(o.run).toBeCloseTo(4.25, 6); // owl 3.4 x 1.25
    expect(t.run).toBeCloseTo(1.5, 6); // turtle 1.2 x 1.25 — slowest
    expect(f.run).toBeGreaterThan(s.run); expect(s.run).toBeGreaterThan(o.run); expect(o.run).toBeGreaterThan(t.run);
    // damage = archetype attack (fox/squirrel have none -> 3) x damageMul; owl/turtle have real attacks
    expect(f.damage).toBeCloseTo(2.7, 6); expect(t.damage).toBeCloseTo(2, 6);
    expect(s.damage).toBeCloseTo(1.5, 6); expect(o.damage).toBeCloseTo(1.2, 6);
    expect(f.damage).toBeGreaterThan(t.damage); expect(t.damage).toBeGreaterThan(s.damage);
  });

  it("each new pet has its own skill tree with the role's nodes, and levels on the Task 15 cadence", () => {
    const defs = G.gameplayDefs(makeWorld());
    expect(defs.animalSkills.size).toBe(26);
    const fox = defs.animalSkillTree("animal_fox")!;
    expect(fox.nodes.map((n) => n.key)).toEqual(["swift_1", "swift_2", "teeth_1", "teeth_2", "hide_1"]);
    expect(fox.nodes[0]!.effect).toMatchObject({ type: "speed", value: 0.12 });
    const owl = defs.animalSkillTree("animal_owl")!;
    expect(owl.nodes.map((n) => n.key)).toEqual(["swift_1", "swift_2", "talons_1", "talons_2", "hide_1"]);
    const turtle = defs.animalSkillTree("animal_turtle")!;
    expect(turtle.nodes.map((n) => n.key)).toEqual(["shell_1", "shell_2", "bite_1", "steady_1"]);
    expect(turtle.nodes[0]!.effect).toMatchObject({ type: "health", value: 0.2 });
    const squirrel = defs.animalSkillTree("animal_squirrel")!;
    expect(squirrel.nodes.map((n) => n.key)).toEqual(["swift_1", "swift_2", "teeth_1", "hide_1"]);
    expect(squirrel.nodes[0]!.effect).toMatchObject({ type: "speed", value: 0.15 });
    // leveling: a fox pet starts with 1 point at level 1 and gains one at level 6 (Task 15 cadence)
    const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
    w.addSystem("simulation", "gameplay.animalAI", G.animalAISystem);
    const p = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 });
    if (w.has(p, PlayerId)) w.set(p, PlayerId, { id: 7 }); else w.add(p, PlayerId, { id: 7 });
    w.add(p, G.Tribe, { id: 5 });
    const a = G.spawnAnimal(w, "animal_fox", 1, 0);
    G.addItem(w, p, iid("meaty_chew"), 50);
    for (let i = 0; i < 40 && !w.has(a, G.Pet); i++) { G.offerTreat(w, p, a, iid("meaty_chew")); w.step(1 / 20); }
    expect(w.has(a, G.Pet)).toBe(true);
    expect(w.getField(a, G.Pet, "species")).toBe(G.petSpeciesOfKey("fox"));
    expect(w.get(a, G.AnimalSkills)).toMatchObject({ level: 1, points: 1, nodes: 0 });
    const to = (from: number, toLevel: number): number => { let s = 0; for (let l = from; l < toLevel; l++) s += G.petXpToNext(l); return s; };
    G.grantXp(w, a, to(1, 6));
    expect(w.getField(a, G.Pet, "level")).toBe(6);
    expect(w.getField(a, G.AnimalSkills, "points")).toBe(2);
    // spending: Swift Paws I (+12% speed) applies to the fox's run
    expect(G.spendAnimalSkill(w, p, a, 0)).toBe(G.ANIMAL_SKILL_FAIL.None);
    const sp = w.getField(a, G.Pet, "species")!;
    expect(G.petStatsWithSkills(w, a, sp, 1).run).toBeCloseTo(G.petStats(sp, 1).run * 1.12, 6);
    // turtle shell: Tough Shell I (+20% health) on a tamed turtle
    const t2 = G.spawnAnimal(w, "animal_turtle", 1, 0);
    G.addItem(w, p, iid("veggie_bites"), 50);
    for (let i = 0; i < 40 && !w.has(t2, G.Pet); i++) { G.offerTreat(w, p, t2, iid("veggie_bites")); w.step(1 / 20); }
    expect(w.has(t2, G.Pet)).toBe(true);
    expect(G.spendAnimalSkill(w, p, t2, 0)).toBe(G.ANIMAL_SKILL_FAIL.None);
    const sp2 = w.getField(t2, G.Pet, "species")!;
    expect(G.petStatsWithSkills(w, t2, sp2, 1).maxHp).toBe(Math.round(G.petStats(sp2, 1).maxHp * 1.2));
  });
});

describe("Task 32: new crops", () => {
  it("ids, plantables (kinds 37-40), yields, and ADR-247 seed sources", () => {
    expect(ids.items.beetroot).toBe(478); expect(ids.items.beetroot_seeds).toBe(479);
    expect(ids.items.lettuce).toBe(480); expect(ids.items.lettuce_seeds).toBe(481);
    expect(ids.items.pepper).toBe(482); expect(ids.items.pepper_seeds).toBe(483);
    expect(ids.items.rice).toBe(484); expect(ids.items.rice_bowl).toBe(485); expect(ids.items.rice_seeds).toBe(486);
    expect(ids.items.salad).toBe(487); expect(ids.items.truffle).toBe(488); expect(ids.items.truffle_stew).toBe(489);
    expect(ids.resources.crop_beetroot).toBe(87); expect(ids.resources.crop_lettuce).toBe(88);
    expect(ids.resources.crop_pepper).toBe(89); expect(ids.resources.crop_rice).toBe(90);
    expect(ids.resources.wild_beetroot).toBe(91); expect(ids.resources.wild_lettuce).toBe(92);
    expect(ids.resources.wild_pepper).toBe(93); expect(ids.resources.wild_rice).toBe(94);
    expect(ids.recipes.rice_bowl).toBe(375); expect(ids.recipes.salad).toBe(376); expect(ids.recipes.truffle_stew).toBe(377);
    expect(G.FARMING.plantables.length).toBe(40);
    expect(G.plantableBySeed("lettuce_seeds")).toBe(37);
    expect(G.plantableBySeed("pepper_seeds")).toBe(38);
    expect(G.plantableBySeed("beetroot_seeds")).toBe(39);
    expect(G.plantableBySeed("rice_seeds")).toBe(40);
    expect(G.plantableOf(37)).toMatchObject({ seed: "lettuce_seeds", key: "lettuce", type: "crop", growSeconds: 420, stages: 4, becomes: "crop_lettuce", tiles: [3, 4], wild: ["wild_lettuce"] });
    expect(G.plantableOf(38)).toMatchObject({ seed: "pepper_seeds", key: "pepper", type: "crop", growSeconds: 600, stages: 4, becomes: "crop_pepper", tiles: [3, 4], wild: ["wild_pepper"] });
    expect(G.plantableOf(39)).toMatchObject({ seed: "beetroot_seeds", key: "beetroot", type: "crop", growSeconds: 660, stages: 4, becomes: "crop_beetroot", tiles: [3, 4], wild: ["wild_beetroot"] });
    expect(G.plantableOf(40)).toMatchObject({ seed: "rice_seeds", key: "rice", type: "crop", growSeconds: 720, stages: 4, becomes: "crop_rice", tiles: [3, 4], wild: ["wild_rice"] });
    // food: lettuce hydrates, pepper/beetroot/rice feed, truffle is a rich food
    expect(d.items.get(iid("lettuce"))!.food).toMatchObject({ hunger: 6, thirst: 8 });
    expect(d.items.get(iid("pepper"))!.food).toMatchObject({ hunger: 7, thirst: 4 });
    expect(d.items.get(iid("beetroot"))!.food).toMatchObject({ hunger: 9, thirst: 3 });
    expect(d.items.get(iid("rice"))!.food).toMatchObject({ hunger: 10 });
    expect(d.items.get(iid("truffle"))!.food).toMatchObject({ hunger: 15, health: 2 });
    // wild nodes: produce 1-2 + own seed 1 @0.3; crop nodes: oneShot, produce + seeds 1-2 @0.6
    for (const [wildKey, cropKey, produce, max] of [
      ["wild_lettuce", "crop_lettuce", "lettuce", 4], ["wild_pepper", "crop_pepper", "pepper", 4],
      ["wild_beetroot", "crop_beetroot", "beetroot", 3], ["wild_rice", "crop_rice", "rice", 4],
    ] as const) {
      const wild = d.resources.get(d.resourceId(wildKey))!;
      expect(wild).toMatchObject({ capacity: 2, respawnSeconds: 240 });
      expect(wild.yields).toEqual([{ item: iid(produce), min: 1, max: 2, chance: 1 }, { item: iid(`${produce}_seeds`), min: 1, max: 1, chance: 0.3 }]);
      const crop = d.resources.get(d.resourceId(cropKey))!;
      expect(crop).toMatchObject({ capacity: 1, respawnSeconds: 600, oneShot: true });
      expect(crop.yields).toEqual([{ item: iid(produce), min: 2, max, chance: 1 }, { item: iid(`${produce}_seeds`), min: 1, max: 2, chance: 0.6 }]);
    }
    // ADR-247: every seed drops only from its own species (wild nodes are placed by worldgen, crops return seeds)
    expect(G.seedSourceIssues(d)).toEqual([]);
    // recipes: salad (no station), rice bowl + truffle stew (campfire)
    expect(d.recipes.get(ids.recipes.salad)).toMatchObject({ station: G.StationKind.None, seconds: 2 });
    expect(d.recipes.get(ids.recipes.salad)!.ingredients).toEqual([{ item: iid("lettuce"), count: 1 }, { item: iid("tomato"), count: 1 }, { item: iid("carrot"), count: 1 }]);
    expect(d.recipes.get(ids.recipes.rice_bowl)).toMatchObject({ station: G.StationKind.Campfire, seconds: 4 });
    expect(d.recipes.get(ids.recipes.rice_bowl)!.ingredients).toEqual([{ item: iid("rice"), count: 1 }, { item: iid("fish"), count: 1 }]);
    expect(d.recipes.get(ids.recipes.truffle_stew)).toMatchObject({ station: G.StationKind.Campfire, seconds: 6 });
    expect(d.recipes.get(ids.recipes.truffle_stew)!.ingredients).toEqual([{ item: iid("truffle"), count: 1 }, { item: iid("potato"), count: 1 }, { item: iid("onion"), count: 1 }]);
    expect(d.items.get(iid("salad"))!.food).toMatchObject({ hunger: 18, thirst: 6, health: 1 });
    expect(d.items.get(iid("rice_bowl"))!.food).toMatchObject({ hunger: 16, thirst: 4, health: 1 });
    expect(d.items.get(iid("truffle_stew"))!.food).toMatchObject({ hunger: 22, thirst: 4, health: 3 });
  });

  it("lettuce plants, grows at the 420s rate, matures into crop_lettuce, and harvest returns lettuce + its own seeds", () => {
    const { w, p } = fresh(); setSeason(w, 0, 0); // summer: growing season, above the frost line
    G.addItem(w, p, iid("hoe"), 1); G.addItem(w, p, iid("lettuce_seeds"), 5); G.addItem(w, p, iid("watering_can"), 1);
    const spot = tillSpot(w, p);
    expect(G.plant(w, p, "lettuce_seeds", spot.x, spot.y)).toBe(G.FarmFail.None);
    const crop = [...w.query([G.Crop])].find((e) => { const t = w.get(e, Transform)!; return t.x === spot.x && t.y === spot.y; })!;
    expect(w.get(crop, G.Crop)!.kind).toBe(37);
    expect(G.water(w, spot.x, spot.y)).toBe(1);
    const mul = G.growthMul(w, w.get(crop, G.Crop)!);
    G.cropGrowthSystem(w);
    expect(w.get(crop, G.Crop)!.growth).toBeCloseTo(mul / 420, 6); // 1s of growth at the 420s rate
    w.set(crop, G.Crop, { growth: 1 });
    G.cropGrowthSystem(w);
    expect(w.isAlive(crop)).toBe(false); // matured into a node
    const node = [...w.query([G.ResourceNode])].find((e) => d.resources.get(w.get(e, G.ResourceNode)!.kind)?.key === "crop_lettuce");
    expect(node).toBeDefined();
    // harvest 12 fresh crop_lettuce nodes next to the player (ADR-247 pattern): lettuce 2-4 each, seeds come back
    w.set(p, Transform, { x: 3.5, y: 3 });
    const lettuceBefore = G.countItem(w, p, iid("lettuce")); const seedsBefore = G.countItem(w, p, iid("lettuce_seeds"));
    for (let i = 0; i < 12; i++) {
      const n = G.spawnResourceNode(w, "crop_lettuce", 3, 3);
      for (let k = 0; k < 12 && w.isAlive(n); k++) { G.setIntent(w, p, { action: G.IntentAction.Gather, target: n }); steps(w, 30); }
      if (w.isAlive(n)) w.destroy(n);
    }
    expect(G.countItem(w, p, iid("lettuce")) - lettuceBefore).toBeGreaterThanOrEqual(24);
    expect(G.countItem(w, p, iid("lettuce_seeds")) - seedsBefore).toBeGreaterThan(0);
  });

  it("pepper, beetroot and rice plant and grow at their own rates and mature into their crop nodes", () => {
    for (const [seed, kind, secs, nodeKey] of [
      ["pepper_seeds", 38, 600, "crop_pepper"], ["beetroot_seeds", 39, 660, "crop_beetroot"], ["rice_seeds", 40, 720, "crop_rice"],
    ] as const) {
      const { w, p } = fresh(); setSeason(w, 0, 0);
      G.addItem(w, p, iid("hoe"), 1); G.addItem(w, p, iid(seed), 5); G.addItem(w, p, iid("watering_can"), 1);
      const spot = tillSpot(w, p);
      expect(G.plant(w, p, seed, spot.x, spot.y)).toBe(G.FarmFail.None);
      const crop = [...w.query([G.Crop])].find((e) => { const t = w.get(e, Transform)!; return t.x === spot.x && t.y === spot.y; })!;
      expect(w.get(crop, G.Crop)!.kind).toBe(kind);
      G.water(w, spot.x, spot.y); // ADR-286: growth needs water
      const mul = G.growthMul(w, w.get(crop, G.Crop)!);
      G.cropGrowthSystem(w);
      expect(w.get(crop, G.Crop)!.growth).toBeCloseTo(mul / secs, 6); // 1s of growth at this crop's rate
      w.set(crop, G.Crop, { growth: 1 });
      G.cropGrowthSystem(w);
      expect(w.isAlive(crop)).toBe(false);
      expect([...w.query([G.ResourceNode])].some((e) => d.resources.get(w.get(e, G.ResourceNode)!.kind)?.key === nodeKey)).toBe(true);
    }
  });

  it("Task 28 seasonal rules cover the new crops: dormant in late fall/winter, killed below 40F", () => {
    const { w } = fresh();
    setSeason(w, 0, 0); expect(G.isCropDormant(w)).toBe(false); // summer grows
    const lettuce = cropAt(w, BASE.x + 3, BASE.y, "lettuce_seeds", 0.5);
    const rice = cropAt(w, BASE.x + 5, BASE.y, "rice_seeds", 0.5);
    setSeason(w, 1, w.env(Season).lengthDays - 1); // last day of fall
    G.cropGrowthSystem(w);
    expect(w.get(lettuce, G.Crop)!.growth).toBeCloseTo(0.5, 6); // dormant: no growth
    expect(w.get(rice, G.Crop)!.growth).toBeCloseTo(0.5, 6);
    setSeason(w, 2, 0); // winter: below the 40F frost line
    expect(G.ambientTemperature(w)).toBeLessThan(G.FROST_KILL_C);
    const wildLettuce = G.spawnResourceNode(w, "wild_lettuce", BASE.x + 2, BASE.y + 2);
    const wildRice = G.spawnResourceNode(w, "wild_rice", BASE.x + 4, BASE.y + 2);
    expect(w.get(wildLettuce, G.ResourceNode)!.amount).toBeGreaterThan(0);
    expect(w.get(wildRice, G.ResourceNode)!.amount).toBeGreaterThan(0);
    G.cropGrowthSystem(w);
    expect(w.get(lettuce, G.Crop)!.kind).toBe(0); // planted lettuce dies -> empty tilled soil
    expect(w.get(rice, G.Crop)!.kind).toBe(0); // planted rice dies
    expect(w.get(wildLettuce, G.ResourceNode)!.amount).toBe(0); // wild lettuce dies
    expect(w.get(wildRice, G.ResourceNode)!.amount).toBe(0); // wild rice dies
  });
});

describe("Task 32: new farm animals", () => {
  it("husbandry: pig -> truffle, alpaca -> wool, bee -> honey, rabbit -> wool; all are domestic", () => {
    expect(G.SKILLS.husbandry.animals).toMatchObject({
      animal_pig: { produce: "truffle", seconds: 480 },
      animal_alpaca: { produce: "wool", seconds: 420 },
      animal_bee: { produce: "honey", seconds: 360 },
      animal_rabbit: { produce: "wool", seconds: 480 },
    });
    expect(Object.keys(G.SKILLS.husbandry.animals).length).toBe(11);
    // truffle needs a non-husbandry source too: wild pigs root them out (economy "every item has a
    // gather or craft source" rule — milk/egg/wool/honey all have one; truffle would otherwise have none)
    expect(G.animalDefs().find((a) => a.key === "animal_pig")!.loot.some((l) => l.item === "truffle")).toBe(true);
    const { w, p } = fresh(); husbandry1(w, p);
    for (const kind of ["animal_pig", "animal_alpaca", "animal_bee", "animal_rabbit"] as const) {
      const a = G.spawnAnimal(w, kind, BASE.x + 2, BASE.y);
      expect(G.isDomesticAnimal(w, a)).toBe(true);
      expect(G.livestockTameChance(w, a)).toBeGreaterThan(0);
      // dry-run tame: a domestic animal nearby, with the skill, is tameable (no RNG in dry-run)
      w.set(p, Transform, { x: BASE.x + 2, y: BASE.y + 1 });
      expect(G.feedAnimal(w, p, true)).toMatchObject({ fail: G.TameFail.None, tame: true });
      w.destroy(a);
    }
    // farm skill trees carry the produce nodes (rabbit shares the pet rabbit tree, extended with wool)
    const defs = G.gameplayDefs(w);
    expect(defs.animalSkillTree("animal_pig")!.nodes.map((n) => n.key)).toEqual(["truffle_1", "truffle_2", "quick_1", "fertile_1"]);
    expect(defs.animalSkillTree("animal_pig")!.nodes[0]!.effect).toMatchObject({ type: "produce", value: 1 });
    expect(defs.animalSkillTree("animal_alpaca")!.nodes[0]!.key).toBe("wool_1");
    expect(defs.animalSkillTree("animal_bee")!.nodes[0]!.key).toBe("honey_1");
    const rabbit = defs.animalSkillTree("animal_rabbit")!;
    expect(rabbit.nodes.some((n) => n.key === "wool_1" && n.effect.type === "produce")).toBe(true);
    expect(rabbit.nodes.some((n) => n.key === "wool_2" && n.requires === "wool_1")).toBe(true);
    expect(rabbit.nodes.some((n) => n.key === "swift_1")).toBe(true); // pet nodes kept
  });

  it("a pig can really be tamed with feed and starts with its level-1 skill point", () => {
    const { w, p } = fresh(); husbandry1(w, p);
    const a = G.spawnAnimal(w, "animal_pig", BASE.x + 2, BASE.y);
    w.set(p, Transform, { x: BASE.x + 2, y: BASE.y + 1 });
    G.addItem(w, p, iid("animal_feed"), 10);
    w.setField(p, G.Equipment, "mainHandSlot", 0);
    let tamedOk = false;
    for (let i = 0; i < 20 && !w.has(a, G.Tamed); i++) {
      const at = w.get(a, Transform)!; w.set(p, Transform, { x: at.x, y: at.y + 1 }); // stay in reach if it wanders
      G.feedAnimal(w, p); steps(w, 1); tamedOk = w.has(a, G.Tamed);
    }
    expect(tamedOk).toBe(true);
    expect(w.get(a, G.Tamed)!.owner).toBe(p);
    expect(w.get(a, G.AnimalSkills)).toMatchObject({ level: 1, points: 1, nodes: 0 });
  });

  it("a real placed trough produces truffle, wool and honey from the new farm animals", () => {
    for (const [kind, produce] of [
      ["animal_pig", "truffle"], ["animal_alpaca", "wool"], ["animal_bee", "honey"], ["animal_rabbit", "wool"],
    ] as const) {
      const { w, p } = fresh(); pens(w, p);
      const r = put(w, p, "feeding_trough", BASE.x + 1.5, BASE.y + 0.5, 0, 0, undefined, STAND);
      expect(r.ok).toBe(true);
      const trough = G.resolveAttachment(w, (r as { piece: Entity }).piece, G.AttachKind.Storage)!;
      tamed(w, p, kind, BASE.x + 3, BASE.y + 0.5, { fedUntil: w.tick + 100000, produceAt: 0 });
      G.husbandrySystem(w);
      expect(G.countItem(w, trough, iid(produce))).toBeGreaterThanOrEqual(1);
    }
  });

  it("a hungry pig and a hungry bee eat hay from a real placed trough and are fed for 600s", () => {
    for (const kind of ["animal_pig", "animal_bee"] as const) {
      const { w, p } = fresh();
      const r = put(w, p, "feeding_trough", BASE.x + 1.5, BASE.y + 0.5, 0, 0, undefined, STAND);
      expect(r.ok).toBe(true);
      const trough = G.resolveAttachment(w, (r as { piece: Entity }).piece, G.AttachKind.Storage)!;
      G.addItem(w, trough, iid("hay"), 3);
      const a = tamed(w, p, kind, BASE.x + 3, BASE.y + 0.5, { fedUntil: 0 });
      G.husbandrySystem(w);
      expect(G.countItem(w, trough, iid("hay"))).toBe(2); // one hay eaten
      expect(w.get(a, G.Tamed)!.fedUntil).toBe(w.tick + 12000); // 600s at 20Hz
    }
  });

  it("a hungry alpaca and a hungry rabbit graze grass tiles (20s to feed, tile bare for 180s)", () => {
    for (const kind of ["animal_alpaca", "animal_rabbit"] as const) {
      const { w, p } = fresh(); withTerrain(w);
      const s = grassSpot(w, BASE.x, BASE.y);
      const a = tamed(w, p, kind, s.x, s.y, { fedUntil: 0 });
      G.husbandrySystem(w);
      const g = w.get(a, G.Grazing)!;
      expect(g).toBeDefined();
      expect(g.tx).toBe(Math.floor(s.x)); expect(g.ty).toBe(Math.floor(s.y));
      expect(g.doneTick).toBe(w.tick + 400); // 20s at 20Hz
      w.set(a, G.Grazing, { doneTick: w.tick }); // 20s have passed
      G.husbandrySystem(w);
      expect(w.has(a, G.Grazing)).toBe(false);
      expect(w.get(a, G.Tamed)!.fedUntil).toBe(w.tick + 12000);
      const tiles = [...w.query([G.GrazedTile])];
      expect(tiles.length).toBe(1);
      expect(w.get(tiles[0]!, G.GrazedTile)).toMatchObject({ tx: Math.floor(s.x), ty: Math.floor(s.y), regrowTick: w.tick + 3600 });
    }
  });
});

describe("Task 32: art wiring", () => {
  it("every new animal resolves to a real pack sprite through the fallback chain (no placeholder)", () => {
    // Task 34: owl + bee have their OWN art now (task34 fragment) — no crow reuse, no tint, no scale.
    // Turtle, pig, and alpaca now ship dedicated nature_critters_c sheets (no tinted boar/deer).
    expect(resolveSprite("animal_owl", has)).toMatchObject({ key: "animal_owl", scale: 1 });
    expect(resolveSprite("animal_owl", has)!.tint).toBe(0);
    expect(resolveSprite("animal_turtle", has)).toMatchObject({ key: "animal_turtle", scale: 1 });
    expect(resolveSprite("animal_turtle", has)!.tint).toBe(0);
    expect(resolveSprite("animal_pig", has)).toMatchObject({ key: "animal_pig", scale: 1 });
    expect(resolveSprite("animal_pig", has)!.tint).toBe(0);
    expect(resolveSprite("animal_alpaca", has)).toMatchObject({ key: "animal_alpaca", scale: 1 });
    expect(resolveSprite("animal_alpaca", has)!.tint).toBe(0);
    expect(resolveSprite("animal_bee", has)).toMatchObject({ key: "animal_bee", scale: 1 });
    expect(resolveSprite("animal_bee", has)!.tint).toBe(0);
    // each of these keys now points at its own packed sheet
    for (const kind of ["animal_owl", "animal_turtle", "animal_pig", "animal_alpaca", "animal_bee"]) {
      expect(resolveSprite(kind, has)).toBeDefined();
    }
  });

  it("every new crop and growth stage resolves to a real pack sprite at the stage scales", () => {
    // Dedicated lettuce growth-stage sprites in the nature pack (no carrot_patch, no scaled crop_lettuce stand-in).
    expect(resolveSprite("crop_lettuce_0", has)).toMatchObject({ key: "crop_lettuce_0", scale: 1 });
    expect(resolveSprite("crop_lettuce_3", has)).toMatchObject({ key: "crop_lettuce_3", scale: 1 });
    expect(resolveSprite("wild_lettuce", has)).toMatchObject({ key: "wild_lettuce", scale: 1 });
    expect(resolveSprite("wild_lettuce", has)!.tint).toBe(0);
    expect(resolveSprite("crop_pepper_0", has)).toMatchObject({ key: "crop_pepper_0", scale: 1 });
    expect(resolveSprite("crop_pepper_3", has)).toMatchObject({ key: "crop_pepper_3", scale: 1 });
    expect(resolveSprite("wild_pepper", has)).toMatchObject({ key: "wild_pepper", scale: 1 });
    expect(resolveSprite("crop_beetroot_0", has)).toMatchObject({ key: "crop_beetroot_0", scale: 1 });
    expect(resolveSprite("crop_beetroot_3", has)).toMatchObject({ key: "crop_beetroot_3", scale: 1 });
    expect(resolveSprite("wild_beetroot", has)).toMatchObject({ key: "wild_beetroot", scale: 1 });
    expect(resolveSprite("crop_rice_0", has)).toMatchObject({ key: "crop_rice_0", scale: 1 });
    expect(resolveSprite("crop_rice_3", has)).toMatchObject({ key: "crop_rice_3", scale: 1 });
    expect(resolveSprite("wild_rice", has)).toMatchObject({ key: "wild_rice", scale: 1 });
  });

  it("every new item key is itself a real sprite in the pack (icon resolves to itself, never a generic)", () => {
    for (const [key, category] of [
      ["lettuce", "food"], ["lettuce_seeds", "resource"], ["pepper", "food"], ["pepper_seeds", "resource"],
      ["beetroot", "food"], ["beetroot_seeds", "resource"], ["rice", "food"], ["rice_seeds", "resource"],
      ["truffle", "food"], ["salad", "food"], ["rice_bowl", "food"], ["truffle_stew", "food"],
      ["honey_tea", "food"], ["salt_brew", "food"], ["paint_brush", "tool"],
      ["charcoal_tonic", "food"], ["cooling_brew", "food"], ["medicated_bandage", "food"],
      ["cloth_mask", "clothing"], ["waterskin", "food"],
      ["boiled_water_flask", "food"], ["boiled_canteen", "food"],
      ["boiled_water_bottle", "food"], ["boiled_waterskin", "food"],
    ] as const) {
      expect(has(key), key).toBe(true);
      expect(resolveIcon(key, category, has)).toBe(key);
      expect(resolveSprite(key, has)).toMatchObject({ key, scale: 1 });
    }
  });
});
