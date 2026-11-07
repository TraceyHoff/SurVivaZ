/**
 * ADR-290: remaining-liquid bar drawn along the bottom of an item tile (HUD hotbar, inventory pack / hotbar row, open
 * container grid). One shared helper so every place a liquid container's icon is drawn reads the same way.
 * DOM hook: `.lfill[data-liquid][data-level=full|partial|low|empty][data-sips][data-max] > .lfill-v` (width = remaining %).
 */
export interface FillLike { sips: number; max: number; frac: number; liquid: string }
export type FillLevel = "full" | "partial" | "low" | "empty";
/** At or below this fraction (but above 0) the bar turns "low" (warning tint). 1 of 6 canteen sips, 1 of 4 flask sips, 1 of 3 waterskin sips... */
export const FILL_LOW_FRAC = 0.34;
export function fillLevel(f: FillLike): FillLevel {
  return f.sips <= 0 ? "empty" : f.sips >= f.max ? "full" : f.frac <= FILL_LOW_FRAC ? "low" : "partial";
}
/** Stable key fragment for change-only rebuilds (ADR-158). */
export const fillKey = (f: FillLike | undefined): string => (f ? `${f.liquid}${f.sips}/${f.max}` : "");
export const fillLabel = (f: FillLike): string => (f.sips <= 0 ? "empty" : `${f.sips}/${f.max} sips left`);
export function fillBar(doc: Document, f: FillLike): HTMLElement {
  if (!doc.getElementById("lfill-css")) { const st = doc.createElement("style"); st.id = "lfill-css"; st.textContent = FILL_CSS; doc.head.append(st); }
  const bar = doc.createElement("span"); bar.className = "lfill"; bar.setAttribute("aria-hidden", "true");
  bar.dataset["liquid"] = f.liquid; bar.dataset["level"] = fillLevel(f); bar.dataset["sips"] = String(f.sips); bar.dataset["max"] = String(f.max);
  const v = doc.createElement("span"); v.className = "lfill-v"; v.style.width = `${Math.round(Math.max(0, Math.min(1, f.frac)) * 100)}%`; bar.append(v);
  return bar;
}
/** Shared look (track + liquid colour + low / empty states); position is set per surface. */
export const FILL_CSS = `.lfill{position:absolute;z-index:1;display:block;box-sizing:border-box;height:5px;border-radius:3px;background:rgba(20,16,12,.78);box-shadow:0 0 0 1px #3B2433;overflow:hidden;pointer-events:none}
.lfill .lfill-v{display:block;height:100%;border-radius:2px;background:#3FA9F5}
.lfill[data-liquid=boiled_water] .lfill-v{background:#8FE3FF}
.lfill[data-level=low] .lfill-v{background:#F5A33F}
.lfill[data-level=empty]{box-shadow:0 0 0 1px #E8475F}`;
