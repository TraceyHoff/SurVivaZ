// ADR-348: a friend-code guest's arrival point (ADR-295, near the host) is a safe centre for
// PVP.guestSafeSeconds, so the guest is not ambushed while still loading in. The guest arrives far
// from every installed starter point, so any protection at the arrival point comes from the
// temporary centre alone — not from Task 33.
import { describe, expect, it } from "vitest";
import { Transform, World } from "@engine/core";
import * as G from "@engine/gameplay";
import { LoopbackNetwork, NetClient } from "@engine/net";
import { AccountAssigned, ClaimAccount, MemoryWorldStore, tokenToWords, wordsToToken } from "@engine/persist";
import { createGameServer, installDemoWorld, DEMO_COMMANDS, DEMO_EVENTS } from "../src/main.js";

async function session() {
  const net = new LoopbackNetwork(348), store = new MemoryWorldStore(); let hostId: number | undefined;
  const gs = createGameServer({ transport: net.createServer(), seed: 21, store, population: false, joinNearClient: () => hostId });
  gs.world.setResource(G.TerrainRes, { tileAt: () => 3, heightAt: () => 0 });
  const clients: NetClient[] = [];
  const tick = () => { for (let i = 0; i < 4; i++) { net.advance(50); gs.step(.05); for (const c of clients) { c.world.step(.05); c.pollEvents(Infinity); } } };
  const join = async (token?: string) => {
    const w = new World(); installDemoWorld(w, "client");
    const c = new NetClient({ world: w, transport: net.createClient(), commands: DEMO_COMMANDS, events: DEMO_EVENTS, sampleInput: () => ({ buttons: 0, aimX: 0, aimY: 0 }) });
    let account = ""; c.onEvent(AccountAssigned, p => { account = wordsToToken(p); });
    const connected = c.connect(); await new Promise(r => setTimeout(r, 0)); net.advance(100); await connected; clients.push(c);
    c.sendCommand(ClaimAccount, token ? tokenToWords(token) : { t0: 0, t1: 0, t2: 0, t3: 0 }); tick();
    return { c, entity: gs.players.get(c.clientId)!.entity, account: () => account };
  };
  return { gs, store, tick, join, host: (id: number) => { hostId = id; } };
}

describe("ADR-348 friend-code guest arrival safe zone", () => {
  it("a guest's arrival point near the host is a safe centre for guestSafeSeconds, then lapses", async () => {
    const s = await session(), host = await s.join(); s.host(host.c.clientId);
    s.gs.world.set(host.entity, Transform, { x: 500.5, y: 500.5, z: 0 });
    // No installed starter point is near (500, 500): the starters sit ~48-144 tiles from the origin.
    expect(G.inSpawnSafeRadius(s.gs.world, 500.5, 500.5)).toBe(false);
    const guest = await s.join(), p = s.gs.world.get(guest.entity, Transform)!;
    expect(Math.hypot(p.x - 500.5, p.y - 500.5)).toBeLessThanOrEqual(3);
    expect(G.inSpawnSafeRadius(s.gs.world, p.x, p.y)).toBe(true);
    expect(G.inSpawnSafeRadius(s.gs.world, p.x + 19, p.y)).toBe(true);
    expect(G.inSpawnSafeRadius(s.gs.world, p.x + 21, p.y)).toBe(false);
    // The zone is temporary: once guestSafeSeconds of ticks pass it is gone, while the installed
    // starter points keep their permanent protection.
    s.gs.world.tick += 20 * G.PVP.guestSafeSeconds;
    expect(G.inSpawnSafeRadius(s.gs.world, p.x, p.y)).toBe(false);
    const starter = G.installedSpawnPoints(s.gs.world)![0]!; // a starter point, still protected
    expect(G.inSpawnSafeRadius(s.gs.world, starter.x, starter.y)).toBe(true);
    await s.gs.shutdown();
  });
});
