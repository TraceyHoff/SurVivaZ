import { describe, expect, it } from "vitest";
import { ChunkManager, ProceduralGenerator } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

/**
 * ADR-595: realistic buildings (farmhouses to fire stations) fill the chunks the legacy planner
 * leaves empty, clustered into towns, picked by biome, intact, deterministic, and never added to a
 * chunk read from an existing save.
 */
const keyOf = (k: number): string => G.ABANDONED_KIND_KEYS[k]!;
const defOf = (k: number) => G.REALISTIC_KINDS[k - G.REALISTIC_BASE]!;

describe("ADR-595 settlements", () => {
  it("is a pure function of (seed, chunk, env) and never shares a chunk with a legacy site", () => {
    let n = 0;
    for (let cy = -30; cy <= 30; cy++) for (let cx = -30; cx <= 30; cx++) {
      const a = G.planSettlementChunk(42, cx, cy), b = G.planSettlementChunk(42, cx, cy);
      expect(a).toEqual(b);
      if (!a) continue;
      n++;
      expect(G.planAbandonedChunk(42, cx, cy)).toBeUndefined();
      expect(G.isRealisticKind(a.kind)).toBe(true);
      const plan = G.planAbandonedSite(42, a.originX, a.originY, { kind: a.kind, rot: a.rot, ruin: a.ruin });
      expect({ w: plan.width, h: plan.height }).toEqual({ w: a.width, h: a.height });
      expect(a.originX).toBeGreaterThanOrEqual(cx * 32); expect(a.originX + a.width).toBeLessThanOrEqual(cx * 32 + 32);
      expect(a.originY).toBeGreaterThanOrEqual(cy * 32); expect(a.originY + a.height).toBeLessThanOrEqual(cy * 32 + 32);
    }
    expect(n).toBeGreaterThan(200);
  });

  it("keeps the start areas open: no settlement building near a spawn point", () => {
    for (const seed of [1, 11, 42]) for (let cy = -8; cy <= 7; cy++) for (let cx = -8; cx <= 7; cx++) {
      const sp = G.planSettlementChunk(seed, cx, cy); if (!sp) continue;
      const mx = sp.originX + sp.width / 2, my = sp.originY + sp.height / 2;
      for (const [sx, sy] of [[96, 96], [96, -96], [-96, 96], [-96, -96]] as const) expect(Math.hypot(mx - sx - 0.5, my - sy - 0.5)).toBeGreaterThanOrEqual(G.SETTLE_SPAWN_CLEAR);
    }
  });

  it("clusters towns: dense lots around a centre, doors facing the square; rural land is sparse", () => {
    let townChunks = 0, townSites = 0, ruralChunks = 0, ruralSites = 0, faced = 0;
    for (let cy = -60; cy <= 60; cy++) for (let cx = -60; cx <= 60; cx++) {
      if (G.planAbandonedChunk(7, cx, cy)) continue;
      const town = G.townAt(7, cx, cy);
      const sp = G.planSettlementChunk(7, cx, cy);
      if (town) { townChunks++; if (sp) townSites++; } else { ruralChunks++; if (sp) ruralSites++; }
      if (!sp || !town) continue;
      expect(sp.town).toBe(true); expect(sp.setting).toBe("town");
      expect(defOf(sp.kind).where.town ?? 0).toBeGreaterThan(0);
      if (town.cx === cx && town.cy === cy) continue;
      const dx = town.cx - cx, dy = town.cy - cy;
      const face = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 3 : 1) : (dy > 0 ? 0 : 2);
      expect(sp.rot).toBe(face); faced++;
    }
    expect(townChunks).toBeGreaterThan(100); expect(faced).toBeGreaterThan(50);
    expect(townSites / townChunks).toBeGreaterThan(0.7);
    expect(ruralSites / ruralChunks).toBeLessThan(0.15);
    expect(ruralSites).toBeGreaterThan(50);
  });

  it("picks from the biome's table outside towns", () => {
    const seen: Record<string, Set<string>> = {};
    for (const tile of [2, 3, 4, 5]) {
      const env: G.SiteEnv = { tileAt: () => tile };
      for (let cy = -60; cy <= 60; cy++) for (let cx = -60; cx <= 60; cx++) {
        const sp = G.planSettlementChunk(3, cx, cy, env); if (!sp || sp.town) continue;
        expect(sp.setting).toBe(G.settingOfTile(tile));
        expect(defOf(sp.kind).where[sp.setting] ?? 0).toBeGreaterThan(0);
        (seen[sp.setting] ??= new Set()).add(keyOf(sp.kind));
      }
    }
    expect([...seen.coast!]).toContain("lighthouse");
    expect([...seen.mountain!].some((k) => k === "bunker" || k === "radio_hut")).toBe(true);
    expect([...seen.forest!].some((k) => k === "ranger_station" || k === "hunting_lodge")).toBe(true);
    expect(seen.plains!.has("lighthouse")).toBe(false);
    // the whole catalogue is reachable somewhere
    const all = new Set(Object.values(seen).flatMap((s) => [...s]));
    for (let cy = -80; cy <= 80; cy++) for (let cx = -80; cx <= 80; cx++) { const sp = G.planSettlementChunk(3, cx, cy); if (sp?.town) all.add(keyOf(sp.kind)); }
    expect(all.size).toBe(G.REALISTIC_KINDS.length);
  });

  it("stamps intact in a fresh chunk; a chunk read from a save gets no new building", () => {
    let cx = 0, cy = 0, sp: G.SettlementPlan | undefined;
    for (let i = 3; !sp; i++) { cx = i; cy = 5; sp = G.planSettlementChunk(42, cx, cy); }
    const fresh = makeWorld();
    const r = G.stampAbandonedChunk(fresh, { cx, cy })!;
    expect(r.skipped).toBe(false);
    G.drainAbandonedStamps(fresh);
    expect(G.settlementSiteInChunk(fresh, cx, cy)).toBe(sp.kind);
    const plan = G.planAbandonedSite(42, sp.originX, sp.originY, { kind: sp.kind, rot: sp.rot, ruin: sp.ruin });
    expect(r.placed.length).toBe(plan.pieces.length);
    expect(r.omitted).toBe(0);

    const old = makeWorld();
    G.markStoredChunk(old, cx, cy);
    const s = G.stampAbandonedChunk(old, { cx, cy });
    expect(s === undefined || s.skipped).toBe(true);
    G.drainAbandonedStamps(old);
    expect(G.settlementSiteInChunk(old, cx, cy)).toBeUndefined();
    // the mark is consumed once: a later fresh load (e.g. after the chunk was wiped) stamps normally
    expect(G.stampAbandonedChunk(old, { cx, cy })!.skipped).toBe(false);
  });

  it("the maps name exactly what a generator-backed world stamps, settlements included", () => {
    for (const seed of [42, 7]) {
      const w = makeWorld({}, seed);
      const gen = new ProceduralGenerator({ seed });
      const chunks = new ChunkManager({ provider: gen, loadRadius: 0, unloadMargin: 0, cacheSize: 0 });
      w.setResource(G.TerrainRes, G.terrainFromTileMap(chunks));
      chunks.onLoad((c) => { G.stampAbandonedChunk(w, c.key); });
      const CX0 = -10, CY0 = -10, CX1 = 10, CY1 = 10;
      for (let cy = CY0; cy <= CY1; cy++) for (let cx = CX0; cx <= CX1; cx++) {
        chunks.setSource({ id: 1, x: cx * 32 + 16, y: cy * 32 + 16, radius: 0 }); chunks.update(); G.drainAbandonedStamps(w);
      }
      const stamped = new Set<string>();
      for (const e of w.query([G.AbandonedSite])) if (G.isRealisticKind(w.getField(e, G.AbandonedSite, "kind")!)) stamped.add(`${w.getField(e, G.AbandonedSite, "originX")},${w.getField(e, G.AbandonedSite, "originY")}`);
      const mapped = new Set(G.mapAbandonedSites(seed, (x, y) => gen.sampleAt(x, y), CX0, CY0, CX1, CY1).filter((s) => G.isRealisticKind(s.kind)).map((s) => `${s.originX},${s.originY}`));
      expect(stamped.size).toBeGreaterThan(5);
      expect([...stamped].sort()).toEqual([...mapped].sort());
    }
  }, 120_000);

  it("plans cheaply and stamps within the per-tick piece budget", () => {
    const t0 = performance.now();
    for (let cy = -50; cy <= 50; cy++) for (let cx = -50; cx <= 50; cx++) G.planSettlementChunk(11, cx, cy, { tileAt: () => 3 });
    const per = (performance.now() - t0) / 101 / 101;
    console.log(`ADR-595 planSettlementChunk ${(per * 1000).toFixed(1)} µs/chunk`);
    expect(per).toBeLessThan(0.5);
    // the largest kind stamps on the time-sliced pump, never more than the A16 per-tick piece budget per step
    const w = makeWorld();
    const big = G.REALISTIC_KINDS.reduce((a, d, i) => (d.w * d.h > G.REALISTIC_KINDS[a]!.w * G.REALISTIC_KINDS[a]!.h ? i : a), 0);
    G.stampAbandonedSite(w, 4, 4, { kind: (G.REALISTIC_BASE + big) as G.AbandonedKindId, rot: 0, ruin: 0.5 });
    let ticks = 0, n: number;
    while ((n = G.pumpAbandonedStamps(w)) > 0) { expect(n).toBeLessThanOrEqual(G.ABANDONED_STAMP_PIECES_PER_TICK); ticks++; }
    expect(ticks).toBeGreaterThan(1);
  });
});
