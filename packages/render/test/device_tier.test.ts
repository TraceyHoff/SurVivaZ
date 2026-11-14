import { describe, expect, it } from "vitest";
import { benchAdjust, classifyDevice, deviceSignature, markContextLost, rememberLevel, startLevel, type DeviceProbe } from "../src/deviceTier.js";
import { QualityController, QualityGovernor, QUALITY_TIERS } from "../src/quality.js";

const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36 Edg/130";
const M: Record<string, [DeviceProbe, string, string, string]> = {
  // probe, expected class, start, ceiling
  "desktop dGPU": [{ renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)", userAgent: WIN, maxTextureSize: 16384, cores: 16, memoryGB: 8 }, "desktop-dgpu", "ultra", "ultra"],
  "desktop AMD dGPU": [{ renderer: "ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11)", userAgent: WIN, maxTextureSize: 16384, cores: 12, memoryGB: 8 }, "desktop-dgpu", "ultra", "ultra"],
  "Apple M-series": [{ renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTextureSize: 16384, cores: 8, memoryGB: 8 }, "desktop-dgpu", "ultra", "ultra"],
  "desktop iGPU": [{ renderer: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)", userAgent: WIN, maxTextureSize: 16384, cores: 8, memoryGB: 8 }, "desktop-igpu", "high", "high"],
  "dGPU on weak CPU": [{ renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1050)", userAgent: WIN, maxTextureSize: 16384, cores: 2, memoryGB: 4 }, "desktop-dgpu", "high", "ultra"],
  "masked desktop": [{ renderer: "WebKit WebGL", userAgent: WIN, maxTextureSize: 16384, cores: 8 }, "desktop-unknown", "high", "ultra"],
  "Xbox Edge": [{ renderer: "ANGLE (Microsoft, SraKmd, D3D11)", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox Series X) Edg/130", maxTextureSize: 16384, cores: 8, memoryGB: 8 }, "console", "high", "high"],
  "Android Mali": [{ renderer: "Mali-G57 MC2", userAgent: "Mozilla/5.0 (Linux; Android 13; SM-A136B) Chrome/130 Mobile", maxTextureSize: 8192, cores: 8, memoryGB: 4 }, "mobile", "medium", "high"],
  "iPhone": [{ renderer: "Apple GPU", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1", maxTextureSize: 16384, cores: 6 }, "mobile-high", "high", "high"],
  "software": [{ renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)", userAgent: WIN, maxTextureSize: 8192, cores: 4 }, "software", "low", "medium"],
  "basic render": [{ renderer: "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11)", userAgent: WIN, maxTextureSize: 16384, cores: 8 }, "software", "low", "medium"],
  "FBO fails": [{ renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4090)", userAgent: WIN, maxTextureSize: 16384, cores: 32, fboOk: false }, "software", "low", "medium"],
};
const kv = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };

describe("ADR-116 tier selection matrix", () => {
  for (const [name, [p, klass, start, ceil]] of Object.entries(M)) it(name, () => {
    const t = classifyDevice(p); expect(t.klass).toBe(klass); expect(QUALITY_TIERS[t.start]!.name).toBe(start); expect(QUALITY_TIERS[t.ceiling]!.name).toBe(ceil); expect(t.reasons.length).toBeGreaterThan(0);
  });
  it("bench: fast masked desktop promotes to ultra; slow start demotes; iGPU never above high", () => {
    expect(benchAdjust(classifyDevice(M["masked desktop"]![0]), 6)).toBe(3); expect(benchAdjust(classifyDevice(M["desktop dGPU"]![0]), 40)).toBe(2);
    expect(benchAdjust(classifyDevice(M["desktop iGPU"]![0]), 5)).toBe(2);
  });
  it("remembers a good tier per device unless the context was lost", () => {
    const s = kv(); const t = classifyDevice(M["masked desktop"]![0]); const sig = deviceSignature(M["masked desktop"]![0]);
    expect(startLevel(t, sig, 3, s)).toEqual({ level: 2, remembered: false });
    rememberLevel(sig, 3, s); expect(startLevel(t, sig, 3, s)).toEqual({ level: 3, remembered: true });
    expect(startLevel(t, "other", 3, s).remembered).toBe(false); expect(startLevel(t, sig, 2, s).level).toBe(2); // gl-recovery "high" cap
    markContextLost(s); expect(startLevel(t, sig, 3, s)).toEqual({ level: 2, remembered: false });
  });
});

const run = (g: { feed(d: number): boolean }, ms: number, dt: number) => { let c = 0; for (let t = 0; t < ms; t += dt) if (g.feed(dt)) c++; return c; };
describe("ADR-116 governor hysteresis", () => {
  it("short drops (<5 s below 50 fps) never step down", () => { const g = new QualityGovernor(3); for (let i = 0; i < 10; i++) { run(g, 3000, 25); run(g, 4000, 16.7); } expect(g.level).toBe(3); });
  it("sustained drops below 50 fps step down after ~5 s, one level, then cooldown", () => {
    const g = new QualityGovernor(3); expect(run(g, 4500, 24)).toBe(0); expect(run(g, 3000, 24)).toBe(1); expect(g.level).toBe(2);
  });
  it("55 fps sits in the dead band: no change either way", () => { const g = new QualityGovernor(2); expect(run(g, 60000, 18)).toBe(0); expect(g.level).toBe(2); });
  it("steps back up when headroom returns, respects the ceiling, and retries a failed level only slowly", () => {
    const g = new QualityGovernor(3, { ceiling: 3 }); run(g, 12000, 24); expect(g.level).toBe(2);
    run(g, 15000, 8); expect(g.level).toBe(2); // 4x up time before retrying the level that failed
    run(g, 40000, 8); expect(g.level).toBe(3);
    const c = new QualityGovernor(0, { ceiling: 2 }); run(c, 120000, 5); expect(c.level).toBe(2);
  });
  it("controller: configure starts Auto at the probed tier; Auto label; stable tier reported once", () => {
    const q = new QualityController("auto"); let saved = -1; q.onStable = (l) => { saved = l; };
    q.configure({ klass: "console", name: "ultra", start: 3, ceiling: 3, remembered: true, reasons: [] });
    expect(q.tier.name).toBe("ultra"); expect(q.autoLabel()).toBe("Auto (Ultra)"); run(q, 31000, 16.7); expect(saved).toBe(3);
    q.preset = "high"; expect(q.tier.name).toBe("high"); q.preset = "ultra"; expect(q.tier.name).toBe("ultra");
  });
  it("controller bench promotes a fast unknown desktop in the first seconds", () => {
    const q = new QualityController("auto"); const t = classifyDevice(M["masked desktop"]![0]);
    q.configure({ klass: t.klass, name: "high", start: 2, ceiling: 3, remembered: false, reasons: [] }, (m) => benchAdjust(t, m)); run(q, 3000, 6); expect(q.tier.name).toBe("ultra");
  });
});
