/**
 * Visible touch controls: draws @engine/input VirtualControls geometry (joystick ring + knob, action buttons) as
 * click-through DOM inside the UI root, so the player can see where to press, in and out of fullscreen.
 * Hooks: `#touch-overlay`, `[data-touch=<element id>]` with `data-pressed`. Hidden while a modal is open.
 */
import type { ElementGeometry } from "@engine/input";
import { iconImg, iconUrl, isIconFile } from "./game-icons.js";

/** Icon + short caption per control (ADR-133): every visible control says what it does. */
export const TOUCH_LABELS: Record<string, { icon: string; text: string }> = {
  attack: { icon: "ic_sword.png", text: "Hit" }, context: { icon: "ic_hand.png", text: "Use" }, boost: { icon: "»", text: "Boost" }, reload: { icon: "↻", text: "Reload" },
  confirm: { icon: "✓", text: "Place" }, cancel: { icon: "✕", text: "Cancel" }, rotate: { icon: "⟳", text: "Rotate" },
  engine: { icon: "ic_key.png", text: "Engine" }, lights: { icon: "ic_bulb.png", text: "Lights" }, // ADR-170: only in the driving layout
  secondary: { icon: "ic_shield.png", text: "Block" }, crouch: { icon: "⤓", text: "Crouch" }, carry: { icon: "⇪", text: "Carry" }, sleep: { icon: "☾", text: "Sleep" }, // ADR-244
};
/** The icon node for a control: a custom icon <img> for icon files, a text span for typographic glyphs. */
const iconNode = (icon: string): HTMLElement => { if (isIconFile(icon)) return iconImg(icon, 22); const s = document.createElement("span"); s.textContent = icon; return s; };
/** Swap a control's icon in place (the live caption path); replaces the node when the kind changes (text glyph ↔ icon file). */
const setIcon = (node: ChildNode, icon: string): void => {
  const wantImg = isIconFile(icon);
  if (wantImg && !(node instanceof HTMLImageElement)) { node.replaceWith(iconNode(icon)); return; }
  if (!wantImg && node instanceof HTMLImageElement) { node.replaceWith(iconNode(icon)); return; }
  if (node instanceof HTMLImageElement) { const u = iconUrl(icon); if (node.src !== u) node.src = u; }
  else node.textContent = icon;
};
/** ADR-244 touch context: which contextual stance buttons apply now and their live captions. */
export interface TouchCtx { reload: boolean; carry?: boolean; carrying?: boolean; sleep?: boolean; sleeping?: boolean; aim?: boolean }
/** Live caption for a control (Carry↔Drop, Sleep↔Wake, Block↔Aim); falls back to TOUCH_LABELS. */
export function touchLabel(id: string, ctx: TouchCtx): { icon: string; text: string } | undefined {
  if (id === "carry" && ctx.carrying) return { icon: "⇩", text: "Drop" };
  if (id === "sleep" && ctx.sleeping) return { icon: "ic_sun.png", text: "Wake" };
  if (id === "secondary" && ctx.aim) return { icon: "◎", text: "Aim" };
  return TOUCH_LABELS[id];
}
const BG = (g: ElementGeometry): string => g.pressed ? "rgba(255,212,90,.45)" : `rgba(20,16,12,${g.kind === "joystick" ? ".12" : ".28"})`;
export function mountTouchOverlay(root: HTMLElement, geometry: () => ElementGeometry[], hidden: () => boolean = () => false, label: (id: string) => { icon: string; text: string } | undefined = (id) => TOUCH_LABELS[id]): { destroy(): void; draw(): void } {
  const layer = document.createElement("div"); layer.id = "touch-overlay";
  layer.style.cssText = "position:absolute;inset:0;z-index:4;pointer-events:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none";
  const els = new Map<string, HTMLDivElement>(); const knobs = new Map<string, HTMLDivElement>();
  root.append(layer);
  const draw = (): void => {
    layer.style.display = hidden() ? "none" : "";
    const geo = geometry(); const live = new Set(geo.map((g) => g.id));
    for (const [id, d] of els) if (!live.has(id)) { d.style.display = "none"; const k = knobs.get(id); if (k) k.style.display = "none"; }
    for (const g of geo) {
      let d = els.get(g.id);
      if (!d) {
        d = document.createElement("div"); d.dataset["touch"] = g.id;
        d.style.cssText = "position:absolute;border-radius:50%;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1;color:#FFFAF0;font:700 17px system-ui,sans-serif;text-shadow:0 1px 2px #000;border:2px solid rgba(255,250,240,.45);opacity:.85";
        const lab = label(g.id); if (lab) { const i = iconNode(lab.icon); const t = document.createElement("span"); t.textContent = lab.text; t.style.cssText = "font:600 9px system-ui,sans-serif;margin-top:1px"; d.append(i, t); d.setAttribute("aria-label", lab.text); } layer.append(d); els.set(g.id, d);
        if (g.kind === "joystick") { const k = document.createElement("div"); k.style.cssText = "position:absolute;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;background:rgba(255,250,240,.6)"; layer.append(k); knobs.set(g.id, k); }
      }
      d.style.display = g.visible ? "flex" : "none";
      const cur = label(g.id); if (cur && d.childNodes.length >= 2 && d.lastChild!.textContent !== cur.text) { setIcon(d.firstChild!, cur.icon); d.lastChild!.textContent = cur.text; d.setAttribute("aria-label", cur.text); }
      d.style.left = `${g.x - g.r}px`; d.style.top = `${g.y - g.r}px`; d.style.width = d.style.height = `${g.r * 2}px`;
      d.dataset["pressed"] = String(g.pressed); d.style.background = BG(g);
      const k = knobs.get(g.id); if (k) { k.style.display = g.knob ? "" : "none"; if (g.knob) { k.style.left = `${g.knob.x}px`; k.style.top = `${g.knob.y}px`; } }
    }
  };
  let raf = 0; const loop = (): void => { draw(); raf = requestAnimationFrame(loop); }; raf = requestAnimationFrame(loop);
  return { draw, destroy: () => { cancelAnimationFrame(raf); layer.remove(); } };
}

/** Context-gated control ids (ADR-133): shown only while their context holds. */
export function syncTouchHidden(hidden: Set<string>, ctx: TouchCtx): void {
  const show = (id: string, on: boolean): void => { if (on) hidden.delete(id); else hidden.add(id); };
  show("reload", ctx.reload);
  show("carry", !!(ctx.carry || ctx.carrying)); show("sleep", !!(ctx.sleep || ctx.sleeping)); // ADR-244: contextual, minimal
}
