import { BinaryReader, BinaryWriter, decodeField, encodeField, entityIndex, schemaHash, Transform, type ComponentStore, type Entity, type World } from "@engine/core";
import { Chunk, CHUNK_AREA, CHUNK_SIZE } from "./chunk.js";
import type { BuildingGrid } from "./building.js";

export const CHUNK_MAGIC = 0x4b4e4843; // "CHNK"
export const CHUNK_VERSION = 2;

/**
 * Versioned binary chunk format v2 (LE):
 *   u32 magic, u16 version, i32 cx, i32 cy
 *   tiles: u16 runCount, runCount x (u16 len, u16 id)      (RLE)
 *   height: 1024 x i16                                     (v1: 1024 x u8, two's complement — decode sign-extends)
 *   buildings: u16 n, n x (u16 piece, u8 lx, u8 ly, u8 z, u8 rot|state<<2, f32 hp)   (state 0..63 in the upper bits; v1-compatible)
 *   components: u8 n, n x (u16 componentId, u32 schemaHash)   (persistent components present in this chunk)
 *   entities: u32 n, n x (u8 compCount, compCount x (u8 tableIndex, record))
 * Transform x/y are stored chunk-relative (precision: see WorldOrigin guidance) and rebased on decode.
 * No storage backend: callers persist the bytes (ChunkProvider.save / their own store).
 * ADR-411: v2 widens heights to i16 because absolute terrain levels now span -100..100 (ADR-529: was -300..326; v1's byte held -60..75).
 * v1 blobs still decode (heights read as u8 and sign-extended; legacy flow-water bytes decode as before).
 */
let scratch = new ArrayBuffer(1 << 16); let scratchView = new DataView(scratch);
function ensureScratch(n: number): void { if (scratch.byteLength >= n) return; let c = scratch.byteLength; while (c < n) c *= 2; scratch = new ArrayBuffer(c); scratchView = new DataView(scratch); }
/** Header + tiles + height + buildings written straight into a reused DataView (no per-piece/per-run allocation). */
function encodeStatic(chunk: Chunk, buildings: BuildingGrid | undefined): number {
  const anchored = buildings?.layer(chunk.key)?.anchored;
  const nb = anchored?.size ?? 0; if (nb > 0xffff) throw new Error("too many pieces in chunk");
  ensureScratch(14 + 2 + CHUNK_AREA * 4 + CHUNK_AREA * 2 + 2 + nb * 10);
  const d = scratchView; let o = 0; const t = chunk.tiles;
  d.setUint32(o, CHUNK_MAGIC, true); d.setUint16(o + 4, CHUNK_VERSION, true); d.setInt32(o + 6, chunk.cx, true); d.setInt32(o + 10, chunk.cy, true); o = 14;
  const runsAt = o; o += 2; let runs = 0;
  for (let i = 0; i < CHUNK_AREA;) { const v = t[i]!; let n = 1; while (i + n < CHUNK_AREA && t[i + n] === v && n < 0xffff) n++; d.setUint16(o, n, true); d.setUint16(o + 2, v, true); o += 4; runs++; i += n; }
  d.setUint16(runsAt, runs, true);
  for (let i = 0; i < CHUNK_AREA; i++) { d.setInt16(o + i * 2, chunk.height[i]!, true); } o += CHUNK_AREA * 2;
  d.setUint16(o, nb, true); o += 2;
  if (anchored && nb) {
    const ox = chunk.cx * CHUNK_SIZE, oy = chunk.cy * CHUNK_SIZE;
    for (const id of anchored) { const b = buildings!.get(id)!; d.setUint16(o, b.piece, true); d.setUint8(o + 2, b.tx - ox); d.setUint8(o + 3, b.ty - oy); d.setUint8(o + 4, b.z); d.setUint8(o + 5, (b.rot & 3) | (b.state << 2)); d.setFloat32(o + 6, b.hp, true); o += 10; }
  }
  return o;
}
export function encodeChunk(chunk: Chunk, opts: { world?: World; entities?: Iterable<Entity>; buildings?: BuildingGrid } = {}): Uint8Array {
  const head = encodeStatic(chunk, opts.buildings);
  if (!opts.world) { const out = new Uint8Array(head + 5); out.set(new Uint8Array(scratch, 0, head)); return out; } // u8 0 comps + u32 0 ents
  const w = new BinaryWriter(256);
  const world = opts.world;
  const stores = world ? world.componentStores.filter((s) => s.def.persistent) : [];
  const ents = world ? [...(opts.entities ?? [])].filter((e) => world.isAlive(e) && stores.some((s) => s.has(entityIndex(e)))) : [];
  const used = stores.filter((s) => ents.some((e) => s.has(entityIndex(e))));
  w.write("u8", used.length); for (const s of used) { w.write("u16", s.id); w.write("u32", schemaHash(s.def.schema)); }
  w.write("u32", ents.length);
  const ox = chunk.cx * CHUNK_SIZE, oy = chunk.cy * CHUNK_SIZE;
  for (const e of ents) {
    const i = entityIndex(e); const have = used.map((s, ti) => [s, ti] as const).filter(([s]) => s.has(i));
    w.write("u8", have.length);
    for (const [s, ti] of have) {
      w.write("u8", ti); const slot = s.slot(i);
      if (s.def === (Transform as unknown)) { // chunk-relative position
        const t = s as unknown as ComponentStore<typeof Transform.schema>;
        for (const f of t.fields) w.write("f32", f === "x" ? t.data.x[slot]! - ox : f === "y" ? t.data.y[slot]! - oy : t.data[f][slot]!);
      } else for (const f of s.fields) encodeField(s, f, slot, w);
    }
  }
  const tail = w.finish(); const out = new Uint8Array(head + tail.length);
  out.set(new Uint8Array(scratch, 0, head)); out.set(tail, head); return out;
}

export interface DecodedChunk { chunk: Chunk; buildings: { piece: number; tx: number; ty: number; z: number; rot: number; state: number; hp: number }[]; entities: Entity[] }
/** Decodes a chunk; creates its persistent entities in `world` and places buildings into `buildings` if given. */
export function decodeChunk(bytes: Uint8Array, opts: { world?: World; buildings?: BuildingGrid } = {}): DecodedChunk {
  const r = new BinaryReader(bytes);
  if (r.read("u32") !== CHUNK_MAGIC) throw new Error("bad chunk magic");
  const ver = r.read("u16"); if (ver > CHUNK_VERSION) throw new Error(`unsupported chunk version ${ver}`);
  const cx = r.read("i32"), cy = r.read("i32"); const chunk = new Chunk(cx, cy);
  let p = 0; const nr = r.read("u16");
  for (let k = 0; k < nr; k++) { const n = r.read("u16"), t = r.read("u16"); if (p + n > CHUNK_AREA) throw new Error("tile RLE overflow"); chunk.tiles.fill(t, p, p + n); p += n; }
  if (p !== CHUNK_AREA) throw new Error("tile RLE underflow");
  if (ver === 1) {
    // v1 heights are one two's-complement byte per tile: sign-extend into the i16 array (a raw 251 is -5, not 251).
    for (let i = 0; i < CHUNK_AREA; i++) { const b = r.read("u8"); chunk.height[i] = b > 127 ? b - 256 : b; }
  } else {
    for (let i = 0; i < CHUNK_AREA; i++) chunk.height[i] = r.read("i16");
  }
  const ox = cx * CHUNK_SIZE, oy = cy * CHUNK_SIZE; const buildings: DecodedChunk["buildings"] = [];
  const nb = r.read("u16");
  for (let k = 0; k < nb; k++) {
    const b = { piece: r.read("u16"), tx: ox + r.read("u8"), ty: oy + r.read("u8"), z: r.read("u8"), rotState: r.read("u8"), hp: r.read("f32") };
    const rec = { piece: b.piece, tx: b.tx, ty: b.ty, z: b.z, rot: b.rotState & 3, state: b.rotState >> 2, hp: b.hp };
    buildings.push(rec); opts.buildings?.place(rec.piece, rec.tx, rec.ty, rec.z, rec.rot, rec.hp, rec.state);
  }
  const nc = r.read("u8"); const table: ComponentStore[] = []; const world = opts.world;
  for (let k = 0; k < nc; k++) {
    const id = r.read("u16"), h = r.read("u32"); const st = world?.storeById(id);
    if (world && (!st || schemaHash(st.def.schema) !== h || !st.def.persistent)) throw new Error(`chunk component ${id} schema mismatch`);
    if (st) table.push(st);
  }
  const ne = r.read("u32"); const entities: Entity[] = [];
  if (ne && !world) throw new Error("chunk has entities: pass a world to decode");
  for (let k = 0; k < ne; k++) {
    const e = world!.create(); entities.push(e); const i = entityIndex(e); const cc = r.read("u8");
    for (let c = 0; c < cc; c++) {
      const st = table[r.read("u8")]; if (!st) throw new Error("bad component table index");
      const slot = st.add(e, i);
      for (const f of st.fields) decodeField(st, f, slot, r);
      if (st.def === (Transform as unknown)) { const dx = st.data["x"]!, dy = st.data["y"]!; dx[slot] = dx[slot]! + ox; dy[slot] = dy[slot]! + oy; }
    }
  }
  chunk.dirty = false; return { chunk, buildings, entities };
}
