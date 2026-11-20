/**
 * Burning building pieces -> fire / ember / smoke VFX (gameplay contract: Burning {lit u8, intensity u8 0-255, startTick u32}
 * on BuildPiece entities). Effect keys come from Art's manifest `vfx` entries (configurable, missing keys are skipped):
 *  - flames: `fire_big` for small pieces / low intensity, `fire_huge` for footprints >= hugeTiles or intensity >= hugeIntensity;
 *    one looping flame per footprint tile (capped), kept alive for as long as the piece burns (ADR-218: no more 0.8 s
 *    respawn pulse that faded every flame out and restarted all tiles on frame 0 in lockstep), each at its own anim phase;
 *  - embers: `campfire_sparks` particles (rate, speed, spread, gravity, fade, scaleCurve from the VfxDef), scaled by intensity;
 *  - smoke: `campfire_smoke` particles, same rules.
 */
import { entityIndex, Transform, type ComponentDef, type World } from "@engine/core";
import { floorToTerrainZ } from "@engine/world";
import type { AssetRegistry, VfxDef } from "@engine/assets";
import type { VfxInstance, VfxLayer } from "./vfx.js";
import type { AtlasManager } from "./assets/atlasManager.js";
import { Sprite } from "./components.js";

export type BurningDefT = ComponentDef<{ lit: "u8"; intensity: "u8"; startTick: "u32" }>;
export interface BurningFxConfig { fireBig: string; fireHuge: string; embers: string; smoke: string; hugeTiles: number; hugeIntensity: number; maxFlames: number }
export const DEFAULT_BURNING_FX: BurningFxConfig = { fireBig: "fire_big", fireHuge: "fire_huge", embers: "campfire_sparks", smoke: "campfire_smoke", hugeTiles: 4, hugeIntensity: 170, maxFlames: 4 };

interface Resolved { def: VfxDef; anim: number }

/** Pure choice of the flame effect (exported for tests). */
export function pickFlame(cfg: BurningFxConfig, tiles: number, intensity: number): string {
  return tiles >= cfg.hugeTiles || intensity >= cfg.hugeIntensity ? cfg.fireHuge : cfg.fireBig;
}

export class BurningFx {
  cfg: BurningFxConfig = { ...DEFAULT_BURNING_FX };
  private flames = new Map<number, { key: string; list: VfxInstance[] }>();
  /** Live flame instances (tests / diagnostics). */
  get flameCount(): number { let n = 0; for (const f of this.flames.values()) n += f.list.length; return n; }
  private cache = new Map<string, Resolved | null>(); private reg: AssetRegistry | null = null;
  rnd: () => number = Math.random;

  private fx(reg: AssetRegistry, key: string): Resolved | null {
    if (reg !== this.reg) { this.cache.clear(); this.reg = reg; }
    let r = this.cache.get(key);
    if (r === undefined) {
      r = null;
      if (reg.ids.vfx.tryId(key) !== undefined) { const def = reg.effect(key); const sp = reg.sprite(def.sprite); r = { def, anim: Math.max(0, sp.animList.findIndex((a) => a.name === def.anim)) }; }
      this.cache.set(key, r);
    }
    return r;
  }

  update(world: World, burning: BurningDefT, buildPiece: ComponentDef<any> | undefined, atlas: AtlasManager, vfx: VfxLayer, now: number, dt: number, wind?: { x: number; y: number }): void {
    const reg = atlas.registry; if (!reg || !world.isRegistered(burning)) return;
    const bs = world.store(burning); const tr = world.store(Transform);
    const bp = buildPiece && world.isRegistered(buildPiece) ? world.store(buildPiece) : null;
    const bpd = bp?.data as Record<string, ArrayLike<number>> | undefined;
    const seen = new Set<number>();
    for (let k = 0; k < bs.size; k++) {
      if (!bs.data.lit[k]) continue;
      const e = bs.dense[k]!; const i = entityIndex(e); const ts = tr.slot(i); if (ts < 0) continue;
      seen.add(i);
      const inten = bs.data.intensity[k]! / 255;
      let fw = 1, fh = 1, level = 0;
      const ps = bp ? bp.slot(i) : -1;
      if (bp && ps >= 0 && bpd) { const info = atlas.pieceInfo(bpd.visualId![ps]!); const rot = bpd.rotation![ps]! & 1; if (info) { fw = rot ? info.fh : info.fw; fh = rot ? info.fw : info.fh; } level = bpd.level![ps]!; }
      const ax = Math.floor(tr.data.x[ts]!), ay = Math.floor(tr.data.y[ts]!);
      const z = floorToTerrainZ(level, tr.data.z[ts]!);
      const tiles = fw * fh;
      // flames: one persistent looping flame per footprint tile (capped), random anim phase each; respawned only when
      // evicted (VfxLayer.maxActive) or when the flame size class changes
      const key = pickFlame(this.cfg, tiles, bs.data.intensity[k]!); const cur = this.flames.get(i); const scale = 0.75 + 0.5 * inten;
      if (!cur || cur.key !== key || cur.list.some((v) => v.dead)) {
        if (cur) for (const v of cur.list) vfx.kill(v);
        const f = this.fx(reg, key); const list: VfxInstance[] = [];
        if (f) {
          const n = Math.min(this.cfg.maxFlames, tiles);
          for (let q = 0; q < n; q++) {
            const tx = ax + (q % fw) + 0.5, ty = ay + Math.floor(q / fw) % fh + 0.5;
            list.push(vfx.spawn({ spriteId: f.def.sprite, anim: f.anim, x: tx, y: ty, z: z + 0.5, lifetime: Infinity, age: this.rnd() * 8, scale, emissive: true }));
          }
        }
        this.flames.set(i, { key, list });
      } else for (const v of cur.list) v.scale = scale;
      // particles: embers + smoke. ADR-465: smoke drifts with the wind (wind already scaled by
      // windSpeed/refSpeed by the caller, * 0.6 tiles/s); embers keep their radial spread (hot and fast).
      for (const key of [this.cfg.embers, this.cfg.smoke]) {
        const p = this.fx(reg, key); const pj = p?.def.particles; if (!p || !pj) continue;
        const isSmoke = key === this.cfg.smoke;
        let expect = pj.rate * dt * (0.25 + inten) * Math.min(3, tiles);
        while (expect > 0) {
          if (expect < 1 && this.rnd() > expect) break; expect -= 1;
          const sp = pj.speed[0] + (pj.speed[1] - pj.speed[0]) * this.rnd(); const a = this.rnd() * Math.PI * 2; const h = pj.spread * this.rnd();
          vfx.spawn({ spriteId: p.def.sprite, anim: p.anim, x: ax + fw * this.rnd(), y: ay + fh * this.rnd(), z: z + 1 + this.rnd(),
            lifetime: p.def.lifetime * (0.7 + 0.6 * this.rnd()), emissive: p.def.blend === "additive",
            vx: Math.cos(a) * h * sp + (isSmoke && wind ? wind.x * 0.6 : 0), vy: Math.sin(a) * h * sp + (isSmoke && wind ? wind.y * 0.6 : 0), vz: sp * 2, gravity: pj.gravity, fade: pj.fade,
            scaleCurve: [pj.scaleCurve[0] ?? 1, pj.scaleCurve[pj.scaleCurve.length - 1] ?? 1] });
        }
      }
    }
    for (const [i, f] of this.flames) if (!seen.has(i)) { for (const v of f.list) vfx.kill(v); this.flames.delete(i); }
  }
}

/**
 * ADR-218: embers + smoke over lit hearths (campfires, fireplaces, furnaces, stoves: GameplayBindings.litPieces with
 * FireState.Hearth, plus lit free-standing fire stations = `lit` component holders), from the same `campfire_sparks` /
 * `campfire_smoke` VfxDefs as BurningFx at a calmer rate. Capped per frame so a fire-heavy base stays cheap.
 */
export interface HearthFxConfig { embers: string; smoke: string; emberRate: number; smokeRate: number; maxHearths: number; height: number }
export const DEFAULT_HEARTH_FX: HearthFxConfig = { embers: "campfire_sparks", smoke: "campfire_smoke", emberRate: 0.35, smokeRate: 0.6, maxHearths: 48, height: 0.7 };

export class HearthFx {
  cfg: HearthFxConfig = { ...DEFAULT_HEARTH_FX };
  rnd: () => number = Math.random;
  /** Particles spawned since construction (tests / diagnostics). */
  spawned = 0;
  private cache = new Map<string, Resolved | null>(); private reg: AssetRegistry | null = null;
  private fx(reg: AssetRegistry, key: string): Resolved | null {
    if (reg !== this.reg) { this.cache.clear(); this.reg = reg; }
    let r = this.cache.get(key);
    if (r === undefined) {
      r = null;
      if (reg.ids.vfx.tryId(key) !== undefined) { const def = reg.effect(key); const sp = reg.sprite(def.sprite); r = { def, anim: Math.max(0, sp.animList.findIndex((a) => a.name === def.anim)) }; }
      this.cache.set(key, r);
    }
    return r;
  }

  update(world: World, litPieces: ReadonlyMap<number, number> | undefined, lit: ComponentDef | undefined, buildPiece: ComponentDef<any> | undefined, atlas: AtlasManager, vfx: VfxLayer, dt: number, pieceScale?: (e: number) => number | undefined, wind?: { x: number; y: number }): void {
    const reg = atlas.registry; if (!reg || dt <= 0) return;
    const tr = world.store(Transform); let n = 0;
    const bp = buildPiece && world.isRegistered(buildPiece) ? world.store(buildPiece) : null;
    const bpd = bp?.data as Record<string, ArrayLike<number>> | undefined;
    const emit = (e: number, fw: number, fh: number, level: number, piece: boolean, sc = 1): void => {
      const i = entityIndex(e); const ts = tr.slot(i); if (ts < 0) return;
      // pieces: footprint centre from the anchor tile (as BurningFx); stations: their own position
      const x = piece ? Math.floor(tr.data.x[ts]!) + fw / 2 : tr.data.x[ts]!, y = piece ? Math.floor(tr.data.y[ts]!) + fh / 2 : tr.data.y[ts]!;
      const z = floorToTerrainZ(level, tr.data.z[ts]!);
      for (const [key, rate] of [[this.cfg.embers, this.cfg.emberRate], [this.cfg.smoke, this.cfg.smokeRate]] as const) {
        const p = this.fx(reg, key); const pj = p?.def.particles; if (!p || !pj) continue;
        const isSmoke = key === this.cfg.smoke;
        let expect = pj.rate * rate * dt;
        while (expect > 0) {
          if (expect < 1 && this.rnd() > expect) break; expect -= 1;
          const sp = pj.speed[0] + (pj.speed[1] - pj.speed[0]) * this.rnd(); const a = this.rnd() * Math.PI * 2; const h = pj.spread * this.rnd();
          vfx.spawn({ spriteId: p.def.sprite, anim: p.anim, x: x + (this.rnd() - 0.5) * 0.4 * fw, y: y + (this.rnd() - 0.5) * 0.4 * fh, z: z + (this.cfg.height + 0.2 * this.rnd()) * sc, // ADR-227: a scaled-down flame emits from its own (lower) top
            // ADR-465: smoke drifts with the wind (wind already scaled by windSpeed/refSpeed by the
            // caller, * 0.6 tiles/s); embers keep their radial spread.
            lifetime: p.def.lifetime * (0.7 + 0.6 * this.rnd()), emissive: p.def.blend === "additive", scale: 0.7 * Math.max(0.6, sc),
            vx: Math.cos(a) * h * sp * 0.5 + (isSmoke && wind ? wind.x * 0.6 : 0), vy: Math.sin(a) * h * sp * 0.5 + (isSmoke && wind ? wind.y * 0.6 : 0), vz: sp * 1.5, gravity: pj.gravity, fade: pj.fade,
            scaleCurve: [pj.scaleCurve[0] ?? 1, pj.scaleCurve[pj.scaleCurve.length - 1] ?? 1] });
          this.spawned++;
        }
      }
    };
    if (litPieces) for (const [e, st] of litPieces) {
      if (st !== 2) continue; if (n++ >= this.cfg.maxHearths) return;
      const i = entityIndex(e); const ps = bp ? bp.slot(i) : -1; let fw = 1, fh = 1, level = 0;
      if (bp && ps >= 0 && bpd) { const info = atlas.pieceInfo(bpd.visualId![ps]!); const rot = bpd.rotation![ps]! & 1; if (info) { fw = rot ? info.fh : info.fw; fh = rot ? info.fw : info.fh; } level = bpd.level![ps]!; }
      emit(e, fw, fh, level, true, pieceScale?.(e) ?? 1);
    }
    if (lit && world.isRegistered(lit)) {
      const ls = world.store(lit); const ld = ls.data as Record<string, ArrayLike<number>>;
      for (let k = 0; k < ls.size; k++) { if (!ld.lit?.[k]) continue; if (n++ >= this.cfg.maxHearths) return; const se = ls.dense[k]!; const sc = world.isRegistered(Sprite) && world.has(se, Sprite) ? world.get(se, Sprite)!.scale || 1 : 1; emit(se, 1, 1, 0, false, sc); }
    }
  }
}
