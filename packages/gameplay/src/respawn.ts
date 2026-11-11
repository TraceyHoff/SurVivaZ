/**
 * ADR-153: respawn at your bed + death-bag lookups for the client death screen / compass.
 *  - `installBedRespawn` sets the spawn_points respawn locator: a dead player respawns next to the nearest bed they
 *    placed (PieceOwner = their PlayerId), else at the world spawn point NEAREST to where they died (+ jitter), so a
 *    new player (tutorial) comes back to their start area and their bag is close, never across the map.
 *  - `deathBagsOf` lists the LootBags owned by a PlayerId (networked, so it works on a client replica too).
 */
import { PlayerId, Transform, type Entity, type World } from "@engine/core";
import { BuildPiece, LootBag, PieceOwner } from "./components.js";
import { gameplayDefs } from "./config.js";
import { aiRespawnPoint } from "./ai_spawn.js";
import { isAiHuman } from "./skills/xp.js";
import { setRespawnLocator, SPAWN_JITTER, spawnPoints, addSafeSpawnCentreProvider, type SpawnPointXY } from "./spawn_points.js";

/** Piece keys that are sleeping beds (not garden / flower beds). */
export const isBedKey = (key: string): boolean => key === "bed" || key.startsWith("bed_") || key === "bunk_bed";

/** Every owned bed: its footprint plus the beside-bed respawn point. A bed nobody owns (abandoned-site
 * furniture, PieceOwner.player 0) is nobody's respawn point, so it is not listed. */
function bedSpots(world: World): { bx: number; by: number; x: number; y: number; player: number }[] {
  if (!world.isRegistered(BuildPiece) || !world.isRegistered(PieceOwner)) return [];
  const defs = gameplayDefs(world); const out: { bx: number; by: number; x: number; y: number; player: number }[] = [];
  for (const b of world.query([BuildPiece, PieceOwner, Transform])) {
    const player = world.getField(b, PieceOwner, "player") ?? 0; if (!player) continue;
    const key = defs.pieces.get(world.getField(b, BuildPiece, "type")!)?.key; if (!key || !isBedKey(key)) continue;
    const t = world.get(b, Transform)!; out.push({ bx: t.x, by: t.y, x: t.x + 1, y: t.y + 0.5, player }); // beside the bed, not inside its footprint
  }
  return out;
}
/** ADR-348: every owned bed's respawn point — the bed safe centres for inSpawnSafeRadius (same 20-tile
 * radius and rules as the starter points). The list is read live, so a placed bed is protected from the
 * next tick and a demolished bed stops being a centre. */
export function bedSpawnPoints(world: World): SpawnPointXY[] { return bedSpots(world).map((b) => ({ x: b.x, y: b.y })); }

/** Next to the nearest bed `e` owns (nearest to where they are / died), or undefined. */
export function bedRespawnPoint(world: World, e: Entity): SpawnPointXY | undefined {
  if (!world.isRegistered(PlayerId) || !world.has(e, PlayerId)) return undefined;
  const pid = world.getField(e, PlayerId, "id"); if (!pid) return undefined;
  const me = world.get(e, Transform);
  let best: SpawnPointXY | undefined; let bd = Infinity;
  for (const b of bedSpots(world)) {
    if (b.player !== pid) continue;
    const d = me ? (b.bx - me.x) ** 2 + (b.by - me.y) ** 2 : 0;
    if (d < bd) { bd = d; best = { x: b.x, y: b.y }; }
  }
  return best;
}
/** The world spawn point nearest `e` (where they died), with a small deterministic jitter. */
export function nearestSpawnPoint(world: World, e: Entity): SpawnPointXY | undefined {
  const me = world.get(e, Transform); const pts = spawnPoints(world); if (!me || !pts.length) return undefined;
  let best = pts[0]!; for (const q of pts) if ((q.x - me.x) ** 2 + (q.y - me.y) ** 2 < (best.x - me.x) ** 2 + (best.y - me.y) ** 2) best = q;
  const rng = world.rngFor("spawn:pvp.respawn.near", e); const a = rng.range(0, Math.PI * 2), r = SPAWN_JITTER * Math.sqrt(rng.next());
  return { x: best.x + Math.cos(a) * r, y: best.y + Math.sin(a) * r };
}
/** ADR-325: AI humans (not hired workers / clan members) go bed -> home -> a distributed world spawn point instead. */
export function installBedRespawn(world: World): void {
  setRespawnLocator(world, (e) => bedRespawnPoint(world, e) ?? (isAiHuman(world, e) ? aiRespawnPoint(world, e) : undefined) ?? nearestSpawnPoint(world, e));
  // ADR-348: beds are respawn points, so each owned bed is a safe centre (same 20-tile radius, same rules).
  addSafeSpawnCentreProvider(world, "beds", () => bedSpawnPoints(world));
}

export interface DeathBagInfo { bag: Entity; x: number; y: number }
/** Death bags owned by PlayerId `pid`, newest (highest entity) first. */
export function deathBagsOf(world: World, pid: number): DeathBagInfo[] {
  if (!pid || !world.isRegistered(LootBag)) return [];
  const out: DeathBagInfo[] = [];
  for (const b of world.query([LootBag, Transform])) if (world.getField(b, LootBag, "owner") === pid) { const t = world.get(b, Transform)!; out.push({ bag: b, x: t.x, y: t.y }); }
  return out.sort((a, b) => b.bag - a.bag);
}
