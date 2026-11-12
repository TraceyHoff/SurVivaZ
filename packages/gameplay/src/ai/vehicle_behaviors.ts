/**
 * Bot driving (DESIGN.md §31): SP AI humans use vehicles through the same validated commands as players, emitted as
 * AgentOutput action strings (venter / vexit / vhitch / vrefuel / vrepair / vdeploy -> AgentOutput.commands via
 * agent_output.ts). Driving = moveX/moveY while seated. Reads only the bot's replica (fillVehicleSensors). Trait
 * gates (data/vehicle_crafting.json bots): timid bots (bravery < minBraveryToDrive) never drive; only industrious
 * bots (>= minIndustriousnessToHitch) hitch trailers. Deterministic: no rng, no clock.
 *
 * ADR-359: `hitch_drawn` / `unhitch_drawn` do the same for animal-drawn vehicles: a bot with a harnessed mount hitches
 * a parked wagon / cart / carriage / chariot when its pack is full (hauling to do) and detaches it when the haul is
 * done (arrived at its goal, or pack space recovered). The hook-up itself is the same `vhitch` / `vunhitch` action
 * strings — the server's validateHitch enforces the harness ("no_harness") — but the bot first rides its mount into
 * position, because the pin joint needs the mount's rear pin on the vehicle's front hitch.
 *
 * ADR-371: `ride_passenger` rides along in a drawn vehicle someone else drives — board a free passenger seat
 * (seat 254) when far from its goal, sit tight while the wagon rolls, and get out at its destination (or when
 * the driver leaves, the wagon is wrecked, or the ride has carried it 10 tiles further from its goal than where
 * it boarded). A passenger's input moves nothing, so while riding it claims the tick and does nothing.
 */
import { Transform, type Entity, type World } from "@engine/core";
import type { AgentWorldView, GameBehavior } from "../agents.js";
import { Driver, Hitch, Vehicle, VehicleSeats } from "../components.js";
import { readSlots } from "../inventory.js";
import { DRAWN_HITCH_GAP, hitchPoint, isDrawnClass, isParked, mountRearPin, PASSENGER_SEAT, ridingVehicle, vehicleDefOf, VEHICLE_TUNING, type VehicleClass } from "../vehicles.js";
import { mountSpecies } from "../mount_defs.js";
import { fuelFits, kitVehicle, vehicleMaxHealth, VEHICLE_CRAFT } from "../vehicle_craft.js";
import { gameplayDefs } from "../config.js";
import { agentWorld, goTo } from "./base_behaviors.js";

export interface SeenVehicle { id: number; x: number; y: number; cls: VehicleClass; fuel: number; hp: number; parked: boolean; hitched: boolean; canTow: boolean; fuelSlot?: number; repairSlot?: number; /** ADR-371: seat 0 occupied — someone is driving, so a passenger may board. */ driverSeated: boolean; /** ADR-371: free seats 1..n-1. */ freePassengerSeats: number }
export interface VehicleSensors {
  vehicles?: SeenVehicle[];
  /** Vehicle the bot sits in (driver seat or not). */
  riding?: SeenVehicle & { driver: boolean };
  /** Inventory slot holding a vehicle kit. */
  kitSlot?: number;
  /** Where the bot wants to go (host may set; default clan goal, else home). */
  driveGoal?: { x: number; y: number };
}

function seen(world: World, v: Entity, slots: ReturnType<typeof readSlots> | undefined): SeenVehicle | undefined {
  const d = vehicleDefOf(world, v); const t = world.get(v, Transform); const s = world.get(v, Vehicle); if (!d || !t || !s) return undefined;
  const occ = world.has(v, VehicleSeats) ? (world.get(v, VehicleSeats)!.occupant as ArrayLike<number>) : undefined;
  let freePassengerSeats = 0; for (let i = 1; i < d.seats; i++) if (!occ?.[i]) freePassengerSeats++;
  const out: SeenVehicle = { id: v, x: t.x, y: t.y, cls: d.class, fuel: d.fuel ? s.fuel / d.fuel.capacity : 1, hp: d.health ? s.health / d.health : 0, parked: isParked(world, v),
    hitched: (world.getField(v, Hitch, "parentNetId") ?? 0) !== 0, canTow: d.hitches.some((h) => h.at === "rear") && (world.getField(v, Hitch, "towNetId") ?? 0) === 0,
    driverSeated: (occ?.[0] ?? 0) !== 0, freePassengerSeats };
  if (slots) {
    const defs = gameplayDefs(world);
    for (let i = 0; i < slots.slotCount; i++) {
      const it = slots.item(i); if (!it || !slots.count(i)) continue;
      if (out.fuelSlot === undefined && d.fuel && fuelFits(world, v, it)) out.fuelSlot = i;
      const r = VEHICLE_CRAFT.repair.items[defs.items.get(it)?.key ?? ""];
      if (out.repairSlot === undefined && r && r.field > 0 && (!r.classes.length || r.classes.includes(d.class))) out.repairSlot = i;
    }
  }
  if (out.hp > vehicleMaxHealth(world, v) / (d.health || 1)) out.hp = vehicleMaxHealth(world, v) / (d.health || 1);
  return out;
}

/** Fills vehicle sensors from the replica (no writes). */
export function fillVehicleSensors(world: World, self: Entity, view: AgentWorldView): void {
  const t = world.get(self, Transform); if (!t) return;
  let slots: ReturnType<typeof readSlots> | undefined; try { slots = readSlots(world, self); } catch { slots = undefined; }
  const list: SeenVehicle[] = []; const R = VEHICLE_CRAFT.bots.seekRadius;
  for (const v of world.query([Vehicle, Transform])) { const p = world.get(v, Transform)!; if (Math.hypot(p.x - t.x, p.y - t.y) > R) continue; const s = seen(world, v, slots); if (s) list.push(s); }
  list.sort((a, b) => Math.hypot(a.x - t.x, a.y - t.y) - Math.hypot(b.x - t.x, b.y - t.y) || a.id - b.id);
  if (list.length) view.vehicles = list;
  const r = ridingVehicle(world, self);
  if (r !== undefined) { const s = seen(world, r, slots); if (s) view.riding = { ...s, driver: world.getField(self, Driver, "seat") === 0 }; }
  if (slots) for (let i = 0; i < slots.slotCount; i++) if (slots.count(i) && kitVehicle(world, slots.item(i))) { view.kitSlot = i; break; }
  if (!view.driveGoal) view.driveGoal = view.clan?.goal ? { x: view.clan.goalX, y: view.clan.goalY } : view.home;
}

const toward = (o: { moveX: number; moveY: number; aimX: number; aimY: number }, fx: number, fy: number, tx: number, ty: number, s = 1): number => {
  const dx = tx - fx, dy = ty - fy, d = Math.hypot(dx, dy) || 1; o.moveX = (dx / d) * s; o.moveY = (dy / d) * s; o.aimX = dx / d; o.aimY = dy / d; return d;
};
const B = (): typeof VEHICLE_CRAFT.bots => VEHICLE_CRAFT.bots;
const goalDist = (w: AgentWorldView, x: number, y: number): number => (w.driveGoal ? Math.hypot(w.driveGoal.x - x, w.driveGoal.y - y) : 0);
/** Best vehicle to drive: motor with fuel or a bicycle, not wrecked, not a trailer, parked. ADR-360: drawn vehicles
 * are not motor vehicles — the `drive_drawn` behaviour below drives those (seat 0 of a wagon the bot's mount tows). */
export function pickRide(w: AgentWorldView): SeenVehicle | undefined {
  return w.vehicles?.find((v) => v.cls !== "trailer" && !isDrawnClass(v.cls) && v.parked && v.hp > 0 && (v.cls === "bicycle" || v.fuel > 0.02));
}
const willDrive = (traits: { bravery: number }): boolean => traits.bravery >= B().minBraveryToDrive;
const cooled = (tick: number, at: number, ticks: number): boolean => tick - at >= ticks;

/** drive, vehicle_service (refuel/repair), hitch, deploy_vehicle. Order is load-bearing: vehicle_craft.test.ts
 * destructures [drive, vehicle_service] by position, so drive_drawn sits after vehicle_service, not after drive. */
export function vehicleBehaviors(): GameBehavior[] {
  return [
    { name: "drive", inertia: 0.4, traits: { bravery: 0.4, industriousness: 0.3 }, considerations: [
        { name: "willing", curve: { type: "step", at: 0.5 }, input: (c) => (willDrive(c.traits) ? 1 : 0) },
        { name: "far", curve: { type: "step", at: 0.5 }, input: (c) => (goalDist(c.world, c.self.x, c.self.y) > (c.world.riding ? B().arriveDistance : B().driveMinDistance) ? 1 : 0) },
        { name: "ride", curve: { type: "step", at: 0.5 }, input: (c) => (((c.world.riding && !isDrawnClass(c.world.riding.cls)) || pickRide(c.world)) ? 1 : 0) }],
      run: (c, o) => {
        const w = c.world; const g = w.driveGoal; if (!g) return false; const r = w.riding;
        if (r) {
          if (isDrawnClass(r.cls)) return false; // ADR-360: a drawn vehicle is drive_drawn's, not drive's
          if (!r.driver) { o.actions.push("vexit"); return false; }
          const d = goalDist(w, r.x, r.y);
          if (d <= B().arriveDistance || r.hp <= 0 || (r.cls !== "bicycle" && r.fuel <= 0)) { o.moveX = 0; o.moveY = 0; if (r.parked) { o.actions.push("vexit"); return false; } return; }
          toward(o, r.x, r.y, g.x, g.y, 1); o.sprint = r.cls === "bicycle" ? c.self.stamina > 0.5 : false; return;
        }
        const v = pickRide(w); if (!v) return false;
        if (toward(o, c.self.x, c.self.y, v.x, v.y, 0.9) < 2.5 && cooled(c.self.tick, c.bb.num("enteredAt", -1e9), 20)) { o.moveX = 0; o.moveY = 0; o.actions.push(`venter:${v.id}`); c.bb.set("enteredAt", c.self.tick); }
      } },
    { name: "vehicle_service", traits: { industriousness: 0.5 }, considerations: [
        { name: "need", curve: { type: "step", at: 0.5 }, input: (c) => (serviceTarget(c.world) && cooled(c.self.tick, c.bb.num("servicedAt", -1e9), 40) ? 1 : 0) }],
      run: (c, o) => {
        const w = c.world; if (w.riding) { if (w.riding.parked) o.actions.push("vexit"); return; }
        const t = serviceTarget(w); if (!t) return false;
        if (toward(o, c.self.x, c.self.y, t.v.x, t.v.y, 0.8) > 2.5) return;
        o.moveX = 0; o.moveY = 0; o.actions.push(t.kind === "fuel" ? `vrefuel:${t.v.id}:${t.slot}:${VEHICLE_CRAFT.refuel.maxPerCommand}` : `vrepair:${t.v.id}:${t.slot}`);
        c.bb.set("servicedAt", c.self.tick); return false;
      } },
    { name: "drive_drawn", inertia: 0.4, traits: { bravery: 0.4, industriousness: 0.3 }, considerations: [
        { name: "willing", curve: { type: "step", at: 0.5 }, input: (c) => (willDrive(c.traits) ? 1 : 0) },
        { name: "far", curve: { type: "step", at: 0.5 }, input: (c) => (goalDist(c.world, c.self.x, c.self.y) > (drawnRiding(c.world) ? B().arriveDistance : B().driveMinDistance) ? 1 : 0) },
        { name: "ride", curve: { type: "step", at: 0.5 }, input: (c) => (drawnRide(c.world) ? 1 : 0) }],
      run: (c, o) => driveDrawnRun(c, o) },
    { name: "hitch", traits: { industriousness: 0.6 }, considerations: [
        { name: "industrious", curve: { type: "step", at: 0.5 }, input: (c) => (c.traits.industriousness >= B().minIndustriousnessToHitch ? 1 : 0) },
        { name: "wantCargo", curve: { type: "step", at: 0.5 }, input: (c) => ((c.world.invSpaceFree ?? 1) < B().hitchWhenInvFreeBelow && hitchPair(c.world) && cooled(c.self.tick, c.bb.num("hitchedAt", -1e9), 200) ? 1 : 0) }],
      run: (c, o) => {
        const p = hitchPair(c.world); if (!p) return false; if (c.world.riding) { if (c.world.riding.parked) o.actions.push("vexit"); return; }
        if (toward(o, c.self.x, c.self.y, p.trailer.x, p.trailer.y, 0.8) > 2.5) return;
        o.moveX = 0; o.moveY = 0; o.actions.push(`vhitch:${p.trailer.id}:${p.tow.id}`); c.bb.set("hitchedAt", c.self.tick); return false;
      } },
    { name: "hitch_drawn", traits: { industriousness: 0.6 }, considerations: [
        { name: "industrious", curve: { type: "step", at: 0.5 }, input: (c) => (c.traits.industriousness >= B().minIndustriousnessToHitch ? 1 : 0) },
        { name: "wantCargo", curve: { type: "step", at: 0.5 }, input: (c) => ((c.world.invSpaceFree ?? 1) < B().hitchWhenInvFreeBelow && !c.world.riding && drawnPair(c.world) && cooled(c.self.tick, c.bb.num("hitchDrawnAt", -1e9), 200) ? 1 : 0) }],
      run: (c, o) => hitchDrawnRun(c, o) },
    { name: "unhitch_drawn", traits: { industriousness: 0.6 }, considerations: [
        { name: "done", curve: { type: "step", at: 0.5 }, input: (c) => (drawnTowDone(c.world, c.self.x, c.self.y) && cooled(c.self.tick, c.bb.num("unhitchedDrawnAt", -1e9), 200) ? 1 : 0) }],
      run: (c, o) => unhitchDrawnRun(c, o) },
    { name: "deploy_vehicle", traits: { industriousness: 0.4 }, considerations: [
        { name: "hasKit", curve: { type: "step", at: 0.5 }, input: (c) => (c.world.kitSlot !== undefined && !c.world.riding && cooled(c.self.tick, c.bb.num("deployedAt", -1e9), 100) ? 1 : 0) }],
      run: (c, o) => {
        const s = c.world.kitSlot; if (s === undefined) return false; o.moveX = 0; o.moveY = 0;
        o.actions.push(`vdeploy:${s}:${Math.round(c.self.x) + 2}:${Math.round(c.self.y)}:0`); c.bb.set("deployedAt", c.self.tick); return false;
      } },
    { name: "ride_passenger", inertia: 0.4, traits: { bravery: 0.4, industriousness: 0.3 }, considerations: [
        { name: "far", curve: { type: "step", at: 0.5 }, input: (c) => (passengerRiding(c.world) || goalDist(c.world, c.self.x, c.self.y) > B().driveMinDistance ? 1 : 0) },
        { name: "ride", curve: { type: "step", at: 0.5 }, input: (c) => (passengerRiding(c.world) || pickPassengerRide(c.world) ? 1 : 0) }],
      run: (c, o) => ridePassengerRun(c, o) },
  ];
}
/** ADR-371: a drawn vehicle the bot can ride in as a passenger — parked, driver seated, a free passenger seat.
 * Chariot shares the path (same seats/hitch/drive code as wagon/cart/carriage), so it is included. */
export function pickPassengerRide(w: AgentWorldView): SeenVehicle | undefined {
  return w.vehicles?.find((v) => isDrawnClass(v.cls) && v.parked && v.hp > 0 && v.driverSeated && v.freePassengerSeats > 0);
}
/** True when the bot sits in a passenger seat of a drawn vehicle. */
const passengerRiding = (w: AgentWorldView): boolean => !!w.riding && isDrawnClass(w.riding.cls) && !w.riding.driver;
/**
 * Walk to a driven drawn vehicle, board a passenger seat (seat 254 — never the driver seat), and ride along.
 * While riding the bot claims the tick and does nothing: a passenger's input moves nothing. It gets out when
 * parked and (a) the vehicle is within arriveDistance of its goal, (b) the driver has left, (c) the wagon is
 * wrecked, or (d) the ride has carried it 10 tiles further from its goal than where it boarded (wrong way).
 * Boarding is re-validated by the server (seat 254 returns "full" if the seat filled meanwhile), so a failed
 * board just re-picks on the next pass. A bot on its own mount is got off it first by mountPolicy
 * (DISMOUNT_NOW), because enter refuses a rider who is already riding.
 */
function ridePassengerRun(c: Ctx, o: Parameters<GameBehavior["run"]>[1]): boolean | void {
  const w = c.world; const g = w.driveGoal; if (!g) return false; const r = w.riding;
  if (r) {
    if (!isDrawnClass(r.cls) || r.driver) return false; // a motor vehicle is drive's; the driver seat is drive_drawn's
    const d = goalDist(w, r.x, r.y);
    const from = c.bb.get<{ x: number; y: number }>("rideFrom");
    const wrongWay = from !== undefined && d > Math.hypot(g.x - from.x, g.y - from.y) + 10;
    if (r.parked && (d <= B().arriveDistance || !r.driverSeated || r.hp <= 0 || wrongWay)) {
      o.moveX = 0; o.moveY = 0; o.actions.push("vexit"); return false;
    }
    return; // stay seated — claim the tick so no foot behaviour fires while riding
  }
  const v = pickPassengerRide(w); if (!v) return false;
  if (toward(o, c.self.x, c.self.y, v.x, v.y, 0.9) < 2.5 && cooled(c.self.tick, c.bb.num("enteredPassengerAt", -1e9), 20)) {
    o.moveX = 0; o.moveY = 0; o.actions.push(`venter:${v.id}:${PASSENGER_SEAT}`); c.bb.set("enteredPassengerAt", c.self.tick);
    c.bb.set("rideFrom", { x: c.self.x, y: c.self.y });
  }
}

function serviceTarget(w: AgentWorldView): { v: SeenVehicle; kind: "fuel" | "repair"; slot: number } | undefined {
  for (const v of w.vehicles ?? []) {
    if (!v.parked || v.cls === "trailer" && v.repairSlot === undefined) continue;
    if (v.fuelSlot !== undefined && v.fuel < B().refuelBelow) return { v, kind: "fuel", slot: v.fuelSlot };
    if (v.repairSlot !== undefined && v.hp > 0 && v.hp < B().repairBelow) return { v, kind: "repair", slot: v.repairSlot };
  }
  return undefined;
}
function hitchPair(w: AgentWorldView): { trailer: SeenVehicle; tow: SeenVehicle } | undefined {
  const vs = w.vehicles ?? []; const trailer = vs.find((v) => v.cls === "trailer" && !v.hitched && v.parked); if (!trailer) return undefined;
  const tow = vs.find((v) => v.canTow && v.cls !== "trailer" && v.parked && Math.hypot(v.x - trailer.x, v.y - trailer.y) < 10);
  return tow ? { trailer, tow } : undefined;
}

// ---- ADR-359: drawn-vehicle hitch / detach -------------------------------------------------------------------
/** The bot's own harnessed mount + a parked unhitched drawn vehicle near it (nothing to tow yet). */
function drawnPair(w: AgentWorldView): { vehicle: SeenVehicle; mount: NonNullable<AgentWorldView["mount"]> } | undefined {
  const m = w.mount; if (!m || !m.harness || m.towing !== undefined || m.busy) return undefined;
  const v = w.vehicles?.find((x) => isDrawnClass(x.cls) && !x.hitched && x.parked && Math.hypot(x.x - m.x, x.y - m.y) < 10);
  return v ? { vehicle: v, mount: m } : undefined;
}
/** The haul is done: the bot's mount tows a drawn vehicle and the bot is at its goal, or its pack has room again. */
function drawnTowDone(w: AgentWorldView, x: number, y: number): boolean {
  const m = w.mount; if (!m || m.towing === undefined) return false;
  if ((w.invSpaceFree ?? 0) >= B().hitchWhenInvFreeBelow + 0.3) return true;
  const g = w.driveGoal; return !!g && Math.hypot(g.x - x, g.y - y) <= B().arriveDistance;
}
/** Pose of a drawn vehicle from the real world: its front hitch and heading. */
function drawnPose(world: World | undefined, v: SeenVehicle): { front: { x: number; y: number }; heading: number } | undefined {
  if (!world) return undefined;
  const e = v.id as Entity; const d = vehicleDefOf(world, e); const t = world.get(e, Transform); if (!d || !t) return undefined;
  const heading = world.getField(e, Vehicle, "heading") ?? 0;
  const front = hitchPoint(d, "front", t.x, t.y, heading); if (!front) return undefined;
  return { front, heading };
}
/** Where the mount must stand for its rear pin to sit on the vehicle's front hitch: just ahead of the vehicle,
 *  facing along its heading (half body length + the drawbar gap). Undefined without the real world. */
function stagingPoint(world: World | undefined, v: SeenVehicle, m: NonNullable<AgentWorldView["mount"]>): { x: number; y: number } | undefined {
  const pose = drawnPose(world, v); if (!pose) return undefined;
  const r = (mountSpecies(m.species)?.size.lengthM ?? 2) / 2 + DRAWN_HITCH_GAP;
  return { x: pose.front.x + Math.cos(pose.heading) * r, y: pose.front.y + Math.sin(pose.heading) * r };
}
/** True when the mount's rear pin already sits on the vehicle's front hitch (the server's hitchRange). */
function pinAligned(world: World | undefined, v: SeenVehicle, m: NonNullable<AgentWorldView["mount"]>): boolean {
  if (!world) return false;
  const e = v.id as Entity; const d = vehicleDefOf(world, e); const t = world.get(e, Transform); if (!d || !t) return false;
  const front = hitchPoint(d, "front", t.x, t.y, world.getField(e, Vehicle, "heading") ?? 0); if (!front) return false;
  const pin = mountRearPin(world, m.id as Entity); if (!pin) return false;
  return Math.hypot(pin.x - front.x, pin.y - front.y) <= VEHICLE_TUNING.hitchRange;
}
type Ctx = Parameters<GameBehavior["run"]>[0];
/** Ride the mount into position, get off, then hook up. A failed hook-up (pin drifted) re-positions on the next pass. */
function hitchDrawnRun(c: Ctx, o: Parameters<GameBehavior["run"]>[1]): boolean | void {
  const p = drawnPair(c.world); if (!p) return false;
  const { vehicle: v, mount: m } = p; const tick = c.self.tick; const w = agentWorld(c);
  if (m.riding) {
    // The pin is the joint, not the rider: get off as soon as the pin sits on the front hitch, whatever the approach.
    if (pinAligned(w, v, m)) { o.moveX = 0; o.moveY = 0; o.actions.push("mdismount"); c.bb.set("hitchDrawnLeg", "approach"); return; }
    const pose = drawnPose(w, v); const stage = stagingPoint(w, v, m);
    if (pose && stage) {
      // Ride in along the vehicle's heading: an approach point 3 tiles behind staging first, so the final leg
      // runs along the heading and the mount arrives facing it (the pin trails the facing, not the path). A
      // pass that overshoots staging, or stalls on the final leg, re-approaches instead of circling.
      if (c.bb.num("hitchDrawnLegV", -1) !== v.id) { c.bb.set("hitchDrawnLegV", v.id); c.bb.set("hitchDrawnLeg", "approach"); c.bb.set("hitchDrawnLegAt", tick); }
      const ax = stage.x - Math.cos(pose.heading) * 3, ay = stage.y - Math.sin(pose.heading) * 3;
      const along = (c.self.x - stage.x) * Math.cos(pose.heading) + (c.self.y - stage.y) * Math.sin(pose.heading);
      let leg = c.bb.get<string>("hitchDrawnLeg") ?? "approach";
      if (leg === "final" && (along > 2 || tick - c.bb.num("hitchDrawnLegAt", tick) > 150)) { leg = "approach"; c.bb.set("hitchDrawnLeg", "approach"); c.bb.set("hitchDrawnLegAt", tick); }
      if (leg === "approach") {
        if (Math.hypot(c.self.x - ax, c.self.y - ay) <= 1.0) { leg = "final"; c.bb.set("hitchDrawnLeg", "final"); c.bb.set("hitchDrawnLegAt", tick); }
        else { toward(o, c.self.x, c.self.y, ax, ay, 0.85); return; }
      }
      toward(o, c.self.x, c.self.y, stage.x, stage.y, 0.85); return;
    }
    o.moveX = 0; o.moveY = 0; o.actions.push("mdismount"); return; // no world to aim with: get off by the vehicle and try
  }
  const md = Math.hypot(c.self.x - m.x, c.self.y - m.y);
  // No world to measure the pin with (never in production): try the hook-up when close — the server validates.
  const aligned = w ? pinAligned(w, v, m) : Math.hypot(c.self.x - v.x, c.self.y - v.y) <= 2.5 && md <= 2.0;
  if (aligned) {
    if (Math.min(Math.hypot(c.self.x - v.x, c.self.y - v.y), md) > 2.5) { goTo(c, o, v.x, v.y, 0.8); return; }
    o.moveX = 0; o.moveY = 0; o.actions.push(`vhitch:${v.id}:${m.id}`); c.bb.set("hitchDrawnAt", tick); return false;
  }
  if (md > 2.0) { toward(o, c.self.x, c.self.y, m.x, m.y, 0.9); return; } // walk to the mount, then ride it into place
  o.moveX = 0; o.moveY = 0;
  if (tick - c.bb.num("mountActAt", -1e9) >= 20) { o.actions.push(`mride:${m.id}`); c.bb.set("mountActAt", tick); }
}
/** Get off the mount if riding, walk to the towed vehicle, detach it (it stays parked where it is). */
function unhitchDrawnRun(c: Ctx, o: Parameters<GameBehavior["run"]>[1]): boolean | void {
  const m = c.world.mount; if (!m || m.towing === undefined) return false;
  const v = c.world.vehicles?.find((x) => x.id === m.towing); if (!v) return false;
  if (m.riding) { o.moveX = 0; o.moveY = 0; o.actions.push("mdismount"); return; }
  if (toward(o, c.self.x, c.self.y, v.x, v.y, 0.8) > 2.5) return;
  o.moveX = 0; o.moveY = 0; o.actions.push(`vunhitch:${v.id}`); c.bb.set("unhitchedDrawnAt", c.self.tick); return false;
}

// ---- ADR-360: drive a drawn vehicle from its driver seat -----------------------------------------------
/** The bot's own mount towing a drawn vehicle (ADR-359 hitch_drawn leaves it there), or undefined. */
function drawnRide(w: AgentWorldView): { vehicle: SeenVehicle; mount: NonNullable<AgentWorldView["mount"]> } | undefined {
  const m = w.mount; if (!m || m.towing === undefined) return undefined;
  const v = w.vehicles?.find((x) => x.id === m.towing && isDrawnClass(x.cls));
  return v ? { vehicle: v, mount: m } : undefined;
}
/** True when the bot sits in the driver seat of a drawn vehicle. */
const drawnRiding = (w: AgentWorldView): boolean => !!w.riding && isDrawnClass(w.riding.cls) && w.riding.driver;
/** Enter the towed wagon's driver seat and haul it toward the drive goal (moveX/moveY steers the mount through
 * the ADR-360 input routing; Sprint gallops the open stretch and walks in close). At the goal, get out. */
function driveDrawnRun(c: Ctx, o: Parameters<GameBehavior["run"]>[1]): boolean | void {
  const w = c.world; const g = w.driveGoal; if (!g) return false; const r = w.riding;
  if (r) {
    if (!isDrawnClass(r.cls)) return false; // a motor vehicle is the drive behaviour's
    if (!r.driver) { o.actions.push("vexit"); return false; }
    const d = goalDist(w, r.x, r.y);
    if (d <= B().arriveDistance || r.hp <= 0) { o.moveX = 0; o.moveY = 0; if (r.parked) { o.actions.push("vexit"); return false; } return; }
    toward(o, r.x, r.y, g.x, g.y, 1); o.sprint = d > B().arriveDistance * 3; return;
  }
  const p = drawnRide(w); if (!p) return false;
  if (toward(o, c.self.x, c.self.y, p.vehicle.x, p.vehicle.y, 0.9) < 2.5 && cooled(c.self.tick, c.bb.num("enteredDrawnAt", -1e9), 20)) {
    o.moveX = 0; o.moveY = 0; o.actions.push(`venter:${p.vehicle.id}:0`); c.bb.set("enteredDrawnAt", c.self.tick);
  }
}
