/**
 * Gameplay side of the ambient population: the spawn table (data/spawns.json via toSpawnEntries), animal defs (ai.json) + an
 * idle/wander/flee/attack AI with loot drops, and installPopulation(), which wires @engine/world's PopulationSpawner to gameplay rules
 * (walkable tiles, no structures, no land claims / safe zones). Authority only. Human bots are spawned through
 * a host callback (virtual players join through the normal client path; see agents.ts / docs/AI_AGENTS.md).
 */
import { LootSource, tagLootSource } from "./loot_labels.js";
import { lootBagInit } from "./loot_despawn.js";
import { Mount, Pet } from "./components.js";
import { luresMount, mountSpeciesOfAnimal } from "./mount_defs.js";
import { isTameableAnimalKey } from "./tameable_defs.js";
import { DEFAULT_TICK_HZ, Permissions, Transform, defineResource, entityIndex, type Entity, type World } from "@engine/core";
import { PopulationSpawner, type BuildingGrid, type ChunkKey, type PhaseKey, type PopulationHost, type SpawnEntry, type PopulationViewpoint } from "@engine/world";
import { Zombie } from "./components.js";
import { Anim, AnimState, Animal, Tamed, Container, ContainerViewers, Dead, Health, LootBag, RopeLead, Survival } from "./components.js";
import { gameplayDefs, isAuthority } from "./config.js";
import { indexEntity } from "./spawn.js";
import { currentPhaseKey, PopulationZombies, spawnZombie } from "./combat/zombies.js";
import { zombieKindAllowed } from "./combat/zombie_gate.js";
import { applyDamage, lastAttacker, setAnim } from "./combat/combat.js";
import { addItem } from "./inventory.js";
import { structures } from "./building/structure.js";
import { TerrainRes } from "./world.js";
import { swimSpeedMulAt, isDrawnDriven } from "./systems/movement.js";
import { creatureStep, type TileBlocked } from "./systems/creature_nav.js";
import { nearestClaimHostile, tamedOwnerTribe, TERRITORY_BITE, TERRITORY_DEFEND_RANGE } from "./territory.js";
import { installSpatialIndex } from "@engine/world";
import { populationData, resolveBehavior, toSpawnEntries, type AggroMode, type GameMode, type LootEntry } from "./ai/population.js";
import { inSpawnSafeRadius } from "./spawn_points.js";

/** Task 33: "aggressive" for the spawn safe radius — zombies plus animals whose ai.json aggro mode is hostile
 * (today: the wolf). Territorial / defensive animals only engage when provoked or approached, so they may spawn
 * near a spawn point; they still will not engage a survivor standing inside the radius (see animalAISystem).
 * ADR-354: tameable species never count as aggressive here either, whatever ai.json says — a tameable
 * animal must not count as a hostile anywhere (the animalAI initiation guard is the enforcement point). */
export function isAggressiveSpawnKind(kind: string, category: string): boolean {
  if (category === "zombie") return true;
  if (category !== "animal") return false;
  if (isTameableAnimalKey(kind)) return false;
  return animalDefs().find((a) => a.key === kind)?.aggro.mode === "hostile";
}

/** Animal def resolved from ai.json (kind "animal"); key = art key (animal_*), spawn rows in spawns.json. */
export interface AnimalDef {
  key: string; spriteKey: string; hp: number; speed: number; fleeSpeed: number; fleeRange: number; fleeHpFrac: number; wanderRadius: number;
  aggro: { mode: AggroMode; range: number; leashRange: number }; attack: { damage: number; range: number; cooldownSeconds: number } | null;
  loot: readonly LootEntry[]; drops: string[];
}
let animalsCache: AnimalDef[] | undefined;
export const animalDefs = (): readonly AnimalDef[] => (animalsCache ??= Object.entries(populationData().ai.archetypes)
  .filter(([, a]) => a.kind === "animal").map(([key]) => {
    const b = resolveBehavior(key);
    return { key, spriteKey: key, hp: b.hp, speed: b.speed * 0.45, fleeSpeed: b.speed, fleeRange: b.flee.range, fleeHpFrac: b.flee.hpFrac, wanderRadius: b.wander.radius,
      aggro: b.aggro, attack: b.attack, loot: b.loot, drops: b.loot.map((l) => l.item) };
  }));
export const animalKindOf = (key: string): number => { const i = animalDefs().findIndex((a) => a.key === key); if (i < 0) throw new Error(`unknown animal ${key}`); return i; };
/** Data-driven defaults (data/spawns.json). */
export const POPULATION_DATA = { get intervalSeconds(): number { return populationData().spawns.intervalSeconds; }, spawns: (mode: GameMode) => toSpawnEntries(mode) };

export const enum AnimalState { Idle = 0, Wander = 1, Flee = 2, Attack = 3, Dead = 4 }
/** Corpse lingers this long (death anim) before the animal entity is removed; loot stays in a LootBag. */
export const ANIMAL_CORPSE_SECONDS = 3;
export function spawnAnimal(world: World, kind: number | string, x: number, y: number): Entity {
  const k = typeof kind === "string" ? animalKindOf(kind) : kind; const def = animalDefs()[k]; if (!def) throw new Error(`unknown animal ${kind}`);
  const e = world.create();
  world.add(e, Transform, { x, y }).add(e, Health, { hp: def.hp, max: def.hp }).add(e, Animal, { kind: k, homeX: x, homeY: y, goalX: x, goalY: y, thinkAt: world.tick })
    .add(e, AnimState, { anim: Anim.Idle, startTick: world.tick });
  indexEntity(world, e); return e;
}
/** Roll an animal's loot (deterministic per entity) into an ownerless LootBag at its body. */
export function dropAnimalLoot(world: World, e: Entity): Entity | undefined {
  const a = world.get(e, Animal); const def = a && animalDefs()[a.kind]; const t = world.get(e, Transform); if (!def || !t) return undefined;
  const rng = world.rngFor("animal.loot", e); const defs = gameplayDefs(world);
  const rolled = def.loot.map((l) => ({ item: defs.itemId(l.item), n: rng.next() < l.chance ? rng.int(l.min, l.max + 1) : 0 })).filter((r) => r.n > 0);
  if (!rolled.length) return undefined;
  const bag = world.create();
  world.add(bag, Transform, { x: t.x, y: t.y, z: t.z }).add(bag, Container, { slotCount: Math.max(4, rolled.length) }).add(bag, ContainerViewers)
    .add(bag, LootBag, lootBagInit(world, 0, "creature", LootSource.Animal));
  for (const r of rolled) addItem(world, bag, r.item, r.n);
  tagLootSource(world, bag, LootSource.Animal); indexEntity(world, bag); return bag;
}

/** ADR-160: roll a dead zombie's ai.json archetype loot (the zombie def key) into an ownerless, hand-lootable LootBag. */
export function dropZombieLoot(world: World, e: Entity): Entity | undefined {
  const z = world.get(e, Zombie); const t = world.get(e, Transform); if (!z || !t) return undefined;
  const defs = gameplayDefs(world); const key = defs.zombies.get(z.kind)?.key; if (!key) return undefined;
  let loot: readonly { item: string; min: number; max: number; chance: number }[];
  try { loot = resolveBehavior(key).loot; } catch { return undefined; }
  const rng = world.rngFor("zombie.loot", e);
  const rolled = loot.map((l) => ({ item: defs.itemId(l.item), n: rng.next() < l.chance ? rng.int(l.min, l.max + 1) : 0 })).filter((r) => r.n > 0);
  if (!rolled.length) return undefined;
  const bag = world.create();
  world.add(bag, Transform, { x: t.x, y: t.y, z: t.z }).add(bag, Container, { slotCount: Math.max(4, rolled.length) }).add(bag, ContainerViewers)
    .add(bag, LootBag, lootBagInit(world, 0, "creature", LootSource.Zombie));
  for (const r of rolled) addItem(world, bag, r.item, r.n);
  tagLootSource(world, bag, LootSource.Zombie); indexEntity(world, bag); return bag;
}

/** Tile lookup used by population when the world has no TerrainRes (the server reads ChunkManager directly). */
export const PopulationTiles = defineResource<(tx: number, ty: number) => number>("gameplay.PopulationTiles");
export function populationTile(world: World, tx: number, ty: number): number {
  const t = world.getResource(TerrainRes); if (t) return t.tileAt(tx, ty);
  return world.getResource(PopulationTiles)?.(tx, ty) ?? 0;
}
const animAt = (world: World, e: Entity, anim: Anim): void => { if (world.has(e, AnimState) && world.getField(e, AnimState, "anim") !== Anim.Hurt) setAnim(world, e, anim); };
/**
 * Animal AI (authority, every tick). Idle/wander around home; flee from living survivors in fleeRange (or once hp <= fleeHpFrac);
 * aggressive kinds (ai.json aggro) chase + bite targets within aggro.range, leash back past leashRange: hostile = anyone close,
 * territorial = close to home, defensive = only after being hurt. Death: loot bag + corpse, then removal.
 * ADR-354: species with a taming path never initiate — a tameable animal only ever engages its actual attacker
 * (retaliation below), never a bystander who walks up to it. The moose's ai.json mode is defensive for the same
 * reason; the guard here is the structural rule, so a future tameable added to ai.json as territorial/hostile
 * still cannot attack on sight. Each species keeps its own non-combat behaviour (flee ranges, wander radii).
 */
const THREATS: number[] = []; const THREAT_LIST_MAX = 48;
/**
 * ADR-377: cached animal lists. animalAISystem used to spread + sort the dead sweep and spread the live
 * list out of the query generator every tick — a fresh array (+ sort) per tick for a set that only changes
 * when an animal spawns/dies, gains/loses Dead, or becomes a pet. Both lists rebuild only when a
 * membership counter of a store that gates membership moves (ComponentStore.membership bumps on
 * add/remove, never on field writes — the ADR-315 precedent), so this system's own field writes
 * (state/thinkAt/goal) never invalidate. The dead list stays sorted ascending by entity id, exactly as
 * the old `[...query].sort((x, y) => x - y)` produced; the live list is rebuilt with the same query
 * expression, so its order (reverse-dense of the Animal store, the query driver) is identical too.
 * Per-world (WeakMap): tests run many worlds through this module-level system. The live list is
 * re-validated after the dead sweep because the sweep's corpse destroys and loot-bag Transform adds
 * move the counters.
 */
interface AnimalListCache {
  dead: Entity[]; deadAnimal: number; deadDead: number;
  live: Entity[]; liveAnimal: number; liveTransform: number; liveDead: number; livePet: number;
}
const animalListCaches = new WeakMap<World, AnimalListCache>();
export function animalAISystem(world: World, dt: number): void {
  if (!isAuthority(world) || world.isReplaying) return;
  const index = installSpatialIndex(world); const unwalk = gameplayDefs(world).worldgen.unwalkableTiles; const defs = animalDefs();
  // Task 29: hoisted component stores + chase limit. world.get() copies the component into a fresh
  // object per call (~0.8us for Animal alone); the loops below read store data directly instead.
  const aStore = world.store(Animal); const tfStore = world.store(Transform); const deadStore = world.store(Dead);
  const chaseLimit = populationData().ai.tuning?.chaseLimitTiles ?? 18;
  const tileBlocked: TileBlocked = (tx, ty) => unwalk.has(populationTile(world, tx, ty));
  let cache = animalListCaches.get(world);
  if (cache === undefined) {
    cache = { dead: [], deadAnimal: -1, deadDead: -1, live: [], liveAnimal: -1, liveTransform: -1, liveDead: -1, livePet: -1 };
    animalListCaches.set(world, cache);
  }
  if (cache.deadAnimal !== aStore.membership || cache.deadDead !== deadStore.membership) {
    cache.dead = [...world.query([Animal, Dead])].sort((x, y) => x - y);
    cache.deadAnimal = aStore.membership; cache.deadDead = deadStore.membership;
  }
  for (const e of cache.dead) {
    const as = aStore.slot(entityIndex(e)); const aD = aStore.data;
    if (aD.state[as]! !== AnimalState.Dead) {
      dropAnimalLoot(world, e); world.setField(e, Animal, "state", AnimalState.Dead);
      world.setField(e, Animal, "thinkAt", world.tick + Math.round(ANIMAL_CORPSE_SECONDS / dt)); if (world.has(e, AnimState)) setAnim(world, e, Anim.Die);
    } else if (world.tick >= aD.thinkAt[as]!) world.destroy(e);
  }
  // Task 29: Health/AnimState are only read by the main loop below; resolve them after confirming
  // there is an animal to process, so a world with no animals (and those components unregistered)
  // behaves exactly like before (no throw). THREATS is only consumed by that loop, so skipping its
  // fill here is unobservable.
  // ADR-377: cached live list, rebuilt only when Animal/Transform/Dead/Pet membership moves (see the
  // cache note above). Re-validated here, after the dead sweep, because the sweep's corpse destroys
  // and loot-bag Transform adds move the counters.
  const petStore = world.store(Pet);
  if (cache.liveAnimal !== aStore.membership || cache.liveTransform !== tfStore.membership || cache.liveDead !== deadStore.membership || cache.livePet !== petStore.membership) {
    cache.live = [...world.query([Animal, Transform], [Dead, Pet])]; // ADR-145: pets are driven by petSystem
    cache.liveAnimal = aStore.membership; cache.liveTransform = tfStore.membership; cache.liveDead = deadStore.membership; cache.livePet = petStore.membership;
  }
  const animals = cache.live;
  if (animals.length === 0) return;
  const hStore = world.store(Health); const anStore = world.store(AnimState);
  const mountReg = world.isRegistered(Mount);
  // ADR-368: the living-zombie list, built once per run (lazily, on the first tame defender that needs
  // it) for nearestClaimHostile — it used to run a spatial radius query per tame animal per tick. The
  // list path scans with the same exact-distance nearest rule (petSystem's Task 29 precedent); ties
  // resolve in query order rather than spatial-index order.
  let zombies: readonly Entity[] | undefined;
  // ADR-215: threat candidates (living survivors) gathered once; a short list beats a radius query over every piece
  // and animal in a village. Same set as the radius query (exact distance on the current Transform).
  THREATS.length = 0; let few = true;
  for (const p of world.query([Survival, Transform], [Dead])) { if (THREATS.length >= 3 * THREAT_LIST_MAX) { few = false; break; } const ps = tfStore.slot(entityIndex(p)); THREATS.push(p, tfStore.data.x[ps]!, tfStore.data.y[ps]!); }
  for (const e of animals) {
    // Task 29: store-direct snapshot at loop top — same staleness as the old world.get() copies
    // (later setFields in this iteration do not change these locals).
    const ei = entityIndex(e); const aSlot = aStore.slot(ei); const aD = aStore.data;
    const aKind = aD.kind[aSlot]!; const def = defs[aKind]; if (!def) continue;
    const owned = mountReg && world.has(e, Mount); // ADR-319: a tamed mount behaves like a domesticated animal
    if (owned && (world.getField(e, Mount, "riderNetId") ?? 0) !== 0) continue; // ridden: mountSystem moves it with its rider
    if (owned && isDrawnDriven(world, e)) continue; // ADR-360: driven from a wagon — the driver steers, the AI must not wander it off
    if (world.isRegistered(RopeLead) && world.has(e, RopeLead)) continue; // ADR-351: led — ropeSystem owns its movement
    const lureable = !owned && mountSpeciesOfAnimal(def.key) > 0; // ADR-319: food in hand calms a wild mount species
    const aState = aD.state[aSlot]!; const aHomeX = aD.homeX[aSlot]!; const aHomeY = aD.homeY[aSlot]!; const aGoalX = aD.goalX[aSlot]!; const aGoalY = aD.goalY[aSlot]!; const aThinkAt = aD.thinkAt[aSlot]!;
    const tSlot = tfStore.slot(ei); const tfD = tfStore.data; const tx = tfD.x[tSlot]!; const ty = tfD.y[tSlot]!;
    const hSlot = hStore.slot(ei); const hD = hStore.data; const hp = hSlot >= 0 ? hD.hp[hSlot]! : undefined; const maxHp = hSlot >= 0 ? hD.max[hSlot]! : undefined;
    const hurt = hp !== undefined && maxHp !== undefined && hp < maxHp; const scared = hurt && hp! <= maxHp! * def.fleeHpFrac;
    const anSlot = anStore.slot(ei); const anD = anStore.data;
    const aggressive = !!def.attack && def.aggro.mode !== "passive" && !scared;
    // ADR-377: squared home distance — homeD is only ever compared against ranges, never used as a value.
    const homeDx = tx - aHomeX, homeDy = ty - aHomeY; const homeD2 = homeDx * homeDx + homeDy * homeDy;
    let threat: { e: Entity; x: number; y: number; d2: number } | undefined;
    const tame = owned || world.has(e, Tamed); // ADR-113 / ADR-319: domesticated animals neither flee nor attack
    const tr = Math.max(def.fleeRange, aggressive ? def.aggro.leashRange : 0);
    if (!tame && few) for (let i = 0; i < THREATS.length; i += 3) {
      const p = THREATS[i]! as Entity, px = THREATS[i + 1]!, py = THREATS[i + 2]!; const ddx = px - tx, ddy = py - ty; if (ddx * ddx + ddy * ddy > tr * tr) continue;
      if (lureable && luresMount(world, def.key, p)) continue;
      const d2 = ddx * ddx + ddy * ddy; if (!threat || d2 < threat.d2 || (d2 === threat.d2 && p < threat.e)) threat = { e: p, x: px, y: py, d2 };
    }
    else if (!tame) for (const p of index.queryRadius(tx, ty, tr)) {
      if (!world.has(p, Survival) || world.has(p, Dead) || (lureable && luresMount(world, def.key, p))) continue; const pt = world.get(p, Transform)!; const pdx = pt.x - tx, pdy = pt.y - ty; const d2 = pdx * pdx + pdy * pdy;
      if (!threat || d2 < threat.d2 || (d2 === threat.d2 && p < threat.e)) threat = { e: p, x: pt.x, y: pt.y, d2 };
    }
    let state = aState, gx = aGoalX, gy = aGoalY;
    // Task 15: chase limit — an engaged animal gives up once it is farther than this from home (tighter than
    // the old 2x leashRange rule when the limit is smaller). Territory defenders below are exempt: they use
    // their own claim-range branch, not this one.
    const pressHome = Math.min(def.aggro.leashRange * 2, chaseLimit); const pressHome2 = pressHome * pressHome; const leash2 = def.aggro.leashRange * def.aggro.leashRange;
    // Task 15: retaliation — a hurt wild animal engages its recent attacker even outside aggro.range, as long
    // as the attacker is close (within leashRange) and recent (retaliateSeconds). The attacker overrides the
    // scanned threat (defending yourself takes priority over a bystander). Scared animals never retaliate
    // (aggressive already excludes them). This keeps a calmer moose (range 2) defending itself.
    let retaliating = false;
    if (!tame && aggressive && hurt) {
      const la = lastAttacker(world, e);
      if (la && world.tick - la.tick <= gameplayDefs(world).ai.retaliateSeconds * DEFAULT_TICK_HZ) {
        const at = world.get(la.e, Transform);
        if (at && world.has(la.e, Survival) && !world.has(la.e, Dead)) {
          const rdx = at.x - tx, rdy = at.y - ty; const d2 = rdx * rdx + rdy * rdy;
          if (d2 <= leash2) { threat = { e: la.e, x: at.x, y: at.y, d2 }; retaliating = true; }
        }
      }
    }
    const engaged = state === AnimalState.Attack;
    // Task 33: aggressive animals do not engage survivors standing inside a spawn safe radius. Retaliation
    // (the attacker overrides the scanned threat above) still applies, so the zone is not a free shooting
    // gallery; fleeing from a safe-zone survivor still works (only the attack decision is gated).
    // ADR-354: a tameable species never initiates — the mode conditions below (hostile / territorial /
    // defensive-when-hurt) only apply to non-tameables. An engaged or retaliating tameable still presses
    // its actual attacker (the branch above), so self-defence is unchanged.
    const safeTarget = threat !== undefined && !retaliating && inSpawnSafeRadius(world, threat.x, threat.y);
    const wants = aggressive && threat && !safeTarget && ((engaged || retaliating) ? threat.d2 <= leash2 && homeD2 <= pressHome2
      : !isTameableAnimalKey(def.key) && threat.d2 <= def.aggro.range * def.aggro.range && (def.aggro.mode === "hostile" || (def.aggro.mode === "territorial" && homeD2 <= leash2) || (def.aggro.mode === "defensive" && hurt)));
    // Task 14: tame animals defend their owner's claim. Passive farm animals have no species attack, so they
    // get a generic bite; goat/cow reuse their own attack. Movement still goes through creatureStep, so a
    // fenced-in defender strains at the fence instead of teleporting through it.
    let territory: { e: Entity; x: number; y: number; d2: number } | undefined;
    if (tame) {
      const tribe = tamedOwnerTribe(world, e);
      if (tribe) {
        if (zombies === undefined) zombies = [...world.query([Zombie, Transform], [Dead])];
        const z = nearestClaimHostile(world, tx, ty, TERRITORY_DEFEND_RANGE, tribe, zombies);
        if (z !== undefined) { const zt = world.get(z, Transform)!; const zdx = zt.x - tx, zdy = zt.y - ty; territory = { e: z, x: zt.x, y: zt.y, d2: zdx * zdx + zdy * zdy }; }
      }
    }
    if (territory) {
      state = AnimalState.Attack; gx = territory.x; gy = territory.y;
      const range = def.attack?.range ?? TERRITORY_BITE.range, damage = def.attack?.damage ?? TERRITORY_BITE.damage, cd = def.attack?.cooldownSeconds ?? TERRITORY_BITE.cooldownSeconds;
      if (territory.d2 <= (range + 0.4) * (range + 0.4)) {
        gx = tx; gy = ty;
        if (world.tick >= aThinkAt) {
          applyDamage(world, territory.e, damage, e); animAt(world, e, Anim.Attack);
          world.setField(e, Animal, "thinkAt", world.tick + Math.max(1, Math.round(cd / dt)));
        }
      }
    } else if (wants && threat && def.attack) {
      state = AnimalState.Attack; gx = threat.x; gy = threat.y;
      if (threat.d2 <= (def.attack.range + 0.4) * (def.attack.range + 0.4)) {
        gx = tx; gy = ty;
        if (world.tick >= aThinkAt) {
          applyDamage(world, threat.e, def.attack.damage, e); animAt(world, e, Anim.Attack);
          world.setField(e, Animal, "thinkAt", world.tick + Math.max(1, Math.round(def.attack.cooldownSeconds / dt)));
        }
      }
    } else if (threat && threat.d2 <= def.fleeRange * def.fleeRange && (!aggressive || scared || def.aggro.mode === "passive" || !def.attack)) {
      state = AnimalState.Flee; const ang = Math.atan2(ty - threat.y, tx - threat.x); gx = tx + Math.cos(ang) * 4; gy = ty + Math.sin(ang) * 4;
    } else if (scared && state === AnimalState.Flee) { /* keep running to the last goal */ }
    else if (world.tick >= aThinkAt || state === AnimalState.Flee || state === AnimalState.Attack) {
      const rng = world.rngFor("animal.think", e);
      if (rng.next() < 0.5) state = AnimalState.Idle;
      else { state = AnimalState.Wander; const ang = rng.range(-Math.PI, Math.PI), r = rng.range(1, tame ? Math.min(2.5, def.wanderRadius) : def.wanderRadius); gx = aHomeX + Math.cos(ang) * r; gy = aHomeY + Math.sin(ang) * r; }
      world.setField(e, Animal, "thinkAt", world.tick + Math.round(rng.range(2, 6) * DEFAULT_TICK_HZ));
    }
    let moving = false;
    if (state !== AnimalState.Idle) {
      const dx = gx - tx, dy = gy - ty, d = Math.hypot(dx, dy); const sp = (state === AnimalState.Wander ? def.speed : def.fleeSpeed) * swimSpeedMulAt(world, tx, ty) * dt;
      if (d < 0.1) { if (state !== AnimalState.Attack) state = AnimalState.Idle; }
      else {
        const nav = creatureStep(world, e, gx, gy, sp, 0, tileBlocked, dt); // ADR-215: collide with / path around structures
        if (nav !== undefined) { moving = nav; if (!nav && state !== AnimalState.Attack) state = AnimalState.Idle; }
        else {
          const nx = tx + (dx / d) * Math.min(sp, d), ny = ty + (dy / d) * Math.min(sp, d);
          if (!unwalk.has(populationTile(world, Math.floor(nx), Math.floor(ny)))) { world.set(e, Transform, { x: nx, y: ny, facing: Math.atan2(dy, dx) }); moving = true; }
          else state = AnimalState.Idle;
        }
      }
    }
    // Task 29: store-direct anim write — same rules as animAt/setAnim (never override Hurt, only
    // write on change, add the component if missing), without the per-call getField/store lookups.
    const curAnim = anSlot >= 0 ? anD.anim[anSlot]! : undefined;
    if (curAnim !== Anim.Attack || !moving) {
      const want = moving ? (state === AnimalState.Wander ? Anim.Walk : Anim.Run) : state === AnimalState.Attack ? (curAnim as Anim) : Anim.Idle;
      if (anSlot >= 0) { if (curAnim !== Anim.Hurt && curAnim !== want) { anD.anim[anSlot] = want; anD.startTick[anSlot] = world.tick; anStore.markChanged(ei); } }
      else animAt(world, e, want);
    }
    if (state !== aState) world.setField(e, Animal, "state", state);
    if (gx !== aGoalX || gy !== aGoalY) { world.setField(e, Animal, "goalX", gx); world.setField(e, Animal, "goalY", gy); }
  }
}

/** Set while a PopulationSpawner owns zombie spawning (the legacy per-player zombieSpawner then stands down). */
export const PopulationRes = defineResource<PopulationSpawner>("gameplay.Population");

export interface InstallPopulationOptions {
  chunks: () => Iterable<ChunkKey>;
  /** Real (human) players: spawn distance + despawn reference. */
  viewpoints: () => PopulationViewpoint[];
  /** Enables the human_bot table entry; spawn is async (virtual players join through the client path). */
  humanBots?: { spawn(x: number, y: number, kind: string): boolean; despawn(e: Entity): void } | undefined;
  /** ADR-110: scales animal perChunk / global caps (mobile / lowend hosts pass < 1). Default 1. */
  animalCapMul?: number;
  buildings?: BuildingGrid;
  /** Override/extend the data table (tests, mods); default toSpawnEntries(mode) from data/spawns.json. */
  spawns?: readonly SpawnEntry[];
  /** Spawn-table mode; default "sp" when humanBots is set, else "mp". */
  mode?: GameMode;
  intervalSeconds?: number;
  tickHz?: number;
  /** Tile lookup when the world has no TerrainRes (e.g. the server's ChunkManager.getTile). */
  tileAt?: (tx: number, ty: number) => number;
  /** Tracked entities that must not be despawned for being far from every viewpoint (e.g. bots at a far spawn point). */
  persistent?: (e: Entity) => boolean;
}
/** Is (tx,ty) off-limits for ambient spawns: unwalkable, under a structure, building grid, or inside a claim. */
export function populationBlocked(world: World, tx: number, ty: number, buildings?: BuildingGrid): boolean {
  if (gameplayDefs(world).worldgen.unwalkableTiles.has(populationTile(world, tx, ty))) return true;
  if (structures(world).deck(tx, ty, 0)) return true;
  if (buildings?.isBlocked(tx, ty)) return true;
  const perms = world.getResource(Permissions); if (perms?.claims.claimAt(tx, ty)) return true;
  return false;
}
/** ADR-110: animal caps * mul (at least 1 each; group clamped to the per-chunk cap). */
export function scaleAnimalCaps<T extends { category: string; perChunkCap: number; globalCap: number; group?: [number, number] }>(entries: T[], mul: number): T[] {
  if (mul === 1) return entries;
  return entries.map((e) => { if (e.category !== "animal") return e; const per = Math.max(1, Math.floor(e.perChunkCap * mul));
    return { ...e, perChunkCap: per, globalCap: Math.max(1, Math.floor(e.globalCap * mul)), ...(e.group ? { group: [Math.min(e.group[0], per), Math.min(e.group[1], per)] as [number, number] } : {}) }; });
}
export function installPopulation(world: World, o: InstallPopulationOptions): PopulationSpawner {
  if (o.tileAt) world.setResource(PopulationTiles, o.tileAt);
  const spawns = scaleAnimalCaps((o.spawns ?? toSpawnEntries(o.mode ?? (o.humanBots ? "sp" : "mp"))).filter((s) => s.category !== "human_bot" || o.humanBots), o.animalCapMul ?? 1);
  const host: PopulationHost = {
    chunks: o.chunks, viewpoints: o.viewpoints,
    phase: (): PhaseKey => currentPhaseKey(world),
    tileAt: (tx, ty) => populationTile(world, tx, ty),
    blocked: (tx, ty) => populationBlocked(world, tx, ty, o.buildings),
    spawn: (entry, x, y) => {
      // Task 33: no aggressive creature spawns inside the safe radius around spawn points. The spawner
      // retries other positions in the chunk, so the radius only ever costs a spawn attempt, never a crash.
      if (isAggressiveSpawnKind(entry.kind, entry.category) && inSpawnSafeRadius(world, x, y)) return undefined;
      if (entry.category === "zombie") { if (!zombieKindAllowed(world, entry.kind, x, y)) return undefined; /* ADR-226 */ const rng = world.rngFor(`pop.variant:${entry.kind}`); return spawnZombie(world, entry.kind, x, y, rng.int(0, 255)); }
      if (entry.category === "animal") return spawnAnimal(world, entry.kind, x, y);
      if (entry.category === "human_bot") return o.humanBots?.spawn(x, y, entry.kind) ? "pending" : undefined;
      return undefined;
    },
    despawn: (e) => { if (world.isAlive(e) && !world.has(e, Tamed) && !(world.isRegistered(Mount) && world.has(e, Mount))) world.destroy(e); }, // ADR-113 / ADR-319: tamed animals and mounts stay
    persistent: (e) => world.has(e, Tamed) || (world.isRegistered(Mount) && world.has(e, Mount)) || (o.persistent?.(e) ?? false),
    position: (e) => { if (!world.isAlive(e) || world.has(e, Dead)) return undefined; const t = world.get(e, Transform); return t ? { x: t.x, y: t.y } : undefined; },
  };
  // Human bots are despawned by their host (session leave), not by destroying the entity.
  const sp = new PopulationSpawner(world, spawns, { ...host, despawn: (e, entry) => { if (entry.category === "human_bot") o.humanBots?.despawn(e); else host.despawn(e, entry); } });
  world.setResource(PopulationRes, sp);
  if (spawns.some((s) => s.category === "zombie")) world.setResource(PopulationZombies, true);
  const every = Math.max(1, Math.round((o.intervalSeconds ?? POPULATION_DATA.intervalSeconds) * (o.tickHz ?? DEFAULT_TICK_HZ)));
  world.addSystem("simulation", "gameplay.population", () => { if (isAuthority(world) && !world.isReplaying) sp.step(); }, { every });
  world.addSystem("simulation", "gameplay.animalAI", animalAISystem);
  return sp;
}
