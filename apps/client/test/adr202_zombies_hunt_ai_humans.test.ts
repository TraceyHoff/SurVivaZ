// ADR-202: zombies hunt AI humans (virtual players) exactly like players.
import { describe, expect, it } from "vitest";
import { Transform, setTimeOfDay } from "@engine/core";
import { MemoryWorldStore } from "@engine/persist";
import { ZombieBrain, gameplayDefs, spawnZombie, inSpawnSafeRadius, SAFE_SPAWN_RADIUS } from "@engine/gameplay";
import { createLocalServer, type LocalServer } from "../src/local.js";

const botEntities = (l: LocalServer) => new Set(l.bots.map((b) => l.game.players.get(b.client.clientId)!.entity));

describe("zombies hunt AI humans like players (ADR-202)", () => {
  it("a night zombie acquires an AI human outside the spawn sanctuary", async () => {
    const local = await createLocalServer({ store: new MemoryWorldStore(), seed: 11, bots: 1, maxBots: 1, population: false, aiSpawn: "starters" }); // ADR-325: this fixture is about the starter sanctuary
    try {
      const W = local.game.world; setTimeOfDay(W, 23);
      for (let i = 0; i < 10; i++) { local.pump(50); await Promise.resolve(); }
      expect(local.bots).toHaveLength(1);
      const bot = [...botEntities(local)][0]!; const start = W.get(bot, Transform)!;
      // Task 33 protects fresh arrivals, including AI humans. Test the hunt outside that
      // radius rather than accidentally asserting that zombies should ignore spawn safety.
      expect(inSpawnSafeRadius(W, start.x, start.y)).toBe(true);
      let x = start.x; const y = start.y;
      while (inSpawnSafeRadius(W, x, y)) x += SAFE_SPAWN_RADIUS + 5;
      W.set(bot, Transform, { x, y });
      expect(inSpawnSafeRadius(W, x, y)).toBe(false);
      const z = spawnZombie(W, [...gameplayDefs(W).zombies.values()][0]!.id, x + 3, y);
      for (let i = 0; i < 60 && W.getField(z, ZombieBrain, "target") !== bot; i++) { local.pump(50); await Promise.resolve(); }
      expect(W.getField(z, ZombieBrain, "target")).toBe(bot);
    } finally { await local.stop(); }
  });
});
