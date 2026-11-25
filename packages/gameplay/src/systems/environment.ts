/**
 * Environment rules on top of core/world mechanisms:
 *  - clock: DayPhaseChanged from core's derived TimeOfDay;
 *  - weather: authority state machine on core Weather (kind, intensity, endsAtTick, windDir, windSpeed);
 *  - climate: GameplayClimateModel registered with world installClimate (temperature curve lives here);
 *  - exposure (every 4 ticks = 5 Hz): heat from the world EmitterIndex (sampleField, walls occlude), shelter from
 *    BuildingGrid isCovered/exposure + edge-wall enclosure, wetness, felt temperature, buff modifiers;
 *    Task 24: inside an enclosed room the fire heat is smoothed into RoomHeat (slow rise/fall), not instant.
 *  - chunk surface wetness (every 20 ticks): rises with rain, dries with wind and sun.
 * WeatherKind values are stable (renderer contract): 0 Clear, 1 Rain, 2 Storm, 3 Snow, 4 Fog, 5 Overcast, 6 Heat, 7 Blizzard, 8 Windy.
 *  - seasons (ADR-239): core Season on the environment; season weather tables + seasonal temperature live here.
 */
import { addModifier, dayNoise, entityIndex, evaluate, ModOp, Season, seasonFromDays, timeOfDay, sunFractionOf, Transform, Weather, type Entity, type SeasonInfo, type TimeOfDayInfo, type World } from "@engine/core";
import { CHUNK_SIZE, ClimateRes, climateAt, EmitterIndexRes, isWaterId, ALTITUDE_LAPSE_COLD_CAP, ALTITUDE_LAPSE_WARM_CAP, altitudeLapseEffect, type BaseClimate, type ClimateContext, type ClimateModel, type ClimateSample } from "@engine/world";
import { Buffs, ChunkSurface, Exposure, Inventory, RoomHeat, Stat, Wetness } from "../components.js";
import { fillContainer } from "../food.js";
import { listSlots } from "../inventory.js";
import { gameplayDefs, isAuthority } from "../config.js";
import { secondsToTicks, WeatherKind, isSnowing, type EnvironmentTuning, type VitalsTuning, type WeatherDef } from "../defs.js";
import { DayPhase, DayPhaseChanged, emit, WeatherChanged } from "../events.js";
import { EmitterKind, isRaining } from "../realism.js";
import { shelterAt, roomOpennessAt, type Shelter } from "../building/shelter.js";
import { waterproofOf } from "../combat/arms.js";
import { dryWetness } from "../exposure-stages.js";
import { inWater } from "./movement.js";
import { FREEZING_C, isWaterFrozen } from "../frozen.js"; // ADR-450: the constant lives in frozen.ts (cycle-free home)
import { TerrainRes, snowRemainder } from "../world.js"; // ADR-466: snow remainder + chunk-centre water check
import { isUnderground, TERRAIN } from "../terrain_depth.js";
import { wellDryCheck } from "../wells.js"; // ADR-471: well dry-drain on dry-day boundaries

export const EXPOSURE_EVERY = 4;
export const SURFACE_EVERY = 20;

export function dayPhase(t: number): DayPhase {
  if (t < 0.2 || t >= 0.85) return DayPhase.Night;
  if (t < 0.3) return DayPhase.Dawn;
  if (t < 0.75) return DayPhase.Day;
  return DayPhase.Dusk;
}

/** Time of day is derived from world.tick (core timeOfDay); this only emits phase changes. */
export function clockSystem(world: World): void {
  const before = timeOfDay(world, world.tick), after = timeOfDay(world, world.tick + 1);
  if (after.dayLengthTicks === 0) return;
  const pa = dayPhase(sunFractionOf(after));
  if (pa !== dayPhase(sunFractionOf(before))) emit(world, DayPhaseChanged, { phase: pa, day: after.day });
}

const NEUTRAL: WeatherDef = { kind: WeatherKind.Clear, weight: 0, durationSeconds: [0, 0], intensity: [0, 0], tempOffset: 0, wetnessPerSec: 0, thirstMul: 1, staminaRegenMul: 1, windSpeed: [0, 0] };
export function weatherDef(env: EnvironmentTuning, kind: WeatherKind): WeatherDef {
  return env.weather.find((w) => w.kind === kind) ?? NEUTRAL;
}

/** ADR-239: the world's season (always summer / seasons off without a Season component or seasons tuning). */
export function worldSeason(world: World, env: EnvironmentTuning = gameplayDefs(world).environment, time?: TimeOfDayInfo): SeasonInfo {
  const st = env.seasons; if (!st || !(st.lengthDays > 0) || !world.isRegistered(Season) || !world.has(world.environment, Season)) return OFF_SEASON;
  const s = world.env(Season); const t = time ?? timeOfDay(world);
  return t.dayLengthTicks > 0 ? seasonFromDays(t.day + t.t + s.offsetDays, s.lengthDays, s.blendDays) : OFF_SEASON;
}
/** Weather.endsAtTick that pins the current weather (u32 max). */
export const PINNED_WEATHER = 0xffffffff; const PINNED = PINNED_WEATHER;
const OFF_SEASON: SeasonInfo = seasonFromDays(0, 0, 0);

/** Whether `kind` may be the current weather in this season (current table, or the next one while blending into it). */
export function weatherAllowed(env: EnvironmentTuning, si: SeasonInfo, kind: number): boolean {
  const st = env.seasons; if (!st || si.lengthDays <= 0) return true;
  const inTable = (i: number): boolean => st.seasons[i]!.weather.some((d) => d.kind === kind && d.weight > 0);
  return inTable(si.index) || (si.blend > 0 && inTable(si.next));
}

/** The weather table in force (season table, crossing into the next one with probability = blend). */
function weatherTable(world: World, env: EnvironmentTuning, si: SeasonInfo): readonly WeatherDef[] {
  const st = env.seasons; if (!st || si.lengthDays <= 0) return env.weather;
  const i = si.blend > 0 && world.rng.next() < si.blend ? si.next : si.index;
  return st.seasons[i]!.weather;
}

/** Season-aware def for an active kind (current season's entry, then the next season's, then the base entry). */
export function seasonalWeatherDef(env: EnvironmentTuning, si: SeasonInfo, kind: WeatherKind): WeatherDef {
  const st = env.seasons;
  if (st && si.lengthDays > 0) for (const i of [si.index, si.next]) { const d = st.seasons[i]!.weather.find((w) => w.kind === kind); if (d) return d; }
  return weatherDef(env, kind);
}

/**
 * Authoritative weather state machine (world.rng, server only; clients receive Weather by replication).
 * ADR-239: rolls from the current season's table and re-rolls at once when the season changes under a kind it does not
 * allow (so winter snow never carries into summer).
 */
export function weatherSystem(world: World, dt: number): void {
  if (!isAuthority(world) || world.isReplaying) return;
  wellDryCheck(world); // ADR-471: wells drain on dry-day boundaries — a few integer comparisons per tick
  const w = world.env(Weather);
  const env = gameplayDefs(world).environment;
  const time = timeOfDay(world, world.tick + 1);
  const si = worldSeason(world, env, time); // the season this step ends in (like clockSystem)
  // Task 23: snow already falling re-rolls at once once the seasonal base temperature reaches freezing.
  const firstDay = timeOfDay(world).day === 0; // world age, not season age; includes loaded day-zero saves
  const rainOk = !firstDay || !isRaining(w.kind);
  const snowOk = !isSnowing(w.kind) || snowAllowed(env, si, time);
  // endsAtTick u32 max = pinned (admin / tests / ?weather=): never re-rolled by the season guard
  if (rainOk && world.tick < w.endsAtTick && (w.endsAtTick === PINNED || (weatherAllowed(env, si, w.kind) && snowOk))) return;
  const table = weatherTable(world, env, si);
  // Heat waves never roll on the first day of a season: a new game starts in summer, and a heat wave on day
  // one kills before anyone can build shelter or stock water. Heat is re-enabled once the season is a day old.
  // Task 23: snow / blizzard never roll while the seasonal base temperature is at or above freezing.
  const rollTable = table.map((d) => {
    if (firstDay && isRaining(d.kind)) return { ...d, weight: 0 };
    if (d.kind === WeatherKind.Heat && si.lengthDays > 0 && si.into < 1) return { ...d, weight: 0 };
    if (isSnowing(d.kind) && !snowAllowed(env, si, time)) return { ...d, weight: 0 };
    return d;
  });
  // A custom all-rain table still needs a dry fallback on day zero.
  const def = rollTable.some((d) => d.weight > 0) ? rollTable[weightedIndex(world, rollTable.map((d) => d.weight))]! : NEUTRAL;
  const from = w.kind as WeatherKind;
  w.kind = def.kind;
  w.intensity = world.rng.range(def.intensity[0], def.intensity[1]);
  w.windSpeed = world.rng.range(def.windSpeed[0], def.windSpeed[1]);
  w.windDir = world.rng.range(-Math.PI, Math.PI);
  const ticks = secondsToTicks(world.rng.range(def.durationSeconds[0], def.durationSeconds[1]), dt);
  w.endsAtTick = world.tick + ticks + 1;
  emit(world, WeatherChanged, { from, to: def.kind, intensity: w.intensity, ticks });
}

function weightedIndex(world: World, weights: readonly number[]): number {
  let total = 0; for (const x of weights) total += Math.max(0, x);
  let r = world.rng.next() * total;
  for (let i = 0; i < weights.length; i++) { r -= Math.max(0, weights[i]!); if (r < 0) return i; }
  return weights.length - 1;
}

/** Smooth per-day noise in [-1, 1] (cosine-interpolated between day centres; same on server and clients). */
function dailyNoise(days: number): number {
  const d = days - 0.5; const d0 = Math.floor(d); const f = d - d0; const k = (1 - Math.cos(Math.PI * f)) / 2;
  return dayNoise(d0, 239) * (1 - k) + dayNoise(d0 + 1, 239) * k;
}

/** Task 23: freezing point (deg C) — snow may only fall below it (32F). The constant lives in
 * frozen.ts (ADR-450); re-exported here so guide.ts / spoilage.ts keep importing it from this module. */
export { FREEZING_C };

/**
 * ADR-239 seasonal base air temperature (deg C): the blended season curve (mean + day/night + per-day noise),
 * clamped to the blended season tempRange. No weather offset: rain cools below the range and heat waves rise above
 * it (see seasonalTemperature). `bandDelta` = biome band temperature - baseTemp.
 */
export function seasonalBaseTemp(env: EnvironmentTuning, si: SeasonInfo, time: TimeOfDayInfo, bandDelta = 0): number {
  const st = env.seasons;
  if (!st || si.lengthDays <= 0) return env.baseTemp + bandDelta + env.dayNightAmplitude * -Math.cos(2 * Math.PI * time.t);
  const curve = -Math.cos(2 * Math.PI * (time.t - 0.04)); // coldest just before dawn-ish, warmest early afternoon
  const noise = dailyNoise(time.day + time.t);
  let t = 0, lo = 0, hi = 0;
  for (let i = 0; i < st.seasons.length; i++) {
    const wgt = si.weights[i]!; if (wgt <= 0) continue; const s = st.seasons[i]!;
    t += wgt * (s.meanTemp + s.dayNightAmplitude * curve + s.dailyVariation * noise); lo += wgt * s.tempRange[0]; hi += wgt * s.tempRange[1];
  }
  return Math.min(hi, Math.max(lo, t + st.bandScale * bandDelta));
}

/**
 * ADR-239 seasonal air temperature (deg C) from the season weights, time of day, a per-day random swing and the weather.
 * Without seasons: the legacy baseTemp + day/night + weather curve. Task 23: the weather offset applies after the
 * seasonal clamp, so rain cools below the season's range and a heat wave clamps into its own band (summer 89-100F).
 * `bandDelta` = biome band temperature - baseTemp.
 */
export function seasonalTemperature(env: EnvironmentTuning, si: SeasonInfo, time: TimeOfDayInfo, weather: { kind: number; intensity: number }, bandDelta = 0): number {
  const st = env.seasons;
  if (!st || si.lengthDays <= 0) return seasonalBaseTemp(env, si, time, bandDelta) + weatherDef(env, weather.kind as WeatherKind).tempOffset * weather.intensity;
  const kind = weather.kind as WeatherKind;
  let t = seasonalBaseTemp(env, si, time, bandDelta) + seasonalWeatherDef(env, si, kind).tempOffset * weather.intensity;
  if (kind === WeatherKind.Heat) {
    let hlo = 0, hhi = 0, hw = 0;
    for (let i = 0; i < st.seasons.length; i++) {
      const wgt = si.weights[i]!; const range = st.seasons[i]!.heatWaveRange; if (wgt <= 0 || !range) continue;
      hlo += wgt * range[0]; hhi += wgt * range[1]; hw += wgt;
    }
    if (hw > 0) t = Math.min(hhi / hw, Math.max(hlo / hw, t));
  }
  return t;
}

/** Task 23: snow / blizzard may fall only while the seasonal base temperature is below freezing. */
export function snowAllowed(env: EnvironmentTuning, si: SeasonInfo, time: TimeOfDayInfo, bandDelta = 0): boolean {
  return seasonalBaseTemp(env, si, time, bandDelta) < FREEZING_C;
}

/** Gameplay temperature/humidity curves for world climateAt: season + biome band + altitude + day/night + weather. */
export function gameplayClimateModel(env: EnvironmentTuning, world?: World): ClimateModel {
  return {
    sample(b: BaseClimate, ctx: ClimateContext): ClimateSample {
      const wd = weatherDef(env, ctx.weather.kind as WeatherKind);
      const si = world ? worldSeason(world, env, ctx.time) : OFF_SEASON;
      return {
        temperature: seasonalTemperature(env, si, ctx.time, ctx.weather, b.temperature - env.baseTemp) + altitudeLapseEffect(b.altitude, env.altitudeLapse, env.altitudeLapseColdCap ?? ALTITUDE_LAPSE_COLD_CAP, env.altitudeLapseWarmCap ?? ALTITUDE_LAPSE_WARM_CAP),
        humidity: Math.min(1, b.humidity + env.humidityPerIntensity * (wd.wetnessPerSec > 0 ? ctx.weather.intensity : 0)),
        altitude: b.altitude, windDir: ctx.weather.windDir, windSpeed: ctx.weather.windSpeed,
        weatherKind: ctx.weather.kind, weatherIntensity: ctx.weather.intensity,
      };
    },
  };
}

/** Air temperature (deg C) at a position: world climate if installed, else baseTemp through the same model.
 * ADR-263: underground (dug >= 3 levels below ground) is a constant 60°F, independent of season / weather / time of day. */
export function ambientTemperature(world: World, x = 0, y = 0): number {
  if (isUnderground(world, x, y)) return TERRAIN.undergroundTempC; // ADR-263: 60°F year-round >= 3 levels below ground
  return surfaceTemperature(world, x, y);
}
/** ADR-263: open-air (surface) temperature at a position, ignoring the underground override (world-wide frost checks). */
export function surfaceTemperature(world: World, x = 0, y = 0): number {
  if (world.getResource(ClimateRes)) return climateAt(world, x, y).temperature;
  const env = gameplayDefs(world).environment; const w = world.env(Weather); const time = timeOfDay(world);
  return seasonalTemperature(env, worldSeason(world, env, time), time, w);
}

/** ADR-488: humidity (0..1) at a position — the band base plus the wet-weather bonus, via the same
 * climateAt sample as the temperature. Without a ClimateRes there is no band to read, so the 0.5
 * band default (defs.ts) applies everywhere. */
export function ambientHumidity(world: World, x = 0, y = 0): number {
  return world.getResource(ClimateRes) ? climateAt(world, x, y).humidity : 0.5;
}

/** ADR-488: damp air dries clothes slower — `max(0.25, 1 - humidity)`, floored so drying in the
 * dampest lowlands (humidity 0.9) runs at a quarter rate instead of stalling at a tenth. */
export function humidityDryMul(humidity: number): number { return Math.max(0.25, 1 - humidity); }

/** ADR-488: damp air rots food faster — decay x `(1 + humidity)`, up to twice as fast in the dampest places. */
export function humiditySpoilMul(humidity: number): number { return 1 + humidity; }

/**
 * Task 23: the shelter's pull on air temperature at a tile (deg C): roof shade/warmth + wall insulation, toward
 * comfort (solid walls insulate twice as well as window walls, and each material tier insulates more than the last).
 * Pure, so the HUD gauge and the character sheet share the exact shift the exposure system applies.
 */
export function shelterTempShift(sh: Shelter, ambient: number, vt: VitalsTuning, shelterBonus: number): number {
  // ADR-239: shelter warms when it is cold and shades (cools) when the air is above the comfort band
  // ADR-312: in the heat the shade (sun exposure: roof first) cools; in the cold the walls + roof (exposure) warm.
  const shelter = ambient > vt.comfortMax ? (1 - sh.sun) * -shelterBonus : (1 - sh.exposure) * shelterBonus;
  // Wall insulation pulls felt toward comfort, scaled by how sheltered the spot is (full inside, none in the open).
  const wallShift = sh.insulation * (1 - sh.exposure) * (ambient > vt.comfortMax ? -1 : ambient < vt.comfortMin ? 1 : 0);
  return shelter + wallShift;
}

/**
 * Task 23: the air temperature where a body stands — outdoor air pulled by shelter (roof + walls); a fully enclosed
 * roofed room clamps to the comfort band, like felt. Display only: felt temperature (exposureSystem) adds clothing
 * insulation, fire heat, wetness and wind on top of this. Task 24: `fireHeat` is the room's smoothed flame heat
 * (RoomHeat) — inside an enclosed room it adds on top of the clamped indoor base, so a lit fire warms the room
 * the gauge shows; outdoors it is always 0.
 */
export function shelteredAirTemp(world: World, x: number, y: number, z = 0, windDir?: number, fireHeat = 0): { temp: number; sheltered: boolean; enclosed: boolean; exposure: number } {
  const env = gameplayDefs(world).environment; const vt = gameplayDefs(world).vitals;
  const ambient = ambientTemperature(world, x, y);
  const sh = shelterAt(world, x, y, z, windDir);
  const t = ambient + shelterTempShift(sh, ambient, vt, env.shelterTempBonus);
  const enclosed = sh.exposure === 0;
  return { temp: enclosed ? Math.min(vt.comfortMax, Math.max(vt.comfortMin, t)) + fireHeat : t, sheltered: sh.exposure < 1, enclosed, exposure: sh.exposure };
}
export function threatLevel(world: World): number {
  return dayPhase(sunFractionOf(timeOfDay(world))) === DayPhase.Night ? gameplayDefs(world).environment.nightThreatMul : 1;
}

/** Heat (deg C) at a position from Heat emitters (lit fires), walls occlude. */
export function heatAt(world: World, x: number, y: number, z = 0): number {
  return world.getResource(EmitterIndexRes)?.sampleField(EmitterKind.Heat, x, y, z) ?? 0;
}

/**
 * Task 24: flame heat of an enclosed room rises and falls slowly, not instantly. A lit campfire (18C at its
 * centre, linear falloff over 4 tiles) warms a small sealed room to a cozy ~15C above the clamped indoor base;
 * a fireplace (22C / 5 tiles) warms a little more, a torch stand (4C / 1.5 tiles) barely registers.
 * Time constant: 63% of the way in 2 minutes, ~95% in 6 minutes; the same rate cooling when the fire goes out.
 * ADR-440: open windows / doors ventilate the room — the target and the time constant both scale by the
 * ventilation factor (1 / (1 + 3 * openness)), so a leaky room settles lower and faster, but its initial warming
 * slope (target / tau) never exceeds the sealed room's.
 */
export const FIRE_HEAT_TAU_S = 120;
/** Cap on the smoothed room-heat contribution (deg C): a room full of fires tops out 15C above its indoor base. */
export const FIRE_HEAT_MAX_C = 15;
/** ADR-440: ventilation gain — openness o scales the room's heat exchange by 1 / (1 + 3o). */
export const VENT_TAU_GAIN = 3;
/** ADR-440: ventilation factor of a room openness 0 (sealed) .. 1 (fully open): 1 sealed, 1/4 fully open. */
export function roomHeatVentFactor(openness: number): number {
  return 1 / (1 + VENT_TAU_GAIN * Math.min(1, Math.max(0, openness)));
}
/** ADR-440: effective RoomHeat time constant (s) at an openness: 120 s sealed, 30 s fully open. */
export function roomHeatTau(openness: number): number {
  return FIRE_HEAT_TAU_S * roomHeatVentFactor(openness);
}
/** Exponential approach of `current` toward `target` over `dt` seconds (pure; shared by the exposure system). */
export function approachRoomHeat(current: number, target: number, dt: number, tauS: number = FIRE_HEAT_TAU_S): number {
  if (!(dt > 0)) return current;
  return current + (target - current) * (1 - Math.exp(-dt / tauS));
}
/** Legacy 0–10°F climate references; ADR-277 removed direct air-temperature damage. */
export const COLD_DAMAGE_LO_C = ((0 - 32) * 5) / 9;
export const COLD_DAMAGE_HI_C = ((10 - 32) * 5) / 9;
/** Legacy insulation reference. All insulation now affects felt drift, not a binary HP-damage gate. */
export const COLD_DAMAGE_INSULATION_C = 10;

/**
 * Task 31: wet clothing insulates less — at full wetness it keeps only half its insulation (felt-temperature
 * shift only). Worn gear shares the wearer's
 * wetness, so it dries with them — no per-item wetness state.
 */
export const WET_INSULATION_LOSS = 0.5;
/** Task 33: wetness gained per second standing in a water tile — faster than rain (0.02/s) or a storm
 * (0.05/s), so wading soaks you in ~7s. Applies even in clear weather; shelter does not cover a swim. */
export const WATER_WET_PER_SEC = 0.15;
/** Effective insulation at a wetness level (0 dry .. 1 soaked); shared by the exposure system and the sheet. */
export function effectiveInsulation(insulation: number, wetness: number): number {
  return insulation * (1 - WET_INSULATION_LOSS * Math.min(1, Math.max(0, wetness)));
}

/**
 * Per entity, every EXPOSURE_EVERY ticks (dt = dt x every): wetness, felt temperature, buffs.
 * Deterministic from replicated state, so the owning client may run it for prediction.
 */
export function exposureSystem(world: World, dt: number): void {
  const defs = gameplayDefs(world); const env = defs.environment; const vt = defs.vitals;
  const w = world.env(Weather); const wdef = weatherDef(env, w.kind as WeatherKind);
  const tf = world.store(Transform); const ex = world.store(Exposure);
  // Task 29: hoisted per-run invariants. Without a ClimateRes the ambient temperature is the same
  // everywhere (seasonalTemperature ignores position), so compute it once instead of per entity
  // (~3.7us a call: gameplayDefs + env + timeOfDay + worldSeason + seasonalTemperature).
  const hasClimate = !!world.getResource(ClimateRes);
  const ambient0 = hasClimate ? undefined : ambientTemperature(world);
  const hasRoomHeat = world.isRegistered(RoomHeat);
  const emitters = world.getResource(EmitterIndexRes);
  const expires = world.tick + EXPOSURE_EVERY * 2 + 1;
  for (const e of world.query([Exposure, Transform])) {
    const idx = entityIndex(e); const s = ex.slot(idx); const ts = tf.slot(idx);
    const x = tf.data.x[ts]!, y = tf.data.y[ts]!, z = tf.data.z[ts]!;
    // ADR-488: one climate sample per occupant per pass — the ambient temperature below and the
    // humidity the drying rate reads share it (no extra sample when a ClimateRes is installed).
    const sample = hasClimate ? climateAt(world, x, y) : undefined;
    const heat = emitters?.sampleField(EmitterKind.Heat, x, y, z) ?? 0;
    const sh = shelterAt(world, x, y, z, w.windDir);
    // Task 24: inside a fully enclosed room the fire's heat is not instant — the room itself warms over
    // minutes (RoomHeat, eased toward the live fire heat; walls occlude, so only fires in the same room
    // count) and cools back down when the fire goes out. Outdoors the instant heat still applies as before.
    // ADR-440: ventilation — open windows / doors lower the room's heat target and shorten its time constant
    // (both scale by the same factor, so a leaky room never warms faster than a sealed one at first); an open
    // room or roofless spot holds no heat, and stored heat vents away fast when a door or shutter is opened.
    const enclosed = sh.exposure === 0;
    const prevHeat = hasRoomHeat ? (world.getField(e, RoomHeat, "heat") ?? 0) : 0;
    // ADR-456: room openness, hoisted — the room-heat vent factor and the sealed-smoke check share
    // one call per occupant per pass (ADR-440 pins: sealed 0, one closed-shutter window 0.0375,
    // one open shutter 0.15, one open door 0.25, roofless/outdoors 1).
    const openness = roomOpennessAt(world, x, y, z);
    const vent = roomHeatVentFactor(openness);
    const roomHeat = approachRoomHeat(prevHeat, enclosed ? Math.min(heat, FIRE_HEAT_MAX_C) * vent : 0, dt, FIRE_HEAT_TAU_S * vent);
    // Write on any change (at equilibrium approachRoomHeat returns the current value exactly, so this stops
    // on its own). A fixed epsilon here would freeze the tail: the per-call delta shrinks with the value.
    if (hasRoomHeat && roomHeat !== prevHeat) {
      if (world.has(e, RoomHeat)) world.setField(e, RoomHeat, "heat", roomHeat);
      else world.add(e, RoomHeat, { heat: roomHeat });
    }
    let wet = ex.data.wetness[s]!;
    // Task 33: standing in a water tile wets you (and your worn gear, which shares your wetness) even when
    // it is not raining. Drying afterwards follows the existing rules below (indoors / by a fire).
    if (inWater(world, x, y)) wet += WATER_WET_PER_SEC * dt;
    // ADR-312: rain / snow wets in proportion to rain exposure (a roof overhead blocks most of it).
    else if (wdef.wetnessPerSec > 0 && sh.rain > 0) wet += wdef.wetnessPerSec * w.intensity * sh.rain * (1 - waterproofOf(world, e)) * dt;
    // ADR-465: wind dries you too when you are unsheltered from it (sh.wind > 0) — same shape as the
    // ground wind-drying in chunkSurfaceSystem (surface.windDryMul), so a windy day dries wet clothes.
    // ADR-488: damp air dries clothes slower (humidityDryMul, floored at 0.25); no ClimateRes reads
    // the 0.5 band default. Clothes only in v1 — ground drying (chunkSurfaceSystem) is untouched.
    else wet = dryWetness(wet, dt, env.dryPerSec * (heat > 0 ? env.heatDryMul : 1) * (sh.wind > 0 ? 1 + env.surface.windDryMul * w.windSpeed / env.surface.windDryRefSpeed : 1) * humidityDryMul(sample?.humidity ?? 0.5));
    wet = Math.min(1, Math.max(0, wet));
    const ambient = isUnderground(world, x, y) ? TERRAIN.undergroundTempC : ambient0 ?? sample!.temperature; // ADR-263
    // Task 23: clothing insulation pulls felt toward the comfort band — it warms in the cold and shades in the heat
    // (a fur coat no longer cooks its wearer in a heat wave); higher tiers insulate more (items.json).
    // Task 31: wet clothing insulates less (effectiveInsulation); all worn insulation contributes continuously.
    const ins = ex.data.insulation[s]!;
    // ADR-472 (fixes the ADR-458 wiring gap): the hot-meal Insulation buff is a Buffs modifier — it
    // was written at eat time but never evaluated anywhere, so hot meals did nothing in live play.
    // Evaluate it into the worn-gear insulation here, so a hot meal actually warms the eater.
    const insWithBuffs = evaluate(world, e, Buffs, Stat.Insulation, ins);
    const insShift = ambient > vt.comfortMax ? -effectiveInsulation(insWithBuffs, wet) : ambient < vt.comfortMin ? effectiveInsulation(insWithBuffs, wet) : 0;
    let felt = ambient + insShift + shelterTempShift(sh, ambient, vt, env.shelterTempBonus)
      - env.wetChill * wet - env.windChillPerSpeed * Math.sqrt(Math.max(0, w.windSpeed)) * sh.wind // ADR-312: walls block the wind
      // ADR-472: wet x wind synergy — soaked in a gale loses extra heat on top of the additive wet
      // and wind terms (windWetSynergyMul of the wind term again, scaled by wetness; walls block it too).
      - env.windChillPerSpeed * Math.sqrt(Math.max(0, w.windSpeed)) * wet * env.windWetSynergyMul * sh.wind;
    // Fully enclosed + roofed: protected from the elements and from death by them — felt never leaves the comfort
    // band, except for the room's own fire heat on top (a sealed room with a roaring fire can still overheat).
    if (enclosed) felt = Math.min(vt.comfortMax, Math.max(vt.comfortMin, felt)) + roomHeat;
    else felt += heat;
    ex.data.wetness[s] = wet; ex.data.feltTemp[s] = felt; ex.data.sheltered[s] = Math.round(sh.factor * 100); /* ADR-312: shelter percent 0..100 (HUD icon) */ ex.markChanged(idx);

    // ADR-452: rain fills open water — a carried liquid container gains +1 sip per
    // rainFillSecondsPerSip of unsheltered rain (one deterministic roll per exposure tick, first
    // container with room). Hooks this existing pass (sh.rain already computed); no new scan.
    // Rain water is untreated, so fillContainer reverts a boiled container to its raw variant.
    // Ground / storage containers are out of scope. Bots fill too — same code path, they carry
    // containers like players.
    if (isRaining(w.kind) && sh.rain > 0 && world.has(e, Inventory)) {
      if (world.rngFor("rainfill", e).next() < dt / env.rainFillSecondsPerSip) {
        for (const sl of listSlots(world, e)) {
          const max = defs.items.get(sl.item)?.sips ?? 0;
          if (max > 0 && sl.durability < max) { fillContainer(world, e, sl.slot, 1); break; }
        }
      }
    }

    // ADR-277: felt temperature drives body-temperature progression; no instant air damage.

    // render-facing wetness (only write on change)
    const lvl = Math.round(wet * 255);
    if (world.getField(e, Wetness, "level") === undefined) world.add(e, Wetness, { level: lvl });
    else if (world.getField(e, Wetness, "level") !== lvl) world.setField(e, Wetness, "level", lvl);

    // buffs: one Mul per stat, refreshed while the condition holds and lapsing on their own otherwise
    const thirst = wdef.thirstMul * (felt > vt.comfortMax ? vt.heatThirstMul : 1);
    const hunger = felt < vt.comfortMin ? vt.coldHungerMul : 1;
    const regen = (sh.covered ? 1 : wdef.staminaRegenMul) * (wet >= env.wetBuffThreshold ? 0.9 : 1);
    setMul(world, e, Stat.ThirstRate, thirst, expires);
    setMul(world, e, Stat.HungerRate, hunger, expires);
    setMul(world, e, Stat.StaminaRegen, regen, expires);

    // ADR-456: smoke in a sealed room — a roaring fire (heat >= smoke.heatC: close to a lit campfire
    // at 18 or fireplace at 22; a torch at 4 never counts) in a sealed-ish room (openness <=
    // smoke.openness) hurts at smoke.hpPerSec * (1 - openness) hp/s. Stateless v1: a HealthRegen
    // Add modifier (the sick-food pattern), refreshed while the condition holds and lapsing on its
    // own ~9 ticks after a door/shutter is opened or the fire goes out. No accumulator, no new
    // component. Threshold 0.1 (not the SCOPE's 0.25): ADR-440 pins one open door at 0.25 and one
    // open shutter at 0.15, so 0.25 would still smoke with the door open; 0.1 sits between one
    // closed-shutter window (0.0375, still smokes) and one open shutter (0.15, vents). Bots share
    // this pass, so a bot in a sealed room with a roaring fire is hurt the same way.
    if (heat >= env.smoke.heatC && openness <= env.smoke.openness) {
      addModifier(world, e, Buffs, { stat: Stat.HealthRegen, op: ModOp.Add, value: -env.smoke.hpPerSec * (1 - openness), expiresAtTick: expires });
    }
  }
}
function setMul(world: World, e: Entity, stat: Stat, value: number, expiresAtTick: number): void {
  addModifier(world, e, Buffs, { stat, op: ModOp.Mul, value, expiresAtTick });
}

/** Per-chunk surface wetness 0..1 (u8) and snow depth 0..255 (u8), authority, every SURFACE_EVERY ticks. */
export function chunkSurfaceSystem(world: World, dt: number): void {
  if (!isAuthority(world)) return;
  const env = gameplayDefs(world).environment; const w = world.env(Weather);
  const curve = -Math.cos(2 * Math.PI * sunFractionOf(timeOfDay(world)));
  const sun = w.kind === WeatherKind.Clear || w.kind === WeatherKind.Heat ? Math.max(0, curve) : 0;
  const rain = isRaining(w.kind) ? env.surface.rainPerSec * w.intensity : 0;
  const dry = env.surface.dryPerSec * (1 + env.surface.windDryMul * w.windSpeed + env.surface.sunDryMul * sun);
  const delta = (rain - (rain > 0 ? 0 : dry)) * dt;
  // ADR-466: snow piles up while it snows and melts when the seasonal base temperature is above
  // freezing — frozen ground holds its snow, so there is no melt while the waters are frozen.
  // Snow and melt are mutually exclusive in practice (snow only rolls below freezing), but the
  // code nets them. Both rates are far below one u8 unit per pass, so the fraction is carried in
  // the runtime-only snow remainder (world.ts) and only whole units reach the component.
  const snowRate = isSnowing(w.kind) ? env.surface.snowPerSec * w.intensity * dt : 0;
  const time = timeOfDay(world);
  const melting = seasonalBaseTemp(env, worldSeason(world, env, time), time) > FREEZING_C && !isWaterFrozen(world);
  const meltRate = melting ? env.surface.meltPerSec * dt : 0;
  if (delta === 0 && snowRate === 0 && meltRate === 0) return;
  const st = world.store(ChunkSurface);
  const rem = snowRemainder(world);
  const terrain = world.getResource(TerrainRes);
  for (let k = 0; k < st.size; k++) {
    const e = st.dense[k]!;
    // --- snow depth (ADR-466) ---
    let wetWhole = 0; // whole wetness units released by meltwater this pass
    if (snowRate > 0 || meltRate > 0) {
      const r = rem.get(e) ?? { snow: 0, wet: 0 };
      // Snow does not accumulate on chunks whose centre is water (a lake chunk stays a lake);
      // without a terrain there is nothing to check, so snow falls (the test-world case).
      const cx = st.data.cx[k]!, cy = st.data.cy[k]!;
      const centreWater = terrain ? isWaterId(terrain.tileAt(cx * CHUNK_SIZE + CHUNK_SIZE / 2, cy * CHUNK_SIZE + CHUNK_SIZE / 2)) : false;
      const before = st.data.snow[k]! + r.snow;
      let total = before;
      if (snowRate > 0 && !centreWater) total += snowRate;
      if (meltRate > 0 && total > 0) total -= meltRate;
      const clamped = Math.max(0, Math.min(255, total));
      const next = Math.floor(clamped + 1e-9); // epsilon: float error must not flip the floor at exact integers
      const melted = Math.max(0, before - clamped); // the actual snow decrease this pass (float)
      r.snow = Math.max(0, clamped - next); // [0, 1); 0 when clamped at either end (excess / loss discarded)
      r.wet += melted * env.surface.meltWetMul;
      wetWhole = Math.floor(r.wet);
      r.wet -= wetWhole;
      if (next !== st.data.snow[k]) { st.data.snow[k] = next; st.markChanged(entityIndex(e)); }
      if (r.snow > 0 || r.wet > 0) rem.set(e, r); else rem.delete(e);
    }
    // --- wetness (existing rain/dry) ---
    const cur = st.data.wetness[k]! / 255; const next = Math.round(Math.min(1, Math.max(0, cur + delta)) * 255);
    // sub-step accumulation: u8 resolution is 1/255; guarantee progress on slow drying
    const v = next === st.data.wetness[k] && delta !== 0 ? Math.min(255, Math.max(0, next + Math.sign(delta) * (Math.abs(delta) * 255 >= 0.5 ? 1 : 0))) : next;
    if (v !== st.data.wetness[k]) { st.data.wetness[k] = v; st.markChanged(entityIndex(e)); }
    // --- meltwater (ADR-466): released wetness units are a separate write, so the same pass's
    // drying cannot eat them — a melted drift leaves the ground damp (spring mud season) ---
    if (wetWhole > 0) {
      const nv = Math.min(255, st.data.wetness[k]! + wetWhole);
      if (nv !== st.data.wetness[k]) { st.data.wetness[k] = nv; st.markChanged(entityIndex(e)); }
    }
  }
  // prune remainders whose surface is gone (despawnChunkSurface deletes the primary entry)
  if (rem.size > st.size) { const live = new Set(st.dense.slice(0, st.size)); for (const key of rem.keys()) if (!live.has(key)) rem.delete(key); }
}
