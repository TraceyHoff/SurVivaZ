/**
 * Placement: snapping (grid cells, socket/edge snapping for walls and openings, free placement for furniture/decor),
 * validation in a fixed order (first failure wins, BuildFail), and the authoritative place. The same snap + validate
 * runs on the client for the ghost preview (client mode skips server-only stability values and uses "has support").
 *
 * Validation order: UnknownPiece, BadTier, LevelLimit, SkillLocked, OutOfRange, NoPrivilege, ZoneFull, Terrain, Occupied,
 * NoSocket, Blocked, NoSupport, NeedClaim, CannotAfford. ADR-315: ClaimOverlap (a flag's disk over another claim) follows NoPrivilege. ADR-211: CornerSlot (straight wall in an outer corner slot) follows Occupied.
 */
import { entityIndex, Membership, Transform, type Entity, type World } from "@engine/core";
/** ADR-230: number of clan palettes Art ships (assets clanPalettes 1..16); clan ids wrap onto them. */
export const CLAN_PALETTE_COUNT = 16;
/** BuildPiece.tint for a clan: 1..CLAN_PALETTE_COUNT index into assets clanPalettes (ADR-077; wrapped since ADR-230). */
import { spawnCrop } from "../farming.js";
export const clanTintIndex = (clanId: number): number => clanId > 0 ? 1 + ((clanId - 1) % CLAN_PALETTE_COUNT) : 0;
import { isWaterId, installSpatialIndex, SUBTILE, WaterDepth, waterDepthAt } from "@engine/world";
import {
  AttachKind, BuildPiece, Container, ContainerViewers, CraftingStation, DoorState, EdgeSide, Emitter, Fuel, Health,
  PieceLink, PieceStability, PrivilegeZone, Tribe, Worker, Zombie,
} from "../components.js";
import { gameplayDefs, isAuthority, rangeSlack } from "../config.js";
import { Placement, SocketKind, StationKind, type GameDefs, type ItemCount, type PieceDef } from "../defs.js";
import { BuildFail, emit, PiecePlaced } from "../events.js";
import { countItem, exchangeItems } from "../inventory.js";
import { emitterSpecs } from "../realism.js";
import { makeNoise } from "../systems/noise.js";
import { recordRecentBuild } from "../recent.js";
import { TerrainRes } from "../world.js";
import { MIN_SHAFT_DROP, shaftDrop, shaftSidesLevel } from "./terrain-hatch.js";
import { linkAttachment } from "./links.js";
import { reseatSmallOn, smallPieceZ, surfaceHeightAt } from "./surface.js";
import { TRI_INRADIUS, triEdges } from "./modular.js";
import { anchorFor, edgeKey, isLCorner, lCornerArms, lCornerTile, StructureIndex as SIdx, FINE_POS_STEP, FINE_ROT, FINE_ROT_STEPS, gridRot, LAYER_DECK, LAYER_OPENING, markLinked, slotTransform, structures, type Slot } from "./structure.js";
type StructureIndex = SIdx;
import { Falloff } from "@engine/world";
import { claimOverlap, zonesNear } from "./zones.js";
import { indexEntity } from "../spawn.js";
import { tillSlots } from "../economy/config.js";
import { initDefense } from "../combat/defenses.js";
import { assignStallOwner, canPlaceStall } from "../economy/stall.js";
import { Listings, PieceOwner, StallHeader, StallLedger, StallSign } from "../components.js";
import { PlayerId } from "@engine/core";
import { hasSkillUnlock, pieceToken, tierToken } from "../skills/tree.js";

export interface PlaceRequest { piece: number; x: number; y: number; level: number; rot: number; tier: number; variant: number }
export interface Snapped { def: PieceDef; slot: Slot; parent: Entity | 0; pos: { x: number; y: number; z: number; facing: number }; tier: number; variant: number }

export function maxHp(defs: GameDefs, def: PieceDef, tier: number): number {
  return def.tiered ? Math.min(0xffff, Math.round(def.hp * (defs.tiers[tier]?.hpMul ?? 1))) : Math.min(0xffff, def.hp);
}
/** Build cost: tier cost x costScale (tiered) or the piece's own cost. */
export function pieceCost(defs: GameDefs, def: PieceDef, tier: number, scale = 1): ItemCount[] {
  const base = def.tiered ? (defs.tiers[tier]?.cost ?? []).map((c) => ({ item: c.item, count: c.count * def.costScale })) : def.cost.map((c) => ({ item: c.resource, count: c.amount }));
  // modular extras (ADR-104): merged by item, appended after the tier cost (order stable for exchangeItems)
  for (const x of def.extraCost) if (tier >= x.fromTier) { const h = base.find((c) => c.item === x.item); if (h) h.count += x.count; else base.push({ item: x.item, count: x.count }); }
  return base.map((c) => ({ item: c.item, count: Math.ceil(c.count * scale - 1e-9) })).filter((c) => c.count > 0);
}

/** Task 30: the nearest edge within FRAME_SNAP_RADIUS tiles whose piece is a frame for `def.fits`
 * (a door frame wall for a door, a window frame for shutters/glass). An opening piece only ever snaps
 * into a matching frame: aiming at a plain wall or open ground near a doorway lands the ghost on the
 * doorway instead of failing NoSocket. With no frame in reach the plain nearest-edge snap stands and
 * validation rejects the placement (NoSocket), so a door can never land anywhere but a frame. */
export const FRAME_SNAP_RADIUS = 1;
export function nearestFrameEdge(idx: StructureIndex, def: PieceDef, x: number, y: number, z: number): { tx: number; ty: number; side: EdgeSide } | undefined {
  let best: { tx: number; ty: number; side: EdgeSide } | undefined; let bd = Infinity;
  const cx = Math.floor(x), cy = Math.floor(y);
  for (let ty = cy - 1; ty <= cy + 1; ty++) for (let tx = cx - 1; tx <= cx + 1; tx++) {
    for (const side of [EdgeSide.North, EdgeSide.West]) {
      const e = idx.edge(tx, ty, z, side); if (!e) continue;
      if (idx.def(e)?.opening !== def.fits) continue;
      const mx = side === EdgeSide.North ? tx + 0.5 : tx, my = side === EdgeSide.North ? ty : ty + 0.5;
      const d = Math.hypot(mx - x, my - y);
      if (d > FRAME_SNAP_RADIUS || d > bd) continue;
      if (d < bd || !best || tx < best.tx || (tx === best.tx && (ty < best.ty || (ty === best.ty && side < best.side)))) { bd = d; best = { tx, ty, side }; }
    }
  }
  return best;
}

/** Nearest edge to (x,y): socket snapping (deck EDGE sockets) first, else geometric nearest edge of the tile. */
export function snapEdge(idx: StructureIndex, x: number, y: number, z: number): { tx: number; ty: number; side: EdgeSide } {
  const s = idx.grid.snap(x * SUBTILE, y * SUBTILE, z, { kind: SocketKind.Edge, maxDist: SUBTILE });
  if (s) {
    if (s.sy % SUBTILE === 0) return { tx: Math.floor(s.sx / SUBTILE), ty: s.sy / SUBTILE, side: EdgeSide.North };
    return { tx: s.sx / SUBTILE, ty: Math.floor(s.sy / SUBTILE), side: EdgeSide.West };
  }
  const tx = Math.floor(x), ty = Math.floor(y), fx = x - tx, fy = y - ty;
  const c: [number, number, number, EdgeSide][] = [[fy, tx, ty, EdgeSide.North], [1 - fy, tx, ty + 1, EdgeSide.North], [fx, tx, ty, EdgeSide.West], [1 - fx, tx + 1, ty, EdgeSide.West]];
  c.sort((a, b) => a[0] - b[0] || a[3] - b[3]);
  const [, ex, ey, side] = c[0]!; return { tx: ex, ty: ey, side };
}

/** ADR-174: may this piece be placed off-grid (snap off)? Free decor / furniture only: not vertex-snapped posts, claims
 *  or stalls; structural pieces (cell decks, edge walls, openings, triangles) are never free. */
export const fineEligible = (def: PieceDef): boolean => def.placement === Placement.Free && def.snap !== "vertex" && def.privilegeRadius === 0 && !def.stall;
export function snapPlacement(world: World, req: PlaceRequest): Snapped | BuildFail {
  const defs = gameplayDefs(world); const def = defs.pieces.get(req.piece);
  if (!def) return BuildFail.UnknownPiece;
  const tier = def.tiered ? req.tier : def.fixedTier;
  if (def.tiered && !(tier >= def.minTier && tier < defs.tiers.length)) return BuildFail.BadTier;
  const variant = req.variant < def.variants ? req.variant : 0;
  const idx = structures(world); const z = req.level; const lh = defs.building.levelHeight;
  let slot: Slot; let parent: Entity | 0 = 0; let px: number | undefined, py: number | undefined;
  switch (def.placement) {
    case Placement.Cell: { const r = req.rot & 3; const [tx, ty] = anchorFor(def, req.x, req.y, r); slot = { tx, ty, z, side: EdgeSide.None, rot: r }; break; }
    case Placement.Tri: { slot = snapTri(idx, req.x, req.y, z, req.rot); break; }
    case Placement.Free: {
      const fine = (req.rot & FINE_ROT) !== 0 && fineEligible(def); // ADR-174: snap off → 1/16 tile, 15° steps
      const step = def.snap === "vertex" ? 1 : fine ? FINE_POS_STEP : defs.building.freeSnapSubtiles / SUBTILE; px = Math.round(req.x / step) * step; py = Math.round(req.y / step) * step;
      const rot = fine ? FINE_ROT | ((req.rot & 0x7f) % FINE_ROT_STEPS) : (req.rot & 0x7f) % (def.rotSteps || defs.building.freeRotSteps); const [tx, ty] = anchorFor(def, px, py, gridRot(def, rot));
      slot = { tx, ty, z, side: EdgeSide.None, rot }; break;
    }
    case Placement.Edge: { const e = snapEdge(idx, req.x, req.y, z); slot = { ...e, z, rot: (e.side === EdgeSide.West ? 1 : 0) | (req.rot & 2) }; if (def.features.mount) parent = idx.edge(e.tx, e.ty, z, e.side); break; }
    case Placement.Opening: {
      if (def.fits === SocketKind.Hatch) {
        const tx = Math.floor(req.x), ty = Math.floor(req.y); slot = { tx, ty, z, side: EdgeSide.None, rot: 0 };
        parent = idx.deck(tx, ty, z);
      } else {
        // Task 30: a door / window only snaps into a matching frame wall within a tile of the aim
        const frame = nearestFrameEdge(idx, def, req.x, req.y, z);
        const e = frame ?? snapEdge(idx, req.x, req.y, z); slot = { ...e, z, rot: (e.side === EdgeSide.West ? 1 : 0) | (req.rot & 2) };
        parent = idx.edge(e.tx, e.ty, z, e.side);
      }
      break;
    }
  }
  const pos = slotTransform(def, slot, lh, px, py);
  if (def.small && def.placement === Placement.Free) pos.z = smallPieceZ(world, pos.x, pos.y, z); // ADR-162 ghost + server snap to the surface top
  if (def.placement === Placement.Opening && parent && def.fits !== SocketKind.Hatch) { const t = world.get(parent, Transform); if (t) { pos.x = t.x; pos.y = t.y; } }
  if (def.placement === Placement.Opening && def.fits === SocketKind.Hatch) { pos.x = slot.tx + 0.5; pos.y = slot.ty + 0.5; }
  return { def, slot, parent, pos, tier, variant };
}

/**
 * Triangle snap (ADR-104): candidates are the free outward faces of square decks and triangles at level z within
 * the 3x3 tiles around the aim; nearest candidate centroid wins (ties: x, then y, then rot). No candidate: the
 * triangle stands alone at the aim (quarter-tile grid) with rot = req.rot % 12 (valid only as a ground root).
 */
export function triCandidates(idx: StructureIndex, x: number, y: number, z: number): Slot[] {
  const out: Slot[] = []; const tx0 = Math.floor(x), ty0 = Math.floor(y);
  const free = (cx: number, cy: number): boolean => !idx.triAt(cx, cy, z) && !idx.deck(Math.floor(cx), Math.floor(cy), z);
  const add = (cx: number, cy: number, rot: number): void => { if (free(cx, cy)) out.push({ tx: Math.floor(cx), ty: Math.floor(cy), z, side: EdgeSide.None, rot: ((rot % 12) + 12) % 12, fx: cx, fy: cy }); };
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const tx = tx0 + dx, ty = ty0 + dy;
    if (idx.isDeck(idx.deck(tx, ty, z))) for (const [mx, my, nx, ny, step] of [[tx + 0.5, ty, 0, -1, 3], [tx + 0.5, ty + 1, 0, 1, 9], [tx, ty + 0.5, -1, 0, 0], [tx + 1, ty + 0.5, 1, 0, 6]] as const)
      add(mx + nx * TRI_INRADIUS, my + ny * TRI_INRADIUS, step); // edge 0 faces back toward the deck
    for (const t of idx.trisInTile(tx, ty, z)) {
      const s = idx.slotOf(t); if (!s || s.fx === undefined) continue;
      for (const e of triEdges(s.fx, s.fy!, s.rot)) add(e.mx + e.nx * TRI_INRADIUS, e.my + e.ny * TRI_INRADIUS, e.dirStep + 6);
    }
  }
  return out;
}
export function snapTri(idx: StructureIndex, x: number, y: number, z: number, rot: number): Slot {
  const c = triCandidates(idx, x, y, z);
  const d = (s: Slot): number => Math.hypot(s.fx! - x, s.fy! - y);
  c.sort((a, b) => d(a) - d(b) || a.fx! - b.fx! || a.fy! - b.fy! || a.rot - b.rot);
  if (c[0] && d(c[0]) <= 1) return c[0];
  const fx = Math.round(x * 4) / 4, fy = Math.round(y * 4) / 4;
  return { tx: Math.floor(fx), ty: Math.floor(fy), z, side: EdgeSide.None, rot: ((rot % 12) + 12) % 12, fx, fy };
}
/**
 * ADR-211 L corners. An outer corner of a deck tile is a tile corner whose two edges both face out (no deck across).
 * outerCornerRots: the L rotations at vertex (vx,vy) that wrap a deck tile's outer corner (auto-rotate targets).
 * isCornerSlot: is this edge an arm of some deck tile's outer corner (where only an L corner may stand)?
 */
export function outerCornerRots(idx: StructureIndex, vx: number, vy: number, z: number): number[] {
  const out: number[] = [];
  for (let r = 0; r < 4; r++) {
    const [cx, cy] = lCornerTile(vx, vy, r); if (!idx.isDeck(idx.deck(cx, cy, z))) continue;
    if (lCornerArms(vx, vy, r).every((a) => { const [t0, t1] = SIdx.edgeTiles(a.tx, a.ty, a.side); const o = t0[0] === cx && t0[1] === cy ? t1 : t0; return !idx.isDeck(idx.deck(o[0], o[1], z)); })) out.push(r);
  }
  return out;
}
export function isCornerSlot(idx: StructureIndex, tx: number, ty: number, z: number, side: EdgeSide): boolean {
  const k = edgeKey(tx, ty, z, side);
  const verts: [number, number][] = side === EdgeSide.North ? [[tx, ty], [tx + 1, ty]] : [[tx, ty], [tx, ty + 1]];
  return verts.some(([vx, vy]) => outerCornerRots(idx, vx, vy, z).some((r) => lCornerArms(vx, vy, r).some((a) => edgeKey(a.tx, a.ty, z, a.side) === k)));
}
/**
 * Task 30: a corner slot is only reserved for the L corner while an L could still be placed there — both
 * arms free. Once one arm is taken (a wall, an L, a doorway), the L can never fit, so the remaining arm
 * takes a straight wall. Without this, a 1-row foundation's end tiles could never be fully walled: the
 * two end corners share the end edge, so only one L fits and the other long edge stays bare forever
 * (straight wall: CornerSlot; second L: Occupied).
 */
export function cornerSlotReserved(idx: StructureIndex, tx: number, ty: number, z: number, side: EdgeSide): boolean {
  if (!isCornerSlot(idx, tx, ty, z, side)) return false;
  const verts: [number, number][] = side === EdgeSide.North ? [[tx, ty], [tx + 1, ty]] : [[tx, ty], [tx, ty + 1]];
  for (const [vx, vy] of verts) for (const r of outerCornerRots(idx, vx, vy, z)) {
    const arms = lCornerArms(vx, vy, r);
    const mine = arms.find((a) => a.tx === tx && a.ty === ty && a.side === side);
    if (!mine) continue;
    const other = arms.find((a) => a !== mine)!;
    if (!idx.edge(other.tx, other.ty, z, other.side)) return true; // the L still fits here
  }
  return false;
}
/** ADR-211: "regular straight walls" = wall-family edge pieces without an opening socket (door/window frames may still sit in a corner slot). */
export const isStraightWall = (def: PieceDef | undefined): boolean => !!def && def.placement === Placement.Edge && !def.features.mount && def.family === "wall" && !def.opening;
/** Tiles around a vertex-snapped corner piece (any one with a deck supports it). */
export const vertexTiles = (tx: number, ty: number): [number, number][] => [[tx, ty], [tx - 1, ty], [tx, ty - 1], [tx - 1, ty - 1]];

export const tribeOf = (world: World, e: Entity): number => world.getField(e, Tribe, "id") ?? 0;
/** Privilege zones (claim pieces) whose disk comes within `extra` of (x,y) — covering it when extra = 0. ADR-315: a
 *  zone grid lookup (building/zones.ts), not a scan of every zone or the entity hash out to the max radius. */
export function zonesAt(world: World, x: number, y: number, extra = 0): Entity[] { return zonesNear(world, x, y, extra); }
/** A privilege zone belongs to `builder`: matching tribe, or the builder owns the claim piece. */
export function zoneOwnedBy(world: World, zone: Entity, builder: Entity): boolean {
  if (!builder) return false;
  const tribe = tribeOf(world, builder);
  const zt = world.getField(zone, PrivilegeZone, "tribe") ?? 0;
  if (tribe && zt === tribe) return true;
  const pid = world.isRegistered(PlayerId) ? world.getField(builder, PlayerId, "id") ?? 0 : 0;
  const ownerPid = world.isRegistered(PieceOwner) ? world.getField(zone, PieceOwner, "player") ?? 0 : 0;
  if (pid && world.isRegistered(PieceOwner) && ownerPid === pid) return true;
  const hireOwner = world.isRegistered(Worker) ? world.getField(builder, Worker, "owner") ?? 0 : 0;
  return !!hireOwner && world.isRegistered(PieceOwner) && ownerPid === hireOwner;
}
/** Builder may modify at (x,y): no foreign zone covers it (wilderness with no zone is allowed). */
export function hasPrivilege(world: World, builder: Entity, x: number, y: number): boolean {
  return zonesAt(world, x, y).every((z) => zoneOwnedBy(world, z, builder));
}
/** True when one of the builder's own Claim Flags covers (x,y). */
export function hasOwnClaim(world: World, builder: Entity, x: number, y: number): boolean {
  return !!builder && zonesAt(world, x, y).some((z) => zoneOwnedBy(world, z, builder));
}
/** Personal tribes live in 0x8000..0xFFFF so they stay clear of typical clan ids. */
const PERSONAL_TRIBE_BIT = 0x8000;
/** Give a solo builder a stable personal tribe so they can plant a Claim Flag (ADR-310). */
export function ensurePersonalTribe(world: World, e: Entity): number {
  if (!e) return 0;
  const existing = tribeOf(world, e);
  if (existing) return existing;
  const pid = world.isRegistered(PlayerId) ? world.getField(e, PlayerId, "id") ?? 0 : 0;
  const seed = pid || (entityIndex(e) + 1);
  const tribe = PERSONAL_TRIBE_BIT | (seed & 0x7fff);
  if (world.has(e, Tribe)) world.setField(e, Tribe, "id", tribe);
  else world.add(e, Tribe, { id: tribe });
  return tribe;
}
/** Base-building pieces (not the Claim Flag itself, and not market stalls with their own land rules). */
export const needsClaim = (def: PieceDef): boolean => def.privilegeRadius <= 0 && !def.stall;

/** A wall piece for ceiling support: wall-family or corner wall, not a wall-mounted decor piece. */
const isWallDef = (def: PieceDef | undefined): boolean =>
  !!def && (def.family === "wall" || def.family === "corner") && !def.features.mount;

/**
 * Whether an upper-level deck piece (a ceiling / roof / upper floor) is connected to a wall: a wall directly
 * below any tile of its own footprint, or below any tile of the already-placed deck cluster it joins at the
 * same level (so a large roof over a room still works — every tile need not sit on a wall, but the cluster
 * as a whole must be wall-anchored). Pillar-only or floating decks do not count.
 */
export function deckWallConnected(world: World, idx: StructureIndex, slot: Slot, tiles: readonly (readonly [number, number])[]): boolean {
  const key = (x: number, y: number): string => `${x},${y}`;
  const wallBelow = (x: number, y: number): boolean =>
    SIdx.tileEdges(x, y).some(([ex, ey, side]) => {
      const w = idx.edge(ex, ey, slot.z - 1, side); return !!w && isWallDef(idx.def(w));
    });
  const seen = new Set<string>(); const queue: [number, number][] = [];
  for (const [x, y] of tiles) if (!seen.has(key(x, y))) { seen.add(key(x, y)); queue.push([x, y]); }
  while (queue.length) {
    const [x, y] = queue.pop()!;
    if (wallBelow(x, y)) return true;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
      if (seen.has(key(nx, ny))) continue;
      if (!idx.deck(nx, ny, slot.z)) continue;
      seen.add(key(nx, ny)); queue.push([nx, ny]);
    }
  }
  return false;
}

/** Candidate stability of a hypothetical placement (server: real values; client: 100 if any support exists). */
export function candidateStability(world: World, sn: Snapped): number {
  const defs = gameplayDefs(world); const idx = structures(world);
  const { root, list } = idx.supportsAt(sn.def, sn.slot, sn.parent);
  if (root) return defs.building.groundStability;
  const tier = defs.tiers[sn.tier] ?? defs.tiers[1]!;
  let best = 0;
  for (const [s, kind] of list) {
    const v = isAuthority(world) ? world.getField(s, PieceStability, "value") ?? 0 : defs.building.groundStability;
    best = Math.max(best, v - (kind === 1 ? tier.vertLoss : kind === 2 ? tier.horizLoss : 0));
  }
  return best;
}

/** ADR-221: gate tokens a piece at `tier` needs (station piece unlock; tier unlock for tiered pieces). Twig and ordinary pieces need none. */
export function pieceGates(defs: GameDefs, def: PieceDef, tier: number): string[] {
  if (def.starter) return []; // ADR-250: starter pieces (basic_storage_box) are craftable from the start
  const out = [pieceToken((def as { key?: string }).key ?? "")]; const tk = defs.tiers[tier]?.key; if (def.tiered && tk) out.push(tierToken(tk)); return out;
}
export const pieceUnlocked = (world: World, e: Entity, def: PieceDef, tier: number): boolean => pieceGates(gameplayDefs(world), def, tier).every((t) => hasSkillUnlock(world, e, t));
/** Repair an inventory item or kit: ungated `item:<key>` tokens pass (ADR-310; no dedicated item-repair command yet). */
export const itemRepairUnlocked = (world: World, e: Entity, itemId: number): boolean => {
  const key = gameplayDefs(world).items.get(itemId)?.key;
  return !key || hasSkillUnlock(world, e, `item:${key}`);
};
export function validatePlacement(world: World, builder: Entity, sn: Snapped, opts: { ignoreCost?: boolean; ignoreRange?: boolean; ignoreClaim?: boolean } = {}): BuildFail | 0 {
  const defs = gameplayDefs(world); const b = defs.building; const idx = structures(world); const { def, slot } = sn;
  if (slot.z > b.maxLevel || slot.z < def.minLevel || (def.groundOnly && slot.z !== 0)) return BuildFail.LevelLimit;
  if (!pieceUnlocked(world, builder, def, sn.tier)) return BuildFail.SkillLocked;
  const bt = world.get(builder, Transform);
  if (!opts.ignoreRange && bt && Math.hypot(bt.x - sn.pos.x, bt.y - sn.pos.y) > b.buildReach + rangeSlack(world, builder)) return BuildFail.OutOfRange;
  // privilege: foreign zones block; planting a Claim Flag is allowed in wilderness (a personal tribe is assigned on place)
  // ADR-315: a flag may stand in no foreign claim; its whole disk may overlap no claim at all (own, clan or foreign)
  // — rims may touch, so clanmates bump claims edge to edge — instead of the old "no foreign zone within r + R".
  const zones = zonesAt(world, sn.pos.x, sn.pos.y);
  if (zones.some((z) => !zoneOwnedBy(world, z, builder))) return BuildFail.NoPrivilege;
  if (def.privilegeRadius > 0 && !builder) return BuildFail.NoPrivilege;
  if (def.privilegeRadius > 0 && claimOverlap(world, sn.pos.x, sn.pos.y, def.privilegeRadius) !== undefined) return BuildFail.ClaimOverlap;
  // stalls: clanOnly needs a clan; core land claims (economy.claims) via the stall place permission rule
  if (def.stall && !canPlaceStall(world, builder, sn.pos.x, sn.pos.y, def.stall.clanOnly)) return BuildFail.NoPrivilege;
  const own = zonesAt(world, sn.pos.x, sn.pos.y)[0];
  if (own !== undefined && (idx.zoneCounts.get(own) ?? 0) >= b.maxPiecesPerZone) return BuildFail.ZoneFull;
  // terrain for ground-level pieces
  const tiles = def.placement === Placement.Cell || def.placement === Placement.Free ? idx.grid.footprintTiles(def.id, slot.tx, slot.ty, gridRot(def, slot.rot)) : def.placement === Placement.Tri ? [[slot.tx, slot.ty] as [number, number]] : [];
  const terrain = world.getResource(TerrainRes);
  const onGround = slot.z === 0 && def.snap !== "vertex" && (def.groundOnly || (def.ground && !tiles.some(([x, y]) => idx.isDeck(idx.deck(x, y, 0)))));
  if (terrain && onGround) {
    let lo = Infinity, hi = -Infinity;
    for (const [x, y] of tiles) {
      if (defs.worldgen.unbuildableTiles.has(terrain.tileAt(x, y)) && waterDepthAt(terrain.tileAt, x, y, defs.movement.shallowRadius) !== WaterDepth.Shallow) return BuildFail.Terrain; // ADR-181: shallow is buildable, deep is not
      const h = terrain.heightAt(x, y); lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    if (hi - lo > (def.maxSlope >= 0 ? def.maxSlope : b.maxSlope)) return BuildFail.Terrain;
  }
  // ADR-265: terrain face, not a wall socket. Check BOTH landing tiles and their claims.
  if (def.features.terrainLadder) {
    if (!terrain || slot.z !== 0) return BuildFail.Terrain;
    const pair = SIdx.edgeTiles(slot.tx, slot.ty, slot.side);
    for (const [x, y] of pair) {
      if (!terrain.tileAt(x, y) || terrain.loaded?.(x, y) === false || isWaterId(terrain.tileAt(x, y))) return BuildFail.Terrain;
      if (!hasPrivilege(world, builder, x + 0.5, y + 0.5)) return BuildFail.NoPrivilege;
      for (let layer = 1; layer <= 3; layer++) { const c = idx.cell(x, y, 0, layer); if (c && idx.def(c)?.solid) return BuildFail.Blocked; }
    }
    if (terrain.heightAt(...pair[0]) === terrain.heightAt(...pair[1])) return BuildFail.NoTerrainFace;
    if (idx.ladder(slot.tx, slot.ty, slot.side)) return BuildFail.Occupied;
    if (idx.edgeBlocker(slot.tx, slot.ty, 0, slot.side)) return BuildFail.Blocked;
  }
  // ADR-299: a shaft hatch covers a dug column and sits at the surrounding rim.
  if (def.features.shaftHatch) {
    if (!terrain || slot.z !== 0) return BuildFail.Terrain;
    for (const [x, y] of tiles) {
      if (!terrain.tileAt(x, y) || terrain.loaded?.(x, y) === false || isWaterId(terrain.tileAt(x, y))) return BuildFail.Terrain;
      if (!hasPrivilege(world, builder, x + 0.5, y + 0.5)) return BuildFail.NoPrivilege;
      if (!shaftSidesLevel(terrain, x, y) || shaftDrop(terrain, x, y) < MIN_SHAFT_DROP) return BuildFail.NoShaft;
      if (idx.hatch(x, y)) return BuildFail.Occupied;
    }
  }
  // occupancy
  if (def.features.terrainLadder) { /* its independent face slot was checked above */ }
  else if (def.placement === Placement.Edge && def.features.mount) { // ADR-112: hung on a wall face
    const w = sn.parent ? idx.def(sn.parent) : undefined; if (!w || w.placement !== Placement.Edge || w.features.mount || !w.blocksPath) return BuildFail.NoSocket;
    if (idx.mount(slot.tx, slot.ty, slot.z, slot.side, slot.rot)) return BuildFail.Occupied;
  } else if (def.placement === Placement.Edge) {
    if (idx.edge(slot.tx, slot.ty, slot.z, slot.side)) return BuildFail.Occupied;
    if (isStraightWall(def) && cornerSlotReserved(idx, slot.tx, slot.ty, slot.z, slot.side)) return BuildFail.CornerSlot; // ADR-211 + Task 30: only while an L could still fit there
  }
  else if (def.placement === Placement.Tri) {
    if (idx.triAt(slot.fx!, slot.fy!, slot.z) || idx.deck(slot.tx, slot.ty, slot.z)) return BuildFail.Occupied;
  } else if (def.placement === Placement.Opening) {
    if (!sn.parent || idx.def(sn.parent)?.opening !== def.fits) return BuildFail.NoSocket;
    if (idx.opening(sn.parent)) return BuildFail.Occupied;
  } else if (!idx.grid.canPlace(def.id, slot.tx, slot.ty, slot.z, gridRot(def, slot.rot)).ok) return BuildFail.Occupied;
  else if (isLCorner(def) && lCornerArms(slot.tx, slot.ty, slot.rot).some((a) => idx.edge(a.tx, a.ty, slot.z, a.side))) return BuildFail.Occupied; // ADR-211: both arm edges must be free
  else if (def.layer === LAYER_DECK && def.placement === Placement.Cell && idx.tris.size && tiles.some(([x, y]) => idx.trisInTile(x, y, slot.z).length > 0)) return BuildFail.Occupied;
  // furniture/decor on decks need a deck under every tile
  if (isLCorner(def)) { const [cx, cy] = lCornerTile(slot.tx, slot.ty, slot.rot); if (!idx.isDeck(idx.deck(cx, cy, slot.z))) return BuildFail.NoSupport; } // ADR-211: wraps a deck corner
  else if (def.snap === "vertex") { if (!vertexTiles(slot.tx, slot.ty).some(([x, y]) => idx.isDeck(idx.deck(x, y, slot.z)))) return BuildFail.NoSupport; }
  else if (def.placement === Placement.Free && !onGround && !onSurface(world, def, tiles, slot.z) && !tiles.every(([x, y]) => idx.isDeck(idx.deck(x, y, slot.z)))) return BuildFail.NoSupport;
  if (def.placement === Placement.Cell && def.needsDeck && !tiles.every(([x, y]) => idx.isDeck(idx.deck(x, y, slot.z)))) return BuildFail.NoSupport;
  // Ceilings and other upper-level deck pieces (roofs, upper floors) must be connected to a wall: a wall below
  // their own footprint, or below a deck tile they join at the same level. Pillar-only and floating decks fail.
  if (def.layer === LAYER_DECK && slot.z > 0 && !deckWallConnected(world, idx, slot, tiles)) return BuildFail.NoSupport;
  // creatures in the way of solid pieces
  if (def.solid && slot.z === 0) {
    const [hw, hh] = def.placement === Placement.Edge ? (slot.side === EdgeSide.North ? [0.5, 0.15] : [0.15, 0.5]) : def.snap === "vertex" ? [0.15, 0.15] : [def.footprint.w / 2, def.footprint.h / 2]; // ADR-210: a corner post is a thin pillar at the vertex
    const rects: [number, number, number, number][] = isLCorner(def) ? lCornerArms(slot.tx, slot.ty, slot.rot).map((a) => [a.x, a.y, a.side === EdgeSide.North ? 0.5 : 0.15, a.side === EdgeSide.North ? 0.15 : 0.5]) : [[sn.pos.x, sn.pos.y, hw, hh]]; // ADR-211: the L blocks like its two arm walls
    for (const [rx, ry, rw, rh] of rects) for (const c of installSpatialIndex(world).queryRect(rx - rw - 0.3, ry - rh - 0.3, rx + rw + 0.3, ry + rh + 0.3)) {
      if (world.has(c, Health) && !world.has(c, BuildPiece) && (world.has(c, Zombie) || c !== builder || def.placement !== Placement.Free || isLCorner(def))) return BuildFail.Blocked;
    }
  }
  if (candidateStability(world, sn) < b.minStability) return BuildFail.NoSupport;
  // ADR-310: after structural checks, base pieces need one of the builder's Claim Flags covering the spot
  if (builder && needsClaim(def) && !opts.ignoreClaim && !hasOwnClaim(world, builder, sn.pos.x, sn.pos.y)) return BuildFail.NeedClaim;
  if (!opts.ignoreCost) for (const c of pieceCost(defs, def, sn.tier)) if (countItem(world, builder, c.item) < c.count) return BuildFail.CannotAfford;
  return 0;
}

/**
 * Authoritative place (after validatePlacement). Pays the cost, creates the piece entity (static replication class)
 * and its non-static attachment entities (door state, fire/fuel/emitters, storage), indexes everything.
 */
/** ADR-162: a small piece whose every tile has a surface piece (table, shelf...) under it at this level. */
function onSurface(world: World, def: PieceDef, tiles: readonly (readonly [number, number])[], z: number): boolean {
  return def.small && tiles.length > 0 && tiles.every(([x, y]) => surfaceHeightAt(world, x + 0.5, y + 0.5, z) > 0);
}
export function placePiece(world: World, builder: Entity | 0, sn: Snapped, opts: { pay?: boolean; hp?: number; paint?: number; tribe?: number } = {}): Entity {
  const defs = gameplayDefs(world); const idx = structures(world); const { def, slot } = sn;
  if (builder && def.privilegeRadius > 0) ensurePersonalTribe(world, builder);
  if (builder && opts.pay !== false) exchangeItems(world, builder, pieceCost(defs, def, sn.tier), []);
  if (def.small && def.placement === Placement.Free) sn = { ...sn, pos: { ...sn.pos, z: smallPieceZ(world, sn.pos.x, sn.pos.y, slot.z) } }; // ADR-162 (also persistence load)
  const e = world.create();
  const tribe = opts.tribe ?? (builder ? tribeOf(world, builder) : 0);
  world.add(e, Transform, sn.pos)
    .add(e, BuildPiece, { type: def.id, rot: slot.rot, variant: sn.variant, tier: sn.tier, hp: opts.hp ?? maxHp(defs, def, sn.tier), damageStage: 0, paint: opts.paint ?? 0 });
  if (tribe) world.add(e, Tribe, { id: tribe });
  const builderId = builder && world.isRegistered(PlayerId) ? world.getField(builder, PlayerId, "id") ?? 0 : 0;
  if (builderId && isAuthority(world)) world.add(e, PieceOwner, { player: builderId }); // ADR-119 settlements / ADR-121 solo hordes
  // clan tint: u8 index into the assets manifest clanPalettes (0 = no clan; clanTintIndex wraps ids onto the 16 palettes, ADR-230)
  const clan = builder && world.isRegistered(Membership) ? world.getField(builder, Membership, "clanId") ?? 0 : 0;
  if (clan) world.setField(e, BuildPiece, "tint", clanTintIndex(clan));
  if (def.privilegeRadius > 0) world.add(e, PrivilegeZone, { radius: def.privilegeRadius, tribe });
  if (def.station !== StationKind.None && !def.fired) world.add(e, CraftingStation, { kind: def.station });
  if (isAuthority(world)) world.add(e, PieceStability, { value: 0, placedTick: world.tick });
  idx.addPiece(e, slot, sn.parent);
  indexEntity(world, e);
  if (def.surfaceHeight > 0 && isAuthority(world)) reseatSmallOn(world, e); // decor already on these tiles moves up onto the top
  const own = zonesAt(world, sn.pos.x, sn.pos.y)[0];
  if (own !== undefined) { idx.zoneOf.set(e, own); idx.zoneCounts.set(own, (idx.zoneCounts.get(own) ?? 0) + 1); }
  if (def.privilegeRadius > 0) idx.zoneCounts.set(e, idx.zoneCounts.get(e) ?? 0);
  if (isAuthority(world)) {
    world.setField(e, PieceStability, "value", Math.max(0, Math.min(255, candidateStability(world, sn))));
    idx.dirty.add(e);
    spawnAttachments(world, e, def, sn);
    if (def.stall && builder) assignStallOwner(world, e, builder);
    initDefense(world, e, def, builder);
    if (def.features.planter) spawnCrop(world, sn.pos.x, sn.pos.y, 0); // ADR-112 planter soil
  }
  if (builder) recordRecentBuild(world, builder, def.id); // Task 33: a placed piece joins the builder's Recently Crafted list
  return e;
}

/** Attachment entities (server). Each carries Transform (same position) + PieceLink to its piece slot. */
export function spawnAttachments(world: World, piece: Entity, def: PieceDef, sn: Snapped): Entity[] {
  const out: Entity[] = [];
  const link = (kind: AttachKind): Entity => {
    const a = world.create();
    world.add(a, Transform, sn.pos).add(a, PieceLink, {
      tx: sn.slot.tx, ty: sn.slot.ty, z: sn.slot.z, side: sn.slot.side, kind,
      layer: def.placement === Placement.Opening ? LAYER_OPENING : def.layer,
    });
    linkAttachment(world, piece, a); markLinked(world, a); indexEntity(world, a); out.push(a);
    return a;
  };
  if (def.door) world.add(link(AttachKind.Door), DoorState, { open: 0, lockTribe: def.features.clanLock ? world.getField(piece, Tribe, "id") ?? 0 : 0 });
  const specs = emitterSpecs(def);
  if (def.fired) {
    const f = link(AttachKind.Fire);
    world.add(f, Fuel, { burnUntilTick: 0, lit: 0 }).add(f, Container, { slotCount: Math.max(1, def.container) }).add(f, ContainerViewers);
    const heat = specs.find((s) => s.kind === 1);
    if (heat) world.add(f, Emitter, { kind: heat.kind, radius: heat.radius, strength: 0, falloff: Falloff.Linear });
    if (def.station !== StationKind.None) world.add(f, CraftingStation, { kind: def.station });
  } else if (def.stall) {
    // trade stall: stock (Container slot i = listing i) + header/listings/ledger on one attachment, proceeds in a separate till
    const st = link(AttachKind.Storage);
    world.add(st, Container, { slotCount: def.stall.listings }).add(st, ContainerViewers)
      .add(st, StallHeader, { ownerKind: 0, ownerId: 0, open: 0, listingCount: def.stall.listings }).add(st, Listings).add(st, StallLedger).add(st, StallSign, { soldOut: 1 });
    world.add(link(AttachKind.Till), Container, { slotCount: tillSlots() });
  } else if (def.container > 0) world.add(link(AttachKind.Storage), Container, { slotCount: def.container }).add(out[out.length - 1]!, ContainerViewers);
  const light = specs.find((s) => s.kind === 2);
  if (light) world.add(link(AttachKind.Light), Emitter, { kind: light.kind, radius: light.radius, strength: def.fired ? 0 : light.strength, falloff: Falloff.Quadratic });
  return out;
}

/** Validate + place (the Place intent). Returns the piece entity or the failure. */
export type PlaceResult = { ok: true; piece: Entity } | { ok: false; reason: BuildFail };
export function tryPlace(world: World, builder: Entity, req: PlaceRequest): PlaceResult {
  const sn = snapPlacement(world, req); if (typeof sn === "number") return { ok: false, reason: sn };
  const why = validatePlacement(world, builder, sn); if (why) return { ok: false, reason: why };
  const e = placePiece(world, builder, sn);
  emit(world, PiecePlaced, { piece: e, type: sn.def.id, builder });
  makeNoise(world, builder, gameplayDefs(world).noise.build);
  return { ok: true, piece: e };
}
void entityIndex;
