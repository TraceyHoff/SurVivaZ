/**
 * Task 35 / ADR-254: seeded worldgen — different seeds differ; same seed is deterministic; heights vary with ledges.
 */
import { describe, it, expect } from "vitest";
import { CHUNK_SIZE, ProceduralGenerator, computeSpawnPoints, randomWorldSeed, HEIGHT_MAX, HEIGHT_MIN } from "../src/index.js";

describe("ADR-254 / Task 35 seeded worldgen", () => {
  it("same seed is deterministic for tiles, heights and resource nodes", () => {
    const a = new ProceduralGenerator({ seed: 9001 }).load(2, -3);
    const b = new ProceduralGenerator({ seed: 9001 }).load(2, -3);
    expect(a.chunk.tiles).toEqual(b.chunk.tiles);
    expect(a.chunk.height).toEqual(b.chunk.height);
    expect(a.nodes).toEqual(b.nodes);
    expect(computeSpawnPoints(new ProceduralGenerator({ seed: 9001 }))).toEqual(
      computeSpawnPoints(new ProceduralGenerator({ seed: 9001 })),
    );
  });

  it("different seeds produce different layouts and resource node placements", () => {
    const a = new ProceduralGenerator({ seed: 11 }).load(0, 0);
    const b = new ProceduralGenerator({ seed: 99 }).load(0, 0);
    expect(a.chunk.tiles).not.toEqual(b.chunk.tiles);
    expect(a.chunk.height).not.toEqual(b.chunk.height);
    // nodes may occasionally collide by chance; tiles/heights already differ. Also check a few chunks' node sets.
    const nodes = (s: number) => {
      const out: string[] = [];
      for (let cy = -1; cy <= 1; cy++) for (let cx = -1; cx <= 1; cx++)
        for (const n of new ProceduralGenerator({ seed: s }).load(cx, cy).nodes) out.push(`${n.tx},${n.ty},${n.kind}`);
      return out.sort().join("|");
    };
    expect(nodes(11)).not.toEqual(nodes(99));
    expect(computeSpawnPoints(new ProceduralGenerator({ seed: 11 }))).not.toEqual(
      computeSpawnPoints(new ProceduralGenerator({ seed: 99 })),
    );
  });

  it("heightAt spans a wider range than the old 0..3 band and creates multi-level ledges", () => {
    const g = new ProceduralGenerator({ seed: 4242 });
    const heights = new Set<number>();
    let maxDrop = 0;
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const h = g.heightAt(x, y);
      expect(h).toBeGreaterThanOrEqual(HEIGHT_MIN); // ADR-530: generated ground reaches -100
      expect(h).toBeLessThanOrEqual(HEIGHT_MAX);
      heights.add(h);
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) maxDrop = Math.max(maxDrop, Math.abs(h - g.heightAt(x + dx, y + dy)));
    }
    expect(heights.size).toBeGreaterThanOrEqual(5); // more varied than the old 4 levels
    expect(Math.max(...heights)).toBeGreaterThan(3); // exceeds the pre-Task-35 ceiling
    expect(maxDrop).toBeGreaterThanOrEqual(3); // multi-level ledge (cliff / gt_side can draw it)
  });

  it("altitude in baseClimate matches generated chunk height", () => {
    const g = new ProceduralGenerator({ seed: 5 });
    const { chunk } = g.load(3, 3);
    const tx = 100, ty = 100;
    const i = (ty - 3 * CHUNK_SIZE) * CHUNK_SIZE + (tx - 3 * CHUNK_SIZE);
    expect(g.baseClimate(tx, ty).altitude).toBe(chunk.height[i]);
    expect(g.heightAt(tx, ty)).toBe(chunk.height[i]);
  });

  it("randomWorldSeed returns distinct non-zero uint32 values", () => {
    let s = 1;
    const rnd = (): number => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 0x100000000; };
    const a = randomWorldSeed(rnd), b = randomWorldSeed(rnd), c = randomWorldSeed(rnd);
    expect(a).not.toBe(0); expect(b).not.toBe(0); expect(c).not.toBe(0);
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
