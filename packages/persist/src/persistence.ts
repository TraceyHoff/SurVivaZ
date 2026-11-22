import { entityIndex, migrateSkinTone, Owner, Season, TimeOfDay, Transform, type ComponentStore, type Entity, type World } from "@engine/core";
import { ChunkMembership, decodeChunk, encodeChunk, parseChunkKey, chunkKeyOf, type BuildingGrid, type Chunk, type ChunkKey, type AsyncChunkProvider, type ChunkManager, type ChunkProvider, type GeneratedChunk, type NodePlacement } from "@engine/world";
import { decodePlayerInto, encodePlayer, PLAYER_VERSION, type PlayerCodecOptions, type PlayerRestoreResult } from "./playerCodec.js";
import { SocialSaver, type SocialState } from "./social.js";
import { ensureAppearance, type AppearanceRepair } from "./appearance.js";
import type { CosmeticCatalogLike } from "@engine/core";
import { DEFAULT_MIGRATIONS, migrateChunkBytes, type AddedFields } from "./migrate.js";
import { chunkFormatOf, type BatchHandle, type SaveBatch, type StoredChunk, type StoredRecord, type WorldMeta, type WorldStore } from "./types.js";

/**
 * A per-chunk blob owned by another system, stored next to the chunk row (records table: ns = `ns`, id = chunk
 * key, chunk = chunk key) and written in the same transaction. Used for gameplay's structure codec (STRC): build
 * pieces and their attachments are entities, but gameplay saves them itself, so persist must not save them again
 * through the chunk codec (`owns`).
 */
export interface ChunkSidecar {
  /** Records namespace, e.g. "chunk.structures". */
  readonly ns: string;
  /** Blob for a resident chunk; undefined = nothing to keep (the stored row, if any, is deleted). */
  encode(world: World, cx: number, cy: number): Uint8Array | undefined;
  /** Version byte(s) of a blob, stored in the record's `format` column. */
  format(bytes: Uint8Array): number;
  /** Recreates the chunk's content; returns every entity it spawned (they are not treated as new changes). */
  decode(world: World, cx: number, cy: number, bytes: Uint8Array): Entity[];
  /** Drops the chunk's content from the world after it was saved (no destruction rules). */
  unload(world: World, key: ChunkKey): void;
  /** Bumped on every change of the chunk's content (dirty tracking without per-tick scans). */
  version(world: World, key: ChunkKey): number;
  /** Entities this sidecar saves: excluded from the chunk codec's entity list. */
  owns(world: World, e: Entity): boolean;
  /** Encode cost hint (e.g. piece count) for the autosave budget. */
  size?(world: World, key: ChunkKey): number;
  /**
   * Migration: the chunk row was written before this sidecar existed and its entity list contains entities the
   * sidecar owns (decoded as plain entities). Adopt them (or replace them) and return the entities that now exist.
   * The chunk is re-saved in the new layout by the next autosave. Default: keep them as decoded.
   */
  migrate?(world: World, cx: number, cy: number, legacy: Entity[]): Entity[];
}

export interface WorldPersistenceOptions {
  world: World;
  store: WorldStore;
  /** Fallback when the store has no row for a chunk (and the source of resource-node placements). */
  generator: ChunkProvider;
  buildings?: BuildingGrid;
  tickHz?: number;
  /** Autosave period for dirty chunks (default 30 s). 0 disables. */
  autosaveSeconds?: number;
  /** Periodic save of online players (default 60 s). 0 disables. */
  playerSaveSeconds?: number;
  /** Max wall-clock ms per tick spent encoding an autosave round (default 1.5). At least one chunk per tick. */
  encodeBudgetMs?: number;
  /**
   * Entities saved with their chunk. Default: has a `persistent` component other than Transform and is not owned by
   * a client (players are saved separately, keyed by account token).
   */
  persistEntity?: (world: World, e: Entity) => boolean;
  /** Entities destroyed when their chunk unloads. Default: every non-player entity with Transform in the chunk. */
  despawnOnUnload?: (world: World, e: Entity) => boolean;
  /**
   * When a chunk comes from storage, still hand the generator's resource-node placements to onLoad (default true).
   * Needed while gameplay's ResourceNode is not a persistent component; nodes then respawn full after reload.
   * A function decides per stored chunk from its decoded entities (ADR-134: the server regenerates only chunks
   * saved before nodes were persisted, i.e. with no node/regrow entity, so depletion survives restarts).
   */
  regenerateNodes?: boolean | ((world: World, entities: readonly Entity[]) => boolean);
  /**
   * ADR-429: when a stored chunk keeps its own nodes (regenerateNodes false for that chunk), fill in the
   * wild-crop / fruit-tree kinds its generation predates: return extra node placements to hand to onLoad
   * with the chunk (they spawn and persist exactly like generated nodes). Only called for stored chunks
   * whose nodes are NOT regenerated; a fresh chunk (or a regenerated one) never calls it. The callback
   * must be deterministic and idempotent — kinds it added and saved are present on the next load, so a
   * second call returns nothing further.
   */
  topUpNodes?: (world: World, chunk: Chunk, entities: readonly Entity[]) => NodePlacement[];
  /** ADR-514: records saved at a tick below `beforeTick` predate the floor-height stamp; `fix` re-seats one loaded entity
   *  (chunk entity or restored player) and returns whether it changed it. */
  legacyZ?: { beforeTick: number; fix: (world: World, e: Entity) => boolean };
  player?: PlayerCodecOptions;
  /**
   * Component schema migrations applied to stored chunk rows (and, unless `player.migrations` is set, player records)
   * whose schema hash is an older layout. Default DEFAULT_MIGRATIONS (crafterId on Inventory/Container, filled 0).
   */
  migrations?: readonly AddedFields[];
  /** With a catalog, restored players get `ensureAppearance` (default for old saves, clamp repair otherwise). */
  appearance?: { catalog: CosmeticCatalogLike };
  /**
   * World-level social state to save with every autosave round / saveAll (only records that changed): core's
   * GroupRegistry (blob "groups", core format v2) and ClaimRegistry (blob "claims"). Load it with `loadSocial(store)`
   * and hand the same objects to `installPermissions`.
   */
  social?: SocialState;
  /** Extra world meta fields saved with every meta write (e.g. gameplay world rules, ADR-121). */
  extraMeta?: () => Partial<WorldMeta>;
  /** Per-chunk blobs owned by other systems (gameplay structures). See ChunkSidecar. */
  sidecars?: readonly ChunkSidecar[];
  /** Injected wall clock for the encode budget / stats (persist is infrastructure, not sim). */
  now?: () => number;
  log?: (msg: string) => void;
  onDecodeError?: (key: ChunkKey, err: unknown) => void;
}

export interface PersistenceStats {
  dirtyChunks: number;
  roundsCompleted: number;
  /** Chunks encoded in the last completed round. */
  lastRoundChunks: number;
  /** Ticks the last round spanned. */
  lastRoundTicks: number;
  /** Total encode ms of the last round (spread over lastRoundTicks). */
  lastRoundEncodeMs: number;
  /** Persistence ms in the most recent tick / worst tick since reset (tracking + encoding + posting). */
  lastTickMs: number;
  maxTickMs: number;
  chunksLoadedFromStore: number;
  chunksGenerated: number;
  /** ADR-429: node placements returned by the topUpNodes hook, across all stored-chunk loads. */
  topUpNodesAdded: number;
  chunksSavedOnUnload: number;
  playersSaved: number;
  decodeErrors: number;
  /** Async backends: chunk reads issued / answered after ChunkManager stopped wanting the chunk (not decoded). */
  /** Chunks whose stored row carried sidecar-owned entities (pre-sidecar save) and were migrated. */
  migratedChunks: number;
  /** ADR-245: Appearance rows (chunk entities + restored players) whose legacy skinTone was remapped on load. */
  skinTonesMigrated: number;
  asyncReads: number;
  asyncLateDropped: number;
  socialSaves: number;
}

interface Round { batch: BatchHandle; queue: ChunkKey[]; encoded: Set<ChunkKey>; requeued: Set<ChunkKey>; startTick: number; encodeMs: number; count: number; flushPlayers: boolean }

const isPlayer = (w: World, e: Entity): boolean => w.has(e, Owner) && w.getField(e, Owner, "clientId") !== 0;

/**
 * Chunk + player persistence on top of a WorldStore.
 *
 * - `provider` (give it to ChunkManager): store row -> decodeChunk, else generator. Untouched generated chunks are
 *   never written, so storage grows with what players changed, not with world size.
 * - Dirty tracking (O(changes) per tick, postSim system `persist.track`): chunk tile version, building place/remove,
 *   and persistent-entity add/change/move/remove via a ChunkMembership.
 * - Autosave (`persist.autosave`): every N s, dirty resident chunks are encoded ON the tick within a wall-clock
 *   budget (default 1.5 ms/tick), parts are posted to the store as they are encoded, and the whole round commits as
 *   ONE transaction off-thread. A chunk dirtied again after it was encoded in the running round is re-encoded once.
 * - onUnload: encode (if dirty) into the running round or its own batch, then despawn the chunk's entities and drop
 *   its buildings. Players: `trackPlayer/untrackPlayer`, `savePlayer`, `restorePlayer`, periodic save.
 * - World-level social state (`social`: GroupRegistry + ClaimRegistry) rides along with each autosave round's final
 *   part and saveAll when it changed; `allocatePlayerId()` hands out persistent account ids.
 * - Async stores (IndexedDB): `provider` is an AsyncChunkProvider (deduped reads, late results never decoded).
 * - `saveAll()` for graceful shutdown.
 */
export class WorldPersistence {
  readonly world: World;
  readonly store: WorldStore;
  readonly membership: ChunkMembership;
  /**
   * Give this to ChunkManager. Sync stores (SQLite, memory): always answers synchronously. Async stores
   * (`readChunkAsync`, IndexedDB): a Promise unless the row is in the store's pending overlay. Concurrent loads of a
   * key share one read; a read that resolves after ChunkManager dropped the request is discarded WITHOUT decoding
   * (decoding spawns the chunk's entities), and a re-request while the read is in flight reuses it.
   */
  readonly provider: AsyncChunkProvider;
  readonly social: SocialState | undefined;
  private socialSaver: SocialSaver | undefined;
  private nextPlayerId: number;
  private reads = new Map<ChunkKey, Promise<GeneratedChunk | undefined>>();
  readonly stats: PersistenceStats = {
    dirtyChunks: 0, roundsCompleted: 0, lastRoundChunks: 0, lastRoundTicks: 0, lastRoundEncodeMs: 0, lastTickMs: 0, maxTickMs: 0,
    chunksLoadedFromStore: 0, chunksGenerated: 0, topUpNodesAdded: 0, chunksSavedOnUnload: 0, playersSaved: 0, decodeErrors: 0,
    migratedChunks: 0, skinTonesMigrated: 0, asyncReads: 0, asyncLateDropped: 0, socialSaves: 0,
  };
  private chunks: ChunkManager | undefined;
  private dirty = new Set<ChunkKey>();
  private savedVersion = new Map<ChunkKey, number>();
  /** Sidecar version at the last save/load, per sidecar index, per chunk. */
  private savedSide = new Map<ChunkKey, number[]>();
  private readonly sidecars: readonly ChunkSidecar[];
  /** Chunks whose stored row could not be decoded: never overwritten this session (keeps the data for a migration). */
  private readOnly = new Set<ChunkKey>();
  private persisted = new Set<Entity>();
  private fresh = new Set<Entity>();
  private round: Round | undefined;
  private online = new Map<string, { entity: Entity; name: string }>();
  private quiet = false;
  private tickMs = 0;
  /** Encode cost model for the per-tick budget: ms ~= msBase + msPerPiece * anchored pieces (both EWMAs, conservative start). */
  private msBase = 0.1; private msPerPiece = 0.0005;
  private readonly autosaveTicks: number; private readonly playerTicks: number; private readonly budget: number;
  private readonly persistEntity: (w: World, e: Entity) => boolean;
  /** ADR-245: chunks whose legacy skin tones were remapped on load; marked dirty on the next track(). */
  private readonly skinDirty = new Set<ChunkKey>();
  private readonly despawn: (w: World, e: Entity) => boolean;
  private readonly now: () => number;
  private persistentStores: ComponentStore[];
  private nextAutosave: number; private nextPlayerSave: number;

  constructor(private readonly opts: WorldPersistenceOptions) {
    this.world = opts.world; this.store = opts.store;
    const hz = opts.tickHz ?? 20;
    this.autosaveTicks = Math.round((opts.autosaveSeconds ?? 30) * hz);
    this.playerTicks = Math.round((opts.playerSaveSeconds ?? 60) * hz);
    this.budget = opts.encodeBudgetMs ?? 1.5;
    this.now = opts.now ?? (() => performance.now());
    this.persistentStores = this.world.componentStores.filter((s) => s.def.persistent);
    const extra = this.persistentStores.filter((s) => s.def !== (Transform as unknown));
    this.sidecars = opts.sidecars ?? [];
    const base = opts.persistEntity ?? ((w: World, e: Entity) => { const i = entityIndex(e); return w.isAlive(e) && !isPlayer(w, e) && extra.some((s) => s.has(i)); });
    this.persistEntity = this.sidecars.length ? (w, e) => base(w, e) && !this.ownedBySidecar(e) : base;
    this.despawn = opts.despawnOnUnload ?? ((w, e) => !isPlayer(w, e));
    this.nextAutosave = this.world.tick + this.autosaveTicks; this.nextPlayerSave = this.world.tick + this.playerTicks;
    this.membership = new ChunkMembership(this.world);
    this.membership.onMove = (e, from, to) => {
      if (this.quiet || this.fresh.has(e)) return;
      if (this.persisted.has(e) || this.persistEntity(this.world, e)) {
        if (from !== undefined) this.markDirty(from);
        if (to !== undefined) { this.markDirty(to); this.persisted.add(e); } else this.persisted.delete(e);
      }
    };
    this.provider = this.store.readChunkAsync ? { load: (cx, cy) => this.loadAsync(cx, cy) } : { load: (cx, cy) => this.load(cx, cy) };
    this.social = opts.social;
    if (opts.social) this.socialSaver = new SocialSaver(opts.social, this.store);
    this.nextPlayerId = Math.max(1, this.store.readMeta()?.nextPlayerId ?? 1);
    if (opts.buildings) {
      const b = opts.buildings; const prevPlace = b.onPlace, prevRemove = b.onRemove;
      b.onPlace = (i) => { prevPlace?.(i); if (!this.quiet) this.markDirty(chunkKeyOf(i.tx, i.ty)); };
      b.onRemove = (i) => { prevRemove?.(i); if (!this.quiet) this.markDirty(chunkKeyOf(i.tx, i.ty)); };
    }
  }

  /** Wire into a ChunkManager built with `provider`. Registers postSim systems persist.track + persist.autosave. */
  attach(chunks: ChunkManager): this {
    this.chunks = chunks;
    chunks.onUnload((c) => this.onUnload(c.key));
    this.membership.rebuild();
    const w = this.world;
    w.addSystem("postSim", "persist.track", () => { const t0 = this.now(); this.track(); this.tickMs = this.now() - t0; });
    w.addSystem("postSim", "persist.autosave", () => {
      const t0 = this.now(); this.autosaveStep();
      this.stats.lastTickMs = this.tickMs + (this.now() - t0); this.stats.maxTickMs = Math.max(this.stats.maxTickMs, this.stats.lastTickMs);
    });
    if (!this.store.readMeta()) void this.store.write({ meta: this.meta() });
    return this;
  }

  meta(): WorldMeta { return { seed: this.world.seed, tick: this.world.tick, schemaHash: this.world.getSchemaHash(), nextPlayerId: this.nextPlayerId, dayEpochTick: this.world.env(TimeOfDay).epochTick, ...(this.world.isRegistered(Season) && this.world.has(this.world.environment, Season) ? { seasonOffsetDays: this.world.env(Season).offsetDays, seasonLengthDays: this.world.env(Season).lengthDays } : {}), ...(this.opts.extraMeta?.() ?? {}) }; }
  /**
   * Hands out the next account PlayerId (core `PlayerId`, persistent: it is saved in the player record). The counter
   * is written right away, ahead of any player row that could carry the id, so ids are never reused after a crash.
   */
  allocatePlayerId(): number {
    const id = this.nextPlayerId++;
    void this.store.write({ meta: this.meta() }).catch((e) => this.opts.log?.(`persist: meta save failed: ${String(e)}`));
    return id;
  }
  /** Changed social state: groups / claims as blobs, names / sales as records; {} without `social`. */
  private socialPart(force = false): Pick<SaveBatch, "blobs" | "records" | "deleteRecords"> {
    const sv = this.socialSaver; if (!sv) return {};
    const blobs = sv.changed(this.world.tick, force); const { records, deleteRecords } = sv.changedRecords(this.world.tick, force);
    this.stats.socialSaves += blobs.length + records.length;
    return { ...(blobs.length ? { blobs } : {}), ...(records.length ? { records } : {}), ...(deleteRecords.length ? { deleteRecords } : {}) };
  }
  /** Writes groups / claims now if they changed (own transaction). */
  saveSocial(): Promise<void> {
    const part = this.socialPart(); if (!part.blobs && !part.records && !part.deleteRecords) return Promise.resolve();
    const p = this.store.write({ ...part, meta: this.meta() }); p.catch(() => this.socialSaver?.invalidate()); return p;
  }
  /** Mark a chunk for the next autosave (e.g. gameplay changed building hp, which has no hook yet). */
  markDirty(key: ChunkKey): void {
    if (this.readOnly.has(key)) return;
    const r = this.round;
    if (r && r.encoded.has(key) && !r.requeued.has(key)) { r.encoded.delete(key); r.requeued.add(key); r.queue.push(key); return; }
    this.dirty.add(key);
  }
  private ownedBySidecar(e: Entity): boolean { for (const sc of this.sidecars) if (this.world.isAlive(e) && sc.owns(this.world, e)) return true; return false; }
  private sideVersions(key: ChunkKey): number[] { return this.sidecars.map((sc) => sc.version(this.world, key)); }
  isDirty(key: ChunkKey): boolean { return this.dirty.has(key) || this.versionChanged(key); }
  get roundInProgress(): boolean { return this.round !== undefined; }
  resetMaxTick(): void { this.stats.maxTickMs = 0; }

  // ---------------- chunks ----------------
  private load(cx: number, cy: number): GeneratedChunk | undefined { return this.fromRecord(cx, cy, this.store.readChunk(`${cx},${cy}`)); }
  private loadAsync(cx: number, cy: number): GeneratedChunk | undefined | Promise<GeneratedChunk | undefined> {
    const key: ChunkKey = `${cx},${cy}`;
    const hot = this.store.readChunk(key); if (hot) return this.fromRecord(cx, cy, hot); // pending overlay / cache: sync
    if (this.store.hasChunk?.(key) === false && !this.reads.has(key)) return this.fromRecord(cx, cy, undefined); // never saved: generator, sync
    const inflight = this.reads.get(key); if (inflight) return inflight; // dedup (also a re-request after a drop)
    this.stats.asyncReads++;
    const p = this.store.readChunkAsync!(key).then((rec) => {
      this.reads.delete(key);
      // Late result: ChunkManager no longer waits for this chunk. Do not decode (it would spawn entities nobody owns).
      if (this.chunks && !this.chunks.isPending(key)) { this.stats.asyncLateDropped++; return undefined; }
      return this.fromRecord(cx, cy, rec);
    }, (err: unknown) => { this.reads.delete(key); throw err; });
    this.reads.set(key, p);
    return p;
  }
  /** Stored row -> decodeChunk (entities spawned, buildings placed), else the generator. */
  private fromRecord(cx: number, cy: number, rec: StoredChunk | undefined): GeneratedChunk | undefined {
    const gen = this.opts.generator;
    if (rec) {
      this.quiet = true;
      try {
        const up = migrateChunkBytes(this.world, rec.bytes, this.opts.migrations ?? DEFAULT_MIGRATIONS);
        if (up) { this.stats.migratedChunks++; this.opts.log?.(`persist: ${rec.key}: schema-migrated (added fields zero-filled)`); }
        const d = decodeChunk(up ?? rec.bytes, { world: this.world, ...(this.opts.buildings ? { buildings: this.opts.buildings } : {}) });
        for (const e of d.entities) { this.fresh.add(e); this.persisted.add(e); }
        // ADR-245: legacy 12-tone skinTone rows (skinScheme 0) -> the 18-tone palette; re-saved on the next autosave
        let skins = 0; for (const e of d.entities) if (migrateSkinTone(this.world, e)) skins++;
        if (skins) { this.stats.skinTonesMigrated += skins; this.skinDirty.add(d.chunk.key); // dirtied in track(), after membership has seen the loaded entities (else the chunk would save empty)
          this.opts.log?.(`persist: ${rec.key}: ${skins} legacy skin tone(s) remapped`); }
        // ADR-514: z of entities saved before the floor stamp (pre-ADR-511 3-level floors) -> the current floor
        const lz = this.opts.legacyZ; if (lz && rec.tick < lz.beforeTick) { let n = 0; for (const e of d.entities) if (lz.fix(this.world, e)) n++;
          if (n) { this.skinDirty.add(d.chunk.key); this.opts.log?.(`persist: ${rec.key}: ${n} legacy floor height(s) re-seated`); } }
        this.savedVersion.set(d.chunk.key, d.chunk.version); this.stats.chunksLoadedFromStore++;
        this.loadSidecars(cx, cy, d.chunk.key, d.entities);
        const rg = this.opts.regenerateNodes;
        const regen = typeof rg === "function" ? rg(this.world, d.entities) : rg !== false;
        // ADR-429: a stored chunk that keeps its own nodes gets the wild-crop / fruit-tree kinds its
        // generation predates; a regenerated chunk already has the generator's full (correct-band) set.
        // The top-up nodes spawn in onLoad (postSim, after persist.track), so their change bits are
        // cleared before track() ever sees them — mark the chunk dirty here, or the first top-up would
        // never be saved and every load would re-add the same nodes. The next load then finds the
        // kinds present and the hook returns nothing (idempotent).
        let nodes: NodePlacement[];
        if (regen) nodes = gen.load(cx, cy)?.nodes ?? [];
        else {
          nodes = this.opts.topUpNodes?.(this.world, d.chunk, d.entities) ?? [];
          this.stats.topUpNodesAdded += nodes.length;
          if (nodes.length) this.markDirty(d.chunk.key);
        }
        return { chunk: d.chunk, nodes };
      } catch (err) {
        this.stats.decodeErrors++; this.readOnly.add(rec.key);
        this.opts.onDecodeError?.(rec.key, err); this.opts.log?.(`persist: chunk ${rec.key} failed to decode (${String(err)}); using generator, row kept read-only`);
      } finally { this.quiet = false; }
    }
    const g = gen.load(cx, cy);
    if (g) {
      this.savedVersion.set(g.chunk.key, g.chunk.version); this.stats.chunksGenerated++;
      if (this.sidecars.length) { this.quiet = true; try { this.loadSidecars(cx, cy, g.chunk.key, []); } finally { this.quiet = false; } }
    }
    return g;
  }
  /**
   * Sidecar rows for a chunk being loaded. A chunk row from before the sidecar existed may carry sidecar-owned
   * entities (e.g. build pieces saved as plain entities): those are handed to `migrate` and the chunk is marked dirty so
   * the next autosave writes the new layout (chunk row without them + sidecar row). If both exist, the sidecar row wins
   * and the legacy entities are dropped.
   */
  private loadSidecars(cx: number, cy: number, key: ChunkKey, decoded: readonly Entity[]): void {
    if (!this.sidecars.length) return;
    const w = this.world;
    this.sidecars.forEach((sc) => {
      const legacy = decoded.filter((e) => w.isAlive(e) && sc.owns(w, e));
      const row = this.store.readRecord(sc.ns, key);
      if (row) {
        for (const e of legacy) { this.persisted.delete(e); this.fresh.delete(e); if (w.isAlive(e)) w.destroy(e); }
        if (legacy.length) { this.markDirty(key); this.stats.migratedChunks++; }
        try { for (const e of sc.decode(w, cx, cy, row.bytes)) this.fresh.add(e); }
        catch (err) {
          this.stats.decodeErrors++; this.readOnly.add(key); this.opts.onDecodeError?.(key, err);
          this.opts.log?.(`persist: ${sc.ns} ${key} failed to decode (${String(err)}); chunk kept read-only`);
        }
      } else if (legacy.length) {
        for (const e of legacy) this.persisted.delete(e);
        const now = sc.migrate ? sc.migrate(w, cx, cy, legacy) : legacy;
        for (const e of now) this.fresh.add(e);
        this.markDirty(key); this.stats.migratedChunks++;
        this.opts.log?.(`persist: ${key}: migrated ${legacy.length} legacy ${sc.ns} entities to the sidecar layout`);
      }
    });
    this.savedSide.set(key, this.sideVersions(key));
  }
  private versionChanged(key: ChunkKey): boolean {
    const c = this.chunks?.getChunkByKey(key); if (!c) return false;
    if (this.savedVersion.get(key) !== c.version) return true;
    if (!this.sidecars.length) return false;
    const saved = this.savedSide.get(key); const now = this.sideVersions(key);
    return !saved || now.some((v, i) => v !== saved[i]);
  }
  /** Sidecar rows of a resident chunk (upserts, or deletes for sidecars with nothing to keep). */
  private encodeSidecars(key: ChunkKey): Pick<SaveBatch, "records" | "deleteRecords"> {
    if (!this.sidecars.length) return {};
    const { cx, cy } = parseChunkKey(key); const records: StoredRecord[] = []; const deleteRecords: { ns: string; id: string }[] = [];
    for (const sc of this.sidecars) {
      const bytes = sc.encode(this.world, cx, cy);
      if (bytes) records.push({ ns: sc.ns, id: key, format: sc.format(bytes), bytes, tick: this.world.tick, ownerKind: 0, ownerId: 0, chunk: key });
      else if (this.store.readRecord(sc.ns, key)) deleteRecords.push({ ns: sc.ns, id: key });
    }
    this.savedSide.set(key, this.sideVersions(key));
    return { ...(records.length ? { records } : {}), ...(deleteRecords.length ? { deleteRecords } : {}) };
  }
  /** Chunk row + sidecar rows of one resident chunk as one batch part (undefined if not resident / read-only). */
  encodePart(key: ChunkKey): SaveBatch | undefined {
    const rec = this.encode(key); if (!rec) return undefined;
    return { chunks: [rec], ...this.encodeSidecars(key) };
  }
  /** Encode one resident chunk (tiles, buildings anchored in it, persistent entities in it). */
  encode(key: ChunkKey): StoredChunk | undefined {
    const c = this.chunks?.getChunkByKey(key); if (!c || this.readOnly.has(key)) return undefined;
    const ents: Entity[] = []; for (const e of this.membership.entitiesIn(key)) if (this.persistEntity(this.world, e)) ents.push(e);
    const bytes = encodeChunk(c, { world: this.world, entities: ents, ...(this.opts.buildings ? { buildings: this.opts.buildings } : {}) });
    this.savedVersion.set(key, c.version); c.dirty = false;
    return { key, format: chunkFormatOf(bytes), bytes, tick: this.world.tick };
  }
  private onUnload(key: ChunkKey): void {
    this.skinDirty.delete(key); // unloaded before track(): row left as is, remapped again on the next load
    const r = this.round;
    const needs = this.dirty.has(key) || this.versionChanged(key) || (r !== undefined && r.queue.includes(key) && !r.encoded.has(key));
    if (needs) {
      const part = this.encodePart(key);
      if (part) { if (r) { r.batch.append(part); r.encoded.add(key); r.count++; } else void this.store.write(part).catch((e) => this.opts.log?.(`persist: unload save failed: ${String(e)}`)); this.stats.chunksSavedOnUnload++; }
    }
    this.dirty.delete(key);
    if (r) { r.encoded.add(key); } // already saved (or clean): skip if still queued
    this.quiet = true;
    try {
      for (const sc of this.sidecars) sc.unload(this.world, key);
      for (const e of [...this.membership.entitiesIn(key)]) if (!this.world.isAlive(e)) { this.persisted.delete(e); this.membership.set(e, undefined); } else if (this.despawn(this.world, e)) { this.persisted.delete(e); this.membership.set(e, undefined); this.world.destroy(e); }
      this.opts.buildings?.unloadChunk(key);
    } finally { this.quiet = false; }
    this.savedVersion.delete(key); this.savedSide.delete(key); this.readOnly.delete(key);
  }

  // ---------------- per-tick ----------------
  private track(): void {
    const w = this.world;
    this.membership.update(); // fires onMove for chunk changes, spawns and removals
    if (this.skinDirty.size) { for (const k of this.skinDirty) this.markDirty(k); this.skinDirty.clear(); }
    for (const s of this.persistentStores) {
      for (const i of s.changedIndices()) {
        const e = s.dense[s.slot(i)]! as Entity; if (this.fresh.has(e)) continue;
        if (this.sidecars.length && this.ownedBySidecar(e)) { const k = this.membership.chunkOf(e); if (k !== undefined) this.markDirty(k); continue; } // e.g. chest contents
        if (!this.persistEntity(w, e)) {
          if (this.persisted.delete(e)) { const k = this.membership.chunkOf(e); if (k !== undefined) this.markDirty(k); } // stopped being persistent
          continue;
        }
        this.persisted.add(e); const k = this.membership.chunkOf(e); if (k !== undefined) this.markDirty(k);
      }
    }
    this.fresh.clear();
    this.stats.dirtyChunks = this.dirty.size;
  }

  private autosaveStep(): void {
    const t = this.world.tick;
    if (this.playerTicks > 0 && t >= this.nextPlayerSave) { this.nextPlayerSave = t + this.playerTicks; if (this.online.size) void this.savePlayers().catch((e) => this.opts.log?.(`persist: player save failed: ${String(e)}`)); }
    if (!this.round && this.autosaveTicks > 0 && t >= this.nextAutosave) {
      this.nextAutosave = t + this.autosaveTicks;
      if (!this.beginRound() && !this.round) void this.saveSocial().catch((e) => this.opts.log?.(`persist: social save failed: ${String(e)}`));
    }
    if (this.round) this.continueRound(this.budget);
  }

  /** Starts an autosave round (no-op if one is running). Returns false if there was nothing to save. */
  beginRound(): boolean {
    if (this.round || !this.chunks) return false;
    const queue: ChunkKey[] = [];
    for (const c of this.chunks.loadedChunks()) if (this.dirty.has(c.key) || this.versionChanged(c.key)) queue.push(c.key);
    this.dirty.clear(); this.stats.dirtyChunks = 0;
    if (!queue.length) return false;
    this.round = { batch: this.store.openBatch(), queue, encoded: new Set(), requeued: new Set(), startTick: this.world.tick, encodeMs: 0, count: 0, flushPlayers: false };
    return true;
  }
  /** Encodes queued chunks until `budgetMs` is used (always at least one), posts them, commits when the queue is empty. */
  continueRound(budgetMs: number): Promise<void> | undefined {
    const r = this.round; if (!r) return undefined;
    const t0 = this.now(); const part: StoredChunk[] = []; const records: StoredRecord[] = []; const deletes: { ns: string; id: string }[] = [];
    let n = 0;
    while (r.queue.length) {
      const k = r.queue[0]!; if (r.encoded.has(k)) { r.queue.shift(); continue; }
      // Predict this chunk's cost (building-heavy chunks cost more) and leave it for the next tick if it would
      // overrun the budget. At least one chunk per tick so a round always progresses.
      let pieces = this.opts.buildings?.layer(k)?.anchored.size ?? 0;
      for (const sc of this.sidecars) pieces += sc.size?.(this.world, k) ?? 0;
      const elapsed = this.now() - t0;
      if (n > 0 && elapsed + this.msBase + this.msPerPiece * pieces > budgetMs) break;
      r.queue.shift();
      const c0 = this.now(); const p = this.encodePart(k); const rec = p?.chunks?.[0]; const ms = this.now() - c0;
      if (p?.records) records.push(...p.records); if (p?.deleteRecords) deletes.push(...p.deleteRecords);
      if (pieces < 200) this.msBase = this.msBase * 0.8 + ms * 0.2;
      else this.msPerPiece = Math.max(this.msPerPiece * 0.5, this.msPerPiece * 0.7 + (Math.max(0, ms - this.msBase) / pieces) * 0.3);
      r.encoded.add(k); n++; if (rec) { part.push(rec); r.count++; }
    }
    r.encodeMs += this.now() - t0;
    const batch: SaveBatch = { chunks: part, ...(records.length ? { records } : {}), ...(deletes.length ? { deleteRecords: deletes } : {}) };
    if (!r.queue.length) {
      batch.meta = this.meta(); const sp = this.socialPart();
      if (sp.blobs) batch.blobs = sp.blobs;
      if (sp.records) batch.records = [...(batch.records ?? []), ...sp.records];
      if (sp.deleteRecords) batch.deleteRecords = [...(batch.deleteRecords ?? []), ...sp.deleteRecords];
    }
    if (part.length || batch.meta) r.batch.append(batch);
    if (r.queue.length) return undefined;
    this.round = undefined;
    this.stats.roundsCompleted++; this.stats.lastRoundChunks = r.count; this.stats.lastRoundTicks = this.world.tick - r.startTick + 1; this.stats.lastRoundEncodeMs = r.encodeMs;
    const p = r.batch.commit(); p.catch((e) => { this.socialSaver?.invalidate(); this.opts.log?.(`persist: autosave commit failed: ${String(e)}`); });
    return p;
  }

  // ---------------- players ----------------
  trackPlayer(token: string, entity: Entity, name = ""): void { this.online.set(token, { entity, name }); }
  untrackPlayer(token: string): void { this.online.delete(token); }
  isOnline(token: string): boolean { return this.online.has(token); }
  get onlinePlayers(): ReadonlyMap<string, { entity: Entity; name: string }> { return this.online; }
  hasPlayer(token: string): boolean { return this.store.readPlayer(token) !== undefined; }
  /** Restores a saved player onto `entity`; undefined if the token has no save. */
  restorePlayer(token: string, entity: Entity): (PlayerRestoreResult & { name: string; appearance?: AppearanceRepair }) | undefined {
    const rec = this.store.readPlayer(token); if (!rec) return undefined;
    const r = decodePlayerInto(this.world, entity, rec.bytes, { ...(this.opts.migrations ? { migrations: this.opts.migrations } : {}), ...this.opts.player });
    if (migrateSkinTone(this.world, entity)) this.stats.skinTonesMigrated++; // ADR-245: before the clamp (it would keep a legacy index)
    if (this.opts.legacyZ && rec.tick < this.opts.legacyZ.beforeTick && this.opts.legacyZ.fix(this.world, entity)) this.opts.log?.(`persist: player ${token.slice(0, 8)}…: legacy floor height re-seated`); // ADR-514
    const appearance = this.opts.appearance ? ensureAppearance(this.world, entity, this.opts.appearance.catalog) : undefined;
    return { ...r, name: rec.name, ...(appearance ? { appearance } : {}) };
  }
  /** Encode + queue a player save (its own transaction). */
  savePlayer(token: string, entity: Entity, name?: string): Promise<void> {
    if (!this.world.isAlive(entity)) return Promise.resolve();
    const bytes = encodePlayer(this.world, entity, this.opts.player); this.stats.playersSaved++;
    return this.store.write({ players: [{ token, name: name ?? this.online.get(token)?.name ?? "", format: PLAYER_VERSION, bytes, tick: this.world.tick }] });
  }
  /** Saves every tracked online player in one transaction. */
  savePlayers(): Promise<void> {
    const players = [...this.online].filter(([, p]) => this.world.isAlive(p.entity))
      .map(([token, p]) => ({ token, name: p.name, format: PLAYER_VERSION, bytes: encodePlayer(this.world, p.entity, this.opts.player), tick: this.world.tick }));
    this.stats.playersSaved += players.length;
    return players.length ? this.store.write({ players }) : Promise.resolve();
  }

  /**
   * Full save (graceful shutdown): finishes the running round, encodes every dirty resident chunk and every online
   * player synchronously, commits, and waits until the store has flushed.
   */
  async saveAll(): Promise<{ chunks: number; players: number }> {
    if (!this.round) this.beginRound();
    let chunks = 0;
    if (this.round) { chunks = this.round.queue.length; await this.continueRound(Infinity); }
    const players = this.online.size; await this.savePlayers();
    await this.store.write({ meta: this.meta(), ...this.socialPart() });
    await this.store.flush();
    return { chunks, players };
  }
  /** Parsed coordinates of a key (re-export convenience). */
  static coords(k: ChunkKey): { cx: number; cy: number } { return parseChunkKey(k); }
}
