/**
 * Gameplay camera zoom (ADR-100). The default view shows ~30% more world area than the old fixed zoom 1.6
 * (1.6 / sqrt(1.3) ≈ 1.4) at 1920x1080; ADR-175 scales it with the viewport so phones see the same world, and the
 * player's own zoom multiplier (mouse wheel, two-finger pinch, +/- keys, gamepad hold RB + D-pad ↑/↓ — ADR-177) is clamped and persisted in "engine-settings".
 * ADR-206: default ~10% closer, max zoom-in closer, and a relative eased indoor zoom under a roof.
 * ADR-304: indoor zoom is much closer (x1.55) so rooms and their contents are readable.
 */
export const LEGACY_ZOOM = 1.6;
export const AREA_GAIN = 1.3;
/** ADR-175 base (≈ 1.403); ADR-206 makes the default view ~10% closer on every device (same world span PC vs mobile). */
export const ADR175_ZOOM = LEGACY_ZOOM / Math.sqrt(AREA_GAIN);
export const DEFAULT_CLOSER = 1.1;
export const DESKTOP_ZOOM = ADR175_ZOOM * DEFAULT_CLOSER; // ≈ 1.543
/** ADR-175: reference viewport (CSS px) at which DESKTOP_ZOOM applies; every other viewport is scaled to show the same world. */
export const REF_LONG = 1920, REF_SHORT = 1080;
export const ZOOM_FLOOR = 0.3, ZOOM_CEIL = 4;
/** ADR-206: max zoom-in raised (absolute 2.24 → 2.70 at 1080p); min lowered so the farthest view (≈1.05) is unchanged. */
export const USER_ZOOM_MIN = 0.68, USER_ZOOM_MAX = 1.75;
/** ADR-206 indoor zoom: extra relative zoom while under a roof (renderer cutaway), eased with time constant INDOOR_TAU_MS. */
export const INDOOR_GAIN = 1.55, INDOOR_TAU_MS = 280, INDOOR_DEBOUNCE_MS = 180;
/** Building-mode zoom: even closer than indoor, so pieces can be placed precisely. Eased like the indoor factor. */
export const BUILD_GAIN = 1.4;
/** One frame of indoor-zoom easing: exponential approach (frame-rate independent, no pop). Returns the new factor. */
export function indoorStep(cur: number, indoor: boolean, dtMs: number): number {
  const tgt = indoor ? INDOOR_GAIN : 1; const dt = Math.max(0, Math.min(250, dtMs || 0));
  const n = cur + (tgt - cur) * (1 - Math.exp(-dt / INDOOR_TAU_MS)); return Math.abs(n - tgt) < 1e-4 ? tgt : n;
}
const KEY = "engine-settings";

/**
 * Default camera zoom (CSS px per iso px) for a CSS viewport (ADR-175). Zoom is resolution-relative, not a fixed
 * pixels-per-tile: the viewport is "contained" against the orientation-matched 1920x1080 reference, so a phone shows
 * at least as much world as PC along both axes of its own orientation (landscape: same vertical span as PC, wider if
 * the screen is wider; portrait: same span across the short side as PC's short side). DPR is not involved here:
 * the renderer multiplies by devicePixelRatio itself, so render resolution and sprite sharpness are unchanged.
 */
export function defaultZoom(cssW: number, cssH: number): number {
  if (!(cssW > 0 && cssH > 0)) return DESKTOP_ZOOM;
  const f = Math.min(Math.max(cssW, cssH) / REF_LONG, Math.min(cssW, cssH) / REF_SHORT);
  return Math.min(ZOOM_CEIL, Math.max(ZOOM_FLOOR, DESKTOP_ZOOM * f));
}
/** World extent in iso px visible at a zoom (for tests/QA). */
export const visibleIso = (cssW: number, cssH: number, zoom = defaultZoom(cssW, cssH)): { w: number; h: number } => ({ w: cssW / zoom, h: cssH / zoom });
export const clampUserZoom = (z: number): number => (Number.isFinite(z) ? Math.min(USER_ZOOM_MAX, Math.max(USER_ZOOM_MIN, z)) : 1);
type KV = Pick<Storage, "getItem" | "setItem">;
export function loadUserZoom(st: KV = localStorage): number {
  try { return clampUserZoom(Number((JSON.parse(st.getItem(KEY) ?? "{}") as { zoom?: unknown }).zoom ?? 1)); } catch { return 1; }
}
export function saveUserZoom(z: number, st: KV = localStorage): void {
  try { const cur = JSON.parse(st.getItem(KEY) ?? "{}") as Record<string, unknown>; st.setItem(KEY, JSON.stringify({ ...cur, zoom: Math.round(clampUserZoom(z) * 100) / 100 })); } catch { /* private mode */ }
}

/** ADR-177: gamepad zoom speed (log-space per second) — the full 0.75..1.6 range takes ~0.85 s of holding RB + D-pad. */
export const PAD_ZOOM_RATE = 0.9;
/** ADR-177: one frame of continuous gamepad zoom. `axis` is the Camera.Zoom value (+1 = RB+D-pad ↑ = zoom in). */
export const padZoomStep = (user: number, axis: number, dtMs: number): number =>
  clampUserZoom(user * Math.exp(Math.max(-1, Math.min(1, axis || 0)) * PAD_ZOOM_RATE * Math.max(0, Math.min(250, dtMs || 0)) / 1000));

export interface ZoomControl { readonly user: number; /** ADR-206 current indoor factor (1 = outdoors). */ readonly indoor: number;
  /** Current building-mode factor (1 = not building). */ readonly build: number;
  /** ADR-206: per-frame indoor signal (debounced) + easing step; applies camera.zoom when it moved. */ setIndoor(on: boolean, dtMs: number): void; /** Building-mode signal (same easing as indoor, no debounce — build mode toggles deliberately). */ setBuild(on: boolean, dtMs: number): void; zoom(): number; setUser(z: number): void; apply(): void; /** ADR-177 held-stick/D-pad zoom. */ nudge(axis: number, dtMs: number): void; dispose(): void }
/** Drives `camera.zoom` = defaultZoom(viewport) × user multiplier, with wheel / pinch / +- input on `el`. */
export function attachZoom(camera: { zoom: number }, el: HTMLElement, opts: { storage?: KV; viewport?: () => { w: number; h: number }; enabled?: () => boolean } = {}): ZoomControl {
  const vp = opts.viewport ?? (() => ({ w: innerWidth, h: innerHeight }));
  const on = opts.enabled ?? (() => true);
  let user = loadUserZoom(opts.storage); let saveT: ReturnType<typeof setTimeout> | undefined;
  let indoor = 1, want = false, pend = false, pendMs = 0;
  let build = 1;
  const zoom = (): number => { const v = vp(); return defaultZoom(v.w, v.h) * user * indoor * build; };
  const setIndoor = (on: boolean, dtMs: number): void => {
    if (on !== want) { if (on !== pend) { pend = on; pendMs = 0; } pendMs += Math.max(0, dtMs || 0); if (pendMs >= INDOOR_DEBOUNCE_MS) want = on; } else { pend = want; pendMs = 0; }
    const n = indoorStep(indoor, want, dtMs); if (n !== indoor) { indoor = n; apply(); }
  };
  const setBuild = (on: boolean, dtMs: number): void => {
    const tgt = on ? BUILD_GAIN : 1; const dt = Math.max(0, Math.min(250, dtMs || 0));
    const n = build + (tgt - build) * (1 - Math.exp(-dt / INDOOR_TAU_MS)); const m = Math.abs(n - tgt) < 1e-4 ? tgt : n;
    if (m !== build) { build = m; apply(); }
  };
  const apply = (): void => { camera.zoom = zoom(); };
  const setUser = (z: number): void => { user = clampUserZoom(z); apply(); clearTimeout(saveT); saveT = setTimeout(() => saveUserZoom(user, opts.storage), 300); };
  const wheel = (e: WheelEvent): void => { if (!on() || e.ctrlKey) return; e.preventDefault(); setUser(user * Math.exp(-Math.max(-100, Math.min(100, e.deltaY)) * 0.0015)); };
  const pts = new Map<number, { x: number; y: number }>(); let pinch0 = 0, user0 = 1;
  const dist = (): number => { const [a, b] = [...pts.values()]; return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0; };
  const down = (e: PointerEvent): void => { if (e.pointerType !== "touch") return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2) { pinch0 = dist(); user0 = user; } };
  const move = (e: PointerEvent): void => { if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2 && pinch0 > 40 && on()) setUser(user0 * dist() / pinch0); };
  const up = (e: PointerEvent): void => { pts.delete(e.pointerId); if (pts.size < 2) pinch0 = 0; };
  const key = (e: KeyboardEvent): void => {
    if (!on() || (e.target as HTMLElement | null)?.closest?.("input,textarea,select,[contenteditable]")) return;
    if (e.key === "=" || e.key === "+") setUser(user * 1.1); else if (e.key === "-" || e.key === "_") setUser(user / 1.1);
  };
  el.addEventListener("wheel", wheel, { passive: false });
  el.addEventListener("pointerdown", down); addEventListener("pointermove", move); addEventListener("pointerup", up); addEventListener("pointercancel", up);
  addEventListener("keydown", key); addEventListener("resize", apply); apply();
  const nudge = (axis: number, dtMs: number): void => { if (!on() || !axis) return; const n = padZoomStep(user, axis, dtMs); if (n !== user) setUser(n); };
  return { get user() { return user; }, get indoor() { return indoor; }, get build() { return build; }, setIndoor, setBuild, zoom, setUser, apply, nudge,
    dispose: () => { el.removeEventListener("wheel", wheel); el.removeEventListener("pointerdown", down); removeEventListener("pointermove", move); removeEventListener("pointerup", up); removeEventListener("pointercancel", up); removeEventListener("keydown", key); removeEventListener("resize", apply); clearTimeout(saveT); } };
}
