/**
 * ADR-498: the TileSync first-chunk hook. onFirstChunk fires once per chunk the first time a client
 * receives it (a Full send for a chunk the client holds no cached copy of) — and NOT on a re-entry
 * Hit, where the client restores the chunk from its own cache. The server wires this hook to the
 * discovery journal; the gameplay store dedups post-eviction re-sends.
 */
import { describe, expect, it } from "vitest";
import { Owner, Transform, type Entity } from "@engine/core";
import { CHUNK_SIZE, TileMap, type ChunkKey } from "@engine/world";
import { LoopbackNetwork, NetClient, NetServer, TileSync } from "../src/index.js";
import { frames, join, makeWorld } from "./fixture.js";

/** 12x12 chunks of grass, so the AOI around both the start and the eastern stop is fully inside the terrain. */
function terrain(): TileMap {
  const m = new TileMap();
  for (let cy = 0; cy < 12; cy++) for (let cx = 0; cx < 12; cx++) {
    const c = m.ensureChunk(cx, cy);
    for (let i = 0; i < c.tiles.length; i++) c.tiles[i] = 3;
  }
  m.tileChanges(); // initial fill isn't an edit
  return m;
}

async function setup() {
  const net = new LoopbackNetwork(5); const sw = makeWorld(); const tiles = terrain(); const players = new Map<number, Entity>();
  const server = new NetServer({ world: sw, transport: net.createServer(), interest: { radius: 1, hysteresis: 0 },
    onClientJoin: (s, w) => { const e = w.create(); w.add(e, Transform, { x: 48 + s.clientId * 3, y: 48 }).add(e, Owner, { clientId: s.clientId }); players.set(s.clientId, e); } });
  const seen: { clientId: number; key: ChunkKey }[] = [];
  const sync = new TileSync(server, { tiles, budgetBytes: 4096, onFirstChunk: (clientId, key) => { seen.push({ clientId, key }); } });
  const c = new NetClient({ world: makeWorld(), transport: net.createClient({ latencyMs: 40, jitterMs: 10, loss: 0 }) });
  await join(net, c);
  const step = (k = 1) => frames(net, [sw, c.world], k);
  const move = (x: number, y: number) => { const e = players.get(1)!; sw.setField(e, Transform, "x", x); sw.setField(e, Transform, "y", y); };
  return { net, sw, server, tiles, sync, c, step, move, seen };
}

describe("ADR-498 TileSync first-chunk hook", () => {
  it("fires once per chunk on first receipt, and not on a re-entry Hit", async () => {
    const x = await setup();
    x.step(10);
    // The player starts at (48,48) -> chunk (1,1); the radius-1 AOI is the 3x3 around it.
    const aoi = new Set<string>();
    for (let cy = 0; cy <= 2; cy++) for (let cx = 0; cx <= 2; cx++) aoi.add(`${cx},${cy}`);
    expect(x.seen.length).toBe(9);
    expect(x.seen.every((s) => s.clientId === 1)).toBe(true);
    expect(new Set(x.seen.map((s) => s.key))).toEqual(aoi);
    expect(x.sync.sessionStats(1)!.fulls).toBe(9);

    // Walk six chunks east: the new AOI (6..8, 0..2) is 9 fresh Fulls -> 9 more hook calls.
    x.move(48 + 6 * CHUNK_SIZE, 48); x.step(10);
    expect(x.seen.length).toBe(18);
    const east = new Set<string>();
    for (let cy = 0; cy <= 2; cy++) for (let cx = 6; cx <= 8; cx++) east.add(`${cx},${cy}`);
    expect(new Set(x.seen.slice(9).map((s) => s.key))).toEqual(east);

    // Walk back: the old chunks return from the client's cache as Hits -> no new hook calls.
    const before = x.sync.sessionStats(1)!;
    x.move(48, 48); x.step(10);
    const after = x.sync.sessionStats(1)!;
    expect(x.seen.length).toBe(18);
    expect(after.hits - before.hits).toBe(9);
    expect(after.fulls - before.fulls).toBe(0);
  });
});
