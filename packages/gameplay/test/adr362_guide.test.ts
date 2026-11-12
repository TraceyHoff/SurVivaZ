/**
 * ADR-362: in-game guide — content + data.
 * - Every guide number must match the data file / named constant the game reads: the drift test below
 *   recomputes every fact's display string from the raw source JSONs (independently of the loader) and
 *   compares it with what the loader resolves. A stale number fails here, not in front of a player.
 * - Prose carries no digits (checked explicitly): any number a player reads comes from a fact entry.
 * - Every icon key must resolve in its own table; every controls row must match the default keyboard
 *   profile (or the client menu hotkey for the character sheet).
 * - ADR-364: image items ({ image, caption }) name a kebab-case id in the client's GUIDE_ACTION_IMAGES
 *   registry (existence is pinned by the ADR-364 client test — gameplay cannot import the client) and
 *   pass through resolvedGuideSection unchanged.
 * Relative imports only: a package must never self-import by package name in its own tests (ADR-347).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TICK_HZ } from "@engine/core";
import guideRaw from "../data/guide.json";
import diseasesRaw from "../data/diseases.json";
import environmentRaw from "../data/environment.json";
import farmingRaw from "../data/farming.json";
import petsRaw from "../data/pets.json";
import skillsRaw from "../data/skills.json";
import pvpRaw from "../data/pvp.json";
import dungRaw from "../data/dung.json";
import defenceRaw from "../data/ai_defence.json";
import journeyRaw from "../data/ai_journey.json";
import ropeRaw from "../data/rope.json";
import economyRaw from "../data/economy.json";
import fireRaw from "../data/fire.json";
import inputRaw from "../data/input.json";
import piecesRaw from "../data/pieces.json";
import itemsRaw from "../data/items.json";
import mountsRaw from "../data/mounts.json";
import vehiclesRaw from "../data/vehicles.json";
import recipesRaw from "../data/recipes.json";
import vehicleRecipesRaw from "../data/vehicle_recipes.json";
import tiersRaw from "../data/tiers.json";
import animalSkillsRaw from "../data/animal_skills.json";
import zombiesRaw from "../data/zombies.json";
import kbmRaw from "../../input/profiles/keyboardMouse.json";
import { CARE_CURE_SECONDS, FLU_AFTER_SECONDS } from "../src/diseases.js";
import { temperatureTier, wetnessStage } from "../src/exposure-stages.js";
import { FROST_KILL_F, LATE_FALL_DAYS } from "../src/farming.js";
import {
  GUIDE_FACTS, formatGuideValue, getGuideSections, guideSection, resolveGuideFact,
  resolvedGuideSection, validateGuide, type GuideFactFormat,
} from "../src/guide.js";
import { WANTED_ITEM_KEYS } from "../src/recruitment.js";
import { SAFE_SPAWN_RADIUS } from "../src/spawn_points.js";
import { FIRE_HEAT_MAX_C, FIRE_HEAT_TAU_S, FREEZING_C, WET_INSULATION_LOSS } from "../src/systems/environment.js";
import { SALT_CONSUME_TICKS } from "../src/systems/spoilage.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const menuSrc = readFileSync(join(testDir, "../../../apps/client/src/game-menus.ts"), "utf8");

const SECTION_IDS = [
  "getting-started", "controls", "icons", "diseases", "temperature", "cooking", "building",
  "ai-humans", "animals", "mounts-vehicles", "crops-farming", "storage", "seasons-weather",
  "combat-defence", "multiplayer-clans",
] as const;

// ---- independent expectations (recomputed from the raw source files, not from the loader) ------------

const cToF = (c: number): number => Math.round((c * 9) / 5 + 32);
const fmtDur = (s: number): string => {
  if (s >= 3600 && s % 3600 === 0) { const h = s / 3600; return `${h} hour${h === 1 ? "" : "s"}`; }
  if (s >= 60 && s % 60 === 0) return `${s / 60} min`;
  return `${s} s`;
};
const fmtTempRange = (r: readonly [number, number]): string => `${cToF(r[0])}–${cToF(r[1])} °F`;
const itemName = (key: string): string => {
  const it = (itemsRaw as { items: { key: string; name: string }[] }).items.find((i) => i.key === key);
  expect(it, `item ${key} must exist in items.json`).toBeDefined();
  return it!.name;
};
const disease = (key: string) => {
  const d = (diseasesRaw as { diseases: { key: string; durationSeconds: number; cure: string | null }[] }).diseases.find((x) => x.key === key);
  expect(d, `disease ${key} must exist in diseases.json`).toBeDefined();
  return d!;
};
const piece = (key: string) => {
  const p = (piecesRaw as { pieces: { key: string }[] }).pieces.find((x) => x.key === key);
  expect(p, `piece ${key} must exist in pieces.json`).toBeDefined();
  return p as unknown as {
    container?: number; spoilMul?: number; privilegeRadius?: number; accepts?: string[];
    stall?: { listings: number }; cost?: { resource: string; amount: number }[];
  };
};
const season = (key: string) => {
  const s = (environmentRaw as unknown as { seasons: Record<string, { tempRange: [number, number]; heatWaveRange?: [number, number] }> }).seasons[key];
  expect(s, `season ${key} must exist in environment.json`).toBeDefined();
  return s!;
};
const loveTreats = (speciesKey: string): string[] => {
  const s = (petsRaw as { species: { key: string; treats: Record<string, string> }[] }).species.find((x) => x.key === speciesKey);
  expect(s, `pet species ${speciesKey} must exist`).toBeDefined();
  return Object.entries(s!.treats).filter(([, pref]) => pref === "love").map(([k]) => k);
};
/** Body-temp tier boundary, probed from the game's own temperatureTier (same idea as the loader). */
const tierBoundary = (tier: "freezing" | "overheating"): number => {
  if (tier === "freezing") {
    let b = 30;
    for (let i = 300; i <= 370; i++) if (temperatureTier(i / 10) === "freezing") b = i / 10;
    return b;
  }
  for (let i = 370; i <= 420; i++) if (temperatureTier(i / 10) === "overheating") return i / 10;
  throw new Error("no overheating boundary");
};

const env = environmentRaw as unknown as {
  dayLengthSeconds: number; seasons: { lengthDays: number };
  weather: { kind: string; durationSeconds: [number, number] }[];
  spoilage: { stages: { key: string }[] };
};
const farm = farmingRaw as unknown as {
  plantables: { growSeconds: number }[]; wateredSeconds: number; fertilizerSeconds: number;
  fertilizerMul: number; unwateredMul: number; dungFertilizerSeconds: number; plantReach: number; waterRadius: number;
};
const pvp = pvpRaw as unknown as {
  bagOwnerOnlySeconds: number; respawnSeconds: number; respawnHealthFrac: number; combatTagSeconds: number;
  guestSafeSeconds: number; despawn: { deathBagSeconds: number; droppedSeconds: number };
};
const tiers = tiersRaw as unknown as { tiers: { key: string }[]; building: { maxPiecesPerZone: number; maxLevel: number; containerReach: number; repairBlockedSeconds: number; demolishRefund: number } };

/** Expected display string for every fact path the guide references, recomputed from source data. */
const EXPECTED: Record<string, string> = {
  "diseases.food_poisoning.durationSeconds": fmtDur(disease("food_poisoning").durationSeconds),
  "diseases.food_poisoning.cure": itemName(disease("food_poisoning").cure!),
  "diseases.dysentery.durationSeconds": fmtDur(disease("dysentery").durationSeconds),
  "diseases.dysentery.cure": itemName(disease("dysentery").cure!),
  "diseases.common_cold.durationSeconds": fmtDur(disease("common_cold").durationSeconds),
  "diseases.common_cold.cure": itemName(disease("common_cold").cure!),
  "diseases.heatstroke.durationSeconds": fmtDur(disease("heatstroke").durationSeconds),
  "diseases.heatstroke.cure": itemName(disease("heatstroke").cure!),
  "diseases.wound_infection.durationSeconds": fmtDur(disease("wound_infection").durationSeconds),
  "diseases.wound_infection.cure": itemName(disease("wound_infection").cure!),
  "diseases.influenza.durationSeconds": fmtDur(disease("influenza").durationSeconds),
  "diseases.influenza.cure": itemName(disease("influenza").cure!),
  "diseases.broken_leg.durationSeconds": fmtDur(disease("broken_leg").durationSeconds),
  "diseases.broken_leg.cure": itemName(disease("broken_leg").cure!),
  "diseases.exhaustion.cure": "Rest",
  "diseases.transmission.radiusTiles": `${(diseasesRaw as unknown as { transmission: { radiusTiles: number } }).transmission.radiusTiles} tiles`,
  "diseases.transmission.contactSeconds": fmtDur((diseasesRaw as unknown as { transmission: { contactSeconds: number } }).transmission.contactSeconds),
  "diseases.transmission.chance": `${Math.round((diseasesRaw as unknown as { transmission: { chance: number } }).transmission.chance * 100)}%`,
  "diseases.exposure.coldSeconds": fmtDur((diseasesRaw as unknown as { exposure: { coldSeconds: number } }).exposure.coldSeconds),
  "diseases.exposure.heatSeconds": fmtDur((diseasesRaw as unknown as { exposure: { heatSeconds: number } }).exposure.heatSeconds),
  "diseases.careCureSeconds": fmtDur(CARE_CURE_SECONDS),
  "diseases.fluAfterSeconds": fmtDur(FLU_AFTER_SECONDS),
  "temperature.fireHeatMaxC": `+${FIRE_HEAT_MAX_C} °C (+${Math.round((FIRE_HEAT_MAX_C * 9) / 5)} °F)`,
  "temperature.fireHeatTauSeconds": fmtDur(FIRE_HEAT_TAU_S),
  "temperature.freezingC": `${cToF(FREEZING_C)} °F`,
  "temperature.frostKillF": `${FROST_KILL_F} °F`,
  "temperature.wetInsulationLoss": `${Math.round(WET_INSULATION_LOSS * 100)}%`,
  "temperature.furCoatInsulation": String((itemsRaw as { items: { key: string; wear?: { insulation?: number } }[] }).items.find((i) => i.key === "fur_coat")!.wear!.insulation),
  "temperature.furHatInsulation": String((itemsRaw as { items: { key: string; wear?: { insulation?: number } }[] }).items.find((i) => i.key === "fur_hat")!.wear!.insulation),
  "temperature.bodyFreezingC": `${cToF(tierBoundary("freezing"))} °F`,
  "temperature.bodyOverheatingC": `${cToF(tierBoundary("overheating"))} °F`,
  "seasons.lengthDays": String(env.seasons.lengthDays),
  "seasons.dayLengthSeconds": fmtDur(env.dayLengthSeconds),
  "seasons.summer.tempRange": fmtTempRange(season("summer").tempRange),
  "seasons.fall.tempRange": fmtTempRange(season("fall").tempRange),
  "seasons.winter.tempRange": fmtTempRange(season("winter").tempRange),
  "seasons.spring.tempRange": fmtTempRange(season("spring").tempRange),
  "seasons.summer.heatWaveRange": fmtTempRange(season("summer").heatWaveRange!),
  "weather.rain.durationSeconds": `${env.weather.find((w) => w.kind === "rain")!.durationSeconds[0] / 60}–${env.weather.find((w) => w.kind === "rain")!.durationSeconds[1] / 60} min`,
  "inventory.packSlots": "16",
  "inventory.hotbarSlots": String((inputRaw as { hotbarSlots: number }).hotbarSlots),
  "inventory.totalSlots": "24",
  "cooking.recipeCount": String((recipesRaw as { recipes: unknown[] }).recipes.length + (vehicleRecipesRaw as { recipes: unknown[] }).recipes.length),
  "cooking.campfireRecipeCount": String((recipesRaw as { recipes: { station: string }[] }).recipes.filter((r) => r.station === "campfire").length),
  "food.spoilageStages": env.spoilage.stages.map((s) => s.key).join(", "),
  "food.saltConsumeSeconds": fmtDur(SALT_CONSUME_TICKS / DEFAULT_TICK_HZ),
  "food.frozenBelowC": `${cToF(FREEZING_C)} °F`,
  "building.claimRadiusTiles": `${piece("claim_totem").privilegeRadius} tiles`,
  "building.claimCost": piece("claim_totem").cost!.map((c) => `${c.amount} ${itemName(c.resource)}`).join(", "),
  "building.maxPiecesPerZone": String(tiers.building.maxPiecesPerZone),
  "building.maxLevel": String(tiers.building.maxLevel),
  "building.containerReachTiles": `${tiers.building.containerReach} tiles`,
  "building.repairBlockedSeconds": fmtDur(tiers.building.repairBlockedSeconds),
  "building.demolishRefund": `${Math.round(tiers.building.demolishRefund * 100)}%`,
  "ai.wantedPoolCount": String(WANTED_ITEM_KEYS.length),
  "ai.travelLongTripTiles": `${(journeyRaw as { longTripTiles: number }).longTripTiles} tiles`,
  "ai.travelMinPrepTiles": `${(journeyRaw as { minPrepTiles: number }).minPrepTiles} tiles`,
  "ai.defenceMaxTurrets": String((defenceRaw as { maxTurrets: number }).maxTurrets),
  "ai.defenceMaxWire": String((defenceRaw as { maxWire: number }).maxWire),
  "safety.safeRadiusTiles": `${SAFE_SPAWN_RADIUS} tiles`,
  "animals.petSpeciesCount": String((petsRaw as { species: unknown[] }).species.length),
  "animals.petSkillMaxLevel": String((animalSkillsRaw as unknown as { xp: { maxLevel: number } }).xp.maxLevel),
  "animals.farmSpeciesCount": String(Object.keys((skillsRaw as { husbandry: { animals: Record<string, unknown> } }).husbandry.animals).length),
  "animals.dungDespawnSeconds": fmtDur((dungRaw as { despawnSeconds: number }).despawnSeconds),
  "animals.dungPerDay": String((dungRaw as { perDay: number }).perDay),
  "animals.dungFertilizerSeconds": fmtDur(farm.dungFertilizerSeconds),
  "animals.fertilizerSeconds": fmtDur(farm.fertilizerSeconds),
  "animals.ropeAttachRangeTiles": `${(ropeRaw as { tuning: { attachRange: number } }).tuning.attachRange} tiles`,
  "animals.ropeBreakDistanceTiles": `${(ropeRaw as { tuning: { breakDistance: number } }).tuning.breakDistance} tiles`,
  "animals.troughRangeTiles": `${(mountsRaw as { tuning: { troughRange: number } }).tuning.troughRange} tiles`,
  "animals.mountFedSeconds": fmtDur((mountsRaw as { tuning: { fedSeconds: number } }).tuning.fedSeconds),
  "animals.treats.dog_lab": loveTreats("dog_lab").map(itemName).join(", "),
  "animals.treats.cat_tabby": loveTreats("cat_tabby").map(itemName).join(", "),
  "animals.treats.fox": loveTreats("fox").map(itemName).join(", "),
  "animals.treats.owl": loveTreats("owl").map(itemName).join(", "),
  "mounts.speciesCount": String((mountsRaw as { species: unknown[] }).species.length),
  "mounts.horse.walkSpeed": `${(mountsRaw as { species: { key: string; walk: number }[] }).species.find((s) => s.key === "horse")!.walk} tiles/s`,
  "mounts.horse.gallopSpeed": `${(mountsRaw as { species: { key: string; gallop: number }[] }).species.find((s) => s.key === "horse")!.gallop} tiles/s`,
  "mounts.saddleCount": String((mountsRaw as { saddles: unknown[] }).saddles.length),
  "mounts.saddleSlots": (mountsRaw as { saddles: { name: string; slots: number }[] }).saddles.map((s) => `${s.name} ${s.slots}`).join(", "),
  "mounts.harnessItem": itemName("harness"),
  "vehicles.drawnCount": String((vehiclesRaw as { vehicles: { drawn?: unknown }[] }).vehicles.filter((v) => v.drawn).length),
  "vehicles.chariotGallopCap": `${Math.min(
    (vehiclesRaw as { vehicles: { id: string; maxSpeed: number; drawn: { pullMul: number } }[] }).vehicles.find((v) => v.id === "chariot")!.maxSpeed,
    (mountsRaw as { species: { key: string; gallop: number }[] }).species.find((s) => s.key === "horse")!.gallop
      * (vehiclesRaw as { vehicles: { id: string; drawn: { pullMul: number } }[] }).vehicles.find((v) => v.id === "chariot")!.drawn.pullMul,
  )} tiles/s`,
  "vehicles.wagonLargeGallopCap": `${Math.min(
    (vehiclesRaw as { vehicles: { id: string; maxSpeed: number; drawn: { pullMul: number } }[] }).vehicles.find((v) => v.id === "wagon_large")!.maxSpeed,
    (mountsRaw as { species: { key: string; gallop: number }[] }).species.find((s) => s.key === "horse")!.gallop
      * (vehiclesRaw as { vehicles: { id: string; drawn: { pullMul: number } }[] }).vehicles.find((v) => v.id === "wagon_large")!.drawn.pullMul,
  )} tiles/s`,
  "vehicles.carriageSeats": String((vehiclesRaw as { vehicles: { id: string; seats: number }[] }).vehicles.find((v) => v.id === "carriage")!.seats),
  "vehicles.wagonLargeStorageSlots": `${(vehiclesRaw as { vehicles: { id: string; storage: { slots: number } }[] }).vehicles.find((v) => v.id === "wagon_large")!.storage.slots} slots`,
  "farming.plantableCount": String(farm.plantables.length),
  "farming.growMinSeconds": fmtDur(Math.min(...farm.plantables.map((p) => p.growSeconds))),
  "farming.growMaxSeconds": fmtDur(Math.max(...farm.plantables.map((p) => p.growSeconds))),
  "farming.wateredSeconds": fmtDur(farm.wateredSeconds),
  "farming.fertilizerSeconds": fmtDur(farm.fertilizerSeconds),
  "farming.fertilizerMul": `×${farm.fertilizerMul}`,
  "farming.unwateredMul": `×${farm.unwateredMul}`,
  "farming.dungFertilizerSeconds": fmtDur(farm.dungFertilizerSeconds),
  "farming.lateFallDormantDays": String(LATE_FALL_DAYS),
  "farming.plantReachTiles": `${farm.plantReach} tiles`,
  "farming.waterRadiusTiles": `${farm.waterRadius} tiles`,
  "storage.storeCount": "5",
  "storage.storeSlots": `${piece("ore_store").container} slots`,
  "storage.oreAccepts": piece("ore_store").accepts!.map(itemName).join(", "),
  "storage.cropAcceptsCount": String(piece("crop_store").accepts!.length),
  "storage.saltBarrelMul": `×${piece("salt_barrel").spoilMul}`,
  "storage.curingBoxMul": `×${piece("curing_box").spoilMul}`,
  "storage.coldStoreMul": `×${piece("cold_store").spoilMul}`,
  "storage.genericBoxSlots": `${piece("basic_storage_box").container} slots`,
  "storage.deathBagSeconds": fmtDur(pvp.despawn.deathBagSeconds),
  "storage.droppedSeconds": fmtDur(pvp.despawn.droppedSeconds),
  "storage.bagOwnerOnlySeconds": fmtDur(pvp.bagOwnerOnlySeconds),
  "combat.zombieNightRate": String((zombiesRaw as unknown as { spawning: { ratePerMinute: { night: number } } }).spawning.ratePerMinute.night),
  "combat.zombieNightCap": String((zombiesRaw as unknown as { spawning: { cap: { night: number } } }).spawning.cap.night),
  "combat.zombieMinDistanceTiles": `${(zombiesRaw as unknown as { spawning: { minDistance: number } }).spawning.minDistance} tiles`,
  "combat.zombieMaxDistanceTiles": `${(zombiesRaw as unknown as { spawning: { maxDistance: number } }).spawning.maxDistance} tiles`,
  "combat.fireDps": String((fireRaw as { dps: number }).dps),
  "combat.fireSpreadChance": `${Math.round((fireRaw as { spreadChance: number }).spreadChance * 100)}%`,
  "combat.fireSpreadRadiusTiles": `${(fireRaw as { spreadRadius: number }).spreadRadius} tiles`,
  "combat.flammableTiers": (fireRaw as { flammableTiers: number[] }).flammableTiers.map((i) => tiers.tiers[i]!.key).join(", "),
  "combat.combatTagSeconds": fmtDur(pvp.combatTagSeconds),
  "combat.respawnSeconds": fmtDur(pvp.respawnSeconds),
  "combat.respawnHealthFrac": `${Math.round(pvp.respawnHealthFrac * 100)}%`,
  "combat.guestSafeSeconds": fmtDur(pvp.guestSafeSeconds),
  "trade.stallBlanketListings": String(piece("stall_blanket").stall!.listings),
  "trade.stallCartListings": String(piece("stall_cart").stall!.listings),
  "trade.stallBoothListings": String(piece("stall_booth").stall!.listings),
  "trade.stallPavilionListings": String(piece("clan_pavilion").stall!.listings),
  "trade.stallCounterListings": String(piece("market_counter").stall!.listings),
  "trade.stallNameMax": String((economyRaw as { stallNameMax: number }).stallNameMax),
  "trade.tillSlots": `${(economyRaw as { tillSlots: number }).tillSlots} slots`,
  "trade.ledgerSize": String((economyRaw as { ledgerSize: number }).ledgerSize),
  "trade.currency": itemName((economyRaw as { currency: string }).currency),
  "icons.wetnessStages": [0.1, 0.5, 0.9].map((w) => wetnessStage(w)).join(", "),
};

type GuideItemRaw = { text?: string; fact?: string; format?: string; label?: string; keys?: string[]; action?: string; actions?: string[]; verify?: string; image?: string; caption?: string };
type GuideSectionRaw = { id: string; title: string; icon: string; intro: string; items: GuideItemRaw[] };
const sections = (guideRaw as unknown as { sections: GuideSectionRaw[] }).sections;
const allFactEntries = sections.flatMap((s) => s.items.filter((i) => i.fact).map((i) => ({ section: s.id, fact: i.fact!, format: i.format as GuideFactFormat, label: i.label! })));

describe("ADR-362 guide content + data", () => {
  it("validates clean and has one section per system, in order", () => {
    expect(validateGuide()).toEqual([]);
    const got = getGuideSections();
    expect(got.map((s) => s.id)).toEqual([...SECTION_IDS]);
    for (const s of got) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.intro.length).toBeGreaterThan(0);
      expect(s.items.length).toBeGreaterThan(0);
    }
  });

  it("prose carries no digits: every number a player reads comes from a fact entry", () => {
    let checked = 0;
    for (const s of sections) {
      expect(s.intro, `${s.id} intro`).not.toMatch(/\d/); checked++;
      for (const item of s.items) {
        if (item.text !== undefined) { expect(item.text, `${s.id} text`).not.toMatch(/\d/); checked++; }
        if (item.label !== undefined) { expect(item.label, `${s.id} label`).not.toMatch(/\d/); checked++; }
        if (item.caption !== undefined) { expect(item.caption, `${s.id} caption`).not.toMatch(/\d/); checked++; }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("every referenced fact path has an independent expectation, and resolves to it (drift test)", () => {
    const referenced = [...new Set(allFactEntries.map((e) => e.fact))].sort();
    expect(Object.keys(EXPECTED).sort()).toEqual(referenced);
    expect(referenced.length).toBeGreaterThan(80);
    for (const e of allFactEntries) {
      expect(resolveGuideFact(e.fact, e.format), `${e.section}: ${e.fact}`).toBe(EXPECTED[e.fact]);
    }
  });

  it("pins the headline numbers a player will remember", () => {
    expect(resolveGuideFact("seasons.summer.tempRange", "tempRangeF")).toBe("70–88 °F");
    expect(resolveGuideFact("seasons.summer.heatWaveRange", "tempRangeF")).toBe("89–100 °F");
    expect(resolveGuideFact("seasons.winter.tempRange", "tempRangeF")).toBe("0–35 °F");
    expect(resolveGuideFact("diseases.influenza.durationSeconds", "duration")).toBe("15 min");
    expect(resolveGuideFact("diseases.influenza.cure", "item")).toBe("Honey Tea");
    expect(resolveGuideFact("diseases.careCureSeconds", "duration")).toBe("4 min");
    expect(resolveGuideFact("farming.dungFertilizerSeconds", "duration")).toBe("15 min");
    expect(resolveGuideFact("vehicles.chariotGallopCap", "speed")).toBe("11.5 tiles/s");
    expect(resolveGuideFact("vehicles.wagonLargeGallopCap", "speed")).toBe("5 tiles/s");
    expect(resolveGuideFact("building.claimCost", "cost")).toBe("10 Pine Log, 10 Stone, 2 Dye");
    expect(resolveGuideFact("safety.safeRadiusTiles", "tiles")).toBe("20 tiles");
    expect(resolveGuideFact("inventory.totalSlots", "count")).toBe("24");
    expect(resolveGuideFact("cooking.recipeCount", "count")).toBe("394");
    expect(resolveGuideFact("temperature.fireHeatMaxC", "tempDelta")).toBe("+15 °C (+27 °F)");
  });

  it("every disease in the data is documented with a duration (when it expires) and a cure", () => {
    const paths = new Set(allFactEntries.map((e) => e.fact));
    for (const d of (diseasesRaw as { diseases: { key: string; durationSeconds: number }[] }).diseases) {
      if (d.durationSeconds > 0) expect(paths.has(`diseases.${d.key}.durationSeconds`), d.key).toBe(true);
      expect(paths.has(`diseases.${d.key}.cure`), d.key).toBe(true);
    }
    expect(resolveGuideFact("diseases.count", "count")).toBe(String((diseasesRaw as { diseases: unknown[] }).diseases.length));
  });

  it("every icon key resolves in its own table", () => {
    const itemKeys = new Set((itemsRaw as { items: { key: string }[] }).items.map((i) => i.key));
    const pieceKeys = new Set((piecesRaw as { pieces: { key: string }[] }).pieces.map((p) => p.key));
    const vehicleIds = new Set((vehiclesRaw as { vehicles: { id: string }[] }).vehicles.map((v) => v.id));
    const mountKeys = new Set((mountsRaw as { species: { key: string }[] }).species.map((s) => s.key));
    const petKeys = new Set((petsRaw as { species: { key: string }[] }).species.map((s) => s.key));
    for (const s of sections) {
      const [kind, key] = s.icon.split(":", 2);
      const table = kind === "item" ? itemKeys : kind === "piece" ? pieceKeys : kind === "vehicle" ? vehicleIds : kind === "mount" ? mountKeys : petKeys;
      expect(table.has(key!), `${s.id} icon ${s.icon}`).toBe(true);
    }
  });

  it("image items name a kebab-case registry id with a digit-free caption, and pass through resolved", () => {
    const images = sections.flatMap((s) => s.items.filter((i) => i.image).map((i) => ({ section: s.id, image: i.image!, caption: i.caption! })));
    expect(images.map((i) => i.image)).toEqual(["cook-fire", "place-hologram", "claim-base", "tame-feed", "use-trough", "harness-mount"]);
    for (const { section, image, caption } of images) {
      expect(image, section).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(caption.length, section).toBeGreaterThan(0);
      expect(caption, section).not.toMatch(/\d/);
      expect(resolvedGuideSection(section)?.items).toContainEqual({ kind: "image", image, caption });
    }
    // Validation rejects a malformed image item instead of silently dropping the picture.
    const badId = JSON.parse(JSON.stringify(guideRaw)) as { sections: GuideSectionRaw[] };
    (badId.sections.find((s) => s.id === "cooking")!.items[0] as { image: string }).image = "Cook Fire";
    expect(validateGuide(badId)).toEqual(["sections[5].items[0].image: needs a kebab-case registry id"]);
    const badCaption = JSON.parse(JSON.stringify(guideRaw)) as { sections: GuideSectionRaw[] };
    (badCaption.sections.find((s) => s.id === "cooking")!.items[0] as { caption: string }).caption = "";
    expect(validateGuide(badCaption)).toEqual(["sections[5].items[0].caption: needs a non-empty caption"]);
    const digitCaption = JSON.parse(JSON.stringify(guideRaw)) as { sections: GuideSectionRaw[] };
    (digitCaption.sections.find((s) => s.id === "cooking")!.items[0] as { caption: string }).caption = "Cook for 2 minutes";
    expect(validateGuide(digitCaption)).toEqual(["sections[5].items[0].caption: prose must not contain digits (use a fact entry)"]);
  });

  it("every item key a fact names exists in the catalog", () => {
    const itemKeys = new Set((itemsRaw as { items: { key: string }[] }).items.map((i) => i.key));
    for (const e of allFactEntries) {
      if (e.format === "item" || e.format === "items" || e.format === "cost") {
        // resolveGuideFact throws on an unknown item key; reaching here proves they all resolve.
        expect(() => resolveGuideFact(e.fact, e.format)).not.toThrow();
      }
    }
    // ...and the loader's own name lookup agrees with the catalog for the ore store list.
    expect(resolveGuideFact("storage.oreAccepts", "items")).toBe(
      piece("ore_store").accepts!.map((k) => { expect(itemKeys.has(k), k).toBe(true); return itemName(k); }).join(", "),
    );
  });

  it("controls rows match the default keyboard profile; the character sheet matches the menu hotkey", () => {
    const CONTROL_LABELS: Record<string, string> = {
      "key.KeyW": "W", "key.KeyA": "A", "key.KeyS": "S", "key.KeyD": "D",
      "key.ArrowUp": "↑", "key.ArrowDown": "↓", "key.ArrowLeft": "←", "key.ArrowRight": "→",
      "key.ShiftLeft": "Shift", "key.ControlLeft": "Ctrl", "key.Space": "Space", "key.Tab": "Tab",
      "key.Escape": "Esc", "key.Enter": "Enter", "key.Delete": "Delete", "key.BracketLeft": "[",
      "key.BracketRight": "]", "key.Slash": "/", "key.Minus": "-", "key.Equal": "=",
      "mouse.left": "Left click", "mouse.right": "Right click",
      "mouse.wheelDown": "Scroll down", "mouse.wheelUp": "Scroll up",
    };
    for (let d = 1; d <= 8; d++) CONTROL_LABELS[`key.Digit${d}`] = String(d);
    for (const code of ["KeyE", "KeyR", "KeyX", "KeyC", "KeyM", "KeyP", "KeyB", "KeyY", "KeyH", "KeyU", "KeyV", "KeyF", "KeyG", "KeyN", "KeyQ", "KeyZ"]) {
      CONTROL_LABELS[`key.${code}`] = code.slice(3);
    }
    const gameplayBindings = (kbmRaw as { bindings: Record<string, { action: string; control?: string; composite?: { up: string; down: string; left: string; right: string } }[]> }).bindings.Gameplay;
    expect(gameplayBindings, "default keyboard profile needs a Gameplay context").toBeDefined();
    const bindings = gameplayBindings!;
    const byAction = new Map<string, { control?: string; composite?: { up: string; down: string; left: string; right: string } }>();
    for (const b of bindings) if (!byAction.has(b.action)) byAction.set(b.action, b);
    let checked = 0;
    for (const s of sections) {
      for (const item of s.items) {
        if (!item.keys) continue;
        if (item.verify === "client-menu") {
          expect(item.keys).toEqual(["K"]);
          expect(menuSrc).toMatch(/id:\s*"character"[^}]*hotkeys:\s*\["KeyK"\]/s);
          checked++;
          continue;
        }
        const actions = item.action ? [item.action] : item.actions ?? [];
        expect(actions.length, `${s.id}: ${item.label}`).toBeGreaterThan(0);
        const expectedKeys = actions.flatMap((a) => {
          const b = byAction.get(a);
          expect(b, `action ${a} must be bound in the default keyboard profile`).toBeDefined();
          if (b!.composite) return [b!.composite.up, b!.composite.left, b!.composite.down, b!.composite.right].map((c) => CONTROL_LABELS[c]!);
          return [CONTROL_LABELS[b!.control!]!];
        });
        expect(item.keys, `${s.id}: ${item.label}`).toEqual(expectedKeys);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("accessors work: sections, single lookup, resolved rendering, unknown ids", () => {
    expect(guideSection("diseases")?.title).toBe("Diseases");
    expect(guideSection("no-such-section")).toBeUndefined();
    const resolved = resolvedGuideSection("diseases");
    expect(resolved?.items).toContainEqual({ kind: "fact", label: "Flu — lasts", value: "15 min" });
    expect(resolved?.items).toContainEqual({ kind: "fact", label: "Flu — cure", value: "Honey Tea" });
    expect(resolved?.items).toContainEqual({ kind: "fact", label: "Exhaustion — cure", value: "Rest" });
    expect(resolvedGuideSection("no-such-section")).toBeUndefined();
    expect(getGuideSections().length).toBe(SECTION_IDS.length);
    expect(() => resolveGuideFact("no.such.path", "count")).toThrow(/unknown path/);
    expect(() => formatGuideValue("not-a-number", "duration")).toThrow();
    expect(() => formatGuideValue(5, "item")).toThrow();
  });

  it("the fact registry covers every path the guide references (no dangling refs)", () => {
    for (const e of allFactEntries) expect(e.fact in GUIDE_FACTS, e.fact).toBe(true);
    expect(validateGuide()).toEqual([]);
  });
});
