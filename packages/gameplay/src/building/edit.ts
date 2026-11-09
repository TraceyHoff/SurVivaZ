/**
 * ADR-317 / ADR-318: who built / owns a placed piece, who may demolish it and what it refunds, and moving a piece.
 * Pure over the world, so the client replica shows exactly what the authoritative server will do (the server
 * re-checks everything on DemolishCmd / MoveCmd).
 *
 * Refunds (ADR-317): your own build refunds 100% of the piece's current-tier cost, regardless of damage. Anything you
 * did not build (a clanmate's piece, abandoned / worldgen ruins, a reclaimed piece) refunds `demolishRefund` (50%),
 * floored per resource but at least 1 of each resource the piece costs. A hired worker's builds count as its
 * employer's (and the employer's as the worker's), because the hire builds on the employer's behalf.
 *
 * Permission (ADR-317): every claim covering the piece must be the actor's (own, clan with the "base" rank permission,
 * or the employer's for a hired worker: zoneOwnedBy). Outside every claim (wilderness), worldgen ruins (tribe 0) and
 * the actor's own pieces may be demolished; another tribe's piece may not.
 *
 * Move (ADR-318): the same entity is re-slotted atomically by one command, so cancelling (never sending) or a
 * disconnect can never lose it, and every attachment (storage contents, fuel, door state, light) comes along.
 */
import { PlayerId, Transform, type Entity, type World } from "@engine/core";
import { BuildPiece, PieceBuilder, PieceLink, PieceOwner, PieceStability, Tribe, Worker } from "../components.js";
import { gameplayDefs, isAuthority } from "../config.js";
import type { ItemCount, PieceDef } from "../defs.js";
import { BuildFail, emit, PieceMoved } from "../events.js";
import { maxHpOf } from "./integrity.js";
import { attachmentsOf } from "./links.js";
import { candidateStability, hasPrivilege, pieceCost, snapPlacement, tribeOf, validatePlacement, zonesAt, zoneOwnedBy, type PlaceRequest, type Snapped } from "./place.js";
import { reseatSmallOn, smallPiecesOn } from "./surface.js";
import { structures } from "./structure.js";
import { invalidateZoneGrid } from "./zones.js";

const pidOf = (world: World, e: Entity): number => (world.isRegistered(PlayerId) && world.has(e, PlayerId) ? world.getField(e, PlayerId, "id") ?? 0 : 0);
const employerOf = (world: World, e: Entity): number => (world.isRegistered(Worker) && world.has(e, Worker) ? world.getField(e, Worker, "owner") ?? 0 : 0);
const field = (world: World, e: Entity, def: typeof PieceOwner | typeof PieceBuilder): number | undefined =>
  world.isRegistered(def) && world.has(e, def) ? world.getField(e, def, "player") ?? 0 : undefined;
/** Employer (PlayerId) of the hired worker whose PlayerId is `pid`, or 0. */
function employerOfPid(world: World, pid: number): number {
  if (!pid || !world.isRegistered(Worker)) return 0;
  for (const w of world.query([Worker, PlayerId])) if (world.getField(w, PlayerId, "id") === pid) return world.getField(w, Worker, "owner") ?? 0;
  return 0;
}
/** Tribe of the player entity with PlayerId `pid` (0 if none / not loaded). */
function tribeOfPid(world: World, pid: number): number {
  if (!pid) return 0;
  for (const p of world.query([PlayerId])) if (world.getField(p, PlayerId, "id") === pid) return tribeOf(world, p);
  return 0;
}

/** ADR-317: PlayerId that built the piece (PieceBuilder; legacy pieces fall back to PieceOwner), 0 = worldgen, undefined = unknown. */
export function builtBy(world: World, piece: Entity): number | undefined {
  return field(world, piece, PieceBuilder) ?? field(world, piece, PieceOwner);
}
/** ADR-317: the actor built this piece (or their hired worker did, or — for a hired worker — its employer did).
 *  A piece with no recorded builder (saved before ADR-317) counts as the actor's when it carries the actor's tribe. */
export function builtByActor(world: World, piece: Entity, actor: Entity): boolean {
  const b = builtBy(world, piece); const pid = pidOf(world, actor);
  if (b === undefined) { const t = world.getField(piece, Tribe, "id") ?? 0; return t !== 0 && t === tribeOf(world, actor); }
  if (!b) return false;
  if (b === pid) return true;
  const emp = employerOf(world, actor); if (emp && b === emp) return true; // a hired worker taking down its employer's build
  return !!pid && employerOfPid(world, b) === pid; // the actor's hired worker built it
}
/** ADR-318: the piece belongs to the actor: same (nonzero) tribe — own personal tribe or clan base — or owned / built by
 *  the actor, or (hired worker) by its employer. Worldgen ruins (tribe 0, no owner) belong to nobody until reclaimed. */
export function pieceOwnedBy(world: World, piece: Entity, actor: Entity): boolean {
  const t = world.getField(piece, Tribe, "id") ?? 0; const at = tribeOf(world, actor);
  if (t && at && t === at) return true;
  const owner = field(world, piece, PieceOwner) ?? 0; const b = field(world, piece, PieceBuilder) ?? 0; const who = owner || b;
  const pid = pidOf(world, actor); if (pid && who === pid) return true;
  const emp = employerOf(world, actor);
  return !!emp && (who === emp || (t !== 0 && tribeOfPid(world, emp) === t));
}

/** ADR-317: 0 when the actor may demolish the piece, else BuildFail.NoDemolishPermission. Same rule for players and AI. */
export function demolishPermission(world: World, actor: Entity, piece: Entity): BuildFail | 0 {
  const t = world.get(piece, Transform); if (!t) return BuildFail.InvalidTarget;
  const zones = zonesAt(world, t.x, t.y);
  if (zones.length) return zones.every((z) => zoneOwnedBy(world, z, actor)) ? 0 : BuildFail.NoDemolishPermission;
  const tribe = world.getField(piece, Tribe, "id") ?? 0; // wilderness: ruins (tribe 0) and your own pieces only
  return tribe === 0 || pieceOwnedBy(world, piece, actor) ? 0 : BuildFail.NoDemolishPermission;
}
/** ADR-317: what Demolish (or Pick up) gives back: 100% of the current tier's cost for your own build, else 50% (min 1 each). */
export function demolishRefund(world: World, actor: Entity, piece: Entity): { items: ItemCount[]; full: boolean } {
  const defs = gameplayDefs(world); const bp = world.get(piece, BuildPiece); const def = bp && defs.pieces.get(bp.type);
  if (!bp || !def) return { items: [], full: false };
  const cost = pieceCost(defs, def, bp.tier); const full = builtByActor(world, piece, actor);
  if (full) return { items: cost, full };
  const k = defs.building.demolishRefund;
  return { items: cost.map((c) => ({ item: c.item, count: Math.max(1, Math.floor(c.count * k)) })), full };
}

/** ADR-318: pieces that never move — they carry their own land / world state (stalls, planter soil, terrain ladders, shaft hatches). */
export const movableDef = (def: PieceDef): boolean => !def.stall && !def.features.planter && !def.features.terrainLadder && !def.features.shaftHatch;
/**
 * ADR-318: why the actor cannot pick this piece up to move it (checked at the source; the destination is validated by
 * validatePlacement). 0 = movable. Order: NotMovable, NotYours, NoMovePermission, NeedsRepair, HasDependents.
 */
export function moveBlocker(world: World, actor: Entity, piece: Entity): BuildFail | 0 {
  const idx = structures(world); const def = idx.def(piece); const t = world.get(piece, Transform);
  if (!def || !t || !world.has(piece, BuildPiece)) return BuildFail.InvalidTarget;
  if (!movableDef(def)) return BuildFail.NotMovable;
  if (!pieceOwnedBy(world, piece, actor)) return BuildFail.NotYours;
  if (!hasPrivilege(world, actor, t.x, t.y)) return BuildFail.NoMovePermission;
  if ((world.getField(piece, BuildPiece, "hp") ?? 0) < maxHpOf(world, piece)) return BuildFail.NeedsRepair;
  if (idx.dependents(piece).length) return BuildFail.HasDependents; // structural pieces that hold up others stay put
  if (def.surfaceHeight > 0 && smallPiecesOn(world, piece).length) return BuildFail.HasDependents; // decor on a table
  return 0;
}
/** ADR-318: destination check while the piece is lifted out of the index (StructureIndex.lifted). No cost, normal reach /
 *  claim / support / overlap rules; a moved Claim Flag ignores its own zone. A foreign claim reads as NoMovePermission. */
export function validateLiftedMove(world: World, actor: Entity, piece: Entity, sn: Snapped): BuildFail | 0 {
  const r = validatePlacement(world, actor, sn, { ignoreCost: true, ...(sn.def.privilegeRadius > 0 ? { ignoreZone: piece } : {}) });
  return r === BuildFail.NoPrivilege ? BuildFail.NoMovePermission : r;
}
/** Snap a move request for `piece` (its own type, tier and variant) while it is lifted. */
const snapMove = (world: World, piece: Entity, req: Pick<PlaceRequest, "x" | "y" | "level" | "rot">): Snapped | BuildFail => {
  const bp = world.get(piece, BuildPiece)!;
  return snapPlacement(world, { piece: bp.type, tier: bp.tier, variant: bp.variant, x: req.x, y: req.y, level: req.level, rot: req.rot });
};
/** ADR-318 (client preview / tests): 0 when moving `piece` to `req` would succeed. Leaves the index unchanged. */
export function validateMove(world: World, actor: Entity, piece: Entity, req: Pick<PlaceRequest, "x" | "y" | "level" | "rot">): BuildFail | 0 {
  const pre = moveBlocker(world, actor, piece); if (pre) return pre;
  return structures(world).lifted(piece, () => { const sn = snapMove(world, piece, req); return typeof sn === "number" ? sn : validateLiftedMove(world, actor, piece, sn); });
}

/**
 * ADR-318 (authority): move `piece` to `req` in one step — validated with the piece lifted, then re-slotted with its
 * entity, BuildPiece (hp, tier, paint, tint), Tribe, PieceOwner / PieceBuilder and every attachment unchanged. On any
 * failure nothing changes. No cost, no refund.
 */
export function movePiece(world: World, actor: Entity, piece: Entity, req: Pick<PlaceRequest, "x" | "y" | "level" | "rot">): BuildFail | 0 {
  const pre = moveBlocker(world, actor, piece); if (pre) return pre;
  const idx = structures(world);
  let sn: Snapped | undefined; let why: BuildFail | 0 = 0;
  idx.lifted(piece, () => { const s = snapMove(world, piece, req); if (typeof s === "number") { why = s; return; } why = validateLiftedMove(world, actor, piece, s); if (!why) sn = s; });
  if (why || !sn) return why || BuildFail.InvalidTarget;
  const s: Snapped = sn; const def = s.def;
  // commit: re-slot the same entity (removePiece keeps PieceSlot; addPiece rewrites it and bumps both chunks' versions)
  idx.removePiece(piece, true);
  world.set(piece, Transform, s.pos); world.setField(piece, BuildPiece, "rot", s.slot.rot);
  if (def.privilegeRadius > 0) invalidateZoneGrid(world);
  idx.addPiece(piece, s.slot, s.parent);
  const own = zonesAt(world, s.pos.x, s.pos.y).filter((z) => z !== piece)[0]; // the claim that now counts it (ZoneFull)
  if (own !== undefined) { idx.zoneOf.set(piece, own); idx.zoneCounts.set(own, (idx.zoneCounts.get(own) ?? 0) + 1); }
  for (const a of attachmentsOf(world, piece)) {
    if (!world.isAlive(a)) continue;
    world.set(a, Transform, s.pos);
    if (world.has(a, PieceLink)) world.set(a, PieceLink, { tx: s.slot.tx, ty: s.slot.ty, z: s.slot.z, side: s.slot.side });
  }
  if (isAuthority(world)) {
    if (world.has(piece, PieceStability)) world.setField(piece, PieceStability, "value", Math.max(0, Math.min(255, candidateStability(world, s))));
    idx.dirty.add(piece);
    if (def.surfaceHeight > 0) reseatSmallOn(world, piece); // decor already standing at the new spot moves up onto it
  }
  emit(world, PieceMoved, { piece, type: def.id, mover: actor });
  return 0;
}
