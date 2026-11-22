import { describe, it, expect } from "vitest";
import { Transform, type World } from "@engine/core";
import { Container, LootBag, legacyFloorZ } from "@engine/gameplay";
import { MemoryWorldStore } from "../src/index.js";
import { makeWorld, step } from "./helpers.js";

/** ADR-514: chunk entities (death bags, AI humans, animals) saved before the floor-height stamp re-seat on load. */
const reg = (w: World): void => { w.register(Container); w.register(LootBag); };

describe("ADR-514 legacy floor heights in chunk records", () => {
  it("a bag saved on a 3-level 2nd floor loads on the 5-level 2nd floor; records saved after the stamp are kept", async () => {
    const store = new MemoryWorldStore();
    const a = makeWorld(store, { setup: reg }); a.chunks.setSource({ id: 1, x: 16, y: 16 }); step(a.world);
    const e = a.world.create(); a.world.add(e, Transform, { x: 5, y: 5, z: 6.3125 }).add(e, Container, { slotCount: 4 }).add(e, LootBag, { owner: 9 } as never);
    step(a.world); await a.persist.saveAll(); const savedAt = a.world.tick;
    // the server passes fixLegacyFloorZ (the same rule plus the deck probe); here the pure rule on the 5-level grid
    const fix = (w: World, x: number): boolean => { const z = legacyFloorZ(w.get(x as never, Transform)!.z ?? 0, 5, 7); if (z === undefined) return false; w.set(x as never, Transform, { z }); return true; };
    // the loader of a pre-stamp save: every record up to the boot tick is legacy
    const b = makeWorld(store, { setup: reg, chunksFirst: true, legacyZ: { beforeTick: savedAt + 1, fix } }); b.chunks.setSource({ id: 1, x: 16, y: 16 }); step(b.world);
    const [x] = [...b.world.query([LootBag])]; expect(b.world.get(x!, Transform)!.z).toBeCloseTo(10.3125, 9);
    // the re-seat dirtied the chunk: it saves again at a later tick, past the stamp, and loads as saved
    for (let i = 0; i < 3; i++) step(b.world); await b.persist.saveAll();
    const c = makeWorld(store, { setup: reg, chunksFirst: true, legacyZ: { beforeTick: savedAt + 1, fix } }); c.chunks.setSource({ id: 1, x: 16, y: 16 }); step(c.world);
    const [y] = [...c.world.query([LootBag])]; expect(c.world.get(y!, Transform)!.z).toBeCloseTo(10.3125, 9);
  });
});
