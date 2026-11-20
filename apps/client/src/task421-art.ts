// ADR-421: dedicated art for the tier-1 boats (raft, canoe, rowboat), painted at runtime like
// ADR-361 — no binary PNGs in the push snapshot. One atlas per def (`veh_art_<id>`, native scale 1):
// 4 cols x 6 rows of the def's frame — two rows per paddle phase (phase 0 raised, 1 mid-stroke,
// 2 recovery), Art directions E,SE,S,SW,W,NW,N,NE in row-major order (Art frame k = world dir
// (k+7)%8, the +PI/4 facing offset in artPack.ts), so frame(phase, dir) = phase*8 + dir and the
// idle animation is frames [8] (mid-stroke, the most readable pose) with dirStride 1. The renderer
// only ever shows ONE frame per direction for a vehicle body (VehicleView's body sprite has no VAnim —
// the same cut ADR-361 made for wheels), so the `row` animation (frames [0, 8, 16], fps 4) is declared
// in the fragment for a future render hook that cycles paddle phases while the boat moves. Bobbing is
// (phase 1 sits 1px lower) and the wake trails the stern longest mid-stroke, so the three rows already
// read as a stroke cycle in the atlas. Each boat is a distinct silhouette that never reads as another:
// the raft is a flat log platform with crates and a barrel, the canoe a narrow bark hull with pointed
// ends, the rowboat a painted plank hull with thwarts and shipped oars. The painter is pure (no DOM)
// and unit-testable; the fragment (pack/task421) carries layout only. The user is the final visual
// check — no GL in the VM, so these are verified numerically (pixel counts, distinct signatures), not
// by eye.
//
// ADR-422: the same painter, atlas layout and frame math serve the tier-2 motorboats (motorboat,
// pontoon, speedboat) in this module — same 4 cols x 6 rows, same frame(phase, dir), same bob.
// Their three phases are throttle phases instead of paddle phases (0 idle / small wake, 1 full
// throttle / longest wake + prop wash, 2 cruise), the idle is still frame 8, and the fragment
// (pack/task422) declares a `wake` animation [0, 8, 16] at 4 fps instead of `row`. Motorboats draw
// no paddles: an outboard motor on the transom, a console + windshield (motorboat, speedboat), bench
// seats instead of thwarts, and the pontoon draws twin cylindrical hulls + a flat deck + a canopy
// instead of a single slab hull. Same dark-plum outline, same water shadow and sheen, so the two
// tiers read as one family at game scale.
import type { AtlasSource } from "@engine/render";
import { Px } from "./task34-art.js";

/** Atlas keys this module paints (also the fragment's atlas keys). */
export const TASK421_ATLAS_KEYS = ["veh_art_raft", "veh_art_canoe", "veh_art_rowboat"] as const;
/** Atlas keys for the tier-2 motorboats (ADR-422, fragment pack/task422). */
export const TASK422_ATLAS_KEYS = ["veh_art_motorboat", "veh_art_pontoon", "veh_art_speedboat"] as const;
/** Atlas key for the ADR-479 sailboat (fragment pack/task479). */
export const TASK479_ATLAS_KEYS = ["veh_art_sailboat"] as const;
/** The three tier-1 boat def ids (ADR-421), in vehicles.json order. */
export const BOAT_IDS = ["raft", "canoe", "rowboat"] as const;
export type BoatId = (typeof BOAT_IDS)[number];
/** The three tier-2 motorboat def ids (ADR-422), in vehicles.json order. */
export const MOTORBOAT_IDS = ["motorboat", "pontoon", "speedboat"] as const;
export type MotorBoatId = (typeof MOTORBOAT_IDS)[number];
/** The ADR-479 sailboat def id (appended last in vehicles.json — APPEND ONLY, defId = index + 1). */
export const SAILBOAT_ID = "sailboat" as const;
export type SailboatId = typeof SAILBOAT_ID;
/** Every boat def id this module paints, tier-1 then tier-2, sailboat last. */
export type AnyBoatId = BoatId | MotorBoatId | SailboatId;
/** Paddle-phase rows in a boat atlas: 0 raised, 1 mid-stroke (blade in the water), 2 recovery. */
export const BOAT_PHASES = 3;
/** Frame index for (phase 0-2, Art direction 0-7) in a boat atlas (4 cols x 6 rows, 2 rows per phase). */
export const boatFrame = (phase: number, dir: number): number => (phase % BOAT_PHASES) * 8 + (dir & 7);
/** Atlas columns / rows (4 cols x 6 rows keeps every atlas under the 2048px mobile cap). */
export const BOAT_ATLAS_COLS = 4;
export const BOAT_ATLAS_ROWS = 6;

type RGBA = readonly [number, number, number, number?];
const OUTLINE: RGBA = [40, 30, 50];
const SHADOW: RGBA = [0, 0, 0, 70];
const shade = (c: RGBA, k: number): RGBA => [
  Math.max(0, Math.min(255, Math.round(c[0] * k))),
  Math.max(0, Math.min(255, Math.round(c[1] * k))),
  Math.max(0, Math.min(255, Math.round(c[2] * k))),
  c[3] ?? 255,
];

const WOOD: RGBA = [185, 138, 78];
const WOOD_MID: RGBA = [161, 118, 58];
const WOOD_DARK: RGBA = [122, 79, 38];
const WOOD_LIGHT: RGBA = [201, 160, 106];
const CRATE: RGBA = [172, 128, 72];
const CRATE_DARK: RGBA = [138, 100, 52];
const ROPE: RGBA = [196, 164, 104];
const WATER: RGBA = [52, 110, 150];
const WATER_LIGHT: RGBA = [120, 180, 210];
const WATER_SHADOW: RGBA = [16, 48, 80, 110];
const PADDLE: RGBA = [150, 102, 62];
const PADDLE_DARK: RGBA = [96, 62, 38];
const OUTBOARD: RGBA = [58, 62, 68];
const OUTBOARD_TOP: RGBA = [92, 98, 106];
const GLASS: RGBA = [170, 205, 220];
const CANOPY: RGBA = [232, 222, 196];
const ALUMINUM: RGBA = [150, 158, 165];
/** ADR-479: masthead flag red (the speedboat's hull red, reused as a tiny accent — not a hull). */
const FLAG_RED: RGBA = [178, 52, 44];

// ---- boat geometry (footprints + seat anchors copied from packages/gameplay/data/vehicles.json;
// asserted against that file in the ADR-421 tests, so drift fails loudly) ----
export interface BoatArtDef {
  id: AnyBoatId; length: number; width: number;
  /** hull paint (top face reads lighter via the box shader) */ hull: RGBA; /** gunwale / trim */ trim: RGBA;
  /** top z of the hull silhouette (prow caps sit above it) */ topZ: number;
  /** "paddle" (ADR-421): the paddles row; "motor" (ADR-422): outboard + prop wash, no paddles;
   * "sail" (ADR-479): mast + boom + sails, no paddles */ propulsion: "paddle" | "motor" | "sail";
  /** paddler hand positions (u along the hull, v side): one paddle each, drawn on its v side */ paddles: { u: number; v: number }[];
  /** cargo kind painted on the floor ("none" for motorboats: benches + console instead) */ cargo: "crates" | "bedroll" | "crate_rope" | "none";
  /** motorboats: u of each bench-seat row */ benches?: number[];
  /** pontoon only: twin cylindrical hulls + flat deck instead of a single slab hull */ twinHull?: boolean;
  /** pontoon only: four posts + a flat canvas roof */ canopy?: boolean;
  /** motorboat / speedboat: console + slanted windshield ahead of the driver bench */ windshield?: boolean;
  /** sailboat only (ADR-479): masthead height in z units + the sail cloth colours. The painter draws
   * a mast, a boom and a mainsail (aft) + jib (forward) in the u-z plane; phases are sail states
   * (0 slack, 1 full, 2 billowing) instead of paddle / throttle phases. */
  sail?: { mastZ: number; cloth: RGBA; clothDark: RGBA };
}
export const BOAT_ART: Readonly<Record<BoatId, BoatArtDef>> = {
  raft: {
    id: "raft", length: 2.4, width: 1.6, hull: [172, 128, 72], trim: WOOD_DARK, topZ: 0.6,
    propulsion: "paddle",
    paddles: [{ u: 0.4, v: 0.55 }, { u: 0.4, v: -0.55 }], cargo: "crates",
  },
  canoe: {
    id: "canoe", length: 3.0, width: 0.9, hull: [122, 90, 52], trim: [94, 66, 36], topZ: 0.7,
    propulsion: "paddle",
    paddles: [{ u: 0.6, v: 0.3 }, { u: -0.6, v: -0.3 }], cargo: "bedroll",
  },
  rowboat: {
    id: "rowboat", length: 3.4, width: 1.4, hull: [58, 96, 120], trim: [232, 222, 196], topZ: 0.65,
    propulsion: "paddle",
    paddles: [{ u: 0.0, v: 0.5 }, { u: 0.0, v: -0.5 }], cargo: "crate_rope",
  },
};
/** Tier-2 motorboat art defs (ADR-422): same frame math, same atlas layout, motor propulsion. */
export const MOTORBOAT_ART: Readonly<Record<MotorBoatId, BoatArtDef>> = {
  motorboat: {
    id: "motorboat", length: 4.2, width: 1.8, hull: [232, 232, 228], trim: [40, 90, 140], topZ: 0.65,
    propulsion: "motor", paddles: [], cargo: "none", benches: [1.2, 0.3], windshield: true,
  },
  pontoon: {
    id: "pontoon", length: 6.0, width: 2.4, hull: ALUMINUM, trim: WOOD_DARK, topZ: 0.6,
    propulsion: "motor", paddles: [], cargo: "none", benches: [2.0, 1.0, 0.0, -1.0], twinHull: true, canopy: true,
  },
  speedboat: {
    id: "speedboat", length: 4.8, width: 1.8, hull: [178, 52, 44], trim: [232, 222, 196], topZ: 0.6,
    propulsion: "motor", paddles: [], cargo: "none", benches: [1.5], windshield: true,
  },
};
/** The ADR-479 sailboat art def: a deep-green painted hull (distinct from the rowboat's blue, the
 * speedboat's red, the motorboat's white and the pontoon's aluminium), cream trim, a cream canvas
 * sail with a green reef band, a dark-wood mast + boom and a red masthead flag. Length/width match
 * vehicles.json (asserted in the ADR-479 tests); mastZ 4.6 clears the tallest sail by the same
 * 4px pad boatFrameSize uses for every boat. */
export const SAILBOAT_ART: BoatArtDef = {
  id: "sailboat", length: 3.6, width: 1.5, hull: [46, 104, 74], trim: [232, 222, 196], topZ: 0.65,
  propulsion: "sail", paddles: [], cargo: "none",
  sail: { mastZ: 4.6, cloth: [238, 228, 200], clothDark: [214, 200, 168] },
};
/** Every boat art def this module paints, tier-1 then tier-2, sailboat last. */
export const ALL_BOAT_ART: Readonly<Record<AnyBoatId, BoatArtDef>> = { ...BOAT_ART, ...MOTORBOAT_ART, sailboat: SAILBOAT_ART };

/**
 * Frame size + pivot for a boat def, mirroring render's vehicleFrame (same 2:1 dimetric projection):
 * the bbox of the bounding box (u incl. paddle fore/aft reach, v incl. paddle out-reach, z 0..raised
 * paddle) over all 8 headings, plus a 4px pad. px = w/2 (x is centrally symmetric); py is the pivot
 * from the top.
 */
export function boatFrameSize(d: BoatArtDef): { w: number; h: number; px: number; py: number } {
  const hl = d.length / 2, hw = d.width / 2, topZ = d.sail ? d.sail.mastZ : 1.6; // ADR-479: the masthead, not the paddle, sets the sailboat's top
  const uMin = -hl - 0.8, uMax = hl + 0.9, vMin = -(hw + 1.1), vMax = hw + 1.1;
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  for (let dir = 0; dir < 8; dir++) {
    const h = dir * (Math.PI / 4), c = Math.cos(h), s = Math.sin(h);
    for (const u of [uMin, uMax]) for (const v of [vMin, vMax]) for (const z of [0, topZ]) {
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

/** Blade point for one paddle in `phase` (hand at (u, v, 0.95); blade swings fore/aft and down into the water). */
function paddleBlade(p: { u: number; v: number }, phase: number): { u: number; v: number; z: number } {
  const out = p.v * 1.9;
  if (phase === 0) return { u: p.u + 0.4, v: out, z: 1.5 }; // raised, clear of the water
  if (phase === 1) return { u: p.u - 0.7, v: out, z: 0.0 }; // mid-stroke: blade in the water
  return { u: p.u + 0.8, v: p.v * 1.7, z: 0.55 }; // recovery: blade forward and low
}

/**
 * One boat cell at (ox, oy): `artDir` 0-7 in Art order, `phase` 0-2. For paddle boats the phases are
 * the paddle stroke (0 raised, 1 mid-stroke, 2 recovery); for motorboats they are throttle phases
 * (0 idle, 1 full throttle, 2 cruise). The pivot is the frame pivot (boatFrameSize); the boat bobs
 * 1px lower at full effort (mid-stroke / full throttle) and the wake trails the stern longest then.
 * Paddles are drawn last (in front of the near gunwale) so the stroke reads at scale; motorboats draw
 * the outboard + prop wash last instead, so the engine reads at scale.
 */
export function paintBoatCell(px: Px, ox: number, oy: number, d: BoatArtDef, artDir: number, phase: number, s = 1): void {
  const f = boatFrameSize(d);
  const bob = phase === 1 ? 1 * s : 0;
  const cx = ox + f.px * s, cy = oy + f.py * s + bob;
  const h = ((artDir + 7) % 8) * (Math.PI / 4);
  const hl = d.length / 2, hw = d.width / 2;
  // Water: a dark patch under the hull and a wake trailing the stern (longest mid-stroke).
  const [wx, wy] = proj(0, 0, 0, h, cx, cy, s);
  px.ellipse(wx, wy + 2 * s, (d.length + d.width) * 13 * s, (d.length + d.width) * 5 * s, WATER_SHADOW, null);
  const wakeLen = phase === 1 ? 1.0 : phase === 2 ? 0.6 : 0.35;
  for (let i = 0; i < 3; i++) {
    const [ax, ay] = proj(-hl - 0.3 - i * 0.35 * wakeLen, (i - 1) * hw * 0.45, 0, h, cx, cy, s);
    const [bx, by] = proj(-hl - 0.3 - (i + 0.7) * 0.5 * wakeLen, (i - 1) * hw * 0.45, 0, h, cx, cy, s);
    px.line(Math.round(ax), Math.round(ay), Math.round(bx), Math.round(by), i === 1 ? WATER_LIGHT : WATER);
  }
  // Hull: slab from the waterline to the gunwale, then a darker inset floor (the hollow read).
  // ADR-422 pontoon: twin cylindrical hulls under a flat wooden deck instead of a single slab.
  if (d.twinHull) {
    box(px, -hl, hl, -hw, -hw + 0.55, 0, 0.45, h, cx, cy, s, d.hull);
    box(px, -hl, hl, hw - 0.55, hw, 0, 0.45, h, cx, cy, s, d.hull);
    box(px, -hl, hl, -hw, hw, 0.45, 0.55, h, cx, cy, s, WOOD);
  } else {
    box(px, -hl, hl, -hw, hw, 0, 0.45, h, cx, cy, s, d.hull);
    box(px, -hl + 0.15, hl - 0.15, -hw + 0.15, hw - 0.15, 0.45, 0.5, h, cx, cy, s, shade(d.hull, 0.55));
  }
  // Gunwale rails on the near + far sides (trim colour, above the floor so cargo sits between them).
  const rt = 0.09;
  box(px, -hl, hl, hw - rt, hw, 0.45, d.topZ, h, cx, cy, s, d.trim);
  box(px, -hl, hl, -hw, -hw + rt, 0.45, d.topZ, h, cx, cy, s, d.trim);
  box(px, -hl, -hl + rt, -hw, hw, 0.45, d.topZ, h, cx, cy, s, d.trim);
  box(px, hl - rt, hl, -hw, hw, 0.45, d.topZ, h, cx, cy, s, d.trim);
  // ADR-479: the sailboat's rig — mast, boom, mainsail aft + jib forward, flag at the masthead.
  // The sails are triangles in the u-z plane (v = belly), so they read broadside from the beam and
  // collapse edge-on from bow/stern, like a real sail. Phases are sail states: 0 slack (lowered head,
  // clew pulled in), 1 full, 2 billowing (belly leeward, clew out).
  if (d.sail) {
    const mz = d.sail.mastZ;
    const belly = phase === 2 ? 0.18 : 0;
    const slack = phase === 0 ? 0.8 : phase === 2 ? 1.08 : 1.0;
    const headZ = mz - 0.15 - (phase === 0 ? 0.7 : 0);
    // Mast + boom (dark wood, same as the paddle shafts).
    box(px, -0.07, 0.07, -0.07, 0.07, 0.5, mz, h, cx, cy, s, WOOD_DARK);
    box(px, -hl + 0.5, 0.15, -0.08, 0.08, 0.62, 0.72, h, cx, cy, s, WOOD_DARK);
    const tri3 = (a: readonly [number, number, number], b: readonly [number, number, number], c: readonly [number, number, number], fill: RGBA): void => {
      const [ax, ay] = proj(a[0], a[1], a[2], h, cx, cy, s);
      const [bx, by] = proj(b[0], b[1], b[2], h, cx, cy, s);
      const [tx, ty] = proj(c[0], c[1], c[2], h, cx, cy, s);
      px.tri(Math.round(ax), Math.round(ay), Math.round(bx), Math.round(by), Math.round(tx), Math.round(ty), fill);
    };
    // Mainsail: mast (tack) -> boom end (clew) -> masthead. Reef band along the foot, darker.
    tri3([0.05, belly, 0.78], [-1.3 * slack, belly, 0.78], [0.05, belly, headZ], d.sail.cloth);
    tri3([0.05, belly, 0.78], [-1.05 * slack, belly, 0.78], [0.05, belly, 1.5], d.sail.clothDark);
    // Jib: masthead -> bow. Darker cloth so the two sails read apart.
    tri3([0.05, belly, 0.78], [1.45 * slack, belly, 0.78], [0.05, belly, headZ - 0.2], d.sail.clothDark);
    // Masthead flag, flying aft.
    tri3([0.07, 0, mz], [-0.45, 0, mz - 0.12], [0.07, 0, mz - 0.24], FLAG_RED);
  }
  if (d.id === "canoe") {
    // Pointed ends: raised prow / stern caps, narrower than the hull.
    box(px, hl - 0.35, hl - 0.05, -hw * 0.45, hw * 0.45, 0.45, d.topZ + 0.15, h, cx, cy, s, d.trim);
    box(px, -hl + 0.05, -hl + 0.35, -hw * 0.45, hw * 0.45, 0.45, d.topZ + 0.1, h, cx, cy, s, d.trim);
  }
  if (d.id === "raft") {
    // Side logs: the raft is lashed logs, so two round logs ride on the gunwales.
    box(px, -hl, hl, hw - 0.22, hw - 0.08, 0.45, 0.62, h, cx, cy, s, WOOD_MID);
    box(px, -hl, hl, -hw + 0.08, -hw + 0.22, 0.45, 0.62, h, cx, cy, s, WOOD_MID);
  }
  // Thwarts (seat planks) across the hull at the paddler seats; motorboats get bench seats instead.
  for (const p of d.paddles) {
    const u0 = p.u - 0.28, u1 = p.u + 0.28;
    box(px, u0, u1, -hw + 0.15, hw - 0.15, 0.5, 0.6, h, cx, cy, s, WOOD_LIGHT);
  }
  for (const u of d.benches ?? []) {
    box(px, u - 0.3, u + 0.3, -hw + 0.2, hw - 0.2, 0.5, 0.68, h, cx, cy, s, d.id === "speedboat" ? shade(d.hull, 0.6) : WOOD_LIGHT);
  }
  // Motorboat console + windshield ahead of the driver bench; pontoon canopy on four posts.
  if (d.windshield) {
    box(px, 0.7, 1.15, -0.4, 0.4, 0.5, 0.95, h, cx, cy, s, shade(d.hull, 0.7));
    box(px, 1.05, 1.15, -0.55, 0.55, 0.95, 1.25, h, cx, cy, s, GLASS);
  }
  if (d.canopy) {
    for (const pu of [-1.6, 1.6]) for (const pv of [-hw + 0.3, hw - 0.3])
      box(px, pu - 0.05, pu + 0.05, pv - 0.05, pv + 0.05, 0.55, 1.45, h, cx, cy, s, d.trim);
    box(px, -1.9, 1.9, -hw + 0.15, hw - 0.15, 1.45, 1.55, h, cx, cy, s, CANOPY);
  }
  // Cargo, between the thwarts.
  if (d.cargo === "crates") {
    box(px, -0.7, 0.0, -0.45, 0.3, 0.5, 1.0, h, cx, cy, s, CRATE);
    box(px, -0.7, 0.0, -0.45, 0.3, 0.75, 0.8, h, cx, cy, s, CRATE_DARK);
    const [bx, by] = proj(-1.0, 0.45, 0.75, h, cx, cy, s);
    px.ellipse(bx, by, 6 * s, 8 * s, WOOD_MID, OUTLINE);
    px.ellipse(bx, by - 3 * s, 6 * s, 2 * s, WOOD_LIGHT, null);
  } else if (d.cargo === "bedroll") {
    box(px, -0.25, 0.35, -0.25, 0.25, 0.5, 0.85, h, cx, cy, s, [150, 102, 62]);
    box(px, -0.25, 0.35, -0.25, 0.25, 0.68, 0.72, h, cx, cy, s, ROPE);
  } else if (d.cargo === "crate_rope") {
    box(px, -0.75, -0.15, -0.35, 0.35, 0.5, 0.9, h, cx, cy, s, CRATE);
    const [rx, ry] = proj(0.55, 0.0, 0.55, h, cx, cy, s);
    px.ellipse(rx, ry, 7 * s, 4 * s, ROPE, OUTLINE);
    px.ellipse(rx, ry, 4 * s, 2 * s, WOOD_DARK, null);
  }
  // Paddles / oars: shaft from the hand to the blade, blade ellipse at the blade point; mid-stroke
  // the blade is in the water, so a pale ring marks where it bites. Motorboats draw the outboard
  // on the transom instead, with a prop-wash churn at the stern (widest at full throttle).
  if (d.propulsion === "motor") {
    box(px, -hl - 0.45, -hl - 0.05, -0.22, 0.22, 0.35, 1.2, h, cx, cy, s, OUTBOARD);
    box(px, -hl - 0.5, -hl, -0.28, 0.28, 1.2, 1.32, h, cx, cy, s, OUTBOARD_TOP);
    const wash = phase === 1 ? 1.0 : phase === 2 ? 0.6 : 0.3;
    const [wx2, wy2] = proj(-hl - 0.6, 0, 0.05, h, cx, cy, s);
    px.ellipse(wx2, wy2, (10 + 14 * wash) * s, (4 + 5 * wash) * s, WATER_LIGHT, null);
    px.ellipse(wx2, wy2, (5 + 7 * wash) * s, (2 + 3 * wash) * s, WATER, null);
    if (phase === 1) {
      px.line(Math.round(wx2 - 14 * s), Math.round(wy2 + 2 * s), Math.round(wx2 - 6 * s), Math.round(wy2 + 2 * s), WATER_LIGHT);
      px.line(Math.round(wx2 + 6 * s), Math.round(wy2 + 2 * s), Math.round(wx2 + 14 * s), Math.round(wy2 + 2 * s), WATER_LIGHT);
    }
  } else for (const p of d.paddles) {
    const blade = paddleBlade(p, phase);
    const [hx, hy] = proj(p.u, p.v, 0.95, h, cx, cy, s);
    const [bx, by] = proj(blade.u, blade.v, blade.z, h, cx, cy, s);
    band(px, hx, hy, bx, by, 2, PADDLE);
    px.ellipse(bx, by, 4 * s, 6 * s, PADDLE_DARK, OUTLINE);
    if (phase === 1) {
      px.ellipse(bx, by + 1 * s, 7 * s, 3 * s, WATER_LIGHT, null);
      px.line(Math.round(bx - 8 * s), Math.round(by + 2 * s), Math.round(bx - 3 * s), Math.round(by + 2 * s), WATER_LIGHT);
      px.line(Math.round(bx + 3 * s), Math.round(by + 2 * s), Math.round(bx + 8 * s), Math.round(by + 2 * s), WATER_LIGHT);
    }
  }
  // Waterline sheen along the near hull side (the boat sits IN the water, not on top of it).
  const [sx0, sy0] = proj(-hl, hw, 0.08, h, cx, cy, s);
  const [sx1, sy1] = proj(hl, hw, 0.08, h, cx, cy, s);
  px.line(Math.round(sx0), Math.round(sy0), Math.round(sx1), Math.round(sy1), WATER_LIGHT);
}

export interface PaintedAtlas { key: string; width: number; height: number; pixels: Uint8ClampedArray }

/**
 * Paint all three boat atlases (pure: no DOM, unit-testable). Each atlas is 4 cols x 6 rows of the
 * def's frame (Art order, dirStride 1; two rows per paddle phase 0-2). Matches the pack/task421
 * fragment layout exactly.
 */
export function paintTask421Atlases(): PaintedAtlas[] {
  const out: PaintedAtlas[] = [];
  for (const id of BOAT_IDS) {
    const d = BOAT_ART[id];
    const f = boatFrameSize(d);
    const px = new Px(f.w * BOAT_ATLAS_COLS, f.h * BOAT_ATLAS_ROWS);
    for (let phase = 0; phase < BOAT_PHASES; phase++)
      for (let dir = 0; dir < 8; dir++)
        paintBoatCell(px, (dir % BOAT_ATLAS_COLS) * f.w, (phase * 2 + Math.floor(dir / BOAT_ATLAS_COLS)) * f.h, d, dir, phase, 1);
    out.push({ key: `veh_art_${id}`, width: f.w * BOAT_ATLAS_COLS, height: f.h * BOAT_ATLAS_ROWS, pixels: px.data });
  }
  return out;
}

/**
 * Paint all three tier-2 motorboat atlases (ADR-422, pure: no DOM, unit-testable). Same layout as
 * the tier-1 atlases (4 cols x 6 rows, two rows per phase 0-2 — throttle phases here, not paddle
 * phases). Matches the pack/task422 fragment layout exactly.
 */
export function paintTask422Atlases(): PaintedAtlas[] {
  const out: PaintedAtlas[] = [];
  for (const id of MOTORBOAT_IDS) {
    const d = MOTORBOAT_ART[id];
    const f = boatFrameSize(d);
    const px = new Px(f.w * BOAT_ATLAS_COLS, f.h * BOAT_ATLAS_ROWS);
    for (let phase = 0; phase < BOAT_PHASES; phase++)
      for (let dir = 0; dir < 8; dir++)
        paintBoatCell(px, (dir % BOAT_ATLAS_COLS) * f.w, (phase * 2 + Math.floor(dir / BOAT_ATLAS_COLS)) * f.h, d, dir, phase, 1);
    out.push({ key: `veh_art_${id}`, width: f.w * BOAT_ATLAS_COLS, height: f.h * BOAT_ATLAS_ROWS, pixels: px.data });
  }
  return out;
}

/**
 * Paint the ADR-479 sailboat atlas (pure: no DOM, unit-testable). Same layout as the tier-1/2
 * atlases (4 cols x 6 rows, two rows per phase 0-2 — sail states here, not paddle / throttle
 * phases). Matches the pack/task479 fragment layout exactly.
 */
export function paintTask479Atlases(): PaintedAtlas[] {
  const d = SAILBOAT_ART;
  const f = boatFrameSize(d);
  const px = new Px(f.w * BOAT_ATLAS_COLS, f.h * BOAT_ATLAS_ROWS);
  for (let phase = 0; phase < BOAT_PHASES; phase++)
    for (let dir = 0; dir < 8; dir++)
      paintBoatCell(px, (dir % BOAT_ATLAS_COLS) * f.w, (phase * 2 + Math.floor(dir / BOAT_ATLAS_COLS)) * f.h, d, dir, phase, 1);
  return [{ key: `veh_art_${SAILBOAT_ID}`, width: f.w * BOAT_ATLAS_COLS, height: f.h * BOAT_ATLAS_ROWS, pixels: px.data }];
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
 * Atlas sources for the three generated atlases (same { url, emissiveUrl } shape as sourcesFromManifest).
 * view.ts merges these over the manifest's debug paths before setRegistry, so the registry's boat
 * sprites draw the painted pixels. Returns only the atlases that converted (empty in a canvas-less
 * environment).
 */
export async function task421AtlasSources(): Promise<Map<string, AtlasSource>> {
  const out = new Map<string, AtlasSource>();
  for (const a of paintTask421Atlases()) {
    const url = await canvasToBlobURL(a.width, a.height, a.pixels);
    if (url) out.set(a.key, { url, emissiveUrl: null });
  }
  return out;
}

/**
 * Atlas sources for the three tier-2 motorboat atlases (ADR-422). Same shape as task421AtlasSources;
 * view.ts merges these over the pack/task422 fragment's debug paths before setRegistry.
 */
export async function task422AtlasSources(): Promise<Map<string, AtlasSource>> {
  const out = new Map<string, AtlasSource>();
  for (const a of paintTask422Atlases()) {
    const url = await canvasToBlobURL(a.width, a.height, a.pixels);
    if (url) out.set(a.key, { url, emissiveUrl: null });
  }
  return out;
}

/**
 * Atlas sources for the ADR-479 sailboat atlas. Same shape as task422AtlasSources; view.ts merges
 * these over the pack/task479 fragment's debug path before setRegistry.
 */
export async function task479AtlasSources(): Promise<Map<string, AtlasSource>> {
  const out = new Map<string, AtlasSource>();
  for (const a of paintTask479Atlases()) {
    const url = await canvasToBlobURL(a.width, a.height, a.pixels);
    if (url) out.set(a.key, { url, emissiveUrl: null });
  }
  return out;
}

// ---- menu icons (ADR-357 pattern) -------------------------------------------------------
// The three kit items' sprite keys (`item_vehicle_kit_<boat>`) have no CSS rule and no atlas cell
// (the generated vitems_icons block covers the motor kits only) — they fall back to the fiber
// category icon today. Until a binary art pass paints those cells, the crafting recipe tiles and
// inventory/hotbar slots show each boat's own art, painted at runtime from the world cell painter
// below (kits reuse the world cell painter at icon scale, SE view, mid-stroke — the most readable
// pose, so the icon IS the boat). A future binary art pass should remove installBoatMenuIcons()
// (one call in view.ts) and the icons will light up from the atlas with no other code change.

/** Item icon keys this module paints: the three boat kits. */
export const BOAT_MENU_ICON_KEYS = ["item_vehicle_kit_raft", "item_vehicle_kit_canoe", "item_vehicle_kit_rowboat"] as const;
export type BoatMenuIconKey = (typeof BOAT_MENU_ICON_KEYS)[number];

/** The def id behind a kit icon key. */
export const kitDefOfIcon = (key: BoatMenuIconKey): BoatId | undefined => {
  const m = /^item_vehicle_kit_(.+)$/.exec(key);
  return m && (BOAT_IDS as readonly string[]).includes(m[1]!) ? m[1] as BoatId : undefined;
};

/**
 * Paint one menu icon (128x128, pure — no DOM). Kit icons re-run the world cell painter at icon scale
 * (SE view, Art frame 1, mid-stroke phase 1); the boat sits on the tile's baseline like the store icons.
 */
export function paintBoatMenuIconPixels(key: BoatMenuIconKey): { width: number; height: number; pixels: Uint8ClampedArray } {
  const px = new Px(128, 128);
  const def = kitDefOfIcon(key);
  if (def) {
    const d = BOAT_ART[def], f = boatFrameSize(d);
    const s = Math.min(1, 118 / f.w, 104 / f.h);
    // Pivot at (64, 100): the boat sits on the tile's baseline like the store icons do.
    const ox = 64 - f.px * s, oy = 100 - f.py * s;
    paintBoatCell(px, ox, oy, d, 1, 1, s);
  }
  return { width: 128, height: 128, pixels: px.data };
}

/**
 * Painted 128px icon -> PNG data URL via a document canvas (sync); undefined when no canvas exists
 * (jsdom / headless). The browser downscales the 128px PNG into the 32px tile box (image-rendering:auto).
 */
export function boatMenuIconDataUrl(key: BoatMenuIconKey, doc?: Document): string | undefined {
  try {
    const d = doc ?? (globalThis as { document?: Document }).document;
    if (!d) return undefined;
    const { width, height, pixels } = paintBoatMenuIconPixels(key);
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
 * vitems_icons block (same [data-icon="..."] attribute selector, later in document order).
 */
export function boatMenuIconsCss(urls: ReadonlyMap<string, string>): string {
  const rules: string[] = [];
  for (const key of BOAT_MENU_ICON_KEYS) {
    const url = urls.get(key);
    if (url) rules.push(`[data-icon="${key}"]{--cz-icon:url("${url}");--cz-ipos:center;--cz-isize:contain}`);
  }
  return rules.join("\n");
}

/**
 * Install the runtime menu icons for the three boat kits: paint each icon, build the override
 * stylesheet, and append (or replace) <style id="task421-menu-icons"> in the document head.
 * Idempotent; safe no-op (returns false, appends nothing) when no canvas exists and no URLs are
 * supplied. `urls` is a test seam — production callers omit it and the icons are painted from the canvas.
 */
export function installBoatMenuIcons(doc?: Document, urls?: ReadonlyMap<string, string>): boolean {
  const d = doc ?? (globalThis as { document?: Document }).document;
  if (!d) return false;
  const resolved = new Map<string, string>();
  for (const key of BOAT_MENU_ICON_KEYS) {
    const u = urls?.get(key) ?? boatMenuIconDataUrl(key, d);
    if (u) resolved.set(key, u);
  }
  if (resolved.size === 0) return false;
  const css = boatMenuIconsCss(resolved);
  let style = d.getElementById("task421-menu-icons") as HTMLStyleElement | null;
  if (!style) { style = d.createElement("style"); style.id = "task421-menu-icons"; d.head.appendChild(style); }
  style.textContent = css;
  return true;
}

// ---- tier-2 motorboat menu icons (ADR-422, same ADR-357 pattern as the tier-1 kits) ---------------
// The three motorboat kit items have no atlas cell or CSS rule either — same runtime-painted icons
// from the world cell painter (SE view, full-throttle phase 1, the most readable pose).

/** Item icon keys this module paints: the three motorboat kits. */
export const MOTORBOAT_MENU_ICON_KEYS = ["item_vehicle_kit_motorboat", "item_vehicle_kit_pontoon", "item_vehicle_kit_speedboat"] as const;
export type MotorBoatMenuIconKey = (typeof MOTORBOAT_MENU_ICON_KEYS)[number];

/** The def id behind a motorboat kit icon key. */
export const motorKitDefOfIcon = (key: MotorBoatMenuIconKey): MotorBoatId | undefined => {
  const m = /^item_vehicle_kit_(.+)$/.exec(key);
  return m && (MOTORBOAT_IDS as readonly string[]).includes(m[1]!) ? m[1] as MotorBoatId : undefined;
};

/**
 * Paint one motorboat menu icon (128x128, pure — no DOM). Same framing as the tier-1 icons.
 */
export function paintMotorboatMenuIconPixels(key: MotorBoatMenuIconKey): { width: number; height: number; pixels: Uint8ClampedArray } {
  const px = new Px(128, 128);
  const def = motorKitDefOfIcon(key);
  if (def) {
    const d = MOTORBOAT_ART[def], f = boatFrameSize(d);
    const s = Math.min(1, 118 / f.w, 104 / f.h);
    const ox = 64 - f.px * s, oy = 100 - f.py * s;
    paintBoatCell(px, ox, oy, d, 1, 1, s);
  }
  return { width: 128, height: 128, pixels: px.data };
}

/**
 * Painted 128px motorboat icon -> PNG data URL via a document canvas (sync); undefined when no canvas exists.
 */
export function motorboatMenuIconDataUrl(key: MotorBoatMenuIconKey, doc?: Document): string | undefined {
  try {
    const d = doc ?? (globalThis as { document?: Document }).document;
    if (!d) return undefined;
    const { width, height, pixels } = paintMotorboatMenuIconPixels(key);
    const data = new ImageData(new Uint8ClampedArray(pixels), width, height);
    const cv = d.createElement("canvas"); cv.width = width; cv.height = height;
    const ctx = cv.getContext("2d");
    if (!ctx) return undefined;
    ctx.putImageData(data, 0, 0);
    const url = cv.toDataURL("image/png");
    return url && url !== "data:," ? url : undefined;
  } catch { return undefined; }
}

/** One override rule per motorboat icon key (same shape as boatMenuIconsCss). */
export function motorboatMenuIconsCss(urls: ReadonlyMap<string, string>): string {
  const rules: string[] = [];
  for (const key of MOTORBOAT_MENU_ICON_KEYS) {
    const url = urls.get(key);
    if (url) rules.push(`[data-icon="${key}"]{--cz-icon:url("${url}");--cz-ipos:center;--cz-isize:contain}`);
  }
  return rules.join("\n");
}

/**
 * Install the runtime menu icons for the three motorboat kits: paint each icon, build the override
 * stylesheet, and append (or replace) <style id="task422-menu-icons"> in the document head.
 * Idempotent; safe no-op (returns false, appends nothing) when no canvas exists and no URLs are
 * supplied. `urls` is a test seam — production callers omit it and the icons are painted from the canvas.
 */
export function installMotorboatMenuIcons(doc?: Document, urls?: ReadonlyMap<string, string>): boolean {
  const d = doc ?? (globalThis as { document?: Document }).document;
  if (!d) return false;
  const resolved = new Map<string, string>();
  for (const key of MOTORBOAT_MENU_ICON_KEYS) {
    const u = urls?.get(key) ?? motorboatMenuIconDataUrl(key, d);
    if (u) resolved.set(key, u);
  }
  if (resolved.size === 0) return false;
  const css = motorboatMenuIconsCss(resolved);
  let style = d.getElementById("task422-menu-icons") as HTMLStyleElement | null;
  if (!style) { style = d.createElement("style"); style.id = "task422-menu-icons"; d.head.appendChild(style); }
  style.textContent = css;
  return true;
}

// ---- ADR-479 sailboat menu icon (same ADR-357 pattern as the tier-1/2 kit icons) ------------------
// The sailboat kit item has no atlas cell or CSS rule either — same runtime-painted icon from the
// world cell painter (SE view, full-sail phase 1, the most readable pose).

/** Item icon key this module paints: the sailboat kit. */
export const SAILBOAT_MENU_ICON_KEYS = ["item_vehicle_kit_sailboat"] as const;
export type SailboatMenuIconKey = (typeof SAILBOAT_MENU_ICON_KEYS)[number];

/** The def id behind the sailboat kit icon key. */
export const sailKitDefOfIcon = (key: SailboatMenuIconKey): SailboatId | undefined => {
  const m = /^item_vehicle_kit_(.+)$/.exec(key);
  return m && m[1] === SAILBOAT_ID ? SAILBOAT_ID : undefined;
};

/**
 * Paint the sailboat menu icon (128x128, pure — no DOM). Same framing as the tier-1/2 icons.
 */
export function paintSailboatMenuIconPixels(key: SailboatMenuIconKey): { width: number; height: number; pixels: Uint8ClampedArray } {
  const px = new Px(128, 128);
  const def = sailKitDefOfIcon(key);
  if (def) {
    const d = SAILBOAT_ART, f = boatFrameSize(d);
    const s = Math.min(1, 118 / f.w, 104 / f.h);
    const ox = 64 - f.px * s, oy = 100 - f.py * s;
    paintBoatCell(px, ox, oy, d, 1, 1, s);
  }
  return { width: 128, height: 128, pixels: px.data };
}

/**
 * Painted 128px sailboat icon -> PNG data URL via a document canvas (sync); undefined when no canvas exists.
 */
export function sailboatMenuIconDataUrl(key: SailboatMenuIconKey, doc?: Document): string | undefined {
  try {
    const d = doc ?? (globalThis as { document?: Document }).document;
    if (!d) return undefined;
    const { width, height, pixels } = paintSailboatMenuIconPixels(key);
    const data = new ImageData(new Uint8ClampedArray(pixels), width, height);
    const cv = d.createElement("canvas"); cv.width = width; cv.height = height;
    const ctx = cv.getContext("2d");
    if (!ctx) return undefined;
    ctx.putImageData(data, 0, 0);
    const url = cv.toDataURL("image/png");
    return url && url !== "data:," ? url : undefined;
  } catch { return undefined; }
}

/** One override rule for the sailboat icon key (same shape as motorboatMenuIconsCss). */
export function sailboatMenuIconsCss(urls: ReadonlyMap<string, string>): string {
  const rules: string[] = [];
  for (const key of SAILBOAT_MENU_ICON_KEYS) {
    const url = urls.get(key);
    if (url) rules.push(`[data-icon="${key}"]{--cz-icon:url("${url}");--cz-ipos:center;--cz-isize:contain}`);
  }
  return rules.join("\n");
}

/**
 * Install the runtime menu icon for the sailboat kit: paint the icon, build the override
 * stylesheet, and append (or replace) <style id="task479-menu-icons"> in the document head.
 * Idempotent; safe no-op (returns false, appends nothing) when no canvas exists and no URLs are
 * supplied. `urls` is a test seam — production callers omit it and the icon is painted from the canvas.
 */
export function installSailboatMenuIcons(doc?: Document, urls?: ReadonlyMap<string, string>): boolean {
  const d = doc ?? (globalThis as { document?: Document }).document;
  if (!d) return false;
  const resolved = new Map<string, string>();
  for (const key of SAILBOAT_MENU_ICON_KEYS) {
    const u = urls?.get(key) ?? sailboatMenuIconDataUrl(key, d);
    if (u) resolved.set(key, u);
  }
  if (resolved.size === 0) return false;
  const css = sailboatMenuIconsCss(resolved);
  let style = d.getElementById("task479-menu-icons") as HTMLStyleElement | null;
  if (!style) { style = d.createElement("style"); style.id = "task479-menu-icons"; d.head.appendChild(style); }
  style.textContent = css;
  return true;
}
