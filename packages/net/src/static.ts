/**
 * 'static' replication class (ARCHITECTURE §11): building pieces and other rarely-changing, numerous entities.
 *
 * Server keeps, per 32x32 chunk, the static entities' states and a version (bumped once per tick in which anything
 * in the chunk was added, changed, moved or removed). Per client:
 *  - entering a chunk: if the client's cache (mirrored server-side) holds the current version -> Hit (no data);
 *    otherwise the chunk is streamed in Parts under a per-tick byte budget, closest chunks first. Changes during
 *    the stream are folded in (already-sent entities are re-queued / despawned), so place/destroy in the entry
 *    tick is handled. The final Part carries the version the client now holds.
 *  - subscribed chunks: one shared Delta(from -> to) per changed chunk per tick, encoded once for all clients:
 *    varuint nRemoved + sorted delta-varint netIds, then change/spawn records, End.
 *  - leaving: Leave; the client moves the chunk into a bounded LRU cache (Evict tells the server when it drops one).
 * Everything rides the reliable channel in one Static message per tick. A client that sees a version mismatch or a
 * Hit for a chunk it no longer has sends Nack; the server answers Leave + a fresh stream.
 */
import { parseChunkKey, chunkKey, chunkKeyOf, CHUNK_SIZE, type ChunkKey } from "@engine/world";
import { BitReader, BitWriter } from "./bits.js";
import { MsgType, writeHeader } from "./protocol.js";
import { decodeDelta, fromWire, readWire, writeWire, writeDespawn, writeEnd, writeEntityRecord, type EntityState, type NetSchema, type WorldState } from "./state.js";

export const StaticSection = { Part: 0, Hit: 1, Delta: 2, Leave: 3 } as const;
export const StaticCtl = { Evict: 0, Nack: 1 } as const;
export type ReplicationClass = "dynamic" | "static";

const zz = (n: number): number => (n << 1) ^ (n >> 31);
const unzz = (n: number): number => (n >>> 1) ^ -(n & 1);
export function writeChunkKey(w: BitWriter, key: ChunkKey): void { const { cx, cy } = parseChunkKey(key); w.writeVarUint(zz(cx) >>> 0); w.writeVarUint(zz(cy) >>> 0); }
export function readChunkKey(r: BitReader): ChunkKey { const cx = unzz(r.readVarUint()); const cy = unzz(r.readVarUint()); return chunkKey(cx, cy); }

export function encodeStaticCtl(kind: number, key: ChunkKey): Uint8Array {
  const w = new BitWriter(); writeHeader(w, MsgType.StaticCtl); w.writeBits(kind, 2); writeChunkKey(w, key); return w.finish();
}

interface Blob { bytes: Uint8Array; bits: number }
interface Chunk { version: number; ents: Map<number, EntityState> }
interface Stream { pending: number[]; queued: Set<number>; sent: Set<number> }
/** Server-side static state of one client. */
export class StaticSession {
  readonly subs = new Map<ChunkKey, number>(); // fully-synced chunk -> version (0 = empty, never announced)
  readonly streams = new Map<ChunkKey, Stream>();
  readonly cache = new Map<ChunkKey, number>(); // mirror of the client's chunk cache
  readonly resets = new Set<ChunkKey>(); // Nack'd: send Leave then restream
  bytes = 0; streamedChunks = 0; hits = 0;
}

export class StaticServer {
  readonly chunks = new Map<ChunkKey, Chunk>();
  private where = new Map<number, ChunkKey>(); // netId -> chunk
  private changes = new Map<ChunkKey, { from: number; old: Map<number, EntityState | undefined> }>();
  private deltaBlobs = new Map<ChunkKey, Blob>();
  /** ADR-369: reused across ticks instead of allocating a fresh Set per update. */
  private seenIds = new Set<number>();
  private spawnBlobs = new WeakMap<EntityState, Blob & { id: number }>();
  /** netIds replicated via the static channel this tick (excluded from snapshots). */
  readonly ids = new Set<number>();
  /** Chunk a static netId currently lives in (undefined = not static). */
  chunkOf(netId: number): ChunkKey | undefined { return this.where.get(netId); }
  /** True if the session holds (or is streaming) the chunk containing static `netId`. */
  knownTo(ss: StaticSession, netId: number): boolean { const k = this.where.get(netId); return k !== undefined && (ss.subs.has(k) || ss.streams.has(k)); }
  private readonly xi: number; private readonly yi: number;
  constructor(private readonly schema: NetSchema, readonly classCis: ReadonlySet<number>, private readonly transformCi: number | undefined) {
    const lay = transformCi === undefined ? [] : schema.layout[transformCi]!;
    this.xi = lay.findIndex(([f]) => f === "x"); this.yi = lay.findIndex(([f]) => f === "y");
  }

  isStatic(es: EntityState): boolean { for (const ci of this.classCis) if (es.has(ci)) return true; return false; }

  /** Fold this tick's captured state into the chunk store. O(static entities) id scan + O(changes) work. */
  update(cur: WorldState): void {
    this.changes.clear(); this.deltaBlobs.clear();
    const seen = this.seenIds; seen.clear();
    const tci = this.transformCi;
    const note = (key: ChunkKey, id: number, old: EntityState | undefined): Chunk => {
      let c = this.chunks.get(key); if (!c) { c = { version: 0, ents: new Map() }; this.chunks.set(key, c); }
      let ch = this.changes.get(key); if (!ch) { ch = { from: c.version, old: new Map() }; this.changes.set(key, ch); }
      if (!ch.old.has(id)) ch.old.set(id, old);
      return c;
    };
    for (const [id, es] of cur) {
      if (!this.isStatic(es)) continue;
      const t = tci === undefined ? undefined : es.get(tci); if (!t) continue; // needs a position
      seen.add(id);
      const sp = this.schema.specs[tci!]!; const xi = this.xi, yi = this.yi; const key = chunkKeyOf(fromWire(sp[xi]!, t[xi]!), fromWire(sp[yi]!, t[yi]!)); const prevKey = this.where.get(id);
      if (prevKey === key) {
        const c = this.chunks.get(key)!; const old = c.ents.get(id)!;
        if (old === es) continue;
        note(key, id, old); c.ents.set(id, es);
      } else {
        if (prevKey !== undefined) { const pc = this.chunks.get(prevKey)!; note(prevKey, id, pc.ents.get(id)); pc.ents.delete(id); }
        note(key, id, undefined).ents.set(id, es); this.where.set(id, key);
      }
    }
    for (const [id, key] of this.where) {
      if (seen.has(id)) continue;
      const c = this.chunks.get(key)!; note(key, id, c.ents.get(id)); c.ents.delete(id); this.where.delete(id);
    }
    for (const key of this.changes.keys()) this.chunks.get(key)!.version++;
    this.ids.clear(); for (const id of seen) this.ids.add(id);
  }

  private delta(key: ChunkKey): Blob {
    let b = this.deltaBlobs.get(key);
    if (!b) {
      const w = new BitWriter(); const c = this.chunks.get(key)!;
      // bulk removals first: sorted netIds as delta-varints (a raid wiping 500 pieces costs ~1-2 B per piece)
      const gone: number[] = [];
      for (const [id, old] of this.changes.get(key)!.old) if (!c.ents.has(id) && old) gone.push(id);
      gone.sort((a, b) => a - b);
      w.writeVarUint(gone.length); let prev = 0; for (const id of gone) { w.writeVarUint(id - prev); prev = id; }
      // column batches: entities whose only change is ONE element of ONE component (hp, state, damageStage...)
      // grouped per (component, element): sorted delta-varint netIds, then the values (~2-3 B per piece)
      const cols = new Map<number, { ci: number; ei: number; ids: number[] }>(); const rest: [number, EntityState, EntityState | undefined][] = [];
      for (const [id, old] of this.changes.get(key)!.old) {
        const es = c.ents.get(id); if (!es) continue;
        const one = old ? singleElementChange(old, es) : undefined;
        if (!one) { rest.push([id, es, old]); continue; }
        const k = one[0] * 4096 + one[1]; let col = cols.get(k); if (!col) cols.set(k, (col = { ci: one[0], ei: one[1], ids: [] })); col.ids.push(id);
      }
      w.writeVarUint(cols.size);
      for (const col of cols.values()) {
        col.ids.sort((a, b) => a - b); const spec = this.schema.specs[col.ci]![col.ei]!;
        w.writeVarUint(col.ci); w.writeVarUint(col.ei); w.writeVarUint(col.ids.length);
        let p = 0; for (const id of col.ids) { w.writeVarUint(id - p); p = id; }
        for (const id of col.ids) writeWire(w, spec, c.ents.get(id)!.get(col.ci)![col.ei]!);
      }
      for (const [id, es, old] of rest) writeEntityRecord(w, this.schema, id, es, old);
      writeEnd(w); b = w.snapshotBits(); this.deltaBlobs.set(key, b);
    }
    return b;
  }
  private spawn(id: number, es: EntityState): Blob {
    let b = this.spawnBlobs.get(es);
    if (!b || b.id !== id) { const w = new BitWriter(); writeEntityRecord(w, this.schema, id, es, undefined); b = { ...w.snapshotBits(), id }; this.spawnBlobs.set(es, b); }
    return b;
  }

  onCtl(s: StaticSession, kind: number, key: ChunkKey): void {
    if (kind === StaticCtl.Evict) { s.cache.delete(key); return; }
    s.cache.delete(key); s.streams.delete(key); s.subs.delete(key); s.resets.add(key);
  }
  forget(s: StaticSession, key: ChunkKey): void { s.subs.delete(key); s.streams.delete(key); }

  /**
   * Build this tick's Static message for one client, or undefined if there is nothing to say.
   * relevant = chunks in the client's AOI (undefined = every chunk); views = viewpoints for stream ordering.
   */
  build(s: StaticSession, tick: number, relevant: ReadonlySet<ChunkKey> | undefined, views: readonly { x: number; y: number }[], budgetBytes: number): Uint8Array | undefined {
    const w = new BitWriter(); writeHeader(w, MsgType.Static); w.writeBits(tick, 32);
    let any = false;
    const section = (kind: number, key: ChunkKey): void => { w.writeBool(true); w.writeBits(kind, 2); writeChunkKey(w, key); any = true; };
    const isRel = (k: ChunkKey): boolean => !relevant || relevant.has(k);
    // resets (Nack) and leaves
    for (const key of s.resets) { section(StaticSection.Leave, key); }
    s.resets.clear();
    for (const [key, ver] of s.subs) if (!isRel(key)) { s.subs.delete(key); if (ver > 0) { section(StaticSection.Leave, key); s.cache.set(key, ver); } }
    for (const key of s.streams.keys()) if (!isRel(key)) { s.streams.delete(key); section(StaticSection.Leave, key); }
    // deltas for subscribed chunks, changes folded into running streams
    for (const [key, ch] of this.changes) {
      const ver = s.subs.get(key);
      if (ver !== undefined) {
        if (ver !== ch.from) { s.subs.delete(key); s.resets.add(key); continue; } // cannot happen on a reliable link
        section(StaticSection.Delta, key); w.writeVarUint(ch.from); w.writeVarUint(this.chunks.get(key)!.version);
        const b = this.delta(key); w.appendBits(b.bytes, b.bits); s.subs.set(key, this.chunks.get(key)!.version);
        continue;
      }
      const st = s.streams.get(key);
      if (st) for (const id of ch.old.keys()) if (!st.queued.has(id)) { st.queued.add(id); st.pending.push(id); }
    }
    // newly relevant chunks
    const consider = (key: ChunkKey): void => {
      if (s.subs.has(key) || s.streams.has(key)) return;
      const c = this.chunks.get(key); const ver = c?.version ?? 0;
      if (!c || (ver === 0)) { s.subs.set(key, 0); return; }
      if (s.cache.get(key) === ver) { s.cache.delete(key); s.subs.set(key, ver); section(StaticSection.Hit, key); w.writeVarUint(ver); s.hits++; return; }
      s.cache.delete(key);
      const pending = [...c.ents.keys()]; s.streams.set(key, { pending, queued: new Set(pending), sent: new Set() });
    };
    if (relevant) for (const key of relevant) consider(key); else for (const key of this.chunks.keys()) consider(key);
    // stream parts, closest chunk first, under the byte budget
    if (s.streams.size) {
      const dist = (key: ChunkKey): number => {
        const { cx, cy } = parseChunkKey(key); const x = (cx + 0.5) * CHUNK_SIZE, y = (cy + 0.5) * CHUNK_SIZE; let d = Infinity;
        for (const v of views) d = Math.min(d, (v.x - x) ** 2 + (v.y - y) ** 2);
        return views.length ? d : 0;
      };
      // ADR-369: score each chunk once (was O(s log s) dist calls through the comparator). Same order.
      const order = [...s.streams.keys()].map((key) => [key, dist(key)] as const).sort((a, b) => a[1] - b[1]).map(([key]) => key);
      const budget = budgetBytes * 8;
      for (const key of order) {
        if (w.bitLength >= budget - 64) break;
        const st = s.streams.get(key)!; const c = this.chunks.get(key)!;
        section(StaticSection.Part, key);
        let progressed = false;
        while (st.pending.length) {
          const id = st.pending[st.pending.length - 1]!; const es = c.ents.get(id);
          if (!es) {
            if (st.sent.has(id)) { if (w.bitLength + 40 > budget && progressed) break; writeDespawn(w, id); st.sent.delete(id); progressed = true; }
          } else {
            const b = this.spawn(id, es);
            if (w.bitLength + b.bits + 2 > budget && progressed) break;
            w.appendBits(b.bytes, b.bits); st.sent.add(id); progressed = true;
          }
          st.pending.pop(); st.queued.delete(id);
        }
        writeEnd(w);
        const final = st.pending.length === 0;
        w.writeBool(final);
        if (final) { w.writeVarUint(c.version); s.subs.set(key, c.version); s.streams.delete(key); s.streamedChunks++; }
      }
    }
    if (!any) return undefined;
    w.writeBool(false);
    const out = w.finish(); s.bytes += out.length;
    return out;
  }
}

/** Client callbacks the static channel drives. */
export interface StaticSink {
  upsert(netId: number, es: EntityState, old: EntityState | undefined): void;
  remove(netId: number): void;
  sendCtl(kind: number, key: ChunkKey): void;
}
interface ClientChunk { version: number; ents: Map<number, EntityState> } // version -1 = streaming
export class StaticClient {
  readonly active = new Map<ChunkKey, ClientChunk>();
  readonly cache = new Map<ChunkKey, ClientChunk>(); // LRU: oldest first
  private owner = new Map<number, ChunkKey>();
  stats = { parts: 0, hits: 0, deltas: 0, nacks: 0, evictions: 0, bytes: 0 };
  constructor(private readonly schema: NetSchema, private readonly sink: StaticSink, readonly cacheChunks = 64) {}

  has(netId: number): boolean { return this.owner.has(netId); }

  private applyDiff(key: ChunkKey, before: Map<number, EntityState>, after: Map<number, EntityState>): void {
    for (const id of before.keys()) if (!after.has(id) && this.owner.get(id) === key) { this.owner.delete(id); this.sink.remove(id); }
    for (const [id, es] of after) {
      const old = this.owner.get(id) === key ? before.get(id) : undefined;
      if (old === es) continue;
      this.owner.set(id, key); this.sink.upsert(id, es, old);
    }
  }
  private drop(key: ChunkKey, toCache: boolean): void {
    const a = this.active.get(key); if (!a) return;
    this.active.delete(key);
    this.applyDiff(key, a.ents, new Map());
    if (toCache && a.version > 0) {
      this.cache.delete(key); this.cache.set(key, a);
      while (this.cache.size > this.cacheChunks) {
        const oldest = this.cache.keys().next().value as ChunkKey; this.cache.delete(oldest); this.stats.evictions++;
        this.sink.sendCtl(StaticCtl.Evict, oldest);
      }
    }
  }
  private nack(key: ChunkKey): void { this.stats.nacks++; this.drop(key, false); this.cache.delete(key); this.sink.sendCtl(StaticCtl.Nack, key); }

  /** Apply one Static message (reader positioned after the header). */
  handle(r: BitReader, byteLength: number): void {
    this.stats.bytes += byteLength;
    r.readBits(32); // tick
    while (r.readBool()) {
      const kind = r.readBits(2); const key = readChunkKey(r);
      if (kind === StaticSection.Leave) { this.drop(key, true); continue; }
      if (kind === StaticSection.Hit) {
        const ver = r.readVarUint(); const c = this.cache.get(key); this.cache.delete(key);
        if (!c || c.version !== ver) { this.nack(key); continue; }
        this.stats.hits++; this.active.set(key, c); this.applyDiff(key, new Map(), c.ents); continue;
      }
      if (kind === StaticSection.Delta) {
        const from = r.readVarUint(), to = r.readVarUint();
        let a = this.active.get(key);
        if (!a && from === 0) { a = { version: 0, ents: new Map() }; this.active.set(key, a); }
        const ok = !!a && a.version === from;
        const n = r.readVarUint(); const gone: number[] = []; let prev = 0; for (let i = 0; i < n; i++) { prev += r.readVarUint(); gone.push(prev); }
        const cols: { ci: number; ei: number; ids: number[]; vals: number[] }[] = [];
        let d;
        try {
          const nc = r.readVarUint();
          for (let k = 0; k < nc; k++) {
            const ci = r.readVarUint(), ei = r.readVarUint(), m = r.readVarUint(); const spec = this.schema.specs[ci]?.[ei]; if (!spec) throw new Error("bad column");
            const ids: number[] = []; let p = 0; for (let i = 0; i < m; i++) { p += r.readVarUint(); ids.push(p); }
            cols.push({ ci, ei, ids, vals: ids.map(() => readWire(r, spec)) });
          }
          d = decodeDelta(r, this.schema, ok ? a!.ents : undefined);
          for (const col of cols) col.ids.forEach((id, i) => {
            const es = d!.state.get(id); const v = es?.get(col.ci); if (!es || !v) { if (ok) throw new Error("column for unknown entity"); return; }
            const nv = [...v]; nv[col.ei] = col.vals[i]!; const ne = new Map(es); ne.set(col.ci, nv); d!.state.set(id, ne);
          });
        } catch { d = undefined; }
        if (d) for (const id of gone) d.state.delete(id);
        if (!ok || !d) { if (!d) return; this.nack(key); continue; }
        this.stats.deltas++; this.applyDiff(key, a!.ents, d.state); a!.ents = d.state; a!.version = to; continue;
      }
      // Part
      this.cache.delete(key);
      let a = this.active.get(key);
      if (!a || a.version >= 0) { if (a) this.drop(key, false); a = { version: -1, ents: new Map() }; this.active.set(key, a); }
      const d = decodeDelta(r, this.schema, a.ents);
      this.stats.parts++; this.applyDiff(key, a.ents, d.state); a.ents = d.state;
      if (r.readBool()) a.version = r.readVarUint();
    }
  }
  /** Connection reset: complete chunks go to the cache, entities are removed. */
  reset(): void { for (const key of [...this.active.keys()]) this.drop(key, true); }
}

/** [ci, element] when exactly one element of one component differs (no adds/removes), else undefined. */
function singleElementChange(a: EntityState, b: EntityState): [number, number] | undefined {
  if (a.size !== b.size) return undefined; let hit: [number, number] | undefined;
  for (const [ci, v] of b) {
    const o = a.get(ci); if (!o) return undefined; if (o === v) continue;
    for (let i = 0; i < v.length; i++) if (v[i] !== o[i]) { if (hit) return undefined; hit = [ci, i]; }
  }
  return hit;
}
