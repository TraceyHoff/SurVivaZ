import { describe, expect, it } from "vitest";
import { installPermissions, Membership, PlayerId, Transform, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

/**
 * ADR-444: trust and reputation change behaviour.
 *
 * Root cause (audit 2026-11-19, base 8616271): `ai/social_memory.ts` records persistent trust/affinity per
 * player — but almost nothing reads it back, and nothing in production ever records the interesting events:
 * `noteSocialEvent(agent, player, "attacked" | "helped")` has no production caller, and `hireWorker` never
 * consults trust, so a player who attacked bots hires exactly like a player who helped them.
 */
const pid = (w: World, e: Entity, id: number): void => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); };
const mkPlayer = (w: World, x: number, y: number, id: number): Entity => { const e = G.spawnPlayer(w, { x, y, maxWeight: 0, clientId: id }); pid(w, e, id); if (w.isRegistered(Membership)) w.add(e, Membership, { partyId: 0, clanId: 0 }); return e; };
const setup = (): { w: World; p: Entity; q: Entity; bot: Entity; agent: ReturnType<typeof G.makeAgent> } => {
  const w = makeWorld(); if (!w.isRegistered(PlayerId)) w.register(PlayerId); installPermissions(w);
  const p = mkPlayer(w, 0, 0, 7); const q = mkPlayer(w, 1, 1, 8); const bot = mkPlayer(w, 2, 0, 9);
  G.setAiHumanPredicate(w, (e) => e === bot);
  G.ensureWorker(w, bot);
  return { w, p, q, bot, agent: G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1) };
};
/** Run the bot's tick (observeSocialMemory mirrors its trust into the world ledger). */
const tickBot = (s: ReturnType<typeof setup>) => G.buildAgentView(s.w, s.bot, s.agent, { x: 0, y: 0 })!;
const giveWanted = (w: World, e: Entity, bot: Entity, n = 1): number => {
  const item = w.get(bot, G.Worker)!.wantedItem; G.addItem(w, e, item, n); return item;
};
const runBehavior = (s: ReturnType<typeof setup>, name: string) => {
  const v = tickBot(s);
  const ctx = { ...v, bb: s.agent.bb, memory: s.agent.memory, traits: s.agent.identity.traits, rng: s.agent.rng, agent: s.agent };
  const o = { moveX: 0, moveY: 0, aimX: 0, aimY: 0, sprint: false, actions: [] as string[] };
  G.hireBehaviors().find((x) => x.name === name)!.run(ctx as never, o as never);
  return { v, o };
};

describe("ADR-444: trust and reputation change behaviour", () => {
  it("repro: a high-trust player hires free, a player who attacked the bot is refused", () => {
    const s = setup(); const { w, p, q, bot, agent } = s;
    // Trusted friend: three helps -> trust 0.6. The hire costs nothing.
    for (let i = 0; i < 3; i++) G.noteSocialEvent(agent, 7, "helped", i);
    tickBot(s);
    const item = giveWanted(w, p, bot, 1);
    expect(G.hireWorkerValidate(w, p, bot)).toBe(G.WorkerFail.None);
    expect(G.hireWorker(w, p, bot)).toBe(G.WorkerFail.None);
    expect(G.countItem(w, p, item)).toBe(1); // free hire: nothing taken
    expect(w.get(bot, G.Worker)!.owner).toBe(7);
    // Attacker: two attacks -> trust -1. Refused, keeps the item, bot stays for hire.
    const s2 = setup(); const { w: w2, q: q2, bot: bot2, agent: agent2 } = s2;
    for (let i = 0; i < 2; i++) G.noteSocialEvent(agent2, 8, "attacked", i);
    G.buildAgentView(w2, bot2, agent2, { x: 0, y: 0 });
    const item2 = giveWanted(w2, q2, bot2, 1);
    expect(G.hireWorkerValidate(w2, q2, bot2)).toBe(G.WorkerFail.Distrusted);
    expect(G.hireWorker(w2, q2, bot2)).toBe(G.WorkerFail.Distrusted);
    expect(G.countItem(w2, q2, item2)).toBe(1);
    expect(w2.get(bot2, G.Worker)!.owner).toBe(0);
  });
  it("one accidental hit does not refuse the hire — it doubles the price, and trust recovers", () => {
    const s = setup(); const { w, q, bot, agent } = s;
    G.noteSocialEvent(agent, 8, "attacked", 0);
    tickBot(s);
    expect(G.hirePriceFor(-0.5)).toBe(2);
    giveWanted(w, q, bot, 1);
    expect(G.hireWorker(w, q, bot)).toBe(G.WorkerFail.NoItem); // 1 unit is not enough at double price
    expect(G.hireWorkerValidate(w, q, bot)).toBe(G.WorkerFail.NoItem);
    giveWanted(w, q, bot, 1);
    expect(G.hireWorkerValidate(w, q, bot)).toBe(G.WorkerFail.None); // not refused, just pricey
    const item = w.get(bot, G.Worker)!.wantedItem;
    expect(G.hireWorker(w, q, bot)).toBe(G.WorkerFail.None);
    expect(G.countItem(w, q, item)).toBe(0); // both units taken
  });
  it("an attack the bot suffers is remembered from the world (once per hit)", () => {
    const s = setup(); const { w, p, bot, agent } = s;
    G.applyDamage(w, bot, 5, p);
    tickBot(s);
    expect(G.trustOf(agent, 7)).toBe(-0.5);
    tickBot(s); // same hit, no new damage: not re-noted
    expect(G.trustOf(agent, 7)).toBe(-0.5);
    steps(w, 1); G.applyDamage(w, bot, 5, p);
    tickBot(s);
    expect(G.trustOf(agent, 7)).toBe(-1);
  });
  it("being hired is remembered as help, and the world ledger sees it", () => {
    const s = setup(); const { w, p, bot, agent } = s;
    giveWanted(w, p, bot, 1);
    expect(G.hireWorker(w, p, bot)).toBe(G.WorkerFail.None);
    tickBot(s);
    expect(G.trustOf(agent, 7)).toBe(0.2);
    expect(G.trustToward(w, bot, 7)).toBe(0.2);
    expect(G.trustToward(w, bot, 8)).toBe(0); // a stranger is neutral
  });
  it("grudges fade: negative trust decays toward 0 and the refusal lifts", () => {
    const s = setup(); const { w, q, bot, agent } = s;
    for (let i = 0; i < 2; i++) G.noteSocialEvent(agent, 8, "attacked", 0);
    G.observeSocialMemory(w, bot, agent);
    expect(G.trustOf(agent, 8)).toBe(-1);
    expect(G.hireWorkerValidate(w, q, bot)).toBe(G.WorkerFail.Distrusted);
    w.tick += G.SOCIAL_MEMORY.seenEveryTicks; G.observeSocialMemory(w, bot, agent);
    expect(G.trustOf(agent, 8)).toBeCloseTo(-0.95, 10); // one forgiveness step
    for (let i = 0; i < 20; i++) { w.tick += G.SOCIAL_MEMORY.seenEveryTicks; G.observeSocialMemory(w, bot, agent); }
    expect(G.trustOf(agent, 8)).toBeGreaterThan(-0.5);
    giveWanted(w, q, bot, 2); // surcharge band now: 2 units, but no longer refused
    expect(G.hireWorkerValidate(w, q, bot)).toBe(G.WorkerFail.None);
    for (let i = 0; i < 200; i++) { w.tick += G.SOCIAL_MEMORY.seenEveryTicks; G.observeSocialMemory(w, bot, agent); }
    expect(G.trustOf(agent, 8)).toBe(0); // fully forgiven
  });
  it("trust survives a restart round-trip and the ledger re-syncs from the loaded record", () => {
    const s = setup(); const { w, p, bot, agent } = s;
    for (let i = 0; i < 3; i++) G.noteSocialEvent(agent, 7, "helped", i);
    const puts: [string, unknown][] = []; const put: G.AgentPut = (id, pt) => puts.push([id, pt]);
    expect(G.flushSocialMemory([agent], put, 1e6, true)).toEqual([agent.identity.id]);
    const saved = JSON.parse(JSON.stringify(puts[0]![1])) as { social: G.SocialMemory };
    expect(saved.social.relationships["7"]!.trust).toBeCloseTo(0.6, 10);
    const back = G.makeAgent({ ...G.makeAgentIdentity(5, 0, "bot_gatherer"), ...saved } as never, 1);
    G.buildAgentView(w, bot, back, { x: 0, y: 0 });
    expect(G.trustToward(w, bot, 7)).toBeCloseTo(0.6, 10); // ledger rebuilt from the loaded memory
    expect(G.workerView(w, p, bot)!.hireCost).toBe(0);
    expect(G.hireWorker(w, p, bot)).toBe(G.WorkerFail.None); // free hire, no item needed
    expect(w.get(bot, G.Worker)!.owner).toBe(7);
  });
  it("workerView shows the trust price and the refusal", () => {
    const s = setup(); const { w, p, q, bot, agent } = s;
    const v0 = G.workerView(w, p, bot)!;
    expect(v0).toMatchObject({ trust: 0, hireCost: 1, hireRefused: false, hasWanted: false });
    for (let i = 0; i < 3; i++) G.noteSocialEvent(agent, 7, "helped", i);
    tickBot(s);
    const vTrust = G.workerView(w, p, bot)!;
    expect(vTrust.trust).toBeCloseTo(0.6, 10);
    expect(vTrust).toMatchObject({ hireCost: 0, hireRefused: false, hasWanted: true });
    for (let i = 0; i < 2; i++) G.noteSocialEvent(agent, 8, "attacked", i);
    tickBot(s);
    expect(G.workerView(w, q, bot)!).toMatchObject({ trust: -1, hireCost: 2, hireRefused: true });
  });
  it("hired bots follow willingly when trusted and keep their distance when distrusted", () => {
    const s = setup(); const { w, p, bot, agent } = s;
    giveWanted(w, p, bot, 1);
    expect(G.hireWorker(w, p, bot)).toBe(G.WorkerFail.None);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Follow)).toBe(G.WorkerFail.None);
    for (let i = 0; i < 3; i++) G.noteSocialEvent(agent, 7, "helped", i);
    w.set(p, Transform, { x: 10, y: 0 }); // owner 8 tiles away
    const { o: trustedOut } = runBehavior(s, "work_follow");
    expect(Math.hypot(trustedOut.moveX, trustedOut.moveY)).toBeGreaterThan(0); // hurries to catch up
    // Distrusted owner: the same bot, 4 tiles away, holds its distance instead.
    const s2 = setup(); const { w: w2, p: p2, bot: bot2, agent: agent2 } = s2;
    giveWanted(w2, p2, bot2, 1);
    expect(G.hireWorker(w2, p2, bot2)).toBe(G.WorkerFail.None);
    expect(G.setWorkerJob(w2, p2, bot2, G.WorkerJob.Follow)).toBe(G.WorkerFail.None);
    G.applyDamage(w2, bot2, 5, p2); // owner struck their own worker
    G.buildAgentView(w2, bot2, agent2, { x: 0, y: 0 });
    expect(G.trustOf(agent2, 7)).toBe(-0.3); // the hire was remembered (+0.2) before the blow (-0.5)
    w2.set(p2, Transform, { x: 6, y: 0 }); // owner 4 tiles away
    const v2 = G.buildAgentView(w2, bot2, agent2, { x: 0, y: 0 })!;
    const ctx2 = { ...v2, bb: agent2.bb, memory: agent2.memory, traits: agent2.identity.traits, rng: agent2.rng, agent: agent2 };
    const o2 = { moveX: 0, moveY: 0, aimX: 0, aimY: 0, sprint: false, actions: [] as string[] };
    G.hireBehaviors().find((x) => x.name === "work_follow")!.run(ctx2 as never, o2 as never);
    expect(o2.moveX).toBe(0); expect(o2.moveY).toBe(0); // keeps its distance
  });
  it("a distrusted owner gets a reluctant guard: far zombies are ignored", () => {
    const s = setup(); const { w, p, bot, agent } = s;
    giveWanted(w, p, bot, 1);
    expect(G.hireWorker(w, p, bot)).toBe(G.WorkerFail.None);
    expect(G.setWorkerJob(w, p, bot, G.WorkerJob.Defend)).toBe(G.WorkerFail.None);
    const z = G.spawnZombie(w, "zombie_walker", 8, 0); // 8 tiles from the hire anchor
    for (let i = 0; i < 3; i++) G.noteSocialEvent(agent, 7, "helped", i);
    expect(tickBot(s).world.defend?.id).toBe(z); // trusted: guards the full radius
    const s2 = setup(); const { w: w2, p: p2, bot: bot2, agent: agent2 } = s2;
    giveWanted(w2, p2, bot2, 1);
    expect(G.hireWorker(w2, p2, bot2)).toBe(G.WorkerFail.None);
    expect(G.setWorkerJob(w2, p2, bot2, G.WorkerJob.Defend)).toBe(G.WorkerFail.None);
    const z2 = G.spawnZombie(w2, "zombie_walker", 8, 0);
    G.applyDamage(w2, bot2, 5, p2);
    const v2 = G.buildAgentView(w2, bot2, agent2, { x: 0, y: 0 })!;
    expect(G.trustOf(agent2, 7)).toBe(-0.3); // the hire was remembered (+0.2) before the blow (-0.5)
    expect(v2.world.defend).toBeUndefined(); // distrusted: will not chase a far threat
    expect(z2).toBeGreaterThan(0);
  });
});
