// ADR-540: new predator species with full art — cougar + wolverine, painted at runtime like
// Task 34 / ADR-421 (no binary PNGs in the push snapshot: the snapshot route carries text
// only). One shared quadruped rig, two species specs: the pixels are rasterized here with the
// task34 software canvas, declared in the pack/task540 fragment (layout only), and turned into
// blob URLs by task540AtlasSources() — the packages/render/src/vehicles/atlas.ts pattern —
// which view.ts merges into the atlas sources before setRegistry.
//
// Why these two species: both are solitary ambush hunters, so they hunt alone (pack: false in
// ai.json) and never join the ADR-539 pack director (wolves + bears stay 4:1). A cougar is a
// big tawny cat with a long tail — nothing in the game looks like it (wolf: grey canid, bear:
// bulky brown, fox: small orange). A wolverine is a dark, stocky mustelid with a pale head /
// saddle stripe and a bushy tail — smaller than the wolf, heavier-built, famously ferocious
// for its size. Neither is a recolor of the wolf or the bear: different silhouettes, different
// palettes, different tails, different ears, different markings, drawn from their own specs.
// A second big cat (lynx / jaguar) would have read as a small cougar, and a second canid
// (coyote) as a wolf recolor, so both were rejected.
//
// Layout (same grid math as Task 34: 8 cols, dirStride 8, rows are directions): each atlas is
// 8 cols x 32 rows of the species' cell — idle rows 0-7 (4 frames), walk rows 8-15 (4 frames),
// attack rows 16-23 (2 frames), death rows 24-31 (2 frames). `run` reuses the walk frames at
// 12 fps (the fauna.py convention), `hit` / `swim` / `eat` fall back through the renderer's
// STATE_ANIMS table (hit -> idle, swim -> walk, eat -> idle), so they need no painted rows.
// Attack has NO fallback (Attack: ["attack"] only), so it is painted. Atlas heights stay under
// the 2048px mobile cap (cougar 448x1792, wolverine 384x1536). The user is the final visual
// check — no GL in the VM, so these are verified numerically (pixel counts, distinct
// signatures, per-cell bounds), not by eye.
import type { AtlasSource } from "@engine/render";
import { Px, TASK34_DIR_VEC } from "./task34-art.js";
import { type PaintedCacheEnv } from "./painted-cache.js";
import { defaultAssemble, paintPaintedGroup, type PaintWorkerPool } from "./painted-core.js";

/** Atlas keys this module paints (also the fragment's atlas keys). */
export const TASK540_ATLAS_KEYS = ["pred_cougar", "pred_wolverine"] as const;
/** The two new species, in ai.json / spawns.json order. */
export const TASK540_SPECIES = ["animal_cougar", "animal_wolverine"] as const;
export type Task540Species = (typeof TASK540_SPECIES)[number];

/** Atlas columns (8 directions) and rows (4 anims x 8 dirs). */
export const PREDATOR_ATLAS_COLS = 8;
export const PREDATOR_ATLAS_ROWS = 32;
/** First row of each animation's direction block. */
export const PREDATOR_ROWS = { idle: 0, walk: 8, attack: 16, death: 24 } as const;
export type PredatorAnim = keyof typeof PREDATOR_ROWS;
/** Frames per animation (idle 4, walk 4, attack 2, death 2). */
export const PREDATOR_FRAMES: Record<PredatorAnim, number> = { idle: 4, walk: 4, attack: 2, death: 2 };
/** Frame index for (anim, dir 0-7, frame) in a predator atlas (8 cols, dirStride 8). */
export const predatorFrame = (anim: PredatorAnim, dir: number, frame: number): number =>
  (PREDATOR_ROWS[anim] + (dir & 7)) * PREDATOR_ATLAS_COLS + (frame % PREDATOR_FRAMES[anim]);

type RGBA = readonly [number, number, number, number?];
/** Game-art outline (same dark plum as the placeholder generator / Task 34). */
const OUTLINE: RGBA = [40, 30, 50];
const SHADOW: RGBA = [0, 0, 0, 70];
const NOSE: RGBA = [32, 22, 24];
const EYE: RGBA = [28, 22, 18];
const EYE_LIGHT: RGBA = [255, 255, 255];
const INNER_EAR: RGBA = [232, 164, 150];

/** One species' drawing spec: proportions in cell px, colours, and the features that make it read. */
export interface QuadrupedSpec {
  key: (typeof TASK540_ATLAS_KEYS)[number];
  /** Cell size px (cougar 56, wolverine 48). */
  cell: number;
  fur: RGBA; furDark: RGBA; furLight: RGBA; belly: RGBA; muzzle: RGBA;
  /** Body ellipse radii (along / across the facing axis). */
  bodyLen: number; bodyH: number;
  legLen: number; legW: number; headR: number;
  /** "long": thin tail to the ground (cougar, dark tip); "bushy": short thick tail (wolverine). */
  tail: "long" | "bushy";
  /** Pale saddle stripe along the back (wolverine) — undefined = plain back (cougar). */
  stripe?: RGBA;
  /** Dark ear backs (cougar) vs fur ears (wolverine). */
  darkEarBacks: boolean;
}

export const COUGAR_SPEC: QuadrupedSpec = {
  key: "pred_cougar", cell: 56,
  fur: [198, 158, 104], furDark: [150, 112, 70], furLight: [222, 188, 140],
  belly: [238, 220, 190], muzzle: [238, 220, 190],
  bodyLen: 17, bodyH: 9, legLen: 13, legW: 3, headR: 7.5,
  tail: "long", darkEarBacks: true,
};
export const WOLVERINE_SPEC: QuadrupedSpec = {
  key: "pred_wolverine", cell: 48,
  fur: [74, 58, 46], furDark: [52, 40, 32], furLight: [104, 84, 66],
  belly: [96, 76, 58], muzzle: [120, 100, 78],
  bodyLen: 14, bodyH: 8.5, legLen: 8, legW: 3.5, headR: 6.5,
  tail: "bushy", stripe: [214, 196, 160], darkEarBacks: false,
};
export const TASK540_SPECS: Record<Task540Species, QuadrupedSpec> = {
  animal_cougar: COUGAR_SPEC,
  animal_wolverine: WOLVERINE_SPEC,
};

const TAU = Math.PI * 2;
/** Leg swing phase offsets (diagonal gait): front-left + back-right together. */
const LEG_PHASE = [0, Math.PI, Math.PI, 0];

/**
 * One quadruped cell at (ox, oy): `dir` 0-7 world facing, `frame` the anim frame, `anim` the
 * animation. The rig is screen-space: the body axis is the facing vector (TASK34_DIR_VEC),
 * legs hang down in screen space with swing along the axis, the head sits at the front end
 * raised above the body line, the tail at the rear. Far legs draw before the body, near legs
 * after it (the higher-screen-y hip is nearer). From behind (dirs 4-6) the muzzle and eyes
 * are hidden and only the ears + back of the head show (the owl painter's convention).
 */
export function paintQuadrupedCell(px: Px, ox: number, oy: number, dir: number, frame: number, anim: PredatorAnim, spec: QuadrupedSpec): void {
  const [dx, dy] = TASK34_DIR_VEC[dir & 7]!;
  const ang = Math.atan2(dy, dx);
  const S = spec.cell;
  const cx = ox + S / 2;
  const feetY = oy + S * 0.86;
  const facingAway = dy < -0.3;
  // Per-anim pose: bob / crouch / lunge / slump, and the head offset along the body axis.
  let bob = 0, bodyDrop = 0, bodyStretch = 1, headFwd = 0, headDrop = 0;
  if (anim === "idle") { bob = frame === 2 ? -1 : 0; }
  else if (anim === "walk") { bob = frame % 2 === 0 ? 0 : -1; }
  else if (anim === "attack") {
    if (frame === 0) { bodyDrop = 2; headFwd = -1; headDrop = 2; } // crouch back
    else { bodyStretch = 1.12; headFwd = 1.5; headDrop = 1; } // lunge
  } else if (anim === "death") {
    if (frame === 0) { bodyDrop = 3; headDrop = 3; } // slump
  }
  const dead = anim === "death" && frame === 1; // lying on its side
  const cy = feetY - spec.legLen - spec.bodyH * 0.55 + bodyDrop + bob;
  const rx = spec.bodyLen * bodyStretch, ry = dead ? spec.bodyH * 0.55 : spec.bodyH;
  // Ground shadow.
  px.ellipse(cx, feetY + 2, rx * 0.85, 3, SHADOW, null);
  // Tail (behind the body): rear end of the body axis, plus a per-frame wag.
  const wag = anim === "idle" ? [0, 0.8, 0, -0.8][frame]! : anim === "walk" ? Math.sin((frame / 4) * TAU) * 0.8 : 0;
  const rearX = cx - dx * rx * 0.9, rearY = cy - dy * rx * 0.4;
  if (spec.tail === "long") {
    // Long thin tail: three dots down the curve from the rear, dark tip at the end.
    // Kept 2px inside the cell edge even in the pure side facings (dirs 3/7), where the
    // rear sits closest to the border.
    const tx = rearX - dx * 5 + wag, ty = rearY + 7;
    px.ellipse((rearX + tx) / 2, (rearY + ty) / 2, 2.4, 2.4, spec.fur);
    px.ellipse(tx, ty, 2.2, 2.2, spec.fur);
    px.ellipse(tx - dx * 2 + wag * 0.5, ty + 4, 1.9, 1.9, spec.furDark);
  } else {
    // Bushy tail: short thick ellipse angled up off the rear, fur-dark with a pale base.
    px.ellipseRot(rearX - dx * 3, rearY - 3, 6, 3.2, ang + Math.PI / 2 + (dy >= 0 ? 0.5 : -0.5), spec.furDark);
    px.ellipseRot(rearX - dx * 2, rearY - 2, 3.5, 2, ang + Math.PI / 2, spec.furLight, null);
  }
  // Legs: hips along the body axis (+/- 0.45 rx), side offset perpendicular (+/- 0.5 ry).
  // Far side (higher screen y at the hip) draws before the body, near side after it.
  const perpX = -dy, perpY = dx;
  const swingAmp = anim === "walk" ? spec.legLen * 0.32 : anim === "attack" && frame === 1 ? spec.legLen * 0.45 : 0;
  const drawLeg = (hipX: number, hipY: number, swing: number, lift: number, far: boolean): void => {
    const footX = hipX + dx * swing, footY = feetY - lift;
    const mx = (hipX + footX) / 2, my = (hipY + footY) / 2;
    const len = Math.hypot(footX - hipX, footY - hipY) || 1;
    px.ellipseRot(mx, my, len / 2 + 0.5, spec.legW / 2, Math.atan2(footY - hipY, footX - hipX), far ? spec.furDark : spec.fur);
  };
  const legs: { hipX: number; hipY: number; swing: number; lift: number; far: boolean }[] = [];
  for (let i = 0; i < 4; i++) {
    const front = i < 2, side = i % 2 === 0 ? -1 : 1;
    const along = (front ? 0.45 : -0.45) * rx;
    const hipX = cx + dx * along + perpX * side * ry * 0.5;
    const hipY = cy + dy * along * 0.5 + perpY * side * ry * 0.5;
    const ph = (frame / 4) * TAU + LEG_PHASE[i]!;
    const swing = anim === "walk" ? Math.sin(ph) * swingAmp : anim === "attack" && frame === 1 ? (front ? swingAmp : -swingAmp * 0.6) : 0;
    const lift = anim === "walk" ? Math.max(0, Math.cos(ph)) * 2 : 0;
    legs.push({ hipX, hipY, swing, lift, far: hipY < cy });
  }
  if (!dead) for (const l of legs.filter((l) => l.far)) drawLeg(l.hipX, l.hipY, l.swing, l.lift, true);
  // Body.
  if (dead) {
    // Lying on its side: long axis horizontal, flattened, legs splayed as short stubs.
    px.ellipseRot(cx, cy + 3, rx, ry, 0, spec.fur);
    px.ellipse(cx - rx * 0.4, cy + 5, rx * 0.5, ry * 0.6, spec.belly, null);
    for (const s of [-1, 1]) {
      px.line(Math.round(cx - rx * 0.5), Math.round(cy + 4), Math.round(cx - rx * 0.5 + s * 5), Math.round(cy + 9), spec.furDark);
      px.line(Math.round(cx + rx * 0.4), Math.round(cy + 4), Math.round(cx + rx * 0.4 + s * 5), Math.round(cy + 9), spec.furDark);
    }
  } else {
    px.ellipseRot(cx, cy, rx, ry, ang, spec.fur);
    // Belly: lighter patch low inside the body (no outline: a marking, not an edge).
    px.ellipse(cx - dx * 2, cy + ry * 0.35, rx * 0.7, ry * 0.45, spec.belly, null);
    // Wolverine saddle stripe: pale band along the top of the body.
    if (spec.stripe) px.ellipseRot(cx, cy - ry * 0.45, rx * 0.75, ry * 0.32, ang, spec.stripe, null);
  }
  if (!dead) for (const l of legs.filter((l) => !l.far)) drawLeg(l.hipX, l.hipY, l.swing, l.lift, false);
  // Head: front end of the body, raised above the body line; dead frame 1 rests beside the body.
  const headX = dead ? cx + rx * 0.95 : cx + dx * rx * 0.8 + dx * headFwd;
  const headY = dead ? cy + 3 : cy - dy * rx * 0.35 - spec.headR * 0.7 + headDrop + bob;
  const hr = spec.headR;
  // Ears: two small rounds at the top of the head, leaning with the facing.
  for (const s of [-1, 1]) {
    const ex = headX + perpX * hr * 0.55 * s + dx * 1, ey = headY - hr * 0.75;
    px.ellipse(ex, ey, hr * 0.32, hr * 0.32, spec.darkEarBacks ? spec.furDark : spec.fur);
    if (!facingAway) px.ellipse(ex, ey + 0.5, hr * 0.16, hr * 0.16, INNER_EAR, null);
  }
  // Skull.
  px.ellipse(headX, headY, hr, hr * 0.94, spec.fur);
  if (spec.stripe && !facingAway) {
    // Wolverine pale crown: a light cap over the top of the head.
    px.ellipse(headX, headY - hr * 0.45, hr * 0.6, hr * 0.35, spec.stripe, null);
  }
  if (!facingAway && !dead) {
    // Muzzle + nose at the front of the head, along the facing axis. The muzzle sits close
    // to the skull (0.55 head radii) so the lunge never reaches the cell edge in side facings.
    const mx = headX + dx * hr * 0.55, my = headY + dy * hr * 0.55;
    px.ellipse(mx, my, hr * 0.55, hr * 0.42, spec.muzzle, null);
    px.ellipse(mx + dx * hr * 0.25, my + dy * hr * 0.25, hr * 0.22, hr * 0.18, NOSE, null);
    // Eyes: dark dots either side of the facing axis, with a white catch-light; idle frame 2 blinks.
    const blink = anim === "idle" && frame === 2;
    for (const s of [-1, 1]) {
      const ex = headX + perpX * hr * 0.42 * s + dx * hr * 0.15;
      const ey = headY + perpY * hr * 0.42 * s + dy * hr * 0.1 - hr * 0.15;
      if (blink) px.line(Math.round(ex - 1.5), Math.round(ey), Math.round(ex + 1.5), Math.round(ey), EYE);
      else {
        px.ellipse(ex, ey, hr * 0.2, hr * 0.22, EYE, null);
        px.set(Math.round(ex - 0.5), Math.round(ey - 0.5), EYE_LIGHT);
      }
    }
    if (anim === "attack" && frame === 1) {
      // Open jaw: dark wedge under the muzzle.
      px.tri(Math.round(mx - 2), Math.round(my + 1), Math.round(mx + 2), Math.round(my + 1), Math.round(mx + dx * 2), Math.round(my + 4), NOSE, null);
    }
  } else if (dead) {
    // X eyes on the resting head.
    for (const s of [-1, 1]) {
      const ex = headX + perpX * hr * 0.4 * s, ey = headY - hr * 0.15;
      px.line(Math.round(ex - 1.5), Math.round(ey - 1.5), Math.round(ex + 1.5), Math.round(ey + 1.5), EYE);
      px.line(Math.round(ex - 1.5), Math.round(ey + 1.5), Math.round(ex + 1.5), Math.round(ey - 1.5), EYE);
    }
  } else {
    // Back of the head: a darker crown over the body top.
    px.ellipse(headX, headY - hr * 0.4, hr * 0.6, hr * 0.4, spec.furDark, null);
  }
}

/** Painted atlas (same shape as Task 34's PaintedAtlas). */
export interface PaintedAtlas { key: string; width: number; height: number; pixels: Uint8ClampedArray }

/** Paint one species' atlas (pure: no DOM, unit-testable). */
export function paintTask540Atlas(spec: QuadrupedSpec): PaintedAtlas {
  const px = new Px(PREDATOR_ATLAS_COLS * spec.cell, PREDATOR_ATLAS_ROWS * spec.cell);
  const anims: PredatorAnim[] = ["idle", "walk", "attack", "death"];
  for (const anim of anims) {
    for (let d = 0; d < 8; d++) {
      for (let f = 0; f < PREDATOR_FRAMES[anim]; f++) {
        paintQuadrupedCell(px, f * spec.cell, (PREDATOR_ROWS[anim] + d) * spec.cell, d, f, anim, spec);
      }
    }
  }
  return { key: spec.key, width: px.w, height: px.h, pixels: px.data };
}

/**
 * Paint both ADR-540 atlases (pure: no DOM, unit-testable). Creature grid is 8 cols x 32 rows
 * of the species' cell: idle rows 0-7, walk rows 8-15, attack rows 16-23, death rows 24-31,
 * 4 / 4 / 2 / 2 frames per row. Matches the pack/task540 fragment layout exactly.
 */
export function paintTask540Atlases(): [PaintedAtlas, PaintedAtlas] {
  return [paintTask540Atlas(COUGAR_SPEC), paintTask540Atlas(WOLVERINE_SPEC)];
}

/**
 * ADR-550: content-hash input for one species — the rasterizer + rig source (literal
 * constants count) + the species spec itself, so one changed spec byte (e.g. cougar fur
 * colour) changes the hash and repaints just that species.
 */
const task540Spec = (spec: QuadrupedSpec): string =>
  `${Px.toString()}|${paintQuadrupedCell.toString()}|${JSON.stringify(spec)}`;

/** ADR-551: content-hash inputs per species atlas (exported for `painted-core.ts` + `painted-parallel.ts`). */
export const task540Specs = (): Map<string, string> =>
  new Map([COUGAR_SPEC, WOLVERINE_SPEC].map((s) => [s.key, task540Spec(s)]));

/**
 * Atlas sources for the two painted atlases (same { url, emissiveUrl } shape as
 * sourcesFromManifest). view.ts merges these over the manifest's debug paths before
 * setRegistry, so the registry's cougar / wolverine sprites draw the painted pixels.
 * ADR-550: each atlas is cache-first (painted-cache.ts) — a warm boot returns the cached
 * PNG without calling the painter at all. Returns only the atlases that converted
 * (empty in a canvas-less environment).
 */
export async function task540AtlasSources(env: PaintedCacheEnv = {}, pool?: PaintWorkerPool): Promise<Map<string, AtlasSource>> {
  // ADR-551: thin delegate to `painted-core.ts` (cache-first, groups in parallel, misses in a Worker).
  // (Was per-species `paintedAtlasURL` under ADR-550: a partial hit now repaints the group — both
  // species paint in one `paintTask540Atlases()` call anyway, ~133 ms VM for the pair.)
  return paintPaintedGroup({ name: "task540", specs: task540Specs, paint: paintTask540Atlases, assemble: defaultAssemble }, env, pool);
}
