/**
 * In-game menus on the shared focus layer (./ui-nav.ts): pause (general menus + "Quit to main menu"), inventory,
 * crafting, build, character (details), wardrobe, party, clan, trade stalls, chat, settings, guide (ADR-363) and session (P2P). Each is a modal
 * shell with stable hooks for Gameplay/Art to fill: `.gm-modal[data-modal=<id>]`, `[data-role=body]`, `[data-role=close]`.
 * Touch: general menus live in the top-right bar; health opens character, world Interact opens furniture/stalls.
 * Keyboard hotkeys (no text field focused): Esc pause, I/Tab inventory, C crafting, B build, K character, P party,
 * L clan, J skills, Enter or / chat, O settings. Gamepad: Start pause, LB+RS character, D-pad/stick + A/B inside menus.
 */
import { deleteConfirm } from "./delete-progress.js";
import { bindTypingFullscreenExit } from "./fullscreen.js";
import { errorLog } from "./error-log.js";
import { UINav, type ContextStack } from "./ui-nav.js";
import { loadSettings, saveSettings, tempUnitControl } from "./menu.js";
import { morph } from "./ui-diff.js";
import { audioSettingsRows, type AudioControls } from "./audio/settings-ui.js";
import { fxSettingsRows, type FxControls } from "./fx/settings-ui.js";
import { GAMEPLAY_PANELS, gameplayBody, pageContainer, pageSkillCategory, type GameplayPanel, type GameplaySource } from "./gameplay-panels.js";
import { buildGuidePanel } from "./guide-panel.js";
import { iconImg, isIconFile } from "./game-icons.js";
import { GUIDE_BOOK_ICON_FILE } from "./guide-art.js";
import { closeContainerIntent, onlineTargets, openContainerIntent, openStallIntent, isPetOwner, Pet, Viewing } from "@engine/gameplay";
import { DEFAULT_QUALITY_PRESET, loadPreset, parsePreset, savePreset, QUALITY_PRESETS, type QualityPreset } from "@engine/render";

/** `data-chan` value per @engine/net ChatChannel number (Global 0 … System 6); omitted/unknown = "system". */
export const CHAT_CHAN_NAMES: Readonly<Record<number, string>> = { 0: "global", 1: "local", 2: "party", 3: "clan", 4: "trade", 5: "whisper", 6: "system" };
/** Contextual panels are absent from pause: world Interact opens furniture/stalls; the health cluster opens character. */
export const CONTEXT_ONLY_MENUS: ReadonlySet<string> = new Set(["station", "camper", "character", "wardrobe", "trade", "mount"]);
export interface MenuDef { id: string; title: string; icon: string; hotkeys: string[]; bar?: boolean; text: string }
export const GAME_MENUS: readonly MenuDef[] = [
  { id: "inventory", title: "Inventory", icon: "ic_backpack.png", hotkeys: ["KeyI", "Tab"], bar: true, text: "Your items and equipment." },
  { id: "crafting", title: "Crafting", icon: "ic_hammer.png", hotkeys: ["KeyC"], bar: true, text: "Recipes you can craft by hand. More recipes at stations." },
  { id: "station", title: "Crafting Station", icon: "ic_anvil.png", hotkeys: [], text: "Recipes made at this station." },
  { id: "build", title: "Build", icon: "ic_build.png", hotkeys: ["KeyB"], bar: true, text: "Pick a piece to place." },
  { id: "character", title: "Character", icon: "ic_shirt.png", hotkeys: ["KeyK"], text: "Your vitals, temperature, diseases and insulation." },
  { id: "wardrobe", title: "Wardrobe", icon: "ic_shirt.png", hotkeys: [], text: "Change your look at a wardrobe." },
  { id: "party", title: "Party", icon: "ic_people.png", hotkeys: ["KeyP"], bar: true, text: "Your party: invite, kick or leave." },
  { id: "clan", title: "Clan", icon: "ic_shield.png", hotkeys: ["KeyL"], text: "Clan members, ranks and goals." },
  { id: "trade", title: "Trade stalls", icon: "ic_scales.png", hotkeys: [], text: "Browse and run trade stalls." },
  { id: "skills", title: "Skills", icon: "ic_star.png", hotkeys: ["KeyJ"], bar: true, text: "Each skill tree levels from its own activities; spend its points there (ADR-209)." },
  { id: "camper", title: "Camper Station", icon: "ic_camper.png", hotkeys: [], text: "Craft, cook, refuel and use storage inside a parked camper." },
  { id: "pet", title: "Pets", icon: "ic_paw.png", hotkeys: ["KeyY"], text: "Tame, feed and command your pets (ADR-145)." },
  { id: "mount", title: "Mount", icon: "ic_paw.png", hotkeys: [], text: "Ride, saddle, feed or tame a mount (ADR-319). Opens with U / pad LB+X / touch Mount near one." },
  { id: "worker", title: "AI Humans", icon: "ic_farmer.png", hotkeys: [], text: "Hire AI humans to work for you (Task 22)." },
  { id: "map", title: "World Map", icon: "ic_map.png", hotkeys: ["KeyM"], bar: true, text: "Your location, facing and markers. Tap a spot to place a marker." },
  { id: "chat", title: "Chat", icon: "ic_chat.png", hotkeys: ["Enter", "Slash"], bar: true, text: "" },
  { id: "settings", title: "Settings", icon: "⚙", hotkeys: ["KeyO"], text: "" },
  { id: "guide", title: "Guide", icon: GUIDE_BOOK_ICON_FILE, hotkeys: [], text: "How everything in SurVivaZ works — controls, diseases, temperature, building, AI humans, animals and more." },
];
const CSS = `.gm-modal{position:absolute;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;background:rgba(10,8,6,.55);
padding:calc(8px + var(--sat,0px)) calc(8px + var(--sar,0px)) calc(8px + var(--sab,0px)) calc(8px + var(--sal,0px));box-sizing:border-box;pointer-events:auto;touch-action:pan-y}
.gm-panel{background:#F6EAD2;color:#3B2433;border:3px solid #74432C;border-radius:14px;box-shadow:0 4px 0 #432C24;max-width:min(560px,94vw);max-height:100%;max-height:calc(100dvh - var(--sat,0px) - var(--sab,0px) - 16px);overflow-y:auto;-webkit-overflow-scrolling:touch;touch-action:pan-y;overscroll-behavior:contain;
padding:12px 14px;display:flex;flex-direction:column;gap:10px;font:600 15px Fredoka,system-ui,sans-serif;box-sizing:border-box;min-width:min(300px,90vw)}
.gm-panel header{display:flex;align-items:center;justify-content:space-between;gap:8px}.gm-panel h2{margin:0;font-size:20px;color:#74432C}
.gm-panel p{margin:0;font-size:14px}.gm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px}
.gm-panel button,.gm-panel input,.gm-panel select{font:700 16px Fredoka,system-ui,sans-serif;min-height:44px;min-width:44px;border-radius:10px;box-sizing:border-box}
.gm-panel button{color:#FFFAF0;background:#5A9A4A;border:3px solid #3B2433;box-shadow:0 3px 0 #2D5A2E;padding:6px 12px;cursor:pointer}
.gm-panel button.alt{background:#C98A4B;box-shadow:0 3px 0 #74432C}
.gm-panel input{border:3px solid #4A2F3D;background:#FFFAF0;color:#3B2433;padding:6px 10px}.gm-panel input[type=checkbox]{min-height:28px;min-width:28px}
.gm-panel label{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:15px}
.gm-panel :focus-visible,.gm-panel button:focus{outline:3px solid #FFD45A;outline-offset:2px}
.gm-panel .hint{font-size:12px;color:#61402E}
#game-menubar{position:absolute;top:calc(6px + var(--sat,0px));right:calc(6px + var(--sar,0px));z-index:12;display:flex;gap:6px;pointer-events:auto}
#game-menubar button{width:44px;height:44px;border-radius:12px;border:2px solid #3B2433;background:rgba(246,234,210,.9);font:20px system-ui,sans-serif;padding:0;touch-action:manipulation;cursor:pointer}
#game-menubar button:focus-visible{outline:3px solid #FFD45A}
#game-menubar .gm-more{display:none}
#game-menubar button[data-badge]{position:relative}#game-menubar button[data-badge]::after{content:attr(data-badge);position:absolute;top:-5px;right:-5px;min-width:16px;height:16px;padding:0 3px;box-sizing:border-box;border-radius:8px;background:#D9412B;color:#fff;font:700 11px/16px system-ui,sans-serif;pointer-events:none}
/* ADR-133: on phones (coarse pointer, short landscape) only the primary menus + "More" + Menu show; the rest fold behind More */
@media (pointer:coarse) and (max-height:500px),(max-width:700px){#game-menubar{gap:4px}#game-menubar button{width:44px;height:44px;font-size:18px;background:rgba(246,234,210,.72)}
#game-menubar .gm-more{display:block}#game-menubar:not([data-expanded=true]) .gm-secondary{display:none}}`;
/** Menu bar entries that stay visible on phones; the rest fold behind "More" (ADR-133). */
export const PRIMARY_BAR_MENUS: ReadonlySet<string> = new Set(["inventory", "build"]);

/** Sendable ChatChannel ids (@engine/net ChatChannel: Global 0, Local 1, Party 2, Clan 3, Trade 4). */
export const CHAT_CHANNELS: readonly [string, number][] = [["Local", 1], ["Global", 0], ["Party", 2], ["Clan", 3], ["Trade", 4], ["Whisper", 5]];

export interface GameMenusOptions {
  root: HTMLElement;
  /** ADR-117 audio mixer controls (Settings volume rows). */
  audio?: AudioControls;
  /** ADR-214 visual-effects settings rows. */
  fx?: FxControls;
  input?: ContextStack;
  /** "Quit to main menu": caller exits fullscreen and returns to the main menu. */
  onQuit: () => void;
  /** Session entry (P2P / dedicated): shown in the pause menu when set. */
  session?: () => SessionInfo | undefined;
  /** Chat send hook: main.ts wires it to NetClient.chat (core ChatServer). `channel` is a ChatChannel id. */
  onChat?: (text: string, channel: number, to?: number) => void;
  /** Real gameplay data + command sender for the inventory/crafting/build/character/party/clan/trade panels. */
  gameplay?: GameplaySource;
  /** World-map panel body (world-map.ts): built fresh on each open so its canvas loop starts with the panel. */
  mapBody?: () => Node[];
  /**
   * "Delete my progress" in Settings (ADR-099): what deleting means in the current mode (singleplayer save, or your
   * character on this server). `run` returns the message to show; throw to show an error. undefined = no entry.
   */
  /** Settings → Graphics quality (render preset, persisted by @engine/render): apply to the live renderer. */
  setQuality?: (p: QualityPreset) => void;
  /** ADR-116: the live renderer's quality controller (Auto label + detected tier). */
  /** ADR-121: the current world's rules (read-only in game; set for new worlds in the main menu Settings). */
  worldRules?: () => { hordes: boolean; hordeGraceDays: number; aiHumans: boolean } | undefined;
  qualityInfo?: () => { autoLabel(): string; detected?: { name: string; klass: string; remembered: boolean } | undefined } | undefined;
  deleteProgress?: () => { label: string; message: string; settingsOption: boolean; run: (o: { resetSettings: boolean }) => Promise<string> } | undefined;
  showMenuBar?: boolean;
  /** ADR-144 tutorial controls: "Play the guide again" in Pause + Settings; "Dismiss this tip" / "Turn off tips" while tips are on (ADR-275). */
  tutorial?: { active(): boolean; replay(): void; next(): void; skip(): void };
  getGamepads?: UINavOptions["getGamepads"];
  pollGamepads?: boolean;
}
type UINavOptions = ConstructorParameters<typeof UINav>[0];

export class GameMenus {
  readonly nav: UINav; readonly bar: HTMLElement | undefined; private chatLog: { text: string; chan: string }[] = []; private chatChannel = 1; private whisperTo = 0; private statusLine = "";
  constructor(private readonly o: GameMenusOptions) {
    if (!document.getElementById("gm-style")) { const st = document.createElement("style"); st.id = "gm-style"; st.textContent = CSS; document.head.append(st); }
    const hotkeys: Record<string, () => void> = {};
    for (const m of GAME_MENUS) for (const k of m.hotkeys) hotkeys[k] = () => this.toggle(m.id);
    this.nav = new UINav({ root: o.root, onPause: () => this.pause(), onPage: (d, kind) => { if (this.nav.top === "inventory" && pageContainer(d)) this.refresh(); else if (this.nav.top === "skills") { pageSkillCategory(d); this.refresh(); } else cycleTabs(this.nav, d, kind ?? "tab"); }, ...(o.input ? { input: o.input } : {}), hotkeys, ...(o.getGamepads ? { getGamepads: o.getGamepads } : {}), ...(o.pollGamepads !== undefined ? { pollGamepads: o.pollGamepads } : {}) });
    if (o.showMenuBar !== false) {
      const bar = document.createElement("nav"); bar.id = "game-menubar"; bar.setAttribute("aria-label", "Game menus");
      const add = (id: string, icon: string, title: string, fn: () => void): void => { const b = document.createElement("button"); b.type = "button"; b.dataset["open"] = id; b.dataset["tip"] = title; b.setAttribute("aria-label", title); if (isIconFile(icon)) b.append(iconImg(icon, 24, title)); else b.textContent = icon; b.addEventListener("click", (e) => { e.stopPropagation(); fn(); }); bar.append(b); };
      for (const m of GAME_MENUS) if (m.bar) { add(m.id, m.icon, m.title, () => { bar.dataset["expanded"] = "false"; this.toggle(m.id); }); if (!PRIMARY_BAR_MENUS.has(m.id)) bar.lastElementChild!.classList.add("gm-secondary"); }
      add("more", "⋯", "More menus", () => { const on = bar.dataset["expanded"] !== "true"; bar.dataset["expanded"] = String(on); (bar.querySelector('[data-open="more"]') as HTMLElement).setAttribute("aria-expanded", String(on)); });
      const more = bar.lastElementChild as HTMLElement; more.classList.add("gm-more"); more.setAttribute("aria-expanded", "false"); bar.insertBefore(more, bar.firstChild);
      add("pause", "☰", "Menu", () => this.pause());
      o.root.append(bar); this.bar = bar;
    }
  }
  destroy(): void { this.nav.destroy(); this.bar?.remove(); }

  private panel(id: string, title: string, body: Node[], buttons: [string, () => void, (string | undefined)?, (string | undefined)?][] = []): HTMLElement {
    const m = document.createElement("div"); m.className = "gm-modal";
    m.addEventListener("pointerdown", (e) => { if (e.target === m) this.nav.close(); }); // tap outside closes
    const p = document.createElement("div"); p.className = "gm-panel"; p.setAttribute("aria-label", title);
    const camper = id === "camper"; if (camper) { p.dataset["panel"] = "camper-station"; p.dataset["key"] = String(this.camperTarget ?? 0); }
    const h = document.createElement("header"); if (camper) h.dataset["role"] = "title"; const h2 = document.createElement("h2"); h2.textContent = title;
    const x = document.createElement("button"); x.type = "button"; x.className = "alt"; x.dataset["role"] = "close"; x.setAttribute("aria-label", `Close ${title}`); x.dataset["tip"] = "Close (B)"; if (camper) x.dataset["key"] = "close"; x.textContent = "✕"; x.addEventListener("click", () => this.nav.close());
    h.append(h2, x);
    const b = document.createElement("div"); b.dataset["role"] = "body"; if (!camper) b.style.cssText = "display:flex;flex-direction:column;gap:8px"; /* camper: grid areas from gameplay-panels.css */ b.append(...body);
    const actions = document.createElement("div"); actions.className = "gm-grid";
    for (const [t, fn, cls, icon] of buttons) { const bt = document.createElement("button"); bt.type = "button"; if (icon) bt.append(iconImg(icon, 20, t)); bt.append(document.createTextNode(t)); if (cls) bt.className = cls; bt.dataset["action"] = t; bt.addEventListener("click", fn); actions.append(bt); }
    p.append(h, b); if (buttons.length) p.append(actions);
    const hint = document.createElement("div"); hint.className = "hint"; hint.textContent = "Tap · Tab/arrows + Enter, Esc back · D-pad + A, B back"; p.append(hint);
    m.append(p); m.dataset["menu"] = id; return m;
  }
  /** ADR-198: Settings → Error log. Plain buttons in the modal, so ui-nav's focus layer makes them D-pad / A / B navigable. */
  private errorLogPanel(): HTMLElement {
    const log = errorLog(), entries = log.list();
    const pre = document.createElement("pre"); pre.dataset["role"] = "error-log";
    pre.style.cssText = "margin:0;max-height:45vh;overflow:auto;white-space:pre-wrap;word-break:break-word;font:12px/1.35 ui-monospace,monospace;background:#FFFAF0;border:2px solid #74432C;border-radius:8px;padding:8px";
    pre.textContent = entries.length ? [...entries].reverse().map((e) => `${new Date(e.t).toLocaleString()}  ${e.code}  ${e.kind}${e.count > 1 ? ` ×${e.count}` : ""}\n${e.message.split("\n").slice(0, 3).join("\n")}`).join("\n\n") : "No errors recorded. 🎉";
    const status = this.para(`${entries.length} entr${entries.length === 1 ? "y" : "ies"} · build ${entries[0]?.build ?? ""}`); status.dataset["role"] = "status";
    const copy = (): void => { const t = log.text(); const done = (ok: boolean): void => { status.textContent = ok ? "Copied — paste it into your bug report." : "Copy blocked — select the text above and copy it."; };
      try { void navigator.clipboard.writeText(t).then(() => done(true), () => done(false)); } catch { done(false); } };
    return this.panel("error-log", "Error log", [status, pre], [["Copy", copy], ["Clear", () => { log.clear(); this.nav.close(); }, "alt"], ["Back", () => this.nav.close(), "alt"]]);
  }
  private para(t: string): HTMLElement { const p = document.createElement("p"); p.textContent = t; return p; }

  /** ADR-172: unread / pending count on a menu-bar button (chat lines, party / clan invites); mirrored on ⋯ when it is a collapsed secondary button. 0 clears. */
  setBadge(id: string, n: number): void {
    if (n > 0) this.badges.set(id, n); else this.badges.delete(id); const bar = this.bar; if (!bar) return;
    const b = bar.querySelector<HTMLElement>(`[data-open="${id}"]`); if (b) { if (n > 0) b.dataset["badge"] = n > 9 ? "9+" : String(n); else delete b.dataset["badge"]; }
    const sec = [...this.badges.keys()].filter((k) => !PRIMARY_BAR_MENUS.has(k)).length; const more = bar.querySelector<HTMLElement>('[data-open="more"]');
    if (more) { if (sec) more.dataset["badge"] = "•"; else delete more.dataset["badge"]; }
  }
  badge(id: string): number { return this.badges.get(id) ?? 0; }
  private badges = new Map<string, number>();
  build(id: string): HTMLElement {
    if (id === "chat" && this.badges.has("chat")) this.setBadge("chat", 0);
    if (id === "pause") return this.pausePanel();
    if (id === "guide") return this.guidePanel();
    if (id === "settings") return this.settingsPanel();
    if (id === "chat") return this.chatPanel();
    if (id === "delete-progress") return this.deletePanel();
    if (id === "error-log") return this.errorLogPanel();
    if (id === "session") { const s = this.o.session?.(); return this.panel("session", "Session", s ? sessionBody(s, (t) => this.para(t)) : [this.para("Not in a shared session.")],
      s ? [...(s.actions?.() ?? []).map(([t, fn]): [string, () => void] => [t, () => { this.nav.closeAll(); fn(); }]), [s.leaveLabel, () => { this.nav.closeAll(); s.onLeave(); }, "alt"]] : []); }
    const m = GAME_MENUS.find((d) => d.id === id); if (!m) throw new Error(`unknown menu ${id}`);
    if (id === "map" && this.o.mapBody) return this.panel(id, m.title, this.o.mapBody());
    if (this.o.gameplay && (GAMEPLAY_PANELS as readonly string[]).includes(id)) return this.panel(id, m.title, this.gameplayNodes(id as GameplayPanel));
    return this.panel(id, m.title, [this.para(m.text)]);
  }
  private gameplayNodes(id: GameplayPanel): Node[] {
    const status = this.para(this.statusLine); status.dataset["role"] = "status"; status.setAttribute("aria-live", "polite");
    return [status, ...gameplayBody(id, { ...this.o.gameplay!, stall: () => this.stallTarget ?? this.o.gameplay!.stall?.(), camper: () => this.camperTarget, station: () => this.stationTarget, pet: () => this.petTarget, selectPet: (e) => this.selectPet(e), mount: () => this.mountTarget, openSaddlebag: (m) => this.openStorage(m), worker: () => this.workerTarget, selectWorker: (e) => this.selectWorker(e) }, { para: (t) => this.para(t), rerender: () => this.refresh(), status: (t) => { this.statusLine = t; }, close: () => this.nav.closeAll() })];
  }
  /** Re-render the open gameplay panel from live world state by diffing (only changed nodes are touched, focus kept).
   *  No-op when no gameplay panel is open. Returns the number of DOM mutations. */
  /** ADR-205: set the open gameplay panel's status line (e.g. a friendly server-reject text) and re-render. */
  notice(text: string): void { this.statusLine = text; this.refresh(); }
  refresh(): number {
    const id = this.nav.top; if (!id || !this.o.gameplay || !(GAMEPLAY_PANELS as readonly string[]).includes(id)) return 0;
    const body = this.o.root.querySelector<HTMLElement>(`[data-menu="${id}"] [data-role=body]`); if (!body) return 0;
    const next = body.cloneNode(false) as HTMLElement; next.append(...this.gameplayNodes(id as GameplayPanel));
    return morph(body, next);
  }
  /** Open the trade panel on a specific stall (interact). */
  openStall(stall: number): void { this.stallTarget = stall; this.o.gameplay?.send(openStallIntent(stall)); if (this.nav.top === "trade") this.refresh(); else this.nav.open("trade", this.build("trade")); }
  stallTarget: number | undefined;
  /** Open the camper station panel on a vehicle (gameplay.vehicleStationOpened event); asks the server to open its storage. */
  openCamper(vehicle: number): void {
    this.camperTarget = vehicle; this.o.gameplay?.send(openContainerIntent(vehicle));
    if (this.nav.top === "camper") { this.o.root.querySelector<HTMLElement>("[data-panel=camper-station]")?.setAttribute("data-key", String(vehicle)); this.refresh(); } else this.nav.open("camper", this.build("camper"));
  }
  camperTarget: number | undefined;
  /** ADR-160: open a loot bag by hand (Interact / click): ask the server to open it and show it in the inventory panel. */
  openLoot(bag: number): void { this.o.gameplay?.send(openContainerIntent(bag as never)); if (this.nav.top === "inventory") this.refresh(); else this.open("inventory"); }
  /** Open a plain base-storage piece (chest, box, shelf) the same way: ask the server to open its Storage
   *  attachment and show it in the inventory panel once its Container replicates (panel refreshes 4×/s). */
  openStorage(piece: number): void { this.o.gameplay?.send(openContainerIntent(piece as never)); if (this.nav.top === "inventory") this.refresh(); else this.open("inventory"); }
  /** ADR-136: open a station's crafting panel (Interact near a workbench, forge, campfire …). */
  openStation(entity: number, kind: number): void {
    this.stationTarget = { entity, kind }; if (kind === 1 || kind === 3) this.o.gameplay?.send(openContainerIntent(entity)); // fired: fuel deposits need the container open
    if (this.nav.top === "station") this.refresh(); else this.nav.open("station", this.build("station"));
  }
  stationTarget: { entity: number; kind: number } | undefined;
  /** ADR-145: open the pet panel on a pet / tameable animal (Interact next to it); asks the server to open an owned pet's bag. */
  openPet(pet: number | undefined): void {
    this.selectPet(pet);
    if (this.nav.top === "pet") this.refresh(); else this.nav.open("pet", this.build("pet"), () => this.closePetBag());
  }
  selectPet(pet: number | undefined): void {
    this.petTarget = pet; const c = this.o.gameplay?.ctx();
    if (pet === undefined || !c || !isPetOwner(c.world, c.player, pet as never)) return;
    const now = performance.now(); if (this.petOpenAt.pet === pet && now - this.petOpenAt.t < 800) return; // the panel re-asks until the bag replicates
    this.petOpenAt = { pet, t: now }; this.o.gameplay?.send(openContainerIntent(pet as never));
  }
  private petOpenAt = { pet: -1, t: 0 };
  /** ADR-319: open the mount panel on a mount / wild rideable animal (Mount.Menu next to it, or riding). */
  openMount(m: number): void { this.mountTarget = m; if (this.nav.top === "mount") this.refresh(); else this.nav.open("mount", this.build("mount")); }
  mountTarget: number | undefined;
  /** Task 22: open the worker panel on an AI human (Interact next to it); no bag to open, unlike pets. */
  openWorker(worker: number | undefined): void {
    this.selectWorker(worker);
    if (this.nav.top === "worker") this.refresh(); else this.nav.open("worker", this.build("worker"));
  }
  selectWorker(worker: number | undefined): void { this.workerTarget = worker; }
  workerTarget: number | undefined;
  /** Closing the pet panel closes the pet's bag on the server (so it stops replicating and the pack panel is normal again). */
  private closePetBag(): void { const c = this.o.gameplay?.ctx(); const v = c?.world.isRegistered(Viewing) ? c.world.getField(c.player, Viewing, "container") : undefined;
    if (v !== undefined && c!.world.isRegistered(Pet) && c!.world.has(v as never, Pet)) this.o.gameplay?.send(closeContainerIntent()); this.petOpenAt = { pet: -1, t: 0 }; }
  petTarget: number | undefined;
  /** Append an incoming chat line (from NetClient.chat). */
  /** `channel`: ChatChannel number (1 global … 5 whisper) or omitted for client/system lines -> `data-chan`. */
  /** `notify` (ADR-172): count it on the chat button's unread badge while the chat panel is closed (main.ts: not for your own lines). */
  pushChat(line: string, channel?: number, notify = false): void {
    if (notify && this.nav.top !== "chat") this.setBadge("chat", this.badge("chat") + 1);
    this.chatLog.push({ text: line, chan: (channel === undefined ? undefined : CHAT_CHAN_NAMES[channel]) ?? "system" }); if (this.chatLog.length > 200) this.chatLog.splice(0, this.chatLog.length - 200);
    const log = this.o.root.querySelector<HTMLElement>("[data-menu=chat] [data-role=chat-log]"); if (log) { const lp = this.para(line); lp.dataset["chan"] = this.chatLog.at(-1)!.chan; log.append(lp); log.scrollTop = log.scrollHeight; }
  }
  toggle(id: string): void { if (id === "trade") this.stallTarget = undefined; this.nav.toggle(id, () => this.build(id), id === "pet" ? () => this.closePetBag() : undefined); }
  open(id: string): void { this.nav.open(id, this.build(id)); }
  pause(): void { if (this.nav.top === "pause") return; this.nav.open("pause", this.build("pause")); }
  /** ADR-363: the guide opens stacked over the pause menu (Esc / ✕ / B closes back to pause; the pause
   *  menu stays in the stack, so singleplayer pause — main.ts keys it on isOpenId("pause") — is preserved). */
  private guidePanel(): HTMLElement {
    const el = this.panel("guide", "Guide", [buildGuidePanel()]);
    // ADR-387: the Guide page header shows the book icon (runtime-painted, guide-art.ts) instead of
    // the bare heading — the same icon as the Guide's entry buttons.
    const h2 = el.querySelector("h2");
    if (h2) h2.prepend(iconImg(GUIDE_BOOK_ICON_FILE, 24, "Guide"), document.createTextNode(" "));
    return el;
  }

  private pausePanel(): HTMLElement {
    const items: [string, () => void, (string | undefined)?, (string | undefined)?][] = [["Resume", () => this.nav.close()]];
    if (this.o.session?.()) items.push(["Session", () => this.open("session")]); // ADR-236: multiplayer status / room code / leave live here, not over the game
    for (const m of GAME_MENUS) if (!CONTEXT_ONLY_MENUS.has(m.id)) items.push([m.title, () => this.open(m.id), undefined, m.id === "guide" ? GUIDE_BOOK_ICON_FILE : undefined]); // station / camper open by walking up to one
    const tut = this.o.tutorial;
    if (tut?.active()) items.push(["Dismiss this tip", () => { this.nav.closeAll(); tut.next(); }], ["Turn off tips", () => { this.nav.closeAll(); tut.skip(); }, "alt"]);
    else if (tut) items.push(["Play the guide again", () => { this.nav.closeAll(); tut.replay(); }, undefined, GUIDE_BOOK_ICON_FILE]);
    items.push(["Quit to main menu", () => { this.nav.closeAll(); this.o.onQuit(); }, "alt"]);
    return this.panel("pause", "Paused", [], items);
  }
  private settingsPanel(): HTMLElement {
    const s = loadSettings();
    const hud = document.createElement("input"); hud.type = "checkbox"; hud.checked = s.showHud;
    const fs = document.createElement("input"); fs.type = "checkbox"; fs.checked = s.fullscreen;
    const l1 = document.createElement("label"); l1.append("Show HUD (next start)", hud);
    const l2 = document.createElement("label"); l2.append("Fullscreen when playing", fs);
    const th = document.createElement("input"); th.type = "checkbox"; th.checked = s.toolHints !== false; th.dataset["key"] = "tool-hints"; // ADR-126
    const l5 = document.createElement("label"); l5.append("Show tool needed near resources", th);
    const nt = document.createElement("input"); nt.type = "checkbox"; nt.checked = s.nameTags !== false; nt.dataset["key"] = "name-tags"; // ADR-173
    const l6 = document.createElement("label"); l6.append("Show player names", nt);
    const lw = document.createElement("input"); lw.type = "checkbox"; lw.checked = s.ledgeWarnings !== false; lw.dataset["key"] = "ledge-warnings"; // ADR-306
    const l8 = document.createElement("label"); l8.append("Hidden ledge warnings", lw);
    const tu = tempUnitControl(s); const l7 = tu.el; // ADR-239/243: °F / °C toggle, first row
    const q = document.createElement("select");
    const qi = this.o.qualityInfo?.(); // ADR-116: Auto shows what it picked; the detected device tier is listed below
    for (const p of QUALITY_PRESETS) { const o = document.createElement("option"); o.value = p; o.textContent = p === "auto" ? (qi ? `${qi.autoLabel()} — adaptive` : "Auto (adaptive)") : p[0]!.toUpperCase() + p.slice(1); q.append(o); }
    q.value = loadPreset();
    const l3 = document.createElement("label"); l3.append("Graphics quality", q);
    if (qi?.detected) { const d = document.createElement("small"); d.dataset["role"] = "detected-tier"; d.style.cssText = "display:block;opacity:.75";
      d.textContent = `Detected: ${qi.detected.name[0]!.toUpperCase()}${qi.detected.name.slice(1)} (${qi.detected.klass}${qi.detected.remembered ? ", remembered" : ""})`; l3.append(d); }
    const del = this.o.deleteProgress?.();
    const wr = this.o.worldRules?.(); const l4 = document.createElement("small"); l4.dataset["role"] = "world-rules"; l4.style.cssText = "display:block;opacity:.8";
    l4.textContent = wr ? `This world: zombie hordes ${wr.hordes ? `ON (after ${wr.hordeGraceDays} in-game days)` : "OFF"} · AI humans ${wr.aiHumans ? "ON" : "OFF"}` : "";
    return this.panel("settings", "Settings", [l7, l1, l2, l5, l6, l8, l3, ...(wr ? [l4] : []), ...(this.o.fx ? [fxSettingsRows(this.o.fx)] : []), ...(this.o.audio ? [audioSettingsRows(this.o.audio)] : [])], [...(this.o.tutorial ? [["Play the guide again", () => { this.nav.closeAll(); this.o.tutorial!.replay(); }, "alt", GUIDE_BOOK_ICON_FILE] as [string, () => void, string, string]] : []), ...(del ? [[del.label, () => this.open("delete-progress"), "alt"] as [string, () => void, string]] : []), ["🐞 Error log", () => this.open("error-log"), "alt"],["Save", () => { saveSettings({ ...loadSettings(), showHud: hud.checked, fullscreen: fs.checked, toolHints: th.checked, nameTags: nt.checked, ledgeWarnings: lw.checked, ...tu.patch() }); const qp = parsePreset(q.value) ?? DEFAULT_QUALITY_PRESET; savePreset(qp); this.o.setQuality?.(qp); this.nav.close(); }], ["Back", () => this.nav.close(), "alt"]]);
  }
  private deletePanel(): HTMLElement {
    const d = this.o.deleteProgress?.();
    if (!d) return this.panel("delete-progress", "Delete progress", [this.para("Nothing to delete here.")]);
    const c = deleteConfirm({ message: d.message, settingsOption: d.settingsOption, onCancel: () => this.nav.close(), onConfirm: (o) => d.run(o), ...(this.o.getGamepads ? { getGamepads: this.o.getGamepads as never } : {}) });
    return this.panel("delete-progress", d.label, [c.el]);
  }
  private chatPanel(): HTMLElement {
    const log = document.createElement("div"); log.dataset["role"] = "chat-log"; log.style.cssText = "max-height:30vh;overflow:auto;font-size:14px";
    for (const l of this.chatLog.slice(-50)) { const p = this.para(l.text); p.dataset["chan"] = l.chan; log.append(p); }
    const input = document.createElement("input"); input.dataset["role"] = "chat-input"; input.placeholder = "Say something…"; input.maxLength = 200; input.setAttribute("aria-label", "Chat message"); input.autofocus = true; bindTypingFullscreenExit(input); // Task 20: in-game chat is a fullscreen text field too
    const send = (): void => { const t = input.value.trim(); if (!t) return; if (this.chatChannel === 5 && !this.whisperTo) { this.pushChat("(pick who to whisper)"); return; }
      if (this.o.onChat) this.o.onChat(t, this.chatChannel, this.chatChannel === 5 ? this.whisperTo : undefined); else this.pushChat(t, this.chatChannel); input.value = ""; };
    /** Whisper picker: online directory (gameplay.onlinePlayer) + nearby players. */
    const picker = document.createElement("div"); picker.className = "gm-grid"; picker.dataset["role"] = "whisper-picker";
    const fillPicker = (): void => {
      picker.replaceChildren(); picker.hidden = this.chatChannel !== 5; const g = this.o.gameplay; const c = g?.ctx(); if (picker.hidden || !c) return;
      const ts = onlineTargets(c, g!.social); if (!ts.length) picker.append(this.para("Nobody online."));
      for (const t of ts.slice(0, 16)) { const b = document.createElement("button"); b.type = "button"; b.textContent = t.name; b.dataset["key"] = `whisper-${t.playerId}`; const on = t.playerId === this.whisperTo; b.className = on ? "" : "alt"; b.setAttribute("aria-pressed", String(on));
        b.addEventListener("click", () => { this.whisperTo = t.playerId; fillPicker(); }); picker.append(b); }
    };
    const chans = document.createElement("div"); chans.className = "gm-grid"; chans.dataset["role"] = "chat-channels"; chans.dataset["tabs"] = "tab";
    for (const [n, c] of CHAT_CHANNELS) { const b = document.createElement("button"); b.type = "button"; b.className = c === this.chatChannel ? "" : "alt"; b.textContent = n; b.dataset["key"] = `chan-${c}`; b.setAttribute("aria-pressed", String(c === this.chatChannel));
      b.addEventListener("click", () => { this.chatChannel = c; for (const o of Array.from(chans.children)) { const on = o === b; (o as HTMLElement).className = on ? "" : "alt"; o.setAttribute("aria-pressed", String(on)); } fillPicker(); }); chans.append(b); }
    fillPicker();
    const m = this.panel("chat", "Chat", [log, chans, picker, input], [["Send", send]]); // header ✕, Esc, B and tap-outside close it; no second Close button
    { const sb = m.querySelector<HTMLElement>("[data-action=Send]")!; sb.dataset["role"] = "submit"; sb.dataset["pad"] = "X"; }
    return m;
  }
}

/** ADR-139: gamepad menu actions from the gamepad profile; modifier combos win over plain Select. */
/** ADR-200: LB/RB (kind "tab") and LT/RT (kind "page") step the top modal's `[data-tabs=tab|page]` button group (pressed = current), keeping pad focus on it. */
export function cycleTabs(nav: UINav, d: number, kind: "tab" | "page"): boolean {
  const m = nav.stack_top(); const g = m?.querySelector<HTMLElement>(`[data-tabs=${kind}]`) ?? (kind === "tab" ? m?.querySelector<HTMLElement>("[data-tabs]") : null); if (!g) return false;
  const bs = Array.from(g.querySelectorAll<HTMLButtonElement>("button")).filter((b) => !b.disabled); if (bs.length < 2) return false;
  const i = Math.max(0, bs.findIndex((b) => b.getAttribute("aria-pressed") === "true" || !b.classList.contains("alt")));
  const key = bs[(i + d + bs.length) % bs.length]!.dataset["key"]; bs[(i + d + bs.length) % bs.length]!.click();
  const n = key ? m?.querySelector<HTMLElement>(`[data-key="${key}"]`) : undefined; n?.focus(); return true;
}
export function padMenuAction(i: { pressed(a: string): boolean }): "crafting" | "chat" | "inventory" | "character" | undefined {
  if (i.pressed("ToggleCharacter")) return "character";
  return i.pressed("ToggleCrafting") ? "crafting" : i.pressed("OpenChat") ? "chat" : i.pressed("ToggleInventory") ? "inventory" : undefined;
}

/** ADR-236: Pause → Session (the in-game home of what the old connect / P2P boxes showed over the game). */
export interface SessionInfo {
  label: string; leaveLabel: string; onLeave: () => void;
  /** Live rows (re-read every 500 ms while open): e.g. Room code, Server, Status, Ping, Account. */
  rows?: () => [string, string][];
  /** Live player list (P2P host). */
  players?: () => { name: string; host?: boolean }[];
  /** Extra buttons before Leave, read when the panel opens (e.g. Reconnect while disconnected). */
  actions?: () => [string, () => void][];
}
export function sessionBody(s: SessionInfo, para: (t: string) => HTMLElement): Node[] {
  const label = para(s.label); label.dataset["role"] = "session-label";
  const dl = document.createElement("dl"); dl.dataset["role"] = "session-rows"; dl.style.cssText = "display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0;font-size:14px";
  const ul = document.createElement("ul"); ul.dataset["role"] = "session-players"; ul.style.cssText = "margin:0;padding-left:18px;font-size:14px;max-height:30vh;overflow:auto";
  const render = (): void => {
    const rows = s.rows?.() ?? []; dl.replaceChildren(...rows.flatMap(([k, v]) => { const dt = document.createElement("dt"); dt.textContent = k; dt.style.cssText = "font-weight:700;opacity:.8";
      const dd = document.createElement("dd"); dd.textContent = v; dd.dataset["row"] = k.toLowerCase().replace(/\s+/g, "-"); dd.style.cssText = "margin:0;overflow-wrap:anywhere"; return [dt, dd]; }));
    const ps = s.players?.() ?? []; ul.hidden = !ps.length;
    ul.replaceChildren(...ps.map((p) => { const li = document.createElement("li"); li.dataset["role"] = "player"; if (p.host) li.dataset["host"] = "1"; li.textContent = p.host ? `${p.name} (host)` : p.name; return li; }));
  };
  render();
  if (s.rows || s.players) { const t = setInterval(() => { if (!dl.isConnected) { clearInterval(t); return; } render(); }, 500); }
  return [label, dl, ul];
}
