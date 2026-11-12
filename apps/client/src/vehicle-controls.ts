/**
 * ADR-170 vehicle controls on every device. Gameplay had the whole vehicle loop (deploy a kit, enter / exit, drive,
 * engine + headlight toggles) but the client never sent any of it, so a crafted kit was a dead item.
 * - Interact (E / pad X / touch "Use") enters the nearest vehicle in reach, or exits the one you ride.
 * - Vehicle.Engine (V / pad RB+Y / touch "Engine") and Vehicle.Lights (F / pad RB+B / touch "Lights") toggle the
 *   driven vehicle's VehicleState bits (server: driver only). Touch buttons exist only in the driving layout.
 * - Deploy: the inventory panel lists carried kits (gameplay-panels.ts, deployKitIntent).
 * DOM hook: `#vehicle-hud[data-engine][data-lights]` (a small status chip while driving).
 */
import { Transform, type Entity, type World } from "@engine/core";
import { eidOfNetId } from "@engine/net";
import {
  Driver, Vehicle, VehicleState, VehicleEnterCmd, VehicleExitCmd, VehicleEngineCmd, VehicleHeadlightsCmd, VehicleDeployCmd,
  VEHICLE_ENGINE_ON, VEHICLE_HEADLIGHTS, VEHICLE_TUNING, vehicleDefOf, isDrawnDef, kitVehicle, type MenuIntent,
} from "@engine/gameplay";

export interface VehicleControlsDeps {
  world(): World; player(): Entity | undefined; send(i: MenuIntent): boolean;
  input: { pressed(a: string): boolean };
  /** driving changed: main swaps the touch layout (engine / lights buttons only while driving) */
  onDrivingChange?(driving: boolean): void;
  toast?(t: string): void;
}
/** The vehicle entity `player` rides, if any. */
export function ridden(w: World, player: Entity): Entity | undefined {
  if (!w.isRegistered(Driver) || !w.has(player, Driver)) return undefined;
  const id = w.getField(player, Driver, "vehicleNetId") ?? 0; return id ? eidOfNetId(w, id) : undefined;
}
/** Nearest vehicle with seats whose enter reach (half length + enterReach) covers the player. */
export function nearestEnterable(w: World, player: Entity): Entity | undefined {
  if (!w.isRegistered(Vehicle)) return undefined; const me = w.get(player, Transform); if (!me) return undefined;
  let best: Entity | undefined, bd = Infinity;
  for (const v of w.query([Vehicle, Transform])) {
    const d = vehicleDefOf(w, v); if (!d || d.seats === 0) continue; const t = w.get(v, Transform)!;
    const dist = Math.hypot(t.x - me.x, t.y - me.y); if (dist <= d.footprint.length / 2 + VEHICLE_TUNING.enterReach && dist < bd) { bd = dist; best = v; }
  }
  return best;
}
export const vehicleFlagsOf = (w: World, v: Entity): number => (w.isRegistered(VehicleState) && w.has(v, VehicleState) ? w.getField(v, VehicleState, "flags") ?? 0 : 0);
export const engineIntent = (v: Entity): MenuIntent => ({ cmd: VehicleEngineCmd, args: { target: v, on: 2 }, entities: ["target"] });
export const lightsIntent = (v: Entity): MenuIntent => ({ cmd: VehicleHeadlightsCmd, args: { target: v, on: 2 }, entities: ["target"] });
export const enterIntent = (v: Entity): MenuIntent => ({ cmd: VehicleEnterCmd, args: { target: v, seat: 255 }, entities: ["target"] });
export const exitIntent = (): MenuIntent => ({ cmd: VehicleExitCmd, args: {} });
/** Deploy the kit in `slot` 2.5 tiles ahead of the player (deploy reach is checked by the server). */
export function deployKitIntent(w: World, player: Entity, slot: number): MenuIntent | undefined {
  const t = w.get(player, Transform); if (!t) return undefined; const f = t.facing || 0;
  return { cmd: VehicleDeployCmd, args: { slot, x: t.x + Math.cos(f) * 2.5, y: t.y + Math.sin(f) * 2.5, heading: f } };
}
export const isKit = (w: World, item: number): boolean => { try { return !!kitVehicle(w, item); } catch { return false; } };

export interface VehicleControls { update(): boolean; readonly driving: boolean; destroy(): void }
export function mountVehicleControls(root: HTMLElement, d: VehicleControlsDeps): VehicleControls {
  const hud = document.createElement("div"); hud.id = "vehicle-hud"; hud.style.cssText = "position:absolute;left:50%;top:calc(env(safe-area-inset-top,0px) + 54px);transform:translateX(-50%);z-index:5;display:none;gap:6px;padding:3px 10px;border-radius:10px;background:rgba(20,16,12,.55);color:#FFFAF0;font:600 12px Fredoka,system-ui,sans-serif;pointer-events:none;white-space:nowrap";
  root.append(hud);
  let driving = false;
  const update = (): boolean => {
    const w = d.world(), p = d.player(); if (p === undefined) return false;
    const v = ridden(w, p); const now = v !== undefined;
    if (now !== driving) { driving = now; d.onDrivingChange?.(now); hud.style.display = now ? "flex" : "none"; }
    if (v !== undefined) {
      // ADR-360: a drawn vehicle has no engine or lights — the chip says nothing true about a wagon, so hide it
      // and ignore the engine/lights buttons there (Interact still exits). `driving` stays true: the driver steers.
      const drawn = (() => { try { const d = vehicleDefOf(w, v); return !!d && isDrawnDef(d); } catch { return false; } })();
      hud.style.display = drawn ? "none" : "flex";
      if (!drawn) {
        const f = vehicleFlagsOf(w, v), eng = (f & VEHICLE_ENGINE_ON) !== 0, li = (f & VEHICLE_HEADLIGHTS) !== 0;
        hud.dataset["engine"] = eng ? "on" : "off"; hud.dataset["lights"] = li ? "on" : "off";
        const txt = `Engine ${eng ? "on" : "off"} · Lights ${li ? "on" : "off"}`; if (hud.textContent !== txt) hud.textContent = txt;
        if (d.input.pressed("Vehicle.Engine")) { d.send(engineIntent(v)); return true; }
        if (d.input.pressed("Vehicle.Lights")) { d.send(lightsIntent(v)); return true; }
      }
      if (d.input.pressed("Interact")) { d.send(exitIntent()); return true; }
      return false;
    }
    if (d.input.pressed("Interact")) { const n = nearestEnterable(w, p); if (n !== undefined) { if (!d.send(enterIntent(n))) d.toast?.("Can't get in."); return true; } }
    return false;
  };
  return { update, get driving() { return driving; }, destroy: () => hud.remove() };
}
