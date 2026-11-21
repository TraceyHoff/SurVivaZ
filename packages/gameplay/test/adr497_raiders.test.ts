/**
 * ADR-497: raiders probe your defences. fillClanSensors gains a cached weakest-wall probe (the
 * homeScan pattern: radius 20 around the rival stall, 30-tick cache); chooseClanGoal stays pure
 * and prefers the weak wall over the stall; a new clan_raid behaviour walks to the wall and
 * breaches it (attack:<pieceId> within 1.4 tiles, one swing per 10 ticks), re-picking the
 * next-weakest after a breach and falling back to the stall (clan_goal) when no walls remain.
 * Doorways count as walls; ties break toward the lowest max HP.
 */
import { describe, expect, it } from "vitest";
import { idleOutput, installPermissions, Membership, PlayerId, Transform, type AgentContext, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

const d = G.defaultDefs();
function setup() {
  const w = makeWorld(); installPermissions(w); G.installEconomy(w);
  const mk = (i: number, x: number) => { const e = G.spawnPlayer(w, { x, y: 0, maxWeight: 0, clientId: i }); w.add(e, PlayerId, { id: i }).add(e, Membership, { partyId: 0, clanId: 0 }); return e; };
  const agent = G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1);
  return { w, a: mk(1, 0), b: mk(2, 3), rival: mk(3, 12), agent };
}
const ctx = (w: World, p: Entity, agent: ReturnType<typeof setup>["agent"], tick?: number): AgentContext<G.AgentWorldView> => {
  const v = G.buildAgentView(w, p, agent, { x: 0, y: 0 })!; return { ...v, self: { ...v.self, tick: tick ?? v.self.tick }, bb: agent.bb, memory: agent.memory, traits: agent.identity.traits, rng: agent.rng, agent };
};
const beh = (n: string) => G.clanBehaviors().find((b) => b.name === n)!;
const run = (n: string, c: AgentContext<G.AgentWorldView>) => { const o = idleOutput(); beh(n).run(c, o); return o; };
const want = (n: string, c: AgentContext<G.AgentWorldView>) => beh(n).considerations[0]!.input(c);
const T = (s = 0.5, ind = 0.5, greed = 0.5, brave = 0.5) => ({ bravery: brave, sociability: s, greed, industriousness: ind, chattiness: 0.5 });
const snap = (w: World, key: string, x = 1, y = 1) => { const sn = G.snapPlacement(w, { piece: d.pieceId(key), x, y, level: 0, rot: 0, tier: 0, variant: 0 }); if (typeof sn === "number") throw new Error(`snap ${sn}`); return sn; };
const at = (w: World, e: Entity): { x: number; y: number } => { const t = w.get(e, Transform)!; return { x: t.x, y: t.y }; };
/** Place a wall for the rival and set its HP to a fraction of its max. */
const wall = (w: World, owner: Entity, key: string, x: number, y: number, frac: number): Entity => {
  const e = G.placePiece(w, owner, snap(w, key, x, y), { pay: false });
  w.setField(e, G.BuildPiece, "hp", Math.round(G.maxHpOf(w, e) * frac));
  return e;
};
/** A rival base: a player-owned stall plus walls around it. Returns the stall + wall entities. */
function rivalBase(w: World, rival: Entity) {
  const stallPiece = G.placePiece(w, rival, snap(w, "stall_booth", 12, 1), { pay: false });
  const st = G.stallOf(w, stallPiece)!;
  G.setStallOwnership(w, st, G.tillOf(w, st), G.StallOwnerKind.Player, 3);
  const full = wall(w, rival, "wall", 10, 2, 1);
  const weak = wall(w, rival, "wall", 14, 2, 0.3);
  const door = wall(w, rival, "wall_doorway", 12, 4, 1);
  const low = wall(w, rival, "wall_low", 16, 1, 1);
  return { st, full, weak, door, low };
}
function clanOf(w: World, a: Entity, b: Entity) {
  G.clanCreate(w, a); const clan = G.clanOf(w, 1); G.clanInvite(w, a, b); G.clanAccept(w, b, clan); return clan;
}

describe("ADR-497 raiders probe your defences", () => {
  it("the probe finds the weakest wall by HP fraction; doorways count; ties break toward the lowest max HP", () => {
    const { w, a, rival, agent } = setup();
    const { weak, door, low } = rivalBase(w, rival);
    const c = ctx(w, a, agent);
    expect(c.world.rivalStall).toBeDefined();
    expect(c.world.rivalWeakWall).toMatchObject({ id: weak });
    expect(c.world.rivalWeakWall!.hpFrac).toBeCloseTo(0.3, 2);
    // The scan is cached: damaging another wall inside the window does not move the probe.
    w.setField(door, G.BuildPiece, "hp", Math.round(G.maxHpOf(w, door) * 0.1));
    expect(ctx(w, a, agent).world.rivalWeakWall).toMatchObject({ id: weak });
    // Past the 30-tick cache the damaged doorway (now the weakest) is picked — doorways count.
    // (Its frac reads ~0.09, not exactly 0.1: the 31 stepped ticks chip a little HP off the
    // unsupported test walls via stability. The pick, not the exact frac, is the assertion.)
    steps(w, 31);
    expect(ctx(w, a, agent).world.rivalWeakWall).toMatchObject({ id: door });
    expect(ctx(w, a, agent).world.rivalWeakWall!.hpFrac).toBeLessThan(0.3);
    // Destroy the doorway: the next-weakest is the damaged wall again; with only full-HP walls left
    // the wall_low wins the tie (lowest max HP).
    w.destroy(door); w.destroy(weak);
    expect(ctx(w, a, agent).world.rivalWeakWall).toMatchObject({ id: low });
    // No walls left in radius: no probe target.
    for (const e of w.query([G.BuildPiece])) if (G.gameplayDefs(w).pieces.get(w.getField(e, G.BuildPiece, "type")!)?.family === "wall") w.destroy(e);
    expect(ctx(w, a, agent).world.rivalWeakWall).toBeUndefined();
  });

  it("weakestWallNear is a cached scan: same tick returns the cached wall, past probeEvery it re-picks", () => {
    const { w, rival } = setup();
    const { weak, door } = rivalBase(w, rival);
    const centre = at(w, weak);
    const first = G.weakestWallNear(w, centre.x, centre.y);
    expect(first).toMatchObject({ id: weak });
    w.setField(door, G.BuildPiece, "hp", Math.round(G.maxHpOf(w, door) * 0.1));
    expect(G.weakestWallNear(w, centre.x, centre.y)).toMatchObject({ id: weak }); // cached
    steps(w, 31);
    expect(G.weakestWallNear(w, centre.x, centre.y)).toMatchObject({ id: door }); // re-picked
    // A destroyed cached wall invalidates at once (no waiting for the cache to expire).
    w.destroy(door);
    expect(G.weakestWallNear(w, centre.x, centre.y)).toMatchObject({ id: weak });
  });

  it("chooseClanGoal raids the weak wall, not the stall — and still raids the stall with no wall sensed", () => {
    const base = { x: 1, y: 2 };
    const brave = T(0.5, 0.5, 0.9, 0.9);
    expect(G.chooseClanGoal(brave, { threats: 0, rival: { x: 9, y: 9, weakWall: { x: 7, y: 8 } }, hasStall: false, base, current: 0 }))
      .toEqual({ goal: G.ClanGoal.Raid, x: 7, y: 8 });
    expect(G.chooseClanGoal(brave, { threats: 0, rival: { x: 9, y: 9 }, hasStall: false, base, current: 0 }))
      .toEqual({ goal: G.ClanGoal.Raid, x: 9, y: 9 });
    // Threats still outrank the raid.
    expect(G.chooseClanGoal(brave, { threats: 3, rival: { x: 9, y: 9, weakWall: { x: 7, y: 8 } }, hasStall: false, base, current: 0 }).goal)
      .toBe(G.ClanGoal.Defend);
  });

  it("the leader sets the raid goal on the weak wall; the raid behaviour walks there and breaches it", () => {
    const { w, a, b, rival, agent } = setup();
    agent.identity.traits = T(0.5, 0.5, 0.9, 0.9);
    clanOf(w, a, b);
    const { weak } = rivalBase(w, rival);
    const wp = at(w, weak);
    const manage = G.emitAgentCommands(run("clan_manage", ctx(w, a, agent, 0)));
    const goal = manage.commands?.find((c) => c.type === "gameplay.clanSetGoal");
    expect(goal?.payload).toEqual({ goal: G.ClanGoal.Raid, x: wp.x, y: wp.y });
    G.clanSetGoal(w, a, G.ClanGoal.Raid, wp.x, wp.y);
    // The raid behaviour owns the raid while a weak wall is sensed; clan_goal yields.
    expect(want("clan_raid", ctx(w, a, agent))).toBe(1);
    expect(want("clan_goal", ctx(w, a, agent))).toBe(0);
    // Far away: the raider walks toward the wall, no attack yet.
    const far = run("clan_raid", ctx(w, a, agent));
    expect(far.moveX).toBeGreaterThan(0);
    expect(far.actions).not.toContain(`attack:${weak}`);
    // Beside the wall: the raider swings at it (one swing per 10 ticks).
    w.set(a, Transform, { x: wp.x - 1, y: wp.y });
    const near = run("clan_raid", ctx(w, a, agent, 100));
    expect(near.actions).toContain(`attack:${weak}`);
    const again = run("clan_raid", ctx(w, a, agent, 100));
    expect(again.actions).not.toContain(`attack:${weak}`);
    // After the breach the next-weakest is picked; with no walls left the raid falls back to clan_goal.
    w.destroy(weak);
    const re = ctx(w, a, agent);
    expect(re.world.rivalWeakWall).toBeDefined();
    expect(re.world.rivalWeakWall!.id).not.toBe(weak);
    for (const e of w.query([G.BuildPiece])) if (G.gameplayDefs(w).pieces.get(w.getField(e, G.BuildPiece, "type")!)?.family === "wall") w.destroy(e);
    const gone = ctx(w, a, agent);
    expect(gone.world.rivalWeakWall).toBeUndefined();
    expect(want("clan_raid", gone)).toBe(0);
    // Fallback: with no walls left the raid is over and the bot walks to the goal (the stall) again.
    // (The leader is standing beside the old wall here, inside goalRadius — move it away first.)
    w.set(a, Transform, { x: 0, y: 0 });
    expect(want("clan_goal", ctx(w, a, agent))).toBe(1);
  });
});
