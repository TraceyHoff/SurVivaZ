import { describe, it, expect } from "vitest";
import { LoopbackNetwork } from "@engine/net";
import { MemoryWorldStore } from "@engine/persist";
import { createGameServer } from "../src/main.js";
import { SPAWN } from "../src/game.js";

// ADR-594: a save written before abandoned structures spawned intact has no intactStampTick; it gets one past every
// stored record (so those chunks restore their sites on load), and new worlds stamp 0 (nothing legacy).
const boot = (store: MemoryWorldStore, logs: string[] = []) =>
  createGameServer({ transport: new LoopbackNetwork(7).createServer(), spawnPoints: [SPAWN], store, seed: 99, autosaveSeconds: 2, playerSaveSeconds: 1, population: false, log: (m) => logs.push(m) });

describe("ADR-594 intact-structure stamp", () => {
  it("new worlds stamp 0 and never log a legacy restore", async () => {
    const store = new MemoryWorldStore(); const logs: string[] = [];
    const gs = boot(store, logs); await gs.shutdown();
    expect(store.readMeta()).toMatchObject({ intactStampTick: 0 });
    const again = boot(store, logs); await again.shutdown();
    expect(logs.some((m) => m.includes("intact-structure stamp"))).toBe(false);
    expect(store.readMeta()!.intactStampTick).toBe(0);
  });
  it("a pre-ADR-594 save is stamped past its last record, and the stamp holds on later boots", async () => {
    const store = new MemoryWorldStore();
    const g1 = boot(store); g1.world.tick += 40; await g1.shutdown();
    const { intactStampTick: _s, ...legacy } = store.readMeta()!; await store.write({ meta: legacy });
    const logs: string[] = []; const g2 = boot(store, logs);
    expect(logs.some((m) => m.includes("no intact-structure stamp"))).toBe(true);
    await g2.shutdown();
    const stamp = store.readMeta()!.intactStampTick!; expect(stamp).toBeGreaterThan(legacy.tick);
    const logs3: string[] = []; const g3 = boot(store, logs3); await g3.shutdown();
    expect(logs3.some((m) => m.includes("no intact-structure stamp"))).toBe(false);
    expect(store.readMeta()!.intactStampTick).toBe(stamp);
  });
});
