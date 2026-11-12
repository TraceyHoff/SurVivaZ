/**
 * Zombies (authority only; clients see Transform/Zombie/AnimState/Health by replication).
 *
 * Spawner (slow system, every spawning.checkSeconds): per living player, rate by day phase (ratePerMinute) x
 * (1 + noiseRateMul x noise/10), capped by cap[phase] zombies within capRadius; spawn ring minDistance..maxDistance
 * on walkable, unbuilt tiles; kind by phase weights. world.rng (server).
 *
 * AI (every tick, thinking every ai.thinkTicks staggered by entity): Wander -> Investigate (heard noise) ->
 * Chase (sighted player) -> AttackPlayer (in range) / AttackStructure (path blocked by a wall/door: blockPiece).
 * Paths come from combat/path.ts (A* with break costs); repath every ai.repathTicks. ADR-194: no sunlight damage; by day
 * a non-horde zombie is calm (wanders, seeks / attacks no one) unless it was hit, then it retaliates against that attacker.
 * It turns aggressive at dusk and calm at dawn, staggered per zombie (zombieAggressive). Far zombies despawn.
 */
import { isCrouched, STANCE } from "../stance.js";
import { entityIndex, NetId, Transform, timeOfDay, sunFractionOf, type Entity, type World } from "@engine/core";
import { installSpatialIndex } from "@engine/world";
import { Anim, AnimState, Attacker, BodyTemp, Dead, Exposure, Health, NoiseLevel, Survival, Zombie, ZombieBrain, ZState } from "../components.js";
import { gameplayDefs, isAuthority } from "../config.js";
import { secondsToTicks, type AiTuning, type ZombieDef } from "../defs.js";
import { DayPhase, emit, ZombieSpawned, ZombieStateChanged } from "../events.js";
import { indexEntity } from "../spawn.js";
import { defineResource } from "@engine/core";
/** Set (true) when the population spawner owns zombie spawning; the legacy per-player spawner then stands down. */
export const PopulationZombies = defineResource<boolean>("gameplay.PopulationZombies");
import { dayPhase } from "../systems/environment.js";
import { makeNoise } from "../systems/noise.js";
import { structures } from "../building/structure.js";
import { TerrainRes } from "../world.js";
import { bodyAxisMove, settleStandZ, swimSpeedMulAt, terrainBlocksWalker } from "../systems/movement.js";
import { applyDamage, lastAttacker, setAnim } from "./combat.js";
import { findPath, pieceHp } from "./path.js";
import { lightAt, lightGrid, nearestLight, type ActiveLight } from "../systems/lights.js";
import { snuffFire } from "../systems/fuel.js";
import { attachmentsOf, pieceOf } from "../building/links.js";
import { damagePiece } from "../building/integrity.js";
import { BuildPiece, Fuel, HordeMember } from "../components.js";
import { gateZombieKind } from "./zombie_gate.js";
import { inSpawnSafeRadius } from "../spawn_points.js";

const PHASE_KEY = { [DayPhase.Night]: "night", [DayPhase.Dawn]: "dawn", [DayPhase.Day]: "day", [DayPhase.Dusk]: "dusk" } as const;
export const currentPhaseKey = (world: World): "night" | "dawn" | "day" | "dusk" => PHASE_KEY[dayPhase(sunFractionOf(timeOfDay(world)))];

/** Paths (sim-local, server). */
const paths = new WeakMap<World, Map<Entity, { tiles: [number, number][]; i: number }>>();
const pathsOf = (w: World): Map<Entity, { tiles: [number, number][]; i: number }> => { let m = paths.get(w); if (!m) paths.set(w, (m = new Map())); return m; };

export function spawnZombie(world: World, kind: number | string, x: number, y: number, variant = 0): Entity {
  const defs = gameplayDefs(world); const id = typeof kind === "string" ? defs.zombieId(kind) : kind;
  const def = defs.zombies.get(id); if (!def) throw new Error(`unknown zombie ${kind}`);
  const e = world.create();
  world.add(e, Transform, { x, y }).add(e, Health, { hp: def.hp, max: def.hp }).add(e, Zombie, { kind: id, variant: variant % def.variants })
    .add(e, ZombieBrain, { state: ZState.Wander, homeX: x, homeY: y, thinkAt: world.tick + (e % defs.ai.thinkTicks) })
    .add(e, AnimState, { anim: Anim.Idle, startTick: world.tick }).add(e, Attacker).add(e, Exposure).add(e, BodyTemp);
  indexEntity(world, e);
  emit(world, ZombieSpawned, { zombie: e, kind: id });
  return e;
}

export function zombieSpawnerSystem(world: World, dt: number): void {
  if (!isAuthority(world) || world.isReplaying) return;
  if (world.getResource(PopulationZombies)) return; // a PopulationSpawner owns zombie spawning
  const defs = gameplayDefs(world); const sp = defs.spawning; const ph = currentPhaseKey(world);
  const index = installSpatialIndex(world); const terrain = world.getResource(TerrainRes); const idx = structures(world);
  const players = [...world.query([Survival, Transform], [Dead])].sort((a, b) => a - b);
  for (const p of players) {
    const t = world.get(p, Transform)!;
    const noise = world.getField(p, NoiseLevel, "value") ?? 0;
    const rate = sp.ratePerMinute[ph] * (1 + sp.noiseRateMul * noise / 10);
    if (world.rng.next() >= rate * dt / 60) continue;
    let near = 0; for (const z of index.queryRadius(t.x, t.y, sp.capRadius)) if (world.has(z, Zombie) && !world.has(z, Dead)) near++;
    if (near >= sp.cap[ph]) continue;
    for (let attempt = 0; attempt < 6; attempt++) {
      const a = world.rng.range(-Math.PI, Math.PI); const d = world.rng.range(sp.minDistance, sp.maxDistance);
      const x = t.x + Math.cos(a) * d, y = t.y + Math.sin(a) * d; const tx = Math.floor(x), ty = Math.floor(y);
      if (inSpawnSafeRadius(world, x, y)) continue; // Task 33: no zombie spawns inside the safe radius around spawn points
      if (terrain && defs.worldgen.unwalkableTiles.has(terrain.tileAt(tx, ty)) && terrainBlocksWalker(world, tx, ty)) continue;
      if (idx.deck(tx, ty, 0)) continue;
      const k0 = pickWeighted(world, sp.weights[ph], defs.zombieKinds); if (k0 === undefined) break;
      const kind = gateZombieKind(world, k0, tx + 0.5, ty + 0.5); // ADR-226
      spawnZombie(world, kind, tx + 0.5, ty + 0.5, world.rng.int(0, 255));
      break;
    }
  }
}
function pickWeighted(world: World, weights: readonly number[], kinds: readonly number[]): number | undefined {
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0); if (total <= 0) return undefined;
  let r = world.rng.next() * total; for (let i = 0; i < weights.length; i++) { r -= Math.max(0, weights[i]!); if (r < 0) return kinds[i]; }
  return kinds[kinds.length - 1];
}

function setState(world: World, z: Entity, state: ZState): void {
  if (world.getField(z, ZombieBrain, "state") === state) return;
  world.set(z, ZombieBrain, { state, stateTick: world.tick }); emit(world, ZombieStateChanged, { zombie: z, state });
}
const dist = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(ax - bx, ay - by);

/**
 * Nearest living player seen (sight range) or heard (noise x hearing) from (x,y).
 * Task 29: scans the small living-survivors list (built once per system run) instead of a
 * spatial radius query over every piece/animal/node in the village (~186us -> ~1us per call).
 * Identical results: the old radius R = max(sightRange, 24) admitted nobody beyond the
 * seen/heard ranges (sight <= 18, heard <= ~16), and the Dead check is kept so a player who
 * dies mid-run is still excluded for later zombies in the same tick.
 */
function acquire(world: World, z: Entity, x: number, y: number, def: ZombieDef, survivors: readonly Entity[], dt: number, ai: AiTuning): { e: Entity; seen: boolean } | undefined {
  const la = lastAttacker(world, z);
  const retaliateTicks = secondsToTicks(ai.retaliateSeconds, dt);
  let best: { e: Entity; seen: boolean; d: number } | undefined;
  for (const p of survivors) {
    if (world.has(p, Dead)) continue;
    const t = world.get(p, Transform)!; const d = dist(x, y, t.x, t.y);
    // Task 33: survivors inside a spawn safe radius are not targets — except a recent attacker
    // (retaliation still re-engages, so the zone is not a free shooting gallery) and except horde
    // members: a player-triggered raid is a deliberate attack, not ambient danger, so it is out of
    // scope for the safe radius and must still reach its target.
    const recentAttacker = la !== undefined && la.e === p && world.tick - la.tick <= retaliateTicks;
    if (!recentAttacker && !world.has(z, HordeMember) && inSpawnSafeRadius(world, t.x, t.y)) continue;
    const seen = d <= def.sightRange * (isCrouched(world, p) ? STANCE.crouchSightMul : 1); const heard = d <= (world.getField(p, NoiseLevel, "value") ?? 0) * def.hearingMul;
    if (!seen && !heard) continue;
    if (!best || d < best.d || (d === best.d && p < best.e)) best = { e: p, seen, d };
  }
  return best && { e: best.e, seen: best.seen };
}

/**
 * ADR-194 day/night temperament. Aggressive from ai.aggroStartT (dusk) until ai.aggroEndT (dawn), each zombie shifted
 * by a stable 0..ai.aggroStaggerT offset (NetId hash) so a crowd wakes / settles over time instead of all at once.
 * No clock (dayLengthTicks 0) reads t = 0: night, aggressive. Horde members ignore this (always aggressive).
 */
export function zombieAggressive(world: World, z: Entity, t = sunFractionOf(timeOfDay(world))): boolean {
  if (world.has(z, HordeMember)) return true;
  const ai = gameplayDefs(world).ai; const id = (world.getField(z, NetId, "id") ?? z) >>> 0;
  const o = (((Math.imul(id ^ 0x9e3779b9, 0x85ebca6b) >>> 0) % 1000) / 1000) * ai.aggroStaggerT;
  return t >= ai.aggroStartT + o || t < ai.aggroEndT - o;
}
/** ADR-194: a calm zombie's target — the last living attacker within ai.retaliateSeconds and loseTargetMul x sight. */
function provoker(world: World, z: Entity, x: number, y: number, def: ZombieDef, dt: number): { e: Entity; seen: boolean } | undefined {
  const h = lastAttacker(world, z); const ai = gameplayDefs(world).ai;
  if (!h || world.tick - h.tick > secondsToTicks(ai.retaliateSeconds, dt) || !world.isAlive(h.e) || world.has(h.e, Dead) || world.has(h.e, Zombie)) return undefined;
  const t = world.get(h.e, Transform); if (!t || dist(x, y, t.x, t.y) > def.sightRange * ai.loseTargetMul) return undefined;
  return { e: h.e, seen: true };
}

/** ADR-108 Snuffer targets: zombie -> light entity it is going for (sim-local, server). */
const snuffs = new WeakMap<World, Map<Entity, Entity>>();
const snuffsOf = (w: World): Map<Entity, Entity> => { let m = snuffs.get(w); if (!m) snuffs.set(w, (m = new Map())); return m; };
/** Task 15: chase give-ups — zombie -> tick until which it will not re-acquire (retaliation still re-engages). */
const giveUps = new WeakMap<World, Map<Entity, number>>();
const giveUpsOf = (w: World): Map<Entity, number> => { let m = giveUps.get(w); if (!m) giveUps.set(w, (m = new Map())); return m; };
const GIVE_UP_SECONDS = 10;
/** Light-shy zombies are active in lightAvoid.phases (night, dusk by default). */
export const lightAvoidActive = (world: World): boolean => gameplayDefs(world).lightAvoid.phases.includes(currentPhaseKey(world));
/** The Snuffer a zombie entity is chasing a light for, if any (render / tests). */
export const snuffTargetOf = (world: World, z: Entity): Entity | undefined => snuffs.get(world)?.get(z);

export function zombieAISystem(world: World, dt: number): void {
  if (!isAuthority(world)) return;
  const defs = gameplayDefs(world); const ai = defs.ai; const tf = world.store(Transform); const br = world.store(ZombieBrain);
  const ps = pathsOf(world); const phase = currentPhaseKey(world); const todT = sunFractionOf(timeOfDay(world));
  const avoid = defs.lightAvoid.phases.includes(phase); const sn = snuffsOf(world);
  // Task 29: living survivors with Transform, sorted for deterministic tie-breaks; rebuilt per
  // tick (cheap: players are few) and shared by acquire + the despawn check below. Guarded: worlds
  // without Survival registered (minimal/persist worlds) previously never reached a survivor query
  // without zombies to think, so an empty list — not a throw — is the faithful answer there.
  const survivors: Entity[] = world.isRegistered(Survival) ? [...world.query([Survival, Transform], [Dead])].sort((a, b) => a - b) : [];
  if (avoid) lightGrid(world);
  const breakTicks = (piece: Entity): number => pieceHp(world, piece) / 10;
  for (const z of world.query([Zombie, ZombieBrain, Transform, Health], [Dead])) {
    const idx = entityIndex(z); const s = br.slot(idx); const ts = tf.slot(idx);
    const def = defs.zombies.get(world.getField(z, Zombie, "kind")!)!;
    const x = tf.data.x[ts]!, y = tf.data.y[ts]!;
    // think
    if (world.tick >= br.data.thinkAt[s]!) {
      br.data.thinkAt[s] = world.tick + ai.thinkTicks; br.markChanged(idx);
      // despawn when no player is near (Task 29: same survivors list as acquire, squared distance)
      let anyNear = false; const r2 = ai.despawnDistance * ai.despawnDistance;
      for (const p of survivors) { if (world.has(p, Dead)) continue; const t = world.get(p, Transform)!; const dx = t.x - x, dy = t.y - y; if (dx * dx + dy * dy <= r2) { anyNear = true; break; } }
      const horde = world.has(z, HordeMember); // ADR-121: horde members roam far from players
      if (!anyNear && !horde && !world.isReplaying) { ps.delete(z); world.destroy(z); continue; }
      const state = br.data.state[s]! as ZState; const target = br.data.target[s]!;
      const aggr = horde || zombieAggressive(world, z, todT);
      let tgt = aggr ? acquire(world, z, x, y, def, survivors, dt, ai) : provoker(world, z, x, y, def, dt);
      // Task 15: a zombie that just gave up a chase does not instantly re-acquire the same player next think
      // (they are usually still in sight). Retaliation still breaks the cooldown: hitting the zombie re-engages it.
      const gu = giveUpsOf(world).get(z);
      if (gu !== undefined && world.tick < gu && tgt) {
        const la = lastAttacker(world, z);
        if (!(la && la.e === tgt.e && world.tick - la.tick <= secondsToTicks(ai.retaliateSeconds, dt))) tgt = undefined;
      }
      if (!aggr && !tgt && (state === ZState.Chase || state === ZState.AttackPlayer || state === ZState.Investigate)) setState(world, z, ZState.Wander);
      if (tgt) {
        br.data.target[s] = tgt.e; const tt = world.get(tgt.e, Transform)!;
        br.data.goalX[s] = tt.x; br.data.goalY[s] = tt.y;
        if (state !== ZState.AttackStructure) setState(world, z, tgt.seen ? ZState.Chase : ZState.Investigate);
        if (tgt.seen && dist(x, y, tt.x, tt.y) <= def.attackRange && state !== ZState.AttackStructure) setState(world, z, ZState.AttackPlayer);
      } else if (state === ZState.Chase || state === ZState.AttackPlayer) {
        const valid = world.isAlive(target) && !world.has(target, Dead);
        const tt = valid ? world.get(target, Transform) : undefined;
        if (!tt || dist(x, y, tt.x, tt.y) > def.sightRange * ai.loseTargetMul) setState(world, z, ZState.Investigate);
      } else if (state === ZState.Investigate && world.tick > br.data.stateTick[s]! + secondsToTicks(ai.investigateSeconds, dt)) {
        setState(world, z, ZState.Wander);
      }
      // ADR-121 horde: with no player in sight, march on the target structure (retarget nearby pieces when it falls)
      if (horde && !tgt?.seen) hordeSteer(world, z, x, y, s, def);
      // ADR-108 Snuffer: at night go for the nearest active light unless a player is already in reach
      if (def.light?.targetsLights && avoid && !(tgt?.seen && br.data.state[s] === ZState.AttackPlayer)) {
        const nl = nearestLight(world, x, y, def.light.seekRange);
        if (nl) { sn.set(z, nl.e); br.data.goalX[s] = nl.x; br.data.goalY[s] = nl.y; if (br.data.state[s] !== ZState.AttackStructure) setState(world, z, ZState.Chase); }
        else sn.delete(z);
      } else sn.delete(z);
      // Task 15: chase limit — a zombie chasing a living player farther than chaseLimitTiles from its spawn
      // anchor gives up and wanders home. Exempt: horde members (structure march), light chasing (sn), and
      // structure attacks (state AttackStructure is not a player chase). Disengage happens at think cadence
      // only, and a swing due this tick still lands in the act phase below (attacks are instant, so there is
      // no wind-up to cut short — the zombie finishes its due hit, then gives up on the next think).
      const st1 = br.data.state[s]! as ZState;
      if (!horde && !sn.has(z) && (st1 === ZState.Chase || st1 === ZState.AttackPlayer)) {
        const ct2 = br.data.target[s]!;
        const chaseLimit = ai.chaseLimitTiles ?? 20;
        if (world.isAlive(ct2) && !world.has(ct2, Dead) && world.has(ct2, Survival)) {
          const homeD = dist(x, y, br.data.homeX[s]!, br.data.homeY[s]!);
          const ctt = world.get(ct2, Transform);
          const swingDue = st1 === ZState.AttackPlayer && !!ctt && dist(x, y, ctt.x, ctt.y) <= def.attackRange + 0.3 && world.tick >= br.data.attackAt[s]!;
          if (homeD > chaseLimit && !swingDue) {
            setState(world, z, ZState.Wander); br.data.target[s] = 0; br.data.repathAt[s] = 0;
            giveUpsOf(world).set(z, world.tick + secondsToTicks(GIVE_UP_SECONDS, dt));
          }
        }
      }
      const st2 = br.data.state[s]! as ZState;
      if (st2 === ZState.Wander && (!ps.has(z) || world.tick >= br.data.repathAt[s]!)) {
        const rng = world.rngFor("zwander", world.getField(z, NetId, "id") ?? z);
        br.data.goalX[s] = br.data.homeX[s]! + rng.range(-ai.wanderRadius, ai.wanderRadius);
        br.data.goalY[s] = br.data.homeY[s]! + rng.range(-ai.wanderRadius, ai.wanderRadius);
        br.data.repathAt[s] = 0;
      }
      if (st2 !== ZState.AttackPlayer && (world.tick >= br.data.repathAt[s]! || !ps.has(z))) {
        br.data.repathAt[s] = world.tick + ai.repathTicks;
        const p = findPath(world, Math.floor(x), Math.floor(y), Math.floor(br.data.goalX[s]!), Math.floor(br.data.goalY[s]!), breakTicks);
        if (p) {
          ps.set(z, { tiles: p.tiles, i: 1 });
          // blocked right ahead? (next step crosses a wall/door)
          if (p.blocker && p.blockerIndex <= 1) { br.data.blockPiece[s] = p.blocker; setState(world, z, ZState.AttackStructure); }
          else if (br.data.state[s] === ZState.AttackStructure && !p.blocker) setState(world, z, ZState.Chase);
          if (p.blocker && p.blockerIndex > 1) br.data.blockPiece[s] = p.blocker;
        }
      }
    }
    const state = br.data.state[s]! as ZState;
    // act
    const lt = sn.get(z);
    if (lt !== undefined && state !== ZState.AttackStructure) {
      const L = lightGrid(world).lights.find((l) => l.e === lt);
      if (!L) { sn.delete(z); br.data.repathAt[s] = 0; }
      else if (dist(x, y, L.x, L.y) <= def.attackRange + 0.7) {
        if (world.tick >= br.data.attackAt[s]!) {
          br.data.attackAt[s] = world.tick + secondsToTicks(def.attackCooldownSeconds, dt); br.markChanged(idx);
          setAnim(world, z, Anim.Attack); snuffLight(world, z, L, def);
        }
        continue;
      }
    }
    if (state === ZState.AttackPlayer || state === ZState.AttackStructure) {
      const tgt = state === ZState.AttackPlayer ? br.data.target[s]! : br.data.blockPiece[s]!;
      if (!world.isAlive(tgt) || world.has(tgt, Dead)) { setState(world, z, ZState.Chase); br.data.repathAt[s] = 0; continue; }
      const tt = world.get(tgt, Transform)!; const reach = def.attackRange + (state === ZState.AttackStructure ? 0.7 : 0.3);
      if (dist(x, y, tt.x, tt.y) > reach) {
        if (state === ZState.AttackPlayer) { setState(world, z, ZState.Chase); continue; }
        const step0 = def.speed * swimSpeedMulAt(world, x, y) * dt;
        const g0 = avoid && !def.light?.ignoresLight ? shyGoal(world, z, x, y, tt.x, tt.y, step0) : undefined;
        moveToward(world, z, g0 ? g0[0] : tt.x, g0 ? g0[1] : tt.y, step0, ts);
        continue;
      }
      if (world.tick >= br.data.attackAt[s]!) {
        br.data.attackAt[s] = world.tick + secondsToTicks(def.attackCooldownSeconds, dt); br.markChanged(idx);
        setAnim(world, z, Anim.Attack);
        if (state === ZState.AttackPlayer) applyDamage(world, tgt, def.damage, z);
        else { applyDamage(world, tgt, def.structureDamage, z); makeNoise(world, z, defs.noise.structureHit); }
      }
      continue;
    }
    const path = ps.get(z);
    if (path && path.i < path.tiles.length) {
      const [px, py] = path.tiles[path.i]!; const gx = px + 0.5, gy = py + 0.5;
      const [cx, cy] = path.tiles[path.i - 1]!;
      // never walk through a blocker: if the next step is blocked, attack it
      const blocked = structures(world).count ? stepBlockerCached(world, cx, cy, px, py) : 0;
      if (blocked) { br.data.blockPiece[s] = blocked; setState(world, z, ZState.AttackStructure); continue; }
      const step = def.speed * (state === ZState.Wander ? 0.5 : 1) * swimSpeedMulAt(world, x, y) * dt;
      const shy = avoid && !def.light?.ignoresLight ? shyGoal(world, z, x, y, gx, gy, step) : undefined;
      if (shy) { moveToward(world, z, shy[0], shy[1], step, ts); setAnim(world, z, Anim.Walk); continue; }
      if (moveToward(world, z, gx, gy, step, ts)) path.i++;
      setAnim(world, z, state === ZState.Wander ? Anim.Walk : Anim.Run);
    } else {
      const shy = avoid && !def.light?.ignoresLight ? shyGoal(world, z, x, y, x, y, def.speed * dt) : undefined;
      if (shy) { moveToward(world, z, shy[0], shy[1], def.speed * dt, ts); setAnim(world, z, Anim.Walk); } else setAnim(world, z, Anim.Idle);
    }
  }
  // ADR-368: delete during Map iteration (safe in JS) instead of spreading every key into a fresh array per tick.
  for (const z of ps.keys()) if (!world.isAlive(z) || world.has(z, Dead)) ps.delete(z);
  for (const z of sn.keys()) if (!world.isAlive(z) || world.has(z, Dead)) sn.delete(z);
}

/**
 * ADR-108 light avoidance: undefined = the move is fine. Inside a lit radius -> head straight out to its edge; about to
 * step into one -> pace along the dark edge (tangent; direction flips every lightAvoid.paceSeconds, staggered per zombie).
 */
export function shyGoal(world: World, z: Entity, x: number, y: number, gx: number, gy: number, step: number): [number, number] | undefined {
  const la = gameplayDefs(world).lightAvoid; const m = la.edgeMargin;
  const inside = lightAt(world, x, y, 0);
  if (inside) { const d = Math.hypot(x - inside.x, y - inside.y) || 1e-3; const R = inside.r + m + 0.05; return [inside.x + ((x - inside.x) / d) * R, inside.y + ((y - inside.y) / d) * R]; }
  const dx = gx - x, dy = gy - y; const d = Math.hypot(dx, dy); const look = Math.max(step, 0.5);
  const nx = d > 1e-6 ? x + (dx / d) * Math.min(look, d) : x, ny = d > 1e-6 ? y + (dy / d) * Math.min(look, d) : y;
  const L = lightAt(world, nx, ny, m); if (!L) return undefined;
  if (d > 1e-6 && Math.hypot(nx - L.x, ny - L.y) >= Math.hypot(x - L.x, y - L.y)) return undefined; // moving away: fine
  const period = Math.max(1, secondsToTicks(la.paceSeconds, 1 / 20));
  const dir = Math.floor((world.tick + (entityIndex(z) * 37)) / period) % 2 ? 1 : -1;
  const R = L.r + m + 0.05; const a = Math.atan2(y - L.y, x - L.x) + dir * Math.max(step, 0.05) * 4 / R;
  return [L.x + Math.cos(a) * R, L.y + Math.sin(a) * R];
}

/** Snuffer hit on a light: extinguish (extinguishChance) or damage the light's piece / vehicle. */
function snuffLight(world: World, z: Entity, L: ActiveLight, def: ZombieDef): void {
  const lt = def.light!; const piece = L.vehicle ? undefined : pieceOf(world, L.e) ?? (world.has(L.e, BuildPiece) ? L.e : undefined);
  const fire = piece !== undefined ? attachmentsOf(world, piece).find((a) => world.has(a, Fuel)) : world.has(L.e, Fuel) ? L.e : undefined;
  if (fire !== undefined && world.rngFor("snuffer", z).next() < lt.extinguishChance && snuffFire(world, fire, z)) return;
  if (piece !== undefined) damagePiece(world, piece, lt.snuffDamage, z);
  else if (world.has(L.e, Health)) applyDamage(world, L.e, lt.snuffDamage, z);
}
import { stepBlocker } from "./path.js";
import { StructureIndexRes } from "../building/structure.js";
function stepBlockerCached(world: World, x: number, y: number, nx: number, ny: number): Entity | 0 { return stepBlocker(world.getResource(StructureIndexRes), x, y, nx, ny); }

/** Moves toward (gx,gy) by up to `step`; returns true when arrived. */
function moveToward(world: World, e: Entity, gx: number, gy: number, step: number, ts: number): boolean {
  const tf = world.store(Transform); const x = tf.data.x[ts]!, y = tf.data.y[ts]!; const dx = gx - x, dy = gy - y; const d = Math.hypot(dx, dy);
  const arrive = d <= step || d === 0; let tx = arrive ? gx : x + (dx / d) * step, ty = arrive ? gy : y + (dy / d) * step;
  // ADR-212: zombies collide like walkers (body vs walls / closed doors / solid pieces); a blocked step is attacked via stepBlocker
  if (structures(world).count) { tx = bodyAxisMove(world, x, y, tx, 0, 0, false); ty = bodyAxisMove(world, tx, y, ty, 1, 0, false); }
  tf.data.x[ts] = tx; tf.data.y[ts] = ty; if (!arrive) tf.data.facing[ts] = Math.atan2(dy, dx); tf.markChanged(entityIndex(e));
  if (structures(world).count) settleStandZ(world, e, 1 / 20);
  return arrive && tx === gx && ty === gy;
}

/** ADR-121: drive a horde member toward / onto its target piece; disband (plain zombie) when nothing is left there. */
function hordeSteer(world: World, z: Entity, x: number, y: number, s: number, def: ZombieDef): void {
  const br = world.store(ZombieBrain); const hm = world.get(z, HordeMember)!;
  let target = hm.target as Entity;
  if (!world.isAlive(target) || !world.has(target, BuildPiece) || world.has(target, Dead)) {
    let best: Entity | 0 = 0, bd = 16;
    for (const e of installSpatialIndex(world).queryRadius(hm.tx, hm.ty, 16)) {
      if (!world.has(e, BuildPiece) || world.has(e, Dead)) continue;
      const t = world.get(e, Transform)!; const d = dist(x, y, t.x, t.y); if (d < bd) { bd = d; best = e; }
    }
    if (!best) { world.remove(z, HordeMember); return; }
    target = best; world.setField(z, HordeMember, "target", best);
  }
  const tt = world.get(target, Transform)!; const state = br.data.state[s]! as ZState;
  if (state === ZState.AttackStructure && world.isAlive(br.data.blockPiece[s]! as Entity)) return;
  br.data.goalX[s] = tt.x; br.data.goalY[s] = tt.y;
  if (dist(x, y, tt.x, tt.y) <= def.attackRange + 1.2) { br.data.blockPiece[s] = target; setState(world, z, ZState.AttackStructure); }
  else if (state === ZState.Wander || state === ZState.Investigate) { setState(world, z, ZState.Chase); br.data.target[s] = target; br.data.repathAt[s] = 0; }
}
