/**
 * Client build placement (owned by gameplay): turns the input aim + build selection into a snapped, reach-clamped,
 * validated preview, and the PlaceCmd intent for it. Browser-safe, pure over the local replica.
 *  - aim.mode 1 (AimMode.WorldPoint: cursor / touch world point): target = that point, clamped to buildReach.
 *  - aim.mode 0 (AimMode.Direction: stick / last move dir from AimResolver): target = player + dir * PLACE_AHEAD.
 *  - snapped with snapPlacement (grid / edge / free steps), validated with validatePlacement (range, privilege,
 *    terrain, overlap, support, cost). Server re-validates on PlaceCmd.
 */
import { Transform, type Entity, type World } from "@engine/core";
import { gameplayDefs } from "../config.js";
import { Placement } from "../defs.js";
import { claimOverlap } from "../building/zones.js";
import { BuildFail } from "../events.js";
import { hasOwnClaim, outerCornerRots, pieceCost, pieceUnlocked, snapPlacement, validatePlacement, type Snapped } from "../building/place.js";
import { isFineRot, isLCorner, rotParts, rotatedSize, structures, type StructureIndex } from "../building/structure.js";
import { maxHpOf } from "../building/integrity.js";
import { BuildPiece, Dead, EdgeSide, PieceSlot, PrivilegeZone } from "../components.js";
import { DemolishCmd, ReclaimCmd, RepairCmd, UpgradeCmd } from "../input.js";
import { siteOf, siteUnclaimed } from "../building/abandoned.js";
import { countItem } from "../inventory.js";
import { placeIntent, type BuildSelection, type MenuIntent } from "./menus.js";

/** Renderer contract: draw the ghost of `pieceKey` at (x, y, level) with `rot`, tinted valid/invalid. */
export interface BuildPreview {
  /** BuildPiece def key (gameplayDefs(world).pieces) — the Renderer maps it to the piece visual. */
  pieceKey: string; piece: number; tier: number; variant: number; paint: number;
  /** Snapped world position (tiles) — the placed piece's Transform x/y (piece centre, as replicated pieces) — and build level (0 = ground). */
  x: number; y: number; level: number;
  /** World height of the snapped slot (level * levelHeight; same as the placed piece's Transform.z). */
  z: number;
  /** Snapped rotation step: 0..3 quarter turns for cell/edge/opening pieces, 0..freeRotSteps-1 for free pieces. */
  rot: number; rotSteps: number;
  /** Placement would pass client validation; `reason` is the BuildFail code (0 when valid). */
  valid: boolean; reason: number;
  /** Touch snap assist (ADR-104) moved the request to a nearby valid snap; `request` holds the moved point. */
  assisted?: boolean;
  /** ADR-174: snap off, off-grid (1/16 tile, 15° steps) — rot/rotSteps are then the 24-step rotation. */
  fine?: boolean;
  /** Snapped facing (radians), identical to the placed piece's Transform.facing. */
  facing?: number;
  /** Unsnapped request (reach-clamped aim point + requested rot) that placePreviewIntent sends. */
  request: { x: number; y: number; rot: number };
  /** ADR-196: the ghost was pulled onto a neighbour's edge by the structural magnet. */
  magnet?: boolean;
  /** ADR-196: world-tile segment (at the preview level) shared with an existing piece: the HUD highlights it. */
  snapEdge?: SnapSegment;
  /** ADR-196: ghost footprint outline (world tiles; a segment for wall-like pieces) for the validity overlay. */
  outline?: SnapSegment[];
  /** ADR-315: the piece is a claim (Claim Flag): its radius for the area preview, and the claim it would overlap
   *  (ClaimOverlap) so the overlay can mark it. */
  claim?: { radius: number; overlap?: Entity };
  /** ADR-315: an overlapping Claim Flag ghost was pushed out onto the overlapped claim's rim (touching is allowed). */
  bumped?: boolean;
}
export interface SnapSegment { x0: number; y0: number; x1: number; y1: number }
export interface PlacementAim { x: number; y: number; mode: number }
export const PLACE_AHEAD = 2;

export function rotationSteps(world: World, piece: number): number {
  const d = gameplayDefs(world); const def = d.pieces.get(piece);
  return def?.placement === Placement.Tri ? 12 : def?.placement === Placement.Free ? def.rotSteps || d.building.freeRotSteps : 4;
}
export const rotateStep = (world: World, piece: number, rot: number, dir: 1 | -1): number => { const n = rotationSteps(world, piece); return (((rot + dir) % n) + n) % n; };

/** Target world point for an aim, clamped to reach. */
export function placementTarget(world: World, player: Entity, aim: PlacementAim | undefined): { x: number; y: number } | undefined {
  const t = world.get(player, Transform); if (!t) return undefined; const reach = gameplayDefs(world).building.buildReach;
  if (!aim) return { x: t.x + PLACE_AHEAD, y: t.y };
  if (aim.mode === 1) { const dx = aim.x - t.x, dy = aim.y - t.y, d = Math.hypot(dx, dy); const k = d > reach ? reach / d : 1; return { x: t.x + dx * k, y: t.y + dy * k }; }
  const n = Math.hypot(aim.x, aim.y) || 1; const a = Math.min(PLACE_AHEAD, reach); return { x: t.x + (aim.x / n) * a, y: t.y + (aim.y / n) * a };
}

/** Max distance a snap moves a piece's centre from the aim point (half a tile diagonal, rounded up). */
export const SNAP_REACH_MARGIN = 0.75;
/** ADR-142: an aim clamped to the very edge of reach snapped outward and read "Too far away" (the ghost flipped red at the
 *  rim, e.g. after rotating). Pull the request in by SNAP_REACH_MARGIN so whatever it snaps to stays in reach. */
function withinSnapReach(world: World, player: Entity, at: { x: number; y: number }): { x: number; y: number } {
  const t = world.get(player, Transform); return t ? clampToSnapReach(t, at, gameplayDefs(world).building.buildReach) : at;
}
/** Pure core of withinSnapReach: `at` pulled toward `from` to at most reach − SNAP_REACH_MARGIN. */
export function clampToSnapReach(from: { x: number; y: number }, at: { x: number; y: number }, reach: number): { x: number; y: number } {
  const lim = reach - SNAP_REACH_MARGIN; const dx = at.x - from.x, dy = at.y - from.y, dd = Math.hypot(dx, dy); if (dd <= lim || lim <= 0) return at;
  return { x: from.x + (dx * lim) / dd, y: from.y + (dy * lim) / dd };
}
/** Snap-assist probe ring (tiles): 8 directions at 0.5 then 1.0 tiles, fixed order (deterministic). */
export const SNAP_ASSIST_RING: readonly (readonly [number, number])[] = [0.5, 1].flatMap((r) => [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [Math.round(Math.cos((k * Math.PI) / 4) * r * 1e6) / 1e6, Math.round(Math.sin((k * Math.PI) / 4) * r * 1e6) / 1e6] as const));
/**
 * Preview with touch snap assist: when the direct aim is invalid and assist is on (default for stick/touch aim,
 * mode 0; `assist` overrides), the first valid preview from SNAP_ASSIST_RING around the aim is returned instead.
 */
export function buildPreviewFor(world: World, player: Entity, sel: BuildSelection, rot: number, aim: PlacementAim | undefined, level = 0, assist?: boolean): BuildPreview | undefined {
  // ADR-228: one preview pass validates each distinct snapped slot once (the magnet candidates and the 16-offset assist
  // ring mostly snap to the same few slots); the world cannot change inside the pass, so the reuse is exact.
  const outer = validateMemo === undefined; if (outer) validateMemo = new Map();
  try { return buildPreviewPass(world, player, sel, rot, aim, level, assist); } finally { if (outer) validateMemo = undefined; }
}
let validateMemo: Map<string, number> | undefined;
/** ADR-228 stats (tests/bench): validatePlacement calls made and reused by preview passes. */
export const previewStats = { validated: 0, reused: 0 };
const slotKey = (sn: Snapped): string => {
  let k = `${sn.def.id}|${sn.tier}|${sn.variant}|${sn.parent}|${sn.pos.x}|${sn.pos.y}|${sn.pos.z}|${sn.pos.facing}`;
  for (const v of Object.values(sn.slot)) if (typeof v !== "object") k += `|${String(v)}`;
  return k;
};
function buildPreviewPass(world: World, player: Entity, sel: BuildSelection, rot: number, aim: PlacementAim | undefined, level: number, assist?: boolean): BuildPreview | undefined {
  const p0 = rawPreview(world, player, sel, rot, aim, level);
  const p = p0 && assist !== false ? magnetize(world, player, sel, rot, aim, level, p0) : p0;
  if (p && !p.valid && p.claim && p.reason === BuildFail.ClaimOverlap && assist !== false) { const b = bumpClaim(world, player, sel, rot, level, p); if (b) return b; }
  if (!p || p.valid || !(assist ?? (aim !== undefined && aim.mode !== 1))) return p;
  if (p.magnet && isLCorner(gameplayDefs(world).pieces.get(sel.piece))) return p; // ADR-211: the L's red corner is final (no hop to another vertex)
  const at = placementTarget(world, player, aim)!;
  for (const [dx, dy] of SNAP_ASSIST_RING) {
    const q = rawPreview(world, player, sel, rot, { mode: 1, x: at.x + dx, y: at.y + dy }, level);
    if (q?.valid) return { ...q, assisted: true };
  }
  return p;
}
function rawPreview(world: World, player: Entity, sel: BuildSelection, rot: number, aim: PlacementAim | undefined, level: number): BuildPreview | undefined {
  const d = gameplayDefs(world); const def = d.pieces.get(sel.piece); const at0 = placementTarget(world, player, aim); if (!def || !at0) return undefined;
  const at = withinSnapReach(world, player, at0);
  const sn = snapPlacement(world, { piece: sel.piece, x: at.x, y: at.y, level, rot, tier: sel.tier, variant: sel.variant });
  const base = { pieceKey: def.key, piece: def.id, tier: sel.tier, variant: sel.variant, paint: sel.paint, level, rotSteps: rotationSteps(world, sel.piece), request: { x: at.x, y: at.y, rot } };
  if (typeof sn === "number") return { ...base, x: at.x, y: at.y, z: level * d.building.levelHeight, rot, valid: false, reason: sn };
  const key = validateMemo ? slotKey(sn) : ""; let reason = validateMemo?.get(key);
  if (reason === undefined) { reason = validatePlacement(world, player, sn); previewStats.validated++; validateMemo?.set(key, reason); } else previewStats.reused++;
  const r = rotParts(def, sn.slot.rot); // ADR-174: an off-grid piece's ghost turns in its 15° steps, like the placed piece
  const overlap = def.privilegeRadius > 0 && reason === BuildFail.ClaimOverlap ? claimOverlap(world, sn.pos.x, sn.pos.y, def.privilegeRadius) : undefined;
  const claim: BuildPreview["claim"] = def.privilegeRadius > 0 ? (overlap !== undefined ? { radius: def.privilegeRadius, overlap } : { radius: def.privilegeRadius }) : undefined;
  return { ...base, tier: sn.tier, variant: sn.variant, x: sn.pos.x, y: sn.pos.y, z: sn.pos.z, rot: r.rot, rotSteps: r.steps, fine: isFineRot(def, sn.slot.rot), facing: sn.pos.facing, valid: reason === 0, reason, ...(claim ? { claim } : {}) };
}
/** ADR-315: farthest (tiles) an overlapping Claim Flag ghost is pushed out to touch the claim it overlaps. */
export const CLAIM_BUMP_MAX = 4;
/** ADR-315: push an overlapping claim ghost radially out of the claim it overlaps until the rims touch (clanmates
 *  "bump up" to each other's land); undefined when that is more than CLAIM_BUMP_MAX away or the spot is not valid. */
function bumpClaim(world: World, player: Entity, sel: BuildSelection, rot: number, level: number, p: BuildPreview): BuildPreview | undefined {
  const z = p.claim?.overlap; if (z === undefined || !p.claim) return undefined;
  const zt = world.get(z, Transform); const rz = world.getField(z, PrivilegeZone, "radius"); if (!zt || rz === undefined) return undefined;
  let dx = p.x - zt.x, dy = p.y - zt.y; const d = Math.hypot(dx, dy); if (d < 1e-6) return undefined;
  const need = rz + p.claim.radius; if (need - d > CLAIM_BUMP_MAX) return undefined;
  dx /= d; dy /= d;
  for (const extra of [0.01, 0.26, 0.51, 1.01]) {
    const q = rawPreview(world, player, sel, rot, { mode: 1, x: zt.x + dx * (need + extra), y: zt.y + dy * (need + extra) }, level);
    if (q?.valid) return { ...q, assisted: true, bumped: true };
  }
  return undefined;
}
// ---- ADR-196: structural magnet --------------------------------------------------------------------------------
/** Aim distance (tiles) within which a structural ghost is pulled onto a neighbour: the aim may be up to ~0.5 tile
 *  past the edge band of the cell next to an existing piece (cell centre <= 1.0 away) or 0.5 from a free edge. */
export const MAGNET_CELL_RADIUS = 1.0, MAGNET_EDGE_RADIUS = 0.6;
const STRUCTURAL = new Set(["foundation", "wall", "floor", "corner", "roof"]);
const NB: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const hasCell = (idx: StructureIndex, x: number, y: number, z: number): boolean => idx.deck(x, y, z) !== 0;
const hasEdge = (idx: StructureIndex, tx: number, ty: number, z: number, side: EdgeSide): boolean => idx.edge(tx, ty, z, side) !== 0;
const edgeSeg = (tx: number, ty: number, side: EdgeSide): SnapSegment => side === EdgeSide.North ? { x0: tx, y0: ty, x1: tx + 1, y1: ty } : { x0: tx, y0: ty, x1: tx, y1: ty + 1 };
/** Ghost outline + the segment it shares with an existing piece (undefined when it touches nothing). Pure over the index. */
export function snapContact(idx: StructureIndex, kind: "cell" | "edge", r: { x0: number; y0: number; x1: number; y1: number }, z: number): { outline: SnapSegment[]; edge?: SnapSegment } {
  if (kind === "edge") {
    const side = r.y0 === r.y1 ? EdgeSide.North : EdgeSide.West; const tx = r.x0, ty = r.y0; const seg = edgeSeg(tx, ty, side);
    const below = side === EdgeSide.North ? [[tx, ty], [tx, ty - 1]] : [[tx, ty], [tx - 1, ty]];
    const onDeck = below.some(([x, y]) => hasCell(idx, x!, y!, z)) || (z > 0 && hasWallsBelow(idx, tx, ty, side, z - 1));
    const along = side === EdgeSide.North ? hasEdge(idx, tx - 1, ty, z, side) || hasEdge(idx, tx + 1, ty, z, side) : hasEdge(idx, tx, ty - 1, z, side) || hasEdge(idx, tx, ty + 1, z, side);
    return { outline: [seg], ...(onDeck || along ? { edge: seg } : {}) };
  }
  const { x0, y0, x1, y1 } = r;
  const outline = [{ x0, y0, x1, y1: y0 }, { x0: x1, y0, x1, y1 }, { x0, y0: y1, x1, y1 }, { x0, y0, x1: x0, y1 }];
  for (let x = x0; x < x1; x++) {
    if (hasCell(idx, x, y0 - 1, z) || (z > 0 && hasEdge(idx, x, y0, z - 1, EdgeSide.North))) return { outline, edge: { x0: x, y0, x1: x + 1, y1: y0 } };
    if (hasCell(idx, x, y1, z) || (z > 0 && hasEdge(idx, x, y1, z - 1, EdgeSide.North))) return { outline, edge: { x0: x, y0: y1, x1: x + 1, y1 } };
  }
  for (let y = y0; y < y1; y++) {
    if (hasCell(idx, x0 - 1, y, z) || (z > 0 && hasEdge(idx, x0, y, z - 1, EdgeSide.West))) return { outline, edge: { x0, y0: y, x1: x0, y1: y + 1 } };
    if (hasCell(idx, x1, y, z) || (z > 0 && hasEdge(idx, x1, y, z - 1, EdgeSide.West))) return { outline, edge: { x0: x1, y0: y, x1, y1: y + 1 } };
  }
  return { outline };
}
const hasWallsBelow = (idx: StructureIndex, tx: number, ty: number, side: EdgeSide, z: number): boolean => hasEdge(idx, tx, ty, z, side);
/**
 * Candidate aim points next to existing structure around `at` (deterministic order): for cell pieces the centres of
 * free cells beside same-level decks or bounded by walls one level down (floors on wall tops); for edge pieces the
 * midpoints of free edges of same-level decks, wall tops below, and the collinear continuation of existing walls.
 */
export function magnetCandidates(idx: StructureIndex, kind: "cell" | "edge", at: { x: number; y: number }, z: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []; const cx = Math.floor(at.x), cy = Math.floor(at.y);
  for (let ty = cy - 2; ty <= cy + 2; ty++) for (let tx = cx - 2; tx <= cx + 2; tx++) {
    if (kind === "cell") {
      if (hasCell(idx, tx, ty, z)) continue;
      const near = NB.some(([dx, dy]) => hasCell(idx, tx + dx, ty + dy, z))
        || (z > 0 && (hasEdge(idx, tx, ty, z - 1, EdgeSide.North) || hasEdge(idx, tx, ty + 1, z - 1, EdgeSide.North) || hasEdge(idx, tx, ty, z - 1, EdgeSide.West) || hasEdge(idx, tx + 1, ty, z - 1, EdgeSide.West)));
      if (near) out.push({ x: tx + 0.5, y: ty + 0.5 });
    } else {
      for (const side of [EdgeSide.North, EdgeSide.West]) {
        if (hasEdge(idx, tx, ty, z, side)) continue;
        const c = snapContact(idx, "edge", edgeSeg(tx, ty, side), z);
        if (c.edge) out.push(side === EdgeSide.North ? { x: tx + 0.5, y: ty } : { x: tx, y: ty + 0.5 });
      }
    }
  }
  return out;
}
function footRect(world: World, p: BuildPreview): { kind: "cell" | "edge"; r: SnapSegment } | undefined {
  const def = gameplayDefs(world).pieces.get(p.piece); if (!def) return undefined;
  if (def.placement === Placement.Edge) {
    const north = Number.isInteger(p.y); return { kind: "edge", r: north ? { x0: Math.floor(p.x), y0: p.y, x1: Math.floor(p.x) + 1, y1: p.y } : { x0: p.x, y0: Math.floor(p.y), x1: p.x, y1: Math.floor(p.y) + 1 } };
  }
  if (def.placement !== Placement.Cell) return undefined;
  const [w, h] = rotatedSize(def, p.rot & 3); const x0 = Math.round(p.x - w / 2), y0 = Math.round(p.y - h / 2);
  return { kind: "cell", r: { x0, y0, x1: x0 + w, y1: y0 + h } };
}
function withContact(world: World, idx: StructureIndex, p: BuildPreview): BuildPreview {
  const f = footRect(world, p); if (!f) return p; const c = snapContact(idx, f.kind, f.r, p.level);
  return { ...p, outline: c.outline, ...(c.edge ? { snapEdge: c.edge } : {}) };
}
/** ADR-210: wall edges meeting at vertex (vx, vy) on level z: [north-edge count, west-edge count]. */
export function vertexWalls(idx: StructureIndex, vx: number, vy: number, z: number): [number, number] {
  const n = (hasEdge(idx, vx - 1, vy, z, EdgeSide.North) ? 1 : 0) + (hasEdge(idx, vx, vy, z, EdgeSide.North) ? 1 : 0);
  const w = (hasEdge(idx, vx, vy - 1, z, EdgeSide.West) ? 1 : 0) + (hasEdge(idx, vx, vy, z, EdgeSide.West) ? 1 : 0);
  return [n, w];
}
/** ADR-210: vertices near `at` where a north-running and a west-running wall meet (corner junctions), nearest first. */
export function cornerJunctions(idx: StructureIndex, at: { x: number; y: number }, z: number, radius = MAGNET_CORNER_RADIUS): { x: number; y: number }[] {
  const out: { x: number; y: number; d: number }[] = []; const cx = Math.round(at.x), cy = Math.round(at.y);
  for (let vy = cy - 1; vy <= cy + 1; vy++) for (let vx = cx - 1; vx <= cx + 1; vx++) {
    const [n, w] = vertexWalls(idx, vx, vy, z); if (n === 0 || w === 0) continue;
    const d = Math.hypot(vx - at.x, vy - at.y); if (d <= radius) out.push({ x: vx, y: vy, d });
  }
  return out.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x).map(({ x, y }) => ({ x, y }));
}
export const MAGNET_CORNER_RADIUS = 0.75;
/**
 * ADR-196 magnet: structural pieces (foundation/wall/floor/corner/roof families) whose direct snap is invalid or
 * touches nothing jump to the nearest VALID slot beside existing structure within the magnet radius. Every input
 * (mouse, touch tap/drag, gamepad cursor, facing aim) goes through here while Snap is on.
 */
export function magnetize(world: World, player: Entity, sel: BuildSelection, rot: number, aim: PlacementAim | undefined, level: number, p: BuildPreview): BuildPreview {
  const def = gameplayDefs(world).pieces.get(sel.piece); if (!def || !STRUCTURAL.has(def.family)) return p;
  if (def.snap === "vertex") return magnetizeCorner(world, player, sel, rot, aim, level, p);
  const f = footRect(world, p); if (!f) return p;
  const idx = structures(world); const direct = withContact(world, idx, p);
  if (direct.valid && direct.snapEdge) return direct;
  // Only pull from open ground or a missing-socket/support spot; a taken/too-far/unaffordable spot keeps its red "why".
  if (!direct.valid && direct.reason !== 10 && direct.reason !== 11) return direct;
  const at = placementTarget(world, player, aim); if (!at) return direct;
  const radius = f.kind === "cell" ? MAGNET_CELL_RADIUS : MAGNET_EDGE_RADIUS;
  let best: BuildPreview | undefined; let bestD = Infinity;
  for (const c of magnetCandidates(idx, f.kind, at, level)) {
    const d = Math.hypot(c.x - at.x, c.y - at.y); if (d > radius || d >= bestD) continue;
    const q = rawPreview(world, player, sel, rot, { mode: 1, x: c.x, y: c.y }, level); if (!q?.valid) continue;
    const qc = withContact(world, idx, q); if (!qc.snapEdge) continue;
    best = { ...qc, magnet: true }; bestD = d;
  }
  return best ?? direct;
}

/** ADR-210: a corner post auto-suggests the nearest wall junction (a vertex where N- and W-running walls meet). */
function magnetizeCorner(world: World, player: Entity, sel: BuildSelection, rot: number, aim: PlacementAim | undefined, level: number, p: BuildPreview): BuildPreview {
  const idx = structures(world);
  if (isLCorner(gameplayDefs(world).pieces.get(sel.piece))) return magnetizeL(world, player, sel, rot, aim, level, p, idx);
  const [n0, w0] = vertexWalls(idx, Math.round(p.x), Math.round(p.y), level);
  if (p.valid && n0 > 0 && w0 > 0) { const q = sel.autoRot === false ? p : fitCorner(world, player, sel, rot, { x: Math.round(p.x), y: Math.round(p.y) }, level, idx); return { ...(q?.valid ? q : p), magnet: false }; }
  if (!p.valid && p.reason !== 10 && p.reason !== 11) return p;
  const at = placementTarget(world, player, aim) ?? { x: p.x, y: p.y };
  for (const c of cornerJunctions(idx, at, level)) {
    const q = fitCorner(world, player, sel, rot, c, level, idx); if (q?.valid) return { ...q, magnet: true };
  }
  return p;
}
/**
 * ADR-211 L corner: snap to the nearest foundation outer corner (vertex within ~1.5 tiles of the aim), auto-rotated so
 * both arms run along its open sides. RB / R (autoRot false) keeps the hand-picked rotation and snaps to the nearest
 * vertex where that rotation wraps a deck tile. Same path for pad, mouse and touch (all aim through placementTarget).
 */
export function lCornerCandidates(idx: StructureIndex, x: number, y: number, z: number): { x: number; y: number; rot: number; d: number }[] {
  const out: { x: number; y: number; rot: number; d: number }[] = [];
  for (let vy = Math.floor(y) - 1; vy <= Math.floor(y) + 2; vy++) for (let vx = Math.floor(x) - 1; vx <= Math.floor(x) + 2; vx++) {
    const d = Math.hypot(vx - x, vy - y); if (d > 1.6) continue;
    for (const r of outerCornerRots(idx, vx, vy, z)) out.push({ x: vx, y: vy, rot: r, d });
  }
  return out.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x || a.rot - b.rot);
}
/**
 * ADR-211 L corner preview: snaps to the nearest foundation outer corner (within 1.6 tiles of the aim), auto-rotated
 * to wrap it. After RB (sel.autoRot false) the corner stays on that vertex with the player's rotation, red when that
 * rotation does not wrap a deck. A taken outer corner falls through to the next one; none valid shows the nearest red.
 */
function magnetizeL(world: World, player: Entity, sel: BuildSelection, rot: number, aim: PlacementAim | undefined, level: number, p: BuildPreview, idx: StructureIndex): BuildPreview {
  const at = placementTarget(world, player, aim) ?? { x: p.x, y: p.y };
  const cands = lCornerCandidates(idx, at.x, at.y, level);
  if (sel.autoRot === false && rot < 4) {
    const v = cands[0] ?? { x: Math.round(at.x), y: Math.round(at.y) };
    const q = rawPreview(world, player, sel, rot & 3, { mode: 1, x: v.x, y: v.y }, level); return q ? { ...q, magnet: true } : p;
  }
  let first: BuildPreview | undefined;
  for (const c of cands) {
    const q = rawPreview(world, player, sel, c.rot, { mode: 1, x: c.x, y: c.y }, level); if (!q) continue;
    if (q.valid) return { ...q, magnet: true };
    first ??= q;
  }
  return first ? { ...first, magnet: true } : p; // nearest corner shown red (e.g. an arm edge already holds a wall)
}
/**
 * ADR-211: rotations whose two arms lie along walls meeting at vertex (vx, vy): rot 0 = walls toward +x and +y,
 * 1 = -x/+y, 2 = -x/-y, 3 = +x/-y (quarter turns of the corner art; same quadrant for outer/inner/angled).
 */
export function cornerFitRots(idx: StructureIndex, vx: number, vy: number, z: number): number[] {
  const px = hasEdge(idx, vx, vy, z, EdgeSide.North), nx = hasEdge(idx, vx - 1, vy, z, EdgeSide.North);
  const py = hasEdge(idx, vx, vy, z, EdgeSide.West), ny = hasEdge(idx, vx, vy - 1, z, EdgeSide.West);
  const out: number[] = []; if (px && py) out.push(0); if (nx && py) out.push(1); if (nx && ny) out.push(2); if (px && ny) out.push(3); return out;
}
/** Preview at junction `c`: auto-rotated to fit its walls (kept when `rot` already fits, or the player rotated by hand). */
function fitCorner(world: World, player: Entity, sel: BuildSelection, rot: number, c: { x: number; y: number }, level: number, idx: StructureIndex): BuildPreview | undefined {
  let r = rot;
  if (sel.autoRot !== false && rot < 4) { const fits = cornerFitRots(idx, c.x, c.y, level); if (fits.length && !fits.includes(rot & 3)) r = fits[0]!; }
  return rawPreview(world, player, sel, r, { mode: 1, x: c.x, y: c.y }, level);
}

/** PlaceCmd for a preview (raw rot as requested; the server re-snaps the same way). */
export const placePreviewIntent = (p: BuildPreview): MenuIntent =>
  placeIntent({ piece: p.piece, tier: p.tier, variant: p.variant, paint: p.paint }, { x: p.request.x, y: p.request.y, level: p.level, rot: p.request.rot });

// ---- ADR-136: targeted placed piece (contextual Repair / Upgrade / Demolish) -----------------------------------
export interface PieceTarget {
  entity: Entity; piece: number; pieceKey: string; level: number; tier: number; tierKey: string; hp: number; maxHp: number;
  /** Next tier for Upgrade (undefined when not tiered / already top tier). */
  nextTier: number | undefined; nextTierKey: string | undefined;
  canRepair: boolean; canUpgrade: boolean; canReclaim: boolean; canAfford: { repair: boolean; upgrade: boolean };
  /** ADR-310: the player's Claim Flag covers this piece; they have unlocked its current tier. */
  onClaim: boolean; repairUnlocked: boolean;
  /** ADR-250: Demolish is a "Pick up" (full refund x hp fraction, contents drop as a bag). */
  pickup: boolean;
}
/** Placed piece nearest the aim point (within `radius` tiles, same level preferred) that is in build reach; undefined if none. */
export function pieceTargetAt(world: World, player: Entity, at: { x: number; y: number } | undefined, level = 0, radius = 0.9): PieceTarget | undefined {
  const pt = world.get(player, Transform); if (!pt || !at || !world.isRegistered(BuildPiece)) return undefined;
  const d = gameplayDefs(world); const reach = d.building.buildReach + 1;
  let best: Entity | undefined; let bestD = Infinity;
  for (const e of world.query([BuildPiece, Transform], [Dead])) {
    // ADR-228: field reads (no Transform copy per piece) and the aim-box reject first: the level penalty is added to
    // both sides of the radius test, so only pieces within `radius` of the aim can ever win.
    const tx = world.getField(e, Transform, "x")!, ty = world.getField(e, Transform, "y")!;
    if (Math.abs(tx - at.x) > radius || Math.abs(ty - at.y) > radius) continue;
    if (Math.hypot(tx - pt.x, ty - pt.y) > reach) continue;
    const z = world.getField(e, PieceSlot, "z") ?? Math.round(world.getField(e, Transform, "z")! / d.building.levelHeight);
    const pen = z === level ? 0 : 0.5 + Math.abs(z - level); const dist = Math.hypot(tx - at.x, ty - at.y) + pen;
    if (dist <= radius + pen && dist < bestD) { bestD = dist; best = e; }
  }
  if (best === undefined) return undefined;
  const bp = world.get(best, BuildPiece)!; const def = d.pieces.get(bp.type); if (!def) return undefined;
  const maxHp = maxHpOf(world, best); const tierKey = (id: number) => d.tiers.find((x) => x.id === id)?.key ?? String(id);
  const next = def.tiered && bp.tier + 1 < d.tiers.length ? bp.tier + 1 : undefined;
  const has = (cost: { item: number; count: number }[]) => cost.every((c) => countItem(world, player, c.item) >= c.count);
  const missing = 1 - bp.hp / Math.max(1, maxHp); const mul = d.tiers[bp.tier]?.repairMul ?? 0.3;
  const tx = world.getField(best, Transform, "x")!, ty = world.getField(best, Transform, "y")!;
  const onClaim = hasOwnClaim(world, player, tx, ty);
  const repairUnlocked = pieceUnlocked(world, player, def, bp.tier);
  return { entity: best, piece: def.id, pieceKey: def.key, level: world.getField(best, PieceSlot, "z") ?? 0, tier: bp.tier, tierKey: tierKey(bp.tier), hp: bp.hp, maxHp,
    nextTier: next, nextTierKey: next === undefined ? undefined : tierKey(next),
    canRepair: bp.hp < maxHp && onClaim && repairUnlocked, canUpgrade: next !== undefined && onClaim,
    canReclaim: (() => { const site = siteOf(world, best); return !!site && siteUnclaimed(world, site) && onClaim; })(), pickup: def.pickup,
    onClaim, repairUnlocked,
    canAfford: { repair: has(pieceCost(d, def, bp.tier, mul * missing)), upgrade: next !== undefined && has(pieceCost(d, def, next)) } };
}
export const repairIntent = (target: Entity): MenuIntent => ({ cmd: RepairCmd, args: { target }, entities: ["target"] });
export const reclaimIntent = (target: Entity): MenuIntent => ({ cmd: ReclaimCmd, args: { target }, entities: ["target"] });
export const upgradeIntent = (target: Entity, tier: number): MenuIntent => ({ cmd: UpgradeCmd, args: { target, tier }, entities: ["target"] });
export const demolishIntent = (target: Entity): MenuIntent => ({ cmd: DemolishCmd, args: { target }, entities: ["target"] });

/** World-tile outline of a placed piece, for highlighting the demolish / repair / upgrade target. */
export function pieceFootprintOutline(world: World, e: Entity): { segments: SnapSegment[]; z: number } | undefined {
  const bp = world.get(e, BuildPiece); const tr = world.get(e, Transform); if (!bp || !tr) return undefined;
  const def = gameplayDefs(world).pieces.get(bp.type); if (!def) return undefined;
  const slot = world.has(e, PieceSlot) ? world.get(e, PieceSlot) : undefined;
  if (def.placement === Placement.Edge || def.placement === Placement.Opening) {
    if (slot && (slot.side === EdgeSide.North || slot.side === EdgeSide.West)) return { segments: [edgeSeg(slot.tx, slot.ty, slot.side)], z: tr.z };
    const north = Math.abs(tr.y - Math.round(tr.y)) <= Math.abs(tr.x - Math.round(tr.x));
    const seg = north
      ? { x0: Math.floor(tr.x), y0: Math.round(tr.y), x1: Math.floor(tr.x) + 1, y1: Math.round(tr.y) }
      : { x0: Math.round(tr.x), y0: Math.floor(tr.y), x1: Math.round(tr.x), y1: Math.floor(tr.y) + 1 };
    return { segments: [seg], z: tr.z };
  }
  const [w, h] = rotatedSize(def, bp.rot & 3);
  const x0 = slot && def.placement === Placement.Cell ? slot.tx : Math.round(tr.x - w / 2);
  const y0 = slot && def.placement === Placement.Cell ? slot.ty : Math.round(tr.y - h / 2);
  return { segments: [
    { x0, y0, x1: x0 + w, y1: y0 }, { x0: x0 + w, y0, x1: x0 + w, y1: y0 + h },
    { x0, y0: y0 + h, x1: x0 + w, y1: y0 + h }, { x0, y0, x1: x0, y1: y0 + h },
  ], z: tr.z };
}
