/**
 * ADR-319 mount rendering helpers (pure; view.ts and gather-fx.ts call them).
 * - Realism: animal sprites of a rideable species draw at mountRenderScale (real head / antler / hump height next to the
 *   1.75 m player = 58 px), see packages/gameplay/data/mounts.json `scale` + ADR-319 table.
 * - Rider: drawn at the mount's position, lifted by the saddle seat height (seatM - riderSitHipM) in terrain z steps,
 *   seated (render state Sit, vehicle anim chain). Dedicated mount art may carry a per-frame "rider" anchor (px above the
 *   pivot at 1x); when present it wins over the table seat height (the art hook).
 * - Saddle overlay: sprite key `saddle_<tier>_<species>`; drawn only when the pack has that dedicated art (none yet).
 */
import type { Entity, World } from "@engine/core";
import { Animal, Mount, MOUNT_SCALE, mountSpecies, mountSpeciesOfAnimal, PX_PER_M, Riding, riderSeatLiftZ, targetTopPx, animalDefs } from "@engine/gameplay";

/** Creature-bar css px per character art px (human bar 74 px over the ~58 px player). */
export const BAR_PX_PER_ART_PX = 74 / MOUNT_SCALE.playerHeightPx;
/** Seat lift (terrain z units) for a rider; a dedicated sprite's "rider" anchor (px from the pivot, 1x, either sign) wins. */
export function riderSeatZ(species: number, anchorY?: number, spriteScale = 1): number {
  if (anchorY === undefined || !Number.isFinite(anchorY)) return riderSeatLiftZ(species);
  return Math.max(0, (Math.abs(anchorY) * spriteScale - MOUNT_SCALE.riderSitHipM * PX_PER_M) / MOUNT_SCALE.zStepPx);
}
/** Saddle overlay sprite key for a tier on a species (`saddle_1_horse` … `saddle_4_buffalo`); "" when bareback. */
export const saddleOverlayKey = (tier: number, species: number): string => { const s = mountSpecies(species); return tier > 0 && s ? `saddle_${tier}_${s.key}` : ""; };
/** Creature hp bar lift (css px at zoom 1): tall rideable animals and seated riders get a higher bar; undefined = default. */
export function creatureBarLift(world: World, e: Entity, kind: "human" | "animal" | "zombie"): number | undefined {
  if (kind === "animal" && world.has(e, Animal)) {
    const key = animalDefs()[world.getField(e, Animal, "kind") ?? -1]?.key; const s = mountSpecies(mountSpeciesOfAnimal(key));
    return s ? Math.round(targetTopPx(s) * BAR_PX_PER_ART_PX) + 6 : undefined;
  }
  if (kind === "human" && world.isRegistered(Riding) && world.has(e, Riding)) return Math.round(74 + riderSeatLiftZ(world.getField(e, Riding, "species") ?? 0) * MOUNT_SCALE.zStepPx * BAR_PX_PER_ART_PX);
  return undefined;
}
/** True when `e` is a mount owned by player id `pid` (ally-coloured bar like own pets). */
export const isOwnMount = (world: World, e: Entity, pid: number): boolean => !!pid && world.isRegistered(Mount) && world.has(e, Mount) && world.getField(e, Mount, "owner") === pid;
