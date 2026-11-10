// ADR-331: coverage for the five areas Grok's ADR-324/325 handoff listed as untested:
//  1. live off-screen hand-back after a FAR RESPAWN (gameplay half here; the view + chunk-streaming half
//     lives in apps/client/test/adr331_open_items_coverage.test.ts, which drives the real local server);
//  2. restoring a saved bot account (persisted AiMemory) over the ADR-325 spawn placement;
//  3. a relocated homestead being rebuilt at the new site;
//  4. mount riding on long world-wide trips (ADR-324 + ADR-321 mount policy), incl. dismount on arrival
//     and at a doorway;
//  5. multiplayer spread: several humans spread across the world, AI spawns distributing over the
//     world-wide points instead of clustering at the starter points.
// Fixtures are reused from adr324_world_travel / adr325_ai_spawn / adr321_ai_mounts / adr252_ai_humans.
import { describe, expect, it } from "vitest";
import { idleOutput, installPermissions, NetId, PlayerId, Transform, type Agent, type AgentContext, type AgentOutput, type Entity, type World } from "@engine/core";
import * as G from "../src/index.js";
import { aiMemoryOf } from "../src/ai/planner.js";
import { DT, makeWorld, plantClaim, spawnLearned, steps } from "./helpers.js";

const T = G.TRAVEL;
const K = G.AI_SPAWN.pick;
let nid = 9100;
const net = (w: World, e: Entity): Entity => { if (!w.has(e, NetId)) w.add(e, NetId, { id: ++nid }); return e; };
const pid = (w: World, e: Entity, id: number): Entity => { if (w.has(e, PlayerId)) w.set(e, PlayerId, { id }); else w.add(e, PlayerId, { id }); return e; };

interface Rig { w: World; p: Entity; a: Agent; home: { x: number; y: number } }
function rig(opts: { seed?: number; x?: number; y?: number } = {}): Rig {
  const w = makeWorld({}, opts.seed ?? 42); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const x = opts.x ?? 0, y = opts.y ?? 0; const p = spawnLearned(w, { x, y, maxWeight: 0, clientId: 7 }); pid(w, p, 7); net(w, p);
  const a = G.makeAgent(G.makeAgentIdentity(3, 0, "bot_gatherer"), 1);
  return { w, p, a, home: { x, y } };
}
type Mem = { travel?: G.TravelState; travelAt?: number; travelN?: number; roamSince?: number; base?: { x: number; y: number } };
const mem = (r: Rig): Mem => aiMemoryOf(r.a) as unknown as Mem;
const memOf = (a: Agent): Mem => aiMemoryOf(a) as unknown as Mem;
type Ctx = AgentContext<G.AgentWorldView>;
const ctxOf = (r: Rig): Ctx => { const v = G.buildAgentView(r.w, r.p, r.a, r.home)!; return { self: v.self, bb: r.a.bb, memory: r.a.memory, traits: r.a.identity.traits, rng: r.a.rng, agent: r.a, world: v.world }; };
const out = (): AgentOutput & { commands?: G.AgentCommand[] } => ({ ...idleOutput(), actions: [] as string[] });
const pos = (w: World, e: Entity): { x: number; y: number } => w.get(e, Transform)!;
const fed = (r: Rig): void => { r.w.set(r.p, G.Survival, { hunger: 100, thirst: 100 }); };
function move(r: Rig, o: AgentOutput): void {
  let bits = 0; const len = Math.hypot(o.moveX, o.moveY);
  if (len > 1e-6) { if (o.moveX > 0.38 * len) bits |= G.GameplayActions.MoveRight; else if (o.moveX < -0.38 * len) bits |= G.GameplayActions.MoveLeft; if (o.moveY > 0.38 * len) bits |= G.GameplayActions.MoveDown; else if (o.moveY < -0.38 * len) bits |= G.GameplayActions.MoveUp; }
  G.applyMovementInput(r.w, r.p, bits, DT);
}
/** Apply the bot's mount commands the way the server handlers do (ADR-321 apply). */
function applyMount(r: Rig, o: AgentOutput & { commands?: G.AgentCommand[] }, log: string[]): void {
  G.emitAgentCommands(o);
  for (const c of o.commands ?? []) {
    const v = c.payload as { target: number };
    if (c.type === G.MountRideCmd.name) { G.rideMount(r.w, r.p, v.target as Entity); log.push("mride"); }
    else if (c.type === G.MountDismountCmd.name) { G.dismount(r.w, r.p); log.push("mdismount"); }
  }
}
/** Drive the travel behaviour (+ the ADR-321 mount policy, as survivorRegistry wraps it) until the trip ends. */
function travelFor(r: Rig, maxTicks: number, withMount = false): { done: number; rode: number; samples: number; log: string[] } {
  const b = G.travelBehaviors()[0]!; let done = 0, rode = 0, samples = 0; const log: string[] = [];
  for (let i = 0; i < maxTicks && !done; i++) {
    if (!mem(r).travel) mem(r).travelAt = -1e9;
    const had = !!mem(r).travel; const c = ctxOf(r); const o = out();
    if (c.world.travel?.route) { b.run(c, o); if (withMount) G.mountPolicy(c, o, "travel"); }
    if (withMount) applyMount(r, o, log);
    if (had && c.world.travel?.route) { samples++; if (r.w.has(r.p, G.Riding)) rode++; }
    move(r, o); r.w.step(DT); fed(r);
    if (had && !mem(r).travel) done++;
  }
  return { done, rode, samples, log };
}
function alongRoute(route: { x: number; y: number }[], from: { x: number; y: number }, p: { x: number; y: number }): { along: number; off: number } {
  let base = 0, bestOff = Infinity, bestAlong = 0, px = from.x, py = from.y;
  for (const wp of route) {
    const dx = wp.x - px, dy = wp.y - py, len2 = dx * dx + dy * dy, len = Math.sqrt(len2);
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - px) * dx + (p.y - py) * dy) / len2)) : 0;
    const off = Math.hypot(p.x - (px + dx * t), p.y - (py + dy * t));
    if (off < bestOff) { bestOff = off; bestAlong = base + len * t; }
    base += len; px = wp.x; py = wp.y;
  }
  return { along: bestAlong, off: bestOff };
}

// ---- shared ADR-325 spawn fixture (starters + world ring) -------------------------------------------------------
const ring = (n: number, r: number, off = 0): G.AiSpawnPoint[] => Array.from({ length: n }, (_, i) => ({ x: Math.cos(off + (i / n) * Math.PI * 2) * r, y: Math.sin(off + (i / n) * Math.PI * 2) * r, source: "world" as const }));
const starters: G.AiSpawnPoint[] = [{ x: 96, y: -96, source: "starter" }, { x: 96, y: 96, source: "starter" }, { x: -96, y: 96, source: "starter" }, { x: -96, y: -96, source: "starter" }];
function spawnSetup(seed = 42): { w: World; pts: G.AiSpawnPoint[]; human: Entity } {
  const w = makeWorld({}, seed); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const pts = [...starters, ...ring(16, 400), ...ring(12, 900, 0.2)]; G.setAiSpawnPoints(w, pts);
  const human = spawnLearned(w, { x: 100, y: 100, maxWeight: 0, clientId: 1 }); w.add(human, PlayerId, { id: 1 });
  G.setAiHumanPredicate(w, () => false); return { w, pts, human };
}

describe("ADR-331 live off-screen hand-back after a far respawn (gameplay half)", () => {
  it("a bot that respawns at a distributed point far from every human steps off-screen along its route, then hands back to full sim with the same route and leg when a human comes near", () => {
    const s = spawnSetup(); const { w, human } = s;
    const bot = spawnLearned(w, { x: 300, y: 300, maxWeight: 0, clientId: 2 }); w.add(bot, PlayerId, { id: 2 });
    G.setAiHumanPredicate(w, (e) => e === bot); G.installBedRespawn(w);
    const a = G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1);
    // die and respawn: the ADR-325 rule lands it on a distributed point, far from the human
    w.add(bot, G.Dead, { tick: 0 } as never); w.tick += 100000;
    expect(G.respawnPlayer(w, bot)).toBeUndefined();
    const p0 = { ...pos(w, bot) };
    expect(Math.hypot(p0.x - 100, p0.y - 100)).toBeGreaterThanOrEqual(K.minPlayerDist - K.jitter);
    expect(s.pts.some((q) => q.source !== "starter" && Math.hypot(q.x - p0.x, q.y - p0.y) <= K.jitter + 1e-6)).toBe(true);
    // the local host's Respawned handler marks a far respawn off-screen (apps/client/src/local.ts)
    G.markSpawnOffscreen(a, true);
    const humans = [{ x: 100, y: 100 }]; void human;
    expect(G.wantsOffscreen(a, p0.x, p0.y, humans)).toBe(true);
    expect(G.wantsOffscreen(a, p0.x, p0.y, [{ x: p0.x + 6, y: p0.y }])).toBe(false); // a human next to it: full sim
    // off-screen: it picks its own goal on the cooldown and steps coarsely along the route
    memOf(a).travelAt = -1e9;
    let moved = 0; for (let i = 0; i < 20; i++) { w.tick += T.offscreen.stepTicks; if (G.offscreenStep(w, bot, a, T.offscreen.stepTicks) !== "idle") moved++; }
    expect(moved).toBeGreaterThan(0);
    const tr = memOf(a).travel!; expect(tr.route?.length).toBeGreaterThan(2);
    const p1 = { ...pos(w, bot) }; const m1 = alongRoute(tr.route!, p0, p1);
    expect(m1.off).toBeLessThan(3); expect(m1.along).toBeGreaterThan(10);
    const leg = tr.leg; const route = tr.route!;
    // hand-back: a human comes near, the flag clears, and full sim walks the SAME route onward (leg not reset)
    expect(G.wantsOffscreen(a, p1.x, p1.y, [{ x: p1.x + 6, y: p1.y }])).toBe(false);
    G.markSpawnOffscreen(a, false); expect(G.spawnedOffscreen(a)).toBe(false);
    const r: Rig = { w, p: bot, a, home: { ...p1 } };
    expect(mem(r).travel?.route).toBe(route); expect(mem(r).travel?.leg).toBe(leg);
    const c = ctxOf(r); expect(c.world.travel?.route).toBe(route);
    const res = travelFor(r, 12000); expect(res.done).toBe(1);
    expect(Math.hypot(pos(w, bot).x - tr.x, pos(w, bot).y - tr.y)).toBeLessThanOrEqual(T.arriveTiles + 0.5);
  });
});

describe("ADR-331 restoring a saved bot account over the new spawn placement", () => {
  it("a JSON-restored identity keeps its base, travel route/leg and off-screen flag, and respawn honours the restored home (bed -> home -> distributed point), not the old starter placement", () => {
    const s = spawnSetup(); const { w } = s;
    const bot = spawnLearned(w, { x: 300, y: 300, maxWeight: 0, clientId: 2 }); w.add(bot, PlayerId, { id: 2 });
    G.setAiHumanPredicate(w, (e) => e === bot); G.installBedRespawn(w);
    // saved state as game.agents persists it (AiMemory inside the identity, ADR-252/324)
    const a = G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1);
    const m = memOf(a); m.base = { x: 520, y: -40 };
    m.travel = { kind: "explore", x: 800, y: 0, since: 0, leg: 1, origin: { x: 520, y: -40 }, route: [{ x: 600, y: -20 }, { x: 700, y: -10 }, { x: 800, y: 0 }] };
    G.markSpawnOffscreen(a, true);
    // reload: the identity goes through JSON like game.agents, a fresh agent picks it up
    const id = JSON.parse(JSON.stringify(a.identity)); const a2 = G.makeAgent(id, 1); const m2 = memOf(a2);
    expect(m2.base).toEqual({ x: 520, y: -40 });
    expect(m2.travel?.kind).toBe("explore"); expect(m2.travel?.leg).toBe(1); expect(m2.travel?.route).toHaveLength(3);
    expect(G.spawnedOffscreen(a2)).toBe(true);
    // the restored route still steps (no jump, no reset to leg 0)
    w.set(bot, Transform, { x: 520, y: -40 });
    expect(G.offscreenStep(w, bot, a2, T.offscreen.stepTicks)).toBe("moved");
    const p1 = pos(w, bot); expect(Math.hypot(p1.x - 520, p1.y + 40)).toBeCloseTo(T.offscreen.speedTilesPerSec, 2);
    expect(memOf(a2).travel?.leg).toBeGreaterThanOrEqual(1);
    // respawn over the restored state: the home locator reads the restored base (as local.ts wires it),
    // so the bot comes back home — not to a starter point and not to a fresh distributed pick
    G.setAiHomeLocator(w, (e) => (e === bot ? G.baseHome(m2.base!) : undefined));
    expect(G.respawnLocation(w, bot)).toEqual(G.baseHome({ x: 520, y: -40 }));
    // ...and with no restored home at all, the same bot respawns at a distributed point, never a starter
    G.setAiHomeLocator(w, undefined);
    const p = G.respawnLocation(w, bot)!;
    const idx = s.pts.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) <= K.jitter + 1e-6);
    expect(idx).toBeGreaterThanOrEqual(0); expect(s.pts[idx]!.source).not.toBe("starter");
    expect(Math.hypot(p.x - 100, p.y - 100)).toBeGreaterThanOrEqual(K.minPlayerDist - K.jitter);
  });
  it("a for-hire bot (Worker record, owner 0 — what recruitmentSystem gives every AI human live) still gets the distributed respawn; only an actually hired bot (owner != 0) keeps the ADR-153 nearest-starter rule", () => {
    const s = spawnSetup(); const { w } = s;
    const bot = spawnLearned(w, { x: 300, y: 300, maxWeight: 0, clientId: 2 }); w.add(bot, PlayerId, { id: 2 });
    G.setAiHumanPredicate(w, (e) => e === bot); G.installBedRespawn(w);
    // for hire, as the live backfill leaves it: the distributed rule applies, not the starter rule
    G.ensureWorker(w, bot);
    expect(w.getField(bot, G.Worker, "owner")).toBe(0);
    const p = G.respawnLocation(w, bot)!;
    const idx = s.pts.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) <= K.jitter + 1e-6);
    expect(idx).toBeGreaterThanOrEqual(0); expect(s.pts[idx]!.source).not.toBe("starter");
    expect(Math.hypot(p.x - 100, p.y - 100)).toBeGreaterThanOrEqual(K.minPlayerDist - K.jitter);
    // hired for real: back to the ADR-153 rule (nearest starter point), as ADR-325's own test pins
    w.setField(bot, G.Worker, "owner", 1);
    G.setSpawnPoints(w, starters);
    const q = G.respawnLocation(w, bot)!;
    expect(Math.hypot(q.x - 96, q.y - 96)).toBeLessThanOrEqual(2.01);
  });
});

describe("ADR-331 relocated homesteads are rebuilt", () => {
  it("a free AI's relocate trip drops its old base on arrival, picks a new site by the new home, and the planner rebuilds the campfire -> box -> workbench ladder there", () => {
    const r = rig(); const d = G.gameplayDefs(r.w);
    mem(r).base = { x: 0, y: 0 };
    // the goal pick itself: every relocateEvery-th exploration of a free AI with a base relocates
    mem(r).travelN = T.relocateEvery - 1; mem(r).travelAt = -1e9;
    expect(ctxOf(r).world.travel?.kind).toBe("relocate");
    // drive the relocation deterministically to (400, 0): the same route the planner would plan
    const route = G.planRegionRoute(r.w, 0, 0, 400, 0)!; expect(route.length).toBeGreaterThan(8);
    mem(r).travel = { kind: "relocate", x: 400, y: 0, since: r.w.tick, leg: 0, origin: { x: 0, y: 0 }, route };
    const res = travelFor(r, 12000); expect(res.done).toBe(1);
    const arrival = { ...pos(r.w, r.p) };
    expect(Math.hypot(arrival.x - 400, arrival.y)).toBeLessThanOrEqual(T.arriveTiles + 0.5);
    expect(mem(r).base).toBeUndefined(); // ADR-324: a relocation drops the base
    expect(aiMemoryOf(r.a).stats.relocations).toBe(1);
    // the home re-anchors to where the bot now lives (local.ts viewFor); the next sense picks a new site by it
    r.home = { ...arrival };
    for (let i = 0; i < 30 && !mem(r).base; i++) { ctxOf(r); steps(r.w, 11); }
    const base = mem(r).base; expect(base).toBeDefined();
    expect(Math.hypot(base!.x - arrival.x, base!.y - arrival.y)).toBeLessThanOrEqual(12); // pickBaseSite: 5..9 tiles from home
    expect(Math.hypot(base!.x, base!.y)).toBeGreaterThan(100); // far from the old homestead, not rebuilt there
    // rebuild the ladder at the new site (the ADR-252 planner walk, with a claim planted first per ADR-310)
    plantClaim(r.w, r.p, base!.x, base!.y);
    G.addItem(r.w, r.p, d.itemId("stone_axe"), 1); G.addItem(r.w, r.p, d.itemId("stone_pickaxe"), 1);
    G.addItem(r.w, r.p, d.itemId("wood"), G.WOOD_RESERVE + 8);
    const give = (key: string): void => { const def = d.pieces.get(d.pieceId(key))!; for (const c of G.pieceCost(d, def, def.tiered ? 0 : def.fixedTier)) G.addItem(r.w, r.p, c.item, c.count); };
    const order: string[] = [];
    for (let i = 0; i < 3; i++) {
      for (const k of ["campfire", "basic_storage_box", "workbench"]) give(k);
      const pl = G.makePlan({ world: r.w, self: r.p, defs: d, base: base!, bs: G.scanBase(r.w, d, base!), fails: {} });
      order.push(pl.goal); const s = pl.step;
      expect(s?.k, `${pl.goal}: ${JSON.stringify(pl)}`).toBe("build"); if (s?.k !== "build") break;
      r.w.set(r.p, Transform, { x: s.stand.x, y: s.stand.y });
      const def = d.pieces.get(s.piece)!;
      expect(G.tryPlace(r.w, r.p, { piece: def.id, x: s.x, y: s.y, level: s.level, rot: 0, tier: def.fixedTier, variant: 0 }).ok, pl.goal).toBe(true);
      steps(r.w, 25);
    }
    expect(order).toEqual(["campfire", "basic_storage_box", "workbench"]);
    const bs = G.scanBase(r.w, d, base!);
    expect(bs.pieces.size + bs.stations.size + (bs.storage ? 1 : 0)).toBeGreaterThanOrEqual(3);
    expect(bs.storage).toBeDefined();
    // the new site is where the bot now lives: a fresh view anchors the base there, not at the old site
    const v = ctxOf(r).world; expect(v.base).toEqual(base);
  });
});

describe("ADR-331 mount riding on long trips", () => {
  const horseRig = (): Rig & { m: Entity } => {
    const r = rig(); const m = net(r.w, G.makeMount(r.w, "animal_horse", 2, 0, r.p)); return { ...r, m };
  };
  it("an AI with its own mount rides (not walks) the long legs of a world-wide trip and dismounts on arrival", () => {
    const r = horseRig();
    const c0 = ctxOf(r); expect(c0.world.mountSkill).toBe(true); expect(c0.world.mount?.id).toBe(r.m);
    G.orderTravel(r.a, 400, 0, r.w.tick); ctxOf(r);
    expect(mem(r).travel?.kind).toBe("sent"); expect(mem(r).travel?.route?.length).toBeGreaterThan(8);
    const res = travelFor(r, 8000, true);
    expect(res.done).toBe(1);
    expect(res.log[0]).toBe("mride"); // mounted at once: the mount stands 2 tiles away, inside mountReach
    expect(res.rode).toBeGreaterThan(0);
    expect(res.samples).toBeGreaterThan(100);
    expect(res.rode / res.samples).toBeGreaterThan(0.8); // riding for the bulk of the trip, not walking it
    expect(res.log).toContain("mdismount"); // dismounted on arrival
    expect(r.w.has(r.p, G.Riding)).toBe(false);
    expect(Math.hypot(pos(r.w, r.p).x - 400, pos(r.w, r.p).y)).toBeLessThanOrEqual(T.arriveTiles + 0.5);
  });
  it("a short trip does not mount up (longTripTiles), and a riding bot dismounts at a doorway instead of riding through it", () => {
    const r = horseRig();
    // short trip: the mount policy leaves the bot on foot
    G.orderTravel(r.a, 10, 0, r.w.tick); ctxOf(r);
    const o1 = out(); const b = G.travelBehaviors()[0]!; const c1 = ctxOf(r);
    b.run(c1, o1); G.mountPolicy(c1, o1, "travel");
    expect(o1.actions.some((a) => a.startsWith("mride:"))).toBe(false);
    // doorway: ride the horse north into a door and expect a dismount instead of riding through it
    // (a rot-0 doorway's edge is crossed moving in y: rideClearanceBlocked is true for a horse, false for a donkey)
    const r2 = horseRig();
    G.rideMount(r2.w, r2.p, r2.m); expect(r2.w.has(r2.p, G.Riding)).toBe(true);
    plantClaim(r2.w, r2.p, 10, 0);
    const d = G.gameplayDefs(r2.w);
    const give = (key: string): void => { const def = d.pieces.get(d.pieceId(key))!; for (const cst of G.pieceCost(d, def, def.tiered ? 0 : def.fixedTier)) G.addItem(r2.w, r2.p, cst.item, cst.count); };
    const place = (key: string, x: number, y: number): boolean => {
      r2.w.set(r2.p, Transform, { x: x + 0.5, y: y + 1.2 });
      return G.tryPlace(r2.w, r2.p, { piece: d.pieceId(key), x, y, level: 0, rot: 0, tier: 0, variant: 0 }).ok;
    };
    give("foundation"); give("wall_doorway"); give("door_wood");
    expect(place("foundation", 10.5, 0.5)).toBe(true); // the doorway needs a foundation under it
    expect(place("wall_doorway", 10.5, 0)).toBe(true);
    expect(place("door_wood", 10.5, 0)).toBe(true);
    steps(r2.w, 2);
    expect(G.rideClearanceBlocked(r2.w, G.mountSpeciesOfAnimal("animal_horse"), 10.5, -0.5, 10.5, 0.5, 0)).toBe(true);
    expect(G.rideClearanceBlocked(r2.w, G.mountSpeciesOfAnimal("animal_donkey"), 10.5, -0.5, 10.5, 0.5, 0)).toBe(false);
    G.orderTravel(r2.a, 400, 0, r2.w.tick);
    r2.w.set(r2.p, Transform, { x: 10.5, y: -1 }); // one probe tile (clearanceProbeTiles) south of the door edge
    const c3 = ctxOf(r2); expect(c3.world.mount?.riding).toBe(true);
    const o3 = out(); o3.moveX = 0; o3.moveY = 1;
    expect(G.dismountReason(c3, o3, "travel", r2.w)).toBe("clearance");
    G.mountPolicy(c3, o3, "travel");
    expect(o3.actions).toContain("mdismount"); expect(o3.moveX).toBe(0); expect(o3.moveY).toBe(0);
    // control: the same probe with no door in the way is not a clearance dismount
    const r3 = horseRig(); G.rideMount(r3.w, r3.p, r3.m);
    G.orderTravel(r3.a, 400, 0, r3.w.tick); r3.w.set(r3.p, Transform, { x: 10.5, y: -1 });
    const c4 = ctxOf(r3); const o4 = out(); o4.moveX = 0; o4.moveY = 1;
    expect(G.dismountReason(c4, o4, "travel", r3.w)).toBeUndefined();
  });
});

describe("ADR-331 multiplayer with several humans and spread AI spawns", () => {
  const entropy = (counts: number[]): number => { const n = counts.reduce((a, b) => a + b, 0); let h = 0; for (const c of counts) if (c) h -= (c / n) * Math.log(c / n); return h; };
  it("with four humans spread across the world, picks still spread over the world-wide points (least-populated weighting) and stay away from every human, never clustering at the starters", () => {
    const { w, pts } = spawnSetup();
    const humans = [{ x: 100, y: 100 }, { x: -500, y: 300 }, { x: 400, y: -600 }, { x: -700, y: -700 }];
    humans.forEach((h, i) => { const e = spawnLearned(w, { x: h.x, y: h.y, maxWeight: 0, clientId: 10 + i }); w.add(e, PlayerId, { id: 10 + i }); });
    const pending: { x: number; y: number }[] = []; const picks: G.AiSpawnPick[] = [];
    for (let i = 0; i < 120; i++) { const p = G.pickAiSpawnPoint(w, "bot", i, { pending, humans }); pending.push(p); picks.push(p); }
    const counts = pts.map(() => 0); for (const p of picks) counts[p.index]!++;
    const eligible = pts.filter((p) => p.source !== "starter").length;
    const used = counts.filter((c) => c > 0).length;
    expect(used).toBeGreaterThanOrEqual(eligible * 0.9); // spread, not clustered near one human
    expect(entropy(counts) / Math.log(eligible)).toBeGreaterThan(0.9);
    expect(Math.max(...counts)).toBeLessThanOrEqual(Math.ceil(120 / eligible) + 3); // no pile-ups
    for (const p of picks) {
      for (const h of humans) { const d = Math.hypot(p.x - h.x, p.y - h.y); expect(d).toBeGreaterThanOrEqual(p.near ? K.onScreenTiles - K.jitter : K.minPlayerDist - K.jitter); }
      if (!p.near) expect(pts[p.index]!.source).not.toBe("starter"); // player areas are left to players
    }
    expect(picks.filter((p) => p.near).length).toBeLessThanOrEqual(Math.ceil(120 * K.nearPlayerShare * 3));
    const sectors = new Set(picks.map((p) => Math.floor(((Math.atan2(p.y, p.x) + Math.PI) / (Math.PI * 2)) * 8) % 8));
    expect(sectors.size).toBeGreaterThanOrEqual(6); // all around the world, not one quadrant
    // a point crowded by a human's neighbours is not piled onto: the human at (100,100) sits inside the
    // ring, yet the nearest world points to it are picked no more often than any other point
    const nearHuman = pts.map((p, i) => ({ i, d: Math.hypot(p.x - 100, p.y - 100) })).filter((q) => q.d < 200).map((q) => q.i);
    expect(nearHuman.length).toBeGreaterThan(0);
    for (const i of nearHuman) expect(counts[i]).toBeLessThanOrEqual(Math.ceil(120 / eligible) + 3);
  });
  it("is deterministic for the same seed and spread of humans", () => {
    const run = (): number[] => {
      const { w, pts } = spawnSetup(7); void pts;
      const humans = [{ x: 100, y: 100 }, { x: -500, y: 300 }, { x: 400, y: -600 }, { x: -700, y: -700 }];
      const pending: { x: number; y: number }[] = []; const outIdx: number[] = [];
      for (let i = 0; i < 40; i++) { const p = G.pickAiSpawnPoint(w, "bot", i, { pending, humans }); pending.push(p); outIdx.push(p.index); }
      return outIdx;
    };
    expect(run()).toEqual(run());
  });
});
