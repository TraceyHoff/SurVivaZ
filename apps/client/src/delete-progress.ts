/**
 * Delete progress (ADR-099, ADR-436): the confirm dialog shared by the main menu (BootUI) and the in-game Settings panel
 * (GameMenus/UINav), plus the browser-side wipes (singleplayer world DB, P2P hosted world DB, optional settings).
 *
 * Confirm = hold the "Hold to delete" button for HOLD_MS (mouse/touch press, Enter/Space held, or gamepad A held while
 * it is focused). There is no typed confirmation and no Delete button: the hold is the single path on every input type,
 * so keyboard, touch and gamepad all delete the same way. Nothing is deleted on a single tap/click/A press.
 */
import { gamepadKeyControl, navPad, padHeld } from "./pad-input.js";
import { deletePaintedCache, type PaintedCaches } from "./painted-cache.js";
export const HOLD_MS = 1500;
/** localStorage keys reset only when the player opts in ("Also reset settings"). */
export const SETTINGS_KEYS = ["engine-settings", "engine.input.bindings", "survivaz.render.quality"] as const;

type Pad = { buttons: readonly { pressed: boolean }[] } | null;
export interface DeleteConfirmOptions {
  message: string;
  /** Show "Also reset settings" (unchecked = keep settings). */
  settingsOption?: boolean;
  onConfirm: (o: { resetSettings: boolean }) => Promise<string> | string;
  onCancel: () => void;
  now?: () => number;
  getGamepads?: () => readonly Pad[];
  /** Drive the hold timer yourself (tests): `tick()` on the handle. Default: requestAnimationFrame. */
  manualTick?: boolean;
  /** Main-menu picker: false while nothing is selected (Delete + Hold are disabled). Call `refresh()` when it changes. */
  canConfirm?: () => boolean;
  /** Put the Delete / Hold buttons here (a sticky footer next to Back) instead of inside the dialog body. */
  actions?: HTMLElement;
}
export interface DeleteConfirm { el: HTMLElement; tick(): void; refresh(): void; destroy(): void; readonly done: boolean }

const frame = (cb: () => void): number => (typeof (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame === "function" ? requestAnimationFrame(cb) : setTimeout(cb, 16) as unknown as number);
export function deleteConfirm(o: DeleteConfirmOptions): DeleteConfirm {
  const now = o.now ?? (() => performance.now());
  const pads = o.getGamepads ?? (() => [...(navigator.getGamepads?.() ?? [])]);
  const el = document.createElement("div"); el.dataset["role"] = "delete-confirm"; el.style.cssText = "display:flex;flex-direction:column;gap:8px";
  const msg = document.createElement("p"); msg.textContent = o.message;
  const hint = document.createElement("p"); hint.dataset["role"] = "delete-hint"; hint.style.cssText = "opacity:.8"; hint.textContent = `Hold the button for ${HOLD_MS / 1000} seconds to delete. A tap never deletes.`;
  const status = document.createElement("p"); status.dataset["role"] = "delete-status"; status.setAttribute("aria-live", "polite");
  const reset = document.createElement("input"); reset.type = "checkbox"; reset.dataset["role"] = "reset-settings";
  const rl = document.createElement("label"); rl.append(reset, " Also reset settings (HUD, bots, key bindings)");
  const hold = document.createElement("button"); hold.type = "button"; hold.dataset["action"] = "hold-delete"; hold.dataset["hold"] = "1"; hold.textContent = "Hold to delete";
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.dataset["action"] = "cancel-delete"; cancel.textContent = "Cancel"; cancel.className = "alt";
  if (o.actions) { o.actions.append(hold); el.append(msg, hint, ...(o.settingsOption ? [rl] : []), status); }
  else el.append(msg, hint, ...(o.settingsOption ? [rl] : []), hold, cancel, status);

  let shown = false, done = false, busy = false, holdFrom: number | undefined, keyHeld = false, pointerHeld = false, raf = 0, destroyed = false;
  const can = (): boolean => o.canConfirm?.() ?? true;
  const sync = (): void => { const c = can(); hold.disabled = !c; if (!c) { keyHeld = false; pointerHeld = false; } };
  const confirm = async (): Promise<void> => {
    if (done || busy) return; busy = true; status.textContent = "Deleting…"; holdFrom = undefined; paint(0);
    try { status.textContent = await o.onConfirm({ resetSettings: reset.checked }); done = true; }
    catch (e) { status.textContent = `Couldn't delete: ${e instanceof Error ? e.message : String(e)}`; }
    finally { busy = false; }
  };
  const paint = (f: number): void => { hold.style.background = f > 0 ? `linear-gradient(90deg,#d9534f ${Math.round(f * 100)}%,transparent ${Math.round(f * 100)}%)` : ""; hold.textContent = f > 0 ? `Hold… ${Math.ceil(((1 - f) * HOLD_MS) / 100) / 10}s` : "Hold to delete"; };
  // ADR-213: merged pads (mapping "" normalised) or Edge's keyboard-emulated GamepadA held on the hold button
  let padKeyA = false;
  const onPadKey = (e: KeyboardEvent): void => { if (gamepadKeyControl(e) === "A") padKeyA = e.type === "keydown" && document.activeElement === hold; };
  addEventListener("keydown", onPadKey, true); addEventListener("keyup", onPadKey, true); addEventListener("blur", () => { padKeyA = false; });
  const padA = (): boolean => document.activeElement === hold && (padKeyA || padHeld(navPad(pads as never), "A"));
  const tick = (): void => {
    if (destroyed) return;
    if (el.isConnected) shown = true; else if (shown) { destroyed = true; removeEventListener("keydown", onPadKey, true); removeEventListener("keyup", onPadKey, true); return; } // dialog closed/replaced
    const held = keyHeld || pointerHeld || padA();
    if (!held || done || busy || !can()) { if (holdFrom !== undefined) { holdFrom = undefined; paint(0); } }
    else { holdFrom ??= now(); const f = Math.min(1, (now() - holdFrom) / HOLD_MS); paint(f); if (f >= 1) void confirm(); }
    if (!o.manualTick) raf = frame(tick);
  };
  hold.addEventListener("click", (e) => { e.preventDefault(); }); // a tap / single A press never deletes
  hold.addEventListener("pointerdown", (e) => { e.preventDefault(); pointerHeld = true; hold.focus(); });
  for (const t of ["pointerup", "pointerleave", "pointercancel"]) hold.addEventListener(t, () => { pointerHeld = false; });
  hold.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); keyHeld = true; } });
  hold.addEventListener("keyup", (e) => { if (e.key === "Enter" || e.key === " ") keyHeld = false; });
  hold.addEventListener("blur", () => { keyHeld = false; pointerHeld = false; });
  cancel.addEventListener("click", () => { if (!busy) o.onCancel(); });
  sync();
  if (!o.manualTick) raf = frame(tick);
  return { el, tick, refresh: sync, destroy: () => { destroyed = true; removeEventListener("keydown", onPadKey, true); removeEventListener("keyup", onPadKey, true); (globalThis.cancelAnimationFrame ?? clearTimeout)(raf); }, get done() { return done; } };
}

type Factory = Pick<IDBFactory, "deleteDatabase"> & { databases?: () => Promise<{ name?: string }[]> };
/** Deletes one IndexedDB database (every version). "blocked" = another tab/connection still holds it open. */
export function deleteIndexedDb(name: string, factory: Factory = indexedDB, blockedMs = 4000): Promise<"deleted" | "blocked"> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const req = factory.deleteDatabase(name);
    req.onsuccess = () => { if (timer) clearTimeout(timer); resolve("deleted"); };
    req.onerror = () => { if (timer) clearTimeout(timer); reject(req.error ?? new Error(`deleting ${name} failed`)); };
    req.onblocked = () => { timer ??= setTimeout(() => resolve("blocked"), blockedMs); };
  });
}

export interface WipeResult { ok: boolean; message: string; deleted: string[] }
/** Singleplayer world DB name for a ?player slot (main.ts openBrowserStore). */
export const localDbName = (slot: string): string => `engine-local-${slot}`;
export const hostDbName = (slot: string): string => `engine-p2p-host-${slot}`;

// ---- ADR-526 fresh start: "Delete everything" must mean everything ----

/** localStorage / sessionStorage keys owned by the game. Anything else on the origin is left alone — never localStorage.clear(). */
export function isGameStorageKey(key: string): boolean {
  return key === "charArt" || key.startsWith("engine.") || key.startsWith("engine-") || key.startsWith("survivaz.") || key.startsWith("survivaz-");
}

/** Removes every game-owned key from a storage (localStorage or sessionStorage). Returns what was removed; unrelated keys survive. */
export function sweepGameStorage(store: Pick<Storage, "key" | "length" | "removeItem">): string[] {
  const gone: string[] = [];
  for (let i = 0; i < store.length; i++) { const k = store.key(i); if (k && isGameStorageKey(k)) gone.push(k); }
  for (const k of gone) store.removeItem(k);
  return gone;
}

/** ?player slots with data on this device: from IndexedDB names, plus slots named in storage keys (fallback when databases() is unavailable). */
export async function listGameSlots(env: { slot: string; factory?: Factory; storage?: Pick<Storage, "key" | "length"> }): Promise<string[]> {
  const slots = new Set([env.slot]);
  const f = env.factory ?? indexedDB;
  try {
    for (const d of (await f.databases?.()) ?? []) {
      if (!d.name) continue;
      for (const p of ["engine-local-", "engine-p2p-host-"] as const) if (d.name.startsWith(p)) slots.add(d.name.slice(p.length));
    }
  } catch { /* databases() unsupported — fall through to key parsing */ }
  const st = env.storage ?? localStorage;
  for (let i = 0; i < st.length; i++) {
    const k = st.key(i); if (!k) continue;
    const m = /^engine\.lastPlayed\.[a-z]+\.(.+)$/.exec(k) ?? /^survivaz\.character\.[a-z]+\.(.+)$/.exec(k) ?? /^survivaz-tutorial-(.+)$/.exec(k) ?? /^engine\.(?:account|name|server)\.(.+)$/.exec(k);
    if (m?.[1]) slots.add(m[1]);
  }
  return [...slots];
}

/** Deletes every engine-local-* / engine-p2p-host-* database on this device (all ?player slots). */
export async function wipeAllGameDatabases(o: { slots: string[]; factory?: Factory; blockedMs?: number }): Promise<WipeResult> {
  const deleted: string[] = [];
  const dbOpts = { ...(o.factory ? { factory: o.factory } : {}), ...(o.blockedMs !== undefined ? { blockedMs: o.blockedMs } : {}) };
  for (const slot of o.slots) {
    for (const name of [localDbName(slot), hostDbName(slot)]) {
      const r = await wipe(name, dbOpts);
      if (!r.ok) return { ...r, deleted };
      deleted.push(...r.deleted);
    }
  }
  return { ok: true, deleted, message: "" };
}

const sessionStore = (env: LocalSaveEnv): Pick<Storage, "key" | "length" | "removeItem"> | undefined => {
  if (env.session) return env.session;
  try { return globalThis.sessionStorage ?? undefined; } catch { return undefined; }
};

async function wipe(base: string, o: { factory?: Factory; blockedMs?: number; close?: () => Promise<void> | void }): Promise<WipeResult> {
  const factory = o.factory ?? indexedDB;
  await o.close?.(); // our own connection first (local server + store), else the delete is blocked by this tab
  const names = new Set([base]);
  try { for (const d of (await factory.databases?.()) ?? []) if (d.name && d.name.startsWith(`${base}-`)) names.add(d.name); } catch { /* databases() unsupported */ }
  const deleted: string[] = [];
  for (const n of names) {
    if ((await deleteIndexedDb(n, factory, o.blockedMs)) === "blocked")
      return { ok: false, deleted, message: "The save is still open in another tab or window of the game. Close the other tabs and try again." };
    deleted.push(n);
  }
  return { ok: true, deleted, message: "" };
}

/**
 * Singleplayer "Delete save": the world DB (chunks, your character + inventory + look, human bots' memory `game.agents`,
 * world meta) is deleted outright. Settings stay unless `resetSettings`. The account token (shared with servers) stays.
 */
export async function wipeSingleplayerSave(o: { slot: string; resetSettings: boolean; factory?: Factory; storage?: Pick<Storage, "removeItem">; blockedMs?: number; close?: () => Promise<void> | void }): Promise<WipeResult> {
  const r = await wipe(localDbName(o.slot), o);
  if (!r.ok) return r;
  if (o.resetSettings) { const s = o.storage ?? localStorage; for (const k of SETTINGS_KEYS) s.removeItem(k); }
  return { ...r, message: `Singleplayer save deleted${o.resetSettings ? " and settings reset" : ""}. The next Singleplayer start is a fresh world.` };
}

/** P2P "Delete hosted world" (the world your guests played in). Refused while you are hosting it. */
export async function wipeHostedWorld(o: { slot: string; hosting: boolean; factory?: Factory; blockedMs?: number }): Promise<WipeResult> {
  if (o.hosting) return { ok: false, deleted: [], message: "End the hosted session first (Pause → Session → End session)." };
  const r = await wipe(hostDbName(o.slot), o);
  return r.ok ? { ...r, message: "Hosted world deleted. The next Host game starts a fresh world." } : r;
}

// ---- Main-menu "Delete progress" picker (ADR-099): what is stored on this device, per category ----
export type LocalSaveKind = "singleplayer" | "hosted" | "character" | "bots" | "settings";
export interface LocalSave { kind: LocalSaveKind; label: string; present: boolean; detail: string }
/** Human bots' long-term memory records in the singleplayer DB (server agents.ts AGENT_NS). */
export const AGENT_RECORDS_NS = "agents";
/** localStorage "last played" stamps, written by main.ts when a mode starts. */
export const lastPlayedKey = (mode: "singleplayer" | "hosted", slot: string): string => `engine.lastPlayed.${mode}.${slot}`;
type StoreLike = { playerTokens(): string[]; listRecords(ns: string): { id: string; bytes: Uint8Array }[]; count(t: "chunks" | "players" | "records"): number;
  write(b: { deletePlayers?: string[]; deleteRecords?: { ns: string; id: string }[] }): Promise<void>; close(): Promise<void> };
export interface LocalSaveEnv { slot: string; factory?: Factory; storage?: Pick<Storage, "getItem" | "removeItem" | "key" | "length">; /** Defaults to this tab's sessionStorage (guarded — private mode may throw). */ session?: Pick<Storage, "key" | "length" | "removeItem">; openStore?: (name: string) => Promise<StoreLike>; now?: () => number; /** ADR-550: Cache Storage holding the painted-PNG cache (defaults to globalThis.caches); only "Delete everything" clears it. */ paintedCaches?: PaintedCaches | null }
const defaultOpen = async (name: string, factory: Factory): Promise<StoreLike> => {
  const { IndexedDbWorldStore } = await import("@engine/persist");
  return IndexedDbWorldStore.open(name, { factory: factory as never });
};
async function exists(name: string, factory: Factory): Promise<boolean | undefined> {
  try { const l = await factory.databases?.(); return l ? l.some((d) => d.name === name) : undefined; } catch { return undefined; }
}
async function withStore<T>(env: LocalSaveEnv, name: string, fn: (s: StoreLike) => Promise<T> | T): Promise<T | undefined> {
  const f = env.factory ?? indexedDB;
  if ((await exists(name, f)) === false) return undefined; // never create an empty DB just to look at it
  const s = await (env.openStore ? env.openStore(name) : defaultOpen(name, f));
  try { return await fn(s); } finally { await s.close(); }
}
const ago = (t: number, now: number): string => { const d = Math.max(0, now - t) / 60000; return d < 2 ? "just now" : d < 120 ? `${Math.round(d)} min ago` : d < 2880 ? `${Math.round(d / 60)} h ago` : new Date(t).toLocaleDateString(); };
const kb = (n: number): string => (n < 1024 ? `${n} B` : `${Math.round(n / 102.4) / 10} KB`);

/** Lists the saves on this device with what's known about them (counts / size / last played). */
export async function listLocalSaves(env: LocalSaveEnv): Promise<LocalSave[]> {
  const st = env.storage ?? localStorage; const now = env.now?.() ?? Date.now();
  const played = (m: "singleplayer" | "hosted"): string => { const t = Number(st.getItem(lastPlayedKey(m, env.slot))); return t > 0 ? `last played ${ago(t, now)}` : ""; };
  const join = (...p: string[]): string => p.filter(Boolean).join(" · ");
  const sp = await withStore(env, localDbName(env.slot), (s) => ({ chunks: s.count("chunks"), players: s.playerTokens().length, bots: s.listRecords(AGENT_RECORDS_NS) }));
  const host = await withStore(env, hostDbName(env.slot), (s) => ({ chunks: s.count("chunks"), players: s.playerTokens().length }));
  const settingsBytes = SETTINGS_KEYS.reduce((n, k) => n + (st.getItem(k)?.length ?? 0), 0);
  const chars = (sp?.players ?? 0) + (host?.players ?? 0);
  const botBytes = sp?.bots.reduce((n, r) => n + r.bytes.length, 0) ?? 0;
  return [
    { kind: "singleplayer", label: "Singleplayer world", present: !!sp, detail: sp ? join(`${sp.chunks} saved chunks`, played("singleplayer")) : "none" },
    { kind: "hosted", label: "Hosted multiplayer world", present: !!host, detail: host ? join(`${host.chunks} saved chunks, ${host.players} characters`, played("hosted")) : "none" },
    { kind: "character", label: "Character / appearance", present: chars > 0, detail: chars ? `${chars} saved character${chars === 1 ? "" : "s"} (singleplayer + hosted)` : "none" },
    { kind: "bots", label: "Bot memories", present: (sp?.bots.length ?? 0) > 0, detail: sp?.bots.length ? `${sp.bots.length} bots · ${kb(botBytes)}` : "none" },
    { kind: "settings", label: "Settings", present: settingsBytes > 0, detail: settingsBytes ? kb(settingsBytes) : "defaults" },
  ];
}

/**
 * Deletes the chosen categories. A whole world (singleplayer / hosted) is deleted as a database; "character" and
 * "bots" alone delete just those rows inside the worlds that are kept. `everything` (ADR-526) is a true fresh start:
 * every ?player slot's worlds, every game localStorage key (all slots, server URL, error log, FX/audio settings,
 * charArt, tutorial progress) and every game sessionStorage key — then the caller reloads to the menu.
 */
export async function deleteLocalProgress(env: LocalSaveEnv & { kinds: ReadonlySet<LocalSaveKind>; everything?: boolean; blockedMs?: number }): Promise<WipeResult> {
  const st = env.storage ?? localStorage;
  if (env.everything) {
    const slots = await listGameSlots(env);
    const dbOpts = { ...(env.factory ? { factory: env.factory } : {}), ...(env.blockedMs !== undefined ? { blockedMs: env.blockedMs } : {}) };
    const r = await wipeAllGameDatabases({ slots, ...dbOpts });
    if (!r.ok) return r;
    sweepGameStorage(st);
    const session = sessionStore(env); if (session) sweepGameStorage(session);
    // ADR-550: the painted-PNG cache is the game's own generated data, so "Delete everything"
    // clears it too (best-effort — a Cache Storage failure never fails the wipe). Per-category
    // deletes and in-game Delete-save stay slot-scoped and never touch it.
    await deletePaintedCache({ caches: env.paintedCaches });
    return { ok: true, deleted: r.deleted, message: `Deleted everything: all saves, settings and game data on this device (${slots.length} player slot${slots.length === 1 ? "" : "s"}). The next start is a fresh game.` };
  }
  const k = env.kinds;
  if (!k.size) return { ok: false, deleted: [], message: "Pick at least one thing to delete." };
  const deleted: string[] = []; const done: string[] = [];
  const dbOpts = { ...(env.factory ? { factory: env.factory } : {}), ...(env.blockedMs !== undefined ? { blockedMs: env.blockedMs } : {}) };
  for (const [kind, name, mode] of [["singleplayer", localDbName(env.slot), "singleplayer"], ["hosted", hostDbName(env.slot), "hosted"]] as const) {
    if (k.has(kind)) {
      const r = await wipe(name, dbOpts); deleted.push(...r.deleted); if (!r.ok) return { ...r, deleted };
      st.removeItem(lastPlayedKey(mode, env.slot)); done.push(kind === "singleplayer" ? "singleplayer world" : "hosted world");
      continue;
    }
    const wantChars = k.has("character"), wantBots = kind === "singleplayer" && k.has("bots");
    if (!wantChars && !wantBots) continue;
    await withStore(env, name, async (s) => {
      await s.write({ ...(wantChars ? { deletePlayers: s.playerTokens() } : {}), ...(wantBots ? { deleteRecords: s.listRecords(AGENT_RECORDS_NS).map((r) => ({ ns: AGENT_RECORDS_NS, id: r.id })) } : {}) });
    });
  }
  if (k.has("character") || (k.has("singleplayer") && k.has("hosted"))) for (const ck of ["singleplayer", "hosted", "remote"] as const) st.removeItem(`survivaz.character.${ck}.${env.slot}`); // ADR-114 creator choices
  if (k.has("character") && !(k.has("singleplayer") && k.has("hosted"))) done.push("characters");
  if (k.has("bots") && !k.has("singleplayer")) done.push("bot memories");
  if (k.has("settings")) { for (const key of SETTINGS_KEYS) st.removeItem(key); done.push("settings"); }
  return { ok: true, deleted, message: `Deleted: ${done.join(", ")}.` };
}
