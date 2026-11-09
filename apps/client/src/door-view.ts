/**
 * ADR-314: doors draw their replicated open state and swing between closed and open on the render clock.
 *
 * DoorState lives on the door piece's Door attachment (PieceLink, AttachKind.Door) and is replicated. The view mirrors it
 * into the piece's building state (`closed` / `open` / `breached`) and, on a real change, starts a swing through the
 * `<sprite>_swing` art (swing1..4, Art 0159d391). The renderer asks for the swing step every frame with its own clock.
 */
import { buildPieceVisual, type AssetRegistry, type BuildPieceIn, type BuildPieceVisualOpts } from "@engine/assets";
import { DOOR_SWING_FPS, DOOR_SWING_FPS_CLAN, DOOR_SWING_STEPS, DoorSwingTracker } from "@engine/render";

/** Resolved art of one door piece: its own state indices and its swing sprite (if Art ships one). */
export interface DoorArt { visualId: number; closed: number; open: number; breached: number; swingVis?: number; swing: readonly number[]; fps: number }

const CLAN_DOORS = new Set(["gate_clan", "clan_hall_door"]);
/** Default swing rate for a piece class when the sprite declares none (Art: doors 16 fps, clan gate / hall door 11 fps). */
export const doorSwingFps = (pieceKey: string): number => (CLAN_DOORS.has(pieceKey) ? DOOR_SWING_FPS_CLAN : DOOR_SWING_FPS);

/**
 * Door art for a piece: `base` / `opts` exactly as the piece's normal buildPieceVisual call (tier, variant, rotation), so the
 * swing sprite follows the same variant (`garden_gate_swing@iron`) and falls back to the bare `<key>_swing`.
 */
export function doorArt(registry: AssetRegistry, pieceKey: string, base: Omit<BuildPieceIn, "state">, opts: BuildPieceVisualOpts): DoorArt {
  const at = (state: string) => buildPieceVisual(registry, { ...base, state }, opts);
  const c = at("closed"); const o = at("open"); const b = at("breached");
  const open = o.stateIndex; const breached = b.stateIndex >= 0 ? b.stateIndex : open; // only gate_clan ships a breached state
  const sw = buildPieceVisual(registry, { ...base, state: "swing1" }, { ...opts, pieceKey: () => `${pieceKey}_swing` });
  let swingVis: number | undefined; let swing: number[] = []; let fps = doorSwingFps(pieceKey);
  if (sw.visualId) {
    const def = registry.sprite(sw.visualId); const names = def.building?.stateNames ?? [];
    swing = Array.from({ length: DOOR_SWING_STEPS }, (_, k) => names.indexOf(`swing${k + 1}`));
    if (swing.every((i) => i >= 0)) { swingVis = sw.visualId; const f = def.animations.get("swing")?.fps; if (f && f > 0) fps = f; } else swing = [];
  }
  return { visualId: c.visualId, closed: c.stateIndex, open, breached, ...(swingVis !== undefined ? { swingVis } : {}), swing, fps };
}

/** Building state index to draw for DoorState.open (0 closed, 1 open, 2 breached). */
export const doorStateIndex = (art: DoorArt, open: number): number => (open === 2 ? art.breached : open ? art.open : art.closed);

/** Per view-entity door state: static state index + the swing tracker the renderer bindings read. */
export class DoorView {
  readonly tracker = new DoorSwingTracker();
  private readonly arts = new Map<number, DoorArt>();
  /** Record the door's replicated state; returns the building state index to draw when not swinging. A first sighting snaps. */
  sync(ve: number, open: number, art: () => DoorArt, visualId: number): number {
    let a = this.arts.get(ve);
    if (!a || a.visualId !== visualId) { a = art(); this.arts.set(ve, a); }
    this.tracker.observe(ve, open, a.fps);
    return doorStateIndex(a, open);
  }
  /** Renderer binding: swing sprite + swing state to draw at render time `now` (s), else undefined. */
  swing(ve: number, now: number): { vis: number; state: number } | undefined {
    const a = this.arts.get(ve); if (a?.swingVis === undefined) return undefined;
    const s = this.tracker.step(ve, now); if (!s) return undefined;
    return { vis: a.swingVis, state: a.swing[s - 1]! };
  }
  /** Renderer binding: the door's swing sprite (warm its streamed page while on screen). */
  swingSprite(ve: number): number | undefined { return this.arts.get(ve)?.swingVis; }
  has(ve: number): boolean { return this.arts.has(ve); }
  forget(ve: number): void { this.arts.delete(ve); this.tracker.forget(ve); }
}
