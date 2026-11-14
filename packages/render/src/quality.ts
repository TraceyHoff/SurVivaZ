/**
 * Adaptive quality: fixed tiers + a frame-time governor (target 60 fps, floor 30 fps, hysteresis) and the user-facing
 * Settings preset (Auto / Low / Medium / High / Ultra / Full, persisted; ADR-116). Auto runs the governor; fixed presets pin a tier.
 * Full pins the Ultra tier AND bypasses the soft DPR / pixel-budget caps in IsoRenderer.resize() (hard GPU limits
 * still apply), so it renders at the device's native DPR. ADR-407: on consoles Full does NOT bypass the caps
 * (the 1 GB UWP app cap cannot afford 4K targets) — see fullResolution. Task 26: Full is now the DEFAULT on every device
 * (reversing the Task 1 decision that kept Auto as the safe default) — the user explicitly requires it.
 * Auto / Low / Medium / High / Ultra stay selectable, and a stored choice is always kept (only the
 * default for fresh installs changes). Trade-off, stated plainly: low-end phones render at native DPR
 * and may run hotter/slower; the player can lower the preset in Settings at any time.
 */
export interface QualityTier { name: string; resScale: number; lightDownscale: number; bloom: boolean; weather: number; particles: number;
  /** ADR-116: clutter density multiplier (1+ on ultra) */ clutter: number; /** max sprite/anim detail (all dir frames, full wearables) */ maxDetail: boolean }
export const QUALITY_TIERS: readonly QualityTier[] = [
  { name: "low", resScale: 0.6, lightDownscale: 4, bloom: false, weather: 0.4, particles: 0.5, clutter: 0.5, maxDetail: false },
  { name: "medium", resScale: 0.75, lightDownscale: 4, bloom: false, weather: 0.6, particles: 0.75, clutter: 0.75, maxDetail: false },
  { name: "high", resScale: 0.9, lightDownscale: 2, bloom: true, weather: 0.85, particles: 1, clutter: 1, maxDetail: true },
  // ADR-116 Ultra/Max: native DPR (to 4K / canvas size), full-res lightmap, every effect at full
  { name: "ultra", resScale: 1, lightDownscale: 1, bloom: true, weather: 1, particles: 1.25, clutter: 1.25, maxDetail: true },
];
export type QualityPreset = "auto" | "low" | "medium" | "high" | "ultra" | "full";
export const QUALITY_PRESETS: readonly QualityPreset[] = ["auto", "low", "medium", "high", "ultra", "full"];
/** Task 26: the default preset for fresh installs (no stored choice). Stored choices are always kept. */
export const DEFAULT_QUALITY_PRESET: QualityPreset = "full";
/** Atlas page scale a preset asks for: Ultra / Full use the @2x pages where they exist (1x otherwise);
 *  every other preset stays on 1x pages, so Auto never triggers an atlas rebuild on a governor step. */
export function atlasPageScaleForPreset(p: QualityPreset): number { return p === "ultra" || p === "full" ? 2 : 1; }
const PRESET_TIER: Record<Exclude<QualityPreset, "auto">, number> = { low: 0, medium: 1, high: 2, ultra: 3, full: 3 };
export const PRESET_STORAGE_KEY = "survivaz.render.quality";

export interface GovernorOptions {
  /** EMA frame ms above which frames count as "dropped" (50 fps) */ targetMs?: number;
  /** below 30 fps slow time counts double */ floorMs?: number;
  /** ms of sustained drops before a step down (5 s) */ downAfterMs?: number;
  /** ms of sustained headroom before a step up */ upAfterMs?: number;
  /** headroom = EMA below targetMs * upRatio (hysteresis band between) */ upRatio?: number;
  /** ms after any change during which no further change happens */ cooldownMs?: number;
  /** highest level the governor may step up to (device ceiling) */ ceiling?: number;
}

/** Frame-time governor (ADR-116): down only after >5 s below 50 fps, up after 8 s of clear headroom (< ~14 ms), with a
 *  dead band between and a cooldown; a level that was stepped down from is retried only after 4x the up time. Allocation-free. */
export class QualityGovernor {
  level: number; ema = 16.7; changes = 0; ceiling: number;
  private slow = 0; private fast = 0; private cool = 0; private failedAt = -1;
  private readonly o: Required<Omit<GovernorOptions, "ceiling">>;
  constructor(start = QUALITY_TIERS.length - 1, opts: GovernorOptions = {}) {
    this.level = start; this.ceiling = opts.ceiling ?? QUALITY_TIERS.length - 1;
    this.o = { targetMs: 20, floorMs: 1000 / 30, downAfterMs: 5000, upAfterMs: 8000, upRatio: 0.7, cooldownMs: 3000, ...opts };
  }
  get tier(): QualityTier { return QUALITY_TIERS[this.level]!; }
  reset(level: number, ceiling = this.ceiling): void { this.level = level; this.ceiling = ceiling; this.slow = this.fast = 0; this.failedAt = -1; }
  feed(dtMs: number): boolean {
    if (!(dtMs > 0) || dtMs > 1000) return false; // tab hidden / hitch: ignore
    this.ema += (dtMs - this.ema) * 0.05;
    if (this.cool > 0) { this.cool -= dtMs; return false; }
    const o = this.o;
    if (this.ema > o.targetMs) { this.slow += this.ema > o.floorMs ? dtMs * 2 : dtMs; this.fast = 0; }
    else if (this.ema < o.targetMs * o.upRatio) { this.fast += dtMs; this.slow = Math.max(0, this.slow - dtMs); }
    else { this.slow = Math.max(0, this.slow - dtMs); this.fast = Math.max(0, this.fast - dtMs); }
    if (this.slow >= o.downAfterMs && this.level > 0) { this.failedAt = this.level; return this.step(-1); }
    const upNeed = this.level + 1 === this.failedAt ? o.upAfterMs * 4 : o.upAfterMs;
    if (this.fast >= upNeed && this.level < this.ceiling) return this.step(1);
    return false;
  }
  private step(d: number): boolean { this.level += d; this.slow = this.fast = 0; this.cool = this.o.cooldownMs; this.changes++; return true; }
}

/** Preset + governor: `tier` is what the renderer applies. */
export class QualityController {
  readonly governor: QualityGovernor; preset: QualityPreset;
  /** ADR-116 detected device tier (Settings shows it; Auto label shows what it picked) */
  detected: { klass: string; name: string; start: number; ceiling: number; remembered: boolean; reasons: string[] } | undefined;
  /** called once the Auto level has held >= 30 s (remember per device) */ onStable: ((level: number) => void) | undefined;
  private bench: number[] | undefined; private benchSkip = 0; private stableMs = 0; private stableSaved = -1;
  private benchAdjust: ((median: number) => number) | undefined;
  constructor(preset: QualityPreset = DEFAULT_QUALITY_PRESET, startLevel?: number) { this.preset = preset; this.governor = new QualityGovernor(startLevel); }
  /** Apply the probe result: Auto starts at `start`, never steps above `ceiling`; optional first-seconds bench. */
  configure(d: NonNullable<QualityController["detected"]>, bench?: (median: number) => number): void {
    this.detected = d; this.governor.reset(d.start, d.ceiling); this.stableMs = 0;
    if (bench && !d.remembered) { this.bench = []; this.benchSkip = 30; this.benchAdjust = bench; }
  }
  get level(): number { return this.preset === "auto" ? this.governor.level : PRESET_TIER[this.preset]; }
  /** True only for the explicit Full preset: native DPR with soft DPR / pixel caps bypassed (see IsoRenderer.resize).
   *  ADR-407: never on a console — Full is the default preset, and the bypass would re-open the 4K targets the
   *  high tier caps at 1080p; the console's 1 GB UWP app cap cannot afford them. Desktop/mobile Full is untouched. */
  get fullResolution(): boolean { return this.preset === "full" && this.detected?.klass !== "console"; }
  get tier(): QualityTier { return QUALITY_TIERS[this.level]!; }
  get current(): QualityTier { return this.tier; }
  setPreset(p: QualityPreset): void { this.preset = p; savePreset(p); }
  /** "Auto (Ultra)" etc. */
  autoLabel(): string { const n = QUALITY_TIERS[this.governor.level]!.name; return `Auto (${n[0]!.toUpperCase()}${n.slice(1)})`; }
  /** returns true when the applied tier changed */
  feed(dtMs: number): boolean {
    if (this.bench && dtMs > 0 && dtMs < 1000) {
      if (this.benchSkip > 0) this.benchSkip--; else this.bench.push(dtMs);
      if (this.bench.length >= 120) { const b = this.bench.sort((a, c) => a - c); const med = b[b.length >> 1]!; this.bench = undefined;
        const lvl = this.benchAdjust!(med); if (lvl !== this.governor.level) { this.governor.reset(lvl); this.governor.changes++; return this.preset === "auto"; } }
    }
    const before = this.governor.level; const changed = this.governor.feed(dtMs);
    if (changed || before !== this.governor.level) this.stableMs = 0; else if (dtMs > 0 && dtMs < 1000) this.stableMs += dtMs;
    if (this.stableMs >= 30000 && !this.bench && this.stableSaved !== this.governor.level) { this.stableSaved = this.governor.level; this.onStable?.(this.governor.level); }
    return changed && this.preset === "auto";
  }
  describe(): string { const t = this.tier; const d = this.detected; return `quality: preset ${this.preset}${this.preset === "auto" ? ` (governor ema ${this.governor.ema.toFixed(1)}ms, ${this.governor.changes} changes, ceiling ${QUALITY_TIERS[this.governor.ceiling]!.name})` : ""}${d ? `; device ${d.klass} -> ${d.name}${d.remembered ? " (remembered)" : ""}` : ""} -> ${t.name}: res x${t.resScale}, light 1/${t.lightDownscale}, bloom ${t.bloom ? "on" : "off"}, weather x${t.weather}, particles x${t.particles}, clutter x${t.clutter}`; }
}

export function parsePreset(v: string | null | undefined): QualityPreset | null { return v && (QUALITY_PRESETS as readonly string[]).includes(v) ? v as QualityPreset : null; }
export function loadPreset(): QualityPreset { try { return parsePreset(globalThis.localStorage?.getItem(PRESET_STORAGE_KEY)) ?? DEFAULT_QUALITY_PRESET; } catch { return DEFAULT_QUALITY_PRESET; } }
export function savePreset(p: QualityPreset): void { try { globalThis.localStorage?.setItem(PRESET_STORAGE_KEY, p); } catch { /* private mode */ } }
