import { describe, expect, it } from "vitest";
import {
  Chunk, ChunkManager, DEFAULT_PLAYER_CHUNKS_PER_BOT_CHUNK, ProceduralGenerator, chunkKey, encodeChunk,
  regionsToPrecompute, REGION_PRECOMPUTE_DISTANCE_TILES, REGION_PRECOMPUTE_MAX_REGIONS,
} from "../src/index.js";

/** ADR-546: chunk streaming is player-first with a fairness floor, directional pre-warm along the
 *  movement heading, and region-siting plans precomputed off the chunk-load path. */

const SEED = 546546;

function rowMajor(cx0: number, cy0: number, r = 2): string[] {
  const out: string[] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) out.push(chunkKey(cx0 + dx, cy0 + dy));
  return out;
}

describe("ADR-546 player-first chunk streaming", () => {
  it("drains player chunks first with the fairness floor: 1 bot chunk per 4 player chunks, bots still served", () => {
    expect(DEFAULT_PLAYER_CHUNKS_PER_BOT_CHUNK).toBe(4);
    const loaded: string[] = [];
    const cm = new ChunkManager({
      provider: { load(cx, cy) { return { chunk: new Chunk(cx, cy), nodes: [] }; } },
      loadRadius: 2, maxLoadsPerUpdate: 100, // no time budget: one update drains everything
    });
    cm.onLoad((c) => loaded.push(c.key));
    cm.setSource({ id: 1, x: 0, y: 0, priority: 0 }); // the player
    cm.setSource({ id: 2, x: 10000, y: 10000, priority: 1 }); // a bot, far away (chunk 312,312)
    cm.update();
    expect(loaded.length).toBe(50);
    const playerChunks = rowMajor(0, 0), botChunks = rowMajor(312, 312);
    const isBot = (k: string): boolean => botChunks.includes(k);
    // The 4-player + 1-bot interleave, pinned: the 5th load is a bot chunk, not a 5th player chunk.
    expect(loaded.slice(0, 4).every((k) => !isBot(k))).toBe(true);
    expect(isBot(loaded[4]!)).toBe(true);
    expect(isBot(loaded[9]!)).toBe(true);
    // Relative order inside each class stays FIFO row-major (ADR-370 nearest-first stays reverted).
    expect(loaded.filter((k) => !isBot(k))).toEqual(playerChunks);
    expect(loaded.filter(isBot)).toEqual(botChunks);
    // The fairness floor serves bots: every bot chunk loads, and the last player chunk is not
    // followed by a long bot-only tail of starved work — bots interleave from the 5th load on.
    expect(loaded.filter(isBot).length).toBe(25);
    expect(loaded.indexOf(botChunks[0]!)).toBe(4);
  });

  it("a bot-only source still drains in FIFO row-major order (no starvation, no nearest-first)", () => {
    const loaded: string[] = [];
    const cm = new ChunkManager({
      provider: { load(cx, cy) { return { chunk: new Chunk(cx, cy), nodes: [] }; } },
      loadRadius: 2, maxLoadsPerUpdate: 100,
    });
    cm.onLoad((c) => loaded.push(c.key));
    cm.setSource({ id: 2, x: 10000, y: 10000, priority: 1 });
    cm.update();
    expect(loaded).toEqual(rowMajor(312, 312));
  });

  it("directional pre-warm: the chunk straight ahead of the movement heading drains next", () => {
    const loaded: string[] = [];
    const cm = new ChunkManager({
      provider: { load(cx, cy) { return { chunk: new Chunk(cx, cy), nodes: [] }; } },
      loadRadius: 2, maxLoadsPerUpdate: 1, // one chunk per update, so the order is observable
    });
    cm.onLoad((c) => loaded.push(c.key));
    // Chunk-centred positions: (16,16) is the centre of chunk (0,0), (48,16) of chunk (1,0).
    cm.setSource({ id: 1, x: 16, y: 16 });
    cm.update();
    expect(loaded).toEqual(["-2,-2"]); // no heading yet: FIFO first
    cm.setSource({ id: 1, x: 48, y: 16 }); // one chunk east: heading east
    cm.update();
    expect(loaded[1]).toBe("3,0"); // straight ahead — not the next FIFO chunk ("-1,-2")
    cm.setSource({ id: 1, x: 16, y: 16 }); // back west: heading west
    cm.update();
    expect(loaded[2]).toBe("-2,0"); // straight ahead the other way
  });
});

describe("ADR-546 region-plan precompute trigger", () => {
  it("regionsToPrecompute: nothing far from a boundary, one region near an edge, two at a corner", () => {
    expect(REGION_PRECOMPUTE_DISTANCE_TILES).toBe(256);
    expect(REGION_PRECOMPUTE_MAX_REGIONS).toBe(2);
    expect(regionsToPrecompute(0, 0)).toEqual([]);
    expect(regionsToPrecompute(512, 0)).toEqual([]); // exactly 256 from the boundary: not within
    expect(regionsToPrecompute(513, 0)).toEqual([[1, 0]]);
    expect(regionsToPrecompute(700, 0)).toEqual([[1, 0]]);
    expect(regionsToPrecompute(-700, 0)).toEqual([[-1, 0]]);
    expect(regionsToPrecompute(0, 700)).toEqual([[0, 1]]);
    expect(regionsToPrecompute(700, 700)).toEqual([[1, 0], [0, 1]]); // two regions, never the diagonal
    expect(regionsToPrecompute(760, 760).length).toBe(2);
    expect(regionsToPrecompute(700, 700)).not.toContainEqual([1, 1]);
  });

  it("precomputeRegionPlans warms one piece per call and reports the pieces still queued", () => {
    const g = new ProceduralGenerator({ seed: SEED });
    expect(g.precomputeRegionPlans(0, 0)).toBe(0); // far from any boundary: no work
    // One region = 4 pieces (water, massifs, canyons, rivers), one per call.
    expect(g.precomputeRegionPlans(700, 0)).toBe(3);
    expect(g.precomputeRegionPlans(700, 0)).toBe(2);
    expect(g.precomputeRegionPlans(700, 0)).toBe(1);
    expect(g.precomputeRegionPlans(700, 0)).toBe(0);
    expect(g.precomputeRegionPlans(700, 0)).toBe(0); // already warm: no re-queue, no work
    // A corner warms two regions = 8 pieces.
    const h = new ProceduralGenerator({ seed: SEED });
    let remaining = h.precomputeRegionPlans(700, 700);
    expect(remaining).toBe(7);
    let calls = 1;
    while (remaining > 0 && calls < 20) { remaining = h.precomputeRegionPlans(700, 700); calls++; }
    expect(remaining).toBe(0);
    expect(calls).toBe(8);
  });
});

describe("ADR-546 region-plan precompute is byte-identical", () => {
  it("precomputed layouts produce the same chunks, nodes and heights as cold generation", () => {
    const cold = new ProceduralGenerator({ seed: SEED });
    const warmed = new ProceduralGenerator({ seed: SEED });
    // Warm regions (1,0), (0,1) and (-1,0) from near their boundaries; (1,1) stays cold on
    // both sides, so the comparison also covers a region neither side precomputed.
    for (const [x, y] of [[700, 0], [0, 700], [700, 700], [-700, 0]] as const) {
      let remaining = warmed.precomputeRegionPlans(x, y);
      let guard = 0;
      while (remaining > 0 && guard++ < 20) remaining = warmed.precomputeRegionPlans(x, y);
      expect(remaining).toBe(0);
    }
    const chunks: Array<[number, number]> = [
      [0, 0], // region-zero control
      [24, 0], [48, 0], [47, -1], [71, 2], [32, 8], // region (1,0)
      [0, 24], [1, 48], [-1, 47], [5, 32], // region (0,1)
      [48, 48], [60, 60], [40, 55], // region (1,1), never precomputed
      [-48, 0], [-24, 5], [-40, -8], // region (-1,0)
    ];
    for (const [cx, cy] of chunks) {
      const a = cold.load(cx, cy)!, b = warmed.load(cx, cy)!;
      expect(b.chunk.key).toBe(a.chunk.key);
      // Tiles + heights, byte for byte (encodeChunk without a world is the static part).
      expect(encodeChunk(b.chunk)).toEqual(encodeChunk(a.chunk));
      expect(b.nodes).toEqual(a.nodes);
    }
    // Heights/tile kinds on a stride grid across every warmed region (massifs, canyons, rivers
    // and water features all feed sampleAt) — catches a plan difference the loaded chunks miss.
    for (const [x0, y0] of [[768, -768], [-768, -768], [-768, 768], [768, 768]] as const) {
      for (let y = y0; y < y0 + 1536; y += 48) {
        for (let x = x0; x < x0 + 1536; x += 48) {
          expect(warmed.sampleAt(x, y)).toEqual(cold.sampleAt(x, y));
        }
      }
    }
  });
});
