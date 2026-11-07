/**
 * ADR-110 farming: hoe -> tilled soil, seeds / saplings planted with Use (IntentAction.Use on the item's slot), growth
 * stages with watering + fertilizer, maturity -> a resource node (crop_* nodes are oneShot and may drop seeds back).
 * Seeds come only from gathering wild plants and harvesting crops (resources.json yields); there are no seed recipes.
 * ADR-247: a seed/sapling drops only from its OWN species (`wild` nodes, its `becomes` node, crop_<key>); see seedSourceIssues.
 * Authority-only and RNG-free; Crop is networked + persistent so fields survive restarts and replicate to clients.
 */
import { DEFAULT_TICK_HZ, SeasonId, timeOfDay, Transform, Weather, entityIndex, seasonAt, type Entity, type World } from "@engine/core";
import { installSpatialIndex } from "@engine/world";
import raw from "../data/farming.json";
import { BuildPiece, Crop, Dead, Equipment, IntentAction, PlayerIntent, ResourceNode, WorkerTarget } from "./components.js";
import { gameplayDefs, isAuthority } from "./config.js";
import type { GameDefs } from "./defs.js";
import { takeSip } from "./food.js";
import { countItem, readSlots, slotItem, takeFromSlot } from "./inventory.js";
import { emit, FarmFailed, PlantDied, XpActivity } from "./events.js";
import { indexEntity, spawnResourceNode } from "./spawn.js";
import { hasPrivilege } from "./building/place.js";
import { populationTile } from "./population.js";
import { nearWater } from "./systems/vitals.js";
import { surfaceTemperature } from "./systems/environment.js";
import { isRaining } from "./realism.js";
import { isUnderground } from "./terrain_depth.js";
import { lightAt } from "./systems/lights.js";

export type PlantType = "crop" | "bush" | "tree";
export interface Plantable { seed: string; key: string; type: PlantType; growSeconds: number; stages: number; becomes: string; tiles: number[];
  /** ADR-247: world-spawned resource nodes of the same species (where the seed is first found). */
  wild: string[] }
export interface FarmingData { unwateredMul: number; wateredMul: number; wateredSeconds: number; fertilizerMul: number; waterRadius: number; fertilizeRadius: number; plantReach: number; minSpacing: number; tickSeconds: number; plantables: Plantable[] }
export const FARMING: FarmingData = raw as unknown as FarmingData;
export const FARM_TOOL = { hoe: "hoe", wateringCan: "watering_can", fertilizer: "fertilizer" } as const;
/** Crop.kind -> plantable (kind 0 = tilled soil). */
export const plantableOf = (kind: number): Plantable | undefined => (kind > 0 ? FARMING.plantables[kind - 1] : undefined);
export const plantableBySeed = (seed: string): number => FARMING.plantables.findIndex((p) => p.seed === seed) + 1;
/** ADR-247: resource node keys allowed to yield `p.seed`: its wild nodes, its `becomes` node and crop_<key>. */
export function seedSourceNodes(p: Plantable): Set<string> { return new Set([...p.wild, p.becomes, `crop_${p.key}`]); }
/**
 * ADR-247 seed-source rules, checked against loaded defs (empty = OK):
 *  - a node may only yield seeds of its own species (no cross-species / generic seed drops);
 *  - every plantable has a wild node that worldgen actually places (some band lists it with nodeChance > 0),
 *    and that wild node yields its seed with chance > 0; every crop_<key> harvest yields its own seed back;
 *  - no recipe outputs a plantable seed.
 */
export function seedSourceIssues(defs: GameDefs, farming: FarmingData = FARMING): string[] {
  const out: string[] = []; const bySeed = new Map(farming.plantables.map((p) => [p.seed, p]));
  const resByKey = new Map([...defs.resources.values()].map((r) => [r.key, r]));
  const itemKey = (id: number): string => defs.items.get(id)?.key ?? `#${id}`;
  for (const r of defs.resources.values()) for (const y of r.yields) {
    const p = bySeed.get(itemKey(y.item)); if (p && !seedSourceNodes(p).has(r.key)) out.push(`${r.key} yields ${p.seed} (not a ${p.key} plant)`);
  }
  const placed = new Set<number>(); for (const b of defs.worldgen.bands) if (b.nodeChance > 0) for (const n of b.nodes) placed.add(n);
  const yieldsSeed = (key: string, seed: string): boolean => resByKey.get(key)?.yields.some((y) => itemKey(y.item) === seed && y.chance > 0 && y.max > 0) ?? false;
  for (const p of farming.plantables) {
    if (!p.wild?.length) { out.push(`${p.key}: no wild source listed`); continue; }
    const spawned = p.wild.filter((k) => { const r = resByKey.get(k); return r !== undefined && placed.has(r.id) && yieldsSeed(k, p.seed); });
    if (!spawned.length) out.push(`${p.key}: no world-spawned wild node yields ${p.seed}`);
    const crop = `crop_${p.key}`; if (resByKey.has(crop) && !yieldsSeed(crop, p.seed)) out.push(`${crop} harvest does not return ${p.seed}`);
    if (p.type !== "crop" && !yieldsSeed(p.becomes, p.seed)) out.push(`${p.becomes} (grown ${p.type}) does not yield ${p.seed}`);
  }
  for (const rc of defs.recipes.values()) { const k = itemKey(rc.output.item); if (bySeed.has(k)) out.push(`recipe ${rc.key} outputs ${k}`); }
  return out;
}

/** Render key for a crop entity: farm_soil, or crop_<key>_<stage> / sapling_<key>_<stage> / bush_<key>_<stage>. */
export function cropSpriteKey(kind: number, stage: number): string {
  const p = plantableOf(kind); if (!p) return "farm_soil";
  return p.type === "crop" ? `crop_${p.key}_${stage}` : `sapling_${p.key}_${stage}`;
}

export const enum FarmFail { None = 0, NoPrivilege = 1, BadTile = 2, Occupied = 3, NeedsSoil = 4, NothingToTend = 5, /** crop seed with no soil and no hoe to till it */ NeedsHoe = 6, /** ADR-286 status */ NeedsWater = 7, /** ADR-286 status */ TooDark = 8 }

/** Planting spot: one tile in front of the player, snapped to the tile centre. */
export function plantSpot(world: World, e: Entity): { x: number; y: number } {
  const t = world.get(e, Transform)!; const f = t.facing ?? 0;
  return { x: Math.floor(t.x + Math.cos(f)) + 0.5, y: Math.floor(t.y + Math.sin(f)) + 0.5 };
}
function near(world: World, x: number, y: number, r: number): Entity[] {
  return installSpatialIndex(world).queryRadius(x, y, r).filter((o) => { const t = world.get(o, Transform); return !!t && Math.hypot(t.x - x, t.y - y) <= r; }).sort((a, b) => a - b);
}
const tileOk = (world: World, x: number, y: number, tiles: readonly number[]): boolean => { const t = populationTile(world, Math.floor(x), Math.floor(y)); return t === 0 || tiles.includes(t); };

/** ADR-112: a planter piece (features.planter) within half a tile: its soil accepts crops on any terrain / deck. */
export function inPlanter(world: World, x: number, y: number): boolean {
  if (!world.isRegistered(BuildPiece)) return false; const defs = gameplayDefs(world);
  return near(world, x, y, 0.75).some((o) => { const t = world.getField(o, BuildPiece, "type"); return t !== undefined && !!defs.pieces.get(t)?.features.planter; });
}
export function spawnCrop(world: World, x: number, y: number, kind = 0): Entity {
  const e = world.create(); world.add(e, Transform, { x, y }).add(e, Crop, { kind, stage: 0, growth: 0, waterUntilTick: kind > 0 ? dryClock(world) : 0, fertilized: 0 }); indexEntity(world, e); return e;
}
/** Till the spot (hoe). */
export function till(world: World, e: Entity, x: number, y: number, dryRun = false): FarmFail {
  if (hasForeignZone(world, e, x, y)) return FarmFail.NoPrivilege;
  if (!tileOk(world, x, y, [3, 4])) return FarmFail.BadTile;
  if (near(world, x, y, FARMING.minSpacing).some((o) => world.has(o, Crop) || world.has(o, ResourceNode))) return FarmFail.Occupied;
  if (!dryRun) spawnCrop(world, x, y, 0); return FarmFail.None;
}
const hasForeignZone = (world: World, e: Entity, x: number, y: number): boolean => !hasPrivilege(world, e, x, y);
/** Plant `seed` (item key) at x,y. Crops need tilled soil there; trees / bushes need a free spot. */
export function plant(world: World, e: Entity, seed: string, x: number, y: number, dryRun = false): FarmFail {
  const kind = plantableBySeed(seed); const p = plantableOf(kind); if (!p) return FarmFail.BadTile;
  if (hasForeignZone(world, e, x, y)) return FarmFail.NoPrivilege;
  const around = near(world, x, y, FARMING.minSpacing);
  if (!(p.type === "crop" && inPlanter(world, x, y)) && !tileOk(world, x, y, p.tiles)) return FarmFail.BadTile;
  if (p.type === "crop") {
    const soil = around.find((o) => world.get(o, Crop)?.kind === 0); if (soil === undefined) return hasHoe(world, e) ? FarmFail.NeedsSoil : FarmFail.NeedsHoe;
    if (!dryRun) world.set(soil, Crop, { kind, stage: 0, growth: 0, waterUntilTick: Math.max(world.get(soil, Crop)!.waterUntilTick, dryClock(world)) }); return FarmFail.None;
  }
  if (around.some((o) => world.has(o, Crop) || world.has(o, ResourceNode))) return FarmFail.Occupied;
  if (!dryRun) spawnCrop(world, x, y, kind); return FarmFail.None;
}
export function water(world: World, x: number, y: number): number {
  const until = world.tick + Math.round(FARMING.wateredSeconds * DEFAULT_TICK_HZ); let n = 0;
  for (const o of near(world, x, y, FARMING.waterRadius)) if ((world.get(o, Crop)?.kind ?? 0) > 0) { world.set(o, Crop, { waterUntilTick: until }); n++; }
  return n;
}
/** ADR-286: waterUntilTick for a freshly planted (dry) plant: the drought clock starts now (0 = unset: re-started on the next crop tick). */
const dryClock = (world: World): number => world.tick;
/** ADR-286: plants in front of `e` (plantSpot, waterRadius) that are not watered right now. */
export function thirstyPlantsInFront(world: World, e: Entity): Entity[] {
  if (!world.has(e, Transform)) return []; const at = plantSpot(world, e);
  return crops(world, at.x, at.y, FARMING.waterRadius).filter((o) => world.get(o, Crop)!.waterUntilTick <= world.tick);
}
/**
 * ADR-286: pour one sip from a held liquid container (waterskin, flask, canteen... any item with sips > 0 still holding
 * water) onto the thirsty plants in front. Authority only; consumes the sip. Returns plants watered (0 = nothing done).
 * Underground plants never get rain, so this (or a watering can / water flowing beside them) is how they are watered.
 */
export function waterFromContainer(world: World, e: Entity, slot: number): number {
  const thirsty = thirstyPlantsInFront(world, e); if (!thirsty.length) return 0;
  if (!takeSip(world, e, slot)) return 0;
  const until = world.tick + Math.round(FARMING.wateredSeconds * DEFAULT_TICK_HZ);
  for (const o of thirsty) world.set(o, Crop, { waterUntilTick: until });
  emit(world, XpActivity, { entity: e, source: "water", units: 1 }); return thirsty.length;
}
const hasHoe = (world: World, e: Entity): boolean => { const id = [...gameplayDefs(world).items.values()].find((d) => d.key === FARM_TOOL.hoe)?.id; return !!id && countItem(world, e, id) > 0; };
const crops = (world: World, x: number, y: number, r: number): Entity[] => near(world, x, y, r).filter((o) => (world.get(o, Crop)?.kind ?? 0) > 0);
export function fertilize(world: World, x: number, y: number): boolean {
  const c = near(world, x, y, FARMING.fertilizeRadius).find((o) => { const k = world.get(o, Crop); return !!k && k.kind > 0 && k.fertilized === 0; });
  if (c === undefined) return false; world.set(c, Crop, { fertilized: 1 }); return true;
}

/** IntentAction.Use on a hoe / seed / sapling / watering can / fertilizer (authority; the client is corrected by replication). */
export function farmUseSystem(world: World): void {
  if (!isAuthority(world) || world.isReplaying) return;
  const defs = gameplayDefs(world); const intent = world.store(PlayerIntent);
  for (const e of world.query([PlayerIntent, Transform], [Dead])) {
    const s = intent.slot(entityIndex(e)); if (intent.data.action[s] !== IntentAction.Use) continue;
    const slot = intent.data.slot[s]!; const { item, count } = slotItem(world, e, slot); if (!count) continue;
    const key = defs.items.get(item)?.key; if (!key) continue;
    const at = plantSpot(world, e); const me = world.get(e, Transform)!;
    let r = FarmFail.None;
    if (key === FARM_TOOL.hoe) r = till(world, e, at.x, at.y);
    else if (key === FARM_TOOL.wateringCan) { if (!water(world, me.x, me.y)) r = FarmFail.NothingToTend; }
    else if (key === FARM_TOOL.fertilizer) { if (fertilize(world, at.x, at.y) || fertilize(world, me.x, me.y)) takeFromSlot(world, e, slot); else r = FarmFail.NothingToTend; }
    else if (plantableBySeed(key) > 0) { r = plant(world, e, key, at.x, at.y); if (r === FarmFail.None) takeFromSlot(world, e, slot); }
    else continue;
    if (r !== FarmFail.None) emit(world, FarmFailed, { entity: e, reason: r });
    else emit(world, XpActivity, { entity: e, source: key === FARM_TOOL.hoe ? "till" : key === FARM_TOOL.wateringCan ? "water" : key === FARM_TOOL.fertilizer ? "fertilize" : "plant", units: 1 });
  }
}

/** ADR-286: true while the sun is up (that day's ADR-285 sunrise..sunset on the shared world clock). */
export function isSunUp(world: World): boolean {
  const tod = timeOfDay(world); if (!tod.dayLengthTicks || !tod.sun) return true;
  return tod.hours >= tod.sun.sunrise && tod.hours < tod.sun.sunset;
}
/** ADR-286: drought death after this many ticks past the last watering (two full in-game days). */
export function droughtTicks(world: World): number {
  const len = timeOfDay(world).dayLengthTicks; return 2 * (len > 0 ? len : 3600 * DEFAULT_TICK_HZ);
}
export type PlantNeed = "growing" | "water" | "dark" | "dormant";
/** ADR-286: why a plant is (not) growing now: pure read, used by prompts, QA and tests. */
export function plantNeed(world: World, e: Entity): PlantNeed | undefined {
  const c = world.get(e, Crop); const t = world.get(e, Transform); if (!c || !t || !plantableOf(c.kind)) return undefined;
  const under = isUnderground(world, t.x, t.y);
  if (!under && isCropDormant(world)) return "dormant";
  if (!(c.waterUntilTick > world.tick || (!under && isRaining(world.env(Weather).kind)) || nearWater(world, t.x, t.y))) return "water";
  if ((under || !isSunUp(world)) && lightAt(world, t.x, t.y, 0) === undefined) return "dark";
  return "growing";
}
/** Growth multiplier right now. ADR-286: a surface plant needs water (can, container, rain or water beside it) AND light
 * (the sun between sunrise and sunset, or an artificial light reaching it at night); otherwise 0 (paused). */
export function growthMul(world: World, c: { waterUntilTick: number; fertilized: number }, x?: number, y?: number): number {
  const wet = c.waterUntilTick > world.tick || isRaining(world.env(Weather).kind) || (x !== undefined && y !== undefined && nearWater(world, x, y));
  if (!wet) return 0;
  if (!isSunUp(world) && (x === undefined || y === undefined || lightAt(world, x, y, 0) === undefined)) return 0;
  return FARMING.wateredMul * (c.fertilized ? FARMING.fertilizerMul : 1);
}
/**
 * ADR-263 (Task 36): growth multiplier for a crop underground (dug >= 3 levels below ground). Rain does not reach it and
 * there is no sun, so it grows only while BOTH a light reaches it (held torch / lantern, campfire, lamp…: checked every
 * crop tick, so the light must stay on) AND it has water (watering can, or flowing / standing water beside it);
 * otherwise 0. Season dormancy and frost do not apply underground (a constant 60°F).
 */
export function undergroundGrowthMul(world: World, c: { waterUntilTick: number; fertilized: number }, x: number, y: number): number {
  if (lightAt(world, x, y, 0) === undefined) return 0;
  if (!(c.waterUntilTick > world.tick || nearWater(world, x, y))) return 0;
  return FARMING.wateredMul * (c.fertilized ? FARMING.fertilizerMul : 1);
}
export const CROP_EVERY = Math.round(FARMING.tickSeconds * DEFAULT_TICK_HZ);
/** Task 28 seasonal crop death: growth pauses in the final LATE_FALL_DAYS days of fall, and all winter.
 * Seasons are 15 in-game days (environment.json lengthDays, ADR-261); N stays 1: the last day of fall is the dormant
 * warning day (N = 3 would make the whole of fall dormant and no fall crop would ever grow). */
export const LATE_FALL_DAYS = 1;
/** Task 28: below this ambient temperature (40°F) outdoor crops/plants die. */
export const FROST_KILL_F = 40;
export const FROST_KILL_C = (FROST_KILL_F - 32) * 5 / 9;
/** True while crops are dormant: the final LATE_FALL_DAYS days of fall, and all of winter. ADR-260: growth resumes at the
 * first tick of Spring (season 3) and continues through Summer and early/mid Fall; frost-killed crops stay dead. */
export function isCropDormant(world: World): boolean {
  const s = seasonAt(world);
  if (s.index === SeasonId.Winter) return true;
  return s.index === SeasonId.Fall && s.into >= s.lengthDays - LATE_FALL_DAYS;
}
/** Task 28 frost exceptions: fruit trees die, ordinary trees and berry bushes survive, wild plants and crops die. */
const FRUIT_TREES = new Set(["apple_tree", "pear_tree", "cherry_tree", "orange_tree", "peach_tree"]);
const BERRY_BUSHES = new Set(["berry_bush", "blueberry_bush", "raspberry_bush", "blackberry_bush", "strawberry_bush"]);
const FROST_EXTRA_DIES = new Set(["cotton_bush", "fiber_bush", "wild_garden"]);
export function frostKillsNode(key: string): boolean {
  if (key === "tree" || key.endsWith("_tree")) return FRUIT_TREES.has(key);
  if (BERRY_BUSHES.has(key)) return false;
  if (key.startsWith("wild_") || key.endsWith("_patch") || key.startsWith("crop_")) return true;
  return FROST_EXTRA_DIES.has(key);
}
/** Every CROP_EVERY ticks: grow, advance stages, mature into the resource node. */
export function cropGrowthSystem(world: World): void {
  if (!isAuthority(world) || world.isReplaying) return;
  const dt = CROP_EVERY / DEFAULT_TICK_HZ;
  // Task 28: below 40°F ambient, outdoor crops/plants die (fruit trees die; ordinary trees and berry bushes survive).
  // The kill pass runs even while dormant — a frost kills a field that stopped growing. A killed crop reverts to
  // empty tilled soil (kind 0) so the player can replant; a killed wild node is depleted (amount 0, regrows later).
  if (surfaceTemperature(world) < FROST_KILL_C) { // ADR-263: the open-air reading (a pit at 0,0 must not stop frost)
    const defs = gameplayDefs(world);
    for (const e of [...world.query([Crop, Transform])].sort((a, b) => a - b)) {
      const c = world.get(e, Crop)!; const p = plantableOf(c.kind); const t = world.get(e, Transform)!;
      if (p && p.type === "crop" && !isUnderground(world, t.x, t.y)) world.set(e, Crop, { kind: 0, stage: 0, growth: 0 }); // ADR-263: 60°F underground
    }
    for (const e of [...world.query([ResourceNode])].sort((a, b) => a - b)) {
      const n = world.get(e, ResourceNode)!; const key = defs.resources.get(n.kind)?.key ?? "";
      if (frostKillsNode(key)) world.set(e, ResourceNode, { amount: 0 });
    }
  }
  const dormant = isCropDormant(world);
  for (const e of [...world.query([Crop, Transform])].sort((a, b) => a - b)) {
    const c = world.get(e, Crop)!; const p = plantableOf(c.kind); if (!p) continue;
    const tf = world.get(e, Transform)!; const under = isUnderground(world, tf.x, tf.y); // ADR-263: no seasons underground
    // ADR-286 water / drought clock: rain (open sky only) or water beside the plant keeps it watered; a legacy 0 starts now.
    let wut = c.waterUntilTick;
    if ((!under && isRaining(world.env(Weather).kind)) || nearWater(world, tf.x, tf.y)) wut = Math.max(wut, world.tick + Math.round(FARMING.wateredSeconds * DEFAULT_TICK_HZ));
    else if (wut === 0) wut = dryClock(world);
    if (dormant && !under && wut < world.tick) wut = world.tick; // ADR-286: no drought clock while dormant (winter)
    if (wut !== c.waterUntilTick) world.set(e, Crop, { waterUntilTick: wut });
    if (world.tick > wut + droughtTicks(world)) { // ADR-286: died of prolonged drought (crop -> bare tilled soil; sapling / bush gone)
      if (p.type === "crop") world.set(e, Crop, { kind: 0, stage: 0, growth: 0, waterUntilTick: 0, fertilized: 0 }); else world.destroy(e);
      emit(world, PlantDied, { x: tf.x, y: tf.y, kind: c.kind }); continue;
    }
    if (dormant && !under) continue;
    const cw = { waterUntilTick: wut, fertilized: c.fertilized };
    const mul = under ? undergroundGrowthMul(world, cw, tf.x, tf.y) : growthMul(world, cw, tf.x, tf.y); if (!(mul > 0)) continue;
    const growth = Math.min(1, c.growth + (dt / p.growSeconds) * mul);
    if (growth >= 1) { const t = world.get(e, Transform)!; const targetId = world.getField(e, WorkerTarget, "id");
      world.destroy(e); const node = spawnResourceNode(world, p.becomes, t.x, t.y);
      if (targetId) world.add(node, WorkerTarget, { id: targetId }); // a selected plot stays selected through maturity
      continue; }
    const stage = Math.min(p.stages - 1, Math.floor(growth * p.stages));
    world.set(e, Crop, stage !== c.stage ? { growth, stage } : { growth });
  }
}

/** Short toast text per failure (ADR-110 follow-up). */
export const FARM_FAIL_TEXT: Readonly<Record<number, string>> = {
  [FarmFail.NoPrivilege]: "Inside someone else's claim", [FarmFail.BadTile]: "Can't farm on this ground", [FarmFail.Occupied]: "Too close to another plant",
  [FarmFail.NeedsSoil]: "Needs tilled soil — use a hoe first", [FarmFail.NothingToTend]: "No crops here to tend", [FarmFail.NeedsHoe]: "You need a hoe to till soil first",
  [FarmFail.NeedsWater]: "Plant needs water", [FarmFail.TooDark]: "Too dark to grow — needs sunlight or a light",
};
export type FarmAction = "Till" | "Plant" | "Water" | "Fertilize" | "Harvest" | "Tame" | "Feed" | "Eat" | "Drink"; // Eat / Drink: ADR-128 quick-use consume; Tame / Feed: ADR-113 husbandryPrompt
export interface FarmPrompt { action: FarmAction; /** Use slot (Harvest goes through Interact / gather instead) */ slot?: number; target?: Entity; /** predicted failure (dry run) */ fail: FarmFail; label: string }
/** Context prompt for the player's held farming item / a ripe farmed node in front (pure read; client-predicted). */
export function farmPrompt(world: World, e: Entity): FarmPrompt | undefined {
  if (!world.has(e, Transform)) return undefined;
  const defs = gameplayDefs(world); const at = plantSpot(world, e); const me = world.get(e, Transform)!;
  const slot = world.get(e, Equipment)?.mainHandSlot ?? 255;
  const { item, count } = slot !== 255 ? slotItem(world, e, slot) : { item: 0, count: 0 };
  const key = count ? defs.items.get(item)?.key : undefined;
  const mk = (action: FarmAction, fail: FarmFail, extra: Partial<FarmPrompt> = {}): FarmPrompt => ({ action, slot, fail, label: fail ? `${action}: ${FARM_FAIL_TEXT[fail]}` : action, ...extra });
  if (key === FARM_TOOL.hoe) return mk("Till", till(world, e, at.x, at.y, true));
  if (key === FARM_TOOL.wateringCan) return mk("Water", crops(world, me.x, me.y, FARMING.waterRadius).length ? FarmFail.None : FarmFail.NothingToTend);
  if (key === FARM_TOOL.fertilizer) return mk("Fertilize", crops(world, at.x, at.y, FARMING.fertilizeRadius).length || crops(world, me.x, me.y, FARMING.fertilizeRadius).length ? FarmFail.None : FarmFail.NothingToTend);
  if (key && plantableBySeed(key) > 0) return mk("Plant", plant(world, e, key, at.x, at.y, true));
  const ripe = new Set(FARMING.plantables.map((p) => p.becomes));
  const node = near(world, at.x, at.y, 1).find((o) => { const n = world.get(o, ResourceNode); return !!n && ripe.has(defs.resources.get(n.kind)?.key ?? ""); });
  if (node !== undefined) { const { slot: _s, ...p } = mk("Harvest", FarmFail.None, { target: node }); return p; }
  // ADR-128: quick-use eats/drinks the held consumable; empty hands next to water drink from the tile (slot NO_SLOT)
  const food = key ? defs.items.get(item) : undefined;
  // ADR-286: a liquid container holding water pours on a thirsty plant in front (instead of drinking)
  if (food?.food && food.sips > 0 && readSlots(world, e).durability(slot) > 0 && thirstyPlantsInFront(world, e).length) return { ...mk("Water", FarmFail.None), label: `Water plant (${food.name})` };
  const wet = nearWater(world, me.x, me.y);
  // ADR-176: an empty liquid container next to water refills (same Use path); say so instead of a dead "Drink"
  if (food?.food && food.sips > 0 && readSlots(world, e).durability(slot) <= 0 && wet) return { ...mk("Drink", FarmFail.None), label: `Refill ${food.name}` };
  if (food?.food) return mk(food.sips > 0 || (food.food.thirst > 0 && food.food.hunger <= 0) ? "Drink" : "Eat", FarmFail.None);
  // ADR-176: drinking from the tile no longer needs empty hands (holding an axe/tool by water used to hide the prompt)
  if (wet) return { action: "Drink", slot: 255, fail: FarmFail.None, label: "Drink water" };
  // ADR-286: say why the plant in front is not growing (needs water / too dark); pure read
  const plantInFront = crops(world, at.x, at.y, FARMING.waterRadius)[0];
  const need = plantInFront !== undefined ? plantNeed(world, plantInFront) : undefined;
  if (need === "water" || need === "dark") { const f = need === "water" ? FarmFail.NeedsWater : FarmFail.TooDark; return { action: "Water", fail: f, label: FARM_FAIL_TEXT[f]!, target: plantInFront! }; }
  return undefined;
}
