/**
 * ADR-283/285: seasonal daylight. A seasonal solar model (ADR-285 retuned to player-chosen sunsets) on the shared world clock: day length follows a
 * cosine through the 4-season year (Summer -> Fall -> Winter -> Spring), longest at mid-summer (the solstice), shortest at
 * mid-winter, equal day and night at mid-fall / mid-spring, with no steps at season boundaries. ADR-285: sunrise and sunset follow
 * their own player-tuned curves (not noon-symmetric). No polar day / night.
 *
 * Every day/night consumer reads the "sun fraction" (`sunDayFraction`): the wall-clock day fraction remapped piecewise
 * linearly so sunrise -> 0.25 (06:00) and sunset -> 0.75 (18:00). Code tuned on the old fixed 06:00 / 18:00 sun (lighting
 * curve, twilight rows, zombie phases, AI day/night, sleep skip) keeps its thresholds and simply stretches with the season:
 * twilight windows scale with the day or night half they live in instead of swallowing a short winter day.
 * Pure (two cosines, no allocation): the same inputs give the same answer on the server and every peer.
 */
/** A day's wall-clock sunrise / sunset (hours, 0..24, sunrise < sunset). */
export interface SunSchedule { sunrise: number; sunset: number }
/** ADR-285 season-midpoint schedule (player-tuned, not noon-symmetric): summer 4:20 AM-9:00 PM, fall / spring 4:30 AM-7:30 PM,
 *  winter 5:30 AM-6:30 PM. Order = cycle order Summer, Fall, Winter, Spring. Seasons off -> 6:00 AM-6:00 PM. */
export const SEASON_MIDPOINT_SUN: readonly SunSchedule[] = [
  { sunrise: 4 + 20 / 60, sunset: 21 }, { sunrise: 4.5, sunset: 19.5 }, { sunrise: 5.5, sunset: 18.5 }, { sunrise: 4.5, sunset: 19.5 },
];
export const SUN_OFF: SunSchedule = { sunrise: 6, sunset: 18 };
// Each of sunrise / sunset = a + b cos(phi) + c cos(2 phi), phi = 0 at mid-summer: exact at all four midpoints
// (phi = 0, pi/2, pi, 3pi/2; spring and fall share a value) and smooth (C-infinity) through every season boundary.
const fit = (su: number, eq: number, wi: number): [number, number, number] => { const b = (su - wi) / 2, c = ((su + wi) / 2 - eq) / 2; return [eq + c, b, c]; };
const M = SEASON_MIDPOINT_SUN;
const RISE = fit(M[0]!.sunrise, M[1]!.sunrise, M[2]!.sunrise), SET = fit(M[0]!.sunset, M[1]!.sunset, M[2]!.sunset);
const ev = (k: [number, number, number], phi: number): number => k[0] + k[1] * Math.cos(phi) + k[2] * Math.cos(2 * phi);

/** Sunrise / sunset at a (fractional) season-cycle position `days` (offset applied) for `seasonLengthDays`-day seasons. */
export function sunScheduleAt(days: number, seasonLengthDays: number): SunSchedule {
  if (!(seasonLengthDays > 0)) return SUN_OFF;
  const phi = 2 * Math.PI * (days - seasonLengthDays * 0.5) / (seasonLengthDays * 4); // 0 = middle of summer
  return { sunrise: ev(RISE, phi), sunset: ev(SET, phi) };
}
/** Hours of daylight (sunset - sunrise). Rises strictly from mid-winter through spring to mid-summer, falls through fall. */
export function dayLengthHours(days: number, seasonLengthDays: number): number { const s = sunScheduleAt(days, seasonLengthDays); return s.sunset - s.sunrise; }
/** Remap a wall-clock day fraction `t` (0..1) to the sun fraction (sunrise -> 0.25, sunset -> 0.75, piecewise linear). */
export function sunFractionFor(t: number, sun: SunSchedule): number {
  const h = (((t % 1) + 1) % 1) * 24; const { sunrise: sr, sunset: ss } = sun; const day = ss - sr;
  let s: number;
  if (h >= sr && h <= ss) s = 6 + 12 * (h - sr) / day;
  else { const night = 24 - day; const since = ((h - ss) % 24 + 24) % 24; s = 18 + 12 * since / night; }
  return (s % 24) / 24;
}
/** Sun fraction at wall-clock fraction `t` on (fractional) cycle day `days`. */
export function sunDayFraction(t: number, days: number, seasonLengthDays: number): number {
  return seasonLengthDays > 0 ? sunFractionFor(t, sunScheduleAt(days, seasonLengthDays)) : (((t % 1) + 1) % 1);
}
/** Inverse: wall-clock hours of a sun hour (e.g. sun 06:00 -> that day's sunrise). */
export function wallHoursForSun(sunHours: number, sun: SunSchedule): number {
  const s = ((sunHours % 24) + 24) % 24; const { sunrise: sr, sunset: ss } = sun; const day = ss - sr;
  if (s >= 6 && s <= 18) return sr + (s - 6) / 12 * day;
  const night = 24 - day; const since = ((s - 18) % 24 + 24) % 24; return (ss + since / 12 * night) % 24;
}
