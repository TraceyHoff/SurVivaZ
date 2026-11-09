import { ArrayCtor, fieldDefault, fieldLength, fieldType, isArrayField, schemaFields,
  type Schema, type SchemaInit, type SchemaValues, type TypedArray } from "./schema.js";
import { INDEX_MASK } from "./entity.js";

export interface ComponentDef<S extends Schema = Schema> {
  readonly name: string;
  readonly schema: S;
  readonly networked: boolean;
  /** Saved with its chunk by the chunk codec (world persistence). */
  readonly persistent: boolean;
}
export function defineComponent<S extends Schema>(name: string, schema: S, opts: { networked?: boolean; persistent?: boolean } = {}): ComponentDef<S> {
  for (const k of Object.keys(schema)) { const n = fieldLength(schema[k]!); if (!(Number.isInteger(n) && n >= 1)) throw new Error(`${name}.${k}: bad length`); }
  return { name, schema, networked: opts.networked ?? false, persistent: opts.persistent ?? false };
}

/**
 * Sparse-set SoA store: one typed array per field, sparse index -> dense slot.
 * Array fields of length n use stride n: element i of slot s is at `data[f][s * n + i]`.
 */
export class ComponentStore<S extends Schema = Schema> {
  readonly fields: (keyof S & string)[];
  /** Element count per field (1 for scalars). */
  readonly lengths: Record<string, number>;
  readonly data: { [K in keyof S]: TypedArray };
  readonly sparse: Int32Array;
  dense: Uint32Array; // entity ids
  size = 0;
  /** Per-tick change bitset over entity index (bit set on add / write / markChanged). */
  readonly dirty: Uint32Array;
  /** Entity ids (with generation at removal time) that lost this component this tick; insertion-ordered, deduped. */
  readonly removedThisTick = new Set<number>();
  /** Bumped whenever an entity gains or loses this component (not on field writes): lets derived indexes
   *  (e.g. the ADR-315 claim-zone grid) rebuild exactly when membership changes, without a per-tick scan. */
  membership = 0;
  private cap: number;
  constructor(readonly id: number, readonly def: ComponentDef<S>, maxEntities: number, initialCap = 64) {
    this.fields = schemaFields(def.schema);
    this.lengths = {};
    for (const f of this.fields) this.lengths[f] = fieldLength(def.schema[f]!);
    this.sparse = new Int32Array(maxEntities).fill(-1);
    this.dirty = new Uint32Array((maxEntities + 31) >>> 5);
    this.cap = initialCap;
    this.dense = new Uint32Array(initialCap);
    const d: Record<string, TypedArray> = {};
    for (const f of this.fields) d[f] = new ArrayCtor[fieldType(def.schema[f]!)](initialCap * this.lengths[f]!);
    this.data = d as { [K in keyof S]: TypedArray };
  }
  has(index: number): boolean { return this.sparse[index]! >= 0; }
  slot(index: number): number { return this.sparse[index]!; }
  isArray(field: keyof S & string): boolean { return isArrayField(this.def.schema[field]!); }
  private grow(): void {
    this.cap *= 2;
    const nd = new Uint32Array(this.cap); nd.set(this.dense); this.dense = nd;
    for (const f of this.fields) {
      const old = this.data[f]; const n = new ArrayCtor[fieldType(this.def.schema[f]!)](this.cap * this.lengths[f]!);
      n.set(old as never); (this.data as Record<string, TypedArray>)[f] = n;
    }
  }
  /** Write a value (number or ArrayLike for array fields) into dense slot without marking. */
  writeSlot(slot: number, field: keyof S & string, v: number | ArrayLike<number>): void {
    const n = this.lengths[field]!; const a = this.data[field];
    if (typeof v === "number") { if (n === 1) a[slot] = v; else a.fill(v, slot * n, slot * n + n); }
    else for (let i = 0; i < n; i++) a[slot * n + i] = v[i] ?? 0;
  }
  /** Adds (or re-inits fields of) the component. New components start from schema defaults. */
  add(entity: number, index: number, init?: SchemaInit<S>): number {
    let s = this.sparse[index]!;
    if (s < 0) {
      if (this.size === this.cap) this.grow();
      s = this.size++;
      this.sparse[index] = s; this.dense[s] = entity; this.membership++;
      for (const f of this.fields) this.writeSlot(s, f, fieldDefault(this.def.schema[f]!));
    }
    this.markChanged(index);
    if (init) for (const f of this.fields) { const v = init[f]; if (v !== undefined) this.writeSlot(s, f, v as number | ArrayLike<number>); }
    return s;
  }
  // Dirty word range [dirtyLo, dirtyHi) (ADR-105): clearChanged / changedIndices touch only words that can be set,
  // instead of the whole maxEntities/32 bitset of every store in every world every tick.
  private dirtyLo = 0x7fffffff; private dirtyHi = 0;
  markChanged(index: number): void {
    const w = index >>> 5; this.dirty[w] = this.dirty[w]! | (1 << (index & 31));
    if (w < this.dirtyLo) this.dirtyLo = w; if (w >= this.dirtyHi) this.dirtyHi = w + 1;
  }
  isChanged(index: number): boolean { return (this.dirty[index >>> 5]! & (1 << (index & 31))) !== 0; }
  clearChanged(): void {
    if (this.dirtyHi > this.dirtyLo) this.dirty.fill(0, this.dirtyLo, this.dirtyHi);
    this.dirtyLo = 0x7fffffff; this.dirtyHi = 0;
    if (this.removedThisTick.size) this.removedThisTick.clear();
  }
  /** Entity indices whose bit is set and still have this component, ascending. */
  *changedIndices(): IterableIterator<number> {
    const d = this.dirty;
    for (let w = this.dirtyLo, end = Math.min(this.dirtyHi, d.length); w < end; w++) {
      let bits = d[w]!;
      while (bits !== 0) {
        const b = 31 - Math.clz32(bits & -bits); bits &= bits - 1;
        const i = (w << 5) | b; if (this.sparse[i]! >= 0) yield i;
      }
    }
  }
  /** Read a scalar field (or element 0 of an array field) by entity index. */
  read(index: number, field: keyof S & string): number | undefined {
    const s = this.sparse[index]!; return s < 0 ? undefined : this.data[field][s * this.lengths[field]!];
  }
  /** Write a scalar field by entity index; marks changed. Returns false if absent. */
  write(index: number, field: keyof S & string, value: number): boolean {
    const s = this.sparse[index]!; if (s < 0) return false;
    this.data[field][s * this.lengths[field]!] = value; this.markChanged(index); return true;
  }
  /** Live subarray view of an array field (writes through; call markChanged after mutating). */
  array(index: number, field: keyof S & string): TypedArray | undefined {
    const s = this.sparse[index]!; if (s < 0) return undefined; const n = this.lengths[field]!;
    return this.data[field].subarray(s * n, s * n + n);
  }
  readElement(index: number, field: keyof S & string, i: number): number | undefined {
    const s = this.sparse[index]!; const n = this.lengths[field]!;
    if (s < 0 || i < 0 || i >= n) return undefined; return this.data[field][s * n + i];
  }
  writeElement(index: number, field: keyof S & string, i: number, value: number): boolean {
    const s = this.sparse[index]!; const n = this.lengths[field]!;
    if (s < 0) return false; if (i < 0 || i >= n) throw new RangeError(`${this.def.name}.${field}[${i}] out of range`);
    this.data[field][s * n + i] = value; this.markChanged(index); return true;
  }
  remove(index: number): void {
    const s = this.sparse[index]!; if (s < 0) return;
    this.removedThisTick.add(this.dense[s]!); this.membership++;
    const last = --this.size;
    if (s !== last) {
      const moved = this.dense[last]!;
      this.dense[s] = moved;
      for (const f of this.fields) {
        const n = this.lengths[f]!; const a = this.data[f];
        if (n === 1) a[s] = a[last]!; else a.copyWithin(s * n, last * n, last * n + n);
      }
      this.sparse[moved & INDEX_MASK] = s;
    }
    this.sparse[index] = -1;
  }
  /** Fill `out` with the scalar fields (array fields are skipped); false if absent. Allocation-free get() for hot loops. */
  readInto(index: number, out: Record<string, number>): boolean {
    const s = this.sparse[index]!; if (s < 0) return false;
    for (const f of this.fields) if (!this.isArray(f)) out[f] = this.data[f][s]!;
    return true;
  }
  /** Copy of the component (arrays copied to number[]). */
  get(index: number): SchemaValues<S> | undefined {
    const s = this.sparse[index]!; if (s < 0) return undefined;
    const o = {} as Record<string, number | number[]>;
    for (const f of this.fields) {
      const n = this.lengths[f]!;
      o[f] = this.isArray(f) ? Array.from(this.data[f].subarray(s * n, s * n + n)) : this.data[f][s]!;
    }
    return o as SchemaValues<S>;
  }
}
