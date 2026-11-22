/**
 * ADR-518: seated riders on true-scale Art (pure). Art's seats.vehicles.json (folded into seats.data.ts at build time)
 * gives every rider seat's H-point in metres and its draw rule:
 *  - "over" (bikes, trike, tandem, cargo bike): the rider draws after (in front of) the vehicle sprite;
 *  - "window" (enclosed cabs): the rider draws after the sprite but only the screen rows between the beltline and the
 *    roof underside at that seat (the door hides the legs, the roof the top of the head), so the occupant shows through
 *    the glass and nowhere else (no see-through ghost on the door or body panels).
 * Art's band is the window at the seat itself. Seen from the iso camera the glass is not at the seat: the line of sight
 * leaves the cabin through the side / end glass a distance D away along the camera direction and climbs
 * PX_PER_M_DEPTH / PX_PER_M_HEIGHT m per m on the way, so the rows of the rider that show through the glass are Art's band
 * lowered by that climb (windowBand). Without it a far-side driver's torso is painted over the roof top (the roof hides
 * it) and nothing of a near-side passenger shows below the beltline band.
 * Gameplay seats beyond Art's (e.g. van_passenger has 8 gameplay seats, Art paints 4 window seats) have no window to
 * show through: those riders draw before (behind) the sprite, fully hidden by the body.
 */
import type { VehicleRenderDef } from "./layout.js";
import { PX_PER_M_DEPTH, PX_PER_M_HEIGHT, VEHICLE_SEAT_ART } from "./seats.data.js";
import { Z_PER_M } from "./scale.js";

export type RiderDraw = "over" | "window" | "hidden";
export interface ArtSeat {
  /** vehicle-local metres = tiles (u forward, v = engine +v) and world z units of the seat H-point (the doll's seat socket) */
  u: number; v: number; z: number; draw: RiderDraw;
  /** "window": visible band as 1x px above the H-point (bottom = beltline, top = roof underside); 0/0 otherwise */
  clipBottom: number; clipTop: number;
}
/** Art seat i of a def, or undefined when the def has no true-scale seat table (legacy placement). */
export function artSeat(d: Pick<VehicleRenderDef, "id">, i: number): ArtSeat | undefined {
  const t = VEHICLE_SEAT_ART[d.id]; if (!t || !t.seats.length) return undefined;
  const s = t.seats[i];
  if (!s) { const s0 = t.seats[0]!; return { u: s0[0], v: s0[1], z: s0[2] * Z_PER_M, draw: "hidden", clipBottom: 0, clipTop: 0 }; }
  const [u, v, z, draw, belt, roof] = s;
  return draw === 1
    ? { u, v, z: z * Z_PER_M, draw: "window", clipBottom: (belt - z) * PX_PER_M_HEIGHT, clipTop: (roof - z) * PX_PER_M_HEIGHT }
    : { u, v, z: z * Z_PER_M, draw: "over", clipBottom: 0, clipTop: 0 };
}
/** Has the def Art seats (riders follow seats.vehicles.json while its Art body is drawn)? */
export const hasArtSeats = (d: Pick<VehicleRenderDef, "id">): boolean => (VEHICLE_SEAT_ART[d.id]?.seats.length ?? 0) > 0;

/** Horizontal metres climbed per metre of height along the camera ray (Art projection: 22.63 px/m depth, 30.29 px/m height). */
export const VIEW_RISE = PX_PER_M_DEPTH / PX_PER_M_HEIGHT;
/** Cabin glass margin ahead of the front seats / behind the rear seats (m): the windscreen and rear window. */
export const CABIN_END_M = 0.75;
/** Horizontal run of a raked windscreen / rear window from its bottom (cowl) to its top (roof edge), m. */
export const WINDSCREEN_RAKE_M = 0.5;
/** A window band thinner than this (px) shows nothing useful: the rider is hidden instead. */
export const MIN_BAND_PX = 2;
/**
 * Rows of a "window" seat's rider visible through the cabin glass for a camera direction (cu, cv) (unit, vehicle-local
 * horizontal, toward the camera): px above the H-point, or undefined when no row shows (rider hidden).
 */
export function windowBand(d: Pick<VehicleRenderDef, "id">, i: number, cu: number, cv: number): { bottom: number; top: number } | undefined {
  const t = VEHICLE_SEAT_ART[d.id]; const s = t?.seats[i]; if (!t || !s || s[3] !== 1) return undefined;
  const [u, v, z, , belt, roof] = s; let u0 = Infinity, u1 = -Infinity; for (const q of t.seats) { u0 = Math.min(u0, q[0]); u1 = Math.max(u1, q[0]); }
  u0 -= CABIN_END_M; u1 += CABIN_END_M; const hw = t.w / 2;
  // exit distance of the ray (u, v) + D (cu, cv) from the cabin box [u0, u1] x [-hw, hw]; through an end (windscreen /
  // rear window) the glass is raked: its top edge (the roof's front / back edge) is WINDSCREEN_RAKE_M nearer the seat
  let Du = Infinity, Dv = Infinity;
  if (cu > 1e-6) Du = (u1 - u) / cu; else if (cu < -1e-6) Du = (u0 - u) / cu;
  if (cv > 1e-6) Dv = (hw - v) / cv; else if (cv < -1e-6) Dv = (-hw - v) / cv;
  let D = Math.min(Du, Dv); if (!Number.isFinite(D)) D = 0; D = Math.max(0, D);
  const Dtop = Du < Dv ? Math.max(0, D - WINDSCREEN_RAKE_M) : D;
  const bottom = (belt - z - D * VIEW_RISE) * PX_PER_M_HEIGHT, top = (roof - z - Dtop * VIEW_RISE) * PX_PER_M_HEIGHT;
  return top - Math.max(bottom, -1e9) >= MIN_BAND_PX && top > 0 ? { bottom, top } : undefined;
}
