// ADR-531 altitude bands: rock above 55, snow above 70, treeline (no trees above 55),
// volcano crater bowls. No new art: existing rock (5) / snow (6) tiles, ADR-410 slopes.
import { describe, expect, it } from "vitest";
import { ProceduralGenerator, MASSIF_ROCK_LINE, MASSIF_SNOW_LINE, MASSIF_TREELINE, CHUNK_SIZE, massifBumpAt } from "../src/index.js";

const SEEDS = [1, 42, 1234, 424242, 9001];
const REGIONS: readonly (readonly [number, number])[] = [[1, 0], [0, 1], [1, 1], [-1, -1], [2, 0]];

/** Kind 5 is `tree` (ids.lock.json resources). */
const TREE_KIND = 5;

describe("ADR-531 altitude bands", () => {
  it("land at height >= 70 is snow and at 55-69 is rock on massif flanks", () => {
    let nRock = 0, nSnow = 0, bad = 0, checked = 0;
    for (const seed of [1, 42, 1234]) {
      const g = new ProceduralGenerator({ seed });
      for (const [rx, ry] of [[1, 0], [0, 1]] as const) {
        for (const m of g.massifsInRegion(rx, ry)) {
          const R = Math.ceil(m.radius);
          for (let y = m.cy - R; y <= m.cy + R; y += 3) for (let x = m.cx - R; x <= m.cx + R; x += 3) {
            const h = g.heightAt(x, y); const t = g.tileAt(x, y);
            if (t === 1 || t === 8) continue; // water / shallows stay water
            checked++;
            if (h >= MASSIF_SNOW_LINE) { nSnow++; if (t !== 6) bad++; }
            else if (h >= MASSIF_ROCK_LINE) { nRock++; if (t !== 5) bad++; }
          }
        }
      }
    }
    console.log(`ADR-531 bands: checked ${checked} land tiles, rock-band ${nRock}, snow-band ${nSnow}, violations ${bad}`);
    expect(MASSIF_ROCK_LINE).toBe(55); expect(MASSIF_SNOW_LINE).toBe(70); expect(MASSIF_TREELINE).toBe(55);
    expect(nRock + nSnow, "massif flanks must actually reach the rock/snow bands").toBeGreaterThan(50);
    expect(nSnow, "some flank tiles must reach the snow band").toBeGreaterThan(0);
    expect(bad).toBe(0);
  }, 180_000);

  it("no trees grow above the treeline on massif summits, and trees still generate lower down", () => {
    let treesAbove = 0, treesBelow = 0, summitChunks = 0;
    for (const seed of [1, 42]) {
      const g = new ProceduralGenerator({ seed });
      for (const m of g.massifsInRegion(1, 0)) {
        const pcx = Math.floor(m.cx / CHUNK_SIZE), pcy = Math.floor(m.cy / CHUNK_SIZE);
        for (let cy = pcy - 1; cy <= pcy + 1; cy++) for (let cx = pcx - 1; cx <= pcx + 1; cx++) {
          summitChunks++;
          for (const n of g.nodesInChunk(cx, cy)) {
            if (n.kind !== TREE_KIND) continue;
            if (g.heightAt(n.tx, n.ty) > MASSIF_TREELINE) treesAbove++;
            else treesBelow++;
          }
        }
      }
      // Trees still generate in the low forest near spawn (vacuity guard).
      let nearSpawnTrees = 0;
      for (let cy = -3; cy <= 3; cy++) for (let cx = -3; cx <= 3; cx++)
        nearSpawnTrees += g.nodesInChunk(cx, cy).filter((n) => n.kind === TREE_KIND).length;
      expect(nearSpawnTrees, `seed ${seed}: trees must still generate near spawn`).toBeGreaterThan(0);
    }
    console.log(`ADR-531 treeline: ${summitChunks} summit chunks, trees above ${treesAbove}, below ${treesBelow}`);
    expect(treesAbove).toBe(0);
  }, 180_000);

  it("volcano massifs have a crater bowl: rim higher than centre, by a real margin", () => {
    const volcanos: { seed: number; m: ReturnType<ProceduralGenerator["massifsInRegion"]>[number] }[] = [];
    for (const seed of SEEDS) {
      const g = new ProceduralGenerator({ seed });
      for (const [rx, ry] of REGIONS)
        for (const m of g.massifsInRegion(rx, ry)) if (m.shape === "volcano") volcanos.push({ seed, m });
    }
    expect(volcanos.length, "at least one volcano in the 5-seed survey").toBeGreaterThanOrEqual(1);
    for (const { seed, m } of volcanos) {
      const d = Math.round(0.22 * m.amp * m.wSlope);
      const rimX = m.cx + Math.round(Math.cos(m.slopeDir) * d), rimY = m.cy + Math.round(Math.sin(m.slopeDir) * d);
      const bowlDrop = massifBumpAt(m, rimX, rimY) - massifBumpAt(m, m.cx, m.cy);
      expect(bowlDrop, `seed ${seed} volcano crater depth (bump field)`).toBeGreaterThanOrEqual(0.2 * m.amp);
      // On the real field the bowl must still read as a dip (natural noise may blur it by a couple of levels).
      const g = new ProceduralGenerator({ seed });
      expect(g.heightAt(m.cx, m.cy), `seed ${seed} volcano centre vs rim`).toBeLessThanOrEqual(g.heightAt(rimX, rimY) + 2);
    }
    console.log(`ADR-531 volcanos in survey: ${volcanos.length}`);
  }, 120_000);
});
