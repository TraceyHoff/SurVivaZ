/**
 * StructureIndex: the sim-local mirror of all build pieces (both peers).
 *  - cell + free pieces live in @engine/world BuildingGrid instances (gridId <-> entity);
 *  - thin edge walls live in an EdgeIndex keyed by (tx, ty, z, side N|W) (BuildingGrid has no edge layer);
 *  - openings (doors/hatches/window inserts) are keyed by their parent piece;
 *  - per-chunk piece sets + versions (persistence dirty tracking / net static versions).
 * The server places pieces directly through addPiece(); replicated or loaded pieces are indexed by the
 * structureIndex system from Transform + BuildPiece (PieceSlot is derived, never replicated).
 */
import { defineResource, entityIndex, Transform, type Entity, type World } from "@engine/core";
import { BuildingGrid, chunkKeyOf, type ChunkKey } from "@engine/world";
import { BuildPiece, EdgeSide, PieceLink, PieceSlot, PieceStability, type AttachKind } from "../components.js";
import { gameplayDefs, isAuthority } from "../config.js";
import { Placement, type GameDefs, type PieceDef } from "../defs.js";
import { linkAttachment } from "./links.js";
import { TRI_INRADIUS, triEdges, triGridEdge, triKey } from "./modular.js";

/** Canonical piece layer ids (PieceLink.layer / BuildingGrid layer); render imports these from here only. */
export const LAYER_DECK = 0, LAYER_STRUCT = 1, LAYER_FURNITURE = 2, LAYER_DECOR = 3, LAYER_OPENING = 4;
const OFF = 1 << 20;
export const edgeKey = (tx: number, ty: number, z: number, side: EdgeSide): number => ((tx + OFF) * 2 ** 21 + (ty + OFF)) * 32 + z * 2 + (side - 1);

/**
 * ADR-211 L corner at vertex (vx,vy), rot r (arms rot0 +x/+y, rot1 -x/+y, rot2 -x/-y, rot3 +x/-y): the deck tile it wraps
 * and its two arms as (edge tx, ty, side, wall rot, arm midpoint x, y). Arm wall rots face outward like a perimeter wall
 * (north 0, west 1, south 2, east 3), so the arm sprites are the tier's straight wall at the exact edge pivot.
 */
export type LArm = { tx: number; ty: number; side: EdgeSide; wallRot: number; x: number; y: number };
export const lCornerTile = (vx: number, vy: number, rot: number): [number, number] => [(rot & 3) === 1 || (rot & 3) === 2 ? vx - 1 : vx, (rot & 3) >= 2 ? vy - 1 : vy];
export function lCornerArms(vx: number, vy: number, rot: number): [LArm, LArm] {
  const r = rot & 3; const [cx, cy] = lCornerTile(vx, vy, r);
  const south = r >= 2, east = r === 1 || r === 2;
  return [
    { tx: cx, ty: south ? cy + 1 : cy, side: EdgeSide.North, wallRot: south ? 2 : 0, x: cx + 0.5, y: vy },
    { tx: east ? cx + 1 : cx, ty: cy, side: EdgeSide.West, wallRot: east ? 3 : 1, x: vx, y: cy + 0.5 },
  ];
}
export const isLCorner = (def: PieceDef | undefined): boolean => def?.shape === "L";

/** fx/fy: exact centroid of tri pieces (tx/ty = the tile containing it). */
export interface Slot { tx: number; ty: number; z: number; side: EdgeSide; rot: number; fx?: number; fy?: number }

/** Geometry of a piece def at a slot: Transform center + facing. */
/**
 * ADR-174 free (off-grid) placement. A Placement.Free piece placed with snap off carries FINE_ROT (bit 7) in its rot:
 * the low bits are a FINE_ROT_STEPS step (15°) and its position is on a FINE_POS_STEP (1/16 tile) grid. Snapped free
 * pieces keep their 0..rotSteps-1 rot and quarter-tile position. Rot stays one u8 (PlaceCmd, BuildPiece, STRC).
 */
export const FINE_ROT = 0x80, FINE_ROT_STEPS = 24, FINE_POS_STEP = 1 / 16;
export const isFineRot = (def: PieceDef, rot: number): boolean => def.placement === Placement.Free && (rot & FINE_ROT) !== 0;
/** Rotation as (step, steps) for art / facing: fine rot → (low bits, 24); else (rot, def steps). */
export function rotParts(def: PieceDef, rot: number): { rot: number; steps: number } {
  if (isFineRot(def, rot)) return { rot: (rot & 0x7f) % FINE_ROT_STEPS, steps: FINE_ROT_STEPS };
  return { rot, steps: def.placement === Placement.Free ? def.rotSteps || 16 : def.placement === Placement.Tri ? 12 : 4 };
}
export function slotTransform(def: PieceDef, slot: Slot, levelHeight: number, x?: number, y?: number): { x: number; y: number; z: number; facing: number } {
  const z = slot.z * levelHeight;
  if (def.placement === Placement.Edge || (def.placement === Placement.Opening && slot.side !== EdgeSide.None)) {
    const flip = (slot.rot & 2) ? Math.PI : 0;
    return slot.side === EdgeSide.North ? { x: slot.tx + 0.5, y: slot.ty, z, facing: norm(flip) } : { x: slot.tx, y: slot.ty + 0.5, z, facing: norm(Math.PI / 2 + flip) };
  }
  if (def.placement === Placement.Free) return { x: x ?? slot.tx + 0.5, y: y ?? slot.ty + 0.5, z, facing: norm((rotParts(def, slot.rot).rot * 2 * Math.PI) / rotParts(def, slot.rot).steps) };
  if (def.placement === Placement.Tri) return { x: slot.fx ?? x ?? slot.tx + 0.5, y: slot.fy ?? y ?? slot.ty + 0.5, z, facing: norm((slot.rot * Math.PI) / 6) };
  const [w, h] = rotatedSize(def, slot.rot & 3);
  return { x: slot.tx + w / 2, y: slot.ty + h / 2, z, facing: norm((slot.rot & 3) * Math.PI / 2) };
}
const norm = (a: number): number => { let r = a; while (r > Math.PI) r -= 2 * Math.PI; while (r < -Math.PI) r += 2 * Math.PI; return r; };
export const rotatedSize = (def: PieceDef, rot4: number): [number, number] => (rot4 & 1 ? [def.footprint.h, def.footprint.w] : [def.footprint.w, def.footprint.h]);
/** Grid rotation (0..3) used for occupancy: cells use rot directly, free pieces round their 16-step rot. */
export const gridRot = (def: PieceDef, rot: number): number => (def.placement === Placement.Free ? Math.round(rotParts(def, rot).rot / (rotParts(def, rot).steps / 4)) & 3 : def.placement === Placement.Tri ? 0 : rot & 3);
/** Anchor tile of a cell/free footprint centred near (x,y). */
export function anchorFor(def: PieceDef, x: number, y: number, rot4: number): [number, number] {
  const [w, h] = rotatedSize(def, rot4); return [Math.floor(x - w / 2 + 0.5), Math.floor(y - h / 2 + 0.5)];
}

/** ADR-215 coarse occupancy block size (tiles) and padding for footprints larger than the anchor tile. */
export const NAV_BLOCK = 8; const NAV_PAD = 4;
const navBlockKey = (bx: number, by: number): number => (bx + 0x8000) * 0x10000 + (by + 0x8000);

export class StructureIndex {
  readonly grid: BuildingGrid;
  readonly byGrid = new Map<number, Entity>();
  readonly edges = new Map<number, Entity>();
  /** parent piece -> opening piece. */
  readonly openings = new Map<Entity, Entity>();
  /** Triangle pieces (placement tri, ADR-104): quantized centroid key -> entity; tile key -> tris centred in it. */
  readonly tris = new Map<number, Entity>();
  readonly tileTris = new Map<number, Set<Entity>>();
  readonly chunkPieces = new Map<ChunkKey, Set<Entity>>();
  readonly chunkVersions = new Map<ChunkKey, number>();
  /** privilege zone (claim piece) -> piece count; piece -> zone. */
  readonly zoneCounts = new Map<Entity, number>();
  readonly zoneOf = new Map<Entity, Entity>();
  /** server: pieces whose stability must be (re)computed this tick; removals trigger region recompute. */
  readonly dirty = new Set<Entity>();
  readonly removedNeighbors = new Set<Entity>();
  /** server: hp damage batched per tick. */
  readonly pendingDamage = new Map<Entity, number>();
  /** entity -> where it is indexed (removal works even after the entity died). */
  readonly info = new Map<Entity, { slot: Slot; gridId: number; parent: Entity | 0; def: PieceDef; ck: ChunkKey }>();
  constructor(readonly world: World, readonly defs: GameDefs) { this.grid = new BuildingGrid(defs.pieceRegistry); this.grid.recordChanges = false; } // nothing drains buildingChanges(); pieces replicate via ECS

  def(e: Entity): PieceDef | undefined { const i = this.info.get(e); if (i) return i.def; const t = this.world.getField(e, BuildPiece, "type"); return t === undefined ? undefined : this.defs.pieces.get(t); }
  slotOf(e: Entity): Slot & { gridId: number; parent: number } | undefined {
    const st = this.world.store(PieceSlot); const s = st.slot(entityIndex(e)); if (s < 0) return undefined;
    const d = st.data;
    const out: Slot & { gridId: number; parent: number } = { tx: d.tx[s]!, ty: d.ty[s]!, z: d.z[s]!, side: d.side[s]! as EdgeSide, rot: this.world.getField(e, BuildPiece, "rot") ?? 0, gridId: d.gridId[s]!, parent: d.parent[s]! };
    const inf = this.info.get(e); if (inf && inf.slot.fx !== undefined) { out.fx = inf.slot.fx; out.fy = inf.slot.fy!; }
    return out;
  }

  // ---- lookups ----
  deck(tx: number, ty: number, z: number): Entity | 0 { const id = this.grid.at(tx, ty, z, LAYER_DECK); return id ? this.byGrid.get(id) ?? 0 : 0; }
  cell(tx: number, ty: number, z: number, layer: number): Entity | 0 { const id = this.grid.at(tx, ty, z, layer); return id ? this.byGrid.get(id) ?? 0 : 0; }
  edge(tx: number, ty: number, z: number, side: EdgeSide): Entity | 0 { return this.edges.get(edgeKey(tx, ty, z, side)) ?? 0; }
  opening(parent: Entity): Entity | 0 { return this.openings.get(parent) ?? 0; }
  /** ADR-112 wall mounts: (edge, face) -> mounted piece; face = rot & 2. */
  readonly mounts = new Map<string, Entity>();
  mount(tx: number, ty: number, z: number, side: EdgeSide, face: number): Entity | 0 { return this.mounts.get(`${edgeKey(tx, ty, z, side)}:${face & 2}`) ?? 0; }
  /** Mounted pieces hung on the wall at this edge (both faces). */
  mountsOn(tx: number, ty: number, z: number, side: EdgeSide): Entity[] { const out: Entity[] = []; for (const f of [0, 2]) { const m = this.mount(tx, ty, z, side, f); if (m) out.push(m); } return out; }
  /** Triangle whose centroid is within 0.1 of (x,y) at level z. */
  triAt(x: number, y: number, z: number): Entity | 0 {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const e = this.tris.get(triKey(x + dx / 16, y + dy / 16, z)); if (e === undefined) continue;
      const i = this.info.get(e); if (i && Math.hypot((i.slot.fx ?? 0) - x, (i.slot.fy ?? 0) - y) < 0.1) return e;
    }
    return 0;
  }
  /** Triangles centred in tile (tx,ty) at z. */
  trisInTile(tx: number, ty: number, z: number): readonly Entity[] { const s = this.tileTris.get(edgeKey(tx, ty, z, EdgeSide.North)); return s ? [...s].sort((a, b) => a - b) : []; }
  /** Deck-like piece (square deck or tri) across a grid edge from point (x,y) along normal (nx,ny). */
  private across(mx: number, my: number, nx: number, ny: number, z: number, out: (e: Entity | 0) => void): void {
    out(this.triAt(mx + nx * TRI_INRADIUS, my + ny * TRI_INRADIUS, z));
  }
  /** Four edges of a tile: N, S, W, E as (tx, ty, side). */
  static tileEdges(tx: number, ty: number): [number, number, EdgeSide][] {
    return [[tx, ty, EdgeSide.North], [tx, ty + 1, EdgeSide.North], [tx, ty, EdgeSide.West], [tx + 1, ty, EdgeSide.West]];
  }
  /** The two tiles an edge separates. */
  static edgeTiles(tx: number, ty: number, side: EdgeSide): [[number, number], [number, number]] {
    return side === EdgeSide.North ? [[tx, ty], [tx, ty - 1]] : [[tx, ty], [tx - 1, ty]];
  }
  tilesOf(e: Entity): [number, number][] {
    const d = this.def(e); const s = this.slotOf(e); if (!d || !s) return [];
    if (s.side !== EdgeSide.None) return [];
    if (d.placement === Placement.Tri) return [[s.tx, s.ty]];
    return this.grid.footprintTiles(d.id, s.tx, s.ty, gridRot(d, s.rot));
  }
  /** Piece at a PieceLink-style slot key. layer 4 = opening hosted by the piece at that slot. */
  atSlot(tx: number, ty: number, z: number, side: EdgeSide, layer: number): Entity | 0 {
    if (layer === 3 && side !== EdgeSide.None && this.ladder(tx, ty, side)) return this.ladder(tx, ty, side);
    if (layer === LAYER_OPENING) {
      const parent = side !== EdgeSide.None ? this.edge(tx, ty, z, side) : this.deck(tx, ty, z);
      return parent ? this.opening(parent) : 0;
    }
    return side !== EdgeSide.None ? this.edge(tx, ty, z, side) : this.cell(tx, ty, z, layer);
  }
  /** Is this deck usable as a floor for walls/furniture (not a roof)? */
  isDeck(e: Entity | 0): e is Entity { return e !== 0 && !this.def(e)?.roof; }

  /** ADR-265: terrain ladders share an edge with a doorway, but never replace it. */
  readonly ladders = new Map<number, Entity>();
  ladder(tx: number, ty: number, side: EdgeSide): Entity | 0 { return this.ladders.get(edgeKey(tx, ty, 0, side)) ?? 0; }

  /** ADR-299: ground shaft hatches keyed by their cell (level 0). */
  readonly hatches = new Map<number, Entity>();
  hatch(tx: number, ty: number): Entity | 0 { return this.hatches.get(edgeKey(tx, ty, 0, EdgeSide.North)) ?? 0; }

  // ---- add / remove ----
  /** Indexes a piece entity at a slot (no rule checks). Returns false if occupied. */
  addPiece(e: Entity, slot: Slot, parent: Entity | 0 = 0): boolean {
    const def = this.def(e); if (!def) return false;
    let gridId = 0;
    if (def.features.terrainLadder) {
      const k = edgeKey(slot.tx, slot.ty, 0, slot.side); if (this.ladders.has(k)) return false; this.ladders.set(k, e);
    } else if (def.placement === Placement.Opening) {
      if (!parent || this.openings.has(parent)) return false;
      this.openings.set(parent, e);
    } else if (def.placement === Placement.Edge && def.features.mount) {
      const k = `${edgeKey(slot.tx, slot.ty, slot.z, slot.side)}:${slot.rot & 2}`; if (this.mounts.has(k)) return false;
      this.mounts.set(k, e);
    } else if (def.placement === Placement.Edge) {
      const k = edgeKey(slot.tx, slot.ty, slot.z, slot.side); if (this.edges.has(k)) return false;
      this.edges.set(k, e);
    } else if (def.placement === Placement.Tri) {
      const fx = slot.fx ?? slot.tx + 0.5, fy = slot.fy ?? slot.ty + 0.5;
      if (this.triAt(fx, fy, slot.z)) return false;
      this.tris.set(triKey(fx, fy, slot.z), e);
      const tk = edgeKey(slot.tx, slot.ty, slot.z, EdgeSide.North); let ts = this.tileTris.get(tk); if (!ts) this.tileTris.set(tk, (ts = new Set())); ts.add(e);
    } else {
      const arms = isLCorner(def) ? lCornerArms(slot.tx, slot.ty, slot.rot).map((a) => edgeKey(a.tx, a.ty, slot.z, a.side)) : [];
      if (arms.some((k) => this.edges.has(k))) return false;
      gridId = this.grid.place(def.id, slot.tx, slot.ty, slot.z, gridRot(def, slot.rot));
      if (!gridId) return false;
      this.byGrid.set(gridId, e);
      for (const k of arms) this.edges.set(k, e); // ADR-211: the L claims both arm edges (walls, doors, paths, enclosure)
    }
    const w = this.world;
    if (w.has(e, PieceSlot)) w.set(e, PieceSlot, { tx: slot.tx, ty: slot.ty, z: slot.z, side: slot.side, gridId, parent });
    else w.add(e, PieceSlot, { tx: slot.tx, ty: slot.ty, z: slot.z, side: slot.side, gridId, parent });
    const ck = this.chunkOf(e); this.info.set(e, { slot: { ...slot }, gridId, parent, def, ck });
    let set = this.chunkPieces.get(ck); if (!set) this.chunkPieces.set(ck, (set = new Set()));
    set.add(e); this.bump(ck); this.coarse(slot.tx, slot.ty, def, 1);
    if (def.features.shaftHatch) this.hatches.set(edgeKey(slot.tx, slot.ty, 0, EdgeSide.North), e);
    return true;
  }
  removePiece(e: Entity, keepSlot = false): void {
    const inf = this.info.get(e); if (!inf) return;
    this.info.delete(e);
    const { slot: s, def } = inf; this.coarse(s.tx, s.ty, def, -1);
    if (def.features.terrainLadder) this.ladders.delete(edgeKey(s.tx, s.ty, 0, s.side));
    if (def.features.shaftHatch) this.hatches.delete(edgeKey(s.tx, s.ty, 0, EdgeSide.North));
    else if (inf.parent && this.openings.get(inf.parent) === e) this.openings.delete(inf.parent);
    else if (def.placement === Placement.Edge && def.features.mount) { const k = `${edgeKey(s.tx, s.ty, s.z, s.side)}:${s.rot & 2}`; if (this.mounts.get(k) === e) this.mounts.delete(k); }
    else if (def.placement === Placement.Edge) { const k = edgeKey(s.tx, s.ty, s.z, s.side); if (this.edges.get(k) === e) this.edges.delete(k); }
    else if (isLCorner(def)) for (const a of lCornerArms(s.tx, s.ty, s.rot)) { const k = edgeKey(a.tx, a.ty, s.z, a.side); if (this.edges.get(k) === e) this.edges.delete(k); }
    this.openings.delete(e);
    if (def.placement === Placement.Tri) {
      const k = triKey(s.fx ?? s.tx + 0.5, s.fy ?? s.ty + 0.5, s.z); if (this.tris.get(k) === e) this.tris.delete(k);
      const tk = edgeKey(s.tx, s.ty, s.z, EdgeSide.North); const ts = this.tileTris.get(tk); if (ts) { ts.delete(e); if (!ts.size) this.tileTris.delete(tk); }
    }
    if (inf.gridId) { this.grid.remove(inf.gridId); this.byGrid.delete(inf.gridId); }
    const set = this.chunkPieces.get(inf.ck); if (set?.delete(e)) { this.bump(inf.ck); if (!set.size) this.chunkPieces.delete(inf.ck); }
    const z = this.zoneOf.get(e); if (z !== undefined) { this.zoneOf.delete(e); this.zoneCounts.set(z, (this.zoneCounts.get(z) ?? 1) - 1); }
    this.dirty.delete(e); this.pendingDamage.delete(e);
    if (!keepSlot && this.world.isAlive(e) && this.world.has(e, PieceSlot)) this.world.remove(e, PieceSlot);
  }
  /**
   * ADR-318: run `fn` with piece `e` out of every lookup (a move is validated as if the piece were not there, so it
   * may land on or overlap its own old footprint), then index it back exactly where it was: same slot, parent, zone
   * count, dirty / damage state and chunk / structure version counters, so a client preview causes no rebuild churn.
   */
  lifted<T>(e: Entity, fn: () => T): T {
    const inf = this.info.get(e); if (!inf) return fn();
    const zone = this.zoneOf.get(e); const ver = this.version; const cv = this.chunkVersions.get(inf.ck);
    const wasDirty = this.dirty.has(e); const dmg = this.pendingDamage.get(e);
    this.removePiece(e, true);
    try { return fn(); } finally {
      this.addPiece(e, inf.slot, inf.parent);
      if (zone !== undefined) { this.zoneOf.set(e, zone); this.zoneCounts.set(zone, (this.zoneCounts.get(zone) ?? 0) + 1); }
      if (wasDirty) this.dirty.add(e); if (dmg !== undefined) this.pendingDamage.set(e, dmg);
      this.version = ver; if (cv === undefined) this.chunkVersions.delete(inf.ck); else this.chunkVersions.set(inf.ck, cv);
    }
  }
  /** ADR-318: where a piece is indexed now (slot + parent), or undefined. */
  indexedAt(e: Entity): { slot: Slot; parent: Entity | 0 } | undefined { const i = this.info.get(e); return i ? { slot: { ...i.slot }, parent: i.parent } : undefined; }
  removePieceByEntity(e: Entity): void { this.removePiece(e); }
  chunkOf(e: Entity): ChunkKey { const tf = this.world.get(e, Transform)!; return chunkKeyOf(tf.x, tf.y); }
  bump(ck: ChunkKey): void { this.chunkVersions.set(ck, (this.chunkVersions.get(ck) ?? 0) + 1); this.version++; }
  /** Bumped on any structural change (and door toggles); invalidates enclosure caches. */
  version = 0;
  /**
   * Piece blocking movement across an edge at level z: a blocking wall, or a doorway/hatch whose door is closed.
   * Returns the entity to attack to break through (door if present, else the wall), or 0 if passable.
   */
  edgeBlocker(tx: number, ty: number, z: number, side: EdgeSide): Entity | 0 {
    const w = this.edge(tx, ty, z, side); if (!w) return 0;
    const d = this.def(w)!; const op = this.openings.get(w);
    if (op) { const od = this.def(op); if (od?.door) return !this.doorOpen(op) ? op : d.blocksPath ? w : 0; return od?.blocksPath ? op : d.blocksPath ? w : 0; } // ADR-212: open shutters leave a window wall solid
    return d.blocksPath ? w : 0;
  }
  /** Door open state lookup (DoorState lives on the door's attachment entity). Set by the doors module. */
  doorOpen: (door: Entity) => boolean = () => false;
  private encCache = new Map<number, { enclosed: boolean; size: number }>(); private encVersion = -1;
  /** Flood fill over tiles at level z bounded by blocking edge walls / closed doors (thin walls are not grid cells). */
  edgeEnclosure(tx: number, ty: number, z: number, maxCells = 256): { enclosed: boolean; size: number } {
    if (this.encVersion !== this.version) { this.encCache.clear(); this.encVersion = this.version; }
    const key = edgeKey(tx, ty, z, EdgeSide.North); const hit = this.encCache.get(key); if (hit) return hit;
    const seen = new Set<number>([key]); const stack: [number, number][] = [[tx, ty]]; let open = false;
    while (stack.length && !open) {
      const [x, y] = stack.pop()!;
      const nb: [number, number, number, number, EdgeSide][] = [[x, y - 1, x, y, EdgeSide.North], [x, y + 1, x, y + 1, EdgeSide.North], [x - 1, y, x, y, EdgeSide.West], [x + 1, y, x + 1, y, EdgeSide.West]];
      for (const [nx, ny, ex, ey, side] of nb) {
        if (this.edgeBlocker(ex, ey, z, side) || (this.edge(ex, ey, z, side) && this.def(this.edge(ex, ey, z, side) as Entity)?.opening === 3)) continue;
        const k = edgeKey(nx, ny, z, EdgeSide.North); if (seen.has(k)) continue;
        seen.add(k); if (seen.size > maxCells) { open = true; break; } stack.push([nx, ny]);
      }
    }
    const r = { enclosed: !open, size: seen.size };
    if (!open) for (const k of seen) this.encCache.set(k, r); else this.encCache.set(key, r);
    return r;
  }
  /** Tris on either side of a grid edge at z. */
  edgeTris(tx: number, ty: number, z: number, side: EdgeSide): Entity[] {
    if (!this.tris.size) return [];
    const [mx, my, nx, ny] = side === EdgeSide.North ? [tx + 0.5, ty, 0, 1] : [tx, ty + 0.5, 1, 0];
    const out: Entity[] = []; for (const sg of [1, -1]) { const t = this.triAt(mx + sg * nx * TRI_INRADIUS, my + sg * ny * TRI_INRADIUS, z); if (t) out.push(t); }
    return out;
  }
  /** Indexed piece count; O(1) (info and chunkPieces are kept in step by addPiece/removePiece). Hot: movement checks it per axis. */
  get count(): number { return this.info.size; }
  /** ADR-215: free-standing vertex corner posts (inner / angled; not ADR-211 L corners, which are edges) for a collision early-out. */
  vertexPosts = 0;
  /** ADR-215: piece counts per NAV_BLOCK x NAV_BLOCK tile block (anchor tile), so creature nav can skip open ground cheaply. */
  readonly blockCounts = new Map<number, number>();
  private coarse(tx: number, ty: number, def: PieceDef, d: 1 | -1): void {
    if (def.snap === "vertex" && def.solid && !isLCorner(def)) this.vertexPosts += d;
    const k = navBlockKey(Math.floor(tx / NAV_BLOCK), Math.floor(ty / NAV_BLOCK)); const n = (this.blockCounts.get(k) ?? 0) + d;
    if (n > 0) this.blockCounts.set(k, n); else this.blockCounts.delete(k);
  }
  /** ADR-215: any piece anchored within the tile rect (inclusive, padded by NAV_PAD for multi-tile footprints / wall faces)? */
  anyPieceNear(x0: number, y0: number, x1: number, y1: number): boolean {
    if (!this.info.size) return false;
    const bx0 = Math.floor((Math.min(x0, x1) - NAV_PAD) / NAV_BLOCK), bx1 = Math.floor((Math.max(x0, x1) + NAV_PAD) / NAV_BLOCK);
    const by0 = Math.floor((Math.min(y0, y1) - NAV_PAD) / NAV_BLOCK), by1 = Math.floor((Math.max(y0, y1) + NAV_PAD) / NAV_BLOCK);
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) if (this.blockCounts.has(navBlockKey(bx, by))) return true;
    return false;
  }

  // ---- support graph (server stability; also used for client-side "has any support" ghost checks) ----
  /** Supporting pieces of an indexed piece with the loss kind: 0 none (openings/furniture), 1 vertical, 2 horizontal. */
  supports(e: Entity, out: [Entity, number][] = []): { root: boolean; list: [Entity, number][] } {
    const def = this.def(e); const s = this.slotOf(e); out.length = 0;
    if (!def || !s) return { root: false, list: out };
    return this.supportsAt(def, s, s.parent, e, out);
  }
  /** Same for a hypothetical placement (validation / ghost). `self` is excluded from results. */
  supportsAt(def: PieceDef, s: Slot, parent: Entity | 0, self: Entity | 0 = 0, out: [Entity, number][] = []): { root: boolean; list: [Entity, number][] } {
    out.length = 0; const z = s.z;
    if (def.features.terrainLadder) return { root: z === 0, list: out };
    if (def.features.shaftHatch) return { root: z === 0, list: out };
    if (def.placement === Placement.Opening || def.features.mount) { if (parent) out.push([parent, 0]); return { root: false, list: out }; }
    if (def.placement === Placement.Edge) {
      for (const [x, y] of StructureIndex.edgeTiles(s.tx, s.ty, s.side)) { const d = this.deck(x, y, z); if (this.isDeck(d)) out.push([d, 1]); }
      if (z > 0) { const below = this.edge(s.tx, s.ty, z - 1, s.side); if (below) out.push([below, 1]); }
      for (const t of this.edgeTris(s.tx, s.ty, z, s.side)) if (this.isDeck(t)) out.push([t, 1]);
      return { root: false, list: out };
    }
    if (def.placement === Placement.Tri) {
      if (z === 0 && def.groundOnly) return { root: true, list: out };
      const seen = new Set<Entity>(); const push = (x: Entity | 0, k: number): void => { if (x && x !== self && !seen.has(x)) { seen.add(x); out.push([x, k]); } };
      for (const e of triEdges(s.fx ?? s.tx + 0.5, s.fy ?? s.ty + 0.5, s.rot)) {
        this.across(e.mx, e.my, e.nx, e.ny, z, (x) => push(x, 2));
        const g = triGridEdge(e); if (!g) continue;
        const d = this.deck(Math.floor(e.mx + e.nx * 0.25), Math.floor(e.my + e.ny * 0.25), z); if (this.isDeck(d)) push(d, 2);
        if (z > 0) { const w = this.edge(g.tx, g.ty, z - 1, g.side); if (w && this.def(w)?.placement === Placement.Edge) push(w, 1); }
      }
      return { root: false, list: out };
    }
    const tiles = this.grid.footprintTiles(def.id, s.tx, s.ty, gridRot(def, s.rot));
    const seen = new Set<Entity>();
    const push = (x: Entity | 0, kind: number): void => { if (x && x !== self && !seen.has(x)) { seen.add(x); out.push([x, kind]); } };
    if (def.layer === LAYER_DECK) {
      if (z === 0) return { root: def.groundOnly, list: out };
      for (const [x, y] of tiles) {
        for (const [ex, ey, side] of StructureIndex.tileEdges(x, y)) { const w = this.edge(ex, ey, z - 1, side); if (w && this.def(w)?.placement === Placement.Edge) push(w, 1); }
        const p = this.cell(x, y, z - 1, LAYER_STRUCT); if (p && this.def(p)?.supportsAbove) push(p, 1);
        for (const [dx, dy] of NEIGH) push(this.deck(x + dx, y + dy, z), 2);
        if (this.tris.size) for (const [mx, my, nx, ny] of tileEdgeNormals(x, y)) this.across(mx, my, nx, ny, z, (t) => push(t, 2));
      }
      return { root: false, list: out };
    }
    if (def.placement === Placement.Free && def.ground && z === 0) {
      let onDeck = false; for (const [x, y] of tiles) if (this.isDeck(this.deck(x, y, 0))) { onDeck = true; break; }
      if (!onDeck) return { root: true, list: out };
    }
    if (def.snap === "vertex") { for (const [x, y] of [[s.tx, s.ty], [s.tx - 1, s.ty], [s.tx, s.ty - 1], [s.tx - 1, s.ty - 1]] as const) { const d = this.deck(x, y, z); if (this.isDeck(d)) push(d, 0); } return { root: false, list: out }; }
    if (def.small) for (const [x, y] of tiles) { const f = this.cell(x, y, z, 2); if (f && (this.def(f)?.surfaceHeight ?? 0) > 0) push(f, 0); } // ADR-162 on a table / shelf
    for (const [x, y] of tiles) {
      const d = this.deck(x, y, z); if (this.isDeck(d)) push(d, def.placement === Placement.Free ? 0 : 1);
      if (def.layer === LAYER_STRUCT && z > 0) { const p = this.cell(x, y, z - 1, LAYER_STRUCT); if (p && this.def(p)?.supportsAbove) push(p, 1); }
    }
    return { root: false, list: out };
  }
  /** Pieces that may rest on e (reverse of supports). */
  dependents(e: Entity, out: Entity[] = []): Entity[] {
    out.length = 0; const def = this.def(e); const s = this.slotOf(e); if (!def || !s) return out;
    const z = s.z; const add = (x: Entity | 0): void => { if (x && x !== e && !out.includes(x)) out.push(x); };
    const op = this.openings.get(e); if (op) add(op);
    if (def.placement === Placement.Edge) {
      if (!def.features.mount) for (const m of this.mountsOn(s.tx, s.ty, z, s.side)) add(m);
      for (const [x, y] of StructureIndex.edgeTiles(s.tx, s.ty, s.side)) add(this.deck(x, y, z + 1));
      add(this.edge(s.tx, s.ty, z + 1, s.side));
      for (const t of this.edgeTris(s.tx, s.ty, z + 1, s.side)) add(t);
      return out;
    }
    if (def.placement === Placement.Tri) {
      for (const e2 of triEdges(s.fx ?? s.tx + 0.5, s.fy ?? s.ty + 0.5, s.rot)) {
        this.across(e2.mx, e2.my, e2.nx, e2.ny, z, add);
        const g = triGridEdge(e2); if (!g) continue;
        add(this.deck(Math.floor(e2.mx + e2.nx * 0.25), Math.floor(e2.my + e2.ny * 0.25), z)); add(this.edge(g.tx, g.ty, z, g.side));
      }
      for (let la = 1; la < 4; la++) add(this.cell(s.tx, s.ty, z, la));
      return out;
    }
    if (def.placement !== Placement.Cell) return out;
    const tiles = this.grid.footprintTiles(def.id, s.tx, s.ty, gridRot(def, s.rot));
    for (const [x, y] of tiles) {
      if (def.layer === LAYER_DECK) {
        for (const [ex, ey, side] of StructureIndex.tileEdges(x, y)) add(this.edge(ex, ey, z, side));
        for (let la = 1; la < 4; la++) add(this.cell(x, y, z, la));
        for (const [vx, vy] of [[x + 1, y], [x, y + 1], [x + 1, y + 1]] as const) { const c = this.cell(vx, vy, z, LAYER_DECOR); if (c && this.def(c)?.snap === "vertex") add(c); }
        for (const [dx, dy] of NEIGH) add(this.deck(x + dx, y + dy, z));
        if (this.tris.size) for (const [mx, my, nx, ny] of tileEdgeNormals(x, y)) this.across(mx, my, nx, ny, z, add);
      } else if (def.supportsAbove) { add(this.deck(x, y, z + 1)); add(this.cell(x, y, z + 1, LAYER_STRUCT)); }
    }
    return out;
  }
}
const NEIGH = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
/** Tile edges as (midpoint, outward normal): N, S, W, E. */
const tileEdgeNormals = (x: number, y: number): [number, number, number, number][] => [[x + 0.5, y, 0, -1], [x + 0.5, y + 1, 0, 1], [x, y + 0.5, -1, 0], [x + 1, y + 0.5, 1, 0]];

export const StructureIndexRes = defineResource<StructureIndex>("gameplay.StructureIndex");
export function structures(world: World): StructureIndex {
  let s = world.getResource(StructureIndexRes);
  if (!s) world.setResource(StructureIndexRes, (s = new StructureIndex(world, gameplayDefs(world))));
  return s;
}

/** Slot from a piece position (Transform x/y, level) + BuildPiece.rot. */
export function slotFromPos(def: PieceDef, x: number, y: number, z: number, rot: number): Slot {
  const edgeLike = def.placement === Placement.Edge || (def.placement === Placement.Opening && def.fits !== 4);
  if (edgeLike) {
    const side = rot & 1 ? EdgeSide.West : EdgeSide.North;
    return side === EdgeSide.North ? { tx: Math.floor(x), ty: Math.round(y), z, side, rot } : { tx: Math.round(x), ty: Math.floor(y), z, side, rot };
  }
  if (def.placement === Placement.Opening) return { tx: Math.floor(x), ty: Math.floor(y), z, side: EdgeSide.None, rot };
  if (def.placement === Placement.Tri) return { tx: Math.floor(x), ty: Math.floor(y), z, side: EdgeSide.None, rot, fx: x, fy: y };
  const [tx, ty] = anchorFor(def, x, y, gridRot(def, rot));
  return { tx, ty, z, side: EdgeSide.None, rot };
}
/** Derive a slot from replicated/loaded Transform + BuildPiece. */
export function deriveSlot(world: World, e: Entity, def: PieceDef): Slot {
  const tf = world.get(e, Transform)!;
  return slotFromPos(def, tf.x, tf.y, Math.round(tf.z / gameplayDefs(world).building.levelHeight), world.getField(e, BuildPiece, "rot")!);
}
/** Parent (host) of an opening at a slot. */
export function openingParent(idx: StructureIndex, def: PieceDef, slot: Slot): Entity | 0 {
  return slot.side !== EdgeSide.None ? idx.edge(slot.tx, slot.ty, slot.z, slot.side) : idx.deck(slot.tx, slot.ty, slot.z);
}

/**
 * Both peers: index BuildPiece entities that are not yet indexed (replicated / loaded), link PieceLink attachments,
 * and drop removed pieces from the index.
 */
export function structureIndexSystem(world: World): void {
  const idx = structures(world);
  for (const e of world.removed(BuildPiece)) idx.removePieceByEntity(e);
  // ADR-318: a replicated piece the server moved (Move keeps the entity) re-indexes at its new Transform. The authority
  // re-indexes its own moves directly (movePiece); a replica sees the position change and drops the stale slot so the
  // query below indexes it again.
  if (!isAuthority(world) && idx.count) for (const e of world.changed(Transform)) {
    if (!world.has(e, BuildPiece) || !world.has(e, PieceSlot)) continue;
    const inf = idx.info.get(e); if (!inf) continue;
    const s = deriveSlot(world, e, inf.def); const o = inf.slot;
    if (s.tx !== o.tx || s.ty !== o.ty || s.z !== o.z || s.side !== o.side || s.rot !== o.rot || (s.fx !== undefined && (s.fx !== o.fx || s.fy !== o.fy))) idx.removePiece(e);
  }
  for (const e of world.query([BuildPiece, Transform], [PieceSlot])) {
    const def = idx.def(e); if (!def) continue;
    const slot = deriveSlot(world, e, def);
    const parent: Entity | 0 = def.placement === Placement.Opening ? openingParent(idx, def, slot) : 0;
    if (def.placement === Placement.Opening && !parent) continue; // parent not streamed yet: retry next tick
    idx.addPiece(e, slot, parent);
    if (world.has(e, PieceStability)) idx.dirty.add(e); else loadedQueue(world).pieces.push(e); // ADR-212: loaded (authority) / replicated piece
  }
  for (const a of world.query([PieceLink])) {
    if (world.getResource(LinkedRes)?.has(a)) continue;
    const l = world.get(a, PieceLink)!;
    const p = idx.atSlot(l.tx, l.ty, l.z, l.side as EdgeSide, l.layer);
    if (p) { linkAttachment(world, p, a); let m = world.getResource(LinkedRes); if (!m) world.setResource(LinkedRes, (m = new Set())); m.add(a); loadedQueue(world).atts.push(a); }
  }
}
/** ADR-212: pieces / attachments indexed from storage or replication this tick (rehydrate.ts restores their derived, non-persistent components on the authority). */
export const LoadedQueueRes = defineResource<{ pieces: Entity[]; atts: Entity[] }>("gameplay.LoadedStructureQueue");
export function loadedQueue(world: World): { pieces: Entity[]; atts: Entity[] } { let q = world.getResource(LoadedQueueRes); if (!q) world.setResource(LoadedQueueRes, (q = { pieces: [], atts: [] })); return q; }
const LinkedRes = defineResource<Set<Entity>>("gameplay.LinkedAttachments");
export function markLinked(world: World, a: Entity): void { let m = world.getResource(LinkedRes); if (!m) world.setResource(LinkedRes, (m = new Set())); m.add(a); }
export function unmarkLinked(world: World, a: Entity): void { world.getResource(LinkedRes)?.delete(a); }

export type { AttachKind };
