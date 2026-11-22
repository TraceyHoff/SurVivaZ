import { describe, it, expect } from "vitest";
import { Transform, World } from "@engine/core";
import { LoopbackNetwork, NetClient } from "@engine/net";
import { AccountAssigned, ClaimAccount, MemoryWorldStore, SetName, nameToWords, tokenToWords, wordsToToken } from "@engine/persist";
import { createGameServer, applyMoveInput, installDemoWorld, DEMO_COMMANDS, DEMO_EVENTS } from "../src/main.js";
import { SPAWN } from "../src/game.js";

// ADR-514: a save written before the floor-height stamp (pre-ADR-511, 3-level floors) re-seats its player's z on
// restore; stamped saves load z as saved.
async function run(store: MemoryWorldStore) {
  const net = new LoopbackNetwork(7);
  const gs = createGameServer({ transport: net.createServer(), spawnPoints: [SPAWN], store, seed: 99, autosaveSeconds: 2, playerSaveSeconds: 1, population: false });
  const join = async (token?: string): Promise<{ account?: string }> => {
    const world = new World({ seed: 1 }); installDemoWorld(world, "client");
    const client = new NetClient({ world, transport: net.createClient(), commands: DEMO_COMMANDS, events: DEMO_EVENTS, sampleInput: () => ({ buttons: 0, aimX: 0, aimY: 0 }), applyInput: (w, e, cmd) => applyMoveInput(w, e, cmd) });
    const tc: { account?: string } = {};
    client.onEvent(AccountAssigned, (p) => { tc.account = wordsToToken(p); });
    const p = client.connect(); await new Promise((r) => setTimeout(r, 0)); net.advance(100); await p;
    client.sendCommand(ClaimAccount, token ? tokenToWords(token) : { t0: 0, t1: 0, t2: 0, t3: 0 }); client.sendCommand(SetName, nameToWords("z"));
    net.advance(50); gs.step(1 / 20); client.pollEvents(Infinity);
    return tc;
  };
  return { gs, join };
}

describe("ADR-514 floor-height stamp and legacy re-seat", () => {
  it("stamps new saves and keeps their z", async () => {
    const store = new MemoryWorldStore();
    const r1 = await run(store); const c = await r1.join();
    const pl = [...r1.gs.players.values()][0]! as { entity: number; account: string }; const pe = pl.entity; c.account = pl.account; r1.gs.world.set(pe, Transform, { z: 6.3125 });
    await r1.gs.shutdown();
    expect(store.readMeta()).toMatchObject({ floorLevels: 5, floorStampTick: 0 });
    const r2 = await run(store); const ent = r2.gs.world.create(); r2.gs.world.add(ent, Transform, { x: 0, y: 0, z: 0 });
    expect(r2.gs.persist!.restorePlayer(c.account!, ent)).toBeTruthy();
    // a current-grid z between floors (6.3125 = floor 1 + 1.3125, e.g. on stairs) is not touched in a stamped save
    expect(r2.gs.world.get(ent, Transform)!.z).toBeCloseTo(6.3125, 9);
    await r2.gs.shutdown();
  });
  it("re-seats a player saved on the 2nd floor of a pre-stamp save", async () => {
    const store = new MemoryWorldStore();
    const r1 = await run(store); const c = await r1.join();
    const pl = [...r1.gs.players.values()][0]! as { entity: number; account: string }; const pe = pl.entity; c.account = pl.account; r1.gs.world.set(pe, Transform, { z: 6.3125 }); // 3-level floor 2 deck
    await r1.gs.shutdown();
    const { floorLevels: _f, floorStampTick: _t, ...legacy } = store.readMeta()!; await store.write({ meta: legacy }); // a pre-ADR-514 save
    const logs: string[] = [];
    const net = new LoopbackNetwork(7);
    const gs = createGameServer({ transport: net.createServer(), spawnPoints: [SPAWN], store, seed: 99, autosaveSeconds: 2, playerSaveSeconds: 1, population: false, log: (m) => logs.push(m) });
    expect(logs.some((m) => m.includes("no floor-height stamp"))).toBe(true);
    const ent = gs.world.create(); gs.world.add(ent, Transform, { x: 0, y: 0, z: 0 });
    expect(gs.persist!.restorePlayer(c.account!, ent)).toBeTruthy();
    expect(gs.world.get(ent, Transform)!.z).toBeCloseTo(10.3125, 9);
    expect(logs.some((m) => m.includes("legacy floor height re-seated"))).toBe(true);
    await gs.shutdown();
    // the next boot carries the stamp: records saved from now on (the re-saved player) are not re-seated again
    expect(store.readMeta()!.floorLevels).toBe(5); expect(store.readMeta()!.floorStampTick).toBeGreaterThan(0);
  });
});
