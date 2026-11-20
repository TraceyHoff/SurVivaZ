/**
 * Noise: actions raise the actor's NoiseLevel (server-only); zombies hear an entity when
 * distance <= NoiseLevel.value * hearingMul. Decays exponentially (noise.decayPerSec fraction per second).
 */
import { entityIndex, Transform, type Entity, type World } from "@engine/core";
import { NoiseLevel, Survival } from "../components.js";
import { gameplayDefs, isAuthority } from "../config.js";
import { isCrouched, STANCE } from "../stance.js";
import { skillMul } from "../skills/tree.js";

/** ADR-476: the last loud survivor noise (the director's "last loud event"). Noise is a decaying
 * per-entity level with no event log, so the director cannot poll for "what was loud" — instead
 * makeNoise records the peak here, at the moment of the action, and the director reads it on its
 * own cadence. Only living survivors are recorded (player-caused by definition): thunder never
 * calls makeNoise, animals never call it (footsteps are Survival-gated in movement.ts), and zombie
 * structure hits are not survivors — so the scope's "player-caused only" gate is exactly this
 * check. Vehicle engine noise does not exist in the noise system (no makeNoise call for driving),
 * so a driving player draws a horde only by what they do at the destination (gunfire, building,
 * chopping, walking). */
export interface LoudNoise { x: number; y: number; tick: number; level: number }
const lastLoud = new WeakMap<World, LoudNoise>();
/** Ticks a loud event stays visible to the director (the director runs every 20 ticks). */
export const LOUD_EVENT_TTL_TICKS = 100;
/** The last loud survivor noise, if one happened within the TTL (undefined otherwise). */
export const lastLoudNoise = (world: World): LoudNoise | undefined => {
  const r = lastLoud.get(world);
  if (!r || world.tick - r.tick > LOUD_EVENT_TTL_TICKS) return undefined;
  return r;
};

export function makeNoise(world: World, e: Entity, amount: number): void {
  if (!isAuthority(world) || world.isReplaying || !world.isAlive(e)) return;
  amount *= skillMul(world, e, "noise"); // ADR-113 stealth
  if (isCrouched(world, e)) amount *= STANCE.crouchNoiseMul; // ADR-244
  const cur = world.getField(e, NoiseLevel, "value");
  if (cur === undefined) world.add(e, NoiseLevel, { value: amount });
  else if (amount > cur) world.setField(e, NoiseLevel, "value", amount);
  // ADR-476: record the peak survivor noise for the horde director (see above). The loudest recent
  // event wins; a quieter action never overwrites a louder one still within its TTL.
  if (world.isRegistered(Survival) && world.has(e, Survival)) {
    const t = world.get(e, Transform);
    if (t) {
      const prev = lastLoud.get(world);
      if (!prev || amount >= prev.level || world.tick - prev.tick > LOUD_EVENT_TTL_TICKS) lastLoud.set(world, { x: t.x, y: t.y, tick: world.tick, level: amount });
    }
  }
}

export function noiseDecaySystem(world: World, dt: number): void {
  if (!isAuthority(world)) return;
  const k = Math.max(0, 1 - gameplayDefs(world).noise.decayPerSec * dt);
  const st = world.store(NoiseLevel);
  for (let i = 0; i < st.size; i++) { const v = st.data.value[i]! * k; st.data.value[i] = v < 0.05 ? 0 : v; }
  void entityIndex; // server-only component: no markChanged needed (never replicated)
}
