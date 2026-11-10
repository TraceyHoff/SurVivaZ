// ADR-325 live: host-added AI humans spawn at world-wide points away from the players' spawn areas, start in the ADR-324
// off-screen sim (no chunk streaming around them), hand back when a human comes near; maxBots still caps them.
import { describe, expect, it } from "vitest";
import { Transform } from "@engine/core";
import { MemoryWorldStore } from "@engine/persist";
import { AI_SPAWN, TRAVEL, aiSpawnPoints, spawnedOffscreen } from "@engine/gameplay";
import { chunkKeyOf } from "@engine/world";
import { createLocalServer } from "../src/local.js";
import { ClientSession, type KeyValue } from "../src/session.js";

class MapStorage implements KeyValue { m = new Map<string, string>(); getItem(k: string): string | null { return this.m.get(k) ?? null; } setItem(k: string, v: string): void { this.m.set(k, v); } }

describe("ADR-325 AI humans spawn around the world", () => {
  it("bots land on distinct world-wide points far from the player spawn areas, off-screen until a human comes near", async () => {
    const local = await createLocalServer({ store: new MemoryWorldStore(), seed: 5, bots: 3, maxBots: 3, population: false });
    const session = new ClientSession({ storage: new MapStorage(), slot: "1", sampleButtons: () => 0 });
    try {
      const W = local.game.world; expect(local.bots).toHaveLength(3);
      const pts = aiSpawnPoints(W); const starters = pts.filter((p) => p.source === "starter");
      const pos = local.bots.map((b) => ({ ...W.get(local.game.players.get(b.client.clientId)!.entity, Transform)! }));
      const idx = pos.map((p) => pts.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) <= AI_SPAWN.pick.jitter + 1e-3));
      expect(idx.every((i) => i >= 0)).toBe(true); expect(new Set(idx).size).toBe(3);
      for (const p of pos) expect(Math.min(...starters.map((s) => Math.hypot(s.x - p.x, s.y - p.y)))).toBeGreaterThanOrEqual(AI_SPAWN.pick.onScreenTiles - AI_SPAWN.pick.jitter);
      expect(local.bots.every((b) => spawnedOffscreen(b.agent))).toBe(true);
      // a human joins at a starter point: far bots stop streaming chunks (cheap off-screen sim)
      const connecting = session.connect("local", "Tess", local.createTransport());
      let world; for (let i = 0; i < 20 && !world; i++) { local.pump(5); world = await Promise.race([connecting, Promise.resolve(undefined)]); }
      world ??= await connecting;
      for (let t = 0; t < 1500; t += 50) { local.pump(50); world.step(1 / 20); session.poll(); await Promise.resolve(); }
      const human = [...local.game.players.values()].find((p) => !p.bot)!.entity; const h = W.get(human, Transform)!;
      const far = local.bots.filter((b) => { const t = W.get(local.game.players.get(b.client.clientId)!.entity, Transform)!; return Math.hypot(t.x - h.x, t.y - h.y) > TRAVEL.offscreen.fullSimTiles + 40; });
      expect(far.length).toBeGreaterThan(0);
      for (const b of far) { const t = W.get(local.game.players.get(b.client.clientId)!.entity, Transform)!; expect(local.game.chunks.activeKeys.has(chunkKeyOf(t.x, t.y))).toBe(false); }
      // the human walks (teleports) up to one: it hands back to full sim and streams its chunk again
      const b0 = far[0]!; const t0 = W.get(local.game.players.get(b0.client.clientId)!.entity, Transform)!;
      W.set(human, Transform, { x: t0.x + 6, y: t0.y });
      for (let t = 0; t < 1500; t += 50) { local.pump(50); world.step(1 / 20); session.poll(); await Promise.resolve(); }
      expect(spawnedOffscreen(b0.agent)).toBe(false);
      const t1 = W.get(local.game.players.get(b0.client.clientId)!.entity, Transform)!; expect(local.game.chunks.activeKeys.has(chunkKeyOf(t1.x, t1.y))).toBe(true);
    } finally { session.disconnect(); await local.stop(); }
  }, 120_000);
  it("maxBots still caps the host's AI humans", async () => {
    const local = await createLocalServer({ store: new MemoryWorldStore(), seed: 5, bots: 6, maxBots: 2, population: false });
    try { expect(local.bots).toHaveLength(2); } finally { await local.stop(); }
  });
});
