// ADR-533: dendritic river/stream networks outside region zero.
// Every stream reaches a water body or a sink pond; channel levels descend monotonically
// (designed AND realised); tributaries join into larger streams; mouths are boat-enterable;
// deltas fan sand at water mouths; sinks are mud + reeds, never a half-carved ditch.
// Region zero's starter river stays byte-identical.
import { describe, expect, it } from "vitest";
import {
  ProceduralGenerator, REGION_SIZE, CHUNK_SIZE, massifBumpAt, waterDepthAt, WaterDepth, isWaterId,
  BOAT_ENTERABLE_MOUTH_LEVEL, walkStream,
} from "../src/index.js";

const SEEDS = [1, 42, 1234, 424242, 9001];
const REED_KIND = 987001; // arbitrary stand-in for defs.resourceId("reed_bed")

function network(seed: number) {
  const g = new ProceduralGenerator({ seed, sinkReedKind: REED_KIND });
  return { g, net: g.riversInRegion(1, 0) };
}

describe("ADR-533 river networks", () => {
  it.each(SEEDS)("seed %i: channels exist, every stream reaches water or a sink, levels descend", (seed) => {
    const { g, net } = network(seed);
    // Pre-network ground (for the mud-ring eligibility check below).
    const plain = new ProceduralGenerator({ seed, rivers: false });
    expect(net.channels.length, `seed ${seed} channels`).toBeGreaterThanOrEqual(4);
    let waters = 0, sinks = 0, conf = 0, enterable = 0, deltas = 0;
    for (const c of net.channels) {
      // Centreline is a connected walk (each step to a 4-neighbour) with non-increasing levels.
      expect(c.centreline.length, `seed ${seed} channel length`).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < c.centreline.length; i++) {
        const a = c.centreline[i - 1]!, b = c.centreline[i]!;
        expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y), `seed ${seed} centreline step ${i}`).toBe(1);
        expect(b.level, `seed ${seed} level rises at step ${i}`).toBeLessThanOrEqual(a.level);
      }
      // The carve is realised: the stored height at every centreline tile IS the channel level,
      // and every centreline tile is water.
      for (const t of c.centreline) {
        expect(g.heightAt(t.x, t.y), `seed ${seed} realised height at (${t.x},${t.y})`).toBe(t.level);
        expect(g.tileAt(t.x, t.y), `seed ${seed} centreline tile at (${t.x},${t.y})`).toBe(1);
      }
      const last = c.centreline[c.centreline.length - 1]!;
      if (c.endKind === "water") {
        waters++;
        // The mouth's end tile is water (tile 1, or 8 shallow where it meets the shore).
        expect(isWaterId(g.tileAt(c.end.x, c.end.y)), `seed ${seed} mouth end is water`).toBe(true);
        if (last.level <= BOAT_ENTERABLE_MOUTH_LEVEL) enterable++;
        // Delta: sand fanned at a water mouth (tile-level sand band, reuses shore/sand tiles).
        expect(c.delta.length, `seed ${seed} water mouth has a delta`).toBeGreaterThan(0);
        for (const d of c.delta) expect(g.tileAt(d.x, d.y), `seed ${seed} delta tile is sand`).toBe(2);
        deltas += c.delta.length;
      } else if (c.endKind === "channel") {
        conf++;
        // A confluence flows into an earlier channel tile (water, at or below our level).
        expect(isWaterId(g.tileAt(c.end.x, c.end.y)), `seed ${seed} confluence end is water`).toBe(true);
        expect(c.endLevel, `seed ${seed} confluence flows uphill`).toBeLessThanOrEqual(last.level);
      } else {
        sinks++;
        // A sink is a real pond: a water disc at the walk's end plus a mud ring — never a ditch.
        expect(c.sink, `seed ${seed} sink channel has a sink record`).toBeDefined();
        const s = c.sink!;
        expect(Math.abs(s.x - last.x) + Math.abs(s.y - last.y), `seed ${seed} sink sits at the walk end`).toBeLessThanOrEqual(2);
        // Water disc: d <= r + 0.5 = 2.5, i.e. r^2 <= 6 (the centreline passes through it, but
        // channel tiles are water too, so every disc tile reads as water).
        let disc = 0, discTotal = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const r2 = dx * dx + dy * dy;
          if (r2 > 6) continue;
          discTotal++;
          if (g.tileAt(s.x + dx, s.y + dy) === 1) disc++;
        }
        expect(disc, `seed ${seed} sink disc is water (${disc}/${discTotal})`).toBeGreaterThanOrEqual(Math.floor(discTotal * 0.8));
        // Mud ring: 2.5 < d <= 3.5, i.e. r^2 in {8,9,10}. A widened channel mouth eats much
        // of the ring (its own tiles are water, not mud), and a ring tile on a lake is water
        // too — so the bar is counted only over the tiles the mud could have been painted on
        // (not already a channel/sink-water tile in the network, not water in the plain field).
        // ADR-534: mud is a lowland feature — a ring tile at/above the rock line (55) reads
        // as rock/snow, never mud, so it is not eligible either. A sink whose whole ring is
        // high (a mountainside sink) has no mud ring by design, so the bar is skipped when
        // no tile is eligible.
        let mud = 0, eligible = 0;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          const r2 = dx * dx + dy * dy;
          if (r2 !== 8 && r2 !== 9 && r2 !== 10) continue;
          const tx = s.x + dx, ty = s.y + dy;
          const kind = net.tiles.get(`${tx},${ty}`)?.kind;
          if (kind === "channel" || kind === "sinkWater") continue;
          const pt = plain.tileAt(tx, ty);
          if (pt === 1 || pt === 8) continue;
          if (g.heightAt(tx, ty) >= 55) continue;
          eligible++;
          if (g.tileAt(tx, ty) === 9) mud++;
        }
        if (eligible > 0) {
          expect(mud, `seed ${seed} sink mud ring (${mud}/${eligible} eligible)`).toBeGreaterThanOrEqual(Math.floor(eligible * 0.8));
        }
        // A boxed-in walk records why it boxed in (the sink is justified, not a planning bug).
        if (c.boxedDetail) {
          expect(c.boxedDetail.neighbours.length, `seed ${seed} boxed detail has 4 neighbours`).toBe(4);
          expect(c.boxedDetail.neighbours.every((n) => n.why !== "ok"), `seed ${seed} sink was truly boxed in`).toBe(true);
        }
      }
      // Width grows downstream: a channel fed by a tributary is wider at the mouth.
      expect(c.widthAtMouth, `seed ${seed} width at mouth`).toBeGreaterThanOrEqual(1);
      expect(c.widthAtMouth, `seed ${seed} width at mouth`).toBeLessThanOrEqual(3);
      expect(c.widthAtMouth, `seed ${seed} width grows with order`).toBeGreaterThanOrEqual(Math.min(3, c.order));
    }
    expect(waters, `seed ${seed} water mouths`).toBeGreaterThan(0);
    expect(conf, `seed ${seed} confluences`).toBeGreaterThan(0);
    expect(enterable, `seed ${seed} boat-enterable mouths`).toBeGreaterThan(0);
    expect(deltas, `seed ${seed} delta tiles`).toBeGreaterThan(0);
    console.log(`ADR-533 seed ${seed}: channels=${net.channels.length} water=${waters} conf=${conf} sinks=${sinks} enterable=${enterable} deltaTiles=${deltas}`);
  }, 300_000);

  it.each(SEEDS)("seed %i: no channel is perched and no stream climbs a massif it did not carve", (seed) => {
    const { g, net } = network(seed);
    // Pre-network ground from a rivers:false generator (same seed — the same world minus networks).
    const plain = new ProceduralGenerator({ seed, rivers: false });
    for (const c of net.channels) {
      const srcNatural = plain.heightAt(c.source.x, c.source.y);
      const quarter = Math.floor(c.centreline.length / 4);
      for (let i = 0; i < c.centreline.length; i++) {
        const t = c.centreline[i]!;
        const natural = plain.heightAt(t.x, t.y);
        // Never perched: the channel level never sits above the ground it crosses (it carves a
        // gorge through saddles instead — the level is at or below natural).
        expect(t.level, `seed ${seed} channel perched at (${t.x},${t.y})`).toBeLessThanOrEqual(natural + 1);
        if (i < quarter) continue; // the source sits on a massif flank by design
        // Downstream of the flank, no tile sits on a massif face far above the source: the
        // walk follows the lowest ground, so it crosses a massif only at a saddle (a small
        // rise it cuts a gorge through — the carve is asserted above), never over the peak.
        const massifs = g.massifsInRegion(1, 0);
        const bump = massifs.reduce((m, mf) => Math.max(m, massifBumpAt(mf, t.x, t.y)), 0);
        expect(!(bump > 0 && natural > srcNatural + 15), `seed ${seed} channel climbs a massif at (${t.x},${t.y}) bump=${bump} natural=${natural} src=${srcNatural}`).toBe(true);
      }
    }
  }, 300_000);

  it.each(SEEDS)("seed %i: a river mouth is enterable by boat from the lake (depth check)", (seed) => {
    const { g, net } = network(seed);
    const mouths = net.channels.filter((c) => c.endKind === "water");
    expect(mouths.length, `seed ${seed} water mouths`).toBeGreaterThan(0);
    // At least one mouth is low (level <= 3) AND its end tile is real water with a depth —
    // a boat floating on the lake can cross into the channel.
    const enterable = mouths.filter((c) => {
      const last = c.centreline[c.centreline.length - 1]!;
      if (last.level > BOAT_ENTERABLE_MOUTH_LEVEL) return false;
      const depth = waterDepthAt((x, y) => g.tileAt(x, y), c.end.x, c.end.y);
      return depth === WaterDepth.Shallow || depth === WaterDepth.Deep;
    });
    expect(enterable.length, `seed ${seed} boat-enterable mouths`).toBeGreaterThan(0);
    // The channel's mouth tile itself is water the boat can sit on.
    for (const c of enterable) {
      const last = c.centreline[c.centreline.length - 1]!;
      expect(waterDepthAt((x, y) => g.tileAt(x, y), last.x, last.y), `seed ${seed} mouth tile has a depth`).not.toBe(WaterDepth.None);
    }
  }, 300_000);

  it.each(SEEDS)("seed %i: no channel enters a massif slope wedge (the ADR-531 approach path)", (seed) => {
    // A spring's channel running down the slope ray cuts a gorge across the approach route
    // and severs the guaranteed <=1-step path to the summit (seed 1 volcano, found by the
    // adr531 neighbour run). Centrelines stay out of the wedge; the test uses the Massif
    // records' own slope sector (the test's wedge: radius + 9, slopeHalfWidth + 0.35).
    const { g, net } = network(seed);
    const angDiff = (a: number, b: number): number => {
      let d = a - b;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      return Math.abs(d);
    };
    for (const m of g.massifsInRegion(1, 0)) {
      for (const c of net.channels) {
        for (const t of c.centreline) {
          const dx = t.x - m.cx, dy = t.y - m.cy;
          const d = Math.hypot(dx, dy);
          if (d > m.radius + 9) continue;
          expect(angDiff(Math.atan2(dy, dx), m.slopeDir), `seed ${seed} channel in the slope wedge of the massif at (${m.cx},${m.cy})`).toBeGreaterThan(m.slopeHalfWidth + 0.35);
        }
      }
    }
  }, 300_000);

  it.each(SEEDS)("seed %i: sink ponds grow reeds (mud tile + reeds)", (seed) => {
    const { g, net } = network(seed);
    const sinks = net.channels.filter((c) => c.endKind === "sink" && c.sink);
    if (!sinks.length) return; // a region with no sinks has no marsh to harvest
    // Reed nodes appear on sink-mud tiles (deterministic per seed — collect every chunk the
    // mud rings touch, since a ring straddles chunk edges).
    const chunks = new Set<string>();
    for (const c of sinks) {
      for (const cx of [Math.floor((c.sink!.x - 4) / CHUNK_SIZE), Math.floor((c.sink!.x + 4) / CHUNK_SIZE)]) {
        for (const cy of [Math.floor((c.sink!.y - 4) / CHUNK_SIZE), Math.floor((c.sink!.y + 4) / CHUNK_SIZE)]) {
          chunks.add(`${cx},${cy}`);
        }
      }
    }
    let reeds = 0;
    for (const key of chunks) {
      const [cx, cy] = key.split(",").map(Number);
      for (const n of g.nodesInChunk(cx!, cy!)) if (n.kind === REED_KIND) reeds++;
    }
    expect(reeds, `seed ${seed} reed nodes on sink mud`).toBeGreaterThan(0);
  }, 300_000);

  it.each(SEEDS)("seed %i: region zero is byte-identical with rivers on vs off", (seed) => {
    const on = new ProceduralGenerator({ seed });
    const off = new ProceduralGenerator({ seed, rivers: false });
    expect(on.riversInRegion(0, 0).channels.length, `seed ${seed} region zero has no network`).toBe(0);
    // The starter river and every other region-zero tile: same tile, height and sample.
    for (let cy = -2; cy <= 2; cy++) for (let cx = -2; cx <= 2; cx++) {
      for (let ly = 0; ly < 16; ly++) for (let lx = 0; lx < 16; lx++) {
        const x = cx * 16 + lx, y = cy * 16 + ly;
        expect(on.tileAt(x, y), `seed ${seed} tileAt (${x},${y})`).toBe(off.tileAt(x, y));
        expect(on.heightAt(x, y), `seed ${seed} heightAt (${x},${y})`).toBe(off.heightAt(x, y));
        expect(on.sampleAt(x, y), `seed ${seed} sampleAt (${x},${y})`).toEqual(off.sampleAt(x, y));
      }
    }
    // A coarse grid over the whole of region zero (the starter river's full course included).
    for (let y = -REGION_SIZE / 2; y < REGION_SIZE / 2; y += 16) {
      for (let x = -REGION_SIZE / 2; x < REGION_SIZE / 2; x += 16) {
        expect(on.tileAt(x, y), `seed ${seed} coarse tileAt (${x},${y})`).toBe(off.tileAt(x, y));
        expect(on.heightAt(x, y), `seed ${seed} coarse heightAt (${x},${y})`).toBe(off.heightAt(x, y));
      }
    }
  }, 300_000);
});

describe("ADR-533 walkStream (synthetic fields)", () => {
  // A gentle slope descending toward water at the target: the walk reaches it, levels descend.
  it("reaches water on an open slope", () => {
    const water = new Set(["10,0"]);
    const w = walkStream({
      start: { x: 0, y: 0 }, target: { x: 10, y: 0 }, maxSteps: 60, minNatural: 0, floor: 1,
      heightAt: (x) => Math.max(0, 20 - x),
      isLowWater: (x, y) => water.has(`${x},${y}`),
      channelAt: () => undefined,
      isBlocked: () => false,
      inWindow: (x, y) => Math.abs(x) <= 20 && Math.abs(y) <= 20,
    });
    expect(w.boxedIn).toBe(false);
    expect(w.endKind).toBe("water");
    expect(w.end).toEqual({ x: 10, y: 0 });
    for (let i = 1; i < w.levels.length; i++) expect(w.levels[i]!).toBeLessThanOrEqual(w.levels[i - 1]!);
    expect(w.path.length).toBeGreaterThan(1);
  });

  // A dead-end pocket (a U-shaped wall of blocked ground, open only to the west): the walk
  // enters it heading for water beyond the wall and boxes in — the planner ends it in a sink
  // there, never a half-carved ditch.
  it("boxes in inside a dead-end pocket", () => {
    const blocked = (x: number, y: number): boolean => {
      if (x === 8 && y >= -3 && y <= 3) return true; // east wall
      if ((y === 3 || y === -3) && x >= 5 && x <= 8) return true; // north/south walls
      return false;
    };
    const w = walkStream({
      start: { x: 0, y: 0 }, target: { x: 15, y: 0 }, maxSteps: 60, minNatural: 0, floor: 1,
      heightAt: (x) => Math.max(0, 12 - x),
      isLowWater: () => false,
      channelAt: () => undefined,
      isBlocked: blocked,
      inWindow: (x, y) => Math.abs(x) <= 20 && Math.abs(y) <= 20,
    });
    expect(w.boxedIn).toBe(true);
    expect(w.boxedDetail, "boxed-in walk records why").toBeDefined();
    expect(w.boxedDetail!.neighbours.length).toBe(4);
    // The path is connected and never rises (a ditch that ends at its lowest point, ready to
    // become a sink pond — not a half-carved cut abandoned mid-slope).
    for (let i = 1; i < w.path.length; i++) {
      const a = w.path[i - 1]!, b = w.path[i]!;
      expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBe(1);
      expect(w.levels[i]!).toBeLessThanOrEqual(w.levels[i - 1]!);
    }
    expect(w.path.length).toBeGreaterThan(1);
  });

  // A confluence: the walk ends when it reaches an earlier channel at or below its level.
  it("joins an earlier channel instead of flowing uphill into it", () => {
    const channel = new Map<string, number>([["5,0", 4], ["5,1", 4], ["5,-1", 4]]);
    const w = walkStream({
      start: { x: 0, y: 0 }, target: { x: 10, y: 0 }, maxSteps: 60, minNatural: 0, floor: 1,
      heightAt: (x) => Math.max(0, 12 - x),
      isLowWater: () => false,
      channelAt: (x, y) => { const l = channel.get(`${x},${y}`); return l === undefined ? undefined : { level: l }; },
      isBlocked: () => false,
      inWindow: (x, y) => Math.abs(x) <= 20 && Math.abs(y) <= 20,
    });
    expect(w.boxedIn).toBe(false);
    expect(w.endKind).toBe("channel");
    expect(w.endLevel).toBe(4);
  });
});
