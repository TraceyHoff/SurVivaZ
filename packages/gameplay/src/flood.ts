/**
 * ADR-467: rivers that flood — a heavy rain or storm swells sea-level water onto low shore ground, and
 * the flood recedes GRADUALLY over in-game time (Tracey: never a single-step clear). Spring melt raises
 * the lake level by 1 tile (seasonal band); summer drains it, again gradually.
 *  - Seed: on WeatherChanged to Rain (intensity >= rainIntensityMin) or Storm, seed the shore band
 *    (land adjacent to sea-level water, bed <= surface) around each living survivor; spring melt seeds
 *    the same band as a seasonal tile on the season change to Spring. Seeding is event-driven, once per
 *    weather change / season change — no new per-tick scan.
 *  - Advance: floodSystem runs every TERRAIN.flowEveryTicks (8 ticks, the flow cadence) and floods seeded
 *    tiles one tile per step outward, bounded at TERRAIN.flowPerStep (64) per step and maxDistance (3)
 *    tiles from the original shoreline. Flood water is NATURAL water (WATER_TILE with the bed as its raw
 *    height — the raw height never changes, so it renders flat at surface 0 and freezes in winter,
 *    ADR-450), never flow-encoded. A tile with a piece / node / crop on it never floods
 *    (terrainTileBlocked, the flow system's occupancy rule); a dug tile belongs to the dug flow.
 *  - Recession: each flooded tile is a persistent FloodTile entity (origTile, drainTick, kind, dist).
 *    Storm tiles drain drainAfterSeconds after flooding, outermost first (one distance step every
 *    drainStepSeconds), at most drainPerStep per step — the flood shrinks back toward the river over
 *    in-game hours. Seasonal tiles drain in summer, hash-staggered over seasonalDrainDays, so the
 *    spring band thins gradually instead of vanishing at once. After recession the ground is wet
 *    (chunk wetness 1.0) so the flood leaves mud behind (ADR-449).
 *  - Waterfall rule (ADR-383/386): the flood only spreads from sea-level water (surface 0) and never
 *    floods a tile adjacent to water whose surface is not 0 — an elevated lake and its spillway are
 *    flow-encoded at their level, so the flood stops at least one tile short of them and can never
 *    connect the two levels. The seed also only counts ORIGINAL water as a source (a tile already
 *    flooded by an earlier storm is not a source), so a second storm during a recession cannot push
 *    the flood past the 3-tile cap.
 *  - Limits (v1): seeding is around living survivors (a river far from any player does not flood until
 *    a player is near it in a storm); a restart mid-storm loses the seeded frontier (the flood stops
 *    advancing, but already-flooded tiles still drain on schedule — their FloodTile entities persist).
 *    A tile a player fills with earth while flooded drops its flood record (the player's edit stands).
 */
import { DEFAULT_TICK_HZ, defineResource, SeasonId, timeOfDay, Transform, type Entity, type World } from "@engine/core";
import { chunkKeyOf, isWaterId, WATER_TILE } from "@engine/world";
import { ChunkSurface, Dead, FloodTile, Survival } from "./components.js";
import { isAuthority } from "./config.js";
import { secondsToTicks, WeatherKind } from "./defs.js";
import { WeatherChanged } from "./events.js";
import { worldSeason } from "./systems/environment.js";
import { terrainTileBlocked, TERRAIN, waterSurfaceAt } from "./terrain.js";
import { terrainDigAt, tkey, untkey } from "./terrain_depth.js";
import { ensureChunkSurface, TerrainRes, type Terrain } from "./world.js";
import floodRaw from "../data/flood.json";

export interface FloodTuning { drainAfterSeconds: number; drainPerStep: number; drainStepSeconds: number; maxDistance: number; rainIntensityMin: number; seasonalDrainDays: number; seedRadius: number }
export const FLOOD: Readonly<FloodTuning> = floodRaw;
/** Flood kinds: 0 = storm flood, 1 = seasonal spring band. */
export const FLOOD_KIND_STORM = 0, FLOOD_KIND_SEASONAL = 1;
/** drainTick for a seasonal tile before summer sets it (u32 max = never). */
export const FLOOD_DRAIN_NEVER = 0xffffffff;
const DT = 1 / DEFAULT_TICK_HZ;
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

interface FloodSeed { dist: number; kind: number }
interface FloodState { seeded: Map<number, FloodSeed>; lastSeason: number }
export const FloodRes = defineResource<FloodState>("gameplay.Flood");
function floodState(world: World): FloodState { let f = world.getResource(FloodRes); if (!f) world.setResource(FloodRes, (f = { seeded: new Map(), lastSeason: -1 })); return f; }
/** Deterministic per-tile hash (murmur-style finalizer) — staggers the seasonal drain so the spring band thins rather than vanishing at once. */
function tileHash(k: number): number { let x = (k ^ 0x9e3779b9) >>> 0; x = Math.imul(x ^ (x >>> 16), 0x21f0aaad); x = Math.imul(x ^ (x >>> 15), 0x735a2d97); return (x ^ (x >>> 15)) >>> 0; }
/** Sea-level water surface (the flat ADR-182 level). A flood spreads only from water at this surface. */
const SEA_SURFACE = 0;
/** True when (tx,ty) is a water tile whose surface is NOT sea level (an elevated lake, its spillway, or a raised dug channel) — the waterfall-rule exclusion. */
function nonSeaWater(t: Terrain, tx: number, ty: number): boolean { const s = waterSurfaceAt(t, tx, ty); return s !== undefined && s !== SEA_SURFACE; }
/** True when a tile may be flooded: land, loaded, not dug, nothing standing on it, and no non-sea water beside it. */
function floodable(world: World, t: Terrain, tx: number, ty: number): boolean {
  return seedable(world, t, tx, ty) && !terrainTileBlocked(world, tx, ty);
}
/** The cheap half of floodable (no spatial-index occupancy query) — the seed scan calls this per tile in a
 *  box, so it must stay O(1) tile lookups; the occupancy check runs only at flood time, on the <=64 tiles
 *  the advance actually processes. A seeded tile that turns out blocked is dropped by the advance. */
function seedable(world: World, t: Terrain, tx: number, ty: number): boolean {
  if (t.loaded && !t.loaded(tx, ty)) return false;
  const id = t.tileAt(tx, ty); if (id === 0 || isWaterId(id)) return false;
  if (terrainDigAt(world, tx, ty) < 0) return false;
  for (const [dx, dy] of N4) if (nonSeaWater(t, tx + dx, ty + dy)) return false;
  return true;
}
/** True when (tx,ty) has a 4-neighbour that is sea-level water (a flood source). `fromFlood` also counts flood water (the advancing flood); the seed counts original water only. */
function hasSeaSource(t: Terrain, tx: number, ty: number, flooded: ReadonlySet<number> | undefined): boolean {
  for (const [dx, dy] of N4) {
    const nx = tx + dx, ny = ty + dy;
    if (flooded !== undefined && flooded.has(tkey(nx, ny))) continue; // a flood tile is not original water
    if (waterSurfaceAt(t, nx, ny) === SEA_SURFACE) return true;
  }
  return false;
}
/** The set of currently flooded tile keys (from the persistent FloodTile entities) — the seed counts original water only, so a second storm during a recession cannot push past the cap. */
function floodedKeys(world: World): Set<number> {
  const s = new Set<number>();
  for (const e of world.query([FloodTile, Transform])) { const tr = world.get(e, Transform)!; s.add(tkey(Math.floor(tr.x), Math.floor(tr.y))); }
  return s;
}
/** Seed the shore band (dist 1) around (cx,cy): land adjacent to original sea-level water, bed <= surface. kind 0 = storm flood, 1 = seasonal spring band. Returns tiles seeded. */
export function seedFlood(world: World, cx: number, cy: number, radius: number, kind: number): number {
  const t = world.getResource(TerrainRes); if (!t?.setTile) return 0;
  const st = floodState(world); const flooded = floodedKeys(world);
  const r = Math.max(0, Math.floor(radius)); let n = 0;
  for (let y = Math.floor(cy) - r; y <= Math.floor(cy) + r; y++) for (let x = Math.floor(cx) - r; x <= Math.floor(cx) + r; x++) {
    const k = tkey(x, y);
    if (st.seeded.has(k) || flooded.has(k)) continue;
    if (!seedable(world, t, x, y)) continue;
    const bed = t.rawHeightAt ? t.rawHeightAt(x, y) : t.heightAt(x, y);
    if (bed > SEA_SURFACE) continue; // no climbing: flat ground only
    if (!hasSeaSource(t, x, y, flooded)) continue;
    st.seeded.set(k, { dist: 1, kind }); n++;
  }
  return n;
}
/** Seed around every living survivor (the WeatherChanged / season-change entry point). */
function seedAroundSurvivors(world: World, kind: number): number {
  let n = 0;
  for (const e of [...world.query([Survival, Transform])].sort((a, b) => a - b)) {
    if (!world.isAlive(e) || world.has(e, Dead)) continue;
    const tr = world.get(e, Transform)!; n += seedFlood(world, tr.x, tr.y, FLOOD.seedRadius, kind);
  }
  return n;
}
/** Flood one seeded tile as natural water and record it; returns the tile's distance, or 0 when it did not flood. */
function floodTile(world: World, t: Terrain, tx: number, ty: number, dist: number, kind: number): number {
  const setTile = t.setTile; if (!setTile) return 0;
  const origTile = t.tileAt(tx, ty);
  setTile(tx, ty, WATER_TILE); // natural water: the raw height (the bed) is left alone, so it renders flat at surface 0 and freezes
  const drainTick = kind === FLOOD_KIND_STORM
    ? world.tick + secondsToTicks(FLOOD.drainAfterSeconds, DT) + (FLOOD.maxDistance - dist) * secondsToTicks(FLOOD.drainStepSeconds, DT)
    : FLOOD_DRAIN_NEVER; // seasonal: summer sets it
  const e = world.create();
  world.add(e, Transform, { x: tx + 0.5, y: ty + 0.5 }).add(e, FloodTile, { origTile, drainTick, kind, dist });
  return dist;
}
/** Advance the flood one tile per step outward (bounded at TERRAIN.flowPerStep per step). Returns tiles flooded. */
function floodAdvance(world: World, t: Terrain): number {
  const st = floodState(world);
  if (!st.seeded.size) return 0;
  const keys = [...st.seeded.keys()].sort((a, b) => a - b);
  let n = 0;
  for (const k of keys) {
    if (n >= TERRAIN.flowPerStep) break;
    const seed = st.seeded.get(k); if (!seed) continue;
    const [x, y] = untkey(k);
    // A tile that can never flood drops out of the frontier (a later storm re-seeds it if the block clears).
    if (!floodable(world, t, x, y)) { st.seeded.delete(k); continue; }
    const bed = t.rawHeightAt ? t.rawHeightAt(x, y) : t.heightAt(x, y);
    if (bed > SEA_SURFACE) { st.seeded.delete(k); continue; } // raised since seeding: it can never flood at this height
    if (!hasSeaSource(t, x, y, undefined)) continue; // not reached by the water yet — stays seeded
    st.seeded.delete(k);
    floodTile(world, t, x, y, seed.dist, seed.kind);
    n++;
    // A storm flood extends one tile further out; the seasonal band is one tile only.
    if (seed.kind === FLOOD_KIND_STORM && seed.dist < FLOOD.maxDistance) {
      for (const [dx, dy] of N4) {
        const nx = x + dx, ny = y + dy;
        if (isWaterId(t.tileAt(nx, ny))) continue; // already water (lake, flood, or channel) — nothing to seed
        const nk = tkey(nx, ny);
        const ex = st.seeded.get(nk);
        if (ex === undefined || ex.dist > seed.dist + 1) st.seeded.set(nk, { dist: seed.dist + 1, kind: seed.kind });
      }
    }
  }
  return n;
}
/** Recession (gradual, never a single-step clear): revert due flood tiles, earliest drainTick first, at most drainPerStep per step. Returns tiles drained. */
function floodDrain(world: World, t: Terrain): number {
  const setTile = t.setTile; if (!setTile) return 0;
  const due: { e: Entity; tx: number; ty: number; drainTick: number }[] = [];
  for (const e of world.query([FloodTile, Transform])) {
    const f = world.get(e, FloodTile)!; if (f.drainTick > world.tick) continue;
    const tr = world.get(e, Transform)!; due.push({ e, tx: Math.floor(tr.x), ty: Math.floor(tr.y), drainTick: f.drainTick });
  }
  if (!due.length) return 0;
  due.sort((a, b) => (a.drainTick - b.drainTick) || (a.tx - b.tx) || (a.ty - b.ty));
  let n = 0;
  for (const d of due) {
    if (n >= FLOOD.drainPerStep) break;
    const f = world.get(d.e, FloodTile); if (!f) continue;
    if (t.loaded && !t.loaded(d.tx, d.ty)) continue; // chunk unloaded: defer (the tile is still water there, and the record persists)
    if (isWaterId(t.tileAt(d.tx, d.ty))) { setTile(d.tx, d.ty, f.origTile); n++; }
    // else: something else changed the tile (a player filled it with earth) — the flood record just goes away
    // The ground stays wet (wetness 1.0) so the flood leaves mud behind (ADR-449).
    const surf = ensureChunkSurface(world, chunkKeyOf(d.tx, d.ty));
    world.set(surf, ChunkSurface, { wetness: 255 });
    world.destroy(d.e);
  }
  return n;
}
/** Summer: schedule the spring band's drain, hash-staggered over seasonalDrainDays so it thins gradually. */
function startSeasonalDrain(world: World): void {
  const dayTicks = timeOfDay(world).dayLengthTicks; if (dayTicks <= 0) return;
  const window = Math.max(1, Math.round(FLOOD.seasonalDrainDays * dayTicks));
  for (const e of world.query([FloodTile, Transform])) {
    const f = world.get(e, FloodTile)!; if (f.kind !== FLOOD_KIND_SEASONAL || f.drainTick !== FLOOD_DRAIN_NEVER) continue;
    const tr = world.get(e, Transform)!;
    // +1: the drain starts strictly after the summer tick, never in the same call that schedules it.
    world.setField(e, FloodTile, "drainTick", world.tick + 1 + (tileHash(tkey(Math.floor(tr.x), Math.floor(tr.y))) % window));
  }
}
/** Season-change half: spring floods the +1 shore band (seasonal), summer schedules its drain. Fall/winter: nothing. */
function floodSeason(world: World): void {
  const si = worldSeason(world);
  const idx = si.lengthDays > 0 ? si.index : -1; // -1 = seasons off: no seasonal flooding
  const st = floodState(world);
  if (idx === st.lastSeason) return;
  st.lastSeason = idx;
  if (idx === SeasonId.Spring) seedAroundSurvivors(world, FLOOD_KIND_SEASONAL);
  else if (idx === SeasonId.Summer) startSeasonalDrain(world);
}
/** Flood system (every TERRAIN.flowEveryTicks, the flow cadence): season, advance, recede. Authority only.
 *  The season check runs first so a spring band seeds and floods in the same call. */
export function floodSystem(world: World): void {
  if (!isAuthority(world) || world.isReplaying) return;
  const t = world.getResource(TerrainRes); if (!t?.setTile) return;
  floodSeason(world);
  floodAdvance(world, t);
  floodDrain(world, t);
}
/** One gameplay strike per storm, on WeatherChanged (once per world) — the storm seed. */
export function installFlood(world: World): void {
  world.events.on(WeatherChanged, (p: { from: WeatherKind; to: WeatherKind; intensity: number; ticks: number }) => {
    if (!isAuthority(world) || world.isReplaying) return;
    if (p.to !== WeatherKind.Rain && p.to !== WeatherKind.Storm) return;
    if (p.to === WeatherKind.Rain && p.intensity < FLOOD.rainIntensityMin) return;
    seedAroundSurvivors(world, FLOOD_KIND_STORM);
  });
}
/** Tests / tools: how many tiles are seeded for flooding right now. */
export function floodSeededCount(world: World): number { return floodState(world).seeded.size; }
/** Tests / tools: the flooded tiles (entity, tile, kind, drainTick). */
export function floodTiles(world: World): { e: Entity; tx: number; ty: number; kind: number; dist: number; drainTick: number }[] {
  const out: { e: Entity; tx: number; ty: number; kind: number; dist: number; drainTick: number }[] = [];
  for (const e of [...world.query([FloodTile, Transform])].sort((a, b) => a - b)) {
    const f = world.get(e, FloodTile)!; const tr = world.get(e, Transform)!;
    out.push({ e, tx: Math.floor(tr.x), ty: Math.floor(tr.y), kind: f.kind, dist: f.dist, drainTick: f.drainTick });
  }
  return out;
}
