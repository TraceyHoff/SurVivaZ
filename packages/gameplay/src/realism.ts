/**
 * Thin interfaces over the Engine Architect's upcoming generic realism support (Emitter/EmitterIndex,
 * BuildingGrid isCovered/enclosure/exposure, Weather.windDir/windSpeed, climateAt/ClimateModel, addSystem every/offset,
 * decayAt, modifier stacks). Gameplay owns the RULES; until the core/world code lands these adapters provide the
 * same answers from gameplay state. Swap each adapter body for the core call when it arrives (signatures pending).
 */
import { Weather, type Entity, type World } from "@engine/core";
import { Falloff } from "@engine/world";
import { Emitter } from "./components.js";
import { StationKind, WeatherKind, type PieceDef, type SmellSpec } from "./defs.js";

/** Emitter kind ids (gameplay-defined, reported to Render/Engine). Append only. */
export const enum EmitterKind { Heat = 1, Light = 2, Smell = 3 }
export interface EmitterSpec { readonly kind: EmitterKind; readonly radius: number; readonly strength: number; /** world Falloff: 0 constant, 1 linear, 2 quadratic */ readonly falloff: number }
/** ADR-216: a light piece's radius in tiles. One number drives zombie light avoidance (systems/lights.ts) and the
 *  client's rendered light (view.ts reads the replicated Emitter radius), so what you see lit is what protects you. */
export function lightRadiusOf(def: Pick<PieceDef, "lightRadius" | "heatRadius">): number {
  return def.lightRadius > 0 ? def.lightRadius : Math.max(def.heatRadius * 2, 4);
}
/** ADR-216: free-standing fired stations (spawnStation campfire/furnace) carry only a heat Emitter; this is the light
 *  radius they count with in the gameplay light grid while Fuel.lit (matches the client's "bonfire"/furnace light). */
export const STATION_LIGHT_RADIUS: Readonly<Record<number, number>> = { [StationKind.Campfire]: 8, [StationKind.Furnace]: 6 };
/** Emitters a fire/light piece carries (attached to its fire entity as core Emitter once it lands).
 * A fired piece also carries a Smell emitter (smoke) on its AttachKind.Smell sibling — the fire
 * smell spec comes from ai.smell.fire, so callers that place or light a piece pass it in. */
export function emitterSpecs(def: PieceDef, smellFire?: SmellSpec): EmitterSpec[] {
  const out: EmitterSpec[] = [];
  if (def.heat > 0) out.push({ kind: EmitterKind.Heat, radius: def.heatRadius, strength: def.heat, falloff: 0 });
  if (def.light) out.push({ kind: EmitterKind.Light, radius: lightRadiusOf(def), strength: 1, falloff: 1 });
  if (def.fired && smellFire) out.push({ kind: EmitterKind.Smell, radius: smellFire.radius, strength: smellFire.strength, falloff: Falloff.Linear });
  return out;
}

/**
 * ADR-486: attach, refresh, or remove a Smell emitter on an entity. A spec attaches (or refreshes
 * the radius/strength of) the entity's Smell emitter; undefined removes it. An entity carrying a
 * different kind of emitter (a station's Heat, a fire's Heat) is left alone — smell cannot share
 * the one-Emitter-per-entity slot, so those shapes carry their smell on a sibling instead.
 */
export function setSmellEmitter(world: World, e: Entity, spec: SmellSpec | undefined): void {
  const cur = world.get(e, Emitter);
  if (!spec) { if (cur && cur.kind === EmitterKind.Smell) world.remove(e, Emitter); return; }
  if (cur) {
    if (cur.kind !== EmitterKind.Smell) return;
    if (cur.radius !== spec.radius) world.setField(e, Emitter, "radius", spec.radius);
    if (cur.strength !== spec.strength) world.setField(e, Emitter, "strength", spec.strength);
    return;
  }
  world.add(e, Emitter, { kind: EmitterKind.Smell, radius: spec.radius, strength: spec.strength, falloff: Falloff.Linear });
}

/** Wind (tiles/s-ish 0..1 scale). Reads core Weather.windSpeed when present, else a per-kind default. */
const WIND_DEFAULT: Record<number, number> = { [WeatherKind.Clear]: 0.2, [WeatherKind.Rain]: 0.4, [WeatherKind.Storm]: 1, [WeatherKind.Snow]: 0.5, [WeatherKind.Fog]: 0.05, [WeatherKind.Overcast]: 0.25, [WeatherKind.Heat]: 0.1, [WeatherKind.Blizzard]: 1, [WeatherKind.Windy]: 0.9 };
export function windSpeed(world: World): number {
  const w = world.env(Weather) as unknown as Record<string, number>;
  return typeof w.windSpeed === "number" ? w.windSpeed : (WIND_DEFAULT[w.kind ?? 0] ?? 0.2) * (w.intensity ?? 1);
}
export const isRaining = (kind: number): boolean => kind === WeatherKind.Rain || kind === WeatherKind.Storm;
