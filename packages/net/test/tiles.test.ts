import { describe, expect, it } from "vitest";
import { Owner, Transform, type Entity } from "@engine/core";
import { CHUNK_SIZE, TileMap } from "@engine/world";
import { LoopbackNetwork, NetClient, NetServer } from "../src/index.js";
import { frames, join, makeWorld } from "./fixture.js";

/** 12x12 chunks of terrain (grass/dirt/water bands) with some structure, so RLE is realistic. */
function terrain(): TileMap {
  const m = new TileMap();
  for (let cy = 0; cy < 12; cy++) for (let cx = 0; cx < 12; cx++) {
    const c = m.ensureChunk(cx, cy);
    for (let i = 0; i < c.tiles.length; i++) { const x = cx * CHUNK_SIZE + (i % CHUNK_SIZE), y = cy * CHUNK_SIZE + ((i / CHUNK_SIZE) | 0); c.tiles[i] = ((x * 7 + y * 3) >> 4) % 5 + 1; c.height[i] = (x + y) >> 5 & 3; }
  }
  m.tileChanges(); // initial fill isn't an edit
  return m;
}
async function setup(n = 2, loss = 0.1) {
  const net = new LoopbackNetwork(5); const sw = makeWorld(); const tiles = terrain(); const players = new Map<number, Entity>();
  const server = new NetServer({ world: sw, transport: net.createServer(), interest: { radius: 1, hysteresis: 0 },
    onClientJoin: (s, w) => { const e = w.create(); w.add(e, Transform, { x: 48 + s.clientId * 3, y: 48 }).add(e, Owner, { clientId: s.clientId }); players.set(s.clientId, e); } });
  const { TileSync } = await import("../src/index.js");
  const sync = new TileSync(server, { tiles, budgetBytes: 4096 });
  const cs: NetClient[] = [];
  for (let i = 0; i < n; i++) { const c = new NetClient({ world: makeWorld(), transport: net.createClient({ latencyMs: 40, jitterMs: 10, loss }) }); await join(net, c); cs.push(c); }
  const step = (k = 1) => frames(net, [sw, ...cs.map((c) => c.world)], k);
  const move = (cid: number, x: number, y: number) => { const e = players.get(cid)!; sw.setField(e, Transform, "x", x); sw.setField(e, Transform, "y", y); };
  /** Tiles mismatching between server and client over the chunks the server thinks the client has. */
  const diff = (ci: number): { chunks: number; bad: number } => {
    const rel = server.relevantChunks(ci + 1)!; let bad = 0, chunks = 0;
    for (const key of rel) {
      const s = tiles.getChunkByKey(key); if (!s) continue; const c = cs[ci]!.tiles.tiles.getChunkByKey(key);
      chunks++; if (!c) { bad += 1024; continue; }
      for (let i = 0; i < 1024; i++) if (s.tiles[i] !== c.tiles[i] || s.height[i] !== c.height[i]) bad++;
    }
    return { chunks, bad };
  };
  return { net, sw, server, tiles, sync, cs, step, move, diff };
}

describe("tile replication", () => {
  it("streams AOI chunks closest first and keeps them exact under 10% loss with continuous edits (deltas encoded once)", async () => {
    const x = await setup(2, 0.1);
    x.step(4);
    const first = [...x.cs[0]!.tiles.tiles.loadedChunks()].map((c) => c.key);
    expect(first[0]).toBe("1,1"); // own chunk first
    let rng = 7; const r = () => ((rng = (rng * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let t = 0; t < 120; t++) {
      for (let k = 0; k < 20; k++) x.tiles.setTile(16 + Math.floor(r() * 64), 16 + Math.floor(r() * 64), 1 + Math.floor(r() * 30));
      x.step(1);
    }
    x.step(30);
    for (const ci of [0, 1]) { const d = x.diff(ci); expect(d.chunks).toBe(9); expect(d.bad).toBe(0); }
    const a = x.sync.sessionStats(1)!, b = x.sync.sessionStats(2)!;
    expect(a.fulls).toBe(9); expect(a.deltas).toBeGreaterThan(300);
    // each changed chunk is encoded once per tick no matter how many subscribers
    expect(x.sync.stats.deltaChunks).toBeLessThanOrEqual(120 * 9);
    expect(a.deltas + b.deltas).toBeGreaterThan(x.sync.stats.deltaChunks);
    // client side tileChanges() reports replicated edits for the renderer
    expect(x.cs[0]!.tiles.tiles.tileChanges().length).toBeGreaterThan(0);
  });

  it("re-entry: Hit when the cached version matches, Full with the new tiles when the chunk changed while away", async () => {
    const x = await setup(1, 0.1);
    x.step(6); const T = x.cs[0]!.tiles;
    expect(T.tiles.getChunkByKey("1,1")).toBeDefined();
    x.move(1, 48 + 6 * 32, 48); x.step(10); // leave 0..2 x 0..2
    expect(T.tiles.getChunkByKey("0,0")).toBeUndefined(); expect(T.cache.has("0,0")).toBe(true);
    x.tiles.setTile(5, 5, 99); x.step(2); // chunk 0,0 changes while away (no delta: not subscribed)
    const before = x.sync.sessionStats(1)!;
    x.move(1, 48, 48); x.step(10);
    const after = x.sync.sessionStats(1)!;
    expect(T.getTile(5, 5)).toBe(99);
    expect(T.tiles.getChunkByKey("0,0")!.version).toBe(x.tiles.getChunkByKey("0,0")!.version);
    expect(after.fulls - before.fulls).toBe(1); // only 0,0 restreamed
    expect(after.hits - before.hits).toBe(8); // the other 8 came from cache
    expect(x.diff(0).bad).toBe(0);
  });

  it("ADR-411: a full resend carries signed i16 heights — dug pits, high ground and flow water — exactly", async () => {
    const { flowWaterRaw } = await import("@engine/world");
    const x = await setup(1, 0);
    x.step(4);
    const c = x.tiles.getChunkByKey("1,1")!;
    const vals = [-100, -1, 0, 26, 100, flowWaterRaw(-100), flowWaterRaw(100)];
    for (let i = 0; i < 1024; i++) {
      const v = vals[i % vals.length]!;
      const lx = i % CHUNK_SIZE, ly = (i / CHUNK_SIZE) | 0;
      if (v >= 700) c.set(lx, ly, 1); // flow-water cells are water tiles (local coords)
      c.setHeight(lx, ly, v);
    }
    x.step(6);
    expect(x.diff(0).bad).toBe(0);
    const got = x.cs[0]!.tiles.tiles.getChunkByKey("1,1")!;
    expect(got.getHeight(0, 0)).toBe(-100); expect(got.getHeight(4, 0)).toBe(100);
    expect(got.getHeight(5, 0)).toBe(flowWaterRaw(-100)); expect(got.getHeight(6, 0)).toBe(flowWaterRaw(100));
  });
});
