/**
 * ADR-493: fishing from shore and boat — the cast–wait–bite loop. One Fish command (from the
 * farm-prompt Use button / QuickUse, with a fishing rod in hand and water in front) casts the
 * line; the cast then holds while the fisher stands still facing the same water tile: a cast
 * costs stamina, the wait rolls 4–8 s (shorter at dawn/dusk), then the bite rolls (dawn/dusk +
 * rain + deep water raise the chance) and a bite lands raw fish in the inventory. A miss
 * re-casts on its own. Moving away, turning away, or switching the held item reels the line in.
 *
 * Why tap-to-cast, not hold-to-fish: PlayerIntent.action is wiped every tick by
 * clearIntentsSystem, and the held Gather bit is re-derived into a Gather intent per tick in
 * the server's applyInput (which knows only nodes and loot bags, not water) — so a one-shot
 * command cannot sustain a cast through the intent. The cast is therefore a state (the Fishing
 * component), started by the Fish intent and sustained by the rod + the same water tile in
 * front. The prompt (QuickUse / Use button) is the discoverability on all three inputs.
 *
 * Performance: no new scan — the system only iterates entities with a PlayerIntent (the same
 * query gatherSystem runs), skips non-fishers at once, reads the one tile in front, and rolls on
 * the deterministic per-entity "fishing" rng stream, so the server and the predicting client
 * agree on every bite without a new replicated field. Only the authority adds the fish (the
 * gather pattern). The stamina cost (2, like the fish_shoal's) is a flavour cost, not an AFK
 * bound (stamina regens at 15/s) — an AFK fisher still only lands 1–2 raw fish per 4–8 s, slower
 * than gathering a shoal (1–2 per 1.5 s), so it is never the best way to get fish.
 *
 * Boat fishing: confirmed — applyMovementInput's Driver branch never touches PlayerIntent.action
 * and no fishing check gates on Driver, so a boat driver casts exactly like a shore fisher (the
 * cast point is the water beside the boat). The touch Use button is hidden while driving (the
 * farm prompt's `hidden` rule), so touch boat-fishing needs a follow-up; keyboard / gamepad reach
 * it through QuickUse, which fires the prompt even while driving. The bite auto-reels in v1 (no
 * timing minigame, no new UI): the catch is the visible outcome.
 */
import { entityIndex, Transform, Weather, type Entity, type World } from "@engine/core";
import { WaterDepth } from "@engine/world";
import { Anim, AnimState, Dead, Equipment, Fishing, IntentAction, Inventory, PlayerIntent, Survival } from "../components.js";
import { gameplayDefs, isAuthority } from "../config.js";
import { secondsToTicks, type FishingTuning } from "../defs.js";
import { emit, InventoryOverflow } from "../events.js";
import { currentPhaseKey } from "../combat/zombies.js";
import { plantSpot } from "../farming.js";
import { addItem } from "../inventory.js";
import { isRaining } from "../realism.js";
import { waterDepth } from "./movement.js";
import { spendStamina } from "./vitals.js";

function setAnimOf(world: World, e: Entity, anim: Anim): void {
  const cur = world.getField(e, AnimState, "anim");
  if (cur === undefined) world.add(e, AnimState, { anim, startTick: world.tick });
  else if (cur !== anim) world.set(e, AnimState, { anim, startTick: world.tick });
  else world.setField(e, AnimState, "startTick", world.tick); // restart the one-shot on repeated casts
}

/** Roll one wait (ticks) for a cast: biteDelaySeconds, shorter at dawn/dusk. Same stream as the bite. */
function rollWait(world: World, e: Entity, tun: FishingTuning): number {
  const phase = currentPhaseKey(world);
  const mul = phase === "dawn" || phase === "dusk" ? tun.dawnDuskDelayMul : 1;
  const rng = world.rngFor("fishing", e);
  const seconds = (tun.biteDelaySeconds[0] + rng.next() * (tun.biteDelaySeconds[1] - tun.biteDelaySeconds[0])) * mul;
  return secondsToTicks(seconds, 1 / 20);
}

export function fishingSystem(world: World, dt: number): void {
  const defs = gameplayDefs(world); const authority = isAuthority(world);
  const tun = defs.fishing; const fishId = defs.itemId("fish");
  const intent = world.store(PlayerIntent);
  for (const e of world.query([PlayerIntent, Inventory, Transform], [Dead])) {
    const idx = entityIndex(e); const is = intent.slot(idx);
    const cast = intent.data.action[is] === IntentAction.Fish;
    // The rod must stay in the main hand, and the tile in front must stay water — otherwise the
    // line is reeled in at once (the fisher moved, turned, or switched items).
    const held = world.getField(e, Equipment, "mainHandItem") ?? 0;
    const rod = defs.items.get(held)?.key === "fishing_rod";
    const at = plantSpot(world, e);
    const depth = waterDepth(world, at.x, at.y);
    const deep = depth === WaterDepth.Deep;
    if (!world.has(e, Fishing)) {
      // No line in the water: a Fish intent casts one (pay the stamina, set the wait, swing the rod).
      if (!cast || !rod || depth === WaterDepth.None) continue;
      if (world.has(e, Survival) && !spendStamina(world, e, tun.staminaCost, dt)) continue;
      world.add(e, Fishing, { waitUntilTick: world.tick + rollWait(world, e, tun), castX: at.x, castY: at.y });
      if (authority || world.has(e, AnimState)) setAnimOf(world, e, Anim.Harvest);
      continue;
    }
    // A line is in the water: it holds only while the rod stays out and the fisher still faces the
    // same water tile. The Fish intent is the trigger, not the sustain — the cast outlives it.
    const cx = world.getField(e, Fishing, "castX")!, cy = world.getField(e, Fishing, "castY")!;
    if (!rod || depth === WaterDepth.None || cx !== at.x || cy !== at.y) { world.remove(e, Fishing); continue; }
    if (world.tick < world.getField(e, Fishing, "waitUntilTick")!) continue;
    // Bite roll (deterministic per-entity stream — both peers agree on bite vs miss, and on the
    // count below, which is rolled on both peers even on a miss so the streams never diverge).
    const rng = world.rngFor("fishing", e);
    const phase = currentPhaseKey(world);
    const raining = isRaining(world.env(Weather).kind);
    const chance = Math.min(1, tun.biteChance + (phase === "dawn" || phase === "dusk" ? tun.dawnDuskBonus : 0) + (raining ? tun.rainBonus : 0) + (deep ? tun.deepWaterBonus : 0));
    const bit = rng.next() < chance;
    const count = tun.fishMin + Math.floor(rng.next() * (tun.fishMax - tun.fishMin + 1)) + (deep ? tun.deepWaterExtraFish : 0);
    if (bit && authority) {
      // addItem returns the amount added (not the leftover); the lost fish are count - added.
      // No ItemGathered emit: that event names a ResourceNode (the progression handler reads its kind
      // for the XP source), and fishing has no node — fishing awards no XP in v1 (a "fish" source is a
      // follow-up). The inventory change is replicated, so the catch is visible.
      const added = addItem(world, e, fishId, count);
      if (added < count) emit(world, InventoryOverflow, { entity: e, item: fishId, lost: count - added });
      if (world.has(e, AnimState)) setAnimOf(world, e, Anim.Harvest);
    }
    // Re-cast (the line stays in while the fisher stands still) — pay again; an exhausted fisher
    // reels in instead of casting on empty stamina.
    if (world.has(e, Survival) && !spendStamina(world, e, tun.staminaCost, dt)) { world.remove(e, Fishing); continue; }
    world.setField(e, Fishing, "waitUntilTick", world.tick + rollWait(world, e, tun));
  }
}
