/**
 * World map (Task 9): a north-up top-down canvas of the client's known terrain, the player's position + facing, and
 * map markers. North is up (world -x-y), east is right (world +x-y). Tiles are coloured with the renderer's TILE_COLORS
 * by TileId; only chunks the client has received are drawn (unknown tiles stay dark), so the map never invents terrain.
 * Input: touch/mouse drag to pan, wheel to zoom, two-finger pinch to zoom on mobile (the world point under the
 * pinch midpoint stays under it, so spreading fingers zooms in on that spot and dragging both fingers pans),
 * tap/click to place a marker (opens a creation form: label + visibility
 * Private/Party/Clan, set at creation and enforced server-side). Gamepad/keyboard: the panel is a normal UINav modal —
 * pan buttons move the centre crosshair, "Mark here" (pad X) places a marker at the crosshair, "Mark my location"
 * places one at the player, "Centre on me" (pad Y) recentres; D-pad/Tab/Enter navigate the controls (UINav owns the
 * D-pad for focus, so there is no free gamepad cursor — the crosshair is the gamepad placement point).
 * Compass: a rose on the canvas (fixed N/E/S/W, needle = facing) plus the HUD compass strip (compass-hud.ts).
 */
import { Transform, type Entity, type World } from "@engine/core";
import { compassOf, placeMapMarkerIntent, removeMapMarkerIntent, visibleMarkers, type MenuIntent } from "@engine/gameplay";
import { TILE_COLORS } from "@engine/render";
import { createIdleTracker, idleCompass } from "./compass-hud.js";
import { northUpToWorld, worldToNorthUp, type TileMap } from "@engine/world";
import { iconImg } from "./game-icons.js";

export interface WorldMapSource {
  world(): World | undefined;
  player(): Entity | undefined;
  tiles(): TileMap | undefined;
  send(i: MenuIntent): boolean;
  status?(t: string): void;
}
/** Pin colour by MarkerVisibility (0 private, 1 party, 2 clan). */
export const markerPinColor = (visibility: number): string => visibility === 1 ? "#7dff9b" : visibility === 2 ? "#ffb347" : "#7fb3ff";
export const MARKER_VISIBILITY_LABELS = ["Private", "Party", "Clan"] as const;
/** World tile coords of a canvas pixel. Centre = world point at canvas centre; scale = px per tile. */
export function canvasToWorld(px: number, py: number, w: number, h: number, centre: { x: number; y: number }, scale: number): { x: number; y: number } {
  const d = northUpToWorld((px - w / 2) / scale, (py - h / 2) / scale);
  return { x: centre.x + d.x, y: centre.y + d.y };
}
/** Canvas pixel of a world point (inverse of canvasToWorld). */
export function worldToCanvas(x: number, y: number, w: number, h: number, centre: { x: number; y: number }, scale: number): { px: number; py: number } {
  const d = worldToNorthUp(x - centre.x, y - centre.y);
  return { px: d.x * scale + w / 2, py: d.y * scale + h / 2 };
}
/** Conservative world bounds of the rotated north-up viewport (including edge tiles). */
export function mapWorldBounds(w: number, h: number, centre: { x: number; y: number }, scale: number): { x0: number; x1: number; y0: number; y1: number } {
  const corners = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => canvasToWorld(x!, y!, w, h, centre, scale));
  return { x0: Math.floor(Math.min(...corners.map(p => p.x))) - 1, x1: Math.ceil(Math.max(...corners.map(p => p.x))) + 1,
    y0: Math.floor(Math.min(...corners.map(p => p.y))) - 1, y1: Math.ceil(Math.max(...corners.map(p => p.y))) + 1 };
}
/** One pinch step (pure, for tests): zoom by the finger-distance ratio, clamped to the map's [2, 32] px/tile range,
 * and re-centre so the world point that was under the previous midpoint stays under the current midpoint — so a
 * pure spread zooms in on that spot and dragging both fingers together pans. Midpoints are canvas pixels. */
export function pinchStep(o: { centre: { x: number; y: number }; scale: number; midPrevPx: number; midPrevPy: number; midPx: number; midPy: number; canvasW: number; canvasH: number; prevDist: number; curDist: number }): { centre: { x: number; y: number }; scale: number } {
  const scale = Math.min(32, Math.max(2, o.scale * (o.prevDist > 0 ? o.curDist / o.prevDist : 1)));
  const under = canvasToWorld(o.midPrevPx, o.midPrevPy, o.canvasW, o.canvasH, o.centre, o.scale);
  const offset = canvasToWorld(o.midPx, o.midPy, o.canvasW, o.canvasH, { x: 0, y: 0 }, scale);
  return { centre: { x: under.x - offset.x, y: under.y - offset.y }, scale };
}

export function createWorldMap(src: WorldMapSource, doc: Document = document): { el: HTMLElement; destroy(): void } {
  const el = doc.createElement("div"); el.dataset["role"] = "world-map"; el.style.cssText = "display:flex;flex-direction:column;gap:8px";
  const canvas = doc.createElement("canvas"); canvas.dataset["role"] = "map-canvas"; canvas.width = 480; canvas.height = 360;
  canvas.style.cssText = "display:block;width:100%;height:auto;aspect-ratio:4/3;box-sizing:border-box;touch-action:none;background:#1b1f1a;border:2px solid #74432C;border-radius:8px;cursor:crosshair";
  canvas.setAttribute("aria-label", "World map — drag to pan, pinch to zoom, tap a spot to place a marker");
  const state = { centre: { x: 0, y: 0 }, scale: 16, following: true, drag: null as null | { px: number; py: number; cx: number; cy: number }, placed: null as null | { x: number; y: number },
    pointers: new Map<number, { x: number; y: number }>(), pinch: null as null | { d: number; mx: number; my: number }, pinched: false };
  const mapIdle = createIdleTracker();
  const controls = doc.createElement("div"); controls.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center";
  const btn = (t: string, fn: () => void, extra?: Record<string, string>): HTMLButtonElement => { const b = doc.createElement("button"); b.type = "button"; b.textContent = t; if (extra) for (const [k, v] of Object.entries(extra)) b.dataset[k] = v; b.addEventListener("click", fn); controls.append(b); return b; };
  const pan = (dx: number, dy: number): void => { state.following = false; const d = northUpToWorld(dx, dy); state.centre.x += d.x; state.centre.y += d.y; draw(); };
  btn("↑", () => pan(0, -4), { key: "pan-up" }); btn("↓", () => pan(0, 4), { key: "pan-down" }); btn("←", () => pan(-4, 0), { key: "pan-left" }); btn("→", () => pan(4, 0), { key: "pan-right" });
  btn("Centre on me", () => { state.following = true; draw(); }, { pad: "Y", padLabel: "Centre on me" });
  btn("Mark here", () => { state.placed = { ...state.centre }; showForm(); }, { pad: "X", padLabel: "Mark here" });
  btn("Mark my location", () => { const w = src.world(), p = src.player(); if (!w || p === undefined) return; const t = w.get(p, Transform); if (!t) return; state.placed = { x: t.x, y: t.y }; showForm(); });
  btn("Zoom +", () => { state.scale = Math.min(32, state.scale * 1.5); draw(); }); btn("Zoom −", () => { state.scale = Math.max(2, state.scale / 1.5); draw(); });
  const note = doc.createElement("p"); note.dataset["role"] = "map-note"; note.style.cssText = "margin:0;font-size:13px"; note.textContent = "North is up ↑. Dark areas are unexplored. Tap a spot on the map (or use Mark here / Mark my location) to place a marker. Markers are small pins; tap one in the list to remove it.";
  // Marker creation form (hidden until a spot is picked).
  const form = doc.createElement("div"); form.dataset["role"] = "marker-form"; form.hidden = true; form.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center";
  const labelInput = doc.createElement("input"); labelInput.type = "text"; labelInput.maxLength = 24; labelInput.placeholder = "Marker name"; labelInput.setAttribute("aria-label", "Marker name");
  const visSelect = doc.createElement("select"); visSelect.setAttribute("aria-label", "Marker visibility");
  for (let i = 0; i < 3; i++) { const o = doc.createElement("option"); o.value = String(i); o.textContent = MARKER_VISIBILITY_LABELS[i]!; visSelect.append(o); }
  const placeBtn = doc.createElement("button"); placeBtn.type = "button"; placeBtn.textContent = "Place marker"; placeBtn.dataset["role"] = "submit";
  const cancelBtn = doc.createElement("button"); cancelBtn.type = "button"; cancelBtn.className = "alt"; cancelBtn.textContent = "Cancel";
  form.append(labelInput, visSelect, placeBtn, cancelBtn);
  const showForm = (): void => { form.hidden = false; labelInput.value = ""; labelInput.focus(); };
  placeBtn.addEventListener("click", () => { if (!state.placed) return; const ok = src.send(placeMapMarkerIntent(state.placed.x, state.placed.y, Number(visSelect.value), labelInput.value || "Marker")); note.textContent = ok ? "Marker placed." : "Could not place marker — are you connected?"; src.status?.(note.textContent); form.hidden = true; state.placed = null; draw(); });
  cancelBtn.addEventListener("click", () => { form.hidden = true; state.placed = null; draw(); });
  // Own markers list (removal is owner-only server-side, so only own markers get a Remove button).
  const list = doc.createElement("div"); list.dataset["role"] = "marker-list"; list.style.cssText = "display:flex;flex-direction:column;gap:4px";
  let listKey = "";
  // Task 26: takes the markers draw() already computed (one visibleMarkers query per frame, not two).
  const rebuildList = (all: ReturnType<typeof visibleMarkers>): void => { const w = src.world(), p = src.player(); if (!w || p === undefined) { if (listKey !== "") { listKey = ""; list.replaceChildren(); } return; }
    // Every visible marker is listed; removal of a marker the viewer does not own is rejected server-side (not_owner).
    const key = all.map((m) => `${m.entity}:${m.label}:${m.visibility}`).join("|"); if (key === listKey) return; listKey = key; list.replaceChildren();
    for (const m of all) { const row = doc.createElement("div"); row.style.cssText = "display:flex;gap:6px;align-items:center;font-size:13px";
      // Task 25: custom pin icon (was 📍 emoji); the visibility is also spelled out in the label text.
      const dot = doc.createElement("span"); dot.append(iconImg("ic_pin.png", 14, "Marker")); row.append(dot);
      const t = doc.createElement("span"); t.textContent = `${m.label || "Marker"} (${MARKER_VISIBILITY_LABELS[m.visibility] ?? "Private"})`; row.append(t);
      const rm = doc.createElement("button"); rm.type = "button"; rm.className = "alt"; rm.textContent = "Remove"; rm.dataset["marker"] = String(m.entity);
      rm.addEventListener("click", () => { const ok = src.send(removeMapMarkerIntent(m.entity)); note.textContent = ok ? "Marker removed." : "Could not remove marker (only the owner can remove it)."; src.status?.(note.textContent); });
      row.append(rm); list.append(row); } };
  el.append(canvas, controls, note, form, list);
  // Pointer: one finger/mouse drag pans; two fingers pinch-zoom (and pan together); a tap without drag opens the form.
  // (touch-action:none on the canvas keeps the browser from hijacking the pinch for page zoom.)
  const toCanvasPx = (clientX: number, clientY: number): { px: number; py: number } => { const r = canvas.getBoundingClientRect(); return { px: (clientX - r.left) * canvas.width / Math.max(1, r.width), py: (clientY - r.top) * canvas.height / Math.max(1, r.height) }; };
  const endPointer = (e: { pointerId: number; clientX: number; clientY: number }): void => {
    state.pointers.delete(e.pointerId);
    if (state.pointers.size < 2) state.pinch = null;
    if (state.pointers.size === 0) {
      const d = state.drag; state.drag = null;
      if (d && !state.pinched && Math.hypot(e.clientX - d.px, e.clientY - d.py) < 6) { const p = toCanvasPx(e.clientX, e.clientY); state.placed = canvasToWorld(p.px, p.py, canvas.width, canvas.height, state.centre, state.scale); showForm(); }
      state.pinched = false;
    } else if (state.pointers.size === 1) {
      // One finger left after a pinch: keep panning from where it is.
      const [rem] = [...state.pointers.values()] as [{ x: number; y: number }]; state.drag = { px: rem.x, py: rem.y, cx: state.centre.x, cy: state.centre.y };
    }
  };
  canvas.addEventListener("pointerdown", (e) => { try { canvas.setPointerCapture(e.pointerId); } catch { /* no capture (jsdom) */ } state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (state.pointers.size === 2) { const [a, b] = [...state.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }]; state.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; state.pinched = true; state.drag = null; }
    else if (state.pointers.size === 1) state.drag = { px: e.clientX, py: e.clientY, cx: state.centre.x, cy: state.centre.y }; });
  canvas.addEventListener("pointermove", (e) => { if (!state.pointers.has(e.pointerId)) return; state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (state.pinch && state.pointers.size === 2) { const [a, b] = [...state.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }]; const d = Math.hypot(a.x - b.x, a.y - b.y); const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const prev = toCanvasPx(state.pinch.mx, state.pinch.my), cur = toCanvasPx(mx, my);
      const step = pinchStep({ centre: state.centre, scale: state.scale, midPrevPx: prev.px, midPrevPy: prev.py, midPx: cur.px, midPy: cur.py, canvasW: canvas.width, canvasH: canvas.height, prevDist: state.pinch.d, curDist: d });
      state.centre = step.centre; state.scale = step.scale; state.pinch = { d, mx, my }; state.following = false; draw(); return; }
    if (!state.drag) return; const r = canvas.getBoundingClientRect(); const sx = canvas.width / Math.max(1, r.width), sy = canvas.height / Math.max(1, r.height);
    const d = northUpToWorld((e.clientX - state.drag.px) * sx / state.scale, (e.clientY - state.drag.py) * sy / state.scale);
    state.centre.x = state.drag.cx - d.x; state.centre.y = state.drag.cy - d.y; state.following = false; draw(); });
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); state.scale = Math.min(32, Math.max(2, state.scale * (e.deltaY < 0 ? 1.25 : 0.8))); draw(); }, { passive: false });
  // Task 26 smoothness: the map used to redraw every tile (~2700 fillRects) on every rAF while open, even
  // when the player stood still. Skip the canvas work when nothing it depends on changed (centre/scale,
  // player pos/facing/idle, visible markers, visible chunks' versions); the rAF loop stays so a moving
  // player, a new chunk, or a marker change still repaints promptly. lastSig starts empty: first draw runs.
  let lastSig = "";
  const draw = (): void => { const ctx = canvas.getContext("2d"); if (!ctx) return; const w = src.world(), p = src.player();
    const t = w && p !== undefined ? w.get(p, Transform) : undefined;
    if (t && state.following) state.centre = { x: t.x, y: t.y };
    const markers = w && p !== undefined ? visibleMarkers(w, p) : [];
    const idle = t ? mapIdle.isIdle(t, performance.now()) : true;
    const facing = t ? compassOf(t.facing) : undefined;
    const rose = t ? (idle ? idleCompass() : facing!) : undefined;
    const tiles = src.tiles();
    let tv = 0;
    if (tiles) {
      const s0 = state.scale, c0 = state.centre;
      const { x0: tx0, x1: tx1, y0: ty0, y1: ty1 } = mapWorldBounds(canvas.width, canvas.height, c0, s0);
      tv = (tiles as { chunkCount?: number }).chunkCount ?? 0;
      const getChunk = (tiles as { getChunk?: (cx: number, cy: number) => { version?: number } | undefined }).getChunk;
      if (getChunk) for (let cy = Math.floor(ty0 / 32); cy <= Math.floor(ty1 / 32); cy++) for (let cx = Math.floor(tx0 / 32); cx <= Math.floor(tx1 / 32); cx++) tv += getChunk.call(tiles, cx, cy)?.version ?? 0;
    }
    const sig = [state.centre.x.toFixed(2), state.centre.y.toFixed(2), state.scale, t ? t.x.toFixed(2) : "", t ? t.y.toFixed(2) : "", facing ? Math.round(facing.heading / 2) : "", idle, markers.map((m) => `${m.entity}:${m.label}:${m.visibility}`).join("|"), tv].join("|");
    rebuildList(markers);
    if (sig === lastSig) return;
    lastSig = sig;
    const W = canvas.width, H = canvas.height, s = state.scale, c = state.centre;
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = "#1b1f1a"; ctx.fillRect(0, 0, W, H);
    const { x0, x1, y0, y1 } = mapWorldBounds(W, H, c, s);
    // Rotate terrain geometry into the same basis used by markers, picking, pan and pinch.
    ctx.save(); ctx.translate(W / 2, H / 2);
    const gx = worldToNorthUp(s, 0), gy = worldToNorthUp(0, s), bleed = 0.5 / s;
    ctx.transform(gx.x, gx.y, gy.x, gy.y, 0, 0); ctx.translate(-c.x, -c.y);
    if (tiles) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const id = tiles.getTile(x, y); if (!id) continue;
      // Half a screen pixel of overdraw seals antialiased seams between rotated tiles.
      ctx.fillStyle = TILE_COLORS[id % TILE_COLORS.length]!; ctx.fillRect(x - bleed, y - bleed, 1 + 2 * bleed, 1 + 2 * bleed);
    }
    ctx.restore();
    // ADR-292: a fixed geographic grid makes the north-up axes unambiguous even when the
    // received chunk footprint has diagonal edges. Unknown terrain is never invented.
    ctx.strokeStyle = "rgba(255,250,240,.12)"; ctx.lineWidth = 1; ctx.beginPath();
    const origin = worldToCanvas(0, 0, W, H, c, s), spacing = 8 * s;
    for (let x = ((origin.px % spacing) + spacing) % spacing; x < W; x += spacing) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = ((origin.py % spacing) + spacing) % spacing; y < H; y += spacing) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    ctx.fillStyle = "rgba(27,31,26,.85)"; ctx.fillRect(8, 8, 100, 24);
    ctx.fillStyle = "#FFFAF0"; ctx.font = "bold 13px system-ui,sans-serif"; ctx.fillText("NORTH ↑", 16, 25);
    // Crosshair at the centre (the gamepad placement point).
    ctx.strokeStyle = "rgba(255,250,240,.8)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(W / 2 - 8, H / 2); ctx.lineTo(W / 2 + 8, H / 2); ctx.moveTo(W / 2, H / 2 - 8); ctx.lineTo(W / 2, H / 2 + 8); ctx.stroke();
    // Markers (small but visible pins).
    for (const m of markers) { const { px, py } = worldToCanvas(m.x, m.y, W, H, c, s); if (px < -20 || px > W + 20 || py < -20 || py > H + 20) continue;
      ctx.fillStyle = markerPinColor(m.visibility); ctx.beginPath(); ctx.arc(px, py - 4, 5, 0, Math.PI * 2); ctx.fill(); ctx.fillRect(px - 1, py - 4, 2, 8);
      ctx.font = "bold 11px system-ui,sans-serif"; ctx.strokeStyle = "rgba(0,0,0,.8)"; ctx.lineWidth = 3; ctx.strokeText(m.label || "Marker", px + 8, py); ctx.fillStyle = "#FFFAF0"; ctx.fillText(m.label || "Marker", px + 8, py); }
    // Player arrow (always the true facing) + compass rose (settles north when standing still, like the HUD compass).
    if (t && facing && rose) { const { px, py } = worldToCanvas(t.x, t.y, W, H, c, s); const { heading } = facing;
      ctx.save(); ctx.translate(px, py); ctx.rotate(heading * Math.PI / 180); ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(6, 8); ctx.lineTo(0, 4); ctx.lineTo(-6, 8); ctx.closePath(); ctx.fill(); ctx.restore();
      // Rose: fixed N/E/S/W, needle = facing, or north when idle.
      const rx = W - 34, ry = 34; ctx.save(); ctx.translate(rx, ry); ctx.fillStyle = "rgba(43,28,36,.85)"; ctx.beginPath(); ctx.arc(0, 0, 26, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#FFFAF0"; ctx.font = "bold 11px system-ui,sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("N", 0, -17); ctx.fillText("S", 0, 17); ctx.fillText("E", 17, 0); ctx.fillText("W", -17, 0);
      ctx.rotate(rose.heading * Math.PI / 180); ctx.fillStyle = "#ff6b5e"; ctx.beginPath(); ctx.moveTo(0, -14); ctx.lineTo(4, 0); ctx.lineTo(-4, 0); ctx.closePath(); ctx.fill(); ctx.restore(); }
  };
  let raf = 0; const loop = (): void => { if (!el.isConnected) return; draw(); raf = requestAnimationFrame(loop); }; raf = requestAnimationFrame(loop);
  draw();
  return { el, destroy: () => { cancelAnimationFrame(raf); } };
}
