/**
 * VehicleView: client-side vehicle presentation. Takes plain snapshots of core's Vehicle/VehicleSeats/Hitch state
 * (render does not depend on @engine/gameplay; the client maps components -> VehicleSnapshot), smooths them per frame
 * (shortest-arc heading, exponential position, snap on teleport), and owns proxy entities in the view world:
 *  - one billboard Sprite per footprint segment (long vehicles are several depth-sorted segments; facing = heading so
 *    the 8-direction art row follows AssetRegistry.directionIndex), swapped to `_int` cutaway sprites while the local
 *    player is inside a camper,
 *  - headlight LightSources ahead of the heading (a cone of 3 growing circles; 1 on lowend) when the engine is on and
 *    it is dark.
 * Trailers (snapshot.parent != 0) are re-posed from the SMOOTHED tow's rear hitch with their own smoothed BROADCAST
 * heading (core Vehicle.heading of the trailer, ADR-101; no client articulation solve), so
 * the joint never separates between snapshots. Riders are returned as RiderPlacement (seat anchor, quantized facing,
 * depth-nudged behind the segment so the body crops the legs); the caller writes them to the rider entity's
 * Transform (no PrevTransform interpolation); gameplay sets the rider's AnimState to Sit (13, ADR-101).
 */
import { Transform, type Entity, type World } from "@engine/core";
import { VIEW_COS, VIEW_SIN } from "@engine/world";
import { LightSource, Occluder, Shadow, Sprite, SpriteFlag, TintNeutral } from "../components.js";
import type { AssetRegistry } from "@engine/assets";
import {
  PoseSmoother, RIDER_DK_CABIN, RIDER_DK_OPEN, dirAngle, hasInterior, headlightCone, insideFootprint, isPowered, quantizeDir8,
  seatAnchors, segmentCount, segmentU, toWorld, trailerPose, depthNudge, footprintKeyAt, type VehicleRenderDef,
} from "./layout.js";
import { modelHeight, modelZScale } from "./model.js";
import type { InteriorRegion } from "./interiorPass.js";
import { ART_INTERIOR, resolveVehicleArt, type VehicleArtBinding, type VehicleArtTable } from "./artPack.js";
import { PLAYER_HEIGHT_Z, tallerThanPlayer } from "./scale.js";
import { artSeat, windowBand } from "./seats.js";
import { vehicleSpriteKey } from "./atlas.js";
import { vehiclePaint } from "./paint.js";

export interface VehicleSnapshot {
  /** stable id (net id) */ key: number; def: VehicleRenderDef;
  x: number; y: number; z?: number; heading: number; drift?: number; speed?: number;
  /** VehicleSeats.occupant (rider keys, 0 = empty), index = seat */ occupants?: readonly number[];
  /** Hitch.parentNetId: the tow this trailer hangs on (0 = none) */ parent?: number;
  /** engine on (driver present / ignition); default: occupied seat 0 or |speed| >= 0.25 */ on?: boolean;
  /** core VehicleState byte (ADR-101): bit 0 engineOn, bit 1 headlights. When present it gates the headlight cone. */ state?: number;
  /** ADR-519: gameplay Vehicle.paint pick (1..240; 0 / absent = Art's default colour) */ paint?: number;
}
export interface VehicleViewOpts {
  /** 0 (day) .. 1 (night); headlights scale with it and are off below ~0.15 */ darkness: number;
  lowEnd?: boolean;
  /** rider key of the local player (cutaway when seated in an interior vehicle) */ localRider?: number;
  /** local player's world position (cutaway when standing inside a parked interior vehicle) */ localPos?: { x: number; y: number };
  /** localPlayerVehicle(world, eid) from gameplay (net id of the vehicle the local player drives, or null): cutaway it */ localVehicle?: number | null;
  /** rider keys are entities of this view world: suppress their ground Shadow while seated (default true; Art 64357f1) */ riderShadows?: boolean;
  /** drift yaw added to the drawn heading (fraction of Vehicle.drift) */ driftYaw?: number;
  /** Camera view rotation in quarter turns (IsoConfig.view, ADR-253): depth keys and the camera ray are in view space. */
  view?: number;
  /** World (tile) position on screen? Off-screen vehicles skip their streamed art page (no pageReady touch), so the
   *  LRU can evict it for visible ones; without this a full pool of off-screen pages starves e.g. car_compact. */
  inView?: (x: number, y: number) => boolean;
}
export interface VehicleSpatial { insert(e: Entity, x: number, y: number): void; remove(e: Entity): void }
export interface RiderPlacement { rider: number; vehicle: number; seat: number; x: number; y: number; z: number; facing: number; cropped: boolean;
  /** ADR-518: rider rows to show, 1x px above the seat pivot (the doll's seat socket): pixels below `bottom` and above
   *  `top` are clipped (top 0 = no top clip). Absent = draw the whole rider. */
  clip?: { bottom: number; top: number } }
export interface VehiclePose { x: number; y: number; z: number; heading: number; dir: number; interior: boolean }

interface Rec { smooth: PoseSmoother; segs: Entity[]; segIds: number[]; intIds: number[]; lights: Entity[]; def: VehicleRenderDef; pose: VehiclePose; seen: number;
  art: VehicleArtBinding | null; body: Entity | undefined; zk: number; /** facing whose art page this rec holds a refcount on */ artFacing?: number;
  /** ADR-518: body frame extent around the pivot for facing f (rider depth) */ geom?: { f: number; top: number; below: number } }
/** ADR-518: depth-key margin of an Art-seated rider over the vehicle body (+ = drawn after the sprite). */
export const RIDER_DK_ART = 0.04;
/** ADR-518: rider rows (1x px from the seat socket) that must beat the body: "over" seats down to the feet / up to the head. */
export const RIDER_LEG_PX = 26, RIDER_HEAD_PX = 34;
/** Sprite outline margin the vertex shader adds to every quad (px). */
const OUTLINE_PX = 1;
/** ADR-518: clip that hides a rider entirely (a seat with no window in the Art). */
export const RIDER_CLIP_HIDDEN = { bottom: 1e4, top: 0 } as const;
/** Streaming hooks (AtlasManager): Art vehicle sheets are retained per live vehicle and released when it leaves; facing-split
 *  art (dirFrames) streams one page per facing group, so the refcount follows the drawn `facing`. */
export interface VehiclePages { retainSprite(id: number, facing?: number): void; releaseSprite(id: number, facing?: number): void; pageReady(id: number, prio?: number, facing?: number): boolean }
export const VEHICLE_STATE_ENGINE_ON = 1, VEHICLE_STATE_HEADLIGHTS = 2;

export class VehicleView {
  readonly recs = new Map<number, Rec>();
  /** Open interiors this frame (local player inside) for the sprite interior pass: IsoRenderer.setInterior(view.interiors, view.interiorIds, view.interiorWall). */
  readonly interiors: InteriorRegion[] = [];
  /** _int cutaway segment sprite ids (routed as interior floor). */
  readonly interiorIds = new Set<number>();
  /** Art camper_interior_wall sprite id (-1 = not in the pack; -2 = not looked up yet). */
  interiorWall = -2;
  private readonly art: boolean | VehicleArtTable | undefined; private readonly pages: VehiclePages | undefined;
  private frame = 0;
  /** Visible vehicles with an Art binding whose streamed page is not resident yet (placeholder shown); 0 = all Art. */
  artPending = 0;
  /** seated rider entity -> its Shadow alpha before seating (restored on exit) */
  private readonly hiddenShadow = new Map<number, number>();
  private readonly iso: { tileH: number; zStep: number }; private readonly zf: number; private readonly spatial: VehicleSpatial | undefined;
  /** spatial: the renderer's chunked index when setSpatialIndex is used (proxies must be in it to be drawn). */
  constructor(private readonly world: World, private readonly registry: AssetRegistry, o: { iso?: { tileH: number; zStep: number }; zFactor?: number; spatial?: VehicleSpatial; art?: boolean | VehicleArtTable; pages?: VehiclePages } = {}) {
    this.art = o.art; this.pages = o.pages;
    this.iso = o.iso ?? { tileH: 32, zStep: 16 }; this.zf = o.zFactor ?? 1 / 3; this.spatial = o.spatial;
  }

  pose(key: number): VehiclePose | undefined { return this.recs.get(key)?.pose; }

  sync(list: readonly VehicleSnapshot[], dt: number, o: VehicleViewOpts): RiderPlacement[] {
    const w = this.world; this.frame++; const out: RiderPlacement[] = [];
    this.interiors.length = 0; this.interiorIds.clear(); this.artPending = 0;
    if (this.interiorWall === -2) this.interiorWall = this.sid(ART_INTERIOR.wall);
    const byKey = new Map(list.map((s) => [s.key, s]));
    // tows first so trailers read the smoothed tow pose (chains: trailer of trailer)
    const order = [...list].sort((a, b) => depthOf(a, byKey) - depthOf(b, byKey));
    for (const s of order) {
      let r = this.recs.get(s.key);
      if (!r || r.def !== s.def) { if (r) this.drop(r); r = this.create(s.def); this.recs.set(s.key, r); }
      r.seen = this.frame;
      const sm = r.smooth.update({ x: s.x, y: s.y, z: s.z ?? 0, heading: s.heading, drift: s.drift ?? 0 }, dt);
      let x = sm.x, y = sm.y, h = sm.heading + sm.drift * (o.driftYaw ?? 0);
      const tow = s.parent ? this.recs.get(s.parent) : undefined;
      if (tow && tow.seen === this.frame) { const p = trailerPose(tow.def, tow.pose.x, tow.pose.y, tow.pose.heading, s.def, sm.heading); if (p) { x = p.x; y = p.y; h = p.heading; } }
      const dir = quantizeDir8(h), hq = dirAngle(dir), z = sm.z;
      const occ = s.occupants ?? [];
      const inside = hasInterior(s.def) && ((o.localVehicle != null && o.localVehicle === s.key) || (o.localRider !== undefined && o.localRider !== 0 && occ.includes(o.localRider)) || (!!o.localPos && insideFootprint(s.def, x, y, h, o.localPos.x, o.localPos.y, -0.1)));
      r.pose = { x, y, z, heading: h, dir, interior: inside };
      if (inside) { this.interiors.push({ cx: x, cy: y, heading: dirAngle(dir), length: s.def.footprint.length, width: s.def.footprint.width }); for (const id of r.intIds) if (id >= 0) this.interiorIds.add(id); }
      // segments: positions on the QUANTIZED heading so the pieces line up with the art row
      const n = r.segs.length;
      // Art body: one billboard (8-dir row = heading + art offset), shown once its streamed page is resident; the
      // placeholder segments stay visible meanwhile (and in the interior cutaway - Art has no per-segment _int pieces).
      const vis = !o.inView || o.inView(x, y);
      // facing page refcount: retain the new facing before releasing the old (same page -> no churn)
      const af = r.art ? hq + r.art.facingOffset : 0;
      if (r.art && r.body !== undefined && r.artFacing !== af) { this.pages?.retainSprite(r.art.spriteId, af); if (r.artFacing !== undefined) this.pages?.releaseSprite(r.art.spriteId, r.artFacing); r.artFacing = af; }
      const artOn = !!r.art && r.body !== undefined && !inside && vis && (!this.pages || this.pages.pageReady(r.art.spriteId, Infinity, af));
      if (r.art && r.body !== undefined && !inside && vis && !artOn) this.artPending++;
      if (r.body !== undefined) {
        const b = r.body; w.set(b, Transform, { x, y, z, facing: hq + r.art!.facingOffset });
        const sp = w.get(b, Sprite)!; const sc = r.art!.scale;
        // ADR-519: Art's paint through the tintmask (Sprite.tint + TintNeutral); was always tint 0 = unpainted grey-beige
        const pt = vehiclePaint(r.art!.key, s.paint); const tint = pt?.tint ?? 0;
        if (sp.scale !== sc || sp.tint !== tint) w.set(b, Sprite, { ...sp, scale: sc, tint });
        if (pt && w.isRegistered(TintNeutral) && !w.has(b, TintNeutral)) w.add(b, TintNeutral, { neutral: pt.neutral, strength: pt.strength });
        if (artOn) this.spatial?.insert(b, x, y); else this.spatial?.remove(b);
        // ADR-518: true-scale bodies taller than the player (box truck, vans, campers, semi, tall trailers) fade like the
        // tall placeholder segments do when they cover the local player (Footprint sprites only occlude via an Occluder)
        if (tallerThanPlayer(s.def) && !w.has(b, Occluder)) w.add(b, Occluder, { fade: 0.45 });
      }
      for (let i = 0; i < n; i++) {
        const [sx, sy] = toWorld(x, y, hq, segmentU(s.def, i), 0); const e = r.segs[i]!;
        w.set(e, Transform, { x: sx, y: sy, z, facing: h }); if (artOn) this.spatial?.remove(e); else this.spatial?.insert(e, sx, sy); // Sprite.scale 0 draws at 1: hide via the index
        const id = inside && r.intIds[i]! >= 0 ? r.intIds[i]! : r.segIds[i]!; const sp = w.get(e, Sprite);
        const fl = inside ? SpriteFlag.Footprint | SpriteFlag.Cutaway : SpriteFlag.Footprint; // cutaway: no height depth so the occupant stands on the floor
        if (sp && (sp.spriteId !== id || sp.flags !== fl)) w.set(e, Sprite, { ...sp, spriteId: id, flags: fl });
        if (w.has(e, Occluder) && (inside || artOn)) w.remove(e, Occluder);
        else if (!w.has(e, Occluder) && !inside && !artOn && modelHeight(s.def) > PLAYER_HEIGHT_Z) w.add(e, Occluder, { fade: 0.45 });
      }
      // headlights
      const on = isPowered(s.def) && (s.state !== undefined ? (s.state & VEHICLE_STATE_HEADLIGHTS) !== 0 && (s.state & VEHICLE_STATE_ENGINE_ON) !== 0
        : (s.on ?? ((occ[0] ?? 0) !== 0 || Math.abs(s.speed ?? 0) >= 0.25)));
      const k = on ? Math.min(1, Math.max(0, (o.darkness - 0.15) / 0.5)) : 0;
      const cone = k > 0 ? headlightCone(s.def, !!o.lowEnd) : [];
      while (r.lights.length > cone.length) { const e = r.lights.pop()!; this.spatial?.remove(e); w.destroy(e); }
      for (let i = 0; i < cone.length; i++) {
        const c = cone[i]!; let e = r.lights[i];
        if (e === undefined) { e = w.create(); w.add(e, Transform, { x, y, z: 0, facing: 0 }); w.add(e, LightSource, { r: 1, g: 0.93, b: 0.75, radius: c.radius, intensity: 0, flicker: 0 }); r.lights.push(e); }
        const [lx, ly] = toWorld(x, y, h, c.u, 0); w.set(e, Transform, { x: lx, y: ly, z: 0, facing: 0 });
        w.set(e, LightSource, { r: 1, g: 0.93, b: 0.75, radius: c.radius, intensity: c.intensity * k, flicker: 0 });
      }
      // riders. ADR-518: while the true-scale Art body is drawn, riders follow Art's seats (seats.vehicles.json): the
      // seat H-point is placed on the body's own plane (depth key = the body pixel at that screen row) + a small margin so
      // the rider draws just after the sprite; "window" seats clip to the beltline..roof band, seats Art has no window for
      // are clipped away (hidden behind the body). Placeholder / interior cutaway: the vehicles.json anchors as before.
      const seats = seatAnchors(s.def, r.zk);
      // view space (ADR-253 camera rotation): depth key = vu + vv + z zf, the camera ray is +(1, 1) in view space
      const vq = (o.view ?? 0) & 3, vc = VIEW_COS[vq]!, vsn = VIEW_SIN[vq]!;
      const vu = (a: number, b: number) => vc * a - vsn * b, vv = (a: number, b: number) => vsn * a + vc * b;
      const bodyKey = vu(x, y) + vv(x, y) + z * this.zf;
      const hv = hq + vq * (Math.PI / 2), cu = (Math.cos(hv) + Math.sin(hv)) / Math.SQRT2, cv = (Math.cos(hv) - Math.sin(hv)) / Math.SQRT2;
      for (let i = 0; i < occ.length; i++) {
        const rid = occ[i]!; if (!rid) continue;
        const as = artOn ? artSeat(s.def, i) : undefined;
        if (as) {
          const [px, py] = toWorld(x, y, hq, as.u, as.v); const p = { x: px, y: py, z: z + as.z };
          const band = as.draw === "window" ? windowBand(s.def, i, cu, cv) : undefined;
          const draw = as.draw === "window" && !band ? "hidden" : as.draw;
          // screen height of the seat above the body pivot (z units): z - view-axis offset x (tileH / 2) / zStep
          const dxy = vu(px, py) + vv(px, py) - (vu(x, y) + vv(x, y)); const hz = as.z - dxy * (this.iso.tileH / 2) / this.iso.zStep;
          // the body is a Footprint billboard: its drawn depth is the vertex-interpolated key (footprintKeyAt), far nearer
          // than its pivot plane. The rider (planar: key + rows x zPerPx) must beat it over every row it shows - both ends of
          // its rows suffice (both keys are linear in the row). Hidden riders sit behind the body plane (and are clipped).
          const zpp = this.zf / this.iso.zStep, hs = hz * this.iso.zStep; const g = this.bodyGeom(r, af + vq * (Math.PI / 2));
          let need = bodyKey + hz * this.zf - (draw === "hidden" ? RIDER_DK_ART : 0);
          if (g && draw !== "hidden") {
            const lo = band ? band.bottom : -RIDER_LEG_PX, hi = band ? band.top : RIDER_HEAD_PX;
            for (const d of [lo, hi]) need = Math.max(need, footprintKeyAt(bodyKey, hs + d, g.top, g.below, zpp, this.iso.tileH / 2) - 0.02 - d * zpp);
            need += RIDER_DK_ART;
          }
          // move along the view axis (screen position unchanged): view-space (d, d, k d) = world R(-view) (d, d)
          const key = vu(p.x, p.y) + vv(p.x, p.y) + p.z * this.zf, kk = this.iso.tileH / this.iso.zStep, dd = (need - key) / (2 + kk * this.zf);
          p.x += (vc + vsn) * dd; p.y += (vc - vsn) * dd; p.z += dd * kk;
          const clip = band ? { bottom: band.bottom, top: band.top } : draw === "hidden" ? { ...RIDER_CLIP_HIDDEN } : undefined;
          out.push({ rider: rid, vehicle: s.key, seat: i, x: p.x, y: p.y, z: p.z, facing: hq, cropped: draw !== "over", ...(clip ? { clip } : {}) });
          continue;
        }
        const a = seats[i] ?? { u: 0, v: 0, z: 0, cabin: false };
        const [px, py] = toWorld(x, y, hq, a.u, a.v); const p = { x: px, y: py, z: z + a.z };
        // depth relative to the seat's segment centre
        const si = Math.min(n - 1, Math.max(0, Math.floor((s.def.footprint.length / 2 - a.u) / (s.def.footprint.length / n))));
        const [cx, cy] = toWorld(x, y, hq, segmentU(s.def, si), 0); const segKey = cx + cy + z * this.zf, key = p.x + p.y + p.z * this.zf;
        depthNudge(p, segKey + (a.cabin ? RIDER_DK_CABIN : RIDER_DK_OPEN) - key, this.iso, this.zf);
        out.push({ rider: rid, vehicle: s.key, seat: i, x: p.x, y: p.y, z: p.z, facing: hq, cropped: a.cabin });
      }
    }
    for (const [k, r] of this.recs) if (r.seen !== this.frame) { this.drop(r); this.recs.delete(k); }
    if (o.riderShadows !== false) {
      const now = new Set(out.map((p) => p.rider));
      for (const rid of now) { const e = rid as Entity; if (this.hiddenShadow.has(rid) || !w.isAlive(e)) continue; const sh = shadowOf(w, e); if (sh) { this.hiddenShadow.set(rid, sh.alpha); if (sh.alpha !== 0) w.set(e, Shadow, { ...sh, alpha: 0 }); } }
      for (const [rid, a] of this.hiddenShadow) if (!now.has(rid)) { const e = rid as Entity; this.hiddenShadow.delete(rid); const sh = w.isAlive(e) ? shadowOf(w, e) : undefined; if (sh) w.set(e, Shadow, { ...sh, alpha: a }); }
    }
    return out;
  }

  /** Art body frame px above / below the pivot for the drawn facing (outline included), cached per facing. */
  private bodyGeom(r: Rec, facing: number): { top: number; below: number } | undefined {
    if (!r.art) return undefined; if (r.geom && r.geom.f === facing) return r.geom;
    try { const s = this.registry.sprite(r.art.spriteId); const f = this.registry.dirFrame(r.art.spriteId, s.animList[0]!.name, facing, 0);
      r.geom = { f: facing, top: f.anchorY + OUTLINE_PX, below: f.h - f.anchorY + OUTLINE_PX }; return r.geom; } catch { return undefined; }
  }
  private sid(key: string): number { try { this.registry.byKey(key); return this.registry.id(key); } catch { return -1; } }
  private create(def: VehicleRenderDef): Rec {
    const w = this.world; const n = segmentCount(def); const segs: Entity[] = [], segIds: number[] = [], intIds: number[] = [];
    for (let i = 0; i < n; i++) {
      const id = this.sid(vehicleSpriteKey(def.id, i)); if (id < 0) continue;
      const e = w.create(); w.add(e, Transform, { x: 0, y: 0, z: 0, facing: 0 }); w.add(e, Sprite, { spriteId: id, frameId: 0, flags: SpriteFlag.Footprint, scale: 1, tint: 0 });
      segs.push(e); segIds.push(id); intIds.push(this.sid(vehicleSpriteKey(def.id, i, true)));
    }
    const art = this.art ? resolveVehicleArt(this.registry, def, this.art === true ? undefined : this.art) : null; let body: Entity | undefined;
    if (art) { body = w.create(); w.add(body, Transform, { x: 0, y: 0, z: 0, facing: 0 }); w.add(body, Sprite, { spriteId: art.spriteId, frameId: 0, flags: SpriteFlag.Footprint, scale: art.scale, tint: 0 }); }
    return { smooth: new PoseSmoother(), segs, segIds, intIds, lights: [], def, pose: { x: 0, y: 0, z: 0, heading: 0, dir: 0, interior: false }, seen: 0, art, body, zk: modelZScale(def) };
  }
  private drop(r: Rec): void {
    if (r.art && r.body !== undefined && r.artFacing !== undefined) this.pages?.releaseSprite(r.art.spriteId, r.artFacing); delete r.artFacing;
    for (const e of [...r.segs, ...r.lights, ...(r.body !== undefined ? [r.body] : [])]) { this.spatial?.remove(e); if (this.world.isAlive(e)) this.world.destroy(e); } r.segs = []; r.lights = []; r.body = undefined;
  }
  dispose(): void { for (const r of this.recs.values()) this.drop(r); this.recs.clear(); }
}
function depthOf(s: VehicleSnapshot, m: Map<number, VehicleSnapshot>): number { let d = 0, c = s; while (c.parent && d < 8) { const p = m.get(c.parent); if (!p) break; c = p; d++; } return d; }

function shadowOf(w: World, e: Entity): { alpha: number; length: number } | undefined { try { return w.get(e, Shadow) as { alpha: number; length: number } | undefined; } catch { return undefined; } }
