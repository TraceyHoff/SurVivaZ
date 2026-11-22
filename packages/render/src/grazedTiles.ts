/**
 * ADR-505: grazed-grass tiles with a per-chunk revision.
 *
 * ADR-256 kept one global `grazedRev`, so every GrazedTile added or removed anywhere (an animal eating a tile,
 * grass regrowing) changed the stamp of every terrain chunk: the WebGL2 TileTerrain rebuilt every visible chunk
 * in one frame and then re-prewarmed both adjacent rotation quarters, and Canvas2D re-baked every gt block.
 * With grazing animals near the player that was a rebuild burst every second or two (a visible hitch on phones).
 *
 * A grazed tile only changes its own cell's base layer (groundArt.groundLayers asks `grazed(x, y)` for the cell
 * being built, never a neighbour), so a change only needs to invalidate the chunk that holds the tile.
 * `commit()` diffs the new set against the previous one and bumps just those chunks' revisions; the renderers
 * fold `chunkRev(cx, cy)` into their chunk / block stamps. Keys are numbers (no per-frame string building).
 */
import { CHUNK_SIZE } from "@engine/world";

const OFF = 1 << 21, SPAN = 1 << 22; // |tile coord| < 2M: unique integer keys well inside 2^53

/** Integer key of a world tile (tx, ty). */
export function grazedTileKey(tx: number, ty: number): number { return (tx + OFF) * SPAN + (ty + OFF); }

export class GrazedTiles {
  private cur = new Set<number>();
  private nxt = new Set<number>();
  private readonly crev = new Map<number, number>();
  /** Bumped once per commit that changed anything (diag / legacy single-revision callers). */
  rev = 0;
  /** Lookup in world tile coords; a stable closure (safe to hand to builders). */
  readonly at = (tx: number, ty: number): boolean => this.cur.has(grazedTileKey(tx, ty));
  get size(): number { return this.cur.size; }
  /** Start collecting the next set (no allocation: the scratch set is reused). */
  begin(): void { this.nxt.clear(); }
  add(tx: number, ty: number): void { this.nxt.add(grazedTileKey(tx, ty)); }
  /** Swap in the collected set; bumps the revision of every chunk whose grazed tiles changed. True = changed. */
  commit(): boolean {
    const a = this.cur, b = this.nxt; let changed = false;
    if (a.size !== b.size || a.size > 0) {
      for (const k of a) if (!b.has(k)) { this.bump(k); changed = true; }
      for (const k of b) if (!a.has(k)) { this.bump(k); changed = true; }
    }
    this.cur = b; this.nxt = a;
    if (changed) this.rev++;
    return changed;
  }
  /** Revision of chunk (cx, cy): changes only when a grazed tile inside that chunk was added or removed. */
  chunkRev(cx: number, cy: number): number { return this.crev.get(grazedTileKey(cx, cy)) ?? 0; }
  private bump(k: number): void {
    const tx = Math.floor(k / SPAN) - OFF, ty = (k - Math.floor(k / SPAN) * SPAN) - OFF;
    const ck = grazedTileKey(Math.floor(tx / CHUNK_SIZE), Math.floor(ty / CHUNK_SIZE));
    this.crev.set(ck, ((this.crev.get(ck) ?? 0) + 1) | 0);
  }
}
