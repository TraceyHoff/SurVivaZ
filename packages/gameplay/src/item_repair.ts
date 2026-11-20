/**
 * ADR-474: tool / weapon repair. A damaged or broken tool / weapon in the pack is repaired in place (durability
 * restored to full) for ~30 % of its own recipe, rounded up per ingredient (the saddle pattern, mounts.ts).
 * First-tier tools (item tier 1: stone, bone) repair anywhere with the resources in the bag; later tiers
 * (tier 2+: bronze, iron, steel, alloy) need an anvil in range (Tracey). Broken tools stay in the inventory
 * until repaired — they never vanish and never become a loot bag — so a repair is always possible from the
 * inventory panel (see ui/menus.ts itemRepairIntent) or by a bot (ai/survivor_behaviors.ts `tool_repair`).
 * The command re-validates everything server-side, so a stale client button or bot sensor can never spend
 * resources the actor no longer has.
 */
import { type CommandHandlers, type Entity, type World } from "@engine/core";
import { Inventory } from "./components.js";
import { gameplayDefs, isAuthority } from "./config.js";
import { StationKind } from "./defs.js";
import { countItem, readSlots, removeItem, slotDurability, slotItem, writeSlots } from "./inventory.js";
import { itemRepairUnlocked } from "./building/place.js";
import { awardXp } from "./skills/progression.js";
import { stationInRange } from "./systems/crafting.js";
import { ItemRepairCmd } from "./item_repair_commands.js";

/** Repair cost for a tool / weapon: ~30 % of its own recipe, rounded up per ingredient (saddle pattern). No recipe = free. */
export function itemRepairCost(world: World, item: number): { item: number; count: number }[] {
  const r = [...gameplayDefs(world).recipes.values()].find((x) => x.output.item === item); if (!r) return [];
  return r.ingredients.map((g) => ({ item: g.item, count: Math.max(1, Math.ceil(g.count * 0.3)) }));
}
/** The item's tier (1 = first tier, stone / bone; 2+ = later tiers). Tier 1 repairs anywhere; tier 2+ needs an anvil. */
export function itemRepairTier(world: World, item: number): number {
  return gameplayDefs(world).items.get(item)?.tier ?? 1;
}
/** Does this slot hold something repairable (a tool or weapon with a durability)? */
export function isRepairableSlot(world: World, e: Entity, slot: number): boolean {
  if (!world.has(e, Inventory)) return false;
  const item = slotItem(world, e, slot).item; if (!item) return false;
  const d = gameplayDefs(world).items.get(item); if (!d || (d.maxDurability ?? 0) <= 0) return false;
  return !!(d.tool || d.weapon);
}
/** Validate a repair (undefined = it can go ahead). Order mirrors the saddle check: slot, repairable, damaged, skill, anvil, cost. */
export function checkItemRepair(world: World, actor: Entity, slot: number): string | undefined {
  if (!world.isAlive(actor) || !world.has(actor, Inventory)) return "bad_slot";
  let v: ReturnType<typeof readSlots>; try { v = readSlots(world, actor); } catch { return "bad_slot"; }
  if (slot < 0 || slot >= v.slotCount || !v.count(slot)) return "empty_slot";
  if (!isRepairableSlot(world, actor, slot)) return "not_repairable";
  const item = v.item(slot); const max = gameplayDefs(world).items.get(item)?.maxDurability ?? 0;
  if (slotDurability(world, actor, slot) >= max) return "not_damaged";
  if (!itemRepairUnlocked(world, actor, item)) return "skill_locked";
  if (itemRepairTier(world, item) > 1 && !stationInRange(world, actor, StationKind.Anvil)) return "needs_anvil";
  for (const c of itemRepairCost(world, item)) if (countItem(world, actor, c.item) < c.count) return "cannot_afford";
  return undefined;
}
/** Repair the tool / weapon in `slot` in place (durability to full), spending the cost. Authority only; returns false when the check fails. */
export function repairItem(world: World, actor: Entity, slot: number): boolean {
  if (!isAuthority(world) || checkItemRepair(world, actor, slot)) return false;
  const item = slotItem(world, actor, slot).item;
  for (const c of itemRepairCost(world, item)) removeItem(world, actor, c.item, c.count);
  // The cost items are recipe ingredients, never the tool itself, so the tool's slot is untouched by the spend above.
  const max = gameplayDefs(world).items.get(item)?.maxDurability ?? 0;
  const v = readSlots(world, actor); v.put(slot, item, v.count(slot), v.created(slot), max, v.crafter(slot)); writeSlots(world, actor, v, gameplayDefs(world));
  awardXp(world, actor, "repair");
  return true;
}
/** Server: wire the repair command into the handler table (called from apps/server/src/game.ts next to installMountCommands). */
export function installItemRepairCommands(world: World, handlers: CommandHandlers): void {
  handlers.on(ItemRepairCmd, {
    validate: (v, c) => checkItemRepair(world, c.actor, v.slot),
    handle: (v, c) => { repairItem(world, c.actor, v.slot); },
  });
}
