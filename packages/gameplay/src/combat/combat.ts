/**
 * Basic combat (authority): Attack intent -> weapon from the held item (fists fallback), cooldown, range (+ slack),
 * stamina; damage to creatures (Health) or structures (batched piece damage x weapon.structureMul).
 * Death is handled by vitals deathSystem (hp <= 0 -> Dead); zombie corpses are removed after corpseSeconds.
 * The owning client may predict the swing (cooldown/stamina/AnimState) but never damage.
 */
import { blockMul, stanceMode, wake } from "../stance.js";
import { StanceMode } from "../components.js";
import { entityIndex, NetId, Transform, type Entity, type World } from "@engine/core";
import { Anim, AnimState, Attacker, BuildPiece, DamageCause, Dead, Equipment, Health, HitReact, IntentAction, Inventory, NO_SLOT, PlayerIntent, Survival, VitalsState, Zombie } from "../components.js";
import { gameplayDefs, isAuthority, rangeSlack } from "../config.js";
import { secondsToTicks, type WeaponDef } from "../defs.js";
import { AttackSwing, Damaged, emit } from "../events.js";
import { slotItem } from "../inventory.js";
import { damagePiece } from "../building/integrity.js";
import { makeNoise } from "../systems/noise.js";
import { distance } from "../systems/fuel.js";
import { spendStamina } from "../systems/vitals.js";
import { checkHit, tagCombat } from "./pvp.js";
import { installSpatialIndex } from "@engine/world";
import { Animal, Pet } from "../components.js";
import { dropZombieLoot } from "../population.js";
import { damageMulFor } from "../skills/tree.js";
import { Progression } from "../components.js";
import { armorReduce, igniteTarget, landThrown, resolveAttack, spendRound, throwExplosive } from "./arms.js";

export const FISTS: WeaponDef = { damage: 5, range: 1.0, cooldownSeconds: 0.4, staminaCost: 3, structureMul: 0.2 };
export function heldWeapon(world: World, e: Entity): WeaponDef {
  const slot = world.getField(e, Equipment, "mainHandSlot");
  if (slot === undefined || slot === NO_SLOT || !world.has(e, Inventory)) return FISTS;
  return gameplayDefs(world).items.get(slotItem(world, e, slot).item)?.weapon ?? FISTS;
}

/**
 * Primary-button melee target for a human (ADR-107): the nearest live zombie or animal within the held weapon's
 * melee reach (+0.4 + slack, the same reach combatSystem checks). Players, structures and pets (ADR-145) are never
 * auto-targeted (PvP / demolition / hurting a pet stay explicit), so a gathering bot or player does not swing at a pet. undefined -> the button falls back to gathering.
 */
export function nearestMeleeTarget(world: World, e: Entity): Entity | undefined {
  const t = world.get(e, Transform); if (!t) return undefined;
  const reach = heldWeapon(world, e).range + 0.4 + rangeSlack(world, e);
  let best: Entity | undefined; let bd = Infinity;
  for (const o of installSpatialIndex(world).queryRadius(t.x, t.y, reach)) {
    if (o === e || !world.isAlive(o) || !world.has(o, Health) || world.has(o, Dead) || !(world.has(o, Zombie) || world.has(o, Animal)) || world.has(o, Pet)) continue;
    const d = distance(world, e, o); if (d <= reach && d < bd) { bd = d; best = o; }
  }
  return best;
}

export function setAnim(world: World, e: Entity, anim: Anim): void {
  const cur = world.getField(e, AnimState, "anim");
  if (cur === undefined) world.add(e, AnimState, { anim, startTick: world.tick });
  else if (cur !== anim) world.set(e, AnimState, { anim, startTick: world.tick });
}

/** Applies damage (authority): creatures lose hp now; structures get batched damage. */
/** Creature damage is reduced by worn armor (Combat / Explosion causes; `pierce` 0..1 ignores part of it). */
/** ADR-194: the last living attacker of each damaged entity (sim-local, server) — day-calm zombies retaliate against it. */
const lastHits = new WeakMap<World, Map<Entity, { e: Entity; tick: number }>>();
const lastHitsOf = (w: World): Map<Entity, { e: Entity; tick: number }> => { let m = lastHits.get(w); if (!m) lastHits.set(w, (m = new Map())); return m; };
export function lastAttacker(world: World, e: Entity): { e: Entity; tick: number } | undefined {
  const m = lastHits.get(world); const h = m?.get(e); if (h && !world.isAlive(e)) { m!.delete(e); return undefined; } return h;
}
/** ADR-244: blocks only stop melee: the attacker stands within 2.5 tiles. */
function isMeleeRange(world: World, a: Entity, b: Entity): boolean { const ta = world.get(a, Transform), tb = world.get(b, Transform); return !!ta && !!tb && Math.hypot(ta.x - tb.x, ta.y - tb.y) <= 2.5; }
export function applyDamage(world: World, target: Entity, amount: number, source: Entity, cause: DamageCause = DamageCause.Combat, pierce = 0): void {
  if (!isAuthority(world) || world.isReplaying || amount <= 0 || !world.isAlive(target)) return;
  if (cause === DamageCause.Combat && world.has(source, Progression)) { // ADR-113 weapon mastery / berserker
    const eq = world.get(source, Equipment); const held = eq && eq.mainHandSlot !== NO_SLOT ? slotItem(world, source, eq.mainHandSlot) : undefined;
    amount *= damageMulFor(world, source, held?.count ? gameplayDefs(world).items.get(held.item)?.key : undefined);
  }
  if (world.has(target, BuildPiece)) { damagePiece(world, target, amount, source, cause); return; }
  const hp = world.getField(target, Health, "hp"); if (hp === undefined || world.has(target, Dead)) return;
  if (cause === DamageCause.Combat || cause === DamageCause.Explosion) amount = armorReduce(world, target, amount, pierce);
  if (stanceMode(world, target) === StanceMode.Sleep) wake(world, target); // ADR-244: damage wakes a sleeper
  let blocked = false;
  if (cause === DamageCause.Combat && source !== 0 && source !== target && isMeleeRange(world, target, source)) {
    const mul = blockMul(world, target, source); if (mul < 1) blocked = true; amount *= mul; // ADR-244 / ADR-298
  }
  world.setField(target, Health, "hp", Math.max(0, hp - amount));
  if (world.has(target, VitalsState)) world.setField(target, VitalsState, "lastDamageCause", cause);
  emit(world, Damaged, { target, source, amount, cause });
  if (source !== 0 && source !== target && world.isAlive(source)) lastHitsOf(world).set(target, { e: source, tick: world.tick }); // ADR-194 retaliation
  if (cause === DamageCause.Combat || cause === DamageCause.Explosion) tagCombat(world, source, target);
  // ADR-193: sourceless hits (sunlight, a creature's own fire) carry no attacker: no Hurt anim / knockback flinch,
  // which read as being struck by an invisible force. The HitReact still goes out (hp bar + cause-coloured sizzle).
  // ADR-298: a blow that lands on a held guard plays block_hit instead of Hurt.
  const directed = source !== 0 && source !== target && world.isAlive(source);
  if (directed && hp - amount > 0) {
    if (blocked) setAnim(world, target, Anim.BlockHit);
    else if (world.has(target, AnimState)) setAnim(world, target, Anim.Hurt);
  }
  if (hp - amount > 0) markHit(world, target, source, amount, cause);
}

/**
 * ADR-134: stamp a broadcast HitReact on a damaged creature/player (flinch direction from the attacker, attacker NetId).
 * Cosmetic + targeting only: no stun or forced movement, so PvP stays fair; clients turn it into a ~0.3 s flinch.
 */
export function markHit(world: World, target: Entity, source: Entity, amount: number, cause: DamageCause = DamageCause.Combat): void {
  const tt = world.get(target, Transform); if (!tt) return;
  const st = world.isAlive(source) && source !== target ? world.get(source, Transform) : undefined;
  let dir = 0;
  if (st) { const a = Math.atan2(tt.y - st.y, tt.x - st.x); dir = Math.round(((a / (2 * Math.PI)) + 1) * 256) & 255; }
  const src = st ? world.getField(source, NetId, "id") ?? 0 : 0;
  const v = { startTick: world.tick, dir, src, amount: Math.min(255, Math.max(1, Math.round(amount))), cause };
  if (world.has(target, HitReact)) world.set(target, HitReact, v); else world.add(target, HitReact, v);
}
/** Radians of a HitReact.dir byte. */
export const hitDirRad = (dir: number): number => (dir / 256) * 2 * Math.PI;

export function combatSystem(world: World, dt: number): void {
  const it = world.store(PlayerIntent); const authority = isAuthority(world); const noise = gameplayDefs(world).noise;
  for (const e of world.query([PlayerIntent, Attacker, Transform], [Dead])) {
    const s = it.slot(entityIndex(e)); if (it.data.action[s] !== IntentAction.Attack) continue;
    const target = it.data.target[s]!;
    if (world.tick < world.getField(e, Attacker, "cooldownUntilTick")!) continue;
    if (!world.isAlive(target) || !(world.has(target, Health) || world.has(target, BuildPiece)) || world.has(target, Dead)) continue;
    const w = heldWeapon(world, e); const slack = rangeSlack(world, e); const piece = world.has(target, BuildPiece);
    const melee = w.range + (piece ? 0.6 : 0.4) + slack; const dist = distance(world, e, target);
    const mode = resolveAttack(world, e, dist, melee, slack, dt);
    const reach = mode.kind === "melee" ? melee : mode.reach;
    if (dist > reach) continue;
    const stamina = mode.kind === "ranged" ? mode.staminaCost : w.staminaCost;
    if (world.has(e, Survival) && !spendStamina(world, e, stamina, dt)) continue;
    world.setField(e, Attacker, "cooldownUntilTick", world.tick + secondsToTicks(mode.kind === "ranged" ? mode.cooldownSeconds : w.cooldownSeconds, dt));
    if (authority || world.has(e, AnimState)) { const sw = w === FISTS && mode.kind === "melee" ? Anim.Punch : Anim.Attack; if (world.has(e, AnimState)) world.set(e, AnimState, { anim: sw, startTick: world.tick }); else setAnim(world, e, sw); } // ADR-151: every swing restarts the anim (fast weapons chain swings); // players get AnimState lazily (settled by gameplay.animSettle)
    emit(world, AttackSwing, { entity: e, target });
    if (!authority) continue;
    if (mode.kind === "explosive") { // lands at the target's position; no hit check (area effect resolves later)
      const t = world.get(target, Transform)!; throwExplosive(world, e, mode.slot, mode.item, t.x, t.y, dt); makeNoise(world, e, noise.attack); continue;
    }
    if (mode.kind === "ranged") spendRound(world, e); // the round is spent even on a rejected hit
    if (!checkHit(world, e, target, reach)) continue;
    if (mode.kind === "ranged") {
      applyDamage(world, target, piece ? mode.damage * mode.structureMul : mode.damage, e, DamageCause.Combat, mode.pierce);
      if (mode.ignite) igniteTarget(world, target);
      makeNoise(world, e, noise.attack * 3); continue;
    }
    if (mode.kind === "thrown") { applyDamage(world, target, piece ? mode.damage * w.structureMul : mode.damage, e); landThrown(world, e, mode.slot, target); makeNoise(world, e, noise.attack); continue; }
    applyDamage(world, target, piece ? w.damage * w.structureMul : w.damage, e);
    makeNoise(world, e, noise.attack);
  }
}

const zombieLooted = new WeakMap<World, Set<Entity>>();
/** Drops zombie loot on death (ADR-160) and removes dead zombies after corpseSeconds (authority, postSim). */
export function corpseSystem(world: World, dt: number): void {
  if (!isAuthority(world) || world.isReplaying) return;
  const ticks = secondsToTicks(gameplayDefs(world).ai.corpseSeconds, dt);
  for (const z of world.query([Zombie, Dead])) {
    const at = world.getField(z, Dead, "tick")!;
    if (world.getField(z, AnimState, "anim") !== Anim.Die) setAnim(world, z, Anim.Die);
    let done = zombieLooted.get(world); if (!done) zombieLooted.set(world, done = new Set());
    if (!done.has(z)) { done.add(z); dropZombieLoot(world, z); } // ADR-160: once per corpse
    if (world.tick >= at + ticks) { done.delete(z); world.destroy(z); }
  }
  for (const p of world.query([Survival, Dead, AnimState])) if (world.getField(p, AnimState, "anim") !== Anim.Die) setAnim(world, p, Anim.Die);
}
export { Health };
