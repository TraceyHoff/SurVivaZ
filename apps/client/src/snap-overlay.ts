/**
 * ADR-196: build-ghost validity outline + magnet snap-edge highlight, a pointer-events-none 2D canvas over the game
 * (WebGL2 and the Canvas2D/debug fallback alike, same CameraLike). The ghost footprint is outlined green (valid) or
 * red (invalid); the edge shared with the existing piece it snapped to is drawn thick in bright yellow.
 */
import { worldToScreen } from "@engine/world";
import type { BuildPreview, SnapSegment } from "@engine/gameplay";
import { camIso, type CameraLike } from "./world-tools.js";

export const SNAP_COLORS = { valid: "rgba(80,255,120,.95)", invalid: "rgba(255,70,70,.95)", edge: "rgba(255,230,60,1)", target: "rgba(255,196,48,.98)" } as const;
export interface OverlayLine { x0: number; y0: number; x1: number; y1: number; color: string; width: number }
/** Pure: CSS-px lines for a preview (outline first, snap edge last so it sits on top). */
export function snapOverlayLines(p: BuildPreview | undefined, cam: CameraLike, groundZ?: number): OverlayLine[] {
  if (!p?.outline?.length) return [];
  const z = cam.drawZoom, hw = cam.viewW / cam.dpr / 2, hh = cam.viewH / cam.dpr / 2;
  const iso = camIso(cam); const css = (x: number, y: number) => { const s = worldToScreen(x, y, groundZ ?? p.z, iso); return { x: (s.sx - cam.x) * z + hw, y: (s.sy - cam.y) * z + hh }; };
  const seg = (s: SnapSegment, color: string, width: number): OverlayLine => { const a = css(s.x0, s.y0), b = css(s.x1, s.y1); return { x0: a.x, y0: a.y, x1: b.x, y1: b.y, color, width }; };
  const col = p.valid ? SNAP_COLORS.valid : SNAP_COLORS.invalid;
  const out = p.outline.map((s) => seg(s, col, 2));
  if (p.snapEdge && p.valid) out.push(seg(p.snapEdge, SNAP_COLORS.edge, 5));
  return out;
}
/** Amber footprint of the aimed placed piece (demolish / repair / upgrade target). Uses that piece's own z. */
export function targetOverlayLines(t: { segments: SnapSegment[]; z: number } | undefined, cam: CameraLike): OverlayLine[] {
  if (!t?.segments.length) return [];
  const z = cam.drawZoom, hw = cam.viewW / cam.dpr / 2, hh = cam.viewH / cam.dpr / 2;
  const iso = camIso(cam); const css = (x: number, y: number) => { const s = worldToScreen(x, y, t.z, iso); return { x: (s.sx - cam.x) * z + hw, y: (s.sy - cam.y) * z + hh }; };
  return t.segments.map((s) => { const a = css(s.x0, s.y0), b = css(s.x1, s.y1); return { x0: a.x, y0: a.y, x1: b.x, y1: b.y, color: SNAP_COLORS.target, width: 4 }; });
}
export interface SnapOverlayDeps { preview(): BuildPreview | undefined; target?(): { segments: SnapSegment[]; z: number } | undefined; camera(): CameraLike | undefined; hidden(): boolean; groundZ?(): number | undefined }
export function mountSnapOverlay(root: HTMLElement, d: SnapOverlayDeps): { destroy(): void } {
  const cv = document.createElement("canvas"); cv.id = "snap-overlay"; cv.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:3"; root.append(cv);
  let raf = 0, drew = false, sig = "", lineSig = "", redraws = 0;
  const tick = (): void => {
    raf = requestAnimationFrame(tick);
    try {
      const cam = d.camera(); const p = d.preview();
      const lines = !cam || d.hidden() ? [] : [...snapOverlayLines(p, cam, d.groundZ?.()), ...targetOverlayLines(d.target?.(), cam)];
      const s = p ? `${lines.length}:${p.valid ? 1 : 0}:${p.magnet ? 1 : 0}:${p.snapEdge ? 1 : 0}` : ""; if (s !== sig) { sig = s; cv.dataset["state"] = s; }
      if (!lines.length && !drew) return;
      // ADR-228: a still ghost under a still camera draws identical lines; skip the full-canvas clear + blurred strokes
      let ls = `${root.clientWidth}x${root.clientHeight}`; for (const l of lines) ls += `|${l.x0.toFixed(1)},${l.y0.toFixed(1)},${l.x1.toFixed(1)},${l.y1.toFixed(1)},${l.color},${l.width}`;
      if (ls === lineSig) return; lineSig = ls; redraws++; cv.dataset["redraws"] = String(redraws);
      const dpr = Math.min(3, globalThis.devicePixelRatio || 1); const W = root.clientWidth || innerWidth, H = root.clientHeight || innerHeight;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = `${W}px`; cv.style.height = `${H}px`; }
      const g = cv.getContext("2d"); if (!g) return; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H); drew = lines.length > 0;
      g.lineCap = "round";
      for (const l of lines) { g.strokeStyle = l.color; g.lineWidth = l.width; g.shadowColor = "rgba(0,0,0,.6)"; g.shadowBlur = l.width > 2 ? 6 : 2; g.beginPath(); g.moveTo(l.x0, l.y0); g.lineTo(l.x1, l.y1); g.stroke(); }
    } catch { /* replica mid-swap */ }
  };
  raf = requestAnimationFrame(tick);
  return { destroy: () => { cancelAnimationFrame(raf); cv.remove(); } };
}
