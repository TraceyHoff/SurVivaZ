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
  const left: { item: number; count: number }[] = [];
  for (const c of items) { const n = addItem(world, e, c.item, c.count); if (n < c.count) left.push({ item: c.item, count: c.count - n }); }
  if (!left.length) return undefined;
  const t = world.get(e, Transform)!; return dropOwnedBag(world, { x: t.x, y: t.y, z: t.z ?? 0 }, ownerPidOf(world, e), left);
}
/** ADR-517: a Dropped loot bag owned by `owner` (PlayerId, 0 = nobody) at `at`, sized for `items`. */
export function dropOwnedBag(world: World, at: { x: number; y: number; z: number }, owner: number, items: readonly { item: number; count: number }[]): Entity | undefined {
  const defs = gameplayDefs(world); const list = items.filter((c) => c.count > 0); if (!list.length) return undefined;
  const slots = list.reduce((a, c) => a + Math.ceil(c.count / Math.max(1, defs.items.get(c.item)?.maxStack ?? 1)), 0);
  const bag = world.create();
  world.add(bag, Transform, { x: at.x, y: at.y, z: at.z }).add(bag, Container, { slotCount: Math.max(4, slots) }).add(bag, ContainerViewers)
    .add(bag, LootBag, lootBagInit(world, owner, "dropped", LootSource.Dropped));
  for (const c of list) addItem(world, bag, c.item, c.count);
  tagLootSource(world, bag, LootSource.Dropped); indexEntity(world, bag); return bag;
}
const ownerPidOf = (world: World, e: Entity): number => (world.isRegistered(PlayerId) && world.has(e, PlayerId) ? world.getField(e, PlayerId, "id") ?? 0 : 0);
