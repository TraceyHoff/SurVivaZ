/** ADR-273: one geographic compass for every client. North is world (-1,-1), east (+1,-1).
 * Transform.facing and wind directions remain world atan2(dy,dx) radians; grid/art axes do not change. */
import { NORTH_FACING } from "@engine/world";
/** World facing radians from a geographic compass heading (degrees clockwise from north). */
export const compassFacing = (heading: number): number => NORTH_FACING + heading * Math.PI / 180;
/** Heading in degrees, 0 = north, clockwise, in [0, 360). */
export const compassHeading = (facing: number): number => {
  const deg = (facing - NORTH_FACING) * 180 / Math.PI;
  return ((deg % 360) + 360) % 360;
};
/** 8-point compass label for a heading in degrees. */
export const compassDir = (heading: number): string => {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
  return dirs[Math.floor(((heading % 360) + 360) % 360 / 45 + 0.5) % 8]!;
};
/** Heading + label for a world facing angle. */
export const compassOf = (facing: number): { heading: number; dir: string } => {
  const heading = compassHeading(facing); return { heading, dir: compassDir(heading) };
};

/** ADR-524: Interact only picks a target right in front — a ±60° half-angle cone (dot >= 0.5). */
export const INTERACT_FACING_DOT = 0.5;
/** True when (tx, ty) lies inside the ±60° cone around `facing` (world atan2 radians, same convention as
 *  Transform.facing); a target on top of the actor counts as in front. Shared by the player's Interact
 *  pick (menus.ts) and the bots' door / container work (ai/base_behaviors.ts). */
export function inFrontOf(fx: number, fy: number, facing: number, tx: number, ty: number): boolean {
  const dx = tx - fx, dy = ty - fy, d = Math.hypot(dx, dy);
  if (d < 0.01) return true;
  return (dx * Math.cos(facing) + dy * Math.sin(facing)) / d >= INTERACT_FACING_DOT;
}
