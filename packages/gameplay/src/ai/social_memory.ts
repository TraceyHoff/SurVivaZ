/**
 * Bot relationship / party / clan memory, stored on the bot's AgentIdentity record (game.agents, the "agents" WorldStore
 * namespace) under `social`. Shape: relationships keyed by persistent player id -> { trust, affinity, lastSeen, notableEvents[] },
 * plus party and clan membership memory. Pure and browser-safe: observeSocialMemory (called from buildAgentView) updates it from
 * the replica; flushSocialMemory writes dirty bots through a put(id, partial) sink (game.agents.put), debounced per bot.
 * Loading needs nothing extra: addBot merges game.agents.get(id) into the identity, and socialMemoryOf validates it.
 *
 * ADR-444: the memory also feeds behaviour back. observeSocialMemory records the events production can see — a hit
 * the bot suffered (lastAttacker, ADR-194) notes "attacked", being hired notes "helped" — and mirrors the bot's
 * relationships into the world TrustLedger, so the agent-less hire path (recruitment.ts) can price / refuse hires
 * by remembered trust. A grudge fades: negative trust decays toward 0 on the lastSeen refresh, so one accidental
 * hit never locks a player out permanently.
 */
import { defineResource, Membership, PlayerId, Transform, type Agent, type Entity, type World } from "@engine/core";
import { ClanStatus, Worker } from "../components.js";
import { lastAttacker } from "../combat/combat.js";

export interface NotableEvent { tick: number; kind: SocialEventKind }
export interface Relation { trust: number; affinity: number; lastSeen: number; notableEvents: NotableEvent[] }
export interface SocialMemory {
  relationships: Record<string, Relation>;
  party: { id: number; since: number } | null;
  clan: { id: number; role: number; since: number } | null;
}
/** trust / affinity deltas (clamped to -1..1) per event; data lives here because it tunes bot temperament, not rules. */
export const SOCIAL_EVENTS = {
  partied: { trust: 0.15, affinity: 0.2 }, clanmate: { trust: 0.2, affinity: 0.15 }, traded: { trust: 0.05, affinity: 0.05 },
  helped: { trust: 0.2, affinity: 0.2 }, attacked: { trust: -0.5, affinity: -0.4 }, kicked: { trust: -0.3, affinity: -0.3 },
  left: { trust: -0.05, affinity: -0.1 },
} as const;
export type SocialEventKind = keyof typeof SOCIAL_EVENTS;
/** ADR-444: forgiveness — on each lastSeen refresh (seenEveryTicks) negative trust keeps this fraction of
 * itself (half-life ~2.3 min at 20 tps); below trustDecaySnap it snaps to 0. Positive trust never decays. */
export const SOCIAL_MEMORY = { maxEvents: 8, maxRelations: 64, seenEveryTicks: 20 * 10, writeDebounceTicks: 20 * 15, trustDecayKeep: 0.95, trustDecaySnap: 0.01 };

type SocialIdentity = Agent["identity"] & { social?: unknown };
const clamp = (v: number): number => Math.max(-1, Math.min(1, v));
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** Validates whatever the store returned (old records, hand edits) into a SocialMemory, attaching it to the identity. */
export function socialMemoryOf(agent: Agent): SocialMemory {
  const id = agent.identity as SocialIdentity; const raw = id.social as Partial<SocialMemory> | undefined;
  if (raw && (raw as { __ok?: true }).__ok) return raw as SocialMemory;
  const rel: Record<string, Relation> = {};
  if (raw && typeof raw.relationships === "object" && raw.relationships) {
    for (const [k, r] of Object.entries(raw.relationships)) {
      if (!/^\d+$/.test(k) || !r || typeof r !== "object") continue;
      const ev = Array.isArray(r.notableEvents) ? r.notableEvents.filter((e) => e && typeof e.kind === "string" && e.kind in SOCIAL_EVENTS).map((e) => ({ tick: num(e.tick), kind: e.kind })) : [];
      rel[k] = { trust: clamp(num(r.trust)), affinity: clamp(num(r.affinity)), lastSeen: num(r.lastSeen), notableEvents: ev.slice(-SOCIAL_MEMORY.maxEvents) };
    }
  }
  const p = raw?.party, c = raw?.clan;
  const mem: SocialMemory = { relationships: rel, party: p && num(p.id) ? { id: num(p.id), since: num(p.since) } : null, clan: c && num(c.id) ? { id: num(c.id), role: num(c.role), since: num(c.since) } : null };
  Object.defineProperty(mem, "__ok", { value: true, enumerable: false }); id.social = mem; return mem;
}

const dirty = new WeakMap<Agent, { since: number }>();
const markDirty = (a: Agent, tick: number): void => { if (!dirty.has(a)) dirty.set(a, { since: tick }); };
const relationOf = (m: SocialMemory, player: number, tick: number): Relation => {
  const k = String(player); let r = m.relationships[k];
  if (!r) {
    r = m.relationships[k] = { trust: 0, affinity: 0, lastSeen: tick, notableEvents: [] };
    const keys = Object.keys(m.relationships); if (keys.length > SOCIAL_MEMORY.maxRelations) { // forget the stalest
      const old = keys.filter((x) => x !== k).sort((a, b) => m.relationships[a]!.lastSeen - m.relationships[b]!.lastSeen)[0]; if (old) delete m.relationships[old];
    }
  }
  return r;
};

/** Records a notable event with a player (trust/affinity shift, capped event log). */
export function noteSocialEvent(agent: Agent, player: number, kind: SocialEventKind, tick: number): void {
  if (!player) return; const m = socialMemoryOf(agent); const r = relationOf(m, player, tick); const d = SOCIAL_EVENTS[kind];
  r.trust = clamp(r.trust + d.trust); r.affinity = clamp(r.affinity + d.affinity); r.lastSeen = tick;
  r.notableEvents.push({ tick, kind }); if (r.notableEvents.length > SOCIAL_MEMORY.maxEvents) r.notableEvents.splice(0, r.notableEvents.length - SOCIAL_MEMORY.maxEvents);
  markDirty(agent, tick);
}
/** Trust in a player (-1..1): remembered trust, else the identity's legacy scalar relationship. */
export function trustOf(agent: Agent, player: number): number {
  const r = player ? socialMemoryOf(agent).relationships[String(player)] : undefined;
  return r ? r.trust : clamp(num(agent.identity.relationship));
}

/**
 * ADR-444: world-side mirror of bot trust, so code with no Agent (the hire path) can read it. Keyed by the bot's
 * stable PlayerId, never a recyclable entity id; rebuilt from the loaded record on first sight after a restart.
 * Sim-local only (never networked / persisted) — game.agents stays the source of truth.
 */
export interface TrustLedger { byBot: Map<number, Map<number, number>> }
export const TrustLedgerRes = defineResource<TrustLedger>("gameplay.TrustLedger");
const syncTrustLedger = (world: World, botPid: number, m: SocialMemory): void => {
  let ledger = world.getResource(TrustLedgerRes);
  if (!ledger) { ledger = { byBot: new Map() }; world.setResource(TrustLedgerRes, ledger); }
  const rel = new Map<number, number>();
  for (const [k, r] of Object.entries(m.relationships)) rel.set(Number(k), r.trust);
  ledger.byBot.set(botPid, rel);
};
/** Remembered trust of bot `bot` toward `player` (0 = unknown / neutral). */
export function trustToward(world: World, bot: Entity, player: number): number {
  if (!player) return 0;
  const ledger = world.getResource(TrustLedgerRes); if (!ledger) return 0;
  const botPid = world.isRegistered(PlayerId) && world.has(bot, PlayerId) ? world.getField(bot, PlayerId, "id") ?? 0 : 0;
  if (!botPid) return 0;
  return ledger.byBot.get(botPid)?.get(player) ?? 0;
}

/**
 * Updates memory from the bot's replica: party / clan joins and leaves (with "partied" / "clanmate" / "left" events for the
 * others in the group) and lastSeen for visible players (throttled). Called from buildAgentView.
 */
export function observeSocialMemory(world: World, self: Entity, agent: Agent): void {
  const m = socialMemoryOf(agent); const tick = world.tick;
  const party = world.getField(self, Membership, "partyId") ?? 0;
  const clan = world.has(self, ClanStatus) ? world.getField(self, ClanStatus, "clan")! : world.getField(self, Membership, "clanId") ?? 0;
  const role = clan && world.has(self, ClanStatus) ? world.getField(self, ClanStatus, "role")! : 0;
  const t = world.get(self, Transform); const me = world.getField(self, PlayerId, "id") ?? 0;
  const others = (field: "partyId" | "clanId", id: number): number[] => {
    const out: number[] = []; if (!id) return out;
    for (const e of world.query([PlayerId, Membership])) { const p = world.getField(e, PlayerId, "id")!; if (e !== self && p !== me && world.getField(e, Membership, field) === id) out.push(p); }
    return out;
  };
  if ((m.party?.id ?? 0) !== party) {
    if (m.party) for (const p of others("partyId", m.party.id)) noteSocialEvent(agent, p, "left", tick);
    m.party = party ? { id: party, since: tick } : null; for (const p of others("partyId", party)) noteSocialEvent(agent, p, "partied", tick); markDirty(agent, tick);
  }
  if ((m.clan?.id ?? 0) !== clan || (clan && m.clan!.role !== role)) {
    const joined = (m.clan?.id ?? 0) !== clan;
    m.clan = clan ? { id: clan, role, since: joined ? tick : m.clan!.since } : null;
    if (joined) for (const p of others("clanId", clan)) noteSocialEvent(agent, p, "clanmate", tick);
    markDirty(agent, tick);
  }
  // ADR-444: being hired is remembered as help (the player gave the bot its wanted item and work). The
  // blackboard holds the last owner seen: a 0 -> player transition notes "helped" once. The first sight
  // (a fresh agent after a restart, or a test agent) notes it only when the bot has no relation with the
  // owner yet — a hire already noted before the save is not noted again on load. Runs BEFORE the attack
  // observation below, so a hire-then-attack in the same unseen window nets in event order (+0.2, -0.5).
  if (world.isRegistered(Worker) && world.has(self, Worker)) {
    const owner = world.get(self, Worker)!.owner ?? 0;
    const lastOwner = agent.bb.num("socialHireOwner", -1);
    if (lastOwner === -1) {
      if (owner !== 0 && !m.relationships[String(owner)]) noteSocialEvent(agent, owner, "helped", tick);
      agent.bb.set("socialHireOwner", owner);
    } else if (lastOwner !== owner) {
      if (lastOwner === 0 && owner !== 0) noteSocialEvent(agent, owner, "helped", tick);
      agent.bb.set("socialHireOwner", owner);
    }
  }
  // ADR-444: a hit the bot suffered is remembered. lastAttacker (ADR-194) is the sim-local record of the last
  // living attacker; the blackboard dedups by hit tick so one blow is noted once, however many ticks pass
  // before the bot's next think. Zombies carry no PlayerId and are skipped; a dead attacker is skipped too
  // (its entity id may be recycled, and a blow from the dead needs no grudge).
  const hit = lastAttacker(world, self);
  if (hit) {
    const noted = agent.bb.num("socialLastAttackTick", -1);
    if (hit.tick > noted) {
      agent.bb.set("socialLastAttackTick", hit.tick);
      if (world.isAlive(hit.e)) {
        const apid = world.getField(hit.e, PlayerId, "id") ?? 0;
        if (apid && apid !== me) noteSocialEvent(agent, apid, "attacked", hit.tick);
      }
    }
  }
  if (!t) return;
  for (const e of world.query([PlayerId, Transform])) {
    if (e === self) continue; const p = world.getField(e, PlayerId, "id")!; if (!p || p === me) continue;
    const r = m.relationships[String(p)]; if (!r) continue; // only refresh people the bot already knows
    if (tick - r.lastSeen >= SOCIAL_MEMORY.seenEveryTicks) {
      r.lastSeen = tick;
      // ADR-444: grudges fade — negative trust decays toward 0 (see SOCIAL_MEMORY.trustDecayKeep), so a
      // single accidental hit stops mattering after a few minutes and a double attack blocks hiring only
      // briefly. Positive trust never decays: friendships persist, grudges do not.
      if (r.trust < 0) { r.trust = clamp(r.trust * SOCIAL_MEMORY.trustDecayKeep); if (Math.abs(r.trust) < SOCIAL_MEMORY.trustDecaySnap) r.trust = 0; }
      markDirty(agent, tick);
    }
  }
  // ADR-444: mirror into the world ledger (see TrustLedger) after every mutation above, so the hire path
  // reads the same trust the agent just recorded.
  if (me) syncTrustLedger(world, me, m);
}

export type AgentPut = (id: string, partial: { social: SocialMemory }) => unknown;
/**
 * Debounced write-through: a bot dirty for at least writeDebounceTicks is written once with put(id, { social }) (game.agents.put
 * persists immediately). force = write every dirty bot now (bot removal / shutdown). Returns the ids written.
 */
export function flushSocialMemory(agents: Iterable<Agent>, put: AgentPut, tick: number, force = false): string[] {
  const out: string[] = [];
  for (const a of agents) {
    const d = dirty.get(a); if (!d || (!force && tick - d.since < SOCIAL_MEMORY.writeDebounceTicks)) continue;
    dirty.delete(a); const m = socialMemoryOf(a); put(a.identity.id, { social: JSON.parse(JSON.stringify(m)) as SocialMemory }); out.push(a.identity.id);
  }
  return out;
}
export const socialMemoryDirty = (a: Agent): boolean => dirty.has(a);
