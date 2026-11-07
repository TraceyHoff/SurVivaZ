/**
 * @engine/gameplay - Survival Systems team. Rules for vitals, inventory, crafting, gathering, environment,
 * base building (structures, integrity, persistence), combat and zombies on @engine/core + @engine/world.
 * See ../DESIGN.md.
 */
export * from "./components.js";
export * from "./events.js";
export * from "./defs.js";
export * from "./config.js";
export * from "./data.js";
export * from "./inventory.js";
export * from "./input.js";
export * from "./map_marker_commands.js";
export * from "./map_markers.js";
export * from "./compass.js";
export * from "./install.js";
export * from "./replication.js";
export * from "./realism.js";
export * from "./world.js";
export * from "./systems/environment.js";
export * from "./systems/vitals.js";
export * from "./systems/diseases.js";
export * from "./diseases.js";
export * from "./systems/gathering.js";
export * from "./systems/crafting.js";
export * from "./systems/fuel.js";
export * from "./systems/windsock.js";
export * from "./food.js";
export * from "./customization.js";
export * from "./systems/noise.js";
export * from "./systems/spoilage.js";
export * from "./systems/movement.js";
export * from "./systems/creature_nav.js";
export * from "./building/structure.js";
export * from "./building/links.js";
export * from "./building/place.js";
export * from "./building/surface.js"; // ADR-162
export * from "./building/integrity.js";
export * from "./building/actions.js";
export * from "./building/ghost.js";
export * from "./building/shelter.js";
export * from "./building/persist.js";
export * from "./building/modular.js";
export * from "./combat/combat.js";
export * from "./combat/path.js";
export * from "./combat/zombies.js";
export * from "./economy/config.js";
export * from "./economy/provenance.js";
export * from "./economy/stall.js";
export * from "./combat/pvp_pieces.js";
export * from "./combat/defenses.js";
export * from "./systems/lights.js";
export * from "./vehicle_keys.js";
export * from "./combat/pvp.js";
export * from "./loot_labels.js";
export * from "./loot_despawn.js";
export * from "./spawn_points.js";
export * from "./respawn.js";
export * from "./combat/arms.js";
export * from "./net_hooks.js";
export * from "./input_hooks.js";
export * from "./population.js";
export * from "./territory.js"; // Task 14: territory defense helpers
export * from "./ready.js"; // Task 14: second loading screen — client loaded-in signal
export * from "./agents.js";
export * from "./systems/craft_queue.js";
export * from "./recent.js"; // Task 33: Recently Crafted lists
export * from "./ai/population.js";
export * from "./ai/bot_input.js";
export * from "./ai/agent_output.js";
export * from "./ai/stance_policy.js"; // ADR-252
export * from "./ai/storage_api.js";
export * from "./ai/survivor_behaviors.js";
export * from "./ai/autonomy.js";
export * from "./systems/stall_display.js";
export * from "./expression.js";
export * from "./party.js";
export * from "./ai/party_behaviors.js";
export * from "./ai/clan_behaviors.js";
export * from "./ai/vehicle_behaviors.js";
export * from "./ai/social_memory.js";
export * from "./ai/planner.js";
export * from "./ai/base_behaviors.js";
export * from "./clan_state.js";
export * from "./clan.js";
export * from "./ui/menus.js";
export * from "./ui/placement.js";
export * from "./vehicles.js";
export * from "./vehicle_craft.js";
export * from "./vehicle_net.js";
export * from "./ui/camper.js";
export * from "./forget.js";
export * from "./farming.js";
export * from "./tool-hint.js";
export * from "./skills/tree.js";
export * from "./skills/progression.js";
export * from "./skills/xp_sim.js";
export * from "./combat/zombie_gate.js";
export * from "./skills/describe.js";
export * from "./skills/xp.js";
export * from "./skills/husbandry.js";
export * from "./clutter.js";
export * from "./sprite-fallback.js";
export * from "./roads.js";
export * from "./terrain.js";
export * from "./signs.js";
export * from "./hordes.js";
export * from "./pets.js"; // ADR-145
export * from "./animal_skills.js"; // Task 15: per-animal skill trees
export * from "./recruitment.js"; // Task 22: AI-human recruitment (hire / jobs / multiplayer toggle)
export * from "./dye.js"; // Task 25: dye system (DyeCmd, SlotDye, brush rule)
export * from "./ai/hire_behaviors.js"; // Task 22: hired-worker sensors + job behaviors
export * from "./inventory_ops.js"; // ADR-204
export * from "./stance.js"; // ADR-244

export * from "./exposure-stages.js";
