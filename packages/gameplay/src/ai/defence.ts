/**
 * ADR-338: an AI human defends its OWN claimed territory (its homestead from the base ladder, or a ruin
 * claimed under ADR-337) with barbed wire and turrets. This module is a planning layer only: it never
 * writes the world and never touches the planner (planner.ts) — the coordinator wires fillDefenceSensors
 * into buildAgentView and defenceBehaviors() into the behavior registry.
 *
 *  - Threat: a pure score over recent events near home (zombie sightings, kills the bot witnessed,
 *    livestock losses, a recent close attack). social_memory only tracks players, so attacks by
 *    zombies / losses of livestock are tracked here, in DefenceMemory on the agent identity
 *    (the same pattern as social memory: identity.defence, debounced write-through).
 *  - Choice: build only when the threat level reaches the data threshold AND the bot has surplus
 *    materials (beyond the survival ladder's needs and a per-item reserve). Wire first along the
 *    claim perimeter, then one turret of each kind, cheapest first. Low threat or a poor bot: nothing.
 *  - Placement: perimeter ring slots for wire, corner offsets around the base anchor for turrets;
 *    every candidate must pass the ghost preview (snapPlacement + validatePlacement, cost/range
 *    ignored), which enforces the bot's own claim, skill unlocks, terrain and occupancy.
 *  - Execution: one piece at a time. The behaviour walks to the stand point, withdraws any missing
 *    materials from base storage first (the same container sequence a player uses), then emits the
 *    same `build:<piece>:<x>:<y>:<level>:<rot>:<tier>` action base_work uses. It is low-priority
 *    work: it never runs while the planner has a step, while hired, or while a zombie is close.
 */
import { PlayerId, Transform, type Agent, type Entity, type World } from "@engine/core";
import { installSpatialIndex } from "@engine/world";
import { BuildPiece, Dead, PrivilegeZone, Tamed, Worker } from "../components.js";
import type { AgentWorldView, GameBehavior } from "../agents.js";
import { countItem, readSlots } from "../inventory.js";
import { pieceCost, snapPlacement, validatePlacement, zoneOwnedBy, zonesAt } from "../building/place.js";
import type { GameDefs, ItemCount, PieceDef } from "../defs.js";
import { GameplayConfig } from "../config.js";
import { agentWorld, CONTAINER_STEP, containerSeq, goTo } from "./base_behaviors.js";
import { stuckOn } from "./autonomy.js";
import { storageWithdrawActions } from "./storage_api.js";
import type { BaseState } from "./planner.js";
import raw from "../../data/ai_defence.json";

/** Tuning knobs (data/ai_defence.json); code reads them, never hardcodes them. */
export interface DefenceData {
  threatWindowTicks: number; sightWeight: number; killWeight: number; livestockWeight: number;
  recentAttackWeight: number; recentAttackTicks: number; levelThresholds: number[]; buildThreatLevel: number;
  maxWire: number; maxTurrets: number; wireRingInset: number; wireSlots: number;
  turretOrder: string[]; turretOffsets: { x: number; y: number }[];
  surplusReserve: Record<string, number>; attackRadius: number; eventCooldownTicks: number; buildCooldownTicks: number;
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
const MAX_EVENTS = 64, MAX_KILL_IDS = 64;
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
const markDefenceDirty = (a: Agent, tick: number): void => { if (!dirty.has(a)) dirty.set(a, { since: tick }); };
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

// ---------------- sensors (called from buildAgentView, after fillGoalSensors) ----------------
export interface DefenceSensors { defenceTarget?: DefenceTarget }
type DefenceView = AgentWorldView & DefenceSensors;
const lastEventTick = (events: readonly ThreatEvent[], kind: ThreatKind): number => {
  let t = -Infinity; for (const e of events) if (e.kind === kind) t = Math.max(t, e.tick); return t;
};
/**
 * Records this sense pass's threat events (zombies seen inside the claim, a zombie close to
 * the base, kills the bot witnessed near home, livestock lost since the last pass), then plans
 * one defence piece when the threat level and surplus allow. Hired workers, bots without a
 * base, and bots without their own claim get no target — defence is for one's own territory.
 */
export function fillDefenceSensors(world: World, self: Entity, view: AgentWorldView, agent: Agent): void {
  const v = view as DefenceView; const data = DEFENCE_DATA;
  const base = view.base; const tick = world.tick;
  if (!base) { delete v.defenceTarget; return; }
  if (world.isRegistered(Worker) && (world.getField(self, Worker, "owner") ?? 0) > 0) { delete v.defenceTarget; return; }
  const defs = world.getResource(GameplayConfig)?.defs; if (!defs) { delete v.defenceTarget; return; }
  const claim = ownClaim(world, self, base.x + 1, base.y + 1);
  if (!claim) { delete v.defenceTarget; return; }
  agent.bb.set("selfEntity", self); // the defence behaviour needs the entity for bag / storage reads
  const mem = defenceMemoryOf(agent);
  let zombiesNear = false, attack = false;
  for (const s of view.seen) {
    if (s.kind !== "zombie") continue;
    if (Math.hypot(s.x - claim.x, s.y - claim.y) <= claim.radius) zombiesNear = true;
    if (Math.hypot(s.x - (base.x + 1), s.y - (base.y + 1)) <= data.attackRadius) attack = true;
  }
  if (zombiesNear && tick - lastEventTick(mem.events, "sighting") >= data.eventCooldownTicks) noteDefenceEvent(agent, "sighting", tick);
  if (attack && tick - lastEventTick(mem.events, "attack") >= data.eventCooldownTicks) noteDefenceEvent(agent, "attack", tick);
  for (const p of agent.memory.items.values()) {
    if (p.kind !== "zombie" || mem.killIds.includes(p.id)) continue;
    if (Math.hypot(p.x - claim.x, p.y - claim.y) > claim.radius) continue;
    if (world.isAlive(p.id as Entity) && !world.has(p.id as Entity, Dead)) continue;
    noteDefenceEvent(agent, "kill", tick);
    mem.killIds.push(p.id); if (mem.killIds.length > MAX_KILL_IDS) mem.killIds.splice(0, mem.killIds.length - MAX_KILL_IDS);
    markDefenceDirty(agent, tick);
  }
  const pid = world.isRegistered(PlayerId) ? world.getField(self, PlayerId, "id") ?? 0 : 0;
  if (pid && world.isRegistered(Tamed)) {
    let n = 0;
    for (const e of world.query([Tamed, Transform])) {
      if (world.has(e, Dead) || world.getField(e, Tamed, "owner") !== pid) continue;
      const t = world.get(e, Transform)!;
      if (Math.hypot(t.x - claim.x, t.y - claim.y) <= claim.radius) n++;
    }
    if (n < mem.livestockSeen) for (let i = 0; i < mem.livestockSeen - n; i++) noteDefenceEvent(agent, "livestock", tick);
    if (n !== mem.livestockSeen) { mem.livestockSeen = n; markDefenceDirty(agent, tick); }
  }
  const before = mem.events.length;
  mem.events = mem.events.filter((e) => e.tick <= tick && tick - e.tick <= data.threatWindowTicks);
  if (mem.events.length !== before) markDefenceDirty(agent, tick);
  const { level } = assessThreat(mem.events, tick, data);
  if (level < data.buildThreatLevel) { delete v.defenceTarget; return; }
  const target = planDefence({ world, self, defs, base, ...(view.bs ? { bs: view.bs } : {}), threat: level, leaves: new Set(view.plan?.leaves ?? []), mem }, data);
  if (target) v.defenceTarget = target; else delete v.defenceTarget;
}

// ---------------- behaviours (registered by the coordinator, low priority) ----------------
type Ctx = Parameters<GameBehavior["run"]>[0];
const defenceTargetOf = (c: Ctx): DefenceTarget | undefined => (c.world as DefenceView).defenceTarget;
/**
 * One behaviour, build_defence: withdraw missing materials from base storage (one container
 * sequence per item), then walk to the stand point and emit the build action. It only scores
 * when a target exists, the planner has no step, the bot is not hired, and no zombie is close —
 * defence building never displaces survival needs, job work, or the saddle chain.
 */
export function defenceBehaviors(): GameBehavior[] {
  return [
    { name: "build_defence", inertia: 0.2, traits: { industriousness: 0.4 }, considerations: [
        { name: "target", weight: 0.5, curve: { type: "step", at: 0.5 }, input: (c) => (defenceTargetOf(c) ? 1 : 0) },
        { name: "planFree", weight: 1, curve: { type: "step", at: 0.5 }, input: (c) => (c.world.plan?.step ? 0 : 1) },
        { name: "ownLand", curve: { type: "step", at: 0.5 }, input: (c) => (c.world.hire ? 0 : 1) },
        { name: "calm", curve: { type: "step", at: 0.5 }, input: (c) => (c.memory.nearest("zombie", c.self.x, c.self.y, 0.3) ? 0 : 1) }],
      run: (c, o) => {
        const t = defenceTargetOf(c); if (!t) return false;
        const w = agentWorld(c); if (!w) return false;
        const defs = w.getResource(GameplayConfig)?.defs; if (!defs) return false;
        const self = c.agent.bb.get<Entity>("selfEntity"); if (!self) return false;
        const def = defs.pieces.get(t.piece); if (!def) return false;
        const cost = pieceCost(defs, def, def.fixedTier);
        const missing = cost.filter((cc) => countItem(w, self, cc.item) < cc.count);
        const sb = c.world.bs?.storage;
        if (missing.length) {
          if (!sb) { c.bb.set("defenceAt", c.self.tick); return false; } // nowhere to fetch from: cool down, don't spin
          const k = c.bb.num("defenceWithdrawIdx");
          const m = missing[Math.min(k, missing.length - 1)]!;
          if (goTo(c, o, sb.x, sb.y) > 2.2) { if (stuckOn(c, sb.x, sb.y)) { c.bb.set("defenceAt", c.self.tick); return false; } return; }
          o.moveX = 0; o.moveY = 0;
          if (containerSeq(c, o, sb.id, storageWithdrawActions(sb.id as Entity, m.item, m.count - countItem(w, self, m.item)))) {
            if (k + 1 >= missing.length) { c.bb.set("defenceWithdrawIdx", 0); c.bb.set("defenceAt", c.self.tick); return false; }
            c.bb.set("defenceWithdrawIdx", k + 1);
          }
          return;
        }
        c.bb.set("defenceWithdrawIdx", 0);
        // The last withdraw landed but its sequence never sent its cclose (missing is
        // empty now, so the storage path above no longer runs): close the panel first,
        // like a player would, instead of walking off with the box open.
        const pendingKey = c.bb.get<string>("cseqKey");
        if (sb && pendingKey?.startsWith(`${sb.id}|`) && c.bb.num("cseqStep") > 0 && c.self.tick - c.bb.num("cseqAt", -1e9) >= CONTAINER_STEP) {
          o.actions.push("cclose"); // the storage API's close is bare (copen/cwithdraw carry the id)
          c.bb.set("cseqStep", 0); c.bb.set("cseqKey", undefined); c.bb.set("cseqAt", c.self.tick);
          return false;
        }
        const d = goTo(c, o, t.stand.x, t.stand.y, 0.8);
        if (d > 0.5) { if (d >= 3 && stuckOn(c, t.stand.x, t.stand.y)) { c.bb.set("defenceAt", c.self.tick); return false; } return; }
        o.moveX = 0; o.moveY = 0; o.aimX = t.x - c.self.x; o.aimY = t.y - c.self.y;
        if (c.self.tick - c.bb.num("defenceBuildAt", -1e9) < DEFENCE_DATA.buildCooldownTicks) return;
        o.actions.push(`build:${t.piece}:${t.x}:${t.y}:${t.level}:${t.rot}:${t.tier}`);
        c.bb.set("defenceBuildAt", c.self.tick);
        const mem = defenceMemoryOf(c.agent);
        mem.fails[t.slot] = (mem.fails[t.slot] ?? 0) + 1; markDefenceDirty(c.agent, c.self.tick);
        return false;
      } },
  ];
}
