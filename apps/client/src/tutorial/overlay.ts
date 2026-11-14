/**
 * ADR-144 tutorial overlay: one compact card + a spotlight ring and arrow on the element being explained.
 * The card picks the free spot with the least overlap (target first, then HUD / menu bar / touch controls / panels),
 * so it never covers the control it points at. Updates at 4 Hz; the card DOM only rebuilds when the step or device
 * changes (no per-frame layout). Hooks: `#tutorial[data-step][data-device]`, `#tutorial-spot`, `#tutorial-arrow`.
 */
import { actionCombos, combosText, menuHotkeyCombos, type BindingSource, type Combo, type TutDevice } from "./labels.js";
import glyphAtlas from "../../../../assets/ui/input/atlas/input_glyphs.json";
import { iconUrl, isIconFile } from "../game-icons.js";
import { GAME_MENUS, PRIMARY_BAR_MENUS } from "../game-menus.js";
import type { Probe, StepText, TutorialProgress } from "./steps.js";

export interface Rect { x: number; y: number; w: number; h: number }
const overlap = (a: Rect, b: Rect): number => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
/** Where the card goes: the candidate with the least overlap (target ×100, other UI ×1); ties keep candidate order. */
/** ADR-150: screen area around the camera-centred player (the world action happens there): weighted like a control. */
export function playerZone(view: { w: number; h: number }): Rect { const w = Math.min(220, view.w * 0.3), h = Math.min(240, view.h * 0.36); return { x: view.w / 2 - w / 2, y: view.h / 2 - h * 0.7, w, h }; }
export function placeCard(view: { w: number; h: number }, card: { w: number; h: number }, target: Rect | undefined, avoid: readonly Rect[], m = 8): { x: number; y: number } {
  const pz = playerZone(view);
  const cx = Math.max(m, (view.w - card.w) / 2); const maxY = Math.max(m, view.h - card.h - m);
  const cands: { x: number; y: number }[] = [];
  if (target) { // next to the target first, so the arrow is short
    cands.push({ x: clamp(target.x + target.w / 2 - card.w / 2, m, view.w - card.w - m), y: target.y + target.h + 14 });
    cands.push({ x: clamp(target.x + target.w / 2 - card.w / 2, m, view.w - card.w - m), y: target.y - card.h - 14 });
    const ty = clamp(target.y + target.h / 2 - card.h / 2, m, maxY); cands.push({ x: target.x - card.w - 14, y: ty }, { x: target.x + target.w + 14, y: ty });
  }
  cands.push({ x: cx, y: view.h * 0.16 }, { x: cx, y: maxY - view.h * 0.2 }, { x: m, y: view.h * 0.3 }, { x: view.w - card.w - m, y: view.h * 0.3 }, { x: cx, y: pz.y - card.h - m }, { x: cx, y: pz.y + pz.h + m }, { x: m, y: m }, { x: view.w - card.w - m, y: m }, { x: m, y: maxY }, { x: view.w - card.w - m, y: maxY }, { x: cx, y: m }, { x: cx, y: maxY }, { x: cx, y: (view.h - card.h) / 2 });
  for (let i = 1; i < 8; i++) { const x = m + ((view.w - card.w - 2 * m) * i) / 8; cands.push({ x, y: m }, { x, y: maxY }); } // ADR-150: row scan for tight landscape phones
  if (view.h > view.w) {
    // Portrait has a free upper-right lane beside the health cluster. Scan obstacle edges, not the player.
    for (const a of avoid) for (const x of [m, view.w - card.w - m]) cands.push({ x, y: a.y + a.h + m });
    cands.push({ x: view.w - card.w - m, y: 70 });
  }
  const tg = target && { x: target.x - 10, y: target.y - 10, w: target.w + 20, h: target.h + 20 }; // the spotlight (4px pad + border) is drawn outside the target
  let best = cands[0]!; let bestScore = Infinity, bestPlayerOverlap = Infinity;
  for (const c0 of cands) {
    const c = { x: clamp(c0.x, m, Math.max(m, view.w - card.w - m)), y: clamp(c0.y, m, maxY) }; const r = { ...c, w: card.w, h: card.h };
    const playerOverlap = view.h > view.w ? overlap(r, pz) : 0;
    const s = (tg ? overlap(r, tg) * 1000 : 0) + avoid.reduce((a, b) => a + overlap(r, b) * 20, 0) + overlap(r, pz);
    if (playerOverlap < bestPlayerOverlap || (playerOverlap === bestPlayerOverlap && s < bestScore - 1e-6)) { best = c; bestScore = s; bestPlayerOverlap = playerOverlap; }
  }
  return best;
}
const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export function stepText(t: StepText, d: TutDevice): string { return typeof t === "string" ? t : t[d] ?? t.all ?? ""; }
const glyphFrames = new Map(Object.values(glyphAtlas.frames).map((f) => [f.meta.id, f.frame]));
// ADR-393: the shipped art/ui copy (a Vite import bundled a second copy into assets/)
const glyphAtlasUrl = `${import.meta.env.BASE_URL}art/ui/input/atlas/input_glyphs.png`;
/** The art atlas is shared by every input device; keep the text alongside it for rebinding and accessibility. */
function chipIcon(glyph: string, icon?: string): string {
  if (icon && isIconFile(icon)) return `<img src="${esc(iconUrl(icon))}" alt="" width="18" height="18">`;
  const f = glyphFrames.get(glyph);
  if (f) return `<span class="tut-glyph" aria-hidden="true" style="display:inline-block;width:${f.w / 2}px;height:${f.h / 2}px;background:url('${esc(glyphAtlasUrl)}') -${f.x / 2}px -${f.y / 2}px / ${glyphAtlas.meta.size.w / 2}px ${glyphAtlas.meta.size.h / 2}px"></span>`;
  return icon ? `<i>${esc(icon)}</i>` : "";
}
const chipsHtml = (cs: readonly Combo[]): string => cs.slice(0, 2).map((c) => `${c.how === "hold" || c.how === "longPress" ? "hold " : ""}${c.chips.map((x) => `<kbd class="tut-key" data-glyph="${esc(x.glyph)}">${chipIcon(x.glyph, x.icon)}${esc(x.text)}</kbd>`).join(c.sep === " " ? "" : "+")}`).join(" or ");
/** How to open a menu on this device: its binding, else the desktop hotkey, else Menu → item. */
export function menuCombos(src: BindingSource, d: TutDevice, id: string): { html: string; text: string } {
  const m = GAME_MENUS.find((x) => x.id === id); const name = m ? m.title : id;
  const bound: Record<string, string> = { inventory: "ToggleInventory", crafting: "ToggleCrafting", chat: "OpenChat", social: "OpenSocial", build: "ToggleBuild", character: "ToggleCharacter" };
  if (d === "touch") {
    const bar = id === "character" ? "the health stats (top left)" : m?.bar ? (PRIMARY_BAR_MENUS.has(id) ? `the ${name} button` : `the ${name} button (under ⋯ More)`) : `☰ Menu, then ${name}`;
    return { html: `${m && isIconFile(m.icon) ? `<img class="tut-icon" src="${esc(iconUrl(m.icon))}" alt="" width="18" height="18"> ` : ""}${esc(bar)}`, text: bar };
  }
  const b = bound[id]; const cs = b ? actionCombos(src, d, b) : [];
  if (cs.length) return { html: chipsHtml(cs), text: combosText(cs) };
  if (d === "keyboardMouse") { const h = menuHotkeyCombos(id); if (h.length) return { html: chipsHtml(h), text: combosText(h) }; }
  const pause = actionCombos(src, d, "Cancel").filter((c) => c.how !== "longPress");
  return { html: `${chipsHtml(pause)} then ${esc(name)}`, text: `${combosText(pause)} then ${name}` };
}
/** Resolve {A:..}/{M:..} tokens to binding chips (HTML) or plain text. */
export function renderTokens(text: string, src: BindingSource, d: TutDevice, html = true): string {
  const parts = text.split(/(\{[AM]:[^}]+\})/g);
  return parts.map((p) => {
    const t = /^\{([AM]):([^}@]+)(?:@([^}]+))?\}$/.exec(p);
    if (!t) return html ? esc(p) : p;
    if (t[1] === "M") { const r = menuCombos(src, d, t[2]!); return html ? r.html : r.text; }
    const cs = actionCombos(src, d, t[2]!, t[3] ?? "Gameplay");
    if (!cs.length) return html ? "<kbd class=\"tut-key\">?</kbd>" : "?";
    return html ? chipsHtml(cs) : combosText(cs);
  }).join("");
}

const CSS = `#tutorial{position:absolute;z-index:45;width:min(330px,calc(100vw - 16px));box-sizing:border-box;background:rgba(246,234,210,.97);color:#3B2433;border:3px solid #74432C;border-radius:12px;box-shadow:0 3px 0 #432C24;padding:8px 10px;font:600 14px/1.35 Fredoka,system-ui,sans-serif;pointer-events:none;transition:left .18s,top .18s;contain:layout paint}
#tutorial[hidden],#tutorial-spot[hidden],#tutorial-arrow[hidden]{display:none}
#tutorial .tut-head{display:flex;align-items:center;gap:6px;font-size:11px;color:#61402E}#tutorial .tut-head span{flex:1}
#tutorial .tut-bar{height:4px;background:#E6C47E;border-radius:3px;overflow:hidden;margin:4px 0 6px}#tutorial .tut-bar i{display:block;height:100%;background:#5A9A4A}
#tutorial h3{margin:0 0 2px;font-size:16px;color:#74432C}#tutorial p{margin:0}
#tutorial .tut-key{display:inline-flex;align-items:center;gap:2px;font:700 12px Fredoka,system-ui,sans-serif;background:#3B2433;color:#FFFAF0;border-radius:6px;padding:1px 6px;margin:0 1px;border-bottom:2px solid #1d1119;white-space:nowrap}
#tutorial .tut-key i{font-style:normal}#tutorial img{vertical-align:middle;image-rendering:pixelated;flex:none}
#tutorial .tut-btns{display:flex;gap:6px;justify-content:flex-end;margin-top:8px;flex-wrap:wrap}
#tutorial button{pointer-events:auto;font:700 13px Fredoka,system-ui,sans-serif;min-height:34px;min-width:44px;border-radius:9px;border:2px solid #3B2433;background:#5A9A4A;color:#FFFAF0;padding:2px 10px;cursor:pointer}
#tutorial button.alt{background:#C98A4B}#tutorial button.x{background:transparent;color:#61402E;border:none;min-width:34px;padding:0}
#tutorial button:focus-visible{outline:3px solid #FFD45A;outline-offset:2px}
#tutorial[data-device=touch] button{min-height:44px}#tutorial .tut-head button.hb{display:none}#tutorial .tut-hint{font-size:11px;color:#61402E;margin-top:4px}
#tutorial .tut-wait{font-size:12px;color:#2D5A2E}
#tutorial-spot{position:absolute;z-index:44;pointer-events:none;border:3px solid #FFD45A;border-radius:12px;box-shadow:0 0 0 3px rgba(59,36,51,.55),0 0 14px #FFD45A;animation:tutpulse 1.2s ease-in-out infinite;transition:left .15s,top .15s,width .15s,height .15s}
#tutorial-arrow{position:absolute;z-index:44;pointer-events:none;font:24px system-ui;color:#FFD45A;text-shadow:0 0 3px #3B2433,0 0 3px #3B2433;transform:translate(-50%,-50%)}
#tutorial .tut-hold{display:inline-block;vertical-align:middle;width:46px;height:6px;border-radius:3px;background:#E6C47E;overflow:hidden}#tutorial .tut-hold i{display:block;height:100%;width:0;background:#5A9A4A}
#tutorial-ghost{position:absolute;z-index:43;left:max(22px,8vw);bottom:max(110px,16vh);width:116px;height:116px;border-radius:50%;border:3px dashed rgba(255,250,240,.85);background:rgba(20,16,12,.18);pointer-events:none;display:flex;align-items:center;justify-content:center;flex-direction:column;font:700 12px Fredoka,system-ui,sans-serif;color:#FFFAF0;text-shadow:0 1px 2px #3B2433}
#tutorial-ghost i{width:44px;height:44px;border-radius:50%;background:rgba(255,250,240,.55);animation:tutdrag 1.6s ease-in-out infinite}
@keyframes tutdrag{0%,100%{transform:translate(0,0)}25%{transform:translate(22px,-10px)}50%{transform:translate(0,-22px)}75%{transform:translate(-22px,0)}}
#tutorial-ghost[hidden]{display:none}
@keyframes tutpulse{50%{opacity:.55}}
@media (prefers-reduced-motion:reduce){#tutorial-spot{animation:none}#tutorial{transition:none}}
@media (min-width:1600px) and (min-height:900px){#tutorial{width:430px;font-size:18px;padding:12px 14px}#tutorial h3{font-size:21px}#tutorial .tut-key{font-size:16px}#tutorial button{font-size:17px;min-height:44px}#tutorial .tut-hint{font-size:14px}}
@media (max-width:480px){#tutorial{width:min(280px,calc(100vw - 16px));font-size:13px;padding:6px 8px}#tutorial h3{font-size:14px}}
@media (orientation:portrait){#tutorial .tut-head button.hb{display:inline-block;font-size:12px}#tutorial .tut-btns{display:none}#tutorial .tut-head{position:sticky;top:0;background:inherit}#tutorial{width:min(245px,calc(100vw - 16px));max-height:max(80px,calc(50dvh - 248px));overflow-y:auto;pointer-events:auto;overscroll-behavior:contain}}
@media (max-height:420px){#tutorial{width:min(260px,calc(100vw - 16px));padding:6px 8px;font-size:13px}#tutorial h3{font-size:14px}}`;

export interface TutorialOverlayOptions {
  root: HTMLElement; progress: TutorialProgress; bindings: BindingSource;
  device(): TutDevice; probe(): Probe;
  /** Hide (but keep progress) while not in a world: boot menu, character creator. */
  hidden(): boolean;
  onChange?(): void;
}
// ADR-150: also the hotbar / tool bar, tool hint and pickup toasts (needed to progress) and the touch overlay's controls
const AVOID = "#hud,#game-menubar,.build-hud:not([hidden]),#farm-prompt,#xp-chip,[data-touch],.gm-modal .gm-panel,#world-tool-bar,#tool-hint,#pickup-toasts,[class*=hotbar],#touch-overlay [data-touch]";
export const HOLD_MS = 1000;
export function mountTutorial(o: TutorialOverlayOptions): { update(): void; frame(i: { pressed(a: string): boolean; down(a: string): boolean }, menuOpen: boolean): void; destroy(): void; el: HTMLElement } {
  if (!document.getElementById("tut-style")) { const st = document.createElement("style"); st.id = "tut-style"; st.textContent = CSS; document.head.append(st); }
  const el = document.createElement("section"); el.id = "tutorial"; el.setAttribute("role", "dialog"); el.setAttribute("aria-live", "polite"); el.setAttribute("aria-label", "Guide"); el.hidden = true;
  const spot = document.createElement("div"); spot.id = "tutorial-spot"; spot.hidden = true;
  const arrow = document.createElement("div"); arrow.id = "tutorial-arrow"; arrow.hidden = true;
  const ghost = document.createElement("div"); ghost.id = "tutorial-ghost"; ghost.hidden = true; ghost.innerHTML = "<i></i><span>Drag here</span>";
  o.root.append(ghost, spot, arrow, el);
  let yHeld = 0; let yStart = 0;
  const p = o.progress; let key = "";
  /** ADR-275: one short, one-topic tip card (no "3 of 40" counter): Got it / Skip this tip, ✕ turns tips off. */
  const build = (d: TutDevice): void => {
    const s = p.step; const isDo = !!s.done;
    const nextKeys = d === "touch" ? "" : renderTokens("{A:Jump}", o.bindings, d);
    el.innerHTML = `<div class="tut-head"><span>Tip · ${esc(s.section)}</span><button type="button" class="hb${isDo ? " alt" : ""}" data-tut="next">${isDo ? "Skip" : "Got it"}</button><button type="button" class="x" data-tut="skip" aria-label="Turn off tips" title="Turn off tips">✕</button></div>`
      + `<h3>${esc(s.title)}</h3><p data-role="tut-text">${renderTokens(stepText(s.text, d), o.bindings, d)}</p>`
      + (isDo ? `<div class="tut-wait">Try it now.</div>` : "")
      + `<div class="tut-btns">` + (isDo ? `<button type="button" class="alt" data-tut="next">Skip this tip</button>` : `<button type="button" data-tut="next">Got it</button>`) + `</div>`
      + (d === "gamepad" ? `<div class="tut-hint">${isDo ? `Hold ${renderTokens("{A:Reload}", o.bindings, d)} to skip <b class="tut-hold"><i></i></b>` : `${nextKeys} Got it`}</div>` : d === "keyboardMouse" && !isDo ? `<div class="tut-hint">${nextKeys} Got it</div>` : "");
    el.dataset["step"] = s.id; el.dataset["device"] = d; el.dataset["kind"] = isDo ? "do" : "info";
  };
  el.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-tut]"); if (!b) return; e.stopPropagation();
    const a = b.dataset["tut"]; if (a === "next") p.next(); else if (a === "skip") p.skip();
    o.onChange?.(); update();
  });
  // keep taps on the card from reaching the game canvas (touch controls / build placement)
  for (const t of ["pointerdown", "touchstart", "mousedown"]) el.addEventListener(t, (e) => e.stopPropagation());
  const rectOf = (n: Element): Rect | undefined => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : undefined; };
  // ADR-150: empty / transparent containers (an idle #tool-hint is a 300x150 box) must not push the card around
  const shown = (n: Element): boolean => { const cs = getComputedStyle(n); return cs.visibility !== "hidden" && cs.opacity !== "0" && (n.childElementCount > 0 || !!n.textContent?.trim()); };
  const rootRect = (): DOMRect => o.root.getBoundingClientRect();
  const layout = (d: TutDevice): void => {
    const sel = p.step.target?.(d); let tn: Element | null = sel ? document.querySelector(sel) : null;
    const rr = rootRect(); let target = tn ? rectOf(tn) : undefined;
    // ADR-150: a target inside a closed submenu has no box: point at its nearest visible ancestor (e.g. the menu bar) instead
    for (let n = tn?.parentElement; tn && !target && !(d === "touch" && p.step.ghost) && n && n !== document.body; n = n.parentElement) { const r = rectOf(n); if (r && shown(n) && r.w * r.h < 0.25 * rr.width * rr.height) { tn = n; target = r; } }
    const wantGhost = d === "touch" && p.step.ghost === "joystick" && !target; ghost.hidden = !wantGhost;
    if (wantGhost) { tn = ghost; target = rectOf(ghost); }
    // ADR-150: a target inside a UI block (a HUD bar, a menu-bar button) keeps the card off the whole block
    let zone = target; const avoid: Rect[] = []; for (const n of Array.from(document.querySelectorAll(AVOID))) { if (n === tn || !shown(n)) continue; const r = rectOf(n); if (!r) continue; if (tn && n.contains(tn)) { if (target && r.w * r.h < 0.25 * rr.width * rr.height) zone = r; continue; } avoid.push(r); }
    const card = { w: el.offsetWidth, h: el.offsetHeight };
    const local = (r: Rect): Rect => ({ x: r.x - rr.left, y: r.y - rr.top, w: r.w, h: r.h });
    const pos = placeCard({ w: rr.width, h: rr.height }, card, zone && local(zone), avoid.map(local));
    el.style.left = `${Math.round(pos.x)}px`; el.style.top = `${Math.round(pos.y)}px`;
    if (target) {
      const t = local(target); const pad = 4;
      Object.assign(spot.style, { left: `${t.x - pad}px`, top: `${t.y - pad}px`, width: `${t.w + pad * 2}px`, height: `${t.h + pad * 2}px` }); spot.hidden = false;
      const below = pos.y > t.y + t.h; const above = pos.y + card.h < t.y;
      if (below || above) { arrow.textContent = below ? "▲" : "▼"; arrow.style.left = `${clamp(t.x + t.w / 2, 12, rr.width - 12)}px`; arrow.style.top = `${below ? t.y + t.h + 10 : t.y - 10}px`; arrow.hidden = false; } else arrow.hidden = true;
    } else { spot.hidden = true; arrow.hidden = true; }
  };
  function update(): void {
    if (!p.active || o.hidden() || p.step.ghost === undefined || o.device() !== "touch") ghost.hidden = true;
    if (!p.active || o.hidden()) { if (p.active) o.probe(); /* ADR-275: keep sampling (e.g. death → respawn) while hidden */ el.hidden = true; spot.hidden = true; arrow.hidden = true; key = ""; return; }
    const d = o.device(); const probe = o.probe();
    if (p.gated(probe)) { el.hidden = true; spot.hidden = true; arrow.hidden = true; ghost.hidden = true; key = ""; return; } // ADR-275: nothing triggered yet
    if (p.observe(probe)) o.onChange?.();
    if (!p.active) { el.hidden = true; spot.hidden = true; arrow.hidden = true; key = ""; return; }
    const k = `${p.step.id}|${d}`;
    if (k !== key) { key = k; build(d); }
    el.hidden = false; layout(d);
  }
  function setHold(f: number): void { const b = el.querySelector<HTMLElement>(".tut-hold i"); if (b) b.style.width = `${Math.round(Math.min(1, f) * 100)}%`; }
  const timer = setInterval(update, 250); addEventListener("resize", update);
  return {
    el, update,
    /** Per input update: info cards move on with Jump (A / Space); gamepad B goes back. Skipped while a menu is open. */
    frame(i: { pressed(a: string): boolean; down(a: string): boolean }, menuOpen: boolean): void {
      if (!p.active || menuOpen || el.hidden) { if (yStart > 0) yStart = 0; return; }
      const d = o.device();
      if (d === "gamepad" && p.step.done) { // ADR-144: hold Y (Reload) 1 s to skip an action tip
        const down = i.down("Reload"); const now = performance.now();
        if (!down) { if (yStart) { yStart = 0; setHold(0); } }
        else if (yStart < 0) { /* wait for release after a skip */ }
        else { if (!yStart) yStart = now; yHeld = (now - yStart) / HOLD_MS; setHold(yHeld); if (yHeld >= 1) { yStart = -1; setHold(0); p.next(); o.onChange?.(); update(); return; } }
      }
      // ADR-275: info tips close with Jump (A / Space); pad B (Cancel is the menu key) never steals the tip.
      if (!p.step.done && d !== "touch" && i.pressed("Jump")) { p.next(); o.onChange?.(); update(); }
    },
    destroy(): void { clearInterval(timer); removeEventListener("resize", update); el.remove(); ghost.remove(); spot.remove(); arrow.remove(); },
  };
}
