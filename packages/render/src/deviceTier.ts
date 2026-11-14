/**
 * ADR-116 device tiering: probe-based Auto start tier (not UA-only). Powerful devices (desktop dGPU) start MAXED
 * (ultra); consoles start high (ADR-407: the 1 GB UWP app cap leaves no room for ultra — 448 MB atlas + 4K
 * targets ≈ 564 MB before the JS heap); integrated GPUs start high; phones / weak devices keep the conservative
 * starts; software adapters start low.
 * Inputs: renderer string, MAX_TEXTURE_SIZE, hardwareConcurrency, deviceMemory, RGBA8 FBO check, plus first-seconds frame
 * timing (see QualityController bench). A tier that ran well is remembered per device (localStorage) unless a context loss
 * happened on it.
 */
import { isBasicAdapter, isConsole } from "./gl/sceneTarget.js";

export type TierName = "low" | "medium" | "high" | "ultra";
export const TIER_NAMES: readonly TierName[] = ["low", "medium", "high", "ultra"];
export type DeviceClass = "desktop-dgpu" | "desktop-igpu" | "desktop-unknown" | "console" | "mobile-high" | "mobile" | "software";

export interface DeviceProbe {
  renderer: string; userAgent: string; maxTextureSize: number;
  /** navigator.hardwareConcurrency (0 = unknown) */ cores?: number;
  /** navigator.deviceMemory GB (0/undefined = unknown; Chrome caps the value at 8) */ memoryGB?: number;
  /** touch-first Mac UA = iPad */ touchPoints?: number;
  /** an RGBA8 colour+depth FBO completed (scene ladder) */ fboOk?: boolean;
}
export interface DeviceTier { klass: DeviceClass; start: number; /** governor never goes above this */ ceiling: number; name: TierName; reasons: string[] }

const DGPU = /nvidia|geforce|quadro|rtx|gtx|radeon\s*(rx|pro|r9|vii)|radeon\(tm\)\s*rx|intel.*\barc\b|\barc a\d/i;
const IGPU = /intel|uhd|iris|hd graphics|radeon\(tm\)\s*graphics|radeon graphics|vega \d+ graphics|adreno.*(x1|8cx)|mali-g\d+ mc|microsoft.*qualcomm/i;
const APPLE_M = /apple m\d/i;
const MOBILE_GPU = /adreno|mali|powervr|apple gpu|apple a\d|videocore|tegra|immortalis|xclipse|maleoon/i;
const MOBILE_UA = /android|iphone|ipad|ipod|mobile/i;
const HIGH_MOBILE = /apple gpu|apple a1[5-9]|immortalis|adreno.*(7[3-9]\d|8\d\d)|xclipse/i;

/** Pure: pick the Auto start tier + ceiling for a probed device. */
export function classifyDevice(p: DeviceProbe): DeviceTier {
  const r = p.renderer || ""; const ua = p.userAgent || ""; const reasons: string[] = [];
  const cores = p.cores || 0, mem = p.memoryGB || 0, tex = p.maxTextureSize || 0;
  const mk = (klass: DeviceClass, start: number, ceiling: number): DeviceTier => ({ klass, start, ceiling, name: TIER_NAMES[start]!, reasons });
  if (isBasicAdapter(r)) { reasons.push(`software/basic adapter (${r.slice(0, 40)})`); return mk("software", 0, 1); }
  if (p.fboOk === false) { reasons.push("RGBA8 scene FBO incomplete"); return mk("software", 0, 1); }
  // ADR-407: consoles start HIGH, not ultra. Edge on Xbox is a UWP app capped at 1 GB foreground memory
  // (Microsoft Learn: UWP system resources on Xbox); ultra's 448 MB atlas + ~116 MB of 4K targets is
  // ~564 MB before the ~344 MB JS heap and Edge's own overhead — the boot peak trips the sandbox limit
  // (SBOX_FATAL_MEMORY_EXCEEDED). High is 256 MB atlas + ~29 MB of 1080p targets (~285 MB GPU set),
  // inside the cap with room; the art is no blurrier (same 0.25x atlas downscale in emulation).
  if (isConsole(r, ua)) { reasons.push("console browser: high tier — 1 GB UWP app memory cap leaves no room for ultra (448 MB atlas + 4K targets)"); return mk("console", 2, 2); }
  const mobile = MOBILE_GPU.test(r) && !APPLE_M.test(r) || MOBILE_UA.test(ua) || (/macintosh/i.test(ua) && (p.touchPoints ?? 0) > 1);
  if (mobile) {
    if (HIGH_MOBILE.test(r) || /iphone|ipad/i.test(ua)) { reasons.push("high-end phone/tablet GPU: conservative high start"); return mk("mobile-high", 2, 2); }
    reasons.push("mobile GPU: conservative medium start"); return mk("mobile", 1, 2);
  }
  const weakCpu = cores > 0 && cores < 4, weakMem = mem > 0 && mem < 4, smallTex = tex > 0 && tex < 8192;
  if (weakCpu) reasons.push(`${cores} cores`); if (weakMem) reasons.push(`${mem} GB memory`); if (smallTex) reasons.push(`MAX_TEXTURE_SIZE ${tex}`);
  const weak = weakCpu || weakMem || smallTex;
  if (DGPU.test(r) || APPLE_M.test(r)) { reasons.push(`discrete/strong GPU (${r.slice(0, 40)})`); return weak ? mk("desktop-dgpu", 2, 3) : mk("desktop-dgpu", 3, 3); }
  if (IGPU.test(r)) { reasons.push(`integrated GPU (${r.slice(0, 40)}): high, not ultra`); return mk("desktop-igpu", weak ? 1 : 2, 2); }
  reasons.push(`unknown/masked desktop GPU (${r.slice(0, 40) || "no renderer string"}): high, bench may promote`);
  return mk("desktop-unknown", weak ? 1 : 2, 3);
}

/** First-seconds frame timing: median frame ms of a warm window -> promote/demote one step. */
export function benchAdjust(t: DeviceTier, medianMs: number): number {
  if (!(medianMs > 0)) return t.start;
  if (medianMs < 9 && t.start < t.ceiling && (t.klass === "desktop-unknown" || t.klass === "desktop-dgpu")) return t.start + 1;
  if (medianMs > 25 && t.start > 0) return t.start - 1;
  return t.start;
}

/** Per-device memory of a tier that ran well (localStorage), invalidated by a context loss on this device. */
export const DEVICE_TIER_KEY = "survivaz.render.deviceTier";
interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void }
const ls = (): KV | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };
export function deviceSignature(p: Pick<DeviceProbe, "renderer" | "userAgent">): string { let h = 2166136261; for (const c of `${p.renderer}|${p.userAgent}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0).toString(36); }
interface Saved { sig: string; level: number; lost?: boolean }
const read = (s: KV | null): Saved | null => { try { const v = JSON.parse(s?.getItem(DEVICE_TIER_KEY) ?? "null"); return v && typeof v.sig === "string" && Number.isInteger(v.level) ? v : null; } catch { return null; } };
/** Remembered level for this device, or null (none / other device / last session lost the context). */
export function rememberedLevel(sig: string, s: KV | null = ls()): number | null { const v = read(s); return v && v.sig === sig && !v.lost ? v.level : null; }
export function rememberLevel(sig: string, level: number, s: KV | null = ls()): void { try { s?.setItem(DEVICE_TIER_KEY, JSON.stringify({ sig, level })); } catch { /* quota/private */ } }
/** A context loss: forget the good tier (next start re-probes, capped by the gl-recovery level). */
export function markContextLost(s: KV | null = ls()): void { const v = read(s); try { s?.setItem(DEVICE_TIER_KEY, JSON.stringify({ sig: v?.sig ?? "", level: v?.level ?? 0, lost: true })); } catch { /* */ } }

/** Start level: remembered (clamped to ceiling) else probe start; capped by `maxLevel` (gl-recovery "high" = 2). */
export function startLevel(t: DeviceTier, sig: string, maxLevel = 3, s: KV | null = ls()): { level: number; remembered: boolean } {
  const r = rememberedLevel(sig, s); const lvl = r !== null ? Math.min(r, t.ceiling) : t.start;
  return { level: Math.max(0, Math.min(lvl, maxLevel)), remembered: r !== null };
}
