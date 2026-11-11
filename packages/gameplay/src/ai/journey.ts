/**
 * ADR-344: distance-based journey preparation for AI humans. Pure planning leaf (like defence_plan.ts):
 * it imports only data JSON, the planner's static index, inventory reads and the storage-permission
 * rule — never base_behaviors / input.ts — so travel.ts can use it without an import cycle.
 *
 *   - Estimate: route length (round trip for a resource expedition, one way otherwise) at the
 *     off-screen speeds (travel.json: 2.6 tiles/s on foot, 5.4 mounted — a bot with an own mount
 *     rides long legs, ADR-321 mountPolicy) plus budgeted rest stops. Rests are budgeted time in
 *     the estimate, not scheduled stops: the off-screen sim walks continuously.
 *   - Pack: food / water sized to the trip from the vitals.json drain rates (hunger 0.05/s,
 *     thirst 0.08/s) times safetyMargin, taken from storage only above the data reserve (the
 *     ADR-338/341 discipline: a per-item reserve floor, defaultReserve for any unlisted food /
 *     water kind, so the base is never starved) and never an item the planner still needs
 *     (its gather leaves). Gear is the tool the trip's target resource needs (ADR-343: iron
 *     needs a tier-2 pickaxe — the planner backward-chains the bronze chain first, so a bot
 *     must not set out for iron without the means to gather it): the lowest adequate tier the
 *     bot does not already carry, from storage — and the trip waits while the planner is still
 *     working that chain (requiredToolChain / stepTargetsToolChain), instead of departing
 *     without the tool. What the bag already holds counts toward the need first.
 *   - Turn-back: provisions are hunger / thirst points the bot carries. Off-screen they drain
 *     with the miles; when either hits zero the bot turns back toward home (or the trip origin
 *     when it has no base) instead of pressing on. The off-screen needsFloor (50) stays as the
 *     survival last resort — abstract foraging keeps the bot alive at 50 — but it is not the
 *     plan: it does not let the bot continue. In full sim the bot eats and drinks from its bag
 *     en route (the eat / drink behaviours) and gathers food nodes when they are close enough
 *     for gather to win arbitration; the turn-back is the backstop when the bag is empty of a
 *     kind and that need is low.
 */
import { type Entity, type World } from "@engine/core";
import { readSlots } from "../inventory.js";
import { StationKind, ToolKind, type GameDefs, type ItemDef } from "../defs.js";
import { plannerIndex, type Step } from "./planner.js";
import travelRaw from "../../data/travel.json";
import vitalsRaw from "../../data/vitals.json";
import raw from "../../data/ai_journey.json";

/** Tuning knobs (data/ai_journey.json); code reads them, never hardcodes them. */
export interface JourneyData {
  minPrepTiles: number; packRadiusTiles: number; safetyMargin: number;
  restEverySeconds: number; restSeconds: number; longTripTiles: number;
  departMinHunger: number; departMinThirst: number; turnBackHunger: number; turnBackThirst: number;
  prepDeadlineTicks: number; journeyRetryCooldownTicks: number; defaultReserve: number;
  reserve: Record<string, number>;
}
export const JOURNEY_DATA: JourneyData = raw as unknown as JourneyData;
/** Provisions a trip carries: hunger / thirst points in the bag at departure (bag + packed). */
export interface JourneyState { food: number; water: number; estTicks: number; prepared: boolean }
export interface JourneyEstimate { tiles: number; seconds: number; ticks: number; restStops: number; riding: boolean }

/** Route length in tiles, from `from` through every waypoint (the last is the exact goal). */
export function routeTiles(route: readonly { x: number; y: number }[], from: { x: number; y: number }): number {
  let tiles = 0, px = from.x, py = from.y;
  for (const wp of route) { tiles += Math.hypot(wp.x - px, wp.y - py); px = wp.x; py = wp.y; }
  return tiles;
}
/** Trip duration at the off-screen speed (mounted or on foot) plus one rest stop per restEverySeconds of travel. */
export function estimateJourney(tiles: number, riding: boolean, data: JourneyData = JOURNEY_DATA): JourneyEstimate {
  const speed = riding ? travelRaw.offscreen.mountSpeedTilesPerSec : travelRaw.offscreen.speedTilesPerSec;
  const travelSeconds = tiles / speed;
  const restStops = Math.floor(travelSeconds / data.restEverySeconds);
  const seconds = travelSeconds + restStops * data.restSeconds;
  return { tiles, seconds, ticks: Math.ceil(seconds * 20), restStops, riding };
}
/** Hunger / thirst points the trip burns, with the safety margin (vitals.json drain rates). */
export function journeyNeeds(est: JourneyEstimate, data: JourneyData = JOURNEY_DATA): { hunger: number; thirst: number } {
  return { hunger: est.seconds * vitalsRaw.hungerDecayPerSec * data.safetyMargin, thirst: est.seconds * vitalsRaw.thirstDecayPerSec * data.safetyMargin };
}
/** Will this bot ride the trip (already riding, or an own mount it will mount for a long leg — the ADR-321
 *  mountPolicy rule, minus the fetch-radius detail, which the estimate does not need to be exact about:
 *  assuming a ride that never happens only under-packs, and the turn-back is the safety net). */
export function willRide(mount: { riding?: boolean; busy?: boolean } | undefined, mountSkill: boolean | undefined, tiles: number, data: JourneyData = JOURNEY_DATA): boolean {
  if (!mount) return false;
  if (mount.riding) return true;
  return !!mountSkill && !mount.busy && tiles > data.longTripTiles;
}

// ---- bag reads -----------------------------------------------------------------------------------------------------
/** Hunger / thirst points one unit of `item` carries (a water container's whole food value, drunk a sip at a time). */
export const foodPointsOf = (defs: GameDefs, item: number): { hunger: number; thirst: number } => {
  const f = defs.items.get(item)?.food;
  return { hunger: Math.max(0, f?.hunger ?? 0), thirst: Math.max(0, f?.thirst ?? 0) };
};
const edible = (defs: GameDefs, item: number): boolean => (defs.items.get(item)?.food?.health ?? -1) >= 0;
/** Live bag counts (a bare world with no inventory reads as empty). */
export function bagCounts(world: World, self: Entity): Map<number, number> {
  const out = new Map<number, number>();
  try {
    const sl = readSlots(world, self);
    for (let i = 0; i < sl.items.length; i++) { const it = sl.items[i]!; if (it && sl.counts[i]) out.set(it, (out.get(it) ?? 0) + sl.counts[i]!); }
  } catch { /* no inventory: empty */ }
  return out;
}
/** What the bag carries now: hunger / thirst points (healthy food only — the eat behaviour skips health<0
 *  food, so raw meat is not provisions) and how many food / water units are in it. */
export function bagPoints(world: World, self: Entity, defs: GameDefs): { hunger: number; thirst: number; foodUnits: number; waterUnits: number } {
  const out = { hunger: 0, thirst: 0, foodUnits: 0, waterUnits: 0 };
  for (const [item, n] of bagCounts(world, self)) {
    if (!edible(defs, item)) continue;
    const p = foodPointsOf(defs, item);
    out.hunger += n * p.hunger; out.thirst += n * p.thirst;
    if (p.hunger > 0) out.foodUnits += n; if (p.thirst > 0) out.waterUnits += n;
  }
  return out;
}
/** Free bag slots (the pack must fit: one slot per new kind, plus a slot per full stack over). */
export function freeBagSlots(world: World, self: Entity): number {
  try { const v = readSlots(world, self); let n = 0; for (let i = 0; i < v.addLimit; i++) if (!v.item(i) || !v.count(i)) n++; return n; }
  catch { return 0; }
}

// ---- gear ----------------------------------------------------------------------------------------------------------
/** Tool kinds + tiers a trip to gather `items` needs (plannerIndex's >= 0.15 node rule, like the
 *  planner's own leaves): the LOWEST tier of any node kind that yields them — the planner's
 *  gatherLeaf prefers the lowest-tier usable node, so the leaf exists because that tier works.
 *  (When the destination node is known — a resource expedition records it — toolsForNodeKinds
 *  below is exact instead: the nearest node may be a higher-tier kind of the same item.) */
export function requiredToolsFor(defs: GameDefs, items: readonly number[]): { kind: ToolKind; tier: number }[] {
  const ix = plannerIndex(defs); const out = new Map<ToolKind, number>();
  for (const it of items) for (const nd of ix.nodes.get(it) ?? []) {
    if (nd.requiredTool === ToolKind.None) continue;
    out.set(nd.requiredTool, Math.min(out.get(nd.requiredTool) ?? Infinity, nd.minTier));
  }
  return [...out].map(([kind, tier]) => ({ kind, tier })).sort((a, b) => a.kind - b.kind);
}
/** Tool kinds + tiers the given node kinds (resource-def ids) need, straight from the defs. */
export function toolsForNodeKinds(defs: GameDefs, kinds: readonly number[]): { kind: ToolKind; tier: number }[] {
  const out = new Map<ToolKind, number>();
  for (const k of kinds) {
    const nd = defs.resources.get(k); if (!nd || nd.requiredTool === ToolKind.None) continue;
    out.set(nd.requiredTool, Math.max(out.get(nd.requiredTool) ?? 0, nd.minTier));
  }
  return [...out].map(([kind, tier]) => ({ kind, tier })).sort((a, b) => a.kind - b.kind);
}
/** The tool item (lowest adequate tier, the planner's obtainTool choice) for one required kind/tier, or undefined. */
const toolFor = (defs: GameDefs, kind: ToolKind, tier: number): ItemDef | undefined =>
  plannerIndex(defs).tools.find((d) => d.tool!.kind === kind && d.tool!.tier >= tier && plannerIndex(defs).reachable.has(d.id));
/** Required tool item ids the bot has in NEITHER its bag nor the given storage: setting out without them
 *  is a wasted trip (the node cannot be worked). When the destination node kinds are known they decide
 *  the tier exactly; otherwise the lowest tier any node yielding the items needs. A kind with no
 *  reachable tool at all reports -1. */
export function missingGear(defs: GameDefs, items: readonly number[], bag: ReadonlyMap<number, number>, storage: ReadonlyMap<number, number> | undefined, nodeKinds?: readonly number[] | undefined): number[] {
  const has = (m: ReadonlyMap<number, number> | undefined, kind: ToolKind, tier: number): boolean => {
    if (!m) return false;
    for (const [id, n] of m) { const t = defs.items.get(id)?.tool; if (n > 0 && t?.kind === kind && t.tier >= tier) return true; }
    return false;
  };
  const out: number[] = [];
  const tools = nodeKinds?.length ? toolsForNodeKinds(defs, nodeKinds) : requiredToolsFor(defs, items);
  for (const { kind, tier } of tools) {
    if (has(bag, kind, tier) || has(storage, kind, tier)) continue;
    out.push(toolFor(defs, kind, tier)?.id ?? -1);
  }
  return out;
}

/** The tool a trip needs, with its make chain: the lowest adequate tool item (the planner's
 *  obtainTool choice), every item id in its recipe closure (the tool + each ingredient,
 *  recursively — a gatherable ingredient is what the planner's leaves hold while the bot works
 *  the chain), and the station kinds the chain's recipes need (building one is a build step).
 *  Undefined when the trip needs no tool (bare hands) or no tool of the tier is reachable at
 *  all — the planner blocks that gather goal itself, so there is no chain to wait for. */
export interface ToolChain { tool: number; items: Set<number>; stations: Set<number> }
export function requiredToolChain(defs: GameDefs, items: readonly number[], nodeKinds?: readonly number[] | undefined): ToolChain | undefined {
  const tools = nodeKinds?.length ? toolsForNodeKinds(defs, nodeKinds) : requiredToolsFor(defs, items);
  const first = tools[0]; if (!first) return undefined;
  const tool = toolFor(defs, first.kind, first.tier); if (!tool) return undefined;
  const ix = plannerIndex(defs);
  const chain: ToolChain = { tool: tool.id, items: new Set([tool.id]), stations: new Set() };
  // Follow the planner's own obtain(): a gatherable ingredient is a leaf (its recipes are never expanded —
  // the bot gathers it), so only craft-only items expand, via the first recipe whose ingredients are all
  // statically reachable (the planner's choice — expanding every alternative recipe would pull in
  // tinder / thatch for fiber and the like, which the planner never crafts while fiber grass exists).
  for (let round = 0; round < 8; round++) {
    let grew = false;
    for (const item of [...chain.items]) {
      if ((ix.nodes.get(item)?.length ?? 0) > 0) continue; // gatherable: a leaf, not a make
      const r = (ix.recipes.get(item) ?? []).find((x) => x.ingredients.every((g) => ix.reachable.has(g.item)));
      if (!r) continue;
      if (r.station !== StationKind.None && !chain.stations.has(r.station)) { chain.stations.add(r.station); grew = true; }
      for (const g of r.ingredients) if (!chain.items.has(g.item)) { chain.items.add(g.item); grew = true; }
    }
    if (!grew) break;
  }
  return chain;
}
/** True when the planner's current step is work on the tool chain: withdrawing the tool or a
 *  part, crafting the tool or a part, or building a station the chain needs. (Gathering a chain
 *  ingredient leaves no step — it lands in plan.leaves, checked by the caller.) */
export function stepTargetsToolChain(defs: GameDefs, step: Step | undefined, chain: ToolChain): boolean {
  if (!step) return false;
  if (step.k === "withdraw") return chain.items.has(step.item);
  if (step.k === "craft") return chain.items.has(defs.recipes.get(step.recipe)?.output.item ?? -1);
  if (step.k === "build") { const st = defs.pieces.get(step.piece)?.station ?? StationKind.None; return st !== StationKind.None && chain.stations.has(st); }
  return false;
}

// ---- the pack ------------------------------------------------------------------------------------------------------
export interface PackItem { item: number; count: number }
export interface JourneyPack {
  food: PackItem[]; water: PackItem[]; gear: PackItem[];
  /** Hunger / thirst points the bot will carry (bag + packed). */
  hunger: number; thirst: number;
  /** True when what the bot will carry covers the estimated need, gear included. */
  prepared: boolean;
}
export interface PlanJourneyPackInput {
  /** The trip's target item ids (a resource expedition): gear is packed for these. */
  targetItems?: readonly number[] | undefined;
  /** The destination node kinds (resource-def ids), when known: gear is packed for these exactly
   *  (a resource expedition records the prospected node's kind on the travel state). */
  nodeKinds?: readonly number[] | undefined;
  /** The planner's gather leaves: never packed — the ladder eats first (the ADR-338 discipline). */
  leaves?: ReadonlySet<number>;
  /** Free bag slots the pack must fit in. */
  freeSlots?: number;
}
/**
 * What to take from storage for this trip (pure: bag + storage counts in, pack list out). Food and
 * water cover the estimated need from what the bag already holds first, then the highest-value
 * healthy items in storage — a food that makes the bot thirstier (bread, jerky) is never packed —
 * taking only the surplus above the data reserve (per-item, else defaultReserve for any food /
 * water kind, so the base keeps its last meal). Gear is the required tool the bag lacks, lowest
 * adequate tier, one each. An item on the planner's leaves is never taken. The pack is capped by
 * free bag slots (a new kind needs a slot; a count over its stack room needs more).
 */
export function planJourneyPack(defs: GameDefs, est: JourneyEstimate, bag: ReadonlyMap<number, number>, storage: ReadonlyMap<number, number> | undefined, opts: PlanJourneyPackInput = {}, data: JourneyData = JOURNEY_DATA): JourneyPack {
  const need = journeyNeeds(est, data);
  const leaves = opts.leaves ?? new Set<number>();
  let haveHunger = 0, haveThirst = 0;
  for (const [item, n] of bag) { if (!edible(defs, item)) continue; const p = foodPointsOf(defs, item); haveHunger += n * p.hunger; haveThirst += n * p.thirst; }
  const reserveFor = (key: string): number => data.reserve[key] ?? data.defaultReserve;
  let free = opts.freeSlots ?? 0;
  /** Trim a pick to what fits in the remaining free slots (0 = does not fit at all): a count that
   *  tops up a bag stack needs no slot, each full stack over needs one. */
  const fit = (item: number, count: number): number => {
    const max = defs.items.get(item)?.maxStack ?? 1;
    const inBag = bag.get(item) ?? 0;
    const room = inBag > 0 ? Math.max(0, max - inBag) : 0; // a kind not carried yet needs a free slot per stack
    const fitted = Math.min(count, room + free * max);
    if (fitted > room) free -= Math.ceil((fitted - room) / max);
    return Math.max(0, fitted);
  };
  const pack: JourneyPack = { food: [], water: [], gear: [], hunger: haveHunger, thirst: haveThirst, prepared: false };
  // gear first: the trip is pointless without it, and it is one slot per tool
  let gearOk = true;
  {
    const tools = opts.nodeKinds?.length ? toolsForNodeKinds(defs, opts.nodeKinds)
      : opts.targetItems?.length ? requiredToolsFor(defs, opts.targetItems) : [];
    for (const { kind, tier } of tools) {
      const inBag = [...bag].some(([id, n]) => n > 0 && defs.items.get(id)?.tool?.kind === kind && defs.items.get(id)!.tool!.tier >= tier);
      if (inBag) continue;
      const tool = toolFor(defs, kind, tier);
      if (!tool || !storage || (storage.get(tool.id) ?? 0) <= 0 || leaves.has(tool.id)) { gearOk = false; continue; }
      const n = fit(tool.id, 1); if (n <= 0) { gearOk = false; continue; }
      pack.gear.push({ item: tool.id, count: 1 });
    }
  }
  // food, then water: highest value first (fewest items, fewest slots); a food pick's thirst counts too
  const pick = (want: "hunger" | "thirst", have: number, taken: PackItem[]): number => {
    if (!storage || have >= need[want]) return have;
    const cands: { item: number; value: number; surplus: number }[] = [];
    for (const [item, n] of storage) {
      const d = defs.items.get(item); if (!d?.food || d.food.health < 0 || leaves.has(item)) continue;
      const value = want === "hunger" ? d.food.hunger : d.food.thirst;
      if (value <= 0) continue;
      if (want === "hunger" && d.food.thirst < 0) continue; // never pack food that makes the bot thirstier
      if (taken.some((t) => t.item === item)) continue;
      const surplus = n - reserveFor(d.key); if (surplus <= 0) continue;
      cands.push({ item, value, surplus });
    }
    cands.sort((a, b) => b.value - a.value || a.item - b.item);
    let h = have;
    for (const c of cands) {
      if (h >= need[want]) break;
      const wantN = Math.ceil((need[want] - h) / c.value);
      const n = fit(c.item, Math.min(c.surplus, wantN)); if (n <= 0) continue;
      const d = defs.items.get(c.item)!;
      taken.push({ item: c.item, count: n });
      h += n * (want === "hunger" ? d.food!.hunger : d.food!.thirst);
      if (want === "hunger") pack.thirst += n * Math.max(0, d.food!.thirst);
      else pack.hunger += n * Math.max(0, d.food!.hunger);
    }
    return h;
  };
  pack.hunger = pick("hunger", pack.hunger, pack.food);
  pack.thirst = pick("thirst", pack.thirst, pack.water);
  pack.prepared = gearOk && pack.hunger >= need.hunger && pack.thirst >= need.thirst;
  return pack;
}

// ---- departure gate + turn-back ------------------------------------------------------------------------------------
/** Fit to set out: fed, watered and warm. The thresholds mirror autonomy's hungry cutoffs (55 / 60),
 *  so a bot the planner wants to feed first (the cook pre-goal) never prepares instead. */
export function canPrepareJourney(hunger: number, thirst: number, cold: boolean, data: JourneyData = JOURNEY_DATA): boolean {
  return !cold && hunger >= data.departMinHunger && thirst >= data.departMinThirst;
}
/** Full-sim backstop: the bag is empty of a kind and that need is low — turn back instead of
 *  pressing on to starve. (hunger / thirst here are 0..100, like Survival.) */
export function shouldTurnBack(bagFoodUnits: number, bagWaterUnits: number, hunger: number, thirst: number, data: JourneyData = JOURNEY_DATA): boolean {
  return (bagFoodUnits <= 0 && hunger < data.turnBackHunger) || (bagWaterUnits <= 0 && thirst < data.turnBackThirst);
}
/** Provisions left after `ticks` ticks off-screen (drain rates from vitals.json, per second). */
export function drainProvisions(journey: { food: number; water: number }, ticks: number, tickHz = 20): { food: number; water: number } {
  const secs = ticks / tickHz;
  return { food: journey.food - secs * vitalsRaw.hungerDecayPerSec, water: journey.water - secs * vitalsRaw.thirstDecayPerSec };
}
/** True when a provision the bot was carrying has run out off-screen: a kind that started this step
 *  above zero is now at or below zero. A kind that was never carried (zero from the start — the bot
 *  forages for it under the needsFloor) does not turn the bot back: a 0/0 record is an unprepared
 *  departure, not an exhaustion, and must not turn a return leg straight back. */
export const provisionsExhausted = (before: { food: number; water: number }, after: { food: number; water: number }): boolean =>
  (before.food > 0 && after.food <= 0) || (before.water > 0 && after.water <= 0);
