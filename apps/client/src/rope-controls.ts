/**
 * ADR-351 rope controls on every device (template: mount-controls.ts).
 * - Interact (E / pad X tap / touch "Use") with rope equipped attaches the rope to the nearest leadable
 *   farm animal / mount in reach; the animal then follows the holder home. Releasing is by un-equipping
 *   the rope (ropeSystem) or the Lead / Release button in the animal panel — Interact never releases, so
 *   it cannot steal the gather / ride press while a lead is running.
 * No DOM of its own: the prompt is the animal panel button, and the rope itself is the rope overlay.
 */
import type { Entity, World } from "@engine/core";
import { nearestLeadable, ropeEquipped, ropeLeadIntent, type MenuIntent } from "@engine/gameplay";

export interface RopeControlsDeps {
  world(): World; player(): Entity | undefined; send(i: MenuIntent): boolean;
  input: { pressed(a: string): boolean };
  toast?(t: string): void;
}
export interface RopeControls { update(): boolean; /** rope equipped and a leadable animal in reach. */ near(): boolean }
export function mountRopeControls(d: RopeControlsDeps): RopeControls {
  const update = (): boolean => {
    const w = d.world(), p = d.player(); if (p === undefined) return false;
    if (!d.input.pressed("Interact")) return false;
    if (!ropeEquipped(w, p)) return false;
    const a = nearestLeadable(w, p); if (a === undefined) return false;
    if (!d.send(ropeLeadIntent(a))) { d.toast?.("Can't lead it."); return true; }
    return true;
  };
  const near = (): boolean => { const w = d.world(), p = d.player(); return p !== undefined && ropeEquipped(w, p) && nearestLeadable(w, p) !== undefined; };
  return { update, near };
}
