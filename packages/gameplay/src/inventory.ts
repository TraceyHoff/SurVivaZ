/**
 * Inventory operations over fixed-slot Inventory (players) and Container (storage, fuel slots) components.
 *
 * All mutations go through a SlotView so the same logic runs against the live SoA arrays or a scratch copy
 * (transactional "would this fit?" checks in crafting). Rules:
 *  - item id 0 = empty slot; counts never exceed the item's maxStack.
 *  - add fills existing stacks first (lowest slot first), then empty slots; partial adds are allowed and return
 *    the amount actually added (limited by slots AND maxWeight).
 *  - remove is all-or-nothing and takes from the highest slot first.
 *  - weight is recomputed and cached on every write.
 * Spoilage: each slot stores an effective `created` tick; freshness = core decayAt(created, rate x spoilMul, tick).
 * Merging stacks averages created ticks by count; moving between holders with different spoilMul re-bases created
 * so freshness is preserved (systems/spoilage.ts also re-bases when temperature changes the multiplier).
 */
import { decayAt, entityIndex, type ComponentDef, type Entity, type World } from "@engine/core";
import { Container, Inventory, PACK_SLOTS, HOTBAR_OFFSET, HotbarSelection, type InvSchema } from "./components.js";
import { gameplayDefs } from "./config.js";
import { skillMul } from "./skills/tree.js";
import type { GameDefs, ItemCount } from "./defs.js";

export interface SlotView {
  readonly slotCount: number;
  readonly maxWeight: number;
  /** Slots below this index accept newly added items (merges + fresh stacks). For a player's Inventory this is the
   * pack size (PACK_SLOTS): gathered / crafted / looted items never land on the hotbar; the hotbar is filled only by
   * explicit moves (MoveSlot / container-to-slot). Containers use slotCount (no hotbar). Defaults to slotCount. */
  readonly addLimit: number;
  item(i: number): number;
  count(i: number): number;
  created(i: number): number;
  durability(i: number): number;
  /** Crafter provenance (PlayerId, 0 = gathered); part of the stack key. */
  crafter(i: number): number;
  put(i: number, item: number, count: number, created?: number, durability?: number, crafter?: number): void;
}

export class ScratchSlots implements SlotView {
  readonly addLimit: number;
  constructor(readonly slotCount: number, readonly maxWeight: number, readonly items: number[], readonly counts: number[], readonly createds: number[], readonly durs: number[] = [], readonly now = 0, readonly crafters: number[] = [], addLimit?: number) { this.addLimit = addLimit ?? slotCount; }
  item(i: number): number { return this.items[i] ?? 0; }
  count(i: number): number { return this.counts[i] ?? 0; }
  created(i: number): number { return this.createds[i] ?? 0; }
  durability(i: number): number { return this.durs[i] ?? 0; }
  crafter(i: number): number { return this.crafters[i] ?? 0; }
  /** Writes a whole slot tuple (item, count, createdTick, durability, crafterId). */
  put(i: number, item: number, count: number, created = this.created(i), durability = this.durability(i), crafter = this.crafter(i)): void {
    const on = count > 0; this.items[i] = on ? item : 0; this.counts[i] = on ? count : 0; this.createds[i] = on ? created : 0; this.durs[i] = on ? durability : 0; this.crafters[i] = on ? crafter : 0;
  }
}

/** Inventory (players) or Container (storage/fuel slots): same shape, same ops. */
export function slotsDef(world: World, e: Entity): ComponentDef<InvSchema> {
  if (world.has(e, Inventory)) return Inventory;
  if (world.has(e, Container)) return Container;
  throw new Error("entity has no Inventory or Container");
}
export const hasSlots = (world: World, e: Entity): boolean => world.has(e, Inventory) || world.has(e, Container);

/** ADR-212: plain-loop copy (Array.from(subarray) went through the iterator protocol: ~45 MB/s of garbage with bots). */
function takeField(world: World, def: ComponentDef<InvSchema>, idx: number, f: "items" | "counts" | "createdTick" | "durability" | "crafterId", n: number): number[] {
  const st = world.store(def); const out = new Array<number>(n); for (let i = 0; i < n; i++) out[i] = st.readElement(idx, f, i) ?? 0; return out;
}
/** ADR-212 allocation-free slot count of the live arrays (0 when the entity has no Inventory / Container). */
function liveSlotCount(world: World, e: Entity): { def: ComponentDef<InvSchema>; idx: number; n: number } | undefined {
  const def = world.has(e, Inventory) ? Inventory : world.has(e, Container) ? Container : undefined; if (!def) return undefined;
  const st = world.store(def); const idx = entityIndex(e); LIVE.def = def; LIVE.idx = idx; LIVE.n = Math.min(st.data.slotCount[st.slot(idx)]!, def.schema.items.length); return LIVE;
}
const LIVE: { def: ComponentDef<InvSchema>; idx: number; n: number } = { def: Inventory, idx: 0, n: 0 };
export function readSlots(world: World, e: Entity): ScratchSlots {
  const def = slotsDef(world, e); const st = world.store(def); const idx = entityIndex(e); const s = st.slot(idx);
  const n = Math.min(st.data.slotCount[s]!, def.schema.items.length);
  const take = (f: "items" | "counts" | "createdTick" | "durability" | "crafterId"): number[] => takeField(world, def, idx, f, n);
  return new ScratchSlots(n, st.data.maxWeight[s]! * (def === Inventory ? skillMul(world, e, "carry") : 1), take("items"), take("counts"), take("createdTick"), take("durability"), world.tick, take("crafterId"), def === Inventory ? Math.min(n, PACK_SLOTS) : n);
}
export function writeSlots(world: World, e: Entity, v: ScratchSlots, defs: GameDefs): void {
  const def = slotsDef(world, e); const st = world.store(def); const idx = entityIndex(e);
  const items = world.getArray(e, def, "items")!, counts = world.getArray(e, def, "counts")!, created = world.getArray(e, def, "createdTick")!, dur = world.getArray(e, def, "durability")!, cr = world.getArray(e, def, "crafterId")!;
  for (let i = 0; i < v.slotCount; i++) { items[i] = v.item(i); counts[i] = v.count(i); created[i] = v.created(i); dur[i] = v.durability(i); cr[i] = v.crafter(i); }
  st.data.weight[st.slot(idx)] = slotsWeight(v, defs);
  st.markChanged(idx);
}
export const spoilMulOf = (world: World, e: Entity): number => world.getField(e, slotsDef(world, e), "spoilMul") ?? 1;

export function slotsWeight(v: SlotView, defs: GameDefs): number {
  let w = 0;
  for (let i = 0; i < v.slotCount; i++) { const id = v.item(i); if (id !== 0) w += (defs.items.get(id)?.weight ?? 0) * v.count(i); }
  return w;
}
export function slotsCount(v: SlotView, item: number): number {
  let n = 0; for (let i = 0; i < v.slotCount; i++) if (v.item(i) === item) n += v.count(i); return n;
}
/** Max units of `item` that fit (slots and weight), capped at `count`. */
export function slotsCanAdd(v: SlotView, item: number, count: number, defs: GameDefs, crafter = 0): number {
  const def = defs.items.get(item); if (!def || count <= 0) return 0;
  let space = 0;
  for (let i = 0; i < v.addLimit && space < count; i++) {
    const id = v.item(i);
    if (id === item && v.crafter(i) === crafter) space += Math.max(0, def.maxStack - v.count(i));
    else if (id === 0) space += def.maxStack;
  }
  let fit = Math.min(space, count);
  if (v.maxWeight > 0 && def.weight > 0) {
    const free = v.maxWeight - slotsWeight(v, defs);
    fit = Math.min(fit, Math.max(0, Math.floor(free / def.weight + 1e-9)));
  }
  return fit;
}
/** Adds with an effective created tick (merged stacks average by count). */
export function slotsAdd(v: SlotView, item: number, count: number, defs: GameDefs, created = 0, durability = defs.items.get(item)?.maxDurability ?? 0, crafter = 0): number {
  const def = defs.items.get(item); if (!def) return 0;
  const total = slotsCanAdd(v, item, count, defs, crafter);
  let left = total;
  for (let i = 0; i < v.addLimit && left > 0; i++) {
    if (v.item(i) !== item || v.crafter(i) !== crafter) continue;
    const c0 = v.count(i); const n = Math.min(left, def.maxStack - c0);
    if (n > 0) { v.put(i, item, c0 + n, Math.round((v.created(i) * c0 + created * n) / (c0 + n)), Math.min(v.durability(i), durability), crafter); left -= n; }
  }
  for (let i = 0; i < v.addLimit && left > 0; i++) {
    if (v.item(i) !== 0) continue;
    const n = Math.min(left, def.maxStack); v.put(i, item, n, created, durability, crafter); left -= n;
  }
  return total - left;
}
/** All-or-nothing; returns the removed (count, created) parts (highest slot first) or null. */
export interface SlotPart { count: number; created: number; durability: number; crafter: number }
export function slotsTake(v: SlotView, item: number, count: number): SlotPart[] | null {
  if (count <= 0) return [];
  if (slotsCount(v, item) < count) return null;
  const parts: SlotPart[] = []; let left = count;
  for (let i = v.slotCount - 1; i >= 0 && left > 0; i--) {
    if (v.item(i) !== item) continue;
    const n = Math.min(left, v.count(i)); parts.push({ count: n, created: v.created(i), durability: v.durability(i), crafter: v.crafter(i) }); v.put(i, item, v.count(i) - n); left -= n;
  }
  return parts;
}
export function slotsRemove(v: SlotView, item: number, count: number): boolean { return slotsTake(v, item, count) !== null; }

/** created tick re-based from spoil multiplier `fromMul` to `toMul` keeping freshness at `now`. */
export function rebaseCreated(created: number, now: number, fromMul: number, toMul: number): number {
  if (toMul <= 0 || fromMul === toMul) return created;
  return Math.max(0, Math.round(now - (now - created) * (fromMul / toMul)));
}

// ---- world-level API ---------------------------------------------------------------------------

/**
 * Task 25: the paint brush must sit in the hotbar (slots PACK_SLOTS..PACK_SLOTS+7), not just anywhere in the
 * pack — dyeing and painting are hotbar-tool actions, like equipping a tool. A brush in the pack does not count.
 * Pure (reads only), so the client UI can gate the Paint / Dye buttons on the same rule the server enforces.
 */
export function hasBrushInHotbar(world: World, e: Entity): boolean {
  let brush = 0; try { brush = gameplayDefs(world).itemId("paint_brush"); } catch { return false; }
  if (!brush) return false;
  for (let s = PACK_SLOTS; s < PACK_SLOTS + 8; s++) { try { if (slotItem(world, e, s).item === brush) return true; } catch { return false; } }
  return false;
}
/** Task 25: does the entity carry at least one dye (any slot)? */
export function hasDye(world: World, e: Entity): boolean {
  let dye = 0; try { dye = gameplayDefs(world).itemId("dye"); } catch { return false; }
  if (!dye) return false;
  try { return countItem(world, e, dye) > 0; } catch { return false; }
}

export function countItem(world: World, e: Entity, item: number): number {
  const L = liveSlotCount(world, e); if (!L) throw new Error("entity has no Inventory or Container");
  const st = world.store(L.def); let c = 0; for (let i = 0; i < L.n; i++) if (st.readElement(L.idx, "items", i) === item) c += st.readElement(L.idx, "counts", i) ?? 0; return c; // ADR-212: no copy
}
export function canAddItem(world: World, e: Entity, item: number, count: number): number {
  return slotsCanAdd(readSlots(world, e), item, count, gameplayDefs(world));
}
/** Adds up to `count` fresh units (created = now, crafterId = `crafter`, 0 = gathered); returns how many were added. */
export function addItem(world: World, e: Entity, item: number, count: number, crafter = 0): number {
  const defs = gameplayDefs(world); const v = readSlots(world, e);
  const n = slotsAdd(v, item, count, defs, world.tick, undefined, crafter); if (n > 0) writeSlots(world, e, v, defs); return n;
}
/** All-or-nothing. */
export function removeItem(world: World, e: Entity, item: number, count: number): boolean {
  const defs = gameplayDefs(world); const v = readSlots(world, e);
  if (!slotsRemove(v, item, count)) return false;
  writeSlots(world, e, v, defs); return true;
}
/** Moves up to `count` of `item` between holders (preserving freshness across different spoil multipliers). */
export function transferItem(world: World, from: Entity, to: Entity, item: number, count: number): number {
  if (from === to) return 0;
  const defs = gameplayDefs(world);
  const a = readSlots(world, from); const b = readSlots(world, to);
  const fm = spoilMulOf(world, from), tm = spoilMulOf(world, to);
  let left = Math.min(count, slotsCount(a, item)), moved = 0;
  // highest slot first, part by part (each part keeps its crafter); stops at the first part that doesn't fully fit
  for (let i = a.slotCount - 1; i >= 0 && left > 0; i--) {
    if (a.item(i) !== item) continue;
    const want = Math.min(left, a.count(i)); const n = Math.min(want, slotsCanAdd(b, item, want, defs, a.crafter(i)));
    if (n <= 0) continue;
    slotsAdd(b, item, n, defs, rebaseCreated(a.created(i), world.tick, fm, tm), a.durability(i), a.crafter(i));
    a.put(i, item, a.count(i) - n); left -= n; moved += n;
  }
  const n = moved; if (n <= 0) return 0;
  writeSlots(world, from, a, defs); writeSlots(world, to, b, defs);
  return n;
}
/**
 * Atomically removes `take` and adds `give` (fresh). Returns false (and changes nothing) if any ingredient is
 * missing or any output does not fully fit after the removal.
 */
export function exchangeItems(world: World, e: Entity, take: readonly ItemCount[], give: readonly ItemCount[], dryRun = false, crafter = 0): boolean {
  const defs = gameplayDefs(world); const v = readSlots(world, e);
  for (const t of take) if (!slotsRemove(v, t.item, t.count)) return false;
  for (const g of give) if (slotsAdd(v, g.item, g.count, defs, world.tick, undefined, crafter) !== g.count) return false;
  if (!dryRun) writeSlots(world, e, v, defs);
  return true;
}
export function slotItem(world: World, e: Entity, slot: number): { item: number; count: number } {
  const L = liveSlotCount(world, e); if (!L) throw new Error("entity has no Inventory or Container"); // ADR-212: no ScratchSlots copy
  if (slot < 0 || slot >= L.n) return { item: 0, count: 0 };
  const st = world.store(L.def); const item = st.readElement(L.idx, "items", slot) ?? 0;
  return { item, count: item ? st.readElement(L.idx, "counts", slot) ?? 0 : 0 };
}
/** Removes one unit from a specific slot. */
export function takeFromSlot(world: World, e: Entity, slot: number): number {
  const defs = gameplayDefs(world); const v = readSlots(world, e);
  if (slot >= v.slotCount || v.count(slot) === 0) return 0;
  const item = v.item(slot); v.put(slot, item, v.count(slot) - 1); writeSlots(world, e, v, defs); return item;
}
/** Freshness 0..1 of a slot (1 for items that never spoil). */
export function slotFreshness(world: World, e: Entity, slot: number): number {
  const v = readSlots(world, e); if (slot >= v.slotCount || !v.item(slot)) return 1;
  return freshness(gameplayDefs(world), v.item(slot), v.created(slot), spoilMulOf(world, e), world.tick, 1 / 20);
}
export function freshness(defs: GameDefs, item: number, created: number, spoilMul: number, tick: number, dt: number): number {
  const sec = defs.items.get(item)?.spoilSeconds ?? 0; if (sec <= 0) return 1;
  return decayAt(created, (dt / sec) * spoilMul, tick);
}
/** Debug/UI view: non-empty slots. */
export interface SlotTuple { slot: number; item: number; count: number; created: number; durability: number; crafterId: number }
export function listSlots(world: World, e: Entity): SlotTuple[] {
  const L = liveSlotCount(world, e); if (!L) throw new Error("entity has no Inventory or Container"); const st = world.store(L.def); const { idx, n } = L; const out: SlotTuple[] = [];
  for (let i = 0; i < n; i++) { const item = st.readElement(idx, "items", i) ?? 0; if (item !== 0) out.push({ slot: i, item, count: st.readElement(idx, "counts", i) ?? 0, created: st.readElement(idx, "createdTick", i) ?? 0, durability: st.readElement(idx, "durability", i) ?? 0, crafterId: st.readElement(idx, "crafterId", i) ?? 0 }); }
  return out;
}
/** Low-level: rewrite every slot through fn (used by spoilage re-basing / conversion). */
export function mapSlots(world: World, e: Entity, fn: (v: ScratchSlots) => boolean): void {
  const v = readSlots(world, e); if (fn(v)) writeSlots(world, e, v, gameplayDefs(world));
}

/**
 * Moves whole slot tuples (item, count, createdTick, durability) from one holder to another, all-or-nothing:
 * `moves` reference source slot indices + counts (trade offers, loot). Re-validates tuples at commit (item ids
 * must match `expect` if given). Returns false and changes nothing if anything does not fit or changed.
 */
export function moveSlotTuples(world: World, from: Entity, to: Entity, moves: readonly { slot: number; count: number; item?: number }[]): boolean {
  const defs = gameplayDefs(world); const a = readSlots(world, from); const b = readSlots(world, to);
  const fm = spoilMulOf(world, from), tm = spoilMulOf(world, to);
  for (const m of moves) {
    const item = a.item(m.slot); if (!item || a.count(m.slot) < m.count || (m.item !== undefined && m.item !== item) || m.count <= 0) return false;
    const created = a.created(m.slot), dur = a.durability(m.slot), cr = a.crafter(m.slot);
    a.put(m.slot, item, a.count(m.slot) - m.count);
    if (slotsAdd(b, item, m.count, defs, rebaseCreated(created, world.tick, fm, tm), dur, cr) !== m.count) return false;
  }
  writeSlots(world, from, a, defs); writeSlots(world, to, b, defs); return true;
}

/** ADR-289: selection survives consuming the final item and is independent of drawn equipment. */
export function setHotbarSelection(world: World, e: Entity, slot: number): void {
  if (slot < HOTBAR_OFFSET || slot >= HOTBAR_OFFSET + 8) return;
  if (!world.has(e, HotbarSelection)) world.add(e, HotbarSelection);
  world.setField(e, HotbarSelection, "slot", slot);
}
