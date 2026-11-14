// ADR-407: Xbox SBOX_FATAL_MEMORY_EXCEEDED at asset-load start.
// Tracey's Xbox Series X Edge kills the page while game assets load. Mechanism (measured):
//  - Microsoft's UWP-on-Xbox doc caps foreground APPS at 1 GB (games 5 GB); Edge on Xbox is a
//    UWP app, so the whole tab (JS heap + GPU set + Edge overhead) must fit ~1 GB. The code's
//    "~512 MB GPU process" assumption (capabilities.ts) is the wrong frame — the cap is per app.
//  - Console was locked to ultra (classifyDevice console -> start 3, ceiling 3): 448 MB atlas
//    budget + ~116 MB of 4K render targets = ~564 MB GPU-side before the JS heap. ADR-212
//    already budgets the console JS heap at 384 MB soft — 564 + 384 = 948 MB leaves ~76 MB
//    for Edge itself. The boot peak (manifest parse + atlas warm-up + targets, all at once)
//    trips the sandbox limit: SBOX_FATAL_MEMORY_EXCEEDED.
//  - Measured in emulation (live build, SraKmd stub + Xbox UA, xbox407-probe.mjs): console
//    ultra boots to vram total 341.3 MB (budget 448) with JS heap 326 MB at spawn, 344 MB
//    after 30 s; the same boot at the high tier (?gl=high) is vram total 193.3 MB (budget
//    256) at the SAME atlas downscale 0.25 — the art is no blurrier, the building pools are
//    even at a higher scale (1 vs 0.5). GPU set at 4K output: ~457 MB ultra -> ~222 MB high.
//  - The fix: consoles start at high (start 2, ceiling 2) — 256 MB atlas, <=1080p targets
//    (~29 MB) — and the default Full preset can no longer re-open native-res targets on a
//    console (fullResolution is false for console). Desktop/mobile are untouched: their
//    tiers, budgets and Full-preset behaviour are asserted unchanged below.
//  - Honest costs, stated plainly: Xbox renders at <=1080p instead of 4K, and character
//    paper-doll pools use the KTX2 compressed tail at 256 MB instead of lossless PNG
//    (losslessCharPools(256) is false; ADR-220 measured ~10% of texels >32 off). The probe's
//    close-ups show no visible smearing at play zoom, but the real-Xbox severity needs
//    Tracey's eyes. A game that runs at 1080p beats a game that crashes at boot.
//  - What this does NOT claim: SBOX itself cannot be reproduced without a real Xbox sandbox;
//    the fix is proven at code level + emulation, and the live re-probe + Tracey's Xbox
//    retest after the push are the real check.
import { describe, expect, it } from "vitest";
import { classifyDevice, benchAdjust, deviceSignature, rememberLevel, startLevel, type DeviceProbe } from "../src/deviceTier.js";
import { detectCapabilities, renderTargetBytes } from "../src/gl/capabilities.js";
import { QualityController, QUALITY_TIERS } from "../src/quality.js";

const XBOX_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox Series X) Edg/130";
const SRA = "ANGLE (SraKmd, AMD Radeon Graphics (RADV), Direct3D11 vs_5_0 ps_5_0, D3D11)";
const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36 Edg/130";

const E = { MAX_TEXTURE_SIZE: 1, MAX_ARRAY_TEXTURE_LAYERS: 2, MAX_RENDERBUFFER_SIZE: 3, MAX_VIEWPORT_DIMS: 4, MAX_TEXTURE_IMAGE_UNITS: 5, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 6,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 7, MAX_VERTEX_ATTRIBS: 8, MAX_FRAGMENT_UNIFORM_VECTORS: 9, MAX_VERTEX_UNIFORM_VECTORS: 10, MAX_DRAW_BUFFERS: 11, MAX_COLOR_ATTACHMENTS: 12,
  RENDERER: 13, VENDOR: 14, FRAGMENT_SHADER: 20, VERTEX_SHADER: 21, HIGH_FLOAT: 22 } as const;
function mockGl(renderer: string): WebGL2RenderingContext {
  const P: Record<number, unknown> = { [E.MAX_TEXTURE_SIZE]: 16384, [E.MAX_ARRAY_TEXTURE_LAYERS]: 2048, [E.MAX_RENDERBUFFER_SIZE]: 16384, [E.MAX_VIEWPORT_DIMS]: new Int32Array([16384, 16384]),
    [E.MAX_TEXTURE_IMAGE_UNITS]: 16, [E.MAX_VERTEX_TEXTURE_IMAGE_UNITS]: 16, [E.MAX_COMBINED_TEXTURE_IMAGE_UNITS]: 32, [E.MAX_VERTEX_ATTRIBS]: 16,
    [E.MAX_FRAGMENT_UNIFORM_VECTORS]: 1024, [E.MAX_VERTEX_UNIFORM_VECTORS]: 1024, [E.MAX_DRAW_BUFFERS]: 8, [E.MAX_COLOR_ATTACHMENTS]: 8, [E.RENDERER]: renderer, [E.VENDOR]: "WebKit" };
  const ext = new Set(["EXT_color_buffer_float", "EXT_color_buffer_half_float", "OES_texture_float_linear"]);
  return { ...E, getParameter: (n: number) => P[n] ?? (n === 100 ? renderer : undefined), getExtension: (n: string) => (n === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL: 100, UNMASKED_VENDOR_WEBGL: 14 } : ext.has(n) ? {} : null),
    getShaderPrecisionFormat: (st: number) => ({ rangeMin: 127, rangeMax: 127, precision: st === E.FRAGMENT_SHADER ? 23 : 23 }) } as unknown as WebGL2RenderingContext;
}
const kv = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };

describe("ADR-407 console memory: Xbox starts at high, not ultra", () => {
  const probe: DeviceProbe = { renderer: SRA, userAgent: XBOX_UA, maxTextureSize: 16384, cores: 8, memoryGB: 8 };
  it("classifyDevice: console starts high with a high ceiling (never ultra)", () => {
    const t = classifyDevice(probe);
    expect(t.klass).toBe("console");
    expect(QUALITY_TIERS[t.start]!.name).toBe("high"); expect(t.start).toBe(2);
    expect(QUALITY_TIERS[t.ceiling]!.name).toBe("high"); expect(t.ceiling).toBe(2);
    expect(t.reasons.join(" ")).toMatch(/1 GB|UWP|memory cap/i);
  });
  it("detectCapabilities: console gets the 256 MB / <=1080p caps, not 448 MB / 4K", () => {
    const c = detectCapabilities(mockGl(SRA), { userAgent: XBOX_UA, cores: 8, memoryGB: 8 });
    expect(c.console).toBe(true); expect(c.basicAdapter).toBe(false); expect(c.lowEnd).toBe(false);
    expect(c.device.klass).toBe("console"); expect(c.device.start).toBe(2); expect(c.device.ceiling).toBe(2);
    expect(c.textureBudgetMB).toBe(256); expect(c.maxPixels).toBe(1920 * 1080); expect(c.maxDpr).toBe(3);
    expect(c.fallbacks.join("|")).toMatch(/256 MB/); expect(c.fallbacks.join("|")).toMatch(/<=1080p/);
    expect(c.fallbacks.join("|")).not.toMatch(/448 MB/);
  });
  it("a console that once remembered ultra is clamped back to high by the ceiling", () => {
    const s = kv(); const t = classifyDevice(probe); const sig = deviceSignature(probe);
    rememberLevel(sig, 3, s);
    expect(startLevel(t, sig, 3, s)).toEqual({ level: 2, remembered: true });
  });
  it("the frame-time bench never promotes a console back to ultra", () => {
    expect(benchAdjust(classifyDevice(probe), 5)).toBe(2); // fast frames: stays high, never climbs to ultra
    expect(benchAdjust(classifyDevice(probe), 40)).toBe(1); // slow frames may still demote one step (fine)
  });
  it("the default Full preset cannot re-open native-res targets on a console", () => {
    const q = new QualityController("full");
    q.configure({ klass: "console", name: "high", start: 2, ceiling: 2, remembered: false, reasons: [] });
    expect(q.fullResolution).toBe(false);
    // ...but Full still means native res on a desktop dGPU (ceiling 3): untouched.
    const d = new QualityController("full");
    d.configure({ klass: "desktop-dgpu", name: "ultra", start: 3, ceiling: 3, remembered: false, reasons: [] });
    expect(d.fullResolution).toBe(true);
  });
  it("the console GPU set fits the 512 MB design budget (atlas + targets), with room for the JS heap", () => {
    const c = detectCapabilities(mockGl(SRA), { userAgent: XBOX_UA, cores: 8, memoryGB: 8 });
    expect(c.maxPixels).toBe(1920 * 1080);
    // Target bytes match the code's own accounting: 4K targets were ~116 MB, 1080p targets ~29 MB.
    expect(renderTargetBytes(3840, 2160) / 1e6).toBeCloseTo(116.1, 0);
    expect(renderTargetBytes(1920, 1080) / 1e6).toBeCloseTo(29.0, 0);
    // High tier: 256 MB atlas + ~29 MB targets ≈ 285 MB — fits 512 MB, leaving the rest of the
    // 1 GB UWP app cap for the JS heap (ADR-212 console soft budget 384 MB) and Edge itself.
    expect(c.textureBudgetMB + renderTargetBytes(1920, 1080) / 1e6).toBeLessThanOrEqual(512);
    // ...and the old ultra set did NOT fit: 448 MB atlas + ~116 MB of 4K targets ≈ 564 MB, before the heap.
    expect(448 + renderTargetBytes(3840, 2160) / 1e6).toBeGreaterThan(512);
  });
  it("non-console tiers are untouched: desktop dGPU stays ultra, capable mobile stays 256 MB", () => {
    const dgpu = detectCapabilities(mockGl("ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11)"), { userAgent: WIN, cores: 16, memoryGB: 8 });
    expect(dgpu.device.klass).toBe("desktop-dgpu"); expect(dgpu.device.start).toBe(3); expect(dgpu.textureBudgetMB).toBe(1024); expect(dgpu.maxPixels).toBe(3840 * 2160);
    const mobile = detectCapabilities(mockGl("Mali-G68"), { userAgent: "Mozilla/5.0 (Linux; Android 14; SM-A166U) Chrome/130 Mobile Safari/537.36", cores: 8, memoryGB: 4 });
    expect(mobile.mobile).toBe(true); expect(mobile.textureBudgetMB).toBe(256);
  });
});
