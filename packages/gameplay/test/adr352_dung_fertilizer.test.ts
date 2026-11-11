// ADR-352 dung + a longer-lasting fertilizer: every living animal drops Dung a couple of times per
// in-game day (jittered, so a herd never drops in unison); the dung is a pickupable LootBag that
// despawns after 10 s if unpicked; dung crafts into dung_fertilizer, which lasts 900 s (vs 600 s for
// the old fertilizer) at the same 1.5x growth multiplier, through the same fertilize path.
import { describe, expect, it } from "vitest";
import { DEFAULT_TICK_HZ, NetId, setSeason, setTimeOfDay, Transform, Weather, type Entity, type World } from "@engine/core";
import { TileMap } from "@engine/world";
import * as G from "../src/index.js";
import { collect, makeWorld, spawnLearned, steps } from "./helpers.js";

const d = G.defaultDefs();
const id = (k: string): number => d.itemId(k);
const T = (s: number): number => Math.ceil(s * 20);
const DUNG = G.DUNG;
const DAY_TICKS = 3600 * DEFAULT_TICK_HZ; // makeWorld default dayLengthSeconds (environment.json)

/** Farm setup: tilled-soil wheat crop at (11.5, 10.5), player in front of it facing east. */
function farmSetup(): { w: World; p: Entity; c: Entity } {
  const w = makeWorld({ dayLengthTicks: 240_000 }); const map = new TileMap();
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { map.setTile(x, y, 3); map.ensureChunk(0, 0).setHeight(x, y, 2); }
  w.setResource(G.TerrainRes, G.terrainFromTileMap(map)); setSeason(w, 0, 7); setTimeOfDay(w, 12);
  w.env(Weather).kind = G.WeatherKind.Clear;
  const p = G.spawnPlayer(w, { x: 10.5, y: 10.5, clientId: 1 }); w.set(p, Transform, { facing: 0 });
  const c = G.spawnCrop(w, 11.5, 10.5, G.plantableBySeed("wheat_seeds")); return { w, p, c };
}
/** Player holding `item` in main-hand slot 0 (the Use path farmUseSystem reads). */
function holderWith(w: World, p: Entity, item: string, n = 1): void {
  G.addItem(w, p, id(item), n);
  w.set(p, G.Equipment, { mainHandSlot: 0, mainHandItem: id(item) });
}
const useHeld = (w: World, p: Entity): void => { G.setIntent(w, p, { action: G.IntentAction.Use, slot: 0 }); G.farmUseSystem(w); };
/** All dung bags currently on the ground. */
const dungBags = (w: World): Entity[] => [...w.query([G.LootBag, G.Container])]
  .filter((b) => G.listSlots(w, b).some((s) => s.item === id("dung")));
/** Force one animal's timer due, then run the production tick. */
const due = (w: World, a: Entity): void => { w.set(a, G.DungTimer, { nextAt: w.tick }); G.dungSystem(w); };
const jump = (w: World, to: number): void => { w.tick = to; steps(w, 20); };

describe("ADR-352 dung data", () => {
  it("a couple of times per in-game day per animal, jittered; big grazers/mounts a little more often", () => {
    expect(DUNG.perDay).toBe(2);
    expect(DUNG.jitterFraction).toBeGreaterThan(0); expect(DUNG.jitterFraction).toBeLessThanOrEqual(0.5);
    expect(G.dungPerDayFor("animal_chicken")).toBe(2);
    expect(G.dungPerDayFor("animal_cow")).toBe(3);
    expect(G.dungPerDayFor("animal_horse")).toBe(3);
    // one day = 3600 s: a chicken drops about every 1800 s, a cow about every 1200 s
    const w = makeWorld(); const chicken = G.spawnAnimal(w, "animal_chicken", 0, 0); const cow = G.spawnAnimal(w, "animal_cow", 0, 0);
    const base = (k: string): number => DAY_TICKS / G.dungPerDayFor(k);
    for (const [a, k] of [[chicken, "animal_chicken"], [cow, "animal_cow"]] as const) {
      const delay = G.nextDungDelay(w, a, k);
      expect(delay).toBeGreaterThanOrEqual(base(k) * (1 - DUNG.jitterFraction));
      expect(delay).toBeLessThanOrEqual(base(k) * (1 + DUNG.jitterFraction));
    }
  });
  it("a herd seeded on the same tick staggers instead of dropping in unison", () => {
    const w = makeWorld(); const cows = [0, 1, 2, 3, 4].map((i) => G.spawnAnimal(w, "animal_cow", i * 3, 0));
    G.dungSystem(w); // seeds every timer
    const nexts = cows.map((c) => w.getField(c, G.DungTimer, "nextAt")!);
    expect(new Set(nexts).size).toBeGreaterThan(1); // not all identical
    for (const n of nexts) expect(n).toBeGreaterThan(w.tick);
  });
  it("covers farm animals, pets, mounts and wild animals; only the bee is excluded (it flies)", () => {
    const keys = G.dungProducerKeys();
    for (const k of ["animal_chicken", "animal_cow", "animal_pig", "animal_sheep", "animal_goat", "animal_alpaca", "animal_rabbit",
      "animal_dog_lab", "animal_cat_tabby", "animal_fox", "animal_owl", "animal_turtle", "animal_squirrel",
      "animal_horse", "animal_donkey", "animal_deer", "animal_elk", "animal_moose", "animal_bison", "animal_yak",
      "animal_wolf", "animal_boar", "animal_bear", "animal_snake", "animal_crow", "animal_duck", "animal_goose", "animal_turkey"]) expect(keys, k).toContain(k);
    expect(keys).not.toContain("animal_bee");
    expect(keys).toHaveLength(G.animalDefs().length - DUNG.excluded.length);
    expect(DUNG.excluded).toEqual(["animal_bee"]);
  });
  it("dung + dung_fertilizer are real items with ids; the recipe is dung + fiber -> dung fertilizer", () => {
    expect(id("dung")).toBeGreaterThan(0); expect(id("dung_fertilizer")).toBeGreaterThan(0);
    expect(d.itemId("dung")).not.toBe(d.itemId("dung_fertilizer"));
    const r = d.recipes.get(d.recipeId("dung_fertilizer"))!;
    expect(r.key).toBe("dung_fertilizer"); expect(r.station).toBe(G.StationKind.None);
    expect(r.ingredients).toEqual([{ item: id("dung"), count: 2 }, { item: id("fiber"), count: 2 }]);
    expect(r.output).toEqual({ item: id("dung_fertilizer"), count: 2 });
    expect(d.items.get(id("dung"))!.maxStack).toBeGreaterThanOrEqual(30); // stacks like other ground resources
  });
});

describe("ADR-352 dung production (sim)", () => {
  it("every covered species drops dung on schedule; the bee never does", () => {
    const w = makeWorld();
    for (const a of G.animalDefs()) {
      const e = G.spawnAnimal(w, a.key, 0, 0); w.add(e, G.DungTimer, { nextAt: w.tick });
      G.dungSystem(w);
      if (a.key === "animal_bee") expect(dungBags(w)).toHaveLength(0);
      else { expect(dungBags(w), a.key).toHaveLength(1); expect(w.getField(e, G.DungTimer, "nextAt")).toBeGreaterThan(w.tick); }
      for (const b of dungBags(w)) w.destroy(b);
    }
  });
  it("a drop is 1 dung in a LootBag at the animal's feet; production repeats on the stored schedule", () => {
    const w = makeWorld(); const cow = G.spawnAnimal(w, "animal_cow", 5, 5);
    w.add(cow, G.DungTimer, { nextAt: w.tick }); G.dungSystem(w);
    const bags = dungBags(w); expect(bags).toHaveLength(1);
    const t = w.get(bags[0]!, Transform)!; expect(Math.hypot(t.x - 5, t.y - 5)).toBeLessThanOrEqual(DUNG.dropRadius + 0.01);
    expect(G.listSlots(w, bags[0]!).find((s) => s.item === id("dung"))!.count).toBe(DUNG.count);
    expect(G.countItem(w, bags[0]!, id("dung"))).toBe(1);
    // three more scheduled drops, each on the stored nextAt (no backlog, no reset)
    for (let i = 0; i < 3; i++) { due(w, cow); expect(dungBags(w)).toHaveLength(i + 2); }
  });
  it("a dead animal never produces", () => {
    const w = makeWorld(); const cow = G.spawnAnimal(w, "animal_cow", 0, 0);
    w.add(cow, G.Dead, { cause: 0, tick: w.tick }); w.add(cow, G.DungTimer, { nextAt: w.tick });
    G.dungSystem(w); expect(dungBags(w)).toHaveLength(0);
  });
  it("the timer is persistent (survives a save/load round-trip) but not networked", () => {
    expect(G.GAMEPLAY_COMPONENTS).toContain(G.DungTimer);
    expect(G.DungTimer.persistent).toBe(true); expect(G.DungTimer.networked).toBeFalsy();
    expect(G.replicationOf(G.DungTimer)).toBeUndefined();
  });
  it("a saved animal reloads with its dung timer intact (chunk codec)", async () => {
    const { Chunk, encodeChunk, decodeChunk } = await import("@engine/world");
    const w = makeWorld(); const cow = G.spawnAnimal(w, "animal_cow", 1, 1);
    // Tamed (like a mount): the animal itself is rebuilt after a load from the persistent Tamed record,
    // so its DungTimer schedule survives with it. A wild animal round-trips as a Transform-only stray
    // (Animal was never persistent) and its orphaned timer is inert — dungSystem only reads Animals.
    const kind = w.get(cow, G.Animal)!.kind;
    w.add(cow, G.Tamed, { kind, owner: 0, fedUntil: w.tick, produceAt: w.tick, breedAt: w.tick });
    w.add(cow, NetId, { id: 700 }); w.add(cow, G.DungTimer, { nextAt: 123456 });
    const bytes = encodeChunk(new Chunk(0, 0), { world: w, entities: [cow] });
    const w2 = makeWorld(); const [e] = decodeChunk(bytes, { world: w2 }).entities; expect(e).toBeDefined();
    expect(w2.getField(e!, G.DungTimer, "nextAt")).toBe(123456);
    steps(w2, 25); // husbandry restores Animal/AnimState for Tamed animals once a second after a load
    expect(w2.has(e!, G.Animal)).toBe(true);
    expect(w2.getField(e!, G.Animal, "kind")).toBe(kind);
  });
});

describe("ADR-352 dung despawn (10 s, dung only)", () => {
  it("a dung bag lives exactly despawnSeconds and then goes with an expired event", () => {
    expect(DUNG.despawnSeconds).toBe(10);
    const w = makeWorld(); const cow = G.spawnAnimal(w, "animal_cow", 0, 0);
    const gone = collect(w, G.LootBagDespawned);
    const bag = G.dropDung(w, cow)!; const lb = w.get(bag, G.LootBag)!;
    expect(lb.despawnAtTick - lb.spawnTick).toBe(T(DUNG.despawnSeconds));
    expect(lb.kind).toBe(G.LootSource.Animal);
    jump(w, lb.spawnTick + T(DUNG.despawnSeconds) - 40); expect(w.isAlive(bag)).toBe(true);
    jump(w, lb.spawnTick + T(DUNG.despawnSeconds)); expect(w.isAlive(bag)).toBe(false);
    steps(w, 1); expect(gone.map((g) => g.reason)).toEqual(["expired"]);
  });
  it("the 10 s rule is dung-only: a dropped stack still lives its full 3 minutes", () => {
    const w = makeWorld(); const p = G.spawnPlayer(w, { x: 0, y: 0, clientId: 1 });
    const cow = G.spawnAnimal(w, "animal_cow", 0, 0); const dung = G.dropDung(w, cow)!;
    G.addItem(w, p, id("wood"), 5); const stack = G.dropItem(w, p, id("wood"), 5)!;
    const t0 = w.tick;
    jump(w, t0 + T(11)); expect(w.isAlive(dung)).toBe(false); expect(w.isAlive(stack)).toBe(true);
    jump(w, t0 + T(G.DESPAWN.droppedSeconds)); expect(w.isAlive(stack)).toBe(false);
  });
  it("a dung bag visibly decays: part-faded at spawn (10 s left, like any bag 10 s from expiry), fading to the floor", () => {
    const w = makeWorld(); const cow = G.spawnAnimal(w, "animal_cow", 0, 0);
    const bag = G.dropDung(w, cow)!; const lb = w.get(bag, G.LootBag)!;
    // Existing presentation: the fade window is the last 30 s before expiry, so a 10 s bag spawns
    // ~0.44 alpha and decays from there — visibly decaying, not popping, and consistent with every
    // other bag. (A first attempt capped the window at the bag's own lifetime; the gate caught it:
    // apps/server adr238 pins that a shortened-expiry bag fades by remaining time.)
    const atSpawn = G.despawnFadeAlpha(lb, lb.spawnTick);
    expect(atSpawn).toBeGreaterThan(0.25); expect(atSpawn).toBeLessThan(0.6);
    const mid = G.despawnFadeAlpha(lb, lb.spawnTick + T(DUNG.despawnSeconds / 2));
    expect(mid).toBeLessThan(atSpawn); expect(mid).toBeGreaterThanOrEqual(0.25);
    expect(G.despawnFadeAlpha(lb, lb.despawnAtTick)).toBe(0.25);
    // a normal dropped bag is unchanged: full alpha at spawn, still full 10 s in
    const p = G.spawnPlayer(w, { x: 0, y: 0, clientId: 1 }); G.addItem(w, p, id("wood"), 1);
    const stack = G.dropItem(w, p, id("wood"), 1)!; const sl = w.get(stack, G.LootBag)!;
    expect(G.despawnFadeAlpha(sl, sl.spawnTick)).toBe(1);
    expect(G.despawnFadeAlpha(sl, sl.spawnTick + T(10))).toBe(1);
  });
  it("picking dung up in time works: inventory, stacking and weight", () => {
    const w = makeWorld(); const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0 });
    const cow = G.spawnAnimal(w, "animal_cow", 0, 0);
    const b1 = G.dropDung(w, cow)!; const b2 = G.dropDung(w, cow)!;
    expect(G.transferItem(w, b1, p, id("dung"), 1)).toBe(1);
    expect(G.countItem(w, p, id("dung"))).toBe(1); expect(w.isAlive(b1)).toBe(true); // bag empties on its own grace, not instantly
    expect(G.transferItem(w, b2, p, id("dung"), 1)).toBe(1);
    expect(G.countItem(w, p, id("dung"))).toBe(2); // stacks
  });
});

describe("ADR-352 dung fertilizer", () => {
  it("crafts from dung through the real crafting system (2 s, no station)", () => {
    const w = makeWorld(); const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0 });
    G.addItem(w, p, id("dung"), 2); G.addItem(w, p, id("fiber"), 2);
    G.setIntent(w, p, { action: G.IntentAction.Craft, recipe: d.recipeId("dung_fertilizer") });
    w.step(1 / 20); steps(w, 40);
    expect(G.countItem(w, p, id("dung_fertilizer"))).toBe(2);
    expect(G.countItem(w, p, id("dung"))).toBe(0); expect(G.countItem(w, p, id("fiber"))).toBe(0);
  });
  it("lasts longer than the old fertilizer: 900 s vs 600 s, same 1.5x multiplier, old fertilizer untouched", () => {
    expect(G.FARMING.fertilizerSeconds).toBe(600); // unchanged
    expect(G.FARMING.fertilizerMul).toBe(1.5); // unchanged
    expect(G.FARMING.dungFertilizerSeconds).toBe(900);
    expect(G.FARMING.dungFertilizerSeconds).toBeGreaterThan(G.FARMING.fertilizerSeconds);
    const { w, c } = farmSetup(); const t0 = w.tick;
    expect(G.fertilize(w, 11.5, 10.5, G.FARMING.dungFertilizerSeconds)).toBe(true);
    expect(w.get(c, G.Crop)!.fertilized).toBe(1);
    expect(w.get(c, G.Crop)!.fertilizerUntilTick - t0).toBe(T(900));
    // growth boost is the same 1.5x while fertilized (watered, noon sun)
    G.water(w, 11.5, 10.5);
    expect(G.growthMul(w, { waterUntilTick: w.tick + 1000, fertilized: 1 }, 11.5, 10.5)).toBe(1.5);
  });
  it("the old fertilizer still gives exactly a 600 s dose", () => {
    const { w, c } = farmSetup(); const t0 = w.tick;
    expect(G.fertilize(w, 11.5, 10.5)).toBe(true);
    expect(w.get(c, G.Crop)!.fertilizerUntilTick - t0).toBe(T(600));
  });
  it("Use with dung fertilizer in hand fertilizes through farmUseSystem and consumes one (prompt agrees)", () => {
    const { w, p, c } = farmSetup(); holderWith(w, p, "dung_fertilizer", 2);
    expect(G.farmPrompt(w, p)).toMatchObject({ action: "Fertilize", fail: 0 });
    useHeld(w, p);
    expect(w.get(c, G.Crop)!.fertilized).toBe(1);
    expect(w.get(c, G.Crop)!.fertilizerUntilTick - w.tick).toBe(T(900));
    expect(G.countItem(w, p, id("dung_fertilizer"))).toBe(1);
    // already fertilized: a second Use does nothing and consumes nothing
    useHeld(w, p); expect(G.countItem(w, p, id("dung_fertilizer"))).toBe(1);
    // ...but the old fertilizer's prompt still works the same way
    const { w: w2, p: p2, c: c2 } = farmSetup(); holderWith(w2, p2, "fertilizer", 1);
    expect(G.farmPrompt(w2, p2)).toMatchObject({ action: "Fertilize", fail: 0 });
    useHeld(w2, p2); expect(w2.get(c2, G.Crop)!.fertilizerUntilTick - w2.tick).toBe(T(600));
  });
  it("a dung-fertilized dose drains and expires like the old one, then can be reapplied", () => {
    const { w, c } = farmSetup();
    G.fertilize(w, 11.5, 10.5, G.FARMING.dungFertilizerSeconds);
    w.tick += T(900); G.cropGrowthSystem(w);
    expect(w.get(c, G.Crop)!.fertilized).toBe(0);
    expect(G.fertilize(w, 11.5, 10.5, G.FARMING.dungFertilizerSeconds)).toBe(true);
  });
  it("dung fertilizer is in the net-visible item set (ids lock) and needs no new sprite key", () => {
    // No new art: the dung bag draws the generic LootBag sprite and the items fall back to the
    // category generic icon (resolveIcon), exactly like other items without a dedicated icon.
    expect(G.resolveIcon("dung", "resource", (k) => k === "fiber")).toBe("fiber");
    expect(G.resolveIcon("dung_fertilizer", "resource", (k) => k === "fiber")).toBe("fiber");
    expect(G.iconForItem(d.items.get(id("dung"))!, (k) => k === "fiber")).toBe("fiber");
  });
});
