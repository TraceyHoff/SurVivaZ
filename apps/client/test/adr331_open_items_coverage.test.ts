// ADR-331 live coverage for the two gaps that need the real local server (view / controller / chunk
// streaming live in apps/client/src/local.ts, not in gameplay):
//  1. live off-screen hand-back after a FAR RESPAWN: a bot that dies and respawns at a distributed point
//     far from every human starts off-screen (no view, no chunk streaming), and when a human comes near
//     it hands back to full sim — view + controller + chunk streaming resume — and its route/position
//     continue from where the coarse sim left them (the gameplay half of this is in
//     packages/gameplay/test/adr331_open_items_coverage.test.ts).
//  2. restoring a saved bot account over the new spawn placement: a bot whose AiMemory (base) was saved
//     keeps it across a server restart with the same store, does not land on the old four starter points,
//     and respawns at its remembered home (bed -> home -> distributed point, ADR-325) rather than a
//     starter point or a fresh distributed pick.
import { describe, expect, it } from "vitest";
import { Transform } from "@engine/core";
import { MemoryWorldStore } from "@engine/persist";
import { AI_SPAWN, Dead, TRAVEL, aiMemoryOf, aiSpawnPoints, baseHome, spawnedOffscreen, type TravelState } from "@engine/gameplay";
import { chunkKeyOf } from "@engine/world";
import { createLocalServer, type LocalServer } from "../src/local.js";
import { ClientSession, type KeyValue } from "../src/session.js";

class MapStorage implements KeyValue { m = new Map<string, string>(); getItem(k: string): string | null { return this.m.get(k) ?? null; } setItem(k: string, v: string): void { this.m.set(k, v); } }

/** Distance from `from` to `p` along the route polyline, plus p's distance off the polyline. */
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
/** The bot's current travel state: `travel` lives in AiMemory via travel.ts, not on the AiMemory type. */
const travelOf = (a: Parameters<typeof aiMemoryOf>[0]): TravelState | undefined =>
  (aiMemoryOf(a) as unknown as { travel?: TravelState }).travel;

async function pumpFor(local: LocalServer, ms: number, world?: { step: (dt: number) => void }, session?: ClientSession): Promise<void> {
  for (let t = 0; t < ms; t += 50) { local.pump(50); world?.step(1 / 20); session?.poll(); await Promise.resolve(); }
}

describe("ADR-331 live off-screen hand-back after a far respawn", () => {
  it("a bot that respawns far from every human starts off-screen, then hands back to full sim when a human comes near and keeps travelling", async () => {
    const local = await createLocalServer({ store: new MemoryWorldStore(), seed: 5, bots: 3, maxBots: 3, population: false });
    const session = new ClientSession({ storage: new MapStorage(), slot: "1", sampleButtons: () => 0 });
    try {
      const W = local.game.world;
      const connecting = session.connect("local", "Tess", local.createTransport());
      let world: { step: (dt: number) => void } | undefined;
      for (let i = 0; i < 20 && !world; i++) { local.pump(5); world = await Promise.race([connecting, Promise.resolve(undefined)]); }
      world ??= await connecting;
      await pumpFor(local, 1500, world, session);
      const human = [...local.game.players.values()].find((p) => !p.bot)!.entity;
      const humanPos = (): { x: number; y: number } => ({ ...W.get(human, Transform)! });
      // Kill a bot and wait for its respawn (respawnSeconds 10 = 200 ticks; the bot presses Respawn
      // like a player). Retry on a near-share pick until the respawn lands far from the human.
      let b0 = local.bots[0]!;
      for (let attempt = 0; attempt < 3; attempt++) {
        const e = local.game.players.get(b0.client.clientId)!.entity;
        const before = { ...W.get(e, Transform)! };
        W.add(e, Dead, { tick: W.tick } as never);
        let respawned = false;
        for (let t = 0; t < 30000; t += 50) { local.pump(50); world.step(1 / 20); session.poll(); await Promise.resolve(); if (!W.has(e, Dead)) { respawned = true; break; } }
        expect(respawned).toBe(true);
        const t = W.get(e, Transform)!; const h = humanPos();
        expect(Math.hypot(t.x - before.x, t.y - before.y)).toBeGreaterThan(5); // it really respawned elsewhere
        if (Math.hypot(t.x - h.x, t.y - h.y) > TRAVEL.offscreen.fullSimTiles + 5) break; // off-screen range
        if (attempt === 2) throw new Error("respawn never landed far from the human");
      }
      const e0 = local.game.players.get(b0.client.clientId)!.entity;
      const t0 = { ...W.get(e0, Transform)! };
      expect(spawnedOffscreen(b0.agent)).toBe(true); // the Respawned handler marked the far respawn off-screen
      expect(local.game.chunks.activeKeys.has(chunkKeyOf(t0.x, t0.y))).toBe(false); // no chunk streaming around it
      // the human walks (teleports) up to it: it hands back to full sim and streams its chunk again
      W.set(human, Transform, { x: t0.x + 6, y: t0.y });
      let handedBack = false;
      for (let t = 0; t < 15000; t += 50) {
        local.pump(50); world.step(1 / 20); session.poll(); await Promise.resolve();
        if (!spawnedOffscreen(b0.agent) && local.game.chunks.activeKeys.has(chunkKeyOf(W.get(e0, Transform)!.x, W.get(e0, Transform)!.y))) { handedBack = true; break; }
      }
      expect(handedBack).toBe(true);
      expect(spawnedOffscreen(b0.agent)).toBe(false);
      // its route continues from where the coarse sim left it: it picks a travel goal and walks it in full sim
      let routed = false;
      for (let t = 0; t < 60000; t += 50) {
        local.pump(50); world.step(1 / 20); session.poll(); await Promise.resolve();
        if (travelOf(b0.agent)?.route) { routed = true; break; }
      }
      expect(routed).toBe(true);
      const route = travelOf(b0.agent)!.route!;
      const origin = { ...travelOf(b0.agent)!.origin };
      const goal = { x: travelOf(b0.agent)!.x, y: travelOf(b0.agent)!.y };
      const handedPos = { ...W.get(e0, Transform)! };
      // Its route continues from where the coarse sim left it. A live bot also gathers on the way, may be out of
      // stamina, and its exact path varies with chunk-load timing, so this waits for real progress — along the
      // current route (a re-plan after arrival counts on the new trip) or plain displacement — not speed.
      // Arriving at the goal counts too: the trip was then walked, not re-planned. (Strict route/leg continuity
      // is pinned by the gameplay half of this test, where the route is deterministic.)
      let progressed = false;
      for (let t = 0; t < 120000; t += 50) {
        local.pump(50); world.step(1 / 20); session.poll(); await Promise.resolve();
        const pp = { ...W.get(e0, Transform)! };
        const tr = travelOf(b0.agent);
        if (!tr) { progressed = Math.hypot(pp.x - goal.x, pp.y - goal.y) <= TRAVEL.arriveTiles + 0.5; break; }
        const m = alongRoute(tr.route ?? route, tr.origin ?? origin, pp);
        if ((m.along > 5 && m.off < 8) || Math.hypot(pp.x - handedPos.x, pp.y - handedPos.y) > 8) { progressed = true; break; }
      }
      expect(progressed).toBe(true);
    } finally { session.disconnect(); await local.stop(); }
  }, 180_000);
});

describe("ADR-331 restoring a saved bot account over the new spawn placement", () => {
  it("a bot's saved base survives a restart, it does not land on a starter point, and it respawns at its remembered home", async () => {
    const store = new MemoryWorldStore();
    let base = { x: 0, y: 0 };
    {
      const first = await createLocalServer({ store, seed: 5, bots: 1, maxBots: 1, population: false });
      try {
        expect(first.bots).toHaveLength(1);
        const b = first.bots[0]!; const e = first.game.players.get(b.client.clientId)!.entity;
        const p = { ...first.game.world.get(e, Transform)! };
        // the base sits on the bot's own spawn point (a seeded clear patch, so baseHome = point + (1,1)
        // is walkable too and the home branch of aiRespawnPoint is not blocked by water)
        const pts = aiSpawnPoints(first.game.world);
        const spawn = pts.reduce((best, q) => (Math.hypot(q.x - p.x, q.y - p.y) < Math.hypot(best.x - p.x, best.y - p.y) ? q : best), pts[0]!);
        base = { x: spawn.x, y: spawn.y };
        aiMemoryOf(b.agent).base = { ...base }; // a homestead the bot remembers (persisted AiMemory)
        first.pump(500);
      } finally { await first.stop(); } // stop() flushes AiMemory with force + saves the player record
    }
    const second = await createLocalServer({ store, seed: 5, bots: 1, maxBots: 1, population: false });
    try {
      expect(second.bots).toHaveLength(1);
      const b = second.bots[0]!; const W = second.game.world;
      expect(aiMemoryOf(b.agent).base).toEqual(base); // the restored identity carries the saved base
      const e = second.game.players.get(b.client.clientId)!.entity;
      const t = { ...W.get(e, Transform)! };
      const starters = aiSpawnPoints(W).filter((q) => q.source === "starter");
      for (const s of starters) expect(Math.hypot(t.x - s.x, t.y - s.y)).toBeGreaterThan(AI_SPAWN.pick.jitter + 5); // not the old placement
      // die and respawn: bed -> home -> distributed point picks the restored home, not a fresh pick
      W.add(e, Dead, { tick: W.tick } as never);
      let respawned = false;
      for (let t = 0; t < 30000; t += 50) { second.pump(50); await Promise.resolve(); if (!W.has(e, Dead)) { respawned = true; break; } }
      expect(respawned).toBe(true);
      const t2 = W.get(e, Transform)!; const home = baseHome(base);
      expect(Math.hypot(t2.x - home.x, t2.y - home.y)).toBeLessThanOrEqual(2);
    } finally { await second.stop(); }
  }, 180_000);
});
