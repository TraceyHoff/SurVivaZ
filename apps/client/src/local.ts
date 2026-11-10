/**
 * Local/offline mode: the authoritative server game module (@engine/server/game, the same code `pnpm demo` runs)
 * hosted in the browser over @engine/net's in-memory LoopbackNetwork, with browser-safe persistence
 * (IndexedDB when available, else memory). Singleplayer by default: the population spawner fills the world with
 * zombies, animals and human bots. Human bots are VIRTUAL PLAYERS: real loopback NetClients (own replica, own
 * PlayerId/account/inventory) driven by an AgentController that only emits the input stream a human sends.
 * mode: "multiplayer" allows human bots only when AI humans are on (Task 22 world rule; a save keeps its own value).
 */
import { CommandRegistry, DEFAULT_TICK_HZ, FixedLoop, Owner, Transform, World, type CosmeticCatalogLike, type Agent, type AgentOutput, type Entity } from "@engine/core";
import { Respawned, TRAVEL, markSpawnOffscreen, offscreenStep, setAiHomeLocator, spawnedOffscreen, travelKeepsHome, wantsOffscreen } from "@engine/gameplay";
import { Animal, Dead, Health, ResourceNode, Zombie, agentOutputFrame, agentOutputIntents, applyAgentEmote, buildAgentSelf, buildAgentView, type AgentWorldView, flushSocialMemory, makeAgent, makeAgentIdentity, survivorController, HOME_MAX_DIST, aiMemoryOf, baseHome, flushAiMemory, flushAiLife, flushDefenceMemory, RespawnCmd, agentStanceInput, fillStanceSensors, stanceMode, StanceMode, GameplayEdgeBits } from "@engine/gameplay";
import { ChatChannel, DirectClient, LoopbackNetwork, MultiServerTransport, NetClient, type ClientTransport, type ServerTransport } from "@engine/net";
import { ClaimAccount, IndexedDbWorldStore, MemoryWorldStore, SetName, nameToWords, tokenToWords, type WorldStore } from "@engine/persist";
import { detectDevice, isMobileHost, type DeviceHints } from "./p2p.js";
import { MEMORY_BUDGETS } from "./memory-budget.js";
import { createGameServer, giveBotAppearance, type GameMode, type GameServer } from "@engine/server/game";
import { chunkKeyOf, randomWorldSeed } from "@engine/world";
import { Act, applyDemoInput, VEHICLE_CLIENT_OPTIONS, installDemoWorld, DEMO_COMMANDS, DEMO_EVENTS } from "@engine/server/protocol";

/** Device-scaled default bot cap (ADR-105): phones get far fewer bots than desktops. */
export const MOBILE_MAX_BOTS = 8;
export const DESKTOP_MAX_BOTS = 32;
/** ADR-110: wildlife caps follow the bot budget (mobile hosts get fewer animals), x0.6 under ?gl=lowend / ?safe=1. */
export function animalCapMulFor(maxBots: number, lowEnd = false): number { return Math.min(1, Math.max(0.4, maxBots / DESKTOP_MAX_BOTS)) * (lowEnd ? 0.6 : 1); }
function lowEndQuery(): boolean { try { const q = new URLSearchParams(globalThis.location?.search ?? ""); return q.get("gl") === "lowend" || q.get("safe") === "1"; } catch { return false; } }
export function defaultMaxBots(d: DeviceHints = detectDevice()): number { return isMobileHost(d) ? MOBILE_MAX_BOTS : d.console ? MEMORY_BUDGETS.console.maxBots : DESKTOP_MAX_BOTS; } // ADR-212: console memory profile

export interface LocalServerOptions {
  store?: WorldStore; seed?: number;
  /** ADR-121: world rules for a new world (hordes on/off, grace days). */
  worldRules?: { hordes?: boolean; hordeGraceDays?: number; /** Task 22: AI humans spawn / are recruitable (default on). */ aiHumans?: boolean };
  /** Default "singleplayer". "multiplayer" allows human bots only when AI humans are on (Task 22). */
  mode?: GameMode;
  /** Dev: connect this many virtual players immediately at spawn (in addition to natural spawns; singleplayer only). */
  bots?: number;
  /** ADR-140 dev/QA sandbox (?dev=sandbox): starter kit + shared spawn. */
  devSandbox?: boolean;
  /** Ambient population spawner (zombies, animals, bots). Default true. */
  population?: boolean;
  /**
   * Population config (ADR-105): cap on live virtual players (initial `bots` + population-spawned human bots). Default
   * `defaultMaxBots()` = MOBILE_MAX_BOTS on phones / tablets (coarse pointer or UA mobile), DESKTOP_MAX_BOTS elsewhere.
   */
  maxBots?: number;
  /** ADR-116: far-bot perception period override (default agentLodEvery(): 1 on strong CPUs, else AGENT_LOD_EVERY). */
  agentLodEvery?: number;
  /** ADR-110: low-end quality (fewer animals); default from ?gl=lowend / ?safe=1. */
  lowEnd?: boolean;
  /** Unused (kept for API compatibility); bot behavior is seeded from the world seed. */
  rng?: () => number; log?: (s: string) => void;
  /** Cosmetics catalog: enables customization + random placeholder appearances (players and bots). */
  catalog?: CosmeticCatalogLike;
  /** P2P host: extra server transports (e.g. RtcServerTransport for WebRTC guests) served by the same NetServer. */
  extraTransports?: ServerTransport[];
  /** Player cap incl. the host's own client; extra joins are rejected (ServerFull + serverFullDetail). */
  maxClients?: number; serverFullDetail?: string;
  /** ADR-325: where AI humans spawn (default world-wide points; "starters" = the ADR-106 starter points, for fixtures). */
  aiSpawn?: "world" | "starters";
  /** ADR-295: room-code host identity; absent for ordinary local/singleplayer servers. */
  joinNearClient?: () => number | undefined;
  /** Distant-entity delta throttle forwarded to the NetServer (P2P host; ADR-102). */
  distantThrottle?: { nearTiles: number; interval: number };
}
export interface VirtualPlayer { client: DirectClient; /** the authoritative world (read-only for bots) */ world: World; agent: Agent; output: AgentOutput; home: { x: number; y: number } }
export interface LocalServer {
  game: GameServer; network: LoopbackNetwork;
  /** A fresh client transport connected to this in-memory server (pass to ClientSession.connect / NetClient). */
  createTransport(): ClientTransport;
  /** Advance wall time: delivers loopback messages, steps the server sim and the virtual players. */
  pump(ms: number): void;
  /** Connected virtual players (human bots). Always empty in multiplayer. */
  bots: VirtualPlayer[];
  stop(): Promise<void>;
}

/**
 * Singleplayer local-server lifecycle, for the ?diag=1 overlay and the camera fallback. `store` names the backend actually
 * used; `error` is the last startup problem (also set when the store fell back to memory).
 */
export const localStatus: { state: "idle" | "opening-store" | "starting" | "connecting" | "running" | "failed"; store: string; error: string | undefined } = { state: "idle", store: "", error: undefined };

type IdbFactory = NonNullable<NonNullable<Parameters<typeof IndexedDbWorldStore.open>[1]>["factory"]>;
/**
 * Opens a browser-safe store: IndexedDB if present, else in-memory. Never hangs: an IndexedDB open that is blocked
 * (an older tab / installed PWA still holds the DB during a schema upgrade, onblocked) or simply never answers
 * (seen on Android) falls back to an in-memory world after `timeoutMs`, with `localStatus.error` set. Before this,
 * a stuck open left singleplayer waiting forever: no server, no player, an empty (clear-colour) scene.
 */
export async function openBrowserStore(dbName = "engine-local-world", timeoutMs = 4000): Promise<WorldStore> {
  const idb = (globalThis as { indexedDB?: IdbFactory }).indexedDB;
  if (!idb) { localStatus.store = "memory (no IndexedDB)"; return new MemoryWorldStore(); }
  let blocked = false;
  const factory: IdbFactory = { deleteDatabase: (n) => idb.deleteDatabase(n), open: (n, v) => { const r = idb.open(n, v); (r as { onblocked?: unknown }).onblocked = () => { blocked = true; }; return r; } };
  const opening = IndexedDbWorldStore.open(dbName, { factory });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), timeoutMs); });
  try {
    const r = await Promise.race([opening, timeout]);
    if (r !== "timeout") { localStatus.store = `indexeddb ${dbName}`; return r; }
    localStatus.error = `IndexedDB "${dbName}" ${blocked ? "upgrade blocked (another tab or app still has the game open)" : "did not open"} within ${timeoutMs} ms; this session is not saved`;
    void opening.then((s) => s.close(), () => undefined); // a late open must not keep the DB locked
  } catch (e) {
    localStatus.error = `IndexedDB "${dbName}" failed: ${e instanceof Error ? e.message : String(e)}; this session is not saved`;
  } finally { clearTimeout(timer); }
  console.warn(`[local] ${localStatus.error}`);
  localStatus.store = "memory (fallback)";
  return new MemoryWorldStore();
}

const hex32 = (s: string): string => { let h = 0x811c9dc5, out = ""; for (let k = 0; k < 4; k++) { for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i) ^ k, 0x01000193) >>> 0; out += h.toString(16).padStart(8, "0"); } return out; };

const NO_COMMANDS = new CommandRegistry();
/** Perception LOD for virtual players (ADR-105): tiles from the nearest human, and the far-bot perception period in ticks. */
export const AGENT_LOD_NEAR = 40, AGENT_LOD_EVERY = 4;
/** ADR-116: far bots think every tick on strong desktop/console CPUs (>= 8 threads, not mobile / lowend); else every 4. */
export function agentLodEvery(d: DeviceHints = detectDevice(), cores = globalThis.navigator?.hardwareConcurrency ?? 0, lowEnd = lowEndQuery()): number { return !lowEnd && !isMobileHost(d) && cores >= 8 ? 1 : AGENT_LOD_EVERY; }
/** Snapshot throttle for virtual players: beyond sight (12) / hearing (18) range, deltas every 4 ticks. */
export const BOT_DISTANT_THROTTLE = { nearTiles: 24, interval: 4 } as const;
const ACT_MASK = Act.MoveUp | Act.MoveDown | Act.MoveLeft | Act.MoveRight | Act.Sprint | Act.Gather;
/** Task 22: may this host run virtual players? Singleplayer always; multiplayer only when AI humans are on.
 * Explicit host settings override the save; absent an explicit setting, preserve its rule. */
export function aiHumansOn(o: Pick<LocalServerOptions, "mode" | "worldRules" | "store">): boolean {
  if ((o.mode ?? "singleplayer") === "singleplayer") return true;
  if (o.worldRules?.aiHumans !== undefined) return o.worldRules.aiHumans;
  const saved = o.store?.readMeta()?.aiHumans;
  return saved !== undefined ? saved === 1 : (o.worldRules?.aiHumans ?? true);
}
export async function createLocalServer(o: LocalServerOptions = {}): Promise<LocalServer> {
  // ADR-254: every new playthrough gets a random seed (map / resources / animals differ). A save keeps its own
  // seed via store meta; o.seed (menu / ?seed= / tests) applies only to a new world, matching createGameServer.
  const seed = o.store?.readMeta()?.seed ?? o.seed ?? randomWorldSeed(); const mode: GameMode = o.mode ?? "singleplayer";
  const network = new LoopbackNetwork(seed);
  const transport = network.createServer();
  const serverTransport: ServerTransport = o.extraTransports?.length ? new MultiServerTransport([transport, ...o.extraTransports]) : transport;
  const bots: VirtualPlayer[] = [];
  const controller = survivorController({ seed });
  let slot = 0, stopped = false; const connecting: Promise<void>[] = [];
  const store = o.store;
  // Called from inside the server tick: defer (the handshake must not re-enter game.loop).
  const queued: { x: number; y: number }[] = [];
  let inflight = 0;
  const maxBots = Math.max(0, Math.floor(o.maxBots ?? defaultMaxBots()));
  const connectBot = (x: number, y: number): boolean => { if (bots.length + queued.length + inflight >= maxBots) return false; queued.push({ x, y }); return true; };
  const game = createGameServer({
    animalCapMul: animalCapMulFor(maxBots, o.lowEnd ?? lowEndQuery()),
    transport: serverTransport, ...(store ? { store } : {}), seed, mode, ...(o.devSandbox ? { devSandbox: true } : {}), ...(o.worldRules ? { worldRules: o.worldRules } : {}),
    ...(o.maxClients !== undefined ? { maxClients: o.maxClients } : {}), ...(o.serverFullDetail ? { serverFullDetail: o.serverFullDetail } : {}), ...(o.log ? { log: o.log } : {}), ...(o.catalog ? { catalog: o.catalog, randomAppearance: true } : {}),
    ...(o.joinNearClient ? { joinNearClient: o.joinNearClient } : {}), ...(o.aiSpawn ? { aiSpawn: o.aiSpawn } : {}),
    ...(o.population === false ? { population: false } : {}), ...(o.distantThrottle ? { distantThrottle: o.distantThrottle } : {}),
    // Task 22: the in-process bot host runs whenever AI humans are on — singleplayer always, multiplayer only
    // when the resolved host rule allows it (explicit settings override saved AI policy).
    ...(aiHumansOn(o) ? { virtualPlayers: { connect: connectBot, disconnect: (cid: number) => dropBot(cid) } } : {}),
  });

  async function addBot(x: number, y: number, drive = true): Promise<void> {
    const identity = (() => { const id = makeAgentIdentity(seed, slot++); return { ...id, ...(game.agents.get(id.id) ?? {}) }; })();
    const agent = makeAgent(identity, (seed ^ (slot * 0x9e3779b1)) >>> 0, DEFAULT_TICK_HZ); controller.add(agent);
    // ADR-105: a direct client: no replica world / snapshot decode; it perceives the authoritative world (filtered by
    // sight / hearing in buildAgentView) and sends inputs, commands and chat as ordinary wire messages.
    const client = new DirectClient(game.net, network.createClient());
    const vp: VirtualPlayer = { client, world: game.world, agent, output: { moveX: 0, moveY: 0, aimX: 0, aimY: 0, sprint: false, actions: [] }, home: { x, y } };
    let ok = false, err: unknown; const conn = client.connect().then(() => { ok = true; }, (e: unknown) => { err = e; ok = true; });
    if (drive) for (let k = 0; k < 200 && !ok; k++) { network.advance(10); game.loop.advance(10); await Promise.resolve(); } // handshake on the virtual clock
    else await conn; // progresses as pump() advances the loopback
    if (stopped) { client.close(); controller.remove(agent); return; }
    if (err || !ok) { controller.remove(agent); throw new Error(`virtual player failed to connect: ${String(err ?? "timeout")}`); }
    if (!game.markVirtual(client.clientId)) { controller.remove(agent); client.close(); return; } // refused (multiplayer)
    { // ADR-325: a bot placed far from every human starts in the ADR-324 off-screen sim (hand-back when someone comes near)
      const pe = game.players.get(client.clientId)?.entity; const t = pe !== undefined ? game.world.get(pe, Transform) : undefined;
      if (t) { const r = TRAVEL.offscreen.fullSimTiles; markSpawnOffscreen(agent, humanPositions().every((h) => Math.hypot(h.x - t.x, h.y - t.y) > r)); }
    }
    if (o.catalog) { const pe = game.players.get(client.clientId)?.entity; if (pe !== undefined) giveBotAppearance(game.world, pe, o.catalog, identity.id); } // ADR-252 / ADR-245: a stable look per AI human (all 18 skin tones), replicated
    client.sendCommand(ClaimAccount, tokenToWords(hex32(identity.id))); // persistent account: inventory/stats saved like a human's
    client.sendCommand(SetName, nameToWords(identity.name));
    game.agents.put(identity.id, { ...identity }); // persisted ("agents" records); gameplay updates relationship / party / clan memory via game.agents.put
    bots.push(vp);
  }
  const putAgent = (id: string, partial: Parameters<typeof game.agents.put>[1]): unknown => game.agents.put(id, partial);
  function dropBot(clientId: number): void {
    const i = bots.findIndex((b) => b.client.clientId === clientId); if (i < 0) return;
    const b = bots[i]!; byAgent.delete(b.agent); lodViews.delete(b); offscreen.delete(b); lodPhase.delete(b); flushSocialMemory([b.agent], putAgent, game.world.tick, true); flushAiMemory([b.agent], putAgent, game.world.tick, true); flushAiLife([b.agent], putAgent, game.world.tick, true); flushDefenceMemory([b.agent], putAgent, game.world.tick, true); controller.remove(b.agent); b.client.close(); bots.splice(i, 1); restAt.delete(b);
  }
  // Player/bot entity lookups (ADR-105): game.players already maps clientId -> server entity, and bots perceive the authoritative world through it.
  const serverEntityOf = (cid: number): Entity | undefined => { const p = game.players.get(cid); return p && game.world.isAlive(p.entity) ? p.entity : undefined; };
  // The exact input frame a human client builds: buttons + aim from the agent's output (gameplay intentToFrame).
  // ADR-252: stance actions -> the same Guard / Crouch buttons and Rest edge a player sends (ADR-244). Rest is pressed once
  // (not while already asleep, at most every REST_EVERY ticks): a repeated Rest is a wake input after sleepWakeGraceTicks.
  const restAt = new Map<VirtualPlayer, number>(); const REST_EVERY = 20;
  const sampleOf = (vp: VirtualPlayer): { buttons: number; aimX: number; aimY: number; edges?: number } => {
    const f = agentOutputFrame(vp.output, 0, NO_COMMANDS); // GameplayActions bits 0-5 == Act bits
    let buttons = f.actions & ACT_MASK; const st = agentStanceInput(vp.output);
    // The generic Primary bit aliases legacy Gather. Targeted combat must use the
    // dedicated Attack control: hand/interact deliberately never damages a foe.
    if (agentOutputIntents(vp.output).some((i) => i.kind === "attack")) buttons = (buttons & ~Act.Gather) | Act.Attack;
    if (st.guard) buttons |= Act.Guard; if (st.crouch) buttons |= Act.Crouch;
    if (st.rest) { const e = serverEntityOf(vp.client.clientId); const tick = game.world.tick;
      if (e !== undefined && stanceMode(game.world, e) !== StanceMode.Sleep && tick - (restAt.get(vp) ?? -1e9) >= REST_EVERY) { restAt.set(vp, tick); return { buttons, aimX: f.aimX, aimY: f.aimY, edges: GameplayEdgeBits.Rest }; } }
    return { buttons, aimX: f.aimX, aimY: f.aimY };
  };
  const byAgent = new Map<Agent, VirtualPlayer>();
  const LOD_EVERY = o.agentLodEvery ?? agentLodEvery();
  // Perception LOD (ADR-105): a bot farther than AGENT_LOD_NEAR tiles from every human player rebuilds its world view
  // (the O(entities) perception scan + sensors) only every AGENT_LOD_EVERY ticks, staggered by slot; its self state
  // (position, vitals) is still fresh every tick so steering stays smooth. Near bots perceive every tick.
  const lodViews = new Map<VirtualPlayer, { world: AgentWorldView; tick: number }>();
  const offscreen = new Set<VirtualPlayer>(); // ADR-324: bots on coarse off-screen travel
  // ADR-325: a bot respawned far from every human (a distributed point) also starts off-screen
  game.world.events.on(Respawned as never, (ev: { entity: Entity; x: number; y: number }) => { for (const vp of bots) if (serverEntityOf(vp.client.clientId) === ev.entity) { const r = TRAVEL.offscreen.fullSimTiles; if (humanPositions().every((h) => Math.hypot(h.x - ev.x, h.y - ev.y) > r)) markSpawnOffscreen(vp.agent, true); } });
  // ADR-325: AI respawn goes bed -> home (the remembered base) -> a distributed world spawn point
  setAiHomeLocator(game.world, (e) => { for (const vp of bots) if (serverEntityOf(vp.client.clientId) === e) { const b = aiMemoryOf(vp.agent).base; return b ? baseHome(b) : undefined; } return undefined; });
  let lodSlot = 0; const lodPhase = new Map<VirtualPlayer, number>();
  const humanPositions = (): { x: number; y: number }[] => {
    const out: { x: number; y: number }[] = [];
    for (const p of game.players.values()) { if (p.bot || !game.world.isAlive(p.entity)) continue; const t = game.world.get(p.entity, Transform); if (t) out.push({ x: t.x, y: t.y }); }
    return out;
  };
  const viewFor = (a: Agent, tick: number, humans: readonly { x: number; y: number }[]): ReturnType<typeof buildAgentView> => {
    const vp = byAgent.get(a); const e = vp && serverEntityOf(vp.client.clientId); if (!vp || e === undefined) return undefined;
    const t = vp.world.get(e, Transform); if (!t) return undefined;
    // ADR-203: the server spawns / restores the bot elsewhere than addBot's (x, y) (pickSpawnPoint, saved account); a home
    // hundreds of tiles away made build / sleep / return_home walk across the map forever. Home = where the bot lives.
    // ADR-252: a bot with a base remembers it (AiMemory persists via game.agents): home = inside the base, even after a trip
    // ADR-324: no range cap while travelling (the base and home are kept; only a relocation drops the base). A bot that
    // drifted away without a trip re-anchors like before (it lives where it is now).
    const keep = travelKeepsHome(a, t.x, t.y);
    const mem = aiMemoryOf(a); if (!keep && mem.base && Math.hypot(mem.base.x - t.x, mem.base.y - t.y) > 4 * HOME_MAX_DIST) delete mem.base;
    if (mem.base) { const h = baseHome(mem.base); if (h.x !== vp.home.x || h.y !== vp.home.y) vp.home = h; }
    else if (!keep && Math.hypot(vp.home.x - t.x, vp.home.y - t.y) > HOME_MAX_DIST) vp.home = { x: t.x, y: t.y };
    // ADR-324 off-screen: a travelling bot far from every human is stepped coarsely by the loop (no view, no controller,
    // not a chunk source); back in range (or arrived) it streams again and waits for its chunk before full sim resumes.
    if (wantsOffscreen(a, t.x, t.y, humans)) { if (!offscreen.has(vp)) { offscreen.add(vp); game.setStreaming(vp.client.clientId, false); } return undefined; }
    if (offscreen.has(vp)) { offscreen.delete(vp); game.setStreaming(vp.client.clientId, true); }
    if (humans.length && spawnedOffscreen(a)) markSpawnOffscreen(a, false); // ADR-325: met a human: full sim from now on
    if (humans.length && !game.chunks.activeKeys.has(chunkKeyOf(t.x, t.y))) return undefined; // hand back once the chunk is in
    let near = humans.length === 0; // no human: everyone is "near" (headless tests keep full fidelity)
    for (const h of humans) { const dx = h.x - t.x, dy = h.y - t.y; if (dx * dx + dy * dy <= AGENT_LOD_NEAR * AGENT_LOD_NEAR) { near = true; break; } }
    const cached = lodViews.get(vp);
    let ph = lodPhase.get(vp); if (ph === undefined) lodPhase.set(vp, (ph = lodSlot++ % LOD_EVERY));
    if (!near && cached && tick - cached.tick < LOD_EVERY && (tick + ph) % LOD_EVERY !== 0) {
      const self = buildAgentSelf(vp.world, e, a); if (self) fillStanceSensors(game.world, e, cached.world); return self ? { self, world: cached.world } : undefined; // ADR-252: own stance stays fresh
    }
    const v = buildAgentView(game.world, e, a, vp.home, undefined, nearby(t.x, t.y)); if (v) lodViews.set(vp, { world: v.world, tick }); else lodViews.delete(vp);
    return v;
  };
  // Perception candidates (ADR-105): one spatial hash per agent tick over perceivable kinds (zombie / node / animal /
  // anything with Health); each fresh view scans only the 3x3 cells around the bot (cell >= sight and hearing range).
  const CELL = 24; let gridTick = -1; const cells = new Map<number, Entity[]>(); const pool: Entity[][] = [];
  const cellKey = (cx: number, cy: number): number => (cx + 0x8000) * 0x10000 + (cy + 0x8000);
  const seenIds = new Set<Entity>();
  const rebuildGrid = (): void => {
    for (const l of cells.values()) { l.length = 0; pool.push(l); } cells.clear();
    const w = game.world;
    // Task 29: was a full Transform scan (every entity, 4 has-checks each — ~1.2ms per agent tick in a
    // busy village). Iterate the 4 perceivable kinds directly and dedup (zombies/animals also carry
    // Health, so they appear in two queries). Same entity set as before — buildAgentView only consumes
    // `seen` order-independently (filter/length, .some(), distance-sorted nearest), so the new
    // kind-grouped order changes nothing observable.
    seenIds.clear();
    for (const def of [Zombie, ResourceNode, Animal, Health] as const) {
      for (const e of w.query([def, Transform], [Dead])) {
        if (seenIds.has(e)) continue; seenIds.add(e);
        const k = cellKey(Math.floor((w.getField(e, Transform, "x") ?? 0) / CELL), Math.floor((w.getField(e, Transform, "y") ?? 0) / CELL));
        let l = cells.get(k); if (!l) { l = pool.pop() ?? []; cells.set(k, l); } l.push(e);
      }
    }
  };
  const nearby = (x: number, y: number): Entity[] => {
    if (gridTick !== game.world.tick) { rebuildGrid(); gridTick = game.world.tick; }
    const out: Entity[] = []; const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const l = cells.get(cellKey(cx + dx, cy + dy)); if (l) for (const e of l) out.push(e); }
    return out;
  };
  let lastRespawnTry = -1e9;
  const agentLoop = new FixedLoop({ tickHz: DEFAULT_TICK_HZ, step: () => {
    const tick = game.world.tick; const humans = humanPositions();
    if (byAgent.size !== bots.length) { byAgent.clear(); for (const b of bots) byAgent.set(b.agent, b); }
    const outs = controller.tick(tick, (a) => viewFor(a, tick, humans));
    for (const vp of bots) { const out = outs.get(vp.agent); if (!out) continue; vp.output = out; vp.client.sendInput(sampleOf(vp)); if (out.chat) vp.client.chat.send(ChatChannel.Local, out.chat.text); if (out.emote) { const e = serverEntityOf(vp.client.clientId); if (e !== undefined) applyAgentEmote(game.world, e, out); } if (out.commands) sendAgentCommands(vp.client, out.commands); }
    if (tick - lastRespawnTry >= 40) { lastRespawnTry = tick; for (const vp of bots) { const e = serverEntityOf(vp.client.clientId); if (e !== undefined && game.world.has(e, Dead)) sendAgentCommands(vp.client, [{ type: RespawnCmd.name, payload: {} }]); } // ADR-252: a dead bot presses Respawn like a player (server enforces respawnSeconds)
    }
    if (offscreen.size && tick % TRAVEL.offscreen.stepTicks === 0) for (const vp of offscreen) { const e = serverEntityOf(vp.client.clientId); if (e !== undefined && !game.world.has(e, Dead)) offscreenStep(game.world, e, vp.agent, TRAVEL.offscreen.stepTicks, DEFAULT_TICK_HZ); }
    flushAiMemory(bots.map((b) => b.agent), putAgent, game.world.tick); flushSocialMemory(bots.map((b) => b.agent), putAgent, game.world.tick); flushAiLife(bots.map((b) => b.agent), putAgent, game.world.tick); flushDefenceMemory(bots.map((b) => b.agent), putAgent, game.world.tick); // debounced social-memory write-through
  } });
  const pump = (ms: number): void => {
    for (const q of queued.splice(0)) { inflight++; connecting.push(addBot(q.x, q.y, false).catch((e) => o.log?.(`bot failed: ${String(e)}`)).finally(() => { inflight--; })); }
    network.advance(ms);
    game.loop.advance(ms);
    agentLoop.advance(ms);
  };
  const server: LocalServer = {
    game, network, bots, pump,
    createTransport: () => network.createClient(),
    async stop() { stopped = true; await Promise.allSettled(connecting); flushSocialMemory(bots.map((b) => b.agent), putAgent, game.world.tick, true); flushAiMemory(bots.map((b) => b.agent), putAgent, game.world.tick, true); flushAiLife(bots.map((b) => b.agent), putAgent, game.world.tick, true); flushDefenceMemory(bots.map((b) => b.agent), putAgent, game.world.tick, true); for (const b of bots) b.client.close(); await game.shutdown(); serverTransport.close(); },
  };
  if (mode === "singleplayer") for (let i = 0; i < Math.min(o.bots ?? 0, maxBots); i++) { const sp = game.spawnPoints[i % game.spawnPoints.length]!; await addBot(sp.x + 1, sp.y + 1); } // dev bots over the 4 spawn points (ADR-106)
  return server;
}

/**
 * Sends an agent's discrete commands through the bot's NetClient exactly as human input does (same wire path, rate limits and
 * server validation). Looks the def up by name in DEMO_COMMANDS; entity fields are replica entities, which NetClient.sendCommand
 * maps to network ids. Returns how many were sent (unknown names / unmapped targets are dropped).
 */
export function sendAgentCommands(client: Pick<NetClient, "sendCommand">, cmds: readonly { type: string; payload: unknown }[]): number {
  let n = 0;
  for (const c of cmds) {
    const def = DEMO_COMMANDS.find((d) => d.name === c.type);
    if (def && client.sendCommand(def as never, (c.payload ?? {}) as never)) n++;
  }
  return n;
}
