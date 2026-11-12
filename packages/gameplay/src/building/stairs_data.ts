/**
 * ADR-372 stairs tunables (packages/gameplay/data/stairs.json), as a leaf module.
 *
 * STAIRS_DATA used to live in building/stairs.ts, but systems/creature_nav.ts reads
 * STAIRS_DATA.maxPathLevel at module top level to size its A* scratch arrays, and
 * stairs.ts's import graph reaches back to creature_nav (stairs -> structure ->
 * modular/combat -> ... -> creature_nav -> stairs), so importing stairs.ts as the
 * entry point threw a temporal-dead-zone "Cannot access 'STAIRS_DATA' before
 * initialization" (caught by esm_import_order.test.ts). This module imports only the
 * JSON, so no cycle can reach it; stairs.ts re-exports STAIRS_DATA for its existing
 * importers, and creature_nav imports it from here.
 */
import raw from "../../data/stairs.json";

export interface StairsData {
  /** Fraction (x ruin) of two-story+ sites whose interior stairs spawn missing. */
  readonly brokenChance: number;
  /** Fraction (x ruin) of exterior stair runs that spawn missing. */
  readonly brokenExteriorChance: number;
  /** A* cost of one level change on a stair tile. */
  readonly pathStairCost: number;
  /** Highest level the level-aware pathfinders route to (townhouse = levels 0..2). */
  readonly maxPathLevel: number;
  /** Tile direction the top of a rot-0 stairs piece faces; rot rotates it with the site. */
  readonly upDir: readonly [number, number];
  /** Abandoned kind keys that also get an outside stair run to a level-1 balcony. */
  readonly exteriorKinds: readonly string[];
}
const DEFAULTS: StairsData = {
  brokenChance: 0.25, brokenExteriorChance: 0.2, pathStairCost: 2, maxPathLevel: 2,
  upDir: [0, -1], exteriorKinds: ["two_story_cottage", "two_story_farmhouse", "townhouse"],
};
export const STAIRS_DATA: StairsData = { ...DEFAULTS, ...(raw as unknown as Partial<StairsData>) };
