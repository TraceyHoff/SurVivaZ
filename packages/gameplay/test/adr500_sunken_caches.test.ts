/**
 * ADR-500: sunken caches in deep water. The generator never placed any node on water tiles (the tile loop's
 * `tile !== 1 && tile !== 8` guard), and a deep-water-only restriction is not expressible in band data, so the
 * cache is placed by its own scatter pass inside the generator — its own rng stream (salted `cache:`), so the
 * land-node distribution is byte-identical with the pass on or off (the hash below is the proof: it was recorded
 * on the pre-change tree for the same 49-chunk seed-42 grid). The cache is a one-shot node (gather once, gone
 * forever — no regrow), drawn with the existing `basket` art (storage_box at 0.6 scale, tinted — the fallback
 * table), and gathered like any other node: a wading/swimming player reaches it from the tile beside it.
 * The cache renders as a basket sitting on the water surface (terrain pass first, dynamic sprites after, per-vertex
 * depth) — Tracey's eyes on the live build are the check that it reads as "sunken" rather than "floating".
 */
import { describe, it, expect } from "vitest";
import { fnv1a, Transform } from "@engine/core";
import { ProceduralGenerator, chunkKeyOf, waterDepthAt, WaterDepth } from "@engine/world";
import * as G from "../src/index.js";
import { worldgenBands } from "../src/world.js";
import { makeWorld, steps, spawnLearned } from "./helpers.js";

const SEED = 42;
/** The 49-chunk grid the baseline was recorded on (seed 42, production bands, pre-change tree): 3,120 land nodes. */
const GRID = { min: -3, max: 3 };
/** fnv1a over the sorted (cx,cy,tx,ty,kind) tuples of every non-cache node in GRID — recorded before the generator change. */
const BASELINE_HASH = 1781826264;
const BASELINE_NODES = 3120;

const genWithCaches = (chance = 0.02): ProceduralGenerator => {
  const defs = G.defaultDefs();
  return new ProceduralGenerator({ seed: SEED, bands: worldgenBands(defs), sunkenCacheKind: defs.resourceId("sunken_cache"), sunkenCacheChance: chance });
};
const genWithoutCaches = (): ProceduralGenerator => {
  const defs = G.defaultDefs();
  return new ProceduralGenerator({ seed: SEED, bands: worldgenBands(defs) });
};
const gridNodes = (gen: ProceduralGenerator): { cx: number; cy: number; tx: number; ty: number; kind: number }[] => {
  const out: { cx: number; cy: number; tx: number; ty: number; kind: number }[] = [];
  for (let cy = GRID.min; cy <= GRID.max; cy++) for (let cx = GRID.min; cx <= GRID.max; cx++)
    for (const n of gen.nodesInChunk(cx, cy)) out.push({ cx, cy, tx: n.tx, ty: n.ty, kind: n.kind });
  return out;
};
const hashOf = (nodes: readonly { cx: number; cy: number; tx: number; ty: number; kind: number }[]): number =>
  fnv1a(nodes.map((n) => `${n.cx},${n.cy},${n.tx},${n.ty},${n.kind}`).sort().join(";"));

describe("ADR-500 sunken caches in deep water", () => {
  it("data: the sunken_cache node (basket art, one-shot, fixed loot table)", () => {
    const defs = G.defaultDefs();
    const def = defs.resources.get(defs.resourceId("sunken_cache"));
    expect(def).toBeDefined();
    expect(def!.spriteKey).toBe("basket"); // the fallback table draws it as storage_box at 0.6, tinted #d0b070
    expect(def!.oneShot).toBe(true); // gather once, gone forever — a find, not a farm
    expect(def!.capacity).toBe(1);
    expect(def!.requiredTool).toBe(0); // ToolKind.None
    const coin = def!.yields.find((y) => y.item === defs.itemId("coin"));
    expect(coin).toBeDefined(); expect(coin!.chance).toBe(1); expect(coin!.min).toBe(5); expect(coin!.max).toBe(15);
    for (const item of ["canned_fish", "salt", "waterskin", "iron_axe"]) {
      const y = def!.yields.find((y) => y.item === defs.itemId(item));
      expect(y, item).toBeDefined(); expect(y!.chance).toBeGreaterThan(0); expect(y!.chance).toBeLessThanOrEqual(1);
    }
    expect(defs.worldgen.sunkenCacheChance).toBe(0.02);
  });

  it("placement: caches scatter on deep water only, never on land, shore or a land node's tile", () => {
    const defs = G.defaultDefs();
    const cacheKind = defs.resourceId("sunken_cache");
    const gen = genWithCaches();
    const all = gridNodes(gen);
    const caches = all.filter((n) => n.kind === cacheKind);
    const land = all.filter((n) => n.kind !== cacheKind);
    expect(caches.length).toBeGreaterThan(0); // ~26 expected at 0.02 over 1,287 deep tiles
    expect(caches.length).toBeLessThan(200);
    const landTiles = new Set(land.map((n) => `${n.tx},${n.ty}`));
    for (const c of caches) {
      expect(gen.tileAt(c.tx, c.ty)).toBe(1); // water, not the shallow tile 8 and not land
      expect(waterDepthAt((x, y) => gen.tileAt(x, y), c.tx, c.ty)).toBe(WaterDepth.Deep);
      expect(landTiles.has(`${c.tx},${c.ty}`)).toBe(false);
    }
  });

  it("distribution: the land-node distribution is byte-identical with the pass on or off", () => {
    const defs = G.defaultDefs();
    const cacheKind = defs.resourceId("sunken_cache");
    const withCaches = gridNodes(genWithCaches()).filter((n) => n.kind !== cacheKind);
    expect(withCaches.length).toBe(BASELINE_NODES);
    expect(hashOf(withCaches)).toBe(BASELINE_HASH);
    // And without the kind at all (the pass off), the same grid gives the same hash.
    const without = gridNodes(genWithoutCaches());
    expect(without.length).toBe(BASELINE_NODES);
    expect(hashOf(without)).toBe(BASELINE_HASH);
    expect(without.some((n) => n.kind === cacheKind)).toBe(false);
  });

  it("load() and nodesInChunk() agree exactly (ADR-343 mirror)", () => {
    const gen = genWithCaches();
    for (const [cx, cy] of [[0, 0], [1, -1], [-2, 2], [3, 3]] as const) {
      expect(gen.load(cx, cy).nodes).toEqual(gen.nodesInChunk(cx, cy));
    }
  });

  it("spawn: the generator's placements spawn a real cache node (kind + amount 1)", () => {
    const w = makeWorld();
    const defs = G.defaultDefs();
    const cacheKind = defs.resourceId("sunken_cache");
    const gen = genWithCaches();
    // Find one cache placement and spawn its chunk's nodes through the production path.
    let found: { cx: number; cy: number; tx: number; ty: number } | undefined;
    outer: for (let cy = GRID.min; cy <= GRID.max; cy++) for (let cx = GRID.min; cx <= GRID.max; cx++)
      for (const n of gen.nodesInChunk(cx, cy)) if (n.kind === cacheKind) { found = { cx, cy, tx: n.tx, ty: n.ty }; break outer; }
    expect(found).toBeDefined();
    const out = G.spawnChunkNodes(w, chunkKeyOf(found!.tx, found!.ty), gen.nodesInChunk(found!.cx, found!.cy));
    const cache = out.find((e) => w.getField(e, G.ResourceNode, "kind") === cacheKind);
    expect(cache).toBeDefined();
    expect(w.getField(cache!, G.ResourceNode, "amount")).toBe(1);
  });

  it("gather: a wading player loots a deep-water cache from the tile beside it; the node is gone after", () => {
    // The adr489 lake: tile 1 on tx 0..19, shallow x 0..1 / 18..19, deep x 2..17 (the adr489 pattern —
    // makeWorld takes no tileAt option; the terrain is set as a resource after).
    const w = makeWorld();
    w.setResource(G.TerrainRes, { tileAt: (tx: number) => (tx >= 0 && tx < 20 ? 1 : 3), heightAt: () => 0 });
    const p = spawnLearned(w, { x: 1.5, y: 5.5 }); // wading in the shallows, facing the deep tile (2,5)
    w.setField(p, Transform, "facing", 0);
    const cache = G.spawnResourceNode(w, "sunken_cache", 2.5, 5.5);
    G.setIntent(w, p, { action: G.IntentAction.Gather, target: cache });
    steps(w, 30); // one gather swing (cooldown 1.5 s)
    expect(w.isAlive(cache)).toBe(false); // oneShot: gone after the single gather
    expect(G.countItem(w, p, G.defaultDefs().itemId("coin"))).toBeGreaterThanOrEqual(5);
  });

  it("prospect: a bot expedition never targets a deep-water cache (ADR-252 live pad stall)", () => {
    // A sunken cache is the nearest source of coin / canned fish / salt / waterskin / iron_axe, so
    // prospectResource would otherwise send a bot on an expedition to a node it can never reach (AI
    // walkers cannot enter deep water, ADR-181). The bot walked to the shore, failed, re-prospected
    // the same cache and set out again — in the ADR-252 live test bot0 wandered ~200 tiles from its
    // base and never built its pad or foundation. The fix skips deep-water nodes in prospectResource.
    const w = makeWorld();
    w.setResource(G.TerrainRes, { tileAt: (tx: number) => (tx >= 0 && tx < 20 ? 1 : 3), heightAt: () => 0 });
    const cacheKind = G.defaultDefs().resourceId("sunken_cache");
    // Deep cache CLOSE to the origin (2.5, 0.5) and a shallow cache FARTHER (0.5, 5.5): without the
    // filter the nearer deep cache wins; with it the shallow cache is the prospect.
    G.spawnResourceNode(w, "sunken_cache", 2.5, 0.5);
    G.spawnResourceNode(w, "sunken_cache", 0.5, 5.5);
    expect(G.prospectResource(w, 0, 0, new Set([cacheKind]))).toEqual({ x: 0.5, y: 5.5, kind: cacheKind });
    // And with only the deep cache placed, it is never the prospect (the generator fallback may
    // return a generated node elsewhere, but never the placed deep one).
    const w2 = makeWorld();
    w2.setResource(G.TerrainRes, { tileAt: (tx: number) => (tx >= 0 && tx < 20 ? 1 : 3), heightAt: () => 0 });
    G.spawnResourceNode(w2, "sunken_cache", 2.5, 0.5);
    const hit = G.prospectResource(w2, 0, 0, new Set([cacheKind]));
    expect(hit === undefined || !(hit.x === 2.5 && hit.y === 0.5)).toBe(true);
  });
});
