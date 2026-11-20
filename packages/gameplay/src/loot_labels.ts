/**
 * ADR-161 world labels for loot bags / dropped items. Container contents only replicate to viewers, so the server
 * keeps a tiny networked LootSummary (top item, its count, stack count, source) on every LootBag; clients turn it
 * into a floating label (range-limited, merged when crowded) with the Interact prompt for the active device.
 */
import type { Entity, World } from "@engine/core";
import { Container, LootBag, LootSummary } from "./components.js";
import { isAuthority } from "./config.js";
import { listSlots } from "./inventory.js";

export const LootSource = { Unknown: 0, Zombie: 1, Animal: 2, Death: 3, Dropped: 4, Crate: 5, Placed: 6 } as const; // ADR-481: a liquid container placed on the ground (permanent bag)
export type LootSourceId = (typeof LootSource)[keyof typeof LootSource];
/** Server recompute period (ticks) for LootSummary; also refreshed when first seen. */
export const LOOT_SUMMARY_EVERY = 10;
/** Client label tuning: show within this many tiles, cap the count, merge closer than mergePx on screen. */
export const LOOT_LABEL = { range: 12, max: 14, mergePx: 46 } as const;

/** Tag a freshly created bag with where it came from (summary contents fill in on the next summary pass). */
export function tagLootSource(world: World, bag: Entity, source: LootSourceId): void {
  if (!world.has(bag, LootSummary)) world.add(bag, LootSummary, { item: 0, count: 0, stacks: 0, source });
  else world.set(bag, LootSummary, { source });
  writeLootSummary(world, bag);
}
/** Recompute one bag's summary from its Container (authority). Unset source is inferred: permanent ownerless = crate. */
export function writeLootSummary(world: World, bag: Entity): void {
  if (!world.has(bag, Container)) return;
  const totals = new Map<number, number>(); let stacks = 0;
  for (const s of listSlots(world, bag)) if (s.item && s.count) { stacks++; totals.set(s.item, (totals.get(s.item) ?? 0) + s.count); }
  let item = 0, count = 0; for (const [k, n] of totals) if (n > count || (n === count && k < item)) { item = k; count = n; }
  const next = { item, count: Math.min(count, 0xffff), stacks: Math.min(stacks, 255) };
  const cur = world.get(bag, LootSummary);
  if (!cur) {
    const lb = world.get(bag, LootBag);
    // ADR-238: LootBag.kind persists the source (labels survive a restart); legacy bags: permanent ownerless = crate
    const source = lb?.kind ? lb.kind : lb && lb.despawnAtTick === 0xffffffff && !lb.owner ? LootSource.Crate : LootSource.Unknown;
    world.add(bag, LootSummary, { ...next, source }); return;
  }
  if (cur.item !== next.item || cur.count !== next.count || cur.stacks !== next.stacks) world.set(bag, LootSummary, next);
}
/** postSim "gameplay.lootSummary" (every LOOT_SUMMARY_EVERY ticks); new bags are summarised at creation (tagLootSource). */
export function lootSummarySystem(world: World): void {
  if (!isAuthority(world) || world.isReplaying) return;
  for (const b of world.query([LootBag])) writeLootSummary(world, b); // scheduled every LOOT_SUMMARY_EVERY ticks
}

/** Label text for a summary. itemName resolves an item id; mine = the local player owns it. */
export function lootLabelText(s: { item: number; count: number; stacks: number; source: number }, itemName: (id: number) => string | undefined, mine = false): string {
  if (s.source === LootSource.Death) return mine ? "Your bag" : "Death bag";
  if (s.source === LootSource.Zombie) return "Zombie loot";
  if (s.source === LootSource.Crate) return "Supply crate";
  const name = s.item ? itemName(s.item) : undefined;
  if (s.stacks === 1 && name) return s.count > 1 ? `${name} ×${s.count}` : name;
  if (s.source === LootSource.Animal) return name ? `${name} +${s.stacks - 1}` : "Loot";
  return name && s.stacks > 1 ? `${name} +${s.stacks - 1} more` : "Loot";
}

export interface LabelPoint { key: number; x: number; y: number; dist: number; text: string }
export interface MergedLabel { x: number; y: number; dist: number; text: string; keys: number[] }
/** Declutter: nearest first, any label within mergePx (screen) of an already placed one merges into it
 *  ("Loot ×3 bags" style suffix); at most `max` labels survive. Pure + deterministic for tests. */
export function mergeLabels(pts: readonly LabelPoint[], mergePx: number = LOOT_LABEL.mergePx, max: number = LOOT_LABEL.max): MergedLabel[] {
  const out: MergedLabel[] = []; const r2 = mergePx * mergePx;
  for (const p of [...pts].sort((a, b) => a.dist - b.dist || a.key - b.key)) {
    const hit = out.find((o) => (o.x - p.x) ** 2 + (o.y - p.y) ** 2 < r2);
    if (hit) { hit.keys.push(p.key); continue; }
    if (out.length < max) out.push({ x: p.x, y: p.y, dist: p.dist, text: p.text, keys: [p.key] });
  }
  for (const o of out) if (o.keys.length > 1) o.text = `${o.text} (+${o.keys.length - 1} bag${o.keys.length > 2 ? "s" : ""})`;
  return out;
}
