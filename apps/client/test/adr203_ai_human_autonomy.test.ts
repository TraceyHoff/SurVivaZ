// ADR-203: AI humans (virtual players) pursue their own goals: move, gather, craft, build, tend a fire.
import { beforeAll, describe, expect, it } from "vitest";
import { setTimeOfDay, timeOfDay, Transform } from "@engine/core";
import { MemoryWorldStore } from "@engine/persist";
import { BuildPiece, CraftCompleted, ItemGathered, gameplayDefs } from "@engine/gameplay";
import { createLocalServer, type LocalServer } from "../src/local.js";

const botEntities = (l: LocalServer) => new Set(l.bots.map((b) => l.game.players.get(b.client.clientId)!.entity));

describe("AI human autonomy (ADR-203)", () => {
  let local: LocalServer; const gatheredAt: number[] = []; const crafted = new Set<string>(); let fireBy = -1; let fireHour = -1; let start = 0;
  beforeAll(async () => {
    local = await createLocalServer({ store: new MemoryWorldStore(), seed: 11, bots: 4, aiSpawn: "starters" }); // ADR-325: fixture keeps the ADR-106 starter placement
    const W = local.game.world; setTimeOfDay(W, 15); start = W.tick;
    const bots = botEntities(local);
    W.events.on(ItemGathered as never, (e: { entity: number }) => { if (bots.has(e.entity as never)) gatheredAt.push(W.tick - start); });
    W.events.on(CraftCompleted as never, (e: { entity: number; recipe: number }) => { if (bots.has(e.entity as never)) crafted.add(gameplayDefs(W).recipes.get(e.recipe)?.key ?? "?"); });
    const fire = [...gameplayDefs(W).pieces.values()].find((p) => p.key === "campfire")!.id;
    const homes = [...bots].map((e) => W.get(e, Transform)!).filter(Boolean);
    for (let i = 0; i < 4800 && fireBy < 0; i++) { // ADR-310: the Claim Flag (10 wood, 10 stone, 2 dye) now goes down before the fire
      local.pump(50); await Promise.resolve();
      if (i % 20 === 0) {
        for (const e of W.query([BuildPiece])) {
          if (W.getField(e, BuildPiece, "type") !== fire) continue;
          const t = W.get(e, Transform);
          if (t && homes.some((h) => Math.hypot(t.x - h.x, t.y - h.y) <= 16)) {
            fireBy = W.tick - start; fireHour = timeOfDay(W).hours; break;
          }
        }
      }
    }
  }, 240_000);

  it("an AI human moves to a resource and gathers within N ticks (stand-still bug: every swing was out of range)", () => {
    expect(gatheredAt.length).toBeGreaterThan(0);
    expect(gatheredAt[0]!).toBeLessThan(600);
  });
  it("an AI human crafts a stone axe from what it gathered", () => {
    expect(crafted.has("stone_axe")).toBe(true);
  });
  it("an AI human builds a campfire near home before night", () => {
    expect(fireBy).toBeGreaterThanOrEqual(0);
    expect(fireHour).toBeGreaterThanOrEqual(15); expect(fireHour).toBeLessThan(21); // placed the same afternoon / dusk
  });
});

