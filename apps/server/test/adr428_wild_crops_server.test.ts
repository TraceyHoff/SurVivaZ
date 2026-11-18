/**
 * ADR-428: wild crops and fruit trees spawn on the production server path.
 *
 * ADR-349 wired the data (worldgen.json bands) and proved it with a generator built the test-only
 * way (`new ProceduralGenerator({ seed, bands: worldgenBands(defs) })`). The production server
 * (`createGameServer`) built its ProceduralGenerator with no bands, so it fell back to
 * DEFAULT_BANDS (7 fossil kinds: fallen_branches, fiber_grass, berry_bush, loose_rocks, tree,
 * boulder, iron_vein), and its chunk onLoad handler dropped any kind outside a 7-entry
 * NODE_RESOURCES allowlist — wild crops and fruit trees could never appear in a live world,
 * on either the client's embedded server or the dedicated server.
 *
 * This test goes through `createGameServer` only — it never constructs a generator itself, with
 * or without bands — and counts the ResourceNode entities the server actually spawns on chunk
 * load over the 5x5 chunks around the origin (the same area ADR-349 sampled).
 */
import { describe, expect, it } from "vitest";
import { Transform } from "@engine/core";
import { gameplayDefs, ResourceNode } from "@engine/gameplay";
import { LoopbackNetwork } from "@engine/net";
import { createGameServer } from "../src/main.js";

const SEEDS = [1234, 11, 99];

/** Node counts by resource key over the 5x5 chunks around the origin, streamed by the server. */
function countServerNodes(seed: number): Map<string, number> {
  const net = new LoopbackNetwork(3);
  const gs = createGameServer({ transport: net.createServer(), seed, population: false });
  // Stream the 5x5 chunks around the origin; the synchronous generator provider installs them
  // in update(), which fires the server's onLoad node spawn. No world.step: no systems run, so
  // no frost / regrow / despawn path can touch the counts.
  gs.chunks.setSource({ id: -99, x: 0, y: 0, radius: 2 });
  for (let guard = 0; guard < 100; guard++) { gs.chunks.update(); if (gs.chunks.pendingLoads - gs.chunks.inflightLoads <= 0) break; }
  expect(gs.chunks.pendingLoads, `seed ${seed} chunks still pending`).toBe(0);
  const defs = gameplayDefs(gs.world);
  const counts = new Map<string, number>();
  for (const e of gs.world.query([ResourceNode])) {
    const k = defs.resources.get(gs.world.get(e, ResourceNode)!.kind)?.key ?? "?";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}
const isWild = (k: string): boolean => k.startsWith("wild_") || k === "flax_patch" || k === "cotton_bush" || k === "herb_patch";
const FRUIT_TREES = ["apple_tree", "pear_tree", "cherry_tree", "orange_tree", "peach_tree"] as const;

describe("ADR-428: wild crops and fruit trees spawn on the production server", { timeout: 60_000 }, () => {
  it("the server spawns wild crops and fruit trees on chunk load, on every seed", () => {
    for (const seed of SEEDS) {
      const counts = countServerNodes(seed);
      const wild = [...counts.entries()].filter(([k]) => isWild(k)).reduce((a, [, v]) => a + v, 0);
      const fruit = [...counts.entries()].filter(([k]) => (FRUIT_TREES as readonly string[]).includes(k)).reduce((a, [, v]) => a + v, 0);
      const distinct = counts.size;
      expect(wild, `seed ${seed} wild plants`).toBeGreaterThan(0);
      expect(fruit, `seed ${seed} fruit trees`).toBeGreaterThan(0);
      // The pre-fix server could only ever spawn the 7 fossil kinds; anything more proves the
      // production generator now runs the real worldgen bands and the onLoad passthrough lets
      // their kinds through.
      expect(distinct, `seed ${seed} distinct node kinds`).toBeGreaterThan(7);
      for (const k of ["wild_wheat", "wild_corn", "apple_tree"]) expect(counts.get(k) ?? 0, `seed ${seed} ${k}`).toBeGreaterThan(0);
    }
  });

  it("spawn points stay one per quadrant, on grass, with a node-free patch around them", () => {
    for (const seed of SEEDS) {
      const net = new LoopbackNetwork(3);
      const gs = createGameServer({ transport: net.createServer(), seed, population: false });
      expect(gs.spawnPoints).toHaveLength(4);
      const quads = new Set(gs.spawnPoints.map((p) => `${Math.sign(p.x)},${Math.sign(p.y)}`));
      expect(quads.size, `seed ${seed} quadrants`).toBe(4);
      // Chunks around the spawn points are loaded at boot (radius-1 sources), so tiles + nodes read live.
      for (const p of gs.spawnPoints) {
        const tx = Math.floor(p.x), ty = Math.floor(p.y);
        expect(gs.chunks.getTile(tx, ty), `seed ${seed} spawn tile at ${tx},${ty}`).toBe(3); // grass
        for (const e of gs.world.query([ResourceNode])) {
          const t = gs.world.get(e, Transform)!;
          expect(Math.max(Math.abs(t.x - p.x), Math.abs(t.y - p.y)), `seed ${seed} node near spawn ${p.x},${p.y}`).toBeGreaterThan(2);
        }
      }
    }
  });
});
