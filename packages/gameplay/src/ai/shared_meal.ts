/**
 * ADR-446: shared meals at the hearth (Task 37 realism slice 6).
 *
 * Root cause (audit 2026-11-19, base 8616271): bots eat alone from their own bags. The `eat`
 * behavior and `instantChores` fire `eat:<slot>` wherever the bot happens to stand the moment
 * hunger drops, and no sensor ever looked at clanmates, the hearth, or the shared store — so two
 * hungry clanmates by the same campfire with food in the base box still ate alone, wherever they
 * were. The `cook` pre-goal, the `socialize` want and the clan behaviours already exist; this
 * layer only decides *where* and *with whom* eating happens and *whose* food it is.
 *
 * Scheduling (who cooks, whose food, accounting):
 * - A meal pends when the bot is hungry (or peckish at dusk, or starving at any phase), a hearth
 *   (view.fire) exists, and at least one clanmate or party mate is in the clan/party. Solo bots
 *   are untouched: no mates, no meal, lone eating exactly as before.
 * - Who cooks: the bot that arrives at the hearth holding cookable raw (a single-ingredient
 *   campfire roast: raw_meat -> cooked_meat, fish -> cooked_fish) while no ready food is in any
 *   bag or in the shared store. It waits by the fire; the planner's existing `cook` pre-goal
 *   does the actual raw -> cooked conversion (this layer never crafts). Raw meat/fish are never
 *   eaten raw at a meal (health < 0, same rule fillAgentSensors uses for view.food).
 * - Whose food: the shared store first, then the bot's own bag. A foodless bot at the hearth
 *   withdraws exactly one portion from the nearest base-storage box near the fire; a bot with
 *   surplus ready food deposits everything above KEEP_BAG portions into that box before eating.
 * - The meal behaviour out-scores lone `eat` (weight 1.5 on the meal consideration) and walks
 *   the bot to its own ring seat around the fire (seatFor: one of 8 seats, deterministic per
 *   bot id, so clanmates do not stack on one tile). It eats only once seated, and waves.
 *
 * Guards — a shared meal must never starve the home build:
 * 1. Seeds are never meal food. Ready food is `food.hunger > 0 && food.health >= 0` and not a
 *    plantable seed (isSeedItem); seeds have no food value at all, so the rule holds by
 *    construction on both the deposit and the withdraw path. The clan's seed stock is never
 *    eaten, deposited as food, or withdrawn as food.
 * 2. Fuel is never food. Wood has no food value, and the meal never touches fire fuel: refuel
 *    stays with tend_fire / warm_up, and the meal never deposits or withdraws wood.
 * 3. The shared-store reserve. A bot withdraws from the store only while taking one portion
 *    leaves >= RESERVE portions behind — unless it is starving (hunger < criticalBelow), when
 *    survival beats the reserve. One portion per bot per meal, and a per-bot meal cooldown, so
 *    a meal cannot drain the store in one sitting.
 * 4. A bot never deposits its last food: it keeps KEEP_BAG portions (one to eat now, one
 *    spare) and shares only the surplus above that.
 * 5. A meal never strands a bot. No ready food anywhere and nothing to cook: the meal clears
 *    and is suppressed for retryTicks (the bot goes back to finding food). A walk to the
 *    hearth that makes no progress for STUCK_TICKS snoozes the meal (same pattern as
 *    life.ts snoozeWant) and lone eating resumes.
 * 6. Distance + starvation limits on the lone-eat suppression. Lone eating (the `eat`
 *    behavior and instantChores) is suppressed only while the meal pends AND the bot is
 *    within WALK_TILES of the hearth AND hunger is above critical: a bot on an expedition
 *    far from home keeps eating alone from its bag (today's behaviour — hunger drains
 *    0.05/s, so a bot working all afternoon would otherwise go unfed), and a starving bot
 *    eats alone right now wherever it is. The sensor precomputes this as
 *    `suppressLoneEat`, so neither consumer needs the rule twice.
 *
 * No new UI: the player-visible part is bots gathering and eating together by the fire.
 * Gamepad / keyboard / touch are untouched — this is bot behaviour, and every action it emits
 * (eat / copen / cdeposit / cwithdraw / cclose) is one a human client already sends; the
 * server re-validates reach, privilege and capacity as for players.
 */
import { PlayerId, Transform, fnv1a, type Agent, type AgentContext, type Entity, type World } from "@engine/core";
import { Survival } from "../components.js";
import type { AgentWorldView, GameBehavior } from "../agents.js";
import { GameplayConfig } from "../config.js";
import { readSlots } from "../inventory.js";
import { currentPhaseKey } from "../combat/zombies.js";
import { StationKind, type GameDefs } from "../defs.js";
import { containerSeq, goTo, isSeedItem } from "./base_behaviors.js";
import { stuckOn } from "./autonomy.js";
import { mayTakeFromStorageAt, nearbyStorage, storageDepositActions, storageWithdrawActions, type StorageInfo } from "./storage_api.js";
import { canUseBaseStorage } from "../building/actions.js";
import { resolveAttachment } from "../building/links.js";
import { AttachKind } from "../components.js";
import { affinityOf, SOCIAL_AFFINITY } from "./social_memory.js";

export const MEAL = {
  /** Hunger (0..1) below which a meal pends at any non-night phase. */
  hungryBelow: 0.55,
  /** Hunger below which a meal pends even at night (starving beats sleep). */
  criticalBelow: 0.2,
  /** Hunger below which the dusk meal pulls a merely peckish bot to the hearth. */
  duskBelow: 0.75,
  /** Portions of ready food a bot keeps in its own bag; only the surplus above this is shared. */
  keepBag: 2,
  /** Portions the shared store keeps after any one withdrawal (unless the bot is starving). */
  reserve: 2,
  /** A shared store must be this close to the hearth to count as the meal's store. */
  storeFireTiles: 8,
  /** Storage lookup radius from the bot. */
  storeRadius: 12,
  /** Ring radius of a bot's seat around the fire. */
  seatRing: 1.5,
  /** Close enough to the fire to count as seated at the hearth. */
  arriveTiles: 2.5,
  /** Lone eating is suppressed only within this walk of the hearth (further out, bots eat alone as today). */
  walkTiles: 12,
  /** Ticks after eating before the next meal may pend. */
  mealCooldownTicks: 600,
  /** Ticks a stuck walk to the hearth snoozes the meal. */
  snoozeTicks: 1200,
  /** Ticks an empty hearth suppresses a new meal (the bot goes back to finding food). */
  retryTicks: 1200,
  /** Container reach: stop here to open / deposit / withdraw (same as base_work's withdraw step). */
  containerReach: 2.2,
} as const;

export interface SharedMeal {
  /** The hearth (view.fire). */
  fire: { x: number; y: number };
  /** This bot's ring seat around the fire. */
  seat: { x: number; y: number };
  /** Within arriveTiles of the fire. */
  atHearth: boolean;
  /** Within walkTiles of the fire (a short walk, not an expedition). */
  nearHearth: boolean;
  /** Clanmates + party mates counted. */
  mates: number;
  /** This bot holds cookable raw and no ready food is available anywhere: wait for the cook. */
  cook: boolean;
  /** Lone eating (eat behavior + instantChores) is suppressed while this is true. */
  suppressLoneEat: boolean;
  /** Best ready food in the shared store, when a withdrawal is allowed (one portion). */
  store?: { piece: Entity; x: number; y: number; item: number; count: number };
  /** Surplus ready food in the bag to deposit into the shared store before eating. */
  deposit?: { piece: Entity; x: number; y: number; item: number; count: number };
}
export interface SharedMealSensors { sharedMeal?: SharedMeal }

// ---------------- pure rules ----------------
type Phase = "night" | "dawn" | "day" | "dusk";
/** A meal is due: hungry (non-night), peckish at dusk (the evening meal), or starving at any phase. */
export function mealDue(hunger01: number, phase: Phase, tick: number, lastMealTick: number): boolean {
  if (tick - lastMealTick < MEAL.mealCooldownTicks) return false;
  if (hunger01 < MEAL.criticalBelow) return true;
  if (phase === "night") return false;
  if (phase === "dusk") return hunger01 < MEAL.duskBelow;
  return hunger01 < MEAL.hungryBelow;
}
/** Ready meal food: filling, not sickening, and never a seed (the seed stock is never food). */
export function isReadyFood(defs: GameDefs, item: number): boolean {
  const f = defs.items.get(item)?.food;
  return !!f && f.hunger > 0 && f.health >= 0 && !isSeedItem(defs, item);
}
/** Cookable raw: a single-ingredient campfire roast whose output is ready food (raw_meat, fish, ...). */
export function isCookableRaw(defs: GameDefs, item: number): boolean {
  const ix = defIndex(defs);
  return ix.cookableRaw.has(item);
}
/** Most filling ready food in `counts`, ties by lowest item id (deterministic). */
export function bestReadyFood(defs: GameDefs, counts: ReadonlyMap<number, number>): { item: number; count: number } | undefined {
  let best: { item: number; count: number } | undefined;
  for (const [item, count] of counts) {
    if (count <= 0 || !isReadyFood(defs, item)) continue;
    const hunger = defs.items.get(item)!.food!.hunger;
    const bh = best ? defs.items.get(best.item)!.food!.hunger : -1;
    if (!best || hunger > bh || (hunger === bh && item < best.item)) best = { item, count };
  }
  return best;
}
/** This bot's seat on the ring around the fire: one of 8 seats, deterministic per bot id. */
export function seatFor(botId: string, fire: { x: number; y: number }): { x: number; y: number } {
  const a = ((fnv1a(botId) % 8) / 8) * Math.PI * 2;
  return { x: fire.x + Math.cos(a) * MEAL.seatRing, y: fire.y + Math.sin(a) * MEAL.seatRing };
}

interface DefIndex { cookableRaw: Set<number> }
const defIndexes = new WeakMap<GameDefs, DefIndex>();
function defIndex(defs: GameDefs): DefIndex {
  let ix = defIndexes.get(defs); if (ix) return ix;
  const cookableRaw = new Set<number>();
  for (const r of defs.recipes.values()) {
    if (r.station !== StationKind.Campfire || r.ingredients.length !== 1 || r.output.count !== 1) continue;
    const out = defs.items.get(r.output.item)?.food;
    if (out && out.hunger > 0 && out.health >= 0) cookableRaw.add(r.ingredients[0]!.item);
  }
  ix = { cookableRaw }; defIndexes.set(defs, ix); return ix;
}

// ---------------- sensor ----------------
const bbNum = (a: Agent, k: string, d: number): number => a.bb.num(k, d);
/** The shared store near the fire: readable contents first, else the planner's scanned base box. */
function mealStore(world: World, self: Entity, view: AgentWorldView & SharedMealSensors, fire: { x: number; y: number }, hunger01: number): SharedMeal["store"] {
  const defs = world.getResource(GameplayConfig)?.defs; if (!defs) return undefined;
  const near = nearbyStorage(world, self, MEAL.storeRadius).filter((s) => Math.hypot(s.x - fire.x, s.y - fire.y) <= MEAL.storeFireTiles);
  let best: SharedMeal["store"];
  const consider = (piece: Entity, x: number, y: number, counts: ReadonlyMap<number, number>): void => {
    const pick = bestReadyFood(defs, counts); if (!pick) return;
    // Guard 3: one portion must leave >= reserve behind, unless the bot is starving.
    if (pick.count - 1 < MEAL.reserve && hunger01 >= MEAL.criticalBelow) return;
    const cur = best ? defs.items.get(best.item)!.food!.hunger : -1;
    const h = defs.items.get(pick.item)!.food!.hunger;
    if (!best || h > cur || (h === cur && pick.item < best.item)) best = { piece, x, y, item: pick.item, count: pick.count };
  };
  for (const s of near) {
    if (!mayTakeFromStorageAt(world, self, s, view.home)) continue;
    if (s.contents) { const m = new Map<number, number>(); for (const c of s.contents) m.set(c.item, c.count); consider(s.piece, s.x, s.y, m); continue; }
    // Contents not replicated here (viewers-only): fall back to the planner's scanned base box.
    const bs = view.bs?.storage;
    if (bs && bs.id === s.piece) consider(s.piece, s.x, s.y, bs.counts);
  }
  return best;
}
/** The nearest usable store near the fire for depositing surplus (free space, or unknown = usable). */
function depositStore(world: World, self: Entity, view: AgentWorldView & SharedMealSensors, fire: { x: number; y: number }): StorageInfo | undefined {
  const near = nearbyStorage(world, self, MEAL.storeRadius).filter((s) => Math.hypot(s.x - fire.x, s.y - fire.y) <= MEAL.storeFireTiles);
  for (const s of near) {
    if (s.free !== undefined && s.free <= 0) continue;
    const att = resolveAttachment(world, s.piece, AttachKind.Storage);
    if (att === undefined || !canUseBaseStorage(world, self, att)) continue;
    if (!mayTakeFromStorageAt(world, self, s, view.home)) continue;
    return s;
  }
  return undefined;
}

/**
 * Fill view.sharedMeal (runs LAST in buildAgentView: it reads view.fire, view.food, view.bs,
 * view.clanMembers / view.partyMates). Deletes it when no meal pends.
 */
export function fillSharedMealSensors(world: World, self: Entity, view: AgentWorldView & SharedMealSensors, agent: Agent): void {
  const tick = world.tick;
  if (tick < bbNum(agent, "mealSnoozeUntil", -1)) { delete view.sharedMeal; return; }
  if (tick < bbNum(agent, "mealEmptyUntil", -1)) { delete view.sharedMeal; return; }
  const fire = view.fire; if (!fire) { delete view.sharedMeal; return; }
  const defs = world.getResource(GameplayConfig)?.defs; if (!defs) { delete view.sharedMeal; return; }
  const sv = world.get(self, Survival);
  const hunger01 = (sv?.hunger ?? 100) / 100;
  if (!mealDue(hunger01, currentPhaseKey(world), tick, bbNum(agent, "mealAt", -1e9))) { delete view.sharedMeal; return; }
  const mates = (view.clanMembers?.length ?? 0) + (view.partyMates?.length ?? 0);
  if (mates < 1) { delete view.sharedMeal; return; } // solo bots keep eating alone, exactly as before
  const t = world.get(self, Transform); if (!t) { delete view.sharedMeal; return; }
  const distFire = Math.hypot(t.x - fire.x, t.y - fire.y);
  const atHearth = distFire <= MEAL.arriveTiles;
  const nearHearth = distFire <= MEAL.walkTiles;
  // Bag: ready food (view.food is already the best ready slot) + per-item counts for the surplus.
  let bagCounts = new Map<number, number>();
  try { const slots = readSlots(world, self); for (let i = 0; i < slots.items.length; i++) { const it = slots.items[i]; if (it && slots.counts[i]) bagCounts.set(it, (bagCounts.get(it) ?? 0) + slots.counts[i]!); } } catch { bagCounts = new Map(); }
  const hasBagFood = view.food !== undefined;
  const store = mealStore(world, self, view, fire, hunger01);
  // Cook: holds a roastable raw and no ready food is available anywhere (bag or store).
  let cook = false;
  if (!hasBagFood && !store) {
    const camp = view.bs?.stations.get(StationKind.Campfire);
    if (camp) for (const [item, count] of bagCounts) if (count > 0 && isCookableRaw(defs, item)) { cook = true; break; }
  }
  // Guard 5: at the hearth with nothing to eat and nothing to cook — do not camp here forever.
  if (atHearth && !hasBagFood && !store && !cook) {
    agent.bb.set("mealEmptyAt", tick); agent.bb.set("mealEmptyUntil", tick + MEAL.retryTicks);
    delete view.sharedMeal; return;
  }
  // Guard 4: share only the surplus above KEEP_BAG, of the most-surplus ready food.
  // ADR-478: a bot shares its surplus with the meal's shared store — unless every mate at the meal is
  // someone it holds a grudge against (affinity < grudgeBelow), in which case it keeps its surplus. The
  // store is communal (no per-recipient queue), so "friends first" is expressed as sharing whenever at
  // least one mate is not a grudge; a single grudge never vetoes sharing with the friends present. A
  // mate whose entity has no PlayerId counts as a stranger (affinity 0), never a grudge.
  const matePids: number[] = [];
  for (const m of [...(view.clanMembers ?? []), ...(view.partyMates ?? [])]) {
    const pid = world.getField(m.id as Entity, PlayerId, "id") ?? 0; if (pid > 0) matePids.push(pid);
  }
  const allGrudged = matePids.length > 0 && matePids.every((pid) => affinityOf(agent, pid) < SOCIAL_AFFINITY.grudgeBelow);
  let deposit: SharedMeal["deposit"];
  {
    let pick: { item: number; surplus: number } | undefined;
    for (const [item, count] of bagCounts) {
      if (count <= MEAL.keepBag || !isReadyFood(defs, item)) continue;
      const surplus = count - MEAL.keepBag;
      if (!pick || surplus > pick.surplus) pick = { item, surplus };
    }
    if (pick && !allGrudged) {
      const box = depositStore(world, self, view, fire);
      if (box) deposit = { piece: box.piece, x: box.x, y: box.y, item: pick.item, count: pick.surplus };
    }
  }
  view.sharedMeal = {
    fire: { x: fire.x, y: fire.y }, seat: seatFor(agent.identity.id, fire), atHearth, nearHearth, mates, cook,
    // Guard 6: lone eating stops only on a short walk to the hearth, above starvation hunger.
    suppressLoneEat: !atHearth && nearHearth && hunger01 >= MEAL.criticalBelow,
    ...(store ? { store } : {}), ...(deposit ? { deposit } : {}),
  };
}

// ---------------- behavior ----------------
type Ctx = AgentContext<AgentWorldView & SharedMealSensors>;
const step01 = { type: "step" as const, at: 0.5 };
const stop = (o: { moveX: number; moveY: number }): void => { o.moveX = 0; o.moveY = 0; };

/** One behavior: walk to the hearth seat, share with the store, then eat together. */
export function sharedMealBehaviors(): GameBehavior[] {
  return [
    { name: "shared_meal", inertia: 0.3, traits: { sociability: 0.3 }, considerations: [
        { name: "hungry", curve: { type: "logistic", k: 12, mid: 0.55 }, input: (c) => 1 - c.self.hunger },
        // Weight 1.5: the social pull — a pending meal beats lone `eat` at equal hunger (eat has no
        // such weight), so bots that can eat together do. Far from the hearth it scores 0: the meal
        // never drags an expedition home; the bot eats alone out there, as today.
        { name: "meal", weight: 1.5, curve: step01, input: (c) => (c.world.sharedMeal && c.world.sharedMeal.nearHearth ? 1 : 0) },
        { name: "calm", curve: step01, input: (c) => (c.memory.nearest("zombie", c.self.x, c.self.y, 0.3) ? 0 : 1) }],
      run: (c, o) => {
        const m = c.world.sharedMeal; if (!m) return false;
        const tick = c.self.tick;
        if (!m.atHearth) {
          // Walk to this bot's ring seat; "seated" is measured to the fire (same rule as the
          // sensor's atHearth), so a bot that reaches the fire's edge eats even if its exact
          // seat is a step further around the ring.
          goTo(c, o, m.seat.x, m.seat.y);
          if (Math.hypot(m.fire.x - c.self.x, m.fire.y - c.self.y) > MEAL.arriveTiles) {
            if (stuckOn(c, m.seat.x, m.seat.y)) { c.bb.set("mealSnoozeUntil", tick + MEAL.snoozeTicks); return false; }
            return; // still walking to the seat
          }
        }
        stop(o); // seated at the hearth
        // Share first: surplus into the store, so the meal is fed from the shared stock.
        if (m.deposit) {
          if (Math.hypot(m.deposit.x - c.self.x, m.deposit.y - c.self.y) > MEAL.containerReach) {
            const d = goTo(c, o, m.deposit.x, m.deposit.y);
            if (d > MEAL.containerReach && stuckOn(c, m.deposit.x, m.deposit.y)) { c.bb.set("mealSnoozeUntil", tick + MEAL.snoozeTicks); return false; }
            return;
          }
          stop(o);
          if (containerSeq(c, o, m.deposit.piece, storageDepositActions(m.deposit.piece, m.deposit.item, m.deposit.count))) return false;
          return;
        }
        // Nothing in the bag: one portion from the shared store (the sensor already applied the reserve).
        if (c.world.food === undefined && m.store) {
          if (Math.hypot(m.store.x - c.self.x, m.store.y - c.self.y) > MEAL.containerReach) {
            const d = goTo(c, o, m.store.x, m.store.y);
            if (d > MEAL.containerReach && stuckOn(c, m.store.x, m.store.y)) { c.bb.set("mealSnoozeUntil", tick + MEAL.snoozeTicks); return false; }
            return;
          }
          stop(o);
          if (containerSeq(c, o, m.store.piece, storageWithdrawActions(m.store.piece, m.store.item, 1))) return false;
          return;
        }
        // The cook waits by the fire: the planner's cook pre-goal converts the raw (this layer never crafts).
        if (m.cook) return false;
        // Eat together, at the hearth.
        if (c.world.food !== undefined) {
          o.actions.push(`eat:${c.world.food}`);
          c.bb.set("ateAt", tick); c.bb.set("mealAt", tick);
          if (m.mates > 0) o.emote = "wave";
          return false;
        }
        // Stale view (food was spent since the sense tick): do not wait here; the sensor re-picks next tick.
        return false;
      } },
  ];
}
