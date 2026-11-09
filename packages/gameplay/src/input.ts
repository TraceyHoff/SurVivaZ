/**
 * Input: action bits (core defineActions) and commands (core defineCommand). Net decodes frames, resolves
 * NetId-typed fields (COMMAND_ENTITY_FIELDS) to local Entities, rate-limits, and calls applyGameplayInput in the
 * input phase. Gameplay queues commands per entity and turns ONE per tick into PlayerIntent (so a burst of commands
 * is processed in order over consecutive ticks, identically on server and predicting client).
 */
import { autoSprintReady } from "./systems/auto-sprint.js";
import { ROAD_COMMANDS } from "./roads.js";
import { TERRAIN_COMMANDS } from "./terrain.js";
import { slotItem } from "./inventory.js";
import { gameplayDefs } from "./config.js";
import { SIGN_COMMANDS } from "./signs.js";
import { PET_COMMANDS } from "./pets.js";
import { ANIMAL_SKILL_COMMANDS } from "./animal_skills.js";
import { WORKER_COMMANDS, WORKER_ENTITY_FIELDS } from "./recruitment.js";
import { DYE_COMMANDS } from "./dye.js";
import { INVENTORY_OP_COMMANDS, INVENTORY_OP_RATES } from "./inventory_ops.js";
import { MAP_MARKER_COMMANDS, MAP_MARKER_ENTITY_FIELDS } from "./map_marker_commands.js";
import { READY_COMMANDS } from "./ready.js";
import { PARTY_COMMANDS } from "./party.js";
import { CLAN_COMMANDS, ClanDeclineCmd } from "./clan.js";
import { CommandRegistry, defineActions, defineCommand, defineResource, type Command, type CommandDef, type Entity, type InputFrame, type World } from "@engine/core";
import { Driver, IntentAction, PlayerIntent } from "./components.js";
import { CUSTOMIZATION_COMMANDS } from "./customization.js";
import { PVP_COMMANDS } from "./combat/pvp.js";
import { CancelQueuedCraftCmd, CRAFT_QUEUE_COMMANDS, QueueCraftCmd } from "./systems/craft_queue.js";
import { EXPRESSION_COMMANDS } from "./expression.js";
import { SKILL_COMMANDS } from "./skills/progression.js";
import { VEHICLE_CRAFT_COMMANDS, VEHICLE_CRAFT_ENTITY_FIELDS } from "./vehicle_craft.js";
import { driveFromBits, setDriveInput, VEHICLE_COMMANDS, VEHICLE_STATE_COMMANDS, VEHICLE_ENTITY_FIELDS } from "./vehicles.js";
import { analogMoving, GameplayEdgeBits, GameplayHoldBits, hotbarSlotFromEdges, runInputHooks } from "./input_hooks.js";
import { HOTBAR_OFFSET } from "./components.js";
import { ECONOMY_COMMAND_RATES, ECONOMY_COMMANDS, ECONOMY_ENTITY_FIELDS } from "./economy/stall.js";

export const GameplayActions = defineActions(["MoveUp", "MoveDown", "MoveLeft", "MoveRight", "Sprint", "Primary", "Secondary", "Interact", "Build"] as const);
const MOVE = GameplayActions.MoveUp | GameplayActions.MoveDown | GameplayActions.MoveLeft | GameplayActions.MoveRight;

const T = { target: "u32" } as const;
export const GatherCmd = defineCommand("gameplay.gather", T);
export const CraftCmd = defineCommand("gameplay.craft", { recipe: "u16" });
export const CancelCraftCmd = defineCommand("gameplay.cancelCraft", {});
export const UseCmd = defineCommand("gameplay.use", { slot: "u8" });
export const SelectHotbarCmd = defineCommand("gameplay.selectHotbar", { slot: "u8" });
export const HOTBAR_COMMANDS: readonly [CommandDef, IntentAction][] = [[SelectHotbarCmd, IntentAction.SelectHotbar]];
export const EquipCmd = defineCommand("gameplay.equip", { slot: "u8" });
/** x,y in tiles (piece center / pointer), level = z, rot 0..3 (cell/edge) or 0..freeRotSteps-1 (free). */
export const PlaceCmd = defineCommand("gameplay.place", { piece: "u16", x: "f32", y: "f32", level: "u8", rot: "u8", tier: "u8", variant: "u8" });
export const UpgradeCmd = defineCommand("gameplay.upgrade", { target: "u32", tier: "u8" });
export const RepairCmd = defineCommand("gameplay.repair", T);
export const ReclaimCmd = defineCommand("gameplay.reclaim", { target: "u32" });
export const DemolishCmd = defineCommand("gameplay.demolish", T);
export const PaintCmd = defineCommand("gameplay.paint", { target: "u32", paint: "u8" });
export const ToggleDoorCmd = defineCommand("gameplay.toggleDoor", T);
export const LockDoorCmd = defineCommand("gameplay.lockDoor", T);
export const OpenContainerCmd = defineCommand("gameplay.openContainer", T);
export const CloseContainerCmd = defineCommand("gameplay.closeContainer", {});
export const DepositCmd = defineCommand("gameplay.deposit", { target: "u32", item: "u16", count: "u16" });
export const WithdrawCmd = defineCommand("gameplay.withdraw", { target: "u32", item: "u16", count: "u16" });
export const ToggleFireCmd = defineCommand("gameplay.toggleFire", T);
export const AttackCmd = defineCommand("gameplay.attack", T);
/** Reload the main-hand ranged weapon from inventory ammo (also queued by the Reload edge). */
export const ReloadCmd = defineCommand("gameplay.reload", {});
/** Wear / take off the clothing or armor in an inventory slot (toggle). */
export const WearCmd = defineCommand("gameplay.wear", { slot: "u8" });
/** Boil the filled raw-water container in an inventory slot at a lit campfire (keeps its sips). */
export const BoilCmd = defineCommand("gameplay.boil", { slot: "u8" });
/** Registered after ClanDeclineCmd (append-only ids); queued like GAMEPLAY_COMMANDS. */
export const ARMS_COMMANDS: readonly [CommandDef, IntentAction][] = [[ReloadCmd, IntentAction.Reload], [WearCmd, IntentAction.Wear]];
/** Task 13: disease actions (append-only ids, registered last). */
export const DISEASE_COMMANDS: readonly [CommandDef, IntentAction][] = [[BoilCmd, IntentAction.Boil]];
/** ADR-300: reclaim an abandoned site (append-only, registered last). */
export const RECLAIM_COMMANDS: readonly [CommandDef, IntentAction][] = [[ReclaimCmd, IntentAction.Reclaim]];
/** ADR-318: move a placed piece to a new slot (same snap inputs as PlaceCmd; no cost). Append-only, registered last. */
export const MoveCmd = defineCommand("gameplay.move", { target: "u32", x: "f32", y: "f32", level: "u8", rot: "u8" });
export const MOVE_COMMANDS: readonly [CommandDef, IntentAction][] = [[MoveCmd, IntentAction.Move]];

/** Registration order = command ids (same list on both peers). Append only. */
export const GAMEPLAY_COMMANDS: readonly [CommandDef, IntentAction][] = [
  [GatherCmd, IntentAction.Gather], [CraftCmd, IntentAction.Craft], [CancelCraftCmd, IntentAction.CancelCraft], [UseCmd, IntentAction.Use],
  [EquipCmd, IntentAction.Equip], [PlaceCmd, IntentAction.Place], [UpgradeCmd, IntentAction.Upgrade], [RepairCmd, IntentAction.Repair],
  [DemolishCmd, IntentAction.Demolish], [PaintCmd, IntentAction.Paint], [ToggleDoorCmd, IntentAction.ToggleDoor], [LockDoorCmd, IntentAction.LockDoor],
  [OpenContainerCmd, IntentAction.OpenContainer], [CloseContainerCmd, IntentAction.CloseContainer], [DepositCmd, IntentAction.Deposit],
  [WithdrawCmd, IntentAction.Withdraw], [ToggleFireCmd, IntentAction.ToggleFire], [AttackCmd, IntentAction.Attack],
];
/** Command fields carrying a NetId that net must resolve to a local Entity before applyGameplayInput. */
export const COMMAND_ENTITY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  ...Object.fromEntries(GAMEPLAY_COMMANDS.filter(([d]) => "target" in d.schema).map(([d]) => [d.name, ["target"]])),
  [ReclaimCmd.name]: ["target"],
  [MoveCmd.name]: ["target"],
  ...ECONOMY_ENTITY_FIELDS,
  ...VEHICLE_ENTITY_FIELDS,
  ...VEHICLE_CRAFT_ENTITY_FIELDS,
  ...MAP_MARKER_ENTITY_FIELDS,
  ...WORKER_ENTITY_FIELDS,
};
/** Suggested per-command rate limits (per second) for net's limiter; gameplay still enforces cooldowns. */
export const COMMAND_RATES: Readonly<Record<string, number>> = {
  ...Object.fromEntries([...GAMEPLAY_COMMANDS, ...ARMS_COMMANDS].map(([d]) => [d.name, d === PlaceCmd ? 8 : 20])), ...ECONOMY_COMMAND_RATES, ...INVENTORY_OP_RATES, [SelectHotbarCmd.name]: 20,
  ...Object.fromEntries(MAP_MARKER_COMMANDS.map((d) => [d.name, 10])),
  ...Object.fromEntries(DISEASE_COMMANDS.map(([d]) => [d.name, 10])),
  ...Object.fromEntries(WORKER_COMMANDS.map((d) => [d.name, 10])),
  ...Object.fromEntries(DYE_COMMANDS.map((d) => [d.name, 10])),
  [ReclaimCmd.name]: 20,
  [MoveCmd.name]: 8,
};

export function registerGameplayCommands(reg: CommandRegistry = new CommandRegistry()): CommandRegistry {
  for (const [d] of GAMEPLAY_COMMANDS) reg.register(d);
  for (const d of ECONOMY_COMMANDS) reg.register(d); // append-only: ids after GAMEPLAY_COMMANDS
  for (const d of CUSTOMIZATION_COMMANDS) reg.register(d);
  for (const d of PVP_COMMANDS) reg.register(d);
  for (const d of CRAFT_QUEUE_COMMANDS) reg.register(d);
  for (const d of EXPRESSION_COMMANDS) reg.register(d);
  for (const d of PARTY_COMMANDS) reg.register(d);
  for (const d of CLAN_COMMANDS) reg.register(d); // append-only, after party
  reg.register(ClanDeclineCmd);
  for (const d of VEHICLE_COMMANDS) reg.register(d); // append-only, after ClanDecline (ADR-096)
  for (const [d] of ARMS_COMMANDS) reg.register(d); // append-only, after vehicles
  for (const d of VEHICLE_CRAFT_COMMANDS) reg.register(d); // append-only: deploy / refuel / repair (DESIGN.md §31)
  for (const d of VEHICLE_STATE_COMMANDS) reg.register(d); // append-only: engine / headlights (ADR-101)
  for (const d of SKILL_COMMANDS) reg.register(d); // append-only: unlock / respec (ADR-113)
  for (const d of ROAD_COMMANDS) reg.register(d); // append-only: roads (ADR-119)
  for (const d of SIGN_COMMANDS) reg.register(d); // append-only: signs (ADR-120)
  for (const d of PET_COMMANDS) reg.register(d); // append-only: pets (ADR-145)
  for (const d of INVENTORY_OP_COMMANDS) reg.register(d); // append-only: split / move slot (ADR-204)
  for (const d of MAP_MARKER_COMMANDS) reg.register(d); // append-only: world-map markers
  for (const [d] of DISEASE_COMMANDS) reg.register(d); // append-only (Task 13): boil water at a lit campfire
  for (const d of READY_COMMANDS) reg.register(d); // append-only (Task 14): client loaded-in signal
  for (const d of ANIMAL_SKILL_COMMANDS) reg.register(d); // append-only (Task 15): animal skill purchase
  for (const d of WORKER_COMMANDS) reg.register(d); // append-only (Task 22): AI-human hire / job / dismiss
  for (const d of DYE_COMMANDS) reg.register(d); // append-only (Task 25): dye hair / worn / held (brush + dye)
  for (const d of TERRAIN_COMMANDS) reg.register(d); // append-only (ADR-263 / Task 36): shovel raise / lower
  for (const [d] of HOTBAR_COMMANDS) reg.register(d); // ADR-289: append-only, idempotent HUD selection
  for (const [d] of RECLAIM_COMMANDS) reg.register(d); // ADR-300: append-only reclaim
  for (const [d] of MOVE_COMMANDS) reg.register(d); // ADR-318: append-only move
  return reg;
}

interface Pending { readonly action: IntentAction; readonly values: Record<string, number> }
export const CommandQueues = defineResource<Map<Entity, Pending[]>>("gameplay.CommandQueues");
const MAX_QUEUE = 16;

/**
 * ADR-180: the sim commands an InputFrame's edge pulses stand for (Hotbar1..8 -> EquipCmd(slot), Reload -> ReloadCmd).
 * Shared by applyGameplayInput and the authoritative server's applyInput so edges mean the same everywhere. Other edges
 * (Jump, HotbarNext/Prev, QuickUse, Toggle*, OpenChat, OpenSocial, Cancel) are client-UI or have no sim effect yet.
 */
/** ADR-223: a hotbar key on food / drink (not a tool or weapon) eats / drinks it instead of holding it. */
export function hotbarConsumes(world: World, e: Entity, slot: number): boolean {
  try { const { item, count } = slotItem(world, e, slot); if (!item || !count) return false; const d = gameplayDefs(world).items.get(item);
    return !!d?.food && !d.weapon && !d.tool && !d.ranged && !d.thrown; } catch { return false; }
}
export const SIM_EDGE_ACTIONS = ["Reload", "Hotbar1", "Hotbar2", "Hotbar3", "Hotbar4", "Hotbar5", "Hotbar6", "Hotbar7", "Hotbar8"] as const;
export function edgeCommands(edges: number, world?: World, e?: Entity): { def: CommandDef; values: Record<string, number> }[] {
  const out: { def: CommandDef; values: Record<string, number> }[] = [];
  const bar = hotbarSlotFromEdges(edges); const slot = bar >= 0 ? HOTBAR_OFFSET + bar : -1; if (slot >= 0) out.push({ def: (world && e !== undefined && hotbarConsumes(world, e, slot) ? UseCmd : EquipCmd) as CommandDef, values: { slot } });
  if (edges & GameplayEdgeBits.Reload) out.push({ def: ReloadCmd as CommandDef, values: {} });
  return out;
}
/** Input phase: actions -> moving/sprint, commands -> queue (one becomes the tick's intent). */
export function applyGameplayInput(world: World, e: Entity, frame: InputFrame | null, reg: CommandRegistry): void {
  if (!world.has(e, PlayerIntent)) return;
  const actions = frame?.actions ?? 0;
  if (world.has(e, Driver)) { // riders steer their vehicle with the same move axes; Sprint = boost (ADR-096)
    autoSprintReady(world, e, 0, 0, 0);
    const b = driveFromBits(actions); const analog = analogMoving(frame);
    setDriveInput(world, e, analog ? frame!.moveX! : b.x, analog ? frame!.moveY! : b.y, (actions & GameplayActions.Sprint) !== 0);
    world.set(e, PlayerIntent, { moving: 0, sprint: 0, charge: 0 });
  } else world.set(e, PlayerIntent, { moving: actions & MOVE || analogMoving(frame) ? 1 : 0, sprint: 0, charge: actions & GameplayHoldBits.Charge ? 1 : 0 });
  for (const c of frame?.commands ?? []) queueCommand(world, e, reg, c);
  if (!frame) return;
  for (const c of edgeCommands(frame.edges ?? 0, world, e)) { try { queueCommand(world, e, reg, reg.make(c.def, c.values)); } catch { /* not in this registry */ } }
  runInputHooks(world, e, frame, reg);
}
export function queueCommand(world: World, e: Entity, reg: CommandRegistry, c: Command): boolean {
  const def = reg.def(c.type); const entry = def && (GAMEPLAY_COMMANDS.find(([d]) => d.name === def.name) ?? ARMS_COMMANDS.find(([d]) => d.name === def.name) ?? DISEASE_COMMANDS.find(([d]) => d.name === def.name) ?? HOTBAR_COMMANDS.find(([d]) => d.name === def.name) ?? RECLAIM_COMMANDS.find(([d]) => d.name === def.name) ?? MOVE_COMMANDS.find(([d]) => d.name === def.name));
  if (!entry) return false;
  let qs = world.getResource(CommandQueues); if (!qs) world.setResource(CommandQueues, (qs = new Map()));
  let q = qs.get(e); if (!q) qs.set(e, (q = []));
  if (q.length >= MAX_QUEUE) return false;
  q.push({ action: entry[1], values: c.values as Record<string, number> });
  return true;
}
/** Input-phase system: pops one queued command per entity into PlayerIntent. */
export function commandIntentSystem(world: World): void {
  const qs = world.getResource(CommandQueues); if (!qs) return;
  for (const [e, q] of qs) {
    if (!world.isAlive(e) || !world.has(e, PlayerIntent)) { qs.delete(e); continue; }
    const p = q.shift(); if (!p) continue;
    world.set(e, PlayerIntent, { ...p.values, action: p.action, ...(p.values.level !== undefined && { level: p.values.level }) });
    if (q.length === 0) qs.delete(e);
  }
}
