/**
 * ADR-212: hand interaction symbol above the crafting station that Interact would open (same selection as
 * `interactPanel`, so the symbol never disagrees with the button). Styled like the ADR-126 tool symbol and the ADR-161
 * loot prompt (dark disc, gold ring, `tool_req_hand` art; gold prompt pill), with the device hint underneath:
 * `[E]` on keyboard, the bound face button on gamepad, "Tap" on touch (and the symbol itself is a tap target).
 * No blinking: no pulse animation, one opacity fade, and hysteresis — once shown it stays while the player is within
 * `range + STATION_HINT.exitSlack` tiles and for `STATION_HINT.graceMs` after the target drops (prediction jitter at the
 * range edge). It hides at once when Interact would open something else (loot bag / pet / stall prompt).
 * Renderer-agnostic DOM overlay positioned from the shared camera (WebGL2 and Canvas2D identical).
 * DOM hook: `#station-hint[data-show][data-kind][data-device]`.
 */
import { Transform, type Entity, type World } from "@engine/core";
import { CraftingStation, STATION_NAMES } from "@engine/gameplay";
import { worldToScreen } from "@engine/world";
import { setAttr, setData } from "./dom-diff.js";
import { drawToolPlaceholder, type ArtFrame } from "./tool-hint.js";
import { camIso, type CameraLike } from "./world-tools.js";
import type { PromptDevice } from "./farm-prompt.js";

export const STATION_HINT = { exitSlack: 0.35, graceMs: 350, scanMs: 120 } as const;
/** Hand-icon lift (css px at zoom 1): above the node health bar (58 in gather-fx.ts), like the tool hint, so a
 * station's hand icon never sits over a nearby resource's bar; bars also draw above the icons (z-index). */
export const STATION_HINT_LIFT = 64;
/** What Interact would open now: a station, a door, something else, or nothing. */
export const DOOR_HINT_KIND = -1;
/** ADR-315: the hand over a Claim Flag (Use toggles its claim border). */
export const CLAIM_HINT_KIND = -2;
export type InteractPick = { station: Entity; kind: number } | { door: Entity } | { claim: Entity } | "other" | undefined;
export interface HintHold { station?: Entity; kind: number; lostAt: number }

/** Pure hysteresis step (tested). `near(e)`: the held target is still within range + exitSlack. */
export function holdStation(prev: HintHold, pick: InteractPick, near: (e: Entity) => boolean, now: number): HintHold {
  if (pick === "other") return { kind: 0, lostAt: 0 };
  if (pick && "door" in pick) return { station: pick.door, kind: DOOR_HINT_KIND, lostAt: 0 };
  if (pick && "claim" in pick) return { station: pick.claim, kind: CLAIM_HINT_KIND, lostAt: 0 };
  if (pick) return { station: pick.station, kind: pick.kind, lostAt: 0 };
  if (prev.station === undefined) return prev;
  if (!near(prev.station)) return { kind: 0, lostAt: 0 };
  const lostAt = prev.lostAt || now;
  return now - lostAt > STATION_HINT.graceMs ? { kind: 0, lostAt: 0 } : { ...prev, lostAt };
}
/** Device hint text under the hand. */
export const stationPrompt = (device: PromptDevice, key: string): string => (device === "touch" ? "Tap" : key ? `[${key}]` : "Use");

export interface StationHintDeps {
  world(): World; player(): Entity | undefined; camera(): CameraLike | undefined; hidden(): boolean;
  device(): PromptDevice; /** Interact binding label for the active device */ key(): string;
  pick(): InteractPick; /** touch tap */ open(station: Entity, kind: number): void;
  art?(): ArtFrame | undefined;
}

const CSS = `#station-hint{position:absolute;left:0;top:0;z-index:4;pointer-events:none;opacity:0;transition:opacity .2s ease;will-change:transform,opacity;display:flex;flex-direction:column;align-items:center;gap:3px}
#station-hint[data-show="true"]{opacity:1}#station-hint[data-device="touch"][data-show="true"]{pointer-events:auto;cursor:pointer}
#station-hint .key{font:700 12px Fredoka,system-ui,sans-serif;color:#F2D27E;background:rgba(20,16,12,.78);border:1.5px solid #F2D27E;border-radius:8px;padding:1px 7px;white-space:nowrap;box-shadow:0 0 8px rgba(255,200,90,.45)}
#station-hint[data-device="touch"] .key{font-size:14px;padding:4px 12px;min-height:24px}`;

export function mountStationHint(root: HTMLElement, d: StationHintDeps): { destroy(): void; current(): HintHold } {
  const style = document.createElement("style"); style.textContent = CSS; document.head.append(style);
  const el = document.createElement("div"); el.id = "station-hint"; el.setAttribute("role", "button"); el.dataset["show"] = "false";
  const cv = document.createElement("canvas"); cv.className = "icon"; const pill = document.createElement("span"); pill.className = "key";
  el.append(cv, pill); root.append(el);
  let hold: HintHold = { kind: 0, lostAt: 0 }; let shown: HintHold | undefined; let lastScan = -1e9; let raf = 0; let lastTf = ""; let drawn = ""; let img: HTMLImageElement | null | undefined;
  const near = (e: Entity): boolean => { // getField: no per-scan object allocation (ADR-212 heap churn)
    const w = d.world(); const p = d.player(); if (p === undefined || !w.isAlive(e)) return false;
    const ax = w.getField(p, Transform, "x"), ay = w.getField(p, Transform, "y"), bx = w.getField(e, Transform, "x"), by = w.getField(e, Transform, "y");
    if (ax === undefined || ay === undefined || bx === undefined || by === undefined) return false;
    const r = w.isRegistered(CraftingStation) ? w.getField(e, CraftingStation, "range") : undefined;
    return Math.hypot(ax - bx, ay - by) <= (r ?? 4) + STATION_HINT.exitSlack;
  };
  const draw = (size: number): void => {
    const f = d.art?.();
    if (f && img === undefined) { img = null; const im = new Image(); im.onload = () => { img = im; drawn = ""; }; im.src = f.src; }
    const key = `${size}|${img ? 1 : 0}`; if (key === drawn) return; drawn = key;
    const dpr = Math.min(3, globalThis.devicePixelRatio || 1); cv.width = cv.height = Math.round(size * dpr); cv.style.width = cv.style.height = `${size}px`;
    const g = cv.getContext("2d"); if (!g) return;
    g.setTransform(cv.width / 32, 0, 0, cv.height / 32, 0, 0); g.clearRect(0, 0, 32, 32);
    g.fillStyle = "rgba(20,16,12,.78)"; g.strokeStyle = "#F2D27E"; g.lineWidth = 2; g.beginPath(); g.arc(16, 16, 14.5, 0, Math.PI * 2); g.fill(); g.stroke();
    if (img && f) g.drawImage(img, f.sx, f.sy, f.sw, f.sh, 5, 5, 22, 22); else { g.save(); g.translate(4, 4); g.scale(0.75, 0.75); drawToolPlaceholder(g, "hand"); g.restore(); }
  };
  const tick = (now: number): void => {
    raf = requestAnimationFrame(tick);
    try {
      if (now - lastScan >= STATION_HINT.scanMs) {
        lastScan = now;
        hold = d.player() === undefined || d.hidden() ? { kind: 0, lostAt: 0 } : holdStation(hold, d.pick(), near, now);
      }
      const cam = d.camera(); const on = hold.station !== undefined && !!cam;
      setData(el, "show", String(on));
      if (on) shown = hold; // keep the last target while fading out
      if (!shown || shown.station === undefined || !cam) return;
      const w = d.world(); const tx = w.getField(shown.station, Transform, "x"), ty = w.getField(shown.station, Transform, "y"); if (tx === undefined || ty === undefined) return;
      const dev = d.device(); const size = dev === "touch" ? 44 : 34; draw(size);
      setData(el, "kind", String(shown.kind)); setData(el, "device", dev);
      const name = shown.kind === DOOR_HINT_KIND ? "Door" : shown.kind === CLAIM_HINT_KIND ? "Claim border" : (STATION_NAMES[shown.kind] ?? "Station"); const txt = stationPrompt(dev, d.key());
      if (pill.textContent !== txt) pill.textContent = txt;
      setAttr(el, "aria-label", `${txt} ${name}`); setAttr(el, "title", name);
      const s = worldToScreen(tx, ty, w.getField(shown.station, Transform, "z") ?? 0, camIso(cam)); const z = cam.drawZoom;
      const x = (s.sx - cam.x) * z + cam.viewW / cam.dpr / 2, y = (s.sy - cam.y) * z + cam.viewH / cam.dpr / 2;
      const lift = STATION_HINT_LIFT * Math.max(0.6, Math.min(2, z));
      const tf = `translate(${Math.round(x - size / 2)}px,${Math.round(y - lift - size - (dev === "touch" ? 30 : 22))}px)`; if (tf !== lastTf) { lastTf = tf; el.style.transform = tf; } // pill sits above the sprite top
    } catch { el.dataset["show"] = "false"; }
  };
  el.addEventListener("click", (ev) => { ev.preventDefault(); if (hold.station !== undefined && d.device() === "touch") d.open(hold.station, hold.kind); });
  raf = requestAnimationFrame(tick);
  return { current: () => hold, destroy: () => { cancelAnimationFrame(raf); el.remove(); style.remove(); } };
}
