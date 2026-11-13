import { registerNetIds } from "./netid.js";
import * as core from "@engine/core";
import { ENV_NET_ID, NetId, Owner, Transform, entityIndex, type ComponentDef, type Entity, type World , CommandRejected } from "@engine/core";
import { BitReader, BitWriter } from "./bits.js";
import { writeUtf8 } from "./utf8.js";
import { StaticServer, StaticSession, readChunkKey, type ReplicationClass } from "./static.js";
import { NetInterest, type InterestOptions, type Viewpoint } from "./interest.js";
import { CHUNK_SIZE as CHUNK } from "@engine/world";
import { PositionHistory } from "./lagcomp.js";
import { DEFAULT_COMMAND_RATE, MessageRegistry, TokenBucket, readPayload, writePayload, type MessageDef, type MessageDefBase, type Payload } from "./messages.js";
import {
  MsgType, NONE_U32, PROTOCOL_VERSION, RejectReason, TOKEN_BYTES, decodeHello, decodeInput, encodeReject,
  encodeWelcome, readHeader, tokenKey, writeHeader, type InputCmd, type NamedHashes,
} from "./protocol.js";
import { NetSchema, captureState, writeDespawn, writeEnd, writeEntityRecord, type EntityState, type WorldState } from "./state.js";
import type { ConnId, ServerTransport } from "./transport/types.js";

/** Resolved value for a null (netId 0) entity field. */
export const NO_ENTITY = 0xffffffff;

/** Server-side netId <-> local entity mapping. NetIds are monotonic u32, never reused; ids below `first` are reserved. */
export class NetIdRegistry {
  /** ADR-369: bumped whenever a netId mapping is created or released; NetServer's per-client relevant-netId cache keys off it, so an entity that gains a netId while sitting still inside a client's AOI is never missed by a stale cache. */
  generation = 0;
  private next: number;
  private toEntity = new Map<number, Entity>();
  private toNet = new Map<number, number>(); // entity index -> netId
  constructor(private readonly world: World) {
    this.next = ENV_NET_ID + 1; // reserved for core's environment singleton
    world.onDespawn((e) => this.release(e));
    const ns = world.store(NetId);
    for (let k = 0; k < ns.size; k++) this.adopt(ns.dense[k]!);
  }
  /** Adds a NetId component (idempotent) and returns the netId. */
  assign(e: Entity): number {
    const known = this.netIdOf(e); if (known !== undefined) return known;
    if (this.world.has(e, NetId)) return this.adopt(e);
    const id = this.next++;
    this.world.add(e, NetId, { id });
    this.toEntity.set(id, e); this.toNet.set(entityIndex(e), id); this.generation++;
    return id;
  }
  /** Registers a NetId that was added directly (not via assign); reassigns if it collides. */
  adopt(e: Entity): number {
    const id = this.world.getField(e, NetId, "id")!;
    const owner = this.toEntity.get(id);
    if (owner === e) return id;
    if ((owner !== undefined && this.world.isAlive(owner)) || id === 0) { this.world.remove(e, NetId); return this.assign(e); }
    this.toEntity.set(id, e); this.toNet.set(entityIndex(e), id); this.generation++;
    if (id >= this.next) this.next = id + 1;
    return id;
  }
  entityOf(netId: number): Entity | undefined { return this.toEntity.get(netId); }
  netIdOf(e: Entity): number | undefined { const id = this.toNet.get(entityIndex(e)); return id !== undefined && this.toEntity.get(id) === e ? id : undefined; }
  get size(): number { return this.toEntity.size; }
  private release(e: Entity): void {
    const id = this.toNet.get(entityIndex(e));
    if (id !== undefined && this.toEntity.get(id) === e) { this.toEntity.delete(id); this.toNet.delete(entityIndex(e)); this.generation++; }
  }
}

/** Who receives a networked component. A function scope is a "viewers" hook (e.g. open containers); the owner always passes. */
export type ReplicationScope = "all" | "owner" | "none" | "party" | "clan" | ((world: World, entity: Entity, clientId: number) => boolean);
export type EventScope = "all" | { owner: number } | { clients: readonly number[] } | { nearby: { x: number; y: number } }
  /** Members (online) of a group id / of the party or clan of an entity's Owner. Needs a GroupScopeResolver (GroupReplicator). */
  | { group: number } | { groupOf: Entity; kind: "party" | "clan" };
/** Membership queries for group scopes; implemented by GroupReplicator over core's GroupRegistry. */
export interface GroupScopeResolver {
  share(clientA: number, clientB: number, kind: "party" | "clan"): boolean;
  groupOf(clientId: number, kind: "party" | "clan"): number | undefined;
  clientsOfGroup(group: number): number[];
}

export interface ClientSession {
  readonly clientId: number;
  readonly token: Uint8Array;
  conn: ConnId | undefined;
  /** Newest snapshot tick the client has decoded (delta baseline), -1 = none. */
  lastAckTick: number;
  lastReceivedSeq: number;
  lastProcessedSeq: number;
  /** Highest input seq whose edge record has been taken (edges are exactly-once per seq). */
  lastEdgeSeq: number;
  /** Edges of seqs whose input never arrived (slid out of the redundancy window) or was dropped: OR'd into the next applied input. */
  pendingEdges: number;
  /** Client's interpolation tick from its last input packet (for lag compensation), -1 = unknown. */
  lastViewTick: number;
  readonly inputQueue: InputCmd[];
  lastSnapshotBytes: number;
  fullSnapshots: number;
  stats: { commands: number; droppedCommands: number; rateLimited: number; deferred: number; bytesSent: number; lateEdges: number; throttled: number; /** entity-records kept alive by AOI leave hysteresis (interestLinger) */ lingered: number };
  /** Smoothed round-trip time in ms from transport-level ping/pong (-1 until measured). */
  rttMs: number;
  /** Session was created from a stored token via `resumeToken` (e.g. after a server restart). */
  resumed: boolean;
}
interface SessionState extends ClientSession {
  static: StaticSession;
  /** Per-client distantThrottle override (setDistantThrottle); null = explicitly off. */
  throttle?: { nearTiles: number; interval: number } | null;
  views: Map<number, WorldState>;
  /** Per netId: tick+1 it was last sent at (0 = never). Grown on demand. */
  lastSent: Int32Array;
  /** ADR: entity-level AOI leave hysteresis: netId -> tick until which an entity that dropped out of the AOI chunks keeps replicating. */
  linger: Map<number, number>;
  buckets: Map<number, TokenBucket>;
  commands: { def: MessageDefBase; payload: Record<string, number> }[];
  events: { reliable: boolean; def: MessageDefBase; payload: Record<string, number> }[];
  pingAt: number; pingNonce: number; lastPingSent?: number;
  /** In-process direct client (setDirect): no snapshots / statics / events / pings; entity refs checked against its AOI. */
  direct?: boolean;
}

export type AnomalyKind = "rateLimited" | "unknownCommand" | "malformed" | "inputFlood" | "badEntityRef" | "commandRejected" | "chatRateLimited" | "speed" | "teleport" | (string & {});
export type ApplyInput = (world: World, entity: Entity, cmd: InputCmd | null, clientId: number) => void;
export type CommandHandler<S extends core.Schema = core.Schema> = (session: ClientSession, payload: Payload<S>, world: World) => void;

export interface NetServerOptions {
  world: World;
  transport: ServerTransport;
  tickHz?: number;
  /** Per-client sent-view history used as delta baselines (default 32 ticks). Older acks get a full snapshot. */
  historySize?: number;
  maxInputQueue?: number;
  maxClients?: number;
  /** Human-readable detail sent with a ServerFull reject (e.g. "host cap 6 players (mobile host)"). */
  serverFullDetail?: string;
  applyInput?: ApplyInput;
  onClientJoin?: (session: ClientSession, world: World) => void;
  onClientLeave?: (session: ClientSession, world: World) => void;
  randomToken?: () => Uint8Array;
  /** Client->server commands and server->client events; same ordered lists on both peers. */
  commands?: readonly MessageDefBase[];
  events?: readonly MessageDefBase[];
  /** Extra handshake hashes (e.g. { assets: hash }). "schema" and "netdefs" are always checked. */
  hashes?: NamedHashes;
  /**
   * Hashes checked only when the client's Hello carries the name (ADR-245: { cosmetics }): a client shipping that
   * content must match (else RejectReason.HashMismatch, detail = name); one without it (Canvas2D debug view with no art
   * pack, dev load-test bots) is still let in.
   */
  hashesIfSent?: NamedHashes;
  /** Chunk area-of-interest; false = every entity is relevant to every client. */
  interest?: InterestOptions | false;
  /**
   * Entity-level AOI leave hysteresis (characters must not pop at the AOI edge). An entity the client already holds
   * that drops out of its relevant chunks keeps replicating while it is within `leaveChunks` extra chunks beyond the
   * chunk leave radius (radius + hysteresis) of any viewpoint, or for `minTicks` after it left (default: 1 chunk,
   * 2 s at tickHz). Despawns therefore happen only well outside view; `false` = despawn on chunk leave (old behaviour).
   */
  interestLinger?: { leaveChunks?: number; minTicks?: number } | false;
  /**
   * Per-client AOI radius bonus (setViewRadiusBonus): `max` chunks cap (default 2); a lowered bonus only takes
   * effect after it stayed lower for `holdTicks` (default 60) so stepping off a tower briefly doesn't thrash chunks.
   */
  viewBonus?: { max?: number; holdTicks?: number };
  /**
   * Entity fields in client commands (MessageDef.entityFields) arrive as NetIds. "aoi" (default): the target must be
   * alive AND currently held by that client (in a retained snapshot view, or in a static chunk it has) — unknown, stale
   * (despawned / reused) or out-of-AOI targets drop the command with a "badEntityRef" anomaly. "alive": any live entity.
   */
  entityRefs?: "aoi" | "alive";
  /** Soft per-client snapshot budget in bytes (default 16 KiB). Owned/global entities and despawns always go. */
  budgetBytes?: number;
  /**
   * Distance throttle for changed non-owned entities: beyond `nearTiles` of every one of the client's owned entities,
   * a delta update (never a spawn) is sent at most every `interval` ticks; skipped ticks keep the client's baseline
   * and the interpolation buffer bridges the gap. Targets fast movers (vehicles) that change every tick far away.
   */
  distantThrottle?: { nearTiles: number; interval: number };
  /** Per-client bytes per tick for streaming static chunks on entry (default 8 KiB); static change batches are not budgeted. */
  staticBudgetBytes?: number;
  /**
   * A client presented a token this server does not know (e.g. stored before a restart). Return true to accept it:
   * a new session is created with that same token (session.resumed = true) and onClientJoin runs. Default: reject (BadToken).
   */
  resumeToken?: (token: Uint8Array, world: World) => boolean;
  /** Forward core CommandHandlers rejections (core.CommandRejected) to the issuing client (default true). */
  forwardCoreRejections?: boolean;
  /** Ping interval in ms for RTT measurement (default 1000; 0 disables). */
  pingIntervalMs?: number;
  /** Lag-compensation window in ticks (default tickHz = 1 s). */
  positionHistoryTicks?: number;
}

function defaultToken(): Uint8Array {
  const c = (globalThis as unknown as { crypto?: { getRandomValues(a: Uint8Array): Uint8Array } }).crypto;
  if (!c) throw new Error("no crypto.getRandomValues; pass randomToken");
  return c.getRandomValues(new Uint8Array(TOKEN_BYTES));
}

/**
 * Authoritative server: handshake + sessions, commands and inputs (input phase), netId assignment,
 * chunk AOI, scoped per-client delta snapshots with a byte budget, and tick-stamped events (network phase).
 */
export class NetServer {
  readonly world: World;
  readonly netIds: NetIdRegistry;
  readonly schema: NetSchema;
  readonly commands: MessageRegistry;
  readonly events: MessageRegistry;
  readonly positions: PositionHistory;
  readonly interest: NetInterest | undefined;
  readonly sessions = new Map<number, ClientSession>();
  private byConn = new Map<ConnId, SessionState>();
  private byToken = new Map<string, SessionState>();
  private prevState: WorldState | undefined;
  private nextClientId = 1;
  private scopes = new Map<number, ReplicationScope>(); // comp index -> scope (absent = all)
  private ownerScoped = new Set<number>();
  private viewerScoped = new Map<number, (world: World, entity: Entity, clientId: number) => boolean>();
  private excluded = new Set<number>();
  private pubCache = new WeakMap<EntityState, EntityState>();
  private globals = new Set<Entity>();
  private groupResolver: GroupScopeResolver | undefined;
  private rawHandlers = new Map<number, (s: ClientSession, r: BitReader) => void>();
  private tickHooks: ((tick: number) => void)[] = [];
  private anomalyHandlers: ((s: ClientSession, kind: AnomalyKind, detail: string) => void)[] = [];
  private ownedCache = new Map<number, Entity[]>();
  /** ADR-369: per-client cached relevant netIds, in the same order the chunk walk produces them. Rebuilt only when that client's AOI set changes (see replicate); keyed by netIds.generation so a netId gained while still inside the AOI forces a rebuild. */
  private relevantNetIds = new Map<number, { ids: number[]; gen: number }>();
  private extraViews = new Map<number, readonly Viewpoint[]>();
  private staticCis = new Set<number>();
  private statics: StaticServer | undefined;
  private handlers = new Map<MessageDefBase, CommandHandler[]>();
  private ownerCi: number | undefined;
  readonly tickHz: number; readonly historySize: number; readonly budgetBytes: number; readonly staticBudgetBytes: number;
  /** Timings of the last network phase, for benchmarks. */
  private posX = new Float64Array(0);
  private curArr: (EntityState | undefined)[] = [];
  private stamp = new Int32Array(0);
  private stampSeq = 0;
  private posY = new Float64Array(0);
  /**
   * ADR-375: per-tick scratch reused across clients and ticks so replicate() stops allocating per client
   * per tick. All of these are fully rewritten (or length-reset then filled) on every use and never retained
   * past the client iteration / prioritize() call that uses them; replicate() is single-threaded and
   * synchronous, so sharing them is safe.
   */
  private replMust: number[] = [];
  private replMustEs: EntityState[] = [];
  private replRest: number[] = [];
  private replRestEs: EntityState[] = [];
  private prioScore = new Float64Array(0);
  private prioSorted = new Float64Array(0);
  /** Reused prioritize() output: only the first `ids.length` entries are valid; the buffer is overwritten on the next call. */
  private prioOrder: number[] = [];
  private prioHead: number[] = [];
  private prioTail: number[] = [];
  private prioCx: number[] = [];
  private prioCy: number[] = [];
  private prioTmpIds: number[] = [];
  private prioTmpEs: EntityState[] = [];
  readonly perf = { captureMs: 0, sendMs: 0, encoded: 0, shared: 0, relevantHits: 0, relevantBuilds: 0 };
  private readonly opts: NetServerOptions;

  constructor(opts: NetServerOptions) {
    this.opts = opts; this.world = opts.world;
    this.tickHz = opts.tickHz ?? 20; this.historySize = opts.historySize ?? 32; this.budgetBytes = opts.budgetBytes ?? 16 * 1024; this.staticBudgetBytes = opts.staticBudgetBytes ?? 8 * 1024;
    this.schema = new NetSchema(this.world);
    this.ownerCi = this.schema.indexOf(Owner, this.world);
    this.netIds = new NetIdRegistry(this.world);
    registerNetIds(this.world, this.netIds);
    this.commands = new MessageRegistry(opts.commands);
    this.events = new MessageRegistry(opts.events);
    this.positions = new PositionHistory(this.world, opts.positionHistoryTicks ?? this.tickHz);
    if (opts.interest !== false) this.interest = new NetInterest(this.world, opts.interest ?? {});
    const t = opts.transport;
    t.onMessage((c, b) => this.onMessage(c, b));
    t.onDisconnect((c) => this.onDisconnect(c));
    if (opts.forwardCoreRejections !== false) this.world.events.on(CommandRejected, (r) => this.rejectCommand(r.clientId, r.type, 0, r.reason, { seq: r.seq, core: true }));
    this.world.addSystem("input", "net.server.applyInputs", (w, dt) => this.inputPhase(w, dt));
    this.world.addSystem("network", "net.server.replicate", (w) => this.replicate(w));
  }

  /** Handshake hashes the client must match. */
  get requiredHashes(): NamedHashes {
    return { ...this.opts.hashes, schema: this.world.getSchemaHash(), netdefs: this.events.hash(this.commands.hash()) };
  }
  /** requiredHashes + hashesIfSent: what an in-process client (DirectTransport) sends. */
  get offeredHashes(): NamedHashes { return { ...this.opts.hashesIfSent, ...this.requiredHashes }; }
  sessionByConn(conn: ConnId): ClientSession | undefined { return this.byConn.get(conn); }

  // ---------------- scope / relevancy API ----------------
  /** Replication scope for a networked component (net-side registry; core ComponentDef has no custom fields). */
  setScope(def: ComponentDef, scope: ReplicationScope): this {
    const ci = this.schema.indexOf(def, this.world);
    if (ci === undefined) throw new Error(`${def.name} is not a replicated component`);
    if (def === Owner && scope !== "all") throw new Error("Owner must replicate to all");
    this.scopes.set(ci, scope); this.ownerScoped.delete(ci); this.viewerScoped.delete(ci); this.excluded.delete(ci);
    if (scope === "owner") this.ownerScoped.add(ci);
    else if (scope === "none") this.excluded.add(ci);
    else if (typeof scope === "function") this.viewerScoped.set(ci, scope);
    else if (scope === "party" || scope === "clan") {
      // visible to the owner and to members of the owner's party/clan
      this.viewerScoped.set(ci, (world, e, clientId) => {
        const owner = world.getField(e, Owner, "clientId"); const r = this.groupResolver;
        return owner !== undefined && owner !== 0 && !!r && r.share(owner, clientId, scope);
      });
    }
    this.pubCache = new WeakMap(); this.prevState = undefined;
    return this;
  }
  getScope(def: ComponentDef): ReplicationScope { const ci = this.schema.indexOf(def, this.world); return (ci !== undefined && this.scopes.get(ci)) || "all"; }
  // ---------------- extension points (groups, chat, anti-cheat modules) ----------------
  /** Install the membership resolver used by "party"/"clan" scopes (GroupReplicator does this). */
  setGroupResolver(r: GroupScopeResolver | undefined): void { this.groupResolver = r; this.pubCache = new WeakMap(); }
  get groups(): GroupScopeResolver | undefined { return this.groupResolver; }
  /** Handle a client->server message type (module-defined, see MsgType). Throwing counts as a malformed-message anomaly. */
  onRawMessage(type: number, fn: (session: ClientSession, r: BitReader) => void): void { this.rawHandlers.set(type, fn); }
  /** Send raw bytes to a connected client. Returns false if not connected. */
  sendRaw(clientId: number, bytes: Uint8Array, channel: "reliable" | "unreliable"): boolean {
    const s = this.sessions.get(clientId); if (!s?.conn) return false;
    this.opts.transport.send(s.conn, bytes, channel); s.stats.bytesSent += bytes.length; return true;
  }
  /**
   * Called once per network phase, BEFORE NetId assignment and snapshot capture: component writes (and entities
   * created) here replicate in this tick's snapshot. This is the supported late write phase for net modules and
   * gameplay; raw messages sent here go out ahead of this tick's snapshot (channels are not mutually ordered anyway).
   */
  onTick(fn: (tick: number) => void): void { this.tickHooks.push(fn); }
  /** Anti-cheat feed: rate-limited/unknown/malformed commands, input floods, rejections, module reports. */
  onAnomaly(fn: (s: ClientSession, kind: AnomalyKind, detail: string) => void): void { this.anomalyHandlers.push(fn); }
  /** Report an anomaly for a session (modules and gameplay can call this too). */
  anomaly(s: ClientSession, kind: AnomalyKind, detail = ""): void { for (const f of this.anomalyHandlers) f(s, kind, detail); }
  /** Entities owned by a client (Owner.clientId), as of the last input phase. */
  ownedEntities(clientId: number): readonly Entity[] { return this.ownedCache.get(clientId) ?? []; }
  /** Disconnect a client and forget its session (token no longer resumable). Safe inside onClientLeave. */
  kick(clientId: number): void { this.removeSession(clientId); }
  /** Connected sessions. */
  connected(): IterableIterator<ClientSession> { return this.byConn.values(); }
  /**
   * Tell a client its command was rejected: `reason` numeric code (0 = see detail), `detail` UTF-8 text, `seq` the
   * command's sequence if known. Core CommandHandlers rejections (core.CommandRejected) are forwarded automatically
   * with source "core", the core command type id, reason 0 and detail = core reason string.
   */
  rejectCommand(clientId: number, command: MessageDefBase | number, reason: number, detail = "", opts: { seq?: number; core?: boolean } = {}): void {
    const s = this.sessions.get(clientId); if (!s) return;
    const id = typeof command === "number" ? command : this.commands.id(command);
    const w = new BitWriter(); writeHeader(w, MsgType.CommandRejected); w.writeBool(!!opts.core); w.writeVarUint(id); w.writeVarUint(opts.seq === undefined ? 0 : opts.seq + 1);
    w.writeVarUint(reason); writeUtf8(w, detail);
    this.sendRaw(clientId, w.finish(), "reliable");
    this.anomaly(s, "commandRejected", `${id}:${reason}:${detail}`);
  }

  /**
   * Replication class of a networked component. "static": entities having any static-class component (and a
   * Transform) replicate ALL their replicated components over the static channel (per-chunk streaming on entry,
   * versioned chunk cache, reliable per-tick change batches) instead of snapshots. Scopes do not apply to them.
   * Set before clients join; default "dynamic".
   */
  setReplicationClass(def: ComponentDef, cls: ReplicationClass): this {
    const ci = this.schema.indexOf(def, this.world);
    if (ci === undefined) throw new Error(`${def.name} is not a replicated component`);
    if (def === Transform || def === Owner) throw new Error(`${def.name} cannot define a replication class`);
    if (cls === "static") this.staticCis.add(ci); else this.staticCis.delete(ci);
    this.statics = this.staticCis.size ? new StaticServer(this.schema, this.staticCis, this.schema.indexOf(Transform, this.world)) : undefined;
    for (const s of this.sessions.values() as IterableIterator<SessionState>) s.static = new StaticSession();
    return this;
  }
  getReplicationClass(def: ComponentDef): ReplicationClass { const ci = this.schema.indexOf(def, this.world); return ci !== undefined && this.staticCis.has(ci) ? "static" : "dynamic"; }
  /** Static-channel state, for stats/tests. */
  get staticReplication(): StaticServer | undefined { return this.statics; }
  staticStats(clientId: number): { bytes: number; streamedChunks: number; hits: number; streaming: number } | undefined {
    const s = this.sessions.get(clientId) as SessionState | undefined; if (!s) return undefined;
    return { bytes: s.static.bytes, streamedChunks: s.static.streamedChunks, hits: s.static.hits, streaming: s.static.streams.size };
  }
  /**
   * Extra AOI viewpoints for a client (e.g. a spectator camera, a remote-viewed turret), unioned with its owned
   * entities' positions. Pass [] to clear. `r` = chunk radius (default the grid radius).
   */
  private lastViews = new Map<number, readonly Viewpoint[]>();
  /** Chunks in the client's AOI as of the last send (undefined = interest disabled: everything is relevant). */
  relevantChunks(clientId: number): ReadonlySet<string> | undefined { return this.interest ? (this.interest.grid.get(clientId)?.chunks ?? NO_CHUNKS) : undefined; }
  /** The client's AOI viewpoints (owned entities + extra) as of the last send; for closest-first ordering. */
  viewpointsOf(clientId: number): readonly Viewpoint[] { return this.lastViews.get(clientId) ?? []; }
  private viewBonus = new Map<number, { target: number; eff: number; lowFor: number }>();
  /**
   * Extra AOI chunk radius for a client (watchtower, spyglass), added to every one of its viewpoints. Capped
   * server-side at viewBonus.max; raising applies on the next send, lowering after viewBonus.holdTicks. 0 clears.
   * Returns the capped target.
   */
  /**
   * Per-client distantThrottle override (ADR-105), e.g. headless virtual players that only perceive ~20 tiles: changed
   * entities beyond `nearTiles` of the client's owned entities get deltas every `interval` ticks. null = off for this
   * client, undefined = back to the server-wide option. Returns false for an unknown client.
   */
  setDistantThrottle(clientId: number, thr: { nearTiles: number; interval: number } | null | undefined): boolean {
    const s = this.sessions.get(clientId) as SessionState | undefined; if (!s) return false;
    if (thr === undefined) delete s.throttle; else s.throttle = thr; return true;
  }
  /**
   * Mark a session as an in-process direct client (ADR-105): it reads the authoritative world itself, so the server
   * skips its snapshot encode, static chunk stream, events and pings. Inputs, commands and raw messages still arrive
   * through onMessage (same decoding, rate limits and handlers). Entity refs in its commands must be alive and inside
   * its interest AOI (or global), instead of "in a snapshot it holds". Returns false for an unknown client.
   */
  setDirect(clientId: number, direct = true): boolean {
    const s = this.sessions.get(clientId) as SessionState | undefined; if (!s) return false;
    if (direct) s.direct = true; else delete s.direct; if (direct) { s.views.clear(); s.events.length = 0; } this.relevantNetIds.delete(clientId); return true;
  }
  /** Only network players occupy join slots. Direct clients are trusted in-process AI, never a wire flag. */
  private playerSlotCount(): number {
    let count = 0; for (const s of this.sessions.values()) if (!this.isDirect(s.clientId)) count++; return count;
  }
  isDirect(clientId: number): boolean { return (this.sessions.get(clientId) as SessionState | undefined)?.direct === true; }
  setViewRadiusBonus(clientId: number, chunks: number): number {
    const max = Math.max(0, Math.floor(this.opts.viewBonus?.max ?? 2));
    const target = Math.min(max, Math.max(0, Math.floor(Number.isFinite(chunks) ? chunks : 0)));
    const b = this.viewBonus.get(clientId);
    if (b) { b.target = target; if (target >= b.eff) { b.eff = target; b.lowFor = 0; } }
    else if (target) this.viewBonus.set(clientId, { target, eff: target, lowFor: 0 });
    return target;
  }
  /** The bonus currently applied to the client's AOI (after hysteresis). */
  viewRadiusBonus(clientId: number): number { return this.viewBonus.get(clientId)?.eff ?? 0; }
  private effectiveBonus(clientId: number): number {
    const b = this.viewBonus.get(clientId); if (!b) return 0;
    if (b.target < b.eff && ++b.lowFor >= (this.opts.viewBonus?.holdTicks ?? 60)) { b.eff = b.target; b.lowFor = 0; }
    if (!b.eff && !b.target) this.viewBonus.delete(clientId);
    return b.eff;
  }
  setViewpoints(clientId: number, views: readonly Viewpoint[]): void { if (views.length) this.extraViews.set(clientId, views); else this.extraViews.delete(clientId); }
  /** Always replicate this entity to every client regardless of AOI (entities without Transform are global automatically). */
  setGlobal(e: Entity, global = true): void { if (global) this.globals.add(e); else this.globals.delete(e); }

  // ---------------- commands & events API ----------------
  onCommand<S extends core.Schema>(def: MessageDef<S>, handler: CommandHandler<S>): () => void {
    this.commands.id(def as unknown as MessageDefBase);
    const d = def as unknown as MessageDefBase; const l = this.handlers.get(d) ?? []; l.push(handler as unknown as CommandHandler); this.handlers.set(d, l);
    return () => { const i = l.indexOf(handler as unknown as CommandHandler); if (i >= 0) l.splice(i, 1); };
  }
  /** Queue a tick-stamped event (entity fields = local entities; sent as NetIds). Flushed in this tick's network phase. */
  emitEvent<S extends core.Schema>(def: MessageDef<S>, payload: Payload<S>, opts: { reliable?: boolean; scope?: EventScope } = {}): void {
    const d = def as unknown as MessageDefBase; this.events.id(d);
    const p = { ...payload } as Record<string, number>; // entity fields are scalars; array fields pass through
    for (const f of d.entityFields) { const e = p[f]!; p[f] = e === NO_ENTITY ? 0 : this.netIds.netIdOf(e) ?? 0; }
    const scope = opts.scope ?? "all";
    const near = typeof scope === "object" && "nearby" in scope ? scope.nearby : undefined;
    let groupClients: Set<number> | undefined;
    if (typeof scope === "object" && ("group" in scope || "groupOf" in scope)) {
      const r = this.groupResolver; let gid: number | undefined;
      if ("group" in scope) gid = scope.group;
      else { const owner = this.world.isAlive(scope.groupOf) ? this.world.getField(scope.groupOf, Owner, "clientId") : undefined; gid = owner && r ? r.groupOf(owner, scope.kind) : undefined; }
      groupClients = new Set(gid !== undefined && r ? r.clientsOfGroup(gid) : []);
    }
    for (const s of this.byConn.values()) {
      if (typeof scope === "object") {
        if ("owner" in scope && s.clientId !== scope.owner) continue;
        if ("clients" in scope && !scope.clients.includes(s.clientId)) continue;
        if (groupClients && !groupClients.has(s.clientId)) continue;
        if (near && this.interest && !this.interest.covers(s.clientId, near.x, near.y)) continue;
      }
      if (s.direct) continue;
      s.events.push({ reliable: opts.reliable ?? true, def: d, payload: p });
    }
  }

  // ---------------- transport handling ----------------
  private reject(conn: ConnId, reason: RejectReason, detail = ""): void { this.opts.transport.send(conn, encodeReject(reason, detail), "reliable"); }

  private onMessage(conn: ConnId, bytes: Uint8Array): void {
    let r: BitReader; let h;
    try { r = new BitReader(bytes); h = readHeader(r); } catch { return; }
    if (h.version !== PROTOCOL_VERSION) { this.reject(conn, RejectReason.ProtocolMismatch, `v${PROTOCOL_VERSION}`); return; }
    try {
      if (h.type === MsgType.Hello) this.onHello(conn, r);
      else if (h.type === MsgType.Input) this.onInput(conn, r);
      else if (h.type === MsgType.Command) this.onCommandMsg(conn, r);
      else if (h.type === MsgType.Pong) this.onPong(conn, r);
      else if (this.rawHandlers.has(h.type)) { const s = this.byConn.get(conn); if (s) this.rawHandlers.get(h.type)!(s, r); }
      else if (h.type === MsgType.StaticCtl) { const s = this.byConn.get(conn); const kind = r.readBits(2); const key = readChunkKey(r); if (s && this.statics) this.statics.onCtl(s.static, kind, key); }
    } catch { const s = this.byConn.get(conn); if (s) this.anomaly(s, "malformed", `msg ${h.type}`); else this.reject(conn, RejectReason.Malformed); }
  }

  private onHello(conn: ConnId, r: BitReader): void {
    const hello = decodeHello(r);
    for (const [name, v] of Object.entries(this.requiredHashes)) {
      if (hello.hashes[name] !== v) { this.reject(conn, name === "schema" ? RejectReason.SchemaMismatch : RejectReason.HashMismatch, name); return; }
    }
    for (const [name, v] of Object.entries(this.opts.hashesIfSent ?? {})) {
      if (name in hello.hashes && hello.hashes[name] !== v) { this.reject(conn, RejectReason.HashMismatch, name); return; }
    }
    let s: SessionState | undefined;
    if (hello.token.some((b) => b !== 0)) {
      s = this.byToken.get(tokenKey(hello.token));
      if (!s && this.opts.resumeToken?.(hello.token, this.world)) {
        if (this.opts.maxClients !== undefined && this.playerSlotCount() >= this.opts.maxClients) { this.reject(conn, RejectReason.ServerFull, this.opts.serverFullDetail ?? ""); return; }
        s = this.newSession(conn, hello.token.slice(), true);
      } else {
        if (!s) { this.reject(conn, RejectReason.BadToken); return; }
        if (s.conn !== undefined) this.byConn.delete(s.conn);
        s.conn = conn; s.lastAckTick = -1; s.views.clear(); s.static = new StaticSession();
      }
    } else {
      if (this.opts.maxClients !== undefined && this.playerSlotCount() >= this.opts.maxClients) { this.reject(conn, RejectReason.ServerFull, this.opts.serverFullDetail ?? ""); return; }
      s = this.newSession(conn, (this.opts.randomToken ?? defaultToken)(), false);
    }
    this.byConn.set(conn, s);
    this.opts.transport.send(conn, encodeWelcome({ clientId: s.clientId, token: s.token, tickHz: this.tickHz, serverTick: this.world.tick }), "reliable");
  }

  private newSession(conn: ConnId, token: Uint8Array, resumed: boolean): SessionState {
    const s: SessionState = {
      clientId: this.nextClientId++, token, conn, lastAckTick: -1, lastReceivedSeq: -1, lastProcessedSeq: -1, lastEdgeSeq: -1, pendingEdges: 0, lastViewTick: -1,
      inputQueue: [], lastSnapshotBytes: 0, fullSnapshots: 0, rttMs: -1, resumed,
      stats: { commands: 0, droppedCommands: 0, rateLimited: 0, deferred: 0, bytesSent: 0, lateEdges: 0, throttled: 0, lingered: 0 },
      views: new Map(), lastSent: new Int32Array(256), linger: new Map(), static: new StaticSession(), buckets: new Map(), commands: [], events: [],
      pingAt: 0, pingNonce: 0,
    };
    this.sessions.set(s.clientId, s); this.byToken.set(tokenKey(token), s);
    this.opts.onClientJoin?.(s, this.world);
    return s;
  }
  private clock(): number { return this.opts.transport.now ? this.opts.transport.now() : now(); }
  private onPong(conn: ConnId, r: BitReader): void {
    const s = this.byConn.get(conn); if (!s) return;
    const nonce = r.readBits(32); if (nonce !== s.pingNonce || !s.pingAt) return;
    const rtt = this.clock() - s.pingAt; s.pingAt = 0;
    s.rttMs = s.rttMs < 0 ? rtt : s.rttMs * 0.75 + rtt * 0.25;
  }
  private pings(): void {
    const iv = this.opts.pingIntervalMs ?? 1000; if (iv <= 0) return;
    const t = this.clock();
    for (const s of this.byConn.values()) {
      if (s.direct) continue;
      if (s.pingAt && t - s.pingAt < iv * 4) continue; // outstanding
      if (s.lastPingSent !== undefined && t - s.lastPingSent < iv) continue;
      s.pingNonce = (s.pingNonce + 1) >>> 0; s.pingAt = t; s.lastPingSent = t;
      const w = new BitWriter(); writeHeader(w, MsgType.Ping); w.writeBits(s.pingNonce, 32); w.writeBits(Math.min(65535, Math.max(0, Math.round(s.rttMs))), 16);
      this.opts.transport.send(s.conn!, w.finish(), "unreliable");
    }
  }
  private onInput(conn: ConnId, r: BitReader): void {
    const s = this.byConn.get(conn); if (!s) return;
    const m = decodeInput(r);
    if (m.ackTick !== NONE_U32 && m.ackTick > s.lastAckTick && m.ackTick <= this.world.tick) s.lastAckTick = m.ackTick;
    if (m.viewTick !== undefined && m.viewTick <= this.world.tick) s.lastViewTick = m.viewTick;
    for (const c of m.cmds) {
      if (c.seq <= s.lastReceivedSeq) continue;
      s.lastReceivedSeq = c.seq; delete c.edges; s.inputQueue.push(c);
    }
    // edge records: exactly once per seq (records arrive sorted; anything <= lastEdgeSeq was already taken)
    for (const e of m.edges ?? []) {
      if (e.seq <= s.lastEdgeSeq || e.seq > s.lastReceivedSeq) continue; // never ahead of the cmds it belongs to
      s.lastEdgeSeq = e.seq;
      const q = s.inputQueue.find((c) => c.seq === e.seq);
      if (q) q.edges = ((q.edges ?? 0) | e.edges) >>> 0;
      else { s.pendingEdges = (s.pendingEdges | e.edges) >>> 0; s.stats.lateEdges++; }
    }
    const max = this.opts.maxInputQueue ?? 8;
    if (s.inputQueue.length > max) {
      this.anomaly(s, "inputFlood", `${s.inputQueue.length}`);
      for (const c of s.inputQueue.splice(0, s.inputQueue.length - max)) if (c.edges) s.pendingEdges = (s.pendingEdges | c.edges) >>> 0; // never lose a pulse
    }
  }

  private onCommandMsg(conn: ConnId, r: BitReader): void {
    const s = this.byConn.get(conn); if (!s) return;
    const id = r.readVarUint(); const vt = r.readVarUint() - 1;
    if (vt >= 0 && vt <= this.world.tick && vt > s.lastViewTick) s.lastViewTick = vt; // what the client saw when it issued this command
    const def = this.commands.get(id);
    if (!def) { s.stats.droppedCommands++; this.anomaly(s, "unknownCommand", `${id}`); return; }
    const payload = readPayload(r, def);
    let b = s.buckets.get(id); if (!b) { b = new TokenBucket(def.rate ?? DEFAULT_COMMAND_RATE); s.buckets.set(id, b); }
    if (!b.take()) { s.stats.rateLimited++; this.anomaly(s, "rateLimited", def.name); return; }
    s.commands.push({ def, payload });
  }

  private onDisconnect(conn: ConnId): void {
    const s = this.byConn.get(conn); if (!s) return;
    this.byConn.delete(conn); s.conn = undefined; s.views.clear(); s.events.length = 0; this.relevantNetIds.delete(s.clientId);
    this.interest?.removeViewer(s.clientId);
    this.opts.onClientLeave?.(s, this.world);
  }

  removeSession(clientId: number): void {
    const s = this.sessions.get(clientId) as SessionState | undefined; if (!s) return;
    this.sessions.delete(clientId); this.byToken.delete(tokenKey(s.token)); this.interest?.removeViewer(clientId); this.extraViews.delete(clientId); this.viewBonus.delete(clientId); this.relevantNetIds.delete(clientId);
    if (s.conn !== undefined) { this.byConn.delete(s.conn); this.opts.transport.disconnect(s.conn); }
  }

  private ownedBy(w: World): Map<number, Entity[]> {
    const owned = new Map<number, Entity[]>();
    for (const e of w.query([Owner])) {
      const cid = w.getField(e, Owner, "clientId")!; if (cid === 0) continue;
      const l = owned.get(cid); if (l) l.push(e); else owned.set(cid, [e]);
    }
    return owned;
  }

  /** Whether `netId` is in what this client currently holds (any retained snapshot view, or a synced static chunk). */
  clientHolds(session: ClientSession, netId: number): boolean {
    const s = session as SessionState;
    if (s.direct) {
      const e = this.netIds.entityOf(netId); if (e === undefined || !this.world.isAlive(e)) return false;
      const t = this.world.get(e, Transform); if (!t || this.globals.has(e) || !this.interest) return true;
      return this.interest.covers(s.clientId, t.x, t.y);
    }
    for (const v of s.views.values()) if (v.has(netId)) return true;
    return this.statics?.knownTo(s.static, netId) ?? false;
  }

  // ---------------- input phase ----------------
  private inputPhase(w: World, dt: number): void {
    const owned = this.ownedBy(w); this.ownedCache = owned;
    for (const s of this.sessions.values() as IterableIterator<SessionState>) {
      for (const b of s.buckets.values()) b.refill(dt);
      const cmds = s.commands; s.commands = [];
      for (const c of cmds) {
        const p = { ...c.payload }; let ok = true;
        for (const f of c.def.entityFields) {
          const id = p[f]!; if (id === 0) { p[f] = NO_ENTITY; continue; }
          const e = this.netIds.entityOf(id);
          if (e === undefined || !w.isAlive(e) || (this.opts.entityRefs ?? "aoi") === "aoi" && !this.clientHolds(s, id)) { ok = false; break; }
          p[f] = e;
        }
        if (!ok) { s.stats.droppedCommands++; this.anomaly(s, "badEntityRef", c.def.name); continue; }
        s.stats.commands++;
        for (const h of this.handlers.get(c.def) ?? []) h(s, p, w);
      }
      const cmd = s.inputQueue.shift() ?? null;
      if (cmd) { s.lastProcessedSeq = cmd.seq; if (s.pendingEdges) { cmd.edges = ((cmd.edges ?? 0) | s.pendingEdges) >>> 0; s.pendingEdges = 0; } }
      if (this.opts.applyInput) for (const e of owned.get(s.clientId) ?? []) this.opts.applyInput(w, e, cmd, s.clientId);
    }
  }

  // ---------------- network phase ----------------
  /** Component view of `es` for `clientId` according to scopes. Returns shared objects whenever possible. */
  private filterFor(netEntity: Entity, es: EntityState, clientId: number): EntityState {
    if (!this.ownerScoped.size && !this.viewerScoped.size) return es;
    const owner = this.ownerCi !== undefined ? es.get(this.ownerCi)?.[0] : undefined;
    let hasViewer = false;
    for (const ci of this.viewerScoped.keys()) if (es.has(ci)) { hasViewer = true; break; }
    if (owner === clientId) return es; // owner sees owner- and viewer-scoped comps
    let pub = this.pubCache.get(es);
    if (!pub) {
      let restricted = hasViewer;
      if (!restricted) for (const ci of this.ownerScoped) if (es.has(ci)) { restricted = true; break; }
      if (!restricted) pub = es;
      else { const m = new Map(es); for (const ci of this.ownerScoped) m.delete(ci); for (const ci of this.viewerScoped.keys()) m.delete(ci); pub = m; }
      this.pubCache.set(es, pub);
    }
    if (!hasViewer) return pub;
    let m: Map<number, readonly number[]> | undefined;
    for (const [ci, fn] of this.viewerScoped) {
      const v = es.get(ci); if (!v || !fn(this.world, netEntity, clientId)) continue;
      m ??= new Map(pub); m.set(ci, v);
    }
    return m ?? pub;
  }

  private replicate(w: World): void {
    for (const f of this.tickHooks) f(w.tick); // before capture: hook writes must not be lost to the end-of-step bit clear
    const t0 = now();
    const ns = w.store(NetId);
    // Spread is deliberate here: adopt() can write the NetId store being iterated, so a snapshot preserves the old behaviour.
    for (const index of [...ns.changedIndices()]) { const e = ns.dense[ns.slot(index)]!; if (this.netIds.netIdOf(e) === undefined) this.netIds.adopt(e); }
    // ADR-369: iterate the generator directly (no per-store snapshot array); assign() only writes the NetId store, never `st`.
    for (const st of this.schema.stores) for (const index of st.changedIndices()) {
      const e = st.dense[st.slot(index)]!;
      if (!w.has(e, NetId)) this.netIds.assign(e);
    }
    this.positions.record();
    const cur = captureState(w, this.schema, this.prevState, this.excluded);
    this.prevState = cur;
    const owned = this.ownedBy(w);
    const tf = w.store(Transform);
    // global entities: no Transform, or flagged
    const globals: number[] = [];
    for (let k = 0; k < ns.size; k++) { const e = ns.dense[k]!; if (!tf.has(entityIndex(e)) || this.globals.has(e)) globals.push(ns.data.id[k]!); }
    const grid = this.interest;
    const viewsOf = new Map<number, readonly Viewpoint[]>(); this.lastViews = viewsOf;
    if (this.statics) this.statics.update(cur);
    if (grid) {
      grid.sync();
      for (const s of this.byConn.values()) {
        const pos = (owned.get(s.clientId) ?? []).filter((e) => tf.has(entityIndex(e))).map((e) => ({ x: w.getField(e, Transform, "x")!, y: w.getField(e, Transform, "y")! }));
        const extra = this.extraViews.get(s.clientId);
        let vp: readonly Viewpoint[] = extra ? [...pos, ...extra] : pos;
        const bonus = this.effectiveBonus(s.clientId);
        if (bonus) vp = vp.map((v) => ({ x: v.x, y: v.y, r: (v.r ?? grid.grid.radius) + bonus }));
        viewsOf.set(s.clientId, vp);
        grid.setViewer(s.clientId, vp);
      }
      grid.update();
    }
    const t1 = now(); this.perf.captureMs = t1 - t0;
    const tick = w.tick;
    // ADR-369: one pass over cur (below) fills curArr and the per-tick positions; the old code walked cur.keys()
    // three times plus a full posX.fill(NaN). Every id in cur gets a posX/posY write in that pass, and every reader
    // of posX/posY only touches ids in cur (prioritize / distantThrottle) or ids guarded by curArr (linger),
    // so no fill is needed.
    let maxId = 0; for (const id of cur.keys()) if (id > maxId) maxId = id;
    if (this.posX.length <= maxId) { this.posX = new Float64Array(maxId * 2 + 1); this.posY = new Float64Array(maxId * 2 + 1); }
    if (this.curArr.length <= maxId) { this.curArr = new Array(maxId * 2 + 1); this.stamp = new Int32Array(maxId * 2 + 1); }
    const scoped = this.ownerScoped.size > 0 || this.viewerScoped.size > 0;
    const chunkIds = new Map<string, number[]>(); // per-tick netIds per chunk, shared by every client that sees it
    // Per-tick cache of encoded entity records keyed by (current state object, baseline state object): clients with
    // the same baseline for an entity share one encoding (states are immutable and shared, so identity == equality).
    const enc = new Map<EntityState, Map<EntityState | typeof NO_BASE, EncodedRecord | null>>();
    const record = (id: number, es: EntityState, old: EntityState | undefined): EncodedRecord | null => {
      let m = enc.get(es); if (!m) { m = new Map(); enc.set(es, m); }
      const k = old ?? NO_BASE; let r = m.get(k);
      if (r === undefined) {
        // ADR-375: keep the writer itself in the per-tick cache instead of snapshotBits()'s byte copy.
        // The writer is written exactly once, by this call, and never mutated afterwards, so its internal
        // buffer is stable for the rest of the tick; appendWriter() reads it without copying.
        const bw = new BitWriter();
        r = writeEntityRecord(bw, this.schema, id, es, old) ? { w: bw, bits: bw.bitLength, id } : null;
        if (r && r.id !== id) r = null;
        m.set(k, r); this.perf.encoded++;
      } else this.perf.shared++;
      return r && r.id === id ? r : null;
    };
    this.perf.encoded = 0; this.perf.shared = 0; this.perf.relevantHits = 0; this.perf.relevantBuilds = 0;
    // netId-indexed current states + a per-client stamp for O(1) dedupe without Map lookups
    const curArr = this.curArr; curArr.fill(undefined);
    cur.forEach((es, id) => { // ADR-212: forEach, no [k, v] entry array per entity per tick
      curArr[id] = es;
      const e = this.netIds.entityOf(id);
      if (e === undefined) { this.posX[id] = NaN; this.posY[id] = NaN; return; }
      const i = entityIndex(e);
      if (tf.has(i)) { const sl = tf.slot(i); this.posX[id] = tf.data.x[sl]!; this.posY[id] = tf.data.y[sl]!; }
      else { this.posX[id] = NaN; this.posY[id] = NaN; }
    });
    if (this.statics) for (const id of this.statics.ids) curArr[id] = undefined; // static channel, not snapshots
    const stamp = this.stamp;
    for (const s of this.byConn.values()) {
      if (s.direct) continue; // ADR-105: reads the authoritative world in-process
      const seq = ++this.stampSeq;
      const base = s.lastAckTick >= 0 ? s.views.get(s.lastAckTick) : undefined;
      if (!base) s.fullSnapshots++;
      const view = new Map<number, EntityState>(); // what the client will hold once it decodes this snapshot
      // ADR-375: reuse the server-level scratch lists (length-reset, then filled by consider() below).
      // They hold no references past this client iteration: the view Map keeps the EntityStates, not the lists.
      const must = this.replMust, mustEs = this.replMustEs, rest = this.replRest, restEs = this.replRestEs;
      must.length = 0; mustEs.length = 0; rest.length = 0; restEs.length = 0;
      const consider = (id: number, isMust: boolean): void => {
        if (stamp[id] === seq) return; const es0 = curArr[id]; if (!es0) return; stamp[id] = seq;
        let es = es0;
        if (scoped) { const e = this.netIds.entityOf(id); if (e !== undefined) es = this.filterFor(e, es0, s.clientId); }
        const old = base?.get(id);
        if (old === es) { view.set(id, es); return; }
        if (isMust) { must.push(id); mustEs.push(es); } else { rest.push(id); restEs.push(es); }
      };
      for (const e of owned.get(s.clientId) ?? []) { const id = this.netIds.netIdOf(e); if (id !== undefined) consider(id, true); }
      for (const id of globals) consider(id, true);
      if (grid) {
        // ADR-369: cache this client's relevant netIds across ticks. InterestGrid already maintains the client's
        // relevant entity set incrementally; it is unchanged exactly when this tick's entered/left (entities and
        // chunks) are all empty, so a hit skips the per-chunk walk, the entitiesIn() scans and the netId lookups.
        // A netId gained while still inside the AOI (netIds.generation moved) forces a rebuild, as does any AOI
        // change. Order on a hit is the order the list was built in; an entity moving between two chunks that are
        // both still relevant keeps its old position in that order (the set is identical, only the walk order
        // differs) — prioritize() reorders `rest` by distance/staleness anyway, so only ties among equal
        // distance/staleness can come out in a different order, and every entity is still sent.
        const g = grid.grid.get(s.clientId);
        const cached = this.relevantNetIds.get(s.clientId);
        if (g !== undefined && cached !== undefined && cached.gen === this.netIds.generation
          && g.entered.length === 0 && g.left.length === 0 && g.enteredChunks.length === 0 && g.leftChunks.length === 0) {
          this.perf.relevantHits++;
          for (let i = 0; i < cached.ids.length; i++) consider(cached.ids[i]!, false);
        } else {
          this.perf.relevantBuilds++;
          const ids: number[] = [];
          for (const key of g?.chunks ?? []) {
            let chunk = chunkIds.get(key);
            if (!chunk) {
              chunk = [];
              for (const e of grid.membership.entitiesIn(key)) { const id = this.netIds.netIdOf(e); if (id !== undefined) chunk.push(id); }
              chunkIds.set(key, chunk);
            }
            for (let i = 0; i < chunk.length; i++) { ids.push(chunk[i]!); consider(chunk[i]!, false); }
          }
          this.relevantNetIds.set(s.clientId, { ids, gen: this.netIds.generation });
        }
        // entity-level leave hysteresis: held entities just outside the AOI chunks linger instead of despawning
        if (base && this.opts.interestLinger !== false) {
          const lo = this.opts.interestLinger ?? {}; const extra = lo.leaveChunks ?? 1; const minT = lo.minTicks ?? Math.round(this.tickHz * 2);
          const vps = viewsOf.get(s.clientId) ?? []; const R0 = grid.grid.radius + grid.grid.hysteresis + extra;
          for (const id of base.keys()) {
            if (stamp[id] === seq) { s.linger.delete(id); continue; }
            if (!curArr[id]) { s.linger.delete(id); continue; }
            const x = this.posX[id]!, y = this.posY[id]!; let keep = false;
            if (x === x) { const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK);
              for (const v of vps) { const r = (v.r ?? grid.grid.radius) - grid.grid.radius + R0; if (Math.abs(cx - Math.floor(v.x / CHUNK)) <= r && Math.abs(cy - Math.floor(v.y / CHUNK)) <= r) { keep = true; break; } } }
            let until = s.linger.get(id); if (until === undefined) s.linger.set(id, (until = tick + minT));
            if (keep || tick < until) { consider(id, false); s.stats.lingered++; } // expired: entry kept until the despawn is acked (cleanup below), so a lagging ack can't restart it
          }
          for (const id of s.linger.keys()) if (!base.has(id)) s.linger.delete(id);
        }
      } else for (const id of cur.keys()) consider(id, false);
      // ---- encode against acked view ----
      const bw = new BitWriter();
      writeHeader(bw, MsgType.Snapshot);
      bw.writeBits(tick, 32); bw.writeBits(base ? s.lastAckTick : NONE_U32, 32);
      bw.writeBits(s.lastProcessedSeq < 0 ? NONE_U32 : s.lastProcessedSeq, 32);
      if (base) for (const id of base.keys()) if (stamp[id] !== seq || curArr[id] === undefined) writeDespawn(bw, id);
      for (let i = 0; i < must.length; i++) {
        const id = must[i]!, es = mustEs[i]!; const r = record(id, es, base?.get(id));
        if (r) bw.appendWriter(r.w); view.set(id, es);
      }
      if (rest.length > 1 && bw.byteLength < this.budgetBytes) {
        const order = this.prioritize(rest, s, owned.get(s.clientId) ?? [], tick, Math.min(rest.length, (this.budgetBytes >> 2) + 64));
        // ADR-375: permute through reused scratch instead of rest.slice() / restEs.slice() copies.
        const tmpIds = this.prioTmpIds, tmpEs = this.prioTmpEs;
        tmpIds.length = rest.length; tmpEs.length = rest.length;
        for (let k = 0; k < rest.length; k++) { tmpIds[k] = rest[k]!; tmpEs[k] = restEs[k]!; }
        for (let k = 0; k < order.length; k++) { rest[k] = tmpIds[order[k]!]!; restEs[k] = tmpEs[order[k]!]!; }
      }
      const budgetBits = this.budgetBytes * 8 - 2;
      const thr = s.throttle === undefined ? this.opts.distantThrottle : (s.throttle ?? undefined); let vx: number[] | undefined, vy: number[] | undefined;
      if (thr && thr.interval > 1) {
        // ADR-375: no ownedIds Set — the owned entities are already in hand; netIdOf() is a Map lookup.
        vx = []; vy = [];
        for (const e of owned.get(s.clientId) ?? []) { const id = this.netIds.netIdOf(e); if (id === undefined) continue; const x = this.posX[id]; if (x !== undefined && !Number.isNaN(x)) { vx.push(x); vy.push(this.posY[id]!); } }
        if (!vx.length) vx = undefined;
      }
      for (let i = 0; i < rest.length; i++) {
        const id = rest[i]!, es = restEs[i]!; const old = base?.get(id);
        if (vx && old && thr && id < s.lastSent.length && s.lastSent[id]! > 0 && tick + 1 - s.lastSent[id]! < thr.interval) {
          const x = this.posX[id]; const near2 = thr.nearTiles * thr.nearTiles;
          if (x !== undefined && !Number.isNaN(x)) {
            let far = true; for (let k = 0; k < vx.length; k++) { const dx = x - vx[k]!, dy = this.posY[id]! - vy![k]!; if (dx * dx + dy * dy <= near2) { far = false; break; } }
            if (far) { view.set(id, old); s.stats.throttled++; continue; }
          }
        }
        const r = record(id, es, old);
        if (!r) { view.set(id, es); continue; }
        if (bw.bitLength + r.bits > budgetBits) {
          // defer this and everything after it: the client keeps its baseline value / does not get the spawn yet
          for (let j = i; j < rest.length; j++) { const o = base?.get(rest[j]!); if (o) view.set(rest[j]!, o); }
          s.stats.deferred += rest.length - i;
          break;
        }
        bw.appendWriter(r.w); view.set(id, es);
        if (id >= s.lastSent.length) { const g = new Int32Array(Math.max(id + 1, s.lastSent.length * 2)); g.set(s.lastSent); s.lastSent = g; }
        s.lastSent[id] = tick + 1;
      }
      writeEnd(bw);
      s.views.set(tick, view);
      for (const t of s.views.keys()) if (t < s.lastAckTick || t <= tick - this.historySize) s.views.delete(t);
      const bytes = bw.finish(); s.lastSnapshotBytes = bytes.length; s.stats.bytesSent += bytes.length;
      this.opts.transport.send(s.conn!, bytes, "unreliable");
      this.flushEvents(s, tick);
      if (this.statics) {
        const rel = grid ? (grid.grid.get(s.clientId)?.chunks ?? NO_CHUNKS) : undefined;
        const msg = this.statics.build(s.static, tick, rel, viewsOf.get(s.clientId) ?? [], this.staticBudgetBytes);
        if (msg) { s.stats.bytesSent += msg.length; this.opts.transport.send(s.conn!, msg, "reliable"); }
      }
    }
    this.perf.sendMs = now() - t1;
    this.pings();
  }

  /**
   * Order by distance to the client's owned entities, discounted by staleness (ticks since last sent).
   * ADR-375: all working storage is reused server-level scratch — the old code allocated a Float64Array,
   * an order array, a sorted score copy, and head/tail arrays (+ a concat copy) per client per tick.
   * Returns the reused prioOrder buffer: only the first `ids.length` entries are valid, and the caller
   * must consume it before the next prioritize() call. The order produced is identical to the old code:
   * same scores, same stable sort, same threshold/head/tail partition (including ties at the threshold,
   * which fill `head` in index order until `limit`, with the rest in `tail` in index order).
   */
  private prioritize(ids: number[], s: SessionState, owned: Entity[], tick: number, limit = ids.length): number[] {
    const w = this.world; const tf = w.store(Transform); const px = this.posX, py = this.posY;
    const n = ids.length;
    const cx = this.prioCx, cy = this.prioCy; cx.length = 0; cy.length = 0;
    for (const e of owned) { const i = entityIndex(e); if (tf.has(i)) { const sl = tf.slot(i); cx.push(tf.data.x[sl]!); cy.push(tf.data.y[sl]!); } }
    if (this.prioScore.length < n) { const c = Math.max(n, (this.prioScore.length || 64) * 2); this.prioScore = new Float64Array(c); this.prioSorted = new Float64Array(c); }
    const score = this.prioScore;
    for (let k = 0; k < n; k++) {
      const id = ids[k]!; let d2 = 0;
      const x = id < px.length ? px[id]! : NaN, y = id < py.length ? py[id]! : NaN;
      if (cx.length && x === x) {
        d2 = Infinity;
        for (let c = 0; c < cx.length; c++) { const dx = x - cx[c]!, dy = y - cy[c]!; const d = dx * dx + dy * dy; if (d < d2) d2 = d; }
      }
      const ls = id < s.lastSent.length ? s.lastSent[id]! : 0; const stale = ls ? tick + 1 - ls : 1;
      score[k] = d2 / (stale * stale);
    }
    const order = this.prioOrder; order.length = n;
    for (let k = 0; k < n; k++) order[k] = k;
    if (limit <= 0) return order; // old code: threshold undefined, every index lands in `tail` in order
    if (limit >= n) { order.sort((a, b) => score[a]! - score[b]!); return order; }
    // Only the first ~limit can fit the budget: find the score threshold with a typed-array sort, fully order just those.
    const sorted = this.prioSorted; sorted.set(score.subarray(0, n)); sorted.subarray(0, n).sort();
    const thr = sorted[limit - 1]!;
    const head = this.prioHead, tail = this.prioTail; head.length = 0; tail.length = 0;
    for (let k = 0; k < n; k++) (score[k]! <= thr && head.length < limit ? head : tail).push(k);
    head.sort((a, b) => score[a]! - score[b]!);
    for (let k = 0; k < head.length; k++) order[k] = head[k]!;
    for (let k = 0; k < tail.length; k++) order[head.length + k] = tail[k]!;
    return order;
  }

  private flushEvents(s: SessionState, tick: number): void {
    if (!s.events.length) return;
    for (const reliable of [true, false]) {
      const list = s.events.filter((e) => e.reliable === reliable); if (!list.length) continue;
      const w = new BitWriter(); writeHeader(w, MsgType.Events); w.writeBits(tick, 32); w.writeVarUint(list.length);
      for (const ev of list) { w.writeVarUint(this.events.id(ev.def)); writePayload(w, ev.def, ev.payload); }
      this.opts.transport.send(s.conn!, w.finish(), reliable ? "reliable" : "unreliable");
    }
    s.events.length = 0;
  }
}

/** ADR-375: the cached record keeps its writer (written once, never mutated after) so appendWriter() can read it without a snapshotBits() byte copy. */
interface EncodedRecord { w: BitWriter; bits: number; id: number }
const NO_BASE = Symbol("full");
const NO_CHUNKS: ReadonlySet<string> = new Set();
const now = (): number => (globalThis as { performance?: { now(): number } }).performance?.now() ?? 0;
