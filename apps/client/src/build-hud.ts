/**
 * ADR-136 compact build HUD: one chip (piece · tier · floor, with ▲▼ floor buttons) and, only while a placed piece is
 * targeted, one labelled contextual strip (Repair / Upgrade → tier / Demolish, with the device's button hint).
 * Also wires touch placement: tap the world to position the ghost, drag to adjust (ghost lifted above the finger).
 */
import type { BuildDevice, BuildMode } from "./build-mode.js";
import { iconUrl } from "./game-icons.js";

export interface BuildHudOptions {
  buildMode: BuildMode; device(): BuildDevice;
  /** CSS px -> world tiles (camera). */
  screenToWorld?(x: number, y: number): { x: number; y: number } | undefined;
  /** Element receiving world taps (the game canvas). */
  target?: HTMLElement;
  /** True when (x, y) CSS px lands on a virtual touch control (joystick zone / button); those touches never move the ghost. */
  blocked?(x: number, y: number): boolean;
}
interface LayoutEl { kind: string; anchor: { x: number; y: number }; radius?: number; zone?: { x: number; y: number; w: number; h: number } }
/** Hit test against a touch layout (normalised anchors/zones; radii in reference px scaled to the viewport). */
/** Build strip top on narrow screens: below the vitals panel (≈98 px) and the menu bar. */
export const NARROW_TOP_PX = 106;
export function onTouchControl(layout: { reference?: { w: number; h: number }; elements: readonly LayoutEl[] }, x: number, y: number, w: number, h: number): boolean {
  const ref = layout.reference ?? { w: 844, h: 390 }; const k = Math.min(w / ref.w, h / ref.h);
  return layout.elements.some((e) => e.zone ? x >= e.zone.x * w && x <= (e.zone.x + e.zone.w) * w && y >= e.zone.y * h && y <= (e.zone.y + e.zone.h) * h
    : Math.hypot(x - e.anchor.x * w, y - e.anchor.y * h) <= ((e.radius ?? 24) + 8) * k);
}
export const TOUCH_LIFT_PX = 48;
/** QA2: why the ghost is red (BuildFail codes from @engine/gameplay events; unknown codes fall back to "Can't place here"). */
export const BUILD_FAIL_TEXT: Readonly<Record<number, string>> = {
  1: "Unknown piece", 2: "Tier not allowed", 3: "Too far away", 4: "Too high", 5: "Not your land", 6: "Area full", 7: "Bad ground",
  8: "Spot taken", 9: "Blocked", 10: "Needs a socket", 11: "Needs support", 12: "Not enough materials",
  21: "Corner: use a corner piece here", // Task 30: BuildFail.CornerSlot (was the generic fallback)
  22: "Locked: learn it in the skill tree", // ADR-221 BuildFail.SkillLocked
  24: "Ladder needs a height-step face",
  23: "Needs a paint brush in the hotbar", // Task 25 BuildFail.NoBrush
};
export const buildFailText = (reason: number | undefined): string => (reason && BUILD_FAIL_TEXT[reason]) || "Can't place here";
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const label = (k: string): string => k.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

const TOOL_HINT: Record<BuildDevice, { road: string; sign: string }> = { keyboardMouse: { road: "T", sign: "N" }, gamepad: { road: "LT+X", sign: "LT+Y" }, touch: { road: "", sign: "" } };
const SNAP_HINT: Record<BuildDevice, string> = { keyboardMouse: "G", gamepad: "R3", touch: "" };
/** Task 25: inline icon img for the build-HUD tool buttons (was 🛣 / 🪧 emoji in the template string). */
const bhIcon = (f: string): string => `<img src="${iconUrl(f)}" alt="" style="width:18px;height:18px;vertical-align:-4px;image-rendering:pixelated">`;

export function renderBuildHud(bm: BuildMode, device: BuildDevice): string {
  const s = bm.selection; if (!s) return "";
  const p = bm.preview; const ctx = bm.context;
  const chip = `<div class="bh-chip" role="status"><span data-role="bh-piece">${esc(label(p?.pieceKey ?? "piece"))}</span>`
    + `<span class="bh-dot ${p?.valid ? "ok" : "bad"}" data-role="bh-valid">${p?.valid ? "✓" : "✕"}</span>`
    + (p && !p.valid ? `<span class="bh-why" data-role="bh-why">${esc(buildFailText(p.reason))}</span>` : "")
    + `<span data-role="bh-level">Floor ${bm.level}</span>`
    + `<button data-bh="level-down" aria-label="Floor down">▼</button><button data-bh="level-up" aria-label="Floor up">▲</button>`
    + `<button data-bh="snap" data-snap="${bm.snap ? "on" : "off"}" aria-pressed="${bm.snap}" aria-label="Grid snap">${bm.snap ? "▦ Snap" : bm.freePlacing ? `▢ Free <span data-bh="angle">${bm.fineRot * 15}°</span>` : "▢ Free · grid piece"}${SNAP_HINT[device] ? ` <kbd>${SNAP_HINT[device]}</kbd>` : ""}</button></div>`;
  const strip = ctx ? `<div class="bh-ctx${ctx.actions.some((a) => a.armed) ? " warn" : ""}" role="menu" aria-label="${esc(ctx.title)}"><div class="bh-title">${esc(ctx.title)}</div>`
    + ctx.actions.map((a) => `<button role="menuitem" data-bh="${a.id}" class="${a.armed ? "armed" : ""}"${a.enabled ? "" : " disabled"}>${esc(a.label)}${a.hint ? ` <kbd>${esc(a.hint)}</kbd>` : ""}</button>`).join("")
    + `</div>` : "";
  // ADR-171: road + sign tools while building (touch / pad / mouse), with the device's shortcut
  const th = TOOL_HINT[device]; const tools = bm.hasTools ? `<div class="bh-tools" role="toolbar" aria-label="Road and sign tools">`
    + `<button data-bh="road" aria-label="Road tool">${bhIcon("ic_road.png")} Road${th.road ? ` <kbd>${th.road}</kbd>` : ""}</button><button data-bh="sign" aria-label="Place or edit a sign">${bhIcon("ic_sign.png")} Sign${th.sign ? ` <kbd>${th.sign}</kbd>` : ""}</button></div>` : "";
  const hint = device === "touch" && !bm.touchPoint ? `<div class="bh-hint">Tap to position · drag to adjust · ✓ to place</div>` : "";
  return chip + tools + strip + hint + (bm.toast ? `<div class="bh-toast" role="status">${esc(bm.toast)}</div>` : "");
}

export function mountBuildHud(root: HTMLElement, o: BuildHudOptions): { update(): void; destroy(): void; el: HTMLElement } {
  const el = document.createElement("div"); el.className = "build-hud"; el.hidden = true; root.append(el);
  const style = document.createElement("style");
  // ADR-142: on phones (≤640 px wide) the top centre is taken by the vitals panel + menu bar: drop the strip below them
  style.textContent = `.build-hud{position:absolute;left:50%;top:calc(8px + env(safe-area-inset-top));transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:6px;z-index:30;font:13px system-ui,sans-serif;color:#eee;pointer-events:none}
.build-hud .bh-chip,.build-hud .bh-ctx,.build-hud .bh-tools{display:flex;gap:6px;align-items:center;background:rgba(15,18,22,.82);border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:4px 8px;pointer-events:auto}
.build-hud button{min-width:36px;min-height:32px;border-radius:8px;border:1px solid rgba(255,255,255,.25);background:#2a3038;color:#eee;font:inherit;cursor:pointer}
.build-hud button:disabled{opacity:.45}.build-hud button[data-snap=on]{background:#2f5a3a}.build-hud button.armed{background:#8a2020}.build-hud kbd{font-size:11px;opacity:.75;margin-left:4px}
.build-hud .bh-title{opacity:1;font-weight:650;margin-right:6px;color:#fff}.build-hud .bh-ctx.warn{border-color:#e8c44a}.build-hud .bh-ctx.warn .bh-title{color:#ffe27a}.bh-dot.ok{color:#6d6}.bh-dot.bad{color:#e66}.bh-why{color:#f99;font-size:12px}.bh-hint,.bh-toast{background:rgba(15,18,22,.7);border-radius:8px;padding:2px 8px}
.build-hud .bh-tools{background:transparent;border:0;padding:0}.build-hud .bh-tools button{background:rgba(42,48,56,.9)}
.build-hud .bh-chip,.build-hud .bh-ctx{max-width:calc(100vw - 16px);flex-wrap:wrap;justify-content:center}
@media (max-width:640px){.build-hud{top:calc(${NARROW_TOP_PX}px + env(safe-area-inset-top))}}`;
  root.append(style);
  let last = "";
  el.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-bh]"); if (!b || b.disabled) return; e.stopPropagation();
    const id = b.dataset.bh!; const bm = o.buildMode;
    if (id === "road" || id === "sign") { bm.tool(id); update(); return; } if (id === "snap") bm.toggleSnap(); else if (id === "level-up") bm.setLevel(1); else if (id === "level-down") bm.setLevel(-1); else bm.act(id as "repair" | "upgrade" | "demolish");
    update();
  });
  let dragging: number | undefined;
  const at = (ev: PointerEvent): void => { const p = o.screenToWorld?.(ev.clientX, ev.clientY - TOUCH_LIFT_PX); if (p) o.buildMode.setTouchPoint(p); };
  const down = (ev: PointerEvent): void => { if (!o.buildMode.active || ev.pointerType !== "touch" || o.blocked?.(ev.clientX, ev.clientY)) return; dragging = ev.pointerId; at(ev); };
  const move = (ev: PointerEvent): void => { if (dragging === ev.pointerId) at(ev); };
  const up = (ev: PointerEvent): void => { if (dragging === ev.pointerId) dragging = undefined; };
  o.target?.addEventListener("pointerdown", down); o.target?.addEventListener("pointermove", move); addEventListener("pointerup", up); addEventListener("pointercancel", up);
  function update(): void {
    const bm = o.buildMode; el.hidden = !bm.active; if (!bm.active) { if (last) { el.innerHTML = ""; last = ""; } return; }
    const html = renderBuildHud(bm, o.device()); if (html !== last) { el.innerHTML = html; last = html; }
  }
  return { el, update, destroy: () => { o.target?.removeEventListener("pointerdown", down); o.target?.removeEventListener("pointermove", move); removeEventListener("pointerup", up); removeEventListener("pointercancel", up); el.remove(); style.remove(); } };
}
