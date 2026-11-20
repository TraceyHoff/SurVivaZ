/**
 * ADR-455: footprints in snow and mud — CLIENT-SIDE ONLY transient decals.
 *
 * Why client-side: the net client never steps the gameplay sim (packages/net/src/client.ts is a
 * snapshot/interpolation client), so a sim-side footprint store would live only on the server and
 * never reach any screen; sharing footprints as world state would need per-step entity replication,
 * which the batch's cost rule forbids. So each client stamps its own footprints from the replicated
 * state it already has (mover Transforms, per-chunk wetness via the networked ChunkSurface, season
 * snow cover) and draws them as one-frame VFX overlays (the StallLayer pattern: replaced before each
 * render, sharing the lit, depth-sorted sprite batch). No sim state, no replication, no persistence —
 * a footprint is gone on reload, which is correct for something that fades in 60 s.
 *
 * Sampling: every sampleTicks (5 ticks = 0.25 s) the client samples movers (players + bots via
 * Survival, animals via Animal, zombies via Zombie) near the local player. A mover stamps its tile
 * only when it ENTERED a new tile since the last sample and the surface qualifies (ground snow cover
 * >= snowCover, or the chunk wetness >= wetness). Standing still stamps nothing; a footprint under a
 * stationary mover is never refreshed. Prints fade linearly over fadeSeconds and are pruned on the
 * next sample after expiry; the store is capped at maxFootprints (oldest evicted first).
 *
 * Facing: the print points along the mover's travel direction (derived from the position delta, not
 * Transform.facing — animals/zombies don't update facing every tick). The atlas has 8 directional
 * frames (frame f = heading f*45 deg in world atan2 terms, i.e. the renderer's facing integer:
 * quantizeDir8, 0 = world (1,0)). The painter rotates the boot by f*45 deg in canvas space, where
 * canvas +x = world +x and canvas +y = world +y (flat-sprite ground mapping). Variant alternates
 * left/right foot (a lateral offset perpendicular to the heading, +-0.18 tiles).
 */
import { Transform, type Entity, type World } from "@engine/core";
import { seasonVisual, type VfxSpawn } from "@engine/render";
import { Animal, chunkWetnessAt, Survival, Zombie, type EnvironmentTuning } from "@engine/gameplay";

export interface FootprintsTuning {
  fadeSeconds: number; snowCover: number; wetness: number; nearPlayerTiles: number; sampleTicks: number; maxFootprints: number;
}
export const DEFAULT_FOOTPRINTS_TUNING: FootprintsTuning = Object.freeze({
  fadeSeconds: 60, snowCover: 0.5, wetness: 0.5, nearPlayerTiles: 40, sampleTicks: 5, maxFootprints: 512,
});
/** Tuning from the gameplay data (environment.json `footprints`); defaults when absent (old data). */
export function footprintTuning(env: EnvironmentTuning | undefined): FootprintsTuning {
  const f = env?.footprints; if (!f) return DEFAULT_FOOTPRINTS_TUNING;
  return {
    fadeSeconds: f.fadeSeconds ?? 60, snowCover: f.snowCover ?? 0.5, wetness: f.wetness ?? 0.5,
    nearPlayerTiles: f.nearPlayerTiles ?? 40, sampleTicks: f.sampleTicks ?? 5, maxFootprints: f.maxFootprints ?? 512,
  };
}
/** Ground snow cover 0..1 for the world (the render formula: 0.82 * smooth(0.15, 0.85, winter weight)). */
export function snowCoverOf(world: World): number { return seasonVisual(world).snow; }

export interface FootprintStamp { x: number; y: number; untilTick: number; facing: number; variant: number; }
export interface FootprintLastPos { x: number; y: number; tx: number; ty: number; step: number; }
/** Transient per-client overlay store. `version` increments on every stamp (the render loop rebuilds the overlay when it changes). */
export class FootprintStore {
  stamps = new Map<string, FootprintStamp>();
  version = 0;
  lastSampleTick = -1;
  lastPos = new Map<Entity, FootprintLastPos>();
}
/** Renderer facing integer for a world heading (radians, atan2): 0 = world (1,0), +1 = +45 deg. */
export const quantizeDir8 = (h: number): number => {
  const TAU = Math.PI * 2; const a = ((h % TAU) + TAU) % TAU; return Math.round(a / (TAU / 8)) % 8;
};
const isMover = (world: World, e: Entity): boolean =>
  world.has(e, Survival) || world.has(e, Animal) || world.has(e, Zombie);

/**
 * Sample mover positions and stamp footprints. `playerX/playerY` is the local player's position
 * (the near-player gate); `snowCover` is the caller's ground snow cover (the view world has the
 * season set — the net world's Season env may lag replication). `tick` is the net world's tick.
 * Runs at most once per sampleTicks; stamping is O(movers) and only writes on tile entry.
 */
export function sampleFootprints(
  store: FootprintStore, world: World, playerX: number, playerY: number, tick: number,
  tuning: FootprintsTuning, snowCover: number,
): void {
  if (tick - store.lastSampleTick < tuning.sampleTicks) return;
  store.lastSampleTick = tick;
  // Prune expired prints (lazy decay: a print is drawn only while tick < untilTick).
  for (const [k, s] of store.stamps) if (s.untilTick <= tick) store.stamps.delete(k);
  const fadeTicks = Math.max(1, Math.round(tuning.fadeSeconds * 20));
  const near = tuning.nearPlayerTiles;
  for (const e of world.query([Transform])) {
    if (!isMover(world, e)) continue;
    const t = world.get(e, Transform); if (!t) continue;
    const tx = Math.floor(t.x), ty = Math.floor(t.y);
    const last = store.lastPos.get(e);
    const moved = !last || last.tx !== tx || last.ty !== ty;
    // Record the position even when nothing stamps (standing still must not stamp on the next sample).
    const step = last ? last.step : 0;
    store.lastPos.set(e, { x: t.x, y: t.y, tx, ty, step });
    if (!moved || !last) continue;
    if (Math.abs(t.x - playerX) > near || Math.abs(t.y - playerY) > near) continue;
    if (snowCover < tuning.snowCover && chunkWetnessAt(world, tx, ty) < tuning.wetness) continue;
    // Travel direction from the sampled delta (animals/zombies don't update Transform.facing per tick).
    const heading = Math.atan2(t.y - last.y, t.x - last.x);
    const facing = quantizeDir8(heading);
    const variant = step % 2;
    // Lateral offset: left/right foot, perpendicular to the heading, +-0.18 tiles.
    const side = variant === 0 ? -0.18 : 0.18;
    const ox = -Math.sin(heading) * side, oy = Math.cos(heading) * side;
    const key = `${tx},${ty}`;
    store.stamps.delete(key); // re-stamping a tile refreshes it (moves it to the back of the eviction order)
    store.stamps.set(key, { x: t.x + ox, y: t.y + oy, untilTick: tick + fadeTicks, facing, variant });
    store.lastPos.set(e, { x: t.x, y: t.y, tx, ty, step: step + 1 });
    store.version++;
  }
  // Cap: evict the oldest prints first (Map insertion order = stamp order).
  while (store.stamps.size > tuning.maxFootprints) {
    const first = store.stamps.keys().next();
    if (first.done) break;
    store.stamps.delete(first.value);
  }
}

/**
 * Build the one-frame VFX overlay for the current footprints (the StallLayer pattern: the caller
 * replaces renderer.vfx.overlay before each render). Alpha fades linearly with remaining life;
 * `flat: true` draws the sprite on the ground plane (SpriteFlag.Flat). Expired prints are skipped
 * (the sampler prunes them, but the overlay may be built between samples). `max` bounds the
 * per-frame overlay build (nearest-first is unnecessary — the gather culls off-screen spawns).
 */
export function collectFootprintOverlays(
  store: FootprintStore, spriteId: number, tick: number, fadeTicks: number, out: VfxSpawn[], max = 128,
): void {
  out.length = 0;
  for (const s of store.stamps.values()) {
    if (out.length >= max) break;
    const remaining = s.untilTick - tick;
    if (remaining <= 0) continue;
    const alpha = Math.max(0, Math.min(1, remaining / fadeTicks));
    out.push({
      spriteId, x: s.x, y: s.y, z: 0, anim: 0, lifetime: remaining / 20, scale: 1,
      facing: s.facing, emissive: false, alpha, flat: true,
    });
  }
}
