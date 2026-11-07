/**
 * Diseases system (Task 13): symptom drains, exposure / sprint accumulation, transmission and the Boil action.
 * Runs in the simulation phase after vitals, before death (so disease hp drain can kill, with cause Disease).
 * Authority-only: contraction rolls use world.rngFor, and symptom drains ride the replicated Diseases / Survival /
 * Health components to every peer (the client predicts movement from the replicated Diseases component).
 */
import { holdingTorch } from "./crafting.js";
import { entityIndex, Transform, type Entity, type World } from "@engine/core";
import { installSpatialIndex } from "@engine/world";
import { DamageCause, Dead, Diseases, Exposure, Health, IntentAction, Inventory, MAX_DISEASES, PlayerIntent, Survival, VitalsState, snapStamina } from "../components.js";
import { gameplayDefs, isAuthority, rangeSlack } from "../config.js";
import { secondsToTicks, type GameDefs } from "../defs.js";
import { ConsumeFail, ConsumeFailed, emit } from "../events.js";
import { readSlots, slotItem, writeSlots } from "../inventory.js";
import { contractDisease, cureDisease, ensureDiseases, hasDisease, activeDiseases, nearLitCampfire, wearsMask, CARE_CURE_SECONDS, FLU_AFTER_SECONDS, careStatus, coldContractedTick, infectionTier } from "../diseases.js";
import { wetIllnessTimeMul, wetnessStage } from "../exposure-stages.js";
import { pendingReady } from "../ready.js";

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Boil intents: a filled raw-water container becomes its boiled variant at a lit campfire, keeping its sips. */
function boilIntents(world: World, defs: GameDefs): void {
  const intent = world.store(PlayerIntent);
  for (const e of world.query([PlayerIntent, Inventory, Transform], [Dead])) {
    const s = intent.slot(entityIndex(e)); if (intent.data.action[s] !== IntentAction.Boil) continue;
    const slot = intent.data.slot[s]!;
    const fail = (reason: ConsumeFail): void => emit(world, ConsumeFailed, { entity: e, item: 0, reason });
    const { item, count } = slotItem(world, e, slot);
    const idef = item ? defs.items.get(item) : undefined;
    if (!item || !count || !idef || idef.sips <= 0 || idef.boiled || !idef.boilTarget) { fail(ConsumeFail.Empty); continue; }
    const v = readSlots(world, e);
    if (slot >= v.slotCount || v.durability(slot) <= 0) { fail(ConsumeFail.Empty); continue; }
    const tf = world.get(e, Transform)!;
    if (!holdingTorch(world, e) && !nearLitCampfire(world, tf.x, tf.y, defs.building.containerReach + rangeSlack(world, e))) { fail(ConsumeFail.NoFire); continue; } // ADR-262: a held beginning torch boils too
    v.put(slot, idef.boilTarget, v.count(slot), v.created(slot), v.durability(slot));
    writeSlots(world, e, v, defs);
  }
}

/** Contagious spread: cumulative close contact with a carrier, throttled to the tuning scan cadence. Either side
 * masked blocks it fully; masked carriers never enter the carrier set, masked susceptibles never accumulate. */
function transmissionScan(world: World, defs: GameDefs, dt: number): void {
  const tun = defs.diseaseTuning.transmission;
  const idx = installSpatialIndex(world);
  const carriers = new Map<Entity, number[]>();
  for (const e of world.query([Diseases, Transform], [Dead])) {
    if (wearsMask(world, e) || pendingReady(world, e)) continue; // loading players neither spread nor catch
    const contagious = activeDiseases(world, e).map((d) => defs.diseaseIndex(d.key)).filter((i) => i >= 0 && defs.diseases[i]!.contagious);
    if (contagious.length) carriers.set(e, contagious);
  }
  const contactThreshold = secondsToTicks(tun.contactSeconds, dt);
  for (const e of world.query([Diseases, Transform], [Dead])) {
    if (pendingReady(world, e)) continue;
    if (wearsMask(world, e)) { world.setField(e, Diseases, "contactTicks", 0); continue; }
    const t = world.get(e, Transform)!;
    let exposed: number[] = [];
    if (carriers.size) for (const c of idx.queryRadius(t.x, t.y, tun.radiusTiles)) if (c !== e) { const ds = carriers.get(c); if (ds) exposed.push(...ds); }
    if (!exposed.length) {
      const cur = world.getField(e, Diseases, "contactTicks") ?? 0;
      world.setField(e, Diseases, "contactTicks", Math.max(0, cur - 100)); // 5s of contact decays per scan without a carrier
      continue;
    }
    const contact = (world.getField(e, Diseases, "contactTicks") ?? 0) + tun.scanEveryTicks;
    if (contact < contactThreshold) { world.setField(e, Diseases, "contactTicks", contact); continue; }
    world.setField(e, Diseases, "contactTicks", 0);
    for (const di of new Set(exposed)) {
      const key = defs.diseases[di]!.key;
      if (hasDisease(world, e, key)) continue;
      if (world.rngFor("disease.transmit", e).next() < tun.chance) contractDisease(world, e, key, dt);
    }
  }
}

export function diseaseSystem(world: World, dt: number): void {
  if (!isAuthority(world)) return;
  const defs = gameplayDefs(world); const vt = defs.vitals; const tun = defs.diseaseTuning;
  boilIntents(world, defs);
  const intent = world.store(PlayerIntent);
  for (const e of world.query([Survival, Health, Transform], [Dead])) {
    if (pendingReady(world, e)) continue; // Task 14: no exposure counters or symptom ticks while loading in
    ensureDiseases(world, e);
    const st = world.store(Diseases); const s = st.slot(entityIndex(e)); if (s < 0) continue;
    // expiry (untilTick 0 = no auto-expiry)
    let expired = false;
    for (let i = 0; i < MAX_DISEASES; i++) {
      const d = st.data.disease[s * MAX_DISEASES + i]!; const until = st.data.untilTick[s * MAX_DISEASES + i]!;
      if (d !== 0 && until !== 0 && world.tick >= until) { st.data.disease[s * MAX_DISEASES + i] = 0; st.data.untilTick[s * MAX_DISEASES + i] = 0; expired = true; }
    }
    if (expired) st.markChanged(entityIndex(e));
    // symptom drains (direct, like vitals damage: no Buffs slots, so disease penalties never clobber trap roots)
    const actives = activeDiseases(world, e);
    if (actives.length) {
      const sv = world.get(e, Survival)!; const hp = world.get(e, Health)!;
      let hunger = sv.hunger, thirst = sv.thirst, stamina = sv.stamina, hpV = hp.hp, hurt = false;
      for (const d of actives) {
        const hpDps = d.key === "wound_infection" && infectionTier(world, e) !== "septic" ? 0 : d.hpDps;
        if (hpDps > 0) { hpV = Math.max(0, hpV - hpDps * dt); hurt = true; }
        hunger = Math.max(0, hunger - vt.hungerDecayPerSec * (d.hungerMul - 1) * dt);
        thirst = Math.max(0, thirst - vt.thirstDecayPerSec * (d.thirstMul - 1) * dt);
        stamina = Math.max(0, stamina - d.staminaDrainPerSec * dt);
      }
      world.set(e, Survival, { hunger, thirst, stamina: snapStamina(stamina) });
      world.set(e, Health, { hp: hpV });
      if (hurt && world.has(e, VitalsState)) world.setField(e, VitalsState, "lastDamageCause", DamageCause.Disease);
    }
    // prolonged cold / heat (thresholds from vitals.json; sustained exposure, not a single cold tick)
    const body = world.getField(e, Survival, "bodyTemp") ?? vt.bodyTempNormal;
    const wet = world.getField(e, Exposure, "wetness") ?? 0;
    const illnessTimeMul = wetIllnessTimeMul(wet);
    // ADR-278: continuous cold OR continuous wetness is an illness exposure; brief wetting dries before the long threshold.
    if (body < vt.hypothermiaBelow || wetnessStage(wet) !== undefined) {
      world.setField(e, Diseases, "coldTicks", (world.getField(e, Diseases, "coldTicks") ?? 0) + 1);
      if ((world.getField(e, Diseases, "coldTicks") ?? 0) >= secondsToTicks(tun.exposure.coldSeconds * illnessTimeMul, dt)) {
        world.setField(e, Diseases, "coldTicks", 0);
        if (!hasDisease(world, e, "common_cold")) contractDisease(world, e, "common_cold", dt);
      }
    } else world.setField(e, Diseases, "coldTicks", 0);
    // Heatstroke retains its original independent timer even while wet.
    if (body > vt.hyperthermiaAbove) {
      world.setField(e, Diseases, "heatTicks", (world.getField(e, Diseases, "heatTicks") ?? 0) + 1);
      if ((world.getField(e, Diseases, "heatTicks") ?? 0) >= secondsToTicks(tun.exposure.heatSeconds, dt)) {
        world.setField(e, Diseases, "heatTicks", 0);
        if (!hasDisease(world, e, "heatstroke")) contractDisease(world, e, "heatstroke", dt);
      }
    } else world.setField(e, Diseases, "heatTicks", 0);
    // Task 31: an untreated cold develops into flu after FLU_AFTER_SECONDS; the care clock restarts for the flu.
    if (hasDisease(world, e, "common_cold")) {
      const contracted = coldContractedTick(world, e);
      if (contracted !== undefined && world.tick - contracted >= secondsToTicks(FLU_AFTER_SECONDS * illnessTimeMul, dt)) {
        cureDisease(world, e, "common_cold");
        world.setField(e, Diseases, "careTicks", 0);
        contractDisease(world, e, "influenza", dt);
      }
    }
    // Task 31: care cure — continuous dry + fed + hydrated + warm time cures a cold or the flu (240s).
    // Any broken condition resets the clock (the four must hold the whole time); item cures still work too.
    const sick = hasDisease(world, e, "common_cold") || hasDisease(world, e, "influenza");
    if (sick) {
      if (careStatus(world, e).missing.length === 0) {
        const care = (world.getField(e, Diseases, "careTicks") ?? 0) + 1;
        world.setField(e, Diseases, "careTicks", care);
        if (care >= secondsToTicks(CARE_CURE_SECONDS, dt)) {
          cureDisease(world, e, "common_cold"); cureDisease(world, e, "influenza");
          world.setField(e, Diseases, "careTicks", 0);
        }
      } else if ((world.getField(e, Diseases, "careTicks") ?? 0) !== 0) {
        world.setField(e, Diseases, "careTicks", 0);
      }
    } else if ((world.getField(e, Diseases, "careTicks") ?? 0) !== 0) {
      world.setField(e, Diseases, "careTicks", 0);
    }
    // sprinting too long -> exhaustion; resting (no sprint) for the recovery period clears it
    const si = intent.slot(entityIndex(e));
    const sprinting = si >= 0 && intent.data.sprint[si] === 1 && intent.data.moving[si] === 1 && (world.getField(e, Survival, "stamina") ?? 0) > 0;
    if (sprinting) {
      world.setField(e, Diseases, "sprintTicks", (world.getField(e, Diseases, "sprintTicks") ?? 0) + 1);
      world.setField(e, Diseases, "restTicks", 0);
      if ((world.getField(e, Diseases, "sprintTicks") ?? 0) >= secondsToTicks(tun.exposure.sprintSeconds, dt)) {
        world.setField(e, Diseases, "sprintTicks", 0);
        if (!hasDisease(world, e, "exhaustion")) contractDisease(world, e, "exhaustion", dt);
      }
    } else {
      world.setField(e, Diseases, "sprintTicks", 0);
      world.setField(e, Diseases, "restTicks", (world.getField(e, Diseases, "restTicks") ?? 0) + 1);
      if (hasDisease(world, e, "exhaustion") && (world.getField(e, Diseases, "restTicks") ?? 0) >= secondsToTicks(tun.exposure.restSeconds, dt)) {
        world.setField(e, Diseases, "restTicks", 0);
        cureDisease(world, e, "exhaustion");
      }
    }
  }
  if (world.tick % tun.transmission.scanEveryTicks === 0) transmissionScan(world, defs, dt);
}
