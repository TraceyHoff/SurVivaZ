import { describe, expect, it } from "vitest";
import { Transform } from "@engine/core";
import { ChunkManager, ProceduralGenerator } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld, steps } from "./helpers.js";

function keys(w: ReturnType<typeof makeWorld>, ents: readonly number[]) {
  const d = G.gameplayDefs(w);
  return ents.map((e) => d.pieces.get(w.getField(e, G.BuildPiece, "type")!)?.key ?? "?");
}
function zOf(w: ReturnType<typeof makeWorld>, e: number) {
  return w.getField(e, G.PieceSlot, "z") ?? Math.round((w.getField(e, Transform, "z") ?? 0) / G.gameplayDefs(w).building.levelHeight);
}
/** Exact final-site signature: key, position, level, rot, tier, hp — order-insensitive. */
function sig(w: ReturnType<typeof makeWorld>, ents: readonly number[]) {
  return ents.map((e) => {
    const t = w.get(e, Transform)!;
    const k = G.gameplayDefs(w).pieces.get(w.getField(e, G.BuildPiece, "type")!)?.key ?? "?";
    return `${k}@${t.x.toFixed(2)},${t.y.toFixed(2)},${zOf(w, e)},r${w.getField(e, G.BuildPiece, "rot")},t${w.getField(e, G.BuildPiece, "tier")},hp${w.getField(e, G.BuildPiece, "hp")}`;
  }).sort();
}
function lootSig(w: ReturnType<typeof makeWorld>, ents: readonly number[]) {
  const ks = keys(w, ents);
  return ents.flatMap((e, i) => {
    const k = ks[i]!;
    if (!(k.includes("storage") || k.includes("chest") || k === "barrel_storage" || k.includes("wardrobe"))) return [];
    const st = G.resolveAttachment(w, e, G.AttachKind.Storage);
    if (!st) return [`${k}:nostorage`];
    return G.listSlots(w, st).map((s) => `${k}:${s.item}:${s.count}`);
  }).sort();
}
const MANOR = { kind: G.AbandonedKind.Manor, rot: 0, ruin: 0, tier: 1 } as const;
function stampManor(w: ReturnType<typeof makeWorld>, ox = 8, oy = 8) {
  return G.stampAbandonedSite(w, ox, oy, { ...MANOR });
}
/** The uninterrupted reference: same seed/origin/opts, drained in a fresh world. */
function referenceManor(seed = 42, ox = 8, oy = 8) {
  const w = makeWorld({}, seed);
  const r = stampManor(w, ox, oy);
  G.drainAbandonedStamps(w);
  expect(r.pending).toBe(false);
  expect(r.skipped).toBe(false);
  return { w, r, signature: sig(w, r.placed), loot: lootSig(w, r.placed) };
}

describe("ADR-382 time-sliced abandoned stamping", () => {
  it("never places more than the per-tick cap in one pump call", () => {
    const w = makeWorld();
    const r = stampManor(w);
    expect(r.pending).toBe(true);
    expect(r.marker).toBe(0);
    expect(r.placed.length).toBe(0);
    const placed = G.pumpAbandonedStamps(w);
    expect(placed).toBeLessThanOrEqual(G.ABANDONED_STAMP_PIECES_PER_TICK);
    expect(placed).toBeGreaterThan(0);
    expect(r.placed.length).toBe(placed);
    expect(r.pending).toBe(true);
    // An explicit smaller cap is honoured too.
    const w2 = makeWorld();
    stampManor(w2);
    expect(G.pumpAbandonedStamps(w2, 5)).toBeLessThanOrEqual(5);
    expect(G.pendingAbandonedStamps(w2)[0]!.placed).toBeLessThanOrEqual(5);
  });

  it("lands foundations first, so the site keeps its shape while it builds", () => {
    const w = makeWorld();
    const r = stampManor(w);
    G.pumpAbandonedStamps(w);
    expect(r.placed.length).toBeGreaterThan(0);
    // Manor level-0 deck is 42 foundations; the first slice is all foundations.
    expect(keys(w, r.placed).every((k) => k === "foundation")).toBe(true);
    expect(keys(w, r.placed).some((k) => k.startsWith("roof_"))).toBe(false);
  });

  it("completes over ticks through the world.step pump and the handle goes live", () => {
    const ref = referenceManor();
    const w = makeWorld();
    const r = stampManor(w);
    steps(w, 1);
    expect(r.placed.length).toBeLessThanOrEqual(G.ABANDONED_STAMP_PIECES_PER_TICK);
    expect(r.pending).toBe(true);
    steps(w, 30);
    expect(r.pending).toBe(false);
    expect(r.marker).toBeGreaterThan(0);
    expect(r.skipped).toBe(false);
    expect(G.pendingAbandonedStamps(w)).toEqual([]);
    expect(sig(w, r.placed)).toEqual(ref.signature);
    expect(lootSig(w, r.placed)).toEqual(ref.loot);
    // The finished site is visible to the marker flows.
    expect(G.siteOf(w, r.placed[0]!)).toBe(r.marker);
  });

  it("is deterministic: drain, one-piece-at-a-time, and stepped pumps end identical", () => {
    const ref = referenceManor();
    const slow = makeWorld();
    const rs = stampManor(slow);
    let guard = 0;
    while (G.pendingAbandonedStamps(slow).length > 0 && guard++ < 5000) G.pumpAbandonedStamps(slow, 1);
    expect(rs.pending).toBe(false);
    expect(sig(slow, rs.placed)).toEqual(ref.signature);
    expect(lootSig(slow, rs.placed)).toEqual(ref.loot);
  });

  it("re-stamping while pending returns the same handle and never duplicates", () => {
    const ref = referenceManor();
    const w = makeWorld();
    const first = stampManor(w);
    G.pumpAbandonedStamps(w);
    const second = stampManor(w);
    expect(second).toBe(first);
    expect(first.placed.length).toBeLessThanOrEqual(G.ABANDONED_STAMP_PIECES_PER_TICK);
    G.drainAbandonedStamps(w);
    expect(first.pending).toBe(false);
    expect(sig(w, first.placed)).toEqual(ref.signature);
    expect(lootSig(w, first.placed)).toEqual(ref.loot);
  });

  it("caps the total per tick across concurrent stamps", () => {
    const w = makeWorld();
    stampManor(w, 8, 8);
    stampManor(w, 200, 8);
    stampManor(w, 400, 8);
    expect(G.pendingAbandonedStamps(w).length).toBe(3);
    steps(w, 1);
    expect([...w.query([G.BuildPiece])].length).toBeLessThanOrEqual(G.ABANDONED_STAMP_PIECES_PER_TICK);
  });

  it("rolls back a stamp whose chunk unloads mid-stamp, and a reload re-stamps it cleanly", () => {
    const seed = 1234;
    const w = makeWorld({}, seed);
    // One chunk at a time (loadRadius 0, no cache): moving the source evicts the old chunk.
    const chunks = new ChunkManager({ provider: new ProceduralGenerator({ seed }), loadRadius: 0, unloadMargin: 0, cacheSize: 0 });
    const terrain = G.terrainFromTileMap(chunks);
    w.setResource(G.TerrainRes, terrain);
    chunks.onLoad((c) => { G.stampAbandonedChunk(w, c.key); });
    // Scan chunk candidates until one actually enqueues a stamp (plan + terrain must pass).
    let found: { cx: number; cy: number; plan: { originX: number; originY: number; kind: G.AbandonedKindId; rot: number; ruin: number } } | undefined;
    for (let cx = 16; cx < 60 && !found; cx++) {
      const plan = G.planAbandonedChunk(seed, cx, 16);
      if (!plan) continue;
      chunks.setSource({ id: 1, x: cx * 32 + 16, y: 16 * 32 + 16, radius: 0 });
      chunks.update();
      if (G.pendingAbandonedStamps(w).some((p) => p.originX === plan.originX && p.originY === plan.originY)) {
        found = { cx, cy: 16, plan };
      }
    }
    expect(found).toBeDefined();
    const { plan } = found!;
    const ox = plan.originX, oy = plan.originY;
    // Partially stamp it, then move away: the chunk is evicted at once (cacheSize 0).
    expect(G.pumpAbandonedStamps(w, 5)).toBe(5);
    expect(G.pendingAbandonedStamps(w).find((p) => p.originX === ox && p.originY === oy)).toBeDefined();
    expect([...w.query([G.BuildPiece])].length).toBe(5);
    chunks.setSource({ id: 1, x: 5000, y: 5000, radius: 0 });
    chunks.update();
    expect(terrain.loaded!(ox, oy)).toBe(false);
    // The next tick's pump sees the chunk is gone and rolls the stamp back: no leak.
    steps(w, 1);
    expect(G.pendingAbandonedStamps(w)).toEqual([]);
    expect([...w.query([G.BuildPiece])].length).toBe(0);
    // Move back: the chunk reloads, the site re-stamps from scratch, and it completes
    // exactly like the uninterrupted reference (no duplicates, same loot).
    chunks.setSource({ id: 1, x: found!.cx * 32 + 16, y: 16 * 32 + 16, radius: 0 });
    chunks.update();
    expect(G.pendingAbandonedStamps(w).find((p) => p.originX === ox && p.originY === oy)).toBeDefined();
    // No single step may add more than the cap while it completes.
    let prev = [...w.query([G.BuildPiece])].length;
    for (let s = 0; s < 40 && G.pendingAbandonedStamps(w).length > 0; s++) {
      steps(w, 1);
      const now = [...w.query([G.BuildPiece])].length;
      expect(now - prev).toBeLessThanOrEqual(G.ABANDONED_STAMP_PIECES_PER_TICK);
      prev = now;
    }
    expect(G.pendingAbandonedStamps(w)).toEqual([]);
    // Reference: the same chunk (same generated terrain, so the same validation
    // outcomes) stamped uninterrupted in a fresh world.
    const ref = makeWorld({}, seed);
    const refChunks = new ChunkManager({ provider: new ProceduralGenerator({ seed }), loadRadius: 0, unloadMargin: 0, cacheSize: 0 });
    ref.setResource(G.TerrainRes, G.terrainFromTileMap(refChunks));
    refChunks.setSource({ id: 1, x: found!.cx * 32 + 16, y: 16 * 32 + 16, radius: 0 });
    refChunks.update();
    const rr = G.stampAbandonedSite(ref, ox, oy, { kind: plan.kind, rot: plan.rot, ruin: plan.ruin });
    G.drainAbandonedStamps(ref);
    const planSite = G.planAbandonedSite(seed, ox, oy, { kind: plan.kind, rot: plan.rot, ruin: plan.ruin });
    const done = [...w.query([G.BuildPiece, Transform])].filter((e) => {
      const t = w.get(e, Transform)!;
      return t.x >= ox - 0.05 && t.x < ox + planSite.width + 0.05 && t.y >= oy - 0.05 && t.y < oy + planSite.height + 0.05;
    });
    expect(sig(w, done)).toEqual(sig(ref, rr.placed));
    expect(lootSig(w, done)).toEqual(lootSig(ref, rr.placed));
  });

  it("resumes a stamp cut off by a restart from its standing pieces, identically", () => {
    const ref = referenceManor();
    const w = makeWorld();
    const r = stampManor(w);
    expect(G.pumpAbandonedStamps(w)).toBe(G.ABANDONED_STAMP_PIECES_PER_TICK);
    expect(r.placed.length).toBe(G.ABANDONED_STAMP_PIECES_PER_TICK);
    // Simulate the process restart: the queue is gone, the pieces persist.
    expect(G._abandonedStampsInternal.forget(w, 8, 8)).toBe(true);
    expect(G.pendingAbandonedStamps(w)).toEqual([]);
    const resumed = stampManor(w);
    expect(resumed).not.toBe(r);
    expect(resumed.pending).toBe(true);
    expect(resumed.skipped).toBe(false);
    expect(resumed.placed.length).toBe(G.ABANDONED_STAMP_PIECES_PER_TICK);
    G.drainAbandonedStamps(w);
    expect(resumed.pending).toBe(false);
    expect(resumed.marker).toBeGreaterThan(0);
    expect(sig(w, resumed.placed)).toEqual(ref.signature);
    expect(lootSig(w, resumed.placed)).toEqual(ref.loot);
  });

  it("still skips a footprint blocked by a foreign piece", () => {
    const w = makeWorld();
    const plan = G.planAbandonedSite(42, 8, 8, { ...MANOR });
    const defs = G.gameplayDefs(w);
    const sn = G.snapPlacement(w, { piece: defs.pieceId("watchtower"), x: 8.5, y: 8.5, level: 0, rot: 0, tier: 0, variant: 0 });
    expect(typeof sn).not.toBe("number");
    if (typeof sn !== "number") G.placePiece(w, 0, sn, { pay: false });
    const t = [...w.query([G.BuildPiece, Transform])].map((e) => w.get(e, Transform)!);
    expect(t.some((p) => p.x >= 8 - 0.05 && p.x < 8 + plan.width + 0.05 && p.y >= 8 - 0.05 && p.y < 8 + plan.height + 0.05)).toBe(true);
    const r = stampManor(w);
    expect(r.skipped).toBe(true);
    expect(r.pending).toBe(false);
    expect(G.pendingAbandonedStamps(w)).toEqual([]);
  });
});
