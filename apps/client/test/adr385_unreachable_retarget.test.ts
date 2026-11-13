// ADR-385 live regression for the ADR-383+384 gate scenario (seed 5, SITE_CHANCE 0.25).
//
// The gate proved the freeze: raising SITE_CHANCE 0.15 -> 0.25 moved bot0's respawn next to a ridge,
// and the nearest wild berry bush sat at height 14 while the bot stood at 8 (rise +6, max unaided
// climb 3). The garden behaviour re-picked that same bush every sense cycle — no reachability check,
// no ban — so the bot walked 10 tiles to the ridge foot, then its displacement stayed exactly 0.0
// for the full 120 s while stuckCount grew 7 -> 42 and navGoal sat at (43.5, 681.5) at every sample.
// The gather sensor had the same flaw. This test replays that scenario live and asserts the bot
// re-targets and keeps travelling instead of freezing: displacement grows past the adr331 bar (8
// tiles) and its navGoal changes (it picks another target), where the frozen bot held one navGoal
// and never moved. Setup mirrors apps/client/test/adr331_open_items_coverage.test.ts.
import { describe, expect, it } from "vitest";
import { Transform } from "@engine/core";
import { MemoryWorldStore } from "@engine/persist";
import { Dead, TRAVEL, aiMemoryOf, spawnedOffscreen, type TravelState } from "@engine/gameplay";
import { chunkKeyOf } from "@engine/world";
import { createLocalServer, type LocalServer } from "../src/local.js";
import { ClientSession, type KeyValue } from "../src/session.js";

class MapStorage implements KeyValue { m = new Map<string, string>(); getItem(k: string): string | null { return this.m.get(k) ?? null; } setItem(k: string, v: string): void { this.m.set(k, v); } }

/** The bot's current travel state: `travel` lives in AiMemory via travel.ts, not on the AiMemory type. */
const travelOf = (a: Parameters<typeof aiMemoryOf>[0]): TravelState | undefined =>
  (aiMemoryOf(a) as unknown as { travel?: TravelState }).travel;

async function pumpFor(local: LocalServer, ms: number, world?: { step: (dt: number) => void }, session?: ClientSession): Promise<void> {
  for (let t = 0; t < ms; t += 50) { local.pump(50); world?.step(1 / 20); session?.poll(); await Promise.resolve(); }
}

describe("ADR-385 a bot whose goal node is unreachable re-targets instead of freezing", () => {
  it("on the seed-5 gate scenario the bot keeps travelling and its navGoal changes (no 120 s freeze)", async () => {
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
      const b0 = local.bots[0]!;
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
      const handedPos = { ...W.get(e0, Transform)! };
      const bb = b0.agent.bb;
      // The frozen bot held navGoal (43.5, 681.5) and displacement 0.0 at every 10 s sample for 120 s.
      // The fixed bot re-targets: its navGoal changes and it travels away from the hand-back point.
      // Same displacement bar as adr331 (8 tiles); break early once both signals are seen.
      let maxDisp = 0; const navGoals = new Set<string>();
      for (let s = 0; s < 12; s++) {
        await pumpFor(local, 10000, world, session);
        const pp = { ...W.get(e0, Transform)! };
        maxDisp = Math.max(maxDisp, Math.hypot(pp.x - handedPos.x, pp.y - handedPos.y));
        const gx = bb.get<number>("navGoalX"), gy = bb.get<number>("navGoalY");
        if (gx !== undefined && gy !== undefined) navGoals.add(`${gx},${gy}`);
        if (maxDisp > 8 && navGoals.size >= 2) break;
      }
      expect(maxDisp).toBeGreaterThan(8); // it travelled, not froze at the ridge foot
      expect(navGoals.size).toBeGreaterThanOrEqual(2); // it re-targeted instead of holding one unreachable goal
    } finally { session.disconnect(); await local.stop(); }
  }, 180_000);
});
