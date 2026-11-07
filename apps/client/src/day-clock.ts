/**
 * ADR-115: the client's one day clock, shared by the renderer (view.ts) and the HUD clock.
 * Source of truth = authoritative server tick (NetClient.serverTickEstimate, seeded from Welcome.serverTick and
 * clamped to snapshot ticks) + the frame's interpolation alpha, against the replicated TimeOfDay {dayLengthTicks,
 * epochTick}. Same for dedicated servers, P2P hosts and the singleplayer Worker (all reach the sim through a
 * NetClient). The client's own world.tick is NOT used: it starts at 0 on join and differs per client.
 */
import { DayClock, DEFAULT_TICK_HZ, Season, TimeOfDay, dayFractionAt, sunFractionFor, sunScheduleAt, SUN_OFF, worldSunSchedule, type SunSchedule, type World } from "@engine/core";

export interface ServerTickSource { serverTickEstimate: number }
const clock = new DayClock(2); // persists across reconnects: a new Welcome blends, never snaps
let lastMs: number | undefined; let lastT = 0.5; let lastDays = 0.5;

/** Target fraction from the authoritative clock (pure; used by tests to compare peers). */
export function serverDayFraction(net: World, src: ServerTickSource | undefined, alpha = 0): number {
  const td = net.env(TimeOfDay); const tick = src ? src.serverTickEstimate + alpha : net.tick + alpha;
  return dayFractionAt(tick, td.epochTick, td.dayLengthTicks || 72000);
}
/** Advance the shared smoothed clock once per frame; returns the day fraction to draw. */
export function sampleDayClock(net: World, src: ServerTickSource | undefined, alpha: number, nowMs = performance.now()): number {
  const len = net.env(TimeOfDay).dayLengthTicks || 72000;
  const dt = lastMs === undefined ? 0 : (nowMs - lastMs) / 1000; lastMs = nowMs;
  lastT = clock.update(serverDayFraction(net, src, alpha), dt, len / DEFAULT_TICK_HZ);
  lastDays = Math.round(serverDays(net, src, alpha) - lastT) + lastT; // ADR-239: whole days from the server tick + the smoothed fraction
  return lastT;
}
/** ADR-239: continuous days since the replicated epoch on the authoritative tick (the season input; pure). */
export function serverDays(net: World, src: ServerTickSource | undefined, alpha = 0): number {
  const td = net.env(TimeOfDay); const tick = src ? src.serverTickEstimate + alpha : net.tick + alpha;
  return (tick - td.epochTick) / (td.dayLengthTicks || 72000);
}
/** Last drawn continuous day count (whole days + the drawn fraction): seasonAtDays(world, dayCount()). */
export const dayCount = (): number => lastDays;
/** Last drawn day fraction / hours (HUD reads this so its clock matches the lighting exactly). */
export const dayFraction = (): number => lastT;
export const dayHours = (): number => lastT * 24;

/** ADR-283: sunrise / sunset for the drawn day (shared world schedule); `ovSeason` (?season=) pins that season's midpoint. */
export function sunScheduleNow(net: World, days: number = lastDays, ovSeason?: number): SunSchedule {
  if (ovSeason !== undefined && Number.isFinite(ovSeason) && net.isRegistered(Season) && net.has(net.environment, Season)) {
    const L = net.env(Season).lengthDays; return sunScheduleAt((((ovSeason % 4) + 4) % 4) * L + L / 2, L);
  }
  try { return worldSunSchedule(net, days); } catch { return SUN_OFF; }
}
/** ADR-283: the sun fraction (sunrise 0.25 / sunset 0.75) for a wall-clock fraction on the drawn day: lighting, sky, audio, FX. */
export function sunFraction(net: World, frac: number, days: number = lastDays, ovSeason?: number): number {
  return sunFractionFor(frac, sunScheduleNow(net, days, ovSeason));
}
