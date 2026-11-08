import { describe, it, expect } from "vitest";
import { TimeOfDay, Transform, World, timeOfDay } from "@engine/core";
import { BuildPiece, PieceOwner, gameplayDefs, spawnPoints } from "@engine/gameplay";
import { LoopbackNetwork, NetClient } from "@engine/net";
import { ProceduralGenerator, computeSpawnPoints } from "@engine/world";
import { createGameServer, applyMoveInput, installDemoWorld, DEMO_COMMANDS, DEMO_EVENTS } from "../src/main.js";

async function setup(seed = 77) {
  const net = new LoopbackNetwork(3);
  const gs = createGameServer({ transport: net.createServer(), seed });
  const clients: NetClient[] = [];
  const tick = (n = 1): void => { for (let i = 0; i < n; i++) { net.advance(50); gs.step(1 / 20); for (const c of clients) { c.world.step(1 / 20); c.pollEvents(Infinity); } } };
  const connect = async (): Promise<NetClient> => {
    const world = new World({ seed: 1 }); installDemoWorld(world, "client");
    const client = new NetClient({ world, transport: net.createClient(), commands: DEMO_COMMANDS, events: DEMO_EVENTS, sampleInput: () => ({ buttons: 0, aimX: 0, aimY: 0 }), applyInput: (w, e, cmd) => applyMoveInput(w, e, cmd) });
    const p = client.connect(); await new Promise((r) => setTimeout(r, 0)); net.advance(100); await p; clients.push(client); return client;
  };
  // Long runs yield to the event loop between chunks so the vitest worker can keep answering its RPC (onTaskUpdate) heartbeats.
  const tickAsync = async (n: number, chunk = 50): Promise<void> => { for (let done = 0; done < n; done += chunk) { tick(Math.min(chunk, n - done)); await new Promise((r) => setTimeout(r, 0)); } };
  return { gs, tick, tickAsync, connect };
}

describe("world start (ADR-106)", { timeout: 30_000 }, () => {
  it("is a blank slate: no starter camp pieces", async () => {
    const { gs, tick } = await setup(); tick(5);
    const pieces = [...gs.world.query([BuildPiece])];
    expect(pieces.every((e) => (gs.world.getField(e, PieceOwner, "player") ?? 0) === 0)).toBe(true);
    const totem = (() => { try { return gameplayDefs(gs.world).pieceId("claim_totem"); } catch { return -1; } })();
    expect(pieces.filter((e) => gs.world.getField(e, BuildPiece, "type") === totem)).toHaveLength(0);
  });
  it("exposes the seed's four spawn points and spreads joining players over all of them", async () => {
    const { gs, tick, connect } = await setup(77);
    const want = computeSpawnPoints(new ProceduralGenerator({ seed: 77 }));
    expect(gs.spawnPoints).toEqual(want); expect(spawnPoints(gs.world)).toEqual(want);
    for (let i = 0; i < 4; i++) { await connect(); tick(2); }
    const near = new Set<number>();
    for (const p of gs.players.values()) {
      const t = gs.world.get(p.entity, Transform)!; const i = want.findIndex((s) => Math.hypot(s.x - t.x, s.y - t.y) <= 3);
      expect(i).toBeGreaterThanOrEqual(0); near.add(i);
    }
    expect(near.size).toBe(4);
  });
  it("one in-game day lasts one real hour of fixed ticks", async () => {
    const { gs, tick, tickAsync, connect } = await setup(); const c = await connect(); tick(5);
    expect(gs.world.env(TimeOfDay).dayLengthTicks).toBe(3600 * 20);
    const h0 = timeOfDay(gs.world).hours; await tickAsync(20 * 150); // 150 s sim time = 1 in-game hour
    expect(timeOfDay(gs.world).hours - h0).toBeCloseTo(1, 5);
    // the HUD clock reads timeOfDay(client world): the replicated day length + epoch keep it in step with the server
    expect(c.world.env(TimeOfDay).dayLengthTicks).toBe(3600 * 20);
    expect(Math.abs(timeOfDay(c.world, gs.world.tick).hours - timeOfDay(gs.world).hours)).toBeLessThan(1e-6);
  }, 180_000);
});
