/**
 * ADR-375: net replicate — cut per-tick allocations.
 * - BitWriter.appendWriter / reset() are bit-identical to the snapshotBits() path.
 * - Replicate output is byte-identical to the pre-375 code (golden hash, computed on
 *   the baseline tree) across a scripted 2-client run that exercises the prioritize()
 *   limit path (small budget), the shared record cache, and the tail of the order.
 * - Prioritization still sends nearest first and does not starve the tail.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NetId, Owner, Rng, Transform, World, type Entity } from "@engine/core";
import { BitWriter, NetServer, encodeHello, encodeInput, type Channel, type ConnId, type ServerTransport } from "../src/index.js";
import { DT, makeWorld } from "./fixture.js";

class FakeTransport implements ServerTransport {
  bytes: Uint8Array[] = [];
  private msg: ((c: ConnId, b: Uint8Array, ch: Channel) => void)[] = [];
  onConnect(): void {} onDisconnect(): void {}
  onMessage(fn: (c: ConnId, b: Uint8Array, ch: Channel) => void): void { this.msg.push(fn); }
  send(_c: ConnId, b: Uint8Array): void { this.bytes.push(b.slice()); }
  disconnect(): void {} close(): void {}
  inject(c: ConnId, b: Uint8Array): void { for (const f of this.msg) f(c, b, "reliable"); }
}

describe("ADR-375 BitWriter appendWriter/reset", () => {
  it("appendWriter matches appendBits(snapshotBits()) at aligned and unaligned offsets", () => {
    for (const lead of [0, 1, 3, 7, 8, 13]) {
      for (const [aBits, bBits] of [[5, 11], [32, 7], [64, 64], [1, 1]] as const) {
        const mk = (seed: number): BitWriter => { const w = new BitWriter(); for (let i = 0; i < aBits + bBits; i++) w.writeBits((seed >>> (i % 29)) & 1, 1); return w; };
        const a = mk(0x1234567), b = mk(0x89abcdef);
        const ref = new BitWriter(); ref.writeBits(0, lead);
        const sa = a.snapshotBits(), sb = b.snapshotBits();
        ref.appendBits(sa.bytes, sa.bits); ref.appendBits(sb.bytes, sb.bits); ref.writeBits(3, 2);
        const got = new BitWriter(); got.writeBits(0, lead);
        got.appendWriter(a); got.appendWriter(b); got.writeBits(3, 2);
        expect(got.bitLength).toBe(ref.bitLength);
        expect([...got.finish()]).toEqual([...ref.finish()]);
      }
    }
  });
  it("appendWriter of an empty writer is a no-op", () => {
    const w = new BitWriter(); w.writeBits(0b101, 3); w.appendWriter(new BitWriter());
    expect(w.bitLength).toBe(3); expect([...w.finish()]).toEqual([0b101]);
  });
  it("reset() clears stale bits: rewritten content equals a fresh writer", () => {
    const w = new BitWriter();
    for (let i = 0; i < 200; i++) w.writeBits(1, 1); // long run of 1s, then reset
    w.reset();
    w.writeBits(0b10110, 5); w.writeVarUint(300); w.writeF32(1.5);
    const fresh = new BitWriter(); fresh.writeBits(0b10110, 5); fresh.writeVarUint(300); fresh.writeF32(1.5);
    expect(w.bitLength).toBe(fresh.bitLength);
    expect([...w.finish()]).toEqual([...fresh.finish()]);
    // reset again to something shorter than the previous content: no 1-bits leak
    w.reset(); w.writeBits(0, 3);
    expect([...w.finish()]).toEqual([0]);
  });
});

function runScripted(): { hash: string; server: NetServer; players: Entity[]; ents: Entity[]; world: World } {
  const w: World = makeWorld(); const rng = new Rng(99);
  const t = new FakeTransport();
  const players: Entity[] = [];
  const server = new NetServer({
    world: w, transport: t, budgetBytes: 256, interest: false,
    randomToken: () => new Uint8Array(16).fill(1 + players.length % 200),
    onClientJoin: (s, world) => {
      const e = world.create();
      world.add(e, Transform, { x: 100, y: 100 }).add(e, Owner, { clientId: s.clientId });
      players.push(e);
    },
  });
  const ents: Entity[] = [];
  for (let i = 0; i < 300; i++) { const e = w.create(); w.add(e, Transform, { x: rng.range(0, 256), y: rng.range(0, 256) }); ents.push(e); }
  for (let c = 1; c <= 2; c++) t.inject(c, encodeHello({ hashes: server.requiredHashes, token: new Uint8Array(16) }));
  for (let tick = 0; tick < 40; tick++) {
    for (let i = 0; i < 30; i++) { const e = ents[rng.int(0, ents.length)]!; w.setField(e, Transform, "x", w.getField(e, Transform, "x")! + rng.range(-0.2, 0.2)); }
    w.step(DT);
    for (let c = 1; c <= 2; c++) t.inject(c, encodeInput({ ackTick: Math.max(0, w.tick - 3), cmds: [] }));
  }
  const h = createHash("sha256");
  for (const b of t.bytes) h.update(b);
  return { hash: h.digest("hex"), server, players, ents, world: w };
}

describe("ADR-375 replicate byte-identical output", () => {
  it("scripted 2-client run hashes identically to the pre-375 baseline", () => {
    const { hash } = runScripted();
    console.log("ADR-375 golden hash:", hash);
    expect(hash).toBe("0e5064c6c59ecb774f362dc91f7e8770db138ded6809dd3f9b8cd59d64586222");
  });
  it("nearest-first under a tiny budget, tail not starved", () => {
    const w: World = makeWorld(); const rng = new Rng(7);
    const t = new FakeTransport();
    let player: Entity | undefined;
    const server = new NetServer({
      world: w, transport: t, budgetBytes: 64, interest: false,
      randomToken: () => new Uint8Array(16).fill(3),
      onClientJoin: (s, world) => {
        player = world.create();
        world.add(player, Transform, { x: 100, y: 100 }).add(player, Owner, { clientId: s.clientId });
      },
    });
    const ents: Entity[] = [];
    for (let i = 0; i < 60; i++) { const e = w.create(); w.add(e, Transform, { x: rng.range(0, 256), y: rng.range(0, 256) }); ents.push(e); }
    t.inject(1, encodeHello({ hashes: server.requiredHashes, token: new Uint8Array(16) }));
    const d2 = (e: Entity): number => { const dx = w.getField(e, Transform, "x")! - 100, dy = w.getField(e, Transform, "y")! - 100; return dx * dx + dy * dy; };
    const sorted = [...ents].sort((a, b) => d2(a) - d2(b));
    const near = sorted[0]!, far = sorted[sorted.length - 1]!;
    w.step(DT); // netIds are assigned inside replicate
    const nearId = server.netIds.netIdOf(near), farId = server.netIds.netIdOf(far);
    t.inject(1, encodeInput({ ackTick: 0, cmds: [] }));
    const session = server.sessions.get(1)!;
    // First tick: only a prefix of the prioritized order fits the 64-byte budget.
    expect(nearId).toBeDefined(); expect(farId).toBeDefined();
    expect(server.clientHolds(session, nearId!)).toBe(true);
    expect(server.clientHolds(session, farId!)).toBe(false);
    // Eventually the tail is sent too (sent entities leave `rest`, so it drains;
    // ~1 entity/tick at this budget with a 3-tick ack lag, so 60 entities need >60 ticks).
    for (let k = 0; k < 90; k++) { w.step(DT); t.inject(1, encodeInput({ ackTick: Math.max(0, w.tick - 3), cmds: [] })); }
    expect(server.clientHolds(session, farId!)).toBe(true);
    expect(player).toBeDefined();
  });
});
