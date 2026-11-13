/**
 * ADR-376: captureState O(N) floor — in-place WorldState update + generation-stamped
 * Uint16Array dirty/touched flags instead of a fresh N-entry Map and two Set.has per
 * entity. Same snapshot bytes (protocol still v8); the contract change is that the
 * returned map IS `prev`, mutated — callers must copy it first if they need the old
 * contents (see the updated delta / ADR-369 / container tests).
 *
 * Note: makeWorld's environment singleton holds netId 1, so every size below counts
 * it; test ids start at 100 to avoid colliding with it.
 */
import { describe, expect, it } from "vitest";
import { NetId, Transform, type Entity, type World } from "@engine/core";
import { BitReader, BitWriter, NetSchema, captureState, decodeDelta, encodeDelta, fromWire, type WorldState } from "../src/index.js";
import { Buff, makeWorld } from "./fixture.js";

function spawn(w: World, id: number, x: number): Entity {
  const e = w.create(); w.add(e, NetId, { id }).add(e, Transform, { x, y: 1 }); return e;
}

/** Scripted change sequence; returns the per-tick delta bytes (bases copied pre-capture). */
function scriptedBytes(): Uint8Array[] {
  const w = makeWorld(); const schema = new NetSchema(w);
  const a = spawn(w, 101, 1); const b = spawn(w, 102, 2); w.add(b, Buff, { power: 3, kind: 1 });
  const bytes: Uint8Array[] = [];
  let prev: WorldState | undefined;
  const cap = (): WorldState => {
    const base = prev === undefined ? undefined : new Map(prev); // ADR-376: copy before capture mutates it
    const cur = captureState(w, schema, prev);
    const wr = new BitWriter(); encodeDelta(wr, schema, cur, base);
    bytes.push(wr.finish()); prev = cur; w.clearChanges(); return cur;
  };
  cap(); // full snapshot
  w.setField(a, Transform, "x", 5); w.setField(b, Buff, "power", 7); cap(); // changes
  w.remove(b, Buff); cap(); // component removal
  w.destroy(a); cap(); // despawn
  const c = spawn(w, 103, 9); w.setField(c, Transform, "x", 10); cap(); // spawn + move
  return bytes;
}

describe("ADR-376 captureState in-place update", () => {
  it("returns the same map object, updated in place; an idle tick changes nothing", () => {
    const w = makeWorld(); const schema = new NetSchema(w);
    const a = spawn(w, 101, 1); spawn(w, 102, 2); void a;
    const s0 = captureState(w, schema, undefined); w.clearChanges();
    const first = new Map(s0);
    const s1 = captureState(w, schema, s0); w.clearChanges();
    expect(s1).toBe(s0); // same object, not a fresh N-entry Map
    expect(s1.size).toBe(3); // 2 spawned + the environment singleton (netId 1)
    for (const id of [1, 101, 102]) expect(s1.get(id)).toBe(first.get(id));
    const s2 = captureState(w, schema, s1);
    expect(s2).toBe(s0); expect(s2.size).toBe(3);
  });
  it("a first capture with no prev still captures everything, even after clearChanges", () => {
    const w = makeWorld(); const schema = new NetSchema(w);
    spawn(w, 101, 1); spawn(w, 102, 2); spawn(w, 103, 3);
    w.clearChanges(); // no dirty bits set anywhere: must not come back empty
    const s = captureState(w, schema, undefined);
    expect(s.size).toBe(4); // 3 spawned + the environment singleton
    for (const id of [101, 102, 103]) expect(s.get(id)).toBeDefined();
    const ti = schema.indexOf(Transform, w)!;
    const xi = schema.layout[ti]!.findIndex(([f]) => f === "x"); // layout is core's sorted order, not field order
    expect(fromWire(schema.specs[ti]![xi]!, s.get(102)!.get(ti)![xi]!)).toBeCloseTo(2, 5);
  });
  it("entities that leave are dropped and stay dropped; encodeDelta reports the despawns", () => {
    const w = makeWorld(); const schema = new NetSchema(w);
    const a = spawn(w, 101, 1); const b = spawn(w, 102, 2); const c = spawn(w, 103, 3);
    const s0 = captureState(w, schema, undefined); w.clearChanges();
    const base = new Map(s0); // ADR-376: copy before capture mutates it
    w.destroy(b); w.remove(c, NetId); // destroy + NetId removal both leave the replicated set
    const s1 = captureState(w, schema, s0); w.clearChanges();
    expect(s1).toBe(s0);
    expect(s1.size).toBe(2); expect(s1.has(101)).toBe(true); expect(s1.has(1)).toBe(true); // env stays
    expect(s1.has(102)).toBe(false); expect(s1.has(103)).toBe(false);
    const wr = new BitWriter(); const stats = encodeDelta(wr, schema, s1, base);
    expect(stats).toEqual({ spawns: 0, despawns: 2, changes: 0 });
    expect(decodeDelta(new BitReader(wr.finish()), schema, base).despawned.sort()).toEqual([102, 103]);
    // a later idle tick does not resurrect them, and a newcomer joins cleanly
    const d = spawn(w, 104, 4); void d;
    const s2 = captureState(w, schema, s1); w.clearChanges();
    expect(s2.size).toBe(3); expect([...s2.keys()].sort()).toEqual([1, 101, 104]);
    expect(s2.has(102)).toBe(false); expect(s2.has(103)).toBe(false);
    const s3 = captureState(w, schema, s2);
    expect(s3.size).toBe(3); expect(s3.has(102)).toBe(false);
    void a;
  });
  it("leave + same-netId re-add in one tick reflects the new entity, not the stale entry", () => {
    const w = makeWorld(); const schema = new NetSchema(w);
    const a = spawn(w, 107, 1); w.add(a, Buff, { power: 1, kind: 1 });
    const s0 = captureState(w, schema, undefined); w.clearChanges();
    const oldEs = s0.get(107)!;
    w.destroy(a);
    const b = spawn(w, 107, 42); // same netId, new entity, same tick
    const s1 = captureState(w, schema, s0);
    expect(s1.size).toBe(2); // env + the re-added entity
    expect(s1.get(107)).not.toBe(oldEs);
    const ti = schema.indexOf(Transform, w)!;
    const xi = schema.layout[ti]!.findIndex(([f]) => f === "x"); // layout is core's sorted order, not field order
    expect(fromWire(schema.specs[ti]![xi]!, s1.get(107)!.get(ti)![xi]!)).toBeCloseTo(42, 5);
    expect(s1.get(107)!.has(schema.indexOf(Buff, w)!)).toBe(false);
    void b;
  });
  it("mass leave under churn: half of 100 entities go, the survivors keep their states", () => {
    const w = makeWorld(); const schema = new NetSchema(w);
    const ents: Entity[] = [];
    for (let i = 0; i < 100; i++) ents.push(spawn(w, 1000 + i, i));
    const s0 = captureState(w, schema, undefined); w.clearChanges();
    const survivorEs = new Map<number, unknown>();
    for (let i = 0; i < 100; i += 2) survivorEs.set(1000 + i, s0.get(1000 + i));
    for (let i = 1; i < 100; i += 2) w.destroy(ents[i]!);
    const s1 = captureState(w, schema, s0); w.clearChanges();
    expect(s1.size).toBe(51); // 50 survivors + the environment singleton
    for (const [id, es] of survivorEs) { expect(s1.has(id)).toBe(true); expect(s1.get(id)).toBe(es); }
    for (let i = 1; i < 100; i += 2) expect(s1.has(1000 + i)).toBe(false);
    // churn on top: new entities join while others leave, indices get reused
    for (let i = 0; i < 25; i++) spawn(w, 2000 + i, i);
    for (let i = 0; i < 100; i += 4) w.destroy(ents[i]!);
    const s2 = captureState(w, schema, s1);
    expect(s2.size).toBe(51); // env + 25 old survivors + 25 newcomers
    for (let i = 0; i < 25; i++) expect(s2.get(2000 + i)).toBeDefined();
    for (let i = 2; i < 100; i += 4) expect(s2.get(1000 + i)).toBeDefined();
  });
  it("scripted change sequence produces deterministic, decodable delta bytes", () => {
    const runA = scriptedBytes(); const runB = scriptedBytes();
    expect(runA.length).toBe(5); expect(runB.length).toBe(5);
    for (let i = 0; i < runA.length; i++) expect(runA[i]).toEqual(runB[i]);
    // the first delta is the full snapshot; the despawn tick carries exactly one Despawn record
    expect(runA[0]!.length).toBeGreaterThan(runA[1]!.length);
  });
});
