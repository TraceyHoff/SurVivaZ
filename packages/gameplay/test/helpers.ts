import { Transform, Weather, World, type EventType } from "@engine/core";
import { gameplayDefs, grantSkillUnlocks, installGameplay, placePiece, snapPlacement, spawnPlayer, type GameplayOptions, type GEvent, type PlayerSpawn } from "../src/index.js";
import type { Entity } from "@engine/core";
/** ADR-221: a player who already learned every station / building-tier unlock (tests about building / crafting, not gating). */
export function spawnLearned(world: World, p: PlayerSpawn): Entity { const e = spawnPlayer(world, p); grantSkillUnlocks(world, e); return e; }

export const DT = 1 / 20;
/** Standalone world; weather pinned to Clear unless `liveWeather` (tests stay independent of weather rolls). */
export function makeWorld(opts: GameplayOptions & { liveWeather?: boolean } = {}, seed = 42, maxEntities = 1 << 14): World {
  const w = new World({ seed, maxEntities });
  const { liveWeather, ...rest } = opts;
  installGameplay(w, rest);
  if (!liveWeather) w.env(Weather).endsAtTick = 0xffffffff;
  return w;
}
export function steps(w: World, n: number): void { for (let i = 0; i < n; i++) w.step(DT); }
/** Collects delivered events of one type. */
export function collect<T>(w: World, type: GEvent<T>): (T & { tick: number })[] { const out: (T & { tick: number })[] = []; w.events.on(type as EventType<T & { tick: number }>, (p) => out.push(p)); return out; }

/** ADR-310: plant a Claim Flag covering nearby tiles (claim_totem privilegeRadius, 32 since ADR-315) so tests can place, repair, or reclaim. */
export function plantClaim(world: World, builder: Entity, x = 0, y = 0): Entity {
  const sn = snapPlacement(world, { piece: gameplayDefs(world).pieceId("claim_totem"), x, y, level: 0, rot: 0, tier: 0, variant: 0 });
  if (typeof sn === "number") throw new Error(`plantClaim snap failed: ${sn}`);
  return placePiece(world, builder, sn, { pay: false });
}

const claimedBuilders = new WeakMap<World, Set<Entity>>();
/** Plant one Claim Flag per builder (ADR-310) so older placement tests keep exercising their original cases. */
export function ensureClaim(world: World, builder: Entity, x?: number, y?: number): void {
  let set = claimedBuilders.get(world);
  if (!set) { set = new Set(); claimedBuilders.set(world, set); }
  if (set.has(builder)) return;
  const t = world.get(builder, Transform);
  plantClaim(world, builder, x ?? t?.x ?? 0, y ?? t?.y ?? 0);
  set.add(builder);
}
