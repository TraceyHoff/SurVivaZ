/**
 * ADR-450: winter ice — still water freezes below 32 °F and becomes walkable, thawing in spring.
 * No new state, no per-lake flags: frozen is a pure function of the season (the blended season mean
 * temperature), so all still water freezes at once and thaws together. The ice visual already ships
 * (render SeasonVisual.ice); this is the walkability half.
 *
 * This module owns FREEZING_C (moved from systems/environment.ts, which imported it for snowAllowed)
 * because movement.ts needs the predicate and environment.ts already imports movement.ts (inWater) —
 * keeping the constant here is the only cycle-free home.
 */
import { Season, seasonAt, type World } from "@engine/core";
import { isFlowWater, isWaterId } from "@engine/world";
import { gameplayDefs } from "./config.js";
import { TerrainRes } from "./world.js";

/** Freezing point in deg C (32 °F) — the same threshold snow uses (snowAllowed). */
export const FREEZING_C = 0;

/**
 * Are the world's still waters frozen right now? The blended season mean temperature
 * (weights × meanTemp) below freezing. The mean — not the instantaneous temperature — is deliberate:
 * the day/night curve would flicker lakes open on mild winter afternoons and shut them at night; the
 * mean is stable within a day and only crosses 0 °C during the 0.75-day season blends, so lakes freeze
 * over a few days in late fall and thaw over a few days in early spring (matching the ice visual's
 * smooth fade). Seasons off (lengthDays 0) is always summer: never frozen. A winter heat wave does NOT
 * thaw the ice in v1 (the predicate ignores weather) — recorded as an open edge.
 *
 * Cached once per world tick (~3.7 µs a call uncached: gameplayDefs + season math) — movementBlocked
 * runs per axis per mover per tick, so it must never be evaluated per mover. The cache key includes the
 * Season env (offsetDays / lengthDays / blendDays) as well as the tick: setSeason changes the season
 * without advancing the tick, and a tick-only key would go stale across it.
 */
const frozenCache = new WeakMap<World, { tick: number; offsetDays: number; lengthDays: number; blendDays: number; frozen: boolean }>();
export function isWaterFrozen(world: World): boolean {
  const hasSeason = world.isRegistered(Season) && world.has(world.environment, Season);
  const s = hasSeason ? world.env(Season) : undefined;
  const c = frozenCache.get(world);
  if (c && c.tick === world.tick && c.offsetDays === (s?.offsetDays ?? 0) && c.lengthDays === (s?.lengthDays ?? 0) && c.blendDays === (s?.blendDays ?? 0)) return c.frozen;
  const env = gameplayDefs(world).environment;
  const st = env.seasons;
  let frozen = false;
  if (st && st.seasons.length > 0) {
    const si = seasonAt(world);
    let mean = 0;
    for (let i = 0; i < st.seasons.length; i++) mean += (si.weights[i] ?? 0) * st.seasons[i]!.meanTemp;
    frozen = mean < FREEZING_C;
  }
  frozenCache.set(world, { tick: world.tick, offsetDays: s?.offsetDays ?? 0, lengthDays: s?.lengthDays ?? 0, blendDays: s?.blendDays ?? 0, frozen });
  return frozen;
}

/**
 * True when the tile (tx, ty) is still water that is frozen right now. "Still" = a water tile that is
 * not flow water — rivers, shovel-dug channels and waterfalls never freeze (their raw height carries
 * the flow encoding; isFlowWater). Without a rawHeightAt accessor the tile cannot be proven to flow,
 * so it is treated as still (the terrainFromTileMap and chunk terrains both provide rawHeightAt).
 */
export function isFrozenWaterAt(world: World, tx: number, ty: number): boolean {
  const terrain = world.getResource(TerrainRes);
  if (!terrain) return false;
  const id = terrain.tileAt(tx, ty);
  if (!isWaterId(id)) return false;
  const raw = terrain.rawHeightAt ? terrain.rawHeightAt(tx, ty) : terrain.heightAt(tx, ty);
  if (isFlowWater(id, raw)) return false;
  return isWaterFrozen(world);
}
