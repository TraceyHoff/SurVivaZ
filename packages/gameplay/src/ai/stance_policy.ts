/**
 * ADR-252: AI humans use the ADR-244 stances through the player's own inputs (agent_output agentStanceInput -> Guard /
 * Crouch buttons, Rest edge; the server's applyStanceInput validates exactly as for a human):
 *  - block: defend alternates strikes with a held guard while a zombie is in reach (autonomy.ts defendRun).
 *  - crouch: sneak (quieter, harder to see, ADR-244 crouchNoiseMul / crouchSightMul) while a zombie lurks 4..12 tiles
 *    away and the bot is not fighting, fleeing, hunting or sleeping; stand up again otherwise.
 *  - sleep: the base bed (base_behaviors baseSleepRun emits "rest" at the bed); asleep, the bot sends no wake input.
 *  - carry: not used: carrying lifts a ground loot bag, and AI humans do not perceive ground bags (ADR-238).
 */
import type { AgentContext, AgentOutput, Entity, World } from "@engine/core";
import { StanceMode } from "../components.js";
import { isCrouched, stanceMode } from "../stance.js";

export interface StanceSensors { /** own ADR-244 stance mode (StanceMode) */ stance?: number; /** own crouch toggle */ crouched?: boolean }
/** The bot's own stance (what the player sees on their character); cheap, refreshed every agent tick. */
export function fillStanceSensors(world: World, self: Entity, view: StanceSensors): void { view.stance = stanceMode(world, self); view.crouched = isCrouched(world, self); }

/** Crouch toggles are pressed at most this often (the server applies a press on its next input; no double toggles). */
export const CROUCH_EVERY = 40;
/** Sneak band (tiles): crouch when the nearest remembered zombie is within SNEAK_IN, stand when beyond SNEAK_OUT or closer than SNEAK_MIN. */
export const SNEAK_MIN = 4, SNEAK_IN = 10, SNEAK_OUT = 13;
const NO_SNEAK = new Set(["defend", "flee", "hunt", "sleep", "drive", "rest"]);

/** Post-run policy for every survivor behaviour (agents.ts survivorRegistry): sleep stillness + sneak crouch. */
export function stancePolicy(c: AgentContext<StanceSensors>, o: AgentOutput, behavior: string): void {
  const w = c.world;
  if (w.stance === StanceMode.Sleep) { // asleep: lie still; only the sleep behaviour keeps the bot in bed (any other wakes it)
    if (behavior === "sleep") { o.moveX = 0; o.moveY = 0; o.sprint = false; o.actions = o.actions.filter((a) => a !== "gather" && a !== "block" && a !== "crouch"); }
    return;
  }
  let want = false;
  // o.sprint expresses urgency here, not an on-foot speed override (ADR-289).
  if (!NO_SNEAK.has(behavior) && !o.sprint) {
    const z = c.memory.nearest("zombie", c.self.x, c.self.y, 0.3);
    if (z) { const d = Math.hypot(z.x - c.self.x, z.y - c.self.y); want = d >= SNEAK_MIN && d <= (w.crouched ? SNEAK_OUT : SNEAK_IN); }
  }
  if (!!w.crouched !== want && c.self.tick - c.bb.num("crouchAt", -1e9) >= CROUCH_EVERY) { o.actions.push("crouch"); c.bb.set("crouchAt", c.self.tick); }
}
