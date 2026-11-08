/** ADR-306: a downward drop arrow on camera-hidden ledges, colored by fall damage vs current HP. */
import { PrevTransform, Transform, lerp, type Entity, type World } from "@engine/core";
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
    if (score > bestScore) { bestScore = score; best = { drop, damage, risk, dx, dy, x: tx + 0.5 + dx * 0.42, y: ty + 0.5 + dy * 0.42 }; }
  }
  return best;
}

type Ground = (x: number, y: number, z: number) => number;
export interface LedgeDraw extends LedgeHint { sx: number; sy: number }

export function ledgeDraw(w: World, player: Entity | undefined, cam: CameraLike, alpha = 1, ground: Ground = (_x, _y, z) => z): LedgeDraw | undefined {
  if (player === undefined || !w.isAlive(player) || (w.isRegistered(Dead) && w.has(player, Dead))) return undefined;
  const t = w.get(player, Transform); if (!t) return undefined;
  const prev = w.get(player, PrevTransform) ?? t;
  const x = lerp(prev.x, t.x, alpha), y = lerp(prev.y, t.y, alpha);
  const terrain = w.getResource(TerrainRes); if (!terrain) return undefined;
  const idx = w.getResource(StructureIndexRes);
  const hint = pickLedgeHint({
    x, y, viewQ: camIso(cam).view ?? 0, facing: t.facing ?? 0,
    hp: w.getField(player, Health, "hp") ?? 100,
    heightAt: (tx, ty) => shaftAwareHeight(w, terrain, tx, ty, player),
    ladderBetween: (ax, ay, bx, by) => ladderBetween(idx, ax, ay, bx, by),
  });
  if (!hint) return undefined;
  const z = ground(hint.x, hint.y, t.z ?? 0);
  const p = worldToScreen(hint.x, hint.y, z, camIso(cam));
  const zoom = cam.drawZoom, W = cam.viewW / cam.dpr, H = cam.viewH / cam.dpr;
  return { ...hint, sx: (p.sx - cam.x) * zoom + W / 2, sy: (p.sy - cam.y) * zoom + H / 2 };
}

export interface LedgeOverlayDeps {
  world(): World; player(): Entity | undefined; camera(): CameraLike | undefined;
  hidden(): boolean; enabled(): boolean; alpha(): number; ground?: Ground;
}

export function mountLedgeWarning(root: HTMLElement, d: LedgeOverlayDeps): { destroy(): void } {
  const cv = document.createElement("canvas"); cv.id = "ledge-warning";
  cv.setAttribute("aria-hidden", "true"); cv.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:4"; root.append(cv);
  let raf = 0, drewLast = false, sig = "";
  const tick = (): void => {
    raf = requestAnimationFrame(tick);
    const cam = d.camera();
    const hint = !cam || d.hidden() || !d.enabled() ? undefined : ledgeDraw(d.world(), d.player(), cam, d.alpha(), d.ground);
    const next = hint ? `${hint.drop}:${hint.risk}` : "";
    if (next !== sig) { sig = next; cv.dataset["drop"] = hint ? String(hint.drop) : ""; cv.dataset["risk"] = hint?.risk ?? ""; cv.dataset["count"] = hint ? "1" : "0"; }
    if (!hint && !drewLast) return;
    const dpr = Math.min(3, devicePixelRatio || 1), W = root.clientWidth || innerWidth, H = root.clientHeight || innerHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    }
    const g = cv.getContext("2d"); if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H); drewLast = !!hint;
    if (!hint) return;
    const color = LEDGE_COLORS[hint.risk], ax = hint.sx, ay = hint.sy + 10;
    g.lineJoin = "round"; g.lineCap = "round";
    g.beginPath(); g.moveTo(ax, ay + 16); g.lineTo(ax - 11, ay - 2); g.lineTo(ax + 11, ay - 2); g.closePath();
    g.fillStyle = color; g.strokeStyle = "#1a1210"; g.lineWidth = 3; g.stroke(); g.fill();
    g.font = "bold 16px Fredoka,system-ui,sans-serif"; g.textAlign = "center"; g.textBaseline = "bottom";
    g.lineWidth = 4; g.strokeStyle = "#1a1210"; g.strokeText(String(hint.drop), ax, ay - 6);
    g.fillStyle = color; g.fillText(String(hint.drop), ax, ay - 6);
  };
  raf = requestAnimationFrame(tick);
  return { destroy: () => { cancelAnimationFrame(raf); cv.remove(); } };
}
