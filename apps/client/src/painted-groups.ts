/**
 * ADR-551: pure paint-variant registry — the paint-only half of every painter group,
 * with no DOM, no Cache Storage, and no encode step, so the exact same code can run
 * on the main thread (fallback) or inside a paint Worker (the fast path).
 *
 * One entry per painter group in `view.ts` (13 groups, 43 atlases). A "variant" is
 * one encodable image: every atlas is one variant, except ADR-410 slopes, where each
 * season atlas is TWO variants — the 1x page (a box downsample of the 2x paint, key
 * `<atlas>`) and the @2x page (key `<atlas>@2x`). The variant keys are exactly the
 * ADR-550 cache keys' atlas keys, so the orchestrator (`painted-parallel.ts`) can
 * look each variant up in the painted cache independently.
 *
 * Module state lives wherever this module is imported: on the main thread the
 * `fieldCache`/`toneCache` in `task410-art.ts` are the main thread's copy; in a
 * Worker each worker thread imports its own copy (the `Px` rasterizer is
 * per-instance state, never shared). The one-group orchestration (cache-first
 * lookup, parallel encode/store) lives in `painted-core.ts`, which imports no
 * art module — the art modules delegate to it, and this registry is imported
 * only by the Worker entry (`paint-worker.ts`) and by tests, so no import
 * cycle through here can ever hit a TDZ binding at module-evaluation time.
 */
import type { PaintedAtlasInput } from "./painted-cache.js";
import { paintTask34Atlases } from "./task34-art.js";
import { paintTask256Atlases } from "./task256-art.js";
import { paintTask355Atlases } from "./task355-art.js";
import { paintTask361Atlases } from "./task361-art.js";
import { paintTask410Variants } from "./task410-art.js";
import { paintTask420Atlases } from "./task420-art.js";
import { paintTask421Atlases, paintTask422Atlases, paintTask479Atlases } from "./task421-art.js";
import { paintTask540Atlases } from "./task540-art.js";
import { FOOTPRINT_ATLAS_KEY, TRACK_ATLAS_KEY, paintFootprintPixels, paintTrackPixels } from "./footprints-art.js";
import { ROD_ATLAS_KEY, paintRodPixels } from "./fishing-rod-art.js";

/** The 13 painter groups, in the `view.ts` start order (start order, not finish order). */
export const PAINTED_GROUP_NAMES = ["task34", "task256", "task355", "task361", "task410", "task420", "task421", "task422", "task479", "task540", "footprint", "track", "rod"] as const;
export type PaintedGroupName = (typeof PAINTED_GROUP_NAMES)[number];

/**
 * Paint one group's variants (pure: no DOM, no cache, no encode). The returned
 * pixel buffers are freshly allocated per call and owned by the caller — a Worker
 * transfers them back to the main thread, the main thread encodes them.
 */
export function paintGroupVariants(name: string): PaintedAtlasInput[] {
  switch (name) {
    case "task34": return paintTask34Atlases();
    case "task256": return paintTask256Atlases();
    case "task355": return paintTask355Atlases();
    case "task361": return paintTask361Atlases();
    case "task410": return paintTask410Variants();
    case "task420": return paintTask420Atlases();
    case "task421": return paintTask421Atlases();
    case "task422": return paintTask422Atlases();
    case "task479": return paintTask479Atlases();
    case "task540": return paintTask540Atlases();
    case "footprint": return [{ key: FOOTPRINT_ATLAS_KEY, ...paintFootprintPixels() }];
    case "track": return [{ key: TRACK_ATLAS_KEY, ...paintTrackPixels() }];
    case "rod": return [{ key: ROD_ATLAS_KEY, ...paintRodPixels() }];
    default: throw new Error(`[adr551] unknown painter group: ${name}`);
  }
}

