/**
 * ADR-136 compact build HUD: one chip (piece · tier · floor, with ▲▼ floor buttons) and, only while a placed piece is
 * targeted, one labelled contextual strip (Repair / Upgrade → tier / Demolish, with the device's button hint).
 * Also wires touch placement: tap the world to position the ghost, drag to adjust (ghost lifted above the finger).
 * ADR-316 demolish mode: the chip reads "Demolish mode" (floor ▲▼, Exit); the strip shows the selected piece's name,
 * refund and why it can't be demolished / moved, at the same fixed top-centre spot; a touch tap selects the piece under
 * the finger (no lift), the strip's "Confirm demolish" demolishes it, "Deselect" clears it.
 */
import { demolishModeHint, type BuildDevice, type BuildMode } from "./build-mode.js";
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
interface LayoutEl { kind: string; anchor: { x: number; y: number; portrait?: { x: number; y: number } }; radius?: number; zone?: { x: number; y: number; w: number; h: number } }
/** Hit test against a touch layout (normalised anchors/zones; radii in reference px scaled to the viewport). */
/** Build strip top on narrow screens: below the vitals panel (≈98 px) and the menu bar. */
export const NARROW_TOP_PX = 106;
export function onTouchControl(layout: { reference?: { w: number; h: number }; elements: readonly LayoutEl[] }, x: number, y: number, w: number, h: number): boolean {
  const ref = layout.reference ?? { w: 844, h: 390 };
  // ADR-347: resolve the anchor and scale exactly like VirtualControls.place (packages/input/src/touch.ts) —
  // portrait screens use the portrait anchor, and the scale is clamped to [1, 1.15] like VirtualControls.scale.
  // The old code always used the landscape anchor with an unclamped scale, so in portrait a tap on ✓ / ✗ / ⟳
  // missed the test by ~90 px (and the radius shrank below the button's real hit radius) and fell through to
  // the canvas as a world tap: the ghost jumped to the world point under the button and the confirm placed it there.
  const portrait = w < h; const k = Math.max(1, Math.min(1.15, Math.min(w / ref.w, h / ref.h)));
  return layout.elements.some((e) => { const a = portrait ? e.anchor.portrait ?? e.anchor : e.anchor;
    return e.zone ? x >= e.zone.x * w && x <= (e.zone.x + e.zone.w) * w && y >= e.zone.y * h && y <= (e.zone.y + e.zone.h) * h
      : Math.hypot(x - a.x * w, y - a.y * h) <= ((e.radius ?? 24) + 8) * k; });
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
  25: "Needs a dug hole with level sides",
  26: "Place a Claim Flag first", // ADR-310 BuildFail.NeedClaim
  27: "Claim would overlap another claim", // ADR-315 BuildFail.ClaimOverlap
  28: "You don't have permission to demolish here", // ADR-317 BuildFail.NoDemolishPermission
  29: "Repair it first", 30: "Not yours", 31: "Can't move this", 32: "Something rests on it", 33: "No permission here", // ADR-318 move refusals
};
export const buildFailText = (reason: number | undefined): string => (reason && BUILD_FAIL_TEXT[reason]) || "Can't place here";
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const label = (k: string): string => k.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());

const TOOL_HINT: Record<BuildDevice, { road: string; sign: string }> = { keyboardMouse: { road: "T", sign: "N" }, gamepad: { road: "LT+X", sign: "LT+Y" }, touch: { road: "", sign: "" } };
const SNAP_HINT: Record<BuildDevice, string> = { keyboardMouse: "G", gamepad: "R3", touch: "" };
/** Task 25: inline icon img for the build-HUD tool buttons (was 🛣 / 🪧 emoji in the template string). */
const bhIcon = (f: string): string => `<img src="${iconUrl(f)}" alt="" style="width:18px;height:18px;vertical-align:-4px;image-rendering:pixelated">`;

function renderStrip(bm: BuildMode, device: BuildDevice): string {
  const ctx = bm.context; if (!ctx) return ""; const touchDemolish = device === "touch" && bm.demolishMode;
  const whys = [...new Set(ctx.actions.filter((a) => !a.enabled && a.why).map((a) => a.why!))];
  return `<div class="bh-ctx${ctx.actions.some((a) => a.armed) ? " warn" : ""}" role="menu" aria-label="${esc(ctx.title)}"><div class="bh-title">${esc(ctx.title)}</div>`
    + (ctx.refund ? `<span class="bh-refund" data-role="bh-refund">${esc(ctx.refund)}</span>` : "")
    + (whys.length ? `<span class="bh-why" data-role="bh-ctx-why">${esc(whys.join(" · "))}</span>` : "")
    + ctx.actions.map((a) => `<button role="menuitem" data-bh="${a.id}" class="${a.armed ? "armed" : ""}"${a.enabled ? "" : " disabled"}>${esc(touchDemolish && a.id === "demolish" ? (ctx.target.pickup ? "Confirm pick up" : "Confirm demolish") : a.label)}${a.hint ? ` <kbd>${esc(a.hint)}</kbd>` : ""}</button>`).join("")
    + (touchDemolish ? `<button role="menuitem" data-bh="deselect">Deselect</button>` : "")
    + `</div>`;
}
export function renderBuildHud(bm: BuildMode, device: BuildDevice): string {
  if (!bm.active) return "";
  const toast = bm.toast ? `<div class="bh-toast" role="status">${esc(bm.toast)}</div>` : "";
  if (bm.demolishMode) { // ADR-316: no ghost: mode chip + the selected piece's strip
    const chip = `<div class="bh-chip" role="status"><span data-role="bh-mode">Demolish mode</span><span data-role="bh-level">Floor ${bm.level}</span>`
      + `<button data-bh="level-down" aria-label="Floor down">▼</button><button data-bh="level-up" aria-label="Floor up">▲</button>`
      + `<button data-bh="exit" aria-label="Exit demolish mode">Exit${device === "touch" ? "" : ` <kbd>${device === "gamepad" ? "B" : "Esc"}</kbd>`}</button></div>`;
    const hint = device === "touch" && !bm.target ? `<div class="bh-hint">${esc(demolishModeHint("touch"))}</div>` : "";
    return chip + renderStrip(bm, device) + hint + toast;
  }
  const s = bm.selection; if (!s) return "";
  const p = bm.preview; const moving = bm.moving !== undefined;
  const chip = `<div class="bh-chip" role="status"><span data-role="bh-piece">${esc(label(p?.pieceKey ?? "piece"))}</span>`
    + `<span class="bh-dot ${p?.valid ? "ok" : "bad"}" data-role="bh-valid">${p?.valid ? "✓" : "✕"}</span>`
    + (p && !p.valid ? `<span class="bh-why" data-role="bh-why">${esc(buildFailText(p.reason))}</span>` : "")
    + `<span data-role="bh-level">Floor ${bm.level}</span>`
    + `<button data-bh="level-down" aria-label="Floor down">▼</button><button data-bh="level-up" aria-label="Floor up">▲</button>`
    + (moving ? `<button data-bh="cancel-move" aria-label="Cancel move">Cancel move</button>` : `<button data-bh="demolish-mode" aria-label="Demolish mode">Demolish${device === "keyboardMouse" ? " <kbd>Del</kbd>" : device === "gamepad" ? " <kbd>LB+B</kbd>" : ""}</button>`)
    + `<button data-bh="snap" data-snap="${bm.snap ? "on" : "off"}" aria-pressed="${bm.snap}" aria-label="Grid snap">${bm.snap ? "▦ Snap" : bm.freePlacing ? `▢ Free <span data-bh="angle">${bm.fineRot * 15}°</span>` : "▢ Free · grid piece"}${SNAP_HINT[device] ? ` <kbd>${SNAP_HINT[device]}</kbd>` : ""}</button></div>`;
  const strip = moving ? "" : renderStrip(bm, device);
  // ADR-171: road + sign tools while building (touch / pad / mouse), with the device's shortcut
  const th = TOOL_HINT[device]; const tools = bm.hasTools && !moving ? `<div class="bh-tools" role="toolbar" aria-label="Road and sign tools">`
    + `<button data-bh="road" aria-label="Road tool">${bhIcon("ic_road.png")} Road${th.road ? ` <kbd>${th.road}</kbd>` : ""}</button><button data-bh="sign" aria-label="Place or edit a sign">${bhIcon("ic_sign.png")} Sign${th.sign ? ` <kbd>${th.sign}</kbd>` : ""}</button></div>` : "";
  const hint = device === "touch" && !bm.touchPoint ? `<div class="bh-hint">Tap to position · drag to adjust · ✓ to place</div>` : "";
  return chip + tools + strip + hint + toast;
}

export function mountBuildHud(root: HTMLElement, o: BuildHudOptions): { update(): void; destroy(): void; el: HTMLElement } {
  const el = document.createElement("div"); el.className = "build-hud"; el.hidden = true; root.append(el);
  const style = document.createElement("style");
  // ADR-142: on phones (≤640 px wide) the top centre is taken by the vitals panel + menu bar: drop the strip below them
  style.textContent = `.build-hud{position:absolute;left:50%;top:calc(8px + env(safe-area-inset-top));transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:6px;z-index:30;font:13px system-ui,sans-serif;color:#eee;pointer-events:none}
.build-hud .bh-chip,.build-hud .bh-ctx,.build-hud .bh-tools{display:flex;gap:6px;align-items:center;background:rgba(15,18,22,.82);border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:4px 8px;pointer-events:auto}
.build-hud button{min-width:36px;min-height:32px;border-radius:8px;border:1px solid rgba(255,255,255,.25);background:#2a3038;color:#eee;font:inherit;cursor:pointer}
.build-hud button:disabled{opacity:.45}.build-hud button[data-snap=on]{background:#2f5a3a}.build-hud button.armed{background:#8a2020}.build-hud kbd{font-size:11px;opacity:.75;margin-left:4px}
.build-hud .bh-title{opacity:1;font-weight:650;margin-right:6px;color:#fff}.build-hud .bh-ctx.warn{border-color:#e8c44a}.build-hud .bh-ctx.warn .bh-title{color:#ffe27a}.bh-dot.ok{color:#6d6}.bh-dot.bad{color:#e66}.bh-why{color:#f99;font-size:12px}.bh-refund{color:#cfe8b0;font-size:12px}.bh-hint,.bh-toast{background:rgba(15,18,22,.7);border-radius:8px;padding:2px 8px}
.build-hud .bh-tools{background:transparent;border:0;padding:0}.build-hud .bh-tools button{background:rgba(42,48,56,.9)}
.build-hud .bh-chip,.build-hud .bh-ctx{max-width:calc(100vw - 16px);flex-wrap:wrap;justify-content:center}
@media (max-width:640px){.build-hud{top:calc(${NARROW_TOP_PX}px + env(safe-area-inset-top))}}`;
  root.append(style);
  let last = "";
  el.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-bh]"); if (!b || b.disabled) return; e.stopPropagation();
    const id = b.dataset.bh!; const bm = o.buildMode;
    if (id === "road" || id === "sign") { bm.tool(id); update(); return; } if (id === "snap") bm.toggleSnap(); else if (id === "level-up") bm.setLevel(1); else if (id === "level-down") bm.setLevel(-1);
    else if (id === "exit") bm.stop(); else if (id === "demolish-mode") bm.startDemolish(); else if (id === "cancel-move") bm.cancelMove(); else if (id === "deselect") bm.selectAt(undefined); else if (id === "move") bm.startMove();
    else bm.act(id as "repair" | "upgrade" | "demolish" | "reclaim", id === "demolish" && o.device() === "touch" && bm.demolishMode); // ADR-316: the touch strip button is the confirmation
    update();
  });
  let dragging: number | undefined;
  const at = (ev: PointerEvent): void => { const p = o.screenToWorld?.(ev.clientX, ev.clientY - TOUCH_LIFT_PX); if (p) o.buildMode.setTouchPoint(p); };
  const down = (ev: PointerEvent): void => { if (!o.buildMode.active || ev.pointerType !== "touch" || o.blocked?.(ev.clientX, ev.clientY)) return;
    if (o.buildMode.demolishMode) { o.buildMode.selectAt(o.screenToWorld?.(ev.clientX, ev.clientY)); update(); return; } // ADR-316: tap selects (no lift, no drag)
    dragging = ev.pointerId; at(ev); };
  const move = (ev: PointerEvent): void => { if (dragging === ev.pointerId) at(ev); };
  const up = (ev: PointerEvent): void => { if (dragging === ev.pointerId) dragging = undefined; };
  o.target?.addEventListener("pointerdown", down); o.target?.addEventListener("pointermove", move); addEventListener("pointerup", up); addEventListener("pointercancel", up);
  function update(): void {
    const bm = o.buildMode; el.hidden = !bm.active; if (!bm.active) { if (last) { el.innerHTML = ""; last = ""; } return; }
    const html = renderBuildHud(bm, o.device()); if (html !== last) { el.innerHTML = html; last = html; }
  }
  return { el, update, destroy: () => { o.target?.removeEventListener("pointerdown", down); o.target?.removeEventListener("pointermove", move); removeEventListener("pointerup", up); removeEventListener("pointercancel", up); el.remove(); style.remove(); } };
}
