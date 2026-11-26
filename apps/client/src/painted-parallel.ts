/**
 * ADR-551: painters in parallel / in a Worker (pixel-identical).
 *
 * `view.ts` used to `await` the 13 painter groups strictly one after another,
 * and inside each group the atlases were painted and PNG-encoded one by one —
 * ~4.7 s of pure paint on this VM, ~14.2 s of paint+encode on the user's phone,
 * all single-threaded on the main thread. This module is the parallel
 * replacement, built on top of ADR-550 (it never weakens the cache):
 *
 * 1. Cache lookup FIRST, per variant, in parallel (`lookupPaintedBlobURL` per
 *    atlas key, `Promise.all`). A warm boot — every variant a hit — never
 *    paints at all, exactly as ADR-550 proved. A partial hit reuses the hit
 *    variants and only paints/encodes the misses (strictly better than the old
 *    all-or-nothing batch lookup, which repainted a whole group on one miss).
 * 2. Paint the misses in a Worker pool (`createPaintWorkerPool`, one
 *    `paint-worker.ts` thread each, capped at 2–4 so the render thread and the
 *    local-server worker keep cores). The workers run the pure painters
 *    (`paintGroupVariants`, no DOM) and transfer the pixel buffers back
 *    zero-copy. Any worker failure, timeout (60 s), or missing `Worker`
 *    falls back to painting that group on the main thread — boot never fails
 *    because a worker did.
 * 3. Encode the missed variants in parallel (`Promise.all` over
 *    `encodePaintedBlob`, which is async native PNG work that overlaps), then
 *    store the survivors to the ADR-550 cache, also in parallel. An atlas
 *    whose main variant failed to encode is dropped whole (task410: a missing
 *    1x drops its @2x too — the old `if (!blob) continue`).
 *
 * The 13 groups themselves run concurrently (`paintPaintedGroups` is one
 * `Promise.all` over the groups), so cold-boot wall time falls toward the
 * single slowest group (ADR-422, ~1.9 s VM) + transfer/encode overlap, instead
 * of the sum of all thirteen. Pixel identity is by construction — the worker
 * runs the same pure paint functions with the same inputs — and is pinned by
 * SHA-256 in `apps/client/test/adr551_painters_parallel.test.ts`.
 *
 * Defs are built lazily (`paintedGroupDefs()` memoises on first call): the art
 * modules delegate their `*AtlasSources` to the orchestrator in
 * `painted-core.ts`, so a top-level def construction here would read their
 * spec functions before those modules finished evaluating (TDZ). Nothing in
 * this file touches an art-module binding at import time.
 */
import type { AtlasSource } from "@engine/render";
import {
  paintPaintedGroup, type PaintedGroupDef, type PaintWorkerPool,
  defaultAssemble,
} from "./painted-core.js";
export type { PaintWorkerPool } from "./painted-core.js";
import { paintTask34Atlases, task34Specs } from "./task34-art.js";
import { paintTask256Atlases, task256Specs } from "./task256-art.js";
import { paintTask355Atlases, task355Specs } from "./task355-art.js";
import { paintTask361Atlases, task361Specs } from "./task361-art.js";
import { TASK410_ATLAS_KEYS, paintTask410Variants, task410Specs } from "./task410-art.js";
import { paintTask420Atlases, task420Specs } from "./task420-art.js";
import { paintTask421Atlases, paintTask422Atlases, paintTask479Atlases, task421Specs, task422Specs, task479Specs } from "./task421-art.js";
import { paintTask540Atlases, task540Specs } from "./task540-art.js";
import { FOOTPRINT_ATLAS_KEY, TRACK_ATLAS_KEY, footprintSpecs, paintFootprintPixels, paintTrackPixels, trackSpecs } from "./footprints-art.js";
import { ROD_ATLAS_KEY, paintRodPixels, rodSpecs } from "./fishing-rod-art.js";
import type { PaintedCacheEnv } from "./painted-cache.js";
import type { PaintedAtlasInput } from "./painted-cache.js";
import type { PaintWorkerRequest, PaintWorkerResponse } from "./paint-worker.js";

let cachedDefs: PaintedGroupDef[] | undefined;

/** ADR-410 assembly: the 1x blob is the atlas URL, the @2x blob (if any) is its page. */
const assembleTask410Sources: PaintedGroupDef["assemble"] = (_specKeys, urls) => {
  const out = new Map<string, AtlasSource>();
  for (const k of TASK410_ATLAS_KEYS) {
    const one = urls.get(k);
    if (!one) continue;
    const src: AtlasSource = { url: one.url, emissiveUrl: null };
    const two = urls.get(`${k}@2x`);
    if (two) src.pages = [{ scale: 2, url: two.url }];
    out.set(k, src);
  }
  return out;
};

/** The 13 group defs, in `view.ts` start order. Built lazily (see header). */
export function paintedGroupDefs(): PaintedGroupDef[] {
  if (cachedDefs) return cachedDefs;
  const def = (
    name: string,
    specs: () => Map<string, string>,
    paint: () => PaintedAtlasInput[],
  ): PaintedGroupDef => ({ name, specs, paint, assemble: defaultAssemble });
  cachedDefs = [
    def("task34", task34Specs, paintTask34Atlases),
    def("task256", task256Specs, paintTask256Atlases),
    def("task355", task355Specs, paintTask355Atlases),
    def("task361", task361Specs, paintTask361Atlases),
    { name: "task410", specs: task410Specs, paint: paintTask410Variants, groupOf: (k) => k.replace(/@2x$/, ""), assemble: assembleTask410Sources },
    def("task420", task420Specs, paintTask420Atlases),
    def("task421", task421Specs, paintTask421Atlases),
    def("task422", task422Specs, paintTask422Atlases),
    def("task479", task479Specs, paintTask479Atlases),
    def("task540", task540Specs, paintTask540Atlases),
    def("footprint", footprintSpecs, () => [{ key: FOOTPRINT_ATLAS_KEY, ...paintFootprintPixels() }]),
    def("track", trackSpecs, () => [{ key: TRACK_ATLAS_KEY, ...paintTrackPixels() }]),
    def("rod", rodSpecs, () => [{ key: ROD_ATLAS_KEY, ...paintRodPixels() }]),
  ];
  return cachedDefs;
}

/** One group def by name (throws on an unknown name — the worker does the same). */
export function paintedGroupDef(name: string): PaintedGroupDef {
  const d = paintedGroupDefs().find((x) => x.name === name);
  if (!d) throw new Error(`[adr551] unknown painter group: ${name}`);
  return d;
}

/**
 * Paint all 13 groups concurrently — one `Promise.all` over the groups, so the
 * wall time is the slowest group (+ encode/store overlap), not the sum. Each
 * group is still cache-first (a warm boot paints nothing anywhere). The
 * per-group work lives in `paintPaintedGroup` (`painted-core.ts`).
 */
export async function paintPaintedGroups(
  env: PaintedCacheEnv = {},
  pool?: PaintWorkerPool | undefined,
): Promise<Map<string, Map<string, AtlasSource>>> {
  const entries = await Promise.all(paintedGroupDefs().map(async (def) => {
    const sources = await paintPaintedGroup(def, env, pool);
    return [def.name, sources] as const;
  }));
  return new Map(entries);
}

// ---- Worker pool ----------------------------------------------------------

/** Minimal structural view of a paint Worker (real `Worker` or a test fake). */
export interface PaintWorkerLike {
  postMessage(msg: PaintWorkerRequest, transfer?: Transferable[]): void;
  onmessage: ((e: { data: PaintWorkerResponse }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  terminate(): void;
}

/** Pool size: 2–4 workers — the render thread and the local-server worker keep cores too. */
export function paintWorkerPoolSize(): number {
  const hc = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 4;
  return Math.max(2, Math.min(4, hc - 2));
}

/** One painted job, in flight or queued. */
interface PaintJob {
  group: string;
  resolve: (v: PaintedAtlasInput[]) => void;
  reject: (e: Error) => void;
}
interface PendingPaintJob extends PaintJob { timer: ReturnType<typeof setTimeout>; slot: PaintSlot }
interface PaintSlot { worker: PaintWorkerLike; busy: boolean; jobId: number | undefined }

/** Adapt a real browser `Worker` to the `PaintWorkerLike` seam (test fakes skip this). */
function adaptWorker(w: Worker): PaintWorkerLike {
  const like: PaintWorkerLike = {
    postMessage: (msg, transfer) => { if (transfer) w.postMessage(msg, transfer); else w.postMessage(msg); },
    onmessage: null,
    onerror: null,
    terminate: () => w.terminate(),
  };
  w.onmessage = (e: MessageEvent) => { like.onmessage?.({ data: e.data as PaintWorkerResponse }); };
  w.onerror = (e: ErrorEvent) => { like.onerror?.(e); };
  return like;
}

/**
 * Create the paint Worker pool, or `undefined` when no `Worker` exists (Node,
 * canvas-less / old browsers) — the caller then paints on the main thread.
 * Workers are created LAZILY on the first `paint()` call, so a warm boot (all
 * cache hits, no paint) pays nothing for threads it never uses. A worker that
 * errors or times out is terminated and dropped; its job rejects so the
 * orchestrator falls back to main-thread paint, and later jobs use the
 * remaining workers (or fall back too, once the pool is empty).
 */
export function createPaintWorkerPool(opts: {
  size?: number;
  /** Per-job timeout (a wedged worker must never stall boot); default 60 s. */
  timeoutMs?: number;
  /** Injectable worker factory (tests pass a fake; production uses the real `Worker`). */
  createWorker?: () => PaintWorkerLike;
} = {}): PaintWorkerPool | undefined {
  const hasWorker = typeof (globalThis as { Worker?: unknown }).Worker !== "undefined";
  if (!hasWorker && !opts.createWorker) return undefined;
  const size = opts.size ?? paintWorkerPoolSize();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const createWorker = opts.createWorker ?? ((): PaintWorkerLike =>
    adaptWorker(new Worker(new URL("./paint-worker.ts", import.meta.url), { type: "module" })));
  const slots: PaintSlot[] = [];
  const pending = new Map<number, PendingPaintJob>();
  const queue: PaintJob[] = [];
  let nextId = 1;
  let terminated = false;
  let createFailed = false;

  const removeSlot = (slot: PaintSlot): void => {
    const i = slots.indexOf(slot);
    if (i >= 0) slots.splice(i, 1);
    try { slot.worker.terminate(); } catch { /* already gone */ }
  };

  const failJob = (id: number, err: Error): void => {
    const job = pending.get(id);
    if (!job) return;
    clearTimeout(job.timer);
    pending.delete(id);
    if (job.slot.jobId === id) { job.slot.busy = false; job.slot.jobId = undefined; }
    job.reject(err);
  };

  const pump = (): void => {
    if (terminated || createFailed) return;
    while (queue.length > 0) {
      let slot = slots.find((s) => !s.busy);
      if (!slot) {
        if (slots.length >= size) return; // all workers busy — the job waits
        let worker: PaintWorkerLike;
        try {
          worker = createWorker();
        } catch (err) {
          // Worker construction itself fails (CSP, bad URL): no worker will ever
          // exist — reject everything queued so callers fall back to main paint.
          createFailed = true;
          const queued = queue.splice(0);
          for (const job of queued) job.reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        slot = { worker, busy: false, jobId: undefined };
        slots.push(slot);
        // Handlers close over this slot only (never the pump loop's `slot`
        // variable, which is reassigned on the next dispatch).
        const created = slot;
        worker.onmessage = (e) => {
          const res = e.data;
          const job = pending.get(res.id);
          if (!job || job.slot !== created) return;
          clearTimeout(job.timer);
          pending.delete(res.id);
          created.busy = false;
          created.jobId = undefined;
          if (res.error || !res.variants) job.reject(new Error(`[adr551] paint worker failed for ${res.group}: ${res.error ?? "no variants"}`));
          else job.resolve(res.variants);
          pump();
        };
        worker.onerror = () => {
          // Drop the wedged worker; its in-flight job (if any) rejects and the
          // orchestrator repaints it on the main thread.
          if (created.jobId !== undefined) failJob(created.jobId, new Error(`[adr551] paint worker error (group in flight)`));
          removeSlot(created);
          pump();
        };
      }
      const job = queue.shift()!;
      // Per-job const: the timer/postMessage closures must not see the pump
      // loop's `slot` variable, which the next iteration reassigns.
      const assigned = slot;
      const id = nextId++;
      assigned.busy = true;
      assigned.jobId = id;
      const timer = setTimeout(() => {
        // Wedged worker: terminate it (its late reply, if any, is ignored —
        // the pending entry is gone) and let the job fall back to main paint.
        failJob(id, new Error(`[adr551] paint worker timed out after ${timeoutMs} ms (group ${job.group})`));
        removeSlot(assigned);
        pump();
      }, timeoutMs);
      pending.set(id, { ...job, timer, slot: assigned });
      try {
        assigned.worker.postMessage({ id, group: job.group });
      } catch (err) {
        failJob(id, err instanceof Error ? err : new Error(String(err)));
        removeSlot(assigned);
        pump();
      }
    }
  };

  return {
    size,
    paint(group: string): Promise<PaintedAtlasInput[]> {
      if (terminated || createFailed) return Promise.reject(new Error("[adr551] paint worker pool is closed"));
      return new Promise<PaintedAtlasInput[]>((resolve, reject) => {
        queue.push({ group, resolve, reject });
        pump();
      });
    },
    terminate(): void {
      if (terminated) return;
      terminated = true;
      for (const job of pending.values()) {
        clearTimeout(job.timer);
        job.reject(new Error("[adr551] paint worker pool terminated"));
      }
      pending.clear();
      for (const job of queue.splice(0)) job.reject(new Error("[adr551] paint worker pool terminated"));
      for (const slot of slots.splice(0)) {
        try { slot.worker.terminate(); } catch { /* already gone */ }
      }
    },
  };
}
