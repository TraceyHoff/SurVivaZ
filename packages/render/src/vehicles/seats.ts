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
import { PX_PER_M_DEPTH, PX_PER_M_HEIGHT, PX_PER_M_LENGTH, VEHICLE_SEAT_ART, type VehicleSeatArt } from "./seats.data.js";
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
/** The cabin box a window band / glass span is measured against: the CABIN seats only, ± CABIN_END_M at both ends
 * (windscreen / rear window), half-width = the def width / 2. An open-bed seat (cabin 0, e.g. the pickup bed) sits
 * behind the cab, and letting it extend the box would push the cab seats' rear-view band closed (ADR-521) — the cab's
 * own rear window is the glass there. Falls back to a CABIN_END_M box around the seat when a def has no cabin seats. */
function cabinBox(t: VehicleSeatArt, u: number): { u0: number; u1: number; hw: number } {
  let u0 = Infinity, u1 = -Infinity;
  for (const q of t.seats) { if (q[6] === 0) continue; u0 = Math.min(u0, q[0]); u1 = Math.max(u1, q[0]); }
  if (!Number.isFinite(u0)) { u0 = u - CABIN_END_M; u1 = u + CABIN_END_M; }
  return { u0: u0 - CABIN_END_M, u1: u1 + CABIN_END_M, hw: t.w / 2 };
}
/**
 * Rows of a "window" seat's rider visible through the cabin glass for a camera direction (cu, cv) (unit, vehicle-local
 * horizontal, toward the camera): px above the H-point, or undefined when no row shows (rider hidden).
 */
export function windowBand(d: Pick<VehicleRenderDef, "id">, i: number, cu: number, cv: number): { bottom: number; top: number } | undefined {
  const t = VEHICLE_SEAT_ART[d.id]; const s = t?.seats[i]; if (!t || !s || s[3] !== 1) return undefined;
  const [u, v, z, , belt, roof] = s; const { u0, u1, hw } = cabinBox(t, u);
  // exit distance of the ray (u, v) + D (cu, cv) from the cabin box [u0, u1] x [-hw, hw]; through an end (windscreen /
  // rear window) the glass is raked: its top edge (the roof's front / back edge) is WINDSCREEN_RAKE_M nearer the seat
  let Du = Infinity, Dv = Infinity;
  if (cu > 1e-6) Du = (u1 - u) / cu; else if (cu < -1e-6) Du = (u0 - u) / cu;
  if (cv > 1e-6) Dv = (hw - v) / cv; else if (cv < -1e-6) Dv = (-hw - v) / cv;
  // ADR-525 (b): a ray leaving through the rear end of a def with no rear window shows no rider — the body is solid
  // there (camper_rv, truck_pickup). An open seat (cabin 0, the pickup bed) sits outside the cabin, in the open air,
  // so the rule never hides it.
  if (t.rearGlass === 0 && s[6] === 1 && cu < -1e-6 && Du < Dv) return undefined;
  let D = Math.min(Du, Dv); if (!Number.isFinite(D)) D = 0; D = Math.max(0, D);
  const Dtop = Du < Dv ? Math.max(0, D - WINDSCREEN_RAKE_M) : D;
  // ADR-525 (a): an open seat (cabin 0) has open sky above it — except when the ray leaves through the front end
  // (the cab's windscreen), where the cab roof caps the sightline. So the camera-ray climb lowers the band top for
  // cabin seats and for an open seat seen through the windscreen, but not for an open seat seen over the rail (side)
  // or the tailgate (rear): the bed seat's head clears in side view, and the cab still hides it from ahead.
  const openSky = s[6] === 0 && !(Du < Dv && cu > 1e-6);
  const bottom = (belt - z - D * VIEW_RISE) * PX_PER_M_HEIGHT, top = (roof - z - (openSky ? 0 : Dtop * VIEW_RISE)) * PX_PER_M_HEIGHT;
  return top - Math.max(bottom, -1e9) >= MIN_BAND_PX && top > 0 ? { bottom, top } : undefined;
}
/**
 * ADR-525 (c): the cabin glass at a "window" seat, as a pivot-relative interval on the screen-x axis (1x px): the
 * projected cabin box, so the glass tint/sheen spans the window itself instead of the rider. The screen-x axis in
 * vehicle-local coords is perpendicular to the camera ray (cu, cv); a metre along it is PX_PER_M_LENGTH px (the
 * engine iso projection: sx = (u - v) * 32, so a unit step along the screen-x diagonal moves sx by 32 * sqrt(2)).
 * ADR-527: the axis is (cv, -cu), NOT its negation — increasing screen-x is increasing u in the E view (a rider
 * at larger u sits further right, verified against the pivots' worldToScreen positions). The negated axis mirrored
 * every span about its pivot, so the merged rect overhung the window by ~119 px on both ends (a van's merged tint
 * was 424 px wide for a 186 px window). Cabin seats only: an open seat (cabin 0) has no glass to span — the caller
 * keeps the rider-width glass there.
 */
export function windowGlassSpan(d: Pick<VehicleRenderDef, "id">, i: number, cu: number, cv: number): { lo: number; hi: number } | undefined {
  const t = VEHICLE_SEAT_ART[d.id]; const s = t?.seats[i]; if (!t || !s || s[3] !== 1 || s[6] !== 1) return undefined;
  const { u0, u1, hw } = cabinBox(t, s[0]); const [u, v] = [s[0], s[1]];
  const sx = cv, sy = -cu; let lo = Infinity, hi = -Infinity; // screen-x axis (unit, vehicle-local); the sign is the window's, not its mirror (ADR-527)
  for (const [bu, bv] of [[u0, -hw], [u0, hw], [u1, -hw], [u1, hw]] as const) {
    const p = ((bu - u) * sx + (bv - v) * sy) * PX_PER_M_LENGTH;
    lo = Math.min(lo, p); hi = Math.max(hi, p);
  }
  return { lo, hi };
}

/**
 * ADR-527 (1): clamp a merged window-glass rect to the roofline (both absolute, screen px, y down): the rect's top
 * never rises above the roofline at either end (the RV's rear roof is higher than its front cab roof, so the
 * unclamped union overhung ~7 px). Returns undefined when the clamp empties the rect (the window is entirely
 * above its own roofline — nothing to draw). No roofline: the rect is unchanged. Shared by the Canvas2D glass
 * pass and the WebGL2 glass quad so both renderers clamp the same way.
 */
export function clampGlassRectToRoofline(r: { x0: number; y0: number; x1: number; y1: number }, roof: { x0: number; y0: number; x1: number; y1: number } | undefined): { x0: number; y0: number; x1: number; y1: number } | undefined {
  if (!roof) return r;
  const roofY = (x: number): number => {
    const t = roof.x1 > roof.x0 ? Math.min(1, Math.max(0, (x - roof.x0) / (roof.x1 - roof.x0))) : 0;
    return roof.y0 + (roof.y1 - roof.y0) * t;
  };
  const y0 = Math.max(r.y0, roofY(r.x0), roofY(r.x1));
  return r.y1 > y0 && r.x1 > r.x0 ? { ...r, y0 } : undefined;
}

/**
 * ADR-527 (1): the cabin roofline over a "window" seat — the window's own top edge, in the pivot-relative 1x-px
 * frame of windowGlassSpan (x along the screen-x axis, y = height above the seat pivot, x0 <= x1): the roof edge
 * of the visible face, from the window's one end to the other. On a side face the roof steps with the seats — the
 * rearmost cabin seat's roof at the u0 end, the frontmost cabin seat's roof at the u1 end (the RV's rear roof is
 * 2.29 m against the front cab's 2.047 m, so a merged rect set by the rear riders' band tops rises ~7 px above the
 * front roofline). On an end face (windscreen / rear window) the roof is the visible end's seats' roof at both
 * v-ends, so the line is flat. The height at an end is the band-top formula for that roof:
 * (roof - z - Dtop * VIEW_RISE) * PX_PER_M_HEIGHT, with Dtop the same raked ray distance windowBand uses for
 * the visible face. Cabin seats only; undefined where there is no glass (open seats, over-drawn seats, and the
 * rearGlass: 0 rear view — the same guards as windowBand).
 */
export function windowGlassRoofline(d: Pick<VehicleRenderDef, "id">, i: number, cu: number, cv: number): { x0: number; y0: number; x1: number; y1: number } | undefined {
  const t = VEHICLE_SEAT_ART[d.id]; const s = t?.seats[i]; if (!t || !s || s[3] !== 1 || s[6] !== 1) return undefined;
  const [u, v, z] = [s[0], s[1], s[2]]; const { u0, u1, hw } = cabinBox(t, u);
  let Du = Infinity, Dv = Infinity;
  if (cu > 1e-6) Du = (u1 - u) / cu; else if (cu < -1e-6) Du = (u0 - u) / cu;
  if (cv > 1e-6) Dv = (hw - v) / cv; else if (cv < -1e-6) Dv = (-hw - v) / cv;
  if (t.rearGlass === 0 && cu < -1e-6 && Du < Dv) return undefined; // the ADR-525 (b) rule: no rear window, no glass
  let D = Math.min(Du, Dv); if (!Number.isFinite(D)) D = 0; D = Math.max(0, D);
  const Dtop = Du < Dv ? Math.max(0, D - WINDSCREEN_RAKE_M) : D;
  const roofAt = (roof: number): number => (roof - z - Dtop * VIEW_RISE) * PX_PER_M_HEIGHT;
  // the roof at the cabin's two ends: the nearest cabin seat's roof at each end (min-u = rear, max-u = front)
  const cab = t.seats.filter((q) => q[6] === 1);
  const roofMinU = cab.reduce((m, q) => (q[0] < m.u ? { u: q[0], roof: q[5] } : m), { u: Infinity, roof: 0 }).roof;
  const roofMaxU = cab.reduce((m, q) => (q[0] > m.u ? { u: q[0], roof: q[5] } : m), { u: -Infinity, roof: 0 }).roof;
  const sx = cv, sy = -cu; // the screen-x axis (ADR-527: the same corrected axis as windowGlassSpan)
  const xAt = (bu: number, bv: number): number => ((bu - u) * sx + (bv - v) * sy) * PX_PER_M_LENGTH;
  if (Dv < Du) {
    // side face: the roofline runs along u, from the rear end (min-u roof) to the front end (max-u roof)
    const fv = cv > 0 ? hw : -hw;
    const a = { x: xAt(u0, fv), y: roofAt(roofMinU) }, b = { x: xAt(u1, fv), y: roofAt(roofMaxU) };
    return a.x <= b.x ? { x0: a.x, y0: a.y, x1: b.x, y1: b.y } : { x0: b.x, y0: b.y, x1: a.x, y1: a.y };
  }
  // end face (windscreen / rear window): the roofline runs along v at the visible end's roof
  const fu = cu > 0 ? u1 : u0, roofEnd = cu > 0 ? roofMaxU : roofMinU, y = roofAt(roofEnd);
  const a = xAt(fu, -hw), b = xAt(fu, hw);
  return a <= b ? { x0: a, y0: y, x1: b, y1: y } : { x0: b, y0: y, x1: a, y1: y };
}
