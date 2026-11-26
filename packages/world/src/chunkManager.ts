import { Chunk, chunkKey, parseChunkKey, TileMap, tileToChunk, tileToLocal, type ChunkKey } from "./chunk.js";
import type { AsyncChunkProvider, ChunkProvider, GeneratedChunk, NodePlacement } from "./generator.js";

export interface InterestSource {
  id: number; x: number; y: number; /** load radius in chunks (default manager radius) */ radius?: number;
  /** ADR-546: drain priority — 0 = real player (default), higher = deprioritised (AI-human bots use 1).
   *  A chunk wanted by any priority-0 source is a player chunk; the pending queue drains player
   *  chunks first, with a fairness floor (see playerChunksPerBotChunk) so bot chunks still load. */
  priority?: number;
}
/** ADR-546: how many player chunks drain before one bot chunk is served (fairness floor — bots
 *  must not starve while the player sprints; ADR-370's nearest-first ordering stays reverted,
 *  so within each class the order is heading-ahead first, then FIFO insertion order). */
export const DEFAULT_PLAYER_CHUNKS_PER_BOT_CHUNK = 4;
export interface ChunkManagerOptions {
  /** Sync or async provider. Async loads are tracked as in-flight: never requested twice, dropped if no longer wanted on arrival. */
  provider: ChunkProvider | AsyncChunkProvider;
  /** Chunks within this Chebyshev radius of any source are kept active. */
  loadRadius?: number;
  /** Extra radius before an active chunk is released (hysteresis). */
  unloadMargin?: number;
  /** Max inactive chunks kept in the LRU cache before being evicted (onUnload fires on eviction). */
  cacheSize?: number;
  /** Max chunk loads per update() (streaming budget). ADR-379: a chunk that ate the whole time budget on its own
   *  (a site chunk — terrain + stamp) ends its update via the after-install time check below, so the stamp
   *  cost counts against the budget; no separate cap is needed (see the update() comment). */
  maxLoadsPerUpdate?: number;
  /** Soft wall-clock load budget; always admits one chunk to avoid starvation (no quality reduction).
   *  ADR-379: enforced after every chunk install (load + install, including the onLoad stamp hook), and
   *  before starting the next chunk using the cost of the chunk just loaded — so plain-chunk updates
   *  stop at two loads (~1.6 ms) instead of three (~2.4 ms), and a site chunk ends its update. */
  maxLoadTimeMs?: number;
  /** ADR-546: player chunks drained per bot chunk (fairness floor, default
   *  DEFAULT_PLAYER_CHUNKS_PER_BOT_CHUNK). Only affects the drain order, never the active set. */
  playerChunksPerBotChunk?: number;
}
export type ChunkLoadHook = (chunk: Chunk, nodes: readonly NodePlacement[]) => void;
export type ChunkUnloadHook = (chunk: Chunk) => void;

/**
 * Streaming chunk manager. Active set = union of squares around interest sources. Chunks leaving the active set go
 * to an LRU cache; evicted chunks fire onUnload (persist there) and are dropped. Loads come from the provider.
 * Hook names `onLoad` / `onUnload` are stable (Netcode codes against them).
 */
export class ChunkManager extends TileMap {
  readonly loadRadius: number; readonly unloadMargin: number; readonly cacheSize: number; readonly maxLoads: number;
  readonly playerChunksPerBotChunk: number;
  private sources = new Map<number, InterestSource>();
  private active = new Set<ChunkKey>();
  /** ADR-546: last seen position per source + the movement heading derived from it (unit vector,
   *  updated when a source moves >= 0.1 tiles between updates — walk is 0.145 tiles/tick and sprint
   *  0.232 at 20 Hz, so both register; a stationary source keeps its last heading, which is harmless
   *  because its want set is static then). The heading is the chunk-prewarm ordering input the
   *  warmup.ts header names: chunks ahead of the heading drain first. There is no such input in
   *  code anywhere else — it is derived here from the source positions the manager already gets. */
  private lastPos = new Map<number, { x: number; y: number }>();
  private headings = new Map<number, { x: number; y: number }>();
  /** LRU of inactive-but-resident chunk keys (Map iteration order = recency). */
  private lru = new Map<ChunkKey, true>();
  private loadHooks: ChunkLoadHook[] = []; private unloadHooks: ChunkUnloadHook[] = [];
  private pending: ChunkKey[] = [];
  private inflight = new Map<ChunkKey, number>(); // key -> request token
  private token = 0;
  private keepSet = new Set<ChunkKey>();
  stats = { loads: 0, unloads: 0, cacheHits: 0, asyncDropped: 0, loadErrors: 0 };
  constructor(private opts: ChunkManagerOptions) {
    super();
    this.loadRadius = opts.loadRadius ?? 2; this.unloadMargin = opts.unloadMargin ?? 1;
    this.cacheSize = opts.cacheSize ?? 64; this.maxLoads = opts.maxLoadsPerUpdate ?? Infinity;
    this.playerChunksPerBotChunk = opts.playerChunksPerBotChunk ?? DEFAULT_PLAYER_CHUNKS_PER_BOT_CHUNK;
  }
  onLoad(fn: ChunkLoadHook): () => void { this.loadHooks.push(fn); return () => rm(this.loadHooks, fn); }
  onUnload(fn: ChunkUnloadHook): () => void { this.unloadHooks.push(fn); return () => rm(this.unloadHooks, fn); }
  setSource(s: InterestSource): void { this.sources.set(s.id, { ...s }); }
  removeSource(id: number): void { this.sources.delete(id); }
  isActive(k: ChunkKey): boolean { return this.active.has(k); }
  get activeKeys(): ReadonlySet<ChunkKey> { return this.active; }
  /** Queued (not yet requested) + in-flight async loads. */
  get pendingLoads(): number { return this.pending.length + this.inflight.size; }
  get inflightLoads(): number { return this.inflight.size; }
  isPending(k: ChunkKey): boolean { return this.inflight.has(k) || this.pending.includes(k); }
  /** Resolves when no async loads are in flight (tests/tools). */
  async settle(): Promise<void> { while (this.inflight.size) await Promise.all([...this.inflightPromises.values()]); }
  private inflightPromises = new Map<ChunkKey, Promise<void>>();
  /** ADR-546: reorder the pending queue for one drain — player chunks first, ahead-of-heading first
   *  within each class, with the fairness floor interleaving one lower-priority (bot) chunk per
   *  playerChunksPerBotChunk player chunks. NOT nearest-first (ADR-370 stays reverted): within a
   *  class the order is heading score, then FIFO insertion order, so far chunks always progress —
   *  a chunk wanted only by bots still drains, just behind the player's. Chunks with no meta are
   *  stale (no longer wanted); they sort as player-class with score 0 and the drain loop drops
   *  them when reached. The merge restarts every update, so with the usual 2-loads/update time
   *  budget a bot chunk is served after ~4 player chunks have drained across updates. */
  private reorderPending(meta: Map<ChunkKey, { prio: number; score: number }>): void {
    if (this.pending.length < 2) return;
    const idx = new Map<ChunkKey, number>();
    this.pending.forEach((k, i) => idx.set(k, i));
    const player: ChunkKey[] = [], other: ChunkKey[] = [];
    for (const k of this.pending) (meta.get(k)?.prio ?? 0) > 0 ? other.push(k) : player.push(k);
    const byScore = (a: ChunkKey, b: ChunkKey): number => {
      const d = (meta.get(b)?.score ?? 0) - (meta.get(a)?.score ?? 0);
      return d !== 0 ? d : (idx.get(a) ?? 0) - (idx.get(b) ?? 0);
    };
    player.sort(byScore); other.sort(byScore);
    const merged: ChunkKey[] = [];
    let pi = 0, oi = 0;
    while (pi < player.length || oi < other.length) {
      for (let n = 0; n < this.playerChunksPerBotChunk && pi < player.length; n++) merged.push(player[pi++]!);
      if (oi < other.length) merged.push(other[oi++]!);
    }
    this.pending = merged;
  }
  private install(k: ChunkKey, cx: number, cy: number, g: GeneratedChunk | undefined): void {
    const chunk = g?.chunk ?? new Chunk(cx, cy);
    this.chunks.set(k, chunk); this.adopt(chunk); this.active.add(k); this.stats.loads++;
    for (const h of this.loadHooks) h(chunk, g?.nodes ?? []);
  }

  /** Recompute active set, queue/perform loads (budgeted), move released chunks to LRU, evict overflow. */
  update(): void {
    // ADR-546: derive each source's movement heading from its position delta since the last update.
    for (const s of this.sources.values()) {
      const last = this.lastPos.get(s.id);
      if (last) {
        const dx = s.x - last.x, dy = s.y - last.y;
        if (dx * dx + dy * dy >= 0.01) { const len = Math.hypot(dx, dy); this.headings.set(s.id, { x: dx / len, y: dy / len }); }
      }
      this.lastPos.set(s.id, { x: s.x, y: s.y });
    }
    const want = new Set<ChunkKey>(), keep = new Set<ChunkKey>();
    /** ADR-546: per wanted chunk, the best (lowest) priority of any source wanting it and the best
     *  heading-ahead score (chunk-centre offset projected on the heading, minus its lateral distance
     *  — a cone score, so the chunk straight ahead of a sprinting player drains before the far
     *  ahead-corner). Sources without a heading score 0, so a stationary source keeps FIFO order. */
    const wantMeta = new Map<ChunkKey, { prio: number; score: number }>();
    for (const s of this.sources.values()) {
      const r = s.radius ?? this.loadRadius, cx = tileToChunk(s.x), cy = tileToChunk(s.y), R = r + this.unloadMargin;
      const prio = s.priority ?? 0, h = this.headings.get(s.id);
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const k = chunkKey(cx + dx, cy + dy); keep.add(k);
        if (Math.abs(dx) <= r && Math.abs(dy) <= r) {
          want.add(k);
          let score = 0;
          if (h) {
            const ox = (cx + dx + 0.5) * 32 - s.x, oy = (cy + dy + 0.5) * 32 - s.y;
            const ahead = ox * h.x + oy * h.y, lx = ox - ahead * h.x, ly = oy - ahead * h.y;
            score = ahead - Math.hypot(lx, ly);
          }
          const prev = wantMeta.get(k);
          if (!prev || prio < prev.prio || (prio === prev.prio && score > prev.score)) wantMeta.set(k, { prio, score });
        }
      }
    }
    this.keepSet = keep;
    for (const k of [...this.inflight.keys()]) if (!keep.has(k)) { this.inflight.delete(k); this.inflightPromises.delete(k); this.stats.asyncDropped++; } // late result will be ignored
    for (const k of [...this.active]) if (!keep.has(k)) { this.active.delete(k); this.lru.delete(k); this.lru.set(k, true); }
    const queued = new Set(this.pending);
    for (const k of want) if (!this.active.has(k)) {
      if (this.chunks.has(k)) { this.active.add(k); this.lru.delete(k); this.stats.cacheHits++; }
      else if (!queued.has(k) && !this.inflight.has(k)) { this.pending.push(k); queued.add(k); }
    }
    // ADR-379: the load budget is enforced on elapsed wall time *after* every chunk install, and before
    // starting the next chunk using the cost of the chunk just loaded. A chunk that starts always finishes
    // (never a half-installed chunk) — the budget only stops *further* chunks in this update. Load cost is
    // provider.load + install, so the onLoad stamp (game.ts: abandoned sites) counts against the budget
    // whether it lands in one tick or sliced across ticks (ADR-378): a sliced stamp costs less per tick,
    // so more chunks fit — the accounting composes without either side knowing about the other.
    // Note: the task's "lower maxLoadsPerUpdate to 2 after a site chunk" is implemented by the after-install
    // check, not a separate cap — a site chunk's own cost (>= the budget) already ends its update, so a
    // cap-2 rule would be unobservable whenever a time budget is configured, and without one a "site chunk"
    // could only be guessed from cost (which misfires on JIT-warm-up chunks). maxLoadsPerUpdate stays the
    // hard cap; the time budget governs.
    // ADR-546: order the pending queue player-first (with the fairness floor) and ahead-of-heading first
    // before draining, so a sprinting player's next chunks are not queued behind bots' far chunks.
    this.reorderPending(wantMeta);
    let n = 0; const started = performance.now();
    const budgetMs = this.opts.maxLoadTimeMs ?? Infinity;
    let lastChunkMs = 0; // wall time the chunk just loaded this update cost
    while (this.pending.length && n < this.maxLoads) {
      const elapsed = performance.now() - started;
      if (n > 0 && elapsed >= budgetMs) break; // after-install check: the chunk just installed already spent the budget
      if (n > 0 && elapsed + lastChunkMs > budgetMs) break; // don't start a chunk the last chunk's cost says won't fit
      const k = this.pending.shift()!; if (!want.has(k) || this.chunks.has(k) || this.inflight.has(k)) continue;
      const { cx, cy } = parseChunkKey(k);
      const t0 = performance.now();
      const g = this.opts.provider.load(cx, cy); n++;
      if (g instanceof Promise) {
        const tok = ++this.token; this.inflight.set(k, tok);
        const p = g.then((res) => {
          if (this.inflight.get(k) !== tok) { return; } // unloaded/superseded while loading
          this.inflight.delete(k); this.inflightPromises.delete(k);
          if (this.chunks.has(k) || !this.keepSet.has(k)) { this.stats.asyncDropped++; return; }
          this.install(k, cx, cy, res);
        }, () => { if (this.inflight.get(k) === tok) { this.inflight.delete(k); this.inflightPromises.delete(k); } this.stats.loadErrors++; });
        this.inflightPromises.set(k, p);
        lastChunkMs = performance.now() - t0; // async dispatch is cheap; it must not block further dispatches
      } else {
        this.install(k, cx, cy, g);
        lastChunkMs = performance.now() - t0;
      }
    }
    while (this.lru.size > this.cacheSize) this.evict(this.lru.keys().next().value!);
  }
  /** Force-unload a chunk (fires onUnload). */
  evict(k: ChunkKey): void {
    if (this.inflight.delete(k)) { this.inflightPromises.delete(k); this.stats.asyncDropped++; }
    const c = this.chunks.get(k); this.lru.delete(k); this.active.delete(k); if (!c) return;
    for (const h of this.unloadHooks) h(c);
    c.changeSink = undefined; this.changed.delete(c);
    this.chunks.delete(k); this.stats.unloads++;
  }
  /** Writes to unloaded chunks are ignored (returns false) — the world only mutates resident chunks. */
  trySetTile(tx: number, ty: number, id: number): boolean {
    const c = this.getChunk(tileToChunk(tx), tileToChunk(ty)); if (!c) return false;
    c.set(tileToLocal(tx), tileToLocal(ty), id); return true;
  }
}
function rm<T>(a: T[], v: T): void { const i = a.indexOf(v); if (i >= 0) a.splice(i, 1); }
