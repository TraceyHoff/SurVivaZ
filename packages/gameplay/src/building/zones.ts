/**
 * ADR-315: claim-zone grid. Every privilege zone (a Claim Flag's PrivilegeZone) is bucketed into the ZONE_CELL grid
 * cells its largest possible disk (MAX_PRIVILEGE_RADIUS) can touch, so `zonesAt` / the claim-overlap test read one cell
 * (a point) or a handful (a disk) instead of scanning every zone or the shared entity hash out to the full radius.
 *
 * The grid rebuilds only when zone membership changes (ComponentStore.membership: a flag placed, destroyed, loaded or
 * replicated) — O(zones), and those events are rare; queries re-check each candidate's live radius and position, and a
 * zone found away from its bucketed position (replica correction) forces a rebuild, so results are always exact.
 */
import { defineResource, Transform, type Entity, type World } from "@engine/core";
import { PieceOwner, PrivilegeZone } from "../components.js";

/** Upper bound on any claim radius (tiles). Pieces' privilegeRadius must stay <= this (checked by the ADR-315 test). */
export const MAX_PRIVILEGE_RADIUS = 40;
/** Grid cell size (tiles): one world chunk, about one claim radius. */
export const ZONE_CELL = 32;
/** Two claims "touch" (allowed) when their rims meet within this tolerance; closer than that they overlap. */
export const CLAIM_TOUCH_EPS = 1e-3;

interface ZoneGrid { ver: number; cells: Map<number, Entity[]>; pos: Map<Entity, { x: number; y: number }>; stale: boolean; rebuilds: number; all: Entity[] }
const ZoneGridRes = defineResource<ZoneGrid>("gameplay.ZoneGrid");
const key = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768);
const cell = (v: number): number => Math.floor(v / ZONE_CELL);

function grid(world: World): ZoneGrid {
  let g = world.getResource(ZoneGridRes);
  if (!g) world.setResource(ZoneGridRes, (g = { ver: -1, cells: new Map(), pos: new Map(), stale: true, rebuilds: 0, all: [] }));
  if (!world.isRegistered(PrivilegeZone)) { g.cells.clear(); g.pos.clear(); g.all = []; return g; }
  const st = world.store(PrivilegeZone);
  if (g.stale || g.ver !== st.membership) {
    g.ver = st.membership; g.stale = false; g.rebuilds++; g.cells.clear(); g.pos.clear(); g.all = [];
    for (let i = 0; i < st.size; i++) {
      const e = st.dense[i]! as Entity; if (!world.isAlive(e)) continue;
      const t = world.get(e, Transform); if (!t) { g.stale = true; continue; } // Transform not in yet (replica): rebuild next query
      g.pos.set(e, { x: t.x, y: t.y }); g.all.push(e);
      const R = MAX_PRIVILEGE_RADIUS;
      for (let cy = cell(t.y - R); cy <= cell(t.y + R); cy++) for (let cx = cell(t.x - R); cx <= cell(t.x + R); cx++) {
        const k = key(cx, cy); let b = g.cells.get(k); if (!b) g.cells.set(k, (b = [])); b.push(e);
      }
    }
    g.all.sort((a, b) => a - b);
  }
  return g;
}

/** Zones whose disk comes within `extra` of (x,y): distance <= radius + extra. Ascending entity order. `extra` <= MAX_PRIVILEGE_RADIUS. */
export function zonesNear(world: World, x: number, y: number, extra = 0): Entity[] {
  for (let attempt = 0; attempt < 2; attempt++) {
    const g = grid(world); const out: Entity[] = []; let seen: Set<Entity> | undefined; let moved = false;
    const x0 = cell(x - extra), x1 = cell(x + extra), y0 = cell(y - extra), y1 = cell(y + extra); const multi = x0 !== x1 || y0 !== y1;
    if (multi) seen = new Set();
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const b = g.cells.get(key(cx, cy)); if (!b) continue;
      for (const z of b) {
        if (seen) { if (seen.has(z)) continue; seen.add(z); }
        const r = world.getField(z, PrivilegeZone, "radius"); if (r === undefined) continue;
        const zx = world.getField(z, Transform, "x"), zy = world.getField(z, Transform, "y"); if (zx === undefined || zy === undefined) continue;
        const p = g.pos.get(z)!; if (p.x !== zx || p.y !== zy) moved = true;
        if (Math.hypot(zx - x, zy - y) <= r + extra) out.push(z);
      }
    }
    if (!moved) return out.sort((a, b) => a - b);
    g.stale = true; // a zone moved since it was bucketed: rebuild and query again
  }
  return scanZones(world, x, y, extra);
}
/** Reference full scan (tests / fallback). */
export function scanZones(world: World, x: number, y: number, extra = 0): Entity[] {
  const out: Entity[] = []; if (!world.isRegistered(PrivilegeZone)) return out;
  for (const z of world.query([PrivilegeZone, Transform])) {
    const r = world.getField(z, PrivilegeZone, "radius")!; const t = world.get(z, Transform)!;
    if (Math.hypot(t.x - x, t.y - y) <= r + extra) out.push(z);
  }
  return out.sort((a, b) => a - b);
}
/** Every live zone, ascending (rebuilt with the grid). */
export const allZones = (world: World): readonly Entity[] => grid(world).all;
/** Grid rebuild count (perf tests). */
export const zoneGridRebuilds = (world: World): number => world.getResource(ZoneGridRes)?.rebuilds ?? 0;
/** Force a rebuild (after a bulk radius change, e.g. the legacy-claim migration). */
export function invalidateZoneGrid(world: World): void { const g = world.getResource(ZoneGridRes); if (g) g.stale = true; }

/** Two claims belong to the same party: same (nonzero) tribe / clan, or the same owning player. */
export function zonesShareOwner(world: World, a: Entity, b: Entity): boolean {
  const ta = world.getField(a, PrivilegeZone, "tribe") ?? 0, tb = world.getField(b, PrivilegeZone, "tribe") ?? 0;
  if (ta && ta === tb) return true;
  if (!world.isRegistered(PieceOwner)) return false;
  const pa = world.getField(a, PieceOwner, "player") ?? 0, pb = world.getField(b, PieceOwner, "player") ?? 0;
  return !!pa && pa === pb;
}
/**
 * ADR-315: the first existing claim a new claim of `radius` at (x,y) would overlap (any owner — own, clan, foreign),
 * or undefined. Rims may touch (distance >= r1 + r2 - CLAIM_TOUCH_EPS); `ignore` skips one zone (the flag being moved).
 */
export function claimOverlap(world: World, x: number, y: number, radius: number, ignore?: Entity): Entity | undefined {
  for (const z of zonesNear(world, x, y, radius)) {
    if (z === ignore) continue;
    const r = world.getField(z, PrivilegeZone, "radius") ?? 0; const zx = world.getField(z, Transform, "x")!, zy = world.getField(z, Transform, "y")!;
    if (Math.hypot(zx - x, zy - y) < r + radius - CLAIM_TOUCH_EPS) return z;
  }
  return undefined;
}
