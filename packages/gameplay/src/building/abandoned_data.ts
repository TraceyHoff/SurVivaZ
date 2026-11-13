/**
 * ADR-382 time-sliced abandoned stamping tunables (packages/gameplay/data/abandoned.json),
 * as a leaf module.
 *
 * Same precedent as stairs_data.ts (ADR-372): this module imports only the JSON, so no
 * import cycle can reach it — abandoned.ts's import graph reaches back through
 * structure / place / links, and the stamp pump runs from install.ts. abandoned.ts
 * re-exports ABANDONED_DATA for its importers.
 */
import raw from "../../data/abandoned.json";

export interface AbandonedData {
  /** Most BuildPiece specs one stamp pump places per tick (postSim gameplay.abandonedStamps). */
  readonly stampPiecesPerTick: number;
}
const DEFAULTS: AbandonedData = { stampPiecesPerTick: 20 };
const parsed = raw as unknown as Partial<AbandonedData>;
export const ABANDONED_DATA: AbandonedData = {
  ...DEFAULTS,
  ...parsed,
  // A zero / negative / non-finite cap would stall stamps forever — clamp to the default.
  stampPiecesPerTick:
    typeof parsed.stampPiecesPerTick === "number" && Number.isFinite(parsed.stampPiecesPerTick)
      ? Math.max(1, Math.floor(parsed.stampPiecesPerTick))
      : DEFAULTS.stampPiecesPerTick,
};
