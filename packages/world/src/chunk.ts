/**
 * Chunked tile storage. Chunk coordinates are signed 32-bit integers (effectively unbounded).
 * ChunkKey is a string "cx,cy" — stable, unbounded and cheap enough for per-tick interest work.
 */
export const CHUNK_SIZE = 32;
export const CHUNK_AREA = CHUNK_SIZE * CHUNK_SIZE;
export type ChunkKey = string;

/** Tile ids are u16 numeric ids into a tile registry (0 = empty). */
export class Chunk {
  readonly tiles = new Uint16Array(CHUNK_AREA);
  /** Terrain height level per tile. ADR-263: signed (Int8) so a shovel can dig below level 0 (ADR-297: -60..75 absolute terrain levels).
   * Binary codecs still write one byte per tile (two's complement), so stored 0..127 saves are unchanged. */
  readonly height = new Int8Array(CHUNK_AREA);
  /** ADR-263: height edits since the last drain (heights have no delta stream; TileSync resends the chunk in full). */
  heightEdited = false;
  /** Set when tiles change; cleared by whoever persists/streams the chunk. */
  dirty = false; version = 0;
  /** Tile edits since the last drain: flat triples (index, old, new). Only recorded when old !== new. */
  readonly tileChanges: number[] = [];
  /** Set by the owning TileMap so edits register the chunk for draining. */
  changeSink: Set<Chunk> | undefined;
  readonly key: ChunkKey;
  constructor(readonly cx: number, readonly cy: number) { this.key = chunkKey(cx, cy); }
  get(lx: number, ly: number): number { return this.tiles[ly * CHUNK_SIZE + lx]!; }
  set(lx: number, ly: number, id: number): void {
    const i = ly * CHUNK_SIZE + lx; if (this.tiles[i] === id) return;
    const old = this.tiles[i]!; this.tiles[i] = id; this.dirty = true; this.version++;
    this.tileChanges.push(i, old, id); this.changeSink?.add(this);
  }
  getHeight(lx: number, ly: number): number { return this.height[ly * CHUNK_SIZE + lx]!; }
  setHeight(lx: number, ly: number, h: number): void {
    const i = ly * CHUNK_SIZE + lx; if (this.height[i] === h) return;
    this.height[i] = h; this.dirty = true; this.version++; this.heightEdited = true; this.changeSink?.add(this);
  }
}
const I32 = (n: number): number => n | 0;
export const chunkKey = (cx: number, cy: number): ChunkKey => `${I32(cx)},${I32(cy)}`;
export function parseChunkKey(k: ChunkKey): { cx: number; cy: number } {
  const i = k.indexOf(","); return { cx: Number(k.slice(0, i)), cy: Number(k.slice(i + 1)) };
}
export const tileToChunk = (t: number): number => Math.floor(t / CHUNK_SIZE);
export const tileToLocal = (t: number): number => ((Math.floor(t) % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
/** Chunk coords containing a world position (float tile units). */
export const chunkOf = (pos: { x: number; y: number }): { cx: number; cy: number } => ({ cx: Math.floor(pos.x / CHUNK_SIZE), cy: Math.floor(pos.y / CHUNK_SIZE) });
export const chunkKeyOf = (x: number, y: number): ChunkKey => chunkKey(Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE));

/** Plain chunk container (no streaming). ChunkManager builds on it. */
export interface TileChangeSet { key: ChunkKey; chunk: Chunk; version: number; /** flat (index, old, new) triples in edit order */ changes: number[];
  /** ADR-263: heights changed too (no delta encoding: replicate the whole chunk). */ heights?: boolean }
export class TileMap {
  protected chunks = new Map<ChunkKey, Chunk>();
  protected changed = new Set<Chunk>();
  protected adopt(c: Chunk): void { c.changeSink = this.changed; if (c.tileChanges.length) this.changed.add(c); }
  /** Drain per-chunk tile edits recorded since the last drain (call once per tick, e.g. in net's network phase). */
  tileChanges(): TileChangeSet[] {
    const out: TileChangeSet[] = [];
    for (const c of this.changed) {
      const heights = c.heightEdited; c.heightEdited = false;
      if ((!c.tileChanges.length && !heights) || this.chunks.get(c.key) !== c) { c.tileChanges.length = 0; continue; }
      out.push({ key: c.key, chunk: c, version: c.version, changes: c.tileChanges.splice(0), ...(heights ? { heights: true } : {}) });
    }
    this.changed.clear(); return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
  getChunk(cx: number, cy: number): Chunk | undefined { return this.chunks.get(chunkKey(cx, cy)); }
  getChunkByKey(k: ChunkKey): Chunk | undefined { return this.chunks.get(k); }
  ensureChunk(cx: number, cy: number): Chunk {
    const k = chunkKey(cx, cy); let c = this.chunks.get(k);
    if (!c) { c = new Chunk(cx, cy); this.chunks.set(k, c); this.adopt(c); } return c;
  }
  insertChunk(c: Chunk): void { this.chunks.set(c.key, c); this.adopt(c); }
  unloadChunk(cx: number, cy: number): boolean { const c = this.chunks.get(chunkKey(cx, cy)); if (c) { c.changeSink = undefined; this.changed.delete(c); } return this.chunks.delete(chunkKey(cx, cy)); }
  getTile(tx: number, ty: number): number {
    return this.getChunk(tileToChunk(tx), tileToChunk(ty))?.get(tileToLocal(tx), tileToLocal(ty)) ?? 0;
  }
  setTile(tx: number, ty: number, id: number): void {
    this.ensureChunk(tileToChunk(tx), tileToChunk(ty)).set(tileToLocal(tx), tileToLocal(ty), id);
  }
  get chunkCount(): number { return this.chunks.size; }
  *loadedChunks(): IterableIterator<Chunk> { yield* this.chunks.values(); }
}

/**
 * Float precision guidance (see ARCHITECTURE "World Streaming"): Transform is f32 tile units.
 * f32 keeps <= 1/256-tile precision up to |x| < 65,536 tiles (2,048 chunks) and integer precision to 2^24.
 * Beyond that, simulate relative to a WorldOrigin (rebased per server region / client camera) and
 * persist chunk-local positions (the chunk codec stores positions relative to the chunk origin).
 */
export const F32_SAFE_TILE_RANGE = 65536;
export class WorldOrigin {
  constructor(public ox = 0, public oy = 0) {}
  toLocal(x: number, y: number): { x: number; y: number } { return { x: x - this.ox, y: y - this.oy }; }
  toWorld(x: number, y: number): { x: number; y: number } { return { x: x + this.ox, y: y + this.oy }; }
  /** Rebase origin to a chunk corner near (x,y) when |local| exceeds `threshold`. Returns shift applied (to subtract from positions). */
  maybeRebase(x: number, y: number, threshold = F32_SAFE_TILE_RANGE / 2): { dx: number; dy: number } {
    const l = this.toLocal(x, y);
    if (Math.abs(l.x) < threshold && Math.abs(l.y) < threshold) return { dx: 0, dy: 0 };
    const nx = Math.floor(x / CHUNK_SIZE) * CHUNK_SIZE, ny = Math.floor(y / CHUNK_SIZE) * CHUNK_SIZE;
    const d = { dx: nx - this.ox, dy: ny - this.oy }; this.ox = nx; this.oy = ny; return d;
  }
}

/**
 * Compact per-chunk tile delta (net replication of edits). Collapses repeated edits of a tile to the final value.
 * Wire: u32 version (after edits), u16 n, n x (u16 index, u16 tile).
 */
export function encodeTileDelta(set: { version: number; changes: readonly number[] }): Uint8Array {
  const last = new Map<number, number>(); for (let k = 0; k < set.changes.length; k += 3) { const i = set.changes[k]!; last.delete(i); last.set(i, set.changes[k + 2]!); }
  const out = new Uint8Array(6 + last.size * 4); const d = new DataView(out.buffer);
  d.setUint32(0, set.version >>> 0, true); d.setUint16(4, last.size, true); let o = 6;
  for (const [i, t] of last) { d.setUint16(o, i, true); d.setUint16(o + 2, t, true); o += 4; }
  return out;
}
export function decodeTileDelta(bytes: Uint8Array): { version: number; tiles: [index: number, tile: number][] } {
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const n = d.getUint16(4, true);
  if (bytes.byteLength < 6 + n * 4) throw new RangeError("tile delta truncated");
  const tiles: [number, number][] = []; for (let k = 0; k < n; k++) { const i = d.getUint16(6 + k * 4, true); if (i >= CHUNK_AREA) throw new RangeError("tile index out of range"); tiles.push([i, d.getUint16(8 + k * 4, true)]); }
  return { version: d.getUint32(0, true), tiles };
}
/** Applies a delta to a client chunk (records as local edits too) and adopts the server version. */
export function applyTileDelta(chunk: Chunk, bytes: Uint8Array): void {
  const { version, tiles } = decodeTileDelta(bytes); for (const [i, t] of tiles) chunk.set(i % CHUNK_SIZE, (i / CHUNK_SIZE) | 0, t); chunk.version = version;
}

/** Supported high-precision play/build domain (not a terrain-generation border). The generator remains
 * unbounded; terrain/road tile indices previously aliased outside a 65,536-tile-wide square.
 * ADR-296: two 18-bit axes cover 262,144 x 262,144 tiles (4x ADR-272 area).
 * This is a supported indexing domain, not a new generation border. At the outer edge f32 resolution is 1/128 tile.
 * Runtime keys are rebuilt on load, so this does not change saved chunk/entity formats. */
export const WORLD_TILE_HALF_EXTENT = F32_SAFE_TILE_RANGE * 2;
export const WORLD_TILE_DIAMETER = WORLD_TILE_HALF_EXTENT * 2;
export const worldTileKey = (x: number, y: number): number => (x + WORLD_TILE_HALF_EXTENT) * WORLD_TILE_DIAMETER + y + WORLD_TILE_HALF_EXTENT;
export const worldTileFromKey = (key: number): [number, number] => [Math.floor(key / WORLD_TILE_DIAMETER) - WORLD_TILE_HALF_EXTENT, (key % WORLD_TILE_DIAMETER) - WORLD_TILE_HALF_EXTENT];
