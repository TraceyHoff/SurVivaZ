/**
 * Vehicle render layout (pure, no GL): the shared geometry the procedural atlas painter, VehicleView and Art's sprites
 * agree on (packages/render/docs/VEHICLES_RENDER.md). Vehicle-local frame: u = along the heading (+ = front), v = left
 * (+ = the side riders exit on, gameplay exitVehicle), z = up in world z units. World = (x, y) + R(heading)·(u, v).
 * Defs are a structural subset of @engine/gameplay VehicleDef (render does not depend on gameplay).
 */
export interface VehicleRenderDef {
  id: string; class: string; seats: number;
  footprint: { length: number; width: number };
  hitches: readonly { at: "front" | "rear"; offset: number; /** vehicle-local hitch point (x = u, y = v); gameplay defs carry it (ADR-101) */ anchor?: { x: number; y: number; z: number } }[];
  /** Per-seat anchors from vehicles.json (x = u, y = v, z). Required for riders (ADR-101). */
  seatAnchors?: readonly { x: number; y: number; z: number }[];
  interior: { stations: readonly string[] };
}
export const TAU = Math.PI * 2;
/** Longest footprint slice drawn as one billboard (tiles). Longer vehicles become several depth-sorted segments. */
export const SEG_LEN = 1.5;
export const MAX_SEGMENTS = 8;
/** Wrap to (-PI, PI]. */
export const wrapAngle = (a: number): number => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
/** 8-direction row for a continuous heading: round(h / 45°) mod 8 (= AssetRegistry.directionIndex(h, 8)). */
export const quantizeDir8 = (h: number): number => { const a = ((h % TAU) + TAU) % TAU; return Math.round(a / (TAU / 8)) % 8; };
export const dirAngle = (d: number): number => (d & 7) * (TAU / 8);
/** Interpolate angles along the shortest arc (never spins the long way round across +-PI). */
export const lerpAngleShortest = (a: number, b: number, t: number): number => wrapAngle(a + wrapAngle(b - a) * t);

export const segmentCount = (d: VehicleRenderDef): number => Math.max(1, Math.min(MAX_SEGMENTS, Math.ceil(d.footprint.length / SEG_LEN - 1e-6)));
/** Segment i centre u (0 = front-most). */
export function segmentU(d: VehicleRenderDef, i: number): number { const n = segmentCount(d), L = d.footprint.length; return L / 2 - (i + 0.5) * (L / n); }
export const toWorld = (x: number, y: number, h: number, u: number, v: number): [number, number] => {
  const c = Math.cos(h), s = Math.sin(h); return [x + c * u - s * v, y + s * u + c * v];
};

/** Classes whose body hides the rider's lower half (cabin crop); bicycles show the whole rider. */
export const hasCabin = (d: VehicleRenderDef): boolean => d.class !== "bicycle" && d.class !== "trailer";
export const hasInterior = (d: VehicleRenderDef): boolean => d.interior.stations.length > 0;
/** ADR-358: animal-drawn classes (gameplay vehicles.json) — engineless, so no headlamps. Render does not depend on
 * gameplay, so the list is duplicated here; keep it in sync with DRAWN_CLASSES in gameplay vehicles.ts. */
export const DRAWN_VEHICLE_CLASSES = ["wagon", "cart", "carriage", "chariot"] as const;
export const isDrawnVehicleClass = (c: string): boolean => (DRAWN_VEHICLE_CLASSES as readonly string[]).includes(c);
export const isPowered = (d: VehicleRenderDef): boolean => d.class !== "trailer" && !isDrawnVehicleClass(d.class);

export interface SeatAnchor { u: number; v: number; z: number; cabin: boolean }
/** Seat anchors from vehicles.json (ADR-101; seat 0 = driver). Verified equal to the old computed layout before it was
 * removed. z is scaled by the per-type stylized height (scale.ts) so riders sit at the right height in the taller body.
 * A def without seatAnchors yields no anchors (riders then sit at the vehicle centre). */
export function seatAnchors(d: VehicleRenderDef, zScale = 1): SeatAnchor[] {
  const cab = hasCabin(d); return (d.seatAnchors ?? []).slice(0, d.seats).map((a) => ({ u: a.x, v: a.y, z: a.z * zScale, cabin: cab }));
}
/** Seat height (z units, feet) for cabin seats; the rider is depth-nudged just behind its segment so the opaque door
 * panel below the beltline crops the legs while the glass cabin shows the torso and head. */
export const SEAT_SINK = 0.25;
/** Depth-key offset of a seated rider relative to its segment billboard (negative = behind = cropped by the body). */
export const RIDER_DK_CABIN = -0.06, RIDER_DK_OPEN = 0.06;
/** Headlamp anchors (front corners) and the light cone samples ahead of the heading: [u, radius tiles, intensity]. */
export function headlampAnchors(d: VehicleRenderDef): { u: number; v: number }[] {
  if (!isPowered(d)) return [];
  const u = d.footprint.length / 2; if (d.class === "bicycle") return [{ u, v: 0 }];
  return [{ u, v: d.footprint.width * 0.32 }, { u, v: -d.footprint.width * 0.32 }];
}
/** Cone as a few growing circles ahead of the nose (one merged light on lowend). */
export function headlightCone(d: VehicleRenderDef, lowEnd: boolean): { u: number; radius: number; intensity: number }[] {
  if (!isPowered(d)) return [];
  const nose = d.footprint.length / 2; const k = d.class === "bicycle" ? 0.55 : 1;
  if (lowEnd) return [{ u: nose + 2.4 * k, radius: 2.6 * k, intensity: 0.9 }];
  return [{ u: nose + 0.9 * k, radius: 1.3 * k, intensity: 0.9 }, { u: nose + 2.4 * k, radius: 2.1 * k, intensity: 0.75 }, { u: nose + 4.2 * k, radius: 2.8 * k, intensity: 0.55 }];
}
export const hitchU = (d: VehicleRenderDef, at: "front" | "rear"): number | undefined => { const h = d.hitches.find((x) => x.at === at); return h?.anchor ? h.anchor.x : undefined; };

/** Trailer pose that keeps the front hitch pinned to the (smoothed) tow's rear hitch; heading = the trailer's own heading. */
export function trailerPose(tow: VehicleRenderDef, towX: number, towY: number, towH: number, tr: VehicleRenderDef, trH: number): { x: number; y: number; heading: number } | undefined {
  const r = hitchU(tow, "rear"), f = hitchU(tr, "front"); if (r === undefined || f === undefined) return undefined;
  const [px, py] = toWorld(towX, towY, towH, r, 0);
  return { x: px - Math.cos(trH) * f, y: py - Math.sin(trH) * f, heading: trH };
}

/** Point inside the vehicle footprint (local player standing in a parked camper). */
export function insideFootprint(d: VehicleRenderDef, x: number, y: number, h: number, px: number, py: number, margin = 0): boolean {
  const dx = px - x, dy = py - y, c = Math.cos(h), s = Math.sin(h);
  const u = c * dx + s * dy, v = -s * dx + c * dy;
  return Math.abs(u) <= d.footprint.length / 2 + margin && Math.abs(v) <= d.footprint.width / 2 + margin;
}

/**
 * Shift a world position along the view axis without moving it on screen: changes the depth key (x + y + z*zf) by
 * dk. Used to push seated riders just behind / in front of their segment.
 */
export function depthNudge(p: { x: number; y: number; z: number }, dk: number, iso: { tileH: number; zStep: number }, zf: number): void {
  // screen y = (x+y)*tileH/2 - z*zStep stays fixed when z moves by d*k for x, y moving by d (k = tileH/zStep); key moves by d*(2 + k*zf)
  const k = iso.tileH / iso.zStep; const d = dk / (2 + k * zf); p.x += d; p.y += d; p.z += d * k;
}

/** Client-side pose smoothing between snapshots: exponential approach, angles along the shortest arc, snap on teleport. */
export class PoseSmoother {
  x = 0; y = 0; z = 0; heading = 0; drift = 0; ready = false;
  constructor(public tau = 0.09, public snapDist = 4) {}
  update(t: { x: number; y: number; z: number; heading: number; drift: number }, dt: number): this {
    if (!this.ready || Math.hypot(t.x - this.x, t.y - this.y) > this.snapDist) { this.x = t.x; this.y = t.y; this.z = t.z; this.heading = wrapAngle(t.heading); this.drift = t.drift; this.ready = true; return this; }
    const k = 1 - Math.exp(-Math.max(0, dt) / Math.max(1e-4, this.tau));
    this.x += (t.x - this.x) * k; this.y += (t.y - this.y) * k; this.z += (t.z - this.z) * k;
    this.heading = lerpAngleShortest(this.heading, t.heading, k); this.drift = lerpAngleShortest(this.drift, t.drift, k * 0.5);
    return this;
  }
}
