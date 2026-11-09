/**
 * ADR-319 / ADR-320 mount + saddle data (data/mounts.json) and pure helpers. Kept free of system imports (components,
 * config and core only) so movement, combat (armorOf) and population can read it without ESM cycles.
 *
 * Realism (t363): every species carries real-world metres (withers, head/antler top, body length, body width, saddle
 * seat height) relative to the 1.75 m player. Render scale, the rider's seat lift, the collision footprint and the
 * doorway / ceiling clearance checks all derive from that one table, so a mount never looks or behaves "toy sized".
 */
import { NetId, PlayerId, type Entity, type World } from "@engine/core";
import raw from "../data/mounts.json";
import { Equipment, Mount, Riding, Tribe, Worker } from "./components.js";
import { gameplayDefs } from "./config.js";

export type FoodPref = "love" | "like" | "ok";
export interface MountSize { withersM: number; headTopM: number; lengthM: number; widthM: number; seatM: number }
export interface MountSpecies {
  key: string; name: string; animals: { key: string; artTopPx: number }[]; pendingArt?: boolean;
  walk: number; gallop: number; accel: number; turn: number; hp: number; tameDifficulty: number;
  foods: Record<string, FoodPref>; traits: string[]; fallSafeBonus: number; swims: boolean; size: MountSize;
}
export interface SaddleDef { tier: number; item: string; name: string; slots: number; defense: number; durability: number }
export const MOUNT_SCALE: Readonly<typeof raw.scale> = raw.scale;
export const MOUNT_TUNING: Readonly<typeof raw.tuning> = raw.tuning;
export const MOUNT_SPECIES: readonly MountSpecies[] = raw.species as MountSpecies[];
export const SADDLES: readonly SaddleDef[] = raw.saddles as SaddleDef[];
/** Pixels per real metre at the character scale (1x): the player is playerHeightPx tall for playerHeightM. */
export const PX_PER_M = MOUNT_SCALE.playerHeightPx / MOUNT_SCALE.playerHeightM;

/** Species row (1-based index, Mount.species / Riding.species); undefined for 0 / out of range. */
export const mountSpecies = (i: number): MountSpecies | undefined => MOUNT_SPECIES[i - 1];
/** Species index (1-based) for an animal archetype key (ai.json `animal_*`), 0 = not rideable. */
export function mountSpeciesOfAnimal(animalKey: string | undefined): number {
  if (!animalKey) return 0; const i = MOUNT_SPECIES.findIndex((s) => s.animals.some((a) => a.key === animalKey)); return i + 1;
}
export const mountSpeciesOfKey = (key: string): number => MOUNT_SPECIES.findIndex((s) => s.key === key) + 1;

// ---- realism (t363) ----------------------------------------------------------------------------------------
/** Target on-screen height (1x px, pivot to the tallest point: head / antlers / hump) for a species. */
export const targetTopPx = (s: MountSpecies): number => s.size.headTopM * PX_PER_M;
/**
 * Draw scale for an animal sprite so its tallest point matches the species' real height next to the player. Existing
 * (pre-mount) art was drawn small; dedicated mount art drawn at targetTopPx comes out at 1 (artTopPx 0 = native).
 * Non-rideable animals keep 1.
 */
export function mountRenderScale(animalKey: string | undefined): number {
  const sp = mountSpecies(mountSpeciesOfAnimal(animalKey)); const a = sp?.animals.find((x) => x.key === animalKey);
  if (!sp || !a || !(a.artTopPx > 0)) return 1;
  return Math.round((targetTopPx(sp) / a.artTopPx) * 1000) / 1000;
}
/** Seat height above the ground in terrain z levels (16 px each), minus the seated pose's hip height above its own pivot. */
export function riderSeatLiftZ(species: number): number {
  const s = mountSpecies(species); if (!s) return 0;
  return ((s.size.seatM - MOUNT_SCALE.riderSitHipM) * PX_PER_M) / MOUNT_SCALE.zStepPx;
}
/** Top of the seated rider's head above the ground (m). */
export const riderHeadM = (species: number): number => (mountSpecies(species)?.size.seatM ?? 0) + MOUNT_SCALE.seatedTorsoM;
/** A rider fits through a doorway / under a floor above only when their head clears it (donkeys fit, horses do not). */
export const fitsDoorway = (species: number): boolean => riderHeadM(species) <= MOUNT_SCALE.doorwayClearanceM;
export const fitsUnderCeiling = (species: number): boolean => riderHeadM(species) <= MOUNT_SCALE.ceilingClearanceM;
/** Collision half-size (tiles; 1 tile = 1 m) of a mounted rider: half the body width plus a hand's margin, kept under half a tile. */
export function mountBodyRadius(species: number): number {
  const s = mountSpecies(species); if (!s) return 0.3;
  return Math.min(0.48, Math.max(0.3, s.size.widthM / 2 + 0.05));
}

// ---- saddles (ADR-320) -----------------------------------------------------------------------------------
export const saddleOfTier = (tier: number): SaddleDef | undefined => SADDLES.find((s) => s.tier === tier);
export const saddleOfItemKey = (key: string | undefined): SaddleDef | undefined => (key ? SADDLES.find((s) => s.item === key) : undefined);
/** Saddlebag slots for a tier (0 = bareback). */
export const saddleSlots = (tier: number): number => saddleOfTier(tier)?.slots ?? 0;
/** Armor points (same units as Worn.armor: damage x 100 / (100 + armor)) a saddle gives rider and mount; 0 when broken. */
export const saddleDefense = (tier: number, dur: number): number => (dur > 0 ? saddleOfTier(tier)?.defense ?? 0 : 0);

/** The Mount entity a rider sits on (scan of the few Mount entities by NetId), or undefined. */
export function mountOfRider(world: World, rider: Entity): Entity | undefined {
  if (!world.isRegistered(Riding) || !world.has(rider, Riding)) return undefined;
  const id = world.getField(rider, Riding, "mountNetId") ?? 0; if (!id) return undefined;
  for (const m of world.query([Mount, NetId])) if (world.getField(m, NetId, "id") === id) return m;
  return undefined;
}
/** ADR-320: extra armor from a saddle: a saddled mount's own, and the rider's (the mount they sit on). */
export function saddleArmorOf(world: World, e: Entity): number {
  if (!world.isRegistered(Mount)) return 0;
  const m = world.has(e, Mount) ? e : mountOfRider(world, e); if (m === undefined) return 0;
  return saddleDefense(world.getField(m, Mount, "saddle") ?? 0, world.getField(m, Mount, "saddleDur") ?? 0);
}

/** Preference of a species for a food item key (undefined = refused). */
export const foodPref = (species: number, itemKey: string | undefined): FoodPref | undefined => (itemKey ? mountSpecies(species)?.foods[itemKey] : undefined);
/** ADR-319 lure: a wild mount-species animal neither flees from nor charges someone holding a food it likes in hand. */
export function luresMount(world: World, animalKey: string | undefined, who: Entity): boolean {
  const sp = mountSpeciesOfAnimal(animalKey); if (!sp || !world.isRegistered(Equipment)) return false;
  const item = world.getField(who, Equipment, "mainHandItem") ?? 0; if (!item) return false;
  return foodPref(sp, gameplayDefs(world).items.get(item)?.key) !== undefined;
}

// ---- ownership (ADR-319; same circle as PieceOwner: the player, their tribe / clan, or a worker they employ) -------
export const playerIdOf = (world: World, e: Entity): number => (world.isRegistered(PlayerId) && world.has(e, PlayerId) ? world.getField(e, PlayerId, "id") ?? 0 : 0);
/** Owner id a new tame is recorded under: a hired worker tames for their employer; players and AI humans for themselves. */
export function mountOwnerIdFor(world: World, e: Entity): number {
  const boss = world.isRegistered(Worker) && world.has(e, Worker) ? world.getField(e, Worker, "owner") ?? 0 : 0;
  return boss || playerIdOf(world, e);
}
const tribeIdOf = (world: World, e: Entity): number => (world.isRegistered(Tribe) && world.has(e, Tribe) ? world.getField(e, Tribe, "id") ?? 0 : 0);
/** True when `who` may ride, saddle, feed-heal and open the saddlebag of mount `m`. */
export function mayUseMount(world: World, who: Entity, m: Entity): boolean {
  if (!world.isRegistered(Mount) || !world.has(m, Mount)) return false;
  const owner = world.getField(m, Mount, "owner") ?? 0, tribe = world.getField(m, Mount, "tribe") ?? 0;
  if (!owner && !tribe) return true;
  const pid = playerIdOf(world, who); if (owner && pid === owner) return true;
  if (tribe && tribeIdOf(world, who) === tribe) return true;
  return !!owner && world.isRegistered(Worker) && world.has(who, Worker) && (world.getField(who, Worker, "owner") ?? 0) === owner;
}
/** ADR-320 / ADR-303: the saddlebag is a container only while a saddle is on and only for those who may use the mount. */
export const canOpenSaddlebag = (world: World, who: Entity, m: Entity): boolean => mayUseMount(world, who, m) && (world.getField(m, Mount, "saddle") ?? 0) > 0;
