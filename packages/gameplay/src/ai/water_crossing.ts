/**
 * ADR-345: water navigation for AI humans — swim / ford across where safe, route around where it is not.
 * Pure decision leaf (like journey.ts): it imports only data JSON — never base_behaviors / input.ts — so
 * travel.ts can use it without an import cycle. The world reads (depth sampling along a leg, the bot's live
 * state) live in travel.ts; this module turns a sampled depth profile + bot state into a decision.
 *
 *   - Ford: shallow water only (a water tile with land within shallowRadius — wadeSpeedMul, walk anim, no
 *     stamina cost). Shallow fords are always allowed: wading is walking, and the exposure system already
 *     wets (0.15/s) and chills the bot for it.
 *   - Swim: deep water, on foot, when the deep run is short enough (swimMaxDeepTiles) and the bot is in good
 *     shape. Deep water is swum at swimSpeedMul and costs swimStaminaPerSec of stamina per second in it.
 *   - Ride: mounted. A mount that swims (moose — the only swimming species, mounts.json) crosses deep water
 *     up to rideSwimMaxDeepTiles; any mount wades shallows (movement lets non-swimmers through shallow
 *     tiles). A mount that cannot swim never takes its rider into deep water: the bot routes around instead
 *     of dismounting and stranding the mount (no riderless-mount recall across water exists).
 *   - Wait: the crossing is structurally fine but the bot is in bad shape — cold (bodyTemp under COLD_BELOW),
 *     hurt, hungry / thirsty, or without the stamina the crossing needs (deep seconds x swimStaminaPerSec x
 *     staminaMargin). In full sim the bot holds at the bank (other behaviours — eat / drink / warm — get the
 *     ticks) and retries; off-screen, where nothing can recover, wait is treated as around.
 *   - Around: the deep run is longer than the bot (or its mount) can swim, or the mount cannot swim deep
 *     water at all. The route is re-planned with those regions avoided; when no route around exists the trip
 *     ends like any unreachable goal. At route-planning time the non-swimmer rule is relaxed
 *     (legUncrossableAtPlan): a mount that cannot swim only forces a re-plan around lake-scale water, and
 *     smaller water is left to the bank gate, where the local nav decides whether it can be skirted.
 *
 * Speeds come from the caller (off-screen speeds for estimates, like journey.ts — the estimate is
 * conservative for a moose, whose walk is slower than the off-screen mount speed, and staminaMargin
 * absorbs the difference). Thresholds are data (travel.json "water"); the hp / needs floors reuse the
 * travel.json top-level minHp / minNeeds.
 */
import { WaterDepth } from "@engine/world";
import travelRaw from "../../data/travel.json";

/** Tuning knobs (data/travel.json "water"); code reads them, never hardcodes them. */
export interface WaterData {
  sampleStepTiles: number; swimMaxDeepTiles: number; rideSwimMaxDeepTiles: number; nonSwimmerPlanDeepTiles: number;
  swimStaminaPerSec: number; staminaMargin: number; minStamina: number; waitTicks: number; bankTiles: number;
}
export const WATER_DATA: WaterData = (travelRaw as unknown as { water: WaterData }).water;
/** Speeds a crossing is costed at (tiles/s on foot / mounted, and the movement.json water multipliers). */
export interface CrossingSpeeds { foot: number; ride: number; wadeMul: number; swimMul: number }
/** Water along one leg, in tiles (sample-scaled, so counts run a little long — conservative by < 1 sample step).
 *  firstDeep is the distance in tiles to the first deep sample (Infinity when the leg has no deep water);
 *  firstWet the same for the first wet sample of either depth (the bank gate's trigger). Both are measured to
 *  a sample, which can sit up to one sample step past the first tile of that kind — callers that need the
 *  water's edge back off by sampleStepTiles. */
export interface WaterProfile { tiles: number; dry: number; shallow: number; deep: number; maxDeepRun: number; firstDeep: number; firstWet: number }
/** The bot's crossing state: 0..1 fractions, except stamina / staminaMax (absolute Survival points). */
export interface CrossingBot {
  riding: boolean; mountSwims: boolean;
  hp: number; hunger: number; thirst: number;
  stamina: number; staminaMax: number;
  cold: boolean;
}
export type CrossingDecision = "ford" | "swim" | "ride" | "around" | "wait";

const T = travelRaw as unknown as { minHp: number; minNeeds: number };

/** Profile of a sampled depth run: tile counts scaled to `tiles` of leg, plus the longest deep run and the
 *  distances to the first deep / first wet sample (Infinity when the leg has none — the bank gate's trigger). */
export function profileFromDepths(depths: readonly WaterDepth[], tiles: number): WaterProfile {
  const n = Math.max(1, depths.length); const per = tiles / n;
  let dry = 0, shallow = 0, deep = 0, run = 0, maxRun = 0, firstDeep = Infinity, firstWet = Infinity;
  for (let i = 0; i < depths.length; i++) {
    const d = depths[i]!;
    if (d === WaterDepth.Deep) { deep++; run++; maxRun = Math.max(maxRun, run); if (!Number.isFinite(firstDeep)) firstDeep = i * per; if (!Number.isFinite(firstWet)) firstWet = i * per; }
    else if (d === WaterDepth.Shallow) { shallow++; run = 0; if (!Number.isFinite(firstWet)) firstWet = i * per; }
    else { dry++; run = 0; }
  }
  return { tiles, dry: dry * per, shallow: shallow * per, deep: deep * per, maxDeepRun: maxRun * per, firstDeep, firstWet };
}

/** Structural decision only (no bot condition): can this leg be crossed at all, and how? */
export function structuralCrossing(profile: WaterProfile, riding: boolean, mountSwims: boolean, data: WaterData = WATER_DATA): "ford" | "swim" | "ride" | "around" {
  if (profile.deep <= 0) return riding ? "ride" : "ford";
  if (riding && !mountSwims) return "around"; // a non-swimming mount never takes its rider into deep water
  const maxDeep = riding ? data.rideSwimMaxDeepTiles : data.swimMaxDeepTiles;
  if (profile.maxDeepRun > maxDeep) return "around";
  return riding ? "ride" : "swim";
}
/** ADR-345: the route-time structural decision — like structuralCrossing, but a mount that cannot swim only
 *  forces a re-plan around a deep run longer than nonSwimmerPlanDeepTiles (12, the local nav's detour
 *  allowance: water wider than that along the leg is beyond what the local nav can skirt within its budget).
 *  Smaller water is left to the bank gate, where the local nav decides whether it can be skirted: routing
 *  around every pond at planning time would end trips whose legs merely clip a river the bot could walk
 *  around (a 400-tile horse trip crosses rivers the local nav skirts in seconds, and each re-plan found new
 *  rivers further along, so the one-re-plan limit ended the trip at assignment). The threshold is a data knob,
 *  not the nav constant itself, so the leaf stays pure (data JSON only) — it just matches NAV.detour in
 *  creature_nav. On foot the rule is unchanged — the bot can swim a short deep run, so a longer one is a
 *  genuine detour choice, not a stranding risk. (Region legs are at most ~23 tiles, so a threshold above that
 *  could never fire on them — the planning rule for a non-swimmer must sit below the leg length.) */
export function legUncrossableAtPlan(profile: WaterProfile, riding: boolean, mountSwims: boolean, data: WaterData = WATER_DATA): boolean {
  if (profile.deep <= 0) return false;
  if (riding && !mountSwims) return profile.maxDeepRun > data.nonSwimmerPlanDeepTiles;
  return structuralCrossing(profile, riding, mountSwims, data) === "around";
}

/** Seconds spent in deep water on this leg at the crossing speeds (0 when the leg has no deep water). */
export function deepSeconds(profile: WaterProfile, riding: boolean, speeds: CrossingSpeeds): number {
  if (profile.deep <= 0) return 0;
  const denom = (riding ? speeds.ride : speeds.foot) * speeds.swimMul;
  return denom > 0 ? profile.deep / denom : Infinity;
}
/** Stamina points the deep water on this leg costs (shallow wading costs none — it is walking). */
export function staminaNeeded(profile: WaterProfile, riding: boolean, speeds: CrossingSpeeds, data: WaterData = WATER_DATA): number {
  return deepSeconds(profile, riding, speeds) * data.swimStaminaPerSec;
}
/** Seconds in any water / in deep water on this leg, at the crossing speeds (off-screen wetness + stamina). */
export function waterSeconds(profile: WaterProfile, riding: boolean, speeds: CrossingSpeeds): { wet: number; deep: number } {
  const speed = riding ? speeds.ride : speeds.foot;
  const wade = speed * speeds.wadeMul > 0 ? profile.shallow / (speed * speeds.wadeMul) : 0;
  const deep = deepSeconds(profile, riding, speeds);
  return { wet: wade + (Number.isFinite(deep) ? deep : 0), deep };
}
/** True when the bot is fit to make this crossing now. A shallow ford is always safe; a deep crossing needs
 *  a warm, fed, watered, unhurt bot with the stamina the deep water costs (times the margin). */
export function crossingSafe(profile: WaterProfile, bot: CrossingBot, speeds: CrossingSpeeds, data: WaterData = WATER_DATA): boolean {
  if (structuralCrossing(profile, bot.riding, bot.mountSwims, data) === "around") return false;
  if (profile.deep <= 0) return true; // a ford is walking, not a dangerous crossing
  if (bot.cold) return false;
  if (bot.hp < T.minHp || bot.hunger < T.minNeeds || bot.thirst < T.minNeeds) return false;
  if (bot.stamina / Math.max(1, bot.staminaMax) < data.minStamina) return false;
  return bot.stamina >= staminaNeeded(profile, bot.riding, speeds, data) * data.staminaMargin;
}

/** The full decision: ford / swim / ride when safe, wait when the bot is in bad shape, around when the
 *  water itself is uncrossable for this bot (or its mount). */
export function decideCrossing(profile: WaterProfile, bot: CrossingBot, speeds: CrossingSpeeds, data: WaterData = WATER_DATA): CrossingDecision {
  const structural = structuralCrossing(profile, bot.riding, bot.mountSwims, data);
  if (structural === "around") return "around";
  return crossingSafe(profile, bot, speeds, data) ? structural : "wait";
}
