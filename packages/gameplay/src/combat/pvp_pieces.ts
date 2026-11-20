/**
 * PvP / clan pieces (Art & Assets pvp_clan proposal) and the Burning status. Authority only; all randomness via
 * world.rngFor; no wall clock. Feature data lives in pieces.json `features`, fire tuning in data/fire.json.
 *  - contact (barricade_spiked): creatures (Health, not Dead) within radius take dps and a MoveSpeed slow; the
 *    piece's own Tribe is spared. Checked every CONTACT_EVERY ticks.
 *  - alarm (raid_bell): when a piece within radius is damaged, the bell emits RaidAlarm (cooldownSeconds per bell).
 *  - breachAt (gate_clan): at hp/max <= breachAt the door is forced open and unlocked; DoorState.open = 2
 *    (DOOR_BREACHED, render "breached" state) cannot be closed again until repaired above the threshold.
 *  - clanLock (gate_clan, clan_hall_door): the door spawns locked to the builder's tribe.
 *  - sightBonus (watchtower): `sightBonusAt(world, x, y)` for vision/AOI consumers (hook only).
 *  - Burning: `ignite(world, e)`; pieces burn per fire.json (dps x intensity/255, grow, spread to flammable tiers,
 *    rain/storm quench); creatures take dps x intensity/255 and the flame decays by growPerCheck per check.
 */
import { addModifier, ModOp, PlayerId, Transform, Weather, type Entity, type World } from "@engine/core";
import fireRaw from "../../data/fire.json";
import { BuildPiece, Buffs, Burning, DamageCause, Dead, DoorState, Health, LightningFire, ResourceNode, Stat, Survival, Tribe } from "../components.js";
import { gameplayDefs, isAuthority } from "../config.js";
import { secondsToTicks, ToolKind, WeatherKind, type PieceDef } from "../defs.js";
import { emit, Extinguished, Ignited, RaidAlarm, WeatherChanged } from "../events.js";
import { depleteNode } from "../systems/gathering.js";
import { applyDamage } from "./combat.js";
import { damagePiece, maxHpOf } from "../building/integrity.js";
import { attachmentsOf } from "../building/links.js";
import { noteUnlockEvent } from "../customization.js";
import { GateBreached, hasPlayerId } from "./pvp.js";
import { installSpatialIndex } from "@engine/world";

export interface FireTuning { checkSeconds: number; dps: number; igniteIntensity: number; growPerCheck: number; spreadRadius: number; spreadChance: number; rainQuench: number; flammableTiers: number[]; /** ADR-451: one gameplay strike per storm, 5..15 tiles from a random survivor. */ lightning: { strikesPerStorm: number; radius: number; minDistance: number } }
export const FIRE: Readonly<FireTuning> = fireRaw;
export const CONTACT_EVERY = 4;
export const DOOR_BREACHED = 2;

const bellCooldown = new WeakMap<World, Map<Entity, number>>();
const defOf = (world: World, e: Entity): PieceDef | undefined => { const t = world.getField(e, BuildPiece, "type"); return t === undefined ? undefined : gameplayDefs(world).pieces.get(t); };
const pos = (world: World, e: Entity): { x: number; y: number } | undefined => world.get(e, Transform);
/** Spatial-index query (flushes pending Transform changes first, so same-tick placements are seen), sorted for determinism. */
const scratch: Entity[] = [];
function nearby(world: World, x: number, y: number, r: number, keep: (e: Entity) => boolean): Entity[] {
  const idx = installSpatialIndex(world); idx.update(); scratch.length = 0; idx.queryRadius(x, y, r, scratch);
  return scratch.filter(keep).sort((a, b) => a - b);
}
const featureRadius = new WeakMap<object, { alarm: number; sight: number; contact: number }>();
/** Largest alarm / sight / contact radius over all piece defs (search radius for the index). */
function maxRadii(world: World): { alarm: number; sight: number; contact: number } {
  const defs = gameplayDefs(world); let m = featureRadius.get(defs);
  if (!m) {
    m = { alarm: 0, sight: 0, contact: 0 };
    for (const d of defs.pieces.values()) {
      if (d.features.alarm) m.alarm = Math.max(m.alarm, d.features.alarm.radius);
      if (d.features.contact) m.contact = Math.max(m.contact, d.features.contact.radius);
      if ((d.features.sightBonus ?? 0) > 0) m.sight = Math.max(m.sight, d.footprint.w, d.footprint.h);
    }
    featureRadius.set(defs, m);
  }
  return m;
}
const pieceWith = (world: World, pick: (d: PieceDef) => boolean) => (e: Entity): boolean => { const d = defOf(world, e); return d !== undefined && pick(d); };

/** Sets a target burning (authority). Pieces only ignite when their tier is flammable. Returns true if now burning. */
export function ignite(world: World, e: Entity, intensity = FIRE.igniteIntensity): boolean {
  if (!isAuthority(world) || world.isReplaying || !world.isAlive(e)) return false;
  if (world.has(e, BuildPiece) && !FIRE.flammableTiers.includes(world.getField(e, BuildPiece, "tier")!)) return false;
  if (!world.has(e, BuildPiece) && !world.has(e, Health)) return false;
  const cur = world.get(e, Burning);
  if (cur && cur.lit) { world.setField(e, Burning, "intensity", Math.max(cur.intensity, Math.min(255, intensity))); return true; }
  const v = { lit: 1, intensity: Math.min(255, intensity), startTick: world.tick };
  if (cur) world.set(e, Burning, v); else world.add(e, Burning, v);
  emit(world, Ignited, { entity: e }); return true;
}
export function extinguish(world: World, e: Entity): void {
  if (!world.has(e, Burning)) return; world.remove(e, Burning);
  if (world.has(e, LightningFire)) world.remove(e, LightningFire); // ADR-451: the exemption ends with the fire
  emit(world, Extinguished, { entity: e });
}

/** ADR-451: ignite as a lightning fire — exempt from storm quench (see burningSystem). */
export function igniteLightning(world: World, e: Entity): boolean {
  if (!ignite(world, e)) return false;
  if (!world.has(e, LightningFire)) world.add(e, LightningFire, { struckTick: world.tick });
  return true;
}

/** Fire system (every checkSeconds). */
export function burningSystem(world: World, dt: number): void {
  if (!isAuthority(world) || world.isReplaying) return;
  const every = Math.max(1, secondsToTicks(FIRE.checkSeconds, dt)); if (world.tick % every !== 0) return;
  const wk = world.env(Weather).kind; const wet = wk === WeatherKind.Rain || wk === WeatherKind.Storm;
  const burning = [...world.query([Burning])].sort((a, b) => a - b);
  for (const e of burning) {
    const b = world.get(e, Burning)!; if (!b.lit) continue;
    const isPiece = world.has(e, BuildPiece);
    const dmg = FIRE.dps * FIRE.checkSeconds * (b.intensity / 255);
    if (isPiece) damagePiece(world, e, dmg, undefined, DamageCause.Fire); else applyDamage(world, e, dmg, e, DamageCause.Fire);
    let next = b.intensity + (isPiece ? FIRE.growPerCheck : -FIRE.growPerCheck) - (wet && !world.has(e, LightningFire) ? FIRE.rainQuench : 0); // ADR-451: lightning fires are exempt from storm quench
    if (world.has(e, Dead)) next = 0;
    next = Math.max(0, Math.min(255, next));
    if (next === 0) { extinguish(world, e); continue; }
    if (next !== b.intensity) world.setField(e, Burning, "intensity", next);
    if (isPiece) {
      const p = pos(world, e)!; const rng = world.rngFor("fire.spread", e);
      for (const o of nearby(world, p.x, p.y, FIRE.spreadRadius, (o) => o !== e && world.has(o, BuildPiece))) {
        if (world.getField(o, Burning, "lit")) continue;
        if (rng.next() < FIRE.spreadChance) ignite(world, o);
      }
    }
  }
}

/**
 * ADR-451 lightning: one gameplay strike per storm, rolled server-side on WeatherChanged (not from the
 * renderer's client-side visual bolts, which stay per-client noise). One rng stream per storm, sequential
 * draws; strikes land near a survivor (5..radius tiles from a random player/bot) and never on a person.
 * Target priority: nearest tree (axe node) — scorch = depletion (dies, regrows; a stump for stumpSeconds) —
 * else the nearest flammable piece, ignited as a quench-exempt lightning fire; else no strike.
 */
export function installLightning(world: World): void {
  world.events.on(WeatherChanged, (p: { from: WeatherKind; to: WeatherKind; intensity: number; ticks: number }) => {
    if (p.to !== WeatherKind.Storm || !isAuthority(world) || world.isReplaying) return;
    const rng = world.rngFor("lightning");
    for (let i = 0; i < FIRE.lightning.strikesPerStorm; i++) resolveLightningStrike(world, rng);
  });
}
export function resolveLightningStrike(world: World, rng: { next(): number; int(min: number, maxExclusive: number): number }): { kind: "tree" | "fire"; entity: Entity } | undefined {
  if (!isAuthority(world) || world.isReplaying) return undefined;
  const defs = gameplayDefs(world); const L = FIRE.lightning;
  const people = [...world.query([Survival, Transform])].sort((a, b) => a - b);
  if (people.length === 0) return undefined;
  const anchor = people[rng.int(0, people.length)]!;
  const a = world.get(anchor, Transform)!;
  const ang = rng.next() * Math.PI * 2;
  const dist = L.minDistance + rng.next() * (L.radius - L.minDistance);
  const x = a.x + Math.cos(ang) * dist, y = a.y + Math.sin(ang) * dist;
  const distTo = (e: Entity): number => { const t = world.get(e, Transform)!; return Math.hypot(t.x - x, t.y - y); };
  const trees = nearby(world, x, y, L.radius, (e) => world.has(e, ResourceNode))
    .filter((e) => { const k = world.getField(e, ResourceNode, "kind"); const d = k === undefined ? undefined : defs.resources.get(k); return d !== undefined && d.requiredTool === ToolKind.Axe && !d.oneShot; })
    .sort((p, q) => distTo(p) - distTo(q) || p - q);
  if (trees.length > 0) {
    const node = trees[0]!; const kind = world.getField(node, ResourceNode, "kind")!;
    const def = defs.resources.get(kind)!; const dep = defs.depletion;
    depleteNode(world, node, kind, world.tick + secondsToTicks(def.respawnSeconds * dep.respawnMul, 1 / 20), secondsToTicks(dep.stumpSeconds, 1 / 20));
    return { kind: "tree", entity: node };
  }
  const pieces = nearby(world, x, y, L.radius, (e) => world.has(e, BuildPiece) && FIRE.flammableTiers.includes(world.getField(e, BuildPiece, "tier")!))
    .sort((p, q) => distTo(p) - distTo(q) || p - q);
  if (pieces.length > 0 && igniteLightning(world, pieces[0]!)) return { kind: "fire", entity: pieces[0]! };
  return undefined;
}

/** Contact damage + slow (barricade_spiked), every CONTACT_EVERY ticks. */
export function contactSystem(world: World, dt: number): void {
  if (!isAuthority(world)) { predictContactSlow(world, dt); return; }
  if (world.isReplaying || world.tick % CONTACT_EVERY !== 0) return;
  const spikes = [...world.query([BuildPiece, Transform])].filter(pieceWith(world, (d) => d.features.contact !== undefined)); if (spikes.length === 0) return;
  const period = CONTACT_EVERY * dt;
  for (const s of spikes.sort((a, b) => a - b)) {
    const c = defOf(world, s)!.features.contact!; const p = pos(world, s)!; const tribe = world.getField(s, Tribe, "id") ?? 0;
    for (const v of nearby(world, p.x, p.y, c.radius, (v) => world.has(v, Health) && !world.has(v, Dead) && !world.has(v, BuildPiece))) {
      if (tribe !== 0 && world.getField(v, Tribe, "id") === tribe) continue;
      applyDamage(world, v, c.dps * period, s, DamageCause.Contact);
      addModifier(world, v, Buffs, { stat: Stat.MoveSpeed, op: ModOp.Mul, value: c.slowMul, expiresAtTick: world.tick + secondsToTicks(c.slowSeconds, dt) });
    }
  }
}

/**
 * ADR-191: the predicting client applies the same contact slow to its own predicted entities (live ticks and
 * reconcile replays), so walking through spikes no longer rubber-bands back by the slow the server applied a round
 * trip earlier. Damage stays authority-only; only the MoveSpeed modifier (replace semantics: idempotent) is predicted.
 */
export function predictContactSlow(world: World, dt: number): void {
  if (world.predicted.size === 0) return;
  let spikes: Entity[] | undefined;
  for (const v of world.predicted) {
    if (!world.isAlive(v) || !world.has(v, Health) || world.has(v, Dead) || world.has(v, BuildPiece)) continue;
    const tick = world.simTick(v); if (tick % CONTACT_EVERY !== 0) continue; // the server's cadence, in its tick frame
    const q = pos(world, v); if (!q) continue;
    spikes ??= [...world.query([BuildPiece, Transform])].filter(pieceWith(world, (d) => d.features.contact !== undefined)).sort((a, b) => a - b);
    if (spikes.length === 0) return;
    for (const s of spikes) {
      const c = defOf(world, s)!.features.contact!; const p = pos(world, s)!;
      if (Math.hypot(q.x - p.x, q.y - p.y) > c.radius) continue;
      const tribe = world.getField(s, Tribe, "id") ?? 0; if (tribe !== 0 && world.getField(v, Tribe, "id") === tribe) continue;
      addModifier(world, v, Buffs, { stat: Stat.MoveSpeed, op: ModOp.Mul, value: c.slowMul, expiresAtTick: tick + secondsToTicks(c.slowSeconds, dt) });
    }
  }
}

/** Called by structureDamageSystem after a piece's hp drops (authority): gate breach + raid bells. */
export function onPieceDamaged(world: World, e: Entity, hp: number, attacker: Entity = 0 as Entity): void {
  const def = defOf(world, e); if (!def) return;
  const breachAt = def.features.breachAt;
  if (breachAt !== undefined && def.door && hp / Math.max(1, maxHpOf(world, e)) <= breachAt) {
    let breached = false;
    for (const a of attachmentsOf(world, e)) if (world.has(a, DoorState) && world.getField(a, DoorState, "open") !== DOOR_BREACHED) { world.set(a, DoorState, { open: DOOR_BREACHED, lockTribe: 0 }); breached = true; }
    if (breached) {
      emit(world, GateBreached, { piece: e, attacker });
      if (attacker && world.isAlive(attacker) && hasPlayerId(world, attacker)) noteUnlockEvent(world, attacker, "raidBreach");
    }
  }
  const p = pos(world, e); if (!p) return;
  let cd = bellCooldown.get(world); if (!cd) bellCooldown.set(world, cd = new Map());
  const dt = 1 / 20;
  const R = maxRadii(world).alarm; if (R <= 0) return;
  for (const bell of nearby(world, p.x, p.y, R, pieceWith(world, (d) => d.features.alarm !== undefined))) {
    const al = defOf(world, bell)!.features.alarm!; const q = pos(world, bell)!;
    if (Math.hypot(q.x - p.x, q.y - p.y) > al.radius || (cd.get(bell) ?? -1) > world.tick) continue;
    cd.set(bell, world.tick + secondsToTicks(al.cooldownSeconds, dt));
    emit(world, RaidAlarm, { bell, piece: e, tribe: world.getField(bell, Tribe, "id") ?? 0 });
  }
}

/** Repair above breachAt restores a breached gate to closed (called from repair). */
export function clearBreach(world: World, e: Entity): void {
  const def = defOf(world, e); if (def?.features.breachAt === undefined) return;
  if ((world.getField(e, BuildPiece, "hp") ?? 0) / Math.max(1, maxHpOf(world, e)) <= def.features.breachAt) return;
  for (const a of attachmentsOf(world, e)) if (world.getField(a, DoorState, "open") === DOOR_BREACHED) world.setField(a, DoorState, "open", 0);
}

/** Max sightBonus of watchtower-like pieces covering (x, y) (within their footprint radius). */
export function sightBonusAt(world: World, x: number, y: number): number {
  let best = 0;
  const R = maxRadii(world).sight; if (R <= 0) return 0;
  for (const e of nearby(world, x, y, R, pieceWith(world, (d) => (d.features.sightBonus ?? 0) > 0))) {
    const d = defOf(world, e)!; const p = pos(world, e)!; const r = Math.max(d.footprint.w, d.footprint.h);
    if (Math.hypot(p.x - x, p.y - y) <= r) best = Math.max(best, d.features.sightBonus!);
  }
  return best;
}
