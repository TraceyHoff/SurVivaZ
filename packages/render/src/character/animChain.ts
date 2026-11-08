/**
 * ADR-241: per-entity anim chain selector for the v2 player anim set (player_v2_spec §6 / §12). AnimState says WHAT the
 * character does; the chain says which manifest anim plays it, given what the character holds (weapon class from
 * gameplay `weaponClassOf`), whether it moves, drives, or lies in a bed. Every chain ends in a v1 anim, so v1 art
 * now includes dedicated block frames; missing layers still fall back to idle. Other chains retain their existing fallbacks.
 * Returns shared frozen arrays: allocation-free per frame.
 */
import { AnimState } from "@engine/core";

/** What the chain depends on besides the AnimState. */
export interface AnimChainCtx {
  /** PlayerIntent.moving / view-side motion: Crouch/Carry pick their walk anim. */
  moving?: boolean;
  /** gameplay weaponClassOf(main-hand item key): unarmed blade blunt axe spear bow crossbow firearm (others = generic swing). */
  weaponClass?: string;
  /** Main-hand item key: throwing_* / sling use attack_throw whatever their class. */
  itemKey?: string;
  /** Rider in a vehicle driver seat (gameplay Driver): Sit plays `vehicle`. */
  driver?: boolean;
  /** Sleep in a bed: "lie" = top/only spot (sleep_lie), "under" = bunk lower spot (sleep_lie_under). */
  bed?: "lie" | "under" | undefined;
  /** Seconds since the state started (Aim with a bow: bow_draw, then bow_hold). */
  elapsed?: number;
}

const c = (...names: string[]): readonly string[] => Object.freeze(names);
/** bow_draw: 4 frames @ 10 fps, then the bow_hold loop (spec §6). */
export const BOW_DRAW_S = 0.4;

const ATTACK: Readonly<Record<string, readonly string[]>> = Object.freeze({
  unarmed: c("attack_unarmed", "punch", "attack", "idle"),
  blade: c("attack_blade", "attack", "idle"), blunt: c("attack_blunt", "attack", "idle"), axe: c("attack_axe", "attack", "idle"),
  spear: c("attack_spear", "attack", "idle"), throw: c("attack_throw", "attack", "idle"),
  bow: c("bow_release", "attack", "idle"), crossbow: c("attack_crossbow", "attack", "idle"), firearm: c("gun_fire", "attack", "idle"),
});
const ATTACK_ANY = c("attack", "idle");
const PUNCH = ATTACK.unarmed!;
const AIM_BOW_DRAW = c("bow_draw", "bow_hold", "idle"), AIM_BOW_HOLD = c("bow_hold", "bow_draw", "idle"), AIM_GUN = c("gun_aim", "idle");
const BLOCK = c("block", "idle");
const BLOCK_HIT = c("block_hit", "block", "idle");
const CROUCH_IDLE = c("crouch_idle", "idle"), CROUCH_WALK = c("crouch_walk", "crouch_idle", "walk", "idle");
const CARRY_IDLE = c("carry_idle", "idle"), CARRY_WALK = c("carry_walk", "carry_idle", "walk", "idle");
const SLEEP = c("sleep", "sit", "idle"), SLEEP_LIE = c("sleep_lie", "sleep", "sit", "idle"), SLEEP_LIE_UNDER = c("sleep_lie_under", "sleep_lie", "sleep", "sit", "idle");
const VEHICLE = c("vehicle", "sit", "idle");

/** Attack class of an item: throwing_* / sling throw, else the weapon class. */
export function attackClassOf(ctx: AnimChainCtx): string {
  const k = ctx.itemKey ?? "";
  if (k.startsWith("throwing_") || k.includes("sling")) return "throw";
  return ctx.weaponClass ?? "unarmed";
}

/** The chain for `state` with `ctx`; undefined = the state's default chain (STATE_ANIMS). */
export function animChainFor(state: number, ctx: AnimChainCtx): readonly string[] | undefined {
  switch (state) {
    case AnimState.Attack: return ATTACK[attackClassOf(ctx)] ?? ATTACK_ANY;
    case AnimState.Punch: return PUNCH;
    case AnimState.Block: return BLOCK;
    case AnimState.BlockHit: return BLOCK_HIT;
    case AnimState.Aim: { const w = ctx.weaponClass; if (w === "crossbow" || w === "firearm") return AIM_GUN;
      return (ctx.elapsed ?? 0) < BOW_DRAW_S ? AIM_BOW_DRAW : AIM_BOW_HOLD; }
    case AnimState.Crouch: return ctx.moving ? CROUCH_WALK : CROUCH_IDLE;
    case AnimState.Carry: return ctx.moving ? CARRY_WALK : CARRY_IDLE;
    case AnimState.Sleep: return ctx.bed === "under" ? SLEEP_LIE_UNDER : ctx.bed === "lie" ? SLEEP_LIE : SLEEP;
    case AnimState.Sit: return ctx.driver ? VEHICLE : undefined;
    default: return undefined;
  }
}

/** Socket names (frameMeta anchors) of the v2 set: carried object {x,y,behind} on carry_* frames, seat {x,y} on sit/vehicle frames. */
export const CARRY_SOCKET = "carry", SEAT_SOCKET = "seat";
