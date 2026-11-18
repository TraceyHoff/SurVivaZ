/** ADR-266: finite, persisted earthworks for a NEW 2x2 shelter. No edits beneath an existing building. */
import { Transform, type Entity, type World } from "@engine/core";
import { isWaterId } from "@engine/world";
import { AttachKind, EdgeSide, Fuel } from "../components.js";
import { hasPrivilege, snapPlacement, validatePlacement } from "../building/place.js";
import { structures } from "../building/structure.js";
import { resolveAttachment } from "../building/links.js";
import { gameplayDefs } from "../config.js";
import { countItem } from "../inventory.js";
import { editTerrain, hasShovel, TerrainFail, terrainDigAt, LEVEL_MAX, LEVEL_MIN } from "../terrain.js";
import { planRamp, gradeRamp, RAMP_MAX_DELTA, type RampPlan as CoreRampPlan } from "../ramp.js";
import { BuildFail } from "../events.js";
import { TerrainRes } from "../world.js";

export interface TerrainBasePlan {
  x: number; y: number; kind: "pad" | "pit"; height: number;
  quarry: { x: number; y: number; bottom: number }[];
  done?: boolean; abandoned?: boolean;
  /** Owner work anchor that selected this adjacent shelter (hired workers only). */
  anchor?: { x: number; y: number };
}
export type TerrainWork = { k: "terrain"; x: number; y: number; dir: number; stand: { x: number; y: number } }
  | { k: "ramp"; x: number; y: number; dx: number; dy: number; delta: number; stand: { x: number; y: number } }
  | { k: "ladder"; x: number; y: number }
  | { k: "light"; x: number; y: number }
  | { k: "fuel"; piece: Entity };

/**
 * ADR-419: a graded ramp the bot builds to smooth its own route. `dest` is the
 * frequent destination the ramp serves (a worn route endpoint); the plan is done
 * when the graded axis is a ±1 staircase (re-planned from live heights each step,
 * so a half-graded ramp left by an interrupted trip resumes, never restarts).
 * Soil: the pad/pit quarry cap (12 soil) cannot fund a ramp — a ramp's quarry is
 * sized to the ramp itself (soilNeeded, at most RAMP_MAX_EDITS), dug from flat
 * ground beside the foot tile before grading starts.
 */
export interface RampPlan {
  x: number; y: number; dx: number; dy: number; delta: number;
  dest?: { x: number; y: number };
  done?: boolean; abandoned?: boolean;
}
/** A ramp plan for the given foot / direction / height change, or undefined when it cannot be graded. */
export function planRampPlan(world: World, self: Entity, x: number, y: number, dx: number, dy: number, delta: number, dest?: { x: number; y: number }): RampPlan | undefined {
  const r = planRamp(world, x, y, dx, dy, delta);
  if (!r.ok) return undefined;
  void self; return { x, y, dx, dy, delta, ...(dest ? { dest } : {}) };
}

/**
 * ADR-419 trigger: walk the straight (Bresenham) line of a frequent route
 * (home <-> destination, trips >= 3 — the same threshold that wears a path,
 * ADR-413) and find the first place where consecutive tiles differ by >= 2
 * levels. The ramp foot is the tile before the step, the direction is the step's
 * axis, and delta is the step itself (clamped to RAMP_MAX_DELTA): grading cuts
 * the ramp into the high side (down-ramp) or builds it up from the low side.
 * Returns undefined when the line is already walkable (all steps <= 1).
 */
export function findRampOnRoute(world: World, self: Entity, from: { x: number; y: number }, to: { x: number; y: number }): RampPlan | undefined {
  const t = world.getResource(TerrainRes); if (!t) return undefined;
  let x0 = Math.floor(from.x), y0 = Math.floor(from.y); const x1 = Math.floor(to.x), y1 = Math.floor(to.y);
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0); const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1; let err = dx - dy;
  let px = x0, py = y0; const hAt = (x: number, y: number): number | undefined => { const id = t.tileAt(x, y); return id === 0 ? undefined : t.heightAt(x, y); };
  let prev = hAt(px, py); if (prev === undefined) return undefined;
  for (let guard = 0; guard < 512; guard++) {
    if (x0 === x1 && y0 === y1) return undefined;
    const e2 = 2 * err;
    // One axis per tile (a diagonal Bresenham step is an x-step then a y-step): the step
    // across the cliff is always axis-aligned, so the ramp direction always is too.
    if (e2 > -dy) { err -= dy; x0 += sx; } else { err += dx; y0 += sy; }
    const h = hAt(x0, y0); if (h === undefined) return undefined;
    const step = h - prev;
    if (Math.abs(step) >= 2) {
      const ddx = x0 - px, ddy = y0 - py; // axis step across the cliff (Bresenham moves one axis per tile)
      const delta = Math.max(-RAMP_MAX_DELTA, Math.min(RAMP_MAX_DELTA, step));
      const plan = planRampPlan(world, self, px, py, ddx, ddy, delta, { x: to.x, y: to.y });
      return plan;
    }
    px = x0; py = y0; prev = h;
  }
  return undefined;
}

/** One ramp step: quarry soil first (ramp-sized quarry, not the 12-soil pad cap), then one whole-ramp command. */
export function nextRampWork(world: World, self: Entity, p: RampPlan): TerrainWork | undefined {
  if (p.done || p.abandoned || !hasShovel(world, self)) return undefined;
  const r = planRamp(world, p.x, p.y, p.dx, p.dy, p.delta);
  if (!r.ok) { if (r.fail === TerrainFail.BadTile) p.done = true; else p.abandoned = true; return undefined; }
  const plan: CoreRampPlan = r.plan;
  if (!plan.edits.length) { p.done = true; return undefined; }
  const soil = [...gameplayDefs(world).items.values()].find((d) => d.key === "soil")?.id;
  const stand = { x: p.x + 0.5 - p.dx * 0.5, y: p.y + 0.5 - p.dy * 0.5 };
  if (plan.soilNeeded > 0 && (soil === undefined || countItem(world, self, soil) < plan.soilNeeded)) {
    // Quarry beside the foot tile, down to 3 levels, until the ramp is funded (bounded by the ramp's own need).
    const t = world.getResource(TerrainRes); if (!t) { p.abandoned = true; return undefined; }
    const qx = p.x - p.dy * 2, qy = p.y + p.dx * 2; // beside the ramp, not on it
    for (let i = 0; i < 4; i++) {
      const tx = qx + p.dx * i, ty = qy + p.dy * i;
      if (terrainDigAt(world, tx, ty) <= -3) continue;
      const why = editTerrain(world, self, tx, ty, -1, true);
      if (why === TerrainFail.None || why === TerrainFail.TooFar) return { k: "terrain", x: tx, y: ty, dir: -1, stand };
      if (why === TerrainFail.InventoryFull) return undefined; // pause: bag full, stash first
    }
    p.abandoned = true; return undefined;
  }
  const dry = gradeRamp(world, self, plan, true);
  // TooFar here only means the bot is not at the stand yet — base_behaviors walks there first and the
  // server re-checks reach when the command lands (same as nextTerrainWork's TooFar steps).
  if (dry === TerrainFail.TooFar) return { k: "ramp", x: p.x, y: p.y, dx: p.dx, dy: p.dy, delta: p.delta, stand };
  if (dry !== TerrainFail.None) { if (dry === TerrainFail.InventoryFull) return undefined; p.abandoned = true; return undefined; }
  return { k: "ramp", x: p.x, y: p.y, dx: p.dx, dy: p.dy, delta: p.delta, stand };
}

/** Select once, before foundations. Refuse water, occupied footprints, foreign claims and extreme existing slopes. */
export function planTerrainBase(world: World, self: Entity, b: { x: number; y: number }, kind: "pad" | "pit"): TerrainBasePlan | undefined {
  const t = world.getResource(TerrainRes); if (!t?.setRawHeight || !t.setTile) return undefined;
  const x = Math.floor(b.x), y = Math.floor(b.y), idx = structures(world);
  for (const [e] of idx.info) { const p = world.get(e, Transform); if (p && p.x >= x && p.x <= x + 2 && p.y >= y && p.y <= y + 2) return undefined; }
  const hs: number[] = [];
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const tx = x + dx, ty = y + dy;
    if (!t.tileAt(tx, ty) || isWaterId(t.tileAt(tx, ty)) || t.loaded?.(tx, ty) === false || !hasPrivilege(world, self, tx + .5, ty + .5)) return undefined;
    hs.push(t.heightAt(tx, ty));
  }
  if (Math.max(...hs) - Math.min(...hs) > 1) return undefined;
  const height = kind === "pad" ? Math.max(...hs) + 2 : Math.min(...hs) - 3;
  if (height < LEVEL_MIN || height > LEVEL_MAX) return undefined; // ADR-411: -300..326 (was a stale -27..44)
  const quarry: TerrainBasePlan["quarry"] = [];
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) { const tx = x - 4 + dx, ty = y + 2 + dy; quarry.push({ x: tx, y: ty, bottom: t.heightAt(tx, ty) - 3 }); }
  return { x, y, kind, height, quarry };
}

/** One command-sized step. A quarry is bounded too (max 12 Soil); exhausted/blocked plans stop, never move to a new hill. */
export function nextTerrainWork(world: World, self: Entity, p: TerrainBasePlan): TerrainWork | undefined {
  if (p.done || p.abandoned || !hasShovel(world, self)) return undefined;
  const t = world.getResource(TerrainRes); if (!t) return undefined;
  const idx = structures(world), stand = { x: p.x + .5, y: p.y + 2.5 };
  const ladder = idx.ladder(p.x, p.y + 2, EdgeSide.North);
  // Fit the entrance as soon as a face exists; nobody gets stranded while subsequent cells are dug.
  if (!ladder && t.heightAt(p.x, p.y + 1) !== t.heightAt(p.x, p.y + 2)) {
    const sn = snapPlacement(world, { piece: gameplayDefs(world).pieceId("ladder"), x: p.x + .5, y: p.y + 2, level: 0, rot: 0, tier: 0, variant: 0 });
    const fail = typeof sn === "number" ? sn : validatePlacement(world, self, sn, { ignoreRange: true, ignoreCost: true });
    if (fail && fail !== BuildFail.SkillLocked) { p.abandoned = true; return undefined; }
    return { k: "ladder", x: p.x + .5, y: p.y + 2 };
  }
  const soil = [...gameplayDefs(world).items.values()].find((d) => d.key === "soil")?.id;
  // Gather the complete pad's Soil before raising anything. A blocked/exhausted quarry
  // must not leave half a mound beneath the ordinary shelter's foundation plan.
  let soilNeeded = 0;
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const x = p.x + dx, y = p.y + dy, h = t.heightAt(x, y);
    if (h !== p.height && !hasPrivilege(world, self, x + .5, y + .5)) { p.abandoned = true; return undefined; }
    soilNeeded += Math.max(0, p.height - h);
  }
  if (soilNeeded > 0 && (soil === undefined || countItem(world, self, soil) < soilNeeded)) {
    let fullBag = false;
    for (const q of p.quarry) if (t.heightAt(q.x, q.y) > q.bottom && terrainDigAt(world, q.x, q.y) > -3) {
      const why = editTerrain(world, self, q.x, q.y, -1, true);
      if (why === TerrainFail.InventoryFull) fullBag = true;
      if (why === TerrainFail.None || why === TerrainFail.TooFar) return { k: "terrain", x: q.x, y: q.y, dir: -1, stand: { x: p.x - .5, y: p.y + 2.5 } };
    }
    if (!fullBag) p.abandoned = true; return undefined; // pause for ordinary surplus stashing when capacity is temporary
  }
  // South row first, so the entrance ladder is always on completed terrain.
  for (const dy of [1, 0]) for (const dx of [0, 1]) {
    const x = p.x + dx, y = p.y + dy, h = t.heightAt(x, y); if (h === p.height) continue;
    const dir = h < p.height ? 1 : -1;
    const why = editTerrain(world, self, x, y, dir, true);
    if (why !== TerrainFail.None && why !== TerrainFail.TooFar) { if (why !== TerrainFail.InventoryFull) p.abandoned = true; return undefined; }
    return { k: "terrain", x, y, dir, stand };
  }
  if (!ladder) { p.abandoned = true; return undefined; } // the outside landing was changed: do not silently pick another entrance
  if (p.kind === "pit") {
    let fire: Entity | undefined;
    for (const [e, info] of idx.info) if (info.def.key === "campfire") { const pos = world.get(e, Transform); if (pos && Math.abs(pos.x - p.x - 1.5) < .3 && Math.abs(pos.y - p.y - .5) < .3) fire = e; }
    if (!fire) return { k: "light", x: p.x + 1.5, y: p.y + .5 };
    const a = resolveAttachment(world, fire, AttachKind.Fire); if (a && !world.getField(a, Fuel, "lit")) return { k: "fuel", piece: a };
  }
  p.done = true; return undefined;
}
