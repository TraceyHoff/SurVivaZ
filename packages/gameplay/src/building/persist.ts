/**
 * Deterministic, versioned per-chunk structure codec ("STRC"). Gameplay owns this blob (pieces are not saved via
 * core's persistent flag, to avoid double-saving); persistence/streaming store it next to the chunk.
 *
 * Layout v1 (little endian, core BinaryWriter):
 *   header: u8 'S','T','R','C' | u16 version | i32 cx | i32 cy | u32 pieceHash | u32 itemHash | u32 count
 *   record: u16 type | u8 tier | u8 rot | u8 variant | u8 paint | u16 hp | u8 level | i16 qx | i16 qy (quarter tiles
 *           relative to the chunk origin) | u16 tribe | u8 flags (1 door, 2 fire, 4 storage, 16 exact x/y: tri (v4), off-grid free piece (ADR-174))
 *           [exact (flag 16, v4): f64 x, f64 y exact world position — tri centroid (ADR-104) or off-grid free piece (ADR-174)]
 *           [door: u8 open, u16 lockTribe] [fire: u8 lit, u32 burnRemainingTicks]
 *           [container (fire or storage): u8 slotCount, u8 n, n x (u8 slot, u16 item, u16 count, u32 ageTicks, u16 durability, u32 crafterId (v2))]
 *           [stall (flag 8, v2): u8 ownerKind, u32 ownerId, u8 open, u32 revision, u8 L, L x (u16 priceItem, u16 priceCount, u16 qty, u8 enabled),
 *            u8 head, u32 total, LEDGER_SIZE x (u32 age, u16 item, u16 count, u16 priceItem, u32 priceCount, u32 buyerId, u32 crafterId), till container]
 *            [v3: u8 nameLen, nameLen x u8 sign text (StallSign)]
 * ADR-259 v5: flag 32 adds an f64 persistent worker-target identity after exact position.
 * ADR-317 v6: flag 64 adds u32 owner (PieceOwner) + u32 builder (PieceBuilder) after the worker target. Pieces from
 * older blobs load without a PieceBuilder (builder unknown: Demolish falls back to the piece's tribe, see building/edit.ts).
 * v1 blobs (no crafterId, no stall block) and v2 blobs (no sign text) still decode.
 * Records are sorted (decks, structure cells, edges, furniture, openings; then level, y, x, type, rot) so hosts
 * decode before openings and re-encoding a decoded chunk is byte-identical. Times are relative to the save tick.
 */
import { BinaryReader, BinaryWriter, entityIndex, Transform, type Entity, type World } from "@engine/core";
import { refreshSoldOut, stallName, writeStallName } from "../economy/stall.js";
import { CHUNK_SIZE, chunkKey, type ChunkKey } from "@engine/world";
import { AttachKind, BuildPiece, Container, DoorState, Fuel, LEDGER_SIZE, Listings, PieceBuilder, PieceLink, PieceOwner, PieceSlot, PieceStability, StallHeader, StallLedger, Tribe, WorkerTarget } from "../components.js";
import { gameplayDefs, isAuthority } from "../config.js";
import { Placement, type PieceDef } from "../defs.js";
import { attachmentsOf, unlinkPiece } from "./links.js";
import { recomputeRegion } from "./integrity.js";
import { maxHp, outerCornerRots, placePiece } from "./place.js";
import { edgeKey, isFineRot, lCornerArms, openingParent, slotFromPos, slotTransform, structures, unmarkLinked, type StructureIndex } from "./structure.js";
import { setEmittersLit } from "../systems/fuel.js";
import { setStallOwnership } from "../economy/stall.js";

export const STRC_VERSION = 6;
const MAGIC = [0x53, 0x54, 0x52, 0x43];
export class StructureCodecError extends Error {}

const rank = (d: PieceDef): number => d.placement === Placement.Cell ? d.layer : d.placement === Placement.Edge ? 4 : d.placement === Placement.Free ? 5 : 6;

interface Rec { e: Entity; def: PieceDef; level: number; qx: number; qy: number; rot: number; type: number; x: number; y: number }
function records(world: World, idx: StructureIndex, cx: number, cy: number): Rec[] {
  const lh = gameplayDefs(world).building.levelHeight; const out: Rec[] = [];
  for (const e of idx.chunkPieces.get(chunkKey(cx, cy)) ?? []) {
    const def = idx.def(e); const t = world.get(e, Transform); const bp = world.get(e, BuildPiece); if (!def || !t || !bp) continue;
    out.push({ e, def, level: Math.round(t.z / lh), qx: Math.round((t.x - cx * CHUNK_SIZE) * 4), qy: Math.round((t.y - cy * CHUNK_SIZE) * 4), rot: bp.rot, type: bp.type, x: t.x, y: t.y });
  }
  return out.sort((a, b) => rank(a.def) - rank(b.def) || a.level - b.level || a.qy - b.qy || a.qx - b.qx || a.type - b.type || a.rot - b.rot || a.x - b.x || a.y - b.y);
}

export function encodeStructures(world: World, cx: number, cy: number): Uint8Array {
  const defs = gameplayDefs(world); const idx = structures(world); const w = new BinaryWriter(256);
  for (const m of MAGIC) w.write("u8", m);
  w.write("u16", STRC_VERSION); w.write("i32", cx); w.write("i32", cy); w.write("u32", defs.hashes.pieces); w.write("u32", defs.hashes.items);
  const recs = records(world, idx, cx, cy); w.write("u32", recs.length);
  for (const r of recs) {
    const bp = world.get(r.e, BuildPiece)!;
    w.write("u16", bp.type); w.write("u8", bp.tier); w.write("u8", bp.rot); w.write("u8", bp.variant); w.write("u8", bp.paint); w.write("u16", bp.hp);
    w.write("u8", r.level); w.write("i16", r.qx); w.write("i16", r.qy); w.write("u16", world.getField(r.e, Tribe, "id") ?? 0);
    const atts = attachmentsOf(world, r.e);
    const door = atts.find((a) => world.has(a, DoorState)); const fire = atts.find((a) => world.has(a, Fuel));
    const store = atts.find((a) => world.has(a, Container) && !world.has(a, Fuel));
    const stall = store !== undefined && world.has(store, StallHeader) ? store : undefined;
    const exact = r.def.placement === Placement.Tri || isFineRot(r.def, bp.rot); // ADR-174: off-grid free pieces keep their exact x/y too
    const owner = world.isRegistered(PieceOwner) ? world.getField(r.e, PieceOwner, "player") ?? 0 : 0, builder = world.isRegistered(PieceBuilder) ? world.getField(r.e, PieceBuilder, "player") ?? 0 : 0;
    w.write("u8", (door !== undefined ? 1 : 0) | (fire !== undefined ? 2 : 0) | (store !== undefined ? 4 : 0) | (stall !== undefined ? 8 : 0) | (exact ? 16 : 0) | (world.has(r.e, WorkerTarget) ? 32 : 0) | (owner || builder ? 64 : 0));
    if (exact) { const s = idx.slotOf(r.e); const t = world.get(r.e, Transform)!; w.write("f64", s?.fx ?? t.x); w.write("f64", s?.fy ?? t.y); }
    if (world.has(r.e, WorkerTarget)) w.write("f64", world.getField(r.e, WorkerTarget, "id")!);
    if (owner || builder) { w.write("u32", owner); w.write("u32", builder); } // ADR-317 (v6)
    if (door !== undefined) { const d = world.get(door, DoorState)!; w.write("u8", d.open); w.write("u16", d.lockTribe); }
    if (fire !== undefined) { const f = world.get(fire, Fuel)!; w.write("u8", f.lit); w.write("u32", Math.max(0, f.burnUntilTick - world.tick)); }
    for (const c of [fire, store]) if (c !== undefined) writeContainer(world, w, c);
    if (stall !== undefined) writeStall(world, w, stall, atts.find((a) => world.getField(a, PieceLink, "kind") === AttachKind.Till));
  }
  return w.finish();
}
function writeContainer(world: World, w: BinaryWriter, c: Entity): void {
  const n = world.getField(c, Container, "slotCount")!; const items = world.getArray(c, Container, "items")!, counts = world.getArray(c, Container, "counts")!, created = world.getArray(c, Container, "createdTick")!;
  const used: number[] = []; for (let i = 0; i < n; i++) if (items[i] && counts[i]) used.push(i);
  w.write("u8", n); w.write("u8", used.length);
  const dur = world.getArray(c, Container, "durability")!, cr = world.getArray(c, Container, "crafterId")!;
  for (const i of used) { w.write("u8", i); w.write("u16", items[i]!); w.write("u16", counts[i]!); w.write("u32", Math.max(0, world.tick - created[i]!)); w.write("u16", dur[i]!); w.write("u32", cr[i]!); }
}
function writeStall(world: World, w: BinaryWriter, s: Entity, till: Entity | undefined): void {
  const h = world.get(s, StallHeader)!; w.write("u8", h.ownerKind); w.write("u32", h.ownerId); w.write("u8", h.open);
  w.write("u32", world.getField(s, Listings, "revision")!); const L = h.listingCount; w.write("u8", L);
  const g = (f: "priceItem" | "priceCount" | "qty" | "enabled") => world.getArray(s, Listings, f)!;
  for (let i = 0; i < L; i++) { w.write("u16", g("priceItem")[i]!); w.write("u16", g("priceCount")[i]!); w.write("u16", g("qty")[i]!); w.write("u8", g("enabled")[i]!); }
  const l = (f: "tick" | "item" | "count" | "priceItem" | "priceCount" | "buyerId" | "crafterId") => world.getArray(s, StallLedger, f)!;
  w.write("u8", world.getField(s, StallLedger, "head")!); w.write("u32", world.getField(s, StallLedger, "total")!);
  for (let i = 0; i < LEDGER_SIZE; i++) { w.write("u32", Math.max(0, world.tick - l("tick")[i]!)); w.write("u16", l("item")[i]!); w.write("u16", l("count")[i]!); w.write("u16", l("priceItem")[i]!); w.write("u32", l("priceCount")[i]!); w.write("u32", l("buyerId")[i]!); w.write("u32", l("crafterId")[i]!); }
  if (till !== undefined) writeContainer(world, w, till); else { w.write("u8", 0); w.write("u8", 0); }
  const name = stallName(world, s); const bytes = Array.from(name, (ch) => ch.charCodeAt(0)); w.write("u8", bytes.length); for (const b of bytes) w.write("u8", b);
}
function readStall(world: World, r: BinaryReader, s: Entity | undefined, till: Entity | undefined, version: number): void {
  const ownerKind = r.read("u8"), ownerId = r.read("u32"), open = r.read("u8"), revision = r.read("u32"), L = r.read("u8");
  const rows: number[][] = []; for (let i = 0; i < L; i++) rows.push([r.read("u16"), r.read("u16"), r.read("u16"), r.read("u8")]);
  const head = r.read("u8"), total = r.read("u32");
  const led: number[][] = []; for (let i = 0; i < LEDGER_SIZE; i++) led.push([r.read("u32"), r.read("u16"), r.read("u16"), r.read("u16"), r.read("u32"), r.read("u32"), r.read("u32")]);
  if (s !== undefined) {
    world.set(s, StallHeader, { ownerKind, ownerId, open }); world.setField(s, Listings, "revision", revision);
    const g = (f: "priceItem" | "priceCount" | "qty" | "enabled") => world.getArray(s, Listings, f)!;
    rows.forEach((x, i) => { g("priceItem")[i] = x[0]!; g("priceCount")[i] = x[1]!; g("qty")[i] = x[2]!; g("enabled")[i] = x[3]!; });
    const l = (f: "tick" | "item" | "count" | "priceItem" | "priceCount" | "buyerId" | "crafterId") => world.getArray(s, StallLedger, f)!;
    led.forEach((x, i) => { l("tick")[i] = x[1] ? Math.max(0, world.tick - x[0]!) : 0; l("item")[i] = x[1]!; l("count")[i] = x[2]!; l("priceItem")[i] = x[3]!; l("priceCount")[i] = x[4]!; l("buyerId")[i] = x[5]!; l("crafterId")[i] = x[6]!; });
    world.setField(s, StallLedger, "head", head); world.setField(s, StallLedger, "total", total);
    world.store(Listings).markChanged(entityIndex(s)); world.store(StallLedger).markChanged(entityIndex(s));
    setStallOwnership(world, s, till, ownerKind, ownerId);
  }
  readContainer(world, r, till, 2);
  if (version >= 3) { const n = r.read("u8"); let name = ""; for (let i = 0; i < n; i++) name += String.fromCharCode(r.read("u8")); if (s !== undefined) writeStallName(world, s, name); }
  if (s !== undefined) refreshSoldOut(world, s);
}
function readContainer(world: World, r: BinaryReader, c: Entity | undefined, version: number): void {
  const n = r.read("u8"); const used = r.read("u8");
  const items = c !== undefined ? world.getArray(c, Container, "items") : undefined, counts = c !== undefined ? world.getArray(c, Container, "counts") : undefined, created = c !== undefined ? world.getArray(c, Container, "createdTick") : undefined;
  if (c !== undefined) world.setField(c, Container, "slotCount", n);
  for (let k = 0; k < used; k++) {
    const i = r.read("u8"), item = r.read("u16"), count = r.read("u16"), age = r.read("u32"), d = r.read("u16"), crafter = version >= 2 ? r.read("u32") : 0;
    const dur = c !== undefined ? world.getArray(c, Container, "durability") : undefined, cr = c !== undefined ? world.getArray(c, Container, "crafterId") : undefined;
    if (items && counts && created && dur && cr && i < items.length) { items[i] = item; counts[i] = count; created[i] = Math.max(0, world.tick - age); dur[i] = d; cr[i] = crafter; }
  }
  if (c !== undefined) world.store(Container).markChanged(entityIndex(c));
}

export interface DecodedStructures { cx: number; cy: number; pieces: Entity[]; hashMismatch: boolean }
/** Decodes into the world (server/authority): spawns pieces + attachments, restores state, recomputes stability. */
export function decodeStructures(world: World, bytes: Uint8Array, opts: { strictHashes?: boolean } = {}): DecodedStructures {
  const defs = gameplayDefs(world); const idx = structures(world); const r = new BinaryReader(bytes); const lh = defs.building.levelHeight;
  for (const m of MAGIC) if (r.read("u8") !== m) throw new StructureCodecError("not a structure blob (bad magic)");
  const version = r.read("u16"); if (version !== STRC_VERSION && version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5) throw new StructureCodecError(`unsupported structure blob version ${version} (expected ${STRC_VERSION})`);
  const cx = r.read("i32"), cy = r.read("i32"); const ph = r.read("u32"), ih = r.read("u32");
  const hashMismatch = ph !== defs.hashes.pieces || ih !== defs.hashes.items;
  if (hashMismatch && opts.strictHashes) throw new StructureCodecError("structure blob was written with different piece/item ids");
  const count = r.read("u32"); const pieces: Entity[] = [];
  for (let k = 0; k < count; k++) {
    const type = r.read("u16"), tier = r.read("u8"), rot = r.read("u8"), variant = r.read("u8"), paint = r.read("u8"), hp = r.read("u16");
    const level = r.read("u8"), qx = r.read("i16"), qy = r.read("i16"), tribe = r.read("u16"), flags = r.read("u8");
    const triPos = flags & 16 ? { x: r.read("f64"), y: r.read("f64") } : undefined;
    const workerTarget = flags & 32 ? r.read("f64") : 0;
    const who = flags & 64 ? { owner: r.read("u32"), builder: r.read("u32") } : undefined; // ADR-317 (v6)
    const door = flags & 1 ? { open: r.read("u8"), lockTribe: r.read("u16") } : undefined;
    const fire = flags & 2 ? { lit: r.read("u8"), rem: r.read("u32") } : undefined;
    const def = defs.pieces.get(type);
    const x = triPos?.x ?? cx * CHUNK_SIZE + qx / 4, y = triPos?.y ?? cy * CHUNK_SIZE + qy / 4;
    let e: Entity | undefined;
    if (def) {
      const slot = slotFromPos(def, x, y, level, rot);
      const parent = def.placement === Placement.Opening ? openingParent(idx, def, slot) : 0;
      if (def.placement !== Placement.Opening || parent) {
        e = placePiece(world, 0, { def, slot, parent, pos: slotTransform(def, slot, lh, x, y), tier, variant }, { pay: false, hp, paint, tribe });
        if (workerTarget) world.add(e, WorkerTarget, { id: workerTarget });
        if (who?.owner && world.isRegistered(PieceOwner)) world.add(e, PieceOwner, { player: who.owner });
        if (world.isRegistered(PieceBuilder) && world.has(e, PieceBuilder)) { if (who) world.setField(e, PieceBuilder, "player", who.builder); else if (version < 6) world.remove(e, PieceBuilder); } // legacy: builder unknown
        pieces.push(e);
      }
    }
    const atts = e !== undefined ? attachmentsOf(world, e) : [];
    const doorA = atts.find((a) => world.has(a, DoorState)); const fireA = atts.find((a) => world.has(a, Fuel)); const storeA = atts.find((a) => world.has(a, Container) && !world.has(a, Fuel));
    if (door && doorA !== undefined) world.set(doorA, DoorState, door);
    if (fire && fireA !== undefined) { world.set(fireA, Fuel, { lit: fire.lit, burnUntilTick: world.tick + fire.rem }); }
    if (fire) readContainer(world, r, fireA, version);
    if (flags & 4) readContainer(world, r, storeA, version);
    if (flags & 8) readStall(world, r, storeA !== undefined && world.has(storeA, StallHeader) ? storeA : undefined, atts.find((a) => world.getField(a, PieceLink, "kind") === AttachKind.Till), version);
  }
  if (isAuthority(world)) migrateWallPairsToCorners(world, idx, pieces);
  if (isAuthority(world) && pieces.length) { recomputeRegion(world, idx, new Set(pieces)); idx.dirty.clear(); }
  // fires: restore emitter strength for lit fires
  for (const p of pieces) for (const a of attachmentsOf(world, p)) if (world.getField(a, Fuel, "lit")) setEmittersLit(world, a, 1);
  return { cx, cy, pieces, hashMismatch };
}
/** Drops a chunk's pieces from the world without destruction rules (unload after saving). */
export function unloadStructures(world: World, k: ChunkKey): number {
  const idx = structures(world); const set = [...(idx.chunkPieces.get(k) ?? [])]; let n = 0;
  for (const e of set) {
    for (const a of unlinkPiece(world, e)) if (world.isAlive(a)) { unmarkLinked(world, a); world.destroy(a); }
    idx.removePiece(e); if (world.isAlive(e)) { world.destroy(e); n++; }
  }
  return n;
}
/** Per-chunk structure version (bumped on any change) for dirty tracking. */
export const structureChunkVersion = (world: World, k: ChunkKey): number => structures(world).chunkVersions.get(k) ?? 0;


/**
 * ADR-211 save migration (load, authority only; idempotent): a pair of plain straight walls (`wall` at any tier, no
 * door/window opening, no attachments) occupying both arms of a foundation outer corner was the only way to close a
 * corner before L corners; it now fills a slot straight walls may not use. Each such pair is merged into one
 * `wall_corner_outer` L at the vertex, at the lower of the two tiers (cost-neutral: an L costs 2 walls, so nothing is
 * refunded or charged), hp scaled to the pair's mean health fraction, keeping the first wall's paint/variant/tribe.
 * Singles in a corner slot (and doorway/window frames) are grandfathered as-is. `pieces` is updated in place.
 */
export function migrateWallPairsToCorners(world: World, idx: StructureIndex, pieces: Entity[]): number {
  const defs = gameplayDefs(world); let wallDef: PieceDef | undefined, lDef: PieceDef | undefined;
  for (const d of defs.pieces.values()) { if (d.key === "wall") wallDef = d; else if (d.key === "wall_corner_outer") lDef = d; }
  if (!wallDef || !lDef) return 0; const lh = defs.building.levelHeight;
  const plain = (e: Entity | 0): e is Entity => !!e && world.isAlive(e) && world.getField(e, BuildPiece, "type") === wallDef!.id && !idx.opening(e) && attachmentsOf(world, e).length === 0;
  const verts = new Set<string>(); let n = 0;
  for (const e of pieces) {
    if (!plain(e)) continue; const s = world.get(e, PieceSlot); if (!s) continue;
    const vs: [number, number][] = s.side === 1 ? [[s.tx, s.ty], [s.tx + 1, s.ty]] : [[s.tx, s.ty], [s.tx, s.ty + 1]];
    for (const [vx, vy] of vs) verts.add(`${vx},${vy},${s.z}`);
  }
  for (const v of [...verts].sort()) {
    const [vx, vy, z] = v.split(",").map(Number) as [number, number, number];
    for (const r of outerCornerRots(idx, vx, vy, z)) {
      const ws = lCornerArms(vx, vy, r).map((a) => idx.edges.get(edgeKey(a.tx, a.ty, z, a.side)) ?? 0);
      if (!plain(ws[0]!) || !plain(ws[1]!) || ws[0] === ws[1]) continue;
      const [a, b] = ws as [Entity, Entity]; const pa = world.get(a, BuildPiece)!, pb = world.get(b, BuildPiece)!;
      const tier = Math.min(pa.tier, pb.tier); const tribe = world.getField(a, Tribe, "id") ?? 0;
      const frac = (pa.hp / Math.max(1, maxHp(defs, wallDef, pa.tier)) + pb.hp / Math.max(1, maxHp(defs, wallDef, pb.tier))) / 2;
      for (const e of [a, b]) { idx.removePiece(e); world.destroy(e); const i = pieces.indexOf(e); if (i >= 0) pieces.splice(i, 1); }
      const slot = { tx: vx, ty: vy, z, side: 0, rot: r } as const;
      const hp = Math.max(1, Math.min(0xffff, Math.round(maxHp(defs, lDef, tier) * Math.min(1, frac))));
      pieces.push(placePiece(world, 0, { def: lDef, slot, parent: 0, pos: slotTransform(lDef, slot, lh, vx, vy), tier, variant: pa.variant }, { pay: false, hp, paint: pa.paint, tribe }));
      n++; break;
    }
  }
  return n;
}
