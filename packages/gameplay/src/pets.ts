/**
 * ADR-145 companion pets (data/pets.json). A wild pet-species animal (dogs, cats, birds, rabbit, ferret) is tamed by
 * offering a treat (PetTameCmd; chance = baseTame x the species' preference for that treat; hated treats are refused and
 * kept). Players and AI humans use the same command. A pet keeps: owner (PlayerId), a renameable name, a small owner-only
 * inventory (Container, opened through the normal container intents), fullness + loyalty, level/xp with hp/damage/speed
 * growth, and a Follow / Stay command. petSystem (authority, every tick) drives it: hunger + auto-eating (own inventory ->
 * food on the ground (loot bags) -> its owner's pet_trough), starvation (slow hp loss floored at 1 hp, loyalty decay, never
 * death), follow / stay movement, defence (owner / stay point / owner's structures + other pets) and item pickup.
 * Pet + Tamed + Container are persistent; Health is rebuilt from Pet.hp + level after a load.
 */
import { LootSource, tagLootSource } from "./loot_labels.js";
import { lootBagInit } from "./loot_despawn.js";
import { defineCommand, DEFAULT_TICK_HZ, entityIndex, PlayerId, Transform, type CommandDef, type CommandHandlers, type Entity, type World } from "@engine/core";
import raw from "../data/pets.json";
import {
  Anim, Animal, AnimalSkills, AnimState, BuildPiece, Container, ContainerViewers, Dead, Health, Inventory, LootBag, Pet, PET_NAME_MAX, PetBrain, PetCmd, PetGuard, PetStatus, PetStatusComp, PieceOwner,
  Survival, Tamed, Tribe, TroughOwner, Zombie,
} from "./components.js";
import { pieceOf } from "./building/links.js";
import { nearestClaimHostile } from "./territory.js";
import { pendingReady } from "./ready.js";
import { gameplayDefs, isAuthority } from "./config.js";
import { emit, ev, Damaged, PiecePlaced, PieceDamaged } from "./events.js";
import { addItem, canAddItem, countItem, listSlots, moveSlotTuples, removeItem, takeFromSlot, transferItem } from "./inventory.js";
import { animalDefs, populationTile } from "./population.js";
import { leadInfo, type LeadInfo } from "./rope.js";
import { animalSkillMods, animalXpToNext, ensureAnimalSkills, reconcileAnimalSkills } from "./animal_skills.js";
import { applyDamage, setAnim } from "./combat/combat.js";
import { awardXp } from "./skills/progression.js";
import { indexEntity } from "./spawn.js";
import { maskProfanity } from "./signs.js";
import { swimSpeedMulAt } from "./systems/movement.js";
import { creatureStep, navNeeded, reachableSpotNear, walledOff } from "./systems/creature_nav.js";
import { PVP } from "./combat/pvp.js";

export type TreatPref = "love" | "like" | "ok" | "hate";
export interface PetSpecies { key: string; name: string; animal: string; family: string; baseTame: number; damageMul: number; treats: Record<string, TreatPref>; diet: string[] }
export type PetTuning = typeof raw.tuning;
export const PET_TUNING: Readonly<PetTuning> = raw.tuning;
export const PET_SPECIES: readonly PetSpecies[] = raw.species as PetSpecies[];
export const PET_TREATS: readonly string[] = raw.treats;
export const PREF_MUL: Readonly<Record<TreatPref, number>> = raw.prefMul as Record<TreatPref, number>;
const T = PET_TUNING;
const sec = (s: number): number => Math.max(1, Math.round(s * DEFAULT_TICK_HZ));
/** Species (1-based) by index; undefined for 0 / out of range. */
export const petSpecies = (species: number): PetSpecies | undefined => PET_SPECIES[species - 1];
export const petSpeciesOfKey = (key: string): number => PET_SPECIES.findIndex((s) => s.key === key) + 1;
/** Species (1-based) of an animal entity's kind, 0 = not a pet species. */
export function speciesOfAnimal(world: World, e: Entity): number {
  const k = world.getField(e, Animal, "kind"); if (k === undefined) return 0; const key = animalDefs()[k]?.key; if (!key) return 0;
  return PET_SPECIES.findIndex((s) => s.animal === key) + 1;
}
export const treatPref = (species: number, treat: string): TreatPref | undefined => petSpecies(species)?.treats[treat];
/** Tame chance of offering `treat` (item key) to a wild animal of `species` (0 = refuses / not a treat). */
export function tameChance(species: number, treat: string): number {
  const s = petSpecies(species); const p = s?.treats[treat]; return s && p ? Math.min(0.95, s.baseTame * PREF_MUL[p]) : 0;
}
/** Fullness gained eating `item` (0 = not edible for this species). Treats (not hated) or diet items. */
export function petFoodValue(species: number, item: string): number {
  const s = petSpecies(species); if (!s) return 0; const p = s.treats[item];
  if (p) return p === "hate" ? 0 : T.treatFullness; return s.diet.includes(item) ? T.foodFullness : 0;
}
// ---- level curve --------------------------------------------------------------------------------------
export const petXpToNext = (level: number): number => Math.round(T.xpBase * Math.pow(T.xpGrowth, Math.max(0, level - 1)));
export interface PetStats { maxHp: number; damage: number; walk: number; run: number; attackRange: number }
export function petStats(species: number, level: number): PetStats {
  const s = petSpecies(species); const def = s ? animalDefs().find((a) => a.key === s.animal) : undefined; const l = Math.max(1, level) - 1;
  const base = def?.hp ?? 30; const dmg = (def?.attack?.damage ?? 3) * (s?.damageMul ?? 1); const fast = def?.fleeSpeed ?? 3.5;
  return { maxHp: Math.round(base * (1 + T.hpPerLevel * l)), damage: dmg * (1 + T.damagePerLevel * l), walk: fast * 0.62 * (1 + T.speedPerLevel * l), run: fast * 1.25 * (1 + T.speedPerLevel * l), attackRange: T.attackRange };
}
/**
 * Task 15: petStats with bought animal-skill multipliers applied (damage / health / speed nodes). No skills row
 * (wild animals, legacy pets before their first petSystem tick) behaves exactly like petStats.
 */
export function petStatsWithSkills(world: World, e: Entity, species: number, level: number): PetStats {
  const base = petStats(species, level); if (!world.has(e, AnimalSkills)) return base;
  const m = animalSkillMods(world, e);
  return { maxHp: Math.round(base.maxHp * m.healthMul), damage: base.damage * m.damageMul, walk: base.walk * m.speedMul, run: base.run * m.speedMul, attackRange: base.attackRange };
}
// ---- names --------------------------------------------------------------------------------------------
export function sanitizePetName(rawName: string): string {
  return maskProfanity(rawName.replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim().slice(0, Math.min(T.nameMax, PET_NAME_MAX)).trimEnd());
}
export function petName(world: World, e: Entity): string {
  const n = world.getField(e, Pet, "len") ?? 0; const a = world.getArray(e, Pet, "name");
  if (!a || !n) return petSpecies(world.getField(e, Pet, "species") ?? 0)?.name ?? "Pet";
  let o = ""; for (let i = 0; i < Math.min(n, PET_NAME_MAX); i++) o += String.fromCharCode(a[i] ?? 32); return o;
}
function writeName(world: World, e: Entity, name: string): void {
  const a = world.getArray(e, Pet, "name"); if (!a) return; for (let i = 0; i < PET_NAME_MAX; i++) a[i] = i < name.length ? name.charCodeAt(i) : 0;
  world.setField(e, Pet, "len", name.length); world.store(Pet).markChanged(entityIndex(e));
}
// ---- ownership ----------------------------------------------------------------------------------------
const pidOf = (world: World, e: Entity): number => (world.isRegistered(PlayerId) && world.has(e, PlayerId) ? world.getField(e, PlayerId, "id") ?? 0 : 0);
export const petOwnerId = (world: World, pet: Entity): number => world.getField(pet, Pet, "owner") ?? 0;
export const isPetOwner = (world: World, actor: Entity, pet: Entity): boolean => { const id = pidOf(world, actor); return id !== 0 && world.has(pet, Pet) && petOwnerId(world, pet) === id; };
/** Live entity of a PlayerId (owner of a pet), undefined when offline / dead. */
export function playerEntity(world: World, id: number): Entity | undefined {
  if (!id || !world.isRegistered(PlayerId)) return undefined;
  for (const e of world.query([PlayerId, Transform], [Dead])) if (world.getField(e, PlayerId, "id") === id) return e;
  return undefined;
}
/** Pets owned by PlayerId `id` (sorted). */
export function petsOf(world: World, id: number): Entity[] {
  const out: Entity[] = []; if (!id) return out; for (const e of world.query([Pet])) if (world.getField(e, Pet, "owner") === id) out.push(e); return out.sort((a, b) => a - b);
}
// ---- events -------------------------------------------------------------------------------------------
export const enum PetResult { Tamed = 1, Refused = 2, Shied = 3, Fed = 4, NotHungry = 5, LevelUp = 6, Renamed = 7, Command = 8 }
export const PetEvent = ev<{ entity: Entity; pet: Entity; result: PetResult; value: number }>("gameplay.PetEvent");
export const PetAte = ev<{ pet: Entity; item: number; source: number }>("gameplay.PetAte");
// ---- taming / feeding by hand -------------------------------------------------------------------------
export const enum PetFail { None = 0, NotFound = 1, TooFar = 2, NotPetSpecies = 3, NoItem = 4, NotTreat = 5, NotOwner = 6, NotFood = 7, BadTarget = 8 }
export const PET_FAIL_REASONS = ["", "not_found", "too_far", "not_pet", "no_item", "not_treat", "not_owner", "not_food", "bad_target"] as const;
const near = (world: World, a: Entity, b: Entity, r: number): boolean => { const p = world.get(a, Transform), q = world.get(b, Transform); return !!p && !!q && Math.hypot(p.x - q.x, p.y - q.y) <= r; };
export function checkOffer(world: World, actor: Entity, target: Entity, item: number): PetFail {
  if (!world.isAlive(target) || world.has(target, Dead) || !world.has(target, Animal)) return PetFail.NotFound;
  if (!near(world, actor, target, T.interactRange + 0.75)) return PetFail.TooFar;
  const sp = world.has(target, Pet) ? world.getField(target, Pet, "species")! : speciesOfAnimal(world, target); if (!sp) return PetFail.NotPetSpecies;
  if (countItem(world, actor, item) < 1) return PetFail.NoItem;
  const key = gameplayDefs(world).items.get(item)?.key ?? "";
  if (world.has(target, Pet)) { if (!isPetOwner(world, actor, target)) return PetFail.NotOwner; return petFoodValue(sp, key) > 0 ? PetFail.None : PetFail.NotFood; }
  if (world.has(target, Tamed)) return PetFail.NotOwner;
  return treatPref(sp, key) ? PetFail.None : PetFail.NotTreat;
}
/** Turn a wild animal into `owner`'s pet (no checks). */
export function makePet(world: World, animal: Entity, owner: Entity, species = speciesOfAnimal(world, animal)): void {
  const ownerId = pidOf(world, owner); const t = world.get(animal, Transform)!; const st = petStats(species, 1);
  const kind = world.getField(animal, Animal, "kind")!;
  world.add(animal, Pet, { species, owner: ownerId, cmd: PetCmd.Follow, level: 1, xp: 0, fullness: 80, loyalty: T.startLoyalty, hp: st.maxHp, stayX: t.x, stayY: t.y, len: 0 });
  ensureAnimalSkills(world, animal); // Task 15: fresh pet starts with its level-1 skill point
  if (!world.has(animal, Tamed)) world.add(animal, Tamed, { kind, owner, fedUntil: world.tick, produceAt: world.tick + sec(600), breedAt: world.tick + sec(1e6) });
  if (!world.has(animal, Container)) world.add(animal, Container, { slotCount: T.inventorySlots, maxWeight: 0 }).add(animal, ContainerViewers);
  world.set(animal, Health, { hp: st.maxHp, max: st.maxHp });
  if (!world.has(animal, PetBrain)) world.add(animal, PetBrain, {});
}
/** Offer one `item` from actor's inventory: tame (wild) or feed (own pet). Consumes the item unless refused. */
export function offerTreat(world: World, actor: Entity, target: Entity, item: number): { fail: PetFail; result?: PetResult } {
  const fail = checkOffer(world, actor, target, item); if (fail) return { fail };
  const key = gameplayDefs(world).items.get(item)!.key;
  if (world.has(target, Pet)) {
    const p = world.get(target, Pet)!; const v = petFoodValue(p.species, key);
    if (p.fullness >= 99.5 && !PET_TREATS.includes(key)) { emit(world, PetEvent, { entity: actor, pet: target, result: PetResult.NotHungry, value: 0 }); return { fail, result: PetResult.NotHungry }; }
    removeItem(world, actor, item, 1);
    world.set(target, Pet, { fullness: Math.min(100, p.fullness + v), loyalty: Math.min(100, p.loyalty + (PET_TREATS.includes(key) ? T.loyaltyPerTreat : 2)) });
    emit(world, PetAte, { pet: target, item, source: 0 }); emit(world, PetEvent, { entity: actor, pet: target, result: PetResult.Fed, value: item });
    setAnim(world, target, Anim.Eat); return { fail, result: PetResult.Fed };
  }
  const sp = speciesOfAnimal(world, target); const chance = tameChance(sp, key);
  if (chance <= 0) { emit(world, PetEvent, { entity: actor, pet: target, result: PetResult.Refused, value: item }); return { fail, result: PetResult.Refused }; }
  removeItem(world, actor, item, 1);
  if (world.rngFor(`pet.tame.${world.tick}`, target).next() >= chance) {
    emit(world, PetEvent, { entity: actor, pet: target, result: PetResult.Shied, value: item }); return { fail, result: PetResult.Shied };
  }
  makePet(world, target, actor, sp); awardXp(world, actor, "tame");
  emit(world, PetEvent, { entity: actor, pet: target, result: PetResult.Tamed, value: sp }); return { fail, result: PetResult.Tamed };
}
export function setPetCommand(world: World, actor: Entity, pet: Entity, cmd: number): PetFail {
  if (!world.isAlive(pet) || !world.has(pet, Pet)) return PetFail.NotFound; if (!isPetOwner(world, actor, pet)) return PetFail.NotOwner;
  const t = world.get(pet, Transform)!; world.set(pet, Pet, { cmd: cmd === PetCmd.Stay ? PetCmd.Stay : PetCmd.Follow, stayX: t.x, stayY: t.y });
  if (world.has(pet, PetGuard)) world.remove(pet, PetGuard); // Follow / Stay replaces any guard assignment
  world.setField(pet, PetBrain, "target", 0); emit(world, PetEvent, { entity: actor, pet, result: PetResult.Command, value: cmd }); return PetFail.None;
}
// ---- guarding (Task 14) -------------------------------------------------------------------------------------
/** Guard target kinds for PetGuard.kind / PetGuardCmd.kind. */
export const enum GuardKind { None = 0, Location = 1, Entity = 2 }
/** Position of a guardable entity: its own Transform, or its piece's Transform for attachments (door, fire, …). */
export function guardTargetPos(world: World, target: Entity): { x: number; y: number } | undefined {
  const t = world.get(target, Transform); if (t) return { x: t.x, y: t.y };
  const piece = pieceOf(world, target); if (piece !== undefined) { const pt = world.get(piece, Transform); if (pt) return { x: pt.x, y: pt.y }; }
  return undefined;
}
/** Dead for guard purposes: destroyed, flagged Dead, or a living thing at 0 HP (death has not ticked yet). */
export function guardTargetDead(world: World, target: Entity): boolean {
  if (!world.isAlive(target) || world.has(target, Dead)) return true;
  const hp = world.getField(target, Health, "hp"); return hp !== undefined && hp <= 0;
}
/** Pure guard validation (no side effects; used by the command handler's validate step). */
export function setGuardValidate(world: World, actor: Entity, pet: Entity, kind: number, target: Entity, x: number, y: number): PetFail {
  if (!world.isAlive(pet) || !world.has(pet, Pet)) return PetFail.NotFound; if (!isPetOwner(world, actor, pet)) return PetFail.NotOwner;
  if (!near(world, actor, pet, 40)) return PetFail.TooFar;
  if (kind === GuardKind.Location) return Number.isFinite(x) && Number.isFinite(y) ? PetFail.None : PetFail.BadTarget;
  if (kind === GuardKind.Entity) return !guardTargetDead(world, target) && !!guardTargetPos(world, target) ? PetFail.None : PetFail.BadTarget;
  return PetFail.BadTarget;
}
/** Assign `pet` to guard a location (kind 1) or an entity (kind 2: player, pet, farm animal, AI human, piece, station). */
export function setGuard(world: World, actor: Entity, pet: Entity, kind: number, target: Entity, x: number, y: number): PetFail {
  const fail = setGuardValidate(world, actor, pet, kind, target, x, y); if (fail) return fail;
  if (kind === GuardKind.Location) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return PetFail.BadTarget;
    world.set(pet, Pet, { cmd: PetCmd.Guard });
    if (world.has(pet, PetGuard)) world.set(pet, PetGuard, { kind, target: 0, x, y }); else world.add(pet, PetGuard, { kind, target: 0, x, y });
  } else if (kind === GuardKind.Entity) {
    if (!world.isAlive(target) || world.has(target, Dead)) return PetFail.BadTarget;
    const pos = guardTargetPos(world, target); if (!pos) return PetFail.BadTarget;
    world.set(pet, Pet, { cmd: PetCmd.Guard });
    if (world.has(pet, PetGuard)) world.set(pet, PetGuard, { kind, target, x: pos.x, y: pos.y }); else world.add(pet, PetGuard, { kind, target, x: pos.x, y: pos.y });
  } else return PetFail.BadTarget;
  world.setField(pet, PetBrain, "target", 0); emit(world, PetEvent, { entity: actor, pet, result: PetResult.Command, value: PetCmd.Guard }); return PetFail.None;
}
/** Live anchor for a guarding pet; undefined when the assignment is gone or its target is dead/destroyed. */
export function guardAnchor(world: World, pet: Entity): { x: number; y: number } | undefined {
  if (!world.has(pet, PetGuard)) return undefined; const g = world.get(pet, PetGuard)!;
  if (g.kind === GuardKind.Location) return { x: g.x, y: g.y };
  if (g.kind === GuardKind.Entity) {
    if (guardTargetDead(world, g.target)) return undefined;
    return guardTargetPos(world, g.target);
  }
  return undefined;
}
/** Human-readable guard target for the pet panel (best effort; falls back to the stored position). */
export function guardTargetLabel(world: World, pet: Entity): string {
  if (!world.has(pet, PetGuard)) return ""; const g = world.get(pet, PetGuard)!;
  if (g.kind === GuardKind.Location) return `Location (${g.x.toFixed(1)}, ${g.y.toFixed(1)})`;
  if (g.kind === GuardKind.Entity && world.isAlive(g.target)) {
    const t = g.target;
    if (world.has(t, Pet)) return petName(world, t);
    if (world.isRegistered(PlayerId) && world.has(t, PlayerId)) return "Player";
    if (world.has(t, BuildPiece)) { const def = gameplayDefs(world).pieces.get(world.getField(t, BuildPiece, "type") ?? 0); if (def) return def.key.replace(/_/g, " "); }
    if (world.has(t, Animal)) { const key = animalDefs()[world.getField(t, Animal, "kind") ?? 0]?.key; if (key) return key.replace(/^animal_/, "").replace(/_/g, " "); }
    if (world.has(t, Tamed)) return "Farm animal";
    return "Target";
  }
  return `Location (${g.x.toFixed(1)}, ${g.y.toFixed(1)})`;
}
/** Panel / marker label for a PetStatus value. */
export const petStatusLabel = (s: number): string => ["Idle", "Following", "Staying", "Guarding", "Fighting", "Returning", "Eating"][s] ?? "Idle";
export function renamePet(world: World, actor: Entity, pet: Entity, name: string): PetFail {
  if (!world.isAlive(pet) || !world.has(pet, Pet)) return PetFail.NotFound; if (!isPetOwner(world, actor, pet)) return PetFail.NotOwner;
  writeName(world, pet, sanitizePetName(name)); emit(world, PetEvent, { entity: actor, pet, result: PetResult.Renamed, value: 0 }); return PetFail.None;
}
// ---- dropping items on the ground ---------------------------------------------------------------------
/** Drop `count` of `item` from e's inventory into a new owner-tagged loot bag at its feet (pets fetch these). */
export function dropItem(world: World, e: Entity, item: number, count: number): Entity | undefined {
  const have = countItem(world, e, item); const n = Math.min(have, Math.max(1, count)); if (!n) return undefined;
  const t = world.get(e, Transform); if (!t) return undefined;
  const bag = world.create(); const ang = t.facing ?? 0;
  world.add(bag, Transform, { x: t.x + Math.cos(ang) * 0.6, y: t.y + Math.sin(ang) * 0.6, z: t.z }).add(bag, Container, { slotCount: 4 }).add(bag, ContainerViewers)
    .add(bag, LootBag, lootBagInit(world, pidOf(world, e), "dropped", LootSource.Dropped));
  transferItem(world, e, bag, item, n); tagLootSource(world, bag, LootSource.Dropped); indexEntity(world, bag); return bag;
}
// ---- commands -----------------------------------------------------------------------------------------
export const PetOfferCmd = defineCommand("gameplay.petOffer", { target: "u32", item: "u16" });
export const PetCommandCmd = defineCommand("gameplay.petCommand", { pet: "u32", cmd: "u8" });
export const PetRenameCmd = defineCommand("gameplay.petRename", { pet: "u32", len: "u8", text: { type: "u8", length: PET_NAME_MAX } });
export const DropItemCmd = defineCommand("gameplay.dropItem", { item: "u16", count: "u16" });
/**
 * Task 14: assign a pet to guard a target. kind: 1 = world location (x, y; target is ignored on the server but
 * must still carry a resolvable NetId on the wire, so clients send the pet itself), 2 = entity (target).
 * Appended to PET_COMMANDS so the existing bridge (protocol.ts ...PET_COMMANDS) picks it up.
 */
export const PetGuardCmd = defineCommand("gameplay.petGuard", { pet: "u32", kind: "u8", target: "u32", x: "f32", y: "f32" });
export const PET_COMMANDS: readonly CommandDef[] = [PetOfferCmd, PetCommandCmd, PetRenameCmd, DropItemCmd, PetGuardCmd];
export const PET_ENTITY_FIELDS: Readonly<Record<string, readonly string[]>> = { [PetOfferCmd.name]: ["target"], [PetCommandCmd.name]: ["pet"], [PetRenameCmd.name]: ["pet"], [PetGuardCmd.name]: ["pet", "target"] };
export const PET_REJECT_REASONS = ["not_pet", "not_treat", "not_food", "bad_target"] as const;
export const encodePetName = (name: string): { len: number; text: number[] } => {
  const s = sanitizePetName(name); return { len: s.length, text: Array.from({ length: PET_NAME_MAX }, (_, i) => (i < s.length ? s.charCodeAt(i) : 0)) };
};
const decode = (len: number, b: ArrayLike<number>): string => Array.from({ length: Math.min(len, PET_NAME_MAX) }, (_, i) => String.fromCharCode(b[i] ?? 32)).join("");
export function installPetCommands(world: World, handlers: CommandHandlers): void {
  const r = (f: PetFail): string | undefined => (f ? PET_FAIL_REASONS[f] : undefined);
  const owned = (actor: Entity, pet: Entity): PetFail => (!world.isAlive(pet) || !world.has(pet, Pet) ? PetFail.NotFound : !isPetOwner(world, actor, pet) ? PetFail.NotOwner : near(world, actor, pet, 40) ? PetFail.None : PetFail.TooFar);
  handlers.on(PetOfferCmd, { validate: (v, c) => r(checkOffer(world, c.actor, v.target as Entity, v.item)), handle: (v, c) => { offerTreat(world, c.actor, v.target as Entity, v.item); } });
  handlers.on(PetCommandCmd, { validate: (v, c) => r(owned(c.actor, v.pet as Entity)), handle: (v, c) => { setPetCommand(world, c.actor, v.pet as Entity, v.cmd); } });
  handlers.on(PetGuardCmd, { validate: (v, c) => r(setGuardValidate(world, c.actor, v.pet as Entity, v.kind, v.target as Entity, v.x, v.y)), handle: (v, c) => { setGuard(world, c.actor, v.pet as Entity, v.kind, v.target as Entity, v.x, v.y); } });
  handlers.on(PetRenameCmd, { validate: (v, c) => r(owned(c.actor, v.pet as Entity)), handle: (v: { pet: number; len: number; text: ArrayLike<number> }, c) => { renamePet(world, c.actor, v.pet as Entity, decode(v.len, v.text)); } });
  handlers.on(DropItemCmd, { validate: (v, c) => (countItem(world, c.actor, v.item) > 0 ? undefined : "no_item"), handle: (v, c) => { dropItem(world, c.actor, v.item, v.count); } });
}
// ---- runtime hooks --------------------------------------------------------------------------------------
interface Aggro { attacker: Entity; tick: number }
/** Recent attackers per owner PlayerId (owner / their pets / their structures were hit). */
const aggroOf = new WeakMap<World, Map<number, Aggro[]>>();
const troughKind = new WeakMap<World, number>();
function noteAggro(world: World, ownerId: number, attacker: Entity): void {
  if (!ownerId || !world.isAlive(attacker) || world.has(attacker, BuildPiece)) return; let m = aggroOf.get(world); if (!m) aggroOf.set(world, (m = new Map()));
  const l = (m.get(ownerId) ?? []).filter((a) => a.attacker !== attacker && world.tick - a.tick < sec(15)); l.push({ attacker, tick: world.tick }); m.set(ownerId, l.slice(-6));
}
/** Registers event hooks (aggro memory for defence, pet_trough ownership). Call once per authority world. */
export function installPets(world: World): void {
  world.events.on(Damaged, (p: { target: Entity; source: Entity }) => {
    if (!isAuthority(world) || p.source === p.target || !world.isAlive(p.source)) return;
    if (world.has(p.source, Pet) && world.has(p.target, Pet) && petOwnerId(world, p.source) === petOwnerId(world, p.target)) return;
    const victimOwner = world.has(p.target, Pet) ? petOwnerId(world, p.target) : pidOf(world, p.target);
    if (victimOwner && !(world.has(p.source, Pet) && petOwnerId(world, p.source) === victimOwner) && pidOf(world, p.source) !== victimOwner) noteAggro(world, victimOwner, p.source);
  });
  world.events.on(PieceDamaged, (p: { piece: Entity; attacker: Entity }) => {
    if (!isAuthority(world) || !world.isAlive(p.piece)) return;
    const owner = (world.isRegistered(PieceOwner) ? world.getField(p.piece, PieceOwner, "player") : 0) || (world.getField(p.piece, TroughOwner, "player") ?? 0);
    if (owner && p.attacker && pidOf(world, p.attacker) !== owner) noteAggro(world, owner, p.attacker);
  });
  world.events.on(PiecePlaced, (p: { piece: Entity; type: number; builder: Entity }) => {
    if (!isAuthority(world) || p.type !== troughId(world)) return; const id = pidOf(world, p.builder);
    if (id && world.isAlive(p.piece)) world.add(p.piece, TroughOwner, { player: id });
  });
}
function troughId(world: World): number {
  let id = troughKind.get(world); if (id === undefined) { try { id = gameplayDefs(world).pieceId("pet_trough"); } catch { id = -1; } troughKind.set(world, id); } return id;
}
/** LootBag.despawnAtTick of a permanent cache (e.g. the sandbox pet-corner crate): pets never eat from or loot those. */
export const PERMANENT_BAG = 0xffffffff;
// ---- system ---------------------------------------------------------------------------------------------
const valid = (world: World, e: Entity): boolean => !!e && world.isAlive(e) && !world.has(e, Dead) && world.has(e, Health) && world.has(e, Transform);
export function grantXp(world: World, pet: Entity, amount: number): void {
  const p = world.get(pet, Pet)!; let xp = p.xp + Math.max(0, Math.round(amount)); let level = p.level; let up = false;
  while (level < T.maxLevel && xp >= petXpToNext(level)) { xp -= petXpToNext(level); level++; up = true; }
  if (level >= T.maxLevel) xp = Math.min(xp, petXpToNext(level));
  world.set(pet, Pet, { xp, level });
  reconcileAnimalSkills(world, pet); // Task 15: level-ups grant points at levels 1/6/11/16 (never removes spent)
  if (up) {
    const st = petStatsWithSkills(world, pet, p.species, level); const h = world.get(pet, Health)!; const hp = Math.min(st.maxHp, h.hp + (st.maxHp - h.max));
    world.set(pet, Health, { max: st.maxHp, hp }); world.setField(pet, Pet, "hp", hp);
    const owner = playerEntity(world, p.owner); emit(world, PetEvent, { entity: owner ?? pet, pet, result: PetResult.LevelUp, value: level });
  }
}
export { grantXp as grantPetXp };
function edibleSlot(world: World, from: Entity, species: number): { item: number; slot: number; value: number } | undefined {
  const defs = gameplayDefs(world); let best: { item: number; slot: number; value: number } | undefined;
  for (const s of listSlots(world, from)) {
    if (!s.item || !s.count) continue; const v = petFoodValue(species, defs.items.get(s.item)?.key ?? "");
    if (v > 0 && (!best || v > best.value)) best = { item: s.item, slot: s.slot, value: v };
  }
  return best;
}
function eatFrom(world: World, pet: Entity, from: Entity, source: number): boolean {
  const p = world.get(pet, Pet)!; const f = edibleSlot(world, from, p.species); if (!f) return false;
  if (!removeItem(world, from, f.item, 1)) return false;
  world.set(pet, Pet, { fullness: Math.min(100, p.fullness + f.value), loyalty: Math.min(100, p.loyalty + 1) });
  setAnim(world, pet, Anim.Eat); emit(world, PetAte, { pet, item: f.item, source }); return true;
}
/** Owned food sources within `r` of (x, y): loot bags (any open bag or one the owner dropped) and the owner's pet troughs. */
// Task 29: bags + troughs for this run (built once in petSystem); same result as the radius
// scan — same distance caps, ownership and edibility checks, same (d, e) sort.
function foodSources(world: World, pet: Entity, x: number, y: number, ownerE: Entity | undefined, bags: readonly Entity[], troughs: readonly Entity[], owner: number, species: number): { e: Entity; d: number; source: number }[] {
  const out: { e: Entity; d: number; source: number }[] = [];
  const tribe = ownerE !== undefined ? world.getField(ownerE, Tribe, "id") ?? 0 : 0;
  for (const e of bags) {
    if (!world.isAlive(e) || e === pet) continue; const t = world.get(e, Transform); if (!t) continue; const d = Math.hypot(t.x - x, t.y - y);
    const o = world.getField(e, LootBag, "owner") ?? 0; if (world.getField(e, LootBag, "despawnAtTick") === PERMANENT_BAG) continue; // caches/crates are not "the ground"
    if (d <= T.groundSearchRange && (o === 0 || o === owner) && edibleSlot(world, e, species)) out.push({ e, d, source: 1 });
  }
  for (const e of troughs) {
    if (!world.isAlive(e) || e === pet) continue; const t = world.get(e, Transform); if (!t) continue; const d = Math.hypot(t.x - x, t.y - y);
    if (d > T.troughRange) continue;
    const own = world.getField(e, TroughOwner, "player") || (world.isRegistered(PieceOwner) ? world.getField(e, PieceOwner, "player") ?? 0 : 0);
    const ok = own === owner || (tribe !== 0 && world.getField(e, Tribe, "id") === tribe);
    if (ok && edibleSlot(world, e, species)) out.push({ e, d, source: 2 });
  }
  return out.sort((a, b) => a.d - b.d || a.e - b.e);
}
// Task 29: loot bags for this run (built once in petSystem). Scanning them directly beats a
// spatial radius query over every piece/animal/node in the village (~10us per pet per tick).
function pickupTarget(world: World, pet: Entity, x: number, y: number, bags: readonly Entity[], owner: number): Entity | undefined {
  let best: Entity | undefined, bd = Infinity;
  for (const e of bags) {
    if (!world.isAlive(e)) continue; const o = world.getField(e, LootBag, "owner") ?? 0;
    if (o !== owner) continue; // only fetch what the owner dropped
    const t = world.get(e, Transform)!; const d = Math.hypot(t.x - x, t.y - y);
    if (d > T.pickupRange || d >= bd) continue;
    if (!listSlots(world, e).some((s) => s.item && s.count && canAddItem(world, pet, s.item, 1) > 0)) continue;
    bd = d; best = e;
  }
  return best;
}
// Task 29: living zombies for this run (built once in petSystem); same nearest-hostile result
// as the radius scan (exact distance + the same tie-break), without scanning the village.
function threatNear(world: World, pet: Entity, x: number, y: number, r: number, zombies: readonly Entity[], owner: number): Entity | undefined {
  let best: Entity | undefined, bd = Infinity;
  const aggro = (aggroOf.get(world)?.get(owner) ?? []).filter((a) => world.tick - a.tick < sec(15) && valid(world, a.attacker));
  const consider = (e: Entity): void => { const t = world.get(e, Transform)!; const d = Math.hypot(t.x - x, t.y - y); if (d <= r && (d < bd || (d === bd && best !== undefined && e < best))) { bd = d; best = e; } };
  for (const a of aggro) if (!(world.has(a.attacker, Pet) && petOwnerId(world, a.attacker) === owner)) consider(a.attacker);
  if (best !== undefined) return best;
  for (const e of zombies) if (e !== pet && world.isAlive(e) && !world.has(e, Dead) && world.has(e, Health)) consider(e);
  return best;
}
/** Move pet toward (gx, gy) at `speed` tiles/s; returns true if it moved. */
function step(world: World, e: Entity, gx: number, gy: number, speed: number, dt: number, stopAt = 0.15): boolean {
  const t = world.get(e, Transform)!; const dx = gx - t.x, dy = gy - t.y, d = Math.hypot(dx, dy); if (d <= stopAt) return false;
  const sp = speed * swimSpeedMulAt(world, t.x, t.y) * dt; const k = Math.min(sp, d - stopAt) / d;
  const unwalk = gameplayDefs(world).worldgen.unwalkableTiles;
  const nav = creatureStep(world, e, gx, gy, sp, stopAt, petBlocked(world), dt); // ADR-215: walls, closed doors, stations
  if (nav !== undefined) return nav;
  const nx = t.x + dx * k, ny = t.y + dy * k;
  if (unwalk.has(populationTile(world, Math.floor(nx), Math.floor(ny)))) {
    // slide along one axis
    if (!unwalk.has(populationTile(world, Math.floor(nx), Math.floor(t.y)))) world.set(e, Transform, { x: nx, facing: Math.atan2(dy, dx) });
    else if (!unwalk.has(populationTile(world, Math.floor(t.x), Math.floor(ny)))) world.set(e, Transform, { y: ny, facing: Math.atan2(dy, dx) });
    else return false; return true;
  }
  world.set(e, Transform, { x: nx, y: ny, facing: Math.atan2(dy, dx) }); return true;
}
/** ADR-215: within followDistance of the owner but walled off, the pet paths round until this close (or in sight). */
const WALLED_STOP = 0.8;
const petBlocked = (world: World) => { const unwalk = gameplayDefs(world).worldgen.unwalkableTiles; return (tx: number, ty: number): boolean => unwalk.has(populationTile(world, tx, ty)); };
/** ADR-215: a trough is a solid piece the pet body now stops against (bodyRadius off its tile), so its reach covers a 1-tile footprint. */
const TROUGH_REACH = 1.5;
/** Catch-up spot beside the owner: legacy (-1, +0.5); near structures (ADR-215) the first offset in body-sized sight of the owner, so a pet never lands on the far side of a wall or inside a station. */
const TELEPORT_OFFSETS: readonly [number, number][] = [[-1, 0.5], [1, 0.5], [0.5, 1], [0.5, -1], [-1, -0.5], [1, -0.5], [-0.5, 1], [-0.5, -1], [-0.6, 0], [0.6, 0], [0, 0.6], [0, -0.6]];
function teleportSpot(world: World, ot: { x: number; y: number; z?: number }): { x: number; y: number; z?: number } {
  if (!navNeeded(world, ot.x - 1.5, ot.y - 1.5, ot.x + 1.5, ot.y + 1.5)) return { x: ot.x - 1, y: ot.y + 0.5 };
  const z = ot.z ?? 0;
  const unwalk = gameplayDefs(world).worldgen.unwalkableTiles;
  return { ...reachableSpotNear(world, ot.x, ot.y, z, (tx, ty) => unwalk.has(populationTile(world, tx, ty)), TELEPORT_OFFSETS), z };
}
/** ADR-146: a pet on Stay sits when idle (render: AnimState Sit = 13 -> the pet atlas's `sit` animation). Client-safe (replicated Pet.cmd). */
export function petSits(world: World, e: Entity): boolean { return world.isRegistered(Pet) && world.has(e, Pet) && world.getField(e, Pet, "cmd") === PetCmd.Stay; }
const animAt = (world: World, e: Entity, anim: Anim): void => {
  const cur = world.getField(e, AnimState, "anim"); if (cur === Anim.Hurt || ((cur === Anim.Attack || cur === Anim.Eat) && world.tick - (world.getField(e, AnimState, "startTick") ?? 0) < sec(0.5))) return; setAnim(world, e, anim);
};
/** Authority, every tick (after animal AI): pet needs, movement, defence, pickup. */
export function petSystem(world: World, dt: number): void {
  if (!isAuthority(world) || world.isReplaying) return;
  const now = world.tick; const defs = gameplayDefs(world);
  // dead pets: inventory -> loot bag for the owner (animalAI then plays the corpse + removes the entity)
  for (const e of [...world.query([Pet, Dead, Container])].sort((a, b) => a - b)) {
    const moves = listSlots(world, e).filter((s) => s.item && s.count).map((s) => ({ slot: s.slot, count: s.count })); if (!moves.length) continue;
    const t = world.get(e, Transform)!; const bag = world.create();
    world.add(bag, Transform, { x: t.x + 0.3, y: t.y, z: t.z }).add(bag, Container, { slotCount: Math.max(4, moves.length) }).add(bag, ContainerViewers)
      .add(bag, LootBag, lootBagInit(world, petOwnerId(world, e), "petDeath", LootSource.Animal));
    moveSlotTuples(world, e, bag, moves); tagLootSource(world, bag, LootSource.Animal); indexEntity(world, bag);
  }
  // Task 29: per-run lookup lists — the old code ran a spatial radius query (over every piece /
  // animal / node in the village) per pet per tick for threats, pickups and food, plus a PlayerId
  // query per pet for its owner. Players / zombies / bags are few; scan those lists with exact
  // distances instead. Troughs are built lazily (only when a pet is hungry) with exactly the old
  // predicate: Container + BuildPiece type pet_trough.
  // The lists/stores below are only consumed by the pet loop, so build them only when a pet exists:
  // the old per-pet helpers never ran a query in a pet-less world, and worlds without PlayerId
  // registered (persist restores) must not throw here. The isRegistered guards mirror playerEntity.
  const pets = [...world.query([Pet, Transform], [Dead])].sort((a, b) => a - b);
  if (pets.length === 0) return;
  // Task 29: hoisted component stores (see animalAISystem — world.get() copies per call).
  const petStore = world.store(Pet); const brainStore = world.store(PetBrain); const tfStore = world.store(Transform); const hpStore = world.store(Health); const anStore = world.store(Animal);
  const playersById = new Map<number, Entity>();
  if (world.isRegistered(PlayerId)) for (const p of world.query([PlayerId, Transform], [Dead])) playersById.set(world.getField(p, PlayerId, "id")!, p);
  const zombies: Entity[] = world.isRegistered(Zombie) ? [...world.query([Zombie, Transform], [Dead])].sort((a, b) => a - b) : [];
  const bags: Entity[] = world.isRegistered(LootBag) && world.isRegistered(Container) ? [...world.query([LootBag, Container, Transform])].sort((a, b) => a - b) : [];
  let troughs: Entity[] | undefined;
  const getTroughs = (): Entity[] => {
    if (!troughs) { const tid = troughId(world); troughs = world.isRegistered(Container) && world.isRegistered(BuildPiece) ? [...world.query([Container, Transform])].filter((e) => world.getField(e, BuildPiece, "type") === tid).sort((a, b) => a - b) : []; }
    return troughs;
  };
  for (const e of pets) {
    // Task 29: store-direct snapshot at loop top — same staleness as the old world.get() copies
    // (later setFields in this iteration do not change these locals).
    const ei = entityIndex(e);
    const pSlot = petStore.slot(ei); const pD = petStore.data;
    const pSpecies = pD.species[pSlot]!; const pLevel = pD.level[pSlot]!; const pOwner = pD.owner[pSlot]!; const pCmd = pD.cmd[pSlot]!;
    const pStayX = pD.stayX[pSlot]!; const pStayY = pD.stayY[pSlot]!; const pFullness = pD.fullness[pSlot]!; const pHp = pD.hp[pSlot]!; const pLoyalty = pD.loyalty[pSlot]!;
    if (!world.has(e, AnimalSkills)) ensureAnimalSkills(world, e); // Task 15: legacy/loaded pets
    const st = petStatsWithSkills(world, e, pSpecies, pLevel);
    if (!world.has(e, PetBrain)) world.add(e, PetBrain, { nextEat: now, nextStarve: now + sec(10) });
    if (!world.has(e, Animal) || !world.has(e, AnimState)) continue; // husbandrySystem restores these after a load
    if (!world.has(e, ContainerViewers)) world.add(e, ContainerViewers);
    // Health is not persistent: rebuild from Pet.hp / level once after a load
    const hSlot = hpStore.slot(ei);
    if (hSlot < 0) { world.add(e, Health, { hp: Math.max(1, pHp || st.maxHp), max: st.maxHp }); }
    else if (hpStore.data.max[hSlot]! !== st.maxHp) world.set(e, Health, { max: st.maxHp, hp: Math.min(hpStore.data.hp[hSlot]!, st.maxHp) });
    const hp = world.getField(e, Health, "hp")!; if (Math.abs(hp - pHp) >= 0.5) world.setField(e, Pet, "hp", hp);
    const bSlot = brainStore.slot(ei); const bD = brainStore.data;
    const bTarget = bD.target[bSlot]!; const bNextEat = bD.nextEat[bSlot]!; const bNextStarve = bD.nextStarve[bSlot]!; const bNextAttack = bD.nextAttack[bSlot]!;
    const tSlot = tfStore.slot(ei); const tfD = tfStore.data; const tx = tfD.x[tSlot]!; const ty = tfD.y[tSlot]!; const tz = tfD.z[tSlot]!;
    const anSlot = anStore.slot(ei); const anD = anStore.data;
    const ownerE = playersById.get(pOwner);
    // hunger (Task 14: frozen while the pet's owner is still loading in)
    const ownerPending = ownerE !== undefined && pendingReady(world, ownerE);
    const fullness = ownerPending ? pFullness : Math.max(0, pFullness - (T.hungerPerMinute / 60) * dt); if (Math.abs(fullness - pFullness) > 1e-6) world.setField(e, Pet, "fullness", fullness);
    if (!ownerPending && fullness <= 0 && now >= bNextStarve) {
      world.setField(e, PetBrain, "nextStarve", now + sec(10));
      const cur = world.getField(e, Health, "hp")!; if (cur > 1) world.setField(e, Health, "hp", Math.max(1, cur - T.starveHpPerTenSeconds));
      world.setField(e, Pet, "loyalty", Math.max(0, pLoyalty - T.starveLoyaltyPerTenSeconds));
    } else if (!ownerPending && fullness > 50 && now >= bNextStarve) { // well fed: slow regen
      world.setField(e, PetBrain, "nextStarve", now + sec(10)); const cur = world.getField(e, Health, "hp")!; if (cur < st.maxHp) world.setField(e, Health, "hp", Math.min(st.maxHp, cur + 1));
    }
    const ot = ownerE !== undefined ? world.get(ownerE, Transform) : undefined;
    const stay = pCmd === PetCmd.Stay;
    // Task 14: a guarding pet anchors on its guard target (live position for entities, fixed point for locations).
    let guard = pCmd === PetCmd.Guard; let gAnchor = guard ? guardAnchor(world, e) : undefined;
    if (guard && !gAnchor) { // guard target destroyed / died / assignment lost: end guarding cleanly, back to Follow
      world.set(e, Pet, { cmd: PetCmd.Follow }); if (world.has(e, PetGuard)) world.remove(e, PetGuard); guard = false;
    }
    const ax = guard && gAnchor ? gAnchor.x : stay ? pStayX : ot?.x ?? pStayX, ay = guard && gAnchor ? gAnchor.y : stay ? pStayY : ot?.y ?? pStayY;
    let moved = false; let run = false; let busy = false; let fighting = false; let eating = false;
    // defend
    if (!busy) {
      let target = bTarget as Entity;
      const guardR = T.defendRange; const leash = Math.hypot(tx - ax, ty - ay) > T.leashRange;
      if (!valid(world, target) || leash) {
        const found = leash ? undefined : threatNear(world, e, ax, ay, guardR, zombies, pOwner);
        // Task 14: territory defense — a hostile inside the owner's claim near the pet is a defend target too,
        // even when it is beyond the anchor's defend range (the pet, not the anchor, is near the intruder).
        let terr: Entity | undefined;
        if (found === undefined && !leash) { const tribe = ownerE !== undefined ? world.getField(ownerE, Tribe, "id") ?? 0 : 0; if (tribe) terr = nearestClaimHostile(world, tx, ty, guardR, tribe, zombies); }
        target = (found ?? terr ?? 0) as Entity;
      }
      if (target !== bTarget) world.setField(e, PetBrain, "target", target);
      if (target && valid(world, target)) {
        busy = true; fighting = true; const tt = world.get(target, Transform)!; const d = Math.hypot(tt.x - tx, tt.y - ty);
        if (d <= st.attackRange + 0.4) {
          world.set(e, Transform, { facing: Math.atan2(tt.y - ty, tt.x - tx) });
          if (now >= bNextAttack) {
            const before = world.getField(target, Health, "hp") ?? 0; const thp = world.getField(target, Health, "max") ?? before;
            applyDamage(world, target, st.damage, e); setAnim(world, e, Anim.Attack); world.setField(e, PetBrain, "nextAttack", now + sec(T.attackCooldownSeconds));
            const after = world.getField(target, Health, "hp") ?? 0;
            grantXp(world, e, T.xpPerHit * Math.max(1, before - after) + (after <= 0 && before > 0 ? thp * T.xpPerKillHp : 0));
            if (after <= 0) world.setField(e, PetBrain, "target", 0);
          }
        } else { moved = step(world, e, tt.x, tt.y, st.run, dt, st.attackRange); run = true; }
      }
    }
    // eat
    const hungry = fullness < T.eatBelow;
    if (!busy && hungry && now >= bNextEat) { // ADR-145: defence beats dinner (a hungry pet still fights back)
      if (eatFrom(world, e, e, 0)) { world.setField(e, PetBrain, "nextEat", now + sec(T.eatCooldownSeconds)); busy = true; eating = true; }
      else {
        const src = foodSources(world, e, tx, ty, ownerE, bags, getTroughs(), pOwner, pSpecies)[0];
        if (src) {
          const sxy = world.get(src.e, Transform)!; busy = true;
          if (src.d <= (src.source === 2 ? TROUGH_REACH : 1.0)) { if (eatFrom(world, e, src.e, src.source)) { world.setField(e, PetBrain, "nextEat", now + sec(T.eatCooldownSeconds)); eating = true; } }
          else { moved = step(world, e, sxy.x, sxy.y, st.walk, dt, 0.6); }
        } else world.setField(e, PetBrain, "nextEat", now + sec(2));
      }
    }
    // fetch dropped items (follow only — guarding and staying pets hold their post)
    if (!busy && !stay && !guard && ownerE !== undefined) {
      const bag = pickupTarget(world, e, tx, ty, bags, pOwner);
      if (bag !== undefined) {
        busy = true; const bt = world.get(bag, Transform)!; const d = Math.hypot(bt.x - tx, bt.y - ty);
        if (d <= 0.9) {
          for (const s of listSlots(world, bag)) if (s.item && s.count) { const n = Math.min(s.count, canAddItem(world, e, s.item, s.count)); if (n > 0) { const moved1 = moveSlotTuples(world, bag, e, [{ slot: s.slot, count: n }]); if (moved1) break; } }
        } else moved = step(world, e, bt.x, bt.y, st.walk * 1.3, dt, 0.5) || moved;
      }
    }
    // follow / stay / guard return (guarding pets walk back — never teleport, so fences still contain them)
    if (!busy) {
      const d = Math.hypot(ax - tx, ay - ty);
      if (guard) { if (d > 0.4) moved = step(world, e, ax, ay, st.walk, dt, 0.2); }
      else if (!stay && ot && d > T.teleportDistance) { world.set(e, Transform, teleportSpot(world, ot)); }
      else if (!stay && ot && d > T.followDistance) { run = d > T.runDistance; moved = step(world, e, ax, ay, run ? st.run : st.walk, dt, T.followDistance * 0.7); }
      else if (!stay && ot && d > WALLED_STOP && walledOff(world, tx, ty, ax, ay, tz ?? 0, petBlocked(world))) moved = step(world, e, ax, ay, st.walk, dt, WALLED_STOP); // ADR-215: close but through a wall: go round
      else if (stay && d > 0.4) moved = step(world, e, ax, ay, st.walk, dt, 0.2);
    }
    // Task 29: only write Animal when something changed — the old unconditional write marked every
    // pet's Animal changed every tick, spamming replication Change records for stationary pets.
    const aState = moved ? (run ? 2 : 1) : 0;
    if (anD.homeX[anSlot]! !== ax || anD.homeY[anSlot]! !== ay || anD.state[anSlot]! !== aState) world.set(e, Animal, { homeX: ax, homeY: ay, state: aState });
    animAt(world, e, moved ? (run ? Anim.Run : Anim.Walk) : !busy && stay ? Anim.Sit : Anim.Idle);
    // Task 14: visible activity status (written only when it changes, so replicas are not spammed every tick)
    const status = fighting ? PetStatus.Fight : eating ? PetStatus.Eat : guard ? (moved ? PetStatus.Return : PetStatus.Guard) : stay ? PetStatus.Stay : moved ? PetStatus.Follow : PetStatus.Idle;
    if (!world.has(e, PetStatusComp) || world.getField(e, PetStatusComp, "status") !== status) {
      if (world.has(e, PetStatusComp)) world.set(e, PetStatusComp, { status }); else world.add(e, PetStatusComp, { status });
    }
  }
  void defs; void Survival; void Inventory; void addItem; void takeFromSlot;
}
// ---- client view-model (replica reads only) ------------------------------------------------------------
export interface PetOffer { item: number; key: string; name: string; count: number; chance: number; pref: TreatPref | "food"; fullness: number }
/** Task 34: a species' favourite treats (pets.json `love` entries) for the hand-on-pet popup. `key` is the item key (the panel's data-icon); `name` is the item's display name. Empty when the species loves nothing (farm animals have no pet species). */
export interface PetFavorite { key: string; name: string }
export const favoriteTreats = (world: World, s: PetSpecies | undefined): PetFavorite[] => {
  if (!s) return [];
  const defs = gameplayDefs(world);
  return Object.entries(s.treats).filter(([, pref]) => pref === "love").map(([key]) => {
    let name = key; try { name = defs.items.get(defs.itemId(key))?.name ?? key; } catch { /* unknown treat item: show the key */ }
    return { key, name };
  });
};
export interface PetView {
  entity: Entity; species: number; speciesName: string; name: string; owned: boolean; wild: boolean; ownerId: number;
  level: number; xp: number; xpNext: number; hp: number; maxHp: number; fullness: number; loyalty: number; cmd: number; offers: PetOffer[];
  favorites: PetFavorite[];
  status: number; guard: string | undefined; livestock: boolean;
  /** ADR-351: rope lead state for this animal (livestock only; companion pets are never leadable). */
  lead: LeadInfo;
}
/** Display name for an animal kind key ("animal_dog_dachshund" -> "Dog Dachshund"). */
export const animalDisplayName = (key: string): string => key.replace(/^animal_/, "").split("_").map((w) => w ? w[0]!.toUpperCase() + w.slice(1) : w).join(" ");
/** True when `player` owns this tamed farm animal (Tamed.owner is the owner entity). */
export const isTamedOwner = (world: World, player: Entity, e: Entity): boolean => {
  const owner = world.getField(e, Tamed, "owner"); if (owner === undefined) return false;
  const id = pidOf(world, player); return id !== 0 && world.isAlive(owner) && pidOf(world, owner) === id;
};
/** Pet / tameable animal panel data for `player` looking at `e` (undefined = not a pet species). */
export function petView(world: World, player: Entity, e: Entity): PetView | undefined {
  if (!world.isAlive(e) || world.has(e, Dead)) return undefined; const p = world.get(e, Pet); const sp = p?.species ?? speciesOfAnimal(world, e); const s = petSpecies(sp);
  if (!p && world.has(e, Tamed)) {
    // Task 15: owned husbandry livestock gets a panel too (status + skills), so farm skill points are spendable.
    const kind = animalDefs()[world.getField(e, Animal, "kind") ?? -1]?.key; if (!kind) return undefined;
    const name = animalDisplayName(kind); const sk = world.get(e, AnimalSkills); const h = world.get(e, Health);
    return {
      entity: e, species: 0, speciesName: name, name, owned: isTamedOwner(world, player, e), wild: false, ownerId: pidOf(world, world.getField(e, Tamed, "owner") ?? 0) ?? 0,
      level: sk?.level ?? 1, xp: sk?.xp ?? 0, xpNext: animalXpToNext(world, sk?.level ?? 1), hp: h?.hp ?? 0, maxHp: h?.max ?? 0, fullness: 0, loyalty: 0, cmd: 0, offers: [],
      favorites: favoriteTreats(world, PET_SPECIES.find((x) => x.animal === kind)),
      status: PetStatus.Idle, guard: undefined, livestock: true,
      lead: leadInfo(world, player, e),
    };
  }
  if (!s) return undefined;
  const defs = gameplayDefs(world); const offers: PetOffer[] = [];
  for (const sl of listSlots(world, player)) {
    if (!sl.item || !sl.count || offers.some((o) => o.item === sl.item)) continue; const d = defs.items.get(sl.item); if (!d) continue;
    const pref = s.treats[d.key]; const full = petFoodValue(sp, d.key);
    if (p) { if (full > 0) offers.push({ item: d.id, key: d.key, name: d.name, count: countItem(world, player, d.id), chance: 1, pref: pref ?? "food", fullness: full }); }
    else if (pref) offers.push({ item: d.id, key: d.key, name: d.name, count: countItem(world, player, d.id), chance: tameChance(sp, d.key), pref, fullness: full });
  }
  offers.sort((a, b) => b.chance - a.chance || b.fullness - a.fullness || a.item - b.item);
  const level = p?.level ?? 1; const st = p ? petStatsWithSkills(world, e, sp, level) : petStats(sp, level); const h = world.get(e, Health);
  return {
    entity: e, species: sp, speciesName: s.name, name: p ? petName(world, e) : `Wild ${s.name}`, owned: !!p && isPetOwner(world, player, e), wild: !p, ownerId: p?.owner ?? 0,
    level, xp: p?.xp ?? 0, xpNext: petXpToNext(level), hp: h?.hp ?? p?.hp ?? st.maxHp, maxHp: h?.max ?? st.maxHp, fullness: p?.fullness ?? 0, loyalty: p?.loyalty ?? 0, cmd: p?.cmd ?? 0, offers,
    favorites: favoriteTreats(world, s),
    status: world.has(e, PetStatusComp) ? world.getField(e, PetStatusComp, "status")! : p?.cmd === PetCmd.Guard ? PetStatus.Guard : p?.cmd === PetCmd.Stay ? PetStatus.Stay : PetStatus.Idle,
    guard: p?.cmd === PetCmd.Guard ? guardTargetLabel(world, e) : undefined, livestock: false,
    lead: { leadable: false, led: false, ledByMe: false, holderId: 0 },
  };
}
/** Nearest pet (own first), tameable wild animal, or owned farm animal within `range` of the player. */
export function nearestPet(world: World, player: Entity, range = T.interactRange + 0.5): { entity: Entity; d: number } | undefined {
  const me = world.get(player, Transform); if (!me) return undefined; let best: { entity: Entity; d: number } | undefined;
  for (const e of world.query([Animal, Transform], [Dead])) {
    if (!world.has(e, Pet)) {
      if (world.has(e, Tamed)) { if (!isTamedOwner(world, player, e)) continue; } // Task 15: own livestock opens its panel
      else if (!speciesOfAnimal(world, e)) continue;
    }
    const t = world.get(e, Transform)!; const d = Math.hypot(t.x - me.x, t.y - me.y) - (isPetOwner(world, player, e) ? 0.3 : 0);
    if (d <= range && (!best || d < best.d)) best = { entity: e, d };
  }
  return best;
}
/** Short one-line help (also shown in the panel and the help menu); independent of the tutorial. */
export const PET_HELP = [
  "Pets: craft a treat (dog biscuit, meaty chew, fish treat, egg crunch at a campfire; seed mix, veggie bites by hand), walk up to a wild dog, cat, bird, rabbit or ferret and interact (E / X / tap) to offer it.",
  "Each species loves some treats and hates others: the panel shows your chance. A refused treat is kept; a failed try uses it.",
  "Your pet's panel: Follow (fights for you and fetches what you drop) or Stay (guards the spot, your buildings and pets), rename, feed, and a small bag you can fill or empty.",
  "Hungry pets eat from their bag, food lying on the ground, then your pet trough (Build > pet trough). Starving pets lose health slowly and trust, but never die of it.",
  "Pets gain XP fighting; every level adds health, damage and speed.",
  "Guard: in your pet's panel, pick Guard here (this spot), Guard me, or a nearby building, station, player, pet, farm animal or AI human — the pet stays near it, fights threats to it, and returns after. A small symbol above the pet shows what it is doing.",
  "Animal skills: every tameable or farmable animal has its own small skill tree (cows make more milk, dogs bite harder). Animals earn a skill point at levels 1, 6, 11, 16 — spend them in the animal's panel. Farm animals level up by producing and being fed.",
] as const;
