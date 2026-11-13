/** Thin WebGL2 helpers: shader compilation and per-frame stats. */
import { annotateShaderLog, toMediump, type RenderError } from "./capabilities.js";

/** Error with a structured RenderError (shown by the client's error overlay). */
export class RenderGLError extends Error {
  constructor(readonly info: RenderError) { super(info.detail ? `${info.message}\n${info.detail}` : info.message); this.name = "RenderGLError"; }
}
/** Per-context shader policy: fragment shaders are rewritten to mediump when highp is unavailable or forced. */
const fragMediump = new WeakMap<WebGL2RenderingContext, boolean>();
export function setFragmentMediump(gl: WebGL2RenderingContext, on: boolean): void { fragMediump.set(gl, on); }
export interface FrameStats { drawCalls: number; sprites: number; lights: number; tiles: number; chunks: number; particles: number; staticChunks: number; staticInstances: number; cpuMs: number; /** ADR-381: last frame's per-phase render CPU (ms); shared record, see PhaseTimer. */ phases?: RenderPhaseMs }
/** ADR-381: per-phase CPU inside IsoRenderer.render() — the phone's `frame cpu` is one number (15.7 ms at 22 draws),
 *  which cannot say whether the time is prep, sprite gather, light, bloom or composite. These splits are the
 *  measurement that answers that on the phone via ?diag=1. */
export interface RenderPhaseMs { prep: number; sprites: number; upload: number; lightsPrep: number; scene: number; light: number; bloom: number; composite: number; weather: number }
export const newPhaseMs = (): RenderPhaseMs => ({ prep: 0, sprites: 0, upload: 0, lightsPrep: 0, scene: 0, light: 0, bloom: 0, composite: 0, weather: 0 });
/** Cheap per-phase wall clock: one reused record, no per-frame allocation. Callers pass performance.now()
 *  readings (so the class is unit-testable with synthetic timestamps); split(name) records the ms since the
 *  previous split/start. A phase that did not run this frame keeps its last value — callers zero it explicitly. */
export class PhaseTimer {
  readonly ms: RenderPhaseMs = newPhaseMs();
  private last = 0;
  start(now: number): void { this.last = now; }
  split(name: keyof RenderPhaseMs, now: number): void { this.ms[name] = now - this.last; this.last = now; }
  zero(name: keyof RenderPhaseMs): void { this.ms[name] = 0; }
}
export const newStats = (): FrameStats => ({ drawCalls: 0, sprites: 0, lights: 0, tiles: 0, chunks: 0, particles: 0, staticChunks: 0, staticInstances: 0, cpuMs: 0 });

export function compile(gl: WebGL2RenderingContext, type: number, src: string, label: string): WebGLShader {
  const s = gl.createShader(type);
  if (!s) throw new Error("createShader failed");
  if (type === gl.FRAGMENT_SHADER && fragMediump.get(gl)) src = toMediump(src);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s) ?? "";
    const where = annotateShaderLog(src, log);
    console.error(`[render] ${label} shader compile error:\n${log}\n${where}`);
    throw new RenderGLError({ kind: "shader", message: `[${label}] shader compile error: ${log.split("\n")[0] ?? ""}`, detail: `${log}\n${where}` });
  }
  return s;
}

export interface Program { prog: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }

export function createProgram(gl: WebGL2RenderingContext, vs: string, fs: string, label: string): Program {
  const prog = gl.createProgram();
  if (!prog) throw new Error("createProgram failed");
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs, label + ".vs"));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs, label + ".fs"));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) ?? ""; console.error(`[render] ${label} link error: ${log}`);
    throw new RenderGLError({ kind: "link", message: `[${label}] program link error: ${log}` });
  }
  const u: Record<string, WebGLUniformLocation | null> = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i);
    if (info) u[info.name.replace(/\[0\]$/, "")] = gl.getUniformLocation(prog, info.name);
  }
  return { prog, u };
}

/** Shared GLSL: camera transform from iso px to clip space, and the depth mapping. */
export const GLSL_COMMON = /* glsl */ `
uniform vec4 uView;   // (camX, camY, 2*zoom/w, -2*zoom/h)
uniform vec2 uDepth;  // (keyMin, 1/keyRange)
vec2 isoToClip(vec2 iso) { return (iso - uView.xy) * uView.zw; }
float keyToNdc(float key) { return 1.0 - 2.0 * clamp((key - uDepth.x) * uDepth.y, 0.0, 1.0) * 0.999; }
`;

export function createTexture(gl: WebGL2RenderingContext, w: number, h: number, internal: number, format: number, type: number, filter: number): WebGLTexture {
  const t = gl.createTexture();
  if (!t) throw new Error("createTexture failed");
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** checkFramebufferStatus with a readable name; throws RenderGLError (kind "fbo") when incomplete. */
export function assertFramebuffer(gl: WebGL2RenderingContext, label: string): void {
  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (st === gl.FRAMEBUFFER_COMPLETE) return;
  const names: Record<number, string> = { [gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT]: "INCOMPLETE_ATTACHMENT", [gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT]: "MISSING_ATTACHMENT", [gl.FRAMEBUFFER_INCOMPLETE_DIMENSIONS]: "INCOMPLETE_DIMENSIONS", [gl.FRAMEBUFFER_UNSUPPORTED]: "UNSUPPORTED", [gl.FRAMEBUFFER_INCOMPLETE_MULTISAMPLE]: "INCOMPLETE_MULTISAMPLE" };
  const msg = `${label} framebuffer incomplete: ${names[st] ?? "0x" + st.toString(16)}`; console.error("[render] " + msg);
  throw new RenderGLError({ kind: "fbo", message: msg });
}

/** Colour render target (texture + FBO) with completeness check; RGBA8 is the universal fallback. */
export function createColorTarget(gl: WebGL2RenderingContext, w: number, h: number, filter: number, label: string, internal: number = gl.RGBA8): { tex: WebGLTexture; fbo: WebGLFramebuffer; internal: number } {
  const attempt = (fmt: number): { tex: WebGLTexture; fbo: WebGLFramebuffer } | null => {
    const type = fmt === gl.RGBA16F ? gl.HALF_FLOAT : fmt === gl.RGBA32F ? gl.FLOAT : gl.UNSIGNED_BYTE;
    const tex = createTexture(gl, w, h, fmt, gl.RGBA, type, filter);
    const fbo = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) return { tex, fbo };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fbo); gl.deleteTexture(tex); return null;
  };
  let r = internal !== gl.RGBA8 ? attempt(internal) : null; let used = internal;
  if (!r) { if (internal !== gl.RGBA8) console.warn(`[render] ${label}: 0x${internal.toString(16)} target incomplete, falling back to RGBA8`); r = attempt(gl.RGBA8); used = gl.RGBA8; }
  if (!r) { assertFramebuffer(gl, label); throw new RenderGLError({ kind: "fbo", message: `${label} RGBA8 target incomplete` }); }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { ...r, internal: used };
}
