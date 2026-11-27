import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopbackNetwork } from "@engine/net";
import { SqliteWorldStore } from "@engine/persist/node";
import { PlaceRoadCmd, RemoveRoadCmd, PlaceSignCmd, SetSignTextCmd, RemoveSignCmd, worldRules } from "@engine/gameplay";
import { createGameServer } from "../src/main.js";
import { gameplayNet, COMMAND_REJECT_REASONS } from "../src/protocol.js";

describe("ADR-119..121 server wiring", () => {
  it("road + sign commands are bridged; their reject reasons have codes", () => {
    for (const c of [PlaceRoadCmd, RemoveRoadCmd, PlaceSignCmd, SetSignTextCmd, RemoveSignCmd]) expect(() => gameplayNet(c)).not.toThrow();
    for (const r of ["no_tool", "cannot_afford", "not_owner", "no_item", "bad_surface"]) expect(COMMAND_REJECT_REASONS as readonly string[]).toContain(r);
  });
  it("world rules: new-world options apply once, then the save keeps its own (SQLite meta)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rules-")); const path = join(dir, "w.sqlite");
    try {
      const g1 = createGameServer({ transport: new LoopbackNetwork(1).createServer(), store: await SqliteWorldStore.open(path), seed: 3, population: false, worldRules: { hordes: false, hordeGraceDays: 6 } });
      expect(worldRules(g1.world)).toEqual({ hordes: false, hordeGraceDays: 6, aiHumans: true, zombies: true, creative: false });
      await g1.shutdown();
      const s2 = await SqliteWorldStore.open(path); expect(s2.readMeta()?.hordes).toBe(0); expect(s2.readMeta()?.hordeGraceDays).toBe(6);
      const g2 = createGameServer({ transport: new LoopbackNetwork(1).createServer(), store: s2, seed: 3, population: false, worldRules: { hordes: true } });
      expect(worldRules(g2.world)).toEqual({ hordes: false, hordeGraceDays: 6, aiHumans: true, zombies: true, creative: false });
      await g2.shutdown();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("in-memory worlds default to hordes on, 3-day grace", async () => {
    const g = createGameServer({ transport: new LoopbackNetwork(1).createServer(), seed: 3, population: false });
    expect(worldRules(g.world)).toEqual({ hordes: true, hordeGraceDays: 3, aiHumans: true, zombies: true, creative: false }); await g.shutdown();
  });
});
