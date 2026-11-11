/**
 * ADR-353: animals eat more crops and use the trough.
 * - Every mount species keeps its taming foods (love/like/ok) exactly, and gains a wider hunger `diet` in
 *   mounts.json (taming never accepts a diet-only crop); farm animals gain a diet in skills.json, pets gain
 *   crops in pets.json diets (carnivores unchanged).
 * - A hungry farm animal eats one diet item from its owner's feeding trough (fed 600s, the old hay window);
 *   a hungry mount does the same (fed 600s + feedHeal), and while hungry it does not regen — it never loses
 *   hp to hunger. Pets eat diet crops from their pet trough through the existing auto-eat path.
 * - Trough ownership is respected: owner's, clan-mate's (same tribe) or unowned — never a stranger's.
 * - Empty / wrong-food troughs fall back to grazing (farm animals) as before; a fed animal never double-dips.
 */
import { describe, expect, it } from "vitest";
import { NetId, PlayerId, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { collect, DT, ensureClaim, makeWorld, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
const iid = (k: string) => d.itemId(k);
const pid = (k: string) => d.pieceId(k);
const BASE = { x: 10, y: 10 };
const STAND = { x: BASE.x + G.BUILD_STAND.x, y: BASE.y + G.BUILD_STAND.y };
const setPid = (w: World, e: Entity, id: number): void => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); };
function fresh(): { w: World; p: Entity } {
  const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = spawnLearned(w, { x: BASE.x + 1, y: BASE.y + 3.3, maxWeight: 0, clientId: 1 }); setPid(w, p, 7);
  steps(w, 1); ensureClaim(w, p, BASE.x + 4, BASE.y + 4); return { w, p };
}
const give = (w: World, e: Entity, key: string, tier = 0): void => { const def = d.pieces.get(pid(key))!; for (const c of G.pieceCost(d, def, def.tiered ? tier : def.fixedTier)) G.addItem(w, e, c.item, c.count); };
const put = (w: World, e: Entity, key: string, x: number, y: number, level = 0, rot = 0, tier?: number, stand?: { x: number; y: number }) => {
  ensureClaim(w, e, x - 2, y + 2);
  const def = d.pieces.get(pid(key))!; const t = tier ?? (def.tiered ? 0 : def.fixedTier); give(w, e, key, t);
  w.set(e, Transform, stand ?? { x, y: y + 1.2 });
  return G.tryPlace(w, e, { piece: pid(key), x, y, level, rot, tier: t, variant: 0 });
};
/** A tamed farm animal; fedUntil/produceAt default far in the future (fed, not producing) unless overridden. */
const farmAnimal = (w: World, owner: Entity, kindKey: string, x: number, y: number, over: Partial<{ fedUntil: number; produceAt: number }> = {}): Entity => {
  const a = G.spawnAnimal(w, kindKey, x, y); const kind = w.get(a, G.Animal)!.kind;
  w.add(a, G.Tamed, { kind, owner, fedUntil: over.fedUntil ?? w.tick + 100000, produceAt: over.produceAt ?? w.tick + 100000, breedAt: w.tick + 100000 });
  return a;
};
/** Install a TerrainRes stub (the server installs the real one over ChunkManager; test worlds have none):
 *  tiles (10..21, 10..21) are grass, everything else dirt — so grazing tests can pin the grass-tile rule. */
const withTerrain = (w: World): void => {
  w.setResource(G.TerrainRes, {
    tileAt: (tx: number, ty: number) => (tx >= 10 && tx < 22 && ty >= 10 && ty < 22 ? G.GRASS_TILE : 4),
    heightAt: () => 0,
  });
};
/** A grass tile (tile 3) near (x, y) for grazing tests. */
const grassSpot = (w: World, x: number, y: number): { x: number; y: number } => {
  const terrain = w.getResource(G.TerrainRes)!;
  for (let dx = 0; dx < 12; dx++) for (let dy = 0; dy < 12; dy++) if (terrain.tileAt(x + dx, y + dy) === G.GRASS_TILE) return { x: x + dx + 0.5, y: y + dy + 0.5 };
  throw new Error("no grass tile near the base");
};
/** A synthetic feeding trough (piece + Container on the piece, like pets.test.ts's pet trough): owner/tribe set explicitly. */
const synthTrough = (w: World, x: number, y: number, owner: number, tribe = 0): Entity => {
  const tr = w.create();
  w.add(tr, Transform, { x, y }).add(tr, G.BuildPiece, { type: pid("feeding_trough") }).add(tr, G.Container, { slotCount: 8 })
    .add(tr, G.PieceOwner, { player: owner });
  if (tribe) w.add(tr, G.Tribe, { id: tribe });
  G.indexEntity(w, tr); return tr;
};
/** A synthetic pet trough (pet_trough piece + Container + TroughOwner), like pets.test.ts. */
const synthPetTrough = (w: World, x: number, y: number, owner: number): Entity => {
  const tr = w.create();
  w.add(tr, Transform, { x, y }).add(tr, G.BuildPiece, { type: pid("pet_trough") }).add(tr, G.Container, { slotCount: 8 }).add(tr, G.TroughOwner, { player: owner });
  G.indexEntity(w, tr); return tr;
};
const net = (w: World, e: Entity, id: number): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id }); return e; };
/** Tame a wild pet-species animal by offering treats until it is a Pet. */
const tamePet = (w: World, p: Entity, a: Entity, item: number): void => {
  G.addItem(w, p, item, 50);
  for (let i = 0; i < 40 && !w.has(a, G.Pet); i++) { G.offerTreat(w, p, a, item); w.step(1 / 20); }
};

describe("ADR-353 diet data: wider hunger diets, taming untouched", () => {
  it("mounts: every species has a diet wider than its taming foods; the taming table is byte-for-byte unchanged", () => {
    const taming: Record<string, Record<string, string>> = {
      horse: { carrot: "love", apple: "love", hay: "like", wheat: "like", berries: "ok" },
      donkey: { carrot: "love", hay: "love", apple: "like", wheat: "like", berries: "ok" },
      deer: { apple: "love", berries: "love", carrot: "like", wheat: "ok" },
      elk: { apple: "love", hay: "like", berries: "like", wheat: "ok" },
      moose: { apple: "love", berries: "like", hay: "like", wheat: "ok" },
      buffalo: { hay: "love", wheat: "love", carrot: "like", apple: "ok" },
      yak: { hay: "love", wheat: "like", berries: "like", carrot: "ok" },
    };
    for (const s of G.MOUNT_SPECIES) {
      expect(s.foods).toEqual(taming[s.key]); // taming must not change
      const diet = G.mountDiet(G.mountSpeciesOfKey(s.key));
      expect(diet.length).toBeGreaterThan(Object.keys(s.foods).length);
      expect(diet.some((k) => !(k in s.foods))).toBe(true); // a non-taming crop is on the diet
      for (const k of diet) expect(() => d.itemId(k), `${s.key} diet ${k}`).not.toThrow(); // every diet item exists
      expect(G.foodPref(G.mountSpeciesOfKey(s.key), "corn")).toBeUndefined(); // corn tames nothing…
      expect(G.mountEats(G.mountSpeciesOfKey(s.key), "corn")).toBe(true); // …but every mount eats it hungry
    }
  });
  it("farm animals: every husbandry kind has a diet; all items exist; the bee keeps hay only", () => {
    for (const [kind, row] of Object.entries(G.SKILLS.husbandry.animals)) {
      const diet = G.farmAnimalDiet(kind);
      expect(diet.length, kind).toBeGreaterThan(0);
      for (const k of diet) expect(() => d.itemId(k), `${kind} diet ${k}`).not.toThrow();
    }
    expect(G.farmAnimalDiet("animal_bee")).toEqual(["hay"]); // bees ate hay before; nothing else changes for them
    expect(G.farmAnimalDiet("animal_cow")).toContain("corn");
    expect(G.farmAnimalDiet("animal_pig")).toContain("potato");
    expect(G.farmAnimalDiet("animal_chicken")).toContain("wheat");
    expect(G.farmAnimalDiet("animal_rabbit")).toContain("carrot");
  });
  it("pets: dogs and omnivores gain crops; carnivores do not; treats are untouched", () => {
    for (const s of G.PET_SPECIES) for (const k of s.diet) expect(() => d.itemId(k), `${s.key} diet ${k}`).not.toThrow();
    const dog = G.petSpeciesOfKey("dog_lab"), cat = G.petSpeciesOfKey("cat_tabby");
    expect(G.petFoodValue(dog, "carrot")).toBe(G.PET_TUNING.foodFullness); // a dog eats a carrot now
    expect(G.petFoodValue(dog, "pumpkin")).toBe(G.PET_TUNING.foodFullness);
    expect(G.petFoodValue(cat, "carrot")).toBe(0); // a cat still refuses crops
    expect(G.petFoodValue(cat, "raw_meat")).toBe(G.PET_TUNING.foodFullness);
    expect(G.petFoodValue(dog, "dog_biscuit")).toBe(G.PET_TUNING.treatFullness); // treats unchanged
    expect(G.petFoodValue(G.petSpeciesOfKey("rabbit"), "lettuce")).toBe(G.PET_TUNING.foodFullness);
    expect(G.petFoodValue(G.petSpeciesOfKey("turtle"), "beetroot")).toBe(G.PET_TUNING.foodFullness);
  });
  it("tuning knobs live in data and the hunger windows are unchanged (600s farm + mount, 4/min pet)", () => {
    expect(G.MOUNT_TUNING.fedSeconds).toBe(600); expect(G.MOUNT_TUNING.troughRange).toBe(10);
    expect(G.SKILLS.husbandry.fedSeconds).toBe(600); expect(G.SKILLS.husbandry.troughRange).toBe(10);
    expect(G.PET_TUNING.hungerPerMinute).toBe(4); expect(G.PET_TUNING.eatBelow).toBe(60);
  });
});

describe("ADR-353 farm animals eat from the trough", () => {
  it("a hungry cow eats 1 corn (not a taming item — farm taming uses animal_feed) and is fed for 600s", () => {
    const { w, p } = fresh();
    const r = put(w, p, "feeding_trough", BASE.x + 1.5, BASE.y + 0.5, 0, 0, undefined, STAND);
    expect(r.ok).toBe(true);
    const trough = G.resolveAttachment(w, (r as { piece: Entity }).piece, G.AttachKind.Storage)!;
    expect(G.troughOwnerId(w, trough)).toBe(7); // the placed trough belongs to the placer
    G.addItem(w, trough, iid("corn"), 3);
    const c = farmAnimal(w, p, "animal_cow", BASE.x + 3, BASE.y + 0.5, { fedUntil: 0 });
    G.husbandrySystem(w);
    expect(G.countItem(w, trough, iid("corn"))).toBe(2); // one corn eaten
    expect(w.get(c, G.Tamed)!.fedUntil).toBe(w.tick + 12000); // 600s at 20Hz, same window as hay
  });
  it("hay still feeds (the old path is the diet's head)", () => {
    const { w, p } = fresh();
    const r = put(w, p, "feeding_trough", BASE.x + 1.5, BASE.y + 0.5, 0, 0, undefined, STAND);
    const trough = G.resolveAttachment(w, (r as { piece: Entity }).piece, G.AttachKind.Storage)!;
    G.addItem(w, trough, iid("hay"), 3);
    const c = farmAnimal(w, p, "animal_cow", BASE.x + 3, BASE.y + 0.5, { fedUntil: 0 });
    G.husbandrySystem(w);
    expect(G.countItem(w, trough, iid("hay"))).toBe(2);
    expect(w.get(c, G.Tamed)!.fedUntil).toBe(w.tick + 12000);
  });
  it("every farm kind eats a non-hay diet item from its owner's trough", () => {
    const food: Record<string, string> = {
      animal_chicken: "wheat", animal_duck: "wheat", animal_goose: "wheat", animal_turkey: "wheat",
      animal_cow: "corn", animal_goat: "corn", animal_sheep: "corn", animal_pig: "potato",
      animal_alpaca: "corn", animal_bee: "hay", animal_rabbit: "carrot",
    };
    for (const [kind, item] of Object.entries(food)) {
      const { w, p } = fresh();
      const r = put(w, p, "feeding_trough", BASE.x + 1.5, BASE.y + 0.5, 0, 0, undefined, STAND);
      const trough = G.resolveAttachment(w, (r as { piece: Entity }).piece, G.AttachKind.Storage)!;
      G.addItem(w, trough, iid(item), 3);
      const a = farmAnimal(w, p, kind, BASE.x + 3, BASE.y + 0.5, { fedUntil: 0 });
      G.husbandrySystem(w);
      expect(G.countItem(w, trough, iid(item)), kind).toBe(2);
      expect(w.get(a, G.Tamed)!.fedUntil, kind).toBe(w.tick + 12000);
    }
  });
  it("an empty trough falls back to grazing (no trough meal, a graze starts)", () => {
    const { w, p } = fresh(); withTerrain(w);
    const r = put(w, p, "feeding_trough", BASE.x + 1.5, BASE.y + 0.5, 0, 0, undefined, STAND);
    expect(r.ok).toBe(true);
    const s = grassSpot(w, BASE.x, BASE.y);
    const c = farmAnimal(w, p, "animal_cow", s.x, s.y, { fedUntil: 0 });
    G.husbandrySystem(w);
    const g = w.get(c, G.Grazing)!; expect(g).toBeDefined(); expect(g.doneTick).toBe(w.tick + 400); // 20s
  });
  it("a trough with only the wrong food is not eaten from — the animal grazes instead", () => {
    const { w, p } = fresh(); withTerrain(w);
    const r = put(w, p, "feeding_trough", BASE.x + 1.5, BASE.y + 0.5, 0, 0, undefined, STAND);
    const trough = G.resolveAttachment(w, (r as { piece: Entity }).piece, G.AttachKind.Storage)!;
    G.addItem(w, trough, iid("raw_meat"), 3); // no farm diet includes raw meat
    const s = grassSpot(w, BASE.x, BASE.y);
    const c = farmAnimal(w, p, "animal_cow", s.x, s.y, { fedUntil: 0 });
    G.husbandrySystem(w);
    expect(G.countItem(w, trough, iid("raw_meat"))).toBe(3); // untouched
    expect(w.get(c, G.Grazing)).toBeDefined(); // fell back to grazing
  });
  it("a stranger's trough is never eaten from — the animal grazes instead", () => {
    const { w, p } = fresh(); withTerrain(w);
    const trough = synthTrough(w, BASE.x + 1.5, BASE.y + 0.5, 999); // owned by someone else
    G.addItem(w, trough, iid("corn"), 3);
    const s = grassSpot(w, BASE.x, BASE.y);
    const c = farmAnimal(w, p, "animal_cow", s.x, s.y, { fedUntil: 0 });
    G.husbandrySystem(w);
    expect(G.countItem(w, trough, iid("corn"))).toBe(3); // untouched
    expect(w.get(c, G.Tamed)!.fedUntil).toBe(0); // still hungry
    expect(w.get(c, G.Grazing)).toBeDefined(); // grazes instead — a stranger's trough does not block grazing
  });
  it("no double-dip: trough food + grass -> exactly one item eaten, fed, and no graze starts", () => {
    const { w, p } = fresh(); withTerrain(w);
    const r = put(w, p, "feeding_trough", BASE.x + 1.5, BASE.y + 0.5, 0, 0, undefined, STAND);
    const trough = G.resolveAttachment(w, (r as { piece: Entity }).piece, G.AttachKind.Storage)!;
    G.addItem(w, trough, iid("corn"), 3);
    const s = grassSpot(w, BASE.x, BASE.y);
    const c = farmAnimal(w, p, "animal_cow", s.x, s.y, { fedUntil: 0 });
    G.husbandrySystem(w);
    expect(G.countItem(w, trough, iid("corn"))).toBe(2);
    expect(w.get(c, G.Tamed)!.fedUntil).toBe(w.tick + 12000);
    expect(w.has(c, G.Grazing)).toBe(false);
    G.husbandrySystem(w); // a fed animal does not eat again
    expect(G.countItem(w, trough, iid("corn"))).toBe(2);
  });
});

describe("ADR-353 mounts eat from the trough", () => {
  it("every mount species eats corn (a non-taming crop) from its owner's trough when hungry", () => {
    const animals: Record<string, string> = {
      horse: "animal_horse", donkey: "animal_donkey", deer: "animal_deer", elk: "animal_elk",
      moose: "animal_moose", buffalo: "animal_bison", yak: "animal_yak",
    };
    for (const [species, animal] of Object.entries(animals)) {
      const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
      const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); setPid(w, p, 7);
      const m = G.makeMount(w, animal, 0, 0, p);
      const trough = synthTrough(w, 1, 0, 7);
      G.addItem(w, trough, iid("corn"), 3);
      steps(w, 1); // tick 1: a fedUntil of 0 is hungry from here (tick 0 itself counts as fed, like Tamed.fedUntil)
      w.set(m, G.MountHunger, { fedUntil: 0 }); // hungry
      G.mountSystem(w, DT);
      expect(G.countItem(w, trough, iid("corn")), species).toBe(2);
      expect(w.getField(m, G.MountHunger, "fedUntil"), species).toBeGreaterThan(w.tick);
      expect(G.mountHungry(w, m)).toBe(false);
    }
  });
  it("a trough meal heals feedHeal, like a hand-feed", () => {
    const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
    const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); setPid(w, p, 7);
    const m = G.makeMount(w, "animal_horse", 0, 0, p);
    const trough = synthTrough(w, 1, 0, 7);
    G.addItem(w, trough, iid("corn"), 3);
    steps(w, 1); // tick 1: a fedUntil of 0 is hungry from here (tick 0 itself counts as fed, like Tamed.fedUntil)
    w.set(m, G.Health, { hp: 50 }); w.set(m, G.MountHunger, { fedUntil: 0 });
    G.mountSystem(w, DT);
    expect(G.countItem(w, trough, iid("corn"))).toBe(2);
    expect(w.get(m, G.Health)!.hp).toBe(50 + G.MOUNT_TUNING.feedHeal);
    expect(w.get(m, G.Mount)!.hp).toBe(50 + G.MOUNT_TUNING.feedHeal); // mirrored onto the mount
  });
  it("a hungry mount does not regen; a fed mount does (same regen rate, only gated on hunger)", () => {
    const run = (hungry: boolean): number => {
      const w = makeWorld();
      const m = G.makeMount(w, "animal_horse", 0, 0, 0);
      w.set(m, G.Health, { hp: 50 });
      w.set(m, G.MountHunger, { fedUntil: hungry ? 0 : w.tick + 100000 });
      steps(w, 1); // tick 1: a fedUntil of 0 is hungry from here (tick 0 itself counts as fed, like Tamed.fedUntil)
      w.set(m, G.Health, { hp: 50 }); // re-pin after that first tick's regen, if any
      steps(w, 1200); // 60 s
      return w.get(m, G.Health)!.hp;
    };
    expect(run(true)).toBe(50); // hungry: no regen, and no hp lost to hunger either
    expect(run(false)).toBeCloseTo(50 + G.MOUNT_TUNING.regenPerMinute, 1); // fed: the usual 6 hp/min (f32 storage: ±0.05 over 1200 ticks)
  });
  it("a stranger's trough is never eaten from; a clan-mate's trough is", () => {
    const run = (troughOwner: number, troughTribe: number, mountTribe: number): { corn: number; hungry: boolean } => {
      const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
      const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); setPid(w, p, 7);
      if (mountTribe) w.add(p, G.Tribe, { id: mountTribe });
      const m = G.makeMount(w, "animal_horse", 0, 0, p);
      const trough = synthTrough(w, 1, 0, troughOwner, troughTribe);
      G.addItem(w, trough, iid("corn"), 3);
      steps(w, 1); // tick 1: a fedUntil of 0 is hungry from here (tick 0 itself counts as fed, like Tamed.fedUntil)
      w.set(m, G.MountHunger, { fedUntil: 0 });
      G.mountSystem(w, DT);
      return { corn: G.countItem(w, trough, iid("corn")), hungry: G.mountHungry(w, m) };
    };
    expect(run(999, 0, 0)).toEqual({ corn: 3, hungry: true }); // stranger's trough: untouched, still hungry
    expect(run(999, 3, 3)).toEqual({ corn: 2, hungry: false }); // clan-mate's trough (same tribe): eats
    expect(run(0, 0, 0)).toEqual({ corn: 2, hungry: false }); // unowned trough: eats
  });
  it("a ridden mount does not trough-eat (the rider steers; they hand-feed)", () => {
    const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
    const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); setPid(w, p, 7); net(w, p, 700);
    const m = G.makeMount(w, "animal_elk", 1, 0, p); net(w, m, 701);
    expect(G.rideMount(w, p, m)).toBe(true);
    const trough = synthTrough(w, 1, 0, 7);
    G.addItem(w, trough, iid("corn"), 3);
    w.set(m, G.MountHunger, { fedUntil: 0 });
    steps(w, 5);
    expect(G.countItem(w, trough, iid("corn"))).toBe(3);
    expect(G.mountHungry(w, m)).toBe(true);
  });
  it("taming is unchanged: a diet-only crop is refused for taming, a love food still tames — and hand-feeding a tamed mount feeds it", () => {
    const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
    const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); setPid(w, p, 7);
    const wild = G.spawnAnimal(w, "animal_horse", 1, 0);
    G.addItem(w, p, iid("corn"), 5); G.addItem(w, p, iid("carrot"), 60);
    expect(G.checkFeed(w, p, wild, iid("corn"))).toBe("not_food");
    expect(G.feedMount(w, p, wild, iid("corn"))).toBeUndefined();
    expect(G.countItem(w, p, iid("corn"))).toBe(5); // refused food is kept
    expect(G.checkFeed(w, p, wild, iid("carrot"))).toBeUndefined();
    G.feedMount(w, p, wild, iid("carrot"));
    expect(w.get(wild, G.MountTaming)!.progress).toBeGreaterThan(0);
    // hand-feeding an owned mount heals and feeds it
    const m = G.makeMount(w, "animal_horse", 1, 0, p);
    w.set(m, G.Health, { hp: 50 }); w.set(m, G.MountHunger, { fedUntil: 0 });
    expect(G.feedMount(w, p, m, iid("carrot"))).toBe(G.MountResult.Fed);
    expect(w.get(m, G.Health)!.hp).toBeGreaterThan(50);
    expect(G.mountHungry(w, m)).toBe(false);
  });
  it("MountHunger is persistent (survives a save/load round-trip) but not networked", async () => {
    expect(G.GAMEPLAY_COMPONENTS).toContain(G.MountHunger);
    expect(G.MountHunger.persistent).toBe(true); expect(G.MountHunger.networked).toBeFalsy();
    expect(G.replicationOf(G.MountHunger)).toBeUndefined();
    const { Chunk, encodeChunk, decodeChunk } = await import("@engine/world");
    const w = makeWorld(); const m = G.makeMount(w, "animal_horse", 1, 1, 0);
    w.add(m, NetId, { id: 701 }); w.set(m, G.MountHunger, { fedUntil: 123456 });
    const bytes = encodeChunk(new Chunk(0, 0), { world: w, entities: [m] });
    const w2 = makeWorld(); const [e] = decodeChunk(bytes, { world: w2 }).entities; expect(e).toBeDefined();
    expect(w2.getField(e!, G.MountHunger, "fedUntil")).toBe(123456);
  });
});

describe("ADR-353 pets eat more crops from the trough", () => {
  it("a hungry dog eats a carrot from its owner's pet trough (source 2) and gains fullness", () => {
    const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
    const p = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }); setPid(w, p, 7);
    const a = G.spawnAnimal(w, "animal_dog_lab", 1, 0); tamePet(w, p, a, d.itemId("dog_biscuit"));
    expect(w.has(a, G.Pet)).toBe(true);
    const ate = collect(w, G.PetAte);
    G.setPetCommand(w, p, a, 1); // Stay: holds its post while it eats
    const t = w.get(a, Transform)!;
    const tr = synthPetTrough(w, t.x + 3, t.y, 7);
    G.addItem(w, tr, iid("carrot"), 2);
    w.setField(a, G.Pet, "fullness", 10);
    steps(w, 60); // 3 s: the pet walks over and eats once (the next meal is 4 s away, so exactly 1 carrot goes)
    expect(ate.some((e) => e.source === 2)).toBe(true); // ate from the trough
    expect(G.countItem(w, tr, iid("carrot"))).toBe(1);
    expect(w.getField(a, G.Pet, "fullness")!).toBeCloseTo(10 + G.PET_TUNING.foodFullness, 0); // +25, minus the small drain while walking over
  });
  it("hand-feeding a dog a carrot works now (diet widening reaches the hand path too)", () => {
    const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
    const p = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }); setPid(w, p, 7);
    const a = G.spawnAnimal(w, "animal_dog_lab", 1, 0); tamePet(w, p, a, d.itemId("dog_biscuit"));
    G.addItem(w, p, iid("carrot"), 1);
    w.setField(a, G.Pet, "fullness", 50);
    expect(G.offerTreat(w, p, a, iid("carrot")).result).toBe(G.PetResult.Fed);
    expect(w.getField(a, G.Pet, "fullness")).toBe(50 + G.PET_TUNING.foodFullness);
  });
  it("a pet trough holding only non-food is not eaten from", () => {
    const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
    const p = G.spawnPlayer(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }); setPid(w, p, 7);
    const a = G.spawnAnimal(w, "animal_dog_lab", 1, 0); tamePet(w, p, a, d.itemId("dog_biscuit"));
    const ate = collect(w, G.PetAte);
    G.setPetCommand(w, p, a, 1);
    const t = w.get(a, Transform)!;
    const tr = synthPetTrough(w, t.x + 3, t.y, 7);
    G.addItem(w, tr, iid("planks"), 2);
    w.setField(a, G.Pet, "fullness", 10);
    steps(w, 100);
    expect(ate.length).toBe(0);
    expect(G.countItem(w, tr, iid("planks"))).toBe(2);
  });
});
