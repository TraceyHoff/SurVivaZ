/**
 * ADR-581: Creative mode waivers. In a world created with the Creative rule on (ADR-580),
 * HUMAN players — session players that are not AI humans — play free: crafting and building
 * cost no resources, hunger/thirst never drain, body temperature holds at normal, and no
 * damage of any cause lands (so no injuries and no death). Levelling, skills and the living
 * world (animals, zombies when enabled, weather) are untouched, and AI humans get no waiver:
 * a bot in a Creative world still eats, pays and can die.
 *
 * The predicate is the same identification the spawn code uses (ai_spawn.humanPlayerPositions):
 * a PlayerId carrier that is not an AI human. On a client replica the AI predicate resource is
 * unset, so isAiHuman reads false there — correct for the one entity a client ever predicts
 * or previews for (its own player); every waiver that spends or spares is authority-side,
 * where the server registers the real predicate (game.ts setAiHumanPredicate).
 */
import { PlayerId, type Entity, type World } from "@engine/core";
import { worldRules } from "./hordes.js";
import { isAiHuman } from "./skills/xp.js";

/** True when e is a human player in a Creative world — the one test every ADR-581 waiver shares. */
export function isCreativePlayer(world: World, e: Entity): boolean {
  if (!worldRules(world).creative) return false;
  if (!world.isRegistered(PlayerId) || !world.has(e, PlayerId)) return false;
  return !isAiHuman(world, e);
}
