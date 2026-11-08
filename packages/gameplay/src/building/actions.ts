/**
 * Building actions (authority) from PlayerIntent: Place, Upgrade, Repair, Demolish, Paint; doors (toggle, lock);
 * containers (open/close with range check + viewer tracking for net's "viewers" scope, deposit/withdraw,
 * auto-close when out of range). The client predicts none of this (only the ghost).
 */
import { Pet } from "../components.js";
import { entityIndex, Owner, Transform, type Entity, type World } from "@engine/core";
import { canLootBag } from "../combat/pvp.js";
import { isPetOwner } from "../pets.js";
import { AttachKind, BuildPiece, PieceLink, StallHeader, Container, ContainerViewers, Dead, DoorState, IntentAction, MAX_VIEWERS, PieceStability, PlayerIntent, Tribe, Viewing } from "../components.js";
import { gameplayDefs, isAuthority, rangeSlack } from "../config.js";
import { secondsToTicks } from "../defs.js";
import {
  BuildFail, BuildFailed, ContainerClosed, ContainerOpened, DestroyCause, DoorToggled, emit, PiecePainted, PieceRepaired, PieceUpgraded,
} from "../events.js";
import { addItem, countItem, exchangeItems, hasBrushInHotbar, listSlots, transferItem } from "../inventory.js";
import { makeNoise } from "../systems/noise.js";
import { clearBreach, DOOR_BREACHED } from "../combat/pvp_pieces.js";
import { distance } from "../systems/fuel.js";
import { destroyPiece, maxHpOf } from "./integrity.js";
import { isShaftHatchPiece, useShaftHatch } from "./terrain-hatch.js";
import { pieceOf, resolveAttachment } from "./links.js";
import { hasOwnClaim, hasPrivilege, pieceCost, pieceUnlocked, tribeOf, tryPlace } from "./place.js";
import { reclaimAbandonedSite } from "./abandoned.js";
import { structures } from "./structure.js";

type Fail = (reason: BuildFail) => void;

function pieceTarget(world: World, t: Entity): Entity | undefined {
  if (world.has(t, BuildPiece)) return t;
  const p = pieceOf(world, t); return p !== undefined && world.has(p, BuildPiece) ? p : undefined;
}
function inReach(world: World, e: Entity, target: Entity, reach: number): boolean {
  return distance(world, e, target) <= reach + rangeSlack(world, e);
}

export function buildActionSystem(world: World, dt: number): void {
  if (!isAuthority(world)) return;
  const defs = gameplayDefs(world); const b = defs.building; const it = world.store(PlayerIntent); const idx = structures(world);
  for (const e of world.query([PlayerIntent, Transform], [Dead])) {
    const s = it.slot(entityIndex(e)); const action = it.data.action[s]!;
    const fail: Fail = (reason) => emit(world, BuildFailed, { entity: e, action, reason });
    if (action === IntentAction.Reclaim) {
      const target = it.data.target[s]! as Entity;
      if (!world.isAlive(target)) { fail(BuildFail.InvalidTarget); continue; }
      if (!inReach(world, e, target, b.buildReach)) { fail(BuildFail.OutOfRange); continue; }
      const tf = world.get(target, Transform);
      if (tf && !hasPrivilege(world, e, tf.x, tf.y)) { fail(BuildFail.NoPrivilege); continue; }
      if (tf && !hasOwnClaim(world, e, tf.x, tf.y)) { fail(BuildFail.NeedClaim); continue; }
      const reason = reclaimAbandonedSite(world, e, target);
      if (reason) fail(reason);
      continue;
    }
    if (action < IntentAction.Place || action > IntentAction.Paint) continue;
    if (action === IntentAction.Place) {
      const r = tryPlace(world, e, { piece: it.data.piece[s]!, x: it.data.x[s]!, y: it.data.y[s]!, level: it.data.level[s]!, rot: it.data.rot[s]!, tier: it.data.tier[s]!, variant: it.data.variant[s]! });
      if (!r.ok) fail(r.reason);
      continue;
    }
    const p = pieceTarget(world, it.data.target[s]!);
    if (p === undefined) { fail(BuildFail.InvalidTarget); continue; }
    if (!inReach(world, e, p, b.buildReach)) { fail(BuildFail.OutOfRange); continue; }
    const pt = world.get(p, Transform)!;
    const bp = world.get(p, BuildPiece)!; const def = defs.pieces.get(bp.type)!;
    if (!hasPrivilege(world, e, pt.x, pt.y)) { fail(BuildFail.NoPrivilege); continue; } // ADR-207: repair too (outsiders may not touch a claimed base)
    if ((action === IntentAction.Repair || action === IntentAction.Upgrade) && !hasOwnClaim(world, e, pt.x, pt.y)) { fail(BuildFail.NeedClaim); continue; }
    switch (action) {
      case IntentAction.Upgrade: {
        const tier = it.data.tier[s]!;
        if (!def.tiered || tier <= bp.tier || tier >= defs.tiers.length) { fail(BuildFail.BadTier); continue; }
        if (!pieceUnlocked(world, e, def, tier)) { fail(BuildFail.SkillLocked); continue; } // ADR-221
        if (!exchangeItems(world, e, pieceCost(defs, def, tier), [])) { fail(BuildFail.CannotAfford); continue; }
        const oldMax = maxHpOf(world, p); world.setField(p, BuildPiece, "tier", tier); const newMax = maxHpOf(world, p);
        world.set(p, BuildPiece, { hp: Math.max(1, Math.round((bp.hp / Math.max(1, oldMax)) * newMax)) });
        idx.dirty.add(p); emit(world, PieceUpgraded, { piece: p, tier }); makeNoise(world, e, defs.noise.build);
        break;
      }
      case IntentAction.Repair: {
        if (!pieceUnlocked(world, e, def, bp.tier)) { fail(BuildFail.SkillLocked); continue; } // ADR-310
        const max = maxHpOf(world, p); if (bp.hp >= max) { fail(BuildFail.NothingToRepair); continue; }
        const last = world.getField(p, PieceStability, "lastDamagedTick") ?? 0;
        if (last > 0 && world.tick < last + secondsToTicks(b.repairBlockedSeconds, dt)) { fail(BuildFail.RepairBlocked); continue; }
        const missing = 1 - bp.hp / max; const mul = defs.tiers[bp.tier]?.repairMul ?? 0.3;
        if (!exchangeItems(world, e, pieceCost(defs, def, bp.tier, mul * missing), [])) { fail(BuildFail.CannotAfford); continue; }
        world.set(p, BuildPiece, { hp: max, damageStage: 0 }); emit(world, PieceRepaired, { piece: p, hp: max }); clearBreach(world, p);
        break;
      }
      case IntentAction.Demolish: {
        const owner = world.getField(p, Tribe, "id") ?? 0;
        if (owner !== 0 && owner !== tribeOf(world, e)) { fail(BuildFail.NoPrivilege); continue; }
        const frac = bp.hp / Math.max(1, maxHpOf(world, p));
        for (const c of pieceCost(defs, def, bp.tier)) { const n = Math.floor(c.count * (def.pickup ? 1 : b.demolishRefund) * frac); /* ADR-250: pickup = full refund */ if (n > 0) addItem(world, e, c.item, n); }
        destroyPiece(world, p, DestroyCause.Demolish);
        break;
      }
      case IntentAction.Paint: {
        if (!def.paintable && !def.tiered) { fail(BuildFail.NotPaintable); continue; }
        const paint = it.data.paint[s]!; const dye = defs.itemId("dye");
        // Task 25: dyeing a piece needs the paint brush in the hotbar (clearing paint back to 0 is free).
        if (paint !== 0 && !hasBrushInHotbar(world, e)) { fail(BuildFail.NoBrush); continue; }
        if (paint !== 0 && !exchangeItems(world, e, [{ item: dye, count: 1 }], [])) { fail(BuildFail.CannotAfford); continue; }
        world.setField(p, BuildPiece, "paint", paint); emit(world, PiecePainted, { piece: p, paint });
        break;
      }
    }
  }
}

/** Doors: toggle (anyone, unless locked to another tribe) and lock/unlock (privileged tribe members). */
export function doorSystem(world: World): void {
  if (!isAuthority(world)) return;
  const defs = gameplayDefs(world); const it = world.store(PlayerIntent); const idx = structures(world);
  for (const e of world.query([PlayerIntent, Transform], [Dead])) {
    const s = it.slot(entityIndex(e)); const action = it.data.action[s]!;
    if (action !== IntentAction.ToggleDoor && action !== IntentAction.LockDoor) continue;
    const fail: Fail = (reason) => emit(world, BuildFailed, { entity: e, action, reason });
    const target = it.data.target[s]!;
    if (action === IntentAction.ToggleDoor && isShaftHatchPiece(world, target)) {
      if (!inReach(world, e, target, defs.building.buildReach)) { fail(BuildFail.OutOfRange); continue; }
      useShaftHatch(world, e, target);
      continue;
    }
    const d = resolveAttachment(world, target, AttachKind.Door);
    if (d === undefined) { fail(BuildFail.InvalidTarget); continue; }
    if (!inReach(world, e, d, defs.building.buildReach)) { fail(BuildFail.OutOfRange); continue; }
    const st = world.get(d, DoorState)!; const tribe = tribeOf(world, e);
    if (st.lockTribe !== 0 && st.lockTribe !== tribe) { fail(BuildFail.Locked); continue; }
    if (st.open === DOOR_BREACHED) { fail(BuildFail.Locked); continue; } // breached gates stay open until repaired
    if (action === IntentAction.LockDoor) {
      if (tribe === 0) { fail(BuildFail.NoPrivilege); continue; }
      world.setField(d, DoorState, "lockTribe", st.lockTribe ? 0 : tribe); continue;
    }
    world.setField(d, DoorState, "open", st.open ? 0 : 1); idx.version++;
    emit(world, DoorToggled, { door: d, open: st.open ? 0 : 1 }); makeNoise(world, e, defs.noise.door);
  }
}
/** Door open lookup for pathing/enclosure (door piece -> its DoorState attachment). */
export function installDoorLookup(world: World): void {
  structures(world).doorOpen = (door) => { const a = resolveAttachment(world, door, AttachKind.Door); return a !== undefined && world.getField(a, DoorState, "open") === 1; };
}

const clientOf = (world: World, e: Entity): number => world.getField(e, Owner, "clientId") ?? 0;
export function addViewer(world: World, c: Entity, client: number): boolean {
  const st = world.store(ContainerViewers); const s = st.slot(entityIndex(c)); if (s < 0) return false;
  const n = st.data.count[s]!; const a = st.data.clients;
  for (let i = 0; i < n; i++) if (a[s * MAX_VIEWERS + i] === client) return true;
  if (n >= Math.min(MAX_VIEWERS, gameplayDefs(world).building.maxContainerViewers)) return false;
  a[s * MAX_VIEWERS + n] = client; st.data.count[s] = n + 1; st.markChanged(entityIndex(c)); return true;
}
export function removeViewer(world: World, c: Entity, client: number): void {
  const st = world.store(ContainerViewers); const s = st.slot(entityIndex(c)); if (s < 0) return;
  const n = st.data.count[s]!; const a = st.data.clients;
  for (let i = 0; i < n; i++) if (a[s * MAX_VIEWERS + i] === client) { a[s * MAX_VIEWERS + i] = a[s * MAX_VIEWERS + n - 1]!; a[s * MAX_VIEWERS + n - 1] = 0; st.data.count[s] = n - 1; st.markChanged(entityIndex(c)); return; }
}
export function closeContainer(world: World, e: Entity): void {
  const c = world.getField(e, Viewing, "container"); if (c === undefined) return;
  world.remove(e, Viewing);
  if (world.isAlive(c)) removeViewer(world, c, clientOf(world, e));
  emit(world, ContainerClosed, { container: c, entity: e, clientId: clientOf(world, e) });
}
/** Clients currently viewing a container (net reads this via containerViewersScope). */
export function viewersOf(world: World, c: Entity): number[] {
  const st = world.store(ContainerViewers); const s = st.slot(entityIndex(c)); if (s < 0) return [];
  return Array.from(st.data.clients.subarray(s * MAX_VIEWERS, s * MAX_VIEWERS + st.data.count[s]!));
}

/**
 * ADR-207: storage attached to a building piece that stands inside a privilege zone (claim totem) opens only for that
 * zone's tribe, i.e. the owning clan's base-rank members. Unclaimed storage, loot bags and pets keep their own rules;
 * raiders must destroy the claim first (same rule as building there).
 */
export function canUseBaseStorage(world: World, e: Entity, c: Entity): boolean {
  if (world.has(c, StallHeader) || world.getField(c, PieceLink, "kind") === AttachKind.Till) return true; // stalls: economy rules
  const p = pieceOf(world, c); if (p === undefined) return true;
  const t = world.get(p, Transform); return !t || hasPrivilege(world, e, t.x, t.y);
}

export function containerSystem(world: World): void {
  if (!isAuthority(world)) return;
  const b = gameplayDefs(world).building; const it = world.store(PlayerIntent);
  for (const e of world.query([PlayerIntent, Transform], [Dead])) {
    const s = it.slot(entityIndex(e)); const action = it.data.action[s]!;
    if (action < IntentAction.OpenContainer || action > IntentAction.Withdraw) continue;
    const fail: Fail = (reason) => emit(world, BuildFailed, { entity: e, action, reason });
    if (action === IntentAction.CloseContainer) { closeContainer(world, e); continue; }
    const c = resolveAttachment(world, it.data.target[s]!, AttachKind.Storage);
    if (c === undefined || !world.has(c, Container)) { fail(BuildFail.InvalidTarget); continue; }
    if (!inReach(world, e, c, b.containerReach)) { fail(BuildFail.OutOfRange); continue; }
    if (action === IntentAction.OpenContainer) {
      if (!canLootBag(world, e, c)) { fail(BuildFail.Locked); continue; }
      if (world.has(c, Pet) && !isPetOwner(world, e, c)) { fail(BuildFail.Locked); continue; } // ADR-145 pet inventory: owner only
      if (!canUseBaseStorage(world, e, c)) { fail(BuildFail.Locked); continue; } // ADR-207: base storage inside a claim = its tribe (clan) only
      if (world.getField(e, Viewing, "container") === c) continue;
      closeContainer(world, e);
      if (!addViewer(world, c, clientOf(world, e))) { fail(BuildFail.ViewersFull); continue; }
      world.add(e, Viewing, { container: c }); emit(world, ContainerOpened, { container: c, entity: e, clientId: clientOf(world, e) });
      continue;
    }
    if (world.getField(e, Viewing, "container") !== c) { fail(BuildFail.NotViewing); continue; }
    // stall stock and tills move only through the economy commands (stock/unstock/buy/collect)
    if (world.has(c, StallHeader) || world.getField(c, PieceLink, "kind") === AttachKind.Till) { fail(BuildFail.Locked); continue; }
    const item = it.data.item[s]!; const count = it.data.count[s]!;
    if (action === IntentAction.Deposit) { if (transferItem(world, e, c, item, count) === 0) fail(countItem(world, e, item) ? BuildFail.Occupied : BuildFail.CannotAfford); }
    else if (item === 0) { // ADR-160 "Take all": item 0 withdraws every stack that fits
      let moved = 0; for (const sl of listSlots(world, c)) if (sl.item && sl.count) moved += transferItem(world, c, e, sl.item, sl.count);
      if (moved === 0) fail(BuildFail.CannotAfford);
    } else if (transferItem(world, c, e, item, count) === 0) fail(BuildFail.CannotAfford);
  }
  // auto-close: out of range (1.5x reach), dead, or container gone
  for (const e of world.query([Viewing])) {
    const c = world.getField(e, Viewing, "container")!;
    if (!world.isAlive(c) || world.has(e, Dead) || distance(world, e, c) > b.containerReach * 1.5 || !canUseBaseStorage(world, e, c)) closeContainer(world, e); // ADR-207: kicked / left clan → closes
  }
}
