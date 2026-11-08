/**
 * Boot UI in Art's cozy-camp theme: loading screen (logo from art/ui/branding/ when present, else a styled title)
 * with a progress bar, then the main menu (Singleplayer / Multiplayer / Settings).
 * Navigation: mouse, touch (buttons), keyboard (arrows/WASD/Tab, Enter/Space, Esc) and gamepad (d-pad/stick, A, B).
 */
import { sampleWorldPreview, worldPreviewSvg, randomWorldSeed } from "@engine/world";
import { parseWorldSeed } from "./world-seed.js";
import { localizeTemps, saveTempUnit } from "./hud-temp.js";
import { deleteConfirm, deleteLocalProgress, listLocalSaves, type LocalSaveKind } from "./delete-progress.js";
import { BUILD_HASH } from "./error-log.js";
import { mountUi } from "./ui-root.js";
import { bindTypingFullscreenExit, enterFullscreen } from "./fullscreen.js";
import { BackHistory, focusVisible, markNavFocus } from "./back-history.js";
import { navPad, PadEdges, padKeyEdge, traceAction, type PadControl } from "./pad-input.js";
const isTyping = (t: EventTarget | null): boolean => t instanceof HTMLInputElement && t.type !== "checkbox" && t.type !== "range";
import { EasedBar, zombiePose } from "./load-progress.js";
import { TIPS, TIP_COLOR, TIP_ROTATION_MS, nextTip } from "./tips.js";
import { installKeyboardViewport } from "./keyboard-viewport.js";
interface Branding { title: string; tagline: string; logo: string; bg: "" | "flat" | "parallax"; plates: boolean; icons: boolean; loading: boolean; loadingAnim: boolean }
declare const __BRANDING__: Branding | undefined;
const BR: Branding = (typeof __BRANDING__ !== "undefined" && __BRANDING__) || { title: "Cozy Wild", tagline: "survival", logo: "", bg: "", plates: false, icons: false, loading: false, loadingAnim: false };
/** {app.title}: Art's branding.json title (placeholder until the game is named). */
export const APP_TITLE = BR.title;
export type MenuChoice = { kind: "singleplayer"; seed?: number } | { kind: "multiplayer"; url: string } | { kind: "host"; seed?: number } | { kind: "join"; code: string };
/** hostCap: desktop P2P host player cap incl. the host (mobile hosts are fixed at 6, see p2p.ts). */
export interface Settings { bots: number; showHud: boolean; fullscreen: boolean; hostCap: number; /** ADR-121: new-world rules */ hordes: boolean; hordeGraceDays: number; /** Task 22: AI humans in multiplayer (new worlds) */ aiHumans?: boolean; /** ADR-126: tool symbol near resource nodes */ toolHints: boolean; /** ADR-173: name tags over other players */ nameTags?: boolean; /** ADR-306: hidden-ledge drop arrows (on by default; off for a harder run) */ ledgeWarnings?: boolean; /** ADR-239/243: HUD temperature units (default F; C only with tempUnitChosen) */ tempUnit?: "C" | "F"; /** ADR-243: the player picked tempUnit themselves */ tempUnitChosen?: boolean }
/** ADR-121: the world rules a NEW local / hosted world is created with (an existing save keeps its own). */
export function newWorldRules(s: Settings = loadSettings()): { hordes: boolean; hordeGraceDays: number; aiHumans: boolean } { return { hordes: s.hordes !== false, hordeGraceDays: Math.max(0, Math.min(30, Number(s.hordeGraceDays) || 0)), aiHumans: s.aiHumans !== false }; }
const SETTINGS_KEY = "engine-settings";
/** ADR-243: the HUD temperature unit a Settings object resolves to. °F is the default; °C only when the player picked it
 *  (`tempUnitChosen`). A bare `tempUnit: "C"` is the ADR-239 default that every Settings save wrote, not a choice -> °F. */
export function resolveTempUnit(s: { tempUnit?: string; tempUnitChosen?: boolean } | undefined): "C" | "F" { return s?.tempUnit === "C" && s.tempUnitChosen === true ? "C" : "F"; }
export interface TempUnitControl { el: HTMLElement; value(): "C" | "F"; /** Settings fields to save: empty until the player presses a unit (keeps "never changed" = °F default) */ patch(): Partial<Settings> }
/** ADR-243 (amends ADR-239): "Temperature" row with two big °F / °C toggle buttons (`data-setting=tempUnit`, `data-unit`).
 *  Plain buttons, so D-pad / stick focus + A, touch taps, mouse and Enter/Space all work (a native <select> does not open from
 *  the gamepad A press, which only .click()s). A <div>, not a <label>: a label would forward taps on its text to the first button. */
export function tempUnitControl(s: { tempUnit?: string; tempUnitChosen?: boolean } | undefined): TempUnitControl {
  let v = resolveTempUnit(s), touched = false;
  const row = document.createElement("div"); row.className = "temp-unit"; row.dataset["setting"] = "tempUnit"; row.setAttribute("role", "radiogroup"); row.setAttribute("aria-label", "Temperature units");
  row.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:15px";
  const t = document.createElement("span"); t.textContent = "Temperature 🌡"; const g = document.createElement("span"); g.style.cssText = "display:flex;gap:6px";
  const bs = (["F", "C"] as const).map((u) => { const b = document.createElement("button"); b.type = "button"; b.dataset["unit"] = u; b.dataset["key"] = `temp-unit-${u}`; b.setAttribute("role", "radio");
    b.textContent = u === "F" ? "°F" : "°C"; b.title = u === "F" ? "Fahrenheit" : "Celsius"; b.style.cssText = "min-width:56px;min-height:40px;padding:6px 12px";
    b.addEventListener("click", () => { v = u; touched = true; sync(); saveTempUnit(u); }); /* ADR-282: applies at once everywhere */ g.append(b); return b; });
  const sync = (): void => { for (const b of bs) { const on = b.dataset["unit"] === v; b.className = on ? "" : "alt"; b.setAttribute("aria-checked", String(on)); b.setAttribute("aria-pressed", String(on)); } };
  sync(); row.append(t, g);
  return { el: row, value: () => v, patch: () => (touched || s?.tempUnitChosen ? { tempUnit: v, tempUnitChosen: true } : {}) };
}
export function saveSettings(s: Settings): void { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as object), ...s })); } catch { /* private mode */ } }
export function loadSettings(): Settings {
  try { return { bots: 3, showHud: true, fullscreen: true, hostCap: 12, hordes: true, hordeGraceDays: 3, aiHumans: true, toolHints: true, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<Settings> }; } catch { return { bots: 3, showHud: true, fullscreen: true, hostCap: 12, hordes: true, hordeGraceDays: 3, aiHumans: true, toolHints: true }; }
}

const CSS = (base: string): string => `@font-face{font-family:Fredoka;src:url(${base}art/ui/fonts/Fredoka.ttf) format("truetype");font-display:swap}
.boot{position:fixed;inset:0;z-index:20;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;
font:600 16px Fredoka,system-ui,sans-serif;color:#FFFAF0;background:radial-gradient(ellipse at 50% 35%,#3d5a3a 0%,#22301f 55%,#14110f 100%);transition:opacity .35s;
overflow-y:auto;-webkit-overflow-scrolling:touch;touch-action:pan-y;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);box-sizing:border-box}
.boot.hide{opacity:0;pointer-events:none}
.boot .title{font-size:clamp(34px,7vw,68px);font-weight:700;letter-spacing:1px;color:#FFD45A;text-align:center;line-height:1.05;
text-shadow:0 3px 0 #74432C,0 6px 0 #432C24,0 10px 18px rgba(0,0,0,.5);-webkit-text-stroke:2px #3B2433}
.boot .title small{display:block;font-size:.38em;color:#F6EAD2;-webkit-text-stroke:1px #3B2433;letter-spacing:4px;margin-top:6px}
.boot .logo{max-width:min(620px,84vw);max-height:38vh;filter:drop-shadow(0 8px 14px rgba(0,0,0,.45))}
.boot .track{width:min(420px,76vw);height:18px;background:#E6C47E;border:3px solid #4A2F3D;border-radius:10px;overflow:hidden;box-shadow:0 3px 0 #432C24}
.boot .fill{height:100%;width:0;background:linear-gradient(#FFE28A,#F4A74A);transition:width .2s}
.boot .lane{position:relative;width:min(420px,76vw);padding-top:40px}.boot .lane .track{width:100%}
.boot .lane .zw{position:absolute;left:0;bottom:16px;width:36px;height:36px;margin-left:-18px;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' shape-rendering='crispEdges'%3E%3Crect x='5' y='1' width='6' height='5' fill='%2379a85a'/%3E%3Crect x='6' y='3' width='1' height='1' fill='%23c0302a'/%3E%3Crect x='9' y='3' width='1' height='1' fill='%23c0302a'/%3E%3Crect x='4' y='6' width='8' height='5' fill='%234a6b8a'/%3E%3Crect x='11' y='6' width='4' height='2' fill='%2379a85a'/%3E%3Crect x='5' y='11' width='2' height='4' fill='%233b2433'/%3E%3Crect x='9' y='11' width='2' height='4' fill='%233b2433'/%3E%3C/svg%3E") center/contain no-repeat;image-rendering:pixelated;pointer-events:none;will-change:transform,left}
.boot[data-boot=error] .fill{background:#C0302A}.boot[data-boot=error] .lbl{color:#FF9A8A}.boot[data-boot=menu] .lane .zw{display:none}
.boot .version{display:none;position:absolute;top:calc(env(safe-area-inset-top,0px) + 8px);left:calc(env(safe-area-inset-left,0px) + 12px);z-index:5;
font:600 12px system-ui,sans-serif;color:#E6C47E;opacity:.85;pointer-events:none;text-shadow:0 1px 2px rgba(0,0,0,.6)}
.boot[data-boot=menu] .version{display:block}
.boot .lbl{font-size:13px;color:#E6C47E;min-height:1em}.boot .tip{font-size:13px;color:${TIP_COLOR};min-height:2em;max-width:420px;text-align:center}
.boot .panel{display:flex;flex-direction:column;gap:12px;background:#F6EAD2;border:4px solid #74432C;border-radius:18px;padding:18px 22px;
box-shadow:0 4px 0 #432C24,0 10px 24px rgba(0,0,0,.45);min-width:min(320px,86vw);max-width:92vw;color:#3B2433;box-sizing:border-box;
max-height:calc(100vh - 24px);max-height:calc(100dvh - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px) - 24px - var(--kb-inset,0px));overflow-y:auto;-webkit-overflow-scrolling:touch;touch-action:pan-y;overscroll-behavior:contain;flex-shrink:0}
.boot button{font:700 20px Fredoka,system-ui,sans-serif;color:#FFFAF0;background:#5A9A4A;border:3px solid #3B2433;border-radius:14px;padding:10px 18px;
box-shadow:0 4px 0 #2D5A2E;cursor:pointer;touch-action:manipulation;text-shadow:0 2px 0 #2D5A2E;min-height:48px}
.boot .panel.has-footer{max-height:calc(100dvh - var(--sat,0px) - var(--sab,0px) - 16px);overflow-y:auto;padding-bottom:0}
.boot .sticky-footer{position:sticky;bottom:0;z-index:1;display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;background:#F6EAD2;border-top:2px solid #74432C;padding:10px 0 14px;margin-top:4px}
.boot .sticky-footer button{flex:1 1 auto;min-height:44px}.boot button:disabled{opacity:.45;cursor:not-allowed}
.boot button.alt{background:#C98A4B;box-shadow:0 4px 0 #74432C;text-shadow:0 2px 0 #74432C}
.boot button:focus,.boot button.sel{outline:3px solid #FFD45A;outline-offset:2px;transform:translateY(-1px)}
.boot button:active{transform:translateY(2px);box-shadow:0 2px 0 #2D5A2E}
.boot input{font:600 16px Fredoka,system-ui,sans-serif;padding:8px 10px;border:3px solid #4A2F3D;border-radius:10px;background:#FFFAF0;color:#3B2433}
.boot p{margin:0;font-size:14px;line-height:1.35;color:#4A2F3D;max-width:360px}
.boot [data-role=notice]{font-weight:700;color:#A0302A}
.boot h2{margin:0;font-size:22px;color:#74432C}
.boot label{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:15px}
.boot .hint{font-size:12px;color:#E6C47E}
.boot[data-page=multiplayer] .panel{width:min(480px,94vw);gap:10px}
.boot .mp-sec{display:flex;flex-direction:column;gap:6px;padding-top:8px;border-top:2px solid rgba(116,67,44,.25)}
.boot .mp-sec h3{margin:0;font-size:15px;color:#74432C;text-transform:uppercase;letter-spacing:1px}
.boot .mp-sec p{font-size:13px;max-width:none}.boot .mp-sec code{font-size:12px}
.boot .mp-row{display:flex;gap:8px;align-items:stretch}.boot .mp-row input{flex:1 1 0;min-width:0;min-height:44px;box-sizing:border-box}.boot .mp-row button{flex:0 0 auto}
.boot input:focus{outline:3px solid #FFD45A;outline-offset:1px}
.boot .mp-status{font-weight:700}.boot .mp-status[data-state=online]{color:#2D5A2E}.boot .mp-status[data-state=offline]{color:#A0302A}
.boot .mp-foot{font-size:12px;opacity:.8}
.boot[data-page=world-seed] .panel{width:min(480px,94vw);gap:10px}
.boot .world-preview{display:block;width:100%;height:clamp(80px,23vh,180px);object-fit:contain;border:2px solid #74432C;border-radius:8px;box-sizing:border-box;image-rendering:pixelated;background:#294537}
.boot .preview-note{font-size:11px;line-height:1.2}
.boot .world-preview[hidden]{display:none}.boot .world-preview[aria-busy=true]{opacity:.55}
@media(max-height:860px){.boot[data-page=world-seed] .panel{max-height:calc(100dvh - 88px - var(--kb-inset,0px))}}
@media(max-height:500px){.boot[data-page=world-seed] .panel{max-height:calc(100dvh - 16px - var(--kb-inset,0px))}.boot .world-preview{height:80px}.boot[data-page=world-seed] .panel{gap:6px}}
@media (max-height:500px){.boot[data-page=world-seed] .logo,.boot[data-page=world-seed] .title{display:none}}
@media (max-height:860px){.boot[data-page=world-seed]{justify-content:flex-start;gap:8px;padding-top:max(8px,env(safe-area-inset-top,0px))}.boot[data-page=world-seed] .title{font-size:28px}.boot[data-page=world-seed] .title small,.boot[data-page=world-seed] .lane,.boot[data-page=world-seed] .lbl{display:none}.boot[data-page=world-seed] .logo{max-height:56px}}
@media (max-height:860px),(max-width:480px){.boot[data-page=world-seed] .panel{padding:12px 14px}.boot[data-page=world-seed] button{font-size:17px;padding:8px 14px}}
/* ADR-262: portrait phones — the loading bar (lane) and its status label sit dead centre (both loading screens) */
@media (orientation:portrait),(max-width:480px){.boot .lane{margin-left:auto;margin-right:auto}.boot .lbl{display:block;box-sizing:border-box;width:min(420px,76vw);margin-left:auto;margin-right:auto;text-align:center;overflow-wrap:anywhere}}
@media (max-height:860px){.boot[data-page=multiplayer]{justify-content:flex-start;gap:8px;padding-top:max(8px,env(safe-area-inset-top,0px))}.boot[data-page=multiplayer] .title{font-size:28px}.boot[data-page=multiplayer] .title small{display:none}.boot[data-page=multiplayer] .logo{max-height:56px}.boot[data-page=multiplayer] .lane,.boot[data-page=multiplayer] .lbl{display:none}}
@media (max-height:860px),(max-width:480px){.boot[data-page=multiplayer] .panel{padding:12px 14px}.boot[data-page=multiplayer] button{font-size:17px;padding:8px 14px}}
${artCss(base)}`;
const KEYS: Record<string, string> = { Singleplayer: "singleplayer", Multiplayer: "multiplayer", Settings: "settings", Save: "settings", Back: "quit" };
function artCss(base: string): string {
  const u = (f: string): string => `url(${base}art/ui/branding/${f})`; let c = "";
  if (BR.bg === "parallax") c += `.boot{background:#1b1622}.boot .px{position:absolute;inset:-4%;background-size:cover;background-position:center;pointer-events:none;z-index:-1;animation:bootdrift 30s ease-in-out infinite alternate}
@keyframes bootdrift{from{transform:translateX(calc(var(--d)*-24px))}to{transform:translateX(calc(var(--d)*24px))}}`;
  else if (BR.bg === "flat") c += `.boot{background:#1b1622 ${u("background/menu_bg_1920x1080.png")} center/cover}`;
  if (BR.plates) {
    c += `.boot button[class*="k-"]{background:none;border:0;border-style:solid;box-shadow:none;outline:none;border-radius:0;padding:14px 26px 18px;min-height:76px;transform:none;display:flex;align-items:center;justify-content:center;gap:10px;text-shadow:0 2px 0 rgba(59,36,51,.8)}
.boot button[class*="k-"] img{width:40px;height:40px;image-rendering:auto}.boot .panel.art{background:none;border:0;box-shadow:none;padding:0}`;
    for (const k of ["singleplayer", "multiplayer", "settings", "quit"]) for (const [st, sel] of [["normal", ""], ["hover", ":hover,.boot button.k-" + k + ":focus,.boot button.k-" + k + ".sel"], ["pressed", ":active"]] as const)
      c += `.boot button.k-${k}${sel}{border-image:${u(`buttons/plates/btn_plate_${k}_${st}.png`)} 18 22 20 22 fill / 18px 22px 20px 22px stretch}`;
  }
  if (BR.loading) c += `.boot .track{border:0;border-style:solid;border-image:${u("loading/loading_frame.png")} 12 16 15 14 fill / 12px 16px 15px 14px stretch;background:none;box-shadow:none;height:32px;padding:6px 9px 8px 8px;box-sizing:border-box;border-radius:0;overflow:visible;position:relative}
.boot .fill{border:0;border-style:solid;border-image:${u("loading/loading_fill.png")} 7 8 7 8 fill / 7px 8px 7px 8px stretch;background:none;min-width:16px;height:18px}`;
  if (BR.loadingAnim) c += `.boot .cf{position:absolute;bottom:22px;width:64px;height:64px;background-size:384px 64px;image-rendering:pixelated}
.boot .lane .zw{background-image:${u("loading/loading_zombie_walk.png")};background-size:384px 64px;width:64px;height:64px;bottom:22px;margin-left:-32px}
.boot .cf{right:-40px;background-image:${u("loading/loading_campfire.png")};animation:bootsheet .6s steps(6) infinite}
@keyframes bootsheet{to{background-position:-384px 0}}.boot[data-boot=menu] .zw,.boot[data-boot=menu] .cf{display:none}
@media (prefers-reduced-motion:reduce){.boot .cf{animation:none}}`;
  return c;
}

/** ADR-236 Multiplayer page inputs from main.ts. */
export interface MultiplayerPageOpts { /** e.g. "12" (or "6 (mobile)") */ hostCap?: string; /** test hook: resolve RTT ms or reject */ probe?: (url: string) => Promise<number> }
/** Reachability + ping of a dedicated server: time to open (then close) a WebSocket. */
export function probeServer(url: string, timeoutMs = 4000, Ws: typeof WebSocket = WebSocket): Promise<number> {
  return new Promise((ok, fail) => {
    if (!/^wss?:\/\/./i.test(url)) { fail(new Error("address must start with ws:// or wss://")); return; }
    if (typeof location !== "undefined" && location.protocol === "https:" && /^ws:/i.test(url)) { fail(new Error("https pages need wss://")); return; }
    const t0 = performance.now(); let ws: WebSocket;
    try { ws = new Ws(url); } catch (e) { fail(e instanceof Error ? e : new Error(String(e))); return; }
    const done = (err?: Error): void => { clearTimeout(timer); ws.onopen = ws.onerror = null; try { ws.close(); } catch { /* ignore */ } if (err) fail(err); else ok(performance.now() - t0); };
    const timer = setTimeout(() => done(new Error("timed out")), timeoutMs);
    ws.onopen = () => done(); ws.onerror = () => done(new Error(""));
  });
}
function mpButton(text: string, action: string, fn: () => void): HTMLButtonElement { const b = document.createElement("button"); b.type = "button"; b.setAttribute("role", "menuitem"); b.dataset["action"] = action; b.textContent = text; b.addEventListener("click", fn); return b; }
function mpInput(role: string, label: string, placeholder: string): HTMLInputElement {
  const i = document.createElement("input"); i.dataset["role"] = role; i.setAttribute("aria-label", label); i.placeholder = placeholder; i.autocomplete = "off"; i.spellcheck = false;
  // Task 20: tapping a menu text field leaves fullscreen so the phone IME can draw (room-code /
  // server-url are the enter-game box the user hit after Enter world).
  bindTypingFullscreenExit(i); return i;
}
function mpRow(...els: HTMLElement[]): HTMLElement { const r = document.createElement("div"); r.className = "mp-row"; r.append(...els); return r; }
function mpSection(title: string, help: string, ...body: HTMLElement[]): HTMLElement {
  const s = document.createElement("section"); s.className = "mp-sec"; s.dataset["section"] = title.toLowerCase().split(" ")[0]!;
  const h = document.createElement("h3"); h.textContent = title; s.append(h);
  if (help) { const p = document.createElement("p"); p.innerHTML = help; s.append(p); }
  s.append(...body); return s;
}

export class BootUI {
  readonly root = document.createElement("div");
  private fill = document.createElement("div");
  private lbl = document.createElement("div");
  /** Task 14: gameplay tip line, rotating on loading screens only (not the menu). */
  private tip = document.createElement("p");
  private tipIdx = 0;
  private tipTimer = 0;
  private hideGen = 0;
  private lane = document.createElement("div");
  private header = document.createElement("div");
  private body = document.createElement("div");
  private zw = document.createElement("div");
  private padTimer = 0; private padGen = 0;
  private keyHandler: ((e: KeyboardEvent) => void) | undefined;
  private back: (() => void) | undefined;
  private readonly history = new BackHistory(() => { this.back?.(); });

  constructor(private readonly base: string) {
    const st = document.createElement("style"); st.textContent = CSS(base); document.head.append(st);
    this.root.className = "boot"; this.root.dataset["boot"] = "loading";
    // Version marker, top-left of the main menu: the build hash stamped by Vite (GITHUB_SHA on CI, else the local
    // git short hash, "dev" in tests). The repo has no semantic version (package.json is 0.0.0 everywhere), so the
    // commit hash is the version that actually identifies a deployed build.
    const ver = document.createElement("div"); ver.className = "version"; ver.dataset["role"] = "version"; ver.textContent = `v${BUILD_HASH}`;
    this.root.append(ver);
    const esc = (t: string): string => t.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
    this.header.innerHTML = `<div class="title">${esc(BR.title)}<small>${esc(BR.tagline.toUpperCase())}</small></div>`;
    document.title = BR.title;
    if (BR.bg === "parallax") ["sky", "far", "near", "fireflies", "vignette"].forEach((l, i) => { const d = document.createElement("div"); d.className = "px"; d.style.backgroundImage = `url(${base}art/ui/branding/background/parallax/menu_bg_${l}.png)`; d.style.setProperty("--d", String([0, 0.15, 0.35, 0.6, 0][i])); this.root.append(d); });
    const track = document.createElement("div"); track.className = "track"; this.fill.className = "fill"; track.append(this.fill);
    this.lane.className = "lane"; this.zw.className = "zw"; this.zw.dataset["role"] = "loading-zombie"; this.lane.append(track, this.zw);
    if (BR.loadingAnim) { const cf = document.createElement("div"); cf.className = "cf"; track.append(cf); }
    track.setAttribute("role", "progressbar"); track.setAttribute("aria-valuemin", "0"); track.setAttribute("aria-valuemax", "100"); this.track = track;
    this.lbl.className = "lbl"; this.lbl.setAttribute("aria-live", "polite");
    this.tip.className = "tip"; this.tip.dataset["role"] = "tip"; this.tip.textContent = localizeTemps(TIPS[0]!);
    this.body.append(this.lane, this.lbl, this.tip);
    this.tipsOn(true);
    try { this.bar.reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { /* old browsers */ }
    this.root.append(this.header, this.body); mountUi(this.root);
    void this.loadLogo();
  }
  /** Art's logo (assets/ui/branding/logo.png|webp|svg) replaces the text title when it exists. */
  private async loadLogo(): Promise<void> {
    if (!BR.logo) return;
    try { const img = new Image(); img.className = "logo"; img.alt = BR.title; img.src = `${this.base}art/ui/branding/${BR.logo}`; await img.decode(); this.header.replaceChildren(img); } catch { /* keep text title */ }
  }
  private track: HTMLElement | undefined;
  private readonly bar = new EasedBar();
  private raf = 0; private lastT = 0; private finishWaiters: (() => void)[] = [];
  /** Target progress (0..1, ADR-118): the fill eases toward it, never backwards; the zombie walks on the fill edge. */
  progress(f: number, label: string): void {
    if (this.root.dataset["boot"] === "error") return;
    this.bar.set(f); this.lbl.textContent = label; this.kick();
  }
  /** Ease to 100% then resolve (capped so a hidden tab or slow frame never blocks the hand-off). */
  finish(label = "Ready"): Promise<void> {
    this.progress(1, label);
    return new Promise((ok) => { if (this.bar.done) { ok(); return; } this.finishWaiters.push(ok); setTimeout(() => { this.bar.reducedMotion = true; this.paint(0); }, 1200); });
  }
  /** Error state: stop the walk, red bar, message stays (the caller decides whether boot continues). */
  fail(message: string): void { this.root.dataset["boot"] = "error"; this.lbl.textContent = message; this.paint(0); }
  /** Task 14: tip rotation on loading screens (Task 16: every TIP_ROTATION_MS); off on the menu and once hidden. */
  private tipsOn(on: boolean): void {
    if (this.tipTimer) { clearInterval(this.tipTimer); this.tipTimer = 0; }
    this.tip.style.display = on ? "" : "none";
    if (on) this.tipTimer = window.setInterval(() => { this.tipIdx = nextTip(this.tipIdx); this.tip.textContent = localizeTemps(TIPS[this.tipIdx]!); }, TIP_ROTATION_MS);
  }
  /**
   * Task 14: the SECOND loading screen, same visual style as the first, shown after the player picks a game
   * mode and kept up until the world is fully loaded (see ready.ts). Reuses this instance after hide(): the
   * bar resets, the pending hide-removal is cancelled, and the root is re-mounted if it was already removed.
   */
  showLoading(label = "Loading world…"): void {
    this.cleanup?.(); this.cleanup = undefined;
    if (this.keyHandler) { removeEventListener("keydown", this.keyHandler); removeEventListener("keyup", this.keyHandler); this.keyHandler = undefined; }
    this.hideGen++; // cancel a pending hide() removal so it cannot take this screen down later
    this.root.classList.remove("hide");
    this.root.dataset["boot"] = "loading";
    this.bar.reset();
    this.lbl.textContent = label;
    this.body.replaceChildren(this.lane, this.lbl, this.tip); // back to the loading layout (menu() replaced it)
    this.tipsOn(true);
    if (!this.root.isConnected) mountUi(this.root);
    this.kick();
  }
  private kick(): void {
    if (this.raf) return;
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number;
    const tick = (t: number): void => { const dt = this.lastT ? (t - this.lastT) / 1000 : 1 / 60; this.lastT = t; this.raf = 0; if (this.paint(dt)) this.raf = raf(tick); else this.lastT = 0; };
    this.raf = raf(tick);
  }
  /** One frame; returns true while still animating. */
  private paint(dt: number): boolean {
    const before = this.bar.shown; const v = this.bar.step(dt); const moving = v > before && this.root.dataset["boot"] !== "error";
    const pc = `${(v * 100).toFixed(2)}%`; this.fill.style.width = pc; this.zw.style.left = pc;
    this.track?.setAttribute("aria-valuenow", String(Math.round(v * 100)));
    const pose = zombiePose(performance.now() / 1000, moving, this.bar.reducedMotion);
    this.zw.style.transform = `translateY(${pose.bob.toFixed(1)}px)`;
    if (BR.loadingAnim) this.zw.style.backgroundPosition = `${-64 * pose.frame}px 0`;
    if (this.bar.done) { const w = this.finishWaiters; this.finishWaiters = []; for (const f of w) f(); }
    return v < this.bar.goal || (moving && !this.bar.done);
  }

  /** Main menu; resolves with the player's choice. */
  /** notice: shown once on the main screen (e.g. "Host ended the session"), hook `.boot [data-role=notice]`. */
  /** slot: ?player slot whose browser saves "Manage saves" deletes (ADR-099). */
  /** page: open straight on a sub-page (ADR-236: a multiplayer session ending returns to the Multiplayer page). */
  menu(opts: { hostedStatic: boolean; defaultUrl: string; notice?: string; slot?: string; page?: "multiplayer"; mp?: MultiplayerPageOpts; savedSeed?: (mode: "singleplayer" | "host") => Promise<number | undefined>; initialSeed?: string }): Promise<MenuChoice> {
    this.tipsOn(false); // the menu is not a loading screen
    this.root.dataset["boot"] = "menu";
    return new Promise((resolve) => {
      // Task 18: shrink the fixed menu above the phone keyboard while it is open
      // (the Multiplayer page's room-code / server-url inputs sit in .boot .panel,
      // which subtracts --kb-inset); uninstalled when the choice resolves, so
      // the loading screens that reuse this root are untouched.
      const kbWin = this.root.ownerDocument.defaultView;
      const uninstallKb = kbWin ? installKeyboardViewport(this.root, kbWin) : undefined;
      const finish = (c: MenuChoice): void => { uninstallKb?.(); resolve(c); };
      let notice = opts.notice;
      // This resolves before main.ts opens the character creator; no world exists yet.
      const localWorld = async (kind: "singleplayer" | "host", back: () => void): Promise<void> => {
        if (!opts.savedSeed) { enterFullscreen(); finish({ kind }); return; }
        const status = document.createElement("p"); status.textContent = "Checking for an existing world…";
        this.screen([["Back", back, "alt"]], back, "<h2>World</h2>", status);
        try {
          const saved = await opts.savedSeed(kind);
          if (!status.isConnected) return; // Back was pressed during the store read
          if (saved !== undefined) { enterFullscreen(); finish({ kind }); return; }
        } catch (e) {
          status.textContent = `Couldn't read the world: ${e instanceof Error ? e.message : String(e)}`; return;
        }
        let generated = randomWorldSeed();
        const seed = mpInput("world-seed", "World seed", "Blank = random"); seed.inputMode = "numeric"; seed.id = "boot-world-seed";
        seed.value = opts.initialSeed ?? String(generated); seed.dataset["autofocus"] = "1";
        const label = document.createElement("label"); label.textContent = "World seed (0–4294967295)"; label.htmlFor = seed.id;
        const chosen = document.createElement("p"); chosen.dataset["role"] = "chosen-seed"; chosen.setAttribute("aria-live", "polite");
        const preview = document.createElement("img"); preview.className = "world-preview"; preview.dataset["role"] = "world-preview";
        preview.alt = "Seeded terrain preview: blue water, green lowlands, shaded hills and cliffs";
        const note = document.createElement("p"); note.className = "preview-note"; note.textContent = "Starter region · 512 × 512 tiles · North ↑. Shading shows relief. World streams beyond this view.";
        let previewTimer = 0;
        const draw = (value: number): void => {
          preview.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(worldPreviewSvg(sampleWorldPreview(value)))}`;
          preview.dataset["seed"] = String(value); preview.setAttribute("aria-busy", "false");
        };
        const update = (): void => {
          const value = parseWorldSeed(seed.value, generated); clearTimeout(previewTimer);
          chosen.textContent = value === undefined ? "Enter a whole number from 0 to 4294967295." : `World seed: ${value} · Keep this number to replay this world.`;
          preview.hidden = value === undefined; preview.setAttribute("aria-busy", String(value !== undefined));
          if (value !== undefined) previewTimer = window.setTimeout(() => draw(value), 100);
        };
        seed.addEventListener("input", update); update();
        const next = (): void => { const value = parseWorldSeed(seed.value, generated); if (value === undefined) { seed.focus(); return; } enterFullscreen(); finish({ kind, seed: value }); };
        const random = mpButton("Random", "random-seed", () => { generated = randomWorldSeed(); seed.value = String(generated); update(); });
        seed.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); next(); } });
        const footer = document.createElement("div"); footer.className = "sticky-footer"; footer.dataset["role"] = "sticky-footer";
        this.screen([["Create world", next], ["Back", back, "alt"]], back, "<h2>New world</h2>", label, mpRow(seed, random), preview, note, chosen, footer);
        this.root.dataset["page"] = "world-seed";
        this.cleanup = () => { clearTimeout(previewTimer); delete this.root.dataset["page"]; };
      };
      const main = (): void => {
        const extra: HTMLElement[] = [];
        if (notice) { const n = document.createElement("p"); n.dataset["role"] = "notice"; n.setAttribute("role", "status"); n.textContent = notice; extra.push(n); notice = undefined; }
        this.screen([
          ["Singleplayer", () => { void localWorld("singleplayer", main); }],
          ["Multiplayer", multi],
          ["Delete progress", saves, "alt"],
          ["Settings", settings, "alt"],
        ], undefined, `<div class="hint">Mouse / touch · arrows + Enter · gamepad D-pad + A</div>`, ...extra);
      };
      // ADR-236: one Multiplayer page holds everything the old in-game connect / P2P boxes did: host, join a room code,
      // dedicated server address + live reachability/ping, and why the last session ended. In-game only Pause → Session
      // and a tiny problem-only indicator remain. One focus column (D-pad / arrows / Tab), A or Enter on a field types,
      // Enter in a field submits its own row, B / Esc = Back.
      const multi = (): void => {
        const mp = opts.mp ?? {};
        const extra: HTMLElement[] = [];
        if (notice) { const n = document.createElement("p"); n.dataset["role"] = "notice"; n.setAttribute("role", "status"); n.textContent = notice; extra.push(n); notice = undefined; }
        const go = (c: MenuChoice): void => { enterFullscreen(); finish(c); };
        const host = mpButton("Host game", "mp-host", () => { void localWorld("host", multi); }); host.dataset["autofocus"] = "1";
        extra.push(mpSection("Host", `Run the world in this browser${mp.hostCap ? ` · up to ${mp.hostCap} players` : ""}. The room code is in Pause → Session.`, host));
        const code = mpInput("room-code", "Room code", "ABC-234"); code.maxLength = 7; code.autocapitalize = "characters"; code.style.textTransform = "uppercase";
        const join = mpButton("Join", "mp-join", () => { const c = code.value.trim(); if (!c) { code.focus(); return; } go({ kind: "join", code: c }); });
        extra.push(mpSection("Join a friend", "", mpRow(code, join)));
        const url = mpInput("server-url", "Server URL", "wss://your-server:7777"); url.value = localStorage.getItem("engine-server-url") ?? opts.defaultUrl;
        const connect = mpButton("Connect", "mp-connect", () => { const u = url.value.trim(); if (!u) { url.focus(); return; } localStorage.setItem("engine-server-url", u); go({ kind: "multiplayer", url: u }); });
        const st = document.createElement("p"); st.dataset["role"] = "server-status"; st.setAttribute("aria-live", "polite"); st.className = "mp-status";
        const help = opts.hostedStatic ? "This web build can't run a server: run <code>pnpm --filter @engine/server start</code> somewhere and enter its <code>wss://</code> address." : "";
        extra.push(mpSection("Dedicated server", help, mpRow(url, connect), st));
        for (const [i, b] of [[code, join], [url, connect]] as const) i.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); b.click(); } });
        const foot = document.createElement("p"); foot.className = "mp-foot"; foot.textContent = loadSettings().aiHumans !== false ? "AI humans are on in multiplayer: they can be hired to work for you." : "AI humans are off in multiplayer (Settings)."; extra.push(foot);
        this.screen([["Back", main, "alt"]], main, `<h2>Multiplayer</h2>`, ...extra);
        this.root.dataset["page"] = "multiplayer";
        // reachability + ping of the typed address (re-checked as it changes)
        const probe = mp.probe ?? probeServer; let gen = 0, timer = 0;
        const check = (): void => { const u = url.value.trim(); const g = ++gen; if (!u) { st.textContent = ""; return; }
          st.dataset["state"] = "checking"; st.textContent = "Checking server…";
          probe(u).then((ms) => { if (g !== gen || !st.isConnected) return; st.dataset["state"] = "online"; st.textContent = `● Online · ${Math.round(ms)} ms`; },
            (e: unknown) => { if (g !== gen || !st.isConnected) return; st.dataset["state"] = "offline"; st.textContent = `● Can't reach server${e instanceof Error && e.message ? ` (${e.message})` : ""}`; }); };
        url.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(check, 600) as unknown as number; });
        this.cleanup = () => { gen++; clearTimeout(timer); delete this.root.dataset["page"]; };
        check();
      };
      const settings = (): void => {
        const s = loadSettings();
        const bots = document.createElement("input"); bots.type = "number"; bots.min = "0"; bots.max = "12"; bots.value = String(s.bots); bots.style.width = "70px"; bindTypingFullscreenExit(bots);
        const hud = document.createElement("input"); hud.type = "checkbox"; hud.checked = s.showHud;
        const l1 = document.createElement("label"); l1.append("Human bots", bots);
        const ah = document.createElement("input"); ah.type = "checkbox"; ah.checked = s.aiHumans !== false; ah.dataset["setting"] = "aiHumans";
        const l1b = document.createElement("label"); l1b.append("AI humans in multiplayer (new worlds)", ah);
        const l2 = document.createElement("label"); l2.append("Show HUD", hud);
        const fs = document.createElement("input"); fs.type = "checkbox"; fs.checked = s.fullscreen;
        const l3 = document.createElement("label"); l3.append("Fullscreen when playing", fs);
        const cap = document.createElement("input"); cap.type = "number"; cap.min = "2"; cap.max = "32"; cap.value = String(s.hostCap); cap.style.width = "70px"; bindTypingFullscreenExit(cap);
        const l4 = document.createElement("label"); l4.append("Max players when hosting (desktop)", cap);
        const hz = document.createElement("input"); hz.type = "checkbox"; hz.checked = s.hordes !== false; hz.dataset["setting"] = "hordes";
        const l5 = document.createElement("label"); l5.append("Roaming zombie hordes (new worlds)", hz);
        const gd = document.createElement("input"); gd.type = "number"; gd.min = "0"; gd.max = "30"; gd.step = "0.5"; gd.value = String(s.hordeGraceDays ?? 3); gd.style.width = "70px"; gd.dataset["setting"] = "hordeGraceDays"; bindTypingFullscreenExit(gd);
        const l6 = document.createElement("label"); l6.append("Horde grace period (in-game days)", gd);
        const tu = tempUnitControl(s); const l7 = tu.el; // ADR-243: near the top, gamepad/touch toggle
        const manage = document.createElement("button"); manage.className = "alt"; manage.textContent = "Delete progress…"; manage.dataset["action"] = "manage-saves"; manage.addEventListener("click", saves);
        const save = (): void => { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as object), bots: Math.max(0, Math.min(12, Number(bots.value) || 0)), showHud: hud.checked, fullscreen: fs.checked, hordes: hz.checked, hordeGraceDays: Math.max(0, Math.min(30, Number(gd.value) || 0)), aiHumans: ah.checked, hostCap: Math.max(2, Math.min(32, Math.round(Number(cap.value)) || 12)), ...tu.patch() })); main(); };
        this.screen([["Save", save], ["Back", main, "alt"]], main, `<h2>Settings</h2>`, l7, l1, l1b, l2, l3, l4, l5, l6, manage);
      };
      // Delete progress (ADR-099): pick what to delete from this device, then type DELETE or hold to confirm.
      const slot = opts.slot ?? "1";
      const saves = (): void => {
        const box = document.createElement("div"); box.dataset["role"] = "save-picker"; box.style.cssText = "display:flex;flex-direction:column;gap:6px";
        const status = document.createElement("p"); status.textContent = "Looking for saves on this device…"; box.append(status);
        const note = document.createElement("p"); note.className = "hint-note"; note.textContent = "Dedicated-server progress isn't stored on this device: delete it in-game from Settings → Delete my progress while connected to that server.";
        const boxes = new Map<LocalSaveKind, HTMLInputElement>();
        const all = document.createElement("input"); all.type = "checkbox"; all.dataset["save"] = "everything";
        const allL = document.createElement("label"); allL.append(all, " Delete everything (also forgets this device's player identity)");
        all.addEventListener("change", () => { for (const b of boxes.values()) b.checked = all.checked; c.refresh(); });
        // Sticky footer (always visible while the picker scrolls): Back + Delete + Hold to delete.
        const footer = document.createElement("div"); footer.dataset["role"] = "sticky-footer"; footer.className = "sticky-footer";
        const picked = (): boolean => all.checked || [...boxes.values()].some((b) => b.checked);
        const c = deleteConfirm({ message: "Pick what to delete above. This can't be undone.", settingsOption: false, onCancel: main, actions: footer, canConfirm: picked,
          onConfirm: async () => {
            const kinds = new Set([...boxes].filter(([, b]) => b.checked).map(([k]) => k));
            const r = await deleteLocalProgress({ slot, kinds, everything: all.checked }); if (!r.ok) throw new Error(r.message);
            setTimeout(() => { if (this.root.dataset["boot"] === "menu") saves(); }, 1500); // refresh the list
            return r.message;
          } });
        c.el.style.maxHeight = "none"; c.el.style.overflow = "visible"; // the panel scrolls, not a nested box
        this.screen([["Back", main, "alt"]], main, `<h2>Delete progress</h2>`, box, note, c.el, footer);
        this.cleanup = () => c.destroy();
        void listLocalSaves({ slot }).then((list) => {
          if (!box.isConnected) return;
          const rows = list.map((s) => {
            const cb = document.createElement("input"); cb.type = "checkbox"; cb.dataset["save"] = s.kind; boxes.set(s.kind, cb);
            cb.addEventListener("change", () => { if (!cb.checked) all.checked = false; c.refresh(); });
            const l = document.createElement("label"); const d = document.createElement("small"); d.textContent = ` — ${s.detail}`;
            l.append(cb, ` ${s.label}`, d); if (!s.present) l.style.opacity = "0.6"; return l;
          });
          status.remove(); box.append(...rows, allL);
          (rows[0]?.querySelector("input") as HTMLInputElement | null)?.focus();
        }, (e: unknown) => { status.textContent = `Couldn't read saves: ${e instanceof Error ? e.message : String(e)}`; });
      };
      if (opts.page === "multiplayer") multi(); else main();
    });
  }
  private cleanup: (() => void) | undefined;

  private screen(items: [string, () => void, string?][], back: (() => void) | undefined, html = "", ...extra: HTMLElement[]): void {
    this.back = back; this.cleanup?.(); this.cleanup = undefined;
    this.history.sync(!!back); // Android/browser back = this screen's Back (ADR-107)
    const panel = document.createElement("div"); panel.className = "panel"; panel.setAttribute("role", "menu");
    if (html) { const h = document.createElement("div"); h.style.cssText = "display:flex;flex-direction:column;gap:8px"; h.innerHTML = html; if (h.querySelector(".hint")) { h.remove(); } else panel.append(h); }
    panel.append(...extra);
    const buttons = items.map(([t, fn, cls]) => { const b = document.createElement("button"); b.setAttribute("role", "menuitem"); if (cls) b.className = cls;
      const k = KEYS[t]; if (BR.plates && k) { b.classList.add(`k-${k}`); if (!extra.length && !html.includes("<h2")) panel.classList.add("art"); }
      if (BR.icons && k && (t === "Singleplayer" || t === "Multiplayer" || t === "Settings")) { const ic = new Image(); ic.src = `${this.base}art/ui/branding/buttons/icons/ic_menu_${k}.png`; ic.alt = ""; b.append(ic); }
      b.append(t); b.addEventListener("click", fn); return b; });
    const footer = extra.find((e) => e.dataset["role"] === "sticky-footer");
    if (footer) { footer.prepend(...buttons); panel.classList.add("ui-scroll", "has-footer"); } else panel.append(...buttons);
    const nodes: HTMLElement[] = [panel]; if (html.includes("hint")) { const h = document.createElement("div"); h.className = "hint"; h.textContent = "Mouse / touch · arrows + Enter · gamepad D-pad + A"; nodes.push(h); }
    this.body.replaceChildren(...nodes);
    const focusables = (): HTMLElement[] => Array.from(panel.querySelectorAll<HTMLElement>("input:not(:disabled),button:not(:disabled)"));
    let idx = focusables().indexOf(panel.querySelector<HTMLElement>("[data-autofocus]") ?? buttons[0]!); const focus = (i: number): void => { const f = focusables(); if (!f.length) return; idx = (i + f.length) % f.length; focusVisible(f[idx]); };
    panel.addEventListener("focusin", (e) => { const i = focusables().indexOf(e.target as HTMLElement); if (i >= 0) idx = i; }); // content added later (save picker)
    focus(idx);
    if (this.keyHandler) { removeEventListener("keydown", this.keyHandler); removeEventListener("keyup", this.keyHandler); }
    this.keyHandler = (e: KeyboardEvent): void => {
      // ADR-213: Edge on Xbox delivers the controller as GamepadDPadDown / keyCode 204 / GamepadA... keys
      const pk = padKeyEdge(e); if (pk !== undefined) { if (!isTyping(e.target)) e.preventDefault(); if (pk) padDo(pk); return; }
      if (e.type !== "keydown") return;
      const typing = (document.activeElement as HTMLElement | null)?.tagName === "INPUT" && (document.activeElement as HTMLInputElement).type !== "checkbox";
      if (e.key === "ArrowDown" || (!typing && (e.key === "s" || e.key === "S"))) { focus(idx + 1); e.preventDefault(); }
      else if (e.key === "ArrowUp" || (!typing && (e.key === "w" || e.key === "W"))) { focus(idx - 1); e.preventDefault(); }
      else if (e.key === "Escape" && this.back) { this.back(); e.preventDefault(); }
      else if (e.key === "Enter" && e.target instanceof HTMLInputElement && e.target.type === "checkbox") { e.target.click(); e.preventDefault(); }
      else if (e.key === "Enter" && typing && buttons[0]) { buttons[0].click(); e.preventDefault(); }
    };
    const padDo = (c: PadControl): void => {
      traceAction(`boot ${c}`); markNavFocus();
      if (c === "DOWN" || c === "RIGHT") focus(idx + 1); else if (c === "UP" || c === "LEFT") focus(idx - 1);
      else if (c === "A") { const f = focusables()[idx]; if (f instanceof HTMLInputElement && f.type !== "checkbox") focusVisible(f); else f?.click(); }
      else if (c === "B") this.back?.();
    };
    addEventListener("keydown", this.keyHandler); addEventListener("keyup", this.keyHandler);
    cancelAnimationFrame(this.padTimer); const gen = ++this.padGen;
    // ADR-213: every connected pad merged (an idle pad at index 0 hid the real one), mapping "" normalised, stick + D-pad with repeat
    const edges = new PadEdges(["UP", "DOWN", "A", "B"]); edges.hold(navPad());
    const poll = (): void => {
      if (gen !== this.padGen) return; // a click inside this poll re-rendered / hid the menu: never keep a stale loop alive
      for (const c of edges.step(navPad(), performance.now())) { padDo(c); if (gen !== this.padGen) return; }
      if (gen !== this.padGen) return;
      this.padTimer = requestAnimationFrame(poll);
    };
    this.padTimer = requestAnimationFrame(poll);
  }

  hide(): void {
    this.cleanup?.(); this.cleanup = undefined;
    cancelAnimationFrame(this.padTimer); this.padGen++; if (this.keyHandler) { removeEventListener("keydown", this.keyHandler); removeEventListener("keyup", this.keyHandler); }
    this.history.sync(false); this.history.destroy();
    this.tipsOn(false);
    this.root.classList.add("hide"); this.root.dataset["boot"] = "done";
    const g = ++this.hideGen; setTimeout(() => { if (g === this.hideGen) this.root.remove(); }, 400);
  }
}
