/**
 * Per-type vehicle size vs the player (pure). ADR-518: vehicles are drawn at TRUE real-world scale. Art's true-scale
 * pass (seats.vehicles.json `scale`) renders every vehicle at 30.29 px per metre of height (the 53 px player doll =
 * 1.75 m) and 45.25 px per footprint metre (1 tile = 1 m), so the Art sprites draw 1:1 (artScaleFor = 1, no stretch or
 * squash). The old stylized height (roof = 1.2-2.4 player heights next to a 74 px player) is retired: VEHICLE_HEIGHT_X
 * is now each def's real roof height / 1.75 m, and the procedural placeholder (model.ts) and seat z use the same scale.
 * World z: Z_PX px per z unit, so a metre of height is PX_PER_M_HEIGHT / Z_PX z units.
 */
import type { VehicleRenderDef } from "./layout.js";
import { PX_PER_M_HEIGHT, VEHICLE_SEAT_ART } from "./seats.data.js";

/** Player doll height (1x px, feet to head) = 1.75 m. */
export const PLAYER_HEIGHT_PX = 53;
export const PLAYER_HEIGHT_M = 1.75;
export const Z_PX = 16;
export const PLAYER_HEIGHT_Z = PLAYER_HEIGHT_PX / Z_PX;
/** World z units per metre of real height (30.29 px/m / 16 px per z). */
export const Z_PER_M = PX_PER_M_HEIGHT / Z_PX;

/** Roof height in player heights (= real roof m / 1.75), by def id: Art's true-scale table (ART_KEYS_VEHICLES.md). */
export const VEHICLE_HEIGHT_X: Readonly<Record<string, number>> = Object.fromEntries(Object.entries(VEHICLE_SEAT_ART).map(([k, v]) => [k, v.h / PLAYER_HEIGHT_M]));
/**
 * Defs with no true-scale Art (wagons, carts, boats: drawn-vehicle / boat art of their own, ADR-361/421) keep the legacy
 * stylized roof (1.3 x the 74 px legacy player): their art, bench heights (task361 SEAT_PX) and seats were authored
 * against it. Only the 31 repainted Art keys move to true scale.
 */
export const LEGACY_PLAYER_HEIGHT_PX = 74;
export const LEGACY_CLASS_HEIGHT_X: Readonly<Record<string, number>> = { bicycle: 0.62, car: 1.28, truck: 1.6, van: 1.7, camper: 2.0, semi: 2.3, trailer: 1.5 };
/** True-scale Art (seats.vehicles.json) for this def? */
export const isTrueScale = (d: Pick<VehicleRenderDef, "id">): boolean => VEHICLE_HEIGHT_X[d.id] !== undefined;

/** Roof height in (53 px) player heights. */
export function heightX(d: Pick<VehicleRenderDef, "id" | "class">): number { return VEHICLE_HEIGHT_X[d.id] ?? (LEGACY_CLASS_HEIGHT_X[d.class] ?? 1.3) * LEGACY_PLAYER_HEIGHT_PX / PLAYER_HEIGHT_PX; }
export function targetHeightPx(d: Pick<VehicleRenderDef, "id" | "class">): number { return heightX(d) * PLAYER_HEIGHT_PX; }
export function targetHeightZ(d: Pick<VehicleRenderDef, "id" | "class">): number { return targetHeightPx(d) / Z_PX; }
/** Target side-view size of a vehicle sprite in 1x px (length along the E/W view: 45.25 px per tile; height above the pivot). */
export function targetSpritePx(d: VehicleRenderDef): { length: number; width: number; height: number } {
  const t = 32 * Math.SQRT2; return { length: Math.round(d.footprint.length * t), width: Math.round(d.footprint.width * t), height: Math.round(targetHeightPx(d)) };
}
/** Is the vehicle taller than the player (its body may hide the player standing behind it -> Occluder fade)? */
export const tallerThanPlayer = (d: Pick<VehicleRenderDef, "id" | "class">): boolean => heightX(d) > 1;

/**
 * Sprite scale for an Art key. ADR-518: Art's sheets are authored at true scale (manifest scaleMode "native"), so every
 * Art sprite draws 1:1. (ART_HEIGHT_PX / ART_LENGTH_PX, the opaque-bbox fit tables of the pre-true-scale d40bc37 art,
 * are retired with it.)
 */
export function artScaleFor(_d?: VehicleRenderDef, _artKey?: string, _fallbackPx?: number): number { return 1; }
/** Vertical factor for vehicles.json seat z (authored against the literal 1 z = 1 m model): true-scale defs map metres
 * to z units (Z_PER_M, no stylization); legacy defs keep the stylized targetHeightZ / literal roof. */
export function seatZScale(d: VehicleRenderDef, literalRoofZ: number): number { return isTrueScale(d) ? Z_PER_M : literalRoofZ > 0 ? targetHeightZ(d) / literalRoofZ : 1; }
