import { describe, expect, it } from "vitest";
import { Fx } from "../src/fx/effects.js";
import { DAMAGE_TUNE, FxDraw, normalizeDamageTune, vignetteCss } from "../src/fx/draw.js";
import { C, PALETTE } from "../src/fx/palette.js";

/**
 * ADR-350: the damage pulse (hurt / low-HP vignette, dread vignette, hit flash) used to force a full-screen
 * canvas repaint every frame it was visible - a clearRect plus a 256px -> ~1080p drawImage upscale, ~48ms/frame
 * in a real-raster harness at phone size, 100% of frames over the 16.7ms budget while low HP. The pulse now lives
 * on composited DOM layers whose only per-frame mutation is style.opacity, so the canvas idle-skips and the frame
 * cost is ~0.003ms. The alpha math is unchanged (same beat, same coefficients, same caps), so the pulse reads
 * exactly as before - just on consecutive frames instead of dropped ones.
 */

const LAYOUT_PROPS = ["offsetWidth", "offsetHeight", "clientWidth", "clientHeight", "scrollWidth", "scrollHeight", "getBoundingClientRect", "getClientRects"];

class FakeEl {
  width = 300; height = 150; id = ""; removed = false;
  readonly styleLog: string[] = []; readonly layoutGets: string[] = [];
  readonly style: Record<string, string>;
  constructor(private readonly ctx: unknown) {
    const log = this.styleLog, target: Record<string, string> = {};
    this.style = new Proxy(target, {
      set(t, k, v) { log.push(`${String(k)}=${String(v)}`); (t as Record<string, unknown>)[k as string] = v; return true; },
      get(t, k) { return (t as Record<string, unknown>)[k as string]; },
    });
    for (const p of LAYOUT_PROPS) {
      if (p.startsWith("get")) Object.defineProperty(this, p, { value: (..._a: unknown[]) => { this.layoutGets.push(p); return []; } });
      else Object.defineProperty(this, p, { get: () => { this.layoutGets.push(p); return 0; } });
    }
  }
  getContext() { return this.ctx; }
  remove() { this.removed = true; }
}

interface Harness { draw: FxDraw; fx: Fx; env: Record<string, unknown>; ctxCalls: string[]; appended: FakeEl[]; restore: () => void }
function harness(): Harness {
  const g = globalThis as Record<string, unknown>, saved = { OffscreenCanvas: g["OffscreenCanvas"], document: g["document"] };
  const ctxCalls: string[] = [];
  const ctx: unknown = new Proxy({}, {
    get: (_t, k) => (k === "createRadialGradient" || k === "createLinearGradient" ? () => ({ addColorStop() {} }) : (..._a: unknown[]) => { ctxCalls.push(String(k)); }),
    set: () => true,
  });
  class FakeCanvas extends FakeEl { constructor(w = 300, h = 150) { super(ctx); this.width = w; this.height = h; } }
  const appended: FakeEl[] = [];
  g["OffscreenCanvas"] = FakeCanvas;
  g["document"] = { createElement: (tag: string) => (tag === "canvas" ? new FakeCanvas() : new FakeEl(ctx)) };
  const root = { appendChild(el: FakeEl) { appended.push(el); } } as unknown as HTMLElement;
  const draw = new FxDraw(root), fx = new Fx(2048, 1400);
  const env: Record<string, unknown> = { cam: { x: 0, y: 0, drawZoom: 1 }, w: 390, h: 844, dpr: 3, time: 0, ambient: [1, 1, 1], fog: [0.5, 0.5, 0.5], daylight: 1, canvasFallback: false,
    weather: { kind: 0, intensity: 0, windDir: 0 }, indoors: false, glows: new Float32Array(8), glowCount: 0, vignette: true, flicker: true };
  return { draw, fx, env, ctxCalls, appended, restore: () => { g["OffscreenCanvas"] = saved.OffscreenCanvas; g["document"] = saved.document; } };
}
/** The pre-350 alpha formula, verbatim constants: the test pins it so a future change that weakens the pulse fails. */
const refHurtA = (fx: Fx): number => {
  const beat = fx.pulsePhase < 0.12 ? Math.sin((fx.pulsePhase / 0.12) * Math.PI)
    : fx.pulsePhase > 0.2 && fx.pulsePhase < 0.3 ? 0.6 * Math.sin(((fx.pulsePhase - 0.2) / 0.1) * Math.PI) : 0;
  const hurtA = Math.min(0.75, fx.hurt * 0.6) + fx.lowHp * (0.22 + 0.33 * beat);
  return hurtA > 0.005 ? Math.min(0.85, hurtA) : 0;
};
const q3 = (v: number): number => Math.round(v * 1000) / 1000;

describe("ADR-350 damage pulse", () => {
  it("low-HP pulse: zero canvas work, compositor-only opacity, same strength and timing as before", () => {
    const h = harness();
    try {
      const { draw, fx, env } = h, [canvas, hurt, dread, flash] = h.appended as [FakeEl, FakeEl, FakeEl, FakeEl];
      // Style writes made by the constructor (cssText + the first background) are the baseline, not per-frame work.
      const ctorLen = [hurt!, dread!, flash!].map((w) => w.styleLog.length);
      expect(h.appended.map((e) => e.id)).toEqual(["vfx-fx", "vfx-wash-hurt", "vfx-wash-dread", "vfx-wash-flash"]);
      // Wash layers are inert and composited: no input, own composited layer, same stacking as the canvas (z-index 2, below the HUD at 5+).
      for (const w of [hurt!, dread!, flash!]) {
        const css = w.styleLog.find((s) => s.startsWith("cssText=")) ?? "";
        expect(css).toMatch(/pointer-events:none/); expect(css).toMatch(/will-change:opacity/); expect(css).toMatch(/z-index:2/);
      }
      fx.hurt = 0; fx.lowHp = 0.6; fx.dread = 0; fx.flash = 0;
      const times: number[] = [], seen: number[] = [];
      for (let i = 0; i < 600; i++) {
        fx.step(1 / 60); env["time"] = fx.time;
        const t0 = performance.now(); draw.draw(fx, env as never); times.push(performance.now() - t0);
        seen.push(parseFloat(hurt!.style["opacity"] ?? "0"));
        expect(parseFloat(hurt!.style["opacity"] ?? "-1")).toBe(q3(refHurtA(fx)));
      }
      // Frame cost: no per-frame JS work of any size, and no frame anywhere near the 16.7ms budget.
      times.sort((a, b) => a - b);
      expect(times.reduce((a, b) => a + b, 0) / times.length).toBeLessThan(1);
      expect(times[Math.floor(times.length * 0.95)]).toBeLessThan(2);
      // Canvas: the pulse never paints - at most the single first-frame dirty clear, no drawImage / fillRect at all.
      expect(h.ctxCalls.filter((c) => c === "drawImage").length).toBe(0);
      expect(h.ctxCalls.filter((c) => c === "fillRect").length).toBe(0);
      expect(h.ctxCalls.filter((c) => c === "clearRect").length).toBeLessThanOrEqual(1);
      // The pulse still reads: it swings 0.132..0.330 (the pre-350 range for lowHp 0.6), never weakened.
      expect(Math.max(...seen)).toBeCloseTo(0.33, 3); expect(Math.min(...seen)).toBeCloseTo(0.132, 3);
      expect(Math.max(...seen) - Math.min(...seen)).toBeGreaterThan(0.15);
      // Compositor-only: after construction the only style writes on any layer are opacity, and no layout
      // property is ever read - nothing on the damage path can trigger layout or a paint.
      [hurt!, dread!, flash!].forEach((w, i) => {
        const afterCtor = w.styleLog.slice(ctorLen[i]);
        // The first non-zero frame establishes the wash colour once; every other per-frame write is opacity.
        const nonOpacity = afterCtor.filter((s) => !s.startsWith("opacity="));
        expect(nonOpacity.length).toBeLessThanOrEqual(1);
        expect(nonOpacity.every((s) => s.startsWith("background="))).toBe(true);
        expect(w.layoutGets).toEqual([]);
      });
      expect(canvas!.layoutGets).toEqual([]);
      expect(canvas!.styleLog.filter((s) => !s.startsWith("cssText="))).toEqual([]);
    } finally { h.restore(); }
  });

  it("hurt flash after a hit keeps the old peak, then decays to quiet with no canvas work", () => {
    const h = harness();
    try {
      const { draw, fx, env } = h, hurt = h.appended[1]!;
      fx.lowHp = 0; fx.damaged(0.2);
      draw.draw(fx, env as never);
      expect(hurt.style["opacity"]).toBe("0.57"); // min(0.75, 0.95 * 0.6): the pre-350 peak for a 0.2 hit
      let frames = 0;
      for (let i = 0; i < 240; i++) {
        fx.step(1 / 60); env["time"] = fx.time; draw.draw(fx, env as never); frames++;
        if (fx.hurt <= 0.005 && parseFloat(hurt.style["opacity"] ?? "1") === 0) break;
      }
      expect(hurt.style["opacity"]).toBe("0");
      expect(h.ctxCalls.filter((c) => c === "drawImage" || c === "fillRect").length).toBe(0);
      expect(frames).toBeLessThan(240); // hurt decays at 1.6/s, so the flash ends on its own
    } finally { h.restore(); }
  });

  it("flash and dread follow the old caps; vignette off and shrink() silence the washes", () => {
    const h = harness();
    try {
      const { draw, fx, env } = h, [, hurt, dread, flash] = h.appended as [FakeEl, FakeEl, FakeEl, FakeEl];
      fx.flash = 0.3; fx.flashColor = C.Crit; draw.draw(fx, env as never);
      expect(flash!.style["opacity"]).toBe("0.3"); expect(flash!.style["background"]).toBe("rgb(255,250,230)");
      fx.flash = 0.9; draw.draw(fx, env as never); expect(flash!.style["opacity"]).toBe("0.45");
      fx.flash = 0; fx.dread = 0.8; draw.draw(fx, env as never); expect(dread!.style["opacity"]).toBe("0.36");
      fx.dread = 0; env["vignette"] = false; fx.lowHp = 0.6; fx.hurt = 0.5;
      for (let i = 0; i < 10; i++) draw.draw(fx, env as never);
      expect(hurt!.style["opacity"]).toBe("0"); expect(dread!.style["opacity"]).toBe("0");
      env["vignette"] = true; fx.hurt = 0.5; draw.draw(fx, env as never);
      expect(parseFloat(hurt!.style["opacity"] ?? "0")).toBeGreaterThan(0);
      draw.shrink();
      expect(hurt!.style["opacity"]).toBe("0"); expect(dread!.style["opacity"]).toBe("0"); expect(flash!.style["opacity"]).toBe("0");
      draw.dispose();
      expect(h.appended.every((e) => e.removed)).toBe(true); expect(draw.texBytes()).toBe(0);
    } finally { h.restore(); }
  });

  it("a cold hit recolours the vignette once; the background is not rewritten per frame", () => {
    const h = harness();
    try {
      const { draw, fx, env } = h, hurt = h.appended[1]!;
      const bgWrites = (): number => hurt.styleLog.filter((s) => s.startsWith("background=")).length;
      fx.lowHp = 0; fx.damaged(0.2, "cold"); draw.draw(fx, env as never);
      expect(hurt.style["background"]).toContain("rgba(150,200,255,0) 21.98%");
      expect(hurt.style["background"]).toContain("rgba(150,200,255,0.25) 64.89%");
      const afterCold = bgWrites();
      for (let i = 0; i < 60; i++) { fx.step(1 / 60); env["time"] = fx.time; draw.draw(fx, env as never); }
      expect(bgWrites()).toBe(afterCold); // colour is event-time state, not a per-frame string
      fx.damaged(0.2); draw.draw(fx, env as never);
      expect(hurt.style["background"]).toContain("rgba(150,22,20,0) 21.98%");
      expect(bgWrites()).toBe(afterCold + 1);
    } finally { h.restore(); }
  });

  it("the CSS gradient is the baked vignette: same geometry, same stops, no transparent-black darkening", () => {
    const [r, g, b] = PALETTE[C.Blood]!;
    expect(vignetteCss(C.Blood)).toBe(
      `radial-gradient(ellipse 71.09% 71.09% at center, rgba(${r},${g},${b},0) 21.98%, rgba(${r},${g},${b},0.25) 64.89%, rgba(${r},${g},${b},1) 100%)`);
    expect(vignetteCss(C.Blood)).not.toContain("transparent");
    expect(vignetteCss(C.Cold)).toContain("rgba(150,200,255,0.25) 64.89%");
    // The JSON values are the pre-350 ones; garbage normalises back to them, never to NaN.
    expect(DAMAGE_TUNE.hurt.perHurt).toBe(0.6); expect(DAMAGE_TUNE.hurt.cap).toBe(0.85);
    expect(DAMAGE_TUNE.vignette.outerRadiusPx).toBe(182); expect(DAMAGE_TUNE.flash.cap).toBe(0.45);
    expect(normalizeDamageTune({})).toEqual(DAMAGE_TUNE);
    expect(normalizeDamageTune({ hurt: { perHurt: "x", cap: NaN }, vignette: null }).hurt.perHurt).toBe(0.6);
  });
});
