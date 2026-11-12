// ADR-361: dedicated art for the animal-drawn vehicles (ADR-358/359/360) and the harness, painted at runtime
// like Task 34 / ADR-356 — no binary PNGs in the push snapshot. Three pieces:
//  1. World sprites for all nine drawn defs, keyed by def id (wagon_small, ..., chariot) so render's
//     resolveVehicleArt binds them as the Art body (atlas `veh_art_<id>`, native scale 1): one 8-direction
//     row per def (Art order E,SE,S,SW,W,NW,N,NE — Art frame k = world dir (k+7)%8, the +PI/4 facing offset
//     in artPack.ts). The renderer only ever shows ONE frame per direction for a vehicle body (VehicleView's
//     body sprite has no VAnim; the damaged/wrecked anims on Art car sprites are never selected for the
//     body billboard — only build pieces go through resolvePiece's damage path), so there is no moving
//     variant: wheels are painted in a mid-roll pose (spokes 15 deg off vertical) instead of faking an
//     animation the game can't show. Damage stages are a cut for the same reason (see the ADR entry).
//  2. A harness overlay per mount art (`mount_harness_<art>`), drawn by view.ts's layerOn exactly like the
//     saddle overlay (same VAnim state/startTick, one LAYER_KEY step above the mount). One 128px cell per
//     direction, shared across the gait frames (the mount bobs ~1-2px under the straps; tack has no gait of
//     its own): the straps sit on the mount's trunk, positioned from the per-direction body averages measured
//     off the pack's mount sheets (HARNESS_BODY, from nature/manifest.nature.json dirFrames).
//  3. Build/crafting-menu + inventory icons for the nine kits, the three wooden parts and the harness,
//     runtime-painted like ADR-357 (painted PNG data URLs injected as a CSS override after the stylesheet).
//     Vehicles have no build-menu pieces (kits craft at the workbench), so the kit icons surface on the
//     crafting recipe tiles and inventory/hotbar slots, which all read the same data-icon keys.
// The painter is pure (no DOM) and unit-testable; the fragment (pack/task361) carries layout only.
import type { AtlasSource } from "@engine/render";
import { Px, TASK34_DIR_VEC } from "./task34-art.js";

/** Atlas keys this module paints (also the fragment's atlas keys). */
export const TASK361_VEHICLE_ATLAS_KEYS = [
  "veh_art_wagon_small", "veh_art_wagon_small_covered", "veh_art_wagon_medium", "veh_art_wagon_medium_covered",
  "veh_art_wagon_large", "veh_art_wagon_large_covered", "veh_art_cart", "veh_art_carriage", "veh_art_chariot",
] as const;
export const TASK361_HARNESS_ATLAS_KEYS = [
  "veh_art_harness_horse", "veh_art_harness_donkey", "veh_art_harness_deer", "veh_art_harness_elk",
  "veh_art_harness_moose", "veh_art_harness_bison", "veh_art_harness_yak",
] as const;
export const TASK361_ATLAS_KEYS = [...TASK361_VEHICLE_ATLAS_KEYS, ...TASK361_HARNESS_ATLAS_KEYS] as const;
/** The nine drawn def ids (ADR-358), in vehicles.json order. */
export const DRAWN_VEHICLE_IDS = [
  "wagon_small", "wagon_small_covered", "wagon_medium", "wagon_medium_covered",
  "wagon_large", "wagon_large_covered", "cart", "carriage", "chariot",
] as const;
export type DrawnVehicleId = (typeof DRAWN_VEHICLE_IDS)[number];
/** Mount arts with a harness overlay (ADR-319 sheets). */
export const TASK361_HARNESS_ARTS = ["horse", "donkey", "deer", "elk", "moose", "bison", "yak"] as const;
export type HarnessArt = (typeof TASK361_HARNESS_ARTS)[number];

type RGBA = readonly [number, number, number, number?];
const OUTLINE: RGBA = [40, 30, 50];
const SHADOW: RGBA = [0, 0, 0, 70];
const shade = (c: RGBA, k: number): RGBA => [
  Math.max(0, Math.min(255, Math.round(c[0] * k))),
  Math.max(0, Math.min(255, Math.round(c[1] * k))),
  Math.max(0, Math.min(255, Math.round(c[2] * k))),
  c[3] ?? 255,
];

// ---- palette (the game's warm palette; same dark-plum outline as Task 34 / ADR-356) ----
const WOOD: RGBA = [185, 138, 78];
const WOOD_MID: RGBA = [161, 118, 58];
const WOOD_DARK: RGBA = [122, 79, 38];
const WOOD_LIGHT: RGBA = [201, 160, 106];
const IRON: RGBA = [96, 96, 104];
const IRON_DARK: RGBA = [58, 58, 66];
const TYRE: RGBA = [38, 36, 40];
const CANVAS: RGBA = [232, 222, 196];
const CANVAS_SHADE: RGBA = [208, 196, 168];
const CANVAS_DARK: RGBA = [186, 172, 140];
const GLASS: RGBA = [58, 84, 104];
const GLASS_LIGHT: RGBA = [120, 170, 205];
const BRASS: RGBA = [212, 175, 55];
const LEATHER: RGBA = [150, 102, 62];
const LEATHER_DARK: RGBA = [96, 62, 38];
const ROPE: RGBA = [196, 164, 104];
const SACK: RGBA = [198, 172, 120];
const CRATE: RGBA = [172, 128, 72];

// ---- drawn-vehicle geometry (footprints + seat anchors copied from packages/gameplay/data/vehicles.json;
// asserted against that file in the ADR-361 tests, so drift fails loudly) ----
export interface DrawnVehicleArtDef {
  id: DrawnVehicleId; length: number; width: number; kind: "wagon" | "cart" | "carriage" | "chariot";
  covered: boolean; /** paint colour of the bed / body (covered twins share their twin's paint) */
  paint: RGBA; /** driver-bench u (seatAnchors[0].x) and seat height in screen px (seat z x modelZScale x 16) */
  seatX: number; seatZPx: number; /** front-hitch anchor x (hitches[0].anchor.x) */
  hitchX: number;
}
const SEAT_PX = 32; // 0.3 z x modelZScale 6.68 x 16 px/z (render modelZScale for the drawn defs)
export const DRAWN_VEHICLE_ART: Readonly<Record<DrawnVehicleId, DrawnVehicleArtDef>> = {
  wagon_small: { id: "wagon_small", length: 2.6, width: 1.4, kind: "wagon", covered: false, paint: [176, 64, 46], seatX: 1.0, seatZPx: SEAT_PX, hitchX: 1.9 },
  wagon_small_covered: { id: "wagon_small_covered", length: 2.6, width: 1.4, kind: "wagon", covered: true, paint: [176, 64, 46], seatX: 1.0, seatZPx: SEAT_PX, hitchX: 1.9 },
  wagon_medium: { id: "wagon_medium", length: 3.6, width: 1.6, kind: "wagon", covered: false, paint: [63, 138, 74], seatX: 1.4, seatZPx: SEAT_PX, hitchX: 2.4 },
  wagon_medium_covered: { id: "wagon_medium_covered", length: 3.6, width: 1.6, kind: "wagon", covered: true, paint: [63, 138, 74], seatX: 1.4, seatZPx: SEAT_PX, hitchX: 2.4 },
  wagon_large: { id: "wagon_large", length: 4.6, width: 1.8, kind: "wagon", covered: false, paint: [47, 111, 176], seatX: 1.8, seatZPx: SEAT_PX, hitchX: 2.9 },
  wagon_large_covered: { id: "wagon_large_covered", length: 4.6, width: 1.8, kind: "wagon", covered: true, paint: [47, 111, 176], seatX: 1.8, seatZPx: SEAT_PX, hitchX: 2.9 },
  cart: { id: "cart", length: 1.8, width: 1.2, kind: "cart", covered: false, paint: [201, 160, 106], seatX: 0.5, seatZPx: SEAT_PX, hitchX: 1.5 },
  carriage: { id: "carriage", length: 3.2, width: 1.6, kind: "carriage", covered: false, paint: [44, 44, 52], seatX: 1.2, seatZPx: 37, hitchX: 2.2 },
  chariot: { id: "chariot", length: 1.6, width: 1.1, kind: "chariot", covered: false, paint: [178, 60, 44], seatX: 0.3, seatZPx: SEAT_PX, hitchX: 1.4 },
};
// Heights in z units (1 z = 16 px): the bench top sits at seatZPx so the seated driver (ADR-360 placement)
// rests on it; the bed floor is below the bench, the canvas / cab roof above it.
const BED_FLOOR_Z = 1.25, BED_TOP_Z = 2.55, RAIL_TOP_Z = 3.05, BENCH_BACK_Z = 2.9;
const CANVAS_TOP_Z = 5.1, CAB_ROOF_Z = 5.5, CHARIOT_RAIL_Z = 2.15;
/** Top z of a def's silhouette (canvas / cab roof / bed rails). */
export const drawnVehicleTopZ = (d: DrawnVehicleArtDef): number =>
  d.covered ? CANVAS_TOP_Z : d.kind === "carriage" ? CAB_ROOF_Z : d.kind === "chariot" ? CHARIOT_RAIL_Z : RAIL_TOP_Z;

/**
 * Frame size + pivot for a drawn def, mirroring render's vehicleFrame (same 2:1 dimetric projection):
 * the bbox of the bounding box (uMin..uMax incl. the drawbar tip, v ±W/2, z 0..topZ) over all 8 headings,
 * plus a 4px pad. px = w/2 (x is centrally symmetric); py is the pivot from the top.
 */
export function drawnVehicleFrame(d: DrawnVehicleArtDef): { w: number; h: number; px: number; py: number } {
  const hl = d.length / 2, hw = d.width / 2, topZ = drawnVehicleTopZ(d);
  const uMin = -hl - 0.1, uMax = d.hitchX + 0.4;
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  for (let dir = 0; dir < 8; dir++) {
    const h = dir * (Math.PI / 4), c = Math.cos(h), s = Math.sin(h);
    for (const u of [uMin, uMax]) for (const v of [-hw, hw]) for (const z of [0, topZ]) {
      const dx = c * u - s * v, dy = s * u + c * v;
      const x = (dx - dy) * 32, y = (dx + dy) * 16 - z * 16;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  const pad = 4;
  const w = Math.ceil(maxX - minX) + pad * 2, h = Math.ceil(maxY - minY) + pad * 2;
  return { w, h, px: w / 2, py: Math.ceil(-minY) + pad };
}

// ---- projection helpers (screen space; pivot = (cx, cy), heading h, scale s) ----
const proj = (u: number, v: number, z: number, h: number, cx: number, cy: number, s: number): [number, number] => {
  const c = Math.cos(h), sn = Math.sin(h), dx = c * u - sn * v, dy = sn * u + c * v;
  return [cx + (dx - dy) * 32 * s, cy + (dx + dy) * 16 * s - z * 16 * s];
};
const inTri = (x: number, y: number, a: readonly [number, number], b: readonly [number, number], c: readonly [number, number]): boolean => {
  const sign = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number => (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);
  const d0 = sign(x, y, a[0], a[1], b[0], b[1]), d1 = sign(x, y, b[0], b[1], c[0], c[1]), d2 = sign(x, y, c[0], c[1], a[0], a[1]);
  return !((d0 < 0 || d1 < 0 || d2 < 0) && (d0 > 0 || d1 > 0 || d2 > 0));
};
/** Filled quad (two triangles for the inside test, so the 1px outline follows the quad, not the diagonal). */
function quad(px: Px, pts: readonly (readonly [number, number])[], fill: RGBA, outline: RGBA | null = OUTLINE): void {
  const [a, b, c, d] = pts as readonly (readonly [number, number])[];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.floor(Math.min(...xs)), x1 = Math.ceil(Math.max(...xs)), y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys));
  px.shape(x0, y0, x1 - x0 + 1, y1 - y0 + 1, (x, y) => inTri(x, y, a!, b!, c!) || inTri(x, y, a!, c!, d!), fill, outline);
}
/** One box face: the projected quad of its 4 corners, shaded by the face normal (paintSegment's rule). */
function face(px: Px, corners: readonly (readonly [number, number, number])[], nrm: readonly [number, number], h: number, cx: number, cy: number, s: number, color: RGBA): void {
  const c = Math.cos(h), sn = Math.sin(h);
  const nx = c * nrm[0] - sn * nrm[1], ny = sn * nrm[0] + c * nrm[1];
  if (nx + ny <= 1e-6) return; // faces away from the camera
  const k = 0.62 + 0.25 * (nx - ny) * 0.7 + 0.1;
  quad(px, corners.map(([u, v, z]) => proj(u, v, z, h, cx, cy, s)), shade(color, k));
}
/** A 3D box (u0..u1, v0..v1, z0..z1): the visible faces, far faces first. */
function box(px: Px, u0: number, u1: number, v0: number, v1: number, z0: number, z1: number, h: number, cx: number, cy: number, s: number, color: RGBA): void {
  const F: { n: readonly [number, number]; pts: readonly (readonly [number, number, number])[]; depth: number }[] = [];
  const c = Math.cos(h), sn = Math.sin(h);
  const depth = (u: number, v: number): number => c * u - sn * v + sn * u + c * v;
  F.push(
    { n: [1, 0], pts: [[u1, v0, z0], [u1, v1, z0], [u1, v1, z1], [u1, v0, z1]], depth: depth(u1, 0) },
    { n: [-1, 0], pts: [[u0, v0, z0], [u0, v1, z0], [u0, v1, z1], [u0, v0, z1]], depth: depth(u0, 0) },
    { n: [0, 1], pts: [[u0, v1, z0], [u1, v1, z0], [u1, v1, z1], [u0, v1, z1]], depth: depth(0, v1) },
    { n: [0, -1], pts: [[u0, v0, z0], [u1, v0, z0], [u1, v0, z1], [u0, v0, z1]], depth: depth(0, v0) },
  );
  for (const f of F.sort((a, b) => a.depth - b.depth)) face(px, f.pts, f.n, h, cx, cy, s, color);
  // Top face (always visible, brightest).
  quad(px, ([[u0, v0, z1], [u1, v0, z1], [u1, v1, z1], [u0, v1, z1]] as [number, number, number][]).map(([u, v, z]) => proj(u, v, z, h, cx, cy, s)), shade(color, 1.12));
}
/** Thick line (a band of 1px lines) between two screen points. */
function band(px: Px, x0: number, y0: number, x1: number, y1: number, w: number, color: RGBA): void {
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
  for (let i = -Math.floor(w / 2); i <= Math.floor(w / 2); i++) px.line(Math.round(x0 + nx * i), Math.round(y0 + ny * i), Math.round(x1 + nx * i), Math.round(y1 + ny * i), color);
}

// ---- wheels ----
/** Wheel axles + radii (z units) per kind: wagons/carriage ride on two axles (rear wheels bigger, the
 *  farm-wagon rule), cart/chariot on one. */
const wheelSpec = (d: DrawnVehicleArtDef): { u: number; r: number }[] => {
  const hl = d.length / 2;
  if (d.kind === "wagon") return [{ u: hl - 0.6, r: 0.55 }, { u: -hl + 0.6, r: 0.65 }];
  if (d.kind === "carriage") return [{ u: hl - 0.6, r: 0.5 }, { u: -hl + 0.6, r: 0.62 }];
  if (d.kind === "cart") return [{ u: -0.1, r: 0.62 }];
  return [{ u: -0.1, r: 0.8 }]; // chariot: one axle, big light wheels
};
/**
 * One wheel: a disc in the u-z plane at fixed v, drawn through the projection (so it reads as a tilted
 * ellipse in the dimetric view, like the debug painter's boxes). Spokes sit 15 deg off vertical — the
 * mid-roll pose, since the renderer shows one frame per direction. Near end-on headings the plane is
 * edge-on to the camera (|cos h - sin h| ~ 0) and the wheel is a thin vertical sliver.
 */
function wheel(px: Px, u: number, v: number, r: number, h: number, cx: number, cy: number, s: number): void {
  const c = Math.cos(h), sn = Math.sin(h);
  const [wx, wy] = proj(u, v, r, h, cx, cy, s);
  const a = 32 * (c - sn) * s, b = 0, d2 = 16 * (c + sn) * s, e = -16 * s, det = a * e - b * d2;
  const disc = (rad: number, fill: RGBA, outline: RGBA | null): void => {
    if (Math.abs(det) < 24) { // edge-on: a sliver as wide as the tyre
      px.ellipse(wx, wy, 3 * s + 1, Math.max(2, rad * 16 * s), fill, outline);
      return;
    }
    const rx = Math.abs(a) * rad + Math.abs(b) * rad + 2, ry = Math.abs(d2) * rad + Math.abs(e) * rad + 2;
    px.shape(Math.round(wx - rx), Math.round(wy - ry), Math.ceil(rx * 2), Math.ceil(ry * 2), (x, y) => {
      const du = (e * (x - wx) - b * (y - wy)) / det, dz = (-d2 * (x - wx) + a * (y - wy)) / det;
      return du * du + dz * dz <= rad * rad;
    }, fill, outline);
  };
  disc(r, TYRE, OUTLINE);
  disc(r * 0.62, WOOD_MID, null);
  // Spokes: 6, mid-roll (15 deg off vertical), on the wooden hub face.
  for (let k = 0; k < 6; k++) {
    const ang = (15 + k * 60) * (Math.PI / 180);
    const [ex, ey] = proj(u + r * 0.58 * Math.cos(ang), v, r + r * 0.58 * Math.sin(ang), h, cx, cy, s);
    px.line(Math.round(wx), Math.round(wy), Math.round(ex), Math.round(ey), WOOD_DARK);
  }
  px.ellipse(wx, wy, Math.max(2, 3 * s), Math.max(2, 2.5 * s), IRON_DARK, null);
  px.set(Math.round(wx), Math.round(wy), BRASS);
}

// ---- the vehicle cell painter ----
/**
 * One direction cell of a drawn vehicle at (ox, oy): `artDir` 0-7 is Art order (E,SE,S,SW,W,NW,N,NE);
 * world dir = (artDir + 7) % 8, heading = world dir x 45 deg. `s` scales the whole drawing (1 = world
 * atlas, < 1 = menu icon). The pivot (vehicle centre, ground) is at the frame pivot.
 */
export function paintDrawnVehicleCell(px: Px, ox: number, oy: number, d: DrawnVehicleArtDef, artDir: number, s = 1): void {
  const f = drawnVehicleFrame(d);
  const cx = ox + f.px * s, cy = oy + f.py * s;
  const h = ((artDir + 7) % 8) * (Math.PI / 4);
  const hl = d.length / 2, hw = d.width / 2;
  const nearV = Math.sin(h) + Math.cos(h) > 0 ? 1 : -1; // the v side facing the camera
  // Ground shadow.
  px.ellipse(cx, cy + 2 * s, (d.length + d.width) * 13 * s, (d.length + d.width) * 6 * s, SHADOW, null);
  // Far-side wheels first (behind the body).
  for (const w of wheelSpec(d)) wheel(px, w.u, -nearV * (hw - 0.08), w.r, h, cx, cy, s);
  if (d.kind === "carriage") paintCarriage(px, d, h, cx, cy, s);
  else if (d.kind === "chariot") paintChariot(px, d, h, cx, cy, s);
  else paintWagonOrCart(px, d, h, cx, cy, s);
  // Near-side wheels (in front of the bed's lower edge).
  for (const w of wheelSpec(d)) wheel(px, w.u, nearV * (hw - 0.08), w.r, h, cx, cy, s);
  // Drawbar / shafts forward from the front hitch, bridging toward the mount's rear pin.
  paintDrawbar(px, d, h, cx, cy, s);
}

/** Wagon + cart body: bed floor, cargo or canvas, bench, rails. */
function paintWagonOrCart(px: Px, d: DrawnVehicleArtDef, h: number, cx: number, cy: number, s: number): void {
  const hl = d.length / 2, hw = d.width / 2;
  // Bed floor slab (painted body colour; the cart keeps natural wood).
  box(px, -hl, hl, -hw, hw, BED_FLOOR_Z, BED_TOP_Z, h, cx, cy, s, d.paint);
  // Bed top planks: a lighter top face is already the box top; add plank seams.
  const [tx0, ty0] = proj(-hl + 0.15, -hw + 0.15, BED_TOP_Z, h, cx, cy, s);
  const [tx1, ty1] = proj(hl - 0.15, hw - 0.15, BED_TOP_Z, h, cx, cy, s);
  void tx0; void ty0; void tx1; void ty1;
  if (d.covered) paintCanvas(px, d, h, cx, cy, s);
  else paintCargo(px, d, h, cx, cy, s);
  // Driver's bench at the front (seat slab + backrest); the seat top is the rider's seat height.
  const bx0 = d.seatX - 0.35, bx1 = d.seatX + 0.35, bz = d.seatZPx / 16;
  box(px, bx0, bx1, -0.35, 0.35, bz - 0.25, bz, h, cx, cy, s, WOOD_DARK);
  box(px, bx0 - 0.08, bx0 + 0.02, -0.35, 0.35, bz, BENCH_BACK_Z, h, cx, cy, s, WOOD_DARK);
  // Footboard under the bench.
  box(px, bx1 - 0.05, bx1 + 0.25, -0.3, 0.3, BED_FLOOR_Z - 0.15, BED_FLOOR_Z + 0.05, h, cx, cy, s, WOOD_MID);
  // Bed rails: thin boxes on the four sides, drawn after the cargo so the near rail occludes it.
  const rt = 0.09;
  box(px, -hl, hl, hw - rt, hw, BED_TOP_Z, RAIL_TOP_Z, h, cx, cy, s, shade(d.paint, 0.85));
  box(px, -hl, hl, -hw, -hw + rt, BED_TOP_Z, RAIL_TOP_Z, h, cx, cy, s, shade(d.paint, 0.85));
  box(px, -hl, -hl + rt, -hw, hw, BED_TOP_Z, RAIL_TOP_Z, h, cx, cy, s, shade(d.paint, 0.85));
  box(px, hl - rt, hl, -hw, hw, BED_TOP_Z, RAIL_TOP_Z, h, cx, cy, s, shade(d.paint, 0.85));
}

/** Canvas cover: an arched cloth tunnel over the bed behind the bench, with hoop arcs. */
function paintCanvas(px: Px, d: DrawnVehicleArtDef, h: number, cx: number, cy: number, s: number): void {
  const hl = d.length / 2, hw = d.width / 2;
  const uF = d.seatX - 0.45, uR = -hl + 0.15; // canvas runs rear of the bench to the tail
  // Silhouette: convex hull of the bed-top corners at the canvas ends + the arch tops (faceted arch).
  const pts: [number, number][] = [];
  for (const [u, v, z] of [[uR, -hw, BED_TOP_Z], [uR, hw, BED_TOP_Z], [uF, -hw, BED_TOP_Z], [uF, hw, BED_TOP_Z],
    [uR, 0, CANVAS_TOP_Z], [(uR + uF) / 2, 0, CANVAS_TOP_Z + 0.15], [uF, 0, CANVAS_TOP_Z]] as const) pts.push(proj(u, v, z, h, cx, cy, s));
  // Hull via the outermost points: sort by angle around the centroid.
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const hull = [...pts].sort((a, b) => Math.atan2(a[1] - my, a[0] - mx) - Math.atan2(b[1] - my, b[0] - mx));
  // Fill the hull as a fan of triangles (no outline: the hoop arcs + bed edge carry the read).
  const [hx, hy] = hull[0]!;
  for (let i = 1; i + 1 < hull.length; i++) {
    const [ax, ay] = hull[i]!, [bx, by] = hull[i + 1]!;
    px.tri(Math.round(hx), Math.round(hy), Math.round(ax), Math.round(ay), Math.round(bx), Math.round(by), CANVAS, null);
  }
  // Shading: a darker canvas strip along the lower edge (the cloth in shadow under the arch).
  const [sx0, sy0] = proj(uR, 0, BED_TOP_Z + 0.4, h, cx, cy, s);
  const [sx1, sy1] = proj(uF, 0, BED_TOP_Z + 0.4, h, cx, cy, s);
  band(px, sx0, sy0, sx1, sy1, Math.max(2, 3 * s), CANVAS_SHADE);
  // Hoop arcs: the arch curve (half-ellipse in the v-z plane) at two u stations, as polylines.
  for (const u of [uR + (uF - uR) * 0.33, uR + (uF - uR) * 0.66]) {
    let prev: [number, number] | undefined;
    for (let i = 0; i <= 10; i++) {
      const v = -hw + (2 * hw * i) / 10;
      const t = 1 - (v / hw) ** 2, z = BED_TOP_Z + (CANVAS_TOP_Z - BED_TOP_Z) * Math.sqrt(Math.max(0, t));
      const p = proj(u, v, z, h, cx, cy, s);
      if (prev) px.line(Math.round(prev[0]), Math.round(prev[1]), Math.round(p[0]), Math.round(p[1]), CANVAS_DARK);
      prev = p;
    }
  }
}

/** Cargo for an open bed: crates, a barrel and sacks, scaled to the wagon size. */
function paintCargo(px: Px, d: DrawnVehicleArtDef, h: number, cx: number, cy: number, s: number): void {
  const hl = d.length / 2, hw = d.width / 2;
  const items: { u: number; v: number; w: number; kind: "crate" | "barrel" | "sack" }[] =
    d.kind === "cart"
      ? [{ u: -0.3, v: 0, w: 0.7, kind: "sack" }]
      : d.length < 3
        ? [{ u: -0.6, v: -0.2, w: 0.8, kind: "crate" }, { u: 0.1, v: 0.25, w: 0.6, kind: "sack" }]
        : d.length < 4
          ? [{ u: -1.0, v: -0.25, w: 0.85, kind: "crate" }, { u: -0.2, v: 0.25, w: 0.8, kind: "barrel" }, { u: 0.5, v: -0.2, w: 0.6, kind: "sack" }]
          : [{ u: -1.5, v: -0.3, w: 0.9, kind: "crate" }, { u: -0.6, v: 0.3, w: 0.85, kind: "barrel" }, { u: 0.3, v: -0.25, w: 0.8, kind: "crate" }, { u: 1.0, v: 0.25, w: 0.6, kind: "sack" }];
  for (const it of items) {
    const w2 = it.w / 2;
    if (it.kind === "crate") {
      box(px, it.u - w2, it.u + w2, it.v - w2 * 0.7, it.v + w2 * 0.7, BED_TOP_Z, BED_TOP_Z + it.w * 0.9, h, cx, cy, s, CRATE);
      const [cx0, cy0] = proj(it.u - w2, it.v, BED_TOP_Z + it.w * 0.45, h, cx, cy, s);
      const [cx1, cy1] = proj(it.u + w2, it.v, BED_TOP_Z + it.w * 0.45, h, cx, cy, s);
      px.line(Math.round(cx0), Math.round(cy0), Math.round(cx1), Math.round(cy1), WOOD_DARK);
    } else if (it.kind === "barrel") {
      const [bx, by] = proj(it.u, it.v, BED_TOP_Z + it.w * 0.45, h, cx, cy, s);
      px.ellipse(bx, by, it.w * 0.45 * 32 * s * 0.7, it.w * 0.45 * 16 * s, WOOD_MID, OUTLINE);
      px.ellipse(bx, by - it.w * 0.2 * 16 * s, it.w * 0.3 * 32 * s * 0.7, it.w * 0.18 * 16 * s, WOOD_LIGHT, null);
    } else {
      const [sx, sy] = proj(it.u, it.v, BED_TOP_Z + it.w * 0.35, h, cx, cy, s);
      px.ellipse(sx, sy, it.w * 0.5 * 32 * s * 0.7, it.w * 0.32 * 16 * s, SACK, OUTLINE);
      px.set(Math.round(sx), Math.round(sy - it.w * 0.3 * 16 * s), WOOD_DARK);
    }
  }
  void hw;
}

/** Carriage: enclosed cab with windows and a door, gold trim, roof slab, driver's box at the front. */
function paintCarriage(px: Px, d: DrawnVehicleArtDef, h: number, cx: number, cy: number, s: number): void {
  const hl = d.length / 2, hw = d.width / 2;
  // Underbody + floor.
  box(px, -hl, hl, -hw, hw, BED_FLOOR_Z, BED_TOP_Z, h, cx, cy, s, IRON_DARK);
  // Cab: rear 2/3, from the bed up to the roof; windows on the visible faces.
  const cabU0 = -hl, cabU1 = 0.35;
  box(px, cabU0, cabU1, -hw + 0.05, hw - 0.05, BED_TOP_Z, CAB_ROOF_Z, h, cx, cy, s, d.paint);
  // Roof slab, slightly wider, with a brass edge.
  box(px, cabU0 - 0.08, cabU1 + 0.08, -hw, hw, CAB_ROOF_Z, CAB_ROOF_Z + 0.22, h, cx, cy, s, IRON_DARK);
  // Windows: two dark glass quads on each visible side face + a door seam below the rear window.
  for (const side of [1, -1]) {
    const v = side * (hw - 0.02);
    for (const [wu0, wu1] of [[-hl + 0.35, -hl + 1.15], [-0.35, 0.15]] as const) {
      const pts = ([[wu0, v, 3.6], [wu1, v, 3.6], [wu1, v, 4.6], [wu0, v, 4.6]] as [number, number, number][]).map(([u, vv, z]) => proj(u, vv, z, h, cx, cy, s)) as [number, number][];
      // Only draw when this side faces the camera (the quad collapses edge-on otherwise).
      if (Math.abs(pts[0]![0] - pts[1]![0]) + Math.abs(pts[0]![1] - pts[1]![1]) < 2) continue;
      quad(px, pts, GLASS, OUTLINE);
      const [gx, gy] = proj((wu0 + wu1) / 2, v, 4.45, h, cx, cy, s);
      px.line(Math.round(gx - 3 * s), Math.round(gy), Math.round(gx + 3 * s), Math.round(gy - 2 * s), GLASS_LIGHT);
    }
    // Door seam under the rear window.
    const [dx0, dy0] = proj(-hl + 0.75, v, BED_TOP_Z + 0.1, h, cx, cy, s);
    const [dx1, dy1] = proj(-hl + 0.75, v, 3.5, h, cx, cy, s);
    px.line(Math.round(dx0), Math.round(dy0), Math.round(dx1), Math.round(dy1), BRASS);
  }
  // Gold trim along the cab's beltline.
  const [t0x, t0y] = proj(cabU0, hw - 0.02, BED_TOP_Z + 0.25, h, cx, cy, s);
  const [t1x, t1y] = proj(cabU1, hw - 0.02, BED_TOP_Z + 0.25, h, cx, cy, s);
  px.line(Math.round(t0x), Math.round(t0y), Math.round(t1x), Math.round(t1y), BRASS);
  const [t2x, t2y] = proj(cabU0, -hw + 0.02, BED_TOP_Z + 0.25, h, cx, cy, s);
  const [t3x, t3y] = proj(cabU1, -hw + 0.02, BED_TOP_Z + 0.25, h, cx, cy, s);
  px.line(Math.round(t2x), Math.round(t2y), Math.round(t3x), Math.round(t3y), BRASS);
  // Driver's box at the front: bench at the carriage seat height + footboard + front panel.
  const bz = d.seatZPx / 16;
  box(px, d.seatX - 0.35, d.seatX + 0.35, -0.35, 0.35, bz - 0.25, bz, h, cx, cy, s, WOOD_DARK);
  box(px, d.seatX - 0.4, d.seatX - 0.32, -0.35, 0.35, bz, bz + 0.7, h, cx, cy, s, WOOD_DARK);
  box(px, d.seatX + 0.3, d.seatX + 0.55, -0.3, 0.3, BED_FLOOR_Z - 0.15, BED_FLOOR_Z + 0.05, h, cx, cy, s, WOOD_MID);
  // Two small lamps on the cab's front corners (unlit brass).
  for (const side of [1, -1]) {
    const [lx, ly] = proj(cabU1 + 0.05, side * (hw - 0.1), 4.9, h, cx, cy, s);
    px.ellipse(lx, ly, 2.5 * s, 3.5 * s, BRASS, OUTLINE);
  }
}

/** Chariot: a light low floor with low rails, a small rear bench, big spoked wheels and a yoke pole. */
function paintChariot(px: Px, d: DrawnVehicleArtDef, h: number, cx: number, cy: number, s: number): void {
  const hl = d.length / 2, hw = d.width / 2;
  // Low floor slab.
  box(px, -hl, hl, -hw, hw, 1.0, 1.25, h, cx, cy, s, WOOD);
  // Low rails on the sides + back (the front stays open, a low dashboard rail only).
  const rt = 0.07;
  box(px, -hl, hl, hw - rt, hw, 1.25, CHARIOT_RAIL_Z, h, cx, cy, s, d.paint);
  box(px, -hl, hl, -hw, -hw + rt, 1.25, CHARIOT_RAIL_Z, h, cx, cy, s, d.paint);
  box(px, -hl, -hl + rt, -hw, hw, 1.25, CHARIOT_RAIL_Z, h, cx, cy, s, d.paint);
  box(px, hl - rt, hl, -hw, hw, 1.25, 1.7, h, cx, cy, s, d.paint);
  // Small rear bench so the seated driver (ADR-360 pose) has something to sit on.
  const bz = d.seatZPx / 16;
  box(px, -hl + 0.15, -hl + 0.55, -0.3, 0.3, bz - 0.25, bz, h, cx, cy, s, LEATHER_DARK);
  // Crimson side panels on the rails (the chariot's flash).
  for (const side of [1, -1]) {
    const [px0, py0] = proj(-hl + 0.15, side * (hw - 0.01), 1.45, h, cx, cy, s);
    const [px1, py1] = proj(hl - 0.15, side * (hw - 0.01), 1.45, h, cx, cy, s);
    const [px2, py2] = proj(hl - 0.15, side * (hw - 0.01), 1.95, h, cx, cy, s);
    const [px3, py3] = proj(-hl + 0.15, side * (hw - 0.01), 1.95, h, cx, cy, s);
    if (Math.abs(px0 - px1) + Math.abs(py0 - py1) < 2) continue;
    quad(px, [[px0, py0], [px1, py1], [px2, py2], [px3, py3]], shade(d.paint, 1.05), null);
  }
}

/** Drawbar (wagons/carriage/chariot: one central tongue) or shafts (cart: two poles flanking the mount). */
function paintDrawbar(px: Px, d: DrawnVehicleArtDef, h: number, cx: number, cy: number, s: number): void {
  const tipU = d.hitchX + 0.38, baseU = d.hitchX - 0.25;
  if (d.kind === "cart") {
    for (const side of [1, -1]) {
      const v = side * 0.35;
      box(px, baseU, tipU, v - 0.05, v + 0.05, 0.7, 0.9, h, cx, cy, s, WOOD_DARK);
      const [rx, ry] = proj(tipU, v, 0.8, h, cx, cy, s);
      px.ellipse(rx, ry, 2.5 * s, 2.5 * s, IRON, OUTLINE);
    }
    return;
  }
  box(px, baseU, tipU, -0.07, 0.07, 0.65, 0.88, h, cx, cy, s, WOOD_DARK);
  const [rx, ry] = proj(tipU, 0, 0.76, h, cx, cy, s);
  px.ellipse(rx, ry, 3 * s, 3 * s, IRON, OUTLINE);
  px.set(Math.round(rx), Math.round(ry), BRASS);
}

// ---- harness overlay ----
// Per-direction mount-body averages (w, h, anchor x, anchor y) over the idle/walk/gallop dirFrames of
// packages/assets/pack/nature/manifest.nature.json, direction index = world dir (0 = heading 0 = +x, screen
// down-right). The straps sit on the trunk, positioned from these averages; the per-frame anchor varies by
// ~±5px around them, so the bands are wide (5-6px) and the traces start well inside the body.
const HARNESS_BODY: Readonly<Record<HarnessArt, readonly (readonly [number, number, number, number])[]>> = {
  horse: [[61.4, 76.9, 0.495, 0.896], [28.3, 74.1, 0.495, 0.874], [60.2, 77.1, 0.505, 0.892], [79.4, 82.2, 0.51, 0.929], [61.1, 91.7, 0.499, 0.907], [43.7, 94.7, 0.405, 0.897], [60.4, 91.9, 0.49, 0.905], [79.1, 82.2, 0.486, 0.929]],
  donkey: [[45.4, 68.9, 0.455, 0.898], [25.8, 66.6, 0.496, 0.881], [44.8, 69.1, 0.545, 0.896], [57.9, 72.7, 0.548, 0.924], [47.5, 78.9, 0.513, 0.905], [41.4, 80.2, 0.386, 0.896], [47.7, 79.1, 0.482, 0.903], [58.5, 72.8, 0.446, 0.923]],
  deer: [[45.1, 75.7, 0.438, 0.908], [31.9, 73.2, 0.498, 0.889], [45.2, 76.0, 0.551, 0.904], [54.4, 79.0, 0.558, 0.938], [48.1, 85.2, 0.519, 0.915], [44.0, 86.9, 0.341, 0.906], [48.1, 85.4, 0.477, 0.913], [54.8, 79.0, 0.432, 0.938]],
  elk: [[48.7, 84.9, 0.448, 0.912], [32.6, 81.9, 0.491, 0.892], [48.8, 85.4, 0.541, 0.908], [59.4, 89.9, 0.562, 0.935], [51.5, 96.2, 0.512, 0.917], [46.9, 96.4, 0.342, 0.905], [51.9, 96.4, 0.482, 0.915], [59.7, 89.8, 0.43, 0.937]],
  moose: [[65.9, 88.1, 0.403, 0.901], [55.6, 81.6, 0.494, 0.876], [65.1, 88.2, 0.59, 0.898], [75.9, 94.6, 0.585, 0.937], [68.6, 101.8, 0.556, 0.91], [65.0, 101.1, 0.308, 0.893], [69.4, 102.2, 0.442, 0.906], [75.7, 94.7, 0.411, 0.938]],
  bison: [[58.7, 69.9, 0.466, 0.872], [38.7, 70.4, 0.53, 0.857], [59.0, 70.1, 0.528, 0.869], [70.8, 75.9, 0.532, 0.909], [63.8, 84.2, 0.486, 0.887], [63.0, 84.0, 0.365, 0.873], [64.4, 84.5, 0.513, 0.884], [71.3, 75.9, 0.462, 0.909]],
  yak: [[62.1, 72.0, 0.5, 0.877], [38.0, 66.3, 0.5, 0.852], [61.6, 72.1, 0.503, 0.875], [73.9, 78.1, 0.466, 0.912], [63.1, 85.6, 0.492, 0.891], [59.0, 85.6, 0.356, 0.878], [62.3, 85.9, 0.502, 0.888], [73.7, 78.1, 0.531, 0.913]],
};
/** Harness cell size (px): the biggest mount body (moose ~76x102 + traces) fits with room. */
export const HARNESS_CELL = 128;
/** Harness cell pivot (sprite anchor 0.5, 0.9, like the mount sheets). */
export const harnessPivot = (): { x: number; y: number } => ({ x: HARNESS_CELL / 2, y: Math.round(HARNESS_CELL * 0.9) });

/**
 * One harness cell at (ox, oy): `dir` 0-7 is the mount's world direction (same index the mount sheet uses,
 * so the layer's frame and this cell agree). Straps: chest band at the facing end of the trunk, girth band
 * at the belly, a back strap along the spine, and two traces running back from the rear toward the vehicle.
 * A band is an outline-coloured strip with the leather fill inside, so the 1px dark-plum outline survives.
 */
export function paintHarnessCell(px: Px, ox: number, oy: number, art: HarnessArt, dir: number): void {
  const [w, h, ax, ay] = HARNESS_BODY[art]![dir & 7]!;
  const P = harnessPivot();
  const pvx = ox + P.x, pvy = oy + P.y;
  // Body rect in the cell, from its anchor: top-left = pivot - (ax*w, ay*h).
  const tx = pvx - ax * w, ty = pvy - ay * h;
  const cx = tx + w / 2, cy = ty + h / 2;
  const [fx, fy] = TASK34_DIR_VEC[dir & 7]!;
  const nx = -fy, ny = fx; // perpendicular to the facing
  const side = Math.abs(fx) > Math.abs(fy); // side view (wide body) vs end-on (narrow body)
  // Strap helper: a band through (bx, by) along (nx, ny), `len` long, `wd` wide, outline first.
  const strap = (bx: number, by: number, len: number, wd: number): void => {
    const hx = nx * len / 2, hy = ny * len / 2;
    band(px, bx - hx, by - hy, bx + hx, by + hy, wd + 2, OUTLINE);
    band(px, bx - hx, by - hy, bx + hx, by + hy, wd, LEATHER);
    band(px, bx - hx, by - hy, bx + hx, by + hy, Math.max(1, wd - 3), LEATHER_DARK);
  };
  // Chest band: at the facing end of the trunk; girth band: at the belly, just behind the middle.
  strap(cx + fx * w * 0.3, cy + fy * h * 0.12, side ? h * 0.58 : w * 0.9, 5);
  strap(cx + fx * w * 0.02, cy + fy * h * 0.05, side ? h * 0.72 : w * 0.95, 6);
  // Back strap along the spine, chest to rear, riding on the body's top edge.
  const bx0 = cx + fx * w * 0.28, by0 = cy - h * 0.3 + fy * h * 0.1;
  const bx1 = cx - fx * w * 0.4, by1 = cy - h * 0.3 - fy * h * 0.08;
  band(px, bx0, by0, bx1, by1, 4, OUTLINE);
  band(px, bx0, by0, bx1, by1, 2, LEATHER_DARK);
  // Traces: two rope lines from the rear of the body, running back toward the vehicle.
  const rx = cx - fx * w * 0.42, ry = cy + fy * h * 0.08;
  for (const sgn of [-1, 1]) {
    const ox0 = rx + nx * 4 * sgn, oy0 = ry + ny * 4 * sgn;
    px.line(Math.round(ox0), Math.round(oy0), Math.round(ox0 - fx * 24), Math.round(oy0 - fy * 24), ROPE);
    px.line(Math.round(ox0), Math.round(oy0 + 1), Math.round(ox0 - fx * 24), Math.round(oy0 - fy * 24 + 1), ROPE);
  }
  // Brass buckles: chest + girth ends, and the trace ring at the rear.
  const buckle = (bx: number, by: number): void => { px.set(Math.round(bx), Math.round(by), BRASS); px.set(Math.round(bx) + 1, Math.round(by), BRASS); };
  buckle(cx + fx * w * 0.3 + nx * (side ? h * 0.2 : w * 0.32), cy + fy * h * 0.12 + ny * (side ? h * 0.2 : w * 0.32));
  buckle(cx + fx * w * 0.02 - nx * (side ? h * 0.24 : w * 0.34), cy + fy * h * 0.05 - ny * (side ? h * 0.24 : w * 0.34));
  px.ellipse(rx, ry, 2.5, 2.5, BRASS, null);
}

// ---- atlas assembly -------------------------------------------------------
export interface PaintedAtlas { key: string; width: number; height: number; pixels: Uint8ClampedArray }

/**
 * Atlas columns for a drawn def: 8 in a row, except the medium/large wagons, whose 8-wide atlas would
 * exceed the 2048px mobile texture cap (262x8 = 2096, 307x8 = 2456) — those use 4 cols x 2 rows instead.
 * The renderer resolves a frame index to a cell by the atlas's columns, so dirStride 1 still lands each
 * direction in its own cell either way.
 */
export const drawnVehicleAtlasCols = (d: DrawnVehicleArtDef): number => (d.length >= 3.6 && d.kind === "wagon" ? 4 : 8);
/** Atlas rows for a drawn def (8 directions over `cols` columns). */
export const drawnVehicleAtlasRows = (d: DrawnVehicleArtDef): number => Math.ceil(8 / drawnVehicleAtlasCols(d));

/**
 * Paint all sixteen ADR-361 atlases (pure: no DOM, unit-testable). Vehicle atlas = `cols` x `rows` of the
 * def's frame (Art order, dirStride 1); harness atlas = 8 cols x 1 row of 128px cells (one per direction,
 * shared by every gait frame). Matches the pack/task361 fragment layout exactly.
 */
export function paintTask361Atlases(): PaintedAtlas[] {
  const out: PaintedAtlas[] = [];
  for (const id of DRAWN_VEHICLE_IDS) {
    const d = DRAWN_VEHICLE_ART[id];
    const f = drawnVehicleFrame(d);
    const cols = drawnVehicleAtlasCols(d), rows = drawnVehicleAtlasRows(d);
    const px = new Px(f.w * cols, f.h * rows);
    for (let dir = 0; dir < 8; dir++) paintDrawnVehicleCell(px, (dir % cols) * f.w, Math.floor(dir / cols) * f.h, d, dir, 1);
    out.push({ key: `veh_art_${id}`, width: f.w * cols, height: f.h * rows, pixels: px.data });
  }
  for (const art of TASK361_HARNESS_ARTS) {
    const px = new Px(HARNESS_CELL * 8, HARNESS_CELL);
    for (let dir = 0; dir < 8; dir++) paintHarnessCell(px, dir * HARNESS_CELL, 0, art, dir);
    out.push({ key: `veh_art_harness_${art}`, width: HARNESS_CELL * 8, height: HARNESS_CELL, pixels: px.data });
  }
  return out;
}

/** Rasterized pixels -> PNG blob URL (OffscreenCanvas, else a document canvas; undefined when no canvas exists). */
async function canvasToBlobURL(w: number, h: number, pixels: Uint8ClampedArray): Promise<string | undefined> {
  try {
    // TS 5.9 (CI's pinned version) types ImageData's data as Uint8ClampedArray<ArrayBuffer>; our pixels are
    // Uint8ClampedArray<ArrayBufferLike>, so copy into a fresh ArrayBuffer-backed array (once, at load).
    const data = new ImageData(new Uint8ClampedArray(pixels), w, h);
    const OC = (globalThis as { OffscreenCanvas?: typeof OffscreenCanvas }).OffscreenCanvas;
    if (OC) {
      const cv = new OC(w, h); const ctx = cv.getContext("2d");
      if (ctx) { ctx.putImageData(data, 0, 0); if (typeof cv.convertToBlob === "function") return URL.createObjectURL(await cv.convertToBlob({ type: "image/png" })); }
    }
    const doc = (globalThis as { document?: Document }).document;
    if (doc) {
      const cv = doc.createElement("canvas"); cv.width = w; cv.height = h; const ctx = cv.getContext("2d");
      if (!ctx) return undefined;
      ctx.putImageData(data, 0, 0);
      return await new Promise<string | undefined>((res) => cv.toBlob((b) => res(b ? URL.createObjectURL(b) : undefined), "image/png"));
    }
  } catch { /* no canvas in this environment: the caller keeps the manifest's debug path */ }
  return undefined;
}

/**
 * Atlas sources for the sixteen generated atlases (same { url, emissiveUrl } shape as sourcesFromManifest).
 * view.ts merges these over the manifest's debug paths before setRegistry, so the registry's drawn-vehicle
 * and harness sprites draw the painted pixels. Returns only the atlases that converted (empty in a
 * canvas-less environment).
 */
export async function task361AtlasSources(): Promise<Map<string, AtlasSource>> {
  const out = new Map<string, AtlasSource>();
  for (const a of paintTask361Atlases()) {
    const url = await canvasToBlobURL(a.width, a.height, a.pixels);
    if (url) out.set(a.key, { url, emissiveUrl: null });
  }
  return out;
}

// ---- menu icons (ADR-357 pattern) -------------------------------------------------------
// The nine kit items' sprite keys (`item_vehicle_kit_<def>`) have no CSS rule and no atlas cell (the
// generated vitems_icons block covers the motor kits only), the three wooden parts (`item_wooden_wheel`,
// `item_canvas_cover`, `item_wagon_frame`) likewise, and the harness item's sprite key is `harness` (no
// `sprite` field in items.json, so spriteKey = key) with no rule either — all three fall back to the
// category icon (fiber) today. Until a binary art pass paints those cells, the crafting recipe tiles and
// inventory/hotbar slots show each item's own art, painted at runtime from the world art below (kits reuse
// the world cell painter at icon scale, so the icon IS the vehicle). The manifest + CSS entries stay as
// the documented home for these icons; a future binary art pass should remove installVehicleMenuIcons()
// (one call in view.ts) and the icons will light up from the atlas with no other code change.

/** Item icon keys this module paints, in display order: nine kits, three parts, the harness. */
export const VEHICLE_MENU_ICON_KEYS = [
  "item_vehicle_kit_wagon_small", "item_vehicle_kit_wagon_small_covered", "item_vehicle_kit_wagon_medium",
  "item_vehicle_kit_wagon_medium_covered", "item_vehicle_kit_wagon_large", "item_vehicle_kit_wagon_large_covered",
  "item_vehicle_kit_cart", "item_vehicle_kit_carriage", "item_vehicle_kit_chariot",
  "item_wooden_wheel", "item_canvas_cover", "item_wagon_frame", "harness",
] as const;
export type VehicleMenuIconKey = (typeof VEHICLE_MENU_ICON_KEYS)[number];

/** The def id behind a kit icon key, or undefined for the parts / harness. */
export const kitDefOfIcon = (key: VehicleMenuIconKey): DrawnVehicleId | undefined => {
  const m = /^item_vehicle_kit_(.+)$/.exec(key);
  return m && (DRAWN_VEHICLE_IDS as readonly string[]).includes(m[1]!) ? m[1] as DrawnVehicleId : undefined;
};

/**
 * Paint one menu icon (128x128, pure — no DOM). Kit icons re-run the world cell painter at icon scale
 * (SE view, Art frame 1 — the most readable 3/4 view); the parts and the harness are small dedicated
 * drawings in the same palette. Pixel-identical to the world art for kits in the sense that the same
 * shapes are painted by the same code, at icon scale.
 */
export function paintVehicleMenuIconPixels(key: VehicleMenuIconKey): { width: number; height: number; pixels: Uint8ClampedArray } {
  const px = new Px(128, 128);
  const def = kitDefOfIcon(key);
  if (def) {
    const d = DRAWN_VEHICLE_ART[def], f = drawnVehicleFrame(d);
    const s = Math.min(1, 118 / f.w, 104 / f.h);
    // Pivot at (64, 100): the vehicle sits on the tile's baseline like the store icons do.
    const ox = 64 - f.px * s, oy = 100 - f.py * s;
    paintDrawnVehicleCell(px, ox, oy, d, 1, s);
    return { width: 128, height: 128, pixels: px.data };
  }
  if (key === "item_wooden_wheel") {
    // A spoked wooden wheel, front-on: dark tyre, wooden face, six spokes, iron hub.
    px.ellipse(64, 64, 40, 40, TYRE, OUTLINE);
    px.ellipse(64, 64, 25, 25, WOOD_MID, null);
    for (let k = 0; k < 6; k++) {
      const a = (15 + k * 60) * (Math.PI / 180);
      px.line(64, 64, Math.round(64 + 24 * Math.cos(a)), Math.round(64 + 24 * Math.sin(a)), WOOD_DARK);
    }
    px.ellipse(64, 64, 7, 7, IRON_DARK, null);
    px.set(64, 64, BRASS);
  } else if (key === "item_canvas_cover") {
    // A folded canvas cover: three stacked arches, rope-tied, in canvas cream.
    for (let i = 0; i < 3; i++) {
      const y = 88 - i * 16;
      px.ellipse(64, y, 42 - i * 4, 14, i === 2 ? CANVAS : CANVAS_SHADE, OUTLINE);
    }
    px.line(40, 44, 40, 92, CANVAS_DARK);
    px.line(88, 44, 88, 92, CANVAS_DARK);
    band(px, 48, 40, 48, 92, 3, ROPE);
    band(px, 80, 40, 80, 92, 3, ROPE);
  } else if (key === "item_wagon_frame") {
    // A wagon frame: bed rails on an axle with two small wheels, no canvas, no cargo.
    px.rect(28, 52, 72, 10, WOOD, OUTLINE);
    px.rect(28, 66, 72, 6, WOOD_MID, OUTLINE);
    for (const x of [34, 62, 90]) px.rect(x, 44, 5, 18, WOOD_DARK, null);
    px.line(28, 78, 100, 78, IRON_DARK);
    for (const x of [44, 84]) {
      px.ellipse(x, 86, 11, 11, TYRE, OUTLINE);
      px.ellipse(x, 86, 6, 6, WOOD_MID, null);
      px.set(x, 86, IRON_DARK);
    }
  } else {
    // Harness: a coiled leather harness — a strap loop with a brass buckle and two traces.
    px.ellipse(64, 62, 34, 30, LEATHER_DARK, OUTLINE);
    px.ellipse(64, 62, 26, 22, LEATHER, null);
    px.ellipse(64, 62, 16, 13, LEATHER_DARK, null);
    px.rect(58, 28, 12, 10, BRASS, OUTLINE);
    px.line(38, 88, 22, 110, ROPE);
    px.line(90, 88, 106, 110, ROPE);
    px.line(64, 92, 64, 112, ROPE);
  }
  return { width: 128, height: 128, pixels: px.data };
}

/**
 * Painted 128px icon -> PNG data URL via a document canvas (sync); undefined when no canvas exists
 * (jsdom / headless). The browser downscales the 128px PNG into the 32px tile box (image-rendering:auto).
 */
export function vehicleMenuIconDataUrl(key: VehicleMenuIconKey, doc?: Document): string | undefined {
  try {
    const d = doc ?? (globalThis as { document?: Document }).document;
    if (!d) return undefined;
    const { width, height, pixels } = paintVehicleMenuIconPixels(key);
    // Same TS 5.9 note as canvasToBlobURL: copy into a fresh ArrayBuffer-backed array.
    const data = new ImageData(new Uint8ClampedArray(pixels), width, height);
    const cv = d.createElement("canvas"); cv.width = width; cv.height = height;
    const ctx = cv.getContext("2d");
    if (!ctx) return undefined;
    ctx.putImageData(data, 0, 0);
    const url = cv.toDataURL("image/png");
    return url && url !== "data:," ? url : undefined;
  } catch { return undefined; }
}

/**
 * One override rule per icon key: the tile's --cz-icon becomes the painted PNG, centred and contained in
 * the 32px tile box. Appended after the linked stylesheet, equal specificity wins over the generated
 * items_build / vitems_icons block (same [data-icon="..."] attribute selector, later in document order).
 */
export function vehicleMenuIconsCss(urls: ReadonlyMap<string, string>): string {
  const rules: string[] = [];
  for (const key of VEHICLE_MENU_ICON_KEYS) {
    const url = urls.get(key);
    if (url) rules.push(`[data-icon="${key}"]{--cz-icon:url("${url}");--cz-ipos:center;--cz-isize:contain}`);
  }
  return rules.join("\n");
}

/**
 * Install the runtime menu icons for the nine kits, three parts and harness: paint each icon, build the
 * override stylesheet, and append (or replace) <style id="task361-menu-icons"> in the document head.
 * Idempotent; safe no-op (returns false, appends nothing) when no canvas exists and no URLs are supplied.
 * `urls` is a test seam — production callers omit it and the icons are painted from the canvas.
 */
export function installVehicleMenuIcons(doc?: Document, urls?: ReadonlyMap<string, string>): boolean {
  const d = doc ?? (globalThis as { document?: Document }).document;
  if (!d) return false;
  const resolved = new Map<string, string>();
  for (const key of VEHICLE_MENU_ICON_KEYS) {
    const u = urls?.get(key) ?? vehicleMenuIconDataUrl(key, d);
    if (u) resolved.set(key, u);
  }
  if (resolved.size === 0) return false;
  const css = vehicleMenuIconsCss(resolved);
  let style = d.getElementById("task361-menu-icons") as HTMLStyleElement | null;
  if (!style) { style = d.createElement("style"); style.id = "task361-menu-icons"; d.head.appendChild(style); }
  style.textContent = css;
  return true;
}
