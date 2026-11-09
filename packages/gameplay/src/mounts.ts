/**
 * ADR-319 mounts (taming, riding) + ADR-320 saddles (tiers, defense, saddlebag). Server-authoritative; riding movement is
 * the shared applyRidingInput (systems/movement.ts) so client prediction matches. Data: data/mounts.json via mount_defs.ts.
 *
 * - A wild animal of a rideable species (horse, donkey, deer, elk, moose, buffalo, yak) is tamed by feeding it foods it likes
 *   (MountFeedCmd) once the rider has the "mount:tame" unlock (Horsemanship). Each feed adds progress scaled by how much it
 *   likes the food, the species' difficulty and the `tame` skill mod; it can spook (bolt, progress lost) or kick (wild
 *   species with an attack). Progress decays when feeding stops. At 100 the animal becomes a Mount owned like a
 *   PieceOwner: by the tamer's PlayerId (a hired worker tames for their employer) and the tamer's tribe.
 * - Mounts never get Tamed (no husbandry breeding / produce); population treats Mount like Tamed (no flee, no despawn,
 *   persisted). Health is rebuilt from Mount.hp after a load (Health is not persistent), like pets.
 * - Riding: MountRideCmd (Use / Interact on your mount), MountDismountCmd. A rider has Riding; the mount follows the rider's
 *   Transform each tick (mountSystem) and is skipped by animal AI. Disconnect / rider death / mount death dismount;
 *   the mount stays where it is (home reset there).
 * - Saddles: a saddle item (tiers 1-4) goes on with MountSaddleCmd and opens a saddlebag (the mount's own Container,
 *   3 / 5 / 7 / 9 slots) through the normal container UI (OpenContainer intent; ADR-303). Defense counts for rider and
 *   mount (arms.ts armorOf). Durability wears with damage taken and is repaired with MountRepairCmd (ADR-310 style).
 */
import { DEFAULT_TICK_HZ, entityIndex, NetId, Transform, type CommandHandlers, type Entity, type World } from "@engine/core";
import {
  Anim, AnimState, Animal, Container, ContainerViewers, Dead, Driver, Health, IntentAction, LootBag, Mount, MOUNT_NAME_MAX, MountTaming, Pet, PlayerIntent,
  Riding, Tamed, Viewing,
} from "./components.js";
import { gameplayDefs, isAuthority } from "./config.js";
import { emit, ev, Damaged } from "./events.js";
import { countItem, listSlots, moveSlotTuples, readSlots, removeItem, slotsAdd, slotsCanAdd, takeFromSlot, writeSlots } from "./inventory.js";
import { animalDefs, AnimalState } from "./population.js";
import { applyDamage, setAnim } from "./combat/combat.js";
import { awardXp } from "./skills/progression.js";
import { hasSkillUnlock, skillMod } from "./skills/tree.js";
import { movementBlocked } from "./systems/movement.js";
import { stanceMode } from "./stance.js";
import { itemRepairUnlocked, tribeOf } from "./building/place.js";
import { closeContainer } from "./building/actions.js";
import { LootSource, tagLootSource } from "./loot_labels.js";
import { lootBagInit } from "./loot_despawn.js";
import { indexEntity } from "./spawn.js";
import {
  canOpenSaddlebag, foodPref, mayUseMount, mountOfRider, mountOwnerIdFor, mountSpecies, mountSpeciesOfAnimal, MOUNT_TUNING as T,
  saddleOfItemKey, saddleOfTier, saddleSlots,
} from "./mount_defs.js";
import { MountDismountCmd, MountFeedCmd, MountRenameCmd, MountRepairCmd, MountRideCmd, MountSaddleCmd, MountUnsaddleCmd } from "./mount_commands.js";

/** Skill-tree token that allows taming / riding (Horsemanship node, husbandry branch). */
export const MOUNT_TAME_TOKEN = "mount:tame";
export const enum MountResult {
  Progress = 1, Tamed = 2, Spooked = 3, Kicked = 4, Fed = 5, Mounted = 6, Dismounted = 7, Saddled = 8, Unsaddled = 9,
  Repaired = 10, Blocked = 11, Died = 12, Renamed = 13, Refused = 14,
}
/** Feedback for the acting player (toasts / panel refresh); value = progress %, item id or a blocked IntentAction. */
export const MountEvent = ev<{ entity: Entity; mount: Entity; result: MountResult; value: number }>("gameplay.MountEvent");

const netIdOf = (world: World, e: Entity): number => world.getField(e, NetId, "id") ?? 0;
const near = (world: World, a: Entity, b: Entity, r: number): boolean => { const p = world.get(a, Transform), q = world.get(b, Transform); return !!p && !!q && Math.hypot(p.x - q.x, p.y - q.y) <= r; };
const reach = T.interactRange + 0.75;
const itemKey = (world: World, id: number): string | undefined => gameplayDefs(world).items.get(id)?.key;
const animalKeyOf = (world: World, e: Entity): string | undefined => { const k = world.getField(e, Animal, "kind"); return k === undefined ? undefined : animalDefs()[k]?.key; };
/** Rideable species index of an animal entity: its Mount.species, else from its archetype (0 = not rideable). */
export function speciesOf(world: World, e: Entity): number {
  if (world.has(e, Mount)) return world.getField(e, Mount, "species") ?? 0;
  return world.has(e, Animal) ? mountSpeciesOfAnimal(animalKeyOf(world, e)) : 0;
}
/** Entity carrying Riding whose NetId is `id` (few riders: linear scan). */
function riderByNetId(world: World, id: number): Entity | undefined {
  if (!id) return undefined; for (const r of world.query([Riding, NetId])) if (world.getField(r, NetId, "id") === id) return r; return undefined;
}
/** The rider currently linked both ways to mount `m` (Mount.riderNetId <-> Riding.mountNetId), else undefined. */
export function liveRider(world: World, m: Entity): Entity | undefined {
  const r = riderByNetId(world, world.getField(m, Mount, "riderNetId") ?? 0);
  return r !== undefined && world.getField(r, Riding, "mountNetId") === netIdOf(world, m) ? r : undefined;
}
export const isRiding = (world: World, e: Entity): boolean => world.isRegistered(Riding) && world.has(e, Riding);
export { mountOfRider };

// ---- taming ---------------------------------------------------------------------------------------------------
export function checkFeed(world: World, actor: Entity, target: Entity, item: number): string | undefined {
  if (!world.isAlive(target) || !world.has(target, Animal) || world.has(target, Dead)) return "not_found";
  if (world.has(target, Pet) || world.has(target, Tamed)) return "not_tameable";
  const sp = speciesOf(world, target); if (!sp) return "not_tameable";
  if (!near(world, actor, target, reach)) return "too_far";
  if (countItem(world, actor, item) <= 0) return "no_item";
  if (!foodPref(sp, itemKey(world, item))) return "not_food";
  if (world.has(target, Mount)) {
    if (!mayUseMount(world, actor, target)) return "not_owner";
    const h = world.get(target, Health); if (h && h.hp >= h.max - 0.5) return "full_health";
    return undefined;
  }
  if (!hasSkillUnlock(world, actor, MOUNT_TAME_TOKEN)) return "needs_skill";
  if (isRiding(world, actor)) return "riding";
  return undefined;
}
const PREF_MUL = { love: 0.5, like: 0.8, ok: 1 } as const;
/** Feeds one `item` (validated by checkFeed). Wild: taming progress (may spook / kick). Owned mount: heals. */
export function feedMount(world: World, actor: Entity, target: Entity, item: number): MountResult | undefined {
  if (!isAuthority(world) || checkFeed(world, actor, target, item)) return undefined;
  const sp = speciesOf(world, target); const spec = mountSpecies(sp)!; const pref = foodPref(sp, itemKey(world, item))!;
  removeItem(world, actor, item, 1); setAnim(world, target, Anim.Eat);
  const say = (result: MountResult, value: number): MountResult => { emit(world, MountEvent, { entity: actor, mount: target, result, value }); return result; };
  if (world.has(target, Mount)) {
    const h = world.get(target, Health)!; const hp = Math.min(h.max, h.hp + T.feedHeal * (pref === "love" ? 1.5 : pref === "like" ? 1.2 : 1));
    world.set(target, Health, { hp }); world.set(target, Mount, { hp }); awardXp(world, actor, "husbandry"); return say(MountResult.Fed, item);
  }
  const by = mountOwnerIdFor(world, actor) || entityIndex(actor);
  const cur = world.get(target, MountTaming);
  let progress = cur && cur.by === by ? cur.progress : 0;
  const rng = world.rngFor("mount.tame", target);
  const spook = T.spookBase * spec.tameDifficulty * (1 - progress / 100) * PREF_MUL[pref] * (1 - Math.min(0.9, skillMod(world, actor, "tame")));
  if (rng.next() < spook) {
    progress = Math.max(0, progress - T.spookLoss);
    const def = animalDefs()[world.getField(target, Animal, "kind") ?? 0];
    world.has(target, MountTaming) ? world.set(target, MountTaming, { progress, by, lastTick: world.tick }) : world.add(target, MountTaming, { progress, by, lastTick: world.tick });
    if (def?.attack && rng.next() < 0.5) { applyDamage(world, actor, T.kickDamage, target); setAnim(world, target, Anim.Attack); return say(MountResult.Kicked, Math.round(progress)); }
    const at = world.get(actor, Transform), mt = world.get(target, Transform)!; const ang = at ? Math.atan2(mt.y - at.y, mt.x - at.x) : 0;
    world.set(target, Animal, { state: AnimalState.Wander, goalX: mt.x + Math.cos(ang) * 4, goalY: mt.y + Math.sin(ang) * 4, thinkAt: world.tick + 3 * DEFAULT_TICK_HZ });
    return say(MountResult.Spooked, Math.round(progress));
  }
  progress += (T.prefGain[pref] * (1 + skillMod(world, actor, "tame"))) / spec.tameDifficulty;
  if (progress >= 100) { tameMount(world, actor, target); awardXp(world, actor, "tame"); return say(MountResult.Tamed, 100); }
  world.has(target, MountTaming) ? world.set(target, MountTaming, { progress, by, lastTick: world.tick }) : world.add(target, MountTaming, { progress, by, lastTick: world.tick });
  awardXp(world, actor, "husbandry"); return say(MountResult.Progress, Math.round(progress));
}
/** Makes `target` a Mount owned by `tamer` (player, AI human or a worker's employer) and the tamer's tribe. */
export function tameMount(world: World, tamer: Entity, target: Entity): Entity {
  const sp = speciesOf(world, target); const spec = mountSpecies(sp); if (!spec) throw new Error("not a rideable species");
  if (world.has(target, MountTaming)) world.remove(target, MountTaming);
  const hp = spec.hp; const t = world.get(target, Transform);
  world.add(target, Mount, { species: sp, kind: world.getField(target, Animal, "kind") ?? 0, owner: mountOwnerIdFor(world, tamer), tribe: tribeOf(world, tamer), hp });
  world.set(target, Health, { hp, max: hp });
  if (t) world.set(target, Animal, { state: AnimalState.Idle, homeX: t.x, homeY: t.y, goalX: t.x, goalY: t.y });
  ensureBag(world, target); return target;
}
/** Spawns an already-tamed mount (tests, admin / dev kits, AI planner hooks). */
export function makeMount(world: World, animalKey: string, x: number, y: number, owner: Entity | 0 = 0): Entity {
  const kind = animalDefs().findIndex((a) => a.key === animalKey); if (kind < 0) throw new Error(`unknown animal ${animalKey}`);
  const sp = mountSpeciesOfAnimal(animalKey); const spec = mountSpecies(sp); if (!spec) throw new Error(`${animalKey} is not rideable`);
  const e = world.create();
  world.add(e, Transform, { x, y }).add(e, Health, { hp: spec.hp, max: spec.hp }).add(e, Animal, { kind, homeX: x, homeY: y, goalX: x, goalY: y, thinkAt: world.tick })
    .add(e, AnimState, { anim: Anim.Idle, startTick: world.tick })
    .add(e, Mount, { species: sp, kind, owner: owner ? mountOwnerIdFor(world, owner) : 0, tribe: owner ? tribeOf(world, owner) : 0, hp: spec.hp });
  ensureBag(world, e); indexEntity(world, e); return e;
}
function ensureBag(world: World, m: Entity): void {
  const slots = saddleSlots(world.getField(m, Mount, "saddle") ?? 0);
  if (!world.has(m, Container)) world.add(m, Container, { slotCount: slots }); else if ((world.getField(m, Container, "slotCount") ?? 0) !== slots) world.set(m, Container, { slotCount: slots });
  if (!world.has(m, ContainerViewers)) world.add(m, ContainerViewers);
}

// ---- riding ---------------------------------------------------------------------------------------------------
export function checkRide(world: World, actor: Entity, m: Entity): string | undefined {
  if (!world.isAlive(m) || !world.has(m, Mount) || world.has(m, Dead)) return "not_mount";
  if (world.has(actor, Dead)) return "dead";
  if (isRiding(world, actor) || world.has(actor, Driver)) return "already_riding";
  if (!mayUseMount(world, actor, m)) return "not_owner";
  if (!hasSkillUnlock(world, actor, MOUNT_TAME_TOKEN)) return "needs_skill";
  if (!near(world, actor, m, reach)) return "too_far";
  if (stanceMode(world, actor) !== 0) return "busy";
  if (liveRider(world, m) !== undefined) return "mount_busy";
  const lh = gameplayDefs(world).building.levelHeight; const z = world.getField(actor, Transform, "z") ?? 0; if (Math.round(z / lh) !== 0) return "blocked";
  if (!netIdOf(world, actor) || !netIdOf(world, m)) return "not_found";
  return undefined;
}
export function rideMount(world: World, actor: Entity, m: Entity): boolean {
  if (!isAuthority(world) || checkRide(world, actor, m)) return false;
  const mt = world.get(m, Transform)!; const sp = world.getField(m, Mount, "species") ?? 0;
  if (world.has(actor, Viewing) && world.getField(actor, Viewing, "container") !== m) closeContainer(world, actor);
  world.add(actor, Riding, { mountNetId: netIdOf(world, m), species: sp, speed: 0, hurt: hurtFlag(world, m) });
  world.set(m, Mount, { riderNetId: netIdOf(world, actor) });
  world.set(actor, Transform, { x: mt.x, y: mt.y, facing: mt.facing ?? 0 });
  world.set(m, Animal, { state: AnimalState.Idle });
  emit(world, MountEvent, { entity: actor, mount: m, result: MountResult.Mounted, value: sp }); return true;
}
const hurtFlag = (world: World, m: Entity): number => { const h = world.get(m, Health); return h && h.hp < h.max * T.lowHpFrac ? 1 : 0; };
/** Gets `rider` off (any reason). The rider steps to a free spot beside the mount; the mount stays put. */
export function dismount(world: World, rider: Entity, quiet = false): boolean {
  if (!isRiding(world, rider)) return false;
  const m = mountOfRider(world, rider); world.remove(rider, Riding);
  const t = world.get(rider, Transform);
  if (m !== undefined && world.isAlive(m)) {
    if (world.has(m, Mount)) world.set(m, Mount, { riderNetId: 0 });
    const mt = world.get(m, Transform);
    if (mt) {
      if (world.has(m, Animal)) world.set(m, Animal, { state: AnimalState.Idle, homeX: mt.x, homeY: mt.y, goalX: mt.x, goalY: mt.y, thinkAt: world.tick + 2 * DEFAULT_TICK_HZ });
      if (t && !world.has(rider, Dead)) { const p = dismountSpot(world, mt.x, mt.y, mt.facing ?? 0); world.set(rider, Transform, { x: p.x, y: p.y }); }
    }
  }
  if (!quiet) emit(world, MountEvent, { entity: rider, mount: m ?? (0 as Entity), result: MountResult.Dismounted, value: 0 }); return true;
}
/** Free ground beside the mount: left, right, behind, ahead; else the mount's own tile. */
export function dismountSpot(world: World, x: number, y: number, facing: number): { x: number; y: number } {
  const d = T.dismountOffset;
  for (const a of [facing + Math.PI / 2, facing - Math.PI / 2, facing + Math.PI, facing]) {
    const nx = x + Math.cos(a) * d, ny = y + Math.sin(a) * d; if (!movementBlocked(world, x, y, nx, ny, 0)) return { x: nx, y: ny };
  }
  return { x, y };
}

// ---- saddles (ADR-320) ----------------------------------------------------------------------------------------
export function checkSaddle(world: World, actor: Entity, m: Entity, slot: number): string | undefined {
  if (!world.isAlive(m) || !world.has(m, Mount) || world.has(m, Dead)) return "not_mount";
  if (!mayUseMount(world, actor, m)) return "not_owner";
  if (!near(world, actor, m, reach)) return "too_far";
  const v = readSlots(world, actor); if (slot >= v.slotCount || !v.count(slot)) return "no_item";
  const sd = saddleOfItemKey(itemKey(world, v.item(slot))); if (!sd) return "not_saddle";
  const cur = world.getField(m, Mount, "saddle") ?? 0;
  if (cur && !canReturnItem(world, actor, world.getField(m, Mount, "saddleItem") ?? 0, slot, v.item(slot))) return "no_room";
  for (const s of listSlots(world, m)) if (s.slot >= sd.slots) return "bag_too_full"; // a smaller saddle needs the extra slots emptied first
  return undefined;
}
/** True when `actor` can take back `item` after giving one of `slotItem` from `slot` (the freed space counts). */
function canReturnItem(world: World, actor: Entity, item: number, slot: number, slotItemId: number): boolean {
  const defs = gameplayDefs(world); const v = readSlots(world, actor); v.put(slot, slotItemId, v.count(slot) - 1);
  return slotsCanAdd(v, item, 1, defs) >= 1;
}
function giveSaddleBack(world: World, actor: Entity, item: number, dur: number): boolean {
  const defs = gameplayDefs(world); const v = readSlots(world, actor);
  if (slotsAdd(v, item, 1, defs, world.tick, dur) !== 1) return false; writeSlots(world, actor, v, defs); return true;
}
export function saddleMount(world: World, actor: Entity, m: Entity, slot: number): boolean {
  if (!isAuthority(world) || checkSaddle(world, actor, m, slot)) return false;
  const v = readSlots(world, actor); const item = v.item(slot); const sd = saddleOfItemKey(itemKey(world, item))!;
  const maxDur = gameplayDefs(world).items.get(item)?.maxDurability || sd.durability;
  const dur = Math.min(maxDur, v.durability(slot) || maxDur);
  if (takeFromSlot(world, actor, slot) !== item) return false;
  const old = world.get(m, Mount)!; if (old.saddle && old.saddleItem) giveSaddleBack(world, actor, old.saddleItem, old.saddleDur);
  world.set(m, Mount, { saddle: sd.tier, saddleItem: item, saddleDur: dur }); ensureBag(world, m);
  emit(world, MountEvent, { entity: actor, mount: m, result: MountResult.Saddled, value: sd.tier }); return true;
}
export function checkUnsaddle(world: World, actor: Entity, m: Entity): string | undefined {
  if (!world.isAlive(m) || !world.has(m, Mount)) return "not_mount";
  if (!mayUseMount(world, actor, m)) return "not_owner";
  if (!near(world, actor, m, reach)) return "too_far";
  const mm = world.get(m, Mount)!; if (!mm.saddle) return "no_saddle";
  if (listSlots(world, m).length) return "bag_not_empty";
  if (slotsCanAdd(readSlots(world, actor), mm.saddleItem, 1, gameplayDefs(world)) < 1) return "no_room";
  return undefined;
}
export function unsaddleMount(world: World, actor: Entity, m: Entity): boolean {
  if (!isAuthority(world) || checkUnsaddle(world, actor, m)) return false;
  const mm = world.get(m, Mount)!; if (!giveSaddleBack(world, actor, mm.saddleItem, mm.saddleDur)) return false;
  world.set(m, Mount, { saddle: 0, saddleItem: 0, saddleDur: 0 }); ensureBag(world, m);
  emit(world, MountEvent, { entity: actor, mount: m, result: MountResult.Unsaddled, value: 0 }); return true;
}
/** Repair cost: ~30 % (rounded up) of the saddle's recipe ingredients; needs the saddle's Saddlery unlock. */
export function saddleRepairCost(world: World, item: number): { item: number; count: number }[] {
  const r = [...gameplayDefs(world).recipes.values()].find((x) => x.output.item === item); if (!r) return [];
  return r.ingredients.map((g) => ({ item: g.item, count: Math.max(1, Math.ceil(g.count * 0.3)) }));
}
export function checkRepair(world: World, actor: Entity, m: Entity): string | undefined {
  if (!world.isAlive(m) || !world.has(m, Mount)) return "not_mount";
  if (!mayUseMount(world, actor, m)) return "not_owner";
  if (!near(world, actor, m, reach)) return "too_far";
  const mm = world.get(m, Mount)!; if (!mm.saddle) return "no_saddle";
  const max = gameplayDefs(world).items.get(mm.saddleItem)?.maxDurability || saddleOfTier(mm.saddle)?.durability || 0;
  if (mm.saddleDur >= max) return "not_damaged";
  if (!itemRepairUnlocked(world, actor, mm.saddleItem)) return "skill_locked"; // ADR-310 `item:<key>` (the Saddlery node)
  for (const c of saddleRepairCost(world, mm.saddleItem)) if (countItem(world, actor, c.item) < c.count) return "cannot_afford";
  return undefined;
}
export function repairSaddle(world: World, actor: Entity, m: Entity): boolean {
  if (!isAuthority(world) || checkRepair(world, actor, m)) return false;
  const mm = world.get(m, Mount)!; for (const c of saddleRepairCost(world, mm.saddleItem)) removeItem(world, actor, c.item, c.count);
  const max = gameplayDefs(world).items.get(mm.saddleItem)?.maxDurability || saddleOfTier(mm.saddle)?.durability || 0;
  world.set(m, Mount, { saddleDur: max }); awardXp(world, actor, "repair");
  emit(world, MountEvent, { entity: actor, mount: m, result: MountResult.Repaired, value: max }); return true;
}
// ---- names ----------------------------------------------------------------------------------------------------
export const sanitizeMountName = (s: string): string => s.replace(/[^\x20-\x7e]/g, "").trim().slice(0, MOUNT_NAME_MAX);
export function mountName(world: World, m: Entity): string {
  const len = world.getField(m, Mount, "len") ?? 0; if (!len) return mountSpecies(world.getField(m, Mount, "species") ?? 0)?.name ?? "Mount";
  const a = world.getArray(m, Mount, "name"); return a ? String.fromCharCode(...Array.from(a).slice(0, len)) : "Mount";
}
export function renameMount(world: World, actor: Entity, m: Entity, name: string): boolean {
  if (!isAuthority(world) || !world.has(m, Mount)) return false;
  const owner = world.getField(m, Mount, "owner") ?? 0; if (owner && mountOwnerIdFor(world, actor) !== owner) return false;
  const n = sanitizeMountName(name); const a = world.getArray(m, Mount, "name");
  if (a) { for (let i = 0; i < MOUNT_NAME_MAX; i++) a[i] = i < n.length ? n.charCodeAt(i) : 0; world.store(Mount).markChanged(entityIndex(m)); }
  world.set(m, Mount, { len: n.length });
  emit(world, MountEvent, { entity: actor, mount: m, result: MountResult.Renamed, value: n.length }); return true;
}

// ---- commands -------------------------------------------------------------------------------------------------
export function installMountCommands(world: World, handlers: CommandHandlers): void {
  const t = (n: number): Entity => n as Entity;
  handlers.on(MountFeedCmd, { validate: (v, c) => checkFeed(world, c.actor, t(v.target), v.item), handle: (v, c) => { feedMount(world, c.actor, t(v.target), v.item); } });
  handlers.on(MountRideCmd, { validate: (v, c) => checkRide(world, c.actor, t(v.target)), handle: (v, c) => { rideMount(world, c.actor, t(v.target)); } });
  handlers.on(MountDismountCmd, { validate: (_v, c) => (isRiding(world, c.actor) ? undefined : "not_riding"), handle: (_v, c) => { dismount(world, c.actor); } });
  handlers.on(MountSaddleCmd, { validate: (v, c) => checkSaddle(world, c.actor, t(v.target), v.slot), handle: (v, c) => { saddleMount(world, c.actor, t(v.target), v.slot); } });
  handlers.on(MountUnsaddleCmd, { validate: (v, c) => checkUnsaddle(world, c.actor, t(v.target)), handle: (v, c) => { unsaddleMount(world, c.actor, t(v.target)); } });
  handlers.on(MountRepairCmd, { validate: (v, c) => checkRepair(world, c.actor, t(v.target)), handle: (v, c) => { repairSaddle(world, c.actor, t(v.target)); } });
  handlers.on(MountRenameCmd, {
    validate: (v, c) => { const m = t(v.target); if (!world.isAlive(m) || !world.has(m, Mount)) return "not_mount"; const o = world.getField(m, Mount, "owner") ?? 0; return o && mountOwnerIdFor(world, c.actor) !== o ? "not_owner" : undefined; },
    handle: (v: { target: number; len: number; text: ArrayLike<number> }, c) => { renameMount(world, c.actor, t(v.target), String.fromCharCode(...Array.from({ length: Math.min(v.len, MOUNT_NAME_MAX) }, (_, i) => v.text[i] ?? 32))); },
  });
}
/** Event hooks: saddle wear from damage taken (rider or mount). Call once per authority world (installGameplay). */
export function installMounts(world: World): void {
  world.events.on(Damaged, (p: { target: Entity; amount: number }) => {
    if (!isAuthority(world) || !world.isRegistered(Mount) || !(p.amount > 0)) return;
    const m = world.has(p.target, Mount) ? p.target : isRiding(world, p.target) ? mountOfRider(world, p.target) : undefined; if (m === undefined) return;
    const d = world.getField(m, Mount, "saddleDur") ?? 0; if (!d || !(world.getField(m, Mount, "saddle") ?? 0)) return;
    world.set(m, Mount, { saddleDur: Math.max(0, d - Math.max(1, Math.round(p.amount * 0.5))) });
  });
}

// ---- systems --------------------------------------------------------------------------------------------------
/** Building, attacking and door / fire use are off while mounted; eating, drinking, crafting, containers stay on. */
const BLOCKED_WHILE_RIDING: ReadonlySet<number> = new Set([
  IntentAction.Gather, IntentAction.Place, IntentAction.Upgrade, IntentAction.Repair, IntentAction.Demolish, IntentAction.Paint, IntentAction.Reclaim,
  IntentAction.Move, IntentAction.ToggleDoor, IntentAction.LockDoor, IntentAction.ToggleFire, IntentAction.Attack, IntentAction.Reload, IntentAction.Boil,
]);
export const blockedWhileRiding = (action: number): boolean => BLOCKED_WHILE_RIDING.has(action);
/** Runs before building / gather / combat systems: clears gated intents of riders. */
export function mountGateSystem(world: World): void {
  if (!world.isRegistered(Riding)) return;
  const it = world.store(PlayerIntent);
  for (const e of world.query([Riding, PlayerIntent])) {
    const i = entityIndex(e); const s = it.slot(i); const a = it.data.action[s]!; if (!BLOCKED_WHILE_RIDING.has(a)) continue;
    it.data.action[s] = IntentAction.None; it.markChanged(i);
    if (isAuthority(world)) emit(world, MountEvent, { entity: e, mount: mountOfRider(world, e) ?? (0 as Entity), result: MountResult.Blocked, value: a });
  }
}
/** Authority: links, mount follow, health mirror + regen, saddlebag size, death drops, taming decay. */
export function mountSystem(world: World, dt: number): void {
  if (!isAuthority(world) || world.isReplaying || !world.isRegistered(Mount)) return;
  // riders: drop broken links (mount gone / dead / taken / rider dead or in a vehicle), else carry the mount along
  for (const r of [...world.query([Riding])]) {
    const m = mountOfRider(world, r);
    if (m === undefined || !world.has(m, Mount) || world.has(m, Dead) || world.has(r, Dead) || world.has(r, Driver) || (world.getField(m, Mount, "riderNetId") ?? 0) !== netIdOf(world, r)) { dismount(world, r); continue; }
    const t = world.get(r, Transform)!; const mt = world.get(m, Transform);
    if (!mt || mt.x !== t.x || mt.y !== t.y || mt.facing !== t.facing || mt.z !== t.z) world.set(m, Transform, { x: t.x, y: t.y, z: t.z, facing: t.facing ?? 0 });
    const sp = mountSpecies(world.getField(r, Riding, "species") ?? 0); const speed = world.getField(r, Riding, "speed") ?? 0;
    const state = speed < 0.05 ? AnimalState.Idle : speed > (sp?.walk ?? 5) + 0.3 ? AnimalState.Flee : AnimalState.Wander;
    if ((world.getField(m, Animal, "state") ?? 0) !== state) world.set(m, Animal, { state });
    const want = state === AnimalState.Idle ? Anim.Idle : state === AnimalState.Flee ? Anim.Run : Anim.Walk; const cur = world.getField(m, AnimState, "anim");
    if (cur !== want && cur !== Anim.Hurt && cur !== Anim.Eat) setAnim(world, m, want);
    const hurt = hurtFlag(world, m); if ((world.getField(r, Riding, "hurt") ?? 0) !== hurt) world.set(r, Riding, { hurt });
  }
  const regen = (T.regenPerMinute / 60) * dt;
  for (const m of [...world.query([Mount, Transform])]) {
    const mm = world.get(m, Mount)!; const spec = mountSpecies(mm.species);
    if (!world.has(m, Animal)) { const t = world.get(m, Transform)!; world.add(m, Animal, { kind: mm.kind, homeX: t.x, homeY: t.y, goalX: t.x, goalY: t.y, thinkAt: world.tick }); } // Animal is not persistent
    if (!world.has(m, Health)) world.add(m, Health, { hp: Math.max(1, mm.hp || spec?.hp || 1), max: spec?.hp ?? 100 }); // Health is not persistent
    if (!world.has(m, AnimState)) world.add(m, AnimState, { anim: Anim.Idle, startTick: world.tick });
    ensureBag(world, m);
    if (mm.riderNetId && liveRider(world, m) === undefined) world.set(m, Mount, { riderNetId: 0 }); // rider left (disconnect) or a reload re-issued NetIds
    if (world.has(m, Dead)) { mountDied(world, m); continue; }
    const h = world.get(m, Health)!; let hp = h.hp; if (hp < h.max) hp = Math.min(h.max, hp + regen);
    if (hp !== h.hp) world.set(m, Health, { hp });
    if (Math.abs(hp - mm.hp) >= 1 || (hp === h.max && mm.hp !== hp)) world.set(m, Mount, { hp });
  }
  if (world.isRegistered(MountTaming)) for (const e of [...world.query([MountTaming])]) {
    const tm = world.get(e, MountTaming)!;
    if (world.has(e, Dead) || world.has(e, Mount)) { world.remove(e, MountTaming); continue; }
    if (world.tick - tm.lastTick < T.tameDecayAfterSeconds * DEFAULT_TICK_HZ) continue;
    const progress = tm.progress - T.tameDecayPerSecond * dt; if (progress <= 0) world.remove(e, MountTaming); else world.set(e, MountTaming, { progress });
  }
}
/** Dead mount: rider off, saddle + saddlebag into an owner-tagged bag, then it is an ordinary animal corpse (meat drops). */
function mountDied(world: World, m: Entity): void {
  const mm = world.get(m, Mount)!; const rider = liveRider(world, m); if (rider !== undefined) dismount(world, rider, true);
  const t = world.get(m, Transform)!; const slots = listSlots(world, m);
  if (mm.saddle || slots.length) {
    const bag = world.create();
    world.add(bag, Transform, { x: t.x, y: t.y, z: t.z }).add(bag, Container, { slotCount: Math.max(1, slots.length + (mm.saddle ? 1 : 0)) }).add(bag, ContainerViewers)
      .add(bag, LootBag, lootBagInit(world, mm.owner, "petDeath", LootSource.Death));
    if (slots.length) moveSlotTuples(world, m, bag, slots.map((s) => ({ slot: s.slot, count: s.count })));
    if (mm.saddle && mm.saddleItem) { const defs = gameplayDefs(world); const v = readSlots(world, bag); slotsAdd(v, mm.saddleItem, 1, defs, world.tick, mm.saddleDur); writeSlots(world, bag, v, defs); }
    tagLootSource(world, bag, LootSource.Death); indexEntity(world, bag);
  }
  for (const v of world.query([Viewing])) if (world.getField(v, Viewing, "container") === m) closeContainer(world, v);
  world.remove(m, Mount); if (world.has(m, Container)) world.remove(m, Container);
  emit(world, MountEvent, { entity: 0 as Entity, mount: m, result: MountResult.Died, value: mm.species });
}
/** Disconnect hook (server): the rider gets off; the mount stays where it is. */
export function dismountOnLeave(world: World, e: Entity): void { if (world.isAlive(e)) dismount(world, e, true); }
/** Saddle instance info for UI / tests. */
export function saddleInfo(world: World, m: Entity): { tier: number; item: number; dur: number; max: number; slots: number; defense: number } | undefined {
  const mm = world.get(m, Mount); if (!mm || !mm.saddle) return undefined; const sd = saddleOfTier(mm.saddle)!;
  const max = gameplayDefs(world).items.get(mm.saddleItem)?.maxDurability || sd.durability;
  return { tier: mm.saddle, item: mm.saddleItem, dur: mm.saddleDur, max, slots: sd.slots, defense: mm.saddleDur > 0 ? sd.defense : 0 };
}
export { canOpenSaddlebag, mayUseMount };
/** First give-up helper for AI: count of a food this species likes in `e`'s inventory (best preference first). */
export function bestMountFood(world: World, e: Entity, species: number): number {
  const spec = mountSpecies(species); if (!spec) return 0; const defs = gameplayDefs(world);
  for (const pref of ["love", "like", "ok"] as const) for (const [k, p] of Object.entries(spec.foods)) if (p === pref) { const id = [...defs.items.values()].find((d) => d.key === k)?.id ?? 0; if (id && countItem(world, e, id) > 0) return id; }
  return 0;
}
