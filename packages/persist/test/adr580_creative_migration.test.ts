import { describe, expect, it } from "vitest";
import { schemaHash, World } from "@engine/core";
import { WorldRules } from "@engine/gameplay";
import { DEFAULT_MIGRATIONS, oldSchemaOf, planFor, WORLD_RULES_CREATIVE_MIGRATIONS } from "../src/migrate.js";

/** ADR-580: WorldRules gained creative; saves from before load with the field present (0 in the
 *  migrated row = off, which is also the live value: Creative is opt-in and the save meta has no
 *  creative key on old saves, so game.ts falls back to off — an old survival world can never
 *  silently become creative). All three pre-creative layouts must map: saves written after
 *  zombies (ADR-535), after aiHumans (Task 22) but before zombies, and predating both fields. */
describe("ADR-580 WorldRules.creative migration", () => {
  it("planFor maps all three pre-creative WorldRules layouts", () => {
    const w = new World({ seed: 1, maxEntities: 1 << 10 }); w.register(WorldRules);
    expect(DEFAULT_MIGRATIONS).toEqual(expect.arrayContaining([...WORLD_RULES_CREATIVE_MIGRATIONS]));
    for (const fields of [["creative"], ["zombies", "creative"], ["aiHumans", "zombies", "creative"]] as const) {
      const old = schemaHash(oldSchemaOf(WorldRules.schema, [...fields], {}, {}, {}));
      expect(old).not.toBe(schemaHash(WorldRules.schema));
      const plan = planFor(w.store(WorldRules), old, DEFAULT_MIGRATIONS);
      expect(plan).toBeDefined(); expect(plan!.newSize - plan!.oldSize).toBe(fields.length);
    }
  });
});
