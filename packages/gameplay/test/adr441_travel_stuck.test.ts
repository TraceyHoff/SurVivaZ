// ADR-441: a bot pushing at an unreachable travel leg must be detected and
// re-planned / ended well before the 60-game-minute goal timeout.
//
// The ADR-385 freeze, replayed on a travel leg: the bot stands at (10.5, 10.5),
// its route waypoint sits across a +6 ridge at x = 13 (max unaided climb 3),
// and the local nav can only walk it to the closest reachable tile at the
// ridge foot. Before the fix travelRun has no progress check at all —
// travel.json "stuckRepathTicks": 200 is referenced nowhere in any .ts source
// — so the bot's displacement stays 0.0 until the 72000-tick timeout.
import { describe, expect, it } from "vitest";
import { TileMap } from "@engine/world";
import { idleOutput, installPermissions, NetId, PlayerId, Transform, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { aiMemoryOf } from "../src/ai/planner.js";
import { DT, makeWorld, spawnLearned } from "./helpers.js";

const T = G.TRAVEL;
let nid = 9100;
type Mem = { travel?: G.TravelState; travelAt?: number; resourceBanned?: { x: number; y: number; at: number }[] };
interface Rig { w: World; p: Entity; a: Agent; home: { x: number; y: number } }

/** Flat land with a +6 ridge wall at x = 13, y -20..40 (ADR-385's ridgeWorld). */
function ridgeRig(kind: G.TravelKind, destX: number): Rig {
  const w = makeWorld();
  installPermissions(w);
  if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const map = new TileMap();
  for (let y = -30; y <= 50; y++) for (let x = -30; x <= 50; x++) map.setTile(x, y, 3);
  w.setResource(G.TerrainRes, G.terrainFromTileMap(map));
  const p = spawnLearned(w, { x: 10.5, y: 10.5, maxWeight: 0, clientId: 7 });
  w.add(p, PlayerId, { id: 7 });
  w.add(p, NetId, { id: ++nid });
  for (let y = -20; y <= 40; y++) G.setTerrainDig(w, 13, y, 6);
  const a = G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1);
  const m = aiMemoryOf(a) as unknown as Mem;
  // A single-leg route straight across the ridge (no region detour can be
  // expressed for it: the goal region is exempt from the avoid set, so a
  // re-plan around this leg returns the same waypoint — see travel.ts).
  m.travel = { kind, x: destX, y: 10.5, since: 0, leg: 0, origin: { x: 10.5, y: 10.5 }, route: [{ x: destX, y: 10.5 }] };
  return { w, p, a, home: { x: 10.5, y: 10.5 } };
}
const mem = (r: Rig): Mem => aiMemoryOf(r.a) as unknown as Mem;
type Ctx = AgentContext<G.AgentWorldView>;
const ctxOf = (r: Rig): Ctx => { const v = G.buildAgentView(r.w, r.p, r.a, r.home)!; return { self: v.self, bb: r.a.bb, memory: r.a.memory, traits: r.a.identity.traits, rng: r.a.rng, agent: r.a, world: v.world }; };
const out = (): AgentOutput => ({ ...idleOutput(), actions: [] as string[] });
const pos = (r: Rig): { x: number; y: number } => r.w.get(r.p, Transform)!;
function move(r: Rig, o: AgentOutput): void {
  let bits = 0; const len = Math.hypot(o.moveX, o.moveY);
  if (len > 1e-6) { if (o.moveX > 0.38 * len) bits |= G.GameplayActions.MoveRight; else if (o.moveX < -0.38 * len) bits |= G.GameplayActions.MoveLeft; if (o.moveY > 0.38 * len) bits |= G.GameplayActions.MoveDown; else if (o.moveY < -0.38 * len) bits |= G.GameplayActions.MoveUp; }
  G.applyMovementInput(r.w, r.p, bits, DT);
}
const fed = (r: Rig): void => { r.w.set(r.p, G.Survival, { hunger: 100, thirst: 100 }); };
/** Run the travel behaviour until the trip ends or maxTicks elapse; returns ticks run. */
function runTravel(r: Rig, maxTicks: number): number {
  const b = G.travelBehaviors()[0]!;
  let ticks = 0;
  for (; ticks < maxTicks; ticks++) {
    if (!mem(r).travel) break;
    const c = ctxOf(r); if (!c.world.travel?.route) break;
    const o = out(); b.run(c, o); move(r, o); r.w.step(DT); fed(r);
    if (!mem(r).travel) break;
  }
  return ticks;
}

describe("ADR-441 travel stuck detection", () => {
  it("a resource trip across an uncrossable ridge ends and bans the destination well before the 72000-tick timeout", () => {
    const r = ridgeRig("resource", 30.5);
    const start = { ...pos(r) };
    const ticks = runTravel(r, 12000);
    expect(mem(r).travel).toBeUndefined(); // ended, not still pushing at the ridge
    expect(ticks).toBeLessThan(12000);
    expect(ticks).toBeLessThan(T.goalTimeoutTicks);
    // the bot walked to the ridge foot and stopped there (it never crossed)
    expect(pos(r).x).toBeGreaterThan(start.x);
    expect(pos(r).x).toBeLessThan(13);
    // endTravel(false) on a resource trip bans the destination, so the next
    // prospect goes to the next-nearest source instead of retrying this one
    expect(mem(r).resourceBanned?.some((b) => b.x === 30.5 && b.y === 10.5)).toBe(true);
  });

  it("a non-resource trip across the same ridge also ends instead of freezing", () => {
    const r = ridgeRig("explore", 30.5);
    const ticks = runTravel(r, 12000);
    expect(mem(r).travel).toBeUndefined();
    expect(ticks).toBeLessThan(12000);
    expect(pos(r).x).toBeLessThan(13);
  });

  it("a bot that keeps moving — even slowly — is never flagged stuck", () => {
    // Unit-level pin of the progress check itself: a bot closing 0.6 tiles
    // every 150 ticks (far slower than any real walk, swim or wade) never
    // trips a 200-tick window, while a frozen bot trips it once.
    const tr: G.TravelState = { kind: "explore", x: 100, y: 0, since: 0, leg: 0, origin: { x: 0, y: 0 }, route: [{ x: 100, y: 0 }] };
    let x = 0;
    for (let tick = 0; tick < 2000; tick++) {
      if (tick % 150 === 0 && tick > 0) x += 0.6;
      expect(G.travelStuckCheck(tr, x, 0, tick)).toBe(false);
    }
    const frozen: G.TravelState = { kind: "explore", x: 100, y: 0, since: 0, leg: 0, origin: { x: 0, y: 0 }, route: [{ x: 100, y: 0 }] };
    let firedAt = -1;
    for (let tick = 0; tick < 1000; tick++) {
      if (G.travelStuckCheck(frozen, 0, 0, tick)) { firedAt = tick; break; }
    }
    expect(firedAt).toBeGreaterThan(0);
    expect(firedAt).toBeLessThanOrEqual(T.stuckRepathTicks + 1);
  });

  it("a gap in travel ticks restarts the window instead of firing on stale data", () => {
    // The behaviour can be deselected for a while (fleeing, off-screen
    // hand-back); progress counted across that gap would be meaningless.
    const tr: G.TravelState = { kind: "explore", x: 100, y: 0, since: 0, leg: 0, origin: { x: 0, y: 0 }, route: [{ x: 100, y: 0 }] };
    for (let tick = 0; tick < 150; tick++) expect(G.travelStuckCheck(tr, 0, 0, tick)).toBe(false);
    // 100 ticks pass with no travelRun call at all, then it resumes frozen:
    // the stale anchor must not fire immediately.
    expect(G.travelStuckCheck(tr, 0, 0, 250)).toBe(false);
    expect(G.travelStuckCheck(tr, 0, 0, 251)).toBe(false);
  });
});
