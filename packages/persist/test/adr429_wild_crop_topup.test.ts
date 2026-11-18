/**
 * ADR-429: wild-crop top-up through the real load path (WorldPersistence + ChunkManager).
 *
 * World 1 is the pre-fix server: default-band generator, the server's `regenerateNodes` predicate, no
 * top-up — its saved chunk (0,0) holds only the 7 fossil kinds. World 2 is the post-fix server: the
 * correct-band generator + `topUpNodes` wired to `computeWildCropTopUp` — loading the stored chunk
 * spawns the missing wild-crop / fruit-tree kinds through the normal onLoad path while the stored nodes
 * stay put. World 3 reloads the re-saved chunk: the top-up returns nothing further (idempotent), and a
 * never-saved chunk is never topped up at all (fresh chunks take the generator path, not the hook).
 */
import { describe, expect, it } from "vitest";
import { Transform, type Entity, type World } from "@engine/core";
import { ProceduralGenerator, type Chunk, type NodePlacement } from "@engine/world";
import * as G from "@engine/gameplay";
import { installGameplay } from "@engine/gameplay";
import { MemoryWorldStore } from "../src/index.js";
import { makeWorld, step, type TestWorld } from "./helpers.js";

const SEED = 1234;
/** The server's ADR-134 predicate: stored chunks keep their own (possibly depleted/relocated) nodes. */
const serverRegenerateNodes = (w: World, ents: readonly Entity[]): boolean =>
  !ents.some((e) => w.has(e, G.ResourceNode) || w.has(e, G.NodeRegrow));

/** Server-style onLoad: spawn every placement the provider hands over. Returns the placements per chunk. */
function trackLoads(tw: TestWorld): Map<string, NodePlacement[]> {
  const seen = new Map<string, NodePlacement[]>();
  tw.chunks.onLoad((c: Chunk, nodes: readonly NodePlacement[]) => {
    seen.set(c.key, [...nodes]);
    for (const n of nodes) G.spawnResourceNode(tw.world, n.kind, n.tx + 0.5, n.ty + 0.5);
  });
  return seen;
}

const kindKey = (w: World, kind: number): string => G.gameplayDefs(w).resources.get(kind)?.key ?? `#${kind}`;
const nodeKindsIn = (w: World): Map<string, number> => {
  const out = new Map<string, number>();
  for (const e of w.query([G.ResourceNode, Transform])) {
    const k = kindKey(w, w.getField(e, G.ResourceNode, "kind")!);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
};

describe("ADR-429: wild-crop top-up through WorldPersistence", () => {
  it("stored old-band chunk gains wild crops on load; a reload adds nothing; fresh chunks are untouched", async () => {
    const store = new MemoryWorldStore();
    const oldGen = new ProceduralGenerator({ seed: SEED });
    const newGen = new ProceduralGenerator({ seed: SEED, bands: G.worldgenBands(G.defaultDefs()) });

    // World 1 — pre-fix server: old generator, no top-up. Save chunk (0,0) with its fossil nodes.
    // chunksFirst: the server streams chunks BEFORE persist.track, so onLoad-spawned nodes join
    // membership (and dirty the chunk) in the same tick.
    const a = makeWorld(store, {
      seed: SEED, loadRadius: 0, chunksFirst: true, generator: oldGen, regenerateNodes: serverRegenerateNodes,
      setup: (w) => { installGameplay(w, { role: "server" }); },
    });
    const seenA = trackLoads(a);
    a.chunks.setSource({ id: 1, x: 16, y: 16 }); step(a.world, 2);
    expect(a.persist.stats.chunksLoadedFromStore).toBe(0); // fresh generation, nothing stored yet
    expect(seenA.get("0,0")!.length).toBeGreaterThan(0);
    expect(seenA.get("0,0")!.every((n) => ["fallen_branches", "fiber_grass", "berry_bush", "loose_rocks", "tree", "boulder", "iron_vein"].includes(kindKey(a.world, n.kind)))).toBe(true);
    expect(a.persist.isDirty("0,0")).toBe(true); // the spawned nodes dirtied the chunk
    await a.persist.saveAll();
    expect(store.readChunk("0,0")).toBeDefined();

    // World 2 — post-fix server: correct-band generator + top-up hook.
    let topUpCalls: string[] = [];
    const b = makeWorld(store, {
      seed: SEED, loadRadius: 0, chunksFirst: true, generator: newGen, regenerateNodes: serverRegenerateNodes,
      topUpNodes: (w, chunk, ents) => {
        topUpCalls.push(chunk.key);
        return G.computeWildCropTopUp(w, chunk, ents, newGen.nodesInChunk(chunk.cx, chunk.cy));
      },
      setup: (w) => { installGameplay(w, { role: "server" }); },
    });
    const seenB = trackLoads(b);
    b.chunks.setSource({ id: 1, x: 16, y: 16 }); step(b.world, 2);
    expect(b.persist.stats.chunksLoadedFromStore).toBe(1);
    expect(topUpCalls).toEqual(["0,0"]); // the hook ran exactly once, for the stored chunk
    const topUp = seenB.get("0,0")!;
    expect(topUp.length).toBeGreaterThan(0);
    expect(topUp.length).toBeLessThanOrEqual(30);
    expect(b.persist.stats.topUpNodesAdded).toBe(topUp.length);
    expect(b.persist.isDirty("0,0")).toBe(true); // the top-up dirties the chunk so the first top-up persists
    for (const n of topUp) expect(G.isWildCropTopUpKey(kindKey(b.world, n.kind)), kindKey(b.world, n.kind)).toBe(true);
    // Stored fossil nodes are still there, untouched, alongside the top-up.
    const kindsB = nodeKindsIn(b.world);
    for (const k of ["berry_bush", "fiber_grass", "tree"]) expect(kindsB.get(k) ?? 0).toBeGreaterThan(0);
    const wildB = [...kindsB.keys()].filter((k) => G.isWildCropTopUpKey(k));
    expect(wildB.length).toBe(topUp.length);
    // A never-saved chunk takes the generator path: the hook is not called and the nodes are the
    // generator's own (identical to nodesInChunk), with no top-up kinds filtered in or out.
    b.chunks.setSource({ id: 1, x: 5 * 32 + 16, y: 5 * 32 + 16 }); step(b.world, 2);
    expect(topUpCalls).toEqual(["0,0"]);
    const fresh = seenB.get("5,5")!;
    const want = newGen.nodesInChunk(5, 5).map((n) => `${n.tx},${n.ty},${n.kind}`).sort().join("|");
    expect(fresh.map((n) => `${n.tx},${n.ty},${n.kind}`).sort().join("|")).toBe(want);
    // Persist the topped-up chunk (top-up nodes are now part of its stored set).
    await b.persist.saveAll();
    expect(store.readChunk("0,0")).toBeDefined();

    // World 3 — reload the re-saved chunk: the top-up is a no-op now.
    topUpCalls = [];
    const c = makeWorld(store, {
      seed: SEED, loadRadius: 0, chunksFirst: true, generator: newGen, regenerateNodes: serverRegenerateNodes,
      topUpNodes: (w, chunk, ents) => {
        topUpCalls.push(chunk.key);
        return G.computeWildCropTopUp(w, chunk, ents, newGen.nodesInChunk(chunk.cx, chunk.cy));
      },
      setup: (w) => { installGameplay(w, { role: "server" }); },
    });
    const seenC = trackLoads(c);
    c.chunks.setSource({ id: 1, x: 16, y: 16 }); step(c.world, 2);
    expect(c.persist.stats.chunksLoadedFromStore).toBe(1);
    expect(topUpCalls).toEqual(["0,0"]); // the hook still runs on load — and returns nothing
    expect(seenC.get("0,0")).toEqual([]);
    expect(c.persist.stats.topUpNodesAdded).toBe(0);
    // The topped-up nodes survived the round trip as stored nodes.
    const kindsC = nodeKindsIn(c.world);
    expect([...kindsC.keys()].filter((k) => G.isWildCropTopUpKey(k)).length).toBe(topUp.length);
    for (const k of ["berry_bush", "fiber_grass", "tree"]) expect(kindsC.get(k) ?? 0).toBeGreaterThan(0);
  });
});
