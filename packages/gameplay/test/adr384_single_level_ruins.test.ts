import { describe, expect, it } from "vitest";
import { Transform } from "@engine/core";
import { ChunkManager, ProceduralGenerator } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

type W = ReturnType<typeof makeWorld>;

function zOf(w: W, e: number) {
  return w.getField(e, G.PieceSlot, "z") ?? Math.round((w.getField(e, Transform, "z") ?? 0) / G.gameplayDefs(w).building.levelHeight);
}

/** Terrain stub: grass everywhere (tile 3), heights from `h`. */
function stepTerrain(w: W, h: (x: number, y: number) => number): void {
  w.setResource(G.TerrainRes, { tileAt: () => 3, heightAt: h, loaded: () => true });
}

function markerInfo(w: W, m: number) {
  return {
    ox: w.getField(m, G.AbandonedSite, "originX")!,
    oy: w.getField(m, G.AbandonedSite, "originY")!,
    w: w.getField(m, G.AbandonedSite, "width")!,
    h: w.getField(m, G.AbandonedSite, "height")!,
    stories: w.getField(m, G.AbandonedSite, "stories")!,
  };
}

/** Distinct terrain levels under the marker's ground footprint (must be exactly one). */
function footprintLevels(w: W, m: number): Set<number> {
  const { ox, oy, w: fw, h: fh } = markerInfo(w, m);
  const terrain = w.getResource(G.TerrainRes)!;
  const out = new Set<number>();
  for (let y = oy; y < oy + fh; y++) for (let x = ox; x < ox + fw; x++) out.add(terrain.heightAt(x, y));
  return out;
}

function stamp(w: W, ox: number, oy: number, kind: number, rot = 0) {
  const r = G.stampAbandonedSite(w, ox, oy, { kind: kind as never, rot, ruin: 0, tier: 1 });
  G.drainAbandonedStamps(w);
  return r;
}

describe("ADR-384 single-level abandoned ruins", () => {
  it("siteTerrainOk is exact now: flat passes, one tile a level up fails", () => {
    const w = makeWorld();
    stepTerrain(w, (x) => (x >= 10 ? 1 : 0));
    expect(G.siteTerrainOk(w, 8, 8, 2, 2)).toBe(true); // x 8..9, all level 0
    expect(G.siteTerrainOk(w, 8, 8, 3, 3)).toBe(false); // x 8..10 spans 0 and 1
    expect(G.siteTerrainOk(w, 10, 8, 2, 2)).toBe(true); // x 10..11, all level 1
    // Water still fails, and no terrain at all still passes (client / unit worlds).
    w.setResource(G.TerrainRes, { tileAt: () => 1, heightAt: () => 0, loaded: () => true });
    expect(G.siteTerrainOk(w, 8, 8, 2, 2)).toBe(false);
    const bare = makeWorld();
    expect(G.siteTerrainOk(bare, 8, 8, 3, 3)).toBe(true);
  });

  it("a site on a slope is skipped, not stamped straddling levels", () => {
    // Spread 1: the old slope gate (maxSlope 2) would have stamped this. The step leaves
    // flat ground two tiles away, but the site is NOT moved there — relocation was tried
    // and removed (it broke the adr203 canary), so a straddling site is simply skipped.
    const w = makeWorld();
    stepTerrain(w, (x) => (x >= 10 ? 1 : 0));
    const r = stamp(w, 8, 8, G.AbandonedKind.Cottage);
    expect(r.skipped).toBe(true);
    expect(r.marker).toBe(0);
    expect(r.placed.length).toBe(0);
    expect(G.pendingAbandonedStamps(w)).toEqual([]);
    expect([...w.query([G.AbandonedSite])].length).toBe(0);
    expect([...w.query([G.BuildPiece])].length).toBe(0);
  });

  it("a site on steep ground is still skipped (no resurrection)", () => {
    // Spread 3: the old gate already skipped this, and the new gate must not resurrect it.
    const w = makeWorld();
    stepTerrain(w, (x) => (x >= 10 ? 3 : 0));
    const r = stamp(w, 8, 8, G.AbandonedKind.Shed);
    expect(r.skipped).toBe(true);
    expect(r.marker).toBe(0);
    expect(r.placed.length).toBe(0);
    expect([...w.query([G.AbandonedSite])].length).toBe(0);
  });

  it("flat ground stamps exactly where planned (no behaviour change)", () => {
    const w = makeWorld();
    stepTerrain(w, () => 0);
    const r = stamp(w, 8, 8, G.AbandonedKind.Cottage);
    expect(r.skipped).toBe(false);
    expect(markerInfo(w, r.marker).ox).toBe(8);
    expect(markerInfo(w, r.marker).oy).toBe(8);
    expect(footprintLevels(w, r.marker)).toEqual(new Set([0]));
  });

  it("every kind skips on a slope and stamps flat on flat ground — never straddling", () => {
    // One world per kind (a chunk holds at most one site). The step cuts 2 tiles into
    // every footprint, so every kind's planned origin straddles and must be skipped.
    let skipped = 0;
    for (let kind = 0; kind < 28; kind++) {
      const w = makeWorld();
      stepTerrain(w, (x) => (x >= 10 ? 1 : 0));
      const r = stamp(w, 8, 8, kind);
      expect(r.kind).toBe(kind);
      expect(r.skipped).toBe(true);
      expect(r.marker).toBe(0);
      expect([...w.query([G.AbandonedSite])].length).toBe(0);
      skipped++;
    }
    expect(skipped).toBe(28);
    // And on flat ground every kind stamps, single-level, keeping its kind.
    let stamped = 0;
    for (let kind = 0; kind < 28; kind++) {
      const w = makeWorld();
      stepTerrain(w, () => 0);
      const r = stamp(w, 8, 8, kind);
      expect(r.kind).toBe(kind);
      expect(r.skipped).toBe(false);
      expect(r.marker).toBeGreaterThan(0);
      expect(footprintLevels(w, r.marker).size).toBe(1);
      stamped++;
    }
    expect(stamped).toBe(28);
  });

  it("two-story kinds keep their upper floor on flat ground and skip on a slope", () => {
    for (const [kind, stories] of [
      [G.AbandonedKind.TwoStoryCottage, 2],
      [G.AbandonedKind.TwoStoryFarmhouse, 2],
      [G.AbandonedKind.Inn, 2],
      [G.AbandonedKind.Manor, 2],
      [G.AbandonedKind.Townhouse, 3],
    ] as const) {
      const flat = makeWorld();
      stepTerrain(flat, () => 0);
      const r = stamp(flat, 8, 8, kind);
      expect(r.skipped).toBe(false);
      expect(r.marker).toBeGreaterThan(0);
      expect(markerInfo(flat, r.marker).stories).toBe(stories);
      expect(r.stories).toBe(stories);
      expect(footprintLevels(flat, r.marker).size).toBe(1); // ground footprint single-level
      const upper = r.placed.filter((e) => zOf(flat, e) >= 1);
      expect(upper.length).toBeGreaterThan(0); // the L1 balcony / floor is still there
      const slope = makeWorld();
      stepTerrain(slope, (x) => (x >= 10 ? 1 : 0));
      const s = stamp(slope, 8, 8, kind);
      expect(s.skipped).toBe(true);
      expect(s.marker).toBe(0);
    }
  });

  it("a chunk reload does not add a second site — standing site is grandfathered", () => {
    // Find a chunk with a plan and stamp it on flat ground.
    let target: { seed: number; cx: number; cy: number; w: W } | undefined;
    for (let seed = 1; seed < 20 && !target; seed++) {
      for (let cx = 0; cx < 8 && !target; cx++) for (let cy = 0; cy < 8 && !target; cy++) {
        const plan = G.planAbandonedChunk(seed, cx, cy);
        if (!plan) continue;
        const w = makeWorld({}, seed);
        stepTerrain(w, () => 0);
        const r = G.stampAbandonedChunk(w, { cx, cy });
        G.drainAbandonedStamps(w);
        if (!r || r.skipped || !r.marker) continue;
        target = { seed, cx, cy, w };
      }
    }
    expect(target).toBeDefined();
    const { seed, cx, cy, w } = target!;
    expect([...w.query([G.AbandonedSite])].length).toBe(1);
    const pieces0 = [...w.query([G.BuildPiece])].length;
    // Re-stamp on the same flat ground: the site already exists, so it is skipped.
    const again = G.stampAbandonedChunk(w, { cx, cy });
    expect(again).toBeDefined();
    expect(again!.skipped).toBe(true);
    G.drainAbandonedStamps(w);
    expect([...w.query([G.AbandonedSite])].length).toBe(1);
    expect([...w.query([G.BuildPiece])].length).toBe(pieces0);
    // Now tilt the ground under it: the standing site is grandfathered (not torn down,
    // not duplicated) and the re-stamp is skipped.
    const plan = G.planAbandonedChunk(seed, cx, cy)!;
    stepTerrain(w, (x) => (x >= plan.originX + 2 ? 1 : 0));
    const tilted = G.stampAbandonedChunk(w, { cx, cy });
    expect(tilted).toBeDefined();
    expect(tilted!.skipped).toBe(true);
    G.drainAbandonedStamps(w);
    expect([...w.query([G.AbandonedSite])].length).toBe(1);
    expect([...w.query([G.BuildPiece])].length).toBe(pieces0);
    expect(G.pendingAbandonedStamps(w)).toEqual([]);
  });

  it("chunk-load stamping skips a straddling site and stamps a flat one", () => {
    const seed = 1234;
    const w = makeWorld({}, seed);
    const chunks = new ChunkManager({ provider: new ProceduralGenerator({ seed }), loadRadius: 0, unloadMargin: 0, cacheSize: 0 });
    const terrain = G.terrainFromTileMap(chunks);
    w.setResource(G.TerrainRes, terrain);
    chunks.onLoad((c) => { G.stampAbandonedChunk(w, c.key); });
    // Scan chunks until one plans a site whose origin straddles levels on real terrain,
    // and one whose origin is flat and actually starts stamping.
    let straddling: { cx: number; cy: number } | undefined;
    let flat: { cx: number; cy: number } | undefined;
    for (let cx = 0; cx < 40 && (!straddling || !flat); cx++) for (let cy = 0; cy < 4 && (!straddling || !flat); cy++) {
      const plan = G.planAbandonedChunk(seed, cx, cy);
      if (!plan) continue;
      chunks.setSource({ id: 1, x: cx * 32 + 16, y: cy * 32 + 16, radius: 0 });
      chunks.update();
      const site = G.planAbandonedSite(seed, plan.originX, plan.originY, { kind: plan.kind, rot: plan.rot, ruin: plan.ruin });
      const ok = G.siteTerrainOk(w, plan.originX, plan.originY, site.width, site.height);
      const pendingHere = G.pendingAbandonedStamps(w).some((p) => Math.floor(p.originX / 32) === cx && Math.floor(p.originY / 32) === cy);
      if (!ok && !straddling && !pendingHere) straddling = { cx, cy };
      if (ok && !flat && pendingHere) flat = { cx, cy };
      // Drain before moving the source on: with cacheSize 0 the chunk unloads as soon
      // as the source moves, and a pending stamp in an unloaded chunk is rolled back
      // (ADR-382), so a flat site would vanish before the end of the scan.
      G.drainAbandonedStamps(w);
    }
    expect(straddling).toBeDefined();
    expect(flat).toBeDefined();
    G.drainAbandonedStamps(w);
    expect(G.pendingAbandonedStamps(w)).toEqual([]);
    const markersIn = (cx: number, cy: number) => [...w.query([G.AbandonedSite])].filter((m) => {
      const ox = w.getField(m, G.AbandonedSite, "originX")!;
      const oy = w.getField(m, G.AbandonedSite, "originY")!;
      return Math.floor(ox / 32) === cx && Math.floor(oy / 32) === cy;
    });
    expect(markersIn(straddling!.cx, straddling!.cy).length).toBe(0);
    const flatMarkers = markersIn(flat!.cx, flat!.cy);
    expect(flatMarkers.length).toBe(1);
    expect(footprintLevels(w, flatMarkers[0]!).size).toBe(1);
  });

  it("SITE_CHANCE reverted to 0.15 by the gate: realised density is lower, all ruins single-level", () => {
    // Guard for the ADR-384 density story. As delivered, the strict gate stamps
    // only the ~41% of planned sites that are already single-level, so SITE_CHANCE
    // was raised 0.15 -> 0.25 to keep the number of standing ruins about the same
    // (0.25 x ~41% ~= 0.10 of chunks get a ruin, vs ~0.106 under the old gate).
    // GATE FIX (ADR-384 gate, 2026-11-13): 0.25 reshuffles the site spawn-point
    // set and deterministically broke adr331 — bot0 respawned at a site point
    // beside a terrain trap (a resource node on a ridge it cannot climb) and
    // froze for the whole 120 s window. The strict gate alone (at 0.15) does NOT
    // break adr331; only the 0.25 compensation does. The gate reverted to 0.15
    // so the spawn-point set matches the pre-384 base. TRADE-OFF: realised
    // density is now ~0.06 of chunks (~6 ruins per 100 chunks) instead of ~0.10
    // — a visible reduction vs the live game. Restoring 0.25 needs the
    // planner/pathfinder to re-target unreachable resource nodes (a new ADR).
    // Loose bounds on a large deterministic sample (5 seeds x 441 chunks, real
    // generator terrain) so a retune or a gate change that moves the realised
    // density is caught here, not on a live world.
    let chunks = 0, plans = 0, flatPlans = 0;
    for (let seed = 1; seed <= 5; seed++) {
      const gen = new ProceduralGenerator({ seed });
      const w = makeWorld({}, seed);
      w.setResource(G.TerrainRes, { tileAt: (x: number, y: number) => gen.tileAt(x, y), heightAt: (x: number, y: number) => gen.heightAt(x, y), loaded: () => true });
      for (let cx = -10; cx <= 10; cx++) for (let cy = -10; cy <= 10; cy++) {
        chunks++;
        const plan = G.planAbandonedChunk(seed, cx, cy);
        if (!plan) continue;
        plans++;
        const site = G.planAbandonedSite(seed, plan.originX, plan.originY, { kind: plan.kind, rot: plan.rot, ruin: plan.ruin });
        if (G.siteTerrainOk(w, plan.originX, plan.originY, site.width, site.height)) flatPlans++;
      }
    }
    const planRate = plans / chunks; // ~SITE_CHANCE (0.15)
    expect(planRate).toBeGreaterThan(0.10);
    expect(planRate).toBeLessThan(0.20);
    const flatRate = flatPlans / plans; // ~0.41 of planned sites are single-level
    expect(flatRate).toBeGreaterThan(0.35);
    expect(flatRate).toBeLessThan(0.47);
    // Realised density: planRate x flatRate ~= 0.06 of chunks get a ruin — lower
    // than the old gate's ~0.106 (0.15 x 0.709), all single-level (gate trade-off).
    const realised = planRate * flatRate;
    expect(realised).toBeGreaterThan(0.045);
    expect(realised).toBeLessThan(0.08);
  });
});
