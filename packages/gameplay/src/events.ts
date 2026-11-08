/**
 * Gameplay events through core's EventBus (delivered at end of tick; discarded by core during replay).
 * Every payload is tick-stamped (`tick`) per Netcode; entity fields are local Entities (net maps to NetIds).
 * Reliability per event: DESIGN.md section 7 / EVENT_RELIABILITY.
 */
import { defineEvent, type Entity, type EventType, type World } from "@engine/core";
import type { WeatherKind } from "./defs.js";
import type { DamageCause, ZState } from "./components.js";

export type GEvent<T> = EventType<T & { tick: number }> & { readonly __payload?: T };
export const ev = <T>(name: string): GEvent<T> => defineEvent<T & { tick: number }>(name) as GEvent<T>;
/** Emits with the current tick stamped in (core discards events queued during replay unless keepEvents). */
export function emit<T>(world: World, type: GEvent<T>, payload: T): void {
  world.events.emit(type, { ...payload, tick: world.tick });
}

export const enum GatherFail { Cooldown = 1, InvalidTarget = 2, Depleted = 3, OutOfRange = 4, WrongTool = 5, Exhausted = 6 }
export const enum CraftFail { Busy = 1, UnknownRecipe = 2, NoStation = 3, MissingIngredients = 4, InventoryFull = 5, Cancelled = 6, SkillTooLow = 7, /** ADR-221: the recipe's station is not unlocked */ Locked = 8 }
export const enum Vital { Hunger = 1, Thirst = 2, Stamina = 3 }
export const enum DayPhase { Night = 0, Dawn = 1, Day = 2, Dusk = 3 }
export const enum BuildFail {
  UnknownPiece = 1, BadTier = 2, OutOfRange = 3, LevelLimit = 4, NoPrivilege = 5, ZoneFull = 6, Terrain = 7, Occupied = 8,
  Blocked = 9, NoSocket = 10, NoSupport = 11, CannotAfford = 12, InvalidTarget = 13, NotPaintable = 14, RepairBlocked = 15,
  NothingToRepair = 16, Locked = 17, ViewersFull = 18, NotViewing = 19, NotFuelable = 20,
  /** ADR-211: a straight wall may not take an outer foundation-corner slot (that is the L corner piece's job). */
  CornerSlot = 21,
  /** ADR-221: the station piece or building tier needs a skill-tree unlock. */
  SkillLocked = 22,
  /** Task 25: painting / dyeing needs a paint brush in the hotbar. */
  NoBrush = 23,
  /** ADR-265: a terrain ladder needs two different-height dry landings. */
  NoTerrainFace = 24,
  /** ADR-299: a shaft hatch needs a dug hole below the surrounding rim. */
  NoShaft = 25,
}
export const enum DestroyCause { Damage = 1, Collapse = 2, Demolish = 3 }

export const ItemGathered = ev<{ entity: Entity; node: Entity; item: number; count: number }>("gameplay.ItemGathered");
export const GatherSwing = ev<{ entity: Entity; node: Entity }>("gameplay.GatherSwing");
export const GatherFailed = ev<{ entity: Entity; node: Entity; reason: GatherFail }>("gameplay.GatherFailed");
export const NodeDepleted = ev<{ node: Entity; kind: number }>("gameplay.NodeDepleted");
export const NodeRespawned = ev<{ node: Entity; kind: number }>("gameplay.NodeRespawned");
export const InventoryOverflow = ev<{ entity: Entity; item: number; lost: number }>("gameplay.InventoryOverflow");
export const CraftStarted = ev<{ entity: Entity; recipe: number; totalTicks: number }>("gameplay.CraftStarted");
export const CraftCompleted = ev<{ entity: Entity; recipe: number; item: number; count: number }>("gameplay.CraftCompleted");
export const CraftFailed = ev<{ entity: Entity; recipe: number; reason: CraftFail }>("gameplay.CraftFailed");
/** ADR-135: a small XP-earning activity (source = data/xp.json sources key); progression awards it. */
export const XpActivity = ev<{ entity: Entity; source: string; units: number }>("gameplay.XpActivity");
export const ItemConsumed = ev<{ entity: Entity; item: number }>("gameplay.ItemConsumed");
/** ADR-128: why a Use (eat/drink) was refused. */
export const enum ConsumeFail { Cooldown = 1, Rotten = 2, Empty = 3, NotConsumable = 4, NoFire = 5, NotNeeded = 6 }
export const ConsumeFailed = ev<{ entity: Entity; item: number; reason: ConsumeFail }>("gameplay.ConsumeFailed");
/** ADR-128: a liquid container was refilled at a water tile (sips added) or the player drank from the tile (item 0). */
export const WaterDrunk = ev<{ entity: Entity; item: number; sips: number }>("gameplay.WaterDrunk");
export const VitalDepleted = ev<{ entity: Entity; vital: Vital }>("gameplay.VitalDepleted");
export const Died = ev<{ entity: Entity; cause: DamageCause }>("gameplay.Died");
export const WeatherChanged = ev<{ from: WeatherKind; to: WeatherKind; intensity: number; ticks: number }>("gameplay.WeatherChanged");
export const DayPhaseChanged = ev<{ phase: DayPhase; day: number }>("gameplay.DayPhaseChanged");
export const FuelOut = ev<{ entity: Entity }>("gameplay.FuelOut");
export const FireToggled = ev<{ entity: Entity; lit: number }>("gameplay.FireToggled");
// building
export const PiecePlaced = ev<{ piece: Entity; type: number; builder: Entity }>("gameplay.PiecePlaced");
export const FarmFailed = ev<{ entity: Entity; reason: number }>("gameplay.FarmFailed");
export const PlantDied = ev<{ x: number; y: number; kind: number }>("gameplay.PlantDied");
export const BuildFailed = ev<{ entity: Entity; action: number; reason: BuildFail }>("gameplay.BuildFailed");
export const PieceDamaged = ev<{ piece: Entity; hp: number; amount: number; attacker: Entity }>("gameplay.PieceDamaged");
export const PieceDestroyed = ev<{ piece: Entity; type: number; cause: DestroyCause }>("gameplay.PieceDestroyed");
export const PieceUpgraded = ev<{ piece: Entity; tier: number }>("gameplay.PieceUpgraded");
export const PieceRepaired = ev<{ piece: Entity; hp: number }>("gameplay.PieceRepaired");
export const PiecePainted = ev<{ piece: Entity; paint: number }>("gameplay.PiecePainted");
export const DoorToggled = ev<{ door: Entity; open: number }>("gameplay.DoorToggled");
export const ContainerOpened = ev<{ container: Entity; entity: Entity; clientId: number }>("gameplay.ContainerOpened");
export const ContainerClosed = ev<{ container: Entity; entity: Entity; clientId: number }>("gameplay.ContainerClosed");
// combat / zombies
export const AttackSwing = ev<{ entity: Entity; target: Entity }>("gameplay.AttackSwing");
export const Damaged = ev<{ target: Entity; source: Entity; amount: number; cause: DamageCause }>("gameplay.Damaged");
export const RaidAlarm = ev<{ bell: Entity; piece: Entity; tribe: number }>("gameplay.RaidAlarm");
export const Ignited = ev<{ entity: Entity }>("gameplay.Ignited");
export const Extinguished = ev<{ entity: Entity }>("gameplay.Extinguished");
export const ZombieSpawned = ev<{ zombie: Entity; kind: number }>("gameplay.ZombieSpawned");
export const ZombieStateChanged = ev<{ zombie: Entity; state: ZState }>("gameplay.ZombieStateChanged");

/** Suggested channel per event name (Netcode decides). */
export const EVENT_RELIABILITY: Readonly<Record<string, "reliable" | "unreliable">> = {
  "gameplay.PiecePlaced": "reliable", "gameplay.PieceDestroyed": "reliable", "gameplay.PieceUpgraded": "reliable", "gameplay.Died": "reliable",
  "gameplay.CraftCompleted": "reliable", "gameplay.ItemGathered": "reliable", "gameplay.ContainerOpened": "reliable", "gameplay.ContainerClosed": "reliable",
  "gameplay.BuildFailed": "reliable", "gameplay.FarmFailed": "reliable", "gameplay.ZombieSpawned": "reliable", "gameplay.RaidAlarm": "reliable",
  "gameplay.Ignited": "unreliable", "gameplay.Extinguished": "unreliable",
  "gameplay.GatherSwing": "unreliable", "gameplay.AttackSwing": "unreliable", "gameplay.PieceDamaged": "unreliable", "gameplay.DoorToggled": "unreliable",
  "gameplay.ZombieStateChanged": "unreliable", "gameplay.Damaged": "unreliable",
  "gameplay.ConsumeFailed": "unreliable", "gameplay.WaterDrunk": "unreliable",
  "gameplay.DeathBagDropped": "reliable", "gameplay.Respawned": "reliable", "gameplay.HitRejected": "unreliable", "gameplay.GateBreached": "reliable",
};
