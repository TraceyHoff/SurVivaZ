/**
 * Task 28 additions: hay crop + trough feeding, grazing, seasonal crop death.
 * Pinned numbers: hay grows 300s (4 stages) -> crop_hay (hay 2-3 + hay_seeds 1-2 @0.6); wild_hay (hay 1-2 +
 * hay_seeds 1 @0.4) is the first-seed source; 1 hay in a trough feeds one animal for 600s; grazing takes 20s and
 * depletes the grass tile for 180s before it regrows; growth pauses in the final 3 days of fall + all winter;
 * below 40F ambient outdoor crops/plants die (ordinary trees + berry bushes survive, fruit trees die).
 */
import { describe, expect, it } from "vitest";
import { installPermissions, PlayerId, seasonAt, setSeason, Transform, type Entity, type World } from "@engine/core";
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
/** A tamed cow; fedUntil/produceAt default far in the future (fed, not producing) unless overridden. */
const cow = (w: World, owner: Entity, x: number, y: number, over: Partial<{ fedUntil: number; produceAt: number }> = {}): Entity => {
  const a = G.spawnAnimal(w, "animal_cow", x, y); const kind = w.get(a, G.Animal)!.kind;
  w.add(a, G.Tamed, { kind, owner, fedUntil: over.fedUntil ?? w.tick + 100000, produceAt: over.produceAt ?? w.tick + 100000, breedAt: w.tick + 100000 });
  return a;
};
/** Grant the player Husbandry 2 ("pens") so trough production is not gated by canUsePens (ADR-234 pattern). */
const pens = (w: World, p: Entity): void => {
  for (const k of G.TREE_KEYS) G.grantTreePoints(w, p, k, 5000 - G.treePoints(w, p, k));
  const unlock = (i: number): void => { for (const r of G.SKILL_REQS[i]!) unlock(r); const why = G.unlockSkill(w, p, i); if (why) throw new Error(`unlock ${G.SKILLS.nodes[i]!.key}: ${why}`); };
  unlock(G.SKILLS.nodes.findIndex((n) => n.key === "husbandry_pens"));
};
/** A grass tile (tile 3) near (x, y) for grazing tests. */
const grassSpot = (w: World, x: number, y: number): { x: number; y: number } => {
  const terrain = w.getResource(G.TerrainRes)!;
  for (let dx = 0; dx < 12; dx++) for (let dy = 0; dy < 12; dy++) if (terrain.tileAt(x + dx, y + dy) === G.GRASS_TILE) return { x: x + dx + 0.5, y: y + dy + 0.5 };
  throw new Error("no grass tile near the base");
};
/** Install a TerrainRes stub (the server installs the real one over ChunkManager; test worlds have none):
 *  tiles (10..21, 10..21) are grass, everything else dirt — so grazing tests can pin the grass-tile rule. */
const withTerrain = (w: World): void => {
  w.setResource(G.TerrainRes, {
    tileAt: (tx: number, ty: number) => (tx >= 10 && tx < 22 && ty >= 10 && ty < 22 ? G.GRASS_TILE : 4),
    heightAt: () => 0,
  });
};
/** Till the first free spot near the base; returns the tilled soil's position. */
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

describe("Task 28: hay crop", () => {
  it("hay data: ids, plantable (300s, 4 stages, crop), yields, and wheat-style art fallbacks", () => {
    expect(ids.items.hay_seeds).toBe(476); expect(ids.items.hay).toBe(477);
    expect(ids.resources.crop_hay).toBe(85); expect(ids.resources.wild_hay).toBe(86);
    expect(d.itemId("hay_seeds")).toBe(476); expect(d.itemId("hay")).toBe(477);
    expect(d.resourceId("crop_hay")).toBe(85); expect(d.resourceId("wild_hay")).toBe(86);
    expect(G.plantableBySeed("hay_seeds")).toBe(36);
    const p = G.plantableOf(36)!;
    expect(p).toMatchObject({ seed: "hay_seeds", key: "hay", type: "crop", growSeconds: 300, stages: 4, becomes: "crop_hay", tiles: [3, 4], wild: ["wild_hay"] });
    // hay is animal feed only — not human food
    expect(d.items.get(iid("hay"))!.food).toBeFalsy();
    const crop = d.resources.get(d.resourceId("crop_hay"))!;
    expect(crop).toMatchObject({ capacity: 1, respawnSeconds: 600, oneShot: true });
    expect(crop.yields).toEqual([{ item: iid("hay"), min: 2, max: 3, chance: 1 }, { item: iid("hay_seeds"), min: 1, max: 2, chance: 0.6 }]);
    const wild = d.resources.get(d.resourceId("wild_hay"))!;
    expect(wild).toMatchObject({ capacity: 2, respawnSeconds: 240 });
    expect(wild.yields).toEqual([{ item: iid("hay"), min: 1, max: 2, chance: 1 }, { item: iid("hay_seeds"), min: 1, max: 1, chance: 0.4 }]);
    // art: dedicated nature-pack hay sprites — no wheat reuse
    const has = (k: string): boolean =>
      k === "wild_hay" || k === "crop_hay" || k === "crop_hay_0" || k === "crop_hay_3"
      || k === "hay" || k === "hay_seeds" || k === "fiber_grass" || k === "flax";
    expect(resolveSprite("crop_hay_0", has)).toMatchObject({ key: "crop_hay_0", scale: 1 });
    expect(resolveSprite("crop_hay_3", has)).toMatchObject({ key: "crop_hay_3", scale: 1 });
    expect(resolveSprite("wild_hay", has)).toMatchObject({ key: "wild_hay", scale: 1 });
    expect(resolveIcon("hay", "resource", has)).toBe("hay");
    expect(resolveIcon("hay_seeds", "resource", has)).toBe("hay_seeds");
    // emergency fallback (no dedicated art) must NOT resolve to wheat
    const emergency = (k: string): boolean => k === "fiber_grass" || k === "flax" || k === "bush" || k === "wild_wheat";
    expect(resolveSprite("wild_hay", emergency)!.key).not.toBe("wild_wheat");
    expect(resolveSprite("crop_hay", emergency)!.key).not.toBe("wild_wheat");
  });

  it("hay plants, grows at the 300s rate, matures into crop_hay, and harvest returns hay + its own seeds", () => {
    const { w, p } = fresh(); setSeason(w, 0, 0); // summer: growing season, above the frost line
    G.addItem(w, p, iid("hoe"), 1); G.addItem(w, p, iid("hay_seeds"), 5); G.addItem(w, p, iid("watering_can"), 1);
    const spot = tillSpot(w, p);
    expect(G.plant(w, p, "hay_seeds", spot.x, spot.y)).toBe(G.FarmFail.None);
    const crop = [...w.query([G.Crop])].find((e) => { const t = w.get(e, Transform)!; return t.x === spot.x && t.y === spot.y; })!;
    expect(w.get(crop, G.Crop)!.kind).toBe(36);
    expect(G.water(w, spot.x, spot.y)).toBe(1);
    const mul = G.growthMul(w, w.get(crop, G.Crop)!);
    G.cropGrowthSystem(w);
    expect(w.get(crop, G.Crop)!.growth).toBeCloseTo(mul / 300, 6); // 1s of growth at the 300s rate
    w.set(crop, G.Crop, { growth: 1 });
    G.cropGrowthSystem(w);
    expect(w.isAlive(crop)).toBe(false); // matured into a node
    const node = [...w.query([G.ResourceNode])].find((e) => d.resources.get(w.get(e, G.ResourceNode)!.kind)?.key === "crop_hay");
    expect(node).toBeDefined();
    // harvest 12 fresh crop_hay nodes next to the player (ADR-247 pattern): hay 2-3 each, seeds come back
    w.set(p, Transform, { x: 3.5, y: 3 });
    const hayBefore = G.countItem(w, p, iid("hay")); const seedsBefore = G.countItem(w, p, iid("hay_seeds"));
    for (let i = 0; i < 12; i++) {
      const n = G.spawnResourceNode(w, "crop_hay", 3, 3);
      for (let k = 0; k < 12 && w.isAlive(n); k++) { G.setIntent(w, p, { action: G.IntentAction.Gather, target: n }); steps(w, 30); }
      if (w.isAlive(n)) w.destroy(n);
    }
    expect(G.countItem(w, p, iid("hay")) - hayBefore).toBeGreaterThanOrEqual(24);
    expect(G.countItem(w, p, iid("hay_seeds")) - seedsBefore).toBeGreaterThan(0);
  });

  it("an unhired bot gardens hay: empty tilled soil + hay_seeds -> plant; seeds + hoe and no soil -> till", () => {
    const { w, p } = fresh();
    G.addItem(w, p, iid("hay_seeds"), 5); G.addItem(w, p, iid("hoe"), 1);
    const crop = w.create();
    w.add(crop, Transform, { x: BASE.x + 3, y: BASE.y }).add(crop, G.Crop, { kind: 0, stage: 0, growth: 0, waterUntilTick: 0, fertilized: 0 });
    G.indexEntity(w, crop);
    const f1 = G.computeFarmSensor(w, p, d, BASE, G.scanBase(w, d, BASE));
    expect(f1?.tend?.kind).toBe("plant");
    expect(G.slotItem(w, p, f1!.tend!.slot!).item).toBe(iid("hay_seeds"));
    w.destroy(crop); steps(w, 1);
    const f2 = G.computeFarmSensor(w, p, d, BASE, G.scanBase(w, d, BASE));
    expect(f2?.till).toBeDefined(); expect(f2?.till?.slot).toBeGreaterThanOrEqual(0);
    expect(Math.hypot(f2!.till!.x - BASE.x, f2!.till!.y - BASE.y)).toBeLessThanOrEqual(12);
  });
});

describe("Task 28: hay in the trough + the trough fix", () => {
  it("a hungry cow eats 1 hay from a real placed trough and is fed for 600s", () => {
    const { w, p } = fresh();
    const r = put(w, p, "feeding_trough", BASE.x + 1.5, BASE.y + 0.5, 0, 0, undefined, STAND);
    expect(r.ok).toBe(true);
    const trough = G.resolveAttachment(w, (r as { piece: Entity }).piece, G.AttachKind.Storage)!;
    G.addItem(w, trough, iid("hay"), 3);
    const c = cow(w, p, BASE.x + 3, BASE.y + 0.5, { fedUntil: 0 });
    G.husbandrySystem(w);
    expect(G.countItem(w, trough, iid("hay"))).toBe(2); // one hay eaten
    expect(w.get(c, G.Tamed)!.fedUntil).toBe(w.tick + 12000); // 600s at 20Hz
  });

  it("a real placed trough produces: a fed cow's milk lands in the trough (the old query found no trough)", () => {
    const { w, p } = fresh(); pens(w, p);
    const r = put(w, p, "feeding_trough", BASE.x + 1.5, BASE.y + 0.5, 0, 0, undefined, STAND);
    expect(r.ok).toBe(true);
    const trough = G.resolveAttachment(w, (r as { piece: Entity }).piece, G.AttachKind.Storage)!;
    const c = cow(w, p, BASE.x + 3, BASE.y + 0.5, { fedUntil: w.tick + 100000, produceAt: 0 });
    expect(w.get(c, G.Tamed)).toBeDefined();
    G.husbandrySystem(w);
    expect(G.countItem(w, trough, iid("milk"))).toBeGreaterThanOrEqual(1);
  });

  it("a bot with hay, a hungry owned cow and a nearby trough gets a feedTrough sensor (and none without hay)", () => {
    const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId); installPermissions(w);
    const bot = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 1 }); steps(w, 1);
    G.addItem(w, bot, iid("hay"), 5);
    const r = put(w, bot, "feeding_trough", 1.5, 0.5, 0, 0, undefined, { x: 1.5, y: 1.7 });
    expect(r.ok).toBe(true);
    const piece = (r as { piece: Entity }).piece;
    cow(w, bot, 3, 0, { fedUntil: 0 });
    const agent = G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1);
    const v = G.buildAgentView(w, bot, agent, { x: 0, y: 0 })!;
    expect(v.world.feedTrough?.id).toBe(piece);
    expect(v.world.feedTrough?.item).toBe(iid("hay"));
    expect(v.world.feedTrough?.count).toBe(4); // up to 4 hay per trip
    expect(G.removeItem(w, bot, iid("hay"), 5)).toBe(true);
    const v2 = G.buildAgentView(w, bot, agent, { x: 0, y: 0 })!;
    expect(v2.world.feedTrough).toBeUndefined();
  });
});

describe("Task 28: grazing", () => {
  it("a hungry cow with no food starts grazing its grass tile (20s to feed)", () => {
    const { w, p } = fresh(); withTerrain(w);
    const s = grassSpot(w, BASE.x, BASE.y);
    expect(G.GRAZE_SECONDS).toBe(20);
    const c = cow(w, p, s.x, s.y, { fedUntil: 0 });
    G.husbandrySystem(w);
    const g = w.get(c, G.Grazing)!;
    expect(g).toBeDefined();
    expect(g.tx).toBe(Math.floor(s.x)); expect(g.ty).toBe(Math.floor(s.y));
    expect(g.doneTick).toBe(w.tick + 400); // 20s at 20Hz
  });

  it("finishing a graze feeds the cow for 600s and depletes the tile for 180s", () => {
    const { w, p } = fresh(); withTerrain(w);
    const s = grassSpot(w, BASE.x, BASE.y);
    const c = cow(w, p, s.x, s.y, { fedUntil: 0 });
    G.husbandrySystem(w);
    expect(w.get(c, G.Grazing)).toBeDefined();
    w.set(c, G.Grazing, { doneTick: w.tick }); // 20s have passed
    G.husbandrySystem(w);
    expect(w.has(c, G.Grazing)).toBe(false);
    expect(w.get(c, G.Tamed)!.fedUntil).toBe(w.tick + 12000);
    const tiles = [...w.query([G.GrazedTile])];
    expect(tiles.length).toBe(1);
    expect(w.get(tiles[0]!, G.GrazedTile)).toMatchObject({ tx: Math.floor(s.x), ty: Math.floor(s.y), regrowTick: w.tick + 3600 });
    expect(G.GRASS_REGROW_SECONDS).toBe(180);
  });

  it("a depleted tile cannot be grazed until its grass regrows, and walking off a tile interrupts the graze", () => {
    const { w, p } = fresh(); withTerrain(w);
    const s = grassSpot(w, BASE.x, BASE.y);
    const c1 = cow(w, p, s.x, s.y, { fedUntil: 0 });
    G.husbandrySystem(w);
    w.set(c1, G.Grazing, { doneTick: w.tick });
    G.husbandrySystem(w); // c1 fed; tile depleted
    expect([...w.query([G.GrazedTile])].length).toBe(1);
    const c2 = cow(w, p, s.x, s.y, { fedUntil: 0 });
    G.husbandrySystem(w);
    expect(w.has(c2, G.Grazing)).toBe(false); // bare tile: nothing to graze
    const tile = [...w.query([G.GrazedTile])][0]!;
    w.set(tile, G.GrazedTile, { regrowTick: w.tick }); // 180s have passed
    G.husbandrySystem(w);
    expect(w.isAlive(tile)).toBe(false); // grass regrown
    expect(w.has(c2, G.Grazing)).toBe(true); // and the tile can be grazed again
    // walking off the tile interrupts the graze (no feed, no depletion)
    w.set(c2, Transform, { x: s.x + 5, y: s.y });
    G.husbandrySystem(w);
    expect(w.has(c2, G.Grazing)).toBe(false);
    expect(w.get(c2, G.Tamed)!.fedUntil).toBe(0);
    expect([...w.query([G.GrazedTile])].length).toBe(0);
  });
});

describe("Task 28: seasonal crop death", () => {
  it("dormancy: final day of fall + winter pause growth; early fall and summer grow", () => {
    expect(G.LATE_FALL_DAYS).toBe(1); // seasons are 15 in-game days; the "last days of fall" is still just the last day (ADR-261)
    const { w } = fresh();
    setSeason(w, 0, 0); expect(G.isCropDormant(w)).toBe(false); // summer
    setSeason(w, 1, 0); expect(G.isCropDormant(w)).toBe(false); // early fall
    const len = seasonAt(w).lengthDays;
    expect(len).toBe(15);
    setSeason(w, 1, len - 2); expect(G.isCropDormant(w)).toBe(false); // second-to-last day of fall still grows
    setSeason(w, 1, len - 1); expect(G.isCropDormant(w)).toBe(true); // last day of fall: dormant
    setSeason(w, 1, len - 1); expect(G.isCropDormant(w)).toBe(true); // last day of fall
    setSeason(w, 2, 0); expect(G.isCropDormant(w)).toBe(true); // winter
  });

  it("growth pauses in late fall and winter (bushes survive frost) and advances in early fall", () => {
    const { w } = fresh();
    const bush = cropAt(w, BASE.x + 3, BASE.y, "berry_seeds", 0.1);
    setSeason(w, 1, 0);
    setSeason(w, 1, seasonAt(w).lengthDays - 1); // last day of fall
    G.cropGrowthSystem(w);
    expect(w.get(bush, G.Crop)!.growth).toBeCloseTo(0.1, 6); // late fall: paused
    setSeason(w, 2, 0);
    G.cropGrowthSystem(w);
    expect(w.get(bush, G.Crop)!.growth).toBeCloseTo(0.1, 6); // winter: paused, bush not killed
    setSeason(w, 1, 0);
    G.cropGrowthSystem(w);
    expect(w.get(bush, G.Crop)!.growth).toBeGreaterThan(0.1); // early fall: growing again
  });

  it("below 40F (winter): planted crops and hay die, wild plants and fruit trees die, trees and berry bushes live", () => {
    expect(G.FROST_KILL_F).toBe(40);
    const { w } = fresh();
    setSeason(w, 2, 0);
    expect(G.ambientTemperature(w)).toBeLessThan(G.FROST_KILL_C);
    const wheat = cropAt(w, BASE.x + 3, BASE.y, "wheat_seeds", 0.5);
    const hay = cropAt(w, BASE.x + 5, BASE.y, "hay_seeds", 0.5);
    const nodes: [string, Entity][] = (["wild_wheat", "apple_tree", "tree", "berry_bush", "wild_carrot", "cotton_bush"] as const)
      .map((k, i) => [k, G.spawnResourceNode(w, k, BASE.x + 2 + i * 2, BASE.y + 2)] as [string, Entity]);
    const before = new Map(nodes.map(([k, e]) => [k, w.get(e, G.ResourceNode)!.amount]));
    for (const [k] of nodes) expect(before.get(k)!).toBeGreaterThan(0);
    G.cropGrowthSystem(w);
    expect(w.get(wheat, G.Crop)!.kind).toBe(0); // crop reverts to empty tilled soil
    expect(w.get(hay, G.Crop)!.kind).toBe(0); // hay counts as a crop
    const after = new Map(nodes.map(([k, e]) => [k, w.get(e, G.ResourceNode)!.amount]));
    expect(after.get("wild_wheat")).toBe(0);
    expect(after.get("wild_carrot")).toBe(0);
    expect(after.get("cotton_bush")).toBe(0);
    expect(after.get("apple_tree")).toBe(0); // fruit trees die
    expect(after.get("tree")).toBe(before.get("tree")); // ordinary trees survive
    expect(after.get("berry_bush")).toBe(before.get("berry_bush")); // berry bushes survive
  });
});

describe("ADR-260: plants start their growth cycle in Spring", () => {
  it("crops are dormant in late fall and winter, and grow again in spring", () => {
    const { w } = fresh(); const len = seasonAt(w).lengthDays;
    setSeason(w, 1, len - 1); expect(G.isCropDormant(w)).toBe(true);
    setSeason(w, 2, 1); expect(G.isCropDormant(w)).toBe(true);
    setSeason(w, 3, 0); expect(seasonAt(w).index).toBe(3); expect(G.isCropDormant(w)).toBe(false);
    setSeason(w, 3, len - 1); expect(G.isCropDormant(w)).toBe(false);
  });
  it("a planted crop does not grow across mid-winter ticks and does grow across spring ticks", () => {
    const { w } = fresh();
    const bush = cropAt(w, BASE.x + 3, BASE.y, "berry_seeds", 0.1);
    w.set(bush, G.Crop, { waterUntilTick: w.tick + 1_000_000 }); // ADR-286: watered (growth needs water + light)
    setSeason(w, 2, 1); for (let i = 0; i < 5; i++) G.cropGrowthSystem(w);
    expect(w.get(bush, G.Crop)!.growth).toBeCloseTo(0.1, 6);
    setSeason(w, 3, 0); let prev = w.get(bush, G.Crop)!.growth;
    for (let i = 0; i < 5; i++) { G.cropGrowthSystem(w); const g = w.get(bush, G.Crop)!.growth; expect(g).toBeGreaterThan(prev); prev = g; }
  });
});
