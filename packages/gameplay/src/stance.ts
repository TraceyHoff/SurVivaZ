/**
 * ADR-244 stance mechanics: block / firearm aim (Secondary hold), crouch (toggle), carry a liftable object (LootBag
 * body bags), sleep in a bed. The server owns the Stance component (networked, "all"); applyStanceInput runs in the
 * server's per-input hook (hold bits + exactly-once edges), stanceSystem runs every tick on the authority (carried bag
 * follows its carrier, block stamina break, sleep heal, the all-asleep time skip). Movement / stamina / damage / noise
 * / zombie sight read the replicated Stance, so client prediction applies the same multipliers.
 */
import { Transform, setTimeOfDay, sunFractionOf, timeOfDay, wallHoursForSun, type Entity, type World } from "@engine/core";
import raw from "../data/stance.json";
import { Anim, AnimState, BuildPiece, Dead, Driver, Equipment, Health, LootBag, Stance, StanceMode, Survival } from "./components.js";
import { gameplayDefs, isAuthority } from "./config.js";
import { netIdEntity } from "./vehicle_net.js";
import { netIdOf } from "./vehicles.js";
import { gridRot, rotatedSize } from "./building/structure.js";
import { Placement } from "./defs.js";

export interface StanceTuning {
  blockMoveMul: number; blockMeleeReduction: number; blockArcDeg: number; blockStaminaDrainPerSec: number; blockStaminaPerHit: number;
  aimMoveMul: number; crouchMoveMul: number; crouchNoiseMul: number; crouchSightMul: number; carryMoveMul: number; carryReach: number; bedReach: number;
  sleepStaminaRegenMul: number; sleepHealPerSec: number; sleepWakeGraceTicks: number; timeSkipMul: number; timeSkipWakeHour: number; timeSkipFromHour: number;
  beds: Record<string, string[]>; underSpots: string[];
}
export const STANCE: StanceTuning = raw as StanceTuning;

/** The stance anim for a mode (undefined = no stance anim, plain idle/walk). */
export const STANCE_ANIM: Readonly<Record<number, Anim | undefined>> = {
  [StanceMode.Block]: Anim.Block, [StanceMode.Aim]: Anim.Aim, [StanceMode.Crouch]: Anim.Crouch, [StanceMode.Carry]: Anim.Carry, [StanceMode.Sleep]: Anim.Sleep,
};
export const stanceMode = (world: World, e: Entity): number => (world.isRegistered(Stance) ? world.getField(e, Stance, "mode") ?? 0 : 0);
/** Walk-speed multiplier for the current stance (1 = none). */
export function stanceMoveMul(world: World, e: Entity): number {
  switch (stanceMode(world, e)) {
    case StanceMode.Block: return STANCE.blockMoveMul;
    case StanceMode.Aim: return STANCE.aimMoveMul;
    case StanceMode.Crouch: return STANCE.crouchMoveMul;
    case StanceMode.Carry: return STANCE.carryMoveMul;
    case StanceMode.Sleep: return 0;
    default: return 1;
  }
}
/** Sprint is off while carrying / blocking / aiming / crouched / asleep. */
export const stanceAllowsSprint = (world: World, e: Entity): boolean => stanceMode(world, e) === StanceMode.None;
/** Carrying or asleep: no attacks, gathering or tool use (the primary button does nothing). */
export const stanceBlocksActions = (world: World, e: Entity): boolean => { const m = stanceMode(world, e); return m === StanceMode.Carry || m === StanceMode.Sleep; };
/** Crouched (the toggle; kept under a Block / Aim hold) -> quieter noise, smaller sight radius for zombies. */
export const isCrouched = (world: World, e: Entity): boolean => (world.isRegistered(Stance) ? world.getField(e, Stance, "crouch") === 1 : false) && stanceMode(world, e) !== StanceMode.Carry && stanceMode(world, e) !== StanceMode.Sleep;

/** Bed spots for a piece key (bed_double_* wildcard), [] = not a bed. */
export function bedSpots(key: string): string[] {
  const b = STANCE.beds; if (b[key]) return b[key]!;
  for (const [k, v] of Object.entries(b)) if (k.endsWith("*") && key.startsWith(k.slice(0, -1))) return v;
  return [];
}
/** Lie mode for a spot: 2 = sleep_lie_under (bunk lower), 1 = sleep_lie. */
export const spotLie = (spot: string): number => (STANCE.underSpots.includes(spot) ? 2 : 1);
/** Bed rotation 0..3 from its facing (sleep_lie dir = rot; facing = rot * pi/2). */
export const bedRot = (facing: number): number => ((Math.round(facing / (Math.PI / 2)) % 4) + 4) % 4;

export interface StanceInput {
  /** Secondary hold (LT / RMB / touch guard): block, or aim with a ranged weapon. */ guard: boolean;
  /** Crouch hold bit (R3 / Ctrl / touch crouch): the rising edge toggles crouch. */ crouch: boolean;
  /** Carry edge (RB+X / G / touch carry): pick up the nearest liftable, or drop. */ carry: boolean;
  /** Rest edge (RB+A / Z / touch sleep): sleep in the nearest bed, or wake. */ rest: boolean;
  /** Interact hold bit: its rising edge drops a carried object. */ interact: boolean;
  /** Any other input this seq (move / primary / sprint / edges): wakes a sleeper. */ active: boolean;
}
const prevBits = new WeakMap<World, Map<Entity, number>>();
const prevOf = (w: World): Map<Entity, number> => { let m = prevBits.get(w); if (!m) prevBits.set(w, (m = new Map())); return m; };
const guardBroken = new WeakMap<World, Set<Entity>>();
const brokenOf = (w: World): Set<Entity> => { let s = guardBroken.get(w); if (!s) guardBroken.set(w, (s = new Set())); return s; };

function ensure(world: World, e: Entity): void { if (!world.has(e, Stance)) world.add(e, Stance, {}); }
function setMode(world: World, e: Entity, mode: number): void {
  const cur = world.getField(e, Stance, "mode"); if (cur === mode) return;
  world.set(e, Stance, { mode, sinceTick: world.tick });
  const want = STANCE_ANIM[mode] ?? Anim.Idle; const a = world.getField(e, AnimState, "anim");
  if (a === undefined) world.add(e, AnimState, { anim: want, startTick: world.tick });
  else if (a !== want) world.set(e, AnimState, { anim: want, startTick: world.tick });
}

/** Nearest LootBag in carry reach not carried by anyone. */
export function liftableNear(world: World, e: Entity): Entity | undefined {
  const t = world.get(e, Transform); if (!t || !world.isRegistered(LootBag)) return undefined;
  const carried = carriedBags(world); let best: Entity | undefined; let bd = STANCE.carryReach;
  // a plain LootBag query (bags are few): also correct on a client world whose spatial index is not kept per tick
  for (const b of world.query([LootBag, Transform])) {
    if (carried.has(b)) continue;
    const bt = world.get(b, Transform)!; const d = Math.hypot(bt.x - t.x, bt.y - t.y); if (d <= bd) { bd = d; best = b; }
  }
  return best;
}
/** Bags currently carried (entity -> carrier). */
export function carriedBags(world: World): Map<Entity, Entity> {
  const m = new Map<Entity, Entity>(); if (!world.isRegistered(Stance)) return m;
  for (const p of world.query([Stance])) { const id = world.getField(p, Stance, "carriedNetId")!; const b = id ? netIdEntity(world, id) : undefined; if (b !== undefined) m.set(b, p); }
  return m;
}
/** Nearest bed piece in reach with a free spot -> { bed, spot }. Fit check: the piece key must be a known bed and a spot free. */
export function bedNear(world: World, e: Entity): { bed: Entity; spot: number } | undefined {
  const t = world.get(e, Transform); if (!t) return undefined; const defs = gameplayDefs(world);
  const taken = new Map<Entity, Set<number>>();
  for (const p of world.query([Stance])) {
    if (p === e || world.getField(p, Stance, "mode") !== StanceMode.Sleep) continue;
    const b = netIdEntity(world, world.getField(p, Stance, "bedNetId")!); if (b === undefined) continue;
    let s = taken.get(b); if (!s) taken.set(b, (s = new Set())); s.add(world.getField(p, Stance, "spot")!);
  }
  let best: { bed: Entity; spot: number } | undefined; let bd = STANCE.bedReach;
  for (const b of world.query([BuildPiece, Transform])) {
    const bt = world.get(b, Transform)!; const d = Math.hypot(bt.x - t.x, bt.y - t.y); if (d > bd || Math.abs((bt.z ?? 0) - (t.z ?? 0)) > 1.5) continue;
    const key = defs.pieces.get(world.getField(b, BuildPiece, "type")!)?.key; const spots = key ? bedSpots(key) : [];
    const free = spots.findIndex((_, i) => !taken.get(b)?.has(i)); if (free < 0) continue;
    bd = d; best = { bed: b, spot: free };
  }
  return best;
}

export function pickUp(world: World, e: Entity, bag: Entity): boolean {
  const id = netIdOf(world, bag); if (!id) return false; ensure(world, e);
  world.set(e, Stance, { carriedNetId: id }); setMode(world, e, StanceMode.Carry); return true;
}
export function drop(world: World, e: Entity): void {
  const id = world.getField(e, Stance, "carriedNetId"); if (!id) return;
  const b = netIdEntity(world, id); const t = world.get(e, Transform);
  if (b !== undefined && t) { const f = t.facing ?? 0; world.set(b, Transform, { x: t.x + Math.cos(f) * 0.6, y: t.y + Math.sin(f) * 0.6, z: t.z ?? 0 }); }
  world.set(e, Stance, { carriedNetId: 0 }); setMode(world, e, world.getField(e, Stance, "crouch") ? StanceMode.Crouch : StanceMode.None);
}
/** ADR-244 (c): a sleeper lies at the bed's footprint centre (the bed sprite's pivot, Art's sleep_lie pivot), not its anchor
 *  tile, so the lying frame lands on the mattress and sorts just after the bed in both renderers. */
export function bedCentre(world: World, bed: Entity, bt: { x: number; y: number }): { x: number; y: number } {
  const bp = world.get(bed, BuildPiece); const def = bp ? gameplayDefs(world).pieces.get(bp.type) : undefined;
  if (!bp || !def || (def.placement !== Placement.Cell && def.placement !== Placement.Free)) return { x: bt.x, y: bt.y };
  const [w, h] = rotatedSize(def, gridRot(def, bp.rot)); return { x: Math.floor(bt.x) + w / 2, y: Math.floor(bt.y) + h / 2 };
}
export function sleepIn(world: World, e: Entity, bed: Entity, spot: number): boolean {
  const defs = gameplayDefs(world); const key = defs.pieces.get(world.getField(bed, BuildPiece, "type")!)?.key ?? "";
  const spots = bedSpots(key); const name = spots[spot]; if (!name) return false;
  ensure(world, e); if (world.getField(e, Stance, "carriedNetId")) drop(world, e);
  const bt = world.get(bed, Transform)!; const c = bedCentre(world, bed, bt);
  world.set(e, Transform, { x: c.x, y: c.y, z: bt.z ?? 0, facing: bedRot(bt.facing ?? 0) * (Math.PI / 2) });
  world.set(e, Stance, { bedNetId: netIdOf(world, bed), spot, lie: spotLie(name), crouch: 0 });
  setMode(world, e, StanceMode.Sleep); return true;
}
/** Wake: step out beside the bed (or stay put for a floor sleep). */
export function wake(world: World, e: Entity): void {
  if (stanceMode(world, e) !== StanceMode.Sleep) return;
  const b = netIdEntity(world, world.getField(e, Stance, "bedNetId")!); const bt = b !== undefined ? world.get(b, Transform) : undefined;
  if (bt) { const r = bedRot(bt.facing ?? 0); const side = r & 1 ? { x: 0, y: 1.1 } : { x: 1.1, y: 0 }; world.set(e, Transform, { x: bt.x + side.x, y: bt.y + side.y }); }
  world.set(e, Stance, { bedNetId: 0, spot: 0, lie: 0 }); setMode(world, e, StanceMode.None);
}

const CROUCH = 1, INTERACT = 2;
/** Server per-input hook (exactly once per input seq). */
export function applyStanceInput(world: World, e: Entity, inp: StanceInput): void {
  if (!isAuthority(world) || !world.isAlive(e) || world.has(e, Dead) || !world.has(e, Survival)) return;
  ensure(world, e);
  const pm = prevOf(world); const prev = pm.get(e) ?? 0; const bits = (inp.crouch ? CROUCH : 0) | (inp.interact ? INTERACT : 0); pm.set(e, bits);
  const crouchEdge = inp.crouch && !(prev & CROUCH); const interactEdge = inp.interact && !(prev & INTERACT);
  const mode = stanceMode(world, e);
  if (mode === StanceMode.Sleep) {
    const since = world.getField(e, Stance, "sinceTick")!;
    if ((inp.active || inp.rest || inp.carry || crouchEdge || interactEdge || inp.guard) && world.tick - since >= STANCE.sleepWakeGraceTicks) wake(world, e);
    return;
  }
  if (world.has(e, Driver)) { if (mode !== StanceMode.None) setMode(world, e, StanceMode.None); return; }
  if (inp.rest) { const b = bedNear(world, e); if (b) { sleepIn(world, e, b.bed, b.spot); return; } }
  if (mode === StanceMode.Carry) { if (inp.carry || interactEdge) drop(world, e); return; }
  if (inp.carry) { const bag = liftableNear(world, e); if (bag !== undefined && pickUp(world, e, bag)) return; }
  if (crouchEdge) world.setField(e, Stance, "crouch", world.getField(e, Stance, "crouch") ? 0 : 1);
  const brk = brokenOf(world); if (!inp.guard) brk.delete(e);
  let next: number = world.getField(e, Stance, "crouch") ? StanceMode.Crouch : StanceMode.None;
  if (inp.guard && !brk.has(e)) {
    const item = world.getField(e, Equipment, "mainHandItem") ?? 0; const def = item ? gameplayDefs(world).items.get(item) : undefined;
    if (def?.ranged) next = StanceMode.Aim;
    else if ((world.getField(e, Survival, "stamina") ?? 0) > 0) next = StanceMode.Block;
  }
  setMode(world, e, next);
}

/** Block reduction for an incoming melee hit (0..1 multiplier); spends stamina, breaks the guard at 0. */
export function blockMul(world: World, target: Entity, source: Entity): number {
  if (stanceMode(world, target) !== StanceMode.Block) return 1;
  const tt = world.get(target, Transform), st = world.get(source, Transform);
  if (tt && st && (st.x !== tt.x || st.y !== tt.y)) {
    const ang = Math.atan2(st.y - tt.y, st.x - tt.x); let d = Math.abs(ang - (tt.facing ?? 0)); d = Math.min(d, 2 * Math.PI - (d % (2 * Math.PI)));
    if (d > (STANCE.blockArcDeg * Math.PI) / 360) return 1; // hit from behind / the side: no block
  }
  const stam = world.getField(target, Survival, "stamina") ?? 0; const left = Math.max(0, stam - STANCE.blockStaminaPerHit);
  world.setField(target, Survival, "stamina", left);
  if (left <= 0) { brokenOf(world).add(target); setMode(world, target, world.getField(target, Stance, "crouch") ? StanceMode.Crouch : StanceMode.None); }
  return 1 - STANCE.blockMeleeReduction;
}

/** True when every live player is asleep (the multiplayer-safe night skip condition). */
export function allAsleep(world: World): boolean {
  let n = 0;
  for (const p of world.query([Survival, Transform], [Dead])) { if (!world.has(p, Health)) continue; n++; if (stanceMode(world, p) !== StanceMode.Sleep) return false; }
  return n > 0;
}

/** Authority per tick: carried bags follow, block drain break, sleep heal, all-asleep time skip, stance anim upkeep. */
export function stanceSystem(world: World, dt: number): void {
  if (!isAuthority(world) || world.isReplaying || !world.isRegistered(Stance)) return;
  const st = world.store(Stance); const brk = brokenOf(world);
  for (let k = 0; k < st.size; k++) {
    const e = st.dense[k]!; const mode = st.data.mode[k]!;
    if (mode === StanceMode.None && !st.data.crouch[k]) continue;
    if (!world.isAlive(e) || world.has(e, Dead)) { if (mode !== StanceMode.None || st.data.crouch[k]) { if (mode === StanceMode.Carry) drop(world, e); world.set(e, Stance, { mode: StanceMode.None, crouch: 0, bedNetId: 0, carriedNetId: 0 }); } continue; }
    if (mode === StanceMode.Carry) {
      const b = netIdEntity(world, st.data.carriedNetId[k]!); const t = world.get(e, Transform)!;
      if (b === undefined) { world.set(e, Stance, { carriedNetId: 0 }); setMode(world, e, StanceMode.None); continue; }
      const bt = world.get(b, Transform); if (bt && (bt.x !== t.x || bt.y !== t.y || (bt.z ?? 0) !== (t.z ?? 0))) world.set(b, Transform, { x: t.x, y: t.y, z: t.z ?? 0 });
    } else if (mode === StanceMode.Block) {
      if ((world.getField(e, Survival, "stamina") ?? 0) <= 0) { brk.add(e); setMode(world, e, world.getField(e, Stance, "crouch") ? StanceMode.Crouch : StanceMode.None); }
    } else if (mode === StanceMode.Sleep) {
      const bed = netIdEntity(world, st.data.bedNetId[k]!); if (st.data.bedNetId[k] && bed === undefined) { wake(world, e); continue; } // bed destroyed
      const hp = world.getField(e, Health, "hp"), max = world.getField(e, Health, "max");
      if (hp !== undefined && max !== undefined && hp < max) world.setField(e, Health, "hp", Math.min(max, hp + STANCE.sleepHealPerSec * dt));
    }
    // a finished one-shot (attack / hurt) settles to Idle in animSettle; re-assert the held stance anim
    const want = STANCE_ANIM[mode]; if (want !== undefined && world.getField(e, AnimState, "anim") === Anim.Idle) world.set(e, AnimState, { anim: want, startTick: world.tick });
  }
  timeSkip(world);
}
/** Night skip: while every player sleeps between timeSkipFromHour and timeSkipWakeHour, the clock runs timeSkipMul x. */
export function timeSkip(world: World): boolean {
  const tod = timeOfDay(world); if (tod.dayLengthTicks <= 0) return false;
  // ADR-283: the night window is in sun hours (stretches with the season); the clock still steps in wall hours.
  const h = tod.hours, sh = sunFractionOf(tod) * 24; const night = sh >= STANCE.timeSkipFromHour || sh < STANCE.timeSkipWakeHour; if (!night || !allAsleep(world)) return false;
  const wake = wallHoursForSun(STANCE.timeSkipWakeHour, tod.daylightHours ?? 12);
  const step = ((STANCE.timeSkipMul - 1) / tod.dayLengthTicks) * 24; let next = h + step; let day = tod.day;
  if (h > 12 && next >= 24) { next -= 24; day += 1; }
  if (h < wake + 1e-9 && h <= 12 && next >= wake) next = wake;
  setTimeOfDay(world, next, day); return true;
}
