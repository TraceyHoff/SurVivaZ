/**
 * ADR-533: dendritic river/stream networks with realistic flow (outside region zero).
 *
 * Region zero keeps the ADR-255 starter layout byte-identical (the sine river stays); every
 * other region gets a network of streams instead of only the one sine river. Sources sit on
 * high ground — mountain springs (massif flanks), snowmelt (high non-massif ground) — and each
 * stream is carved by the descent-following walk generalised from the ADR-386 spillway:
 * lowest-neighbour descent toward a target water body, bounded steps, never walking away from
 * the target. Tributaries join earlier streams (a confluence), so width grows downstream
 * (1 tile headwater → 2–3 at the mouth). Every channel ends at a lake, great lake, pond, the
 * sine river, the biome sea, an earlier channel, or — when the walk boxes itself in — a sink
 * pond/marsh (ADR-535 item 5: mud tile + reeds), never a half-carved ditch.
 *
 * Channel levels descend monotonically by construction: the walk carries a running level that
 * drops at least 1 per tile and never rises above the natural ground (it carves a gorge
 * through saddles instead), floored at the mouth level (1 for sea/lake water, parent level + 1
 * for a confluence). Steps require natural ground at or above the mouth floor minus 1, so a
 * channel is never perched more than 1 level above the ground it crosses; a walk that cannot
 * stay above its outlet ends in a sink instead of crossing a closed basin. Mouths get a
 * delta/sand fan where the river meets still water (tile-level sand band, reuses shore/sand
 * tiles).
 *
 * Pure layout + carve, computed once per region and memoised by the generator (cap 16, like
 * massifs/canyons). Generation-time only; no new per-tick scans, nothing per frame. The
 * planner reads the PRE-network height field (massifs + benches + canyons, no network carve),
 * so siting never depends on call order and never sees its own carve.
 */
import { fnv1a, Rng } from "@engine/core";

/** ADR-533: the walk stays inside the region's own span (a channel must not cross a region
 *  boundary, where the neighbouring region's layout would cut it off) — the ADR-386
 *  SPILLWAY_WINDOW value. */
export const RIVER_WINDOW = 767;
/** ADR-533: farthest low water a stream reaches for (ring scan, spillway pattern). */
/** How far a source looks for water (ring scan). 200: a target farther than that needs a walk
 *  longer than the step budget (3x + 40, capped at RIVER_MAX_LEN 600) anyway, so scanning
 *  farther only burns ring-scan time. */
export const RIVER_TARGET_RANGE = 200;
/** ADR-533: longest channel (tiles) — the step budget (3x + 40) for a target at the 200 range. */
export const RIVER_MAX_LEN = 600;
/** ADR-533: a tributary source sits this far (tiles) from its join point on the parent. */
export const TRIBUTARY_MIN_DIST = 15;
export const TRIBUTARY_MAX_DIST = 45;
/** ADR-533: sink pond disc radius (tiles) and mud-ring outer radius. */
export const SINK_RADIUS = 2;
export const SINK_MUD_RADIUS = 3;
/** ADR-533: a river mouth is boat-enterable when its last channel tile is at most this level
 *  (MAX_UNAIDED_CLIMB is 3, so a mouth at level 3 is the steepest a boat can climb into from
 *  the lake). Higher mouths are waterfall mouths — real, but not enterable. */
export const BOAT_ENTERABLE_MOUTH_LEVEL = 3;

/** One painted network tile (the generator and the current lookup share this). */
export interface NetTileInfo {
  kind: "channel" | "sinkWater" | "delta" | "sinkMud";
  /** Water surface level (flow-encoded by the generator) for channel/sinkWater; 1 for delta sand. */
  level: number;
  /** Downstream unit direction for channel tiles (0, 0 for still sink water / delta / mud). */
  dx: number; dy: number;
}

/** A massif as the planner sees it (centre + disc radius + slope sector — the generator maps
 *  its Massif[]; the slope sector is the ADR-531 approach wedge, kept clear of channels). */
export interface RiverMassif { cx: number; cy: number; radius: number; slopeDir: number; slopeHalfWidth: number }

/** Why a walk boxed in: the end tile and, per neighbour, why it was rejected. Stored on sink
 *  channels so tests can assert every sink was truly boxed in (not a planning bug). */
export interface WalkBoxedDetail {
  x: number; y: number;
  neighbours: { x: number; y: number; h: number; lowWater: boolean; blocked: boolean; channel: boolean; seen: boolean; dist: number; why: string }[];
}

/** One stream: centreline in walk order (source -> mouth), painted tiles, and its end. */
export interface RiverChannel {
  source: { x: number; y: number; kind: "spring" | "snowmelt" | "tributary" | "outflow" };
  /** Centreline tiles in walk order with their carved levels (non-increasing downstream). */
  centreline: { x: number; y: number; level: number }[];
  /** All painted water tiles (centreline + widened sides), each with its downstream direction. */
  tiles: { x: number; y: number; level: number; dx: number; dy: number }[];
  /** The water tile the channel meets (lake/river/sea tile, parent channel tile, or sink centre). */
  end: { x: number; y: number };
  endKind: "water" | "channel" | "sink";
  /** Target water level (0), parent channel level at the join, or the sink water level. */
  endLevel: number;
  /** Boxed-in fallback: a sink pond/marsh at the walk's end (water disc + mud ring). */
  sink?: { x: number; y: number; r: number; level: number };
  /** Why the walk boxed in (sink channels only) — the diagnostic record. */
  boxedDetail?: WalkBoxedDetail;
  /** Sand fan at a still-water mouth (tiles in the target water, just past the mouth). */
  delta: { x: number; y: number }[];
  /** Stream order: 1 = headwater; a channel fed by a tributary is 2+, widened downstream. */
  order: number;
  /** Painted width at the mouth (1..3 tiles). */
  widthAtMouth: number;
  /** Carve footprint (centreline + widening + sink/delta), absolute coords. */
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** A region's whole network: channels plus the painted-tile lookup (absolute coords). */
export interface RiverNetwork {
  channels: RiverChannel[];
  tiles: Map<string, NetTileInfo>;
  bbox: { x0: number; y0: number; x1: number; y1: number } | undefined;
}

export const EMPTY_RIVER_NETWORK: RiverNetwork = { channels: [], tiles: new Map(), bbox: undefined };

/** What the planner needs from the generator (all region-local except heightAt, absolute). */
export interface RiverNetworkContext {
  seed: number;
  rx: number; ry: number;
  ox: number; oy: number;
  /** Pre-network natural height at absolute (tx, ty) (massifs + benches + canyons). */
  heightAt(tx: number, ty: number): number;
  /** True when the region-local tile is sea-level water a stream may end at (biome sea, lake,
   *  pond, great lake, sine river, canyon-floor water — never elevated-lake or spillway water). */
  isLowWater(lx: number, ly: number): boolean;
  /** True when the region-local tile must never be walked on (elevated disc + rim, island, spillway). */
  isBlocked(lx: number, ly: number): boolean;
  massifs: RiverMassif[];
  /** Geometric water anchors (absolute coords) for the room check and target selection: the
   *  sited layout's lake/pond/greatLake discs and the sine river's sampled centreline. The
   *  planner measures distances to these instead of scanning tiles ring by ring. */
  waterAnchors: {
    discs: { x: number; y: number; r: number }[];
    riverPts: { x: number; y: number }[];
    riverWidth: number;
  };
  /** ADR-534: the huge lakes (absolute coords) this region must connect — each one gets
   *  >= 2 feeder rivers in and >= 1 outflow river out (see planRiverNetwork). Empty when
   *  the region has no huge lake. */
  hugeLakes?: { x: number; y: number; r: number }[];
}

const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const keyOf = (x: number, y: number): string => `${x},${y}`;

/**
 * ADR-533: one descent walk, generalised from the ADR-386 spillway. Starts at `start`, aims at
 * `target`, and ends adjacent to lower water (endKind "water") or to an earlier channel tile
 * (endKind "channel" — a confluence, accepted only when the parent sits at or below the
 * stream's running level, so water never flows uphill into it). Each step keeps (or barely
 * increases) the distance to the target and takes the lowest ground among those steps; steps
 * require natural ground >= `minNatural`, so the channel never crosses a closed basin below
 * its outlet. The running level drops >= 1 per tile and never rises above the natural ground
 * (it carves a gorge through saddles instead), floored at `floor` — so the returned levels
 * are non-increasing downstream by construction, and a tile is never perched more than 1
 * above the ground it crosses. `boxedIn` means no valid step: the caller ends the channel in
 * a sink at the path's end instead of leaving a half-carved ditch. `corridor` (ADR-534
 * feeders) pins the walk to a band around the start→target line: the greedy-lowest rule
 * otherwise follows valleys far off the beeline and wanders into dead ends (a 61-tile
 * approach burned 427 steps and died 9 tiles short of the lake), while the corridor's line
 * was pre-checked clear — so the walk stays in viable terrain and arrives.
 */
export function walkStream(o: {
  start: { x: number; y: number }; target: { x: number; y: number };
  maxSteps: number; minNatural: number; floor: number;
  heightAt(x: number, y: number): number;
  isLowWater(x: number, y: number): boolean;
  channelAt(x: number, y: number): { level: number } | undefined;
  isBlocked(x: number, y: number): boolean;
  inWindow(x: number, y: number): boolean;
  corridor?: { x1: number; y1: number; x2: number; y2: number; half: number };
  // ADR-534 feeders only: on exactly flat ground prefer the neighbour closest to the target.
  // The default (first-N4 tie-break) is kept for every other walk, so the ADR-533 mains and
  // the region-zero starter river stay byte-identical.
  preferTargetOnTie?: boolean;
}): { path: { x: number; y: number }[]; levels: number[]; end: { x: number; y: number }; endKind: "water" | "channel"; endLevel: number; boxedIn: boolean; boxedDetail?: WalkBoxedDetail } {
  const { target, maxSteps, minNatural, floor } = o;
  const distTo = (x: number, y: number): number => Math.hypot(x - target.x, y - target.y);
  // Perpendicular distance from (x, y) to the corridor's start→target line.
  const corridorDist = o.corridor ? (x: number, y: number): number => {
    const { x1, y1, x2, y2 } = o.corridor!;
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    return Math.abs((x - x1) * (y2 - y1) - (y - y1) * (x2 - x1)) / len;
  } : undefined;
  const path: { x: number; y: number }[] = [{ ...o.start }];
  const levels: number[] = [Math.max(floor, o.heightAt(o.start.x, o.start.y) - 1)];
  const seen = new Set<string>([keyOf(o.start.x, o.start.y)]);
  let cur = o.start;
  let level = levels[0]!;
  for (let step = 0; step < maxSteps; step++) {
    // End when a neighbour is water (the mouth — a high cliff-top shore makes a waterfall
    // mouth, which is real geography: the stream reaches the water, it just is not a
    // boat-enterable one) or a channel we can flow into (at or below our level).
    for (const [dx, dy] of N4) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (o.isLowWater(nx, ny)) return { path, levels, end: { x: nx, y: ny }, endKind: "water", endLevel: 0, boxedIn: false };
      const ch = o.channelAt(nx, ny);
      if (ch && ch.level <= level) return { path, levels, end: { x: nx, y: ny }, endKind: "channel", endLevel: ch.level, boxedIn: false };
    }
    const curD = distTo(cur.x, cur.y);
    let best: { x: number; y: number; h: number } | undefined;
    for (const [dx, dy] of N4) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (seen.has(keyOf(nx, ny)) || !o.inWindow(nx, ny) || o.isBlocked(nx, ny)) continue;
      if (o.isLowWater(nx, ny)) continue; // water is an end, never a step
      if (o.channelAt(nx, ny)) continue; // a channel tile is an end, never a step
      if (distTo(nx, ny) > curD + 0.5) continue; // never walk away from the target (the spillway's bound — looser bounds let the walk wander into spits and dead ends and burn its step budget)
      if (corridorDist && corridorDist(nx, ny) > o.corridor!.half) continue; // ADR-534: stay in the pre-checked band
      const h = o.heightAt(nx, ny);
      if (h < minNatural) continue; // never cross ground below the outlet (a closed basin)
      // Lowest ground wins; on exactly flat ground the neighbour closest to the target wins
      // when preferTargetOnTie is set (ADR-534 feeders — the default first-N4 tie-break
      // wandered arbitrarily on plateaus and boxed the walk in against its own path and the
      // corridor's edge).
      if (!best || h < best.h || (o.preferTargetOnTie && h === best.h && distTo(nx, ny) < distTo(best.x, best.y))) best = { x: nx, y: ny, h };
    }
    if (!best) {
      // Boxed in: record why each neighbour was rejected (diagnostics for the sink rate).
      const neighbours = N4.map(([dx, dy]) => {
        const nx = cur.x + dx, ny = cur.y + dy;
        const h = o.heightAt(nx, ny);
        const lowWater = o.isLowWater(nx, ny);
        const blocked = o.isBlocked(nx, ny);
        const channel = !!o.channelAt(nx, ny);
        const seenN = seen.has(keyOf(nx, ny));
        const dist = distTo(nx, ny);
        let why = "ok";
        if (seenN) why = "seen";
        else if (!o.inWindow(nx, ny)) why = "window";
        else if (blocked) why = "blocked";
        else if (lowWater) why = "water";
        else if (channel) why = "channel";
        else if (dist > curD + 0.5) why = "dist";
        else if (corridorDist && corridorDist(nx, ny) > o.corridor!.half) why = "corridor";
        else if (h < minNatural) why = "low-ground";
        return { x: nx, y: ny, h, lowWater, blocked, channel, seen: seenN, dist: Math.round(dist * 10) / 10, why };
      });
      return { path, levels, end: { ...cur }, endKind: "water", endLevel: 0, boxedIn: true, boxedDetail: { x: cur.x, y: cur.y, neighbours } };
    }
    level = Math.max(floor, Math.min(level - 1, best.h));
    path.push({ x: best.x, y: best.y }); levels.push(level); seen.add(keyOf(best.x, best.y));
    cur = best;
  }
  return { path, levels, end: { ...cur }, endKind: "water", endLevel: 0, boxedIn: true };
}

/** Distance from absolute (ax, ay) to the nearest low water, measured geometrically to the
 *  water anchors (lake/pond/greatLake disc edges, sine-river centreline minus its width).
 *  O(anchors), not O(rings^2) — the ring scan this replaces was the plan's dominant cost.
 *  The river samples are ~8 tiles apart, so the sample distance overestimates the true
 *  distance by up to ~4; the room check subtracts that margin, so it only claims room when
 *  the true distance is almost certainly far enough. The biome sea and canyon-floor water
 *  are not anchors, so a source near one reads as farther from water than it is (a
 *  conservative "no room" — it builds as a waterfall mouth, and the walk still ends at the
 *  first water it touches, sea included). */
function nearestWaterDist(ctx: RiverNetworkContext, ax: number, ay: number): number {
  let best = Infinity;
  for (const d of ctx.waterAnchors.discs) best = Math.min(best, Math.hypot(ax - d.x, ay - d.y) - d.r);
  for (const p of ctx.waterAnchors.riverPts) best = Math.min(best, Math.hypot(ax - p.x, ay - p.y) - ctx.waterAnchors.riverWidth);
  return best;
}

/** The perimeter tiles of the Chebyshev ring at distance `ring` from (cx, cy), in order. */
function ringPerimeter(cx: number, cy: number, ring: number): [number, number][] {
  const out: [number, number][] = [];
  for (let x = cx - ring; x <= cx + ring; x++) { out.push([x, cy - ring]); out.push([x, cy + ring]); }
  for (let y = cy - ring + 1; y <= cy + ring - 1; y++) { out.push([cx - ring, y]); out.push([cx + ring, y]); }
  return out;
}

/** Nearest low-water tiles to absolute (ax, ay) in ring order (the spillway's ring scan), up
 *  to `want` distinct targets at least `minApart` tiles apart. `exclude` (absolute coords)
 *  skips tiles that must not be targets — the ADR-534 outflow scan excludes the huge lake
 *  itself, so it finds the nearest OTHER water. Targets are sorted by (1) room
 *  to descend — a stream drops >= 1 level per tile, so a target at least `sourceHeight - 3`
 *  tiles away lets the mouth reach a boat-enterable level (a nearer lake makes a waterfall
 *  mouth instead); (2) a low shore (a land neighbour at height <= LOW_SHORE); (3) distance. */
export const LOW_SHORE = 8;
function nearestWaterTargets(ctx: RiverNetworkContext, ax: number, ay: number, sourceHeight: number, want: number, minApart: number, exclude?: (x: number, y: number) => boolean): { x: number; y: number }[] {
  const lx0 = ax - ctx.ox, ly0 = ay - ctx.oy;
  const found: { x: number; y: number; shore: number; dist: number }[] = [];
  /** Collect one ring's water tiles as targets (same stride/minApart/shore logic as the
   *  spillway's scan). Returns true when `want` targets are collected. */
  const collectRing = (ring: number): boolean => {
    // Stride 2 along the perimeter: any water body spanning >= 2 consecutive perimeter
    // tiles (the sine river is 2–3 wide, lakes wider) is still caught, at half the layout
    // lookups. A 1-tile pond missed here is no loss — it is a poor target anyway.
    const perim = ringPerimeter(lx0, ly0, ring);
    for (let pi = 0; pi < perim.length; pi += 2) {
      const [x, y] = perim[pi]!;
      if (Math.abs(x) > RIVER_WINDOW || Math.abs(y) > RIVER_WINDOW) continue;
      if (!ctx.isLowWater(x, y)) continue;
      if (exclude && exclude(ctx.ox + x, ctx.oy + y)) continue;
      if (found.some((t) => Math.hypot(t.x - (ctx.ox + x), t.y - (ctx.oy + y)) < minApart)) continue;
      // Shore height: the lowest land neighbour (not water, not blocked) — Infinity when the
      // water tile has no land neighbour at all (mid-lake: the walk could never stand by it).
      let shore = Infinity;
      for (const [dx, dy] of N4) {
        const nx = x + dx, ny = y + dy;
        if (ctx.isLowWater(nx, ny) || ctx.isBlocked(nx, ny)) continue;
        shore = Math.min(shore, ctx.heightAt(ctx.ox + nx, ctx.oy + ny));
      }
      found.push({ x: ctx.ox + x, y: ctx.oy + y, shore, dist: Math.hypot(x - lx0, y - ly0) });
      if (found.length >= want) return true;
    }
    return false;
  };
  // Banded scan: start near the geometric nearest water (the feature distance from the
  // anchors) instead of ring 1. The empty rings before the first water body are the scan's
  // cost — 12k–47k layout lookups per plan — and the geometric distance locates that water
  // within ~4 tiles (river samples) to ~1 tile (disc edges), so a margin of 8 is safe.
  // The sea and canyon-floor water are not anchors, so a source whose nearest water is the
  // sea reads farther than it is; when the outward scan comes up short of `want` targets,
  // the inward scan below catches the closer water the estimate missed.
  const geoD = nearestWaterDist(ctx, ax, ay);
  const ringStart = Number.isFinite(geoD) ? Math.max(1, Math.floor(geoD) - 8) : 1;
  for (let ring = ringStart; ring <= RIVER_TARGET_RANGE; ring++) {
    if (collectRing(ring)) break;
  }
  if (found.length < want) {
    for (let ring = ringStart - 1; ring >= 1; ring--) {
      if (collectRing(ring)) break;
    }
  }
  const room = (dist: number): number => (dist >= Math.max(0, sourceHeight - BOAT_ENTERABLE_MOUTH_LEVEL) ? 0 : 1);
  found.sort((a, b) => room(a.dist) - room(b.dist) || (a.shore <= LOW_SHORE ? 0 : 1) - (b.shore <= LOW_SHORE ? 0 : 1) || a.dist - b.dist);
  return found.slice(0, want);
}

/** A tile inside a massif's slope sector (the ADR-531 approach wedge: the guaranteed ≤1-step
 *  path from the base ring to the summit). Channels stay out of it: a spring's channel running
 *  down the slope ray cuts a gorge across the very route the approach path takes, and the
 *  water + the gorge step sever the path. The wedge is the disc out to radius + 9 (the base
 *  ring) and the angle within slopeHalfWidth + 0.35 of slopeDir — the test's own wedge. */
function inSlopeWedge(ctx: RiverNetworkContext, x: number, y: number): boolean {
  for (const m of ctx.massifs) {
    const dx = x - m.cx, dy = y - m.cy;
    const d = Math.hypot(dx, dy);
    if (d > m.radius + 9) continue;
    let diff = Math.atan2(dy, dx) - m.slopeDir;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    if (Math.abs(diff) <= m.slopeHalfWidth + 0.35) return true;
  }
  return false;
}

/** A source candidate at absolute (x, y): high ground clear of water, blocks and earlier channels. */
function isSourceGround(ctx: RiverNetworkContext, channelAt: (x: number, y: number) => { level: number } | undefined, x: number, y: number, minH: number): boolean {
  const lx = x - ctx.ox, ly = y - ctx.oy;
  if (Math.abs(lx) > RIVER_WINDOW || Math.abs(ly) > RIVER_WINDOW) return false;
  if (ctx.isBlocked(lx, ly) || ctx.isLowWater(lx, ly) || channelAt(x, y)) return false;
  if (inSlopeWedge(ctx, x, y)) return false; // never source a stream inside the approach wedge
  return ctx.heightAt(x, y) >= minH;
}

/**
 * ADR-533: plan one region's network. Mains first (one spring per massif, then snowmelt),
 * then tributaries that join a main (guaranteed confluences — a tributary source is placed
 * on high ground near its join point and walks to it). ADR-534: then the huge-lake
 * connections — every huge lake in ctx.hugeLakes gets >= 2 feeder rivers in and >= 1
 * outflow river out (a feeder is a spring that walks to the lake's edge; an outflow is a
 * level-1 outlet stream from the lake's shore to the nearest other water). A main that
 * boxes in on every target ends in a sink pond at its longest attempt's end. Widths are
 * assigned in a second pass: a channel widens by 1 downstream of each tributary that joins
 * it (cap 3 tiles).
 */
export function planRiverNetwork(ctx: RiverNetworkContext): RiverNetwork {
  const heightAt = (x: number, y: number): number => ctx.heightAt(x, y);
  const rng = new Rng(fnv1a(`river:${ctx.rx},${ctx.ry}`, ctx.seed >>> 0));
  const tiles = new Map<string, NetTileInfo>();
  /** Centreline tiles of channels already built (level by tile) — the walks read this, so a
   *  later stream sees earlier channels as confluence targets while they are still being
   *  planned (the final `tiles` map is only painted at the end, after the widths pass). */
  const painted = new Map<string, number>();
  const channelAt = (x: number, y: number): { level: number } | undefined => {
    const level = painted.get(keyOf(x, y));
    return level === undefined ? undefined : { level };
  };
  /** The planner works in ABSOLUTE coords (the record and the tile map are absolute — the
   *  generator looks them up by absolute tile); the ctx water/block callbacks take
   *  region-local coords, so the wrappers below convert. */
  const lowWaterAt = (x: number, y: number): boolean => ctx.isLowWater(x - ctx.ox, y - ctx.oy);
  const blockedAt = (x: number, y: number): boolean => ctx.isBlocked(x - ctx.ox, y - ctx.oy);
  /** What a walk may not step on: the generator's blocks plus every slope wedge (a channel
   *  must never enter the approach sector — see inSlopeWedge). The walk's boxed-in report
   *  calls these "blocked". */
  const walkBlocked = (x: number, y: number): boolean => blockedAt(x, y) || inSlopeWedge(ctx, x, y);
  /** Per-plan tile cache for the walks: a walk queries each corridor tile ~twice as it passes
   *  (a tile beside the path is a neighbour for 2–3 consecutive steps), and every query costs
   *  a layout lookup plus a noise evaluation. One combined lookup per tile, cached, roughly
   *  halves the walk cost. Discarded with the plan (the generator's own lookups stay live). */
  const infoCache = new Map<string, { h: number; water: boolean; blocked: boolean }>();
  const tileInfo = (x: number, y: number): { h: number; water: boolean; blocked: boolean } => {
    const k = keyOf(x, y);
    let v = infoCache.get(k);
    if (!v) {
      v = { h: ctx.heightAt(x, y), water: lowWaterAt(x, y), blocked: walkBlocked(x, y) };
      infoCache.set(k, v);
    }
    return v;
  };
  const inWindow = (x: number, y: number): boolean => Math.abs(x - ctx.ox) <= RIVER_WINDOW && Math.abs(y - ctx.oy) <= RIVER_WINDOW;
  const channels: RiverChannel[] = [];
  // Join records for the width pass: parent channel index + centreline index of the join +
  // the side the tributary approached from (the channel widens toward the tributary first).
  const joins: { parent: number; atIndex: number; side: number }[] = [];

  /** Build one channel from a source: walk to the nearest water (up to 3 targets), else sink. */
  const buildMain = (sx: number, sy: number, kind: "spring" | "snowmelt"): RiverChannel | undefined => {
    const sourceHeight = heightAt(sx, sy);
    const tryTargets = (targets: { x: number; y: number }[]): ReturnType<typeof walkStream> | undefined => {
      let best: ReturnType<typeof walkStream> | undefined;
      for (const t of targets) {
        const w = walkStream({
          start: { x: sx, y: sy }, target: t,
          maxSteps: Math.min(RIVER_MAX_LEN, 3 * Math.ceil(Math.hypot(t.x - sx, t.y - sy)) + 40),
          minNatural: 0, floor: 1,
          heightAt: (x, y) => tileInfo(x, y).h,
          isLowWater: (x, y) => tileInfo(x, y).water,
          channelAt, isBlocked: (x, y) => tileInfo(x, y).blocked, inWindow,
        });
        if (!w.boxedIn) return w;
        if (!best || w.path.length > best.path.length) best = w;
      }
      return best;
    };
    const targets = nearestWaterTargets(ctx, sx, sy, sourceHeight, 3, 12);
    const best = tryTargets(targets);
    if (!best) return undefined; // no water in range at all — no channel, no ditch
    return finishChannel(kind, { x: sx, y: sy }, best);
  };

  /** Build a tributary into `parent` at centreline index `atIndex` (parent level P there). */
  const buildTributary = (parent: number, atIndex: number): RiverChannel | undefined => {
    const p = channels[parent]!;
    const join = p.centreline[atIndex]!;
    const P = join.level;
    for (let attempt = 0; attempt < 3; attempt++) {
      // Source: the highest ground 15..45 tiles from the join point, at least P+8 up.
      let sx = 0, sy = 0, sh = -Infinity;
      for (let i = 0; i < 12; i++) {
        const a = rng.next() * Math.PI * 2;
        const d = TRIBUTARY_MIN_DIST + rng.next() * (TRIBUTARY_MAX_DIST - TRIBUTARY_MIN_DIST);
        const x = Math.round(join.x + Math.cos(a) * d), y = Math.round(join.y + Math.sin(a) * d);
        if (!isSourceGround(ctx, channelAt, x, y, P + 8)) continue;
        const h = heightAt(x, y);
        if (h > sh) { sh = h; sx = x; sy = y; }
      }
      if (sh === -Infinity) continue;
      const w = walkStream({
        start: { x: sx, y: sy }, target: { ...join },
        maxSteps: Math.min(RIVER_MAX_LEN, 3 * Math.ceil(Math.hypot(join.x - sx, join.y - sy)) + 40),
        minNatural: P, floor: P + 1,
        heightAt: (x, y) => tileInfo(x, y).h,
        isLowWater: (x, y) => tileInfo(x, y).water,
        channelAt, isBlocked: (x, y) => tileInfo(x, y).blocked, inWindow,
      });
      if (w.boxedIn) continue;
      // The walk must end at (or next to) the intended parent: another channel's tile at a
      // higher level would have been rejected as an end, so a channel end here is the parent
      // (or a lower stretch of it) — record the join against the channel that owns the end
      // tile, with the side the tributary approached from.
      const ch = finishChannel("tributary", { x: sx, y: sy }, w);
      if (!ch) continue;
      if (w.endKind === "channel") {
        const owner = channels.findIndex((c) => c.centreline.some((t) => t.x === w.end.x && t.y === w.end.y));
        const at = owner >= 0 ? channels[owner]!.centreline.findIndex((t) => t.x === w.end.x && t.y === w.end.y) : -1;
        if (owner >= 0 && at >= 0) {
          const oc = channels[owner]!;
          const jt = oc.centreline[at]!;
          const nx = oc.centreline[Math.min(at + 1, oc.centreline.length - 1)]!;
          let pdx = nx.x - jt.x, pdy = nx.y - jt.y;
          const pl = Math.hypot(pdx, pdy) || 1; pdx /= pl; pdy /= pl;
          const mouth = ch.centreline[ch.centreline.length - 1]!;
          // Side = the sign of the approach projected onto the parent's left normal.
          const side = (mouth.x - jt.x) * -pdy + (mouth.y - jt.y) * pdx;
          joins.push({ parent: owner, atIndex: at, side: side === 0 ? 1 : Math.sign(side) });
        }
      }
      return ch;
    }
    return undefined;
  };

  /** Turn a finished walk into a channel record (sink or delta as needed). Widths come later. */
  function finishChannel(kind: "spring" | "snowmelt" | "tributary" | "outflow", source: { x: number; y: number }, w: ReturnType<typeof walkStream>): RiverChannel | undefined {
    if (w.path.length < 2) return undefined; // a spring with nowhere to go — no ditch
    const centreline = w.path.map((p, i) => ({ ...p, level: w.levels[i]! }));
    const end = w.boxedIn ? { ...w.path[w.path.length - 1]! } : w.end;
    const endKind = w.boxedIn ? "sink" : w.endKind;
    const endLevel = w.boxedIn ? w.levels[w.levels.length - 1]! : w.endLevel;
    const ch: RiverChannel = {
      source: { ...source, kind }, centreline, tiles: [],
      end, endKind, endLevel,
      delta: [],
      order: kind === "tributary" ? 1 : 1, widthAtMouth: 1,
      bbox: { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
    };
    if (w.boxedDetail) ch.boxedDetail = w.boxedDetail;
    if (endKind === "sink") {
      // Sink pond: a water disc at the walk's end level (the hollow the walk boxed into),
      // ringed with mud — a marsh, not a ditch. The channel's last tile is its shore.
      ch.sink = { x: end.x, y: end.y, r: SINK_RADIUS, level: endLevel };
    } else if (endKind === "water") {
      // Delta: a sand fan in the still water just past the mouth, in the downstream direction
      // (a plus-shaped fan at each step out, so it reads as a fan, not a line).
      const last = centreline[centreline.length - 1]!;
      const prev = centreline[centreline.length - 2]!;
      const dx = last.x - prev.x, dy = last.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      for (let s = 1; s <= 3 && ch.delta.length < 8; s++) {
        for (const [ax, ay] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const x = Math.round(end.x + ux * s + ax);
          const y = Math.round(end.y + uy * s + ay);
          // The fan spreads INTO the water past the mouth — never the mouth tile itself (the
          // lateral offset at s=1 cancels the downstream step and would sand over the very
          // tile a boat enters through).
          if (x === end.x && y === end.y) continue;
          if (ch.delta.some((d) => d.x === x && d.y === y)) continue;
          if (blockedAt(x, y) || channelAt(x, y)) continue;
          if (!lowWaterAt(x, y)) continue;
          ch.delta.push({ x, y });
          if (ch.delta.length >= 8) break;
        }
      }
    }
    channels.push(ch);
    // Later streams see this channel's centreline as a confluence target from now on.
    for (const t of centreline) if (!painted.has(keyOf(t.x, t.y))) painted.set(keyOf(t.x, t.y), t.level);
    return ch;
  }

  // ---- mains: one spring per massif, then snowmelt on high open ground ----
  // Sources prefer room to descend (nearest water at least height - 3 away — the walk then
  // reaches a boat-enterable mouth); a source with no room still builds, as a waterfall mouth.
  const pickSource = (cands: { x: number; y: number; h: number }[]): { x: number; y: number; h: number } | undefined => {
    // Highest first; the first with room to descend is the highest room candidate. The ring
    // scan is the plan's dearest lookup, so at most 3 candidates are scanned per source —
    // if none of the three highest has room, the highest builds as a waterfall mouth.
    const sorted = [...cands].sort((a, b) => b.h - a.h);
    for (const c of sorted.slice(0, 3)) {
      // Room to descend: the geometric distance minus the sample margin (4) must reach
      // height - 3, so the walk travels that far before it can touch water.
      if (nearestWaterDist(ctx, c.x, c.y) - 4 >= Math.max(0, c.h - BOAT_ENTERABLE_MOUTH_LEVEL)) return c;
    }
    return sorted[0];
  };
  for (const m of ctx.massifs) {
    // Spring: the highest sampled point on the flank (40–70% of the disc radius out).
    const cands: { x: number; y: number; h: number }[] = [];
    for (let i = 0; i < 10; i++) {
      const a = rng.next() * Math.PI * 2;
      const d = m.radius * (0.4 + rng.next() * 0.3);
      const x = Math.round(m.cx + Math.cos(a) * d), y = Math.round(m.cy + Math.sin(a) * d);
      if (!isSourceGround(ctx, channelAt, x, y, 25)) continue;
      cands.push({ x, y, h: heightAt(x, y) });
    }
    const pick = pickSource(cands);
    if (pick) buildMain(pick.x, pick.y, "spring");
  }
  const snowmelt = 1 + (rng.next() < 0.5 ? 1 : 0);
  for (let s = 0; s < snowmelt; s++) {
    const cands: { x: number; y: number; h: number }[] = [];
    for (let i = 0; i < 24; i++) {
      const x = Math.round(ctx.ox + rng.range(-600, 600)), y = Math.round(ctx.oy + rng.range(-600, 600));
      if (!isSourceGround(ctx, channelAt, x, y, 40)) continue;
      cands.push({ x, y, h: heightAt(x, y) });
    }
    const pick = pickSource(cands);
    if (pick) buildMain(pick.x, pick.y, "snowmelt");
  }
  // ---- tributaries: join a main mid-course (guaranteed confluences) ----
  const mains = channels.length;
  for (let t = 0; t < 2 && channels.length < mains + 2; t++) {
    if (!channels.length) break;
    const parent = Math.floor(rng.next() * channels.length);
    const p = channels[parent]!;
    if (p.centreline.length < 12) continue;
    // Join in the middle 60% (not at the source, not at the mouth — the parent still has
    // downstream course to widen).
    const lo = Math.floor(p.centreline.length * 0.2), hi = Math.floor(p.centreline.length * 0.8);
    const atIndex = lo + Math.floor(rng.next() * Math.max(1, hi - lo));
    buildTributary(parent, atIndex);
  }

  // ---- ADR-534: huge-lake connections — >= 2 feeders in, >= 1 outflow out per huge lake ----
  // The mains above target the NEAREST water, and a great lake is rarely the nearest water —
  // measured 0 feeders into it on all 5 survey seeds before this pass — so the guarantee is
  // a dedicated pass, not a hope. A feeder is a spring outside the lake that walks to the
  // lake's edge; an outflow is a level-1 outlet stream from the lake's shore to the nearest
  // OTHER water (sea, lake, pond, sine river). Failed attempts leave no ditch (a boxed-in
  // feeder/outflow walk is simply retried elsewhere, never sunk into a sink pond at the shore).
  const inHugeLake = (x: number, y: number): boolean =>
    (ctx.hugeLakes ?? []).some((L) => Math.hypot(x + 0.5 - L.x, y + 0.5 - L.y) <= L.r);
  const feedersInto = (lake: { x: number; y: number; r: number }): number =>
    channels.filter((c) => c.endKind === "water" && Math.hypot(c.end.x + 0.5 - lake.x, c.end.y + 0.5 - lake.y) <= lake.r).length;
  const hasOutflow = (lake: { x: number; y: number; r: number }): boolean =>
    channels.some((c) => c.source.kind === "outflow" && c.endKind === "water"
      && Math.hypot(c.centreline[0]!.x + 0.5 - lake.x, c.centreline[0]!.y + 0.5 - lake.y) <= lake.r + 3);
  const buildFeeder = (lake: { x: number; y: number; r: number }): boolean => {
    // Candidates: the highest sampled ground in a ring r+8..r+110 out, best first. Each
    // candidate needs a CLEAR corridor to the lake — the straight line from the source to
    // the lake's edge must be dry land with no other water and no earlier channel on it.
    // (A walk that meets a pond, a river or the sea first ends there, not at the lake —
    // measured: most first-draft feeder walks ended at water just outside the lake.)
    // The ring starts close to the shore: a near spring has a short corridor and a short
    // walk, so it almost always arrives; far sources make longer rivers but cross more
    // mains and basins, so they are the ones that fail. Each candidate is tried in turn
    // until one walks to the lake.
    const cands: { x: number; y: number; h: number }[] = [];
    for (let i = 0; i < 48; i++) {
      const a = rng.next() * Math.PI * 2;
      const d = lake.r + 8 + rng.next() * 102;
      const x = Math.round(lake.x + Math.cos(a) * d), y = Math.round(lake.y + Math.sin(a) * d);
      if (!isSourceGround(ctx, channelAt, x, y, 8)) continue;
      const sd = Math.hypot(x - lake.x, y - lake.y) || 1;
      const ux = (x - lake.x) / sd, uy = (y - lake.y) / sd;
      let clear = true;
      for (let s = 4; s < sd - lake.r - 2; s += 2) {
        const px = Math.round(lake.x + ux * (lake.r + s)), py = Math.round(lake.y + uy * (lake.r + s));
        if (channelAt(px, py)) { clear = false; break; }
        const info = tileInfo(px, py);
        // ADR-534: the corridor must also stay at or above sea level — the walk's minNatural
        // is 0, so a corridor dipping into a sub-0 basin boxes the walk in at the basin's edge
        // (the great lake is sited where its shore works, so viable corridors exist — but a
        // single low stretch still wastes a walk attempt, so it is checked here, not by walking).
        if (info.h < 0) { clear = false; break; }
        if (info.water && !inHugeLake(px, py)) { clear = false; break; }
      }
      if (!clear) continue;
      cands.push({ x, y, h: heightAt(x, y) });
    }
    cands.sort((a, b) => b.h - a.h);
    for (const cand of cands.slice(0, 4)) {
      const { x: sx, y: sy } = cand;
      const sd = Math.hypot(sx - lake.x, sy - lake.y) || 1;
      const target = { x: Math.round(lake.x + ((sx - lake.x) / sd) * (lake.r - 1)), y: Math.round(lake.y + ((sy - lake.y) / sd) * (lake.r - 1)) };
      const w = walkStream({
        start: { x: sx, y: sy }, target,
        // The greedy-lowest walk meanders (it follows valleys, not the beeline), so a
        // 3x budget runs out 10-18 tiles short of the lake on winding approaches; 6x
        // lets it arrive. A long meandering feeder is a real river, not a defect.
        maxSteps: Math.min(RIVER_MAX_LEN, 6 * Math.ceil(Math.hypot(target.x - sx, target.y - sy)) + 60),
        minNatural: 0, floor: 1,
        heightAt: (x, y) => tileInfo(x, y).h,
        // Only lake water ends this walk; every other water is blocked ground the walk
        // routes around (a pond or sea patch beside the corridor must not steal it).
        isLowWater: (x, y) => tileInfo(x, y).water && inHugeLake(x, y),
        channelAt, isBlocked: (x, y) => tileInfo(x, y).blocked || (tileInfo(x, y).water && !inHugeLake(x, y)), inWindow,
        // Stay in a band around the source→edge line: the corridor check verified this line
        // clear, so the walk stays in viable terrain instead of following valleys off-line.
        corridor: { x1: sx, y1: sy, x2: target.x, y2: target.y, half: 20 },
        preferTargetOnTie: true,
      });
      if (w.boxedIn) {
        continue;
      }
      const ch = finishChannel("spring", { x: sx, y: sy }, w);
      if (!ch) continue;
      // Counts only when the mouth is actually in the lake — a nearer pond or sea can still
      // steal the walk if the corridor check missed it. A feeder that ended elsewhere stays
      // in the network (it is a real stream — it just doesn't count toward this lake's two),
      // so the next candidate sources elsewhere.
      if (ch.endKind === "water" && Math.hypot(ch.end.x + 0.5 - lake.x, ch.end.y + 0.5 - lake.y) <= lake.r) return true;
    }
    return false;
  };
  const buildOutflow = (lake: { x: number; y: number; r: number }): boolean => {
    // Outlet starts: a dense scan of the shore ring (every degree, r+1..r+3) for the LOWEST
    // land tiles adjacent to lake water — the lake's natural outlet. Random sampling misses
    // them: seed 1's shore has only 12/1080 tiles at height 1..4 (the boat-enterable band —
    // the first channel tile is at level height-1, and a boat climbs at most 3). The lowest
    // spots are tried first; if none is at height <= 4 the outflow still builds from the
    // lowest available shore (a waterfall outlet — a real river, just not boat-enterable).
    const spots: { x: number; y: number; h: number }[] = [];
    for (let a = 0; a < 360; a++) {
      const th = (a * Math.PI) / 180;
      for (let d = lake.r + 1; d <= lake.r + 3; d++) {
        const x = Math.round(lake.x + Math.cos(th) * d), y = Math.round(lake.y + Math.sin(th) * d);
        const lx = x - ctx.ox, ly = y - ctx.oy;
        if (Math.abs(lx) > RIVER_WINDOW || Math.abs(ly) > RIVER_WINDOW) continue;
        if (ctx.isBlocked(lx, ly) || ctx.isLowWater(lx, ly) || channelAt(x, y)) continue;
        if (inSlopeWedge(ctx, x, y)) continue;
        const h = heightAt(x, y);
        if (h < 1) continue;
        if (!N4.some(([dx, dy]) => inHugeLake(x + dx, y + dy))) continue;
        spots.push({ x, y, h });
      }
    }
    spots.sort((a, b) => a.h - b.h);
    // The lowest spots cluster on one shore (and that shore can be ringed by sub-0 ground
    // the walk may not cross — minNatural 0 keeps channels from perching over a low band),
    // so the starts are spread around the ring: no two within 8 tiles or within 30 degrees
    // of each other as seen from the lake centre. The lowest shore is tried first, then the
    // lowest spot on each other shore.
    const starts: { x: number; y: number }[] = [];
    for (const s of spots) {
      if (starts.length >= 12) break;
      if (starts.some((t) => Math.hypot(t.x - s.x, t.y - s.y) < 8)) continue;
      const ang = Math.atan2(s.y - lake.y, s.x - lake.x);
      if (starts.some((t) => {
        const a2 = Math.atan2(t.y - lake.y, t.x - lake.x);
        let d = Math.abs(ang - a2) % (Math.PI * 2);
        if (d > Math.PI) d = Math.PI * 2 - d;
        return d < Math.PI / 6;
      })) continue;
      starts.push({ x: s.x, y: s.y });
    }
    for (const start of starts) {
      // Nearest OTHER water (the lake itself excluded from the target scan).
      const targets = nearestWaterTargets(ctx, start.x, start.y, heightAt(start.x, start.y), 3, 12, (x, y) => inHugeLake(x, y));
      if (!targets.length) continue;
      for (const t of targets) {
        const w = walkStream({
          start, target: t,
          maxSteps: Math.min(RIVER_MAX_LEN, 3 * Math.ceil(Math.hypot(t.x - start.x, t.y - start.y)) + 40),
          minNatural: 0, floor: 1,
          heightAt: (x, y) => tileInfo(x, y).h,
          // Lake tiles are neither water nor steps for this walk (the blocked wrapper below
          // covers steps; the end check must not fire on the lake the outlet leaves).
          isLowWater: (x, y) => tileInfo(x, y).water && !inHugeLake(x, y),
          channelAt, isBlocked: (x, y) => tileInfo(x, y).blocked || inHugeLake(x, y), inWindow,
        });
        if (w.boxedIn) {
          continue;
        }
        const ch = finishChannel("outflow", { ...start }, w);
        if (!ch) continue;
        // An end at a channel is a real confluence, but not a proven outflow to still water
        // — keep it (it is a real stream) and try another target for the proven one.
        if (ch.endKind === "water") return true;
      }
    }
    return false;
  };
  for (const lake of ctx.hugeLakes ?? []) {
    for (let n = feedersInto(lake); n < 2; n++) {
      if (!buildFeeder(lake)) break;
    }
    if (!hasOutflow(lake)) buildOutflow(lake);
  }

  // ---- foothill guarantee: at least one boat-enterable mouth per region ----
  // A region whose springs all end at cliff mouths gets one low foothill spring (a spring at
  // 8–20 with room to descend is guaranteed a low mouth by the same room argument — the walk
  // travels at least height-3 tiles before it can touch water, so its level is <= 3), so a
  // boat can always enter at least one river mouth from the lake.
  const hasEnterable = channels.some((c) => c.endKind === "water" && c.centreline[c.centreline.length - 1]!.level <= BOAT_ENTERABLE_MOUTH_LEVEL);
  if (!hasEnterable) {
    const cands: { x: number; y: number; h: number }[] = [];
    for (let i = 0; i < 40 && cands.length < 8; i++) {
      const x = Math.round(ctx.ox + rng.range(-600, 600)), y = Math.round(ctx.oy + rng.range(-600, 600));
      const h = heightAt(x, y);
      if (h < 8 || h > 20) continue;
      if (!isSourceGround(ctx, channelAt, x, y, 8)) continue;
      if (nearestWaterDist(ctx, x, y) - 4 < h - BOAT_ENTERABLE_MOUTH_LEVEL) continue;
      cands.push({ x, y, h });
    }
    const pick = cands[0];
    if (pick) buildMain(pick.x, pick.y, "spring");
  }

  // ---- widths (second pass) + painting ----
  // Two passes: every centreline first, then widenings/sinks/deltas. A centreline is a
  // channel's course — its realised height MUST be the channel's level (the tests assert
  // it) — so a widening tile from an earlier channel must never occupy a later channel's
  // centreline tile. Widenings/sinks/deltas are subordinate: they skip occupied tiles.
  const paintCentre = (ch: RiverChannel, x: number, y: number, level: number, dx: number, dy: number): void => {
    const k = keyOf(x, y);
    if (tiles.has(k)) return; // centrelines never overlap (a walk never steps on a channel)
    tiles.set(k, { kind: "channel", level, dx, dy });
    if (x < ch.bbox.x0) ch.bbox.x0 = x;
    if (x > ch.bbox.x1) ch.bbox.x1 = x;
    if (y < ch.bbox.y0) ch.bbox.y0 = y;
    if (y > ch.bbox.y1) ch.bbox.y1 = y;
  };
  for (let ci = 0; ci < channels.length; ci++) {
    const ch = channels[ci]!;
    const chJoins = joins.filter((j) => j.parent === ci).sort((a, b) => a.atIndex - b.atIndex);
    // Order: 1 + the number of tributaries feeding it (a channel fed by a tributary is order 2+).
    ch.order = 1 + chJoins.length;
    const widthAt = (i: number): number => Math.min(3, 1 + chJoins.filter((j) => j.atIndex <= i).length);
    ch.widthAtMouth = widthAt(ch.centreline.length - 1);
    for (let i = 0; i < ch.centreline.length; i++) {
      const t = ch.centreline[i]!;
      const next = ch.centreline[i + 1] ?? ch.end;
      let dx = next.x - t.x, dy = next.y - t.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      paintCentre(ch, t.x, t.y, t.level, dx, dy);
      ch.tiles.push({ x: t.x, y: t.y, level: t.level, dx, dy });
    }
  }
  for (let ci = 0; ci < channels.length; ci++) {
    const ch = channels[ci]!;
    const chJoins = joins.filter((j) => j.parent === ci).sort((a, b) => a.atIndex - b.atIndex);
    // The widening side at tile i is the side of the first join at or upstream of it.
    const sideAt = (i: number): number => {
      const j = chJoins.find((jj) => jj.atIndex <= i);
      return j ? j.side : 1;
    };
    const widthAt = (i: number): number => Math.min(3, 1 + chJoins.filter((j) => j.atIndex <= i).length);
    const paintSide = (x: number, y: number, level: number, dx: number, dy: number): void => {
      const k = keyOf(x, y);
      if (tiles.has(k)) return; // first channel wins — never overwrite another channel's tile
      tiles.set(k, { kind: "channel", level, dx, dy });
      if (x < ch.bbox.x0) ch.bbox.x0 = x;
      if (x > ch.bbox.x1) ch.bbox.x1 = x;
      if (y < ch.bbox.y0) ch.bbox.y0 = y;
      if (y > ch.bbox.y1) ch.bbox.y1 = y;
    };
    for (let i = 0; i < ch.centreline.length; i++) {
      const t = ch.centreline[i]!;
      const next = ch.centreline[i + 1] ?? ch.end;
      let dx = next.x - t.x, dy = next.y - t.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      // Widen downstream of each join: the extra tile goes on the join side first (the side
      // the tributary came from), then the other side. A side tile is skipped when the ground
      // beside the channel falls more than 2 below the channel level (no perched bank).
      const w = widthAt(i);
      if (w > 1) {
        const joinSide = sideAt(i);
        const sides: number[] = [joinSide, -joinSide];
        for (let s = 0; s < w - 1 && s < sides.length; s++) {
          const px = Math.round(-dy * sides[s]!), py = Math.round(dx * sides[s]!);
          if (px === 0 && py === 0) continue;
          const x = t.x + px, y = t.y + py;
          if (tiles.has(keyOf(x, y))) continue;
          if (blockedAt(x, y)) continue;
          if (heightAt(x, y) < t.level - 2) continue;
          paintSide(x, y, t.level, dx, dy);
          ch.tiles.push({ x, y, level: t.level, dx, dy });
        }
      }
    }
    // Sink disc + mud ring, painted after the channel (the sink is the channel's end).
    if (ch.sink) {
      const { x: cx, y: cy, r, level } = ch.sink;
      for (let y = cy - SINK_MUD_RADIUS; y <= cy + SINK_MUD_RADIUS; y++) for (let x = cx - SINK_MUD_RADIUS; x <= cx + SINK_MUD_RADIUS; x++) {
        const d = Math.hypot(x - cx, y - cy);
        const k = keyOf(x, y);
        if (d <= r + 0.5) {
          if (!tiles.has(k) && !blockedAt(x, y)) {
            tiles.set(k, { kind: "sinkWater", level, dx: 0, dy: 0 });
            if (x < ch.bbox.x0) ch.bbox.x0 = x; if (x > ch.bbox.x1) ch.bbox.x1 = x;
            if (y < ch.bbox.y0) ch.bbox.y0 = y; if (y > ch.bbox.y1) ch.bbox.y1 = y;
          }
        } else if (d <= SINK_MUD_RADIUS + 0.5) {
          if (!tiles.has(k) && !blockedAt(x, y) && !lowWaterAt(x, y)) {
            tiles.set(k, { kind: "sinkMud", level, dx: 0, dy: 0 });
            if (x < ch.bbox.x0) ch.bbox.x0 = x; if (x > ch.bbox.x1) ch.bbox.x1 = x;
            if (y < ch.bbox.y0) ch.bbox.y0 = y; if (y > ch.bbox.y1) ch.bbox.y1 = y;
          }
        }
      }
    }
    for (const d of ch.delta) {
      const k = keyOf(d.x, d.y);
      if (tiles.has(k)) continue;
      tiles.set(k, { kind: "delta", level: 1, dx: 0, dy: 0 });
      if (d.x < ch.bbox.x0) ch.bbox.x0 = d.x; if (d.x > ch.bbox.x1) ch.bbox.x1 = d.x;
      if (d.y < ch.bbox.y0) ch.bbox.y0 = d.y; if (d.y > ch.bbox.y1) ch.bbox.y1 = d.y;
    }
    if (!Number.isFinite(ch.bbox.x0)) ch.bbox = { x0: ch.source.x, y0: ch.source.y, x1: ch.source.x, y1: ch.source.y };
  }

  let bbox: RiverNetwork["bbox"];
  for (const ch of channels) {
    if (!bbox) bbox = { ...ch.bbox };
    else {
      bbox.x0 = Math.min(bbox.x0, ch.bbox.x0); bbox.y0 = Math.min(bbox.y0, ch.bbox.y0);
      bbox.x1 = Math.max(bbox.x1, ch.bbox.x1); bbox.y1 = Math.max(bbox.y1, ch.bbox.y1);
    }
  }
  return { channels, tiles, bbox };
}
