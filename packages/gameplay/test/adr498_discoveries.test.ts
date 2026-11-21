/**
 * ADR-498: first-visit discoveries + the Guide journal. A chunk yields at most one discovery per
 * kind (ruin / lake / river); recording is deduped by (kind, chunk), most recent first, capped at
 * DISCOVERY_MAX (64). The journal labels come from discoveryLabel; the store lives on the player
 * in the Discoveries component (networked + persistent, same class as RecentCrafts).
 */
import { describe, it, expect } from "vitest";
import { CHUNK_SIZE, riverPoint, waterFeatureAt, waterFeatureLayout } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

const SEED = 42;
const layout0 = waterFeatureLayout(SEED);
const chunkOf = (tx: number, ty: number): { cx: number; cy: number } => ({ cx: Math.floor(tx / CHUNK_SIZE), cy: Math.floor(ty / CHUNK_SIZE) });

/** First river tile on the centreline with |u| <= 60 (a good stretch, near spawn). */
const riverTile = (): { tx: number; ty: number } => {
  for (let u = -60; u <= 60; u++) {
    const p = riverPoint(layout0, u);
    const tx = Math.floor(p.x), ty = Math.floor(p.y);
    if (waterFeatureAt(SEED, tx, ty, layout0) === "river") return { tx, ty };
  }
  throw new Error("no river tile found in region zero (seed 42)");
};
/** First chunk in a scan window that plans a ruin. */
const ruinChunk = (): { cx: number; cy: number; kind: number } => {
  for (let cy = -10; cy <= 10; cy++) for (let cx = -10; cx <= 10; cx++) {
    const plan = G.planAbandonedChunk(SEED, cx, cy);
    if (plan) return { cx, cy, kind: plan.kind };
  }
  throw new Error("no ruin chunk found near spawn (seed 42)");
};
/** First chunk in a scan window with no ruin, lake or river. */
const emptyChunk = (): { cx: number; cy: number } => {
  for (let cy = -10; cy <= 10; cy++) for (let cx = -10; cx <= 10; cx++) {
    if (G.chunkDiscoveries(makeWorld(), cx, cy).length === 0) return { cx, cy };
  }
  throw new Error("no empty chunk found near spawn (seed 42)");
};

describe("ADR-498 first-visit discoveries + the Guide journal", () => {
  it("data: the journal holds 64 discoveries (well above the Recent* cap of 8)", () => {
    expect(G.DISCOVERY_MAX).toBe(64);
    const w = makeWorld();
    expect(w.isRegistered(G.Discoveries)).toBe(true);
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    expect(G.discoveriesOf(w, p)).toEqual([]);
  });

  it("labels: lake / river / ruin kinds render as journal lines", () => {
    expect(G.discoveryLabel(G.DiscoveryKind.Lake)).toBe("A lake");
    expect(G.discoveryLabel(G.DiscoveryKind.River)).toBe("A river");
    expect(G.discoveryLabel(G.DiscoveryKind.RuinBase + G.AbandonedKind.Chapel)).toBe("Chapel ruins");
    expect(G.discoveryLabel(G.DiscoveryKind.RuinBase + G.AbandonedKind.FisherHut)).toBe("Fisher Hut ruins");
    expect(G.discoveryLabel(G.DiscoveryKind.RuinBase + G.AbandonedKind.TwoStoryFarmhouse)).toBe("Two Story Farmhouse ruins");
    expect(G.discoveryLabel(999)).toBe("Ruins");
  });

  it("chunkDiscoveries: a ruin chunk yields its planned kind; a river chunk a river; a lake chunk a lake; an empty chunk nothing", () => {
    const w = makeWorld();
    const ruin = ruinChunk();
    const rd = G.chunkDiscoveries(w, ruin.cx, ruin.cy);
    expect(rd).toContainEqual({ kind: G.DiscoveryKind.RuinBase + ruin.kind, cx: ruin.cx, cy: ruin.cy });
    const river = chunkOf(riverTile().tx, riverTile().ty);
    expect(G.chunkDiscoveries(w, river.cx, river.cy)).toContainEqual({ kind: G.DiscoveryKind.River, cx: river.cx, cy: river.cy });
    const lake = chunkOf(layout0.lake.x, layout0.lake.y);
    expect(G.chunkDiscoveries(w, lake.cx, lake.cy)).toContainEqual({ kind: G.DiscoveryKind.Lake, cx: lake.cx, cy: lake.cy });
    const empty = emptyChunk();
    expect(G.chunkDiscoveries(w, empty.cx, empty.cy)).toEqual([]);
  });

  it("recordChunkDiscoveries: records, dedups re-visits, most recent first", () => {
    const w = makeWorld();
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    const ruin = ruinChunk();
    const river = chunkOf(riverTile().tx, riverTile().ty);
    const first = G.recordChunkDiscoveries(w, p, ruin.cx, ruin.cy);
    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(first).toContainEqual({ kind: G.DiscoveryKind.RuinBase + ruin.kind, cx: ruin.cx, cy: ruin.cy });
    expect(G.discoveriesOf(w, p).length).toBe(first.length);
    // A re-visit records nothing and does not duplicate.
    expect(G.recordChunkDiscoveries(w, p, ruin.cx, ruin.cy)).toEqual([]);
    expect(G.discoveriesOf(w, p).length).toBe(first.length);
    // A second chunk's discoveries go first (most recent first) — ahead of the first chunk's.
    // (The river chunk may also hold a ruin, which is recorded ahead of its river within the chunk.)
    const second = G.recordChunkDiscoveries(w, p, river.cx, river.cy);
    expect(second).toContainEqual({ kind: G.DiscoveryKind.River, cx: river.cx, cy: river.cy });
    const all = G.discoveriesOf(w, p);
    expect(all.length).toBe(first.length + second.length);
    const riverIdx = all.findIndex((d) => d.kind === G.DiscoveryKind.River && d.cx === river.cx && d.cy === river.cy);
    const ruinIdx = all.findIndex((d) => d.kind === G.DiscoveryKind.RuinBase + ruin.kind && d.cx === ruin.cx && d.cy === ruin.cy);
    expect(riverIdx).toBeGreaterThanOrEqual(0);
    expect(ruinIdx).toBeGreaterThanOrEqual(0);
    expect(riverIdx).toBeLessThan(ruinIdx);
  });

  it("recordChunkDiscoveries: the journal caps at 64, oldest fall off", () => {
    const w = makeWorld();
    const p = G.spawnPlayer(w, { x: 0, y: 0 });
    let recorded = 0;
    let last: { cx: number; cy: number } | undefined;
    outer: for (let cy = -12; cy <= 12; cy++) for (let cx = -12; cx <= 12; cx++) {
      const found = G.recordChunkDiscoveries(w, p, cx, cy);
      if (found.length) { recorded += found.length; last = { cx, cy }; }
      if (recorded >= 70) break outer;
    }
    expect(recorded).toBeGreaterThanOrEqual(70);
    const all = G.discoveriesOf(w, p);
    expect(all.length).toBe(64);
    expect(all[0]!.cx).toBe(last!.cx);
    expect(all[0]!.cy).toBe(last!.cy);
    expect(w.get(p, G.Discoveries)!.count).toBe(64);
  });
});
