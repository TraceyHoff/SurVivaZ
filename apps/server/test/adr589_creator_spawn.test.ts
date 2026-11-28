// ADR-589: with GameServerOptions.spawnIndex set, the FIRST human join spawns at the
// creator's chosen point; later joins fall back to the least-crowded pick. Without the
// option, joins behave exactly as before.
import { describe, expect, it } from "vitest";
import { Transform, World } from "@engine/core";
import * as G from "@engine/gameplay";
import { LoopbackNetwork, NetClient } from "@engine/net";
import { ClaimAccount, MemoryWorldStore } from "@engine/persist";
import { createGameServer, installDemoWorld, DEMO_COMMANDS, DEMO_EVENTS } from "../src/main.js";

const PTS = [{ x: 100, y: -100 }, { x: 100, y: 100 }, { x: -100, y: 100 }, { x: -100, y: -100 }];

async function session(spawnIndex?: number) {
  const net = new LoopbackNetwork(589), store = new MemoryWorldStore();
  const gs = createGameServer({ transport: net.createServer(), seed: 21, store, population: false, spawnPoints: PTS, ...(spawnIndex !== undefined ? { spawnIndex } : {}) });
  gs.world.setResource(G.TerrainRes, { tileAt: () => 3, heightAt: () => 0 });
  const clients: NetClient[] = [];
  const tick = () => { for (let i = 0; i < 4; i++) { net.advance(50); gs.step(.05); for (const c of clients) { c.world.step(.05); c.pollEvents(Infinity); } } };
  const join = async () => {
    const w = new World(); installDemoWorld(w, "client");
    const c = new NetClient({ world: w, transport: net.createClient(), commands: DEMO_COMMANDS, events: DEMO_EVENTS, sampleInput: () => ({ buttons: 0, aimX: 0, aimY: 0 }) });
    const connected = c.connect(); await new Promise(r => setTimeout(r, 0)); net.advance(100); await connected; clients.push(c);
    c.sendCommand(ClaimAccount, { t0: 0, t1: 0, t2: 0, t3: 0 }); tick();
    return gs.players.get(c.clientId)!.entity;
  };
  return { gs, join };
}
const near = (gs: Awaited<ReturnType<typeof session>>["gs"], e: number, p: { x: number; y: number }): boolean => {
  const t = gs.world.get(e, Transform)!;
  return Math.hypot(t.x - p.x, t.y - p.y) <= G.SPAWN_JITTER + 0.001;
};

describe("ADR-589 creator spawn point", () => {
  it("the first join spawns at the chosen point; the second join does not", async () => {
    const s = await session(2);
    const first = await s.join();
    expect(near(s.gs, first, PTS[2]!)).toBe(true);
    const second = await s.join();
    expect(near(s.gs, second, PTS[2]!)).toBe(false); // least-crowded pick avoids the occupied point
    await s.gs.shutdown();
  });

  it("without spawnIndex the first join uses the ordinary pick", async () => {
    const s = await session(undefined);
    const first = await s.join();
    expect(PTS.some((p) => near(s.gs, first, p))).toBe(true);
    await s.gs.shutdown();
  });
});
