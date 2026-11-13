/**
 * ADR-369: net replication — dirty-driven capture, pooled/aligned bit copies, cached per-client
 * relevant-netId lists, and once-per-chunk distance scoring for tile/static streaming.
 * Wire-identical throughout: no protocol, snapshot-format or ordering-contract change
 * (see the ADR for the one documented tie-order nuance in the relevant-netId cache).
 */
import { describe, expect, it } from "vitest";
import { NetId, Owner, Transform, type Entity } from "@engine/core";
import { CHUNK_SIZE, TileMap } from "@engine/world";
import {
  BitReader, BitWriter, LoopbackNetwork, NetClient, NetSchema, NetServer, TileSync,
  captureState, decodeDelta, encodeDelta,
} from "../src/index.js";
import { Buff, Chest, Control, Secret, frames, join, makeWorld } from "./fixture.js";

describe("ADR-369 bit bulk copies", () => {
  it("writeBytes/readBytes match per-byte writeBits/readBits, aligned and unaligned", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 34, 200, 7, 9, 10]);
    for (const prefixBits of [0, 3]) {
      const a = new BitWriter(); const b = new BitWriter();
      if (prefixBits) { a.writeBits(0b101, 3); b.writeBits(0b101, 3); }
      a.writeBytes(bytes);
      for (const x of bytes) b.writeBits(x, 8);
      expect(a.finish()).toEqual(b.finish());
      const ra = new BitReader(a.finish()); const rb = new BitReader(b.finish());
      if (prefixBits) { expect(ra.readBits(3)).toBe(0b101); expect(rb.readBits(3)).toBe(0b101); }
      expect(ra.readBytes(bytes.length)).toEqual(bytes);
      expect(rb.readBytes(bytes.length)).toEqual(bytes);
    }
  });
  it("readBytes overrun throws the same RangeError as readBits", () => {
    const w = new BitWriter(); w.writeBytes(new Uint8Array([1, 2]));
    expect(() => new BitReader(w.finish()).readBytes(3)).toThrow(/out of data/);
    const w2 = new BitWriter(); w2.writeBits(1, 1); w2.writeBytes(new Uint8Array([1, 2]));
    const r2 = new BitReader(w2.finish()); r2.readBits(1);
    expect(() => r2.readBytes(3)).toThrow(/out of data/);
  });
});

describe("ADR-369 dirty-driven captureState", () => {
  function worldWithMobs(n: number) {
    const w = makeWorld(); const schema = new NetSchema(w); const ids: number[] = []; const ents: Entity[] = [];
    for (let i = 0; i < n; i++) {
      const e = w.create();
      w.add(e, NetId, { id: 1000 + i }).add(e, Transform, { x: i, y: 1 }).add(e, Buff, { power: 1, kind: 1 });
      ids.push(1000 + i); ents.push(e);
    }
    return { w, schema, ids, ents };
  }
  it("an idle tick reuses every entity state; a non-replicated write changes nothing", () => {
    const { w, schema, ids, ents } = worldWithMobs(200);
    const s0 = captureState(w, schema, undefined); w.clearChanges();
    // ADR-376: captureState mutates `prev` in place, so the reference states are a copy taken before the next capture.
    const first = new Map(s0);
    const s1 = captureState(w, schema, s0); w.clearChanges();
    for (const id of ids) expect(s1.get(id)).toBe(first.get(id));
    w.setField(ents[0]!, Control, "buttons", 3); // Control is not networked: no replicated change
    const s2 = captureState(w, schema, s1); w.clearChanges();
    for (const id of ids) expect(s2.get(id)).toBe(first.get(id));
    w.setField(ents[5]!, Buff, "power", 2);
    const s3 = captureState(w, schema, s2); w.clearChanges();
    for (const id of ids) if (id !== 1005) expect(s3.get(id)).toBe(first.get(id));
    expect(s3.get(1005)).not.toBe(first.get(1005));
    const ti = schema.indexOf(Transform, w)!; const bi = schema.indexOf(Buff, w)!;
    expect(s3.get(1005)!.get(ti)).toBe(first.get(1005)!.get(ti)); // untouched component structurally shared
    expect(s3.get(1005)!.get(bi)).not.toBe(first.get(1005)!.get(bi));
    w.remove(ents[6]!, Buff); // removal still detected via the removal record, not the dirty set
    const s4 = captureState(w, schema, s3);
    expect(s4.get(1006)).not.toBe(first.get(1006));
    expect(s4.get(1006)!.has(bi)).toBe(false);
    for (const id of ids) if (id !== 1005 && id !== 1006) expect(s4.get(id)).toBe(first.get(id));
  });
  it("multi-component change + removal round-trips exactly (two-pointer mask write)", () => {
    const w = makeWorld(); const schema = new NetSchema(w);
    const a = w.create();
    w.add(a, NetId, { id: 1 }).add(a, Transform, { x: 1, y: 1 }).add(a, Buff, { power: 3, kind: 1 })
      .add(a, Secret, { gold: 5 }).add(a, Chest, { items: 9 });
    const s0 = captureState(w, schema, undefined); w.clearChanges();
    w.setField(a, Buff, "power", 4); w.setField(a, Secret, "gold", 6); w.remove(a, Chest);
    const s0base = new Map(s0); // ADR-376: captureState mutates `prev` in place
    const s1 = captureState(w, schema, s0);
    const wr = new BitWriter(); const stats = encodeDelta(wr, schema, s1, s0base);
    expect(stats).toEqual({ spawns: 0, despawns: 0, changes: 1 });
    const d = decodeDelta(new BitReader(wr.finish()), schema, s0base);
    expect(d.state).toEqual(s1);
    expect(d.changed.get(1)?.removed).toEqual([schema.indexOf(Chest, w)]);
  });
});

describe("ADR-369 per-client relevant-netId cache", () => {
  async function setup() {
    const net = new LoopbackNetwork(6); const sw = makeWorld();
    const server = new NetServer({ world: sw, transport: net.createServer(), interest: { radius: 1, hysteresis: 1 },
      onClientJoin: (s, w) => { const e = w.create(); w.add(e, Transform, { x: 1, y: 1 }).add(e, Owner, { clientId: s.clientId }); } });
    const A = new NetClient({ world: makeWorld(), transport: net.createClient({ latencyMs: 10 }) });
    await join(net, A);
    const step = (n: number) => frames(net, [sw, A.world], n);
    return { net, sw, server, A, step };
  }
  it("idle ticks hit the cache, an intra-AOI chunk move keeps it, leaving the AOI rebuilds it", async () => {
    const x = await setup();
    const mobs: Entity[] = [];
    for (let i = 0; i < 40; i++) { const e = x.sw.create(); x.sw.add(e, Transform, { x: 10 + (i % 20), y: 10 }).add(e, Buff, { power: 1, kind: 1 }); mobs.push(e); }
    x.step(5);
    for (const m of mobs) expect(x.A.entityOf(x.server.netIds.netIdOf(m)!)).toBeDefined();
    x.step(1); // idle tick: cache hit, no rebuild
    expect(x.server.perf.relevantHits).toBe(1); expect(x.server.perf.relevantBuilds).toBe(0);
    const mover = mobs[0]!; // chunk (0,0) -> (1,0): still inside the AOI, set unchanged -> still a hit
    x.sw.setField(mover, Transform, "x", 40);
    x.step(1);
    expect(x.server.perf.relevantHits).toBe(1); expect(x.server.perf.relevantBuilds).toBe(0);
    expect(x.A.entityOf(x.server.netIds.netIdOf(mover)!)).toBeDefined();
    x.sw.setField(mover, Transform, "x", 8 * CHUNK_SIZE); // out of the AOI: the next tick rebuilds
    x.step(1);
    expect(x.server.perf.relevantBuilds).toBe(1);
    x.step(x.server.tickHz * 2 + 5); // past the leave-hysteresis linger
    expect(x.A.entityOf(x.server.netIds.netIdOf(mover)!)).toBeUndefined();
    x.sw.setField(mover, Transform, "x", 20); x.step(5); // re-entry: full spawn again
    expect(x.A.entityOf(x.server.netIds.netIdOf(mover)!)).toBeDefined();
  });
  it("netIds.generation moves when a netId is assigned or released", async () => {
    const x = await setup();
    const g0 = x.server.netIds.generation;
    const e = x.sw.create(); x.sw.add(e, Transform, { x: 5, y: 5 });
    x.step(1);
    expect(x.server.netIds.generation).toBeGreaterThan(g0);
    expect(x.server.netIds.netIdOf(e)).toBeDefined();
    const g1 = x.server.netIds.generation;
    x.sw.destroy(e); x.step(1);
    expect(x.server.netIds.generation).toBeGreaterThan(g1);
    expect(x.server.netIds.netIdOf(e)).toBeUndefined();
  });
});

describe("ADR-369 tile streaming order", () => {
  /** 12x12 chunks of terrain (same shape as tiles.test.ts) so RLE sizes are realistic. */
  function terrain(): TileMap {
    const m = new TileMap();
    for (let cy = 0; cy < 12; cy++) for (let cx = 0; cx < 12; cx++) {
      const c = m.ensureChunk(cx, cy);
      for (let i = 0; i < c.tiles.length; i++) { const x = cx * CHUNK_SIZE + (i % CHUNK_SIZE), y = cy * CHUNK_SIZE + ((i / CHUNK_SIZE) | 0); c.tiles[i] = ((x * 7 + y * 3) >> 4) % 5 + 1; c.height[i] = (x + y) >> 5 & 3; }
    }
    m.tileChanges(); // initial fill isn't an edit
    return m;
  }
  it("streams AOI chunks nearest-first (distances non-decreasing)", async () => {
    const net = new LoopbackNetwork(9); const sw = makeWorld(); const tiles = terrain();
    const server = new NetServer({ world: sw, transport: net.createServer(), interest: { radius: 2, hysteresis: 0 },
      onClientJoin: (s, w) => { const e = w.create(); w.add(e, Transform, { x: 48, y: 48 }).add(e, Owner, { clientId: s.clientId }); } });
    const sync = new TileSync(server, { tiles, budgetBytes: 64 * 1024 });
    const c = new NetClient({ world: makeWorld(), transport: net.createClient({ latencyMs: 10 }) });
    await join(net, c);
    frames(net, [sw, c.world], 10);
    const keys = [...c.tiles.tiles.loadedChunks()].map((ch) => ch.key);
    expect(keys.length).toBe(16); // radius 2 around chunk (1,1), clipped to the 12x12 terrain
    expect(keys[0]).toBe("1,1");
    const d = (key: string): number => { const [cx, cy] = key.split(",").map(Number); const x = (cx! + 0.5) * CHUNK_SIZE, y = (cy! + 0.5) * CHUNK_SIZE; return (x - 48) ** 2 + (y - 48) ** 2; };
    for (let i = 1; i < keys.length; i++) expect(d(keys[i]!)).toBeGreaterThanOrEqual(d(keys[i - 1]!));
    expect(sync.sessionStats(1)!.fulls).toBe(16);
  });
});
