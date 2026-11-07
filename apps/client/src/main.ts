import { markNavFocus } from "./back-history.js";
import { HeapTrend, MEMORY_BUDGETS, memoryProfileFor } from "./memory-budget.js";
import { debugCamera, mountLootLabels } from "./loot-labels.js";
import { mountNameTags } from "./name-tags.js";
import { mountPetStatus } from "./pet-status.js";
import { waitForWorldReady } from "./ready.js";
import { mountSnapOverlay } from "./snap-overlay.js";
import { lastPlayedKey } from "./delete-progress.js";
import { CHAT_TAG, chatLine, chatSender } from "./chat-line.js";
import { intentPayload } from "./send-intent.js";
import { LoadProgress } from "./load-progress.js";
import { attachZoom, type ZoomControl } from "./camera-zoom.js";
import { attachCameraRotate, screenDirToWorld, type CameraRotateControl } from "./camera-rotate.js";
let camZoom: ZoomControl | undefined; let padZoomT = 0; // ADR-177
let camRot: CameraRotateControl | undefined; // ADR-253
import { mountUi } from "./ui-root.js";
import { showRenderError, glInfo } from "./glcheck.js";
import { errorLog, installGlobalErrorCapture, logRecoverable } from "./error-log.js";
import { setRenderErrorSink } from "@engine/render";
import { startDiag } from "./diag.js";
import { installFullscreenRestore, exitFullscreen } from "./fullscreen.js";
import { uiRoot, safeAreaInsets } from "./ui-root.js";
import { GameMenus, padMenuAction } from "./game-menus.js";
import { BuildMode } from "./build-mode.js";
import { mountBuildHud, onTouchControl } from "./build-hud.js";
import { mountToolHint, toolIconFrame } from "./tool-hint.js";
import { mountStationHint } from "./station-hint.js";
import { mountWorldTools, type WorldToolsHandle } from "./world-tools.js";
import { syncUnderground } from "./underground.js";
import { mountVehicleControls, type VehicleControls } from "./vehicle-controls.js";
import { mountTouchOverlay, syncTouchHidden, touchLabel, type TouchCtx } from "./touch-overlay.js";
import { stanceMode, StanceMode, liftableNear, bedNear } from "@engine/gameplay";
/**
 * Client bootstrap: fixed-step loop + WebGL2 IsoRenderer view (./view.ts, Art's pack) + network session.
 * Falls back to the Canvas2D debug draw with ?renderer=debug or when WebGL2 / the art fails to load.
 * URL params: ?server=ws://host:7777 (default: same host, port 7777), ?player=N (separate saved account per N),
 *             ?offline=1 (skip the menu: singleplayer), ?menu=0 (skip the menu: legacy connect overlay), ?bots=N,
 *             ?ice=<JSON RTCIceServer[]> (P2P STUN/TURN override, also VITE_ICE_SERVERS), ?renderer=debug, ?time=0..24 / ?weather=clear|rain|storm|snow|fog|overcast|heat|blizzard|windy &intensity=0..1, ?season=summer|fall|winter|0..3 (view-only overrides), ?hud=0.
 */
import { cosmeticsHashes, createGameLoop, World, PlayerId, Transform, PrevTransform, lerp, entityIndex, InputState, type FixedLoop, type Entity } from "@engine/core";
import { TileMap, worldToScreen, screenToWorld, DEFAULT_ISO, ProceduralGenerator, computeSpawnPoints } from "@engine/world";
import { InputSystem, AimResolver, DEFAULT_ACTIONS, DEFAULT_CONTEXTS, DEFAULT_PROFILES, DEFAULT_TOUCH_LAYOUTS } from "@engine/input";
import { attachBrowserInput } from "@engine/input/browser";
import { ClanRoster, ClanRosterMember, OnlinePlayer, VehicleStationOpenedEvt, PetEventEvt, WorkerEventEvt, gameplayNet, installDemoWorld, onGameplayRejected } from "@engine/server/protocol";
import { terrainRejectText } from "./terrain-reject.js";
import { inventoryOpRejectText } from "./inventory-reject.js";
import { netIdOf, ChatChannel, type ChatDelivered } from "@engine/net";
import { WorldRules, worldRules, ROADS, holdsRangedWeapon, Sign, signText, Road, StallHeader, buildView, listItemIntents, setStallOpenIntent, stallView, nearestStall, inventoryView, selectHotbarIntent, equipIntent, useIntent, moveSlotIntent, hotbarConsumes, gameplayDefs, BuildPiece, compassOf } from "@engine/gameplay";
import { replicaTerrain } from "./replica-terrain.js";
import { SocialDirectory, hasCreatedLook, setAppearanceIntent, interactPanel, petEventText, workerEventText, petRenameIntent, readyIntent, UseCmd, GatherCmd, farmPrompt, TerrainRes, type MenuCtx, type MenuIntent } from "@engine/gameplay";
import { ClientSession } from "./session.js";
import { mountNetStatus, pingLabel } from "./net-status.js";
import type { SessionInfo } from "./game-menus.js";
import { IsoView, groundZ } from "./view.js";
import { mountFx, saveFx } from "./fx/index.js";
import { mountHud } from "./hud.js";
import { mountGatherFx } from "./gather-fx.js";
import { panelIcon } from "./gameplay-panels.js";
import { mountHotbar, hotbarCells, hotbarCycle } from "./hotbar.js";
import { createWorldMap } from "./world-map.js";
import { mountCompassHud, createIdleTracker, idleCompass } from "./compass-hud.js";
import { CLIENT_FRAME_MAPPING, gateEdges } from "./frame-mapping.js";
import { buildSignEditor } from "./sign-editor.js";
import { controlLabel, mountFarmPrompt, quickUseFires, type PromptDevice } from "./farm-prompt.js";
import { attachContextRecovery, effectiveLevel, retryIsoAtSafe } from "./gl-recovery.js";
import { BootUI, loadSettings, newWorldRules } from "./menu.js";
import { EDIT_CHAR_KEY, creatorShotFromQuery, creatorShotLook, loadCharacter, previewModeFromQuery, saveCharacter, showCharacterCreator, type CharacterSaveKind, type StoredCharacter } from "./character-creator.js";
import { sampleDayClock, sunFraction } from "./day-clock.js";
import { TUTORIAL_STEPS, TutorialProgress, tutorialKey } from "./tutorial/steps.js";
import { mountTutorial } from "./tutorial/overlay.js";
import { TutorialProber, type ProbeSample } from "./tutorial/probe.js";
import { Health, Zombie, Progression, hasDisease, worldDays } from "@engine/gameplay";
import { sunFractionOf, timeOfDay } from "@engine/core";
import { Survival, PlayerIntent, HotbarSelection, heldTool, ResourceNode, toolHint, Animal, LootBag, openContainer } from "@engine/gameplay";
import { AudioSystem } from "./audio/index.js";
import { mountDeathScreen, type DeathScreen } from "./death-screen.js";
import { mountPadDebug } from "./pad-input.js";
import { RespawnCmd, partyView, clanView } from "@engine/gameplay";
// ADR-200: Xbox Edge — deliver the controller as a Gamepad (not emulated mouse/keys) so UINav owns menu navigation.
// ADR-213: index.html sets it before any module runs too; pad keys (if Edge still emulates) are handled everywhere.
try { const nv = navigator as Navigator & { gamepadInputEmulation?: string }; if ("gamepadInputEmulation" in nv) nv.gamepadInputEmulation = "gamepad"; } catch { /* read-only on some engines */ }

const canvas = document.getElementById("game") as HTMLCanvasElement;
/** Everything (canvas, HUD, touch overlay, menu bar, modals) lives in this root; fullscreen targets it (ADR-095). */
const root = uiRoot();
const params = new URLSearchParams(location.search);
// ADR-213: ?padDebug=1 — raw gamepad / pad-key readout for diagnosing real controllers (Xbox Edge)
if (params.get("padDebug") === "1") mountPadDebug();
/** Clan roster + online directory from the server (reset per client). */
const social = new SocialDirectory();
let ctx: CanvasRenderingContext2D | null = null;
/** Canvas the Canvas2D debug view draws on; declared before isoReady (?renderer=debug calls fallback() synchronously: ADR-164). */
let debugCanvas = canvas;
let iso: IsoView | undefined;
const WEATHERS = ["clear", "rain", "storm", "snow", "fog", "overcast", "heat", "blizzard", "windy"];
const SEASONS = ["summer", "fall", "winter", "spring"]; // ADR-239 ?season= view override (name or 0..3 fractional blend)
const num = (k: string): number | undefined => { const v = params.get(k); return v === null || !Number.isFinite(Number(v)) ? undefined : Number(v); };
const wq = params.get("weather"); const wi = wq ? WEATHERS.indexOf(wq) : -1;
const sq = params.get("season"); const si = sq ? (SEASONS.indexOf(sq === "autumn" ? "fall" : sq) >= 0 ? SEASONS.indexOf(sq === "autumn" ? "fall" : sq) : Number.isFinite(Number(sq)) ? Number(sq) : -1) : -1;
const seasonOv = si >= 0 ? { season: si } : {};
const serverParam = params.get("server");
/** Main menu unless a URL param already picks the mode (?offline=1, ?server=, ?menu=0: tests/screenshots). */
/** ?creator=shot&seed=N[&facing=0..7][&body=|sex=][&freeze=1][&timeout=ms]: deterministic creator capture (no menu / world); sets window.__creatorReady (ADR-124, ADR-130). */
const creatorShot = creatorShotFromQuery(params);
const useMenu = !creatorShot && !serverParam && params.get("offline") !== "1" && params.get("menu") !== "0";
const boot = useMenu ? new BootUI(import.meta.env.BASE_URL) : undefined;
/** ADR-118: weighted boot stages -> the loading bar (monotonic; BootUI eases the fill and walks the zombie). */
// ADR-198: persistent error log — uncaught errors / unhandled rejections are recorded even when no overlay shows.
installGlobalErrorCapture(window);
// ADR-201: errors @engine/render used to swallow (retier, page-in, ktx2, Canvas2D image loads) land in the log; only user-visible ones get the overlay
setRenderErrorSink((r) => { if (r.visible) showRenderError(`Renderer: ${r.where}`, r.error instanceof Error ? r.error.stack ?? r.error.message : String(r.error)); else logRecoverable(r.where, r.error); });
errorLog().ctx = { renderer: () => (iso ? (iso.renderer.gl ? "webgl2" : "canvas2d") : ctx ? "debug" : "booting"), gpu: () => (iso ? glInfo(iso.renderer.gl).split(" | ")[0] ?? "" : "n/a") };
const loadProgress = new LoadProgress();
const onStage = (id: string, f: number, label?: string): void => { const v = loadProgress.update(id, f, label); boot?.progress(v, loadProgress.label); };
onStage("renderer", 0);
const glLevel = effectiveLevel(location.search);
const wantIso = glLevel !== "debug" && typeof WebGL2RenderingContext !== "undefined";
const isoReady: Promise<void> = wantIso ? (async () => {
  const v = await IsoView.create(canvas, import.meta.env.BASE_URL, { ...(num("time") !== undefined ? { hours: num("time")! } : {}), ...(wi >= 0 ? { weather: wi, intensity: num("intensity") ?? 1 } : {}), ...seasonOv }, onStage);
  const onResize = (): void => v.resize(innerWidth, innerHeight, devicePixelRatio || 1); addEventListener("resize", onResize);
  // Task 19: rotating the phone must reflow without a reload. Rotation fires resize on most browsers, but
  // orientationchange covers ones that fire it first / report stale metrics on resize alone; onResize is cheap
  // when nothing changed, and the camera zoom + keyboard-viewport helpers also listen to resize.
  addEventListener("orientationchange", onResize); onResize();
  attachContextRecovery(canvas, { notify: showRenderError });
  camZoom = attachZoom(v.renderer.camera, canvas, { enabled: () => !document.querySelector("[data-boot=menu]") });
  iso = v; (window as { __view?: unknown }).__view = { ready: true, renderer: "iso", iso: v };
})().catch((e: unknown) => {
  // keep the sprite renderer: retry once at safe quality (still full art) before the Canvas2D debug view
  if (glLevel !== "safe" && retryIsoAtSafe()) { boot?.fail("Graphics hiccup — reloading at safe quality…"); return; }
  boot?.progress(loadProgress.value, "3D renderer unavailable — using the simple view");
  console.warn("IsoRenderer unavailable, using debug renderer", e); showRenderError("3D renderer unavailable — showing debug view", e instanceof Error ? e.message + ((e as { info?: unknown }).info ? `\n${JSON.stringify((e as { info?: unknown }).info).slice(0, 300)}` : "") : String(e)); fallback(); }) : Promise.resolve(fallback());
function fallback(): void {
  // a WebGL context may already own #game: draw Canvas2D on an overlay (input stays bound to #game)
  const c = document.createElement("canvas"); c.id = "game-debug"; c.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none";
  mountUi(c); debugCanvas = c; ctx = c.getContext("2d");
  (window as { __view?: unknown }).__view = { ready: true, renderer: "debug" };
}
void isoReady;

// Input (@engine/input, see packages/input/README.md): keyboard/mouse, gamepad and touch -> one InputFrame per tick.
const input = new InputSystem(performance, { actions: DEFAULT_ACTIONS, contexts: DEFAULT_CONTEXTS, profiles: DEFAULT_PROFILES });
input.push("Gameplay");
/** The layout's top-row menu buttons (inventory/crafting/map/chat/social/build/back) are replaced by the DOM menu bar
 * (./game-menus.ts): real, visible, focusable buttons that also work for mouse; the HUD sits where chat/social were. */
const MENU_BAR_IDS = new Set(["inventory", "crafting", "map", "chat", "social", "build", "back"]);
const touchLayout = { ...DEFAULT_TOUCH_LAYOUTS.gameplay, elements: DEFAULT_TOUCH_LAYOUTS.gameplay.elements.filter((e) => !MENU_BAR_IDS.has(e.id)) };
/** ADR-170: the driving layout adds Engine / Lights buttons (right side, clear of reload / hotbar / attack); swapped in only while seated. */
const driveTouchLayout = { ...touchLayout, elements: [...touchLayout.elements,
  { id: "boost", kind: "button" as const, anchor: { x: 0.05, y: 0.42 }, radius: 22, control: "touch.btn.sprint", label: "Boost" },
  { id: "engine", kind: "button" as const, anchor: { x: 0.86, y: 0.4 }, radius: 20, control: "touch.btn.engine", label: "Engine" },
  { id: "lights", kind: "button" as const, anchor: { x: 0.94, y: 0.4 }, radius: 20, control: "touch.btn.lights", label: "Lights" }] };
let vehicleCtl: VehicleControls | undefined;
const gameplayTouchLayout = (): typeof touchLayout => (vehicleCtl?.driving ? driveTouchLayout : touchLayout) as typeof touchLayout;
const browserInput = attachBrowserInput(canvas, input, { ...(matchMedia("(pointer: coarse)").matches ? { virtualLayout: touchLayout } : {}), insets: () => safeAreaInsets() });
let menus: GameMenus | undefined;
/** ADR-117 audio (Web Audio mixer + snapshot-driven director); low-CPU mode follows LOW_END-style detection. */
const audio = new AudioSystem({ base: import.meta.env.BASE_URL, lowEnd: params.get("gl") === "lowend" || (navigator.hardwareConcurrency ?? 8) <= 4 || ((navigator as { deviceMemory?: number }).deviceMemory ?? 8) <= 2 });
audio.start();
document.addEventListener("visibilitychange", () => audio.mixer.setSuspended("hidden", document.hidden));
wireUiSounds(audio);
let farm: ReturnType<typeof mountFarmPrompt> | undefined;
const safeFarmPrompt = (p: NonNullable<typeof session.player>): ReturnType<typeof farmPrompt> => { try { return farmPrompt(world, p); } catch { return undefined; } };
/** ADR-133: context-only touch controls (Reload only with a ranged weapon in hand). */
/** ADR-244: carry / sleep buttons appear only near a liftable bag / free bed (or while carrying / asleep, captioned Drop / Wake). */
let touchCtxCache: TouchCtx = { reload: false }; let touchCtxAt = 0;
const touchContext = (): TouchCtx => {
  const now = performance.now(); if (now - touchCtxAt < 150) return touchCtxCache; touchCtxAt = now;
  const p = session.player;
  try {
    if (p === undefined) return (touchCtxCache = { reload: false });
    const m = stanceMode(world, p), ranged = holdsRangedWeapon(world, p);
    return (touchCtxCache = { reload: ranged, aim: ranged, carrying: m === StanceMode.Carry, sleeping: m === StanceMode.Sleep,
      carry: m === StanceMode.None && liftableNear(world, p) !== undefined, sleep: m !== StanceMode.Sleep && bedNear(world, p) !== undefined });
  } catch { return (touchCtxCache = { reload: false }); }
};
if (browserInput.controls) { const c = browserInput.controls; mountTouchOverlay(root, () => { syncTouchHidden(c.hidden, touchContext()); return c.geometry(); }, () => !menus || menus.nav.isOpen, (id) => touchLabel(id, touchContext())); }
/** Set by the active mode: what "Quit to main menu" must do first (save / end the P2P session / disconnect). */
let leaveCurrent: (() => Promise<void> | void) | undefined;
/** Set by the active mode: Settings → "Delete my progress" (ADR-099); undefined hides the entry. */
let deleteInfo: (() => { label: string; message: string; settingsOption: boolean; run: (o: { resetSettings: boolean }) => Promise<string> } | undefined) | undefined;
let sessionInfo: (() => SessionInfo) | undefined;
let menuWorldSeed: number | undefined;
/** ADR-144: the guide. `tutorialNewGame` is set when a NEW character enters (or ?tutorial=1). */
/** ADR-153: death screen (mounted below, after the tutorial). */
let deathUi: DeathScreen | undefined;
let tutorialNewGame = false; let tutProgress: TutorialProgress | undefined; const tutProber = new TutorialProber();
let tutorialUi: ReturnType<typeof mountTutorial> | undefined;
function tutorialProgress(): TutorialProgress {
  if (!tutProgress) { let store: Storage | undefined; try { store = localStorage; } catch { /* private mode */ }
    tutProgress = new TutorialProgress(TUTORIAL_STEPS, store, tutorialKey(params.get("player") ?? "1")); }
  return tutProgress;
}
function maybeStartTutorial(): void {
  const t = tutorialProgress();
  if (params.get("tutorial") === "1" && !t.active) t.start(true);
  else if (t.shouldAutoStart(tutorialNewGame)) t.start();
  tutorialUi?.update();
}
function startMenus(): void {
  if (menus) return;
  maybeStartTutorial();
  menus = new GameMenus({ root, input, tutorial: { active: () => tutorialProgress().active, replay: () => { tutorialProgress().start(true); tutorialUi?.update(); }, next: () => { tutorialProgress().next(); tutorialUi?.update(); }, skip: () => { tutorialProgress().skip(); tutorialUi?.update(); } }, audio: audio.mixer, fx: { get: () => fxLayer.settings(), set: (v) => { saveFx(v); fxLayer.apply(v); }, click: () => audio.ui("ui.click") }, worldRules: () => (world.isRegistered(WorldRules) && world.has(world.environment, WorldRules) ? worldRules(world) : undefined), onQuit: quitToMenu, session: () => sessionInfo?.(), deleteProgress: () => deleteInfo?.(), setQuality: (p) => iso?.renderer.setQualityPreset(p), qualityInfo: () => (iso && "quality" in iso.renderer ? (iso.renderer as { quality: { autoLabel(): string; detected?: { name: string; klass: string; remembered: boolean } | undefined } }).quality : undefined), gameplay: { ctx: menuCtx, send: sendIntent, social, clanTint: (t) => iso?.registry.clanPaletteForTint(t)?.primary, clanTint2: (t) => iso?.registry.clanPaletteForTint(t)?.secondary, onBuildSelect: (sel) => buildMode.select(sel), startPlacing: (sel) => buildMode.start(sel, { fromMenu: true }), worldTools: worldToolsApi, renamePet },
    onChat: (text, channel, to) => { if (!session.client?.chat.send(channel as ChatChannel, text, to ? { to } : {})) menus?.pushChat("(not connected — message not sent)"); },
    mapBody: () => { const m = createWorldMap({ world: () => world, player: () => session.player, tiles: () => session.client?.tiles.tiles, send: sendIntent }); return [m.el]; } });
}
/** Live data for the gameplay panels: the replicated world + local player; names via NetClient's NamesClient. */
function menuCtx(): MenuCtx | undefined {
  const p = session.player; const c = session.client; if (p === undefined || !c) return undefined;
  const names = { get: (id: number): string | undefined => { const n = c.names.get(id); if (n === undefined && id) c.names.want([id]); return n; } };
  const catalog = iso?.registry.cosmetics?.size ? iso.registry.cosmetics : undefined; // wardrobe palettes / eye list / secondary rows
  return { world, player: p, names, tick: c.serverTickEstimate, ...(catalog ? { catalog } : {}) };
}
/** ADR-145: pet rename modal (sign editor; on-screen keyboard on gamepad) -> PetRenameCmd. */
function renamePet(pet: Entity, current: string): void {
  let handle: { close(): void } | undefined; let closed = false;
  const close = (): void => { if (closed) return; closed = true; if (handle) handle.close(); else ed.remove(); };
  const ed = buildSignEditor({ kindName: "Pet name", saveLabel: "Save name", maxLen: 16, initial: current, keyboard: promptDevice() === "gamepad", close,
    onSave: (t) => { sendIntent(petRenameIntent(pet, t)); } });
  if (menus) handle = menus.nav.open("pet-rename", ed, () => { closed = true; menus?.refresh(); }); else root.append(ed);
}
/** Panel intent -> bridged gameplay net command; Entity args become NetIds (unbridged commands such as PaintCmd return false). */
function sendIntent(i: MenuIntent): boolean {
  const c = session.client; if (!c) return false;
  tutProber.command(i.cmd.name);
  try {
    const def = gameplayNet(i.cmd); const args = intentPayload(i.args as Record<string, number | number[]>, i.entities, (def as unknown as { entityFields: readonly string[] }).entityFields, (e) => netIdOf(world, e as never));
    return args !== undefined && c.sendCommand(def, args as never) !== false;
  } catch { return false; }
}
let chatWired: unknown;
/** Hook NetClient.chat (core ChatServer, already run by the server) into the chat panel once per client. */
function wireChat(): void {
  const c = session.client; if (!c || chatWired === c || !menus) return; chatWired = c; social.reset();
  c.chat.on((m: ChatDelivered) => { const me = session.player !== undefined ? world.getField(session.player, PlayerId, "id") : undefined; menus?.pushChat(chatLine(m.channel, chatSender(m.fromPlayer, (id) => c.names.get(id)), m.text), m.channel, m.fromPlayer !== me); });
  // owner-scoped social replication (Netcode SocialSync) → clan roster, invite lists, whisper picker
  c.onEvent(ClanRoster, (e) => social.onRoster(e)); c.onEvent(ClanRosterMember, (e) => social.onMember(e)); c.onEvent(OnlinePlayer, (e) => social.onOnline(e));
  // camper interior station used (server VehicleStationOpened, owner only) → camper station panel
  c.onEvent(VehicleStationOpenedEvt, (e) => { if (e.vehicle) menus?.openCamper(e.vehicle); });
  // ADR-145 pet feedback (owner only): tamed / refused / shied / fed / level up -> toast + panel refresh
  c.onEvent(PetEventEvt, (e) => { const t = petEventText(world, e.pet as never, e.result, e.value); if (t) farm?.toast(t); if (e.result === 1 && e.pet) menus?.openPet(e.pet); else menus?.refresh(); });
  // Task 22 worker feedback (owner only): hired / job set / released -> toast + panel refresh
  c.onEvent(WorkerEventEvt, (e) => { const t = workerEventText(world, e.worker as never, e.result, e.value); if (t) farm?.toast(t); menus?.refresh(); });
  // ADR-205 / ADR-264: inventory ops and shovel edits rejected by the server -> specific panel text + toast
  onGameplayRejected(c, (r) => { const t = inventoryOpRejectText(r.command, r.reason) ?? terrainRejectText(r.command, r.reason); if (t) { menus?.notice(t); farm?.toast(t); } });
  c.chat.onReject((ch, reason) => menus?.pushChat(`(${CHAT_TAG[ch] ?? "?"} message rejected: ${reason})`));
}
/** Pause menu "Quit to main menu": leave fullscreen, end the session, back to the main menu. */
function quitToMenu(): void {
  exitFullscreen();
  void Promise.resolve().then(() => leaveCurrent?.()).catch(() => {}).finally(() => {
    if (useMenu) { backToMenu(""); return; }
    const q = new URLSearchParams(location.search); for (const k of ["offline", "menu", "server", "autoconnect"]) q.delete(k);
    location.assign(`${location.pathname}${q.size ? `?${q}` : ""}`);
  });
}
let cam = { sx: 0, sy: 0 }; // camera offset from render(), for mouse aim
const aim = new AimResolver(input, { screenToWorld: (x, y) => iso ? iso.renderer.camera.cssToWorld(x, y) : screenToWorld(x - innerWidth / 2 + cam.sx, y - innerHeight / 2 + cam.sy),
  dirToWorld: (x, y) => screenDirToWorld(x, y, input.viewQuarter) }); // ADR-253: stick / touch aim is camera-relative
/** Input actions -> InputFrame (frame-mapping.ts, ADR-180); `inGameplay` is set by onUiFrame (runs first) so sim edges only fire in plain gameplay. */
let inGameplay = false;
const inputState = new InputState();
function sampleInput(): { buttons: number; aimX: number; aimY: number } {
  const p = session.player; const pt = p !== undefined ? world.get(p, Transform) : undefined;
  input.update(); onUiFrame();
  input.writeFrame(inputState, CLIENT_FRAME_MAPPING, p !== undefined && pt ? aim.resolve(world, p, pt) : undefined);
  const { tick: _t, commands: _c, actions, edges, ...rest } = inputState.sample(world.tick);
  // Every frame field goes to NetClient (spread into its InputCmd); net encodes the v2 fields once its InputCmd carries them.
  const e = gateEdges(edges, inGameplay); const cmd = { buttons: actions, ...rest, ...(e !== undefined ? { edges: e } : {}) }; return cmd;
}

const SLOT = params.get("player") ?? "1";
const stampPlayed = (m: "singleplayer" | "hosted"): void => { try { localStorage.setItem(lastPlayedKey(m, SLOT), String(Date.now())); } catch { /* private mode */ } };
// ADR-245: send the art pack's cosmetics hash once it is loaded (no catalog, e.g. the debug view: none sent)
const session = new ClientSession({ storage: localStorage, slot: SLOT, sampleInput,
  hashes: async () => { await isoReady.catch(() => undefined); const c = iso?.registry.cosmetics; return c?.size ? cosmeticsHashes(c) : undefined; } });
let world = new World({ seed: 1234 }); installDemoWorld(world, "client");
installFullscreenRestore();
const diag = startDiag({ renderer: () => iso?.renderer, entities: () => world.entityCount, tick: () => world.tick, player: () => session.player,
  snapshot: () => session.client ? { received: session.client.latestTick >= 0, latestTick: session.client.latestTick, snapshots: session.client.stats.snapshots } : undefined,
  // ADR-254: ?seed= pins the preview (and a remote join); otherwise 1234 until the local server reports its seed.
  spawnPoints: (() => { let c: { seed: number; points: { x: number; y: number }[] } | undefined; return () => (c ??= (() => { const seed = Number(params.get("seed") ?? 1234); return { seed, points: computeSpawnPoints(new ProceduralGenerator({ seed })) }; })()); })() });
// Ground: replicated tiles from the server (net TileClient, `session.client.tiles.tiles`) once connected;
// a placeholder ground is drawn only while offline.
const placeholder = new TileMap();
for (let y = -64; y < 96; y++) for (let x = -64; x < 96; x++) placeholder.setTile(x, y, 1 + ((x * 7 + y * 13) & 3) % 3);

const colors = ["#000", "#3a5", "#495", "#874"];
/** ADR-122 road / sign tools (world-tools.ts), mounted after the menus; the Build panel reaches them through this. */
let worldTools: WorldToolsHandle | undefined;
const worldToolsApi = { road: (n: number) => worldTools?.road(n), roadSurface: () => worldTools?.roadSurface() ?? 0, placeSign: () => worldTools?.placeSign() ?? false, editNearestSign: () => worldTools?.editNearestSign() ?? false, surfaces: ROADS.surfaces.map((x) => x.name) };
/** Build mode (aim-point placement); `buildMode.preview` is the Renderer's buildPreview. */
const buildMode = new BuildMode({ input, ctx: () => menuCtx(), send: (i) => sendIntent(i), device: () => promptDevice(), onPickPiece: () => menus?.open("build"), onBack: () => menus?.open("build"),
  tools: { road: () => worldTools?.road(), sign: () => { if (!worldTools?.editNearestSign()) worldTools?.placeSign(); } },
  aim: () => { const p = session.player; const pt = p !== undefined ? world.get(p, Transform) : undefined; return p !== undefined && pt ? aim.resolve(world, p, pt) : undefined; },
  onActiveChange: (on) => { const c = browserInput.controls; if (c) c.layout = on ? buildTouchLayout : gameplayTouchLayout(); } });
const buildHud = mountBuildHud(root, { buildMode, device: () => promptDevice(), target: canvas,
  screenToWorld: (x, y) => iso ? iso.renderer.camera.cssToWorld(x, y) : screenToWorld(x - innerWidth / 2 + cam.sx, y - innerHeight / 2 + cam.sy),
  blocked: (x, y) => onTouchControl(buildTouchLayout, x, y, innerWidth, innerHeight) });
const buildTouchLayout = { ...DEFAULT_TOUCH_LAYOUTS.building, elements: DEFAULT_TOUCH_LAYOUTS.building.elements.filter((e) => !MENU_BAR_IDS.has(e.id)) };
/** ADR-142: ?dev=sandbox exposes read-only QA handles (build preview, world, player) for automated browser tests. */
{ // ADR-212: memory budget profile + heap-floor leak watchdog (diagnostics only; no UI). window.__survivazMem() for QA/soak.
  const mobile = /android|iphone|ipad|mobile/i.test(navigator.userAgent) || (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches); const prof = MEMORY_BUDGETS[memoryProfileFor(navigator.userAgent, location.search, mobile)];
  const trend = new HeapTrend(); let warned = false; const pm = (): { usedJSHeapSize: number } | undefined => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  setInterval(() => { const m = pm(); if (!m) return; trend.push(performance.now(), m.usedJSHeapSize);
    if (!warned && (trend.leaking(prof) || m.usedJSHeapSize / 1048576 > prof.jsHeapSoftMB)) { warned = true; console.warn(`[memory] ${prof.name} budget: heap ${(m.usedJSHeapSize / 1048576).toFixed(0)} MB, floor slope ${trend.slopeMBPerMin().toFixed(2)} MB/min`); } }, 5000);
  (window as { __survivazMem?: unknown }).__survivazMem = () => ({ profile: prof.name, budget: prof, usedMB: (pm()?.usedJSHeapSize ?? 0) / 1048576, floorMB: trend.lastFloorMB, slopeMBPerMin: trend.slopeMBPerMin(), windows: trend.windows, leaking: trend.leaking(prof), domNodes: document.getElementsByTagName("*").length });
}
if (params.get("dev") === "sandbox") (window as { __qa?: unknown }).__qa = { input, G: () => import("@engine/gameplay"), C: () => import("@engine/core"), iso: () => iso, view: () => camRot?.view, setView: (q: number) => camRot?.set(q), tutorial: () => tutProgress, tutProbe: () => tutProber.probe(), petKit: () => session.devPetKit(), session: () => session, buildMode, send: (i: MenuIntent) => sendIntent(i), ctx: () => menuCtx(), gp: { buildView, listItemIntents, setStallOpenIntent, stallView, nearestStall, inventoryView, gameplayDefs }, world: () => world, player: () => session.player, menus: () => menus, stalls: () => world.isRegistered(StallHeader) ? [...world.query([StallHeader])].length : 0, roads: () => world.isRegistered(Road) ? [...world.query([Road])].length : 0, signs: () => world.isRegistered(Sign) ? [...world.query([Sign, Transform])].map((e) => signText(world, e)) : [], nodes: () => world.isRegistered(ResourceNode) ? [...world.query([ResourceNode, Transform])].filter((n) => world.getField(n, ResourceNode, "amount") !== 0).map((n) => { const t = world.get(n, Transform)!; const d = gameplayDefs(world).resources.get(world.getField(n, ResourceNode, "kind")!); return { x: t.x, y: t.y, key: d?.key, tool: d?.requiredTool }; }) : [], hint: () => { const p = session.player; return p !== undefined ? toolHint(world, p) : undefined; }, animals: () => world.isRegistered(Animal) ? [...world.query([Animal, Transform])].map((e) => { const t = world.get(e, Transform)!; return { e, x: t.x, y: t.y, kind: world.getField(e, Animal, "kind") }; }) : [], net: () => session.client ? { ...session.client.stats, pending: (session.client as unknown as { pending?: unknown[] }).pending?.length } : undefined, zoom: () => ({ user: camZoom?.user, indoor: camZoom?.indoor, cam: iso?.renderer.camera.zoom, cut: iso?.renderer.indoor }), pos: () => { const p = session.player; const t = p !== undefined ? world.get(p, Transform) : undefined; return t ? { x: t.x, y: t.y } : undefined; } };
/** ADR-179/180: Hotbar1..8 (1-8 keys / D-pad, LB+D-pad) now reach the sim as frame edges; only the
 * pad RB/LB tap cycle (HotbarNext/Prev, which needs the filled-slot list) is sent from here, so nothing fires twice. */
function hotbarInput(): void {
  let slot = -1;
  if (promptDevice() === "gamepad") { const dir = input.pressed("HotbarNext") ? 1 : input.pressed("HotbarPrev") ? -1 : 0;
    if (dir) { const c = menuCtx(); if (c) { try { const cells = hotbarCells(inventoryView(c)); const bar = hotbarCycle(cells, cells.findIndex((x) => x.equipped), dir); slot = bar >= 0 ? cells[bar]!.slot : -1; } catch { /* no inventory yet */ } } } }
  if (slot >= 0) sendIntent(equipIntent(slot));
}
/** Per input update: build mode, and the shared Interact action (E / pad X / touch interact) opening stall / wardrobe panels. */
function onUiFrame(): void {
  inGameplay = false;
  { const t = performance.now(); if (t - hotbarT > 120) { hotbarT = t; hotbar.update(hotbarVisible()); compassHud.update(hotbarVisible()); } } // ADR-179 (rebuilds only on change)
  if (input.pressed("ToggleMap")) menus?.toggle("map");
  if (deathUi?.dead) { buildMode.stop(); return; } // ADR-153: dead: only the death screen takes input
  tutorialUi?.frame(input, !!menus?.nav.isOpen);
  if (promptDevice() === "gamepad") markNavFocus(); // ADR-142: pad users get a visible menu focus ring
  lootAutoOpen(); // ADR-160 (tracks the open bag even while a menu is up, so closing the panel does not reopen it)
  if (menus?.nav.isOpen) { if (menus.nav.top !== "build") buildMode.stop(); return; }
  camRot?.poll(); // ADR-253: gameplay, build mode and the road tool all rotate (menus own the D-pad / brackets)
  if (buildMode.active) { worldTools?.road(0); buildMode.update(); buildHud.update(); return; }
  buildHud.update();
  worldTools?.update(); if (worldTools?.tool.active) return; // ADR-122: the Road context owns A/B/X/Y/RS while laying
  { const t = performance.now(), dt = padZoomT ? t - padZoomT : 0; padZoomT = t; if (promptDevice() === "gamepad") camZoom?.nudge(input.axis("Camera.Zoom"), dt); } // ADR-177: hold RB + D-pad ↑/↓
  inGameplay = true; hotbarInput(); // ADR-179/180
  if (input.pressed("ToggleBuild") && promptDevice() === "gamepad") { menus?.open("build"); return; } // ADR-136: pad LB+Y (KBM B is a UINav hotkey)
  { const id = padMenuAction(input); if (id) { menus?.open(id); return; } } // ADR-139: pad-only bindings: Select = inventory, LB+Select = crafting, RB+Select = chat
  if (input.pressed("QuickUse") && farm) { const p = session.player; if (p !== undefined && quickUseFires(safeFarmPrompt(p))) farm.trigger(); }
  if (vehicleCtl?.update()) return; // ADR-170: enter / exit (Interact), engine + headlights while driving
  if (input.pressed("Interact") && !(session.player !== undefined && stanceMode(world, session.player) >= StanceMode.Carry && stanceMode(world, session.player) !== StanceMode.Aim)) { /* ADR-244: carrying → Interact drops; asleep → wakes */ const c = menuCtx(); const t = c && interactPanel(c); if (t?.panel === "trade") menus?.openStall(t.stall); else if (t?.panel === "station") menus?.openStation(t.station, t.kind); else if (t?.panel === "pet") menus?.openPet(t.pet); else if (t?.panel === "worker") menus?.openWorker(t.worker); else if (t?.panel === "loot") menus?.openLoot(t.bag); else if (t?.panel === "storage") menus?.openStorage(t.piece); else if (t?.panel === "lootLocked") farm?.toast("That death bag belongs to another player for 60 seconds"); else if (t?.panel === "wardrobe") menus?.open("wardrobe"); else if (t) menus?.open("character"); }
}
/** ADR-160: a loot bag the server opened for us (primary click / tap fallback) shows in the inventory panel once. */
let lootShown: number | undefined;
function lootAutoOpen(): void {
  const c = menuCtx(); if (!c || !world.isRegistered(LootBag)) return; const box = openContainer(c);
  const bag = box !== undefined && world.has(box, LootBag) ? box : undefined;
  if (bag !== undefined && bag !== lootShown && !menus?.nav.isOpen) menus?.open("inventory");
  lootShown = bag;
}
/** Panel refresh cadence: 250ms, 500ms on low-end devices (few cores / little memory / ?gl=lowend). */
const LOW_END = params.get("gl") === "lowend" || (navigator.hardwareConcurrency ?? 8) <= 4 || ((navigator as { deviceMemory?: number }).deviceMemory ?? 8) <= 2;
export const MENU_REFRESH_MS = LOW_END ? 500 : 250;
let menuRefreshAt = 0;
/** ADR-172: a party / clan invite used to show only inside its panel. Now a toast plus a badge on Party / clan when one arrives; the badge clears when the invite is answered or expires. */
let inviteSeen = { party: 0, clan: 0 }; let inviteCheckAt = 0;
function inviteNotices(): void {
  const now = performance.now(); if (now < inviteCheckAt || !menus) return; inviteCheckAt = now + 400;
  const c = menuCtx(); if (!c) return;
  let pi: ReturnType<typeof partyView>["invite"]; let ci: ReturnType<typeof clanView>["invite"];
  try { pi = partyView(c).invite; ci = clanView(c).invite; } catch { return; }
  const pk = pi?.party ?? 0, ck = ci?.clan ?? 0;
  if (pk !== inviteSeen.party) { if (pi) farm?.toast(`${pi.fromName} invited you to a party: open Party`); menus.setBadge("party", pi ? 1 : 0); }
  if (ck !== inviteSeen.clan) { if (ci) farm?.toast(`${ci.fromName} invited you to a clan: open Clan`); menus.setBadge("clan", ci ? 1 : 0); }
  inviteSeen = { party: pk, clan: ck };
}
let indoorT = 0;
let renderAlpha = 1; // ADR-173: name tags follow the same interpolated position as the sprites
function render(w: World, alpha: number): void {
  renderAlpha = alpha;
  wireChat();
  try { deathUi?.frame(); } catch { /* never break a frame */ }
  const dayFrac = sampleDayClock(w, session.client, alpha); // ADR-115: one clock for lighting + HUD
  const sunFrac = sunFraction(w, dayFrac); // ADR-283: seasonal sunrise / sunset for day-night audio + FX
  audioFrame(w, sunFrac);
  inviteNotices();
  if (menus?.nav.isOpen) { const now = performance.now(); if (now >= menuRefreshAt) { menuRefreshAt = now + MENU_REFRESH_MS; menus.refresh(); } }
  iso?.syncGhost(buildMode.preview, w);
  if (iso) {
    iso.status = { localServer: spStatus?.state ?? (session.client ? "n/a (remote)" : "idle"), snapshots: session.client?.stats.snapshots ?? 0, ...(spStatus?.error ? { error: spStatus.error } : {}) };
    { const t = performance.now(); const dt = indoorT ? t - indoorT : 0; camZoom?.setIndoor(iso.renderer.indoor, dt); camZoom?.setBuild(buildMode.active, dt); indoorT = t; } // ADR-206: ease in under a roof; building mode zooms in further for precise placement
    try { syncUnderground(iso.renderer as { underground?: number }, w, session.player); } catch { /* never break a frame */ } // ADR-263
    iso.corrections = session.client; fxLayer.pre();
    const before = iso.renderer.completeFrames;
    iso.render(w, session.client?.tiles.tiles, session.player, alpha, dayFrac);
    if (iso.renderer.completeFrames !== before) camRot?.frameComplete();
    try { fxLayer.draw(sunFrac); } catch { /* effects must never break a frame */ }
    diag?.afterRender(); return;
  }
  if (!ctx) return;
  const canvas = debugCanvas;
  const dpr = devicePixelRatio || 1;
  if (canvas.width !== innerWidth * dpr) { canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; }
  const p = session.player; const pt = p !== undefined ? w.get(p, Transform) : undefined;
  cam = worldToScreen(pt?.x ?? 16, pt?.y ?? 16);
  ctx.setTransform(dpr, 0, 0, dpr, (innerWidth / 2 - cam.sx) * dpr, (innerHeight / 2 - cam.sy) * dpr);
  ctx.clearRect(-1e5, -1e5, 2e5, 2e5);
  const { tileW: tw, tileH: th } = DEFAULT_ISO;
  const map: TileMap = session.client?.tiles.tiles ?? placeholder;
  const cx = Math.floor(pt?.x ?? 16), cy = Math.floor(pt?.y ?? 16);
  for (let y = cy - 20; y < cy + 20; y++) for (let x = cx - 20; x < cx + 20; x++) {
    const s = worldToScreen(x, y); ctx.fillStyle = colors[map.getTile(x, y)] ?? "#333";
    ctx.beginPath(); ctx.moveTo(s.sx, s.sy); ctx.lineTo(s.sx + tw / 2, s.sy + th / 2); ctx.lineTo(s.sx, s.sy + th); ctx.lineTo(s.sx - tw / 2, s.sy + th / 2); ctx.fill();
  }
  const ts = w.store(Transform), ps = w.store(PrevTransform);
  for (const e of w.query([Transform])) {
    const i = entityIndex(e); const cur = ts.get(i)!; const prev = ps.get(i) ?? cur;
    const s = worldToScreen(lerp(prev.x, cur.x, alpha), lerp(prev.y, cur.y, alpha));
    ctx.fillStyle = e === p ? "#fd4" : w.predicted.has(e) ? "#fd4" : "#9cf"; ctx.beginPath(); ctx.arc(s.sx, s.sy + th / 2 - 12, e === p ? 10 : 6, 0, Math.PI * 2); ctx.fill();
  }
}

let loop: FixedLoop = createGameLoop(world, { render });
function useWorld(w: World): void { world = w; loop = createGameLoop(w, { render }); sendStoredLook(); }

// ---- ADR-114 character creator (after the mode choice, before entering the world) ----
async function runCreatorShot(shot: NonNullable<typeof creatorShot>): Promise<void> {
  const w = window as { __creatorReady?: unknown }; const t0 = performance.now(); let stage = "art";
  const timer = setTimeout(() => { if (!w.__creatorReady) w.__creatorReady = { ok: false, error: "timeout", seed: shot.seed, facing: shot.facing, stage, ms: Math.round(performance.now() - t0), hidden: document.visibilityState }; }, shot.timeoutMs);
  await isoReady; stage = "catalog"; const catalog = iso?.registry.cosmetics?.size ? iso.registry.cosmetics : undefined;
  if (!catalog) { clearTimeout(timer); w.__creatorReady = { ok: false, seed: shot.seed, error: "customization pack not loaded" }; return; }
  const appearance = creatorShotLook(catalog, shot.seed, shot.body); stage = "creator";
  void showCharacterCreator({ root: uiRoot(), catalog, initial: { v: 1, name: `Survivor ${shot.seed}`, appearance }, title: "Create your character", pads: () => [],
    preview: iso ? { registry: iso.registry, sources: iso.renderer.atlas.sources, mode: params.get("preview") === "2d" ? "canvas2d" : "auto" } : undefined, artBase: `${import.meta.env.BASE_URL}art/ui/creator/`,
    shot: { facing: shot.facing, freeze: shot.freeze, onStage: (s) => { stage = s; }, onReady: ({ renderer }) => { clearTimeout(timer); if (!w.__creatorReady) w.__creatorReady = { ok: true, seed: shot.seed, facing: shot.facing, body: appearance.bodyType, freeze: shot.freeze, renderer, appearance, ms: Math.round(performance.now() - t0) }; } } });
}
let activeChar: StoredCharacter | undefined;
/** Stored character for this save, or the creator (also when ?editchar=1 / "Edit character" asked for it). Undefined = Back. */
async function ensureCharacter(kind: CharacterSaveKind): Promise<StoredCharacter | undefined> {
  const stored = loadCharacter(kind, SLOT); let edit = params.get("editchar") === "1";
  try { if (sessionStorage.getItem(EDIT_CHAR_KEY)) { edit = true; sessionStorage.removeItem(EDIT_CHAR_KEY); } } catch { /* private mode */ }
  if (stored && !edit) return stored;
  await isoReady; const catalog = iso?.registry.cosmetics?.size ? iso.registry.cosmetics : undefined;
  const seed: StoredCharacter | undefined = stored ?? (session.savedName ? { v: 1, name: session.savedName, appearance: undefined as never } : undefined);
  const c = await showCharacterCreator({ root: uiRoot(), catalog, initial: seed?.appearance ? seed : undefined, preview: iso && catalog ? { registry: iso.registry, sources: iso.renderer.atlas.sources, mode: previewModeFromQuery(params) } : undefined, artBase: `${import.meta.env.BASE_URL}art/ui/creator/` });
  if (c) saveCharacter(kind, SLOT, c); return c;
}
const playerName = (): string => activeChar?.name ?? session.savedName ?? "";
/** On join: send the stored look as SetAppearance (server validates: catalog, unlocks, first-join gate). Existing
 * characters (Wardrobe.created) keep their server look unless the creator was just used to edit it. */
let lookSent: World | undefined, lookEdited = false;
function sendStoredLook(): void {
  const c = activeChar; if (!c) return; const w = world; let tries = 0;
  const t = setInterval(() => {
    if (world !== w || lookSent === w || ++tries > 100) { clearInterval(t); return; }
    const p = session.player; if (p === undefined) return;
    clearInterval(t); lookSent = w;
    if (hasCreatedLook(w, p) && !lookEdited) return;
    if (!sendIntent(setAppearanceIntent(c.appearance))) console.warn("appearance not sent");
  }, 100);
}

let pumpLocal: ((ms: number) => void) | undefined;
/** Singleplayer local-server status (./local.ts localStatus) once singleplayer starts; diag + camera fallback. */
let spStatus: { state: string; error: string | undefined } | undefined;
const settings = loadSettings();
/** Singleplayer: in-browser authoritative server (lazy chunk) in "singleplayer" mode; human bots spawn automatically. */
async function startSingleplayer(chosenSeed?: number): Promise<void> {
  const { createLocalServer, openBrowserStore, localStatus } = await import("./local.js");
  spStatus = localStatus;
  try {
    const bots = Number(params.get("bots") ?? settings.bots);
    localStatus.state = "opening-store";
    stampPlayed("singleplayer");
    const devSandbox = params.get("dev") === "sandbox"; // ADR-140: QA sandbox, own throwaway save slot
    const dbName = devSandbox ? "engine-sandbox" : `engine-local-${params.get("player") ?? "1"}`;
    await isoReady; const catalog = iso?.registry.cosmetics?.size ? iso.registry.cosmetics : undefined;
    const log = (m: string): void => console.info(`[local] ${m}`);
    // ADR-105: run the server sim + bots in a Web Worker (keeps the main thread for render/input, big win on phones);
    // ?worker=0, no Worker support, or a worker that fails/stalls on startup falls back to the in-tab server.
    const { startWorkerServer } = await import("./local-bridge.js");
    // ADR-254: ?seed=N forces a reproducible world; otherwise createLocalServer picks a random seed for a new save.
    const seedParam = params.get("seed"); const seedOpt = chosenSeed !== undefined ? { seed: chosenSeed } : seedParam != null && seedParam !== "" && Number.isFinite(Number(seedParam)) ? { seed: Number(seedParam) } : {};
    let local: import("./local-bridge.js").LocalServerHandle | undefined = params.get("worker") === "0" ? undefined
      : await startWorkerServer({ dbName, bots, devSandbox, worldRules: newWorldRules(settings), catalog, status: localStatus, log, timeoutMs: 15000, ...seedOpt });
    if (!local) {
      const store = await openBrowserStore(dbName);
      localStatus.state = "starting";
      const inTab = await createLocalServer({ store, bots, devSandbox, worldRules: newWorldRules(settings), ...seedOpt, ...(catalog ? { catalog } : {}), log });
      pumpLocal = inTab.pump; if (devSandbox) (window as { __qaServer?: unknown }).__qaServer = inTab.game; // ADR-145 QA: in-tab server (?worker=0)
      local = { inWorker: false, createTransport: () => inTab.createTransport(), save: async () => { await inTab.game.persist?.saveAll(); }, stop: () => inTab.stop() };
    }
    log(local.inWorker ? "server running in Web Worker" : "server running in tab");
    const srv = local;
    let wiped = false; // after "Delete save" nothing may write the slot again
    addEventListener("pagehide", () => { if (!wiped) void srv.save(); });
    leaveCurrent = async () => { if (!wiped) await srv.save(); };
    deleteInfo = () => ({ label: "Delete save", settingsOption: true,
      message: `Delete singleplayer save slot ${SLOT}: the world, your character, inventory, bots' memories and appearance. This can't be undone.`,
      run: async ({ resetSettings }) => {
        wiped = true; pumpLocal = undefined; session.onEnded = undefined; session.disconnect();
        await srv.stop(); // closes the IndexedDB connection so the delete isn't blocked by this tab
        const { wipeSingleplayerSave } = await import("./delete-progress.js");
        const r = await wipeSingleplayerSave({ slot: SLOT, resetSettings });
        setTimeout(() => backToMenu(r.ok ? r.message : `${r.message} Then use Main menu → Manage saves.`), r.ok ? 1200 : 4000);
        if (!r.ok) throw new Error(r.message);
        return r.message;
      } });
    localStatus.state = "connecting";
    useWorld(await session.connect("local", playerName(), srv.createTransport()));
    localStatus.state = "running";
    sessionInfo = () => ({ label: `Singleplayer · World seed: ${menuWorldSeed ?? chosenSeed ?? seedOpt.seed ?? "random"}`, leaveLabel: "Main menu", onLeave: quitToMenu });
  } catch (e) {
    localStatus.state = "failed"; localStatus.error = e instanceof Error ? e.message : String(e);
    showRenderError("Singleplayer failed to start", `${localStatus.error}\nReload, or close other tabs of the game — please report this text.`);
    throw e;
  }
}
/** P2P: return to the main menu with a one-shot notice (the menu flow is one-shot, so reload). */
const P2P_NOTICE_KEY = "engine-p2p-notice";
/** ADR-236: a multiplayer session ending lands on the Multiplayer page (its notice shown there). */
const MENU_PAGE_KEY = "engine-menu-page";
function backToMenu(notice: string, page?: "multiplayer"): void {
  try { sessionStorage.setItem(P2P_NOTICE_KEY, notice); if (page) sessionStorage.setItem(MENU_PAGE_KEY, page); } catch { /* private mode */ }
  location.reload();
}
async function p2pSignaling(): Promise<import("./p2p.js").Signaling> {
  const { PeerJsSignaling, resolveIceServers } = await import("./p2p.js");
  return new PeerJsSignaling({ iceServers: resolveIceServers(params.get("ice") ?? import.meta.env["VITE_ICE_SERVERS"]) });
}
/** Host game: authoritative server in this tab (mode "multiplayer"), guests over WebRTC, room code via signaling. */
async function startHost(chosenSeed?: number): Promise<void> {
  const [{ startP2PHost }, { openBrowserStore }, { hostPlayerCap, detectDevice }] = await Promise.all([import("./host.js"), import("./local.js"), import("./p2p.js")]);
  const cap = hostPlayerCap(detectDevice(), settings.hostCap);
  let host: import("./host.js").P2PHost;
  try {
    stampPlayed("hosted");
    host = await startP2PHost({ ...(chosenSeed !== undefined ? { seed: chosenSeed } : {}), worldRules: newWorldRules(), signaling: await p2pSignaling(), store: await openBrowserStore(`engine-p2p-host-${params.get("player") ?? "1"}`), cap: cap.cap, capDetail: cap.detail,
      ...(await isoReady, iso?.registry.cosmetics?.size ? { catalog: iso.registry.cosmetics } : {}), log: (m) => console.info(`[host] ${m}`) });
  } catch (e) { backToMenu(`Couldn't host: ${e instanceof Error ? e.message : String(e)}`, "multiplayer"); return; }
  pumpLocal = host.local.pump;
  const { formatRoomCode } = await import("./p2p.js");
  const end = (): void => { void host.leave().finally(() => backToMenu("Session ended.", "multiplayer")); };
  leaveCurrent = () => host.leave();
  deleteInfo = () => ({ label: "Delete hosted world", settingsOption: false,
    message: "The hosted world can't be deleted while you are hosting it. End the session first, then use Main menu → Manage saves → Delete hosted world.",
    run: () => Promise.reject(new Error("End the session first (Pause → End session), then delete it from the main menu.")) });
  // ADR-236: room code, players and status live in Pause → Session (no box over the game)
  sessionInfo = () => ({ label: `World seed: ${host.local.game.world.seed} · Hosting${cap.mobile ? " (mobile)" : ""} · keep this tab open. Friends join from Multiplayer → Join a friend.`, leaveLabel: "End session", onLeave: end,
    rows: () => [["Room code", formatRoomCode(host.code)], ["Players", `${host.players().length}/${host.cap}`], ["Status", session.status]],
    players: () => host.players() });
  addEventListener("beforeunload", () => host.unload());
  addEventListener("pagehide", () => host.unload());
  useWorld(await session.connect("p2p-host", playerName(), host.hostTransport));
  host.hostClientId = session.client?.clientId;
}
/** Join with code: guest over WebRTC; "Host ended the session" (or a lost link) returns to the menu. */
async function startJoin(raw: string): Promise<void> {
  const [{ guestTransport }, { normalizeRoomCode, formatRoomCode }] = await Promise.all([import("./host.js"), import("./p2p.js")]);
  const code = normalizeRoomCode(raw);
  if (!code) { backToMenu("That isn't a valid room code (6 letters/digits, e.g. ABC-234).", "multiplayer"); return; }
  session.onEnded = (detail) => backToMenu(detail, "multiplayer");
  leaveCurrent = () => { session.onEnded = undefined; session.disconnect(); };
  deleteInfo = () => remoteDeleteInfo("this host", () => { session.onEnded = undefined; session.disconnect(); backToMenu("Your progress on that host was deleted. Join again to start fresh."); });
  sessionInfo = () => ({ label: `Joined a friend's game (room ${formatRoomCode(code)}).`, leaveLabel: "Leave", onLeave: () => { session.onEnded = undefined; session.disconnect(); backToMenu("You left the session.", "multiplayer"); },
    rows: () => [["Room code", formatRoomCode(code)], ["Status", statusText()], ["Ping", pingLabel(session.rttMs)]] });
  netStatus ??= mountNetStatus(session, uiRoot());
  try { useWorld(await session.connect(`p2p:${code}`, playerName(), guestTransport(await p2pSignaling(), code))); }
  catch (e) { session.onEnded = undefined; backToMenu(`Couldn't join ${formatRoomCode(code)}: ${e instanceof Error ? e.message : String(e)}`, "multiplayer"); }
}
/** Remote server / P2P guest: ask the server to delete *my* character (DeleteMyProgressCmd, ADR-099); resolves on ProgressDeleted. */
function remoteDeleteInfo(where: string, after: () => void): NonNullable<ReturnType<NonNullable<typeof deleteInfo>>> {
  return { label: "Delete my progress", settingsOption: false,
    message: `Delete your character on ${where}: inventory, appearance, party/clan membership (leadership passes on) and market stalls. Other players are not affected. This can't be undone.`,
    run: () => new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => { session.onProgressDeleted = undefined; reject(new Error("No answer from the server — try again later.")); }, 10_000);
      session.onProgressDeleted = () => { clearTimeout(t); session.onProgressDeleted = undefined; resolve("Progress deleted. Starting a new character…"); setTimeout(after, 800); };
      if (!session.deleteMyProgress()) { clearTimeout(t); session.onProgressDeleted = undefined; reject(new Error("Not connected.")); }
    }) };
}
const statusText = (): string => `${session.status}${session.detail && session.detail !== session.savedUrl && session.status !== "connected" ? ` (${session.detail})` : ""}`;
function connectRemote(url: string): void {
  leaveCurrent = () => session.disconnect();
  // ADR-236: Pause → Session replaces the old connect box: server, status, ping, account, Reconnect / Disconnect
  sessionInfo = () => ({ label: "Dedicated server.", leaveLabel: session.status === "connected" ? "Disconnect" : "Main menu",
    onLeave: () => { session.disconnect(); if (useMenu) backToMenu("Disconnected from the server.", "multiplayer"); },
    rows: () => [["Server", url], ["Status", statusText()], ["Ping", session.status === "connected" ? pingLabel(session.rttMs) : "—"], ["Account", session.account ? `${session.account.slice(0, 8)}…${session.restored ? " (restored)" : ""}` : "new"]],
    actions: () => session.status === "connected" || session.status === "connecting" ? [] : [["Reconnect", () => connectTo(url, playerName())]] });
  deleteInfo = () => session.status === "connected" ? remoteDeleteInfo("this server", () => {
    // the server kicks us shortly; reconnect with the same token = a fresh character, straight into the creator
    session.disconnect(); session.connect(url, session.savedName ?? "").then((w) => { useWorld(w); menus?.open("character"); }, (e: unknown) => console.warn("reconnect failed", e));
  }) : undefined;
}
const connectTo = (url: string, name: string): void => { connectRemote(url); session.connect(url, name).then(useWorld, (e: unknown) => console.warn("connect failed", e)); };
let netStatus: ReturnType<typeof mountNetStatus> | undefined;
const defaultUrl = serverParam ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname || "localhost"}:7777`;
/**
 * Task 14: once the world is loaded (session connected, player spawned, nearby chunks streamed), tell the
 * server with gameplay.ready — until then the server freezes this player's vitals, diseases, pet hunger
 * and pack spoilage, so nothing drains while the player is still loading in.
 */
const signalReady = async (): Promise<void> => {
  const ok = await waitForWorldReady(session);
  if (ok) sendIntent(readyIntent());
};
/** Task 14: the second loading screen — same style as the first — over a world start, until it is loaded. */
const enterWorld = async (start: () => Promise<unknown>): Promise<void> => {
  if (!boot) { await start(); await signalReady(); return; }
  boot.showLoading("Loading world…");
  let started = false;
  try { await start(); started = true; } catch (e) { console.error("start failed", e); }
  if (started) {
    const ok = await waitForWorldReady(session, { onProgress: (f) => boot.progress(f, f >= 1 ? "Ready" : "Loading world…") });
    if (ok) sendIntent(readyIntent());
  }
  boot.hide();
};
if (creatorShot) {
  runCreatorShot(creatorShot).catch((e: unknown) => { (window as { __creatorReady?: unknown }).__creatorReady = { ok: false, seed: creatorShot.seed, error: String(e) }; });
} else if (boot) {
  void (async () => {
    await isoReady; loadProgress.complete(); await boot.finish("Ready");
    let notice: string | undefined, page: string | null = null;
    try { notice = sessionStorage.getItem(P2P_NOTICE_KEY) ?? undefined; sessionStorage.removeItem(P2P_NOTICE_KEY); page = sessionStorage.getItem(MENU_PAGE_KEY); sessionStorage.removeItem(MENU_PAGE_KEY); } catch { /* ignore */ }
    const { hostPlayerCap, detectDevice } = await import("./p2p.js"); const hc = hostPlayerCap(detectDevice(), settings.hostCap);
    const choice = await boot.menu({ slot: SLOT, hostedStatic: import.meta.env["VITE_DEFAULT_OFFLINE"] === "1", defaultUrl, ...(notice ? { notice } : {}), ...(page === "multiplayer" ? { page } : {}),
      ...(params.has("seed") ? { initialSeed: params.get("seed")! } : {}),
      savedSeed: async (mode) => {
        const { openBrowserStore } = await import("./local.js");
        const db = mode === "host" ? `engine-p2p-host-${SLOT}` : params.get("dev") === "sandbox" ? "engine-sandbox" : `engine-local-${SLOT}`;
        const store = await openBrowserStore(db);
        try { const seed = store.readMeta()?.seed; menuWorldSeed = seed; return seed; }
        finally { await store.close(); }
      },
      mp: { hostCap: `${hc.cap}${hc.mobile ? " (mobile host)" : ""}` } });
    if (choice.kind === "singleplayer" || choice.kind === "host") menuWorldSeed = choice.seed ?? menuWorldSeed;
    boot.hide();
    const kind: CharacterSaveKind = choice.kind === "singleplayer" ? "singleplayer" : choice.kind === "host" ? "hosted" : "remote";
    const before = loadCharacter(kind, SLOT); tutorialNewGame = !before; activeChar = await ensureCharacter(kind);
    if (!activeChar) { backToMenu(""); return; }
    lookEdited = !before || JSON.stringify(before) !== JSON.stringify(activeChar);
    startMenus();
    await enterWorld(async () => {
      if (choice.kind === "singleplayer") await startSingleplayer(choice.seed);
      else if (choice.kind === "host") await startHost(choice.seed);
      else if (choice.kind === "join") await startJoin(choice.code);
      else { // multiplayer: remote server, no local human bots. ADR-236: no box over the game; a failed first connect returns to the Multiplayer page
        netStatus ??= mountNetStatus(session, uiRoot());
        connectRemote(choice.url);
        session.connect(choice.url, playerName()).then(useWorld, (e: unknown) => backToMenu(`Couldn't connect to ${choice.url}: ${e instanceof Error ? e.message : String(e)}`, "multiplayer"));
      }
    });
  })().catch((e: unknown) => console.error("start failed", e));
} else if (!serverParam && (params.get("offline") === "1" || (params.get("menu") === "0" && import.meta.env["VITE_DEFAULT_OFFLINE"] === "1"))) {
  startMenus(); startSingleplayer().then(signalReady).catch((e: unknown) => console.error("local server failed", e));
} else {
  // ?server= / ?menu=0 (tests, QA links): connect straight away, no box over the game (ADR-236); Pause → Session has
  // Reconnect / Disconnect and the tiny indicator shows problems. ?autoconnect=0 = stay idle until Session → Reconnect.
  startMenus(); netStatus ??= mountNetStatus(session, uiRoot());
  const url = serverParam ?? session.savedUrl ?? defaultUrl;
  connectRemote(url);
  if (params.get("autoconnect") !== "0") { connectTo(url, session.savedName ?? ""); void signalReady(); }
}

/** ADR-275 contextual-tip triggers: cheap reads of the local player (each guarded; a missing component just means "not yet"). */
function tutorialTriggers(p: Entity | undefined, pt: { x: number; y: number } | undefined, sv: { stamina?: number; maxStamina?: number } | undefined): Partial<ProbeSample> {
  const out: { -readonly [K in keyof ProbeSample]?: ProbeSample[K] } = { dead: !!deathUi?.dead };
  if (p === undefined) return out;
  try { out.nearNode = toolHint(world, p) !== undefined; } catch { /* none */ }
  try { if (world.has(p, Health)) { const h = world.get(p, Health)!; out.hp = h.hp; out.hpMax = h.max; } } catch { /* none */ }
  if (sv?.stamina !== undefined) out.stamina = (sv.stamina / Math.max(1, sv.maxStamina ?? 100)) * 100;
  try { const t = timeOfDay(world); if (t.dayLengthTicks > 0) { out.hours = sunFractionOf(t) * 24; out.day = worldDays(world); } } catch { /* none */ }
  try { if (pt && world.isRegistered(Zombie)) { let best = Infinity; for (const z of world.query([Zombie, Transform])) { const t = world.get(z, Transform)!; best = Math.min(best, Math.hypot(t.x - pt.x, t.y - pt.y)); } if (best < Infinity) out.zombieDist = best; } } catch { /* none */ }
  try { out.brokenLeg = hasDisease(world, p, "broken_leg"); } catch { /* none */ }
  try { if (world.isRegistered(Progression) && world.has(p, Progression)) { const g = world.get(p, Progression) as unknown as { points: number; tpoints?: ArrayLike<number>; nodes?: ArrayLike<number> }; let pts = g.points; for (const v of Array.from(g.tpoints ?? [])) pts += v; let n = 0; for (const w of Array.from(g.nodes ?? [])) { let x = w >>> 0; while (x) { n += x & 1; x >>>= 1; } } out.skillPoints = pts; out.skillNodes = n; } } catch { /* none */ }
  try { out.nearBed = bedNear(world, p) !== undefined; } catch { /* none */ }
  try { out.nearBag = liftableNear(world, p) !== undefined; } catch { /* none */ }
  return out;
}
const promptDevice = (): PromptDevice => { const c = input.activeDevice?.deviceClass; return c === "gamepad" || c === "touch" ? c : "keyboardMouse"; };
tutorialUi = mountTutorial({ root, progress: tutorialProgress(), bindings: input, device: promptDevice,
  hidden: () => session.player === undefined || !!deathUi?.dead || !!document.querySelector(".creator:not([hidden]),#boot:not([hidden])"),
  probe: () => {
    const p = session.player; const pt = p !== undefined ? world.get(p, Transform) : undefined; const c = menuCtx();
    let items: Map<string, number> | undefined; let tk = 0; let pieces: number | undefined; let campfires: number | undefined; let stations: number | undefined; let sv: { hunger: number; thirst: number; stamina?: number; maxStamina?: number } | undefined;
    if (c) { try { items = new Map(); for (const v of inventoryView(c)) if (v.item) items.set(v.name, (items.get(v.name) ?? 0) + v.count); } catch { items = undefined; }
      try { tk = heldTool(world, c.player, gameplayDefs(world)).kind; } catch { tk = 0; }
      try { if (pt && world.isRegistered(BuildPiece)) { pieces = 0; campfires = 0; stations = 0; const defs = gameplayDefs(world); for (const e of world.query([BuildPiece, Transform])) { const t = world.get(e, Transform)!; if ((t.x - pt.x) ** 2 + (t.y - pt.y) ** 2 < 144) { pieces++; const def = defs.pieces.get(world.getField(e, BuildPiece, "type") ?? -1); if (def?.key === "campfire") campfires++; if (def && def.station !== 0) stations++; /* StationKind.None = 0 */ } } } } catch { pieces = undefined; campfires = undefined; stations = undefined; }
      try { if (world.has(c.player, Survival)) sv = world.get(c.player, Survival) as { hunger: number; thirst: number; stamina: number; maxStamina: number }; } catch { /* none */ } }
    const av = input.vector("Aim");
    tutProber.sample({ pos: pt ? { x: pt.x, y: pt.y } : undefined, sprinting: !!(c?.player !== undefined && world.getField(c.player, PlayerIntent, "sprint") && (sv?.stamina ?? 0) > 0), zoom: iso?.renderer.camera.zoom, aiming: Math.hypot(av[0], av[1]) > 0.3 || input.down("Primary"),
      items, menuOpen: !!menus?.nav.isOpen, hunger: sv?.hunger, thirst: sv?.thirst, toolKind: tk, buildActive: buildMode.active, buildRot: buildMode.rot, menuTop: menus?.nav.top, pieces, campfires, stations, ...tutorialTriggers(p, pt, sv) });
    return tutProber.probe();
  } });
input.onDeviceChange(() => tutorialUi?.update());
// ADR-153: death screen + Respawn (mouse / touch / keyboard / gamepad) and the death-bag compass; above the tutorial and menus.
deathUi = mountDeathScreen(root, { world: () => world, player: () => session.player,
  respawn: () => { const c = session.client; if (!c?.connected) return false; try { return c.sendCommand(gameplayNet(RespawnCmd), {} as never) !== false; } catch { return false; } },
  onDeath: () => { menus?.nav.closeAll(); buildMode.stop(); }, view: () => input.viewQuarter });
// ADR-253: four 90° views (KBM [ / ], pad RB + D-pad ←/→ or LT + D-pad ←/→ in build mode, ⟲ / ⟳ HUD for mouse / touch)
camRot = attachCameraRotate({ target: () => iso?.renderer, input, root, frameBoundary: true, spinTarget: () => canvas,
  pivot: () => iso?.rotationPivot(),
  onChange: (q) => { audio.mixer.view = q; },
  hidden: () => !!document.querySelector("[data-boot=menu]") || !!deathUi?.dead || !!menus?.nav.isOpen || session.player === undefined });
farm = mountFarmPrompt(root, {
  world: () => world, player: () => session.player, device: promptDevice, hidden: () => !!menus?.nav.isOpen || buildMode.active || !!vehicleCtl?.driving,
  key: (action) => controlLabel(input.bindings(promptDevice(), "Gameplay").find((b) => b.binding.action === action)?.binding.control),
  use: (p) => { if (p.action === "Harvest") { if (p.target !== undefined) sendIntent({ cmd: GatherCmd, args: { target: p.target }, entities: ["target"] }); } else if (p.slot !== undefined) sendIntent({ cmd: UseCmd, args: { slot: p.slot } }); },
});
// ADR-179: visible hotbar (inventory slots 1..8) bottom-centre; equips like the Hotbar1..8 bindings
const hotbar = mountHotbar({ selectedSlot: () => session.player !== undefined ? world.getField(session.player, HotbarSelection, "slot") : undefined, device: promptDevice, equip: (slot) => sendIntent(selectHotbarIntent(slot)),
  activate: (slot) => { const c = menuCtx(); sendIntent(c && hotbarConsumes(c.world, c.player, slot) ? useIntent(slot) : selectHotbarIntent(slot)); }, /* ADR-289: single tap selects, double tap uses / equips */ icon: (icon, item) => panelIcon(world, icon, String(item)),
  move: (from, to) => sendIntent(moveSlotIntent(from, to)), /* ADR-231: drag between HUD hotbar slots */
  view: () => { const c = menuCtx(); if (!c) return undefined; try { return inventoryView(c); } catch { return undefined; } } });
let hotbarT = 0;
const hotbarVisible = (): boolean => !deathUi?.dead && !menus?.nav.isOpen && !buildMode.active && !worldTools?.tool.active && !document.querySelector("[data-boot=menu]");
// Compass HUD (Task 9): top-centre strip, same visibility as the hotbar, updated with it.
// Task 10: while the player moves the compass shows their facing; once they stand still it settles north.
const compassIdle = createIdleTracker();
const compassHud = mountCompassHud({ view: () => input.viewQuarter, heading: () => { const p = session.player; if (p === undefined) return undefined; const t = world.get(p, Transform); if (!t) return undefined; return compassIdle.isIdle(t, performance.now()) ? idleCompass() : compassOf(t.facing); } });
// ADR-119..121: sign labels, road drag tool (G), sign placing (N), settlement label, horde toasts + cues
vehicleCtl = mountVehicleControls(root, { world: () => world, player: () => session.player, send: (i) => sendIntent(i), input,
  toast: (t) => farm?.toast(t), onDrivingChange: () => { const c = browserInput.controls; if (c && !buildMode.active) c.layout = gameplayTouchLayout(); } });
worldTools = mountWorldTools(root, { world: () => world, player: () => session.player, camera: () => iso?.renderer.camera, send: (i) => sendIntent(i), hidden: () => !!menus?.nav.isOpen || buildMode.active || !!vehicleCtl?.driving, sound: (k) => audio.mixer.play(k),
  input, device: promptDevice, canvas,
  openModal: (id, el, onClose) => menus ? menus.nav.open(id, el, onClose) : (root.append(el), { close: () => el.remove() }),
  onControl: (x, y) => { const r = canvas.getBoundingClientRect(); return !!browserInput.controls?.geometry().some((g) => g.visible && Math.hypot(g.x - (x - r.left), g.y - (y - r.top)) <= g.r + 8); } });
// ADR-128: node health bars + hit particles + "+3 Wood" pickup toasts
mountGatherFx(root, { world: () => world, player: () => session.player, camera: () => iso?.renderer.camera, hidden: () => !!menus?.nav.isOpen || buildMode.active || !!vehicleCtl?.driving, device: promptDevice,
  icon: (item, key) => panelIcon(world, key, String(item)) });
// ADR-214: pooled VFX layer (impacts, muzzle/tracers, swings, deaths, explosions, fire embers, footsteps, ambient life,
// screen cues) on both renderers; fed by the replicated world + the audio director's events, drawn after iso.render.
const fxLayer = mountFx(root, { world: () => world, player: () => session.player, renderer: () => iso?.renderer as never, view: () => iso,
  audio: () => audio, ground: (x, y, z) => groundZ(session.client?.tiles.tiles, x, y, z), tile: (x, y) => session.client?.tiles.tiles.getTile(x, y) ?? 3,
  hidden: () => !!menus?.nav.isOpen, lowEnd: LOW_END, console: memoryProfileFor(navigator.userAgent, location.search, false) === "console" });
{ const qa = (window as { __qa?: Record<string, unknown> }).__qa; if (qa) qa["fx"] = fxLayer; }
// ADR-196: build ghost validity outline + magnet snap-edge highlight (WebGL2 and Canvas2D)
mountSnapOverlay(root, { preview: () => (buildMode.active ? buildMode.preview : undefined), camera: () => iso?.renderer.camera ?? (ctx ? debugCamera(cam, innerWidth, innerHeight, devicePixelRatio || 1) : undefined), hidden: () => !!menus?.nav.isOpen, groundZ: () => iso?.ghostZ });
// ADR-161: floating loot-bag / dropped-item labels with the Interact prompt
let nameTagsOn = true, nameTagsAt = 0; // settings read at most once a second (no per-frame JSON parse)
mountNameTags(root, { artBase: `${import.meta.env.BASE_URL}art/`, world: () => world, player: () => session.player, alpha: () => renderAlpha, enabled: () => { const n = performance.now(); if (n >= nameTagsAt) { nameTagsAt = n + 1000; nameTagsOn = loadSettings().nameTags !== false; } return nameTagsOn; },
  camera: () => iso?.renderer.camera ?? (ctx ? debugCamera(cam, innerWidth, innerHeight, devicePixelRatio || 1) : undefined),
  names: () => { const c = session.client; return c ? { get: (id: number) => { const n = c.names.get(id); if (n === undefined && id) c.names.want([id]); return n; } } : undefined; },
  hidden: () => !!menus?.nav.isOpen });
// Task 14: floating badge above each pet showing what it is doing (guard / fight / return / follow / stay / eat)
mountPetStatus(root, { world: () => world, camera: () => iso?.renderer.camera ?? (ctx ? debugCamera(cam, innerWidth, innerHeight, devicePixelRatio || 1) : undefined), hidden: () => !!menus?.nav.isOpen, alpha: () => renderAlpha });
mountLootLabels(root, { world: () => world, player: () => session.player, camera: () => iso?.renderer.camera ?? (ctx ? debugCamera(cam, innerWidth, innerHeight, devicePixelRatio || 1) : undefined), hidden: () => !!menus?.nav.isOpen || buildMode.active || !!vehicleCtl?.driving,
  device: promptDevice, key: () => controlLabel(input.bindings(promptDevice(), "Gameplay").find((b) => b.binding.action === "Interact")?.binding.control) });
// ADR-212: hand symbol + Interact hint over the station Interact would open (same pick as interactPanel)
mountStationHint(root, { world: () => world, player: () => session.player, camera: () => iso?.renderer.camera ?? (ctx ? debugCamera(cam, innerWidth, innerHeight, devicePixelRatio || 1) : undefined),
  hidden: () => !!menus?.nav.isOpen || buildMode.active || !!vehicleCtl?.driving, device: promptDevice,
  key: () => controlLabel(input.bindings(promptDevice(), "Gameplay").find((b) => b.binding.action === "Interact")?.binding.control),
  pick: () => { const c = menuCtx(); const t = c && interactPanel(c); return !t ? undefined : t.panel === "station" ? { station: t.station, kind: t.kind } : "other"; },
  open: (st, kind) => menus?.openStation(st, kind),
  art: () => toolIconFrame(iso?.registry, "hand", Math.min(3, devicePixelRatio || 1) * (promptDevice() === "touch" ? 44 : 34) / 32) });
// ADR-126: tool-needed symbol over the nearest resource node (Settings toggle, live)
mountToolHint(root, { world: () => world, player: () => session.player, camera: () => iso?.renderer.camera, hidden: () => !!menus?.nav.isOpen || buildMode.active || !!vehicleCtl?.driving,
  enabled: () => loadSettings().toolHints !== false, device: promptDevice,
  art: (icon) => toolIconFrame(iso?.registry, icon, Math.min(3, devicePixelRatio || 1) * (promptDevice() === "touch" ? 44 : 34) / 32) });
if (params.get("hud") !== "0" && settings.showHud) mountHud(() => world, () => session.player, { ...(num("time") !== undefined ? { hours: num("time")! } : {}), ...(wi >= 0 ? { weather: wi } : {}), ...seasonOv }, () => menus?.toggle("character"));

let last = performance.now();
function audioFrame(w: World, dayFrac: number | undefined): void {
  try {
    audio.mixer.pollGamepadUnlock(navigator.getGamepads?.() as never);
    const inGame = session.player !== undefined; const paused = !!menus?.nav.isOpenId("pause") && !!spStatus; // singleplayer pause: world audio stops, UI stays live
    audio.frame(w, session.player, session.client?.tiles.tiles, dayFrac, !inGame ? "menu" : paused ? "off" : "game", performance.now() / 1000, session.client?.serverTickEstimate);
  } catch { /* audio must never break a frame */ }
}
/** UI sounds: button clicks (touch/mouse/gamepad A all dispatch click), hover/focus, toasts. */
function wireUiSounds(a: AudioSystem): void {
  let hoverAt = 0; const hover = (t: EventTarget | null): void => { const now = performance.now(); if (now - hoverAt < 60 || !(t instanceof HTMLElement) || !t.closest("button,select,[role=button]")) return; hoverAt = now; a.ui("ui.hover"); };
  document.addEventListener("click", (e) => { const b = e.target instanceof HTMLElement ? e.target.closest("button") : null; if (!b || /^(vol-|mute-|audio-)/.test(b.dataset["key"] ?? "")) return; a.ui(/back|close|cancel/i.test(b.textContent ?? "") ? "ui.back" : "ui.click"); }, true);
  document.addEventListener("pointerover", (e) => hover(e.target), true);
  document.addEventListener("focusin", (e) => hover(e.target), true);
  document.addEventListener("keydown", (e) => { if (e.code === "KeyH" && !e.repeat && a.driving && !menus?.nav.isOpen && !(e.target instanceof HTMLInputElement)) a.horn(); });
  new MutationObserver((ms) => { for (const m of ms) { const el = m.target; if (el instanceof HTMLElement && el.id === "farm-toast" && el.textContent) { if (el.dataset["kind"] !== "levelup") a.ui("ui.notify"); return; } } })
    .observe(document.body, { childList: true, subtree: true });
}
// ADR-178: the replica gets a TerrainRes over replicated tiles (was a water-only probe, ADR-128) so predicted swim speed /
// water collision match the server; nearWater / "Drink water" read it too.
const replicaTerrainRes = replicaTerrain(() => session.client?.tiles.tiles);
function frame(now: number): void { requestAnimationFrame(frame); const dt = Math.min(now - last, 250); last = now; try { if (!world.getResource(TerrainRes)) world.setResource(TerrainRes, replicaTerrainRes); pumpLocal?.(dt); loop.advance(dt); session.poll(); } catch (e) { showRenderError("Frame error", e instanceof Error ? e.stack ?? e.message : String(e)); } }
requestAnimationFrame(frame);
export const buildPreview = () => buildMode.preview;
