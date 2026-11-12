/**
 * ADR-319 / ADR-320 mount rendering helpers (pure; view.ts and gather-fx.ts call them).
 * Art (fafe447e, docs/ART_KEYS_MOUNTS.md): dedicated true-scale sheets at the player's 52 px = 1.75 m
 * - `mount_<art>` (idle 4f@4, walk 6f@8, gallop 6f@12, 8 facings, per-frame `seat` anchor), drawn at scale 1;
 * - `mount_saddle_<art>_<leather|reinforced|iron|steel>` overlay, then the rider doll (`ride_<anim>`, its own `seat`
 *   socket lands on the entity position like the vehicle seat), then `mount_<art>_fore` (head / neck / near legs) on top.
 * Wild animals keep their shipped animal_* sheets; horse / donkey / yak (no wild sheet) wander on their mount sheet.
 * Layers are ordered with screen-neutral depth shifts (move along the view diagonal and up by the same screen amount),
 * so each layer lands exactly where the art puts it while its sort key is just above the one below.
 */
import type { Entity, World } from "@engine/core";
import { VIEW_COS, VIEW_SIN } from "@engine/world";
import { Mount, MOUNT_SCALE, mountArtKey, mountSpecies, Riding, riderSeatLiftZ, SADDLE_ART_TIERS, targetTopPx } from "@engine/gameplay";

/** Creature-bar css px per character art px (human bar 74 px over the 52 px doll). */
export const BAR_PX_PER_ART_PX = 74 / MOUNT_SCALE.playerHeightPx;
/** Gait index: 0 idle, 1 walk, 2 gallop (from Riding.speed vs the species walk speed). */
export function mountGait(speed: number, species: number): 0 | 1 | 2 {
  const s = mountSpecies(species); return speed < 0.05 ? 0 : s && speed > s.walk + 0.3 ? 2 : 1;
}
export const MOUNT_GAIT_ANIM = ["idle", "walk", "gallop"] as const;
export const RIDER_GAIT_ANIM = ["ride_idle", "ride_walk", "ride_gallop"] as const;
/** Mount sprite key (`mount_<art>`), fore layer key and saddle overlay key (`mount_saddle_<art>_<tier>`; "" bareback). */
export const mountSpriteKeyOf = (species: number): string => { const a = mountArtKey(species); return a ? `mount_${a}` : ""; };
export const mountForeKey = (species: number): string => { const a = mountArtKey(species); return a ? `mount_${a}_fore` : ""; };
export const saddleOverlayKey = (tier: number, species: number): string => {
  const a = mountArtKey(species); const t = SADDLE_ART_TIERS[tier - 1]; return a && t ? `mount_saddle_${a}_${t}` : "";
};
/** Harness overlay key (`mount_harness_<art>`, ADR-361 runtime-painted); "" when the species has no mount sheet. */
export const harnessOverlayKey = (species: number): string => {
  const a = mountArtKey(species); return a ? `mount_harness_${a}` : "";
};
/** Sort-key steps above the mount for the layers drawn on it. */
export const LAYER_KEY = { harness: 0.005, saddle: 0.01, rider: 0.02, fore: 0.03 } as const;
const ZSTEP = MOUNT_SCALE.zStepPx, TILE_W = 64;
/**
 * World offset (x, y, z) that leaves a sprite at the same screen spot but raises its depth key by `key`
 * (key = u + v + z / 3; screen y = (u + v) * 16 - z * 16). View rotation `q` (ADR-253) turns the diagonal.
 */
export function screenNeutralShift(key: number, q = 0): { dx: number; dy: number; dz: number } {
  const d = (3 * key) / 8, c = VIEW_COS[q & 3]!, s = VIEW_SIN[q & 3]!; return { dx: d * (c + s), dy: d * (c - s), dz: 2 * d };
}
/**
 * Rider pose relative to the mount pivot: the mount frame's `seat` anchor (1x px from the pivot, +y down) raises the rider
 * by -seat.y px and moves them seat.x px sideways on screen; without an anchor the realism-table seat height is used.
 * The depth shift then puts the rider's key just above the mount's (LAYER_KEY.rider) whatever the lift.
 */
export function riderPose(species: number, seat: { x: number; y: number } | undefined, q = 0): { dx: number; dy: number; dz: number } {
  const lift = seat ? Math.max(0, -seat.y) / ZSTEP : riderSeatLiftZ(species);
  const sx = seat ? seat.x / TILE_W : 0; const c = VIEW_COS[q & 3]!, s = VIEW_SIN[q & 3]!;
  // screen-x shift: (u, v) = (sx, -sx); key cancels the lift's z/3 so only LAYER_KEY.rider remains
  const n = screenNeutralShift(LAYER_KEY.rider - lift / 3, q);
  return { dx: n.dx + sx * (c - s), dy: n.dy + sx * (-s - c), dz: lift + n.dz };
}
/** Seat lift (terrain z units) for a rider; kept for callers without frame data (table seat height). */
export function riderSeatZ(species: number, anchorY?: number): number {
  return anchorY === undefined || !Number.isFinite(anchorY) ? riderSeatLiftZ(species) : Math.max(0, -anchorY) / ZSTEP;
}
/** Creature hp bar lift (css px at zoom 1): tamed mounts at their real head height and seated riders higher; undefined = default. */
export function creatureBarLift(world: World, e: Entity, kind: "human" | "animal" | "zombie"): number | undefined {
  if (kind === "animal" && world.isRegistered(Mount) && world.has(e, Mount)) {
    const s = mountSpecies(world.getField(e, Mount, "species") ?? 0); return s ? Math.round(targetTopPx(s) * BAR_PX_PER_ART_PX) + 6 : undefined;
  }
  if (kind === "human" && world.isRegistered(Riding) && world.has(e, Riding)) return Math.round(74 + riderSeatLiftZ(world.getField(e, Riding, "species") ?? 0) * ZSTEP * BAR_PX_PER_ART_PX);
  return undefined;
}
/** True when `e` is a mount owned by player id `pid` (ally-coloured bar like own pets). */
export const isOwnMount = (world: World, e: Entity, pid: number): boolean => !!pid && world.isRegistered(Mount) && world.has(e, Mount) && world.getField(e, Mount, "owner") === pid;

// ---- ADR-322: mount actions (Art 9281a1bd) and the rider during them -------------------------------------------
/** Mount action anims on mount_<art>, mount_<art>_fore and every saddle overlay (moose also swim). */
export type MountAct = "hit" | "death" | "graze" | "swim";
/** mount_anchors.json `acts.riderAnim`: hit / graze / swim keep the rider seated on `ride_idle` (its own clock, pinned to
 *  the act's seat anchor every tick); death has none: the rider gets off. */
export const RIDER_ACT_ANIM: Readonly<Record<MountAct, "ride_idle" | null>> = { hit: "ride_idle", graze: "ride_idle", swim: "ride_idle", death: null };
/** View anim state (core AnimState) of a mount -> the action it plays (undefined = a gait: idle / walk / gallop).
 *  Swim counts only when the sheet has dedicated swim frames (moose); others keep the walk + waterline fallback. */
export function mountActOf(state: number, hasSwim: boolean): MountAct | undefined {
  return state === 4 ? "hit" : state === 5 ? "death" : state === 8 || state === 9 ? "graze" : state === 14 && hasSwim ? "swim" : undefined;
}
/** How the rider plays during `act`: seated on ride_idle with its own clock, or dismounted (death). Gaits: frame-locked. */
export function riderActPlan(act: MountAct | undefined): { anim: (typeof RIDER_GAIT_ANIM)[number] | null; ownClock: boolean } {
  if (!act) return { anim: null, ownClock: false };
  const a = RIDER_ACT_ANIM[act]; return { anim: a, ownClock: a !== null };
}
/** Rider VAnim start tick: frame-locked to the mount's gait (rider frame fi = mount frame fi, same fps), or its own clock
 *  (started when the act began) while the mount plays an action whose frame count differs from ride_idle. */
export const riderStartTick = (act: MountAct | undefined, mountStart: number, actStart: number): number => (riderActPlan(act).ownClock ? actStart : mountStart);
/** Doll pivot offset from the mount pivot: mount seat anchor minus the doll's own ride_* seat socket (= riderOffset). */
export const riderPivotOffset = (mountSeat: { x: number; y: number }, riderSeat: { x: number; y: number }): { x: number; y: number } => ({ x: mountSeat.x - riderSeat.x, y: mountSeat.y - riderSeat.y });
/** Moose swim clip for the rider: the water row (`anchors.water.y`, 1x px from the mount pivot, +y down) as px above the
 *  rider's seat pivot (sprites.ts lands the doll's ride_* seat socket on the mount seat), negative = below the seat. */
export const swimClipPx = (seatY: number, waterY: number): number => seatY - waterY;
/** Idle grazing for tamed mounts and wild horse / donkey / yak (they wander on their mount sheet): a per-entity cycle of
 *  GRAZE_ON of every GRAZE_CYCLE seconds while standing still and unridden (cosmetic, render-side only). */
export const GRAZE_CYCLE = 12, GRAZE_ON = 5;
/** Wild archetypes that wander on their mount sheet (no wild sheet; sprite_fallbacks.json animal_<k> -> mount_<k>). */
export const MOUNT_SHEET_WILD: ReadonlySet<string> = new Set(["animal_horse", "animal_donkey", "animal_yak"]);
export function idleGrazing(tick: number, tickHz: number, hash: number): boolean {
  const t = tick / Math.max(1, tickHz) + (hash % (GRAZE_CYCLE * 10)) / 10; return t % GRAZE_CYCLE < GRAZE_ON;
}
