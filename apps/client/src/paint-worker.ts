/**
 * ADR-551: the paint Worker's entry point (thin wrapper — the work itself is
 * `paintGroupVariants` in `painted-groups.ts`, imported here so each worker thread
 * owns its own copy of the painters' module state: `Px` instances are per-call,
 * and `task410-art.ts`'s `fieldCache`/`toneCache` live in the worker, never on
 * the main thread).
 *
 * Protocol: the main thread posts `{ id, group }`; the worker paints the group's
 * variants and posts back `{ id, group, variants }` with the pixel buffers
 * TRANSFERRED (zero-copy — the ~88 MB of raw RGBA is never copied across the
 * boundary). On any paint failure it posts `{ id, group, error }` and the main
 * thread falls back to painting that group itself, so a worker failure never
 * fails boot. The worker never touches Cache Storage or the canvas: lookup,
 * PNG encode, and store all stay on the main thread (`painted-parallel.ts`),
 * where `OffscreenCanvas` availability is already proven by the old path.
 *
 * Bundled by Vite as a module worker (`new Worker(new URL("./paint-worker.ts",
 * import.meta.url), { type: "module" })` — the same pattern as
 * `local-worker.ts`). This file has no import-time side effect other than
 * installing `onmessage`, so importing it headlessly (a test importing the
 * protocol types) is safe — but tests exercise the handler through
 * `paintGroupVariants` + a fake worker instead, because this VM has no
 * browser `Worker`.
 */
import { paintGroupVariants } from "./painted-groups.js";
import type { PaintedAtlasInput } from "./painted-cache.js";

/** Main thread -> worker: paint one group. `id` correlates the reply. */
export interface PaintWorkerRequest { id: number; group: string }
/** Worker -> main thread: the painted variants, or `error` when painting threw. */
export interface PaintWorkerResponse {
  id: number;
  group: string;
  variants?: PaintedAtlasInput[];
  error?: string;
}

/** Minimal view of the dedicated-worker global scope (avoids a `self` lib type). */
const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<PaintWorkerRequest>) => void) | null;
  postMessage: (msg: PaintWorkerResponse, transfer: Transferable[]) => void;
};

scope.onmessage = (e: MessageEvent<PaintWorkerRequest>): void => {
  const req = e.data;
  try {
    const variants = paintGroupVariants(req.group);
    // Transfer the pixel buffers: the worker's copies detach, the main thread
    // owns them. Every variant's pixels are a fresh full-buffer view (Px data
    // and the task410 downsample allocate exactly w*h*4), so transferring
    // `.buffer` transfers exactly that variant's pixels, nothing shared.
    scope.postMessage(
      { id: req.id, group: req.group, variants },
      variants.map((v) => v.pixels.buffer as ArrayBuffer),
    );
  } catch (err) {
    scope.postMessage({ id: req.id, group: req.group, error: err instanceof Error ? err.message : String(err) }, []);
  }
};
