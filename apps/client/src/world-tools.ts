/**
 * ADR-119..122 client overlay: sign world labels (click / tap to edit in the sign editor modal), the road tool, sign
 * placing, the settlement HUD label (House / Village / Clan City) and horde warning toasts + audio cues.
 * Road tool + signs on every device (ADR-122, input actions RoadTool / PlaceSign and the "Road" context):
 * - keyboard/mouse: G (or the HUD "Road" button / Build panel) cycles path -> gravel -> paved -> off, mouse drag lays a
 *   line immediately; N (or the HUD "Sign" button) places the first carried sign at the cursor; Esc leaves the tool.
 * - touch: HUD buttons; drag (or tap start, tap end) shows a preview with ✓ Confirm / ✕ Cancel; drags that start on a
 *   virtual control are ignored.
 * - gamepad: HUD buttons via the Build panel (D-pad + A); a tile cursor on the right stick with button prompts:
 *   A start / end, RT lay, B cancel (B again leaves), Y next surface, X place sign at the cursor.
 * ADR-263 shovel terrain editing (Task 36), shown only while a shovel is in the main hand (same right-hand column, so
 * nothing new overlaps the HUD): ⬆ Raise / ⬇ Dig buttons (touch / mouse), keyboard Y raise / H dig, gamepad LT + D-pad ↑
 * raise / LT + D-pad ↓ dig. Target: the tile under the mouse when it is within reach, else the tile the player faces
 * (touch / gamepad always use the faced tile); a dashed diamond marks it. `#world-tool-bar [data-tool=raise|dig]`.
 * ADR-419 ramp mode (same column, same shovel): "Ramp" toggles the mode (T / LT + Y, Esc exits; click the button again
 * to cycle length 2/3/4/6), then ⬆ / ⬇ (Y / H, LT + D-pad) grades a whole ramp up / down from the marked foot tile in
 * the facing / aimed direction — one gameplay.terrainRamp command, foot + graded line previewed as diamonds.
 * DOM hooks: `#world-labels`, `.sign-label[data-sign]`, `#settlement-label[data-kind]`, `#horde-toast[data-phase]`,
 * `#road-tool[data-surface][data-device]`, `#world-tool-bar [data-tool=road|sign]`, `#road-confirm [data-role=confirm|cancel]`,
 * `#road-preview`, `#road-cursor`.
 */
import { setAttr, setDisabled } from "./dom-diff.js";
import { iconImg } from "./game-icons.js";
import { Transform, type Entity, type World } from "@engine/core";
import { worldToScreen, DEFAULT_ISO, type IsoConfig } from "@engine/world";
import {
  Sign, HordeStatus, HordePhase, PlaceRoadCmd, PlaceSignCmd, SetSignTextCmd, SIGNS, ROADS, countItem, gameplayDefs,
  signText, signDef, homesteads, classifySettlements, settlementNear, TerrainCmd, TerrainRampCmd, TERRAIN, holdingShovel, type MenuIntent,
} from "@engine/gameplay";
import { RoadTool, lineTiles, type RoadDevice, type RoadLine, type Tile } from "./road-tool.js";
import { buildSignEditor } from "./sign-editor.js";

export interface CameraLike { x: number; y: number; viewW: number; viewH: number; dpr: number; readonly drawZoom: number; cssToWorld(x: number, y: number): { x: number; y: number };
  /** ADR-253: the renderer camera's projection (carries the view rotation); absent = DEFAULT_ISO (q0). */ readonly iso?: IsoConfig }
/** ADR-253: the projection a CameraLike draws with (its view-rotated IsoConfig, else the default q0 projection). */
export const camIso = (cam: { readonly iso?: IsoConfig }): IsoConfig => cam.iso ?? DEFAULT_ISO;
export interface WorldToolsDeps {
  world(): World; player(): Entity | undefined; camera(): CameraLike | undefined; send(i: MenuIntent): boolean;
  hidden(): boolean; sound?(key: string): void; canvas?: HTMLElement;
  /** @engine/input system: RoadTool / PlaceSign / Road.* actions and the "Road" context. Without it G / N keydown are used. */
  input?: { pressed(a: string): boolean; vector(a: string): readonly [number, number]; push(c: string): void; pop(c?: string): void };
  /** Last used device class (prompts, touch confirm step, gamepad cursor). */
  device?(): RoadDevice;
  /** Open a modal on the UINav stack (Esc / pad B / popstate / Back close it). Falls back to appending to `root`. */
  openModal?(id: string, el: HTMLElement, onClose?: () => void): { close(): void };
  /** True when a CSS point is on a visible touch virtual control (joystick / buttons): road drags ignore those. */
  onControl?(x: number, y: number): boolean;
}
/** Button prompt line for the road tool per device. */
/**
 * ADR-133: the Road / Sign HUD buttons are context-only. Road shows while the road tool is on (it cycles the surface /
 * turns the tool off); Sign shows in road mode or when a sign is in reach (edit). Entering the tool is the Build panel's
 * "Roads & signs" row, G or N, so nothing sits on screen when it does nothing.
 * ADR-253: the column starts at 108 px (below the ⟲ / ⟳ camera-rotate pair under the menu bar) and hides while driving
 * (the drive layout's Engine / Lights buttons sit at the right edge lower down).
 */
export function worldToolBarState(s: { active: boolean; nearSign: boolean; hidden: boolean }): { bar: boolean; road: boolean; sign: boolean } {
  const road = !s.hidden && s.active, sign = !s.hidden && (s.active || s.nearSign); return { bar: road || sign, road, sign };
}
export function roadPrompt(device: RoadDevice, state: { start: boolean; pending: boolean }): string {
  if (device === "gamepad") return state.pending ? "Ⓐ / RT lay road · Ⓑ cancel" : state.start ? "Ⓐ mark end · RT lay · Ⓑ cancel · 🕹R move" : "🕹R move cursor · Ⓐ mark start · Ⓨ surface · Ⓧ sign · Ⓑ exit";
  if (device === "touch") return state.pending ? "Confirm ✓ or Cancel ✕" : "Drag (or tap start, tap end) to plan a road";
  return "Drag to lay · G next / off · Esc exit";
}
/** ADR-263: shovel prompt line per device. */
export function shovelPrompt(device: RoadDevice): string {
  if (device === "gamepad") return "Shovel: LT + D-pad ↑ raise · LT + D-pad ↓ dig";
  if (device === "touch") return "Shovel: ⬆ Raise / ⬇ Dig the marked tile";
  return "Shovel: Y raise · H dig (aim with the mouse)";
}
/** ADR-419: ramp lengths the Ramp button cycles through (one command grades the whole ramp). */
export const RAMP_LENGTHS = [2, 3, 4, 6] as const;
/** ADR-419: ramp prompt line per device (length = levels climbed / descended). */
export function rampPrompt(device: RoadDevice, len: number): string {
  if (device === "gamepad") return `Ramp ${len}: LT + Y on/off · LT + D-pad ↑ grade up ${len} · LT + D-pad ↓ grade down ${len}`;
  if (device === "touch") return `Ramp ${len}: tap Ramp for length · ⬆ grade up ${len} · ⬇ grade down ${len}`;
  return `Ramp ${len}: aim the foot tile · Y grade up ${len} · H grade down ${len} · T on/off`;
}
/**
 * ADR-419: ramp direction — keyboard/mouse: from the player tile toward the hovered tile (dominant axis);
 * touch / gamepad: the facing direction, snapped to an axis. Always one of (+-1,0) / (0,+-1).
 */
export function rampDir(body: { x: number; y: number; facing: number }, hovered?: Tile): { dx: number; dy: number } {
  const px = Math.floor(body.x), py = Math.floor(body.y);
  if (hovered && (hovered.x !== px || hovered.y !== py)) {
    const dx = hovered.x - px, dy = hovered.y - py;
    return Math.abs(dx) >= Math.abs(dy) ? { dx: Math.sign(dx), dy: 0 } : { dx: 0, dy: Math.sign(dy) };
  }
  const cx = Math.cos(body.facing), cy = Math.sin(body.facing);
  return Math.abs(cx) >= Math.abs(cy) ? { dx: Math.sign(cx) || 1, dy: 0 } : { dx: 0, dy: Math.sign(cy) || 1 };
}
/** ADR-419: the tiles one ramp grades — the foot tile itself is unchanged, tiles 1..|delta| rise / fall by 1 each. */
export function rampTiles(start: Tile, dx: number, dy: number, delta: number): Tile[] {
  const out: Tile[] = []; for (let i = 1; i <= Math.abs(delta); i++) out.push({ x: start.x + dx * i, y: start.y + dy * i }); return out;
}
/**
 * ADR-263: which tile a shovel use targets. Keyboard/mouse: the hovered tile when its centre is within reach of the body,
 * else the faced tile; touch / gamepad: the faced tile (no precise aim needed).
 */
export function shovelTarget(device: RoadDevice, body: { x: number; y: number; facing: number }, hovered: Tile | undefined, reach: number = TERRAIN.reach): Tile {
  if (device === "keyboardMouse" && hovered && Math.hypot(hovered.x + 0.5 - body.x, hovered.y + 0.5 - body.y) <= reach) return hovered;
  return { x: Math.floor(body.x + Math.cos(body.facing)), y: Math.floor(body.y + Math.sin(body.facing)) };
}
export const HORDE_TEXT = { warning: "A zombie horde is gathering — prepare your defenses!", active: "The horde is here!", defeated: "The horde has been defeated." } as const;
const CSS = `#world-labels{position:absolute;inset:0;pointer-events:none;z-index:4;overflow:hidden}
#world-labels .sign-label{position:absolute;transform:translate(-50%,-100%);pointer-events:auto;cursor:text;max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
font:600 12px Fredoka,system-ui,sans-serif;color:#3B2433;background:#F6EAD2;border:2px solid #74432C;border-radius:6px;padding:1px 6px;box-shadow:0 2px 0 #432C24}
#world-labels .sign-label[data-kind="5"]{background:#2f6b3a;color:#fff;border-color:#e8f0e8}
#settlement-label,#road-tool{position:absolute;left:50%;transform:translateX(-50%);z-index:5;font:600 13px Fredoka,system-ui,sans-serif;color:#FFFAF0;background:rgba(59,36,51,.75);border-radius:10px;padding:2px 10px;pointer-events:none}
#settlement-label{top:calc(6px + var(--sat,0px))}#road-tool{bottom:calc(90px + var(--sab,0px))}
#world-tool-bar{position:absolute;right:calc(8px + var(--sar,0px));top:calc(108px + var(--sat,0px));z-index:6;display:flex;flex-direction:column;gap:6px}
#world-tool-bar button,#road-confirm button{min-width:52px;min-height:44px;font:600 13px Fredoka,system-ui,sans-serif;color:#3B2433;background:#F6EAD2;border:2px solid #74432C;border-radius:10px;box-shadow:0 2px 0 #432C24;cursor:pointer;touch-action:manipulation}
#world-tool-bar button[aria-pressed=true]{background:#ffd45a}#world-tool-bar button:disabled{opacity:.5}
#road-confirm{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(124px + var(--sab,0px));z-index:6;display:flex;gap:10px}
#road-confirm [data-role=confirm]{background:#bfe3a6}#road-confirm [data-role=cancel]{background:#f1b3a8}
#road-preview{position:absolute;inset:0;width:100%;height:100%;z-index:3;pointer-events:none;overflow:visible}
#road-preview polygon{fill:rgba(255,212,90,.35);stroke:#ffd45a;stroke-width:1.5}#road-preview polygon.dig{fill:rgba(255,255,255,.12);stroke:#fff;stroke-dasharray:4 3}#road-preview polygon.start{fill:rgba(120,220,120,.45)}
#road-cursor{position:absolute;z-index:5;pointer-events:none;width:0;height:0}
#road-cursor::before{content:"";position:absolute;left:-14px;top:-8px;width:28px;height:16px;border:2px solid #fff;border-radius:3px;transform:scaleY(.6) rotate(45deg) scaleY(1.4);box-shadow:0 0 0 2px #3B2433}
#horde-toast{position:absolute;left:50%;top:calc(26% + var(--sat,0px));transform:translateX(-50%);z-index:6;font:700 15px Fredoka,system-ui,sans-serif;color:#FFE0D8;background:rgba(110,20,20,.88);border:2px solid #3B2433;border-radius:12px;padding:6px 14px;transition:opacity .4s;pointer-events:none}`;

export function isoToCss(cam: CameraLike, wx: number, wy: number): { x: number; y: number } {
  const s = worldToScreen(wx, wy, 0, camIso(cam)); const z = cam.drawZoom;
  return { x: (s.sx - cam.x) * z + cam.viewW / cam.dpr / 2, y: (s.sy - cam.y) * z + cam.viewH / cam.dpr / 2 };
}
/** Horde HUD state machine (pure, tested): returns the cue for a HordeStatus change. */
export function hordeCue(prev: { phase: number; seq: number } | undefined, cur: { phase: number; seq: number } | undefined): "warning" | "active" | "defeated" | undefined {
  if (!cur || !prev) return undefined;
  if (cur.phase === HordePhase.Warning && (prev.phase !== HordePhase.Warning || prev.seq !== cur.seq)) return "warning";
  if (cur.phase === HordePhase.Active && prev.phase !== HordePhase.Active) return "active";
  if (cur.phase === HordePhase.Idle && prev.phase === HordePhase.Active) return "defeated";
  return undefined;
}
const encode = (t: string): { len: number; text: number[] } => { const b = Array.from({ length: 48 }, (_, i) => t.charCodeAt(i) || 0); return { len: Math.min(48, t.length), text: b }; };

export interface WorldToolsHandle {
  destroy(): void; roadSurface(): number;
  /** Per input update (after input.update()): RoadTool / PlaceSign / Road.* actions and the gamepad cursor. */
  update(dt?: number): void;
  /** Cycle / select the road surface (HUD button, Build panel). 0 = off. */
  road(surface?: number): void;
  /** Place the first carried sign at the cursor / gamepad cursor / in front of the player. Returns whether sent. */
  placeSign(): boolean;
  /** Open the sign editor for a sign entity. */
  editSign(e: Entity): void;
  /** Edit the nearest sign within reach (2.5 tiles); false when none. HUD Sign button / Build panel / gamepad. */
  editNearestSign(): boolean;
  readonly tool: RoadTool;
}
export function mountWorldTools(root: HTMLElement, d: WorldToolsDeps): WorldToolsHandle {
  const style = document.createElement("style"); style.textContent = CSS; document.head.append(style);
  const layer = document.createElement("div"); layer.id = "world-labels";
  const place = document.createElement("div"); place.id = "settlement-label"; place.style.display = "none";
  const tool = document.createElement("div"); tool.id = "road-tool"; tool.style.display = "none";
  const toast = document.createElement("div"); toast.id = "horde-toast"; toast.setAttribute("role", "alert"); toast.style.opacity = "0";
  const bar = document.createElement("div"); bar.id = "world-tool-bar"; bar.setAttribute("aria-label", "Road and sign tools");
  // Task 25: buttons carry a custom icon (ic_road.png / ic_sign.png) + a text span; setBtnLabel updates only the span so the icon survives.
  const mkBtn = (txt: string, attr: string, val: string, fn: () => void, title: string, icon?: string): HTMLButtonElement => { const b = document.createElement("button"); b.type = "button"; if (icon) b.append(iconImg(icon, 18, "")); const s = document.createElement("span"); s.textContent = txt; b.append(s); b.dataset[attr] = val; b.title = title; b.setAttribute("aria-label", title); b.addEventListener("click", (e) => { e.stopPropagation(); fn(); }); return b; };
  const setBtnLabel = (b: HTMLButtonElement, v: string): void => { const s = b.querySelector("span"); if (s && s.textContent !== v) s.textContent = v; };
  // ADR-419: ramp mode (shovel held): grade a ±rampLen slope from the marked foot tile instead of one level.
  let rampOn = false, rampLen = 3;
  const roadBtn = mkBtn("Road", "tool", "road", () => road(), "Road tool (G): path, gravel, paved, off", "ic_road.png");
  const signBtn = mkBtn("Sign", "tool", "sign", () => { if (!editNearestSign()) placeSign(); }, "Place a sign you carry (N), or edit the sign next to you", "ic_sign.png");
  // ADR-263: shovel Raise / Dig (context-only: visible while a shovel is in the main hand)
  const raiseBtn = mkBtn("⬆ Raise", "tool", "raise", () => { rampOn ? ramp(1) : shovel(1); }, "Raise the ground here one level — costs 1 Soil (Y / LT + D-pad ↑); in Ramp mode grades the ramp up");
  const digBtn = mkBtn("⬇ Dig", "tool", "dig", () => { rampOn ? ramp(-1) : shovel(-1); }, "Dig the ground here one level — gains 1 Soil (H / LT + D-pad ↓); in Ramp mode grades the ramp down");
  // ADR-419: Ramp mode toggle — click again while on to cycle the length (2/3/4/6 levels); T / LT+Y toggles it off
  const rampBtn = mkBtn("Ramp", "tool", "ramp", () => { if (!rampOn) { rampOn = true; } else { rampLen = RAMP_LENGTHS[(RAMP_LENGTHS.indexOf(rampLen as (typeof RAMP_LENGTHS)[number]) + 1) % RAMP_LENGTHS.length]!; } }, "Ramp tool (T / LT + Y): grade a slope from the marked tile — click again to change length");
  bar.append(roadBtn, signBtn, raiseBtn, digBtn, rampBtn);
  const confirmBar = document.createElement("div"); confirmBar.id = "road-confirm"; confirmBar.style.display = "none";
  confirmBar.append(mkBtn("✓ Lay road", "role", "confirm", () => confirmRoad(), "Lay the planned road"), mkBtn("✕ Cancel", "role", "cancel", () => cancelRoad(), "Cancel the planned road"));
  const SVGNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(SVGNS, "svg"); svg.id = "road-preview"; svg.style.display = "none";
  const cursorEl = document.createElement("div"); cursorEl.id = "road-cursor"; cursorEl.style.display = "none";
  root.append(svg, layer, place, tool, toast, bar, confirmBar, cursorEl);
  const pool = new Map<Entity, HTMLDivElement>();
  const rt = new RoadTool(ROADS.surfaces.length);
  let pointer = { x: innerWidth / 2, y: innerHeight / 2 }; let dragId: number | undefined;
  let prevHorde: { phase: number; seq: number } | undefined; let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const device = (): RoadDevice => d.device?.() ?? "keyboardMouse";
  const tileAt = (x: number, y: number): Tile | undefined => { const c = d.camera(); if (!c) return undefined; const w = c.cssToWorld(x, y); return { x: Math.floor(w.x), y: Math.floor(w.y) }; };
  const aimTile = (): Tile | undefined => tileAt(pointer.x, pointer.y);
  const playerTile = (): Tile | undefined => { const p = d.player(); const t = p !== undefined ? d.world().get(p, Transform) : undefined; return t ? { x: Math.floor(t.x), y: Math.floor(t.y) } : undefined; };
  let ctxOn = false;
  const syncCtx = (): void => { const on = rt.active; if (on === ctxOn || !d.input) return; ctxOn = on; try { if (on) d.input.push("Road"); else d.input.pop("Road"); } catch { /* context not defined */ } };
  function road(surface?: number): void { if (surface === undefined) rt.cycle(); else rt.select(surface); syncCtx(); }
  const sendLine = (l: RoadLine | undefined): void => { if (l && rt.active) d.send({ cmd: PlaceRoadCmd, args: { x0: l.a.x, y0: l.a.y, x1: l.b.x, y1: l.b.y, surface: rt.surface } } as unknown as MenuIntent); };
  function confirmRoad(): void { sendLine(rt.confirm()); }
  function cancelRoad(): void { rt.cancel(); syncCtx(); }
  const signKind = (): number => { const w = d.world(), p = d.player(); if (p === undefined) return 0; const defs = gameplayDefs(w); return SIGNS.findIndex((s) => { try { return countItem(w, p, defs.itemId(s.item)) > 0; } catch { return false; } }) + 1; };
  function placeSign(): boolean {
    const p = d.player(); if (p === undefined || d.hidden()) return false;
    const dev = device(); const at = dev === "gamepad" ? (rt.cursorTile() ?? playerTile()) : dev === "touch" ? playerTile() : aimTile(); if (!at) return false;
    const kind = signKind(); if (kind <= 0) { d.sound?.("ui.error"); return false; }
    return d.send({ cmd: PlaceSignCmd, args: { kind, x: at.x + 0.5, y: at.y + 0.5, rot: 0 } } as unknown as MenuIntent);
  }
  const nearestSign = (): Entity | undefined => {
    const w = d.world(), p = d.player(); const pt = p !== undefined ? w.get(p, Transform) : undefined; if (!pt || !w.isRegistered(Sign)) return undefined;
    let best: Entity | undefined, bd = 2.5; for (const e of w.query([Sign, Transform])) { const t = w.get(e, Transform)!; const dd = Math.hypot(t.x - pt.x, t.y - pt.y); if (dd <= bd) { bd = dd; best = e; } }
    return best;
  };
  const shovelHeld = (): boolean => { const p = d.player(); return p !== undefined && holdingShovel(d.world(), p); };
  const shovelTile = (): Tile | undefined => {
    const p = d.player(); const t = p !== undefined ? d.world().get(p, Transform) : undefined; if (!t) return undefined;
    return shovelTarget(device(), { x: t.x, y: t.y, facing: t.facing ?? 0 }, aimTile());
  };
  function shovel(dir: 1 | -1): boolean {
    if (d.hidden() || rt.active || !shovelHeld()) return false; const at = shovelTile(); if (!at) return false;
    d.sound?.("ui.click"); return d.send({ cmd: TerrainCmd, args: { x: at.x, y: at.y, dir } } as unknown as MenuIntent);
  }
  /** ADR-419: grade a ramp from the marked foot tile in the facing / aimed direction (one command, server-validated). */
  function ramp(dirSign: 1 | -1): boolean {
    if (d.hidden() || rt.active || !shovelHeld() || !rampOn) return false;
    const p = d.player(); const t = p !== undefined ? d.world().get(p, Transform) : undefined; if (!t) return false;
    const at = shovelTile(); if (!at) return false;
    const { dx, dy } = rampDir({ x: t.x, y: t.y, facing: t.facing ?? 0 }, device() === "keyboardMouse" ? aimTile() : undefined);
    d.sound?.("ui.click");
    return d.send({ cmd: TerrainRampCmd, args: { x: at.x, y: at.y, dx, dy, delta: dirSign * rampLen } } as unknown as MenuIntent);
  }
  function toggleRamp(): void { rampOn = !rampOn; }
  let shovelHintUntil = 0, wasShovel = false;
  const editNearestSign = (): boolean => { const e = nearestSign(); if (e === undefined) return false; editSign(e); return true; };
  let editor: { close(): void } | undefined;
  const editSign = (e: Entity): void => {
    const w = d.world(); if (!w.has(e, Sign)) return; const def = signDef(w.get(e, Sign)!.kind);
    editor?.close();
    const dev = device(); let handle: { close(): void } | undefined; let closed = false;
    const close = (): void => { if (closed) return; closed = true; if (handle) handle.close(); else el.remove(); editor = undefined; };
    const el = buildSignEditor({ kindName: def?.name ?? "Sign", maxLen: def?.maxLen ?? 48, initial: signText(w, e), keyboard: dev === "gamepad", close,
      onSave: (t) => { d.send({ cmd: SetSignTextCmd, args: { sign: e, ...encode(t) }, entities: ["sign"] } as unknown as MenuIntent); } });
    if (d.openModal) handle = d.openModal("sign-editor", el, () => { closed = true; editor = undefined; }); else root.append(el);
    editor = { close };
  };
  layer.addEventListener("click", (ev) => { const el = (ev.target as HTMLElement).closest<HTMLElement>(".sign-label"); if (el) editSign(Number(el.dataset["sign"]) as Entity); });
  const typing = (e: KeyboardEvent): boolean => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  const onKey = (e: KeyboardEvent): void => {
    if (d.input || e.repeat || typing(e) || d.hidden()) return; // with an input system the actions drive this in update()
    if (e.code === "KeyG") road(); else if (e.code === "KeyN") placeSign(); else if (e.code === "Escape" && rampOn) rampOn = false; else if (e.code === "Escape" && rt.active) cancelRoad();
    else if (e.code === "KeyT") toggleRamp(); else if (e.code === "KeyY") rampOn ? ramp(1) : shovel(1); else if (e.code === "KeyH") rampOn ? ramp(-1) : shovel(-1);
  };
  const target = d.canvas ?? document;
  const down = (e: Event): void => {
    const pe = e as PointerEvent; pointer = { x: pe.clientX, y: pe.clientY };
    if (!rt.active || d.hidden() || dragId !== undefined || (pe.button ?? 0) !== 0) return;
    if (pe.pointerType !== "mouse" && d.onControl?.(pe.clientX, pe.clientY)) return;
    if (pe.pointerType === "touch" && rt.start && !rt.pending) { dragId = pe.pointerId; return; } // tap start, tap end
    rt.down(aimTile()); dragId = pe.pointerId;
  };
  const move = (e: Event): void => { const pe = e as PointerEvent; if (dragId === undefined || pe.pointerId === dragId || pe.pointerType === "mouse") pointer = { x: pe.clientX, y: pe.clientY }; };
  const up = (e: Event): void => {
    const pe = e as PointerEvent; if (dragId === undefined || pe.pointerId !== dragId) return; dragId = undefined; pointer = { x: pe.clientX, y: pe.clientY };
    const b = aimTile(); const dev: RoadDevice = pe.pointerType === "touch" || pe.pointerType === "pen" ? "touch" : "keyboardMouse";
    if (dev === "touch" && rt.start && b && rt.start.x === b.x && rt.start.y === b.y) return; // a tap: keep the start, wait for the end tap
    sendLine(rt.up(b, dev));
  };
  document.addEventListener("keydown", onKey); target.addEventListener("pointerdown", down); target.addEventListener("pointermove", move); target.addEventListener("pointerup", up);
  const update = (dt = 1 / 60): void => {
    const i = d.input; if (!i || d.hidden()) return;
    if (!rt.active) { if (i.pressed("RoadTool")) road(); if (i.pressed("PlaceSign")) placeSign(); if (i.pressed("Terrain.Ramp")) toggleRamp(); if (i.pressed("Cancel") && rampOn) { rampOn = false; return; } if (i.pressed("Terrain.Raise")) rampOn ? ramp(1) : shovel(1); else if (i.pressed("Terrain.Lower")) rampOn ? ramp(-1) : shovel(-1); return; }
    if (i.pressed("Road.Next")) road();
    if (!rt.active) return;
    if (i.pressed("Road.Cancel")) { cancelRoad(); return; }
    if (i.pressed("PlaceSign")) placeSign();
    if (device() === "gamepad") { const seed = playerTile(); if (seed) rt.nudge(i.vector("Road.Cursor"), dt, seed); }
    if (i.pressed("Road.Mark")) sendLine(rt.mark());
    if (i.pressed("Road.Confirm")) confirmRoad();
  };
  const diamond = (cam: CameraLike, t: Tile, cls: string): SVGPolygonElement => {
    const pts = [[t.x, t.y], [t.x + 1, t.y], [t.x + 1, t.y + 1], [t.x, t.y + 1]].map(([x, y]) => { const c = isoToCss(cam, x!, y!); return `${c.x.toFixed(1)},${c.y.toFixed(1)}`; }).join(" ");
    const p = document.createElementNS(SVGNS, "polygon"); p.setAttribute("points", pts); if (cls) p.setAttribute("class", cls); return p;
  };
  let raf = 0, slow = 0; let placeLabel = "";
  const frame = (): void => {
    raf = requestAnimationFrame(frame);
    try {
      const w = d.world(), p = d.player(), cam = d.camera(); const hide = d.hidden() || p === undefined || !cam;
      layer.style.display = hide ? "none" : "";
      const dig = !hide && !rt.active && shovelHeld(); const dev = device();
      { const vis = worldToolBarState({ active: rt.active, nearSign: !hide && nearestSign() !== undefined, hidden: hide }); bar.style.display = vis.bar || dig ? "" : "none"; roadBtn.style.display = vis.road ? "" : "none"; signBtn.style.display = vis.sign ? "" : "none";
        raiseBtn.style.display = dig ? "" : "none"; digBtn.style.display = dig ? "" : "none"; rampBtn.style.display = dig ? "" : "none"; }
      if (dig && !wasShovel) shovelHintUntil = performance.now() + 4000; wasShovel = dig;
      setAttr(roadBtn, "aria-pressed", String(rt.active)); setAttr(rampBtn, "aria-pressed", String(rampOn)); setBtnLabel(rampBtn, rampOn ? `Ramp ${rampLen}` : "Ramp"); setBtnLabel(roadBtn, rt.active ? `${ROADS.surfaces[rt.surface - 1]!.name.split(" ")[0]}` : "Road");
      const hint = dig && performance.now() < shovelHintUntil;
      tool.style.display = (rt.active || hint || (rampOn && dig)) && !hide ? "" : "none";
      if (rampOn && dig && !rt.active) { tool.dataset["device"] = dev; const txt = rampPrompt(dev, rampLen); if (tool.textContent !== txt) tool.textContent = txt; }
      else if (hint && !rt.active) { tool.dataset["device"] = dev; const txt = shovelPrompt(dev); if (tool.textContent !== txt) tool.textContent = txt; }
      if (rt.active) { tool.dataset["surface"] = String(rt.surface); tool.dataset["device"] = dev; tool.textContent = `Road tool: ${ROADS.surfaces[rt.surface - 1]!.name} — ${roadPrompt(dev, { start: !!rt.start, pending: !!rt.pending })}`; }
      confirmBar.style.display = rt.active && rt.pending && !hide && dev !== "gamepad" ? "flex" : "none";
      // preview + gamepad cursor
      const live = dev === "gamepad" ? rt.cursorTile() : dragId !== undefined || rt.start ? aimTile() : undefined;
      const line = rt.active && !hide ? rt.preview(live) : undefined;
      svg.replaceChildren();
      if (line && cam) { svg.style.display = ""; lineTiles(line).forEach((t, k) => svg.append(diamond(cam, t, k === 0 ? "start" : ""))); }
      else if (rt.active && rt.start && cam && !hide) { svg.style.display = ""; svg.append(diamond(cam, rt.start, "start")); }
      else if (rampOn && dig && cam) { // ADR-419: ramp preview — foot tile + the graded line
        const p = d.player(); const t = p !== undefined ? d.world().get(p, Transform) : undefined;
        const at = shovelTile();
        if (at && t) { const { dx, dy } = rampDir({ x: t.x, y: t.y, facing: t.facing ?? 0 }, dev === "keyboardMouse" ? aimTile() : undefined); svg.style.display = ""; svg.append(diamond(cam, at, "start")); for (const rtile of rampTiles(at, dx, dy, rampLen)) svg.append(diamond(cam, rtile, "dig")); }
        else svg.style.display = "none";
      }
      else if (dig && cam) { const at = shovelTile(); if (at) { svg.style.display = ""; svg.append(diamond(cam, at, "dig")); } else svg.style.display = "none"; } // ADR-263 shovel target
      else svg.style.display = "none";
      const ct = rt.cursorTile();
      if (rt.active && dev === "gamepad" && ct && cam && !hide) { const c = isoToCss(cam, ct.x + 0.5, ct.y + 0.5); cursorEl.style.display = ""; cursorEl.style.left = `${c.x.toFixed(1)}px`; cursorEl.style.top = `${c.y.toFixed(1)}px`; }
      else cursorEl.style.display = "none";
      if (hide || !w.isRegistered(Sign)) return;
      const near = nearestSign() !== undefined; setBtnLabel(signBtn, near ? "✎ Edit sign" : "Sign"); setDisabled(signBtn, !near && signKind() <= 0);
      const pt = w.get(p!, Transform); if (!pt) return;
      const seen = new Set<Entity>();
      for (const e of w.query([Sign, Transform])) {
        const t = w.get(e, Transform)!; if (Math.hypot(t.x - pt.x, t.y - pt.y) > 22 || seen.size >= 40) continue;
        const txt = signText(w, e); seen.add(e);
        let el = pool.get(e); if (!el) { el = document.createElement("div"); el.className = "sign-label"; el.dataset["sign"] = String(e); el.setAttribute("role", "button"); layer.append(el); pool.set(e, el); }
        const shown = txt || "✎"; if (el.textContent !== shown) el.textContent = shown; el.dataset["kind"] = String(w.get(e, Sign)!.kind); el.dataset["empty"] = String(!txt);
        el.title = txt ? "Edit sign" : "Write on this sign";
        const c = isoToCss(cam!, t.x, t.y); el.style.left = `${c.x.toFixed(1)}px`; el.style.top = `${(c.y - 28 * cam!.drawZoom).toFixed(1)}px`;
      }
      for (const [e, el] of pool) if (!seen.has(e)) { el.remove(); pool.delete(e); }
      const now = performance.now(); if (now - slow < 1000) return; slow = now;
      // settlement label
      const list = classifySettlements(homesteads(w, (tribe) => tribe !== 0));
      const s = settlementNear(list, pt.x, pt.y); place.style.display = s ? "" : "none";
      if (s) { place.dataset["kind"] = String(s.kind); const label = `${s.label}${s.players.length > 1 ? ` · ${s.players.length} residents` : ""}`; if (placeLabel !== label) { placeLabel = label; place.replaceChildren(iconImg("ic_pin.png", 14, ""), document.createTextNode(` ${label}`)); } }
      // hordes
      const st = w.has(w.environment, HordeStatus) ? w.get(w.environment, HordeStatus)! : undefined;
      const cur = st ? { phase: st.phase, seq: st.seq } : undefined;
      const cue = hordeCue(prevHorde, cur); prevHorde = cur;
      if (cue) {
        toast.dataset["phase"] = cue; toast.textContent = cue === "warning" ? `${HORDE_TEXT.warning} (~${st!.size} zombies)` : HORDE_TEXT[cue]; toast.style.opacity = "1";
        clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.style.opacity = "0"; }, 5000);
        d.sound?.(cue === "warning" ? "horde.warning" : cue === "active" ? "horde.spawn" : "horde.defeated");
      }
    } catch { /* overlay must never break a frame */ }
  };
  raf = requestAnimationFrame(frame);
  return {
    tool: rt, update, road, placeSign, editSign, editNearestSign,
    roadSurface: () => rt.surface,
    destroy: () => { cancelAnimationFrame(raf); clearTimeout(toastTimer); editor?.close(); if (ctxOn) d.input?.pop("Road"); document.removeEventListener("keydown", onKey); target.removeEventListener("pointerdown", down); target.removeEventListener("pointermove", move); target.removeEventListener("pointerup", up); for (const el of [layer, place, tool, toast, bar, confirmBar, cursorEl, style]) el.remove(); svg.remove(); },
  };
}
