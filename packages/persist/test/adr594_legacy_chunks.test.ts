import { describe, it, expect } from "vitest";
import { MemoryWorldStore } from "../src/index.js";
import { makeWorld, spawnCrate, step } from "./helpers.js";

/** ADR-594: chunk records saved before the intact-structure stamp are reported once per load, so gameplay can restore their abandoned sites. */
describe("ADR-594 legacy chunk marking", () => {
  it("marks stored chunks saved below the stamp tick, and only those", async () => {
    const store = new MemoryWorldStore();
    const a = makeWorld(store); a.chunks.setSource({ id: 1, x: 16, y: 16 }); step(a.world);
    spawnCrate(a.world, 5, 5, 3); step(a.world); await a.persist.saveAll(); const savedAt = a.world.tick;
    const marks: string[] = [];
    const legacy = makeWorld(store, { legacyChunk: { beforeTick: savedAt + 1, mark: (_w, cx, cy) => { marks.push(`${cx},${cy}`); } } });
    legacy.chunks.setSource({ id: 1, x: 16, y: 16 }); step(legacy.world);
    expect(marks).toEqual(["0,0"]);
    const stamped: string[] = [];
    const current = makeWorld(store, { legacyChunk: { beforeTick: savedAt, mark: (_w, cx, cy) => { stamped.push(`${cx},${cy}`); } } });
    current.chunks.setSource({ id: 1, x: 16, y: 16 }); step(current.world);
    expect(stamped).toEqual([]);
    // a never-saved (generated) chunk is not legacy
    const fresh: string[] = [];
    const f = makeWorld(new MemoryWorldStore(), { legacyChunk: { beforeTick: 1e9, mark: (_w, cx, cy) => { fresh.push(`${cx},${cy}`); } } });
    f.chunks.setSource({ id: 1, x: 16, y: 16 }); step(f.world);
    expect(fresh).toEqual([]);
  });
});
