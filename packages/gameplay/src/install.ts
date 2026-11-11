import { wearSystem } from "./combat/arms.js";
import { installVehicleCraft, VEHICLE_CRAFT_HASH } from "./vehicle_craft.js";
import { CROP_EVERY, cropGrowthSystem, farmUseSystem } from "./farming.js";
import { TERRAIN, terrainFlowSystem } from "./terrain.js";
import { HUSBANDRY_EVERY, husbandrySystem, husbandryUseSystem } from "./skills/husbandry.js";
import { installProgression, progressionMigrateSystem, xpTravelSystem } from "./skills/progression.js";
import { installPets, petSystem } from "./pets.js";
import { DEFAULT_TICK_HZ, pruneModifiers, Season, setTimeOfDay, wallHoursForSun, worldSunSchedule, StallDisplay, TimeOfDay, Weather, type World } from "@engine/core";
import { installSpatialIndex, setClimateModel, ClimateRes } from "@engine/world";
import { HOTBAR_OFFSET, Buffs, Equipment, GAMEPLAY_COMPONENTS, IntentAction, Inventory, NO_SLOT, PlayerIntent } from "./components.js";
import { GameplayConfig, type GameplayRole } from "./config.js";
import { defaultDefs } from "./data.js";
import { WeatherKind, type GameDefs } from "./defs.js";
import { commandIntentSystem, queueCommand, ToggleDoorCmd } from "./input.js";
import { setHotbarSelection, slotItem } from "./inventory.js";
import { applyReplication, type NetReplicationHooks } from "./replication.js";
import { chunkSurfaceSystem, clockSystem, exposureSystem, EXPOSURE_EVERY, gameplayClimateModel, SURFACE_EVERY, weatherSystem } from "./systems/environment.js";
import { craftingSystem } from "./systems/crafting.js";
import { fuelSystem } from "./systems/fuel.js";
import { gatherSystem, respawnSystem } from "./systems/gathering.js";
import { noiseDecaySystem } from "./systems/noise.js";
import { spoilageSystem, SPOILAGE_EVERY } from "./systems/spoilage.js";
import { consumeSystem, deathSystem, vitalsSystem } from "./systems/vitals.js";
import { diseaseSystem } from "./systems/diseases.js";
import { installDiseases } from "./diseases.js";
import { recruitmentSystem } from "./recruitment.js";
import { animSettleSystem } from "./systems/movement.js";
import { installShaftHatchInput } from "./building/terrain-hatch.js";
import { installAbandonedStructures } from "./building/abandoned.js";
import { stanceSystem } from "./stance.js";
import { installMounts, mountGateSystem, mountSystem } from "./mounts.js";
import { ropeSystem } from "./rope.js";
import { DUNG_EVERY, dungSystem } from "./dung.js";
import { installBuildingSystems, BUILDING_SYSTEMS } from "./building/install.js";
import { installCombatSystems, COMBAT_SYSTEMS } from "./combat/install.js";
import { entityIndex } from "@engine/core";
import { installGameplayContainers } from "./economy/provenance.js";
import { VEHICLE_DEFS_HASH, vehicleSystem } from "./vehicles.js";
import { vehicleGuardSystem } from "./vehicle_net.js";
import { expressionSystem, EXPRESSION_EVERY } from "./expression.js";
import { stallDisplaySystem, STALL_DISPLAY_EVERY } from "./systems/stall_display.js";
import { storeFillSystem, STORE_FILL_EVERY } from "./systems/store_fill.js";
import { hordeDirectorSystem, HORDES_EVERY, setWorldRules, type WorldRulesOpts } from "./hordes.js";

export * from "./spawn.js";

export interface GameplayOptions {
  defs?: GameDefs;
  role?: GameplayRole;
  /** Overrides environment.json dayLengthSeconds. */
  dayLengthTicks?: number;
  tickHz?: number;
  /** Server role: the NetServer (structurally) - BuildPiece is registered as static class and scopes applied. Call before clients join. */
  net?: NetReplicationHooks;
  /** ADR-121 world rules (hordes on/off, grace days); defaults from roads.json hordes. */
  worldRules?: WorldRulesOpts;
}

type Phase = "input" | "simulation" | "postSim";
/** System order (gameplay systems only; third element = every N ticks). Tests assert world.systemOrder() matches. */
export const GAMEPLAY_SYSTEM_ORDER: readonly (readonly [Phase, string, number?])[] = [
  ["input", "gameplay.commands"],
  ["simulation", "gameplay.clock"],
  ["simulation", "gameplay.weather"],
  ["simulation", "gameplay.vehicles"],
  ["simulation", "gameplay.mountGate"], // ADR-319: riders cannot build / attack / use doors (before the action systems)
  ...BUILDING_SYSTEMS.pre,
  ["simulation", "gameplay.equip"], // ADR-135 EquipCmd handler
  ["simulation", "gameplay.wear"],
  ["simulation", "gameplay.exposure", EXPOSURE_EVERY],
  ["simulation", "gameplay.fuel"],
  ["simulation", "gameplay.respawn"],
  ["simulation", "gameplay.gather"],
  ...BUILDING_SYSTEMS.actions,
  ["simulation", "gameplay.craft"],
  ...COMBAT_SYSTEMS.sim,
  ...BUILDING_SYSTEMS.post,
  ["simulation", "gameplay.consume"],
  ["simulation", "gameplay.farmUse"], // ADR-110
  ["simulation", "gameplay.crops", CROP_EVERY], // ADR-110
  ["simulation", "gameplay.terrainFlow", TERRAIN.flowEveryTicks], // ADR-263: water flows into shovel-dug channels (authority)
  ["simulation", "gameplay.husbandryUse"], // ADR-113
  ["simulation", "gameplay.husbandry", HUSBANDRY_EVERY], // ADR-113
  ["simulation", "gameplay.pets"], // ADR-145 (after animal AI)
  ["simulation", "gameplay.mounts"], // ADR-319 / ADR-320: mount follow, regen, saddlebag, death drops
  ["simulation", "gameplay.rope"], // ADR-351: rope lead follow / balk / break / arrival (after animal AI)
  ["simulation", "gameplay.dung", DUNG_EVERY], // ADR-352: animal dung production (after animal AI; 1 s check)
  ["simulation", "gameplay.hordes", HORDES_EVERY], // ADR-121 server director (no-op on clients / when disabled)
  ["simulation", "gameplay.stance"], // ADR-244 carry follow / block break / sleep heal / night skip (authority)
  ["simulation", "gameplay.vitals"],
  ["simulation", "gameplay.diseases"], // Task 13: symptom drains + exposure + transmission (after vitals, before death)
  ["simulation", "gameplay.recruitment", 20], // Task 22: backfill Worker records onto AI humans (authority-only)
  ["simulation", "gameplay.death"],
  ["simulation", "gameplay.deathBags"],
  ["simulation", "gameplay.spoilage", SPOILAGE_EVERY],
  ["simulation", "gameplay.chunkSurface", SURFACE_EVERY],
  ["simulation", "gameplay.clearIntents"],
  ["postSim", "gameplay.equipmentSync"],
  ["postSim", "gameplay.xpTravel", 20],
  ["postSim", "gameplay.progressionMigrate"], // ADR-209 legacy / fresh Progression -> per-tree
  ...BUILDING_SYSTEMS.postSim,
  ...COMBAT_SYSTEMS.postSim,
  ["postSim", "gameplay.noiseDecay"],
  ["postSim", "gameplay.pruneBuffs", 20],
  ["postSim", "gameplay.stallDisplay", STALL_DISPLAY_EVERY],
  ["postSim", "gameplay.storeFill", STORE_FILL_EVERY], // ADR-356: mirror store Container fill into StoreFill
  ["postSim", "gameplay.expression", EXPRESSION_EVERY],
  ["postSim", "gameplay.animSettle"], // ADR-107: swim + player one-shot anims
  ["postSim", "gameplay.vehicleGuard"], // server-only, no-op until installVehicleGuard (vehicle_net.ts)
];

/** Registers gameplay components (the shared registration module: fixed order on every peer), resources and systems. */
export function installGameplay(world: World, options: GameplayOptions | number = {}): void {
  const opts: GameplayOptions = typeof options === "number" ? { dayLengthTicks: options } : options;
  const defs = opts.defs ?? defaultDefs();
  const env = defs.environment;
  for (const c of GAMEPLAY_COMPONENTS) world.register(c);
  if (!world.isRegistered(StallDisplay)) world.register(StallDisplay); // core broadcast mirror, fed by gameplay.stallDisplay
  world.addSchemaSalt("gameplay.defs", defs.hashes.all);
  world.addSchemaSalt("gameplay.vehicles", VEHICLE_DEFS_HASH);
  world.addSchemaSalt("gameplay.vehicleCraft", VEHICLE_CRAFT_HASH);
  const role = opts.role ?? "standalone";
  world.setResource(GameplayConfig, { defs, role });
  const dayLengthTicks = opts.dayLengthTicks ?? Math.round(env.dayLengthSeconds * (opts.tickHz ?? DEFAULT_TICK_HZ));
  // Environment singleton is created by core; initialise TimeOfDay once (dayLengthTicks 0 = uninitialised).
  const freshClock = world.env(TimeOfDay).dayLengthTicks === 0;
  if (freshClock) { world.env(TimeOfDay).dayLengthTicks = dayLengthTicks; setTimeOfDay(world, env.startTimeOfDay * 24, 0); }
  world.set(world.environment, Weather, { kind: WeatherKind.Clear });
  // ADR-239: seasons ride on the day clock; offsetDays starts the cycle at startSeason (server meta restores it).
  if (!world.isRegistered(Season)) world.register(Season);
  if (!world.has(world.environment, Season)) { const st = env.seasons; world.add(world.environment, Season, st ? { lengthDays: st.lengthDays, blendDays: st.blendDays, offsetDays: st.startSeason * st.lengthDays } : { lengthDays: 0 }); }
  // ADR-283: startTimeOfDay is a sun fraction (0.3 = just after dawn), so a new world starts just after *that day's* sunrise.
  if (freshClock) setTimeOfDay(world, newWorldStartHours(world, env.startTimeOfDay), 0);
  if (role !== "client") setWorldRules(world, opts.worldRules ?? {});
  installSpatialIndex(world);
  installGameplayContainers(world);
  installVehicleCraft(world);
  if (world.getResource(ClimateRes)) setClimateModel(world, gameplayClimateModel(env, world));
  if (opts.net && role === "server") applyReplication(opts.net);

  const sys: Record<string, (w: World, dt: number) => void> = {
    "gameplay.commands": commandIntentSystem, "gameplay.clock": clockSystem, "gameplay.weather": weatherSystem,
    "gameplay.wear": wearSystem, "gameplay.exposure": exposureSystem, "gameplay.fuel": fuelSystem, "gameplay.respawn": respawnSystem, "gameplay.gather": gatherSystem,
    "gameplay.craft": craftingSystem, "gameplay.consume": consumeSystem, "gameplay.vitals": vitalsSystem, "gameplay.death": deathSystem, "gameplay.diseases": diseaseSystem,
    "gameplay.spoilage": spoilageSystem, "gameplay.chunkSurface": chunkSurfaceSystem,
    "gameplay.recruitment": recruitmentSystem,
    "gameplay.clearIntents": clearIntentsSystem, "gameplay.equipmentSync": equipmentSyncSystem, "gameplay.noiseDecay": noiseDecaySystem,
    "gameplay.pruneBuffs": (w) => pruneModifiers(w, Buffs), "gameplay.stallDisplay": stallDisplaySystem, "gameplay.storeFill": storeFillSystem, "gameplay.expression": expressionSystem, "gameplay.vehicles": vehicleSystem, "gameplay.mountGate": mountGateSystem, "gameplay.mounts": mountSystem, "gameplay.vehicleGuard": vehicleGuardSystem, "gameplay.animSettle": animSettleSystem, "gameplay.farmUse": farmUseSystem, "gameplay.crops": cropGrowthSystem, "gameplay.terrainFlow": terrainFlowSystem, "gameplay.husbandryUse": husbandryUseSystem, "gameplay.husbandry": husbandrySystem,
    "gameplay.hordes": hordeDirectorSystem, "gameplay.xpTravel": xpTravelSystem, "gameplay.progressionMigrate": progressionMigrateSystem, "gameplay.equip": equipSystem, "gameplay.stance": stanceSystem, "gameplay.pets": petSystem, "gameplay.rope": ropeSystem, "gameplay.dung": dungSystem,
    ...installBuildingSystems(world), ...installCombatSystems(world),
  };
  installProgression(world);
  installPets(world); // ADR-145
  installMounts(world); // ADR-320 saddle wear
  installDiseases(world); // Task 13: wound-infection Damaged subscription (once per world)
  for (const [phase, name, every] of GAMEPLAY_SYSTEM_ORDER) {
    const fn = sys[name]; if (!fn) throw new Error(`no system ${name}`);
    world.addSystem(phase, name, fn, every ? { every } : {});
  }
  installShaftHatchInput(world, queueCommand, ToggleDoorCmd);
  installAbandonedStructures(world);
}

/** One-shot actions are consumed at the end of the simulation phase (so simulate() replays are correct). */
export function clearIntentsSystem(world: World): void {
  const st = world.store(PlayerIntent);
  for (let k = 0; k < st.size; k++) {
    if (st.data.action[k] !== IntentAction.None) { st.data.action[k] = IntentAction.None; st.markChanged(entityIndex(st.dense[k]!)); }
  }
}

/** ADR-135: IntentAction.Equip(slot) puts an inventory slot in the main hand; the same slot again (or an empty slot) unequips. */
export function equipSystem(world: World): void {
  const st = world.store(PlayerIntent);
  for (let k = 0; k < st.size; k++) {
    const select = st.data.action[k] === IntentAction.SelectHotbar;
    if (st.data.action[k] !== IntentAction.Equip && !select) continue;
    const e = st.dense[k]!; if (!world.has(e, Equipment) || !world.has(e, Inventory)) continue;
    const slot = st.data.slot[k]!; const cur = world.getField(e, Equipment, "mainHandSlot");
    const it = slotItem(world, e, slot);
    if (select && (slot < HOTBAR_OFFSET || slot >= HOTBAR_OFFSET + 8)) continue;
    setHotbarSelection(world, e, slot);
    const next = (!select && cur === slot) || !it || it.count === 0 ? NO_SLOT : slot;
    world.set(e, Equipment, { mainHandSlot: next, mainHandItem: next === NO_SLOT ? 0 : it.item });
  }
}

/** Derives Equipment.mainHandItem (networked to all) from the owner-only inventory. */
export function equipmentSyncSystem(world: World): void {
  for (const e of world.query([Equipment, Inventory])) {
    const slot = world.getField(e, Equipment, "mainHandSlot")!;
    const item = slot === NO_SLOT ? 0 : slotItem(world, e, slot).item;
    if (world.getField(e, Equipment, "mainHandItem") !== item) world.setField(e, Equipment, "mainHandItem", item);
  }
}

// ---- spawn helpers (server spawns; NetId assignment is @engine/net's job) ----------------------


/** ADR-283: wall-clock hours on day 0 for a sun fraction (startTimeOfDay): follows day 0's seasonal sunrise. */
export function newWorldStartHours(world: World, sunFraction: number): number {
  let h = sunFraction * 24; for (let i = 0; i < 2; i++) h = wallHoursForSun(sunFraction * 24, worldSunSchedule(world, h / 24)); return h;
}
