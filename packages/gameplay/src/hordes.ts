/**
 * ADR-121 roaming zombie hordes. A server-only director (gameplay.hordes) that, once the world's grace period is over
 * (WorldRules.hordeGraceDays in-game days, doubled for targets whose players are below hordes.minTargetLevel), sends
 * one horde per hordes.intervalDays at dusk / night toward a player- or clan-owned structure group. Hordes are plain
 * zombies tagged HordeMember: the zombie AI walks them to the target piece and attacks it, so fire light avoidance,
 * snuffers (part of the composition), defenses and wall breaking all apply unchanged. Members do not despawn when no
 * player is near. WorldRules.hordes = 0 disables the director entirely.
 *
 * Size (hordeSize): scale = min(scaleCap, 1 + levelScalePerLevel * (avgLevel - 1) + dayScalePerDay * daysPastGrace)
 *   solo: min(solo.cap, round(solo.base * scale))
 *   clan: min(clan.cap, round((clan.base + clan.perMember * members) * scale))
 * then clipped to the global budget (maxHordeZombies alive in hordes, maxActiveHordes). With the shipped data the
 * smallest clan horde (16) is larger than the largest solo horde (14).
 */
import { terrainBlocksWalker } from "./systems/movement.js";
import { defineResource, GroupKind, TimeOfDay as TimeOfDayLike, Permissions, PlayerId, Transform, type Entity, type World } from "@engine/core";
import raw from "../data/roads.json";
import { gateZombieKind } from "./combat/zombie_gate.js";
import { BuildPiece, Dead, HordeMember, HordePhase, HordeStatus, PieceOwner, Progression, Survival, Tribe, WorldRules, Zombie, ZombieBrain, ZState } from "./components.js";
import { gameplayDefs, isAuthority } from "./config.js";
import { secondsToTicks } from "./defs.js";
import { currentPhaseKey, spawnZombie } from "./combat/zombies.js";
import { TerrainRes } from "./world.js";
import { lastLoudNoise } from "./systems/noise.js";
import { nearestLight } from "./systems/lights.js";
import { pieceOf } from "./building/links.js";

export interface HordeTuning {
  enabledDefault: boolean; graceDaysDefault: number; lowLevelGraceMul: number; minTargetLevel: number; intervalDays: number; warnSeconds: number;
  phases: string[]; solo: { base: number; cap: number }; clan: { base: number; perMember: number; cap: number };
  levelScalePerLevel: number; dayScalePerDay: number; scaleCap: number; maxActiveHordes: number; maxHordeZombies: number;
  spawnRingMin: number; spawnRingMax: number; targetRadius: number; composition: Record<string, number>; minPiecesPerTarget: number;
  /** ADR-476: noise level at which a survivor's action draws a horde (8 = gather/chop; gunshot 9, build 10, walk 12, sprint 18, explosion 27; door 5 and swim 7 do not). */
  noiseMin: number;
  /** ADR-476: in-game minutes a horde sieges a noisy base (refreshed by further loud noise there). */
  siegeMinutes: number;
  /** ADR-476: tiles from the siege target within which a sieging horde seeks the base's lights. */
  lightSeekTiles: number;
  /** ADR-476: max distance from a loud noise to a structure group for the horde to siege it. */
  noiseTargetRadius: number;
}
export const HORDES = raw.hordes as HordeTuning;
export const HORDES_EVERY = 20;
export const enum HordeKind { Solo = 1, Clan = 2 }

/** Pure size formula (see file header). */
export function hordeSize(o: { clan: boolean; members?: number; level?: number; daysPastGrace?: number }, t: HordeTuning = HORDES): number {
  const scale = Math.min(t.scaleCap, 1 + t.levelScalePerLevel * Math.max(0, (o.level ?? 1) - 1) + t.dayScalePerDay * Math.max(0, o.daysPastGrace ?? 0));
  if (!o.clan) return Math.min(t.solo.cap, Math.max(1, Math.round(t.solo.base * scale)));
  return Math.min(t.clan.cap, Math.round((t.clan.base + t.clan.perMember * Math.max(1, o.members ?? 1)) * scale));
}

export interface WorldRulesOpts { hordes?: boolean; hordeGraceDays?: number; /** Task 22: AI humans spawn / are recruitable (default on). */ aiHumans?: boolean }
/** Sets the replicated world rules on the environment singleton (server/standalone at install; loaders after meta). */
export function setWorldRules(world: World, r: WorldRulesOpts): void {
  const cur = world.get(world.environment, WorldRules);
  const hordes = r.hordes ?? (cur ? cur.hordes === 1 : HORDES.enabledDefault);
  const grace = Math.max(0, Math.min(365, r.hordeGraceDays ?? cur?.hordeGraceDays ?? HORDES.graceDaysDefault));
  const aiHumans = r.aiHumans ?? (cur ? cur.aiHumans === 1 : true);
  const v = { hordes: hordes ? 1 : 0, hordeGraceDays: grace, aiHumans: aiHumans ? 1 : 0 };
  if (cur) world.set(world.environment, WorldRules, v); else world.add(world.environment, WorldRules, v);
}
export function worldRules(world: World): { hordes: boolean; hordeGraceDays: number; aiHumans: boolean } {
  const r = world.get(world.environment, WorldRules);
  return { hordes: r ? r.hordes === 1 : HORDES.enabledDefault, hordeGraceDays: r?.hordeGraceDays ?? HORDES.graceDaysDefault, aiHumans: r ? r.aiHumans === 1 : true };
}
/** In-game days since the world clock epoch (fractional). */
export function worldDays(world: World): number {
  const tod = world.env(TimeOfDayLike);
  return tod.dayLengthTicks > 0 ? (world.tick - tod.epochTick) / tod.dayLengthTicks : 0;
}

export interface HordeTarget { key: string; kind: HordeKind; owner: number; members: number; level: number; pieces: Entity[]; x: number; y: number }
interface Horde { id: number; kind: HordeKind; owner: number; key: string; members: Set<Entity>; tx: number; ty: number; target: Entity; /** ADR-476: tick the siege expires (0 = not sieging). */ siegeUntil: number }
interface Pending { at: number; t: HordeTarget; size: number }
interface HordeRuntime { hordes: Map<number, Horde>; nextId: number; nextTick: number; pending?: Pending | undefined; lastHit: Map<string, number> }
export const HordeRuntimeRes = defineResource<HordeRuntime>("gameplay.HordeRuntime");
export function hordeRuntime(world: World): HordeRuntime {
  let r = world.getResource(HordeRuntimeRes);
  if (!r) world.setResource(HordeRuntimeRes, (r = { hordes: new Map(), nextId: 1, nextTick: 0, lastHit: new Map() }));
  return r;
}

const levelOf = (world: World, e: Entity): number => (world.isRegistered(Progression) ? world.getField(e, Progression, "level") ?? 1 : 1) || 1;
/** Structure groups hordes can target: one per clan (pieces whose Tribe is a clan), per solo builder (PieceOwner),
 *  and ownerless pieces bucketed by 32-tile cell (legacy / reloaded solo builds). */
export function hordeTargets(world: World): HordeTarget[] {
  const reg = world.getResource(Permissions)?.groups;
  const players = new Map<number, Entity>(); if (world.isRegistered(PlayerId)) for (const p of world.query([Survival, PlayerId, Transform], [Dead])) players.set(world.getField(p, PlayerId, "id")!, p);
  const acc = new Map<string, HordeTarget>();
  for (const e of world.query([BuildPiece, Transform], [Dead])) {
    const tribe = world.getField(e, Tribe, "id") ?? 0; const t = world.get(e, Transform)!;
    const clanG = tribe && reg ? reg.get(tribe) : undefined;
    let key: string, kind = HordeKind.Solo, owner = 0;
    if (clanG && clanG.kind === GroupKind.Clan) { key = `c${tribe}`; kind = HordeKind.Clan; owner = tribe; }
    else { owner = world.getField(e, PieceOwner, "player") ?? 0; key = owner ? `p${owner}` : `h${Math.floor(t.x / 32)},${Math.floor(t.y / 32)}`; }
    let g = acc.get(key); if (!g) acc.set(key, (g = { key, kind, owner, members: 1, level: 1, pieces: [], x: 0, y: 0 }));
    g.pieces.push(e); g.x += t.x; g.y += t.y;
  }
  const out: HordeTarget[] = [];
  for (const g of acc.values()) {
    if (g.pieces.length < HORDES.minPiecesPerTarget) continue;
    g.x /= g.pieces.length; g.y /= g.pieces.length;
    if (g.kind === HordeKind.Clan) {
      const grp = reg!.get(g.owner)!; g.members = Math.max(1, grp.members.size);
      const lv = [...grp.members.keys()].map((p) => players.get(p)).filter((e): e is Entity => e !== undefined).map((e) => levelOf(world, e));
      g.level = lv.length ? lv.reduce((a, b) => a + b, 0) / lv.length : 1;
    } else {
      let pe = g.owner ? players.get(g.owner) : undefined;
      if (pe === undefined) { let bd = Infinity; for (const p of players.values()) { const t = world.get(p, Transform)!; const d = Math.hypot(t.x - g.x, t.y - g.y); if (d < bd) { bd = d; pe = p; } } }
      g.level = pe !== undefined ? levelOf(world, pe) : 1;
    }
    out.push(g);
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
/** Grace in days for a target: world grace, times lowLevelGraceMul while its players are below minTargetLevel. */
export const graceFor = (graceDays: number, level: number): number => graceDays * (level >= HORDES.minTargetLevel ? 1 : HORDES.lowLevelGraceMul);

const status = (world: World) => world.get(world.environment, HordeStatus);
function setStatus(world: World, patch: Partial<{ phase: number; seq: number; kind: number; size: number; alive: number; x: number; y: number; owner: number; nextTick: number }>): void {
  const cur = status(world) ?? { phase: 0, seq: 0, kind: 0, size: 0, alive: 0, x: 0, y: 0, owner: 0, nextTick: 0 };
  const next = { ...cur, ...patch };
  if (Object.keys(patch).some((k) => (cur as Record<string, number>)[k] !== (next as Record<string, number>)[k]) || !world.has(world.environment, HordeStatus)) { if (world.has(world.environment, HordeStatus)) world.set(world.environment, HordeStatus, next); else world.add(world.environment, HordeStatus, next); }
}

function walkable(world: World, x: number, y: number): boolean {
  const terrain = world.getResource(TerrainRes); if (!terrain) return true;
  return !terrainBlocksWalker(world, Math.floor(x), Math.floor(y)); // ADR-181: shallow water is walkable
}
function compositionKinds(world: World): { kinds: number[]; weights: number[] } {
  const defs = gameplayDefs(world); const kinds: number[] = [], weights: number[] = [];
  for (const [k, w] of Object.entries(HORDES.composition)) { try { kinds.push(defs.zombieId(k)); weights.push(w); } catch { /* unknown kind */ } }
  return { kinds, weights };
}
/** ADR-476: ticks in a siege — siegeMinutes in-game minutes (dayLengthTicks per game day; 30 min
 * default). No clock (dayLengthTicks 0) falls back to real-time minutes at 20 ticks/s. */
export function siegeTicks(world: World): number {
  const len = world.env(TimeOfDayLike).dayLengthTicks;
  return len > 0 ? Math.max(1, Math.round((len * HORDES.siegeMinutes) / (24 * 60))) : HORDES.siegeMinutes * 60 * 20;
}
/** ADR-476: a horde hears what a walker would hear — 1 tile of radius per noise level
 * (zombie_walker hearingMul 1.0, the baseline; runners hear further, brutes less). */
export const HORDE_HEARING_TILES_PER_LEVEL = 1;
/** Centroid of a horde's living members (undefined when none are left). */
function hordeCentroid(world: World, h: Horde): { x: number; y: number } | undefined {
  let x = 0, y = 0, n = 0;
  for (const z of h.members) {
    if (!world.isAlive(z)) continue;
    const t = world.get(z, Transform); if (!t) continue;
    x += t.x; y += t.y; n++;
  }
  return n ? { x: x / n, y: y / n } : undefined;
}
/** Point every member of a horde at one piece (and set their siege clock). The director calls this
 * for the noise re-target and the light-seek re-target; spawnHorde does its own member setup. */
function setHordeMembersTarget(world: World, h: Horde, target: Entity, tx: number, ty: number, siegeUntil: number): void {
  for (const z of [...h.members]) {
    if (!world.isAlive(z) || !world.has(z, HordeMember)) continue;
    world.set(z, HordeMember, { target, tx, ty, siegeUntil });
    world.setField(z, ZombieBrain, "goalX", tx); world.setField(z, ZombieBrain, "goalY", ty);
    world.setField(z, ZombieBrain, "state", ZState.Chase);
  }
}
/** ADR-476: re-target a horde to a structure group (the base near a loud noise) and start a siege.
 * The target piece is the one nearest the noise, not the group centroid — the horde marches on
 * where the noise came from. */
function retargetHorde(world: World, h: Horde, t: HordeTarget, loud: { x: number; y: number }): void {
  const piece = t.pieces.reduce((best, e) => { const a = world.get(e, Transform)!, b = world.get(best, Transform)!; return Math.hypot(a.x - loud.x, a.y - loud.y) < Math.hypot(b.x - loud.x, b.y - loud.y) ? e : best; }, t.pieces[0]!);
  const pt = world.get(piece, Transform)!;
  const until = world.tick + siegeTicks(world);
  h.key = t.key; h.kind = t.kind; h.owner = t.owner; h.tx = pt.x; h.ty = pt.y; h.target = piece; h.siegeUntil = until;
  setHordeMembersTarget(world, h, piece, pt.x, pt.y, until);
}
/** Spawns a horde of `size` toward target group t. Returns the horde id (0 when nothing could spawn). */
export function spawnHorde(world: World, t: HordeTarget, size: number): number {
  const rt = hordeRuntime(world); const rng = world.rngFor("horde", rt.nextId);
  const target = t.pieces.reduce((best, e) => { const a = world.get(e, Transform)!, b = world.get(best, Transform)!; return Math.hypot(a.x - t.x, a.y - t.y) < Math.hypot(b.x - t.x, b.y - t.y) ? e : best; }, t.pieces[0]!);
  let cx = t.x, cy = t.y, ok = false;
  for (let i = 0; i < 12 && !ok; i++) {
    const a = rng.range(0, Math.PI * 2), r = rng.range(HORDES.spawnRingMin, HORDES.spawnRingMax);
    cx = t.x + Math.cos(a) * r; cy = t.y + Math.sin(a) * r; ok = walkable(world, cx, cy);
  }
  if (!ok) return 0;
  const { kinds, weights } = compositionKinds(world); if (!kinds.length) return 0;
  const total = weights.reduce((a, b) => a + b, 0); const id = rt.nextId++; const members = new Set<Entity>();
  const tt = world.get(target, Transform)!;
  for (let n = 0; n < size; n++) {
    let roll = rng.range(0, total), kind = kinds[0]!; for (let i = 0; i < kinds.length; i++) { roll -= weights[i]!; if (roll <= 0) { kind = kinds[i]!; break; } }
    const x = cx + rng.range(-3, 3), y = cy + rng.range(-3, 3); if (!walkable(world, x, y)) continue;
    const z = spawnZombie(world, gateZombieKind(world, kind, tt.x, tt.y), x, y, 0); // ADR-226: gated kinds by the target's nearby players
    world.add(z, HordeMember, { horde: id & 0xffff, target, tx: tt.x, ty: tt.y });
    world.setField(z, ZombieBrain, "goalX", tt.x); world.setField(z, ZombieBrain, "goalY", tt.y); world.setField(z, ZombieBrain, "state", ZState.Chase);
    members.add(z);
  }
  if (!members.size) return 0;
  rt.hordes.set(id, { id, kind: t.kind, owner: t.owner, key: t.key, members, tx: tt.x, ty: tt.y, target, siegeUntil: 0 });
  return id;
}
const aliveIn = (world: World, h: Horde): number => { for (const z of [...h.members]) if (!world.isAlive(z) || world.has(z, Dead) || !world.has(z, HordeMember)) h.members.delete(z); return h.members.size; };

/** Server director (every HORDES_EVERY ticks). */
export function hordeDirectorSystem(world: World, dt = 1 / 20): void {
  if (!isAuthority(world) || world.isReplaying) return;
  const rules = worldRules(world); const rt = hordeRuntime(world);
  // bookkeeping
  let alive = 0;
  for (const h of [...rt.hordes.values()]) { const n = aliveIn(world, h); alive += n; if (n === 0) rt.hordes.delete(h.id); }
  const st = status(world);
  if (st && st.phase === HordePhase.Active) {
    const cur = [...rt.hordes.values()].reduce((s, h) => s + h.members.size, 0);
    if (rt.hordes.size === 0) setStatus(world, { phase: HordePhase.Idle, alive: 0 }); else if (st.alive !== cur) setStatus(world, { alive: cur });
  }
  if (!rules.hordes) { rt.pending = undefined; if (st && st.phase === HordePhase.Warning) setStatus(world, { phase: HordePhase.Idle }); return; }
  const len = world.env(TimeOfDayLike).dayLengthTicks; if (len <= 0) return;
  if (rt.nextTick === 0) rt.nextTick = world.tick + Math.round(len * HORDES.intervalDays * 0.5);
  // ADR-476: hordes hunt by sound, then by lamplight. The director reads the last loud survivor
  // noise (recorded by makeNoise — the noise system has no event log) and re-targets the nearest
  // horde that can hear it to the nearest base near the noise; that horde then sieges for
  // siegeMinutes. A horde already sieging that base just refreshes its siege clock, and a sieging
  // horde is never pulled away to another noise. Loud in the open (no base within noiseTargetRadius)
  // draws no horde — the individuals still investigate by their own hearing, unchanged.
  const loud = lastLoudNoise(world);
  if (loud && loud.level >= HORDES.noiseMin) {
    const targets = hordeTargets(world);
    let best: HordeTarget | undefined; let bd = HORDES.noiseTargetRadius;
    for (const t of targets) { const d = Math.hypot(t.x - loud.x, t.y - loud.y); if (d <= bd) { bd = d; best = t; } }
    if (best) {
      const sieging = [...rt.hordes.values()].find((h) => h.key === best!.key && h.siegeUntil > world.tick);
      if (sieging) {
        sieging.siegeUntil = world.tick + siegeTicks(world);
        for (const z of sieging.members) if (world.isAlive(z) && world.has(z, HordeMember)) world.setField(z, HordeMember, "siegeUntil", sieging.siegeUntil);
      } else {
        let nearest: Horde | undefined; let nd = Infinity;
        for (const h of rt.hordes.values()) {
          if (h.siegeUntil > world.tick) continue;
          const c = hordeCentroid(world, h); if (!c) continue;
          const d = Math.hypot(c.x - loud.x, c.y - loud.y);
          if (d <= loud.level * HORDE_HEARING_TILES_PER_LEVEL && d < nd) { nd = d; nearest = h; }
        }
        if (nearest) retargetHorde(world, nearest, best, loud);
      }
    }
  }
  // ADR-476 lamplight (Tracey's decision: IN, but only for hordes already in siege mode, within
  // lightSeekTiles of their target, exempt from shyGoal while sieging — see combat/zombies.ts).
  // The director re-targets the siege to the piece the nearest light is on; hordeSteer then drives
  // the members to it and attacks it through the existing structure-attack path. The re-target is
  // self-stabilising: once the target IS a light's piece, the nearest light to it is itself.
  for (const h of rt.hordes.values()) {
    if (h.siegeUntil <= world.tick) continue;
    const nl = nearestLight(world, h.tx, h.ty, HORDES.lightSeekTiles);
    if (!nl) continue;
    const piece = pieceOf(world, nl.e) ?? (world.has(nl.e, BuildPiece) ? nl.e : undefined);
    if (!piece || piece === h.target) continue;
    const pt = world.get(piece, Transform); if (!pt) continue;
    h.tx = pt.x; h.ty = pt.y; h.target = piece;
    setHordeMembersTarget(world, h, piece, pt.x, pt.y, h.siegeUntil);
  }
  // warning elapsed -> spawn
  if (rt.pending && world.tick >= rt.pending.at) {
    const p = rt.pending; rt.pending = undefined;
    const size = Math.min(p.size, HORDES.maxHordeZombies - alive);
    const id = size >= 2 ? spawnHorde(world, p.t, size) : 0;
    if (id) { rt.lastHit.set(p.t.key, world.tick); setStatus(world, { phase: HordePhase.Active, size: rt.hordes.get(id)!.members.size, alive: alive + rt.hordes.get(id)!.members.size }); }
    else setStatus(world, { phase: rt.hordes.size ? HordePhase.Active : HordePhase.Idle });
    return;
  }
  if (rt.pending || world.tick < rt.nextTick || rt.hordes.size >= HORDES.maxActiveHordes || alive >= HORDES.maxHordeZombies - 2) return;
  if (!HORDES.phases.includes(currentPhaseKey(world))) return;
  const days = worldDays(world); if (days < rules.hordeGraceDays) return;
  const eligible = hordeTargets(world).filter((t) => days >= graceFor(rules.hordeGraceDays, t.level) && ![...rt.hordes.values()].some((h) => h.key === t.key));
  if (!eligible.length) return;
  eligible.sort((a, b) => (rt.lastHit.get(a.key) ?? -1) - (rt.lastHit.get(b.key) ?? -1) || (a.key < b.key ? -1 : 1));
  const t = eligible[0]!;
  const size = Math.min(hordeSize({ clan: t.kind === HordeKind.Clan, members: t.members, level: t.level, daysPastGrace: days - graceFor(rules.hordeGraceDays, t.level) }), HORDES.maxHordeZombies - alive);
  const at = world.tick + Math.max(1, secondsToTicks(HORDES.warnSeconds, dt));
  rt.pending = { at, t, size }; rt.nextTick = world.tick + Math.round(len * HORDES.intervalDays);
  setStatus(world, { phase: HordePhase.Warning, seq: ((st?.seq ?? 0) + 1) & 0xffff, kind: t.kind, size, alive: 0, x: t.x, y: t.y, owner: t.owner, nextTick: at });
}
/** Test/dev hook: start a horde against target `t` immediately (no warning). */
export function forceHorde(world: World, t: HordeTarget, size?: number): number {
  const n = size ?? hordeSize({ clan: t.kind === HordeKind.Clan, members: t.members, level: t.level });
  const id = spawnHorde(world, t, n);
  if (id) { const st = status(world); setStatus(world, { phase: HordePhase.Active, seq: ((st?.seq ?? 0) + 1) & 0xffff, kind: t.kind, size: n, alive: hordeRuntime(world).hordes.get(id)!.members.size, x: t.x, y: t.y, owner: t.owner }); }
  return id;
}
export const _hordeInternal = { Zombie };
