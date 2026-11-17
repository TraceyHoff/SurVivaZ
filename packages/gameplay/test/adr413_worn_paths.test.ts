// ADR-413: AI humans wear paths into roads on routes they travel often (ai/worn_paths.ts).
import { describe, expect, it } from "vitest";
import { idleOutput, installPermissions, NetId, PlayerId, Transform, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { aiMemoryOf } from "../src/ai/planner.js";
import { DT, makeWorld, spawnLearned } from "./helpers.js";

let nid = 9100;
interface Rig { w: World; p: Entity; a: Agent; home: { x: number; y: number } }
function rig(): Rig {
  const w = makeWorld({}, 42); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }); w.add(p, PlayerId, { id: 7 }); w.add(p, NetId, { id: ++nid });
  const a = G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1);
  return { w, p, a, home: { x: 0, y: 0 } };
}
type Mem = { travel?: G.TravelState; travelAt?: number };
const mem = (r: Rig): Mem => aiMemoryOf(r.a) as unknown as Mem;
const HOME = { x: 0, y: 0 }, DEST = { x: 40, y: 0 };
/** One completed trip home -> destination, as endTravel records it on arrival. */
const trip = (r: Rig): void => {
  mem(r).travel = { kind: "explore", x: DEST.x, y: DEST.y, since: r.w.tick, leg: 0, origin: { ...HOME } };
  G.endTravel(r.a, r.w.tick, true);
};
const roadTiles = (r: Rig): number => {
  let n = 0;
  for (const e of r.w.query([G.Road, Transform])) if (r.w.getField(e, G.Road, "surface") === G.RoadSurface.Path) n++;
  return n;
};
type Ctx = AgentContext<G.AgentWorldView>;
const ctxOf = (r: Rig): Ctx => { const v = G.buildAgentView(r.w, r.p, r.a, r.home)!; return { self: v.self, bb: r.a.bb, memory: r.a.memory, traits: r.a.identity.traits, rng: r.a.rng, agent: r.a, world: v.world }; };
const out = (): AgentOutput => ({ ...idleOutput(), actions: [] as string[] });
const pos = (r: Rig): { x: number; y: number } => r.w.get(r.p, Transform)!;
function move(r: Rig, o: AgentOutput): void {
  let bits = 0; const len = Math.hypot(o.moveX, o.moveY);
  if (len > 1e-6) { if (o.moveX > 0.38 * len) bits |= G.GameplayActions.MoveRight; else if (o.moveX < -0.38 * len) bits |= G.GameplayActions.MoveLeft; if (o.moveY > 0.38 * len) bits |= G.GameplayActions.MoveDown; else if (o.moveY < -0.38 * len) bits |= G.GameplayActions.MoveUp; }
  G.applyMovementInput(r.w, r.p, bits, DT);
}

describe("ADR-413 worn paths", () => {
  it("repeated trips on the same route form a visible dirt path (owner-0 Path road tiles along the line)", () => {
    const r = rig();
    trip(r); trip(r);
    expect(G.wornTrips(r.a, HOME, DEST)).toBe(2);
    expect(G.maybeFormWornPath(r.w, r.p, r.a, HOME, DEST)).toBe(0); // not worn enough yet
    expect(roadTiles(r)).toBe(0);
    trip(r);
    expect(G.wornTrips(r.a, HOME, DEST)).toBe(3);
    const laid = G.maybeFormWornPath(r.w, r.p, r.a, HOME, DEST);
    expect(laid).toBeGreaterThan(30); // the 40-tile line, minus any water/claimed skips
    expect(roadTiles(r)).toBe(laid);
    // the tiles are real road entities: Path surface, worn (owner 0), auto-connected masks
    for (const tx of [5, 20, 35]) {
      const e = G.roadAt(r.w, tx, 0); expect(e).toBeDefined();
      expect(r.w.getField(e!, G.Road, "surface")).toBe(G.RoadSurface.Path);
      expect(r.w.getField(e!, G.Road, "owner")).toBe(0);
    }
    // forming again lays nothing — the path is already there
    expect(G.maybeFormWornPath(r.w, r.p, r.a, HOME, DEST)).toBe(0);
    expect(roadTiles(r)).toBe(laid);
  });

  it("a rarely-travelled route does NOT form a road, and short hops never count", () => {
    const r = rig();
    trip(r); trip(r); // two trips: below the threshold
    expect(G.maybeFormWornPath(r.w, r.p, r.a, HOME, DEST)).toBe(0);
    expect(roadTiles(r)).toBe(0);
    // a failed trip does not count either
    mem(r).travel = { kind: "explore", x: DEST.x, y: DEST.y, since: r.w.tick, leg: 0, origin: { ...HOME } };
    G.endTravel(r.a, r.w.tick, false);
    expect(G.wornTrips(r.a, HOME, DEST)).toBe(2);
    // hops under WORN_PATH_MIN_TILES never count, however often repeated
    const near = { x: 3, y: 0 };
    for (let i = 0; i < 5; i++) G.recordWornTrip(r.a, HOME, near, r.w.tick);
    expect(G.wornTrips(r.a, HOME, near)).toBe(0);
  });

  it("the path is used on later trips: route assignment follows the road tiles, and the bot walks them home", () => {
    const r = rig();
    trip(r); trip(r); trip(r);
    expect(G.maybeFormWornPath(r.w, r.p, r.a, HOME, DEST)).toBeGreaterThan(0);
    const wp = G.wornPathWaypoints(r.w, HOME, DEST);
    expect(wp).toBeDefined();
    expect(wp!.every((p) => G.roadAt(r.w, Math.floor(p.x), Math.floor(p.y)) !== undefined)).toBe(true);
    // a fresh trip to the same destination is routed along the path, not the region centres
    mem(r).travelAt = -1e9; G.orderTravel(r.a, DEST.x, DEST.y, r.w.tick);
    const c = ctxOf(r); const tr = mem(r).travel!;
    expect(tr.route).toBeDefined();
    expect(tr.route!.every((p) => G.roadAt(r.w, Math.floor(p.x), Math.floor(p.y)) !== undefined)).toBe(true);
    // …and the bot actually walks the path to the goal
    const b = G.travelBehaviors()[0]!; let done = false;
    for (let i = 0; i < 6000 && !done; i++) {
      const cc = ctxOf(r); const o = out();
      if (cc.world.travel?.route) { b.run(cc, o); G.mountPolicy(cc, o, "travel"); }
      move(r, o); r.w.step(DT); r.w.set(r.p, G.Survival, { hunger: 100, thirst: 100 });
      if (!mem(r).travel) done = true;
    }
    expect(done).toBe(true);
    expect(Math.hypot(pos(r).x - DEST.x, pos(r).y - DEST.y)).toBeLessThanOrEqual(G.TRAVEL.arriveTiles + 0.5);
  });

  it("the worn route and its path persist across a save/load round-trip", () => {
    const r = rig();
    trip(r); trip(r); trip(r);
    expect(G.maybeFormWornPath(r.w, r.p, r.a, HOME, DEST)).toBeGreaterThan(0);
    // the counts live in AiMemory, which goes through JSON like game.agents (flushAiMemory)
    const id = JSON.parse(JSON.stringify(r.a.identity));
    const a2 = G.makeAgent(id, 1);
    expect(G.wornTrips(a2, HOME, DEST)).toBe(3);
    expect(G.wornTrips(a2, DEST, HOME)).toBe(3); // the return leg is the same route
    // the reloaded bot still sees (and would still walk) the same path — nothing to re-form
    expect(G.wornPathWaypoints(r.w, HOME, DEST)).toBeDefined();
    expect(G.maybeFormWornPath(r.w, r.p, a2, HOME, DEST)).toBe(0);
    // the road tiles themselves survive restarts through the Road component's persistence contract
    // (networked + persistent, chunk codec like Crop — ADR-119); no new schema, no migration.
    expect(G.Road.networked).toBe(true);
    expect(G.Road.persistent).toBe(true);
  });

  it("route memory is capped per bot (least-travelled evicted first)", () => {
    const r = rig();
    for (let i = 0; i < 12; i++) G.recordWornTrip(r.a, HOME, { x: 10 + i * 10, y: 50 }, r.w.tick);
    const routes = (aiMemoryOf(r.a) as unknown as { wornRoutes: { trips: number }[] }).wornRoutes;
    expect(routes.length).toBeLessThanOrEqual(G.WORN_PATH_MAX_ROUTES_PER_AI);
    // a well-travelled route survives eviction of one-off routes
    for (let i = 0; i < 5; i++) G.recordWornTrip(r.a, HOME, DEST, r.w.tick);
    for (let i = 0; i < 9; i++) G.recordWornTrip(r.a, HOME, { x: 200 + i * 10, y: 60 }, r.w.tick);
    expect(G.wornTrips(r.a, HOME, DEST)).toBe(5);
    expect((aiMemoryOf(r.a) as unknown as { wornRoutes: unknown[] }).wornRoutes.length).toBeLessThanOrEqual(G.WORN_PATH_MAX_ROUTES_PER_AI);
  });
});
