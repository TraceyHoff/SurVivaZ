/**
 * ADR-478: bots that remember each other — affinity is finally read, not just recorded.
 *
 * Scale correction (verified in build): the scope's -20 / >= 30 were written against a -100..100
 * scale, but the shipped trust/affinity scale is -1..1 (social_memory.ts clamps both), so the
 * thresholds are grudgeBelow -0.2 and friendAt 0.3. Meal: a bot deposits its surplus into the shared
 * store unless every mate at the meal is a grudge (affinity < -0.2) — the store is communal (no
 * per-recipient queue), so "friends first" is expressed as sharing whenever at least one mate is not
 * a grudge; a single grudge never vetoes sharing with the friends present. Guard: a hired Defend /
 * Follow bot guards a friend (affinity >= 0.3) more keenly (radius 12 + 4), a grudge only up close
 * (radius 4); the ADR-444 trust gate still applies (distrusted owner: radius 4 no matter the affinity).
 */
import { describe, expect, it } from "vitest";
import { installPermissions, Membership, NetId, PlayerId, Transform, setTimeOfDay, type Agent, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { fillSharedMealSensors, type SharedMealSensors } from "../src/ai/shared_meal.js";
import { makeWorld, plantClaim, spawnLearned } from "./helpers.js";

const d = G.defaultDefs();
const iid = (k: string): number => d.itemId(k);
const pid = (k: string): number => d.pieceId(k);
const BASE = { x: 10, y: 10 };
const FIRE = { x: BASE.x + 3.5, y: BASE.y + 0.5 };

let nid = 9700;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };

interface Rig { w: World; p: Entity; a: Agent; home: { x: number; y: number } }
function rig(slot = 0): Rig {
  const w = makeWorld({}, 42);
  installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = spawnLearned(w, { x: BASE.x + 1, y: BASE.y + 3.3, maxWeight: 0, clientId: 7 });
  if (w.has(p, PlayerId)) w.set(p, PlayerId, { id: 7 }); else w.add(p, PlayerId, { id: 7 });
  net(w, p);
  const a = G.makeAgent(G.makeAgentIdentity(3, slot, "bot_gatherer"), 1);
  a.bb.set("selfEntity", p);
  setTimeOfDay(w, 12);
  return { w, p, a, home: { ...BASE } };
}
const clanOf = (w: World, e: Entity, clan = 5): void => {
  if (!w.has(e, G.ClanStatus)) w.add(e, G.ClanStatus, { clan, role: 1, goal: 0, goalX: 0, goalY: 0, contrib: 0 });
  else w.set(e, G.ClanStatus, { clan, role: 1, goal: 0, goalX: 0, goalY: 0, contrib: 0 });
};
/** A second bot in the same clan with the given persistent player id, visible to the rig bot. */
function mate(r: Rig, clientId: number, x: number, y: number): Entity {
  const q = spawnLearned(r.w, { x, y, maxWeight: 0, clientId });
  if (r.w.has(q, PlayerId)) r.w.set(q, PlayerId, { id: clientId }); else r.w.add(q, PlayerId, { id: clientId });
  net(r.w, q); clanOf(r.w, q);
  clanOf(r.w, r.p);
  return q;
}
const give = (r: Rig, key: string, n = 1): void => { G.addItem(r.w, r.p, iid(key), n); };
const hungry = (r: Rig, hunger = 40): void => { r.w.set(r.p, G.Survival, { hunger, thirst: 100 }); };
type View = G.AgentWorldView & SharedMealSensors;
/** Hand-built view: a campfire at FIRE, the given mates, food already sensed in the bag. */
function viewOf(r: Rig, mates: Entity[], over: Partial<View> = {}): View {
  const v = { seen: [], home: r.home, playerName: "friend", fire: { id: 1 as Entity, x: FIRE.x, y: FIRE.y, lit: false } } as unknown as View;
  G.fillAgentSensors(r.w, r.p, v);
  return { ...v, clanMembers: mates.map((id) => ({ id, role: 1, contrib: 0 })), clan: { id: 5, role: 1, goal: 0, goalX: 0, goalY: 0, contrib: 0 }, ...over };
}
/** Place the campfire + starter box the adr252 way (claim, then tryPlace). */
function placeHearth(r: Rig): { fire: Entity; box: Entity } {
  plantClaim(r.w, r.p, BASE.x - 2, BASE.y - 2);
  const givePiece = (key: string): void => { const def = d.pieces.get(pid(key))!; for (const c of G.pieceCost(d, def, def.tiered ? 0 : def.fixedTier)) G.addItem(r.w, r.p, c.item, c.count); };
  const put = (key: string, x: number, y: number): Entity => {
    givePiece(key); const def = d.pieces.get(pid(key))!;
    r.w.set(r.p, Transform, { x, y: y + 1.2 });
    const res = G.tryPlace(r.w, r.p, { piece: pid(key), x, y, level: 0, rot: 0, tier: def.fixedTier, variant: 0 });
    if (!res.ok) throw new Error(`place ${key} failed: ${res.reason}`);
    return res.piece as Entity;
  };
  const fire = put("campfire", FIRE.x, FIRE.y);
  const box = put("storage_box", FIRE.x, FIRE.y + 1.1);
  return { fire, box };
}

// ---------------- guard rig (ADR-444 pattern) ----------------
const mkPlayer = (w: World, x: number, y: number, id: number): Entity => { const e = G.spawnPlayer(w, { x, y, maxWeight: 0, clientId: id }); if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); if (w.isRegistered(Membership)) w.add(e, Membership, { partyId: 0, clanId: 0 }); return e; };
function guardSetup(): { w: World; p: Entity; bot: Entity; agent: ReturnType<typeof G.makeAgent> } {
  const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId); installPermissions(w);
  const p = mkPlayer(w, 0, 0, 7); const bot = mkPlayer(w, 2, 0, 9);
  G.setAiHumanPredicate(w, (e) => e === bot);
  G.ensureWorker(w, bot);
  return { w, p, bot, agent: G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1) };
}
const tickBot = (s: ReturnType<typeof guardSetup>) => G.buildAgentView(s.w, s.bot, s.agent, { x: 0, y: 0 })!;
const hireDefend = (s: ReturnType<typeof guardSetup>): void => {
  const { w, p, bot } = s;
  const item = w.get(bot, G.Worker)!.wantedItem; G.addItem(w, p, item, 1);
  expect(G.hireWorker(w, p, bot)).toBe(G.WorkerFail.None);
  expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Defend)).toBe(G.WorkerFail.None);
};

describe("ADR-478 affinity is read (social_memory)", () => {
  it("affinityOf reads the recorded affinity; unknown players read 0", () => {
    const { a } = rig();
    expect(G.affinityOf(a, 8)).toBe(0);
    G.noteSocialEvent(a, 8, "attacked", 0);
    expect(G.affinityOf(a, 8)).toBe(-0.4);
    G.noteSocialEvent(a, 8, "helped", 1); G.noteSocialEvent(a, 8, "helped", 2);
    expect(G.affinityOf(a, 8)).toBeCloseTo(0, 5); // -0.4 + 0.2 + 0.2
    expect(G.SOCIAL_AFFINITY.grudgeBelow).toBe(-0.2);
    expect(G.SOCIAL_AFFINITY.friendAt).toBe(0.3);
  });
});

describe("ADR-478 meal: grudges are not fed", () => {
  it("neutral mates: surplus is shared into the store as before", () => {
    const r = rig(); const q = mate(r, 8, FIRE.x + 2, FIRE.y + 1);
    placeHearth(r); give(r, "cooked_meat", 5); hungry(r, 40);
    const v = viewOf(r, [q]);
    fillSharedMealSensors(r.w, r.p, v, r.a);
    expect(v.sharedMeal?.deposit?.item).toBe(iid("cooked_meat"));
    expect(v.sharedMeal?.deposit?.count).toBe(3); // 5 - keep 2
  });

  it("every mate a grudge: the bot keeps its surplus (no deposit) but still eats at the hearth", () => {
    const r = rig(); const q = mate(r, 8, FIRE.x + 2, FIRE.y + 1);
    G.noteSocialEvent(r.a, 8, "attacked", 0); // affinity -0.4 < grudgeBelow -0.2
    expect(G.affinityOf(r.a, 8)).toBe(-0.4);
    placeHearth(r); give(r, "cooked_meat", 5); hungry(r, 40);
    const v = viewOf(r, [q]);
    fillSharedMealSensors(r.w, r.p, v, r.a);
    expect(v.sharedMeal).toBeDefined();
    expect(v.sharedMeal?.deposit).toBeUndefined();
  });

  it("one grudge + one friend: the bot still shares (the friend is fed; one grudge never vetoes the meal)", () => {
    const r = rig();
    const q = mate(r, 8, FIRE.x + 2, FIRE.y + 1);
    const f = mate(r, 9, FIRE.x - 2, FIRE.y + 1);
    G.noteSocialEvent(r.a, 8, "attacked", 0); // grudge: -0.4
    G.noteSocialEvent(r.a, 9, "helped", 1); G.noteSocialEvent(r.a, 9, "helped", 2); // friend: +0.4
    expect(G.affinityOf(r.a, 8)).toBe(-0.4);
    expect(G.affinityOf(r.a, 9)).toBeCloseTo(0.4, 5);
    placeHearth(r); give(r, "cooked_meat", 5); hungry(r, 40);
    const v = viewOf(r, [q, f]);
    fillSharedMealSensors(r.w, r.p, v, r.a);
    expect(v.sharedMeal?.deposit?.item).toBe(iid("cooked_meat"));
    expect(v.sharedMeal?.deposit?.count).toBe(3);
  });
});

describe("ADR-478 guard: friends are guarded more keenly", () => {
  it("a friend (affinity 0.6) is guarded out to 16 tiles; a neutral owner only to 12", () => {
    const s = guardSetup(); hireDefend(s);
    for (let i = 0; i < 3; i++) G.noteSocialEvent(s.agent, 7, "helped", i); // affinity +0.6, trust +0.6
    expect(G.affinityOf(s.agent, 7)).toBeCloseTo(0.6, 5);
    const z = G.spawnZombie(s.w, "zombie_walker", 14, 0); // 14 tiles from the anchor (0,0)
    expect(tickBot(s).world.defend?.id).toBe(z); // friend radius 16 covers 14
    const s2 = guardSetup(); hireDefend(s2); // neutral: the hire itself notes "helped" once (+0.2 affinity)
    expect(G.affinityOf(s2.agent, 7)).toBe(0); // not yet observed: the hire note lands on the next tick
    const z2 = G.spawnZombie(s2.w, "zombie_walker", 14, 0);
    expect(tickBot(s2).world.defend).toBeUndefined(); // neutral radius 12 does not cover 14
    expect(G.affinityOf(s2.agent, 7)).toBeCloseTo(0.2, 5); // the hire note: +0.2, still below friendAt 0.3
    expect(z2).toBeGreaterThan(0);
  });

  it("a grudge (affinity -0.5, trust +0.5) is guarded only up close: 8 tiles ignored, 3 tiles defended", () => {
    const s = guardSetup(); hireDefend(s);
    // Direct record: trust and affinity are coupled by events, so the grudge-with-trust case is set
    // directly (precedent: social_memory.test.ts validation of stored records).
    (s.agent.identity as unknown as { social: unknown }).social = {
      relationships: { "7": { trust: 0.5, affinity: -0.5, lastSeen: 0, notableEvents: [] } }, party: null, clan: null,
    };
    expect(G.affinityOf(s.agent, 7)).toBe(-0.5);
    expect(G.trustOf(s.agent, 7)).toBe(0.5);
    const z = G.spawnZombie(s.w, "zombie_walker", 8, 0);
    expect(tickBot(s).world.defend).toBeUndefined(); // grudge radius 4 does not cover 8
    const s2 = guardSetup(); hireDefend(s2);
    (s2.agent.identity as unknown as { social: unknown }).social = {
      relationships: { "7": { trust: 0.5, affinity: -0.5, lastSeen: 0, notableEvents: [] } }, party: null, clan: null,
    };
    const z2 = G.spawnZombie(s2.w, "zombie_walker", 3, 0);
    expect(tickBot(s2).world.defend?.id).toBe(z2); // 3 tiles is inside the reluctant radius
  });

  it("the trust gate still applies: a distrusted owner is guarded up close even with high affinity", () => {
    const s = guardSetup(); hireDefend(s);
    (s.agent.identity as unknown as { social: unknown }).social = {
      relationships: { "7": { trust: -0.5, affinity: 0.6, lastSeen: 0, notableEvents: [] } }, party: null, clan: null,
    };
    expect(G.affinityOf(s.agent, 7)).toBe(0.6);
    expect(G.trustOf(s.agent, 7)).toBe(-0.5);
    const z = G.spawnZombie(s.w, "zombie_walker", 8, 0);
    expect(tickBot(s).world.defend).toBeUndefined(); // trust < 0: radius 4, friend bonus does not apply
    expect(z).toBeGreaterThan(0);
  });
});
