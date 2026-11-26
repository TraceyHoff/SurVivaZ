/**
 * ADR-544: world entry waits until the first view is actually loaded — no pop-in after entry.
 *
 * The old entry path (main.ts drainFirstView, ADR-370/374) gave the first-view warm-up 1.5 s and the
 * drain another 1.5 s, then lifted the overlay whether or not the pages had landed — the user's own
 * screenshot proves it: world-entry warm-up 0/1 first-view pages resident in 2134 ms (timed out, 1
 * pending), and 1 first-view page still pending after 1770 ms. The overlay lifted onto an unfinished
 * world by design. This module is the bounded wait that replaces those two windows: the overlay only
 * lifts once pending == 0, or once the shared cap elapses.
 *
 * Pure except for Date.now / console.warn (no GL, no DOM): the atlas shape is structural, so tests
 * fake it without a renderer. main.ts keeps the loadCost notes; this module only decides when the
 * first view has actually drained.
 */
import type { WarmupResult } from "@engine/render";

/**
 * ADR-544: shared wall-clock cap (ms) for the whole world-entry warm-up — first-view page-in plus
 * the queue drain together. 25 s: the user accepted a 20–30 s loading screen for a finished world
 * (2026-11-25 ~21:35 CST, overriding the prep's ~10 s cap); 25 s is the midpoint of that range and
 * sits inside the 30 s absolute READY_TIMEOUT_MS with 5 s headroom, so a pathological drain waits
 * the full cap on entry at most, never forever.
 */
export const FIRST_VIEW_DRAIN_CAP_MS = 25000;

/** Minimal atlas shape the entry drain needs (structural, so tests can fake it without GL). */
export interface FirstViewAtlasLike {
  warmupKeysForSprites?: (spriteIds: Iterable<number>) => string[];
  warmupFirstView?: (keys: Iterable<string>, opts: { firstView?: Iterable<string>; timeoutMs?: number }) => Promise<WarmupResult>;
  warmupDrain?: (timeoutMs?: number) => Promise<{ pending: number; ms: number; drained: boolean }>;
}

export interface FirstViewDrainResult {
  /** First-view warm-up outcome (undefined when there was nothing to warm up). */
  warmup: WarmupResult | undefined;
  /** Queue-drain outcome (undefined when the atlas has no drain). */
  drain: { pending: number; ms: number; drained: boolean } | undefined;
  /** Wall-clock ms the whole drain took. */
  ms: number;
  /** True when nothing is still pending: the first view actually landed. */
  drained: boolean;
  /** The cap that bounded this drain. */
  capMs: number;
}

/**
 * Page the sprites actually on screen tier-0, then wait for the page-in queue to drain — but do not
 * give up on a timer while pages are still landing. The cap is shared across both phases (the
 * warm-up gets the full cap; the drain gets whatever is left), so the entry warm-up can never run
 * longer than the cap. A failure in either phase never blocks ready: the drain still runs and the
 * result reports drained: false, so the caller lifts the overlay at the cap.
 */
export async function drainFirstView(atlas: FirstViewAtlasLike, spriteIds: Iterable<number>, opts: { capMs?: number } = {}): Promise<FirstViewDrainResult> {
  const capMs = Math.max(0, opts.capMs ?? FIRST_VIEW_DRAIN_CAP_MS);
  const t0 = Date.now();
  let warmup: WarmupResult | undefined;
  try {
    const keys = atlas.warmupKeysForSprites?.(spriteIds) ?? [];
    if (keys.length) warmup = await atlas.warmupFirstView?.(keys, { firstView: keys, timeoutMs: capMs });
  } catch (e) { console.warn("first-view warm-up failed", e); }
  const remaining = Math.max(0, capMs - (Date.now() - t0));
  const drain = await atlas.warmupDrain?.(remaining);
  const drained = (warmup === undefined || warmup.stillPending === 0) && (drain === undefined || drain.drained);
  return { warmup, drain, ms: Date.now() - t0, drained, capMs };
}
