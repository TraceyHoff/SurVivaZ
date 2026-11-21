/**
 * Character creator preview: a self-contained IsoRenderer + mini World showing one layered character on a neutral
 * backdrop with a soft key light. Usable from the DOM UI:
 *
 *   const pv = await createCharacterPreview(containerOrCanvas, { registry, sources, appearance });
 *   pv.setAppearance(next); pv.rotate(1); pv.setZoom(1.5); pv.setAnim("walk"); ... pv.dispose();
 *
 * Appearance writes go through core `setAppearance` (bumps Appearance.version, which the layer cache keys on).
 * Input: pointer drag rotates (8 facings), wheel / pinch zooms, `bindKeys()` adds arrows/Q/E rotate and +/- zoom,
 * `pollGamepad` (default on) maps LB/RB or the right stick to rotate. resize()/DPR is automatic for containers
 * (ResizeObserver) and callable by hand.
 */
import { AnimState as CoreAnimState } from "@engine/core";
import { Appearance, Transform, World, defineComponent, getAppearance, setAppearance, type AppearanceValue, type CosmeticCatalogLike, type Entity } from "@engine/core";
import type { AssetRegistry } from "@engine/assets";
import { IsoRenderer } from "../IsoRenderer.js";
import { LightSource, Shadow, Sprite } from "../components.js";
import type { AtlasSource } from "../assets/atlasManager.js";
import { coreAppearanceBinding, type AppearanceBinding } from "./layers.js";
import { worldToScreen } from "@engine/world";

/** Frame height (px) the fit-to-height scale is based on (same as CharacterPreview2D). */
export const PREVIEW_FRAME_H = 64;
/**
 * Doll placement shared with CharacterPreview2D: integer device scale floor(H * 0.62 / 64) (x user zoom), foot pivot at
 * device pixel (round(W/2), round(H*0.81)). Returns the camera centre offset (iso px, relative to the pivot's iso
 * position) that lands the pivot on that pixel after IsoCamera.viewUniform's snapping (centre on the 1/scale grid, +half
 * a pixel on odd-sized buffers).
 */
export function previewPlacement(devW: number, devH: number, zoom = 1): { scale: number; pivotX: number; pivotY: number; camDx: number; camDy: number } {
  const raw = (devH * 0.62) / PREVIEW_FRAME_H * zoom; const scale = raw >= 1 ? Math.floor(raw) : Math.max(0.25, raw);
  const pivotX = Math.round(devW / 2), pivotY = Math.round(devH * 0.81);
  const camDx = (devW / 2 - pivotX - ((devW & 1) ? 0.5 : 0)) / scale, camDy = (devH / 2 - pivotY - ((devH & 1) ? 0.5 : 0)) / scale;
  return { scale, pivotX, pivotY, camDx, camDy };
}

/** Preview-local anim driver (same schema as gameplay AnimState; the renderer only needs {state, startTick}). */
export const PreviewAnim = defineComponent("PreviewAnimState", { state: "u8", startTick: "u32" });
export type PreviewAnimName = "idle" | "walk";
const ANIM_STATE: Record<PreviewAnimName, number> = { idle: CoreAnimState.Idle, walk: CoreAnimState.Walk };
/** Facing index 0..7 -> radians (k * 45 deg). Index 1 faces the camera in the pack's character sheets. */
export const facingAngle = (k: number): number => (((k % 8) + 8) % 8) * Math.PI / 4;
export const FRONT_FACING = 1;

export interface CharacterPreviewOptions {
  registry: AssetRegistry; appearance: AppearanceValue;
  /** Atlas sources (as for IsoRenderer.atlas.setRegistry); default: none (registry atlases must already resolve). */
  sources?: Map<string, AtlasSource>;
  /** 0..7 (default FRONT_FACING) */ facing?: number | undefined;
  /** user zoom multiplier on top of fit-to-height (default 1, clamped 0.5..3) */ zoom?: number | undefined;
  anim?: PreviewAnimName | undefined;
  /** custom binding (default: core Appearance + resolveLayers over registry.cosmetics) */ binding?: AppearanceBinding;
  /** backdrop colour (CSS hex); only used when `transparent` is false */ backdrop?: string;
  /** Transparent canvas (default true): no opaque clear, so the page behind (the creator panel) shows through. */
  transparent?: boolean;
  /** degrees per drag step (pixels per 45 deg facing step), default 48 */ dragStepPx?: number;
  pollGamepad?: boolean;
  /** Pixel-stable frames for screenshot diffs: anim ticks stop (no idle bob/walk cycle), renderer clock frozen at 0 (no
   *  shader time effects / particles / flicker) and no adaptive-quality changes. */
  freeze?: boolean;
}

export interface CharacterPreview {
  readonly canvas: HTMLCanvasElement; readonly renderer: IsoRenderer; readonly world: World; readonly entity: Entity;
  /** Pages the selection's streamed wearable art in first (the previous composite stays on screen meanwhile), then
   *  applies it. Resolves once applied; a newer call supersedes an older pending one. */
  setAppearance(a: AppearanceValue): Promise<void>;
  /** current Appearance (a copy; mutate and pass back to setAppearance) */ getAppearance(): AppearanceValue;
  setFacing(k: number): void; rotate(steps: number): void; readonly facing: number;
  setZoom(z: number): void; readonly zoom: number;
  setAnim(a: PreviewAnimName): void;
  resize(cssW?: number, cssH?: number, dpr?: number): void;
  /** arrows / Q,E rotate, +/- zoom on `target` (default window); returns an unbind fn */ bindKeys(target?: Window | HTMLElement): () => void;
  /** render one frame now (for tests/screenshots); normally driven by rAF */ renderNow(): void;
  dispose(): void;
}

const hexRgb = (h: string): [number, number, number] => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };

export async function createCharacterPreview(target: HTMLCanvasElement | HTMLElement, o: CharacterPreviewOptions): Promise<CharacterPreview> {
  const own = !(target instanceof HTMLCanvasElement);
  const canvas = own ? document.createElement("canvas") : target as HTMLCanvasElement;
  const backdrop = o.backdrop ?? "#8a8f98";
  if (own) { canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none"; (target as HTMLElement).appendChild(canvas); }
  else canvas.style.touchAction = "none";
  const transparent = o.transparent ?? true;
  canvas.style.background = transparent ? "transparent" : backdrop;
  const world = new World({ seed: 1 });
  IsoRenderer.registerComponents(world); world.register(Appearance); world.register(PreviewAnim);
  const renderer = new IsoRenderer(canvas, { preserveDrawingBuffer: true, transparent, style: { blobShadow: { alpha: 0.45, widthFactor: 0.6, aspect: 0.4 }, occlusion: { enabled: false } } });
  renderer.settings.weather = false; renderer.settings.fog = false;
  if (o.freeze) { renderer.freezeClock = true; renderer.time = 0; }
  renderer.backdrop = hexRgb(backdrop);
  // one character: a small pool of sharp pages (paged in on selection) instead of the whole wardrobe at crowd scale
  renderer.atlas.poolPolicy = { coverAll: false, minSlots: 16 };
  // the doll is the only thing on screen: character art (bodies + wearables) stays on the hot x1 tier, everything else
  // in the registry goes cold first, so a low GPU budget shrinks scenery we never draw instead of blurring the doll
  renderer.atlas.magNearest = true;
  renderer.atlas.atlasTier = (_k, i) => (i.bodies || i.wearShare > 0 ? "hot" : "cold");
  // pin full resolution without touching the persisted Settings preset (setPreset would save it); the game's adaptive
  // resScale (x0.6 on low) would otherwise shrink the backing store and the browser upscales it -> blur
  renderer.quality.preset = "ultra";
  await renderer.atlas.setRegistry(o.registry, o.sources ?? new Map());
  const cat = o.registry.cosmetics as unknown as CosmeticCatalogLike | undefined;
  const binding = o.binding ?? (cat ? coreAppearanceBinding(cat) : undefined);
  if (!binding) throw new Error("createCharacterPreview: registry has no cosmetics catalog (and no binding given)");
  renderer.bindGameplay({ appearance: binding, animState: PreviewAnim });
  renderer.setCharacterOptions({ minorLayerMinZoom: 0 });

  const e = world.create();
  world.add(e, Transform, { x: 0, y: 0, z: 0, facing: facingAngle(o.facing ?? FRONT_FACING) });
  world.add(e, Sprite, { spriteId: o.registry.cosmetics?.bodySprite?.("male")?.sprite ?? 0, frameId: 0, flags: 0, scale: 1, tint: 0 });
  world.add(e, Shadow, { alpha: 0.8, length: 0.6 });
  world.add(e, PreviewAnim, { state: ANIM_STATE[o.anim ?? "idle"], startTick: 0 });
  // page in the initial outfit before the first frame (no layer pop-in)
  const spritesOf = (a: AppearanceValue): number[] => { const out: number[] = []; for (let k = 0; k < 8; k++) for (const l of binding.resolve(a as never, facingAngle(k), {}) as unknown as { sprite: number }[]) out.push(l.sprite); return out; };
  await renderer.atlas.prefetch(spritesOf(o.appearance)).catch(() => undefined);
  setAppearance(world, e, o.appearance);
  let pick = 0;
  const select = async (a: AppearanceValue): Promise<void> => {
    const n = ++pick; await renderer.atlas.prefetch(spritesOf(a)).catch(() => undefined);
    if (n === pick && !disposed) setAppearance(world, e, a);
  };
  // soft key light (warm, front-left) + cool rim (back-right)
  const key = world.create(); world.add(key, Transform, { x: 1.2, y: 1.6, z: 1.5, facing: 0 }); world.add(key, LightSource, { r: 1, g: 0.93, b: 0.82, radius: 4, intensity: 0.7, flicker: 0 });
  const rim = world.create(); world.add(rim, Transform, { x: -1.4, y: -1.2, z: 1.5, facing: 0 }); world.add(rim, LightSource, { r: 0.7, g: 0.8, b: 1, radius: 3, intensity: 0.35, flicker: 0 });

  let facing = ((o.facing ?? FRONT_FACING) % 8 + 8) % 8, zoom = Math.min(3, Math.max(0.5, o.zoom ?? 1)), cssH = 1, disposed = false;
  let devW = 1, devH = 1;
  const applyCam = (): void => {
    const p = previewPlacement(devW, devH, zoom), c = renderer.camera, o = worldToScreen(0, 0, 0, c.iso);
    c.zoom = p.scale / c.dpr; c.x = o.sx + p.camDx; c.y = o.sy + p.camDy;
  };
  const resize = (w?: number, h?: number, dpr?: number): void => {
    const cw = w ?? (own ? (target as HTMLElement).clientWidth : canvas.clientWidth) ?? 0, ch = h ?? (own ? (target as HTMLElement).clientHeight : canvas.clientHeight) ?? 0;
    const d = Math.min(3, dpr ?? (globalThis.devicePixelRatio || 1));
    // size the backing store in device px exactly like CharacterPreview2D (round(css * dpr)); passing device px at dpr 1
    // keeps the renderer's low-end DPR cap (meant for the full game view) from dropping the doll to CSS resolution
    cssH = Math.max(1, ch); renderer.resize(Math.max(1, Math.round(Math.max(1, cw) * d)), Math.max(1, Math.round(cssH * d)), 1);
    devW = canvas.width; devH = canvas.height; applyCam();
  };
  const setFacing = (k: number): void => { facing = ((Math.round(k) % 8) + 8) % 8; world.set(e, Transform, { facing: facingAngle(facing) }); };
  const setZoom = (z: number): void => { zoom = Math.min(3, Math.max(0.5, z)); applyCam(); };

  // --- input: drag rotate, wheel / pinch zoom ---------------------------------------------------------------------
  const step = o.dragStepPx ?? 48; const ptrs = new Map<number, { x: number; y: number }>(); let dragAcc = 0, pinch0 = 0, zoom0 = 1;
  const pdist = (): number => { const [a, b] = [...ptrs.values()]; return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0; };
  const onDown = (ev: PointerEvent): void => { ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY }); canvas.setPointerCapture?.(ev.pointerId); if (ptrs.size === 2) { pinch0 = pdist(); zoom0 = zoom; } };
  const onMove = (ev: PointerEvent): void => {
    const p = ptrs.get(ev.pointerId); if (!p) return;
    if (ptrs.size === 1) { dragAcc += ev.clientX - p.x; while (Math.abs(dragAcc) >= step) { const s = Math.sign(dragAcc); setFacing(facing - s); dragAcc -= s * step; } }
    p.x = ev.clientX; p.y = ev.clientY;
    if (ptrs.size === 2 && pinch0 > 0) setZoom(zoom0 * pdist() / pinch0);
  };
  const onUp = (ev: PointerEvent): void => { ptrs.delete(ev.pointerId); if (ptrs.size < 2) pinch0 = 0; if (!ptrs.size) dragAcc = 0; };
  const onWheel = (ev: WheelEvent): void => { ev.preventDefault(); setZoom(zoom * Math.exp(-ev.deltaY * 0.0015)); };
  canvas.addEventListener("pointerdown", onDown); canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp); canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  const ro = own && typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => resize()) : null; ro?.observe(target as HTMLElement);
  const unbinds: (() => void)[] = [];

  // --- loop: fixed 20 Hz anim ticks, render per rAF ------------------------------------------------------------
  let raf = 0, acc = 0, last = performance.now(), padPrev = 0;
  const pollPad = (): void => {
    if (o.pollGamepad === false || typeof navigator === "undefined" || !navigator.getGamepads) return;
    for (const gp of navigator.getGamepads()) {
      if (!gp) continue;
      const lb = gp.buttons[4]?.pressed ? -1 : 0, rb = gp.buttons[5]?.pressed ? 1 : 0, ax = gp.axes[2] ?? 0;
      const dir = lb + rb || (Math.abs(ax) > 0.6 ? Math.sign(ax) : 0);
      if (dir !== padPrev && dir !== 0) setFacing(facing + dir);
      padPrev = dir; return;
    }
  };
  const renderNow = (): void => { renderer.render(world, 1); };
  const loop = (now: number): void => {
    if (disposed) return;
    acc += Math.min(0.25, (now - last) / 1000); last = now;
    while (acc >= 0.05) { if (!o.freeze) world.tick++; acc -= 0.05; }
    pollPad(); renderNow(); raf = requestAnimationFrame(loop);
  };
  resize(); raf = requestAnimationFrame(loop);

  return {
    canvas, renderer, world, entity: e,
    setAppearance: select,
    getAppearance: () => { const a = getAppearance(world, e)!; return { bodyType: a.bodyType, skinTone: a.skinTone, parts: a.parts, primary: a.primary, secondary: a.secondary }; },
    setFacing, rotate: (s) => setFacing(facing + s), get facing() { return facing; },
    setZoom, get zoom() { return zoom; },
    setAnim: (a) => { world.set(e, PreviewAnim, { state: ANIM_STATE[a], startTick: world.tick }); },
    resize, renderNow,
    bindKeys: (t = window) => {
      const h = (ev: Event): void => {
        const k = (ev as KeyboardEvent).key;
        if (k === "ArrowLeft" || k === "q" || k === "Q") setFacing(facing + 1);
        else if (k === "ArrowRight" || k === "e" || k === "E") setFacing(facing - 1);
        else if (k === "+" || k === "=") setZoom(zoom * 1.15); else if (k === "-" || k === "_") setZoom(zoom / 1.15); else return;
        ev.preventDefault();
      };
      t.addEventListener("keydown", h); const u = (): void => t.removeEventListener("keydown", h); unbinds.push(u); return u;
    },
    dispose: () => {
      if (disposed) return; disposed = true; cancelAnimationFrame(raf); ro?.disconnect(); for (const u of unbinds) u();
      canvas.removeEventListener("pointerdown", onDown); canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp); canvas.removeEventListener("pointercancel", onUp); canvas.removeEventListener("wheel", onWheel);
      renderer.dispose(); if (own) canvas.remove();
    },
  };
}
