/**
 * WebGL2 capability probe + fallback policy for mobile GPUs (Adreno, Mali, PowerVR) and iOS Safari.
 *
 * Everything the renderer chooses per device lives in one `RenderCapabilities` object (exposed as
 * `IsoRenderer.capabilities`) so the client can show it in an error overlay / debug panel:
 * - render target formats (all LDR RGBA8; the lightmap is LDR-encoded at 0.5x, i.e. range [0,2])
 * - whether float / half-float colour buffers and float linear filtering exist (never required)
 * - fragment shader precision (highp when the GPU reports it, else mediump)
 * - limits (texture size, units, attribs, uniforms) and the atlas texture memory budget
 * - DPR cap (mobile 2, low-end 1) and max drawing-buffer pixels
 * `?gl=safe`: no float targets, no bloom / LUT, direct scene-to-screen composite. `?diag=1`: readbacks + diagReport().
 * Force the fallbacks for testing with `?gl=lowend` (all fallbacks), `?gl=mediump`, `?gl=nofloat`, `?gl=lowmem`
 * (comma-separated), or `IsoRendererOptions.gl`.
 */

import { isBasicAdapter, isConsole } from "./sceneTarget.js";
import { classifyDevice, type DeviceTier } from "../deviceTier.js";

export type GlFlag = "lowend" | "mediump" | "nofloat" | "lowmem" | "safe" | "high";

export interface RenderCapabilities {
  renderer: string; vendor: string; mobile: boolean; lowEnd: boolean; /** software / basic / remote adapter (auto lowend) */ basicAdapter: boolean; /** console browser (Xbox): full art at the high tier (ADR-407) — 256 MB atlas budget, <=1080p targets, inside the 1 GB UWP app cap */ console: boolean; flags: GlFlag[];
  /** GPU-compressed texture families (KTX2 transcode targets); all false = PNG/RGBA8 path. */
  compressed: CompressedTextureSupport;
  ext: { colorBufferFloat: boolean; colorBufferHalfFloat: boolean; floatLinear: boolean; debugRendererInfo: boolean };
  /** Chosen colour formats of the render targets. */
  formats: { scene: "RGBA8"; emissive: "RGBA8"; lightmap: "RGBA8" | "RGBA16F"; bloom: "RGBA8" | "RGBA16F"; lightmapEncode: number; dataTables: "RGBA32F"; lut: "RGBA8-2D-strip" };
  /** Filtering used on float textures (data tables are always texelFetch / NEAREST). */
  floatFilter: "LINEAR" | "NEAREST";
  precision: { fragmentHighp: boolean; fragment: "highp" | "mediump"; vertex: "highp" | "mediump"; fragmentHighpBits: number };
  limits: { maxTextureSize: number; maxArrayLayers: number; maxRenderbufferSize: number; maxViewport: [number, number]; maxTextureUnits: number; maxVertexTextureUnits: number; maxCombinedTextureUnits: number; maxVertexAttribs: number; maxFragmentUniformVectors: number; maxVertexUniformVectors: number; maxDrawBuffers: number; maxColorAttachments: number };
  /** Atlas page size (min(2048 or requested, MAX_TEXTURE_SIZE)) and GPU memory budget for atlas arrays. */
  atlasLayerSize: number; textureBudgetMB: number;
  maxDpr: number; maxPixels: number;
  /** Every fallback taken (also logged with console.warn). */
  fallbacks: string[];
  /** Hard problems found (limits below what the shaders need). */
  problems: string[];
  /** `?gl=safe` (or the automatic empty-scene retry): no float targets, no bloom/LUT, direct scene x light composite. */
  safe: boolean;
  /** ADR-116 probe-based device tier (Auto start + ceiling); `?gl=high` (post-context-loss) caps it at high. */
  device: DeviceTier;
  /** Filled under `?diag=1`: per-pass gl errors, FBO/texture status and frame-1/60 pixel readbacks (see IsoRenderer.diagReport()). */
  diag?: import("./diag.js").RenderDiag;
}

export interface RenderError { kind: "shader" | "link" | "fbo" | "diag" | "context-lost" | "context-restored" | "oom" | "limits" | "webgl2"; message: string; detail?: string }

/** Parse `gl=` flags from a query string (e.g. location.search). */
export function parseGlFlags(search: string | undefined): GlFlag[] {
  if (!search) return [];
  const v = new URLSearchParams(search).get("gl"); if (!v) return [];
  const all: GlFlag[] = ["lowend", "mediump", "nofloat", "lowmem", "safe", "high"];
  return v.split(",").map((s) => s.trim().toLowerCase()).filter((s): s is GlFlag => (all as string[]).includes(s));
}

const MOBILE_GPU = /adreno|mali|powervr|apple gpu|apple a\d|videocore|tegra|immortalis|xclipse|maleoon/i;
const MOBILE_UA = /android|iphone|ipad|ipod|mobile/i;

export interface CompressedTextureSupport { etc2: boolean; astc: boolean; s3tc: boolean; bptc: boolean }
/** Probe compressed-texture extensions (ETC2 is core in WebGL2 but only hardware-native on mobile: the extension
 *  WEBGL_compressed_texture_etc is what browsers expose when it is not emulated). ?gl=safe reports none. */
export function probeCompressedTextures(gl: { getExtension(name: string): unknown }, safe = false): CompressedTextureSupport {
  if (safe) return { etc2: false, astc: false, s3tc: false, bptc: false };
  const has = (n: string): boolean => { try { return !!gl.getExtension(n); } catch { return false; } };
  return { etc2: has("WEBGL_compressed_texture_etc"), astc: has("WEBGL_compressed_texture_astc"), s3tc: has("WEBGL_compressed_texture_s3tc"), bptc: has("EXT_texture_compression_bptc") };
}

export function detectCapabilities(gl: WebGL2RenderingContext, opts: { flags?: GlFlag[]; userAgent?: string; layerSize?: number; cores?: number; memoryGB?: number } = {}): RenderCapabilities {
  const flags = [...new Set(opts.flags ?? [])];
  const has = (f: GlFlag): boolean => flags.includes(f) || (f !== "lowend" && flags.includes("lowend"));
  const p = (n: number): number => Number(gl.getParameter(n)) || 0;
  const dbg = gl.getExtension("WEBGL_debug_renderer_info") as { UNMASKED_RENDERER_WEBGL: number; UNMASKED_VENDOR_WEBGL: number } | null;
  const renderer = String((dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) ?? "");
  const vendor = String((dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)) ?? "");
  const ua = opts.userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
  // software / basic / remote adapters (SwiftShader, llvmpipe, Microsoft Basic Render, WARP): small or shared
  // VRAM and partial format support -> start on the low-end path (lowmem budget, DPR 1) unless ?gl= already chose
  // (SraKmd is NOT basic: it is the Xbox console adapter, handled by isConsole below.)
  const basic = isBasicAdapter(renderer);
  if (basic && !flags.includes("lowend") && !flags.includes("safe")) flags.push("lowend");
  const mobile = MOBILE_GPU.test(renderer) || MOBILE_UA.test(ua) || (/macintosh/i.test(ua) && typeof navigator !== "undefined" && (navigator.maxTouchPoints ?? 0) > 1);
  const nofloat = has("nofloat") || flags.includes("safe");
  const ext = {
    colorBufferFloat: !nofloat && !!gl.getExtension("EXT_color_buffer_float"),
    colorBufferHalfFloat: !nofloat && !!gl.getExtension("EXT_color_buffer_half_float"),
    floatLinear: !nofloat && !!gl.getExtension("OES_texture_float_linear"),
    debugRendererInfo: !!dbg,
  };
  const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  const fragmentHighpBits = hp ? hp.precision : 0;
  const fragmentHighp = fragmentHighpBits >= 23 && !has("mediump");
  const vp = gl.getShaderPrecisionFormat(gl.VERTEX_SHADER, gl.HIGH_FLOAT);
  const vh = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | number[] | null;
  const limits = {
    maxTextureSize: p(gl.MAX_TEXTURE_SIZE), maxArrayLayers: p(gl.MAX_ARRAY_TEXTURE_LAYERS), maxRenderbufferSize: p(gl.MAX_RENDERBUFFER_SIZE),
    maxViewport: [vh?.[0] ?? 4096, vh?.[1] ?? 4096] as [number, number],
    maxTextureUnits: p(gl.MAX_TEXTURE_IMAGE_UNITS), maxVertexTextureUnits: p(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS), maxCombinedTextureUnits: p(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
    maxVertexAttribs: p(gl.MAX_VERTEX_ATTRIBS), maxFragmentUniformVectors: p(gl.MAX_FRAGMENT_UNIFORM_VECTORS), maxVertexUniformVectors: p(gl.MAX_VERTEX_UNIFORM_VECTORS),
    maxDrawBuffers: p(gl.MAX_DRAW_BUFFERS), maxColorAttachments: p(gl.MAX_COLOR_ATTACHMENTS),
  };
  const fallbacks: string[] = []; const problems: string[] = [];
  if (basic) fallbacks.push(`basic/software GPU adapter (${renderer.slice(0, 60)}): auto lowend`);
  const lowEnd = flags.includes("lowend");
  // Render targets stay LDR RGBA8 everywhere (renderable + linear-filterable on every WebGL2 device); the
  // lightmap stores light * 0.5 so [0,2] fits. Float targets would only be an optional upgrade.
  if (!ext.colorBufferFloat && !ext.colorBufferHalfFloat) fallbacks.push("no float colour buffers: lightmap/bloom RGBA8 (lightmap LDR-encoded x0.5)");
  if (!ext.floatLinear) fallbacks.push("no OES_texture_float_linear: float data tables use NEAREST/texelFetch only");
  if (!fragmentHighp) fallbacks.push(`fragment shaders use mediump (highp ${fragmentHighpBits ? fragmentHighpBits + " bits" : "unsupported"}${has("mediump") ? ", forced" : ""})`);
  // shader requirements (sprites: 9 instanced attribs, 6 fragment samplers + 1 vertex sampler; composite: 7 samplers, 16 heat vec4s)
  if (limits.maxVertexAttribs < 10) problems.push(`MAX_VERTEX_ATTRIBS ${limits.maxVertexAttribs} < 10`);
  if (limits.maxTextureUnits < 8) problems.push(`MAX_TEXTURE_IMAGE_UNITS ${limits.maxTextureUnits} < 8`);
  if (limits.maxVertexTextureUnits < 1) problems.push("no vertex texture units (frame table is fetched in the vertex shader)");
  if (limits.maxFragmentUniformVectors < 64) problems.push(`MAX_FRAGMENT_UNIFORM_VECTORS ${limits.maxFragmentUniformVectors} < 64`);
  if (limits.maxDrawBuffers < 2 || limits.maxColorAttachments < 2) problems.push("scene pass needs 2 draw buffers (colour + emissive)");
  let atlasLayerSize = Math.min(opts.layerSize ?? 2048, limits.maxTextureSize || 2048);
  if (atlasLayerSize < (opts.layerSize ?? 2048)) fallbacks.push(`atlas layer clamped to MAX_TEXTURE_SIZE ${atlasLayerSize}`);
  atlasLayerSize = 1 << Math.floor(Math.log2(Math.max(256, atlasLayerSize)));
  // mediump (fp16, 10-bit mantissa) atlas UVs are only ~1/2048 accurate near 1.0: cap pages at 1024 so the
  // UV error stays under half a texel (oversized atlas images are downscaled to fit by AtlasManager)
  if (!fragmentHighp && atlasLayerSize > 1024) { atlasLayerSize = 1024; fallbacks.push("mediump: atlas layer 1024 (UV precision)"); }
  // GPU memory budget for the atlas arrays: phones share RAM with the GPU and Chrome's GPU process caps it;
  // a 2048^2 x 11 layer x 4 array set with mips is ~0.9 GB, which fails (OOM / context loss) on Android.
  const lowmem = has("lowmem");
  // Mobile: 128 MB of atlas + streaming pools keeps the whole GPU set (plus ~30 MB of native-DPR render targets)
  // under ~160 MB. Memory comes from cold tiers + eviction, not from blurring visible art (see AtlasManager.fitBudget).
  const console_ = isConsole(renderer, ua) && !basic;
  // ADR-407: console runs at HIGH, not ultra. Edge on Xbox is a UWP app: Microsoft caps foreground apps at
  // 1 GB (games get 5 GB), so the whole tab — JS heap + GPU set + Edge's own overhead — must fit ~1 GB.
  // Ultra was 448 MB of atlas + ~116 MB of 4K render targets (renderTargetBytes) ≈ 564 MB before the JS
  // heap (ADR-212 budgets the console heap at 384 MB soft; measured 326 MB at spawn, 344 MB after 30 s in
  // emulation) — the boot peak tripped the sandbox limit (SBOX_FATAL_MEMORY_EXCEEDED). High is 256 MB
  // atlas + ~29 MB of 1080p targets ≈ 285 MB GPU-side (measured vram total 341.3 -> 193.3 MB in emulation
  // at the same 0.25x atlas downscale, so the art is no blurrier). ?gl=high used to be the post-context-loss
  // recovery tier; it is now the console default, and the recovery path is a no-op for consoles.
  // ADR-116: probe-based tier. Ultra (desktop dGPU) gets full-res @2x pages + larger streamed budgets; ?gl=high
  // (gl-recovery after a context loss) keeps the pre-ADR-116 budgets (desktop 768, console 256 MB / 1080p).
  const nav = typeof navigator !== "undefined" ? navigator as Navigator & { deviceMemory?: number } : undefined;
  const device = classifyDevice({ renderer, userAgent: ua, maxTextureSize: limits.maxTextureSize, cores: opts.cores ?? nav?.hardwareConcurrency ?? 0, memoryGB: opts.memoryGB ?? nav?.deviceMemory ?? 0, touchPoints: nav?.maxTouchPoints ?? 0 });
  const capHigh = flags.includes("high") || lowEnd;
  if (capHigh && device.ceiling > 2) { device.ceiling = 2; device.start = Math.min(device.start, 2); device.name = (["low", "medium", "high", "ultra"] as const)[device.start]!; device.reasons.push(lowEnd ? "lowend: capped at high" : "?gl=high (context loss): capped at high"); }
  const ultra = device.start >= 3 && !lowmem && !flags.includes("safe");
  // Capable phones (reported >= 4 GB RAM and >= 6 cores) get 256 MB instead of 128: at 128 MB the
  // pack's hot atlases (~200 MB at 1x) are forced to 0.5x by fitBudget, which is the blur in the
  // screenshot -- visible art magnified 2x from a halved page. Smaller / unknown devices keep 128 MB,
  // and the upload OOM path still halves on a real out-of-memory, so this is a budget, not a promise.
  const capableMobile = mobile && (opts.memoryGB ?? nav?.deviceMemory ?? 0) >= 4 && (opts.cores ?? nav?.hardwareConcurrency ?? 0) >= 6;
  const textureBudgetMB = lowmem || flags.includes("safe") ? 160 : mobile ? (capableMobile ? 256 : 128) : console_ ? 256 : ultra ? 1024 : 768;
  if (console_) fallbacks.push(`console GPU (${renderer.slice(0, 40)}): atlas budget ${textureBudgetMB} MB (streamed), RGBA8 targets, <=1080p (ADR-407: 1 GB UWP app cap)`);
  if (flags.includes("safe")) fallbacks.push("safe mode (?gl=safe): no float targets, bloom or LUT; direct composite");
  if (lowmem || mobile) fallbacks.push(`atlas texture budget ${textureBudgetMB} MB${mobile ? " (mobile)" : ""}`);
  // Mobile renders at the native DPR (a 2.625 phone backed at 2x is upscaled 1.31x by the compositor = blurry); the pixel
  // budget still caps 3.5x / 1440p panels. ?gl=lowend keeps DPR 1 (explicit low-end choice).
  const maxDpr = lowEnd ? 1 : ultra ? 4 : 3;
  const maxPixels = lowEnd ? 1280 * 720 : console_ && !ultra ? 1920 * 1080 : mobile ? 3_200_000 : 3840 * 2160;
  if (maxDpr < 3 || mobile) fallbacks.push(`DPR capped at ${maxDpr}, max ${maxPixels} px`);
  return {
    renderer, vendor, mobile, lowEnd, basicAdapter: basic, console: console_, flags, ext, compressed: probeCompressedTextures(gl, flags.includes("safe")),
    formats: { scene: "RGBA8", emissive: "RGBA8", lightmap: "RGBA8", bloom: "RGBA8", lightmapEncode: 0.5, dataTables: "RGBA32F", lut: "RGBA8-2D-strip" },
    floatFilter: ext.floatLinear ? "LINEAR" : "NEAREST",
    precision: { fragmentHighp, fragment: fragmentHighp ? "highp" : "mediump", vertex: vp && vp.precision >= 23 ? "highp" : "mediump", fragmentHighpBits },
    limits, atlasLayerSize, textureBudgetMB, maxDpr, maxPixels, fallbacks, problems, safe: flags.includes("safe"), device,
  };
}

/**
 * ADR-407: bytes of the scene render-target set at w x h — scene + emissive RGBA8 (4 B/px each),
 * DEPTH_COMPONENT24 depth (3 B/px), lightmap RGBA8 at 1/`lightDownscale` (half-res at the high tier,
 * full-res at ultra) and the two half-res bloom RGBA8 targets (2 B/px) = 14 B/px at the high tier.
 * At 3840x2160 with the high-tier half-res lightmap this is ~116.1 MB (the figure the old console
 * comment cited); at 1920x1080 it is ~29.0 MB. The depth figure is the accounting one (drivers may
 * pad 24-bit depth to 4 B/px, which only makes the real total larger — the console budget invariant
 * in adr407_console_memory_budget.test.ts still holds with margin). Used by the console boot-budget
 * invariant: the console GPU set (atlas budget + this) must fit the 512 MB design budget, leaving
 * the rest of the 1 GB UWP app cap for the JS heap (ADR-212: 384 MB soft) and Edge itself.
 */
export function renderTargetBytes(w: number, h: number, lightDownscale = 2): number {
  const px = Math.max(0, w) * Math.max(0, h);
  const lw = Math.max(1, Math.ceil(w / Math.max(1, lightDownscale))), lh = Math.max(1, Math.ceil(h / Math.max(1, lightDownscale)));
  return px * (4 + 4 + 3) + lw * lh * 4 + 2 * Math.max(1, w >> 1) * Math.max(1, h >> 1) * 4;
}

/** Rewrite a fragment shader for mediump-only GPUs (or the forced `?gl=mediump` path). */
export function toMediump(src: string): string {
  // Only the default float precision drops to mediump. Uniforms get an explicit highp so their precision still
  // matches the vertex stage (a mismatch is a link error); ints, samplers and explicit qualifiers are left alone
  // (GLSL ES 3.00 guarantees highp int in fragment shaders).
  return src.replace(/precision\s+highp\s+float\s*;/g, "precision mediump float;")
    .replace(/\buniform\s+(?!highp\b|mediump\b|lowp\b)((?:float|vec[234]|mat[234](?:x[234])?)\b)/g, "uniform highp $1");
}

/** Clamp a requested drawing-buffer size to the device caps.
 * Soft caps (DPR cap, pixel budget) are skipped when `bypassSoftCaps` is set -- used only by the explicit Full
 * preset, which is opt-in. Hard GPU limits (max renderbuffer / texture / viewport size) always still apply, so an
 * oversized scene FBO cannot silently become incomplete (black world).
 */
export function clampDrawingBuffer(cssW: number, cssH: number, dpr: number, caps: Pick<RenderCapabilities, "maxDpr" | "maxPixels" | "limits">, opts?: { bypassSoftCaps?: boolean }): { w: number; h: number; dpr: number } {
  let d = Math.max(0.5, dpr || 1);
  if (!opts?.bypassSoftCaps) {
    d = Math.min(d, caps.maxDpr);
    const px = cssW * cssH * d * d; if (px > caps.maxPixels) d *= Math.sqrt(caps.maxPixels / px);
  }
  const lim = Math.min(caps.limits.maxRenderbufferSize || 4096, caps.limits.maxTextureSize || 4096, caps.limits.maxViewport[0], caps.limits.maxViewport[1]);
  d = Math.min(d, lim / Math.max(1, cssW), lim / Math.max(1, cssH));
  return { w: Math.max(1, Math.round(cssW * d)), h: Math.max(1, Math.round(cssH * d)), dpr: d };
}

/** Annotated source excerpt around the lines named in a shader info log ("ERROR: 0:12: ..."). */
export function annotateShaderLog(src: string, log: string): string {
  const lines = src.split("\n"); const nums = new Set<number>();
  for (const m of log.matchAll(/(?:ERROR|WARNING):\s*\d+:(\d+)/g)) nums.add(Number(m[1]));
  const out: string[] = [];
  for (const n of [...nums].sort((a, b) => a - b)) for (let i = Math.max(1, n - 1); i <= Math.min(lines.length, n + 1); i++) out.push(`${i === n ? ">" : " "}${String(i).padStart(4)}| ${lines[i - 1]}`);
  return out.join("\n");
}
