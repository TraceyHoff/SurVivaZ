import { fieldLength, fieldType, schemaHash, type ComponentStore, type FieldType, type Schema, type World } from "@engine/core";
import { CHUNK_AREA } from "@engine/world";

/**
 * Schema migration "fields added since": a save written before `fields` existed on component `component` (by
 * name) carries the schema hash of the current schema minus those fields. Persist then decodes it with that old
 * layout and fills the added fields with 0 (every element). Field order is the schema's key order, so added
 * fields may sit anywhere; the rest must keep their order and types.
 */
export interface AddedFields {
  component: string; fields: readonly string[];
  /** Array fields that were NARROWER in the old layout: name -> old element count (ADR-098). Old elements are copied
   *  in order and the tail is zero-filled. May be combined with `fields` (a save that predates both). */
  grown?: Readonly<Record<string, number>>;
  /** Scalar fields whose DEFAULT changed since the old layout: name -> old default. The schema hash includes
   *  defaults, so a migration that also changed a default must name the old one or it never matches a real save. */
  oldDefaults?: Readonly<Record<string, number>>;
}
/** core Slot.crafterId on gameplay's slot containers (4b8b28d): 0 = no crafter. */
export const CRAFTER_ID_MIGRATIONS: readonly AddedFields[] = [
  { component: "Inventory", fields: ["crafterId"] },
  { component: "Container", fields: ["crafterId"] },
];
/** core Appearance.version (a287243): saves from 81cdf46 lack it; 0 = first version. (Such saves also predate skinScheme.) */
export const APPEARANCE_VERSION_MIGRATION: AddedFields = { component: "Appearance", fields: ["version", "skinScheme"] };
/** ADR-098: Container arrays grew 24 -> 96 slots (slotCount stays per-instance). Old rows zero-pad the tail. */
const C24 = { items: 24, counts: 24, createdTick: 24, durability: 24, crafterId: 24 } as const;
export const CONTAINER_96_MIGRATIONS: readonly AddedFields[] = [
  { component: "Container", fields: [], grown: C24 },
  { component: "Container", fields: ["crafterId"], grown: C24 },
];
/** Player Inventory grew 16 -> 24 slots (16 pack + 8 hotbar, hotbar stored after the pack). Old rows zero-pad the
 * tail, so every old item lands in the pack and the hotbar starts empty — the player re-assigns it. */
const I16 = { items: 16, counts: 16, createdTick: 16, durability: 16, crafterId: 16 } as const;
/** slotCount's default moved with INVENTORY_SLOTS (16 -> 24), so the old hash carries default 16. */
export const INVENTORY_24_MIGRATIONS: readonly AddedFields[] = [
  { component: "Inventory", fields: [], grown: I16, oldDefaults: { slotCount: 16 } },
  { component: "Inventory", fields: ["crafterId"], grown: I16, oldDefaults: { slotCount: 16 } },
];
/** ADR-137: Appearance gained the "hands" wear slot (WEARABLE_SLOTS 8 -> 9). Old rows zero-pad it (no hands part, palette 0). */
const A8 = { parts: 8, primary: 8, secondary: 8 } as const;
export const APPEARANCE_HANDS_MIGRATIONS: readonly AddedFields[] = [
  { component: "Appearance", fields: ["skinScheme"], grown: A8 },
  { component: "Appearance", fields: ["version", "skinScheme"], grown: A8 },
];
/**
 * ADR-245: Appearance gained skinScheme (skin palette of skinTone). Every row saved before it zero-fills to 0 = the
 * legacy 12-tone palette; core migrateSkinTone remaps it on load (persistence: chunk decode + restorePlayer).
 */
export const APPEARANCE_SKIN_SCHEME_MIGRATION: AddedFields = { component: "Appearance", fields: ["skinScheme"] };
/** ADR-209: Progression gained per-tree xp / level / points (tver 0 = legacy global pool; gameplay converts it on load). */
export const PROGRESSION_TREES_MIGRATION: AddedFields = { component: "Progression", fields: ["tver", "txp", "tlevel", "tpoints"] };
/** ADR-238: LootBag gained spawnTick / kind / emptiedTick (0 = legacy: spawn derived from despawnAtTick, label inferred). */
export const LOOTBAG_DESPAWN_MIGRATION: AddedFields = { component: "LootBag", fields: ["spawnTick", "kind", "emptiedTick"] };
/** Task 22: WorldRules gained aiHumans (0 = legacy: AI humans on, the default). */
export const WORLD_RULES_AI_HUMANS_MIGRATION: AddedFields = { component: "WorldRules", fields: ["aiHumans"] };
/** Task 31: Diseases gained careTicks (0 = legacy: no care-cure progress yet). */
export const DISEASES_CARE_TICKS_MIGRATION: AddedFields = { component: "Diseases", fields: ["careTicks"] };
/** ADR-280: infection clock rate; zero-filled legacy values are interpreted as the standard 20Hz. */
export const DISEASES_INFECTION_CLOCK_MIGRATIONS: readonly AddedFields[] = [
  { component: "Diseases", fields: ["infectionHz"] },
  { component: "Diseases", fields: ["careTicks", "infectionHz"] },
];
/** ADR-287: finite fertilizer timer; legacy fertilized flags receive one dose in gameplay. */
export const CROP_FERTILIZER_MIGRATION: AddedFields = { component: "Crop", fields: ["fertilizerUntilTick"] };
export const DEFAULT_MIGRATIONS: readonly AddedFields[] = [...CRAFTER_ID_MIGRATIONS, APPEARANCE_VERSION_MIGRATION, ...CONTAINER_96_MIGRATIONS, ...INVENTORY_24_MIGRATIONS, ...APPEARANCE_HANDS_MIGRATIONS, APPEARANCE_SKIN_SCHEME_MIGRATION, PROGRESSION_TREES_MIGRATION, LOOTBAG_DESPAWN_MIGRATION, WORLD_RULES_AI_HUMANS_MIGRATION, DISEASES_CARE_TICKS_MIGRATION, ...DISEASES_INFECTION_CLOCK_MIGRATIONS, CROP_FERTILIZER_MIGRATION];

const BYTES: Record<FieldType, number> = { f32: 4, f64: 8, i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4 };
export const oldSchemaOf = (s: Schema, added: readonly string[], grown: Readonly<Record<string, number>> = {}, oldDefaults: Readonly<Record<string, number>> = {}): Schema =>
  Object.fromEntries(Object.entries(s).filter(([k]) => !added.includes(k)).map(([k, v]) => {
    let out = k in grown && typeof v === "object" ? { ...v, length: grown[k]! } : v;
    if (k in oldDefaults) out = typeof out === "string" ? { type: out, default: oldDefaults[k]! } : { ...out, default: oldDefaults[k]! };
    return [k, out];
  })) as Schema;
/** Per field of the CURRENT schema: byte size now, byte size in the old record (0 = added), and whether it is added. */
export interface FieldPlan { fields: { bytes: number; oldBytes: number; added: boolean }[]; oldSize: number; newSize: number }
/** The migration that explains stored hash `h` for `store`, if any. */
export function planFor(store: ComponentStore, h: number, migrations: readonly AddedFields[]): FieldPlan | undefined {
  for (const m of migrations) {
    const grown = m.grown ?? {}; const gk = Object.keys(grown);
    if (m.component !== store.def.name) continue;
    if (!m.fields.some((f) => f in store.def.schema) && !gk.some((f) => f in store.def.schema)) continue;
    if (gk.some((f) => !(f in store.def.schema) || fieldLength(store.def.schema[f]!) < grown[f]!)) continue;
    if (schemaHash(oldSchemaOf(store.def.schema, m.fields, grown, m.oldDefaults ?? {})) !== h) continue;
    const fields = store.fields.map((f) => {
      const spec = store.def.schema[f]!; const added = m.fields.includes(f); const el = BYTES[fieldType(spec)];
      return { bytes: el * fieldLength(spec), oldBytes: added ? 0 : el * (grown[f] ?? fieldLength(spec)), added };
    });
    let oldSize = 0, newSize = 0; for (const f of fields) { newSize += f.bytes; oldSize += f.oldBytes; }
    return { fields, oldSize, newSize };
  }
  return undefined;
}
/** Old-layout record bytes -> current-layout bytes (added fields and grown array tails zero). */
export function upgradeRecord(plan: FieldPlan, src: Uint8Array, at: number, out: Uint8Array, to: number): void {
  let i = at, o = to;
  for (const f of plan.fields) {
    if (f.oldBytes) out.set(src.subarray(i, i + f.oldBytes), o);
    out.fill(0, o + f.oldBytes, o + f.bytes); i += f.oldBytes; o += f.bytes;
  }
}

/**
 * Rewrites a chunk row (world chunk format v1) whose component table has hashes explained by `migrations` into the
 * current layout so world's decodeChunk accepts it. Returns undefined when nothing needs migrating (or the row is
 * not understood: decodeChunk then reports the real error). Pure byte rewrite; world/core are untouched.
 */
export function migrateChunkBytes(world: World, bytes: Uint8Array, migrations: readonly AddedFields[] = DEFAULT_MIGRATIONS): Uint8Array | undefined {
  if (!migrations.length || bytes.length < 16) return undefined;
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    let o = 14; const runs = d.getUint16(o, true); o += 2 + runs * 4 + CHUNK_AREA;
    const nb = d.getUint16(o, true); o += 2 + nb * 10;
    const tableAt = o; const nc = d.getUint8(o); o += 1;
    const sizes: number[] = []; const plans: (FieldPlan | undefined)[] = []; let any = false;
    for (let k = 0; k < nc; k++) {
      const id = d.getUint16(o, true), h = d.getUint32(o + 2, true); o += 6;
      const st = world.storeById(id); if (!st) return undefined;
      const plan = schemaHash(st.def.schema) === h ? undefined : planFor(st, h, migrations);
      if (!plan && schemaHash(st.def.schema) !== h) return undefined;
      plans.push(plan); if (plan) any = true;
      sizes.push(plan ? plan.oldSize : st.fields.reduce((n, f) => n + BYTES[fieldType(st.def.schema[f]!)] * fieldLength(st.def.schema[f]!), 0));
    }
    if (!any) return undefined;
    // Pass 1: size of the rewritten entity section.
    const entAt = o; const ne = d.getUint32(o, true); o += 4; let grow = 0;
    for (let k = 0; k < ne; k++) {
      const cc = d.getUint8(o); o += 1;
      for (let c = 0; c < cc; c++) { const t = d.getUint8(o); o += 1; const p = plans[t]; if (sizes[t] === undefined) return undefined; o += sizes[t]!; if (p) grow += p.newSize - p.oldSize; }
    }
    if (o !== bytes.length) return undefined;
    const out = new Uint8Array(bytes.length + grow); out.set(bytes.subarray(0, entAt));
    const od = new DataView(out.buffer);
    for (let k = 0; k < nc; k++) { const p = plans[k]; if (p) { const id = d.getUint16(tableAt + 1 + k * 6, true); od.setUint32(tableAt + 1 + k * 6 + 2, schemaHash(world.storeById(id)!.def.schema), true); } }
    // Pass 2: copy entities, widening migrated records.
    let i = entAt + 4, w = entAt + 4; od.setUint32(entAt, ne, true);
    for (let k = 0; k < ne; k++) {
      const cc = d.getUint8(i); out[w++] = cc; i++;
      for (let c = 0; c < cc; c++) {
        const t = d.getUint8(i); out[w++] = t; i++; const p = plans[t];
        if (p) { upgradeRecord(p, bytes, i, out, w); i += p.oldSize; w += p.newSize; }
        else { out.set(bytes.subarray(i, i + sizes[t]!), w); i += sizes[t]!; w += sizes[t]!; }
      }
    }
    return out;
  } catch { return undefined; }
}
