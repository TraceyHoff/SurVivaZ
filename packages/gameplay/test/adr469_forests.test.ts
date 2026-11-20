/**
 * ADR-469: living forests — wild trees regrow through sapling stages (not instant full-size), wild saplings
 * can die of drought (2 in-game days without rain/water, same clock as crops), lightning fells a grove
 * (the nearest tree plus the other axe-trees within 3 tiles of it) and leaves fallen logs, and generic
 * `tree` / `resin_tree` keep instant regrow (they have no sapling). Growth progress is lost on chunk
 * unload (a wild sapling despawns with its chunk, same as a partially-gathered node resetting).
 * Scope corrections: there is no `wildlife.ts` / `migrationSystem` — the real system is `animalAISystem`
 * in `population.ts` plus the tamed graze path in `skills/husbandry.ts` (not used here); `respawnSystem`
 * is in `systems/gathering.ts`, `cropGrowthSystem` in `farming.ts`; the scope's −20/≥30 affinity scale
 * does not apply (that is ADR-478). The fallen log spawns only for lightning-felled trees: an
 * axe-felled tree and a wildfire-burned tree leave none.
 */
import { describe, it, expect } from "vitest";
import { Transform, type Entity, type World } from "@engine/core";
import { chunkKeyOf } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld, steps, collect } from "./helpers.js";

const d = G.defaultDefs();
const OAK_ID = d.resourceId("oak_tree");
const TREE_ID = d.resourceId("tree");
const LOG_ID = d.resourceId("fallen_log");
/** Stub rng: angle 0, minimum distance — the strike point is exactly 5 tiles east of the anchor (ADR-451). */
const eastRng = { next: () => 0, int: () => 0 };
/** Run one burning check (checkSeconds 1 s = 20 ticks at 20 Hz; ADR-468 pattern). */
const check = (w: World): void => { w.tick += 20; G.burningSystem(w, 1 / 20); };
/** Burn a tree out (128 intensity, 16 per check — ADR-451/ADR-468 pattern). */
function burnOut(w: World, tree: Entity): void {
  for (let i = 0; i < 8 && w.isAlive(tree); i++) check(w);
  expect(w.isAlive(tree)).toBe(false);
}
/** Deplete a node now and step until its regrow fires; return the respawned entity (a Crop sapling or a node). */
function regrow(w: World, node: Entity, kind: string): Entity {
  const marker = G.depleteNode(w, node, d.resourceId(kind), w.tick, 0);
  for (let i = 0; i < 100 && w.isAlive(marker); i++) w.step(1 / 20);
  expect(w.isAlive(marker)).toBe(false);
  const crops = [...w.query([G.Crop])];
  const nodes = [...w.query([G.ResourceNode])].filter((n) => n !== node);
  expect(crops.length + nodes.length).toBeGreaterThan(0);
  return crops[0] ?? nodes[0]!;
}
/** A world whose east half is forest (the ADR-134 gathering-test pattern), so a regrow spot is always the same biome. */
function forestWorld(): World {
  const w = makeWorld();
  w.setResource(G.PopulationTiles, (tx: number) => (tx < 0 ? 1 : 4));
  return w;
}
const fallenLogs = (w: World): Entity[] => [...w.query([G.ResourceNode])].filter((n) => w.get(n, G.ResourceNode)!.kind === LOG_ID);

describe("ADR-469 living forests", () => {
  it("a depleted oak regrows as a sapling, grows through stages, and matures into an oak tree (no fallen log)", () => {
    const w = forestWorld();
    G.spawnPlayer(w, { x: 0, y: 0 });
    const oak = G.spawnResourceNode(w, "oak_tree", 5, 5);
    const sapling = regrow(w, oak, "oak_tree");
    expect(w.has(sapling, G.Crop)).toBe(true);
    expect(w.has(sapling, G.ResourceNode)).toBe(false);
    expect(w.get(sapling, G.Crop)!.kind).toBe(G.wildSaplingKind("oak_tree"));
    expect(w.get(sapling, G.Crop)!.stage).toBe(0);
    expect(fallenLogs(w)).toHaveLength(0); // axe-felled: no log
    // Water it (ADR-110 pattern) and grow it through the 3 sapling stages to maturity.
    const t = w.get(sapling, Transform)!;
    expect(G.water(w, t.x, t.y)).toBe(1);
    expect(G.growthMul(w, w.get(sapling, G.Crop)!)).toBeGreaterThan(0);
    const stages = new Set<number>();
    for (let i = 0; i < 2400 && w.isAlive(sapling); i++) { G.cropGrowthSystem(w); if (w.isAlive(sapling)) stages.add(w.get(sapling, G.Crop)!.stage); }
    expect(w.isAlive(sapling)).toBe(false);
    expect(stages).toEqual(new Set([0, 1, 2]));
    const node = [...w.query([G.ResourceNode])].find((n) => w.get(n, G.ResourceNode)!.kind === OAK_ID);
    expect(node).toBeDefined();
    const nt = w.get(node!, Transform)!;
    expect(nt.x).toBe(t.x); expect(nt.y).toBe(t.y);
    expect(w.has(node!, G.GrownPlant)).toBe(true);
  });

  it("a wild sapling that dries out dies (PlantDied); a watered one survives", () => {
    const w = forestWorld();
    const died = collect(w, G.PlantDied);
    const dry = G.spawnCrop(w, 5, 5, G.wildSaplingKind("oak_tree"));
    const wet = G.spawnCrop(w, 10, 10, G.wildSaplingKind("oak_tree"));
    // waterUntilTick is u32 — a negative "past" value wraps to a huge future tick, so the dry sapling's
    // clock is set to a small positive tick and the world clock is jumped past the 2-day drought
    // (the ADR-471 tick-jump pattern). 0 would re-start the clock (dryClock), so 1 is used.
    w.set(dry, G.Crop, { waterUntilTick: 1 });
    w.tick = 1 + G.droughtTicks(w) + 1;
    expect(G.water(w, 10, 10)).toBe(1);
    G.cropGrowthSystem(w);
    steps(w, 1); // emit is deferred: the PlantDied delivery happens on the step
    expect(w.isAlive(dry)).toBe(false);
    expect(died).toHaveLength(1);
    expect(died[0]!.x).toBe(5); expect(died[0]!.y).toBe(5);
    expect(died[0]!.kind).toBe(G.wildSaplingKind("oak_tree"));
    expect(w.isAlive(wet)).toBe(true);
  });

  it("lightning fells a grove: the nearest tree plus the axe-trees within 3 tiles ignite, farther trees do not", () => {
    const w = forestWorld();
    G.spawnPlayer(w, { x: 0, y: 0 }); // strike point: 5 tiles east, (5, 0)
    const near = G.spawnResourceNode(w, "tree", 5, 0);
    const close1 = G.spawnResourceNode(w, "tree", 6, 1); // ~1.4 tiles from the nearest
    const edge = G.spawnResourceNode(w, "tree", 8, 0); // exactly 3 tiles
    const far1 = G.spawnResourceNode(w, "tree", 9, 0); // 4 tiles
    const far2 = G.spawnResourceNode(w, "tree", 5, 4); // 4 tiles
    const hit = G.resolveLightningStrike(w, eastRng);
    expect(hit?.kind).toBe("tree");
    expect(hit?.entity).toBe(near);
    for (const t of [near, close1, edge]) {
      expect(w.get(t, G.Burning)?.lit).toBe(1);
      expect(w.has(t, G.LightningFire)).toBe(true);
    }
    for (const t of [far1, far2]) {
      expect(w.get(t, G.Burning)?.lit ?? 0).toBe(0);
      expect(w.has(t, G.LightningFire)).toBe(false);
    }
  });

  it("a lightning-felled tree leaves a fallen log at its position when it burns out", () => {
    const w = forestWorld();
    G.spawnPlayer(w, { x: 0, y: 0 });
    const tree = G.spawnResourceNode(w, "tree", 5, 0);
    const hit = G.resolveLightningStrike(w, eastRng);
    expect(hit?.entity).toBe(tree);
    burnOut(w, tree);
    const markers = [...w.query([G.NodeRegrow])];
    expect(markers).toHaveLength(1);
    expect(w.get(markers[0]!, G.NodeRegrow)!.kind).toBe(TREE_ID);
    const logs = fallenLogs(w);
    expect(logs).toHaveLength(1);
    const lt = w.get(logs[0]!, Transform)!;
    expect(lt.x).toBe(5); expect(lt.y).toBe(0);
    expect(w.get(logs[0]!, G.ResourceNode)!.amount).toBe(5); // full capacity
  });

  it("a wildfire-burned tree leaves no fallen log (lightning-felled only)", () => {
    const w = forestWorld();
    G.spawnPlayer(w, { x: 0, y: 0 });
    const tree = G.spawnResourceNode(w, "tree", 5, 0);
    expect(G.ignite(w, tree)).toBe(true);
    expect(w.has(tree, G.LightningFire)).toBe(false);
    burnOut(w, tree);
    expect([...w.query([G.NodeRegrow])]).toHaveLength(1);
    expect(fallenLogs(w)).toHaveLength(0);
  });

  it("generic tree and resin_tree keep instant full-size regrow (they have no sapling)", () => {
    expect(G.wildSaplingKind("tree")).toBe(0);
    expect(G.wildSaplingKind("resin_tree")).toBe(0);
    for (const kind of ["tree", "resin_tree"] as const) {
      const w = forestWorld();
      G.spawnPlayer(w, { x: 0, y: 0 });
      const node = G.spawnResourceNode(w, kind, 5, 5);
      const grown = regrow(w, node, kind);
      expect(w.has(grown, G.ResourceNode)).toBe(true);
      expect(w.has(grown, G.Crop)).toBe(false);
      expect(w.get(grown, G.ResourceNode)!.kind).toBe(d.resourceId(kind));
      expect(w.get(grown, G.ResourceNode)!.amount).toBe(d.resources.get(d.resourceId(kind))!.capacity);
    }
  });

  it("chunk tracking: a wild sapling in the chunk list despawns on unload, and its matured node inherits the list", () => {
    const w = forestWorld();
    const key = chunkKeyOf(5, 5);
    // A wild sapling in the chunk list despawns when the chunk unloads.
    const sapling = G.spawnCrop(w, 5, 5, G.wildSaplingKind("oak_tree"));
    w.setResource(G.ChunkNodes, new Map([[key, [sapling]]]));
    expect(G.despawnChunkNodes(w, key)).toBe(1);
    expect(w.isAlive(sapling)).toBe(false);
    // Its matured node inherits the list entry (swapChunkNode is a no-op for a planted sapling, which is in no list).
    const sapling2 = G.spawnCrop(w, 5, 5, G.wildSaplingKind("oak_tree"));
    w.setResource(G.ChunkNodes, new Map([[key, [sapling2]]]));
    expect(G.water(w, 5, 5)).toBe(1);
    expect(G.growthMul(w, w.get(sapling2, G.Crop)!)).toBeGreaterThan(0);
    w.set(sapling2, G.Crop, { growth: 0.9999 }); // one crop tick from maturity
    G.cropGrowthSystem(w);
    expect(w.isAlive(sapling2)).toBe(false);
    const list = w.getResource(G.ChunkNodes)!.get(key)!;
    expect(list).toHaveLength(1);
    const node = list[0]!;
    expect(w.has(node, G.ResourceNode)).toBe(true);
    expect(w.get(node, G.ResourceNode)!.kind).toBe(OAK_ID);
    expect(G.despawnChunkNodes(w, key)).toBe(1); // the matured node is chunk-tracked too
    expect(w.isAlive(node)).toBe(false);
  });
});
