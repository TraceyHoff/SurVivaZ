/** Full Resolution preset: native DPR, soft caps bypassed, Auto behaviour unchanged.
 *  Blur fix: @2x atlas pages are actually used (page scale was never wired before), the drawn
 *  season's ground may use its @2x page, and capable phones get a 256 MB atlas budget. */
import { describe, it, expect } from "vitest";
import { atlasPageScaleForPreset, DEFAULT_QUALITY_PRESET, loadPreset, PRESET_STORAGE_KEY, QualityController, parsePreset, QUALITY_PRESETS, savePreset } from "../src/quality.js";
import { clampDrawingBuffer, detectCapabilities } from "../src/gl/capabilities.js";
import { Canvas2DRenderer } from "../src/canvas2d.js";
import { AtlasManager, NON_CRISP_ATLAS_RE, VISIBLE_PIN_RE } from "../src/assets/atlasManager.js";

const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36";
// Same mock shape as capabilities.test.ts (constants carried on the context object).
const E = { MAX_TEXTURE_SIZE: 1, MAX_ARRAY_TEXTURE_LAYERS: 2, MAX_RENDERBUFFER_SIZE: 3, MAX_VIEWPORT_DIMS: 4, MAX_TEXTURE_IMAGE_UNITS: 5, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 6,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 7, MAX_VERTEX_ATTRIBS: 8, MAX_FRAGMENT_UNIFORM_VECTORS: 9, MAX_VERTEX_UNIFORM_VECTORS: 10, MAX_DRAW_BUFFERS: 11, MAX_COLOR_ATTACHMENTS: 12,
  RENDERER: 13, VENDOR: 14, FRAGMENT_SHADER: 20, VERTEX_SHADER: 21, HIGH_FLOAT: 22 } as const;
function mockGl(o: { renderer?: string } = {}): WebGL2RenderingContext {
  const P: Record<number, unknown> = { [E.MAX_TEXTURE_SIZE]: 16384, [E.MAX_ARRAY_TEXTURE_LAYERS]: 2048, [E.MAX_RENDERBUFFER_SIZE]: 16384, [E.MAX_VIEWPORT_DIMS]: new Int32Array([16384, 16384]),
    [E.MAX_TEXTURE_IMAGE_UNITS]: 16, [E.MAX_VERTEX_TEXTURE_IMAGE_UNITS]: 16, [E.MAX_COMBINED_TEXTURE_IMAGE_UNITS]: 32, [E.MAX_VERTEX_ATTRIBS]: 16,
    [E.MAX_FRAGMENT_UNIFORM_VECTORS]: 1024, [E.MAX_VERTEX_UNIFORM_VECTORS]: 1024, [E.MAX_DRAW_BUFFERS]: 8, [E.MAX_COLOR_ATTACHMENTS]: 8, [E.RENDERER]: o.renderer ?? "ANGLE (Qualcomm, Adreno (TM) 750, OpenGL ES 3.2)", [E.VENDOR]: "Qualcomm" };
  const ext = new Set(["EXT_color_buffer_float", "EXT_color_buffer_half_float", "OES_texture_float_linear"]);
  return { ...E, getParameter: (n: number) => P[n] ?? (n === 100 ? o.renderer : undefined), getExtension: (n: string) => (n === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL: 100, UNMASKED_VENDOR_WEBGL: 14 } : ext.has(n) ? {} : null),
    getShaderPrecisionFormat: (st: number) => ({ rangeMin: 127, rangeMax: 127, precision: st === E.FRAGMENT_SHADER ? 23 : 23 }) } as unknown as WebGL2RenderingContext;
}

const lim = (n: number) => ({ maxTextureSize: n, maxRenderbufferSize: n, maxViewport: [n, n] as [number, number] }) as never;

describe("Full Resolution preset", () => {
  it("is a valid, persisted preset that pins the Ultra tier", () => {
    expect(QUALITY_PRESETS).toContain("full");
    expect(parsePreset("full")).toBe("full");
    const q = new QualityController("full");
    expect(q.fullResolution).toBe(true);
    expect(q.level).toBe(3);
    expect(q.tier.name).toBe("ultra");
    expect(q.tier.resScale).toBe(1);
    expect(q.tier.lightDownscale).toBe(1);
  });
  it("does not let the frame-time governor move it (fixed presets only report Auto changes)", () => {
    const q = new QualityController("full");
    expect(q.feed(100)).toBe(false);
    expect(q.level).toBe(3);
  });
  it("Auto is unchanged: not full-resolution", () => {
    expect(new QualityController("auto").fullResolution).toBe(false);
  });
  it("clampDrawingBuffer bypasses soft DPR / pixel caps, but not hard GPU limits", () => {
    const caps = { maxDpr: 3, maxPixels: 3200000, limits: lim(16384) } as never;
    // 412x915 @ DPR 4: soft cap would give 1236x2745; bypass gives native 1648x3660
    expect(clampDrawingBuffer(412, 915, 4, caps, { bypassSoftCaps: true })).toEqual({ w: 1648, h: 3660, dpr: 4 });
    // Soft caps together: DPR 3, then the 3.2M-pixel budget pulls it to ~2.913x
    expect(clampDrawingBuffer(412, 915, 4, caps)).toEqual({ w: 1200, h: 2666, dpr: 2.9135054452534423 });
    // Hard viewport limit still applies even when bypassing soft caps
    const small = clampDrawingBuffer(3000, 1000, 2, { maxDpr: 3, maxPixels: 1e9, limits: lim(4096) } as never, { bypassSoftCaps: true });
    expect(small.w).toBeLessThanOrEqual(4096);
    expect(small.h).toBeLessThanOrEqual(4096);
  });
  it("atlas pages: Ultra / Full ask for @2x, Auto and the other presets stay on 1x", () => {
    expect(atlasPageScaleForPreset("full")).toBe(2);
    expect(atlasPageScaleForPreset("ultra")).toBe(2);
    expect(atlasPageScaleForPreset("auto")).toBe(1);
    expect(atlasPageScaleForPreset("high")).toBe(1);
  });
  it("capable phones get a 256 MB atlas budget; unknown / small phones keep 128 MB", () => {
    expect(detectCapabilities(mockGl(), { userAgent: ANDROID_UA, cores: 8, memoryGB: 8 }).textureBudgetMB).toBe(256);
    expect(detectCapabilities(mockGl(), { userAgent: ANDROID_UA }).textureBudgetMB).toBe(128);
    expect(detectCapabilities(mockGl(), { userAgent: ANDROID_UA, cores: 4, memoryGB: 2 }).textureBudgetMB).toBe(128);
  });
  it("ground @2x: only the drawn season's pages, other seasons stay 1x", () => {
    const am = Object.create(AtlasManager.prototype) as any;
    am.layerSize = 2048; am.groundPinSeason = "summer"; am.pageScale = 2;
    const src = (key: string) => ({ pages: [{ scale: 1, image: `${key}.png` }, { scale: 2, image: `${key}@2x.png` }] });
    const atlas = (key: string) => ({ key, columns: 15, frameW: 68, rows: 19, frameH: 52 });
    expect(am.pickScale(atlas("gt_summer_p0"), src("gt_summer_p0"))).toBe(2);
    expect(am.pickScale(atlas("gt_fall_p0"), src("gt_fall_p0"))).toBe(1);
    expect(am.pickScale(atlas("season_res"), src("season_res"))).toBe(2);
    am.pageScale = 1;
    expect(am.pickScale(atlas("gt_summer_p0"), src("gt_summer_p0"))).toBe(1);
  });
  it("crisp sampling covers ground, characters and buildings on every preset; soft art stays bilinear", () => {
    const am = Object.create(AtlasManager.prototype) as any;
    const keys = ["gt_summer_p0", "characters", "characters_b", "zombies", "buildings", "buildings_twig", "furniture", "resources_tall", "ui", "fog", "vfx", "se_fx_puff", "season_snowflake"];
    am.atlases = keys.map((key) => ({ key })); am.crispMark = [];
    const crisp = (k: string) => am.isCrisp(keys.indexOf(k));
    for (const k of ["gt_summer_p0", "characters", "characters_b", "zombies", "buildings", "buildings_twig", "furniture", "resources_tall"]) expect(crisp(k)).toBe(true);
    for (const k of ["ui", "fog", "vfx", "se_fx_puff", "season_snowflake"]) expect(crisp(k)).toBe(false);
    expect(NON_CRISP_ATLAS_RE.test("ui_icons")).toBe(true);
  });
  it("building pieces are pinned at 1x like ground and furniture, so fitBudget does not halve walls first", () => {
    for (const k of ["buildings", "buildings_twig", "buildings_stone", "openings", "defenses", "gt_summer_p0", "furniture"]) expect(VISIBLE_PIN_RE.test(k)).toBe(true);
    for (const k of ["buildingsx", "decor", "ui_icons", "zombies"]) expect(VISIBLE_PIN_RE.test(k)).toBe(false);
  });
  it("fitBudget's idle demotion never cold-shrinks pinned building/furniture art: unpinned idle art pays first", async () => {
    const gl = { canvas: undefined, getParameter: () => 4096, isContextLost: () => false, getError: () => 0 } as never;
    const a = new AtlasManager(gl, { registerLoader: () => {} } as never, { textureBudgetMB: 9 }) as any;
    a.atlases = []; a.coldDownscale = 1; a.downscale = 1; a.recentlyUsed.add("characters");
    const rt = (key: string, w: number): any => ({ key, img: { width: w, height: w }, emis: null, masks: {}, scale: 1, cold: false });
    const list = [rt("buildings", 1024), rt("furniture", 1024), rt("decor", 1024)];
    let last: any[] = []; a.pack = (l: any[]) => { last = l; }; a.planEstimate = () => last.reduce((t, x) => t + x.img.width * x.img.height * 4, 0); a.estimate = a.planEstimate;
    // 1024^2 RGBA8 = 4 MB each; budget 9 MB only fits the two pinned sheets at 1x plus decor cold at 0.25 (0.25 MB)
    await a.fitBudget(list, 0, 0);
    expect(list[0]!.cold).toBe(false); expect(list[1]!.cold).toBe(false); expect(list[2]!.cold).toBe(true);
    expect(last.find((x: any) => x.key === "buildings")!.img.width).toBe(1024);
  });
  it("Canvas2D fallback uses full DPR only on Full, and keeps the 1.5x cap otherwise", () => {
    const canvas = { width: 0, height: 0 } as unknown as HTMLCanvasElement;
    const r = new Canvas2DRenderer(canvas, {} as unknown as CanvasRenderingContext2D);
    r.resize(100, 50, 3);
    expect(canvas.width).toBe(150);
    r.setQualityPreset("full");
    r.resize(100, 50, 3);
    expect(canvas.width).toBe(300);
    expect(canvas.height).toBe(150);
    expect(r.camera.dpr).toBe(3);
    r.setQualityPreset("auto");
    r.resize(100, 50, 3);
    expect(canvas.width).toBe(150);
  });
});

describe("ADR-408: Auto is the default preset on every device", () => {
  const store = new Map<string, string>();
  const stub = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const prev = (globalThis as Record<string, unknown>).localStorage;
  const withStorage = (fn: () => void): void => { (globalThis as Record<string, unknown>).localStorage = stub; try { fn(); } finally { (globalThis as Record<string, unknown>).localStorage = prev; } };
  it("DEFAULT_QUALITY_PRESET is auto; a fresh install (nothing stored) loads Auto", () => {
    expect(DEFAULT_QUALITY_PRESET).toBe("auto");
    withStorage(() => { store.clear(); expect(loadPreset()).toBe("auto"); expect(new QualityController().preset).toBe("auto"); expect(new QualityController().fullResolution).toBe(false); });
  });
  it("a stored choice is always kept — only the default changes", () => {
    withStorage(() => {
      for (const p of ["auto", "low", "medium", "high", "ultra", "full"] as const) { savePreset(p); expect(loadPreset()).toBe(p); }
      store.set(PRESET_STORAGE_KEY, "nonsense"); expect(loadPreset()).toBe("auto"); // unparseable stored value falls back to the default
    });
  });
});
