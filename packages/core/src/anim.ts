/**
 * Shared animation state ids (ADR-093). Replicated as u8 (gameplay `AnimState.anim`), so values are WIRE-STABLE:
 * never renumber; append only. Hit/Death are aliases of Hurt/Die (same value), not new states.
 */
export const enum AnimState {
  Idle = 0, Walk = 1, Run = 2, Attack = 3, Hurt = 4, Die = 5, Gather = 6, Build = 7,
  Eat = 8, Graze = 9, Shamble = 10, Crawl = 11, Feed = 12, Sit = 13,
  /** ADR-107 (append-only): in deep water; renderer falls back to walk + bob + clipped lower body. */ Swim = 14,
  /** ADR-107: unarmed melee (fists); falls back to attack. */ Punch = 15,
  /** ADR-128 (append-only): hand-harvest (pick/pull) from bushes, crops, plants; falls back to gather/punch. */ Harvest = 16,
  /** ADR-128: chopping a tree/log with an axe; falls back to attack. */ Chop = 17,
  /** ADR-128: mining a rock/ore with a pickaxe; falls back to attack. */ Mine = 18,
  /** ADR-128: drinking (container or water tile); falls back to eat. */ Drink = 19,
  /** ADR-241 (append-only): shield / guard hold; falls back to idle. */ Block = 20,
  /** ADR-241: bow/crossbow draw (WeaponState.chargeStartTick != 0) or firearm aim hold; falls back to idle. */ Aim = 21,
  /** ADR-241: crouched (walking = Crouch + moving); falls back to idle / walk. */ Crouch = 22,
  /** ADR-241: carrying a crate/log/body in both arms (walking = Carry + moving); falls back to idle / walk. */ Carry = 23,
  /** ADR-241: asleep (in a bed: sleep_lie, else the curled seated sleep); falls back to sit, idle. */ Sleep = 24,
  /** ADR-298 (append-only): guard compression/rebound when a melee blow lands on a held block; falls back to block, idle. */ BlockHit = 25,
  Hit = Hurt, Death = Die,
}
/** Canonical name per AnimState value (index = value). Append in step with the enum. */
export const ANIM_STATE_NAMES: readonly string[] = Object.freeze(["idle", "walk", "run", "attack", "hurt", "die", "gather", "build", "eat", "graze", "shamble", "crawl", "feed", "sit", "swim", "punch", "harvest", "chop", "mine", "drink", "block", "aim", "crouch", "carry", "sleep", "block_hit"]);
export const animStateName = (s: number): string | undefined => ANIM_STATE_NAMES[s];
