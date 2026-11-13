import { reportRenderError } from "./report.js";
/**
 * Canvas2DRenderer: sprite fallback when WebGL2 cannot be created (console browsers after a GPU reset, WebGL blocked for
 * the origin, software-only devices). Draws the REAL sprite art from the same manifest + atlas PNGs and the same view
 * World IsoView fills for IsoRenderer: terrain diamonds, depth-sorted sprites (Transform + Sprite + AnimState), and a
 * day/night lightmap (ambient + iso light ellipses, multiplied; ADR-216), and paper-doll wearables (tinted on the CPU, ADR-128 head offset).
 * No bloom or masks. Building pieces (ADR-197) are painted level by level in a total order, with deck side faces
 * clipped where a neighbouring deck covers them.
 *
 * Presents the subset of the IsoRenderer surface the client uses (camera, capabilities, atlas.setRegistry, bindGameplay,
 * loadLook, resize, render, tilemap, setFocusEntity, diagReport) so IsoView can drive either one.
 */
import { Transform, PrevTransform, entityIndex, getAppearance, type World, type Entity } from "@engine/core";
import { fireAnimTime, hearthParticles, pieceFireFrame, isFireAnim, type HearthParticle } from "./fire-anim.js";
import { previewLayers2D, tintPixels, type PreviewLayer2D } from "./character/preview2d.js";
import { worldToScreen, toView, fromView, viewRect, DEFAULT_ISO, CHUNK_SIZE, floorToTerrainZ, terrainZToFloor, isWaterId, waterShoreTint, type TileMap, type Chunk } from "@engine/world";
import { allWaterfallArtKeys, planWaterfallArt, WATERFALL_ANIM } from "./waterfallTiles.js";
import type { AssetRegistry } from "@engine/assets";
import { IsoCamera } from "./camera.js";
import { Sprite, LightSource, SpriteAlpha } from "./components.js";
import { frameAnim } from "./frame-select.js";
import { Canvas2DLightmap, lightRadiusPx, type C2DLight } from "./canvasLight.js";
import { DEFAULT_STYLE } from "./style.js";
import { SpriteFlag } from "./ids.js";
import { GroundArt, groundHash, groundLayers, GroundLayerKind, type GroundLayer } from "./groundArt.js";
import { STATE_ANIMS, type AtlasSource } from "./assets/atlasManager.js";
import { computeDayLighting, dimForWeather, undergroundInto } from "./timeOfDay.js";
import { weatherTargets } from "./weather.js";
import { SEASON_GROUND, SeasonArt, seasonGroundRgb, seasonSpritePixels, seasonVisual, SUMMER_VISUAL, type SeasonVisual } from "./season.js";
import { readDayFraction, readDayNumber, readWeather, readWind } from "./env.js";
import { VfxLayer } from "./vfx.js";
import { WeatherFx } from "./weatherFx.js";
import { newStats, type FrameStats } from "./gl/util.js";
import { BED_SORT_EPS, type GameplayBindings } from "./sprites.js";
import { DeckNeighbors, rotSideMask, deckTopPx, deckClipPolygon, deckSeamPatches, pieceTieBreak, exactTieBreak, pieceOrder, VERTEX_POST_BIAS } from "./building/deckFaces.js";
import { lCornerArmPiece, lCornerArmPivots, ROT_EXACT_PIVOT, ROT_DECK_LIFT, ROT_VERTEX_POST } from "./building/modular.js";

export type FallbackRendererKind = "webgl2" | "canvas2d" | "debug";
export interface ContextProbe { (kind: "webgl2" | "2d"): unknown }
/** Pick the renderer for a device: WebGL2 (IsoRenderer) -> Canvas2D sprites -> debug dots. Probes a FRESH canvas so a
 *  lost/blocked context on #game cannot poison the probe. */
export function chooseRenderer(probe: ContextProbe, opts: { forceDebug?: boolean; forceCanvas?: boolean } = {}): FallbackRendererKind {
  if (opts.forceDebug) return "debug";
  const ok = (k: "webgl2" | "2d"): boolean => { try { return !!probe(k); } catch { return false; } };
  if (!opts.forceCanvas && ok("webgl2")) return "webgl2";
  if (ok("2d")) return "canvas2d";
  return "debug";
}

/** Flat ground fill per world tile id (world DEFAULT_BANDS: 1 water, 2 sand, 3 grass, 4 forest, 5 rock; 0 = none). The old
 * table was shifted by one, so grass (3) drew brown, forest blue and water green. */
export const TILE_COLORS = ["#1b1f1a", "#2d5d8a", "#c8b47a", "#4f8a43", "#3f7a3a", "#6b6b6b", "#e8eef0", "#35552c", "#4f93bf", "#5e4a33"]; // [8] ADR-181 shallow water (lighter than deep [1]); ADR-246: [6] snow / [7] forest were swapped, [9] mud

/** ADR-145: snap a sprite origin to a whole device pixel (x*s + o integer) so nearest-neighbour pixel art keeps even texel widths. */
export function snapPx(v: number, s: number, o: number): number { return s >= 1 ? (Math.round(v * s + o) - o) / s : v; }

/** ADR-182: water colour from deep (#3484bc) toward shallow (#4f93bf) by shore tint 0..1. */
/** ADR-184: deep blue -> shore turquoise (same endpoints as the WebGL2 mesh). */
export const C2D_DEEP = [0x18, 0x46, 0x90] as const, C2D_SHALLOW = [0x41, 0xb5, 0xcc] as const; // #41b5cc: matches the shallow shore overlays (50a10091)
export function waterRgb(k: number): [number, number, number] { const m = (j: 0 | 1 | 2): number => Math.round(C2D_DEEP[j] + (C2D_SHALLOW[j] - C2D_DEEP[j]) * k); return [m(0), m(1), m(2)]; }
/** ADR-253: true when a sprite has art per facing (building rows or a multi-direction / pre-rotated anim); otherwise the
 *  odd view quarters mirror it (the WebGL path: AtlasManager.isDirectional). */
export function spriteIsDirectional(reg: AssetRegistry, sid: number): boolean {
  let s; try { s = reg.sprite(sid); } catch { return false; } if (s.building) return true;
  for (const a of s.animList) if (a && (a.directions > 1 || (a.rotations?.length ?? 0) > 1)) return true; return false;
}
export class Canvas2DRenderer {
  /** ADR-263 (Task 36): 0..1 underground darkness around the camera focus. */
  underground = 0;
  readonly kind = "canvas2d" as const;
  readonly ctx: CanvasRenderingContext2D;
  readonly camera = new IsoCamera({ ...DEFAULT_ISO });
  /** ADR-253: the camera's projection (carries the view quarter). */ get iso() { return this.camera.iso; }
  /** ADR-253: current 90-degree view quarter 0..3. */ get viewRotation(): number { return this.camera.view; }
  /** ADR-253: rotate the view (instant 90-degree snap), keeping `pivot` (e.g. the player) at the same screen spot. */
  setViewRotation(q: number, pivot?: { x: number; y: number; z?: number }): void { this.camera.setView(q, pivot); }
  readonly capabilities = { renderer: "Canvas2D (no WebGL2)", vendor: "", mobile: false, lowEnd: true, basicAdapter: false, console: false, safe: true, flags: ["lowend"] as string[], fallbacks: ["Canvas2D sprite renderer (WebGL2 unavailable)"], problems: [] as string[], textureBudgetMB: 0 };
  readonly settings = { lights: true, shadows: true, weather: false, fog: false };
  stats: FrameStats = newStats();
  tilemap: TileMap | undefined;
  private tintCache = new WeakMap<Chunk, { stamp: string; t: Float32Array }>(); private waterCanvas: HTMLCanvasElement | undefined;
  bindings: GameplayBindings = {};
  readonly vram = undefined;
  readonly gl = undefined;
  private registry: AssetRegistry | undefined;
  private sources = new Map<string, AtlasSource>();
  private images = new Map<string, HTMLImageElement | ImageBitmap | null>();
  private focus = -1; private w = 0; private h = 0;
  private readonly lightmap = new Canvas2DLightmap();
  /** ADR-214: renderer-clock rate (hit-stop); the clock accumulates scaled frame time instead of reading wall time. */
  timeScale = 1; private clock = 0; private clockAt = -1;
  /** Image loader (tests inject one). */
  loadImage: (url: string) => Promise<HTMLImageElement | ImageBitmap> = (url) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error(url)); i.src = url; });
  readonly atlas = {
    setRegistry: async (r: AssetRegistry, s: Map<string, AtlasSource>): Promise<void> => { this.registry = r; this.sources = s; },
    setPieceVariants: (_p: unknown): void => {}, setHands: (_a: string, _h: unknown): void => {},
  };

  constructor(readonly canvas: HTMLCanvasElement, ctx?: CanvasRenderingContext2D | null) {
    const c = ctx ?? canvas.getContext("2d", { alpha: false }); if (!c) throw new Error("Canvas2D unavailable");
    this.ctx = c;
  }
  bindGameplay(b: GameplayBindings): void { this.bindings = b; }
  /** ADR-256: grazed grass lookup (world tile coords) + revision so gt blocks rebuild. */
  setGrazed(at: ((tx: number, ty: number) => boolean) | undefined, rev = 0): void { this.grazedAt = at; this.grazedRev = rev | 0; }
  private syncGrazedBinding(world: World): void {
    const def = this.bindings.grazedTile; if (!def || !world.isRegistered(def)) return;
    const next = new Set<string>(); for (const e of world.query([def])) { const g = world.get(e, def)!; next.add(`${g.tx},${g.ty}`); }
    let same = next.size === this.grazedKeys.size; if (same) for (const k of next) if (!this.grazedKeys.has(k)) { same = false; break; }
    if (!same) { this.grazedKeys = next; this.grazedBindRev++; this.setGrazed((x, y) => this.grazedKeys.has(`${x},${y}`), this.grazedBindRev); }
  }
  private grazedKeys = new Set<string>(); private grazedBindRev = 0;
  setFocusEntity(e: number): void { this.focus = e; }
  private fullRes = false;
  /** Full preset: do not cap the backbuffer at 1.5x DPR (see resize). Any other preset restores the 1.5x cap. */
  setQualityPreset(p: unknown): void { this.fullRes = p === "full"; }
  async loadLook(_url: string): Promise<{ warnings: string[]; loaded: string[] }> { return { warnings: [], loaded: [] }; }
  resize(cssW: number, cssH: number, dpr: number): void {
    if (!(cssW > 0) || !(cssH > 0)) return;
    const d = this.fullRes ? dpr : Math.min(dpr, 1.5); this.w = Math.round(cssW * d); this.h = Math.round(cssH * d);
    this.canvas.width = this.w; this.canvas.height = this.h; this.camera.setViewport(this.w, this.h, d);
  }
  diagReport(): string { return `renderer: Canvas2D sprites (WebGL2 unavailable); images ${[...this.images.values()].filter(Boolean).length}/${this.images.size}; draws ${this.stats.drawCalls}`; }
  dispose(): void {}

  /** Atlas image for an atlas key (PNG at scale 1), loaded on first use; null while loading / failed. */
  image(atlasKey: string): HTMLImageElement | ImageBitmap | null {
    if (this.images.has(atlasKey)) return this.images.get(atlasKey)!;
    this.images.set(atlasKey, null);
    const src = this.sources.get(atlasKey); if (src) this.loadImage(src.url).then((i) => this.images.set(atlasKey, i), (e: unknown) => reportRenderError(`canvas2d atlas load ${src.url}`, e));
    return null;
  }

  /** Image by URL (tint masks), loaded on first use; null while loading / failed. */
  private urlImage(url: string): HTMLImageElement | ImageBitmap | null {
    const k = `url:${url}`; if (this.images.has(k)) return this.images.get(k)!;
    this.images.set(k, null); this.loadImage(url).then((i) => this.images.set(k, i), (e: unknown) => reportRenderError(`canvas2d image load ${url}`, e)); return null;
  }
  private tinted = new Map<string, CanvasImageSource>();
  private tintedPieces = new Map<string, HTMLCanvasElement>();
  /** ADR-230: a build-piece frame tinted through its atlas tintmask (cached per frame rect + tint pair); null = draw untinted (no mask / no DOM / mask loading). */
  private tintedPiece(img: CanvasImageSource, f: { atlas: { key: string }; x: number; y: number; w: number; h: number }, primary: number, secondary: number): HTMLCanvasElement | null {
    if (typeof document === "undefined") return null;
    const key = `${f.atlas.key}|${f.x},${f.y},${f.w},${f.h}|${primary}|${secondary}`; const c0 = this.tintedPieces.get(key); if (c0) return c0;
    const m = this.sources.get(f.atlas.key)?.masks?.tintmask; const url = Array.isArray(m) ? m[0] : m; if (!url) return null;
    const mi = this.urlImage(url); if (!mi) return null;
    const c = document.createElement("canvas"); c.width = f.w; c.height = f.h; const g = c.getContext("2d", { willReadFrequently: true }); if (!g) return null;
    g.drawImage(img, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
    try { const d = g.getImageData(0, 0, f.w, f.h); const mc = document.createElement("canvas"); mc.width = f.w; mc.height = f.h; const mg = mc.getContext("2d", { willReadFrequently: true })!;
      mg.drawImage(mi, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h); tintPiecePixels(d.data, mg.getImageData(0, 0, f.w, f.h).data, primary, secondary); g.putImageData(d, 0, 0); } catch { return null; }
    if (this.tintedPieces.size > 512) this.tintedPieces.clear(); this.tintedPieces.set(key, c); return c;
  }
  /** A paper-doll layer's frame, tinted through its tintmask (cached); the raw sheet when untinted or no DOM canvas. */
  /** ADR-244: a paper doll picks its anim from the body layer it actually draws (v2 twin via mapLayers, e.g. sleep_lie), not the entity's v1 sprite. */
  private dollBodySprite(world: World, e: Entity, spriteId: number): number {
    const apB = this.bindings.appearance; if (!apB?.mapLayers || !world.has(e, apB.def)) return spriteId;
    const look = getAppearance(world, e); if (!look) return spriteId;
    try { const ls = apB.mapLayers(e, apB.resolve(look as never, 0, {}) as readonly { sprite: number; slot: string }[]); return ls.find((l) => l.slot === "body")?.sprite ?? spriteId; } catch { return spriteId; }
  }
  private layerImage(p: PreviewLayer2D): { img: CanvasImageSource; x: number; y: number } | null {
    const img = this.image(p.ref.atlas.key); if (!img) return null; const r = p.ref, l = p.layer;
    if ((l.tintR === undefined && l.tintG === undefined) || typeof document === "undefined") return { img, x: r.x, y: r.y };
    const key = `${r.atlas.key}|${r.x},${r.y},${r.w},${r.h}|${l.tintR}|${l.tintG}|${l.tintMode}|${l.tintStrength}`; const c0 = this.tinted.get(key); if (c0) return { img: c0, x: 0, y: 0 };
    const mi = p.maskUrl ? this.urlImage(p.maskUrl) : null; if (p.maskUrl && !mi) return { img, x: r.x, y: r.y };
    const c = document.createElement("canvas"); c.width = r.w; c.height = r.h; const g = c.getContext("2d", { willReadFrequently: true }); if (!g) return { img, x: r.x, y: r.y };
    g.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    try { const d = g.getImageData(0, 0, r.w, r.h); let mask: Uint8ClampedArray | undefined;
      if (mi) { const mc = document.createElement("canvas"); mc.width = r.w; mc.height = r.h; const mg = mc.getContext("2d", { willReadFrequently: true })!; mg.drawImage(mi, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h); mask = mg.getImageData(0, 0, r.w, r.h).data; }
      tintPixels(d.data, mask, l); g.putImageData(d, 0, 0); } catch { /* tainted: untinted */ }
    if (this.tinted.size > 512) this.tinted.clear(); this.tinted.set(key, c); return { img: c, x: 0, y: 0 };
  }

  /** ADR-184: cached per-chunk shore tints (re-derived when this chunk or a neighbour changes). */
  private chunkTint(tm: TileMap, ch: Chunk): Float32Array {
    let st = ""; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const n = tm.getChunk(ch.cx + dx, ch.cy + dy); st += n ? n.version + "," : "x,"; }
    const hit = this.tintCache.get(ch); if (hit && hit.stamp === st) return hit.t;
    const t = new Float32Array(CHUNK_SIZE * CHUNK_SIZE); const at = (a: number, b: number): number => tm.getTile(a, b);
    for (let ly = 0; ly < CHUNK_SIZE; ly++) for (let lx = 0; lx < CHUNK_SIZE; lx++) t[ly * CHUNK_SIZE + lx] = waterShoreTint(at, ch.cx * CHUNK_SIZE + lx, ch.cy * CHUNK_SIZE + ly);
    this.tintCache.set(ch, { stamp: st, t }); return t;
  }
  /**
   * ADR-184: water as one image, 1 px per tile (land = full shore tint so the blend under sand is turquoise), drawn
   * through the iso affine with bilinear smoothing: a continuous shore->deep gradient instead of one fill per tile.
   */
  private drawWater(tm: TileMap, x0: number, y0: number, n: number): void {
    if (typeof document === "undefined") return;
    const cv = (this.waterCanvas ??= document.createElement("canvas")); if (cv.width !== n || cv.height !== n) { cv.width = n; cv.height = n; }
    const wg = cv.getContext("2d"); if (!wg) return; const img = wg.createImageData(n, n); const d = img.data; let any = false; const ice = this.sv.ice;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = x0 + i, y = y0 + j; const ch = tm.getChunk(Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE)); if (!ch) continue;
      const li = (((y % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE) * CHUNK_SIZE + (((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE); const id = ch.tiles[li]!;
      const k = isWaterId(id) ? (any = true, this.chunkTint(tm, ch)[li]!) : 1; const c = waterRgb(k); const o = (j * n + i) * 4;
      if (ice > 0) { // ADR-239 winter ice: shallow water freezes first, a few darker cracks
        const crack = ((x * 2654435761) ^ (y * 40503)) % 7 === 0 ? 0.82 : 1; const a = Math.min(1, ice * (0.75 + 0.25 * k)); const ic = [196 * crack, 220 * crack, 232 * crack];
        d[o] = c[0] + (ic[0]! - c[0]) * a; d[o + 1] = c[1] + (ic[1]! - c[1]) * a; d[o + 2] = c[2] + (ic[2]! - c[2]) * a;
      } else { d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; }
      d[o + 3] = 255;
    }
    if (!any) return; wg.putImageData(img, 0, 0);
    const g = this.ctx; const iso = this.camera.iso; const o = worldToScreen(x0 - 0.5, y0 - 0.5, 0, iso); // affine: rotates with the view
    const a = worldToScreen(x0 + 0.5, y0 - 0.5, 0, iso), b = worldToScreen(x0 - 0.5, y0 + 0.5, 0, iso);
    g.save(); g.transform(a.sx - o.sx, a.sy - o.sy, b.sx - o.sx, b.sy - o.sy, o.sx, o.sy); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    g.drawImage(cv, 0, 0); g.restore();
  }

  /** ADR-389: draw Art's waterfall frames when resident. Pools (then lips) paint over the dest/source
   *  water already drawn; sheets come last so the curtain sits in front and stacks with the pool foam. */
  private drawWaterfallArt(tm: TileMap, x0: number, y0: number, n: number, time: number): void {
    const reg = this.registry; if (!reg) return;
    if (this.waterfallArtOn === undefined) this.waterfallArtOn = allWaterfallArtKeys().some((k) => reg.ids.sprites.tryId(k) !== undefined);
    if (!this.waterfallArtOn) return;
    const has = (k: string): boolean => reg.ids.sprites.tryId(k) !== undefined;
    const g = this.ctx, iso = this.camera.iso, q = (iso.view ?? 0) & 3;
    const insts: ReturnType<typeof planWaterfallArt> = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) insts.push(...planWaterfallArt(tm, x0 + i, y0 + j, has, q));
    insts.sort((a, b) => (a.role === "pool" ? 0 : a.role === "lip" ? 1 : 2) - (b.role === "pool" ? 0 : b.role === "lip" ? 1 : 2));
    for (const inst of insts) {
      const id = reg.ids.sprites.tryId(inst.key); if (id === undefined) continue;
      let f; try { f = reg.dirFrame(id, WATERFALL_ANIM, 0, time); } catch { continue; }
      const img = this.image(f.atlas.key); if (!img) continue;
      const p = worldToScreen(inst.x + 0.5, inst.y + 0.5, inst.z, iso);
      g.save(); g.translate(p.sx, p.sy); if (inst.flipX) g.scale(-1, 1);
      g.drawImage(img, f.x, f.y, f.w, f.h, -f.anchorX, -f.anchorY, f.w, f.h); g.restore();
    }
  }

  // ---- ADR-246 gt_ ground art: cached B x B tile blocks (all layers baked once per season / chunk edit) ----
  private gArt: GroundArt | null = null; private gArtReg: AssetRegistry | undefined;
  /** ADR-389: cached "any waterfall sprite is in the pack"; undefined = not scanned yet. */
  private waterfallArtOn: boolean | undefined;
  private gBlocks = new Map<string, { cv: HTMLCanvasElement; stamp: string; used: number }>(); private gFrame = 0;
  /** false = flat legacy diamonds (tests / diag). */ groundArtEnabled = true;
  /** ADR-256: world-tile grazed lookup; undefined = ungrazed. */ grazedAt: ((tx: number, ty: number) => boolean) | undefined;
  /** ADR-256: bumped when the grazed set changes so gt blocks rebuild. */ grazedRev = 0;
  /** gt blocks drawn / built this frame (diag). */ groundStats = { blocks: 0, built: 0, cached: 0 };
  private groundArtOf(reg: AssetRegistry): GroundArt | null {
    if (this.gArtReg !== reg) { this.gArtReg = reg; const g = new GroundArt(reg); this.gArt = g.available ? g : null; this.gBlocks.clear(); this.waterfallArtOn = undefined; }
    return this.gArt;
  }
  /** One baked block (null = an art page is still loading or no DOM). Back-to-front so skirts sit under front cells. */
  private gtBlock(tm: TileMap, reg: AssetRegistry, ga: GroundArt, bx: number, by: number, season: number, build: boolean, q = 0): HTMLCanvasElement | null {
    // ADR-253: (bx, by) and the cells below are VIEW indices (U, V) of quarter q; tile (x, y) sits at view point toView(x, y)
    // (C2D centres tile (x, y) on the point (x, y)), so view index -> world tile = fromView. q = 0 is unchanged.
    const B = GT_BLOCK, x0 = bx * B, y0 = by * B; let st = `${season}:g${this.grazedRev | 0}`; // ADR-256
    const ca = fromView(x0 - 1, y0 - 1, q), cb = fromView(x0 + B, y0 + B, q); // world tile bounds of the block (+1 ring)
    const wx0 = Math.min(ca.x, cb.x), wx1 = Math.max(ca.x, cb.x), wy0 = Math.min(ca.y, cb.y), wy1 = Math.max(ca.y, cb.y);
    for (let cy = Math.floor(wy0 / CHUNK_SIZE); cy <= Math.floor(wy1 / CHUNK_SIZE); cy++) for (let cx = Math.floor(wx0 / CHUNK_SIZE); cx <= Math.floor(wx1 / CHUNK_SIZE); cx++) { const n = tm.getChunk(cx, cy); st += n ? `,${n.version}` : ",x"; }
    const k = `${q}:${bx},${by}`; const hit = this.gBlocks.get(k); if (hit && hit.stamp === st) { hit.used = this.gFrame; return hit.cv; }
    if (!build || typeof document === "undefined") return hit?.cv ?? null; // stale block until rebuilt (no flash)
    const at = q === 0 ? (a: number, b: number): number => tm.getTile(a, b) : (a: number, b: number): number => { const w = fromView(a, b, q); return tm.getTile(w.x, w.y); };
    const L: GroundLayer[] = [];
    const ops: { img: CanvasImageSource; f: { x: number; y: number; w: number; h: number; anchorX: number; anchorY: number }; dx: number; dy: number }[] = [];
    for (let d = 0; d <= 2 * (B - 1); d++) for (let lx = Math.max(0, d - B + 1); lx <= Math.min(B - 1, d); lx++) {
      const x = x0 + lx, y = y0 + d - lx; if (!at(x, y)) continue;
      const w = q === 0 ? null : fromView(x, y, q);
      const grazed = this.grazedAt ? (a: number, b: number): boolean => { const ww = q === 0 ? { x: a, y: b } : fromView(a, b, q); return this.grazedAt!(ww.x, ww.y); } : undefined;
      groundLayers(at, x, y, season, (a, b) => waterShoreTint(at, a, b), L, w ? groundHash(w.x, w.y) : undefined, grazed);
      for (const l of L) { if (l.kind === GroundLayerKind.Water) continue; /* tinted by the drawWater gradient underneath (the grey detail art needs the GPU tint) */ const id = ga.id(l.key); if (id < 0) continue; let f; try { f = reg.dirFrame(id, "idle", 0, 0); } catch { continue; }
        const img = this.image(f.atlas.key); if (!img) return hit?.cv ?? null; ops.push({ img, f, dx: (lx - (d - lx)) * 32 + GT_OX, dy: d * 16 + GT_OY }); }
    }
    const cv = hit?.cv ?? document.createElement("canvas"); cv.width = GT_W; cv.height = GT_H; const g = cv.getContext("2d"); if (!g) return null;
    g.clearRect(0, 0, GT_W, GT_H); for (const o of ops) g.drawImage(o.img, o.f.x, o.f.y, o.f.w, o.f.h, o.dx - o.f.anchorX, o.dy - o.f.anchorY, o.f.w, o.f.h);
    this.gBlocks.set(k, { cv, stamp: st, used: this.gFrame }); this.groundStats.built++; return cv;
  }
  /** Draws the visible gt blocks (iso order); blocks not baked yet fall back to flat diamonds. Returns false = no gt art. */
  private drawGroundArt(tm: TileMap, reg: AssetRegistry, cx: number, cy: number, R: number, s: number, ox: number, oy: number, stats: FrameStats): boolean {
    const ga = this.groundArtEnabled ? this.groundArtOf(reg) : null; if (!ga) return false;
    const g = this.ctx, B = GT_BLOCK, season = Math.max(0, Math.min(2, this.sv.art | 0)); this.gFrame++; this.groundStats = { blocks: 0, built: 0, cached: this.gBlocks.size };
    const vx0 = -ox / s, vx1 = (this.w - ox) / s, vy0 = -oy / s, vy1 = (this.h - oy) / s; let budget = GT_BUILDS_PER_FRAME;
    const q = this.camera.view; const cv0 = toView(cx, cy, q); cx = cv0.u; cy = cv0.v; // ADR-253: view indices
    const bx0 = Math.floor((cx - R) / B), bx1 = Math.floor((cx + R) / B), by0 = Math.floor((cy - R) / B), by1 = Math.floor((cy + R) / B);
    for (let d = bx0 + by0; d <= bx1 + by1; d++) for (let bx = Math.max(bx0, d - by1); bx <= Math.min(bx1, d - by0); bx++) {
      const by = d - bx; const sx = (bx - by) * B * 32 - GT_OX, sy = (bx + by) * B * 16 - GT_OY; // block canvas origin (world px)
      if (sx > vx1 || sx + GT_W < vx0 || sy > vy1 || sy + GT_H < vy0) continue;
      { const w0 = fromView(bx * B, by * B, q), w1 = fromView(bx * B + B - 1, by * B + B - 1, q); // any chunk under the block
        if (!tm.getChunk(Math.floor(w0.x / CHUNK_SIZE), Math.floor(w0.y / CHUNK_SIZE)) && !tm.getChunk(Math.floor(w1.x / CHUNK_SIZE), Math.floor(w1.y / CHUNK_SIZE))) continue; }
      const nb = this.groundStats.built; const cv = this.gtBlock(tm, reg, ga, bx, by, season, budget > 0, q); if (this.groundStats.built > nb) budget--;
      if (cv) { g.drawImage(cv, sx, sy); stats.drawCalls++; this.groundStats.blocks++; stats.tiles += B * B; continue; }
      this.flatTiles(tm, bx * B, by * B, B, stats, q); // still loading / over budget: flat diamonds
    }
    const cap = Math.max(48, this.groundStats.blocks + 24); // LRU: drop the least recently drawn blocks
    if (this.gBlocks.size > cap) { const old = [...this.gBlocks.entries()].sort((a, b) => a[1].used - b[1].used); for (let i = 0; i < old.length - cap; i++) this.gBlocks.delete(old[i]![0]); }
    return true;
  }
  private wvfx = new VfxLayer(); readonly weatherFx = new WeatherFx();
  private drawWeatherFx(world: World, reg: AssetRegistry, kind: number, wt: { snow: number; wind: number }, daylight: number, time: number, s: number, ox: number, oy: number, stats: FrameStats): void {
    const dt = Math.max(0, Math.min(0.1, time - this.wvfx.now)); this.wvfx.update(time); this.weatherFx.scale = 0.5;
    const w = readWind(world); const wv = Math.min(2, (w.speed > 0 ? w.speed : DEFAULT_STYLE.wind.defaultSpeed * (1 + 3 * wt.wind)) / Math.max(0.1, DEFAULT_STYLE.wind.refSpeed)); const dir = w.speed > 0 ? w.dir : DEFAULT_STYLE.wind.defaultDir;
    const iso = this.camera.iso, hw = iso.tileW / 2, hh = iso.tileH / 2; const sx0 = -ox / s, sx1 = (this.w - ox) / s, sy0 = -oy / s, sy1 = (this.h - oy) / s;
    const t = (a: number, b: number): [number, number] => { const w = fromView((a / hw + b / hh) / 2, (b / hh - a / hw) / 2, iso.view ?? 0); return [w.x, w.y]; }; const A = t(sx0, sy0), B = t(sx1, sy0), C = t(sx0, sy1), D = t(sx1, sy1);
    this.weatherFx.update(this.wvfx, (k) => reg.ids.sprites.tryId(k), kind, wt, daylight, { x: Math.cos(dir) * wv, y: Math.sin(dir) * wv },
      { x0: Math.min(A[0], B[0], C[0], D[0]), x1: Math.max(A[0], B[0], C[0], D[0]), y0: Math.min(A[1], B[1], C[1], D[1]), y1: Math.max(A[1], B[1], C[1], D[1]), tiles: ((sx1 - sx0) * (sy1 - sy0)) / (2 * hw * hh) }, dt);
    const g = this.ctx;
    for (const v of this.wvfx.active) {
      const age = time - v.born; let f; try { f = reg.dirFrame(v.spriteId, "idle", 0, age); } catch { continue; } const img = this.image(f.atlas.key); if (!img) continue;
      const p = worldToScreen(v.x, v.y, v.z, iso); const k = v.scale; g.globalAlpha = Math.max(0, Math.min(1, v.alpha * (v.fade ? 1 - age / v.lifetime : 1)));
      g.drawImage(img, f.x, f.y, f.w, f.h, p.sx - f.anchorX * k, p.sy - f.anchorY * k, f.w * k, f.h * k); stats.drawCalls++;
    }
    g.globalAlpha = 1;
  }
  /** Legacy flat land diamonds for an n x n tile square (water: the gradient image below). */
  private flatTiles(tm: TileMap, x0: number, y0: number, n: number, stats: FrameStats, q = 0): void { // (x0, y0): view indices
    const g = this.ctx, tw = DEFAULT_ISO.tileW, th = DEFAULT_ISO.tileH;
    for (let y = y0; y < y0 + n; y++) for (let x = x0; x < x0 + n; x++) {
      const w = fromView(x, y, q); const t = tm.getTile(w.x, w.y); if (!t || isWaterId(t)) { if (t) stats.tiles++; continue; }
      const p = worldToScreen(x, y, 0, DEFAULT_ISO); g.fillStyle = this.groundColor(t, w.x, w.y);
      g.beginPath(); g.moveTo(p.sx, p.sy - th / 2); g.lineTo(p.sx + tw / 2, p.sy); g.lineTo(p.sx, p.sy + th / 2); g.lineTo(p.sx - tw / 2, p.sy); g.fill(); stats.tiles++;
    }
  }

  // ---- ADR-239 seasons (CPU mirror of the WebGL2 shader pass, quantised so the recoloured frames cache) ----
  private sv: SeasonVisual = SUMMER_VISUAL; private seasonArt: SeasonArt | undefined; private seasonArtReg: AssetRegistry | undefined;
  private seasonCache = new Map<string, HTMLCanvasElement | null>(); private seasonBuilds = 0;
  /** Frames recoloured per frame at most (the rest draw plain until the next frame): no hitch when the season turns. */
  static SEASON_BUILDS_PER_FRAME = 24; static SEASON_CACHE_MAX = 900;
  private seasonPick(reg: AssetRegistry, sid: number): { sid: number; flags: number } {
    if (this.seasonArtReg !== reg) { this.seasonArt = new SeasonArt(reg); this.seasonArtReg = reg; }
    return this.seasonArt!.resolve(sid, this.sv);
  }
  /** Recoloured copy of one frame (fall palette / bare winter / snow caps) or null (summer, budget, tainted image). */
  private seasonFrame(img: CanvasImageSource, f: { atlas: { key: string }; x: number; y: number; w: number; h: number }, flags: number, seed: number, salt = ""): HTMLCanvasElement | null {
    const sv = this.sv; if (!flags || typeof document === "undefined" || f.w <= 0 || f.h <= 0) return null;
    const qf = Math.round(sv.fall * 8), qw = Math.round(sv.winter * 8), qs = Math.round(Math.min(1, sv.snow * 1.15) * 8); if (qf + qw === 0) return null;
    const b = seed % 3, key = `${f.atlas.key}|${f.x},${f.y},${f.w},${f.h}|${flags}|${b}|${qf},${qw},${qs}|${salt}`;
    const hit = this.seasonCache.get(key); if (hit !== undefined) return hit;
    if (this.seasonBuilds >= Canvas2DRenderer.SEASON_BUILDS_PER_FRAME) return null; this.seasonBuilds++;
    if (this.seasonCache.size >= Canvas2DRenderer.SEASON_CACHE_MAX) this.seasonCache.clear();
    let out: HTMLCanvasElement | null = document.createElement("canvas"); out.width = f.w; out.height = f.h;
    try { const g = out.getContext("2d", { willReadFrequently: true })!; g.drawImage(img, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
      const d = g.getImageData(0, 0, f.w, f.h); seasonSpritePixels(d.data, f.w, f.h, flags, [0.03, 0.08, 0.125][b]!, qf / 8, qw / 8, qs / 8); g.putImageData(d, 0, 0); } catch { out = null; }
    this.seasonCache.set(key, out); return out;
  }
  private groundCache = new Map<string, string>();
  /** Season-recoloured ground diamond colour (2 noise variants per tile type), snow blanket + quantised like the frames. */
  private groundColor(t: number, x: number, y: number): string {
    const base = TILE_COLORS[t % TILE_COLORS.length]!; const sv = this.sv; if (sv.fall + sv.winter < 0.01) return base;
    const v = ((x * 73856093) ^ (y * 19349663)) & 1, qf = Math.round(sv.fall * 16), qw = Math.round(sv.winter * 16), qs = Math.round(sv.snow * 16);
    const key = `${t}|${v}|${qf}|${qw}|${qs}`; let c = this.groundCache.get(key); if (c) return c;
    const h = parseInt(base.slice(1), 16); const rgb = [(h >> 16 & 255) / 255, (h >> 8 & 255) / 255, (h & 255) / 255];
    let [r, g, b] = seasonGroundRgb(rgb, qf / 16, qw / 16, v ? 0.7 : 0.3); const sn = (qs / 16) * (t === 5 ? 0.6 : 0.92); // bare rock holds less snow
    r += (0.9 - r) * sn; g += (0.93 - g) * sn; b += (0.98 - b) * sn;
    c = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`; if (this.groundCache.size > 512) this.groundCache.clear(); this.groundCache.set(key, c); return c;
  }

  private decks = new DeckNeighbors();
  /** ADR-197: building pieces as painter items: level-major, decks under their floor's uprights, iso order, unique tie-break. */
  gatherPieces(world: World, reg: AssetRegistry, time = this.clock): C2DPiece[] {
    const bpd = this.bindings.buildPiece; if (!bpd || !world.isRegistered(bpd)) return [];
    const iso = this.camera.iso; const hw = iso.tileW / 2, hh = iso.tileH / 2; const q = (iso.view ?? 0) & 3; const raw: { e: Entity; ax: number; ay: number; fw: number; fh: number; level: number; layer: number; z: number; vis: number; rot: number; dmg: number; ghost: boolean; deck: boolean; top: number | undefined; px: number; py: number; tint: number }[] = [];
    this.decks.clear();
    for (const e of world.query([bpd, Transform])) {
      const b = world.get(e, bpd)!; const t = world.get(e, Transform)!; let sd; try { sd = reg.sprite(b.visualId); } catch { continue; } if (!sd.building) continue;
      const rot = b.rotation & 3; const fw = rot & 1 ? sd.building.footprint.h : sd.building.footprint.w, fh = rot & 1 ? sd.building.footprint.w : sd.building.footprint.h;
      const roof = (sd.building.piece ?? sd.key).startsWith("roof"); const deck = b.layer === 0 && !roof; const top = deck ? deckTopPx(sd.key) : undefined;
      const r = { e, ax: Math.floor(t.x), ay: Math.floor(t.y), fw, fh, level: b.level, layer: b.layer, z: floorToTerrainZ(b.level, t.z), vis: b.visualId, rot: b.rotation, dmg: b.damageStage, ghost: b.ghost > 0, deck, top, px: t.x, py: t.y, tint: (b as { tint?: number }).tint ?? 0 };
      raw.push(r); if (deck && !r.ghost && top !== undefined) this.decks.add(r.ax, r.ay, fw, fh, r.level, top);
      // ADR-211: an L corner = its tier's straight wall on both arm edges (same pivots/flags as an edge wall) + the post art
      const armKey = lCornerArmPiece(sd.building.piece); const arm = armKey ? reg.spriteForPiece(armKey) : undefined;
      if (arm !== undefined) { let ad; try { ad = reg.sprite(arm); } catch { ad = undefined; }
        if (ad?.building) for (const a of lCornerArmPivots(t.x, t.y, b.rotation)) {
          const afw = a.rot & 1 ? ad.building.footprint.h : ad.building.footprint.w, afh = a.rot & 1 ? ad.building.footprint.w : ad.building.footprint.h;
          raw.push({ ...r, ax: Math.floor(a.x), ay: Math.floor(a.y), fw: afw, fh: afh, layer: 1, vis: arm, rot: a.rot | ROT_EXACT_PIVOT | ROT_DECK_LIFT, deck: false, top: undefined, px: a.x, py: a.y });
        } }
    }
    const out: C2DPiece[] = [];
    for (const r of raw) {
      // ADR-218: piece state (bonfire "unlit") + lit fires play their idle flame loop on the render clock (per-entity phase)
      const fire = this.bindings.pieceLit?.(r.e); const pst = this.bindings.pieceState?.(r.e) ?? -1;
      const spk = r.ghost ? { sid: r.vis, flags: 0 } : this.seasonPick(reg, r.vis); // ADR-239: <key>_<season> piece art, else procedural
      const ar = (r.rot + q) & 3; // ADR-253: the art row seen from this view
      let f; try { f = pieceFireFrame(reg, spk.sid, ar, r.dmg, pst, fire, r.ghost, time, entityIndex(r.e)); } catch { try { f = pieceFireFrame(reg, r.vis, ar, r.dmg, pst, fire, r.ghost, time, entityIndex(r.e)); } catch { continue; } } let img: CanvasImageSource | null = this.image(f.atlas.key); if (!img) continue;
      if (!r.ghost && this.bindings.pieceSwing && r.vis === world.get(r.e, bpd)?.visualId) { // ADR-314: a swinging door draws its swing step once that atlas image is loaded
        const sw = this.bindings.pieceSwing?.(r.e, time);
        if (sw) { try { const sf = reg.buildingFrame(sw.vis, ar, r.dmg, sw.state); const si = this.image(sf.atlas.key); if (si) { f = sf; img = si; } } catch { /* no swing art */ } }
      }
      const f0 = f; let tintSalt = "";
      { // ADR-230: clan tint through the atlas tintmask (R primary, G secondary), as the WebGL2 shader does
        const tp = r.ghost ? undefined : this.bindings.pieceTints?.(r.e) ?? (r.tint ? [r.tint >>> 0, 0] as const : undefined);
        if (tp && tp[0]) { const ti = this.tintedPiece(img, f, tp[0], tp[1]); if (ti) { img = ti; f = { ...f, x: 0, y: 0 }; tintSalt = `${tp[0]},${tp[1]}`; } } }
      if (spk.flags) { const sc = this.seasonFrame(img, { ...f, atlas: f0.atlas, x: f.x, y: f.y }, spk.flags, entityIndex(r.e), tintSalt ? `${f0.x},${f0.y}|${tintSalt}` : ""); if (sc) { img = sc; f = { ...f, x: 0, y: 0 }; } }
      // ADR-210: exact pivot (edge midpoint / vertex / tri centroid) and deck-top lift, mirroring the WebGL2 path
      const exact = (r.rot & ROT_EXACT_PIVOT) !== 0; const pvx = exact ? r.px : r.ax + r.fw / 2, pvy = exact ? r.py : r.ay + r.fh / 2;
      const lift = r.rot & ROT_DECK_LIFT ? (exact ? this.decks.topNear(pvx, pvy, r.level) : this.decks.topOver(r.ax, r.ay, r.fw, r.fh, r.level)) : 0;
      const p0 = worldToScreen(pvx, pvy, r.z, iso); const p = { sx: p0.sx, sy: p0.sy - lift };
      // ADR-253: depth / tie-breaks / deck sides from the VIEW footprint and pivot (decks.mask stays in world tiles)
      const vr = viewRect(r.ax, r.ay, r.fw, r.fh, q); const pv = toView(pvx, pvy, q);
      const mask = r.top === undefined || exact ? 0 : rotSideMask(this.decks.mask(r.ax, r.ay, r.fw, r.fh, r.level, r.top), q);
      const isoD = (exact ? pv.u + pv.v - 1 : vr.x + vr.w - 1 + vr.y + vr.h - 1) + r.layer * 0.01 + (exact ? exactTieBreak(pv.u, pv.v, r.ghost) : pieceTieBreak(vr.x, vr.y, r.ghost)) + (r.rot & ROT_VERTEX_POST ? VERTEX_POST_BIAS : 0);
      out.push({ e: r.e, sx: p.sx, sy: p.sy, depth: r.level * LEVEL_DEPTH + (r.deck ? DECK_DEPTH : 0) + isoD, ord: pieceOrder(r.level, r.layer, vr.x, vr.y) * 2 + (r.ghost ? 1 : 0), img, f,
        clip: mask ? deckClipPolygon(vr.w, vr.h, mask, r.top!, hw, hh) : undefined, seams: mask ? deckSeamPatches(vr.w, vr.h, mask, r.top!, hw, hh) : undefined, ghost: r.ghost, hearth: fire === 2 && !r.ghost && r.dmg === 0, scale: this.bindings.pieceScale?.(r.e) ?? 1 });
    }
    return out;
  }
  private hearthBuf: HearthParticle[] = [];
  /** ADR-218: stateless embers (additive) + smoke puffs over a lit hearth (Canvas2D has no particle layer). */
  private drawHearth(sx: number, sy: number, time: number, seed: number, s: number, ox: number, oy: number, sc = 1): void {
    const g = this.ctx; const ps = hearthParticles(time, seed, 9, DEFAULT_ISO.tileW * sc, this.hearthBuf);
    g.save(); g.translate(snapPx(sx, s, ox), snapPx(sy, s, oy));
    for (const p of ps) {
      if (p.alpha <= 0.01) continue;
      g.globalCompositeOperation = p.ember ? "lighter" : "source-over"; g.globalAlpha = Math.min(1, p.alpha);
      g.fillStyle = p.ember ? "rgb(255,170,60)" : "rgb(120,116,110)";
      g.beginPath(); g.arc(p.dx, p.dy, p.size, 0, Math.PI * 2); g.fill(); this.stats.drawCalls++;
    }
    g.restore();
  }
  private drawPiece(pc: C2DPiece, s: number, ox: number, oy: number): void {
    const g = this.ctx; const f = pc.f; g.save(); g.translate(snapPx(pc.sx, s, ox), snapPx(pc.sy, s, oy));
    if (pc.clip) { g.beginPath(); pc.clip.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.clip(); }
    if (pc.ghost) g.globalAlpha = 0.6;
    if (pc.scale !== 1) g.scale(pc.scale, pc.scale); // ADR-227: about the pivot
    if (f.flipX) g.scale(-1, 1);
    g.drawImage(pc.img, f.x, f.y, f.w, f.h, -f.anchorX, -f.anchorY, f.w, f.h); g.restore(); this.stats.sprites++; this.stats.drawCalls++;
    if (pc.seams) for (const sp of pc.seams) { // ADR-210 connected top: closed-side border bands repainted from the interior
      g.save(); g.translate(snapPx(pc.sx, s, ox), snapPx(pc.sy, s, oy));
      g.beginPath(); sp.poly.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.clip();
      if (pc.ghost) g.globalAlpha = 0.6;
      g.translate(-sp.dx, -sp.dy); if (f.flipX) g.scale(-1, 1);
      g.drawImage(pc.img, f.x, f.y, f.w, f.h, -f.anchorX, -f.anchorY, f.w, f.h); g.restore(); this.stats.drawCalls++;
    }
  }

  completeFrames = 0;
  render(world: World, alpha: number): void {
    const g = this.ctx, cam = this.camera, s = cam.scale; const stats = (this.stats = newStats());
    const nowMs = performance.now(); if (this.clockAt >= 0) this.clock += Math.min(0.1, (nowMs - this.clockAt) / 1000) * (this.timeScale > 0 ? Math.min(1, this.timeScale) : 1); this.clockAt = nowMs; const time = this.clock; const wr = readWeather(world), wt = weatherTargets(wr.kind, wr.intensity); // ADR-115: same curve + weather dimming as WebGL2 (no smoothing state: cheap)
    const day = undergroundInto(dimForWeather(computeDayLighting(readDayFraction(world), readDayNumber(world)), { overcast: Math.max(wt.rain, wt.fog, wt.snow * 0.7), storm: wt.storm }), this.underground); // ADR-263
    this.sv = seasonVisual(world); this.seasonBuilds = 0; // ADR-239
    this.syncGrazedBinding(world); // ADR-256
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = "source-over"; g.globalAlpha = 1;
    g.fillStyle = rgb(day.sky); g.fillRect(0, 0, this.w, this.h);
    const ox = Math.round(this.w / 2 - cam.x * s), oy = Math.round(this.h / 2 - cam.y * s); g.setTransform(s, 0, 0, s, ox, oy); g.imageSmoothingEnabled = s < 1; // ADR-197: whole-pixel camera origin
    const iso = this.camera.iso; const tw = iso.tileW, th = iso.tileH; const vq = (iso.view ?? 0) & 3, vFace = vq * (Math.PI / 2);
    // terrain: diamonds around the camera
    const tm = this.tilemap; const c = cam.cssToWorld(cam.viewW / cam.dpr / 2, cam.viewH / cam.dpr / 2);
    const R = Math.ceil(Math.max(this.w, this.h) / (s * th)) + 2;
    if (tm) this.drawWater(tm, Math.floor(c.x) - R, Math.floor(c.y) - R, 2 * R + 1); // ADR-184: smooth gradient under the land diamonds
    if (tm && !(this.registry && this.drawGroundArt(tm, this.registry, Math.floor(c.x), Math.floor(c.y), R, s, ox, oy, stats))) for (let y = Math.floor(c.y) - R; y < c.y + R; y++) for (let x = Math.floor(c.x) - R; x < c.x + R; x++) {
      let t = tm.getTile(x, y); if (!t && !tm.getChunk(Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE))) continue;
      if (isWaterId(t)) { stats.tiles++; continue; }
      const p = worldToScreen(x, y, 0, iso); g.fillStyle = this.groundColor(t, x, y); // ADR-239 season tint
      g.beginPath(); g.moveTo(p.sx, p.sy - th / 2); g.lineTo(p.sx + tw / 2, p.sy); g.lineTo(p.sx, p.sy + th / 2); g.lineTo(p.sx - tw / 2, p.sy); g.fill(); stats.tiles++;
    }
    if (tm) this.drawWaterfallArt(tm, Math.floor(c.x) - R, Math.floor(c.y) - R, 2 * R + 1, time); // ADR-389: art hook after ground (no-op without frames)
    // sprites: gather, sort by iso depth (screen y of the foot), draw
    const reg = this.registry; const items: { e: Entity; sx: number; sy: number; depth: number; ord: number; pc?: C2DPiece }[] = [];
    if (reg && world.isRegistered(Sprite)) for (const e of world.query([Transform, Sprite])) {
      const cur = world.get(e, Transform)!; const prev = world.get(e, PrevTransform) ?? cur;
      const x = prev.x + (cur.x - prev.x) * alpha, y = prev.y + (cur.y - prev.y) * alpha, z = prev.z + (cur.z - prev.z) * alpha;
      const p = worldToScreen(x, y, z, iso); const flat = (world.get(e, Sprite)!.flags & SpriteFlag.Flat) !== 0;
      const lvl = z >= FLOOR_Z - 1e-6 ? terrainZToFloor(z, 0) : 0;
      const bed = this.bindings.bedFit?.(e) ? BED_SORT_EPS : 0; // ADR-244 (c): a lying sleeper sorts just after its bed (as WebGL)
      const vp = vq ? toView(x, y, vq) : null; // ADR-253: depth along the view axes
      items.push({ e, sx: p.sx, sy: p.sy, depth: lvl * LEVEL_DEPTH + flatSortDepth(vp ? vp.u + vp.v : x + y, flat) + bed, ord: 1e15 + e });
    }
    if (reg) for (const pc of this.gatherPieces(world, reg)) items.push({ e: pc.e, sx: pc.sx, sy: pc.sy, depth: pc.depth, ord: pc.ord, pc });
    items.sort((a, b) => (a.depth - b.depth) || (a.ord - b.ord)); // ADR-197: total order (no equal-key coin flips) // Flat ground decals (roads) first: always under feet and entities
    const an = this.bindings.animState; const tick = world.tick;
    for (const it of items) {
      if (it.pc) { this.drawPiece(it.pc, s, ox, oy); if (it.pc.hearth) this.drawHearth(it.pc.sx, it.pc.sy, time, entityIndex(it.e), s, ox, oy, it.pc.scale); continue; }
      const sp = world.get(it.e, Sprite)!; if (sp.scale > 0 && sp.scale < 0.01) continue;
      let anim = "idle"; let tAnim = time;
      const fa = frameAnim(sp.frameId); if (fa >= 0) { try { anim = reg!.sprite(sp.spriteId).animList[fa]?.name ?? "idle"; } catch { /* unknown sprite */ } tAnim = 0; }
      if (an && world.has(it.e, an)) { const a = world.get(it.e, an)!; const names = this.bindings.animChain?.(it.e, a.state, Math.max(0, (tick - a.startTick) / 20)) ?? STATE_ANIMS[a.state] ?? ["idle"]; /* ADR-241 per-entity chain */ let def; try { def = reg!.sprite(this.dollBodySprite(world, it.e, sp.spriteId)); } catch { def = undefined; }
        anim = names.find((n) => def?.animations.has(n)) ?? "idle"; tAnim = Math.max(0, (tick - a.startTick) / 20) * (this.bindings.animRate?.(it.e, a.state) ?? 1); }
      // ADR-218: a lit fire sprite (station bonfire) loops its flame at its own phase, with embers + smoke
      const litB = this.bindings.lit; let hearth = false;
      if (fa < 0 && !(an && world.has(it.e, an)) && litB && world.isRegistered(litB) && world.has(it.e, litB) && (world.get(it.e, litB) as { lit?: number }).lit) {
        let def; try { def = reg!.sprite(sp.spriteId); } catch { def = undefined; }
        if (def && isFireAnim(def)) { anim = "idle"; tAnim = fireAnimTime(time, entityIndex(it.e)); hearth = true; }
      }
      const facing = world.get(it.e, Transform)!.facing + vFace; const k = sp.scale || 1; // ADR-253: art facing = world facing + view
      // ADR-134 flinch: brief brightness flash + tilt about the foot (same bindings as WebGL's hitFlash)
      const hf = this.bindings.hitFlash?.(it.e) ?? 0; const tilt = this.bindings.hitTilt?.(it.e) ?? 0;
      const fx = (): void => { if (tilt) g.rotate(tilt); if (hf > 0) g.filter = `brightness(${(1 + 2.5 * Math.min(1, hf)).toFixed(2)})`; };
      // paper doll (same layer list + per-frame anchors as the creator's 2D preview; head layers follow the body's head anchor)
      const apB = this.bindings.appearance; const look = apB && world.has(it.e, apB.def) ? getAppearance(world, it.e) : undefined;
      if (look && apB) {
        let ls: PreviewLayer2D[] = []; try { ls = previewLayers2D(reg!, apB.mapLayers ? { ...apB, resolve: (a, fa, o) => apB.mapLayers!(it.e, apB.resolve(a, fa, o)) } : apB, look, 0, tAnim, this.sources, anim, facing); } catch { ls = []; }
        if (ls.length) {
          // ADR-244 (c): sleep_lie* frames put their pivot on the bed footprint centre + bedFits offset (WebGL: sprites.ts)
          const bf = anim.startsWith("sleep_lie") ? this.bindings.bedFit?.(it.e) : undefined; const bx = (bf?.x ?? 0) * k, by = (bf?.y ?? 0) * k;
          for (const p of ls) { const li = this.layerImage(p); if (!li) continue; const r = p.ref;
            g.save(); g.translate(snapPx(it.sx + bx, s, ox), snapPx(it.sy + by, s, oy)); fx(); if (r.flipX) g.scale(-1, 1);
            g.drawImage(li.img, li.x, li.y, r.w, r.h, (p.dx - r.anchorX) * k, (p.dy - r.anchorY) * k, r.w * k, r.h * k); g.restore(); stats.drawCalls++; }
          stats.sprites++; continue;
        }
      }
      const flatS = (sp.flags & SpriteFlag.Flat) !== 0; const spk = this.seasonPick(reg!, sp.spriteId); // ADR-239: <key>_<season> art first
      let f; try { f = reg!.dirFrame(spk.sid, anim, facing, tAnim); } catch { try { f = reg!.dirFrame(sp.spriteId, anim, facing, tAnim); } catch { continue; } }
      let img: CanvasImageSource | null = this.image(f.atlas.key); if (!img) continue;
      if ((vq & 1) && !spriteIsDirectional(reg!, spk.sid)) f = { ...f, flipX: !f.flipX }; // ADR-253 fallback: mirror single-facing art
      const sFl = flatS ? (spk.sid === sp.spriteId && this.sv.fall + this.sv.winter > 0.002 ? SEASON_GROUND : 0) : spk.flags; // ADR-246: seasonal roads
      if (sFl) { const sc = this.seasonFrame(img, f, sFl, entityIndex(it.e)); if (sc) { img = sc; f = { ...f, x: 0, y: 0 }; } }
      const dw = f.w * k, dh = f.h * k;
      const sAl = world.isRegistered(SpriteAlpha) ? world.getField(it.e, SpriteAlpha, "alpha") : undefined; // ADR-238 despawn fade
      if (sAl !== undefined && sAl <= 0.01) continue;
      g.save(); g.translate(snapPx(it.sx, s, ox), snapPx(it.sy, s, oy)); fx(); if (f.flipX) g.scale(-1, 1); if (sAl !== undefined) g.globalAlpha = Math.min(1, sAl);
      g.drawImage(img, f.x, f.y, f.w, f.h, -f.anchorX * k, -f.anchorY * k, dw, dh); g.restore(); stats.sprites++; stats.drawCalls++;
      if (hearth) this.drawHearth(it.sx, it.sy, time, entityIndex(it.e), s, ox, oy, k);
    }
    // ADR-246: weather sprites (same spawner as WebGL2, half the rate), over the scene and under the lightmap
    if (reg) this.drawWeatherFx(world, reg, wr.kind, wt, day.daylight, time, s, ox, oy, stats);
    // ADR-216: real lightmap (ambient + additive iso light ellipses) multiplied onto the scene, like the WebGL LightPass
    g.setTransform(1, 0, 0, 1, 0, 0);
    const a = day.ambient;
    if (a[0] + a[1] + a[2] < 2.9) {
      const lights: C2DLight[] = [];
      if (this.settings.lights && world.isRegistered(LightSource)) for (const e of world.query([Transform, LightSource])) {
        const L = world.get(e, LightSource)!; if (!(L.intensity > 0) || !(L.radius > 0)) continue; const t = world.get(e, Transform)!; const p = worldToScreen(t.x, t.y, t.z, iso);
        lights.push({ sx: p.sx, sy: p.sy, r: lightRadiusPx(L.radius, tw), color: [L.r, L.g, L.b], intensity: L.intensity, flicker: L.flicker });
      }
      stats.lights = lights.length;
      this.lightmap.apply(g, this.w, this.h, { s, ox: this.w / 2 - cam.x * s, oy: this.h / 2 - cam.y * s }, a, C2D_DAYLIGHT_LIGHT_SCALE + (1 - C2D_DAYLIGHT_LIGHT_SCALE) * day.glow, time, lights);
    }
    g.globalCompositeOperation = "source-over"; void this.focus;
    this.completeFrames++;
  }
}
const FLOOR_Z = floorToTerrainZ(1, 0);
/** ADR-246 Canvas2D gt blocks: B x B tiles per cached canvas (cell 68x52, centre at frame px 34, 18). */
export const GT_BLOCK = 8; const GT_OX = (GT_BLOCK - 1) * 32 + 34, GT_OY = 18;
const GT_W = (2 * GT_BLOCK - 2) * 32 + 68, GT_H = (2 * GT_BLOCK - 2) * 16 + 52; const GT_BUILDS_PER_FRAME = 4;
const C2D_DAYLIGHT_LIGHT_SCALE = DEFAULT_STYLE.daylightLightScale;
/** Painter layers: everything on floor N draws after floor N-1; decks draw below the uprights of their own floor. */
const LEVEL_DEPTH = 1e6, DECK_DEPTH = -5e5;
/**
 * ADR-230: the WebGL2 two-tone tintmask multiply on the CPU: rgb *= mix(1, primary, mask.r) * mix(1, secondary || primary, mask.g).
 * primary / secondary are RGBA8 (0xRRGGBBAA, as Sprite.tint / pieceTints); secondary 0 = reuse the primary.
 */
export function tintPiecePixels(px: Uint8ClampedArray, mask: Uint8ClampedArray, primary: number, secondary: number): void {
  const p = [(primary >>> 24) & 255, (primary >>> 16) & 255, (primary >>> 8) & 255].map((v) => v / 255) as [number, number, number];
  const s2 = secondary >>> 8 ? secondary : primary; const q = [(s2 >>> 24) & 255, (s2 >>> 16) & 255, (s2 >>> 8) & 255].map((v) => v / 255) as [number, number, number];
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue; const mr = mask[i]! / 255, mg = mask[i + 1]! / 255; if (mr === 0 && mg === 0) continue;
    for (let c = 0; c < 3; c++) px[i + c] = px[i + c]! * (1 + (p[c]! - 1) * mr) * (1 + (q[c]! - 1) * mg);
  }
}
interface C2DPiece { e: Entity; sx: number; sy: number; depth: number; ord: number; img: CanvasImageSource; f: { x: number; y: number; w: number; h: number; anchorX: number; anchorY: number; flipX?: boolean }; clip: [number, number][] | undefined; seams?: { poly: [number, number][]; dx: number; dy: number }[] | undefined; ghost: boolean; hearth?: boolean; scale: number }
const rgb = (c: readonly number[]): string => `rgb(${Math.round(Math.min(1, c[0]!) * 255)},${Math.round(Math.min(1, c[1]!) * 255)},${Math.round(Math.min(1, c[2]!) * 255)})`;

/** Canvas2D sort key: Flat ground decals (roads, ADR-119) draw in a layer below every upright sprite, in iso order. */
export const flatSortDepth = (isoDepth: number, flat: boolean): number => (flat ? isoDepth - 1e7 : isoDepth);
