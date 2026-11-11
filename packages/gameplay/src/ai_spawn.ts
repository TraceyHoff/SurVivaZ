/**
 * ADR-325: AI humans spawn and respawn all around the world, not by the players.
 *  - `computeAiSpawnPoints(gen, seed, starters, unwalkable)`: deterministic world-wide spawn points from the seed (a Vogel
 *    spiral snapped to clear walkable patches, plus spots beside seeded abandoned sites), with the ADR-106 starter points.
 *  - `pickAiSpawnPoint`: seeded pick weighted toward the least-populated points, at least `minPlayerDist` from every human
 *    player (and starter point), a small `nearPlayerShare` allowed closer (never on screen); claims, water, decks skipped.
 *  - `aiRespawnPoint`: bed, then home (host hook: the AI memory base), then a distributed point. Workers and clan members
 *    keep the ADR-153 rule (installBedRespawn chains this in).
 * ADR-326: the installed points are also the extra safe-radius centres (spawn_points.ts) — the Task 33
 * 20-tile protection (no aggressive spawns inside, no acquire/engage of survivors inside, hordes exempt)
 * covers the world-wide points too. No new knob: the radius is the shared SAFE_SPAWN_RADIUS, so the two
 * sets can never drift apart.
 */
import { Permissions, PlayerId, Transform, defineResource, type Entity, type World } from "@engine/core";
import { CHUNK_SIZE, type GeneratedChunk } from "@engine/world";
import raw from "../data/ai_spawn.json";
import { planAbandonedChunk } from "./building/abandoned.js";
import { ClanStatus, Dead, Survival, Worker } from "./components.js";
import { gameplayDefs } from "./config.js";
import { populationTile } from "./population.js";
import { isAiHuman } from "./skills/xp.js";
import { spawnPoints, setExtraSafeSpawnPoints, addSafeSpawnCentreProvider, type SpawnPointXY } from "./spawn_points.js";
import { structures } from "./building/structure.js";

export const AI_SPAWN = raw as unknown as {
  points: { count: number; minRadius: number; maxRadius: number; searchTiles: number; searchStep: number; clear: number; abandonedSites: number; abandonedProbes: number };
  pick: { minPlayerDist: number; nearPlayerShare: number; onScreenTiles: number; crowdRadius: number; crowdPow: number; jitter: number; tries: number };
  respawn: { homeFirst: boolean; homeMaxDist: number };
};
const P = AI_SPAWN.points, K = AI_SPAWN.pick;
export interface AiSpawnPoint extends SpawnPointXY { source: "starter" | "world" | "site" }
interface GenLike { tileAt(tx: number, ty: number): number; load(cx: number, cy: number): GeneratedChunk | undefined | Promise<GeneratedChunk | undefined> }

/** Deterministic world-wide AI spawn points (pure function of the generator / seed). */
export function computeAiSpawnPoints(gen: GenLike, seed: number, starters: readonly SpawnPointXY[], unwalkable: ReadonlySet<number>): AiSpawnPoint[] {
  const nodes = new Map<string, Set<number> | undefined>();
  const hasNode = (tx: number, ty: number): boolean => {
    const cx = Math.floor(tx / CHUNK_SIZE), cy = Math.floor(ty / CHUNK_SIZE), k = `${cx},${cy}`;
    if (!nodes.has(k)) { const c = gen.load(cx, cy); nodes.set(k, c && !(c instanceof Promise) ? new Set(c.nodes.map((n) => (n.ty - cy * CHUNK_SIZE) * CHUNK_SIZE + (n.tx - cx * CHUNK_SIZE))) : undefined); }
    return !!nodes.get(k)?.has((ty - cy * CHUNK_SIZE) * CHUNK_SIZE + (tx - cx * CHUNK_SIZE));
  };
  const clear = (tx: number, ty: number): boolean => {
    for (let dy = -P.clear; dy <= P.clear; dy++) for (let dx = -P.clear; dx <= P.clear; dx++) if (unwalkable.has(gen.tileAt(tx + dx, ty + dy)) || hasNode(tx + dx, ty + dy)) return false;
    return true;
  };
  const out: AiSpawnPoint[] = starters.map((s) => ({ x: s.x, y: s.y, source: "starter" }));
  const golden = Math.PI * (3 - Math.sqrt(5)); const phase = ((seed >>> 0) % 3600) / 3600 * Math.PI * 2;
  for (let i = 0; i < P.count; i++) {
    const f = (i + 0.5) / P.count; const r = Math.sqrt(P.minRadius ** 2 + f * (P.maxRadius ** 2 - P.minRadius ** 2)); const a = phase + i * golden;
    const cx = Math.round(Math.cos(a) * r), cy = Math.round(Math.sin(a) * r);
    let best: { x: number; y: number; d: number } | undefined;
    for (let dy = -P.searchTiles; dy <= P.searchTiles; dy += P.searchStep) for (let dx = -P.searchTiles; dx <= P.searchTiles; dx += P.searchStep) {
      const d = dx * dx + dy * dy; if (best && d >= best.d) continue; if (clear(cx + dx, cy + dy)) best = { x: cx + dx + 0.5, y: cy + dy + 0.5, d };
    }
    if (best) out.push({ x: best.x, y: best.y, source: "world" });
  }
  // beside seeded abandoned buildings (towns / POIs; the same plan stampAbandonedChunk uses when the chunk loads)
  let sites = 0;
  for (let i = 0; i < P.abandonedProbes && sites < P.abandonedSites; i++) {
    const f = (i + 0.5) / P.abandonedProbes; const r = Math.sqrt(P.minRadius ** 2 + f * (P.maxRadius ** 2 - P.minRadius ** 2)) / CHUNK_SIZE; const a = phase + 1 + i * golden;
    const plan = planAbandonedChunk(seed, Math.round(Math.cos(a) * r), Math.round(Math.sin(a) * r)); if (!plan) continue;
    const tx = plan.originX - 1, ty = plan.originY - 1; if (!clear(tx, ty)) continue;
    out.push({ x: tx + 0.5, y: ty + 0.5, source: "site" }); sites++;
  }
  return out;
}

const AiSpawnRes = defineResource<{ points?: AiSpawnPoint[]; lazy?: () => AiSpawnPoint[]; home?: ((e: Entity) => SpawnPointXY | undefined) | undefined; n: number }>("gameplay.AiSpawn");
const st = (w: World) => { let s = w.getResource(AiSpawnRes); if (!s) { s = { n: 0 }; w.setResource(AiSpawnRes, s); } return s; };
/** Install the points (or a lazy builder, run on the first spawn so server start stays fast). ADR-326: the
 * points are also the extra safe-radius centres in spawn_points.ts, so the Task 33 protection covers
 * them — eagerly here, or lazily through the same builder (a lazy set is protected from the first spawn
 * check, not only after the first bot spawns). */
export function setAiSpawnPoints(world: World, pts: readonly AiSpawnPoint[] | (() => AiSpawnPoint[])): void {
  const s = st(world);
  if (typeof pts === "function") { s.lazy = pts; delete s.points; setExtraSafeSpawnPoints(world, () => aiSpawnPoints(world)); }
  else { s.points = pts.map((p) => ({ ...p })); delete s.lazy; setExtraSafeSpawnPoints(world, s.points); }
}
/** AI spawn points: installed / lazily built, else the player spawn points. */
export function aiSpawnPoints(world: World): AiSpawnPoint[] {
  const s = st(world); if (!s.points && s.lazy) { s.points = s.lazy(); delete s.lazy; }
  return s.points?.length ? s.points : spawnPoints(world).map((p) => ({ ...p, source: "starter" as const }));
}
/** Host hook: an AI human's home (its remembered base), for respawn. */
export function setAiHomeLocator(world: World, fn: ((e: Entity) => SpawnPointXY | undefined) | undefined): void {
  st(world).home = fn;
  // ADR-348: homes are respawn points, so each live home is a safe centre (same 20-tile radius, same rules).
  addSafeSpawnCentreProvider(world, "ai-homes", () => aiHomeSafeCentres(world));
}
/** Hired workers and clan members keep the ADR-153 rule (bed -> nearest starter point): their home is
 * not a respawn point, so it is not a safe centre either (ADR-348). A Worker record with owner 0 is for
 * hire, not hired (recruitmentSystem gives every AI human one), so only a non-zero owner counts as hired. */
function keepsAdr153Rule(world: World, e: Entity): boolean {
  const hired = world.isRegistered(Worker) && world.has(e, Worker) && (world.getField(e, Worker, "owner") ?? 0) !== 0;
  const clan = world.isRegistered(ClanStatus) && world.has(e, ClanStatus) && (world.getField(e, ClanStatus, "clan") ?? 0) !== 0;
  return hired || clan;
}
/** ADR-348: the live home points of the AI humans whose respawn goes home (their own beds are covered by
 * respawn.ts). Mirrors aiRespawnPoint minus the death-distance check — the predicate has no corpse
 * position — and includes the dead: a dead AI human's home stays a centre through its respawn wait. A home
 * that is blocked (claim / water / deck) is not a respawn point, so it is not a centre. */
export function aiHomeSafeCentres(world: World): SpawnPointXY[] {
  const s = st(world); if (!s.home) return [];
  const out: SpawnPointXY[] = [];
  for (const e of world.query([Survival, Transform])) {
    if (!isAiHuman(world, e) || keepsAdr153Rule(world, e)) continue;
    const h = s.home(e); if (h && !blocked(world, h.x, h.y)) out.push({ x: h.x, y: h.y });
  }
  return out;
}

/** Live human (non-AI) player positions on the authoritative world. */
export function humanPlayerPositions(world: World): SpawnPointXY[] {
  const out: SpawnPointXY[] = []; if (!world.isRegistered(PlayerId)) return out;
  for (const e of world.query([PlayerId, Transform, Survival], [Dead])) if (!isAiHuman(world, e)) { const t = world.get(e, Transform)!; out.push({ x: t.x, y: t.y }); }
  return out;
}
const blocked = (world: World, x: number, y: number): boolean => {
  const tx = Math.floor(x), ty = Math.floor(y);
  if (gameplayDefs(world).worldgen.unwalkableTiles.has(populationTile(world, tx, ty))) return true;
  if (structures(world).deck(tx, ty, 0)) return true;
  return !!world.getResource(Permissions)?.claims.claimAt(tx, ty);
};
export interface AiSpawnPick extends SpawnPointXY { index: number; near: boolean }
/**
 * Seeded, least-populated-weighted AI spawn point. `pending` = spots already handed out but not yet occupied.
 * Deterministic: world.rngFor(`aispawn:${key}`, salt) + the world state.
 */
export function pickAiSpawnPoint(world: World, key: string, salt = 0, o: { humans?: readonly SpawnPointXY[]; pending?: readonly SpawnPointXY[]; exclude?: Entity } = {}): AiSpawnPick {
  const pts = aiSpawnPoints(world); const humans = o.humans ?? humanPlayerPositions(world); const rng = world.rngFor(`aispawn:${key}`, salt);
  const starters = pts.filter((p) => p.source === "starter"); const onlyStarters = starters.length === pts.length; // custom maps: the starters are all there is
  const nearest = (p: SpawnPointXY, set: readonly SpawnPointXY[]): number => { let d = Infinity; for (const h of set) d = Math.min(d, Math.hypot(h.x - p.x, h.y - p.y)); return d; };
  const crowd = pts.map(() => 0); const r2 = K.crowdRadius ** 2;
  const occupants: SpawnPointXY[] = [...(o.pending ?? [])];
  for (const e of world.query([Survival, Transform], [Dead])) if (e !== o.exclude) { const t = world.get(e, Transform)!; occupants.push({ x: t.x, y: t.y }); }
  for (const q of occupants) pts.forEach((p, i) => { if ((q.x - p.x) ** 2 + (q.y - p.y) ** 2 <= r2) crowd[i]!++; });
  const near = rng.next() < K.nearPlayerShare;
  const ok = (i: number): boolean => { const p = pts[i]!; if (blocked(world, p.x, p.y)) return false; const dh = nearest(p, humans);
    return near ? dh >= K.onScreenTiles : dh >= K.minPlayerDist && (onlyStarters || nearest(p, starters) >= K.minPlayerDist); };
  let cand = pts.map((_, i) => i).filter(ok);
  if (!cand.length) { // nowhere far enough: the point farthest from every human (still never a blocked one)
    const free = pts.map((_, i) => i).filter((i) => !blocked(world, pts[i]!.x, pts[i]!.y)); const all = free.length ? free : pts.map((_, i) => i);
    cand = [all.reduce((b, i) => (nearest(pts[i]!, humans) > nearest(pts[b]!, humans) ? i : b), all[0]!)];
  }
  const w = cand.map((i) => 1 / (1 + crowd[i]!) ** K.crowdPow); const tot = w.reduce((a, b) => a + b, 0);
  let roll = rng.next() * tot, index = cand[cand.length - 1]!; for (let k = 0; k < cand.length; k++) { roll -= w[k]!; if (roll <= 0) { index = cand[k]!; break; } }
  const p = pts[index]!;
  for (let t = 0; t < K.tries; t++) { const a = rng.range(0, Math.PI * 2), r = K.jitter * Math.sqrt(rng.next()); const x = p.x + Math.cos(a) * r, y = p.y + Math.sin(a) * r; if (!blocked(world, x, y)) return { x, y, index, near }; }
  return { x: p.x, y: p.y, index, near };
}
/** AI human respawn after the bed: home (remembered base) when homeFirst, else a distributed point. Hired workers and clan
 *  members return undefined (the caller keeps their ADR-153 rule). */
export function aiRespawnPoint(world: World, e: Entity): SpawnPointXY | undefined {
  if (keepsAdr153Rule(world, e)) return undefined;
  const s = st(world); const t = world.get(e, Transform);
  if (AI_SPAWN.respawn.homeFirst) { const h = s.home?.(e); if (h && (!t || Math.hypot(h.x - t.x, h.y - t.y) <= AI_SPAWN.respawn.homeMaxDist) && !blocked(world, h.x, h.y)) return h; }
  const p = pickAiSpawnPoint(world, "respawn", (s.n++) * 7919 + e, { exclude: e }); return { x: p.x, y: p.y };
}
