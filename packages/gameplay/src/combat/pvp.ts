/**
 * PvP rules (slice 6, authority): death bags, respawn, server hit validation hook, combat tag, raid attribution.
 * Tuning in data/pvp.json. Deterministic: respawn point via world.rngFor; no wall clock; all writes skip replay.
 *  - Death bag: the tick a player (Inventory + Survival) gets Dead, every stack moves (with provenance) into a new
 *    LootBag container at the body; equipment is cleared. Only the owner may loot for bagOwnerOnlySeconds; the bag
 *    despawns per ADR-238 (loot_despawn.ts: timer by kind, short grace once emptied, ground cap).
 *  - Respawn: `respawnPlayer` (or gameplay.respawn command) after respawnSeconds: bed/claim hook or world spawn point, partial vitals, clears
 *    Dead / Burning / CombatTag and every affliction (Task 33: diseases, exposure counters, wetness).
 *  - Hit validation: `setHitValidator(world, fn)`; the combat system calls it for player attackers on the authority
 *    before damage (server wires net validateHit + lag-comp rewind; gameplay cannot import net).
 *  - Combat tag: player-vs-player damage sets CombatTag on both for combatTagSeconds.
 */
import { defineCommand, defineResource, PlayerId, Transform, type CommandHandlers, type Entity, type World } from "@engine/core";
import raw from "../../data/pvp.json";
import { Anim, AnimState, Burning, CombatTag, Container, ContainerViewers, Dead, Equipment, Health, Inventory, LootBag, NO_SLOT, Survival } from "../components.js";
import { gameplayDefs, isAuthority } from "../config.js";
import { secondsToTicks } from "../defs.js";
import { emit, ev } from "../events.js";
import { listSlots, moveSlotTuples } from "../inventory.js";
import { bagSpawnTick, lootBagInit } from "../loot_despawn.js";
import { LootSource, tagLootSource } from "../loot_labels.js";
import { indexEntity } from "../spawn.js";
import { clearAfflictions } from "../diseases.js";
import { pickSpawnPoint, respawnLocation } from "../spawn_points.js";

export interface PvpTuning {
  bagSlots: number; bagOwnerOnlySeconds: number; respawnSeconds: number; respawnHealthFrac: number;
  /** ADR-348: how long a friend-code guest's arrival point stays a safe centre (seconds). */
  guestSafeSeconds: number;
  respawnHunger: number; respawnThirst: number; combatTagSeconds: number; hitConeDeg: number; spawnPoints: { x: number; y: number }[];
  /** Explosive raid rules: own-tribe structure damage multiplier, player damage multiplier, falloff at the edge. */
  explosives: { ownTribeStructureMul: number; playerDamageMul: number; edgeFalloff: number; igniteRadiusFrac: number };
  /** ADR-238 ground despawn (see loot_despawn.ts DESPAWN). */
  despawn: Record<string, number>;
}
export const PVP: Readonly<PvpTuning> = Object.freeze(raw as PvpTuning);
if (!PVP.spawnPoints.length) throw new Error("pvp.json: spawnPoints must not be empty");
const DT = 1 / 20;
/** PlayerId is registered by core permissions (server); standalone worlds may lack it. */
export const hasPlayerId = (world: World, e: Entity): boolean => world.isRegistered(PlayerId) && world.has(e, PlayerId);

export const DeathBagDropped = ev<{ bag: Entity; owner: Entity; ownerId: number; stacks: number }>("gameplay.DeathBagDropped");
export const Respawned = ev<{ entity: Entity; x: number; y: number }>("gameplay.Respawned");
export const HitRejected = ev<{ entity: Entity; target: Entity; reason: string }>("gameplay.HitRejected");
export const GateBreached = ev<{ piece: Entity; attacker: Entity }>("gameplay.GateBreached");
export const PVP_EVENT_RELIABILITY = { "gameplay.DeathBagDropped": "reliable", "gameplay.Respawned": "reliable", "gameplay.HitRejected": "unreliable", "gameplay.GateBreached": "reliable" } as const;

// ---- hit validation hook -----------------------------------------------------------------------------
/** Returns a reject reason or undefined. `reach` is the weapon reach incl. target size; `coneDeg` from pvp.json. */
export type HitValidator = (attacker: Entity, target: Entity, check: { reach: number; coneDeg: number }) => string | undefined;
export const HitValidatorRes = defineResource<{ fn: HitValidator | undefined }>("gameplay.HitValidator");
export function setHitValidator(world: World, fn: HitValidator | undefined): void { world.setResource(HitValidatorRes, { fn }); }
/** Used by the combat system: true = apply damage. Only player attackers (PlayerId) on the authority are checked. */
export function checkHit(world: World, attacker: Entity, target: Entity, reach: number): boolean {
  if (!isAuthority(world) || !hasPlayerId(world, attacker)) return true;
  const fn = world.getResource(HitValidatorRes)?.fn; if (!fn) return true;
  const reason = fn(attacker, target, { reach, coneDeg: PVP.hitConeDeg }); if (reason === undefined) return true;
  if (!world.isReplaying) emit(world, HitRejected, { entity: attacker, target, reason }); return false;
}

// ---- combat tag --------------------------------------------------------------------------------------
export function tagCombat(world: World, a: Entity, b: Entity): void {
  if (!isAuthority(world) || world.isReplaying || a === b || !hasPlayerId(world, a) || !hasPlayerId(world, b)) return;
  const until = world.tick + secondsToTicks(PVP.combatTagSeconds, DT);
  for (const e of [a, b]) if (world.has(e, CombatTag)) world.setField(e, CombatTag, "untilTick", until); else world.add(e, CombatTag, { untilTick: until });
}
export const inCombat = (world: World, e: Entity): boolean => (world.getField(e, CombatTag, "untilTick") ?? 0) > world.tick;

// ---- death bags ----------------------------------------------------------------------------------------
export function dropDeathBag(world: World, e: Entity): Entity | undefined {
  if (!isAuthority(world) || world.isReplaying || !world.has(e, Inventory)) return undefined;
  const moves = listSlots(world, e).filter((s) => s.item && s.count).map((s) => ({ slot: s.slot, count: s.count }));
  if (world.has(e, Equipment)) world.set(e, Equipment, { mainHandSlot: NO_SLOT, mainHandItem: 0 });
  if (!moves.length) return undefined;
  const t = world.get(e, Transform)!; const bag = world.create(); const ownerId = (hasPlayerId(world, e) ? world.getField(e, PlayerId, "id") : undefined) ?? 0;
  world.add(bag, Transform, { x: t.x, y: t.y, z: t.z }).add(bag, Container, { slotCount: Math.max(PVP.bagSlots, moves.length) }).add(bag, ContainerViewers)
    .add(bag, LootBag, lootBagInit(world, ownerId, "death", LootSource.Death));
  moveSlotTuples(world, e, bag, moves); tagLootSource(world, bag, LootSource.Death); indexEntity(world, bag);
  emit(world, DeathBagDropped, { bag, owner: e, ownerId, stacks: moves.length }); return bag;
}
/** Loot gate (container open / withdraw): owner-only window after the drop. Only death bags get the window: a
 *  voluntarily dropped item is on the ground for anyone to pick up, so applying the death-bag lock to dropped
 *  stacks made dropped items unlootable for 60s with no explanation. `tick` is the authoritative server tick
 *  (replicas must pass their server-tick estimate, not their local world.tick). */
export function canLootBagAt(world: World, actor: Entity, bag: Entity, tick: number): boolean {
  const lb = world.get(bag, LootBag); if (!lb) return true; if (lb.owner === 0) return true;
  if (lb.kind !== LootSource.Death) return true;
  const dropped = bagSpawnTick(lb); // ADR-238: stored spawn tick (legacy saves: derived)
  return (hasPlayerId(world, actor) ? world.getField(actor, PlayerId, "id") : undefined) === lb.owner || tick >= dropped + secondsToTicks(PVP.bagOwnerOnlySeconds, DT);
}
/** Server-side form: tick = world.tick. */
export function canLootBag(world: World, actor: Entity, bag: Entity): boolean { return canLootBagAt(world, actor, bag, world.tick); }
/** ADR-160 bare-handed loot: the nearest LootBag within container reach (and closer than `within`) the actor may open. */
export function handLootTarget(world: World, actor: Entity, within = Infinity): Entity | undefined {
  const t = world.get(actor, Transform); if (!t) return undefined;
  let bd = Math.min(gameplayDefs(world).building.containerReach, within); let best: Entity | undefined;
  for (const b of world.query([LootBag, Transform])) {
    const bt = world.get(b, Transform)!; const d = Math.hypot(bt.x - t.x, bt.y - t.y);
    if (d <= bd && canLootBag(world, actor, b)) { bd = d; best = b; }
  }
  return best;
}
/** simulation, right after gameplay.death: bags for players that died this tick. */
export function deathBagSystem(world: World): void {
  if (!isAuthority(world) || world.isReplaying) return;
  for (const e of [...world.query([Dead, Inventory, Survival])].sort((a, b) => a - b)) if (world.getField(e, Dead, "tick") === world.tick) dropDeathBag(world, e);
}
/** postSim despawn: see loot_despawn.ts (ADR-238). */
export { lootBagDespawnSystem } from "../loot_despawn.js";

// ---- respawn ------------------------------------------------------------------------------------------
export type RespawnReject = "not_dead" | "too_soon" | undefined;
export function canRespawn(world: World, e: Entity): RespawnReject {
  const at = world.getField(e, Dead, "tick"); if (at === undefined || !world.has(e, Survival)) return "not_dead";
  return world.tick < at + secondsToTicks(PVP.respawnSeconds, DT) ? "too_soon" : undefined;
}
export function respawnPlayer(world: World, e: Entity): RespawnReject {
  const r = canRespawn(world, e); if (r || !isAuthority(world) || world.isReplaying) return r;
  // bed / claim hook first (setRespawnLocator), else the least crowded world spawn point (+ jitter), ADR-106
  const p = respawnLocation(world, e) ?? pickSpawnPoint(world, "pvp.respawn", e, { exclude: e });
  const vt = gameplayDefs(world).vitals; const max = world.getField(e, Health, "max") ?? vt.maxHealth;
  world.remove(e, Dead); if (world.has(e, Burning)) world.remove(e, Burning); if (world.has(e, CombatTag)) world.remove(e, CombatTag);
  clearAfflictions(world, e); // Task 33: death clears diseases / illnesses / wetness — respawn with no health issues
  world.set(e, Transform, { x: p.x, y: p.y });
  world.setField(e, Health, "hp", Math.max(1, max * PVP.respawnHealthFrac));
  world.setField(e, Survival, "hunger", PVP.respawnHunger); world.setField(e, Survival, "thirst", PVP.respawnThirst); world.setField(e, Survival, "stamina", world.getField(e, Survival, "maxStamina")!);
  world.setField(e, Survival, "bodyTemp", vt.bodyTempNormal); // ADR-252: a hypothermic corpse respawned at 30 C and died again within seconds
  if (world.has(e, AnimState)) world.set(e, AnimState, { anim: Anim.Idle, startTick: world.tick });
  emit(world, Respawned, { entity: e, x: p.x, y: p.y }); return undefined;
}

export const RespawnCmd = defineCommand("gameplay.respawnPlayer", {});
export const PVP_COMMANDS = [RespawnCmd] as const;
export function installPvp(world: World, handlers?: CommandHandlers): void {
  void world; if (!handlers) return;
  handlers.on(RespawnCmd, { validate: (_v, ctx) => canRespawn(world, ctx.actor), handle: (_v, ctx) => { respawnPlayer(world, ctx.actor); } });
}
