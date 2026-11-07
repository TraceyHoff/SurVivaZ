/**
 * ADR-283: seasonal daylight. A temperate mid-latitude (~40°N) solar model on the shared world clock: day length follows a
 * cosine through the 4-season year (Summer -> Fall -> Winter -> Spring), longest at mid-summer (the solstice), shortest at
 * mid-winter, equal day and night at mid-fall / mid-spring, with no steps at season boundaries. Sunrise and sunset sit
 * symmetrically around 12:00 (local solar noon). No polar day / night.
 *
 * Every day/night consumer reads the "sun fraction" (`sunDayFraction`): the wall-clock day fraction remapped piecewise
 * linearly so sunrise -> 0.25 (06:00) and sunset -> 0.75 (18:00). Code tuned on the old fixed 06:00 / 18:00 sun (lighting
 * curve, twilight rows, zombie phases, AI day/night, sleep skip) keeps its thresholds and simply stretches with the season:
 * twilight windows scale with the day or night half they live in instead of swallowing a short winter day.
 * Pure (two cosines, no allocation): the same inputs give the same answer on the server and every peer.
 */
/** Hours of daylight at the solstices / equinoxes (~40°N). */
export const DAYLIGHT_MAX_HOURS = 15, DAYLIGHT_MIN_HOURS = 9, DAYLIGHT_EQUINOX_HOURS = 12;
const AMP = (DAYLIGHT_MAX_HOURS - DAYLIGHT_MIN_HOURS) / 2;

/** Hours of daylight at a (fractional) season-cycle position `days` (offset already applied) for `seasonLengthDays`-day
 *  seasons in the Summer, Fall, Winter, Spring order. Seasons off (length 0) -> 12 h. */
export function dayLengthHours(days: number, seasonLengthDays: number): number {
  if (!(seasonLengthDays > 0)) return DAYLIGHT_EQUINOX_HOURS;
  const year = seasonLengthDays * 4; // summer solstice = middle of summer (0.5 season into the cycle)
  return DAYLIGHT_EQUINOX_HOURS + AMP * Math.cos(2 * Math.PI * (days - seasonLengthDays * 0.5) / year);
}
/** Wall-clock sunrise / sunset hours (symmetric around noon) for a day length. */
export function sunTimes(dayHours: number): { sunrise: number; sunset: number } { return { sunrise: 12 - dayHours / 2, sunset: 12 + dayHours / 2 }; }
/** Remap a wall-clock day fraction `t` (0..1) to the sun fraction for a day `dayHours` long (sunrise -> 0.25, sunset -> 0.75). */
export function sunFractionFor(t: number, dayHours: number): number {
  const h = (((t % 1) + 1) % 1) * 24; const sr = 12 - dayHours / 2, ss = 12 + dayHours / 2;
  let s: number;
  if (h >= sr && h <= ss) s = 6 + 12 * (h - sr) / dayHours;
  else { const night = 24 - dayHours; const since = ((h - ss) % 24 + 24) % 24; s = 18 + 12 * since / night; }
  s = s % 24; return s / 24;
}
/** Sun fraction at wall-clock fraction `t` on (fractional) cycle day `days`. */
export function sunDayFraction(t: number, days: number, seasonLengthDays: number): number {
  return seasonLengthDays > 0 ? sunFractionFor(t, dayLengthHours(days, seasonLengthDays)) : (((t % 1) + 1) % 1);
}
/** Inverse: wall-clock hours of a sun hour (e.g. sun 06:00 -> that day's sunrise). */
export function wallHoursForSun(sunHours: number, dayHours: number): number {
  const s = ((sunHours % 24) + 24) % 24; const sr = 12 - dayHours / 2;
  if (s >= 6 && s <= 18) return sr + (s - 6) / 12 * dayHours;
  const night = 24 - dayHours; const since = ((s - 18) % 24 + 24) % 24; return (12 + dayHours / 2 + since / 12 * night) % 24;
}
