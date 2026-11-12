import { dequantize, entityIndex, fieldQuant, fieldType, NetId, quantize, type ComponentDef, type ComponentStore, type FieldSpec, type World } from "@engine/core";
import { BitWriter, type BitReader } from "./bits.js";

/** Wire values (quantized ints / f32-rounded floats) of one component: fields in core's sorted order, array fields expanded per element. */
export type CompValues = readonly number[];
/** Replicated state of one entity: schema component index -> wire values. Immutable once built (shared by reference). */
export type EntityState = ReadonlyMap<number, CompValues>;
/** Replicated world state: netId -> entity state. */
export type WorldState = ReadonlyMap<number, EntityState>;

/** Element count of a field; works with and without core array fields. */
export function storeFieldLength(st: ComponentStore, f: string): number {
  return (st as unknown as { lengths?: Record<string, number> }).lengths?.[f] ?? 1;
}

/** Replicated component list shared by client and server: networked stores except NetId, ascending id. */
export class NetSchema {
  readonly stores: ComponentStore[];
  /** Per component: one spec per wire element (array fields repeated). */
  readonly specs: FieldSpec[][];
  /** Per component: [field, element] per wire element. */
  readonly layout: [string, number][][];
  private readonly indexById = new Map<number, number>();
  constructor(world: World) {
    const netIdStore = world.store(NetId) as unknown as ComponentStore;
    this.stores = world.componentStores.filter((s) => s.def.networked && s !== netIdStore);
    this.layout = this.stores.map((s) => s.fields.flatMap((f) => Array.from({ length: storeFieldLength(s, f) }, (_, i) => [f, i] as [string, number])));
    this.specs = this.stores.map((s, ci) => this.layout[ci]!.map(([f]) => s.def.schema[f]!));
    this.stores.forEach((s, i) => this.indexById.set(s.id, i));
  }
  get count(): number { return this.stores.length; }
  indexOf(def: ComponentDef, world: World): number | undefined { return this.indexById.get(world.componentId(def)); }
}

export function toWire(spec: FieldSpec, v: number): number {
  const q = fieldQuant(spec);
  if (q) return quantize(v, q);
  return fieldType(spec) === "f32" ? Math.fround(v) : v;
}
export function fromWire(spec: FieldSpec, v: number): number { const q = fieldQuant(spec); return q ? dequantize(v, q) : v; }
export function writeWire(w: BitWriter, spec: FieldSpec, v: number): void { const q = fieldQuant(spec); if (q) w.writeBits(v, q.bits); else w.write(fieldType(spec), v); }
export function readWire(r: BitReader, spec: FieldSpec): number { const q = fieldQuant(spec); return q ? r.readBits(q.bits) : r.read(fieldType(spec)); }

/** Read one component's wire values from a dense slot. */
export function readComp(schema: NetSchema, ci: number, slot: number): number[] {
  const st = schema.stores[ci]!; const specs = schema.specs[ci]!;
  const lay = schema.layout[ci]!; const out = new Array<number>(lay.length);
  for (let i = 0; i < lay.length; i++) { const [f, e] = lay[i]!; out[i] = toWire(specs[i]!, st.data[f]![slot * storeFieldLength(st, f) + e]!); }
  return out;
}

/**
 * Server: capture replicated state of every entity that has a NetId. Entities with no change bit
 * and no removal this tick reuse the previous tick's (immutable) EntityState, so cost scales with churn.
 * `exclude` = component indices never put on the wire (scope "none"). Must run in the network phase.
 */
export function captureState(world: World, schema: NetSchema, prev: WorldState | undefined, exclude?: ReadonlySet<number>): Map<number, EntityState> {
  const ns = world.store(NetId);
  const touched = new Set<number>();
  for (const st of schema.stores) for (const e of world.removed(st.def)) touched.add(entityIndex(e));
  // ADR-369: dirty entity indices from the stores' own change iterators (O(changed), not O(entities x stores)).
  // changedIndices() yields an index only while the component is still present; removals are covered by `touched`
  // and NetId adds by the NetId store below, so an index in neither set provably has no replicated change.
  const dirty = new Set<number>();
  for (const st of schema.stores) for (const i of st.changedIndices()) dirty.add(i);
  for (const i of ns.changedIndices()) dirty.add(i);
  const out = new Map<number, EntityState>();
  for (let k = 0; k < ns.size; k++) {
    const index = entityIndex(ns.dense[k]!); const netId = ns.data.id[k]!;
    const old = prev?.get(netId);
    const stores = schema.stores; const isTouched = touched.has(index);
    if (old && !isTouched && !dirty.has(index)) { out.set(netId, old); continue; }
    const es = new Map<number, CompValues>(); let same = !!old;
    for (let ci = 0; ci < stores.length; ci++) {
      const st = stores[ci]!;
      if (exclude?.has(ci) || !st.has(index)) { if (same && old!.has(ci)) same = false; continue; }
      const prevV = old?.get(ci);
      let v: CompValues;
      if (prevV && !isTouched && !st.isChanged(index)) v = prevV; // structural sharing of untouched components
      else {
        v = readComp(schema, ci, st.slot(index));
        if (prevV && prevV.length === v.length) { let eq = true; for (let i = 0; i < v.length; i++) if (v[i] !== prevV[i]) { eq = false; break; } if (eq) v = prevV; }
      }
      if (v !== prevV) same = false;
      es.set(ci, v);
    }
    out.set(netId, same && old!.size === es.size ? old! : es);
  }
  return out;
}
/** Structural equality, so an entity whose dirty bit was set without a real change keeps its old object. */
export function sameState(a: EntityState | undefined, b: EntityState): boolean {
  if (!a || a.size !== b.size) return false;
  for (const [ci, v] of b) { const o = a.get(ci); if (!o || o.length !== v.length || v.some((x, i) => x !== o[i])) return false; }
  return true;
}

export const RecordKind = { End: 0, Spawn: 1, Despawn: 2, Change: 3 } as const;

/**
 * Snapshot body = sequence of records, each `kind:2 bits` then payload, terminated by End:
 *   Spawn   varuint netId, compMask[nComp], per present comp: compBody
 *           compBody = comps with > 8 elements: bit sparse ? (varuint k, k x (varuint gap, value)) of the non-zero
 *           elements (others decode as 0) : all elements; comps with <= 8 elements: all elements (protocol v8)
 *   Despawn varuint netId
 *   Change  varuint netId, changedMask[nComp], removedMask[nComp],
 *           per changed comp: bit full ? all elements : elementMask + changed elements
 * Records are independent, so the server can drop any of them (bandwidth budget) by truncating the writer.
 */
export function writeDespawn(w: BitWriter, netId: number): void { w.writeBits(RecordKind.Despawn, 2); w.writeVarUint(netId); }
/** Writes a Spawn (old undefined) or Change record. Returns false (and writes nothing) if there is no difference. */
export function writeEntityRecord(w: BitWriter, schema: NetSchema, netId: number, es: EntityState, old: EntityState | undefined): boolean {
  const n = schema.count;
  if (!old) {
    w.writeBits(RecordKind.Spawn, 2); w.writeVarUint(netId);
    for (let ci = 0; ci < n; ci++) w.writeBool(es.has(ci));
    for (let ci = 0; ci < n; ci++) { const v = es.get(ci); if (v) writeSpawnComp(w, schema.specs[ci]!, v); }
    return true;
  }
  if (old === es) return false;
  const changed: number[] = []; const removed: number[] = [];
  for (let ci = 0; ci < n; ci++) {
    const a = old.get(ci); const b = es.get(ci);
    if (a && !b) removed.push(ci);
    else if (b && (!a || b.some((v, i) => v !== a[i]))) changed.push(ci);
  }
  if (!changed.length && !removed.length) return false;
  w.writeBits(RecordKind.Change, 2); w.writeVarUint(netId);
  // ADR-369: changed/removed are built in ascending ci order, so one linear merge writes both masks
  // (was changed.includes(ci) per component: O(n^2) per record). Same bits on the wire.
  let cp = 0; for (let ci = 0; ci < n; ci++) { if (cp < changed.length && changed[cp] === ci) { w.writeBool(true); cp++; } else w.writeBool(false); }
  let rp = 0; for (let ci = 0; ci < n; ci++) { if (rp < removed.length && removed[rp] === ci) { w.writeBool(true); rp++; } else w.writeBool(false); }
  for (const ci of changed) {
    const v = es.get(ci)!; const a = old.get(ci); const specs = schema.specs[ci]!;
    w.writeBool(!a);
    if (!a) { specs.forEach((s, i) => writeWire(w, s, v[i]!)); continue; }
    // element mask, or (wide components, few changes) a sparse list of delta-coded indices: whichever is smaller
    const idx: number[] = []; for (let i = 0; i < specs.length; i++) if (v[i] !== a[i]) idx.push(i);
    let sparseBits = 0, p = -1; for (const i of idx) { sparseBits += varBits(i - p - 1); p = i; } sparseBits += varBits(idx.length);
    const sparse = specs.length > 8 && sparseBits < specs.length;
    if (specs.length > 8) w.writeBool(sparse);
    if (sparse) { w.writeVarUint(idx.length); let q = -1; for (const i of idx) { w.writeVarUint(i - q - 1); q = i; } }
    else for (let i = 0; i < specs.length; i++) w.writeBool(v[i] !== a[i]);
    for (const i of idx) writeWire(w, specs[i]!, v[i]!);
  }
  return true;
}
/** Spawn body of one component: dense, or (wide components, mostly zero) a zero-run/sparse list, whichever is smaller. */
function writeSpawnComp(w: BitWriter, specs: readonly FieldSpec[], v: CompValues): void {
  if (specs.length <= 8) { specs.forEach((s, i) => writeWire(w, s, v[i]!)); return; }
  const nz: number[] = []; for (let i = 0; i < specs.length; i++) if (!Object.is(v[i], 0)) nz.push(i);
  const sp = new BitWriter(); sp.writeVarUint(nz.length); let q = -1; for (const i of nz) { sp.writeVarUint(i - q - 1); q = i; writeWire(sp, specs[i]!, v[i]!); }
  const dn = new BitWriter(); specs.forEach((s, i) => writeWire(dn, s, v[i]!));
  const sparse = sp.bitLength < dn.bitLength; const src = (sparse ? sp : dn).snapshotBits();
  w.writeBool(sparse); w.appendBits(src.bytes, src.bits);
}
function readSpawnComp(r: BitReader, specs: readonly FieldSpec[]): number[] {
  if (specs.length <= 8 || !r.readBool()) return specs.map((s) => readWire(r, s));
  const v = new Array<number>(specs.length).fill(0); const k = r.readVarUint(); let q = -1;
  for (let j = 0; j < k; j++) { q += r.readVarUint() + 1; if (q >= specs.length) throw new Error("sparse index out of range"); v[q] = readWire(r, specs[q]!); }
  return v;
}
export function writeEnd(w: BitWriter): void { w.writeBits(RecordKind.End, 2); }

export interface DeltaStats { spawns: number; despawns: number; changes: number }
/** Unbudgeted delta of `cur` against `base` (undefined = full). */
export function encodeDelta(w: BitWriter, schema: NetSchema, cur: WorldState, base: WorldState | undefined): DeltaStats {
  const st: DeltaStats = { spawns: 0, despawns: 0, changes: 0 };
  if (base) for (const netId of base.keys()) if (!cur.has(netId)) { writeDespawn(w, netId); st.despawns++; }
  cur.forEach((es, netId) => {
    const old = base?.get(netId);
    if (writeEntityRecord(w, schema, netId, es, old)) { if (old) st.changes++; else st.spawns++; }
  });
  writeEnd(w);
  return st;
}

export interface DecodedDelta {
  state: Map<number, EntityState>;
  spawned: number[];
  despawned: number[];
  changed: Map<number, { changed: number[]; removed: number[] }>;
}
/** ADR-212: Map copy via forEach (the iterable constructor allocates a [k, v] array per entry). */
function copyMap<K, V>(m: ReadonlyMap<K, V> | undefined): Map<K, V> { const o = new Map<K, V>(); if (m) m.forEach((v, k) => { o.set(k, v); }); return o; }
export function decodeDelta(r: BitReader, schema: NetSchema, base: WorldState | undefined): DecodedDelta {
  const n = schema.count;
  const state = copyMap<number, EntityState>(base);
  const spawned: number[] = []; const despawned: number[] = [];
  const changed = new Map<number, { changed: number[]; removed: number[] }>();
  const readAll = (ci: number): number[] => schema.specs[ci]!.map((s) => readWire(r, s));
  for (;;) {
    const kind = r.readBits(2);
    if (kind === RecordKind.End) break;
    const netId = r.readVarUint();
    if (kind === RecordKind.Despawn) { state.delete(netId); despawned.push(netId); continue; }
    if (kind === RecordKind.Spawn) {
      const present: number[] = [];
      for (let ci = 0; ci < n; ci++) if (r.readBool()) present.push(ci);
      const es = new Map<number, CompValues>(); for (const ci of present) es.set(ci, readSpawnComp(r, schema.specs[ci]!));
      state.set(netId, es); spawned.push(netId); continue;
    }
    const ch: number[] = []; const rm: number[] = [];
    for (let ci = 0; ci < n; ci++) if (r.readBool()) ch.push(ci);
    for (let ci = 0; ci < n; ci++) if (r.readBool()) rm.push(ci);
    const old = state.get(netId);
    if (!old) throw new Error(`delta references unknown netId ${netId}`);
    const es = copyMap(old);
    for (const ci of rm) es.delete(ci);
    for (const ci of ch) {
      if (r.readBool()) { es.set(ci, readAll(ci)); continue; }
      const prev = old.get(ci); if (!prev) throw new Error(`field delta for absent component ${ci}`);
      const specs = schema.specs[ci]!; let mask: boolean[];
      if (specs.length > 8 && r.readBool()) {
        mask = specs.map(() => false); const k = r.readVarUint(); let q = -1;
        for (let j = 0; j < k; j++) { q += r.readVarUint() + 1; if (q >= specs.length) throw new Error("sparse index out of range"); mask[q] = true; }
      } else mask = specs.map(() => r.readBool());
      const v = [...prev]; mask.forEach((m, i) => { if (m) v[i] = readWire(r, specs[i]!); });
      es.set(ci, v);
    }
    state.set(netId, es); changed.set(netId, { changed: ch, removed: rm });
  }
  return { state, spawned, despawned, changed };
}

/** Bits a writeVarUint(v) takes (7-bit groups + continuation bit). */
function varBits(v: number): number { let n = 8; while (v >= 128) { v = Math.floor(v / 128); n += 8; } return n; }
