/**
 * Task 33: "Recently Crafted" lists — the most-recently crafted recipes and placed pieces per player
 * (most recent first, capped at RECENT_MAX). Stored on the player entity in the RecentCrafts /
 * RecentBuilds components (networked + persistent: the player codec encodes every component on the
 * player entity, so the lists survive save/reconnect; old saves simply lack the component = empty).
 * Recorded at completion, not at queue time (a queued craft is not crafted yet) and at placement, not
 * at selection (a chosen piece is not built yet). Duplicates move to the front instead of repeating.
 */
import { entityIndex, type ComponentDef, type Entity, type World } from "@engine/core";
import { RECENT_MAX, RecentBuilds, RecentCrafts, RecentFoods } from "./components.js";

function pushRecent(world: World, e: Entity, id: number, comp: ComponentDef, field: "recipe" | "piece"): void {
  if (!world.isRegistered(comp) || id <= 0) return;
  if (!world.has(e, comp)) world.add(e, comp, {});
  const st = world.store(comp); const s = st.slot(entityIndex(e)); if (s < 0) return;
  const data = st.data as unknown as Record<string, number[]>;
  const ids = data[field]!; const n = data.count![s]!;
  const list = [id];
  for (let i = 0; i < n && list.length < RECENT_MAX; i++) { const v = ids[s * RECENT_MAX + i]!; if (v !== 0 && v !== id) list.push(v); }
  for (let i = 0; i < RECENT_MAX; i++) ids[s * RECENT_MAX + i] = list[i] ?? 0;
  data.count![s] = list.length;
  st.markChanged(entityIndex(e));
}

/** Record a finished craft (called from both craft completion paths). */
export function recordRecentCraft(world: World, e: Entity, recipe: number): void { pushRecent(world, e, recipe, RecentCrafts, "recipe"); }
/** Record a placed piece (called from placePiece for real builders; builder 0 = load/worldgen). */
export function recordRecentBuild(world: World, e: Entity, piece: number): void { pushRecent(world, e, piece, RecentBuilds, "piece"); }

/** Most-recently crafted recipe ids (most recent first), or [] when none. */
export function recentCrafts(world: World, e: Entity): number[] {
  const c = world.get(e, RecentCrafts); if (!c) return [];
  return [...c.recipe].slice(0, Math.min(c.count, RECENT_MAX)).filter((v) => v !== 0);
}
/** Most-recently placed piece ids (most recent first), or [] when none. */
export function recentBuilds(world: World, e: Entity): number[] {
  const c = world.get(e, RecentBuilds); if (!c) return [];
  return [...c.piece].slice(0, Math.min(c.count, RECENT_MAX)).filter((v) => v !== 0);
}

/** ADR-470: record one eaten food's diet group. A plain queue (oldest first, capped at RECENT_MAX) —
 * unlike pushRecent above, duplicates are kept: variety is the distinct-group count over the last 8
 * eats, so an old group must fall off once 8 newer eats have passed. */
export function recordRecentFood(world: World, e: Entity, group: number): void {
  if (!world.isRegistered(RecentFoods) || group < 0) return;
  if (!world.has(e, RecentFoods)) world.add(e, RecentFoods, {});
  const st = world.store(RecentFoods); const s = st.slot(entityIndex(e)); if (s < 0) return;
  const data = st.data as unknown as Record<string, number[]>;
  const ids = data.group!; const n = data.count![s]!;
  if (n < RECENT_MAX) { ids[s * RECENT_MAX + n] = group; data.count![s] = n + 1; }
  else {
    for (let i = 0; i < RECENT_MAX - 1; i++) ids[s * RECENT_MAX + i] = ids[s * RECENT_MAX + i + 1]!;
    ids[s * RECENT_MAX + RECENT_MAX - 1] = group;
  }
  st.markChanged(entityIndex(e));
}
/** Diet groups of the last 8 foods eaten (oldest first), or [] when none. */
export function recentFoodGroups(world: World, e: Entity): number[] {
  const c = world.get(e, RecentFoods); if (!c) return [];
  return [...c.group].slice(0, Math.min(c.count, RECENT_MAX));
}
/** Distinct diet groups among the last 8 eats (0..6). */
export function recentFoodGroupCount(world: World, e: Entity): number {
  return new Set(recentFoodGroups(world, e)).size;
}
