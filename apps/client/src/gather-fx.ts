/**
 * ADR-128 client overlays (renderer-agnostic DOM, positioned from the shared camera like ADR-126's tool hint, so WebGL2
 * and the Canvas2D fallback look the same):
 *  - node health bars: when a ResourceNode's REPLICATED amount drops (any player's hit, so every client agrees) a small
 *    bar of remaining yield (amount / capacity) shows above the node, then fades out ~3 s after the last hit;
 *  - hit particles: wood chips + leaves (axe nodes), stone chips (pickaxe nodes) or leaves (hand nodes) burst away;
 *  - pickup toasts: "+3 Wood" with the item icon for every rise in the local player's inventory (gather, harvest,
 *    loot, pickup, crafting output), merged per item while it is still on screen; a short stack bottom-left, smaller
 *    and higher on touch so it never covers the sticks.
 *  - ADR-134 creature bars: players, AI humans, animals and zombies show a compact hp bar (same ADR-128 frame art) when
 *    their replicated hp drops or a HitReact arrives, fading CREATURE_BAR_MS after the last hit; the local player's
 *    current combat targets (it hit them in the last COMBAT_TARGET_MS, or is attacking them now) keep theirs up.
 *    Party / clan mates of the local player draw blue.
 * Pure state machines (NodeHits, ToastStack, CreatureBars) are exported and tested; the DOM layer only draws them.
 * DOM hooks: `#gather-fx` (canvas), `#pickup-toasts > [data-role=toast][data-item]`.
 */
import { setData, setHidden, setStyle, setText } from "./dom-diff.js";
import { NetId, PlayerId, Transform, type Entity, type World } from "@engine/core";
import { creatureBarLift, isOwnMount } from "./mount-render.js";
import { Animal, Dead, gameplayDefs, GroupSummary, Health, HitReact, IntentAction, listSlots, Pet, PlayerIntent, Progression, XP, xpToNext, treesOf, treeShortName, treeXpToNext, ResourceNode, Survival, Zombie } from "@engine/gameplay";
import { isoToCss, type CameraLike } from "./world-tools.js";

export const NODE_BAR_MS = 3000;
/** Screen lift (css px at zoom 1) of a node health bar above its feet: hand icons must sit above this, not over it. */
export const NODE_BAR_LIFT = 58;
export const NODE_BAR_FADE_MS = 600;
export interface NodeBar { node: Entity; x: number; y: number; frac: number; at: number; kind: "wood" | "stone" | "plant" }
/** Alpha of a node bar `ms` after its last hit (1 -> fades over the last NODE_BAR_FADE_MS of NODE_BAR_MS, then 0). */
export const nodeBarAlpha = (ms: number): number => (ms < 0 ? 0 : ms <= NODE_BAR_MS - NODE_BAR_FADE_MS ? 1 : ms >= NODE_BAR_MS ? 0 : (NODE_BAR_MS - ms) / NODE_BAR_FADE_MS);
/** Particle family for a node by the tool it asks for. */
export const particleKind = (tool: number): NodeBar["kind"] => // ToolKind 1 axe, 2 pickaxe
  (tool === 1 ? "wood" : tool === 2 ? "stone" : "plant");

/** Tracks replicated ResourceNode amounts and reports hits (amount went down) with the remaining fraction. */
export class NodeHits {
  private amt = new Map<Entity, number>(); readonly bars = new Map<Entity, NodeBar>();
  /** Scan the replica; returns the bars that were hit this call. */
  scan(world: World, now: number): NodeBar[] {
    const defs = gameplayDefs(world); const hits: NodeBar[] = []; const seen = new Set<Entity>();
    for (const e of world.query([ResourceNode, Transform])) {
      seen.add(e); const n = world.get(e, ResourceNode)!; const was = this.amt.get(e); this.amt.set(e, n.amount);
      if (was === undefined || n.amount >= was) continue;
      const def = defs.resources.get(n.kind); const cap = Math.max(1, def?.capacity ?? was); const t = world.get(e, Transform)!;
      const bar: NodeBar = { node: e, x: t.x, y: t.y, frac: Math.max(0, Math.min(1, n.amount / cap)), at: now, kind: particleKind(def?.requiredTool ?? 0) };
      this.bars.set(e, bar); hits.push(bar);
    }
    for (const e of [...this.amt.keys()]) if (!seen.has(e)) { this.amt.delete(e); this.bars.delete(e); }
    for (const [e, b] of this.bars) if (now - b.at >= NODE_BAR_MS) this.bars.delete(e);
    return hits;
  }
}

export const CREATURE_BAR_MS = 4000;
export const CREATURE_BAR_FADE_MS = 800;
export const COMBAT_TARGET_MS = 8000;
export type CreatureKind = "human" | "animal" | "zombie";
export interface CreatureBar { e: Entity; x: number; y: number; frac: number; at: number; kind: CreatureKind; ally: boolean; target: boolean; /** ADR-319: css px lift override (tall mounts, riders) */ lift?: number }
export const creatureBarAlpha = (ms: number, target: boolean): number =>
  target ? 1 : ms < 0 ? 0 : ms <= CREATURE_BAR_MS - CREATURE_BAR_FADE_MS ? 1 : ms >= CREATURE_BAR_MS ? 0 : (CREATURE_BAR_MS - ms) / CREATURE_BAR_FADE_MS;
/** Bar fill colour: allies blue, else by remaining hp. */
export const barFill = (frac: number, ally = false): string => (ally ? "#6CA8E6" : frac > 0.5 ? "#7BC86C" : frac > 0.25 ? "#E6C47E" : "#C0584A");

/** ADR-134: which creatures show an hp bar this frame (replica-only: Health, HitReact, GroupSummary, local intent). */
export class CreatureBars {
  private hp = new Map<Entity, number>(); private hitTick = new Map<Entity, number>(); private mine = new Map<Entity, number>();
  readonly bars = new Map<Entity, CreatureBar>();
  scan(world: World, now: number, me: Entity | undefined): CreatureBar[] {
    const seen = new Set<Entity>(); const myId = me !== undefined ? world.getField(me, NetId, "id") ?? 0 : 0;
    const myG = me !== undefined ? world.get(me, GroupSummary) : undefined;
    const myPid = me !== undefined && world.isRegistered(PlayerId) && world.isRegistered(Pet) ? world.getField(me, PlayerId, "id") ?? 0 : 0; // ADR-145: own pets = ally, bar kept up while hurt
    const it = me !== undefined ? world.get(me, PlayerIntent) : undefined; const attacking = it && it.action === IntentAction.Attack ? it.target : undefined;
    for (const e of world.query([Health, Transform], [Dead])) {
      if (e === me) continue;
      const kind: CreatureKind | undefined = world.has(e, Zombie) ? "zombie" : world.has(e, Animal) ? "animal" : world.has(e, Survival) || world.has(e, GroupSummary) ? "human" : undefined;
      if (!kind) continue;
      seen.add(e); const h = world.get(e, Health)!; const t = world.get(e, Transform)!;
      const was = this.hp.get(e); this.hp.set(e, h.hp);
      const hr = world.get(e, HitReact); const lastHit = this.hitTick.get(e);
      if (hr) this.hitTick.set(e, hr.startTick);
      const hitNow = (was !== undefined && h.hp < was - 1e-3) || (hr !== undefined && lastHit !== undefined && hr.startTick !== lastHit);
      if (hitNow && hr && myId && hr.src === myId) this.mine.set(e, now);
      const myPet = (!!myPid && world.has(e, Pet) && world.getField(e, Pet, "owner") === myPid) || isOwnMount(world, e, myPid); // ADR-319: own mounts too
      const target = (myPet && h.hp < h.max - 1e-3) || attacking === e || now - (this.mine.get(e) ?? -Infinity) < COMBAT_TARGET_MS;
      let b = this.bars.get(e);
      if (!b && !hitNow && !target) continue;
      const g = world.get(e, GroupSummary);
      const ally = myPet || !!(myG && g && ((myG.partyId && g.partyId === myG.partyId) || (myG.clanId && g.clanId === myG.clanId)));
      const frac = h.max > 0 ? Math.max(0, Math.min(1, h.hp / h.max)) : 0;
      if (!b) { b = { e, x: t.x, y: t.y, frac, at: now, kind, ally, target }; this.bars.set(e, b); }
      Object.assign(b, { x: t.x, y: t.y, frac, kind, ally, target }); if (hitNow) b.at = now;
      const lift = creatureBarLift(world, e, kind); if (lift !== undefined) b.lift = lift; else delete b.lift;
    }
    for (const e of [...this.hp.keys()]) if (!seen.has(e)) { this.hp.delete(e); this.hitTick.delete(e); this.mine.delete(e); this.bars.delete(e); }
    for (const [e, b] of this.bars) if (creatureBarAlpha(now - b.at, b.target) <= 0) this.bars.delete(e);
    return [...this.bars.values()];
  }
}
/** Screen lift (css px at zoom 1) of a creature bar above its feet. */
export const CREATURE_BAR_LIFT: Record<CreatureKind, number> = { human: 74, zombie: 74, animal: 46 };

export const TOAST_MS = 2200;
export const TOAST_MAX = 4;
export interface Toast { item: number; count: number; name: string; icon: string; at: number; id: number }
/** Inventory-diff pickup toasts: one line per item, merged while visible, newest last, at most TOAST_MAX. */
export class ToastStack {
  private last: Map<number, number> | undefined; private seq = 0; toasts: Toast[] = [];
  /** Feed the current item totals; the first call (join / respawn) only primes. */
  update(totals: ReadonlyMap<number, number>, now: number, label: (item: number) => { name: string; icon: string }): void {
    const prev = this.last; this.last = new Map(totals);
    this.toasts = this.toasts.filter((t) => now - t.at < TOAST_MS);
    if (!prev) return;
    for (const [item, n] of totals) {
      const gain = n - (prev.get(item) ?? 0); if (gain <= 0) continue;
      const cur = this.toasts.find((t) => t.item === item);
      if (cur) { cur.count += gain; cur.at = now; this.toasts = [...this.toasts.filter((t) => t !== cur), cur]; }
      else { const l = label(item); this.toasts.push({ item, count: gain, name: l.name, icon: l.icon, at: now, id: ++this.seq }); }
    }
    if (this.toasts.length > TOAST_MAX) this.toasts = this.toasts.slice(-TOAST_MAX);
  }
  /** ADR-135: "+N XP" line (pseudo item XP_ITEM), merged while visible like item pickups. */
  addXp(gain: number, now: number, label = "XP"): void {
    if (gain <= 0) return; const cur = this.toasts.find((t) => t.item === XP_ITEM && t.name === label);
    if (cur && now - cur.at < XP.popup.mergeMs + TOAST_MS) { cur.count = isLevelLabel(label) ? gain : cur.count + gain; cur.at = now; this.toasts = [...this.toasts.filter((t) => t !== cur), cur]; }
    else this.toasts.push({ item: XP_ITEM, count: gain, name: label, icon: "xp", at: now, id: ++this.seq });
    if (this.toasts.length > TOAST_MAX) this.toasts = this.toasts.slice(-TOAST_MAX);
  }
  reset(): void { this.last = undefined; this.toasts = []; }
}
export const XP_ITEM = -1;
/** ADR-135: XP gained between two Progression samples (level-ups count the remainder of each finished level). */
export function xpGain(prev: { xp: number; level: number } | undefined, cur: { xp: number; level: number }, next: (level: number) => number = xpToNext): number {
  if (!prev) return 0; if (cur.level === prev.level) return Math.max(0, cur.xp - prev.xp);
  if (cur.level < prev.level) return 0; let g = next(prev.level) - prev.xp; for (let l = prev.level + 1; l < cur.level; l++) g += next(l); return g + cur.xp;
}
/** "Level" (character) or "<Tree> level" (ADR-209): the count is a level, replaced rather than summed. */
export const isLevelLabel = (name: string): boolean => name === "Level" || name.endsWith(" level");
export const toastText = (t: Pick<Toast, "count" | "name">): string => isLevelLabel(t.name) ? `${t.name} ${t.count}!` : `+${t.count} ${t.name}`;
/** ADR-209: per-tree XP toasts ("+6 Combat XP", "Combat level 3!") from two replicated per-tree samples. */
export function treeXpToasts(prev: readonly { xp: number; level: number }[] | undefined, cur: readonly { xp: number; level: number }[]): { label: string; count: number }[] {
  const out: { label: string; count: number }[] = []; if (!prev) return out;
  cur.forEach((c, i) => {
    const p = prev[i]; if (!p) return; const g = xpGain(p, c, treeXpToNext); const n = treeShortName(i);
    if (g >= XP.popup.minShown) out.push({ label: `${n} XP`, count: g });
    if (c.level > p.level) out.push({ label: `${n} level`, count: c.level });
  });
  return out;
}
export function inventoryTotals(world: World, e: Entity): Map<number, number> {
  const m = new Map<number, number>(); for (const s of listSlots(world, e)) m.set(s.item, (m.get(s.item) ?? 0) + s.count); return m;
}

/** ADR-128 art (nature_adr128_fx / _hpbar / _toast, manifest.nature.json). Procedural drawing stays as the fallback. */
export const FX_CELL = 16; export const FX_COLS = 4; export const FX_FRAMES = 4; export const FX_FPS = 12;
export const FX_SPRITE: Record<NodeBar["kind"], { key: string; first: number }> = {
  wood: { key: "particle_wood_chip", first: 0 }, stone: { key: "particle_stone_chip", first: 4 }, plant: { key: "particle_leaf", first: 8 },
};
/** Source rect (in 1x atlas px; multiply by page scale) of a particle's current frame. */
export function particleFrame(kind: NodeBar["kind"], age: number, scale = 1): { sx: number; sy: number; sw: number; sh: number } {
  const f = FX_SPRITE[kind].first + (Math.floor(Math.max(0, age) * FX_FPS) % FX_FRAMES); const c = FX_CELL * scale;
  return { sx: (f % FX_COLS) * c, sy: Math.floor(f / FX_COLS) * c, sw: c, sh: c };
}
/** ui_node_hpbar_frame: a 32x4 bar centred (rows 6..9) in a 32x16 cell; 9-slice l/r 2 px. */
export const HPBAR = { w: 32, h: 4, y: 6, l: 2, r: 2 } as const;
/** Horizontal 3-slice of the hp bar frame into a dest rect: [sx, sw, dx, dw] per piece (source in 1x px times scale). */
export function hpbarSlices(dx: number, dw: number, scale = 1): Array<[number, number, number, number]> {
  const { w, l, r } = HPBAR; const L = Math.min(l * 2, dw / 2), R = Math.min(r * 2, dw / 2); // caps drawn at 2 css px per art px
  return [[0, l * scale, dx, L], [l * scale, (w - l - r) * scale, dx + L, Math.max(0, dw - L - R)], [(w - r) * scale, r * scale, dx + dw - R, R]];
}
/** ui_creature_hpbar_frame (ADR-134, nature_adr134_hpbar): 24x6 bar at (4,5) in a 32x16 cell; manifest 9-slice l/t/r/b 7/6/7/6 of the cell. */
export const CREATURE_HPBAR = { cellW: 32, cellH: 16, x: 4, y: 5, w: 24, h: 6, slice: { l: 7, t: 6, r: 7, b: 6 } } as const;
/** 9-slice the creature frame into dest rect (dx,dy,dw,dh): [sx, sy, sw, sh, dx, dy, dw, dh] per piece (source px times scale).
 *  The source is the bar box inside the cell, so the cell's slice lines become insets of l-x, t-y, (x+w)-(cellW-r), (y+h)-(cellH-b). */
export function nineSlice(dx: number, dy: number, dw: number, dh: number, scale = 1, cap = 1): Array<[number, number, number, number, number, number, number, number]> {
  const B = CREATURE_HPBAR, S = B.slice;
  const l = S.l - B.x, t = S.t - B.y, r = B.x + B.w - (B.cellW - S.r), b = B.y + B.h - (B.cellH - S.b);
  const xs = [B.x, B.x + l, B.x + B.w - r, B.x + B.w], ys = [B.y, B.y + t, B.y + B.h - b, B.y + B.h];
  const L = Math.min(l * cap, dw / 2), R = Math.min(r * cap, dw / 2), T = Math.min(t * cap, dh / 2), Bt = Math.min(b * cap, dh / 2);
  const dxs = [dx, dx + L, dx + dw - R, dx + dw], dys = [dy, dy + T, dy + dh - Bt, dy + dh];
  const out: Array<[number, number, number, number, number, number, number, number]> = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
    const w = dxs[i + 1]! - dxs[i]!, h = dys[j + 1]! - dys[j]!; if (w <= 0 || h <= 0) continue;
    out.push([xs[i]! * scale, ys[j]! * scale, (xs[i + 1]! - xs[i]!) * scale, (ys[j + 1]! - ys[j]!) * scale, dxs[i]!, dys[j]!, w, h]);
  }
  return out;
}
/** ui_pickup_toast_bg: 48x32 cell, 9-slice l/r 10, t/b 12 (pill rows 4..27). */
export const TOAST_SLICE = { l: 10, t: 12, r: 10, b: 12 } as const;
/** ui_xp_chip_frame (ADR-135, items_xp_chip): 40x20 cell, 9-slice l/t/r/b 10/9/10/9. */
export const XP_CHIP_SLICE = { l: 10, t: 9, r: 10, b: 9 } as const;
export const ART_URLS = {
  fx: [new URL("../../../packages/assets/pack/nature/atlases/nature_adr128_fx.png", import.meta.url).href, new URL("../../../packages/assets/pack/nature/atlases/nature_adr128_fx@2x.png", import.meta.url).href],
  hpbar: [new URL("../../../packages/assets/pack/nature/atlases/nature_adr128_hpbar.png", import.meta.url).href, new URL("../../../packages/assets/pack/nature/atlases/nature_adr128_hpbar@2x.png", import.meta.url).href],
  creatureHpbar: [new URL("../../../packages/assets/pack/nature/atlases/nature_adr134_hpbar.png", import.meta.url).href, new URL("../../../packages/assets/pack/nature/atlases/nature_adr134_hpbar@2x.png", import.meta.url).href],
  toast: [new URL("../../../packages/assets/pack/nature/atlases/nature_adr128_toast.png", import.meta.url).href, new URL("../../../packages/assets/pack/nature/atlases/nature_adr128_toast@2x.png", import.meta.url).href],
  xpChip: [new URL("../../../packages/assets/pack/items/atlases/items_xp_chip.png", import.meta.url).href, new URL("../../../packages/assets/pack/items/atlases/items_xp_chip@2x.png", import.meta.url).href],
} as const;
const ready = (im: HTMLImageElement | undefined): im is HTMLImageElement => !!im && im.complete && im.naturalWidth > 0;
function loadArt(urls: readonly string[], onLoad?: (im: HTMLImageElement, i: number) => void): HTMLImageElement[] {
  if (typeof Image === "undefined") return [];
  return urls.map((u, i) => { const im = new Image(); im.decoding = "async"; if (onLoad) im.onload = () => onLoad(im, i); im.src = u; return im; });
}

interface Particle { x: number; y: number; vx: number; vy: number; life: number; age: number; color: string; size: number; leaf: boolean; kind: NodeBar["kind"] }
const COLORS: Record<NodeBar["kind"], string[]> = { wood: ["#C8955A", "#8B5A2B", "#5E8C3A"], stone: ["#9A9A9A", "#6E6E6E", "#C4C0B8"], plant: ["#5E8C3A", "#7FB24A", "#A3C76B"] };

export interface GatherFxDeps {
  world(): World; player(): Entity | undefined; camera(): CameraLike | undefined; hidden(): boolean;
  device?(): "keyboardMouse" | "gamepad" | "touch"; icon?(item: number, key: string): string;
}
const CSS = `#gather-fx{position:absolute;inset:0;z-index:5;pointer-events:none}
#pickup-toasts{position:absolute;left:12px;bottom:96px;z-index:5;display:flex;flex-direction:column;gap:4px;pointer-events:none;font:600 14px/1.2 system-ui,sans-serif}
#pickup-toasts[data-device=touch]{bottom:auto;top:84px;left:8px;font-size:12px}
@media (orientation:portrait){#pickup-toasts,#pickup-toasts[data-device=touch]{bottom:auto;top:calc(var(--hud-bottom,140px) + 8px);left:calc(8px + var(--sal,0px));max-width:min(120px,calc(100% - 16px - var(--sal,0px) - var(--sar,0px)))}}
#pickup-toasts [data-role=toast]{overflow-wrap:anywhere;display:flex;align-items:center;gap:6px;padding:3px 8px 3px 4px;border-radius:6px;background:rgba(20,16,12,.62);color:#FFFAF0;transition:opacity .3s ease,transform .3s ease;text-shadow:0 1px 1px #000}
#pickup-toasts [data-role=toast][data-fade=true]{opacity:0;transform:translateX(-8px)}
#pickup-toasts[data-art=true] [data-role=toast]{background:transparent;border-style:solid;border-width:6px 5px;border-image:var(--toast-bg) ${TOAST_SLICE.t} ${TOAST_SLICE.r} ${TOAST_SLICE.b} ${TOAST_SLICE.l} fill / 12px 10px / 0 round;border-radius:0;padding:0 6px 0 2px;color:#3a2a18;text-shadow:none}
#pickup-toasts [data-item="-1"] .ic{background:#d9a227;border-radius:50%}
#xp-chip{position:absolute;left:12px;bottom:72px;z-index:5;display:flex;align-items:center;gap:5px;padding:2px 6px;border-radius:9px;background:rgba(20,16,12,.55);color:#FFFAF0;font:700 11px/1 system-ui,sans-serif;pointer-events:none}
#xp-chip[data-device=touch]{bottom:auto;top:max(60px,var(--hud-bottom,60px));left:8px}
#xp-chip[data-art=true]{background:transparent;border-radius:0;border-style:solid;border-width:5px 5px;border-image:var(--xp-chip-bg) ${XP_CHIP_SLICE.t} ${XP_CHIP_SLICE.r} ${XP_CHIP_SLICE.b} ${XP_CHIP_SLICE.l} fill / 9px 10px stretch;padding:0 2px}
#xp-chip .bar{width:56px;height:4px;border-radius:2px;background:rgba(255,255,255,.18);overflow:hidden}#xp-chip .bar>i{display:block;height:100%;width:var(--p,0%);background:#d9a227}
#pickup-toasts .ic{width:20px;height:20px;flex:none;background:var(--cz-icon,#6b5a45) var(--cz-ipos,center)/var(--cz-isize,contain) no-repeat;border-radius:3px}`;

export function mountGatherFx(root: HTMLElement, d: GatherFxDeps): { destroy(): void } {
  const style = document.createElement("style"); style.textContent = CSS; document.head.append(style);
  const cv = document.createElement("canvas"); cv.id = "gather-fx"; root.append(cv);
  const box = document.createElement("div"); box.id = "pickup-toasts"; box.setAttribute("aria-live", "polite"); root.append(box);
  const chip = document.createElement("div"); chip.id = "xp-chip"; chip.innerHTML = '<span class="lv"></span><span class="bar"><i></i></span>'; root.append(chip);
  loadArt(ART_URLS.xpChip, (_im, i) => { if (i !== 0) return; chip.style.setProperty("--xp-chip-bg", `image-set(url("${ART_URLS.xpChip[0]}") 1x, url("${ART_URLS.xpChip[1]}") 2x)`); chip.dataset["art"] = "true"; }); // else the CSS pill stays
  let lastXp: { xp: number; level: number } | undefined; let lastTrees: { xp: number; level: number }[] | undefined;
  const fx = loadArt(ART_URLS.fx), bar = loadArt(ART_URLS.hpbar), cbar = loadArt(ART_URLS.creatureHpbar);
  loadArt(ART_URLS.toast.slice(0, 1), () => { box.style.setProperty("--toast-bg", `url("${ART_URLS.toast[0]}")`); box.dataset["art"] = "true"; }); // else the CSS pill stays
  const hits = new NodeHits(); const creatures = new CreatureBars(); const stack = new ToastStack(); let parts: Particle[] = []; let raf = 0; let last = performance.now(); let player: Entity | undefined; let lastInv = 0;
  const label = (item: number): { name: string; icon: string } => { const it = gameplayDefs(d.world()).items.get(item); const key = it?.spriteKey ?? ""; return { name: it?.name ?? `#${item}`, icon: d.icon ? d.icon(item, key) : key }; };
  const tick = (now: number): void => {
    raf = requestAnimationFrame(tick); const dt = Math.min(0.05, (now - last) / 1000); last = now;
    try {
      const w = d.world(); const cam = d.camera(); const p = d.player();
      for (const b of hits.scan(w, now)) for (let i = 0; i < 7; i++) {
        const a = Math.random() * Math.PI * 2; const sp = 0.6 + Math.random() * 1.2; const cs = COLORS[b.kind];
        parts.push({ x: b.x, y: b.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.45 + Math.random() * 0.35, age: 0, color: cs[i % cs.length]!, size: b.kind === "stone" ? 3 : 4, leaf: b.kind !== "stone" && i % 3 === 2, kind: b.kind });
      }
      if (p !== player) { player = p; stack.reset(); lastXp = undefined; lastTrees = undefined; }
      const pr = p !== undefined ? w.get(p, Progression) : undefined; setHidden(chip, !pr || d.hidden()); setData(chip, "device", d.device?.() ?? "keyboardMouse");
      if (pr) {
        const cur = { xp: pr.xp, level: pr.level };
        // ADR-209: XP toasts name the tree that earned it; the chip stays the character level
        const trees = treesOf(w, p!); if (trees) { for (const t of treeXpToasts(lastTrees, trees)) stack.addXp(t.count, now, t.label); lastTrees = trees; }
        if (cur.level > (lastXp?.level ?? cur.level)) stack.addXp(cur.level, now, "Level"); lastXp = cur;
        setText(chip.firstChild as HTMLElement, `Lv ${cur.level}`); setStyle(chip, "--p", `${Math.min(100, (100 * cur.xp) / Math.max(1, xpToNext(cur.level))).toFixed(1)}%`);
      }
      if (p !== undefined && now - lastInv > 100) { lastInv = now; stack.update(inventoryTotals(w, p), now, label); }
      drawToasts(now);
      const dpr = Math.min(3, globalThis.devicePixelRatio || 1); const W = root.clientWidth || innerWidth, H = root.clientHeight || innerHeight;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = `${W}px`; cv.style.height = `${H}px`; }
      const g = cv.getContext("2d"); if (!g) return; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      if (!cam || d.hidden()) { parts = []; return; }
      const z = Math.max(0.6, Math.min(2, cam.drawZoom)); const touch = d.device?.() === "touch";
      const pi = dpr > 1 && ready(fx[1]) ? 1 : 0; const fxIm = ready(fx[pi]) ? fx[pi] : undefined; const fxS = pi + 1;
      const bi = dpr > 1 && ready(bar[1]) ? 1 : 0; const barIm = ready(bar[bi]) ? bar[bi] : undefined; const barS = bi + 1;
      const ci = dpr > 1 && ready(cbar[1]) ? 1 : 0; const cIm = ready(cbar[ci]) ? cbar[ci] : undefined; const cS = ci + 1;
      g.imageSmoothingEnabled = false;
      const drawBar = (cx: number, top: number, bw: number, bh: number, frac: number, fill: string, al: number, creature = false): void => {
        const x = cx - bw / 2, y = top; g.globalAlpha = al;
        if (creature && cIm) { // ADR-134 creature frame (9-sliced) over a dark well + fill inside its rim
          const ix = Math.max(1, bw / 8), iy = Math.max(1, bh / 4);
          g.fillStyle = "rgba(20,16,12,.55)"; g.fillRect(x, y, bw, bh); g.fillStyle = fill; g.fillRect(x + ix, y + iy, (bw - 2 * ix) * frac, bh - 2 * iy);
          for (const [sx, sy, sw, sh, dx, dy, dw, dh] of nineSlice(x, y, bw, bh, cS, bh / CREATURE_HPBAR.h)) g.drawImage(cIm, sx, sy, sw, sh, dx, dy, dw, dh);
        } else if (!creature && barIm) { // art frame (3-sliced, 4 px tall crop) over a dark well + the fill inside its rim
          g.fillStyle = "rgba(20,16,12,.55)"; g.fillRect(x, y, bw, bh); g.fillStyle = fill; const inset = Math.max(1, bh / 4); g.fillRect(x + inset, y + inset, (bw - 2 * inset) * frac, bh - 2 * inset);
          for (const [sx, sw, dx, dw] of hpbarSlices(x, bw, barS)) if (dw > 0) g.drawImage(barIm, sx, HPBAR.y * barS, sw, HPBAR.h * barS, dx, y, dw, bh);
        } else { g.fillStyle = "rgba(20,16,12,.75)"; g.fillRect(x - 1, y - 1, bw + 2, bh + 2); g.fillStyle = fill; g.fillRect(x, y, bw * frac, bh); }
      };
      for (const b of hits.bars.values()) {
        const al = nodeBarAlpha(now - b.at); if (al <= 0) continue; const s = isoToCss(cam, b.x, b.y);
        drawBar(s.x, s.y - NODE_BAR_LIFT * z, (touch ? 44 : 36) * z, Math.max(4, 5 * z), b.frac, barFill(b.frac), al);
      }
      for (const b of creatures.scan(w, now, p)) { // ADR-134 creature bars: compact, a touch smaller than node bars
        const al = creatureBarAlpha(now - b.at, b.target); if (al <= 0) continue; const s = isoToCss(cam, b.x, b.y);
        drawBar(s.x, s.y - (b.lift ?? CREATURE_BAR_LIFT[b.kind]) * z, (b.kind === "animal" ? 26 : 30) * z * (touch ? 1.2 : 1), Math.max(3, 4 * z), b.frac, barFill(b.frac, b.ally), al, true);
      }
      parts = parts.filter((q) => (q.age += dt) < q.life);
      for (const q of parts) {
        q.x += q.vx * dt; q.y += q.vy * dt; const s = isoToCss(cam, q.x, q.y); const lift = (24 + 40 * q.age - 90 * q.age * q.age) * z;
        g.globalAlpha = 1 - q.age / q.life; g.fillStyle = q.color;
        if (fxIm) { const r = particleFrame(q.kind, q.age, fxS); const sz = FX_CELL * 0.75 * z; g.drawImage(fxIm, r.sx, r.sy, r.sw, r.sh, s.x - sz / 2, s.y - lift - sz / 2, sz, sz); }
        else if (q.leaf) { g.beginPath(); g.ellipse(s.x, s.y - lift, q.size * z, q.size * 0.5 * z, q.age * 6, 0, Math.PI * 2); g.fill(); } else g.fillRect(s.x - q.size * z / 2, s.y - lift, q.size * z, q.size * z);
      }
      g.globalAlpha = 1;
    } catch { /* overlays must never break a frame */ }
  };
  const drawToasts = (now: number): void => {
    setData(box, "device", d.device?.() ?? "keyboardMouse"); setHidden(box, d.hidden());
    const keep = new Set(stack.toasts.map((t) => String(t.id)));
    for (const el of Array.from(box.children) as HTMLElement[]) if (!keep.has(el.dataset["id"] ?? "")) el.remove();
    for (const t of stack.toasts) {
      let el = box.querySelector<HTMLElement>(`[data-id="${t.id}"]`);
      if (!el) { el = document.createElement("div"); el.dataset["role"] = "toast"; el.dataset["id"] = String(t.id); el.dataset["item"] = String(t.item); const ic = document.createElement("span"); ic.className = "ic"; ic.setAttribute("data-icon", t.icon); const tx = document.createElement("span"); el.append(ic, tx); }
      box.append(el); setText(el.lastChild as HTMLElement, toastText(t)); setData(el, "fade", String(now - t.at > TOAST_MS - 350));
    }
  };
  raf = requestAnimationFrame(tick);
  return { destroy: () => { cancelAnimationFrame(raf); cv.remove(); box.remove(); chip.remove(); style.remove(); } };
}
