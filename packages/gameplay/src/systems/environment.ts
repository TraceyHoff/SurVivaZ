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
import { addModifier, dayNoise, entityIndex, ModOp, Season, seasonFromDays, timeOfDay, Transform, Weather, type Entity, type SeasonInfo, type TimeOfDayInfo, type World } from "@engine/core";
import { ClimateRes, climateAt, EmitterIndexRes, type BaseClimate, type ClimateContext, type ClimateModel, type ClimateSample } from "@engine/world";
import { Buffs, ChunkSurface, Exposure, RoomHeat, Stat, Wetness } from "../components.js";
import { gameplayDefs, isAuthority } from "../config.js";
import { secondsToTicks, WeatherKind, isSnowing, type EnvironmentTuning, type VitalsTuning, type WeatherDef } from "../defs.js";
import { DayPhase, DayPhaseChanged, emit, WeatherChanged } from "../events.js";
import { EmitterKind, isRaining } from "../realism.js";
import { shelterAt, type Shelter } from "../building/shelter.js";
import { waterproofOf } from "../combat/arms.js";
import { dryWetness } from "../exposure-stages.js";
import { inWater } from "./movement.js";
import { isUnderground, TERRAIN } from "../terrain_depth.js";

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
  const pa = dayPhase(after.t);
  if (pa !== dayPhase(before.t)) emit(world, DayPhaseChanged, { phase: pa, day: after.day });
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

/** Task 23: freezing point (deg C) — snow may only fall below it (32F). */
export const FREEZING_C = 0;

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
        temperature: seasonalTemperature(env, si, ctx.time, ctx.weather, b.temperature - env.baseTemp) - env.altitudeLapse * b.altitude,
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

/**
 * Task 23: the shelter's pull on air temperature at a tile (deg C): roof shade/warmth + wall insulation, toward
 * comfort (solid walls insulate twice as well as window walls, and each material tier insulates more than the last).
 * Pure, so the HUD gauge and the character sheet share the exact shift the exposure system applies.
 */
export function shelterTempShift(sh: Shelter, ambient: number, vt: VitalsTuning, shelterBonus: number): number {
  // ADR-239: shelter warms when it is cold and shades (cools) when the air is above the comfort band
  const shelter = (1 - sh.exposure) * (ambient > vt.comfortMax ? -shelterBonus : shelterBonus);
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
  return dayPhase(timeOfDay(world).t) === DayPhase.Night ? gameplayDefs(world).environment.nightThreatMul : 1;
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
 */
export const FIRE_HEAT_TAU_S = 120;
/** Cap on the smoothed room-heat contribution (deg C): a room full of fires tops out 15C above its indoor base. */
export const FIRE_HEAT_MAX_C = 15;
/** Exponential approach of `current` toward `target` over `dt` seconds (pure; shared by the exposure system). */
export function approachRoomHeat(current: number, target: number, dt: number): number {
  if (!(dt > 0)) return current;
  return current + (target - current) * (1 - Math.exp(-dt / FIRE_HEAT_TAU_S));
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
    const heat = emitters?.sampleField(EmitterKind.Heat, x, y, z) ?? 0;
    const sh = shelterAt(world, x, y, z, w.windDir);
    // Task 24: inside a fully enclosed room the fire's heat is not instant — the room itself warms over
    // minutes (RoomHeat, eased toward the live fire heat; walls occlude, so only fires in the same room
    // count) and cools back down when the fire goes out. Outdoors the instant heat still applies as before.
    const enclosed = sh.exposure === 0;
    const prevHeat = hasRoomHeat ? (world.getField(e, RoomHeat, "heat") ?? 0) : 0;
    const roomHeat = approachRoomHeat(prevHeat, enclosed ? Math.min(heat, FIRE_HEAT_MAX_C) : 0, dt);
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
    else if (wdef.wetnessPerSec > 0 && sh.exposure > 0) wet += wdef.wetnessPerSec * w.intensity * sh.exposure * (1 - waterproofOf(world, e)) * dt;
    else wet = dryWetness(wet, dt, env.dryPerSec * (heat > 0 ? env.heatDryMul : 1));
    wet = Math.min(1, Math.max(0, wet));
    const ambient = isUnderground(world, x, y) ? TERRAIN.undergroundTempC : ambient0 ?? ambientTemperature(world, x, y); // ADR-263
    // Task 23: clothing insulation pulls felt toward the comfort band — it warms in the cold and shades in the heat
    // (a fur coat no longer cooks its wearer in a heat wave); higher tiers insulate more (items.json).
    // Task 31: wet clothing insulates less (effectiveInsulation); all worn insulation contributes continuously.
    const ins = ex.data.insulation[s]!;
    const insShift = ambient > vt.comfortMax ? -effectiveInsulation(ins, wet) : ambient < vt.comfortMin ? effectiveInsulation(ins, wet) : 0;
    let felt = ambient + insShift + shelterTempShift(sh, ambient, vt, env.shelterTempBonus)
      - env.wetChill * wet - env.windChillPerSpeed * Math.sqrt(Math.max(0, w.windSpeed)) * sh.exposure;
    // Fully enclosed + roofed: protected from the elements and from death by them — felt never leaves the comfort
    // band, except for the room's own fire heat on top (a sealed room with a roaring fire can still overheat).
    if (enclosed) felt = Math.min(vt.comfortMax, Math.max(vt.comfortMin, felt)) + roomHeat;
    else felt += heat;
    ex.data.wetness[s] = wet; ex.data.feltTemp[s] = felt; ex.data.sheltered[s] = sh.covered ? 1 : 0; ex.markChanged(idx);

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
  }
}
function setMul(world: World, e: Entity, stat: Stat, value: number, expiresAtTick: number): void {
  addModifier(world, e, Buffs, { stat, op: ModOp.Mul, value, expiresAtTick });
}

/** Per-chunk surface wetness 0..1 (u8), authority, every SURFACE_EVERY ticks. */
export function chunkSurfaceSystem(world: World, dt: number): void {
  if (!isAuthority(world)) return;
  const env = gameplayDefs(world).environment; const w = world.env(Weather);
  const curve = -Math.cos(2 * Math.PI * timeOfDay(world).t);
  const sun = w.kind === WeatherKind.Clear || w.kind === WeatherKind.Heat ? Math.max(0, curve) : 0;
  const rain = isRaining(w.kind) ? env.surface.rainPerSec * w.intensity : 0;
  const dry = env.surface.dryPerSec * (1 + env.surface.windDryMul * w.windSpeed + env.surface.sunDryMul * sun);
  const delta = (rain - (rain > 0 ? 0 : dry)) * dt;
  if (delta === 0) return;
  const st = world.store(ChunkSurface);
  for (let k = 0; k < st.size; k++) {
    const cur = st.data.wetness[k]! / 255; const next = Math.round(Math.min(1, Math.max(0, cur + delta)) * 255);
    // sub-step accumulation: u8 resolution is 1/255; guarantee progress on slow drying
    const v = next === st.data.wetness[k] && delta !== 0 ? Math.min(255, Math.max(0, next + Math.sign(delta) * (Math.abs(delta) * 255 >= 0.5 ? 1 : 0))) : next;
    if (v !== st.data.wetness[k]) { st.data.wetness[k] = v; st.markChanged(entityIndex(st.dense[k]!)); }
  }
}
