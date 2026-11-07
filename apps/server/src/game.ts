import { friendSpawn } from "./friend-spawn.js";
import { giveSandboxKit, sandboxPetKit, sandboxPetCorner, sandboxSpawn } from "./sandbox.js";
import { handLootTarget, Viewing, TerrainRes, terrainFromTileMap } from "@engine/gameplay";
import { applyStanceInput, stanceBlocksActions, GameplayEdgeBits } from "@engine/gameplay"; // ADR-244
import { installInventoryOpCommands, installRoadCommands, NodeRegrow, installSignCommands, installPetCommands, installReadyCommands, markReady, PlayerReady, PetEvent, setWorldRules, worldRules, type WorldRulesOpts, installAnimalSkillCommands, installWorkerCommands, installDyeCommands, WorkerEvent, installTerrainCommands } from "@engine/gameplay";
/** Authoritative game server: world + gameplay + streaming chunks + persistence + NetServer sessions. */
import { ChannelRegistry, CommandRejected, DEFAULT_TICK_HZ, FixedLoop, installCommandHandlers, cosmeticsHashes, type CosmeticCatalogLike, Membership, Owner, PlayerId, Season, SEASON_COUNT, TimeOfDay, Transform, World, type Entity, type PermissionsRes } from "@engine/core";
import { CHUNK_SIZE, ChunkManager, ProceduralGenerator, computeSpawnPoints, chunkKeyOf, type BuildingGrid, type PopulationSpawner } from "@engine/world";
import { spawnPoints, GAMEPLAY_COMMANDS, ARMS_COMMANDS, DISEASE_COMMANDS, HOTBAR_COMMANDS, ARMS_EVENT_RELIABILITY, Exploded, Reloaded, VehicleStationOpened, installPartyCommands, PartyInvitePending, installClanCommands, ClanInvitePending, ClanStatus, syncSocialMembership, clanState, encodeClanState, decodeClanState, loadClanState, queueCommand, edgeCommands, spawnPlayer, spawnResourceNode, setSpawnPoints, spawnPoints as worldSpawnPoints, pickSpawnPoint, gameplayDefs, setIntent, IntentAction, nearestMeleeTarget, ResourceNode, PlayerIntent, registerGameplayCommands, installEconomy, installPopulation, installCustomization,
  appearanceServerHooks, applyReplication, installStallBuyHook, installViewBonus, setHitValidator, installPvp, installBedRespawn, installCraftQueue, installExpressionCommands, installVehicleCommands, installVehicleCraftCommands, installVehicleGuard, requestEmote, CraftQueue, CraftQueuesRes, playerNames, stallListing, listingRevision, stallOf, tillOf, StallHeader, StallOwnerKind, installMapMarkerCommands, MapMarker } from "@engine/gameplay";
import { AppearanceServer, ChatServer, NameSync, NetServer, StallResult, StallServer, TileSync, validateHit, type ClientSession, type ServerTransport, type StallHooks } from "@engine/net";
import { createAgentStore, type AgentIdentityStore } from "./agents.js";
import { AccountAssigned, ClaimAccount, SetName, WorldPersistence, loadSocial, tokenToHex, tokenToWords, wordsToName, wordsToToken, type WorldStore } from "@engine/persist";
import { giveRandomAppearance } from "./appearance.js";
export { botAppearance, giveBotAppearance } from "./appearance.js"; // ADR-252: AI humans' looks
import { SocialSync } from "./social_sync.js";
import { Act, applyDemoInput, installDemoWorld, rejectReasonCode, DevBotHello, DevPetKit, DEMO_COMMANDS, DEMO_EVENTS, ExplodedEvt, GAMEPLAY_NET_COMMANDS, Ping, Pong, ReloadedEvt, VehicleStationOpenedEvt, PetEventEvt, WorkerEventEvt, DeleteMyProgressCmd, DELETE_PROGRESS_CONFIRM, ProgressDeleted } from "./protocol.js";
import { forgetPlayer, sweepForgottenPlayers, installSkillHandlers, setAiHumanPredicate } from "@engine/gameplay";

/** Pre-ADR-107 worlds started at 0.25 of the day and did not persist the day-clock epoch. */
export const LEGACY_START_TIME_OF_DAY = 0.25;
/** Restore TimeOfDay.epochTick from save meta (ADR-107): the saved epoch, else the legacy 0.25 start. */
export function restoreDayClock(world: World, meta: { dayEpochTick?: number }): void {
  const tod = world.env(TimeOfDay);
  tod.epochTick = meta.dayEpochTick !== undefined && Number.isFinite(meta.dayEpochTick) ? meta.dayEpochTick : -Math.round(LEGACY_START_TIME_OF_DAY * tod.dayLengthTicks);
}
/** ADR-261: seasons were 3 in-game days before ADR-261; saves without seasonLengthDays used that length. */
export const LEGACY_SEASON_LENGTH_DAYS = 3;
/**
 * ADR-239: restore the season phase (Season.offsetDays) from save meta; older saves keep the install default.
 * ADR-261: lengthDays / blendDays always come from current defs (installGameplay). If the save was written under a
 * different season length, the offset is rescaled so the world stays in the same season at the same fraction through it.
 * Call after restoreDayClock; `meta.tick` is the saved tick (world.tick is not restored yet).
 */
export function restoreSeason(world: World, meta: { seasonOffsetDays?: number; seasonLengthDays?: number; tick?: number }): void {
  if (!world.isRegistered(Season) || !world.has(world.environment, Season)) return;
  if (meta.seasonOffsetDays === undefined || !Number.isFinite(meta.seasonOffsetDays)) return;
  const L = world.env(Season).lengthDays; const oldL = meta.seasonLengthDays ?? LEGACY_SEASON_LENGTH_DAYS;
  const tod = world.env(TimeOfDay);
  if (L > 0 && oldL > 0 && oldL !== L && tod.dayLengthTicks > 0) {
    const days = ((meta.tick ?? world.tick) - tod.epochTick) / tod.dayLengthTicks;
    const oldCycle = oldL * SEASON_COUNT; const ph = (((days + meta.seasonOffsetDays) % oldCycle) + oldCycle) % oldCycle;
    const idx = Math.min(SEASON_COUNT - 1, Math.floor(ph / oldL)); const frac = (ph - idx * oldL) / oldL;
    const cycle = L * SEASON_COUNT; const off = Math.floor(idx * L + frac * L) - Math.floor(days); // whole-day offset (i32) that stays inside season idx
    world.set(world.environment, Season, { offsetDays: ((off % cycle) + cycle) % cycle });
  } else world.set(world.environment, Season, { offsetDays: meta.seasonOffsetDays });
}
export const CLAN_BLOB = "gameplay.clans";
/** ProceduralGenerator node kinds -> gameplay resource keys (see DEFAULT_BANDS comments in @engine/world). */
const NODE_RESOURCES: Record<number, string> = { 1: "fallen_branches", 2: "fiber_grass", 3: "berry_bush", 4: "loose_rocks", 5: "tree", 6: "boulder", 7: "iron_vein" };
/** Legacy origin spawn (camera fallback only). Players and bots spawn at `spawnPoints(world)` (ADR-106). */
export const SPAWN = { x: 16, y: 16 };

export interface GameServerOptions {
  /** ADR-140 dev/QA sandbox: kit + shared spawn for every joiner (never on in normal play). */
  devSandbox?: boolean;
  transport: ServerTransport;
  /** Persistent store; omit for an in-memory, non-persistent world. */
  store?: WorldStore;
  /** Used only for a new world; a save keeps its own seed. */
  seed?: number;
  tickHz?: number;
  autosaveSeconds?: number;
  playerSaveSeconds?: number;
  loadRadius?: number;
  buildings?: BuildingGrid;
  log?: (msg: string) => void;
  /** Cosmetics catalog (@engine/assets CosmeticCatalog). Enables customization: Appearance net messages + gameplay commands. */
  catalog?: CosmeticCatalogLike;
  /** Give each joining client (players and bots) a random valid Appearance as a placeholder until they set their own look. */
  randomAppearance?: boolean;
  /**
   * Game mode. "singleplayer" (local.ts) enables human bots (virtual players); "multiplayer" (the Node server,
   * default) forcibly disables them - no bot table entry, no virtual-player joins. Animals + zombies spawn in both.
   */
  mode?: GameMode;
  /** Singleplayer only: the host that connects a virtual player (a loopback client driven by an AgentController). */
  virtualPlayers?: VirtualPlayerHost;
  /** Override the seed's four spawn points (tests / dev: e.g. [SPAWN] keeps every join co-located). */
  spawnPoints?: readonly { x: number; y: number }[];
  /** Ambient population (zombies, animals, bots via PopulationSpawner). Default true. */
  population?: boolean;
  /** ADR-110: animal spawn-cap multiplier (mobile / lowend local hosts). */
  animalCapMul?: number;
  /** Player cap (all sessions, incl. a P2P host's own client); extra joins get RejectReason.ServerFull + serverFullDetail. */
  maxClients?: number;
  serverFullDetail?: string;
  /** Dev load-test flag (NET_DEV_BOTS=1): accept DevBotHello-tagged connections in multiplayer. Default false. */
  devBots?: boolean;
  /** ADR-295: only room-code hosts opt in; resolve their own client id at join time. */
  joinNearClient?: () => number | undefined;
  /** Throttle deltas for distant owned entities (P2P mobile host bandwidth; ADR-102). */
  distantThrottle?: { nearTiles: number; interval: number };
  /** Chat (net ChatServer over core ChannelRegistry): local radius in tiles (default 48), per-player token bucket (default core 5 burst, 0.05/tick). */
  /** ADR-121 world rules for a NEW world (roaming hordes on/off, grace days); a save keeps its own. */
  worldRules?: WorldRulesOpts;
  chat?: { localRadius?: number; rate?: { capacity: number; refillPerTick: number }; maxLength?: number; /** chat replay ring on join (default 50; 0 = off) */ historySize?: number };
}
/** True when the dev bot flag is set in the environment (NET_DEV_BOTS=1). */
export const devBotsFromEnv = (env: Record<string, string | undefined>): boolean => env["NET_DEV_BOTS"] === "1";
export type GameMode = "singleplayer" | "multiplayer";
/** Resolved mode config: humanBots is true in singleplayer, and in multiplayer when AI humans are on (Task 22). */
export interface GameModeConfig { mode: GameMode; humanBots: boolean }
export function gameModeConfig(mode: GameMode = "multiplayer", wantBots = true, aiHumans = true): GameModeConfig { return { mode, humanBots: wantBots && (mode === "singleplayer" || aiHumans) }; }
/** Connects a virtual player whose server entity should appear at (x, y); returns false if it cannot. */
/** `kind` = the population entry's human_bot kind (e.g. a bots.json archetype); optional so older hosts still type-check. */
export interface VirtualPlayerHost { connect(x: number, y: number, kind?: string): boolean; disconnect(clientId: number): void }

/** claimed: ClaimAccount processed (saved record restored), so a held join-time look can no longer be overwritten by the restore. */
/** Records namespace of deleted account PlayerIds (ADR-099). */
export const DELETED_PLAYER_NS = "deletedPlayer";
/** Ticks between ProgressDeleted and dropping the connection (the client reconnects itself first). */
const DELETE_KICK_TICKS = 40;
interface Player { entity: Entity; account: string; name: string; claimed: boolean; /** virtual player (singleplayer human bot) */ bot?: boolean }

/** Alias kept for the menu/client code. */
export type ServerMode = GameMode;
export interface GameServer {
  /** "singleplayer" | "multiplayer" (see modeConfig for derived flags). */
  readonly mode: GameMode;
  world: World; net: NetServer; chunks: ChunkManager; persist: WorldPersistence | undefined; loop: FixedLoop;
  /** Core permissions resource: GroupRegistry (parties/clans), ClaimRegistry, policy. Saved with the world. */
  permissions: PermissionsRes;
  players: ReadonlyMap<number, Player>;
  /** Resolved mode flags: humanBots in singleplayer, and in multiplayer when AI humans are on (Task 22). */
  modeConfig: GameModeConfig;
  /** The world's four spawn points (deterministic per seed, ADR-106). */
  spawnPoints: { x: number; y: number }[];
  /** Ambient population spawner (undefined with population: false). */
  population: PopulationSpawner | undefined;
  /** Singleplayer host: mark a joined session as a virtual player (false = refused, e.g. multiplayer). */
  markVirtual(clientId: number): boolean;
  stalls: StallServer; appearance: AppearanceServer | undefined;
  /** Local/party/clan/global/whisper chat with mentions + emotes; players and bots (loopback clients) both go through it. */
  chat: ChatServer;
  /** Persistent bot identities (relationship, party / clan memory): get / put / onChange; saved in the store's "agents" records. */
  agents: AgentIdentityStore;
  /** Wall-clock ms of recent world.step calls (filled by the host loop via step()). */
  step(dt: number): void;
  tickTimes: number[];
  /** Graceful shutdown: full save, close the store. Does not close the transport. */
  shutdown(): Promise<{ chunks: number; players: number }>;
}

export function createGameServer(o: GameServerOptions): GameServer {
  const log = o.log ?? (() => {});
  const tickHz = o.tickHz ?? DEFAULT_TICK_HZ;
  const meta = o.store?.readMeta();
  const seed = meta?.seed ?? o.seed ?? 1234;
  const world = new World({ seed, maxEntities: 1 << 18 });
  // Saved parties/clans/claims (throws on a corrupt record rather than starting empty and overwriting it).
  const permissions = installDemoWorld(world, "server", { tickHz, ...(o.store ? { social: loadSocial(o.store) } : {}) });
  // ADR-107: restore the saved day clock (meta.dayEpochTick); pre-ADR-107 saves fall back to their 0.25 start.
  if (meta) { restoreDayClock(world, meta); restoreSeason(world, meta); }
  // ADR-121: horde rules belong to the save. ADR-258: explicit host AI policy overrides its saved default.
  setWorldRules(world, { ...o.worldRules, ...(meta?.hordes !== undefined ? { hordes: meta.hordes === 1 } : {}), ...(meta?.hordeGraceDays !== undefined ? { hordeGraceDays: meta.hordeGraceDays } : {}), ...(meta?.aiHumans !== undefined && o.worldRules?.aiHumans === undefined ? { aiHumans: meta.aiHumans === 1 } : {}) });
  if (meta) { world.tick = meta.tick; if (meta.schemaHash !== world.getSchemaHash()) log(`persist: save schema ${meta.schemaHash.toString(16)} != build ${world.getSchemaHash().toString(16)}; chunks with changed persistent components load read-only`); }
  // Clan rank masks / goals / contributions (gameplay ClanState) persist as the world blob "gameplay.clans", written on change.
  { const b = o.store?.readBlob(CLAN_BLOB); if (b) { try { loadClanState(world, decodeClanState(b.bytes)); } catch (e) { log(`persist: clan state unreadable: ${String(e)}`); } } }
  if (o.store) { const store = o.store; clanState(world).onChange = () => { if (closing) return; void store.write({ blobs: [{ key: CLAN_BLOB, format: 1, bytes: encodeClanState(clanState(world)), tick: world.tick }] }).catch((e) => log(`persist: clan save failed: ${String(e)}`)); }; }
  const generator = new ProceduralGenerator({ seed });
  // Four far-apart starter-biome spawn points, deterministic per seed (ADR-106).
  setSpawnPoints(world, o.spawnPoints?.length ? o.spawnPoints : computeSpawnPoints(generator));
  const persist = o.store ? new WorldPersistence({
    world, store: o.store, generator, tickHz, log,
    ...(o.buildings ? { buildings: o.buildings } : {}),
    autosaveSeconds: o.autosaveSeconds ?? 30, playerSaveSeconds: o.playerSaveSeconds ?? 60,
    player: { exclude: [PlayerIntent] },
    // ADR-134: stored chunks keep their own (possibly depleted/relocated) nodes; only pre-persistence rows regenerate.
    regenerateNodes: (w, ents) => !ents.some((e) => w.has(e, ResourceNode) || w.has(e, NodeRegrow)),
    social: permissions,
    extraMeta: () => { const r = worldRules(world); return { hordes: r.hordes ? 1 : 0, hordeGraceDays: r.hordeGraceDays, aiHumans: r.aiHumans ? 1 : 0 }; },
    ...(o.catalog ? { appearance: { catalog: o.catalog } } : {}),
  }) : undefined;
  let localPlayerIds = 1; // no store: ids only need to be unique for this run
  const loadRadius = o.loadRadius ?? 2;
  const chunks = new ChunkManager({ provider: persist?.provider ?? generator, loadRadius, unloadMargin: 1, cacheSize: 64, maxLoadsPerUpdate: 4, maxLoadTimeMs: 2 });
  const defs = gameplayDefs(world);
  const resIds = new Map<number, number>();
  for (const [kind, key] of Object.entries(NODE_RESOURCES)) { try { resIds.set(Number(kind), defs.resourceId(key)); } catch { /* resource renamed: skip */ } }
  chunks.onLoad((_c, nodes) => { for (const n of nodes) { const id = resIds.get(n.kind); if (id !== undefined) spawnResourceNode(world, id, n.tx + 0.5, n.ty + 0.5); } });

  const mode = gameModeConfig(o.mode ?? "multiplayer", !!o.virtualPlayers, worldRules(world).aiHumans);
  const players = new Map<number, Player>();
  let petCorner = false; // ADR-145 sandbox pet corner placed
  // Spawn points chosen by the population spawner for virtual players still connecting. Always empty in multiplayer.
  const pendingSpots: { x: number; y: number }[] = [];
  const agents = createAgentStore(o.store, { tick: () => world.tick, log });
  let closing = false; // after shutdown() the save is final: disconnects no longer write
  const removeEntity = (e: Entity): void => { if (world.isAlive(e)) world.destroy(e); };

  const net: NetServer = new NetServer({
    world, tickHz, transport: o.transport,
    ...(o.maxClients !== undefined ? { maxClients: o.maxClients } : {}), ...(o.serverFullDetail ? { serverFullDetail: o.serverFullDetail } : {}),
    ...(o.distantThrottle ? { distantThrottle: o.distantThrottle } : {}),
    commands: DEMO_COMMANDS, events: DEMO_EVENTS,
    hashesIfSent: cosmeticsHashes(o.catalog), // ADR-245: a client with a different skin palette / wearables is rejected ("cosmetics")
    forwardCoreRejections: false, // forwarded below with the net command def + a reason code (protocol.ts)
    applyInput: (w, e, cmd, clientId) => {
      if (cmd && players.get(clientId)?.entity === e) { // ADR-244 stance (before movement: a move input wakes a sleeper first)
        const b = cmd.edges ?? 0;
        applyStanceInput(w, e, { guard: !!(cmd.buttons & Act.Guard), crouch: !!(cmd.buttons & Act.Crouch), carry: !!(b & GameplayEdgeBits.Carry), rest: !!(b & GameplayEdgeBits.Rest), interact: !!(cmd.buttons & Act.Gather),
          active: !!(cmd.buttons & (Act.MoveUp | Act.MoveDown | Act.MoveLeft | Act.MoveRight | Act.Sprint | Act.Gather | Act.Attack)) || Math.hypot(cmd.moveX ?? 0, cmd.moveY ?? 0) > 0.3 || !!(b & ~(GameplayEdgeBits.Carry | GameplayEdgeBits.Rest)) });
      }
      applyDemoInput(w, e, cmd, 1 / tickHz); // riders: drive input (only the seat-0 driver steers, gameplay.vehicles)
      // ADR-180: edge pulses (exactly-once per seq) -> the same input-queue commands their net command twins use (Hotbar1..8 equip, Reload)
      if (cmd?.edges && players.get(clientId)?.entity === e) for (const c of edgeCommands(cmd.edges, w, e)) queueCommand(w, e, handlers.registry, handlers.registry.make(c.def, c.values as never));
      if (cmd && (cmd.buttons & (Act.Gather | Act.Attack)) && players.get(clientId)?.entity === e && !stanceBlocksActions(w, e)) { // ADR-244: no attack / gather while carrying or asleep
        // Hand/interact is never combat. Only the dedicated primary/attack control may strike.
        const foe = (cmd.buttons & Act.Attack) && !(cmd.buttons & Act.Gather) ? nearestMeleeTarget(w, e) : undefined;
        if (foe !== undefined) setIntent(w, e, { action: IntentAction.Attack, target: foe });
        else {
          // ADR-160: bare-handed loot: a loot bag in reach that is closer than any node opens instead of gathering
          const target = nearestNode(e); const nt = target !== undefined ? w.get(target, Transform) : undefined; const et = w.get(e, Transform);
          const bag = handLootTarget(w, e, nt && et ? Math.hypot(nt.x - et.x, nt.y - et.y) : Infinity);
          if (bag !== undefined) { if (!w.has(e, Viewing) || w.getField(e, Viewing, "container") !== bag) setIntent(w, e, { action: IntentAction.OpenContainer, target: bag }); }
          else if (target !== undefined) setIntent(w, e, { action: IntentAction.Gather, target });
        }
      }
    },
    onClientJoin: (s, w) => {
      const at0 = pickSpawnPoint(w, "join", s.clientId); // least crowded of the 4 (+ jitter)
      const hostId = o.joinNearClient?.(), friend = hostId !== undefined && hostId !== s.clientId ? players.get(hostId)?.entity : undefined;
      const near = friend !== undefined ? friendSpawn(w, friend) : undefined;
      const at = near ?? (o.devSandbox ? sandboxSpawn(spawnPoints(w)[0] ?? at0, s.clientId) : at0);
      const e = spawnPlayer(w, { x: at.x, y: at.y, clientId: s.clientId });
      if (near) w.set(e, Transform, { z: near.z }); // saved-account restore below still wins
      // Task 14: vitals/disease/pet-hunger/spoilage freeze until this client sends gameplay.ready (or is a bot, see markVirtual)
      if (!w.has(e, PlayerReady)) w.add(e, PlayerReady, { ready: 0 });
      if (o.devSandbox) log(`sandbox kit: ${giveSandboxKit(w, e).length} items`);
      if (o.devSandbox && !petCorner) { petCorner = true; sandboxPetCorner(w, spawnPoints(w)[0] ?? at0); }
      net.netIds.assign(e);
      // random valid look (replicates; a restored player record or the client's own setAppearance replaces it)
      if (o.catalog && o.randomAppearance) giveRandomAppearance(w, e, o.catalog, Math.random);
      const account = tokenToHex(s.token); // provisional account = net session token until the client claims one
      players.set(s.clientId, { entity: e, account, name: "", claimed: false });
      persist?.trackPlayer(account, e);
      log(`join: client ${s.clientId}`);
    },
    onClientLeave: (s) => leave(s.clientId, "disconnect"),
  });

  applyReplication(net);
  net.setScope(PartyInvitePending, "owner"); // pending party invite: only the invitee sees it
  // ClanStatus carries the goal / raid target: only the owner and same-clan viewers receive it (Netcode review of 2897f2b)
  net.setScope(ClanStatus, (w, e, clientId) => {
    if (w.getField(e, Owner, "clientId") === clientId) return true;
    const clan = w.getField(e, ClanStatus, "clan") ?? 0; const viewer = players.get(clientId)?.entity;
    return clan !== 0 && viewer !== undefined && w.has(viewer, ClanStatus) && w.getField(viewer, ClanStatus, "clan") === clan;
  });
  net.setScope(ClanInvitePending, "owner"); // pending clan invite: only the invitee sees it
  net.setScope(CraftQueue, "owner"); // queued crafting: networked + persistent, progress only to its owner
  // Gameplay commands: core handlers (economy + customization) fed by the net mirrors from protocol.ts.
  const handlers = installCommandHandlers(world, registerGameplayCommands());
  installEconomy(world, handlers);
  installPvp(world, handlers); // gameplay.respawnPlayer
  installBedRespawn(world); // ADR-153: respawn beside your bed, else a world spawn point
  installCraftQueue(world, handlers); // gameplay.queueCraft / cancelQueuedCraft (server-only timers)
  installExpressionCommands(world, handlers); // gameplay.emote -> Expression
  installVehicleCommands(world, handlers); // gameplay.vehicle* (enter/exit/hitch/unhitch/station), ADR-096
  installVehicleCraftCommands(world, handlers);
  installRoadCommands(world, handlers); // gameplay.placeRoad / removeRoad (ADR-119)
  installTerrainCommands(world, handlers); // gameplay.terrain shovel raise / lower (ADR-263)
  installInventoryOpCommands(world, handlers); // gameplay.splitStack / moveSlot (ADR-204)
  installPetCommands(world, handlers); // gameplay.petOffer / petCommand / petRename / dropItem (ADR-145)
  installAnimalSkillCommands(world, handlers); // gameplay.animalSkill (Task 15)
  installWorkerCommands(world, handlers); // gameplay.hireWorker / setWorkerJob / dismissWorker (Task 22)
  installDyeCommands(world, handlers); // gameplay.dye — hair / worn / held (Task 25)
  installReadyCommands(world, handlers); // Task 14: gameplay.ready — client finished loading
  installSignCommands(world, handlers); // gameplay.placeSign / setSignText / removeSign (ADR-120) // gameplay.vehicleDeploy / vehicleRefuel / vehicleRepair (gameplay DESIGN.md §31)
  // ADR-102: server vehicle speed/teleport sanity (reverts the step) -> anomaly on the driver's session (AntiCheat scores it)
  installVehicleGuard(world, (v) => {
    const cid = v.driver !== undefined ? world.getField(v.driver, Owner, "clientId") : undefined; if (cid === undefined) return;
    for (const s of net.connected()) if (s.clientId === cid) { net.anomaly(s, v.kind, `vehicle ${v.distance.toFixed(2)} tiles`); break; }
  });
  installClanCommands(world, handlers); // gameplay.clan* on core GroupRegistry (GroupKind.Clan) + gameplay ClanState
  installPartyCommands(world, handlers); // gameplay.partyInvite / partyAccept / partyLeave / partyKick on core GroupRegistry
  installMapMarkerCommands(world, handlers); // gameplay.placeMapMarker / removeMapMarker (world-map markers)
  // Map markers must replicate regardless of AOI: a marker for a far-away location has to show on the world map
  // even when the player is nowhere near it. Flagging is idempotent and cheap (markers are few).
  net.onTick(() => { if (world.isRegistered(MapMarker)) for (const e of world.query([MapMarker])) net.setGlobal(e); });
  const rearmCrafts = (): void => world.resource(CraftQueuesRes).rearmAll(); // timers are not saved: re-arm after any load
  // Melee hits from players are re-checked with lag compensation (target rewound to what the attacker saw).
  setHitValidator(world, (attacker, target, check) => {
    let s: ClientSession | undefined; for (const [cid, p] of players) if (p.entity === attacker) { s = net.sessions.get(cid); break; }
    if (!s) return undefined; // not a connected player: nothing to rewind against
    const r = validateHit(net, s, attacker, target, { reach: check.reach, coneDeg: check.coneDeg });
    return r.ok ? undefined : r.reason;
  });
  // Watchtower sight: gameplay computes per-client chunk bonus; net caps it and applies hysteresis.
  installViewBonus(world, (c, n) => net.setViewRadiusBonus(c, n));
  if (o.catalog) installCustomization(world, { catalog: o.catalog, handlers });
  installSkillHandlers(world, handlers); // ADR-113
  let cmdSeq = 0;
  const INPUT_QUEUE = new Set([...GAMEPLAY_COMMANDS, ...ARMS_COMMANDS, ...DISEASE_COMMANDS, ...HOTBAR_COMMANDS].map(([d]) => d.name));
  const netDefOf = new Map<number, (typeof GAMEPLAY_NET_COMMANDS)[number]["net"]>(); // core command type -> net mirror
  for (const { core, net: def } of GAMEPLAY_NET_COMMANDS) {
    if (!o.catalog && (core.name === "gameplay.setAppearance" || core.name === "gameplay.equipCosmetic")) continue; // no catalog: unhandled
    const type = handlers.registry.register(core); netDefOf.set(type, def);
    net.onCommand(def, (s, payload) => {
      const p = players.get(s.clientId); if (!p || !world.isAlive(p.entity)) return;
      // Input-queue commands (gameplay.use / gameplay.place) have no core handler: they join the player's intent queue like an InputFrame command.
      if (INPUT_QUEUE.has(core.name)) { queueCommand(world, p.entity, handlers.registry, { type, values: payload as never }); return; }
      handlers.enqueue(p.entity, s.clientId, cmdSeq++, { type, values: payload as never });
    });
  }
  // Arms events -> clients. Exploded: every client whose AOI covers a chunk the blast circle touches. Reloaded: owner only.
  world.events.on(Exploded, (ev: { entity: Entity; item: number; owner: Entity; x: number; y: number; radius: number }) => {
    const rel = (ARMS_EVENT_RELIABILITY["gameplay.Exploded"] as string) === "reliable"; const payload = { entity: ev.entity, item: ev.item, owner: ev.owner, x: ev.x, y: ev.y, radius: ev.radius };
    const clients: number[] = [];
    for (const cid of net.sessions.keys()) {
      const chunks = net.relevantChunks(cid); if (!chunks) { clients.push(cid); continue; }
      if (circleTouches(chunks, ev.x, ev.y, ev.radius)) clients.push(cid);
    }
    if (clients.length) net.emitEvent(ExplodedEvt, payload, { reliable: rel, scope: { clients } });
  });
  world.events.on(Reloaded, (ev: { entity: Entity; item: number; ammo: number; rounds: number }) => {
    for (const [cid, p] of players) if (p.entity === ev.entity) { net.emitEvent(ReloadedEvt, { entity: ev.entity, item: ev.item, ammo: ev.ammo, rounds: ev.rounds }, { reliable: (ARMS_EVENT_RELIABILITY["gameplay.Reloaded"] as string) === "reliable", scope: { owner: cid } }); break; }
  });
  world.events.on(PetEvent, (ev: { entity: Entity; pet: Entity; result: number; value: number }) => { // ADR-145
    for (const [cid, p] of players) if (p.entity === ev.entity) { net.emitEvent(PetEventEvt, { pet: ev.pet, result: ev.result, value: ev.value }, { reliable: true, scope: { owner: cid } }); break; }
  });
  world.events.on(WorkerEvent, (ev: { entity: Entity; worker: Entity; result: number; value: number }) => { // Task 22
    for (const [cid, p] of players) if (p.entity === ev.entity) { net.emitEvent(WorkerEventEvt, { worker: ev.worker, result: ev.result, value: ev.value }, { reliable: true, scope: { owner: cid } }); break; }
  });
  world.events.on(VehicleStationOpened, (ev: { entity: Entity; vehicle: Entity; station: number; kind: number }) => {
    for (const [cid, p] of players) if (p.entity === ev.entity) { net.emitEvent(VehicleStationOpenedEvt, { vehicle: ev.vehicle, station: ev.station, kind: ev.kind }, { reliable: true, scope: { owner: cid } }); break; }
  });
  // Delete my progress (ADR-099): validated like every gameplay command (also bots' ADR-092 path, which is refused);
  // only ever acts on the sender's own account. Forgotten PlayerIds persist as "deletedPlayer" records so stalls /
  // buildings in chunks that stream in later are unowned too (sweep below).
  const deleting = new Set<string>(); // accounts whose row was deleted: never saved again by this connection
  const pendingKicks = new Map<number, number>(); // clientId -> tick to drop the connection (after ProgressDeleted flushes)
  const forgotten = new Set<number>(o.store?.listRecords(DELETED_PLAYER_NS).map((r) => Number(r.id)).filter((n) => n > 0) ?? []);
  handlers.on(DeleteMyProgressCmd, {
    validate: (v, c) => {
      const p = players.get(c.clientId); if (!p || p.entity !== c.actor) return "no_actor";
      if (p.bot) return "not_allowed"; if (!p.claimed) return "not_claimed"; if (v.confirm !== DELETE_PROGRESS_CONFIRM) return "bad_confirm";
      return undefined;
    },
    handle: (_v, c) => deleteProgress(c.clientId),
  });
  function deleteProgress(clientId: number): void {
    const p = players.get(clientId); if (!p || deleting.has(p.account)) return;
    const id = world.getField(p.entity, PlayerId, "id") ?? 0;
    const r = forgetPlayer(world, id); if (id) forgotten.add(id);
    deleting.add(p.account); persist?.untrackPlayer(p.account);
    void o.store?.write({ deletePlayers: [p.account], ...(id ? { records: [{ ns: DELETED_PLAYER_NS, id: String(id), format: 1, bytes: new Uint8Array(0), tick: world.tick, ownerKind: 0, ownerId: 0, chunk: "" as const }] } : {}) })
      .catch((e) => log(`persist: delete progress failed: ${String(e)}`));
    net.emitEvent(ProgressDeleted, { ok: 1 }, { scope: { owner: clientId } });
    pendingKicks.set(clientId, world.tick + DELETE_KICK_TICKS);
    log(`delete progress: client ${clientId} account ${p.account.slice(0, 8)}… player ${id} (party ${r.party ? "left" : "-"}, clan ${r.clan ? "left" : "-"}, ${r.stalls} stalls, ${r.structures} buildings unowned)`);
  }
  world.addSystem("postSim", "server.deleteProgress", () => {
    for (const [cid, t] of pendingKicks) if (world.tick >= t) leave(cid, "progress deleted");
    if (forgotten.size && world.tick % 100 === 0) sweepForgottenPlayers(world, forgotten);
  });
  // Gameplay rejections -> the issuing client (client.onCommandRejected / onGameplayRejected): net command + reason code + text.
  world.events.on(CommandRejected, (r) => {
    if (!net.sessions.get(r.clientId)?.conn) return;
    const def = netDefOf.get(r.type); net.rejectCommand(r.clientId, def ?? r.type, rejectReasonCode(r.reason), r.reason);
  });
  // Stall raw protocol (client.stalls): gameplay owns the purchase via the buy hook; owner ops go through the commands above.
  const stallHooks: StallHooks = {
    view: (w, target) => {
      const st = stallOf(w, target); const h = st !== undefined ? w.get(st, StallHeader) : undefined; if (st === undefined || !h) return undefined;
      return {
        open: h.open === 1, ownerKind: h.ownerKind, ownerId: h.ownerId, revision: listingRevision(w, st), stock: st, till: tillOf(w, st) ?? st,
        listing: (id) => { const l = stallListing(w, st, id); return l && l.enabled ? { listingId: id, slot: id, item: l.stockItem, count: l.stock, durability: 0, crafterId: 0, price: { itemId: l.priceItem, count: l.priceCount } } : undefined; },
      };
    },
    canManage: () => false, owner: () => StallResult.Denied, sold: () => {},
    saleRecipients: (_w, _st, v) => (v.ownerKind === StallOwnerKind.Player ? [v.ownerId] : []),
  };
  const names = playerNames(world);
  const nameSync = new NameSync(net, { names }); // crafter/buyer names for sale notifications + client.names
  const stalls = new StallServer(net, { hooks: stallHooks, names: nameSync, playerIdOf: (s) => { const e = players.get(s.clientId)?.entity; return (e !== undefined && world.getField(e, PlayerId, "id")) || 0; } });
  installStallBuyHook(stalls);
  // The buyer gets the sale record too (crafter provenance + names), unless they are also the recipient owner.
  stalls.saleLog.push((sale, st) => { const v = stallHooks.view(world, st); if (sale.buyerId && !(v && stallHooks.saleRecipients(world, st, v).includes(sale.buyerId))) stalls.notify(sale, [sale.buyerId]); });
  const appearance = o.catalog ? new AppearanceServer(net, {
    catalog: o.catalog,
    // The join-time look is held (AppearanceServer pending) until the account is claimed, then applied with initial=true:
    // a new player has no created look, so gameplay's first-join rule passes; a returning player's restored look wins.
    entityOf: (s) => { const p = players.get(s.clientId); return p?.claimed ? p.entity : undefined; },
    ...appearanceServerHooks(world, (e) => {
      for (const p of players.values()) if (p.entity === e && persist && !closing && !deleting.has(p.account)) { void persist.savePlayer(p.account, e, p.name).catch((x) => log(`persist: save failed ${String(x)}`)); break; }
    }),
  }) : undefined;

  // Clan roster (owner-scoped, members only) + online-player directory: see social_sync.ts.
  new SocialSync({ net, world, groups: permissions.groups, names: nameSync, claimed: function* () { for (const [c, p] of players) if (p.claimed) yield [c, p.entity] as [number, Entity]; } });
  new TileSync(net, { tiles: chunks }); // tile replication: full chunks on AOI entry + per-tick deltas (sole tileChanges() drainer)

  function leave(clientId: number, why: string): void {
    const p = players.get(clientId); if (!p) return;
    players.delete(clientId); chunks.removeSource(clientId); pendingKicks.delete(clientId);
    if (deleting.delete(p.account)) persist?.untrackPlayer(p.account); // progress deleted (ADR-099): never re-save it
    else if (persist && !closing) { void persist.savePlayer(p.account, p.entity, p.name).catch((e) => log(`persist: save failed ${String(e)}`)); persist.untrackPlayer(p.account); }
    removeEntity(p.entity);
    // Forget the net session: identity across reconnects/restarts is the persistent account (ClaimAccount).
    net.removeSession(clientId);
    log(`leave: client ${clientId} (${why})${p.name ? ` "${p.name}"` : ""}`);
  }

  const chat = new ChatServer(net, {
    channels: new ChannelRegistry(permissions.groups, undefined, o.chat?.rate ?? { capacity: 5, refillPerTick: 0.05 }),
    localRadius: o.chat?.localRadius ?? 48, historySize: o.chat?.historySize ?? 50, ...(o.chat?.maxLength ? { maxLength: o.chat.maxLength } : {}),
    // account PlayerId (what parties/clans are keyed by); 0 until claimed would collide, so fall back to a negative-free offset
    playerIdOf: (s) => { const p = players.get(s.clientId); const id = p ? world.getField(p.entity, PlayerId, "id") ?? 0 : 0; return id || 0x40000000 + s.clientId; },
    // parties/clans live in the core GroupRegistry keyed by account PlayerId
    groupOf: (s, kind) => { const p = players.get(s.clientId); const id = p ? world.getField(p.entity, PlayerId, "id") ?? 0 : 0; return id ? permissions.groups.groupsOf(id).find((g) => g.kind === (kind === "party" ? 1 : 2))?.id : undefined; },
  });
  // Chat emotes drive the face like EmoteCmd: ChatDelivered.emote = emoteNames() index + 1 (requestEmote range-checks it).
  chat.log.push((d) => { if (!d.emote) return; const p = players.get(d.fromClient); if (p && world.isAlive(p.entity)) requestEmote(world, p.entity, d.emote); });
  net.onCommand(DevPetKit, (s) => { const p = players.get(s.clientId); if (o.devSandbox && p && world.isAlive(p.entity)) sandboxPetKit(world, p.entity); });
  net.onCommand(DevBotHello, (s) => {
    const p = players.get(s.clientId); if (!p) return;
    if (mode.mode === "multiplayer" && !o.devBots) { leave(s.clientId, "bot connection rejected: multiplayer server without NET_DEV_BOTS=1"); return; }
    p.bot = true;
  });
  net.onCommand(ClaimAccount, (s, payload) => {
    const p = players.get(s.clientId); if (!p) return;
    const zero = !payload.t0 && !payload.t1 && !payload.t2 && !payload.t3;
    let restored = 0;
    if (!zero) {
      const token = wordsToToken(payload);
      if (token !== p.account) {
        for (const [cid, other] of players) if (cid !== s.clientId && other.account === token) leave(cid, "account taken over by a new connection");
        persist?.untrackPlayer(p.account); p.account = token;
        const r = persist?.restorePlayer(token, p.entity);
        if (r) { restored = 1; rearmCrafts(); if (r.name && !p.name) p.name = r.name; log(`restore: client ${s.clientId} account ${token.slice(0, 8)}… (${r.restored.length} components${r.skipped.length ? `, skipped ${r.skipped.join(",")}` : ""})`); }
        persist?.trackPlayer(token, p.entity, p.name);
      }
    }
    assignIdentity(p.entity); p.claimed = true;
    if (p.name) names.set(world.getField(p.entity, PlayerId, "id")!, p.name);
    net.emitEvent(AccountAssigned, { ...tokenToWords(p.account), restored }, { scope: { owner: s.clientId } });
    chat.replay(s); // recent global + own party/clan/whisper lines (ChatServer.replay)
  });
  /** Account PlayerId (restored from the player record, else newly allocated) + Membership mirrored from the registry. */
  function assignIdentity(e: Entity): void {
    let id = world.getField(e, PlayerId, "id") ?? 0;
    if (!id) { id = persist ? persist.allocatePlayerId() : localPlayerIds++; if (world.has(e, PlayerId)) world.setField(e, PlayerId, "id", id); else world.add(e, PlayerId, { id }); }
    syncSocialMembership(world, e); // Membership + ClanStatus + clan base Tribe from the registry
  }
  net.onCommand(SetName, (s, payload) => {
    const p = players.get(s.clientId); if (!p) return;
    p.name = wordsToName(payload).replace(/[<>\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 20); persist?.trackPlayer(p.account, p.entity, p.name);
    const id = world.getField(p.entity, PlayerId, "id"); if (id) names.set(id, p.name);
  });
  net.onCommand(Ping, (s, payload) => net.emitEvent(Pong, { t: payload.t }, { scope: { owner: s.clientId } }));

  /** Nearest resource node within reach, from chunk membership (O(entities in 3x3 chunks)). */
  function nearestNode(e: Entity): Entity | undefined {
    const t = world.get(e, Transform); if (!t) return undefined;
    let best: Entity | undefined, bd = 2.25 * 2.25;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const set = persist ? persist.membership.entitiesIn(chunkKeyOf(t.x + dx * 32, t.y + dy * 32)) : undefined;
      for (const n of set ?? world.query([ResourceNode, Transform])) {
        if (!world.has(n, ResourceNode)) continue; const nt = world.get(n, Transform)!;
        const d = (nt.x - t.x) ** 2 + (nt.y - t.y) ** 2; if (d < bd) { bd = d; best = n; }
      }
      if (!persist) return best; // full scan done once
    }
    return best;
  }

  // Streaming: players are the interest sources. Runs before persist.track (registered by attach below).
  world.addSystem("postSim", "server.chunks", () => {
    // A watchtower's AOI bonus widens streaming too, so the extra chunks exist to be sent.
    for (const [cid, p] of players) { const t = world.get(p.entity, Transform); if (t) chunks.setSource({ id: cid, x: t.x, y: t.y, radius: loadRadius + net.viewRadiusBonus(cid) }); }
    chunks.update();
  });
  persist?.attach(chunks);
  // ADR-176/178: the authority's TerrainRes reads ChunkManager. It was never set, so every TerrainRes user silently fell
  // back to "no terrain": drinking (ADR-176), swim speed + Swim anim, water collision, zombie/animal pathing, horde
  // spawn checks, build slope/water validation.
  world.setResource(TerrainRes, terrainFromTileMap(chunks));
  // ADR-135: AI humans are virtual players; kill XP pays the aiHuman rate for them (not the PvP rate + anti-farming)
  setAiHumanPredicate(world, (e) => { for (const p of players.values()) if (p.entity === e) return !!p.bot; return false; });
  // Ambient population: zombies + animals everywhere; human bots in singleplayer, and in multiplayer when AI humans are on (Task 22).
  const population = o.population === false ? undefined : installPopulation(world, {
    tickHz, ...(o.animalCapMul !== undefined ? { animalCapMul: o.animalCapMul } : {}),
    chunks: () => chunks.activeKeys,
    tileAt: (tx, ty) => chunks.getTile(tx, ty),
    viewpoints: () => { const v: { x: number; y: number }[] = []; for (const p of players.values()) { if (p.bot) continue; const t = world.get(p.entity, Transform); if (t) v.push({ x: t.x, y: t.y }); } return v; },
    ...(o.buildings ? { buildings: o.buildings } : {}),
    humanBots: mode.humanBots && o.virtualPlayers ? {
      // human bots start at the least crowded world spawn point (ADR-106), not where the spawner rolled
      spawn: (_x, _y, kind?: string) => { const { x, y } = pickSpawnPoint(world, "bot", pendingSpots.length); pendingSpots.push({ x, y }); if (kind !== undefined ? o.virtualPlayers!.connect(x, y, kind) : o.virtualPlayers!.connect(x, y)) return true; pendingSpots.pop(); return false; },
      despawn: (e) => { for (const [cid, p] of players) if (p.entity === e && p.bot) { o.virtualPlayers!.disconnect(cid); leave(cid, "bot despawned"); break; } },
    } : undefined,
    // bots placed at a far spawn point must not be culled for being out of the player's view
    persistent: (e) => { for (const p of players.values()) if (p.entity === e) return !!p.bot; return false; },
  });
  /**
   * Singleplayer host marks a joined session as a virtual player: it is placed at the spawner's chosen point and
   * tracked as population. Refused (false) when human bots are off for this mode (multiplayer with AI humans off).
   */
  const markVirtual = (clientId: number): boolean => {
    const p = players.get(clientId); if (!mode.humanBots || !p || p.bot) return false;
    p.bot = true; markReady(world, p.entity); // bots perceive the authoritative world directly: never "loading"
    const spot = pendingSpots.shift();
    if (spot) { world.setField(p.entity, Transform, "x", spot.x); world.setField(p.entity, Transform, "y", spot.y); }
    population?.adopt(p.entity, "human_bot"); return true;
  };
  // keep the spawn points warm (source ids -1..-4 never collide with client ids)
  worldSpawnPoints(world).forEach((p, i) => chunks.setSource({ id: -1 - i, x: p.x, y: p.y, radius: 1 }));
  // Load the spawn area before the first tick. Only spin on *queued* loads: an async provider (IndexedDB save) returns
  // Promises that settle on a later microtask, so waiting for in-flight loads here would never end (the "continue a
  // saved game -> blank light-blue world" hang: the worker/tab locked up in this loop). Those chunks install on their
  // own when the reads resolve (ChunkManager .then -> install); the tick loop's chunks.update() keeps streaming.
  for (let guard = 0; guard < 10_000; guard++) { chunks.update(); if (chunks.pendingLoads - chunks.inflightLoads <= 0) break; }
  rearmCrafts();

  const tickTimes: number[] = [];
  const step = (dt: number): void => { const t0 = performance.now(); world.step(dt); tickTimes.push(performance.now() - t0); if (tickTimes.length > 4096) tickTimes.splice(0, 2048); };
  const loop = new FixedLoop({ tickHz, step });
  return {
    world, net, chunks, persist, loop, permissions, players, spawnPoints: worldSpawnPoints(world), mode: mode.mode, modeConfig: mode, population, markVirtual, stalls, appearance, chat, agents, step, tickTimes,
    async shutdown() {
      if (!persist || closing) return { chunks: 0, players: 0 };
      await agents.flush();
      const r = await persist.saveAll(); closing = true; await persist.store.close(); return r;
    },
  };
}
export type { ClientSession };

/** Does the circle (x, y, r) intersect any of these "cx,cy" chunk squares? Exact circle-vs-rect test per chunk. */
function circleTouches(chunks: ReadonlySet<string>, x: number, y: number, r: number): boolean {
  for (const k of chunks) {
    const c = k.indexOf(","); const x0 = Number(k.slice(0, c)) * CHUNK_SIZE, y0 = Number(k.slice(c + 1)) * CHUNK_SIZE;
    const dx = x - Math.max(x0, Math.min(x, x0 + CHUNK_SIZE)), dy = y - Math.max(y0, Math.min(y, y0 + CHUNK_SIZE));
    if (dx * dx + dy * dy <= r * r) return true;
  }
  return false;
}
