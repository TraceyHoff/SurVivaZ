/**
 * ?diag=1: on-screen diagnostics (screenshot-able on phones). Refreshes ~2x/s from cheap getters only:
 * GL caps/limits, atlas layers/size/downscale vs MAX_ARRAY_TEXTURE_LAYERS, VRAM, frame draw calls/sprites, entity count,
 * snapshot-received, sim tick rate, gl.getError, a centre-pixel readback, and the last error.
 */
import { mountUi } from "./ui-root.js";
import type { IsoRenderer } from "@engine/render";

export interface DiagSources { renderer(): IsoRenderer | undefined; entities(): number; tick(): number; snapshot(): { received: boolean; latestTick: number; snapshots: number } | undefined; player(): unknown;
  /** ADR-370: client load-cost breakdown (boot / world-ready / warm-up timings). */
  loadCost?(): string | undefined;
  /** World spawn points (ADR-106) and the seed they were computed for. */
  spawnPoints?(): { seed: number; points: { x: number; y: number }[] } | undefined }
let lastError = "";
const hex = (r: number, g: number, b: number): string => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

export function startDiag(src: DiagSources): { afterRender(): void } | undefined {
  if (new URLSearchParams(location.search).get("diag") !== "1") return undefined;
  addEventListener("error", (e) => { lastError = `${e.message} @${e.filename?.split("/").pop()}:${e.lineno}`; });
  addEventListener("unhandledrejection", (e) => { lastError = `unhandled: ${String((e as PromiseRejectionEvent).reason).slice(0, 200)}`; });
  const ce = console.error.bind(console), cw = console.warn.bind(console);
  console.error = (...a: unknown[]) => { lastError = a.map(String).join(" ").slice(0, 240); ce(...a); };
  console.warn = (...a: unknown[]) => { const t = a.map(String).join(" "); if (/\[render\]|oom|exceed|incomplete/i.test(t)) lastError = "warn: " + t.slice(0, 240); cw(...a); };
  const el = document.createElement("pre"); el.id = "diag";
  el.style.cssText = "position:fixed;left:4px;top:4px;z-index:9999;margin:0;padding:6px 8px;max-width:min(96vw,560px);white-space:pre-wrap;font:11px/1.35 ui-monospace,monospace;color:#cfe;background:rgba(0,0,0,.72);border-radius:6px;pointer-events:none";
  mountUi(el);
  let t0 = performance.now(), k0 = src.tick(), rate = 0, pixel = "?", glErr = 0, want = true;
  setInterval(() => {
    const now = performance.now(), k = src.tick(); rate = ((k - k0) * 1000) / (now - t0); t0 = now; k0 = k; want = true;
    const r = src.renderer(); const L: string[] = [];
    if (r) {
      const c = r.capabilities, a = r.atlas.stats, v = r.vram as unknown as Record<string, unknown>, f = r.stats as unknown as Record<string, number>;
      L.push(`gl ${c.renderer}`, `prec frag ${c.precision.fragment} vert ${c.precision.vertex} lowEnd=${c.lowEnd} mobile=${c.mobile} flags=${c.flags.join(",") || "-"}`);
      L.push(`limits tex ${c.limits.maxTextureSize} layers ${c.limits.maxArrayLayers} units ${c.limits.maxTextureUnits}`);
      L.push(`atlas ${a.atlases} atl, ${a.layers} layers${a.layers > c.limits.maxArrayLayers ? " (OVER MAX!)" : ""} @${a.layerSize}px x${a.downscale} ${a.gpuMB}MB / budget ${c.textureBudgetMB}MB, ${a.sprites} sprites`);
      const vs = Object.entries(v ?? {}).filter(([, x]) => typeof x !== "object").map(([n, x]) => `${n}=${typeof x === "number" && x > 1e5 ? `${Math.round(x / 1048576)}M` : x}`);
      if (vs.length) L.push(`vram ${vs.join(" ")}`);
      L.push(`frame draws ${f.drawCalls ?? "?"} sprites ${f.sprites ?? "?"} cpu ${(f.cpuMs ?? 0).toFixed(1)}ms`);
      const lc = src.loadCost?.(); if (lc) L.push(lc);
      L.push(`glError ${glErr ? "0x" + glErr.toString(16) : "none"} centre ${pixel} cam ${r.camera.x.toFixed(1)},${r.camera.y.toFixed(1)} z${r.camera.zoom}`);
      if (c.fallbacks.length) L.push(`fallbacks: ${c.fallbacks.join("; ")}`);
      if (c.problems.length) L.push(`PROBLEMS: ${c.problems.join("; ")}`);
      // Renderer-provided report (renderer.diagReport() / capabilities.diag) when available.
      try {
        const rr = r as unknown as { diagReport?: () => unknown }, cd = (c as unknown as { diag?: unknown }).diag;
        const rep = typeof rr.diagReport === "function" ? rr.diagReport() : cd;
        if (rep !== undefined) L.push(`report: ${typeof rep === "string" ? rep : JSON.stringify(rep)}`);
      } catch (e) { L.push(`report error: ${String(e)}`); }
    } else L.push("renderer: not created (debug view)");
    const s = src.snapshot();
    const sd = r?.sceneDiag; if (sd) L.push(`view entities ${sd.entities} player eid ${sd.playerEid ?? "none"} cam target ${sd.cameraTarget ? `${sd.cameraTarget.kind} ${sd.cameraTarget.x.toFixed(1)},${sd.cameraTarget.y.toFixed(1)}` : "none"} local server ${sd.localServer ?? "?"} snapshots ${sd.snapshots ?? "?"}${sd.lastError ? ` scene error: ${sd.lastError}` : ""}`);
    L.push(`entities ${src.entities()} player ${src.player() !== undefined ? "yes" : "no"} snapshot ${s ? `${s.received ? "yes" : "NO"} tick ${s.latestTick} n=${s.snapshots}` : "no session"}`);
    L.push(`sim tick ${src.tick()} @ ${rate.toFixed(1)}/s`);
    const sp = src.spawnPoints?.(); if (sp) L.push(`spawns (seed ${sp.seed}) ${sp.points.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join("  ")}`);
    L.push(`last error: ${lastError || "none"}`);
    el.textContent = L.join("\n");
  }, 500);
  return { afterRender(): void {
    if (!want) return; want = false; const r = src.renderer(); if (!r) return;
    const gl = r.gl; glErr = gl.getError();
    const px = new Uint8Array(4); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(gl.drawingBufferWidth >> 1, gl.drawingBufferHeight >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    pixel = hex(px[0]!, px[1]!, px[2]!);
  } };
}
