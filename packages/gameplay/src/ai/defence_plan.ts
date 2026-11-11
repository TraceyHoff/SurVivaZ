/**
 * ADR-341 follow-up: the pure defence-planning layer, split out of defence.ts so the
 * planner can import it without an import cycle. defence.ts (sensors + behaviours) imports
 * base_behaviors.ts, which imports input.ts, which imports recruitment.ts — so when
 * recruitment.ts was the ESM entry, planner.ts -> defence.ts -> base_behaviors.ts ->
 * input.ts read WORKER_COMMANDS from the still-evaluating recruitment module and threw
 * "Cannot read properties of undefined (reading 'map')" (esm_import_order test). This
 * module imports only leaf modules (core, world, components, inventory, building/*,
 * storage_api, defs, data JSON) plus a type-only BaseState, so no path from here reaches
 * input.ts. The behaviour layer (defence.ts) imports from here, never the reverse.
 *
 *  - Threat: a pure score over recent events near home (see assessThreat).
 *  - Choice: build only when the threat level reaches the data threshold AND the bot has
 *    surplus materials (beyond the survival ladder's needs and a per-item reserve).
 *  - Placement: perimeter ring slots for wire, corner offsets for turrets; every candidate
 *    passes the ghost preview (snapPlacement + validatePlacement, cost/range ignored).
 *  - Turret ammo (ADR-342): pickTurretAmmo chooses one low turret to stock next, from the
 *    bot's bag or its own / employer's base storage, only the surplus above the reserve.
 */
import { Transform, type Agent, type Entity, type World } from "@engine/core";
import { installSpatialIndex } from "@engine/world";
import { BuildPiece, Container, PrivilegeZone, Survival } from "../components.js";
import { countItem, listSlots, readSlots } from "../inventory.js";
import { attachmentsOf } from "../building/links.js";
import { pieceCost, snapPlacement, validatePlacement, zoneOwnedBy, zonesAt } from "../building/place.js";
import type { GameDefs, ItemCount, PieceDef } from "../defs.js";
import { mayTakeFromStorageAt } from "./storage_api.js";
import type { BaseState } from "./planner.js";
import raw from "../../data/ai_defence.json";

/** Tuning knobs (data/ai_defence.json); code reads them, never hardcodes them. */
export interface DefenceData {
  threatWindowTicks: number; sightWeight: number; killWeight: number; livestockWeight: number;
  recentAttackWeight: number; recentAttackTicks: number; levelThresholds: number[]; buildThreatLevel: number;
  maxWire: number; maxTurrets: number; wireRingInset: number; wireSlots: number;
  turretOrder: string[]; turretOffsets: { x: number; y: number }[];
  surplusReserve: Record<string, number>; attackRadius: number; eventCooldownTicks: number; buildCooldownTicks: number;
  /** ADR-342: turret ammo stocking — fill a turret to this many rounds, restock below this fraction of it,
   *  at most one trip per turret per cooldown, unclaimed storage only within this many tiles of home. */
  ammoTargetCount: number; ammoLowFraction: number; ammoCooldownTicks: number; ammoHomeTiles: number;
}
export const DEFENCE_DATA: DefenceData = raw as unknown as DefenceData;
/** Defence pieces in build priority order (wire first, then turrets cheapest first). */
export const DEFENCE_PIECE_KEYS: readonly string[] = ["barbed_wire", ...DEFENCE_DATA.turretOrder];
const TURRET_KEYS = new Set<string>(DEFENCE_DATA.turretOrder);
// ---------------- threat assessment (pure) ----------------
export type ThreatKind = "sighting" | "kill" | "livestock" | "attack";
export interface ThreatEvent { tick: number; kind: ThreatKind; }
/**
 * Threat level 0..levelThresholds.length from recent events (older than threatWindowTicks are
 * forgotten). Each sighting / kill / livestock loss adds its weight; a close attack adds its
 * weight once while it is recent. Level = how many thresholds the score reaches.
 */
export function assessThreat(events: readonly ThreatEvent[], tick: number, data: DefenceData = DEFENCE_DATA): { level: number; score: number } {
  let score = 0; let lastAttack = -Infinity;
  for (const e of events) {
    if (e.tick > tick || tick - e.tick > data.threatWindowTicks) continue;
    if (e.kind === "sighting") score += data.sightWeight;
    else if (e.kind === "kill") score += data.killWeight;
    else if (e.kind === "livestock") score += data.livestockWeight;
    else lastAttack = Math.max(lastAttack, e.tick);
  }
  if (tick - lastAttack <= data.recentAttackTicks) score += data.recentAttackWeight;
  return { level: data.levelThresholds.filter((t) => score >= t).length, score };
}
// ---------------- defence memory (identity.defence, like social memory) ----------------
export interface DefenceMemory {
  v: 1; events: ThreatEvent[]; livestockSeen: number; killIds: number[];
  wireIndex: number; turretIndex: number; fails: Record<string, number>;
}
type DefenceIdentity = Agent["identity"] & { defence?: unknown };
export const MAX_EVENTS = 64, MAX_KILL_IDS = 64;
/** Debounced write-through gap (ticks) for flushDefenceMemory — same 15 s as social memory. */
export const DEFENCE_WRITE_DEBOUNCE_TICKS = 300;
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const isKind = (k: unknown): k is ThreatKind => k === "sighting" || k === "kill" || k === "livestock" || k === "attack";
/** Validates whatever the store returned (old records, hand edits) into a DefenceMemory, attaching it to the identity. */
export function defenceMemoryOf(agent: Agent): DefenceMemory {
  const id = agent.identity as DefenceIdentity; const rawMem = id.defence as Partial<DefenceMemory> | undefined;
  if (rawMem && (rawMem as { __ok?: true }).__ok) return rawMem as DefenceMemory;
  const mem: DefenceMemory = {
    v: 1,
    events: Array.isArray(rawMem?.events) ? rawMem.events.filter((e) => e && typeof e.tick === "number" && isKind(e.kind)).map((e) => ({ tick: num(e.tick), kind: e.kind as ThreatKind })) : [],
    livestockSeen: num(rawMem?.livestockSeen),
    killIds: Array.isArray(rawMem?.killIds) ? rawMem.killIds.filter((n) => typeof n === "number") : [],
    wireIndex: num(rawMem?.wireIndex), turretIndex: num(rawMem?.turretIndex),
    fails: rawMem?.fails && typeof rawMem.fails === "object" ? Object.fromEntries(Object.entries(rawMem.fails).filter(([, v]) => typeof v === "number")) : {},
  };
  Object.defineProperty(mem, "__ok", { value: true, enumerable: false }); id.defence = mem; return mem;
}
const dirty = new WeakMap<Agent, { since: number }>();
export const markDefenceDirty = (a: Agent, tick: number): void => { if (!dirty.has(a)) dirty.set(a, { since: tick }); };
export const defenceMemoryDirty = (a: Agent): boolean => dirty.has(a);
/** Records one threat event (capped log; old events are pruned on the next sensor pass). */
export function noteDefenceEvent(agent: Agent, kind: ThreatKind, tick: number): void {
  const m = defenceMemoryOf(agent); m.events.push({ tick, kind });
  if (m.events.length > MAX_EVENTS) m.events.splice(0, m.events.length - MAX_EVENTS);
  markDefenceDirty(agent, tick);
}
export type DefencePut = (id: string, partial: { defence: DefenceMemory }) => unknown;
/**
 * Debounced write-through: a bot dirty for at least DEFENCE_WRITE_DEBOUNCE_TICKS is written once
 * with put(id, { defence }) (game.agents.put persists immediately). force = write every dirty bot
 * now (bot removal / shutdown). Returns the ids written.
 */
export function flushDefenceMemory(agents: Iterable<Agent>, put: DefencePut, tick: number, force = false): string[] {
  const out: string[] = [];
  for (const a of agents) {
    const d = dirty.get(a); if (!d || (!force && tick - d.since < DEFENCE_WRITE_DEBOUNCE_TICKS)) continue;
    dirty.delete(a); const m = defenceMemoryOf(a); put(a.identity.id, { defence: JSON.parse(JSON.stringify(m)) as DefenceMemory }); out.push(a.identity.id);
  }
  return out;
}
// ---------------- territory ----------------
/** The bot's own claim zone covering (cx, cy): centre = the Claim Flag, radius = its privilege radius. */
export interface OwnClaim { x: number; y: number; radius: number; zone: Entity }
export function ownClaim(world: World, self: Entity, cx: number, cy: number): OwnClaim | undefined {
  for (const z of zonesAt(world, cx, cy)) {
    if (!zoneOwnedBy(world, z, self)) continue;
    const t = world.get(z, Transform); if (!t) continue;
    const radius = world.getField(z, PrivilegeZone, "radius") ?? 0;
    if (radius > 0) return { x: t.x, y: t.y, radius, zone: z };
  }
  return undefined;
}
// ---------------- materials ----------------
/** Bag + base storage counts (what the bot can actually spend). */
export function availableMaterials(world: World, self: Entity, bs: BaseState | undefined): Map<number, number> {
  const avail = new Map<number, number>();
  const sl = readSlots(world, self);
  for (let i = 0; i < sl.items.length; i++) if (sl.items[i] && sl.counts[i]) avail.set(sl.items[i]!, (avail.get(sl.items[i]!) ?? 0) + sl.counts[i]!);
  for (const [k, v] of bs?.storage?.counts ?? []) avail.set(k, (avail.get(k) ?? 0) + v);
  return avail;
}
/**
 * Surplus: after paying `cost`, at least the data reserve of each cost item remains, and no cost
 * item is still on the survival ladder's gather list (plan.leaves) — the ladder eats first.
 */
export function hasSurplus(defs: GameDefs, avail: Map<number, number>, cost: ItemCount[], leaves: ReadonlySet<number>, data: DefenceData = DEFENCE_DATA): boolean {
  for (const c of cost) {
    if (leaves.has(c.item)) return false;
    const key = defs.items.get(c.item)?.key ?? "";
    if ((avail.get(c.item) ?? 0) < c.count + (data.surplusReserve[key] ?? 0)) return false;
  }
  return true;
}
// ---------------- counting + placement ----------------
/** Wire + turrets already standing inside the claim (any owner — a wire is a wire; the bot does not double-build). */
export function countDefences(world: World, defs: GameDefs, c: { x: number; y: number }, radius: number): { wire: number; turrets: Map<string, number> } {
  const out = { wire: 0, turrets: new Map<string, number>() };
  for (const e of installSpatialIndex(world).queryRadius(c.x, c.y, radius)) {
    if (!world.has(e, BuildPiece)) continue;
    const t = world.get(e, Transform); if (!t || Math.hypot(t.x - c.x, t.y - c.y) > radius) continue;
    const def = defs.pieces.get(world.getField(e, BuildPiece, "type")!); if (!def) continue;
    if (def.key === "barbed_wire") out.wire++;
    else if (TURRET_KEYS.has(def.key)) out.turrets.set(def.key, (out.turrets.get(def.key) ?? 0) + 1);
  }
  return out;
}
const pieceIndexes = new WeakMap<GameDefs, Map<string, PieceDef>>();
const pieceIndex = (defs: GameDefs): Map<string, PieceDef> => {
  let ix = pieceIndexes.get(defs); if (!ix) { ix = new Map(); for (const p of defs.pieces.values()) if (!ix.has(p.key)) ix.set(p.key, p); pieceIndexes.set(defs, ix); }
  return ix;
};
/** Ghost preview, like the planner's ghostOk: placement rules only (cost / range are the behaviour's job). */
const ghostOk = (world: World, self: Entity, piece: number, x: number, y: number): boolean => {
  const sn = snapPlacement(world, { piece, x, y, level: 0, rot: 0, tier: 0, variant: 0 });
  return typeof sn !== "number" && validatePlacement(world, self, sn, { ignoreCost: true, ignoreRange: true }) === 0;
};
/** Stand 1.6 tiles from the piece, toward the base centre (inside the wire ring / in build reach). */
const standNear = (ax: number, ay: number, x: number, y: number): { x: number; y: number } => {
  const dx = ax - x, dy = ay - y, d = Math.hypot(dx, dy) || 1;
  return { x: x + (dx / d) * 1.6, y: y + (dy / d) * 1.6 };
};

export interface DefenceTarget {
  piece: number; key: string; x: number; y: number; level: number; rot: number; tier: number;
  slot: string; stand: { x: number; y: number }; threat: number;
}
export interface DefencePlanInput {
  world: World; self: Entity; defs: GameDefs; base: { x: number; y: number }; bs?: BaseState;
  threat: number; leaves?: ReadonlySet<number>; mem: DefenceMemory;
}
/**
 * One defence piece to build next, or undefined (low threat, no own claim, nothing affordable
 * with surplus, nothing placeable, or fully defended). Wire along the claim perimeter first,
 * then one turret of each kind, cheapest first — a kind the bot cannot afford or place is
 * skipped for the next kind, never jumped over while affordable. The chosen slot index is
 * remembered in `mem` so the target is stable across sense passes until the piece stands.
 */
export function planDefence(p: DefencePlanInput, data: DefenceData = DEFENCE_DATA): DefenceTarget | undefined {
  const { world, self, defs, mem } = p;
  if (p.threat < data.buildThreatLevel) return undefined;
  const claim = ownClaim(world, self, p.base.x + 1, p.base.y + 1);
  if (!claim) return undefined;
  const counts = countDefences(world, defs, claim, claim.radius);
  const ix = pieceIndex(defs); const avail = availableMaterials(world, self, p.bs); const leaves = p.leaves ?? new Set<number>();
  const home = { x: p.base.x + 1, y: p.base.y + 1 };
  const tryPiece = (key: string, x: number, y: number, slot: string): DefenceTarget | undefined => {
    const def = ix.get(key); if (!def) return undefined;
    if (!hasSurplus(defs, avail, pieceCost(defs, def, def.fixedTier), leaves, data)) return undefined;
    if (!ghostOk(world, self, def.id, x, y)) return undefined;
    return { piece: def.id, key, x, y, level: 0, rot: 0, tier: def.fixedTier, slot, stand: standNear(home.x, home.y, x, y), threat: p.threat };
  };
  if (counts.wire < data.maxWire) {
    const r = claim.radius - data.wireRingInset;
    for (let k = 0; k < data.wireSlots; k++) {
      const i = (mem.wireIndex + k) % data.wireSlots; const slot = `wire${i}`;
      if ((mem.fails[slot] ?? 0) >= 4) continue;
      const a = (i / data.wireSlots) * Math.PI * 2;
      const t = tryPiece("barbed_wire", claim.x + Math.cos(a) * r, claim.y + Math.sin(a) * r, slot);
      if (t) { mem.wireIndex = i; return t; }
    }
  }
  const totalTurrets = [...counts.turrets.values()].reduce((a, b) => a + b, 0);
  if (totalTurrets < data.maxTurrets) {
    for (const key of data.turretOrder) {
      if ((counts.turrets.get(key) ?? 0) > 0) continue;
      for (let k = 0; k < data.turretOffsets.length; k++) {
        const i = (mem.turretIndex + k) % data.turretOffsets.length; const slot = `turret${i}`;
        if ((mem.fails[slot] ?? 0) >= 4) continue;
        const off = data.turretOffsets[i]!; if (!off) continue;
        const t = tryPiece(key, p.base.x + off.x, p.base.y + off.y, slot);
        if (t) { mem.turretIndex = i; return t; }
      }
    }
  }
  return undefined;
}
// ---------------- turret ammo (ADR-342) ----------------
export interface TurretAmmoTarget {
  turret: Entity; key: string; x: number; y: number;
  item: number; itemKey: string; count: number;
  /** Source storage piece (the base box) when the bag does not cover the deposit; absent = bag only. */
  box?: { id: Entity; x: number; y: number };
}

/** Ammo in a turret's storage (the piece's Storage attachment, 4 slots): per-item counts + free slots. */
export interface TurretAmmoState { count: number; byItem: Map<number, number>; freeSlots: number }
export function turretAmmoState(world: World, defs: GameDefs, piece: Entity): TurretAmmoState {
  const def = defs.pieces.get(world.getField(piece, BuildPiece, "type") ?? 0);
  const kinds = new Set((def?.features.turret?.ammo ?? []).map((k) => defs.itemId(k)));
  const out: TurretAmmoState = { count: 0, byItem: new Map(), freeSlots: 0 };
  for (const box of attachmentsOf(world, piece)) {
    if (!world.has(box, Container)) continue;
    const used = listSlots(world, box);
    out.freeSlots += Math.max(0, (world.getField(box, Container, "slotCount") ?? def?.container ?? 0) - used.length);
    for (const s of used) {
      if (!kinds.has(s.item) || s.count <= 0) continue;
      out.count += s.count; out.byItem.set(s.item, (out.byItem.get(s.item) ?? 0) + s.count);
    }
  }
  return out;
}
/** Turret pieces standing inside the claim (any owner — a turret is a turret; the bot stocks the claim's guns). */
export function turretsInClaim(world: World, defs: GameDefs, c: OwnClaim): { id: Entity; key: string; x: number; y: number }[] {
  const out: { id: Entity; key: string; x: number; y: number }[] = [];
  for (const e of installSpatialIndex(world).queryRadius(c.x, c.y, c.radius)) {
    if (!world.has(e, BuildPiece)) continue;
    const t = world.get(e, Transform); if (!t || Math.hypot(t.x - c.x, t.y - c.y) > c.radius) continue;
    const def = defs.pieces.get(world.getField(e, BuildPiece, "type")!); if (!def?.features.turret) continue;
    out.push({ id: e, key: def.key, x: t.x, y: t.y });
  }
  return out.sort((a, b) => a.id - b.id);
}

export interface TurretAmmoPickInput {
  world: World; self: Entity; defs: GameDefs; claim: OwnClaim; bs?: BaseState;
  /** The survival ladder's gather leaves (the plan's leaves): an ammo kind on them is never spent. */
  leaves?: ReadonlySet<number>; home: { x: number; y: number };
}
/**
 * One turret to stock next, or undefined (nothing low, nothing to stock it with, or no allowed
 * source). Neediest turret first (least ammo, then nearest the bot); the ammo kind is the turret's
 * first listed kind with surplus above the data reserve — never the bot's last arrows: only the
 * surplus above surplusReserve is deposited, and a kind on the ladder's gather leaves is skipped
 * for the next kind. The deposit is capped by the turret's free stack room (a kind already inside
 * tops its stack up; a new kind needs a free slot). The source is the bag, else the base storage
 * box — and only when mayTakeFromStorageAt allows it (own / clan / employer claim, or unclaimed
 * within ammoHomeTiles of home): never anyone else's box.
 */
export function pickTurretAmmo(p: TurretAmmoPickInput, data: DefenceData = DEFENCE_DATA): TurretAmmoTarget | undefined {
  const { world, self, defs } = p;
  const leaves = p.leaves ?? new Set<number>();
  const sb = p.bs?.storage;
  const box = sb && mayTakeFromStorageAt(world, self, { piece: sb.id, x: sb.x, y: sb.y }, p.home, data.ammoHomeTiles) ? sb : undefined;
  const lowAt = data.ammoTargetCount * data.ammoLowFraction;
  const sp = world.get(self, Transform);
  const cands: { t: { id: Entity; key: string; x: number; y: number }; state: TurretAmmoState; d: number }[] = [];
  for (const t of turretsInClaim(world, defs, p.claim)) {
    const state = turretAmmoState(world, defs, t.id);
    if (state.count >= lowAt) continue;
    cands.push({ t, state, d: sp ? Math.hypot(t.x - sp.x, t.y - sp.y) : 0 });
  }
  cands.sort((a, b) => a.state.count - b.state.count || a.d - b.d || a.t.id - b.t.id);
  for (const { t, state } of cands) {
    const def = defs.pieces.get(world.getField(t.id, BuildPiece, "type")!)!;
    const need = data.ammoTargetCount - state.count;
    for (const key of def.features.turret?.ammo ?? []) {
      const item = defs.itemId(key); if (!item || leaves.has(item)) continue;
      const reserve = data.surplusReserve[key] ?? 0;
      const bag = countItem(world, self, item);
      const stored = box?.counts.get(item) ?? 0;
      const surplus = bag + stored - reserve;
      if (surplus <= 0) continue;
      const have = state.byItem.get(item) ?? 0;
      const maxStack = defs.items.get(item)?.maxStack ?? 1;
      const room = have > 0 ? maxStack - have : state.freeSlots > 0 ? maxStack : 0;
      if (room <= 0) continue;
      const count = Math.min(need, surplus, room);
      if (count <= 0) continue;
      const target: TurretAmmoTarget = { turret: t.id, key: t.key, x: t.x, y: t.y, item, itemKey: key, count };
      if (bag < count && box) target.box = { id: box.id, x: box.x, y: box.y };
      return target;
    }
  }
  return undefined;
}

/** ADR-342: survival needs met for ammo stocking — the same hunger / thirst floor the ADR-327
 *  idle check uses (Survival < 30); a bot with no Survival component counts as fed. */
export function ammoNeedsMet(world: World, self: Entity): boolean {
  const sv = world.get(self, Survival);
  return !sv || (sv.hunger >= 30 && sv.thirst >= 30);
}
