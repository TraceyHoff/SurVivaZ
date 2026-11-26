import { describe, expect, it } from "vitest";
import { schemaHash, World } from "@engine/core";
import { WorldRules } from "@engine/gameplay";
import { DEFAULT_MIGRATIONS, oldSchemaOf, planFor, WORLD_RULES_ZOMBIES_MIGRATIONS } from "../src/migrate.js";

/** ADR-535: WorldRules gained zombies; saves from before load with the field present (0 in the
 *  migrated row — the live value comes from the save meta, which has no zombies key on old saves,
 *  so game.ts falls back to zombies on). Both pre-zombies layouts must map: saves written after
 *  aiHumans (Task 22) and saves predating both fields. */
describe("ADR-535 WorldRules.zombies migration", () => {
  it("planFor maps both pre-zombies WorldRules layouts", () => {
    const w = new World({ seed: 1, maxEntities: 1 << 10 }); w.register(WorldRules);
    expect(DEFAULT_MIGRATIONS).toEqual(expect.arrayContaining([...WORLD_RULES_ZOMBIES_MIGRATIONS]));
    for (const fields of [["zombies"], ["aiHumans", "zombies"]] as const) {
      const old = schemaHash(oldSchemaOf(WorldRules.schema, [...fields], {}, {}, {}));
      expect(old).not.toBe(schemaHash(WorldRules.schema));
      const plan = planFor(w.store(WorldRules), old, DEFAULT_MIGRATIONS);
      expect(plan).toBeDefined(); expect(plan!.newSize - plan!.oldSize).toBe(fields.length);
    }
  });
});
