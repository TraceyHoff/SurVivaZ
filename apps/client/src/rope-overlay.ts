/**
 * ADR-351: visible rope between a holder and the animal they lead. A pointer-events-none 2D canvas (WebGL2
 * and Canvas2D alike, same CameraLike as the ADR-315 claim overlay) that draws one sagging procedural line
 * per live lead: a dark halo under a tan rope stroke, with a knot dot at each end (holder's hand, animal's
 * neck). The line is drawn from the replicated RopeLead component (holder PlayerId -> holder entity), so
 * player-led and AI-human-led animals both show it to every peer, with no sprite and no extra network
 * traffic. Nothing is drawn when there is no lead, so the HUD stays clean.
 */
import { PlayerId, Transform, type Entity, type World } from "@engine/core";
import { RopeLead } from "@engine/gameplay";
import { worldToScreen } from "@engine/world";
import { camIso, type CameraLike } from "./world-tools.js";

export const ROPE_COLORS = { rope: "#D8B06A", halo: "rgba(12,10,8,.72)", knot: "#8A6A3B" } as const;
/** How far (screen px) the rope sags below the straight holder->animal line at its midpoint. */
export const ROPE_SAG_PX = 8;

export interface RopeSegment { hx: number; hy: number; hz: number; ax: number; ay: number; az: number; holder: Entity; animal: Entity }
/** Live entity of a PlayerId, undefined when offline / dead (replica read; mirrors gameplay.holderEntity). */
export const holderEntityOf = (world: World, id: number): Entity | undefined => {
  if (!id || !world.isRegistered(PlayerId)) return undefined;
  for (const e of world.query([PlayerId, Transform])) if (world.getField(e, PlayerId, "id") === id) return e;
  return undefined;
};
/** Pure: the rope segments to draw this frame (one per led animal whose holder is in the replica). */
export function ropeSegments(world: World): RopeSegment[] {
  const out: RopeSegment[] = [];
  if (!world.isRegistered(RopeLead)) return out;
  for (const e of world.query([RopeLead, Transform])) {
    const holder = holderEntityOf(world, world.getField(e, RopeLead, "holder") ?? 0);
    if (holder === undefined) continue;
    const ht = world.get(holder, Transform), at = world.get(e, Transform);
    if (!ht || !at) continue;
    out.push({ hx: ht.x, hy: ht.y, hz: ht.z ?? 0, ax: at.x, ay: at.y, az: at.z ?? 0, holder, animal: e });
  }
  return out.sort((a, b) => a.animal - b.animal);
}

export interface RopePoints { hx: number; hy: number; ax: number; ay: number; cx: number; cy: number }
/** Pure: a segment's screen points — holder hand, animal neck, and the sagging midpoint (quadratic control). */
export function ropePoints(seg: RopeSegment, cam: CameraLike, ground?: (x: number, y: number) => number): RopePoints {
  const z = cam.drawZoom, hw = cam.viewW / cam.dpr / 2, hh = cam.viewH / cam.dpr / 2; const iso = camIso(cam);
  const proj = (wx: number, wy: number, wz: number): { x: number; y: number } => {
    const s = worldToScreen(wx, wy, (ground?.(wx, wy) ?? 0) + wz, iso); return { x: (s.sx - cam.x) * z + hw, y: (s.sy - cam.y) * z + hh };
  };
  const h = proj(seg.hx, seg.hy, seg.hz), a = proj(seg.ax, seg.ay, seg.az);
  // the hand holds the rope a little above the ground, the neck a little less; the midpoint sags below
  // the chord between the *lifted* endpoints (sag from the ground-projected points would hang 12px too low)
  const hy = h.y - 14 * z, ay = a.y - 10 * z;
  return { hx: h.x, hy, ax: a.x, ay, cx: (h.x + a.x) / 2, cy: (hy + ay) / 2 + ROPE_SAG_PX };
}

export interface RopeOverlayDeps {
  world(): World; camera(): CameraLike | undefined; hidden(): boolean; ground?(x: number, y: number): number;
}
export function mountRopeOverlay(root: HTMLElement, d: RopeOverlayDeps): { destroy(): void } {
  const cv = document.createElement("canvas"); cv.id = "rope-overlay"; cv.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:2"; root.append(cv);
  let raf = 0, drew = false, sig = "";
  const tick = (): void => {
    raf = requestAnimationFrame(tick);
    try {
      const cam = d.camera(); const segs = !cam || d.hidden() ? [] : ropeSegments(d.world());
      cv.dataset["leads"] = String(segs.length);
      if (!segs.length && !drew) return;
      const pts = cam ? segs.map((s) => ropePoints(s, cam, d.ground)) : [];
      // a still camera with still ropes draws the same pixels: skip the clear + strokes (ADR-228 pattern)
      let s = `${root.clientWidth}x${root.clientHeight}`; for (const p of pts) s += `|${p.hx.toFixed(1)},${p.hy.toFixed(1)},${p.ax.toFixed(1)},${p.ay.toFixed(1)}`;
      if (s === sig) return; sig = s;
      const dpr = Math.min(3, globalThis.devicePixelRatio || 1); const W = root.clientWidth || innerWidth, H = root.clientHeight || innerHeight;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = `${W}px`; cv.style.height = `${H}px`; }
      const g = cv.getContext("2d"); if (!g) return; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H); drew = pts.length > 0;
      g.lineJoin = "round"; g.lineCap = "round";
      for (const p of pts) {
        g.beginPath(); g.moveTo(p.hx, p.hy); g.quadraticCurveTo(p.cx, p.cy, p.ax, p.ay);
        g.strokeStyle = ROPE_COLORS.halo; g.lineWidth = 5; g.stroke();
        g.strokeStyle = ROPE_COLORS.rope; g.lineWidth = 2; g.stroke();
        g.fillStyle = ROPE_COLORS.knot;
        g.beginPath(); g.arc(p.hx, p.hy, 2.5, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.arc(p.ax, p.ay, 2.5, 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 1;
    } catch { /* replica mid-swap */ }
  };
  raf = requestAnimationFrame(tick);
  return { destroy: () => { cancelAnimationFrame(raf); cv.remove(); } };
}
