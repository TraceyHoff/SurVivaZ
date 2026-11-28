import { describe, it, expect } from "vitest";
import { MemoryWorldStore } from "../src/index.js";
import { makeWorld, spawnCrate, step } from "./helpers.js";

/** ADR-595: every chunk read from storage (whatever its save tick) is reported once, so gameplay never adds a new settlement building to it. */
describe("ADR-595 stored chunk marking", () => {
  it("reports chunks loaded from the store, not freshly generated ones", async () => {
    const store = new MemoryWorldStore();
    const fresh: string[] = [];
    const a = makeWorld(store, { storedChunk: (_w, cx, cy) => { fresh.push(`${cx},${cy}`); } });
    a.chunks.setSource({ id: 1, x: 16, y: 16 }); step(a.world);
    expect(fresh).toEqual([]);
    spawnCrate(a.world, 5, 5, 3); step(a.world); await a.persist.saveAll();
    const stored: string[] = [];
    const b = makeWorld(store, { storedChunk: (_w, cx, cy) => { stored.push(`${cx},${cy}`); } });
    b.chunks.setSource({ id: 1, x: 16, y: 16 }); step(b.world);
    expect(stored).toEqual(["0,0"]);
  });
});
