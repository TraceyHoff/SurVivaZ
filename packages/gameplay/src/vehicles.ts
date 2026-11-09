/**
 * Vehicles (engine foundation, docs/VEHICLES.md, ADR-096). Data: data/vehicles.json (schema data/vehicles.schema.json).
 *  - Defs: loadVehicleDefs/validateVehicleDefs; Vehicle.defId = index + 1 (append-only).
 *  - Components (components.ts, appended): Vehicle, VehicleSeats, Driver, Hitch; storage = Container on the vehicle.
 *  - Input: drivers reuse moveX/moveY (or move bits) + Sprint (boost) via applyGameplayInput -> setDriveInput, so bots
 *    (AgentOutput) and every device drive the same way. Enter/exit/hitch/unhitch/station use are validated commands
 *    (installVehicleCommands on the server CommandHandlers, ADR-092 path; Interact -> vehicleInteractCommand).
 *  - gameplay.vehicles (simulation, every peer): deterministic arcade kinematic bicycle model with drift, footprint
 *    collision against movementBlocked (or setVehicleBlocker), trailer pin-joint articulation, riders follow seats.
 *  - Camper interior: usableVehicleStations / addVehicleStationHook; stations usable only while parked.
 */
import { roadVehicleMul } from "./roads.js";
import { AnimState as Anim, defineCommand, defineResource, fnv1a, NetId, Transform, type CommandHandlers, type Entity, type World } from "@engine/core";
import raw from "../data/vehicles.json";
import stationsRaw from "../data/stations.json";
import storageRaw from "../data/vehicle_storage.json";
import { AnimState, Container, CONTAINER_MAX_SLOTS, Dead, Driver, Hitch, Survival, Vehicle, VehicleSeats, VehicleState, VEHICLE_ENGINE_ON, VEHICLE_HEADLIGHTS, VEHICLE_MAX_SEATS } from "./components.js";
import { movementBlocked } from "./systems/movement.js";
import { spendStamina } from "./systems/vitals.js";
import { netIdEntity } from "./vehicle_net.js";
import { hasKeyFor, keyIssueSystem } from "./vehicle_keys.js";
import { Riding, VehicleLock } from "./components.js";

export const VEHICLE_CLASSES = ["bicycle", "car", "truck", "van", "camper", "semi", "trailer"] as const;
export type VehicleClass = (typeof VEHICLE_CLASSES)[number];
export const VEHICLE_SIZES = ["xs", "s", "m", "l", "xl"] as const;
export type VehicleSize = (typeof VEHICLE_SIZES)[number];
/** Vehicle-local offset (ADR-101): x along the heading (+ front), y left (+ = exit side), z up (world z units). */
export interface VehicleAnchor { x: number; y: number; z: number }
/** anchor.x = +offset (front) / -offset (rear); render reads it instead of recomputing (VEHICLES_RENDER.md). */
export interface HitchPoint { at: "front" | "rear"; offset: number; accepts: VehicleClass[]; anchor: VehicleAnchor }
export interface VehicleDef {
  id: string; class: VehicleClass; size: VehicleSize; seats: number; /** one per seat, seat 0 = driver */ seatAnchors: VehicleAnchor[]; mass: number;
  maxSpeed: number; accel: number; brake: number; turn: number; grip: number;
  fuel: { capacity: number; perSecond: number } | null; stamina: { perSecond: number } | null; health: number;
  storage: { slots: number; maxWeight: number }; hitches: HitchPoint[]; interior: { stations: string[] };
  footprint: { length: number; width: number }; collider: { radius: number };
}
const STATIONS: Record<string, number> = (stationsRaw as { stations: Record<string, number> }).stations;

export function validateVehicleDefs(defs: readonly VehicleDef[]): string[] {
  const errs: string[] = []; const ids = new Set<string>();
  for (const d of defs) {
    const p = `vehicle ${d.id}`;
    if (ids.has(d.id)) errs.push(`${p}: duplicate id`); ids.add(d.id);
    if (!VEHICLE_CLASSES.includes(d.class)) errs.push(`${p}: class`);
    if (!VEHICLE_SIZES.includes(d.size)) errs.push(`${p}: size`);
    if (!(d.seats >= 0 && d.seats <= VEHICLE_MAX_SEATS) || !Number.isInteger(d.seats)) errs.push(`${p}: seats`);
    if (d.class === "trailer" ? d.seats !== 0 : d.seats < 1) errs.push(`${p}: seats for class`);
    if (d.class === "bicycle" && (d.fuel || !d.stamina)) errs.push(`${p}: bicycles use stamina, not fuel`);
    if (d.class !== "bicycle" && d.class !== "trailer" && !d.fuel) errs.push(`${p}: motor vehicles need fuel`);
    if (!(d.mass > 0) || !(d.health > 0) || !(d.collider.radius > 0) || !(d.footprint.length > 0) || !(d.footprint.width > 0)) errs.push(`${p}: mass/health/footprint/collider`);
    if (!(d.grip >= 0 && d.grip <= 1)) errs.push(`${p}: grip`);
    if (!(d.storage.slots >= 0 && d.storage.slots <= CONTAINER_MAX_SLOTS) || !(d.storage.maxWeight >= 0)) errs.push(`${p}: storage (slots <= ${CONTAINER_MAX_SLOTS})`);
    const fin = (a: VehicleAnchor | undefined): boolean => !!a && [a.x, a.y, a.z].every(Number.isFinite);
    if (!Array.isArray(d.seatAnchors) || d.seatAnchors.length !== d.seats || !d.seatAnchors.every(fin)) errs.push(`${p}: seatAnchors (one {x,y,z} per seat)`);
    const ats = new Set<string>();
    for (const h of d.hitches) {
      if (ats.has(h.at)) errs.push(`${p}: duplicate ${h.at} hitch`); ats.add(h.at);
      if (!fin(h.anchor) || Math.abs(h.anchor.x - (h.at === "front" ? h.offset : -h.offset)) > 1e-6) errs.push(`${p}: ${h.at} hitch anchor.x must be ${h.at === "front" ? "+" : "-"}offset`);
      for (const c of h.accepts) if (!VEHICLE_CLASSES.includes(c)) errs.push(`${p}: hitch accepts ${c}`);
    }
    if (d.class === "trailer" && !d.hitches.some((h) => h.at === "front")) errs.push(`${p}: trailer needs a front hitch`);
    for (const s of d.interior.stations) if (!(s in STATIONS)) errs.push(`${p}: unknown station ${s}`);
  }
  if (defs.length > 0xfffe) errs.push("too many vehicles (u16)");
  return errs;
}
/** Loads (and validates) a vehicles.json document. Throws on errors. */
export function loadVehicleDefs(doc: unknown): VehicleDef[] {
  const defs = (doc as { vehicles: VehicleDef[] }).vehicles; const errs = validateVehicleDefs(defs);
  if (errs.length) throw new Error(`vehicles.json: ${errs.join("; ")}`); return defs;
}
export const VEHICLE_DEFS: readonly VehicleDef[] = loadVehicleDefs(raw);
/** Mixed into the world schema hash (installGameplay) so peers with different vehicles.json refuse to connect. */
export const VEHICLE_DEFS_HASH: number = fnv1a(JSON.stringify(VEHICLE_DEFS)) >>> 0;
export const vehicleDefId = (id: string): number => VEHICLE_DEFS.findIndex((d) => d.id === id) + 1;
export const vehicleDef = (defId: number): VehicleDef | undefined => VEHICLE_DEFS[defId - 1];
export const vehicleDefOf = (world: World, e: Entity): VehicleDef | undefined => vehicleDef(world.getField(e, Vehicle, "defId") ?? 0);
/** ADR-098 class scaling (data/vehicle_storage.json): bike (<= 6) ... semi trailer (96). */
export const VEHICLE_STORAGE = storageRaw as { scale: Record<VehicleClass, number>; max: Record<VehicleClass, number> };
for (const c of VEHICLE_CLASSES) {
  const sc = VEHICLE_STORAGE.scale[c], mx = VEHICLE_STORAGE.max[c];
  if (!(sc > 0) || !(mx >= 1 && mx <= CONTAINER_MAX_SLOTS && Number.isInteger(mx))) throw new Error(`vehicle_storage.json: bad ${c}`);
}
/** Container capacity for a def: base slots scaled by class, clamped to the class max (<= CONTAINER_MAX_SLOTS). Weight unchanged. */
export const storageCapacity = (d: VehicleDef): { slots: number; maxWeight: number } => {
  if (d.storage.slots <= 0) return { slots: 0, maxWeight: d.storage.maxWeight };
  const slots = Math.max(1, Math.min(VEHICLE_STORAGE.max[d.class], CONTAINER_MAX_SLOTS, Math.round(d.storage.slots * VEHICLE_STORAGE.scale[d.class])));
  return { slots, maxWeight: d.storage.maxWeight };
};

// ---- tuning ---------------------------------------------------------------------------------------
export const VEHICLE_TUNING = {
  /** |speed| below this counts as parked (enter, hitch, interior stations). */
  parkedSpeed: 0.25, enterReach: 2, hitchRange: 1.5, stationReach: 2.5,
  boostMul: 1.3, reverseMul: 0.35, rollingDrag: 0.6, exhaustedThrottle: 0.35,
  /** Max trailer angle relative to its tow (rad) before the joint clamps (jackknife limit). */
  maxArticulation: 1.75, impactDamagePerSpeedTon: 4, bounce: 0.2,
} as const;

// ---- spawn / lookup -------------------------------------------------------------------------------
/** Spawns a vehicle (server). NetId is assigned by net; standalone tests add it themselves. */
export function spawnVehicle(world: World, def: number | string, x: number, y: number, heading = 0): Entity {
  const defId = typeof def === "string" ? vehicleDefId(def) : def; const d = vehicleDef(defId); if (!d) throw new Error(`unknown vehicle ${def}`);
  const e = world.create(); const cap = storageCapacity(d);
  world.add(e, Transform, { x, y, facing: heading })
    .add(e, Vehicle, { defId, heading, fuel: d.fuel?.capacity ?? 0, health: d.health })
    .add(e, Container, { slotCount: cap.slots, maxWeight: cap.maxWeight });
  if (d.seats > 0) world.add(e, VehicleSeats);
  if (d.hitches.length) world.add(e, Hitch);
  if (d.class !== "trailer") world.add(e, VehicleState);
  return e;
}
export const netIdOf = (world: World, e: Entity): number => world.getField(e, NetId, "id") ?? 0;
/** Vehicle entity for a NetId (0 / unknown -> undefined). */
export function vehicleByNetId(world: World, id: number): Entity | undefined {
  const e = netIdEntity(world, id); return e !== undefined && world.has(e, Vehicle) ? e : undefined; // O(1) (vehicle_net.ts)
}
const entityByNetId = (world: World, id: number): Entity | undefined => netIdEntity(world, id);
export const isParked = (world: World, v: Entity): boolean => Math.abs(world.getField(v, Vehicle, "speed") ?? 0) < VEHICLE_TUNING.parkedSpeed;
export const ridingVehicle = (world: World, rider: Entity): Entity | undefined => world.has(rider, Driver) ? vehicleByNetId(world, world.getField(rider, Driver, "vehicleNetId")!) : undefined;
const seatsOf = (world: World, v: Entity): ArrayLike<number> | undefined => world.has(v, VehicleSeats) ? (world.get(v, VehicleSeats)!.occupant as ArrayLike<number>) : undefined;
const writeSeat = (world: World, v: Entity, seat: number, id: number): void => {
  const occ = Array.from(world.get(v, VehicleSeats)!.occupant as ArrayLike<number>); occ[seat] = id; world.set(v, VehicleSeats, { occupant: occ });
};

// ---- drive input ------------------------------------------------------------------------------------
export interface DriveInput { x: number; y: number; boost: boolean }
/** Latest drive input per rider entity (sim-local; written in the input phase on every peer). */
export const DriveInputs = defineResource<Map<Entity, DriveInput>>("gameplay.DriveInputs");
export function setDriveInput(world: World, rider: Entity, x: number, y: number, boost: boolean): void {
  let m = world.getResource(DriveInputs); if (!m) world.setResource(DriveInputs, (m = new Map()));
  const len = Math.hypot(x, y); const k = len > 1 ? 1 / len : 1; m.set(rider, { x: x * k, y: y * k, boost });
}
/** Move bits (GameplayActions MoveUp..Right = bits 0..3, Sprint = bit 4) to a screen-iso direction, same as walking. */
export function driveFromBits(actions: number): DriveInput {
  let dx = 0, dy = 0;
  if (actions & 1) { dx -= 1; dy -= 1; } if (actions & 2) { dx += 1; dy += 1; } if (actions & 4) { dx -= 1; dy += 1; } if (actions & 8) { dx += 1; dy -= 1; }
  const l = Math.hypot(dx, dy) || 1; return { x: dx / l, y: dy / l, boost: (actions & 16) !== 0 };
}

// ---- collision --------------------------------------------------------------------------------------
export type VehicleBlocker = (world: World, x0: number, y0: number, x1: number, y1: number) => boolean;
export const VehicleBlockerRes = defineResource<VehicleBlocker>("gameplay.VehicleBlocker");
/** Override world collision for vehicles (tests, custom worlds). Default: movementBlocked at level 0. */
export function setVehicleBlocker(world: World, fn: VehicleBlocker): void { world.setResource(VehicleBlockerRes, fn); }
const blockerOf = (world: World): VehicleBlocker => world.getResource(VehicleBlockerRes) ?? ((w, a, b, c, d) => movementBlocked(w, a, b, c, d, 0));
/** Footprint corners + center for a pose. */
function footprintPoints(d: VehicleDef, x: number, y: number, h: number): [number, number][] {
  const c = Math.cos(h), s = Math.sin(h), hl = d.footprint.length / 2, hw = d.footprint.width / 2;
  return [[x, y], [x + c * hl - s * hw, y + s * hl + c * hw], [x + c * hl + s * hw, y + s * hl - c * hw], [x - c * hl - s * hw, y - s * hl + c * hw], [x - c * hl + s * hw, y - s * hl - c * hw]];
}
function poseBlocked(world: World, d: VehicleDef, x0: number, y0: number, h0: number, x1: number, y1: number, h1: number): boolean {
  const b = blockerOf(world); const a = footprintPoints(d, x0, y0, h0), n = footprintPoints(d, x1, y1, h1);
  for (let i = 0; i < n.length; i++) if (b(world, a[i]![0], a[i]![1], n[i]![0], n[i]![1])) return true;
  return false;
}

// ---- physics ----------------------------------------------------------------------------------------
const wrap = (a: number): number => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const hitchOf = (d: VehicleDef, at: "front" | "rear"): HitchPoint | undefined => d.hitches.find((h) => h.at === at);
/** World position of a hitch point for a pose. */
export function hitchPoint(d: VehicleDef, at: "front" | "rear", x: number, y: number, heading: number): { x: number; y: number } | undefined {
  const h = hitchOf(d, at); if (!h) return undefined; const s = at === "front" ? 1 : -1;
  return { x: x + Math.cos(heading) * h.offset * s, y: y + Math.sin(heading) * h.offset * s };
}

/** One tick of a powered vehicle (pure state step; exported for tests/tools). */
export function stepVehicleKinematics(d: VehicleDef, s: { x: number; y: number; speed: number; heading: number; drift: number; steer: number }, inp: DriveInput, throttleCap: number, dt: number, surfaceMul = 1): void {
  const T = VEHICLE_TUNING; const mag = Math.min(1, Math.hypot(inp.x, inp.y));
  let target = 0, steerTarget = 0;
  if (mag > 1e-3) {
    const want = Math.atan2(inp.y, inp.x); const diff = wrap(want - s.heading);
    const reverse = Math.abs(diff) > 2.4 && s.speed <= 0.5; // pull back -> reverse
    target = (reverse ? -T.reverseMul : 1) * mag * Math.min(1, throttleCap) * d.maxSpeed * surfaceMul * (inp.boost ? T.boostMul : 1);
    steerTarget = clamp(reverse ? wrap(diff + Math.PI) * -1 : diff, -0.6, 0.6);
    if (!reverse && Math.abs(diff) > Math.PI / 2 && s.speed > 1) target = 0; // braking into a U-turn
  }
  // longitudinal: accelerate toward target, brake when opposing, drag otherwise
  const dv = target - s.speed;
  const rate = target === 0 ? Math.max(T.rollingDrag, d.brake * 0.25) : Math.sign(dv) !== Math.sign(s.speed) && s.speed !== 0 ? d.brake : d.accel;
  s.speed += clamp(dv, -rate * dt, rate * dt);
  // steering + kinematic bicycle yaw (wheelbase ~ 0.6 length), capped by def.turn
  s.steer += clamp(steerTarget - s.steer, -4 * dt, 4 * dt);
  const L = d.footprint.length * 0.6; const yaw = clamp((s.speed * Math.tan(s.steer)) / L, -d.turn, d.turn);
  s.heading = wrap(s.heading + yaw * dt);
  // drift: velocity direction lags heading by (1 - grip); boost at speed loosens grip
  const grip = clamp(d.grip - (inp.boost && Math.abs(s.speed) > d.maxSpeed * 0.7 ? 0.25 : 0), 0.05, 1);
  s.drift = clamp(wrap(s.drift - yaw * dt) * (1 - grip * Math.min(1, dt * 12)), -0.9, 0.9);
  const va = s.heading + s.drift;
  s.x += Math.cos(va) * s.speed * dt; s.y += Math.sin(va) * s.speed * dt;
}

function stepPowered(world: World, v: Entity, d: VehicleDef, dt: number, inputs: Map<Entity, DriveInput> | undefined, riders: Map<number, Entity>): void {
  const T = VEHICLE_TUNING; const t = world.get(v, Transform)!; const st = world.get(v, Vehicle)!;
  const seats = seatsOf(world, v); const driver = seats && seats[0] ? riders.get(seats[0]) : undefined;
  const inp = (driver !== undefined && !world.has(driver, Dead) && inputs?.get(driver)) || { x: 0, y: 0, boost: false };
  let cap = 1, fuel = st.fuel;
  const mag = Math.min(1, Math.hypot(inp.x, inp.y));
  if (d.fuel) { if (fuel <= 0) cap = 0; else fuel = Math.max(0, fuel - d.fuel.perSecond * mag * (inp.boost ? T.boostMul : 1) * dt); }
  if (d.stamina && driver !== undefined && world.has(driver, Survival)) {
    const sta = world.getField(driver, Survival, "stamina")!;
    if (sta <= 0) cap = T.exhaustedThrottle;
    else if (mag > 0) spendStamina(world, driver, Math.min(sta, d.stamina.perSecond * mag * (inp.boost ? 2 : 1) * dt), dt); // pedalling pauses regen
  }
  if (st.health <= 0) cap = 0;
  const s = { x: t.x, y: t.y, speed: st.speed, heading: st.heading, drift: st.drift, steer: st.steer };
  if (mag === 0 && s.speed === 0 && s.steer === 0 && s.drift === 0) return; // at rest: no writes
  stepVehicleKinematics(d, s, inp, cap, dt, roadVehicleMul(world, t.x, t.y)); // ADR-119 road bonus
  let health = st.health;
  if (poseBlocked(world, d, t.x, t.y, st.heading, s.x, s.y, s.heading)) {
    // per-axis slide (keeps the free component); if the slide keeps < half the step it is an impact: stop, bounce, damage
    const want = Math.hypot(s.x - t.x, s.y - t.y);
    if (!poseBlocked(world, d, t.x, t.y, st.heading, s.x, t.y, s.heading)) s.y = t.y;
    else if (!poseBlocked(world, d, t.x, t.y, st.heading, t.x, s.y, s.heading)) s.x = t.x;
    else { s.x = t.x; s.y = t.y; }
    if (Math.hypot(s.x - t.x, s.y - t.y) < want * 0.5) {
      s.x = t.x; s.y = t.y; if (poseBlocked(world, d, t.x, t.y, st.heading, t.x, t.y, s.heading)) s.heading = st.heading;
      health = Math.max(0, health - Math.abs(s.speed) * (d.mass / 1000) * T.impactDamagePerSpeedTon);
      s.speed = -s.speed * T.bounce; s.drift = 0;
    } else s.speed *= 0.9; // scraping along a wall
  }
  if (Math.abs(s.speed) < 1e-3 && mag === 0) s.speed = 0;
  if (Math.abs(s.steer) < 1e-3 && mag === 0) s.steer = 0;
  if (Math.abs(s.drift) < 1e-3) s.drift = 0;
  world.set(v, Vehicle, { speed: s.speed, heading: s.heading, drift: s.drift, steer: s.steer, fuel, health });
  world.set(v, Transform, { x: s.x, y: s.y, facing: s.heading });
}

/** Pin joint: the trailer's front hitch sits on the tow's rear hitch; heading follows the drawbar. */
function stepTrailer(world: World, tr: Entity, d: VehicleDef, tow: Entity): void {
  const td = vehicleDefOf(world, tow); if (!td) return;
  const tt = world.get(tow, Transform)!; const th = world.getField(tow, Vehicle, "heading")!;
  const pin = hitchPoint(td, "rear", tt.x, tt.y, th); const front = hitchOf(d, "front"); if (!pin || !front) return;
  const t = world.get(tr, Transform)!; const prevH = world.getField(tr, Vehicle, "heading")!;
  let h = Math.atan2(pin.y - t.y, pin.x - t.x);
  const rel = wrap(h - th); if (Math.abs(rel) > VEHICLE_TUNING.maxArticulation) h = wrap(th + Math.sign(rel) * VEHICLE_TUNING.maxArticulation);
  const x = pin.x - Math.cos(h) * front.offset, y = pin.y - Math.sin(h) * front.offset;
  if (x === t.x && y === t.y && h === prevH) return;
  const moved = Math.hypot(x - t.x, y - t.y);
  world.set(tr, Vehicle, { heading: h, speed: world.getField(tow, Vehicle, "speed")! >= 0 ? moved : -moved });
  world.set(tr, Transform, { x, y, facing: h });
}

/** gameplay.vehicles: drive powered vehicles, then trailers in chain order, then seat riders. Deterministic on every peer. */
export function vehicleSystem(world: World, dt: number): void {
  if (world.tick % 20 === 0 && world.isRegistered(VehicleLock)) keyIssueSystem(world); // ADR-109 legacy migration + owed keys
  const vs = [...world.query([Vehicle, Transform])]; if (vs.length === 0) return;
  const inputs = world.getResource(DriveInputs); const riders = new Map<number, Entity>();
  for (const r of world.query([Driver, NetId])) riders.set(world.getField(r, NetId, "id")!, r);
  const byNet = new Map<number, Entity>(); for (const v of vs) { const id = netIdOf(world, v); if (id) byNet.set(id, v); }
  const sorted = [...vs].sort((a, b) => netIdOf(world, a) - netIdOf(world, b) || a - b);
  const trailers: Entity[] = [];
  for (const v of sorted) {
    const d = vehicleDefOf(world, v); if (!d) continue;
    const parent = world.getField(v, Hitch, "parentNetId") ?? 0;
    if (parent && byNet.has(parent)) { trailers.push(v); continue; }
    if (d.class !== "trailer") stepPowered(world, v, d, dt, inputs, riders);
    else if (world.getField(v, Vehicle, "speed")) world.setField(v, Vehicle, "speed", 0);
  }
  // chain order: a trailer goes after its parent (depth-first from roots; cycles are refused at hitch time)
  const done = new Set<Entity>(); const depth = (e: Entity, n = 0): number => { const p = byNet.get(world.getField(e, Hitch, "parentNetId") ?? 0); return p !== undefined && n < 8 && trailers.includes(p) ? depth(p, n + 1) + 1 : 0; };
  for (const tr of [...trailers].sort((a, b) => depth(a) - depth(b) || netIdOf(world, a) - netIdOf(world, b))) {
    if (done.has(tr)) continue; done.add(tr); stepTrailer(world, tr, vehicleDefOf(world, tr)!, byNet.get(world.getField(tr, Hitch, "parentNetId")!)!);
  }
  // riders follow
  for (const [, r] of riders) {
    const v = byNet.get(world.getField(r, Driver, "vehicleNetId")!); if (v === undefined) continue;
    const vt = world.get(v, Transform)!; const rt = world.get(r, Transform);
    if (rt && (rt.x !== vt.x || rt.y !== vt.y || rt.facing !== vt.facing)) world.set(r, Transform, { x: vt.x, y: vt.y, facing: vt.facing });
    if (world.has(r, AnimState) && !world.has(r, Dead) && world.getField(r, AnimState, "anim") !== Anim.Sit) world.set(r, AnimState, { anim: Anim.Sit, startTick: world.tick });
  }
}

// ---- commands (ADR-092: humans and bots both go through validate + handle) --------------------------
/** seat 255 = first free seat. */
export const VehicleEnterCmd = defineCommand("gameplay.vehicleEnter", { target: "u32", seat: "u8" });
export const VehicleExitCmd = defineCommand("gameplay.vehicleExit", {});
/** target = trailer, tow = vehicle whose rear hitch receives it. */
export const VehicleHitchCmd = defineCommand("gameplay.vehicleHitch", { target: "u32", tow: "u32" });
export const VehicleUnhitchCmd = defineCommand("gameplay.vehicleUnhitch", { target: "u32" });
/** Use interior station index (into def.interior.stations) of a parked vehicle. */
export const VehicleStationCmd = defineCommand("gameplay.vehicleStation", { target: "u32", station: "u8" });
export const VEHICLE_COMMANDS = [VehicleEnterCmd, VehicleExitCmd, VehicleHitchCmd, VehicleUnhitchCmd, VehicleStationCmd] as const;
/** Vehicle toggles (ADR-101), registered after VEHICLE_CRAFT_COMMANDS (append-only). on: 0 off, 1 on, 2 toggle. Driver only. */
export const VehicleEngineCmd = defineCommand("gameplay.vehicleEngine", { target: "u32", on: "u8" });
export const VehicleHeadlightsCmd = defineCommand("gameplay.vehicleHeadlights", { target: "u32", on: "u8" });
export const VEHICLE_STATE_COMMANDS = [VehicleEngineCmd, VehicleHeadlightsCmd] as const;
export const VEHICLE_ENTITY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  [VehicleEngineCmd.name]: ["target"], [VehicleHeadlightsCmd.name]: ["target"],
  [VehicleEnterCmd.name]: ["target"], [VehicleHitchCmd.name]: ["target", "tow"], [VehicleUnhitchCmd.name]: ["target"], [VehicleStationCmd.name]: ["target"],
};

const dist = (world: World, a: Entity, b: Entity): number => { const p = world.get(a, Transform), q = world.get(b, Transform); return p && q ? Math.hypot(p.x - q.x, p.y - q.y) : Infinity; };
const reachOf = (d: VehicleDef): number => d.footprint.length / 2 + VEHICLE_TUNING.enterReach;

export function validateEnter(world: World, actor: Entity, v: Entity, seat: number): string | undefined {
  if (world.has(actor, Dead)) return "dead";
  if (world.has(actor, Driver) || (world.isRegistered(Riding) && world.has(actor, Riding))) return "already_riding"; // ADR-319: not while on a mount
  if (!world.isAlive(v) || !world.has(v, Vehicle)) return "not_vehicle";
  const d = vehicleDefOf(world, v); if (!d || d.seats === 0) return "no_seats";
  if (!netIdOf(world, v) || !netIdOf(world, actor)) return "no_net_id";
  if ((world.getField(v, Vehicle, "health") ?? 0) <= 0) return "wrecked";
  if (dist(world, actor, v) > reachOf(d)) return "too_far";
  if (Math.abs(world.getField(v, Vehicle, "speed") ?? 0) > 1) return "moving";
  const occ = seatsOf(world, v)!;
  const key = hasKeyFor(world, actor, v); // ADR-109: the driver seat needs the matching key; passengers don't
  if (seat === 255) { for (let i = key ? 0 : 1; i < d.seats; i++) if (!occ[i]) return undefined; return key || d.seats > 1 ? "full" : "no_key"; }
  if (seat >= d.seats) return "bad_seat";
  if (seat === 0 && !key) return "no_key";
  return occ[seat] ? "seat_taken" : undefined;
}
export function enterVehicle(world: World, actor: Entity, v: Entity, seat = 255): string | undefined {
  const r = validateEnter(world, actor, v, seat); if (r) return r;
  const d = vehicleDefOf(world, v)!; const occ = seatsOf(world, v)!;
  if (seat === 255) for (seat = hasKeyFor(world, actor, v) ? 0 : 1; seat < d.seats && occ[seat]; seat++);
  writeSeat(world, v, seat, netIdOf(world, actor));
  world.add(actor, Driver, { vehicleNetId: netIdOf(world, v), seat });
  return undefined;
}
export function exitVehicle(world: World, actor: Entity): string | undefined {
  if (!world.has(actor, Driver)) return "not_riding";
  const v = ridingVehicle(world, actor); const seat = world.getField(actor, Driver, "seat")!;
  world.remove(actor, Driver); world.getResource(DriveInputs)?.delete(actor);
  if (world.getField(actor, AnimState, "anim") === Anim.Sit) world.set(actor, AnimState, { anim: Anim.Idle, startTick: world.tick });
  if (v === undefined) return undefined;
  if (seatsOf(world, v)?.[seat] === netIdOf(world, actor)) writeSeat(world, v, seat, 0);
  const d = vehicleDefOf(world, v)!; const t = world.get(v, Transform)!; const h = world.getField(v, Vehicle, "heading")!;
  const side = d.footprint.width / 2 + 0.6; // step out on the left side
  world.set(actor, Transform, { x: t.x - Math.sin(h) * side, y: t.y + Math.cos(h) * side });
  return undefined;
}

export function validateHitch(world: World, actor: Entity, trailer: Entity, tow: Entity): string | undefined {
  if (world.has(actor, Dead)) return "dead";
  if (trailer === tow || !world.has(trailer, Vehicle) || !world.has(tow, Vehicle)) return "not_vehicle";
  const td = vehicleDefOf(world, trailer), wd = vehicleDefOf(world, tow); if (!td || !wd) return "not_vehicle";
  const front = hitchOf(td, "front"), rear = hitchOf(wd, "rear");
  if (!front || !rear) return "no_hitch";
  if (!front.accepts.includes(wd.class) || !rear.accepts.includes(td.class)) return "incompatible";
  if (!netIdOf(world, trailer) || !netIdOf(world, tow)) return "no_net_id";
  if (world.getField(trailer, Hitch, "parentNetId")) return "already_hitched";
  if (world.getField(tow, Hitch, "towNetId")) return "tow_busy";
  // no cycles: tow must not be (transitively) towed by trailer
  for (let p = tow, n = 0; n < 16; n++) { const pid = world.getField(p, Hitch, "parentNetId") ?? 0; if (!pid) break; if (pid === netIdOf(world, trailer)) return "cycle"; const q = vehicleByNetId(world, pid); if (q === undefined) break; p = q; }
  if (!isParked(world, trailer) || !isParked(world, tow)) return "moving";
  const tt = world.get(trailer, Transform)!, wt = world.get(tow, Transform)!;
  const a = hitchPoint(td, "front", tt.x, tt.y, world.getField(trailer, Vehicle, "heading")!)!, b = hitchPoint(wd, "rear", wt.x, wt.y, world.getField(tow, Vehicle, "heading")!)!;
  if (Math.hypot(a.x - b.x, a.y - b.y) > VEHICLE_TUNING.hitchRange) return "too_far";
  if (Math.min(dist(world, actor, trailer), dist(world, actor, tow)) > reachOf(td) + 2) return "actor_too_far";
  return undefined;
}
export function hitchVehicles(world: World, actor: Entity, trailer: Entity, tow: Entity): string | undefined {
  const r = validateHitch(world, actor, trailer, tow); if (r) return r;
  world.setField(trailer, Hitch, "parentNetId", netIdOf(world, tow)); world.setField(tow, Hitch, "towNetId", netIdOf(world, trailer));
  return undefined;
}
export function validateUnhitch(world: World, actor: Entity, trailer: Entity): string | undefined {
  if (world.has(actor, Dead)) return "dead";
  if (!world.isAlive(trailer) || !world.has(trailer, Hitch)) return "not_vehicle";
  const pid = world.getField(trailer, Hitch, "parentNetId") ?? 0; if (!pid) return "not_hitched";
  const tow = vehicleByNetId(world, pid);
  if (tow !== undefined && !isParked(world, tow)) return "moving";
  const d = vehicleDefOf(world, trailer); if (d && dist(world, actor, trailer) > reachOf(d) + 2 && (tow === undefined || dist(world, actor, tow) > reachOf(d) + 2)) return "actor_too_far";
  return undefined;
}
export function unhitchVehicle(world: World, actor: Entity, trailer: Entity): string | undefined {
  const r = validateUnhitch(world, actor, trailer); if (r) return r;
  const pid = world.getField(trailer, Hitch, "parentNetId")!; const tow = vehicleByNetId(world, pid);
  world.setField(trailer, Hitch, "parentNetId", 0); world.setField(trailer, Vehicle, "speed", 0);
  if (tow !== undefined && world.getField(tow, Hitch, "towNetId") === netIdOf(world, trailer)) world.setField(tow, Hitch, "towNetId", 0);
  return undefined;
}

// ---- engine / headlights (ADR-101) -------------------------------------------------------------------
export const vehicleFlags = (world: World, v: Entity): number => world.getField(v, VehicleState, "flags") ?? 0;
export const isEngineOn = (world: World, v: Entity): boolean => (vehicleFlags(world, v) & VEHICLE_ENGINE_ON) !== 0;
export const headlightsOn = (world: World, v: Entity): boolean => (vehicleFlags(world, v) & VEHICLE_HEADLIGHTS) !== 0;
/** Driver (seat 0) of a powered vehicle; the engine bit needs a motor (bicycles have lights but no engine). */
export function validateVehicleToggle(world: World, actor: Entity, v: Entity, bit: number, on: number): string | undefined {
  if (world.has(actor, Dead)) return "dead";
  if (!world.isAlive(v) || !world.has(v, Vehicle)) return "not_vehicle";
  if (on > 2) return "bad_value";
  const d = vehicleDefOf(world, v); if (!d) return "not_vehicle";
  if (d.class === "trailer") return "no_controls";
  if (bit === VEHICLE_ENGINE_ON && !d.fuel) return "no_engine";
  if (!netIdOf(world, actor) || world.getField(actor, Driver, "vehicleNetId") !== netIdOf(world, v) || world.getField(actor, Driver, "seat") !== 0) return "not_driver";
  if (bit === VEHICLE_ENGINE_ON && on !== 0 && (world.getField(v, Vehicle, "health") ?? 0) <= 0) return "wrecked";
  if (bit === VEHICLE_ENGINE_ON && on !== 0 && !hasKeyFor(world, actor, v)) return "no_key";
  return undefined;
}
export function setVehicleToggle(world: World, actor: Entity, v: Entity, bit: number, on: number): string | undefined {
  const r = validateVehicleToggle(world, actor, v, bit, on); if (r) return r;
  if (!world.has(v, VehicleState)) world.add(v, VehicleState); // vehicles from pre-ADR-101 saves
  const f = vehicleFlags(world, v); const want = on === 2 ? !(f & bit) : on === 1;
  const nf = want ? f | bit : f & ~bit; if (nf !== f) world.setField(v, VehicleState, "flags", nf);
  return undefined;
}

/** Client helper (render cutaway): NetId of the vehicle `playerEid` rides, or null. */
export function localPlayerVehicle(world: World, playerEid: Entity): number | null {
  if (!world.isAlive(playerEid) || !world.has(playerEid, Driver)) return null;
  return world.getField(playerEid, Driver, "vehicleNetId") || null;
}

// ---- interior stations (camper hook API) ------------------------------------------------------------
export interface VehicleStation { index: number; key: string; kind: number }
/** Survival wires station behaviour here: onUse runs after validation (parked, in reach / seated). */
export interface VehicleStationHook { readonly name: string; onUse(world: World, player: Entity, vehicle: Entity, station: VehicleStation): void }
export const VehicleStationHooksRes = defineResource<VehicleStationHook[]>("gameplay.VehicleStationHooks");
export function addVehicleStationHook(world: World, hook: VehicleStationHook): void {
  let hs = world.getResource(VehicleStationHooksRes); if (!hs) world.setResource(VehicleStationHooksRes, (hs = []));
  if (hs.some((h) => h.name === hook.name)) throw new Error(`duplicate vehicle station hook ${hook.name}`); hs.push(hook);
}
/** Interior stations of a vehicle (empty for non-campers). */
export const vehicleStations = (world: World, v: Entity): VehicleStation[] => (vehicleDefOf(world, v)?.interior.stations ?? []).map((key, index) => ({ index, key, kind: STATIONS[key]! }));
/** Stations `player` can use right now: vehicle parked and player seated in it or within stationReach of it. */
export function usableVehicleStations(world: World, player: Entity, v: Entity): VehicleStation[] {
  if (!world.has(v, Vehicle) || world.has(player, Dead) || !isParked(world, v)) return [];
  const inside = world.getField(player, Driver, "vehicleNetId") === netIdOf(world, v) && netIdOf(world, v) !== 0;
  const d = vehicleDefOf(world, v)!;
  if (!inside && dist(world, player, v) > d.footprint.length / 2 + VEHICLE_TUNING.stationReach) return [];
  return vehicleStations(world, v);
}
export function useVehicleStation(world: World, player: Entity, v: Entity, index: number): string | undefined {
  if (!world.has(v, Vehicle)) return "not_vehicle";
  if (!isParked(world, v)) return vehicleStations(world, v).length ? "moving" : "no_station";
  const st = usableVehicleStations(world, player, v).find((s) => s.index === index); if (!st) return "no_station";
  for (const h of world.getResource(VehicleStationHooksRes) ?? []) h.onUse(world, player, v, st);
  return undefined;
}
/** CraftingStation-style lookup for Survival: station kinds usable by `player` from any nearby parked vehicle. */
export function nearbyVehicleStationKinds(world: World, player: Entity): Set<number> {
  const out = new Set<number>();
  for (const v of world.query([Vehicle, Transform])) for (const s of usableVehicleStations(world, player, v)) out.add(s.kind);
  return out;
}

/** What Interact does for a vehicle target: exit when riding, else enter (seat 255) - caller makes the command. */
export function vehicleInteractCommand(world: World, player: Entity, target: Entity | undefined): { def: typeof VehicleEnterCmd | typeof VehicleExitCmd; values: Record<string, number> } | undefined {
  if (world.has(player, Driver)) return { def: VehicleExitCmd, values: {} };
  if (target !== undefined && world.has(target, VehicleSeats)) return { def: VehicleEnterCmd, values: { target, seat: 255 } };
  return undefined;
}

/** Server: register vehicle command handlers (validate -> rejection reason, same path as bots, ADR-092). */
export function installVehicleCommands(world: World, handlers: CommandHandlers): void {
  const run = (fn: () => string | undefined): void => { const r = fn(); if (r) throw new Error(r); };
  handlers.on(VehicleEnterCmd, { validate: (v, c) => validateEnter(world, c.actor, v.target as Entity, v.seat), handle: (v, c) => run(() => enterVehicle(world, c.actor, v.target as Entity, v.seat)) });
  handlers.on(VehicleExitCmd, { validate: (_v, c) => (world.has(c.actor, Driver) ? undefined : "not_riding"), handle: (_v, c) => run(() => exitVehicle(world, c.actor)) });
  handlers.on(VehicleHitchCmd, { validate: (v, c) => validateHitch(world, c.actor, v.target as Entity, v.tow as Entity), handle: (v, c) => run(() => hitchVehicles(world, c.actor, v.target as Entity, v.tow as Entity)) });
  handlers.on(VehicleUnhitchCmd, { validate: (v, c) => validateUnhitch(world, c.actor, v.target as Entity), handle: (v, c) => run(() => unhitchVehicle(world, c.actor, v.target as Entity)) });
  for (const [def, bit] of [[VehicleEngineCmd, VEHICLE_ENGINE_ON], [VehicleHeadlightsCmd, VEHICLE_HEADLIGHTS]] as const)
    handlers.on(def, { validate: (v, c) => validateVehicleToggle(world, c.actor, v.target as Entity, bit, v.on), handle: (v, c) => run(() => setVehicleToggle(world, c.actor, v.target as Entity, bit, v.on)) });
  handlers.on(VehicleStationCmd, { validate: (v, c) => (usableVehicleStations(world, c.actor, v.target as Entity).some((s) => s.index === v.station) ? undefined : "no_station"), handle: (v, c) => run(() => useVehicleStation(world, c.actor, v.target as Entity, v.station)) });
}
