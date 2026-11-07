import { TimeOfDay } from "./builtins.js";
import type { World } from "./world.js";
import { Season } from "./season.js";
import { SUN_OFF, sunFractionFor, sunScheduleAt, type SunSchedule } from "./daylight.js";

export interface TimeOfDayInfo {
  /** Fraction of the day in [0, 1). */
  t: number;
  /** Hours in [0, 24). */
  hours: number;
  /** Whole days elapsed since the epoch (may be negative before it). */
  day: number;
  /** Tick within the current day, [0, dayLengthTicks). */
  tickOfDay: number;
  dayLengthTicks: number;
  /** ADR-283: sun fraction [0,1) - wall clock remapped so sunrise = 0.25 and sunset = 0.75 (equals t with seasons off).
   *  Day/night consumers (lighting, zombie phases, AI, sleep) read this; clocks and seasons read t. */
  sunT?: number;
  /** ADR-283: hours of daylight today (12 with seasons off). */
  daylightHours?: number;
  /** ADR-285: today's wall-clock sunrise / sunset hours. */
  sun?: SunSchedule;
}
/** ADR-283/285: today's sunrise / sunset from the replicated Season (6:00 AM-6:00 PM when seasons are off / absent). */
export function worldSunSchedule(world: World, days: number): SunSchedule {
  if (!world.isAlive(world.environment) || !world.isRegistered(Season) || !world.has(world.environment, Season)) return SUN_OFF;
  const s = world.env(Season); return sunScheduleAt(days + s.offsetDays, s.lengthDays);
}
/** Derived time of day at `tick` (default world.tick). dayLengthTicks 0 (uninitialised) reports t = 0, day 0. */
export function timeOfDay(world: World, tick = world.tick): TimeOfDayInfo {
  const tod = world.env(TimeOfDay); const len = tod.dayLengthTicks;
  if (len <= 0) return { t: 0, hours: 0, day: 0, tickOfDay: 0, dayLengthTicks: 0, sunT: 0, daylightHours: 12, sun: SUN_OFF };
  const elapsed = tick - tod.epochTick; const day = Math.floor(elapsed / len); const tickOfDay = elapsed - day * len;
  const t = tickOfDay / len;
  const sun = worldSunSchedule(world, day + t);
  return { t, hours: t * 24, day, tickOfDay, dayLengthTicks: len, sunT: sun === SUN_OFF ? t : sunFractionFor(t, sun), daylightHours: sun.sunset - sun.sunrise, sun };
}
/** Jump to `hours` (0-24) of `day` (default: current day) at the current tick. */
export function setTimeOfDay(world: World, hours: number, day = timeOfDay(world).day): void {
  const tod = world.env(TimeOfDay); const len = tod.dayLengthTicks; if (len <= 0) throw new Error("setTimeOfDay: dayLengthTicks not set");
  const h = ((hours % 24) + 24) % 24;
  tod.epochTick = world.tick - (day * len + Math.round((h / 24) * len));
}
/** Change day length, keeping the current fraction of day and day number. */
export function setDayLength(world: World, dayLengthTicks: number): void {
  if (!(Number.isInteger(dayLengthTicks) && dayLengthTicks > 0)) throw new Error("dayLengthTicks must be a positive integer");
  const cur = timeOfDay(world); const tod = world.env(TimeOfDay);
  tod.dayLengthTicks = dayLengthTicks;
  tod.epochTick = world.tick - (cur.day * dayLengthTicks + Math.round(cur.t * dayLengthTicks));
}

/**
 * Lazy time-based value: compute decay from a stored start tick instead of updating every tick.
 * Store createdTick (or lastUpdateTick + value at that tick) on the item/slot; evaluate on read.
 *  - linear: initial - rate * elapsed (clamped at 0)
 *  - exp:    initial * (1 - rate) ^ elapsed   (rate = fraction lost per tick)
 */
export function decayAt(createdTick: number, rate: number, tick: number, opts: { initial?: number; mode?: "linear" | "exp" } = {}): number {
  const initial = opts.initial ?? 1; const elapsed = Math.max(0, tick - createdTick);
  if (opts.mode === "exp") return initial * Math.pow(Math.max(0, 1 - rate), elapsed);
  return Math.max(0, initial - rate * elapsed);
}
/** Tick at which a linear decay reaches `threshold` (for scheduling spoil events instead of polling). */
export function decayReachesAt(createdTick: number, rate: number, threshold = 0, initial = 1): number {
  return rate <= 0 ? Infinity : createdTick + Math.ceil((initial - threshold) / rate);
}

// ---- ADR-115: shared, smoothed day clock ------------------------------------------------------------------
/** Day fraction [0,1) at a (fractional) authoritative server tick. Pure: same inputs give the same answer on every peer. */
export function dayFractionAt(serverTick: number, epochTick: number, dayLengthTicks: number): number {
  if (!(dayLengthTicks > 0)) return 0.5;
  const f = (serverTick - epochTick) / dayLengthTicks; return f - Math.floor(f);
}
/**
 * Client-side smoother for the day fraction. Targets dayFractionAt(serverTickEstimate + frame alpha) each frame,
 * advances at the natural day rate between samples (extrapolation), and folds any error (wrap-aware) in over
 * `blendSec` instead of snapping (reconnect, epoch changes from sleep/admin). The very first sample is taken as-is:
 * nothing was shown before it, so join never visibly jumps. Keep one instance across reconnects.
 */
export class DayClock {
  private t: number | undefined;
  constructor(readonly blendSec = 2) {}
  get value(): number | undefined { return this.t; }
  update(target: number, dtSec: number, dayLengthSec: number): number {
    if (this.t === undefined || !Number.isFinite(this.t)) return (this.t = target);
    const dt = Math.max(0, Math.min(1, dtSec));
    let t = this.t + (dayLengthSec > 0 ? dt / dayLengthSec : 0);
    let err = target - t; err -= Math.round(err); // shortest way round the wrap
    t += Math.abs(err) < 1e-7 ? err : err * Math.min(1, dt / this.blendSec * 3); // ~95% in blendSec
    return (this.t = t - Math.floor(t));
  }
  reset(): void { this.t = undefined; }
}
/** ADR-283: the sun fraction of a TimeOfDayInfo (falls back to the wall clock for hand-built infos). */
export const sunFractionOf = (tod: Pick<TimeOfDayInfo, "t" | "sunT">): number => tod.sunT ?? tod.t;
