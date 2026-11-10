/**
 * World spawn points (ADR-106). The authority installs the seed's four points (`@engine/world` computeSpawnPoints) with
 * `setSpawnPoints`; joins, human bots and respawns then use `pickSpawnPoint`: the least crowded point (players/bots
 * within CROWD_RADIUS), ties broken by a deterministic rngFor stream, plus a small jitter. Without installed points
 * `spawnPoints(world)` falls back to data/pvp.json spawnPoints. `setRespawnLocator` is the bed / claim hook: when it
 * returns a point for a dead player, respawn uses it instead.
 */
import { defineResource, Transform, type Entity, type World } from "@engine/core";
import pvp from "../data/pvp.json";
import { Dead, Survival } from "./components.js";

export interface SpawnPointXY { x: number; y: number }
const SpawnPointsRes = defineResource<{ points: SpawnPointXY[]; respawnAt?: ((e: Entity) => SpawnPointXY | undefined) | undefined }>("gameplay.SpawnPoints");
/** Players within this many tiles of a spawn point count as crowding it. */
export const CROWD_RADIUS = 24;
/** Task 33: radius (tiles) around every world spawn point kept free of aggressive creatures, so players and
 * AI humans can get started without constantly dying. Larger than the legacy zombie spawner's 16-tile
 * minimum spawn distance, so a fresh arrival is never in immediate danger. */
export const SAFE_SPAWN_RADIUS = 20;
/** ADR-326: extra safe-radius centres beyond the installed world spawn points — the ADR-325 world-wide AI
 * spawn points, synced in by ai_spawn.ts when they are installed or lazily materialised. Same radius, same
 * rules (no aggressive spawns inside; zombies / aggressive animals do not acquire or engage survivors
 * inside; horde zombies exempt): one radius, one predicate, every enforcement site (legacy zombie
 * spawner, zombie acquire, population spawn gate, animal engage) reads inSpawnSafeRadius. The resource
 * lives here, not in ai_spawn.ts, because that module imports this one — a resource defined there would
 * need a second defineResource key here, and resource keys are object identity, so it would never match. */
const ExtraSafePointsRes = defineResource<{ points: SpawnPointXY[]; lazy?: (() => SpawnPointXY[]) | undefined }>("gameplay.ExtraSafeSpawnPoints");
/** Install extra safe-radius centres (ADR-326), eagerly or as a lazy builder run on first read. */
export function setExtraSafeSpawnPoints(world: World, points: readonly SpawnPointXY[] | (() => SpawnPointXY[])): void {
  if (typeof points === "function") world.setResource(ExtraSafePointsRes, { points: [], lazy: points });
  else world.setResource(ExtraSafePointsRes, { points: points.map((p) => ({ x: p.x, y: p.y })) });
}
/** The extra safe-radius centres, materialising a lazy provider on first read — so a lazily installed set
 * is protected from the first spawn check, not only after the first bot spawns. */
export function extraSafeSpawnPoints(world: World): SpawnPointXY[] | undefined {
  const s = world.getResource(ExtraSafePointsRes); if (!s) return undefined;
  if (s.lazy) { s.points = s.lazy().map((p) => ({ x: p.x, y: p.y })); delete s.lazy; }
  return s.points.length ? s.points.map((p) => ({ ...p })) : undefined;
}
/** The authority-installed spawn points, if any (else undefined). The pvp.json fallback is NOT a configured
 * spawn location — a bare world that never installed points (tests, dev) has no safe radius, so zombie and
 * animal behaviour there is unchanged; live servers always install points (server game.ts). */
export function installedSpawnPoints(world: World): SpawnPointXY[] | undefined {
  const s = world.getResource(SpawnPointsRes);
  return s && s.points.length ? s.points.map((p) => ({ ...p })) : undefined;
}
/** True when (x, y) lies within SAFE_SPAWN_RADIUS of any installed world spawn point, or of any ADR-326
 * extra safe centre (the ADR-325 world-wide AI spawn points). */
export function inSpawnSafeRadius(world: World, x: number, y: number): boolean {
  const r2 = SAFE_SPAWN_RADIUS * SAFE_SPAWN_RADIUS;
  const within = (pts: readonly SpawnPointXY[]): boolean => { for (const p of pts) { const dx = x - p.x, dy = y - p.y; if (dx * dx + dy * dy <= r2) return true; } return false; };
  const pts = installedSpawnPoints(world); if (pts && within(pts)) return true;
  const extra = extraSafeSpawnPoints(world); return !!extra && within(extra);
}
/** Default jitter radius around the chosen point (tiles; spawn patches are clear for >= 2 tiles). */
export const SPAWN_JITTER = 2;

const state = (world: World) => { let s = world.getResource(SpawnPointsRes); if (!s) { s = { points: [] }; world.setResource(SpawnPointsRes, s); } return s; };
export function setSpawnPoints(world: World, points: readonly SpawnPointXY[]): void { state(world).points = points.map((p) => ({ x: p.x, y: p.y })); }
/** The world's spawn points (installed ones, else the pvp.json fallback). */
export function spawnPoints(world: World): SpawnPointXY[] {
  const s = world.getResource(SpawnPointsRes); return s?.points.length ? s.points.map((p) => ({ ...p })) : pvp.spawnPoints.map((p) => ({ x: p.x, y: p.y }));
}
/** Bed / claim respawn hook: return a point to respawn `e` there, or undefined for a world spawn point. */
export function setRespawnLocator(world: World, fn: ((e: Entity) => SpawnPointXY | undefined) | undefined): void { state(world).respawnAt = fn; }
export function respawnLocation(world: World, e: Entity): SpawnPointXY | undefined { return world.getResource(SpawnPointsRes)?.respawnAt?.(e); }

/** How many live players / human bots (Survival + Transform) stand within CROWD_RADIUS of each point. */
export function spawnCrowding(world: World, points: readonly SpawnPointXY[], exclude?: Entity): number[] {
  const n = points.map(() => 0);
  for (const e of world.query([Survival, Transform], [Dead])) {
    if (e === exclude) continue; const t = world.get(e, Transform)!;
    points.forEach((p, i) => { if (Math.hypot(t.x - p.x, t.y - p.y) <= CROWD_RADIUS) n[i]!++; });
  }
  return n;
}
/** Least-crowded spawn point (deterministic tie-break via world.rngFor(key, salt)) with jitter. */
export function pickSpawnPoint(world: World, key: string, salt = 0, o: { jitter?: number; exclude?: Entity } = {}): SpawnPointXY & { index: number } {
  const pts = spawnPoints(world); const crowd = spawnCrowding(world, pts, o.exclude); const rng = world.rngFor(`spawn:${key}`, salt);
  const min = Math.min(...crowd); const best = pts.map((_, i) => i).filter((i) => crowd[i] === min);
  const index = best[rng.int(0, best.length)]!; const p = pts[index]!; const j = o.jitter ?? SPAWN_JITTER;
  const a = rng.range(0, Math.PI * 2), r = j * Math.sqrt(rng.next());
  return { x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r, index };
}
