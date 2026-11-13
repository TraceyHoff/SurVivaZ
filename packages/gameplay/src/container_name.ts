/**
 * ADR-390: the display name of an open storage container (window title + section heading).
 * Resolves the piece / item / vehicle / loot-bag / mount name so the player can see what they
 * are searching ("Log Store", "Death Bag", "Saddlebag", "Wagon Medium", …).
 */
import { PlayerId, type Entity, type World } from "@engine/core";
import { BuildPiece, LootBag, LootSummary, Mount, Vehicle } from "./components.js";
import { pieceOf } from "./building/links.js";
import { gameplayDefs } from "./config.js";
import { LootSource } from "./loot_labels.js";
import { vehicleDefOf } from "./vehicles.js";

/** Title-case a def key (`log_store` → "Log Store"), same convention as the camper / build lists. */
export const titleCaseKey = (key: string): string => key.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());

function pieceTitle(world: World, piece: Entity): string | undefined {
  const type = world.getField(piece, BuildPiece, "type");
  if (type === undefined) return undefined;
  const key = gameplayDefs(world).pieces.get(type)?.key;
  return key ? titleCaseKey(key) : undefined;
}

function lootContainerTitle(world: World, bag: Entity, player?: Entity): string {
  const source = world.get(bag, LootSummary)?.source ?? world.getField(bag, LootBag, "kind") ?? 0;
  if (source === LootSource.Death) {
    const owner = world.getField(bag, LootBag, "owner") ?? 0;
    const mine = !!player && owner !== 0 && world.isRegistered(PlayerId) && world.has(player, PlayerId)
      && (world.getField(player, PlayerId, "id") ?? 0) === owner;
    return mine ? "Your Bag" : "Death Bag";
  }
  if (source === LootSource.Zombie) return "Zombie Loot";
  if (source === LootSource.Crate) return "Supply Crate";
  return "Loot Bag";
}

/**
 * Window title for the container `entity` (the Container itself, which may be a storage attachment).
 * Fallback "Storage" when the owner cannot be named.
 */
export function containerDisplayName(world: World, entity: Entity, player?: Entity): string {
  if (world.isRegistered(Mount) && world.has(entity, Mount)) return "Saddlebag";
  if (world.isRegistered(Vehicle) && world.has(entity, Vehicle)) {
    const d = vehicleDefOf(world, entity);
    if (d) return titleCaseKey(d.id);
  }
  if (world.isRegistered(LootBag) && world.has(entity, LootBag)) return lootContainerTitle(world, entity, player);
  if (world.isRegistered(BuildPiece) && world.has(entity, BuildPiece)) {
    const n = pieceTitle(world, entity); if (n) return n;
  }
  const owner = pieceOf(world, entity);
  if (owner !== undefined && world.isRegistered(BuildPiece) && world.has(owner, BuildPiece)) {
    const n = pieceTitle(world, owner); if (n) return n;
  }
  return "Storage";
}
