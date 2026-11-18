/**
 * ADR-419: the ramp tool — grade a ±1-level staircase so a player or AI human can walk
 * up / down a step that would otherwise be a cliff.
 *
 * A ramp is a straight axis-aligned line: a foot (start) tile, a direction, and a signed
 * height change `delta`. The graded tiles are start+dir*i for i = 1..|delta|, with target
 * height startHeight + sign*i — consecutive tiles differ by exactly 1 level along the
 * graded axis, so no graded-axis edge ever drops 2+ (that would be `stepped`, a cliff
 * face by design, ADR-409/418). Each graded tile is raised / dug from its CURRENT
 * height to its target, one level per shovel edit, so a tile i levels off its target
 * costs i edits and i soil (up) or yields i soil (down): an up-ramp of +3 on flat
 * ground costs 1+2+3 = 6 soil. A water tile costs one extra edit to fill first
 * (editTerrain fills water at its bed level before it starts rising, ADR-263), and
 * digging water is refused (BadTile) — a downhill ramp into a lake stops at the shore,
 * an uphill ramp over water builds a causeway.
 *
 * Design decision (b): ONE new command, gameplay.terrainRamp, carrying the whole
 * ramp (foot + direction + delta). The server plans it, validates every step with
 * editTerrain(dryRun) and applies it in round-robin order (level by level, so every
 * intermediate state is itself a ±1 staircase — a failed / partial ramp is still
 * walkable, never a cliff). One rate-limit charge per ramp instead of one per tile,
 * and one Step for the AI instead of a dozen. (a) — a client loop over TerrainCmd —
 * was rejected: each tile would re-check shovel reach (a ramp longer than ~3 tiles
 * extends past TERRAIN.reach), re-charge the 2/s fallback rate, and leave a
 * half-graded cliff if the client stopped mid-loop. The ramp command therefore
 * checks reach only for the FOOT tile (one shovel use from where you stand); the
 * graded line extends from there, each tile still checked for privilege, occupancy
 * and soil exactly like a single shovel edit.
 *
 * Movement physics are unchanged (ADR-409): 1-level steps were already walkable
 * (MAX_UNAIDED_CLIMB 3); the ramp only makes the terrain match that.
 */
import { Transform, defineCommand, type CommandDef, type CommandHandlers, type Entity, type World } from "@engine/core";
import { isWaterId, terrainLevel } from "@engine/world";
import { countItem, canAddItem } from "./inventory.js";
import { editTerrain, hasShovel, TerrainFail, TERRAIN_FAIL_REASONS } from "./terrain.js";
import { LEVEL_MAX, LEVEL_MIN, TERRAIN } from "./terrain_depth.js";
import { itemIdSafe } from "./roads.js";
import { TerrainRes } from "./world.js";

/** Longest ramp (levels climbed / descended) in one command. */
export const RAMP_MAX_DELTA = 16;
/** Most single-level edits in one ramp (bounds the soil / tick cost of one command). */
export const RAMP_MAX_EDITS = 96;

export interface RampEdit { x: number; y: number; dir: 1 | -1 }
export interface RampPlan {
  x: number; y: number; dx: number; dy: number; delta: number;
  /** Per-level edits, round-robin (level 1 of every tile, then level 2, ...). */
  edits: RampEdit[];
  /** Soil an up-ramp consumes (0 for a down-ramp). */
  soilNeeded: number;
  /** Soil a down-ramp yields (0 for an up-ramp). */
  soilYielded: number;
}
export type RampPlanResult = { ok: true; plan: RampPlan } | { ok: false; fail: TerrainFail };

/** Current (bed) level of a tile, or undefined when it is not loaded. */
function levelAt(world: World, x: number, y: number): { level: number; water: boolean } | undefined {
  const t = world.getResource(TerrainRes); if (!t) return undefined;
  const id = t.tileAt(x, y); if (id === 0) return undefined;
  const raw = t.rawHeightAt?.(x, y) ?? t.heightAt(x, y);
  return { level: terrainLevel(id, raw), water: isWaterId(id) };
}

const axis = (dx: number, dy: number): boolean =>
  (dx === 1 && dy === 0) || (dx === -1 && dy === 0) || (dx === 0 && dy === 1) || (dx === 0 && dy === -1);

/**
 * Plan a ramp: foot (x,y), axis direction (dx,dy), signed height change delta.
 * Pure except reading terrain heights; never writes. Fails BadTile for a zero delta,
 * a non-axis direction or a downhill step into water; Limit for |delta| > 16, a
 * target outside -300..326, or more than 96 edits; NotLoaded for an unloaded tile.
 */
export function planRamp(world: World, x: number, y: number, dx: number, dy: number, delta: number): RampPlanResult {
  x = Math.floor(x); y = Math.floor(y); dx = Math.floor(dx); dy = Math.floor(dy); delta = Math.floor(delta);
  if (delta === 0 || !axis(dx, dy)) return { ok: false, fail: TerrainFail.BadTile };
  if (Math.abs(delta) > RAMP_MAX_DELTA) return { ok: false, fail: TerrainFail.Limit };
  const foot = levelAt(world, x, y); if (!foot) return { ok: false, fail: TerrainFail.NotLoaded };
  const sign = delta > 0 ? 1 : -1; const n = Math.abs(delta);
  // Per-tile level counts first (targets), then expand round-robin so intermediate states stay ±1.
  const perTile: { x: number; y: number; dir: 1 | -1; count: number }[] = [];
  let soilNeeded = 0, soilYielded = 0, total = 0;
  for (let i = 1; i <= n; i++) {
    const tx = x + dx * i, ty = y + dy * i; const target = foot.level + sign * i;
    if (target < LEVEL_MIN || target > LEVEL_MAX) return { ok: false, fail: TerrainFail.Limit };
    const cur = levelAt(world, tx, ty); if (!cur) return { ok: false, fail: TerrainFail.NotLoaded };
    const diff = target - cur.level;
    if (diff === 0) continue;
    if (diff < 0 && cur.water) return { ok: false, fail: TerrainFail.BadTile }; // can't dig open water
    // Raising water fills it first (one extra edit at the bed level, ADR-263).
    const count = diff > 0 && cur.water ? diff + 1 : Math.abs(diff);
    perTile.push({ x: tx, y: ty, dir: diff > 0 ? 1 : -1, count });
    total += count; if (total > RAMP_MAX_EDITS) return { ok: false, fail: TerrainFail.Limit };
    if (diff > 0) soilNeeded += count; else soilYielded += count;
  }
  if (!perTile.length) return { ok: false, fail: TerrainFail.BadTile }; // already graded: nothing to do
  const edits: RampEdit[] = [];
  const maxCount = Math.max(...perTile.map((p) => p.count));
  for (let level = 0; level < maxCount; level++)
    for (const p of perTile) if (level < p.count) edits.push({ x: p.x, y: p.y, dir: p.dir });
  return { ok: true, plan: { x, y, dx, dy, delta, edits, soilNeeded, soilYielded } };
}

/**
 * Validate (dryRun) or apply a planned ramp. Reach is checked only for the foot
 * tile — the graded line extends from there (see header). Soil is checked in total
 * up front (a per-edit dryRun would see the same unspent bag every time and could
 * approve a ramp the bag cannot pay for); inventory space for a down-ramp likewise.
 * Applying stops at the first failing edit and returns its failure — the partial
 * ramp left behind is round-robin graded, so still a ±1 staircase, never a cliff.
 */
export function gradeRamp(world: World, e: Entity, plan: RampPlan, dryRun = false): TerrainFail {
  if (!hasShovel(world, e)) return TerrainFail.NoShovel;
  // Reach: the foot tile must be within shovel reach of the body (a normal shovel use);
  // the graded line extends from there, so far tiles are not re-checked per edit.
  const body = world.get(e, Transform);
  if (body && Math.hypot(body.x - plan.x - 0.5, body.y - plan.y - 0.5) > TERRAIN.reach + 0.75) return TerrainFail.TooFar;
  const t = world.getResource(TerrainRes); if (!t) return TerrainFail.NotLoaded;
  const soil = itemIdSafe(world, "soil");
  if (plan.soilNeeded > 0) {
    if (soil === undefined || countItem(world, e, soil) < plan.soilNeeded) return TerrainFail.NoSoil;
  }
  if (plan.soilYielded > 0) {
    if (soil === undefined || canAddItem(world, e, soil, plan.soilYielded) < plan.soilYielded) return TerrainFail.InventoryFull;
  }
  for (const s of plan.edits) {
    const why = editTerrain(world, e, s.x, s.y, s.dir, dryRun, true);
    if (why !== TerrainFail.None) return why;
  }
  return TerrainFail.None;
}

// ---- command ---------------------------------------------------------------------------------------------------------
/** Foot tile (x,y), axis direction (dx,dy), signed height change (delta levels over |delta| tiles). */
export const TerrainRampCmd = defineCommand("gameplay.terrainRamp", { x: "i32", y: "i32", dx: "i8", dy: "i8", delta: "i8" });
export const RAMP_COMMANDS: readonly CommandDef[] = [TerrainRampCmd];
export function installRampCommands(world: World, handlers: CommandHandlers): void {
  handlers.on(TerrainRampCmd, {
    validate: (v, c) => {
      const r = planRamp(world, v.x, v.y, v.dx, v.dy, v.delta);
      if (!r.ok) return TERRAIN_FAIL_REASONS[r.fail];
      const g = gradeRamp(world, c.actor, r.plan, true);
      return g ? TERRAIN_FAIL_REASONS[g] : undefined;
    },
    handle: (v, c) => {
      const r = planRamp(world, v.x, v.y, v.dx, v.dy, v.delta);
      if (!r.ok) throw new Error(TERRAIN_FAIL_REASONS[r.fail]);
      const g = gradeRamp(world, c.actor, r.plan);
      if (g) throw new Error(TERRAIN_FAIL_REASONS[g]);
    },
  });
}
