/**
 * ADR-319 mount controls on every device (template: vehicle-controls.ts).
 * - Interact (E / pad X tap / touch "Use") gets on the nearest mount you may ride, or off the one you ride.
 * - Mount.Menu (KBM U / pad LB+X / touch "Mount", shown only near a rideable animal or while riding) opens the mount
 *   panel: ride / dismount, saddlebag (normal container panel), saddle on / off / repair, feed or tame, rename.
 * DOM hook: `#mount-hud` (small status chip while riding: name · gait · HP).
 */
import type { Entity, World } from "@engine/core";
import { isRiding, stanceMode, mountDismountIntent, mountOfRider, mountRideIntent, nearestRideable, ridingHud, type MenuIntent } from "@engine/gameplay";

export interface MountControlsDeps {
  world(): World; player(): Entity | undefined; send(i: MenuIntent): boolean;
  input: { pressed(a: string): boolean };
  /** Mount.Menu: open the mount panel on this animal. */
  openMenu(m: Entity): void;
  /** riding changed (touch caption refresh). */
  onRidingChange?(riding: boolean): void;
  toast?(t: string): void;
}
export interface MountControls { update(): boolean; readonly riding: boolean; /** a rideable animal is in reach or you ride one (touch "Mount" button). */ near(): boolean; destroy(): void }
export function mountMountControls(root: HTMLElement, d: MountControlsDeps): MountControls {
  const hud = document.createElement("div"); hud.id = "mount-hud";
  hud.style.cssText = "position:absolute;left:50%;top:calc(env(safe-area-inset-top,0px) + 54px);transform:translateX(-50%);z-index:5;display:none;padding:3px 10px;border-radius:10px;background:rgba(20,16,12,.55);color:#FFFAF0;font:600 13px system-ui,sans-serif;white-space:nowrap;max-width:80vw;overflow:hidden;text-overflow:ellipsis;pointer-events:none";
  root.append(hud);
  let riding = false;
  const update = (): boolean => {
    const w = d.world(), p = d.player(); if (p === undefined) return false;
    const now = isRiding(w, p);
    if (now !== riding) { riding = now; d.onRidingChange?.(now); hud.style.display = now ? "" : "none"; }
    if (now) { const t = ridingHud(w, p) ?? ""; if (hud.textContent !== t) hud.textContent = t; }
    if (d.input.pressed("Mount.Menu")) {
      const m = now ? mountOfRider(w, p) : nearestRideable(w, p);
      if (m !== undefined) d.openMenu(m); else d.toast?.("No mount nearby.");
      return true;
    }
    if (!d.input.pressed("Interact")) return false;
    if (now) { d.send(mountDismountIntent()); return true; }
    const m = stanceMode(w, p) === 0 ? nearestRideable(w, p, undefined, true) : undefined; // carrying / asleep: Interact keeps its stance meaning
    if (m !== undefined) { if (!d.send(mountRideIntent(m))) d.toast?.("Can't get on."); return true; }
    return false;
  };
  const near = (): boolean => { const w = d.world(), p = d.player(); return p !== undefined && (isRiding(w, p) || nearestRideable(w, p) !== undefined); };
  return { update, get riding() { return riding; }, near, destroy: () => hud.remove() };
}
