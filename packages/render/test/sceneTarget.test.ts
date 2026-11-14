/** Scene FBO completeness ladder (ANGLE/D3D11 basic adapters report UNSUPPORTED for some depth formats) + basic adapter detection. */
import { describe, it, expect } from "vitest";
import { buildSceneTarget, isBasicAdapter, isConsole } from "../src/gl/sceneTarget.js";
import { detectCapabilities } from "../src/gl/capabilities.js";

const C = { FRAMEBUFFER: 1, RENDERBUFFER: 2, TEXTURE_2D: 3, COLOR_ATTACHMENT0: 10, COLOR_ATTACHMENT1: 11, DEPTH_ATTACHMENT: 12, DEPTH_STENCIL_ATTACHMENT: 13,
  DEPTH_COMPONENT24: 20, DEPTH_COMPONENT16: 21, DEPTH24_STENCIL8: 22, FRAMEBUFFER_COMPLETE: 0x8cd5, FRAMEBUFFER_UNSUPPORTED: 0x8cdd };
function mock(ok: (fmt: number | null) => boolean) {
  let fmt: number | null = null; let deleted = 0;
  const gl = { ...C, createFramebuffer: () => { fmt = null; return {}; }, createRenderbuffer: () => ({}), bindFramebuffer() {}, bindRenderbuffer() {}, framebufferTexture2D() {},
    renderbufferStorage: (_t: number, f: number) => { fmt = f; }, framebufferRenderbuffer() {}, deleteFramebuffer: () => { deleted++; }, deleteRenderbuffer() {},
    checkFramebufferStatus: () => (ok(fmt) ? C.FRAMEBUFFER_COMPLETE : C.FRAMEBUFFER_UNSUPPORTED) };
  return { gl: gl as unknown as WebGL2RenderingContext, deleted: () => deleted };
}
const T = {} as WebGLTexture;

describe("scene target ladder", () => {
  it("D24 complete: used directly", () => { const m = mock(() => true); expect(buildSceneTarget(m.gl, T, T, 100, 100, false).depth).toBe("DEPTH_COMPONENT24"); });
  it("D24/D16 UNSUPPORTED -> DEPTH24_STENCIL8", () => {
    const m = mock((f) => f === C.DEPTH24_STENCIL8); const t = buildSceneTarget(m.gl, T, T, 1728, 851, false);
    expect(t.depth).toBe("DEPTH24_STENCIL8"); expect(t.status).toBe(C.FRAMEBUFFER_COMPLETE); expect(t.tried.length).toBe(3); expect(m.deleted()).toBe(2);
  });
  it("every depth format UNSUPPORTED -> no depth (world still draws)", () => {
    const t = buildSceneTarget(mock((f) => f === null).gl, T, T, 1728, 851, false); expect(t.depth).toBe("none"); expect(t.depthRb).toBeNull(); expect(t.status).toBe(C.FRAMEBUFFER_COMPLETE);
  });
  it("nothing complete: returns last attempt incomplete (caller faults to safe)", () => { expect(buildSceneTarget(mock(() => false).gl, T, T, 8, 8, true).status).toBe(C.FRAMEBUFFER_UNSUPPORTED); });
});

describe("basic adapter detection", () => {
  it.each(["ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)", "llvmpipe (LLVM 15.0.7, 256 bits)"])("%s", (r) => expect(isBasicAdapter(r)).toBe(true));
  it.each(["ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)", "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)", "Adreno (TM) 740", "ANGLE (Microsoft, SraKmd_arden (0x0000D000) Direct3D11 vs_5_0 ps_5_0, D3D11)"])("not %s", (r) => expect(isBasicAdapter(r)).toBe(false));
  it("Xbox SraKmd: console High (256 MB streamed, <=1080p); ?gl=high after loss is the same tier", () => {
    const P: Record<number, unknown> = { 100: "ANGLE (Microsoft, SraKmd_arden (0x0000D000) Direct3D11 vs_5_0 ps_5_0, D3D11)" };
    const gl = { MAX_VIEWPORT_DIMS: 4, FRAGMENT_SHADER: 20, VERTEX_SHADER: 21, HIGH_FLOAT: 22, getParameter: (n: number) => P[n] ?? (n === 4 ? new Int32Array([16384, 16384]) : 16),
      getExtension: (n: string) => (n === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL: 100, UNMASKED_VENDOR_WEBGL: 101 } : null),
      getShaderPrecisionFormat: () => ({ precision: 23 }) } as unknown as WebGL2RenderingContext;
    const c = detectCapabilities(gl, { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141" });
    // ADR-407: consoles start High (256 MB / 1080p) — ultra's 448 MB atlas + 4K targets do not fit the 1 GB UWP app cap
    expect(c.console).toBe(true); expect(c.basicAdapter).toBe(false); expect(c.lowEnd).toBe(false); expect(c.safe).toBe(false); expect(c.textureBudgetMB).toBe(256); expect(c.maxPixels).toBe(1920 * 1080);
    expect(c.device.klass).toBe("console"); expect(c.device.start).toBe(2); expect(c.device.ceiling).toBe(2); expect(c.formats.scene).toBe("RGBA8");
    // after a context loss gl-recovery passes ?gl=high: same High tier (it used to be the recovery tier; now it is the default)
    const h = detectCapabilities(gl, { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141", flags: ["high"] });
    expect(h.lowEnd).toBe(false); expect(h.device.start).toBe(2); expect(h.device.ceiling).toBe(2); expect(h.textureBudgetMB).toBe(256); expect(h.maxPixels).toBe(1920 * 1080);
  });
});

describe("console detection", () => { it("Xbox UA or SraKmd", () => { expect(isConsole("ANGLE (Intel)", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox Series X) Edg/141")).toBe(true); expect(isConsole("SraKmd_arden", "")).toBe(true); expect(isConsole("ANGLE (NVIDIA)", "Windows NT 10.0 Chrome")).toBe(false); }); });
