/**
 * Diseases: shared helpers (data/diseases.json). This module is deliberately free of vitals imports: vitals.ts
 * calls contractDisease / cureDiseasesForItem from consumeSystem, while systems/diseases.ts owns the per-tick
 * system, the Boil action and transmission. Rolls happen at call sites, gated on isAuthority; contracting and
 * curing themselves are deterministic writes.
 */
import { DEFAULT_TICK_HZ, entityIndex, Transform, type Entity, type World } from "@engine/core";
import { BuildPiece, CraftingStation, DamageCause, Diseases, Exposure, Fuel, Health, MAX_DISEASES, Animal, Survival, Wetness, Worn, Zombie } from "./components.js";
import { gameplayDefs, isAuthority } from "./config.js";
import { secondsToTicks, StationKind, WearSlot, type DiseaseDef } from "./defs.js";
import { Damaged } from "./events.js";
import { pieceOf } from "./building/links.js";

/** Adds a Diseases component when missing (same lazy pattern as writeBodyTemp); returns false when already present. */
export function ensureDiseases(world: World, e: Entity): boolean {
  if (world.has(e, Diseases)) return false;
  world.add(e, Diseases, {});
  return true;
}
/** Slot index holding disease `index` (0-based into defs.diseases), or -1. */
export function diseaseSlot(world: World, e: Entity, index: number): number {
  if (!world.has(e, Diseases)) return -1;
  const st = world.store(Diseases); const s = st.slot(entityIndex(e)); if (s < 0) return -1;
  for (let i = 0; i < MAX_DISEASES; i++) if (st.data.disease[s * MAX_DISEASES + i] === index + 1) return i;
  return -1;
}
export function hasDisease(world: World, e: Entity, key: string): boolean {
  const idx = gameplayDefs(world).diseaseIndex(key); return idx >= 0 && diseaseSlot(world, e, idx) >= 0;
}
/** Active disease defs on an entity (HUD chips, move penalty, transmission carriers). */
export function activeDiseases(world: World, e: Entity): DiseaseDef[] {
  if (!world.has(e, Diseases)) return [];
  const defs = gameplayDefs(world); const st = world.store(Diseases); const s = st.slot(entityIndex(e)); if (s < 0) return [];
  const out: DiseaseDef[] = [];
  for (let i = 0; i < MAX_DISEASES; i++) { const d = st.data.disease[s * MAX_DISEASES + i]!; if (d > 0) { const def = defs.diseases[d - 1]; if (def) out.push(def); } }
  return out;
}
/**
 * Contracts (or refreshes) a disease: expiry = now + duration (0 = no auto-expiry, e.g. exhaustion, which clears
 * on rest). Returns false for unknown keys or a full disease table.
 */
export function contractDisease(world: World, e: Entity, key: string, dt = 1 / 20): boolean {
  const defs = gameplayDefs(world); const idx = defs.diseaseIndex(key); if (idx < 0) return false;
  if (key === "wound_infection" && !world.has(e, Survival)) return false;
  ensureDiseases(world, e);
  const st = world.store(Diseases); const s = st.slot(entityIndex(e)); if (s < 0) return false;
  const until = defs.diseases[idx]!.durationSeconds > 0 ? world.tick + secondsToTicks(defs.diseases[idx]!.durationSeconds, dt) : 0;
  let slot = diseaseSlot(world, e, idx);
  // Another bite must not reset an already-progressing infection back to its harmless first tier.
  if (key === "wound_infection" && slot >= 0) return true;
  if (slot < 0) { for (let i = 0; i < MAX_DISEASES; i++) if (st.data.disease[s * MAX_DISEASES + i] === 0) { slot = i; break; } }
  if (slot < 0) return false;
  if (key === "wound_infection") st.data.infectionHz[s] = Math.max(1, Math.min(0xffff, Math.round(1 / dt)));
  st.data.disease[s * MAX_DISEASES + slot] = idx + 1; st.data.untilTick[s * MAX_DISEASES + slot] = until; st.markChanged(entityIndex(e));
  return true;
}
/** Clears one disease; returns true when it was present. */
export function cureDisease(world: World, e: Entity, key: string): boolean {
  const idx = gameplayDefs(world).diseaseIndex(key); if (idx < 0 || !world.has(e, Diseases)) return false;
  const st = world.store(Diseases); const s = st.slot(entityIndex(e)); if (s < 0) return false;
  const slot = diseaseSlot(world, e, idx); if (slot < 0) return false;
  st.data.disease[s * MAX_DISEASES + slot] = 0; st.data.untilTick[s * MAX_DISEASES + slot] = 0; st.markChanged(entityIndex(e));
  return true;
}
/** Clears every disease the consumed item cures (consumeSystem calls this after a successful eat/drink). */
export function cureDiseasesForItem(world: World, e: Entity, item: number): string[] {
  const cured: string[] = [];
  const def = gameplayDefs(world).items.get(item);
  if (def?.key === "bandage") treatWoundInfection(world, e);
  for (const key of def?.cures ?? []) if (cureDisease(world, e, key)) cured.push(key);
  return cured;
}
/**
 * Task 33: death clears afflictions — every disease slot plus every exposure accumulator (cold/heat/sprint/rest/
 * contact/care ticks), so a respawned player (or AI human, via the same respawnPlayer path) starts with no health
 * issues. Wetness clears too: it is part of the body's state, and a fresh body is dry (bodyTemp is already reset
 * by respawnPlayer). Timed Buffs modifiers are left alone — they lapse on their own expiry.
 */
export function clearAfflictions(world: World, e: Entity): void {
  if (world.has(e, Diseases)) {
    const st = world.store(Diseases); const s = st.slot(entityIndex(e));
    if (s >= 0) {
      for (let i = 0; i < MAX_DISEASES; i++) { st.data.disease[s * MAX_DISEASES + i] = 0; st.data.untilTick[s * MAX_DISEASES + i] = 0; }
      st.data.coldTicks[s] = 0; st.data.heatTicks[s] = 0; st.data.sprintTicks[s] = 0; st.data.restTicks[s] = 0;
      st.data.contactTicks[s] = 0; st.data.careTicks[s] = 0; st.data.infectionHz[s] = DEFAULT_TICK_HZ;
      st.markChanged(entityIndex(e));
    }
  }
  if (world.has(e, Exposure)) world.setField(e, Exposure, "wetness", 0);
  if (world.has(e, Wetness)) world.setField(e, Wetness, "level", 0);
}
/** Combined walk-speed multiplier from active diseases (1 = healthy); multiplied into speedMultiplier. */
export function diseaseMoveMul(world: World, e: Entity): number {
  let m = 1; for (const d of activeDiseases(world, e)) m *= d.moveMul; return m;
}

/** Legacy disease icons remain; injuries and wound-infection stages use dedicated UI-atlas status art. */
export function diseaseIcon(key: string): string {
  if (key === "broken_leg") return "broken_leg";
  if (key === "wound_infection") return "infected";
  if (key === "common_cold") return "ic_snowflake.png";
  if (key === "influenza") return "ic_temp.png";
  return "ic_health.png";
}

/** ADR-280: one wound-infection track, derived from its existing replicated/persisted expiry clock. */
export type InfectionTier = "infected" | "festering" | "septic";
export const INFECTION_FESTERING_SECONDS = 180;
export const INFECTION_SEPTIC_SECONDS = 360;
export const BANDAGE_INFECTION_RELIEF_SECONDS = 60;
export function infectionTier(world: World, e: Entity): InfectionTier | undefined {
  const defs = gameplayDefs(world), di = defs.diseaseIndex("wound_infection");
  if (di < 0 || !world.has(e, Survival)) return undefined;
  const slot = diseaseSlot(world, e, di); if (slot < 0) return undefined;
  const st = world.store(Diseases), s = st.slot(entityIndex(e));
  const until = st.data.untilTick[s * MAX_DISEASES + slot]!;
  const hz = st.data.infectionHz[s] || DEFAULT_TICK_HZ;
  const started = until - defs.diseases[di]!.durationSeconds * hz;
  const seconds = until === 0 ? 0 : Math.max(0, (world.tick - started) / hz);
  return seconds >= INFECTION_SEPTIC_SECONDS ? "septic" : seconds >= INFECTION_FESTERING_SECONDS ? "festering" : "infected";
}
/** Plain bandages rewind one minute of infection progress, bounded at the start; medicated bandages cure outright. */
export function treatWoundInfection(world: World, e: Entity): boolean {
  const defs = gameplayDefs(world), di = defs.diseaseIndex("wound_infection");
  if (di < 0) return false;
  const slot = diseaseSlot(world, e, di); if (slot < 0) return false;
  const st = world.store(Diseases), idx = entityIndex(e), s = st.slot(idx), offset = s * MAX_DISEASES + slot;
  const until = st.data.untilTick[offset]!; if (until === 0) return false;
  const hz = st.data.infectionHz[s] || DEFAULT_TICK_HZ;
  st.data.untilTick[offset] = Math.min(world.tick + defs.diseases[di]!.durationSeconds * hz, until + BANDAGE_INFECTION_RELIEF_SECONDS * hz);
  st.markChanged(idx); return true;
}
/** Disease identity/cure stays wound_infection; stage labels and dedicated atlas art are presentation, not extra diseases. */
export function diseasePresentation(world: World, e: Entity, def: DiseaseDef): { short: string; name: string; icon: string; stage: InfectionTier | undefined } {
  const stage = def.key === "wound_infection" ? infectionTier(world, e) : undefined;
  if (!stage) return { short: def.short, name: def.name, icon: diseaseIcon(def.key), stage };
  const short = stage[0]!.toUpperCase() + stage.slice(1);
  return { short, name: `${short} wound infection`, icon: stage, stage };
}

/** Task 31: care cure — staying dry, fed, hydrated and warm for this long cures a cold or the flu. */
export const CARE_CURE_SECONDS = 240;
/** Wetness at or below this counts as dry for the care cure (and for the sheet's "dry" state). */
export const CARE_DRY_MAX = 0.05;
/** Task 31: seconds of untreated cold before it develops into flu. Care (240s) beats it when started promptly. */
export const FLU_AFTER_SECONDS = 300;

/** Care-cure state for an entity: whether it is sick, seconds of care still needed, and which conditions are unmet. */
export interface CareStatus { sick: boolean; secondsLeft: number; missing: string[] }
/** Pure read: the four care conditions (dry, fed, hydrated, warm) and how much care time is still owed. */
export function careStatus(world: World, e: Entity): CareStatus {
  const defs = gameplayDefs(world); const vt = defs.vitals;
  const sick = hasDisease(world, e, "common_cold") || hasDisease(world, e, "influenza");
  const wet = world.getField(e, Exposure, "wetness") ?? 0;
  const sv = world.get(e, Survival);
  const body = sv?.bodyTemp ?? vt.bodyTempNormal;
  const missing: string[] = [];
  if (wet > CARE_DRY_MAX) missing.push("dry");
  if ((sv?.hunger ?? 0) <= vt.lowNeedsThreshold) missing.push("fed");
  if ((sv?.thirst ?? 0) <= vt.lowNeedsThreshold) missing.push("hydrated");
  if (body < vt.hypothermiaBelow) missing.push("warm");
  const care = world.getField(e, Diseases, "careTicks") ?? 0;
  return { sick, secondsLeft: Math.max(0, CARE_CURE_SECONDS - care / DEFAULT_TICK_HZ), missing };
}
/** Tick the cold was contracted (derived from its expiry: untilTick minus its duration), or undefined. */
export function coldContractedTick(world: World, e: Entity): number | undefined {
  const defs = gameplayDefs(world); const idx = defs.diseaseIndex("common_cold"); if (idx < 0) return undefined;
  if (!world.has(e, Diseases)) return undefined;
  const st = world.store(Diseases); const s = st.slot(entityIndex(e)); if (s < 0) return undefined;
  const slot = diseaseSlot(world, e, idx); if (slot < 0) return undefined;
  const until = st.data.untilTick[s * MAX_DISEASES + slot]!;
  const dur = defs.diseases[idx]!.durationSeconds;
  if (until === 0 || dur <= 0) return undefined;
  return until - dur * DEFAULT_TICK_HZ;
}
/** True when the entity wears a mask item in the Accessory slot (blocks transmission in both directions). */
export function wearsMask(world: World, e: Entity): boolean {
  const w = world.get(e, Worn); const it = w?.item[WearSlot.Accessory] ?? 0;
  return it !== 0 && gameplayDefs(world).items.get(it)?.mask === true;
}
/**
 * True when a lit campfire is within `reach` tiles of (x, y): a Fuel-lit attachment whose piece is a campfire,
 * or a free-standing lit campfire station. Shared by the server Boil action and the client Boil button.
 */
export function nearLitCampfire(world: World, x: number, y: number, reach: number): boolean {
  const defs = gameplayDefs(world); const fu = world.store(Fuel); const r2 = reach * reach;
  for (let k = 0; k < fu.size; k++) {
    if (fu.data.lit[k] !== 1) continue;
    const fire = fu.dense[k]!; const t = world.get(fire, Transform); if (!t) continue;
    if ((t.x - x) ** 2 + (t.y - y) ** 2 > r2) continue;
    if (world.getField(fire, CraftingStation, "kind") === StationKind.Campfire) return true;
    const piece = pieceOf(world, fire); const type = piece === undefined ? undefined : world.getField(piece, BuildPiece, "type");
    if (type !== undefined && defs.pieces.get(type)?.station === StationKind.Campfire) return true;
  }
  return false;
}

const installed = new WeakSet<World>();
/**
 * Wound infection hook: zombie / animal bites roll infection. Subscribes once per world (called from
 * installGameplay); the Damaged event carries the real attacker entity, so no combat code changes are needed.
 * Events are discarded during replay, and only the authority rolls.
 */
export function installDiseases(world: World): void {
  if (installed.has(world)) return;
  installed.add(world);
  world.events.on(Damaged, (p: { target: Entity; source: Entity; cause: number }) => {
    if (!isAuthority(world) || p.cause !== DamageCause.Combat) return;
    const t = p.target, s = p.source;
    if (!world.isAlive(t) || !world.has(t, Survival) || !world.has(t, Health)) return;
    if (!world.isAlive(s) || (!world.has(s, Zombie) && !world.has(s, Animal))) return;
    ensureDiseases(world, t);
    const chance = gameplayDefs(world).diseaseTuning.causes.woundChance;
    if (chance > 0 && world.rngFor("disease.wound", t).next() < chance) contractDisease(world, t, "wound_infection");
  });
}
