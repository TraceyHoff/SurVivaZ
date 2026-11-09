/**
 * ADR-314: door / gate swing animation on the render clock (like ADR-218 fireAnim).
 *
 * Every `door: true` piece has a `<sprite>_swing` building sprite (Art 0159d391) with states swing1..swing4 and an
 * `animations.swing` (loop false) at 16 fps (doors, hatch, shutters, garden gates) or 11 fps (gate_clan, clan_hall_door).
 * Opening plays swing1 -> swing2 -> swing3 -> swing4 and then the piece's own `open` state; closing plays swing4 -> swing1 and
 * then `closed`. One frame each, so a full open shows 5 frames (16 fps: 312.5 ms, 11 fps: ~455 ms) counting the end frame.
 *
 * The replicated DoorState.open drives it; nothing new goes over the wire. Each client animates the change it observes.
 * The first observation of a door (initial load, join, streaming into view) snaps with no playback, and changes into or
 * out of the breached state (2, gate_clan forced open / repaired shut) snap too: a breached gate stays open.
 */

/** Swing steps between the closed and the open art. */
export const DOOR_SWING_STEPS = 4;
/** Fallback fps when a swing sprite declares none (Art: doors 16, clan pieces 11). */
export const DOOR_SWING_FPS = 16;
export const DOOR_SWING_FPS_CLAN = 11;
/** DoorState.open values (gameplay: 0 closed, 1 open, 2 breached). */
const DOOR_CLOSED = 0, DOOR_BREACHED = 2;

/**
 * Swing step (1..4 = swing1..swing4) shown `elapsed` seconds into an opening (or closing) at `fps`, or 0 when the
 * swing is over and the piece's own open / closed art shows. Opening: 1, 2, 3, 4; closing: 4, 3, 2, 1.
 */
export function doorSwingStep(elapsed: number, fps: number, opening: boolean): number {
  if (!(elapsed >= 0) || !(fps > 0)) return 0;
  const n = Math.floor(elapsed * fps + 1e-9);
  if (n >= DOOR_SWING_STEPS) return 0;
  return opening ? n + 1 : DOOR_SWING_STEPS - n;
}
/** Seconds the whole sequence takes (4 swing frames + the end frame). */
export const doorSwingSeconds = (fps: number): number => (DOOR_SWING_STEPS + 1) / (fps > 0 ? fps : DOOR_SWING_FPS);

interface SwingEntry { state: number; fps: number; opening: boolean; /** render-clock start (s); NaN = starts on the next frame() */ start: number; /** frames already played when a swing reversed mid-way */ offset: number; active: boolean }

/**
 * Per-door swing state. `observe` is called from the replicated-state sync with the door's DoorState.open; `step` is called by
 * the renderer with its own clock, so a swing starts on the first frame drawn after the change (no dependency on the
 * sync clock) and plays at a steady rate whatever the tick / frame rate.
 */
export class DoorSwingTracker {
  private readonly doors = new Map<number, SwingEntry>();
  /** Returns true when a swing started (a real open/close change on an already-known door). */
  observe(key: number, state: number, fps: number): boolean {
    const e = this.doors.get(key);
    if (!e) { this.doors.set(key, { state, fps, opening: false, start: NaN, offset: 0, active: false }); return false; } // first sight: snap
    if (e.state === state) return false;
    const was = e.state; e.state = state; e.fps = fps;
    if (was === DOOR_BREACHED || state === DOOR_BREACHED || (was !== DOOR_CLOSED) === (state !== DOOR_CLOSED)) { e.active = false; return false; } // breach / repair snap
    const opening = state !== DOOR_CLOSED;
    // reversing mid-swing continues from the step on screen instead of jumping to the other end
    let offset = 0;
    if (e.active) { const cur = this.lastStep.get(key) ?? 0; if (cur > 0) offset = opening ? cur - 1 : DOOR_SWING_STEPS - cur; }
    e.opening = opening; e.start = NaN; e.offset = offset; e.active = true;
    return true;
  }
  private readonly lastStep = new Map<number, number>();
  /** Swing step 1..4 to draw now (render clock `now`, seconds), or 0 = draw the piece's own state art. */
  step(key: number, now: number): number {
    const e = this.doors.get(key); if (!e || !e.active) return 0;
    if (Number.isNaN(e.start)) e.start = now - e.offset / e.fps;
    const s = doorSwingStep(now - e.start, e.fps, e.opening);
    if (s === 0) { e.active = false; this.lastStep.delete(key); } else this.lastStep.set(key, s);
    return s;
  }
  /** True while a swing is playing (pending or in progress). */
  swinging(key: number): boolean { return this.doors.get(key)?.active ?? false; }
  forget(key: number): void { this.doors.delete(key); this.lastStep.delete(key); }
  get size(): number { return this.doors.size; }
}
