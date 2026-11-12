/**
 * Spoilage (authority, slow system every 20 ticks): food freshness is lazy (core decayAt from each slot's effective
 * created tick), so nothing ticks per item. This system only
 *  1. re-bases created ticks when a holder's spoil multiplier changes (temperature x container), preserving freshness;
 *  2. converts fully spoiled stacks to the spoiled item (data: environment.spoilage.spoiledItem).
 * Multiplier = container spoilMul (piece data) x clamp(1 + mulPerDegree x (temp - tempRefC), minMul, maxMul).
 */
import { entityIndex, Transform, type Entity, type World } from "@engine/core";
import { ClimateRes } from "@engine/world";
import { BuildPiece, Container, Exposure, Inventory, type InvSchema } from "../components.js";
import { pieceOf } from "../building/links.js";
import { gameplayDefs, isAuthority } from "../config.js";
import { countItem, freshness, mapSlots, rebaseCreated, removeItem, slotsAdd } from "../inventory.js";
import { pendingReady } from "../ready.js";
import { ambientTemperature, FREEZING_C, surfaceTemperature } from "./environment.js";
import { isUnderground, TERRAIN } from "../terrain_depth.js";
import type { ComponentDef } from "@engine/core";

export const SPOILAGE_EVERY = 20;
/** Task 28: a salt-fuelled container burns 1 salt per SALT_CONSUME_TICKS while it holds spoilable food. */
export const SALT_CONSUME_TICKS = 3600;
/** Last tick each salt-fuelled container consumed salt (authority-side only; resets on reload — timing, not state). */
const saltLast = new WeakMap<World, Map<Entity, number>>();
/**
 * Task 30: last spoilage-pass tick per holder. Frozen food's effective age is held still by advancing each
 * slot's `created` tick by the time since the last pass, so it resumes spoiling from where it left off on
 * thaw instead of resetting (a stored multiplier of 0 would lose the age) or decaying retroactively.
 */
const frozenLast = new WeakMap<World, Map<Entity, number>>();
/** Salt in a container holder (0 when the holder has no salt item, or the catalog has no salt). */
export function saltCount(world: World, e: Entity): number {
  let salt = 0; try { salt = gameplayDefs(world).itemId("salt"); } catch { return 0; }
  return countItem(world, e, salt);
}
/** Container multiplier from the owning piece's data (1 for players / free-standing holders). Task 28: a
 * salt-fuelled piece (salt_barrel / curing_box / cold_store) only grants its spoilMul while its container
 * holds salt; unfuelled it is ordinary storage (multiplier 1). */
function baseMul(world: World, e: Entity): number {
  const p = pieceOf(world, e); if (p === undefined) return 1;
  const t = world.getField(p, BuildPiece, "type"); const def = t !== undefined ? gameplayDefs(world).pieces.get(t) : undefined;
  if (!def) return 1;
  if (def.saltFuel) return saltCount(world, e) > 0 ? def.spoilMul : 1;
  return def.spoilMul || 1;
}
/** Burn one salt from a salt-fuelled container when due (called from the Container pass, before `want` is read).
 * ADR-368: the holdsSpoilable scan is gone — the pass only calls this for holders it already gated on
 * (they carry spoilable food), so salt still only burns while there is food to preserve. */
function burnSalt(world: World, e: Entity): void {
  const p = pieceOf(world, e); if (p === undefined) return;
  const t = world.getField(p, BuildPiece, "type"); const def = t !== undefined ? gameplayDefs(world).pieces.get(t) : undefined;
  if (!def?.saltFuel) return;
  if (saltCount(world, e) <= 0) return;
  let m = saltLast.get(world); if (!m) saltLast.set(world, (m = new Map()));
  const last = m.get(e);
  if (last === undefined) { m.set(e, world.tick); return; } // first sight: start the clock, do not burn yet
  if (world.tick - last < SALT_CONSUME_TICKS) return;
  if (removeItem(world, e, gameplayDefs(world).itemId("salt"), 1)) m.set(e, world.tick);
}

export function spoilageSystem(world: World, dt: number): void {
  if (!isAuthority(world)) return;
  const defs = gameplayDefs(world); const sp = defs.environment.spoilage; const tickDt = dt / SPOILAGE_EVERY;
  // ADR-368: without a ClimateRes the surface temperature is the same everywhere (seasonalTemperature
  // ignores position — the same hoist exposureSystem got in Task 29), so compute it once per pass
  // instead of per holder; underground holders still read the constant 60F below. With a ClimateRes
  // it varies by position and stays per holder.
  const hasClimate = !!world.getResource(ClimateRes);
  const surface0 = hasClimate ? undefined : surfaceTemperature(world);
  const run = (def: ComponentDef<InvSchema>): void => {
    const st = world.store(def);
    for (let k = st.size - 1; k >= 0; k--) {
      const e = st.dense[k]!; if (pendingReady(world, e)) continue; // Task 14: a loading player's pack does not spoil
      // Task 30: frozen food (at or below 32 F / 0 C) does not spoil and burns no salt. Its stored multiplier
      // is left alone — a stored 0 would lose the food's age (rebaseCreated from 0 resets freshness on thaw).
      const idx = entityIndex(e);
      let m = frozenLast.get(world); if (!m) frozenLast.set(world, (m = new Map()));
      const prev = m.get(e); m.set(e, world.tick);
      // normally exactly one pass (20 ticks) back; capped so a holder skipped for a while (loading) never jumps fresh
      const held = prev === undefined || prev > world.tick ? 0 : Math.min(world.tick - prev, SPOILAGE_EVERY * 2);
      // ADR-368: most holders carry no spoilable food at all — skip the per-item work
      // (mapSlots copies every slot array) for them. Allocation-free scan over the live
      // slot arrays; the frozenLast update above still runs for every holder, so food
      // added later never inherits a stale freeze credit. The holder's spoilMul still
      // re-bases below even with no spoilable food: it is a property of the container
      // (Task 28: a salt barrel holding only salt still reads 0.5x), so the cheap
      // temperature / piece / salt lookups run for every holder — only the per-item
      // decay/conversion loop is skipped. Salt still only burns while food is present.
      const slot = st.slot(idx); const n = Math.min(st.data.slotCount[slot]!, def.schema.items.length);
      let spoilable = false;
      for (let i = 0; i < n; i++) { const item = st.readElement(idx, "items", i) ?? 0; if (item && defs.items.get(item)?.spoilSeconds) { spoilable = true; break; } }
      const temp = world.has(e, Exposure) ? world.getField(e, Exposure, "feltTemp")!
        : world.has(e, Transform) ? (isUnderground(world, world.getField(e, Transform, "x")!, world.getField(e, Transform, "y")!) ? TERRAIN.undergroundTempC : surface0 ?? ambientTemperature(world, world.getField(e, Transform, "x")!, world.getField(e, Transform, "y")!))
        : sp.tempRefC;
      const frozen = temp <= FREEZING_C;
      if (spoilable && def === Container && !frozen) burnSalt(world, e); // Task 28: salt burns before the multiplier is read this pass
      const tempMul = Math.min(sp.maxMul, Math.max(sp.minMul, 1 + sp.mulPerDegree * (temp - sp.tempRefC)));
      const cur = st.data.spoilMul[k]!;
      const want = frozen ? cur : baseMul(world, e) * tempMul;
      const rebase = !frozen && Math.abs(want - cur) > sp.rebaseThreshold * cur;
      if (!spoilable) { if (rebase) { st.data.spoilMul[st.slot(idx)] = want; st.markChanged(idx); } continue; }
      mapSlots(world, e, (v) => {
        let changed = false;
        for (let i = 0; i < v.slotCount; i++) {
          const item = v.item(i); if (!item || !(defs.items.get(item)?.spoilSeconds)) continue;
          if (frozen && held > 0) { v.put(i, item, v.count(i), v.created(i) + held); changed = true; } // hold the age still
          if (rebase) { v.put(i, item, v.count(i), rebaseCreated(v.created(i), world.tick, cur, want)); changed = true; }
          if (freshness(defs, item, v.created(i), rebase ? want : cur, world.tick, tickDt) <= 0 && defs.spoiledItem) {
            const n = v.count(i); v.put(i, 0, 0); slotsAdd(v, defs.spoiledItem, n, defs, world.tick); changed = true;
          }
        }
        return changed;
      });
      if (rebase) { st.data.spoilMul[st.slot(idx)] = want; st.markChanged(idx); }
    }
  };
  run(Inventory); run(Container);
}
