/** Spawn helpers (server spawns; NetId assignment is net's job) and test/bot intent helper. */
import { DEFAULT_TICK_HZ, entityIndex, Owner, Transform, type Entity, type SchemaInit, type World } from "@engine/core";
import { Falloff, installSpatialIndex } from "@engine/world";
import {
  Attacker, Worn, WeaponState, Progression, Buffs, Container, CraftingStation, Crafter, Emitter, Equipment, Exposure, Fuel, Gatherer, Health,
  AutoSprint, Inventory, PlayerIntent, ResourceNode, Survival, Tribe, VitalsState,
} from "./components.js";
import { gameplayDefs } from "./config.js";
import { StationKind } from "./defs.js";
import { EmitterKind } from "./realism.js";
import { STATION_HEAT } from "./systems/fuel.js";

/** New entities are not in the spatial index until postSim; spawn helpers insert directly so same-tick queries see them. */
export function indexEntity(world: World, e: Entity): void {
  const tf = world.store(Transform); const sl = tf.slot(entityIndex(e)); if (sl < 0) return;
  installSpatialIndex(world).hash.insert(e, tf.data.x[sl]!, tf.data.y[sl]!);
}

export interface PlayerSpawn { x: number; y: number; clientId?: number; slots?: number; maxWeight?: number; reach?: number; tribe?: number }
export function spawnPlayer(world: World, p: PlayerSpawn): Entity {
  const vt = gameplayDefs(world).vitals; const e = world.create();
  world.add(e, Transform, { x: p.x, y: p.y })
    .add(e, Health, { hp: vt.maxHealth, max: vt.maxHealth })
    .add(e, Survival, { hunger: 100, thirst: 100, stamina: vt.maxStamina, maxStamina: vt.maxStamina, bodyTemp: vt.bodyTempNormal })
    .add(e, VitalsState).add(e, Exposure).add(e, Buffs)
    .add(e, Inventory, { ...(p.slots !== undefined && { slotCount: p.slots }), ...(p.maxWeight !== undefined && { maxWeight: p.maxWeight }) })
    .add(e, Equipment).add(e, Gatherer, { ...(p.reach !== undefined && { reach: p.reach }) })
    .add(e, Crafter).add(e, AutoSprint).add(e, PlayerIntent).add(e, Attacker).add(e, Worn).add(e, WeaponState).add(e, Progression, { level: 1 });
  if (p.clientId !== undefined) world.add(e, Owner, { clientId: p.clientId });
  if (p.tribe !== undefined) world.add(e, Tribe, { id: p.tribe });
  indexEntity(world, e);
  return e;
}

export function spawnResourceNode(world: World, kind: number | string, x: number, y: number): Entity {
  const defs = gameplayDefs(world);
  const id = typeof kind === "string" ? defs.resourceId(kind) : kind;
  const def = defs.resources.get(id); if (!def) throw new Error(`unknown resource ${kind}`);
  const e = world.create();
  world.add(e, Transform, { x, y }).add(e, ResourceNode, { kind: id, amount: def.capacity });
  indexEntity(world, e);
  return e;
}

/** Free-standing station (tests/tools; placed stations come from building). Fired kinds get Fuel + fuel slots. */
export function spawnStation(world: World, kind: StationKind, x: number, y: number, opts: { range?: number; burnSeconds?: number } = {}): Entity {
  const e = world.create();
  world.add(e, Transform, { x, y }).add(e, CraftingStation, { kind, ...(opts.range !== undefined && { range: opts.range }) });
  if (kind === StationKind.Campfire || kind === StationKind.Furnace) {
    const lit = (opts.burnSeconds ?? 600) > 0 ? 1 : 0;
    const h = STATION_HEAT[kind]!;
    world.add(e, Emitter, { kind: EmitterKind.Heat, radius: h.radius, strength: lit ? h.strength : 0, falloff: Falloff.Linear })
      .add(e, Fuel, { lit, burnUntilTick: world.tick + Math.round((opts.burnSeconds ?? 600) * DEFAULT_TICK_HZ) })
      .add(e, Container, { slotCount: 4 });
  }
  indexEntity(world, e);
  return e;
}

/** Input-phase helper (tests/bots): writes a player's intent for this tick. */
export function setIntent(world: World, e: Entity, intent: SchemaInit<(typeof PlayerIntent)["schema"]>): void {
  world.set(e, PlayerIntent, intent);
}
