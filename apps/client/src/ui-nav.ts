/**
 * Shared in-game focus/navigation layer for every menu and modal (inventory, crafting, build, character, party, clan,
 * trade, chat, settings, session, pause). One modal stack, portaled into the UI root (./ui-root.ts) so it
 * renders and takes input in fullscreen. Devices:
 * - touch / mouse: modals are plain DOM with >= 44px tap targets; the menu bar (./game-menus.ts) opens each one.
 * - keyboard: Tab / Shift+Tab cycle (trapped in the top modal), arrows move spatially, Enter / Space activate,
 *   Esc closes the top modal (opens the pause menu when none is open), plus per-menu hotkeys when no text field is focused.
 * - gamepad: D-pad / left stick move focus (with repeat), A activates, B closes / goes back, Start toggles the pause menu,
 *   Select opens the pause menu (hub listing every menu).
 * While a modal is open the "Dialog" input context is pushed so gameplay actions (move/attack) are consumed.
 * Spatial moves use @engine/input's FocusManager over element rects; with no layout (all rects empty) they fall back to DOM order.
 */
import { FocusManager, type Dir } from "@engine/input";
import { BackHistory, focusVisible, markNavFocus, revealAboveFooter } from "./back-history.js";
import { buildSignEditor } from "./sign-editor.js";
import { gamepadKeyControl, navPad, padArbiter, traceAction, type PadControl, type PadSource } from "./pad-input.js";

export interface ContextStack { push(name: string): void; pop(name?: string): void; isActive?(name: string): boolean }
/** Input contexts in which Esc belongs to the game (Build.Cancel / Road.Cancel, ADR-122), not the pause menu. */
export const ESC_OWNING_CONTEXTS = ["Building", "Road"] as const;
export interface ModalHandle { id: string; el: HTMLElement; close(): void }
export interface UINavOptions {
  root: HTMLElement;
  /** Opens the pause menu (Esc / Start / Select with nothing open). */
  onPause?: () => void;
  /** Gameplay input stack: "Dialog" is pushed while any modal is open. */
  input?: ContextStack;
  /** code (KeyboardEvent.code) -> handler, active when no text field has focus. */
  hotkeys?: Record<string, () => void>;
  /** Page the open menu (PgUp/PgDn, gamepad LB/RB) while a modal is open; e.g. the paged container grid (ADR-098). */
  onPage?: (dir: -1 | 1, kind?: "tab" | "page") => void;
  getGamepads?: () => readonly (GamepadLikeNav | null)[];
  /** default true: poll gamepads every animation frame */
  pollGamepads?: boolean;
  now?: () => number;
  /** Poll the pad even while a boot screen ([data-boot]) is up (the character creator's name keyboard). */
  ignoreBoot?: boolean;
  /** default true: Android/browser back (popstate) closes the top modal */
  history?: boolean;
}
export interface GamepadLikeNav { buttons: readonly { pressed: boolean; value?: number }[]; axes: readonly number[]; mapping?: string; id?: string; index?: number; connected?: boolean }
export const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, SELECT: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const;
/** Face/shoulder shortcuts inside an open modal: clicks its enabled `[data-pad=<name>]` control (e.g. camper Y = add fuel, LB/RB = tabs). */
export const PAD_SHORTCUTS = ["X", "Y", "LB", "RB", "LT", "RT"] as const;
/** ADR-200: Xbox-style glyphs for the pad hint footer. */
export const PAD_GLYPH: Record<string, string> = { A: "Ⓐ", B: "Ⓑ", X: "Ⓧ", Y: "Ⓨ", LB: "LB", RB: "RB", LT: "LT", RT: "RT" };
/** ADR-200: `html[data-pad-ui]` while the pad is the last-used device (shows hint footers); any pointer / key clears it. */
let padUiHooked = false;
/**
 * ADR-513: D-pad wrap at a modal's edge. The control that shares the focused one's column (down / up) or row (left / right)
 * and lies furthest the other way, or undefined when none does. The old DOM-order step jumped from a grid's last row into
 * whatever panel came next in the markup (inventory: Down on Hotbar 8 went UP to the equipment's Main hand and looped).
 */
export function edgeWrap(rects: readonly { left: number; right: number; top: number; bottom: number }[], i: number, dir: "up" | "down" | "left" | "right"): number | undefined {
  const c = rects[i]; if (!c) return undefined; const vert = dir === "up" || dir === "down";
  let best: number | undefined, bestKey = Infinity;
  rects.forEach((r, j) => {
    if (j === i || r.right - r.left <= 0 || r.bottom - r.top <= 0) return;
    const overlap = vert ? Math.min(c.right, r.right) - Math.max(c.left, r.left) : Math.min(c.bottom, r.bottom) - Math.max(c.top, r.top); if (overlap <= 1) return;
    const key = dir === "down" ? r.top : dir === "up" ? -r.bottom : dir === "right" ? r.left : -r.right;
    if (key < bestKey) { bestKey = key; best = j; }
  });
  if (best === undefined) return undefined; const b = rects[best]!;
  // the far end must really be on the other side (a lone control in its column has nowhere to wrap to)
  const other = dir === "down" ? b.top < c.top : dir === "up" ? b.bottom > c.bottom : dir === "right" ? b.left < c.left : b.right > c.right;
  return other ? best : undefined;
}
export function setPadUi(on: boolean, doc: Document | undefined = typeof document !== "undefined" ? document : undefined): void {
  if (!doc) return; if (on) doc.documentElement.dataset["padUi"] = "1"; else delete doc.documentElement.dataset["padUi"];
  if (!padUiHooked) { padUiHooked = true; const off = (): void => setPadUi(false, doc); doc.addEventListener("pointerdown", off, true);
    // ADR-213: Edge keyboard emulation delivers the PAD as keys (GamepadDPadUp / keyCode 203): those keep the pad UI on
    doc.addEventListener("keydown", (e) => { if (gamepadKeyControl(e) === undefined) off(); }, true); }
}
const HINT_CSS = `.pad-hints{display:none;position:sticky;bottom:0;z-index:2;gap:12px;flex-wrap:wrap;justify-content:center;padding:4px 8px;margin-top:6px;background:rgba(43,28,36,.92);color:#FFFAF0;font:700 13px Fredoka,system-ui,sans-serif;border-radius:8px;pointer-events:none}
:root[data-pad-ui] .pad-hints{display:flex}.pad-hints b{display:inline-block;min-width:20px;text-align:center;margin-right:3px;color:#FFD45A}
:root[data-pad-ui] [data-modal] :focus{outline:3px solid #FFD45A !important;outline-offset:2px;box-shadow:0 0 0 6px rgba(255,212,90,.35)}`;
const FOCUSABLE = "button,input,select,textarea,a[href],[tabindex]:not([tabindex='-1'])";
const DIR_OF: Partial<Record<PadControl, Dir>> = { UP: "up", DOWN: "down", LEFT: "left", RIGHT: "right" };
const CTL_OF: Record<Dir, PadControl> = { up: "UP", down: "DOWN", left: "LEFT", right: "RIGHT" };
const ARROWS: Record<string, PadControl> = { ArrowUp: "UP", ArrowDown: "DOWN", ArrowLeft: "LEFT", ArrowRight: "RIGHT" };
const isText = (el: Element | null): boolean => (el instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "range"].includes(el.type)) || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable);

export class UINav {
  private stack: { id: string; el: HTMLElement; onClose?: (() => void) | undefined; restore: Element | null }[] = [];
  private prevPad: Record<string, boolean> = {};
  private held: Dir | undefined; private nextAt = 0; private raf = 0;
  /** ADR-213: repeat clock = poll time with each step capped at 120 ms, so one long frame (a hitch on a console) never turns a tap into a repeat. */
  private vnow = 0; private lastPoll = 0;
  private readonly onKey = (e: KeyboardEvent): void => this.key(e);
  /** Android/browser back closes the top modal like Esc / B (ADR-107); opt out with history:false. */
  private readonly backHistory: BackHistory | undefined;
  private bootHold = false;
  /** ADR-213: a keyboard-emulated pad direction being held (repeat is ours: Edge may not auto-repeat pad keys). */
  private keyHeld: { ctl: PadControl; dir: Dir; nextAt: number } | undefined;
  private readonly onKeyUp = (e: KeyboardEvent): void => { const c = gamepadKeyControl(e); if (c) { padArbiter.release(c, "key", this.t()); if (this.keyHeld?.ctl === c) this.keyHeld = undefined; } else if (ARROWS[e.key]) padArbiter.release(ARROWS[e.key]!, "arrow", this.t()); };
  private readonly onBlur = (): void => { this.keyHeld = undefined; };
  private t(): number { return this.o.now?.() ?? performance.now(); }
  constructor(readonly o: UINavOptions) {
    padArbiter.reset(); addEventListener("keydown", this.onKey, true); addEventListener("keyup", this.onKeyUp, true); addEventListener("blur", this.onBlur);
    // ADR-139: menus built mid-press (Start in the character creator enters the world) ignore buttons already held until released
    { const g = navPad(o.getGamepads); this.bootHold = !o.ignoreBoot && !!g?.buttons.some((x) => x.pressed); }
    this.backHistory = o.history === false ? undefined : new BackHistory(() => { this.close(); });
    if (o.pollGamepads !== false && typeof requestAnimationFrame === "function") { const loop = (): void => { this.pollGamepad(); this.raf = requestAnimationFrame(loop); }; this.raf = requestAnimationFrame(loop); }
  }
  destroy(): void { removeEventListener("keydown", this.onKey, true); removeEventListener("keyup", this.onKeyUp, true); removeEventListener("blur", this.onBlur); if (this.raf) cancelAnimationFrame(this.raf); this.closeAll(); this.backHistory?.destroy(); }

  /** The top modal element (ADR-200 tab cycling). */
  stack_top(): HTMLElement | undefined { return this.stack.at(-1)?.el; }
  get isOpen(): boolean { return this.stack.length > 0; }
  get top(): string | undefined { return this.stack.at(-1)?.id; }
  isOpenId(id: string): boolean { return this.stack.some((s) => s.id === id); }

  /** Open (portal) a modal into the UI root and focus its first control (or `[autofocus]`). */
  open(id: string, el: HTMLElement, onClose?: () => void): ModalHandle {
    if (this.isOpenId(id)) this.closeTo(id);
    el.dataset["modal"] = id; el.setAttribute("role", el.getAttribute("role") ?? "dialog"); el.setAttribute("aria-modal", "true");
    const restore = document.activeElement;
    this.o.root.append(el);
    if (!this.stack.length) this.o.input?.push("Dialog");
    // Every modal gets a visible Back/Close control (ADR-107): panels built by GameMenus carry [data-role=close]; anything else gets one.
    if (!el.querySelector("[data-role=close],[data-role=back]")) {
      const b = document.createElement("button"); b.type = "button"; b.className = "alt ui-back"; b.dataset["role"] = "back"; b.textContent = "← Back";
      b.setAttribute("aria-label", "Back"); b.addEventListener("click", () => this.closeId(id));
      (el.querySelector(".gm-panel") ?? el).prepend(b);
    }
    this.stack.push({ id, el, onClose, restore }); this.hints(el);
    this.backHistory?.sync(true);
    const first = el.querySelector<HTMLElement>("[autofocus]") ?? this.focusables()[0]; focusVisible(first);
    return { id, el, close: () => this.closeId(id) };
  }
  /** Close the top modal (B / Esc / Back button). */
  close(): void {
    const s = this.stack.pop(); if (!s) return;
    s.el.remove(); s.onClose?.();
    if (!this.stack.length) this.o.input?.pop("Dialog");
    this.backHistory?.sync(this.stack.length > 0);
    const t = this.stack.at(-1); if (t) focusVisible(s.restore instanceof HTMLElement && s.restore.isConnected && t.el.contains(s.restore) && this.focusables().includes(s.restore) ? s.restore : this.focusables()[0]); else if (s.restore instanceof HTMLElement && s.restore.isConnected) s.restore.focus();
  }
  closeId(id: string): void { while (this.isOpenId(id)) this.close(); }
  private closeTo(id: string): void { while (this.top && this.top !== id) this.close(); this.close(); }
  closeAll(): void { while (this.stack.length) this.close(); }
  /** Toggle: hotkey / menu-bar button for a menu that may already be on top. */
  toggle(id: string, build: () => HTMLElement, onClose?: () => void): void { if (this.top === id) this.close(); else { if (this.isOpenId(id)) this.closeId(id); this.open(id, build(), onClose); } }

  focusables(): HTMLElement[] {
    const t = this.stack.at(-1)?.el; if (!t) return [];
    return Array.from(t.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((e) => !(e as HTMLButtonElement).disabled && !e.hidden && e.closest("[hidden]") === null && e.getAttribute("aria-hidden") !== "true");
  }
  get focused(): HTMLElement | undefined { const a = document.activeElement; return a instanceof HTMLElement && this.focusables().includes(a) ? a : undefined; }

  /** Linear (Tab order) move, wrapping inside the top modal. */
  step(delta: number): HTMLElement | undefined {
    markNavFocus();
    const f = this.focusables(); if (!f.length) return undefined;
    const i = this.focused ? f.indexOf(this.focused) : -1; const n = f[i < 0 ? (delta > 0 ? 0 : f.length - 1) : (i + delta + f.length) % f.length]!; focusVisible(n); return n;
  }
  /** Spatial move (arrows / D-pad / stick). */
  move(dir: Dir): HTMLElement | undefined {
    markNavFocus();
    const f = this.focusables(); if (!f.length) return undefined;
    const cur = this.focused; if (!cur) { focusVisible(f[0]); return f[0]; }
    const rects = f.map((e) => e.getBoundingClientRect());
    if (rects.every((r) => r.width === 0 && r.height === 0)) return this.step(dir === "up" || dir === "left" ? -1 : 1);
    const fm = new FocusManager(); fm.pushScreen("modal", true);
    f.forEach((e, i) => { const r = rects[i]!; fm.add({ id: String(i), rect: { x: r.left, y: r.top, w: r.width, h: r.height } }); });
    fm.setFocus(String(f.indexOf(cur)));
    const next = fm.navigate(dir);
    if (next === undefined || next === String(f.indexOf(cur))) { // edge: wrap to the far end of the same column / row
      const w = edgeWrap(rects, f.indexOf(cur), dir); if (w !== undefined) { const n = f[w]!; focusVisible(n); return n; }
      return this.step(dir === "up" || dir === "left" ? -1 : 1); // nothing shares the column / row: DOM order
    }
    const n = f[Number(next)]!; focusVisible(n); return n;
  }
  /** A / Enter / Space on the focused control. */
  activate(fromPad = false): void {
    const f = this.focused ?? this.focusables()[0]; if (!f) return;
    if (isText(f) && fromPad && (f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement)) { this.openTextKeyboard(f); return; }
    if (isText(f)) { f.focus(); const submit = f.closest("[data-modal]")?.querySelector<HTMLElement>("[data-role=submit]"); if (submit && document.activeElement === f && (f as HTMLInputElement).value) submit.click(); return; }
    f.click();
  }
  /** Click the open modal's enabled `[data-pad=name]` control (gamepad X/Y/LB/RB). Returns whether one fired. */
  padShortcut(name: string): boolean {
    const t = this.stack.at(-1)?.el;
    // ADR-204: contextual first — the focused control's data-pad-<x|y|lb|…>="<data-key>" names the action it stands for
    const ctx = this.focused?.dataset[`pad${name[0]}${name.slice(1).toLowerCase()}`];
    if (ctx && t) { const k = t.querySelector<HTMLButtonElement>(`[data-key="${ctx}"]`); if (k && !k.disabled) { k.click(); return true; } }
    const c = t?.querySelector<HTMLButtonElement>(`[data-pad="${name}"]`); if (!c || c.disabled || c.closest("[hidden]")) return false; c.click(); return true;
  }
  /** ADR-200: gamepad text entry — A on any text field opens the shared on-screen keyboard as a nested modal; Save writes the
   *  value back (firing input + change) and, when the field's modal has a [data-role=submit], leaves focus there for one more A. */
  openTextKeyboard(f: HTMLInputElement | HTMLTextAreaElement): void {
    const label = f.getAttribute("aria-label") ?? f.placeholder ?? "text"; const max = f.maxLength > 0 ? f.maxLength : 200;
    const ed = buildSignEditor({ kindName: label.toLowerCase(), saveLabel: "Done", maxLen: max, initial: f.value, keyboard: true, raw: true, placeholder: f.placeholder || label,
      close: () => this.closeId("osk"), onSave: (t) => { f.value = t; f.dispatchEvent(new Event("input", { bubbles: true })); f.dispatchEvent(new Event("change", { bubbles: true })); } });
    ed.dataset["role"] = "pad-osk"; this.open("osk", ed);
  }
  /** ADR-200: (re)build the glyph hint footer of a modal from its live `[data-pad]` shortcuts. */
  hints(el: HTMLElement | undefined = this.stack.at(-1)?.el): void {
    if (!el || typeof document === "undefined") return;
    if (!document.getElementById("pad-hints-css")) { const st = document.createElement("style"); st.id = "pad-hints-css"; st.textContent = HINT_CSS; document.head.append(st);
      // ADR-205: any focus change (pad, keys, panel code) keeps the focused control clear of the sticky footer
      document.addEventListener("focusin", (e) => revealAboveFooter(e.target as Element | null)); }
    const parts: string[] = [`<span><b>${PAD_GLYPH["A"]}</b>Select</span>`, `<span><b>${PAD_GLYPH["B"]}</b>Back</span>`];
    const fo = this.focused && el.contains(this.focused) ? this.focused : undefined;
    for (const n of PAD_SHORTCUTS) { const ck = `pad${n[0]}${n.slice(1).toLowerCase()}`; const cl = fo?.dataset[ck];
      if (cl && el.querySelector(`[data-key="${cl}"]`)) { parts.push(`<span><b>${PAD_GLYPH[n]}</b>${(fo!.dataset[`${ck}Label`] ?? n).replace(/[<&]/g, "")}</span>`); continue; }
      const c = el.querySelector<HTMLButtonElement>(`[data-pad="${n}"]`); if (!c || c.disabled || c.closest("[hidden]")) continue;
      const t = (c.dataset["padLabel"] ?? c.getAttribute("aria-label") ?? c.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 18); parts.push(`<span><b>${PAD_GLYPH[n]}</b>${t.replace(/[<&]/g, "")}</span>`); }
    if (this.o.onPage && !el.querySelector('[data-pad="LB"],[data-pad="RB"]') && el.querySelector("[data-tabs=tab],[role=tablist]")) parts.push(`<span><b>LB/RB</b>Tabs</span>`);
    if (this.o.onPage && el.querySelector("[data-tabs=page]")) parts.push(`<span><b>LT/RT</b>${(el.querySelector<HTMLElement>("[data-tabs=page]")!.dataset["tabsLabel"] ?? "Page").replace(/[<&]/g, "")}</span>`);
    const html = parts.join("");
    let f = el.querySelector<HTMLElement>(":scope > .pad-hints, :scope > .gm-panel > .pad-hints");
    if (f?.dataset["h"] === html) return;
    if (!f) { f = document.createElement("div"); f.className = "pad-hints"; f.dataset["role"] = "pad-hints"; f.setAttribute("aria-hidden", "true"); (el.querySelector(":scope > .gm-panel, :scope > .se-panel") ?? el).append(f); }
    f.dataset["h"] = html; f.innerHTML = html; revealAboveFooter(document.activeElement); // footer height may have changed
  }
  private pause(): void { this.o.onPause?.(); }

  /** ADR-213: one logical pad control from either source (Gamepad API poll or Edge keyboard emulation). */
  private padAction(c: PadControl, src: PadSource): void {
    traceAction(`${src} ${c} -> ${this.top ?? "(no modal)"}`);
    if (c === "START") { if (this.top === "pause") this.close(); else this.pause(); return; }
    if (!this.isOpen) return; // Select / D-pad / A... belong to gameplay with no modal open (ADR-139)
    const d = DIR_OF[c]; if (d) { this.move(d); return; }
    if (c === "SELECT") { if (this.top === "inventory") this.close(); return; }
    if (c === "A") { this.activate(true); return; }
    if (c === "B") { this.close(); return; }
    if (c === "LB" || c === "RB" || c === "LT" || c === "RT" || c === "X" || c === "Y") { if (!this.padShortcut(c) && c !== "X" && c !== "Y") this.o.onPage?.(c === "LB" || c === "LT" ? -1 : 1, c === "LB" || c === "RB" ? "tab" : "page"); this.hints(); }
  }
  /** ADR-213: Edge on Xbox (gamepadInputEmulation 'keyboard', or the setting ignored) sends the controller as key events:
   *  key "GamepadDPadUp" / "GamepadLeftThumbstickUp" / "GamepadA"... or "Unidentified" with keyCode 195..218. */
  private padKey(e: KeyboardEvent, c: PadControl | null): void {
    if (!this.o.ignoreBoot && typeof document !== "undefined" && document.querySelector("[data-boot]")) return; // the boot menu owns the pad
    if (typeof document !== "undefined" && !document.documentElement.dataset["padUi"]) setPadUi(true); markNavFocus();
    if (c === null || (!this.isOpen && c !== "START")) return; // gameplay gets it (browser input adapter: virtual pad)
    e.preventDefault(); e.stopPropagation();
    const t = this.t(); if (!padArbiter.claim(c, "key", t, 1000)) { traceAction(`key ${c} dropped (pad API owns it)`); return; }
    if (e.repeat || this.keyHeld?.ctl === c) return; // repeat comes from our own timer (keyRepeat), never twice
    const d = DIR_OF[c]; this.keyHeld = d ? { ctl: c, dir: d, nextAt: this.vnow + 400 } : undefined;
    this.padAction(c, "key");
  }
  private keyRepeat(now: number, v: number): void {
    const k = this.keyHeld; if (!k || v < k.nextAt) return;
    if (!this.isOpen) { this.keyHeld = undefined; return; }
    padArbiter.claim(k.ctl, "key", now, 1000); k.nextAt = v + 110; this.move(k.dir); traceAction(`key ${k.ctl} repeat`);
  }

  private key(e: KeyboardEvent): void {
    const pc = gamepadKeyControl(e); if (pc !== undefined) { this.padKey(e, pc); return; }
    const typing = isText(document.activeElement);
    if (!this.isOpen) {
      if (typing) return;
      if (e.key === "Escape" && ESC_OWNING_CONTEXTS.some((c) => this.o.input?.isActive?.(c))) return; // Build.Cancel via the input system
      if (e.key === "Escape") { this.pause(); e.preventDefault(); e.stopPropagation(); return; }
      const h = this.o.hotkeys?.[e.code]; if (h && !e.ctrlKey && !e.metaKey && !e.altKey) { h(); e.preventDefault(); e.stopPropagation(); }
      return;
    }
    // a modal is open: it owns the keyboard
    if (e.key === "Escape") { this.close(); e.preventDefault(); e.stopPropagation(); return; }
    if (e.key === "Tab") { this.step(e.shiftKey ? -1 : 1); e.preventDefault(); e.stopPropagation(); return; }
    if (typing) { if (e.key === "Enter") { this.activate(); e.preventDefault(); } return; }
    const dirs: Record<string, Dir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
    const d = dirs[e.key]; if (d) { e.preventDefault(); e.stopPropagation();
      // ADR-213: Edge may turn the same D-pad press into ArrowDown too: the pad API / pad key that already moved owns it
      if (!padArbiter.claim(ARROWS[e.key]!, "arrow", this.t(), 150)) { traceAction(`arrow ${e.key} dropped (pad owns it)`); return; }
      this.move(d); return; }
    // hold-to-confirm buttons (data-hold, e.g. delete progress) handle their own Enter/Space press + release
    if ((e.key === "Enter" || e.key === " ") && (e.target as HTMLElement | null)?.dataset?.["hold"] !== undefined) return;
    if (e.key === "Enter" || e.key === " ") { this.activate(); e.preventDefault(); e.stopPropagation(); return; }
    if ((e.key === "PageUp" || e.key === "PageDown") && this.o.onPage) { this.o.onPage(e.key === "PageUp" ? -1 : 1, "page"); e.preventDefault(); e.stopPropagation(); return; }
    const h = this.o.hotkeys?.[e.code]; if (h && !e.ctrlKey && !e.metaKey && !e.altKey) { h(); e.preventDefault(); e.stopPropagation(); }
  }

  /** One gamepad sample (edge-detected; stick/D-pad repeat 400ms then 110ms). Called per frame; exposed for tests.
   *  ADR-213: every connected pad is merged (an idle pad at index 0 no longer hides the live one at index 1), mapping ""
   *  pads are normalised (hat D-pad, View/Menu), and a press also delivered as a pad key / arrow key acts only once. */
  pollGamepad(): void {
    const now = this.t();
    this.vnow += this.lastPoll ? Math.min(Math.max(now - this.lastPoll, 0), 120) : 16; this.lastPoll = now; const v = this.vnow;
    this.keyRepeat(now, v);
    const gp = navPad(this.o.getGamepads); if (!gp) return;
    const raw = (i: number): boolean => !!gp.buttons[i]?.pressed;
    // boot menu / character creator own the pad (Start there = Enter world); a button still held from there is ignored until released
    if (!this.o.ignoreBoot && typeof document !== "undefined" && document.querySelector("[data-boot]")) { this.bootHold = true; for (const k of Object.keys(PAD)) this.prevPad[k] = raw(PAD[k as keyof typeof PAD]); return; }
    if (this.bootHold) { if (gp.buttons.some((x) => x.pressed)) return; this.bootHold = false; }
    const ax = gp.axes[0] ?? 0, ay = gp.axes[1] ?? 0;
    const dir: Dir | undefined = raw(PAD.UP) ? "up" : raw(PAD.DOWN) ? "down" : raw(PAD.LEFT) ? "left" : raw(PAD.RIGHT) ? "right"
      : Math.max(Math.abs(ax), Math.abs(ay)) < 0.5 ? undefined : Math.abs(ax) > Math.abs(ay) ? (ax < 0 ? "left" : "right") : ay < 0 ? "up" : "down";
    if (gp.buttons.some((x) => x.pressed) || dir) { if (typeof document !== "undefined" && !document.documentElement.dataset["padUi"]) setPadUi(true); }
    /** Edge + ownership: true on the frame `name` goes down AND this source owns it (not already handled as a key). */
    const press = (name: PadControl, v: boolean): boolean => {
      const was = this.prevPad[name]; this.prevPad[name] = v;
      if (!v) { if (was) padArbiter.release(name, "api", now); return false; }
      const owned = padArbiter.claim(name, "api", now);
      if (!was && !owned) traceAction(`api ${name} dropped (key owns it)`);
      return !was && owned;
    };
    const DIRC = dir ? CTL_OF[dir] : undefined;
    if (this.held && this.held !== dir) padArbiter.release(CTL_OF[this.held], "api", now);
    const dirOwned = DIRC ? padArbiter.claim(DIRC, "api", now) : false;
    if (press("START", raw(PAD.START))) { this.padAction("START", "api"); return; }
    const select = press("SELECT", raw(PAD.SELECT)), a = press("A", raw(PAD.A)), bb = press("B", raw(PAD.B));
    const sc = PAD_SHORTCUTS.filter((n) => press(n, raw(PAD[n])));
    if (!this.isOpen) { this.held = dir; return; } // Select is the inventory action in gameplay (ADR-139), not pause
    if (select && this.top === "inventory") { this.padAction("SELECT", "api"); return; }
    if (dir !== this.held) { this.held = dir; if (dir) { if (dirOwned) this.padAction(DIRC!, "api"); else traceAction(`api ${DIRC} dropped (key owns it)`); this.nextAt = v + 400; } }
    else if (dir && v >= this.nextAt) { if (dirOwned) this.move(dir); this.nextAt = v + 110; }
    if (a) { this.padAction("A", "api"); return; }
    if (bb) { this.padAction("B", "api"); return; }
    // X / Y / LB / RB / LT / RT: the modal's own [data-pad] control wins; otherwise LB/RB switch tabs and LT/RT page (onPage)
    for (const n of sc) this.padAction(n, "api");
    this.hints();
  }
}
