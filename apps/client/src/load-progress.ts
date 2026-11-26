/**
 * ADR-118: real boot progress. Weighted stages (renderer/shader init, art manifest, atlases, building variants,
 * lighting/shader warm-up, menu ready) feed one monotonic target in [0,1]; EasedBar eases the displayed fill toward it
 * every frame and never moves backwards. Pure (no DOM) so it is unit-tested in node.
 */
export interface Stage { id: string; weight: number; label: string }
export const BOOT_STAGES: readonly Stage[] = [
  { id: "renderer", weight: 0.08, label: "Starting renderer" },
  { id: "manifest", weight: 0.1, label: "Loading art manifest" },
  { id: "atlases", weight: 0.52, label: "Loading sprite atlases" },
  { id: "variants", weight: 0.1, label: "Loading building variants" },
  { id: "lighting", weight: 0.15, label: "Compiling lighting shaders" },
  { id: "ready", weight: 0.05, label: "Getting ready" },
];

export class LoadProgress {
  private readonly frac = new Map<string, number>();
  private readonly total: number;
  private peak = 0;
  label: string;
  error: string | undefined;
  constructor(readonly stages: readonly Stage[] = BOOT_STAGES) {
    this.total = stages.reduce((s, x) => s + Math.max(0, x.weight), 0) || 1;
    this.label = stages[0]?.label ?? "Loading";
  }
  /** Report progress within a stage (0..1). Earlier stages count as complete; values never decrease. */
  update(id: string, f: number, label?: string): number {
    const i = this.stages.findIndex((s) => s.id === id); if (i < 0) return this.value;
    for (let k = 0; k < i; k++) this.frac.set(this.stages[k]!.id, 1);
    const v = Number.isFinite(f) ? Math.max(0, Math.min(1, f)) : 0;
    this.frac.set(id, Math.max(this.frac.get(id) ?? 0, v));
    this.label = label ?? this.stages[i]!.label;
    return this.value;
  }
  begin(id: string, label?: string): number { return this.update(id, 0, label); }
  complete(): number { for (const s of this.stages) this.frac.set(s.id, 1); this.label = "Ready"; return this.value; }
  fail(message: string): void { this.error = message; }
  /** Monotonic weighted sum. */
  get value(): number {
    let s = 0; for (const st of this.stages) s += Math.max(0, st.weight) * (this.frac.get(st.id) ?? 0);
    this.peak = Math.max(this.peak, Math.min(1, s / this.total)); return this.peak;
  }
}

/**
 * ADR-543: one-line server-location note for ?diag=1 + window.__survivazLoadCost — whether the
 * singleplayer server runs in a Web Worker or falls back to in-tab (main.ts:504-509: ?worker=0, no
 * Worker support, or a worker that fails / does not come up within the 15 s start timeout). Pure, so
 * the exact wording is pinned by tests and both surfaces stay in sync.
 */
export function serverLocationNote(inWorker: boolean, workerForcedOff = false): string {
  if (inWorker) return "server: in Web Worker";
  return workerForcedOff ? "server: in tab (?worker=0)" : "server: in tab (worker unavailable or start timed out)";
}

/** Counting progress with an unknown tail: done/expected, capped below 1 until the caller completes the stage. */
export function countFraction(done: number, expected: number, cap = 0.97): number {
  if (expected <= 0) return done > 0 ? cap : 0;
  return Math.max(0, Math.min(cap, done / expected));
}

/** Smoothly eased, monotonic display value chasing a target. Reduced motion snaps to the target. */
export class EasedBar {
  shown = 0; private target = 0;
  constructor(public reducedMotion = false, private readonly rate = 6) {}
  set(t: number): void { if (Number.isFinite(t)) this.target = Math.max(this.target, Math.max(0, Math.min(1, t))); }
  /** Task 14: start over (the second loading screen reuses the bar after the first screen finished at 100%). */
  reset(): void { this.shown = 0; this.target = 0; }
  get goal(): number { return this.target; }
  /** Advance by dt seconds; returns the shown value. Exponential ease plus a small minimum speed so it lands on 1. */
  step(dt: number): number {
    const d = this.target - this.shown; if (d <= 0) return this.shown;
    if (this.reducedMotion) { this.shown = this.target; return this.shown; }
    const k = 1 - Math.exp(-this.rate * Math.max(0, Math.min(0.25, dt)));
    this.shown = Math.min(this.target, this.shown + Math.max(d * k, 0.15 * dt));
    if (this.target - this.shown < 0.0005) this.shown = this.target;
    return this.shown;
  }
  get done(): boolean { return this.shown >= 1; }
}

/** Zombie walker pose for the fill edge: 6-frame sheet index + vertical bob (px). Idle/reduced motion = frame 0, no bob. */
export function zombiePose(timeSec: number, moving: boolean, reducedMotion: boolean): { frame: number; bob: number } {
  if (reducedMotion || !moving) return { frame: 0, bob: 0 };
  const frame = Math.floor((timeSec / 0.857) * 6) % 6;
  return { frame, bob: -Math.abs(Math.sin(timeSec * Math.PI * 2 / 0.4286)) * 3 };
}

/** ADR-548: one boot-phase entry, optionally marked as a part of another phase (see partitionPhase). */
export interface PhaseEntry { name: string; ms: number; parent?: string }

/**
 * ADR-548: split one boot phase into per-group entries that sum to the parent (diag only — the
 * painting / registry work itself is unchanged; this only labels the time). Every entry carries
 * `parent`, so main.ts can render the split in the `?diag=1` bracket without double-counting the
 * parent in the "other" residual. The leftover — work between groups (paper-doll loop, watcher
 * setup) — lands in `<parent>.other` when positive; each group ms is rounded, so a negative
 * leftover (≤1 ms per group of rounding) is dropped rather than shown as a negative phase.
 */
export function partitionPhase(parent: string, parentMs: number, groups: { name: string; ms: number }[]): PhaseEntry[] {
  const out: PhaseEntry[] = groups.map((g) => ({ name: g.name, ms: g.ms, parent }));
  const rest = parentMs - groups.reduce((s, g) => s + g.ms, 0);
  if (rest > 0) out.push({ name: `${parent}.other`, ms: rest, parent });
  return out;
}

/**
 * ADR-370: client cost breakdown — sequential load phases plus free-form notes (warm-up
 * sub-timings), so the blurry-start cost is visible in ?diag=1 and on window.__survivazLoadCost.
 * Pure (no DOM): the phases are recorded by main.ts around the real waits (boot, world-ready,
 * warmup-drain); the warm-up itself is a note, because it runs *inside* the boot phase and
 * must not be double-counted in the total.
 */
export interface CostStage { name: string; ms: number; /** ADR-380: sub-phases inside this phase (never added to the total — they split it, not extend it). */ subs?: CostStage[] }
export class LoadCostBreakdown {
  private stages: CostStage[] = [];
  private notes: string[] = [];
  /** Record one sequential phase (ms rounded; invalid records are ignored). */
  record(name: string, ms: number): void {
    if (typeof name !== "string" || !name || !Number.isFinite(ms) || ms < 0) return;
    this.stages.push({ name, ms: Math.round(ms) });
  }
  /**
   * ADR-380: record a sub-phase inside an already-recorded phase (e.g. the boot sub-phases from IsoView.create:
   * manifest / painted / registry.fetch / registry.upload / warmup / ...). Sub-phases are a split of the parent,
   * never an addition to the total; subs for an unknown parent or invalid values are ignored.
   */
  recordSub(stage: string, name: string, ms: number): void {
    if (typeof name !== "string" || !name || !Number.isFinite(ms) || ms < 0) return;
    const s = this.stages.find((x) => x.name === stage); if (!s) return;
    (s.subs ??= []).push({ name, ms: Math.round(ms) });
  }
  /** Attach a free-form note (e.g. a warm-up sub-timing with its page counts). */
  note(text: string): void { if (typeof text === "string" && text) this.notes.push(text); }
  get totalMs(): number { return this.stages.reduce((s, x) => s + x.ms, 0); }
  get stageList(): readonly CostStage[] { return this.stages; }
  format(): string {
    if (!this.stages.length && !this.notes.length) return "load cost: not measured yet";
    const total = this.totalMs;
    const parts = this.stages.map((s) => {
      const base = `${s.name} ${s.ms}ms${total > 0 ? ` (${Math.round((s.ms / total) * 100)}%)` : ""}`;
      return s.subs?.length ? `${base} [${s.subs.map((u) => `${u.name} ${u.ms}ms`).join(" · ")}]` : base;
    });
    const head = parts.length ? `load cost: ${parts.join(" · ")} · total ${total}ms` : "load cost:";
    return this.notes.length ? `${head}; ${this.notes.join("; ")}` : head;
  }
}
