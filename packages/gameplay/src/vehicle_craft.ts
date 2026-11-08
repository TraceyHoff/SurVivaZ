/**
 * SurVivaZ vehicle crafting, fuel, repair and camper stations (Survival, on the Engine Architect vehicle core in
 * vehicles.ts - core untouched). DESIGN.md §31, data/vehicle_items.json, vehicle_recipes.json, vehicle_crafting.json.
 *  - Spawn method: placeable vehicle KITS. A kit is an ordinary recipe output (so it carries the crafter in its slot's
 *    crafterId like every crafted item); gameplay.vehicleDeploy consumes it and calls spawnVehicle, then stamps
 *    VehicleCondition.crafterId. Kits can be traded/stored before deploying.
 *  - Fuel: gameplay.vehicleRefuel pours fuel items (1 item = 1 L) whose class matches the def; bicycles have no tank
 *    (stamina, vehicles.ts) and trailers none. Consumption is the core's (stepPowered).
 *  - Repair: gameplay.vehicleRepair spends one use of a repair item (kits lose durability, parts are consumed):
 *    field fraction anywhere, garage fraction near a garage. Field repairs add wear (caps effective max health);
 *    a garage repair clears wear. Wrecked (health 0) vehicles need a wreckOk part at a garage.
 *  - Camper stations: a parked camper's interior stations count as crafting stations for stationInRange (crafting
 *    and cooking), via addStationProvider; interior fires are propane (always lit). addVehicleStationHook emits
 *    VehicleStationOpened so UI opens the craft menu filtered to that station.
 * All handlers are validate/handle commands (ADR-092): players and bots use the same path.
 */
import { defineCommand, fnv1a, PlayerId, Transform, type CommandHandlers, type Entity, type World } from "@engine/core";
import raw from "../data/vehicle_crafting.json";
import { Dead, Vehicle, VehicleCondition } from "./components.js";
import { gameplayDefs } from "./config.js";
import { lockAndIssueKey } from "./vehicle_keys.js";
import { StationKind } from "./defs.js";
import { emit, ev } from "./events.js";
import { hasSkillUnlock, skillMul } from "./skills/tree.js";
import { itemRepairUnlocked } from "./building/place.js";
import { readSlots, writeSlots } from "./inventory.js";
import { addStationProvider, stationInRange } from "./systems/crafting.js";
import { addVehicleStationHook, isParked, nearbyVehicleStationKinds, spawnVehicle, vehicleDefId, vehicleDefOf, VEHICLE_DEFS, type VehicleClass } from "./vehicles.js";

export interface VehicleCraftRules {
  deploy: { reach: number; startFuel: number };
  refuel: { reach: number; maxPerCommand: number };
  fuels: Record<string, { classes: string[]; liters: number }>;
  repair: { reach: number; garageRange: number; wearPerField: number; items: Record<string, { field: number; garage: number; classes: string[]; wreckOk: boolean }> };
  vehicles: Record<string, { kit: string; fuel: "gasoline" | "diesel" | "none" }>;
  bots: { minBraveryToDrive: number; minIndustriousnessToHitch: number; driveMinDistance: number; arriveDistance: number; seekRadius: number; refuelBelow: number; repairBelow: number; hitchWhenInvFreeBelow: number };
}
export const VEHICLE_CRAFT: VehicleCraftRules = raw as VehicleCraftRules;
/** Schema salt "gameplay.vehicleCraft" (rules change sim results). */
export const VEHICLE_CRAFT_HASH: number = fnv1a(JSON.stringify(VEHICLE_CRAFT)) >>> 0;

/** Static check: every vehicle def has a kit item + recipe, fuel classes match, repair items exist. */
export function validateVehicleCraft(world: World, rules: VehicleCraftRules = VEHICLE_CRAFT): string[] {
  const defs = gameplayDefs(world); const errs: string[] = [];
  const itemId = (k: string): number | undefined => [...defs.items.values()].find((i) => i.key === k)?.id;
  for (const d of VEHICLE_DEFS) {
    const r = rules.vehicles[d.id]; if (!r) { errs.push(`${d.id}: no kit`); continue; }
    const kit = itemId(r.kit); if (kit === undefined) errs.push(`${d.id}: kit item ${r.kit} missing`);
    else if (![...defs.recipes.values()].some((x) => x.output.item === kit)) errs.push(`${d.id}: no recipe for ${r.kit}`);
    if ((r.fuel === "none") !== !d.fuel) errs.push(`${d.id}: fuel class ${r.fuel} vs def fuel`);
  }
  for (const k of [...Object.keys(rules.fuels), ...Object.keys(rules.repair.items)]) if (itemId(k) === undefined) errs.push(`item ${k} missing`);
  return errs;
}

// ---- events -----------------------------------------------------------------------------------------
export const VehicleDeployed = ev<{ entity: Entity; vehicle: Entity; defId: number; crafterId: number }>("gameplay.VehicleDeployed");
export const VehicleRefueled = ev<{ entity: Entity; vehicle: Entity; item: number; liters: number; fuel: number }>("gameplay.VehicleRefueled");
export const VehicleRepaired = ev<{ entity: Entity; vehicle: Entity; item: number; health: number; atGarage: boolean }>("gameplay.VehicleRepaired");
export const VehicleStationOpened = ev<{ entity: Entity; vehicle: Entity; station: number; kind: number }>("gameplay.VehicleStationOpened");

// ---- commands (append-only; registered after the other gameplay commands) ---------------------------
/** Deploy the vehicle kit in inventory `slot` at (x, y) facing heading (radians). */
export const VehicleDeployCmd = defineCommand("gameplay.vehicleDeploy", { slot: "u8", x: "f32", y: "f32", heading: "f32" });
/** Pour up to `count` fuel items from inventory `slot` into vehicle target. */
export const VehicleRefuelCmd = defineCommand("gameplay.vehicleRefuel", { target: "u32", slot: "u8", count: "u8" });
/** Use the repair item in inventory `slot` on vehicle target. */
export const VehicleRepairCmd = defineCommand("gameplay.vehicleRepair", { target: "u32", slot: "u8" });
export const VEHICLE_CRAFT_COMMANDS = [VehicleDeployCmd, VehicleRefuelCmd, VehicleRepairCmd] as const;
export const VEHICLE_CRAFT_ENTITY_FIELDS: Readonly<Record<string, readonly string[]>> = { [VehicleRefuelCmd.name]: ["target"], [VehicleRepairCmd.name]: ["target"] };

const pos = (world: World, e: Entity): { x: number; y: number } | undefined => world.get(e, Transform);
const dist = (world: World, a: Entity, b: Entity): number => { const p = pos(world, a), q = pos(world, b); return p && q ? Math.hypot(p.x - q.x, p.y - q.y) : Infinity; };
const reachTo = (world: World, actor: Entity, v: Entity, extra: number): boolean => { const d = vehicleDefOf(world, v); return !!d && dist(world, actor, v) <= d.footprint.length / 2 + extra; };
const keyOf = (world: World, item: number): string | undefined => gameplayDefs(world).items.get(item)?.key;
const kitToDef = new Map(Object.entries(VEHICLE_CRAFT.vehicles).map(([def, r]) => [r.kit, def]));
/** Vehicle def key a kit item deploys (undefined = not a kit). */
export const kitVehicle = (world: World, item: number): string | undefined => kitToDef.get(keyOf(world, item) ?? "");
/** Kit item key for a vehicle def key. */
export const vehicleKitKey = (def: string): string | undefined => VEHICLE_CRAFT.vehicles[def]?.kit;

function slotOf(world: World, e: Entity, slot: number): { item: number; count: number; durability: number; crafter: number } | undefined {
  let v; try { v = readSlots(world, e); } catch { return undefined; }
  if (slot >= v.slotCount || !v.count(slot)) return undefined;
  return { item: v.item(slot), count: v.count(slot), durability: v.durability(slot), crafter: v.crafter(slot) };
}
/** Takes n from a slot (n = 0: spend one durability use; slot empties at 0). */
function spend(world: World, e: Entity, slot: number, n: number): void {
  const defs = gameplayDefs(world); const v = readSlots(world, e); const item = v.item(slot);
  if (n === 0 && (defs.items.get(item)?.maxDurability ?? 0) > 0) { const d = v.durability(slot) - 1; if (d > 0) v.put(slot, item, v.count(slot), v.created(slot), d); else v.put(slot, item, v.count(slot) - 1); }
  else v.put(slot, item, v.count(slot) - Math.max(1, n));
  writeSlots(world, e, v, defs);
}

// ---- deploy ----------------------------------------------------------------------------------------------
export function validateDeploy(world: World, actor: Entity, slot: number, x: number, y: number): string | undefined {
  if (world.has(actor, Dead)) return "dead";
  const s = slotOf(world, actor, slot); if (!s) return "empty_slot";
  if (!kitVehicle(world, s.item)) return "not_kit";
  const p = pos(world, actor); if (!p || !Number.isFinite(x) || !Number.isFinite(y) || Math.hypot(p.x - x, p.y - y) > VEHICLE_CRAFT.deploy.reach) return "too_far";
  return undefined;
}
/** Server: consume the kit and spawn its vehicle (crafter recorded). Returns the vehicle or a rejection reason. */
export function deployVehicleKit(world: World, actor: Entity, slot: number, x: number, y: number, heading = 0): Entity | string {
  const why = validateDeploy(world, actor, slot, x, y); if (why) return why;
  const s = slotOf(world, actor, slot)!; const defKey = kitVehicle(world, s.item)!;
  spend(world, actor, slot, 1);
  const v = spawnVehicle(world, defKey, x, y, heading); const d = vehicleDefOf(world, v)!;
  if (d.fuel) world.setField(v, Vehicle, "fuel", d.fuel.capacity * VEHICLE_CRAFT.deploy.startFuel);
  world.add(v, VehicleCondition, { crafterId: s.crafter, wear: 0 });
  if (d.seats > 0 && d.class !== "trailer") lockAndIssueKey(world, v, actor, s.crafter || (world.isRegistered(PlayerId) ? world.getField(actor, PlayerId, "id") ?? 0 : 0)); // ADR-109
  emit(world, VehicleDeployed, { entity: actor, vehicle: v, defId: vehicleDefId(defKey), crafterId: s.crafter });
  return v;
}
/** Crafter PlayerId recorded on a deployed vehicle (0 = world-spawned / unknown). */
export const vehicleCrafter = (world: World, v: Entity): number => world.getField(v, VehicleCondition, "crafterId") ?? 0;

// ---- fuel ------------------------------------------------------------------------------------------------
/** Fuel class a vehicle def burns ("none" = stamina or towed). */
export const vehicleFuelClass = (world: World, v: Entity): string => VEHICLE_CRAFT.vehicles[vehicleDefOf(world, v)?.id ?? ""]?.fuel ?? "none";
/** Does fuel item `item` fit vehicle v? */
export function fuelFits(world: World, v: Entity, item: number): boolean {
  const f = VEHICLE_CRAFT.fuels[keyOf(world, item) ?? ""]; return !!f && f.classes.includes(vehicleFuelClass(world, v));
}
export function validateRefuel(world: World, actor: Entity, v: Entity, slot: number): string | undefined {
  if (!world.has(v, Vehicle)) return "not_vehicle"; if (world.has(actor, Dead)) return "dead";
  const d = vehicleDefOf(world, v)!; if (!d.fuel) return "no_tank";
  if (!isParked(world, v)) return "moving";
  if (!reachTo(world, actor, v, VEHICLE_CRAFT.refuel.reach)) return "too_far";
  const s = slotOf(world, actor, slot); if (!s) return "empty_slot";
  if (!VEHICLE_CRAFT.fuels[keyOf(world, s.item) ?? ""]) return "not_fuel";
  if (!fuelFits(world, v, s.item)) return "wrong_fuel";
  if ((world.getField(v, Vehicle, "fuel") ?? 0) >= d.fuel.capacity - 1e-3) return "full";
  return undefined;
}
/** Pours whole items only (no overfill, so a nearly full tank takes fewer). Returns liters added or a reason. */
export function refuelVehicle(world: World, actor: Entity, v: Entity, slot: number, count = 1): number | string {
  const why = validateRefuel(world, actor, v, slot); if (why) return why;
  const d = vehicleDefOf(world, v)!; const s = slotOf(world, actor, slot)!; const f = VEHICLE_CRAFT.fuels[keyOf(world, s.item)!]!;
  const fuel = world.getField(v, Vehicle, "fuel")!; const room = d.fuel!.capacity - fuel;
  const n = Math.max(1, Math.min(count || 1, s.count, VEHICLE_CRAFT.refuel.maxPerCommand, Math.ceil(room / f.liters)));
  const liters = Math.min(room, n * f.liters * skillMul(world, actor, "vfuel")); spend(world, actor, slot, n);
  world.setField(v, Vehicle, "fuel", fuel + liters);
  emit(world, VehicleRefueled, { entity: actor, vehicle: v, item: s.item, liters, fuel: fuel + liters });
  return liters;
}

// ---- repair ----------------------------------------------------------------------------------------------
/** Effective max health after wear (field repairs wear the vehicle; garages restore it). */
export function vehicleMaxHealth(world: World, v: Entity): number {
  const d = vehicleDefOf(world, v); if (!d) return 0; return d.health * (1 - (world.getField(v, VehicleCondition, "wear") ?? 0));
}
export const atGarage = (world: World, actor: Entity): boolean => stationInRange(world, actor, StationKind.Garage);
export function validateRepair(world: World, actor: Entity, v: Entity, slot: number): string | undefined {
  if (!world.has(v, Vehicle)) return "not_vehicle"; if (world.has(actor, Dead)) return "dead";
  if (!isParked(world, v)) return "moving";
  if (!reachTo(world, actor, v, VEHICLE_CRAFT.repair.reach)) return "too_far";
  const s = slotOf(world, actor, slot); if (!s) return "empty_slot";
  const r = VEHICLE_CRAFT.repair.items[keyOf(world, s.item) ?? ""]; if (!r) return "not_repair_item";
  const d = vehicleDefOf(world, v)!; if (r.classes.length && !r.classes.includes(d.class as VehicleClass)) return "wrong_part";
  if (!itemRepairUnlocked(world, actor, s.item) || !hasSkillUnlock(world, actor, `piece:${d.id}`)) return "skill_locked";
  const garage = atGarage(world, actor); const amt = garage ? r.garage : r.field; if (amt <= 0) return "needs_garage";
  const hp = world.getField(v, Vehicle, "health")!;
  if (hp <= 0 && !(r.wreckOk && garage)) return "wrecked";
  if (hp >= (garage ? d.health : vehicleMaxHealth(world, v)) - 1e-3) return "full";
  return undefined;
}
/** Applies one repair use. Returns new health or a reason. */
export function repairVehicle(world: World, actor: Entity, v: Entity, slot: number): number | string {
  const why = validateRepair(world, actor, v, slot); if (why) return why;
  const s = slotOf(world, actor, slot)!; const r = VEHICLE_CRAFT.repair.items[keyOf(world, s.item)!]!; const d = vehicleDefOf(world, v)!;
  const garage = atGarage(world, actor);
  if (!world.has(v, VehicleCondition)) world.add(v, VehicleCondition, { crafterId: 0, wear: 0 });
  const wear = garage ? 0 : Math.min(0.5, world.getField(v, VehicleCondition, "wear")! + VEHICLE_CRAFT.repair.wearPerField);
  world.setField(v, VehicleCondition, "wear", wear);
  const cap = d.health * (1 - wear); const hp = Math.min(cap, Math.max(world.getField(v, Vehicle, "health")!, 0) + d.health * (garage ? r.garage : r.field) * skillMul(world, actor, "repair"));
  spend(world, actor, slot, 0); world.setField(v, Vehicle, "health", hp);
  emit(world, VehicleRepaired, { entity: actor, vehicle: v, item: s.item, health: hp, atGarage: garage });
  return hp;
}

// ---- camper stations -------------------------------------------------------------------------------------
/** Install on every peer (installGameplay does): camper interiors as crafting stations + UI hook. */
export function installVehicleCraft(world: World): void {
  addStationProvider(world, { name: "vehicle.interior", has: (w, e, kind) => nearbyVehicleStationKinds(w, e).has(kind) });
  addVehicleStationHook(world, { name: "survival.stations", onUse: (w, player, vehicle, st) => emit(w, VehicleStationOpened, { entity: player, vehicle, station: st.index, kind: st.kind }) });
}

/** Server: register gameplay.vehicleDeploy / vehicleRefuel / vehicleRepair handlers (same path for bots). */
export function installVehicleCraftCommands(world: World, handlers: CommandHandlers): void {
  const run = (r: unknown): void => { if (typeof r === "string") throw new Error(r); };
  handlers.on(VehicleDeployCmd, { validate: (v, c) => validateDeploy(world, c.actor, v.slot, v.x, v.y), handle: (v, c) => run(deployVehicleKit(world, c.actor, v.slot, v.x, v.y, v.heading)) });
  handlers.on(VehicleRefuelCmd, { validate: (v, c) => validateRefuel(world, c.actor, v.target as Entity, v.slot), handle: (v, c) => run(refuelVehicle(world, c.actor, v.target as Entity, v.slot, v.count)) });
  handlers.on(VehicleRepairCmd, { validate: (v, c) => validateRepair(world, c.actor, v.target as Entity, v.slot), handle: (v, c) => run(repairVehicle(world, c.actor, v.target as Entity, v.slot)) });
}
