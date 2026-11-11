/**
 * ADR-338: an AI human defends its OWN claimed territory (its homestead from the base ladder, or a ruin
 * claimed under ADR-337) with barbed wire and turrets. Sensors + behaviours only: the pure planning
 * layer (threat, memory, planDefence, turret ammo picking) lives in defence_plan.ts, which the
 * planner imports directly — defence.ts must never be imported by planner.ts (import cycle:
 * planner -> defence -> base_behaviors -> input -> recruitment, see defence_plan.ts header).
 * ADR-341: the target is now owned by the planner (makePlan's `defence` goal calls planDefence) —
 * the sensor below only records threat events and translates the planner's defence step back into
 * view.defenceTarget for the build_defence behaviour, so a threatened bot never plans two
 * defences. The coordinator wires fillDefenceSensors into buildAgentView and defenceBehaviors()
 * into the behavior registry.
 *
 *  - Execution: one piece at a time. The behaviour walks to the stand point, withdraws any missing
 *    materials from base storage first (the same container sequence a player uses), then emits the
 *    same `build:<piece>:<x>:<y>:<level>:<rot>:<tier>` action base_work uses. It is low-priority
 *    work: it never runs while the planner has a step other than its own defence step, while hired,
 *    or while a zombie is close.
 *  - ADR-342: turret ammo stocking (stock_turret). A turret below ammoLowFraction of ammoTargetCount
 *    rounds is topped up from the bot's bag or its own / employer's base storage (mayTakeFromStorageAt:
 *    own / clan / employer claim, or unclaimed within ammoHomeTiles of home), depositing only the
 *    surplus above the per-kind surplusReserve. One trip per turret, ammoCooldownTicks between trips;
 *    never while a survival need is unmet, never while the planner wants anything (a step, a gather
 *    leaf or a hunt target), and for a hired worker only while hire.idle. Hired workers stock the
 *    employer's turrets; they still build none.
 */
import { PlayerId, Transform, type Agent, type Entity, type World } from "@engine/core";
import { AttachKind, BuildPiece, Dead, Tamed, Worker } from "../components.js";
import type { AgentWorldView, GameBehavior } from "../agents.js";
import { countItem } from "../inventory.js";
import { resolveAttachment } from "../building/links.js";
import { pieceCost } from "../building/place.js";
import { GameplayConfig } from "../config.js";
import { agentWorld, CONTAINER_STEP, containerSeq, goTo } from "./base_behaviors.js";
import { stuckOn } from "./autonomy.js";
import { mayTakeFromStorageAt, storageDepositActions, storageWithdrawActions } from "./storage_api.js";
import {
  ammoNeedsMet, assessThreat, DEFENCE_DATA, defenceMemoryOf, markDefenceDirty, MAX_KILL_IDS,
  noteDefenceEvent, ownClaim, pickTurretAmmo, turretAmmoState,
} from "./defence_plan.js";
import type { DefenceData, DefenceTarget, ThreatEvent, ThreatKind, TurretAmmoTarget } from "./defence_plan.js";
/** Re-exported so existing `import * as D from defence.js` users (tests, index.ts) keep working. */
export {
  ammoNeedsMet, assessThreat, availableMaterials, countDefences, DEFENCE_DATA, DEFENCE_PIECE_KEYS,
  DEFENCE_WRITE_DEBOUNCE_TICKS, defenceMemoryOf, defenceMemoryDirty, flushDefenceMemory, hasSurplus,
  noteDefenceEvent, ownClaim, pickTurretAmmo, planDefence, turretAmmoState, turretsInClaim,
} from "./defence_plan.js";
export type {
  DefenceData, DefenceMemory, DefencePlanInput, DefencePut, DefenceTarget, OwnClaim, ThreatEvent,
  ThreatKind, TurretAmmoPickInput, TurretAmmoState, TurretAmmoTarget,
} from "./defence_plan.js";
export interface TurretAmmoSensors { turretAmmoTarget?: TurretAmmoTarget }

// ---------------- sensors (called from buildAgentView, after fillGoalSensors) ----------------
export interface DefenceSensors { defenceTarget?: DefenceTarget; turretAmmoTarget?: TurretAmmoTarget }
type DefenceView = AgentWorldView & DefenceSensors;
const lastEventTick = (events: readonly ThreatEvent[], kind: ThreatKind): number => {
  let t = -Infinity; for (const e of events) if (e.kind === kind) t = Math.max(t, e.tick); return t;
};
/**
 * The turret-ammo sensor: one low turret to stock, or nothing. Low-priority maintenance, gated
 * like the ADR-338 surplus discipline — only with surplus (pickTurretAmmo), never while a survival
 * need is unmet, never while the planner wants anything (any step, gather leaf or hunt target:
 * stocking is below the whole ladder — the same "work pending" shape as ADR-327's idle check),
 * and for a hired worker only while hire.idle (no pending job work, needs met — the flag
 * fillHireSensors sets). One trip per turret: after a trip the behaviour cools down for
 * ammoCooldownTicks. Own turrets and the employer's alike; the claim check (ownClaim /
 * zoneOwnedBy) covers the employer's claim. The target earmarks its ammo: the kind joins
 * plan.keep and leaves view.surplus, so the bot neither junk-drops nor stashes the rounds it is
 * about to load.
 */
export function fillTurretAmmoSensor(world: World, self: Entity, view: AgentWorldView, agent: Agent, data: DefenceData = DEFENCE_DATA): void {
  const v = view as AgentWorldView & TurretAmmoSensors;
  const clear = (): void => { delete v.turretAmmoTarget; };
  const base = view.base ?? view.ruinBase;
  if (!base) return clear();
  const hired = world.isRegistered(Worker) && (world.getField(self, Worker, "owner") ?? 0) > 0;
  if (hired && view.hire?.idle !== true) return clear();
  if (view.plan?.step || view.plan?.leaves.length || view.plan?.hunt.length) return clear();
  if (!ammoNeedsMet(world, self)) return clear();
  if (world.tick - agent.bb.num("ammoAt", -1e9) < data.ammoCooldownTicks) return clear();
  const defs = world.getResource(GameplayConfig)?.defs; if (!defs) return clear();
  const claim = ownClaim(world, self, base.x + 1, base.y + 1); if (!claim) return clear();
  const t = pickTurretAmmo({ world, self, defs, claim, ...(view.bs ? { bs: view.bs } : {}), leaves: new Set(view.plan?.leaves ?? []), home: { x: base.x + 1, y: base.y + 1 } }, data);
  if (!t) return clear();
  v.turretAmmoTarget = t;
  view.plan?.keep.add(t.item);
  if (v.surplus) { const rest = v.surplus.filter((s) => s.item !== t.item); if (rest.length) v.surplus = rest; else delete v.surplus; }
}

/**
 * Records this sense pass's threat events (zombies seen inside the claim, a zombie close to
 * the base, kills the bot witnessed near home, livestock lost since the last pass), then
 * translates the planner's defence step (ADR-341: makePlan owns the target now) into the
 * DefenceTarget build_defence executes. The sensor never calls planDefence itself: a
 * threatened bot must not plan a second defence beside the planner's. Hired workers, bots
 * without a base, and bots without their own claim get no target — defence is for one's own
 * territory. A ruin home (view.ruinBase, ADR-340) defends its claim like a built base.
 * Hired workers fortify nobody's land, but they DO stock the employer's turrets (ADR-342):
 * the hired branch skips only the threat events and the build target, and the ammo sensor
 * below still runs for them.
 */
export function fillDefenceSensors(world: World, self: Entity, view: AgentWorldView, agent: Agent): void {
  const v = view as DefenceView; const data = DEFENCE_DATA;
  const base = view.base ?? view.ruinBase; const tick = world.tick;
  if (!base) { delete v.defenceTarget; delete v.turretAmmoTarget; return; }
  const defs = world.getResource(GameplayConfig)?.defs; if (!defs) { delete v.defenceTarget; delete v.turretAmmoTarget; return; }
  const claim = ownClaim(world, self, base.x + 1, base.y + 1);
  if (!claim) { delete v.defenceTarget; delete v.turretAmmoTarget; return; }
  agent.bb.set("selfEntity", self); // the defence behaviour needs the entity for bag / storage reads
  if (world.isRegistered(Worker) && (world.getField(self, Worker, "owner") ?? 0) > 0) {
    delete v.defenceTarget;
    // ADR-342: hired workers fortify nobody's land, but they still stock the employer's turrets.
    fillTurretAmmoSensor(world, self, view, agent, data);
    return;
  }
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
  // ADR-341: the planner owns the target — translate its defence step into the behaviour's
  // target (same piece / slot / stand), or clear it when the plan is doing anything else.
  // A stale target must never outlive the plan that produced it.
  const plan = view.plan;
  if (plan?.goal === "defence" && plan.step?.k === "build") {
    const s = plan.step; const def = defs.pieces.get(s.piece);
    if (def) v.defenceTarget = { piece: s.piece, key: def.key, x: s.x, y: s.y, level: s.level, rot: s.rot ?? 0, tier: s.tier ?? 0, slot: s.slot, stand: s.stand, threat: level };
    else delete v.defenceTarget;
  } else delete v.defenceTarget;
  // ADR-342: turret ammo stocking (own turrets alike) — the sensor gates on surplus, needs,
  // a free planner and (for hired workers) hire.idle.
  fillTurretAmmoSensor(world, self, view, agent, data);
}

// ---------------- behaviours (registered by the coordinator, low priority) ----------------
type Ctx = Parameters<GameBehavior["run"]>[0];
const defenceTargetOf = (c: Ctx): DefenceTarget | undefined => (c.world as DefenceView).defenceTarget;
const turretAmmoTargetOf = (c: Ctx): TurretAmmoTarget | undefined => (c.world as DefenceView).turretAmmoTarget;
/**
 * One behaviour, build_defence: withdraw missing materials from base storage (one container
 * sequence per item), then walk to the stand point and emit the build action. It only scores
 * when a target exists, the planner has no step other than its own defence step (ADR-341: the
 * planner owns the target now, so a defence plan is this behaviour's green light, not a
 * conflict), the bot is not hired, and no zombie is close — defence building never displaces
 * survival needs, job work, or the saddle chain.
 */
export function defenceBehaviors(): GameBehavior[] {
  return [
    { name: "build_defence", inertia: 0.2, traits: { industriousness: 0.4 }, considerations: [
        { name: "target", weight: 0.5, curve: { type: "step", at: 0.5 }, input: (c) => (defenceTargetOf(c) ? 1 : 0) },
        { name: "planFree", weight: 1, curve: { type: "step", at: 0.5 }, input: (c) => (c.world.plan?.step && c.world.plan.goal !== "defence" ? 0 : 1) },
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
    { name: "stock_turret", inertia: 0.2, traits: { industriousness: 0.4 }, considerations: [
        { name: "target", weight: 0.5, curve: { type: "step", at: 0.5 }, input: (c) => (turretAmmoTargetOf(c) ? 1 : 0) },
        { name: "planFree", weight: 1, curve: { type: "step", at: 0.5 }, input: (c) => { const p = c.world.plan; return p && (p.step || p.leaves.length || p.hunt.length) ? 0 : 1; } },
        { name: "needs", weight: 1, curve: { type: "step", at: 0.5 }, input: (c) => (c.self.hunger >= 0.3 && c.self.thirst >= 0.3 ? 1 : 0) },
        { name: "hireIdle", weight: 1, curve: { type: "step", at: 0.5 }, input: (c) => (c.world.hire && c.world.hire.idle !== true ? 0 : 1) },
        { name: "calm", curve: { type: "step", at: 0.5 }, input: (c) => (c.memory.nearest("zombie", c.self.x, c.self.y, 0.3) ? 0 : 1) }],
      run: (c, o) => {
        const t = turretAmmoTargetOf(c); if (!t) return false;
        const w = agentWorld(c); if (!w) return false;
        const defs = w.getResource(GameplayConfig)?.defs; if (!defs) return false;
        const self = c.agent.bb.get<Entity>("selfEntity"); if (!self) return false;
        const turret = t.turret as Entity;
        const cool = (): false => { c.bb.set("ammoAt", c.self.tick); return false; };
        if (!w.isAlive(turret) || !w.has(turret, BuildPiece)) return cool(); // gone: cool down, don't spin
        // A deposit sequence already open on this turret finishes even though the turret now reads
        // full (the deposit landed when cdeposit went out — the need check below would bail before
        // cclose). A sequence open on another turret is closed first; its panel is stale.
        const inFlight = c.bb.get<{ turret: number; item: number; count: number }>("ammoSeq");
        if (inFlight) {
          if (inFlight.turret !== turret) {
            o.actions.push("cclose"); c.bb.set("ammoSeq", undefined);
            c.bb.set("cseqStep", 0); c.bb.set("cseqKey", undefined); c.bb.set("cseqAt", c.self.tick);
            return false;
          }
          if (goTo(c, o, t.x, t.y) > 2.2) { if (stuckOn(c, t.x, t.y)) return cool(); return; }
          o.moveX = 0; o.moveY = 0;
          if (containerSeq(c, o, turret, storageDepositActions(turret, inFlight.item, inFlight.count))) { c.bb.set("ammoSeq", undefined); c.bb.set("ammoAt", c.self.tick); return false; }
          return;
        }
        const cur = turretAmmoState(w, defs, turret);
        const need = Math.min(t.count, DEFENCE_DATA.ammoTargetCount - cur.count);
        if (need <= 0) return false; // already stocked (the sensor clears the target next pass)
        const bag = countItem(w, self, t.item);
        if (bag < need) {
          // Withdraw the shortfall from the source box first (the same container sequence a player
          // uses). The sensor pinned the box; if the bag was spent since (a stash beat us to it),
          // fall back to the base box live — still only when the storage rule allows it.
          let box = t.box;
          if (!box) {
            const home = c.world.base ?? c.world.ruinBase;
            const sb = c.world.bs?.storage;
            if (home && sb && mayTakeFromStorageAt(w, self, { piece: sb.id, x: sb.x, y: sb.y }, { x: home.x + 1, y: home.y + 1 }, DEFENCE_DATA.ammoHomeTiles)) box = { id: sb.id, x: sb.x, y: sb.y };
          }
          if (!box) return cool(); // nowhere to fetch from: cool down, don't spin
          const att = resolveAttachment(w, box.id as Entity, AttachKind.Storage);
          const stored = att !== undefined ? countItem(w, att, t.item) : 0;
          if (stored <= 0) return cool(); // nothing to fetch: cool down, don't loop
          if (goTo(c, o, box.x, box.y) > 2.2) { if (stuckOn(c, box.x, box.y)) return cool(); return; }
          o.moveX = 0; o.moveY = 0;
          if (containerSeq(c, o, box.id, storageWithdrawActions(box.id as Entity, t.item, Math.min(need - bag, stored)))) return false;
          return;
        }
        // The last withdraw landed but its sequence never sent its cclose (the bag filled first, so the
        // withdraw phase no longer runs): close the panel first, like a player would — the same edge
        // build_defence closes for its materials.
        const pendingKey = c.bb.get<string>("cseqKey");
        if (t.box && pendingKey?.startsWith(`${t.box.id}|`) && c.bb.num("cseqStep") > 0 && c.self.tick - c.bb.num("cseqAt", -1e9) >= CONTAINER_STEP) {
          o.actions.push("cclose"); // the storage API's close is bare (copen/cwithdraw carry the id)
          c.bb.set("cseqStep", 0); c.bb.set("cseqKey", undefined); c.bb.set("cseqAt", c.self.tick);
          return false;
        }
        if (goTo(c, o, t.x, t.y) > 2.2) { if (stuckOn(c, t.x, t.y)) return cool(); return; }
        o.moveX = 0; o.moveY = 0;
        const n = Math.min(need, bag);
        if (containerSeq(c, o, turret, storageDepositActions(turret, t.item, n))) { c.bb.set("ammoAt", c.self.tick); return false; }
        c.bb.set("ammoSeq", { turret: t.turret, item: t.item, count: n });
      } },
  ];
}
