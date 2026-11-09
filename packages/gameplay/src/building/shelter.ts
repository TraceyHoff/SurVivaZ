/**
 * Shelter rules: roof cover from world BuildingGrid.isCovered (decks/roofs above), wind/rain exposure from
 * BuildingGrid.exposure(x, y, z, windDir) (cell walls, roof), combined with the gameplay edge-wall enclosure
 * (thin walls live in the EdgeIndex, not in grid cells): enclosed + covered = fully sheltered.
 */
import type { Entity, World } from "@engine/core";
import { buildingOcclusion, type OcclusionFn } from "@engine/world";
import { BuildPiece, EdgeSide } from "../components.js";
import { gameplayDefs } from "../config.js";
import { SocketKind } from "../defs.js";
import { edgeKey, structures, StructureIndex, StructureIndexRes } from "./structure.js";

export interface Shelter {
  covered: boolean; enclosed: boolean;
  /** 0 (inside a closed roofed room) .. 1 (open sky): cold / temperature exposure (shelter warmth, wall insulation). */
  exposure: number;
  /** Wall insulation in deg C around the tile (tier-scaled, window walls halved), averaged over the 4 edges. */
  insulation: number;
  /** ADR-312: rain / snow exposure 0..1 (a roof overhead blocks most of it). */
  rain: number;
  /** ADR-312: wind-chill exposure 0..1 (walls around block most of it). */
  wind: number;
  /** ADR-312: sun / heat exposure 0..1 (roof shade first, walls a little). */
  sun: number;
  /** ADR-312: overall protection from the elements 0 (none) .. 1 (fully enclosed and roofed), for the HUD shelter icon. */
  factor: number;
}

const OPEN: Shelter = { covered: false, enclosed: false, exposure: 1, insulation: 0, rain: 1, wind: 1, sun: 1, factor: 0 };

/** A wall piece for insulation purposes: a wall-family or corner wall, not a wall-mounted decor piece. */
const isWallPiece = (d: { family?: string; features?: { mount?: boolean } } | undefined): boolean =>
  !!d && (d.family === "wall" || d.family === "corner") && !d.features?.mount;

/** Insulation in deg C from one wall: rises 0.75 per material tier, halved when the wall has a window. */
export const WALL_INSULATION_PER_TIER = [0.75, 1.5, 2.25, 3, 3.75];
export function wallInsulationOf(def: { family?: string; opening?: unknown } | undefined, tier: number, hasWindow: boolean): number {
  if (!isWallPiece(def as { family?: string; features?: { mount?: boolean } })) return 0;
  return (WALL_INSULATION_PER_TIER[Math.min(Math.max(tier, 0), WALL_INSULATION_PER_TIER.length - 1)] ?? 1.5) * (hasWindow ? 0.5 : 1);
}

// Task 29: the 4 edge walls around a tile, as (dx, dy, side) offsets — StructureIndex.tileEdges
// allocates 4 fresh arrays per call; this table is shared. Same edges, same order.
const TILE_EDGE_OFFSETS: readonly (readonly [number, number, EdgeSide])[] = [[0, 0, EdgeSide.North], [0, 1, EdgeSide.North], [0, 0, EdgeSide.West], [1, 0, EdgeSide.West]];
/** Wall insulation around a tile at a level: the 4 edge walls' insulation, averaged over the 4 edges. */
export function wallInsulationAt(world: World, x: number, y: number, z: number): number {
  const idx = world.getResource(StructureIndexRes); if (!idx || idx.count === 0) return 0;
  const level = Math.max(0, Math.round(z / gameplayDefs(world).building.levelHeight));
  const tx = Math.floor(x), ty = Math.floor(y);
  let sum = 0;
  for (const [dx, dy, side] of TILE_EDGE_OFFSETS) {
    const w = idx.edge(tx + dx, ty + dy, level, side); if (!w) continue;
    const d = idx.def(w); if (!d) continue;
    const opening = idx.opening(w); const insert = opening ? idx.def(opening) : undefined;
    const hasWindow = d.opening === SocketKind.Window || insert?.fits === SocketKind.Window;
    const tier = world.getField(w, BuildPiece, "tier") ?? 1;
    sum += wallInsulationOf(d, tier, hasWindow);
  }
  return sum / 4;
}

// ---------- ADR-312: partial shelter from the base pieces around a tile ----------
/** Shelter weight of one edge piece (before its condition): a solid wall blocks the most, a closed door nearly as much. */
export const SHELTER_EDGE = { wall: 1, lowWall: 0.5, windowFilled: 0.8, windowOpen: 0.6, doorClosed: 0.9, doorOpen: 0.35, doorway: 0.25 } as const;
/** Condition multiplier by BuildPiece.damageStage (0 intact, 1 scuffed, 2 cracked, 3 wrecked): damaged pieces shelter less. */
export const SHELTER_CONDITION = [1, 0.85, 0.6, 0.3] as const;
/** Tiles searched outward in each cardinal direction for the nearest wall of the room (a 9x9 room's centre still sees all 4). */
export const SHELTER_RING = 4;
/** Ticks a cached per-tile roof / wall reading stays valid (structural changes and door toggles invalidate at once). */
export const SHELTER_CACHE_TICKS = 20;
/** Overall shelter below this is not shown on the HUD (a lone wall a few tiles away is not "shelter"). */
export const SHELTER_ICON_MIN = 0.1;

const conditionOf = (world: World, e: Entity): number => SHELTER_CONDITION[Math.min(3, world.getField(e, BuildPiece, "damageStage") ?? 0)] ?? 0.3;

/** Shelter weight (0..1) of the edge piece `w` (a wall, window wall or doorway with its insert), or 0 for non-walls. */
export function edgeShelterOf(world: World, idx: StructureIndex, w: Entity): number {
  const d = idx.def(w); if (!isWallPiece(d)) return 0;
  let v: number = d!.key === "wall_low" ? SHELTER_EDGE.lowWall : SHELTER_EDGE.wall;
  const op = idx.opening(w); const od = op ? idx.def(op) : undefined;
  if (d!.opening === SocketKind.Door) {
    if (!op || !od?.door) v = SHELTER_EDGE.doorway;
    else return (idx.doorOpen(op) ? SHELTER_EDGE.doorOpen : SHELTER_EDGE.doorClosed) * Math.min(conditionOf(world, w), conditionOf(world, op));
  } else if (d!.opening === SocketKind.Window) v = op ? SHELTER_EDGE.windowFilled : SHELTER_EDGE.windowOpen;
  return v * conditionOf(world, w);
}

/** Roof cover (0..1) over a tile: the condition of the lowest roof / deck above `level`, 0 when nothing is overhead. */
function roofCoverAt(world: World, idx: StructureIndex, tx: number, ty: number, level: number): number {
  if (!idx.grid.isCovered(tx, ty, level)) return 0;
  for (let lv = level + 1; lv < level + 8; lv++) { const e = idx.deck(tx, ty, lv); if (e) return conditionOf(world, e); }
  return 1;
}

/**
 * Wall ring (0..1) around a tile: in each of the 4 cardinal directions, the nearest edge wall within SHELTER_RING
 * tiles counts its SHELTER_EDGE weight x condition (L-corner arms are edges too; free posts do not count); the 4 are averaged.
 */
function wallRingAt(world: World, idx: StructureIndex, tx: number, ty: number, level: number): number {
  let sum = 0;
  // [dx, dy, edge offset x, edge offset y, side] for N, S, W, E
  for (const [dx, dy, ox, oy, side] of RING_DIRS) {
    let x = tx, y = ty;
    for (let k = 0; k < SHELTER_RING; k++) {
      const w = idx.edge(x + ox, y + oy, level, side);
      if (w) { sum += edgeShelterOf(world, idx, w); break; }
      x += dx; y += dy;
    }
  }
  return sum / 4;
}
const RING_DIRS: readonly (readonly [number, number, number, number, EdgeSide])[] = [[0, -1, 0, 0, EdgeSide.North], [0, 1, 0, 1, EdgeSide.North], [-1, 0, 0, 0, EdgeSide.West], [1, 0, 1, 0, EdgeSide.West]];

interface RingCache { version: number; tiles: Map<number, { tick: number; roof: number; walls: number }> }
const ringCaches = new WeakMap<StructureIndex, RingCache>();
/** Cached roof cover and wall ring for a tile (per StructureIndex version, refreshed every SHELTER_CACHE_TICKS for damage). */
export function shelterPartsAt(world: World, idx: StructureIndex, tx: number, ty: number, level: number): { roof: number; walls: number } {
  let c = ringCaches.get(idx); if (!c) ringCaches.set(idx, (c = { version: idx.version, tiles: new Map() }));
  if (c.version !== idx.version || c.tiles.size > 8192) { c.version = idx.version; c.tiles.clear(); }
  const key = edgeKey(tx, ty, level, EdgeSide.North); const hit = c.tiles.get(key);
  if (hit && world.tick - hit.tick < SHELTER_CACHE_TICKS && world.tick >= hit.tick) return hit;
  const r = { tick: world.tick, roof: roofCoverAt(world, idx, tx, ty, level), walls: wallRingAt(world, idx, tx, ty, level) };
  c.tiles.set(key, r); return r;
}

/**
 * ADR-312 graduated shelter from roof cover R and wall ring W (both 0..1), as exposures 0..1:
 * rain = 1 - (R(0.8 + 0.2W) + (1-R)0.2W)  — a roof alone blocks 80% of rain, walls add driven-rain cover;
 * wind = 1 - (0.85W + 0.15R)               — walls block wind, a roof barely;
 * cold = 1 - (0.6W + 0.4R)                 — shelter warmth / wall insulation;
 * sun  = 1 - (0.75R + 0.25W)               — roof shade first.
 */
export function partialExposure(roof: number, walls: number): { rain: number; wind: number; cold: number; sun: number } {
  const R = Math.min(1, Math.max(0, roof)), W = Math.min(1, Math.max(0, walls));
  return { rain: 1 - (R * (0.8 + 0.2 * W) + (1 - R) * 0.2 * W), wind: 1 - (0.85 * W + 0.15 * R), cold: 1 - (0.6 * W + 0.4 * R), sun: 1 - (0.75 * R + 0.25 * W) };
}

export function shelterAt(world: World, x: number, y: number, z: number, windDir?: number): Shelter {
  const idx = world.getResource(StructureIndexRes); if (!idx || idx.count === 0) return OPEN;
  const level = Math.max(0, Math.round(z / gameplayDefs(world).building.levelHeight));
  const tx = Math.floor(x), ty = Math.floor(y);
  const covered = idx.grid.isCovered(tx, ty, level);
  const enc = idx.edgeEnclosure(tx, ty, level);
  const insulation = wallInsulationAt(world, x, y, z);
  // Fully enclosed + roofed: unchanged full-indoors behaviour (every exposure 0).
  if (enc.enclosed && covered) return { covered, enclosed: true, exposure: 0, insulation, rain: 0, wind: 0, sun: 0, factor: 1 };
  let e = idx.grid.exposure(x, y, level, windDir);
  if (enc.enclosed) e *= 0.5;
  // ADR-312: graduated partial shelter from the roof overhead and the walls / doors / windows around; never worse
  // than the legacy exposure (min), so nothing that sheltered before shelters less now.
  let rain = e, wind = e, sun = e, cold = e;
  if (idx.anyPieceNear(tx - SHELTER_RING, ty - SHELTER_RING, tx + SHELTER_RING, ty + SHELTER_RING)) {
    const parts = shelterPartsAt(world, idx, tx, ty, level);
    if (parts.roof > 0 || parts.walls > 0) {
      const p = partialExposure(parts.roof, parts.walls);
      rain = Math.min(e, p.rain); wind = Math.min(e, p.wind); cold = Math.min(e, p.cold); sun = Math.min(e, p.sun);
    }
  }
  const factor = Math.max(0, Math.min(1, 1 - (rain + wind + cold) / 3));
  return { covered, enclosed: enc.enclosed, exposure: cold, insulation, rain, wind, sun, factor };
}

/**
 * Emitter occlusion for the world EmitterIndex: BuildingGrid cell occlusion (world buildingOcclusion) times thin edge
 * walls / closed doors crossed on the segment (gameplay EdgeIndex).
 */
export function structureOcclusion(world: World): OcclusionFn {
  const idx = structures(world); const cells = buildingOcclusion(idx.grid); const lh = gameplayDefs(world).building.levelHeight;
  return (kind, a, b) => {
    const c = cells(kind, a, b); if (c === 0 || idx.edges.size === 0) return c;
    const z = Math.max(0, Math.floor(b.z / lh + 1e-6));
    const d = Math.hypot(b.x - a.x, b.y - a.y); const n = Math.max(1, Math.ceil(d * 3));
    let px = Math.floor(a.x), py = Math.floor(a.y);
    for (let i = 1; i <= n; i++) {
      const x = Math.floor(a.x + ((b.x - a.x) * i) / n), y = Math.floor(a.y + ((b.y - a.y) * i) / n);
      if (x !== px && idx.edgeBlocker(Math.max(x, px), py, z, EdgeSide.West)) return 0;
      if (y !== py && idx.edgeBlocker(x, Math.max(y, py), z, EdgeSide.North)) return 0;
      px = x; py = y;
    }
    return c;
  };
}
