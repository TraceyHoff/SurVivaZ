import { MOUNT_COMMANDS, MOUNT_ENTITY_FIELDS, MOUNT_REJECT_REASONS } from "@engine/gameplay";
import { ROPE_COMMANDS, ROPE_ENTITY_FIELDS, ROPE_REJECT_REASONS } from "@engine/gameplay";
import { INVENTORY_OP_COMMANDS, INVENTORY_OP_RATES, INVENTORY_OP_REJECT_REASONS, GatherCmd, ToggleFireCmd, UpgradeCmd, RepairCmd, ReclaimCmd, MoveCmd, DemolishCmd, ToggleDoorCmd, LockDoorCmd, OpenContainerCmd, CloseContainerCmd, DepositCmd, WithdrawCmd, PET_COMMANDS, PET_ENTITY_FIELDS, PET_REJECT_REASONS, ROAD_COMMANDS, SIGN_COMMANDS, SIGN_ENTITY_FIELDS, MAP_MARKER_COMMANDS, MAP_MARKER_ENTITY_FIELDS, MAP_MARKER_REJECT_REASONS, DISEASE_COMMANDS, READY_COMMANDS, ANIMAL_SKILL_COMMANDS, ANIMAL_SKILL_ENTITY_FIELDS, ANIMAL_SKILL_REJECT_REASONS, WORKER_COMMANDS, WORKER_ENTITY_FIELDS, WORKER_REJECT_REASONS, DYE_COMMANDS, DYE_REJECT_REASONS, TERRAIN_COMMANDS } from "@engine/gameplay";
/**
 * Browser-safe demo protocol shared by apps/server, the headless bots and apps/client ("@engine/server/protocol").
 * Input bits + movement (identical on server and in client prediction), and the ordered command/event lists.
 */
import { Appearance, DEFAULT_TICK_HZ, defineActions, installPermissions, type ClaimRegistry, type Entity, type GroupRegistry, type PermissionsRes, type World } from "@engine/core";
import { defineCommand, defineNetEvent, type CommandRejection, type InputCmd, type NetClient, type NetClientOptions } from "@engine/net";
import { COMMAND_RATES, PVP_COMMANDS, CRAFT_QUEUE_COMMANDS, CUSTOMIZATION_COMMANDS, ECONOMY_COMMAND_RATES, ECONOMY_COMMANDS, ECONOMY_ENTITY_FIELDS, installGameplay, SelectHotbarCmd, UseCmd, PlaceCmd, EmoteCmd, PARTY_COMMANDS, PARTY_ENTITY_FIELDS, PARTY_REJECT_REASONS, CLAN_COMMANDS, CLAN_ENTITY_FIELDS, CLAN_REJECT_REASONS, ClanDeclineCmd, PaintCmd, ReloadCmd, WearCmd, EquipCmd, VEHICLE_COMMANDS, VEHICLE_CRAFT_COMMANDS, VEHICLE_STATE_COMMANDS, VEHICLE_CRAFT_ENTITY_FIELDS, VEHICLE_COMMAND_RATES, VEHICLE_ENTITY_FIELDS, VEHICLE_REJECT_REASONS, Driver, driveFromBits, setDriveInput, controlledVehicles, poseTrailersInHitchFrame, SKILL_COMMANDS, applyMovementInput } from "@engine/gameplay";
import { defineCommand as defineCoreCommand, type CommandDef } from "@engine/core";
import { SESSION_COMMANDS, SESSION_EVENTS } from "@engine/persist";

/** Bits 0..5 as before; ADR-244 appends Guard (Secondary hold: block / aim) and Crouch (rising edge toggles) at 6, 7. */
export const Act = defineActions(["MoveUp", "MoveDown", "MoveLeft", "MoveRight", "Sprint", "Gather", "Guard", "Crouch", "Attack"]);

/** App-level ping (Netcode has no RTT measurement yet). Server answers on its next tick, so RTT includes 0..1 tick. */
export const Ping = defineCommand("demo.ping", { t: "u32" }, { rate: { perSec: 4, burst: 4 } });
export const Pong = defineNetEvent("demo.pong", { t: "u32" });

/** Same order on both peers (checked by the "netdefs" handshake hash). */
/**
 * Gameplay commands on the wire: net mirrors of gameplay's core CommandDefs (same name + schema; `stall` is a NetId
 * resolved to an Entity). The server bridges each into core CommandHandlers (see game.ts). Append-only order.
 */
/**
 * Chat-style limit (core ChannelRegistry default: 5 burst, 0.05/tick = 1/s at 20 Hz) for social commands: emotes and
 * gameplay's party (and later clan) commands. Their entity fields (PARTY_ENTITY_FIELDS) still go out as NetIds.
 */
export const CHAT_STYLE_RATE = { perSec: 1, burst: 5 } as const;
export const SOCIAL_COMMAND_NAMES: ReadonlySet<string> = new Set(["gameplay.emote", "gameplay.partyInvite", "gameplay.partyAccept", "gameplay.partyDecline", "gameplay.partyLeave", "gameplay.partyKick", ...CLAN_COMMANDS.map((d) => d.name), ClanDeclineCmd.name]);
/** NetId entity fields of bridged input-queue commands (validated under the server's entityRefs, default "aoi"). */
export const INPUT_ENTITY_FIELDS: Readonly<Record<string, readonly string[]>> = { [PaintCmd.name]: ["target"], ...VEHICLE_ENTITY_FIELDS, ...VEHICLE_CRAFT_ENTITY_FIELDS, ...SIGN_ENTITY_FIELDS, ...PET_ENTITY_FIELDS, ...MAP_MARKER_ENTITY_FIELDS, ...ANIMAL_SKILL_ENTITY_FIELDS, ...WORKER_ENTITY_FIELDS, ...MOUNT_ENTITY_FIELDS, ...ROPE_ENTITY_FIELDS,
  /* ADR-146: container panel commands */ [OpenContainerCmd.name]: ["target"], [DepositCmd.name]: ["target"], [WithdrawCmd.name]: ["target"],
  /* ADR-163 */ [UpgradeCmd.name]: ["target"], [RepairCmd.name]: ["target"], [ReclaimCmd.name]: ["target"], [MoveCmd.name]: ["target"], [DemolishCmd.name]: ["target"], [ToggleDoorCmd.name]: ["target"], [LockDoorCmd.name]: ["target"],
  /* ADR-165 */ [GatherCmd.name]: ["target"], [ToggleFireCmd.name]: ["target"] };
/** Vehicle wire rates (ADR-102): seat/hitch/station 4/s burst 8; deploy/refuel/repair 2/s burst 4. Dispatch: handlers.enqueue only (not INPUT_QUEUE). */
export const VEHICLE_NET_RATES: Readonly<Record<string, { perSec: number; burst: number }>> = Object.fromEntries([
  ...VEHICLE_COMMANDS.map((d) => [d.name, { perSec: 4, burst: 8 }] as const),
  ...VEHICLE_CRAFT_COMMANDS.map((d) => [d.name, { perSec: 2, burst: 4 }] as const),
  ...VEHICLE_STATE_COMMANDS.map((d) => [d.name, { perSec: 4, burst: 8 }] as const), // ADR-170
]);
/**
 * Delete my progress (ADR-099): the caller's own character/inventory/look/player row, party+clan membership and personal
 * stall/building ownership. Takes no target — it can only ever act on the sender's account. `confirm` must equal
 * DELETE_PROGRESS_CONFIRM (guards against stray/replayed packets); one per 30 s per connection.
 */
export const DELETE_PROGRESS_CONFIRM = 0xde1e7e;
export const DeleteMyProgressCmd = defineCoreCommand("account.deleteMyProgress", { confirm: "u32" });
export const DELETE_PROGRESS_RATE = { perSec: 1 / 30, burst: 1 } as const;
/** Fixed net rates overriding the COMMAND_RATES-derived default (arms input-queue commands). */
export const NET_RATE_OVERRIDES: Readonly<Record<string, { perSec: number; burst: number }>> = { [ReloadCmd.name]: { perSec: 5, burst: 10 }, [WearCmd.name]: { ...CHAT_STYLE_RATE }, [EquipCmd.name]: { ...CHAT_STYLE_RATE }, ...VEHICLE_NET_RATES };
const mirror = (d: CommandDef) => {
  if (d === DeleteMyProgressCmd) return defineCommand(d.name, d.schema, { rate: { ...DELETE_PROGRESS_RATE } });
  const fixed = NET_RATE_OVERRIDES[d.name];
  if (fixed) return defineCommand(d.name, d.schema, { entityFields: [...(INPUT_ENTITY_FIELDS[d.name] ?? [])], rate: { ...fixed } });
  if (SOCIAL_COMMAND_NAMES.has(d.name)) return defineCommand(d.name, d.schema, { entityFields: [...(ECONOMY_ENTITY_FIELDS[d.name] ?? PARTY_ENTITY_FIELDS[d.name] ?? CLAN_ENTITY_FIELDS[d.name] ?? [])], rate: { ...CHAT_STYLE_RATE } });
  const perSec = ECONOMY_COMMAND_RATES[d.name] ?? INVENTORY_OP_RATES[d.name] ?? VEHICLE_COMMAND_RATES[d.name] ?? COMMAND_RATES[d.name] ?? 2;
  return defineCommand(d.name, d.schema, { entityFields: [...(ECONOMY_ENTITY_FIELDS[d.name] ?? PARTY_ENTITY_FIELDS[d.name] ?? CLAN_ENTITY_FIELDS[d.name] ?? INPUT_ENTITY_FIELDS[d.name] ?? VEHICLE_ENTITY_FIELDS[d.name] ?? [])], rate: { perSec, burst: Math.max(2, Math.ceil(perSec * 2)) } });
};
export const GAMEPLAY_NET_COMMANDS = [...ECONOMY_COMMANDS, ...CUSTOMIZATION_COMMANDS, ...PVP_COMMANDS, ...CRAFT_QUEUE_COMMANDS, /* appended */ UseCmd, PlaceCmd, EmoteCmd, ...PARTY_COMMANDS, ...CLAN_COMMANDS, PaintCmd, ClanDeclineCmd, ReloadCmd, WearCmd, ...VEHICLE_COMMANDS, ...VEHICLE_CRAFT_COMMANDS, DeleteMyProgressCmd, ...SKILL_COMMANDS, ...ROAD_COMMANDS, ...SIGN_COMMANDS, /* QA2: inventory main-hand equip (was hotbar-only; menu taps threw) */ EquipCmd, /* ADR-145 */ ...PET_COMMANDS, /* ADR-146: panel container open/close/deposit/withdraw (input-queue; were frame-only, so panel taps silently failed) */ OpenContainerCmd, CloseContainerCmd, DepositCmd, WithdrawCmd, /* ADR-163: build-mode piece actions (were frame-only, so Repair / Upgrade / Demolish and door taps failed to send) */ UpgradeCmd, RepairCmd, DemolishCmd, ToggleDoorCmd, LockDoorCmd, /* ADR-165: touch Harvest prompt + campfire Light/Put out (were frame-only; taps silently failed) */ GatherCmd, ToggleFireCmd, /* ADR-170: vehicle engine / headlights (registered, never bridged) */ ...VEHICLE_STATE_COMMANDS, /* ADR-204: split stack / move slot (hotbar) */ ...INVENTORY_OP_COMMANDS, /* Task 9: world-map markers (were UI-sent but never bridged, so marker taps failed to send) */ ...MAP_MARKER_COMMANDS, /* Task 13: boil water at a lit campfire */ ...DISEASE_COMMANDS.map(([d]) => d), /* Task 14: client loaded-in signal */ ...READY_COMMANDS, /* Task 15: animal skill purchase */ ...ANIMAL_SKILL_COMMANDS, /* Task 22: AI-human hire / job / dismiss */ ...WORKER_COMMANDS, /* Task 25: dye hair / worn / held */ ...DYE_COMMANDS, /* ADR-263 Task 36: shovel raise / lower */ ...TERRAIN_COMMANDS, /* ADR-289 */ SelectHotbarCmd, /* ADR-300 */ ReclaimCmd, /* ADR-318 */ MoveCmd, /* ADR-319 / ADR-320 */ ...MOUNT_COMMANDS, /* ADR-351 */ ...ROPE_COMMANDS].map((d) => ({ core: d as CommandDef, net: mirror(d) }));
/** Net command for a gameplay core CommandDef (clients: `client.sendCommand(gameplayNet(BuyFromStallCmd), {...})`). */
export function gameplayNet<D extends CommandDef>(d: D): ReturnType<typeof defineCommand<D["schema"]>> {
  const m = GAMEPLAY_NET_COMMANDS.find((x) => x.core === d); if (!m) throw new Error(`not a bridged gameplay command: ${d.name}`);
  return m.net as unknown as ReturnType<typeof defineCommand<D["schema"]>>;
}
/**
 * Dev load-test bots (src/bots.ts) tag their connection with this before ClaimAccount. A multiplayer server drops tagged
 * connections unless started with the dev flag (NET_DEV_BOTS=1 / devBots). Human bots are a singleplayer/offline thing.
 */
export const DevBotHello = defineCommand("demo.devBot", { v: "u8" }, { rate: { perSec: 1, burst: 1 } });
/** ADR-145 QA: sandbox-only pet kit (dog treats + a dachshund next to the sender); ignored unless the server runs DEV_SANDBOX. */
export const DevPetKit = defineCommand("demo.devPetKit", { v: "u8" }, { rate: { perSec: 1, burst: 2 } });
export const DEMO_COMMANDS = [...SESSION_COMMANDS, Ping, ...GAMEPLAY_NET_COMMANDS.map((x) => x.net), DevBotHello, DevPetKit] as const;
/**
 * Owner-scoped social replication (apps/server/src/social_sync.ts). Ids are account PlayerIds; names via client.names.
 * ClanRoster: your clan (0 = none: clear the roster), rank masks (member / officer; leader = all), member count. Sent on
 *   joining a clan, on claim, and when masks change; a new clan id means "replace the roster".
 * ClanRosterMember: one member row (role = GroupRole; 0 = removed; online 0/1). Deltas only.
 * OnlinePlayer: online directory row (online 0 = went offline). Full list on claim, then deltas.
 */
export const ClanRoster = defineNetEvent("gameplay.clanRoster", { clan: "u32", memberMask: "u32", officerMask: "u32", size: "u8" });
export const ClanRosterMember = defineNetEvent("gameplay.clanRosterMember", { clan: "u32", player: "u32", role: "u8", online: "u8" });
export const OnlinePlayer = defineNetEvent("gameplay.onlinePlayer", { player: "u32", online: "u8" });
/**
 * Arms events (gameplay.Exploded / gameplay.Reloaded mirrors; reliability from ARMS_EVENT_RELIABILITY).
 * Exploded: to clients whose view/AOI covers any part of the blast circle (x, y, radius in tiles). entity = the explosive
 *   (often already gone: 0), owner = thrower/placer (0 if unknown), item = item id.
 * Reloaded: owner only. entity = the reloading player, item = weapon item id, ammo = ammo item id, rounds = now loaded.
 */
export const ExplodedEvt = defineNetEvent("gameplay.exploded", { entity: "u32", item: "u32", owner: "u32", x: "f32", y: "f32", radius: "f32" }, { entityFields: ["entity", "owner"] });
export const ReloadedEvt = defineNetEvent("gameplay.reloaded", { entity: "u32", item: "u32", ammo: "u32", rounds: "u16" }, { entityFields: ["entity"] });
/** gameplay.VehicleStationOpened mirror (owner only): the client opens the camper station panel (vehicle = the camper). */
export const VehicleStationOpenedEvt = defineNetEvent("gameplay.vehicleStationOpened", { vehicle: "u32", station: "u8", kind: "u8" }, { entityFields: ["vehicle"] });
/** Owner-only: your progress was deleted (ADR-099); forget the account token and reconnect fresh (character creator). */
export const ProgressDeleted = defineNetEvent("account.progressDeleted", { ok: "u8" });
/** ADR-145: pet feedback (tamed / refused / shied / fed / level up ...) to the acting / owning client only. */
export const PetEventEvt = defineNetEvent("gameplay.petEvent", { pet: "u32", result: "u8", value: "u16" }, { entityFields: ["pet"] });
/** ADR-319 / ADR-320 mount feedback to the acting player (MountResult; value = progress %, item, tier or blocked action). */
export const MountEventEvt = defineNetEvent("gameplay.mountEvent", { mount: "u32", result: "u8", value: "u16" }, { entityFields: ["mount"] });
/** Task 22: AI-human hire feedback (hired / job set / released) to the acting / owning client only. */
export const WorkerEventEvt = defineNetEvent("gameplay.workerEvent", { worker: "u32", result: "u8", value: "u16" }, { entityFields: ["worker"] });
export const DEMO_EVENTS = [...SESSION_EVENTS, Pong, /* appended */ ClanRoster, ClanRosterMember, OnlinePlayer, ExplodedEvt, ReloadedEvt, VehicleStationOpenedEvt, ProgressDeleted, /* ADR-145 */ PetEventEvt, /* Task 22 */ WorkerEventEvt, /* ADR-319 */ MountEventEvt] as const;

/**
 * Wire codes for gameplay command rejections (CommandRejection.reason; the reason string also rides in `detail`).
 * Append-only; 0 = unknown (read `detail`).
 */
export const COMMAND_REJECT_REASONS = [
  "unknown_command", "no_actor", "forbidden", "not_allowed", "rate_limited",
  "not_stall", "stall_closed", "out_of_range", "bad_listing", "listing_disabled", "stale_listing", "price_changed", "sold_out",
  "no_funds", "no_space", "till_full", "till_empty", "bad_qty", "bad_slot", "viewers_full",
  "no_catalog", "no_appearance", "no_target", "not_dead",
  "unknown_recipe", "bad_count", "no_station", "queue_full", "missing_ingredients", "no_job", "not_authority",
  ...PARTY_REJECT_REASONS,
  ...CLAN_REJECT_REASONS,
  /* appended: vehicles (ADR-102). A name already listed above (no_station) keeps its earlier code (first match). */
  ...VEHICLE_REJECT_REASONS,
  /* appended: vehicle crafting (gameplay DESIGN §31) */
  "empty_slot", "not_kit", "no_tank", "not_fuel", "wrong_fuel", "not_repair_item", "wrong_part", "needs_garage",
  /* appended (ADR-099) */ "bad_confirm", "not_claimed",
  /* appended (ADR-109) */ "no_key",
  /* appended (ADR-119/120): roads + signs */ "bad_surface", "no_privilege", "occupied", "cannot_afford", "no_tool", "not_found", "too_far", "bad_kind", "no_item", "not_owner",
  /* appended (ADR-145): pets */ ...PET_REJECT_REASONS,
  /* appended (ADR-205): split / move / to-hotbar (no_space, bad_count, bad_slot, empty_slot keep their earlier codes) */ ...INVENTORY_OP_REJECT_REASONS,
  /* appended (ADR-221): station recipe needs a skill-tree unlock */ "skill_too_low", "skill_locked",
  /* appended (Task 9): map markers (not_owner / not_found keep their earlier codes above) */ ...MAP_MARKER_REJECT_REASONS,
  /* appended (Task 15): animal skill purchase (not_found / not_owner / too_far keep their earlier codes above) */ ...ANIMAL_SKILL_REJECT_REASONS,
  /* appended (Task 22): AI-human hire (not_found / too_far / no_item / not_owner keep their earlier codes above) */ ...WORKER_REJECT_REASONS,
  /* appended (Task 25): dye (no_brush / no_dye / no_wearable / bad_palette / not_dyeable / bad_dye_kind) */ ...DYE_REJECT_REASONS,
  /* appended (ADR-263 Task 36): shovel terrain edits (no_privilege / occupied / too_far keep their earlier codes above) */ "no_shovel", "limit", "not_loaded", "bad_tile",
  /* ADR-264: soil economy */ "no_soil", "inventory_full",
  /* appended (ADR-319 / ADR-320): mounts + saddles (names listed above keep their earlier codes) */ ...MOUNT_REJECT_REASONS,
  /* appended (ADR-351): rope leading (not_leadable / no_rope / already_led) */ ...ROPE_REJECT_REASONS,
] as const;
export type CommandRejectReason = (typeof COMMAND_REJECT_REASONS)[number];
export function rejectReasonCode(reason: string): number { const i = (COMMAND_REJECT_REASONS as readonly string[]).indexOf(reason); return i < 0 ? 0 : i + 1; }
export function rejectReasonName(code: number): CommandRejectReason | undefined { return code > 0 ? COMMAND_REJECT_REASONS[code - 1] : undefined; }
export interface GameplayRejection { command: CommandDef; code: number; reason: string; raw: CommandRejection }
/** Client: gameplay command rejected by the server (core CommandDef, reason code, reason name). Returns unsubscribe. */
export function onGameplayRejected(client: Pick<NetClient, "onCommandRejected">, fn: (r: GameplayRejection) => void): () => void {
  return client.onCommandRejected((raw) => {
    const m = GAMEPLAY_NET_COMMANDS.find((x) => x.net === raw.command); if (!m) return;
    fn({ command: m.core, code: raw.reason, reason: rejectReasonName(raw.reason) ?? raw.detail, raw });
  });
}

/**
 * Applies one input to a player entity (server authority and client prediction use this same function). Delegates to
 * gameplay's shared applyMovementInput (ADR-127): walkSpeed from movement.json x sprint/encumbrance/wetness/road/buffs,
 * normalized so every direction (8 keys, analog stick) moves at exactly that speed x stick magnitude, with collision.
 */
export function applyMoveInput(world: World, e: Entity, cmd: InputCmd | null, dt = 1 / DEFAULT_TICK_HZ): void {
  applyMovementInput(world, e, cmd?.buttons ?? 0, dt, cmd ? { x: cmd.moveX, y: cmd.moveY } : undefined);
}

/**
 * Demo input shared by server and client prediction: a rider's move bits become drive input for its vehicle
 * (gameplay.vehicles reads only the seat-0 rider's, so passengers cannot steer); on foot it is applyMoveInput.
 * ADR-360: the driver's full input (bits + analog) also goes through applyMovementInput, so a wagon driver steers
 * the pulling mount through the same DrawnDrive hook the tests and bots use — motor drivers ignore it there.
 */
export function applyDemoInput(world: World, e: Entity, cmd: InputCmd | null, dt = 1 / DEFAULT_TICK_HZ): void {
  if (!world.has(e, Driver)) { applyMoveInput(world, e, cmd, dt); return; }
  applyMovementInput(world, e, cmd?.buttons ?? 0, dt, cmd ? { x: cmd.moveX, y: cmd.moveY } : undefined); // ADR-289: riding clears the on-foot run-up, never auto-boosts
  const d = driveFromBits(cmd?.buttons ?? 0); setDriveInput(world, e, d.x, d.y, d.boost);
}

/**
 * NetClient options for vehicles (ADR-102): the driver predicts + reconciles its vehicle and trailer chain, corrections
 * over 2 tiles snap (a smoothed slide at vehicle speed looks worse), remote trailers sit in their tow's hitch frame.
 * Use with `applyInput: applyDemoInput` (the same input function as the server).
 */
export const VEHICLE_CLIENT_OPTIONS = {
  controlled: (w: World, owned: readonly Entity[]) => controlledVehicles(w, owned),
  afterInterpolate: (w: World) => { poseTrailersInHitchFrame(w); },
  correctionSnapDistance: 2,
  /** 4 ticks (200 ms): covers 2 lost/late snapshots and the P2P host's every-3rd-tick distant throttle without starving. */
  interpDelayTicks: 4,
} satisfies Partial<NetClientOptions>;

/**
 * The shared registration module for the demo: every peer (server, browser client, bots) calls this so component
 * order and the schema hash match. Gameplay, then core permissions (PlayerId, Membership, OwnedBy, AccessList +
 * the Permissions resource; the server passes its saved GroupRegistry / ClaimRegistry).
 */
export function installDemoWorld(world: World, role: "server" | "client", opts: { tickHz?: number; social?: { groups: GroupRegistry; claims: ClaimRegistry } } = {}): PermissionsRes {
  installGameplay(world, { role, ...(opts.tickHz !== undefined ? { tickHz: opts.tickHz } : {}) });
  if (!world.isRegistered(Appearance)) world.register(Appearance); // character look (same order on every peer)
  return installPermissions(world, opts.social ?? {});
}
