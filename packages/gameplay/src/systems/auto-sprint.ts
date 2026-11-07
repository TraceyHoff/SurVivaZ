/** ADR-289: one on-foot rule for every human/device, independent of the legacy vehicle-boost bit. */
import type { Entity, World } from "@engine/core";
import { AutoSprint } from "../components.js";

export const AUTO_SPRINT_SECONDS = 4;
/** Compare against the initial heading, not the previous frame: wobble is OK, circling is not a straight run-up. */
export const AUTO_SPRINT_HEADING_COS = Math.cos(Math.PI / 3);
export function autoSprintReady(world: World, e: Entity, dx: number, dy: number, dt: number): boolean {
  if (!world.has(e, AutoSprint)) world.add(e, AutoSprint);
  const state = world.get(e, AutoSprint)!;
  const length = Math.hypot(dx, dy);
  if (!length) {
    if (state.seconds || state.headingX || state.headingY) world.set(e, AutoSprint, { seconds: 0, headingX: 0, headingY: 0 });
    return false;
  }
  // Once warmed up, even reversing direction keeps the latch until movement input stops.
  if (state.seconds >= AUTO_SPRINT_SECONDS) return true;
  const x = dx / length, y = dy / length;
  const same = state.seconds > 0 && x * state.headingX + y * state.headingY >= AUTO_SPRINT_HEADING_COS - 1e-6;
  const seconds = Math.min(AUTO_SPRINT_SECONDS, (same ? state.seconds : 0) + Math.max(0, dt));
  const ready = seconds >= AUTO_SPRINT_SECONDS - 1e-5;
  world.set(e, AutoSprint, { seconds: ready ? AUTO_SPRINT_SECONDS : seconds, headingX: same ? state.headingX : x, headingY: same ? state.headingY : y });
  return ready;
}
