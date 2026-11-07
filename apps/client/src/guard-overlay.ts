/** ADR-291: a world-space guard cue, including v1 dolls which have no dedicated block frames.
 * This is combat UI, not a substitute action sprite. Read authoritative Stance, never the raw button:
 * exhausted/ranged/carrying/dead characters must not advertise protection they don't have. */
import { PrevTransform, Transform, lerp, type Entity, type World } from "@engine/core";
import { Dead, STANCE, Stance, StanceMode } from "@engine/gameplay";
import { worldToScreen } from "@engine/world";
import { camIso, type CameraLike } from "./world-tools.js";

type Point = { x: number; y: number };
export interface GuardCue { e: Entity; x: number; y: number; arc: Point[] }
type Ground = (x: number, y: number, z: number) => number;
/** Pure projection shared by WebGL and Canvas2D; arc matches the actual 150° frontal defence. */
export function guardCues(w: World, cam: CameraLike, alpha = 1, ground: Ground = (_x, _y, z) => z): GuardCue[] {
  if (!w.isRegistered(Stance)) return [];
  const out: GuardCue[] = [], zoom = cam.drawZoom, W = cam.viewW / cam.dpr, H = cam.viewH / cam.dpr;
  const project = (x: number, y: number, z: number): Point => {
    const p = worldToScreen(x, y, z, camIso(cam));
    return { x: (p.sx - cam.x) * zoom + W / 2, y: (p.sy - cam.y) * zoom + H / 2 };
  };
  for (const e of w.query([Stance, Transform])) {
    if (w.getField(e, Stance, "mode") !== StanceMode.Block || (w.isRegistered(Dead) && w.has(e, Dead))) continue;
    const t = w.get(e, Transform)!, prev = w.get(e, PrevTransform) ?? t;
    const x = lerp(prev.x, t.x, alpha), y = lerp(prev.y, t.y, alpha), z = ground(x, y, t.z ?? 0);
    const p = project(x, y, z);
    if (p.x < -80 || p.x > W + 80 || p.y < -80 || p.y > H + 100) continue;
    const half = STANCE.blockArcDeg * Math.PI / 360;
    const arc = Array.from({ length: 17 }, (_, i) => {
      const a = (t.facing ?? 0) - half + i * half / 8;
      return project(x + Math.cos(a) * 0.65, y + Math.sin(a) * 0.65, z + 0.05);
    });
    out.push({ e, x: p.x, y: p.y - Math.max(48, 66 * zoom), arc });
  }
  return out;
}
export interface GuardOverlayDeps {
  world(): World; camera(): CameraLike | undefined; hidden(): boolean; alpha(): number; ground?: Ground;
}
export function mountGuardOverlay(root: HTMLElement, d: GuardOverlayDeps): { destroy(): void } {
  const cv = document.createElement("canvas"); cv.id = "guard-overlay";
  cv.setAttribute("aria-hidden", "true"); cv.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:4"; root.append(cv);
  let raf = 0, drewLast = false, count = -1;
  const tick = (): void => {
    raf = requestAnimationFrame(tick);
    const cam = d.camera(); const cues = !cam || d.hidden() ? [] : guardCues(d.world(), cam, d.alpha(), d.ground);
    if (count !== cues.length) { count = cues.length; cv.dataset["count"] = String(count); }
    if (!cues.length && !drewLast) return;
    const dpr = Math.min(3, devicePixelRatio || 1), W = root.clientWidth || innerWidth, H = root.clientHeight || innerHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    }
    const g = cv.getContext("2d"); if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H); drewLast = cues.length > 0;
    g.lineJoin = "round"; g.lineCap = "round"; g.font = "bold 12px system-ui,sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    for (const q of cues) {
      g.beginPath(); q.arc.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y));
      g.strokeStyle = "#14262e"; g.lineWidth = 7; g.stroke(); g.strokeStyle = "#8cecff"; g.lineWidth = 3; g.stroke();
      g.fillStyle = "#14262e"; g.beginPath(); g.roundRect(q.x - 30, q.y - 10, 60, 20, 5); g.fill();
      g.strokeStyle = "#8cecff"; g.lineWidth = 1.5; g.stroke(); g.fillStyle = "#c6f7ff"; g.fillText("GUARD", q.x, q.y);
    }
  };
  raf = requestAnimationFrame(tick);
  return { destroy: () => { cancelAnimationFrame(raf); cv.remove(); } };
}
