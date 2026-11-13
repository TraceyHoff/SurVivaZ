import { describe, expect, it } from "vitest";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

function keys(w: ReturnType<typeof makeWorld>, ents: readonly number[]) {
  const d = G.gameplayDefs(w);
  return ents.map((e) => d.pieces.get(w.getField(e, G.BuildPiece, "type")!)?.key ?? "?");
}

const NEW_KINDS = [
  G.AbandonedKind.Mill, G.AbandonedKind.Schoolhouse, G.AbandonedKind.Chapel, G.AbandonedKind.TradingPost,
  G.AbandonedKind.Smithy, G.AbandonedKind.Bakery, G.AbandonedKind.Stable, G.AbandonedKind.Watchtower,
  G.AbandonedKind.Bathhouse, G.AbandonedKind.Inn, G.AbandonedKind.Apiary, G.AbandonedKind.Granary,
  G.AbandonedKind.FisherHut, G.AbandonedKind.Barracks,
] as const;

const SIGNATURES: Record<number, readonly string[]> = {
  [G.AbandonedKind.Mill]: ["workbench", "crop_store", "stone_store"],
  [G.AbandonedKind.Schoolhouse]: ["desk_rustic", "bookcase_rustic"],
  [G.AbandonedKind.Chapel]: ["bench_rustic", "statue"],
  [G.AbandonedKind.TradingPost]: ["counter_rustic", "stall_booth"],
  [G.AbandonedKind.Smithy]: ["anvil", "furnace", "tool_bench"],
  [G.AbandonedKind.Bakery]: ["clay_oven", "cook_range", "pantry"],
  [G.AbandonedKind.Stable]: ["feeding_trough"],
  [G.AbandonedKind.Watchtower]: ["watchtower"],
  [G.AbandonedKind.Bathhouse]: ["fountain"],
  [G.AbandonedKind.Inn]: ["table_dining_rustic", "stairs"],
  [G.AbandonedKind.Apiary]: ["apiary"],
  [G.AbandonedKind.Granary]: ["crop_store", "ore_store", "log_store", "stick_store"],
  [G.AbandonedKind.FisherHut]: ["basket", "campfire"],
  [G.AbandonedKind.Barracks]: ["bunk_bed"],
};

describe("ADR-373 abandoned variety", () => {
  it("doubles the catalogue: 28 kinds, every kind id has a key and a weight", () => {
    expect(G.ABANDONED_KIND_KEYS.length).toBe(28);
    expect(new Set(G.ABANDONED_KIND_KEYS).size).toBe(28);
    const ids = Object.values(G.AbandonedKind) as number[];
    expect(ids.length).toBe(28);
    expect(Math.min(...ids)).toBe(0);
    expect(Math.max(...ids)).toBe(27);
    // Old kinds keep their ids and keys (save/reclaim/claim code references them by id).
    expect(G.AbandonedKind.Shed).toBe(0);
    expect(G.AbandonedKind.Manor).toBe(13);
    expect(G.ABANDONED_KIND_KEYS[13]).toBe("manor");
    expect(G.ABANDONED_KIND_KEYS[14]).toBe("mill");
    expect(G.ABANDONED_KIND_KEYS[27]).toBe("barracks");
  });

  it("KIND_WEIGHTS sums to 146 with the old weights untouched and every kind reachable", () => {
    const total = G.KIND_WEIGHTS.reduce((a, k) => a + k.w, 0);
    expect(total).toBe(146);
    expect(G.KIND_WEIGHTS.length).toBe(28);
    const byKind = new Map(G.KIND_WEIGHTS.map((k) => [k.kind, k.w]));
    expect(byKind.size).toBe(28);
    for (const k of G.KIND_WEIGHTS) expect(k.w).toBeGreaterThan(0);
    // Old weights, unchanged from before ADR-373 (they summed to 100).
    expect(byKind.get(G.AbandonedKind.Shed)).toBe(12);
    expect(byKind.get(G.AbandonedKind.Cottage)).toBe(12);
    expect(byKind.get(G.AbandonedKind.Homestead)).toBe(11);
    expect(byKind.get(G.AbandonedKind.Manor)).toBe(2);
    // The new kinds together take 46/146 (~31%) of sites.
    const added = NEW_KINDS.reduce((a, k) => a + (byKind.get(k) ?? 0), 0);
    expect(added).toBe(46);
    // Weighted pick actually reaches every kind over many seeded draws.
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) seen.add(G.planAbandonedSite(1000 + i, 10, 20).kind);
    expect(seen.size).toBe(28);
  });

  it("plans every new kind deterministically with a valid footprint, rooms and furniture", () => {
    const w = makeWorld();
    const defs = G.gameplayDefs(w);
    for (const kind of NEW_KINDS) {
      const a = G.planAbandonedSite(42, 10, 20, { kind, rot: 0, ruin: 0 });
      const b = G.planAbandonedSite(42, 10, 20, { kind, rot: 0, ruin: 0 });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(a.kindKey).toBe(G.ABANDONED_KIND_KEYS[kind]);
      expect(a.width).toBeGreaterThanOrEqual(3);
      expect(a.height).toBeGreaterThanOrEqual(3);
      // Fits a chunk with the planAbandonedChunk margin (w+4 <= 32, h+4 <= 32).
      expect(a.width + 4).toBeLessThanOrEqual(32);
      expect(a.height + 4).toBeLessThanOrEqual(32);
      expect(a.stories).toBeGreaterThanOrEqual(1);
      expect(a.pieces.length).toBeGreaterThan(10);
      // Every planned piece key resolves in the piece defs and lies inside the footprint.
      for (const p of a.pieces) {
        expect(() => defs.pieceId(p.key)).not.toThrow();
        expect(p.x).toBeGreaterThanOrEqual(10);
        expect(p.x).toBeLessThanOrEqual(10 + a.width);
        expect(p.y).toBeGreaterThanOrEqual(20);
        expect(p.y).toBeLessThanOrEqual(20 + a.height);
        expect(p.level).toBeGreaterThanOrEqual(0);
        expect(p.level).toBeLessThanOrEqual(a.stories);
      }
      // Enclosed: foundations under the house, walls, a door, a roof at the top story.
      const ks = a.pieces.map((p) => p.key);
      expect(ks).toContain("foundation");
      expect(ks).toContain("wall_corner_outer");
      expect(ks).toContain("door_wood");
      expect(ks.some((k) => k.startsWith("roof_"))).toBe(true);
      expect(a.pieces.some((p) => p.key.startsWith("roof_") && p.level === a.stories)).toBe(true);
      // Signature furniture for the kind is in the plan.
      for (const sig of SIGNATURES[kind]!) expect(ks).toContain(sig);
      if (a.stories >= 2) expect(ks).toContain("stairs");
    }
    // Catalogue facts for the new kinds.
    expect(G.catalogHas(G.AbandonedKind.Inn).stories).toBe(2);
    expect(G.catalogHas(G.AbandonedKind.Stable).pen).toBe(true);
    expect(G.catalogHas(G.AbandonedKind.Bathhouse).garden).toBe(true);
    expect(G.catalogHas(G.AbandonedKind.Apiary).garden).toBe(true);
    expect(G.catalogHas(G.AbandonedKind.Watchtower).w).toBe(6);
    expect(G.catalogHas(G.AbandonedKind.Chapel).h).toBe(6);
  });

  it("stamps every new kind from real pieces, including its signature furniture", () => {
    for (const kind of NEW_KINDS) {
      const w = makeWorld();
      const r = G.stampAbandonedSite(w, 8, 8, { kind, rot: 0, ruin: 0, tier: 1 });
      G.drainAbandonedStamps(w); // ADR-382: the stamp completes over ticks; drain it for the assertions below
      expect(r.skipped).toBe(false);
      expect(r.marker).toBeGreaterThan(0);
      const ks = keys(w, r.placed);
      for (const sig of SIGNATURES[kind]!) expect(ks).toContain(sig);
      expect(ks).toContain("foundation");
      expect(ks.some((k) => k.startsWith("roof_"))).toBe(true);
      if (kind === G.AbandonedKind.Stable) expect(r.pen).toBe(true);
      if (kind === G.AbandonedKind.Bathhouse || kind === G.AbandonedKind.Apiary) expect(r.garden).toBe(true);
      if (kind === G.AbandonedKind.Inn) {
        expect(r.stories).toBe(2);
        expect(ks).toContain("stairs");
      }
    }
  });

  it("keeps the old kinds planning as before", () => {
    expect(G.catalogHas(G.AbandonedKind.Shed)).toEqual({ stories: 1, garden: false, pen: false, w: 3, h: 3 });
    expect(G.catalogHas(G.AbandonedKind.Homestead).garden).toBe(true);
    expect(G.catalogHas(G.AbandonedKind.Homestead).pen).toBe(true);
    expect(G.catalogHas(G.AbandonedKind.Townhouse).stories).toBe(3);
    expect(G.catalogHas(G.AbandonedKind.Manor).stories).toBe(2);
    const a = G.planAbandonedSite(42, 10, 20, { kind: G.AbandonedKind.Shed, rot: 0, ruin: 0 });
    expect(a.pieces.filter((p) => p.key === "foundation").length).toBe(9);
    expect(a.pieces.every((p) => !p.omit)).toBe(true);
    const b = G.planAbandonedSite(42, 10, 20, { kind: G.AbandonedKind.Shed, rot: 0, ruin: 0 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const w = makeWorld();
    const r = G.stampAbandonedSite(w, 8, 8, { kind: G.AbandonedKind.Shed, rot: 0, ruin: 0, tier: 1 });
    G.drainAbandonedStamps(w); // ADR-382: the stamp completes over ticks; drain it for the assertions below
    expect(r.skipped).toBe(false);
    expect(keys(w, r.placed).filter((k) => k === "foundation").length).toBe(9);
  });

  it("raises density a little: SITE_CHANCE 0.15, ~15 sites per 100 chunks", () => {
    expect(G.SITE_CHANCE).toBe(0.15);
    // 1600 chunks at 0.15 -> mean 240, sd ~14.3; the old 0.12 gave 189 on this seed.
    let planned = 0;
    for (let cy = 0; cy < 40; cy++) for (let cx = 0; cx < 40; cx++) if (G.planAbandonedChunk(42, cx, cy)) planned++;
    expect(planned).toBeGreaterThanOrEqual(190);
    expect(planned).toBeLessThanOrEqual(290);
    // Expected sites per area: 0.15/chunk = 15 per 100 chunks = 15 per 10x10-chunk region.
    expect(G.SITE_CHANCE * 100).toBeCloseTo(15);
  });

  it("never overlaps two sites in a multi-chunk plan sweep or stamp sweep", () => {
    const rects: { x0: number; y0: number; x1: number; y1: number }[] = [];
    for (let cy = 0; cy < 16; cy++) {
      for (let cx = 0; cx < 16; cx++) {
        const plan = G.planAbandonedChunk(7, cx, cy);
        if (!plan) continue;
        const built = G.catalogHas(plan.kind);
        // planAbandonedChunk rotates the footprint; use the planned kind's catalogue size
        // conservatively (max of w/h) so the check holds under any rotation.
        const s = Math.max(built.w, built.h);
        rects.push({ x0: plan.originX, y0: plan.originY, x1: plan.originX + s, y1: plan.originY + s });
      }
    }
    expect(rects.length).toBeGreaterThan(10);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!, b = rects[j]!;
        expect(a.x0 >= b.x1 || a.x1 <= b.x0 || a.y0 >= b.y1 || a.y1 <= b.y0).toBe(true);
      }
    }
    // Real stamps: marker footprints never overlap either.
    const w = makeWorld();
    const stamped: { x0: number; y0: number; x1: number; y1: number }[] = [];
    for (let cy = 0; cy < 6; cy++) {
      for (let cx = 0; cx < 6; cx++) {
        const plan = G.planAbandonedChunk(7, cx, cy);
        if (!plan) continue;
        const r = G.stampAbandonedSite(w, plan.originX, plan.originY, { kind: plan.kind, rot: plan.rot, ruin: plan.ruin });
        G.drainAbandonedStamps(w); // ADR-382: the stamp completes over ticks; drain it for the assertions below
        if (r.skipped || !r.marker) continue;
        const mw = w.getField(r.marker, G.AbandonedSite, "width")!;
        const mh = w.getField(r.marker, G.AbandonedSite, "height")!;
        stamped.push({ x0: plan.originX, y0: plan.originY, x1: plan.originX + mw, y1: plan.originY + mh });
      }
    }
    expect(stamped.length).toBeGreaterThan(0);
    for (let i = 0; i < stamped.length; i++) {
      for (let j = i + 1; j < stamped.length; j++) {
        const a = stamped[i]!, b = stamped[j]!;
        expect(a.x0 >= b.x1 || a.x1 <= b.x0 || a.y0 >= b.y1 || a.y1 <= b.y0).toBe(true);
      }
    }
  });

  it("reports stamp timing for the ADR-373 report (no assertion on wall time)", () => {
    const t0 = performance.now();
    let planned = 0;
    for (let cy = 0; cy < 40; cy++) for (let cx = 0; cx < 40; cx++) if (G.planAbandonedChunk(42, cx, cy)) planned++;
    const t1 = performance.now();
    const w = makeWorld();
    let stamped = 0; let placed = 0;
    for (let i = 0; i < 40; i++) {
      const r = G.stampAbandonedSite(w, 8 + (i % 8) * 40, 8 + Math.floor(i / 8) * 40, { kind: (i % 28) as never, rot: 0, ruin: 0, tier: 1 });
      G.drainAbandonedStamps(w); // ADR-382: the stamp completes over ticks; drain it for the assertions below
      if (!r.skipped) { stamped++; placed += r.placed.length; }
    }
    const t2 = performance.now();
    console.log(`[timing] ADR-373 plan sweep 1600 chunks: ${(t1 - t0).toFixed(1)}ms, planned=${planned}; stamp 40 sites: ${(t2 - t1).toFixed(1)}ms, stamped=${stamped}, placed=${placed}`);
    expect(planned).toBeGreaterThan(0);
    expect(stamped).toBeGreaterThan(0);
  });
});
