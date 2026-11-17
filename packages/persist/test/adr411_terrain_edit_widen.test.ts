// ADR-411: TerrainEdit.dig widened i8 -> i16 — old saves migrate (sign-extended) instead of failing to decode.
import { describe, expect, it } from "vitest";
import { schemaHash, Transform, World } from "@engine/core";
import { CHUNK_MAGIC, Chunk, decodeChunk, encodeChunk } from "@engine/world";
import { TerrainEdit } from "@engine/gameplay";
import { DEFAULT_MIGRATIONS, migrateChunkBytes, oldSchemaOf, planFor, upgradeRecord } from "../src/migrate.js";

function worldWithTerrainEdit(): World {
  const w = new World({ seed: 42, maxEntities: 1 << 14 });
  w.register(TerrainEdit); // Transform is a builtin; TerrainEdit is the only gameplay component this needs
  return w;
}

describe("ADR-411 TerrainEdit dig i8 -> i16 migration", () => {
  it("planFor finds the widened-field migration and upgradeRecord sign-extends", () => {
    const w = worldWithTerrainEdit();
    const oldHash = schemaHash(oldSchemaOf(TerrainEdit.schema, [], {}, {}, { dig: "i8" }));
    expect(oldHash).not.toBe(schemaHash(TerrainEdit.schema));
    const plan = planFor(w.store(TerrainEdit), oldHash, DEFAULT_MIGRATIONS);
    expect(plan).toBeDefined();
    expect(plan!.oldSize).toBe(1); expect(plan!.newSize).toBe(2);
    const neg = new Uint8Array(2); upgradeRecord(plan!, new Uint8Array([0xfb]), 0, neg, 0); // -5 as i8
    expect(new DataView(neg.buffer).getInt16(0, true)).toBe(-5);
    const pos = new Uint8Array(2); upgradeRecord(plan!, new Uint8Array([70]), 0, pos, 0);
    expect(new DataView(pos.buffer).getInt16(0, true)).toBe(70);
    const min = new Uint8Array(2); upgradeRecord(plan!, new Uint8Array([0x80]), 0, min, 0); // -128 as i8
    expect(new DataView(min.buffer).getInt16(0, true)).toBe(-128);
  });

  it("a v1 chunk holding an i8 TerrainEdit migrates and decodes with its dig intact", () => {
    const w = worldWithTerrainEdit();
    const bytes = v1BlobWithTerrainEdit(w, -5);
    // Without the migration the old schema hash rejects the chunk.
    expect(() => decodeChunk(bytes, { world: w })).toThrow(/schema mismatch/);
    const up = migrateChunkBytes(w, bytes);
    expect(up).toBeDefined();
    const dec = decodeChunk(up!, { world: w });
    expect(dec.entities).toHaveLength(1);
    const [e] = dec.entities;
    expect(w.getField(e!, TerrainEdit, "dig")).toBe(-5);
    expect(w.get(e!, Transform)?.x).toBeCloseTo(1.5);
    expect(w.get(e!, Transform)?.y).toBeCloseTo(0.5);
  });

  it("v2 chunk rows are left alone by the migration", () => {
    const w = worldWithTerrainEdit();
    expect(migrateChunkBytes(w, encodeChunk(new Chunk(0, 0)))).toBeUndefined();
  });
});

/** v1 chunk blob (chunk 0,0, all-grass heights 2) holding one entity: Transform + TerrainEdit(dig, i8). */
function v1BlobWithTerrainEdit(w: World, dig: number): Uint8Array {
  const tId = w.store(Transform).id, eId = w.store(TerrainEdit).id;
  const tHash = schemaHash(Transform.schema);
  const eHash = schemaHash(oldSchemaOf(TerrainEdit.schema, [], {}, {}, { dig: "i8" }));
  const out = new Uint8Array(1083);
  const d = new DataView(out.buffer);
  d.setUint32(0, CHUNK_MAGIC, true); d.setUint16(4, 1, true); d.setInt32(6, 0, true); d.setInt32(10, 0, true);
  d.setUint16(14, 1, true); d.setUint16(16, 1024, true); d.setUint16(18, 3, true);
  out.fill(2, 20, 20 + 1024);
  let o = 20 + 1024;
  d.setUint16(o, 0, true); o += 2; // no buildings
  out[o] = 2; o += 1; // two components in the table
  d.setUint16(o, tId, true); d.setUint32(o + 2, tHash, true); o += 6;
  d.setUint16(o, eId, true); d.setUint32(o + 2, eHash, true); o += 6;
  d.setUint32(o, 1, true); o += 4; // one entity
  out[o] = 2; o += 1; // two components on the entity
  out[o] = 0; o += 1; // Transform (table index 0): fields in sorted order facing, x, y, z
  d.setFloat32(o, 0, true); d.setFloat32(o + 4, 1.5, true); d.setFloat32(o + 8, 0.5, true); d.setFloat32(o + 12, 0, true); o += 16;
  out[o] = 1; o += 1; // TerrainEdit (table index 1)
  out[o] = dig & 0xff; o += 1;
  expect(o).toBe(out.length);
  return out;
}
