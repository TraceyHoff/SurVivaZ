/**
 * ADR-539 predator packs replace hordes. A server-only director (gameplay.packs, same cadence as
 * gameplay.hordes — every 20 ticks) that runs INSTEAD of the horde director when hordes are off:
 * packs are on when zombies are off OR hordes are off (zombies-off implies hordes-off/packs-on —
 * the contradictory zombies-off + hordes-on combination resolves to packs, per ADR-535).
 * Activation matrix (packsActive / hordesActive, both pure reads of WorldRules):
 *   zombies ON  + hordes ON  -> hordes run, packs do not.
 *   zombies ON  + hordes OFF -> packs run, hordes do not.
 *   zombies OFF + hordes ON  -> packs run (hordes are zombies), hordes do not.
 *   zombies OFF + hordes OFF -> packs run, hordes do not.
 *
 * A pack is NOT a horde with fur. A horde targets a STRUCTURE GROUP to attack; a pack targets
 * PREY in the open — a living survivor (player or AI human) outside structures, or near a base.
 * hordeTargets() is reused only to find the base whose occupants are the prey (the watch point
 * while the prey is indoors). Members are wolves (pack hunters already) + bears (the ferocious
 * anchor), spawned in the same 36–48 tile ring, with a size formula mirroring hordeSize but
 * smaller (solo 3–6, clan 6–12 — playtest tunables in roads.json `packs`). Members never
 * despawn while the pack lives (they are direct spawnAnimal entities, untracked by the ambient
 * PopulationSpawner) and disband to plain animals when the prey is gone.
 *
 * Openings (user ruling 2026-11-25): pack members NEVER damage walls or doors — there is no
 * structure-attack path for them at all (packSteer in population.ts never sets an attack on a
 * piece, and the animal loop never attacks BuildPiece). When the prey goes inside a structure,
 * the pack waits outside near the structure and WATCHES the doors / ways in: "watching" means
 * each member walks to the nearest door or open doorway of the prey's shelter and holds there
 * in Investigate (walking in, not attacking), re-checking on its think tick; the moment a door
 * is open (or the way in is an open doorway with no door hung), the member's goal becomes the
 * prey itself and creatureStep routes it through the opening — creatureStep's A* only ever
 * passes open doors / doorways, never closed doors or walls, so a closed door is a hard stop.
 * A prey indoors with no door at all is watched from the base centroid (the watch point).
 *
 * Reused from hordes: the cadence, the dusk/night + grace + interval schedule, the warning
 * channel (HordeStatus with kind Pack = 3 — the client toast/audio keep working, with pack
 * copy), the noise siege (ADR-476 lastLoudNoise re-target + siege minutes), the spawn ring.
 * NOT reused: the light-seek (predators do not seek lamplight — cut, see DECISIONS.md) and
 * hordeSteer (zombie-specific: it sets ZombieBrain; packSteer drives Animal goals instead).
 * Cost: same class as a horde — director every 20 ticks, A* repath via creatureStep's cached
 * routes per member; no new per-tick scans, nothing per frame.
 */
import { terrainBlocksWalker } from "./systems/movement.js";
import { defineResource, PlayerId, TimeOfDay as TimeOfDayLike, Transform, type Entity, type World } from "@engine/core";
import raw from "../data/roads.json";
import { Animal, Dead, HordePhase, HordeStatus, PackMember, Progression, Survival } from "./components.js";
/** HordeKind is a const enum (erased at runtime across modules), so packs.ts uses the numeric
 * values directly: Solo 1, Clan 2, Pack 3 (see hordes.ts). */
const KIND_CLAN = 2, KIND_PACK = 3;
import { isAuthority } from "./config.js";
import { secondsToTicks } from "./defs.js";
import { currentPhaseKey } from "./combat/zombies.js";
import { graceFor, hordeTargets, worldDays, worldRules, type HordeTarget } from "./hordes.js";
import { spawnAnimal } from "./population.js";
import { lastLoudNoise } from "./systems/noise.js";
import { shelterAt } from "./building/shelter.js";
import { TerrainRes } from "./world.js";

export interface PackTuning {
  intervalDays: number; warnSeconds: number; phases: string[];
  solo: { base: number; cap: number }; clan: { base: number; perMember: number; cap: number };
  levelScalePerLevel: number; dayScalePerDay: number; scaleCap: number;
  maxActivePacks: number; maxPackAnimals: number; spawnRingMin: number; spawnRingMax: number;
  composition: Record<string, number>; noiseMin: number; siegeMinutes: number;
}
export const PACKS = raw.packs as PackTuning;
export const PACKS_EVERY = 20;

/** Hordes run only when zombies are ON and hordes are ON; packs run in every other combination. */
export const hordesActive = (world: World): boolean => { const r = worldRules(world); return r.zombies && r.hordes; };
export const packsActive = (world: World): boolean => !hordesActive(world);

/** Pure size formula, mirroring hordeSize with the packs tuning (see file header). */
export function packSize(o: { clan: boolean; members?: number; level?: number; daysPastGrace?: number }, t: PackTuning = PACKS): number {
  const scale = Math.min(t.scaleCap, 1 + t.levelScalePerLevel * Math.max(0, (o.level ?? 1) - 1) + t.dayScalePerDay * Math.max(0, o.daysPastGrace ?? 0));
  if (!o.clan) return Math.min(t.solo.cap, Math.max(1, Math.round(t.solo.base * scale)));
  return Math.min(t.clan.cap, Math.round((t.clan.base + t.clan.perMember * Math.max(1, o.members ?? 1)) * scale));
}

/** A living survivor the director can send a pack after, with the base it belongs to (if any). */
export interface PackPrey { prey: Entity; base: HordeTarget | undefined; x: number; y: number; level: number; members: number; clan: boolean; outside: boolean }
/** Prey picker: every living survivor, outside-first (a survivor indoors is still prey — the
 * pack watches its base — but an exposed survivor is the preferred hunt), then by entity id.
 * `outside` is shelterAt().enclosed: roofed + walled-in counts as inside, anything else is open. */
export function packPreyTargets(world: World): PackPrey[] {
  const groups = hordeTargets(world);
  const out: PackPrey[] = [];
  for (const p of world.query([Survival, Transform], [Dead])) {
    const t = world.get(p, Transform)!;
    const outside = !shelterAt(world, t.x, t.y, t.z ?? 0).enclosed;
    let base: HordeTarget | undefined; let bd = Infinity;
    for (const g of groups) { const d = Math.hypot(g.x - t.x, g.y - t.y); if (d < bd) { bd = d; base = g; } }
    const level = base?.level ?? (world.isRegistered(Progression) ? world.getField(p, Progression, "level") ?? 1 : 1) ?? 1;
    out.push({ prey: p, base, x: t.x, y: t.y, level, members: base?.members ?? 1, clan: base?.kind === KIND_CLAN, outside });
  }
  return out.sort((a, b) => (a.outside === b.outside ? a.prey - b.prey : a.outside ? -1 : 1));
}

interface Pack { id: number; prey: Entity; baseKey: string | undefined; members: Set<Entity>; watchX: number; watchY: number; siegeUntil: number }
interface PackPending { at: number; prey: PackPrey; size: number }
interface PackRuntime { packs: Map<number, Pack>; nextId: number; nextTick: number; pending?: PackPending | undefined; lastHit: Map<number, number> }
export const PackRuntimeRes = defineResource<PackRuntime>("gameplay.PackRuntime");
export function packRuntime(world: World): PackRuntime {
  let r = world.getResource(PackRuntimeRes);
  if (!r) world.setResource(PackRuntimeRes, (r = { packs: new Map(), nextId: 1, nextTick: 0, lastHit: new Map() }));
  return r;
}

const status = (world: World) => world.get(world.environment, HordeStatus);
function setStatus(world: World, patch: Partial<{ phase: number; seq: number; kind: number; size: number; alive: number; x: number; y: number; owner: number; nextTick: number }>): void {
  const cur = status(world) ?? { phase: 0, seq: 0, kind: 0, size: 0, alive: 0, x: 0, y: 0, owner: 0, nextTick: 0 };
  const next = { ...cur, ...patch };
  if (Object.keys(patch).some((k) => (cur as Record<string, number>)[k] !== (next as Record<string, number>)[k]) || !world.has(world.environment, HordeStatus)) { if (world.has(world.environment, HordeStatus)) world.set(world.environment, HordeStatus, next); else world.add(world.environment, HordeStatus, next); }
}

function walkable(world: World, x: number, y: number): boolean {
  const terrain = world.getResource(TerrainRes); if (!terrain) return true;
  return !terrainBlocksWalker(world, Math.floor(x), Math.floor(y));
}
/** ADR-476, mirrored for packs: siegeMinutes in-game minutes (dayLengthTicks per game day; 30 min
 * default). No clock falls back to real-time minutes at 20 ticks/s. */
export function packSiegeTicks(world: World): number {
  const len = world.env(TimeOfDayLike).dayLengthTicks;
  return len > 0 ? Math.max(1, Math.round((len * PACKS.siegeMinutes) / (24 * 60))) : PACKS.siegeMinutes * 60 * 20;
}

/** Spawns a pack of `size` after prey `p`. Returns the pack id (0 when nothing could spawn). */
export function spawnPack(world: World, p: PackPrey, size: number): number {
  const rt = packRuntime(world); const rng = world.rngFor("pack", rt.nextId);
  let cx = p.x, cy = p.y, ok = false;
  for (let i = 0; i < 12 && !ok; i++) {
    const a = rng.range(0, Math.PI * 2), r = rng.range(PACKS.spawnRingMin, PACKS.spawnRingMax);
    cx = p.x + Math.cos(a) * r; cy = p.y + Math.sin(a) * r; ok = walkable(world, cx, cy);
  }
  if (!ok) return 0;
  const comp = Object.entries(PACKS.composition);
  const total = comp.reduce((a, [, w]) => a + w, 0); if (!total) return 0;
  const id = rt.nextId++; const members = new Set<Entity>();
  const watchX = p.base ? p.base.x : p.x, watchY = p.base ? p.base.y : p.y;
  for (let n = 0; n < size; n++) {
    let roll = rng.range(0, total), kind = comp[0]![0];
    for (const [k, w] of comp) { roll -= w; if (roll <= 0) { kind = k; break; } }
    const x = cx + rng.range(-3, 3), y = cy + rng.range(-3, 3); if (!walkable(world, x, y)) continue;
    let a: Entity;
    try { a = spawnAnimal(world, kind, x, y); } catch { continue; }
    world.add(a, PackMember, { pack: id & 0xffff, prey: p.prey, watchX, watchY, siegeUntil: 0 });
    world.setField(a, Animal, "goalX", p.x); world.setField(a, Animal, "goalY", p.y);
    members.add(a);
  }
  if (!members.size) return 0;
  rt.packs.set(id, { id, prey: p.prey, baseKey: p.base?.key, members, watchX, watchY, siegeUntil: 0 });
  return id;
}
const aliveIn = (world: World, pk: Pack): number => { for (const a of [...pk.members]) if (!world.isAlive(a) || world.has(a, Dead) || !world.has(a, PackMember)) pk.members.delete(a); return pk.members.size; };
/** Centroid of a pack's living members (undefined when none are left). */
function packCentroid(world: World, pk: Pack): { x: number; y: number } | undefined {
  let x = 0, y = 0, n = 0;
  for (const a of pk.members) {
    if (!world.isAlive(a)) continue;
    const t = world.get(a, Transform); if (!t) continue;
    x += t.x; y += t.y; n++;
  }
  return n ? { x: x / n, y: y / n } : undefined;
}
/** Disband a pack: its members lose PackMember and become plain animals again (wander home),
 * mirroring hordeSteer's disband (a horde whose target is gone drops HordeMember). */
export function disbandPack(world: World, id: number): void {
  const pk = packRuntime(world).packs.get(id); if (!pk) return;
  for (const a of [...pk.members]) {
    if (!world.isAlive(a) || !world.has(a, PackMember)) continue;
    const home = world.get(a, Animal);
    world.remove(a, PackMember);
    if (home) { world.setField(a, Animal, "goalX", home.homeX); world.setField(a, Animal, "goalY", home.homeY); world.setField(a, Animal, "state", 1); /* AnimalState.Wander */ }
  }
  packRuntime(world).packs.delete(id);
}

/** Server director (every PACKS_EVERY ticks). */
export function packDirectorSystem(world: World, dt = 1 / 20): void {
  if (!isAuthority(world) || world.isReplaying) return;
  const rules = worldRules(world); const rt = packRuntime(world);
  const st = status(world);
  const packStatus = st !== undefined && st.kind === KIND_PACK;
  // bookkeeping: prune dead members, disband packs whose prey is gone, track the status channel
  let alive = 0;
  for (const pk of [...rt.packs.values()]) {
    const preyGone = !world.isAlive(pk.prey) || world.has(pk.prey, Dead);
    if (preyGone) { disbandPack(world, pk.id); continue; }
    const n = aliveIn(world, pk); alive += n; if (n === 0) rt.packs.delete(pk.id);
  }
  if (packStatus && st!.phase === HordePhase.Active) {
    const cur = [...rt.packs.values()].reduce((s, pk) => s + pk.members.size, 0);
    if (rt.packs.size === 0) setStatus(world, { phase: HordePhase.Idle, alive: 0 }); else if (st!.alive !== cur) setStatus(world, { alive: cur });
  }
  if (!packsActive(world)) { rt.pending = undefined; if (packStatus && st!.phase === HordePhase.Warning) setStatus(world, { phase: HordePhase.Idle }); return; }
  const len = world.env(TimeOfDayLike).dayLengthTicks; if (len <= 0) return;
  if (rt.nextTick === 0) rt.nextTick = world.tick + Math.round(len * PACKS.intervalDays * 0.5);
  // ADR-476, mirrored for packs: a loud survivor noise re-targets the nearest pack that can hear
  // it (distance <= noise level x 1 tile/level) onto the noise maker, and starts a siege for
  // siegeMinutes (refreshed by further loud noise from the same prey). A sieging pack is never
  // pulled away to another noise. A loud noise in the open with no pack in hearing draws no pack
  // — the individuals still investigate by their own hearing (ADR-537), unchanged.
  const loud = lastLoudNoise(world);
  if (loud && loud.level >= PACKS.noiseMin) {
    const prey = packPreyTargets(world).find((t) => { const tt = world.get(t.prey, Transform)!; return Math.hypot(tt.x - loud.x, tt.y - loud.y) <= 1.5; });
    if (prey) {
      const sieging = [...rt.packs.values()].find((pk) => pk.prey === prey.prey && pk.siegeUntil > world.tick);
      if (sieging) {
        sieging.siegeUntil = world.tick + packSiegeTicks(world);
        for (const a of sieging.members) if (world.isAlive(a) && world.has(a, PackMember)) world.setField(a, PackMember, "siegeUntil", sieging.siegeUntil);
      } else {
        let nearest: Pack | undefined; let nd = Infinity;
        for (const pk of rt.packs.values()) {
          if (pk.siegeUntil > world.tick) continue;
          const c = packCentroid(world, pk); if (!c) continue;
          const d = Math.hypot(c.x - loud.x, c.y - loud.y);
          if (d <= loud.level * 1 && d < nd) { nd = d; nearest = pk; }
        }
        if (nearest) {
          const until = world.tick + packSiegeTicks(world);
          nearest.prey = prey.prey; nearest.baseKey = prey.base?.key; nearest.watchX = prey.base ? prey.base.x : prey.x; nearest.watchY = prey.base ? prey.base.y : prey.y; nearest.siegeUntil = until;
          for (const a of [...nearest.members]) {
            if (!world.isAlive(a) || !world.has(a, PackMember)) continue;
            world.set(a, PackMember, { pack: nearest.id & 0xffff, prey: prey.prey, watchX: nearest.watchX, watchY: nearest.watchY, siegeUntil: until });
          }
        }
      }
    }
  }
  // warning elapsed -> spawn
  if (rt.pending && world.tick >= rt.pending.at) {
    const p = rt.pending; rt.pending = undefined;
    const size = Math.min(p.size, PACKS.maxPackAnimals - alive);
    const id = size >= 2 ? spawnPack(world, p.prey, size) : 0;
    if (id) { rt.lastHit.set(p.prey.prey, world.tick); setStatus(world, { phase: HordePhase.Active, kind: KIND_PACK, size: rt.packs.get(id)!.members.size, alive: alive + rt.packs.get(id)!.members.size, x: p.prey.x, y: p.prey.y }); }
    else setStatus(world, { phase: rt.packs.size ? HordePhase.Active : HordePhase.Idle, kind: KIND_PACK });
    return;
  }
  if (rt.pending || world.tick < rt.nextTick || rt.packs.size >= PACKS.maxActivePacks || alive >= PACKS.maxPackAnimals - 2) return;
  if (!PACKS.phases.includes(currentPhaseKey(world))) return;
  const days = worldDays(world); if (days < rules.hordeGraceDays) return;
  const targeted = new Set([...rt.packs.values()].map((pk) => pk.prey));
  const eligible = packPreyTargets(world).filter((t) => days >= graceFor(rules.hordeGraceDays, t.level) && !targeted.has(t.prey));
  if (!eligible.length) return;
  eligible.sort((a, b) => (rt.lastHit.get(a.prey) ?? -1) - (rt.lastHit.get(b.prey) ?? -1) || (a.prey - b.prey));
  const t = eligible[0]!;
  const size = Math.min(packSize({ clan: t.clan, members: t.members, level: t.level, daysPastGrace: days - graceFor(rules.hordeGraceDays, t.level) }), PACKS.maxPackAnimals - alive);
  const at = world.tick + Math.max(1, secondsToTicks(PACKS.warnSeconds, dt));
  rt.pending = { at, prey: t, size }; rt.nextTick = world.tick + Math.round(len * PACKS.intervalDays);
  const owner = world.isRegistered(PlayerId) ? world.getField(t.prey, PlayerId, "id") ?? 0 : 0;
  setStatus(world, { phase: HordePhase.Warning, seq: ((st?.seq ?? 0) + 1) & 0xffff, kind: KIND_PACK, size, alive: 0, x: t.x, y: t.y, owner, nextTick: at });
}
/** Test/dev hook: start a pack after prey `p` immediately (no warning). */
export function forcePack(world: World, p: PackPrey, size?: number): number {
  const n = size ?? packSize({ clan: p.clan, members: p.members, level: p.level });
  const id = spawnPack(world, p, n);
  if (id) { const st = status(world); const owner = world.isRegistered(PlayerId) ? world.getField(p.prey, PlayerId, "id") ?? 0 : 0; setStatus(world, { phase: HordePhase.Active, seq: ((st?.seq ?? 0) + 1) & 0xffff, kind: KIND_PACK, size: n, alive: packRuntime(world).packs.get(id)!.members.size, x: p.x, y: p.y, owner }); }
  return id;
}
