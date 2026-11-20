/**
 * Render-side VFX layer: short-lived sprite effects (hit sparks, dust, muzzle flashes...) drawn in the
 * dynamic sprite batch. Feed it from the net client's delayed event stream so effects line up with the
 * interpolated remote view:   for (const ev of client.pollEvents(client.renderTick)) renderer.vfx.handle(ev)
 * with a mapper registered via `renderer.vfx.onEvent(defName, ev => ({ spriteId, x, y, ... }))`.
 */
export interface VfxSpawn {
  spriteId: number; x: number; y: number; z?: number;
  /** Animation index (default 0) and lifetime in seconds (default: one pass of the animation or 0.5 s). */
  anim?: number; lifetime?: number; scale?: number; facing?: number;
  /** Ignore darkness (fire, sparks). */
  emissive?: boolean;
  /** Particle motion: velocity (tiles/s, z in terrain levels/s), gravity (levels/s², negative rises), fade over life, scale curve. */
  vx?: number; vy?: number; vz?: number; gravity?: number; fade?: boolean; scaleCurve?: [number, number];
  /** Opacity multiplier 0..1 (default 1). */
  alpha?: number;
  /** ADR-455: draw flat on the ground plane (SpriteFlag.Flat) instead of as a billboard — ground decals (footprints). */
  flat?: boolean;
  /** ADR-218: start this many seconds into the animation (desyncs looping flames). */
  age?: number;
}
export interface VfxInstance { spriteId: number; x: number; y: number; z: number; anim: number; born: number; lifetime: number; scale: number; facing: number; emissive: boolean;
  vx: number; vy: number; vz: number; gravity: number; fade: boolean; s0: number; s1: number; alpha: number; flat: boolean;
  /** one-frame overlay instance (see VfxLayer.overlay) */ overlay?: boolean;
  /** ADR-218: set once the instance left `active` (expired, killed or evicted by maxActive). */ dead?: boolean }
export interface VfxEventLike { tick: number; def: { name?: string; type?: number } | unknown; payload: Record<string, number> }

export class VfxLayer {
  readonly active: VfxInstance[] = [];
  private mappers = new Map<string, (ev: VfxEventLike) => VfxSpawn | VfxSpawn[] | null>();
  maxActive = 2048;
  /** Renderer clock (seconds); set by the renderer each frame. */
  now = 0;
  /**
   * Persistent per-frame overlays (e.g. stall listing icons / prompts, see stalls/StallLayer): replaced by the caller before
   * each render; update() swaps them into `active` for exactly one frame so they share the lit, depth-sorted sprite batch.
   */
  overlay: readonly VfxSpawn[] = [];

  spawn(s: VfxSpawn, overlay = false): VfxInstance {
    if (this.active.length >= this.maxActive) { const ev = this.active.shift(); if (ev) ev.dead = true; }
    const v: VfxInstance = { alpha: s.alpha ?? 1, ...(overlay ? { overlay: true, } : {}), spriteId: s.spriteId, x: s.x, y: s.y, z: s.z ?? 0, anim: s.anim ?? 0, born: this.now - (s.age ?? 0), lifetime: s.lifetime ?? 0.5, scale: s.scale ?? 1, facing: s.facing ?? 0, emissive: s.emissive ?? true, flat: s.flat ?? false,
      vx: s.vx ?? 0, vy: s.vy ?? 0, vz: s.vz ?? 0, gravity: s.gravity ?? 0, fade: s.fade ?? false, s0: s.scaleCurve?.[0] ?? 1, s1: s.scaleCurve?.[1] ?? 1 };
    this.active.push(v); return v;
  }
  /** ADR-218: end a (persistent) instance now; it is dropped on the next update(). */
  kill(v: VfxInstance): void { v.lifetime = 0; v.born = this.now - 1; v.alpha = 0; }
  /** Map a gameplay/net event (by def name) to effects. */
  onEvent(defName: string, map: (ev: VfxEventLike) => VfxSpawn | VfxSpawn[] | null): void { this.mappers.set(defName, map); }
  handle(ev: VfxEventLike): void {
    const name = (ev.def as { name?: string } | undefined)?.name; if (!name) return;
    const m = this.mappers.get(name); if (!m) return;
    const r = m(ev); if (!r) return; for (const s of Array.isArray(r) ? r : [r]) this.spawn(s);
  }
  /** Drop expired effects. */
  update(now: number): void {
    const dt = Math.max(0, Math.min(0.1, now - this.now)); this.now = now; let w = 0;
    for (const v of this.active) if (!v.overlay && now - v.born < v.lifetime) {
      if (v.vx || v.vy || v.vz || v.gravity) { v.x += v.vx * dt; v.y += v.vy * dt; v.vz -= v.gravity * dt; v.z += v.vz * dt; }
      this.active[w++] = v;
    } else v.dead = true;
    this.active.length = w;
    for (const o of this.overlay) this.spawn({ ...o, lifetime: Infinity }, true);
  }
}
