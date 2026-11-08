/**
 * Gameplay components: numeric SoA schemas (ADR-007), array fields + defaults (core batch 2).
 * Registration order = component ids: append new components at the END of GAMEPLAY_COMPONENTS.
 * Replication scope/class per component lives in replication.ts (net applies it); persistence in
 * building/persist.ts. Render-facing fields are numeric references only (Art & Assets owns visuals).
 */
import { defineComponent, defineJobQueue, defineModifierStack, type ComponentDef, type FieldSpec, type FieldType } from "@engine/core";
import { Emitter } from "@engine/world";
export { Emitter };

const pct = (bits = 8): FieldSpec => ({ type: "f32", quant: { bits, min: 0, max: 100 } });

export const Health = defineComponent("Health", {
  hp: { type: "f32", quant: { bits: 12, min: 0, max: 4000 } },
  max: { type: "f32", quant: { bits: 12, min: 0, max: 4000 } },
}, { networked: true });

/** persistent: saved with the chunk (core chunk codec), so depleted nodes and their absolute respawnAtTick survive reloads. */
export const ResourceNode = defineComponent("ResourceNode", { kind: "u16", amount: "u16", respawnAtTick: "u32" }, { networked: true, persistent: true });

/**
 * ADR-147: stamina replicates at 16 bits and the authority keeps it ON the quantization grid (snapStamina), so the
 * owner's prediction replays from exactly the server's value. At 8 bits (0.39 steps) the replica's stamina ran out a
 * tick or two apart from the server's, so the sprint ended at different ticks: a visible singleplayer rubber-band.
 */
export const STAMINA_BITS = 16;
const STAMINA_MAX_I = (1 << STAMINA_BITS) - 1;
export function snapStamina(v: number): number { const t = Math.min(100, Math.max(0, v)) / 100; return (Math.round(t * STAMINA_MAX_I) / STAMINA_MAX_I) * 100; }

export const Survival = defineComponent("Survival", {
  hunger: pct(), thirst: pct(), stamina: pct(STAMINA_BITS), maxStamina: pct(),
  bodyTemp: { type: "f32", quant: { bits: 10, min: 25, max: 45 } },
  staminaDelayTicks: "u16", // remaining regen delay (replicates as u16 ticks, per Netcode)
}, { networked: true });

export const enum DamageCause { None = 0, Starvation = 1, Dehydration = 2, Hypothermia = 3, Hyperthermia = 4, Combat = 5, Sunlight = 6, Fire = 7, Contact = 8, Explosion = 9, Turret = 10, Trap = 11, Disease = 12, Fall = 13 }
export const VitalsState = defineComponent("VitalsState", { lastDamageCause: "u8" });
/** Buff/debuff stat ids (core modifier stacks; 1..255, append only). */
export const enum Stat { HungerRate = 1, ThirstRate = 2, StaminaRegen = 3, HealthRegen = 4, Insulation = 5, MoveSpeed = 6 }
/** Buff kinds are just (stat, op) pairs with expiry; see systems/environment.ts + vitals.ts for the rules. */
export const Buffs = defineModifierStack("gameplay.Buffs", 8, { networked: true });
export const Exposure = defineComponent("Exposure", {
  insulation: "f32", sheltered: "u8",
  wetness: { type: "f32", quant: { bits: 7, min: 0, max: 1 } },
  feltTemp: { type: "f32", quant: { bits: 10, min: -40, max: 60 }, default: 20 },
}, { networked: true });
export const Dead = defineComponent("Dead", { cause: "u8", tick: "u32" }, { networked: true });

/** Shared shape of Inventory and Container so inventory ops work on both. */
export type InvSchema = {
  slotCount: FieldSpec; maxWeight: FieldSpec; weight: FieldSpec; spoilMul: FieldSpec;
  items: { type: FieldType; length: number }; counts: { type: FieldType; length: number };
  /** Per-slot effective creation tick for spoilage (core decayAt); re-based when storage conditions change. */
  createdTick: { type: FieldType; length: number };
  /** Per-slot durability (tools/weapons; non-stackable items have count 1). 0 = n/a. */
  durability: { type: FieldType; length: number };
  /** Per-slot crafter provenance: persistent PlayerId (u32) of whoever crafted the item, 0 = gathered. Part of the stack key. */
  crafterId: { type: FieldType; length: number };
};
/** Player pack slots (separate from the hotbar): gathered / crafted / looted items always land here, never on the hotbar. */
export const PACK_SLOTS = 16;
/** Hotbar slots: the 8 quick slots, stored after the pack in the same Inventory array (slots PACK_SLOTS..PACK_SLOTS+HOTBAR_SLOTS-1). */
export const HOTBAR_OFFSET = PACK_SLOTS;
/** Total player Inventory slots: 16 pack + 8 hotbar. */
export const INVENTORY_SLOTS = PACK_SLOTS + 8;
/** Container array width (ADR-098): the hard per-instance cap. Real capacity is per-instance `slotCount`, set from the def
 *  (piece `container`, vehicle class storage, bag size); slots >= slotCount are always empty. */
export const CONTAINER_MAX_SLOTS = 96;
/** Array width before ADR-098 (persist migration: old rows are zero-padded from 24 to CONTAINER_MAX_SLOTS). */
export const CONTAINER_LEGACY_SLOTS = 24;
/** @deprecated alias of CONTAINER_MAX_SLOTS (kept so existing imports compile). */
export const CONTAINER_SLOTS = CONTAINER_MAX_SLOTS;
export const Inventory = defineComponent("Inventory", {
  slotCount: { type: "u8", default: INVENTORY_SLOTS }, maxWeight: { type: "f32", default: 60 }, weight: "f32", spoilMul: { type: "f32", default: 1 },
  items: { type: "u16", length: INVENTORY_SLOTS }, counts: { type: "u16", length: INVENTORY_SLOTS }, createdTick: { type: "u32", length: INVENTORY_SLOTS }, durability: { type: "u16", length: INVENTORY_SLOTS }, crafterId: { type: "u32", length: INVENTORY_SLOTS },
}, { networked: true, persistent: true }) as ComponentDef<InvSchema>;

export const NO_SLOT = 255;
export const Equipment = defineComponent("Equipment", { mainHandSlot: { type: "u8", default: NO_SLOT }, mainHandItem: "u16" }, { networked: true });
export const Gatherer = defineComponent("Gatherer", { reach: { type: "f32", default: 1.5 }, cooldownUntilTick: "u32" }, { networked: true });
export const CraftingStation = defineComponent("CraftingStation", { kind: "u8", range: { type: "f32", default: 2.5 } }, { networked: true });
/** Crafting job: progress is derived (tick - startTick) so nothing is written per tick; the client predicts only that. */
export const Crafter = defineComponent("Crafter", { recipe: "u16", startTick: "u32", totalTicks: "u16" }, { networked: true });

export const enum IntentAction {
  None = 0, Gather = 1, Craft = 2, Use = 3, CancelCraft = 4, Equip = 5, SelectHotbar = 6,
  Place = 10, Upgrade = 11, Repair = 12, Demolish = 13, Paint = 14,
  Reclaim = 15,
  ToggleDoor = 20, LockDoor = 21, OpenContainer = 22, CloseContainer = 23, Deposit = 24, Withdraw = 25, ToggleFire = 26,
  Attack = 30, Reload = 31, Wear = 32, Boil = 33,
}
/** Per-tick intent, written in the input phase by applyGameplayInput (sim-local; rebuilt from inputs). */
export const PlayerIntent = defineComponent("PlayerIntent", {
  moving: "u8", sprint: "u8", action: "u8", target: "u32", recipe: "u16", slot: "u8",
  piece: "u16", x: "f32", y: "f32", level: "u8", rot: "u8", tier: "u8", variant: "u8", paint: "u8", item: "u16", count: "u16",
  /** Charge hold bit this tick (bows / crossbow draw); set by applyGameplayInput. */
  charge: "u8",
});

// ---- building ----------------------------------------------------------------------------------
/** Agreed with Netcode: static replication class, persisted per chunk. hp is written at most once per tick. */
export const BuildPiece = defineComponent("BuildPiece", {
  type: "u16", rot: "u8", variant: "u8", tier: "u8", hp: "u16", damageStage: "u8", paint: "u8",
  /** Clan color index (set on place / claim change); render uses paint when paint != 0, else tint. */
  tint: "u8",
}, { networked: true, persistent: true });
export const enum EdgeSide { None = 0, North = 1, West = 2 }
/** Derived on every peer from Transform + def when the piece is indexed. */
export const PieceSlot = defineComponent("PieceSlot", { tx: "i32", ty: "i32", z: "u8", side: "u8", gridId: "u32", parent: "u32" });
/** Server-only, never replicated. */
export const PieceStability = defineComponent("PieceStability", { value: "u8", placedTick: "u32", lastDamagedTick: "u32" });
export const Tribe = defineComponent("Tribe", { id: "u16" }, { networked: true, persistent: true });
export const PrivilegeZone = defineComponent("PrivilegeZone", { radius: "f32", tribe: "u16" }, { networked: true, persistent: true });
export const DoorState = defineComponent("DoorState", { open: "u8", lockTribe: "u16" }, { networked: true, persistent: true });
/** burnUntilTick is absolute so burning causes no per-tick writes (low-rate replication). */
/** ADR-108 turret / trap state on a placed defense piece: readyTick = next shot or re-arm tick, owner = builder PlayerId
 *  (never targeted, nor their party/clan), target = current turret target (render aim). Ammo lives in the piece's Container. */
export const Defense = defineComponent("Defense", { readyTick: "u32", owner: "u32", target: "u32" }, { networked: true, persistent: true });
/** ADR-109 vehicle keys (append-only): keyId = stable lock id a vehicle_key slot carries in crafterId (0 = open, no key); owner = PlayerId the key was issued to; issued = key handed out. */
export const VehicleLock = defineComponent("VehicleLock", { keyId: "u32", owner: "u32", issued: "u8" }, { networked: true, persistent: true });
export const Fuel = defineComponent("Fuel", { burnUntilTick: "u32", lit: "u8" }, { networked: true, persistent: true });
export const Container = defineComponent("Container", {
  slotCount: { type: "u8", default: 12 }, maxWeight: "f32", weight: "f32", spoilMul: { type: "f32", default: 1 },
  items: { type: "u16", length: CONTAINER_SLOTS }, counts: { type: "u16", length: CONTAINER_SLOTS }, createdTick: { type: "u32", length: CONTAINER_SLOTS }, durability: { type: "u16", length: CONTAINER_SLOTS }, crafterId: { type: "u32", length: CONTAINER_SLOTS },
}, { networked: true, persistent: true }) as ComponentDef<InvSchema>;
export const MAX_VIEWERS = 8;
/** Who has the container open (server-only; net reads it for the "viewers" scope). */
export const ContainerViewers = defineComponent("ContainerViewers", { clients: { type: "u16", length: MAX_VIEWERS }, count: "u8" });
export const Viewing = defineComponent("Viewing", { container: "u32" });
/** Client-only placement preview (the only predicted building state). */
export const BuildGhost = defineComponent("BuildGhost", {
  /** inputs (client UI): builder entity, piece type, pointer position (tiles), level, rotation step, tier, variant */
  builder: "u32", piece: "u16", px: "f32", py: "f32", level: "u8", rot: "u8", tier: "u8", variant: "u8",
  /** outputs (render): snapped position/height/facing, validity and BuildFail reason */
  x: "f32", y: "f32", z: "f32", facing: "f32", valid: "u8", reason: "u8",
});

// ---- combat / zombies ----------------------------------------------------------------------------
export const Attacker = defineComponent("Attacker", { cooldownUntilTick: "u32" }, { networked: true });
export const Zombie = defineComponent("Zombie", { kind: "u8", variant: "u8" }, { networked: true });
export const enum ZState { Wander = 0, Investigate = 1, Chase = 2, AttackPlayer = 3, AttackStructure = 4, Dead = 5 }
export const ZombieBrain = defineComponent("ZombieBrain", {
  state: "u8", target: "u32", goalX: "f32", goalY: "f32", homeX: "f32", homeY: "f32",
  thinkAt: "u32", repathAt: "u32", attackAt: "u32", stateTick: "u32", blockPiece: "u32",
});
/** Shared, wire-stable anim ids (core AnimState, ADR-093); `Anim` kept as gameplay's name. */
export { AnimState as Anim, ANIM_STATE_NAMES } from "@engine/core";
export const AnimState = defineComponent("AnimState", { anim: "u8", startTick: "u32" }, { networked: true });
export const NoiseLevel = defineComponent("NoiseLevel", { value: "f32" });
/**
 * Links an attachment entity (door state, fire/fuel, container) to its piece by grid slot, so peers resolve it
 * without entity references. Attachments are separate entities because BuildPiece entities use net's static class
 * (all their components ride the static channel, scopes don't apply).
 */
export const enum AttachKind { Door = 1, Fire = 2, Storage = 3, Light = 4, Till = 5 }
export const PieceLink = defineComponent("PieceLink", { tx: "i32", ty: "i32", z: "u8", side: "u8", layer: "u8", kind: "u8" }, { networked: true, persistent: true });
/** Render-facing (renderer contract): wetness 0..255 on characters and zombies, replicated to all. */
export const Wetness = defineComponent("Wetness", { level: "u8" }, { networked: true });
/** Render-facing (renderer contract): cold/heat stress 0..255 and shivering 0/1. Precise bodyTemp stays owner-scoped in Survival. */
export const BodyTemp = defineComponent("BodyTemp", { cold: "u8", heat: "u8", shivering: "u8" }, { networked: true });
/** Per-chunk surface wetness (0..1 as u8 0..255), one entity per active chunk at its center; server-driven, render reads it. */
export const ChunkSurface = defineComponent("ChunkSurface", { cx: "i32", cy: "i32", wetness: "u8" }, { networked: true });
/** Social summary for render/UI (scope all). Ids come from core GroupRegistry (party, clan); rank is clan rank. */
export const GroupSummary = defineComponent("GroupSummary", { partyId: "u32", clanId: "u32", rank: "u8" }, { networked: true });
/** Last tick this entity dealt or took combat damage (combat tag: blocks trade/logout rules, UI timer). */
export const CombatTag = defineComponent("CombatTag", { untilTick: "u32" }, { networked: true });
/** Death loot container marker (player corpse / bag): owner PlayerId, despawn tick. Contents in Container. */
/** Ground container. ADR-238: spawnTick (absolute, persists) + kind (LootSource) drive the despawn timer; emptiedTick
 *  (0 = has items) starts the short emptied grace. despawnAtTick 0xffffffff = permanent cache. See loot_despawn.ts. */
export const LootBag = defineComponent("LootBag", { owner: "u32", despawnAtTick: "u32", spawnTick: "u32", kind: "u8", emptiedTick: "u32" }, { networked: true, persistent: true });
/** Written by net on the server (per-connection RTT) for range slack. */
/** ADR-161 world-label summary of a LootBag (everyone sees it; Container itself is viewers-only). Server recomputes
 *  ~every 10 ticks: top item + its total count, number of non-empty stacks, and a LootSource tag. */
export const LootSummary = defineComponent("LootSummary", { item: "u16", count: "u16", stacks: "u8", source: "u8" }, { networked: true });
/** Written by net on the server (per-connection RTT) for range slack. */
export const Latency = defineComponent("Latency", { rttMs: "u16" });
/**
 * ADR-244 player stance (server-authoritative, replicated to all): mode = StanceMode (drives AnimState 20..24),
 * crouch = the crouch toggle, carriedNetId = the LootBag carried at the carry socket (0 none), bedNetId/spot/lie = the
 * bed slept in (spot index into the bed's spots, lie 1 = sleep_lie, 2 = sleep_lie_under, 0 = curled floor sleep).
 */
/** World-map marker visibility: 0 = private (owner only), 1 = party, 2 = clan. Set at creation; party/clan markers
 * carry the party/clan id they were placed under, so players who join that party/clan later can see them too. */
export const enum MarkerVisibility { Private = 0, Party = 1, Clan = 2 }
/** Max marker label length (same u8-array text pattern as Sign). */
export const MAP_MARKER_LABEL_MAX = 24;
/** World-map marker: a point a player marked on the map. Transform holds the world position; Owner holds the placing
 * client's session (so the owner always passes the replication scope); `owner` is the persistent PlayerId. Networked
 * (scope-filtered by visibility) and persistent (chunk-saved via Transform). */
export const MapMarker = defineComponent("MapMarker", { owner: "u32", visibility: "u8", party: "u32", clan: "u32", len: "u8", label: { type: "u8", length: MAP_MARKER_LABEL_MAX } }, { networked: true, persistent: true });
/** Task 13 diseases: active disease slots (disease index + 1, 0 = empty; untilTick 0 = no auto-expiry) plus
 * exposure accumulators in ticks (cold/heat/sprint/rest/contact). Networked (HUD + transmission + move penalty
 * read it on every peer) and persistent (sickness survives restarts). */
export const MAX_DISEASES = 8;
export const Diseases = defineComponent("Diseases", {
  disease: { type: "u8", length: MAX_DISEASES },
  untilTick: { type: "u32", length: MAX_DISEASES },
  coldTicks: "u32", heatTicks: "u32", sprintTicks: "u32", restTicks: "u32", contactTicks: "u32",
  /** Task 31: care-cure progress in ticks — continuous dry + fed + hydrated + warm time while sick (cold/flu). */
  careTicks: "u32",
  /** ADR-280: tick rate used by the infection expiry clock; legacy saves default to the standard 20Hz. */
  infectionHz: { type: "u16", default: 20 },
}, { networked: true, persistent: true });
/** Task 15 animal skills: per-animal level/XP (farm animals; pets mirror Pet.level), unspent skill points, and a
 * bitmask of bought tree nodes (bit i = tree node i). Networked (panels read it on every peer) and persistent
 * (points and purchases survive restarts; see reconcileAnimalSkills for the level-based migration rule). */
export const AnimalSkills = defineComponent("AnimalSkills", {
  level: { type: "u16", default: 1 },
  xp: "u32",
  points: "u16",
  nodes: "u32",
}, { networked: true, persistent: true });
/** Task 22 AI-human recruitment: one record per AI human (bot player entity). `wantedItem` is the single item the
 * bot asks for before it will work for a player (0 = not yet assigned; assigned once, server-side, and never
 * re-rolled). `owner` is the hiring player's PlayerId (0 = for hire). `job` is the assigned WorkerJob. `homeX/homeY`
 * is where the bot was hired — the work anchor when the owner has no claim. Networked (every peer sees the same
 * want / owner / job) and persistent (a hired worker survives restarts via the player save path). */
export const enum WorkerJob { None = 0, Gather = 1, Farm = 2, Defend = 3, Craft = 4, Maintain = 5, Follow = 6 }
export const Worker = defineComponent("Worker", {
  wantedItem: "u16",
  owner: "u32",
  job: "u8",
  homeX: "f32",
  homeY: "f32",
}, { networked: true, persistent: true });
/** ADR-259: the current assignment. Empty selections mean gather-any / automatic tool progression.
 * Target ids are persistent identities, NOT process-local entity handles or NetIds. */
export const WORKER_SELECTION_MAX = 16;
export const WorkerOrder = defineComponent("WorkerOrder", {
  selections: { type: "u16", length: WORKER_SELECTION_MAX },
  craftCursor: "u8", kind: "u8", targetId: "f64", targetPlayer: "u32", x: "f32", y: "f32",
}, { networked: true, persistent: true });
/** Lazily assigned opaque 53-bit identity for guard / farm / repair targets; survives chunk/player save/load. */
export const WorkerTarget = defineComponent("WorkerTarget", { id: "f64" }, { networked: true, persistent: true });
/** Task 28: a bot's home anchor (server-side only, persistent) — set on hire relocation so the bot's planner
 * re-anchors on the new base instead of rebuilding at the old site. Not networked: the agent layer reads it
 * server-side only, so it costs nothing on the container-bandwidth budget. */
export const BotHome = defineComponent("BotHome", { x: "f32", y: "f32" }, { networked: false, persistent: true });
export const Stance = defineComponent("Stance", { mode: "u8", crouch: "u8", carriedNetId: "u32", bedNetId: "u32", spot: "u8", lie: "u8", sinceTick: "u32" }, { networked: true });
export const StanceMode = { None: 0, Block: 1, Crouch: 2, Carry: 3, Sleep: 4, Aim: 5 } as const;
export type StanceMode = (typeof StanceMode)[keyof typeof StanceMode];

// ---- economy (trade stalls) ----------------------------------------------------------------------
export const MAX_LISTINGS = 24;
export const LEDGER_SIZE = 16;
export const enum StallOwnerKind { None = 0, Player = 1, Clan = 2 }
/** Lives on the stall's stock attachment (the entity with Container = stock). Scope all (AOI): owner kind/id, open, listing count. */
export const StallHeader = defineComponent("StallHeader", { ownerKind: "u8", ownerId: "u32", open: "u8", listingCount: "u8" }, { networked: true, persistent: true });
/** Stall sign + derived flags, replicated to all (Art & Assets): soldOut = no enabled listing has stock (server-maintained);
 * name = owner-editable sign text, sanitized printable ASCII, nameLen bytes used (max STALL_NAME_MAX). Saved in STRC v3. */
export const STALL_NAME_MAX = 24;
export const StallSign = defineComponent("StallSign", { soldOut: "u8", nameLen: "u8", name: { type: "u8", length: STALL_NAME_MAX } }, { networked: true });
/** Per player customization state: created = first-join creator done; unlocks = bitmask over data/cosmetics.json
 * unlockTags (index = bit, 64 max). Networked (owner UI shows locked/unlocked), persistent with the player. */
export const Wardrobe = defineComponent("Wardrobe", { created: "u8", unlocks: { type: "u32", length: 2 } }, { networked: true, persistent: true });
/** Per listing slot i (stock slot i): price {item,count}, quantity per sale, enabled. revision bumps on every change. Scope viewers. */
export const Listings = defineComponent("Listings", {
  priceItem: { type: "u16", length: MAX_LISTINGS }, priceCount: { type: "u16", length: MAX_LISTINGS },
  qty: { type: "u16", length: MAX_LISTINGS }, enabled: { type: "u8", length: MAX_LISTINGS }, revision: "u32",
}, { networked: true, persistent: true });
/** Sales ledger ring buffer (capped, persisted); head = next write index, total = sales ever. Scope viewers (owner UI). */
export const StallLedger = defineComponent("StallLedger", {
  tick: { type: "u32", length: LEDGER_SIZE }, item: { type: "u16", length: LEDGER_SIZE }, count: { type: "u16", length: LEDGER_SIZE },
  priceItem: { type: "u16", length: LEDGER_SIZE }, priceCount: { type: "u32", length: LEDGER_SIZE }, buyerId: { type: "u32", length: LEDGER_SIZE },
  crafterId: { type: "u32", length: LEDGER_SIZE }, head: "u8", total: "u32",
}, { networked: true, persistent: true });

/**
 * Burning status (render contract, packages/render/src/burning.ts): on BuildPiece entities (structure fire,
 * data/fire.json) and creatures (damage over time). lit 0/1, intensity 0..255, startTick = ignition tick.
 */
export const Burning = defineComponent("Burning", { lit: "u8", intensity: "u8", startTick: "u32" }, { networked: true, persistent: true });

/**
 * The shared registration module: registration order = component ids on every peer (append only!).
 * Includes engine-provided gameplay-facing components (world Emitter, the Buffs modifier stack).
 */
/** Ambient wildlife (population spawner). kind = index into animalDefs() (ai.json animal_* archetypes; spawn rows in spawns.json). Not persistent: respawned by density. */
export const Animal = defineComponent("Animal", { kind: "u8", state: "u8", homeX: "f32", homeY: "f32", goalX: "f32", goalY: "f32", thinkAt: "u32" }, { networked: true });

/** Slice 5 queued crafting (core JobQueue layout, 4 slots; see systems/craft_queue.ts). */
export const CraftQueue = defineJobQueue("gameplay.CraftQueue", 4);
/** Queued-craft outputs that didn't fit at completion; persistent so they survive restarts (old saves: absent = nothing owed). */
export const CRAFT_OWED_SLOTS = 8;
export const CraftOwed = defineComponent("CraftOwed", {
  item: { type: "u16", length: CRAFT_OWED_SLOTS }, count: { type: "u16", length: CRAFT_OWED_SLOTS }, crafterId: { type: "u32", length: CRAFT_OWED_SLOTS },
}, { networked: false, persistent: true });
/** Face expression (id = data/expressions.json index + 1, 0 = none) shown until untilTick. Broadcast, not persisted, kept off Appearance. */
export const Expression = defineComponent("Expression", { id: "u8", untilTick: "u32" }, { networked: true });
/** Latest pending party invite for this player (owner-scoped mirror of PartyInvites; server writes it in party handlers only). */
/** Mirror of the player's party role (GroupRole; 0 = none) so the client can hide leader-only buttons (ADR-141). */
export const PartyRank = defineComponent("PartyRank", { role: "u8" }, { networked: true });
export const PartyInvitePending = defineComponent("PartyInvitePending", { party: "u32", from: "u32", expiresTick: "u32" }, { networked: true });
/** Latest pending clan invite (owner-scoped mirror of ClanInvites; written in clan handlers only). */
export const ClanInvitePending = defineComponent("ClanInvitePending", { clan: "u32", from: "u32", expiresTick: "u32" }, { networked: true });
/** Clan view on each online member (AOI): clan, role, current clan goal (ClanGoal) + point, own contribution count. Clan handlers only. */
export const ClanStatus = defineComponent("ClanStatus", { clan: "u32", role: "u8", goal: "u8", goalX: "f32", goalY: "f32", contrib: "u32" }, { networked: true });
// ---- vehicles (docs/VEHICLES.md, ADR-096) ---------------------------------------------------------
export const VEHICLE_MAX_SEATS = 8;
/** A drivable vehicle or trailer. defId = data/vehicles.json index + 1. heading radians; drift = velocity angle minus heading
 * (arcade slide); steer = current steering angle. Storage lives in Container on the same entity. */
export const Vehicle = defineComponent("Vehicle", {
  defId: "u16", speed: "f32", heading: "f32", fuel: "f32", health: "f32", drift: "f32", steer: "f32",
}, { networked: true, persistent: true });
/** Seat occupancy on the vehicle: rider NetIds (0 = empty), seat 0 = driver. Not persisted (riders are ejected on load). */
export const VehicleSeats = defineComponent("VehicleSeats", { occupant: { type: "u32", length: VEHICLE_MAX_SEATS } }, { networked: true });
/** On a rider: the vehicle NetId and seat index (0 = driver). */
export const Driver = defineComponent("Driver", { vehicleNetId: "u32", seat: "u8" }, { networked: true });
/** Hitch links (NetIds, 0 = none): towNetId = what this entity tows at its rear; parentNetId = what tows this entity. */
export const Hitch = defineComponent("Hitch", { towNetId: "u32", parentNetId: "u32" }, { networked: true, persistent: true });
/** Worn clothing/armor: per WearSlot the inventory slot + 1 (0 = empty) and the item (broadcast for render). carryBonus applied to Inventory.maxWeight. */
export const Worn = defineComponent("Worn", { slot: { type: "u8", length: 8 }, item: { type: "u16", length: 8 }, carryBonus: "f32", waterproof: "f32", armor: "f32" }, { networked: true, persistent: true });
/** Main-hand ranged state: inventory slot + 1 the magazine belongs to, loaded rounds of ammoItem, reload timer, draw start (0 = not drawing). */
export const WeaponState = defineComponent("WeaponState", { slot: "u8", loaded: "u8", ammoItem: "u16", reloadUntilTick: "u32", chargeStartTick: "u32" }, { networked: true });
/** A thrown explosive waiting for its fuse (Transform = landing point). Replicated: only what clients render (item, fuse). */
export const LiveExplosive = defineComponent("LiveExplosive", { item: "u16", detonateTick: "u32" }, { networked: true });
/** Server-only side component of a LiveExplosive: thrower entity (raid attribution) and tribe (own-structure immunity). Never replicated. */
export const ExplosiveOwner = defineComponent("ExplosiveOwner", { owner: "u32", ownerTribe: "u16" }, { networked: false });
/** Crafted-vehicle provenance + condition (vehicle_craft.ts): crafterId = PlayerId from the kit slot (0 = world spawn);
 * wear 0..0.5 = fraction of max health lost to field repairs (garage repair clears it). */
export const VehicleCondition = defineComponent("VehicleCondition", { crafterId: "u32", wear: "f32" }, { networked: true, persistent: true });
/** Replicated toggles on a powered vehicle (ADR-101): bit 0 engineOn, bit 1 headlights. Separate 1-byte component so it
 * only goes on the wire when toggled, not with every moving-Vehicle delta. Written only by the vehicle state commands. */
export const VehicleState = defineComponent("VehicleState", { flags: "u8" }, { networked: true, persistent: true });
export const VEHICLE_ENGINE_ON = 1, VEHICLE_HEADLIGHTS = 2;
/** ADR-110 planted crop / sapling / bush (farming.ts). kind = farming.json plantables index + 1 (0 = tilled soil, nothing planted);
 *  growth 0..1, stage = render stage; waterUntilTick = watered boost end; fertilized 0/1; fertilizerUntilTick = dose expiry (ADR-287). Matures into a resource node. */
export const Crop = defineComponent("Crop", { kind: "u8", stage: "u8", growth: "f32", waterUntilTick: "u32", fertilized: "u8", fertilizerUntilTick: "u32" }, { networked: true, persistent: true });
/** ADR-287: planted provenance survives maturity; never attached to wild flora. */
export const GrownPlant = defineComponent("GrownPlant", { kind: "u8", waterUntilTick: "u32", fertilizerUntilTick: "u32" }, { networked: true, persistent: true });
/** ADR-113 skill progression (skills/progression.ts): xp toward next level, unspent points, respec count, nodes = bitset of
 * skills.json node indices (append-only order). Networked (own tree UI / toast) + persistent (saves, rejoin). */
export const Progression = defineComponent("Progression", { xp: "u32", level: "u16", points: "u16", respecs: "u8", nodes: { type: "u32", length: 8 }, /* ADR-209 per-tree (index = skills.json categories) */ tver: "u8", txp: { type: "u32", length: 8 }, tlevel: { type: "u16", length: 8 }, tpoints: { type: "u16", length: 8 } }, { networked: true, persistent: true });
/** ADR-113 domesticated animal (skills/husbandry.ts). owner = tamer PlayerId (0 = none); fedUntil / produceAt / breedAt are ticks. */
export const Tamed = defineComponent("Tamed", { kind: "u8", owner: "u32", fedUntil: "u32", produceAt: "u32", breedAt: "u32" }, { networked: true, persistent: true });

/** ADR-119 road tile (roads.ts). Standalone entity at tile centre. surface = RoadSurface; mask = auto-connect bits
 *  (1 N, 2 E, 4 S, 8 W) recomputed on place/remove; owner = placer PlayerId. Networked + persistent (chunk codec, like Crop). */
export const Road = defineComponent("Road", { surface: "u8", mask: "u8", owner: "u32" }, { networked: true, persistent: true });
export const enum RoadSurface { None = 0, Path = 1, Gravel = 2, Paved = 3 }
/** ADR-263 (Task 36) shovel terrain edit: standalone entity at a tile centre (like Road). dig = levels raised (+) or dug
 * (-) relative to the generated ground there, clamped to ±25. Networked (client depth / darkness / HUD temperature) and
 * persistent (the chunk height byte is saved with the chunk; this keeps the "how far below ground" reference). */
export const TerrainEdit = defineComponent("TerrainEdit", { dig: "i8" }, { networked: true, persistent: true });
export const SIGN_TEXT_MAX = 48;
/** ADR-120 sign (signs.ts). kind = signs.json index + 1; rot = quarter turns; owner = PlayerId, clan = owner's clan at
 *  placement (edit rights); text = sanitized ASCII bytes, len used. Networked (rendered as a world label) + persistent. */
export const Sign = defineComponent("Sign", { kind: "u8", rot: "u8", owner: "u32", clan: "u32", len: "u8", text: { type: "u8", length: SIGN_TEXT_MAX } }, { networked: true, persistent: true });
/** ADR-121 roaming horde member (hordes.ts): horde id, target piece entity + target centroid (retarget if destroyed). Server-only. */
export const HordeMember = defineComponent("HordeMember", { horde: "u16", target: "u32", tx: "f32", ty: "f32" });
/** ADR-121 world rules on the environment singleton (replicated so clients show them): hordes 0/1, grace in in-game days. */
export const WorldRules = defineComponent("WorldRules", { hordes: "u8", hordeGraceDays: "f32", aiHumans: "u8" }, { networked: true });
export const enum HordePhase { Idle = 0, Warning = 1, Active = 2 }
/** ADR-121 horde director status on the environment singleton: drives client toasts + audio (snapshot diffs).
 *  seq bumps per horde; kind 1 solo / 2 clan; alive/size members; x,y = target centroid; owner = clan id or PlayerId. */
export const HordeStatus = defineComponent("HordeStatus", { phase: "u8", seq: "u16", kind: "u8", size: "u16", alive: "u16", x: "f32", y: "f32", owner: "u32", nextTick: "u32" }, { networked: true });
/** ADR-119 server-only runtime builder of a piece (PlayerId), for settlement classification + solo horde owners. */
export const PieceOwner = defineComponent("PieceOwner", { player: "u32" }, { persistent: true }); // ADR-212: survives restarts (respawn at base, horde groups)

/**
 * ADR-134 hit reaction (authority writes on creature damage; broadcast, NOT persisted). startTick = tick of the hit,
 * dir = hit direction (attacker -> target) quantised to 0..255 over 2*pi, src = attacker NetId (0 = none), amount = damage (clamped u8).
 * Clients render a short flinch/knockback nudge + flash from it; health bars use src to spot their own combat targets.
 */
/** ADR-193: `cause` = DamageCause; src 0 = undirected (sunlight, own fire): clients show no knockback flinch. */
export const HitReact = defineComponent("HitReact", { startTick: "u32", dir: "u8", src: "u32", amount: "u8", cause: "u8" }, { networked: true });
/**
 * ADR-134 depleted resource node waiting to regrow (authority; networked + persistent so it survives restarts).
 * Sits at the old node's position (a tree leaves a stump until stumpUntilTick); at respawnAtTick a fresh node of `kind`
 * spawns at a new valid spot near it (same tile/biome, clear of structures, roads and players) and this entity is removed.
 */
export const NodeRegrow = defineComponent("NodeRegrow", { kind: "u16", respawnAtTick: "u32", stumpUntilTick: "u32", tries: "u8" }, { networked: true, persistent: true });

/** ADR-145 pet name buffer width (printable ASCII). */
export const PET_NAME_MAX = 16;
export const enum PetCmd { Follow = 0, Stay = 1, Guard = 2 }
/**
 * ADR-145 companion pet (authority writes; networked to all + persistent). species = pets.json index + 1; owner = PlayerId
 * (stable across sessions/restarts); cmd = PetCmd; fullness/loyalty 0..100; hp mirrors Health (Health is not persistent);
 * stayX/Y = the Stay anchor; name = renameable label (len chars). The pet also carries Tamed (despawn + load restore) and a
 * small Container (its inventory, owner-only).
 */
export const Pet = defineComponent("Pet", {
  species: "u8", owner: "u32", cmd: "u8", level: { type: "u8", default: 1 }, xp: "u32",
  fullness: { type: "f32", quant: { bits: 8, min: 0, max: 100 }, default: 80 }, loyalty: { type: "f32", quant: { bits: 8, min: 0, max: 100 }, default: 60 }, hp: "f32",
  stayX: "f32", stayY: "f32", len: "u8", name: { type: "u8", length: PET_NAME_MAX },
}, { networked: true, persistent: true });
/** ADR-145 owner of a pet_trough (builder PlayerId; persistent so pets still find it after a restart). */
export const TroughOwner = defineComponent("TroughOwner", { player: "u32" }, { networked: true, persistent: true });
/** ADR-145 server-only pet runtime (timers + current target). */
export const PetBrain = defineComponent("PetBrain", { target: "u32", nextAttack: "u32", nextEat: "u32", nextStarve: "u32", goal: "u32", lastSeen: "u32" });
/**
 * Task 14: a pet's guard assignment (authority writes; networked, NOT persistent — a guard target is a live
 * entity whose id is meaningless after a restart, so a reload reverts a guarding pet to Follow; see petSystem).
 * kind: 0 = none, 1 = world location (x, y), 2 = entity (target; x, y snapshot its last-known position).
 */
export const PetGuard = defineComponent("PetGuard", { kind: "u8", target: "u32", x: "f32", y: "f32" }, { networked: true });
/** Task 14: what a pet is currently doing (authority writes when it changes; networked, not persistent). */
export const enum PetStatus { Idle = 0, Follow = 1, Stay = 2, Guard = 3, Fight = 4, Return = 5, Eat = 6 }
export const PetStatusComp = defineComponent("PetStatus", { status: "u8" }, { networked: true });
/**
 * Task 24: smoothed flame heat (deg C) of the enclosed room an entity stands in — 0 outdoors or with no lit fire
 * nearby. The exposure system eases it toward the live fire heat (walls occlude, so only fires in the same room
 * count) with a minutes-long time constant, and it decays back to 0 when the fire goes out. Networked, NOT
 * persistent: a reload rewarms the room from cold (the rise takes minutes either way). Read by the HUD indoor
 * gauge and the character sheet; the value is per-entity (each occupant converges to the same room heat).
 */
export const RoomHeat = defineComponent("RoomHeat", { heat: "f32" }, { networked: true });

/** Task 28 grazing: a grass tile an animal depleted by grazing — bare until regrowTick (world tick), when the grass is back. */
export const GrazedTile = defineComponent("GrazedTile", { tx: "i32", ty: "i32", regrowTick: "u32" }, { networked: true, persistent: true });
/** Task 28 grazing: transient per-animal grazing progress (server-only) — the tile being grazed and the tick it feeds. */
export const Grazing = defineComponent("Grazing", { tx: "i32", ty: "i32", doneTick: "u32" }, { networked: false, persistent: false });
/**
 * Task 25: dye colour of the item in each inventory slot (held tools / weapons). Packed 0xRRGGBB, 0 = undyed
 * (no palette colour is 0x000000, so 0 is unambiguous). Networked (every peer sees the dyed held item) and
 * persistent (the dye survives save/reconnect). Only the main-hand held sprite is tinted in the renderer; the
 * colour is also shown on the item's inventory icon. Hair / worn clothing are dyed through the appearance
 * slots (primary colour), not here — see dye.ts.
 */
export const SlotDye = defineComponent("SlotDye", { colors: { type: "u32", length: INVENTORY_SLOTS } }, { networked: true, persistent: true });
/** Task 33: most-recently crafted recipes (ids, most recent first) and placed pieces, per player. Networked (the
 * crafting / build panels read the owner's list on every peer) and persistent (the player codec encodes every
 * component on the player entity, so the lists survive save/reconnect; old saves: absent = empty). */
export const RECENT_MAX = 8;
export const RecentCrafts = defineComponent("RecentCrafts", {
  recipe: { type: "u16", length: RECENT_MAX }, count: "u8",
}, { networked: true, persistent: true });
export const RecentBuilds = defineComponent("RecentBuilds", {
  piece: { type: "u16", length: RECENT_MAX }, count: "u8",
}, { networked: true, persistent: true });
/**
 * Task 14: a joined player's load-in state (networked, NOT persistent — re-added on every join).
 * The server adds it with ready=0 when a client joins; the client sends gameplay.ready when its second
 * loading screen dismisses (connected + player spawned + chunks streamed), and the server flips ready=1.
 * Virtual players (singleplayer bots) are marked ready at join by markVirtual. Systems that drain a player
 * (vitals, diseases, pet hunger, spoilage) skip entities whose PlayerReady is still 0 — so nothing ticks
 * down while the player is still loading. Entities without PlayerReady (test worlds, respawns, NPCs) are
 * unaffected: the gate is opt-in per joined player, not a global behavior change.
 */
export const PlayerReady = defineComponent("PlayerReady", { ready: "u8" }, { networked: true });

/** ADR-289: owner-replicated so reconciliation restores the warmup before replaying inputs. Not persisted. */
export const AutoSprint = defineComponent("AutoSprint", {
  seconds: "f32", headingX: "f32", headingY: "f32",
}, { networked: true });

export const HotbarSelection = defineComponent("HotbarSelection", { slot: { type: "u8", default: NO_SLOT } }, { networked: true });

/** ADR-299: the player/AI human is at the bottom of a shaft hatch on their current tile (otherwise they stand on the lid). */
export const InShaft = defineComponent("InShaft", { down: "u8" }, { networked: true, persistent: true });

/** ADR-300: persistent marker for a seed-stamped abandoned site (not networked). */
export const AbandonedSite = defineComponent("AbandonedSite", {
  originX: "i32", originY: "i32", width: "u8", height: "u8", kind: "u8", stories: "u8", claimed: "u8", claimedBy: "u32",
}, { persistent: true });

export const GAMEPLAY_COMPONENTS = [
  Emitter, Buffs,
  Health, ResourceNode, Survival, VitalsState, Exposure, Dead,
  Inventory, Equipment, Gatherer, CraftingStation, Crafter, PlayerIntent,
  BuildPiece, PieceSlot, PieceStability, Tribe, PrivilegeZone, DoorState, Fuel, Container, ContainerViewers, Viewing, BuildGhost,
  Attacker, Zombie, ZombieBrain, AnimState, NoiseLevel, Latency, PieceLink, Wetness, BodyTemp, ChunkSurface,
  GroupSummary, CombatTag, LootBag,
  StallHeader, Listings, StallLedger,
  Burning,
  StallSign,
  Wardrobe,
  Animal,
  CraftQueue,
  CraftOwed,
  Expression,
  PartyInvitePending,
  ClanInvitePending,
  ClanStatus,
  Vehicle, VehicleSeats, Driver, Hitch, // append-only (ADR-096)
  Worn, WeaponState, LiveExplosive,
  ExplosiveOwner, // append-only (server-only)
  VehicleCondition, // vehicle crafting (DESIGN.md §31)
  VehicleState, // append-only (ADR-101)
  Defense, // append-only (ADR-108)
  VehicleLock, // append-only (ADR-109)
  Crop, // append-only (ADR-110)
  Progression, Tamed, // append-only (ADR-113)
  Road, Sign, HordeMember, WorldRules, HordeStatus, PieceOwner, // append-only (ADR-119..121)
  HitReact, NodeRegrow, // append-only (ADR-134)
  PartyRank, // append-only (ADR-141)
  Pet, TroughOwner, PetBrain, // append-only (ADR-145)
  LootSummary, // ADR-161
  Stance, // ADR-244 (append-only)
  MapMarker, // append-only (world-map markers)
  Diseases, // append-only (Task 13: diseases)
  PetGuard, PetStatusComp, // append-only (Task 14: pet guarding + status)
  PlayerReady, // append-only (Task 14: second loading screen — joined players wait for their client to load in)
  AnimalSkills, // append-only (Task 15: per-animal skill points + spent-node bitmask)
  Worker, // append-only (Task 22: AI-human recruitment — wanted item / owner / job / hire anchor)
  BotHome, // append-only (Task 28: a bot's home anchor after hire relocation — server-side only)
  GrazedTile, Grazing, // append-only (Task 28: grazing — depleted-grass tiles + per-animal grazing progress)
  RoomHeat, // append-only (Task 24: smoothed flame heat of the enclosed room an entity stands in)
  SlotDye, // append-only (Task 25: per-inventory-slot dye colour for held tools/weapons — packed 0xRRGGBB, 0 = undyed)
  RecentCrafts, RecentBuilds, // append-only (Task 33: most-recently crafted recipes / placed pieces, most recent first)
  WorkerOrder, WorkerTarget, // append-only (ADR-259: detailed hired-human orders)
  TerrainEdit, // append-only (ADR-263: shovel terrain edits)
  GrownPlant, // append-only (ADR-287)
  AutoSprint, HotbarSelection, // append-only (ADR-289)
  InShaft, // append-only (ADR-299)
  AbandonedSite, // append-only (ADR-300)
] as const;
