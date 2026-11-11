/**
 * ADR-352 dung. Every living animal produces Dung a couple of times per in-game day: a per-animal,
 * persistent DungTimer (nextAt, absolute tick) drives it, so a herd never drops in unison and a restart
 * does not reset the schedule (no backlog — the stored nextAt is honoured). The interval is
 * dayLengthTicks / perDay for the species (data/dung.json, with per-species overrides for the big
 * grazers/mounts), jittered ±jitterFraction by the deterministic per-animal RNG (world.rngFor, seeded by
 * world seed + tick + entity, so server and client agree and a herd staggers instead of syncing).
 *
 * The drop is a plain ownerless LootBag holding 1 dung at the animal's feet (the generic dropped-item
 * path: same Container / LootBag / tagLootSource shape as animal loot, so pickup, stacking, weight,
 * replication and persistence all come for free). Its despawnAtTick is spawn + despawnSeconds (10 s):
 * the exception to the 3-minute dropped-item rule, and it applies to dung bags only — other bags keep
 * their own lifetimes from loot_despawn.ts. The client fades the bag over its short life through
 * the existing despawnFadeAlpha path (syncLootFade): with only 10 s left it spawns already
 * part-faded, exactly like any other bag 10 s from expiry, and decays to the floor by despawn —
 * the existing dropped-item presentation, not a special case.
 *
 * Coverage: every animal archetype in ai.json (kind "animal") except the data-driven `excluded` list —
 * today only animal_bee (it flies; honey is its produce and goes to the Apiary). Farm animals, pets,
 * mounts and wild animals all produce; dead animals never do. Authority-only, like every other
 * production system; DungTimer is persistent but not networked (clients only ever see the bag).
 */
import { DEFAULT_TICK_HZ, timeOfDay, Transform, type Entity, type World } from "@engine/core";
import { Animal, Container, ContainerViewers, Dead, DungTimer, LootBag } from "./components.js";
import { gameplayDefs, isAuthority } from "./config.js";
import { secondsToTicks } from "./defs.js";
import { addItem } from "./inventory.js";
import { LootSource, tagLootSource } from "./loot_labels.js";
import { PERMANENT_DESPAWN } from "./loot_despawn.js";
import { animalDefs } from "./population.js";
import { indexEntity } from "./spawn.js";
import raw from "../data/dung.json";

export interface DungData {
  perDay: number; jitterFraction: number; despawnSeconds: number; dropRadius: number; count: number;
  excluded: string[]; perSpecies: Record<string, number>;
}
export const DUNG: DungData = raw as unknown as DungData;
/** How often the production timer is checked (1 s); a drop is never more than a second late. */
export const DUNG_EVERY = 20;

const dayLengthTicks = (world: World): number => {
  const len = timeOfDay(world).dayLengthTicks;
  return len > 0 ? len : 3600 * DEFAULT_TICK_HZ;
};
/** Drops per in-game day for this species (per-species override, else the default). */
export const dungPerDayFor = (key: string): number => DUNG.perSpecies[key] ?? DUNG.perDay;
/** True when this animal archetype produces dung (every living animal except the excluded list). */
export const isDungProducerKey = (key: string): boolean => !DUNG.excluded.includes(key);
/** All producing species, in animalDefs order (farm animals, pets, mounts, wild animals). */
export const dungProducerKeys = (): string[] => animalDefs().map((a) => a.key).filter(isDungProducerKey);
/**
 * Ticks until the next drop for `animal`: one day's worth of production, jittered ±jitterFraction.
 * The RNG is seeded by (world seed, current tick, entity), so two animals never share a schedule and a
 * whole herd seeded on the same tick still staggers.
 */
export function nextDungDelay(world: World, animal: Entity, key: string): number {
  const base = dayLengthTicks(world) / Math.max(1, dungPerDayFor(key));
  const j = (world.rngFor("dung.next", animal).next() * 2 - 1) * DUNG.jitterFraction;
  return Math.max(1, Math.round(base * (1 + j)));
}
/** Drop one dung at the animal's feet as an ownerless, 10-second LootBag (the generic dropped-item path). */
export function dropDung(world: World, animal: Entity): Entity | undefined {
  const t = world.get(animal, Transform); if (!t) return undefined;
  const defs = gameplayDefs(world); const dungId = defs.itemId("dung");
  const rng = world.rngFor("dung.drop", animal);
  const ang = rng.next() * Math.PI * 2; const r = rng.next() * DUNG.dropRadius;
  const now = world.tick >>> 0;
  const bag = world.create();
  world.add(bag, Transform, { x: t.x + Math.cos(ang) * r, y: t.y + Math.sin(ang) * r, z: t.z })
    .add(bag, Container, { slotCount: 4 }).add(bag, ContainerViewers)
    .add(bag, LootBag, {
      owner: 0,
      despawnAtTick: Math.min(PERMANENT_DESPAWN - 1, now + secondsToTicks(DUNG.despawnSeconds, 1 / DEFAULT_TICK_HZ)),
      spawnTick: now, kind: LootSource.Animal, emptiedTick: 0,
    });
  addItem(world, bag, dungId, DUNG.count);
  tagLootSource(world, bag, LootSource.Animal); indexEntity(world, bag); return bag;
}
/** Authority production tick (every DUNG_EVERY ticks): seed new animals with a staggered first drop, drop on schedule. */
export function dungSystem(world: World): void {
  if (!isAuthority(world) || world.isReplaying) return;
  const now = world.tick;
  for (const e of [...world.query([Animal, Transform])].sort((a, b) => a - b)) {
    if (world.has(e, Dead)) continue;
    const key = animalDefs()[world.get(e, Animal)?.kind ?? -1]?.key; if (!key || !isDungProducerKey(key)) continue;
    const timer = world.get(e, DungTimer);
    if (!timer) { world.add(e, DungTimer, { nextAt: now + nextDungDelay(world, e, key) }); continue; }
    if (now < timer.nextAt) continue;
    dropDung(world, e);
    world.set(e, DungTimer, { nextAt: now + nextDungDelay(world, e, key) });
  }
}
