import { describe, expect, it } from "vitest";
import { NetId, Transform, World } from "@engine/core";
import { BitReader, BitWriter, NetSchema, captureState, decodeDelta, encodeDelta, fromWire, type WorldState } from "../src/index.js";
import { Buff, makeWorld } from "./fixture.js";

function roundtrip(schema: NetSchema, cur: WorldState, base: WorldState | undefined, clientBase = base) {
  const w = new BitWriter(); const stats = encodeDelta(w, schema, cur, base);
  const bytes = w.finish(); const d = decodeDelta(new BitReader(bytes), schema, clientBase);
  return { bytes, stats, d };
}
function spawn(w: World, id: number, x: number) {
  const e = w.create(); w.add(e, NetId, { id }).add(e, Transform, { x, y: 1 }); return e;
}

describe("delta codec", () => {
  it("full snapshot then field-masked delta reproduces server state exactly", () => {
    const w = makeWorld(); const schema = new NetSchema(w);
    const a = spawn(w, 1, 1.5); spawn(w, 2, 3);
    const s0 = captureState(w, schema, undefined); w.clearChanges();
    const full = roundtrip(schema, s0, undefined);
    expect(full.stats.spawns).toBe(2); expect(full.d.state).toEqual(s0);

    w.setField(a, Transform, "x", 2.25);
    // ADR-376: captureState mutates `prev` in place, so the base for the delta is a copy taken before this capture.
    const s0base = new Map(s0);
    const s1 = captureState(w, schema, s0);
    expect(s1.get(2)).toBe(s0base.get(2)); // unchanged entity reuses previous state object
    const delta = roundtrip(schema, s1, s0base);
    expect(delta.stats).toEqual({ spawns: 0, despawns: 0, changes: 1 });
    expect(delta.d.state).toEqual(s1);
    expect(delta.bytes.length).toBeLessThan(full.bytes.length / 2);
    expect(delta.d.changed.get(1)).toEqual({ changed: [schema.indexOf(Transform, w)], removed: [] });
  });
  it("encodes despawns and component add/remove; removal before re-add in same tick is a change", () => {
    const w = makeWorld(); const schema = new NetSchema(w);
    const a = spawn(w, 1, 0); const b = spawn(w, 2, 0);
    w.add(a, Buff, { power: 5, kind: 2 });
    const s0 = captureState(w, schema, undefined); w.clearChanges();
    w.remove(a, Buff); w.destroy(b);
    const s0base = new Map(s0); // ADR-376: captureState mutates `prev` in place
    const s1 = captureState(w, schema, s0); w.clearChanges();
    const d1 = roundtrip(schema, s1, s0base);
    const bi = schema.indexOf(Buff, w)!;
    expect(d1.stats.despawns).toBe(1); expect(d1.d.despawned).toEqual([2]);
    expect(d1.d.changed.get(1)).toEqual({ changed: [], removed: [bi] });
    expect(d1.d.state.get(1)!.has(bi)).toBe(false);
    // remove + re-add in one tick with a new value: no entity dirty-miss, arrives as a field change
    w.add(a, Buff, { power: 5, kind: 2 }); const s2 = captureState(w, schema, s1); w.clearChanges();
    w.remove(a, Buff); w.add(a, Buff, { power: 7, kind: 2 });
    const s2base = new Map(s2); // ADR-376: captureState mutates `prev` in place
    const s3 = captureState(w, schema, s2);
    expect(roundtrip(schema, s3, s2base).d.state).toEqual(s3);
  });
  it("detects removal on an otherwise untouched entity via world.removed", () => {
    const w = makeWorld(); const schema = new NetSchema(w);
    const a = spawn(w, 1, 0); w.add(a, Buff, { power: 1, kind: 1 });
    const s0 = captureState(w, schema, undefined); w.clearChanges();
    w.remove(a, Buff);
    const before = s0.get(1); // ADR-376: EntityState objects are still immutable; only the outer map is mutated
    const s1 = captureState(w, schema, s0);
    expect(s1.get(1)).not.toBe(before);
    expect(s1.get(1)!.has(schema.indexOf(Buff, w)!)).toBe(false);
  });
  it("quantized fields use their bit width and stay within one step", () => {
    const w = makeWorld(); const schema = new NetSchema(w);
    const a = spawn(w, 1, 0); w.add(a, Buff, { power: 3.14159, kind: 0 });
    const s = captureState(w, schema, undefined);
    const bi = schema.indexOf(Buff, w)!; const pi = w.store(Buff).fields.indexOf("power");
    const back = fromWire(schema.specs[bi]![pi]!, s.get(1)!.get(bi)![pi]!);
    expect(Math.abs(back - 3.14159)).toBeLessThanOrEqual(10 / 1023);
    expect(w.getField(a, Buff, "power")).toBeCloseTo(3.14159, 5); // sim keeps full precision
  });
  it("rejects a delta that references an unknown baseline entity", () => {
    const w = makeWorld(); const schema = new NetSchema(w); const a = spawn(w, 1, 0);
    const s0 = captureState(w, schema, undefined); w.clearChanges();
    w.setField(a, Transform, "x", 9); const s0base = new Map(s0); // ADR-376: captureState mutates `prev` in place
    const s1 = captureState(w, schema, s0);
    expect(() => roundtrip(schema, s1, s0base, new Map())).toThrow(/unknown netId/);
  });
});
