/**
 * Arms & wearables (content expansion): worn clothing/armor, ranged reload/charge, thrown weapons, explosives.
 * Server-authoritative and deterministic: inventory/ammo/damage only change on the authority; clients may predict
 * timers (reloadUntilTick / chargeStartTick) from the owner-scoped WeaponState.
 *  - gameplay.wear (before exposure): Wear intent toggles the wearable in an inventory slot; derives
 *    Exposure.insulation, Worn.waterproof (mean over 6 slots, read by exposure wetting), Worn.armor, carryBonus->maxWeight.
 *  - gameplay.weapons (before combat): unload on main-hand switch, Reload intent -> timer -> rounds from inventory, Charge hold.
 *  - combat (combat.ts) calls resolveAttack() to pick melee / ranged / thrown / explosive throw.
 *  - gameplay.explosives (after combat): fuse -> radial damage (falloff), structures via damagePiece (raid attribution),
 *    own-tribe structures x pvp.explosives.ownTribeStructureMul, RaidRule hook, ignite; Exploded (reliable).
 */
import { LootSource, tagLootSource } from "../loot_labels.js";
import { lootBagInit } from "../loot_despawn.js";
import { defineResource, entityIndex, PlayerId, Transform, type Entity, type World } from "@engine/core";
import { BuildPiece, Container, DamageCause, ContainerViewers, Dead, Equipment, Exposure, Health, ExplosiveOwner, IntentAction, Inventory, LiveExplosive, LootBag, NO_SLOT, PlayerIntent, Tribe, WeaponState, Worn } from "../components.js";
import { gameplayDefs, isAuthority } from "../config.js";
import { BODY_WEAR_SLOTS, ItemCategory, secondsToTicks, WearSlot, WEAR_SLOTS, type ItemDef } from "../defs.js";
import { emit, ev } from "../events.js";
import { addItem, countItem, moveSlotTuples, removeItem, slotItem, takeFromSlot } from "../inventory.js";
import { applyDamage } from "./combat.js";
import { Anim, AnimState } from "../components.js";
import { indexEntity } from "../spawn.js";
import { PVP, hasPlayerId } from "./pvp.js";
import { ignite } from "./pvp_pieces.js";
import { saddleArmorOf } from "../mount_defs.js";

export const Exploded = ev<{ entity: Entity; item: number; owner: Entity; x: number; y: number; radius: number }>("gameplay.Exploded");
export const Reloaded = ev<{ entity: Entity; item: number; ammo: number; rounds: number }>("gameplay.Reloaded");
export const ARMS_EVENT_RELIABILITY = { "gameplay.Exploded": "reliable", "gameplay.Reloaded": "reliable" } as const;

/** Optional raid-window rule (server): false = this explosion may not damage that piece. Absent = allowed. */
export type RaidRule = (attacker: Entity, piece: Entity) => boolean;
export const RaidRuleRes = defineResource<{ fn: RaidRule | undefined }>("gameplay.RaidRule");
export function setRaidRule(world: World, fn: RaidRule | undefined): void { world.setResource(RaidRuleRes, { fn }); }

const canMutate = (world: World): boolean => isAuthority(world) && !world.isReplaying;
const itemDef = (world: World, id: number): ItemDef | undefined => gameplayDefs(world).items.get(id);

// ---- wear ------------------------------------------------------------------------------------------------
export function wornItems(world: World, e: Entity): number[] {
  const st = world.store(Worn); const s = st.slot(entityIndex(e)); if (s < 0) return [];
  const out: number[] = []; for (let i = 0; i < WEAR_SLOTS; i++) out.push(st.data.item[s * WEAR_SLOTS + i]!); return out;
}
/** Worn armor plus ADR-320 saddle defense (a saddled mount, or a rider on one). */
export const armorOf = (world: World, e: Entity): number => (world.getField(e, Worn, "armor") ?? 0) + saddleArmorOf(world, e);
export const waterproofOf = (world: World, e: Entity): number => world.getField(e, Worn, "waterproof") ?? 0;

/** Toggle-wear the item in inventory `slot` (authority). Returns false if not wearable. */
export function wearSlot(world: World, e: Entity, slot: number): boolean {
  if (!canMutate(world) || !world.has(e, Worn) || !world.has(e, Inventory)) return false;
  const { item } = slotItem(world, e, slot); const w = item ? itemDef(world, item)?.wear : undefined; if (!w) return false;
  const st = world.store(Worn); const s = st.slot(entityIndex(e)); const k = s * WEAR_SLOTS + w.slot;
  if (st.data.slot[k] === slot + 1) { st.data.slot[k] = 0; st.data.item[k] = 0; }
  else if (w.slot === WearSlot.OffHand && world.getField(e, Equipment, "mainHandSlot") === slot) return false;
  else { st.data.slot[k] = slot + 1; st.data.item[k] = item; }
  st.markChanged(entityIndex(e)); refreshWorn(world, e); return true;
}
/** Drops worn entries whose inventory slot no longer holds that item, then re-derives totals. */
export function refreshWorn(world: World, e: Entity): void {
  const st = world.store(Worn); const idx = entityIndex(e); const s = st.slot(idx); if (s < 0) return;
  let ins = 0, wp = 0, armor = 0, carry = 0, changed = false;
  for (let i = 0; i < WEAR_SLOTS; i++) {
    const k = s * WEAR_SLOTS + i; const sl = st.data.slot[k]!; if (!sl) continue;
    const it = st.data.item[k]!;
    if (slotItem(world, e, sl - 1).item !== it || (i === WearSlot.OffHand && world.has(e, Equipment) && world.getField(e, Equipment, "mainHandSlot") === sl - 1)) { st.data.slot[k] = 0; st.data.item[k] = 0; changed = true; continue; }
    const w = itemDef(world, it)?.wear; if (!w) continue;
    ins += w.insulation; wp += w.waterproof; armor += w.armor; carry += w.carryBonus;
  }
  wp /= BODY_WEAR_SLOTS;
  const oldCarry = st.data.carryBonus[s]!;
  if (oldCarry !== carry && world.has(e, Inventory)) world.setField(e, Inventory, "maxWeight", world.getField(e, Inventory, "maxWeight")! + carry - oldCarry);
  if (changed || oldCarry !== carry || st.data.waterproof[s] !== Math.fround(wp) || st.data.armor[s] !== armor) {
    st.data.carryBonus[s] = carry; st.data.waterproof[s] = wp; st.data.armor[s] = armor; st.markChanged(idx);
  }
  if (world.has(e, Exposure) && world.getField(e, Exposure, "insulation") !== ins) world.setField(e, Exposure, "insulation", ins);
}
export function wearSystem(world: World): void {
  if (!canMutate(world)) return;
  const it = world.store(PlayerIntent);
  for (const e of world.query([Worn, Inventory])) {
    const s = it.slot(entityIndex(e));
    if (s >= 0 && it.data.action[s] === IntentAction.Wear) wearSlot(world, e, it.data.slot[s]!);
    else refreshWorn(world, e);
  }
}
/** Armor: damage x 100 / (100 + armor x (1 - pierce)). */
export function armorReduce(world: World, target: Entity, amount: number, pierce = 0): number {
  const a = armorOf(world, target) * (1 - Math.min(1, Math.max(0, pierce))); return a > 0 ? (amount * 100) / (100 + a) : amount;
}

// ---- ranged weapons ---------------------------------------------------------------------------------------
/** True when `e`'s main hand holds a ranged weapon (networked Equipment.mainHandItem): gates the touch Reload button (ADR-133). */
export function holdsRangedWeapon(world: World, e: Entity | undefined): boolean {
  if (e === undefined || !world.isRegistered(Equipment) || !world.has(e, Equipment)) return false;
  const item = world.getField(e, Equipment, "mainHandItem"); if (!item) return false;
  try { return !!itemDef(world, item)?.ranged; } catch { return false; }
}
function heldDef(world: World, e: Entity): { slot: number; item: number; def: ItemDef | undefined } {
  const slot = world.getField(e, Equipment, "mainHandSlot");
  if (slot === undefined || slot === NO_SLOT || !world.has(e, Inventory)) return { slot: NO_SLOT, item: 0, def: undefined };
  const item = slotItem(world, e, slot).item; return { slot, item, def: item ? itemDef(world, item) : undefined };
}
function pickAmmo(world: World, e: Entity, def: ItemDef, loaded: number, current: number): number {
  if (loaded > 0) return current;
  for (const a of def.ranged!.ammo) if (countItem(world, e, a) > 0) return a; return 0;
}
export function weaponsSystem(world: World, dt: number): void {
  const it = world.store(PlayerIntent); const auth = canMutate(world);
  for (const e of world.query([WeaponState, PlayerIntent], [Dead])) {
    const ws = world.get(e, WeaponState)!; const h = heldDef(world, e); const s = it.slot(entityIndex(e));
    const want = h.def?.ranged ? h.slot + 1 : 0;
    if (ws.slot !== want) { // switched weapon: return rounds to inventory
      if (auth && ws.loaded > 0 && ws.ammoItem) addItem(world, e, ws.ammoItem, ws.loaded);
      world.set(e, WeaponState, { slot: want, loaded: 0, ammoItem: 0, reloadUntilTick: 0, chargeStartTick: 0 }); continue;
    }
    const r = h.def?.ranged; if (!r) continue;
    if (ws.reloadUntilTick > 0 && world.tick >= ws.reloadUntilTick) {
      if (auth) {
        const ammo = pickAmmo(world, e, h.def!, ws.loaded, ws.ammoItem);
        const n = ammo ? Math.min(r.magazine - ws.loaded, countItem(world, e, ammo)) : 0;
        if (n > 0 && removeItem(world, e, ammo, n)) { world.set(e, WeaponState, { loaded: ws.loaded + n, ammoItem: ammo, reloadUntilTick: 0 }); emit(world, Reloaded, { entity: e, item: h.item, ammo, rounds: ws.loaded + n }); }
        else world.setField(e, WeaponState, "reloadUntilTick", 0);
      } else world.setField(e, WeaponState, "reloadUntilTick", 0);
    } else if (s >= 0 && it.data.action[s] === IntentAction.Reload && ws.reloadUntilTick === 0 && ws.loaded < r.magazine && pickAmmo(world, e, h.def!, ws.loaded, ws.ammoItem)) {
      world.setField(e, WeaponState, "reloadUntilTick", world.tick + Math.max(1, secondsToTicks(r.reloadSeconds, dt)));
    }
    if (r.chargeSeconds > 0) {
      const charging = s >= 0 && it.data.charge[s] === 1; const st = world.getField(e, WeaponState, "chargeStartTick")!;
      if (charging && st === 0) { world.setField(e, WeaponState, "chargeStartTick", world.tick + 1); aimAnim(world, e, true); }
      else if (!charging && st !== 0 && (s < 0 || it.data.action[s] !== IntentAction.Attack)) { world.setField(e, WeaponState, "chargeStartTick", 0); aimAnim(world, e, false); }
    }
  }
}
/** ADR-241: drawing a bow/crossbow plays Aim (bow_draw -> bow_hold / gun_aim); releasing without a shot drops back to Idle (a shot's Attack wins). */
function aimAnim(world: World, e: Entity, on: boolean): void {
  if (!world.has(e, AnimState)) return; const cur = world.getField(e, AnimState, "anim");
  if (on && cur !== Anim.Aim && cur !== Anim.Attack) world.set(e, AnimState, { anim: Anim.Aim, startTick: world.tick });
  else if (!on && cur === Anim.Aim) world.set(e, AnimState, { anim: Anim.Idle, startTick: world.tick });
}
/** Draw multiplier minChargeMul..1 (1 for weapons without a draw). */
export function chargeMul(world: World, e: Entity, def: ItemDef, dt: number): number {
  const r = def.ranged!; if (r.chargeSeconds <= 0) return 1;
  const st = world.getField(e, WeaponState, "chargeStartTick") ?? 0; if (!st) return r.minChargeMul;
  const f = Math.min(1, (world.tick + 1 - st) / Math.max(1, secondsToTicks(r.chargeSeconds, dt)));
  return r.minChargeMul + (1 - r.minChargeMul) * f;
}

export type AttackMode =
  | { kind: "melee" }
  | { kind: "ranged"; reach: number; damage: number; structureMul: number; pierce: number; ignite: boolean; cooldownSeconds: number; staminaCost: number }
  | { kind: "thrown"; reach: number; damage: number; slot: number }
  | { kind: "explosive"; reach: number; slot: number; item: number };

/** Picks the attack mode for the held item given the target distance and melee reach. */
export function resolveAttack(world: World, e: Entity, dist: number, meleeReach: number, slack: number, dt: number): AttackMode {
  const h = heldDef(world, e); const d = h.def; if (!d) return { kind: "melee" };
  if (d.category === ItemCategory.Explosive && d.explosive) return { kind: "explosive", reach: d.explosive.throwRange + slack, slot: h.slot, item: h.item };
  const closeEnough = dist <= meleeReach;
  if (d.ranged && !closeEnough) {
    const ws = world.get(e, WeaponState);
    if (ws && ws.slot === h.slot + 1 && ws.loaded > 0 && ws.reloadUntilTick === 0) {
      const a = itemDef(world, ws.ammoItem)?.ammo; const mul = chargeMul(world, e, d, dt) * (a?.damageMul ?? 1);
      return { kind: "ranged", reach: d.ranged.range + slack, damage: d.ranged.damage * mul, structureMul: d.ranged.structureMul * (a?.structureMul ?? 1), pierce: a?.armorPierce ?? 0, ignite: a?.ignite ?? false, cooldownSeconds: d.ranged.cooldownSeconds, staminaCost: d.ranged.staminaCost };
    }
  }
  if (d.thrown && !closeEnough) return { kind: "thrown", reach: d.thrown.range + slack, damage: d.thrown.damage, slot: h.slot };
  return { kind: "melee" };
}
/** Authority: spend one loaded round (after the shot is validated). */
export function spendRound(world: World, e: Entity): void {
  if (!canMutate(world)) return; const n = world.getField(e, WeaponState, "loaded") ?? 0;
  world.set(e, WeaponState, { loaded: Math.max(0, n - 1), chargeStartTick: 0, ...(n <= 1 && { ammoItem: 0 }) });
}
export const igniteTarget = (world: World, target: Entity): boolean => world.has(target, BuildPiece) && ignite(world, target);

/** Authority: the thrown weapon (1 unit, durability/crafter kept) lands in a loot bag at the target; thrower has the owner-only window. */
export function landThrown(world: World, e: Entity, slot: number, target: Entity): Entity | undefined {
  if (!canMutate(world)) return undefined;
  const t = world.get(target, Transform); if (!t) return undefined;
  const bag = world.create(); const ownerId = (hasPlayerId(world, e) ? world.getField(e, PlayerId, "id") : undefined) ?? 0;
  world.add(bag, Transform, { x: t.x, y: t.y, z: t.z }).add(bag, Container, { slotCount: 1 }).add(bag, ContainerViewers)
    .add(bag, LootBag, lootBagInit(world, ownerId, "thrown", LootSource.Dropped));
  moveSlotTuples(world, e, bag, [{ slot, count: 1 }]); tagLootSource(world, bag, LootSource.Dropped); indexEntity(world, bag);
  if (world.getField(e, Equipment, "mainHandSlot") === slot && slotItem(world, e, slot).count === 0) world.set(e, Equipment, { mainHandSlot: NO_SLOT, mainHandItem: 0 });
  return bag;
}

// ---- explosives -------------------------------------------------------------------------------------------
/** Authority: remove one explosive from `slot` and arm it at the target point. */
export function throwExplosive(world: World, e: Entity, slot: number, item: number, x: number, y: number, dt: number): Entity | undefined {
  if (!canMutate(world)) return undefined; const d = itemDef(world, item)?.explosive; if (!d) return undefined;
  if (slotItem(world, e, slot).item !== item || !takeFromSlot(world, e, slot)) return undefined;
  const live = world.create();
  world.add(live, Transform, { x, y }).add(live, LiveExplosive, { item, detonateTick: world.tick + Math.max(1, secondsToTicks(d.fuseSeconds, dt)) })
    .add(live, ExplosiveOwner, { owner: e, ownerTribe: world.getField(e, Tribe, "id") ?? 0 });
  return live;
}
export function explosivesSystem(world: World): void {
  if (!canMutate(world)) return;
  const tf = world.store(Transform); const cfg = PVP.explosives;
  for (const b of [...world.query([LiveExplosive, Transform])].sort((a, c) => a - c)) {
    const lx = world.get(b, LiveExplosive)!; if (world.tick < lx.detonateTick) continue;
    const ow = world.get(b, ExplosiveOwner) ?? { owner: 0, ownerTribe: 0 };
    const d = itemDef(world, lx.item)?.explosive; const p = world.get(b, Transform)!; world.destroy(b);
    if (!d) continue;
    const owner = ow.owner as Entity; const rule = world.getResource(RaidRuleRes)?.fn;
    const hits: [Entity, number][] = [];
    for (const t of world.query([Transform])) {
      if (!(world.has(t, Health) || world.has(t, BuildPiece)) || world.has(t, Dead)) continue;
      const s = tf.slot(entityIndex(t)); const dist = Math.hypot(tf.data.x[s]! - p.x, tf.data.y[s]! - p.y); if (dist > d.radius) continue;
      hits.push([t, 1 - (1 - cfg.edgeFalloff) * (dist / d.radius)]);
    }
    hits.sort((a, c) => a[0] - c[0]);
    for (const [t, f] of hits) {
      if (world.has(t, BuildPiece)) {
        if (rule && !rule(owner, t)) continue;
        const own = ow.ownerTribe !== 0 && world.getField(t, Tribe, "id") === ow.ownerTribe;
        const amt = d.structureDamage * f * (own ? cfg.ownTribeStructureMul : 1);
        if (amt > 0) applyDamage(world, t, amt, owner, DamageCause.Explosion);
        if (d.ignite && f >= 1 - (1 - cfg.edgeFalloff) * cfg.igniteRadiusFrac) ignite(world, t);
      } else {
        const amt = d.damage * f * (hasPlayerId(world, t) ? cfg.playerDamageMul : 1);
        applyDamage(world, t, amt, owner, DamageCause.Explosion);
      }
    }
    emit(world, Exploded, { entity: b, item: lx.item, owner, x: p.x, y: p.y, radius: d.radius });
  }
}
