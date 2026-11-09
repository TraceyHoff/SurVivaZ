/**
 * ADR-315: Claim Flag area overlay. A pointer-events-none 2D canvas (WebGL2 and Canvas2D alike, same CameraLike as the
 * ADR-196 snap overlay) that draws claim borders on the ground:
 *  - build mode with a Claim Flag hologram: the claim it would make at the ghost (green; red when it would overlap a
 *    claim — that claim's border turns red too), plus the borders of nearby claims: own / clan in cyan, foreign in amber;
 *  - a placed flag's border while this player has toggled it on (Use / hand on the flag; client-local view state);
 *  - a short fade-out of a flag's border right after this player places it (CLAIM_FLASH_MS), then off by default.
 * Readable on any ground: a dark halo under a bright stroke, a faint fill, and each rim point lifted to the terrain
 * height under it. Nothing is drawn otherwise, so the HUD stays clean.
 */
import { Transform, type Entity, type World } from "@engine/core";
import { BuildFail, PrivilegeZone, zoneOwnedBy, zonesAt, type BuildPreview } from "@engine/gameplay";
import { worldToScreen } from "@engine/world";
import { camIso, type CameraLike } from "./world-tools.js";

export const CLAIM_COLORS = { ghost: "#7CFF8A", invalid: "#FF4A4A", own: "#5BD2FF", foreign: "#FFAA3C", halo: "rgba(12,10,8,.72)" } as const;
/** How long (ms) a just-placed flag shows its border before fading out (the default for placed flags is off). */
export const CLAIM_FLASH_MS = 6000;
/** Neighbour claims drawn around a flag hologram: any whose rim comes within this many tiles of the ghost's rim. */
export const CLAIM_NEIGHBOUR_PAD = 24;
export const CLAIM_RING_SEGMENTS = 72;

export type ClaimRingKind = "ghost" | "invalid" | "own" | "foreign";
export interface ClaimRing { x: number; y: number; r: number; kind: ClaimRingKind; color: string; alpha: number; zone?: Entity }

/** Client-local, per-player claim border view state (never replicated, never sent). */
export class ClaimView {
  readonly shown = new Set<Entity>();
  flash: { x: number; y: number; r: number; at: number } | undefined;
  /** Use / hand on a flag: flip its border; returns the new state. */
  toggle(flag: Entity): boolean { if (this.shown.delete(flag)) return false; this.shown.add(flag); return true; }
  isShown(flag: Entity): boolean { return this.shown.has(flag); }
  /** This player just placed a flag at (x, y): show its border briefly. */
  placed(x: number, y: number, r: number, now: number): void { this.flash = { x, y, r, at: now }; }
  /** Drop flags that no longer exist (destroyed / out of the replica). */
  prune(world: World): void { for (const e of this.shown) if (!world.isAlive(e) || !world.has(e, PrivilegeZone)) this.shown.delete(e); }
}

const ringOf = (world: World, player: Entity | undefined, z: Entity, overlap?: Entity): ClaimRing | undefined => {
  const t = world.get(z, Transform); const r = world.getField(z, PrivilegeZone, "radius"); if (!t || !r) return undefined;
  const kind: ClaimRingKind = z === overlap ? "invalid" : player !== undefined && zoneOwnedBy(world, z, player) ? "own" : "foreign";
  return { x: t.x, y: t.y, r, kind, color: CLAIM_COLORS[kind], alpha: 1, zone: z };
};

/** Pure: the claim rings to draw this frame. */
export function claimRings(world: World, player: Entity | undefined, view: ClaimView, preview: BuildPreview | undefined, now: number): ClaimRing[] {
  const out: ClaimRing[] = []; const seen = new Set<Entity>();
  if (!world.isRegistered(PrivilegeZone)) return out;
  view.prune(world);
  const pc = preview?.claim;
  if (preview && pc) {
    const overlap = preview.reason === BuildFail.ClaimOverlap;
    for (const z of zonesAt(world, preview.x, preview.y, pc.radius + CLAIM_NEIGHBOUR_PAD)) { const r = ringOf(world, player, z, pc.overlap); if (r) { out.push(r); seen.add(z); } }
    out.push({ x: preview.x, y: preview.y, r: pc.radius, kind: overlap || !preview.valid ? "invalid" : "ghost", color: overlap || !preview.valid ? CLAIM_COLORS.invalid : CLAIM_COLORS.ghost, alpha: overlap || preview.valid ? 1 : 0.6 });
  }
  for (const z of view.shown) { if (seen.has(z)) continue; const r = ringOf(world, player, z); if (r) { out.push(r); seen.add(z); } }
  const f = view.flash;
  if (f) {
    const age = now - f.at; if (age >= CLAIM_FLASH_MS || age < 0) view.flash = undefined;
    else if (!pc) out.push({ x: f.x, y: f.y, r: f.r, kind: "own", color: CLAIM_COLORS.own, alpha: Math.min(1, (CLAIM_FLASH_MS - age) / 1500) });
  }
  return out;
}

/** Pure: a ring's rim as CSS-px points, each lifted to the ground height under it (`ground(x, y)`, terrain z). */
export function ringPoints(ring: ClaimRing, cam: CameraLike, ground?: (x: number, y: number) => number, n = CLAIM_RING_SEGMENTS): { x: number; y: number }[] {
  const z = cam.drawZoom, hw = cam.viewW / cam.dpr / 2, hh = cam.viewH / cam.dpr / 2; const iso = camIso(cam); const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2; const wx = ring.x + Math.cos(a) * ring.r, wy = ring.y + Math.sin(a) * ring.r;
    const s = worldToScreen(wx, wy, ground?.(wx, wy) ?? 0, iso); pts.push({ x: (s.sx - cam.x) * z + hw, y: (s.sy - cam.y) * z + hh });
  }
  return pts;
}

export interface ClaimOverlayDeps {
  world(): World; player(): Entity | undefined; view: ClaimView; preview(): BuildPreview | undefined;
  camera(): CameraLike | undefined; hidden(): boolean; ground?(x: number, y: number): number;
}
export function mountClaimOverlay(root: HTMLElement, d: ClaimOverlayDeps): { destroy(): void } {
  const cv = document.createElement("canvas"); cv.id = "claim-overlay"; cv.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:2"; root.append(cv);
  let raf = 0, drew = false, sig = "";
  const tick = (now: number): void => {
    raf = requestAnimationFrame(tick);
    try {
      const cam = d.camera(); const rings = !cam || d.hidden() ? [] : claimRings(d.world(), d.player(), d.view, d.preview(), now);
      cv.dataset["rings"] = rings.map((r) => r.kind).join(",");
      if (!rings.length && !drew) return;
      const polys = cam ? rings.map((r) => ({ r, pts: ringPoints(r, cam, d.ground) })) : [];
      // a still camera with still rings draws the same pixels: skip the clear + strokes (like the ADR-228 snap overlay)
      let s = `${root.clientWidth}x${root.clientHeight}`; for (const p of polys) s += `|${p.r.kind}${p.r.alpha.toFixed(2)}:${p.pts[0]!.x.toFixed(1)},${p.pts[0]!.y.toFixed(1)},${p.pts[18]!.x.toFixed(1)},${p.pts[18]!.y.toFixed(1)}`;
      if (s === sig) return; sig = s;
      const dpr = Math.min(3, globalThis.devicePixelRatio || 1); const W = root.clientWidth || innerWidth, H = root.clientHeight || innerHeight;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = `${W}px`; cv.style.height = `${H}px`; }
      const g = cv.getContext("2d"); if (!g) return; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H); drew = polys.length > 0;
      g.lineJoin = "round";
      for (const { r, pts } of polys) {
        g.globalAlpha = r.alpha; g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath();
        g.fillStyle = r.color; g.globalAlpha = r.alpha * (r.kind === "ghost" || r.kind === "invalid" ? 0.1 : 0.05); g.fill();
        g.globalAlpha = r.alpha; g.setLineDash(r.kind === "foreign" ? [10, 6] : []); g.strokeStyle = CLAIM_COLORS.halo; g.lineWidth = 5.5; g.stroke();
        g.strokeStyle = r.color; g.lineWidth = r.kind === "ghost" || r.kind === "invalid" ? 3 : 2.25; g.stroke();
      }
      g.setLineDash([]); g.globalAlpha = 1;
    } catch { /* replica mid-swap */ }
  };
  raf = requestAnimationFrame(tick);
  return { destroy: () => { cancelAnimationFrame(raf); cv.remove(); } };
}
