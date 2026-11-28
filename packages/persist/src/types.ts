import type { ChunkKey } from "@engine/world";

/** One saved chunk row. `format` = the chunk codec version stored in the blob header (encodeChunk). */
export interface StoredChunk { key: ChunkKey; format: number; bytes: Uint8Array; tick: number }
/** One saved player row, keyed by the account/session token (hex). `format` = player record version. */
export interface StoredPlayer { token: string; name: string; format: number; bytes: Uint8Array; tick: number }
/**
 * World-level record that is not per chunk or per player (blobs table), e.g. "groups" (core GroupRegistry format)
 * and "claims" (persist claim format). `format` = the record's own version byte.
 */
export interface StoredBlob { key: string; format: number; bytes: Uint8Array; tick: number }
/**
 * Owner of a generic record, mirroring core's `OwnedBy {playerId, groupId}`: a player (account PlayerId) or a group
 * (party / clan id from GroupRegistry). Plain object (not a const enum) so it survives isolated transpilation.
 */
export const OwnerKind = { None: 0, Player: 1, Group: 2 } as const;
/**
 * Generic, row-per-object world data in a namespace (records table). The extension point for gameplay systems whose
 * state is neither chunk-local entities nor one small world blob and that change row by row - e.g. the planned
 * trade-stall economy: ns "stall" (one row per stall, `chunk` = where it stands), "listing" (one per listed item;
 * the item bytes keep their crafterId like any other item slot), "earnings" (one per owner). Owner and chunk are
 * indexed columns so "all listings of clan 7" / "stalls in chunk 3,4" do not decode every row.
 * `bytes` / `format` belong to the namespace's owner (versioned by them); persist never interprets them.
 */
export interface StoredRecord {
  ns: string; id: string; format: number; bytes: Uint8Array; tick: number;
  /** OwnerKind + id (0/0 = unowned). */
  ownerKind: number; ownerId: number;
  /** Chunk the record is anchored to, "" for none. */
  chunk: ChunkKey | "";
}
export interface RecordRef { ns: string; id: string }
/** Filter for listRecords; omitted fields match anything. */
export interface RecordQuery { ownerKind?: number; ownerId?: number; chunk?: ChunkKey | "" }
export const recordMatches = (r: StoredRecord, q: RecordQuery = {}): boolean =>
  (q.ownerKind === undefined || r.ownerKind === q.ownerKind) && (q.ownerId === undefined || r.ownerId === q.ownerId) && (q.chunk === undefined || r.chunk === q.chunk);
export const recordKey = (ns: string, id: string): string => `${ns}\u0000${id}`;
const byId = (a: StoredRecord, b: StoredRecord): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/**
 * In-memory record table with a pending overlay (used by the memory and IndexedDB stores, and as the SQLite
 * overlay). `null` in the overlay = pending delete.
 */
export class RecordTable {
  readonly rows = new Map<string, StoredRecord>();
  readonly overlay = new Map<string, StoredRecord | null>();
  get(ns: string, id: string): StoredRecord | undefined { const k = recordKey(ns, id); const o = this.overlay.get(k); return o !== undefined ? o ?? undefined : this.rows.get(k); }
  /** Merges `base` (committed rows from disk, if the backend keeps them elsewhere) with rows + overlay. Sorted by id. */
  list(ns: string, q: RecordQuery = {}, base: StoredRecord[] = []): StoredRecord[] {
    const m = new Map<string, StoredRecord>();
    for (const r of base) m.set(recordKey(r.ns, r.id), r);
    for (const [k, r] of this.rows) if (r.ns === ns) m.set(k, r);
    for (const [k, r] of this.overlay) { if (r === null) m.delete(k); else if (r.ns === ns) m.set(k, r); }
    return [...m.values()].filter((r) => r.ns === ns && recordMatches(r, q)).sort(byId);
  }
  count(): number { const k = new Set(this.rows.keys()); for (const [x, r] of this.overlay) { if (r) k.add(x); else k.delete(x); } return k.size; }
  stage(b: SaveBatch): void { for (const r of b.records ?? []) this.overlay.set(recordKey(r.ns, r.id), r); for (const d of b.deleteRecords ?? []) this.overlay.set(recordKey(d.ns, d.id), null); }
  /** Applies committed rows (keep=false: only clear the overlay entries this batch staged). */
  settle(b: SaveBatch, ok: boolean, keepRows = true): void {
    for (const r of b.records ?? []) { const k = recordKey(r.ns, r.id); if (ok && keepRows) this.rows.set(k, r); if (this.overlay.get(k) === r) this.overlay.delete(k); }
    for (const d of b.deleteRecords ?? []) { const k = recordKey(d.ns, d.id); if (ok && keepRows) this.rows.delete(k); if (this.overlay.get(k) === null) this.overlay.delete(k); }
  }
}

/** World-level metadata (meta table). */
export interface WorldMeta { seed: number; tick: number; schemaHash: number; createdAt?: number; /** Next account PlayerId to hand out. */ nextPlayerId?: number;
  /** TimeOfDay.epochTick (ADR-107): the day clock is derived from tick - epoch. Absent in pre-ADR-107 saves (they started at 0.25 of the day). */
  dayEpochTick?: number;
  /** ADR-239: core Season.offsetDays (season cycle phase relative to the day clock). */
  seasonOffsetDays?: number;
  /** ADR-261: Season.lengthDays the offset was saved under. Absent = legacy 3-day seasons. */
  seasonLengthDays?: number;
  /** World rules (ADR-121): roaming hordes on (1) / off (0), and their grace period in in-game days. Absent = gameplay defaults. */
  hordes?: number; hordeGraceDays?: number;
  /** World rules (Task 22): AI humans on (1) / off (0) in multiplayer. Absent = on. */
  aiHumans?: number;
  /** World rules (ADR-535): ambient zombies on (1) / off (0) in new worlds. Absent = on (old saves keep zombies). */
  zombies?: number;
  /** World rules (ADR-580): Creative mode on (1) / off (0), chosen at world creation. Absent = off (old saves stay survival). */
  creative?: number;
  /** ADR-514: terrain levels per building floor the save's Transform.z values use (5 since ADR-511). Absent = written
   *  before the stamp: records saved before ADR-511 store z in 3-level floors. */
  floorLevels?: number;
  /** ADR-514: records (chunks / players) saved at a tick below this one predate the floor stamp and get the legacy z fix
   *  on load; 0 / absent with floorLevels set = none. */
  floorStampTick?: number;
  /** ADR-594: chunk records saved at a tick below this one may hold ruined abandoned structures (before they spawned
   *  intact); they are restored when loaded. 0 / absent on a stamped world = none; a save without it is legacy. */
  intactStampTick?: number }

/** Everything written in one transaction. Either all of it becomes durable or none of it does. */
export interface SaveBatch {
  chunks?: StoredChunk[];
  players?: StoredPlayer[];
  meta?: WorldMeta;
  /** World-level records (upsert by key). */
  blobs?: StoredBlob[];
  /** Generic records (upsert by ns + id) and deletions; see StoredRecord. */
  records?: StoredRecord[];
  deleteRecords?: RecordRef[];
  /** Player rows (account tokens) to delete, applied before `players` upserts in the same part (ADR-099 delete progress). */
  deletePlayers?: string[];
  /** Chunk keys to delete (e.g. a world reset of an area). */
  deleteChunks?: ChunkKey[];
}

export interface StoreStats {
  /** Batches handed to write() that have not committed yet. */
  pendingBatches: number;
  /** Rows waiting in the read-through overlay (written but not committed yet). */
  pendingChunks: number;
  committedBatches: number;
  committedChunks: number;
  committedPlayers: number;
  bytesWritten: number;
  /** Wall-clock ms the backend spent committing the last batch (worker side for SQLite). */
  lastCommitMs: number;
}

/**
 * Storage backend for a world. Meta, blobs and players are read SYNCHRONOUSLY (backends without sync I/O load them
 * at open). Chunks are read synchronously (`readChunk`, SQLite / memory) or asynchronously (`readChunkAsync`,
 * IndexedDB), which WorldPersistence turns into a sync `ChunkProvider` or core's `AsyncChunkProvider`.
 * Writes are asynchronous, batched and transactional.
 *
 * Read-your-writes: a row passed to write() must be returned by the read methods immediately, even before the
 * batch commits (implementations keep a pending overlay).
 */
export interface WorldStore {
  readonly kind: string;
  readMeta(): WorldMeta | undefined;
  /** Sync chunk read. Async-only backends answer from their pending overlay / cache and may miss. */
  readChunk(key: ChunkKey): StoredChunk | undefined;
  /** Present on backends whose chunk reads are asynchronous: the authoritative read (overlay, then disk). */
  readChunkAsync?(key: ChunkKey): Promise<StoredChunk | undefined>;
  /** Async backends that know their key set: false = definitely no row (load from the generator synchronously). */
  hasChunk?(key: ChunkKey): boolean;
  readPlayer(token: string): StoredPlayer | undefined;
  readBlob(key: string): StoredBlob | undefined;
  /** Generic records (sync on every backend: SQLite indexes, memory / IndexedDB keep them resident). */
  readRecord(ns: string, id: string): StoredRecord | undefined;
  listRecords(ns: string, q?: RecordQuery): StoredRecord[];
  /** Optional async warm-up for backends without synchronous reads. */
  prefetchChunks?(keys: readonly ChunkKey[]): Promise<void>;
  /** Queue one transactional batch. Resolves when committed. Never blocks the caller on I/O. */
  write(batch: SaveBatch): Promise<void>;
  /** Start a multi-part transaction (see BatchHandle). */
  openBatch(): BatchHandle;
  /** Resolves when every batch queued so far is committed. */
  flush(): Promise<void>;
  /** Flush, then release the backend. */
  close(): Promise<void>;
  stats(): StoreStats;
  /** Number of chunk / player rows stored (diagnostics, tests). */
  count(table: "chunks" | "players" | "records"): number;
}

export function emptyStats(): StoreStats {
  return { pendingBatches: 0, pendingChunks: 0, committedBatches: 0, committedChunks: 0, committedPlayers: 0, bytesWritten: 0, lastCommitMs: 0 };
}

/** Hex encoding for 16-byte tokens (stable row key, safe for localStorage). */
export function tokenToHex(t: Uint8Array): string { let s = ""; for (const b of t) s += b.toString(16).padStart(2, "0"); return s; }
export function hexToToken(h: string): Uint8Array {
  if (!/^([0-9a-f]{2})+$/i.test(h)) throw new Error("bad token hex");
  const out = new Uint8Array(h.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16); return out;
}
/** Reads the chunk codec version from an encodeChunk blob header (u32 magic, u16 version). */
export function chunkFormatOf(bytes: Uint8Array): number { return bytes.length >= 6 ? bytes[4]! | (bytes[5]! << 8) : 0; }

/**
 * A transaction assembled over several calls (e.g. one autosave round encoded across many ticks). Parts become
 * readable through the store immediately; nothing is durable until commit() resolves, and then all of it is.
 */
export interface BatchHandle {
  append(part: SaveBatch): void;
  commit(): Promise<void>;
}
