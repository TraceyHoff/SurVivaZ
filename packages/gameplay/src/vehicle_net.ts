/**
 * Vehicle netcode helpers (ADR-102, docs/ARCHITECTURE.md "Vehicles on the wire"). Pure gameplay, no @engine/net:
 *  - netIdEntity: O(1) NetId -> Entity lookup (cached map, kept in sync through world.onSpawn/onDespawn + lazy
 *    validation), used by vehicleByNetId / ridingVehicle / hitch chains instead of query scans.
 *  - controlledVehicles: the vehicle a locally-owned rider drives (seat 0) + its hitched trailer chain. The client feeds
 *    it to NetClient `controlled` so the driver predicts and reconciles the vehicle like its own player.
 *  - poseTrailersInHitchFrame: remote (interpolated) trailers are re-posed on the parent's interpolated rear hitch pin
 *    so a trailer never separates from / jitters against its tow when their snapshots land on different ticks.
 *  - vehicleViewChunks: speed -> AOI chunk bonus with hysteresis (rises at 8 / 16 tiles/s, falls at 6 / 13).
 *  - riderMaxSpeed: per-entity speed cap for net AntiCheat (`maxSpeedFor`).
 *  - vehicleGuardSystem: server-side per-tick vehicle speed / teleport sanity check (reverts the step, reports).
 */
import { defineResource, NetId, Transform, type Entity, type World } from "@engine/core";
import { Driver, Hitch, Mount, Riding, Vehicle, VehicleSeats } from "./components.js";
import { mountSpecies } from "./mount_defs.js";
import { ROADS } from "./roads.js";
import { isAuthority } from "./config.js";
import { hitchPoint, mountRearPinPos, mountTowPose, vehicleDefOf, VEHICLE_TUNING } from "./vehicles.js";

// ---- O(1) NetId index ---------------------------------------------------------------------------------
interface NetIdIndex { map: Map<number, Entity>; dirty: boolean; size: number }
const NetIdIndexRes = defineResource<NetIdIndex>("gameplay.NetIdIndex");
function index(world: World): NetIdIndex {
  let ix = world.getResource(NetIdIndexRes);
  if (!ix) {
    ix = { map: new Map(), dirty: true, size: -1 }; world.setResource(NetIdIndexRes, ix);
    const st = ix;
    world.onSpawn(() => { st.dirty = true; }); // NetId is usually added right after create: rebuild on the next miss
    world.onDespawn((e) => { const id = world.getField(e, NetId, "id"); if (id && st.map.get(id) === e) st.map.delete(id); });
  }
  return ix;
}
function rebuild(world: World, ix: NetIdIndex): void {
  ix.map.clear(); for (const e of world.query([NetId])) { const id = world.getField(e, NetId, "id")!; if (id) ix.map.set(id, e); }
  ix.dirty = false; ix.size = world.store(NetId).size;
}
/**
 * Entity holding NetId `id` (0 / unknown -> undefined). Amortised O(1): a hit is validated (alive + same id); a miss
 * rebuilds only if an entity spawned or the NetId count changed since the last rebuild (NetId added after spawn).
 * Re-assigning an id in place needs invalidateNetIdIndex.
 */
export function netIdEntity(world: World, id: number): Entity | undefined {
  if (!id) return undefined;
  const ix = index(world); let e = ix.map.get(id);
  if (e !== undefined && world.isAlive(e) && world.getField(e, NetId, "id") === id) return e;
  if (e !== undefined) ix.map.delete(id);
  if (!ix.dirty && e === undefined && world.store(NetId).size === ix.size) return undefined;
  rebuild(world, ix); e = ix.map.get(id);
  return e;
}
/** Force the next lookup miss to rebuild (call after re-assigning a NetId in place; spawns/despawns are automatic). */
export function invalidateNetIdIndex(world: World): void { index(world).dirty = true; }

// ---- prediction set -----------------------------------------------------------------------------------
/** Vehicles to predict for these riders: each seat-0 rider's vehicle plus its trailer chain (tow order, max 8). */
export function controlledVehicles(world: World, riders: readonly Entity[]): Entity[] {
  const out: Entity[] = [];
  for (const r of riders) {
    if (!world.isAlive(r) || !world.has(r, Driver) || world.getField(r, Driver, "seat") !== 0) continue;
    let v = netIdEntity(world, world.getField(r, Driver, "vehicleNetId")!);
    if (v === undefined || !world.has(v, Vehicle)) continue;
    const seats = world.get(v, VehicleSeats)?.occupant as ArrayLike<number> | undefined;
    if (!seats || seats[0] !== world.getField(r, NetId, "id")) continue; // replicated seat must agree
    for (let n = 0; v !== undefined && n < 9 && !out.includes(v); n++) {
      out.push(v); const tow: number = world.getField(v, Hitch, "towNetId") ?? 0; v = tow ? netIdEntity(world, tow) : undefined;
    }
  }
  return out;
}

// ---- trailer hitch frame --------------------------------------------------------------------------------
const wrap = (a: number): number => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };
/**
 * Client, after interpolation: put every non-predicted hitched trailer on its parent's (interpolated) rear pin,
 * keeping the trailer's interpolated heading (clamped to maxArticulation). Parents first (chain order). Uses
 * Transform.facing (interpolated), not Vehicle.heading (latest snapshot). Returns how many trailers were posed.
 */
export function poseTrailersInHitchFrame(world: World): number {
  const trailers: Entity[] = [];
  for (const e of world.query([Vehicle, Hitch, Transform])) if (world.getField(e, Hitch, "parentNetId") && !world.predicted.has(e)) trailers.push(e);
  if (!trailers.length) return 0;
  const depth = (e: Entity): number => { let n = 0; for (let p = e; n < 8; n++) { const q = netIdEntity(world, world.getField(p, Hitch, "parentNetId") ?? 0); if (q === undefined || !world.has(q, Hitch)) break; p = q; } return n; };
  trailers.sort((a, b) => depth(a) - depth(b) || a - b);
  let posed = 0;
  for (const tr of trailers) {
    const tow = netIdEntity(world, world.getField(tr, Hitch, "parentNetId")!); if (tow === undefined || !world.has(tow, Transform)) continue;
    const d = vehicleDefOf(world, tr); if (!d) continue;
    const front = d.hitches.find((h) => h.at === "front"); if (!front) continue;
    // ADR-358: a mount tow pins to the mount's rear pin (rider pose when ridden), not a vehicle rear hitch
    let pin: { x: number; y: number } | undefined; let towFacing: number;
    if (world.has(tow, Mount)) {
      const pose = mountTowPose(world, tow); if (!pose) continue;
      pin = mountRearPinPos(pose.x, pose.y, pose.facing, pose.species); towFacing = pose.facing;
    } else {
      const td = vehicleDefOf(world, tow); if (!td) continue;
      const tt = world.get(tow, Transform)!; pin = hitchPoint(td, "rear", tt.x, tt.y, tt.facing); towFacing = tt.facing;
    }
    if (!pin) continue;
    const t = world.get(tr, Transform)!; let h = t.facing;
    const rel = wrap(h - towFacing); if (Math.abs(rel) > VEHICLE_TUNING.maxArticulation) h = wrap(towFacing + Math.sign(rel) * VEHICLE_TUNING.maxArticulation);
    const x = pin.x - Math.cos(h) * front.offset, y = pin.y - Math.sin(h) * front.offset;
    if (x !== t.x || y !== t.y || h !== t.facing) { world.set(tr, Transform, { x, y, facing: h }); posed++; }
  }
  return posed;
}

// ---- interest radius at speed -------------------------------------------------------------------------
/** Speed thresholds (tiles/s) per extra chunk: rise at `up[i]`, fall below `down[i]` (hysteresis). Net caps at 2. */
export const VEHICLE_VIEW_BONUS = { up: [8, 16] as readonly number[], down: [6, 13] as readonly number[] };
export function vehicleViewChunks(speed: number, prev: number): number {
  const s = Math.abs(speed); const { up, down } = VEHICLE_VIEW_BONUS; let c = Math.min(prev, up.length);
  while (c < up.length && s >= up[c]!) c++;
  while (c > 0 && s < down[c - 1]!) c--;
  return c;
}
/** Speed of the vehicle `rider` sits in (any seat), else 0. */
export function riderVehicleSpeed(world: World, rider: Entity): number {
  if (!world.has(rider, Driver)) return 0;
  const v = netIdEntity(world, world.getField(rider, Driver, "vehicleNetId")!);
  return v === undefined ? 0 : (world.getField(v, Vehicle, "speed") ?? 0);
}

// ---- anti-cheat -----------------------------------------------------------------------------------------
/** Top speed (tiles/s, incl. boost) of the vehicle `e` rides, or undefined when on foot (AntiCheat maxSpeedFor). */
export function riderMaxSpeed(world: World, e: Entity): number | undefined {
  if (world.isRegistered(Riding) && world.has(e, Riding)) { const s = mountSpecies(world.getField(e, Riding, "species") ?? 0); return s ? s.gallop * Math.max(1, ...ROADS.surfaces.map((r) => r.speedMul)) : undefined; } // ADR-319
  if (!world.has(e, Driver)) return undefined;
  const v = netIdEntity(world, world.getField(e, Driver, "vehicleNetId")!); const d = v === undefined ? undefined : vehicleDefOf(world, v);
  return d ? d.maxSpeed * VEHICLE_TUNING.boostMul : undefined;
}
export type VehicleViolation = { vehicle: Entity; driver: Entity | undefined; kind: "speed" | "teleport"; distance: number };
interface VehicleGuard { last: Map<Entity, { x: number; y: number; tick: number }>; report: (v: VehicleViolation) => void; tolerance: number; teleport: number; allow?: (v: Entity) => boolean }
export const VehicleGuardRes = defineResource<VehicleGuard>("gameplay.VehicleGuard");
/**
 * Server: check every vehicle's per-tick displacement against its def (maxSpeed * boostMul * (1 + tolerance)). A
 * violation reverts the vehicle (and riders) to the last good pose, zeroes its speed and calls `report` (the server
 * maps it to an anomaly on the driver's session). `teleport` tiles/tick = a "teleport" instead of "speed".
 * `allow(v)` sanctions a jump (gameplay teleport / respawn).
 */
export function installVehicleGuard(world: World, report: (v: VehicleViolation) => void, opts: { tolerance?: number; teleport?: number; allow?: (v: Entity) => boolean } = {}): void {
  world.setResource(VehicleGuardRes, { last: new Map(), report, tolerance: opts.tolerance ?? 0.25, teleport: opts.teleport ?? 4, ...(opts.allow && { allow: opts.allow }) });
}
export function vehicleGuardSystem(world: World, dt: number): void {
  const g = world.getResource(VehicleGuardRes); if (!g || !isAuthority(world) || world.isReplaying) return;
  const seen = new Set<Entity>();
  for (const v of world.query([Vehicle, Transform])) {
    seen.add(v); const t = world.get(v, Transform)!; const p = g.last.get(v); const d = vehicleDefOf(world, v);
    if (!p || !d) { g.last.set(v, { x: t.x, y: t.y, tick: world.tick }); continue; }
    const ticks = Math.max(1, world.tick - p.tick); const dist = Math.hypot(t.x - p.x, t.y - p.y);
    // trailers (maxSpeed 0) swing on the pin joint and snap onto a hitch: only the teleport bound applies to them
    const lim = d.class === "trailer" ? g.teleport * ticks : d.maxSpeed * VEHICLE_TUNING.boostMul * dt * (1 + g.tolerance) * ticks;
    const seats = world.get(v, VehicleSeats)?.occupant as ArrayLike<number> | undefined;
    // only player-driven motion is policed: a seat-0 driver, or a trailer on a hitch; scripted/admin moves of parked vehicles pass
    const policed = (seats !== undefined && seats[0] !== 0) || (world.getField(v, Hitch, "parentNetId") ?? 0) !== 0;
    if (!policed || dist <= lim + 1e-6 || g.allow?.(v)) { g.last.set(v, { x: t.x, y: t.y, tick: world.tick }); continue; }
    const driver = seats && seats[0] ? netIdEntity(world, seats[0]) : undefined;
    world.set(v, Transform, { x: p.x, y: p.y }); world.setField(v, Vehicle, "speed", 0);
    for (let i = 0; seats && i < seats.length; i++) { const r = seats[i] ? netIdEntity(world, seats[i]!) : undefined; if (r !== undefined && world.has(r, Transform)) world.set(r, Transform, { x: p.x, y: p.y }); }
    g.report({ vehicle: v, driver, kind: dist > g.teleport * ticks ? "teleport" : "speed", distance: dist });
  }
  for (const v of [...g.last.keys()]) if (!seen.has(v)) g.last.delete(v);
}

// ---- wire metadata ----------------------------------------------------------------------------------------
/** Every reason string the vehicle validators return (append-only; apps/server appends these to its wire codes). */
export const VEHICLE_REJECT_REASONS = ["dead", "already_riding", "not_vehicle", "no_seats", "no_net_id", "wrecked", "too_far", "moving", "full", "bad_seat", "seat_taken",
  "not_riding", "actor_too_far", "already_hitched", "cycle", "incompatible", "no_hitch", "not_hitched", "tow_busy", "no_station"] as const;
/** Per-second rate limits of the vehicle commands on the wire (burst = 2x). */
export const VEHICLE_COMMAND_RATES: Readonly<Record<string, number>> = {
  "gameplay.vehicleEnter": 4, "gameplay.vehicleExit": 4, "gameplay.vehicleHitch": 4, "gameplay.vehicleUnhitch": 4, "gameplay.vehicleStation": 4,
};
