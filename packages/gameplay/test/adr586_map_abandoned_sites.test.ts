import { describe, expect, it } from "vitest";
import { ChunkManager, ProceduralGenerator } from "@engine/world";
import * as G from "../src/index.js";
import { makeWorld } from "./helpers.js";

/**
 * ADR-586: the maps' abandoned-structure enumeration must name exactly the sites the
 * chunk-load stamper places — no marker for a ruin that never stands, none missing.
 * Two pins: (1) planAbandonedChunkForMap replicates planAbandonedChunk roll-for-roll
 * (it exists to avoid building a full layout per chunk during wide surveys);
 * (2) mapAbandonedSites over a chunk range equals the AbandonedSite markers a real
 * generator-backed world stamps over the same range.
 */
describe("ADR-586 map abandoned sites", () => {
  it("planAbandonedChunkForMap replicates planAbandonedChunk and the planned footprint size", () => {
    for (const seed of [1, 42, 987654]) {
      let planned = 0;
      for (let cy = -40; cy <= 40; cy++) for (let cx = -40; cx <= 40; cx++) {
        const a = G.planAbandonedChunk(seed, cx, cy);
        const b = G.planAbandonedChunkForMap(seed, cx, cy);
        if (!a) { expect(b).toBeUndefined(); continue; }
        planned++;
        expect(b).toBeDefined();
        expect({ originX: b!.originX, originY: b!.originY, kind: b!.kind, rot: b!.rot, ruin: b!.ruin })
          .toEqual({ originX: a.originX, originY: a.originY, kind: a.kind, rot: a.rot, ruin: a.ruin });
        const full = G.planAbandonedSite(seed, a.originX, a.originY, { kind: a.kind, rot: a.rot, ruin: a.ruin });
        expect({ w: b!.width, h: b!.height }).toEqual({ w: full.width, h: full.height });
      }
      expect(planned).toBeGreaterThan(500); // the comparison actually exercised planned chunks
    }
  }, 60_000);

  it("mapAbandonedSites equals the sites a real world stamps over the same chunks", () => {
    const CX0 = -7, CY0 = -7, CX1 = 6, CY1 = 6;
    for (const seed of [42, 7]) {
      const w = makeWorld({}, seed);
      const chunks = new ChunkManager({ provider: new ProceduralGenerator({ seed }), loadRadius: 0, unloadMargin: 0, cacheSize: 0 });
      w.setResource(G.TerrainRes, G.terrainFromTileMap(chunks));
      chunks.onLoad((c) => { G.stampAbandonedChunk(w, c.key); });
      for (let cy = CY0; cy <= CY1; cy++) for (let cx = CX0; cx <= CX1; cx++) {
        chunks.setSource({ id: 1, x: cx * 32 + 16, y: cy * 32 + 16, radius: 0 });
        chunks.update();
        G.drainAbandonedStamps(w);
      }
      const stamped = [...w.query([G.AbandonedSite])]
        .map((m) => `${w.getField(m, G.AbandonedSite, "originX")},${w.getField(m, G.AbandonedSite, "originY")}`)
        .sort();
      const gen = new ProceduralGenerator({ seed });
      const mapped = G.mapAbandonedSites(seed, (x, y) => gen.sampleAt(x, y), CX0, CY0, CX1, CY1)
        .map((s) => `${s.originX},${s.originY}`)
        .sort();
      expect(stamped.length).toBeGreaterThanOrEqual(8); // the range really contains ruins
      expect(mapped).toEqual(stamped);
    }
  }, 60_000);
});
