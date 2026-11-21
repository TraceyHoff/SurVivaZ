/**
 * Bot clan behaviors (pure: read the bot's replica — ClanStatus, ClanInvitePending, StallHeader — and write AgentOutput
 * action strings that emitAgentCommands turns into gameplay.clan* / stockStall commands; humans use the same commands).
 * Traits drive it: founding = sociability + max(industriousness, greed); recruiting = sociability; leaders promote active
 * contributors, kick long-idle members, open stocking to members, and pick goals (base -> stock stalls, defend on threats,
 * raid when brave + greedy); members walk to the goal and stock clan stalls. Every decision has a cooldown.
 */
import { Membership, PlayerId, StallDisplay, Transform, entityIndex, type Entity, type Traits, type World } from "@engine/core";
import { trustOf } from "./social_memory.js";
import type { AgentWorldView, GameBehavior } from "../agents.js";
import { BuildPiece, ClanInvitePending, ClanStatus, Health, StallHeader, StallOwnerKind } from "../components.js";
import { ClanGoal, clanPermBit } from "../clan_state.js";
import { gameplayDefs } from "../config.js";
import { maxHpOf } from "../building/integrity.js";
import { listSlots } from "../inventory.js";
import en from "../../data/locale/en.json";

export interface ClanMember { id: number; role: number; contrib: number }
export interface ClanStock { stall: number; x: number; y: number; listing: number; invSlot: number; count: number }
export interface ClanSensors {
  clan?: { id: number; role: number; goal: number; goalX: number; goalY: number; contrib: number };
  clanInvite?: { clan: number; from: number; expiresTick: number };
  /** Visible players / bots without a clan (recruits). */
  clanless?: { id: number; x: number; y: number }[];
  /** Visible clanmates (not self). */
  clanMembers?: ClanMember[];
  /** Nearest own-clan stall with a listing this bot can stock from its inventory. */
  clanStock?: ClanStock;
  /** Nearest visible stall owned by someone else (raid target). */
  rivalStall?: { id: number; x: number; y: number };
  /**
   * ADR-497: the rival base's weakest wall piece — the probe target. The weakest by HP fraction
   * (ties break toward the lowest max HP, so a wall_low beats a full-HP wall); doorways count
   * (a door is a legitimate weak spot). Set by fillClanSensors, cached at the homeScan cadence.
   */
  rivalWeakWall?: { id: number; x: number; y: number; hpFrac: number } | undefined;
}
export const CLAN_AI = {
  foundScore: 0.72, foundCooldown: 20 * 300, recruitCooldown: 20 * 60, recruitRange: 10, minRecruitSociability: 0.5,
  decideDelay: 20 * 2, manageCooldown: 20 * 30, promoteContrib: 20, kickIdleTicks: 20 * 600, goalCooldown: 20 * 120,
  threatZombies: 2, raidTrait: 0.7, goalRadius: 4, stockRange: 2.5, stallRange: 14,
  /** ADR-497: probe tuning — the wall scan covers a base-footprint radius around the rival stall (or the raid goal), refreshed at the homeScan cadence. */
  probeRadius: 20, probeEvery: 30,
};

/**
 * ADR-497: the weakest wall piece within probeRadius of a centre (the rival stall, or the clan's
 * raid goal). The homeScan pattern: one alloc-free pass over build pieces, shared per centre for
 * probeEvery ticks (a destroyed wall invalidates its entry at once, so a breach re-picks the
 * next-weakest within one sensor refresh). Weakest by HP fraction; ties break toward the lowest
 * max HP, so a wall_low beats a full-HP wall. Doorways count (family "wall" covers wall,
 * wall_low, wall_window and wall_doorway).
 */
const weakWallScans = new WeakMap<World, Map<string, { tick: number; wall?: { id: number; x: number; y: number; hpFrac: number } }>>();
export function weakestWallNear(world: World, cx: number, cy: number): { id: number; x: number; y: number; hpFrac: number } | undefined {
  let m = weakWallScans.get(world); if (!m) weakWallScans.set(world, (m = new Map()));
  const key = `${Math.round(cx)},${Math.round(cy)}`; const c = m.get(key);
  if (c && world.tick - c.tick < CLAN_AI.probeEvery && world.tick >= c.tick && (c.wall === undefined || world.isAlive(c.wall.id))) return c.wall;
  const defs = gameplayDefs(world);
  const tf = world.store(Transform);
  const r: { tick: number; wall?: { id: number; x: number; y: number; hpFrac: number } } = { tick: world.tick };
  let bestFrac = Infinity, bestMax = Infinity;
  const r2 = CLAN_AI.probeRadius * CLAN_AI.probeRadius;
  for (const e of world.query([BuildPiece, Transform])) {
    const ts = tf.slot(entityIndex(e)); const dx = tf.data.x[ts]! - cx, dy = tf.data.y[ts]! - cy, d2 = dx * dx + dy * dy; if (d2 > r2) continue;
    const type = world.getField(e, BuildPiece, "type")!;
    const def = defs.pieces.get(type); if (!def || def.family !== "wall") continue;
    const hp = world.getField(e, BuildPiece, "hp")!; const max = maxHpOf(world, e);
    const frac = max > 0 ? hp / max : 1;
    if (frac < bestFrac - 1e-9 || (Math.abs(frac - bestFrac) <= 1e-9 && max < bestMax)) {
      bestFrac = frac; bestMax = max; r.wall = { id: e, x: tf.data.x[ts]!, y: tf.data.y[ts]!, hpFrac: frac };
    }
  }
  if (m.size > 256) m.clear(); m.set(key, r); return r.wall;
}

export function fillClanSensors(world: World, self: Entity, view: AgentWorldView): void {
  const t = world.get(self, Transform); if (!t) return;
  const st = world.has(self, ClanStatus) ? world.get(self, ClanStatus)! : undefined;
  const clan = st?.clan ?? world.getField(self, Membership, "clanId") ?? 0;
  if (clan && st) view.clan = { id: clan, role: st.role, goal: st.goal, goalX: st.goalX, goalY: st.goalY, contrib: st.contrib };
  const inv = world.has(self, ClanInvitePending) ? world.get(self, ClanInvitePending) : undefined;
  if (inv && inv.clan && inv.expiresTick > world.tick) view.clanInvite = { clan: inv.clan, from: inv.from, expiresTick: inv.expiresTick };
  const less: { id: number; x: number; y: number }[] = [], mates: ClanMember[] = [];
  for (const e of world.query([PlayerId, Transform, Health])) {
    if (e === self) continue; const c = world.has(e, ClanStatus) ? world.getField(e, ClanStatus, "clan")! : world.getField(e, Membership, "clanId") ?? 0;
    const p = world.get(e, Transform)!;
    if (!c) { if (Math.hypot(p.x - t.x, p.y - t.y) <= CLAN_AI.recruitRange) less.push({ id: e, x: p.x, y: p.y }); }
    else if (clan && c === clan && world.has(e, ClanStatus)) mates.push({ id: e, role: world.getField(e, ClanStatus, "role")!, contrib: world.getField(e, ClanStatus, "contrib")! });
  }
  if (less.length) view.clanless = less.sort((a, b) => a.id - b.id);
  if (mates.length) view.clanMembers = mates.sort((a, b) => a.id - b.id);
  const inv2 = listSlots(world, self); let bd = CLAN_AI.stallRange, rd = CLAN_AI.stallRange;
  for (const e of world.query([StallHeader, Transform])) {
    const h = world.get(e, StallHeader)!; const p = world.get(e, Transform)!; const d = Math.hypot(p.x - t.x, p.y - t.y);
    const mine = clan && h.ownerKind === StallOwnerKind.Clan && h.ownerId === clan;
    if (!mine) { if (h.ownerKind && d < rd) { view.rivalStall = { id: e, x: p.x, y: p.y }; rd = d; } continue; }
    if (d >= bd || !world.has(e, StallDisplay)) continue;
    const items = world.getArray(e, StallDisplay, "item")!;
    for (let i = 0; i < items.length; i++) {
      const s = items[i] ? inv2.find((x) => x.item === items[i]) : undefined;
      if (s) { view.clanStock = { stall: e, x: p.x, y: p.y, listing: i, invSlot: s.slot, count: s.count }; bd = d; break; }
    }
  }
  // ADR-497: probe the rival base's weakest wall. The scan centre is the rival stall when sensed;
  // a bot on a raid goal re-derives it near the shared goal (the leader's pick) — the leader shares
  // the target with the clan through the goal, so members at the wall can attack even when the stall
  // itself is out of their sensor range. Only when a rival stall is sensed or a raid is running.
  if (view.rivalStall) view.rivalWeakWall = weakestWallNear(world, view.rivalStall.x, view.rivalStall.y);
  else if (st && st.goal === ClanGoal.Raid) view.rivalWeakWall = weakestWallNear(world, st.goalX, st.goalY);
}

/** Founding drive (0..1): sociable and either industrious or greedy. */
export const clanFoundScore = (t: Traits): number => Math.max(0, Math.min(1, 0.5 * t.sociability + 0.5 * Math.max(t.industriousness, t.greed)));
/** Chance a bot accepts a clan invite: sociability, trust in the inviter (-1..1), industriousness (likes shared goals). */
export function clanAcceptChance(traits: Traits, trust: number): number {
  const tr = Math.max(-1, Math.min(1, trust));
  return Math.max(0, Math.min(1, 0.1 + 0.45 * traits.sociability + 0.3 * tr + 0.2 * traits.industriousness));
}
/** The leader's goal pick: defend on threats near the base, raid when brave + greedy and a rival stall is seen, stock once a stall exists, else build a base. */
export function chooseClanGoal(traits: Traits, s: { threats: number; rival?: { x: number; y: number; weakWall?: { x: number; y: number } }; hasStall: boolean; base: { x: number; y: number }; current: number }): { goal: number; x: number; y: number } {
  if (s.threats >= CLAN_AI.threatZombies) return { goal: ClanGoal.Defend, ...s.base };
  if (s.rival && traits.bravery >= CLAN_AI.raidTrait && traits.greed >= CLAN_AI.raidTrait) {
    // ADR-497: raid the weakest wall, not the stall — the stall is the prize behind the wall.
    const w = s.rival.weakWall;
    return { goal: ClanGoal.Raid, x: w ? w.x : s.rival.x, y: w ? w.y : s.rival.y };
  }
  if (s.hasStall) return { goal: ClanGoal.StockStalls, ...s.base };
  return { goal: ClanGoal.BuildBase, ...s.base };
}

export type ClanSituation = "found" | "invite" | "accept" | "decline" | "promote" | "kick" | "goal" | "contribute" | "defend" | "raid";
/** A local chat line (en.json social.clan.<situation>.N), picked with the agent rng. */
export function clanLine(situation: ClanSituation, pick: () => number): { channel: string; text: string } | undefined {
  const keys = Object.keys(en).filter((k) => k.startsWith(`social.clan.${situation}.`)).sort();
  const k = keys[Math.floor(pick() * keys.length)]; return k ? { channel: "local", text: (en as Record<string, string>)[k]! } : undefined;
}

const toward = (o: { moveX: number; moveY: number; aimX: number; aimY: number }, fx: number, fy: number, tx: number, ty: number, s = 1): number => {
  const dx = tx - fx, dy = ty - fy, d = Math.hypot(dx, dy) || 1; o.moveX = (dx / d) * s; o.moveY = (dy / d) * s; o.aimX = dx / d; o.aimY = dy / d; return d;
};
const since = (c: { self: { tick: number }; bb: { num(k: string, d?: number): number } }, k: string, ticks: number): boolean => c.self.tick - c.bb.num(k, -1e9) >= ticks;
const LEADER = 3, OFFICER = 2;

export function clanBehaviors(): GameBehavior[] {
  return [
    { name: "clan_found", traits: { sociability: 0.5, industriousness: 0.3, greed: 0.2 }, inertia: 0, considerations: [
        { name: "drive", curve: { type: "step", at: 0.5 }, input: (c) => (!c.world.clan && !c.world.clanInvite && clanFoundScore(c.traits) >= CLAN_AI.foundScore && since(c, "clanFoundAt", CLAN_AI.foundCooldown) ? 1 : 0) }],
      run: (c, o) => { o.actions.push("ccreate"); c.bb.set("clanFoundAt", c.self.tick); const l = clanLine("found", () => c.rng.next()); if (l) o.chat = l; return false; } },
    { name: "clan_decide", inertia: 0, considerations: [
        { name: "invite", curve: { type: "step", at: 0.5 }, input: (c) => (c.world.clanInvite && !c.world.clan && since(c, "clanDecidedAt", CLAN_AI.decideDelay) ? 1 : 0) }],
      run: (c, o) => {
        const inv = c.world.clanInvite; if (!inv || c.world.clan) return false; c.bb.set("clanDecidedAt", c.self.tick);
        const yes = c.rng.next() < clanAcceptChance(c.traits, trustOf(c.agent, inv.from));
        if (yes) { o.actions.push(`caccept:${inv.clan}`); o.emote = "wave"; } else c.bb.set("clanDecidedAt", inv.expiresTick); // ignore until it expires
        const l = clanLine(yes ? "accept" : "decline", () => c.rng.next()); if (l) o.chat = l; return false;
      } },
    { name: "clan_recruit", traits: { sociability: 1 }, inertia: 0, considerations: [
        { name: "recruit", curve: { type: "step", at: 0.5 }, input: (c) => { const k = c.world.clan; return k && k.role >= OFFICER && c.world.clanless?.length && c.traits.sociability >= CLAN_AI.minRecruitSociability && since(c, "clanRecruitAt", CLAN_AI.recruitCooldown) ? 1 : 0; } }],
      run: (c, o) => {
        const l = c.world.clanless; if (!l?.length) return false; const t = l[Math.floor(c.rng.next() * l.length)]!;
        o.actions.push(`cinvite:${t.id}`); c.bb.set("clanRecruitAt", c.self.tick); const line = clanLine("invite", () => c.rng.next()); if (line) o.chat = line; return false;
      } },
    { name: "clan_manage", inertia: 0, considerations: [
        { name: "leader", curve: { type: "step", at: 0.5 }, input: (c) => (c.world.clan?.role === LEADER && since(c, "clanManageAt", CLAN_AI.manageCooldown) ? 1 : 0) }],
      run: (c, o) => {
        const k = c.world.clan!; c.bb.set("clanManageAt", c.self.tick); const mates = c.world.clanMembers ?? [];
        // role assignment once: industrious leaders let members stock clan stalls
        if (!c.bb.get("clanPermsSet") && c.traits.industriousness >= 0.5) { c.bb.set("clanPermsSet", true); o.actions.push(`cperms:1:${clanPermBit("base") | clanPermBit("stock")}`); }
        const star = mates.filter((m) => m.role === 1 && m.contrib >= CLAN_AI.promoteContrib).sort((a, b) => b.contrib - a.contrib)[0];
        if (star) { o.actions.push(`cpromote:${star.id}`); const l = clanLine("promote", () => c.rng.next()); if (l) o.chat = l; return false; }
        for (const m of mates) { // idle tracking: first tick each member was seen with zero contribution
          const key = `clanIdle.${m.id}`; if (m.contrib > 0 || m.role !== 1) { c.bb.set(key, -1); continue; }
          const s0 = c.bb.num(key, -1); if (s0 < 0) { c.bb.set(key, c.self.tick); continue; }
          if (c.self.tick - s0 >= CLAN_AI.kickIdleTicks * (1.5 - c.traits.sociability)) { o.actions.push(`ckick:${m.id}`); c.bb.set(key, -1); const l = clanLine("kick", () => c.rng.next()); if (l) o.chat = l; return false; }
        }
        if (since(c, "clanGoalAt", CLAN_AI.goalCooldown) || (k.goal === ClanGoal.None)) {
          const base = k.goal === ClanGoal.None || k.goal === ClanGoal.Raid ? { x: Math.round(c.world.home.x), y: Math.round(c.world.home.y) } : { x: k.goalX, y: k.goalY };
          const threats = c.world.seen.filter((s) => s.kind === "zombie" && Math.hypot(s.x - base.x, s.y - base.y) < 10).length;
          // ADR-497: the raid goal carries the probed weak wall (the walk target is the wall, not the stall).
          const rival = c.world.rivalStall ? { ...c.world.rivalStall, ...(c.world.rivalWeakWall ? { weakWall: c.world.rivalWeakWall } : {}) } : undefined;
          const g = chooseClanGoal(c.traits, { threats, ...(rival ? { rival } : {}), hasStall: !!c.world.clanStock, base, current: k.goal });
          if (g.goal !== k.goal || g.x !== k.goalX || g.y !== k.goalY) {
            o.actions.push(`cgoal:${g.goal}:${g.x}:${g.y}`); c.bb.set("clanGoalAt", c.self.tick);
            const l = clanLine(g.goal === ClanGoal.Defend ? "defend" : g.goal === ClanGoal.Raid ? "raid" : "goal", () => c.rng.next()); if (l) o.chat = l;
          }
        }
        return false;
      } },
    { name: "clan_stock", traits: { industriousness: 0.6, sociability: 0.2 }, inertia: 0.3, considerations: [
        { name: "stock", curve: { type: "step", at: 0.5 }, input: (c) => (c.world.clan && c.world.clanStock && since(c, "clanStockAt", 20 * 20) ? 1 : 0) }],
      run: (c, o) => {
        const s = c.world.clanStock; if (!s) return false;
        if (toward(o, c.self.x, c.self.y, s.x, s.y, 0.8) > CLAN_AI.stockRange) return true;
        o.moveX = 0; o.moveY = 0; o.actions.push(`cstock:${s.stall}:${s.listing}:${s.invSlot}:${s.count}`); c.bb.set("clanStockAt", c.self.tick);
        const l = clanLine("contribute", () => c.rng.next()); if (l) o.chat = l; return false;
      } },
    { name: "clan_raid", traits: { bravery: 0.6 }, inertia: 0.4, considerations: [
        { name: "raid", curve: { type: "step", at: 0.5 }, input: (c) => (c.world.clan?.goal === ClanGoal.Raid && c.world.rivalWeakWall ? 1 : 0) }],
      run: (c, o) => {
        // ADR-497: approach the probed weak wall and breach it (the hunt/defend attack shape: within
        // 1.4 tiles, one swing per 10 ticks). The sensor refreshes every probeEvery ticks, so a breach
        // re-picks the next-weakest wall on its own; when no walls remain the consideration drops to 0
        // and clan_goal takes over (walk to the stall — the old raid).
        const w = c.world.rivalWeakWall; if (!w) return false;
        const d = toward(o, c.self.x, c.self.y, w.x, w.y, 1);
        if (d < 1.4) { o.moveX *= 0.2; o.moveY *= 0.2; if (since(c, "hitAt", 10)) { o.actions.push(`attack:${w.id}`); c.bb.set("hitAt", c.self.tick); } }
        return true;
      } },
    { name: "clan_goal", traits: { sociability: 0.4, bravery: 0.3 }, inertia: 0.4, considerations: [
        { name: "far", curve: { type: "step", at: 0.5 }, input: (c) => { const k = c.world.clan; if (!k || k.goal === ClanGoal.None || k.goal === ClanGoal.StockStalls) return 0; if (k.goal === ClanGoal.Raid && c.world.rivalWeakWall) return 0; return Math.hypot(k.goalX - c.self.x, k.goalY - c.self.y) > CLAN_AI.goalRadius ? 1 : 0; } }],
      run: (c, o) => { const k = c.world.clan; if (!k) return false; return toward(o, c.self.x, c.self.y, k.goalX, k.goalY, k.goal === ClanGoal.Raid || k.goal === ClanGoal.Defend ? 1 : 0.8) > CLAN_AI.goalRadius; } },
  ];
}
