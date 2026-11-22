/**
 * ADR-519: vehicle paint. Art's sheets are greyscale-neutral where the paint goes (tintmask R = 1) and carry a per-vehicle
 * paint contract (paint.data.ts): out = base * mix(1, color / neutral, strength * mask.r), colour from a tint set.
 * Gameplay stores a paint pick on Vehicle.paint (1..240, 0 = none yet); the colour is set[(pick - 1) % set.length], so
 * every pick maps uniformly onto both the 12-colour car set and the 10-colour bike set. No pick = Art's defaultIndex.
 */
import { VEHICLE_PAINT, VEHICLE_PAINT_SETS } from "./paint.data.js";

export interface VehiclePaint { /** Sprite.tint, RGBA8 0xRRGGBBAA */ tint: number; neutral: number; strength: number; rgb: number }

/** Paint of an Art vehicle sprite key for a gameplay pick (0 / undefined = Art's default colour); undefined = no contract. */
export function vehiclePaint(artKey: string, pick?: number): VehiclePaint | undefined {
  const c = VEHICLE_PAINT[artKey]; if (!c) return undefined;
  const set = VEHICLE_PAINT_SETS[c[0]]; if (!set?.length) return undefined;
  const i = pick && pick > 0 ? (pick - 1) % set.length : Math.min(Math.max(0, c[1]), set.length - 1);
  const rgb = set[i]!;
  return { tint: ((rgb << 8) | 0xff) >>> 0, neutral: c[2], strength: c[3], rgb };
}
