// ADR-345: AI humans navigate through / around water (ai/travel.ts, ai/water_crossing.ts).
// Before: a bot on a travel leg walked straight into deep water and swam across it — a 40-wide lake cost
// nothing but time at swim speed, soaked (Wetness 255), with no stamina cost and no danger check (probe,
// since deleted: a straight route across a lake arrived wet and alive; the region router only avoids
// all-water regions). Now legs are profiled by depth (shallow = ford, deep = swim): a fit bot fords and
// swims short deep runs, a cold / tired bot waits at the bank, a too-long deep run or deep water under a
// non-swimming mount re-plans around, and off-screen legs cross water at wade / swim speed with wetness
// and swim stamina costed in — never teleported across.
import { describe, expect, it } from "vitest";
import { idleOutput, installPermissions, NetId, PlayerId, Transform, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import { ProceduralGenerator, TileMap, WaterDepth, waterDepthAt } from "@engine/world";
import * as G from "../src/index.js";
import { aiMemoryOf } from "../src/ai/planner.js";
import { DT, makeWorld, spawnLearned } from "./helpers.js";

const T = G.TRAVEL;
const W = G.WATER_DATA;
const SPEEDS: G.CrossingSpeeds = { foot: T.offscreen.speedTilesPerSec, ride: T.offscreen.mountSpeedTilesPerSec, wadeMul: 0.7, swimMul: 0.35 };
let nid = 9600;
interface Rig { w: World; p: Entity; a: Agent; home: { x: number; y: number } }
function rig(): Rig {
  const w = makeWorld({}, 42); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const p = spawnLearned(w, { x: 0, y: 0, maxWeight: 0, clientId: 7 }); w.add(p, PlayerId, { id: 7 }); w.add(p, NetId, { id: ++nid });
  const a = G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1);
  return { w, p, a, home: { x: 0, y: 0 } };
}
type Mem = { travel?: G.TravelState; travelAt?: number };
const mem = (r: Rig): Mem => aiMemoryOf(r.a) as unknown as Mem;
const ctxOf = (r: Rig): AgentContext<G.AgentWorldView> => {
  const v = G.buildAgentView(r.w, r.p, r.a, r.home)!;
  return { self: v.self, bb: r.a.bb, memory: r.a.memory, traits: r.a.identity.traits, rng: r.a.rng, agent: r.a, world: v.world };
};
const out = (): AgentOutput => ({ ...idleOutput(), actions: [] as string[] });
const pos = (r: Rig): { x: number; y: number } => r.w.get(r.p, Transform)!;
const fed = (r: Rig): void => { r.w.set(r.p, G.Survival, { hunger: 100, thirst: 100 }); };
function move(r: Rig, o: AgentOutput): void {
  let bits = 0; const len = Math.hypot(o.moveX, o.moveY);
  if (len > 1e-6) { if (o.moveX > 0.38 * len) bits |= G.GameplayActions.MoveRight; else if (o.moveX < -0.38 * len) bits |= G.GameplayActions.MoveLeft; if (o.moveY > 0.38 * len) bits |= G.GameplayActions.MoveDown; else if (o.moveY < -0.38 * len) bits |= G.GameplayActions.MoveUp; }
  G.applyMovementInput(r.w, r.p, bits, DT);
}
/** Drive the travel behaviour (+ the ADR-321 mount policy) for up to n ticks; `each` runs after every step. */
function driveTravel(r: Rig, n: number, until: () => boolean, each?: (i: number) => void): number {
  const b = G.travelBehaviors()[0]!;
  for (let i = 0; i < n; i++) {
    const c = ctxOf(r); const o = out();
    if (c.world.travel?.route) { b.run(c, o); G.mountPolicy(c, o, "travel"); }
    move(r, o); r.w.step(DT); fed(r); each?.(i);
    if (until()) return i;
  }
  return -1;
}
/** Land tile 3 over x -32..128, y -48..48, with water tile 1 in the given x band (and y band, default all). */
function waterMap(x0: number, x1: number, y0 = -48, y1 = 48): TileMap {
  const map = new TileMap();
  for (let y = -48; y <= 48; y++) for (let x = -32; x <= 128; x++) map.setTile(x, y, 3);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) map.setTile(x, y, 1);
  return map;
}
const loadWater = (r: Rig, map: TileMap): void => { r.w.setResource(G.TerrainRes, G.terrainFromTileMap(map)); };
/** Distance from `from` to `p` along the route polyline (adr324's measure: a detouring bot advances along its legs).
 *  The closest leg decides: a point before a leg's start must not read as its start's along-distance. */
function alongRoute(route: { x: number; y: number }[], from: { x: number; y: number }, p: { x: number; y: number }): number {
  let base = 0, bestOff = Infinity, bestAlong = 0, px = from.x, py = from.y;
  for (const wp of route) {
    const dx = wp.x - px, dy = wp.y - py, len2 = dx * dx + dy * dy, len = Math.sqrt(len2);
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - px) * dx + (p.y - py) * dy) / len2)) : 0;
    const off = Math.hypot(p.x - (px + dx * t), p.y - (py + dy * t));
    if (off < bestOff) { bestOff = off; bestAlong = base + len * t; }
    base += len; px = wp.x; py = wp.y;
  }
  return bestAlong;
}
const fitBot = (over: Partial<G.CrossingBot> = {}): G.CrossingBot =>
  ({ riding: false, mountSwims: false, hp: 1, hunger: 1, thirst: 1, stamina: 100, staminaMax: 100, cold: false, ...over });
/** Put the bot on its own mount of `speciesKey` (tamed, next to it) and ride it. */
function mountUp(r: Rig, speciesKey: string): Entity {
  const species = G.mountSpeciesOfKey(speciesKey);
  const m = G.spawnAnimal(r.w, `animal_${speciesKey === "red_deer" ? "red_deer" : speciesKey}`, 1, 0);
  r.w.add(m, NetId, { id: ++nid });
  r.w.add(m, G.Mount, { species, owner: 7 });
  expect(G.rideMount(r.w, r.p, m)).toBe(true);
  expect(r.w.has(r.p, G.Riding)).toBe(true);
  return m;
}

describe("ADR-345 depth sampling", () => {
  it("regionSampleDepth tells shallow from deep on loaded terrain", () => {
    const r = rig(); loadWater(r, waterMap(48, 57)); // 10-wide river: edges shallow, middle deep
    expect(G.regionSampleDepth(r.w, 49, 0)).toBe(WaterDepth.Shallow);
    expect(G.regionSampleDepth(r.w, 52, 0)).toBe(WaterDepth.Deep);
    expect(G.regionSampleDepth(r.w, 56, 0)).toBe(WaterDepth.Shallow);
    expect(G.regionSampleDepth(r.w, 0, 0)).toBe(WaterDepth.None);
    expect(G.regionSampleDepth(r.w, 49, 0)).toBe(G.waterDepth(r.w, 49, 0)); // agrees with the movement helper
  });
  it("regionSampleDepth reads unloaded terrain from the seeded generator, like regionSampleWater", () => {
    const w = makeWorld({}, 42), gen = new ProceduralGenerator({ seed: 42 }); // no TerrainRes at all
    for (let y = -16; y <= 16; y++) for (let x = -16; x <= 16; x++) {
      const want = waterDepthAt((ax, ay) => gen.tileAt(ax, ay), x, y, 2);
      expect(G.regionSampleDepth(w, x, y)).toBe(want);
    }
  });
  it("legWaterProfile counts a ford, a river and a lake differently", () => {
    const r = rig(); loadWater(r, waterMap(48, 50)); // 3-wide ford: all shallow
    const ford = G.legWaterProfile(r.w, 0, 0, 96, 0);
    expect(ford.deep).toBe(0); expect(ford.shallow).toBeGreaterThan(0); expect(ford.maxDeepRun).toBe(0);
    loadWater(r, waterMap(48, 57)); // 10-wide river: ~6 deep in the middle
    const river = G.legWaterProfile(r.w, 0, 0, 96, 0);
    expect(river.deep).toBeGreaterThan(0); expect(river.deep).toBeLessThan(10); expect(river.maxDeepRun).toBeGreaterThan(0);
    expect(river.maxDeepRun).toBeLessThanOrEqual(W.swimMaxDeepTiles);
    loadWater(r, waterMap(48, 88, -20, 20)); // 40-wide lake
    const lake = G.legWaterProfile(r.w, 0, 0, 96, 0);
    expect(lake.maxDeepRun).toBeGreaterThan(W.swimMaxDeepTiles);
    expect(G.legWaterProfile(r.w, 0, 0, 40, 0).deep).toBe(0); // a dry leg has no water at all
  });
});

describe("ADR-345 crossing decisions", () => {
  it("a ford is always crossable; a short deep run is a swim when fit", () => {
    const ford: G.WaterProfile = { tiles: 10, dry: 7, shallow: 3, deep: 0, maxDeepRun: 0, firstDeep: Infinity, firstWet: 7 };
    expect(G.decideCrossing(ford, fitBot({ cold: true }), SPEEDS)).toBe("ford"); // cold does not bar a ford
    const river: G.WaterProfile = { tiles: 20, dry: 10, shallow: 4, deep: 6, maxDeepRun: 6, firstDeep: 10, firstWet: 10 };
    expect(G.decideCrossing(river, fitBot(), SPEEDS)).toBe("swim");
    expect(G.staminaNeeded(river, false, SPEEDS)).toBeCloseTo(6 / (2.6 * 0.35) * W.swimStaminaPerSec, 6);
  });
  it("a cold, hurt, hungry, thirsty or low-stamina bot waits instead of swimming", () => {
    const river: G.WaterProfile = { tiles: 20, dry: 10, shallow: 4, deep: 6, maxDeepRun: 6, firstDeep: 10, firstWet: 10 };
    expect(G.decideCrossing(river, fitBot({ cold: true }), SPEEDS)).toBe("wait");
    expect(G.decideCrossing(river, fitBot({ hp: 0.2 }), SPEEDS)).toBe("wait");
    expect(G.decideCrossing(river, fitBot({ hunger: 0.2 }), SPEEDS)).toBe("wait");
    expect(G.decideCrossing(river, fitBot({ thirst: 0.2 }), SPEEDS)).toBe("wait");
    expect(G.decideCrossing(river, fitBot({ stamina: 10 }), SPEEDS)).toBe("wait"); // 6 deep tiles need ~8 pts x margin 1.5
    expect(G.decideCrossing(river, fitBot({ stamina: 10, staminaMax: 100 }), SPEEDS)).toBe("wait");
    expect(G.decideCrossing(river, fitBot({ stamina: 30 }), SPEEDS)).toBe("swim");
  });
  it("a deep run longer than the bot can swim routes around", () => {
    const lake: G.WaterProfile = { tiles: 60, dry: 20, shallow: 0, deep: 40, maxDeepRun: 40, firstDeep: 20, firstWet: 20 };
    expect(G.decideCrossing(lake, fitBot(), SPEEDS)).toBe("around");
    expect(G.structuralCrossing(lake, false, false)).toBe("around");
  });
  it("a riding bot stays mounted across swimmable water, and a non-swimming mount never goes into deep water", () => {
    const river: G.WaterProfile = { tiles: 30, dry: 16, shallow: 4, deep: 10, maxDeepRun: 10, firstDeep: 16, firstWet: 16 };
    expect(G.decideCrossing(river, fitBot({ riding: true, mountSwims: true }), SPEEDS)).toBe("ride");
    expect(G.decideCrossing(river, fitBot({ riding: true, mountSwims: false }), SPEEDS)).toBe("around");
    const shallows: G.WaterProfile = { tiles: 10, dry: 7, shallow: 3, deep: 0, maxDeepRun: 0, firstDeep: Infinity, firstWet: 7 };
    expect(G.decideCrossing(shallows, fitBot({ riding: true, mountSwims: false }), SPEEDS)).toBe("ride"); // mounts wade shallows
    const longSwim: G.WaterProfile = { tiles: 50, dry: 26, shallow: 4, deep: 20, maxDeepRun: 20, firstDeep: 26, firstWet: 26 };
    expect(G.decideCrossing(longSwim, fitBot({ riding: true, mountSwims: true }), SPEEDS)).toBe("ride"); // a swimming mount swims further
    expect(G.decideCrossing(longSwim, fitBot(), SPEEDS)).toBe("around"); // the same run is too long on foot
  });
  it("waterSeconds costs a wet leg in water time, not leg time", () => {
    const leg: G.WaterProfile = { tiles: 24, dry: 14, shallow: 4, deep: 6, maxDeepRun: 6, firstDeep: 14, firstWet: 14 };
    // 4 shallow tiles at 2.6 x 0.7 + 6 deep tiles at 2.6 x 0.35
    expect(G.waterSeconds(leg, false, SPEEDS).wet).toBeCloseTo(4 / (2.6 * 0.7) + 6 / (2.6 * 0.35), 6);
    expect(G.waterSeconds(leg, false, SPEEDS).deep).toBeCloseTo(6 / (2.6 * 0.35), 6);
  });
});

describe("ADR-345 full-sim crossings", () => {
  it("a bot crosses a fordable river and arrives wet but alive", () => {
    const r = rig(); loadWater(r, waterMap(48, 50));
    mem(r).travel = { kind: "sent", x: 96, y: 0, since: r.w.tick, leg: 0, origin: { x: 0, y: 0 }, route: [{ x: 96, y: 0 }] };
    let maxWet = 0, enteredWater = false;
    const n = driveTravel(r, 20000, () => !mem(r).travel, () => {
      const p = pos(r);
      if (G.inWater(r.w, p.x, p.y)) enteredWater = true;
      maxWet = Math.max(maxWet, r.w.getField(r.p, G.Wetness, "level") ?? 0);
    });
    expect(n).toBeGreaterThanOrEqual(0); // arrived
    expect(enteredWater).toBe(true);
    expect(maxWet).toBeGreaterThan(0); // wading soaks the bot
    expect(r.w.get(r.p, G.Health)!.hp).toBe(r.w.get(r.p, G.Health)!.max);
    expect(Math.hypot(pos(r).x - 96, pos(r).y)).toBeLessThanOrEqual(T.arriveTiles + 0.5);
  });
  it("a bot with a straight route across a lake re-plans around it instead of swimming", () => {
    const r = rig(); loadWater(r, waterMap(48, 88, -20, 20));
    const route = [{ x: 96, y: 0 }];
    mem(r).travel = { kind: "sent", x: 96, y: 0, since: r.w.tick, leg: 0, origin: { x: 0, y: 0 }, route };
    let enteredWater = false, maxWet = 0;
    const n = driveTravel(r, 30000, () => !mem(r).travel, () => {
      const p = pos(r);
      if (G.inWater(r.w, p.x, p.y)) enteredWater = true;
      maxWet = Math.max(maxWet, r.w.getField(r.p, G.Wetness, "level") ?? 0);
    });
    expect(n).toBeGreaterThanOrEqual(0); // arrived — by the detour, not the swim
    expect(enteredWater).toBe(false);
    expect(maxWet).toBe(0); // never got wet at all
    expect(mem(r).travel).toBeUndefined();
  });
  it("a cold bot refuses a dangerous crossing at the bank, then crosses once warm", () => {
    const r = rig(); loadWater(r, waterMap(48, 57)); // 10-wide river, ~6 deep: swimmable when fit
    mem(r).travel = { kind: "sent", x: 96, y: 0, since: r.w.tick, leg: 0, origin: { x: 40, y: 0 }, route: [{ x: 96, y: 0 }] };
    r.w.set(r.p, Transform, { x: 40, y: 0 });
    r.w.set(r.p, G.Survival, { stamina: 100 });
    let enteredWater = false, maxWet = 0;
    // held cold: the bot walks to the bank and waits there, dry, trip still live
    driveTravel(r, 600, () => false, () => {
      r.w.set(r.p, G.Survival, { bodyTemp: 30 }); // held cold (vitals would warm it back up)
      const p = pos(r);
      if (G.inWater(r.w, p.x, p.y)) enteredWater = true;
      maxWet = Math.max(maxWet, r.w.getField(r.p, G.Wetness, "level") ?? 0);
    });
    expect(enteredWater).toBe(false);
    expect(maxWet).toBe(0);
    expect(pos(r).x).toBeLessThan(48); // never left the bank
    expect(mem(r).travel).toBeDefined(); // still on the trip, not ended
    // warmed up: the same bot crosses and arrives
    const n = driveTravel(r, 20000, () => !mem(r).travel, () => {
      r.w.set(r.p, G.Survival, { bodyTemp: 37 });
      if (G.inWater(r.w, pos(r).x, pos(r).y)) enteredWater = true;
    });
    expect(n).toBeGreaterThanOrEqual(0);
    expect(enteredWater).toBe(true);
  });
  it("a bot riding a moose stays mounted across swimmable water", () => {
    const r = rig(); loadWater(r, waterMap(48, 57));
    mountUp(r, "moose");
    mem(r).travel = { kind: "sent", x: 96, y: 0, since: r.w.tick, leg: 0, origin: { x: 0, y: 0 }, route: [{ x: 96, y: 0 }] };
    let ridingInWater = false, enteredWater = false;
    const n = driveTravel(r, 20000, () => !mem(r).travel, () => {
      const p = pos(r);
      if (G.inWater(r.w, p.x, p.y)) { enteredWater = true; if (r.w.has(r.p, G.Riding)) ridingInWater = true; }
    });
    expect(n).toBeGreaterThanOrEqual(0);
    expect(enteredWater).toBe(true);
    expect(ridingInWater).toBe(true); // never got off in the river
    expect(r.w.has(r.p, G.Riding)).toBe(true);
  });
  it("a bot riding a horse routes around deep water instead of drowning its mount", () => {
    const r = rig(); loadWater(r, waterMap(48, 88, -20, 20));
    mountUp(r, "horse");
    mem(r).travel = { kind: "sent", x: 96, y: 0, since: r.w.tick, leg: 0, origin: { x: 0, y: 0 }, route: [{ x: 96, y: 0 }] };
    let enteredWater = false, maxWet = 0;
    const n = driveTravel(r, 30000, () => !mem(r).travel, () => {
      const p = pos(r);
      if (G.inWater(r.w, p.x, p.y)) enteredWater = true;
      maxWet = Math.max(maxWet, r.w.getField(r.p, G.Wetness, "level") ?? 0);
    });
    expect(n).toBeGreaterThanOrEqual(0);
    expect(enteredWater).toBe(false); // the horse never goes in
    expect(maxWet).toBe(0);
    expect(r.w.has(r.p, G.Riding)).toBe(true); // still mounted: it rode around, it did not dismount
  });
});

describe("ADR-345 route assignment", () => {
  it("a route planned through deep water is re-planned around it at assignment", () => {
    const r = rig(); loadWater(r, waterMap(48, 88, -20, 20));
    for (const rx of [3, 4, 5]) G.setRegionCost(r.w, rx, 0, 1); // force the lake regions cheap: the planner goes straight through
    const straight = G.planRegionRoute(r.w, 0, 0, 96, 0)!;
    expect(straight.some((p) => p.x > 48 && p.x < 88 && Math.abs(p.y) < 20)).toBe(true); // the raw plan crosses the lake
    G.orderTravel(r.a, 96, 0, r.w.tick);
    ctxOf(r); // fillTravelSensors assigns the route, then checkRouteWater re-plans around
    const tr = mem(r).travel!;
    expect(tr.route).toBeDefined();
    expect(tr.route).not.toEqual(straight); // re-planned, not the lake crossing
    for (let i = 0; i < tr.route!.length; i++) {
      const from = i === 0 ? tr.origin : tr.route![i - 1]!;
      expect(G.legWaterProfile(r.w, from.x, from.y, tr.route![i]!.x, tr.route![i]!.y).maxDeepRun)
        .toBeLessThanOrEqual(W.swimMaxDeepTiles);
    }
  });
  it("a horse trip across small seeded rivers is not ended at assignment — small water is the bank gate's job", () => {
    // ADR-331 regression: the first version ended this trip at assignment (any deep water under a
    // non-swimming mount forced a re-plan, and each re-plan found new rivers further along). Now the
    // planning check only re-plans around a deep run over nonSwimmerPlanDeepTiles (the local nav's detour
    // allowance); the bank gate handles the smaller rivers when reached.
    const r = rig(); mountUp(r, "horse");
    G.orderTravel(r.a, 400, 0, r.w.tick);
    ctxOf(r); // fillTravelSensors assigns the route, then checkRouteWater
    const tr = mem(r).travel!;
    expect(tr.kind).toBe("sent");
    expect(tr.route).toBeDefined();
    let crossedDeep = false;
    for (let i = 0; i < tr.route!.length; i++) {
      const from = i === 0 ? tr.origin : tr.route![i - 1]!;
      const prof = G.legWaterProfile(r.w, from.x, from.y, tr.route![i]!.x, tr.route![i]!.y);
      if (prof.deep > 0) crossedDeep = true;
      expect(prof.maxDeepRun).toBeLessThanOrEqual(W.nonSwimmerPlanDeepTiles);
    }
    expect(crossedDeep).toBe(true); // the route still crosses rivers — the planner did not detour around them
  });
  it("a horse trip is still re-planned around lake-scale water at assignment", () => {
    const r = rig(); mountUp(r, "horse"); loadWater(r, waterMap(48, 88, -20, 20));
    for (const rx of [3, 4, 5]) G.setRegionCost(r.w, rx, 0, 1); // force the lake regions cheap: the planner goes straight through
    const straight = G.planRegionRoute(r.w, 0, 0, 96, 0)!;
    expect(straight.some((p) => p.x > 48 && p.x < 88 && Math.abs(p.y) < 20)).toBe(true); // the raw plan crosses the lake
    G.orderTravel(r.a, 96, 0, r.w.tick);
    ctxOf(r);
    const tr = mem(r).travel!;
    expect(tr.kind).toBe("sent");
    expect(tr.route).toBeDefined();
    expect(tr.route).not.toEqual(straight); // re-planned, not the lake crossing
    for (let i = 0; i < tr.route!.length; i++) {
      const from = i === 0 ? tr.origin : tr.route![i - 1]!;
      expect(G.legWaterProfile(r.w, from.x, from.y, tr.route![i]!.x, tr.route![i]!.y).maxDeepRun)
        .toBeLessThanOrEqual(W.nonSwimmerPlanDeepTiles);
    }
  });
  it("the same seed plans the same water-aware route on fresh worlds", () => {
    const run = (): { x: number; y: number }[] | undefined => {
      const r = rig(); loadWater(r, waterMap(48, 88, -20, 20));
      for (const rx of [3, 4, 5]) G.setRegionCost(r.w, rx, 0, 1);
      G.orderTravel(r.a, 96, 0, r.w.tick); ctxOf(r);
      return mem(r).travel?.route;
    };
    expect(run()).toEqual(run());
  });
});

describe("ADR-345 off-screen crossings", () => {
  it("off-screen progress across a water leg matches the crossing cost — slower than dry, never a teleport", () => {
    const r = rig(); loadWater(r, waterMap(48, 57)); // 10-wide river on the (48,0)->(72,0) leg
    const route = [{ x: 24, y: 0 }, { x: 48, y: 0 }, { x: 72, y: 0 }, { x: 96, y: 0 }];
    mem(r).travel = { kind: "sent", x: 96, y: 0, since: r.w.tick, leg: 0, origin: { x: 0, y: 0 }, route };
    r.w.set(r.p, G.Survival, { stamina: 100, hunger: 100, thirst: 100 });
    const startStamina = r.w.getField(r.p, G.Survival, "stamina")!;
    let wetLegCalls = 0, prevAlong = 0, maxStep = 0, arrived = false;
    for (let i = 0; i < 200 && !arrived; i++) {
      const before = alongRoute(route, { x: 0, y: 0 }, pos(r));
      const legBefore = mem(r).travel!.leg;
      const res = G.offscreenStep(r.w, r.p, r.a, T.offscreen.stepTicks);
      const after = alongRoute(mem(r).travel?.route ?? route, { x: 0, y: 0 }, pos(r));
      maxStep = Math.max(maxStep, after - before);
      if (legBefore === 2) wetLegCalls++; // the leg that crosses the river
      if (res === "arrived") arrived = true;
      prevAlong = after;
    }
    void prevAlong;
    expect(arrived).toBe(true);
    expect(maxStep).toBeLessThanOrEqual(T.offscreen.speedTilesPerSec + 0.6); // never faster than dry speed (+ slack)
    expect(wetLegCalls).toBeGreaterThanOrEqual(11); // the wet leg takes ~14 s, a dry leg ~9 s: the river costs time
    expect(r.w.getField(r.p, G.Wetness, "level") ?? 0).toBeGreaterThan(0); // the crossing soaked the bot
    expect(r.w.getField(r.p, G.Survival, "stamina")!).toBeLessThan(startStamina); // swimming cost stamina
  });
  it("an off-screen bot re-plans around water it cannot cross instead of swimming it", () => {
    const r = rig(); loadWater(r, waterMap(48, 88, -20, 20));
    const route = [{ x: 96, y: 0 }];
    mem(r).travel = { kind: "sent", x: 96, y: 0, since: r.w.tick, leg: 0, origin: { x: 0, y: 0 }, route };
    const res = G.offscreenStep(r.w, r.p, r.a, T.offscreen.stepTicks);
    expect(res).not.toBe("idle");
    expect(mem(r).travel?.route).toBeDefined();
    expect(mem(r).travel!.route).not.toEqual(route); // re-planned around the lake
    expect(pos(r).x).toBeLessThan(48); // never stepped into the lake
    let arrived = false;
    for (let i = 0; i < 300 && !arrived; i++) {
      if (G.offscreenStep(r.w, r.p, r.a, T.offscreen.stepTicks) === "arrived") arrived = true;
      r.w.step(DT); // advance the tick so the plan budget resets between steps
      expect(G.inWater(r.w, pos(r).x, pos(r).y)).toBe(false);
    }
    expect(arrived).toBe(true);
  });
});
