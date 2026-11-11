/**
 * ADR-351 rope leading. A player or AI human with rope in their hotbar and equipped can lead a tamed or wild
 * farm animal (and, where sensible, a mount) back to their fenced-in area — their claim, else their home
 * anchor (BotHome / hire anchor). The rope is a visible procedural line between holder and animal (the
 * client draws it from the replicated RopeLead component; no sprite), and the lead is server-authoritative:
 * attach / release go through RopeLeadCmd, ropeSystem drives the follow every tick.
 *
 * Rules (forgiving, not frustrating):
 *  - Attach needs the rope equipped (main hand, like the dye brush's hotbar-tool rule), the animal in
 *    attachRange, leadable species, and ownership (wild: anyone; tamed: the owner or their hired worker;
 *    mounts: mayUseMount; never an animal standing inside someone else's claim). One lead per holder.
 *  - While led the animal follows the holder (walk inside followDistance, run beyond runDistance) through
 *    the same creature navigation as everything else, so fences still contain it (no teleports).
 *  - A zombie near the animal makes it balk (it stops, the lead stays) instead of breaking.
 *  - Too far (past breakDistance) or stuck against a fence / obstacle for stuckSeconds breaks the lead.
 *  - Arriving inside the holder's claim (or at their home anchor) ends the lead cleanly: the animal stays
 *    (its Animal home is reset where it stands).
 *  - Un-equipping the rope, the rope running out, holder death and animal death all end the lead with no
 *    dangling RopeLead. animalAISystem skips led animals, so the rope owns their movement while led.
 */
import { DEFAULT_TICK_HZ, Transform, PlayerId, type CommandHandlers, type Entity, type World } from "@engine/core";
import {
  Anim, Animal, AnimState, BotHome, Dead, Equipment, HotbarSelection, Mount, NO_SLOT, Pet, PrivilegeZone, RopeLead, Tamed, Worker, Zombie,
} from "./components.js";
import { gameplayDefs, isAuthority } from "./config.js";
import { emit, ev } from "./events.js";
import { listSlots, slotItem } from "./inventory.js";
import { animalDefs, populationTile } from "./population.js";
import { mayUseMount, mountOwnerIdFor, playerIdOf } from "./mount_defs.js";
import { tribeOf, zonesAt } from "./building/place.js";
import { creatureStep, type TileBlocked } from "./systems/creature_nav.js";
import { swimSpeedMulAt } from "./systems/movement.js";
import { setAnim } from "./combat/combat.js";
import { ROPE_TUNING as T, animalKeyOfKind, isLeadableKey } from "./rope_defs.js";
import { RopeLeadCmd } from "./rope_commands.js";

const sec = (s: number): number => Math.max(1, Math.round(s * DEFAULT_TICK_HZ));
const dist = (world: World, a: Entity, b: Entity): number => { const p = world.get(a, Transform), q = world.get(b, Transform); return p && q ? Math.hypot(p.x - q.x, p.y - q.y) : Infinity; };
/** Live entity of a PlayerId (owner of a lead), undefined when offline / dead. */
export function holderEntity(world: World, id: number): Entity | undefined {
  if (!id || !world.isRegistered(PlayerId)) return undefined;
  for (const e of world.query([PlayerId, Transform], [Dead])) if (world.getField(e, PlayerId, "id") === id) return e;
  return undefined;
}
/** The animal `holder` currently leads (if any). */
export function ledAnimalOf(world: World, holder: Entity): Entity | undefined {
  const id = mountOwnerIdFor(world, holder); if (!id || !world.isRegistered(RopeLead)) return undefined;
  for (const e of world.query([RopeLead])) if (world.getField(e, RopeLead, "holder") === id) return e;
  return undefined;
}
const ropeIdCache = new WeakMap<World, number>();
/** Item id of `rope` (0 when the item is missing from data — never in the shipped game). */
export function ropeItemId(world: World): number {
  let id = ropeIdCache.get(world); if (id === undefined) { try { id = gameplayDefs(world).itemId("rope"); } catch { id = 0; } ropeIdCache.set(world, id); }
  return id;
}
/** Hotbar-tool rule (Task 25 dye pattern): the rope is equipped when it is the main-hand item, or — for
 *  holders without an Equipment main hand yet — the selected hotbar slot holds it. */
/** True when the rope is equipped in the main hand. Strictly the main hand: HotbarSelection is the *selected* slot and equipSystem leaves it pointing at the rope slot even after the same-slot Equip toggles the main hand off, so a selection fallback would make un-equip never release the lead. (SelectHotbar also sets the main hand, so keyboard/gamepad/touch selection is covered.) */
export function ropeEquipped(world: World, e: Entity): boolean {
  const rope = ropeItemId(world); if (!rope) return false;
  return world.has(e, Equipment) && world.getField(e, Equipment, "mainHandItem") === rope;
}
/** Inventory slot holding rope (lowest slot first), -1 when the holder carries none. For AI equip. */
export function ropeSlotOf(world: World, e: Entity): number {
  const rope = ropeItemId(world); if (!rope) return -1;
  try { for (const s of listSlots(world, e)) if (s.item === rope && s.count > 0) return s.slot; } catch { return -1; }
  return -1;
}
/** True when `e` is an animal the rope may attach to at all (species + state, before ownership / range). */
export function isLeadable(world: World, e: Entity): boolean {
  if (!world.isAlive(e) || world.has(e, Dead) || !world.has(e, Animal) || world.has(e, Pet)) return false;
  if (world.has(e, RopeLead)) return false; // already led (by anyone)
  if (world.has(e, Mount) && (world.getField(e, Mount, "riderNetId") ?? 0) !== 0) return false; // ridden: mountSystem moves it
  return isLeadableKey(animalKeyOfKind(world.getField(e, Animal, "kind") ?? -1));
}
/** Ownership + claim rules for `holder` leading `animal` (wild: anyone; tamed: owner / their hired worker;
 *  mounts: mayUseMount; never an animal standing inside someone else's claim). */
export function mayLead(world: World, holder: Entity, animal: Entity): boolean {
  if (world.has(animal, Mount)) return mayUseMount(world, holder, animal);
  if (world.has(animal, Tamed)) {
    const owner = world.getField(animal, Tamed, "owner");
    if (owner === undefined || owner === 0 || !world.isAlive(owner)) return true; // unowned / owner gone
    if (owner === holder) return true;
    const boss = world.isRegistered(Worker) && world.has(holder, Worker) ? world.getField(holder, Worker, "owner") ?? 0 : 0;
    return boss !== 0 && boss === playerIdOf(world, owner);
  }
  // Wild: not inside someone else's claim (leading livestock out of a foreign pen is stealing).
  const tribe = tribeOf(world, holder); const t = world.get(animal, Transform); if (!t) return false;
  for (const z of zonesAt(world, t.x, t.y)) if ((world.getField(z, PrivilegeZone, "tribe") ?? 0) !== 0 && (world.getField(z, PrivilegeZone, "tribe") ?? 0) !== tribe) return false;
  return true;
}
/** Destination for a lead: the holder's claim (nearest zone of their tribe), else their home anchor
 *  (BotHome, then the hire anchor). Undefined = no fenced-in area yet: the lead runs until released. */
export function leadDestination(world: World, holder: Entity): { x: number; y: number; r: number } | undefined {
  const tribe = tribeOf(world, holder); const ht = world.get(holder, Transform);
  if (tribe && ht) {
    let best: { x: number; y: number; r: number } | undefined; let bd = Infinity;
    for (const z of world.query([PrivilegeZone, Transform])) {
      if ((world.getField(z, PrivilegeZone, "tribe") ?? 0) !== tribe) continue;
      const zt = world.get(z, Transform)!; const d = Math.hypot(zt.x - ht.x, zt.y - ht.y);
      if (d < bd) { bd = d; best = { x: zt.x, y: zt.y, r: world.getField(z, PrivilegeZone, "radius") ?? 0 }; }
    }
    if (best) return best;
  }
  if (world.has(holder, BotHome)) { const h = world.get(holder, BotHome)!; return { x: h.x, y: h.y, r: T.arrivalRadius }; }
  if (world.has(holder, Worker)) { const w = world.get(holder, Worker)!; if (w.homeX || w.homeY) return { x: w.homeX, y: w.homeY, r: T.arrivalRadius }; }
  return undefined;
}

export const enum RopeResult { Attached = 1, Released = 2, Arrived = 3, BrokeFree = 4 }
export const RopeEvent = ev<{ entity: Entity; animal: Entity; result: RopeResult; value: number }>("gameplay.RopeEvent");
export const ROPE_EVENT_TEXT: Readonly<Record<number, string>> = {
  [RopeResult.Attached]: "Leading it home.",
  [RopeResult.Released]: "Released.",
  [RopeResult.Arrived]: "Home — the rope comes off.",
  [RopeResult.BrokeFree]: "It broke free!",
};

/** Attach validation (server re-validates every command): undefined = ok. */
export function checkLead(world: World, holder: Entity, target: Entity): string | undefined {
  if (!world.isAlive(holder) || world.has(holder, Dead)) return "dead";
  if (!world.isAlive(target) || !world.has(target, Animal) || world.has(target, Dead)) return "not_found";
  if (!isLeadable(world, target)) return "not_leadable";
  if (!ropeEquipped(world, holder)) return "no_rope";
  if (ledAnimalOf(world, holder) !== undefined) return "already_led";
  if (!mayLead(world, holder, target)) return "not_owner";
  if (dist(world, holder, target) > T.attachRange) return "too_far";
  return undefined;
}
/** Attach the rope (no checks — callers use checkLead). One lead per holder; the animal keeps its own AI off while led. */
export function attachLead(world: World, holder: Entity, target: Entity): boolean {
  if (!isAuthority(world) || checkLead(world, holder, target)) return false;
  if (!world.isRegistered(RopeLead)) return false;
  world.add(target, RopeLead, { holder: mountOwnerIdFor(world, holder) || playerIdOf(world, holder) });
  emit(world, RopeEvent, { entity: holder, animal: target, result: RopeResult.Attached, value: 0 });
  return true;
}
/** End a lead cleanly: the animal stays where it stands (its Animal home is reset there). No-op when not led. */
export function releaseLead(world: World, animal: Entity, result: RopeResult, holder?: Entity): boolean {
  if (!world.has(animal, RopeLead)) return false;
  const t = world.get(animal, Transform);
  world.remove(animal, RopeLead);
  if (t && world.has(animal, Animal)) world.set(animal, Animal, { homeX: t.x, homeY: t.y, goalX: t.x, goalY: t.y });
  emit(world, RopeEvent, { entity: holder ?? (0 as Entity), animal, result, value: 0 });
  return true;
}

/** Nearest leadable animal in `range` of `e` that `e` may lead (deterministic tie-break by id). Client + AI. */
export function nearestLeadable(world: World, e: Entity, range = T.attachRange): Entity | undefined {
  const t = world.get(e, Transform); if (!t || !world.isRegistered(RopeLead)) return undefined;
  let best: Entity | undefined; let bd = range * range;
  for (const a of world.query([Animal, Transform], [Dead, Pet])) {
    if (!isLeadable(world, a) || !mayLead(world, e, a)) continue;
    const at = world.get(a, Transform)!; const d = (at.x - t.x) ** 2 + (at.y - t.y) ** 2;
    if (d <= bd && (best === undefined || d < bd || a < best)) { bd = d; best = a; }
  }
  return best;
}
/** Panel / overlay view of a lead for `player` looking at `animal` (pure, replica reads only). */
export interface LeadInfo { leadable: boolean; led: boolean; ledByMe: boolean; holderId: number }
export function leadInfo(world: World, player: Entity, animal: Entity): LeadInfo {
  const holderId = world.has(animal, RopeLead) ? world.getField(animal, RopeLead, "holder") ?? 0 : 0;
  const me = mountOwnerIdFor(world, player) || playerIdOf(world, player);
  return { leadable: isLeadable(world, animal) && mayLead(world, player, animal), led: holderId !== 0, ledByMe: holderId !== 0 && holderId === me, holderId };
}

export function installRopeCommands(world: World, handlers: CommandHandlers): void {
  handlers.on(RopeLeadCmd, {
    validate: (v, c) => {
      if (v.target === 0) return ledAnimalOf(world, c.actor) !== undefined ? undefined : "not_found";
      return checkLead(world, c.actor, v.target as Entity);
    },
    handle: (v, c) => {
      if (v.target === 0) { const a = ledAnimalOf(world, c.actor); if (a !== undefined) releaseLead(world, a, RopeResult.Released, c.actor); }
      else attachLead(world, c.actor, v.target as Entity);
    },
  });
}

// ---- system -----------------------------------------------------------------------------------------------
/** Per-lead stuck tracking (server-only): the animal's last position + the tick it last moved from it. */
const stuckOf = new WeakMap<World, Map<Entity, { x: number; y: number; at: number }>>();
const ropeBlocked = (world: World): TileBlocked => { const unwalk = gameplayDefs(world).worldgen.unwalkableTiles; return (tx: number, ty: number): boolean => unwalk.has(populationTile(world, tx, ty)); };
/** Move `e` toward (gx, gy) at `speed` tiles/s through creature navigation; false = did not move. */
function leadStep(world: World, e: Entity, gx: number, gy: number, speed: number, dt: number, stopAt: number): boolean {
  const t = world.get(e, Transform)!; const dx = gx - t.x, dy = gy - t.y, d = Math.hypot(dx, dy); if (d <= stopAt) return false;
  const sp = speed * swimSpeedMulAt(world, t.x, t.y) * dt;
  const nav = creatureStep(world, e, gx, gy, sp, stopAt, ropeBlocked(world), dt);
  if (nav !== undefined) return nav;
  const unwalk = gameplayDefs(world).worldgen.unwalkableTiles; const k = Math.min(sp, d - stopAt) / d;
  const nx = t.x + dx * k, ny = t.y + dy * k;
  if (unwalk.has(populationTile(world, Math.floor(nx), Math.floor(ny)))) {
    if (!unwalk.has(populationTile(world, Math.floor(nx), Math.floor(t.y)))) world.set(e, Transform, { x: nx, facing: Math.atan2(dy, dx) });
    else if (!unwalk.has(populationTile(world, Math.floor(t.x), Math.floor(ny)))) world.set(e, Transform, { y: ny, facing: Math.atan2(dy, dx) });
    else return false; return true;
  }
  world.set(e, Transform, { x: nx, y: ny, facing: Math.atan2(dy, dx) }); return true;
}
/** Authority, every tick: follow the holder, balk at danger, break when too far / stuck, release on arrival. */
export function ropeSystem(world: World, dt: number): void {
  if (!isAuthority(world) || world.isReplaying || !world.isRegistered(RopeLead)) return;
  const leads = [...world.query([RopeLead, Transform])].sort((a, b) => a - b);
  if (leads.length === 0) return;
  const zombies: Entity[] = world.isRegistered(Zombie) ? [...world.query([Zombie, Transform], [Dead])].sort((a, b) => a - b) : [];
  let stuck = stuckOf.get(world); if (!stuck) stuckOf.set(world, (stuck = new Map()));
  for (const e of leads) {
    if (!world.isAlive(e) || world.has(e, Dead)) { if (world.has(e, RopeLead)) world.remove(e, RopeLead); stuck.delete(e); continue; }
    const holderId = world.getField(e, RopeLead, "holder") ?? 0;
    const holder = holderEntity(world, holderId);
    if (holder === undefined || world.has(holder, Dead)) { releaseLead(world, e, RopeResult.Released); stuck.delete(e); continue; }
    if (!ropeEquipped(world, holder)) { releaseLead(world, e, RopeResult.Released, holder); stuck.delete(e); continue; } // un-equipped / rope gone
    const ht = world.get(holder, Transform)!; const t = world.get(e, Transform)!;
    const d = Math.hypot(ht.x - t.x, ht.y - t.y);
    if (d > T.breakDistance) { releaseLead(world, e, RopeResult.BrokeFree, holder); stuck.delete(e); continue; }
    // arrival: inside the holder's claim, or at their home anchor
    const dest = leadDestination(world, holder);
    if (dest && Math.hypot(dest.x - t.x, dest.y - t.y) <= Math.max(dest.r, T.arrivalRadius)) { releaseLead(world, e, RopeResult.Arrived, holder); stuck.delete(e); continue; }
    if (d <= T.followDistance) { stuck.set(e, { x: t.x, y: t.y, at: world.tick }); continue; } // close enough: stand with the holder (not stuck)
    // danger: a zombie near the animal balks it (lead stays, stuck clock pauses)
    let balked = false;
    for (const z of zombies) { const zt = world.get(z, Transform)!; if (Math.hypot(zt.x - t.x, zt.y - t.y) <= T.dangerRadius) { balked = true; break; } }
    if (balked) { if (world.has(e, AnimState)) setAnim(world, e, Anim.Idle); continue; }
    const def = animalDefs()[world.getField(e, Animal, "kind") ?? -1];
    const speed = (d > T.runDistance ? (def?.fleeSpeed ?? 3) : (def?.speed ?? 2)) * T.leadSpeedMul;
    const moved = leadStep(world, e, ht.x, ht.y, speed, dt, T.followDistance * 0.7);
    if (world.has(e, AnimState)) setAnim(world, e, moved ? (d > T.runDistance ? Anim.Run : Anim.Walk) : Anim.Idle);
    // stuck: the animal itself has not moved for stuckSeconds while it should be following (fence in the
    // way). Measured on the animal's own position, NOT on the gap to the holder: a holder walking away
    // steadily keeps the gap constant while the animal runs after them at full speed, and that is
    // following, not stuck (the distance break above is what ends a lead that is stretched too far).
    const prev = stuck.get(e);
    const movedSince = prev ? Math.hypot(t.x - prev.x, t.y - prev.y) : Infinity;
    if (movedSince >= 0.25) stuck.set(e, { x: t.x, y: t.y, at: world.tick });
    else if (prev && world.tick - prev.at >= sec(T.stuckSeconds)) { releaseLead(world, e, RopeResult.BrokeFree, holder); stuck.delete(e); }
  }
}
