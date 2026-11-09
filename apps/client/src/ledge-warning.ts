/** ADR-306: a downward drop arrow on camera-hidden ledges, colored by fall damage vs current HP. ADR-313: looks ahead along the travel heading (speed x 2 s) so a sprinting player sees the ledge in time to stop. */
import { DEFAULT_TICK_HZ, PrevTransform, Transform, lerp, type Entity, type World } from "@engine/core";
import { Dead, Health, StructureIndexRes, TerrainRes, ladderBetween, shaftAwareHeight, terrainFallDamage } from "@engine/gameplay";
import { fromView, viewQuarter, worldToScreen } from "@engine/world";
import { camIso, type CameraLike } from "./world-tools.js";

export const LEDGE_COLORS = { safe: "#3DCC6A", hurt: "#F0C040", lethal: "#E23B3B" } as const;
export type LedgeRisk = keyof typeof LEDGE_COLORS;

/** Camera-hidden cardinal steps (view -u and -v, ADR-276 rear edges) in world tiles. */
export function hiddenDropDirs(viewQ: number): readonly { dx: number; dy: number }[] {
  const q = viewQuarter(viewQ);
  return [fromView(-1, 0, q), fromView(0, -1, q)].map((p) => ({ dx: Math.round(p.x), dy: Math.round(p.y) }));
}

/** Green = no fall damage, yellow = damage but survive, red = the fall would kill at `hp`. */
export function classifyLedgeRisk(dropTiles: number, hp: number, guarded = false): { damage: number; risk: LedgeRisk } {
  const damage = guarded ? 0 : terrainFallDamage(dropTiles);
  if (damage <= 0) return { damage: 0, risk: "safe" };
  if (damage >= Math.max(1, hp)) return { damage, risk: "lethal" };
  return { damage, risk: "hurt" };
}

export interface LedgeHint {
  drop: number; damage: number; risk: LedgeRisk;
  x: number; y: number; dx: number; dy: number;
  /** ADR-313: tiles from the player to the rim along the travel heading (0 = standing on the rim). */
  dist?: number;
}

/** ADR-313: seconds of travel the warning looks ahead (sprint 4.64 t/s -> ~10 tiles, walk 2.9 t/s -> ~7 tiles). */
export const LEDGE_LOOKAHEAD_S = 2;
/** ADR-313: lookahead floor (idle / slow) and ceiling (vehicles are hidden anyway), in tiles. */
export const LEDGE_MIN_RANGE = 3, LEDGE_MAX_RANGE = 14;
/** ADR-313: at most this many ledges are drawn (nearest first) so a cliff line does not clutter the screen. */
export const LEDGE_MAX_HINTS = 3;
/** ADR-313: rim hints on the same hidden side closer than this (tiles) merge into the nearest. */
export const LEDGE_MERGE = 3.5;
/** ADR-313: side rays either side of the heading (radians) so a ledge slightly off the path still shows. */
export const LEDGE_SIDE_RAY = 0.35;
/** ADR-313: lookahead distance in tiles for a travel speed in tiles/s: speed x 2 s + 1 tile, clamped to [3, 14]. */
export function ledgeLookahead(speed: number): number {
  const s = Number.isFinite(speed) ? Math.max(0, speed) : 0;
  return Math.min(LEDGE_MAX_RANGE, Math.max(LEDGE_MIN_RANGE, s * LEDGE_LOOKAHEAD_S + 1));
}
/** ADR-313: arrow opacity by distance: full within 1.5 tiles, fading to 0.35 at the edge of the lookahead. */
export function ledgeAlpha(dist: number, range: number): number {
  if (!(dist > 1.5)) return 1;
  return Math.max(0.35, Math.min(1, 1 - 0.65 * ((dist - 1.5) / Math.max(0.5, range - 1.5))));
}

export function pickLedgeHint(o: {
  x: number; y: number; viewQ: number; hp: number;
  heightAt: (tx: number, ty: number) => number;
  facing?: number;
  ladderBetween?: (tx: number, ty: number, nx: number, ny: number) => boolean;
  near?: number;
}): LedgeHint | undefined {
  const near = o.near ?? 0.55, tx = Math.floor(o.x), ty = Math.floor(o.y), fx = o.x - tx, fy = o.y - ty;
  const h0 = o.heightAt(tx, ty);
  let best: LedgeHint | undefined, bestScore = -Infinity;
  for (const { dx, dy } of hiddenDropDirs(o.viewQ)) {
    const raw = h0 - o.heightAt(tx + dx, ty + dy); if (raw < 1 - 1e-6) continue;
    const drop = Math.max(1, Math.round(raw));
    const onRim = (dx < 0 && fx <= near) || (dx > 0 && fx >= 1 - near) || (dy < 0 && fy <= near) || (dy > 0 && fy >= 1 - near);
    const toward = o.facing !== undefined && Math.cos(o.facing) * dx + Math.sin(o.facing) * dy > 0.25;
    if (!onRim && !toward) continue;
    const { damage, risk } = classifyLedgeRisk(drop, o.hp, o.ladderBetween?.(tx, ty, tx + dx, ty + dy) ?? false);
    const align = o.facing !== undefined ? Math.cos(o.facing) * dx + Math.sin(o.facing) * dy : 0;
    const score = drop + (toward ? 0.5 : 0) + align;
    const dist = Math.max(0, dx < 0 ? fx : dx > 0 ? 1 - fx : dy < 0 ? fy : 1 - fy);
    if (score > bestScore) { bestScore = score; best = { drop, damage, risk, dx, dy, x: tx + 0.5 + dx * 0.42, y: ty + 0.5 + dy * 0.42, dist }; }
  }
  return best;
}

/**
 * ADR-313: hidden ledges ahead along the travel heading. The ADR-306 rim check (the tile the player stands on) plus
 * three rays (heading and +-LEDGE_SIDE_RAY) marched tile by tile up to `range` tiles: each ray stops at the first drop
 * of 1+ tiles (hidden-side drops become hints; visible drops just end the ray) or at a climb of more than 1 tile.
 * Rims on the same side within LEDGE_MERGE tiles merge; nearest first, at most LEDGE_MAX_HINTS.
 */
export function pickLedgeHints(o: {
  x: number; y: number; viewQ: number; hp: number;
  heightAt: (tx: number, ty: number) => number;
  facing?: number; heading?: number; range?: number;
  ladderBetween?: (tx: number, ty: number, nx: number, ny: number) => boolean;
  near?: number; max?: number;
}): LedgeHint[] {
  const cache = new Map<number, number>();
  const H = (tx: number, ty: number): number => { const k = (tx + 32768) * 65536 + (ty + 32768); let v = cache.get(k); if (v === undefined) cache.set(k, (v = o.heightAt(tx, ty))); return v; };
  // One arrow per stretch of rim: hints on the same hidden side within LEDGE_MERGE tiles of each other collapse
  // into the nearest one, so a straight cliff line shows one arrow, not three.
  const out: LedgeHint[] = [];
  const add = (h: LedgeHint): void => {
    const i = out.findIndex((q) => q.dx === h.dx && q.dy === h.dy && Math.hypot(q.x - h.x, q.y - h.y) <= LEDGE_MERGE);
    if (i < 0) out.push(h); else if ((h.dist ?? 0) < (out[i]!.dist ?? 0)) out[i] = h;
  };
  const rim = pickLedgeHint({ ...o, heightAt: H });
  if (rim) add(rim);
  const heading = o.heading ?? o.facing;
  const range = o.range ?? LEDGE_MIN_RANGE;
  if (heading !== undefined && range > 0) {
    const hidden = hiddenDropDirs(o.viewQ);
    const isHidden = (dx: number, dy: number): boolean => hidden.some((d) => d.dx === dx && d.dy === dy);
    for (const a of [heading, heading - LEDGE_SIDE_RAY, heading + LEDGE_SIDE_RAY]) {
      const ux = Math.cos(a), uy = Math.sin(a);
      let cx = Math.floor(o.x), cy = Math.floor(o.y), hc = H(cx, cy);
      // Grid walk (Amanatides-Woo): the distance to the next x / y tile boundary along the ray.
      const sx = ux > 1e-9 ? 1 : ux < -1e-9 ? -1 : 0, sy = uy > 1e-9 ? 1 : uy < -1e-9 ? -1 : 0;
      let tX = sx > 0 ? (cx + 1 - o.x) / ux : sx < 0 ? (o.x - cx) / -ux : Infinity;
      let tY = sy > 0 ? (cy + 1 - o.y) / uy : sy < 0 ? (o.y - cy) / -uy : Infinity;
      const dX = sx !== 0 ? 1 / Math.abs(ux) : Infinity, dY = sy !== 0 ? 1 / Math.abs(uy) : Infinity;
      for (let n = 0; n < 64; n++) {
        const stepX = tX <= tY; const t = stepX ? tX : tY; if (t > range) break;
        const dx = stepX ? sx : 0, dy = stepX ? 0 : sy; const nx = cx + dx, ny = cy + dy;
        const hn = H(nx, ny); const raw = hc - hn;
        if (raw >= 1 - 1e-6) {
          if (isHidden(dx, dy)) {
            const drop = Math.max(1, Math.round(raw));
            const { damage, risk } = classifyLedgeRisk(drop, o.hp, o.ladderBetween?.(cx, cy, nx, ny) ?? false);
            add({ drop, damage, risk, dx, dy, x: cx + 0.5 + dx * 0.42, y: cy + 0.5 + dy * 0.42, dist: t });
          }
          break; // the player falls here: nothing past this rim matters on this ray
        }
        if (-raw > 1 + 1e-6) break; // a cliff face blocks the path
        cx = nx; cy = ny; hc = hn;
        if (stepX) tX += dX; else tY += dY;
      }
    }
  }
  return out.sort((a, b) => (a.dist ?? 0) - (b.dist ?? 0)).slice(0, o.max ?? LEDGE_MAX_HINTS);
}

type Ground = (x: number, y: number, z: number) => number;
export interface LedgeDraw extends LedgeHint { sx: number; sy: number; alpha: number }

/** ADR-313: the player's measured travel (tiles/s and world heading), tracked by the overlay from frame to frame. */
export interface LedgeMotion { speed: number; heading?: number }

/** ADR-313: every hidden ledge to draw (nearest first), with screen positions and distance fade. */
export function ledgeDraws(w: World, player: Entity | undefined, cam: CameraLike, alpha = 1, ground: Ground = (_x, _y, z) => z, motion?: LedgeMotion): LedgeDraw[] {
  if (player === undefined || !w.isAlive(player) || (w.isRegistered(Dead) && w.has(player, Dead))) return [];
  const t = w.get(player, Transform); if (!t) return [];
  const prev = w.get(player, PrevTransform) ?? t;
  const x = lerp(prev.x, t.x, alpha), y = lerp(prev.y, t.y, alpha);
  const terrain = w.getResource(TerrainRes); if (!terrain) return [];
  const idx = w.getResource(StructureIndexRes);
  // Travel: the overlay's frame-to-frame measurement when given, else the last tick step (PrevTransform -> Transform).
  const vx = t.x - prev.x, vy = t.y - prev.y, step = Math.hypot(vx, vy);
  const tickSpeed = step < 0.5 ? step * DEFAULT_TICK_HZ : 0; // a teleport / respawn is not travel
  const speed = Math.max(motion?.speed ?? 0, tickSpeed);
  const heading = motion?.heading ?? (tickSpeed > 0.3 ? Math.atan2(vy, vx) : undefined) ?? t.facing ?? 0;
  const range = ledgeLookahead(speed);
  const hints = pickLedgeHints({
    x, y, viewQ: camIso(cam).view ?? 0, facing: t.facing ?? 0, heading, range,
    hp: w.getField(player, Health, "hp") ?? 100,
    heightAt: (tx, ty) => shaftAwareHeight(w, terrain, tx, ty, player),
    ladderBetween: (ax, ay, bx, by) => ladderBetween(idx, ax, ay, bx, by),
  });
  if (!hints.length) return [];
  const zoom = cam.drawZoom, W = cam.viewW / cam.dpr, Hh = cam.viewH / cam.dpr, iso = camIso(cam);
  return hints.map((hint) => {
    const z = ground(hint.x, hint.y, t.z ?? 0);
    const p = worldToScreen(hint.x, hint.y, z, iso);
    return { ...hint, sx: (p.sx - cam.x) * zoom + W / 2, sy: (p.sy - cam.y) * zoom + Hh / 2, alpha: ledgeAlpha(hint.dist ?? 0, range) };
  });
}
/** The nearest hidden ledge to draw (ADR-306 API; ADR-313 looks ahead along the heading). */
export function ledgeDraw(w: World, player: Entity | undefined, cam: CameraLike, alpha = 1, ground: Ground = (_x, _y, z) => z, motion?: LedgeMotion): LedgeDraw | undefined {
  return ledgeDraws(w, player, cam, alpha, ground, motion)[0];
}

/**
 * ADR-313: smoothed travel speed and heading from the player's Transform between frames (EMA, ~0.15 s), so the
 * lookahead scales with walk (2.9 t/s) vs sprint (4.64 t/s) whatever the replication cadence.
 */
export class LedgeMotionTracker {
  private x = NaN; private y = NaN; private t = 0; private speed = 0; private heading: number | undefined;
  reset(): void { this.x = NaN; this.speed = 0; this.heading = undefined; }
  sample(w: World, player: Entity | undefined, nowMs: number): LedgeMotion {
    const tf = player !== undefined && w.isAlive(player) ? w.get(player, Transform) : undefined;
    if (!tf) { this.reset(); return { speed: 0 }; }
    const dtS = (nowMs - this.t) / 1000;
    if (Number.isNaN(this.x) || !(dtS > 0) || dtS > 0.5) { this.x = tf.x; this.y = tf.y; this.t = nowMs; return { speed: this.speed, ...(this.heading !== undefined && { heading: this.heading }) }; }
    const dx = tf.x - this.x, dy = tf.y - this.y, dist = Math.hypot(dx, dy);
    if (dist > 3) { this.reset(); this.x = tf.x; this.y = tf.y; this.t = nowMs; return { speed: 0 }; } // teleport / respawn
    if (dist < 1e-4 && dtS < 0.08) return { speed: this.speed, ...(this.heading !== undefined && { heading: this.heading }) }; // no new tick yet
    const k = 1 - Math.exp(-dtS / 0.15);
    this.speed += (dist / dtS - this.speed) * k;
    if (dist > 0.01) this.heading = Math.atan2(dy, dx); else if (this.speed < 0.3) this.heading = undefined;
    this.x = tf.x; this.y = tf.y; this.t = nowMs;
    return { speed: this.speed, ...(this.heading !== undefined && { heading: this.heading }) };
  }
}

export interface LedgeOverlayDeps {
  world(): World; player(): Entity | undefined; camera(): CameraLike | undefined;
  hidden(): boolean; enabled(): boolean; alpha(): number; ground?: Ground;
}

export function mountLedgeWarning(root: HTMLElement, d: LedgeOverlayDeps): { destroy(): void } {
  const cv = document.createElement("canvas"); cv.id = "ledge-warning";
  cv.setAttribute("aria-hidden", "true"); cv.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:4"; root.append(cv);
  let raf = 0, drewLast = false, sig = "";
  const track = new LedgeMotionTracker();
  const tick = (): void => {
    raf = requestAnimationFrame(tick);
    const cam = d.camera();
    const on = !!cam && !d.hidden() && d.enabled();
    const motion = on ? track.sample(d.world(), d.player(), performance.now()) : (track.reset(), undefined);
    const hints = !on ? [] : ledgeDraws(d.world(), d.player(), cam!, d.alpha(), d.ground, motion);
    const hint = hints[0];
    const next = hints.map((h) => `${h.drop}:${h.risk}`).join("|");
    if (next !== sig) { sig = next; cv.dataset["drop"] = hint ? String(hint.drop) : ""; cv.dataset["risk"] = hint?.risk ?? ""; cv.dataset["count"] = String(hints.length); }
    if (!hint && !drewLast) return;
    const dpr = Math.min(3, devicePixelRatio || 1), W = root.clientWidth || innerWidth, H = root.clientHeight || innerHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    }
    const g = cv.getContext("2d"); if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H); drewLast = !!hint;
    if (!hint) return;
    g.lineJoin = "round"; g.lineCap = "round";
    // farthest first so the nearest (most urgent) arrow draws on top; off-screen arrows are skipped
    for (let i = hints.length - 1; i >= 0; i--) {
      const h = hints[i]!; const ax = h.sx, ay = h.sy + 10;
      if (ax < -20 || ay < -30 || ax > W + 20 || ay > H + 30) continue;
      const color = LEDGE_COLORS[h.risk];
      g.globalAlpha = h.alpha;
      g.beginPath(); g.moveTo(ax, ay + 16); g.lineTo(ax - 11, ay - 2); g.lineTo(ax + 11, ay - 2); g.closePath();
      g.fillStyle = color; g.strokeStyle = "#1a1210"; g.lineWidth = 3; g.stroke(); g.fill();
      g.font = "bold 16px Fredoka,system-ui,sans-serif"; g.textAlign = "center"; g.textBaseline = "bottom";
      g.lineWidth = 4; g.strokeStyle = "#1a1210"; g.strokeText(String(h.drop), ax, ay - 6);
      g.fillStyle = color; g.fillText(String(h.drop), ax, ay - 6);
    }
    g.globalAlpha = 1;
  };
  raf = requestAnimationFrame(tick);
  return { destroy: () => { cancelAnimationFrame(raf); cv.remove(); } };
}
