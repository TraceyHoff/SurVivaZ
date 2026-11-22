/**
 * Structural integrity (server only; PieceStability is never replicated).
 *
 * Stability is a value 0..100 on a directed support graph: ground pieces (foundations, ground furniture) are roots
 * at groundStability; every other piece takes max over its supports of (support value - loss), where loss is the
 * piece tier's vertLoss (stacked) or horizLoss (cantilevered decks), 0 for openings/furniture. Pieces below
 * minStability collapse. Plugged into BuildingGrid as stabilityRule.
 *  - additions/upgrades: incremental increase propagation (bucket queue, highest first) from the dirty pieces;
 *  - removals: the connected region around removed pieces is recomputed from its roots with a bucket-queue
 *    max-Dijkstra (values are integers 0..100, so 101 buckets), then everything under minStability collapses.
 * HP damage is batched per tick (one BuildPiece write per piece per tick) and drives damageStage.
 */
import { reseatSmallOn, smallPiecesOn } from "./surface.js";
import { spillStall } from "../economy/stall.js";
import { onPieceDamaged } from "../combat/pvp_pieces.js";
import { defineResource, Transform, type Entity, type World } from "@engine/core";
import { raidScaled } from "./modular.js";
import { Placement } from "../defs.js";
import { AttachKind, BuildPiece, Container, type DamageCause, ContainerViewers, Fuel, LootBag, PieceLink, PieceStability, StallHeader, Viewing } from "../components.js";
import { lootBagInit } from "../loot_despawn.js";
import { LootSource } from "../loot_labels.js";
import { moveSlotTuples } from "../inventory.js";
import { indexEntity } from "../spawn.js";
import { gameplayDefs, isAuthority } from "../config.js";
import { DestroyCause, emit, PieceDamaged, PieceDestroyed } from "../events.js";
import { unlinkPiece } from "./links.js";
import { structures, unmarkLinked, type StructureIndex } from "./structure.js";

const value = (w: World, e: Entity): number => w.getField(e, PieceStability, "value") ?? 0;
function lossOf(world: World, idx: StructureIndex, e: Entity, kind: number): number {
  if (kind === 0) return 0;
  const defs = gameplayDefs(world); const t = defs.tiers[world.getField(e, BuildPiece, "tier") ?? 1] ?? defs.tiers[1]!;
  void idx; return kind === 1 ? t.vertLoss : t.horizLoss;
}
/** Value implied by current support values. */
export function computeStability(world: World, idx: StructureIndex, e: Entity, scratch: [Entity, number][] = []): number {
  const { root, list } = idx.supports(e, scratch);
  if (root) return gameplayDefs(world).building.groundStability;
  let best = 0;
  for (const [s, k] of list) best = Math.max(best, value(world, s) - lossOf(world, idx, e, k));
  return Math.max(0, best);
}

/** Increase propagation from `seeds` (their values recomputed first). */
function propagateUp(world: World, idx: StructureIndex, seeds: Iterable<Entity>): void {
  const buckets: Entity[][] = Array.from({ length: 256 }, () => []); let top = 0; const sc: [Entity, number][] = []; const dep: Entity[] = [];
  const set = (e: Entity, v: number): void => { world.setField(e, PieceStability, "value", v); buckets[v]!.push(e); top = Math.max(top, v); };
  for (const e of seeds) if (world.isAlive(e) && world.has(e, PieceStability)) set(e, computeStability(world, idx, e, sc));
  for (let b = top; b >= 0; b--) {
    const q = buckets[b]!;
    while (q.length) {
      const u = q.pop()!; if (value(world, u) !== b) continue;
      for (const n of idx.dependents(u, dep).slice()) {
        if (!world.has(n, PieceStability)) continue;
        const nv = computeStability(world, idx, n, sc);
        if (nv > value(world, n)) { world.setField(n, PieceStability, "value", nv); buckets[nv]!.push(n); }
      }
    }
  }
}

/** Connected region (support + dependent edges) around `starts`, bounded by maxNodes. */
function region(idx: StructureIndex, starts: Iterable<Entity>, maxNodes = 1 << 20): Set<Entity> {
  const seen = new Set<Entity>(); const stack: Entity[] = []; const sc: [Entity, number][] = []; const dep: Entity[] = [];
  for (const s of starts) if (idx.info.has(s) && !seen.has(s)) { seen.add(s); stack.push(s); }
  while (stack.length && seen.size < maxNodes) {
    const u = stack.pop()!;
    for (const [n] of idx.supports(u, sc).list) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    for (const n of idx.dependents(u, dep)) if (!seen.has(n)) { seen.add(n); stack.push(n); }
  }
  return seen;
}

/** Full recompute of a region: zero, seed roots, bucket max-Dijkstra. Returns region members below minStability. */
export function recomputeRegion(world: World, idx: StructureIndex, nodes: Set<Entity>): Entity[] {
  const defs = gameplayDefs(world); const ground = defs.building.groundStability;
  const buckets: Entity[][] = Array.from({ length: 256 }, () => []); const sc: [Entity, number][] = []; const dep: Entity[] = [];
  for (const e of nodes) {
    if (!world.has(e, PieceStability)) continue;
    const { root } = idx.supports(e, sc);
    world.setField(e, PieceStability, "value", root ? ground : 0);
    if (root) buckets[ground]!.push(e);
  }
  for (let b = 255; b > 0; b--) {
    const q = buckets[b]!;
    while (q.length) {
      const u = q.pop()!; if (value(world, u) !== b) continue;
      for (const n of idx.dependents(u, dep).slice()) {
        if (!nodes.has(n) || !world.has(n, PieceStability)) continue;
        const nv = computeStability(world, idx, n, sc);
        if (nv > value(world, n)) { world.setField(n, PieceStability, "value", nv); buckets[nv]!.push(n); }
      }
    }
  }
  const min = defs.building.minStability; const out: Entity[] = [];
  for (const e of nodes) if (world.has(e, PieceStability) && value(world, e) < min) out.push(e);
  return out.sort((a, b) => a - b);
}

/** ADR-250: a destroyed storage attachment (plain Storage container: not a stall, till or fire) spills its items into a
 *  Dropped loot bag at the piece with the stall-spill lifetime (ADR-238 timers apply to the bag, never to the box). Server only; undefined when empty. */
export function spillStorage(world: World, att: Entity): Entity | undefined {
  if (!isAuthority(world) || world.isReplaying) return undefined;
  if (world.getField(att, PieceLink, "kind") !== AttachKind.Storage || world.has(att, StallHeader) || world.has(att, Fuel) || !world.has(att, Container)) return undefined;
  const n = world.getField(att, Container, "slotCount") ?? 0; const items = world.getArray(att, Container, "items")!; const counts = world.getArray(att, Container, "counts")!;
  const moves: { slot: number; count: number }[] = []; for (let i = 0; i < n; i++) if (items[i] && counts[i]) moves.push({ slot: i, count: counts[i]! });
  if (!moves.length) return undefined;
  const t = world.get(att, Transform)!; const bag = world.create();
  world.add(bag, Transform, { x: t.x, y: t.y, z: t.z }).add(bag, Container, { slotCount: Math.max(24, n) }).add(bag, ContainerViewers)
    .add(bag, LootBag, lootBagInit(world, 0, "stall", LootSource.Dropped));
  moveSlotTuples(world, att, bag, moves); indexEntity(world, bag); return bag;
}

/** ADR-516: the pieces destroyPiece takes down with `e` (its hosted opening — door, window, hatch — and, on an edge
 *  piece, the wall inserts mounted on it), recursively; `e` itself excluded. Same walk as destroyPiece below. */
export function attachedPieces(world: World, e: Entity, out: Entity[] = []): Entity[] {
  const idx = structures(world); if (!idx.info.has(e)) return out;
  const op = idx.opening(e); if (op && !out.includes(op)) { out.push(op); attachedPieces(world, op, out); }
  const d = idx.def(e); const s = idx.info.get(e)?.slot;
  if (d && s && d.placement === Placement.Edge && !d.features.mount) for (const m of idx.mountsOn(s.tx, s.ty, s.z, s.side)) if (!out.includes(m)) { out.push(m); attachedPieces(world, m, out); }
  return out;
}
/** ADR-517: who a demolish-caused collapse refunds (the demolisher's entity and PlayerId). */
export interface CollapseCredit { by: Entity; pid: number }
/** ADR-517: collapse refund hooks (building/collapse_refund.ts): `piece` collapses for `credit` (called while it is
 *  still intact), then `flush` once per stability pass pays what accumulated. Absent = no collapse refunds. */
export const CollapseRefundRes = defineResource<{ piece(world: World, credit: CollapseCredit, piece: Entity): void; flush(world: World): void }>("gameplay.CollapseRefund");
/**
 * Destroy a piece (server): removes attachments and the hosted opening, records neighbors for recompute.
 * ADR-517: `credit` marks a demolish (cause Demolish) or a collapse it caused (cause Collapse). The neighbours it
 * queues for the stability pass carry the credit, and a credited Collapse refunds the piece (and, through the
 * recursion, its attachments) to that player. A Demolish never refunds here: the Demolish intent already paid
 * demolishRefundAll. Damage / decay / uncredited collapses pass no credit and refund nothing.
 */
export function destroyPiece(world: World, e: Entity, cause: DestroyCause, credit?: CollapseCredit): void {
  const idx = structures(world); if (!idx.info.has(e)) return;
  if (credit && cause === DestroyCause.Collapse) world.getResource(CollapseRefundRes)?.piece(world, credit, e);
  const type = world.getField(e, BuildPiece, "type") ?? 0;
  const op = idx.opening(e); if (op) destroyPiece(world, op, cause, credit);
  { const d = idx.def(e); const s = idx.info.get(e)?.slot; if (d && s && d.placement === Placement.Edge && !d.features.mount) for (const m of idx.mountsOn(s.tx, s.ty, s.z, s.side)) destroyPiece(world, m, cause, credit); }
  const sc: [Entity, number][] = [];
  const queue = (n: Entity): void => { idx.removedNeighbors.add(n); if (credit && !idx.collapseCredit.has(n)) idx.collapseCredit.set(n, credit); };
  for (const [n] of idx.supports(e, sc).list) queue(n);
  for (const n of idx.dependents(e)) queue(n);
  for (const a of unlinkPiece(world, e)) {
    if (!world.isAlive(a)) continue;
    // close the container for viewers before it vanishes
    const vs = world.get(a, ContainerViewers);
    if (vs) for (const v of world.query([Viewing])) if (world.getField(v, Viewing, "container") === a) world.remove(v, Viewing);
    if (cause !== DestroyCause.Demolish) spillStall(world, a);
    spillStorage(world, a); // ADR-250: chest contents drop as a loot bag (demolish / pickup / raid / decay alike)
    unmarkLinked(world, a); world.destroy(a);
  }
  if ((idx.def(e)?.surfaceHeight ?? 0) > 0) for (const m of smallPiecesOn(world, e)) queue(m); // ADR-162 decor on it drops
  if ((idx.def(e)?.surfaceHeight ?? 0) > 0 && isAuthority(world)) reseatSmallOn(world, e, e);
  idx.removePiece(e); idx.removedNeighbors.delete(e); idx.collapseCredit.delete(e);
  emit(world, PieceDestroyed, { piece: e, type, cause });
  world.destroy(e);
}

/** Queue hp damage on a piece; applied once per tick by structureDamageSystem. */
/** `cause` selects the tier raid multiplier (ADR-104): melee (Combat), explosive (Explosion), fire. */
export function damagePiece(world: World, e: Entity, amount: number, attacker?: Entity, cause?: DamageCause): void {
  if (!isAuthority(world) || world.isReplaying || amount <= 0 || !world.has(e, BuildPiece)) return;
  amount = raidScaled(world, gameplayDefs(world), e, amount, attacker, cause); if (amount <= 0) return;
  const idx = structures(world); idx.pendingDamage.set(e, (idx.pendingDamage.get(e) ?? 0) + amount);
  if (attacker !== undefined && attacker !== e) pieceAttackers(world).set(e, attacker); // last attacker this tick wins
}
const attackersByWorld = new WeakMap<World, Map<Entity, Entity>>();
/** Raid attribution: last attacker per piece for the pending damage batch (0 = environment/fire/unknown). */
export function pieceAttackers(world: World): Map<Entity, Entity> { let m = attackersByWorld.get(world); if (!m) attackersByWorld.set(world, m = new Map()); return m; }
export function damageStageFor(world: World, hp: number, max: number): number {
  const st = gameplayDefs(world).building.damageStages; const f = max > 0 ? hp / max : 0;
  let s = 0; for (const t of st) if (f <= t) s++; return s;
}

export function structureDamageSystem(world: World): void {
  if (!isAuthority(world)) return;
  const idx = structures(world); if (idx.pendingDamage.size === 0) return;
  const pending = [...idx.pendingDamage].sort((a, b) => a[0] - b[0]); idx.pendingDamage.clear();
  const attackers = pieceAttackers(world); const by = new Map(attackers); attackers.clear();
  for (const [e, amount] of pending) {
    if (!world.isAlive(e)) continue;
    const attacker = by.get(e) ?? (0 as Entity);
    const bp = world.get(e, BuildPiece)!; const def = idx.def(e); if (!def) continue;
    const max = maxHpOf(world, e); const hp = Math.max(0, Math.round(bp.hp - amount));
    world.setField(e, PieceStability, "lastDamagedTick", world.tick);
    if (hp <= 0) { destroyPiece(world, e, DestroyCause.Damage); continue; }
    world.set(e, BuildPiece, { hp, damageStage: damageStageFor(world, hp, max) });
    emit(world, PieceDamaged, { piece: e, hp, amount, attacker });
    onPieceDamaged(world, e, hp, attacker);
  }
}
export function maxHpOf(world: World, e: Entity): number {
  const defs = gameplayDefs(world); const bp = world.get(e, BuildPiece); const def = bp && defs.pieces.get(bp.type); if (!bp || !def) return 0;
  return def.tiered ? Math.min(0xffff, Math.round(def.hp * (defs.tiers[bp.tier]?.hpMul ?? 1))) : Math.min(0xffff, def.hp);
}

/** Server: increases from dirty pieces; region recompute + collapse around removals (repeat until stable). */
export function stabilitySystem(world: World): void {
  if (!isAuthority(world)) return;
  const idx = structures(world);
  if (idx.dirty.size) { const d = [...idx.dirty].sort((a, b) => a - b); idx.dirty.clear(); propagateUp(world, idx, d); }
  for (let guard = 0; idx.removedNeighbors.size && guard < 64; guard++) {
    const starts = [...idx.removedNeighbors].filter((e) => world.isAlive(e)); idx.removedNeighbors.clear();
    const credits = new Map(idx.collapseCredit); idx.collapseCredit.clear();
    const nodes = region(idx, starts);
    const collapsed = recomputeRegion(world, idx, nodes);
    // ADR-517: a collapsing piece refunds the demolisher whose removal reached it, unless anything uncredited
    // (raid damage, decay, explosions) also reaches it: those collapses never mint resources.
    const owner = collapsed.length && credits.size ? collapseCredits(idx, starts, credits) : undefined;
    for (const e of collapsed) destroyPiece(world, e, DestroyCause.Collapse, owner?.get(e));
  }
  world.getResource(CollapseRefundRes)?.flush(world);
}
/** ADR-517: region member -> credit, from the credited starts' regions minus anything the uncredited starts reach. */
function collapseCredits(idx: StructureIndex, starts: readonly Entity[], credits: ReadonlyMap<Entity, CollapseCredit>): Map<Entity, CollapseCredit> {
  const plain = starts.filter((s) => !credits.has(s)); const tainted = plain.length ? region(idx, plain) : new Set<Entity>();
  const groups = new Map<number, { c: CollapseCredit; starts: Entity[] }>();
  for (const s of starts) { const c = credits.get(s); if (!c) continue; const k = c.pid || -c.by; let g = groups.get(k); if (!g) groups.set(k, (g = { c, starts: [] })); g.starts.push(s); }
  const out = new Map<Entity, CollapseCredit>();
  for (const g of [...groups.values()].sort((a, b) => a.c.pid - b.c.pid)) for (const e of region(idx, g.starts)) if (!tainted.has(e) && !out.has(e)) out.set(e, g.c);
  return out;
}

/** BuildingGrid.stabilityRule: a grid instance is stable when its piece entity meets minStability. */
export function installStabilityRule(world: World, idx: StructureIndex): void {
  const min = gameplayDefs(world).building.minStability;
  idx.grid.stabilityRule = (_g, inst) => { const e = idx.byGrid.get(inst.id); return e === undefined || !world.has(e, PieceStability) || value(world, e) >= min; };
}

