/**
 * ADR-363: the in-game guide window — section list + detail view over the ADR-362 content model.
 *
 * One builder serves both openings: the in-game modal (./game-menus.ts, gm-modal shell) and the main-menu
 * screen (./menu.ts, boot panel). The body is the same DOM in both; only the shell differs, so the guide
 * looks and behaves like the rest of the UI in each place. Guide text comes from the ADR-362 data, never
 * hardcoded here. No search box: the 15 sections are a button grid (the quick-jump), and gamepad LB/RB
 * cycles them through the existing `[data-tabs=tab]` tab pattern — adding a text search would invent a new
 * modal pattern for a list short enough to scan.
 *
 * Section icons render through the menus' own `[data-icon]` mechanism (./gameplay-panels.css): a section
 * shows its icon only when the stylesheet has art for the resolved key, otherwise the title renders
 * text-only — never a broken image. `mount:` / `pet:` resolve through the ADR-364 rules in
 * gameplay-panels.css (the SW idle frame cropped out of the shipped pet/mount atlases).
 *
 * Action images (`{ image, caption }` items, ADR-364) render as a figure: a row of `[data-icon]` tiles
 * composed by ./task364-art.ts (GUIDE_ACTION_IMAGES) plus the caption. Tiles are spans, never `<img>` —
 * the same rule as the section icons — and every tile key is pinned to real pixels by the ADR-364 tests.
 */
import { defaultDefs, getGuideSections, iconForItem, resolvedGuideSection, type GuideIconRef, type ResolvedGuideSection } from "@engine/gameplay";
import { buildIconKey, iconKeysFromCss } from "./gameplay-panels.js";
import { guideActionImage } from "./task364-art.js";

const CSS = `.guide{display:flex;flex-direction:column;gap:10px}
.guide-sections{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px}
.guide-sections button{font:700 15px Fredoka,system-ui,sans-serif;min-height:44px;min-width:44px;border-radius:10px;padding:6px 10px;cursor:pointer;box-sizing:border-box}
.guide-sections button:focus-visible{outline:3px solid #FFD45A;outline-offset:2px}
.guide-detail{display:flex;flex-direction:column;gap:8px}
.guide-detail h3{margin:0;font-size:19px;color:#74432C;display:flex;align-items:center;gap:8px}
.guide-detail p{margin:0;font-size:14px;line-height:1.4}
.guide-icon{display:inline-block;flex:none;width:28px;height:28px;background:var(--cz-icon,none) var(--cz-ipos,center)/var(--cz-isize,contain) no-repeat}
.guide-fact{display:flex;justify-content:space-between;align-items:baseline;gap:12px;font-size:14px}
.guide-fact b{white-space:nowrap;text-align:right}
.guide-keys{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:14px}
.guide-keys kbd{font:700 13px Fredoka,system-ui,sans-serif;background:#FFFAF0;border:2px solid #4A2F3D;border-radius:6px;padding:2px 7px;box-sizing:border-box}
.guide-image{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:4px 0}
.guide-img-tile{display:inline-block;flex:none;width:44px;height:44px;background:var(--cz-icon,none) var(--cz-ipos,center)/var(--cz-isize,contain) no-repeat}
.guide-img-join{font:700 18px Fredoka,system-ui,sans-serif;color:#74432C}
.guide-image figcaption{font-size:14px;line-height:1.4}`;

/** Inject the guide stylesheet once (same pattern as GameMenus' `#gm-style`). */
export function installGuideCss(doc: Document = document): void {
  if (doc.getElementById("guide-style")) return;
  const st = doc.createElement("style"); st.id = "guide-style"; st.textContent = CSS; doc.head.append(st);
}

/** The `[data-icon]` keys the shipped stylesheet has art for (same scan as gameplay-panels' hasIcon). */
export function guideIconKeysFromDom(doc: Document = document): Set<string> {
  const texts: string[] = [];
  try { for (const sh of Array.from(doc.styleSheets)) { try { for (const r of Array.from(sh.cssRules)) texts.push(r.cssText); } catch { /* cross-origin sheet */ } } } catch { /* no DOM */ }
  return iconKeysFromCss(texts);
}

/**
 * `has` for the icon resolver: true when the stylesheet carries the key — or when no stylesheet info is
 * available at all (tests / headless), where keys are kept as-is, like gameplay-panels' hasIcon.
 */
export function hasGuideIcon(key: string, known: Set<string> = guideIconKeysFromDom()): boolean {
  return known.size === 0 || known.has(key);
}

/**
 * Resolve a guide icon ref to a `[data-icon]` key the shipped stylesheet has art for, or undefined when
 * no art exists yet (the section renders text-only; ADR-364). `item:` uses the item's own sprite key via
 * the same `iconForItem` fallback the panels use; `piece:` uses the build-menu icon (`build_<key>`,
 * tiered candidates first); `vehicle:` uses the runtime-painted kit icon key from ADR-361; `pet:` /
 * `mount:` use the ADR-364 atlas-crop rules (`pet_<key>` / `mount_<key>`, the SW idle frame).
 */
export function guideIconKey(icon: GuideIconRef, has: (k: string) => boolean): string | undefined {
  const [kind, key] = icon.split(":", 2);
  if (!kind || !key) return undefined;
  switch (kind) {
    case "item": {
      try {
        const defs = defaultDefs();
        const it = defs.items.get(defs.itemId(key));
        if (!it) return undefined;
        const k = iconForItem(it, has);
        return has(k) ? k : undefined;
      } catch { return undefined; }
    }
    case "piece": return buildIconKey(key, 1, true, has);
    case "vehicle": { const k = `item_vehicle_kit_${key}`; return has(k) ? k : undefined; }
    case "pet": { const k = `pet_${key}`; return has(k) ? k : undefined; }
    case "mount": { const k = `mount_${key}`; return has(k) ? k : undefined; }
    default: return undefined;
  }
}

function renderGuideSection(s: ResolvedGuideSection, has: (k: string) => boolean): Node[] {
  const out: Node[] = [];
  const h = document.createElement("h3"); h.dataset["role"] = "guide-title";
  const icon = guideIconKey(s.icon, has);
  if (icon) {
    const ic = document.createElement("span"); ic.className = "guide-icon"; ic.dataset["role"] = "ic"; ic.dataset["icon"] = icon;
    ic.setAttribute("aria-hidden", "true"); h.append(ic);
  }
  h.append(s.title);
  const intro = document.createElement("p"); intro.className = "guide-intro"; intro.dataset["role"] = "guide-intro"; intro.textContent = s.intro;
  out.push(h, intro);
  for (const item of s.items) {
    if (item.kind === "text") {
      const p = document.createElement("p"); p.dataset["role"] = "guide-text"; p.textContent = item.text; out.push(p);
    } else if (item.kind === "fact") {
      const row = document.createElement("div"); row.className = "guide-fact"; row.dataset["role"] = "guide-fact";
      const l = document.createElement("span"); l.textContent = item.label;
      const v = document.createElement("b"); v.textContent = item.value;
      row.append(l, v); out.push(row);
    } else if (item.kind === "image") {
      // An action image: a row of [data-icon] tiles from the ADR-364 registry plus its caption. Tiles
      // are spans (never <img>); a tile with no art yet shows as an empty box, never a broken image.
      const img = guideActionImage(item.image);
      const fig = document.createElement("figure"); fig.className = "guide-image"; fig.dataset["role"] = "guide-image"; fig.dataset["image"] = item.image;
      if (img) {
        img.tiles.forEach((key, i) => {
          if (i > 0) {
            const join = document.createElement("span"); join.className = "guide-img-join"; join.setAttribute("aria-hidden", "true");
            join.textContent = img.join; fig.append(join);
          }
          const tile = document.createElement("span"); tile.className = "guide-img-tile"; tile.dataset["role"] = "guide-img-tile";
          tile.dataset["icon"] = key; tile.setAttribute("aria-hidden", "true"); fig.append(tile);
        });
      }
      const cap = document.createElement("figcaption"); cap.textContent = item.caption; fig.append(cap);
      out.push(fig);
    } else {
      const row = document.createElement("div"); row.className = "guide-keys"; row.dataset["role"] = "guide-keys";
      for (const k of item.keys) { const chip = document.createElement("kbd"); chip.textContent = k; row.append(chip); }
      const l = document.createElement("span"); l.textContent = item.label; row.append(l); out.push(row);
    }
  }
  return out;
}

/**
 * Build the guide body: the section list (quick-jump; `[data-tabs=tab]` so gamepad LB/RB cycles it like
 * other tabbed panels) above the selected section's detail. Works inside a gm-modal and inside a boot
 * panel; the caller owns the shell, the close button and the pause flow.
 */
export function buildGuidePanel(initialId?: string): HTMLElement {
  installGuideCss();
  const sections = getGuideSections();
  const known = guideIconKeysFromDom();
  const has = (k: string): boolean => hasGuideIcon(k, known);
  const el = document.createElement("div"); el.className = "guide"; el.dataset["role"] = "guide";
  const list = document.createElement("div"); list.className = "guide-sections"; list.dataset["tabs"] = "tab";
  list.setAttribute("aria-label", "Guide sections");
  const detail = document.createElement("div"); detail.className = "guide-detail"; detail.dataset["role"] = "guide-detail";
  let selectedId = sections.find((s) => s.id === initialId)?.id ?? sections[0]!.id;
  const render = (id: string): void => {
    const s = resolvedGuideSection(id);
    if (!s) return;
    selectedId = id;
    for (const b of Array.from(list.querySelectorAll<HTMLButtonElement>("button"))) {
      const on = b.dataset["guideSection"] === id;
      // Same tab convention as the chat channels: selected is the plain (green) button, the rest are "alt" —
      // cycleTabs (gamepad LB/RB) reads the current tab from aria-pressed / the missing "alt" class.
      b.className = on ? "" : "alt"; b.setAttribute("aria-pressed", String(on));
    }
    detail.replaceChildren(...renderGuideSection(s, has));
  };
  for (const s of sections) {
    const b = document.createElement("button"); b.type = "button";
    b.dataset["guideSection"] = s.id; b.dataset["key"] = `guide-${s.id}`;
    b.textContent = s.title; b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => render(s.id));
    list.append(b);
  }
  el.append(list, detail);
  render(selectedId);
  return el;
}
