/**
 * Tile replication (milestone 5). Server source: any core-world TileMap (ChunkManager), drained once per tick via
 * `tileChanges()`. Same scheme as the static class (§11): per-client subscribed chunks with the version the client
 * holds, a server-side mirror of the client's LRU cache, Hit on re-entry when versions match, closest-first full
 * sends under a per-tick byte budget, and one shared encoded delta per changed chunk per tick.
 *
 * Wire (reliable):
 *  Tiles (s->c): u32 tick, then sections `bit more=1, u2 kind, chunkKey (zigzag varuint cx, cy)`, ended by bit 0:
 *    0 Full:  varuint version, tile runs, height runs   (runs: varuint nRuns, nRuns x (varuint len, varuint value))
 *    1 Hit:   varuint version                           (client restores its cached copy)
 *    2 Delta: varuint n, n bytes core encodeTileDelta (u32 version, u16 count, count x (u16 index, u16 tile))
 *    3 Leave:                                          (client moves the chunk into its LRU cache)
 *  TilesCtl (c->s): u2 kind (0 Evict: dropped from cache, 1 Nack: resend full), chunkKey.
 * Heights travel only in Full (core records no height edit stream). ADR-263: a drained set flagged `heights` (shovel
 * terrain edit) is resent as Full to every subscriber holding an older version, the same tick.
 */
import { CHUNK_SIZE, Chunk, TileMap, applyTileDelta, encodeTileDelta, parseChunkKey, type ChunkKey } from "@engine/world";
import { BitReader, BitWriter } from "./bits.js";
import { MsgType, writeHeader } from "./protocol.js";
import type { NetServer } from "./server.js";
import { readChunkKey, writeChunkKey } from "./static.js";

export const TileSection = { Full: 0, Hit: 1, Delta: 2, Leave: 3 } as const;
export const TileCtl = { Evict: 0, Nack: 1 } as const;

interface Blob { bytes: Uint8Array; bits: number }
function runs(w: BitWriter, a: Uint16Array | Uint8Array | Int8Array): void {
  let n = 0; for (let i = 0; i < a.length;) { let j = i + 1; while (j < a.length && a[j] === a[i]) j++; n++; i = j; }
  w.writeVarUint(n);
  for (let i = 0; i < a.length;) { let j = i + 1; while (j < a.length && a[j] === a[i]) j++; w.writeVarUint(j - i); w.writeVarUint(a instanceof Int8Array ? a[i]! & 0xff : a[i]!); i = j; } // ADR-263: signed heights as bytes
}
function readRuns(r: BitReader, a: Uint16Array | Uint8Array | Int8Array): void {
  const n = r.readVarUint(); let o = 0;
  for (let k = 0; k < n; k++) { const len = r.readVarUint(), v = r.readVarUint(); if (o + len > a.length) throw new RangeError("tile runs overflow"); a.fill(v, o, o + len); o += len; }
  if (o !== a.length) throw new RangeError("tile runs short");
}

class TileSession {
  readonly subs = new Map<ChunkKey, number>(); // chunk -> version the client holds
  readonly cache = new Map<ChunkKey, number>(); // mirror of the client's LRU
  readonly resend = new Set<ChunkKey>();
  bytes = 0; fulls = 0; hits = 0; deltas = 0;
}
export interface TileSyncOptions {
  /** Server tile store (core ChunkManager / TileMap). Drained every tick: nobody else may call tileChanges(). */
  tiles: TileMap;
  /** Per-client bytes per tick for full chunk sends (deltas are never budgeted). Default 8 KiB; at least one chunk/tick. */
  budgetBytes?: number;
}

/** Server side. `new TileSync(server, { tiles })`. */
export class TileSync {
  private sessions = new Map<number, TileSession>();
  private fullCache = new Map<ChunkKey, { version: number; blob: Blob }>();
  readonly stats = { deltaChunks: 0, deltaBytesEncoded: 0, fullBytesEncoded: 0, lastTickBytes: 0 };
  constructor(readonly server: NetServer, readonly opts: TileSyncOptions) {
    server.onTick((tick) => this.tick(tick));
    server.onRawMessage(MsgType.TilesCtl, (s, r) => {
      const kind = r.readBits(2); const key = readChunkKey(r); const ts = this.sessions.get(s.clientId); if (!ts) return;
      ts.cache.delete(key); if (kind === TileCtl.Nack) { ts.subs.delete(key); ts.resend.add(key); }
    });
  }
  sessionStats(clientId: number): { bytes: number; fulls: number; hits: number; deltas: number; subscribed: number } | undefined {
    const s = this.sessions.get(clientId); return s && { bytes: s.bytes, fulls: s.fulls, hits: s.hits, deltas: s.deltas, subscribed: s.subs.size };
  }
  private full(c: Chunk): Blob {
    const f = this.fullCache.get(c.key); if (f && f.version === c.version) return f.blob;
    const w = new BitWriter(); w.writeVarUint(c.version); runs(w, c.tiles); runs(w, c.height);
    const blob = { bytes: w.finish(), bits: w.bitLength }; this.fullCache.set(c.key, { version: c.version, blob }); this.stats.fullBytesEncoded += blob.bytes.length;
    return blob;
  }
  private tick(tick: number): void {
    const tiles = this.opts.tiles; this.stats.lastTickBytes = 0;
    // 1. drain once; encode each chunk's delta once for every subscriber
    const deltas = new Map<ChunkKey, { version: number; blob: Blob }>();
    const heightKeys = new Set<ChunkKey>(); // ADR-263: shovel height edits -> full resend to subscribers holding an older version
    for (const set of tiles.tileChanges()) {
      if (set.heights) { heightKeys.add(set.key); continue; }
      const bytes = encodeTileDelta(set); const w = new BitWriter(); w.writeVarUint(bytes.length); w.writeBytes(bytes);
      deltas.set(set.key, { version: set.version, blob: { bytes: w.finish(), bits: w.bitLength } });
      this.stats.deltaChunks++; this.stats.deltaBytesEncoded += bytes.length;
    }
    for (const id of this.sessions.keys()) if (!this.server.sessions.get(id)?.conn) this.sessions.delete(id);
    for (const key of this.fullCache.keys()) if (!tiles.getChunkByKey(key)) this.fullCache.delete(key);
    const budget = (this.opts.budgetBytes ?? 8 * 1024) * 8;
    for (const sess of this.server.connected()) {
      let s = this.sessions.get(sess.clientId); if (!s) this.sessions.set(sess.clientId, (s = new TileSession()));
      const rel = this.server.relevantChunks(sess.clientId);
      const w = new BitWriter(); writeHeader(w, MsgType.Tiles); w.writeBits(tick >>> 0, 32); let any = false;
      const section = (kind: number, key: ChunkKey): void => { w.writeBool(true); w.writeBits(kind, 2); writeChunkKey(w, key); any = true; };
      const isRel = (k: ChunkKey): boolean => !rel || rel.has(k);
      for (const key of s.resend) { if (s.subs.has(key)) continue; section(TileSection.Leave, key); }
      s.resend.clear();
      // leaves
      for (const [key, ver] of s.subs) if (!isRel(key) || !tiles.getChunkByKey(key)) { s.subs.delete(key); section(TileSection.Leave, key); s.cache.set(key, ver); }
      // deltas to subscribers that hold an older version
      for (const [key, d] of deltas) {
        const have = s.subs.get(key); if (have === undefined || have >= d.version) continue;
        section(TileSection.Delta, key); w.appendBits(d.blob.bytes, d.blob.bits); s.subs.set(key, d.version); s.deltas++;
      }
      for (const key of heightKeys) {
        const have = s.subs.get(key); const c = tiles.getChunkByKey(key); if (have === undefined || !c || have >= c.version) continue;
        const b = this.full(c); section(TileSection.Full, key); w.appendBits(b.bytes, b.bits); s.subs.set(key, c.version); s.fulls++;
      }
      // entries: Hit from cache, else full sends closest first under the budget
      const want: ChunkKey[] = [];
      const consider = (key: ChunkKey): void => {
        if (s.subs.has(key)) return; const c = tiles.getChunkByKey(key); if (!c) return;
        if (s.cache.get(key) === c.version) { s.cache.delete(key); s.subs.set(key, c.version); section(TileSection.Hit, key); w.writeVarUint(c.version); s.hits++; return; }
        want.push(key);
      };
      if (rel) for (const key of rel) consider(key); else for (const c of tiles.loadedChunks()) consider(c.key);
      if (want.length) {
        const views = this.server.viewpointsOf(sess.clientId);
        const dist = (key: ChunkKey): number => {
          if (!views.length) return 0; const { cx, cy } = parseChunkKey(key); const x = (cx + 0.5) * CHUNK_SIZE, y = (cy + 0.5) * CHUNK_SIZE;
          let d = Infinity; for (const v of views) d = Math.min(d, (v.x - x) ** 2 + (v.y - y) ** 2); return d;
        };
        // ADR-369: score each chunk once (the comparator used to re-parse the key and re-scan viewpoints
        // on every comparison: O(w log w) dist calls). Same order, same bytes.
        const scored = want.map((key) => [key, dist(key)] as const); scored.sort((a, b) => a[1] - b[1]);
        let sent = 0;
        for (const [key] of scored) {
          const c = tiles.getChunkByKey(key)!; const b = this.full(c);
          if (sent && w.bitLength + b.bits > budget) break;
          section(TileSection.Full, key); w.appendBits(b.bytes, b.bits); s.cache.delete(key); s.subs.set(key, c.version); s.fulls++; sent++;
        }
      }
      if (!any) continue;
      w.writeBool(false); const out = w.finish(); s.bytes += out.length; this.stats.lastTickBytes += out.length;
      this.server.sendRaw(sess.clientId, out, "reliable");
    }
  }
}

export interface TileClientOptions {
  /** Where replicated chunks live (the renderer reads it). Default: a new TileMap. */
  tiles?: TileMap;
  /** Chunks kept after leaving them, for instant re-entry (LRU, default 64). */
  cacheChunks?: number;
}
export type TileChunkEvent = "full" | "hit" | "delta" | "leave";
/**
 * Client side: `new TileClient(client, opts)`. Active chunks are inserted into `tiles` (getTile / getChunk / loadedChunks);
 * deltas go through core applyTileDelta, so `tiles.tileChanges()` on the client also yields per-chunk edits for the renderer.
 */
export class TileClient {
  readonly tiles: TileMap;
  readonly cache = new Map<ChunkKey, Chunk>(); // LRU, oldest first
  readonly stats = { fulls: 0, hits: 0, deltas: 0, leaves: 0, nacks: 0, evictions: 0, bytes: 0 };
  private handlers: ((key: ChunkKey, kind: TileChunkEvent, chunk: Chunk | undefined) => void)[] = [];
  private readonly cacheChunks: number;
  constructor(private readonly client: { sendRaw(b: Uint8Array, ch: "reliable" | "unreliable"): boolean; onRawMessage(type: number, fn: (r: BitReader) => void): void }, opts: TileClientOptions = {}) {
    this.tiles = opts.tiles ?? new TileMap(); this.cacheChunks = opts.cacheChunks ?? 64;
    client.onRawMessage(MsgType.Tiles, (r) => this.handle(r));
  }
  /** Chunk arrived/updated/left: (key, "full" | "hit" | "delta" | "leave", chunk). */
  on(fn: (key: ChunkKey, kind: TileChunkEvent, chunk: Chunk | undefined) => void): () => void { this.handlers.push(fn); return () => { const i = this.handlers.indexOf(fn); if (i >= 0) this.handlers.splice(i, 1); }; }
  getTile(tx: number, ty: number): number { return this.tiles.getTile(tx, ty); }
  private emit(key: ChunkKey, kind: TileChunkEvent, c: Chunk | undefined): void { for (const f of this.handlers) f(key, kind, c); }
  private ctl(kind: number, key: ChunkKey): void {
    const w = new BitWriter(); writeHeader(w, MsgType.TilesCtl); w.writeBits(kind, 2); writeChunkKey(w, key); this.client.sendRaw(w.finish(), "reliable");
  }
  private nack(key: ChunkKey): void { this.stats.nacks++; this.cache.delete(key); const { cx, cy } = parseChunkKey(key); this.tiles.unloadChunk(cx, cy); this.ctl(TileCtl.Nack, key); }
  private handle(r: BitReader): void {
    r.readBits(32);
    while (r.readBool()) {
      const kind = r.readBits(2); const key = readChunkKey(r); const { cx, cy } = parseChunkKey(key);
      if (kind === TileSection.Leave) {
        const c = this.tiles.getChunkByKey(key); if (!c) continue;
        this.tiles.unloadChunk(cx, cy); this.cache.delete(key); this.cache.set(key, c); this.stats.leaves++;
        while (this.cache.size > this.cacheChunks) { const old = this.cache.keys().next().value as ChunkKey; this.cache.delete(old); this.stats.evictions++; this.ctl(TileCtl.Evict, old); }
        this.emit(key, "leave", c); continue;
      }
      if (kind === TileSection.Hit) {
        const ver = r.readVarUint(); const c = this.cache.get(key); this.cache.delete(key);
        if (!c || c.version !== ver) { this.nack(key); continue; }
        this.tiles.insertChunk(c); this.stats.hits++; this.emit(key, "hit", c); continue;
      }
      if (kind === TileSection.Delta) {
        const bytes = r.readBytes(r.readVarUint()); const c = this.tiles.getChunkByKey(key);
        if (!c) { this.nack(key); continue; }
        applyTileDelta(c, bytes); this.stats.deltas++; this.emit(key, "delta", c); continue;
      }
      const c = new Chunk(cx, cy); const ver = r.readVarUint(); readRuns(r, c.tiles); readRuns(r, c.height); c.version = ver;
      this.cache.delete(key); this.tiles.unloadChunk(cx, cy); this.tiles.insertChunk(c); this.stats.fulls++; this.emit(key, "full", c);
    }
  }
}
