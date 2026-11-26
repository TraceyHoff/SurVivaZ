import { describe, expect, it } from "vitest";
import { defineComponent, Owner, Transform, type World } from "@engine/core";
import { CHUNK_SIZE } from "@engine/world";
import { LoopbackNetwork, NetClient, NetServer } from "../src/index.js";
import { frames, join, makeWorld } from "./fixture.js";

const BuildPiece = defineComponent("BuildPiece", { type: "u16", rot: "u8", variant: "u8", tier: "u8", hp: "u16", damageStage: "u8", paint: "u8" }, { networked: true });
const mk = (): World => { const w = makeWorld(); w.register(BuildPiece); return w; };
const FIELDS = ["type", "rot", "variant", "tier", "hp", "damageStage", "paint"] as const;

async function setup(opts: { loss?: number; cacheChunks?: number } = {}) {
  const net = new LoopbackNetwork(11); const sw = mk();
  let player = 0;
  const server = new NetServer({ world: sw, transport: net.createServer(), interest: { radius: 2, hysteresis: 0 }, staticBudgetBytes: 8 * 1024,
    // ADR-547: this file pins the steady 8 KiB budget (closest-first spread over ~10 ticks); the
    // default entry burst would deliver the whole AOI in ~4 ticks and break the early-arrival
    // pins below. Burst behaviour is covered by adr547_entry_burst.test.ts.
    entryStaticBurst: false,
    onClientJoin: (s, w) => { player = w.create(); w.add(player, Transform, { x: 112, y: 112 }).add(player, Owner, { clientId: s.clientId }); } });
  server.setReplicationClass(BuildPiece, "static");
  // 3000-piece base over 3x3 chunks (96x96 tiles) starting at tile 64
  const pieces: number[] = [];
  for (let i = 0; i < 3000; i++) {
    const e = sw.create();
    sw.add(e, Transform, { x: 64 + (i % 55) * 1.75, y: 64 + Math.floor(i / 55) * 1.75 })
      .add(e, BuildPiece, { type: i % 40, rot: i % 4, variant: i % 3, tier: 1 + (i % 4), hp: 500, damageStage: 0, paint: 0 });
    pieces.push(e);
  }
  const A = new NetClient({ world: mk(), transport: net.createClient({ latencyMs: 30, jitterMs: 10, loss: opts.loss ?? 0.1 }), ...(opts.cacheChunks !== undefined && { staticCacheChunks: opts.cacheChunks }) });
  await join(net, A);
  const step = (n = 1) => frames(net, [sw, A.world], n);
  /** Pieces in the client's AOI on the server vs what the client holds. Returns mismatch count. */
  const mismatches = (): { missing: number; wrong: number; extra: number; expected: number } => {
    const rel = server.interest!.grid.get(1)!.chunks; let missing = 0, wrong = 0, expected = 0;
    const want = new Set<number>();
    for (const e of sw.query([BuildPiece, Transform])) {
      const t = sw.get(e, Transform)!; const key = `${Math.floor(t.x / CHUNK_SIZE)},${Math.floor(t.y / CHUNK_SIZE)}`;
      if (!rel.has(key)) continue;
      expected++; const id = server.netIds.netIdOf(e)!; want.add(id);
      const ce = A.entityOf(id); const cp = ce === undefined ? undefined : A.world.get(ce, BuildPiece);
      if (!cp) { missing++; continue; }
      const sp = sw.get(e, BuildPiece)!; const ct = A.world.get(ce!, Transform)!;
      if (FIELDS.some((f) => sp[f] !== cp[f]) || Math.abs(ct.x - t.x) > 1e-4) wrong++;
    }
    let extra = 0; for (const e of A.world.query([BuildPiece])) if (!want.has(A.netIdOf(e)!)) extra++;
    return { missing, wrong, extra, expected };
  };
  return { net, sw, A, server, pieces, step, mismatches, player: () => player };
}

describe("static replication class (building pieces)", () => {
  it("streams a 3000-piece base budget-aware, then ~0 B steady state; damage/repair/destroy/place stay exact under 10% loss", async () => {
    const { sw, A, server, pieces, step, mismatches } = await setup();
    let ticks = 0;
    step(3); ticks = 3; // closest chunks first: early pieces are nearer the player (112,112) than the base average
    const d = (e: number) => { const t = A.world.get(e, Transform)!; return Math.max(Math.abs(t.x - 112), Math.abs(t.y - 112)); };
    const early = [...A.world.query([BuildPiece])];
    expect(early.length).toBeGreaterThan(0); expect(early.length).toBeLessThan(3000);
    expect(early.reduce((a, e) => a + d(e), 0) / early.length).toBeLessThan(26);
    while ([...A.world.query([BuildPiece])].length < 3000 && ticks < 200) { step(); ticks++; }
    const st0 = server.staticStats(1)!;
    console.log(JSON.stringify({ initialStreamTicks: ticks, initialStreamMs: ticks * 50, staticBytes: st0.bytes, bytesPerPiece: +(st0.bytes / 3000).toFixed(1) }));
    expect(mismatches()).toEqual({ missing: 0, wrong: 0, extra: 0, expected: 3000 });
    expect(ticks).toBeGreaterThan(3); // spread over several ticks by the 8 KiB budget
    expect(ticks).toBeLessThan(40);
    expect(st0.bytes).toBeLessThan(3000 * 30);
    // nothing in snapshots: pieces never go through the delta path
    expect(server.sessions.get(1)!.lastSnapshotBytes).toBeLessThan(200);
    step(5);
    const b0 = server.staticStats(1)!.bytes; step(40);
    const steady = server.staticStats(1)!.bytes - b0;
    console.log(JSON.stringify({ steadyStaticBytesPer40Ticks: steady }));
    expect(steady).toBe(0);
    // damage 200, repair 100 of them, destroy 50, place 30 — over several ticks
    for (let i = 0; i < 200; i++) sw.setField(pieces[i * 7]!, BuildPiece, "hp", 120 + i);
    for (let i = 0; i < 200; i++) sw.setField(pieces[i * 7]!, BuildPiece, "damageStage", 2);
    step(2);
    for (let i = 0; i < 100; i++) { sw.setField(pieces[i * 7]!, BuildPiece, "hp", 500); sw.setField(pieces[i * 7]!, BuildPiece, "damageStage", 0); }
    const b1 = server.staticStats(1)!.bytes;
    step(1);
    for (let i = 0; i < 50; i++) sw.destroy(pieces[2000 + i]!);
    for (let i = 0; i < 30; i++) { const e = sw.create(); sw.add(e, Transform, { x: 70 + i, y: 150 }).add(e, BuildPiece, { type: 7, rot: 1, variant: 0, tier: 2, hp: 300, damageStage: 0, paint: 3 }); }
    step(10);
    console.log(JSON.stringify({ changeBatchBytes: server.staticStats(1)!.bytes - b1, changes: 100 + 50 + 30 }));
    expect(mismatches()).toEqual({ missing: 0, wrong: 0, extra: 0, expected: 2980 });
    expect(A.statics.stats.nacks).toBe(0);
  });

  it("re-entering an unchanged chunk is a cache hit; changed chunks restream; same-tick place/destroy on entry is exact", async () => {
    const { sw, A, server, pieces, step, mismatches, player } = await setup({ loss: 0.1 });
    step(40);
    expect(mismatches().missing).toBe(0);
    const away = (x: number) => sw.setField(player(), Transform, "x", x);
    away(112 + 10 * CHUNK_SIZE); step(5);
    expect([...A.world.query([BuildPiece])].length).toBe(0);
    expect(A.statics.cache.size).toBeGreaterThan(0);
    // while away: change one chunk only (pieces near the base's low-y edge, chunk 2,2)
    sw.setField(pieces[0]!, BuildPiece, "paint", 9);
    step(3);
    const before = server.staticStats(1)!;
    away(112);
    // same tick as entry: destroy one piece, place one, damage one
    sw.destroy(pieces[1]!); const e = sw.create(); sw.add(e, Transform, { x: 65, y: 65 }).add(e, BuildPiece, { type: 1, rot: 0, variant: 0, tier: 1, hp: 50, damageStage: 3, paint: 0 });
    sw.setField(pieces[2]!, BuildPiece, "hp", 1);
    step(20);
    const after = server.staticStats(1)!;
    console.log(JSON.stringify({ reentryBytes: after.bytes - before.bytes, cacheHits: after.hits - before.hits, restreamed: after.streamedChunks - before.streamedChunks }));
    expect(after.hits - before.hits).toBeGreaterThanOrEqual(8); // 9 base chunks, 1 changed
    expect(after.streamedChunks - before.streamedChunks).toBe(1);
    expect(mismatches()).toEqual({ missing: 0, wrong: 0, extra: 0, expected: 3000 });
    expect(A.world.get(A.entityOf(server.netIds.netIdOf(pieces[0]!)!)!, BuildPiece)!.paint).toBe(9);
  });

  it("bounded client LRU: evicted chunks are restreamed; a changing chunk mid-stream converges", async () => {
    const { sw, A, server, pieces, step, mismatches, player } = await setup({ cacheChunks: 2 });
    step(40);
    sw.setField(player(), Transform, "x", 112 + 10 * CHUNK_SIZE); step(5);
    expect(A.statics.cache.size).toBe(2); expect(A.statics.stats.evictions).toBeGreaterThan(0);
    const before = server.staticStats(1)!;
    sw.setField(player(), Transform, "x", 112);
    for (let t = 0; t < 10; t++) { sw.setField(pieces[t * 50]!, BuildPiece, "hp", 10 + t); step(1); } // churn during the stream
    step(20);
    const after = server.staticStats(1)!;
    expect(after.hits - before.hits).toBeLessThanOrEqual(2);
    expect(mismatches()).toEqual({ missing: 0, wrong: 0, extra: 0, expected: 3000 });
  });

  it("a Hit for a chunk the client already evicted is Nack'd and restreamed", async () => {
    const { sw, A, server, step, mismatches, player } = await setup();
    step(40);
    sw.setField(player(), Transform, "x", 112 + 10 * CHUNK_SIZE); step(5);
    A.statics.cache.clear(); // client lost its cache without telling the server (e.g. memory pressure)
    sw.setField(player(), Transform, "x", 112); step(30);
    expect(A.statics.stats.nacks).toBeGreaterThan(0);
    expect(mismatches()).toEqual({ missing: 0, wrong: 0, extra: 0, expected: 3000 });
    expect(server.staticStats(1)!.streaming).toBe(0);
  });

  it("raid: 600 pieces destroyed in one tick across chunks -> compact sorted delta-varint removal batches", async () => {
    const { sw, A, server, pieces, step, mismatches } = await setup({ loss: 0.1 });
    step(40); expect(mismatches().missing).toBe(0);
    const b0 = server.staticStats(1)!.bytes;
    const victims = pieces.filter((_, i) => i % 5 === 0).slice(0, 600); // spread over all 9 chunks
    for (const e of victims) sw.destroy(e);
    step(1);
    const bytes = server.staticStats(1)!.bytes - b0;
    console.log(JSON.stringify({ raidRemoved: victims.length, raidBytes: bytes, bytesPerRemoval: +(bytes / victims.length).toFixed(2) }));
    expect(bytes).toBeLessThan(victims.length * 1.6);
    step(5);
    expect(mismatches()).toEqual({ missing: 0, wrong: 0, extra: 0, expected: 2400 });
  });

  it("raid scale: 600 removals + 1000 hp changes in one tick ride one batched static delta (no BuildingGrid stream)", async () => {
    const { sw, server, pieces, step, mismatches } = await setup({ loss: 0.1 });
    step(40); expect(mismatches().missing).toBe(0);
    const b0 = server.staticStats(1)!.bytes;
    const victims = pieces.filter((_, i) => i % 5 === 0).slice(0, 600);
    const damaged = pieces.filter((_, i) => i % 5 !== 0).slice(0, 1000);
    for (const e of victims) sw.destroy(e);
    damaged.forEach((e, i) => sw.setField(e, BuildPiece, "hp", 500 - 1 - (i % 400)));
    step(1);
    const bytes = server.staticStats(1)!.bytes - b0;
    console.log(JSON.stringify({ raidRemoved: 600, raidHpChanges: 1000, raidBytes: bytes, bytesPerOp: +(bytes / 1600).toFixed(2) }));
    expect(bytes).toBeLessThan(600 * 1.6 + 1000 * 3.5);
    step(5);
    expect(mismatches()).toEqual({ missing: 0, wrong: 0, extra: 0, expected: 2400 });
  });
});
