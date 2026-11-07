import { describe, expect, it } from "vitest";
import { defineComponent, Transform } from "@engine/core";
import { Crop, GrownPlant } from "@engine/gameplay";
import { MemoryWorldStore } from "../src/index.js";
import { oldSchemaOf } from "../src/migrate.js";
import { makeWorld, step } from "./helpers.js";

describe("ADR-287 planted-plant persistence", () => {
  it("loads legacy crop chunks without losing growth, water or the fertilizer flag", async () => {
    const Old = defineComponent("Crop", oldSchemaOf(Crop.schema, ["fertilizerUntilTick"]), { networked: true, persistent: true });
    const store = new MemoryWorldStore(); const a = makeWorld(store, { setup: w => w.register(Old) });
    a.chunks.setSource({ id: 1, x: 16, y: 16 }); step(a.world);
    const e = a.world.create(); a.world.add(e, Transform, { x: 3, y: 4 }).add(e, Old, { kind: 1, stage: 1, growth: 0.4, waterUntilTick: 2500, fertilized: 1 } as never);
    step(a.world); await a.persist.saveAll();
    const b = makeWorld(store, { setup: w => w.register(Crop) }); b.chunks.setSource({ id: 1, x: 16, y: 16 }); step(b.world);
    expect(b.persist.stats.decodeErrors).toBe(0); expect(b.persist.stats.migratedChunks).toBeGreaterThan(0);
    const crops = [...b.world.query([Crop])]; expect(crops).toHaveLength(1);
    expect(b.world.get(crops[0]!, Crop)).toMatchObject({ kind: 1, stage: 1, waterUntilTick: 2500, fertilized: 1, fertilizerUntilTick: 0 });
    expect(b.world.getField(crops[0]!, Crop, "growth")).toBeCloseTo(0.4);
  });
  it("retains grown planted provenance and timers through a chunk save/reload", async () => {
    const store = new MemoryWorldStore(); const a = makeWorld(store, { setup: w => w.register(GrownPlant) });
    a.chunks.setSource({ id: 1, x: 16, y: 16 }); step(a.world);
    const e = a.world.create(); a.world.add(e, Transform, { x: 3, y: 4 }).add(e, GrownPlant, { kind: 1, waterUntilTick: 2500, fertilizerUntilTick: 4000 });
    step(a.world); await a.persist.saveAll();
    const b = makeWorld(store, { setup: w => w.register(GrownPlant) }); b.chunks.setSource({ id: 1, x: 16, y: 16 }); step(b.world);
    expect(b.persist.stats.decodeErrors).toBe(0); const plants = [...b.world.query([GrownPlant])]; expect(plants).toHaveLength(1);
    expect(b.world.get(plants[0]!, GrownPlant)).toMatchObject({ kind: 1, waterUntilTick: 2500, fertilizerUntilTick: 4000 });
  });
});
