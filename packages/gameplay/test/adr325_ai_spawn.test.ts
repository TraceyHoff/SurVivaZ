// ADR-325: AI humans spawn all around the world's spawn points (seeded, least-populated, away from players) and
// respawn bed -> home -> distributed point; far spawns start in the ADR-324 off-screen sim.
import { describe, expect, it } from "vitest";
import { PlayerId, Transform, installPermissions, type Entity, type World } from "@engine/core";
import { ProceduralGenerator, computeSpawnPoints } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld, spawnLearned } from "./helpers.js";

const K = G.AI_SPAWN.pick;
const ring = (n: number, r: number, off = 0): G.AiSpawnPoint[] => Array.from({ length: n }, (_, i) => ({ x: Math.cos(off + (i / n) * Math.PI * 2) * r, y: Math.sin(off + (i / n) * Math.PI * 2) * r, source: "world" as const }));
const starters: G.AiSpawnPoint[] = [{ x: 96, y: -96, source: "starter" }, { x: 96, y: 96, source: "starter" }, { x: -96, y: 96, source: "starter" }, { x: -96, y: -96, source: "starter" }];
function setup(seed = 42): { w: World; pts: G.AiSpawnPoint[]; human: Entity } {
  const w = makeWorld({}, seed); installPermissions(w); if (!w.isRegistered(PlayerId)) w.register(PlayerId);
  const pts = [...starters, ...ring(16, 400), ...ring(12, 900, 0.2)]; G.setAiSpawnPoints(w, pts);
  const human = spawnLearned(w, { x: 100, y: 100, maxWeight: 0, clientId: 1 }); w.add(human, PlayerId, { id: 1 });
  G.setAiHumanPredicate(w, () => false); return { w, pts, human };
}
const entropy = (counts: number[]): number => { const n = counts.reduce((a, b) => a + b, 0); let h = 0; for (const c of counts) if (c) h -= (c / n) * Math.log(c / n); return h; };
function spreadPicks(w: World, n: number): G.AiSpawnPick[] {
  const pending: { x: number; y: number }[] = []; const out: G.AiSpawnPick[] = [];
  for (let i = 0; i < n; i++) { const p = G.pickAiSpawnPoint(w, "bot", i, { pending }); pending.push(p); out.push(p); }
  return out;
}

describe("ADR-325 world-wide AI spawn points", () => {
  it("are generated from the seed all around the world on walkable, clear tiles (deterministic)", () => {
    const gen = new ProceduralGenerator({ seed: 11 }); const st = computeSpawnPoints(gen); const unwalk = G.defaultDefs().worldgen.unwalkableTiles;
    const a = G.computeAiSpawnPoints(gen, 11, st, unwalk), b = G.computeAiSpawnPoints(new ProceduralGenerator({ seed: 11 }), 11, st, unwalk);
    expect(a).toEqual(b);
    const world = a.filter((p) => p.source !== "starter"); expect(world.length).toBeGreaterThanOrEqual(G.AI_SPAWN.points.count * 0.6);
    expect(a.filter((p) => p.source === "starter")).toHaveLength(4);
    const sectors = new Set(world.map((p) => Math.floor(((Math.atan2(p.y, p.x) + Math.PI) / (Math.PI * 2)) * 8) % 8)); expect(sectors.size).toBe(8);
    const rs = world.map((p) => Math.hypot(p.x, p.y)); expect(Math.max(...rs)).toBeGreaterThan(G.AI_SPAWN.points.maxRadius * 0.8); expect(Math.min(...rs)).toBeGreaterThan(G.AI_SPAWN.points.minRadius - G.AI_SPAWN.points.searchTiles * 1.5);
    for (const p of world) expect(unwalk.has(gen.tileAt(Math.floor(p.x), Math.floor(p.y)))).toBe(false);
    const other = G.computeAiSpawnPoints(new ProceduralGenerator({ seed: 12 }), 12, computeSpawnPoints(new ProceduralGenerator({ seed: 12 })), unwalk);
    expect(other).not.toEqual(a);
  });
});

describe("ADR-325 picking", () => {
  it("spreads over the points (high entropy, weighted to the least populated) and keeps away from players", () => {
    const { w, pts } = setup(); const picks = spreadPicks(w, 120);
    const counts = pts.map(() => 0); for (const p of picks) counts[p.index]!++;
    const used = counts.filter((c) => c > 0).length; const eligible = pts.filter((p) => p.source !== "starter").length;
    expect(used).toBeGreaterThanOrEqual(eligible * 0.9); expect(entropy(counts) / Math.log(eligible)).toBeGreaterThan(0.9);
    expect(Math.max(...counts)).toBeLessThanOrEqual(Math.ceil(120 / eligible) + 3); // least-populated weighting, no pile-ups
    const human = { x: 100, y: 100 };
    for (const p of picks) { const d = Math.hypot(p.x - human.x, p.y - human.y); expect(d).toBeGreaterThanOrEqual(p.near ? K.onScreenTiles - K.jitter : K.minPlayerDist - K.jitter); }
    for (const p of picks.filter((q) => !q.near)) expect(pts[p.index]!.source).not.toBe("starter"); // player areas are left to players
    expect(picks.filter((p) => p.near).length).toBeLessThanOrEqual(Math.ceil(120 * K.nearPlayerShare * 3)); // low near-player share
  });
  it("is deterministic for the same seed and world state", () => {
    const a = spreadPicks(setup(7).w, 40), b = spreadPicks(setup(7).w, 40); expect(a).toEqual(b);
    const c = spreadPicks(setup(8).w, 40); expect(c.map((p) => p.index)).not.toEqual(a.map((p) => p.index));
  });
  it("skips claimed and water points; falls back to the farthest free point when nothing is far enough", () => {
    const { w, pts } = setup(); const perms = installPermissions(w);
    const claimed = pts.findIndex((p) => p.source === "world"); const cp = pts[claimed]!;
    perms.claims.add({ ownerGroup: 1, x0: Math.floor(cp.x) - 8, y0: Math.floor(cp.y) - 8, x1: Math.floor(cp.x) + 8, y1: Math.floor(cp.y) + 8, flags: 0 });
    const wet = pts.findIndex((p, i) => p.source === "world" && i !== claimed); const wp = pts[wet]!;
    w.setResource(G.PopulationTiles, (tx: number, ty: number) => (Math.hypot(tx - wp.x, ty - wp.y) < 6 ? 1 : 3));
    const picks = spreadPicks(w, 200); expect(picks.some((p) => p.index === claimed || p.index === wet)).toBe(false);
    const w2 = makeWorld(); G.setAiSpawnPoints(w2, [{ x: 10, y: 0, source: "world" }, { x: 60, y: 0, source: "world" }]);
    expect(G.pickAiSpawnPoint(w2, "bot", 0, { humans: [{ x: 0, y: 0 }] }).index).toBe(1);
  });
});

describe("ADR-325 respawn", () => {
  const rig = () => {
    const s = setup(); const bot = spawnLearned(s.w, { x: 300, y: 300, maxWeight: 0, clientId: 2 }); s.w.add(bot, PlayerId, { id: 2 });
    G.setAiHumanPredicate(s.w, (e) => e === bot); G.installBedRespawn(s.w); return { ...s, bot };
  };
  it("an AI human without bed or home respawns at a distributed point far from players", () => {
    const { w, bot, pts } = rig(); const p = G.respawnLocation(w, bot)!;
    const idx = pts.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) <= K.jitter + 1e-6); expect(idx).toBeGreaterThanOrEqual(0);
    expect(Math.hypot(p.x - 100, p.y - 100)).toBeGreaterThanOrEqual(K.onScreenTiles - K.jitter);
  });
  it("goes home (its remembered base) first, and its own bed before that", () => {
    const { w, bot } = rig(); G.setAiHomeLocator(w, (e) => (e === bot ? { x: 520, y: -40 } : undefined));
    expect(G.respawnLocation(w, bot)).toEqual({ x: 520, y: -40 });
    const d = G.gameplayDefs(w); const bed = [...d.pieces.values()].find((p) => p.key === "bed")!;
    const b = w.create(); w.add(b, Transform, { x: 530, y: -30 }).add(b, G.BuildPiece, { type: bed.id } as never).add(b, G.PieceOwner, { player: 2 });
    expect(G.respawnLocation(w, bot)).toEqual({ x: 531, y: -29.5 });
  });
  it("hired workers and clan members keep the ADR-153 rule (nearest spawn point)", () => {
    const { w, bot } = rig(); G.setSpawnPoints(w, starters); G.ensureWorker(w, bot); w.setField(bot, G.Worker, "owner", 1);
    const p = G.respawnLocation(w, bot)!; expect(Math.hypot(p.x - 96, p.y - 96)).toBeLessThanOrEqual(2.01);
  });
  it("respawnPlayer moves a dead AI human there", () => {
    const { w, bot } = rig(); G.setAiHomeLocator(w, () => ({ x: 700, y: 10 })); w.add(bot, G.Dead, { tick: 0 } as never); w.tick += 100000;
    expect(G.respawnPlayer(w, bot)).toBeUndefined(); expect(w.get(bot, Transform)).toMatchObject({ x: 700, y: 10 });
  });
});

describe("ADR-325 far spawns start off-screen", () => {
  it("an off-screen spawn needs no route, picks its own goal on the cooldown, travels coarsely and hands back near a human", () => {
    const w = makeWorld(); const e = spawnLearned(w, { x: 800, y: 0, maxWeight: 0, clientId: 3 });
    const a = G.makeAgent(G.makeAgentIdentity(5, 0, "bot_gatherer"), 1); G.markSpawnOffscreen(a, true);
    const far = [{ x: 0, y: 0 }]; expect(G.wantsOffscreen(a, 800, 0, far)).toBe(true); expect(G.wantsOffscreen(a, 800, 0, [])).toBe(false);
    expect(G.wantsOffscreen(a, 800, 0, [{ x: 760, y: 0 }])).toBe(false); // a human within fullSimTiles: full sim
    const step = G.TRAVEL.offscreen.stepTicks; let moved = 0;
    for (let i = 0; i < 400; i++) { w.tick += step; if (G.offscreenStep(w, e, a, step) !== "idle") moved++; }
    expect(moved).toBeGreaterThan(0); const t = w.get(e, Transform)!; expect(Math.hypot(t.x - 800, t.y)).toBeGreaterThan(10);
    G.markSpawnOffscreen(a, false); expect(G.spawnedOffscreen(a)).toBe(false);
  });
});
