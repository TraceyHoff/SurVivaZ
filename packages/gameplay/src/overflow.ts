/**
 * ADR-515 / ADR-516: give items to an actor's pack; what does not fit drops in a Dropped loot bag at its feet (owner =
 * its PlayerId) instead of being lost. Used where the items already existed (demolish refunds, unloaded rounds, a
 * picked-up sign).
 */
import { PlayerId, Transform, type Entity, type World } from "@engine/core";
import { Container, ContainerViewers, LootBag } from "./components.js";
import { gameplayDefs } from "./config.js";
import { addItem } from "./inventory.js";
import { lootBagInit } from "./loot_despawn.js";
import { LootSource, tagLootSource } from "./loot_labels.js";
import { indexEntity } from "./spawn.js";

export function refundOrDrop(world: World, e: Entity, items: readonly { item: number; count: number }[]): Entity | undefined {
  const defs = gameplayDefs(world); const left: { item: number; count: number }[] = [];
  for (const c of items) { const n = addItem(world, e, c.item, c.count); if (n < c.count) left.push({ item: c.item, count: c.count - n }); }
  if (!left.length) return undefined;
  const t = world.get(e, Transform)!; const bag = world.create();
  const slots = left.reduce((a, c) => a + Math.ceil(c.count / Math.max(1, defs.items.get(c.item)?.maxStack ?? 1)), 0);
  world.add(bag, Transform, { x: t.x, y: t.y, z: t.z }).add(bag, Container, { slotCount: Math.max(4, slots) }).add(bag, ContainerViewers)
    .add(bag, LootBag, lootBagInit(world, ownerPidOf(world, e), "dropped", LootSource.Dropped));
  for (const c of left) addItem(world, bag, c.item, c.count);
  tagLootSource(world, bag, LootSource.Dropped); indexEntity(world, bag); return bag;
}
const ownerPidOf = (world: World, e: Entity): number => (world.isRegistered(PlayerId) && world.has(e, PlayerId) ? world.getField(e, PlayerId, "id") ?? 0 : 0);
