import { buildFailText } from "./build-hud.js";
/**
 * Client build mode: the Build panel's "Place" starts it; it pushes the input "Building" context so the Build.* bindings
 * apply on every device, and every frame turns the aim into `preview` via @engine/gameplay buildPreviewFor
 * (snap + reach clamp + validatePlacement). The Renderer draws the ghost from `buildPreview`.
 *
 * ADR-136 (building on every platform):
 *  - keyboard+mouse: cursor aims; LMB place, RMB / R / Q rotate, wheel piece, Shift+wheel tier, PgUp/PgDn floor,
 *    H repair / U upgrade / X demolish (press twice) on the targeted piece, Esc cancel.
 *  - gamepad: right stick moves a free build cursor (relative to the player, clamped to reach, follows the player);
 *    A / RT place, RB / LB rotate, D-pad left/right piece, up/down tier, LT + up/down floor, tap X repair,
 *    tap Y upgrade, hold X demolish, B cancel.
 *  - touch: tap the world to position the ghost, drag to adjust (lifted above the finger), Confirm places;
 *    the compact HUD carries floor ▲▼ and the contextual Repair / Upgrade / Demolish buttons.
 *  - a placed piece under the aim is the `target`; `context` lists its labelled actions (shown only when targeted).
 */
import { BuildPiece, snapPlacement, validatePlacement, buildPreviewFor, fineEligible, FINE_ROT, FINE_ROT_STEPS, rotationSteps, buildView, demolishIntent, gameplayDefs, moveVector, pieceTargetAt, placementTarget, placePreviewIntent, reclaimIntent, repairIntent, rotateStep, structures, upgradeIntent,
  type BuildPreview, type BuildSelection, type MenuCtx, type MenuIntent, type PieceTarget, type PlacementAim } from "@engine/gameplay";
import { Transform } from "@engine/core";
import { rotateScreenVec } from "@engine/input";

export type BuildDevice = "keyboardMouse" | "gamepad" | "touch";
export interface BuildModeInput { pressed(action: string): boolean; /** held state (ADR-222 confirm latch); optional for older fakes */ down?(action: string): boolean; push(context: string): void; pop(context?: string): void; vector?(action: string): readonly number[];
  /** ADR-253 camera view quarter: the pad cursor moves camera-relative (stick up = up on screen in every view). */ readonly viewQuarter?: number }
export interface BuildModeOptions {
  input: BuildModeInput;
  ctx(): MenuCtx | undefined;
  /** Current aim: AimResolver.resolve() (mode 1 world point, mode 0 direction incl. last move dir). */
  aim(): PlacementAim | undefined;
  send(i: MenuIntent): boolean;
  /** Active device class (defaults to keyboardMouse). */
  device?(): BuildDevice;
  now?(): number;
  /** Called on start/stop (e.g. swap the touch layout to the "building" one with the rotate button). */
  onActiveChange?(active: boolean): void;
  /** ToggleBuild while placing (pad LB+Y): back to the piece picker. */
  onPickPiece?(): void;
  /** ADR-224: Cancel (B / Esc) after a menu-started placement goes back to the build menu (once Cancel is released). */
  onBack?(): void;
  /** ADR-171: road tool / sign placing from inside build mode (HUD 🛣 / 🪧, KBM T / N, pad LT+X / LT+Y). Build mode stops first. */
  tools?: { road(): void; sign(): void };
}
export type BuildActionId = "repair" | "upgrade" | "demolish" | "reclaim";
export interface BuildContextAction { id: BuildActionId; label: string; hint: string; enabled: boolean; armed?: boolean }
export interface BuildContextView { target: PieceTarget; title: string; actions: BuildContextAction[] }
/** Gamepad cursor speed (tiles/s at full stick). */
export const PAD_CURSOR_SPEED = 5;
/** ADR-228: per-frame placement queries rerun once the aim moved this many tiles or this long passed (inputs unchanged). */
export const REFRESH_STEP = 0.125, REFRESH_MAX_MS = 100;
export const DEMOLISH_CONFIRM_MS = 3000;
const HINTS: Record<BuildDevice, Record<BuildActionId, string>> = {
  keyboardMouse: { repair: "H", upgrade: "U", demolish: "X", reclaim: "C" },
  gamepad: { repair: "X", upgrade: "Y", demolish: "hold X", reclaim: "" },
  touch: { repair: "", upgrade: "", demolish: "", reclaim: "" },
};
const label = (k: string): string => k.replace(/_/g, " ").replace(/^\w/, (m) => m.toUpperCase());

export class BuildMode {
  private sel: BuildSelection | undefined; rot = 0; level = 0;
  /** Renderer contract: undefined when not placing. */
  preview: BuildPreview | undefined;
  /** Placed piece under the aim (drives the contextual menu). */
  target: PieceTarget | undefined;
  /** Gamepad cursor offset from the player (world tiles); touch point (world). */
  padOffset: { x: number; y: number } | undefined; touchPoint: { x: number; y: number } | undefined;
  private demolishArmedAt = -Infinity; private lastT: number | undefined;
  /** ADR-169: grid snap assist (Build.ToggleSnap: G / R3 / HUD "Snap" chip). On = an invalid aim snaps to the nearest valid
   * grid cell around it (facing aim + gamepad cursor; a pointed mouse cell / touch tap stays exact so a red ghost says why); off = the ghost sits exactly on the aimed cell, red when it can't be placed. */
  snap = true;
  /** ADR-171: leave build mode and open the road tool / place (or edit) a sign. */
  tool(id: "road" | "sign"): void { const t = this.o.tools; if (!t) return; this.stop(); if (id === "road") t.road(); else t.sign(); }
  get hasTools(): boolean { return !!this.o.tools; }
  /** ADR-174: 15° step (0..23) used while snap is off for pieces that may go off-grid (fineEligible). */
  fineRot = 0;
  /** Snap is off and the selected piece can be placed off-grid: 1/16-tile position, 15° rotation steps. */
  get freePlacing(): boolean { const c = this.o.ctx(); const def = this.sel && c ? gameplayDefs(c.world).pieces.get(this.sel.piece) : undefined; return !this.snap && !!def && fineEligible(def); }
  /** Rot sent with the preview / PlaceCmd (FINE_ROT | step when free placing). */
  get requestRot(): number { return this.freePlacing ? FINE_ROT | this.fineRot : this.rot; }
  toggleSnap(): void {
    const c = this.o.ctx(); const n = this.sel && c ? rotationSteps(c.world, this.sel.piece) : 16; // keep the heading across the switch
    if (this.snap) this.fineRot = Math.round((this.rot * FINE_ROT_STEPS) / n) % FINE_ROT_STEPS; else this.rot = Math.round((this.fineRot * n) / FINE_ROT_STEPS) % n;
    this.snap = !this.snap; this.toast = this.snap ? "Snap on" : "Snap off"; this.refresh(); }
  /** Last action feedback for the HUD ("Repaired", "Press X again to demolish", ...). */
  toast = "";
  constructor(private readonly o: BuildModeOptions) {}
  get active(): boolean { return this.sel !== undefined; }
  get selection(): BuildSelection | undefined { return this.sel; }
  private now(): number { return this.o.now?.() ?? (typeof performance !== "undefined" ? performance.now() : Date.now()); }
  private device(): BuildDevice { return this.o.device?.() ?? "keyboardMouse"; }
  /** ADR-222: true until Build.PlaceConfirm has been observed up after start(). */
  private confirmLatch = false;
  get awaitingRelease(): boolean { return this.confirmLatch; }
  private fromMenu = false; private pendingBack = false;
  start(sel: BuildSelection, opts?: { fromMenu?: boolean }): void {
    const was = this.active; const previousPiece = this.sel?.piece; this.sel = { ...sel };
    if (was && previousPiece !== sel.piece) { this.rot = 0; this.fineRot = 0; this.rotLockAt = undefined; this.disarm(); this.toast = ""; }
    this.fromMenu = !!opts?.fromMenu; this.pendingBack = false;
    // ADR-222: the press that chose the piece (pad A / Enter / click on a menu tile) must never also place it. Placement
    // only confirms after PlaceConfirm has been seen released at least one frame after entering build mode.
    this.confirmLatch = true;
    if (!was) { this.rotLockAt = undefined; this.rot = 0; this.fineRot = 0; this.level = 0; this.padOffset = undefined; this.touchPoint = undefined; this.disarm(); this.o.input.push("Building"); this.o.onActiveChange?.(true); }
    this.refresh();
  }
  /** Update an active picker selection without exiting Building or losing its cursor/floor. */
  select(sel: BuildSelection): void {
    if (!this.active) return;
    this.start(sel, { fromMenu: this.fromMenu });
  }
  stop(): void { if (!this.active) return; this.sel = undefined; this.preview = undefined; this.target = undefined; this.touchPoint = undefined; this.padOffset = undefined; this.disarm(); this.o.input.pop("Building"); this.o.onActiveChange?.(false); }
  rotate(dir: 1 | -1): void { const c = this.o.ctx(); if (!this.sel || !c) return; if (this.freePlacing) { this.fineRot = (this.fineRot + dir + FINE_ROT_STEPS) % FINE_ROT_STEPS; this.refresh(); return; } // ADR-211: step from the rotation shown (a corner may have auto-fitted it); RB then overrides auto-fit at this junction
    const shown = this.preview?.request.rot; if (this.preview?.magnet !== undefined && shown !== undefined && shown < FINE_ROT) this.rot = shown;
    this.rot = rotateStep(c.world, this.sel.piece, this.rot, dir); this.rotLockAt = this.preview ? { x: Math.round(this.preview.x), y: Math.round(this.preview.y) } : { x: NaN, y: NaN }; this.refresh(); }
  /** ADR-211: junction where the player last rotated by hand (corner auto-fit off there; moving to another junction re-enables it). */
  private rotLockAt: { x: number; y: number } | undefined;
  setLevel(dir: 1 | -1): void { const c = this.o.ctx(); if (!this.sel || !c) return; const max = gameplayDefs(c.world).building.maxLevel; this.level = Math.max(0, Math.min(max, this.level + dir)); this.disarm(); this.refresh(); }
  /** Cycle the piece (all pieces, catalog order) keeping tier when the new piece has it. */
  cyclePiece(dir: 1 | -1): void {
    const c = this.o.ctx(); if (!this.sel || !c) return; const all = buildView(c); if (!all.length) return;
    const i = all.findIndex((p) => p.id === this.sel!.piece); const next = all[(((i + dir) % all.length) + all.length) % all.length]!;
    const tier = next.tiers.some((t) => t.tier === this.sel!.tier) ? this.sel.tier : next.tiers[0]!.tier;
    this.sel = { piece: next.id, tier, variant: 0, paint: this.sel.paint }; this.rot = 0; this.rotLockAt = undefined; this.fineRot = 0; this.refresh();
  }
  cycleTier(dir: 1 | -1): void {
    const c = this.o.ctx(); if (!this.sel || !c) return; const p = buildView(c).find((x) => x.id === this.sel!.piece); if (!p || p.tiers.length < 2) return;
    const i = p.tiers.findIndex((t) => t.tier === this.sel!.tier); this.sel = { ...this.sel, tier: p.tiers[Math.max(0, Math.min(p.tiers.length - 1, i + dir))]!.tier }; this.refresh();
  }
  /** Touch: world point under the finger (tap positions, drag adjusts). */
  setTouchPoint(p: { x: number; y: number } | undefined): void { this.touchPoint = p; this.disarm(); this.refresh(); }
  /** Place at the current preview; false when invalid / not sent. */
  place(): boolean {
    // Confirm the model the ghost was drawn from. HUD clicks, stick release and camera
    // movement must not resolve a different aim inside confirmation.
    const p = this.preview, c = this.o.ctx(); if (!p || !c) { this.toast = "Choose a build location"; return false; }
    const sn = snapPlacement(c.world, { piece: p.piece, tier: p.tier, variant: p.variant, level: p.level, ...p.request });
    const reason = typeof sn === "number" ? sn : validatePlacement(c.world, c.player, sn);
    p.reason = reason; p.valid = reason === 0;
    if (reason) { this.toast = buildFailText(reason); return false; }
    const sent = this.o.send(placePreviewIntent(p)); this.toast = sent ? "Building…" : "Not connected"; return sent;
  }
  private disarm(): void { this.demolishArmedAt = -Infinity; }
  get demolishArmed(): boolean { return this.now() - this.demolishArmedAt < DEMOLISH_CONFIRM_MS; }
  /** Contextual Repair / Upgrade / Demolish on the targeted piece. Demolish needs a second press unless `confirmed`. */
  act(id: BuildActionId, confirmed = false): boolean {
    this.refresh(); const t = this.target; if (!t) return false;
    if (id === "repair") { if (!t.canRepair) { this.toast = "Nothing to repair"; return false; } if (!t.canAfford.repair) { this.toast = "Can't afford repair"; return false; } this.toast = "Repairing…"; return this.o.send(repairIntent(t.entity)); }
    if (id === "upgrade") { if (!t.canUpgrade || t.nextTier === undefined) { this.toast = "Already top tier"; return false; } if (!t.canAfford.upgrade) { this.toast = `Need materials for ${label(t.nextTierKey!)}`; return false; } this.toast = `Upgrading to ${label(t.nextTierKey!)}…`; return this.o.send(upgradeIntent(t.entity, t.nextTier)); }
    if (id === "reclaim") { if (!t.canReclaim) { this.toast = "Nothing to reclaim"; return false; } this.toast = "Reclaiming…"; return this.o.send(reclaimIntent(t.entity)); }
    const verb = t.pickup ? "Pick up" : "Demolish"; // ADR-250: pickup pieces (basic_storage_box) refund in full
    if (!confirmed && !this.demolishArmed) { this.demolishArmedAt = this.now(); this.toast = `${verb}? Press again to confirm`; return false; }
    this.disarm(); this.toast = t.pickup ? "Picking up…" : "Demolishing…"; return this.o.send(demolishIntent(t.entity));
  }
  get context(): BuildContextView | undefined {
    const t = this.target; if (!t) return undefined; const h = HINTS[this.device()]; const armed = this.demolishArmed;
    return { target: t, title: `${label(t.pieceKey)} · ${label(t.tierKey)} · ${Math.round((100 * t.hp) / Math.max(1, t.maxHp))}%`, actions: [
      { id: "repair", label: "Repair", hint: h.repair, enabled: t.canRepair && t.canAfford.repair },
      { id: "upgrade", label: t.nextTierKey ? `Upgrade → ${label(t.nextTierKey)}` : "Upgrade", hint: h.upgrade, enabled: t.canUpgrade && t.canAfford.upgrade },
      ...(t.canReclaim ? [{ id: "reclaim" as const, label: "Reclaim", hint: h.reclaim, enabled: true }] : []),
      { id: "demolish", label: t.pickup ? (armed ? "Confirm pick up" : "Pick up") : armed ? "Confirm demolish" : "Demolish", hint: h.demolish, enabled: true, armed },
    ] };
  }
  /** Aim actually used: touch point / gamepad cursor override the resolver's aim. */
  private aim(c: MenuCtx): PlacementAim | undefined {
    const dev = this.device(); const pt = c.world.get(c.player, Transform);
    if (dev === "touch" && this.touchPoint) return { mode: 1, ...this.touchPoint };
    if (dev === "gamepad" && this.padOffset && pt) return { mode: 1, x: pt.x + this.padOffset.x, y: pt.y + this.padOffset.y };
    return this.o.aim();
  }
  /** ADR-228: the last full refresh's inputs (everything but the aim point), aim and time, for the per-frame throttle. */
  private lastRefresh: { key: string; x: number; y: number; at: number } | undefined;
  /** ADR-228 bench/test counter: full (snap + validate + target) refreshes actually computed. */
  refreshes = 0;
  /**
   * `throttled` (the per-frame call only): skip the snap/validate/target queries while nothing but the aim changed and
   * the aim moved less than REFRESH_STEP tiles within REFRESH_MAX_MS since the last full pass; every explicit action
   * (place, rotate, level, tier, piece, snap toggle, target actions) still refreshes exactly. The view eases the ghost.
   */
  private refresh(throttled = false): void {
    const c = this.o.ctx(); if (!this.sel || !c) { this.preview = undefined; this.target = undefined; this.lastRefresh = undefined; return; }
    const aim = this.aim(c);
    // ADR-169: off = never assist; on = the default (facing / pad-cursor aims snap, a pointed mouse / tap cell stays exact so a red ghost says why)
    const assist = !this.snap ? false : this.device() === "gamepad" ? true : undefined; // pad cursor is imprecise: snap it too
    const sel = { ...this.sel, autoRot: this.rotLockAt === undefined };
    { const pt = c.world.get(c.player, Transform); const s = this.sel; const now = this.now();
      const key = `${s.piece}|${s.tier}|${s.variant}|${s.paint}|${sel.autoRot ? 1 : 0}|${this.requestRot}|${this.level}|${assist}|${aim?.mode}|${pt?.x}|${pt?.y}|${c.world.tick}|${c.player}|${c.world.isRegistered(BuildPiece) ? structures(c.world).count : 0}`;
      const ax = aim?.x ?? NaN, ay = aim?.y ?? NaN; const L = this.lastRefresh;
      if (throttled && L && L.key === key && now - L.at < REFRESH_MAX_MS && Math.abs(ax - L.x) < REFRESH_STEP && Math.abs(ay - L.y) < REFRESH_STEP) return;
      this.lastRefresh = { key, x: ax, y: ay, at: now }; this.refreshes++; }
    this.preview = buildPreviewFor(c.world, c.player, sel, this.requestRot, aim, this.level, assist);
    if (this.rotLockAt && this.preview && (Math.round(this.preview.x) !== this.rotLockAt.x || Math.round(this.preview.y) !== this.rotLockAt.y)) {
      this.rotLockAt = undefined; this.preview = buildPreviewFor(c.world, c.player, { ...this.sel, autoRot: true }, this.requestRot, aim, this.level, assist);
    }
    const at = placementTarget(c.world, c.player, aim);
    const prev = this.target?.entity; this.target = pieceTargetAt(c.world, c.player, at, this.level);
    if (this.target?.entity !== prev) this.disarm();
  }
  private padCursor(c: MenuCtx): void {
    const v = this.o.input.vector?.("Build.Nudge"); const t = this.now(); const dt = this.lastT === undefined ? 0 : Math.min(0.1, (t - this.lastT) / 1000); this.lastT = t;
    if (!v || Math.hypot(v[0] ?? 0, v[1] ?? 0) < 0.2) return;
    if (!this.padOffset) { const pt = c.world.get(c.player, Transform); const at = placementTarget(c.world, c.player, this.o.aim()); this.padOffset = pt && at ? { x: at.x - pt.x, y: at.y - pt.y } : { x: 0, y: 0 }; }
    const r = rotateScreenVec([v[0] ?? 0, v[1] ?? 0], this.o.input.viewQuarter ?? 0); const m = moveVector(0, { x: r[0], y: r[1] }); const reach = gameplayDefs(c.world).building.buildReach;
    let x = this.padOffset.x + m.dx * PAD_CURSOR_SPEED * dt, y = this.padOffset.y + m.dy * PAD_CURSOR_SPEED * dt; const d = Math.hypot(x, y); if (d > reach) { x *= reach / d; y *= reach / d; }
    this.padOffset = { x, y };
  }
  /** Per frame, after input.update(). */
  update(): void {
    // ADR-224: back to the menu only after Cancel is released (the same press must not also close the reopened menu)
    if (this.pendingBack && !this.sel) { if (!(this.o.input.down?.("Build.Cancel") ?? false)) { this.pendingBack = false; this.o.onBack?.(); } return; }
    if (!this.sel) return; const i = this.o.input; const c = this.o.ctx(); const dev = this.device();
    if (i.pressed("ToggleBuild") && this.o.onPickPiece) { this.o.onPickPiece(); return; }
    if (i.pressed("Build.Cancel")) { if (this.demolishArmed) { this.disarm(); this.toast = ""; return; } const back = this.fromMenu && !!this.o.onBack; this.stop(); this.pendingBack = back; return; }
    if (i.pressed("Build.RoadTool")) { this.tool("road"); return; } if (i.pressed("Build.PlaceSign")) { this.tool("sign"); return; }
    if (i.pressed("Build.ToggleSnap")) this.toggleSnap();
    if (c && dev === "gamepad") this.padCursor(c);
    // LevelUp/Down win over TierNext/Prev (pad: LT + D-pad up/down shares the D-pad with tier).
    const lvl = i.pressed("Build.LevelUp") ? 1 : i.pressed("Build.LevelDown") ? -1 : 0;
    if (lvl) this.setLevel(lvl);
    else if (i.pressed("Build.TierNext")) this.cycleTier(1); else if (i.pressed("Build.TierPrev")) this.cycleTier(-1);
    else if (i.pressed("Build.PieceNext")) this.cyclePiece(1); else if (i.pressed("Build.PiecePrev")) this.cyclePiece(-1);
    if (i.pressed("Build.RotateCW")) this.rotate(1); else if (i.pressed("Build.RotateCCW")) this.rotate(-1); else if (!(i.pressed("Build.PlaceConfirm") && !this.confirmLatch)) this.refresh(true);
    if (i.pressed("Build.RepairMode")) this.act("repair");
    else if (i.pressed("Build.UpgradeMode")) this.act("upgrade");
    else if (i.pressed("Build.DemolishMode")) this.act("demolish", dev === "gamepad"); // pad: the 500ms hold is the confirmation
    else if (i.pressed("Build.PlaceConfirm") && !this.confirmLatch) this.place();
    if (this.confirmLatch && !(i.down?.("Build.PlaceConfirm") ?? i.pressed("Build.PlaceConfirm"))) this.confirmLatch = false;
  }
}
