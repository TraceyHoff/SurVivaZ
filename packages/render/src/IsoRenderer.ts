import { reportRenderError } from "./report.js";
/**
 * IsoRenderer: WebGL2 2.5D isometric renderer. Read-only consumer of the ECS World.
 *
 * Per frame, render(world, alpha):
 *   0. prep (CPU)  sync terrain chunk meshes; gather/interpolate/resolve/cull/sort sprites; rebuild
 *                  dirty static build-piece chunks; gather lights
 *   1. scene pass  -> sceneFBO [color, emissive] + depth24
 *        a. terrain chunks              (opaque, depth write; 1 draw / visible chunk)
 *        b. static build-piece chunks   (cached instances, alpha-tested, depth write; 1 draw / visible chunk)
 *        c. shadows                     (blob or projected; instanced, blended, depth test only; 1 draw)
 *        d. dynamic sprites             (sorted back-to-front, alpha-tested, per-vertex depth; 1 draw)
 *   2. light pass  -> half-res lightmap: clear to ambient(time of day) + additive point lights (1 draw)
 *   3. composite   -> canvas: scene x light (emissive bypass), banding/night floor, fog, grading (1 draw)
 *   4. weather     -> canvas: instanced rain streaks, splashes, snow (<= 3 draws)
 */
import { buildSceneTarget, type SceneDepth } from "./gl/sceneTarget.js";
import { formatSceneDiag, type SceneDiag } from "./sceneDiag.js";
import { AssetManager, entityIndex, Transform, type World } from "@engine/core";
import { DEFAULT_ISO, screenToWorld, toView, type BuildingGrid, type ChunkedSpatialIndex, type IsoConfig, type TileMap } from "@engine/world";
import { IsoCamera, type Rect } from "./camera.js";
import { BloomPass } from "./bloom.js";
import { lightningStrikeAnim } from "./frame-select.js";
import { TileTerrain } from "./terrainTiles.js";
import { tileHeight } from "./tilemap.js";
import { parseGradingKeyframes, sampleKeyframes, lutSizeFromImage, type GradingKeyframe } from "./grading.js";
import { DEFAULT_EMITTER_KINDS, type EmitterVisual } from "./lighting.js";
import { loadRenderTuning } from "./style.js";
import type { SurfaceProvider } from "./tilemap.js";
import type { LutBinding } from "./composite.js";
import { AtlasManager } from "./assets/atlasManager.js";
import { BuildingTierStreamer } from "./assets/buildingTiers.js";
import { basisTranscoder, setKtx2Transcoder } from "./assets/ktx2.js";
import { TilemapRenderer } from "./tilemap.js";
import { waterfallArtResident } from "./waterfallTiles.js";
import { SpriteBatch, type GameplayBindings } from "./sprites.js";
import { LightPass } from "./lighting.js";
import { CompositePass } from "./composite.js";
import { WeatherPass, WeatherState, weatherTargets } from "./weather.js";
import { computeDayLighting, dimWeatherInto, newDayLighting, undergroundInto, type DayLighting } from "./timeOfDay.js";
import { isoZDepthFactor } from "./depth.js";
import { assertFramebuffer, createTexture, newStats, PhaseTimer, RenderGLError, setFragmentMediump, type FrameStats } from "./gl/util.js";
import { clampDrawingBuffer, detectCapabilities, parseGlFlags, type GlFlag, type RenderCapabilities, type RenderError } from "./gl/capabilities.js";
import { RENDER_COMPONENTS } from "./components.js";
import { DEFAULT_STYLE, mergeStyle, type StyleConfig, type StylePatch } from "./style.js";
import { readDayFraction, readDayNumber, readWeather, readWind } from "./env.js";
import { WeatherFx } from "./weatherFx.js";
import { seasonVisual } from "./season.js";
import type { TransformSource } from "./transformSource.js";
import { VfxLayer } from "./vfx.js";
import { BurningFx, HearthFx } from "./burning.js";
import { ChimneySmoke } from "./building/chimney.js";
import type { Renderer } from "./types.js";
import { atlasPageScaleForPreset, loadPreset, parsePreset, QualityController, QUALITY_TIERS, type QualityPreset } from "./quality.js";
import { benchAdjust, deviceSignature, rememberLevel, startLevel } from "./deviceTier.js";
import { BlankWatchdog, FallbackLadder, FallbackStep, FALLBACK_STEP_NAMES } from "./gl/fallback.js";
import { AsyncReadback } from "./gl/readback.js";
import { fboStatusName, formatDiagReport, glErrorName, isEmptyScene, newDiag, parseDiagFlag, SAMPLE_POINTS, type DiagReadback, type RenderDiag, type Rgba } from "./gl/diag.js";

export interface IsoRendererOptions {
  iso?: IsoConfig;
  /** Terrain to draw (TileMap or a streaming ChunkManager). */
  tilemap?: TileMap;
  /** Shared ref-counted asset cache (core). A private one is created if omitted. */
  assets?: AssetManager;
  /** Texture-array layer size for atlases (2048 default, 4096 on desktop). */
  atlasLayerSize?: number;
  /** Sim tick rate, for AnimState timing (default 20). */
  tickHz?: number;
  /** Keep the drawing buffer (needed for toDataURL/readPixels screenshots). */
  preserveDrawingBuffer?: boolean;
  /** Transparent canvas (premultiplied alpha): clears to (0,0,0,0) and composites with the scene's coverage alpha, so
   *  page content behind the canvas (e.g. the creator's preview_bg) shows through. Default false (opaque, sky clear). */
  transparent?: boolean;
  style?: StylePatch;
  /** Building sprite pivot convention: footprint centre (default; art guide + @engine/assets sample) or front-most corner. */
  pieceAnchor?: "center" | "front";
  /** Forced fallbacks for testing ("lowend" = all). Default: parsed from `?gl=` in location.search. */
  gl?: GlFlag[];
  /** Runtime render errors (context loss, OOM). Construction errors are thrown as RenderGLError (`.info`). */
  onError?: (e: RenderError) => void;
  /** `?diag=1` diagnostics (frame-1/60 readbacks, per-pass errors, diagReport()). Default: parsed from location.search. */
  diag?: boolean;
}

export interface RenderSettings { lights: boolean; shadows: boolean; weather: boolean; fog: boolean }

/** ADR-115: weight of Art's daynight_grading ambient vs the DAY_CURVE ambient. */
const GRADING_AMBIENT_MIX = 0.35;
/** Longest an atlas rebuild may hold the last frame before drawing resumes regardless (ms). */
export const SETTLE_HOLD_MS = 1500;
/** Holds drawing while the atlas settles after a rebuild, at most SETTLE_HOLD_MS per rebuild. */
export class SettleHold { private since = -1; hold(settling: boolean, now: number): boolean { if (!settling) { this.since = -1; return false; } if (this.since < 0) this.since = now; return now - this.since < SETTLE_HOLD_MS; } }
/** Atlas texel footprint (device px per texel) for tiering: zoom x device DPR, independent of the quality tier's resScale,
 *  so an adaptive-quality step never changes wear scale / mip range and never triggers an atlas re-tier. */
export function atlasFootprint(zoom: number, deviceDpr: number): number { return zoom * deviceDpr; }
export class IsoRenderer implements Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly camera: IsoCamera;
  readonly iso: IsoConfig;
  readonly zFactor: number;
  readonly atlas: AtlasManager;
  /** Atlas VRAM accounting: bytes resident / reserved pool / streamed wearable pages vs capabilities.textureBudgetMB, page-ins, evictions. */
  get vram(): AtlasManager["vramStats"] { return this.atlas.vramStats; }
  /** Device capabilities and every fallback chosen (formats, precision, limits, DPR cap, texture budget). */
  readonly capabilities: RenderCapabilities;
  /** Runtime errors for the client overlay: context-lost / context-restored / oom. After "context-restored" recreate the renderer. */
  onError: ((e: RenderError) => void) | null = null;
  /** True between webglcontextlost and webglcontextrestored; render() is a no-op meanwhile. */
  contextLost = false;
  private onLost = (ev: Event): void => { ev.preventDefault(); this.contextLost = true; this.emit({ kind: "context-lost", message: "WebGL context lost (GPU reset or out of memory); waiting for restore" }); };
  private onRestored = (): void => { this.contextLost = false; this.w = 0; this.h = 0; this.emit({ kind: "context-restored", message: "WebGL context restored: recreate the renderer to re-upload GPU resources" }); };
  private emit(e: RenderError): void { console.warn(`[render] ${e.kind}: ${e.message}`); this.onError?.(e); }
  /** Override the sky clear colour (linear-ish 0..1 RGB), e.g. a neutral backdrop for the character preview. */
  backdrop: [number, number, number] | null = null;
  /** IsoRendererOptions.transparent (fixed at construction: it is a context attribute). */
  readonly transparent: boolean;
  readonly settings: RenderSettings = { lights: true, shadows: true, weather: true, fog: true };
  /** Adaptive quality: Settings preset (Auto/Low/Medium/High/Ultra, persisted; ADR-116 probe-based Auto start) + frame-time governor (Auto). */
  readonly quality = new QualityController(parsePreset(typeof location !== "undefined" ? new URLSearchParams(location.search).get("quality") : null) ?? loadPreset());
  /** Change the Settings preset (persisted to localStorage); re-lays out the backbuffer at the new resolution scale. */
  /** Camper interior pass input (VehicleView.interiors / interiorIds / interiorWall): floor -> occupants -> cutaway walls. */
  setInterior(regions: readonly import("./vehicles/interiorPass.js").InteriorRegion[], floorIds: ReadonlySet<number>, wallSprite = -1, cut = false): void {
    const s = this.sprites; s.interiorRegions = regions as never; s.interiorFloorIds = floorIds as Set<number>; s.interiorWallSprite = wallSprite; s.interiorCut = cut;
  }
  setQualityPreset(p: QualityPreset): void { this.quality.setPreset(p); this.applyQuality(); }
  private readonly settleHold = new SettleHold();
  /** Frames skipped while an atlas rebuild settled (diag / tests). */
  heldFrames = 0;
  /** Presentation serial: unchanged on held, lost-context or incomplete frames. */
  completeFrames = 0;
  private prepareQuarter = false;
  private applyQuality(): void {
    // @2x pages were dead code before: setPageScale was never called, so Ultra / Full rendered
    // 1x pages into a native-DPR backbuffer -- a sharp canvas holding soft art. Wire the preset's
    // page scale here (and in the constructor, before the first setRegistry), so changing the
    // preset rebuilds the atlases at the scale it asks for. Full also lifts the atlas budget to
    // 256 MB before that rebuild, so the @2x pages do not immediately force fitBudget to halve
    // the rest of the visible art; a real OOM still halves on upload as before.
    if (this.quality.fullResolution) this.atlas.textureBudgetMB = Math.max(this.atlas.textureBudgetMB, 256);
    void this.atlas.setPageScale(atlasPageScaleForPreset(this.quality.preset)).catch((e: unknown) => reportRenderError("atlas page scale", e));
    this.resize(this.lastCss[0], this.lastCss[1], this.lastCss[2]);
  }
  readonly weatherState = new WeatherState();
  readonly vfx = new VfxLayer();
  /** ADR-246: weather sprite spawner (fx_snowflake / fx_blizzard / fx_heat_haze). */
  readonly weatherFx = new WeatherFx();
  /** Burning -> fire/ember/smoke VFX (keys in burning.cfg). */
  readonly burning = new BurningFx();
  /** ADR-218: embers + smoke over lit hearths (litPieces binding) and lit fire stations. */
  readonly hearth = new HearthFx();
  /** roof_chimney smoke attach point -> campfire_smoke particles (building/chimney.ts). */
  readonly chimneySmoke = new ChimneySmoke();
  style: StyleConfig;
  stats: FrameStats = newStats();
  /** ADR-381: per-phase render CPU (last frame, ms) — reused record, attached to stats each frame for ?diag=1. */
  readonly phaseTimer = new PhaseTimer();
  lighting: DayLighting = computeDayLighting(0.5, undefined, newDayLighting());
  /** ADR-263 (Task 36): 0..1 underground darkness around the camera focus (the client eases it from the player's depth). */
  underground = 0;
  private mixFog(a: readonly number[], b: readonly number[]): [number, number, number] { const o = this.fogScratch; o[0] = (a[0]! + b[0]!) / 2; o[1] = (a[1]! + b[1]!) / 2; o[2] = (a[2]! + b[2]!) / 2; return o; }
  private clearScratch = new Float32Array(4);
  private ambScratch: [number, number, number] = [0, 0, 0]; private fogScratch: [number, number, number] = [0, 0, 0];
  tilemap: TileMap | undefined;
  tickHz: number;
  pieceAnchor: "center" | "front";
  bindings: GameplayBindings = {};
  grid: BuildingGrid | undefined;
  spatial: { index: ChunkedSpatialIndex; activeKeys?: ReadonlySet<string> } | undefined;
  /** Chunks to draw (e.g. ChunkManager.activeKeys); undefined = all resident. */
  activeKeys: ReadonlySet<string> | undefined;
  transformSource: TransformSource | undefined;
  /** Emitter kind id -> visual (gameplay-defined ids; unknown kinds ignored). */
  emitterKinds: Record<number, EmitterVisual> = { ...DEFAULT_EMITTER_KINDS };
  /** Surface wetness/snow: derived from Weather over time unless a per-chunk provider is set. */
  readonly surface = { wet: 0, snow: 0 };
  /** ADR-239: [fall, winter, ground snow floor, ice] for the terrain shaders. */
  private readonly seasonU: [number, number, number, number] = [0, 0, 0, 0];
  /** Grading keyframes (time-of-day sun/ambient/fog/shadow tint + optional LUT per keyframe). */
  gradingKeyframes: GradingKeyframe[] = [];
  private luts = new Map<string, LutBinding>();
  private styleLut: LutBinding | null = null;
  private shimmerTex: WebGLTexture | null = null;
  private bloom: BloomPass;
  private tiles: TileTerrain;
  /** Use the textured tile atlas for terrain when the registry has tile sprites (else vertex colours only). */
  texturedTerrain = true;
  private flash = 0; private nextBolt = 3; private cloudOff = [0, 0];
  /** Fires when lightning strikes (screen-space x/y of a random visible point, world tile coords). */
  onLightning: ((x: number, y: number) => void) | null = null;
  /** Status particle sprites by key (Art's survival_fx status atlas); missing keys disable that particle. rate = spawns/s per entity at level 1. */
  statusFx = { wet: { sprite: "fx_drip", rate: 1.2, lifetime: 0.6 }, cold: { sprite: "fx_breath_puff", rate: 0.8, lifetime: 1.0 }, heat: { sprite: "fx_sweat_drop", rate: 0.6, lifetime: 0.7 } };
  private statusDt = 0;
  private statusHook = (kind: "wet" | "cold" | "heat", x: number, y: number, z: number, level: number): void => {
    const c = this.statusFx[kind]; if (Math.random() > c.rate * level * this.statusDt) return;
    const id = this.atlas.registry?.ids.sprites.tryId(c.sprite); if (id === undefined) return;
    const up = kind === "wet" ? 1.2 + Math.random() * 0.8 : 2.4; // height above the feet in z units
    this.vfx.spawn({ spriteId: id, x: x - 0.15 + Math.random() * 0.3, y: y - 0.15 + Math.random() * 0.3, z: z + up, lifetime: c.lifetime, scale: 1, emissive: false });
  };

  private terrain: TilemapRenderer;
  private sprites: SpriteBatch;
  /** debug counters of held-item drawing: [with item, with hand anchor, drawn] */
  get heldStats(): readonly number[] { return this.sprites.heldStats; }
  /** ADR-135 off-hand draws [with item, with anchor, drawn, on mirrored-handR fallback]. */
  get offHandStats(): readonly number[] { return this.sprites.offHandStats; }
  /** layered characters drawn last frame, extra layer instances, and total resolveLayers calls (cache misses) */
  get characterStats(): { characters: number; layerInstances: number; resolves: number; cached: number } {
    const s = this.sprites; return { characters: s.characters, layerInstances: s.layerInstances, resolves: s.layerCache?.resolves ?? 0, cached: s.layerCache?.size ?? 0 };
  }
  /** Character layer options: outline "union" (all layers) | "body"; minor layers (accessory/shoes/face/eyes) skipped below this zoom. */
  setCharacterOptions(o: Partial<{ outline: "union" | "body"; minorLayerMinZoom: number; outlineWidthPx: number; outlineColor: [number, number, number, number] }>): void { Object.assign(this.sprites.characterOpts, o); }
  private lights: LightPass;
  private composite: CompositePass;
  private weather: WeatherPass;
  private sceneFbo: WebGLFramebuffer | null = null;
  private sceneTex: WebGLTexture | null = null;
  private emisTex: WebGLTexture | null = null;
  private depthRb: WebGLRenderbuffer | null = null;
  private w = 0; private h = 0;
  private viewU = new Float32Array(4);
  private depthU = new Float32Array(2);
  private rect: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private lastNow = -1;
  private firstFrame = true;
  private firstFrame2 = true;
  /** Frames rendered (diagnostic readbacks on 1 and 60). */
  frameCount = 0;
  /** Safe mode: no float targets, bloom or LUT; direct composite (`?gl=safe`, or auto after an empty-scene readback). */
  get safeMode(): boolean { return this.diagState.safe; }
  private diagState: RenderDiag;
  /** Diagnostics (also at capabilities.diag). */
  get diag(): RenderDiag { return this.diagState; }
  /** Seconds of renderer time (animation clock for water, flicker, particles). */
  time = 0;
  /** Freeze `time` (dt = 0) and adaptive quality: pixel-stable frames for screenshot diffs (character preview freeze). */
  freezeClock = false;
  /** ADR-214: renderer-clock rate (hit-stop dilates particles/weather/flicker for ~60 ms; the sim and input never pause). */
  timeScale = 1;
  /** Runtime GPU-memory fallback ladder (wearables -> dressed cap -> low atlas tier -> safe); see gl/fallback.ts. */
  readonly fallback = new FallbackLadder();
  /** Ongoing blank-frame watchdog (centre pixels every 60 frames for the whole session). */
  readonly watchdog = new BlankWatchdog();
  /** Dressed characters kept at fallback step 2 (nearest to the view centre). */
  static DRESS_CAP = 6;
  /** Frames rendered since construction (frameCount restarts on a safe-mode retry). */
  private totalFrames = 0;
  /** GPU sync points (diag probe readbacks + watchdog readPixels). Profilers set false so frame timings stay pipelined. */
  get syncPoints(): boolean { return this._sync; }
  set syncPoints(v: boolean) { this._sync = v; this.atlas.syncChecks = v; }
  private _sync = true;
  /** building_t1..t4 pages retained per tier present nearby (see updateBuildingTiers). */
  private tierStream: BuildingTierStreamer | null = null; private tierLayout = -1;
  /** Streamed building tier pages currently held (diagnostics / tests). */
  get buildingTiersHeld(): string[] { return this.tierStream?.heldKeys() ?? []; }
  /** ADR-206: last frame had a roof/upper-floor cutaway around the focus entity (player is indoors). Allocation-free. */
  get indoor(): boolean { return this.sprites.cutawayActive; }
  /** Modular building stats of the last frame: pieces drawn with streaming fallback art, crack overlays, gridless/grid cutaway active. */
  get buildingStats(): { tierFallbacks: number; crackOverlays: number; cutaway: boolean; chimneys: number; smoke: number } {
    return { tierFallbacks: this.sprites.tierFallbacks, crackOverlays: this.sprites.crackOverlays, cutaway: this.sprites.cutawayActive, chimneys: this.chimneySmoke.chimneys, smoke: this.chimneySmoke.spawned };
  }
  /** Report a GPU allocation / render-target fault: steps the fallback ladder down once (with cooldown). */
  fault(source: string, detail: string): void {
    const step = this.fallback.fault(source, detail, this.totalFrames);
    this.diagState.messages.push(`${source}: ${detail}`); if (this.diagState.messages.length > 16) this.diagState.messages.shift();
    if (step === null) return;
    const msg = `GPU fallback step ${step} (${FALLBACK_STEP_NAMES[step]}) after ${source}: ${detail}`;
    this.capabilities.fallbacks.push(`runtime fallback: ${FALLBACK_STEP_NAMES[step]}`);
    this.applyFallback(step);
    this.emit({ kind: "oom", message: msg, detail: this.diagReport() });
  }
  private applyFallback(step: number): void {
    if (step >= FallbackStep.EvictWearables) this.atlas.setWearables(false);
    if (step >= FallbackStep.CapDressed) this.sprites.maxDressed = IsoRenderer.DRESS_CAP;
    if (step === FallbackStep.LowTier) {
      this.atlas.forceLowTier().then(() => { this.w = 0; }, (e: unknown) => this.fault("atlas", `low-tier rebuild failed: ${String(e)}`));
    }
    if (step >= FallbackStep.Safe) this.enterSafe("fallback ladder");
  }
  /** Ladder recovery: undo the step we just left (wearables back on, dressed cap lifted, default atlas tiers). */
  private recoverFallback(step: number): void {
    if (step < FallbackStep.LowTier) this.atlas.restoreTier().then(() => { this.w = 0; }, (e: unknown) => this.fault("atlas", `tier restore failed: ${String(e)}`));
    if (step < FallbackStep.CapDressed) this.sprites.maxDressed = Infinity;
    if (step < FallbackStep.EvictWearables) this.atlas.setWearables(true);
    this.diagState.messages.push(`GPU fallback recovered to step ${step} (${FALLBACK_STEP_NAMES[step]})`);
  }
  private enterSafe(why: string): void {
    const d = this.diagState; if (d.safe) return;
    d.safe = true; d.autoSafe++; this.capabilities.safe = true; this.capabilities.fallbacks.push(`auto safe mode (${why})`);
    const w = this.canvas.clientWidth || this.w, h = this.canvas.clientHeight || this.h; this.w = 0; this.h = 0; this.resize(w, h, this.camera.dpr); this.frameCount = 0;
  }

  constructor(readonly canvas: HTMLCanvasElement, opts: IsoRendererOptions = {}) {
    // no failIfMajorPerformanceCaveat (software/console adapters must still get a context); retry with the default
    // power preference — some ANGLE/D3D11 adapters (Xbox Edge) refuse "high-performance" after a GPU reset
    this.transparent = opts.transparent ?? false;
    const ctxOpts = { antialias: false, alpha: this.transparent, premultipliedAlpha: true, depth: false, stencil: false, preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false };
    const gl = canvas.getContext("webgl2", { ...ctxOpts, powerPreference: "high-performance" }) ?? canvas.getContext("webgl2", { ...ctxOpts, powerPreference: "default" });
    if (!gl) throw new RenderGLError({ kind: "webgl2", message: "WebGL2 is not available in this browser/GPU" });
    this.gl = gl;
    if (opts.onError) this.onError = opts.onError;
    const flags = opts.gl ?? parseGlFlags(typeof location !== "undefined" ? location.search : undefined);
    const caps = (this.capabilities = detectCapabilities(gl, { flags, ...(opts.atlasLayerSize !== undefined ? { layerSize: opts.atlasLayerSize } : {}) }));
    setFragmentMediump(gl, !caps.precision.fragmentHighp);
    this.diagState = caps.diag = newDiag(opts.diag ?? parseDiagFlag(typeof location !== "undefined" ? location.search : undefined), caps.safe);
    console.info(`[render] ${caps.renderer} | frag ${caps.precision.fragment} | atlas ${caps.atlasLayerSize}px budget ${caps.textureBudgetMB}MB | dpr<=${caps.maxDpr}` + (caps.fallbacks.length ? `\n  fallbacks: ${caps.fallbacks.join("; ")}` : ""));
    if (caps.problems.length) { console.error("[render] GPU limits: " + caps.problems.join("; ")); }
    { // ADR-116: Auto starts at the probed (or remembered-good) tier, never above the device ceiling; bench promotes/demotes once
      const dv = caps.device; const sig = deviceSignature({ renderer: caps.renderer, userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "" });
      const st = startLevel(dv, sig, caps.flags.includes("high") || caps.lowEnd ? 2 : 3);
      this.quality.configure({ klass: dv.klass, name: QUALITY_TIERS[st.level]!.name, start: st.level, ceiling: dv.ceiling, remembered: st.remembered, reasons: dv.reasons }, (m) => benchAdjust({ ...dv, start: st.level }, m));
      this.quality.onStable = (lvl) => rememberLevel(sig, lvl);
      console.info(`[render] device ${dv.klass}: auto ${QUALITY_TIERS[st.level]!.name}${st.remembered ? " (remembered)" : ""} (ceiling ${QUALITY_TIERS[dv.ceiling]!.name}; ${dv.reasons.join("; ")})`);
    }
    canvas.addEventListener("webglcontextlost", this.onLost, false);
    canvas.addEventListener("webglcontextrestored", this.onRestored, false);
    this.iso = { ...(opts.iso ?? DEFAULT_ISO) }; // own copy: the ADR-253 view rotation lives on it (camera + passes share it)
    this.zFactor = isoZDepthFactor(this.iso);
    this.camera = new IsoCamera(this.iso);
    this.tilemap = opts.tilemap;
    this.tickHz = opts.tickHz ?? 20;
    this.pieceAnchor = opts.pieceAnchor ?? "center";
    this.style = mergeStyle(DEFAULT_STYLE, opts.style ?? {});
    this.atlas = new AtlasManager(gl, opts.assets ?? new AssetManager(), { layerSize: caps.atlasLayerSize, textureBudgetMB: caps.textureBudgetMB });
    // Preset's page scale before the first setRegistry, so a persisted Full / Ultra preset does
    // not first build at 1x and only switch after the user re-picks it in Settings. setPageScale
    // with no registry yet just records the scale; the first rebuild then uses it.
    void this.atlas.setPageScale(atlasPageScaleForPreset(this.quality.preset));
    { // KTX2 wearables: Basis transcoder (vendored, lazy) unless ?ktx2=0 or safe mode; probe target from compressed caps
      const off = caps.safe || (typeof location !== "undefined" && /[?&]ktx2=0\b/.test(location.search));
      setKtx2Transcoder(off ? null : basisTranscoder); this.atlas.setCompressed(off ? null : caps.compressed);
    }
    this.atlas.onError = (e) => this.emit(e);
    this.atlas.onFault = (src, detail) => this.fault(src, detail);
    if (caps.safe) this.fallback.atLeast(FallbackStep.Safe);
    this.atlas.setStatusTints(this.style.statusTints);
    this.terrain = new TilemapRenderer(gl, this.iso, this.zFactor);
    this.sprites = new SpriteBatch(gl, this.iso, this.zFactor);
    this.lights = new LightPass(gl, this.iso);
    this.composite = new CompositePass(gl);
    this.weather = new WeatherPass(gl);
    this.bloom = new BloomPass(gl);
    this.tiles = new TileTerrain(gl, this.iso, this.zFactor);
  }

  /** Make sure the render components exist on this world (idempotent). */
  /**
   * Building tier streaming: every 15 frames, count BuildPiece sprites whose pivot is within the visible rect grown by
   * half a screen per side ("nearby") per streamed tier page; tiers present are retained, absent ones released.
   */
  private updateBuildingTiers(world: World, rect: { x0: number; y0: number; x1: number; y1: number }): void {
    const bpDef = this.bindings.buildPiece; if (!bpDef || !this.atlas.streamBuildingTiers) return;
    if (this.tierLayout !== this.atlas.layoutVersion) { this.tierStream = new BuildingTierStreamer(this.atlas); this.tierLayout = this.atlas.layoutVersion; }
    else if (this.totalFrames % 15 !== 1) return;
    const ts = this.tierStream!; const bp = world.store(bpDef); const tr = world.store(Transform); const vis = (bp.data as Record<string, ArrayLike<number>>).visualId!;
    const hw = this.iso.tileW / 2, hh = this.iso.tileH / 2, q = this.iso.view ?? 0; const mx = (rect.x1 - rect.x0) / 2, my = (rect.y1 - rect.y0) / 2;
    const x0 = rect.x0 - mx, x1 = rect.x1 + mx, y0 = rect.y0 - my, y1 = rect.y1 + my * 3; // + tall pieces below the bottom edge
    ts.begin();
    for (let k = 0; k < bp.size; k++) {
      const t = tr.slot(entityIndex(bp.dense[k]!)); if (t < 0) continue;
      const p = toView(tr.data.x[t]!, tr.data.y[t]!, q); const sx = (p.u - p.v) * hw, sy = (p.u + p.v) * hh;
      if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) ts.add(vis[k]!);
    }
    ts.end();
  }
  static registerComponents(world: World): void { for (const c of RENDER_COMPONENTS) world.register(c); }

  /** Entity (the local player) used for Occluder fading and roof/upper-floor cutaways. */
  setFocusEntity(e: number): void { this.sprites.focusEntity = e; }
  /** ADR-253: view rotation in quarter turns (0..3). */
  get viewRotation(): number { return this.camera.view; }
  /** ADR-253: snap the view to quarter `q` keeping `pivot` (default: the view centre) fixed on screen. All passes read the
   *  shared IsoConfig, so terrain, sprites, buildings, lights and shadows follow on the next frame. */
  setViewRotation(q: number, pivot?: { x: number; y: number; z?: number }): void { this.camera.setView(q, pivot); this.prepareQuarter = true; }
  /** Gameplay components the renderer reads (BuildPiece, AnimState). */
  bindGameplay(b: GameplayBindings): void { this.bindings = { ...this.bindings, ...b }; }
  /** ADR-256: grazed grass lookup (world tile coords) + revision so TileTerrain chunk caches rebuild. */
  setGrazed(at: ((tx: number, ty: number) => boolean) | undefined, rev = 0): void { this.tiles.grazedAt = at; this.tiles.grazedRev = rev | 0; }
  private syncGrazedBinding(world: World): void {
    const def = this.bindings.grazedTile; if (!def || !world.isRegistered(def)) return;
    const next = new Set<string>(); for (const e of world.query([def])) { const g = world.get(e, def)!; next.add(`${g.tx},${g.ty}`); }
    let same = next.size === this.grazedKeys.size; if (same) for (const k of next) if (!this.grazedKeys.has(k)) { same = false; break; }
    if (!same) { this.grazedKeys = next; this.grazedRev++; this.setGrazed((x, y) => this.grazedKeys.has(`${x},${y}`), this.grazedRev); }
  }
  private grazedKeys = new Set<string>(); private grazedRev = 0;
  /** BuildingGrid used for cutaway detection (multi-level). */
  setBuildingGrid(g: BuildingGrid | undefined): void { this.grid = g; }
  /** Use a ChunkedSpatialIndex for sprite culling (iterate only visible, active chunks). */
  setSpatialIndex(index: ChunkedSpatialIndex | undefined, activeKeys?: ReadonlySet<string>): void { this.spatial = index ? { index, ...(activeKeys ? { activeKeys } : {}) } : undefined; }
  setActiveChunks(keys: ReadonlySet<string> | undefined): void { this.activeKeys = keys; }
  setTransformSource(s: TransformSource | undefined): void { this.transformSource = s; }
  setStyle(patch: StylePatch): void { this.style = mergeStyle(this.style, patch); this.atlas.setStatusTints(this.style.statusTints); }
  /** Gameplay's per-chunk surface value (wet/snow 0..1); undefined -> derive from Weather. */
  setSurfaceProvider(p: SurfaceProvider | undefined): void { this.terrain.perChunk = p; }

  /** Tileable RG offset noise for heat shimmer (e.g. survival_fx/textures/heat_shimmer_rg_128.png). */
  setShimmerNoise(img: TexImageSource): void {
    const gl = this.gl; if (!this.shimmerTex) this.shimmerTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.shimmerTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  }
  /** Upload a grading LUT strip (16³ 256x16 or 32³ 1024x32; size auto-detected). */
  addLut(key: string, img: TexImageSource & { width: number; height: number }): LutBinding {
    const size = lutSizeFromImage(img.width, img.height);
    if (!size) throw new Error(`LUT ${key}: ${img.width}x${img.height} is not an N²xN strip`);
    const gl = this.gl; const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const b = { tex, size }; const old = this.luts.get(key); if (old) gl.deleteTexture(old.tex); this.luts.set(key, b); return b;
  }

  /**
   * Load Art & Assets' look layer: render_tuning.json (validated; unknown keys warn) merged over the neutral
   * defaults, plus the grading LUT / keyframes it references (relative URLs). Missing files keep procedural fallbacks.
   */
  async loadLook(tuningUrl: string, fetcher: typeof fetch = fetch): Promise<{ warnings: string[]; loaded: string[] }> {
    const warnings: string[] = []; const loaded: string[] = [];
    const base = tuningUrl.replace(/[^/]*$/, ""); const abs = (u: string): string => /^(\/|[a-z]+:)/i.test(u) ? u : base + u;
    const res = await fetcher(tuningUrl).catch(() => null);
    if (!res || !res.ok) return { warnings: [`render tuning not found: ${tuningUrl} (using defaults)`], loaded };
    const t = loadRenderTuning(await res.json(), this.style); warnings.push(...t.warnings); this.style = t.style; this.atlas.setStatusTints(this.style.statusTints); loaded.push(tuningUrl);
    const img = async (u: string): Promise<ImageBitmap | null> => { try { const r = await fetcher(u); if (!r.ok) return null; return await createImageBitmap(await r.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" }); } catch { return null; } };
    const g = this.style.gradingLut;
    if (g.url) { const b = await img(abs(g.url)); if (b) { try { this.styleLut = this.addLut(g.url, b); loaded.push(abs(g.url)); } catch (e) { warnings.push(String(e)); } } else warnings.push(`LUT not found: ${abs(g.url)}`); }
    if (g.keyframes) {
      const r = await fetcher(abs(g.keyframes)).catch(() => null);
      if (r && r.ok) {
        const k = parseGradingKeyframes(await r.json()); warnings.push(...k.issues.map((i) => `keyframes ${i}`)); this.gradingKeyframes = k.keyframes; loaded.push(abs(g.keyframes));
        for (const kf of k.keyframes) if (kf.lut && !this.luts.has(kf.lut)) { const b = await img(abs(kf.lut)); if (b) { try { this.addLut(kf.lut, b); } catch (e) { warnings.push(String(e)); } } else warnings.push(`keyframe LUT not found: ${abs(kf.lut)}`); }
      } else warnings.push(`keyframes not found: ${abs(g.keyframes)}`);
    }
    return { warnings, loaded };
  }

  /** Depth format the scene FBO ended up with ("none" = painter order only). */
  sceneDepth: SceneDepth = "DEPTH_COMPONENT24";
  private lastCss: [number, number, number] = [0, 0, 1];
  private lightDs = 0;
  resize(cssW: number, cssH: number, dprIn: number): void {
    // lost context / hidden canvas: every GL call is a no-op and clientWidth may be 0 -> never size targets to 0x0
    if (this.contextLost || this.gl.isContextLost() || !(cssW > 0) || !(cssH > 0)) return;
    this.lastCss = [cssW, cssH, dprIn]; this.lights.downscale = this.quality.tier.lightDownscale;
    // Full preset: native DPR, soft DPR / pixel-budget caps bypassed (opt-in only; Auto keeps them). Hard
    // MAX_TEXTURE/RENDERBUFFER/VIEWPORT clamp inside clampDrawingBuffer still applies (an oversized scene FBO is
    // incomplete -> black world) (mobile 2, low-end 1): phones report DPR 2.6-3.5
    const full = this.quality.fullResolution;
    const { w, h, dpr } = clampDrawingBuffer(cssW, cssH, full ? dprIn : dprIn * this.quality.tier.resScale, this.capabilities, { bypassSoftCaps: full });
    this.canvas.width = w; this.canvas.height = h;
    this.camera.setViewport(w, h, dpr);
    if (w === this.w && h === this.h && this.lights.downscale === this.lightDs) return;
    this.lightDs = this.lights.downscale;
    if (w === this.w && h === this.h) { this.lights.resize(w, h); return; }
    this.w = w; this.h = h;
    const gl = this.gl;
    if (this.sceneTex) gl.deleteTexture(this.sceneTex); if (this.emisTex) gl.deleteTexture(this.emisTex);
    if (this.depthRb) gl.deleteRenderbuffer(this.depthRb); if (this.sceneFbo) gl.deleteFramebuffer(this.sceneFbo);
    this.sceneTex = createTexture(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    this.emisTex = createTexture(gl, w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST);
    const tgt = buildSceneTarget(gl, this.sceneTex, this.emisTex, w, h, this.diagState.safe);
    this.sceneFbo = tgt.fbo; this.depthRb = tgt.depthRb; this.sceneDepth = tgt.depth;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    if (tgt.depth !== (this.diagState.safe ? "DEPTH_COMPONENT16" : "DEPTH_COMPONENT24")) {
      const f = `scene depth ${tgt.depth} (tried ${tgt.tried.join(", ")})`;
      console.warn(`[render] ${f}`); if (!this.capabilities.fallbacks.includes(f)) this.capabilities.fallbacks.push(f);
    }
    const fst = gl.checkFramebufferStatus(gl.FRAMEBUFFER); const allocErr = gl.getError();
    this.diagState.fbo.scene = fboStatusName(fst);
    if (fst !== gl.FRAMEBUFFER_COMPLETE || allocErr === gl.OUT_OF_MEMORY) {
      // out of memory / incomplete after the resize: step down (frees atlas memory or drops to safe targets) and retry
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.fault("fbo", `scene ${w}x${h} ${fboStatusName(fst)}${allocErr ? " " + glErrorName(allocErr) : ""}`);
      if (fst !== gl.FRAMEBUFFER_COMPLETE && this.fallback.exhausted) { gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo); assertFramebuffer(gl, "scene"); }
      if (fst !== gl.FRAMEBUFFER_COMPLETE) { this.w = 0; return; }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.lights.resize(w, h);
    this.bloom.resize(w, h);
    this.checkTargets();
    const e2 = gl.getError(); if (e2 === gl.OUT_OF_MEMORY) this.fault("fbo", `lightmap/bloom ${w}x${h} OUT_OF_MEMORY`);
  }

  /** checkFramebufferStatus on lightmap + bloom chain; createColorTarget already fell back to RGBA8, an incomplete one is rebuilt RGBA8 once. */
  private checkTargets(): void {
    const gl = this.gl; const d = this.diagState.fbo;
    const st = (f: WebGLFramebuffer | null): string => { if (!f) return "none"; gl.bindFramebuffer(gl.FRAMEBUFFER, f); const r = fboStatusName(gl.checkFramebufferStatus(gl.FRAMEBUFFER)); gl.bindFramebuffer(gl.FRAMEBUFFER, null); return r; };
    d.lightmap = st(this.lights.fbo); this.bloom.fbos.forEach((f, i) => { d[`bloom${i}`] = st(f); });
    const bad = Object.entries(d).filter(([, v]) => v !== "COMPLETE" && v !== "none");
    if (bad.length) {
      const msg = `render targets incomplete (${bad.map(([k, v]) => `${k}=${v}`).join(", ")}): rebuilt as RGBA8`; this.diagState.messages.push(msg); this.emit({ kind: "fbo", message: msg }); this.fault("fbo", msg);
      const w = this.w, h = this.h; (this.lights as unknown as { w: number }).w = 0; (this.bloom as unknown as { w: number }).w = 0; this.lights.resize(w, h); this.bloom.resize(w, h);
    }
  }

  /** Read-only: draws the world at interpolation factor alpha in [0,1). */
  render(world: World, alpha: number): void {
    if (this.contextLost || this.gl.isContextLost()) return;
    const t0 = performance.now();
    // atlas rebuild in flight (re-tier): hold the last presented frame until resident pages are back (bounded) instead of
    // drawing frames with the player's body / clothes / streamed art missing
    if (this.totalFrames > 0 && this.settleHold.hold(this.atlas.settling, t0)) { this.heldFrames++; return; }
    const dt = this.freezeClock || this.lastNow < 0 ? 0 : Math.min(0.1, (t0 - this.lastNow) / 1000);
    this.lastNow = t0; this.time += dt * (this.timeScale > 0 ? Math.min(1, this.timeScale) : 1);
    if (!this.freezeClock && this.quality.feed(dt * 1000) && this.lastCss[0] > 0) this.applyQuality();
    this.vfx.maxActive = Math.round(2048 * this.quality.tier.particles);
    const stats = (this.stats = newStats());
    const pt = this.phaseTimer; pt.start(t0); // ADR-381: per-phase CPU for ?diag=1 (see gl/util.ts PhaseTimer)
    this.frameCount++; this.totalFrames++; const probe = this.frameCount === 1 || this.frameCount === 60; const diag = this.diagState;
    const pass = (name: string): void => { if (probe) { const e = gl.getError(); if (diag.enabled || e !== gl.NO_ERROR) diag.passErrors[name] = glErrorName(e); } };
    const gl = this.gl; const style = this.style;
    // re-layout after an atlas rebuild / fallback: keep the caller's CSS size + DPR (a hard-coded 1 here dropped phones to a DPR-1 backbuffer = blurry)
    if (this.w === 0) this.resize(this.lastCss[0] || this.canvas.clientWidth || 800, this.lastCss[1] || this.canvas.clientHeight || 600, this.lastCss[2]);
    this.vfx.update(this.time); this.statusDt = dt;
    if (this.bindings.burning) this.burning.update(world, this.bindings.burning, this.bindings.buildPiece, this.atlas, this.vfx, this.time, dt);
    if (this.bindings.litPieces || this.bindings.lit) this.hearth.update(world, this.bindings.litPieces?.(), this.bindings.lit, this.bindings.buildPiece, this.atlas, this.vfx, dt * (this.timeScale > 0 ? Math.min(1, this.timeScale) : 1), this.bindings.pieceScale);
    if (this.chimneySmoke.cfg.rateScale > 0) this.chimneySmoke.update(world, this.bindings.buildPiece, this.atlas, this.vfx, dt, this.iso);

    // --- 0. prep ---------------------------------------------------------------------------
    const dayFrac = readDayFraction(world);
    const kf = sampleKeyframes(this.gradingKeyframes, dayFrac * 24);
    const wr = readWeather(world);
    const target = weatherTargets(wr.kind, wr.intensity);
    if (this.firstFrame) { this.weatherState.snap(target); this.firstFrame = false; } else this.weatherState.update(target, dt);
    const ws = this.weatherState;
    // ADR-115: the shared light curve (sun elevation table + moon), then weather dimming; Art's grading keyframes keep
    // the LUTs/shadow tint and are folded into ambient at GRADING_AMBIENT_MIX so the curve still drives the transitions.
    const day = this.lighting; computeDayLighting(dayFrac, readDayNumber(world), day); dimWeatherInto(day, Math.max(ws.rain, ws.fog, ws.snow * 0.7), ws.storm, day); // in place: no per-frame allocation
    if (kf) { const m = GRADING_AMBIENT_MIX; for (let k = 0; k < 3; k++) day.ambient[k] = day.ambient[k]! * (1 - m) + (kf.ambient[k]! + kf.sun[k]!) * m; }
    undergroundInto(day, this.underground); // ADR-263: dark underground until local lights (the light pass below) reach it
    this.sprites.shadowColor.set(kf ? kf.shadowTint : style.shadowTint);
    // wind: Weather.windDir/windSpeed when set, else the configured default (scaled by weather wind level)
    const wenv = readWind(world);
    const wDir = wenv.speed > 0 ? wenv.dir : style.wind.defaultDir;
    const wSpeed = wenv.speed > 0 ? wenv.speed : style.wind.defaultSpeed * (1 + 3 * ws.wind);
    const wvd = wDir + ((this.iso.view ?? 0) & 3) * Math.PI / 2; // ADR-253: wind in view space (screen-space sway / clouds)
    const wsx = Math.cos(wvd) - Math.sin(wvd); // tile-axis direction -> screen x
    this.sprites.windVec[0] = Math.sign(wsx) * Math.min(1, Math.abs(wsx)); this.sprites.windVec[1] = Math.min(1.5, wSpeed / Math.max(0.1, style.wind.refSpeed));
    this.cloudOff[0]! -= wsx * wSpeed * 8 * dt; this.cloudOff[1]! -= (Math.cos(wvd) + Math.sin(wvd)) * 0.5 * wSpeed * 8 * dt;
    // surface wetness / snow cover accumulate from weather (gameplay's per-chunk value overrides via setSurfaceProvider)
    const sf = this.surface, su = style.surface;
    sf.wet = Math.max(0, Math.min(1, sf.wet + (ws.rain > 0.05 ? ws.rain * su.wetRate : -su.dryRate * (0.5 + day.daylight)) * dt));
    sf.snow = Math.max(0, Math.min(1, sf.snow + (ws.snow > 0.05 ? ws.snow * su.snowRate : -su.meltRate * day.daylight) * dt));
    if (this.firstFrame2) { sf.wet = Math.min(1, ws.rain * 0.85); sf.snow = Math.min(1, ws.snow * 0.8); this.firstFrame2 = false; }
    this.terrain.surface = sf;
    // ADR-239 seasons: ground recolour + snowpack + ice (terrain uniforms), sprite foliage/snow caps (falling leaves: the client FX director)
    const sv = seasonVisual(world); const SU = this.seasonU;
    SU[0] = sv.fall; SU[1] = sv.winter; SU[2] = sv.snow; SU[3] = sv.ice;
    this.terrain.season = SU; this.tiles.season = SU; this.tiles.groundSeason = sv.art; // ADR-246: gt_ ground art season
    this.syncGrazedBinding(world); // ADR-256: single-world demos (client uses IsoView.setGrazed from the net world)
    this.sprites.season = sv; this.sprites.seasonSnowCap = Math.max(sv.snow * 1.15, sf.snow * 0.9);
    this.terrain.surfaceStyle = { puddles: su.puddles, wetDarken: su.wetDarken, skyRefl: su.skyReflection };
    // lightning during storms
    this.flash = Math.max(0, this.flash - dt * 4);
    if (style.lightning.enabled && ws.storm > 0.2) {
      this.nextBolt -= dt;
      if (this.nextBolt <= 0) {
        this.flash = 1; this.nextBolt = style.lightning.meanIntervalSec * (0.3 + Math.random() * 1.4);
        const r = this.rect; const sx = r.x0 + Math.random() * (r.x1 - r.x0), sy = r.y0 + Math.random() * (r.y1 - r.y0) * 0.6;
        const wp = screenToWorld(sx, sy, 0, this.iso); const tx = wp.x, ty = wp.y; // ADR-253: rotation-aware
        const bolt = this.atlas.registry?.ids.sprites.tryId("fx_lightning");
        if (bolt !== undefined) { // ADR-242: random strike_a/b/c variant per bolt
          let names: string[] = []; try { names = this.atlas.registry!.sprite(bolt).animList.map((a) => a.name ?? ""); } catch { /* unknown sprite */ }
          this.vfx.spawn({ spriteId: bolt, anim: lightningStrikeAnim(names, Math.random()), x: tx, y: ty, lifetime: 0.25, scale: 2 });
        }
        this.onLightning?.(tx, ty);
      }
    }
    // ADR-246: Art's weather sprites (snowflakes, blizzard gusts, heat haze) from the ADR-239 weather
    { const r = this.rect, hw0 = this.iso.tileW / 2, hh0 = this.iso.tileH / 2; const t = (sx: number, sy: number): [number, number] => { const w = screenToWorld(sx, sy, 0, this.iso); return [w.x, w.y]; };
      const a = t(r.x0, r.y0), b = t(r.x1, r.y0), c = t(r.x0, r.y1), d = t(r.x1, r.y1); const reg = this.atlas.registry;
      const wv = Math.min(2, wSpeed / Math.max(0.1, style.wind.refSpeed)); this.weatherFx.scale = this.quality.tier.particles;
      this.weatherFx.update(this.vfx, (k) => reg?.ids.sprites.tryId(k), wr.kind, ws, day.daylight, { x: Math.cos(wDir) * wv, y: Math.sin(wDir) * wv },
        { x0: Math.min(a[0], b[0], c[0], d[0]), x1: Math.max(a[0], b[0], c[0], d[0]), y0: Math.min(a[1], b[1], c[1], d[1]), y1: Math.max(a[1], b[1], c[1], d[1]), tiles: ((r.x1 - r.x0) * (r.y1 - r.y0)) / (2 * hw0 * hh0) }, dt); }

    { const up = this.fallback.recover(this.totalFrames); if (up !== null) this.recoverFallback(up); }
    // texel footprint from zoom x device DPR, not the governor's resScale: a quality tier change must never trigger an atlas re-tier
    this.atlas.setCharFootprint(atlasFootprint(this.camera.zoom, this.lastCss[2] || this.camera.dpr));
    if (this.totalFrames >= 30 && this.totalFrames % 30 === 0) void this.atlas.retier(this.totalFrames).then((r) => { if (r) { this.w = 0; console.info(`[render] re-tiered atlases: ${this.atlas.tiers.hot.length} hot x${this.atlas.tiers.hotScale}`); } }, (e: unknown) => reportRenderError("atlas retier", e));
    if (this.tilemap) this.terrain.sync(this.tilemap);
    this.camera.viewUniform(this.viewU);
    const rect = this.camera.visibleRect(0, this.rect);
    // Camera-relative depth range: precision independent of world size / streaming.
    const hh = this.iso.tileH / 2;
    const minKey = rect.y0 / hh - 64, maxKey = (rect.y1 + 2048) / hh + 64;
    this.depthU[0] = minKey; this.depthU[1] = 1 / (maxKey - minKey);
    // Keep preparing while pages settle: a later atlas revision invalidates all destination meshes.
    if (this.prepareQuarter && this.tilemap) this.tiles.prepareView(this.tilemap, this.atlas, this.activeKeys);
    this.updateBuildingTiers(world, rect);
    pt.split("prep", performance.now()); // section 0 (day/weather/season/tiers) ends here
    this.sprites.prepare({
      world, alpha, rect, atlas: this.atlas, depthMin: minKey, depthRange: maxKey - minKey, tickHz: this.tickHz, style,
      bindings: this.bindings, spatial: this.spatial, activeKeys: this.activeKeys, grid: this.grid, groundZAt: this.tilemap ? (x: number, y: number) => tileHeight(this.tilemap!, x, y) : undefined, pieceAnchor: this.pieceAnchor,
      transformSource: this.transformSource, vfx: this.vfx, now: this.time, statusFx: this.statusHook, zoom: this.camera.zoom,
    });
    pt.split("sprites", performance.now());
    this.sprites.upload();
    pt.split("upload", performance.now());
    pass("prep");
    this.lights.prepare(world, alpha, rect, this.settings.lights, this.transformSource, { emitter: this.bindings.emitter, lit: this.bindings.lit, kinds: this.emitterKinds });
    pt.split("lightsPrep", performance.now());

    // --- 1. scene pass ---------------------------------------------------------------------
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, this.w, this.h);
    gl.depthMask(true);
    { const bg = this.backdrop ?? day.sky; const c = this.clearScratch; if (this.transparent) { c[0] = c[1] = c[2] = c[3] = 0; } else { c[0] = bg[0]; c[1] = bg[1]; c[2] = bg[2]; c[3] = 1; } gl.clearBufferfv(gl.COLOR, 0, c); }
    gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]);
    // depth-only attachment (DEPTH_COMPONENT24/16): clear DEPTH, not DEPTH_STENCIL. Clearing DEPTH_STENCIL with no stencil
    // left depth uncleared on some ANGLE/Mali drivers -> every terrain/sprite fragment failed LESS (only the sky clear showed)
    gl.clearBufferfv(gl.DEPTH, 0, [1]);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS);
    gl.disable(gl.BLEND);
    if (this.tilemap) {
      // ADR-249: the vertex-colour mesh is only the under-layer (cliff fill / unloaded-art fallback) when textured tiles draw:
      // push it back with a polygon offset so the tile art (gt_ land, water, ice) always wins the LEQUAL test instead of
      // z-fighting it (hid gt water/land on some depth buffers; the fall-grass mosaic / seam lines).
      const textured = this.texturedTerrain && TileTerrain.available(this.atlas);
      if (textured) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(2, 8); }
      const reg = this.atlas.registry;
      this.terrain.waterfallArt = !!reg && waterfallArtResident((k) => reg.ids.sprites.tryId(k) !== undefined);
      this.terrain.draw(this.viewU, this.depthU, rect, this.time, stats, this.activeKeys);
      if (textured) gl.disable(gl.POLYGON_OFFSET_FILL);
      if (textured) {
        gl.depthFunc(gl.LEQUAL);
        this.tiles.draw(this.tilemap, this.atlas, this.viewU, this.depthU, rect, this.time, stats, this.terrain.surface, this.terrain.perChunk, this.terrain.surfaceStyle, this.activeKeys);
        gl.depthFunc(gl.LESS);
      }
    }
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.sprites.drawStatic(this.viewU, this.depthU, this.atlas, this.time, this.time, rect, this.activeKeys, style, stats);
    if (this.settings.shadows && style.shadowMode !== "none") {
      gl.depthMask(false); gl.depthFunc(gl.LEQUAL);
      const base = style.shadowMode === "blob" ? style.blobShadow.alpha * (0.45 + 0.55 * day.daylight) : day.shadowAlpha;
      const sa = base * (1 - 0.6 * Math.max(ws.fog, ws.rain));
      this.sprites.draw("shadow", this.viewU, this.depthU, this.atlas, this.time, ws.wind, day.shadowDir, sa, style, stats);
      gl.depthMask(true); gl.depthFunc(gl.LESS);
    }
    this.sprites.draw("sprite", this.viewU, this.depthU, this.atlas, this.time, ws.wind + 0.15, day.shadowDir, 1, style, stats);
    this.sprites.drawSilhouette(this.viewU, this.depthU, this.atlas, this.time, ws.wind + 0.15, style, stats);
    this.sprites.drawLate(this.viewU, this.depthU, this.atlas, this.time, ws.wind + 0.15, style, stats);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    pass("scene");
    pt.split("scene", performance.now());
    const clearBg = this.backdrop ?? day.sky;

    // --- 2. light pass ---------------------------------------------------------------------
    const amb = this.ambScratch; amb[0] = day.ambient[0]; amb[1] = day.ambient[1]; amb[2] = day.ambient[2]; // weather already applied (dimForWeather)
    this.lights.draw(this.viewU, amb, style.daylightLightScale + (1 - style.daylightLightScale) * day.glow, this.time, stats); // fires/lamps swell as it darkens

    pass("light");
    pt.split("light", performance.now());
    // --- 3. composite ----------------------------------------------------------------------
    const bloomOn = style.bloom.strength > 0 && !diag.safe && this.quality.tier.bloom;
    if (bloomOn) this.bloom.draw(this.sceneTex!, this.emisTex!, style.bloom.radiusPx, stats);
    if (bloomOn) pt.split("bloom", performance.now()); else pt.zero("bloom"); // off: no time attributed (last stays at the split)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    let lutA = this.styleLut, lutB: LutBinding | null = null, lutMix = 0;
    if (kf) { const a = this.gradingKeyframes[kf.a]!.lut, b = this.gradingKeyframes[kf.b]!.lut; const la = a ? this.luts.get(a) : undefined, lb = b ? this.luts.get(b) : undefined;
      if (la && lb) { lutA = la; lutB = lb; lutMix = kf.t; } else if (la || lb) { lutA = (la ?? lb)!; } }
    const night = Math.max(0, Math.min(1, Math.max(day.glow, 1 - (amb[0] + amb[1] + amb[2]) / 1.6)));
    if (bloomOn) pass("bloom");
    if (diag.safe) this.composite.drawSafe(this.sceneTex!, this.emisTex!, this.lights.tex!, this.transparent);
    else this.composite.draw(this.sceneTex!, this.emisTex!, this.lights.tex!, {
      ambient: amb, fog: this.settings.fog ? ws.fog : 0, haze: day.haze, storm: ws.storm, night, wind: ws.wind, time: this.time,
      origin: [rect.x0, rect.y1], size: [rect.x1 - rect.x0, rect.y0 - rect.y1], style,
      fogColor: kf ? this.mixFog(kf.fog, day.fog) : day.fog,
      bloom: bloomOn ? this.bloom.output : null, bloomStrength: style.bloom.strength * (1 + (style.bloom.nightBoost - 1) * night),
      lutA, lutB, lutMix, transparent: this.transparent, flash: this.flash * style.lightning.flash,
      cloudOffset: [this.cloudOff[0]!, this.cloudOff[1]!], cloudAlpha: style.clouds.alpha * day.daylight * (1 + style.clouds.overcastBoost * Math.max(ws.rain, ws.storm)),
      heat: this.lights.heat, heatCount: this.lights.heatCount, shimmerTex: this.shimmerTex,
    });
    stats.drawCalls++;
    pass("composite");
    pt.split("composite", performance.now());
    if (probe) this.probe(stats, clearBg);
    else if (this._sync) this.watch(stats);

    // --- 4. weather particles --------------------------------------------------------------
    if (this.settings.weather) this.weather.draw(this.w, this.h, this.camera.x * this.camera.scale, this.camera.y * this.camera.scale, this.camera.dpr, ws, this.time, amb, stats, this.quality.tier.weather);
    if (this.settings.weather) pt.split("weather", performance.now()); else pt.zero("weather");

    stats.staticChunks = this.sprites.staticChunksDrawn; stats.staticInstances = this.sprites.staticInstances;
    stats.cpuMs = performance.now() - t0;
    stats.phases = pt.ms; // ADR-381: shared record — the diag overlay reads the last frame's splits
    if (this.tilemap && this.w > 0 && this.h > 0 && !this.atlas.settling && !gl.isContextLost()) { this.prepareQuarter = false; this.completeFrames++; }
  }


  /** Blank-frame watchdog check (whole session): flat scene + output while instances were drawn -> fallback step. */
  private watch(stats: FrameStats): void {
    // ADR-148: async readback (PBO + fence) queued on the due frame and collected a few frames later without a CPU/GPU
    // stall (the old synchronous readPixels drained the pipeline once a second: a periodic hitch)
    const rb = this.watchRb ??= new AsyncReadback(this.gl);
    if (rb.pending) {
      const px = rb.poll(); if (!px) return; const at = this.watchAt; this.watchAt = undefined; if (!at) return;
      const n = SAMPLE_POINTS.length; const scene = px.slice(0, n), output = px.slice(n, 2 * n);
      // ADR-159: getError is a synchronous GPU-process round trip; skip it when sync checks are off (budgets >=384 MB)
      const err = this.atlas.syncChecks ? this.gl.getError() : this.gl.NO_ERROR;
      if (err === this.gl.OUT_OF_MEMORY) this.fault("frame", "GL_OUT_OF_MEMORY during the frame");
      if (this.watchdog.sample(at.frame, scene, output, at.instances)) this.fault("watchdog", `flat frame ${this.watchdog.consecutive}x in a row (${at.instances} instances)`);
      return;
    }
    if (!this.watchdog.due(this.totalFrames)) return;
    const pts = SAMPLE_POINTS.map(([x, y]) => [Math.min(this.w - 1, Math.floor(x * this.w)), Math.min(this.h - 1, Math.floor(y * this.h))] as [number, number]);
    if (rb.start([{ fbo: this.sceneFbo, pts }, { fbo: null, pts }])) this.watchAt = { frame: this.totalFrames, instances: stats.sprites + stats.staticInstances + stats.tiles };
  }
  private watchRb: AsyncReadback | undefined; private watchAt: { frame: number; instances: number } | undefined;

  /** Frame-1/60 readback: a few pixels of the scene FBO, lightmap and final output; empty scene with draws -> onError + one safe retry. */
  private probe(stats: FrameStats, bg: readonly number[]): void {
    const gl = this.gl; const d = this.diagState;
    const read = (fbo: WebGLFramebuffer | null, w: number, h: number): Rgba[] => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); if (fbo) gl.readBuffer(gl.COLOR_ATTACHMENT0);
      const px = new Uint8Array(4);
      const out = SAMPLE_POINTS.map(([x, y]) => { gl.readPixels(Math.min(w - 1, Math.floor(x * w)), Math.min(h - 1, Math.floor(y * h)), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return [px[0]!, px[1]!, px[2]!, px[3]!] as Rgba; });
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); return out;
    };
    const lw = (this.lights as unknown as { w: number; h: number });
    const instances = stats.sprites + stats.staticInstances + stats.tiles;
    const clear: Rgba = [Math.round(Math.min(1, bg[0]!) * 255), Math.round(Math.min(1, bg[1]!) * 255), Math.round(Math.min(1, bg[2]!) * 255), 255];
    const scene = read(this.sceneFbo, this.w, this.h);
    const r: DiagReadback = { frame: this.frameCount, scene, light: read(this.lights.fbo, lw.w, lw.h), output: read(null, this.w, this.h), clear, instances, drawCalls: stats.drawCalls, empty: isEmptyScene(scene, clear) };
    d.passErrors.readback = glErrorName(gl.getError());
    d.readbacks.push(r); if (d.readbacks.length > 4) d.readbacks.shift();
    const a = this.atlas.diagInfo;
    d.textures = { atlasLayers: a.layers, atlasLayerSize: a.layerSize, atlasLevels: a.levels, atlasDownscale: a.downscale, pool: a.pool, uploadErrors: a.errors };
    if (d.enabled) console.info("[render] diag\n" + this.diagReport());
    if (r.empty && instances > 0) {
      const retry = !d.safe && d.autoSafe === 0;
      const msg = `scene FBO empty on frame ${r.frame} (all samples = clear ${clear.slice(0, 3).join(",")}) although ${instances} instances / ${stats.drawCalls} draws were submitted` + (retry ? "; retrying in safe mode (?gl=safe)" : "");
      d.messages.push(msg); this.emit({ kind: "diag", message: msg, detail: this.diagReport() });
      if (retry) { this.fallback.atLeast(FallbackStep.Safe); this.applyFallback(FallbackStep.Safe); }
    }
  }

  /** Plain-text diagnostics for the client's ?diag=1 overlay (capabilities, atlas/FBO status, per-pass errors, readbacks). */
  /** Plain-text diagnostics; safe to call at any time, including before frame 1 (no readbacks yet). */
  /** Client-fed scene info (entities, player, camera target, local server, snapshots, last error) for diagReport(). */
  sceneDiag: SceneDiag | undefined;
  diagReport(): string {
    const c = this.capabilities;
    let vramMB: number | undefined; try { const t = this.vram?.totalMB; if (Number.isFinite(t)) vramMB = Math.round(t); } catch { /* atlas not ready */ }
    try {
      const r = formatDiagReport(this.diagState, { renderer: c.renderer, mobile: c.mobile, precision: c.precision.fragment, budgetMB: c.textureBudgetMB, ...(vramMB !== undefined ? { vramMB } : {}), fallbacks: c.fallbacks, problems: c.problems });
      const a = this.atlas; const sp = this.sprites;
      const t = a.tiers; const fi = a.fitInfo;
      const tierLine = `tiers: hot x${t.hotScale} (${t.hot.length}), cold x${t.coldScale} (${t.cold.length}), side arrays x1/${1 << a.sideShift}, page @${a.currentPageScale}x; pool reserve ${fi.reserveMB}/${fi.reserveWantedMB} MB, demoted ${fi.demoted}${fi.pinned?.length ? `, x1-pinned ${fi.pinned.length}` : ""}${a.needsRetier ? ", RETIER pending" : ""}; ladder step ${this.fallback.step} (${this.fallback.name}); backbuffer ${this.w}x${this.h} @dpr ${this.camera.dpr.toFixed(3)} scale ${this.camera.scale.toFixed(3)}`;
      const extra = [this.quality.describe(), tierLine, `wear pool: ${a.wearPoolInfo}`, ...this.fallback.report(), this.watchdog.report(),
        `wearables: ${a.wearablesEnabled ? "on" : "OFF"}, page faults ${a.pageFaults}, budget refusals ${a.pageBudgetRefusals}; dressed cap ${Number.isFinite(sp.maxDressed) ? sp.maxDressed : "none"} (${sp.dressCapped} body-only last frame)`,
        ...sp.nearInfo.slice(0, sp.nearN).map((n) => `char ${n.d === 0 ? "LOCAL" : "near"} e${n.e} d=${n.d.toFixed(1)}t: tier x${n.scale} (dress-cap/ladder exempt), layers ${n.resident}/${n.layers} resident${n.missing.length ? ` missing [${n.missing.join(",")}]` : ""}`)].join("\n");
      const sc = this.sceneDiag; const hint = sc && sc.entities === 0 ? "\n! no entities replicated: nothing to draw (GPU is fine; check localServer/snapshots/lastError)" : "";
      const out = r + "\n" + extra + "\n" + formatSceneDiag(sc) + hint;
      return this.frameCount === 0 ? out + "\n(no frame rendered yet: readbacks appear after frames 1 and 60)" : out;
    } catch (e) { return `render diag unavailable: ${String(e)}`; }
  }

  dispose(): void {
    this.canvas.removeEventListener("webglcontextlost", this.onLost); this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    this.atlas.dispose();
    const ext = this.gl.getExtension("WEBGL_lose_context"); ext?.loseContext();
  }
}
