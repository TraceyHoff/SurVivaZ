/**
 * ADR-179: on-screen hotbar — inventory slots 17..24 (the ones Hotbar1..8 / 1-8 keys / LB+D-pad
 * equip via EquipCmd) as a compact strip anchored bottom-centre inside the safe area. The hotbar is separate from the
 * pack: pack slots are 0..15, hotbar slots are HOTBAR_OFFSET..HOTBAR_OFFSET+7 (16..23). DOM hook: `#hotbar.hotbar [data-slot][data-icon][data-equipped]`.
 * Rebuilt only when the slot contents change (ADR-158 change-only updates); hidden while a menu / build mode / death
 * screen owns the screen. Slots are tappable/clickable (equip); the strip itself is click-through.
 */
import { mountUi } from "./ui-root.js";

export const HOTBAR_SLOTS = 8;
/** First hotbar slot in the player's Inventory array (pack = 0..15, hotbar = 16..23). Mirrors @engine/gameplay HOTBAR_OFFSET. */
export const HOTBAR_OFFSET = 16;
import { installSlotDrag } from "./slot-drag.js";
export interface HotbarSource { slot: number; item?: number; icon: string; name: string; count: number; equipped?: boolean }
export interface HotbarCell { selected?: boolean; slot: number; item: number; icon: string; name: string; count: number; equipped: boolean }
/** Pure model: one cell per hotbar slot (bar index 0..n-1 maps to inventory slot offset + index; empty cells have icon ""). */
export function hotbarCells(view: readonly HotbarSource[], n = HOTBAR_SLOTS, offset = HOTBAR_OFFSET): HotbarCell[] {
  return Array.from({ length: n }, (_, i) => { const slot = offset + i; const v = view.find((s) => s.slot === slot && s.count > 0);
    return v ? { slot, item: v.item ?? 0, icon: v.icon, name: v.name, count: v.count, equipped: !!v.equipped } : { slot, item: 0, icon: "", name: "", count: 0, equipped: false }; });
}
/** Next/previous filled hotbar slot from `cur` (-1 / none = start of the bar); -1 when the bar is empty. */
export function hotbarCycle(cells: readonly HotbarCell[], cur: number, dir: 1 | -1): number {
  const n = cells.length; if (!n) return -1; let i = cur >= 0 && cur < n ? cur : dir > 0 ? -1 : n;
  for (let k = 0; k < n; k++) { i = (i + dir + n) % n; if (cells[i]!.count > 0) return i; }
  return -1;
}
/** Slot (0-based) for the first Hotbar1..8 action pressed this update, else -1. */
export function pressedHotbarSlot(pressed: (action: string) => boolean, n = HOTBAR_SLOTS): number {
  for (let i = 0; i < n; i++) if (pressed(`Hotbar${i + 1}`)) return i;
  return -1;
}
export const hotbarKey = (cells: readonly HotbarCell[], device: string): string => device + "|" + cells.map((c) => `${c.icon}:${c.count}:${c.equipped ? 1 : 0}:${c.selected ? 1 : 0}`).join(",");

const CSS = `#hotbar{position:absolute;left:50%;bottom:calc(8px + var(--sab,0px));transform:translateX(-50%);z-index:5;display:flex;gap:4px;padding:4px;border-radius:10px;background:rgba(59,36,51,.55);pointer-events:none;font:700 10px/1 Fredoka,system-ui,sans-serif;color:#FFFAF0;max-width:calc(100vw - 16px - var(--sal,0px) - var(--sar,0px))}
#hotbar[hidden]{display:none}
#hotbar button{position:relative;flex:none;width:44px;height:44px;padding:0;margin:0;border:2px solid rgba(255,250,240,.35);border-radius:8px;background:rgba(20,16,12,.45);pointer-events:auto;cursor:pointer;color:inherit;font:inherit;touch-action:manipulation}
#hotbar button[data-drag]{touch-action:none;-webkit-touch-callout:none;user-select:none}#hotbar button[data-dragging]{opacity:.35}#hotbar button[data-drop-over]{border-color:#7FC4F0;box-shadow:0 0 0 3px rgba(46,123,184,.7)}#hotbar button[data-ghost]{opacity:.92;box-shadow:0 6px 14px rgba(0,0,0,.5)}
#hotbar button[data-equipped=true],#hotbar button[data-selected=true]{border-color:#FFDF00;box-shadow:inset 0 0 0 2px #FFDF00}
#hotbar button .ic{position:absolute;inset:5px;background:var(--cz-icon,none) var(--cz-ipos,center) / var(--cz-isize,contain) no-repeat;image-rendering:pixelated}
#hotbar button .n{position:absolute;left:3px;top:2px;opacity:.75}#hotbar button .c{position:absolute;right:3px;bottom:2px;text-shadow:0 1px 1px #000}
#hotbar[data-device=gamepad] button .n,#hotbar[data-device=touch] button .n{display:none}
@media (max-width:480px),(max-height:440px){#hotbar{gap:3px;padding:3px}#hotbar button{width:36px;height:36px}#hotbar button .ic{inset:4px}}`;

export const HOTBAR_DOUBLE_TAP_MS = 320;
export interface HotbarOptions { selectedSlot?: () => number | undefined; activate?: (slot: number) => void; now?: () => number; view: () => readonly HotbarSource[] | undefined; equip: (slot: number) => void; device: () => string; icon?: (icon: string, item: number) => string; /** ADR-231: drag one HUD slot onto another (mouse / touch) = move / swap / merge */ move?: (from: number, to: number) => void }
export function mountHotbar(o: HotbarOptions, doc: Document = document): { el: HTMLElement; update(visible: boolean): void; destroy(): void } {
  const style = doc.createElement("style"); style.textContent = CSS; doc.head.append(style);
  const el = mountUi(doc.createElement("div"), doc); el.id = "hotbar"; el.className = "hotbar"; el.setAttribute("role", "toolbar"); el.setAttribute("aria-label", "Hotbar"); el.hidden = true;
  let key = ""; let lastTap: { slot: number; at: number } | undefined;
  el.addEventListener("click", (e) => { const b = (e.target as HTMLElement).closest?.("button[data-slot]") as HTMLElement | null; if (b) {
    e.preventDefault(); e.stopPropagation(); const slot = Number(b.dataset["slot"]), at = (o.now ?? (() => performance.now()))();
    if (lastTap?.slot === slot && at - lastTap.at <= HOTBAR_DOUBLE_TAP_MS && o.activate) { lastTap = undefined; o.activate(slot); }
    else { lastTap = { slot, at }; o.equip(slot); }
  } });
  el.addEventListener("pointerdown", (e) => e.stopPropagation()); // taps on slots must not reach the canvas / touch controls
  const drag = o.move ? installSlotDrag(el, { onDrop: () => (from, to) => { if (from.kind === "h" && to.kind === "h") o.move?.(from.slot, to.slot); } }) : undefined;
  const update = (visible: boolean): void => {
    const v = visible ? o.view() : undefined; el.hidden = !v; if (!v) { lastTap = undefined; return; }
    const dev = o.device(); const cells = hotbarCells(v); const selected = o.selectedSlot?.(); for (const c of cells) c.selected = c.slot === selected; const k = hotbarKey(cells, dev); if (k === key) return; key = k;
    el.dataset["device"] = dev;
    el.replaceChildren(...cells.map((c, i) => { const b = doc.createElement("button"); b.type = "button"; b.tabIndex = -1; b.dataset["slot"] = String(c.slot); b.dataset["equipped"] = String(c.equipped); b.dataset["selected"] = String(!!c.selected); b.setAttribute("aria-pressed", String(c.equipped || !!c.selected));
      if (o.move) { b.dataset["drop"] = `h:${c.slot}`; if (c.count) b.dataset["drag"] = `h:${c.slot}`; }
      b.title = c.count ? `${c.name}${c.count > 1 ? ` ×${c.count}` : ""} (${i + 1})` : `Slot ${i + 1}`; b.setAttribute("aria-label", b.title);
      const n = doc.createElement("span"); n.className = "n"; n.textContent = String(i + 1); b.append(n);
      if (c.count) { const ic = doc.createElement("span"); ic.className = "ic"; ic.dataset["icon"] = o.icon ? o.icon(c.icon, c.item) : c.icon; b.append(ic);
        if (c.count > 1) { const ct = doc.createElement("span"); ct.className = "c"; ct.textContent = String(c.count); b.append(ct); } }
      return b; }));
  };
  return { el, update, destroy: () => { drag?.destroy(); el.remove(); style.remove(); } };
}
