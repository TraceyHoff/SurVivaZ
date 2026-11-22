import { describe, expect, it } from "vitest";
import { schemaHash, World } from "@engine/core";
import { Vehicle } from "@engine/gameplay";
import { DEFAULT_MIGRATIONS, oldSchemaOf, planFor, VEHICLE_PAINT_MIGRATION } from "../src/migrate.js";

/** ADR-519: Vehicle gained paint; saves from before load with paint 0 (gameplay assigns a pick) instead of being skipped. */
describe("ADR-519 Vehicle.paint migration", () => {
  it("planFor maps the pre-paint Vehicle layout", () => {
    const w = new World({ seed: 1, maxEntities: 1 << 10 }); w.register(Vehicle);
    expect(DEFAULT_MIGRATIONS).toContain(VEHICLE_PAINT_MIGRATION);
    const old = schemaHash(oldSchemaOf(Vehicle.schema, ["paint"], {}, {}, {}));
    expect(old).not.toBe(schemaHash(Vehicle.schema));
    const plan = planFor(w.store(Vehicle), old, DEFAULT_MIGRATIONS);
    expect(plan).toBeDefined(); expect(plan!.newSize - plan!.oldSize).toBe(1);
  });
});
